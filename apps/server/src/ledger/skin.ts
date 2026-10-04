/**
 * `skin` 账本：Blessing Skin 的 `users.score` + `credit_ledger`。
 *
 * 这是**默认**后端 —— 皮肤站是本生态里既定的唯一账本。
 *
 * <h2>怎么访问皮肤站的账本</h2>
 *
 * 三条路都考虑过：
 *
 *   1. **直连 MySQL** —— 皮肤站的 MariaDB 只监听 `127.0.0.1:3306`，
 *      平台在另一台机器上根本连不到。要么把数据库暴露到公网（危险），
 *      要么为每个部署开 SSH 隧道（运维负担）。**不选**。
 *
 *   2. **用 `kokuu-credit` 已有的 `/api/earn`、`/api/balance`** ——
 *      它们是 HMAC 签名、服务端到服务端可调的，但：
 *        - 按 **email** 定位账号，而平台存的是 `bs_uid` / `nickname`，**没有玩家邮箱**；
 *        - `earn` 只加分，行政调整需要能扣分；
 *        - 有 `max_per_event` / `max_per_day` 这类为论坛事件设的上限。
 *      **不够用**。
 *
 *   3. **给 `kokuu-credit` 补三个按 uid 寻址的签名接口** ← **本实现走这条**。
 *      它的 `bootstrap.php` 里已经有全部零件：HMAC 校验函数、`credit_ledger` 表、
 *      以及 `POST /api/adjust` 里那套 event_id 幂等写法。
 *      照抄那三个「管理员会话版」路由、把鉴权换成 HMAC 即可，改动很小，
 *      而且**不需要暴露数据库、不需要隧道**。
 *
 * <h2>需要在皮肤站补的契约</h2>
 *
 * 三者都在 `plugin/kokuu-credit/api/admin/` 下，请求体带
 * `ts` / `nonce` / `sign`，`sign = hmac_sha256(secret, payload)`，
 * payload 是把下面列出的字段用 `.` 连接（沿用现有 `kokuu_credit_verify` 的风格）。
 * 时间戳偏差超过 `ttl`（默认 300 秒）一律拒绝；`nonce` 去重防重放。
 *
 * ```text
 * POST …/api/admin/users     payload = ts.nonce.kw.page.size
 *      → { code:0, total, items:[{ uid, nickname, score }] }
 *
 * POST …/api/admin/ledger    payload = ts.nonce.uid.source.limit
 *      → { code:0, total, items:[{ id, uid, delta, balance_after, source, ref, note, created_at }] }
 *
 * POST …/api/admin/adjust    payload = ts.nonce.event_id.uid.delta.source
 *      体还需 note；uid 为 0 时用 email 定位
 *      → { code:0, balance, ledger_id }
 *      幂等：event_id 唯一索引；重复投递回 { code:0, duplicate:true } 而不是报错
 * ```
 *
 * 在皮肤站补完之前，{@link SkinLedger.status} 会报 `available:false` 并说明原因，
 * 界面据此显示说明 —— **不是**报错。
 */

import { createHmac, randomUUID } from 'node:crypto';

import type { Config } from '../config.ts';
import type { LedgerRow, EconomyAccountRow, BalanceChange, BalanceResult } from '../store/index.ts';
import {
  LedgerUnavailableError,
  type Ledger,
  type LedgerAccountPage,
  type LedgerEntryPage,
  type LedgerStatus,
  type LedgerCapabilities,
} from './index.ts';

/** UUID 与皮肤站 uid 的互查。由 `characters` 表提供（那一列叫 `bs_uid`）。 */
export interface IdentityIndex {
  /** MC UUID → 皮肤站 uid；找不到返回 null。 */
  uidByUuid(uuid: string): number | null;
  /** 皮肤站 uid → MC UUID；找不到返回 null。 */
  uuidByUid(uid: number): string | null;
}

/**
 * 补完之前，皮肤站侧还缺这三个接口 —— 能力表如实反映这一点，
 * 界面就不会给出「能改余额」这种点了必然失败的入口。
 */
const CAPABILITIES_PENDING: LedgerCapabilities = {
  listAccounts: false,
  readAccount: false,
  adjust: false,
  listLedger: false,
  stats: false,
  config: false,
};

/** 接口就绪后应当上报的能力。 */
const CAPABILITIES_READY: LedgerCapabilities = {
  listAccounts: true,
  readAccount: true,
  adjust: true,
  listLedger: true,
  stats: true,
  // 兑换比例与限额由皮肤站的 kokuu-exchange 管，平台不该在这里改 ——
  // 两个地方都能改就会出现「谁最后写谁赢」。
  config: false,
};

export class SkinLedger implements Ledger {
  readonly backend = 'skin' as const;

  private readonly config: Config;
  private readonly identity: IdentityIndex;

  constructor(config: Config, identity: IdentityIndex) {
    this.config = config;
    this.identity = identity;
  }

