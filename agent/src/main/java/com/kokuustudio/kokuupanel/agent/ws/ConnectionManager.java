package com.kokuustudio.kokuupanel.agent.ws;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.reflect.TypeToken;
import com.kokuustudio.kokuupanel.agent.AgentConfig;
import com.kokuustudio.kokuupanel.agent.model.Punishment;
import com.kokuustudio.kokuupanel.agent.protocol.ErrorCode;
import com.kokuustudio.kokuupanel.agent.protocol.Protocol;
import java.lang.reflect.Field;
import java.lang.reflect.Type;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Random;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Level;
import org.java_websocket.WebSocket;
import org.java_websocket.enums.ReadyState;

/**
 * 连接生命周期：外连、握手、心跳、指数退避重连、半开检测。
 *
 * <p>对应协议 §2（连接与握手）与 §3（心跳）。
 *
 * <p>关键行为：
 * <ul>
 *   <li>连上就发 hello，且 hello 必须是第一个帧。</li>
 *   <li>{@code UNAUTHORIZED} → 记 ERROR + 退避重连（上限 5 分钟）。</li>
 *   <li>{@code PROTOCOL_MISMATCH} → 记 ERROR 并 <b>停止重连</b>，提示升级插件。</li>
 *   <li>{@code NODE_DISABLED} → 记 WARN + 退避重连。</li>
 *   <li>超时没收到平台的任何帧 → 判定半开连接，主动断开重连。</li>
 * </ul>
 *
 * <p>这个类不认识 Bukkit：所有外部依赖都走 {@link ConnectionHost}。
 */
public final class ConnectionManager {

    /** 单次 TCP+握手 的容忍时间；超过就认为这次尝试挂了，另起一次。 */
    private static final long CONNECT_TIMEOUT_MS = 20_000L;
    /** 连上后多久还没握手成功就重连。 */
    private static final long HELLO_TIMEOUT_MS = 10_000L;
    private static final long WATCHDOG_PERIOD_SECONDS = 5L;

    private final ConnectionHost host;
    private final ScheduledExecutorService scheduler;
    private final PendingRequests pending;

    private volatile WsConnection connection;
    private volatile boolean authenticated;
    private volatile boolean stopRequested;
    /** PROTOCOL_MISMATCH：不再重连，直到人工 /kp reload。 */
    private volatile boolean halted;
    private volatile String haltReason = "";

    private volatile long lastInboundAt;
    private volatile long lastPingAt;
    private volatile long connectedAt;
    private volatile long connectStartedAt;
    private volatile long authenticatedAt;
    private volatile String sessionId = "";
    private volatile long serverHeartbeatMs;
    private volatile String helloRequestId;
    private volatile List<String> serverCapabilities = Collections.emptyList();

    private final AtomicInteger attempts = new AtomicInteger();
    private final Random random = new Random();
    private ScheduledFuture<?> reconnectFuture;
    private ScheduledFuture<?> watchdogFuture;

