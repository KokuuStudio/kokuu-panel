// 静态托管集成检查（.tmp 已在 .gitignore 里）
const base = process.argv[2] ?? 'http://127.0.0.1:8787';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function probe(path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  const type = res.headers.get('content-type') ?? '';
  const cache = res.headers.get('cache-control') ?? '';
  const body = await res.text();
  return { status: res.status, type, cache, body, len: body.length };
}

console.log(`\n\x1b[1m静态托管检查\x1b[0m  ${base}\n`);

// 1. 首页
const index = await probe('/');
check(
  'GET / 返回 HTML',
  index.status === 200 && index.type.includes('text/html'),
  `HTTP ${index.status}, ${index.type.split(';')[0]}, ${index.len} 字节`,
);
check(
  'index.html 不可长缓存（否则发版后用户永远拿不到新版）',
  index.cache.includes('no-cache') || index.cache.includes('no-store'),
  index.cache || '(无 cache-control)',
);

// 2. 抽一个带 hash 的产物
const assetMatch = index.body.match(/\/assets\/[A-Za-z0-9_.-]+\.js/);
if (assetMatch) {
  const asset = await probe(assetMatch[0]);
  check(
    `GET ${assetMatch[0].slice(0, 42)}… 返回 JS`,
    asset.status === 200 && asset.type.includes('javascript'),
    `HTTP ${asset.status}, ${(asset.len / 1024).toFixed(1)} KB`,
  );
  check(
    '带 hash 的产物可长缓存',
    asset.cache.includes('immutable') || asset.cache.includes('max-age=31536000'),
    asset.cache,
  );
} else {
  check('index.html 里能找到带 hash 的产物引用', false, '没匹配到 /assets/*.js');
}

// 3. SPA 回退：前端路由必须回 index.html
for (const route of ['/players', '/nodes/survival-01', '/luckperms']) {
  const spa = await probe(route);
  check(
    `SPA 回退 ${route} → index.html`,
    spa.status === 200 && spa.type.includes('text/html') && spa.body.includes('<div id="app"'),
    `HTTP ${spa.status}, ${spa.len} 字节`,
  );
}

// 4. 关键回归：未知的 API 路径必须是 JSON 404，不能掉进 SPA 回退。
//
// 必须先登录：未认证访问 `/_api/*` 会（正确地）先被 401 拦下 ——
// 那是有意为之，不向未认证的调用方泄露「哪些路径存在」。
//
// 口令只能由环境变量提供，这里**刻意不留兜底值**：
// 一个默认口令就等于把某个真实实例的凭据写进了公开仓库。
const verifyUser = process.env.KP_VERIFY_USER ?? 'admin';
const verifyPassword = process.env.KP_VERIFY_PASSWORD;
if (!verifyPassword) {
  console.error(
    '\x1b[31m缺少 KP_VERIFY_PASSWORD\x1b[0m\n'
      + '  本脚本需要先登录才能校验「已认证」分支的 API 行为。\n'
      + '  口令从环境变量读取，不在代码里留默认值。\n'
      + '  用法：KP_VERIFY_PASSWORD=<口令> node tools/verify-static.mjs [baseUrl]\n'
      + '  提示：服务端首次启动若未设 KP_ADMIN_PASSWORD，会随机生成一个并打进启动日志。',
  );
  process.exit(2);
}

const jar = new Map();
const login = await fetch(`${base}/_api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: verifyUser, password: verifyPassword }),
});
for (const c of login.headers.getSetCookie?.() ?? []) {
  const [pair] = c.split(';');
  const i = pair.indexOf('=');
  jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
}

const authed = await fetch(`${base}/_api/nodes/zzz/nonexistent`, {
  headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
});
const authedType = authed.headers.get('content-type') ?? '';
const authedBody = await authed.text();
check(
  '未知 API 路径（已登录）返回 JSON 404 而不是 HTML',
  authed.status === 404 && authedType.includes('application/json'),
  `HTTP ${authed.status}, ${authedType.split(';')[0]}`,
);
let parsed = null;
try { parsed = JSON.parse(authedBody); } catch { /* */ }
check(
  'JSON 404 带 error.code',
  parsed?.error?.code === 'NOT_FOUND',
  parsed ? `code=${parsed.error.code}` : '不是合法 JSON',
);

// 未认证时应当是 401，而不是 404 —— 不泄露路径是否存在
const anon = await fetch(`${base}/_api/nodes/zzz/nonexistent`);
check(
  '未认证访问未知 API 路径 → 401（不泄露路径是否存在）',
  anon.status === 401,
  `HTTP ${anon.status}`,
);

// 5. 目录穿越
const traverse = await probe('/../../../etc/passwd');
const traverseOk =
  traverse.status >= 400 ||
  traverse.body.includes('<div id="app"') ||   // 被规范化后落到 SPA
  !traverse.body.includes('root:');
check(
  '目录穿越拿不到 /etc/passwd',
  traverseOk,
  `HTTP ${traverse.status}${traverse.body.includes('root:') ? ' ⚠️ 泄露了文件内容！' : ''}`,
);

const failed = results.filter((r) => !r.ok);
console.log(`\n\x1b[1m汇总\x1b[0m  ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
  process.exit(1);
}
console.log('\x1b[32m全部通过\x1b[0m');
