/**
 * Agent 网关。
 *
 * 负责：接收入站的 Agent WebSocket 连接、握手鉴权、心跳、
 * 双向 RPC 分发、掉线清理。
 *
 * 关键设计见 docs/PROTOCOL.md §1–§4。这里只强调一条：
 * **Agent 是主动外连的一方**，所以 MC 服务端不需要开放任何端口。
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';

import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  HEARTBEAT_MISS_LIMIT,
  HELLO_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  METHOD_CAPABILITY,
  AgentError,
  encodeFrame,
  parseFrame,
  toRpcError,
  type AgentEventMap,
  type AgentEventName,
  type AgentToServerMethod,
  type Capability,
  type ErrorCode,
  type Frame,
  type Punishment,
  type RpcRequest,
  type ServerToAgentMethod,
  type ServerToAgentMethods,
} from '@kokuu/protocol';
import {
  HelloSchema,
  validate,
  validateAgentToServerParams,
  validateServerToAgentParams,
} from '@kokuu/protocol/schemas';

import { createLogger } from '../logger.ts';
import type { NodeRow, PunishmentRow, Store } from '../store/index.ts';
import { verifySecret } from '../lib/crypto.ts';

const log = createLogger('agent');

export interface AgentInfo {
  version: string;
  mcVersion: string;
  brand: string;
  javaVersion: string;
}

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

/** 处理 Agent 发来的请求（`AgentToServerMethods`）。 */
export type AgentRequestHandler = (
  connection: AgentConnection,
  method: AgentToServerMethod,
  params: unknown,
) => Promise<unknown>;

export interface GatewayHooks {
  onConnected(node: NodeRow, connection: AgentConnection): void;
  onDisconnected(nodeId: string, reason: string): void;
  onEvent(nodeId: string, event: AgentEventName, data: unknown): void;
}

/**
 * 单个节点连接。
 *
 * 每个连接一个实例，持有自己的 pending 表、心跳状态与能力集合。
 */
export class AgentConnection {
  readonly nodeId: string;
  readonly agentInfo: AgentInfo;
  readonly capabilities: Set<Capability>;
  readonly remoteAddress: string;
  readonly connectedAt = Date.now();

  private readonly ws: WebSocket;
  private readonly pending = new Map<string, PendingCall>();
  private readonly log;
  private seq = 0;
  private missedPings = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private lastSeenAt = Date.now();

  constructor(
    ws: WebSocket,
    nodeId: string,
    agentInfo: AgentInfo,
    capabilities: Capability[],
    remoteAddress: string,
  ) {
    this.ws = ws;
    this.nodeId = nodeId;
    this.agentInfo = agentInfo;
    this.capabilities = new Set(capabilities);
    this.remoteAddress = remoteAddress;
    this.log = log.child(nodeId);
  }

