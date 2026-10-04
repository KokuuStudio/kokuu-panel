<script setup lang="ts">
/**
 * 后台布局：侧边栏（权限过滤的菜单）+ 顶栏（页面标题 / 实时连接状态 / 主题）+ 内容区。
 *
 * 菜单项的显示完全由 `auth.hasPerm(meta.permission)` 决定，
 * **不判断角色名** —— 服务端可以给账号单独授权，按角色猜一定会有偏差。
 */
import {
  Avatar,
  Bell,
  Coin,
  CircleClose,
  Connection,
  Document,
  Expand,
  Fold,
  Key,
  Monitor,
  Moon,
  Odometer,
  Sunny,
  SwitchButton,
  User,
} from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import type { Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAuthStore } from '@/stores/auth';
import { useEventsStore } from '@/stores/events';
import { useNodesStore } from '@/stores/nodes';
import { roleLabel } from '@/utils/permissions';
import { resolvedTheme, themeMode, setThemeMode } from '@/utils/theme';

interface NavItem {
  name: string;
  label: string;
  icon: Component;
  permission: string;
  children?: NavItem[];
}

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const events = useEventsStore();
const nodes = useNodesStore();

const collapsed = ref(false);

const navItems: NavItem[] = [
  {
    name: 'servers',
    label: '服务器',
    icon: Monitor,
    permission: 'node.view',
    children: [
      { name: 'dashboard', label: '总览', icon: Odometer, permission: 'node.view' },
      { name: 'nodes', label: '节点管理', icon: Monitor, permission: 'node.view' },
    ],
  },
  {
    name: 'players-group',
    label: '玩家管理',
    icon: User,
    permission: 'player.view',
    children: [
      { name: 'players', label: '玩家列表', icon: User, permission: 'player.view' },
      { name: 'punishments', label: '封禁 / 禁言', icon: CircleClose, permission: 'punish.view' },
    ],
  },
  { name: 'luckperms', label: '权限组', icon: Key, permission: 'luckperms.view' },
  { name: 'economy', label: '经济', icon: Coin, permission: 'economy.view' },
  { name: 'audit', label: '审计日志', icon: Document, permission: 'audit.view' },
  { name: 'accounts', label: '后台账号', icon: Avatar, permission: 'account.manage' },
];

/** 过滤掉无权限的菜单项；父项在子项全被过滤后一并隐藏。 */
const visibleNav = computed<NavItem[]>(() => {
  const result: NavItem[] = [];
  for (const item of navItems) {
    if (!auth.hasPerm(item.permission)) continue;
    if (item.children && item.children.length > 0) {
      const children = item.children.filter((child) => auth.hasPerm(child.permission));
      if (children.length === 0) continue;
      result.push({ ...item, children });
      continue;
    }
    result.push(item);
  }
  return result;
});

const activeMenu = computed(() => {
  const name = route.name;
  if (typeof name === 'string') {
    if (name === 'node-detail') return 'nodes';
    if (name === 'player-detail') return 'players';
    return name;
  }
  return '';
});

/**
 * 菜单点击 → 按**路由名**跳转。
 *
 * 刻意不用 el-menu 的 `router` 属性：那个属性把 index 当**路径** push，
 * 而这里的 index 是路由名。`dashboard` 的名字与路径（`/`）不一致，
 * 用 router 属性点「总览」会跳到 `/dashboard` → 404；其它项因为
 * 名字恰好等于路径而蒙对，所以只有总览暴露出来。
 *
 * @param index el-menu 抛出的 index，在当前设计里就是路由名
 */
function onNavSelect(index: string): void {
  if (!router.hasRoute(index)) return;
  // 重复点击当前页时 push 会 reject（NavigationDuplicated），这里吞掉即可。
  void router.push({ name: index }).catch(() => undefined);
}

const pageTitle = computed(() => route.meta.title ?? 'KokuuPanel');

