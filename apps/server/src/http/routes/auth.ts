/**
 * 后台账号登录 / 登出 / 会话查询。
 *
 * 两个刻意的设计：
 * 1. 登录失败**不区分**「用户不存在」与「密码错误」—— 区分了等于给出
 *    一个枚举有效用户名的接口。
 * 2. 登录**必须**先校验密码再决定是否清计数，且失败计数按 IP 累计。
 */

import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { config, isOAuthConfigured } from '../../config.ts';
import { log } from '../../logger.ts';
import { newToken, signSession, verifySecret } from '../../lib/crypto.ts';
import type { Role } from '@kokuu/protocol';
import {
  HttpError,
  accountPayload,
  audited,
  currentAccount,
  type AppContext,
} from '../context.ts';

const LoginBody = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(256),
  })
  .strict();

/** scrypt 校验一次的耗时用作「用户不存在」时的填充，避免时序泄露。 */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/_api/auth/login', async (request, reply) => {
    const parsed = LoginBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw HttpError.badRequest('请填写用户名与密码');
    }

    const ip = request.clientIp ?? 'unknown';
    const failures = ctx.store.countRecentLoginFailures(ip, config.loginWindowMs);
    if (failures >= config.loginMaxAttempts) {
      const minutes = Math.ceil(config.loginWindowMs / 60000);
      throw new HttpError(
        'RATE_LIMITED',
        `登录失败次数过多，请在 ${minutes} 分钟后重试`,
      );
    }

    const account = ctx.store.findAccountByUsername(parsed.data.username);

    // 用户不存在时也跑一次 scrypt。否则「秒回失败」与「算了一会儿才失败」
    // 的耗时差异就能被用来枚举用户名。
    const ok = account
      ? verifySecret(parsed.data.password, account.password_hash)
      : (verifySecret(parsed.data.password, DUMMY_HASH), false);

    if (!account || !ok || account.disabled === 1) {
      ctx.store.recordLoginAttempt(ip, false);
      throw new HttpError('UNAUTHENTICATED', '用户名或口令不正确');
    }

    ctx.store.recordLoginAttempt(ip, true);
    ctx.store.touchLogin(account.id, ip);
    // 登录成功时清掉该账号的旧会话：口令泄露后改密码应当能踢掉旧设备。
    ctx.store.deleteAccountSessions(account.id);

    const sessionId = newToken(24);
    const csrf = newToken(24);
    const expiresAt = Date.now() + config.sessionTtlMs;

    ctx.store.createSession({
      id: sessionId,
      accountId: account.id,
      csrf,
      expiresAt,
      ip,
      userAgent: String(request.headers['user-agent'] ?? ''),
    });

    const secure = config.isProduction;
    reply.setCookie('kp_session', signSession(sessionId, config.sessionSecret), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    });
    // CSRF token 必须**能被 JS 读到**（它不是机密，是「证明请求来自
    // 本站页面」的凭据），所以不设 httpOnly。
    reply.setCookie('kp_csrf', csrf, {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      secure,
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    });

    return { account: accountPayload(account) };
  });

  app.post('/_api/auth/logout', async (request, reply) => {
    const account = currentAccount(request);

    // 登出本身不算敏感操作，但记一条有助于排查「谁在什么时候退的」。
    await audited(ctx, request, { action: 'auth.logout', targetType: 'account', targetId: String(account.id) }, () => {
      const signed = request.cookies['kp_session'];
      if (signed) {
        const raw = signed.slice(0, signed.lastIndexOf('.'));
        ctx.store.deleteSession(raw);
      }
    });

    reply.clearCookie('kp_session', { path: '/' });
    reply.clearCookie('kp_csrf', { path: '/' });
    return reply.status(204).send();
  });

  app.get('/_api/auth/me', async (request) => {
    const account = currentAccount(request);
    return { account: accountPayload(account) };
  });

  // ── 皮肤站 OAuth2 登录 ─────────────────────────────────────
  //
  // 玩家注册与服务端验证（Yggdrasil）都已由皮肤站实现，平台不重复造。
  // 后台登录同理：kokuu-credit 已经是 OAuth2 授权服务器
  // （Passport + 强制 PKCE S256），平台作为第二个客户端接入即可，
  // **不需要第二套口令**。
  //
  // 未配置时这些接口回 501，登录页据此只显示本地账号表单。

  /** 登录页用它决定「显示皮肤站登录按钮还是本地表单」。公开接口。 */
  app.get('/_api/auth/providers', async () => ({
    oauth: {
      enabled: isOAuthConfigured(),
      skinUrl: config.skin.url || null,
      startUrl: '/_api/auth/oauth/start',
      minPermission: config.skin.minPermission,
    },
    local: { enabled: true },
  }));

  app.get('/_api/auth/oauth/start', async (request, reply) => {
    if (!isOAuthConfigured()) {
      throw new HttpError(
        'NOT_IMPLEMENTED',
        '未配置皮肤站 OAuth2（KP_SKIN_URL / KP_OAUTH_CLIENT_ID / ' +
          'KP_OAUTH_CLIENT_SECRET / KP_OAUTH_REDIRECT_URI），' +
          '当前只能用本地账号登录。',
      );
    }

    // PKCE：verifier 留在服务端，challenge 发给授权服务器。
    // 授权码被截获也无法换 token（没有 verifier）。
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    const state = randomBytes(24).toString('base64url');
    const query = request.query as Record<string, unknown>;
    // 只接受站内相对路径，避免开放重定向。
    const raw = typeof query.redirect === 'string' ? query.redirect : '/';
    const redirectTo = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';

    ctx.store.createOAuthState({
      state,
      codeVerifier,
      redirectTo,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const authorize = new URL(`${config.skin.url}/oauth/authorize`);
    authorize.searchParams.set('client_id', config.skin.clientId);
    authorize.searchParams.set('redirect_uri', config.skin.redirectUri);
    authorize.searchParams.set('response_type', 'code');
    // 最小权限：平台只需要读身份，不需要读写皮肤站的任何资源。
    authorize.searchParams.set('scope', 'User.Read');
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', codeChallenge);
    authorize.searchParams.set('code_challenge_method', 'S256');

    return reply.redirect(authorize.toString());
  });

  app.get('/_api/auth/oauth/callback', async (request, reply) => {
    if (!isOAuthConfigured()) {
      throw new HttpError('NOT_IMPLEMENTED', '未配置皮肤站 OAuth2');
    }

    const query = request.query as Record<string, unknown>;
    const fail = (reason: string) =>
      reply.redirect(`/login?oauth_error=${encodeURIComponent(reason)}`);

    if (typeof query.error === 'string') {
      // 用户在授权页点了「拒绝」，或授权服务器出错。这不是平台的问题。
      return fail(`皮肤站返回错误：${query.error}`);
    }

    const code = typeof query.code === 'string' ? query.code : '';
    const state = typeof query.state === 'string' ? query.state : '';
    if (!code || !state) return fail('回调缺少 code 或 state');

    // 一次性消费。重复回调 / state 被猜到都不会有第二次机会。
    const stored = ctx.store.consumeOAuthState(state);
    if (!stored) return fail('state 无效或已过期，请重新登录');

    // ── 换 token ──
    let tokenPayload: { access_token?: string };
    try {
      const tokenRes = await fetch(`${config.skin.url}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: config.skin.clientId,
          client_secret: config.skin.clientSecret,
          redirect_uri: config.skin.redirectUri,
          code,
          code_verifier: stored.codeVerifier,
        }),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => '');
        log.warn(`OAuth2 换取 token 失败：HTTP ${tokenRes.status} ${text.slice(0, 200)}`);
        return fail(`换取令牌失败（HTTP ${tokenRes.status}）`);
      }
      tokenPayload = (await tokenRes.json()) as { access_token?: string };
    } catch (error) {
      log.warn('OAuth2 换取 token 时网络错误', error);
      return fail('无法连接皮肤站');
    }

    const accessToken = tokenPayload.access_token;
    if (!accessToken) return fail('皮肤站未返回 access_token');

    // ── 取 userinfo ──
    // 端点由 kokuu-credit 插件提供，字段名以它的 README 为准：
    //   { sub, user: { uid, nickname, email, verified, score, permission, ... } }
    let info: { sub?: string; user?: Record<string, unknown> };
    try {
      const infoRes = await fetch(`${config.skin.url}/plugin/kokuu-credit/api/userinfo`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      });
      if (!infoRes.ok) {
        log.warn(`OAuth2 取 userinfo 失败：HTTP ${infoRes.status}`);
        return fail(`读取账号信息失败（HTTP ${infoRes.status}）`);
      }
      info = (await infoRes.json()) as typeof info;
    } catch (error) {
      log.warn('OAuth2 取 userinfo 时网络错误', error);
      return fail('无法读取账号信息');
    }

    const skinUid = Number(info.user?.uid ?? info.sub);
    if (!Number.isInteger(skinUid) || skinUid <= 0) {
      return fail('皮肤站返回的账号 ID 不合法');
    }

    const permission = Number(info.user?.permission ?? 0);
    if (!Number.isFinite(permission) || permission < config.skin.minPermission) {
      // 平台能封人、改权限、发指令。普通玩家不该进来。
      log.warn(
        `拒绝 OAuth 登录：skin uid=${skinUid} permission=${permission} ` +
          `低于门槛 ${config.skin.minPermission}`,
      );
      return fail(
        `该皮肤站账号的权限不足（需要 permission ≥ ${config.skin.minPermission}）`,
      );
    }

    // 角色每次登录都按皮肤站权限重算 —— 在皮肤站降权后平台立刻跟着降，
    // 不需要两边各维护一次，也不会出现「皮肤站已撤权但平台还是管理员」。
    const role: Role = permission >= config.skin.ownerPermission ? 'owner' : 'admin';
    const nickname =
      typeof info.user?.nickname === 'string' && info.user.nickname
        ? info.user.nickname
        : `skin_${skinUid}`;

    const account = ctx.store.upsertOAuthAccount({ skinUid, nickname, role });

    if (account.disabled === 1) {
      return fail('该账号已在平台侧被停用');
    }

    const ip = request.clientIp ?? 'unknown';
    ctx.store.touchLogin(account.id, ip);
    ctx.store.deleteAccountSessions(account.id);

    const sessionId = newToken(24);
    const csrf = newToken(24);
    const expiresAt = Date.now() + config.sessionTtlMs;
    ctx.store.createSession({
      id: sessionId,
      accountId: account.id,
      csrf,
      expiresAt,
      ip,
      userAgent: String(request.headers['user-agent'] ?? ''),
    });

    const secure = config.isProduction;
    const maxAge = Math.floor(config.sessionTtlMs / 1000);
    reply.setCookie('kp_session', signSession(sessionId, config.sessionSecret), {
      path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge,
    });
    reply.setCookie('kp_csrf', csrf, {
      path: '/', httpOnly: false, sameSite: 'lax', secure, maxAge,
    });

    ctx.store.audit({
      actor: account.username,
      actorIp: ip,
      action: 'auth.oauth_login',
      targetType: 'account',
      targetId: String(account.id),
      params: { skinUid, permission, role },
      ok: true,
    });

    log.info(
      `皮肤站登录成功：${nickname}（skin uid=${skinUid}, permission=${permission} → 角色 ${role}）`,
    );

    return reply.redirect(stored.redirectTo);
  });
}
