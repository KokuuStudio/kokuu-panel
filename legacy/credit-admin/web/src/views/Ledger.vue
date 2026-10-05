<script setup>
import { onMounted, reactive, ref, computed, watch } from 'vue';
import http, { meta, suggestPlayers } from '../api.js';

const rows = ref([]);
const total = ref(0);
const loading = ref(false);
const q = reactive({ source: '', kw: '', from: '', to: '', page: 1, size: 30 });

/**
 * 来源列表从后端取，不写死。
 *
 * 之前这里硬编码了 admin/sign/lottery/exchange/forum 五项，
 * 但那只是 skin 站一侧的历史来源 —— 独立模式只有 admin/game/exchange，
 * 写死会让管理员点「签到」却永远得到空列表，像是功能坏了。
 * 后端 ledger.sources() 是权威答案。
 */
const LABELS = {
  admin: '人工调整', game: '游戏兑换', exchange: '积分兑换',
  sign: '签到', lottery: '抽奖', draw: '抽奖', forum: '论坛',
  consume: '消费', reward: '奖励', admin_op: '管理员',
};
const labelOf = (s) => LABELS[s] || s;

const sources = computed(() => [{ v: '', label: '全部' }, ...meta.sources.map((s) => ({
  v: s, label: labelOf(s),
}))]);

/**
 * 来源列表：后端给的候选 + 当前数据里兜底补的。
 *
 * 只靠 meta.sources 不够 —— 皮肤站里还有 kokuu-credit 等插件在写
 * 自己的来源（draw / sign / lottery…），它们不在中间件的枚举里。
 * 但也不能只靠当前页数据（翻页后筛选项会跳变）。
 * 所以两边合并：已知项固定在前，实际出现的追加在后。
 */
const extra = computed(() => {
  const known = new Set([...meta.sources, '']);
  const seen = [];
  for (const r of rows.value) {
    if (r.source && !known.has(r.source) && !seen.includes(r.source)) seen.push(r.source);
  }
  return seen.map((s) => ({ v: s, label: labelOf(s) }));
});
const allSources = computed(() => [...sources.value, ...extra.value]);

/* ── 时间范围 ────────────────────────────────────────────
 * 存 'YYYY-MM-DD HH:mm:ss' 字符串而不是 Date 对象：
 * 传 Date 会踩时区坑（前后端各按本地时区解释一遍，差 8 小时），
 * 而且后端两种账本（JSONL 存 ISO / MySQL 存 DATETIME）
 * 比较的都是字符串，字符串能一套走通。 */
const range = ref([]);
watch(range, (v) => {
  q.from = v?.[0] || '';
  q.to = v?.[1] || '';
  q.page = 1;
  load();
});

const TIME_SHORTCUTS = [
  { text: '今天', value: () => span(0) },
  { text: '近 7 天', value: () => span(6) },
  { text: '近 30 天', value: () => span(29) },
];

