/**
 * Fastify 应用装配。
 *
 * 顺序很重要：cookie 解析 → 客户端 IP → 鉴权 → CSRF → 业务路由。
 * CSRF 必须在校验过会话**之后** —— 它比对的是会话里存的 token。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

import { config } from '../config.ts';
import { createLogger } from '../logger.ts';
import { ROLE_PERMISSIONS, type Permission, type Role } from '@kokuu/protocol';
import { hashSecret, newToken, signSession, unsignSession } from '../lib/crypto.ts';
import type { Store } from '../store/index.ts';
import {
  HttpError,
  toHttpError,
  type AppContext,
} from './context.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerNodeRoutes } from './routes/nodes.ts';
import { registerPlayerRoutes } from './routes/players.ts';
import { registerPunishmentRoutes } from './routes/punishments.ts';
import { registerCharacterRoutes } from './routes/characters.ts';
import { registerLuckPermsRoutes } from './routes/luckperms.ts';
import { registerEconomyRoutes } from './routes/economy.ts';
import { registerAuditRoutes } from './routes/audit.ts';
import { registerAccountRoutes } from './routes/accounts.ts';

const log = createLogger('http');

/** 不需要登录的路径。 */
const PUBLIC_PATHS = new Set([
  '/_api/auth/login',
  '/_api/health',
]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function buildApp(store: Store, ctx: AppContext): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    // Fastify 6 会把 `ignoreTrailingSlash` 从顶层移走，这里直接用新位置，
    // 免得每天启动都打一条弃用警告把日志刷满。
    routerOptions: { ignoreTrailingSlash: true },
  });

  app.register(cookie);

  // ── 客户端 IP ─────────────────────────────────────────────
  // 只有显式信任代理时才读 X-Forwarded-For。默认直接监听，
  // 信任它等于让任何人伪造来源 IP，而登录限流和审计都依赖这个值。
  app.addHook('onRequest', async (request) => {
    request.clientIp = request.ip;
  });

  // ── 鉴权 ───────────────────────────────────────────────────
  // 注：不要再想着在这里把 `/api/...` 改写成 `/_api/...`。
  // Fastify 的生命周期是「先路由，后 onRequest」，钩子里改 URL
  // 已经来不及影响匹配结果，只会得到 404。前缀只能是 `/_api`。
  app.addHook('onRequest', async (request, reply) => {
    const url = (request.raw.url ?? '').split('?')[0] ?? '';

    // 静态资源与 SPA 路由不需要鉴权（页面本身会调 /_api/auth/me 判断）
    if (!url.startsWith('/_api')) return;

    if (PUBLIC_PATHS.has(url)) return;

    const signed = request.cookies['kp_session'];
    if (!signed) {
      throw new HttpError('UNAUTHENTICATED', '请先登录');
    }

    const sessionId = unsignSession(signed, config.sessionSecret);
    if (!sessionId) {
      reply.clearCookie('kp_session', { path: '/' });
      throw new HttpError('UNAUTHENTICATED', '会话无效，请重新登录');
    }

    const session = store.findSession(sessionId);
    if (!session) {
      reply.clearCookie('kp_session', { path: '/' });
      throw new HttpError('UNAUTHENTICATED', '会话不存在或已过期');
    }

    if (session.expires_at < Date.now()) {
      store.deleteSession(sessionId);
      reply.clearCookie('kp_session', { path: '/' });
      throw new HttpError('UNAUTHENTICATED', '会话已过期，请重新登录');
    }

    const account = store.findAccountById(session.account_id);
    if (!account || account.disabled === 1) {
      store.deleteSession(sessionId);
      reply.clearCookie('kp_session', { path: '/' });
      throw new HttpError('UNAUTHENTICATED', '账号已被停用');
    }

    // ── CSRF ──
    // 双提交：非安全方法必须带上与会话里一致的 token。
    // 攻击者能让浏览器发出请求，但**读不到** kp_csrf 的值（跨域），
    // 所以伪造不出这个头。
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const header = request.headers['x-csrf-token'];
      if (typeof header !== 'string' || header !== session.csrf) {
        throw new HttpError('FORBIDDEN', 'CSRF 校验失败，请刷新页面后重试');
      }
    }

    request.account = account;
    request.permissions = new Set<Permission>(
      ROLE_PERMISSIONS[account.role as Role] ?? [],
    );
  });

  // ── 错误处理 ───────────────────────────────────────────────
  app.setErrorHandler((error, request, reply) => {
    const httpError = toHttpError(error);

    // 500 级别的错误要把原始堆栈打到服务端日志 —— 响应里不带，
    // 免得把内部结构泄露给前端。
    if (httpError.status >= 500) {
      log.error(`${request.method} ${request.raw.url} → ${httpError.code}`, error);
    } else {
      log.debug(`${request.method} ${request.raw.url} → ${httpError.status} ${httpError.code}`);
    }

    void reply.status(httpError.status).send({
      error: {
        code: httpError.code,
        message: httpError.message,
        data: httpError.data ?? {},
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if ((request.raw.url ?? '').startsWith('/_api')) {
      void reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `接口不存在：${request.method} ${request.raw.url}` },
      });
      return;
    }
    // SPA 回退
    void serveIndex(reply);
  });

  // ── 健康检查 ───────────────────────────────────────────────
  app.get('/_api/health', async () => ({
    ok: true,
    uptimeSeconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
    nodes: ctx.gateway.list().length,
    browserClients: ctx.hub.clientCount,
  }));

  // ── 业务路由 ───────────────────────────────────────────────
  registerAuthRoutes(app, ctx);
  registerNodeRoutes(app, ctx);
  registerPlayerRoutes(app, ctx);
  registerPunishmentRoutes(app, ctx);
  registerCharacterRoutes(app, ctx);
  registerLuckPermsRoutes(app, ctx);
  registerEconomyRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerAccountRoutes(app, ctx);

  // ── 静态前端 ───────────────────────────────────────────────
  registerStatic(app);

  return app;
}

