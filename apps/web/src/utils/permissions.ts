/**
 * 权限点常量与展示文案。
 * 角色名（owner/admin/…）只用于**展示**，任何显示/隐藏判断都必须走权限点
 * —— 后端给的是 `account.permissions`，硬编码角色名会在自定义角色时直接失效。
 */
import type { Permission } from '@kokuu/protocol';

export const PERMISSIONS = {
  nodeView: 'node.view',
  nodeManage: 'node.manage',
  playerView: 'player.view',
  playerManage: 'player.manage',
  playerViewIp: 'player.view_ip',
  punishView: 'punish.view',
  punishManage: 'punish.manage',
  luckpermsView: 'luckperms.view',
  luckpermsManage: 'luckperms.manage',
  economyView: 'economy.view',
  economyManage: 'economy.manage',
  consoleExecute: 'console.execute',
  auditView: 'audit.view',
  accountManage: 'account.manage',
} as const satisfies Record<string, Permission>;

/** 权限点 → 中文说明，给账号页/权限提示用。 */
export const PERMISSION_LABELS: Record<string, string> = {
  'node.view': '查看节点',
  'node.manage': '管理节点',
  'player.view': '查看玩家',
  'player.manage': '管理玩家',
  'player.view_ip': '查看玩家 IP',
  'punish.view': '查看封禁',
  'punish.manage': '管理封禁',
  'luckperms.view': '查看权限组',
  'luckperms.manage': '管理权限组',
  'economy.view': '查看经济',
  'economy.manage': '管理经济',
  'console.execute': '执行控制台命令',
  'audit.view': '查看审计',
  'account.manage': '管理后台账号',
};

export const ROLE_LABELS: Record<string, string> = {
  owner: '拥有者',
  admin: '管理员',
  moderator: '版主',
  viewer: '只读',
};

export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission;
}

export function roleLabel(role: string | null | undefined): string {
  if (!role) return '—';
  return ROLE_LABELS[role] ?? role;
}
