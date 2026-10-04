<script setup lang="ts">
/**
 * 新建封禁 / 禁言对话框。Punishments 页与玩家详情页共用。
 *
 * 重点（docs/API.md「建封禁是一个跨系统动作」）：
 * 响应里的 `dispatched` 是各节点下发结果，**失败的节点必须显式展示**。
 * 节点下发失败不影响封禁生效（平台是权威，记录已落库），
 * 所以这里既不能说「失败」，也不能静默吞掉 —— 必须说清「已记录，但这几个节点没生效」。
 */
import { ElMessage } from 'element-plus';
import { computed, reactive, ref, watch } from 'vue';

import { punishmentsApi } from '@/api/endpoints';
import { describeApiError, toApiError } from '@/api/client';
import type { PunishmentCreateResponse, PunishmentDispatchResult, PunishmentType } from '@/api/types';
import { useAuthStore } from '@/stores/auth';
import { useNodesStore } from '@/stores/nodes';
import { PERMISSIONS } from '@/utils/permissions';
import { formatDuration } from '@/utils/format';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 预填玩家（从玩家详情页发起时传）。 */
    playerUuid?: string;
    playerName?: string;
    /** 预填节点（从节点页发起时传）。 */
    nodeId?: string | null;
  }>(),
  { playerUuid: '', playerName: '', nodeId: null },
);

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  /** 创建成功；父组件据此刷新列表。 */
  created: [result: PunishmentCreateResponse];
}>();

const auth = useAuthStore();
const nodesStore = useNodesStore();

const canManage = computed(() => auth.hasPerm(PERMISSIONS.punishManage));

const DURATION_PRESETS = [
  { label: '1 小时', seconds: 3600 },
  { label: '1 天', seconds: 86400 },
  { label: '7 天', seconds: 604800 },
  { label: '30 天', seconds: 2592000 },
] as const;

const TYPES: Array<{ value: PunishmentType; label: string; hint: string }> = [
  { value: 'ban', label: '封禁', hint: '禁止登录，可跨服生效' },
  { value: 'mute', label: '禁言', hint: '保留登录，禁止发言' },
  { value: 'warn', label: '警告', hint: '仅记录并提示玩家' },
  { value: 'kick', label: '踢出', hint: '立刻踢下线，不禁止再次登录' },
];

interface FormState {
  type: PunishmentType;
  uuid: string;
  name: string;
  reason: string;
  permanent: boolean;
  durationSeconds: number;
  scopeAll: boolean;
  nodeId: string;
  kickNow: boolean;
}

const form = reactive<FormState>({
  type: 'ban',
  uuid: '',
  name: '',
  reason: '',
  permanent: false,
  durationSeconds: 86400,
  scopeAll: true,
  nodeId: '',
  kickNow: true,
});

const submitting = ref(false);
const result = ref<PunishmentCreateResponse | null>(null);

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    result.value = null;
    form.uuid = props.playerUuid ?? '';
    form.name = props.playerName ?? '';
    form.reason = '';
    form.type = 'ban';
    form.permanent = false;
    form.durationSeconds = 86400;
    form.kickNow = true;
    if (props.nodeId) {
      form.scopeAll = false;
      form.nodeId = props.nodeId;
    } else {
      form.scopeAll = true;
      form.nodeId = '';
    }
    if (!nodesStore.loaded) void nodesStore.refreshQuietly();
  },
);

const failedDispatches = computed<PunishmentDispatchResult[]>(() =>
  (result.value?.dispatched ?? []).filter((item) => !item.ok),
);

const okDispatches = computed<PunishmentDispatchResult[]>(() =>
  (result.value?.dispatched ?? []).filter((item) => item.ok),
);

/** 生效范围摘要：用于结果提示里说明「到底影响哪些服」。 */
function scopeText(): string {
  if (form.scopeAll) return '全平台（所有节点）';
  return form.nodeId ? `仅节点 ${nodesStore.nodeName(form.nodeId)}` : '未选择节点';
}

