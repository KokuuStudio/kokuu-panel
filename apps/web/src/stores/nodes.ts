/**
 * 节点列表缓存。侧边栏、Dashboard、下拉筛选都从这拿，
 * 避免每个页面各自请求一遍 `/nodes`。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { nodesApi } from '@/api/endpoints';
import { describeApiError, toApiError } from '@/api/client';
import type { NodeSummary } from '@/api/types';

export const useNodesStore = defineStore('nodes', () => {
  const nodes = ref<NodeSummary[]>([]);
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref('');

  /** 只列在线节点，给「必须选一个在线节点」的表单用。 */
  const onlineNodes = computed(() => nodes.value.filter((node) => node.status === 'online'));

  /** 能提供 LuckPerms 的节点。 */
  const luckpermsNodes = computed(() =>
    nodes.value.filter((node) => node.capabilities.includes('luckperms')),
  );

  const economyNodes = computed(() =>
    nodes.value.filter((node) => node.capabilities.includes('economy')),
  );

  async function refresh(): Promise<NodeSummary[]> {
    loading.value = true;
    error.value = '';
    try {
      const list = await nodesApi.list();
      nodes.value = Array.isArray(list) ? list : [];
      loaded.value = true;
      return nodes.value;
    } catch (cause) {
      const apiError = toApiError(cause);
      error.value = describeApiError(apiError);
      throw apiError;
    } finally {
      loading.value = false;
    }
  }
  /** 静默刷新：失败只记错误，不抛（用于后台定时刷新）。 */
  async function refreshQuietly(): Promise<void> {
    try {
      await refresh();
    } catch {
      // 保留 error 文案，由 UI 显示。
    }
  }

  function findNode(nodeId: string | null | undefined): NodeSummary | undefined {
    if (!nodeId) return undefined;
    return nodes.value.find((node) => node.id === nodeId);
  }

  function nodeName(nodeId: string | null | undefined): string {
    if (!nodeId) return '全平台';
    return findNode(nodeId)?.name ?? nodeId;
  }

  /** WS 事件 `node.connected` / `node.disconnected` 到来时就地改状态。 */
  function markStatus(nodeId: string, status: NodeSummary['status']): void {
    const node = findNode(nodeId);
    if (!node) return;
    node.status = status;
    node.lastSeenAt = Date.now();
  }

  function patchMetrics(nodeId: string, metrics: NodeSummary['metrics']): void {
    const node = findNode(nodeId);
    if (!node) return;
    node.metrics = metrics;
    if (metrics) {
      node.onlinePlayers = metrics.online;
      node.maxPlayers = metrics.maxPlayers;
    }
  }

  return {
    nodes,
    loading,
    loaded,
    error,
    onlineNodes,
    luckpermsNodes,
    economyNodes,
    refresh,
    refreshQuietly,
    findNode,
    nodeName,
    markStatus,
    patchMetrics,
  };
});
