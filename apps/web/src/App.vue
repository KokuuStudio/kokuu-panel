<script setup lang="ts">
/**
 * 应用外壳。真正的布局在 layouts/AdminLayout.vue（登录页不套布局）。
 */
</script>

<template>
  <router-view v-slot="{ Component }">
    <component :is="Component" />
  </router-view>
</template>
