/** 审计日志查询。只读，不提供删除接口 —— 审计能被删就不叫审计了。 */

import type { FastifyInstance } from 'fastify';

import {
  optBool,
  optInt,
  optStr,
  pageParams,
  requirePermission,
  type AppContext,
} from '../context.ts';
import { deserializeAudit } from './players.ts';

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/_api/audit', async (request) => {
    requirePermission(request, 'audit.view');
    const query = request.query as Record<string, unknown>;
    const { page, size } = pageParams(query);

    const result = ctx.store.listAudit({
      actor: optStr(query, 'actor'),
      action: optStr(query, 'action'),
      targetType: optStr(query, 'targetType'),
      targetId: optStr(query, 'targetId'),
      nodeId: optStr(query, 'nodeId'),
      ok: optBool(query, 'ok'),
      from: optInt(query, 'from'),
      to: optInt(query, 'to'),
      page,
      size,
    });

    return {
      items: result.items.map(deserializeAudit),
      total: result.total,
      page: result.page,
      size: result.size,
    };
  });

  /** 供前端做筛选下拉：库里实际出现过的 action 前缀。 */
  app.get('/_api/audit/actions', async (request) => {
    requirePermission(request, 'audit.view');
    return {
      actions: [
        'auth.logout',
        'node.create',
        'node.update',
        'node.delete',
        'node.rotate_secret',
        'console.execute',
        'player.kick',
        'player.op',
        'player.deop',
        'player.set_gamemode',
        'player.whitelist_add',
        'player.whitelist_remove',
        'player.view_ip_history',
        'player.view_online_with_ip',
        'punish.create',
        'punish.revoke',
        'luckperms.user.set_primary_group',
        'luckperms.user.add_group',
        'luckperms.user.remove_group',
        'luckperms.user.set_permission',
        'luckperms.user.unset_permission',
        'luckperms.user.set_meta',
        'luckperms.group.create',
        'luckperms.group.delete',
        'luckperms.group.set_permission',
        'luckperms.group.unset_permission',
        'luckperms.group.set_parent',
        'luckperms.group.remove_parent',
        'luckperms.group.set_weight',
        'luckperms.group.set_meta',
        'economy.adjust',
        'economy.adjust_game_currency',
        'economy.update_config',
        'account.create',
        'account.update',
        'account.delete',
      ],
    };
  });
}
