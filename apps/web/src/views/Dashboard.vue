<script setup lang="ts">
/**
 * 总览页：节点卡片总览（在线数 / 人数 / TPS / 内存）+ 在线玩家数 + 最近审计。
 *
 * 数据来源：
 * - `/nodes` 每 15s 轮询，同时订阅 WS topic `nodes` 收到事件就刷新；
 * - `/audit` 仅在有 `audit.view` 权限时请求（无权限就整块隐藏，而不是显示 403）。
 */
import { Coin, Connection, Monitor, User } from '@element-plus/icons-vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { auditApi } from '@/api/endpoints';
import type { AuditEntry } from '@/api/types';
import PageHeader from '@/components/PageHeader.vue';
import StatCard from '@/components/StatCard.vue';
import TpsText from '@/components/TpsText.vue';
import { usePolling } from '@/composables/usePolling';
import { useAsyncData } from '@/composables/useAsyncData';
import { useAuthStore } from '@/stores/auth';
import { useEventsStore } from '@/stores/events';
import { useNodesStore } from '@/stores/nodes';
import { PERMISSIONS } from '@/utils/permissions';
import { formatBytes, formatNumber, formatRelative, memoryPercent, percentText } from '@/utils/format';

const router = useRouter();
const auth = useAuthStore();
const nodesStore = useNodesStore();
const events = useEventsStore();

const canViewAudit = computed(() => auth.hasPerm(PERMISSIONS.auditView));

const audit = useAsyncData<AuditEntry[]>(async () => {
  const page = await auditApi.list({ page: 1, size: 8 });
  return page.items ?? [];
});

const nodes = computed(() => nodesStore.nodes);
const onlineNodes = computed(() => nodes.value.filter((node) => node.status === 'online'));
const offlineNodes = computed(() => nodes.value.filter((node) => node.status === 'offline'));
const disabledNodes = computed(() => nodes.value.filter((node) => node.status === 'disabled'));

const totalOnline = computed(() =>
  onlineNodes.value.reduce((sum, node) => sum + (node.onlinePlayers ?? 0), 0),
);
const totalCapacity = computed(() =>
  onlineNodes.value.reduce((sum, node) => sum + (node.maxPlayers ?? 0), 0),
);
/**
 * 平均 TPS：只统计「真的报上来了 TPS」的节点。
 * 全都没报就显示「—」—— 协议明确 tps 可能为 null，编不出 20.0 来糊弄人。
 */
const tpsSummary = computed<{ text: string; tone: 'default' | 'success' | 'warning' | 'danger'; hint: string }>(() => {
  const values = onlineNodes.value
    .map((node) => node.metrics?.tps?.[0] ?? null)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) {
    return { text: '—', tone: 'default', hint: '没有节点上报 TPS（服务端可能不支持）' };
  }
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const tone = avg >= 19.5 ? 'success' : avg >= 18 ? 'warning' : 'danger';
  return { text: avg.toFixed(2), tone, hint: `来自 ${values.length} / ${onlineNodes.value.length} 个在线节点` };
});

const memorySummary = computed(() => {
  let used = 0;
  let max = 0;
  for (const node of onlineNodes.value) {
    const memory = node.metrics?.memory;
    if (!memory) continue;
    used += memory.used;
    max += memory.max;
  }
  const percent = memoryPercent({ used, max });
  return {
    used,
    max,
    percent,
    hint: max > 0 ? `${formatBytes(used)} / ${formatBytes(max)}` : '没有节点上报内存',
  };
});

const lastRefreshAt = ref(0);

async function refreshNodes(): Promise<void> {
  await nodesStore.refreshQuietly();
  lastRefreshAt.value = Date.now();
}

let offNodeEvents: (() => void) | null = null;

onMounted(async () => {
  await refreshNodes();
  if (canViewAudit.value) void audit.load();

  // 订阅 `nodes` topic：节点上下线、metrics 变化立刻反映到卡片。
  const unsubscribeTopic = events.subscribe('nodes');
  const offConnected = events.on('node.connected', () => {
    void refreshNodes();
  });
  const offDisconnected = events.on('node.disconnected', () => {
    void refreshNodes();
  });
  const offMetrics = events.on('node.metrics', () => {
    void refreshNodes();
  });
  offNodeEvents = () => {
    unsubscribeTopic();
    offConnected();
    offDisconnected();
    offMetrics();
  };
});

