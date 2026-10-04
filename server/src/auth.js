/**
 * 鉴权：管理端只认一个共享口令，放在 x-admin-token 头里。
 *
 * 口令比较用 timingSafeEqual，避免逐字节比较泄漏信息。
 * 口令本身不写进代码，只从 server/.env 读。
 */
import crypto from 'node:crypto';
import { loadEnv } from './env.js';

const env = loadEnv();
const EXPECT = env.ADMIN_TOKEN || '';

if (!EXPECT) {
  console.error('ADMIN_TOKEN 未配置，拒绝启动。');
  process.exit(1);
}
const EXPECT_BUF = Buffer.from(EXPECT);

export function auth(req, res, next) {
  const got = String(req.get('x-admin-token') || '');
  const ok =
    got.length === EXPECT_BUF.length &&
    crypto.timingSafeEqual(Buffer.from(got), EXPECT_BUF);
  if (!ok) return res.status(401).json({ error: '口令无效' });
  next();
}
