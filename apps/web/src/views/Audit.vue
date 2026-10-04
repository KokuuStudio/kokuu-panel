<script setup lang="ts">
/**
 * 审计日志：多维筛选（操作者 / 动作 / 目标 / 节点 / 结果 / 时间范围）+ 分页。
 *
 * 时间用 el-date-picker 取毫秒时间戳（docs/API.md：时间一律毫秒时间戳）。
 * params 可能很大，主表只显示摘要，点「详情」在抽屉里看完整 JSON。
 */
import { Refresh, Search } from '@element-plus/icons-vue';
import { computed, onMounted, reactive, ref } from 'vue';

import { auditApi } from '@/api/endpoints';
import { describeApiError, toApiError } from '@/api/client';
import type { AuditEntry, PageResult } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import PageHeader from '@/components/PageHeader.vue';
import type { DataTableColumn } from '@/components/DataTable.vue';
import { useNodesStore } from '@/stores/nodes';
import { formatTime, truncate } from '@/utils/format';

const nodesStore = useNodesStore();

interface Filters {
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  nodeId: string;
  ok: '' | 'true' | 'false';
  range: [number, number] | null;
}

const filters = reactive<Filters>({
  actor: '',
  action: '',
  targetType: '',
  targetId: '',
  nodeId: '',
  ok: '',
  range: null,
});

const page = ref(1);
const size = ref(20);
const pageData = ref<PageResult<AuditEntry>>({ items: [], total: 0, page: 1, size: 20 });
const loading = ref(false);
const error = ref('');

const rows = computed(() => pageData.value.items ?? []);
const total = computed(() => pageData.value.total ?? rows.value.length);

/** 常见 targetType：docs/API.md 未穷举，这里给常见值 + 允许手输。 */
const TARGET_TYPES = ['player', 'node', 'punishment', 'group', 'account', 'economy'] as const;

const columns: DataTableColumn[] = [
  { key: 'ts', label: '时间', width: 170, slot: 'ts' },
  { key: 'actor', label: '操作者', width: 130, slot: 'actor' },
  { key: 'action', label: '动作', minWidth: 190, slot: 'action' },
  { key: 'target', label: '目标', minWidth: 220, slot: 'target' },
  { key: 'nodeId', label: '节点', width: 140, slot: 'node' },
  { key: 'ok', label: '结果', width: 90, slot: 'ok' },
  { key: 'params', label: '参数', minWidth: 200, slot: 'params' },
  { key: 'actions', label: '', width: 80, fixed: 'right', slot: 'actions' },
];

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await auditApi.list({
      actor: filters.actor.trim() || undefined,
      action: filters.action.trim() || undefined,
      targetType: filters.targetType || undefined,
      targetId: filters.targetId.trim() || undefined,
      nodeId: filters.nodeId || undefined,
      ok: filters.ok === '' ? undefined : filters.ok === 'true',
      from: filters.range?.[0] ?? undefined,
      to: filters.range?.[1] ?? undefined,
      page: page.value,
      size: size.value,
    });
    pageData.value = {
      items: result?.items ?? [],
      total: result?.total ?? 0,
      page: result?.page ?? page.value,
      size: result?.size ?? size.value,
    };
  } catch (cause) {
    error.value = describeApiError(toApiError(cause));
    pageData.value = { items: [], total: 0, page: page.value, size: size.value };
  } finally {
    loading.value = false;
  }
}

function search(): void {
  page.value = 1;
  void load();
}

function reset(): void {
  filters.actor = '';
  filters.action = '';
  filters.targetType = '';
  filters.targetId = '';
  filters.nodeId = '';
  filters.ok = '';
  filters.range = null;
  page.value = 1;
  void load();
}

function onPageChange(value: number): void {
  page.value = value;
  void load();
}

function onSizeChange(value: number): void {
  size.value = value;
  page.value = 1;
  void load();
}

// ── 详情抽屉 ────────────────────────────────────────────────

const drawerVisible = ref(false);
const current = ref<AuditEntry | null>(null);

function openDetail(row: AuditEntry): void {
  current.value = row;
  drawerVisible.value = true;
}

const currentParams = computed(() => {
  const params = current.value?.params;
  if (params === null || params === undefined) return '（无参数）';
  try {
    return JSON.stringify(params, null, 2);
  } catch {
    return String(params);
  }
});

function paramsSummary(row: AuditEntry): string {
  const params = row.params;
  if (params === null || params === undefined) return '—';
  try {
    const text = JSON.stringify(params);
    return truncate(text, 60);
  } catch {
    return '—';
  }
}

onMounted(() => {
  if (!nodesStore.loaded) void nodesStore.refreshQuietly();
  void load();
});
</script>

