<script setup lang="ts">
/**
 * 封禁类型标签。四种类型（ban / mute / warn / kick）语义与严重度不同，
 * 用颜色区分能在长列表里一眼扫出「封禁」。
 */
import { computed } from 'vue';

import type { PunishmentType } from '@/api/types';

/** 中文名映射。放在 `<script setup>` 外的独立模块里（见 utils/punishment.ts）。 */
import { punishmentLabel } from '@/utils/punishment';

const props = defineProps<{
  type: PunishmentType | string | null | undefined;
  /** 已撤销 / 已过期时置灰。 */
  inactive?: boolean;
  size?: 'small' | 'default' | 'large';
}>();

const TYPE_MAP: Record<string, 'danger' | 'warning' | 'info' | 'primary'> = {
  ban: 'danger',
  mute: 'warning',
  warn: 'info',
  kick: 'primary',
};

const label = computed(() => punishmentLabel(props.type));
const type = computed(() => TYPE_MAP[props.type ?? ''] ?? 'info');
</script>

<template>
  <el-tag
    :type="inactive ? 'info' : type"
    :size="size ?? 'small'"
    :effect="inactive ? 'plain' : 'light'"
    disable-transitions
  >
    {{ label }}
  </el-tag>
</template>
