/**
 * 封禁 / 禁言。
 *
 * 这是整个平台**跨系统语义最强**的一个模块，两条规则必须守住：
 *
 * 1. **平台是唯一权威。** 记录先落库，再下发。下发失败不回滚 ——
 *    权威状态已经变了，回滚会让「平台显示没封但游戏里封了」更难查。
 * 2. **下发失败必须暴露给操作人。** 响应里带 `dispatched` 明细，
 *    前端要把失败的节点显式展示出来。静默吞掉会让管理员
 *    以为已经全服生效，而实际上漏了一个服。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { isSafeUuid, type Punishment } from '@kokuu/protocol';
import { newId } from '../../lib/crypto.ts';
import { toProtocolPunishment } from '../../agent/gateway.ts';
import type { PunishmentRow } from '../../store/index.ts';
import {
  HttpError,
  audited,
  optBool,
  optStr,
  pageParams,
  requirePermission,
  type AppContext,
} from '../context.ts';
import { deserializeAudit } from './players.ts';

const CreatePunishmentBody = z
  .object({
    type: z.enum(['ban', 'mute', 'warn', 'kick']),
    uuid: z.string().refine(isSafeUuid, 'UUID 格式不正确'),
    name: z.string().regex(/^[A-Za-z0-9_]{1,16}$/, '玩家名格式不正确'),
    reason: z.string().min(1, '必须填写原因').max(500),
    /** null = 永久。 */
    durationSeconds: z.number().int().positive().max(365 * 24 * 3600).nullable().optional(),
    /** null / 省略 = 全平台。 */
    nodeId: z.string().min(1).max(64).nullable().optional(),
    /** ban 时是否立刻踢下线，默认 true。 */
    kickNow: z.boolean().optional(),
  })
  .strict();

export interface DispatchResult {
  nodeId: string;
  ok: boolean;
  code?: string;
  message?: string;
}

/**
 * REST 层的封禁序列化。
 *
 * 比协议里的 `Punishment` 多一个 `bsPid` —— **故意不放进协议类型**：
 * Agent 侧的参数校验会拒绝未知字段，往 `punish.apply` 的载荷里塞新字段
 * 会让整个下发失败。所以身份锚点只在平台与界面之间可见。
 */
