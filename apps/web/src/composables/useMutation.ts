/**
 * 统一处理「写操作」的反馈。
 *
 * 所有写操作都从这里出去，保证：
 * - 成功 → ElMessage.success + 指定文案；
 * - 失败 → ElMessage.error，文案走 describeApiError（NODE_OFFLINE 与 NODE_ERROR 已区分）。
 */
import { ElMessage } from 'element-plus';

import { describeApiError, toApiError } from '@/api/client';

export interface MutationOptions {
  success?: string;
  /** 失败时不弹消息（由调用方自己展示，比如 dispatched 失败清单）。 */
  silentError?: boolean;
  /** 用于控制台定位。 */
  action?: string;
}

export async function runMutation<T>(
  operation: () => Promise<T>,
  options: MutationOptions = {},
): Promise<T | null> {
  try {
    const result = await operation();
    if (options.success) ElMessage.success(options.success);
    return result;
  } catch (cause) {
    const apiError = toApiError(cause);
    if (!options.silentError) {
      ElMessage.error(describeApiError(apiError));
    }
    if (options.action) {
      console.error(`[mutation] ${options.action} failed`, apiError);
    }
    return null;
  }
}

/**
 * LuckPerms / 其它返回 `{changed}` 的写操作的统一反馈。
 *
 * 协议约定：所有写操作返回 `changed`；`false` 表示「本来就是这个值」。
 * 这时必须提示「无需修改」而不是「已修改」，否则管理员会以为改动生效了，
 * 而审计表里记的恰恰是「无需修改」。
 * 注意 `undefined` 不能被当成 false —— 后端没返回 changed 时按成功处理。
 */
export function reportChanged(
  changed: boolean | undefined | null,
  changedText: string,
  noChangeText = '无需修改，当前已是该值',
): void {
  if (changed === false) {
    ElMessage.info(noChangeText);
    return;
  }
  ElMessage.success(changedText);
}
