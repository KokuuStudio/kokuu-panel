/**
 * 浏览器 ↔ 平台的载荷类型。
 *
 * `PlayerEntry` / `Punishment` / `LpUser` / `LpGroup` / `Metrics` / `ServerInfo`
 * 直接来自 `@kokuu/protocol`（docs/PROTOCOL.md 的权威定义），这里**不重复定义**。
 *
 * 本文只放 docs/API.md 定义、而协议包里没有的类型（PlayerProfile、
 * EconomyAccount、AuditEntry、会话记录等）。
 *
 * **字段形状以实际后端（apps/server）为准**，因为文档只给了部分响应体；
 * 与文档不一致的地方在 `api/endpoints.ts` 的归一化函数里逐条标注。
 */
import type {
  Metrics,
  Permission,
  Punishment,
  PunishmentType,
  Role,
  ServerInfo,
} from '@kokuu/protocol';

export type {
  Capability,
  EconomyBalance,
  LpGroup,
  LpGroupRef,
  LpMeta,
  LpPermission,
  LpUser,
  Metrics,
  Permission,
  PlayerEntry,
  Punishment,
  PunishmentType,
  Role,
  ServerInfo,
} from '@kokuu/protocol';

// ─────────────────────────────────────────────────────────────
// 通用
// ─────────────────────────────────────────────────────────────

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/** 列表接口的常见出入参，避免每个 endpoint 重复写一遍。 */
export interface ListQuery {
  page?: number;
  size?: number;
  kw?: string;
}

// ─────────────────────────────────────────────────────────────
// 认证
// ─────────────────────────────────────────────────────────────

export interface Account {
  id: number;
  username: string;
  /** 后端回 display_name，缺省时等于 username。 */
  displayName?: string;
  role: Role;
  permissions: string[];
}

export interface LoginResult {
  account: Account;
}

export interface MeResult {
  account: Account;
}

/** 后台账号行。后端字段是 `disabled`，前端统一暴露 `enabled`。 */
export interface AccountEntry {
  id: number;
  username: string;
  displayName?: string;
  role: Role;
  permissions?: string[];
  enabled?: boolean;
  createdAt?: number | null;
  lastLoginAt?: number | null;
}

export interface AccountCreatePayload {
  username: string;
  password: string;
  role: Role;
  displayName?: string;
}

// ─────────────────────────────────────────────────────────────
// 节点
// ─────────────────────────────────────────────────────────────

