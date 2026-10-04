/**
 * 轮询：页面可见时才跑，组件卸载自动停。
 * 节点状态 / Metrics 这类「会自己变」的数据用它，避免用户手动刷新。
 */
import { onBeforeUnmount, onMounted, watch } from 'vue';
import type { Ref } from 'vue';

export interface PollingOptions {
  /** 是否正在轮询（一般传一个 ref，便于临时暂停）。 */
  enabled?: Ref<boolean>;
  /** 页面不可见时跳过（默认 true）。 */
  pauseWhenHidden?: boolean;
}

export function usePolling(callback: () => void | Promise<void>, intervalMs: number, options: PollingOptions = {}): void {
  let timer: ReturnType<typeof setInterval> | null = null;

  const shouldRun = (): boolean => {
    if (options.enabled && !options.enabled.value) return false;
    if (options.pauseWhenHidden !== false && typeof document !== 'undefined' && document.hidden) {
      return false;
    }
    return true;
  };

  const tick = (): void => {
    if (!shouldRun()) return;
    void callback();
  };

  const start = (): void => {
    stop();
    timer = setInterval(tick, intervalMs);
  };

  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  onMounted(() => {
    start();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', tick);
    }
  });

  onBeforeUnmount(() => {
    stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', tick);
    }
  });

  if (options.enabled) {
    watch(options.enabled, (value) => {
      if (value) start();
      else stop();
    });
  }
}
