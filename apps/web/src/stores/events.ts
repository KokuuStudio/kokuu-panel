/**
 * 实时事件（WebSocket）。
 *
 * 三处是刻意的设计，改之前先想清楚：
 *
 * 1. **`subscribed` 帧是唯一可信的订阅列表。** 服务端会把没有权限的
 *    `console:<nodeId>` 静默剔除（docs/API.md），如果本地记「我请求了什么」，
 *    UI 会一直显示「已订阅」却永远收不到日志。所以这里 `topics` 以服务端
 *    回的列表为准，并额外暴露 `rejectedTopics` 让页面能提示原因。
 * 2. **断线自动重连，重连后用「期望列表」重新订阅**（服务端不会记住上一轮的订阅）。
 * 3. **没有任何消息超过 IDLE_TIMEOUT 就主动重连。** 半开连接（TCP 断了但对端
 *    不知道）不会触发 onclose，只有超时能发现 —— 否则界面看着正常，实际早就不推了。
 */
import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref } from 'vue';

import { ApiError } from '@/api/client';
import type { EventFrame, ServerFrame } from '@/api/types';

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
/** 静默多久判定连接已死。 */
const IDLE_TIMEOUT_MS = 90_000;
/** 重连尝试次数上限；超过后进入 `failed`，由用户手动点「重连」。 */
const MAX_ATTEMPTS = 8;

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'subscribed'
  | 'reconnecting'
  | 'failed'
  | 'closed';

