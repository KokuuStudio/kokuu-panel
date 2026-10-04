<script setup lang="ts">
/**
 * 节点列表 + 新建 / 编辑 / 删除 / 轮换密钥。
 *
 * 密钥相关（docs/API.md）：
 * - `POST /nodes` 与 `POST /nodes/:id/rotate-secret` 的响应里带 `secret`，**只此一次**；
 * - 库里只存 scrypt 哈希，找不回来。
 * 所以两者都必须走 SecretDialog，并且明确警告「关闭后无法再查看」。
 */
import { Plus, Refresh, RefreshRight, Search } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { nodesApi } from '@/api/endpoints';
import { describeApiError, toApiError } from '@/api/client';
import type { NodeCreatePayload, NodeStatus, NodeSummary } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import PageHeader from '@/components/PageHeader.vue';
import SecretDialog from '@/components/SecretDialog.vue';
import type { DataTableColumn } from '@/components/DataTable.vue';
import { runMutation } from '@/composables/useMutation';
import { useAuthStore } from '@/stores/auth';
import { useNodesStore } from '@/stores/nodes';
import { PERMISSIONS } from '@/utils/permissions';
import { formatNumber, formatRelative } from '@/utils/format';

/** 与 docs/API.md 一致：`id` 只允许 `^[a-z0-9][a-z0-9_-]{1,63}$`。 */
const NODE_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

const router = useRouter();
const auth = useAuthStore();
const nodesStore = useNodesStore();

const canManage = computed(() => auth.hasPerm(PERMISSIONS.nodeManage));

const keyword = ref('');
const statusFilter = ref<NodeStatus | ''>('');

const rows = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return nodesStore.nodes.filter((node) => {
    if (statusFilter.value && node.status !== statusFilter.value) return false;
    if (!kw) return true;
    return (
      node.id.toLowerCase().includes(kw) ||
      node.name.toLowerCase().includes(kw) ||
      node.tags.some((tag) => tag.toLowerCase().includes(kw))
    );
  });
});

const columns: DataTableColumn[] = [
  { key: 'name', label: '名称', minWidth: 160, slot: 'name' },
  { key: 'id', label: '节点 ID', minWidth: 150, slot: 'id' },
  { key: 'status', label: '状态', width: 100, slot: 'status' },
  { key: 'onlinePlayers', label: '人数', width: 110, slot: 'players' },
  { key: 'version', label: '服务端', minWidth: 150, slot: 'version' },
  { key: 'tags', label: '标签', minWidth: 140, slot: 'tags' },
  { key: 'lastSeenAt', label: '上次心跳', width: 130, slot: 'lastSeen' },
  { key: 'actions', label: '操作', width: 250, fixed: 'right', slot: 'actions' },
];

// ── 新建 / 编辑 ─────────────────────────────────────────────

const formVisible = ref(false);
const formMode = ref<'create' | 'edit'>('create');
const submitting = ref(false);
const formRef = ref<{ validate: () => Promise<boolean> } | null>(null);

interface NodeForm {
  id: string;
  name: string;
  tags: string[];
  enabled: boolean;
}

const form = reactive<NodeForm>({ id: '', name: '', tags: [], enabled: true });
const tagInput = ref('');
const editingId = ref('');

const formRules = {
  id: [
    { required: true, message: '请输入节点 ID', trigger: 'blur' },
    {
      validator: (_rule: unknown, value: string, callback: (error?: Error) => void) => {
        if (!value) return callback();
        if (!NODE_ID_RE.test(value)) {
          callback(new Error('只允许小写字母、数字、下划线、连字符，2–64 位，且不能以符号开头'));
          return;
        }
        callback();
      },
      trigger: 'blur',
    },
  ],
  name: [{ required: true, message: '请输入节点名称', trigger: 'blur' }],
};

function openCreate(): void {
  formMode.value = 'create';
  editingId.value = '';
  form.id = '';
  form.name = '';
  form.tags = [];
  form.enabled = true;
  tagInput.value = '';
  formVisible.value = true;
}

function openEdit(node: NodeSummary): void {
  formMode.value = 'edit';
  editingId.value = node.id;
  form.id = node.id;
  form.name = node.name;
  form.tags = [...node.tags];
  form.enabled = node.enabled;
  tagInput.value = '';
  formVisible.value = true;
}

function addTag(): void {
  const value = tagInput.value.trim();
  if (!value) return;
  if (!form.tags.includes(value)) form.tags.push(value);
  tagInput.value = '';
}

function removeTag(tag: string): void {
  form.tags = form.tags.filter((item) => item !== tag);
}

