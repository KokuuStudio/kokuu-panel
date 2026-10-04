<script setup lang="ts">
/**
 * 经济：账户列表 + 账户详情（余额 + 流水）+ 调整积分 + 下发游戏内货币 + 经济配置编辑。
 *
 * 两个来自 docs/API.md 的硬约束：
 * 1. `delta` / `amount` **不接受 0** —— 前端也拦一道，并说明原因（否则服务端只能回
 *    INVALID_PARAMS，用户看不出是哪里错了）。
 * 2. 经济配置的三个约束由**服务端拒绝写入**（`min_coin >= ratio`、`ratio >= 1`、
 *    各项限额 `>= 0`）。前端做同样的校验只是提前告知，最终以服务端为准 ——
 *    与旧实现「把矛盾配置当警告打在页面上」不同，这里不允许存进去。
 */
import { Coin, Money, Refresh, Search } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { economyApi } from '@/api/endpoints';
import { describeApiError, toApiError } from '@/api/client';
import type {
  EconomyAccount,
  EconomyConfig,
  LedgerEntry,
  PageResult,
} from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import PageHeader from '@/components/PageHeader.vue';
import StatCard from '@/components/StatCard.vue';
import type { DataTableColumn } from '@/components/DataTable.vue';
import { useAuthStore } from '@/stores/auth';
import { useNodesStore } from '@/stores/nodes';
import { PERMISSIONS } from '@/utils/permissions';
import { formatMoney, formatRelative, formatTime } from '@/utils/format';

const route = useRoute();
const auth = useAuthStore();
const nodesStore = useNodesStore();

const canManage = computed(() => auth.hasPerm(PERMISSIONS.economyManage));

// ── 账户列表 ────────────────────────────────────────────────

const keyword = ref(typeof route.query.kw === 'string' ? route.query.kw : '');
const page = ref(1);
const size = ref(20);
const accounts = ref<PageResult<EconomyAccount>>({ items: [], total: 0, page: 1, size: 20 });
const accountsLoading = ref(false);
const accountsError = ref('');

const accountColumns: DataTableColumn[] = [
  { key: 'name', label: '玩家', minWidth: 170, slot: 'name' },
  { key: 'uuid', label: 'UUID', minWidth: 260, slot: 'uuid' },
  { key: 'balance', label: '站点积分', width: 140, slot: 'balance' },
  { key: 'updatedAt', label: '最后变动', width: 170, slot: 'updatedAt' },
  { key: 'actions', label: '操作', width: 110, fixed: 'right', slot: 'actions' },
];

async function loadAccounts(): Promise<void> {
  accountsLoading.value = true;
  accountsError.value = '';
  try {
    const result = await economyApi.accounts({
      kw: keyword.value.trim() || undefined,
      page: page.value,
      size: size.value,
    });
    accounts.value = {
      items: result?.items ?? [],
      total: result?.total ?? 0,
      page: result?.page ?? page.value,
      size: result?.size ?? size.value,
    };
    if (!selectedUuid.value && accounts.value.items.length > 0 && route.query.uuid === undefined) {
      // 不自动选中，避免刚打开就发一堆详情请求；用户点哪条看哪条。
    }
  } catch (cause) {
    accountsError.value = describeApiError(toApiError(cause));
    accounts.value = { items: [], total: 0, page: page.value, size: size.value };
  } finally {
    accountsLoading.value = false;
  }
}

function search(): void {
  page.value = 1;
  void loadAccounts();
}

function resetSearch(): void {
  keyword.value = '';
  page.value = 1;
  void loadAccounts();
}

function onPageChange(value: number): void {
  page.value = value;
  void loadAccounts();
}

function onSizeChange(value: number): void {
  size.value = value;
  page.value = 1;
  void loadAccounts();
}

// ── 账户详情 ────────────────────────────────────────────────

