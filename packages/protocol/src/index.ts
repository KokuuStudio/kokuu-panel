/**
 * KokuuPanel Agent 协议 v1 —— 类型与常量。
 *
 * 这是三端（后端、Java Agent、模拟 Agent）共用的唯一契约，
 * 对应文档：docs/PROTOCOL.md。改这里之前先读那份文档的第 8 节。
 *
 * 本文件不含任何运行时依赖，可以被浏览器直接引入；
 * 需要校验的地方用 `@kokuu/protocol/schemas`。
 */

export const PROTOCOL_VERSION = 1 as const;

/** 握手前必须发出的方法名。服务端在收到它之前不接受任何其他帧。 */
export const HELLO_METHOD = 'hello' as const;

/** 握手超时：连接建立后多久没收到 hello 就断开。 */
export const HELLO_TIMEOUT_MS = 5_000;

/** 心跳间隔。服务端按此频率发 ping，Agent 必须回 pong。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 连续多少次心跳未回判定离线。
 * 15s × 3 = 45s 内发现掉线 —— 这是「发现掉线要快」与
 * 「网络抖一下不要误报」之间的平衡点。
 */
export const HEARTBEAT_MISS_LIMIT = 3;

/** 单次 RPC 默认超时（毫秒）。 */
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/** 单条 WebSocket 文本帧上限。防止对端发超大帧把内存打满。 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────
// 能力
// ─────────────────────────────────────────────────────────────

/**
 * Agent 能力自述。插件按「实际装了什么」上报，
 * 平台据此隐藏对应入口 —— 用户看不到点了会报错的功能。
 */
export type Capability =
  | 'console'
  | 'players'
  | 'punish'
  | 'whitelist'
  | 'luckperms'
  | 'economy';

export const ALL_CAPABILITIES: readonly Capability[] = [
  'console',
  'players',
  'punish',
  'whitelist',
  'luckperms',
  'economy',
];

// ─────────────────────────────────────────────────────────────
// 错误码
// ─────────────────────────────────────────────────────────────

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'PROTOCOL_MISMATCH'
  | 'NODE_DISABLED'
  /**
   * 节点不在线。
   *
   * 与 `NODE_DISABLED`（平台侧主动停用）刻意分开：一个是「连不上」，
   * 一个是「不让连」。运维看到这两个词排查方向完全不同，
   * 前端也要给出不同的提示文案。
   */
  | 'NODE_OFFLINE'
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'NOT_ONLINE'
  | 'UNSUPPORTED'
  | 'NO_LUCKPERMS'
  | 'NO_ECONOMY'
  | 'READ_ONLY'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'INTERNAL';

export interface RpcError {
  code: ErrorCode;
  message: string;
  data?: unknown;
}

/** 带 code 的错误，用于 Agent 侧抛出后被统一转成 RpcError。 */
export class AgentError extends Error {
  readonly code: ErrorCode;
  readonly data: unknown;

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.data = data;
  }
}

// ─────────────────────────────────────────────────────────────
// 帧
// ─────────────────────────────────────────────────────────────

export interface RpcRequest {
  type: 'request';
  id: string;
  method: string;
  params?: unknown;
}

export interface RpcResponseOk {
  type: 'response';
  id: string;
  ok: true;
  result: unknown;
}

export interface RpcResponseErr {
  type: 'response';
  id: string;
  ok: false;
  error: RpcError;
}

export type RpcResponse = RpcResponseOk | RpcResponseErr;

export interface RpcEvent {
  type: 'event';
  event: string;
  ts: number;
  data: unknown;
}

export type Frame = RpcRequest | RpcResponse | RpcEvent;

// ─────────────────────────────────────────────────────────────
// 载荷类型
// ─────────────────────────────────────────────────────────────

export interface AgentBuildInfo {
  version: string;
  mcVersion: string;
  brand: string;
  javaVersion: string;
}

export interface HelloParams {
  protocolVersion: number;
  nodeId: string;
  secret: string;
  agent: AgentBuildInfo;
  capabilities: Capability[];
}

export interface PluginInfo {
  name: string;
  version: string;
}

export interface WorldInfo {
  name: string;
  environment: string;
  players: number;
  entities: number;
  chunks: number;
}

