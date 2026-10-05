/**
 * 账本抽象 —— 低耦合的核心。
 *
 * 系统管理三类资产，但它们的**真身**在不同地方：
 *
 *   credit  积分   真身在账本（皮肤站 MySQL，或本地 JSONL）—— 权威账本
 *   coin    游戏金币  真身在游戏服（经济插件）    —— 中间件碰不到
 *   points  游戏点券  真身在游戏服（PlayerPoints）—— 中间件碰不到
 *
 * 所以「账本」有两个实现：
 *
 *   SkinLedger        写 MySQL。装了皮肤站时用，能与论坛/抽奖等既有链路共享账本。
 *   StandaloneLedger  写本地 JSONL。**没装皮肤站也能用** —— 这是本项目
 *                     能在纯 Minecraft 服务器上独立运行的原因。
 *
 * ★ 这就是「低耦合」的落点：中间件对皮肤站没有任何硬依赖，
 *   皮肤站只是一个可选的 Ledger 实现。删掉它，其余功能照常。
 *
 * ────────────────────────────────────────────────────────────────
 * 身份：为什么用 UUID 而不是玩家名
 *
 * 玩家名在 Minecraft 里**可变**，而且任何人都能抢注：
 *   · 玩家改了名 → 按名字记账就找不到人了，余额"丢了"
 *   · 别人改名叫你的旧名 → 直接继承了你的余额
 *
 * UUID 由服务器在玩家首次进服时生成，不可变也不可伪造，
 * 离线模式（cracked）下同样稳定。所以账本的**主键必须是 UUID**，
 * 玩家名只作为可变的显示名存在，改名不影响账户。
 *
 * 插件侧上报一律带 uuid；uuid 缺失时（老版本插件 / 无法取到时）
 * 退回按名字查并在日志里提示 —— 那条路径是降级，不是常态。
 *
 * 身份能力的统一约定（**基类不声明，靠 typeof 探测**）：
 *   uidByUuid(uuid)          uuid → 账本 uid，查不到返回 null
 *   ensureByUuid(uuid, name)  uuid → uid，不存在则按后端能力开户
 *   uidByName(name)          名字 → uid（降级路径 / 皮肤站 players 表）
 *   nameSuggest(kw, limit)   名字前缀候选，供管理台搜索下拉
 *
 * 实现约定：
 *   - change() 要么成功并返回新余额，要么抛错，**不允许静默部分成功**
 *   - 幂等由实现自己保证（同一 eventId 重复调用不重复计账）
 *   - 身份相关能力用 `typeof x.uidByUuid === 'function'` 探测，
 *     不要塞进基类
 */

export class Ledger {
  /**
   * 记一笔账。
   * @param {{uid:string, delta:number, eventId:string, source:string, ref?:string, note?:string}} e
   * @returns {Promise<{ok:boolean, before?:number, after:number, idempotent?:boolean}>}
   */
  async change(e) { throw new Error('未实现 change()'); }

  /** 查余额。不存在返回 0。 */
  async balance(uid) { throw new Error('未实现 balance()'); }

  /** 账户是否存在。 */
  async exists(uid) { throw new Error('未实现 exists()'); }

  /** 列出账户（分页）。返回 { total, page, size, rows }。 */
  async list({ kw = '', page = 1, size = 20 } = {}) {
    return { total: 0, page, size, rows: [] };
  }

  /**
   * 名字 / uid / uuid 前缀候选，供管理台搜索框的下拉提示。
   * 纯建议接口：实现不了就返回空数组，调用方会退化为自由输入。
   */
  async nameSuggest(kw, limit = 20) { return []; }

  /** 某账户流水（倒序）。 */
  async logs(uid, limit = 100) { return []; }

  /**
   * 全站流水（倒序分页）。
   * @param {object} q
   * @param {string} q.source  来源精确匹配，空 = 全部
   * @param {string} q.kw      玩家名 / uid / uuid 模糊匹配，空 = 全部
   * @param {string} q.from    起始时间 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:mm:ss'
   * @param {string} q.to      截止时间，同上；只给日期时含当天 23:59:59
   */
  async all({ page = 1, size = 30, source = '', kw = '', from = '', to = '' } = {}) {
    return { total: 0, page, size, rows: [] };
  }

  /** 全站统计，供概览页。 */
  async stats() {
    return { accounts: 0, total: 0, todayPlus: 0, todayMinus: 0, todayOps: 0 };
  }

  /** 建账户。只在 standalone 有意义（skin 的账户由皮肤站注册流程产生）。 */
  async create() { throw new Error('当前账本不支持建账户'); }

  /** 可用来源标记，供前端筛选下拉。 */
  sources() { return ['admin', 'game', 'exchange']; }

  /** 实现标识，诊断用。 */
  get kind() { return 'abstract'; }

  /** 人读的名字，启动横幅用。 */
  get label() { return '抽象账本'; }
}

/**
 * 把前端的日期/时间筛选值规整成可直接比较的 'YYYY-MM-DD HH:mm:ss'。
 *
 * ★ 为什么统一在这里做，而不是让两个账本各写一份：
 *   JSONL 存的是 ISO（`2026-10-04T12:00:00.000Z`），MySQL 存的是
 *   DATETIME，两者比较方式完全不同；而且只给日期时，
 *   「到 10-04」必须含当天 23:59:59，否则查「今天」返回空 ——
 *   这是时间筛选最常见的 bug。规则只写一遍，两个后端行为必然一致。
 *
 * @returns {{from:string,to:string}|null}  全空返回 null
 */
export function parseTimeRange(from, to) {
  const norm = (v, endOfDay) => {
    const s = String(v || '').trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} ${endOfDay ? '23:59:59' : '00:00:00'}`;
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      return s.replace('T', ' ').slice(0, 19).padEnd(19, '0');
    }
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(s)) {
      return s.replace('T', ' ').replace('Z', '').slice(0, 19);
    }
    return '';   // 认不出的格式一律当没填，绝不把整表查空
  };
  const f = norm(from, false);
  const t = norm(to, true);
  return f || t ? { from: f, to: t } : null;
}
