/**
 * 账本抽象。
 *
 * <h2>为什么要有这一层</h2>
 *
 * 「积分」这件事有两个可能的持有者，而且**只能有一个**：
 *
 *   1. `skin`       —— Blessing Skin 的 `users.score` + `credit_ledger`
 *                      （由 `kokuu-credit` 维护，本生态里既定的唯一账本）
 *   2. `standalone` —— 平台自带（给「没有皮肤站」的部署兜底）
 *
 * 之前经济模块把这两件事搅在一起：接口直接调 `store.*`，然后按
 * `KP_LEDGER_MODE` 整块回 501。结果是默认部署下**整个经济页面都是坏的** ——
 * 统计卡是 `—`、列表报错、配置卡报错，连唯一能用的「游戏内货币」也点不到，
 * 因为它的入口要求先选中一个账户，而账户列表本身就 501。
 *
 * 现在换成：所有经济接口都经 {@link Ledger} 这一层，具体用哪个后端由配置决定。
 * 后端准备好了就是能用的功能，没准备好就在 `/economy/status` 里**如实说明原因**，
 * 界面据此渲染说明而不是报错。
 *
 * <h2>身份键统一用 MC UUID</h2>
 *
 * 平台面向账本的键一律是 MC UUID。两个后端各自负责把它翻译成自己的键：
 *   - `standalone`：UUID 就是主键（`economy_accounts.uuid`）
 *   - `skin`：UUID → `characters.bs_uid` → 皮肤站 `users.uid`
 *     （`characters` 表里已经存了 `bs_uid`，所以这个映射不需要额外拉数据）
 */

import type { Store, LedgerRow, EconomyAccountRow, BalanceChange, BalanceResult } from '../store/index.ts';
import type { Config } from '../config.ts';
import { StandaloneLedger } from './standalone.ts';
import { SkinLedger } from './skin.ts';

export type LedgerBackend = 'standalone' | 'skin';

/** 账户分页（行形状与 store 保持一致，路由层不用改映射）。 */
export interface LedgerAccountPage {
  items: { uuid: string; balance: number; updated_at: number; name: string | null }[];
  total: number;
  page: number;
  size: number;
}

export interface LedgerEntryPage {
  items: (LedgerRow & { name: string | null })[];
  total: number;
  page: number;
  size: number;
}

/**
 * 后端能做什么。
 *
 * 不同后端能力不同（例如皮肤站侧的兑换比例归它自己管，平台改不了），
 * 所以界面要按能力隐藏入口 —— 「有入口但点进去报错」比没有入口更糟。
 */
export interface LedgerCapabilities {
  /** 能按关键字列出/搜索账户。 */
  listAccounts: boolean;
  /** 能读单个账户余额与流水。 */
  readAccount: boolean;
  /** 能改余额（含扣减）。 */
  adjust: boolean;
  /** 能查全站流水。 */
  listLedger: boolean;
  /** 能出统计（账户数、余额总量、余额榜）。 */
  stats: boolean;
  /** 能改兑换比例 / 限额这类配置。 */
  config: boolean;
}

export interface LedgerStatus {
  backend: LedgerBackend;
  /**
   * 后端现在能用吗。
   *
   * `false` 时 {@link LedgerStatus.reason} 必须是一句**能直接显示给管理员看的话**：
   * 说清为什么不能用、要去配什么，而不是「后端不可用」这种没有信息量的说法。
   */
  available: boolean;
  reason: string | null;
  capabilities: LedgerCapabilities;
  /** 界面标题，例如「站点积分：由皮肤站持有」。 */
  title: string;
  detail: string;
  /** 相关文档路径，给界面显示。 */
  docs: string;
}

export interface Ledger {
  readonly backend: LedgerBackend;

  /** 当前状态。**永远不抛异常**，不可用也要如实返回。 */
  status(): LedgerStatus;

  /**
   * 以下查询/写入一律**异步**。
   *
   * `standalone` 是本地 SQLite（同步），但 `skin` 要发 HTTP ——
   * 接口必须按更慢的那个来定义，否则 skin 后端就没法实现。
   */
  listAccounts(query: { kw?: string; page: number; size: number }): Promise<LedgerAccountPage>;
  getAccount(uuid: string): Promise<EconomyAccountRow | undefined>;
  adjust(change: BalanceChange): Promise<BalanceResult>;
  listLedger(query: {
    uuid?: string;
    source?: string;
    from?: number;
    to?: number;
    page: number;
    size: number;
  }): Promise<LedgerEntryPage>;
  stats(): Promise<Record<string, unknown>>;
}

/**
 * 后端不可用。
 *
 * 路由层把它翻成 503 —— 注意**不是** 501：
 *   501 = 这个功能被有意地不实现（设计决定）
 *   503 = 功能是存在的，只是后端暂时不可达/没配好（运维问题）
 * 之前的 501 表达的是前者，现在语义变了，码也必须跟着变，
 * 否则运维会照着「设计如此」去找原因。
 */
export class LedgerUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'LedgerUnavailableError';
    this.reason = reason;
  }
}

/**
 * 按配置造一个账本后端。
 *
 * 默认 `skin`：皮肤站是既定的唯一账本，不该因为「没配」就悄悄换成平台自带账本 ——
 * 那会凭空多出第二个余额，正是 `kokuu-credit` / `kokuu-coupon` 的 README
 * 反复警告的事。
 */
export function createLedger(config: Config, store: Store): Ledger {
  if (config.ledgerMode === 'standalone') {
    return new StandaloneLedger(store);
  }

  // skin：平台面向账本的键是 MC UUID，皮肤站那边是 uid。
  // 这个互查由 `characters` 表提供（那一列叫 `bs_uid`），
  // 所以不需要额外拉数据，也不需要玩家邮箱。
  return new SkinLedger(config, {
    uidByUuid: (uuid) => store.findCharacterByUuid(uuid)?.bs_uid ?? null,
    uuidByUid: (uid) => store.findCharacterByUid(uid)?.uuid ?? null,
  });
}
