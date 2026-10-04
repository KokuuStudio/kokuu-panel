/**
 * 皮肤站后端的兑换明细：写 MySQL 表 bridge_exchange。
 *
 * 独立成文件的原因只有一个：**它是唯一 import db.js 的兑换实现**。
 * runtime.js 用动态 import 加载它，standalone 模式下这条边根本不会被走到，
 * mysql2 因此不会进入模块图。
 */

import { pool } from './db.js';
import { SCHEMA, MIGRATIONS } from './schema.js';
import { ExchangeLog } from './exchange-log.js';

export class SkinExchangeLog extends ExchangeLog {
  async init() {
    for (const sql of SCHEMA) await pool.query(sql);
    for (const m of MIGRATIONS) {
      // 先查再加：information_schema.COLUMNS 里没有才 ALTER
      const [[r]] = await pool.query(
        'SELECT 1 AS x FROM information_schema.COLUMNS ' +
        'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [m.table, m.column],
      );
      if (!r) await pool.query(m.sql);
    }
  }

  async find(uniqEvent) {
    const [[r]] = await pool.query(
      'SELECT credit_delta, credit_after FROM bridge_exchange WHERE uniq_event = ?',
      [uniqEvent],
    );
    return r || null;
  }

  async record({ uniqEvent, playerName, playerUuid, uid, coin, credit, creditAfter, reason, note }) {
    await pool.query(
      `INSERT INTO bridge_exchange
         (uniq_event, player_name, player_uuid, uid, coin_delta, credit_delta,
          credit_after, reason, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uniqEvent, playerName, playerUuid || '', uid, coin, credit, creditAfter, reason, note],
    );
  }

  async recent(limit = 50) {
    const [rows] = await pool.query(
      `SELECT id, player_name, player_uuid, uid, coin_delta, credit_delta,
              credit_after, reason, note,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM bridge_exchange ORDER BY id DESC LIMIT ?`,
      [Math.min(200, Math.max(1, Number(limit) || 50))],
    );
    return rows;
  }

  get kind() { return 'skin'; }
}
