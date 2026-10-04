<script setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import http, { getToken } from '../api.js';

const router = useRouter();
const loading = ref(true);
const s = ref({ users: 0, total_score: 0, max_score: 0, today: {}, top: [] });

onMounted(async () => {
  if (!getToken()) return router.replace('/login');
  try {
    s.value = await http.get('/stats');
  } finally {
    loading.value = false;
  }
});

const cards = [
  { k: 'users', label: '用户数', suffix: '人' },
  { k: 'total_score', label: '积分总存量', suffix: '分' },
  { k: 'max_score', label: '最高持有', suffix: '分' },
];
</script>

<template>
  <div v-loading="loading">
    <div class="grid">
      <div v-for="c in cards" :key="c.k" class="card">
        <div class="lb">{{ c.label }}</div>
        <div class="vl num">{{ Number(s[c.k] || 0).toLocaleString() }}</div>
        <div class="sf">{{ c.suffix }}</div>
      </div>
      <div class="card">
        <div class="lb">今日加分</div>
        <div class="vl num up">+{{ Number(s.today?.plus || 0).toLocaleString() }}</div>
        <div class="sf">{{ s.today?.ops || 0 }} 笔操作</div>
      </div>
      <div class="card">
        <div class="lb">今日扣分</div>
        <div class="vl num down">-{{ Number(s.today?.minus || 0).toLocaleString() }}</div>
        <div class="sf">含兑换与人工</div>
      </div>
    </div>

    <div class="panel">
      <div class="ph">积分 TOP 10</div>
      <el-table :data="s.top" size="small" stripe>
        <el-table-column prop="uid" label="UID" width="80" />
        <el-table-column prop="nickname" label="昵称" min-width="140" />
        <el-table-column prop="email" label="邮箱" min-width="200" />
        <el-table-column label="积分" width="130" align="right">
          <template #default="{ row }">
            <span class="num">{{ Number(row.score).toLocaleString() }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.grid {
  display: grid; gap: 12px; margin-bottom: 18px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}
.card {
  position: relative; padding: 16px 18px;
  background: var(--kk-panel); border: 1px solid var(--kk-line);
  border-radius: 12px;
}
.lb { font-size: 12px; color: var(--kk-dim); }
.vl { font-size: 28px; font-weight: 700; line-height: 1.25; }
.sf { font-size: 11px; color: var(--kk-dim); }

.panel {
  background: var(--kk-panel); border: 1px solid var(--kk-line);
  border-radius: 12px; padding: 14px 16px 6px;
}
.ph { font-size: 13px; color: var(--kk-dim); margin-bottom: 10px; }
</style>
