<script setup>
/**
 * 游戏资产下发页。
 *
 * ★ 这一页是「低耦合」最直观的体现：没有皮肤站也照样能用。
 *   金币 / 点券的真身在游戏服，中间件改了数据库也没用 ——
 *   所以这里不是「改数值」，而是「下发一条指令」，
 *   插件 BRPOP 取走后在主线程执行。
 *
 *   因此按钮的成功文案必须说清「已入队」而不是「已生效」，
 *   否则管理员会以为钱没到账。这是这类异步下发最容易出的错。
 */
import { ref, reactive, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import http, { meta, newEventId } from '../api.js';

const form = reactive({ asset: 'coin', player: '', delta: 0, note: '' });
const sending = ref(false);
const recent = ref([]);

// 只列出「需要经插件执行」的资产；credit 走账本直写，不在这里
const pluginAssets = computed(() => (meta.assets || []).filter((a) => a.writable === 'plugin'));
const current = computed(() => pluginAssets.value.find((a) => a.key === form.asset));

const q = computed(() => form.player.trim());
const canSend = computed(() =>
  /^[A-Za-z0-9_-]{1,16}$/.test(q.value) && Number.isInteger(Number(form.delta)) && Number(form.delta) !== 0);

const nameHint = computed(() => {
  if (!q.value) return '';
  return /^[A-Za-z0-9_-]{1,16}$/.test(q.value)
    ? ''
    : '玩家名只能含字母/数字/下划线/短横线，1-16 位（与 Minecraft 规则一致）';
});

async function send() {
  if (!canSend.value) return;
  sending.value = true;
  try {
    const d = await http.post('/assets/adjust', {
      asset: form.asset,
      player: q.value,
      delta: Number(form.delta),
      note: form.note,
      eventId: newEventId('admin'),
    });
    if (d.applied) {
      ElMessage.success(`已直接入账，当前余额 ${d.after}`);
    } else {
      // 措辞必须是「已入队」—— 此刻钱还没到玩家手上
      ElMessage.success({ message: d.message || '指令已入队', duration: 5000 });
    }
    form.delta = 0;
    form.note = '';
    loadRecent();
  } catch (e) {
    /* 拦截器已弹错误 */
  } finally {
    sending.value = false;
  }
}

async function loadRecent() {
  try {
    const d = await http.get('/game/exchanges', { params: { limit: 20 } });
    recent.value = d.rows || [];
  } catch { /* 首次无数据 */ }
}

onMounted(loadRecent);
</script>

<template>
  <div class="page">
    <el-alert type="info" :closable="false" class="mb">
      <template #title>这里的操作是「下发指令」，不是「改数据库」</template>
      金币与点券由游戏服插件持有，中间件碰不到它们。
      指令写进 Redis 队列后由插件取走执行，<b>几秒内生效</b>；
      若游戏服离线，指令会一直排队直到它上线。
    </el-alert>

    <el-card shadow="never" class="card">
      <template #header><span>调整玩家资产</span></template>

      <el-form label-width="90px" label-position="left">
        <el-form-item label="资产">
          <el-radio-group v-model="form.asset">
            <el-radio-button v-for="a in pluginAssets" :key="a.key" :value="a.key">
              {{ a.label }}
            </el-radio-button>
          </el-radio-group>
          <div v-if="current" class="hint">{{ current.desc }}</div>
        </el-form-item>

        <el-form-item label="玩家名">
          <el-input v-model="form.player" placeholder="游戏内 ID" style="max-width: 240px" />
          <div v-if="nameHint" class="hint err">{{ nameHint }}</div>
        </el-form-item>

        <el-form-item label="变动">
          <el-input-number v-model="form.delta" :step="100" step-strictly
            controls-position="right" style="width: 180px" />
          <span class="hint inline">正数增加，负数扣减</span>
        </el-form-item>

        <el-form-item label="备注">
          <el-input v-model="form.note" placeholder="选填，会记进日志" style="max-width: 320px" />
        </el-form-item>

        <el-form-item>
          <el-button type="primary" :disabled="!canSend" :loading="sending" @click="send">
            下发指令
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" class="card">
      <template #header><span>最近兑换</span></template>
      <el-table :data="recent" size="small" empty-text="还没有兑换记录">
        <el-table-column prop="player_name" label="玩家" min-width="120" />
        <el-table-column label="金币" width="110" align="right">
          <template #default="{ row }"><span class="minus">-{{ row.coin_delta }}</span></template>
        </el-table-column>
        <el-table-column label="积分" width="100" align="right">
          <template #default="{ row }"><span class="plus">+{{ row.credit_delta }}</span></template>
        </el-table-column>
        <el-table-column label="余额" width="100" align="right" prop="credit_after" />
        <el-table-column prop="reason" label="来源" width="100" />
        <el-table-column prop="created_at" label="时间" min-width="150" />
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; max-width: 1000px; }
.card { border-radius: 12px; }
.mb { line-height: 1.7; }
.mb b { color: var(--kk-text); }
.hint { font-size: 12px; color: var(--kk-dim); line-height: 1.6; margin-top: 4px; }
.hint.inline { display: inline-block; margin-left: 10px; }
.hint.err { color: var(--el-color-danger); }
.minus { color: #4fd1c5; font-variant-numeric: tabular-nums; font-family: ui-monospace, Consolas, monospace; }
.plus { color: #f0b429; font-variant-numeric: tabular-nums; font-family: ui-monospace, Consolas, monospace; }
</style>
