<script setup lang="ts">
/**
 * 玩家详情。Tab：概览 / IP 历史 / 曾用名 / 上下线记录 / 封禁记录 / 经济 / 权限组 / 操作审计。
 *
 * 两个必须点：
 * 1. **IP 历史整块隐藏**：没有 `player.view_ip` 权限时，docs/API.md 规定
 *    服务端**不返回** lastIp 与 /ips，所以这里连 Tab 都不渲染，
 *    而不是渲染一个「无权限」的空壳 —— 「有入口但点进去不能用」本身就是信息泄漏形状。
 * 2. **管玩家需要指定节点**：所有玩家操作都要求 `{nodeId}`，玩家不在线就没有可操作节点。
 *    这时按钮禁用并说明原因，而不是点了才报 NODE_OFFLINE。
 */
import { Refresh } from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { luckpermsApi, playersApi, punishmentsApi } from '@/api/endpoints';
import { describeApiError, toApiError } from '@/api/client';
import type {
  AuditEntry,
  LpUser,
  PlayerIpRecord,
  PlayerNameRecord,
  PlayerProfile,
  PlayerSession,
  Punishment,
  PunishmentRecord,
} from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import PageHeader from '@/components/PageHeader.vue';
import PlayerAvatar from '@/components/PlayerAvatar.vue';
import PunishTag from '@/components/PunishTag.vue';
import PunishmentCreateDialog from '@/components/PunishmentCreateDialog.vue';
import type { DataTableColumn } from '@/components/DataTable.vue';
import { runMutation } from '@/composables/useMutation';
import { useAuthStore } from '@/stores/auth';
import { useNodesStore } from '@/stores/nodes';
import { PERMISSIONS } from '@/utils/permissions';
import {
  formatBoolean,
  formatDuration,
  formatMoney,
  formatRelative,
  formatTime,
} from '@/utils/format';

const props = defineProps<{ uuid?: string }>();

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const nodesStore = useNodesStore();

const uuid = computed(() => props.uuid ?? String(route.params.uuid ?? ''));

const canViewIp = computed(() => auth.hasPerm(PERMISSIONS.playerViewIp));
const canManage = computed(() => auth.hasPerm(PERMISSIONS.playerManage));
const canViewLuckperms = computed(() => auth.hasPerm(PERMISSIONS.luckpermsView));
const canViewAudit = computed(() => auth.hasPerm(PERMISSIONS.auditView));
const canViewEconomy = computed(() => auth.hasPerm(PERMISSIONS.economyView));

const activeTab = ref(typeof route.query.tab === 'string' ? route.query.tab : 'overview');

// ── 档案 ────────────────────────────────────────────────────

const profile = ref<PlayerProfile | null>(null);
const profileLoading = ref(false);
const profileError = ref('');

async function loadProfile(): Promise<void> {
  profileLoading.value = true;
  profileError.value = '';
  try {
    profile.value = await playersApi.detail(uuid.value);
  } catch (cause) {
    profile.value = null;
    profileError.value = describeApiError(toApiError(cause));
  } finally {
    profileLoading.value = false;
  }
}

/** 可执行操作的节点：玩家在线时才有；优先用档案里的 nodeId。 */
const targetNodeId = computed(() => {
  const nodeId = profile.value?.nodeId;
  if (nodeId && nodesStore.findNode(nodeId)?.status === 'online') return nodeId;
  return null;
});

const targetNode = computed(() => nodesStore.findNode(targetNodeId.value));

const canAct = computed(() => canManage.value && Boolean(targetNodeId.value));

const blockedReason = computed(() => {
  if (!profile.value) return '玩家档案未加载';
  if (!canManage.value) return '缺少 player.manage 权限';
  if (!profile.value.online) return '玩家当前不在线，踢出 / OP / 游戏模式 / 白名单都需要目标在线节点';
  if (!profile.value.nodeId) return '平台没有记录该玩家当前所在节点';
  if (!nodesStore.findNode(profile.value.nodeId)) return `节点 ${profile.value.nodeId} 不在平台列表中`;
  if (!targetNodeId.value) return `玩家所在节点 ${profile.value.nodeId} 当前不在线`;
  return '';
});

const capabilities = computed<string[]>(() => targetNode.value?.capabilities ?? []);
const supportsPlayers = computed(() => capabilities.value.includes('players'));
const supportsWhitelist = computed(() => capabilities.value.includes('whitelist'));