async function submit(): Promise<void> {
  if (!form.uuid.trim()) {
    ElMessage.warning('缺少玩家 UUID，请先通过玩家列表选择玩家');
    return;
  }
  if (!form.reason.trim()) {
    ElMessage.warning('请填写原因（会记入审计与玩家可见的提示）');
    return;
  }
  if (!form.scopeAll && !form.nodeId) {
    ElMessage.warning('请选择生效节点，或改为全平台');
    return;
  }
  if (!form.permanent && (!form.durationSeconds || form.durationSeconds <= 0)) {
    ElMessage.warning('时长必须大于 0，或勾选永久');
    return;
  }

  submitting.value = true;
  try {
    const response = await punishmentsApi.create({
      type: form.type,
      uuid: form.uuid.trim(),
      name: form.name.trim() || form.uuid.trim(),
      reason: form.reason.trim(),
      durationSeconds: form.permanent ? null : form.durationSeconds,
      nodeId: form.scopeAll ? null : form.nodeId,
      kickNow: form.type === 'ban' ? form.kickNow : undefined,
    });
    result.value = response;
    emit('created', response);
    // 结果里有失败节点时不用「成功」语气，避免管理员以为全服已生效。
    if (failedDispatches.value.length > 0) {
      ElMessage.warning(`已记录，但有 ${failedDispatches.value.length} 个节点下发失败，请查看下方明细`);
    } else {
      ElMessage.success('已创建并下发');
    }
  } catch (cause) {
    ElMessage.error(describeApiError(toApiError(cause)));
  } finally {
    submitting.value = false;
  }
}