async function submitForm(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  submitting.value = true;
  try {
    if (formMode.value === 'create') {
      const payload: NodeCreatePayload = {
        id: form.id.trim(),
        name: form.name.trim(),
        tags: [...form.tags],
      };
      const result = await nodesApi.create(payload);
      formVisible.value = false;
      if (result?.secret) {
        secretNodeId.value = result.node?.id ?? payload.id;
        secretNodeName.value = result.node?.name ?? payload.name;
        secretValue.value = result.secret;
        secretTitle.value = '节点创建成功 —— 密钥（仅显示一次）';
        secretVisible.value = true;
      } else {
        // 后端没回 secret 说明实现与文档不一致，明确告知而不是静默放过。
        ElMessage.warning('节点已创建，但响应里没有 secret 字段（与 docs/API.md 不一致），请联系后端确认');
      }
      ElMessage.success(`节点 ${payload.id} 已创建`);
    } else {
      await nodesApi.patch(editingId.value, {
        name: form.name.trim(),
        tags: [...form.tags],
        enabled: form.enabled,
      });
      ElMessage.success('节点已更新');
      formVisible.value = false;
    }
    await nodesStore.refresh();
  } catch (cause) {
    ElMessage.error(describeApiError(toApiError(cause)));
  } finally {
    submitting.value = false;
  }
}

// ── 删除 / 轮换 ─────────────────────────────────────────────

const secretVisible = ref(false);
const secretValue = ref('');
const secretNodeId = ref('');
const secretNodeName = ref('');
const secretTitle = ref('节点密钥（仅显示一次）');

