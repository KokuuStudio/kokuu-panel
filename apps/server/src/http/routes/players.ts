/**
 * 玩家管理。
 *
 * 身份锚点是 **UUID**，不是玩家名 —— 名字可改、可重名，
 * 用名字做键会在改名后找不到人，重名时更糟：找到别人。
 * 这是 kokuu-credit-admin 已验证过的结论，这里继续沿用。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { isSafeUuid, type PlayerEntry } from '@kokuu/protocol';
import { toProtocolPunishment } from '../../agent/gateway.ts';
import type { PlayerRow } from '../../store/index.ts';
import {
  HttpError,
  audited,
  optBool,
  optStr,
  pageParams,
  requirePermission,
  toHttpError,
  type AppContext,
} from '../context.ts';

const UuidParam = z.string().refine(isSafeUuid, 'UUID 格式不正确');

const ResolveBody = z
  .object({ name: z.string().regex(/^[A-Za-z0-9_]{1,16}$/, '玩家名格式不正确') })
  .strict();

const KickBody = z
  .object({
    nodeId: z.string().min(1).max(64),
    reason: z.string().max(500).default('被管理员踢出'),
  })
  .strict();

const OpBody = z
  .object({ nodeId: z.string().min(1).max(64), value: z.boolean() })
  .strict();

const GamemodeBody = z
  .object({
    nodeId: z.string().min(1).max(64),
    gamemode: z.enum(['SURVIVAL', 'CREATIVE', 'ADVENTURE', 'SPECTATOR']),
  })
  .strict();

const WhitelistBody = z
  .object({
    nodeId: z.string().min(1).max(64),
    value: z.boolean(),
  })
  .strict();

function serializePlayer(
  row: PlayerRow,
  options: { includeIp: boolean },
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    uuid: row.uuid,
    name: row.name,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    playtimeSeconds: row.playtime_seconds,
    online: row.online === 1,
    nodeId: row.node_id,
  };
  // 没有 player.view_ip 权限时**整个字段不出现**，
  // 而不是给一个占位值 —— 前端不必为「有 key 但不能看」写分支。
  if (options.includeIp) base.lastIp = row.last_ip;
  return base;
}

export function registerPlayerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/_api/players', async (request) => {
    requirePermission(request, 'player.view');
    const query = request.query as Record<string, unknown>;
    const { page, size } = pageParams(query);

    const result = ctx.store.listPlayers({
      kw: optStr(query, 'kw'),
      online: optBool(query, 'online'),
      nodeId: optStr(query, 'node'),
      page,
      size,
    });

    const includeIp = request.permissions?.has('player.view_ip') ?? false;

    return {
      items: result.items.map((row) => serializePlayer(row, { includeIp })),
      total: result.total,
      page: result.page,
      size: result.size,
    };
  });

  app.post('/_api/players/resolve', async (request) => {
    requirePermission(request, 'player.view');
    const parsed = ResolveBody.safeParse(request.body ?? {});
    if (!parsed.success) throw HttpError.badRequest('玩家名格式不正确');

    // 先查本地历史名 —— 改名玩家也要能靠旧名找到。
    const local = ctx.store.findPlayerByName(parsed.data.name);

    // 再问在线节点（可能是个从没在本平台记录过的玩家）。
    let online = false;
    let uuid = local?.uuid ?? null;
    for (const node of ctx.store.listNodes()) {
      if (!ctx.gateway.isOnline(node.id)) continue;
      try {
        const resolved = await ctx.gateway.call(node.id, 'players.resolve', {
          name: parsed.data.name,
        });
        uuid = resolved.uuid;
        online = resolved.online;
        break;
      } catch {
        // 单个节点失败不影响结论，继续问下一个。
        continue;
      }
    }

    if (!uuid) throw HttpError.notFound(`找不到玩家 ${parsed.data.name}`);
    return { uuid, name: parsed.data.name, online };
  });

  app.get<{ Params: { uuid: string } }>('/_api/players/:uuid', async (request) => {
    requirePermission(request, 'player.view');
    const uuid = request.params.uuid;
    if (!isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

    const row = ctx.store.getPlayer(uuid);
    if (!row) throw HttpError.notFound('该玩家不在平台记录中');

    const includeIp = request.permissions?.has('player.view_ip') ?? false;

    const economy = ctx.store.getEconomyAccount(uuid);

    // 游戏内货币：只问在线节点，且**串行带超时**。
    // 并发问所有节点会让一个卡住的节点拖慢整个详情页。
    const gameCurrency: Record<string, { balance: number; currency: string }> = {};
    for (const node of ctx.store.listNodes()) {
      if (!ctx.gateway.get(node.id)?.has('economy')) continue;
      try {
        const balance = await ctx.gateway.call(
          node.id,
          'economy.getBalance',
          { uuid, name: row.name },
          3000,
        );
        gameCurrency[node.id] = { balance: balance.balance, currency: balance.currency };
      } catch {
        // 拿不到就跳过，不让详情页整体失败。
        continue;
      }
    }

    return {
      player: {
        ...serializePlayer(row, { includeIp }),
        knownNames: ctx.store.getPlayerNames(uuid).map((n) => n.name),
        punishments: ctx.store.listPunishmentsForUuid(uuid).map(toProtocolPunishment),
        economy: economy ? { balance: economy.balance } : { balance: 0 },
        gameCurrency,
      },
    };
  });

  app.get<{ Params: { uuid: string } }>('/_api/players/:uuid/ips', async (request) => {
    requirePermission(request, 'player.view_ip');
    const uuid = request.params.uuid;
    if (!isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

    ctx.store.audit({
      actor: request.account?.username ?? 'unknown',
      actorIp: request.clientIp ?? null,
      action: 'player.view_ip_history',
      targetType: 'player',
      targetId: uuid,
      ok: true,
    });

    return {
      items: ctx.store.getPlayerIps(uuid).map((row) => ({
        ip: row.ip,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        seenCount: row.seen_count,
      })),
    };
  });

  app.get<{ Params: { uuid: string } }>('/_api/players/:uuid/names', async (request) => {
    requirePermission(request, 'player.view');
    const uuid = request.params.uuid;
    if (!isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

    return {
      items: ctx.store.getPlayerNames(uuid).map((row) => ({
        name: row.name,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      })),
    };
  });

  app.get<{ Params: { uuid: string }; Querystring: Record<string, unknown> }>(
    '/_api/players/:uuid/sessions',
    async (request) => {
      requirePermission(request, 'player.view');
      const uuid = request.params.uuid;
      if (!isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

      const limit = Math.min(200, Number.parseInt(String(request.query.limit ?? '50'), 10) || 50);
      return {
        items: ctx.store.getPlayerSessions(uuid, limit).map((row) => ({
          id: row.id,
          nodeId: row.node_id,
          // IP 只在有权限时返回
          ip: request.permissions?.has('player.view_ip') ? row.ip : undefined,
          joinedAt: row.joined_at,
          leftAt: row.left_at,
          playtimeSeconds: row.playtime_seconds,
        })),
      };
    },
  );

  app.get<{ Params: { uuid: string }; Querystring: Record<string, unknown> }>(
    '/_api/players/:uuid/audit',
    async (request) => {
      requirePermission(request, 'audit.view');
      const uuid = request.params.uuid;
      if (!isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

      const { page, size } = pageParams(request.query);
      const result = ctx.store.listAudit({
        targetType: 'player',
        targetId: uuid,
        page,
        size,
      });
      return {
        items: result.items.map(deserializeAudit),
        total: result.total,
        page: result.page,
        size: result.size,
      };
    },
  );

  // ── 写操作 ─────────────────────────────────────────────────

  app.post<{ Params: { uuid: string } }>('/_api/players/:uuid/kick', async (request) => {
    requirePermission(request, 'player.manage');
    const uuid = request.params.uuid;
    if (!isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

    const parsed = KickBody.safeParse(request.body ?? {});
    if (!parsed.success) throw HttpError.badRequest('参数不正确');

    return audited(
      ctx,
      request,
      {
        action: 'player.kick',
        targetType: 'player',
        targetId: uuid,
        nodeId: parsed.data.nodeId,
        params: { reason: parsed.data.reason },
      },
      async () => {
        try {
          return await ctx.gateway.call(parsed.data.nodeId, 'players.kick', {
            uuid,
            reason: parsed.data.reason,
          });
        } catch (error) {
          throw toHttpError(error);
        }
      },
    );
  });

  app.post<{ Params: { uuid: string } }>('/_api/players/:uuid/op', async (request) => {
    requirePermission(request, 'player.manage');
    const uuid = request.params.uuid;
    if (!isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

    const parsed = OpBody.safeParse(request.body ?? {});
    if (!parsed.success) throw HttpError.badRequest('参数不正确');

    return audited(
      ctx,
      request,
      {
        action: parsed.data.value ? 'player.op' : 'player.deop',
        targetType: 'player',
        targetId: uuid,
        nodeId: parsed.data.nodeId,
      },
      async () => {
        try {
          return await ctx.gateway.call(parsed.data.nodeId, 'players.setOp', {
            uuid,
            value: parsed.data.value,
          });
        } catch (error) {
          throw toHttpError(error);
        }
      },
    );
  });

  app.post<{ Params: { uuid: string } }>(
    '/_api/players/:uuid/gamemode',
    async (request) => {
      requirePermission(request, 'player.manage');
      const uuid = request.params.uuid;
      if (!isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

      const parsed = GamemodeBody.safeParse(request.body ?? {});
      if (!parsed.success) throw HttpError.badRequest('参数不正确');

      return audited(
        ctx,
        request,
        {
          action: 'player.set_gamemode',
          targetType: 'player',
          targetId: uuid,
          nodeId: parsed.data.nodeId,
          params: { gamemode: parsed.data.gamemode },
        },
        async () => {
          try {
            return await ctx.gateway.call(parsed.data.nodeId, 'players.setGamemode', {
              uuid,
              gamemode: parsed.data.gamemode,
            });
          } catch (error) {
            throw toHttpError(error);
          }
        },
      );
    },
  );

  app.post<{ Params: { uuid: string } }>(
    '/_api/players/:uuid/whitelist',
    async (request) => {
      requirePermission(request, 'player.manage');
      const uuid = request.params.uuid;
      if (!isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

      const parsed = WhitelistBody.safeParse(request.body ?? {});
      if (!parsed.success) throw HttpError.badRequest('参数不正确');

      const row = ctx.store.getPlayer(uuid);
      if (!row) {
        throw HttpError.notFound(
          '该玩家不在平台记录中。白名单需要玩家名，请先让该玩家上线一次。',
        );
      }

      return audited(
        ctx,
        request,
        {
          action: parsed.data.value ? 'player.whitelist_add' : 'player.whitelist_remove',
          targetType: 'player',
          targetId: uuid,
          nodeId: parsed.data.nodeId,
          params: { name: row.name },
        },
        async () => {
          try {
            return await ctx.gateway.call(parsed.data.nodeId, 'players.setWhitelist', {
              uuid,
              name: row.name,
              value: parsed.data.value,
            });
          } catch (error) {
            throw toHttpError(error);
          }
        },
      );
    },
  );
}

export function deserializeAudit(row: {
  id: number;
  ts: number;
  actor: string;
  actor_ip: string | null;
  action: string;
  target_type: string;
  target_id: string;
  node_id: string | null;
  params: string;
  ok: number;
  error: string | null;
}) {
  let params: unknown = {};
  try {
    params = JSON.parse(row.params);
  } catch {
    params = { _raw: row.params };
  }
  return {
    id: row.id,
    ts: row.ts,
    actor: row.actor,
    actorIp: row.actor_ip,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    nodeId: row.node_id,
    params,
    ok: row.ok === 1,
    error: row.error,
  };
}

export type { PlayerEntry };
