<script setup lang="ts">
/**
 * 封禁 / 禁言列表：类型 / 生效状态 / 节点筛选，新建（时长可选永久）、撤销。
 *
 * 撤销用 `active` 之外还要看 `revokedAt`：平台只回 `active`，
 * 已撤销的记录被置为 active=false，这里用「已撤销」而不是「已过期」区分展示，
 * 因为撤销是人的动作，过期是时间的结果 —— 排查时要能分开。
 */
import { CirclePlus, Refresh, Search } from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { punishmentsApi } from '@/api/endpoints';
import { describeApiError, toApiError } from '@/api/client';
import type { PageResult, PunishmentRecord, PunishmentType } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import PageHeader from '@/components/PageHeader.vue';
import PunishTag from '@/components/PunishTag.vue';
import PunishmentCreateDialog from '@/components/PunishmentCreateDialog.vue';
import type { DataTableColumn } from '@/components/DataTable.vue';
import { runMutation } from '@/composables/useMutation';
import { useAuthStore } from '@/stores/auth';
import { useNodesStore } from '@/stores/nodes';
import { PERMISSIONS } from '@/utils/permissions';
import { formatRelative, formatTime, truncate } from '@/utils/format';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const nodesStore = useNodesStore();

const canManage = computed(() => auth.hasPerm(PERMISSIONS.punishManage));

