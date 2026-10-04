/**
 * 金币回流事件消费器（插件 → 中间件）。
 *
 * 插件侧（EarningsWatcher）已经**先把金币扣掉了**，才把事件写进 Redis。
 * 本文件的职责就是把这份积分补上：读事件 → 校验 → 记账 → 写审计明细。
 *
 * ★ 为什么「先扣币再加积分」这个顺序不能反：
 *   Redis 队列没有回执，中间件**无法知道扣币成功没有**。
 *   若先加积分、再让中间件扣币，扣币失败时玩家就凭空多一笔积分 ——
 *   而积分能换金币，等于直接造币。
 *   现在这个顺序下，最坏情况是「玩家亏了币没拿到积分」：
 *   可追溯、可人工补，而且方向是安全的那一侧。
 *
 * ★ 比例以插件上报的 credit 为准，本文件**不重算**。
 *   扣币发生在插件侧，算式必须在同一处完成；两边各算一半、
 *   比例一旦漂移就等于凭空造币或吞钱。
 *   这里只做「合理性校验」：用中间件自己的比例反算，
 *   如果差得太远，说明两边配置不一致 —— 记账但告警，
 *   让管理员去修配置，而不是默默按错的数发钱。
 *
 * ★ 为什么 Redis 队列比 HTTP 好：
 *   断线期间事件堆在队列里，重连后继续消费，玩家不丢分。
 *   HTTP 回调失败就是永久丢失 —— 而这时玩家的金币已经被扣了。
 */

import { assertSafeName, assertSafeUuid } from './assets.js';

/** 消费循环的默认参数 */
const DEFAULTS = {
  enabled: false,
  idleSleepMs: 1000,
  maxPerRound: 50,
  ratioTolerance: 0.5,      // 允许的与中间件比例的偏差（相对值）
  staleSec: 0,               // 0 = 不做过期检查
};

export class ReflowConsumer {
  /**
   * @param {object} d
   * @param {import('./queue.js').Queue} d.queue
   * @param {import('./ledger.js').Ledger} d.ledger
   * @param {import('./settings.js').Settings} d.settings
   * @param {import('./exchange-log.js').ExchangeLog} d.exchangeLog
   * @param {(uuid: string, name: string) => Promise<string|null>} d.resolveUid
   * @param {object} d.opts
   */
  constructor({ queue, ledger, settings, exchangeLog, resolveUid, opts = {} }) {
    this.queue = queue;
    this.ledger = ledger;
    this.settings = settings;
    this.exchangeLog = exchangeLog;
    this.resolveUid = resolveUid;
    this.o = { ...DEFAULTS, ...opts };

    this.timer = null;
    this.busy = false;
    this.stats = {
      consumed: 0, credited: 0, rejected: 0, dup: 0, failed: 0,
      drift: 0, lastError: '', lastAt: 0,
    };
  }

  get running() { return this.timer !== null; }