const selectedUuid = ref(typeof route.query.uuid === 'string' ? route.query.uuid : '');
const detail = ref<{ account: EconomyAccount | null; ledger: LedgerEntry[]; total: number }>({
  account: null,
  ledger: [],
  total: 0,
});
const detailLoading = ref(false);
const detailError = ref('');

async function loadDetail(): Promise<void> {
  if (!selectedUuid.value) {
    detail.value = { account: null, ledger: [], total: 0 };
    return;
  }
  detailLoading.value = true;
  detailError.value = '';
  try {
    const result = await economyApi.account(selectedUuid.value);
    detail.value = {
      account: result?.account ?? null,
      ledger: result?.ledger ?? [],
      total: result?.total ?? result?.ledger?.length ?? 0,
    };
  } catch (cause) {
    detail.value = { account: null, ledger: [], total: 0 };
    detailError.value = describeApiError(toApiError(cause));
  } finally {
    detailLoading.value = false;
  }
}

function selectAccount(uuid: string): void {
  selectedUuid.value = uuid;
}

const ledgerColumns: DataTableColumn[] = [
  { key: 'ts', label: '时间', width: 170, slot: 'ts' },
  { key: 'delta', label: '变动', width: 110, slot: 'delta' },
  { key: 'balanceAfter', label: '变动后', width: 120, slot: 'after' },
  { key: 'source', label: '来源', width: 130, slot: 'source' },
  { key: 'currency', label: '货币', width: 100 },
  { key: 'note', label: '备注', minWidth: 180 },
  { key: 'eventId', label: '幂等键', minWidth: 160, slot: 'eventId' },
];

// ── 调整积分 ────────────────────────────────────────────────

const adjustDialogVisible = ref(false);
const adjustForm = reactive({ mode: 'delta' as 'delta' | 'absolute', delta: 0, note: '', eventId: '' });
const adjusting = ref(false);

async function submitAdjust(): Promise<void> {
  if (!selectedUuid.value) return;
  if (adjustForm.mode === 'delta' && adjustForm.delta === 0) {
    ElMessage.warning('调整值不能为 0（服务端会拒绝）');
    return;
  }
  if (adjustForm.mode === 'absolute') {
    const current = detail.value.account?.balance ?? 0;
    const delta = Number(adjustForm.delta) - current;
    if (delta === 0) {
      ElMessage.info('余额未变化，无需调整');
      return;
    }
    adjustForm.delta = delta;
  }

  adjusting.value = true;
  try {
    const result = await economyApi.adjust(selectedUuid.value, {
      delta: adjustForm.delta,
      note: adjustForm.note.trim() || undefined,
      eventId: adjustForm.eventId.trim() || undefined,
    });
    ElMessage.success(`已调整，当前余额 ${formatMoney(result?.balance)}`);
    adjustDialogVisible.value = false;
    adjustForm.delta = 0;
    adjustForm.note = '';
    adjustForm.eventId = '';
    await Promise.all([loadDetail(), loadAccounts(), loadStats()]);
  } catch (cause) {
    ElMessage.error(describeApiError(toApiError(cause)));
  } finally {
    adjusting.value = false;
  }
}

// ── 游戏内货币 ──────────────────────────────────────────────

const currencyDialogVisible = ref(false);
const currencyForm = reactive({ nodeId: '', amount: 0, note: '', eventId: '' });
const currencySubmitting = ref(false);

const economyNodes = computed(() =>
  nodesStore.nodes.filter((node) => node.capabilities.includes('economy')),
);

async function submitCurrency(): Promise<void> {
  if (!selectedUuid.value) return;
  if (!currencyForm.nodeId) {
    ElMessage.warning('请选择节点（游戏内货币经该节点的 Vault 下发）');
    return;
  }
  if (currencyForm.amount === 0) {
    ElMessage.warning('金额不能为 0（服务端会拒绝）');
    return;
  }
  currencySubmitting.value = true;
  try {
    const result = await economyApi.gameCurrency(selectedUuid.value, {
      nodeId: currencyForm.nodeId,
      amount: currencyForm.amount,
      note: currencyForm.note.trim() || undefined,
      eventId: currencyForm.eventId.trim() || undefined,
    });
    ElMessage.success(`已下发，该节点余额 ${formatMoney(result?.balanceAfter)}`);
    currencyDialogVisible.value = false;
    currencyForm.amount = 0;
    currencyForm.note = '';
    currencyForm.eventId = '';
    await loadDetail();
  } catch (cause) {
    ElMessage.error(describeApiError(toApiError(cause)));
  } finally {
    currencySubmitting.value = false;
  }
}