/** 节点状态是「在线 / 离线 / 被停用」三态，不是布尔。 */
export const NODE_STATUSES = ['online', 'offline', 'disabled'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export interface NodeSummary {
  id: string;
  name: string;
  enabled: boolean;
  status: NodeStatus;
  lastSeenAt: number | null;
  agentVersion: string | null;
  mcVersion: string | null;
  brand: string | null;
  capabilities: string[];
  tags: string[];
  createdAt: number;
  /**
   * ⚠️ 后端在「没有 metrics」时回 **null**（不是 0）。
   * 视图必须把 null 显示成「—」—— 显示 0 会让人以为服务器开着但没人。
   */
  onlinePlayers: number | null;
  maxPlayers: number | null;
  /** 离线时为 null（docs/API.md）。 */
  metrics: Metrics | null;
  /** 后端额外提供：metrics 缓存已存在多久（毫秒），用于提示「数据是不是陈旧的」。 */
  metricsAgeMs?: number | null;
}

export interface NodeCreatePayload {
  id: string;
  name: string;
  tags: string[];
}

export interface NodePatchPayload {
  name?: string;
  tags?: string[];
  enabled?: boolean;
}

/** 密钥只在创建与轮换时出现，只此一次。 */
export interface NodeSecretResult {
  secret: string;
  node?: NodeSummary;
}

export interface ServerInfoResult {
  info: ServerInfo;
}

export interface MetricsResult {
  metrics: Metrics;
  /** 后端额外提供：这份 metrics 的年龄（毫秒）。 */
  ageMs?: number;
}

export interface ConsoleExecuteResult {
  success: boolean;
  output: string[];
}

export interface ConsoleLine {
  line: string;
  level?: string;
  ts?: number;
  dropped?: number;
}

/** 后端回 `{ lines: ConsoleLine[] }`；文档没写响应体，这里两种都接受。 */
export type ConsoleHistoryResult = ConsoleLine[] | { lines?: ConsoleLine[]; items?: ConsoleLine[] };

// ─────────────────────────────────────────────────────────────
// 玩家
// ─────────────────────────────────────────────────────────────

/** 后端 `GET /players/:uuid/sessions` 回的行（没有 durationSeconds）。 */
export interface PlayerSession {
  id?: number | string;
  nodeId?: string | null;
  ip?: string;
  joinedAt?: number;
  leftAt?: number | null;
  playtimeSeconds?: number | null;
}

/** 后端 `GET /players/:uuid/ips` 回的行：次数字段叫 `seenCount`。 */
export interface PlayerIpRecord {
  ip: string;
  firstSeenAt?: number;
  lastSeenAt?: number;
  seenCount?: number;
  /** 兼容字段：某些实现用 count。 */
  count?: number;
}

/** 后端 `GET /players/:uuid/names` 回的行（没有 changedAt）。 */
export interface PlayerNameRecord {
  name: string;
  changedAt?: number;
  firstSeenAt?: number;
  lastSeenAt?: number;
}

export interface EconomyAccountRef {
  balance: number;
}

export interface GameCurrencyEntry {
  balance: number;
  currency: string;
}

export interface PlayerProfile {
  uuid: string;
  name: string;
  knownNames?: string[];
  firstSeenAt?: number;
  lastSeenAt?: number;
  playtimeSeconds?: number;
  /** 需要 `player.view_ip`；无权限时字段**不返回**（不是 null）。 */
  lastIp?: string;
  online?: boolean;
  nodeId?: string | null;
  punishments?: Punishment[];
  economy?: EconomyAccountRef;
  gameCurrency?: Record<string, GameCurrencyEntry>;
}

export interface PlayerResolveResult {
  uuid: string;
  name: string;
  online: boolean;
}

export interface PlayerListQuery extends ListQuery {
  online?: boolean | null;
  node?: string | null;
}

// ─────────────────────────────────────────────────────────────
// 封禁 / 禁言
// ─────────────────────────────────────────────────────────────

export interface PunishmentDispatchResult {
  nodeId: string;
  ok: boolean;
  code?: string;
  message?: string;
}

/**
 * 平台侧的处罚记录。
 *
 * `revokedAt` / `revokedBy` 只出现在 docs/API.md 的示例里，
 * 当前后端（apps/server）**不返回**这两个字段，也**没有** Punishment 之外的
 * revokedAt —— 因此它们全部是可选的：值为 undefined 时按「未撤销」处理。
 * 因此判断「是否已撤销」要同时看 `active === false` 与 `revokedAt`。
 */
export interface PunishmentRevokeInfo {
  revokedAt?: number | null;
  revokedBy?: string | null;
}

export type PunishmentRecord = Punishment & PunishmentRevokeInfo;

export interface PunishmentCreatePayload {
  type: PunishmentType;
  uuid: string;
  name: string;
  reason: string;
  /** null = 永久。 */
  durationSeconds: number | null;
  /** null = 全平台。 */
  nodeId: string | null;
  kickNow?: boolean;
}

export interface PunishmentCreateResponse {
  punishment: Punishment;
  /** 下发结果。失败的节点必须显式提示，不能静默吞掉。 */
  dispatched?: PunishmentDispatchResult[];
}

export interface PunishmentListQuery extends ListQuery {
  type?: PunishmentType | null;
  active?: boolean | null;
  uuid?: string | null;
  node?: string | null;
}

// ─────────────────────────────────────────────────────────────
// LuckPerms
// ─────────────────────────────────────────────────────────────

/** 所有 LP 写操作统一返回这个。`changed:false` = 本来就是这个值。 */
export interface ChangedResult {
  changed: boolean;
}

// ─────────────────────────────────────────────────────────────
// 经济
// ─────────────────────────────────────────────────────────────

export interface EconomyAccount {
  uuid: string;
  name: string;
  balance: number;
  updatedAt: number | null;
}

/** 后端 ledger 行没有 `ts` / `currency`，只有 `createdAt` 等字段。 */
export interface LedgerEntry {
  id: number;
  uuid?: string;
  name?: string;
  delta?: number;
  balanceAfter?: number;
  currency?: string;
  source?: string;
  note?: string;
  eventId?: string;
  operator?: string;
  ts?: number;
  createdAt?: number;
}

export interface EconomyAccountDetail {
  account: EconomyAccount;
  ledger: LedgerEntry[];
  total?: number;
}

/**
 * 经济概览。
 * 后端 `GET /economy/stats` 实际回：
 * `{ accounts, totalBalance, ledgerCount, last24hDelta, topBalances, sources, config }`。
 * 这里只保留视图用得到的部分。
 */
export interface EconomyStats {
  totalAccounts?: number | null;
  totalBalance?: number | null;
  ledgerCount?: number | null;
  last24hDelta?: number | null;
  topBalances?: Array<{ uuid: string; name: string | null; balance: number }>;
  sources?: Array<{ source: string; count: number; delta: number }>;
}

/**
 * 经济配置。
 * 后端存的是 `economy.ratio` 这类点号键的字符串值，前端用下面这套驼峰/下划线字段。
 * 三个约束由服务端强制校验：`min_coin >= ratio`、`ratio >= 1`、各项限额 `>= 0`。
 */
export interface EconomyConfig {
  /** 1 积分 = ratio 游戏币。 */
  ratio: number;
  min_coin: number;
  currency: string;
  daily_limit?: number;
  single_limit?: number;
  points_name?: string;
  enabled?: boolean;
}

export interface EconomyAdjustPayload {
  /** 不接受 0。 */
  delta: number;
  note?: string;
  /** 幂等键；省略时服务端生成。 */
  eventId?: string;
}

export interface EconomyAdjustResult {
  balance: number;
  ledgerId: number;
}

export interface GameCurrencyPayload {
  nodeId: string;
  /** 不接受 0。 */
  amount: number;
  note?: string;
  eventId?: string;
}

export interface GameCurrencyResult {
  balanceAfter: number;
}

// ─────────────────────────────────────────────────────────────
// 审计
// ─────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  actorIp?: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  nodeId: string | null;
  params?: Record<string, unknown> | null;
  ok: boolean;
  error?: string | null;
}

