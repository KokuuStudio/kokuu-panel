<script setup lang="ts">
/** 404：路由未匹配。刻意不做「自动跳首页」，避免掩盖写错的链接。 */
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="hint-page">
    <el-result icon="info" title="404" sub-title="页面不存在">
      <template #extra>
        <div class="hint-page__actions">
          <el-button type="primary" @click="router.push({ name: 'dashboard' })">返回总览</el-button>
        </div>
      </template>
    </el-result>
  </div>
</template>

<style scoped>
.hint-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 70vh;
}

.hint-page__actions {
  display: flex;
  gap: 8px;
  justify-content: center;
}
</style>
