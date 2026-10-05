/**
 * 本地账本 —— standalone 后端。
 *
 * 数据放内存 + 追加落盘为 JSONL。特性：
 *   - 零外部依赖：不装 MySQL、不装皮肤站也能跑
 *   - JSONL 是 append-only，进程被 kill 也不会像「全量重写 JSON」那样丢数据
 *   - 启动时重放日志恢复状态
 *
 * 适用场景：纯 Minecraft 服务器、还没搭站点、或者只想先试用这套系统。
 * 之后想接皮肤站，改一个 BACKEND 环境变量即可，账本数据可以用
 * `tools/migrate-local-to-mysql.js` 搬过去。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Ledger, parseTimeRange } from './ledger.js';

/** 标准 UUID（8-4-4-4-12）。全 0 是 Bukkit 对「从未上线」的名字的返回值。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export class StandaloneLedger extends Ledger {
  /**
   * @param {string} dataDir  存放 *.accounts.jsonl / *.ledger.jsonl 的目录
   * @param {string} prefix   账本命名空间（多实例共用一目录时区分）
   */
  constructor(dataDir, prefix = 'default') {
    super();
    this.prefix = prefix;
    this.accounts = new Map();   // uid -> { uid, name, uuid, balance, createdAt }
    this.byUuid = new Map();     // uuid(小写) -> uid
    this.seen = new Set();       // eventId 幂等集合
    this.accFile = path.join(dataDir, `${prefix}.accounts.jsonl`);
    this.ledFile = path.join(dataDir, `${prefix}.ledger.jsonl`);
    this.seq = 0;                // 流水自增序号，替代 MySQL 的自增主键
  }

  async load() {
    fs.mkdirSync(path.dirname(this.accFile), { recursive: true });

    if (fs.existsSync(this.accFile)) {
      for (const line of fs.readFileSync(this.accFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const a = JSON.parse(line);
          this.accounts.set(String(a.uid), a);
          if (a.uuid) this.byUuid.set(String(a.uuid).toLowerCase(), String(a.uid));
        } catch { /* 跳过损坏行，不让一行坏数据毁掉整个恢复 */ }
      }
    }
    if (fs.existsSync(this.ledFile)) {
      for (const line of fs.readFileSync(this.ledFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const l = JSON.parse(line);
          this.seen.add(l.eventId);
          if (Number(l.id) > this.seq) this.seq = Number(l.id);
        } catch { /* 同上 */ }
      }
    }
    return this;
  }

  _append(file, obj) {
    // 同步追加：appendFileSync 保证写完才返回。
    // 异步写会在进程被 kill 时丢掉「已在内存里生效」的账 —— 那是最难查的一类丢账。
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  }

  async exists(uid) {
    return this.accounts.has(String(uid));
  }

  /**
   * 建户 / 更新显示名，并绑定 uuid。
   *
   * ★ uid 是账户主键，uuid 是**身份**，name 是**显示名** —— 三者角色不同：
   *   uid   建户那一刻定下来，之后永不变（历史流水都指着它）
   *   uuid  玩家的不可变身份，用来把「同一个人」认出来
   *   name  想改就改，改名不动账
   *
   * 旧数据（先于 uuid 时代）uid 就是玩家名。这里靠 ensureByUuid 的
   * 「认领」逻辑平滑升级：老账户保持原 uid，余额和历史一条不少。
   */
  async ensureAccount(uid, name, uuid) {
    const k = String(uid);
    const u = uuid ? String(uuid).toLowerCase() : '';
    let a = this.accounts.get(k);
    let dirty = false;

    if (!a) {
      a = { uid: k, name: name || k, uuid: null, balance: 0, createdAt: Date.now() };
      this.accounts.set(k, a);
      dirty = true;
    }
    if (name && a.name !== name) { a.name = name; dirty = true; }
    // ★ 索引登记必须放在这里无条件做，不能只在「uuid 变了」时做。
    //   新建账户时 a.uuid 是 null → 赋 u，走下面分支注册；
    //   但如果新建时就直接带上 uuid（上面构造对象时给了值），
    //   `a.uuid !== u` 就不成立，索引永远漏登记 ——
    //   表现是「刚建的账户按 uuid 查不到，只能靠名字，改名后彻底失联」。
    if (u) {
      if (a.uuid !== u) {
        // 同一 uuid 不该挂在两个 uid 上：那是「改名后被重名冒领」的信号。
        // 保守处理 —— 旧索引作废，新的绑定生效，余额各归各。
        if (this.byUuid.has(u) && this.byUuid.get(u) !== k) {
          console.warn(`[ledger] uuid ${u} 原绑定 uid=${this.byUuid.get(u)}，` +
            `现改绑 uid=${k}（疑似玩家改名后被他人冒名）`);
        }
        a.uuid = u;
        dirty = true;
      }
      this.byUuid.set(u, k);
    }
    if (dirty) this._append(this.accFile, a);
    return a;
  }

  /**
   * 对外形状统一。
   *
   * 内部用 name / balance（语义中性），但接口层一律输出
   * nickname / score —— 与皮肤站 users 表的列名对齐。
   * 这样前端组件在两种后端下写同一套字段，不必到处 if/else，
   * 而「统一输出形状」正是换后端不该波及上层的关键。
   */
  _shape(a) {
    return {
      uid: a.uid, nickname: a.name, name: a.name, uuid: a.uuid || null,
      score: a.balance, balance: a.balance,
      email: null, permission: null, verified: null, register_at: null,
    };
  }

  async create({ uid, name }) {
    const k = String(uid).trim();
    const isUuid = UUID_RE.test(k);
    if (!isUuid && !/^[A-Za-z0-9_-]{1,32}$/.test(k)) {
      throw new Error('uid 只允许标准 UUID，或字母/数字/下划线/短横线（1-32 位）');
    }
    if (this.accounts.has(k)) throw new Error(`账户 ${k} 已存在`);
    return this._shape(await this.ensureAccount(k, name, isUuid ? k : null));
  }

  async change({ uid, delta, eventId, source, ref, note, name, uuid }) {
    const k = String(uid);
    if (this.seen.has(eventId)) {
      const a = this.accounts.get(k);
      return { ok: true, idempotent: true, before: a?.balance ?? 0, after: a?.balance ?? 0 };
    }
    // name/uuid 是「顺带绑定」：调用方已经解析出 uid 时，
    // 把这次见到的名字和 uuid 一起登记，改名/首次上报就自动生效。
    const acc = await this.ensureAccount(k, name, uuid);
    const before = acc.balance;
    const after = before + delta;
    if (after < 0) {
      const e = new Error(`余额不足：当前 ${before}，本次 ${delta}`);
      e.balance = before;
      throw e;
    }

    // 先落盘流水再改内存：顺序反了会在崩溃时出现「有余额无流水」
    this._append(this.ledFile, {
      id: ++this.seq,
      eventId,
      uid: k,
      // 名字/UUID 快照：流水一旦写下就不该随改名而变
      name: acc.name,
      uuid: acc.uuid || null,
      delta,
      balanceAfter: after,
      source: source || 'admin',
      ref: ref || null,
      note: note || '',
      at: new Date().toISOString(),
    });
    acc.balance = after;
    this._append(this.accFile, acc);
    this.seen.add(eventId);

    return { ok: true, before, after };
  }

  async balance(uid) {
    return this.accounts.get(String(uid))?.balance ?? 0;
  }

  /* ── 身份解析 ────────────────────────────────────────────
   * 主路径：uuid。降级路径：玩家名。
   * 降级会打警告 —— 它是兼容老插件 / 取不到 uuid 的临时通路，
   * 不是常态，管理员应该尽快升级插件。 */

  /** uuid → uid。 */
  async uidByUuid(uuid) {
    const u = String(uuid || '').toLowerCase();
    if (!u || u === NIL_UUID) return null;
    return this.byUuid.get(u) || null;
  }

  /**
   * uuid → uid，找不到就开户。
   *
   * ★ 认领逻辑：老数据（uuid 时代之前）uid 就是玩家名。
   *   玩家第一次带 uuid 上报时，如果已存在「同名且未绑 uuid」的旧账户，
   *   就把 uuid 绑到那个旧账户上 —— 余额和历史一条不少。
   *   不这样做的话，每个老玩家升级后都会变成「余额 0 的新人」。
   */
  async ensureByUuid(uuid, name) {
    const u = String(uuid || '').toLowerCase();
    if (!u || u === NIL_UUID) return null;
    const hit = this.byUuid.get(u);
    if (hit) {
      await this.ensureAccount(hit, name, u);
      return hit;
    }
    // 认领：同名旧账户且尚未绑定 uuid
    if (name) {
      for (const a of this.accounts.values()) {
        if (String(a.name).toLowerCase() === String(name).toLowerCase() && !a.uuid) {
          await this.ensureAccount(a.uid, name, u);
          return a.uid;
        }
      }
    }
    // 全新账户：以 uuid 当主键
    await this.ensureAccount(u, name || u.slice(0, 8), u);
    return u;
  }

  /**
   * 玩家名 → uid。**降级路径**，uuid 不可用时才走。
   * 只按当前显示名精确匹配，不做前缀匹配 —— 前缀会撞名。
   */
  async uidByName(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return null;
    for (const a of this.accounts.values()) {
      if (String(a.name).toLowerCase() === n) return a.uid;
    }
    return null;
  }

  /** 按名字开户 —— 仅在拿不到 uuid 时使用（会打降级警告）。 */
  async ensureByName(name) {
    const uid = await this.uidByName(name);
    if (uid) return uid;
    const clean = String(name).trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
    if (!clean) return null;
    console.warn(`[ledger] 玩家「${name}」没有上报 uuid，按名字开户（降级路径，` +
      '请升级 exchange-bridge 插件并确认 uuid 上报已开启）');
    await this.ensureAccount(clean, clean);
    return clean;
  }

  /**
   * 前缀候选：名字 / uid / uuid 任一以 kw 开头。
   *
   * 用于管理台搜索框的下拉提示 —— 用户只记得名字开头几个字母时，
   * 不用把全名敲完。排序上「名字前缀命中」优先于「uuid 命中」，
   * 因为人记名字不记 uuid。
   */
  async nameSuggest(kw, limit = 20) {
    const k = String(kw || '').trim().toLowerCase();
    if (!k) return [];
    const hits = [];
    for (const a of this.accounts.values()) {
      const name = String(a.name || '').toLowerCase();
      const uid = String(a.uid || '').toLowerCase();
      const uuid = String(a.uuid || '').toLowerCase();
      const rank = name.startsWith(k) ? 0
        : a.name && a.name.toLowerCase().includes(k) ? 1
          : uuid.startsWith(k) ? 2
            : uid.startsWith(k) ? 3
              : uuid.includes(k) || uid.includes(k) ? 4
                : -1;
      if (rank < 0) continue;
      hits.push({ rank, uid: a.uid, nickname: a.name, uuid: a.uuid || null });
    }
    hits.sort((x, y) => (x.rank - y.rank) ||
      String(x.nickname).localeCompare(String(y.nickname)));
    return hits.slice(0, Math.min(50, Math.max(1, Number(limit) || 20)))
      .map(({ uid, nickname, uuid }) => ({ uid, nickname, uuid }));
  }

  async list({ kw = '', page = 1, size = 20 } = {}) {
    let rows = [...this.accounts.values()];
    if (kw) {
      const k = kw.toLowerCase();
      rows = rows.filter((r) =>
        String(r.uid).toLowerCase().includes(k) ||
        String(r.name).toLowerCase().includes(k) ||
        String(r.uuid || '').toLowerCase().includes(k));
    }
    rows.sort((a, b) => String(a.uid).localeCompare(String(b.uid)));
    const total = rows.length;
    return {
      total, page, size,
      rows: rows.slice((page - 1) * size, page * size).map((a) => this._shape(a)),
    };
  }

  /** 倒序读流水文件。需要时才碰磁盘，内存占用与流水总量无关。 */
  _readLedger() {
    if (!fs.existsSync(this.ledFile)) return [];
    return fs.readFileSync(this.ledFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  async logs(uid, limit = 100) {
    const rows = this._readLedger().reverse().filter((l) => l.uid === String(uid));
    return rows.slice(0, Math.min(500, limit)).map((l) => this._shapeLog(l));
  }

  /**
   * 流水的对外形状同样统一：
   *   内部 balanceAfter / at  →  接口 balance_after / created_at
   * 与 credit_ledger 的列名一致，前端表格不用分后端。
   */
  _shapeLog(l) {
    const acc = this.accounts.get(String(l.uid));
    return {
      id: l.id,
      event_id: l.eventId,
      uid: l.uid,
      nickname: l.name || acc?.name || l.uid,
      uuid: l.uuid || acc?.uuid || null,
      email: null,
      delta: l.delta,
      balance_after: l.balanceAfter,
      source: l.source,
      ref: l.ref,
      note: l.note,
      created_at: this._time(l.at),
    };
  }

  /**
   * ISO → 'YYYY-MM-DD HH:mm:ss'。
   *
   * ★ 流水里额外存一份 name/uuid 快照，是为了让**历史流水显示的是当时的
   *   名字**。玩家改名后，历史记录不该跟着变 —— 否则管理员查「上个月谁
   *   刷的分」会看到一个现在根本不存在的名字。
   *   老数据没有快照就回落到当前账户名。
   */
  _time(at) {
    return String(at).replace('T', ' ').slice(0, 19);
  }

  async all({ page = 1, size = 30, source = '', kw = '', from = '', to = '' } = {}) {
    let rows = this._readLedger().reverse();
    if (source) rows = rows.filter((l) => l.source === source);

    const range = parseTimeRange(from, to);
    if (range) {
      rows = rows.filter((l) => {
        const t = this._time(l.at);
        return (!range.from || t >= range.from) && (!range.to || t <= range.to);
      });
    }

    if (kw) {
      // 名字 / uid / uuid 都能搜。
      // 搜 uuid 片段时先试精确匹配整条流水记录的 uuid —— 只查账户表会漏掉
      // 「账户已删但流水还在」的历史记录。
      const k = kw.toLowerCase();
      const uidSet = new Set(
        [...this.accounts.values()]
          .filter((a) => String(a.name).toLowerCase().includes(k)
            || String(a.uid).toLowerCase().includes(k)
            || String(a.uuid || '').toLowerCase().includes(k))
          .map((a) => String(a.uid)),
      );
      rows = rows.filter((l) => uidSet.has(String(l.uid))
        || String(l.name || '').toLowerCase().includes(k)
        || String(l.uuid || '').toLowerCase().includes(k));
    }

    const shaped = rows.map((l) => this._shapeLog(l));
    return { total: shaped.length, page, size, rows: shaped.slice((page - 1) * size, page * size) };
  }

  async stats() {
    const accounts = [...this.accounts.values()];
    const today = new Date().toISOString().slice(0, 10);
    let plus = 0, minus = 0, ops = 0;
    for (const l of this._readLedger()) {
      if (String(l.at).slice(0, 10) !== today) continue;
      if (l.delta > 0) plus += l.delta; else minus += -l.delta;
      ops++;
    }
    return {
      accounts: accounts.length,
      total: accounts.reduce((s, a) => s + a.balance, 0),
      max: accounts.reduce((s, a) => Math.max(s, a.balance), 0),
      todayPlus: plus, todayMinus: minus, todayOps: ops,
    };
  }

  /** 今日某 uid 通过 source 获得的总额，防刷限额用。 */
  async todayTotal(uid, source) {
    const today = new Date().toISOString().slice(0, 10);
    let s = 0;
    for (const l of this._readLedger()) {
      if (l.uid !== String(uid)) continue;
      if (l.source !== source) continue;
      if (String(l.at).slice(0, 10) !== today) continue;
      if (l.delta > 0) s += l.delta;
    }
    return s;
  }

  sources() { return ['admin', 'game', 'exchange']; }
  get kind() { return 'standalone'; }
  get label() { return '本地账本（无数据库）'; }
}
