/**
 * 节点管理。
 *
 * 「节点」= 一台被纳管的 MC 服务端。密钥只在创建与轮换时返回明文，
 * 库中存 scrypt 哈希 —— 找不回来只能轮换，这是刻意的。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Capability, Metrics, PlayerEntry, ServerInfo } from '@kokuu/protocol';
import { hashSecret, newNodeSecret } from '../../lib/crypto.ts';
import type { NodeRow } from '../../store/index.ts';
import {
  HttpError,
  audited,
  optStr,
  requirePermission,
  toHttpError,
  type AppContext,
} from '../context.ts';

const NODE_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

const CreateNodeBody = z
  .object({
    id: z.string().regex(NODE_ID_RE, '节点 ID 只能用 2–64 位小写字母、数字、下划线或连字符，且以字母数字开头'),
    name: z.string().min(1).max(64),
    tags: z.array(z.string().max(32)).max(16).optional(),
  })
  .strict();

const UpdateNodeBody = z
  .object({
    name: z.string().min(1).max(64).optional(),
    tags: z.array(z.string().max(32)).max(16).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const ConsoleBody = z.object({ command: z.string().min(1).max(1000) }).strict();

function nodeStatus(ctx: AppContext, row: NodeRow): 'online' | 'offline' | 'disabled' {
  if (row.enabled === 0) return 'disabled';
  return ctx.gateway.isOnline(row.id) ? 'online' : 'offline';
}

function serializeNode(ctx: AppContext, row: NodeRow) {
  const status = nodeStatus(ctx, row);
  const cached = ctx.metrics.get(row.id);
  const metrics = (cached?.data as Metrics | undefined) ?? null;

  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    status,
    lastSeenAt: row.last_seen_at,
    agentVersion: row.agent_version,
    mcVersion: row.mc_version,
    brand: row.brand,
    capabilities: JSON.parse(row.capabilities) as Capability[],
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.created_at,
    onlinePlayers: metrics?.online ?? null,
    maxPlayers: metrics?.maxPlayers ?? null,
    metrics,
    // 让前端能直接判断「这个数据是不是陈旧的」。
    metricsAgeMs: cached ? Date.now() - cached.ts : null,
  };
}

export function registerNodeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/_api/nodes', async (request) => {
    requirePermission(request, 'node.view');
    return { items: ctx.store.listNodes().map((row) => serializeNode(ctx, row)) };
  });

  app.post('/_api/nodes', async (request) => {
    const account = requirePermission(request, 'node.manage');
    const parsed = CreateNodeBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw HttpError.badRequest(
        parsed.error.issues[0]?.message ?? '参数不正确',
        { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      );
    }

    const { id, name, tags } = parsed.data;
    if (ctx.store.getNode(id)) {
      throw new HttpError('CONFLICT', `节点 ${id} 已存在`);
    }

    const secret = newNodeSecret();

    await audited(
      ctx,
      request,
      { action: 'node.create', targetType: 'node', targetId: id, nodeId: id, params: { name, tags } },
      () => {
        ctx.store.createNode({ id, name, secretHash: hashSecret(secret), tags: tags ?? [] });
      },
    );

    void account;
    const row = ctx.store.getNode(id)!;
    return {
      node: serializeNode(ctx, row),
      // 明文密钥只在此刻出现一次。
      secret,
      warning: '请立刻把密钥填入插件配置。关闭本提示后无法再次查看，只能轮换。',
    };
  });

  app.get<{ Params: { id: string } }>('/_api/nodes/:id', async (request) => {
    requirePermission(request, 'node.view');
    const row = ctx.store.getNode(request.params.id);
    if (!row) throw HttpError.notFound(`节点 ${request.params.id} 不存在`);
    return { node: serializeNode(ctx, row) };
  });

  app.patch<{ Params: { id: string } }>('/_api/nodes/:id', async (request) => {
    requirePermission(request, 'node.manage');
    const id = request.params.id;
    const row = ctx.store.getNode(id);
    if (!row) throw HttpError.notFound(`节点 ${id} 不存在`);

    const parsed = UpdateNodeBody.safeParse(request.body ?? {});
    if (!parsed.success) throw HttpError.badRequest('参数不正确');

    await audited(
      ctx,
      request,
      { action: 'node.update', targetType: 'node', targetId: id, nodeId: id, params: parsed.data },
      () => ctx.store.updateNode(id, parsed.data),
    );

    return { node: serializeNode(ctx, ctx.store.getNode(id)!) };
  });

  app.delete<{ Params: { id: string } }>('/_api/nodes/:id', async (request) => {
    requirePermission(request, 'node.manage');
    const id = request.params.id;
    if (!ctx.store.getNode(id)) throw HttpError.notFound(`节点 ${id} 不存在`);

    await audited(
      ctx,
      request,
      { action: 'node.delete', targetType: 'node', targetId: id, nodeId: id },
      () => {
        // 删节点前先断开连接，否则那个连接会一直挂到超时，
        // 期间它还能继续收发（已鉴权），等于留了一个后门。
        const connection = ctx.gateway.get(id);
        connection?.close('node deleted');
        ctx.store.deleteNode(id);
      },
    );

    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/_api/nodes/:id/rotate-secret', async (request) => {
    requirePermission(request, 'node.manage');
    const id = request.params.id;
    if (!ctx.store.getNode(id)) throw HttpError.notFound(`节点 ${id} 不存在`);

    const secret = newNodeSecret();

    await audited(
      ctx,
      request,
      { action: 'node.rotate_secret', targetType: 'node', targetId: id, nodeId: id },
      () => {
        ctx.store.updateNodeSecret(id, hashSecret(secret));
        // 旧密钥立即失效：断开当前连接，迫使 Agent 用新密钥重连。
        ctx.gateway.get(id)?.close('secret rotated');
      },
    );

    return {
      secret,
      warning: '旧密钥已失效，插件需用新密钥重连。此密钥只显示这一次。',
    };
  });

  // ── 透传 Agent 能力 ────────────────────────────────────────

  app.get<{ Params: { id: string } }>('/_api/nodes/:id/info', async (request) => {
    requirePermission(request, 'node.view');
    const id = request.params.id;
    const cached = ctx.serverInfo.get(id);
    if (cached && Date.now() - cached.ts < 30_000) {
      return { info: cached.data as ServerInfo, cached: true };
    }
    try {
      const info = await ctx.gateway.call(id, 'server.info', {});
      ctx.serverInfo.set(id, { data: info, ts: Date.now() });
      return { info, cached: false };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: { id: string } }>('/_api/nodes/:id/metrics', async (request) => {
    requirePermission(request, 'node.view');
    const cached = ctx.metrics.get(request.params.id);
    if (cached) return { metrics: cached.data as Metrics, ageMs: Date.now() - cached.ts };

    try {
      const metrics = await ctx.gateway.call(request.params.id, 'server.metrics', {});
      ctx.metrics.set(request.params.id, { data: metrics, ts: Date.now() });
      return { metrics, ageMs: 0 };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    '/_api/nodes/:id/online',
    async (request) => {
      requirePermission(request, 'player.view');
      const withIp =
        optStr(request.query, 'withIp') === 'true' &&
        (request.permissions?.has('player.view_ip') ?? false);

      try {
        const players = await ctx.gateway.call(request.params.id, 'players.list', { withIp });
        // 普通查看在线列表不写审计（读操作不产生审计噪音），
        // 但带上 IP 时要记 —— 那属于个人信息访问。
        if (withIp) {
          ctx.store.audit({
            actor: request.account?.username ?? 'unknown',
            actorIp: request.clientIp ?? null,
            action: 'player.view_online_with_ip',
            targetType: 'node',
            targetId: request.params.id,
            nodeId: request.params.id,
            ok: true,
          });
        }
        return { players: players as PlayerEntry[] };
      } catch (error) {
        throw toHttpError(error);
      }
    },
  );

  app.get<{ Params: { id: string } }>('/_api/nodes/:id/console/history', async (request) => {
    requirePermission(request, 'console.execute');
    return { lines: ctx.hub.consoleHistory(request.params.id) };
  });

  app.post<{ Params: { id: string } }>('/_api/nodes/:id/console', async (request) => {
    requirePermission(request, 'console.execute');
    const id = request.params.id;

    const parsed = ConsoleBody.safeParse(request.body ?? {});
    if (!parsed.success) throw HttpError.badRequest('命令不能为空');

    return audited(
      ctx,
      request,
      {
        action: 'console.execute',
        targetType: 'node',
        targetId: id,
        nodeId: id,
        params: { command: parsed.data.command },
      },
      async () => {
        try {
          return await ctx.gateway.call(id, 'console.execute', {
            command: parsed.data.command,
          });
        } catch (error) {
          throw toHttpError(error);
        }
      },
    );
  });
}
