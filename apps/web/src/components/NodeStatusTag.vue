<script setup lang="ts">
/**
 * 节点状态标签。三态（在线 / 离线 / 停用）语义不同，颜色也必须不同：
 * 「停用」是管理员的决定，「离线」是故障，混成一个灰色会掩盖故障。
 */
import { computed } from 'vue';

import type { NodeStatus } from '@/api/types';

const props = defineProps<{
  status: NodeStatus | null | undefined;
  enabled?: boolean;
  /** 是否在文字里带上「上次心跳」。 */
  lastSeenAt?: number | null;
  size?: 'small' | 'default' | 'large';
}>();

const LABELS: Record<NodeStatus, string> = {
  online: '在线',
  offline: '离线',
  disabled: '已停用',
};

const TYPE: Record<NodeStatus, 'success' | 'danger' | 'info'> = {
  online: 'success',
  offline: 'danger',
  disabled: 'info',
};

const effective = computed<NodeStatus>(() => {
  if (props.enabled === false) return 'disabled';
  return props.status ?? 'offline';
});

const label = computed(() => LABELS[effective.value]);
const type = computed(() => TYPE[effective.value]);
</script>

<template>
  <el-tooltip
    :disabled="!lastSeenAt"
    :content="lastSeenAt ? `上次心跳：${new Date(lastSeenAt).toLocaleString()}` : ''"
    placement="top"
  >
    <el-tag :type="type" :size="size ?? 'small'" effect="light" disable-transitions>
      <span class="kp-dot" :class="`kp-dot--${effective}`" />
      {{ label }}
    </el-tag>
  </el-tooltip>
</template>
