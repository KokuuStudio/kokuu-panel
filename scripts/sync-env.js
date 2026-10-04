#!/usr/bin/env node
/**
 * 从拉下来的服务器 .env 里抽出 DB_* 五项，写进 server/.env。
 * 只在本地跑；server/.env 已在 .gitignore 中。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, '.env.remote'), 'utf8');
const want = ['DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD'];
const found = {};

for (const line of src.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  if (want.includes(m[1])) found[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const missing = want.filter((k) => !found[k]);
if (missing.length) {
  console.error('缺少字段: ' + missing.join(', '));
  process.exit(1);
}

const out = [
  '# 由 scripts/sync-env.js 生成，勿手改。源: 服务器 /var/www/kokuu-auth/.env',
  '#',
  '# DB_HOST/DB_PORT 指的是本机这一侧：127.0.0.1:13306 是 ops/tunnel.sh',
  '# 开的 SSH 隧道本地端口。服务器真正的 3306 只在隧道另一端出现。',
  'DB_HOST=127.0.0.1',
  'DB_PORT=' + (process.env.LOCAL_PORT || '13306'),
  'DB_DATABASE=' + found.DB_DATABASE,
  'DB_USERNAME=' + found.DB_USERNAME,
  'DB_PASSWORD=' + found.DB_PASSWORD,
  '',
  '# 管理端登录口令（自己设，不要复用皮肤站密码）',
  'ADMIN_TOKEN=' + (process.env.ADMIN_TOKEN || fs.readFileSync(path.join(root, 'ops', 'token.txt'), 'utf8').trim()),
  '',
].join('\n');

const dest = path.join(root, 'server', '.env');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log('OK -> server/.env  (' + found.DB_DATABASE + ')');