/** 最近 n 天（含今天）的 [起, 止]，止取到当前时刻。 */
function span(days) {
  const p = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const start = new Date(now.getTime() - days * 86400000);
  const d = (x) => `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  const t = (x) => `${p(x.getHours())}:${p(x.getMinutes())}:${p(x.getSeconds())}`;
  return [new Date(`${d(start)} 00:00:00`), new Date(`${d(now)} ${t(now)}`)];
}

/* ── 玩家名前缀候选 ──────────────────────────────────────
 * 后端前缀匹配，输入开头几个字母就出候选，不用敲全名。 */
const kwOpts = ref([]);
const kwLoading = ref(false);
let kwTimer = null;

const doSuggest = async (kw) => {
  if (!kw || !kw.trim()) { kwOpts.value = []; return; }
  kwLoading.value = true;
  try {
    const list = await suggestPlayers(kw, 20);
    // 选中的项也补进候选，否则清空再点开就找不到当前选中项了
    const cur = kwOpts.value.find((o) => o.nickname === kw);
    kwOpts.value = cur && !list.some((o) => o.nickname === cur.nickname)
      ? [cur, ...list] : list;
  } finally {
    kwLoading.value = false;
  }
};

// 250ms 防抖：每敲一个字母打一次接口，在 skin 模式下是真实的 SQL 查询
function onKwInput(v) {
  clearTimeout(kwTimer);
  kwTimer = setTimeout(() => doSuggest(v), 250);
}

async function load() {
  loading.value = true;
  try {
    // 空值一律不发：后端把空串当「不过滤」，但发过去也没意义，
    // 还会让 URL 变得难以复制排查
    const params = { page: q.page, size: q.size };
    if (q.source) params.source = q.source;
    if (q.kw) params.kw = q.kw;
    if (q.from) params.from = q.from;
    if (q.to) params.to = q.to;
    const r = await http.get('/ledger', { params });
    rows.value = r.rows;
    total.value = r.total;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
function turn(p) { q.page = p; load(); }
function pick(v) { q.source = v; q.page = 1; load(); }

function search() { q.page = 1; load(); }
function clearAll() {
  q.source = ''; q.kw = ''; q.from = ''; q.to = '';
  range.value = [];
  q.page = 1;
  load();
}
const filtering = computed(() => !!(q.source || q.kw || q.from || q.to));

/**
 * UUID 显示成紧凑形式。
 * 完整 36 字符会把表格挤变形；前 8 位已经足够定位一个人。
 */
function shortUuid(u) {
  return u && u.length > 12 ? `${u.slice(0, 8)}…` : (u || '');
}
</script>

<template>
  <div>
    <div class="filters">
      <el-select
        v-model="q.kw"
        filterable
        allow-create
        default-first-option
        clearable
        remote
        :remote-method="onKwInput"
        :loading="kwLoading"
        placeholder="玩家名 / UID / UUID 前缀"
        style="width: 240px"
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

      <el-date-picker
        v-model="range"
        type="datetimerange"
        unlink-panels
        range-separator="→"
        start-placeholder="开始时间"
        end-placeholder="结束时间"
        :shortcuts="TIME_SHORTCUTS"
        value-format="YYYY-MM-DD HH:mm:ss"
        style="width: 360px"
      />

      <el-button @click="clearAll" :disabled="!filtering">重置</el-button>
      <el-button @click="load"><el-icon><Refresh /></el-icon></el-button>
      <span class="cnt">共 {{ total }} 条</span>
    </div>

    <div class="bar">
      <el-button-group>
        <el-button
          v-for="s in allSources" :key="s.v"
          size="small"
          :type="q.source === s.v ? 'primary' : undefined"
          @click="pick(s.v)"
        >{{ s.label }}</el-button>
      </el-button-group>
    </div>

    <div class="panel">
      <el-table :data="rows" v-loading="loading" stripe size="small">
        <el-table-column label="时间" width="170">
          <template #default="{ row }"><span class="num dim">{{ row.created_at }}</span></template>
        </el-table-column>
        <el-table-column label="用户" width="180">
          <template #default="{ row }">
            <span v-if="row.nickname">{{ row.nickname }}</span>
            <span v-else class="dim">#{{ row.uid }} 已注销</span>
            <div class="dim uid">
              #{{ row.uid }}
              <span v-if="row.uuid" class="uuid">{{ shortUuid(row.uuid) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="变动" width="110" align="right">
          <template #default="{ row }">
            <span class="num fw" :class="row.delta >= 0 ? 'up' : 'down'">
              {{ row.delta >= 0 ? '+' : '' }}{{ row.delta }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="余额" width="110" align="right">
          <template #default="{ row }"><span class="num">{{ row.balance_after }}</span></template>
        </el-table-column>
        <el-table-column label="来源" width="120">
          <template #default="{ row }">
            <el-tooltip :content="row.source" placement="top">
              <el-tag size="small" effect="plain">{{ labelOf(row.source) }}</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="200" show-overflow-tooltip />
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
  </div>
</template>

<style scoped>
.filters { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.bar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.cnt { margin-left: auto; font-size: 12px; color: var(--kk-dim); }
.panel {
  background: var(--kk-panel); border: 1px solid var(--kk-line);
  border-radius: 12px; padding: 12px 14px;
}
.pg { margin-top: 12px; justify-content: flex-end; }
.fw { font-weight: 700; }
.uid { font-size: 11px; }
.uuid { opacity: 0.65; margin-left: 4px; }
.cand { float: left; }
.cand-uid { float: right; color: var(--kk-dim); font-size: 12px; margin-left: 16px; }

/* 表头左右留白。Element Plus 默认 cell padding 在多列表格下会把
   「变动 / 余额 / 来源」三个短标题挤成一片，视觉上像一列。 */
.panel :deep(.el-table__header th) { padding: 0; }
.panel :deep(.el-table__header .cell) { padding: 0 10px; }
</style>