const wsState = computed(() => {
  switch (events.state) {
    case 'subscribed':
      return { label: '实时已连接', type: 'success' as const };
    case 'open':
      return { label: '实时握手…', type: 'warning' as const };
    case 'connecting':
    case 'reconnecting':
      return { label: '实时重连中', type: 'warning' as const };
    case 'failed':
      return { label: '实时连接失败', type: 'danger' as const };
    default:
      return { label: '实时未连接', type: 'info' as const };
  }
});

const onlineNodeCount = computed(() => nodes.nodes.filter((node) => node.status === 'online').length);
// onlinePlayers 可能是 null（节点在线但还没收到 metrics）—— 计 0，不显示「—」的地方是汇总数字。
const totalOnline = computed(() =>
  nodes.nodes.reduce(
    (sum, node) => sum + (node.status === 'online' ? (node.onlinePlayers ?? 0) : 0),
    0,
  ),
);

async function handleThemeCommand(command: string | number | object): Promise<void> {
  const value = String(command);
  if (value === 'theme-light') setThemeMode('light');
  if (value === 'theme-dark') setThemeMode('dark');
  if (value === 'theme-system') setThemeMode('system');
}

async function handleAccountCommand(command: string | number | object): Promise<void> {
  if (String(command) !== 'logout') return;
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '退出登录', {
      type: 'warning',
      confirmButtonText: '退出',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  await auth.logout();
  events.disconnect();
  ElMessage.success('已退出登录');
  await router.replace({ name: 'login' });
}

onMounted(() => {
  // 布局挂载时建立实时连接（会话已确认）。失败不阻塞页面。
  events.connect();
  if (!nodes.loaded) void nodes.refreshQuietly();
});
</script>

<template>
  <div class="layout" :class="{ 'layout--collapsed': collapsed }">
    <aside class="layout__sidebar">
      <div class="brand">
        <span class="brand__logo">K</span>
        <span v-show="!collapsed" class="brand__text">KokuuPanel</span>
      </div>

      <el-scrollbar class="layout__nav">
        <!--
          ⚠ 这里**不能**用 el-menu 的 `router` 属性。

          那个属性会拿 `index` 直接 router.push()，也就是**当成路径**用；
          而 navItems 里的 index 是**路由名**（见上面的 navItems 定义，
          以及下面 activeMenu 用的也是 route.name）。两者不总是一样：

              name = dashboard  →  路径是 /          → push('/dashboard') 404
              name = nodes      →  路径是 /nodes     → push('/nodes') 碰巧对

          所以只有「总览」会 404，其它项是蒙对的 —— 这种 bug 最难发现。
          改成显式按名字跳转（onNavSelect），名字与路径就不需要一一对应了。
        -->
        <el-menu
          :default-active="activeMenu"
          :collapse="collapsed"
          :collapse-transition="false"
          class="layout__menu"
          @select="onNavSelect"
        >
          <template v-for="item in visibleNav" :key="item.name">
            <el-sub-menu v-if="item.children" :index="item.name">
              <template #title>
                <el-icon><component :is="item.icon" /></el-icon>
                <span>{{ item.label }}</span>
              </template>
              <el-menu-item v-for="child in item.children" :key="child.name" :index="child.name">
                <el-icon><component :is="child.icon" /></el-icon>
                <template #title>{{ child.label }}</template>
              </el-menu-item>
            </el-sub-menu>
            <el-menu-item v-else :index="item.name">
              <el-icon><component :is="item.icon" /></el-icon>
              <template #title>{{ item.label }}</template>
            </el-menu-item>
          </template>
        </el-menu>
      </el-scrollbar>

      <div class="layout__nav-footer">
        <el-tooltip content="在线节点 / 在线玩家" placement="right">
          <span class="nav-stat">
            <el-icon><Connection /></el-icon>
            <span v-show="!collapsed">{{ onlineNodeCount }} / {{ totalOnline }}</span>
          </span>
        </el-tooltip>
      </div>
    </aside>

    <div class="layout__main">
      <header class="layout__header">
        <div class="layout__header-left">
          <el-button
            text
            :icon="collapsed ? Expand : Fold"
            class="layout__collapse"
            @click="collapsed = !collapsed"
          />
          <h1 class="layout__title">{{ pageTitle }}</h1>
        </div>

        <div class="layout__header-right">
          <el-tooltip :content="events.lastError || wsState.label" placement="bottom">
            <el-tag :type="wsState.type" size="small" effect="plain" disable-transitions>
              <el-icon class="layout__ws-icon"><Bell /></el-icon>
              {{ wsState.label }}
            </el-tag>
          </el-tooltip>

          <el-dropdown trigger="click" @command="handleThemeCommand">
            <el-button text :icon="resolvedTheme === 'dark' ? Moon : Sunny" />
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="theme-system" :disabled="themeMode === 'system'">
                  跟随系统
                </el-dropdown-item>
                <el-dropdown-item command="theme-light" :disabled="themeMode === 'light'">
                  浅色
                </el-dropdown-item>
                <el-dropdown-item command="theme-dark" :disabled="themeMode === 'dark'">
                  深色
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>

          <el-dropdown trigger="click" @command="handleAccountCommand">
            <span class="layout__account">
              <el-avatar :size="26" class="layout__avatar">
                {{ auth.account?.username.slice(0, 1).toUpperCase() }}
              </el-avatar>
              <span class="layout__account-name">{{ auth.account?.username }}</span>
              <el-tag size="small" effect="plain" disable-transitions>
                {{ roleLabel(auth.account?.role) }}
              </el-tag>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>
                  权限点 {{ auth.permissions.length }} 项
                </el-dropdown-item>
                <el-dropdown-item divided command="logout">
                  <el-icon><SwitchButton /></el-icon>
                  退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <main class="layout__content">
        <router-view v-slot="{ Component: ViewComponent }">
          <component :is="ViewComponent" />
        </router-view>
      </main>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  min-height: 100vh;
  background: var(--el-bg-color-page);
}