async function removeNode(node: NodeSummary): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除节点「${node.name}」（${node.id}）后，该节点的 Agent 会立即失去连接，历史数据保留。此操作不可撤销。`,
      '删除节点',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' },
    );
  } catch {
    return;
  }
  const ok = await runMutation(() => nodesApi.remove(node.id), {
    success: `节点 ${node.id} 已删除`,
    action: 'nodes.remove',
  });
  if (ok !== null) await nodesStore.refresh();
}

async function rotateSecret(node: NodeSummary): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `轮换「${node.name}」的密钥后，旧密钥立即失效，该节点当前连接会断开，需要在服务端更新 config.yml。`,
      '轮换密钥',
      { type: 'warning', confirmButtonText: '轮换', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  const result = await runMutation(() => nodesApi.rotateSecret(node.id), {
    action: 'nodes.rotateSecret',
    silentError: false,
  });
  if (!result) return;
  if (result.secret) {
    secretNodeId.value = node.id;
    secretNodeName.value = node.name;
    secretValue.value = result.secret;
    secretTitle.value = '密钥已轮换 —— 新密钥（仅显示一次）';
    secretVisible.value = true;
  } else {
    ElMessage.warning('轮换成功，但响应里没有 secret 字段（与 docs/API.md 不一致）');
  }
}

async function toggleEnabled(node: NodeSummary): Promise<void> {
  const ok = await runMutation(() => nodesApi.patch(node.id, { enabled: !node.enabled }), {
    success: node.enabled ? `节点 ${node.id} 已停用` : `节点 ${node.id} 已启用`,
    action: 'nodes.toggleEnabled',
  });
  if (ok !== null) await nodesStore.refresh();
}

onMounted(() => {
  void nodesStore.refreshQuietly();
});

function openDetail(nodeId: string): void {
  void router.push({ name: 'node-detail', params: { id: nodeId } });
}
</script>

<template>
  <div class="kp-page">
    <PageHeader title="节点管理" subtitle="每个节点是一台 MC 服务端；Agent 主动外连，无需开放入站端口">
      <template #actions>
        <el-button :icon="Refresh" :loading="nodesStore.loading" @click="nodesStore.refresh()">
          刷新
        </el-button>
        <el-button v-if="canManage" type="primary" :icon="Plus" @click="openCreate">新建节点</el-button>
      </template>
    </PageHeader>

    <el-card shadow="never">
      <div class="kp-filter-form">
        <el-input
          v-model="keyword"
          :prefix-icon="Search"
          placeholder="按名称 / ID / 标签搜索"
          clearable
          style="width: 260px"
        />
        <el-select v-model="statusFilter" placeholder="全部状态" clearable style="width: 150px">
          <el-option label="在线" value="online" />
          <el-option label="离线" value="offline" />
          <el-option label="已停用" value="disabled" />
        </el-select>
        <span class="kp-text-muted">共 {{ rows.length }} 个节点</span>
      </div>
    </el-card>

    <el-card shadow="never">
      <DataTable
        :columns="columns"
        :rows="rows"
        :loading="nodesStore.loading"
        :error="nodesStore.error"
        empty-text="没有匹配的节点"
        row-key="id"
        :show-pager="false"
        @retry="nodesStore.refresh()"
      >
        <template #name="{ row }">
          <el-link type="primary" :underline="false" @click="openDetail(row.id)">
            {{ row.name }}
          </el-link>
        </template>

        <template #id="{ row }">
          <span class="kp-mono">{{ row.id }}</span>
        </template>

        <template #status="{ row }">
          <el-tag
            :type="row.enabled === false ? 'info' : row.status === 'online' ? 'success' : 'danger'"
            size="small"
            effect="light"
            disable-transitions
          >
            <span
              class="kp-dot"
              :class="`kp-dot--${row.enabled === false ? 'disabled' : row.status}`"
            />
            {{ row.enabled === false ? '已停用' : row.status === 'online' ? '在线' : '离线' }}
          </el-tag>
        </template>

        <template #players="{ row }">
          <span v-if="row.status === 'online'">
            {{ formatNumber(row.onlinePlayers) }}
            <span class="kp-text-muted">/ {{ formatNumber(row.maxPlayers) }}</span>
          </span>
          <span v-else class="kp-text-muted">—</span>
        </template>

        <template #version="{ row }">
          <span v-if="row.mcVersion">{{ row.brand ?? 'MC' }} {{ row.mcVersion }}</span>
          <span v-else class="kp-text-muted">—</span>
          <div v-if="row.agentVersion" class="kp-text-muted agent-ver">
            Agent {{ row.agentVersion }}
          </div>
        </template>

        <template #tags="{ row }">
          <template v-if="row.tags.length">
            <el-tag
              v-for="tag in row.tags"
              :key="tag"
              size="small"
              effect="plain"
              class="tag"
              disable-transitions
            >
              {{ tag }}
            </el-tag>
          </template>
          <span v-else class="kp-text-muted">—</span>
        </template>

        <template #lastSeen="{ row }">
          <span :title="row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : ''">
            {{ formatRelative(row.lastSeenAt) }}
          </span>
        </template>

        <template #actions="{ row }">
          <el-button size="small" text type="primary" @click="openDetail(row.id)">详情</el-button>
          <template v-if="canManage">
            <el-button size="small" text @click="openEdit(row)">编辑</el-button>
            <el-button size="small" text @click="toggleEnabled(row)">
              {{ row.enabled ? '停用' : '启用' }}
            </el-button>
            <el-button size="small" text :icon="RefreshRight" @click="rotateSecret(row)">
              轮换密钥
            </el-button>
            <el-button size="small" text type="danger" @click="removeNode(row)">删除</el-button>
          </template>
        </template>
      </DataTable>
    </el-card>

    <!-- 新建 / 编辑 -->
    <el-dialog
      v-model="formVisible"
      :title="formMode === 'create' ? '新建节点' : `编辑节点 ${editingId}`"
      width="520px"
      :close-on-click-modal="false"
    >
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="88px">
        <el-form-item label="节点 ID" prop="id">
          <el-input
            v-model="form.id"
            :disabled="formMode === 'edit'"
            placeholder="survival-01"
            class="kp-mono"
          />
          <div class="form-hint kp-text-muted">
            小写字母 / 数字 / 下划线 / 连字符，2–64 位。创建后不可修改，Agent 的 config.yml 要填这个值。
          </div>
        </el-form-item>
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" placeholder="生存服" maxlength="64" />
        </el-form-item>
        <el-form-item label="标签">
          <div class="tags-editor">
            <el-tag
              v-for="tag in form.tags"
              :key="tag"
              closable
              size="small"
              @close="removeTag(tag)"
            >
              {{ tag }}
            </el-tag>
            <el-input
              v-model="tagInput"
              size="small"
              placeholder="输入后回车添加"
              style="width: 170px"
              @keyup.enter="addTag"
            />
          </div>
        </el-form-item>
        <el-form-item v-if="formMode === 'edit'" label="启用">
          <el-switch v-model="form.enabled" active-text="启用" inactive-text="停用" />
          <div class="form-hint kp-text-muted">停用后平台会拒绝该节点的 Agent 连接（NODE_DISABLED）。</div>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ formMode === 'create' ? '创建' : '保存' }}
        </el-button>
      </template>
    </el-dialog>

    <SecretDialog
      v-model="secretVisible"
      :node-id="secretNodeId"
      :node-name="secretNodeName"
      :secret="secretValue"
      :title="secretTitle"
    />
  </div>
</template>

<style scoped>
.agent-ver {
  font-size: 12px;
}

.tag {
  margin-right: 4px;
}

.tags-editor {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.form-hint {
  font-size: 12px;
  line-height: 1.5;
  margin-top: 4px;
}
</style>
