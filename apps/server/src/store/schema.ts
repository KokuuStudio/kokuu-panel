/**
 * 数据库结构。
 *
 * 用 SQLite 方言书写（Node 内置 `node:sqlite`，零原生依赖）。
 * 换 MySQL 时只需改三处：`INTEGER PRIMARY KEY AUTOINCREMENT`、
 * 布尔用 `INTEGER` 还是 `TINYINT`、以及 `INSERT … ON CONFLICT` 的写法。
 * 收敛点见 `store/dialect.ts`。
 *
 * 设计上的一条铁律：**任何需要保证一致的状态，权威都在这里。**
 * Agent 侧只持有可失效的快照。
 */

export const SCHEMA_VERSION = 3;

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── 后台账号 ────────────────────────────────────────────────
--
-- 两种来源，用 auth_provider 区分：
--   local  本地口令（无皮肤站的部署，或皮肤站管理员之外的运维账号）
--   oauth  皮肤站账号经 kokuu-credit 的 OAuth2 登入
--
-- oauth 账号的 password_hash 存空串 ——「这个账号不靠口令登录」。
-- 空串永远过不了 verifySecret（它解析不出六段格式），所以
-- 不会出现「空口令能登进 OAuth 账号」这种漏洞。
--
-- ⚠️ 本字符串是 TS 模板串，注释里**不要用反引号**（会截断字符串），
--    也不要写美元符号加花括号（会被当成插值 —— 这条注释自己就踩过一次）。
--    要强调就用「」。
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL DEFAULT '',
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'viewer',
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  last_login_ip TEXT,
  -- 皮肤站 users.uid。OAuth 账号靠它认人（邮箱会变，uid 不会）。
  skin_uid      INTEGER,
  auth_provider TEXT    NOT NULL DEFAULT 'local'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_skin_uid
  ON accounts(skin_uid) WHERE skin_uid IS NOT NULL;