export interface ServerInfo {
  name: string;
  brand: string;
  version: string;
  bukkitVersion: string;
  port: number;
  onlineMode: boolean;
  maxPlayers: number;
  viewDistance: number;
  motd: string;
  plugins: PluginInfo[];
  worlds: WorldInfo[];
  whitelistEnabled: boolean;
}

export interface Metrics {
  /**
   * [1m, 5m, 15m]。取不到时必须是 null。
   * 1.12.2 的 Spigot 没有 getTPS()，降级实现也可能拿不到 ——
   * 这时候编一个 20.0 会让运维看着「一切正常」，比不显示更糟。
   */
  tps: [number, number, number] | null;
  mspt: number | null;
  online: number;
  maxPlayers: number;
  memory: { used: number; max: number; free: number };
  threads: number;
  uptimeSeconds: number;
  entities: number;
  chunks: number;
}

export interface PlayerEntry {
  uuid: string;
  name: string;
  displayName: string;
  online: boolean;
  world: string;
  x: number;
  y: number;
  z: number;
  ping: number;
  gamemode: string;
  health: number;
  food: number;
  level: number;
  op: boolean;
  whitelisted: boolean;
  /** 仅 players.list 传 withIp=true 且账号有权限时出现。 */
  ip?: string;
  firstPlayed: number;
  lastSeen: number;
  playtimeSeconds: number;
}

export type PunishmentType = 'ban' | 'mute' | 'warn' | 'kick';

export interface Punishment {
  id: string;
  type: PunishmentType;
  uuid: string;
  name: string;
  reason: string;
  operator: string;
  /** null = 全平台生效；否则只在该节点生效。 */
  nodeId: string | null;
  createdAt: number;
  /** null = 永久。 */
  expiresAt: number | null;
  active: boolean;
}

export interface WhitelistEntry {
  uuid: string;
  name: string;
}

export interface LpGroupRef {
  name: string;
  weight: number;
  direct: boolean;
}

export interface LpPermission {
  key: string;
  value: boolean;
  direct: boolean;
}

/**
 * 权限目录里的一条 —— 「这个服务端上存在这个权限节点」。
 *
 * 来源是 {@code Bukkit.getPluginManager().getPermissions()}，也就是
 * **各插件启动时注册进来的权限**。这是判断「某个节点到底存不存在」的权威依据：
 * 手动敲一个没人注册过的节点，LuckPerms 会照样存下来，但它永远不会生效，
 * 而管理员从界面上看不出区别。
 */
export interface LpPermissionInfo {
  node: string;
  /** 插件注册时给的描述；没写描述则为 null。 */
  description: string | null;
  /** 注册的默认值：TRUE / FALSE / OP / NOT_OP。 */
  defaultValue: string | null;
  /** 注册它的插件名，方便判断这个节点属于谁（如 CMI、LuckPerms）。 */
  plugin: string | null;
}

export interface LpMeta {
  prefix: string;
  suffix: string;
  weight: number;
}

export interface LpUser {
  uuid: string;
  name: string;
  primaryGroup: string;
  groups: LpGroupRef[];
  permissions: LpPermission[];
  meta: LpMeta;
  inheritedPermissionsCount: number;
}

export interface LpGroup {
  name: string;
  displayName: string;
  weight: number;
  parents: string[];
  permissions: LpPermission[];
  meta: LpMeta;
  /** 统计全量用户开销大，Agent 可选实现，可能为 null。 */
  userCount: number | null;
}

export interface EconomyBalance {
  balance: number;
  currency: string;
  backend: string;
}

// ─────────────────────────────────────────────────────────────
// 方法表
// ─────────────────────────────────────────────────────────────

/**
 * 平台 → Agent。
 *
 * 用「方法名 → { params, result }」的映射而不是一堆函数签名，
 * 是为了让 `call()` 能从方法名自动推出参数与返回类型：
 *
 *   await call(nodeId, 'players.kick', { uuid, reason })  // 参数与返回值都被检查
 */
export interface ServerToAgentMethods {
  ping: { params: Record<string, never>; result: { nonce: string } };

