<script setup lang="ts">
/**
 * 页面标题 + 操作区。所有 view 统一用它，保证标题/操作按钮位置一致。
 */
import { ArrowLeft } from '@element-plus/icons-vue';

defineProps<{
  title: string;
  subtitle?: string;
  /** 是否显示返回按钮（详情页用）。 */
  back?: boolean;
}>();

const emit = defineEmits<{ back: [] }>();
</script>

<template>
  <div class="page-header">
    <div class="page-header__main">
      <el-button v-if="back" text :icon="ArrowLeft" class="page-header__back" @click="emit('back')">
        返回
      </el-button>
      <div>
        <h2 class="page-header__title">{{ title }}</h2>
        <p v-if="subtitle" class="page-header__subtitle kp-text-muted">{{ subtitle }}</p>
      </div>
    </div>
    <div class="page-header__actions kp-card-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.page-header__main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.page-header__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
}

.page-header__subtitle {
  margin: 4px 0 0;
  font-size: 13px;
}

.page-header__actions {
  align-items: center;
}
</style>
