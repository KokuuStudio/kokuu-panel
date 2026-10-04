<script setup lang="ts">
/**
 * 玩家列表：搜索 / 在线筛选 / 节点筛选 / 分页。
 *
 * 筛选条件与分页都同步到 URL query（`?kw=&online=&node=&page=&size=`），
 * 这样从玩家详情返回时能回到原来的筛选结果，链接也能直接分享。
 */
import { Refresh, Search } from '@element-plus/icons-vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { playersApi } from '@/api/endpoints';
import { describeApiError, toApiError } from '@/api/client';
import type { PageResult, PlayerEntry } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import PageHeader from '@/components/PageHeader.vue';
import PlayerAvatar from '@/components/PlayerAvatar.vue';
import type { DataTableColumn } from '@/components/DataTable.vue';
import { useNodesStore } from '@/stores/nodes';
import { formatDuration, formatRelative, formatTime } from '@/utils/format';

const route = useRoute();
const router = useRouter();
const nodesStore = useNodesStore();

function queryString(key: string): string {
  const value = route.query[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

function queryNumber(key: string, fallback: number): number {
  const parsed = Number(queryString(key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const keyword = ref(queryString('kw'));
const onlineFilter = ref<'' | 'true' | 'false'>(queryString('online') as '' | 'true' | 'false');
const nodeFilter = ref(queryString('node'));
const page = ref(queryNumber('page', 1));
const size = ref(queryNumber('size', 20));

const pageData = ref<PageResult<PlayerEntry>>({ items: [], total: 0, page: 1, size: 20 });
const loading = ref(false);
const error = ref('');

const rows = computed(() => pageData.value.items ?? []);
const total = computed(() => pageData.value.total ?? rows.value.length);

const columns: DataTableColumn[] = [
  { key: 'name', label: '玩家', minWidth: 190, slot: 'name' },
  { key: 'uuid', label: 'UUID', minWidth: 260, slot: 'uuid' },
  { key: 'status', label: '状态', width: 110, slot: 'status' },
  { key: 'world', label: '位置', minWidth: 190, slot: 'location' },
  { key: 'playtimeSeconds', label: '游玩时长', width: 140, slot: 'playtime' },
  { key: 'firstPlayed', label: '首次进入', width: 170, slot: 'firstPlayed' },
  { key: 'lastSeen', label: '最后在线', width: 160, slot: 'lastSeen' },
];

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await playersApi.list({
      kw: keyword.value.trim() || undefined,
      online: onlineFilter.value === '' ? undefined : onlineFilter.value === 'true',
      node: nodeFilter.value || undefined,
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

/** 把当前筛选写回 URL（replace 避免污染历史记录）。 */
function syncQuery(): void {
  void router.replace({
    query: {
      ...(keyword.value.trim() ? { kw: keyword.value.trim() } : {}),
      ...(onlineFilter.value ? { online: onlineFilter.value } : {}),
      ...(nodeFilter.value ? { node: nodeFilter.value } : {}),
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
  keyword.value = '';
  onlineFilter.value = '';
  nodeFilter.value = '';
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

function openPlayer(uuid: string): void {
  void router.push({ name: 'player-detail', params: { uuid }, query: { back: route.fullPath } });
}

onMounted(() => {
  if (!nodesStore.loaded) void nodesStore.refreshQuietly();
  void load();
});

// 浏览器前进/后退时按 URL 重新加载，保持列表与地址栏一致。
watch(
  () => route.fullPath,
  () => {
    if (route.name !== 'players') return;
    const nextKeyword = queryString('kw');
    const nextOnline = queryString('online') as '' | 'true' | 'false';
    const nextNode = queryString('node');
    const nextPage = queryNumber('page', 1);
    const nextSize = queryNumber('size', 20);
    const changed =
      nextKeyword !== keyword.value ||
      nextOnline !== onlineFilter.value ||
      nextNode !== nodeFilter.value ||
      nextPage !== page.value ||
      nextSize !== size.value;
    if (!changed) return;
    keyword.value = nextKeyword;
    onlineFilter.value = nextOnline;
    nodeFilter.value = nextNode;
    page.value = nextPage;
    size.value = nextSize;
    void load();
  },
);
</script>

<template>
  <div class="kp-page">
    <PageHeader title="玩家" subtitle="平台记录的玩家档案；离线玩家的数据来自历史记录">
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </template>
    </PageHeader>

    <el-card shadow="never">
      <div class="kp-filter-form">
        <el-input
          v-model="keyword"
          :prefix-icon="Search"
          placeholder="按玩家名或 UUID 搜索"
          clearable
          style="width: 260px"
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="onlineFilter" placeholder="全部状态" clearable style="width: 140px">
          <el-option label="在线" value="true" />
          <el-option label="离线" value="false" />
        </el-select>
        <el-select
          v-model="nodeFilter"
          placeholder="全部节点"
          clearable
          filterable
          style="width: 200px"
        >
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
        empty-text="没有匹配的玩家。玩家首次进入服务器并上报后才会出现在这里。"
        row-key="uuid"
        :total="total"
        :page="page"
        :size="size"
        clickable
        @retry="load"
        @update:page="onPageChange"
        @update:size="onSizeChange"
        @row-click="(row) => openPlayer(String(row.uuid))"
      >
        <template #name="{ row }">
          <div class="player-cell">
            <PlayerAvatar :name="row.name" :online="row.online" />
            <el-link type="primary" :underline="false" @click.stop="openPlayer(row.uuid)">
              {{ row.name }}
            </el-link>
          </div>
        </template>
        <template #uuid="{ row }">
          <span class="kp-mono uuid">{{ row.uuid }}</span>
        </template>
        <template #status="{ row }">
          <el-tag :type="row.online ? 'success' : 'info'" size="small" effect="light" disable-transitions>
            {{ row.online ? '在线' : '离线' }}
          </el-tag>
        </template>
        <template #location="{ row }">
          <template v-if="row.online && row.world">
            <span class="kp-mono">
              {{ row.world }} {{ row.x.toFixed(1) }}, {{ row.y.toFixed(1) }}, {{ row.z.toFixed(1) }}
            </span>
          </template>
          <span v-else class="kp-text-muted">—</span>
        </template>
        <template #playtime="{ row }">
          {{ formatDuration(row.playtimeSeconds, '—') }}
        </template>
        <template #firstPlayed="{ row }">
          <span :title="formatTime(row.firstPlayed)">{{ formatRelative(row.firstPlayed) }}</span>
        </template>
        <template #lastSeen="{ row }">
          <span :title="formatTime(row.lastSeen)">{{ formatRelative(row.lastSeen) }}</span>
        </template>
      </DataTable>
    </el-card>
  </div>
</template>

<style scoped>
.player-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.uuid {
  font-size: 12px;
}
</style>
