/**
 * 运行时装配。
 *
 * 这是整个低耦合设计的**唯一胶水点**：整个系统里，只有这一个文件
 * 知道「皮肤站存在」这件事。其他所有模块都只面向接口。
 *
 *   BACKEND=skin        → SkinLedger + SkinSettings + SkinExchangeLog + MySQL
 *   BACKEND=standalone  → StandaloneLedger + LocalSettings + LocalExchangeLog + JSONL
 *
 * ★ 关键性质：standalone 走的是**动态 import**，模块图里根本不会加载
 *   db.js / mysql2。所以「不装皮肤站、不装 MySQL 也能跑」不是嘴上说说，
 *   而是依赖图上真的没有那条边。
 */

import path from 'node:path';
import { loadEnv } from './env.js';

const env = loadEnv();

export const BACKEND = String(env.BACKEND || 'skin').toLowerCase();
export const DATA_DIR = path.resolve(env.DATA_DIR || './data');
export const LEDGER_PREFIX = env.LEDGER_PREFIX || 'default';

/** 供前端 /api/meta 用，管理员一眼看出当前跑的是哪套。 */
export const runtimeInfo = {
  backend: BACKEND,
  dataDir: DATA_DIR,
  label: '',
  ledger: '',
  settings: '',
  exchange: '',
  hasDatabase: false,
  hasSkin: false,
};

/**
 * 按 BACKEND 组装全部实现。
 * @returns {Promise<{ledger,settings,exchangeLog,bridge,queue,reflow}>}
 */
export async function createRuntime() {
  if (BACKEND === 'standalone' || BACKEND === 'local') {
    const [{ StandaloneLedger }, { LocalSettings, DEFAULTS }, { LocalExchangeLog }] =
      await Promise.all([
        import('./local-ledger.js'),
        import('./settings.js'),
        import('./exchange-log.js'),
      ]);

    const ledger = await new StandaloneLedger(DATA_DIR, LEDGER_PREFIX).load();
    const settings = new LocalSettings(DATA_DIR, LEDGER_PREFIX);
    await settings.load();
    const exchangeLog = new LocalExchangeLog(DATA_DIR, LEDGER_PREFIX);
    await exchangeLog.init();

    const { createBridge } = await import('./bridge.js');
    const { makeQueue } = await import('./queue.js');
    const { ReflowConsumer } = await import('./reflow.js');

    Object.assign(runtimeInfo, {
      label: '独立模式（不依赖皮肤站 / 不依赖 MySQL）',
      ledger: ledger.label, settings: settings.label, exchange: '本地 JSONL',
      hasDatabase: false, hasSkin: false,
    });

    const bridge = createBridge({ ledger, settings, exchangeLog, autoOpen: true });
    const queue = makeQueue();
    const reflow = new ReflowConsumer({
      queue, ledger, settings, exchangeLog,
      resolveUid: bridge.resolveUid,
      opts: reflowOpts(),
    });

    return { ledger, settings, exchangeLog, bridge, queue, reflow };
  }

  // ── skin 模式 ────────────────────────────────────────────────
  // 全部动态 import。这不是「条件加载」的偷懒，而是**模块隔离的必要条件**：
  // 静态 import 会在模块图解析期就把 db.js 拉进来，standalone 就再也
  // 摘不干净了（已实测：exchange-log.js 静态 import db.js 时，
  // 物理删掉 node_modules/mysql2 后 standalone 一样起不来）。
  const [{ SkinLedger }, { SkinSettings }, { SkinExchangeLog }] = await Promise.all([
    import('./skin-ledger.js'),
    import('./skin-settings.js'),
    import('./skin-exchange-log.js'),
  ]);

  const settings = new SkinSettings();
  await settings.init();          // 建表 + 补默认配置，幂等
  const exchangeLog = new SkinExchangeLog();
  await exchangeLog.init();

  const { createBridge } = await import('./bridge.js');
  const { makeQueue } = await import('./queue.js');
  const { ReflowConsumer } = await import('./reflow.js');

  Object.assign(runtimeInfo, {
    label: '皮肤站模式（账本 = MySQL users.score）',
    ledger: '皮肤站积分（MySQL）', settings: settings.label, exchange: 'bridge_exchange 表',
    hasDatabase: true, hasSkin: true,
  });

  const ledger = new SkinLedger();
  const bridge = createBridge({ ledger, settings, exchangeLog });
  const queue = makeQueue();
  const reflow = new ReflowConsumer({
    queue, ledger, settings, exchangeLog,
    resolveUid: bridge.resolveUid,
    opts: reflowOpts(),
  });

  return { ledger, settings, exchangeLog, bridge, queue, reflow };
}

/** 回流消费器的运行参数。staleSec 默认 0（不过期检查）——
 *  因为玩家的金币在事件产生那一刻就已经扣掉了，事件再旧也必须入账。 */
function reflowOpts() {
  return {
    enabled: String(env.REFLOW_ENABLED || '0') === '1',
    idleSleepMs: Math.max(200, Number(env.REFLOW_IDLE_MS) || 1000),
    maxPerRound: Math.min(500, Math.max(1, Number(env.REFLOW_MAX_PER_ROUND) || 50)),
    staleSec: Math.max(0, Number(env.REFLOW_STALE_SEC) || 0),
  };
}

/** 供 /api/ping 用：后端是否真的连得上。 */
export async function healthCheck(rt) {
  if (BACKEND === 'standalone' || BACKEND === 'local') {
    return { ok: true, storage: 'jsonl', detail: DATA_DIR };
  }
  try {
    const [[r]] = await (await import('./db.js')).pool.query('SELECT 1 AS ok');
    return { ok: r.ok === 1, storage: 'mysql', detail: env.DB_DATABASE || 'kokuu' };
  } catch (e) {
    return { ok: false, storage: 'mysql', detail: e.message };
  }
}