  'server.info': { params: Record<string, never>; result: ServerInfo };
  'server.metrics': { params: Record<string, never>; result: Metrics };
  'console.execute': {
    params: { command: string };
    result: { success: boolean; output: string[] };
  };

  'players.list': { params: { withIp?: boolean }; result: PlayerEntry[] };
  'players.detail': { params: { uuid: string }; result: PlayerEntry };
  'players.kick': { params: { uuid: string; reason: string }; result: { ok: true } };
  'players.setOp': { params: { uuid: string; value: boolean }; result: { ok: true } };
  'players.setGamemode': {
    params: { uuid: string; gamemode: string };
    result: { ok: true };
  };
  'players.setWhitelist': {
    params: { uuid: string; name: string; value: boolean };
    result: { ok: true };
  };
  'players.resolve': {
    params: { name: string };
    result: { uuid: string; name: string; online: boolean };
  };

  'punish.apply': { params: { punishment: Punishment }; result: { ok: true } };
  'punish.revoke': { params: { id: string }; result: { ok: true } };
  'punish.kickNow': { params: { uuid: string; reason: string }; result: { ok: true } };

  'whitelist.list': { params: Record<string, never>; result: WhitelistEntry[] };
  'whitelist.setEnabled': { params: { value: boolean }; result: { ok: true } };

  'luckperms.user.get': {
    params: { uuid: string; name?: string };
    result: LpUser;
  };
  'luckperms.user.setPrimaryGroup': {
    params: { uuid: string; group: string };
    result: { ok: true; changed: boolean };
  };
  'luckperms.user.addGroup': {
    params: { uuid: string; group: string };
    result: { ok: true; changed: boolean };
  };
  'luckperms.user.removeGroup': {
    params: { uuid: string; group: string };
    result: { ok: true; changed: boolean };
  };
  'luckperms.user.setPermission': {
    params: { uuid: string; permission: string; value: boolean };
    result: { ok: true; changed: boolean };
  };
  'luckperms.user.unsetPermission': {
    params: { uuid: string; permission: string };
    result: { ok: true; changed: boolean };
  };
  'luckperms.user.setMeta': {
    params: { uuid: string; prefix?: string; suffix?: string };
    result: { ok: true; changed: boolean };
  };

  'luckperms.groups.list': { params: Record<string, never>; result: LpGroup[] };
  /**
   * 权限节点目录（只读）。
   *
   * 让界面能给出**真实存在**的节点候选，而不是让管理员盲敲。
   * 数据来自所有插件注册的权限（见到 `Bukkit.getPluginManager().getPermissions()`）。
   */
  'luckperms.permissions.catalog': {
    params: { query?: string; limit?: number };
    result: {
      items: LpPermissionInfo[];
      /** 服务端注册的权限总数（过滤之前），用来提示「是不是被截断了」。 */
      total: number;
      truncated: boolean;
    };
  };
  'luckperms.group.create': {
    params: { name: string };
    result: { ok: true; changed: boolean };
  };
  'luckperms.group.delete': {
    params: { name: string };
    result: { ok: true; changed: boolean };
  };
  'luckperms.group.setPermission': {
    params: { name: string; permission: string; value: boolean };
    result: { ok: true; changed: boolean };
  };
  'luckperms.group.unsetPermission': {
    params: { name: string; permission: string };
    result: { ok: true; changed: boolean };
  };
  'luckperms.group.setParent': {
    params: { name: string; parent: string };
    result: { ok: true; changed: boolean };
  };
  'luckperms.group.removeParent': {
    params: { name: string; parent: string };
    result: { ok: true; changed: boolean };
  };
  'luckperms.group.setWeight': {
    params: { name: string; weight: number };
    result: { ok: true; changed: boolean };
  };
  'luckperms.group.setMeta': {
    params: { name: string; prefix?: string; suffix?: string };
    result: { ok: true; changed: boolean };
  };