function close(): void {
  visible.value = false;
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="新建封禁 / 禁言"
    width="620px"
    :close-on-click-modal="false"
    @closed="result = null"
  >
    <el-alert
      v-if="!canManage"
      type="warning"
      :closable="false"
      show-icon
      title="缺少 punish.manage 权限"
      description="你只能查看封禁记录，不能新建。"
    />

    <!-- 创建结果：显式展示各节点下发情况 -->
    <template v-if="result">
      <el-alert
        v-if="failedDispatches.length > 0"
        type="error"
        :closable="false"
        show-icon
        title="部分节点下发失败（封禁仍已生效并记录在案）"
        data-testid="dispatch-failed"
      >
        <template #default>
          <p style="margin: 0 0 6px">
            平台是封禁的唯一权威，记录已落库；但下面这些节点<strong>没有生效</strong>，
            玩家在那些服上仍可继续游戏，请按节点状态排查后重试或手动执行。
          </p>
          <ul class="dispatch-list">
            <li v-for="item in failedDispatches" :key="item.nodeId">
              <strong>{{ nodesStore.nodeName(item.nodeId) }}</strong>
              <span class="kp-mono">（{{ item.nodeId }}）</span>
              <el-tag size="small" type="danger" effect="plain" disable-transitions>
                {{ item.code ?? 'FAILED' }}
              </el-tag>
              <span v-if="item.message" class="kp-text-muted">{{ item.message }}</span>
            </li>
          </ul>
        </template>
      </el-alert>
      <el-alert
        v-else
        type="success"
        :closable="false"
        show-icon
        :title="
          okDispatches.length > 0
            ? `已下发到 ${okDispatches.length} 个节点`
            : '已记录（没有需要下发的在线节点）'
        "
      />

      <el-descriptions :column="1" border style="margin-top: 12px">
        <el-descriptions-item label="记录 ID">
          <span class="kp-mono">{{ result.punishment?.id ?? '—' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="类型">{{ result.punishment?.type ?? form.type }}</el-descriptions-item>
        <el-descriptions-item label="到期时间">
          {{
            result.punishment?.expiresAt
              ? new Date(result.punishment.expiresAt).toLocaleString()
              : '永久 / 不适用'
          }}
        </el-descriptions-item>
        <el-descriptions-item v-if="okDispatches.length > 0" label="成功节点">
          <el-tag
            v-for="item in okDispatches"
            :key="item.nodeId"
            size="small"
            type="success"
            effect="plain"
            class="dispatch-tag"
            disable-transitions
          >
            {{ item.nodeId }}
          </el-tag>
        </el-descriptions-item>
      </el-descriptions>
    </template>

    <el-form v-else label-width="92px" :disabled="!canManage">
      <el-form-item label="玩家">
        <el-input v-model="form.name" placeholder="玩家名" />
        <el-input v-model="form.uuid" placeholder="UUID" class="kp-mono uuid-input" />
        <div class="form-hint kp-text-muted">
          身份锚点是 UUID，改名后记录仍然跟随。UUID 决定封禁对象，名字只用于展示。
        </div>
      </el-form-item>

      <el-form-item label="类型">
        <el-radio-group v-model="form.type">
          <el-radio-button v-for="item in TYPES" :key="item.value" :value="item.value">
            {{ item.label }}
          </el-radio-button>
        </el-radio-group>
        <div class="form-hint kp-text-muted">
          {{ TYPES.find((item) => item.value === form.type)?.hint }}
        </div>
      </el-form-item>

      <el-form-item label="原因">
        <el-input
          v-model="form.reason"
          type="textarea"
          :rows="2"
          maxlength="200"
          show-word-limit
          placeholder="例：使用作弊客户端（会展示给玩家）"
        />
      </el-form-item>

      <el-form-item label="时长">
        <div class="duration">
          <el-checkbox v-model="form.permanent">永久</el-checkbox>
          <template v-if="!form.permanent">
            <el-button
              v-for="preset in DURATION_PRESETS"
              :key="preset.seconds"
              size="small"
              :type="form.durationSeconds === preset.seconds ? 'primary' : 'default'"
              @click="form.durationSeconds = preset.seconds"
            >
              {{ preset.label }}
            </el-button>
            <el-input-number
              v-model="form.durationSeconds"
              :min="1"
              :step="3600"
              controls-position="right"
              style="width: 150px"
            />
            <span class="kp-text-muted">秒</span>
          </template>
        </div>
        <div class="form-hint kp-text-muted">
          {{ form.permanent ? '永久封禁不会自动解封。' : `约 ${formatDuration(form.durationSeconds, '—')}` }}
        </div>
      </el-form-item>

      <el-form-item label="生效范围">
        <el-radio-group v-model="form.scopeAll">
          <el-radio :value="true">全平台</el-radio>
          <el-radio :value="false">指定节点</el-radio>
        </el-radio-group>
        <el-select
          v-if="!form.scopeAll"
          v-model="form.nodeId"
          placeholder="选择节点"
          filterable
          style="width: 100%; margin-top: 8px"
        >
          <el-option
            v-for="node in nodesStore.nodes"
            :key="node.id"
            :label="`${node.name}（${node.id}）`"
            :value="node.id"
          />
        </el-select>
        <div class="form-hint kp-text-muted">
          当前：{{ scopeText() }}。<strong>全平台</strong>会把记录下发到所有相关节点，
          跨服一致；只选某个节点只影响那个服。
        </div>
      </el-form-item>

      <el-form-item v-if="form.type === 'ban'" label="立即踢下线">
        <el-switch v-model="form.kickNow" />
        <span class="kp-text-muted switch-hint">关闭后玩家要下次登录才被拒</span>
      </el-form-item>
    </el-form>

    <template #footer>
      <template v-if="result">
        <el-button type="primary" @click="close">完成</el-button>
      </template>
      <template v-else>
        <el-button @click="close">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!canManage" @click="submit">
          创建并下发
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<style scoped>
.dispatch-list {
  margin: 6px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dispatch-tag {
  margin-right: 4px;
}

.uuid-input {
  margin-top: 8px;
}

.form-hint {
  font-size: 12px;
  line-height: 1.5;
  margin-top: 4px;
}

.duration {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.switch-hint {
  margin-left: 10px;
  font-size: 12px;
}
</style>