.layout__sidebar {
  display: flex;
  flex-direction: column;
  width: var(--kp-sidebar-width);
  flex: 0 0 var(--kp-sidebar-width);
  background: var(--el-bg-color);
  border-right: 1px solid var(--kp-border);
  transition: width 0.18s ease;
}

.layout--collapsed .layout__sidebar {
  width: var(--kp-sidebar-width-collapsed);
  flex-basis: var(--kp-sidebar-width-collapsed);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--kp-header-height);
  padding: 0 14px;
  border-bottom: 1px solid var(--kp-border);
  overflow: hidden;
}

.brand__logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--el-color-primary);
  color: #fff;
  font-weight: 700;
  flex: 0 0 auto;
}

.brand__text {
  font-weight: 600;
  white-space: nowrap;
}

.layout__nav {
  flex: 1 1 auto;
}

.layout__menu {
  border-right: none;
}

.layout__nav-footer {
  padding: 10px 14px;
  border-top: 1px solid var(--kp-border);
  font-size: 12px;
  color: var(--kp-text-muted);
}

.nav-stat {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.layout__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.layout__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: var(--kp-header-height);
  padding: 0 18px;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--kp-border);
  position: sticky;
  top: 0;
  z-index: 10;
}

.layout__header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.layout__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.layout__header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.layout__ws-icon {
  margin-right: 4px;
  vertical-align: -2px;
}

.layout__account {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  outline: none;
}

.layout__avatar {
  background: var(--el-color-primary);
}

.layout__account-name {
  font-size: 13px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layout__content {
  flex: 1 1 auto;
  padding: 18px;
  min-width: 0;
}

@media (max-width: 720px) {
  .layout__account-name {
    display: none;
  }

  .layout__content {
    padding: 12px;
  }
}
</style>
