/**
 * 皮肤站后端的配置存储：写 MySQL 表 bridge_config。
 *
 * 放在这里而不是 config.js，是为了让 standalone 模式彻底不 import db.js ——
 * 「不装皮肤站也能跑」的前提是模块图里根本没有 mysql2 那条链。
 */

import { pool } from './db.js';
import { SCHEMA, DEFAULTS } from './schema.js';
import { Settings, validateConfig } from './settings.js';

export class SkinSettings extends Settings {
  constructor() {
    super();
    this.pool = pool;
  }

  /** 建表 + 补默认配置。幂等，启动时调用一次。 */
  async init() {
    for (const sql of SCHEMA) await this.pool.query(sql);
    for (const [k, v] of Object.entries(DEFAULTS)) {
      await this.pool.query(
        'INSERT IGNORE INTO bridge_config (cfg_key, cfg_value) VALUES (?, ?)',
        [k, v],
      );
    }
  }

  async load() {
    const [rows] = await this.pool.query('SELECT cfg_key, cfg_value FROM bridge_config');
    const cfg = { ...DEFAULTS };
    for (const r of rows) cfg[r.cfg_key] = r.cfg_value;
    return cfg;
  }

  /**
   * 写配置。
   * 白名单：只接受 DEFAULTS 里出现过的键，避免后台误传任意键名把表搞脏。
   * 先全量校验再写 —— 不允许「校验一半写一半」。
   */
  async save(patch) {
    const keys = Object.keys(DEFAULTS);
    const entries = Object.entries(patch).filter(([k]) => keys.includes(k));
    if (!entries.length) throw new Error('没有可更新的配置项');

    const current = await this.load();
    const next = { ...current };
    for (const [k, v] of entries) {
      const val = String(v).trim();
      if (val.length > 255) throw new Error(`${k} 的值过长`);
      next[k] = val;
    }
    validateConfig(next);

    for (const [k, v] of entries) {
      await this.pool.query(
        'INSERT INTO bridge_config (cfg_key, cfg_value) VALUES (?, ?) ' +
          'ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)',
        [k, String(v).trim()],
      );
    }
    return next;
  }

  get kind() { return 'skin'; }
  get label() { return '皮肤站数据库'; }
}
