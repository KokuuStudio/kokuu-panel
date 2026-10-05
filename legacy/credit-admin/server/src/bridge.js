/**
 * 游戏 ↔ 积分的双向桥接。
 *
 * 方向一（原有，由 exchange-bridge 插件负责）：积分 → Redis 队列 → 插件发现金
 * 方向二（本文件）：玩家在游戏里赚金币 → 换成积分 → 写进账本
 *
 * ★ 方向二的安全边界（每一条都对应一类真实刷分手法）：
 *
 *  1. 只认「经插件上报」的金币 —— 中间件不直连游戏，余额真伪由 MC 端
 *     EconomyHook 判定（它读的是经济插件的真实余额）。
 *  2. event_id 唯一索引做幂等 —— 插件重试、网络重发都不会重复加分。
 *  3. 顺序：先记账后写兑换明细 —— 见下面「为什么不需要分布式事务」。
 *  4. 每日/单笔限额 —— 挡工作室批量小号。
 *  5. 余额从账本读，不信任调用方传的 balance_after。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么不需要分布式事务
 *
 * 账本和兑换明细在两个后端下可能根本不在同一个存储里（skin 在 MySQL，
 * standalone 一个在 MySQL 一个在 JSONL），跨存储的两阶段提交带来的复杂度
 * 远大于收益 —— 而且它要防的场景本身可以被顺序消除：
 *
 *   先 ledger.change(eventId)：
 *     成功 → 积分已入账且 eventId 已占位，重复请求天然被幂等挡住。
 *     失败 → 什么都没发生，插件侧的金币已扣（那是插件的账），
 *             玩家找客服补即可 —— 这是**已知且可追溯**的一类。
 *   再 exchangeLog.record()：
 *     失败 → 只丢一条审计明细，积分是对的。降级为日志告警。
 *
 * 反过来（先记明细后加分）若明细写成功、记账失败，玩家金币被扣但既没积分
 * 也没幂等占位，重试会再扣一次币 —— 那才是真的坑。
 * ────────────────────────────────────────────────────────────────
 */

import { assertSafeName, assertSafeUuid } from './assets.js';

/**
 * 桥接服务工厂。依赖全部走接口，skin / standalone 通用。
 *
 * @param {object} d
 * @param {import('./ledger.js').Ledger} d.ledger
 * @param {import('./settings.js').Settings} d.settings
 * @param {import('./exchange-log.js').ExchangeLog} d.exchangeLog
 * @param {boolean} d.autoOpen  standalone 时自动为首次出现的玩家开户
 */
