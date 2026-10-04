/**
 * 存储层。
 *
 * 用 Node 24 内置的 `node:sqlite`。选它而不是 `better-sqlite3` 的理由：
 * 后者是原生模块，装它要 node-gyp + 编译工具链，在 Windows 上常年
 * 是部署失败的头号原因。内置模块没有这个问题，代价是 API 略新。
 *
 * 所有写操作走 `tx()`。**余额一律从库里读，绝不信任调用方传入的值** ——
 * 这条来自 kokuu-credit-admin 已被生产验证的「账本三原则」。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  DDL,
  DEFAULT_CONFIG,
  SCHEMA_VERSION,
  CONFIG_RULES,
  validateConfigCross,
} from './schema.ts';
import { log } from '../logger.ts';

export type SqlValue = string | number | null;

/** node:sqlite 不接受 `undefined`，统一转成 null。 */
const p = (v: unknown): SqlValue => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return String(v);
};

/**
 * 关于本文件里密集出现的 `as unknown as XxxRow`：
 *
 * `node:sqlite` 的 `all()` / `get()` 返回 `Record<string, SQLOutputValue>`，
 * 它与具名行类型没有结构重叠，TS 因此拒绝单重断言（TS2352）。
 * 行的真实形状由 `store/schema.ts` 的 DDL 决定，这里用双重断言建立映射。
 *
 * 代价是「改了 DDL 但忘了改这里的接口」不会被类型系统发现。
 * 补这个缺口应该是针对本文件的集成测试，
 * 而不是把行类型退化成 `Record<string, unknown>` 让整条链失去类型。
 */

// ─────────────────────────────────────────────────────────────
// 行类型
// ─────────────────────────────────────────────────────────────

export interface AccountRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
  last_login_ip: string | null;
  /** 皮肤站 users.uid。本地账号为 null。 */
  skin_uid: number | null;
  /** `local` | `oauth` */
  auth_provider: string;
}

export interface SessionRow {
  id: string;
  account_id: number;
  csrf: string;
  created_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

export interface NodeRow {
  id: string;
  name: string;
  secret_hash: string;
  enabled: number;
  tags: string;
  agent_version: string | null;
  mc_version: string | null;
  brand: string | null;
  capabilities: string;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PlayerRow {
  uuid: string;
  name: string;
  first_seen_at: number;
  last_seen_at: number;
  playtime_seconds: number;
  last_ip: string | null;
  online: number;
  node_id: string | null;
  /** 关联的皮肤站角色。目录未导入时为 null。 */
  bs_pid: number | null;
}

/**
 * 皮肤站角色目录。
 *
 * 这是本平台**唯一稳定的身份锚点** —— 见 schema.ts 里 characters 表的注释：
 * 本站 UUID 由角色名派生，改名会让名字与 UUID 一起变，只有 pid 不变。
 */
export interface CharacterRow {
  bs_pid: number;
  bs_uid: number;
  name: string;
  uuid: string | null;
  prev_names: string;
  prev_uuids: string;
  first_seen_at: number;
  last_seen_at: number;
  source: string;
  updated_at: number;
}

export interface PunishmentRow {
  id: string;
  type: string;
  uuid: string;
  name: string;
  reason: string;
  operator: string;
  node_id: string | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
  active: number;
  /**
   * 皮肤站角色 pid —— **这是权威键**。
   *
   * `uuid` / `name` 只是「最近一次已知身份」的快照，用于下发给 Agent
   * （Agent 只认 uuid/name）。改名后这两个会被刷新，而 pid 不变。
   * 目录未导入时为 null，此时只能退化按 uuid 匹配（改名即失效）。
   */
  bs_pid: number | null;
}

export interface EconomyAccountRow {
  uuid: string;
  balance: number;
  updated_at: number;
}

export interface LedgerRow {
  id: number;
  uuid: string;
  delta: number;
  balance_after: number;
  source: string;
  note: string;
  operator: string;
  event_id: string;
  created_at: number;
}

export interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  actor_ip: string | null;
  action: string;
  target_type: string;
  target_id: string;
  node_id: string | null;
  params: string;
  ok: number;
  error: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export class IdempotencyConflict extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`eventId 已处理过：${eventId}`);
    this.name = 'IdempotencyConflict';
    this.eventId = eventId;
  }
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * 角色目录多久没同步就认为「不可信」。
 *
 * 为什么需要这个阈值：目录决定封禁能不能扛住改名。目录旧了，
 * 新改名的玩家就解析不出 pid，封禁对他不生效 —— 而界面上看起来
 * 一切正常。超过这个时间就在界面上明确告警。
 *
 * 默认 24 小时：改名不是高频事件，一天同步一次足够；
 * 但超过一天还没同步，就不能再声称封禁是可靠的。
 */
export const CHARACTERS_STALE_AFTER_MS = 24 * 3600 * 1000;

export interface BalanceChange {
  uuid: string;
  delta: number;
  source: string;
  note: string;
  operator: string;
  eventId: string;
}

export interface BalanceResult {
  balance: number;
  ledgerId: number;
}

