/**
 * 暗色模式。
 *
 * 默认跟随系统（`prefers-color-scheme`），允许手动覆盖并持久化到 localStorage。
 * Element Plus 的暗色主题靠 `<html class="dark">` 触发（见 element-plus/theme-chalk/dark/css-vars.css），
 * 所以这里只负责维护这个 class 与 `color-scheme`。
 */
import { ref, watch } from 'vue';

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

const STORAGE_KEY = 'kokuu.theme';

export const themeMode = ref<ThemeMode>(readStoredMode());

/** 已解析的实际主题（system → 跟随系统后的结果）。 */
export const resolvedTheme = ref<'light' | 'dark'>('light');

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

function readStoredMode(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'system';
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isThemeMode(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(): void {
  const dark = themeMode.value === 'dark' || (themeMode.value === 'system' && systemPrefersDark());
  resolvedTheme.value = dark ? 'dark' : 'light';
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

export function setThemeMode(mode: ThemeMode): void {
  themeMode.value = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 隐私模式下 localStorage 会抛；主题不持久化不影响功能。
  }
}

export function toggleTheme(): void {
  setThemeMode(resolvedTheme.value === 'dark' ? 'light' : 'dark');
}

/** 在 app 启动时调用一次：应用当前主题并监听系统变化。 */
export function initTheme(): void {
  apply();
  watch(themeMode, apply);
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (): void => {
      if (themeMode.value === 'system') apply();
    };
    // Safari < 14 只有 addListener。
    if (typeof query.addEventListener === 'function') query.addEventListener('change', listener);
    else if (typeof (query as MediaQueryList).addListener === 'function') {
      (query as MediaQueryList).addListener(listener);
    }
  }
}