/** 当前处罚：active 且未撤销。 */
const activePunishments = computed<PunishmentRecord[]>(() =>
  ((profile.value?.punishments ?? []) as PunishmentRecord[]).filter(
    (item) => item.active && !item.revokedAt,
  ),
);

// ── IP 历史 ─────────────────────────────────────────────────

const ips = ref<PlayerIpRecord[]>([]);
const ipsLoading = ref(false);
const ipsError = ref('');

async function loadIps(): Promise<void> {
  if (!canViewIp.value) return;
  ipsLoading.value = true;
  ipsError.value = '';
  try {
    ips.value = await playersApi.ips(uuid.value);
  } catch (cause) {
    ips.value = [];
    ipsError.value = describeApiError(toApiError(cause));
  } finally {
    ipsLoading.value = false;
  }
}

const ipColumns: DataTableColumn[] = [
  { key: 'ip', label: 'IP', minWidth: 180, slot: 'ip' },
  { key: 'firstSeenAt', label: '首次出现', width: 180, slot: 'first' },
  { key: 'lastSeenAt', label: '最近出现', width: 180, slot: 'last' },
  { key: 'seenCount', label: '出现次数', width: 110, slot: 'count' },
];

// ── 曾用名 / 会话 ───────────────────────────────────────────

const names = ref<PlayerNameRecord[]>([]);
const namesLoading = ref(false);
const namesError = ref('');

async function loadNames(): Promise<void> {
  namesLoading.value = true;
  namesError.value = '';
  try {
    names.value = await playersApi.names(uuid.value);
  } catch (cause) {
    names.value = [];
    namesError.value = describeApiError(toApiError(cause));
  } finally {
    namesLoading.value = false;
  }
}

const sessions = ref<PlayerSession[]>([]);
const sessionsLoading = ref(false);
const sessionsError = ref('');

async function loadSessions(): Promise<void> {
  sessionsLoading.value = true;
  sessionsError.value = '';
  try {
    sessions.value = await playersApi.sessions(uuid.value);
  } catch (cause) {
    sessions.value = [];
    sessionsError.value = describeApiError(toApiError(cause));
  } finally {
    sessionsLoading.value = false;
  }
}

const sessionColumns: DataTableColumn[] = [
  { key: 'nodeId', label: '节点', width: 150, slot: 'node' },
  { key: 'ip', label: 'IP', width: 160, slot: 'ip' },
  { key: 'joinedAt', label: '上线', width: 180, slot: 'joined' },
  { key: 'leftAt', label: '下线', width: 180, slot: 'left' },
  { key: 'playtimeSeconds', label: '时长', width: 130, slot: 'duration' },
];

// ── 审计 ────────────────────────────────────────────────────

const audits = ref<AuditEntry[]>([]);
const auditsLoading = ref(false);
const auditsError = ref('');
const auditPage = ref(1);
const auditSize = ref(20);
const auditTotal = ref(0);

async function loadAudits(): Promise<void> {
  if (!canViewAudit.value) return;
  auditsLoading.value = true;
  auditsError.value = '';
  try {
    const result = await playersApi.audit(uuid.value, { page: auditPage.value, size: auditSize.value });
    audits.value = result?.items ?? [];
    auditTotal.value = result?.total ?? audits.value.length;
  } catch (cause) {
    audits.value = [];
    auditsError.value = describeApiError(toApiError(cause));
  } finally {
    auditsLoading.value = false;
  }
}

const auditColumns: DataTableColumn[] = [
  { key: 'ts', label: '时间', width: 180, slot: 'ts' },
  { key: 'actor', label: '操作者', width: 130 },
  { key: 'action', label: '动作', minWidth: 180, slot: 'action' },
  { key: 'nodeId', label: '节点', width: 140, slot: 'node' },
  { key: 'ok', label: '结果', width: 100, slot: 'ok' },
  { key: 'error', label: '错误', minWidth: 180, slot: 'error' },
];

// ── LuckPerms 用户视图 ──────────────────────────────────────

const lpNodeId = ref('');
const lpUser = ref<LpUser | null>(null);
const lpLoading = ref(false);
const lpError = ref('');

const lpCandidateNodes = computed(() =>
  nodesStore.nodes.filter((node) => node.capabilities.includes('luckperms')),
);

