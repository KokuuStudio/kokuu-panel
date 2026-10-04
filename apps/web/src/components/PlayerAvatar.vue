<script setup lang="ts">
/**
 * 玩家头像占位：名字首字母 + 按名字散列的色相。
 * 刻意不去拉外部头像服务（CORS、可用性、以及把玩家名单泄露给第三方）。
 */
import { computed } from 'vue';

import { avatarHue, initialsOf } from '@/utils/format';

const props = withDefaults(
  defineProps<{
    name: string | null | undefined;
    size?: number;
    /** 在线状态点。 */
    online?: boolean | null;
  }>(),
  { size: 28 },
);

const hue = computed(() => avatarHue(props.name ?? '?'));
const initials = computed(() => initialsOf(props.name));
const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  fontSize: `${Math.max(11, Math.round(props.size * 0.42))}px`,
  background: `hsl(${hue.value} 62% 46%)`,
}));
</script>

<template>
  <span class="avatar-wrap" :style="{ width: `${size}px`, height: `${size}px` }">
    <span class="avatar" :style="style">{{ initials }}</span>
    <span
      v-if="online !== null && online !== undefined"
      class="avatar__badge"
      :class="online ? 'avatar__badge--online' : 'avatar__badge--offline'"
    />
  </span>
</template>

<style scoped>
.avatar-wrap {
  position: relative;
  display: inline-block;
  flex: 0 0 auto;
}

.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: #fff;
  font-weight: 600;
  user-select: none;
}

.avatar__badge {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 2px solid var(--el-bg-color);
}

.avatar__badge--online {
  background: var(--kp-online);
}

.avatar__badge--offline {
  background: var(--kp-disabled);
}
</style>
