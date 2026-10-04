package com.kokuustudio.kokuupanel.agent.ws;

import com.google.gson.JsonObject;
import com.kokuustudio.kokuupanel.agent.protocol.Protocol;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Logger;

/**
 * 出站请求的 id 空间与等待表。
 *
 * <p>协议 §3：{@code id} 只在发起方一侧唯一，两边各自维护 id 空间。
 * 所以这里就是一个自增整数。
 *
 * <p>连接断开时全部失败 —— 否则 {@code /kp info} 这类调用会一直挂着等到超时。
 */
public final class PendingRequests {

    private final AtomicLong sequence = new AtomicLong();
    private final Map<String, CompletableFuture<JsonObject>> waiting =
            new ConcurrentHashMap<String, CompletableFuture<JsonObject>>();
    private final Logger logger;

    public PendingRequests(Logger logger) {
        this.logger = logger;
    }

    public String nextId() {
        return Long.toString(sequence.incrementAndGet());
    }

    public CompletableFuture<JsonObject> register(String id) {
        CompletableFuture<JsonObject> future = new CompletableFuture<JsonObject>();
        waiting.put(id, future);
        return future;
    }

    /** 收到响应帧。返回 false 表示这是一个没人等的 id（多半是上一个连接的残留）。 */
    public boolean complete(JsonObject response) {
        String id = Protocol.string(response, "id");
        if (id == null) {
            return false;
        }
        CompletableFuture<JsonObject> future = waiting.remove(id);
        if (future == null) {
            logger.fine("收到未知 id 的响应: " + id);
            return false;
        }
        if (Protocol.bool(response, "ok", false)) {
            future.complete(response);
        } else {
            future.completeExceptionally(new PlatformError(
                    Protocol.toErrorCode(Protocol.errorCode(response)),
                    Protocol.errorMessage(response),
                    Protocol.object(response, "error")));
        }
        return true;
    }

    public void fail(String id, String message) {
        CompletableFuture<JsonObject> future = waiting.remove(id);
        if (future != null) {
            future.completeExceptionally(new PlatformError(
                    com.kokuustudio.kokuupanel.agent.protocol.ErrorCode.INTERNAL, message, null));
        }
    }

    public void failAll(String message) {
        for (String id : waiting.keySet()) {
            fail(id, message);
        }
        waiting.clear();
    }

    public int size() {
        return waiting.size();
    }

    /** 平台返回的错误，带协议错误码。 */
    public static final class PlatformError extends RuntimeException {
        private static final long serialVersionUID = 1L;
        private final com.kokuustudio.kokuupanel.agent.protocol.ErrorCode code;
        private final transient JsonObject error;

        PlatformError(com.kokuustudio.kokuupanel.agent.protocol.ErrorCode code, String message,
                      JsonObject error) {
            super(message);
            this.code = code;
            this.error = error;
        }

        public com.kokuustudio.kokuupanel.agent.protocol.ErrorCode getCode() {
            return code;
        }

        public JsonObject getError() {
            return error;
        }
    }
}