async function loadLpUser(): Promise<void> {
  if (!canViewLuckperms.value || !lpNodeId.value) return;
  const node = nodesStore.findNode(lpNodeId.value);
  if (node && !node.capabilities.includes('luckperms')) {
    lpUser.value = null;
    lpError.value = `节点 ${node.name} 未声明 luckperms 能力（服务端没装 LuckPerms），平台不会向它发权限查询`;
    return;
  }
  lpLoading.value = true;
  lpError.value = '';
  try {
    lpUser.value = await luckpermsApi.user(lpNodeId.value, uuid.value);
  } catch (cause) {
    lpUser.value = null;
    lpError.value = describeApiError(toApiError(cause));
  } finally {
    lpLoading.value = false;
  }
}

const lpDirectPermissions = computed(() => lpUser.value?.permissions.filter((item) => item.direct) ?? []);

/**
 * 模板里用这两个小工具读行字段，而不是写 `(scope.row as {...}).x`：
 * `<template>` 里没有 `lang="ts"` 时，vue-tsc 不认 type assertion 语法（TS1005），
 * 加了 `lang="ts"` 又会被 @vue/compiler-sfc 当成自定义块（Invalid end tag）。
 * 用函数取值两条路都不踩。
 */
function rowField(row: unknown, key: string): unknown {
  if (row && typeof row === 'object' && key in row) {
    return (row as Record<string, unknown>)[key];
  }
  return undefined;
}

function isDirect(row: unknown): boolean {
  return rowField(row, 'direct') === true;
}

function isTruthy(row: unknown): boolean {
  return rowField(row, 'value') === true;
}

// ── 操作按钮 ────────────────────────────────────────────────

const actionLoading = ref('');

const kickVisible = ref(false);
const kickReason = ref('违反服务器规则');

async function doKick(): Promise<void> {
  if (!targetNodeId.value) return;
  actionLoading.value = 'kick';
  const ok = await runMutation(
    () => playersApi.kick(uuid.value, targetNodeId.value as string, kickReason.value.trim() || '被管理员踢出'),
    { success: '已踢出', action: 'players.kick' },
  );
  actionLoading.value = '';
  if (ok !== null) {
    kickVisible.value = false;
    await loadProfile();
  }
}

async function doOp(value: boolean): Promise<void> {
  if (!targetNodeId.value) return;
  actionLoading.value = 'op';
  const ok = await runMutation(() => playersApi.op(uuid.value, targetNodeId.value as string, value), {
    success: value ? '已授予 OP' : '已取消 OP',
    action: 'players.op',
  });
  actionLoading.value = '';
  if (ok !== null) await loadProfile();
}

const gamemodeVisible = ref(false);
const gamemode = ref('SURVIVAL');
const GAMEMODES = ['SURVIVAL', 'CREATIVE', 'ADVENTURE', 'SPECTATOR'] as const;

async function doGamemode(): Promise<void> {
  if (!targetNodeId.value) return;
  actionLoading.value = 'gamemode';
  const ok = await runMutation(
    () => playersApi.gamemode(uuid.value, targetNodeId.value as string, gamemode.value),
    { success: `游戏模式已切换为 ${gamemode.value}`, action: 'players.gamemode' },
  );
  actionLoading.value = '';
  if (ok !== null) {
    gamemodeVisible.value = false;
    await loadProfile();
  }
}

async function doWhitelist(value: boolean): Promise<void> {
  if (!targetNodeId.value) return;
  actionLoading.value = 'whitelist';
  const ok = await runMutation(
    () => playersApi.whitelist(uuid.value, targetNodeId.value as string, value),
    {
      success: value ? '已加入白名单' : '已移出白名单',
      action: 'players.whitelist',
    },
  );
  actionLoading.value = '';
  if (ok !== null) await loadProfile();
}

const punishVisible = ref(false);

