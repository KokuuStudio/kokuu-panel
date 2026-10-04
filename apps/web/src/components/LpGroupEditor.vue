<script setup lang="ts">
/**
 * LuckPerms 组编辑器（权限 / 父组 / 权重 / 前后缀）。
 *
 * 所有写操作都返回 `{ changed }`：`false` 表示「本来就是这个值」。
 * 这里统一走 reportChanged → 提示「无需修改」，而不是永远报「已修改」。
 * （审计表记的也是「无需修改」，前端提示与审计必须一致。）
 */
import { Plus } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { computed, ref, watch } from 'vue';

import { luckpermsApi } from '@/api/endpoints';
import { describeApiError, toApiError } from '@/api/client';
import type { LpGroup, LpPermission } from '@/api/types';
import { reportChanged } from '@/composables/useMutation';
import { useAuthStore } from '@/stores/auth';
import { PERMISSIONS } from '@/utils/permissions';

const props = defineProps<{
  nodeId: string;
  group: LpGroup;
  /** 该节点上的全部组名，用于父组选择。 */
  allGroups: string[];
}>();

const emit = defineEmits<{ changed: [message: string] }>();

const auth = useAuthStore();
const canManage = computed(() => auth.hasPerm(PERMISSIONS.luckpermsManage));
const busy = ref('');

const allGroupNames = computed(() => {
  const names = new Set(props.allGroups);
  names.add(props.group.name);
  return [...names].sort();
});

const parentCandidates = computed(() =>
  allGroupNames.value.filter((name) => name !== props.group.name && !(props.group.parents ?? []).includes(name)),
);

// ── 权限 ────────────────────────────────────────────────────

const newPermission = ref('');
const newPermissionValue = ref(true);

async function setPermission(permission: string, value: boolean | null): Promise<void> {
  busy.value = `perm:${permission}`;
  try {
    const result = await luckpermsApi.setGroupPermission(props.nodeId, props.group.name, permission, value);
    reportChanged(
      result?.changed,
      value === null ? `已删除权限 ${permission}` : `权限 ${permission} 已设为 ${String(value)}`,
    );
    emit('changed', 'permission');
  } catch (cause) {
    ElMessage.error(describeApiError(toApiError(cause)));
  } finally {
    busy.value = '';
  }
}

async function addPermission(): Promise<void> {
  const key = newPermission.value.trim();
  if (!key) {
    ElMessage.warning('请输入权限节点，例如 essentials.fly');
    return;
  }
  await setPermission(key, newPermissionValue.value);
  newPermission.value = '';
}

// ── 父组 ────────────────────────────────────────────────────

const newParent = ref('');

async function changeParent(parent: string, add: boolean): Promise<void> {
  if (!parent) {
    ElMessage.warning('请选择父组');
    return;
  }
  busy.value = `parent:${parent}`;
  try {
    const result = await luckpermsApi.setGroupParent(props.nodeId, props.group.name, parent, add);
    reportChanged(result?.changed, add ? `已添加父组 ${parent}` : `已移除父组 ${parent}`);
    emit('changed', 'parent');
  } catch (cause) {
    ElMessage.error(describeApiError(toApiError(cause)));
  } finally {
    busy.value = '';
  }
}

// ── 权重 / 元数据 ───────────────────────────────────────────

const weight = ref(props.group.weight ?? 0);
const prefix = ref(props.group.meta?.prefix ?? '');
const suffix = ref(props.group.meta?.suffix ?? '');

watch(
  () => props.group,
  (group) => {
    weight.value = group.weight ?? 0;
    prefix.value = group.meta?.prefix ?? '';
    suffix.value = group.meta?.suffix ?? '';
  },
);

async function saveWeight(): Promise<void> {
  busy.value = 'weight';
  try {
    const result = await luckpermsApi.setGroupWeight(props.nodeId, props.group.name, weight.value);
    reportChanged(result?.changed, `权重已设为 ${weight.value}`);
    emit('changed', 'weight');
  } catch (cause) {
    ElMessage.error(describeApiError(toApiError(cause)));
  } finally {
    busy.value = '';
  }
}

async function saveMeta(): Promise<void> {
  busy.value = 'meta';
  try {
    const result = await luckpermsApi.setGroupMeta(
      props.nodeId,
      props.group.name,
      prefix.value,
      suffix.value,
    );
    reportChanged(result?.changed, '前后缀已保存');
    emit('changed', 'meta');
  } catch (cause) {
    ElMessage.error(describeApiError(toApiError(cause)));
  } finally {
    busy.value = '';
  }
}

/** LP 权限节点的直接（direct）子集：继承来的不在这里展示，改也改不动。 */
const directPermissions = computed<LpPermission[]>(() =>
  (props.group.permissions ?? []).filter((item) => item.direct !== false),
);

/**
 * 父组表格的行。
 * el-table 的默认行类型是 `DefaultRow`（Element Plus 未导出该类型），
 * 直接传 `string[]` 类型对不上，所以包一层对象 —— 也顺便避免在模板里写类型断言。
 */
const parentRows = computed<Array<{ name: string }>>(() =>
  (props.group.parents ?? []).map((name) => ({ name })),
);

function parentName(row: unknown): string {
  if (typeof row === 'string') return row;
  if (row && typeof row === 'object' && 'name' in row) return String((row as { name: unknown }).name);
  return '';
}
</script>

