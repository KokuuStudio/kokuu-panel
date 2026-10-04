/**
 * 路由 + 守卫。
 *
 * 守卫只做两件事：
 * 1. 未登录 → `/login`（带 `redirect`，登录后回原地）；
 * 2. 已登录但缺 `meta.permission` → `/403`。
 *
 * 菜单渲染同样只看权限点，不看角色名。
 */
import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';

import { PERMISSIONS } from '@/utils/permissions';
import { useAuthStore } from '@/stores/auth';

declare module 'vue-router' {
  interface RouteMeta {
    title?: string;
    /** 进入该路由需要的权限点；缺省 = 登录即可。 */
    permission?: string;
    /** 显示在侧边栏（父级菜单项不显示，由子项决定）。 */
    nav?: boolean;
    /** 侧边栏图标（Element Plus 图标组件名）。 */
    icon?: string;
  }
}

export const LOGIN_ROUTE = '/login';

export const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/Login.vue'),
    meta: { title: '登录' },
  },
  {
    path: '/',
    component: () => import('@/layouts/AdminLayout.vue'),
    children: [
      {
        path: '',
        name: 'dashboard',
        component: () => import('@/views/Dashboard.vue'),
        meta: { title: '总览', permission: PERMISSIONS.nodeView, nav: true, icon: 'Odometer' },
      },
      {
        path: 'nodes',
        name: 'nodes',
        component: () => import('@/views/Nodes.vue'),
        meta: { title: '节点管理', permission: PERMISSIONS.nodeView, nav: true, icon: 'Monitor' },
      },
      {
        path: 'nodes/:id',
        name: 'node-detail',
        component: () => import('@/views/NodeDetail.vue'),
        props: true,
        meta: { title: '节点详情', permission: PERMISSIONS.nodeView },
      },
      {
        path: 'players',
        name: 'players',
        component: () => import('@/views/Players.vue'),
        meta: { title: '玩家', permission: PERMISSIONS.playerView, nav: true, icon: 'User' },
      },
      {
        path: 'players/:uuid',
        name: 'player-detail',
        component: () => import('@/views/PlayerDetail.vue'),
        props: true,
        meta: { title: '玩家详情', permission: PERMISSIONS.playerView },
      },
      {
        path: 'punishments',
        name: 'punishments',
        component: () => import('@/views/Punishments.vue'),
        meta: {
          title: '封禁 / 禁言',
          permission: PERMISSIONS.punishView,
          nav: true,
          icon: 'CircleClose',
        },
      },
      {
        path: 'luckperms',
        name: 'luckperms',
        component: () => import('@/views/LuckPerms.vue'),
        meta: {
          title: '权限组',
          permission: PERMISSIONS.luckpermsView,
          nav: true,
          icon: 'Key',
        },
      },
      {
        path: 'economy',
        name: 'economy',
        component: () => import('@/views/Economy.vue'),
        meta: {
          title: '经济',
          permission: PERMISSIONS.economyView,
          nav: true,
          icon: 'Coin',
        },
      },
      {
        path: 'audit',
        name: 'audit',
        component: () => import('@/views/Audit.vue'),
        meta: { title: '审计日志', permission: PERMISSIONS.auditView, nav: true, icon: 'Document' },
      },
      {
        path: 'accounts',
        name: 'accounts',
        component: () => import('@/views/Accounts.vue'),
        meta: {
          title: '后台账号',
          permission: PERMISSIONS.accountManage,
          nav: true,
          icon: 'Avatar',
        },
      },
      {
        path: '403',
        name: 'forbidden',
        component: () => import('@/views/Forbidden.vue'),
        meta: { title: '权限不足' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFound.vue'),
    meta: { title: '页面不存在' },
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  // 刷新页面后 store 是空的：先确认会话再决定去留，
  // 否则已登录用户会被瞬间踢到登录页。
  if (!auth.initialized) {
    await auth.fetchMe();
  }

  if (to.name === 'login') {
    return auth.isAuthenticated ? { name: 'dashboard' } : true;
  }

  if (!auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }

  const permission = to.meta.permission;
  if (permission && !auth.hasPerm(permission)) {
    return { name: 'forbidden', query: { from: to.fullPath, need: permission } };
  }

  return true;
});

router.afterEach((to) => {
  const base = 'KokuuPanel';
  document.title = to.meta.title ? `${to.meta.title} · ${base}` : base;
});

export default router;
