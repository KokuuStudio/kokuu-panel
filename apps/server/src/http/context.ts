/**
 * HTTP 层共享上下文与工具。
 *
 * 鉴权模型：会话 Cookie（HttpOnly）+ CSRF 双提交 + 权限点校验。
 * 每个写接口都必须显式声明它需要的权限点 —— 没有「默认放行」的路径。
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ROLE_PERMISSIONS,
  hasPermission,
  type ErrorCode,
  type Permission,
  type Role,
} from '@kokuu/protocol';

import type { AccountRow, Store } from '../store/index.ts';
import type { AgentGateway } from '../agent/gateway.ts';
import type { EventsHub } from '../events/hub.ts';

export interface AppContext {
  store: Store;
  gateway: AgentGateway;
  hub: EventsHub;
  startedAt: number;
  /**
   * 最近一次从节点收到的指标与信息，按 nodeId 缓存。
   *
   * 有缓存才能让「节点列表」这类页面一次查询就渲染完 ——
   * 否则每张卡片都要发一次 RPC，10 个节点就是 10 个来回，
   * 而且节点离线时会同时超时。
   */
  metrics: Map<string, { data: unknown; ts: number }>;
  serverInfo: Map<string, { data: unknown; ts: number }>;
}

declare module 'fastify' {
  interface FastifyRequest {
    account?: AccountRow;
    permissions?: Set<Permission>;
    clientIp?: string;
  }
}

/**
 * 业务错误 → HTTP 状态码。
 *
 * `NODE_OFFLINE` 与 `NODE_ERROR` 必须分开：前者是「连不上」，
 * 后者是「连上了但它拒绝」。运维看到这两个词排查方向完全不同。
 */
const CODE_TO_STATUS: Record<string, number> = {
  INVALID_PARAMS: 400,
  UNAUTHENTICATED: 401,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  NODE_REJECTED: 422,
  RATE_LIMITED: 429,
  // 501：功能**有意的**未实现，不是坏了。用于「平台不持有账本」这类
  // 设计决定 —— 回 500 会让人以为是 bug，回 404 会让人以为路径写错。
  NOT_IMPLEMENTED: 501,
  NODE_OFFLINE: 502,
  NODE_DISABLED: 502,
  NODE_ERROR: 502,
  UNSUPPORTED: 502,
  NO_LUCKPERMS: 502,
  NO_ECONOMY: 502,
  TIMEOUT: 504,
  PROTOCOL_MISMATCH: 502,
  INTERNAL: 500,
};

export class HttpError extends Error {
  readonly code: string;
  readonly data: unknown;
  readonly status: number;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.data = data;
    this.status = CODE_TO_STATUS[code] ?? 500;
  }

  static badRequest(message: string, data?: unknown): HttpError {
    return new HttpError('INVALID_PARAMS', message, data);
  }

  static notFound(message: string): HttpError {
    return new HttpError('NOT_FOUND', message);
  }

  static forbidden(message: string): HttpError {
    return new HttpError('FORBIDDEN', message);
  }
}

/** 路由处理函数里直接 `throw`，由统一的错误处理器转成响应。 */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;

  // Agent 调用失败：透传它的错误码，让前端能区分「离线」与「拒绝」。
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    const code = (error as { code: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    const data = (error as { data?: unknown }).data;
    if (code in CODE_TO_STATUS) {
      return new HttpError(code, message, data);
    }
  }

  return new HttpError('INTERNAL', error instanceof Error ? error.message : String(error));
}

export function accountPayload(account: AccountRow) {
  const role = account.role as Role;
  return {
    id: account.id,
    username: account.username,
    displayName: account.display_name || account.username,
    role,
    permissions: ROLE_PERMISSIONS[role] ?? [],
  };
}

/** 取当前请求的账号；未登录直接抛 401。 */
export function currentAccount(request: FastifyRequest): AccountRow {
  if (!request.account) {
    throw new HttpError('UNAUTHENTICATED', '请先登录');
  }
  return request.account;
}

/**
 * 权限校验。缺权限时抛 403，消息里**明确写出缺哪个权限点** ——
 * 只说「无权限」会让管理员在排查时无从下手。
 */
export function requirePermission(
  request: FastifyRequest,
  permission: Permission,
): AccountRow {
  const account = currentAccount(request);
  if (!hasPermission(account.role as Role, permission)) {
    throw HttpError.forbidden(`缺少权限 ${permission}`);
  }
  return account;
}

/** 同时要求多个权限点（全部满足）。 */
export function requireAll(
  request: FastifyRequest,
  permissions: Permission[],
): AccountRow {
  const account = currentAccount(request);
  for (const permission of permissions) {
    if (!hasPermission(account.role as Role, permission)) {
      throw HttpError.forbidden(`缺少权限 ${permission}`);
    }
  }
  return account;
}

/** 分页参数。上限 200，防止 `?size=100000` 把内存打满。 */
export function pageParams(query: Record<string, unknown>): {
  page: number;
  size: number;
} {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const rawSize = Number.parseInt(String(query.size ?? '20'), 10) || 20;
  return { page, size: Math.min(200, Math.max(1, rawSize)) };
}

export function optStr(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

export function optBool(
  query: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = optStr(query, key);
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

export function optInt(
  query: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = optStr(query, key);
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 审计包装。
 *
 * 无论成功失败都记一条。**失败也要记** —— 「谁试过但没成功」
 * 在排查越权与误操作时比成功记录更有价值。
 */
export async function audited<T>(
  ctx: AppContext,
  request: FastifyRequest,
  meta: {
    action: string;
    targetType?: string;
    targetId?: string;
    nodeId?: string | null;
    params?: unknown;
  },
  fn: () => Promise<T> | T,
): Promise<T> {
  const account = request.account;
  try {
    const result = await fn();
    ctx.store.audit({
      actor: account?.username ?? 'anonymous',
      actorIp: request.clientIp ?? null,
      action: meta.action,
      targetType: meta.targetType,
      targetId: meta.targetId,
      nodeId: meta.nodeId ?? null,
      params: meta.params,
      ok: true,
    });
    return result;
  } catch (error) {
    ctx.store.audit({
      actor: account?.username ?? 'anonymous',
      actorIp: request.clientIp ?? null,
      action: meta.action,
      targetType: meta.targetType,
      targetId: meta.targetId,
      nodeId: meta.nodeId ?? null,
      params: meta.params,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export interface RouteModule {
  register(app: import('fastify').FastifyInstance, ctx: AppContext): void;
}

export type { ErrorCode };
