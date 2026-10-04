/**
 * 本地账本 → MySQL 迁移工具。
 *
 * 场景：先用 standalone 模式跑了一段时间，后来装了皮肤站想把账搬过去。
 * 反向（MySQL → 本地）不提供 —— 权威账本只能有一个，导出请用 mysqldump。
 *
 * 用法：
 *   BACKEND=standalone DATA_DIR=./data node tools/migrate-to-mysql.js --dry-run
 *   BACKEND=skin DB_*=... node tools/migrate-to-mysql.js
 *
 * ★ 安全设计：
 *   1. --dry-run 默认开启演练模式，不写任何东西
 *   2. 每个账户的 event_id 带 m 前缀，重跑不会重复计账（幂等）
 *   3. 目标 uid 不存在时**跳过并报告**，绝不凭空建 users 行 ——
 *      users 表属于皮肤站内核，中间件没有资格造用户
 *   4. 余额以本地账本为准，直接写 balance_after，不做二次累加
 */

import path from 'node:path';
import { loadEnv } from '../src/env.js';
import { StandaloneLedger } from '../src/local-ledger.js';

const env = loadEnv();
const dryRun = !process.argv.includes('--apply');
const DATA_DIR = path.resolve(env.DATA_DIR || './data');
const PREFIX = env.LEDGER_PREFIX || 'default';

const log = (...a) => console.log(...a);
const head = (t) => log(`\n── ${t}`);

async function main() {
  head('读取本地账本');
  const local = await new StandaloneLedger(DATA_DIR, PREFIX).load();
  const accounts = [...local.accounts.values()];
  log(`  账户 ${accounts.length} 个，流水 ${local.seen.size} 条`);

  if (!accounts.length) {
    log('\n本地账本为空，无需迁移。');
    return;
  }

  // 迁移只写 credit_ledger —— users.score 由皮肤站自己的业务维护。
  // 但我们仍要确认目标 uid 存在，否则流水会挂在不存在的账户上。
  const { pool } = await import('../src/db.js');

  head('检查目标库');
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users');
  log(`  users 表 ${n} 个账户`);
  const [[{ t }]] = await pool.query('SELECT COUNT(*) AS t FROM credit_ledger');
  log(`  credit_ledger 现有 ${t} 条流水`);

  // 找出本地有、目标库没有的 uid
  const uids = accounts.map((a) => a.uid);
  const ph = uids.map(() => '?').join(',');
  const [exists] = await pool.query(
    `SELECT uid FROM users WHERE uid IN (${ph})`, uids,
  );
  const have = new Set(exists.map((r) => Number(r.uid)));
  const missing = accounts.filter((a) => !have.has(Number(a.uid)));

  if (missing.length) {
    head('无法迁移的账户（目标库无此 uid）');
    for (const a of missing.slice(0, 20)) {
      log(`  uid=${a.uid}  name=${a.name}  余额=${a.balance}`);
    }
    if (missing.length > 20) log(`  …另有 ${missing.length - 20} 个`);
    log('\n  这些账户要先在皮肤站注册同名用户，再重跑本工具。');
    log('  中间件不会替你造 users 行 —— 那是皮肤站内核的领域。');
  }

  const ok = accounts.filter((a) => have.has(Number(a.uid)));
  if (!ok.length) {
    log('\n没有可迁移的账户，结束。');
    await pool.end();
    return;
  }

  // 逐个账户搬它的流水
  head(dryRun ? '演练（不写入）' : '实际写入');
  let moved = 0, skipped = 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const a of ok) {
      const logs = await local.logs(a.uid, 5000);
      for (const l of logs) {
        // event_id 加 m: 前缀做命名空间，避免与线上已有流水撞 id
        const eventId = `m:${PREFIX}:${l.eventId}`;
        const [[dup]] = await conn.query(
          'SELECT id FROM credit_ledger WHERE event_id = ?', [eventId],
        );
        if (dup) { skipped++; continue; }
        if (!dryRun) {
          await conn.query(
            `INSERT INTO credit_ledger
               (event_id, uid, delta, balance_after, source, ref, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [eventId, Number(a.uid), l.delta, l.balanceAfter,
             l.source || 'admin', l.ref, `${l.note || ''} [自本地账本迁移]`],
          );
        }
        moved++;
      }
      log(`  ${a.uid} (${a.name}) 余额 ${a.balance}，流水 ${logs.length} 条`);
    }
    if (dryRun) {
      await conn.rollback();
      log(`\n演练完成：将写入 ${moved} 条，跳过 ${skipped} 条已存在。未做任何改动。`);
      log('去掉 --dry-run 并加上 --apply 才会真正执行。');
    } else {
      await conn.commit();
      log(`\n迁移完成：写入 ${moved} 条，跳过 ${skipped} 条已存在。`);
      log('注意：credit_ledger 已搬，但 users.score 未改动 ——');
      log('  余额是否与本地一致取决于皮肤站那边是否有其它业务在加分。');
      log('  上线前请到管理台核对一次各账户余额。');
    }
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.error('\n迁移失败，已回滚：', e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
