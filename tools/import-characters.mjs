#!/usr/bin/env node
/**
 * 导入「皮肤站角色目录」。
 *
 * ## 为什么需要这个工具
 *
 * 本站 Yggdrasil 用 **UUID v3**（`md5("OfflinePlayer:" + 角色名)`），
 * 所以「角色名」与「UUID」是等价标识 —— 玩家改个名，两个一起变。
 * 平台的封禁若按 UUID 存，**改名即可绕过**。
 *
 * 唯一扛得住改名的键是 Blessing Skin 的 `players.pid`。
 * 平台没法自己推出 pid，所以要把皮肤站的 (pid, uid, name, uuid) 映射导进来。
 *
 * 详见 docs/ECOSYSTEM.md §4.1。
 *
 * ## 用法
 *
 * 第一步 —— 在**皮肤站机器**上导出（工具会把这个 SQL 原样印出来）：
 *
 *   node tools/import-characters.mjs --print-sql
 *
 * 第二步 —— 把结果喂给平台：
 *
 *   node tools/import-characters.mjs --file characters.tsv
 *   node tools/import-characters.mjs --file characters.json
 *   cat characters.tsv | node tools/import-characters.mjs --stdin
 *
 * 也支持直接跑 mysql（平台与皮肤站同机、装了客户端时）：
 *
 *   node tools/import-characters.mjs --mysql "mysql -u… -p… kokuu_auth -N -B"
 *
 * ## 输入格式
 *
 * TSV / CSV（有表头，列名任意但需含 pid、uid、name；uuid 可空）
 * 或 JSON 数组 `[{ "pid":1, "uid":2, "name":"...", "uuid":"..." }]`。
 *
 * ## 幂等
 *
 * 可以反复跑。同一个 pid 再次导入是更新而不是新增；
 * 名字变了会把旧名推进 `prev_names`，于是**按旧名仍能找到同一个人**。
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { config } from '../apps/server/src/config.ts';
import { Store } from '../apps/server/src/store/index.ts';

/**
 * 在皮肤站机器上执行的查询。列名与顺序即导入格式。
 *
 * 列都显式起别名：`mysql -B`（batch）会拿**第一个 SELECT 的列名**当表头打印，
 * 所以起了别名就等于自带表头，不需要再 UNION 一行字面表头。
 */
const EXPORT_SQL = [
  'SELECT p.pid AS pid, p.uid AS uid, p.name AS name, COALESCE(u.uuid, \'\') AS uuid',
  '  FROM players p',
  '  LEFT JOIN uuid u ON u.name = p.name',
  ' ORDER BY p.pid;',
].join('\n');

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(name);
}

function value(name, fallback = undefined) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

if (flag('--help') || flag('-h') || args.length === 0) {
  console.log(
    [
      '导入皮肤站角色目录（让封禁扛得住改名）',
      '',
      '用法：',
      '  node tools/import-characters.mjs --print-sql          打印在皮肤站机器上要跑的 SQL',
      '  node tools/import-characters.mjs --file <路径>        从文件导入（TSV/CSV/JSON）',
      '  node tools/import-characters.mjs --stdin              从标准输入导入',
      '  node tools/import-characters.mjs --mysql "<命令>"     直接执行 mysql 命令并导入',
      '',
      '选项：',
      '  --dry-run      只解析与统计，不写库',
      '  --db <路径>    覆盖平台数据库路径',
      '',
      '为什么要做这件事：',
      '  本站 Yggdrasil 的 UUID 是 md5("OfflinePlayer:"+角色名) 派生的，',
      '  所以改名会让名字与 UUID 一起变。按 UUID 存的封禁改个名就绕过了。',
      '  只有 Blessing Skin 的 players.pid 是稳定的 —— 这个工具就是把',
      '  (pid, uid, name, uuid) 的映射搬进平台。',
    ].join('\n'),
  );
  process.exit(args.length === 0 ? 1 : 0);
}