<template>
  <div class="kp-page">
    <PageHeader title="审计日志" subtitle="谁在什么时候对什么做了什么 —— 失败的操作同样记录">
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </template>
    </PageHeader>

    <el-card shadow="never">
      <el-form label-position="top" class="audit-filters">
        <div class="audit-filters__row">
          <el-form-item label="操作者">
            <el-input v-model="filters.actor" placeholder="用户名" clearable style="width: 150px" />
          </el-form-item>
          <el-form-item label="动作">
            <el-input
              v-model="filters.action"
              placeholder="punish.create"
              clearable
              class="kp-mono"
              style="width: 190px"
            />
          </el-form-item>
          <el-form-item label="目标类型">
            <el-select v-model="filters.targetType" placeholder="全部" clearable style="width: 140px">
              <el-option v-for="type in TARGET_TYPES" :key="type" :label="type" :value="type" />
            </el-select>
          </el-form-item>
          <el-form-item label="目标 ID">
            <el-input v-model="filters.targetId" placeholder="UUID / ID" clearable style="width: 210px" />
          </el-form-item>
          <el-form-item label="节点">
            <el-select v-model="filters.nodeId" placeholder="全部" clearable filterable style="width: 190px">
              <el-option
                v-for="node in nodesStore.nodes"
                :key="node.id"
                :label="`${node.name}（${node.id}）`"
                :value="node.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="结果">
            <el-select v-model="filters.ok" placeholder="全部" clearable style="width: 120px">
              <el-option label="成功" value="true" />
              <el-option label="失败" value="false" />
            </el-select>
          </el-form-item>
          <el-form-item label="时间范围">
            <el-date-picker
              v-model="filters.range"
              type="datetimerange"
              unlink-panels
              range-separator="至"
              start-placeholder="开始"
              end-placeholder="结束"
              style="width: 360px"
            />
          </el-form-item>
        </div>
        <div class="audit-filters__actions">
          <el-button type="primary" :icon="Search" @click="search">查询</el-button>
          <el-button @click="reset">重置</el-button>
        </div>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <DataTable
        :columns="columns"
        :rows="rows"
        :loading="loading"
        :error="error"
        empty-text="没有匹配的审计记录"
        row-key="id"
        :total="total"
        :page="page"
        :size="size"
        @retry="load"
        @update:page="onPageChange"
        @update:size="onSizeChange"
      >
        <template #ts="{ row }">{{ formatTime(row.ts) }}</template>
        <template #actor="{ row }">
          <span>{{ row.actor || '—' }}</span>
          <div v-if="row.actorIp" class="kp-text-muted ip kp-mono">{{ row.actorIp }}</div>
        </template>
        <template #action="{ row }">
          <span class="kp-inline-code">{{ row.action }}</span>
        </template>
        <template #target="{ row }">
          <span v-if="row.targetId">
            <span class="kp-text-muted">{{ row.targetType ?? '—' }}</span>
            · <span class="kp-mono target-id">{{ row.targetId }}</span>
          </span>
          <span v-else class="kp-text-muted">—</span>
        </template>
        <template #node="{ row }">{{ row.nodeId ? nodesStore.nodeName(row.nodeId) : '—' }}</template>
        <template #ok="{ row }">
          <el-tag :type="row.ok ? 'success' : 'danger'" size="small" disable-transitions>
            {{ row.ok ? '成功' : '失败' }}
          </el-tag>
        </template>
        <template #params="{ row }">
          <el-tooltip v-if="row.error" :content="row.error" placement="top">
            <span class="error-text">{{ truncate(row.error, 40) }}</span>
          </el-tooltip>
          <span v-else class="kp-mono param-text">{{ paramsSummary(row) }}</span>
        </template>
        <template #actions="{ row }">
          <el-button size="small" text type="primary" @click="openDetail(row)">详情</el-button>
        </template>
      </DataTable>
    </el-card>

    <el-drawer v-model="drawerVisible" title="审计详情" size="480px">
      <template v-if="current">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="ID">{{ current.id }}</el-descriptions-item>
          <el-descriptions-item label="时间">{{ formatTime(current.ts) }}</el-descriptions-item>
          <el-descriptions-item label="操作者">
            {{ current.actor }}
            <span v-if="current.actorIp" class="kp-text-muted">（{{ current.actorIp }}）</span>
          </el-descriptions-item>
          <el-descriptions-item label="动作">
            <span class="kp-inline-code">{{ current.action }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="目标">
            {{ current.targetType ?? '—' }} · {{ current.targetId ?? '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="节点">
            {{ current.nodeId ? nodesStore.nodeName(current.nodeId) : '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="结果">
            <el-tag :type="current.ok ? 'success' : 'danger'" size="small" disable-transitions>
              {{ current.ok ? '成功' : '失败' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item v-if="current.error" label="错误">
            <span class="error-text">{{ current.error }}</span>
          </el-descriptions-item>
        </el-descriptions>

        <el-divider content-position="left">params</el-divider>
        <pre class="params kp-mono">{{ currentParams }}</pre>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.audit-filters__row {
  display: flex;
  flex-wrap: wrap;
  gap: 0 12px;
  align-items: flex-end;
}

.audit-filters__row :deep(.el-form-item) {
  margin-bottom: 8px;
}

.audit-filters__actions {
  display: flex;
  gap: 8px;
}

.ip {
  font-size: 11.5px;
}

.target-id {
  font-size: 12px;
}

.param-text {
  font-size: 12px;
}

.error-text {
  color: var(--el-color-danger);
  font-size: 12px;
}

.params {
  margin: 0;
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  font-size: 12.5px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 60vh;
  overflow: auto;
}
</style>