// ─────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.migrate();
  }

  private migrate(): void {
    // meta 表必须先建，否则读不到版本号 —— 而「要不要迁移」取决于版本号。
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
    );

    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as unknown as { value: string } | undefined;

    if (row) {
      let version = Number.parseInt(row.value, 10);
      if (!Number.isFinite(version)) version = 0;

      // 逐级迁移。每一级都要幂等 —— 迁移中途崩溃后重启要能接着跑。
      if (version < 2) {
        this.migrateV1toV2();
        version = 2;
      }
      if (version < 3) {
        this.migrateV2toV3();
        version = 3;
      }

      if (version !== SCHEMA_VERSION) {
        // 明确报错而不是假装没事：结构不匹配时静默启动，坏的是线上数据。
        throw new Error(
          `数据库 schema 版本为 ${version}，本程序期望 ${SCHEMA_VERSION}。` +
            '请先备份再升级（本版本尚未提供更高版本的自动迁移）。',
        );
      }
    }

    // DDL 全是 `IF NOT EXISTS`，重复执行是幂等的。
    // 放在迁移之后：这样 `accounts` 上的新索引能用上刚 ALTER 出来的列。
    this.db.exec(DDL);

    if (!row) {
      this.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(SCHEMA_VERSION));
      log.info(`数据库已初始化（schema v${SCHEMA_VERSION}）`);
    }

    // 播种默认配置。已存在的键不覆盖。
    const now = Date.now();
    const insertConfig = this.db.prepare(
      'INSERT OR IGNORE INTO config (key, value, updated_at) VALUES (?, ?, ?)',
    );
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      insertConfig.run(key, value, now);
    }
  }

  /**
   * v1 → v2：`accounts` 增加 `skin_uid` 与 `auth_provider`，并新增
   * `oauth_states` 表（由 DDL 的 `IF NOT EXISTS` 负责）。
   *
   * SQLite 的 `ALTER TABLE ADD COLUMN` 不支持 `IF NOT EXISTS`，
   * 所以先查 `PRAGMA table_info` 再改 —— 让这一步可以重复执行。
   */
  private migrateV1toV2(): void {
    const columns = this.db.prepare('PRAGMA table_info(accounts)').all() as unknown as {
      name: string;
    }[];
    const names = new Set(columns.map((c) => c.name));

    if (!names.has('skin_uid')) {
      this.db.exec('ALTER TABLE accounts ADD COLUMN skin_uid INTEGER');
    }
    if (!names.has('auth_provider')) {
      this.db.exec(
        "ALTER TABLE accounts ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'local'",
      );
    }

    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', '2')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run();

    log.info('数据库已迁移：v1 → v2（accounts 增加 OAuth 字段）');
  }

  /**
   * v2 → v3：引入「皮肤站角色」作为身份锚点。
   *
   * - 新表 `characters`（由 DDL 的 IF NOT EXISTS 建）
   * - `players.bs_pid`、`punishments.bs_pid` 两列
   *
   * 为什么必须这么做：本站 Yggdrasil 用 UUID v3（md5 of "OfflinePlayer:"+名字），
   * 所以封禁按 UUID 存的话，玩家改个名就绕过了。详见 docs/ECOSYSTEM.md §4.1。
   *
   * 已有数据的处理：**不猜**。老封禁的 `bs_pid` 留空，退回按 uuid 匹配，
   * 同时打 WARN 提示需要导入角色目录。凭空推断 pid 比留空更危险 ——
   * 猜错会把封禁安到别人头上。
   */
  private migrateV2toV3(): void {
    const addColumnIfMissing = (table: string, column: string, definition: string): void => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
        name: string;
      }[];
      if (!columns.some((c) => c.name === column)) {
        // 表名/列名来自本文件的字面量，不来自外部输入。
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };

    addColumnIfMissing('players', 'bs_pid', 'INTEGER');
    addColumnIfMissing('punishments', 'bs_pid', 'INTEGER');

    // 索引在 DDL 里建；这里补老库可能缺的（DDL 会在迁移之后执行，所以
    // 依赖它的 IF NOT EXISTS 即可，不需要在这里重复）。

    const orphans = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM punishments WHERE active = 1 AND bs_pid IS NULL')
        .get() as unknown as { n: number }
    ).n;

    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', '3')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run();

    log.info('数据库已迁移：v2 → v3（引入皮肤站角色目录作为身份锚点）');

    if (orphans > 0) {
      log.warn(
        `有 ${orphans} 条生效中的封禁没有关联皮肤站角色（bs_pid 为空）。` +
          '它们只能按 UUID 匹配，而本站 UUID 由角色名派生 —— ' +
          '**玩家改名即可绕过**。请导入角色目录后重建这些封禁。' +
          '导入方式：node tools/import-characters.mjs --help',
      );
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }

  /**
   * 写事务。
   *
   * 用 `BEGIN IMMEDIATE` 而非默认的 `BEGIN`：默认事务在第一次写时才
   * 升级为写锁，两个并发事务可能同时持有读锁再互相等对方释放 ——
   * SQLite 直接报 `SQLITE_BUSY` 且**不会**重试。IMMEDIATE 一上来就拿写锁，
   * 配合 `busy_timeout` 变成排队。
   */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 事务可能已因错误自动回滚 */
      }
      throw error;
    }
  }

  // ── 元信息 ─────────────────────────────────────────────────

  schemaVersion(): number {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as unknown as { value: string } | undefined;
    return row ? Number.parseInt(row.value, 10) : 0;
  }

  // ── 账号 ───────────────────────────────────────────────────

  createAccount(input: {
    username: string;
    passwordHash: string;
    role: string;
    displayName?: string;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO accounts (username, display_name, password_hash, role, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.username,
        input.displayName ?? input.username,
        input.passwordHash,
        input.role,
        Date.now(),
      );
    return Number(info.lastInsertRowid);
  }

  countAccounts(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as unknown as {
      n: number;
    };
    return row.n;
  }

  findAccountByUsername(username: string): AccountRow | undefined {
    return this.db
      .prepare('SELECT * FROM accounts WHERE username = ?')
      .get(username) as unknown as AccountRow | undefined;
  }

  findAccountById(id: number): AccountRow | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as
      | AccountRow
      | undefined;
  }

  listAccounts(): AccountRow[] {
    return this.db
      .prepare('SELECT * FROM accounts ORDER BY id ASC')
      .all() as unknown as AccountRow[];
  }

  updateAccount(
    id: number,
    patch: { role?: string; disabled?: boolean; passwordHash?: string },
  ): void {
    const sets: string[] = [];
    const values: SqlValue[] = [];
    if (patch.role !== undefined) {
      sets.push('role = ?');
      values.push(patch.role);
    }
    if (patch.disabled !== undefined) {
      sets.push('disabled = ?');
      values.push(patch.disabled ? 1 : 0);
    }
    if (patch.passwordHash !== undefined) {
      sets.push('password_hash = ?');
      values.push(patch.passwordHash);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteAccount(id: number): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }

  touchLogin(id: number, ip: string): void {
    this.db
      .prepare('UPDATE accounts SET last_login_at = ?, last_login_ip = ? WHERE id = ?')
      .run(Date.now(), ip, id);
  }

  // ── OAuth2（皮肤站账号登入） ────────────────────────────────

  findAccountBySkinUid(skinUid: number): AccountRow | undefined {
    return this.db
      .prepare('SELECT * FROM accounts WHERE skin_uid = ?')
      .get(skinUid) as unknown as AccountRow | undefined;
  }

  /**
   * OAuth 登录成功后落库/更新本地账号。
   *
   * 认人用 `skin_uid` 而**不是**邮箱或昵称 —— 两者都会变，uid 不会。
   * 角色每次登录都按皮肤站的 `permission` 重算，这样在皮肤站降权后
   * 平台侧的权限会立刻跟着降，不必在两边各维护一次。
   *
   * `password_hash` 存空串：这个账号不靠口令登录，而空串永远过不了
   * `verifySecret`（它解析不出六段格式），所以不存在「空口令能进」。
   */
  upsertOAuthAccount(input: {
    skinUid: number;
    nickname: string;
    role: string;
  }): AccountRow {
    const now = Date.now();

    return this.tx(() => {
      const existing = this.db
        .prepare('SELECT id FROM accounts WHERE skin_uid = ?')
        .get(input.skinUid) as unknown as { id: number } | undefined;

      if (existing) {
        this.db
          .prepare(
            `UPDATE accounts
                SET display_name = ?, role = ?, auth_provider = 'oauth'
              WHERE id = ?`,
          )
          .run(input.nickname, input.role, existing.id);

        return this.db
          .prepare('SELECT * FROM accounts WHERE id = ?')
          .get(existing.id) as unknown as AccountRow;
      }

      // username 有唯一约束，而皮肤站昵称可能与人撞车（也可能含非法字符）。
      // 用 `skin_<uid>`：纯 ASCII、天然唯一、且带来源信息。
      this.db
        .prepare(
          `INSERT INTO accounts
             (username, display_name, password_hash, role, created_at, skin_uid, auth_provider)
           VALUES (?, ?, '', ?, ?, ?, 'oauth')`,
        )
        .run(`skin_${input.skinUid}`, input.nickname, input.role, now, input.skinUid);

      return this.db
        .prepare('SELECT * FROM accounts WHERE skin_uid = ?')
        .get(input.skinUid) as unknown as AccountRow;
    });
  }

  createOAuthState(input: {
    state: string;
    codeVerifier: string;
    redirectTo: string;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO oauth_states (state, code_verifier, redirect_to, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.state, input.codeVerifier, input.redirectTo, Date.now(), input.expiresAt);
  }

  /**
   * 取出并**立即删除** state。
   *
   * 一次性是安全要求而非优化：可复用的 state 等于给了重放的机会。
   * 「取出即删」比「查完再删」可靠 —— 后者在两步之间崩溃就留下了可复用的 state。
   */
  consumeOAuthState(
    state: string,
  ): { codeVerifier: string; redirectTo: string } | undefined {
    return this.tx(() => {
      const row = this.db
        .prepare(
          'SELECT code_verifier, redirect_to, expires_at FROM oauth_states WHERE state = ?',
        )
        .get(state) as unknown as
        | { code_verifier: string; redirect_to: string; expires_at: number }
        | undefined;

      if (!row) return undefined;

      this.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);

      if (row.expires_at < Date.now()) return undefined;

      return { codeVerifier: row.code_verifier, redirectTo: row.redirect_to };
    });
  }

  purgeExpiredOAuthStates(): number {
    const info = this.db
      .prepare('DELETE FROM oauth_states WHERE expires_at < ?')
      .run(Date.now());
    return Number(info.changes);
  }

  // ── 会话 ───────────────────────────────────────────────────

  createSession(input: {
    id: string;
    accountId: number;
    csrf: string;
    expiresAt: number;
    ip: string;
    userAgent: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, account_id, csrf, created_at, expires_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.accountId,
        input.csrf,
        Date.now(),
        input.expiresAt,
        input.ip,
        input.userAgent.slice(0, 300),
      );
  }

  findSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as
      | SessionRow
      | undefined;
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  deleteAccountSessions(accountId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
  }

  purgeExpiredSessions(): number {
    const info = this.db
      .prepare('DELETE FROM sessions WHERE expires_at < ?')
      .run(Date.now());
    return Number(info.changes);
  }

  // ── 登录限流 ───────────────────────────────────────────────

  recordLoginAttempt(ip: string, ok: boolean): void {
    this.db
      .prepare('INSERT INTO login_attempts (ip, ts, ok) VALUES (?, ?, ?)')
      .run(ip, Date.now(), ok ? 1 : 0);
  }

  countRecentLoginFailures(ip: string, windowMs: number): number {
    const since = Date.now() - windowMs;
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ok = 0 AND ts >= ?',
      )
      .get(ip, since) as unknown as { n: number };
    return row.n;
  }

  pruneLoginAttempts(olderThanMs: number): void {
    this.db
      .prepare('DELETE FROM login_attempts WHERE ts < ?')
      .run(Date.now() - olderThanMs);
  }

  // ── 节点 ───────────────────────────────────────────────────

  listNodes(): NodeRow[] {
    return this.db
      .prepare('SELECT * FROM nodes ORDER BY name ASC')
      .all() as unknown as NodeRow[];
  }

  getNode(id: string): NodeRow | undefined {
    return this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as unknown as
      | NodeRow
      | undefined;
  }

  createNode(input: {
    id: string;
    name: string;
    secretHash: string;
    tags: string[];
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO nodes (id, name, secret_hash, enabled, tags, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(input.id, input.name, input.secretHash, JSON.stringify(input.tags), now, now);
  }

  updateNode(
    id: string,
    patch: { name?: string; tags?: string[]; enabled?: boolean },
  ): void {
    const sets: string[] = ['updated_at = ?'];
    const values: SqlValue[] = [Date.now()];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      values.push(patch.name);
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?');
      values.push(JSON.stringify(patch.tags));
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      values.push(patch.enabled ? 1 : 0);
    }
    values.push(id);
    this.db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  updateNodeSecret(id: string, secretHash: string): void {
    this.db
      .prepare('UPDATE nodes SET secret_hash = ?, updated_at = ? WHERE id = ?')
      .run(secretHash, Date.now(), id);
  }

  deleteNode(id: string): void {
    this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  }

  /** Agent 握手成功时写入它自报的能力与版本。 */
  markNodeOnline(
    id: string,
    info: {
      agentVersion: string;
      mcVersion: string;
      brand: string;
      capabilities: string[];
    },
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE nodes
            SET agent_version = ?, mc_version = ?, brand = ?, capabilities = ?,
                last_seen_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        info.agentVersion,
        info.mcVersion,
        info.brand,
        JSON.stringify(info.capabilities),
        now,
        now,
        id,
      );
  }

  touchNode(id: string): void {
    this.db.prepare('UPDATE nodes SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  }

  // ── 玩家 ───────────────────────────────────────────────────

  /** 上线：建或更新主档、记名字历史、记 IP 历史、开一条 session。 */
  playerJoin(input: {
    uuid: string;
    name: string;
    nodeId: string;
    ip: string | null;
  }): void {
    const now = Date.now();

    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO players (uuid, name, first_seen_at, last_seen_at, last_ip, online, node_id)
           VALUES (?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(uuid) DO UPDATE SET
             name = excluded.name,
             last_seen_at = excluded.last_seen_at,
             last_ip = COALESCE(excluded.last_ip, players.last_ip),
             online = 1,
             node_id = excluded.node_id`,
        )
        .run(input.uuid, input.name, now, now, p(input.ip), input.nodeId);

      this.db
        .prepare(
          `INSERT INTO player_names (uuid, name, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(uuid, name) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        )
        .run(input.uuid, input.name, now, now);

      if (input.ip) {
        this.db
          .prepare(
            `INSERT INTO player_ips (uuid, ip, first_seen_at, last_seen_at, seen_count)
             VALUES (?, ?, ?, ?, 1)
             ON CONFLICT(uuid, ip) DO UPDATE SET
               last_seen_at = excluded.last_seen_at,
               seen_count = player_ips.seen_count + 1`,
          )
          .run(input.uuid, input.ip, now, now);
      }

      this.db
        .prepare(
          `INSERT INTO player_sessions (uuid, name, node_id, ip, joined_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.uuid, input.name, input.nodeId, p(input.ip), now);
    });
  }

  /**
   * 下线。只关**该节点上**的开放 session：
   * 玩家可能同时在两个服上（代理端场景），关错了会把别人的时长算丢。
   */
  playerQuit(input: {
    uuid: string;
    name: string;
    nodeId: string;
    playtimeSeconds: number;
  }): void {
    const now = Date.now();

    this.tx(() => {
      const open = this.db
        .prepare(
          `SELECT id, joined_at FROM player_sessions
            WHERE uuid = ? AND node_id = ? AND left_at IS NULL
            ORDER BY joined_at DESC LIMIT 1`,
        )
        .get(input.uuid, input.nodeId) as unknown as
        | { id: number; joined_at: number }
        | undefined;

      if (open) {
        // 以实际时间差为准，不信 Agent 报的时长 —— 它可能是重连后
        // 拿旧快照算的。Agent 的值只在时间差为负（时钟漂移）时兜底。
        const measured = Math.max(0, Math.floor((now - open.joined_at) / 1000));
        const used = measured > 0 ? measured : Math.max(0, input.playtimeSeconds);

        this.db
          .prepare(
            'UPDATE player_sessions SET left_at = ?, playtime_seconds = ? WHERE id = ?',
          )
          .run(now, used, open.id);

        this.db
          .prepare(
            `UPDATE players
                SET playtime_seconds = playtime_seconds + ?, last_seen_at = ?, online = 0
              WHERE uuid = ?`,
          )
          .run(used, now, input.uuid);
      } else {
        this.db
          .prepare('UPDATE players SET last_seen_at = ?, online = 0 WHERE uuid = ?')
          .run(now, input.uuid);
      }
    });
  }

  /** 节点掉线时，把该节点上的在线玩家全部标为离线。 */
  markNodePlayersOffline(nodeId: string): void {
    const now = Date.now();
    this.tx(() => {
      const rows = this.db
        .prepare(
          'SELECT uuid, joined_at FROM player_sessions WHERE node_id = ? AND left_at IS NULL',
        )
        .all(nodeId) as unknown as { uuid: string; joined_at: number }[];

      for (const row of rows) {
        const measured = Math.max(0, Math.floor((now - row.joined_at) / 1000));
        this.db
          .prepare(
            `UPDATE player_sessions SET left_at = ?, playtime_seconds = ?
              WHERE uuid = ? AND node_id = ? AND left_at IS NULL`,
          )
          .run(now, measured, row.uuid, nodeId);
        this.db
          .prepare('UPDATE players SET online = 0, last_seen_at = ? WHERE uuid = ?')
          .run(now, row.uuid);
      }

      this.db.prepare('UPDATE players SET online = 0 WHERE node_id = ?').run(nodeId);
    });
  }

  getPlayer(uuid: string): PlayerRow | undefined {
    return this.db.prepare('SELECT * FROM players WHERE uuid = ?').get(uuid) as unknown as
      | PlayerRow
      | undefined;
  }

  /**
   * 以「节点当前实际在线的玩家」为准，对齐平台侧的在线状态。
   *
   * 为什么需要它：平台是后来才装上的，或者平台自己重启过 ——
   * 这两种情况下服务器上**已经在线的玩家从没发过 join 事件**，
   * 平台侧完全没有记录。不补这一步，管理员打开界面会看到
   * 「0 人在线」而服务器里明明站着几十个人。
   *
   * 三件事，都在一个事务里：
   *   1. 补齐/更新玩家主档与名字历史
   *   2. 给还没有开放 session 的玩家开一条（joined_at 用服务端给的
   *      firstPlayed，尽量贴近真实上线时间，而不是拿「现在」糊弄）
   *   3. 该节点上**不在列表里**的玩家标记为离线 —— 平台断线期间
   *      离开的人，只能靠这一步纠正
   *
   * 幂等：重复调用（每次重连都会调）不会产生重复 session，
   * 也不会把在线时长算成负数。
   */
  reconcileOnlinePlayers(
    nodeId: string,
    players: { uuid: string; name: string; firstPlayed?: number }[],
  ): { known: number; markedOffline: number } {
    const now = Date.now();

    return this.tx(() => {
      const onlineUuids = new Set(players.map((player) => player.uuid));

      for (const player of players) {
        // 顺手做身份解析：对齐在线玩家的同时把 pid 关联上。
        // 放在这里而不是让调用方循环调用，是因为这一步本来就要遍历玩家，
        // 而且关联结果应当与「谁在线」同时落库，避免出现半截状态。
        const bsPid = this.resolveCharacterPid({ uuid: player.uuid, name: player.name });

        this.db
          .prepare(
            `INSERT INTO players (uuid, name, first_seen_at, last_seen_at, online, node_id, bs_pid)
             VALUES (?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(uuid) DO UPDATE SET
               name = excluded.name,
               last_seen_at = excluded.last_seen_at,
               online = 1,
               node_id = excluded.node_id,
               bs_pid = excluded.bs_pid`,
          )
          .run(player.uuid, player.name, now, now, nodeId, p(bsPid));

        this.db
          .prepare(
            `INSERT INTO player_names (uuid, name, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(uuid, name) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
          )
          .run(player.uuid, player.name, now, now);

        const open = this.db
          .prepare(
            `SELECT id FROM player_sessions
              WHERE uuid = ? AND node_id = ? AND left_at IS NULL LIMIT 1`,
          )
          .get(player.uuid, nodeId) as unknown as { id: number } | undefined;

        if (!open) {
          // firstPlayed 是「该玩家在本服首次游玩的时间」，可能非常久远。
          // 直接用它当 joined_at 会把一次几小时的上线记成几个月，所以
          // 夹一个下限：最多回溯 24 小时，超出就按「24 小时前」算。
          const fallback = now - 24 * 3600 * 1000;
          const joinedAt =
            player.firstPlayed && player.firstPlayed > fallback ? player.firstPlayed : now;

          this.db
            .prepare(
              `INSERT INTO player_sessions (uuid, name, node_id, joined_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(player.uuid, player.name, nodeId, joinedAt);
        }
      }

      // 该节点上已经不在列表里的玩家 → 离线。
      const stale = this.db
        .prepare('SELECT uuid FROM players WHERE node_id = ? AND online = 1')
        .all(nodeId) as unknown as { uuid: string }[];

      let markedOffline = 0;
      for (const row of stale) {
        if (onlineUuids.has(row.uuid)) continue;
        this.db
          .prepare('UPDATE players SET online = 0, last_seen_at = ? WHERE uuid = ?')
          .run(now, row.uuid);
        this.db
          .prepare(
            `UPDATE player_sessions SET left_at = ?, playtime_seconds = ?
              WHERE uuid = ? AND node_id = ? AND left_at IS NULL`,
          )
          .run(now, 0, row.uuid, nodeId);
        markedOffline += 1;
      }

      return { known: players.length, markedOffline };
    });
  }

  findPlayerByName(name: string): PlayerRow | undefined {
    return this.db
      .prepare(
        `SELECT p.* FROM players p
          WHERE p.uuid = (SELECT uuid FROM player_names WHERE name = ? COLLATE NOCASE
                          ORDER BY last_seen_at DESC LIMIT 1)`,
      )
      .get(name) as unknown as PlayerRow | undefined;
  }

  ensurePlayer(uuid: string, name: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO players (uuid, name, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(uuid, name, now, now);
  }

  listPlayers(query: {
    kw?: string;
    online?: boolean;
    nodeId?: string;
    page: number;
    size: number;
  }): Page<PlayerRow> {
    const where: string[] = [];
    const args: SqlValue[] = [];

    if (query.kw) {
      where.push('(p.name LIKE ? COLLATE NOCASE OR p.uuid LIKE ?)');
      args.push(`%${query.kw}%`, `%${query.kw}%`);
    }
    if (query.online !== undefined) {
      where.push('p.online = ?');
      args.push(query.online ? 1 : 0);
    }
    if (query.nodeId) {
      where.push('p.node_id = ?');
      args.push(query.nodeId);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM players p ${clause}`)
        .get(...args) as unknown as { n: number }
    ).n;

    const items = this.db
      .prepare(
        `SELECT p.* FROM players p ${clause}
          ORDER BY p.online DESC, p.last_seen_at DESC, p.uuid ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...args, query.size, (query.page - 1) * query.size) as unknown as PlayerRow[];

    return { items, total, page: query.page, size: query.size };
  }

  getPlayerNames(
    uuid: string,
  ): { name: string; first_seen_at: number; last_seen_at: number }[] {
    return this.db
      .prepare(
        'SELECT name, first_seen_at, last_seen_at FROM player_names WHERE uuid = ? ORDER BY last_seen_at DESC',
      )
      .all(uuid) as unknown as {
      name: string;
      first_seen_at: number;
      last_seen_at: number;
    }[];
  }

  getPlayerIps(uuid: string) {
    return this.db
      .prepare(
        'SELECT ip, first_seen_at, last_seen_at, seen_count FROM player_ips WHERE uuid = ? ORDER BY last_seen_at DESC',
      )
      .all(uuid) as unknown as {
      ip: string;
      first_seen_at: number;
      last_seen_at: number;
      seen_count: number;
    }[];
  }

  getPlayerSessions(uuid: string, limit: number) {
    return this.db
      .prepare(
        `SELECT id, node_id, ip, joined_at, left_at, playtime_seconds
           FROM player_sessions WHERE uuid = ?
          ORDER BY joined_at DESC, id DESC LIMIT ?`,
      )
      .all(uuid, limit) as unknown as {
      id: number;
      node_id: string;
      ip: string | null;
      joined_at: number;
      left_at: number | null;
      playtime_seconds: number | null;
    }[];
  }

  // ── 角色目录（身份锚点） ───────────────────────────────────

  /**
   * 写入/更新一个皮肤站角色。
   *
   * **改名处理是这张表存在的全部意义**：换名字时不覆盖旧值，而是把旧的
   * 推进 prev_names / prev_uuids。于是「按旧名找同一个人」仍然可行，
   * 而 `name` / `uuid` 始终代表**当前**身份。
   */
  upsertCharacter(input: {
    bsPid: number;
    bsUid: number;
    name: string;
    uuid: string | null;
    source?: string;
  }): { created: boolean; renamed: boolean } {
    const now = Date.now();

    return this.tx(() => {
      const existing = this.db
        .prepare('SELECT * FROM characters WHERE bs_pid = ?')
        .get(input.bsPid) as unknown as CharacterRow | undefined;

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO characters
               (bs_pid, bs_uid, name, uuid, prev_names, prev_uuids,
                first_seen_at, last_seen_at, source, updated_at)
             VALUES (?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?)`,
          )
          .run(
            input.bsPid,
            input.bsUid,
            input.name,
            p(input.uuid),
            now,
            now,
            input.source ?? 'import',
            now,
          );
        return { created: true, renamed: false };
      }

      const renamed = existing.name !== input.name;

      // 旧值入历史。去重 + 截断，避免长期改名把行撑大。
      const pushUnique = (json: string, value: string | null): string => {
        if (!value) return json;
        let list: string[];
        try {
          list = JSON.parse(json) as string[];
          if (!Array.isArray(list)) list = [];
        } catch {
          list = [];
        }
        if (list.includes(value)) return JSON.stringify(list);
        list.push(value);
        // 只留最近 20 个：更早的历史对判罚没有价值，但会一直变大。
        return JSON.stringify(list.slice(-20));
      };

      let prevNames = existing.prev_names;
      let prevUuids = existing.prev_uuids;
      if (renamed) {
        prevNames = pushUnique(prevNames, existing.name);
      }
      if (input.uuid && existing.uuid && existing.uuid !== input.uuid) {
        prevUuids = pushUnique(prevUuids, existing.uuid);
      }
      // 名字变了但 UUID 没变（理论上 v3 下不会发生，但目录可能来自
      // 手工导入）—— 也把旧 UUID 记下来，宁可多留。
      if (renamed && existing.uuid && existing.uuid !== input.uuid) {
        prevUuids = pushUnique(prevUuids, existing.uuid);
      }

      this.db
        .prepare(
          `UPDATE characters
              SET bs_uid = ?, name = ?, uuid = ?, prev_names = ?, prev_uuids = ?,
                  last_seen_at = ?, source = ?, updated_at = ?
            WHERE bs_pid = ?`,
        )
        .run(
          input.bsUid,
          input.name,
          p(input.uuid),
          prevNames,
          prevUuids,
          now,
          input.source ?? existing.source,
          now,
          input.bsPid,
        );

      return { created: false, renamed };
    });
  }

  getCharacter(bsPid: number): CharacterRow | undefined {
    return this.db
      .prepare('SELECT * FROM characters WHERE bs_pid = ?')
      .get(bsPid) as unknown as CharacterRow | undefined;
  }

  listCharacters(limit = 1000): CharacterRow[] {
    return this.db
      .prepare('SELECT * FROM characters ORDER BY last_seen_at DESC LIMIT ?')
      .all(limit) as unknown as CharacterRow[];
  }

  countCharacters(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM characters').get() as unknown as { n: number }
    ).n;
  }

  /**
   * 按**当前名或历史名**找角色。
   *
   * 历史名也要能命中：皮肤站改名后，游戏里可能还有一个客户端用旧名
   * 在重连，而平台只见过旧名。
   */
  findCharacterByName(name: string): CharacterRow | undefined {
    const direct = this.db
      .prepare('SELECT * FROM characters WHERE name = ? COLLATE NOCASE')
      .get(name) as unknown as CharacterRow | undefined;
    if (direct) return direct;

    // prev_names 是 JSON 数组，用 LIKE 粗筛后再精确比对，
    // 避免把名字里的特殊字符当成 JSON 语法。
    const candidates = this.db
      .prepare("SELECT * FROM characters WHERE prev_names LIKE ? COLLATE NOCASE")
      .all(`%"${name}"%`) as unknown as CharacterRow[];

    return candidates.find((row) => {
      try {
        const list = JSON.parse(row.prev_names) as unknown;
        return Array.isArray(list) && list.some((n) => String(n).toLowerCase() === name.toLowerCase());
      } catch {
        return false;
      }
    });
  }

  /**
   * 按皮肤站 uid 反查角色。
   *
   * 给 `skin` 账本用：皮肤站的 `credit_ledger` 按 `uid` 记流水，
   * 而平台面向账本的键是 MC UUID，需要这个方向才能把站点流水显示成玩家。
   *
   * 同一个 uid 理论上只对应一个角色（注册时绑定），但 `charactersStatus()`
   * 会把「一个 uid 对多个角色」当成异常报出来，所以这里按最近活跃取一条，
   * 而不是假设唯一 —— 数据脏了也不该让查询抛异常。
   */
  findCharacterByUid(bsUid: number): CharacterRow | undefined {
    return this.db
      .prepare('SELECT * FROM characters WHERE bs_uid = ? ORDER BY last_seen_at DESC LIMIT 1')
      .get(bsUid) as unknown as CharacterRow | undefined;
  }

  findCharacterByUuid(uuid: string): CharacterRow | undefined {
    const direct = this.db
      .prepare('SELECT * FROM characters WHERE uuid = ?')
      .get(uuid) as unknown as CharacterRow | undefined;
    if (direct) return direct;

    const candidates = this.db
      .prepare('SELECT * FROM characters WHERE prev_uuids LIKE ?')
      .all(`%${uuid}%`) as unknown as CharacterRow[];

    return candidates.find((row) => {
      try {
        const list = JSON.parse(row.prev_uuids) as unknown;
        return Array.isArray(list) && list.includes(uuid);
      } catch {
        return false;
      }
    });
  }

  /**
   * 把游戏里看到的身份解析成皮肤站角色 pid。
   *
   * 先用 uuid（更准），再用名字。都找不到返回 null ——
   * **不要**退化成「按 uuid 造一个 pid」，那会把不同的人合并。
   */
  resolveCharacterPid(identity: { uuid?: string | null; name?: string | null }): number | null {
    if (identity.uuid) {
      const byUuid = this.findCharacterByUuid(identity.uuid);
      if (byUuid) return byUuid.bs_pid;
    }
    if (identity.name) {
      const byName = this.findCharacterByName(identity.name);
      if (byName) return byName.bs_pid;
    }
    return null;
  }

  /** 游戏内看到的身份 → 关联到角色（幂等）。 */
  linkPlayerToCharacter(uuid: string, bsPid: number | null): void {
    this.db.prepare('UPDATE players SET bs_pid = ? WHERE uuid = ?').run(p(bsPid), uuid);
  }

  /**
   * 目录健康度。
   *
   * `renameBypassable` 是这里最重要的数字：**没有关联 pid 的生效封禁**。
   * 它们只能按 UUID 匹配，而本站 UUID 由角色名派生 —— 玩家改个名就绕过了。
   *
   * 把它做成一个显式指标而不是藏在日志里，是因为「封禁看起来生效了、
   * 其实能被绕过」是最危险的状态：管理员不会去查，直到有人在论坛上炫耀。
   */
  charactersStatus(): {
    count: number;
    withUuid: number;
    lastSyncedAt: number | null;
    lastSyncedAgoMs: number | null;
    stale: boolean;
    staleAfterMs: number;
    renameBypassable: number;
    /** 有多少账号拥有多个角色 —— 平台不该假设 uid 与 pid 一对一。 */
    multiCharacterAccounts: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS n,
           SUM(CASE WHEN uuid IS NOT NULL THEN 1 ELSE 0 END) AS with_uuid,
           MAX(updated_at) AS last_sync
         FROM characters`,
      )
      .get() as unknown as { n: number; with_uuid: number | null; last_sync: number | null };

    const multi = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM (SELECT bs_uid FROM characters GROUP BY bs_uid HAVING COUNT(*) > 1)',
      )
      .get() as unknown as { n: number };

    const renameBypassable = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM punishments
            WHERE active = 1 AND bs_pid IS NULL
              AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .get(Date.now()) as unknown as { n: number }
    ).n;

    const lastSyncedAt = row.last_sync ?? null;
    const lastSyncedAgoMs = lastSyncedAt === null ? null : Date.now() - lastSyncedAt;

    return {
      count: row.n,
      withUuid: row.with_uuid ?? 0,
      lastSyncedAt,
      lastSyncedAgoMs,
      stale: lastSyncedAgoMs === null ? true : lastSyncedAgoMs > CHARACTERS_STALE_AFTER_MS,
      staleAfterMs: CHARACTERS_STALE_AFTER_MS,
      renameBypassable,
      multiCharacterAccounts: multi.n,
    };
  }

  // ── 封禁 ───────────────────────────────────────────────────

  /** 新增封禁并在同一事务里递增快照版本号。 */
  createPunishment(input: {
    id: string;
    type: string;
    uuid: string;
    name: string;
    reason: string;
    operator: string;
    nodeId: string | null;
    expiresAt: number | null;
    /** 皮肤站角色 pid。能给就给 —— 这是唯一扛得住改名的键。 */
    bsPid?: number | null;
  }): PunishmentRow {
    const now = Date.now();
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO punishments
             (id, type, uuid, name, reason, operator, node_id, created_at, expires_at, active, bs_pid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          input.id,
          input.type,
          input.uuid,
          input.name,
          input.reason,
          input.operator,
          p(input.nodeId),
          now,
          p(input.expiresAt),
          p(input.bsPid ?? null),
        );

      this.bumpPunishRevision();

      return this.db
        .prepare('SELECT * FROM punishments WHERE id = ?')
        .get(input.id) as unknown as PunishmentRow;
    });
  }

  /**
   * 刷新一条封禁的「当前身份」快照。
   *
   * 玩家改名后调用：pid 不变（封禁依旧有效），但下发给 Agent 的
   * uuid/name 必须换成新的，否则 Agent 的快照里还是旧名，拦不住人。
   *
   * 同时递增 revision —— 身份变了就是快照变了。
   */
  updatePunishmentIdentity(
    id: string,
    identity: { uuid: string; name: string },
  ): PunishmentRow | undefined {
    return this.tx(() => {
      const info = this.db
        .prepare('UPDATE punishments SET uuid = ?, name = ? WHERE id = ?')
        .run(identity.uuid, identity.name, id);

      if (Number(info.changes) === 0) return undefined;

      this.bumpPunishRevision();
      return this.db
        .prepare('SELECT * FROM punishments WHERE id = ?')
        .get(id) as unknown as PunishmentRow;
    });
  }

  /** 按皮肤站角色查生效中的封禁 —— 判罚的主查询。 */
  listActivePunishmentsForPid(bsPid: number): PunishmentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM punishments
          WHERE bs_pid = ? AND active = 1
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(bsPid, Date.now()) as unknown as PunishmentRow[];
  }

  listPunishmentsForPid(bsPid: number): PunishmentRow[] {
    return this.db
      .prepare(
        'SELECT * FROM punishments WHERE bs_pid = ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(bsPid) as unknown as PunishmentRow[];
  }

  revokePunishment(id: string, by: string): PunishmentRow | undefined {
    return this.tx(() => {
      const info = this.db
        .prepare(
          `UPDATE punishments SET active = 0, revoked_at = ?, revoked_by = ?
            WHERE id = ? AND active = 1`,
        )
        .run(Date.now(), by, id);

      if (Number(info.changes) === 0) return undefined;

      this.bumpPunishRevision();
      return this.db
        .prepare('SELECT * FROM punishments WHERE id = ?')
        .get(id) as unknown as PunishmentRow;
    });
  }

  /**
   * 把已过期的封禁标记为失效。
   *
   * 定时任务调用。**同时递增快照版本**，这样 Agent 会收到新的快照 ——
   * 否则「封禁到期」这件事永远不会传播到游戏侧。
   */
  expirePunishments(): string[] {
    return this.tx(() => {
      const now = Date.now();
      const rows = this.db
        .prepare(
          `SELECT id FROM punishments
            WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .all(now) as unknown as { id: string }[];

      if (rows.length === 0) return [];

      this.db
        .prepare(
          `UPDATE punishments SET active = 0
            WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .run(now);

      this.bumpPunishRevision();
      return rows.map((r) => r.id);
    });
  }

  getPunishment(id: string): PunishmentRow | undefined {
    return this.db.prepare('SELECT * FROM punishments WHERE id = ?').get(id) as unknown as
      | PunishmentRow
      | undefined;
  }

  listPunishments(query: {
    type?: string;
    active?: boolean;
    uuid?: string;
    nodeId?: string;
    kw?: string;
    page: number;
    size: number;
  }): Page<PunishmentRow> {
    const where: string[] = [];
    const args: SqlValue[] = [];

    if (query.type) {
      where.push('type = ?');
      args.push(query.type);
    }
    if (query.active !== undefined) {
      where.push('active = ?');
      args.push(query.active ? 1 : 0);
    }
    if (query.uuid) {
      where.push('uuid = ?');
      args.push(query.uuid);
    }
    if (query.nodeId) {
      // 「全平台封禁」也要出现在按节点筛选的结果里 ——
      // 它确实在该节点生效，漏掉会让管理员以为没封上。
      where.push('(node_id = ? OR node_id IS NULL)');
      args.push(query.nodeId);
    }
    if (query.kw) {
      where.push('(name LIKE ? COLLATE NOCASE OR reason LIKE ? COLLATE NOCASE)');
      args.push(`%${query.kw}%`, `%${query.kw}%`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM punishments ${clause}`)
        .get(...args) as unknown as { n: number }
    ).n;

    const items = this.db
      .prepare(
        `SELECT * FROM punishments ${clause}
          ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, query.size, (query.page - 1) * query.size) as unknown as PunishmentRow[];

    return { items, total, page: query.page, size: query.size };
  }

  listActivePunishmentsFor(uuid: string): PunishmentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM punishments
          WHERE uuid = ? AND active = 1
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(uuid, Date.now()) as unknown as PunishmentRow[];
  }

  /** 全平台 active 快照。只含未过期的。 */
  listAllActivePunishments(): PunishmentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM punishments
          WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(Date.now()) as unknown as PunishmentRow[];
  }

  listPunishmentsForUuid(uuid: string): PunishmentRow[] {
    return this.db
      .prepare(
        'SELECT * FROM punishments WHERE uuid = ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(uuid) as unknown as PunishmentRow[];
  }

  private bumpPunishRevision(): number {
    this.db.prepare('UPDATE punish_state SET revision = revision + 1 WHERE id = 1').run();
    const row = this.db
      .prepare('SELECT revision FROM punish_state WHERE id = 1')
      .get() as unknown as { revision: number };
    return row.revision;
  }

  getPunishRevision(): number {
    const row = this.db
      .prepare('SELECT revision FROM punish_state WHERE id = 1')
      .get() as unknown as { revision: number };
    return row.revision;
  }

  // ── 经济 ───────────────────────────────────────────────────

  getEconomyAccount(uuid: string): EconomyAccountRow | undefined {
    return this.db
      .prepare('SELECT * FROM economy_accounts WHERE uuid = ?')
      .get(uuid) as unknown as EconomyAccountRow | undefined;
  }

  ensureEconomyAccount(uuid: string): EconomyAccountRow {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT OR IGNORE INTO economy_accounts (uuid, balance, updated_at) VALUES (?, 0, ?)',
      )
      .run(uuid, now);
    return this.db
      .prepare('SELECT * FROM economy_accounts WHERE uuid = ?')
      .get(uuid) as unknown as EconomyAccountRow;
  }

  listEconomyAccounts(query: { kw?: string; page: number; size: number }) {
    const where: string[] = [];
    const args: SqlValue[] = [];

    if (query.kw) {
      where.push("(a.uuid LIKE ? OR COALESCE(p.name, '') LIKE ? COLLATE NOCASE)");
      args.push(`%${query.kw}%`, `%${query.kw}%`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = 'FROM economy_accounts a LEFT JOIN players p ON p.uuid = a.uuid';

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n ${from} ${clause}`).get(...args) as unknown as {
        n: number;
      }
    ).n;

    const items = this.db
      .prepare(
        `SELECT a.uuid, a.balance, a.updated_at, p.name AS name ${from} ${clause}
          ORDER BY a.balance DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, query.size, (query.page - 1) * query.size) as unknown as {
      uuid: string;
      balance: number;
      updated_at: number;
      name: string | null;
    }[];

    return { items, total, page: query.page, size: query.size };
  }

  /**
   * 改余额 + 记流水，**在同一个事务里**。
   *
   * 幂等靠 `event_id` 的唯一索引：先查有没有处理过，处理过就抛
   * `IdempotencyConflict` 让整个事务回滚。唯一索引是最终防线 ——
   * 即便两个并发请求同时通过了这里的检查，第二个插入也会被索引挡住。
   *
   * 余额从库里读，**不信任调用方**。
   */
  adjustBalance(change: BalanceChange): BalanceResult {
    return this.tx(() => {
      const existing = this.db
        .prepare('SELECT id FROM economy_ledger WHERE event_id = ?')
        .get(change.eventId) as unknown as { id: number } | undefined;
      if (existing) throw new IdempotencyConflict(change.eventId);

      this.db
        .prepare(
          'INSERT OR IGNORE INTO economy_accounts (uuid, balance, updated_at) VALUES (?, 0, ?)',
        )
        .run(change.uuid, Date.now());

      const account = this.db
        .prepare('SELECT balance FROM economy_accounts WHERE uuid = ?')
        .get(change.uuid) as unknown as { balance: number };

      const next = account.balance + change.delta;

      this.db
        .prepare('UPDATE economy_accounts SET balance = ?, updated_at = ? WHERE uuid = ?')
        .run(next, Date.now(), change.uuid);

      const info = this.db
        .prepare(
          `INSERT INTO economy_ledger
             (uuid, delta, balance_after, source, note, operator, event_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          change.uuid,
          change.delta,
          next,
          change.source,
          change.note,
          change.operator,
          change.eventId,
          Date.now(),
        );

      return { balance: next, ledgerId: Number(info.lastInsertRowid) };
    });
  }

  listLedger(query: {
    uuid?: string;
    source?: string;
    from?: number;
    to?: number;
    page: number;
    size: number;
  }) {
    const where: string[] = [];
    const args: SqlValue[] = [];

    if (query.uuid) {
      where.push('l.uuid = ?');
      args.push(query.uuid);
    }
    if (query.source) {
      where.push('l.source = ?');
      args.push(query.source);
    }
    if (query.from !== undefined) {
      where.push('l.created_at >= ?');
      args.push(query.from);
    }
    if (query.to !== undefined) {
      where.push('l.created_at <= ?');
      args.push(query.to);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = 'FROM economy_ledger l LEFT JOIN players p ON p.uuid = l.uuid';

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n ${from} ${clause}`).get(...args) as unknown as {
        n: number;
      }
    ).n;

    const items = this.db
      .prepare(
        `SELECT l.*, p.name AS name ${from} ${clause}
          ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, query.size, (query.page - 1) * query.size) as unknown as (LedgerRow & {
      name: string | null;
    })[];

    return { items, total, page: query.page, size: query.size };
  }

  economyStats(): {
    accounts: number;
    totalBalance: number;
    ledgerCount: number;
    last24hDelta: number;
    topBalances: { uuid: string; name: string | null; balance: number }[];
    sources: { source: string; count: number; delta: number }[];
  } {
    const accounts = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM economy_accounts')
        .get() as unknown as { n: number }
    ).n;
    const totalBalance = (
      this.db
        .prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM economy_accounts')
        .get() as unknown as { s: number }
    ).s;
    const ledgerCount = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM economy_ledger')
        .get() as unknown as { n: number }
    ).n;
    const last24hDelta = (
      this.db
        .prepare(
          'SELECT COALESCE(SUM(delta), 0) AS s FROM economy_ledger WHERE created_at >= ?',
        )
        .get(Date.now() - 24 * 3600 * 1000) as unknown as { s: number }
    ).s;

    const topBalances = this.db
      .prepare(
        `SELECT a.uuid, a.balance, p.name AS name
           FROM economy_accounts a LEFT JOIN players p ON p.uuid = a.uuid
          ORDER BY a.balance DESC LIMIT 10`,
      )
      .all() as unknown as { uuid: string; balance: number; name: string | null }[];

    const sources = this.db
      .prepare(
        `SELECT source, COUNT(*) AS count, COALESCE(SUM(delta), 0) AS delta
           FROM economy_ledger GROUP BY source ORDER BY count DESC LIMIT 20`,
      )
      .all() as unknown as { source: string; count: number; delta: number }[];

    return { accounts, totalBalance, ledgerCount, last24hDelta, topBalances, sources };
  }

  // ── 配置 ───────────────────────────────────────────────────

  getConfig(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM config').all() as unknown as {
      key: string;
      value: string;
    }[];
    const out: Record<string, string> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  }

  /**
   * 写配置。
   *
   * 校验分两层：单字段规则（类型、范围）与跨字段关系
   * （`min_coin >= ratio`）。任何一条不过就**整批拒绝**，
   * 不做「部分写入」—— 部分写入会留下一个自相矛盾的配置。
   */
  setConfig(patch: Record<string, string>): Record<string, string> {
    const unknown = Object.keys(patch).filter((k) => !(k in CONFIG_RULES));
    if (unknown.length > 0) {
      throw new ConfigValidationError(`未知配置项：${unknown.join('、')}`);
    }

    for (const [key, raw] of Object.entries(patch)) {
      const rule = CONFIG_RULES[key]!;
      if (rule.type === 'int') {
        if (!/^-?\d+$/.test(raw)) {
          throw new ConfigValidationError(`${key} 必须是整数，收到「${raw}」`);
        }
        const n = Number.parseInt(raw, 10);
        if (rule.min !== undefined && n < rule.min) {
          throw new ConfigValidationError(`${key} 不能小于 ${rule.min}`);
        }
        if (rule.max !== undefined && n > rule.max) {
          throw new ConfigValidationError(`${key} 不能大于 ${rule.max}`);
        }
      } else if (rule.type === 'bool') {
        if (raw !== '0' && raw !== '1') {
          throw new ConfigValidationError(`${key} 只能是 0 或 1，收到「${raw}」`);
        }
      } else if (rule.type === 'string') {
        if (raw.length > 64) {
          throw new ConfigValidationError(`${key} 长度不能超过 64`);
        }
      }
    }

    const merged = { ...this.getConfig(), ...patch };
    const crossError = validateConfigCross(merged);
    if (crossError) throw new ConfigValidationError(crossError);

    this.tx(() => {
      const stmt = this.db.prepare(
        `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      );
      for (const [key, value] of Object.entries(patch)) {
        stmt.run(key, value, Date.now());
      }
    });

    return merged;
  }

  // ── 审计 ───────────────────────────────────────────────────

  audit(entry: {
    actor: string;
    actorIp: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    nodeId?: string | null;
    params?: unknown;
    ok: boolean;
    error?: string | null;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO audit_log
             (ts, actor, actor_ip, action, target_type, target_id, node_id, params, ok, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          Date.now(),
          entry.actor,
          p(entry.actorIp),
          entry.action,
          entry.targetType ?? '',
          entry.targetId ?? '',
          p(entry.nodeId),
          JSON.stringify(entry.params ?? {}).slice(0, 8000),
          entry.ok ? 1 : 0,
          p(entry.error),
        );
    } catch (error) {
      // 审计写入失败不能拖垮业务操作，但必须留下痕迹 ——
      // 「审计悄悄丢了」比「审计没记」更危险。
      log.error('审计日志写入失败', { error, entry });
    }
  }

  listAudit(query: {
    actor?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    nodeId?: string;
    ok?: boolean;
    from?: number;
    to?: number;
    page: number;
    size: number;
  }): Page<AuditRow> {
    const where: string[] = [];
    const args: SqlValue[] = [];

    if (query.actor) {
      where.push('actor = ?');
      args.push(query.actor);
    }
    if (query.action) {
      where.push('action LIKE ?');
      args.push(`${query.action}%`);
    }
    if (query.targetType) {
      where.push('target_type = ?');
      args.push(query.targetType);
    }
    if (query.targetId) {
      where.push('target_id = ?');
      args.push(query.targetId);
    }
    if (query.nodeId) {
      where.push('node_id = ?');
      args.push(query.nodeId);
    }
    if (query.ok !== undefined) {
      where.push('ok = ?');
      args.push(query.ok ? 1 : 0);
    }
    if (query.from !== undefined) {
      where.push('ts >= ?');
      args.push(query.from);
    }
    if (query.to !== undefined) {
      where.push('ts <= ?');
      args.push(query.to);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`)
        .get(...args) as unknown as { n: number }
    ).n;

    const items = this.db
      .prepare(`SELECT * FROM audit_log ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, query.size, (query.page - 1) * query.size) as unknown as AuditRow[];

    return { items, total, page: query.page, size: query.size };
  }
}
