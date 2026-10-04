/**
 * `standalone` 账本：平台自带的 SQLite 账本。
 *
 * 这一份是**兜底**，给「没有皮肤站」的部署用。默认部署不该走它 ——
 * 皮肤站才是既定的唯一账本，两个账本并存必然出现「两边余额对不上」。
 *
 * 它不是什么新东西：`economy_accounts` / `economy_ledger` 两张表与
 * store 里的实现早就有了，只是一直被 501 关着。这里只是把它接到
 * {@link Ledger} 接口上。
 *
 * 关键不变量（都在 store.adjustBalance 里）：
 *   - 改余额与记流水在**同一个事务**里；
 *   - 幂等靠 `event_id` 的**唯一索引**，不是「先查再写」——
 *     两个并发请求会同时通过检查，唯一索引才是最终防线；
 *   - 余额从库里读，**不信任调用方**。
 */

import { isSafeUuid } from '@kokuu/protocol';

import type { Store, LedgerRow, EconomyAccountRow, BalanceChange, BalanceResult } from '../store/index.ts';
import {
  LedgerUnavailableError,
  type Ledger,
  type LedgerAccountPage,
  type LedgerEntryPage,
  type LedgerStatus,
  type LedgerCapabilities,
} from './index.ts';

export class StandaloneLedger implements Ledger {
  readonly backend = 'standalone' as const;

  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  status(): LedgerStatus {
    const capabilities: LedgerCapabilities = {
      listAccounts: true,
      readAccount: true,
      adjust: true,
      listLedger: true,
      stats: true,
      config: true,
    };

    return {
      backend: 'standalone',
      available: true,
      reason: null,
      capabilities,
      title: '站点积分：平台自带账本',
      detail:
        '平台正在持有积分账本（SQLite 的 economy_accounts / economy_ledger）。'
        + '这是给「没有皮肤站」的部署用的兜底模式；'
        + '如果你的站上已经有 Blessing Skin，应当改用 skin 模式，'
        + '否则会出现两个各自为政的余额。',
      docs: 'docs/ECOSYSTEM.md',
    };
  }

  async listAccounts(query: { kw?: string; page: number; size: number }): Promise<LedgerAccountPage> {
    return this.store.listEconomyAccounts(query);
  }

  async getAccount(uuid: string): Promise<EconomyAccountRow | undefined> {
    return this.store.getEconomyAccount(uuid);
  }

  async adjust(change: BalanceChange): Promise<BalanceResult> {
    /*
     * 平台自带账本的主键**就是 MC UUID**，不接受 `uid:<n>` 那种站点账号标识 ——
     * 那个标识来自 skin 账本，放进来会凭空建出一个名叫 "uid:1" 的账户，
     * 而它跟任何真人都对不上。
     */
    if (!isSafeUuid(change.uuid)) {
      throw new LedgerUnavailableError(
        `平台自带账本按 MC UUID 记账，不接受「${change.uuid}」这种标识。`
        + '（uid:<数字> 是皮肤站账号的标识，只在 skin 模式下出现。）',
      );
    }
    return this.store.adjustBalance(change);
  }

  async listLedger(query: {
    uuid?: string;
    source?: string;
    from?: number;
    to?: number;
    page: number;
    size: number;
  }): Promise<LedgerEntryPage> {
    return this.store.listLedger(query) as LedgerEntryPage;
  }

  async stats(): Promise<Record<string, unknown>> {
    return this.store.economyStats() as unknown as Record<string, unknown>;
  }

  /** 供路由层判断「这个账户存不存在」用（standalone 下账户是惰性创建的）。 */
  ensureAccount(uuid: string): EconomyAccountRow {
    return this.store.ensureEconomyAccount(uuid);
  }
}

/** 类型守卫：路由层偶尔需要碰 standalone 独有的方法。 */
export function isStandalone(ledger: Ledger): ledger is StandaloneLedger {
  return ledger.backend === 'standalone';
}

export type { LedgerRow };
