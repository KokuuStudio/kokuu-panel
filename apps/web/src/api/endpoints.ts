/**
 * 按 docs/API.md 逐个封装接口。
 *
 * **重要：后端（apps/server）已实现，且部分响应的「信封」与文档不一致。**
 * 例如文档写 `GET /_api/nodes → Node[]`，实际是 `{ items: Node[] }`；
 * 文档写 `GET /_api/nodes/:id → Node`，实际是 `{ node: Node }`。
 * 为了让页面能真跑，这里统一在**本文件内**拆信封、做字段归一化，
 * 对外仍然暴露文档意义上的类型（`NodeSummary` / `PlayerProfile` …），
 * 视图层不感知差异。每一处不一致都在下面用 `⚠️ 文档 vs 实现` 注明。
 *
 * 约定：返回值一律是「已解包的 data」；错误一律抛 `ApiError`（见 ./client.ts）。
 */
import { request } from './client';
import type {
  Account,
  AccountCreatePayload,
  AccountEntry,
  AuditEntry,
  AuditQuery,
  ChangedResult,
  ConsoleExecuteResult,
  ConsoleHistoryResult,
  EconomyAccount,
  EconomyAccountDetail,
  EconomyAdjustPayload,
  EconomyAdjustResult,
  EconomyConfig,
  EconomyStats,
  EconomyStatus,
  GameCurrencyBalance,
  GameCurrencyPayload,
  GameCurrencyResult,
  LedgerEntry,
  LoginResult,
  LpGroup,
  LpPermissionCatalog,
  LpUser,
  MeResult,
  MetricsResult,
  NodeCreatePayload,
  NodePatchPayload,
  NodeSecretResult,
  NodeSummary,
  PageResult,
  PlayerEntry,
  PlayerIpRecord,
  PlayerListQuery,
  PlayerNameRecord,
  PlayerProfile,
  PlayerResolveResult,
  PlayerSession,
  PunishmentCreatePayload,
  PunishmentCreateResponse,
  PunishmentListQuery,
  PunishmentRecord,
  ServerInfoResult,
} from './types';

// ─────────────────────────────────────────────────────────────
// 内部工具：信封拆解 / 字段归一化
// ─────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** 数值字段归一化：字符串 / null 都能吃。 */
function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 列表信封：`T[]` / `{items}` / `{groups}` / `{players}` / `{lines}` 都拍平成数组。
 * 文档只给「结果类型」，实现用了具名键，这里一并兼容。
 */
function unwrapList<T>(raw: unknown, key?: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (isObject(raw)) {
    if (key && Array.isArray(raw[key])) return raw[key] as T[];
    for (const candidate of ['items', 'groups', 'players', 'lines', 'list']) {
      if (Array.isArray(raw[candidate])) return raw[candidate] as T[];
    }
  }
  return [];
}

/** 分页信封：缺 total / page / size 时用入参兜底（`/accounts` 只回 items）。 */
function unwrapPage<T>(raw: unknown, fallback: { page: number; size: number }, key?: string): PageResult<T> {
  const items = unwrapList<T>(raw, key);
  const source = isObject(raw) ? raw : {};
  return {
    items,
    total: asNumber(source['total'], items.length),
    page: asNumber(source['page'], fallback.page),
    size: asNumber(source['size'], fallback.size),
  };
}

/**
 * 节点归一化。
 * ⚠️ 实现里 `onlinePlayers` / `maxPlayers` 在拿不到 metrics 时是 **null**（文档写的 Node 形状
 * 没有这点，但 offline 时 metrics 为 null）。这里保持 null，绝不退化成 0 ——
 * 0 会让人以为「服务器开着、只是没人」。
 */
function normalizeNode(raw: unknown): NodeSummary {
  const node = isObject(raw) ? raw : {};
  const metrics = isObject(node['metrics'])
    ? (node['metrics'] as unknown as NodeSummary['metrics'])
    : null;
  return {
    id: asString(node['id']),
    name: asString(node['name']),
    enabled: node['enabled'] !== false,
    status: (asString(node['status'], 'offline') as NodeSummary['status']) ?? 'offline',
    lastSeenAt: asNumberOrNull(node['lastSeenAt']),
    agentVersion: typeof node['agentVersion'] === 'string' ? node['agentVersion'] : null,
    mcVersion: typeof node['mcVersion'] === 'string' ? node['mcVersion'] : null,
    brand: typeof node['brand'] === 'string' ? node['brand'] : null,
    capabilities: Array.isArray(node['capabilities']) ? (node['capabilities'] as string[]) : [],
    tags: Array.isArray(node['tags']) ? (node['tags'] as string[]) : [],
    createdAt: asNumber(node['createdAt']),
    onlinePlayers: asNumberOrNull(node['onlinePlayers']),
    maxPlayers: asNumberOrNull(node['maxPlayers']),
    metrics,
    metricsAgeMs: asNumberOrNull(node['metricsAgeMs']),
  };
}

