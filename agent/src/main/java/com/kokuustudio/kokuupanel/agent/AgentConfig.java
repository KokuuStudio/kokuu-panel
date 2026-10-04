package com.kokuustudio.kokuupanel.agent;

import java.util.ArrayList;
import java.util.List;
import org.bukkit.configuration.file.FileConfiguration;

/**
 * config.yml 的类型化快照。
 *
 * <p>读配置只在这里做一次，其余代码拿的是不可变字段 —— 避免「配置读到一半
 * 被 /kp reload 换掉」这种半新半旧的状态。
 *
 * <p>所有键都有代码内兜底默认值：老 config.yml 缺新键时不会 NPE，
 * 也不会因为插件升级就必须删配置文件。
 */
public final class AgentConfig {

    public static final int DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 15;
    public static final int DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 45;
    public static final long HARD_MAX_BACKOFF_MS = 5L * 60L * 1000L;

    public final String panelUrl;
    public final String nodeId;
    public final String secret;
    public final boolean readOnly;
    /** server.info 里的显示名；空表示自动探测（见 ServerInfoCollector.resolveName）。 */
    public final String serverName;

    public final int heartbeatIntervalSeconds;
    public final int heartbeatTimeoutSeconds;

    public final long reconnectMinBackoffMs;
    public final long reconnectMaxBackoffMs;
    public final int reconnectJitterPercent;

    public final long mainThreadTimeoutMs;
    public final long outboundTimeoutMs;

    public final boolean eventsJoin;
    public final boolean eventsQuit;
    public final boolean eventsChat;
    public final boolean eventsDeath;
    public final boolean eventsCommand;
    public final boolean eventsConsole;
    public final boolean eventsMetrics;

    public final int metricsIntervalSeconds;
    public final boolean tickCounterFallback;

    public final int consoleMaxOutputLines;
    public final int consoleMaxLinesPerSecond;

    public final boolean punishFailClosed;
    public final int punishStaleWarnMinutes;
    public final String punishBanMessage;
    public final String punishUnavailableMessage;
    public final String punishMuteMessage;

    public final int economyIdempotencyTtlHours;

    public final long commandDefaultBanSeconds;

    /** 配置本身的疑点（缺 nodeId 等），启动时打成 WARN 提示用户。 */
    public final List<String> warnings;

    private AgentConfig(FileConfiguration config) {
        this.panelUrl = trim(config.getString("panelUrl", "ws://127.0.0.1:8787"));
        this.nodeId = trim(config.getString("nodeId", ""));
        this.secret = trim(config.getString("secret", ""));
        this.readOnly = config.getBoolean("readOnly", false);
        this.serverName = trim(config.getString("serverName", ""));

        this.heartbeatIntervalSeconds = clamp(
                config.getInt("heartbeat.intervalSeconds", DEFAULT_HEARTBEAT_INTERVAL_SECONDS), 1, 3600);
        this.heartbeatTimeoutSeconds = clamp(
                config.getInt("heartbeat.timeoutSeconds", DEFAULT_HEARTBEAT_TIMEOUT_SECONDS),
                heartbeatIntervalSeconds, 24 * 3600);

        long minBackoff = clamp(config.getInt("reconnect.minBackoffSeconds", 1), 1, 3600) * 1000L;
        long maxBackoff = clamp(config.getInt("reconnect.maxBackoffSeconds", 300), 1, 24 * 3600) * 1000L;
        if (maxBackoff < minBackoff) {
            maxBackoff = minBackoff;
        }
        // 协议要求退避上限最长 5 分钟；配置里写更大也不认。
        this.reconnectMinBackoffMs = Math.min(minBackoff, HARD_MAX_BACKOFF_MS);
        this.reconnectMaxBackoffMs = Math.min(maxBackoff, HARD_MAX_BACKOFF_MS);
        this.reconnectJitterPercent = clamp(config.getInt("reconnect.jitterPercent", 20), 0, 80);

        this.mainThreadTimeoutMs = clamp(config.getLong("rpc.mainThreadTimeoutMs", 8000L), 100L, 600_000L);
        this.outboundTimeoutMs = clamp(config.getLong("rpc.outboundTimeoutMs", 10_000L), 100L, 600_000L);

        this.eventsJoin = config.getBoolean("events.join", true);
        this.eventsQuit = config.getBoolean("events.quit", true);
        this.eventsChat = config.getBoolean("events.chat", true);
        this.eventsDeath = config.getBoolean("events.death", true);
        this.eventsCommand = config.getBoolean("events.command", true);
        // 协议 §7：控制台全量转发默认关闭。
        this.eventsConsole = config.getBoolean("events.console", false);
        this.eventsMetrics = config.getBoolean("events.metrics", true);

        this.metricsIntervalSeconds = clamp(config.getInt("metrics.metricsIntervalSeconds", 10), 1, 3600);
        this.tickCounterFallback = config.getBoolean("metrics.tickCounterFallback", true);

        this.consoleMaxOutputLines = clamp(config.getInt("console.maxOutputLines", 200), 1, 10_000);
        this.consoleMaxLinesPerSecond = clamp(config.getInt("console.maxLinesPerSecond", 200), 1, 100_000);

        this.punishFailClosed = config.getBoolean("punish.failClosed", false);
        this.punishStaleWarnMinutes = clamp(config.getInt("punish.staleWarnMinutes", 30), 0, 24 * 60);
        this.punishBanMessage = config.getString("punish.banMessage",
                "&c你已被本服务器封禁：&f${reason}${expires}");
        this.punishUnavailableMessage = config.getString("punish.unavailableMessage",
                "&c本服务器暂时无法校验封禁状态，请稍后再试");
        this.punishMuteMessage = config.getString("punish.muteMessage",
                "&c你已被禁言：&f${reason}${expires}");

        // 协议要求幂等缓存 TTL >= 24h，配小了也按 24 算。
        this.economyIdempotencyTtlHours = clamp(
                config.getInt("economy.idempotencyTtlHours", 24), 24, 24 * 365);

        this.commandDefaultBanSeconds = clamp(config.getLong("command.defaultBanSeconds", 0L), 0L,
                365L * 24 * 3600);

        List<String> problems = new ArrayList<String>();
        if (nodeId.isEmpty() || secret.isEmpty()) {
            problems.add("config.yml 里的 nodeId / secret 还没填：请到平台的节点页面创建节点，"
                    + "把密钥填进来再 /kp reload。现在连接一定会被 UNAUTHORIZED 拒绝。");
        }
        if (panelUrl.startsWith("ws://") && !isLocal(panelUrl)) {
            problems.add("panelUrl 用的是 ws://（明文）。节点密钥在 hello 帧里明文传输，"
                    + "非本机地址请改用 wss://。");
        }
        this.warnings = problems;
    }

    public static AgentConfig load(FileConfiguration configuration) {
        return new AgentConfig(configuration);
    }

    private static boolean isLocal(String url) {
        return url.contains("127.0.0.1") || url.contains("localhost") || url.contains("[::1]");
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }

    private static int clamp(int value, int min, int max) {
        return value < min ? min : (value > max ? max : value);
    }

    private static long clamp(long value, long min, long max) {
        return value < min ? min : (value > max ? max : value);
    }
}