<template>
  <div class="lp-editor">
    <el-alert
      v-if="!canManage"
      type="info"
      :closable="false"
      show-icon
      title="只读：缺少 luckperms.manage 权限，可查看但不能修改"
    />

    <el-descriptions :column="3" border size="small">
      <el-descriptions-item label="组名">
        <span class="kp-mono">{{ group.name }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="显示名">{{ group.displayName || '—' }}</el-descriptions-item>
      <el-descriptions-item label="成员数">
        <!-- userCount 可能为 null（Agent 可选实现），显示「—」而不是 0 -->
        {{ group.userCount === null || group.userCount === undefined ? '—' : group.userCount }}
      </el-descriptions-item>
    </el-descriptions>

    <el-row :gutter="16" class="lp-editor__row">
      <el-col :xs="24" :md="14">
        <el-card shadow="never" class="lp-editor__card">
          <template #header>
            <div class="card-head">
              <span>权限节点（直接 {{ directPermissions.length }} / 共 {{ (group.permissions ?? []).length }}）</span>
            </div>
          </template>

          <div v-if="canManage" class="lp-add">
            <el-input
              v-model="newPermission"
              placeholder="权限节点，例如 essentials.fly"
              class="kp-mono"
              @keyup.enter="addPermission"
            />
            <el-select v-model="newPermissionValue" style="width: 110px">
              <el-option label="true" :value="true" />
              <el-option label="false" :value="false" />
            </el-select>
            <el-button type="primary" :icon="Plus" :loading="busy.startsWith('perm:')" @click="addPermission">
              添加
            </el-button>
          </div>

          <el-table :data="group.permissions ?? []" size="small" max-height="340" empty-text="没有权限节点">
            <el-table-column label="权限" min-width="220">
              <template #default="scope">
                <span class="kp-mono">{{ (scope.row as LpPermission).key }}</span>
              </template>
            </el-table-column>
            <el-table-column label="值" width="90">
              <template #default="scope">
                <el-tag
                  :type="(scope.row as LpPermission).value ? 'success' : 'danger'"
                  size="small"
                  effect="plain"
                  disable-transitions
                >
                  {{ (scope.row as LpPermission).value ? 'true' : 'false' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="来源" width="90">
              <template #default="scope">
                <span class="kp-text-muted">
                  {{ (scope.row as LpPermission).direct === false ? '继承' : '直接' }}
                </span>
              </template>
            </el-table-column>
            <el-table-column v-if="canManage" label="操作" width="150">
              <template #default="scope">
                <el-button
                  size="small"
                  text
                  :loading="busy === `perm:${(scope.row as LpPermission).key}`"
                  @click="setPermission((scope.row as LpPermission).key, !(scope.row as LpPermission).value)"
                >
                  取反
                </el-button>
                <el-button
                  size="small"
                  text
                  type="danger"
                  :loading="busy === `perm:${(scope.row as LpPermission).key}`"
                  @click="setPermission((scope.row as LpPermission).key, null)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="10">
        <el-card shadow="never" class="lp-editor__card">
          <template #header><span>继承（父组）</span></template>

          <div v-if="canManage" class="lp-add">
            <el-select
              v-model="newParent"
              placeholder="选择父组"
              filterable
              style="flex: 1 1 auto"
            >
              <el-option v-for="name in parentCandidates" :key="name" :label="name" :value="name" />
            </el-select>
            <el-button :disabled="!newParent" @click="changeParent(newParent, true)">添加</el-button>
          </div>

          <el-table
            :data="parentRows"
            size="small"
            empty-text="没有父组（顶层组）"
          >
            <el-table-column label="父组" min-width="140">
              <template #default="scope">
                <span class="kp-mono">{{ parentName(scope.row) }}</span>
              </template>
            </el-table-column>
            <el-table-column v-if="canManage" label="操作" width="90">
              <template #default="scope">
                <el-button
                  size="small"
                  text
                  type="danger"
                  :loading="busy === `parent:${parentName(scope.row)}`"
                  @click="changeParent(parentName(scope.row), false)"
                >
                  移除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" class="lp-editor__card">
          <template #header><span>权重与前后缀</span></template>
          <el-form label-width="76px" size="small">
            <el-form-item label="权重">
              <el-input-number v-model="weight" :min="0" :max="100000" :disabled="!canManage" />
              <el-button
                class="lp-inline-btn"
                type="primary"
                plain
                :disabled="!canManage"
                :loading="busy === 'weight'"
                @click="saveWeight"
              >
                保存权重
              </el-button>
            </el-form-item>
            <el-form-item label="前缀">
              <el-input v-model="prefix" :disabled="!canManage" placeholder="[VIP] " />
            </el-form-item>
            <el-form-item label="后缀">
              <el-input v-model="suffix" :disabled="!canManage" placeholder="" />
            </el-form-item>
            <el-form-item>
              <el-button
                type="primary"
                :disabled="!canManage"
                :loading="busy === 'meta'"
                @click="saveMeta"
              >
                保存前后缀
              </el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.lp-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lp-editor__row {
  row-gap: 12px;
}

.lp-editor__card {
  height: 100%;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.lp-add {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.lp-inline-btn {
  margin-left: 10px;
}
</style>