  get lastSeen(): number {
    return this.lastSeenAt;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  has(capability: Capability): boolean {
    return this.capabilities.has(capability);
  }

  startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;

      if (this.missedPings >= HEARTBEAT_MISS_LIMIT) {
        // 半开连接的兜底：TCP 断了但对端没感知，表现为
        // 「平台显示在线但所有操作超时」。主动断开让 Agent 重连。
        this.log.warn(
          `连续 ${this.missedPings} 次心跳无响应，判定连接已失效，主动断开`,
        );
        this.close('heartbeat timeout');
        return;
      }

      this.missedPings += 1;
      this.call('ping', {}).catch(() => {
        /* 心跳失败由 missedPings 计数处理，这里不重复记日志 */
      });
    }, DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  markPong(): void {
    this.missedPings = 0;
    this.lastSeenAt = Date.now();
  }
  /** 发一个请求并等响应。超时或掉线都会 reject。 */
  call<M extends ServerToAgentMethod>(
    method: M,
    params: ServerToAgentMethods[M]['params'],
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<ServerToAgentMethods[M]['result']> {
    return this.callUnknown(method, params, timeoutMs) as Promise<
      ServerToAgentMethods[M]['result']
    >;
  }

  /**
   * 不做类型收窄的调用入口。
   *
   * 给「薄代理」路由用（LuckPerms 那一批方法名与参数都是动态的），
   * 免得它们在泛型上反复 `as never`。
   */
  callUnknown(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(mapCode('NODE_OFFLINE', `节点 ${this.nodeId} 已离线`));
        return;
      }

      // 能力预检：能提前判定的失败就不要浪费一个来回。
      // 少了这一步，前端在「节点没装 LuckPerms」时会转圈 10 秒才超时。
      const required = METHOD_CAPABILITY[method as ServerToAgentMethod];
      if (required && !this.capabilities.has(required)) {
        reject(
          mapCode(
            required === 'luckperms' ? 'NO_LUCKPERMS' : 'UNSUPPORTED',
            `节点 ${this.nodeId} 未声明能力 ${required}`,
          ),
        );
        return;
      }

      const id = `s${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          mapCode(
            'TIMEOUT',
            `节点 ${this.nodeId} 在 ${timeoutMs}ms 内未响应 ${method}`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
        startedAt: Date.now(),
      });

      const frame: RpcRequest = { type: 'request', id, method, params };
      this.send(frame);
    });
  }

  /** 发事件。事件不保证送达，也不重传。 */
  sendEvent<E extends AgentEventName>(
    event: E,
    data: AgentEventMap[E],
  ): void {
    this.send({ type: 'event', event, ts: Date.now(), data });
  }

  private send(frame: Frame): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(encodeFrame(frame));
    } catch (error) {
      this.log.warn('发送帧失败', error);
    }
  }

  respond(id: string, result: unknown): void {
    this.send({ type: 'response', id, ok: true, result });
  }

  respondError(id: string, error: unknown): void {
    this.send({ type: 'response', id, ok: false, error: toRpcError(error) });
  }

  /** 收到一帧。由网关调用。 */
  handleFrame(frame: Frame, handler: AgentRequestHandler, hooks: GatewayHooks): void {
    // **任何**入站帧都证明对端活着，都要重置心跳计数。
    //
    // 这里踩过一次坑：最初只在收到名为 `pong` 的 event 时重置，而 Agent
    // 回的是 `ping` 的 **response** 帧 —— 计数永不归零，连接每 60 秒被
    // 服务端以「心跳超时」踢掉一次。症状是「节点每分钟无故掉线」，
    // 而且因为自动重连很快，界面上几乎看不出来。
    //
    // 心跳衡量的是「对端还在不在」，不是「它答了哪一题」。
    // 对端卡住的场景由 RPC 超时单独发现，不该混进心跳。
    this.markPong();

    switch (frame.type) {
      case 'response': {
        const call = this.pending.get(frame.id);
        if (!call) {
          // 迟到的响应（已经超时）属于正常现象，不记 warn 免刷日志。
          this.log.debug(`收到无主的响应 id=${frame.id}`);
          return;
        }
        this.pending.delete(frame.id);
        clearTimeout(call.timer);

        if (frame.ok) {
          call.resolve(frame.result);
        } else {
          call.reject(mapCode(frame.error.code, frame.error.message, frame.error.data));
        }
        return;
      }

      case 'request': {
        void this.dispatchRequest(frame, handler);
        return;
      }

      case 'event': {
        hooks.onEvent(this.nodeId, frame.event as AgentEventName, frame.data);
        return;
      }
    }
  }

  private async dispatchRequest(
    frame: RpcRequest,
    handler: AgentRequestHandler,
  ): Promise<void> {
    const checked = validateAgentToServerParams(frame.method, frame.params);
    if (!checked.ok) {
      this.respondError(frame.id, checked.error);
      return;
    }

    const method = frame.method as AgentToServerMethod;

    try {
      const result = await handler(this, method, checked.value);
      this.respond(frame.id, result);
    } catch (error) {
      this.log.warn(`处理 ${method} 失败`, error);
      this.respondError(frame.id, error);
    }
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();

    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(
        mapCode('NODE_OFFLINE', `节点离线（${reason}），未完成的 ${call.method} 已取消`),
      );
      this.pending.delete(id);
    }

    try {
      this.ws.close(1000, reason.slice(0, 120));
    } catch {
      /* 已经关了 */
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/** 携带协议错误码的 Error，向上透传到 HTTP 层。 */
export class AgentCallError extends Error {
  readonly code: ErrorCode;
  readonly data: unknown;

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'AgentCallError';
    this.code = code;
    this.data = data;
  }
}

function mapCode(code: ErrorCode, message: string, data?: unknown): AgentCallError {
  return new AgentCallError(code, message, data);
}

export class AgentGateway {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, AgentConnection>();
  private readonly store: Store;
  private readonly hooks: GatewayHooks;
  private readonly requestHandler: AgentRequestHandler;
  /** 握手完成前挂在连接上的定时器，用于超时关闭。 */
  private readonly helloTimers = new WeakMap<WebSocket, NodeJS.Timeout>();

  constructor(
    store: Store,
    hooks: GatewayHooks,
    requestHandler: AgentRequestHandler,
  ) {
    this.store = store;
    this.hooks = hooks;
    this.requestHandler = requestHandler;

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME_BYTES,
      // 压缩会让控制台日志这类高重复内容省很多带宽。
      perMessageDeflate: { threshold: 1024 },
    });
  }

  /** 挂到 HTTP server 的 upgrade 事件上。只处理 `/agent` 路径。 */
  attach(server: HttpServer): void {
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://placeholder');
      if (url.pathname !== '/agent') return; // 交给别的 handler（如浏览器事件）

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.onRawConnection(ws, request);
      });
    });
  }

  private onRawConnection(ws: WebSocket, request: IncomingMessage): void {
    const remote = request.socket.remoteAddress ?? 'unknown';
    // 用对象持有而不是裸 `let`：TS 对「只在闭包里赋值」的变量
    // 会保守地按初始值 `null` 收窄，导致后续 `if (bound)` 判定为永假。
    const state: { connection: AgentConnection | null } = { connection: null };
    let handshaken = false;

    // 握手超时：连上但不发 hello 的连接（扫描器、配错地址的插件）
    // 不能一直占着资源。
    const helloTimer = setTimeout(() => {
      if (!handshaken) {
        log.warn(`来自 ${remote} 的连接在 ${HELLO_TIMEOUT_MS}ms 内未握手，关闭`);
        try {
          ws.close(4401, 'hello timeout');
        } catch {
          /* ignore */
        }
      }
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    this.helloTimers.set(ws, helloTimer);

    ws.on('message', (raw: RawData) => {
      const frame = parseFrame(raw.toString());
      if (!frame) {
        // 单帧不合法只丢弃并记日志，不断开连接 ——
        // 断开会让一次编码 bug 变成「节点反复掉线」这种难查的现象。
        log.debug(`收到无法解析的帧（已丢弃），来源 ${state.connection?.nodeId ?? remote}`);
        return;
      }

      if (!handshaken) {
        if (frame.type !== 'request' || frame.method !== 'hello') {
          ws.close(4400, 'expected hello');
          return;
        }
        clearTimeout(helloTimer);
        handshaken = true;
        state.connection = this.handleHello(ws, frame, remote);
        return;
      }

      state.connection?.handleFrame(frame, this.requestHandler, this.hooks);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (state.connection) this.dropConnection(state.connection, 'connection closed');
    });

    ws.on('error', (error) => {
      log.warn(`连接错误（${state.connection?.nodeId ?? remote}）`, error);
    });
  }

  private handleHello(
    ws: WebSocket,
    frame: RpcRequest,
    remote: string,
  ): AgentConnection | null {
    const checked = validate(HelloSchema, frame.params ?? {});
    if (!checked.ok) {
      this.replyHelloError(ws, frame.id, 'INVALID_PARAMS', checked.error.message);
      return null;
    }

    const hello = checked.value;

    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      this.replyHelloError(
        ws,
        frame.id,
        'PROTOCOL_MISMATCH',
        `协议版本不匹配：插件 v${hello.protocolVersion}，平台 v${PROTOCOL_VERSION}。` +
          '请升级插件或平台，两者必须一致。',
      );
      log.error(
        `节点 ${hello.nodeId} 协议版本不匹配（插件 ${hello.protocolVersion} / 平台 ${PROTOCOL_VERSION}）`,
      );
      return null;
    }

    const node = this.store.getNode(hello.nodeId);
    if (!node) {
      // 不区分「节点不存在」与「密钥错误」：区分了等于给攻击者一个
      // 枚举有效节点 ID 的接口。
      this.replyHelloError(ws, frame.id, 'UNAUTHORIZED', '节点 ID 或密钥不正确');
      log.warn(`握手失败：未知节点 ${hello.nodeId}（来自 ${remote}）`);
      return null;
    }

    if (!verifySecret(hello.secret, node.secret_hash)) {
      this.replyHelloError(ws, frame.id, 'UNAUTHORIZED', '节点 ID 或密钥不正确');
      log.warn(`握手失败：节点 ${hello.nodeId} 密钥不正确（来自 ${remote}）`);
      return null;
    }

    if (node.enabled === 0) {
      this.replyHelloError(
        ws,
        frame.id,
        'NODE_DISABLED',
        '该节点已在平台侧停用，请在平台重新启用后重试',
      );
      log.warn(`握手失败：节点 ${hello.nodeId} 已停用`);
      return null;
    }

    // 同 ID 重复连接：踢掉旧的。多半是插件重启但旧连接还没超时，
    // 保留旧连接会让平台的请求发到一个已经没人处理的 socket 上。
    const existing = this.connections.get(hello.nodeId);
    if (existing && !existing.isClosed) {
      log.warn(`节点 ${hello.nodeId} 重复连接，断开旧连接`);
      this.dropConnection(existing, 'replaced by new connection');
    }

    const connection = new AgentConnection(
      ws,
      hello.nodeId,
      hello.agent,
      hello.capabilities,
      remote,
    );

    this.store.markNodeOnline(hello.nodeId, {
      agentVersion: hello.agent.version,
      mcVersion: hello.agent.mcVersion,
      brand: hello.agent.brand,
      capabilities: hello.capabilities,
    });

    // 握手上直接下发封禁快照，省掉一次往返。
    // 只发全平台 + 本节点的 —— 别的节点的封禁跟它无关。
    const active = this.store
      .listAllActivePunishments()
      .filter((row) => row.node_id === null || row.node_id === hello.nodeId)
      .map(toProtocolPunishment);

    connection.respond(frame.id, {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: `${hello.nodeId}-${Date.now()}`,
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      serverTime: Date.now(),
      capabilities: hello.capabilities,
      punish: { revision: this.store.getPunishRevision(), active },
      economy: {
        backend: hello.capabilities.includes('economy') ? 'vault' : 'none',
        currency: this.store.getConfig()['economy.currency_name'] ?? '金币',
      },
    });

    this.connections.set(hello.nodeId, connection);
    connection.startHeartbeat();

    log.info(
      `节点 ${hello.nodeId} 已连接（${hello.agent.brand} ${hello.agent.mcVersion}，` +
        `Agent ${hello.agent.version}，能力 ${hello.capabilities.join(',') || '无'}）`,
    );

    const fresh = this.store.getNode(hello.nodeId);
    if (fresh) this.hooks.onConnected(fresh, connection);

    return connection;
  }

  private replyHelloError(
    ws: WebSocket,
    id: string,
    code: ErrorCode,
    message: string,
  ): void {
    try {
      ws.send(encodeFrame({ type: 'response', id, ok: false, error: { code, message } }));
    } catch {
      /* ignore */
    }
    // 给客户端一点时间收到这一帧再关。
    setTimeout(() => {
      try {
        ws.close(4403, code);
      } catch {
        /* ignore */
      }
    }, 50).unref?.();
  }

  private dropConnection(connection: AgentConnection, reason: string): void {
    if (!connection.isClosed) connection.close(reason);
    if (this.connections.get(connection.nodeId) === connection) {
      this.connections.delete(connection.nodeId);
    }

    // 掉线时把该节点上的在线玩家标为离线。
    // 不标的话「在线人数」会永远停在掉线前那一刻，而这正是
    // 管理员最需要看准的数字。
    try {
      this.store.markNodePlayersOffline(connection.nodeId);
    } catch (error) {
      log.error(`标记节点 ${connection.nodeId} 的玩家离线失败`, error);
    }

    log.info(`节点 ${connection.nodeId} 已断开：${reason}`);
    this.hooks.onDisconnected(connection.nodeId, reason);
  }

  get(nodeId: string): AgentConnection | undefined {
    const connection = this.connections.get(nodeId);
    return connection && !connection.isClosed ? connection : undefined;
  }

  isOnline(nodeId: string): boolean {
    return this.get(nodeId) !== undefined;
  }

  list(): { nodeId: string; capabilities: string[]; connectedAt: number }[] {
    return [...this.connections.values()].map((c) => ({
      nodeId: c.nodeId,
      capabilities: [...c.capabilities],
      connectedAt: c.connectedAt,
    }));
  }

  /**
   * 向节点发一个 RPC。节点离线时抛 `NODE_OFFLINE`。
   * 上层据此回 HTTP 502，与「节点返回了错误」（502 `NODE_ERROR`）区分开。
   */
  async call<M extends ServerToAgentMethod>(
    nodeId: string,
    method: M,
    params: ServerToAgentMethods[M]['params'],
    timeoutMs?: number,
  ): Promise<ServerToAgentMethods[M]['result']> {
    return this.callRaw(nodeId, method, params, timeoutMs) as Promise<
      ServerToAgentMethods[M]['result']
    >;
  }

  /**
   * 动态方法名的调用入口。给薄代理路由用（LuckPerms 那一批），
   * 免得它们在泛型上反复 `as never`。
   */
  async callRaw(
    nodeId: string,
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    const connection = this.get(nodeId);
    if (!connection) {
      // 用 NODE_OFFLINE 而不是 NODE_DISABLED：这里是「连不上」，
      // 不是「平台不让连」。两者在运维眼里是两回事，前端提示也不同。
      throw new AgentCallError('NODE_OFFLINE', `节点 ${nodeId} 不在线`);
    }

    const checked = validateServerToAgentParams(method, params);
    if (!checked.ok) {
      throw new AgentCallError(
        'INVALID_PARAMS',
        `${method} 的参数未通过校验：${checked.error.message}`,
        checked.error.data,
      );
    }

    return connection.callUnknown(method, params, timeoutMs);
  }

  /** 广播一个事件给所有在线节点。 */
  broadcastEvent<E extends AgentEventName>(event: E, data: AgentEventMap[E], filter?: (nodeId: string) => boolean): void {
    for (const connection of this.connections.values()) {
      if (filter && !filter(connection.nodeId)) continue;
      connection.sendEvent(event, data);
    }
  }

  /**
   * 广播封禁快照。
   *
   * 发全量而非增量：快照通常只有几十条，全量让 Agent 本地状态
   * **永远可以自愈** —— 不必处理「丢了第 3 条增量」之后的缺口。
   */
  broadcastPunishSnapshot(): void {
    const revision = this.store.getPunishRevision();
    const all = this.store.listAllActivePunishments().map(toProtocolPunishment);

    for (const connection of this.connections.values()) {
      const scoped = all.filter(
        (row) => row.nodeId === null || row.nodeId === connection.nodeId,
      );
      connection.sendEvent('punish.sync', { revision, active: scoped });
    }
  }

  async closeAll(): Promise<void> {
    for (const connection of [...this.connections.values()]) {
      this.dropConnection(connection, '服务器关闭');
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

export function toProtocolPunishment(row: PunishmentRow): Punishment {
  return {
    id: row.id,
    type: row.type as Punishment['type'],
    uuid: row.uuid,
    name: row.name,
    reason: row.reason,
    operator: row.operator,
    nodeId: row.node_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    active: row.active === 1,
  };
}

export { AgentError };
