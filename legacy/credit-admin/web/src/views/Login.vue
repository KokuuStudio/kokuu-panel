<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import http, { setToken } from '../api.js';

const router = useRouter();
const token = ref('');
const busy = ref(false);

async function submit() {
  if (!token.value.trim()) return ElMessage.warning('请输入口令');
  busy.value = true;
  setToken(token.value.trim());
  try {
    await http.get('/stats');
    router.push('/overview');
  } catch {
    /* 拦截器已提示 */
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="wrap">
    <div class="card">
      <div class="logo">KOKUU</div>
      <div class="ttl">积分管理台</div>
      <div class="hint">口令存于 ops/token.txt</div>
      <el-input
        v-model="token"
        type="password"
        show-password
        placeholder="管理口令"
        size="large"
        @keyup.enter="submit"
      />
      <el-button
        type="primary"
        size="large"
        class="go"
        :loading="busy"
        @click="submit"
      >
        进入
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  min-height: 100vh; display: grid; place-items: center; padding: 20px;
}
.card {
  width: 100%; max-width: 340px; padding: 30px 26px;
  background: var(--kk-panel); border: 1px solid var(--kk-line);
  border-radius: 14px;
  display: flex; flex-direction: column; gap: 14px;
}
.logo {
  font-weight: 800; letter-spacing: .2em; text-align: center;
  color: var(--kk-accent); font-size: 20px;
}
.ttl { text-align: center; font-size: 15px; }
.hint { text-align: center; font-size: 12px; color: var(--kk-dim); margin-top: -6px; }
.go { width: 100%; }
</style>