  'economy.getBalance': {
    params: { uuid: string; name?: string };
    result: EconomyBalance;
  };
  'economy.adjust': {
    params: {
      uuid: string;
      name: string;
      amount: number;
      note?: string;
      eventId: string;
    };
    /**
     * `duplicate` 表示这次 `eventId` **之前已经处理过**，本次没有真的动钱
     * （`balanceAfter` 是那一次的结果）。
     *
     * 为什么是「成功 + 标记」而不是报错：幂等键的用途就是让调用方在
     * **没收到响应**时重试。重试理应拿到成功，而不是一个需要特殊处理
     * 的错误 —— 否则「网络超时后重试」这条最正常的路径会变成异常分支。
     *
     * ⚠️ 与平台自带账本的 `POST /economy/accounts/:uuid/adjust` 语义不同：
     * 那条路重复 `eventId` 回 409 CONFLICT。两边都安全（都不会重复发钱），
     * 但调用方需要知道区别。
     */
    result: { ok: true; balanceAfter: number; duplicate: boolean };
  };
}

/** Agent → 平台。 */
export interface AgentToServerMethods {
  'player.resolve': {
    params: { uuid?: string; name?: string };
    result: {
      uuid: string;
      name: string;
      known: boolean;
      punishments: Punishment[];
    };
  };
  'punish.snapshot': {
    params: Record<string, never>;
    result: { revision: number; active: Punishment[] };
  };
  'economy.stats': { params: Record<string, never>; result: Record<string, unknown> };
}

export type ServerToAgentMethod = keyof ServerToAgentMethods;
export type AgentToServerMethod = keyof AgentToServerMethods;

/**
 * 方法 → 必需能力。
 * 平台在发请求**之前**查这张表，能力不足直接返回 UNSUPPORTED，
 * 不必等一个来回。少了这张表，前端就会在「节点没装 LuckPerms」时
 * 转圈 10 秒然后超时。
 */
export const METHOD_CAPABILITY: Partial<Record<ServerToAgentMethod, Capability>> = {
  'console.execute': 'console',
  'players.list': 'players',
  'players.detail': 'players',
  'players.kick': 'players',
  'players.setOp': 'players',
  'players.setGamemode': 'players',
  'players.setWhitelist': 'whitelist',
  'players.resolve': 'players',
  'punish.apply': 'punish',
  'punish.revoke': 'punish',
  'punish.kickNow': 'punish',
  'whitelist.list': 'whitelist',
  'whitelist.setEnabled': 'whitelist',
  'luckperms.user.get': 'luckperms',
  'luckperms.user.setPrimaryGroup': 'luckperms',
  'luckperms.user.addGroup': 'luckperms',
  'luckperms.user.removeGroup': 'luckperms',
  'luckperms.user.setPermission': 'luckperms',
  'luckperms.user.unsetPermission': 'luckperms',
  'luckperms.user.setMeta': 'luckperms',
  'luckperms.groups.list': 'luckperms',
  'luckperms.permissions.catalog': 'luckperms',
  'luckperms.group.create': 'luckperms',
  'luckperms.group.delete': 'luckperms',
  'luckperms.group.setPermission': 'luckperms',
  'luckperms.group.unsetPermission': 'luckperms',
  'luckperms.group.setParent': 'luckperms',
  'luckperms.group.removeParent': 'luckperms',
  'luckperms.group.setWeight': 'luckperms',
  'luckperms.group.setMeta': 'luckperms',
  'economy.getBalance': 'economy',
  'economy.adjust': 'economy',
};

// ─────────────────────────────────────────────────────────────
// 事件表
// ─────────────────────────────────────────────────────────────

export interface AgentEventMap {
  'player.join': { uuid: string; name: string; ip: string };
  'player.quit': { uuid: string; name: string; playtimeSeconds: number };
  'player.chat': { uuid: string; name: string; message: string };
  'player.death': { uuid: string; name: string; cause: string; killer: string };
  'player.command': { uuid: string; name: string; command: string };
  'console.line': { line: string; level: string; dropped?: number };
  'server.metrics': Metrics;
  'punish.applied': Punishment;
  'punish.revoked': { id: string };
  /**
   * 封禁快照广播。平台每次变更封禁后向相关节点推**全量** active 列表
   * 与新的 `revision`。发全量而非增量，是为了让 Agent 的本地状态
   * 永远可以自愈 —— 不必处理「丢了第 3 条增量」之后的缺口。
   */
  'punish.sync': { revision: number; active: Punishment[] };
  'whitelist.changed': { enabled: boolean };
  'agent.log': { level: string; message: string };
  /** 平台内部事件：节点上线/离线，由网关产生而非 Agent 上报。 */
  'node.connected': { nodeId: string };
  'node.disconnected': { nodeId: string; reason: string };
}