export interface AuditQuery {
  actor?: string | null;
  action?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  nodeId?: string | null;
  ok?: boolean | null;
  from?: number | null;
  to?: number | null;
  page?: number;
  size?: number;
}

// ─────────────────────────────────────────────────────────────
// 实时事件（docs/API.md「实时事件」）
// ─────────────────────────────────────────────────────────────

export const EVENT_TOPICS = ['nodes', 'players', 'punish'] as const;
export type EventTopic = (typeof EVENT_TOPICS)[number] | `console:${string}`;

export interface EventFrame {
  type: 'event';
  topic: string;
  event: string;
  ts: number;
  data: unknown;
}

/**
 * 服务端回的真实生效 topic 列表。
 * **必须用这个列表**，不能用本地请求的列表 —— 带 `console:` 的 topic
 * 在缺 `console.execute` 权限时会被服务端静默剔除，本地列表会让 UI 一直
 * 显示「已订阅」却收不到任何东西。
 */
export interface SubscribedFrame {
  type: 'subscribed';
  topics: string[];
}

export interface ErrorFrame {
  type: 'error';
  code?: string;
  message?: string;
}

export type ServerFrame = EventFrame | SubscribedFrame | ErrorFrame | { type: string };

/** 便利别名，给 store / 组件用。 */
export type { Metrics as NodeMetrics, ServerInfo as NodeServerInfo, Permission as PermissionName };