  status(): LedgerStatus {
    const base = {
      backend: 'skin' as const,
      title: '站点积分：由皮肤站持有',
      detail:
        '唯一账本是皮肤站的 users.score + credit_ledger（由 kokuu-credit 维护）。'
        + '平台不建第二个余额 —— 两个账本并存时，两边对不上就无从判断谁对。',
      docs: 'docs/ECOSYSTEM.md',
    };

    if (!this.config.skin.url) {
      return {
        ...base,
        available: false,
        reason: '未配置皮肤站地址（KP_SKIN_URL）。这是平台对接唯一账本的入口。',
        capabilities: CAPABILITIES_PENDING,
      };
    }

    if (!this.config.skin.ledgerSecret) {
      return {
        ...base,
        available: false,
        reason:
          '未配置账本接口密钥（KP_SKIN_LEDGER_SECRET）。'
          + '需要在皮肤站的 kokuu-credit 里补三个按 uid 寻址的签名接口 —— '
          + '契约见 apps/server/src/ledger/skin.ts 的文件头。'
          + '在此之前平台只能管游戏内货币（Vault），不能读写站点积分。',
        capabilities: CAPABILITIES_PENDING,
      };
    }

    return {
      ...base,
      available: true,
      reason: null,
      capabilities: CAPABILITIES_READY,
    };
  }

  // ── 查询 ────────────────────────────────────────────────────

  async listAccounts(query: { kw?: string; page: number; size: number }): Promise<LedgerAccountPage> {
    this.requireAvailable();
    const raw = await this.call<{
      total?: number;
      items?: { uid?: number; nickname?: string; score?: number }[];
    }>('users', [query.kw ?? '', query.page, query.size]);

    const items = (raw.items ?? []).map((row) => {
      const uid = Number(row.uid ?? 0);
      return {
        // 平台面向账本的键统一是 MC UUID；站点账号没有对应角色时用 `uid:<n>` 占位，
        // 这样它至少能显示出来，而不是因为映射不上就凭空消失。
        uuid: this.identity.uuidByUid(uid) ?? `uid:${uid}`,
        name: row.nickname ?? null,
        balance: Number(row.score ?? 0),
        updated_at: Date.now(),
      };
    });

    return {
      items,
      total: Number(raw.total ?? items.length),
      page: query.page,
      size: query.size,
    };
  }

  async getAccount(uuid: string): Promise<EconomyAccountRow | undefined> {
    this.requireAvailable();
    const uid = this.resolveUid(uuid);
    if (uid === null) {
      // 站点账号没有这个角色 —— 这不是错误，如实回「没有」。
      return undefined;
    }
    const raw = await this.call<{ items?: { uid?: number; score?: number }[] }>('users', [
      String(uid),
      1,
      1,
    ]);
    const hit = (raw.items ?? [])[0];
    if (!hit) return undefined;
    return { uuid, balance: Number(hit.score ?? 0), updated_at: Date.now() };
  }

  /**
   * 把平台侧的账户标识解析成皮肤站 uid。
   *
   * 支持两种形式：
   *   - `uid:<数字>` —— 直接就是站点账号，**不需要**有 MC 角色
   *   - MC UUID       —— 通过 `characters.bs_uid` 反查
   *
   * 为什么必须支持第一种：积分是「每个**站点账号**一份」的，而 `characters`
   * 只有进过 MC 服的角色。只按 UUID 寻址的话，那些注册了但还没玩过的账号
   * 在平台上就**永远无法调整积分** —— 而它们的积分是真实存在、也该被管理的。
   */
  private resolveUid(ref: string): number | null {
    const direct = /^uid:(\d{1,10})$/.exec(ref);
    if (direct) return Number(direct[1]);
    return this.identity.uidByUuid(ref);
  }

  async listLedger(query: {
    uuid?: string;
    source?: string;
    from?: number;
    to?: number;
    page: number;
    size: number;
  }): Promise<LedgerEntryPage> {
    this.requireAvailable();

    let uid = 0;
    if (query.uuid) {
      const resolved = this.resolveUid(query.uuid);
      if (resolved === null) {
        // 查一个没映射到站点账号的 uuid：返回空页，而不是把全站流水当成他的。
        return { items: [], total: 0, page: query.page, size: query.size };
      }
      uid = resolved;
    }

    const raw = await this.call<{ total?: number; items?: SkinLedgerRow[] }>('ledger', [
      uid,
      query.source ?? '',
      query.size,
    ]);

    const items: (LedgerRow & { name: string | null })[] = (raw.items ?? []).map((row) => ({
      id: Number(row.id ?? 0),
      uuid: this.identity.uuidByUid(Number(row.uid ?? 0)) ?? `uid:${row.uid ?? 0}`,
      delta: Number(row.delta ?? 0),
      balance_after: Number(row.balance_after ?? 0),
      source: String(row.source ?? ''),
      note: String(row.note ?? ''),
      // 站点流水表没有「操作人」这一列（管理员操作记在 source 与 ref 里）。
      operator: '',
      event_id: String(row.event_id ?? ''),
      created_at: parseSiteTime(row.created_at),
      name: null,
    }));

    return {
      items,
      total: Number(raw.total ?? items.length),
      page: query.page,
      size: query.size,
    };
  }

