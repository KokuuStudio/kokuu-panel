<script setup lang="ts">
/**
 * 指标卡片。`value` 允许是字符串（比如 TPS 的「—」），
 * 这样调用方能在「取不到」时传占位符而不是 0。
 */
import type { Component } from 'vue';

withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    suffix?: string;
    hint?: string;
    icon?: Component;
    tone?: 'default' | 'success' | 'warning' | 'danger';
  }>(),
  { tone: 'default' },
);
</script>

<template>
  <div class="stat" :class="`stat--${tone}`">
    <div class="stat__head">
      <span class="stat__label">{{ label }}</span>
      <el-icon v-if="icon" class="stat__icon"><component :is="icon" /></el-icon>
    </div>
    <div class="stat__value">
      <span class="stat__number">{{ value }}</span>
      <span v-if="suffix" class="stat__suffix">{{ suffix }}</span>
    </div>
    <div v-if="hint" class="stat__hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.stat {
  padding: 14px 16px;
  border: 1px solid var(--kp-border);
  border-radius: var(--kp-radius);
  background: var(--el-bg-color);
  min-width: 0;
}

.stat__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.stat__label {
  font-size: 12.5px;
  color: var(--kp-text-muted);
}

.stat__icon {
  color: var(--el-color-primary);
}

.stat__value {
  margin-top: 6px;
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.stat__number {
  font-size: 24px;
  font-weight: 600;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.stat__suffix {
  font-size: 12.5px;
  color: var(--kp-text-muted);
}

.stat__hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--kp-text-muted);
}

.stat--success .stat__number {
  color: var(--kp-online);
}

.stat--warning .stat__number {
  color: var(--kp-warn);
}

.stat--danger .stat__number {
  color: var(--kp-offline);
}
</style>
