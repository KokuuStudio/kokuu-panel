<script setup lang="ts">
/**
 * TPS 显示。
 *
 * 协议：`Metrics.tps` 取不到时是 `null`（1.12.2 没有 getTPS()）。
 * **必须显示「—」，绝不能显示 0 或 20.0** —— 编一个 20.0 会让运维
 * 看着「一切正常」，比不显示更糟。
 */
import { computed } from 'vue';

import { formatTps, tpsTone } from '@/utils/format';

const props = withDefaults(
  defineProps<{
    /** `Metrics.tps`：[1m, 5m, 15m] 或 null。 */
    tps: readonly [number, number, number] | number[] | null | undefined;
    /** 只显示第一个值（卡片场景）。 */
    compact?: boolean;
    showLabel?: boolean;
  }>(),
  { compact: false, showLabel: true },
);

const first = computed<number | null>(() => {
  const value = props.tps;
  if (!value || !Array.isArray(value) || value.length === 0) return null;
  const head = value[0];
  return typeof head === 'number' && Number.isFinite(head) ? head : null;
});

const text = computed(() => formatTps(first.value));
const tone = computed(() => tpsTone(first.value));
const tooltip = computed(() => {
  const value = props.tps;
  if (!value || !Array.isArray(value)) return 'TPS 取不到（服务端未提供，不要按 0 或 20.0 解读）';
  return `1m ${formatTps(value[0])} / 5m ${formatTps(value[1])} / 15m ${formatTps(value[2])}`;
});
</script>

<template>
  <el-tooltip :content="tooltip" placement="top">
    <span class="tps" :class="`tps--${tone}`">
      <span v-if="showLabel" class="tps__label">TPS</span>
      <span class="tps__value kp-mono">{{ text }}</span>
      <template v-if="!compact && tps && tps.length > 1">
        <span class="tps__rest kp-mono">/ {{ formatTps(tps[1]) }} / {{ formatTps(tps[2]) }}</span>
      </template>
    </span>
  </el-tooltip>
</template>

<style scoped>
.tps {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.tps__label {
  color: var(--kp-text-muted);
  font-size: 12px;
}

.tps__value {
  font-weight: 600;
}

.tps__rest {
  color: var(--kp-text-muted);
  font-size: 12px;
}

.tps--normal .tps__value {
  color: var(--kp-tps-ok);
}

.tps--warn .tps__value {
  color: var(--kp-tps-warn);
}

.tps--bad .tps__value {
  color: var(--kp-tps-bad);
}

.tps--empty .tps__value {
  color: var(--kp-text-muted);
}
</style>
