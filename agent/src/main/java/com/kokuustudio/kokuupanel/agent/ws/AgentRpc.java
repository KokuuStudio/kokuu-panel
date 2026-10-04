package com.kokuustudio.kokuupanel.agent.ws;

import com.google.gson.JsonObject;
import com.kokuustudio.kokuupanel.agent.KokuuAgentPlugin;
import com.kokuustudio.kokuupanel.agent.protocol.Protocol;
import java.util.concurrent.CompletableFuture;

/**
 * Agent → 平台请求（协议 §6）。
 *
 * <p>只有三个：{@code player.resolve} / {@code punish.snapshot} / {@code economy.stats}。
 * 用途是让游戏内的 {@code /kp info}、{@code /kp ban} 这类操作**也进平台的审计日志** ——
 * 平台能从中知道「谁在哪个服上干了什么」。
 */
public final class AgentRpc {

    private final KokuuAgentPlugin plugin;
    private final ConnectionManager connection;

    public AgentRpc(KokuuAgentPlugin plugin, ConnectionManager connection) {
        this.plugin = plugin;
        this.connection = connection;
    }

    public CompletableFuture<JsonObject> call(String method, JsonObject params) {
        return connection.request(method, params, plugin.config().outboundTimeoutMs);
    }

    /** 按名字问平台：全名是什么、知不知道这个人、历史处罚。 */
    public CompletableFuture<JsonObject> resolvePlayer(String name) {
        JsonObject params = new JsonObject();
        params.addProperty("name", name);
        return call("player.resolve", params);
    }

    public CompletableFuture<JsonObject> punishSnapshot() {
        return call("punish.snapshot", new JsonObject());
    }

    public CompletableFuture<JsonObject> economyStats() {
        return call("economy.stats", new JsonObject());
    }

    /** 从响应帧里取 result；没有就返回空对象。 */
    public static JsonObject resultOf(JsonObject response) {
        JsonObject result = Protocol.object(response, "result");
        return result == null ? new JsonObject() : result;
    }
}