onBeforeUnmount(() => {
  offNodeEvents?.();
  offNodeEvents = null;
});

usePolling(refreshNodes, 15_000);

function openNode(nodeId: string): void {
  void router.push({ name: 'node-detail', params: { id: nodeId } });
}
</script>

<template>
  <div class="kp-page">
    <PageHeader title="总览" subtitle="节点状态、在线人数与最近操作">
      <template #actions>
        <span class="kp-text-muted refresh-hint">
          最近刷新：{{ lastRefreshAt ? formatRelative(lastRefreshAt) : '—' }}
        </span>
        <el-button :loading="nodesStore.loading" @click="refreshNodes">刷新</el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="nodesStore.error"
      type="error"
      :closable="false"
      show-icon
      title="节点列表加载失败"
      :description="nodesStore.error"
      data-testid="dashboard-nodes-error"
    />

    <div class="stats">
      <StatCard
        label="在线节点"
        :value="`${onlineNodes.length} / ${nodes.length}`"
        :icon="Monitor"
        :tone="offlineNodes.length > 0 ? 'warning' : 'success'"
        :hint="`离线 ${offlineNodes.length} · 停用 ${disabledNodes.length}`"
      />
      <StatCard
        label="在线玩家"
        :value="formatNumber(totalOnline)"
        :suffix="totalCapacity > 0 ? `/ ${formatNumber(totalCapacity)}` : ''"
        :icon="User"
        :hint="onlineNodes.length === 0 ? '没有在线节点' : `${onlineNodes.length} 个节点在报数`"
      />
      <StatCard
        label="平均 TPS"
        :value="tpsSummary.text"
        :icon="Connection"
        :tone="tpsSummary.tone"
        :hint="tpsSummary.hint"
      />
      <StatCard
        label="内存占用"
        :value="memorySummary.percent === null ? '—' : percentText(memorySummary.percent, 0)"
        :icon="Coin"
        :tone="memorySummary.percent !== null && memorySummary.percent > 90 ? 'danger' : 'default'"
        :hint="memorySummary.hint"
      />
    </div>

    <el-card shadow="never">
      <template #header>
        <div class="card-head">
          <span>节点</span>
          <el-button text type="primary" @click="router.push({ name: 'nodes' })">管理节点</el-button>
        </div>
      </template>

      <el-empty
        v-if="!nodesStore.loading && nodes.length === 0 && !nodesStore.error"
        description="还没有节点，先去「节点管理」创建一个"
      >
        <el-button type="primary" @click="router.push({ name: 'nodes' })">新建节点</el-button>
      </el-empty>

      <div v-else class="node-grid" v-loading="nodesStore.loading && nodes.length === 0">
        <div
          v-for="node in nodes"
          :key="node.id"
          class="node-card"
          :class="`node-card--${node.enabled === false ? 'disabled' : node.status}`"
          @click="openNode(node.id)"
        >
          <div class="node-card__head">
            <div class="node-card__title">
              <span class="kp-dot" :class="`kp-dot--${node.enabled === false ? 'disabled' : node.status}`" />
              <strong>{{ node.name }}</strong>
            </div>
            <el-tag
              size="small"
              effect="plain"
              :type="node.enabled === false ? 'info' : node.status === 'online' ? 'success' : 'danger'"
              disable-transitions
            >
              {{ node.enabled === false ? '已停用' : node.status === 'online' ? '在线' : '离线' }}
            </el-tag>
          </div>

          <div class="node-card__id kp-mono kp-text-muted">{{ node.id }}</div>

          <div class="node-card__metrics">
            <div class="metric">
              <span class="metric__label">人数</span>
              <span class="metric__value">
                {{ node.status === 'online' ? formatNumber(node.onlinePlayers) : '—' }}
                <span
                  v-if="node.status === 'online' && node.maxPlayers !== null && node.maxPlayers > 0"
                  class="kp-text-muted"
                >
                  / {{ formatNumber(node.maxPlayers) }}
                </span>
              </span>
            </div>
            <div class="metric">
              <span class="metric__label">TPS</span>
              <!-- tps 为 null 时 TpsText 显示「—」，不显示 0 / 20.0 -->
              <TpsText v-if="node.status === 'online'" :tps="node.metrics?.tps ?? null" :show-label="false" compact />
              <span v-else class="metric__value">—</span>
            </div>
            <div class="metric">
              <span class="metric__label">内存</span>
              <span class="metric__value">
                {{
                  memoryPercent(node.metrics?.memory) === null
                    ? '—'
                    : percentText(memoryPercent(node.metrics?.memory), 0)
                }}
              </span>
            </div>
            <div class="metric">
              <span class="metric__label">MSPT</span>
              <span class="metric__value kp-mono">
                {{ node.metrics?.mspt === null || node.metrics?.mspt === undefined ? '—' : node.metrics.mspt.toFixed(1) }}
              </span>
            </div>
          </div>

          <div class="node-card__foot">
            <span v-if="node.mcVersion" class="kp-text-muted">{{ node.brand ?? 'MC' }} {{ node.mcVersion }}</span>
            <span v-else class="kp-text-muted">未上报版本</span>
            <span class="kp-text-muted">
              心跳 {{ node.status === 'online' ? '正常' : formatRelative(node.lastSeenAt) }}
            </span>
          </div>
        </div>
      </div>
    </el-card>

    <el-card v-if="canViewAudit" shadow="never">
      <template #header>
        <div class="card-head">
          <span>最近审计</span>
          <el-button text type="primary" @click="router.push({ name: 'audit' })">查看全部</el-button>
        </div>
      </template>

      <el-alert
        v-if="audit.error.value"
        type="error"
        :closable="false"
        show-icon
        :title="audit.error.value"
        data-testid="dashboard-audit-error"
      />
      <el-skeleton v-else-if="audit.loading.value && !audit.data.value" :rows="4" animated />
      <el-empty
        v-else-if="(audit.data.value ?? []).length === 0"
        description="暂无审计记录"
        :image-size="70"
      />
      <el-table v-else :data="audit.data.value ?? []" size="small">
        <el-table-column label="时间" width="180">
          <template #default="scope">{{ formatRelative((scope.row as AuditEntry).ts) }}</template>
        </el-table-column>
        <el-table-column label="操作者" width="140" prop="actor" />
        <el-table-column label="动作" min-width="180">
          <template #default="scope">
            <span class="kp-inline-code">{{ (scope.row as AuditEntry).action }}</span>
          </template>
        </el-table-column>
        <el-table-column label="目标" min-width="200">
          <template #default="scope">
            <span v-if="(scope.row as AuditEntry).targetId">
              {{ (scope.row as AuditEntry).targetType }} · {{ (scope.row as AuditEntry).targetId }}
            </span>
            <span v-else class="kp-text-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="结果" width="110">
          <template #default="scope">
            <el-tag :type="(scope.row as AuditEntry).ok ? 'success' : 'danger'" size="small" disable-transitions>
              {{ (scope.row as AuditEntry).ok ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="详情" min-width="200">
          <template #default="scope">
            <el-tooltip
              v-if="(scope.row as AuditEntry).error"
              :content="(scope.row as AuditEntry).error ?? ''"
              placement="top"
            >
              <span class="error-text">{{ (scope.row as AuditEntry).error }}</span>
            </el-tooltip>
            <span v-else class="kp-text-muted">—</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-else shadow="never">
      <el-empty description="当前账号没有 audit.view 权限，审计记录不可见" :image-size="70" />
    </el-card>
  </div>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--kp-gap);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.node-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(264px, 1fr));
  gap: 12px;
}

.node-card {
  border: 1px solid var(--kp-border);
  border-left: 3px solid var(--kp-disabled);
  border-radius: var(--kp-radius);
  padding: 12px 14px;
  cursor: pointer;
  transition: box-shadow 0.15s ease, transform 0.15s ease;
  background: var(--el-bg-color);
}

.node-card:hover {
  box-shadow: var(--el-box-shadow-light);
  transform: translateY(-1px);
}

.node-card--online {
  border-left-color: var(--kp-online);
}

.node-card--offline {
  border-left-color: var(--kp-offline);
}

.node-card--disabled {
  border-left-color: var(--kp-disabled);
  opacity: 0.75;
}

.node-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.node-card__title {
  display: flex;
  align-items: center;
  min-width: 0;
}

.node-card__title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-card__id {
  font-size: 12px;
  margin-top: 2px;
}

.node-card__metrics {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
}

.metric {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.metric__label {
  font-size: 12px;
  color: var(--kp-text-muted);
}

.metric__value {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.node-card__foot {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--kp-border);
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.refresh-hint {
  font-size: 12px;
}

.error-text {
  color: var(--el-color-danger);
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
