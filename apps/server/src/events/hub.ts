/**
 * 浏览器实时事件中枢。
 *
 * 职责：维护浏览器 WebSocket 连接、按 topic 订阅、转发 Agent 事件、
 * 以及为控制台保留一小段环形缓冲（新打开页面能立刻看到最近的日志，
 * 而不是盯着一片空白等下一行）。
 *
 * 与 Agent 网关是两条**独立**的 WebSocket 通道：
 * `/_api/events` 面向浏览器，`/agent` 面向 MC 服务端。
 * 混在一条通道上会让鉴权逻辑纠缠不清（浏览器用会话 Cookie，
 * Agent 用握手密钥）。
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';

import { createLogger } from '../logger.ts';
import type { AccountRow } from '../store/index.ts';
import {
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@kokuu/protocol';

const log = createLogger('events');

/** 每个节点的控制台环形缓冲行数。 */
const CONSOLE_BUFFER_LINES = 500;

export interface BrowserEvent {
  type: 'event';
  topic: string;
  event: string;
  ts: number;
  data: unknown;
}

interface ClientState {
  ws: WebSocket;
  account: AccountRow;
  permissions: Set<Permission>;
  topics: Set<string>;
  /** 是否已收到过 subscribe 帧。没订阅前不推任何东西。 */
  subscribed: boolean;
}

export interface ConsoleLine {
  ts: number;
  line: string;
  level: string;
}

export class EventsHub {
  private readonly wss: WebSocketServer;
  private readonly authenticate: (
    request: IncomingMessage,
  ) => Promise<AccountRow | null>;
  private readonly clients = new Set<ClientState>();
  private readonly consoleBuffers = new Map<string, ConsoleLine[]>();
  /** topic → 有订阅者的节点，避免给没人看的 topic 做无用功。 */
  private readonly consoleDropped = new Map<string, number>();

  constructor(
    authenticate: (request: IncomingMessage) => Promise<AccountRow | null>,
  ) {
    // 显式赋值而不是构造函数参数属性：`erasableSyntaxOnly` 下
    // 参数属性不是可擦除语法，Node 的类型剥离跑不起来。
    this.authenticate = authenticate;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  }

  attach(server: HttpServer): void {
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://placeholder');
      if (url.pathname !== '/_api/events' && url.pathname !== '/api/events') return;

      void this.authenticate(request).then((account) => {
        if (!account) {
          // 未登录直接拒。回一个 HTTP 401 而不是先升级再关 ——
          // 浏览器的 close 事件拿不到原因，调试时只能靠抓包。
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.onConnection(ws, account);
        });
      });
    });
  }

  private onConnection(ws: WebSocket, account: AccountRow): void {
    const permissions = new Set<Permission>(
      ROLE_PERMISSIONS[account.role as Role] ?? [],
    );

    const state: ClientState = { ws, account, permissions, topics: new Set(), subscribed: false };
    this.clients.add(state);

    log.debug(`浏览器事件连接建立：${account.username}`);

    ws.on('message', (raw: RawData) => {
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof frame !== 'object' || frame === null) return;
      const f = frame as { type?: unknown; topics?: unknown };
      if (f.type !== 'subscribe' || !Array.isArray(f.topics)) return;

      this.handleSubscribe(state, f.topics);
    });

    ws.on('close', () => {
      this.clients.delete(state);
      log.debug(`浏览器事件连接关闭：${account.username}`);
    });

    ws.on('error', () => {
      this.clients.delete(state);
    });
  }

  private handleSubscribe(state: ClientState, requested: unknown[]): void {
    const effective: string[] = [];

    for (const raw of requested) {
      if (typeof raw !== 'string') continue;

      const needed = requiredPermission(raw);
      if (needed && !state.permissions.has(needed)) continue;

      state.topics.add(raw);
      effective.push(raw);
    }

    state.subscribed = true;

    // 必须回**实际生效**的列表。只回请求列表的话，前端会一直显示
    // 「已订阅」但收不到任何东西，而原因（缺权限）无从得知。
    this.send(state, {
      type: 'subscribed',
      topics: effective,
      rejected: requested.filter((t) => typeof t === 'string' && !effective.includes(t)),
    });

    // 控制台 topic：立刻补发缓冲里的历史行，新页面不用干等。
    for (const topic of effective) {
      if (!topic.startsWith('console:')) continue;
      const nodeId = topic.slice('console:'.length);
      const buffered = this.consoleBuffers.get(nodeId) ?? [];
      for (const entry of buffered) {
        this.send(state, {
          type: 'event',
          topic,
          event: 'console.line',
          ts: entry.ts,
          data: { line: entry.line, level: entry.level, replay: true },
        });
      }
      const dropped = this.consoleDropped.get(nodeId) ?? 0;
      if (dropped > 0) {
        this.send(state, {
          type: 'event',
          topic,
          event: 'console.dropped',
          ts: Date.now(),
          data: { dropped },
        });
        // 报过就清零。不清的话这个数字会一路累加，
        // 第二次打开页面看到的会是「历史累计丢失」，而不是「你错过的那些」。
        this.consoleDropped.delete(nodeId);
      }
    }
  }

  private send(state: ClientState, payload: unknown): void {
    if (state.ws.readyState !== WebSocket.OPEN) return;
    try {
      state.ws.send(JSON.stringify(payload));
    } catch {
      /* 连接已断，close 事件会清理 */
    }
  }

  /** 广播一个事件给订阅了 `topic` 的浏览器。 */
  publish(topic: string, event: string, data: unknown): void {
    const payload: BrowserEvent = { type: 'event', topic, event, ts: Date.now(), data };

    for (const state of this.clients) {
      if (!state.subscribed) continue;
      if (!state.topics.has(topic)) continue;
      this.send(state, payload);
    }
  }

  /**
   * 收一行控制台日志。写入环形缓冲并广播给订阅者。
   *
   * **无人订阅时不入缓冲也不广播** —— 活动服务器每秒几百行，
   * 无人观看时保留只会白占内存。
   */
  pushConsole(nodeId: string, line: string, level: string): void {
    const topic = `console:${nodeId}`;
    const hasSubscriber = [...this.clients].some((c) => c.topics.has(topic));
    if (!hasSubscriber) return;

    let buffer = this.consoleBuffers.get(nodeId);
    if (!buffer) {
      buffer = [];
      this.consoleBuffers.set(nodeId, buffer);
    }
    const entry: ConsoleLine = { ts: Date.now(), line, level };
    buffer.push(entry);
    if (buffer.length > CONSOLE_BUFFER_LINES) buffer.splice(0, buffer.length - CONSOLE_BUFFER_LINES);

    this.publish(topic, 'console.line', { line, level });
  }

  /** 记录因限流被丢掉的行数，下次订阅时告知。 */
  noteConsoleDropped(nodeId: string, count: number): void {
    this.consoleDropped.set(nodeId, (this.consoleDropped.get(nodeId) ?? 0) + count);
  }

  clearConsoleDropped(nodeId: string): void {
    this.consoleDropped.delete(nodeId);
  }

  consoleHistory(nodeId: string): ConsoleLine[] {
    return [...(this.consoleBuffers.get(nodeId) ?? [])];
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** 服务重启前礼貌关闭所有浏览器连接。 */
  async close(): Promise<void> {
    for (const state of this.clients) {
      try {
        state.ws.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

/** topic → 需要的权限点。返回 null 表示公开（登录即可）。 */
function requiredPermission(topic: string): Permission | null {
  if (topic.startsWith('console:')) return 'console.execute';
  return null;
}