export function eventsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/_api/events`;
}

type EventHandler = (frame: EventFrame) => void;

export const useEventsStore = defineStore('events', () => {
  const state = ref<ConnectionState>('idle');
  /** 服务端确认生效的 topic（唯一可信来源）。 */
  const topics = ref<string[]>([]);
  /** 请求过但被服务端剔除的 topic（通常是缺 console.execute 权限）。 */
  const rejectedTopics = ref<string[]>([]);
  const lastEventAt = ref(0);
  const lastError = ref('');
  const reconnectAttempt = ref(0);

  /** 我们「希望」订阅的 topic（跨重连保留）。 */
  const desired = new Set<string>();
  const handlers = new Map<string, Set<EventHandler>>();
  const anyHandlers = new Set<EventHandler>();

  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 关掉页面前主动 close，避免 beforeunload 触发一次无意义的重连。 */
  let intentionalClose = false;

  const connected = computed(() => state.value === 'open' || state.value === 'subscribed');
  const subscribedTopics = computed(() => [...topics.value]);

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdleTimer(): void {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      lastError.value = '连接静默超时，正在重连';
      reconnect();
    }, IDLE_TIMEOUT_MS);
  }

  function send(payload: unknown): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function sendSubscribe(): void {
    if (desired.size === 0) {
      // 服务端握手时默认订阅可能为空；显式发一个空列表也无害。
      send({ type: 'subscribe', topics: [] });
      return;
    }
    send({ type: 'subscribe', topics: [...desired] });
  }

  function emit(frame: EventFrame): void {
    lastEventAt.value = frame.ts || Date.now();
    const set = handlers.get(frame.event);
    if (set) {
      for (const handler of set) {
        try {
          handler(frame);
        } catch (error) {
          console.error('[events] handler failed', frame.event, error);
        }
      }
    }
    for (const handler of anyHandlers) {
      try {
        handler(frame);
      } catch (error) {
        console.error('[events] wildcard handler failed', error);
      }
    }
  }

  function handleFrame(frame: ServerFrame): void {
    armIdleTimer();

    if (frame.type === 'subscribed') {
      const list = (frame as { topics?: unknown }).topics;
      const actual = Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : [];
      topics.value = actual;
      rejectedTopics.value = [...desired].filter((topic) => !actual.includes(topic));
      state.value = 'subscribed';
      if (rejectedTopics.value.length > 0) {
        lastError.value = `以下订阅被服务端拒绝（通常是权限不足）：${rejectedTopics.value.join('、')}`;
      } else {
        lastError.value = '';
      }
      return;
    }

    if (frame.type === 'event') {
      emit(frame as EventFrame);
      return;
    }

    if (frame.type === 'error') {
      const message = (frame as { message?: unknown }).message;
      lastError.value = typeof message === 'string' ? message : '服务端返回了未知错误帧';
    }
  }

  function scheduleReconnect(): void {
    clearReconnectTimer();
    if (intentionalClose) return;
    if (reconnectAttempt.value >= MAX_ATTEMPTS) {
      state.value = 'failed';
      lastError.value = `实时连接重试 ${MAX_ATTEMPTS} 次仍失败，请检查服务状态后手动重连`;
      return;
    }
    reconnectAttempt.value += 1;
    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      BASE_RECONNECT_DELAY_MS * 2 ** (reconnectAttempt.value - 1),
    );
    state.value = 'reconnecting';
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function open(): void {
    if (typeof WebSocket === 'undefined') {
      state.value = 'failed';
      lastError.value = '当前浏览器不支持 WebSocket';
      return;
    }
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    intentionalClose = false;
    state.value = 'connecting';
    let ws: WebSocket;
    try {
      ws = new WebSocket(eventsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      state.value = 'open';
      reconnectAttempt.value = 0;
      lastError.value = '';
      armIdleTimer();
      sendSubscribe();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let parsed: ServerFrame;
      try {
        parsed = JSON.parse(event.data) as ServerFrame;
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return;
      handleFrame(parsed);
    };

    ws.onerror = () => {
      // onerror 之后一定会有 onclose，重连逻辑放在 onclose。
      lastError.value = '实时连接发生错误';
    };

    ws.onclose = (event: CloseEvent) => {
      // 先判断这是不是「当前」连接：手动 reconnect / 断开后，旧 socket 的
      // onclose 可能晚一步到达。如果让它继续往下跑，它会清空新连接的 topics
      // 并再排一次重连，结果就是「界面显示未连接、实际已经连上」。
      if (socket !== ws) return;
      socket = null;
      clearIdleTimer();
      topics.value = [];
      if (intentionalClose) {
        state.value = 'closed';
        return;
      }
      if (event.code === 1008 || event.code === 4401) {
        // 未登录时服务端直接关闭，没必要疯狂重连。
        state.value = 'failed';
        lastError.value = '实时连接被拒绝：会话无效或已过期，请重新登录';
        return;
      }
      scheduleReconnect();
    };
  }

  /** 建立连接（幂等）。 */
  function connect(): void {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    reconnectAttempt.value = 0;
    clearReconnectTimer();
    open();
  }

  function disconnect(): void {
    intentionalClose = true;
    clearReconnectTimer();
    clearIdleTimer();
    if (socket) {
      try {
        socket.close(1000, 'client disconnect');
      } catch {
        // ignore
      }
      socket = null;
    }
    topics.value = [];
    state.value = 'closed';
  }

  /** 手动重连（失败后由用户触发）。 */
  function reconnect(): void {
    clearReconnectTimer();
    clearIdleTimer();
    intentionalClose = true;
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
      socket = null;
    }
    intentionalClose = false;
    reconnectAttempt.value = 0;
    open();
  }

  /**
   * 订阅。返回一个退订函数，交给 `onScopeDispose` / `onUnmounted` 调用。
   * 引用计数：多个组件订阅同一 topic 时只在最后一个退订后才真正发 unsub。
   */
  function subscribe(topic: string): () => void {
    const created = !desired.has(topic);
    desired.add(topic);
    if (created) {
      // 注意：这里**不**往 topics 里塞本地请求的 topic。
      // topics 只由服务端 `subscribed` 帧写入 —— 请求 ≠ 生效。
      connect();
      if (connected.value) sendSubscribe();
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      desired.delete(topic);
      topics.value = topics.value.filter((item) => item !== topic);
      rejectedTopics.value = rejectedTopics.value.filter((item) => item !== topic);
      if (connected.value) sendSubscribe();
    };
  }

  /** 监听某个事件名；返回取消函数。 */
  function on(event: string, handler: EventHandler): () => void {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set && set.size === 0) handlers.delete(event);
    };
  }

  /** 监听所有事件（Dashboard 的「最近事件」用）。 */
  function onAny(handler: EventHandler): () => void {
    anyHandlers.add(handler);
    return () => {
      anyHandlers.delete(handler);
    };
  }

  onScopeDispose(() => {
    disconnect();
  });

  function describeError(error: unknown): string {
    if (error instanceof ApiError) return error.message;
    return error instanceof Error ? error.message : String(error);
  }

  return {
    state,
    connected,
    topics,
    subscribedTopics,
    rejectedTopics,
    lastEventAt,
    lastError,
    reconnectAttempt,
    connect,
    disconnect,
    reconnect,
    subscribe,
    on,
    onAny,
    describeError,
  };
});