/** 账户归一化：实现用 `disabled`，文档/UI 用 `enabled`。 */
function normalizeAccountEntry(raw: unknown): AccountEntry {
  const row = isObject(raw) ? raw : {};
  const disabled = row['disabled'] === true;
  return {
    id: asNumber(row['id']),
    username: asString(row['username']),
    displayName: asString(row['displayName'], asString(row['username'])),
    role: (asString(row['role'], 'viewer') as AccountEntry['role']) ?? 'viewer',
    permissions: Array.isArray(row['permissions']) ? (row['permissions'] as string[]) : undefined,
    enabled: row['enabled'] === undefined ? !disabled : row['enabled'] !== false,
    createdAt: asNumberOrNull(row['createdAt']),
    lastLoginAt: asNumberOrNull(row['lastLoginAt']),
  };
}

/** 账户详情归一化：实现回 `{account}`。 */
function normalizeAccount(raw: unknown): Account {
  const row = isObject(raw) ? raw : {};
  return {
    id: asNumber(row['id']),
    username: asString(row['username']),
    displayName: asString(row['displayName'], asString(row['username'])),
    role: (asString(row['role'], 'viewer') as Account['role']) ?? 'viewer',
    permissions: Array.isArray(row['permissions']) ? (row['permissions'] as string[]) : [],
  };
}

/**
 * 玩家档案归一化。
 * ⚠️ 实现的 `GET /_api/players/:uuid` 回 `{ player: {...} }`；
 * `lastIp` 只在有 `player.view_ip` 时出现（这条与文档一致）。
 */
function normalizePlayerProfile(raw: unknown): PlayerProfile {
  const row = isObject(raw) ? raw : {};
  const economy = isObject(row['economy']) ? row['economy'] : null;
  const gameCurrency: Record<string, { balance: number; currency: string }> = {};
  if (isObject(row['gameCurrency'])) {
    for (const [nodeId, value] of Object.entries(row['gameCurrency'])) {
      if (!isObject(value)) continue;
      gameCurrency[nodeId] = {
        balance: asNumber(value['balance']),
        currency: asString(value['currency']),
      };
    }
  }
  return {
    uuid: asString(row['uuid']),
    name: asString(row['name']),
    knownNames: Array.isArray(row['knownNames']) ? (row['knownNames'] as string[]) : undefined,
    firstSeenAt: asNumberOrNull(row['firstSeenAt']) ?? undefined,
    lastSeenAt: asNumberOrNull(row['lastSeenAt']) ?? undefined,
    playtimeSeconds: asNumberOrNull(row['playtimeSeconds']) ?? undefined,
    lastIp: typeof row['lastIp'] === 'string' ? row['lastIp'] : undefined,
    online: row['online'] === true,
    nodeId: typeof row['nodeId'] === 'string' ? row['nodeId'] : null,
    punishments: Array.isArray(row['punishments'])
      ? (row['punishments'] as PlayerProfile['punishments'])
      : undefined,
    economy: economy ? { balance: asNumber(economy['balance']) } : undefined,
    gameCurrency,
  };
}

/**
 * LP 组归一化：实现里 `userCount` / `displayName` 可能缺字段、`meta` 可能为 null，
 * 而 `LpGroup` 类型要求它们存在 —— 这里补默认值，避免视图层到处判空。
 */
function normalizeLpGroup(raw: unknown): LpGroup {
  const group = isObject(raw) ? raw : {};
  const meta = isObject(group['meta']) ? group['meta'] : {};
  return {
    name: asString(group['name']),
    displayName: asString(group['displayName'], asString(group['name'])),
    weight: asNumber(group['weight']),
    parents: Array.isArray(group['parents']) ? (group['parents'] as string[]) : [],
    permissions: Array.isArray(group['permissions'])
      ? (group['permissions'] as LpGroup['permissions'])
      : [],
    meta: {
      prefix: asString(meta['prefix']),
      suffix: asString(meta['suffix']),
      weight: asNumber(meta['weight']),
    },
    // 关键：userCount 为 null 是合法值（Agent 可选实现），不能变成 0。
    userCount: asNumberOrNull(group['userCount']),
  };
}

