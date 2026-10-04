<script setup lang="ts">
/**
 * 后台账号列表。
 *
 * ⚠️ docs/API.md **没有定义**账号管理接口（只在 packages/protocol 里有
 * `account.manage` 权限点）。这里按与其他资源一致的命名习惯做了最保守的推断
 * （`/accounts`），并在页面上明确提示，避免被误当成已确认契约。
 * 后端实现后只需改 `api/endpoints.ts` 的 `accountsApi`。
 */
import { Plus, Refresh } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';

import { accountsApi } from '@/api/endpoints';
import { describeApiError, toApiError } from '@/api/client';
import type { AccountEntry, PageResult, Role } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import PageHeader from '@/components/PageHeader.vue';
import type { DataTableColumn } from '@/components/DataTable.vue';
import { runMutation } from '@/composables/useMutation';
import { useAuthStore } from '@/stores/auth';
import { PERMISSION_LABELS, ROLE_LABELS, roleLabel } from '@/utils/permissions';
import { formatRelative, formatTime } from '@/utils/format';

const auth = useAuthStore();

const ROLES: Role[] = ['owner', 'admin', 'moderator', 'viewer'];

const page = ref(1);
const size = ref(20);
const keyword = ref('');
const pageData = ref<PageResult<AccountEntry>>({ items: [], total: 0, page: 1, size: 20 });
const loading = ref(false);
const error = ref('');

const rows = computed(() => pageData.value.items ?? []);
const total = computed(() => pageData.value.total ?? rows.value.length);

