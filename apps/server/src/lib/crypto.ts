/**
 * 口令与密钥处理。
 *
 * 密码和节点密钥都用 `scrypt`：它内存硬（memory-hard），
 * 对 GPU 暴力破解的抵抗远好于 PBKDF2，而 bcrypt 在 Node 里
 * 需要原生模块（node-gyp），与「零原生依赖」的目标冲突。
 */

import {
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SCRYPT_KEYLEN = 64;
/**
 * scrypt 参数。
 * N=2^15 时单次约 100ms / 32MB —— 登录接口可以接受，
 * 而暴力破解的代价被放大到实用门槛之上。
 * maxmem 必须显式抬高：Node 默认 32MB 会直接让 N=2^15 报错。
 */
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;

const HASH_PREFIX = 'scrypt';

/** 生成 `scrypt$N$r$p$salt$hash` 格式的字符串。 */
export function hashSecret(plain: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(plain, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return [
    HASH_PREFIX,
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * 校验密钥。用 `timingSafeEqual` 而非 `===`：
 * 字符串比较会在第一个不同的字节处提前返回，把哈希逐字节泄露出去。
 */
export function verifySecret(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return false;

  const N = Number.parseInt(parts[1]!, 10);
  const r = Number.parseInt(parts[2]!, 10);
  const p = Number.parseInt(parts[3]!, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(plain, salt, SCRYPT_KEYLEN, { N, r, p, maxmem: 128 * 1024 * 1024 });
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

/**
 * 短 ID，用于节点标识之外的地方。
 * 不用 `Math.random()`：可预测的 ID 在幂等键场景下会撞。
 */
export function shortId(): string {
  return randomBytes(8).toString('hex');
}

/** 生成给 Agent 用的「节点密钥」：`nodeId` 本身不进密钥，避免格式耦合。 */
export function newNodeSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** 会话 cookie 值的签名：`sessionId.hmac`。 */
export function signSession(sessionId: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(sessionId).digest('base64url');
  return `${sessionId}.${mac}`;
}

/** 校验签名并取出 sessionId。签名不合法返回 null。 */
export function unsignSession(signed: string, secret: string): string | null {
  const idx = signed.lastIndexOf('.');
  if (idx <= 0) return null;
  const sessionId = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);

  const expected = createHmac('sha256', secret).update(sessionId).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? sessionId : null;
}
