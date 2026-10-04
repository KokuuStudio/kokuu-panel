import { createPinia } from 'pinia';
import { createApp } from 'vue';

import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
// Element Plus 暗色主题：靠 <html class="dark"> 生效，class 由 utils/theme.ts 维护。
import 'element-plus/theme-chalk/dark/css-vars.css';

import App from './App.vue';
import router from './router';
import { setUnauthorizedHandler } from './api/client';
import { useAuthStore } from './stores/auth';
import { useEventsStore } from './stores/events';
import { initTheme } from './utils/theme';

import './styles/variables.css';
import './styles/global.css';

initTheme();

const app = createApp(App);

app.use(createPinia());
app.use(ElementPlus, { locale: zhCn });
app.use(router);

// 401 的统一出口：清本地会话 + 跳登录。
// 放在这里而不是 client.ts 内部，是为了让 client 不依赖 router / store（避免循环引用）。
setUnauthorizedHandler(() => {
  const auth = useAuthStore();
  const redirect = router.currentRoute.value.fullPath;
  if (redirect.startsWith('/login')) return;
  auth.clear();
  void router.replace({ name: 'login', query: { redirect } });
});

// 页面关闭时主动断开 WS：否则浏览器会在卸载过程中再触发一次 onclose → 重连。
window.addEventListener('beforeunload', () => {
  useEventsStore().disconnect();
});

app.mount('#app');
