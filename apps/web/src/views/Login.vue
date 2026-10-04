<script setup lang="ts">
/**
 * 登录页。
 *
 * 安全相关：失败提示**不区分**「用户不存在」与「密码错误」——
 * 服务端本来就统一回 401 UNAUTHENTICATED，前端不能自作聪明地
 * 通过响应差异泄漏账号是否存在。
 */
import { Lock, User } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { describeApiError, toApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { themeMode, setThemeMode } from '@/utils/theme';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const form = reactive({ username: '', password: '' });
const submitting = ref(false);
const errorText = ref('');
const failedCount = ref(0);
const usernameRef = ref<{ focus: () => void } | null>(null);

onMounted(() => {
  usernameRef.value?.focus();
});

function redirectTarget(): string {
  const raw = route.query.redirect;
  const target = Array.isArray(raw) ? raw[0] : raw;
  if (typeof target === 'string' && target.startsWith('/') && !target.startsWith('//')) {
    return target;
  }
  return '/';
}

async function submit(): Promise<void> {
  if (!form.username.trim() || !form.password) {
    errorText.value = '请输入用户名与密码';
    return;
  }
  submitting.value = true;
  errorText.value = '';
  try {
    await auth.login(form.username.trim(), form.password);
    ElMessage.success('登录成功');
    form.password = '';
    await router.replace(redirectTarget());
  } catch (cause) {
    const apiError = toApiError(cause);
    failedCount.value += 1;
    if (apiError.status === 429) {
      errorText.value = '失败次数过多，该 IP 已被临时锁定，请 15 分钟后再试';
    } else if (apiError.status === 401) {
      // 刻意模糊：不区分用户不存在与密码错误。
      errorText.value = '用户名或密码错误';
    } else {
      errorText.value = describeApiError(apiError);
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login">
    <div class="login__aside">
      <div class="login__brand">
        <span class="login__logo">K</span>
        <div>
          <h1>KokuuPanel</h1>
          <p>Minecraft 服务器管理平台</p>
        </div>
      </div>
      <ul class="login__points">
        <li>多节点统一控制台，Agent 主动外连，无需开放入站端口</li>
        <li>平台侧唯一的封禁权威，跨服一致</li>
        <li>LuckPerms / 经济 / 审计，权限点驱动界面</li>
      </ul>
    </div>

    <div class="login__panel">
      <el-card class="login__card" shadow="never">
        <h2 class="login__title">登录控制台</h2>
        <p class="login__hint kp-text-muted">使用后台账号登录</p>

        <el-alert
          v-if="errorText"
          type="error"
          :closable="false"
          show-icon
          class="login__error"
          data-testid="login-error"
        >
          <template #title>{{ errorText }}</template>
          <template v-if="failedCount >= 5" #default>
            <span class="kp-text-muted">同一 IP 15 分钟内连续失败 10 次会被临时锁定。</span>
          </template>
        </el-alert>

        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="用户名">
            <el-input
              ref="usernameRef"
              v-model="form.username"
              :prefix-icon="User"
              autocomplete="username"
              placeholder="用户名"
              size="large"
              @keyup.enter="submit"
            />
          </el-form-item>
          <el-form-item label="密码">
            <el-input
              v-model="form.password"
              :prefix-icon="Lock"
              type="password"
              show-password
              autocomplete="current-password"
              placeholder="密码"
              size="large"
              @keyup.enter="submit"
            />
          </el-form-item>
          <el-button
            type="primary"
            size="large"
            class="login__submit"
            :loading="submitting"
            data-testid="login-submit"
            @click="submit"
          >
            登录
          </el-button>
        </el-form>

        <div class="login__footer">
          <el-radio-group
            :model-value="themeMode"
            size="small"
            @update:model-value="(v) => setThemeMode(v as typeof themeMode)"
          >
            <el-radio-button value="system">跟随系统</el-radio-button>
            <el-radio-button value="light">浅色</el-radio-button>
            <el-radio-button value="dark">深色</el-radio-button>
          </el-radio-group>
        </div>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.login {
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  min-height: 100vh;
}

.login__aside {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 28px;
  padding: 48px 56px;
  background:
    radial-gradient(1100px 520px at -10% -20%, rgba(64, 158, 255, 0.28), transparent 60%),
    linear-gradient(140deg, #0f172a 0%, #16324f 55%, #0b2b3a 100%);
  color: #e8eef6;
}

.login__brand {
  display: flex;
  align-items: center;
  gap: 16px;
}

.login__logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.18);
  font-size: 26px;
  font-weight: 700;
}

.login__brand h1 {
  margin: 0;
  font-size: 26px;
  letter-spacing: 0.4px;
}

.login__brand p {
  margin: 4px 0 0;
  opacity: 0.75;
  font-size: 13px;
}

.login__points {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13.5px;
  opacity: 0.85;
  max-width: 460px;
}

.login__panel {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: var(--el-bg-color-page);
}

.login__card {
  width: 100%;
  max-width: 380px;
  border-radius: 14px;
}

.login__title {
  margin: 0 0 4px;
  font-size: 20px;
}

.login__hint {
  margin: 0 0 18px;
  font-size: 13px;
}

.login__error {
  margin-bottom: 16px;
}

.login__submit {
  width: 100%;
  margin-top: 4px;
}

.login__footer {
  margin-top: 22px;
  display: flex;
  justify-content: center;
}

@media (max-width: 900px) {
  .login {
    grid-template-columns: 1fr;
  }

  .login__aside {
    display: none;
  }
}
</style>
