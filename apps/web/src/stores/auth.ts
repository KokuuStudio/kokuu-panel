/**
 * 会话与权限。
 *
 * 权限判断**只**看服务端返回的 `account.permissions`，不在这里根据 role 重算
 * —— 后端可以给账号单独加权限点，前端按角色猜必然猜错。
 */
import type { Permission } from '@kokuu/protocol';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { authApi } from '@/api/endpoints';
import type { Account } from '@/api/types';

export const useAuthStore = defineStore('auth', () => {
  const account = ref<Account | null>(null);
  /** 首次拉取会话信息中（路由守卫据此等待，避免刷新后闪回登录页）。 */
  const loading = ref(false);
  /** 是否已尝试过拉取会话。 */
  const initialized = ref(false);
  const loginError = ref('');

  const isAuthenticated = computed(() => account.value !== null);
  const permissions = computed<string[]>(() => account.value?.permissions ?? []);

  /**
   * 权限判断。传数组表示「任一满足」。
   * 用法：`if (auth.hasPerm('luckperms.manage')) { … }`
   */
  function hasPerm(permission: Permission | string): boolean {
    return permissions.value.includes(permission);
  }

  function hasAnyPerm(list: Array<Permission | string>): boolean {
    if (list.length === 0) return true;
    return list.some((item) => hasPerm(item));
  }

  /** 拉取当前会话。401 视为「未登录」，不当作错误抛出。 */
  async function fetchMe(signal?: AbortSignal): Promise<void> {
    loading.value = true;
    try {
      const result = await authApi.me(signal ? { signal } : {});
      account.value = result.account;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      account.value = null;
    } finally {
      loading.value = false;
      initialized.value = true;
    }
  }

  async function login(username: string, password: string): Promise<Account> {
    loginError.value = '';
    loading.value = true;
    try {
      const result = await authApi.login(username, password);
      account.value = result.account;
      initialized.value = true;
      return result.account;
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await authApi.logout();
    } catch {
      // 服务端可能已把会话清掉（或后端没实现 logout），本地状态照样清。
    } finally {
      account.value = null;
    }
  }

  /** 被 client 层的 401 处理器调用。 */
  function clear(): void {
    account.value = null;
  }

  return {
    account,
    loading,
    initialized,
    loginError,
    isAuthenticated,
    permissions,
    hasPerm,
    hasAnyPerm,
    fetchMe,
    login,
    logout,
    clear,
  };
});
