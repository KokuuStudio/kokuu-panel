/**
 * 处罚类型的展示映射。
 * 单独一个模块，是因为 `<script setup>` 里不能有 ES module 导出，
 * 而多处需要这套中文名。
 */
export const PUNISHMENT_LABELS: Record<string, string> = {
  ban: '封禁',
  mute: '禁言',
  warn: '警告',
  kick: '踢出',
};

export function punishmentLabel(type: string | null | undefined): string {
  if (!type) return '—';
  return PUNISHMENT_LABELS[type] ?? type;
}