    public ConnectionManager(ConnectionHost host) {
        this.host = host;
        this.pending = new PendingRequests(host.logger());
        this.scheduler = Executors.newSingleThreadScheduledExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable runnable) {
                Thread thread = new Thread(runnable, "kokuu-agent-connection");
                thread.setDaemon(true);
                return thread;
            }
        });
        this.serverHeartbeatMs = host.config().heartbeatIntervalSeconds * 1000L;
    }

    // ── 生命周期 ──────────────────────────────────────────────────────────

    public void start() {
        watchdogFuture = scheduler.scheduleWithFixedDelay(new Runnable() {
            @Override
            public void run() {
                try {
                    watchdog();
                } catch (Throwable t) {
                    host.logger().log(Level.FINE, "心跳看门狗异常", t);
                }
            }
        }, WATCHDOG_PERIOD_SECONDS, WATCHDOG_PERIOD_SECONDS, TimeUnit.SECONDS);
        scheduler.execute(new Runnable() {
            @Override
            public void run() {
                connectNow();
            }
        });
    }

    /** 关服 / 停用插件。 */
    public void stop() {
        stopRequested = true;
        cancel(reconnectFuture);
        cancel(watchdogFuture);
        closeQuietly(connection, "agent shutdown");
        pending.failAll("Agent 已停止");
        scheduler.shutdownNow();
    }

    /**
     * /kp reload 用：清掉 PROTOCOL_MISMATCH 的停止标记并按新配置重连。
     *
     * @return 之前是否处于「已停止重连」状态
     */
    public boolean resetAndReconnect() {
        boolean wasHalted = halted;
        halted = false;
        haltReason = "";
        stopRequested = false;
        attempts.set(0);
        cancel(reconnectFuture);
        closeQuietly(connection, "reload");
        scheduler.execute(new Runnable() {
            @Override
            public void run() {
                connectNow();
            }
        });
        return wasHalted;
    }

    // ── 连接 ──────────────────────────────────────────────────────────────

    private void connectNow() {
        if (stopRequested || halted) {
            return;
        }
        long now = System.currentTimeMillis();
        if (attemptInFlight(now)) {
            return;
        }
        closeQuietly(connection, "replacing connection");

        URI uri;
        try {
            uri = resolveUri();
        } catch (URISyntaxException e) {
            host.logger().severe("panelUrl 不是合法的 URL：" + host.config().panelUrl
                    + "（" + e.getMessage() + "）");
            halted = true;
            haltReason = "panelUrl 无法解析";
            return;
        }

        WsConnection fresh = new WsConnection(uri, this);
        fresh.setConnectionLostTimeout((int) Math.max(15L, host.config().heartbeatTimeoutSeconds));
        connection = fresh;
        connectStartedAt = now;
        lastInboundAt = now;
        authenticated = false;
        host.logger().info("正在连接平台 " + safeUri(uri));
        try {
            fresh.connect();
        } catch (Throwable t) {
            host.logger().log(Level.WARNING, "发起连接失败: " + describe(t));
            scheduleReconnect();
        }
    }

    private boolean attemptInFlight(long now) {
        WsConnection current = connection;
        if (current == null) {
            return false;
        }
        ReadyState state = current.getReadyState();
        if (state == ReadyState.OPEN || state == ReadyState.CLOSING) {
            return true;
        }
        if (state == ReadyState.NOT_YET_CONNECTED) {
            return now - connectStartedAt < CONNECT_TIMEOUT_MS;
        }
        return false;
    }

    /**
     * panelUrl → WebSocket URI。
     *
     * <p>宽容一点：用户很可能把面板的 HTTP 地址直接贴进来。
     * {@code http://} → {@code ws://}、{@code https://} → {@code wss://}，
     * 没有 scheme 按 {@code ws://} 处理，路径末尾补 {@code /agent}（协议 §2 的端点）。
     */
    URI resolveUri() throws URISyntaxException {
        String raw = host.config().panelUrl;
        if (raw == null || raw.isEmpty()) {
            throw new URISyntaxException("", "panelUrl 为空");
        }
        String normalized = raw.trim();
        if (normalized.startsWith("https://")) {
            normalized = "wss://" + normalized.substring("https://".length());
        } else if (normalized.startsWith("http://")) {
            normalized = "ws://" + normalized.substring("http://".length());
        } else if (!normalized.startsWith("ws://") && !normalized.startsWith("wss://")) {
            normalized = "ws://" + normalized;
        }
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        if (!normalized.endsWith("/agent")) {
            normalized = normalized + "/agent";
        }
        return new URI(normalized);
    }

    private void scheduleReconnect() {
        if (stopRequested || halted) {
            return;
        }
        synchronized (this) {
            if (reconnectFuture != null && !reconnectFuture.isDone()) {
                return;
            }
            final int attempt = attempts.getAndIncrement();
            AgentConfig config = host.config();
            long delay = backoffDelay(attempt, config.reconnectMinBackoffMs,
                    config.reconnectMaxBackoffMs, config.reconnectJitterPercent,
                    random.nextDouble());
            host.logger().info("将在 " + (delay / 1000.0D) + "s 后重连（第 "
                    + (attempt + 1) + " 次尝试）");
            reconnectFuture = scheduler.schedule(new Runnable() {
                @Override
                public void run() {
                    connectNow();
                }
            }, delay, TimeUnit.MILLISECONDS);
        }
    }

    private static void cancel(ScheduledFuture<?> future) {
        if (future != null) {
            future.cancel(false);
        }
    }

    /**
     * 指数退避 + 抖动。
     *
     * <p>抽成静态方法是为了能单独验证：协议要求上限 5 分钟。
     *
     * @param random01 [0,1) 的随机数
     */
    static long backoffDelay(int attempt, long minMs, long maxMs, int jitterPercent, double random01) {
        long delay = minMs;
        for (int i = 0; i < attempt; i++) {
            if (delay >= maxMs) {
                break;
            }
            delay = delay * 2L;
            if (delay <= 0L) {
                delay = maxMs;
                break;
            }
        }
        if (delay > maxMs) {
            delay = maxMs;
        }
        if (jitterPercent > 0) {
            double factor = 1.0D + ((random01 * 2.0D) - 1.0D) * (jitterPercent / 100.0D);
            delay = (long) (delay * factor);
        }
        delay = Math.max(200L, delay);
        return Math.min(delay, AgentConfig.HARD_MAX_BACKOFF_MS);
    }

    // ── 看门狗：半开连接 ──────────────────────────────────────────────────

    private void watchdog() {
        if (stopRequested || halted) {
            return;
        }
        WsConnection current = connection;
        long now = System.currentTimeMillis();
        if (current == null) {
            scheduleReconnect();
            return;
        }
        ReadyState state = current.getReadyState();
        if (state == ReadyState.OPEN) {
            long idle = now - lastInboundAt;
            // 判定基准取「配置的超时」与「平台心跳的 3 倍」里更大的那个：
            // 平台把心跳调长了也不该被误判。
            long allowed = Math.max(host.config().heartbeatTimeoutSeconds * 1000L,
                    serverHeartbeatMs * 3L);
            if (authenticated && idle > allowed) {
                host.logger().warning("已 " + (idle / 1000L) + "s 没收到平台的任何帧"
                        + "（心跳间隔 " + (serverHeartbeatMs / 1000L) + "s），"
                        + "判定连接半开（TCP 已断但对端未感知），主动重连");
                closeQuietly(current, "heartbeat timeout");
                return;
            }
            if (!authenticated && now - connectStartedAt > HELLO_TIMEOUT_MS) {
                host.logger().warning("连接已建立但 " + (HELLO_TIMEOUT_MS / 1000L)
                        + "s 内没有完成握手，主动重连");
                closeQuietly(current, "hello timeout");
            }
            return;
        }
        if (state == ReadyState.CLOSED) {
            scheduleReconnect();
        }
    }

    // ── WebSocket 回调（WS 读线程） ────────────────────────────────────────

    public void onOpen(WsConnection source) {
        if (source != connection) {
            closeQuietly(source, "stale connection");
            return;
        }
        connectedAt = System.currentTimeMillis();
        lastInboundAt = connectedAt;
        lastPingAt = connectedAt;
        authenticated = false;
        sendHello(source);
    }

    public void onMessage(WsConnection source, String text) {
        if (source != connection) {
            return;
        }
        lastInboundAt = System.currentTimeMillis();
        JsonObject frame = Protocol.parseObject(text);
        if (frame == null) {
            // 解析不了的帧记日志并丢弃，**不要断开** —— 断开会把一次脏数据
            // 放大成一整轮重连。
            host.logger().fine("收到无法解析的帧，已丢弃");
            return;
        }
        String type = Protocol.typeOf(frame);
        if (Protocol.TYPE_REQUEST.equals(type)) {
            handleRequest(frame);
        } else if (Protocol.TYPE_RESPONSE.equals(type)) {
            handleResponse(frame);
        } else if (Protocol.TYPE_EVENT.equals(type)) {
            handleEvent(frame);
        } else {
            // 协议 §8：不能因为不认识就断线，次版本会新增东西。
            host.logger().fine("收到未知类型的帧: " + type);
        }
    }

    public void onClose(WsConnection source, int code, String reason, boolean remote) {
        if (source != connection) {
            return;
        }
        boolean wasAuthenticated = authenticated;
        authenticated = false;
        helloRequestId = null;
        pending.failAll("与平台的连接已断开");
        if (stopRequested) {
            host.logger().info("与平台的连接已关闭（code=" + code + "）");
            return;
        }
        if (halted) {
            host.logger().warning("连接已关闭，且重连已停止：" + haltReason);
            return;
        }
        host.logger().warning((wasAuthenticated ? "与平台的连接断开" : "连接未能建立")
                + "（code=" + code + ", reason=" + (reason == null ? "" : reason)
                + ", remote=" + remote + "），准备重连");
        scheduleReconnect();
    }

    public void onError(WsConnection source, Exception exception) {
        if (source != connection) {
            return;
        }
        // 连接失败时 Java-WebSocket 会先 onError 再 onClose，重连统一由 onClose 触发，
        // 这里只记日志，避免出现两条重连线。
        host.logger().log(Level.FINE, "WebSocket 错误: " + describe(exception));
    }

    // ── 帧处理 ────────────────────────────────────────────────────────────

    /**
     * 握手：hello 必须是连接建立后的第一个帧（协议 §2）。
     *
     * <p>服务端在收到 hello 之前不接受任何其他帧，超时 5s 直接关闭连接 ——
     * 所以这里在 {@code onOpen} 里同步就发，不排队、不等任何别的东西。
     */
    private void sendHello(WsConnection target) {
        AgentConfig current = host.config();
        JsonObject agent = new JsonObject();
        agent.addProperty("version", host.agentVersion());
        agent.addProperty("mcVersion", host.mcVersion());
        agent.addProperty("brand", host.brand());
        agent.addProperty("javaVersion", System.getProperty("java.version", ""));

        List<String> declared = host.declaredCapabilities();
        JsonObject params = new JsonObject();
        params.addProperty("protocolVersion", Protocol.VERSION);
        params.addProperty("nodeId", current.nodeId);
        params.addProperty("secret", current.secret);
        params.add("agent", agent);
        JsonArray capabilities = new JsonArray();
        for (String capability : declared) {
            capabilities.add(capability);
        }
        params.add("capabilities", capabilities);

        String id = pending.nextId();
        helloRequestId = id;
        host.logger().info("发送 hello（协议 v" + Protocol.VERSION + "，能力：" + declared + "）");
        if (!send(Protocol.encode(Protocol.request(id, Protocol.HELLO_METHOD, params)), target)) {
            host.logger().warning("hello 发送失败，连接可能已经关闭");
        }
    }

    private void handleRequest(JsonObject frame) {
        String id = Protocol.string(frame, "id");
        String method = Protocol.string(frame, "method");
        if (id == null || method == null) {
            host.logger().fine("收到缺少 id/method 的请求帧，已丢弃");
            return;
        }
        if (!authenticated) {
            host.logger().warning("握手完成前收到请求 " + method + "，已丢弃");
            return;
        }
        if (Protocol.METHOD_PING.equals(method)) {
            // 心跳走快路径，不排队等主线程：主线程被别的插件卡住时，
            // 平台不该把「服务器卡」误判成「节点掉线」。
            // ping 不碰任何 Bukkit 状态，放在 WS 线程上是安全的。
            lastPingAt = System.currentTimeMillis();
            JsonObject params = Protocol.object(frame, "params");
            String nonce = Protocol.string(params, "nonce");
            if (nonce == null) {
                nonce = Long.toString(System.nanoTime());
            }
            JsonObject result = new JsonObject();
            result.addProperty("nonce", nonce);
            send(Protocol.responseOk(id, result));
            return;
        }
        JsonObject response = host.dispatcher().dispatch(id, method, frame.get("params"));
        send(response);
    }

    private void handleResponse(JsonObject frame) {
        String id = Protocol.string(frame, "id");
        if (id == null) {
            return;
        }
        if (helloRequestId != null && helloRequestId.equals(id)) {
            handleHelloResponse(frame);
            return;
        }
        pending.complete(frame);
    }

    private void handleHelloResponse(JsonObject frame) {
        helloRequestId = null;
        WsConnection current = connection;
        if (Protocol.bool(frame, "ok", false)) {
            applyHelloResult(Protocol.object(frame, "result"));
            authenticated = true;
            authenticatedAt = System.currentTimeMillis();
            lastInboundAt = authenticatedAt;
            attempts.set(0);
            host.logger().info("已连接平台：session=" + sessionId
                    + " 心跳=" + (serverHeartbeatMs / 1000L) + "s 平台能力=" + serverCapabilities);
            return;
        }

        String code = Protocol.errorCode(frame);
        String message = Protocol.errorMessage(frame);
        if (ErrorCode.PROTOCOL_MISMATCH.name().equals(code)) {
            // 协议 §2：不匹配直接停止重连。反复重连只会把日志刷满，
            // 真正要做的动作是「运维去升级插件」，那就必须让人看见。
            halted = true;
            haltReason = "平台拒绝协议版本 v" + Protocol.VERSION + "：" + message;
            host.logger().severe("协议版本不匹配：" + message
                    + "。本插件实现协议 v" + Protocol.VERSION
                    + "，已停止重连，请升级 KokuuAgent 插件后 /kp reload。");
        } else if (ErrorCode.UNAUTHORIZED.name().equals(code)) {
            host.logger().severe("节点认证失败（nodeId 或 secret 不正确/已被轮换）：" + message
                    + "。将按指数退避重连（最长 5 分钟）。");
        } else if (ErrorCode.NODE_DISABLED.name().equals(code)) {
            host.logger().warning("节点已被平台停用：" + message + "。将按指数退避重连。");
        } else {
            host.logger().severe("握手失败 " + code + "：" + message);
        }
        closeQuietly(current, "hello rejected: " + code);
    }

    private void applyHelloResult(JsonObject result) {
        if (result == null) {
            return;
        }
        String session = Protocol.string(result, "sessionId");
        sessionId = session == null ? "" : session;

        long heartbeat = Protocol.longValue(result, "heartbeatIntervalMs", 0L);
        if (heartbeat > 0L) {
            serverHeartbeatMs = heartbeat;
        }

        List<String> capabilities = new ArrayList<String>();
        JsonElement capabilityElement = result.get("capabilities");
        if (capabilityElement != null && capabilityElement.isJsonArray()) {
            for (JsonElement element : capabilityElement.getAsJsonArray()) {
                if (element != null && element.isJsonPrimitive()
                        && element.getAsJsonPrimitive().isString()) {
                    capabilities.add(element.getAsString());
                }
            }
        }
        serverCapabilities = Collections.unmodifiableList(capabilities);

        JsonObject punish = Protocol.object(result, "punish");
        if (punish != null) {
            long revision = Protocol.longValue(punish, "revision", 0L);
            List<Punishment> active = parsePunishments(punish.get("active"));
            host.punishSnapshot().replace(revision, active);
            host.logger().info("已接收封禁快照：revision=" + revision
                    + " 生效中=" + active.size() + " 条");
        }

        JsonObject economy = Protocol.object(result, "economy");
        if (economy != null) {
            host.applyEconomyInfo(Protocol.string(economy, "backend"),
                    Protocol.string(economy, "currency"));
        }

        // 能力按**我们自己**声明的算：平台回的那份可能被裁剪过，
        // 而「节点未声明该 capability」的判定主体是节点自己（协议 §4 UNSUPPORTED）。
        host.dispatcher().setCapabilities(host.declaredCapabilities());
    }

    private static List<Punishment> parsePunishments(JsonElement element) {
        if (element == null || !element.isJsonArray()) {
            return Collections.emptyList();
        }
        Type type = new TypeToken<List<Punishment>>() { }.getType();
        try {
            List<Punishment> parsed = Protocol.gson().fromJson(element, type);
            return parsed == null ? Collections.<Punishment>emptyList() : parsed;
        } catch (RuntimeException e) {
            return Collections.emptyList();
        }
    }

    private void handleEvent(JsonObject frame) {
        String name = Protocol.string(frame, "event");
        if (name == null) {
            return;
        }
        if (Protocol.EVENT_PUNISH_SYNC.equals(name)) {
            JsonObject data = Protocol.object(frame, "data");
            if (data == null) {
                return;
            }
            long revision = Protocol.longValue(data, "revision", host.punishSnapshot().revision());
            List<Punishment> active = parsePunishments(data.get("active"));
            long previousRevision = host.punishSnapshot().revision();
            host.punishSnapshot().replace(revision, active);
            host.logger().info("封禁快照已同步：revision " + previousRevision + " → " + revision
                    + "，生效中 " + active.size() + " 条");
            return;
        }
        // 平台可能会推我们还不认识的事件（协议 §8 的次版本变更），忽略即可。
        host.logger().fine("忽略未知事件 " + name);
    }

    // ── 发送 / 请求 ───────────────────────────────────────────────────────

    public boolean send(JsonObject frame) {
        return send(Protocol.encode(frame), connection);
    }

    private boolean send(String text, WsConnection target) {
        if (target == null) {
            return false;
        }
        try {
            if (target.getReadyState() != ReadyState.OPEN) {
                return false;
            }
            target.send(text);
            return true;
        } catch (Throwable t) {
            host.logger().fine("发送帧失败: " + describe(t));
            return false;
        }
    }

    /**
     * Agent → 平台请求（协议 §6）。
     *
     * <p>未连接时立刻以失败完成，绝不让调用方（例如 /kp info）挂在那里等。
     */
    public CompletableFuture<JsonObject> request(String method, Object params, long timeoutMs) {
        WsConnection current = connection;
        if (!authenticated || current == null || current.getReadyState() != ReadyState.OPEN) {
            CompletableFuture<JsonObject> failed = new CompletableFuture<JsonObject>();
            failed.completeExceptionally(new PendingRequests.PlatformError(ErrorCode.INTERNAL,
                    "当前没有连接到平台，无法调用 " + method, null));
            return failed;
        }
        final String id = pending.nextId();
        final CompletableFuture<JsonObject> future = pending.register(id);
        scheduler.schedule(new Runnable() {
            @Override
            public void run() {
                pending.fail(id, "平台在超时时间内没有响应");
            }
        }, timeoutMs, TimeUnit.MILLISECONDS);
        if (!send(Protocol.encode(Protocol.request(id, method, params)), current)) {
            pending.fail(id, "发送失败：连接已断开");
        }
        return future;
    }

    // ── 状态（/kp status） ────────────────────────────────────────────────

    public boolean isAuthenticated() {
        return authenticated;
    }

    public boolean isHalted() {
        return halted;
    }

    public String getHaltReason() {
        return haltReason;
    }

    public String getSessionId() {
        return sessionId;
    }

    public long getServerHeartbeatMs() {
        return serverHeartbeatMs;
    }

    public List<String> getServerCapabilities() {
        return serverCapabilities;
    }

    public int getReconnectAttempts() {
        return attempts.get();
    }

    public long getLastInboundAt() {
        return lastInboundAt;
    }

    public long getLastPingAt() {
        return lastPingAt;
    }

    public long getAuthenticatedAt() {
        return authenticatedAt;
    }

    public int pendingCount() {
        return pending.size();
    }

    /** Java-WebSocket 内部出站队列深度（发不出去时能直接看出堆积）。 */
    public int outQueueDepth() {
        WsConnection current = connection;
        if (current == null) {
            return 0;
        }
        try {
            WebSocket socket = current.getConnection();
            if (socket == null) {
                return 0;
            }
            Field field = socket.getClass().getField("outQueue");
            Object value = field.get(socket);
            if (value instanceof Collection) {
                return ((Collection<?>) value).size();
            }
        } catch (Throwable ignored) {
            // 版本变化拿不到就算了，状态页显示 0。
        }
        return 0;
    }

    public String getPanelUrl() {
        try {
            return safeUri(resolveUri());
        } catch (URISyntaxException e) {
            return host.config().panelUrl;
        }
    }

    public String getConnectionState() {
        WsConnection current = connection;
        if (stopRequested) {
            return "已停止";
        }
        if (halted) {
            return "已停止重连（协议不匹配）";
        }
        if (current == null) {
            return "未连接";
        }
        ReadyState state = current.getReadyState();
        if (state == ReadyState.OPEN) {
            return authenticated ? "已连接（已握手）" : "已连接（握手中）";
        }
        if (state == ReadyState.NOT_YET_CONNECTED) {
            return "连接中";
        }
        if (state == ReadyState.CLOSING) {
            return "正在关闭";
        }
        return "已断开，等待重连";
    }

    private static String safeUri(URI uri) {
        return uri == null ? "" : uri.toString();
    }

    private static String describe(Throwable throwable) {
        if (throwable == null) {
            return "未知异常";
        }
        String message = throwable.getMessage();
        return throwable.getClass().getSimpleName() + (message == null ? "" : ": " + message);
    }

    private void closeQuietly(WsConnection target, String reason) {
        if (target == null) {
            return;
        }
        try {
            target.close(1000, reason == null ? "" : reason);
        } catch (Throwable t) {
            // 未连接/已关闭时 close() 可能抛，忽略。
            host.logger().fine("关闭连接时出错: " + describe(t));
        }
    }
}