const columns: DataTableColumn[] = [
  { key: 'username', label: '用户名', minWidth: 160, slot: 'username' },
  { key: 'role', label: '角色', width: 130, slot: 'role' },
  { key: 'enabled', label: '状态', width: 110, slot: 'enabled' },
  { key: 'createdAt', label: '创建时间', width: 180, slot: 'createdAt' },
  { key: 'lastLoginAt', label: '最后登录', width: 180, slot: 'lastLoginAt' },
  { key: 'actions', label: '操作', width: 150, fixed: 'right', slot: 'actions' },
];

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await accountsApi.list({
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

function search(): void {
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

// ── 新建 / 编辑 ─────────────────────────────────────────────

const dialogVisible = ref(false);
const editing = ref<AccountEntry | null>(null);
const submitting = ref(false);
const form = reactive({ username: '', password: '', role: 'viewer' as Role, enabled: true });

function openCreate(): void {
  editing.value = null;
  form.username = '';
  form.password = '';
  form.role = 'viewer';
  form.enabled = true;
  dialogVisible.value = true;
}

function openEdit(row: AccountEntry): void {
  editing.value = row;
  form.username = row.username;
  form.password = '';
  form.role = row.role;
  form.enabled = row.enabled !== false;
  dialogVisible.value = true;
}

async function submit(): Promise<void> {
  if (!form.username.trim()) {
    ElMessage.warning('请输入用户名');
    return;
  }
  if (!editing.value && !form.password) {
    ElMessage.warning('请设置初始密码');
    return;
  }
  submitting.value = true;
  try {
    if (editing.value) {
      await accountsApi.patch(editing.value.id, {
        role: form.role,
        enabled: form.enabled,
        ...(form.password ? { password: form.password } : {}),
      });
      ElMessage.success('账号已更新');
    } else {
      await accountsApi.create({
        username: form.username.trim(),
        password: form.password,
        role: form.role,
      });
      ElMessage.success('账号已创建');
    }
    dialogVisible.value = false;
    await load();
  } catch (cause) {
    ElMessage.error(describeApiError(toApiError(cause)));
  } finally {
    submitting.value = false;
  }
}

async function removeAccount(row: AccountEntry): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除后台账号「${row.username}」？该账号会立即失去所有访问权限。`, '删除账号', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
    });
  } catch {
    return;
  }
  const ok = await runMutation(() => accountsApi.remove(row.id), {
    success: `账号 ${row.username} 已删除`,
    action: 'accounts.remove',
  });
  if (ok !== null) await load();
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="kp-page">
    <PageHeader title="后台账号" subtitle="登录平台控制台的账号与角色">
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建账号</el-button>
      </template>
    </PageHeader>

    <el-alert type="warning" :closable="false" show-icon title="接口契约未在 docs/API.md 中定义">
      <template #default>
        <p style="margin: 0">
          API 文档里没有账号管理这一组接口（只有协议包中的
          <code class="kp-inline-code">account.manage</code> 权限点）。本页按
          <code class="kp-inline-code">GET/POST /_api/accounts</code>、
          <code class="kp-inline-code">PATCH/DELETE /_api/accounts/:id</code> 的推断实现；
          后端落地后如路径不同，只需改前端一处（<code class="kp-inline-code">api/endpoints.ts</code>）。
        </p>
      </template>
    </el-alert>

    <el-card shadow="never">
      <div class="kp-filter-form">
        <el-input
          v-model="keyword"
          placeholder="按用户名搜索"
          clearable
          style="width: 220px"
          @keyup.enter="search"
          @clear="search"
        />
        <el-button type="primary" @click="search">查询</el-button>
        <span class="kp-text-muted">当前账号：{{ auth.account?.username }}（{{ roleLabel(auth.account?.role) }}）</span>
      </div>
    </el-card>

    <el-card shadow="never">
      <DataTable
        :columns="columns"
        :rows="rows"
        :loading="loading"
        :error="error"
        empty-text="还没有后台账号"
        row-key="id"
        :total="total"
        :page="page"
        :size="size"
        @retry="load"
        @update:page="onPageChange"
        @update:size="onSizeChange"
      >
        <template #username="{ row }">
          <strong>{{ row.username }}</strong>
          <el-tag v-if="row.id === auth.account?.id" size="small" type="success" effect="plain" class="self" disable-transitions>
            当前登录
          </el-tag>
        </template>
        <template #role="{ row }">
          <el-tag size="small" effect="plain" disable-transitions>{{ roleLabel(row.role) }}</el-tag>
        </template>
        <template #enabled="{ row }">
          <el-tag
            :type="row.enabled === false ? 'info' : 'success'"
            size="small"
            effect="light"
            disable-transitions
          >
            {{ row.enabled === false ? '已禁用' : '正常' }}
          </el-tag>
        </template>
        <template #createdAt="{ row }">{{ formatTime(row.createdAt) }}</template>
        <template #lastLoginAt="{ row }">
          <span v-if="row.lastLoginAt" :title="formatTime(row.lastLoginAt)">
            {{ formatRelative(row.lastLoginAt) }}
          </span>
          <span v-else class="kp-text-muted">从未登录</span>
        </template>
        <template #actions="{ row }">
          <el-button size="small" text type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button
            size="small"
            text
            type="danger"
            :disabled="row.id === auth.account?.id"
            @click="removeAccount(row)"
          >
            删除
          </el-button>
        </template>
      </DataTable>
    </el-card>

    <el-dialog
      v-model="dialogVisible"
      :title="editing ? `编辑账号 ${editing.username}` : '新建后台账号'"
      width="480px"
    >
      <el-form label-width="92px">
        <el-form-item label="用户名">
          <el-input v-model="form.username" :disabled="Boolean(editing)" placeholder="用户名" />
        </el-form-item>
        <el-form-item :label="editing ? '重置密码' : '初始密码'">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            :placeholder="editing ? '留空表示不修改' : '至少 8 位'"
          />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width: 100%">
            <el-option v-for="role in ROLES" :key="role" :label="ROLE_LABELS[role] ?? role" :value="role" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="editing" label="启用">
          <el-switch v-model="form.enabled" />
        </el-form-item>
      </el-form>

      <el-alert type="info" :closable="false" class="role-hint">
        <template #title>角色的权限点（只读参考）</template>
        <template #default>
          <div class="perm-list">
            <span v-for="(label, key) in PERMISSION_LABELS" :key="key" class="perm">
              {{ label }}
            </span>
          </div>
          <p style="margin: 8px 0 0">
            实际生效的权限以服务端返回的 <code class="kp-inline-code">account.permissions</code> 为准，
            前端不按角色名判断。
          </p>
        </template>
      </el-alert>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">
          {{ editing ? '保存' : '创建' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.self {
  margin-left: 6px;
}

.role-hint {
  margin-top: 6px;
}

.perm-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.perm {
  font-size: 12px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--el-fill-color);
}
</style>