async function revokePunishment(row: PunishmentRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(`撤销对「${row.name}」的这条处罚？`, '撤销处罚', {
      type: 'warning',
      confirmButtonText: '撤销',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  const ok = await runMutation(() => punishmentsApi.revoke(row.id), { success: '已撤销并下发' });
  if (ok !== null) await loadProfile();
}

// ── 生命周期 ────────────────────────────────────────────────

async function loadAll(): Promise<void> {
  await nodesStore.refreshQuietly();
  await loadProfile();
  // 默认 LP 节点：优先玩家当前所在节点，否则第一个支持 LP 的节点。
  if (canViewLuckperms.value && !lpNodeId.value) {
    const current = profile.value?.nodeId;
    if (current && lpCandidateNodes.value.some((node) => node.id === current)) lpNodeId.value = current;
    else lpNodeId.value = lpCandidateNodes.value[0]?.id ?? '';
  }
  await Promise.all([
    canViewIp.value ? loadIps() : Promise.resolve(),
    loadNames(),
    loadSessions(),
    canViewAudit.value ? loadAudits() : Promise.resolve(),
  ]);
  if (canViewLuckperms.value && lpNodeId.value) await loadLpUser();
}

onMounted(loadAll);

watch(uuid, loadAll);
watch(lpNodeId, () => {
  void loadLpUser();
});
watch(activeTab, (tab) => {
  void router.replace({ query: { ...route.query, tab } });
});
watch([auditPage, auditSize], () => {
  void loadAudits();
});
</script>

<template>
  <div class="kp-page">
    <PageHeader
      :title="profile?.name ?? uuid"
      :subtitle="uuid"
      back
      @back="router.back()"
    >
      <template #actions>
        <el-button :icon="Refresh" :loading="profileLoading" @click="loadAll">刷新</el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="profileError"
      type="error"
      :closable="false"
      show-icon
      title="玩家档案加载失败"
      :description="profileError"
      data-testid="profile-error"
    />

    <!-- 操作条 -->
    <el-card shadow="never">
      <div class="action-bar">
        <PlayerAvatar :name="profile?.name ?? uuid" :online="profile?.online" :size="42" />
        <div class="action-bar__info">
          <div class="action-bar__name">
            <strong>{{ profile?.name ?? '—' }}</strong>
            <el-tag
              :type="profile?.online ? 'success' : 'info'"
              size="small"
              effect="light"
              disable-transitions
            >
              {{ profile?.online ? '在线' : '离线' }}
            </el-tag>
            <el-tag
              v-for="punishment in activePunishments"
              :key="punishment.id"
              size="small"
              type="danger"
              effect="plain"
              disable-transitions
            >
              {{ punishment.type === 'ban' ? '封禁中' : punishment.type === 'mute' ? '禁言中' : punishment.type }}
            </el-tag>
          </div>
          <div class="action-bar__meta kp-text-muted">
            <span v-if="profile?.online && profile?.nodeId">
              当前节点：{{ nodesStore.nodeName(profile.nodeId) }}
            </span>
            <span v-else>不在线，无法执行需要节点的操作</span>
          </div>
        </div>

        <div class="action-bar__buttons">
          <el-tooltip :content="blockedReason" :disabled="canAct">
            <span class="action-bar__group">
              <el-button
                size="small"
                :disabled="!canAct || !supportsPlayers"
                :loading="actionLoading === 'kick'"
                @click="kickVisible = true"
              >
                踢出
              </el-button>
              <el-button
                size="small"
                :disabled="!canAct || !supportsPlayers"
                :loading="actionLoading === 'op'"
                @click="doOp(true)"
              >
                授予 OP
              </el-button>
              <el-button
                size="small"
                :disabled="!canAct || !supportsPlayers"
                :loading="actionLoading === 'op'"
                @click="doOp(false)"
              >
                取消 OP
              </el-button>
              <el-button
                size="small"
                :disabled="!canAct || !supportsPlayers"
                @click="gamemodeVisible = true"
              >
                游戏模式
              </el-button>
              <el-button
                size="small"
                :disabled="!canAct || !supportsWhitelist"
                :loading="actionLoading === 'whitelist'"
                @click="doWhitelist(true)"
              >
                加入白名单
              </el-button>
              <el-button
                size="small"
                :disabled="!canAct || !supportsWhitelist"
                :loading="actionLoading === 'whitelist'"
                @click="doWhitelist(false)"
              >
                移出白名单
              </el-button>
            </span>
          </el-tooltip>
          <el-button
            v-if="auth.hasPerm(PERMISSIONS.punishManage)"
            size="small"
            type="danger"
            plain
            @click="punishVisible = true"
          >
            新建处罚
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="!canAct && blockedReason"
        class="action-note"
        type="info"
        :closable="false"
        show-icon
        :title="blockedReason"
      />
      <el-alert
        v-else-if="canAct && (!supportsPlayers || !supportsWhitelist)"
        class="action-note"
        type="warning"
        :closable="false"
        show-icon
        :title="
          !supportsPlayers
            ? `节点 ${targetNode?.name ?? ''} 未声明 players 能力，玩家操作按钮对该节点无效`
            : `节点 ${targetNode?.name ?? ''} 未声明 whitelist 能力，白名单按钮对该节点无效`
        "
      />
    </el-card>

    <el-tabs v-model="activeTab" type="border-card">
      <!-- 概览 -->
      <el-tab-pane label="概览" name="overview">
        <el-skeleton v-if="profileLoading && !profile" :rows="6" animated />
        <el-empty v-else-if="!profile" description="没有档案数据" :image-size="70" />
        <template v-else>
          <div class="kp-desc-grid">
            <div class="kp-desc-item">
              <span class="kp-desc-item__label">UUID</span>
              <span class="kp-desc-item__value kp-mono">{{ profile.uuid }}</span>
            </div>
            <div class="kp-desc-item">
              <span class="kp-desc-item__label">当前名字</span>
              <span class="kp-desc-item__value">{{ profile.name }}</span>
            </div>
            <div class="kp-desc-item">
              <span class="kp-desc-item__label">在线</span>
              <span class="kp-desc-item__value">{{ formatBoolean(profile.online, '在线', '离线') }}</span>
            </div>
            <div class="kp-desc-item">
              <span class="kp-desc-item__label">所在节点</span>
              <span class="kp-desc-item__value">
                {{ profile.nodeId ? nodesStore.nodeName(profile.nodeId) : '—' }}
              </span>
            </div>
            <div class="kp-desc-item">
              <span class="kp-desc-item__label">首次进入</span>
              <span class="kp-desc-item__value">{{ formatTime(profile.firstSeenAt) }}</span>
            </div>
            <div class="kp-desc-item">
              <span class="kp-desc-item__label">最后在线</span>
              <span class="kp-desc-item__value">
                {{ formatTime(profile.lastSeenAt) }}
                <span class="kp-text-muted">（{{ formatRelative(profile.lastSeenAt) }}）</span>
              </span>
            </div>
            <div class="kp-desc-item">
              <span class="kp-desc-item__label">累计游玩</span>
              <span class="kp-desc-item__value">
                {{ formatDuration(profile.playtimeSeconds, '—') }}
              </span>
            </div>
            <!-- lastIp 仅在账号有 player.view_ip 时由服务端返回；没有 key 就整项不渲染 -->
            <div v-if="canViewIp && profile.lastIp" class="kp-desc-item">
              <span class="kp-desc-item__label">最近 IP</span>
              <span class="kp-desc-item__value kp-mono">{{ profile.lastIp }}</span>
            </div>
          </div>

          <el-divider content-position="left">当前处罚</el-divider>
          <el-table v-if="activePunishments.length > 0" :data="activePunishments" size="small">
            <el-table-column label="类型" width="90">
              <template #default="scope"><PunishTag :type="(scope.row as Punishment).type" /></template>
            </el-table-column>
            <el-table-column label="原因" min-width="200" prop="reason" />
            <el-table-column label="范围" width="130">
              <template #default="scope">
                {{
                  (scope.row as Punishment).nodeId
                    ? nodesStore.nodeName((scope.row as Punishment).nodeId)
                    : '全平台'
                }}
              </template>
            </el-table-column>
            <el-table-column label="到期" width="180">
              <template #default="scope">
                {{
                  (scope.row as Punishment).expiresAt
                    ? formatTime((scope.row as Punishment).expiresAt)
                    : '永久'
                }}
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="当前没有生效中的处罚" :image-size="60" />
        </template>
      </el-tab-pane>

      <!-- IP 历史：无 player.view_ip 时整个 Tab 都不渲染 -->
      <el-tab-pane v-if="canViewIp" label="IP 历史" name="ips">
        <DataTable
          :columns="ipColumns"
          :rows="ips"
          :loading="ipsLoading"
          :error="ipsError"
          empty-text="没有 IP 记录"
          row-key="ip"
          :show-pager="false"
          @retry="loadIps"
        >
          <template #ip="{ row }"><span class="kp-mono">{{ row.ip }}</span></template>
          <template #first="{ row }">{{ formatTime(row.firstSeenAt) }}</template>
          <template #last="{ row }">{{ formatTime(row.lastSeenAt) }}</template>
          <template #count="{ row }">{{ row.seenCount ?? row.count ?? '—' }}</template>
        </DataTable>
      </el-tab-pane>

      <!-- 曾用名 -->
      <el-tab-pane label="曾用名" name="names">
        <el-alert
          v-if="namesError"
          type="error"
          :closable="false"
          show-icon
          :title="namesError"
        />
        <el-skeleton v-else-if="namesLoading && names.length === 0" :rows="3" animated />
        <el-empty v-else-if="names.length === 0" description="没有改名记录" :image-size="70" />
        <el-table v-else :data="names" size="small">
          <el-table-column label="名字" min-width="180" prop="name" />
          <el-table-column label="首次出现" width="200">
            <template #default="scope">{{ formatTime((scope.row as PlayerNameRecord).firstSeenAt) }}</template>
          </el-table-column>
          <el-table-column label="最近使用" width="200">
            <template #default="scope">{{ formatTime((scope.row as PlayerNameRecord).lastSeenAt) }}</template>
          </el-table-column>
          <el-table-column label="改名时间" width="200">
            <template #default="scope">{{ formatTime((scope.row as PlayerNameRecord).changedAt) }}</template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- 上下线记录 -->
      <el-tab-pane label="上下线记录" name="sessions">
        <DataTable
          :columns="sessionColumns"
          :rows="sessions"
          :loading="sessionsLoading"
          :error="sessionsError"
          empty-text="没有上下线记录"
          row-key="id"
          :show-pager="false"
          @retry="loadSessions"
        >
          <template #node="{ row }">
            {{ row.nodeId ? nodesStore.nodeName(row.nodeId) : '—' }}
          </template>
          <template #ip="{ row }">
            <span v-if="row.ip" class="kp-mono">{{ row.ip }}</span>
            <span v-else class="kp-text-muted">—</span>
          </template>
          <template #joined="{ row }">{{ formatTime(row.joinedAt) }}</template>
          <template #left="{ row }">
            <span v-if="row.leftAt">{{ formatTime(row.leftAt) }}</span>
            <span v-else class="kp-text-muted">仍在游戏中</span>
          </template>
          <template #duration="{ row }">
            {{ formatDuration(row.playtimeSeconds, '—') }}
          </template>
        </DataTable>
      </el-tab-pane>

      <!-- 封禁记录 -->
      <el-tab-pane label="封禁记录" name="punishments">
        <el-alert
          v-if="!auth.hasPerm(PERMISSIONS.punishView)"
          type="info"
          :closable="false"
          show-icon
          title="缺少 punish.view 权限，无法查看处罚记录"
        />
        <el-table v-else :data="profile?.punishments ?? []" size="small">
          <el-table-column label="类型" width="90">
            <template #default="scope">
              <PunishTag :type="(scope.row as Punishment).type" :inactive="!(scope.row as Punishment).active" />
            </template>
          </el-table-column>
          <el-table-column label="原因" min-width="200" prop="reason" />
          <el-table-column label="范围" width="140">
            <template #default="scope">
              {{
                (scope.row as Punishment).nodeId
                  ? nodesStore.nodeName((scope.row as Punishment).nodeId)
                  : '全平台'
              }}
            </template>
          </el-table-column>
          <el-table-column label="创建" width="170">
            <template #default="scope">{{ formatTime((scope.row as Punishment).createdAt) }}</template>
          </el-table-column>
          <el-table-column label="到期" width="170">
            <template #default="scope">
              {{
                (scope.row as Punishment).expiresAt
                  ? formatTime((scope.row as Punishment).expiresAt)
                  : '永久'
              }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="scope">
              <el-tag
                :type="(scope.row as Punishment).active ? 'danger' : 'info'"
                size="small"
                effect="plain"
                disable-transitions
              >
                {{ (scope.row as Punishment).active ? '生效中' : '已失效' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="100">
            <template #default="scope">
              <el-button
                v-if="auth.hasPerm(PERMISSIONS.punishManage) && (scope.row as Punishment).active"
                size="small"
                text
                type="danger"
                @click="revokePunishment(scope.row as Punishment)"
              >
                撤销
              </el-button>
              <span v-else class="kp-text-muted">—</span>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- 经济 -->
      <el-tab-pane label="经济" name="economy">
        <el-alert
          v-if="!canViewEconomy"
          type="info"
          :closable="false"
          show-icon
          title="缺少 economy.view 权限"
        />
        <template v-else-if="profile">
          <el-descriptions :column="2" border>
            <el-descriptions-item label="站点积分">
              {{ formatMoney(profile.economy?.balance) }}
            </el-descriptions-item>
            <el-descriptions-item label="游戏内货币（各节点）">
              <template v-if="Object.keys(profile.gameCurrency ?? {}).length > 0">
                <div v-for="(value, key) in profile.gameCurrency" :key="key" class="currency-row">
                  <span class="kp-text-muted">{{ nodesStore.nodeName(String(key)) }}</span>
                  <span class="kp-mono">{{ formatMoney(value.balance) }} {{ value.currency }}</span>
                </div>
              </template>
              <span v-else class="kp-text-muted">—</span>
            </el-descriptions-item>
          </el-descriptions>

          <el-divider content-position="left">调整</el-divider>
          <div class="economy-actions">
            <el-button
              v-if="auth.hasPerm(PERMISSIONS.economyManage)"
              type="primary"
              plain
              @click="router.push({ name: 'economy', query: { uuid: profile.uuid } })"
            >
              前往经济页调整余额
            </el-button>
            <span class="kp-text-muted">
              积分调整 / 游戏内货币下发与流水都在经济页完成（那里有幂等键与配置校验）。
            </span>
          </div>
        </template>
      </el-tab-pane>

      <!-- LuckPerms 用户视图 -->
      <el-tab-pane v-if="canViewLuckperms" label="权限组" name="luckperms">
        <div class="lp-toolbar">
          <span class="kp-text-muted">节点</span>
          <el-select v-model="lpNodeId" placeholder="选择节点" style="width: 240px" filterable>
            <el-option
              v-for="node in lpCandidateNodes"
              :key="node.id"
              :label="`${node.name}（${node.id}）`"
              :value="node.id"
            />
          </el-select>
          <el-button
            v-if="auth.hasPerm(PERMISSIONS.luckpermsManage) && lpNodeId"
            @click="router.push({ name: 'luckperms', query: { node: lpNodeId } })"
          >
            管理权限组
          </el-button>
          <span class="kp-text-muted">
            LuckPerms 是每个服务端各自的数据，必须按节点查询。
          </span>
        </div>

        <el-alert
          v-if="lpCandidateNodes.length === 0"
          type="warning"
          :closable="false"
          show-icon
          title="没有声明 luckperms 能力的节点"
          description="Agent 未上报 luckperms 能力（服务端没装 LuckPerms），平台不会发起查询。"
        />
        <el-alert v-else-if="lpError" type="error" :closable="false" show-icon :title="lpError" />
        <el-skeleton v-else-if="lpLoading && !lpUser" :rows="5" animated />
        <el-empty v-else-if="!lpUser" description="没有权限数据（选择一个节点查询）" :image-size="70" />
        <template v-else>
          <div class="kp-desc-grid">
            <div class="kp-desc-item">
              <span class="kp-desc-item__label">主组</span>
              <span class="kp-desc-item__value">
                <el-tag size="small" effect="plain" disable-transitions>{{ lpUser.primaryGroup }}</el-tag>
              </span>
            </div>
            <div class="kp-desc-item">
              <span class="kp-desc-item__label">继承权限总数</span>
              <span class="kp-desc-item__value">{{ lpUser.inheritedPermissionsCount ?? '—' }}</span>
            </div>
            <div class="kp-desc-item">
              <span class="kp-desc-item__label">前缀</span>
              <span class="kp-desc-item__value kp-mono">{{ lpUser.meta?.prefix || '（空）' }}</span>
            </div>
            <div class="kp-desc-item">
              <span class="kp-desc-item__label">后缀</span>
              <span class="kp-desc-item__value kp-mono">{{ lpUser.meta?.suffix || '（空）' }}</span>
            </div>
          </div>

          <el-divider content-position="left">组（{{ lpUser.groups?.length ?? 0 }}）</el-divider>
          <el-table :data="lpUser.groups ?? []" size="small">
            <el-table-column prop="name" label="组" min-width="140" />
            <el-table-column prop="weight" label="权重" width="90" />
            <el-table-column label="来源" width="140">
              <template #default="scope">
                <el-tag
                  size="small"
                  effect="plain"
                  :type="isDirect(scope.row) ? 'success' : 'info'"
                  disable-transitions
                >
                  {{ isDirect(scope.row) ? '直接授予' : '继承' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>

          <el-divider content-position="left">
            直接权限节点（{{ lpDirectPermissions.length }}）
          </el-divider>
          <el-table :data="lpDirectPermissions" size="small" max-height="320">
            <el-table-column prop="key" label="权限" min-width="240" />
            <el-table-column label="值" width="100">
              <template #default="scope">
                <el-tag
                  :type="isTruthy(scope.row) ? 'success' : 'danger'"
                  size="small"
                  effect="plain"
                  disable-transitions
                >
                  {{ isTruthy(scope.row) ? 'true' : 'false' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </el-tab-pane>

      <!-- 操作审计 -->
      <el-tab-pane v-if="canViewAudit" label="操作审计" name="audit">
        <DataTable
          :columns="auditColumns"
          :rows="audits"
          :loading="auditsLoading"
          :error="auditsError"
          empty-text="没有针对该玩家的操作记录"
          row-key="id"
          :total="auditTotal"
          :page="auditPage"
          :size="auditSize"
          @retry="loadAudits"
          @update:page="auditPage = $event"
          @update:size="auditSize = $event"
        >
          <template #ts="{ row }">
            <span :title="formatTime(row.ts)">{{ formatRelative(row.ts) }}</span>
          </template>
          <template #action="{ row }">
            <span class="kp-inline-code">{{ row.action }}</span>
          </template>
          <template #node="{ row }">{{ row.nodeId ? nodesStore.nodeName(row.nodeId) : '—' }}</template>
          <template #ok="{ row }">
            <el-tag :type="row.ok ? 'success' : 'danger'" size="small" disable-transitions>
              {{ row.ok ? '成功' : '失败' }}
            </el-tag>
          </template>
          <template #error="{ row }">
            <span v-if="row.error" class="error-text">{{ row.error }}</span>
            <span v-else class="kp-text-muted">—</span>
          </template>
        </DataTable>
      </el-tab-pane>
    </el-tabs>

    <!-- 踢出对话框 -->
    <el-dialog v-model="kickVisible" title="踢出玩家" width="440px">
      <el-form label-width="72px">
        <el-form-item label="玩家">
          <span>{{ profile?.name }} <span class="kp-mono kp-text-muted">{{ uuid }}</span></span>
        </el-form-item>
        <el-form-item label="原因">
          <el-input v-model="kickReason" maxlength="120" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="kickVisible = false">取消</el-button>
        <el-button type="primary" :loading="actionLoading === 'kick'" @click="doKick">踢出</el-button>
      </template>
    </el-dialog>

    <!-- 游戏模式对话框 -->
    <el-dialog v-model="gamemodeVisible" title="切换游戏模式" width="420px">
      <el-radio-group v-model="gamemode">
        <el-radio v-for="mode in GAMEMODES" :key="mode" :value="mode" class="gamemode-radio">
          {{ mode }}
        </el-radio>
      </el-radio-group>
      <template #footer>
        <el-button @click="gamemodeVisible = false">取消</el-button>
        <el-button type="primary" :loading="actionLoading === 'gamemode'" @click="doGamemode">
          应用
        </el-button>
      </template>
    </el-dialog>

    <PunishmentCreateDialog
      v-model="punishVisible"
      :player-uuid="uuid"
      :player-name="profile?.name"
      :node-id="targetNodeId"
      @created="loadProfile"
    />
  </div>
</template>

<style scoped>
.action-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.action-bar__info {
  flex: 1 1 220px;
  min-width: 0;
}

.action-bar__name {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.action-bar__meta {
  font-size: 12.5px;
  margin-top: 2px;
}

.action-bar__buttons {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.action-bar__group {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
}

.action-note {
  margin-top: 12px;
}

.currency-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.economy-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.lp-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.gamemode-radio {
  display: block;
  margin: 6px 0;
}

.error-text {
  color: var(--el-color-danger);
}
</style>