export type AgentEventName = keyof AgentEventMap;

// ─────────────────────────────────────────────────────────────
// 帧工具
// ─────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 解析入站文本帧。返回 null 表示这帧不合法，调用方应记日志并丢弃（不要断开）。 */
export function parseFrame(raw: string): Frame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;

  switch (value.type) {
    case 'request':
      if (typeof value.id !== 'string' || typeof value.method !== 'string') return null;
      return {
        type: 'request',
        id: value.id,
        method: value.method,
        params: value.params,
      };

    case 'response': {
      if (typeof value.id !== 'string' || typeof value.ok !== 'boolean') return null;
      if (value.ok) {
        return { type: 'response', id: value.id, ok: true, result: value.result };
      }
      const err = isObject(value.error) ? value.error : {};
      return {
        type: 'response',
        id: value.id,
        ok: false,
        error: {
          code: (typeof err.code === 'string' ? err.code : 'INTERNAL') as ErrorCode,
          message: typeof err.message === 'string' ? err.message : '未知错误',
          data: err.data,
        },
      };
    }

    case 'event':
      if (typeof value.event !== 'string') return null;
      return {
        type: 'event',
        event: value.event,
        ts: typeof value.ts === 'number' ? value.ts : Date.now(),
        data: value.data,
      };

    default:
      return null;
  }
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

/** 把任意抛出的异常收敛成协议里的 RpcError。 */
export function toRpcError(error: unknown): RpcError {
  if (error instanceof AgentError) {
    return { code: error.code, message: error.message, data: error.data };
  }
  if (error instanceof Error) {
    return { code: 'INTERNAL', message: error.message };
  }
  return { code: 'INTERNAL', message: String(error) };
}

/** 玩家名白名单。防止名字被当成命令或 SQL 片段拼进下游。 */
export const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

/** 严格 UUID（带横线）。 */
export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 全 0 UUID 排除 —— Bukkit 对「从未上线过的名字」返回它，
 *  当成真实身份会把不同玩家合并成同一个账号。 */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export function isSafePlayerName(name: unknown): name is string {
  return typeof name === 'string' && PLAYER_NAME_RE.test(name);
}

export function isSafeUuid(uuid: unknown): uuid is string {
  return (
    typeof uuid === 'string' &&
    UUID_RE.test(uuid) &&
    uuid.toLowerCase() !== NIL_UUID
  );
}

/** 权限点。角色的权限集合是它的子集。 */
export type Permission =
  | 'node.view'
  | 'node.manage'
  | 'player.view'
  | 'player.manage'
  | 'player.view_ip'
  | 'punish.view'
  | 'punish.manage'
  | 'luckperms.view'
  | 'luckperms.manage'
  | 'economy.view'
  | 'economy.manage'
  | 'console.execute'
  | 'audit.view'
  | 'account.manage';

export type Role = 'owner' | 'admin' | 'moderator' | 'viewer';

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    'node.view',
    'node.manage',
    'player.view',
    'player.manage',
    'player.view_ip',
    'punish.view',
    'punish.manage',
    'luckperms.view',
    'luckperms.manage',
    'economy.view',
    'economy.manage',
    'console.execute',
    'audit.view',
    'account.manage',
  ],
  admin: [
    'node.view',
    'node.manage',
    'player.view',
    'player.manage',
    'player.view_ip',
    'punish.view',
    'punish.manage',
    'luckperms.view',
    'luckperms.manage',
    'economy.view',
    'economy.manage',
    'console.execute',
    'audit.view',
  ],
  // 版主：能管玩家和封禁，碰不到权限组和经济。
  moderator: [
    'node.view',
    'player.view',
    'player.manage',
    'punish.view',
    'punish.manage',
    'luckperms.view',
    'economy.view',
    'audit.view',
  ],
  viewer: [
    'node.view',
    'player.view',
    'punish.view',
    'luckperms.view',
    'economy.view',
  ],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
