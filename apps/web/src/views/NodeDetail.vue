<script setup lang="ts">
/**
 * 节点详情：概览 / 控制台 / 在线玩家。
 *
 * 关键实现点：
 * - 控制台实时日志走 WS topic `console:<nodeId>`。该 topic 需要 `console.execute`
 *   权限，服务端会静默剔除无权限的订阅 —— 所以 UI 显示的是 store 里
 *   **服务端回的真实 topic 列表**，并且把 `console:<id>` 是否在列表里当作
 *   「实时日志是否真的接通」的唯一判据（而不是「我本地订阅了」）。
 * - `/info` 与 `/metrics` 走的是 Agent 的 `server.info` / `server.metrics`，
 *   节点离线时后端会回 502 NODE_OFFLINE，这里按「节点离线」提示，与
 *   NODE_ERROR（连上了但拒绝）区分开。
 */
import { Promotion, Refresh, VideoPlay } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { nodesApi } from '@/api/endpoints';
import { describeApiError, toApiError } from '@/api/client';
import type {
  ConsoleLine,
  Metrics as NodeMetrics,
  PlayerEntry,
  ServerInfo,
} from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import NodeStatusTag from '@/components/NodeStatusTag.vue';
import PageHeader from '@/components/PageHeader.vue';
import TpsText from '@/components/TpsText.vue';
import type { DataTableColumn } from '@/components/DataTable.vue';
import { usePolling } from '@/composables/usePolling';
import { useAuthStore } from '@/stores/auth';
import { useEventsStore } from '@/stores/events';
import { useNodesStore } from '@/stores/nodes';
import { PERMISSIONS } from '@/utils/permissions';
import {
  formatBytes,
  formatNumber,
  formatRelative,
  formatUptime,
  memoryPercent,
  numOrDash,
  percentText,
  toArray,
} from '@/utils/format';

const props = defineProps<{ id?: string }>();

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const events = useEventsStore();
const nodesStore = useNodesStore();

const nodeId = computed(() => props.id ?? String(route.params.id ?? ''));
const node = computed(() => nodesStore.findNode(nodeId.value));
const capabilities = computed<string[]>(() => node.value?.capabilities ?? []);

const canExecute = computed(() => auth.hasPerm(PERMISSIONS.consoleExecute));
const canViewPlayers = computed(() => auth.hasPerm(PERMISSIONS.playerView));
const supportsConsole = computed(() => capabilities.value.includes('console'));
const supportsPlayers = computed(() => capabilities.value.includes('players'));

const activeTab = ref('overview');

// ── 概览：ServerInfo / Metrics ───────────────────────────────

const info = ref<ServerInfo | null>(null);
const infoLoading = ref(false);
const infoError = ref('');

const metrics = ref<NodeMetrics | null>(null);
const metricsLoading = ref(false);
const metricsError = ref('');

async function loadInfo(): Promise<void> {
  if (!nodeId.value) return;
  infoLoading.value = true;
  infoError.value = '';
  try {
    const result = await nodesApi.info(nodeId.value);
    info.value = result?.info ?? null;
  } catch (cause) {
    info.value = null;
    infoError.value = describeApiError(toApiError(cause));
  } finally {
    infoLoading.value = false;
  }
}

async function loadMetrics(): Promise<void> {
  if (!nodeId.value) return;
  metricsLoading.value = true;
  metricsError.value = '';
  try {
    const result = await nodesApi.metrics(nodeId.value);
    metrics.value = result?.metrics ?? null;
  } catch (cause) {
    metrics.value = null;
    metricsError.value = describeApiError(toApiError(cause));
  } finally {
    metricsLoading.value = false;
  }
}

const memoryPct = computed(() => memoryPercent(metrics.value?.memory));

// ── 在线玩家 ────────────────────────────────────────────────

const players = ref<PlayerEntry[]>([]);
const playersLoading = ref(false);
const playersError = ref('');

async function loadPlayers(): Promise<void> {
  if (!nodeId.value) return;
  playersLoading.value = true;
  playersError.value = '';
  try {
    // endpoints 层已拆掉 `{ players: […] }` 信封，这里直接是数组。
    players.value = await nodesApi.online(nodeId.value);
  } catch (cause) {
    players.value = [];
    playersError.value = describeApiError(toApiError(cause));
  } finally {
    playersLoading.value = false;
  }
}

