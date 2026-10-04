/**
 * 皮肤站账本：写 MySQL。
 *
 * 与 {@link StandaloneLedger} 实现同一套接口，所以上层业务代码
 * 完全不关心用的是哪个 —— 这是模块化的意义。
 *
 * ★ 三条不可破的约束（每一条都对应一类真实事故）：
 *   1. 事务 + SELECT ... FOR UPDATE 行锁，杜绝并发读改写的丢失更新
 *   2. event_id 唯一索引做幂等，重复提交不重复计账
 *   3. 余额从库里读，不信任调用方传的 balance_after
 */

import { pool } from './db.js';
import { Ledger, parseTimeRange } from './ledger.js';

/** Bukkit 对「从未上线过的名字」返回的 UUID，拿它当主键会把不同玩家合并。 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export class SkinLedger extends Ledger {
  constructor() {
    super();
    this.pool = pool;
  }

  get kind() { return 'skin'; }
  get label() { return '皮肤站积分（MySQL）'; }

  async change({ uid, delta, eventId, source, ref, note }) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      // 幂等：同一 eventId 已处理过就回放结果
      const [[dup]] = await conn.query(
        'SELECT delta, balance_after FROM credit_ledger WHERE event_id = ?',
        [eventId],
      );
      if (dup) {
        await conn.rollback();
        return {
          ok: true, idempotent: true,
          before: Number(dup.balance_after) - Number(dup.delta),
          after: Number(dup.balance_after),
        };
      }

      const [[user]] = await conn.query(
        'SELECT uid, score FROM users WHERE uid = ? FOR UPDATE',
        [uid],
      );
      if (!user) {
        await conn.rollback();
        const e = new Error(`uid ${uid} 在账本中不存在`);
        e.status = 404;
        throw e;
      }

      const before = Number(user.score);
      const after = before + delta;
      if (after < 0) {
        await conn.rollback();
        const e = new Error(`余额不足：当前 ${before}，本次 ${delta}`);
        e.balance = before;
        throw e;
      }

      await conn.query('UPDATE users SET score = ? WHERE uid = ?', [after, uid]);
      await conn.query(
        `INSERT INTO credit_ledger
           (event_id, uid, delta, balance_after, source, ref, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [eventId, uid, delta, after, source || 'admin', ref || null, note || ''],
      );

      await conn.commit();
      return { ok: true, before, after };
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  async balance(uid) {
    const [[r]] = await this.pool.query('SELECT score FROM users WHERE uid = ?', [uid]);
    return r ? Number(r.score) : 0;
  }

  async exists(uid) {
    const [[r]] = await this.pool.query('SELECT 1 AS x FROM users WHERE uid = ?', [uid]);
    return !!r;
  }

  async list({ kw = '', page = 1, size = 20 } = {}) {
    // 条件里显式带 u. 前缀：下面 JOIN 了 bridge_identity，不加前缀会有歧义
    const where = kw
      ? 'WHERE u.nickname LIKE ? OR u.email LIKE ? OR CAST(u.uid AS CHAR) = ?'
      : '';
    const args = kw ? [`%${kw}%`, `%${kw}%`, kw] : [];
    const [[{ total }]] = await this.pool.query(
      `SELECT COUNT(*) AS total FROM users u ${where}`, args,
    );
    const [rows] = await this.pool.query(
      `SELECT u.uid, u.email, u.nickname, u.score, u.permission, u.verified,
              b.mc_uuid AS uuid,
              DATE_FORMAT(u.register_at, '%Y-%m-%d %H:%i') AS register_at
         FROM users u
         LEFT JOIN bridge_identity b ON b.uid = u.uid
         ${where}
         ORDER BY u.uid ASC LIMIT ? OFFSET ?`,
      [...args, size, (page - 1) * size],
    );
    return { total: Number(total), page, size, rows };
  }

  async logs(uid, limit = 100) {
    const [rows] = await this.pool.query(
      `SELECT id, event_id, delta, balance_after, source, ref, note,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM credit_ledger WHERE uid = ? ORDER BY id DESC LIMIT ?`,
      [uid, Math.min(500, limit)],
    );
    return rows;
  }

  async all({ page = 1, size = 30, source = '', kw = '', from = '', to = '' } = {}) {
    const where = [];
    const args = [];
    if (source) { where.push('l.source = ?'); args.push(source); }

    if (kw) {
      // 玩家名模糊 + uid 精确/前缀。uuid 走 bridge_identity 映射，
      // 这样「我记得他的 UUID」也能查得到 —— 服主排查问题时的真实需求。
      where.push(`(
        u.nickname LIKE ? OR CAST(l.uid AS CHAR) LIKE ?
        OR EXISTS (SELECT 1 FROM bridge_identity b
                    WHERE b.uid = l.uid AND b.mc_uuid LIKE ?)
      )`);
      args.push(`%${kw}%`, `%${kw}%`, `${kw}%`);
    }

    const range = parseTimeRange(from, to);
    if (range?.from) { where.push('l.created_at >= ?'); args.push(range.from); }
    if (range?.to) { where.push('l.created_at <= ?'); args.push(range.to); }

    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[{ total }]] = await this.pool.query(
      `SELECT COUNT(*) AS total FROM credit_ledger l
         LEFT JOIN users u ON u.uid = l.uid ${sql}`, args,
    );
    const [rows] = await this.pool.query(
      `SELECT l.id, l.event_id, l.uid, u.nickname, u.email, l.delta,
              l.balance_after, l.source, l.note, l.ref,
              DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM credit_ledger l
         LEFT JOIN users u ON u.uid = l.uid
         ${sql}
        ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      [...args, size, (page - 1) * size],
    );
    return { total: Number(total), page, size, rows };
  }

  async stats() {
    const [[agg]] = await this.pool.query(
      `SELECT COUNT(*) AS accounts,
              COALESCE(SUM(score), 0) AS total,
              COALESCE(MAX(score), 0) AS max
         FROM users`,
    );
    const [[today]] = await this.pool.query(
      `SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS todayPlus,
              COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS todayMinus,
              COUNT(*) AS todayOps
         FROM credit_ledger WHERE created_at >= CURDATE()`,
    );
    return {
      accounts: Number(agg.accounts),
      total: Number(agg.total),
      max: Number(agg.max),
      todayPlus: Number(today.todayPlus),
      todayMinus: Number(today.todayMinus),
      todayOps: Number(today.todayOps),
    };
  }

  async todayTotal(uid, source) {
    const [[r]] = await this.pool.query(
      `SELECT COALESCE(SUM(delta), 0) AS s
         FROM credit_ledger
        WHERE uid = ? AND source = ? AND delta > 0 AND created_at >= CURDATE()`,
      [uid, source],
    );
    return Number(r.s);
  }

  /**
   * 玩家名 → uid。
   * players 表是 Blessing Skin 内核建的（pid, uid, name）。
   * standalone 模式没有这个表，所以这不是接口的一部分，只在 skin 后端调用。
   *
   * ★ 这是**降级路径**。按名字认人在改名后失效、重名后更危险，
   *   所以只在拿不到 uuid 时才走，且调用方会打警告。
   */
  async uidByName(playerName) {
    const [[r]] = await this.pool.query(
      'SELECT uid FROM players WHERE name = ? LIMIT 1', [playerName],
    );
    return r ? Number(r.uid) : null;
  }

  /**
   * UUID → uid。中间件自建 bridge_identity 表做映射。
   * @returns {Promise<number|null>}
   */
  async uidByUuid(uuid) {
    const u = String(uuid || '').toLowerCase();
    if (!u || u === NIL_UUID) return null;
    const [[r]] = await this.pool.query(
      'SELECT uid FROM bridge_identity WHERE mc_uuid = ? LIMIT 1', [u],
    );
    return r ? Number(r.uid) : null;
  }

  /**
   * UUID → uid，找不到就按名字试着绑一次。
   *
   * ★ 皮肤站模式下**不自动开户** —— 账户由注册流程产生，
   *   中间件擅自建号会绕过邮箱验证那些流程。所以查不到就是查不到，
   *   返回 null 让上层报「该玩家还没绑定皮肤站账号」。
   *
   * 绑定成功后玩家改名也不影响：下次 uuid 直接命中映射表。
   */
  async ensureByUuid(uuid, playerName) {
    const u = String(uuid || '').toLowerCase();
    if (!u || u === NIL_UUID) return null;
    const hit = await this.uidByUuid(u);
    if (hit !== null) {
      // 顺带刷新名字，让改名也能被记录下来
      if (playerName) {
        await this.pool.query(
          'UPDATE bridge_identity SET player_name = ? WHERE mc_uuid = ?', [playerName, u],
        );
      }
      return hit;
    }
    if (!playerName) return null;
    const uid = await this.uidByName(playerName);
    if (uid === null || uid === undefined) return null;
    await this.pool.query(
      `INSERT INTO bridge_identity (mc_uuid, player_name, uid)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE player_name = VALUES(player_name)`,
      [u, playerName, uid],
    );
    return uid;
  }

  /**
   * 名字 / uid 前缀候选，供管理台搜索下拉。
   * 用 uid 前缀而非 uuid 前缀：管理员面对的是「站内的用户名」，
   * uuid 片段在 uid 列表里没有意义（站上没有 uuid 列）。
   */
  async nameSuggest(kw, limit = 20) {
    const k = String(kw || '').trim();
    if (!k) return [];
    const like = `${k}%`;
    const any = `%${k}%`;
    const [rows] = await this.pool.query(
      `SELECT uid, nickname FROM users
        WHERE nickname LIKE ? OR nickname LIKE ? OR CAST(uid AS CHAR) LIKE ?
        ORDER BY (nickname LIKE ?) DESC, nickname ASC
        LIMIT ?`,
      [like, any, like, like, Math.min(50, Math.max(1, Number(limit) || 20))],
    );
    return rows.map((r) => ({ uid: Number(r.uid), nickname: r.nickname, uuid: null }));
  }

  sources() { return ['admin', 'game', 'exchange']; }
}
