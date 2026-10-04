/**
 * 极简 .env 读取器（避免为一个功能引第三方 dotenv）。
 *
 * 优先级：**真实环境变量 > .env 文件**。
 * 反过来会导致 Docker / systemd 注入的值被文件里的旧值盖掉，
 * 表现为「改了环境变量没生效」，是这类部署最常见的坑。
 *
 * 文件不存在不算错 —— 纯 Docker 部署可以一个 .env 都不给，
 * 全部用环境变量。缺 ADMIN_TOKEN 由 auth.js 负责报错。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function readEnvFile() {
  const file = path.join(here, '..', '.env');
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export function loadEnv() {
  // process.env 里的同名键直接覆盖文件值
  return { ...readEnvFile(), ...process.env };
}