const playerColumns: DataTableColumn[] = [
  { key: 'name', label: '玩家', minWidth: 150, slot: 'playerName' },
  { key: 'world', label: '世界', width: 130 },
  { key: 'position', label: '坐标', minWidth: 180, slot: 'position' },
  { key: 'ping', label: '延迟', width: 100, slot: 'ping' },
  { key: 'gamemode', label: '模式', width: 110 },
  { key: 'health', label: '生命', width: 90, slot: 'health' },
  { key: 'level', label: '等级', width: 80 },
  { key: 'flags', label: '状态', minWidth: 150, slot: 'flags' },
];

// ── 控制台 ─────────────────────────────────────────────────

interface ConsoleEntry {
  id: number;
  line: string;
  level: string;
  ts?: number;
  /** 本行是用户输入的命令（回显）。 */
  local?: boolean;
}

const consoleLines = ref<ConsoleEntry[]>([]);
const consoleInput = ref('');
const consoleSending = ref(false);
const consoleHistoryLoading = ref(false);
const consoleHistoryError = ref('');
const consoleDropped = ref(0);
const consoleBox = ref<HTMLElement | null>(null);

let consoleSeq = 0;
const MAX_CONSOLE_LINES = 2000;

const consoleTopic = computed(() => `console:${nodeId.value}`);
/** 服务端确认生效的 topic 里有没有控制台 —— 这才是「实时日志接通」的证据。 */
const consoleTopicActive = computed(() => events.topics.includes(consoleTopic.value));
const consoleTopicRejected = computed(() => events.rejectedTopics.includes(consoleTopic.value));

function pushConsole(line: string, level = 'INFO', local = false, ts?: number): void {
  consoleSeq += 1;
  consoleLines.value.push({ id: consoleSeq, line, level, ts, local });
  if (consoleLines.value.length > MAX_CONSOLE_LINES) {
    consoleLines.value.splice(0, consoleLines.value.length - MAX_CONSOLE_LINES);
  }
}

async function scrollConsoleToBottom(): Promise<void> {
  await nextTick();
  const box = consoleBox.value;
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  if (nearBottom || consoleLines.value.length < 60) box.scrollTop = box.scrollHeight;
}

async function loadConsoleHistory(): Promise<void> {
  if (!nodeId.value || !canExecute.value) return;
  consoleHistoryLoading.value = true;
  consoleHistoryError.value = '';
  try {
    // 后端回 `{ lines: [{ line, level, ts }] }`；endpoints 的类型也容忍裸数组。
    const result = await nodesApi.consoleHistory(nodeId.value);
    const lines = toArray<ConsoleLine>(result);
    consoleLines.value = [];
    consoleSeq = 0;
    for (const item of lines) {
      const text = typeof item === 'string' ? item : item?.line;
      if (typeof text !== 'string') continue;
      pushConsole(
        text,
        typeof item === 'string' ? 'INFO' : (item.level ?? 'INFO'),
        false,
        typeof item === 'string' ? undefined : item.ts,
      );
    }
    await scrollConsoleToBottom();
  } catch (cause) {
    consoleHistoryError.value = describeApiError(toApiError(cause));
  } finally {
    consoleHistoryLoading.value = false;
  }
}

async function sendCommand(): Promise<void> {
  const command = consoleInput.value.trim();
  if (!command || !nodeId.value) return;
  consoleSending.value = true;
  try {
    const result = await nodesApi.console(nodeId.value, command);
    pushConsole(`> ${command}`, 'command', true);
    for (const line of result?.output ?? []) pushConsole(line, result?.success === false ? 'ERROR' : 'INFO');
    if (result?.success === false) {
      ElMessage.warning('命令已发送，但服务端返回 success=false，请查看输出');
    }
    consoleInput.value = '';
    await scrollConsoleToBottom();
  } catch (cause) {
    ElMessage.error(describeApiError(toApiError(cause)));
  } finally {
    consoleSending.value = false;
  }
}

function clearConsole(): void {
  consoleLines.value = [];
}

function onQuickCommand(command: string): void {
  consoleInput.value = command;
  void sendCommand();
}

let offConsole: (() => void) | null = null;
let unsubscribeConsole: (() => void) | null = null;