  /** 启动消费循环。enabled=false 时不启 —— Redis 不可用也不影响主功能。 */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick(); }, this.o.idleSleepMs);
    // 不阻止进程退出：Ctrl+C 应该立刻停下来，不是等下一个 tick
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  snapshot() {
    return {
      ...this.stats,
      enabled: !!this.enabled,
      running: this.running,
      idleSleepMs: this.o.idleSleepMs,
    };
  }

  /** 单轮消费。幂等重入 —— 定时器慢一拍时不会并发跑两轮。 */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const cfg = await this.settings.load();
      const on = cfg.reflow_enabled !== undefined
        ? String(cfg.reflow_enabled) === '1'
        : !!this.o.enabled;
      if (!on) {
        this.enabled = false;
        return;
      }
      this.enabled = true;

      const ratio = parseInt(cfg.ratio, 10) || 1000;
      const dailyLimit = parseInt(cfg.reflow_daily_limit, 10) || 0;

      let n = 0;
      while (n < this.o.maxPerRound) {
        const raw = await this.queue.popEvent(0);
        if (!raw) break;
        n++;
        try {
          await this.handle(raw, { ratio, dailyLimit });
        } catch (e) {
          this.stats.failed++;
          this.stats.lastError = e.message;
          console.error(`[reflow] 处理事件失败：${e.message}`);
        }
      }
      if (n) this.stats.lastAt = Date.now();
    } catch (e) {
      // Redis 断了不该刷屏刷爆日志 —— 只记状态，等下一轮重试
      this.stats.lastError = e.message;
    } finally {
      this.busy = false;
    }
  }

  /**
   * 处理一条回流事件。
   *
   * @returns {Promise<{ok:boolean, credit?:number, reason?:string}>}
   */
  async handle(raw, ctx = {}) {
    // ★ 计数放在这里而不是 tick()：
    //   handle() 有两条入口（队列消费 / 补发模拟），把计数写在 tick 里
    //   会让补发路径完全不计数 —— 排查时看到 consumed=0 但明明入账了，
    //   那种「数字对不上」比没有数字更让人怀疑人生。
    this.stats.consumed++;
    let ev;
    try {
      ev = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      this.stats.rejected++;
      return { ok: false, reason: 'JSON 解析失败' };
    }

    const eventId = String(ev.event_id || '').trim().slice(0, 96);
    const playerRaw = String(ev.player || '').trim();
    const uuidRaw = String(ev.uuid || '').trim();
    const asset = String(ev.asset || 'coin').trim();
    const coin = Number(ev.delta);
    const credit = parseInt(ev.credit, 10);

    if (!eventId) {
      this.stats.rejected++;
      return { ok: false, reason: '缺少 event_id' };
    }
    if (asset !== 'coin') {
      // 现在只有金币回流。将来加别的资产时在这里分流，
      // 但**不要**直接放行未知资产 —— 那是往账本里写脏数据的口子。
      this.stats.rejected++;
      return { ok: false, reason: `暂不支持回流资产「${asset}」` };
    }
    if (!Number.isInteger(credit) || credit < 1) {
      this.stats.rejected++;
      return { ok: false, reason: `credit 非法：${ev.credit}` };
    }
    if (!Number.isFinite(coin) || coin < 1) {
      this.stats.rejected++;
      return { ok: false, reason: `delta 非法：${ev.delta}` };
    }

    // 玩家名与 uuid 都要过白名单：它们会进 SQL 参数与日志。
    let playerName = '';
    if (playerRaw) {
      try { playerName = assertSafeName(playerRaw); }
      catch (e) { this.stats.rejected++; return { ok: false, reason: e.message }; }
    }
    let uuid = '';
    if (uuidRaw) {
      try { uuid = assertSafeUuid(uuidRaw); }
      catch (e) { this.stats.rejected++; return { ok: false, reason: e.message }; }
    }
    if (!playerName && !uuid) {
      this.stats.rejected++;
      return { ok: false, reason: '事件既无玩家名也无 uuid' };
    }

    // 过期事件：插件离线很久后重启，可能把几天前的增量一次性倒进来。
    // 那时金币早就扣了（玩家确实损失过），所以不能丢 —— 但要记账并告警。
    if (this.o.staleSec > 0 && ev.ts) {
      const ageSec = (Date.now() - Number(ev.ts)) / 1000;
      if (ageSec > this.o.staleSec) {
        console.warn(`[reflow] 事件 ${eventId} 已过期 ${Math.round(ageSec)}s，` +
          '仍会入账（玩家的金币当时已经扣了），请检查插件是否长时间离线');
      }
    }

    // 幂等：同一 event_id 重复投递直接回放，绝不二次加分。
    const dup = await this.exchangeLog.find(eventId);
    if (dup) {
      this.stats.dup++;
      return {
        ok: true, idempotent: true,
        credit: Number(dup.credit_delta), after: Number(dup.credit_after),
      };
    }

    // 比例漂移检测：不拒绝记账（玩家金币已经扣了），
    // 但要能一眼看出两边配置不一致。
    const ratio = ctx.ratio || this.o.ratioFallback || 1000;
    const expected = Math.floor(coin / ratio);
    if (expected >= 1 && Math.abs(credit - expected) / expected > this.o.ratioTolerance) {
      this.stats.drift++;
      console.warn(`[reflow] 比例漂移：${eventId} 扣了 ${coin} 金币上报 ${credit} 积分，` +
        `但中间件比例 ${ratio}:1 应为 ${expected} 积分。` +
        '请核对插件 config.yml 的 reflow.ratio 与后台「兑换比例」是否一致。');
    }

    const uid = await this.resolveUid(uuid, playerName);
    if (uid === null || uid === undefined) {
      this.stats.rejected++;
      return {
        ok: false,
        reason: uuid
          ? `UUID ${uuid} 未绑定账号`
          : `玩家「${playerName}」未绑定账号`,
        unbound: true,
      };
    }

    // 每日回流上限：与「金币换积分」分开算（不同 source）。
    // 分开的原因是两者的风控诉求不同 —— 手动兑换限得死，
    // 自动回流要留出余量，否则玩家玩一整天一分拿不到。
    if (ctx.dailyLimit > 0) {
      const got = await this.ledger.todayTotal(uid, 'reflow');
      if (got + credit > ctx.dailyLimit) {
        this.stats.rejected++;
        return {
          ok: false, reason: `今日回流已达上限（${got}/${ctx.dailyLimit} 积分）`,
          gotToday: got, dailyLimit: ctx.dailyLimit,
        };
      }
    }

    let res;
    try {
      res = await this.ledger.change({
        uid, delta: credit, eventId,
        source: 'reflow', ref: eventId,
        name: playerName, uuid,
        note: `游戏内赚取 ${coin} 金币自动回流`,
      });
    } catch (e) {
      this.stats.failed++;
      return { ok: false, reason: e.message, balance: e.balance };
    }

    try {
      await this.exchangeLog.record({
        uniqEvent: eventId, playerName, playerUuid: uuid, uid,
        coin, credit, creditAfter: res.after,
        reason: 'reflow', note: `游戏内赚取 ${coin} 金币自动回流`,
      });
    } catch (e) {
      console.error(`[reflow] 明细写入失败 eventId=${eventId}：${e.message}` +
        '（积分已入账，仅缺审计明细）');
    }

    this.stats.credited++;
    console.log(`[reflow] ${playerName || uuid} −${coin} 金币 → +${credit} 积分（余额 ${res.after}）`);
    return { ok: true, credit, before: res.before, after: res.after, coin, uid };
  }
}