function normalizeLpUser(raw: unknown): LpUser {
  const user = isObject(raw) ? raw : {};
  const meta = isObject(user['meta']) ? user['meta'] : {};
  return {
    uuid: asString(user['uuid']),
    name: asString(user['name']),
    primaryGroup: asString(user['primaryGroup'], 'default'),
    groups: Array.isArray(user['groups']) ? (user['groups'] as LpUser['groups']) : [],
    permissions: Array.isArray(user['permissions'])
      ? (user['permissions'] as LpUser['permissions'])
      : [],
    meta: {
      prefix: asString(meta['prefix']),
      suffix: asString(meta['suffix']),
      weight: asNumber(meta['weight']),
    },
    inheritedPermissionsCount: asNumber(user['inheritedPermissionsCount']),
  };
}

/** 经济账户归一化：实现里 `name` 可能是 null。 */
function normalizeEconomyAccount(raw: unknown): EconomyAccount {
  const row = isObject(raw) ? raw : {};
  return {
    uuid: asString(row['uuid']),
    name: asString(row['name'], asString(row['uuid'])),
    balance: asNumber(row['balance']),
    updatedAt: asNumberOrNull(row['updatedAt']),
  };
}

/** 流水行归一化（实现只回 `createdAt`，没有 `ts`）。 */
function normalizeLedgerEntry(raw: unknown): LedgerEntry {
  const row = isObject(raw) ? raw : {};
  return {
    id: asNumber(row['id']),
    uuid: typeof row['uuid'] === 'string' ? row['uuid'] : undefined,
    name: typeof row['name'] === 'string' ? row['name'] : undefined,
    delta: asNumberOrNull(row['delta']) ?? undefined,
    balanceAfter: asNumberOrNull(row['balanceAfter']) ?? undefined,
    currency: typeof row['currency'] === 'string' ? row['currency'] : undefined,
    source: typeof row['source'] === 'string' ? row['source'] : undefined,
    note: typeof row['note'] === 'string' ? row['note'] : undefined,
    eventId: typeof row['eventId'] === 'string' ? row['eventId'] : undefined,
    operator: typeof row['operator'] === 'string' ? row['operator'] : undefined,
    ts: asNumberOrNull(row['ts']) ?? undefined,
    createdAt: asNumberOrNull(row['createdAt']) ?? undefined,
  };
}

/**
 * 经济配置归一化。
 *
 * ⚠️ 文档写的是 `{ ratio, min_coin, currency, … }`；实现（`GET /_api/economy/config`）
 * 回的是数据库键值表：`{ config: { 'economy.ratio': '1000', 'economy.min_coin': '0', … } }`，
 * 值全是字符串。这里两种形状都吃，统一成前台可编辑的 `EconomyConfig`。
 */
function normalizeEconomyConfig(raw: unknown): EconomyConfig {
  const outer = isObject(raw) && isObject(raw['config']) ? raw['config'] : raw;
  const source = isObject(outer) ? outer : {};

  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) return source[key];
    }
    return undefined;
  };

  const config: EconomyConfig = {
    ratio: asNumber(pick('ratio', 'economy.ratio'), 1),
    min_coin: asNumber(pick('min_coin', 'minCoin', 'economy.min_coin'), 0),
    currency: asString(
      pick('currency', 'currency_name', 'currencyName', 'economy.currency_name'),
      '金币',
    ),
    daily_limit: asNumber(pick('daily_limit', 'dailyLimit', 'economy.daily_limit'), 0),
    single_limit: asNumber(pick('single_limit', 'singleLimit', 'economy.single_limit'), 0),
    points_name: asString(pick('points_name', 'pointsName', 'economy.points_name'), '积分'),
    enabled:
      pick('enabled', 'economy.enabled') === undefined
        ? true
        : String(pick('enabled', 'economy.enabled')) === '1' ||
          pick('enabled', 'economy.enabled') === true,
  };
  return config;
}

/**
 * 经济配置 → 请求体。
 * 实现按「扁平键值表」写库，所以同时发一份点号键，
 * 兼容后端只认 `economy.*` 的实现（`setConfig` 会原样存键）。
 */
function serializeEconomyConfig(config: EconomyConfig): Record<string, string | number | boolean> {
  const body: Record<string, string | number | boolean> = { ...config };
  body['economy.ratio'] = config.ratio;
  body['economy.min_coin'] = config.min_coin;
  body['economy.currency_name'] = config.currency;
  body['economy.daily_limit'] = config.daily_limit ?? 0;
  body['economy.single_limit'] = config.single_limit ?? 0;
  body['economy.points_name'] = config.points_name ?? '积分';
  body['economy.enabled'] = config.enabled === false ? 0 : 1;
  return body;
}

