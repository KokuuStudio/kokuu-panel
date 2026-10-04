/**
 * 异步数据的「加载中 / 出错 / 空」三态封装。
 * 强制要求每个页面都呈现三态，避免出现「白屏什么都不显示」。
 */
import { ref, shallowRef } from 'vue';
import type { Ref, ShallowRef } from 'vue';

import { describeApiError, toApiError } from '@/api/client';

export interface AsyncDataOptions {
  /** 失败时的兜底值（默认 null）。 */
  fallbackOnError?: boolean;
}

export interface AsyncDataHandle<T> {
  data: ShallowRef<T | null>;
  loading: Ref<boolean>;
  error: Ref<string>;
  load: () => Promise<T | null>;
}

export function useAsyncData<T>(loader: () => Promise<T>, options: AsyncDataOptions = {}): AsyncDataHandle<T> {
  const data = shallowRef<T | null>(null);
  const loading = ref(false);
  const error = ref('');

  async function load(): Promise<T | null> {
    loading.value = true;
    error.value = '';
    try {
      const result = await loader();
      data.value = result;
      return result;
    } catch (cause) {
      const apiError = toApiError(cause);
      error.value = describeApiError(apiError);
      if (options.fallbackOnError !== false) data.value = null;
      return null;
    } finally {
      loading.value = false;
    }
  }

  return { data, loading, error, load };
}
