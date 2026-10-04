<script setup lang="ts">
/**
 * LuckPerms：选节点 → 组列表 → 组详情编辑（权限 / 父组 / 权重 / 前后缀）+ 新建 / 删除组。
 *
 * LuckPerms 是**每个服务端各自的数据**，所以一切操作都必须先选节点；
 * 节点没声明 `luckperms` 能力时（服务端没装 LuckPerms）连请求都不发，
 * 直接提示 —— 而不是让用户等一个 10 秒超时。
 */
import { Delete, Plus, Refresh } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { luckpermsApi } from '@/api/endpoints';
import { describeApiError, toApiError } from '@/api/client';
import type { LpGroup } from '@/api/types';
import LpGroupEditor from '@/components/LpGroupEditor.vue';
import PageHeader from '@/components/PageHeader.vue';
import { reportChanged, runMutation } from '@/composables/useMutation';
import { useAuthStore } from '@/stores/auth';
import { useNodesStore } from '@/stores/nodes';
import { PERMISSIONS } from '@/utils/permissions';
import { toLpGroupArray } from '@/utils/format';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const nodesStore = useNodesStore();

const canManage = computed(() => auth.hasPerm(PERMISSIONS.luckpermsManage));

const nodeId = ref(typeof route.query.node === 'string' ? route.query.node : '');
const groups = ref<LpGroup[]>([]);
const loading = ref(false);
const error = ref('');
const selectedName = ref('');

const selectedGroup = computed(() => groups.value.find((group) => group.name === selectedName.value) ?? null);
const currentGroupNames = computed(() => groups.value.map((group) => group.name));
const selectedNode = computed(() => nodesStore.findNode(nodeId.value));

/** 节点没装 LuckPerms 时平台会给 NO_LUCKPERMS，前端提前拦住更省时间。 */
const nodeMissingLuckperms = computed(
  () => Boolean(nodeId.value) && Boolean(selectedNode.value) && !(selectedNode.value?.capabilities ?? []).includes('luckperms'),
);

async function loadGroups(): Promise<void> {
  if (!nodeId.value) {
    groups.value = [];
    return;
  }
  loading.value = true;
  error.value = '';
  selectedName.value = '';
  try {
    const result = await luckpermsApi.groups(nodeId.value);
    groups.value = toLpGroupArray<LpGroup>(result);
    // 默认选中：权重最高的组（通常是 default 之上的管理组）或第一个。
    const sorted = [...groups.value].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    selectedName.value = sorted[0]?.name ?? '';
  } catch (cause) {
    groups.value = [];
    error.value = describeApiError(toApiError(cause));
  } finally {
    loading.value = false;
  }
}

const createVisible = ref(false);
const newGroupName = ref('');
const creating = ref(false);

async function createGroup(): Promise<void> {
  const name = newGroupName.value.trim();
  if (!name) {
    ElMessage.warning('请输入组名');
    return;
  }
  if (groups.value.some((group) => group.name === name)) {
    ElMessage.warning(`组 ${name} 已存在`);
    return;
  }
  creating.value = true;
  try {
    const result = await luckpermsApi.createGroup(nodeId.value, name);
    reportChanged(result?.changed, `组 ${name} 已创建`, `组 ${name} 本来就存在（无需修改）`);
    createVisible.value = false;
    newGroupName.value = '';
    await loadGroups();
    selectedName.value = name;
  } catch (cause) {
    ElMessage.error(describeApiError(toApiError(cause)));
  } finally {
    creating.value = false;
  }
}