  async stats(): Promise<Record<string, unknown>> {
    this.requireAvailable();
    // 皮肤站侧不提供全站余额聚合（那是另一条重查询）。
    // 与其编一个看着正常的数字，不如不给 —— 界面会显示 `—`。
    return { accounts: null, totalBalance: null, backend: 'skin' };
  }

  // ── 写入 ────────────────────────────────────────────────────

  async adjust(change: BalanceChange): Promise<BalanceResult> {
    this.requireAvailable();

    const uid = this.resolveUid(change.uuid);
    if (uid === null) {
      throw new LedgerUnavailableError(
        `账户 ${change.uuid} 没有映射到皮肤站账号（characters.bs_uid 里查不到）。`
        + '请先用 tools/import-characters.mjs 同步角色目录 —— '
        + '否则这笔调整会落到一个没人认领的账号上。'
        + '（若该账号还没进过 MC 服，界面会用 uid:<数字> 形式的标识，那种不需要角色映射。）',
      );
    }

    const raw = await this.call<{ balance?: number; ledger_id?: number; duplicate?: boolean }>(
      'adjust',
      [change.eventId, uid, change.delta, change.source],
      { note: change.note, operator: change.operator },
    );

    return {
      balance: Number(raw.balance ?? 0),
      ledgerId: Number(raw.ledger_id ?? 0),
    };
  }

  // ── 传输 ────────────────────────────────────────────────────

  private requireAvailable(): void {
    const status = this.status();
    if (!status.available) {
      throw new LedgerUnavailableError(status.reason ?? '账本后端不可用');
    }
  }

  /**
   * 调一个签名接口。
   *
   * 签名方案**刻意与 kokuu-credit 现有的 `kokuu_credit_verify` 保持一致**
   * （点号连接 + HMAC-SHA256 + 时间戳窗口 + nonce 去重），
   * 这样皮肤站那边可以直接复用已有的校验函数，不用再发明一套。
   */
  private async call<T>(
    action: 'users' | 'ledger' | 'adjust',
    payloadParts: (string | number)[],
    extra: Record<string, unknown> = {},
  ): Promise<T> {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomUUID();
    const secret = this.config.skin.ledgerSecret;

    const payload = [ts, nonce, ...payloadParts].join('.');
    const sign = createHmac('sha256', secret).update(payload).digest('hex');

    const url = `${this.config.skin.url}/plugin/kokuu-credit/api/admin/${action}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ts, nonce, sign, ...extra, ...payloadFields(action, payloadParts) }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (error) {
      throw new LedgerUnavailableError(
        `连不上皮肤站账本接口（${url}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    let body: { code?: number; message?: string } & Record<string, unknown>;
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new LedgerUnavailableError(
        `皮肤站账本接口返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`,
      );
    }

    // 接口还不存在时，nginx/Laravel 通常回 404 或一段 HTML —— 这里如实说明，
    // 而不是当成「余额是 0」那样继续跑。
    if (response.status === 404) {
      throw new LedgerUnavailableError(
        `皮肤站上还没有这个接口（${url} 返回 404）。`
        + '需要在 kokuu-credit 里补三个按 uid 寻址的签名接口，契约见 ledger/skin.ts 文件头。',
      );
    }
    if (!response.ok || body.code !== 0) {
      throw new LedgerUnavailableError(
        `皮肤站账本接口拒绝：HTTP ${response.status}`
        + `${body.message ? ` · ${body.message}` : ''}`,
      );
    }

    return body as T;
  }
}

function payloadFields(
  action: 'users' | 'ledger' | 'adjust',
  parts: (string | number)[],
): Record<string, unknown> {
  if (action === 'users') {
    const [kw, page, size] = parts;
    return { kw, page, size };
  }
  if (action === 'ledger') {
    const [uid, source, limit] = parts;
    return { uid, source, limit };
  }
  const [eventId, uid, delta, source] = parts;
  return { event_id: eventId, uid, delta, source };
}

interface SkinLedgerRow {
  id?: number;
  uid?: number;
  delta?: number;
  balance_after?: number;
  source?: string;
  ref?: string;
  note?: string;
  event_id?: string;
  created_at?: string;
}

/**
 * 皮肤站的 `created_at` 是 MySQL 的 `Y-m-d H:i:s`（**服务器本地时区**，
 * 不是 ISO8601，也没有时区标记）。`Date.parse` 会把它当本地时间解析 ——
 * 那正好等于站点服务器的时区，但平台可能在另一个时区，会整体偏移。
 *
 * 这里如实返回 0 表示「解析不出来」，而不是给一个看着合理却偏了几小时的数。
 * 要精确需要皮肤站侧一并返回 unix 时间戳（契约里已留 `created_at` 字段，
 * 建议补完时直接给秒级时间戳）。
 */
function parseSiteTime(value: unknown): number {
  if (typeof value === 'number') return value * 1000;
  return 0;
}
