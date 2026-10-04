/**
 * 一次性密钥展示对话框。
 *
 * 节点创建 / 轮换密钥的 `secret` 只在响应里出现一次，库里存的是 scrypt 哈希
 * —— 找不回来。所以这里必须：
 * 1. 用 `closeOnClickModal=false` / `closeOnPressEscape=false`，防止误触关掉；
 * 2. 显式警告「关闭后无法再查看」；
 * 3. 提供一键复制。
 */
<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  modelValue: boolean;
  nodeId: string;
  nodeName?: string;
  secret: string;
  title?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  closed: [];
}>();

const copied = ref(false);

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

watch(
  () => props.secret,
  () => {
    copied.value = false;
  },
);

async function copySecret(): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(props.secret);
    } else {
      // 非安全上下文（http 局域网访问）没有 clipboard API，退回 execCommand。
      const input = document.createElement('textarea');
      input.value = props.secret;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    copied.value = true;
    ElMessage.success('密钥已复制到剪贴板');
  } catch {
    ElMessage.error('复制失败，请手动选中并复制');
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="title ?? '节点密钥（仅显示一次）'"
    width="560px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="true"
    @closed="emit('closed')"
  >
    <el-alert type="error" :closable="false" show-icon title="关闭后无法再查看">
      <template #default>
        <p style="margin: 0 0 6px">
          平台只保存密钥的 <code class="kp-inline-code">scrypt</code> 哈希，<strong>无法找回</strong>。
          请立刻把它填进该节点 MC 服务端的 <code class="kp-inline-code">plugins/KokuuPanel/config.yml</code>。
        </p>
        <p style="margin: 0">
          丢失后只能通过「轮换密钥」重新生成；轮换会让旧密钥立即失效，已连接的 Agent 会掉线重连。
        </p>
      </template>
    </el-alert>

    <el-descriptions :column="1" border style="margin-top: 14px">
      <el-descriptions-item label="节点 ID">
        <span class="kp-mono">{{ nodeId }}</span>
      </el-descriptions-item>
      <el-descriptions-item v-if="nodeName" label="节点名称">{{ nodeName }}</el-descriptions-item>
      <el-descriptions-item label="密钥">
        <div class="secret-row">
          <code class="secret kp-mono" data-testid="node-secret">{{ secret }}</code>
          <el-button type="primary" plain size="small" @click="copySecret">
            {{ copied ? '已复制' : '复制' }}
          </el-button>
        </div>
      </el-descriptions-item>
    </el-descriptions>

    <template #footer>
      <el-button type="primary" @click="visible = false">我已保存，关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.secret-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.secret {
  flex: 1 1 260px;
  word-break: break-all;
  background: var(--el-fill-color);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12.5px;
}
</style>