async function deleteGroup(group: LpGroup): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除组「${group.name}」会把它从所有玩家身上移除继承关系${
        group.userCount ? `（当前约 ${group.userCount} 名成员）` : ''
      }。此操作不可撤销。`,
      '删除权限组',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' },
    );
  } catch {
    return;
  }
  const result = await runMutation(() => luckpermsApi.deleteGroup(nodeId.value, group.name), {
    action: 'luckperms.deleteGroup',
  });
  if (!result) return;
  reportChanged(result.changed, `组 ${group.name} 已删除`, `组 ${group.name} 本来就不存在（无需修改）`);
  await loadGroups();
}

function onEditorChanged(): void {
  void loadGroups();
}

onMounted(async () => {
  await nodesStore.refreshQuietly();
  if (!nodeId.value) {
    nodeId.value = nodesStore.luckpermsNodes[0]?.id ?? nodesStore.nodes[0]?.id ?? '';
  }
  await loadGroups();
});

watch(nodeId, async (value) => {
  void router.replace({ query: { ...route.query, node: value || undefined } });
  await loadGroups();
});
</script>

<template>
  <div class="kp-page">
    <PageHeader
      title="权限组"
      subtitle="LuckPerms 数据按节点独立；先选节点，再管理该节点上的组"
    >
      <template #actions>
        <el-select v-model="nodeId" placeholder="选择节点" filterable style="width: 240px">
          <el-option
            v-for="node in nodesStore.nodes"
            :key="node.id"
            :label="`${node.name}（${node.id}）`"
            :value="node.id"
          />
        </el-select>
        <el-button :icon="Refresh" :loading="loading" :disabled="!nodeId" @click="loadGroups">
          刷新
        </el-button>
        <el-button
          v-if="canManage"
          type="primary"
          :icon="Plus"
          :disabled="!nodeId"
          @click="createVisible = true"
        >
          新建组
        </el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="nodesStore.nodes.length === 0 && !nodesStore.loading"
      type="warning"
      :closable="false"
      show-icon
      title="还没有节点"
      description="LuckPerms 操作需要指定节点，请先在「节点管理」创建节点并接入 Agent。"
    />
    <el-alert
      v-else-if="nodeMissingLuckperms"
      type="warning"
      :closable="false"
      show-icon
      title="该节点未声明 luckperms 能力"
      :description="`节点 ${selectedNode?.name ?? nodeId} 的 Agent 没有上报 luckperms 能力（服务端未安装 LuckPerms 或版本不兼容），平台不会向它发起权限查询。`"
      data-testid="no-luckperms"
    />

    <div class="lp-layout">
      <el-card shadow="never" class="lp-list">
        <template #header>
          <div class="card-head">
            <span>组（{{ groups.length }}）</span>
          </div>
        </template>

        <el-alert
          v-if="error"
          type="error"
          :closable="false"
          show-icon
          :title="error"
          data-testid="lp-groups-error"
        >
          <template #default>
            <el-button size="small" type="primary" plain @click="loadGroups">重试</el-button>
          </template>
        </el-alert>

        <el-skeleton v-else-if="loading && groups.length === 0" :rows="5" animated />
        <el-empty
          v-else-if="groups.length === 0"
          :description="nodeId ? '该节点上没有权限组' : '请先选择节点'"
          :image-size="70"
        />
        <ul v-else class="group-list">
          <li
            v-for="group in groups"
            :key="group.name"
            class="group-item"
            :class="{ 'group-item--active': group.name === selectedName }"
            @click="selectedName = group.name"
          >
            <div class="group-item__main">
              <span class="kp-mono group-item__name">{{ group.name }}</span>
              <span v-if="group.displayName && group.displayName !== group.name" class="kp-text-muted">
                {{ group.displayName }}
              </span>
            </div>
            <div class="group-item__meta">
              <el-tag size="small" effect="plain" disable-transitions>权重 {{ group.weight ?? 0 }}</el-tag>
              <el-tag size="small" effect="plain" type="info" disable-transitions>
                {{ group.userCount === null || group.userCount === undefined ? '成员 —' : `成员 ${group.userCount}` }}
              </el-tag>
              <el-button
                v-if="canManage"
                size="small"
                text
                type="danger"
                :icon="Delete"
                @click.stop="deleteGroup(group)"
              />
            </div>
          </li>
        </ul>
      </el-card>

      <div class="lp-detail">
        <el-card v-if="selectedGroup && nodeId" shadow="never">
          <LpGroupEditor
            :node-id="nodeId"
            :group="selectedGroup"
            :all-groups="currentGroupNames"
            @changed="onEditorChanged"
          />
        </el-card>
        <el-card v-else shadow="never">
          <el-empty description="从左侧选择一个组查看详情" :image-size="80" />
        </el-card>
      </div>
    </div>

    <el-dialog v-model="createVisible" title="新建权限组" width="440px">
      <el-form label-width="72px">
        <el-form-item label="组名">
          <el-input v-model="newGroupName" placeholder="vip" class="kp-mono" @keyup.enter="createGroup" />
        </el-form-item>
      </el-form>
      <div class="kp-text-muted dialog-hint">
        组名即 LuckPerms 内部名，创建后不建议改名（改名要重建继承关系）。
      </div>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="createGroup">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.lp-layout {
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  gap: var(--kp-gap);
  align-items: start;
}

@media (max-width: 1000px) {
  .lp-layout {
    grid-template-columns: 1fr;
  }
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.group-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 62vh;
  overflow: auto;
}

.group-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--kp-border);
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.group-item:hover {
  background: var(--el-fill-color-light);
}

.group-item--active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.group-item__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.group-item__name {
  font-weight: 600;
}

.group-item__meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.dialog-hint {
  padding: 0 4px;
  font-size: 12px;
}
</style>
