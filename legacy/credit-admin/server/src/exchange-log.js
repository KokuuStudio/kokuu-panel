/**
 * 兑换流水的存储抽象。
 *
 * 「金币换积分」每一笔要记两处：
 *   1. 账本流水（Ledger）—— 加了多少积分，审计的唯一依据
 *   2. 兑换明细（ExchangeLog）—— 换了多少金币、比例多少、什么时候
 *
 * 第 2 处不是账本，是**兑换业务记录**。
 *
 * ★ 本文件只放抽象 + 本地实现，**绝不 import db.js**。
 *   MySQL 实现见 skin-exchange-log.js —— 它必须走动态 import，
 *   否则 mysql2 会被拖进 standalone 的模块图，破坏「零数据库依赖」。
 */

import fs from 'node:fs';
import path from 'node:path';

export class ExchangeLog {
  async init() {}
  /**
   * 幂等查询。命中返回上次结果，未命中返回 null。
   * @returns {Promise<{credit_delta:number, credit_after:number}|null>}
   */
  async find(uniqEvent) { return null; }
  async record(r) { throw new Error('未实现 record()'); }
  async recent(limit = 50) { return []; }
  get kind() { return 'abstract'; }
}

/* ------------------------------------------------------------------ *
 * 本地 JSONL
 * ------------------------------------------------------------------ */
export class LocalExchangeLog extends ExchangeLog {
  constructor(dataDir, prefix = 'default') {
    super();
    this.file = path.join(dataDir, `${prefix}.exchange.jsonl`);
    this.seen = new Map();   // uniqEvent -> row
    this.seq = 0;
  }

  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        this.seen.set(r.uniqEvent, r);
        if (Number(r.id) > this.seq) this.seq = Number(r.id);
      } catch { /* 跳过坏行，不让一行坏数据毁掉整个恢复 */ }
    }
  }

  async find(uniqEvent) {
    return this.seen.get(uniqEvent) || null;
  }

  async record({ uniqEvent, playerName, playerUuid, uid, coin, credit, creditAfter, reason, note }) {
    const row = {
      id: ++this.seq,
      uniqEvent, playerName,
      playerUuid: playerUuid || '',
      uid,
      coin_delta: coin, credit_delta: credit, credit_after: creditAfter,
      reason, note: note || '',
      at: new Date().toISOString(),
    };
    // 同步追加：写完才返回。异步写会在进程被 kill 时丢审计明细。
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
    this.seen.set(uniqEvent, row);
  }

  async recent(limit = 50) {
    if (!fs.existsSync(this.file)) return [];
    const rows = fs.readFileSync(this.file, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).reverse();
    return rows.slice(0, Math.min(200, Math.max(1, Number(limit) || 50)))
      .map((r) => ({
        id: r.id,
        // ★ 字段名对齐 MySQL 侧的列名（bridge_exchange.player_name 等），
        //   否则同一张表在两种后端下前端要写两套 prop，
        //   而这类不一致只在切后端时才暴露 —— 极难排查。
        player_name: r.playerName,
        player_uuid: r.playerUuid || '',
        uid: r.uid,
        coin_delta: r.coin_delta,
        credit_delta: r.credit_delta,
        credit_after: r.credit_after,
        reason: r.reason,
        note: r.note,
        created_at: String(r.at).replace('T', ' ').slice(0, 19),
      }));
  }

  get kind() { return 'local'; }
}