// ── 统计 / 配置 ─────────────────────────────────────────────

const stats = ref<{ totalAccounts: number | null; totalBalance: number | null }>({
  totalAccounts: null,
  totalBalance: null,
});
const statsError = ref('');
const config = ref<EconomyConfig | null>(null);
const configLoading = ref(false);
const configError = ref('');
const configSaving = ref(false);
const configForm = reactive({ ratio: 1, min_coin: 0, currency: '金币', daily_limit: 0, enabled: true });

async function loadStats(): Promise<void> {
  statsError.value = '';
  try {
    // endpoints 层已把后端的 `{ accounts, totalBalance, … }` 映射成这两个字段。
    const result = await economyApi.stats();
    stats.value = {
      totalAccounts: result?.totalAccounts ?? null,
      totalBalance: result?.totalBalance ?? null,
    };
  } catch (cause) {
    statsError.value = describeApiError(toApiError(cause));
  }
}

function applyConfigToForm(value: EconomyConfig): void {
  configForm.ratio = Number(value.ratio ?? 1);
  configForm.min_coin = Number(value.min_coin ?? 0);
  configForm.currency = String(value.currency ?? '金币');
  configForm.daily_limit = Number(value.daily_limit ?? 0);
  configForm.enabled = value.enabled !== false;
}

async function loadConfig(): Promise<void> {
  configLoading.value = true;
  configError.value = '';
  try {
    const result = await economyApi.config();
    config.value = result;
    applyConfigToForm(result ?? { ratio: 1, min_coin: 0, currency: '金币' });
  } catch (cause) {
    config.value = null;
    configError.value = describeApiError(toApiError(cause));
  } finally {
    configLoading.value = false;
  }
}

/** 与后端同一套约束：ratio >= 1、min_coin >= ratio、限额 >= 0。 */
const configIssues = computed<string[]>(() => {
  const issues: string[] = [];
  if (!Number.isFinite(configForm.ratio) || configForm.ratio < 1) {
    issues.push('ratio 必须 >= 1');
  }
  if (!Number.isFinite(configForm.min_coin) || configForm.min_coin < configForm.ratio) {
    issues.push('min_coin 必须 >= ratio');
  }
  if (!Number.isFinite(configForm.daily_limit) || configForm.daily_limit < 0) {
    issues.push('daily_limit 必须 >= 0');
  }
  return issues;
});

async function saveConfig(): Promise<void> {
  if (configIssues.value.length > 0) {
    ElMessage.warning(`配置不合法，服务端会拒绝写入：${configIssues.value.join('；')}`);
    return;
  }
  configSaving.value = true;
  try {
    const result = await economyApi.updateConfig({ ...configForm });
    config.value = result ?? ({ ...configForm } as EconomyConfig);
    applyConfigToForm(config.value);
    ElMessage.success('经济配置已保存');
  } catch (cause) {
    ElMessage.error(describeApiError(toApiError(cause)));
  } finally {
    configSaving.value = false;
  }
}

onMounted(async () => {
  await nodesStore.refreshQuietly();
  await Promise.all([loadAccounts(), loadStats(), loadConfig()]);
  if (selectedUuid.value) await loadDetail();
});

watch(selectedUuid, () => {
  void loadDetail();
});

const openAdjust = (): void => {
  adjustForm.mode = 'delta';
  adjustForm.delta = 0;
  adjustForm.note = '';
  adjustForm.eventId = '';
  adjustDialogVisible.value = true;
};

