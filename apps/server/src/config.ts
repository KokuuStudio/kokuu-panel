/**
 * 运行配置。
 *
 * 全部走环境变量，不读配置文件 —— 后端是常驻服务，
 * 环境变量在容器里比文件更好管（不需要挂载，不会被误提交）。
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * 路径配置。
 *
 * **fallback 也必须走 resolve** —— 否则未设置环境变量时拿到的是相对路径，
 * 而相对路径是相对**进程 cwd** 的。同一份配置在「`cd kokuu-panel && node
 * apps/server/src/index.ts`」与「systemd 里 cwd=/」下会指向两个不同的目录，
 * 症状是「本地好好的，装成服务就找不到前端产物」。
 *
 * 所以这里一律返回绝对路径，调用方不需要再 resolve 一次。
 */
function envPath(name: string, fallback: string): string {
  const raw = process.env[name];
  const value = raw && raw !== '' ? raw : fallback;
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

/**
 * 会话密钥。
 *
 * 开发环境自动生成并落盘到 `data/session.key`；生产环境**必须**通过
 * `KP_SESSION_SECRET` 显式提供 —— 多实例部署时各自随机生成的密钥
 * 会让 A 实例签发的会话在 B 实例上校验失败，表现为「随机被登出」。
 */
function sessionSecret(): string {
  const provided = process.env.KP_SESSION_SECRET;
  if (provided && provided.length >= 16) return provided;

  const dataDir = envPath('KP_DATA_DIR', 'data');
  mkdirSync(dataDir, { recursive: true });
  const keyFile = join(dataDir, 'session.key');

  if (existsSync(keyFile)) {
    const existing = readFileSync(keyFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }

  const generated = randomBytes(32).toString('hex');
  writeFileSync(keyFile, generated, { encoding: 'utf8', mode: 0o600 });

  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[config] 未设置 KP_SESSION_SECRET，已生成并写入 ' +
        keyFile +
        '。多实例部署时必须显式设置，否则会话无法跨实例共享。',
    );
  }
  return generated;
}

export const config = {
  host: env('KP_HOST', '127.0.0.1'),
  port: envInt('KP_PORT', 8787),
  nodeEnv: env('KP_NODE_ENV', process.env.NODE_ENV ?? 'development'),
  isProduction: env('KP_NODE_ENV', process.env.NODE_ENV ?? 'development') === 'production',

  dataDir: envPath('KP_DATA_DIR', 'data'),
  /** SQLite 库路径。为空则用 `dataDir/kokuu.sqlite`。 */
  dbFile: process.env.KP_DB_FILE
    ? envPath('KP_DB_FILE', '')
    : join(envPath('KP_DATA_DIR', 'data'), 'kokuu.sqlite'),

  sessionSecret: sessionSecret(),
  /** 会话有效期：7 天。 */
  sessionTtlMs: envInt('KP_SESSION_TTL_MS', 7 * 24 * 3600 * 1000),

  /** 前端构建产物。存在则后端直接托管，省掉一个 nginx。 */
  webDist: envPath('KP_WEB_DIST', 'apps/web/dist'),

  /**
   * 是否信任反向代理的 X-Forwarded-For。
   * 默认 false —— 直接监听时信任它等于让任何人都能伪造来源 IP，
   * 而登录限流与审计都依赖来源 IP。
   */
  trustProxy: envBool('KP_TRUST_PROXY', false),

  /** 单 IP 登录失败次数上限与窗口。 */
  loginMaxAttempts: envInt('KP_LOGIN_MAX_ATTEMPTS', 10),
  loginWindowMs: envInt('KP_LOGIN_WINDOW_MS', 15 * 60 * 1000),

  /** 初始管理员（仅当 accounts 表为空时用于播种）。 */
  bootstrapAdmin: env('KP_ADMIN_USER', 'admin'),
  bootstrapPassword: process.env.KP_ADMIN_PASSWORD ?? '',

  /**
   * 站点积分账本由谁持有。
   *
   * - `external`（默认）：**平台不持有账本**。唯一账本是 Blessing Skin 的
   *   `users.score` + `credit_ledger`（由 `kokuu-credit` 维护）。
   *   平台的积分相关接口变成「只读视图 + 操作入口」，写操作走对接层。
   * - `standalone`：平台自带 SQLite 账本。**仅用于没有皮肤站的部署**，
   *   需要显式开启。
   *
   * 默认值刻意选 `external`：装上平台就凭空多出第二个余额，
   * 正是 kokuu-credit 与 kokuu-coupon 的 README 反复警告的
   * 「两个真相源」。要变成第二个账本必须是**有意为之**，
   * 不能是默认行为。详见 docs/ECOSYSTEM.md。
   */
  ledgerMode: env('KP_LEDGER_MODE', 'external') as 'external' | 'standalone',

  /**
   * 皮肤站（Blessing Skin）与 kokuu-credit 的 OAuth2。
   *
   * 玩家注册与服务端验证（Yggdrasil）都已经由皮肤站实现，平台不重复造。
   * 后台登录同理：kokuu-credit 已经是 OAuth2 授权服务器（Passport + PKCE），
   * 平台作为第二个客户端接入即可，**不需要第二套口令**。
   *
   * 三项都配齐才启用。没配就回落到本地账号（无皮肤站的部署）。
   */
  skin: {
    url: env('KP_SKIN_URL', '').replace(/\/+$/, ''),
    clientId: env('KP_OAUTH_CLIENT_ID', ''),
    clientSecret: env('KP_OAUTH_CLIENT_SECRET', ''),
    /** 平台自身的回调地址。必须与皮肤站客户端里登记的完全一致。 */
    redirectUri: env('KP_OAUTH_REDIRECT_URI', ''),
    /**
     * 皮肤站 `users.permission` 至少多少才允许登入平台。
     * 默认 2 = 皮肤站管理员。低于此值一律拒绝 ——
     * 平台能封人、改权限、下指令，不该让普通玩家进来。
     */
    minPermission: envInt('KP_OAUTH_MIN_PERMISSION', 2),
    /** `permission >= 此值` 映射为 owner（可管平台账号），默认 3 = 超管。 */
    ownerPermission: envInt('KP_OAUTH_OWNER_PERMISSION', 3),
  },

  logLevel: env('KP_LOG_LEVEL', 'info'),
} as const;

/** OAuth2 是否已配置齐。缺任何一项都算没配。 */
export function isOAuthConfigured(): boolean {
  const { url, clientId, clientSecret, redirectUri } = config.skin;
  return Boolean(url && clientId && clientSecret && redirectUri);
}

export function describeConfig(): string {
  return [
    `监听     ${config.host}:${config.port}`,
    `环境     ${config.nodeEnv}`,
    `数据目录 ${config.dataDir}`,
    `数据库   ${config.dbFile}`,
    `前端产物 ${config.webDist}`,
    `积分账本 ${config.ledgerMode === 'external' ? '外部（皮肤站 / kokuu-credit）' : '平台自带（standalone）'}`,
    `后台登录 ${isOAuthConfigured() ? `皮肤站 OAuth2（${config.skin.url}）` : '本地账号（未配置 OAuth2）'}`,
  ].join('\n         ');
}