function startConsoleStream(): void {
  if (offConsole || !canExecute.value || !supportsConsole.value) return;
  unsubscribeConsole = events.subscribe(consoleTopic.value);
  offConsole = events.on('console.line', (frame) => {
    const data = frame.data as { line?: unknown; level?: unknown; dropped?: unknown } | null;
    if (!data || typeof data.line !== 'string') return;
    const level = typeof data.level === 'string' ? data.level : 'INFO';
    pushConsole(data.line, level, false, frame.ts);
    if (typeof data.dropped === 'number' && data.dropped > 0) {
      consoleDropped.value += data.dropped;
    }
    void scrollConsoleToBottom();
  });
}

function stopConsoleStream(): void {
  offConsole?.();
  unsubscribeConsole?.();
  offConsole = null;
  unsubscribeConsole = null;
}

// ── 生命周期 ────────────────────────────────────────────────

async function loadAll(): Promise<void> {
  await nodesStore.refreshQuietly();
  await Promise.all([loadInfo(), loadMetrics()]);
  if (canViewPlayers.value && supportsPlayers.value) await loadPlayers();
}

const refreshEnabled = ref(true);
usePolling(
  async () => {
    await loadMetrics();
    if (canViewPlayers.value && supportsPlayers.value) await loadPlayers();
  },
  10_000,
  { enabled: refreshEnabled },
);

const offNodeEvents: Array<() => void> = [];

onMounted(async () => {
  await loadAll();
  if (canExecute.value && supportsConsole.value) await loadConsoleHistory();
  startConsoleStream();

  // 节点上下线时刷新概览：状态标签与指标要立刻反映，而不是等下一次轮询。
  offNodeEvents.push(
    events.on('node.connected', () => {
      void loadAll();
    }),
    events.on('node.disconnected', () => {
      void loadAll();
    }),
    events.on('node.metrics', () => {
      if (nodeId.value) void loadMetrics();
    }),
  );

  if (typeof route.query.tab === 'string') activeTab.value = route.query.tab;
});

onBeforeUnmount(() => {
  stopConsoleStream();
  for (const off of offNodeEvents) off();
  offNodeEvents.length = 0;
});

watch(nodeId, async () => {
  stopConsoleStream();
  consoleLines.value = [];
  await loadAll();
  if (canExecute.value && supportsConsole.value) await loadConsoleHistory();
  startConsoleStream();
});

watch(activeTab, (tab) => {
  void router.replace({ query: { ...route.query, tab } });
});
</script>