if (flag('--print-sql')) {
  console.log('# 在皮肤站机器上执行（示例，按你的库名/账号调整）：');
  console.log('');
  console.log(`mysql -u<用户> -p <库名> -N -B -e "${EXPORT_SQL.replace(/\n/g, ' ')}" > characters.tsv`);
  console.log('');
  console.log('# 加 -B 就会打印列名当表头（列已起别名，表头直接可用）：');
  console.log('');
  console.log(`mysql -u<用户> -p <库名> -B -e "${EXPORT_SQL.replace(/\n/g, ' ').replace(/;$/, '')}" > characters.tsv`);
  console.log('');
  console.log('# 拿到 characters.tsv 后，在本平台这边执行：');
  console.log('');
  console.log('node tools/import-characters.mjs --file characters.tsv');
  process.exit(0);
}

// ── 取原始文本 ───────────────────────────────────────────────

let raw = '';

const mysqlCmd = value('--mysql');
const filePath = value('--file');

if (mysqlCmd) {
  try {
    // 用 shell 语义执行用户给的 mysql 命令（用户自己拼的，不是外部输入）。
    raw = execFileSync(mysqlCmd, ['-N', '-B', '-e', EXPORT_SQL], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    console.error('执行 mysql 失败：', error.message);
    console.error('提示：也可以用 --print-sql 打印 SQL，手工导出成文件再 --file 导入。');
    process.exit(2);
  }
} else if (filePath) {
  raw = readFileSync(filePath, 'utf8');
} else if (flag('--stdin')) {
  raw = readFileSync(0, 'utf8');
} else {
  console.error('未指定输入。用 --file / --stdin / --mysql，或 --help 看用法。');
  process.exit(2);
}

// ── 解析 ─────────────────────────────────────────────────────

/**
 * 解析 JSON 数组或分隔符文本。
 *
 * 分隔符文本**按表头映射列**而不是按位置 —— 皮肤站的列顺序可能被改，
 * 而按位置解析会静默把 name 当成 uuid 读进去，症状是「封禁全都对不上人」。
 */
function parseRecords(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('JSON 顶层必须是数组');
    return parsed;
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];

  const delim = lines[0].includes('\t') ? '\t' : ',';
  const header = lines[0].split(delim).map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());

  const hasHeader = header.some((h) => ['pid', 'name', 'uid'].includes(h));
  const body = hasHeader ? lines.slice(1) : lines;

  // 没有表头时按 SQL 的列顺序假定：pid, uid, name, uuid
  const cols = hasHeader ? header : ['pid', 'uid', 'name', 'uuid'];

  const idx = (names) => {
    for (const n of names) {
      const i = cols.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const iPid = idx(['pid', 'bs_pid', 'bspid']);
  const iUid = idx(['uid', 'bs_uid', 'bsuid']);
  const iName = idx(['name', 'character_name', 'charactername']);
  const iUuid = idx(['uuid', 'bs_uuid']);

  if (iPid < 0 || iName < 0) {
    throw new Error(
      `输入缺少必需列。解析到的列：${cols.join(', ')}；需要至少包含 pid 与 name。` +
        '用 --print-sql 看推荐的导出语句。',
    );
  }

  return body.map((line, lineNo) => {
    const cells = line.split(delim).map((c) => c.trim().replace(/^"|"$/g, ''));
    const record = {
      pid: Number.parseInt(cells[iPid] ?? '', 10),
      uid: iUid >= 0 ? Number.parseInt(cells[iUid] ?? '', 10) : NaN,
      name: cells[iName] ?? '',
      uuid: normalizeUuid(iUuid >= 0 ? (cells[iUuid] ?? '') : ''),
      line: lineNo + (hasHeader ? 2 : 1),
    };
    return record;
  });
}

/**
 * 把 UUID 统一成**带连字符的小写**标准形式。
 *
 * 为什么必须做：Blessing Skin 的 `uuid` 表存的是**无连字符**的 32 位十六进制
 * （`fbde4894fff23230a3ca4be322076961`），而平台从 Agent 拿到的 MC UUID
 * 是标准带连字符形式。两者字符串不相等，于是
 * `findCharacterByUuid()` 的精确匹配永远查不到 ——
 * 症状是「skin 账本里所有账号都映射不到 MC 角色」，而这不会报错，只会静默地
 * 退化成 uid:<n> 占位符。
 *
 * 已经在库里的旧数据需要用同一个文件重导一次才会被规范化。
 */
function normalizeUuid(raw) {
  const s = String(raw).trim().toLowerCase();
  if (s === '') return '';
  const hex = s.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) return s; // 不是 32 位十六进制就原样保留，交给校验去报
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

let records;
try {
  records = parseRecords(raw);
} catch (error) {
  console.error(`解析失败：${error.message}`);
  process.exit(2);
}

if (records.length === 0) {
  console.error('没有解析到任何记录。');
  process.exit(2);
}

// ── 校验 ─────────────────────────────────────────────────────

const problems = [];
const valid = [];

for (const r of records) {
  if (!Number.isInteger(r.pid) || r.pid <= 0) {
    problems.push(`第 ${r.line} 行：pid 不是正整数（${r.pid}）`);
    continue;
  }
  if (!r.name || r.name.length > 50) {
    problems.push(`第 ${r.line} 行：角色名为空或过长（${r.name}）`);
    continue;
  }
  // uid 允许缺失（目录来自不同来源时），但不能是负数。
  const uid = Number.isInteger(r.uid) && r.uid > 0 ? r.uid : 0;
  if (Number.isInteger(r.uid) && r.uid < 0) {
    problems.push(`第 ${r.line} 行：uid 为负数（${r.uid}）`);
    continue;
  }
  /*
   * uuid 为空是合法的：从没经 Yggdrasil 登录过的角色在皮肤站也没有 uuid 行。
   *
   * 这里再归一化一次（parseRecords 已经做过）是为了 JSON 输入那条路径 ——
   * 它不经过 parseRecords。库里的值必须**只有一种形式**：带连字符的小写。
   * 混着无连字符的形式时，findCharacterByUuid() 的精确匹配会全部落空，
   * 而且不报错 —— 症状只是 skin 账本里所有账号都退化成 uid:<n> 占位符。
   */
  const normalized = r.uuid ? normalizeUuid(r.uuid) : '';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
  valid.push({ bsPid: r.pid, bsUid: uid, name: r.name, uuid });
}

if (problems.length > 0) {
  console.error(`有 ${problems.length} 行不合法，前 10 条：`);
  for (const p of problems.slice(0, 10)) console.error(`  ${p}`);
  if (problems.length > valid.length) {
    console.error('不合法行数超过合法行数，疑似解析错位 —— 已中止，不写库。');
    process.exit(2);
  }
  console.error('（跳过这些行，继续导入其余记录）');
}

// ── 写库 ─────────────────────────────────────────────────────

const dbFile = value('--db', config.dbFile);
const dryRun = flag('--dry-run');

if (dryRun) {
  console.log(`[dry-run] 解析到 ${valid.length} 条合法记录，未写库。示例：`);
  for (const r of valid.slice(0, 5)) {
    console.log(`  pid=${r.bsPid} uid=${r.bsUid} name=${r.name} uuid=${r.uuid ?? '(无)'}`);
  }
  process.exit(0);
}

const store = new Store(dbFile);
let created = 0;
let updated = 0;
let renamed = 0;

try {
  for (const r of valid) {
    const result = store.upsertCharacter({ ...r, source: 'import' });
    if (result.created) created += 1;
    else updated += 1;
    if (result.renamed) renamed += 1;
  }

  const status = store.charactersStatus();

  console.log(`已导入角色目录（${dbFile}）`);
  console.log(`  新增 ${created} 个，更新 ${updated} 个，其中改名 ${renamed} 个`);
  console.log(`  目录共 ${status.count} 个角色（${status.withUuid} 个有 UUID）`);
  console.log(`  多角色账号 ${status.multiCharacterAccounts} 个`);

  if (status.renameBypassable > 0) {
    console.log('');
    console.log(
      `  ⚠️ 仍有 ${status.renameBypassable} 条生效封禁没有关联角色（bs_pid 为空）。`,
    );
    console.log('     它们只能按 UUID 匹配，玩家改名即可绕过。请在平台上重建这些封禁。');
  }
} finally {
  store.close();
}
