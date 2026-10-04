<script setup lang="ts">
/**
 * 403：已登录但缺权限点。把「需要哪个权限」直接写出来，
 * 让运维能一眼判断该找谁要权限，而不是猜。
 */
import { useRoute, useRouter } from 'vue-router';

import { permissionLabel } from '@/utils/permissions';

const route = useRoute();
const router = useRouter();
</script>

<template>
  <div class="hint-page">
    <el-result icon="warning" title="权限不足" sub-title="当前账号缺少访问该页面所需的权限点">
      <template #extra>
        <div class="hint-page__body">
          <p v-if="route.query.need">
            需要权限点：
            <el-tag size="small" effect="plain" disable-transitions>
              {{ route.query.need }}
            </el-tag>
            <span class="kp-text-muted">（{{ permissionLabel(String(route.query.need)) }}）</span>
          </p>
          <p v-if="route.query.from" class="kp-text-muted">
            目标地址：<span class="kp-mono">{{ route.query.from }}</span>
          </p>
          <p class="kp-text-muted">请联系拥有者或管理员为你的账号添加该权限点。</p>
          <div class="hint-page__actions">
            <el-button type="primary" @click="router.push({ name: 'dashboard' })">返回总览</el-button>
            <el-button @click="router.back()">返回上一页</el-button>
          </div>
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
  min-height: 60vh;
}

.hint-page__body {
  text-align: center;
  max-width: 460px;
}

.hint-page__actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  justify-content: center;
}
</style>
