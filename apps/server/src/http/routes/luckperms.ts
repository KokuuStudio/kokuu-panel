/**
 * LuckPerms 管理。
 *
 * 全部按节点操作 —— LuckPerms 的数据存在**每个服务端各自**的存储里
 * （文件或 MySQL），平台不持有它的权威副本。
 *
 * 这一点与封禁相反，值得讲清楚：封禁放平台是因为多服必须一致；
 * 权限组放平台则会造成两套数据打架。平台在这里的角色是
 * **远程编辑器**，不是数据库。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { isSafeUuid, type LpGroup, type LpUser } from '@kokuu/protocol';
import {
  HttpError,
  audited,
  requirePermission,
  toHttpError,
  type AppContext,
} from '../context.ts';

const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const GROUP_RE = /^[a-z0-9_-]{1,64}$/;
const PERM_RE = /^[A-Za-z0-9_.*\-]{1,128}$/;

const GroupBody = z.object({ group: z.string().regex(GROUP_RE, '组名不合法') }).strict();

const GroupToggleBody = z
  .object({ group: z.string().regex(GROUP_RE), add: z.boolean() })
  .strict();

const PermissionBody = z
  .object({
    permission: z.string().regex(PERM_RE, '权限节点含有非法字符'),
    value: z.boolean(),
  })
  .strict();

const UnsetPermissionBody = z
  .object({ permission: z.string().regex(PERM_RE) })
  .strict();

const MetaBody = z
  .object({
    prefix: z.string().max(64).optional(),
    suffix: z.string().max(64).optional(),
  })
  .strict();

const ParentToggleBody = z
  .object({ parent: z.string().regex(GROUP_RE), add: z.boolean() })
  .strict();

const WeightBody = z.object({ weight: z.number().int().min(-32768).max(32767) }).strict();

const CreateGroupBody = z.object({ name: z.string().regex(GROUP_RE) }).strict();

/** 统一的 Agent 调用包装：把 Agent 错误转成 HTTP 错误。 */
async function callAgent<T>(
  ctx: AppContext,
  nodeId: string,
  method: string,
  params: unknown,
): Promise<T> {
  try {
    return (await ctx.gateway.callRaw(nodeId, method, params)) as T;
  } catch (error) {
    throw toHttpError(error);
  }
}