const openCurrency = (): void => {
  currencyForm.nodeId = economyNodes.value[0]?.id ?? '';
  currencyForm.amount = 0;
  currencyForm.note = '';
  currencyForm.eventId = '';
  currencyDialogVisible.value = true;
};

const refreshAll = (): void => {
  void Promise.all([loadAccounts(), loadStats(), loadConfig(), loadDetail()]);
};
</script>

<template>
  <div class="kp-page">
    <PageHeader title="经济" subtitle="站点积分与游戏内货币（游戏内货币经目标节点的 Vault 下发）">
      <template #actions>
        <el-button :icon="Refresh" :loading="accountsLoading" @click="refreshAll">刷新</el-button>
      </template>
    </PageHeader>

    <div class="stats">
      <StatCard
        label="账户总数"
        :value="stats.totalAccounts === null ? '—' : stats.totalAccounts"
        :icon="Search"
        :hint="statsError || '来自 /economy/stats'"
        :tone="statsError ? 'warning' : 'default'"
      />
      <StatCard
        label="积分总量"
        :value="formatMoney(stats.totalBalance)"
        :icon="Coin"
        :hint="statsError || '所有账户余额之和'"
        :tone="statsError ? 'warning' : 'default'"
      />
      <StatCard
        label="兑换比例"
        :value="config ? String(config.ratio ?? '—') : '—'"
        :icon="Money"
        :hint="config ? `min_coin ${config.min_coin ?? '—'} · ${config.currency ?? ''}` : configError || '配置未加载'"
      />
    </div>

    <div class="economy">
      <el-card shadow="never" class="economy__list">
        <template #header>
          <div class="card-head">
            <span>账户</span>
            <div class="kp-filter-form">
              <el-input
                v-model="keyword"
                :prefix-icon="Search"
                placeholder="按玩家名 / UUID 搜索"
                clearable
                style="width: 200px"
                @keyup.enter="search"
                @clear="search"
              />
              <el-button type="primary" @click="search">查询</el-button>
              <el-button @click="resetSearch">重置</el-button>
            </div>
          </div>
        </template>

        <DataTable
          :columns="accountColumns"
          :rows="accounts.items"
          :loading="accountsLoading"
          :error="accountsError"
          empty-text="没有匹配的账户"
          row-key="uuid"
          :total="accounts.total"
          :page="page"
          :size="size"
          @retry="loadAccounts"
          @update:page="onPageChange"
          @update:size="onSizeChange"
        >
          <template #name="{ row }">
            <el-link
              type="primary"
              :underline="false"
              :class="{ 'is-selected': row.uuid === selectedUuid }"
              @click="selectAccount(row.uuid)"
            >
              {{ row.name }}
            </el-link>
          </template>
          <template #uuid="{ row }">
            <span class="kp-mono uuid">{{ row.uuid }}</span>
          </template>
          <template #balance="{ row }">
            <span class="kp-mono">{{ formatMoney(row.balance) }}</span>
          </template>
          <template #updatedAt="{ row }">
            <span :title="formatTime(row.updatedAt)">{{ formatRelative(row.updatedAt) }}</span>
          </template>
          <template #actions="{ row }">
            <el-button size="small" text type="primary" @click="selectAccount(row.uuid)">详情</el-button>
          </template>
        </DataTable>
      </el-card>

      <el-card shadow="never" class="economy__detail">
        <template #header>
          <div class="card-head">
            <span>
              账户详情
              <span v-if="detail.account" class="kp-text-muted">（{{ detail.account.name }}）</span>
            </span>
            <div v-if="detail.account && canManage" class="kp-card-actions">
              <el-button size="small" type="primary" plain @click="openAdjust">调整积分</el-button>
              <el-button size="small" plain @click="openCurrency">下发游戏内货币</el-button>
            </div>
          </div>
        </template>

        <el-alert
          v-if="detailError"
          type="error"
          :closable="false"
          show-icon
          :title="detailError"
          data-testid="economy-detail-error"
        />
        <el-skeleton v-else-if="detailLoading && !detail.account" :rows="4" animated />
        <el-empty
          v-else-if="!selectedUuid"
          description="从左侧选择一个账户查看余额与流水"
          :image-size="80"
        />
        <el-empty v-else-if="!detail.account" description="账户不存在或无数据" :image-size="70" />
        <template v-else>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="玩家">{{ detail.account.name }}</el-descriptions-item>
            <el-descriptions-item label="余额">
              <span class="kp-mono balance">{{ formatMoney(detail.account.balance) }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="UUID">
              <span class="kp-mono uuid">{{ detail.account.uuid }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="最后变动">
              {{ formatTime(detail.account.updatedAt) }}
            </el-descriptions-item>
          </el-descriptions>

          <el-divider content-position="left">最近流水</el-divider>
          <DataTable
            :columns="ledgerColumns"
            :rows="detail.ledger"
            :loading="detailLoading"
            empty-text="没有流水记录"
            row-key="id"
            :show-pager="false"
          >
            <template #ts="{ row }">
              <span :title="formatTime(row.ts ?? row.createdAt)">
                {{ formatRelative(row.ts ?? row.createdAt) }}
              </span>
            </template>
            <template #delta="{ row }">
              <span
                class="kp-mono"
                :class="(row.delta ?? 0) >= 0 ? 'delta-plus' : 'delta-minus'"
              >
                {{ (row.delta ?? 0) >= 0 ? '+' : '' }}{{ formatMoney(row.delta) }}
              </span>
            </template>
            <template #after="{ row }">
              <span class="kp-mono">{{ formatMoney(row.balanceAfter) }}</span>
            </template>
            <template #source="{ row }">{{ row.source ?? '—' }}</template>
            <template #eventId="{ row }">
              <span v-if="row.eventId" class="kp-mono uuid">{{ row.eventId }}</span>
              <span v-else class="kp-text-muted">—</span>
            </template>
          </DataTable>
        </template>
      </el-card>
    </div>

    <el-card shadow="never">
      <template #header>
        <div class="card-head">
          <span>经济配置</span>
          <span class="kp-text-muted">
            三个约束由服务端强制校验；不合法会被拒绝写入，而不是存下矛盾配置
          </span>
        </div>
      </template>

      <el-alert
        v-if="configError"
        type="error"
        :closable="false"
        show-icon
        :title="configError"
        data-testid="economy-config-error"
      />
      <el-skeleton v-else-if="configLoading && !config" :rows="3" animated />
      <el-form v-else label-width="120px" class="config-form">
        <el-form-item label="兑换比例 (ratio)">
          <el-input-number v-model="configForm.ratio" :min="0" :step="1" :disabled="!canManage" />
          <span class="form-hint kp-text-muted">必须 &gt;= 1</span>
        </el-form-item>
        <el-form-item label="最小兑换 (min_coin)">
          <el-input-number v-model="configForm.min_coin" :min="0" :step="1" :disabled="!canManage" />
          <span class="form-hint kp-text-muted">必须 &gt;= ratio</span>
        </el-form-item>
        <el-form-item label="货币名称">
          <el-input v-model="configForm.currency" style="width: 200px" :disabled="!canManage" />
        </el-form-item>
        <el-form-item label="每日限额">
          <el-input-number v-model="configForm.daily_limit" :min="0" :step="100" :disabled="!canManage" />
          <span class="form-hint kp-text-muted">必须 &gt;= 0</span>
        </el-form-item>
        <el-form-item label="启用经济">
          <el-switch v-model="configForm.enabled" :disabled="!canManage" />
        </el-form-item>

        <el-alert
          v-if="configIssues.length > 0"
          type="warning"
          :closable="false"
          show-icon
          title="当前填写的配置不合法，保存会被服务端拒绝"
        >
          <template #default>
            <ul class="issue-list">
              <li v-for="issue in configIssues" :key="issue">{{ issue }}</li>
            </ul>
          </template>
        </el-alert>

        <el-form-item>
          <el-button
            type="primary"
            :disabled="!canManage || configIssues.length > 0"
            :loading="configSaving"
            @click="saveConfig"
          >
            保存配置
          </el-button>
          <el-button :disabled="!canManage" @click="loadConfig">重新加载</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 调整积分 -->
    <el-dialog v-model="adjustDialogVisible" title="调整站点积分" width="480px">
      <el-form label-width="92px">
        <el-form-item label="玩家">
          <span>{{ detail.account?.name }} <span class="kp-mono kp-text-muted">{{ selectedUuid }}</span></span>
        </el-form-item>
        <el-form-item label="调整方式">
          <el-radio-group v-model="adjustForm.mode">
            <el-radio value="delta">增减</el-radio>
            <el-radio value="absolute">设为指定值</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="adjustForm.mode === 'delta' ? '增减值' : '目标余额'">
          <el-input-number v-model="adjustForm.delta" :step="10" controls-position="right" />
          <span class="form-hint kp-text-muted">
            {{
              adjustForm.mode === 'delta'
                ? '正数增加、负数扣减；不能为 0'
                : `当前余额 ${formatMoney(detail.account?.balance)}`
            }}
          </span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="adjustForm.note" maxlength="100" placeholder="例：活动补发" />
        </el-form-item>
        <el-form-item label="幂等键">
          <el-input v-model="adjustForm.eventId" class="kp-mono" placeholder="留空则服务端生成" />
          <div class="form-hint kp-text-muted">
            网络重试时会带上同一个幂等键，服务端据此拒绝重复入账。
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="adjusting" @click="submitAdjust">提交</el-button>
      </template>
    </el-dialog>

    <!-- 下发游戏内货币 -->
    <el-dialog v-model="currencyDialogVisible" title="下发游戏内货币" width="480px">
      <el-alert
        v-if="economyNodes.length === 0"
        type="warning"
        :closable="false"
        show-icon
        title="没有声明 economy 能力的节点"
        description="游戏内货币经目标节点的 Vault 下发，节点未上报 economy 能力时无法执行。"
      />
      <el-form label-width="92px">
        <el-form-item label="玩家">
          <span>{{ detail.account?.name }}</span>
        </el-form-item>
        <el-form-item label="节点">
          <el-select v-model="currencyForm.nodeId" placeholder="选择节点" filterable style="width: 100%">
            <el-option
              v-for="node in economyNodes"
              :key="node.id"
              :label="`${node.name}（${node.id}）`"
              :value="node.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="金额">
          <el-input-number v-model="currencyForm.amount" :step="100" controls-position="right" />
          <span class="form-hint kp-text-muted">正数发放、负数扣除；不能为 0</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="currencyForm.note" maxlength="100" />
        </el-form-item>
        <el-form-item label="幂等键">
          <el-input v-model="currencyForm.eventId" class="kp-mono" placeholder="留空则服务端生成" />
          <div class="form-hint kp-text-muted">
            Agent 会缓存已处理的幂等键（TTL &ge; 24h），重试不会发两遍钱。
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="currencyDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="currencySubmitting"
          :disabled="economyNodes.length === 0"
          @click="submitCurrency"
        >
          下发
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--kp-gap);
}

.economy {
  display: grid;
  grid-template-columns: minmax(320px, 400px) minmax(0, 1fr);
  gap: var(--kp-gap);
  align-items: start;
}

@media (max-width: 1100px) {
  .economy {
    grid-template-columns: 1fr;
  }
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.uuid {
  font-size: 11.5px;
}

.balance {
  font-size: 16px;
  font-weight: 600;
}

.delta-plus {
  color: var(--kp-online);
}

.delta-minus {
  color: var(--kp-offline);
}

.is-selected {
  font-weight: 600;
}

.config-form {
  max-width: 620px;
}

.form-hint {
  margin-left: 10px;
  font-size: 12px;
  line-height: 1.5;
}

.issue-list {
  margin: 4px 0 0;
  padding-left: 18px;
}
</style>
