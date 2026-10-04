#!/usr/bin/env node
// 断言插件产物**能在 Java 8 上加载**。
//
// 注意判据是 major <= 52 而不是 == 52：字节码兼容是单向的，Java 7 的类
// 在 Java 8 上跑得很好。agent 的 jar 里就有一大批 major=51 —— 那是 shade
// 进去的 Java-WebSocket（1.5.7 编译到 Java 7）。写成「必须等于 52」会把
// 这些正常的东西报成错误，是错的。
//
// 真正要防的是**超过** 52：那才会让 1.12.2 服务端直接
// UnsupportedClassVersionError。
//
// 为什么值得单独有个检查：docs/ARCHITECTURE.md §4.1 把「字节码必须是 Java 8」
// 定成了硬约束，但这件事一直只靠「记得别改 pom」来保证，而 JDK 25 编译时的
// "source value 8 is obsolete" 警告恰恰在**劝人改**。有人在 CI 里被这个警告
// 说服、把 release 调成 17，产物就会在 1.12.2 上直接加载失败 ——
// 而那台服务端上根本跑不了这套测试。所以把它变成机器检查。
//
// 用法：
//   node tools/check-java8-bytecode.mjs                       # 检查默认的两个产物
//   node tools/check-java8-bytecode.mjs <jar|class> [...]     # 检查指定文件
// 退出码：0 = 全部合规，1 = 有不合规的，2 = 用法/IO 错误。

import { readFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const JAVA8_MAJOR = 52;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGETS = [
  join(repoRoot, 'agent', 'target', 'kokuu-agent-1.0.0.jar'),
  join(repoRoot, 'legacy-fix', 'target', 'kokuu-legacy-fix-1.0.0.jar'),
];

// ── 最小 ZIP 读取（只为了取 .class 条目，不想为此引依赖）──────────────

function readCentralDirectory(buf) {
  let eocd = -1;
  // EOCD 签名 0x06054b50，注释最长 65535 字节，所以只往前找这么多
  const floor = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP：找不到 EOCD');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error(`中央目录第 ${i} 条签名不对`);
    }
    const nameLen = buf.readUInt16LE(off + 28);
    entries.push({
      name: buf.toString('utf8', off + 46, off + 46 + nameLen),
      method: buf.readUInt16LE(off + 10),
      compSize: buf.readUInt32LE(off + 20),
      localOff: buf.readUInt32LE(off + 42),
      extraLen: buf.readUInt16LE(off + 30),
      commentLen: buf.readUInt16LE(off + 32),
    });
    off += 46 + nameLen + entries[entries.length - 1].extraLen + entries[entries.length - 1].commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  const lh = entry.localOff;
  if (buf.readUInt32LE(lh) !== 0x04034b50) {
    throw new Error(`本地头签名不对：${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw; // stored
  if (entry.method === 8) return inflateRawSync(raw); // deflate
  throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`);
}

/** 从一个 .class 字节流读 major version。结构：magic(4) minor(2) major(2)。 */
function classMajorVersion(data) {
  if (data.length < 8 || data.readUInt32BE(0) !== 0xcafebabe) return null;
  return data.readUInt16BE(6);
}

// ── 检查 ──────────────────────────────────────────────────────────────

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_TARGETS;

console.log(`断言 Java 8 字节码（major version ${JAVA8_MAJOR}）`);
console.log('');

let failed = false;
let checkedFiles = 0;
let checkedClasses = 0;

for (const target of targets) {
  const label = basename(target);
  if (!existsSync(target)) {
    console.log(`  ✗ ${label} —— 文件不存在（先跑 mvn package）`);
    failed = true;
    continue;
  }

  const buf = readFileSync(target);
  const tooNew = [];
  let total = 0;
  let maxMajor = 0;

  // 单个 .class 文件（没打成 jar 时也能直接查）
  if (target.toLowerCase().endsWith('.class')) {
    const major = classMajorVersion(buf);
    total = 1;
    if (major !== null) maxMajor = major;
    if (major !== null && major > JAVA8_MAJOR) tooNew.push({ name: label, major });
  } else {
    for (const entry of readCentralDirectory(buf)) {
      if (!entry.name.endsWith('.class')) continue;
      if (entry.name === 'module-info.class') continue;
      const major = classMajorVersion(readEntry(buf, entry));
      if (major === null) continue;
      total++;
      if (major > maxMajor) maxMajor = major;
      if (major > JAVA8_MAJOR) tooNew.push({ name: entry.name, major });
    }
  }

  checkedFiles++;
  checkedClasses += total;

  if (tooNew.length === 0) {
    // 报出最高版本，让人一眼看到离红线还有多远
    console.log(
      `  ✓ ${label} —— ${total} 个类，最高 major ${maxMajor}（Java ${maxMajor - 44}），不超过 ${JAVA8_MAJOR}`,
    );
  } else {
    failed = true;
    console.log(`  ✗ ${label} —— ${total} 个类里有 ${tooNew.length} 个超过 major ${JAVA8_MAJOR}`);
    for (const b of tooNew.slice(0, 10)) {
      console.log(`      ${b.name}  major=${b.major} → Java ${b.major - 44}`);
    }
    if (tooNew.length > 10) console.log(`      … 其余 ${tooNew.length - 10} 个略`);
  }
}

console.log('');
console.log(`检查了 ${checkedFiles} 个产物、${checkedClasses} 个类。`);

if (failed) {
  console.log('');
  console.log('有类超过 Java 8 字节码。1.12.2 服务端只能跑 Java 8，加载会直接');
  console.log('UnsupportedClassVersionError。检查 pom 里的 maven.compiler.release');
  console.log('是不是被改成了 17 —— JDK 的 "source value 8 is obsolete" 警告是在劝人改，');
  console.log('但那个警告应该用 -Xlint:-options 消掉，**不是**调高目标版本。');
  process.exit(1);
}

console.log('全部合规：产物能在 Java 8 上加载。');
