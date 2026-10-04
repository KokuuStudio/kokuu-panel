package com.kokuustudio.kokuupanel.agent.protocol;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

/**
 * 帧的编解码。逐字对应 docs/PROTOCOL.md §3。
 *
 * <pre>
 * request   { "type":"request",  "id":"7f3a…", "method":"players.list", "params":{} }
 * response  { "type":"response", "id":"7f3a…", "ok":true,  "result":{} }
 *           { "type":"response", "id":"7f3a…", "ok":false, "error":{"code":…} }
 * event     { "type":"event",    "event":"player.join", "ts":…, "data":{} }
 * </pre>
 *
 * <p>入站帧一律先解析成 {@link JsonObject} 再按 {@code type} 分派。
 * **未知 type 必须容忍并丢弃**，不能当成协议错误断开 —— 第 8 节说新增方法
 * 属于次版本变更，老 Agent 遇到不认识的东西要能继续跑。
 */
public final class Protocol {

    /** hello 里交换的协议版本。 */
    public static final int VERSION = 1;

    /** 握手前必须发出的方法名。 */
    public static final String HELLO_METHOD = "hello";

    public static final String TYPE_REQUEST = "request";
    public static final String TYPE_RESPONSE = "response";
    public static final String TYPE_EVENT = "event";

    /** 平台广播的封禁全量快照事件（Server → Agent，不在 §7 的 Agent→Server 表里）。 */
    public static final String EVENT_PUNISH_SYNC = "punish.sync";

    /** 心跳请求的方法名。Agent 收到必须回响应（协议里叫「回 pong」）。 */
    public static final String METHOD_PING = "ping";

    /**
     * 默认 Gson：null 字段直接省略。
     * 这对 {@code PlayerEntry.ip} 是必须的 —— 协议要求「仅 withIp=true 时返回」，
     * 而不是返回一个 null 字段。
     *
     * <p>需要「显式 null」的载荷（{@code Metrics.tps/mspt}）不走这里，
     * 各自提供 {@code toJson()}。
     */
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    private Protocol() {
    }

    public static Gson gson() {
        return GSON;
    }

    /**
     * 解析入站文本帧。
     *
     * @return JSON 对象，或 {@code null} 表示这帧不合法（调用方记日志并丢弃，**不要断开**）
     */
    public static JsonObject parseObject(String raw) {
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        JsonElement element;
        try {
            element = JsonParser.parseString(raw);
        } catch (RuntimeException e) {
            return null;
        }
        if (element == null || !element.isJsonObject()) {
            return null;
        }
        return element.getAsJsonObject();
    }

    public static String encode(JsonObject frame) {
        return GSON.toJson(frame);
    }

    // ── 帧构造 ────────────────────────────────────────────────────────────

    public static JsonObject request(String id, String method, Object params) {
        JsonObject frame = new JsonObject();
        frame.addProperty("type", TYPE_REQUEST);
        frame.addProperty("id", id);
        frame.addProperty("method", method);
        frame.add("params", params == null ? new JsonObject() : GSON.toJsonTree(params));
        return frame;
    }

    public static JsonObject responseOk(String id, Object result) {
        JsonObject frame = new JsonObject();
        frame.addProperty("type", TYPE_RESPONSE);
        frame.addProperty("id", id);
        frame.addProperty("ok", true);
        frame.add("result", result == null ? new JsonObject() : GSON.toJsonTree(result));
        return frame;
    }

    public static JsonObject responseError(String id, ErrorCode code, String message, Object data) {
        JsonObject error = new JsonObject();
        error.addProperty("code", code.name());
        error.addProperty("message", message == null ? "" : message);
        if (data != null) {
            error.add("data", GSON.toJsonTree(data));
        }
        JsonObject frame = new JsonObject();
        frame.addProperty("type", TYPE_RESPONSE);
        frame.addProperty("id", id);
        frame.addProperty("ok", false);
        frame.add("error", error);
        return frame;
    }

    public static JsonObject event(String name, Object data) {
        JsonObject frame = new JsonObject();
        frame.addProperty("type", TYPE_EVENT);
        frame.addProperty("event", name);
        frame.addProperty("ts", System.currentTimeMillis());
        frame.add("data", data == null ? new JsonObject() : GSON.toJsonTree(data));
        return frame;
    }

    // ── 取值助手（一律做类型检查，不做隐式转换） ────────────────────────────

    /** type 字段；不是字符串就返回 null。 */
    public static String typeOf(JsonObject frame) {
        return string(frame, "type");
    }

    public static String string(JsonObject frame, String key) {
        if (frame == null) {
            return null;
        }
        JsonElement element = frame.get(key);
        if (element == null || !element.isJsonPrimitive()) {
            return null;
        }
        JsonPrimitive primitive = element.getAsJsonPrimitive();
        return primitive.isString() ? primitive.getAsString() : null;
    }

    public static boolean bool(JsonObject frame, String key, boolean fallback) {
        if (frame == null) {
            return fallback;
        }
        JsonElement element = frame.get(key);
        if (element == null || !element.isJsonPrimitive()) {
            return fallback;
        }
        JsonPrimitive primitive = element.getAsJsonPrimitive();
        return primitive.isBoolean() ? primitive.getAsBoolean() : fallback;
    }

    public static long longValue(JsonObject frame, String key, long fallback) {
        if (frame == null) {
            return fallback;
        }
        JsonElement element = frame.get(key);
        if (element == null || !element.isJsonPrimitive()) {
            return fallback;
        }
        JsonPrimitive primitive = element.getAsJsonPrimitive();
        try {
            return primitive.isNumber() ? primitive.getAsLong() : fallback;
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    public static JsonObject object(JsonObject frame, String key) {
        if (frame == null) {
            return null;
        }
        JsonElement element = frame.get(key);
        return element != null && element.isJsonObject() ? element.getAsJsonObject() : null;
    }

    /** 从响应帧里取 error.code；没有就返回 null。 */
    public static String errorCode(JsonObject response) {
        return string(object(response, "error"), "code");
    }

    public static String errorMessage(JsonObject response) {
        JsonObject error = object(response, "error");
        String message = string(error, "message");
        return message == null ? "未知错误" : message;
    }

    /** 把错误码字符串映射回枚举；不认识的一律算 INTERNAL。 */
    public static ErrorCode toErrorCode(String raw) {
        if (raw == null) {
            return ErrorCode.INTERNAL;
        }
        for (ErrorCode code : ErrorCode.values()) {
            if (code.name().equals(raw)) {
                return code;
            }
        }
        return ErrorCode.INTERNAL;
    }
}
