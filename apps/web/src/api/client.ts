/**
 * fetch 封装。
 *
 * 三条硬约束，来自 docs/API.md 的「约定」一节：
 * 1. 认证走 HttpOnly Cookie（`kp_session`），**不**用 Authorization 头；
 * 2. 所有非 GET 请求必须带 `X-CSRF-Token`，值与 `kp_csrf` 非 HttpOnly Cookie 相同（双提交）；
 * 3. 错误一律是 `{ error: { code, message, data } }`，由本文件规范化成 ApiError 抛出。
 */
import type { ErrorCode } from '@kokuu/protocol';

/** REST 前缀。放在一处，改前缀只改这里。 */
export const API_BASE = '/_api';

const CSRF_COOKIE = 'kp_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

/**
 * 错误码集合。不用 enum —— 根 tsconfig 开了 `erasableSyntaxOnly`，
 * enum 会被 TS 拒绝；`as const` 元组 + typeof 推导出的联合类型等价且可直接擦除。
 */
export const API_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'INVALID_PARAMS',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'NODE_REJECTED',
  'NODE_OFFLINE',
  'NODE_ERROR',
  'HTTP_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** 便于把协议里的 Agent 错误码（可能是任意字符串）直接塞进 code。 */
export type AnyErrorCode = ApiErrorCode | ErrorCode | (string & {});

export interface ApiErrorInit {
  status: number;
  code: AnyErrorCode;
  message: string;
  data?: unknown;
  /** 透传的 Agent 错误码（NODE_ERROR / NODE_REJECTED 时才有意义）。 */
  agentCode?: string | undefined;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: AnyErrorCode;
  readonly data: unknown;
  readonly agentCode: string | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.data = init.data;
    this.agentCode = init.agentCode;
  }
}

/** 服务端错误体（docs/API.md「错误响应」）。 */
interface WireErrorBody {
  error?: { code?: string; message?: string; data?: unknown };
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** query 参数；null / undefined / '' 会被丢掉。 */
  query?: Record<string, unknown>;
  body?: unknown;
  /** 不触发「401 自动跳登录」。登录接口自身要用。 */
  skipAuthRedirect?: boolean;
  signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────
// Cookie / CSRF
// ─────────────────────────────────────────────────────────────

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const item = part.trim();
    if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
  }
  return null;
}

export function csrfToken(): string | null {
  return readCookie(CSRF_COOKIE);
}

// ─────────────────────────────────────────────────────────────
// 查询串
// ─────────────────────────────────────────────────────────────

export function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    if (raw === null || raw === undefined || raw === '') continue;
    if (Array.isArray(raw)) {
      for (const v of raw) {
        if (v === null || v === undefined || v === '') continue;
        search.append(key, String(v));
      }
      continue;
    }
    search.append(key, String(raw));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

// ─────────────────────────────────────────────────────────────
// 401 处理（登录跳转交给 app 层注册，client 不依赖 router，避免循环引用）
// ─────────────────────────────────────────────────────────────

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

function handleUnauthorized(): void {
  try {
    unauthorizedHandler?.();
  } catch {
    // 跳转失败不能盖掉原始错误。
  }
}

// ─────────────────────────────────────────────────────────────
// 请求
// ─────────────────────────────────────────────────────────────

function hasBody(method: string, body: unknown): boolean {
  if (body === undefined || body === null) return false;
  return method !== 'GET' && method !== 'DELETE';
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const url = `${API_BASE}${path}${buildQuery(options.query)}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (hasBody(method, options.body)) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const token = csrfToken();
    // 没有 csrf cookie 时不硬造一个值：让服务端明确拒绝，
    // 好过发一个假 token 让人误以为「前端已经带了」。
    if (token) headers[CSRF_HEADER] = token;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      // 带上会话 Cookie。同源部署下这是默认值，显式写出防止将来跨域改动踩坑。
      credentials: 'same-origin',
      ...(hasBody(method, options.body) ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError({
      status: 0,
      code: 'HTTP_ERROR',
      message: '无法连接后台服务，请确认服务是否已启动',
      data: cause,
    });
  }

  return (await parseResponse<T>(response, options)) as T;
}

async function parseResponse<T>(response: Response, options: RequestOptions): Promise<T | undefined> {
  if (response.status === 204) {
    if (!response.ok) throw await buildError(response);
    return undefined;
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (!response.ok) {
    const error = await buildError(response, parsed);
    if (error.status === 401 && !options.skipAuthRedirect) handleUnauthorized();
    throw error;
  }

  return parsed as T;
}

async function buildError(response: Response, parsed?: unknown): Promise<ApiError> {
  let payload = parsed;
  if (payload === undefined) {
    const text = await response.text().catch(() => '');
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: { code: 'HTTP_ERROR', message: text.slice(0, 300) } };
      }
    }
  }

  const body = (payload ?? {}) as WireErrorBody;
  const wire = body.error ?? {};
  const data = wire.data;
  const agentCode = extractAgentCode(data);

  return new ApiError({
    status: response.status,
    code: wire.code ?? 'HTTP_ERROR',
    message: wire.message ?? `请求失败（HTTP ${response.status}）`,
    data,
    agentCode,
  });
}

function extractAgentCode(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const code = (data as { agentCode?: unknown }).agentCode;
  return typeof code === 'string' ? code : undefined;
}

// ─────────────────────────────────────────────────────────────
// 错误 → 用户可读文案
// ─────────────────────────────────────────────────────────────

/**
 * `NODE_OFFLINE` 与 `NODE_ERROR` 的文案**必须不同**：
 * 前者是「连不上节点」（查网络 / 插件是否在跑 / 心跳是否超时），
 * 后者是「节点在线但拒绝了操作」（查 Agent 返回的 agentCode，比如 UNSUPPORTED / NO_LUCKPERMS）。
 * 排查方向完全不同，合并成一句话就是把运维时间扔掉。
 */
export function describeApiError(error: ApiError): string {
  switch (error.code) {
    case 'NODE_OFFLINE':
      return `节点离线：${error.message}`;
    case 'NODE_ERROR':
      return `节点拒绝了操作：${error.agentCode ? `[${error.agentCode}] ` : ''}${error.message}`;
    case 'NODE_REJECTED':
      return `节点拒绝了操作：${error.agentCode ? `[${error.agentCode}] ` : ''}${error.message}`;
    case 'FORBIDDEN':
      return `缺少权限：${error.message}`;
    case 'UNAUTHENTICATED':
      return '会话已过期，请重新登录';
    case 'INVALID_PARAMS':
      return `参数校验失败：${error.message}`;
    case 'NOT_FOUND':
      return `资源不存在：${error.message}`;
    case 'CONFLICT':
      return `状态冲突：${error.message}`;
    case 'RATE_LIMITED':
      return '请求过于频繁，请稍后再试';
    case 'HTTP_ERROR':
      return error.message;
    default:
      return error.message;
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    return new ApiError({ status: 0, code: 'HTTP_ERROR', message: error.message });
  }
  return new ApiError({ status: 0, code: 'HTTP_ERROR', message: String(error) });
}
