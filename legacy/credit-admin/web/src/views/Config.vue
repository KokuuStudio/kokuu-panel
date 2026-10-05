<script setup>
/**
 * 兑换配置页。
 *
 * 比例与限额是**安全边界**，配错直接导致刷分或误伤，所以：
 *   - 数值控件统一用 el-input-number，禁掉小数与负数（后端也会再拦一道）
 *   - 保存前先本地校验，把「为什么不行」直接写在字段旁
 *   - 每次保存带一个 eventId，后端白名单 + 幂等
 */
import { ref, reactive, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import http, { meta } from '../api.js';

const cfg = reactive({});
const labels = ref({});
const saving = ref(false);
const loaded = ref(false);

// ★ 初始值必须与后端 DEFAULTS 对齐，不能留空。
//   el-switch 的 modelValue 为 undefined 时会直接抛
//   "must be active-value or inactive-value"，而配置是异步拉取的
//   —— 首帧必然是空。所以先给一份与后端一致的初值，
//   请求回来再覆盖，切换过程也不会有中间态闪烁。
const INITIAL = {
  enabled: '1', ratio: '1000', daily_limit: '200',
  single_limit: '50', min_coin: '1000', auto_source: 'game',
  reflow_enabled: '0', reflow_daily_limit: '0',
};
Object.assign(cfg, INITIAL);

const FIELDS = [
  { key: 'enabled', type: 'switch', hint: '关掉后游戏内所有兑换请求直接拒绝' },
  { key: 'ratio', type: 'int', min: 1, hint: '例：1000 表示 1000 金币 = 1 积分' },
  { key: 'daily_limit', type: 'int', min: 0, hint: '单个用户每天通过兑换能拿到的积分上限，0 = 不限' },
  { key: 'single_limit', type: 'int', min: 0, hint: '单笔最多换多少积分，0 = 不限' },
  { key: 'min_coin', type: 'int', min: 1, hint: '单笔最少消耗多少金币，挡掉刷单的小额请求' },
  { key: 'auto_source', type: 'text', hint: '写进流水的来源标记，便于日后按来源筛查' },
];

const REFLOW_FIELDS = [
  { key: 'reflow_enabled', type: 'switch', hint: '开启后，玩家在游戏里赚到的金币会被插件按比例自动抽走并换成积分。默认关闭 —— 这功能会动玩家的钱' },
  { key: 'reflow_daily_limit', type: 'int', min: 0, hint: '单个用户每天通过自动回流能拿到的积分上限，0 = 不限。与上面的每日上限分开算' },
];

/** 回流运行状态（后端 /reflow/status）。拉不到时保持 null，页面照常显示表单。 */
const reflow = ref(null);
const reflowErr = ref('');
async function loadReflow() {
  try {
    reflow.value = await http.get('/reflow/status');
    reflowErr.value = '';
  } catch (e) {
    reflowErr.value = e.message;
  }
}

/**
 * ★ 数值字段的读写都要过数字层。
 *   el-input-number 的 modelValue 声明是 Number，给 String 会触发
 *   "Expected Number | Null, got String" 的 prop 校验警告 ——
 *   而配置在库里、在 JSON 里、在表单里天然都是字符串。
 *   所以：显示时 Number 化，保存时 String 化，中间不混用。
 */
const numOf = (k) => (cfg[k] === '' || cfg[k] === null || cfg[k] === undefined ? null : Number(cfg[k]));
function setNum(k, v) { cfg[k] = v === null || v === undefined || Number.isNaN(v) ? '' : String(v); }

const error = ref('');

/** 本地预校验。规则与后端 settings.js 的 validateConfig 一致，但先在前端给提示。 */
const localError = computed(() => {
  const r = Number(cfg.ratio);
  if (!Number.isInteger(r) || r <= 0) return '兑换比例必须是正整数';
  for (const k of ['daily_limit', 'single_limit']) {
    const n = Number(cfg[k]);
    if (!Number.isInteger(n) || n < 0) return '限额必须是非负整数';
  }
  const m = Number(cfg.min_coin);
  if (!Number.isInteger(m) || m <= 0) return '单笔最少金币不能为 0，否则任何金额都能提交';
  return '';
});

/** 换算预览：让管理员改比例时立刻看到实际效果，不用自己算。 */
const preview = computed(() => {
  const r = Number(cfg.ratio) || 0;
  if (r <= 0) return '—';
  const coin = Number(cfg.min_coin) || 0;
  const got = Math.floor(coin / r);
  return `${coin} 金币 → ${got} 积分` + (got < 1 ? '（不足 1 积分，这一笔会被拒）' : '');
});

/**
 * 回流的换算预览。与上面的区别：插件抽的是**零头** ——
 * 玩家赚 5500 金币、比例 1000:1，插件抽走 5000 换 5 积分，剩 500 零头。
 */
const reflowPreview = computed(() => {
  const r = Number(cfg.ratio) || 0;
  if (r <= 0) return '—';
  const got = Math.floor(5000 / r);
  return `赚 5000 金币 → 抽走 ${got * r} 换 ${got} 积分，剩 ${5000 - got * r} 金币零头`;
});

/** 回流开关打开、但比例与插件不一致时给出提示（后端也会检测并告警，这里先给一眼可见的提醒）。 */
const reflowMismatch = computed(() => {
  const r = Number(cfg.ratio) || 0;
  const m = Number(cfg.min_coin) || 0;
  return String(cfg.reflow_enabled) === '1' && r > 0 && m > 0 && m < r;
});

/**
 * min_coin < ratio 不非法，但意味着「按最低门槛提交也换不到分」。
 * 这种情况后端会逐笔拒绝，看起来像功能坏了 —— 所以要在页面上
 * 明确提示成因，而不是让人自己去翻日志猜。
 */
const warnGap = computed(() => {
  const r = Number(cfg.ratio) || 0;
  const m = Number(cfg.min_coin) || 0;
  return r > 0 && m > 0 && m < r;
});

async function load() {
  const d = await http.get('/config');
  Object.assign(cfg, d.config);
  labels.value = d.labels || {};
  // 后端返回里缺的键用初值兜住（老配置行缺新加的字段时会漏）
  for (const k of Object.keys(INITIAL)) {
    if (cfg[k] === undefined) cfg[k] = INITIAL[k];
  }
  loaded.value = true;
}

function reset() {
  error.value = '';
  load();
}

/** 保存后刷新回流状态 —— 开关一改，统计与「已生效」判定就变了。 */
async function save() {
  if (localError.value) { error.value = localError.value; return; }
  saving.value = true;
  error.value = '';
  try {
    const d = await http.put('/config', { ...cfg });
    Object.assign(cfg, d.config);
    ElMessage.success('已保存，立即对新交易生效');
    loadReflow();
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

onMounted(() => { load(); loadReflow(); });
</script>

<template>
  <div v-loading="!loaded" class="page">
    <el-card shadow="never" class="card">
      <template #header>
        <div class="hd">
          <span>兑换规则</span>
          <div>
            <el-button size="small" @click="reset">还原</el-button>
            <el-button size="small" type="primary" :loading="saving" @click="save">保存</el-button>
          </div>
        </div>
      </template>

      <el-alert
        v-if="error"
        type="error"
        :title="error"
        show-icon
        :closable="false"
        class="mb"
      />

      <el-alert
        v-if="warnGap"
        type="warning"
        show-icon
        :closable="false"
        class="mb"
        title="当前设置下所有兑换都会被拒"
      >
        单笔最少金币（{{ cfg.min_coin }}）小于兑换比例（{{ cfg.ratio }}），
        意味着按最低门槛提交也换不到 1 积分。把「单笔最少金币」调到
        {{ cfg.ratio }} 或更高即可。
      </el-alert>

      <el-form label-width="180px" label-position="left">
        <el-form-item v-for="f in FIELDS" :key="f.key" :label="labels[f.key] || f.key">
          <el-switch v-if="f.type === 'switch'" v-model="cfg[f.key]"
            active-value="1" inactive-value="0" />
          <el-input-number v-else-if="f.type === 'int'"
            :model-value="numOf(f.key)"
            @update:model-value="(v) => setNum(f.key, v)"
            :min="f.min" :step="1" step-strictly controls-position="right" />
          <el-input v-else v-model="cfg[f.key]" style="max-width: 220px" />
          <div class="hint">{{ f.hint }}</div>
        </el-form-item>
      </el-form>

      <el-divider />

      <div class="pv">
        <span class="pv-label">按当前设置</span>
        <span class="pv-val">{{ preview }}</span>
      </div>
    </el-card>

    <!-- ── 金币自动回流 ─────────────────────────────────── -->
    <el-card shadow="never" class="card">
      <template #header>
        <div class="hd">
          <span>金币自动回流</span>
          <div>
            <el-button size="small" @click="reset">还原</el-button>
            <el-button size="small" type="primary" :loading="saving" @click="save">保存</el-button>
          </div>
        </div>
      </template>

      <el-alert type="warning" show-icon :closable="false" class="mb"
        title="这功能会自动扣玩家的金币，务必先读一遍说明再打开" />

      <el-alert v-if="reflowMismatch" type="error" show-icon :closable="false" class="mb"
        title="回流开着，但当前比例与单笔门槛矛盾">
        单笔最少金币（{{ cfg.min_coin }}）小于兑换比例（{{ cfg.ratio }}），
        回流会按比例抽零头，玩家在游戏里赚到的钱会几乎被抽干。
        把「单笔最少金币」调到 {{ cfg.ratio }} 或更高再开回流。
      </el-alert>

      <el-alert v-if="reflowErr" type="error" show-icon :closable="false" class="mb"
        :title="`读取回流运行状态失败：${reflowErr}（不影响配置保存）`" />

      <el-form label-width="180px" label-position="left">
        <el-form-item v-for="f in REFLOW_FIELDS" :key="f.key" :label="labels[f.key] || f.key">
          <el-switch v-if="f.type === 'switch'" v-model="cfg[f.key]"
            active-value="1" inactive-value="0" />
          <el-input-number v-else-if="f.type === 'int'"
            :model-value="numOf(f.key)"
            @update:model-value="(v) => setNum(f.key, v)"
            :min="f.min" :step="1" step-strictly controls-position="right" />
          <div class="hint">{{ f.hint }}</div>
        </el-form-item>
      </el-form>

      <div class="pv">
        <span class="pv-label">按当前设置</span>
        <span class="pv-val">{{ reflowPreview }}</span>
      </div>

      <!-- 运行状态 -->
      <template v-if="reflow">
        <el-divider />
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="消费循环">
            <span :class="reflow.running ? 'ok' : 'bad'">
              {{ reflow.running ? '运行中' : '未运行' }}
            </span>
          </el-descriptions-item>
          <el-descriptions-item label="已入账">
            {{ reflow.credited }} 笔
            <span v-if="reflow.drift" class="bad">（比例漂移 {{ reflow.drift }} 笔）</span>
          </el-descriptions-item>
          <el-descriptions-item label="已消费 / 拒绝">
            {{ reflow.consumed }} / {{ reflow.rejected }}
          </el-descriptions-item>
          <el-descriptions-item label="重复 / 失败">
            {{ reflow.dup }} / {{ reflow.failed }}
          </el-descriptions-item>
          <el-descriptions-item label="队列积压">
            {{ reflow.queue?.event ?? '—' }} 条
            <span v-if="(reflow.queue?.event ?? 0) > 20" class="bad">
              积压过多，玩家已扣币但积分未入账
            </span>
          </el-descriptions-item>
          <el-descriptions-item label="最近错误">
            <span :class="reflow.lastError ? 'bad' : 'dim'">
              {{ reflow.lastError || '无' }}
            </span>
          </el-descriptions-item>
        </el-descriptions>

        <el-alert type="info" show-icon :closable="false" class="mt">
          <template #title>还需两步才生效</template>
          <ol class="steps">
            <li>把本页的<strong>兑换比例</strong>与插件 <code>config.yml</code> 的
              <code>reflow.ratio</code> 填成同一个数</li>
            <li>把插件的 <code>reflow.enabled</code> 设为 <code>true</code> 后重启游戏服<br>
              <span class="dim">（比例不一致时本服务会在日志里告警，但不会改你上报的数字）</span></li>
          </ol>
        </el-alert>
      </template>
    </el-card>

    <el-card shadow="never" class="card">
      <template #header><span>存储位置</span></template>
      <el-descriptions :column="1" size="small" border>
        <el-descriptions-item label="后端模式">{{ meta.label || meta.backend }}</el-descriptions-item>
        <el-descriptions-item label="数据目录">
          <code class="mono">{{ meta.dataDir || '—' }}</code>
        </el-descriptions-item>
        <el-descriptions-item label="说明">
          <span class="dim">
            比例与限额改动<b>立即对新交易生效</b>，但不会追溯已完成的兑换。
            修改期间正在排队的请求会按它们被处理那一刻的旧值执行。
          </span>
        </el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; max-width: 1000px; }
.card { border-radius: 12px; }
.hd { display: flex; align-items: center; justify-content: space-between; font-weight: 600; }
.mb { margin-bottom: 16px; }
.hint { font-size: 12px; color: var(--kk-dim); line-height: 1.6; margin-top: 2px; }
.pv { display: flex; align-items: baseline; gap: 12px; }
.pv-label { font-size: 13px; color: var(--kk-dim); }
.pv-val { font-size: 15px; font-weight: 600; color: var(--kk-accent); }
.dim { color: var(--kk-dim); font-size: 13px; line-height: 1.7; }
.dim b { color: var(--kk-text); }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--kk-accent); word-break: break-all; }
.mt { margin-top: 16px; }
.ok { color: var(--el-color-success); }
.bad { color: var(--el-color-danger); }
.steps { margin: 4px 0 0; padding-left: 20px; font-size: 13px; line-height: 1.8; color: var(--kk-text); }
.steps code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--kk-accent); }
</style>