export function registerLuckPermsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const prefix = '/_api/luckperms/nodes/:nodeId';

  // ── 用户 ───────────────────────────────────────────────────

  app.get<{ Params: { nodeId: string; uuid: string } }>(
    `${prefix}/users/:uuid`,
    async (request) => {
      requirePermission(request, 'luckperms.view');
      const { nodeId, uuid } = request.params;
      if (!UUID_RE.test(uuid)) throw HttpError.badRequest('UUID 格式不正确');

      const player = ctx.store.getPlayer(uuid);
      const user = await callAgent<LpUser>(ctx, nodeId, 'luckperms.user.get', {
        uuid,
        name: player?.name,
      });
      return { user };
    },
  );

  app.post<{ Params: { nodeId: string; uuid: string } }>(
    `${prefix}/users/:uuid/primary-group`,
    async (request) => {
      requirePermission(request, 'luckperms.manage');
      const { nodeId, uuid } = request.params;
      const parsed = GroupBody.safeParse(request.body ?? {});
      if (!parsed.success) throw HttpError.badRequest('组名不合法');

      return audited(
        ctx,
        request,
        {
          action: 'luckperms.user.set_primary_group',
          targetType: 'player',
          targetId: uuid,
          nodeId,
          params: parsed.data,
        },
        () =>
          callAgent(ctx, nodeId, 'luckperms.user.setPrimaryGroup', {
            uuid,
            group: parsed.data.group,
          }),
      );
    },
  );

  app.post<{ Params: { nodeId: string; uuid: string } }>(
    `${prefix}/users/:uuid/groups`,
    async (request) => {
      requirePermission(request, 'luckperms.manage');
      const { nodeId, uuid } = request.params;
      const parsed = GroupToggleBody.safeParse(request.body ?? {});
      if (!parsed.success) throw HttpError.badRequest('参数不正确');

      return audited(
        ctx,
        request,
        {
          action: parsed.data.add ? 'luckperms.user.add_group' : 'luckperms.user.remove_group',
          targetType: 'player',
          targetId: uuid,
          nodeId,
          params: parsed.data,
        },
        () =>
          callAgent(
            ctx,
            nodeId,
            parsed.data.add ? 'luckperms.user.addGroup' : 'luckperms.user.removeGroup',
            { uuid, group: parsed.data.group },
          ),
      );
    },
  );

  app.post<{ Params: { nodeId: string; uuid: string } }>(
    `${prefix}/users/:uuid/permissions`,
    async (request) => {
      requirePermission(request, 'luckperms.manage');
      const { nodeId, uuid } = request.params;
      const parsed = PermissionBody.safeParse(request.body ?? {});
      if (!parsed.success) throw HttpError.badRequest('权限节点格式不正确');

      return audited(
        ctx,
        request,
        {
          action: 'luckperms.user.set_permission',
          targetType: 'player',
          targetId: uuid,
          nodeId,
          params: parsed.data,
        },
        () =>
          callAgent(ctx, nodeId, 'luckperms.user.setPermission', {
            uuid,
            permission: parsed.data.permission,
            value: parsed.data.value,
          }),
      );
    },
  );

  app.delete<{ Params: { nodeId: string; uuid: string } }>(
    `${prefix}/users/:uuid/permissions`,
    async (request) => {
      requirePermission(request, 'luckperms.manage');
      const { nodeId, uuid } = request.params;
      const parsed = UnsetPermissionBody.safeParse(request.body ?? {});
      if (!parsed.success) throw HttpError.badRequest('权限节点格式不正确');

      return audited(
        ctx,
        request,
        {
          action: 'luckperms.user.unset_permission',
          targetType: 'player',
          targetId: uuid,
          nodeId,
          params: parsed.data,
        },
        () =>
          callAgent(ctx, nodeId, 'luckperms.user.unsetPermission', {
            uuid,
            permission: parsed.data.permission,
          }),
      );
    },
  );

  app.post<{ Params: { nodeId: string; uuid: string } }>(
    `${prefix}/users/:uuid/meta`,
    async (request) => {
      requirePermission(request, 'luckperms.manage');
      const { nodeId, uuid } = request.params;
      const parsed = MetaBody.safeParse(request.body ?? {});
      if (!parsed.success) throw HttpError.badRequest('前后缀过长');

      return audited(
        ctx,
        request,
        {
          action: 'luckperms.user.set_meta',
          targetType: 'player',
          targetId: uuid,
          nodeId,
          params: parsed.data,
        },
        () => callAgent(ctx, nodeId, 'luckperms.user.setMeta', { uuid, ...parsed.data }),
      );
    },
  );

  // ── 权限目录 ───────────────────────────────────────────────

  /**
   * 这个节点上**存在**哪些权限节点（只读，给界面做候选）。
   *
   * 有了它，加权限时才不用盲敲 —— 敲一个没人注册过的节点，LuckPerms 会照样存下来，
   * 但它永远不会生效，而管理员从界面上看不出区别。
   */
  app.get<{ Params: { nodeId: string } }>(`${prefix}/permissions`, async (request) => {
    requirePermission(request, 'luckperms.view');
    const query = request.query as Record<string, unknown>;

    const q = typeof query.q === 'string' && query.q.trim() ? query.q.trim().slice(0, 64) : undefined;
    const parsedLimit = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : Number.NaN;
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 1000)
      : undefined;

    return callAgent(ctx, request.params.nodeId, 'luckperms.permissions.catalog', {
      ...(q ? { query: q } : {}),
      ...(limit === undefined ? {} : { limit }),
    });
  });

  // ── 组 ─────────────────────────────────────────────────────

  app.get<{ Params: { nodeId: string } }>(`${prefix}/groups`, async (request) => {
    requirePermission(request, 'luckperms.view');
    const groups = await callAgent<LpGroup[]>(
      ctx,
      request.params.nodeId,
      'luckperms.groups.list',
      {},
    );
    // 按权重降序 —— 这就是 LP 自己判定继承优先级的顺序。
    return { groups: [...groups].sort((a, b) => b.weight - a.weight) };
  });

  app.post<{ Params: { nodeId: string } }>(`${prefix}/groups`, async (request) => {
    requirePermission(request, 'luckperms.manage');
    const { nodeId } = request.params;
    const parsed = CreateGroupBody.safeParse(request.body ?? {});
    if (!parsed.success) throw HttpError.badRequest('组名只能是小写字母、数字、下划线或连字符');

    return audited(
      ctx,
      request,
      { action: 'luckperms.group.create', targetType: 'group', targetId: parsed.data.name, nodeId, params: parsed.data },
      () => callAgent(ctx, nodeId, 'luckperms.group.create', { name: parsed.data.name }),
    );
  });

  app.delete<{ Params: { nodeId: string; name: string } }>(
    `${prefix}/groups/:name`,
    async (request) => {
      requirePermission(request, 'luckperms.manage');
      const { nodeId, name } = request.params;
      if (!GROUP_RE.test(name)) throw HttpError.badRequest('组名不合法');

      return audited(
        ctx,
        request,
        { action: 'luckperms.group.delete', targetType: 'group', targetId: name, nodeId },
        () => callAgent(ctx, nodeId, 'luckperms.group.delete', { name }),
      );
    },
  );

  app.post<{ Params: { nodeId: string; name: string } }>(
    `${prefix}/groups/:name/permissions`,
    async (request) => {
      requirePermission(request, 'luckperms.manage');
      const { nodeId, name } = request.params;
      const parsed = PermissionBody.safeParse(request.body ?? {});
      if (!parsed.success) throw HttpError.badRequest('权限节点格式不正确');

      return audited(
        ctx,
        request,
        {
          action: 'luckperms.group.set_permission',
          targetType: 'group',
          targetId: name,
          nodeId,
          params: parsed.data,
        },
        () =>
          callAgent(ctx, nodeId, 'luckperms.group.setPermission', {
            name,
            permission: parsed.data.permission,
            value: parsed.data.value,
          }),
      );
    },
  );

  app.delete<{ Params: { nodeId: string; name: string } }>(
    `${prefix}/groups/:name/permissions`,
    async (request) => {
      requirePermission(request, 'luckperms.manage');
      const { nodeId, name } = request.params;
      const parsed = UnsetPermissionBody.safeParse(request.body ?? {});
      if (!parsed.success) throw HttpError.badRequest('权限节点格式不正确');

      return audited(
        ctx,
        request,
        {
          action: 'luckperms.group.unset_permission',
          targetType: 'group',
          targetId: name,
          nodeId,
          params: parsed.data,
        },
        () =>
          callAgent(ctx, nodeId, 'luckperms.group.unsetPermission', {
            name,
            permission: parsed.data.permission,
          }),
      );
    },
  );

  app.post<{ Params: { nodeId: string; name: string } }>(
    `${prefix}/groups/:name/parents`,
    async (request) => {
      requirePermission(request, 'luckperms.manage');
      const { nodeId, name } = request.params;
      const parsed = ParentToggleBody.safeParse(request.body ?? {});
      if (!parsed.success) throw HttpError.badRequest('父组名不合法');

      if (parsed.data.add && parsed.data.parent === name) {
        throw HttpError.badRequest('一个组不能是自己的父组');
      }

      return audited(
        ctx,
        request,
        {
          action: parsed.data.add ? 'luckperms.group.set_parent' : 'luckperms.group.remove_parent',
          targetType: 'group',
          targetId: name,
          nodeId,
          params: parsed.data,
        },
        () =>
          callAgent(
            ctx,
            nodeId,
            parsed.data.add ? 'luckperms.group.setParent' : 'luckperms.group.removeParent',
            { name, parent: parsed.data.parent },
          ),
      );
    },
  );

  app.post<{ Params: { nodeId: string; name: string } }>(
    `${prefix}/groups/:name/weight`,
    async (request) => {
      requirePermission(request, 'luckperms.manage');
      const { nodeId, name } = request.params;
      const parsed = WeightBody.safeParse(request.body ?? {});
      if (!parsed.success) throw HttpError.badRequest('权重必须是 -32768 到 32767 之间的整数');

      return audited(
        ctx,
        request,
        {
          action: 'luckperms.group.set_weight',
          targetType: 'group',
          targetId: name,
          nodeId,
          params: parsed.data,
        },
        () =>
          callAgent(ctx, nodeId, 'luckperms.group.setWeight', {
            name,
            weight: parsed.data.weight,
          }),
      );
    },
  );

  app.post<{ Params: { nodeId: string; name: string } }>(
    `${prefix}/groups/:name/meta`,
    async (request) => {
      requirePermission(request, 'luckperms.manage');
      const { nodeId, name } = request.params;
      const parsed = MetaBody.safeParse(request.body ?? {});
      if (!parsed.success) throw HttpError.badRequest('前后缀过长');

      return audited(
        ctx,
        request,
        {
          action: 'luckperms.group.set_meta',
          targetType: 'group',
          targetId: name,
          nodeId,
          params: parsed.data,
        },
        () => callAgent(ctx, nodeId, 'luckperms.group.setMeta', { name, ...parsed.data }),
      );
    },
  );
}