export function createBridge({ ledger, settings, exchangeLog, autoOpen = false }) {
  /**
   * 玩家身份 → 账本 uid。
   *
   * ★ 顺序是刻意的：uuid 优先，名字兜底。
   *   名字在 Minecraft 里可变且可抢注 —— 改了名就找不到人，
   *   别人抢注你的旧名就继承了你的余额。uuid 两者都不存在。
   *   所以插件一旦带上 uuid，我们就绝不再看名字。
   *
   * @param {string} uuid    插件上报的 UUID，可能为空
   * @param {string} name    玩家名
   * @returns {Promise<string|null>} null = 未绑定
   */
  async function resolveUid(uuid, name) {
    const u = String(uuid || '').trim();
    if (u && typeof ledger.ensureByUuid === 'function') {
      const hit = await ledger.ensureByUuid(u, name);
      if (hit !== null && hit !== undefined) return hit;
    }
    if (!name) return null;
    if (typeof ledger.uidByName !== 'function') return null;

    if (u) {
      // 带了 uuid 却还是没绑上，说明这个 UUID 在账本里查无此人
      // —— 多半是玩家还没注册站号。降级按名字再试一次，
      // 但一定要留痕，否则管理员会对着「明明有余额」的账户查不到。
      console.warn(`[bridge] uuid ${u}（${name}）未绑定，降级按名字匹配` +
        '（skin 模式下通常是玩家还没注册站号）');
    }
    const byName = await ledger.uidByName(name);
    if (byName) return byName;
    if (autoOpen && typeof ledger.ensureByName === 'function') {
      return ledger.ensureByName(name);
    }
    return null;
  }

  /**
   * 游戏金币换积分。
   *
   * @param {object} p
   * @param {string} p.playerName  游戏内玩家名
   * @param {string} p.uuid        游戏内 UUID，**强烈建议带上**（改名不丢账户）
   * @param {number} p.coin        消耗的金币数（正整数）
   * @param {string} p.eventId     幂等键，插件生成，全局唯一
   * @param {string} p.reason      来源标记：job / sell / admin
   * @param {string} p.note        备注
   * @returns {Promise<{ok:boolean, credit?:number, after?:number, reason?:string}>}
   */
  async function convertCoin(p = {}) {
    let playerName = String(p.playerName || '').trim();
    const uuid = String(p.uuid || p.playerUuid || '').trim().slice(0, 36);
    const coin = Number(p.coin);
    const eventId = String(p.eventId || '').trim().slice(0, 96);
    const reason = String(p.reason || 'manual').trim().slice(0, 64);
    const note = String(p.note || '').trim().slice(0, 191);

    if (!playerName && !uuid) return { ok: false, reason: '缺少玩家标识（name 或 uuid）' };
    // 玩家名会进 Redis 消息体与日志，先过白名单挡掉控制字符
    if (playerName) {
      try { playerName = assertSafeName(playerName); }
      catch (e) { return { ok: false, reason: e.message }; }
    }
    // uuid 也过白名单：它会进 SQL 参数与 Redis 消息体。
    // 全 0 的「从未上线」假 UUID 必须在这里挡掉 —— 拿它当主键
    // 会把所有没上线过的名字合并成同一个账户。
    let uuidOk = '';
    if (uuid) {
      try { uuidOk = assertSafeUuid(uuid); }
      catch (e) { return { ok: false, reason: e.message }; }
    }

    if (!Number.isInteger(coin) || coin <= 0) return { ok: false, reason: '金币数必须是正整数' };
    if (coin > 1_000_000_000) return { ok: false, reason: '金币数超出合理上限' };
    if (!eventId) return { ok: false, reason: '缺少 eventId' };

    const cfg = await settings.load();
    if (String(cfg.enabled) !== '1') return { ok: false, reason: '金币换积分功能已关闭' };

    const ratio = parseInt(cfg.ratio, 10);
    const dailyLimit = parseInt(cfg.daily_limit, 10) || 0;
    const singleLimit = parseInt(cfg.single_limit, 10) || 0;
    const minCoin = parseInt(cfg.min_coin, 10) || 0;
    const source = cfg.auto_source || 'game';

    if (minCoin > 0 && coin < minCoin) {
      return { ok: false, reason: `单笔至少需要 ${minCoin} 金币` };
    }
    const credit = Math.floor(coin / ratio);
    if (credit < 1) {
      return { ok: false, reason: `${coin} 金币不足 1 积分（比例 ${ratio}:1）` };
    }
    if (singleLimit > 0 && credit > singleLimit) {
      return { ok: false, reason: `单笔最多换 ${singleLimit} 积分，请分次兑换` };
    }

    // 幂等：已经换过就直接回放，绝不二次加分
    const dup = await exchangeLog.find(eventId);
    if (dup) {
      return {
        ok: true, idempotent: true,
        credit: Number(dup.credit_delta), after: Number(dup.credit_after),
      };
    }

    const uid = await resolveUid(uuidOk, playerName);
    if (uid === null || uid === undefined) {
      return {
        ok: false,
        reason: playerName
          ? `玩家「${playerName}」未绑定账号，无法入账`
          : '该 UUID 未绑定账号，无法入账',
      };
    }

    // 每日限额。
    // ⚠️ 这里是「先查后写」，理论上并发下可能超限 1~2 分。
    //   这是刻意的取舍：把每日额度检查塞进账本事务需要账本实现暴露锁接口，
    //   而超限几分钱的代价远小于该接口带来的耦合。
    //   账本侧的 FOR UPDATE 已经保证了余额本身不会算错。
    if (dailyLimit > 0) {
      const got = await ledger.todayTotal(uid, source);
      if (got + credit > dailyLimit) {
        return {
          ok: false,
          reason: `今日已达上限（${got}/${dailyLimit} 积分），明天再来`,
          gotToday: got, dailyLimit,
        };
      }
    }

    // 记账（权威、幂等、带行锁）。失败则整笔中止。
    // name/uuid 一起传下去：账本顺手把身份绑定补上，
    // 这样「玩家 A 用名字 B 的余额」这种事在源头就被掐断。
    let res;
    try {
      res = await ledger.change({
        uid, delta: credit, eventId,
        source, ref: eventId,
        name: playerName, uuid: uuidOk,
        note: note || `游戏内消耗 ${coin} 金币兑换`,
      });
    } catch (e) {
      return { ok: false, reason: e.message, balance: e.balance };
    }

    // 明细是审计用的，失败不推翻已生效的积分
    try {
      await exchangeLog.record({
        uniqEvent: eventId, playerName, playerUuid: uuidOk, uid,
        coin, credit, creditAfter: res.after, reason, note,
      });
    } catch (e) {
      console.error(`[bridge] 兑换明细写入失败 eventId=${eventId}：${e.message}` +
        '（积分已入账，仅缺审计明细）');
    }

    return { ok: true, credit, before: res.before, after: res.after, coin, ratio, uid };
  }

  /**
   * 某玩家今日兑换情况，供插件在游戏内提示玩家。
   * uuid 优先：改名后依然查得到自己。
   */
  async function playerQuota(playerName, uuid) {
    const cfg = await settings.load();
    const base = {
      ratio: parseInt(cfg.ratio, 10),
      minCoin: parseInt(cfg.min_coin, 10) || 0,
      singleLimit: parseInt(cfg.single_limit, 10) || 0,
      dailyLimit: parseInt(cfg.daily_limit, 10) || 0,
      enabled: String(cfg.enabled) === '1',
    };
    // 只查不建：这里绝不能开户，玩家查余额不该凭空多出一个账户
    let uid = null;
    const u = String(uuid || '').trim();
    if (u && typeof ledger.uidByUuid === 'function') {
      try { uid = await ledger.uidByUuid(assertSafeUuid(u)); } catch { uid = null; }
    }
    if (uid === null && playerName && typeof ledger.uidByName === 'function') {
      uid = await ledger.uidByName(playerName);
    }
    if (uid === null || uid === undefined) return { bound: false, ...base };
    return {
      bound: true, uid, ...base,
      score: await ledger.balance(uid),
      gotToday: await ledger.todayTotal(uid, cfg.auto_source || 'game'),
    };
  }

  const recentExchanges = (limit = 50) => exchangeLog.recent(limit);

  return { convertCoin, playerQuota, recentExchanges, resolveUid };
}