// ─────────────────────────────────────────────────────────────
// 认证
// ─────────────────────────────────────────────────────────────

export const authApi = {
  /** 失败一律 401 UNAUTHENTICATED，服务端不区分「用户不存在」与「密码错误」。 */
  async login(username: string, password: string): Promise<LoginResult> {
    const raw = await request<{ account?: unknown }>('/auth/login', {
      method: 'POST',
      body: { username, password },
      skipAuthRedirect: true,
    });
    return { account: normalizeAccount(raw?.account) };
  },

  logout() {
    return request<void>('/auth/logout', { method: 'POST' });
  },

  async me(options: { signal?: AbortSignal } = {}): Promise<MeResult> {
    const raw = await request<{ account?: unknown }>('/auth/me', {
      skipAuthRedirect: true,
      ...options,
    });
    return { account: normalizeAccount(raw?.account) };
  },
};

// ─────────────────────────────────────────────────────────────
// 节点
// ─────────────────────────────────────────────────────────────

export const nodesApi = {
  /** ⚠️ 文档：`Node[]`；实现：`{ items: Node[] }`。 */
  async list(): Promise<NodeSummary[]> {
    const raw = await request<unknown>('/nodes');
    return unwrapList<unknown>(raw, 'items').map(normalizeNode);
  },

  /** 响应里带 `secret`，**只此一次**。⚠️ 实现：`{ node, secret, warning }`。 */
  async create(payload: NodeCreatePayload): Promise<NodeSecretResult> {
    const raw = await request<{ node?: unknown; secret?: unknown }>('/nodes', {
      method: 'POST',
      body: payload,
    });
    return {
      secret: asString(raw?.secret),
      ...(raw?.node ? { node: normalizeNode(raw.node) } : {}),
    };
  },

  /** ⚠️ 文档：`Node`；实现：`{ node: Node }`。 */
  async detail(nodeId: string): Promise<NodeSummary> {
    const raw = await request<{ node?: unknown }>(`/nodes/${encodeURIComponent(nodeId)}`);
    return normalizeNode(raw?.node ?? raw);
  },

  async patch(nodeId: string, payload: NodePatchPayload): Promise<NodeSummary> {
    const raw = await request<{ node?: unknown }>(`/nodes/${encodeURIComponent(nodeId)}`, {
      method: 'PATCH',
      body: payload,
    });
    return normalizeNode(raw?.node ?? raw);
  },

  remove(nodeId: string) {
    // 实现回 `{ ok: true }`，文档写删除；返回体对调用方无用。
    return request<unknown>(`/nodes/${encodeURIComponent(nodeId)}`, { method: 'DELETE' });
  },

  /** 换密钥，返回新 `secret`（同样只此一次）。实现：`{ node, secret, warning }`。 */
  async rotateSecret(nodeId: string): Promise<NodeSecretResult> {
    const raw = await request<{ node?: unknown; secret?: unknown }>(
      `/nodes/${encodeURIComponent(nodeId)}/rotate-secret`,
      { method: 'POST' },
    );
    return {
      secret: asString(raw?.secret),
      ...(raw?.node ? { node: normalizeNode(raw.node) } : {}),
    };
  },

  /** ⚠️ 实现返回 `{ info }`（文档只写「透传 server.info」）。 */
  info(nodeId: string) {
    return request<ServerInfoResult>(`/nodes/${encodeURIComponent(nodeId)}/info`);
  },

  metrics(nodeId: string) {
    return request<MetricsResult>(`/nodes/${encodeURIComponent(nodeId)}/metrics`);
  },

  /** ⚠️ 文档：`PlayerEntry[]`；实现：`{ players: PlayerEntry[] }`。 */
  async online(nodeId: string): Promise<PlayerEntry[]> {
    const raw = await request<unknown>(`/nodes/${encodeURIComponent(nodeId)}/online`);
    return unwrapList<PlayerEntry>(raw, 'players');
  },

  /** ⚠️ 实现返回 `{ success, output }`（与文档一致）。 */
  console(nodeId: string, command: string) {
    return request<ConsoleExecuteResult>(`/nodes/${encodeURIComponent(nodeId)}/console`, {
      method: 'POST',
      body: { command },
    });
  },

  /** ⚠️ 实现返回 `{ lines }`。 */
  consoleHistory(nodeId: string) {
    return request<ConsoleHistoryResult>(`/nodes/${encodeURIComponent(nodeId)}/console/history`);
  },
};

