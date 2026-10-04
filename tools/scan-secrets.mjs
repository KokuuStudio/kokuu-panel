#!/usr/bin/env node
// 提交前的敏感内容扫描。
//
// 为什么需要它：`.gitignore` 只能挡住**路径**，挡不住「把口令写进某个会被提交的
// 源文件里」。本仓库就出过一次 —— `tools/verify-static.mjs` 里留了个默认口令
// 兜底值，等于把某个真实实例的凭据写进了公开仓库。
//
// 为什么不用 `git grep`：git 没装或不在 PATH 时它只会失败，而失败返回空结果，
// 很容易被误读成「没找到问题」（本仓库的核查过程中就真的这样误报过一次）。
// 本脚本自己读文件，并把「扫过了」和「跳过了」分开报，不给模棱两可的结论。
//
// 用法：
//   node tools/scan-secrets.mjs            # 扫描仓库根目录
//   node tools/scan-secrets.mjs <目录>
// 退出码：0 = 干净，1 = 发现可疑内容，2 = 用法错误。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[2] ?? repoRoot;

// 与 .gitignore 保持一致。这里**重复维护**是刻意的：扫描器若直接去解析
// .gitignore，那 .gitignore 写错时扫描器会跟着一起瞎。两边都写、偶尔对一遍，
// 比单点依赖可靠。
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  '.tmp',
  '.pnpm-store',
  'data',
  '.git',
  'target',
  '.vscode',
  '.idea',
]);

const IGNORED_FILE_PATTERNS = [
  /\.log$/i,
  /\.sqlite(-journal|-wal|-shm)?$/i,
  /^session\.key$/,
  /^\.env$/,
  /^\.env\.local$/,
  /\.iml$/,
  /^\.DS_Store$/,
];

const BINARY_EXT =
  /\.(jar|png|jpe?g|gif|ico|woff2?|ttf|eot|zip|gz|pdf|class|so|dll|exe|node|wasm)$/i;

/**
 * 自我描述为「假」的标记：命中处只要包含其中之一就跳过。
 * 一个叫 `definitely-wrong-password` 的字符串是测试夹具，不是凭据。
 *
 * ⚠ 刻意**不包含** `test`：本仓库真出过问题的那个默认口令就叫
 * `test-admin-pass-123`。把 `test` 放进来会让扫描器对真正的那类问题失明 ——
 * 这是整个工具最需要小心的一处。
 */
const FAKE_MARKERS =
  /wrong|fake|dummy|invalid|nonexistent|not-a-real|placeholder|changeme|hunter2|example\.com/i;

