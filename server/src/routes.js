/**
 * HTTP 路由。
 *
 * 全部面向 rt.ledger / rt.settings / rt.bridge 接口，**没有一行裸 SQL**。
 * 换后端时这个文件一个字都不用改 —— 这就是模块化要的效果。
 */

import express from 'express';
import { auth } from './auth.js';
import { ASSET, ASSET_LIST, ASSET_META, assertSafeName, assertSafeInt, assertSafeUuid } from './assets.js';
import { CONFIG_LABELS, DEFAULTS } from './settings.js';
import { runtimeInfo, healthCheck } from './runtime.js';

/**
 * @param {object} rt createRuntime() 的返回值
 */
export function createRoutes(rt) {
  const { ledger, settings, bridge, queue } = rt;
  const api = express.Router();
  api.use(auth);

  /** 把内部错误翻译成合适的 HTTP 状态码。 */
  const fail = (res, e) => {
    if (res.headersSent) return;
    const status = e.status || (/不存在/.test(e.message) ? 404 : 400);
    res.status(status).json({ error: e.message, balance: e.balance });
  };

  /* ── 元信息：前端据此决定显示哪些页签 ────────────────────── */
  api.get('/meta', async (req, res) => {
    const h = await healthCheck(rt);
    res.json({
      ...runtimeInfo,
      ok: h.ok,
      storage: h.storage,
      detail: h.detail,
      sources: ledger.sources(),
      configLabels: CONFIG_LABELS,
      configDefaults: DEFAULTS,
      assets: ASSET_LIST.map((a) => ({ key: a, ...ASSET_META[a] })),
    });
  });

  /* ── 账户列表 ──────────────────────────────────────────── */
  api.get('/users', async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
      const kw = String(req.query.kw || '').trim();
      res.json(await ledger.list({ kw, page, size }));
    } catch (e) { next(e); }
  });

  /* ── 单账户详情 + 流水 ─────────────────────────────────── */
  api.get('/users/:uid', async (req, res, next) => {
    try {
      const uid = req.params.uid;
      if (!await ledger.exists(uid)) {
        return res.status(404).json({ error: `账户 ${uid} 不存在` });
      }
      const [list, logs] = await Promise.all([
        ledger.list({ kw: String(uid), size: 100 }),
        ledger.logs(uid, 100),
      ]);
      // exists() 已确认存在，list 里的第一条就是目标
      const user = list.rows.find((r) => String(r.uid) === String(uid)) || list.rows[0];
      res.json({ user, logs });
    } catch (e) { next(e); }
  });

  /* ── 改积分：唯一的写入口 ────────────────────────────────
   * 约束由账本实现保证（事务+行锁 / event_id 幂等 / 余额从库读 /
   * 绝不写成负数），这里只做入参校验。 */
  api.post('/users/:uid/score', async (req, res, next) => {
    try {
      const uid = req.params.uid;
      const delta = Number(req.body?.delta);
      const note = String(req.body?.note || '').trim().slice(0, 180);
      const eventId = String(req.body?.eventId || '').trim().slice(0, 80);

      if (!Number.isInteger(delta) || delta === 0) {
        return res.status(400).json({ error: 'delta 必须是非 0 整数' });
      }
      if (Math.abs(delta) > 10_000_000) {
        return res.status(400).json({ error: '单次变动超过上限 1000 万' });
      }
      if (!eventId) return res.status(400).json({ error: '缺少 eventId' });

      const r = await ledger.change({ uid, delta, eventId, source: 'admin', note: note || '管理员手动调整' });
      res.json(r);
    } catch (e) { fail(res, e); }
  });

  /* ── 新建账户（仅本地账本；皮肤站账户由注册流程产生）───── */
  api.post('/users', async (req, res, next) => {
    try {
      if (runtimeInfo.hasSkin) {
        return res.status(400).json({ error: '皮肤站模式下账户由注册流程创建，不能手工添加' });
      }
      const uid = String(req.body?.uid || '').trim();
      const name = String(req.body?.name || uid).trim();
      const acc = await ledger.create({ uid, name });
      res.json({ ok: true, user: acc });
    } catch (e) { fail(res, e); }
  });

  /* ── 全站流水：支持 来源 / 玩家 / 时间范围 三类条件 ─────── */
  api.get('/ledger', async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const size = Math.min(200, Math.max(1, Number(req.query.size) || 30));
      const source = String(req.query.source || '').trim();
      const kw = String(req.query.kw || '').trim().slice(0, 64);
      const from = String(req.query.from || '').trim();
      const to = String(req.query.to || '').trim();
      res.json(await ledger.all({ page, size, source, kw, from, to }));
    } catch (e) { next(e); }
  });

  /* ── 玩家名候选：输入前缀即出下拉项 ──────────────────────
   * 管理员只记得名字开头几个字母是常态，所以候选是**前缀匹配**。
   * 返回空数组时前端退化为自由输入，不影响查询。 */
  api.get('/players/suggest', async (req, res, next) => {
    try {
      const kw = String(req.query.kw || '').trim();
      if (!kw) return res.json({ rows: [] });
      if (typeof ledger.nameSuggest !== 'function') return res.json({ rows: [] });
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      res.json({ rows: await ledger.nameSuggest(kw, limit) });
    } catch (e) { next(e); }
  });

  /* ── 金币回流：状态与手工触发 ─────────────────────────── */
  /* 状态与统计挂在 /stats 里一起返回（下面改），这里只提供手工入口。 */
  api.get('/reflow/status', async (req, res, next) => {
    try {
      const cfg = await settings.load();
      const depths = await queue.depths().catch(() => ({ asset: -1, event: -1 }));
      res.json({
        ...rt.reflow.snapshot(),
        config: {
          enabled: String(cfg.reflow_enabled || '0') === '1',
          dailyLimit: parseInt(cfg.reflow_daily_limit, 10) || 0,
          ratio: parseInt(cfg.ratio, 10),
        },
        queue: depths,
      });
    } catch (e) { next(e); }
  });

  /**
   * 手工投一条回流事件。
   *
   * 存在的意义：**中端件没有游戏服也能端到端验证回流链路**，
   * 以及线上排查「玩家说没收到积分」时，可以照着插件日志里的
   * event_id 手工补发一次（幂等键相同，所以只会补一次）。
   */
  api.post('/reflow/simulate', async (req, res, next) => {
    try {
      const player = assertSafeName(req.body?.player);
      const uuid = req.body?.uuid ? assertSafeUuid(String(req.body.uuid)) : '';
      const coin = assertSafeInt(req.body?.coin, '金币数');
      if (coin <= 0) return res.status(400).json({ error: '金币数必须为正整数' });

      const cfg = await settings.load();
      const ratio = parseInt(cfg.ratio, 10) || 1000;
      const dailyLimit = parseInt(cfg.reflow_daily_limit, 10) || 0;

      // ★ credit 允许显式指定：
      //   真实插件上报的 credit 来自**它自己的**比例，与本服务未必一致 ——
      //   两边配置漂移正是这里要检测的东西。留这个口子才能
      //   （a）测试比例漂移检测，（b）线上照插件日志手工补发。
      const hasCredit = req.body?.credit !== undefined && req.body?.credit !== null;
      const credit = hasCredit
        ? assertSafeInt(req.body.credit, '积分数')
        : Math.floor(coin / ratio);
      if (credit < 1) {
        return res.status(400).json({
          error: hasCredit
            ? `积分数非法：${req.body.credit}`
            : `${coin} 金币不足 1 积分（比例 ${ratio}:1）`,
        });
      }

      const eventId = String(req.body?.eventId || '').trim()
        || `rf:${uuid.replace(/-/g, '') || player}:${Date.now()}`;

      // 直接进 handle 而不是走 Redis：这条是「补发」，必须立刻知道结果。
      // 走队列反而可能卡在队列里，玩家继续等。
      const r = await rt.reflow.handle({
        event_id: eventId, player, uuid, asset: 'coin',
        delta: coin, credit, balance_after: -1, ts: Date.now(),
      }, { ratio, dailyLimit });

      res.status(r.ok ? 200 : 400).json({ ...r, eventId, ratio, requestedCoin: coin });
    } catch (e) { fail(res, e); }
  });

  /* ── 概览 ────────────────────────────────────────────── */
  api.get('/stats', async (req, res, next) => {
    try {
      const [stats, list, depths] = await Promise.all([
        ledger.stats(),
        ledger.list({ size: 10, page: 1 }),
        queue.depths().catch(() => ({ asset: -1, event: -1 })),
      ]);
      // 「余额榜」= 按余额倒序。ledger.list 是按 uid 升序，
      // 两个后端的 uid 语义不同（数字 vs 字符串），所以在应用层排。
      const top = [...list.rows].sort((a, b) => Number(b.score) - Number(a.score)).slice(0, 10);
      const cfg = await settings.load();
      res.json({
        ...stats, top, queue: depths,
        reflow: {
          ...rt.reflow.snapshot(),
          configEnabled: String(cfg.reflow_enabled || '0') === '1',
          dailyLimit: parseInt(cfg.reflow_daily_limit, 10) || 0,
        },
      });
    } catch (e) { next(e); }
  });

  /* ── 配置：比例 / 限额，后台可改 ───────────────────────── */
  api.get('/config', async (req, res, next) => {
    try {
      const cfg = await settings.load();
      res.json({ config: cfg, labels: CONFIG_LABELS, defaults: DEFAULTS });
    } catch (e) { next(e); }
  });

  api.put('/config', async (req, res, next) => {
    try {
      const cfg = await settings.save(req.body || {});
      res.json({ ok: true, config: cfg });
    } catch (e) { fail(res, e); }
  });

  /* ── 资产下发：给游戏内金币 / 点券增减 ──────────────────────
   *
   * ★ coin / points 的真身在游戏服，中间件改了数据库也没用。
   *   这里只把指令写进 Redis 队列，由插件 BRPOP 取出后在主线程执行。
   *   所以本接口返回「已入队」而不是「已生效」—— 真正的结果由插件回执。 */
  api.post('/assets/adjust', async (req, res, next) => {
    try {
      const asset = String(req.body?.asset || '').trim();
      if (!ASSET_LIST.includes(asset)) {
        return res.status(400).json({ error: `未知资产 ${asset}` });
      }
      // 玩家名仍必填 —— 它是要拼进控制台指令的那一份；
      // uuid 是身份锚点，用来查账本。两者角色不同，不能互相替代。
      const player = assertSafeName(req.body?.player);
      const delta = assertSafeInt(req.body?.delta, '变动值');
      if (delta === 0) return res.status(400).json({ error: '变动值不能为 0' });
      if (Math.abs(delta) > 100_000_000) {
        return res.status(400).json({ error: '单次变动超过上限 1 亿' });
      }
      const note = String(req.body?.note || '').trim().slice(0, 120);
      const eventId = String(req.body?.eventId || '')
        .trim() || `admin:${asset}:${player}:${Date.now()}`;

      // uuid 可选：有就带上（改名后依然命中同一人），没有就按名字查
      let uuid = '';
      const raw = String(req.body?.uuid || '').trim();
      if (raw) {
        try { uuid = assertSafeUuid(raw); }
        catch (e) { return res.status(400).json({ error: e.message }); }
      }

      if (asset === ASSET.CREDIT) {
        // 积分是唯一能直写的资产。
        // ★ 这里只查不建：管理员手动给分不该凭空造出一个账户
        //   （bridge.resolveUid 在 standalone 下会自动开户，那是给
        //   游戏内消费用的，不该套用到管理台的手动操作上）。
        let uid = null;
        if (uuid && typeof ledger.uidByUuid === 'function') uid = await ledger.uidByUuid(uuid);
        if (uid === null && typeof ledger.uidByName === 'function') {
          uid = await ledger.uidByName(player);
        }
        if (uid === null || uid === undefined) {
          return res.status(404).json({ error: `查不到玩家「${player}」对应的积分账户` });
        }
        const r = await ledger.change({
          uid, delta, eventId, source: 'admin',
          name: player, uuid,
          note: note || '管理员调整',
        });
        return res.json({ ok: true, applied: true, ...r });
      }

      const r = await queue.pushAsset({ eventId, player, uuid, asset, delta, note });
      if (!r.queued) return res.status(503).json({ error: r.reason });
      res.json({
        ok: true, applied: false, queued: true, eventId,
        message: '指令已入队，等待游戏服插件执行；实际生效以插件回执为准',
      });
    } catch (e) { fail(res, e); }
  });

  /* ── 金币换积分：供插件 HTTP 回调 / 手工测试 ─────────────── */
  api.post('/game/convert', async (req, res, next) => {
    try {
      const r = await bridge.convertCoin(req.body || {});
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) { fail(res, e); }
  });

  api.get('/game/quota', async (req, res, next) => {
    try {
      res.json(await bridge.playerQuota(
        String(req.query.player || '').trim(),
        String(req.query.uuid || '').trim(),
      ));
    } catch (e) { next(e); }
  });

  api.get('/game/exchanges', async (req, res, next) => {
    try {
      res.json({ rows: await bridge.recentExchanges(Number(req.query.limit) || 50) });
    } catch (e) { next(e); }
  });

  return api;
}