<template>
  <div class="kp-page">
    <PageHeader
      :title="node?.name ?? nodeId"
      :subtitle="node ? `${node.id} · ${node.brand ?? 'MC'} ${node.mcVersion ?? ''}` : nodeId"
      back
      @back="router.push({ name: 'nodes' })"
    >
      <template #actions>
        <NodeStatusTag
          v-if="node"
          :status="node.status"
          :enabled="node.enabled"
          :last-seen-at="node.lastSeenAt"
          size="default"
        />
        <el-tag
          v-for="capability in capabilities"
          :key="capability"
          size="small"
          effect="plain"
          disable-transitions
        >
          {{ capability }}
        </el-tag>
        <el-button :icon="Refresh" :loading="infoLoading || metricsLoading" @click="loadAll">
          刷新
        </el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="!node && !nodesStore.loading"
      type="warning"
      :closable="false"
      show-icon
      title="节点不存在或已被删除"
      :description="`平台里没有 id 为 ${nodeId} 的节点。`"
    />

    <el-tabs v-model="activeTab" type="border-card" class="node-tabs">
      <!-- ── 概览 ─────────────────────────────────────────── -->
      <el-tab-pane label="概览" name="overview">
        <div class="overview">
          <el-card shadow="never" class="overview__card">
            <template #header>
              <div class="card-head">
                <span>实时指标</span>
                <span class="kp-text-muted">{{ metricsLoading ? '刷新中…' : '每 10 秒自动刷新' }}</span>
              </div>
            </template>

            <el-alert
              v-if="metricsError"
              type="error"
              :closable="false"
              show-icon
              :title="metricsError"
              data-testid="metrics-error"
            />
            <el-skeleton v-else-if="metricsLoading && !metrics" :rows="3" animated />
            <el-empty
              v-else-if="!metrics"
              description="暂无指标数据（节点离线时后端不返回 metrics）"
              :image-size="70"
            />
            <div v-else class="metric-grid">
              <div class="metric-cell">
                <span class="metric-cell__label">TPS</span>
                <!-- null → 「—」，绝不显示 0 / 20.0 -->
                <TpsText :tps="metrics.tps" :show-label="false" />
              </div>
              <div class="metric-cell">
                <span class="metric-cell__label">MSPT</span>
                <span class="metric-cell__value kp-mono">{{ numOrDash(metrics.mspt, 1) }}</span>
              </div>
              <div class="metric-cell">
                <span class="metric-cell__label">在线 / 上限</span>
                <span class="metric-cell__value kp-mono">
                  {{ formatNumber(metrics.online) }} / {{ formatNumber(metrics.maxPlayers) }}
                </span>
              </div>
              <div class="metric-cell">
                <span class="metric-cell__label">内存</span>
                <span class="metric-cell__value">
                  {{ memoryPct === null ? '—' : percentText(memoryPct) }}
                  <span class="kp-text-muted">
                    ({{ formatBytes(metrics.memory?.used) }} / {{ formatBytes(metrics.memory?.max) }})
                  </span>
                </span>
              </div>
              <div class="metric-cell">
                <span class="metric-cell__label">线程</span>
                <span class="metric-cell__value kp-mono">{{ numOrDash(metrics.threads) }}</span>
              </div>
              <div class="metric-cell">
                <span class="metric-cell__label">运行时长</span>
                <span class="metric-cell__value">{{ formatUptime(metrics.uptimeSeconds) }}</span>
              </div>
              <div class="metric-cell">
                <span class="metric-cell__label">实体 / 区块</span>
                <span class="metric-cell__value kp-mono">
                  {{ numOrDash(metrics.entities) }} / {{ numOrDash(metrics.chunks) }}
                </span>
              </div>
              <div class="metric-cell">
                <span class="metric-cell__label">上次心跳</span>
                <span class="metric-cell__value">{{ formatRelative(node?.lastSeenAt ?? null) }}</span>
              </div>
            </div>

            <div v-if="memoryPct !== null" class="memory-bar">
              <el-progress
                :percentage="Math.round(memoryPct)"
                :stroke-width="10"
                :status="memoryPct > 90 ? 'exception' : memoryPct > 75 ? 'warning' : 'success'"
              />
            </div>
          </el-card>

          <el-card shadow="never" class="overview__card">
            <template #header>
              <div class="card-head">
                <span>服务端信息</span>
                <span class="kp-text-muted">来自 Agent 的 server.info</span>
              </div>
            </template>

            <el-alert
              v-if="infoError"
              type="error"
              :closable="false"
              show-icon
              :title="infoError"
              data-testid="info-error"
            />
            <el-skeleton v-else-if="infoLoading && !info" :rows="4" animated />
            <el-empty v-else-if="!info" description="节点未上报服务端信息" :image-size="70" />
            <template v-else>
              <div class="kp-desc-grid">
                <div class="kp-desc-item">
                  <span class="kp-desc-item__label">名称</span>
                  <span class="kp-desc-item__value">{{ info.name }}</span>
                </div>
                <div class="kp-desc-item">
                  <span class="kp-desc-item__label">服务端</span>
                  <span class="kp-desc-item__value">{{ info.brand }} {{ info.bukkitVersion }}</span>
                </div>
                <div class="kp-desc-item">
                  <span class="kp-desc-item__label">端口</span>
                  <span class="kp-desc-item__value kp-mono">{{ info.port }}</span>
                </div>
                <div class="kp-desc-item">
                  <span class="kp-desc-item__label">正版验证</span>
                  <span class="kp-desc-item__value">{{ info.onlineMode ? '开启' : '关闭' }}</span>
                </div>
                <div class="kp-desc-item">
                  <span class="kp-desc-item__label">人数上限</span>
                  <span class="kp-desc-item__value">{{ info.maxPlayers }}</span>
                </div>
                <div class="kp-desc-item">
                  <span class="kp-desc-item__label">视距</span>
                  <span class="kp-desc-item__value">{{ info.viewDistance }}</span>
                </div>
                <div class="kp-desc-item">
                  <span class="kp-desc-item__label">白名单</span>
                  <span class="kp-desc-item__value">
                    {{ info.whitelistEnabled ? '已开启' : '已关闭' }}
                  </span>
                </div>
              </div>

              <div class="motd">
                <span class="kp-text-muted">MOTD</span>
                <div class="motd__text kp-mono">{{ info.motd || '—' }}</div>
              </div>

              <el-divider content-position="left">
                插件（{{ info.plugins?.length ?? 0 }}）
              </el-divider>
              <el-table
                v-if="(info.plugins ?? []).length > 0"
                :data="info.plugins"
                size="small"
                max-height="240"
              >
                <el-table-column prop="name" label="名称" min-width="180" />
                <el-table-column prop="version" label="版本" min-width="140" />
              </el-table>
              <el-empty v-else description="没有插件信息" :image-size="60" />

              <el-divider content-position="left">
                世界（{{ info.worlds?.length ?? 0 }}）
              </el-divider>
              <el-table
                v-if="(info.worlds ?? []).length > 0"
                :data="info.worlds"
                size="small"
                max-height="280"
              >
                <el-table-column prop="name" label="世界" min-width="150" />
                <el-table-column prop="environment" label="环境" width="130" />
                <el-table-column prop="players" label="玩家" width="90" />
                <el-table-column prop="entities" label="实体" width="100" />
                <el-table-column prop="chunks" label="已载入区块" width="120" />
              </el-table>
              <el-empty v-else description="没有世界信息" :image-size="60" />
            </template>
          </el-card>
        </div>
      </el-tab-pane>

      <!-- ── 控制台 ───────────────────────────────────────── -->
      <el-tab-pane label="控制台" name="console" :disabled="!canExecute">
        <div v-if="!canExecute" class="pad">
          <el-empty description="缺少 console.execute 权限，无法查看或执行控制台命令" :image-size="70" />
        </div>
        <div v-else-if="!supportsConsole" class="pad">
          <el-empty
            description="该节点未声明 console 能力（插件未启用控制台模块），命令无法下发"
            :image-size="70"
          />
        </div>
        <div v-else class="console">
          <div class="console__bar">
            <el-tag
              :type="consoleTopicActive ? 'success' : consoleTopicRejected ? 'danger' : 'info'"
              size="small"
              effect="plain"
              disable-transitions
              data-testid="console-topic-state"
            >
              实时日志：{{
                consoleTopicActive ? '已订阅' : consoleTopicRejected ? '服务端拒绝订阅' : '未连接'
              }}
            </el-tag>
            <span class="kp-text-muted console__topic kp-mono">{{ consoleTopic }}</span>
            <span v-if="consoleDropped > 0" class="kp-text-muted">
              服务端限流丢弃 {{ consoleDropped }} 行
            </span>
            <span class="console__spacer" />
            <el-button size="small" :loading="consoleHistoryLoading" @click="loadConsoleHistory">
              重新加载历史
            </el-button>
            <el-button size="small" @click="clearConsole">清屏</el-button>
          </div>

          <el-alert
            v-if="consoleTopicRejected"
            type="warning"
            :closable="false"
            show-icon
            title="服务端拒绝了实时日志订阅"
            description="服务端返回的生效 topic 列表里没有该控制台 topic，通常是账号缺少 console.execute 权限。当前显示的只是历史缓冲。"
            data-testid="console-rejected"
          />
          <el-alert
            v-else-if="consoleHistoryError"
            type="error"
            :closable="false"
            show-icon
            :title="consoleHistoryError"
          />

          <div ref="consoleBox" class="kp-console console__box">
            <div v-if="consoleLines.length === 0" class="console__empty">
              暂无日志。控制台实时转发默认在 Agent 侧关闭（agent.yml 的 events.console），
              打开后才会推送到这里；输入命令仍可正常执行。
            </div>
            <div v-for="entry in consoleLines" :key="entry.id" class="kp-console__line">
              <span class="kp-console__level" :class="`kp-console__level--${entry.level}`">
                {{ entry.local ? 'input' : entry.level }}
              </span>
              <span>{{ entry.line }}</span>
            </div>
          </div>

          <div class="console__input">
            <el-input
              v-model="consoleInput"
              placeholder="输入命令（不需要带前导 /），回车执行"
              class="kp-mono"
              :disabled="consoleSending"
              @keyup.enter="sendCommand"
            >
              <template #prepend>/</template>
            </el-input>
            <el-button
              type="primary"
              :icon="Promotion"
              :loading="consoleSending"
              @click="sendCommand"
            >
              执行
            </el-button>
          </div>

          <div class="console__quick">
            <span class="kp-text-muted">常用：</span>
            <el-button size="small" text :icon="VideoPlay" @click="onQuickCommand('list')">list</el-button>
            <el-button size="small" text @click="onQuickCommand('tps')">tps</el-button>
            <el-button size="small" text @click="onQuickCommand('save-all')">save-all</el-button>
            <el-button size="small" text @click="onQuickCommand('whitelist list')">
              whitelist list
            </el-button>
          </div>
        </div>
      </el-tab-pane>

      <!-- ── 在线玩家 ─────────────────────────────────────── -->
      <el-tab-pane label="在线玩家" name="players" :disabled="!canViewPlayers">
        <div v-if="!canViewPlayers" class="pad">
          <el-empty description="缺少 player.view 权限，无法查看在线玩家" :image-size="70" />
        </div>
        <div v-else class="pad">
          <DataTable
            :columns="playerColumns"
            :rows="players"
            :loading="playersLoading"
            :error="playersError"
            empty-text="当前没有在线玩家"
            row-key="uuid"
            :show-pager="false"
            @retry="loadPlayers"
          >
            <template #playerName="{ row }">
              <el-link
                type="primary"
                :underline="false"
                @click="router.push({ name: 'player-detail', params: { uuid: row.uuid } })"
              >
                {{ row.name }}
              </el-link>
              <span v-if="row.displayName && row.displayName !== row.name" class="kp-text-muted">
                （{{ row.displayName }}）
              </span>
            </template>
            <template #position="{ row }">
              <span class="kp-mono">{{ row.x.toFixed(1) }}, {{ row.y.toFixed(1) }}, {{ row.z.toFixed(1) }}</span>
            </template>
            <template #ping="{ row }">
              <el-tag
                :type="row.ping < 80 ? 'success' : row.ping < 200 ? 'warning' : 'danger'"
                size="small"
                effect="plain"
                disable-transitions
              >
                {{ row.ping }} ms
              </el-tag>
            </template>
            <template #health="{ row }">
              <span class="kp-mono">{{ numOrDash(row.health, 1) }}</span>
              <span class="kp-text-muted"> / {{ row.food }}</span>
            </template>
            <template #flags="{ row }">
              <el-tag v-if="row.op" size="small" type="warning" effect="plain" disable-transitions>OP</el-tag>
              <el-tag
                v-if="row.whitelisted"
                size="small"
                type="info"
                effect="plain"
                class="flag"
                disable-transitions
              >
                白名单
              </el-tag>
              <span v-if="!row.op && !row.whitelisted" class="kp-text-muted">普通</span>
            </template>
          </DataTable>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.node-tabs {
  border-radius: var(--kp-radius);
}

.overview {
  display: grid;
  grid-template-columns: minmax(300px, 1fr) minmax(360px, 1.4fr);
  gap: var(--kp-gap);
  align-items: start;
}

@media (max-width: 1100px) {
  .overview {
    grid-template-columns: 1fr;
  }
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px 16px;
}

.metric-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.metric-cell__label {
  font-size: 12px;
  color: var(--kp-text-muted);
}

.metric-cell__value {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  word-break: break-all;
}

.memory-bar {
  margin-top: 14px;
}

.motd {
  margin-top: 14px;
}

.motd__text {
  margin-top: 4px;
  padding: 8px 10px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  word-break: break-all;
  white-space: pre-wrap;
}

.pad {
  padding: 4px;
}

.console {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.console__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.console__topic {
  font-size: 12px;
}

.console__spacer {
  flex: 1 1 auto;
}

.console__box {
  height: min(52vh, 520px);
  min-height: 240px;
}

.console__empty {
  color: #8b9bad;
  white-space: pre-wrap;
}

.console__input {
  display: flex;
  gap: 8px;
}

.console__quick {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.flag {
  margin-left: 4px;
}
</style>
