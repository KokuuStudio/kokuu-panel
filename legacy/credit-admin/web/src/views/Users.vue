<script setup>
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http, { meta, suggestPlayers } from '../api.js';

const rows = ref([]);
const total = ref(0);
const loading = ref(false);
const q = reactive({ kw: '', page: 1, size: 20 });

/* 玩家名前缀候选：输入开头几个字母即出候选，不必敲全名。
   后端做前缀匹配；失败静默退化为自由输入。 */
const kwOpts = ref([]);
const kwLoading = ref(false);
let kwTimer = null;

async function onKwInput(v) {
  clearTimeout(kwTimer);
  const k = String(v || '').trim();
  if (!k) { kwOpts.value = []; return; }
  // 250ms 防抖：skin 模式下每次输入都是一次真实 SQL 查询
  kwTimer = setTimeout(async () => {
    kwLoading.value = true;
    try { kwOpts.value = await suggestPlayers(k, 20); }
    finally { kwLoading.value = false; }
  }, 250);
}

async function load() {
  loading.value = true;
  try {
    const r = await http.get('/users', { params: { ...q } });
    rows.value = r.rows;
    total.value = r.total;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
function search() { q.page = 1; load(); }
function turn(p) { q.page = p; load(); }

/* ---------------- 调整积分 ---------------- */
const dlg = ref(false);
const busy = ref(false);
const form = reactive({ uid: 0, nickname: '', cur: 0, delta: 100, note: '' });

function openAdjust(row) {
  Object.assign(form, {
    uid: row.uid, nickname: row.nickname,
    cur: Number(row.score), delta: 100, note: '',
  });
  dlg.value = true;
}

const QUICK = [10, 50, 100, 500, 1000, -100, -500];

async function submit() {
  const delta = Number(form.delta);
  if (!Number.isInteger(delta) || delta === 0) {
    return ElMessage.warning('变动值必须是非 0 整数');
  }
  if (form.cur + delta < 0) {
    return ElMessage.error(`余额不足：当前 ${form.cur}`);
  }
  busy.value = true;
  try {
    // eventId 由「时间戳 + 随机段」构成：同一次点击重试不会重复加分，
    // 不同操作则一定是新事件。
    const eventId = `admin:${form.uid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const r = await http.post(`/users/${form.uid}/score`, {
      delta, note: form.note, eventId,
    });
    if (r.idempotent) {
      ElMessage.info('该操作已处理过，未重复入账');
    } else {
      ElMessage.success(`${r.before} → ${r.after}`);
    }
    dlg.value = false;
    load();
  } catch {
    /* 已提示 */
  } finally {
    busy.value = false;
  }
}

async function quick(row, d) {
  try {
    await ElMessageBox.confirm(
      `确认给 ${row.nickname} ${d > 0 ? '+' : ''}${d} 积分？`,
      '快速调整',
      { type: d > 0 ? 'info' : 'warning', confirmButtonText: '确认', cancelButtonText: '取消' },
    );
  } catch { return; }
  try {
    const eventId = `admin:${row.uid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const r = await http.post(`/users/${row.uid}/score`, {
      delta: d, note: '快速调整', eventId,
    });
    ElMessage.success(`${r.before} → ${r.after}`);
    load();
  } catch { /* 已提示 */ }
}

/* ---------------- 抽屉：明细 + 流水 ---------------- */
const drawer = ref(false);
const detail = ref(null);
const dLoading = ref(false);

async function openDetail(row) {
  drawer.value = true;
  dLoading.value = true;
  try {
    detail.value = await http.get(`/users/${row.uid}`);
  } finally {
    dLoading.value = false;
  }
}
</script>

<template>
  <div>
    <div class="bar">
      <el-select
        v-model="q.kw"
        filterable
        allow-create
        default-first-option
        clearable
        remote
        :remote-method="onKwInput"
        :loading="kwLoading"
        :placeholder="meta.hasSkin ? '昵称 / 邮箱 / UID 前缀' : '玩家名 / UID / UUID 前缀'"
        style="width: 280px"
        @change="search"
        @clear="search"
      >
        <el-option
          v-for="o in kwOpts" :key="String(o.uid)"
          :label="o.nickname"
          :value="o.nickname"
        >
          <span class="cand">{{ o.nickname }}</span>
          <span class="cand-uid">#{{ o.uid }}</span>
        </el-option>
      </el-select>
      <el-button type="primary" @click="search">查询</el-button>
      <el-button @click="load"><el-icon><Refresh /></el-icon></el-button>
      <span class="cnt">共 {{ total }} 名用户</span>
    </div>

    <div class="panel">
      <el-table :data="rows" v-loading="loading" stripe size="default">
        <el-table-column prop="uid" label="UID" width="80" />
        <el-table-column prop="nickname" label="昵称" min-width="130" />
        <!-- 邮箱只存在于皮肤站账户，独立模式没有这个概念。
             硬渲染会得到一整列空白还占 190px 宽。 -->
        <el-table-column v-if="meta.hasSkin" prop="email" label="邮箱" min-width="190" />
        <!-- UUID 只在插件上报过之后才有值。未绑定的玩家这一列全空，
             所以放在昵称后面做补充信息而不是主标识。 -->
        <el-table-column label="UUID" width="120">
          <template #default="{ row }">
            <el-tooltip v-if="row.uuid" :content="row.uuid" placement="top">
              <span class="uuid dim">{{ row.uuid.slice(0, 8) }}…</span>
            </el-tooltip>
            <span v-else class="dim">—</span>
          </template>
        </el-table-column>
        <el-table-column label="权限" width="90" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.permission & 1" type="danger" size="small" effect="dark">管理员</el-tag>
            <el-tag v-else type="info" size="small">普通</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="积分" width="120" align="right">
          <template #default="{ row }">
            <span class="num big">{{ Number(row.score).toLocaleString() }}</span>
          </template>
        </el-table-column>
        <el-table-column label="快捷调整" width="230">
          <template #default="{ row }">
            <el-button-group>
              <el-button size="small" @click="quick(row, 10)">+10</el-button>
              <el-button size="small" @click="quick(row, 100)">+100</el-button>
              <el-button size="small" @click="quick(row, 1000)">+1000</el-button>
              <el-button size="small" type="danger" plain @click="quick(row, -100)">-100</el-button>
            </el-button-group>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="openAdjust(row)">调整</el-button>
            <el-button size="small" @click="openDetail(row)">明细</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        class="pg"
        layout="total, prev, pager, next"
        :total="total"
        :page-size="q.size"
        :current-page="q.page"
        @current-change="turn"
      />
    </div>

    <!-- 调整弹窗 -->
    <el-dialog v-model="dlg" title="调整积分" width="420px">
      <div class="d-user">
        <div class="d-nick">{{ form.nickname }} <span class="dim">#{{ form.uid }}</span></div>
        <div class="d-cur">当前 <b class="num">{{ form.cur.toLocaleString() }}</b> 分</div>
      </div>

      <el-form label-width="72px" label-position="left">
        <el-form-item label="变动值">
          <el-input-number v-model="form.delta" :step="10" style="width: 100%" />
        </el-form-item>
        <el-form-item label="快捷">
          <div class="chips">
            <el-button
              v-for="d in QUICK" :key="d"
              size="small"
              :type="d > 0 ? 'primary' : 'danger'"
              plain
              @click="form.delta = d"
            >{{ d > 0 ? '+' : '' }}{{ d }}</el-button>
          </div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" maxlength="180" placeholder="例：活动补发 / 人工补偿" />
        </el-form-item>
      </el-form>

      <div class="preview">
        调整后余额
        <b class="num" :class="form.cur + form.delta < 0 ? 'down' : ''">
          {{ (form.cur + Number(form.delta || 0)).toLocaleString() }}
        </b>
      </div>

      <template #footer>
        <el-button @click="dlg = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submit">确认入账</el-button>
      </template>
    </el-dialog>

    <!-- 明细抽屉 -->
    <el-drawer v-model="drawer" size="620px" :title="`用户明细 #${detail?.user?.uid ?? ''}`">
      <div v-loading="dLoading">
        <div v-if="detail" class="d-sum">
          <div>
            <div class="dim">昵称</div>
            <div>{{ detail.user.nickname }}</div>
          </div>
          <div>
            <div class="dim">邮箱</div>
            <div>{{ detail.user.email || '—' }}</div>
          </div>
          <div>
            <div class="dim">UUID</div>
            <div class="num uuid-full">{{ detail.user.uuid || '未绑定' }}</div>
          </div>
          <div>
            <div class="dim">当前积分</div>
            <div class="num big">{{ Number(detail.user.score).toLocaleString() }}</div>
          </div>
          <div>
            <div class="dim">注册于</div>
            <div class="num">{{ detail.user.register_at }}</div>
          </div>
        </div>

        <div class="lg-h">最近 100 条流水</div>
        <el-table v-if="detail" :data="detail.logs" size="small" stripe>
          <el-table-column label="时间" width="150">
            <template #default="{ row }"><span class="num dim">{{ row.created_at }}</span></template>
          </el-table-column>
          <el-table-column label="变动" width="100" align="right">
            <template #default="{ row }">
              <span class="num" :class="row.delta >= 0 ? 'up' : 'down'">
                {{ row.delta >= 0 ? '+' : '' }}{{ row.delta }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="余额" width="100" align="right">
            <template #default="{ row }"><span class="num">{{ row.balance_after }}</span></template>
          </el-table-column>
          <el-table-column prop="source" label="来源" width="100" />
          <el-table-column prop="note" label="备注" min-width="160" show-overflow-tooltip />
        </el-table>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
.cnt { margin-left: auto; font-size: 12px; color: var(--kk-dim); }
.cand { float: left; }
.cand-uid { float: right; color: var(--kk-dim); font-size: 12px; margin-left: 16px; }
.uuid { font-size: 12px; }
.uuid-full { font-size: 11px; word-break: break-all; }

.panel {
  background: var(--kk-panel); border: 1px solid var(--kk-line);
  border-radius: 12px; padding: 12px 14px;
}
.pg { margin-top: 12px; justify-content: flex-end; }
.big { font-size: 15px; font-weight: 700; }

.d-user {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 10px 12px; margin-bottom: 16px;
  background: #1d222a; border-radius: 8px;
}
.d-nick { font-weight: 600; }
.d-cur { font-size: 13px; color: var(--kk-dim); }
.d-cur b { color: var(--kk-text); font-size: 15px; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; }

.preview {
  padding: 10px 12px; border-radius: 8px; background: #1d222a;
  font-size: 13px; color: var(--kk-dim); text-align: right;
}
.preview b { color: var(--kk-text); font-size: 17px; margin-left: 6px; }

.d-sum {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px; padding: 12px; margin-bottom: 16px;
  background: #1d222a; border-radius: 8px; font-size: 13px;
}
.lg-h { font-size: 12px; color: var(--kk-dim); margin-bottom: 8px; }
</style>
