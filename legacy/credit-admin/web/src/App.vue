<script setup>
/**
 * 顶栏与导航。
 *
 * 页签不写死 —— 资产下发依赖 Redis 队列，没配 Redis 时不该给一个
 * 点了就报错的入口。meta 拉到之后再决定显示什么。
 */
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { meta, loadMeta, getToken } from './api.js';

const TABS = [
  { name: '/overview', label: '概览', icon: 'DataLine' },
  { name: '/users', label: '账户', icon: 'User' },
  { name: '/ledger', label: '全站流水', icon: 'Tickets' },
  { name: '/assets', label: '游戏资产', icon: 'Coin', needQueue: true },
  { name: '/config', label: '兑换配置', icon: 'Setting' },
];

const router = useRouter();
const active = ref(router.currentRoute.value.path);
router.afterEach((to) => (active.value = to.path));

const tabs = computed(() => TABS.filter((t) => !t.needQueue || meta.loaded));

onMounted(() => {
  if (getToken()) loadMeta();
});
</script>

<template>
  <div class="shell">
    <header class="top">
      <div class="brand">
        <span class="mark">KOKUU</span>
        <span class="sub">资产管理台</span>
      </div>
      <nav class="tabs">
        <button
          v-for="t in tabs"
          :key="t.name"
          class="tab"
          :class="{ on: active === t.name }"
          @click="router.push(t.name)"
        >
          <el-icon><component :is="t.icon" /></el-icon>{{ t.label }}
        </button>
      </nav>
      <!-- 后端模式常驻显示：管理员必须一眼看出自己在改哪套账 -->
      <el-tag v-if="meta.loaded" :type="meta.hasSkin ? 'warning' : 'success'"
        size="small" effect="plain" class="mode">
        {{ meta.hasSkin ? '皮肤站账本' : '本地账本' }}
      </el-tag>
    </header>
    <main class="body">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.shell { height: 100%; display: flex; flex-direction: column; }

.top {
  display: flex; align-items: center; gap: 28px;
  padding: 0 22px; height: 56px; flex: none;
  background: var(--kk-panel);
  border-bottom: 1px solid var(--kk-line);
}

.brand { display: flex; align-items: baseline; gap: 10px; }
.mark { font-weight: 800; letter-spacing: .14em; color: var(--kk-accent); }
.sub { font-size: 13px; color: var(--kk-dim); }

.tabs { display: flex; gap: 4px; flex: 1; }
.mode { flex: none; }

.tab {
  display: inline-flex; align-items: center; gap: 6px;
  height: 34px; padding: 0 14px;
  background: transparent; color: var(--kk-dim);
  border: 1px solid transparent; border-radius: 8px;
  font-size: 14px; cursor: pointer; transition: .15s;
}
.tab:hover { color: var(--kk-text); background: #1f252e; }
.tab.on {
  color: var(--kk-accent);
  background: rgba(79, 209, 197, .1);
  border-color: rgba(79, 209, 197, .32);
}

.body { flex: 1; min-height: 0; overflow: auto; padding: 20px 22px 40px; }

@media (max-width: 640px) {
  .top { height: auto; flex-wrap: wrap; align-items: flex-start; gap: 10px; padding: 12px 14px; }
  .tabs { order: 3; width: 100%; overflow-x: auto; }
  .body { padding: 14px; }
}
</style>