// ─────────────────────────────────────────────────────────────
// 玩家
// ─────────────────────────────────────────────────────────────

export const playersApi = {
  async list(query: PlayerListQuery = {}): Promise<PageResult<PlayerEntry>> {
    const page = query.page ?? 1;
    const size = query.size ?? 20;
    const raw = await request<unknown>('/players', { query: { ...query } });
    return unwrapPage<PlayerEntry>(raw, { page, size });
  },

  /** ⚠️ 文档：`PlayerProfile`；实现：`{ player: PlayerProfile }`。 */
  async detail(uuid: string): Promise<PlayerProfile> {
    const raw = await request<{ player?: unknown }>(`/players/${encodeURIComponent(uuid)}`);
    return normalizePlayerProfile(raw?.player ?? raw);
  },

  /** 需要 `player.view_ip`；无权限时字段根本不返回。实现：`{ items }`，次数字段是 `seenCount`。 */
  async ips(uuid: string): Promise<PlayerIpRecord[]> {
    const raw = await request<unknown>(`/players/${encodeURIComponent(uuid)}/ips`);
    return unwrapList<unknown>(raw, 'items').map((row) => {
      const item = isObject(row) ? row : {};
      return {
        ip: asString(item['ip']),
        firstSeenAt: asNumberOrNull(item['firstSeenAt']) ?? undefined,
        lastSeenAt: asNumberOrNull(item['lastSeenAt']) ?? undefined,
        // ⚠️ 实现是 seenCount；文档没定义。两个都留着，视图优先 seenCount。
        seenCount: asNumberOrNull(item['seenCount']) ?? undefined,
        count: asNumberOrNull(item['count'] ?? item['seenCount']) ?? undefined,
      };
    });
  },

  /** 实现：`{ items: [{ name, firstSeenAt, lastSeenAt }] }`（没有 changedAt）。 */
  async names(uuid: string): Promise<PlayerNameRecord[]> {
    const raw = await request<unknown>(`/players/${encodeURIComponent(uuid)}/names`);
    return unwrapList<PlayerNameRecord>(raw, 'items');
  },

  /** 实现：`{ items: [{ id, nodeId, ip?, joinedAt, leftAt, playtimeSeconds }] }`。 */
  async sessions(uuid: string): Promise<PlayerSession[]> {
    const raw = await request<unknown>(`/players/${encodeURIComponent(uuid)}/sessions`);
    return unwrapList<PlayerSession>(raw, 'items');
  },

  audit(uuid: string, query: { page?: number; size?: number } = {}) {
    return request<PageResult<AuditEntry>>(`/players/${encodeURIComponent(uuid)}/audit`, { query });
  },

  resolve(name: string) {
    return request<PlayerResolveResult>('/players/resolve', {
      method: 'POST',
      body: { name },
    });
  },

  kick(uuid: string, nodeId: string, reason: string) {
    return request<unknown>(`/players/${encodeURIComponent(uuid)}/kick`, {
      method: 'POST',
      body: { nodeId, reason },
    });
  },

  op(uuid: string, nodeId: string, value: boolean) {
    return request<unknown>(`/players/${encodeURIComponent(uuid)}/op`, {
      method: 'POST',
      body: { nodeId, value },
    });
  },

  gamemode(uuid: string, nodeId: string, gamemode: string) {
    return request<unknown>(`/players/${encodeURIComponent(uuid)}/gamemode`, {
      method: 'POST',
      body: { nodeId, gamemode },
    });
  },

  whitelist(uuid: string, nodeId: string, value: boolean) {
    return request<unknown>(`/players/${encodeURIComponent(uuid)}/whitelist`, {
      method: 'POST',
      body: { nodeId, value },
    });
  },
};

// ─────────────────────────────────────────────────────────────
// 封禁 / 禁言
// ─────────────────────────────────────────────────────────────

