/**
 * 配置存储抽象。
 *
 * 同样的键值对，在两种后端下落在不同地方：
 *   SkinSettings   → MySQL 表 bridge_config（跟着皮肤站一起备份/迁移）
 *   LocalSettings  → data/config.json（standalone，零依赖）
 *
 * 比例、限额这类值是**安全边界**，配错直接导致刷分或误伤，
 * 所以 validate() 在两个实现里都必须调用，不允许绕过。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, CONFIG_LABELS } from './schema.js';

export { DEFAULTS, CONFIG_LABELS };

/**
 * 校验配置的数值合理性。
 * 纯函数，不碰 IO —— 写前拦一道，配错当场报错而不是等到半夜对不上账。
 */
export function validateConfig(cfg) {
  const num = (v) => (/^-?\d+$/.test(String(v).trim()) ? parseInt(v, 10) : NaN);

  if (!/^[01]$/.test(String(cfg.enabled).trim())) {
    throw new Error('总开关只能是 0 或 1');
  }
  if (!/^[01]$/.test(String(cfg.reflow_enabled === undefined ? '0' : cfg.reflow_enabled).trim())) {
    throw new Error('金币自动回流开关只能是 0 或 1');
  }
  const ratio = num(cfg.ratio);
  if (!Number.isInteger(ratio) || ratio <= 0) throw new Error('兑换比例必须是正整数');

  for (const k of ['daily_limit', 'single_limit', 'min_coin', 'reflow_daily_limit']) {
    const n = num(cfg[k]);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${CONFIG_LABELS[k]} 必须是非负整数`);
  }
  // 兑换关系：ratio 金币 = 1 积分，min_coin 是单笔最少**金币**。
  // min_coin < ratio 意味着「这批金币不够换 1 积分」—— 这是管理员
  // 有意为之的调低门槛（比如按 500 金币 1 积分但允许 500 起兑），
  // 不是配置错误，所以只提示不拒绝。
  // 真正必须拦的是 min_coin = 0：任何金额都能提交，全是小额请求，
  // 会把账本和队列打满。
  if (num(cfg.min_coin) === 0) {
    throw new Error('单笔最少金币不能为 0，否则任何金额都能提交');
  }
  const src = String(cfg.auto_source || '').trim();
  if (src && !/^[a-z_]{1,16}$/.test(src)) {
    throw new Error('流水来源标记只允许小写字母与下划线');
  }
  return true;
}

/** 抽象基类。 */
export class Settings {
  async load() { throw new Error('未实现 load()'); }
  async save(patch) { throw new Error('未实现 save()'); }
  get kind() { return 'abstract'; }
  get label() { return '抽象配置'; }
}

/* ------------------------------------------------------------------ *
 * 本地 JSON 配置
 * ------------------------------------------------------------------ */
export class LocalSettings extends Settings {
  constructor(dataDir, prefix = 'default') {
    super();
    this.file = path.join(dataDir, `${prefix}.config.json`);
    this.cache = { ...DEFAULTS };
  }

  async load() {
    if (fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.cache = { ...DEFAULTS, ...raw };
      } catch {
        // 配置坏了不能让服务起不来：退回默认并留下痕迹
        console.error(`[settings] ${this.file} 解析失败，已回退默认值`);
        this.cache = { ...DEFAULTS };
      }
    }
    return this.cache;
  }

  async save(patch) {
    const next = { ...this.cache };
    for (const k of Object.keys(DEFAULTS)) {
      if (patch[k] === undefined) continue;
      const v = String(patch[k]).trim();
      if (v.length > 255) throw new Error(`${k} 的值过长`);
      next[k] = v;
    }
    validateConfig(next);
    this.cache = next;
    // 先写临时文件再改名：断电时不会留下半个 JSON
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, this.file);
    return next;
  }

  get kind() { return 'local'; }
  get label() { return '本地配置文件'; }
}