-- OAuth2 授权码流程的一次性 state 与 PKCE verifier。
--
-- 存库而不是存内存：多实例部署时回调可能落到另一个实例上，
-- 存内存会表现为「登录随机失败」——最难查的那类问题。
CREATE TABLE IF NOT EXISTS oauth_states (
  state        TEXT    PRIMARY KEY,
  code_verifier TEXT   NOT NULL,
  redirect_to  TEXT    NOT NULL DEFAULT '/',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  csrf       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ── 节点 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  secret_hash  TEXT    NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  tags         TEXT    NOT NULL DEFAULT '[]',
  agent_version TEXT,
  mc_version   TEXT,
  brand        TEXT,
  capabilities TEXT    NOT NULL DEFAULT '[]',
  last_seen_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- ── 角色目录（身份锚点） ─────────────────────────────────────
--
-- 为什么需要这张表：本平台的封禁必须扛得住改名。
--
-- 实测事实（见 docs/ECOSYSTEM.md §4.1）：本站 ygg_uuid_algorithm=v3，
-- Yggdrasil 返回的 UUID 是 md5("OfflinePlayer:" + 角色名) 派生出来的。
-- 于是「名字」与「UUID」是**等价**的标识 —— 改名会让两个一起变。
-- 唯一稳定的身份是 Blessing Skin 的 players.pid。
--
-- 所以平台要把 (pid, uid, name, uuid) 的对应关系存下来。它来自皮肤站：
--   SELECT p.pid, p.uid, p.name, u.uuid
--     FROM players p LEFT JOIN uuid u ON u.name = p.name
--
-- uuid 可以为 NULL：从没经 Yggdrasil 登录过的角色在皮肤站也没有 uuid 行。
--
-- 一个 pid 会有**多行历史**吗？不会 —— 这张表按 pid 唯一，改名时更新
-- name/uuid 并把旧值推进 prev_names。历史名字留在 prev_names 里，
-- 用于「按旧名找到同一个人」。
CREATE TABLE IF NOT EXISTS characters (
  bs_pid      INTEGER PRIMARY KEY,
  bs_uid      INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  uuid        TEXT,
  prev_names  TEXT    NOT NULL DEFAULT '[]',
  prev_uuids  TEXT    NOT NULL DEFAULT '[]',
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  source      TEXT    NOT NULL DEFAULT 'import',
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_characters_name ON characters(name);
CREATE INDEX IF NOT EXISTS idx_characters_uuid ON characters(uuid);
CREATE INDEX IF NOT EXISTS idx_characters_uid ON characters(bs_uid);

-- ── 玩家 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  uuid             TEXT    PRIMARY KEY,
  name             TEXT    NOT NULL,
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  playtime_seconds INTEGER NOT NULL DEFAULT 0,
  last_ip          TEXT,
  online           INTEGER NOT NULL DEFAULT 0,
  node_id          TEXT,
  -- 关联到皮肤站角色。可空：目录还没导入时就是 NULL。
  bs_pid           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_players_bs_pid ON players(bs_pid);

-- 曾用名。UUID 是身份锚点，名字只是历史 —— 改名玩家要能靠旧名找到。
CREATE TABLE IF NOT EXISTS player_names (
  uuid          TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (uuid, name)
);
CREATE INDEX IF NOT EXISTS idx_player_names_name ON player_names(name);

CREATE TABLE IF NOT EXISTS player_ips (
  uuid          TEXT    NOT NULL,
  ip            TEXT    NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  seen_count    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (uuid, ip)
);
CREATE INDEX IF NOT EXISTS idx_player_ips_ip ON player_ips(ip);

CREATE TABLE IF NOT EXISTS player_sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid             TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  node_id          TEXT    NOT NULL,
  ip               TEXT,
  joined_at        INTEGER NOT NULL,
  left_at          INTEGER,
  playtime_seconds INTEGER
);
CREATE INDEX IF NOT EXISTS idx_player_sessions_uuid
  ON player_sessions(uuid, joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_player_sessions_open
  ON player_sessions(uuid, left_at);

-- ── 封禁 / 禁言（权威） ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS punishments (
  id         TEXT    PRIMARY KEY,
  type       TEXT    NOT NULL,
  uuid       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  reason     TEXT    NOT NULL,
  operator   TEXT    NOT NULL,
  node_id    TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  bs_pid     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_punishments_uuid ON punishments(uuid, active);
CREATE INDEX IF NOT EXISTS idx_punishments_active ON punishments(active, type);
CREATE INDEX IF NOT EXISTS idx_punishments_created ON punishments(created_at DESC);

-- 封禁的权威键是皮肤站角色 pid，不是 uuid。
--
-- 原因见 characters 表的注释：本站 UUID 由角色名派生，改名即失效。
-- uuid / name 这两列保留下来只作**展示与下发快照**用（Agent 只认 uuid/name），
-- 它们是「最近一次已知身份」的快照，会被改名事件刷新。
--
-- ⚠️ 注意列定义在 CREATE TABLE 里（新装用），老库由
--    store/index.ts 的 migrateV2toV3() 补 —— 不要在这里写 ALTER，
--    DDL 每次启动都会执行，重复 ALTER 会报 duplicate column name。
CREATE INDEX IF NOT EXISTS idx_punishments_pid ON punishments(bs_pid, active);

-- 快照版本号。每次封禁状态变化 +1，Agent 据此判断自己的快照是否过期。
CREATE TABLE IF NOT EXISTS punish_state (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO punish_state (id, revision) VALUES (1, 0);

-- ── 经济 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS economy_accounts (
  uuid       TEXT    PRIMARY KEY,
  balance    REAL    NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS economy_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid          TEXT    NOT NULL,
  delta         REAL    NOT NULL,
  balance_after REAL    NOT NULL,
  source        TEXT    NOT NULL,
  note          TEXT    NOT NULL DEFAULT '',
  operator      TEXT    NOT NULL DEFAULT '',
  -- 幂等键。唯一索引是「网络重试不会发两遍钱」的唯一防线，
  -- 不能靠「先查再写」——两个并发请求会都通过检查。
  event_id      TEXT    NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_uuid ON economy_ledger(uuid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON economy_ledger(created_at DESC);

-- ── 配置 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── 审计 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  actor       TEXT    NOT NULL,
  actor_ip    TEXT,
  action      TEXT    NOT NULL,
  target_type TEXT    NOT NULL DEFAULT '',
  target_id   TEXT    NOT NULL DEFAULT '',
  node_id     TEXT,
  params      TEXT    NOT NULL DEFAULT '{}',
  ok          INTEGER NOT NULL DEFAULT 1,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, ts DESC);

-- 登录失败记录。按 IP 限流用，登录成功后不清除 ——
-- 清了就等于给攻击者「试错 → 成功 → 重置计数」的循环。
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT    NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, ts DESC);
`;

/** 经济模块的默认配置。与 kokuu-credit-admin 的键名保持一致，便于迁移。 */
export const DEFAULT_CONFIG: Record<string, string> = {
  'economy.enabled': '1',
  'economy.ratio': '1000',
  'economy.daily_limit': '200',
  'economy.single_limit': '50',
  'economy.min_coin': '1000',
  'economy.reflow_enabled': '0',
  'economy.reflow_daily_limit': '0',
  'economy.currency_name': '金币',
  'economy.points_name': '积分',
};

/**
 * 经济配置的约束。
 *
 * `kokuu-credit-admin` 把「min_coin < ratio」这类矛盾配置以警告形式
 * 打在页面上；这里改成**拒绝写入** —— 一个会让每一笔兑换都被拒的
 * 配置不该进数据库。教训来自那份 README 的「⚠️ min_coin 必须 ≥ ratio」。
 */
export const CONFIG_RULES: Record<
  string,
  { type: 'int' | 'bool' | 'string'; min?: number; max?: number }
> = {
  'economy.enabled': { type: 'bool' },
  'economy.ratio': { type: 'int', min: 1 },
  'economy.daily_limit': { type: 'int', min: 0 },
  'economy.single_limit': { type: 'int', min: 0 },
  'economy.min_coin': { type: 'int', min: 0 },
  'economy.reflow_enabled': { type: 'bool' },
  'economy.reflow_daily_limit': { type: 'int', min: 0 },
  'economy.currency_name': { type: 'string' },
  'economy.points_name': { type: 'string' },
};

/**
 * 跨字段校验：在单字段规则之外，还要检查彼此关系。
 * 返回错误消息，或 null 表示通过。
 */
export function validateConfigCross(
  merged: Record<string, string>,
): string | null {
  const int = (k: string) => Number.parseInt(merged[k] ?? '0', 10);

  const ratio = int('economy.ratio');
  const minCoin = int('economy.min_coin');
  const singleLimit = int('economy.single_limit');

  if (ratio >= 1 && minCoin > 0 && minCoin < ratio) {
    return (
      `单笔最少消耗金币（${minCoin}）必须 ≥ 兑换比例（${ratio}），` +
      '否则玩家按最低门槛提交也换不到 1 个积分，每一笔兑换都会被拒'
    );
  }

  if (singleLimit > 0 && singleLimit < 1) {
    return '单笔限额必须 ≥ 1，或填 0 表示不限';
  }

  return null;
}
