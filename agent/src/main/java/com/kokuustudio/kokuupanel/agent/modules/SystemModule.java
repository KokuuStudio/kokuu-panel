package com.kokuustudio.kokuupanel.agent.modules;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.kokuustudio.kokuupanel.agent.Capabilities;
import com.kokuustudio.kokuupanel.agent.KokuuAgentPlugin;
import com.kokuustudio.kokuupanel.agent.metrics.MetricsCollector;
import com.kokuustudio.kokuupanel.agent.metrics.ServerInfoCollector;
import com.kokuustudio.kokuupanel.agent.protocol.AgentException;
import com.kokuustudio.kokuupanel.agent.protocol.ErrorCode;
import com.kokuustudio.kokuupanel.agent.rpc.MainThreadExecutor;
import com.kokuustudio.kokuupanel.agent.rpc.Params;
import com.kokuustudio.kokuupanel.agent.rpc.RpcDispatcher;
import java.util.regex.Pattern;
import org.bukkit.Bukkit;

/**
 * 系统方法：{@code ping} / {@code server.info} / {@code server.metrics} / {@code console.execute}
 * （协议 §5.1）。
 */
public final class SystemModule {

    /** 换行会把一条命令变成多条 —— 这是控制台注入最基本的入口（协议 §5.1 的 schema）。 */
    private static final Pattern NO_NEWLINE = Pattern.compile("[^\\r\\n]+");

    private final KokuuAgentPlugin plugin;
    private final MetricsCollector metricsCollector;

    public SystemModule(KokuuAgentPlugin plugin, MetricsCollector metricsCollector) {
        this.plugin = plugin;
        this.metricsCollector = metricsCollector;
    }

    public void register(RpcDispatcher dispatcher) {
        dispatcher.register("ping", null, false, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                // 正常情况下 ConnectionManager 会在 WS 线程上直接回它，
                // 这里保留一份是为了「不管从哪条路进来都答得上」。
                String nonce = params.optionalString("nonce", 128);
                params.done();
                JsonObject result = new JsonObject();
                result.addProperty("nonce", nonce == null ? Long.toString(System.nanoTime()) : nonce);
                return result;
            }
        });

        dispatcher.register("server.info", null, false, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                params.done();
                return ServerInfoCollector.collect(plugin.config().serverName);
            }
        });

        dispatcher.register("server.metrics", null, false, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                params.done();
                return metricsCollector.collect().toJson();
            }
        });

        dispatcher.register("console.execute", Capabilities.CONSOLE, true, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                return execute(params);
            }
        });
    }

    /**
     * 执行一条控制台命令并捕获回显。
     *
     * <p>用一个自定义 {@link CapturingCommandSender} 收 output —— 这是唯一能拿到
     * 命令输出的办法（{@code Bukkit.getConsoleSender()} 的输出直接进服务端日志，
     * 插件侧看不到）。
     */
    private Object execute(Params params) {
        String command = params.string("command", true, 1000, NO_NEWLINE,
                "命令不能为空，且不能包含换行");
        params.done();

        String normalized = command.startsWith("/") ? command.substring(1) : command;
        CapturingCommandSender sender =
                new CapturingCommandSender(plugin.config().consoleMaxOutputLines);

        boolean success;
        try {
            success = Bukkit.dispatchCommand(sender, normalized);
        } catch (Throwable t) {
            // 命令执行时抛出的异常要变成明确的 INTERNAL，
            // 不能让它吃掉响应让平台等满超时。
            throw new AgentException(ErrorCode.INTERNAL,
                    "执行命令时抛出异常: " + MainThreadExecutor.describe(t), t);
        }

        JsonArray output = new JsonArray();
        for (String line : sender.lines()) {
            output.add(line);
        }
        JsonObject result = new JsonObject();
        result.addProperty("success", success);
        result.add("output", output);
        return result;
    }
}
