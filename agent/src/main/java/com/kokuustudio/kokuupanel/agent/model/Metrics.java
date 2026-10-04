package com.kokuustudio.kokuupanel.agent.model;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

/**
 * 服务器瞬时指标。逐字对应协议 §5.1 的 {@code Metrics}。
 *
 * <p><b>tps / mspt 取不到时必须是 {@code null}，不要填假值。</b>
 * 编一个 20.0 会让运维看着「一切正常」，比不显示更糟。
 * 所以序列化走 {@link #toJson()}：默认 Gson 会把 null 字段整条省略，
 * 平台前端拿到的就是 undefined 而不是 null。
 */
public final class Metrics {

    /** [1m, 5m, 15m]；取不到时 null。 */
    public double[] tps;
    public Double mspt;
    public int online;
    public int maxPlayers;
    public Memory memory;
    public int threads;
    public long uptimeSeconds;
    public int entities;
    public int chunks;

    public static final class Memory {
        public long used;
        public long max;
        public long free;

        public Memory(long used, long max, long free) {
            this.used = used;
            this.max = max;
            this.free = free;
        }
    }

    /** 显式输出 null 的 JSON 形式。RPC 结果与 server.metrics 事件都用它。 */
    public JsonObject toJson() {
        JsonObject json = new JsonObject();
        if (tps == null || tps.length < 3) {
            json.add("tps", JsonNull.INSTANCE);
        } else {
            JsonArray array = new JsonArray();
            array.add(tps[0]);
            array.add(tps[1]);
            array.add(tps[2]);
            json.add("tps", array);
        }
        if (mspt == null) {
            json.add("mspt", JsonNull.INSTANCE);
        } else {
            json.addProperty("mspt", mspt.doubleValue());
        }
        json.addProperty("online", online);
        json.addProperty("maxPlayers", maxPlayers);
        JsonObject memoryJson = new JsonObject();
        if (memory != null) {
            memoryJson.addProperty("used", memory.used);
            memoryJson.addProperty("max", memory.max);
            memoryJson.addProperty("free", memory.free);
        }
        json.add("memory", memoryJson);
        json.addProperty("threads", threads);
        json.addProperty("uptimeSeconds", uptimeSeconds);
        json.addProperty("entities", entities);
        json.addProperty("chunks", chunks);
        return json;
    }
}
