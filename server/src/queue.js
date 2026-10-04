/**
 * 与 Minecraft 插件之间的通信。
 *
 * 走 Redis 队列而非 HTTP —— 理由与 exchange-bridge 的设计一致：
 *   - 不需要在游戏服开任何公网端口
 *   - RPOP/BRPOP「取走即消失」，天然避免两实例重复消费
 *   - 断线重连即可，队列里的消息不丢
 *
 * ★ 前缀问题（本项目最容易踩的坑，务必读）：
 *   皮肤站用 Laravel 的 Redis 门面，内核 config/database.php 会给 redis
 *   设一个 prefix（本站为 blessing_skin_database_），phpredis 在**扩展层**
 *   加上它。而插件用的是裸客户端，键名就是字面量。
 *   所以「同一个 key 名」在两边实际是不同的键。
 *   → 中间件必须显式配置完整键名，或用 FLUSHDB 的连接（清空前缀）。
 *   这里用 standalone 模式时不存在这个问题（没有 Laravel 在中间）。
 */

import Redis from 'ioredis';
import { loadEnv } from './env.js';

const env = loadEnv();

export class Queue {
  /**
   * @param {object} o
   * @param {string} o.host
   * @param {number} o.port
   * @param {string} o.password
   * @param {number} o.db
   * @param {string} o.assetKey 资产指令队列（中间件 → 插件）
   * @param {string} o.eventKey 事件队列（插件 → 中间件）
   */
  constructor(o) {
    this.opts = o;
    this.client = null;
    this.lastError = '';
  }

  /** 惰性连接。Redis 不可用时不让进程崩 —— 资产功能降级，其余照常。 */
  connect() {
    if (this.client) return this.client;
    const { host, port, password, db } = this.opts;
    this.client = new Redis({
      host: host || '127.0.0.1',
      port: Number(port || 6379),
      password: password || undefined,
      db: Number(db || 0),
      // 重连策略：最多 10 次，之后放弃并标记不可用，
      // 避免 Redis 长时间挂掉时无限重连刷日志。
      retryStrategy: (times) => (times > 10 ? null : Math.min(times * 500, 5000)),
      lazyConnect: false,
      maxRetriesPerRequest: 2,
    });
    this.client.on('error', (e) => {
      this.lastError = e.message;
    });
    return this.client;
  }

  async ping() {
    try {
      const r = await this.connect().ping();
      return r === 'PONG';
    } catch (e) {
      this.lastError = e.message;
      return false;
    }
  }

  /**
   * 下发一条资产变更指令。
   *
   * ★ 消息体不含玩家可控的自由文本之外的内容；player 已在
   *   assets.js 里做过白名单校验，这里不再拼接任何指令字符串 ——
   *   插件端按字段解析，不靠字符串拼接执行。
   *
   * @param {string} uuid 可选。带上后插件能确认「要改的是不是同一个人」，
   *   避免重名时给错账户发钱 —— 玩家名可重名，UUID 不会。
   */
  async pushAsset({ eventId, player, uuid, asset, delta, note }) {
    try {
      const payload = JSON.stringify({
        event_id: eventId,
        player,
        uuid: uuid || '',
        asset,
        delta,
        note: note || '',
        ts: Date.now(),
      });
      await this.connect().lpush(this.opts.assetKey, payload);
      return { queued: true, eventId };
    } catch (e) {
      this.lastError = e.message;
      return { queued: false, eventId, reason: `Redis 写入失败：${e.message}` };
    }
  }

  /** 各队列深度，供诊断。 */
  async depths() {
    try {
      const c = this.connect();
      const [asset, event] = await Promise.all([
        c.llen(this.opts.assetKey),
        c.llen(this.opts.eventKey),
      ]);
      return { asset, event, error: '' };
    } catch (e) {
      return { asset: -1, event: -1, error: e.message };
    }
  }

  /**
   * 消费插件上报的事件（玩家赚取金币等）。
   * 目前是预留接口 —— 自动回流需要在插件侧监听经济事件后上报。
   */
  async popEvent(timeoutSec = 0) {
    const res = await this.connect().blpop(this.opts.eventKey, timeoutSec);
    return res ? JSON.parse(res[1]) : null;
  }

  async quit() {
    if (this.client) {
      try { await this.client.quit(); } catch { /* 忽略 */ }
      this.client = null;
    }
  }
}

/** 从环境变量建队列实例。 */
export function makeQueue() {
  return new Queue({
    host: env.REDIS_HOST || '127.0.0.1',
    port: env.REDIS_PORT || 6379,
    password: env.REDIS_PASSWORD || '',
    db: env.REDIS_DB || 0,
    assetKey: env.REDIS_ASSET_KEY || 'bs:asset:cmd',
    eventKey: env.REDIS_EVENT_KEY || 'bs:asset:event',
  });
}
