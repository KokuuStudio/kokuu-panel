import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import * as Icons from '@element-plus/icons-vue';
import App from './App.vue';
import './style.css';
import { getToken } from './api.js';
import Login from './views/Login.vue';
import Overview from './views/Overview.vue';
import Users from './views/Users.vue';
import Ledger from './views/Ledger.vue';
import Config from './views/Config.vue';
import Assets from './views/Assets.vue';

const routes = [
  { path: '/', redirect: '/overview' },
  { path: '/login', component: Login, meta: { open: true } },
  { path: '/overview', component: Overview },
  { path: '/users', component: Users },
  { path: '/ledger', component: Ledger },
  { path: '/config', component: Config },
  { path: '/assets', component: Assets },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.beforeEach((to) => {
  if (to.meta.open) return true;
  if (!getToken()) return '/login';
  return true;
});

const app = createApp(App);
for (const [k, v] of Object.entries(Icons)) app.component(k, v);
app.use(router);
app.use(ElementPlus);
app.mount('#app');