/**
 * 托管前端构建产物。
 *
 * 不引 `@fastify/static`：这里只需要「按扩展名给 MIME + 其余全部回
 * index.html」这两件事，为它多一个依赖不划算。
 */
function registerStatic(app: FastifyInstance): void {
  if (!existsSync(config.webDist)) {
    log.warn(
      `未找到前端产物 ${config.webDist}，仅提供 API。` +
        '开发时请另开 `pnpm dev:web`，生产请先 `pnpm build`。',
    );
    return;
  }

  const root = resolve(config.webDist);
  log.info(`托管前端产物：${root}`);

  app.get('/*', async (request, reply) => {
    const url = (request.raw.url ?? '/').split('?')[0] ?? '/';

    // `/*` 会把未知的 `GET /_api/...` 也吃掉。不挡住的话，
    // 接口路径写错时会返回 200 + index.html，前端拿 HTML 去
    // JSON.parse，报的是「Unexpected token <」这种毫无指向性的错。
    if (url.startsWith('/_api')) {
      void reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `接口不存在：GET ${url}` },
      });
      return;
    }

    const relative = normalize(decodeURIComponent(url)).replace(/^([/\\])+/, '');
    const target = resolve(join(root, relative));

    // 目录穿越防护：解析后的路径必须仍在 root 之内。
    if (target !== root && !target.startsWith(root + sep)) {
      void reply.status(400).send({ error: { code: 'INVALID_PARAMS', message: '非法路径' } });
      return;
    }

    const isFile = Boolean(relative) && existsSync(target) && statSync(target).isFile();
    log.debug(
      `静态：url=${url} relative=${JSON.stringify(relative)} target=${target} 命中文件=${isFile}`,
    );

    if (isFile) {
      const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';

      // 判断是否可长缓存时**必须先转成 URL 风格的分隔符**。
      // `normalize()` 在 Windows 上产出反斜杠（`assets\x.js`），
      // 直接拿 `'assets/'` 去 startsWith 会永远为假 ——
      // 症状是 Windows 上带 hash 的产物全部退化成 no-cache，白丢一层 CDN 缓存。
      const urlPath = relative.split(sep).join('/');
      const immutable = urlPath.startsWith('assets/');

      void reply
        .header('content-type', type)
        // 带 hash 的产物可以长缓存，index.html 绝对不行 ——
        // 缓存了 index.html 等于发布新版本后用户永远拿不到。
        .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
        .send(readFileSync(target));
      return;
    }

    await serveIndex(reply);
  });
}

async function serveIndex(reply: import('fastify').FastifyReply): Promise<void> {
  const indexFile = join(resolve(config.webDist), 'index.html');
  if (!existsSync(indexFile)) {
    void reply
      .status(503)
      .type('text/plain; charset=utf-8')
      .send(
        '前端尚未构建。\n开发：pnpm dev:web（默认 http://127.0.0.1:5174）\n生产：pnpm build',
      );
    return;
  }
  void reply
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-cache')
    .send(readFileSync(indexFile));
}

/**
 * 首次启动播种管理员。
 *
 * 没设 `KP_ADMIN_PASSWORD` 时生成一个随机口令并打到日志 ——
 * 比默认口令安全得多（默认口令在公网上会被扫到），
 * 也比「拒绝启动」友好（否则用户第一次跑不起来）。
 */
export function bootstrapAdmin(store: Store): void {
  if (store.countAccounts() > 0) return;

  const username = config.bootstrapAdmin;
  const password = config.bootstrapPassword || newToken(12);

  store.createAccount({
    username,
    passwordHash: hashSecret(password),
    role: 'owner',
  });

  if (config.bootstrapPassword) {
    log.info(`已创建初始管理员账号：${username}（口令来自 KP_ADMIN_PASSWORD）`);
  } else {
    // 用醒目的方式打出来，因为它只出现这一次。
    log.warn(
      '\n' +
        '  ╔══════════════════════════════════════════════════════════╗\n' +
        '  ║  已生成初始管理员账号，此口令只显示这一次                 ║\n' +
        `  ║    用户名  ${username.padEnd(42)}║\n` +
        `  ║    口令    ${password.padEnd(42)}║\n` +
        '  ║  登录后请立刻修改，或设置 KP_ADMIN_PASSWORD 后重建数据库  ║\n' +
        '  ╚══════════════════════════════════════════════════════════╝',
    );
  }
}

export { signSession, newToken };