function serializePunishment(row: PunishmentRow) {
  return {
    ...toProtocolPunishment(row),
    bsPid: row.bs_pid,
    // 协议里没有这两个字段（Agent 用不上，而且它的入参校验会拒绝未知字段），
    // 但界面要区分「已撤销」与「已过期」—— 后者是自然到期，前者是人撤的。
    // 只靠 active=false + expiresAt 对时间能猜，但猜不准（撤销一条永久的
    // 封禁时 expiresAt 是 null，两种情况的形状完全一样）。
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}

export function registerPunishmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/_api/punishments', async (request) => {
    requirePermission(request, 'punish.view');
    const query = request.query as Record<string, unknown>;
    const { page, size } = pageParams(query);

    const result = ctx.store.listPunishments({
      type: optStr(query, 'type'),
      active: optBool(query, 'active'),
      uuid: optStr(query, 'uuid'),
      nodeId: optStr(query, 'node'),
      kw: optStr(query, 'kw'),
      page,
      size,
    });

    return {
      items: result.items.map(serializePunishment),
      total: result.total,
      page: result.page,
      size: result.size,
    };
  });

  app.post('/_api/punishments', async (request) => {
    requirePermission(request, 'punish.manage');

    const parsed = CreatePunishmentBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw HttpError.badRequest(
        parsed.error.issues[0]?.message ?? '参数不正确',
        {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      );
    }

    const body = parsed.data;
    const nodeId = body.nodeId ?? null;
    const expiresAt =
      body.durationSeconds == null ? null : Date.now() + body.durationSeconds * 1000;

    const id = newId('p');
    const operator = request.account?.username ?? 'unknown';

    // ── 身份解析：把游戏里的身份映射到皮肤站角色 ──
    //
    // 这一步决定封禁扛不扛得住改名。本站 UUID 由角色名派生
    // （md5 of "OfflinePlayer:"+名字），所以按 UUID 存 = 改名即失效。
    // 详见 docs/ECOSYSTEM.md §4.1。
    const bsPid = ctx.store.resolveCharacterPid({ uuid: body.uuid, name: body.name });

    const punishment = await audited(
      ctx,
      request,
      {
        action: 'punish.create',
        targetType: 'player',
        targetId: body.uuid,
        nodeId,
        params: {
          type: body.type,
          reason: body.reason,
          durationSeconds: body.durationSeconds ?? null,
          nodeId,
          name: body.name,
          bsPid,
        },
      },
      () =>
        ctx.store.createPunishment({
          id,
          type: body.type,
          uuid: body.uuid,
          name: body.name,
          reason: body.reason,
          operator,
          nodeId,
          expiresAt,
          bsPid,
        }),
    );

    // 解析不出 pid 时必须说清楚后果，不能默默存一条看起来正常的封禁。
    // 「封禁显示生效、实际能被改名绕过」是最危险的状态 ——
    // 管理员不会去查，直到有人在论坛上炫耀。
    const warning =
      bsPid === null
        ? '该封禁**未关联皮肤站角色**，只能按 UUID 匹配。本站 UUID 由角色名派生' +
          '（Yggdrasil UUID v3），所以玩家改名后此封禁将不再生效。' +
          '请先导入角色目录（node tools/import-characters.mjs --help）后重建该封禁。'
        : null;

    const protocolPunishment = toProtocolPunishment(punishment);
    const dispatched = await dispatchPunishment(ctx, protocolPunishment);

    // ban/kick 且要求立刻生效时，把人踢下线。
    // 这一步失败不影响封禁本身 —— 他下次登录照样进不来。
    if ((body.type === 'ban' || body.type === 'kick') && body.kickNow !== false) {
      const targets = nodeId
        ? [nodeId]
        : ctx.store.listNodes().map((n) => n.id);

      for (const target of targets) {
        if (!ctx.gateway.isOnline(target)) continue;
        try {
          await ctx.gateway.call(target, 'punish.kickNow', {
            uuid: body.uuid,
            reason: body.reason,
          });
        } catch {
          // 玩家可能本来就不在那个服上，踢不到是正常的。
          continue;
        }
      }
    }

    // 广播新快照，让所有节点刷新本地封禁表。
    ctx.gateway.broadcastPunishSnapshot();
    ctx.hub.publish('punish', 'punish.applied', protocolPunishment);

    return { punishment: serializePunishment(punishment), dispatched, bsPid, warning };
  });

  app.post<{ Params: { id: string } }>(
    '/_api/punishments/:id/revoke',
    async (request) => {
      requirePermission(request, 'punish.manage');
      const id = request.params.id;
      const operator = request.account?.username ?? 'unknown';

      const revoked = await audited(
        ctx,
        request,
        { action: 'punish.revoke', targetType: 'punishment', targetId: id },
        () => {
          const row = ctx.store.revokePunishment(id, operator);
          if (!row) {
            throw new HttpError(
              'NOT_FOUND',
              '该封禁记录不存在，或已经被撤销',
            );
          }
          return row;
        },
      );

      const dispatched = await dispatchPunishment(
        ctx,
        toProtocolPunishment(revoked),
        true,
      );

      ctx.gateway.broadcastPunishSnapshot();
      ctx.hub.publish('punish', 'punish.revoked', { id });

      return { punishment: serializePunishment(revoked), dispatched };
    },
  );

  /** 某个玩家当前的生效封禁（详情页用）。 */
  app.get<{ Params: { uuid: string }; Querystring: Record<string, unknown> }>(
    '/_api/punishments/by-player/:uuid',
    async (request) => {
      requirePermission(request, 'punish.view');
      const uuid = request.params.uuid;
      if (!isSafeUuid(uuid)) throw HttpError.badRequest('UUID 格式不正确');

      const player = ctx.store.getPlayer(uuid);
      const name = optStr(request.query, 'name') ?? player?.name ?? null;

      // 先按角色 pid 查（权威），再按 UUID 查（兜底：目录未导入时只有这条路）。
      const bsPid =
        player?.bs_pid ?? ctx.store.resolveCharacterPid({ uuid, name });

      const byPid = bsPid === null ? [] : ctx.store.listActivePunishmentsForPid(bsPid);
      const byUuid = ctx.store.listActivePunishmentsFor(uuid);

      // 合并去重（同一条可能两边都命中）。
      const merged = new Map<string, ReturnType<typeof serializePunishment>>();
      for (const row of [...byPid, ...byUuid]) merged.set(row.id, serializePunishment(row));

      return {
        items: [...merged.values()],
        bsPid,
        /** 没有 pid 就只能按 UUID 匹配 —— 改名即失效，界面上要说出来。 */
        renameBypassable: bsPid === null && merged.size > 0,
      };
    },
  );

  app.get('/_api/audit/punishments', async (request) => {
    requirePermission(request, 'audit.view');
    const { page, size } = pageParams(request.query as Record<string, unknown>);
    const result = ctx.store.listAudit({ action: 'punish.', page, size });
    return {
      items: result.items.map(deserializeAudit),
      total: result.total,
      page: result.page,
      size: result.size,
    };
  });
}

/**
 * 把一条封禁下发给所有相关节点，收集每个节点的结果。
 *
 * 并行走：串行会让 10 个节点里的一个超时把整个请求拖到 30 秒。
 * 每个节点独立 catch，一个失败不影响其他节点。
 */
async function dispatchPunishment(
  ctx: AppContext,
  punishment: Punishment,
  revoke = false,
): Promise<DispatchResult[]> {
  const nodes = ctx.store
    .listNodes()
    .filter((node) => {
      if (node.enabled === 0) return false;
      // 全平台封禁下发到所有节点；限定节点的只下发到那一个。
      if (punishment.nodeId !== null) return node.id === punishment.nodeId;
      return true;
    });

  return Promise.all(
    nodes.map(async (node): Promise<DispatchResult> => {
      if (!ctx.gateway.isOnline(node.id)) {
        return {
          nodeId: node.id,
          ok: false,
          code: 'NODE_OFFLINE',
          message: '节点离线，封禁将在其下次上线时生效',
        };
      }

      try {
        if (revoke) {
          await ctx.gateway.call(node.id, 'punish.revoke', { id: punishment.id });
        } else {
          await ctx.gateway.call(node.id, 'punish.apply', { punishment });
        }
        return { nodeId: node.id, ok: true };
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'INTERNAL';
        return {
          nodeId: node.id,
          ok: false,
          code,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}
