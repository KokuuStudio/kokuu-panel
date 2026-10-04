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
import { config } from '../../config.ts';
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
   * 门槛：这些接口操作的是**平台自带的账本**。
   *
   * 默认部署（`KP_LEDGER_MODE=external`）下平台不持有账本 ——
   * 唯一账本是 Blessing Skin 的 `users.score` + `credit_ledger`。
   * 这时所有「读写平台账本」的接口都必须明确回 501 并说清原因，
   * 而不是拿空数据装作正常。
   *
   * 为什么用 501 而不是 404 或 500：
   *   - 404 会让调用方以为路径写错了，去改 URL
   *   - 500 会让人以为是 bug，去翻日志
   *   - 501 的意思是「这个功能被有意地不实现」，指向的是设计决定
   */
  const requireOwnedLedger = (): void => {
    if (config.ledgerMode === 'standalone') return;
    throw new HttpError(
      'NOT_IMPLEMENTED',
      '平台不持有积分账本。唯一账本是皮肤站的 users.score + credit_ledger' +
        '（由 kokuu-credit 维护），自建第二个余额会造成两个真相源。' +
        '积分读写请走对接层；确实需要平台自带账本（例如没有皮肤站的部署）' +
        '请显式设置 KP_LEDGER_MODE=standalone。详见 docs/ECOSYSTEM.md。',
    );
  };

  app.get('/_api/economy/accounts', async (request) => {
    requirePermission(request, 'economy.view');
    requireOwnedLedger();
    const query = request.query as Record<string, unknown>;
    const { page, size } = pageParams(query);

    const result = ctx.store.listEconomyAccounts({
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
      requireOwnedLedger();
      const uuid = request.params.uuid;
      if (!isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

      const account = ctx.store.getEconomyAccount(uuid);
      const player = ctx.store.getPlayer(uuid);
      if (!account && !player) throw HttpError.notFound('没有该玩家的记录');

      const ledger = ctx.store.listLedger({ uuid, page: 1, size: 50 });

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
      requireOwnedLedger();
      const uuid = request.params.uuid;
      if (!isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

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
            ctx.store.adjustBalance({
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
    requireOwnedLedger();
    const query = request.query as Record<string, unknown>;
    const { page, size } = pageParams(query);

    const result = ctx.store.listLedger({
      uuid: optStr(query, 'uuid'),
      source: optStr(query, 'source'),
      from: optInt(query, 'from'),
      to: optInt(query, 'to'),
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
    requireOwnedLedger();
    const stats = ctx.store.economyStats();
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
    requireOwnedLedger();
    return { config: ctx.store.getConfig() };
  });

  app.put('/_api/economy/config', async (request) => {
    requirePermission(request, 'economy.manage');
    requireOwnedLedger();
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
