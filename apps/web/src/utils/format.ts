/**
 * 纯展示层工具：时间、时长、字节、数字、玩家名首字母配色。
 * 这里的每个函数都必须能接受 null / undefined 并给出「—」，
 * 因为协议里有大量「取不到就是 null」的字段（Metrics.tps、LpGroup.userCount … ）。
 */

/** 统一的空值占位。不要用 0、不要用 20.0 —— 那会让人以为一切正常。 */
export const EMPTY = '—';

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function formatTime(ts: number | null | undefined, withSeconds = true): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return EMPTY;
  const d = new Date(ts);
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

export function formatDate(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return EMPTY;
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 相对时间（「3 分钟前」）；用于 lastSeenAt / 审计时间。 */
export function formatRelative(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return EMPTY;
  const delta = Date.now() - ts;
  if (delta < 0) return formatTime(ts);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatTime(ts);
}

/**
 * 时长。null / undefined = 永久（封禁场景语义），
 * 用 `permanentLabel` 区分「永久」与「未知」。
 */
export function formatDuration(
  seconds: number | null | undefined,
  permanentLabel = '永久',
): string {
  if (seconds === null || seconds === undefined) return permanentLabel;
  if (!Number.isFinite(seconds)) return EMPTY;
  if (seconds < 0) return EMPTY;
  if (seconds === 0) return '0 秒';
  const units: Array<[number, string]> = [
    [86400, '天'],
    [3600, '小时'],
    [60, '分钟'],
    [1, '秒'],
  ];
  const parts: string[] = [];
  let rest = Math.floor(seconds);
  for (const [size, label] of units) {
    const value = Math.floor(rest / size);
    if (value > 0) {
      parts.push(`${value} ${label}`);
      rest -= value * size;
    }
    if (parts.length >= 2) break;
  }
  return parts.join('') || '0 秒';
}

export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return EMPTY;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const unit = units[index] ?? 'B';
  return `${value.toFixed(index === 0 ? 0 : digits)} ${unit}`;
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * 数字或「—」。协议里有大量 `number | null`（Metrics.mspt、Metrics.tps…），
 * 统一用这个，避免某处写成 `value ?? 0` 把「取不到」伪装成 0。
 */
export function numOrDash(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return digits > 0 ? value.toFixed(digits) : String(value);
}

/** 秒 → 「3 天 4 小时」。 */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return EMPTY;
  }
  return formatDuration(seconds, EMPTY);
}

/** 余额：保留两位；无数据时给「—」而不是 0.00。 */
export function formatMoney(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return formatNumber(value, digits);
}

/**
 * TPS。协议明确：取不到时是 null，**必须显示「—」**。
 * 顺手在 19.5 以下标黄、18 以下标红，让「卡服」一眼可见。
 */
export function formatTps(tps: number | null | undefined): string {
  if (tps === null || tps === undefined || !Number.isFinite(tps)) return EMPTY;
  return tps.toFixed(2);
}

export type TpsTone = 'normal' | 'warn' | 'bad' | 'empty';

export function tpsTone(tps: number | null | undefined): TpsTone {
  if (tps === null || tps === undefined || !Number.isFinite(tps)) return 'empty';
  if (tps >= 19.5) return 'normal';
  if (tps >= 18) return 'warn';
  return 'bad';
}

/** 内存占用百分比；max 为 0 或缺失时返回 null（不要除零编个 0%）。 */
export function memoryPercent(
  memory: { used: number; max: number } | null | undefined,
): number | null {
  if (!memory || !Number.isFinite(memory.max) || memory.max <= 0) return null;
  return Math.min(100, Math.max(0, (memory.used / memory.max) * 100));
}

export function percentText(percent: number | null | undefined, digits = 1): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return EMPTY;
  return `${percent.toFixed(digits)}%`;
}

export function truncate(text: string | null | undefined, max = 60): string {
  if (!text) return EMPTY;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function shortUuid(uuid: string | null | undefined): string {
  if (!uuid) return EMPTY;
  return uuid.length > 10 ? `${uuid.slice(0, 8)}…` : uuid;
}

/** 玩家头像：用名字首字母 + 稳定色相，避免为一张头像去拉外部服务。 */
export function avatarHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 360;
  }
  return hash;
}

export function initialsOf(name: string | null | undefined): string {
  if (!name) return '?';
  return name.slice(0, 1).toUpperCase();
}

/** 把任意列表响应（裸数组 / {items} / {players}）拍成数组。 */
export function toArray<T>(value: T[] | { items?: T[]; players?: T[]; lines?: T[] } | null | undefined): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.players)) return value.players;
  if (Array.isArray(value.lines)) return value.lines;
  return [];
}

export function formatBoolean(value: boolean | null | undefined, yes = '是', no = '否'): string {
  if (value === null || value === undefined) return EMPTY;
  return value ? yes : no;
}

/** 把 LuckPerms 组列表响应（裸数组 / {groups:[…]}）拍成数组。 */
export function toLpGroupArray<T>(value: T[] | { groups?: T[] } | null | undefined): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.groups)) return value.groups;
  return [];
}

/** 深拷贝，仅用于「编辑副本」，避免直接改到 store 里的原始对象。 */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