export const punishmentsApi = {
  async list(query: PunishmentListQuery = {}): Promise<PageResult<PunishmentRecord>> {
    const page = query.page ?? 1;
    const size = query.size ?? 20;
    const raw = await request<unknown>('/punishments', { query: { ...query } });
    return unwrapPage<PunishmentRecord>(raw, { page, size }, 'items');
  },

  /**
   * ⚠️ 实现把响应体同时包了 `punishment` 与 `dispatched`，与文档一致。
   * 失败节点必须由页面显式展示。
   */
  create(payload: PunishmentCreatePayload) {
    return request<PunishmentCreateResponse>('/punishments', { method: 'POST', body: payload });
  },

  /** 实现：`{ punishment, dispatched }`（文档只写「撤销」，没写响应体）。 */
  revoke(id: string) {
    return request<PunishmentCreateResponse>(`/punishments/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
    });
  },
};

// ─────────────────────────────────────────────────────────────
// LuckPerms（按节点）
// ─────────────────────────────────────────────────────────────

export const luckpermsApi = {
  /** 实现：`{ user }`。 */
  async user(nodeId: string, uuid: string): Promise<LpUser> {
    const raw = await request<{ user?: unknown }>(
      `/luckperms/nodes/${encodeURIComponent(nodeId)}/users/${encodeURIComponent(uuid)}`,
    );
    return normalizeLpUser(raw?.user ?? raw);
  },

  /** 实现：`POST /users/:uuid/primary-group`（连字符，与 docs/API.md 一致）。 */
  setPrimaryGroup(nodeId: string, uuid: string, group: string) {
    return request<ChangedResult>(
      `/luckperms/nodes/${encodeURIComponent(nodeId)}/users/${encodeURIComponent(uuid)}/primary-group`,
      { method: 'POST', body: { group } },
    );
  },

  /** 实现：`POST /users/:uuid/groups`，体 `{ group, add }`（与文档一致）。 */
  addUserGroup(nodeId: string, uuid: string, group: string, add: boolean) {
    return request<ChangedResult>(
      `/luckperms/nodes/${encodeURIComponent(nodeId)}/users/${encodeURIComponent(uuid)}/groups`,
      { method: 'POST', body: { group, add } },
    );
  },

  /**
   * ⚠️ 方法差异：文档写「`POST …/permissions` + `value:null` 表示删除」，
   * 实现是 `POST …/permissions` 设置、`DELETE …/permissions`（体 `{ permission }`）删除。
   * 这里两种都实现：`value === null` 走 DELETE（实现路径），否则走 POST。
   */
  setUserPermission(nodeId: string, uuid: string, permission: string, value: boolean | null) {
    const base = `/luckperms/nodes/${encodeURIComponent(nodeId)}/users/${encodeURIComponent(uuid)}/permissions`;
    if (value === null) {
      return request<ChangedResult>(base, { method: 'DELETE', body: { permission } });
    }
    return request<ChangedResult>(base, { method: 'POST', body: { permission, value } });
  },

  setUserMeta(nodeId: string, uuid: string, prefix: string, suffix: string) {
    return request<ChangedResult>(
      `/luckperms/nodes/${encodeURIComponent(nodeId)}/users/${encodeURIComponent(uuid)}/meta`,
      { method: 'POST', body: { prefix, suffix } },
    );
  },

  /** 实现：`{ groups: LpGroup[] }`；`userCount` 可能为 null。 */
  async groups(nodeId: string): Promise<LpGroup[]> {
    const raw = await request<unknown>(`/luckperms/nodes/${encodeURIComponent(nodeId)}/groups`);
    return unwrapList<unknown>(raw, 'groups').map(normalizeLpGroup);
  },

  createGroup(nodeId: string, name: string) {
    return request<ChangedResult>(`/luckperms/nodes/${encodeURIComponent(nodeId)}/groups`, {
      method: 'POST',
      body: { name },
    });
  },

  deleteGroup(nodeId: string, name: string) {
    return request<ChangedResult>(
      `/luckperms/nodes/${encodeURIComponent(nodeId)}/groups/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
  },

  /**
   * ⚠️ 同 setUserPermission：实现用 `DELETE …/permissions` 删除。
   * 另外实现里组权限路径是 `…/groups/:name/permissions`（与文档一致）。
   */
  setGroupPermission(nodeId: string, name: string, permission: string, value: boolean | null) {
    const base = `/luckperms/nodes/${encodeURIComponent(nodeId)}/groups/${encodeURIComponent(name)}/permissions`;
    if (value === null) {
      return request<ChangedResult>(base, { method: 'DELETE', body: { permission } });
    }
    return request<ChangedResult>(base, { method: 'POST', body: { permission, value } });
  },

  setGroupParent(nodeId: string, name: string, parent: string, add: boolean) {
    return request<ChangedResult>(
      `/luckperms/nodes/${encodeURIComponent(nodeId)}/groups/${encodeURIComponent(name)}/parents`,
      { method: 'POST', body: { parent, add } },
    );
  },

  setGroupWeight(nodeId: string, name: string, weight: number) {
    return request<ChangedResult>(
      `/luckperms/nodes/${encodeURIComponent(nodeId)}/groups/${encodeURIComponent(name)}/weight`,
      { method: 'POST', body: { weight } },
    );
  },

  setGroupMeta(nodeId: string, name: string, prefix: string, suffix: string) {
    return request<ChangedResult>(
      `/luckperms/nodes/${encodeURIComponent(nodeId)}/groups/${encodeURIComponent(name)}/meta`,
      { method: 'POST', body: { prefix, suffix } },
    );
  },

  /**
   * 这个节点上**存在**哪些权限节点（给输入框做候选，只读）。
   *
   * 来源是服务端各插件注册的权限。有了它，加权限时不用盲敲 ——
   * 敲一个没人注册过的节点 LuckPerms 会照存，但永远不会生效，
   * 而管理员从界面上看不出区别。
   */
  permissionCatalog(nodeId: string, query: { q?: string; limit?: number } = {}) {
    return request<LpPermissionCatalog>(
      `/luckperms/nodes/${encodeURIComponent(nodeId)}/permissions`,
      { query: { ...query } },
    );
  },
};

// ─────────────────────────────────────────────────────────────
// 经济
// ─────────────────────────────────────────────────────────────

export const economyApi = {
  /**
   * 经济模块现状。**永远成功**，用它决定页面怎么渲染。
   *
   * 不要靠「哪个请求 501 了」去猜处境：默认部署下平台不持有积分账本，
   * 读账本的接口一律 501，那是设计决定。用这个接口区分
   * 「站点积分走外部账本」和「游戏内货币始终可用」。
   */
  status() {
    return request<EconomyStatus>('/economy/status');
  },

  /** 某玩家在某节点上的游戏内余额（Vault）。余额是每个服务端各自一份的。 */
  balance(nodeId: string, uuid: string) {
    return request<GameCurrencyBalance>('/economy/balance', {
      query: { nodeId, uuid },
    });
  },

  async accounts(query: { kw?: string; page?: number; size?: number } = {}): Promise<PageResult<EconomyAccount>> {
    const page = query.page ?? 1;
    const size = query.size ?? 20;
    const raw = await request<unknown>('/economy/accounts', { query: { ...query } });
    const result = unwrapPage<unknown>(raw, { page, size }, 'items');
    return { ...result, items: result.items.map(normalizeEconomyAccount) };
  },

  /** 实现：`{ account, ledger }`（与文档一致，但流水最多 50 条）。 */
  async account(uuid: string): Promise<EconomyAccountDetail> {
    const raw = await request<{ account?: unknown; ledger?: unknown }>(
      `/economy/accounts/${encodeURIComponent(uuid)}`,
    );
    const ledger = Array.isArray(raw?.ledger) ? raw.ledger.map(normalizeLedgerEntry) : [];
    return {
      account: normalizeEconomyAccount(raw?.account),
      ledger,
      total: ledger.length,
    };
  },

  adjust(uuid: string, payload: EconomyAdjustPayload) {
    return request<EconomyAdjustResult>(`/economy/accounts/${encodeURIComponent(uuid)}/adjust`, {
      method: 'POST',
      body: payload,
    });
  },

  gameCurrency(uuid: string, payload: GameCurrencyPayload) {
    return request<GameCurrencyResult>(
      `/economy/accounts/${encodeURIComponent(uuid)}/game-currency`,
      { method: 'POST', body: payload },
    );
  },

  async ledger(query: LedgerQueryInput = {}): Promise<PageResult<LedgerEntry>> {
    const page = query.page ?? 1;
    const size = query.size ?? 20;
    const raw = await request<unknown>('/economy/ledger', { query: { ...query } });
    const result = unwrapPage<unknown>(raw, { page, size }, 'items');
    return { ...result, items: result.items.map(normalizeLedgerEntry) };
  },

  /**
   * 概览。
   * ⚠️ 实现回的是 `{ accounts, totalBalance, ledgerCount, last24hDelta, topBalances, sources, config }`，
   * 文档只写「概览」。这里映射成视图用的字段。
   */
  async stats(): Promise<EconomyStats> {
    const raw = await request<Record<string, unknown>>('/economy/stats');
    return {
      totalAccounts: asNumberOrNull(raw?.['accounts'] ?? raw?.['totalAccounts']),
      totalBalance: asNumberOrNull(raw?.['totalBalance'] ?? raw?.['balanceSum']),
      ledgerCount: asNumberOrNull(raw?.['ledgerCount']),
      last24hDelta: asNumberOrNull(raw?.['last24hDelta']),
      topBalances: Array.isArray(raw?.['topBalances'])
        ? (raw['topBalances'] as EconomyStats['topBalances'])
        : [],
      sources: Array.isArray(raw?.['sources']) ? (raw['sources'] as EconomyStats['sources']) : [],
    };
  },

  /** ⚠️ 实现：`{ config: { 'economy.ratio': '1000', … } }`（字符串键值表）。 */
  async config(): Promise<EconomyConfig> {
    const raw = await request<unknown>('/economy/config');
    return normalizeEconomyConfig(raw);
  },

  /** ⚠️ 实现按扁平键值表写库；这里同时发点号键，保证后端能落库。 */
  async updateConfig(config: EconomyConfig): Promise<EconomyConfig> {
    const raw = await request<unknown>('/economy/config', {
      method: 'PUT',
      body: serializeEconomyConfig(config),
    });
    return normalizeEconomyConfig(raw);
  },

  /** 实现额外提供：`GET /_api/economy/new-event-id → { eventId }`。 */
  newEventId() {
    return request<{ eventId: string }>('/economy/new-event-id');
  },
};

/** 流水筛选入参（避免在函数签名里写 inline 类型）。 */
export interface LedgerQueryInput {
  uuid?: string | null;
  source?: string | null;
  from?: number | null;
  to?: number | null;
  page?: number;
  size?: number;
}

// ─────────────────────────────────────────────────────────────
// 审计
// ─────────────────────────────────────────────────────────────

export const auditApi = {
  async list(query: AuditQuery = {}): Promise<PageResult<AuditEntry>> {
    const page = query.page ?? 1;
    const size = query.size ?? 20;
    const raw = await request<unknown>('/audit', { query: { ...query } });
    return unwrapPage<AuditEntry>(raw, { page, size }, 'items');
  },

  /** 实现额外提供：`GET /_api/audit/actions`（动作枚举，供筛选下拉）。 */
  actions() {
    return request<{ actions?: string[] } | string[]>('/audit/actions');
  },
};

// ─────────────────────────────────────────────────────────────
// 账号（docs/API.md 未列出这一组接口；实现见 apps/server/src/http/routes/accounts.ts）
// ─────────────────────────────────────────────────────────────

/**
 * ⚠️ docs/API.md **没有**定义后台账号管理接口，但后端已实现：
 * - `GET /_api/accounts` → `{ items: AccountEntry[], roles: [{role, permissions}] }`
 *   （**不分页**；`items` 无 `total/page/size`）
 * - `POST /_api/accounts` → `{ account }`
 * - `PATCH /_api/accounts/:id` → `{ account }`
 * - `DELETE /_api/accounts/:id` → `{ ok: true }`
 * 实现里字段是 `disabled`（布尔），前端统一映射成 `enabled`。
 */
export const accountsApi = {
  async list(query: { kw?: string; page?: number; size?: number } = {}): Promise<PageResult<AccountEntry>> {
    const page = query.page ?? 1;
    const size = query.size ?? 20;
    const raw = await request<unknown>('/accounts');
    const result = unwrapPage<unknown>(raw, { page, size }, 'items');
    return { ...result, items: result.items.map(normalizeAccountEntry) };
  },

  async create(payload: AccountCreatePayload): Promise<AccountEntry> {
    const raw = await request<{ account?: unknown }>('/accounts', {
      method: 'POST',
      body: payload,
    });
    return normalizeAccountEntry(raw?.account ?? raw);
  },

  async patch(
    id: number,
    payload: Partial<AccountCreatePayload> & { enabled?: boolean; disabled?: boolean },
  ): Promise<AccountEntry> {
    // UI 用 enabled，实现用 disabled —— 在边界转换。
    const body: Record<string, unknown> = {};
    if (payload.role !== undefined) body['role'] = payload.role;
    if (payload.password) body['password'] = payload.password;
    if (payload.enabled !== undefined) body['disabled'] = !payload.enabled;
    if (payload.disabled !== undefined) body['disabled'] = payload.disabled;

    const raw = await request<{ account?: unknown }>(`/accounts/${id}`, {
      method: 'PATCH',
      body,
    });
    return normalizeAccountEntry(raw?.account ?? raw);
  },

  remove(id: number) {
    return request<{ ok: boolean }>(`/accounts/${id}`, { method: 'DELETE' });
  },
};

export type { Account };
