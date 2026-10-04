package com.kokuustudio.kokuupanel.agent.events;

import com.google.gson.JsonObject;
import com.kokuustudio.kokuupanel.agent.AgentConfig;
import com.kokuustudio.kokuupanel.agent.KokuuAgentPlugin;
import com.kokuustudio.kokuupanel.agent.protocol.Protocol;
import com.kokuustudio.kokuupanel.agent.ws.ConnectionManager;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Agent → 平台事件上报（协议 §7）。
 *
 * <p>三条铁律：
 * <ol>
 *   <li>事件**不保证送达、不重传** —— 未连接时直接丢弃，不排队、不落盘。
 *       事件用于「观察」而非「记账」；需要保证的状态全走请求-响应。</li>
 *   <li>{@code console.line} 默认关闭，打开后单连接每秒最多 N 行，
 *       超出丢弃并在下一条里带 {@code dropped: N}（协议 §7）。</li>
 *   <li>上报路径里不许再打日志 —— 否则「日志 → 事件 → 日志」会自激。</li>
 * </ol>
 */
public final class EventReporter {

    private final KokuuAgentPlugin plugin;
    private final ConnectionManager connection;

    private final AtomicLong consoleWindowStartMs = new AtomicLong();
    private final AtomicInteger consoleSentInWindow = new AtomicInteger();
    private final AtomicInteger consoleDropped = new AtomicInteger();
    private final AtomicLong consoleDroppedTotal = new AtomicLong();
    private final AtomicLong consoleSentTotal = new AtomicLong();

    public EventReporter(KokuuAgentPlugin plugin, ConnectionManager connection) {
        this.plugin = plugin;
        this.connection = connection;
    }

    /** 未连接时静默丢弃。 */
    public void emit(String name, Object data) {
        if (!connection.isAuthenticated()) {
            return;
        }
        if (!enabled(name)) {
            return;
        }
        connection.send(Protocol.event(name, data));
    }

    public boolean enabled(String name) {
        AgentConfig config = plugin.config();
        if ("player.join".equals(name)) {
            return config.eventsJoin;
        }
        if ("player.quit".equals(name)) {
            return config.eventsQuit;
        }
        if ("player.chat".equals(name)) {
            return config.eventsChat;
        }
        if ("player.death".equals(name)) {
            return config.eventsDeath;
        }
        if ("player.command".equals(name)) {
            return config.eventsCommand;
        }
        if ("server.metrics".equals(name)) {
            return config.eventsMetrics;
        }
        if ("console.line".equals(name)) {
            return config.eventsConsole;
        }
        // 封禁 / 白名单变更这类低量但语义重要的事件没有开关，一直上报。
        return true;
    }

    /**
     * 控制台行（协议 §7 的采样与限流）。
     *
     * <p>超出配额的行直接丢；丢了多少会挂在**下一条**发出去的行的
     * {@code dropped} 字段上 —— 有丢包但没人知道，比丢包本身更糟。
     */
    public void consoleLine(String line, String level) {
        if (!connection.isAuthenticated() || !plugin.config().eventsConsole) {
            return;
        }
        int limit = plugin.config().consoleMaxLinesPerSecond;
        long now = System.currentTimeMillis();
        long windowStart = consoleWindowStartMs.get();
        if (now - windowStart >= 1000L) {
            if (consoleWindowStartMs.compareAndSet(windowStart, now)) {
                consoleSentInWindow.set(0);
            }
        }
        if (consoleSentInWindow.incrementAndGet() > limit) {
            consoleDropped.incrementAndGet();
            consoleDroppedTotal.incrementAndGet();
            return;
        }
        JsonObject data = new JsonObject();
        data.addProperty("line", line);
        data.addProperty("level", level == null ? "INFO" : level);
        int dropped = consoleDropped.getAndSet(0);
        if (dropped > 0) {
            data.addProperty("dropped", dropped);
        }
        consoleSentTotal.incrementAndGet();
        connection.send(Protocol.event("console.line", data));
    }

    public long consoleDroppedTotal() {
        return consoleDroppedTotal.get();
    }

    public long consoleSentTotal() {
        return consoleSentTotal.get();
    }
}
