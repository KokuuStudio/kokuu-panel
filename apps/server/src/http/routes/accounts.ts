/**
 * 后台账号管理。
 *
 * 两条保护规则，都是为了「不要把自己锁在门外」：
 * 1. 不能停用或降级**最后一个** owner。
 * 2. 不能删除自己。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ROLE_PERMISSIONS, type Role } from '@kokuu/protocol';
import { hashSecret } from '../../lib/crypto.ts';
import {
  HttpError,
  accountPayload,
  audited,
  currentAccount,
  optStr,
  pageParams,
  requirePermission,
  type AppContext,
} from '../context.ts';

const ROLES: Role[] = ['owner', 'admin', 'moderator', 'viewer'];

const CreateAccountBody = z
  .object({
    username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/, '用户名只能含字母、数字、下划线、点、连字符'),
    password: z.string().min(8, '口令至少 8 位').max(256),
    role: z.enum(['owner', 'admin', 'moderator', 'viewer']),
    displayName: z.string().max(64).optional(),
  })
  .strict();

const UpdateAccountBody = z
  .object({
    role: z.enum(['owner', 'admin', 'moderator', 'viewer']).optional(),
    disabled: z.boolean().optional(),
    password: z.string().min(8, '口令至少 8 位').max(256).optional(),
    displayName: z.string().max(64).optional(),
  })
  .strict();

export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/_api/accounts', async (request) => {
    requirePermission(request, 'account.manage');

    // 支持搜索与分页。界面早就做了搜索框与分页器，但后端原先一律回全量 ——
    // 「搜索了没反应」是最容易被当成前端 bug 的那类问题。
    const query = request.query as Record<string, unknown>;
    const { page, size } = pageParams(query);
    const kw = optStr(query, 'kw')?.toLowerCase();

    let rows = ctx.store.listAccounts();
    if (kw) {
      rows = rows.filter(
        (row) =>
          row.username.toLowerCase().includes(kw) ||
          String(row.id) === kw ||
          (row.display_name ?? '').toLowerCase().includes(kw) ||
          (row.skin_uid !== null && String(row.skin_uid) === kw),
      );
    }

    const total = rows.length;
    const start = (page - 1) * size;

    return {
      items: rows.slice(start, start + size).map((row) => ({
        ...accountPayload(row),
        disabled: row.disabled === 1,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
        lastLoginIp: row.last_login_ip,
        authProvider: row.auth_provider,
        skinUid: row.skin_uid,
      })),
      total,
      page,
      size,
      roles: ROLES.map((role) => ({ role, permissions: ROLE_PERMISSIONS[role] })),
    };
  });

  app.post('/_api/accounts', async (request) => {
    requirePermission(request, 'account.manage');
    const parsed = CreateAccountBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw HttpError.badRequest(parsed.error.issues[0]?.message ?? '参数不正确');
    }

    if (ctx.store.findAccountByUsername(parsed.data.username)) {
      throw new HttpError('CONFLICT', `用户名 ${parsed.data.username} 已被占用`);
    }

    const id = await audited(
      ctx,
      request,
      {
        action: 'account.create',
        targetType: 'account',
        targetId: parsed.data.username,
        params: { role: parsed.data.role },
      },
      () =>
        ctx.store.createAccount({
          username: parsed.data.username,
          passwordHash: hashSecret(parsed.data.password),
          role: parsed.data.role,
          displayName: parsed.data.displayName,
        }),
    );

    const row = ctx.store.findAccountById(id)!;
    return { account: { ...accountPayload(row), disabled: false } };
  });

  app.patch<{ Params: { id: string } }>('/_api/accounts/:id', async (request) => {
    const actor = requirePermission(request, 'account.manage');
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(id)) throw HttpError.badRequest('账号 ID 不正确');

    const target = ctx.store.findAccountById(id);
    if (!target) throw HttpError.notFound('账号不存在');

    const parsed = UpdateAccountBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw HttpError.badRequest(parsed.error.issues[0]?.message ?? '参数不正确');
    }

    const patch = parsed.data;

    // 保护 1：不能把最后一个 owner 停用或降级。
    if (
      target.role === 'owner' &&
      (patch.role !== undefined && patch.role !== 'owner' || patch.disabled === true)
    ) {
      const owners = ctx.store
        .listAccounts()
        .filter((a) => a.role === 'owner' && a.disabled === 0);
      if (owners.length <= 1) {
        throw HttpError.badRequest(
          '这是最后一个可用的 owner 账号，不能停用或降级 —— 否则将没有人能再管理平台',
        );
      }
    }

    // 保护 2：不能停用自己。
    if (patch.disabled === true && id === actor.id) {
      throw HttpError.badRequest('不能停用当前登录的账号');
    }

    await audited(
      ctx,
      request,
      {
        action: 'account.update',
        targetType: 'account',
        targetId: target.username,
        params: { ...patch, password: patch.password ? '***' : undefined },
      },
      () => {
        ctx.store.updateAccount(id, {
          role: patch.role,
          disabled: patch.disabled,
          passwordHash: patch.password ? hashSecret(patch.password) : undefined,
        });
        // 改口令/停用后踢掉该账号的所有会话。
        if (patch.password || patch.disabled) {
          ctx.store.deleteAccountSessions(id);
        }
      },
    );

    return { account: accountPayload(ctx.store.findAccountById(id)!) };
  });

  app.delete<{ Params: { id: string } }>('/_api/accounts/:id', async (request) => {
    const actor = requirePermission(request, 'account.manage');
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(id)) throw HttpError.badRequest('账号 ID 不正确');

    const target = ctx.store.findAccountById(id);
    if (!target) throw HttpError.notFound('账号不存在');

    if (id === actor.id) {
      throw HttpError.badRequest('不能删除当前登录的账号');
    }

    if (target.role === 'owner') {
      const owners = ctx.store
        .listAccounts()
        .filter((a) => a.role === 'owner' && a.disabled === 0);
      if (owners.length <= 1) {
        throw HttpError.badRequest('这是最后一个可用的 owner 账号，不能删除');
      }
    }

    await audited(
      ctx,
      request,
      { action: 'account.delete', targetType: 'account', targetId: target.username },
      () => ctx.store.deleteAccount(id),
    );

    return { ok: true };
  });

  /** 当前登录者自己的信息（含权限点解释）。 */
  app.get('/_api/accounts/me/permissions', async (request) => {
    const account = currentAccount(request);
    return {
      role: account.role,
      permissions: ROLE_PERMISSIONS[account.role as Role] ?? [],
    };
  });
}