/** 与具体值无关的结构性模式，直接按行报。 */
const STRUCTURAL_PATTERNS = [
  ['PEM 私钥', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['RSA 私钥的 base64 头', /LS0tLS1CRUdJTiB[A-Za-z0-9+/]{40,}/],
  ['Yggdrasil 私钥字段', /ygg[_-]?private[_-]?key/i],
  ['Bearer 长令牌', /Bearer\s+[A-Za-z0-9_\-.]{30,}/],
  [
    '明文凭据类环境变量',
    /^\s*(?:export\s+)?[A-Z_][A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*\S+/m,
  ],
];

const CREDENTIAL_KEY = '(?:secret|token|api[_-]?key|password|passwd|pwd|passphrase|private[_-]?key)';

/**
 * 判断一行是不是「硬编码的凭据字面量」。
 *
 * 为什么不用一条正则了事：一条 `键名\s*[:=]\s*引号…引号` 会同时命中
 *   - 真的凭据：`password: process.env.X ?? <兜底字面量>`
 *   - Vue 属性绑定：`:secret="secretValue"`
 * 而把长度阈值抬高到能排除后者的程度（≥20），又会漏掉前者（19 个字符的兜底值）。
 * 所以拆成「键名 + 值的形态」两步判断。
 *
 * ⚠ 上面的示例刻意不写完整的凭据字面量 —— 写了的话本文件会被自己报出来，
 * 干净仓库就永远 exit=1，工具直接废掉。
 */
function hardcodedCredential(line) {
  // 键名前面不能是 : @ - 或单词字符 —— 排除 `:secret="…"`（Vue 绑定）
  // 和标记语言属性；`.` 允许（`obj.secret = …`）。
  const keyRe = new RegExp(`(?<![:@\\w-])(${CREDENTIAL_KEY})\\s*[:=]`, 'i');
  const km = keyRe.exec(line);
  if (!km) return null;

  const key = km[1];
  const rest = line.slice(km.index + km[0].length);

  // 两种写法都要认：
  //   1) 键后面直接跟字面量      password: 'xxx'
  //   2) 键后面是表达式再兜底     password: process.env.X ?? 'xxx'
  //                              ↑ 本仓库真出过问题的就是这种，只在第 1 种上匹配会漏掉它
  const direct = /^\s*(["'])([^"']+)\1/.exec(rest);
  const fallback = /(?:\?\?|\|\||\?\?=)\s*(["'])([^"']+)\1/.exec(rest);
  const hit = direct ?? fallback;
  if (!hit) return null;

  const value = hit[2];

  // 值的形态判断：真凭据通常含分隔符或数字，或者够长且大小写混合。
  // 纯 camelCase 标识符（secretValue / passwordField）是变量名，放过。
  const hasSeparatorOrDigit = /[-_0-9]/.test(value);
  const looksRandom = value.length >= 20 && /[A-Z]/.test(value) && /[a-z]/.test(value);
  if (!hasSeparatorOrDigit && !looksRandom) return null;

  // 同一字符重复（xxxx）或明显是占位符（*** / ...）的，放过
  if (/^(.)\1+$/.test(value)) return null;
  if (/^[x*.\-_\s]+$/i.test(value)) return null;

  return { key, value };
}

const findings = [];
let scanned = 0;
const skippedDirs = [];
let skippedFiles = 0;
let skippedBinary = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join('/');

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        skippedDirs.push(rel);
        continue;
      }
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;

    if (IGNORED_FILE_PATTERNS.some((re) => re.test(entry.name))) {
      skippedFiles++;
      continue;
    }
    if (BINARY_EXT.test(entry.name)) {
      skippedBinary++;
      continue;
    }

    let text;
    try {
      if (statSync(full).size > 4 * 1024 * 1024) {
        skippedBinary++;
        continue;
      }
      text = readFileSync(full, 'utf8');
    } catch {
      skippedBinary++;
      continue;
    }
    if (text.includes('\u0000')) {
      skippedBinary++;
      continue;
    }

    scanned++;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (FAKE_MARKERS.test(line)) return;

      for (const [label, re] of STRUCTURAL_PATTERNS) {
        if (re.test(line)) {
          findings.push({ rel, line: i + 1, label, excerpt: line.trim().slice(0, 140) });
        }
      }

      const cred = hardcodedCredential(line);
      if (cred) {
        findings.push({
          rel,
          line: i + 1,
          label: `硬编码凭据（${cred.key}）`,
          excerpt: line.trim().slice(0, 140),
        });
      }
    });
  }
}

walk(root);

console.log(`扫描目录：${root}`);
console.log(`已扫描文本文件：${scanned}`);
console.log(
  `跳过：目录 ${skippedDirs.length} 个、按规则忽略的文件 ${skippedFiles} 个、二进制 ${skippedBinary} 个`,
);
console.log('');

if (skippedDirs.length > 0) {
  console.log('被跳过的目录（确认这些确实不该提交）：');
  for (const d of skippedDirs) console.log(`  - ${d}`);
  console.log('');
}

if (findings.length === 0) {
  console.log('结果：未发现敏感内容。');
  process.exit(0);
}

console.log(`结果：发现 ${findings.length} 处可疑内容 ——`);
for (const f of findings) {
  console.log(`  [${f.label}] ${f.rel}:${f.line}`);
  console.log(`      ${f.excerpt}`);
}
console.log('');
console.log('如果某项是**故意的测试夹具**，请把它改成一眼可辨的名字');
console.log('（例如 definitely-wrong-password），而不是放宽上面的规则。');
process.exit(1);