function queryString(key: string): string {
  const value = route.query[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

function queryNumber(key: string, fallback: number): number {
  const parsed = Number(queryString(key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const typeFilter = ref<PunishmentType | ''>(queryString('type') as PunishmentType | '');
const activeFilter = ref<'' | 'true' | 'false'>(
  queryString('active') === '' ? 'true' : (queryString('active') as 'true' | 'false'),
);
const nodeFilter = ref(queryString('node'));
const keyword = ref(queryString('kw'));
const page = ref(queryNumber('page', 1));
const size = ref(queryNumber('size', 20));

const pageData = ref<PageResult<PunishmentRecord>>({ items: [], total: 0, page: 1, size: 20 });
const loading = ref(false);
const error = ref('');
const createVisible = ref(false);

const rows = computed(() => pageData.value.items ?? []);
const total = computed(() => pageData.value.total ?? rows.value.length);

const columns: DataTableColumn[] = [
  { key: 'type', label: '类型', width: 90, slot: 'type' },
  { key: 'name', label: '玩家', minWidth: 160, slot: 'player' },
  { key: 'reason', label: '原因', minWidth: 200, slot: 'reason' },
  { key: 'scope', label: '生效范围', width: 130, slot: 'scope' },
  { key: 'state', label: '状态', width: 110, slot: 'state' },
  { key: 'createdAt', label: '创建时间', width: 160, slot: 'createdAt' },
  { key: 'expiresAt', label: '到期', width: 160, slot: 'expiresAt' },
  { key: 'operator', label: '操作者', width: 120 },
  { key: 'actions', label: '操作', width: 130, fixed: 'right', slot: 'actions' },
];

function stateOf(row: PunishmentRecord): { label: string; type: 'success' | 'danger' | 'info' | 'warning' } {
  if (row.revokedAt) return { label: '已撤销', type: 'info' };
  if (!row.active) return { label: '未生效', type: 'info' };
  if (row.expiresAt && row.expiresAt <= Date.now()) return { label: '已过期', type: 'warning' };
  return { label: '生效中', type: 'danger' };
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await punishmentsApi.list({
      type: typeFilter.value || undefined,
      active: activeFilter.value === '' ? undefined : activeFilter.value === 'true',
      node: nodeFilter.value || undefined,
      kw: keyword.value.trim() || undefined,
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

function syncQuery(): void {
  void router.replace({
    query: {
      ...(typeFilter.value ? { type: typeFilter.value } : {}),
      ...(activeFilter.value ? { active: activeFilter.value } : {}),
      ...(nodeFilter.value ? { node: nodeFilter.value } : {}),
      ...(keyword.value.trim() ? { kw: keyword.value.trim() } : {}),
      ...(page.value > 1 ? { page: String(page.value) } : {}),
      ...(size.value !== 20 ? { size: String(size.value) } : {}),
    },
  });
}

function search(): void {
  page.value = 1;
  syncQuery();
  void load();
}

function reset(): void {
  typeFilter.value = '';
  activeFilter.value = 'true';
  nodeFilter.value = '';
  keyword.value = '';
  page.value = 1;
  syncQuery();
  void load();
}

function onPageChange(value: number): void {
  page.value = value;
  syncQuery();
  void load();
}

function onSizeChange(value: number): void {
  size.value = value;
  page.value = 1;
  syncQuery();
  void load();
}

async function revoke(row: PunishmentRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `撤销对「${row.name}」的${row.type === 'ban' ? '封禁' : row.type === 'mute' ? '禁言' : '处罚'}记录？撤销后会下发到相关节点，玩家立即恢复。`,
      '撤销处罚',
      { type: 'warning', confirmButtonText: '撤销', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  const ok = await runMutation(() => punishmentsApi.revoke(row.id), {
    success: '已撤销并下发',
    action: 'punishments.revoke',
  });
  if (ok !== null) await load();
}

function onCreated(): void {
  void load();
}

onMounted(() => {
  if (!nodesStore.loaded) void nodesStore.refreshQuietly();
  void load();
});

watch(
  () => route.fullPath,
  () => {
    if (route.name !== 'punishments') return;
    const nextType = queryString('type') as PunishmentType | '';
    const nextActive = queryString('active') as '' | 'true' | 'false';
    const nextNode = queryString('node');
    const nextKeyword = queryString('kw');
    const nextPage = queryNumber('page', 1);
    const nextSize = queryNumber('size', 20);
    const changed =
      nextType !== typeFilter.value ||
      nextActive !== activeFilter.value ||
      nextNode !== nodeFilter.value ||
      nextKeyword !== keyword.value ||
      nextPage !== page.value ||
      nextSize !== size.value;
    if (!changed) return;
    typeFilter.value = nextType;
    activeFilter.value = nextActive;
    nodeFilter.value = nextNode;
    keyword.value = nextKeyword;
    page.value = nextPage;
    size.value = nextSize;
    void load();
  },
);
</script>

<template>
  <div class="kp-page">
    <PageHeader
      title="封禁 / 禁言"
      subtitle="平台是唯一权威；记录落库后再下发到各节点（下发失败不影响封禁生效）"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        <el-button v-if="canManage" type="primary" :icon="CirclePlus" @click="createVisible = true">
          新建
        </el-button>
      </template>
    </PageHeader>

    <el-card shadow="never">
      <div class="kp-filter-form">
        <el-input
          v-model="keyword"
          :prefix-icon="Search"
          placeholder="按玩家名 / UUID / 原因搜索"
          clearable
          style="width: 240px"
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="typeFilter" placeholder="全部类型" clearable style="width: 130px">
          <el-option label="封禁" value="ban" />
          <el-option label="禁言" value="mute" />
          <el-option label="警告" value="warn" />
          <el-option label="踢出" value="kick" />
        </el-select>
        <el-select v-model="activeFilter" placeholder="全部状态" clearable style="width: 140px">
          <el-option label="生效中" value="true" />
          <el-option label="已失效" value="false" />
        </el-select>
        <el-select v-model="nodeFilter" placeholder="全部节点" clearable filterable style="width: 190px">
          <el-option
            v-for="node in nodesStore.nodes"
            :key="node.id"
            :label="`${node.name}（${node.id}）`"
            :value="node.id"
          />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </div>
    </el-card>

    <el-card shadow="never">
      <DataTable
        :columns="columns"
        :rows="rows"
        :loading="loading"
        :error="error"
        empty-text="没有匹配的处罚记录"
        row-key="id"
        :total="total"
        :page="page"
        :size="size"
        @retry="load"
        @update:page="onPageChange"
        @update:size="onSizeChange"
      >
        <template #type="{ row }">
          <PunishTag :type="row.type" :inactive="!row.active" />
        </template>
        <template #player="{ row }">
          <el-link
            type="primary"
            :underline="false"
            @click="router.push({ name: 'player-detail', params: { uuid: row.uuid } })"
          >
            {{ row.name }}
          </el-link>
          <div class="kp-text-muted uuid kp-mono">{{ row.uuid }}</div>
        </template>
        <template #reason="{ row }">
          <el-tooltip :content="row.reason" placement="top" :disabled="(row.reason ?? '').length < 40">
            <span>{{ truncate(row.reason, 40) }}</span>
          </el-tooltip>
        </template>
        <template #scope="{ row }">
          <el-tag v-if="!row.nodeId" size="small" type="warning" effect="plain" disable-transitions>
            全平台
          </el-tag>
          <span v-else>{{ nodesStore.nodeName(row.nodeId) }}</span>
        </template>
        <template #state="{ row }">
          <el-tag :type="stateOf(row).type" size="small" effect="light" disable-transitions>
            {{ stateOf(row).label }}
          </el-tag>
        </template>
        <template #createdAt="{ row }">
          <span :title="formatTime(row.createdAt)">{{ formatRelative(row.createdAt) }}</span>
        </template>
        <template #expiresAt="{ row }">
          <span v-if="!row.expiresAt" class="kp-text-muted">永久 / 不适用</span>
          <span v-else :title="formatTime(row.expiresAt)">
            {{ row.expiresAt <= Date.now() ? '已过期' : formatTime(row.expiresAt) }}
          </span>
        </template>
        <template #actions="{ row }">
          <el-button
            v-if="canManage && row.active && !row.revokedAt"
            size="small"
            text
            type="danger"
            @click="revoke(row)"
          >
            撤销
          </el-button>
          <span v-else class="kp-text-muted">—</span>
        </template>
      </DataTable>
    </el-card>

    <PunishmentCreateDialog v-model="createVisible" @created="onCreated" />
  </div>
</template>

<style scoped>
.uuid {
  font-size: 11.5px;
}
</style>
