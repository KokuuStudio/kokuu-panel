import axios from 'axios';
import { ElMessage } from 'element-plus';
import { reactive } from 'vue';

const TOKEN_KEY = 'kk_admin_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}

/**
 * 后端元信息。由 App.vue 登录后拉一次，全局共享。
 *
 * 前端据此做两件事：
 *   1. 顶栏显示当前后端（skin / standalone），避免管理员搞不清在改哪套账
 *   2. 按能力显示/隐藏入口 —— 皮肤站账户不能手工建，配置项标签后端才知道
 *
 * 字段缺失一律按最保守的方式处理（当作 standalone 且无该能力），
 * 避免后端加字段前前端就崩。
 */
export const meta = reactive({
  loaded: false,
  backend: 'standalone',
  hasSkin: false,
  hasDatabase: false,
  label: '',
  sources: ['admin', 'game', 'exchange'],
  configLabels: {},
  configDefaults: {},
  assets: [],
});

export async function loadMeta() {
  try {
    const d = await http.get('/meta');
    Object.assign(meta, d, { loaded: true });
    return meta;
  } catch {
    meta.loaded = true;
    return meta;
  }
}

const http = axios.create({ baseURL: '/api', timeout: 15000 });

http.interceptors.request.use((cfg) => {
  const t = getToken();
  if (t) cfg.headers['X-Admin-Token'] = t;
  return cfg;
});

http.interceptors.response.use(
  (r) => r.data,
  (err) => {
    const msg = err.response?.data?.error || err.message || '请求失败';
    if (err.response?.status === 401) {
      ElMessage.error('口令无效，请重新登录');
      localStorage.removeItem(TOKEN_KEY);
      setTimeout(() => location.reload(), 800);
    } else {
      ElMessage.error(msg);
    }
    return Promise.reject(new Error(msg));
  },
);

/**
 * 统一的事件 id 生成。
 * 后端靠它做幂等，所以同一次用户操作必须复用同一个 id ——
 * 「生成一次、传到底」是唯一正确用法，不要在提交时才临时生成。
 */
export function newEventId(prefix = 'admin') {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 玩家名候选（供搜索框下拉）。
 *
 * ★ 后端是前缀匹配：输入 "ali" 出 "Alice" / "aliz"。
 *   管理员只记得名字开头几个字母是常态，要求全名匹配等于没有搜索。
 *   任何失败都静默返回空数组 —— 候选是锦上添花，
 *   查不到不该阻断自由输入与查询本身。
 */
export async function suggestPlayers(kw, limit = 20) {
  const k = String(kw || '').trim();
  if (!k) return [];
  try {
    const r = await http.get('/players/suggest', { params: { kw: k, limit } });
    return Array.isArray(r?.rows) ? r.rows : [];
  } catch {
    return [];
  }
}

export default http;
