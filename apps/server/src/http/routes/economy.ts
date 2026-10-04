/**
 * 经济模块。
 *
 * 🛑 **本文件与 ECOSYSTEM.md 的结论冲突，需要改造。**
 *
 * 现在它把平台当作**账本的持有者**（`economy_accounts` / `economy_ledger`）。
 * 但 kokuu 生态里已经有唯一账本：Blessing Skin 的 `users.score` +
 * `credit_ledger`（由 `kokuu-credit` 维护）。自建第二个余额正是
 * `kokuu-credit` 与 `kokuu-coupon` 的 README 反复警告的「两个真相源」——
 * 装上就会多出一个对不上的余额。
 *
 * 正确方向（见 docs/ECOSYSTEM.md §3）：
 *   - 站点积分：**不自建**，读写皮肤站那一个账本
 *     （方案 A：给 kokuu-credit 加签名接口；方案 B：直连同一个库）
 *   - 底仓 min_keep：读 `kokuu_exchange_min_keep`，**不复制到平台配置**
 *   - 来源标签：调 `kokuu_credit_source_labels()`，**不自己再写一份映射**
 *   - 游戏内货币：这一半是对的，Authority 在 MC 服务端的经济插件，
 *     平台只能通过 Agent 下发指令
 *
 * 在改造完成前，**不要把本模块接到生产**。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { isSafeUuid } from '@kokuu/protocol';
import { newToken, shortId } from '../../lib/crypto.ts';
import { ConfigValidationError, IdempotencyConflict } from '../../store/index.ts';
import {
  HttpError,
  audited,
  currentAccount,
  optInt,
  optStr,
  pageParams,
  requirePermission,
  toHttpError,
  type AppContext,
} from '../context.ts';

const AdjustBody = z
  .object({
    delta: z
      .number()
      .finite()
      .refine((v) => v !== 0, '调整数额不能为 0'),
    note: z.string().max(200).optional(),
    eventId: z.string().min(1).max(128).optional(),
  })
  .strict();

const GameCurrencyBody = z
  .object({
    nodeId: z.string().min(1).max(64),
    amount: z
      .number()
      .finite()
      .refine((v) => v !== 0, '调整数额不能为 0'),
    note: z.string().max(200).optional(),
    eventId: z.string().min(1).max(128).optional(),
  })
  .strict();

export function registerEconomyRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * 账本门槛：后端不可用就明确拒绝，并**说清为什么、要去配什么**。
   *
   * 用 503 而不是 501：以前这些接口回 501，语义是「平台有意不持有账本」——
   * 那是设计决定，运维看到就知道别找了。现在语义变了：账本在皮肤站，
   * 接口是存在的，只是还没接通。503 读作「去把它配起来」，501 读作「设计如此」，
   * 两者对排查的指向完全相反。
   *
   * 原因文本来自后端的 `status().reason`，所以它是**能直接显示给管理员看的**。
   */
  const requireLedger = (): ReturnType<AppContext['ledger']['status']> => {
    const status = ctx.ledger.status();
    if (!status.available) {
      throw new HttpError('LEDGER_UNAVAILABLE', status.reason ?? '积分账本后端不可用');
    }
    return status;
  };

  /** 某项能力后端支不支持。不支持就直说，而不是让它点了报一个看不懂的错。 */
  const requireCapability = (
    status: ReturnType<AppContext['ledger']['status']>,
    capability: keyof ReturnType<AppContext['ledger']['status']>['capabilities'],
    what: string,
  ): void => {
    if (status.capabilities[capability]) return;
    throw new HttpError(
      'LEDGER_UNAVAILABLE',
      `当前账本后端（${status.backend}）不支持${what}。` + (status.detail ?? ''),
    );
  };

  /**
   * 账户标识校验。
   *
   * 两种合法形式：
   *   - MC UUID            （standalone 账本的主键；skin 账本靠 characters 反查）
   *   - `uid:<数字>`        （skin 账本里**还没进过 MC 服**的站点账号）
   *
   * 为什么要允许第二种：积分归**站点账号**（`users.score`），而 `characters`
   * 只有进过服的角色。只收 UUID 的话，注册了但没玩过的账号在平台上就
   * 永远无法调整积分 —— 而它们的积分是真实存在、也该被管理的。
   */
  const ACCOUNT_REF = /^(?:uid:\d{1,10}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

  const requireAccountRef = (raw: string): string => {
    if (!ACCOUNT_REF.test(raw)) {
      throw HttpError.badRequest('账户标识格式不正确（应为 MC UUID 或 uid:<数字>）');
    }
    return raw;
  };

  /**
   * 经济模块的**状态**。这个接口永远返回 200，不会 503。
   *
   * 为什么需要它：以前读账本的接口一律 501，于是前端只能靠「请求失败」去猜
   * 自己的处境 —— 结果就是整个经济页面看起来是坏的
   * （统计卡是 `—`、列表报错、配置卡报错，连能用的「游戏内货币」也点不到，
   * 因为它的入口要求先选中一个账户）。
   *
   * 有了这个接口，前端就能**明确区分**三种情况并各自渲染：
   *   1. 账本后端已就绪（standalone 或接好接口的 skin）→ 渲染完整界面
   *   2. 账本后端不可用 → 说明现状 + 缺什么，不是错误
   *   3. 游戏内货币 → 这条路径与账本后端无关，始终可用
   */
  app.get('/_api/economy/status', async (request) => {
    requirePermission(request, 'economy.view');
    const ledger = ctx.ledger.status();

    return {
      ledger: {
        backend: ledger.backend,
        available: ledger.available,
        /** 不可用时的原因。界面直接显示这句话 —— 它必须能被人看懂并据此去配。 */
        reason: ledger.reason,
        capabilities: ledger.capabilities,
        title: ledger.title,
        detail: ledger.detail,
        docs: ledger.docs,
      },
      gameCurrency: {
        available: true,
        note: '游戏内货币的权威在 MC 服务端的经济插件（Vault），平台通过 Agent 读写，'
          + '与账本后端无关。',
      },
    };
  });

  /**
   * 读某个玩家在某个节点上的**游戏内余额**。
   *
   * 余额是「每个服务端各自一份」的（Vault 的经济后端在服务端本地），
   * 所以必须指明 nodeId —— 不指定就只能猜，而猜错会让人看到另一台服的余额。
   */
  app.get('/_api/economy/balance', async (request) => {
    requirePermission(request, 'economy.view');
    const query = request.query as Record<string, unknown>;
    const nodeId = optStr(query, 'nodeId');
    const uuid = optStr(query, 'uuid');

    if (!nodeId) {
      throw HttpError.badRequest('缺少 nodeId：游戏内余额是每个服务端各自一份的');
    }
    if (!uuid || !isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

    const player = ctx.store.getPlayer(uuid);

    try {
      const result = await ctx.gateway.call(nodeId, 'economy.getBalance', {
        uuid,
        // name 可选：Vault 支持按离线玩家取余额，拿不到名字也能读。
        ...(player?.name ? { name: player.name } : {}),
      });
      return { nodeId, uuid, name: player?.name ?? null, ...result };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get('/_api/economy/accounts', async (request) => {
    requirePermission(request, 'economy.view');
    requireLedger();
    const query = request.query as Record<string, unknown>;
    const { page, size } = pageParams(query);

    const result = await ctx.ledger.listAccounts({
      kw: optStr(query, 'kw'),
      page,
      size,
    });

    return {
      items: result.items.map((row) => ({
        uuid: row.uuid,
        name: row.name ?? null,
        balance: row.balance,
        updatedAt: row.updated_at,
      })),
      total: result.total,
      page: result.page,
      size: result.size,
    };
  });

  app.get<{ Params: { uuid: string } }>(
    '/_api/economy/accounts/:uuid',
    async (request) => {
      requirePermission(request, 'economy.view');
      requireLedger();
      const uuid = request.params.uuid;
      requireAccountRef(uuid);

      const account = await ctx.ledger.getAccount(uuid);
      // 玩家档案按 MC UUID 查；`uid:<n>` 这种站点账号标识自然查不到，
      // 所以这里不能因为 player 为空就报「没有该玩家的记录」——
      // 账本里有这个账号就够了。
      const player = isSafeUuid(uuid) ? ctx.store.getPlayer(uuid) : undefined;
      if (!account && !player) throw HttpError.notFound('没有该玩家的记录');

      const ledger = await ctx.ledger.listLedger({ uuid, page: 1, size: 50 });

      return {
        account: {
          uuid,
          name: player?.name ?? null,
          balance: account?.balance ?? 0,
          updatedAt: account?.updated_at ?? null,
        },
        ledger: ledger.items.map((row) => ({
          id: row.id,
          delta: row.delta,
          balanceAfter: row.balance_after,
          source: row.source,
          note: row.note,
          operator: row.operator,
          eventId: row.event_id,
          createdAt: row.created_at,
        })),
      };
    },
  );

  app.post<{ Params: { uuid: string } }>(
    '/_api/economy/accounts/:uuid/adjust',
    async (request) => {
      const account = requirePermission(request, 'economy.manage');
      requireLedger();
      const uuid = request.params.uuid;
      requireAccountRef(uuid);

      const parsed = AdjustBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw HttpError.badRequest(
          parsed.error.issues[0]?.message ?? '参数不正确',
        );
      }

      const eventId = parsed.data.eventId ?? `admin:${shortId()}`;

      try {
        const result = await audited(
          ctx,
          request,
          {
            action: 'economy.adjust',
            targetType: 'player',
            targetId: uuid,
            params: { delta: parsed.data.delta, note: parsed.data.note, eventId },
          },
          () =>
            ctx.ledger.adjust({
              uuid,
              delta: parsed.data.delta,
              source: 'admin',
              note: parsed.data.note ?? '',
              operator: account.username,
              eventId,
            }),
        );

        ctx.hub.publish('economy', 'economy.adjusted', {
          uuid,
          delta: parsed.data.delta,
          balance: result.balance,
        });

        return { balance: result.balance, ledgerId: result.ledgerId };
      } catch (error) {
        if (error instanceof IdempotencyConflict) {
          throw new HttpError(
            'CONFLICT',
            '该 eventId 已经处理过。这是一次重复提交，资金不会被重复加减。',
          );
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { uuid: string } }>(
    '/_api/economy/accounts/:uuid/game-currency',
    async (request) => {
      requirePermission(request, 'economy.manage');
      const uuid = request.params.uuid;
      if (!isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

      const parsed = GameCurrencyBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw HttpError.badRequest(parsed.error.issues[0]?.message ?? '参数不正确');
      }

      const player = ctx.store.getPlayer(uuid);
      if (!player) {
        throw HttpError.notFound(
          '该玩家不在平台记录中。游戏内货币需要玩家名，请先让该玩家上线一次。',
        );
      }

      const eventId =
        parsed.data.eventId ?? `admin:cur:${uuid}:${Date.now()}:${shortId()}`;

      return audited(
        ctx,
        request,
        {
          action: 'economy.adjust_game_currency',
          targetType: 'player',
          targetId: uuid,
          nodeId: parsed.data.nodeId,
          params: {
            amount: parsed.data.amount,
            note: parsed.data.note,
            eventId,
          },
        },
        async () => {
          try {
            return await ctx.gateway.call(parsed.data.nodeId, 'economy.adjust', {
              uuid,
              name: player.name,
              amount: parsed.data.amount,
              note: parsed.data.note,
              eventId,
            });
          } catch (error) {
            throw toHttpError(error);
          }
        },
      );
    },
  );

  app.get('/_api/economy/ledger', async (request) => {
    requirePermission(request, 'economy.view');
    requireLedger();
    const query = request.query as Record<string, unknown>;
    const { page, size } = pageParams(query);

    const result = await ctx.ledger.listLedger({
      uuid: optStr(query, 'uuid') ?? undefined,
      source: optStr(query, 'source') ?? undefined,
      from: optInt(query, 'from') ?? undefined,
      to: optInt(query, 'to') ?? undefined,
      page,
      size,
    });

    return {
      items: result.items.map((row) => ({
        id: row.id,
        uuid: row.uuid,
        name: row.name ?? null,
        delta: row.delta,
        balanceAfter: row.balance_after,
        source: row.source,
        note: row.note,
        operator: row.operator,
        eventId: row.event_id,
        createdAt: row.created_at,
      })),
      total: result.total,
      page: result.page,
      size: result.size,
    };
  });

  app.get('/_api/economy/stats', async (request) => {
    requirePermission(request, 'economy.view');
    const status = requireLedger();
    requireCapability(status, 'stats', '全站统计');
    const stats = await ctx.ledger.stats();
    const config = ctx.store.getConfig();

    return {
      ...stats,
      config: {
        enabled: config['economy.enabled'] === '1',
        ratio: Number.parseInt(config['economy.ratio'] ?? '1000', 10),
        dailyLimit: Number.parseInt(config['economy.daily_limit'] ?? '0', 10),
        singleLimit: Number.parseInt(config['economy.single_limit'] ?? '0', 10),
        minCoin: Number.parseInt(config['economy.min_coin'] ?? '0', 10),
        reflowEnabled: config['economy.reflow_enabled'] === '1',
        reflowDailyLimit: Number.parseInt(config['economy.reflow_daily_limit'] ?? '0', 10),
        currencyName: config['economy.currency_name'] ?? '金币',
        pointsName: config['economy.points_name'] ?? '积分',
      },
    };
  });

  app.get('/_api/economy/config', async (request) => {
    requirePermission(request, 'economy.view');
    const status = requireLedger();
    requireCapability(status, 'config', '兑换比例与限额配置');
    return { config: ctx.store.getConfig() };
  });

  app.put('/_api/economy/config', async (request) => {
    requirePermission(request, 'economy.manage');
    const status = requireLedger();
    requireCapability(status, 'config', '兑换比例与限额配置');
    const body = request.body;
    if (typeof body !== 'object' || body === null) {
      throw HttpError.badRequest('请求体必须是键值对象');
    }

    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      patch[key] =
        typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
    }

    if (Object.keys(patch).length === 0) {
      throw HttpError.badRequest('没有需要修改的配置项');
    }

    return audited(
      ctx,
      request,
      { action: 'economy.update_config', targetType: 'config', targetId: 'economy', params: patch },
      () => {
        try {
          return { config: ctx.store.setConfig(patch) };
        } catch (error) {
          if (error instanceof ConfigValidationError) {
            // 400 而不是 500：这是用户填错了，不是服务器坏了。
            throw HttpError.badRequest(error.message);
          }
          throw error;
        }
      },
    );
  });

  /** 生成一个幂等键，供前端「重试同一次操作」时复用。 */
  app.get('/_api/economy/new-event-id', async (request) => {
    currentAccount(request);
    return { eventId: `admin:${newToken(8)}` };
  });
}
