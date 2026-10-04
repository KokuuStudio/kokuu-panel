package com.kokuustudio.kokuupanel.agent;

import com.kokuustudio.kokuupanel.agent.command.KpCommand;
import com.kokuustudio.kokuupanel.agent.economy.IdempotencyStore;
import com.kokuustudio.kokuupanel.agent.events.ConsoleLogHandler;
import com.kokuustudio.kokuupanel.agent.events.EventReporter;
import com.kokuustudio.kokuupanel.agent.events.PlayerEventListener;
import com.kokuustudio.kokuupanel.agent.hooks.LuckPermsHook;
import com.kokuustudio.kokuupanel.agent.hooks.VaultHook;
import com.kokuustudio.kokuupanel.agent.metrics.MetricsCollector;
import com.kokuustudio.kokuupanel.agent.modules.EconomyModule;
import com.kokuustudio.kokuupanel.agent.modules.LuckPermsModule;
import com.kokuustudio.kokuupanel.agent.modules.PlayerModule;
import com.kokuustudio.kokuupanel.agent.modules.SystemModule;
import com.kokuustudio.kokuupanel.agent.modules.WhitelistModule;
import com.kokuustudio.kokuupanel.agent.protocol.Protocol;
import com.kokuustudio.kokuupanel.agent.punish.MuteGate;
import com.kokuustudio.kokuupanel.agent.punish.PunishChatListener;
import com.kokuustudio.kokuupanel.agent.punish.PunishLoginListener;
import com.kokuustudio.kokuupanel.agent.punish.PunishModule;
import com.kokuustudio.kokuupanel.agent.punish.PunishSnapshot;
import com.kokuustudio.kokuupanel.agent.rpc.MainThreadExecutor;
import com.kokuustudio.kokuupanel.agent.rpc.RpcDispatcher;
import com.kokuustudio.kokuupanel.agent.ws.AgentRpc;
import com.kokuustudio.kokuupanel.agent.ws.ConnectionHost;
import com.kokuustudio.kokuupanel.agent.ws.ConnectionManager;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.logging.Level;
import java.util.logging.Logger;
import org.bukkit.Bukkit;
import org.bukkit.event.Listener;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

/**
 * KokuuAgent：KokuuPanel 的 Minecraft 服务端侧插件。
 *
 * <p>整体形状（对应 docs/ARCHITECTURE.md §1）：
 * <pre>
 *   onEnable
 *     ├─ 读配置
 *     ├─ 探测 LuckPerms / Vault（决定能力自述）
 *     ├─ 注册 RPC 方法（六个模块）
 *     ├─ 注册事件监听（join/quit/chat/death/command/登录拦截/聊天禁言）
 *     ├─ 起定时任务（tick 计数、metrics 上报、幂等缓存刷盘）
 *     └─ 主动外连平台（ConnectionManager）
 * </pre>
 *
 * <p>不接管服务端启停、不做聊天室 —— 架构文档 §8 的「明确不做」。
 */
public final class KokuuAgentPlugin extends JavaPlugin implements ConnectionHost {

    private volatile AgentConfig config;

    private MainThreadExecutor mainThread;
    private RpcDispatcher dispatcher;
    private ConnectionManager connection;
    private EventReporter events;
    private MetricsCollector metricsCollector;
    private PunishSnapshot punishSnapshot;
    private PunishModule punishModule;
    private LuckPermsHook luckPermsHook;
    private VaultHook vaultHook;
    private IdempotencyStore idempotencyStore;
    private AgentRpc rpc;
    private ConsoleLogHandler consoleLogHandler;
    private final List<BukkitTask> tasks = new ArrayList<BukkitTask>();

    private volatile String economyBackend = "";
    private volatile String economyCurrency = "";

    /**
     * 上一次 {@code hello} 帧里实际发出去的能力集。
     *
     * 用来判断「本地能力变了但平台还不知道」—— 协议里没有「能力变更」帧，
     * 所以只能靠重连让新的 hello 带上新能力集。见 {@link #watchCapabilities()}。
     */
    private volatile List<String> announcedCapabilities = new ArrayList<String>();

    @Override
    public void onEnable() {
        // 首次启动生成带中文注释的 config.yml（之后不再覆盖，避免吃掉用户的注释）。
        saveDefaultConfig();
        config = AgentConfig.load(getConfig());
        for (String warning : config.warnings) {
            getLogger().warning(warning);
        }

        mainThread = new MainThreadExecutor(this, config.mainThreadTimeoutMs);
        dispatcher = new RpcDispatcher(getLogger(), mainThread);
        dispatcher.setReadOnly(config.readOnly);

        luckPermsHook = new LuckPermsHook(getLogger());
        vaultHook = new VaultHook(getLogger());

        // 静默探测：这一次的结果只用于「该不该注册 economy/luckperms 模块」，
        // 不作为对外能力自述 —— 此刻服务端还没启动完，CMI 这类插件可能还没把
        // 经济后端注册进 Vault。真正的能力判定在 startConnectionAfterStartup()
        // 里做（那时服务端已就绪），所以这里不必打日志，否则每次启动都会留一条
        // 「没有可用的经济后端」的误导性 WARN。
        luckPermsHook.probe(true);
        vaultHook.probe(true);

        punishSnapshot = new PunishSnapshot();
        idempotencyStore = new IdempotencyStore(getLogger(),
                new File(getDataFolder(), "idempotency.json"), config.economyIdempotencyTtlHours);
        metricsCollector = new MetricsCollector(config);

        connection = new ConnectionManager(this);
        events = new EventReporter(this, connection);
        punishModule = new PunishModule(this, punishSnapshot, events);
        rpc = new AgentRpc(this, connection);

        registerModules();
        dispatcher.setCapabilities(declaredCapabilities());

        registerListeners();
        registerCommand();
        attachConsoleHandler();
        startTasks();

        // 幂等缓存异步载入：几万条记录也不该拖慢启动。
        Bukkit.getScheduler().runTaskAsynchronously(this, new Runnable() {
            @Override
            public void run() {
                idempotencyStore.load();
            }
        });

        startConnectionAfterStartup();
        getLogger().info("KokuuAgent v" + getDescription().getVersion() + " 已启用"
                + "（协议 v" + Protocol.VERSION + "）");
        if (config.readOnly) {
            getLogger().info("当前是只读模式：所有写操作会被拒绝（config.yml 的 readOnly）。");
        }
    }

    @Override
    public void onDisable() {
        if (connection != null) {
            connection.stop();
        }
        for (BukkitTask task : tasks) {
            try {
                task.cancel();
            } catch (Throwable ignored) {
                // 关服时 scheduler 可能已经停了。
            }
        }
        tasks.clear();
        if (consoleLogHandler != null) {
            ConsoleLogHandler.detach(Bukkit.getLogger(), consoleLogHandler);
            consoleLogHandler = null;
        }
        if (idempotencyStore != null) {
            // 关服时同步刷一次：经济幂等键丢一条就等于多一次重复发钱的风险。
            idempotencyStore.flushIfDirty();
        }
        getLogger().info("KokuuAgent 已停用。");
    }

    // ── 组装 ──────────────────────────────────────────────────────────────

    private void registerModules() {
        new SystemModule(this, metricsCollector).register(dispatcher);
        new PlayerModule(this).register(dispatcher);
        // 用同一个 PunishModule 实例：/kp ban 走的就是它，两条路径的状态必须是一份。
        punishModule.register(dispatcher);
        new WhitelistModule(events).register(dispatcher);
        new LuckPermsModule(luckPermsHook).register(dispatcher);
        new EconomyModule(this, vaultHook, idempotencyStore).register(dispatcher);
    }

    private void registerListeners() {
        register(new PlayerEventListener(this, events));
        register(new PunishLoginListener(this, punishSnapshot, connection));
        MuteGate gate = new MuteGate(this, punishSnapshot);
        register(new PunishChatListener(gate));
        registerPaperChatListener(gate);
    }

    private void register(Listener listener) {
        getServer().getPluginManager().registerEvents(listener, this);
    }

    /**
     * Paper 的 {@code AsyncChatEvent} 监听器用反射注册。
     *
     * <p>这个事件 1.19+ 才有；在 1.12.2/Spigot 上直接引用那个类会
     * {@code NoClassDefFoundError}。所以先探测类在不在，再用反射 newInstance ——
     * 这样插件本体永远不会加载到缺失的类。
     */
    private void registerPaperChatListener(MuteGate gate) {
        final String eventClass = "io.papermc.paper.event.player.AsyncChatEvent";
        final String listenerClass = "com.kokuustudio.kokuupanel.agent.punish.PaperChatListener";
        try {
            Class.forName(eventClass);
        } catch (Throwable notPresent) {
            getLogger().info("本服务端没有 Paper 的 AsyncChatEvent，聊天禁言只用传统事件（正常）。");
            return;
        }
        try {
            Class<?> impl = Class.forName(listenerClass);
            Listener listener = (Listener) impl.getDeclaredConstructor(MuteGate.class)
                    .newInstance(gate);
            register(listener);
        } catch (Throwable t) {
            getLogger().log(Level.WARNING, "注册 Paper 聊天监听器失败（禁言可能只对传统事件生效）", t);
        }
    }

    private void registerCommand() {
        KpCommand executor = new KpCommand(this);
        if (getCommand("kp") != null) {
            getCommand("kp").setExecutor(executor);
            getCommand("kp").setTabCompleter(executor);
        } else {
            getLogger().severe("plugin.yml 里没有定义命令 kp，/kp 命令不可用。");
        }
    }

    private void attachConsoleHandler() {
        if (!config.eventsConsole) {
            return;
        }
        consoleLogHandler = ConsoleLogHandler.attach(Bukkit.getLogger(), events);
        getLogger().info("console.line 事件已开启：单连接每秒最多 "
                + config.consoleMaxLinesPerSecond + " 行，超出丢弃并在下一条带 dropped。");
    }

    private void startTasks() {
        cancelTasks();
        if (config.tickCounterFallback) {
            // 每 tick 一次；Paper 的 getTPS() 拿不到时靠它算真实 TPS。
            tasks.add(Bukkit.getScheduler().runTaskTimer(this, metricsCollector.tickCounter(), 1L, 1L));
        }
        long periodTicks = config.metricsIntervalSeconds * 20L;
        if (config.eventsMetrics) {
            tasks.add(Bukkit.getScheduler().runTaskTimer(this, new Runnable() {
                @Override
                public void run() {
                    metricsCollector.setConfig(config);
                    events.emit("server.metrics", metricsCollector.collect().toJson());
                }
            }, periodTicks, periodTicks));
        }
        tasks.add(Bukkit.getScheduler().runTaskTimerAsynchronously(this, new Runnable() {
            @Override
            public void run() {
                idempotencyStore.flushIfDirty();
            }
        }, 600L, 600L));

        // 能力看门狗：每 30 秒一次。内部只在「还有 hook 没就绪」时才真探测，
        // 所以常态下几乎零开销。
        tasks.add(Bukkit.getScheduler().runTaskTimer(this, new Runnable() {
            @Override
            public void run() {
                watchCapabilities();
            }
        }, 600L, 600L));
    }

    /**
     * 延迟到「服务端跑完启动流程」之后再连平台。
     *
     * <p>为什么不能直接在 {@code onEnable} 里连：Bukkit 的调度器只在主循环里跑，
     * 而主循环是在 {@code Done (Xs)!} 之后才开始的 —— 所以从这个 task 里发起连接，
     * 等价于「服务端已就绪」。在 1.12.2 + CMI 上实测到了不这么做会踩的两个坑：
     *
     * <ol>
     *   <li><b>能力集残缺</b>：CMI 的经济后端比本插件晚约 12 秒才注册进 Vault，
     *       而 {@code hello} 里的 capabilities 是握手那一刻定格的 ——
     *       平台会一直以为这个节点没有 {@code economy}，把经济入口藏起来。
     *       （实测：平台侧看到的能力集少了 economy。）</li>
     *   <li><b>启动期请求超时</b>：平台握手后立刻问 {@code server.info}，
     *       而主线程还忙着加载插件，超过了本插件 8 秒的主线程超时门限，
     *       平台拿到一个 TIMEOUT。（实测日志：{@code 方法 server.info 失败: TIMEOUT}。）</li>
     * </ol>
     *
     * <p>晚连 2 秒对运维没有影响：控制台捕获在 {@code onEnable} 就已经挂上，
     * 这里只是晚一点把缓冲的日志推上去。
     */
    private void startConnectionAfterStartup() {
        Bukkit.getScheduler().runTaskLater(this, new Runnable() {
            @Override
            public void run() {
                reprobeHooks();
                List<String> caps = declaredCapabilities();
                dispatcher.setCapabilities(caps);
                announcedCapabilities = caps;
                if (luckPermsHook.isAvailable() || vaultHook.isAvailable()) {
                    getLogger().info("连接前探测到的能力：" + join(caps));
                }
                connection.start();
            }
        }, 40L);
    }

    /**
     * 能力看门狗。
     *
     * <p>{@code hello} 里的能力集是握手那一刻定格的，而有些插件（实测 CMI）会在
     * 服务端启动后十几秒才把经济/权限后端注册进 Vault。协议里没有「能力变更」帧，
     * 所以探到变化就<b>重连一次</b>，让新的 {@code hello} 带上完整能力集。
     *
     * <p>只在「插件在但还没就绪」时才真去探测 —— 没装就永远不用探，
     * 装好了也不用再探，避免每 30 秒白构造一次桥接对象。
     */
    private void watchCapabilities() {
        boolean pending = (luckPermsHook.pluginPresent() && !luckPermsHook.isAvailable())
                || (vaultHook.pluginPresent() && !vaultHook.isAvailable());
        if (!pending) {
            return;
        }

        luckPermsHook.probe(true);
        vaultHook.probe(true);

        List<String> caps = declaredCapabilities();
        if (caps.equals(announcedCapabilities)) {
            return;
        }

        getLogger().info("能力集变化：" + join(announcedCapabilities) + " → " + join(caps)
                + "，重连一次让平台刷新（服务端刚把后端准备好）。");
        dispatcher.setCapabilities(caps);
        announcedCapabilities = caps;
        connection.resetAndReconnect();
    }

    private void cancelTasks() {
        for (BukkitTask task : tasks) {
            try {
                task.cancel();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
        tasks.clear();
    }

    // ── /kp reload ────────────────────────────────────────────────────────

    /** 重载配置、重探能力、按需重连。 */
    public void reloadEverything() {
        AgentConfig previous = config;
        reloadConfig();
        AgentConfig fresh = AgentConfig.load(getConfig());
        config = fresh;
        for (String warning : fresh.warnings) {
            getLogger().warning(warning);
        }
        mainThread.setTimeoutMs(fresh.mainThreadTimeoutMs);
        dispatcher.setReadOnly(fresh.readOnly);
        metricsCollector.setConfig(fresh);

        reprobeHooks();
        List<String> reloadedCaps = declaredCapabilities();
        dispatcher.setCapabilities(reloadedCaps);
        announcedCapabilities = reloadedCaps;
        startTasks();

        if (fresh.eventsConsole && consoleLogHandler == null) {
            attachConsoleHandler();
        } else if (!fresh.eventsConsole && consoleLogHandler != null) {
            ConsoleLogHandler.detach(Bukkit.getLogger(), consoleLogHandler);
            consoleLogHandler = null;
        }

        if (fresh.economyIdempotencyTtlHours != previous.economyIdempotencyTtlHours) {
            getLogger().warning("economy.idempotencyTtlHours 改了：TTL 在启动时确定，"
                    + "需要重启服务端才生效（本次仍按 " + previous.economyIdempotencyTtlHours + "h 运行）。");
        }

        boolean endpointChanged = !previous.panelUrl.equals(fresh.panelUrl)
                || !previous.nodeId.equals(fresh.nodeId)
                || !previous.secret.equals(fresh.secret);
        if (endpointChanged || connection.isHalted()) {
            getLogger().info("连接参数变化或之前已停止重连，重新建立连接。");
            connection.resetAndReconnect();
        }
    }

    private void reprobeHooks() {
        luckPermsHook.probe();
        vaultHook.probe();
    }

    // ── 对外状态 ──────────────────────────────────────────────────────────

    /**
     * 能力自述。没装 LuckPerms 就不报 luckperms，没装 Vault 就不报 economy ——
     * 平台据此隐藏入口，用户看不到点了会报错的功能（架构文档 §4.3）。
     */
    public List<String> declaredCapabilities() {
        List<String> capabilities = new ArrayList<String>();
        capabilities.add(Capabilities.CONSOLE);
        capabilities.add(Capabilities.PLAYERS);
        capabilities.add(Capabilities.PUNISH);
        capabilities.add(Capabilities.WHITELIST);
        if (luckPermsHook != null && luckPermsHook.isAvailable()) {
            capabilities.add(Capabilities.LUCKPERMS);
        }
        if (vaultHook != null && vaultHook.isAvailable()) {
            capabilities.add(Capabilities.ECONOMY);
        }
        return capabilities;
    }

    /** 主线程执行一段代码；关服时静默失败（不能因为这个抛异常）。 */
    public void runOnMain(Runnable task) {
        try {
            if (Bukkit.isPrimaryThread()) {
                task.run();
            } else {
                Bukkit.getScheduler().runTask(this, task);
            }
        } catch (Throwable t) {
            getLogger().fine("无法把回调调度回主线程（服务器可能正在关闭）: " + t);
        }
    }

    public void applyEconomyInfo(String backend, String currency) {
        economyBackend = backend == null ? "" : backend;
        economyCurrency = currency == null ? "" : currency;
    }

    public String economyBackend() {
        return economyBackend;
    }

    public String economyCurrency() {
        return economyCurrency;
    }

    public AgentConfig config() {
        return config;
    }

    // ── ConnectionHost 实现（连接层只认这几个方法，不认识 Bukkit） ─────────

    @Override
    public Logger logger() {
        return getLogger();
    }

    @Override
    public String agentVersion() {
        // 永不返回 null：hello 里的 version 是必填字符串。
        String version = getDescription() == null ? null : getDescription().getVersion();
        return version == null ? "unknown" : version;
    }

    @Override
    public String mcVersion() {
        return Bukkit.getBukkitVersion();
    }

    @Override
    public String brand() {
        return Bukkit.getName();
    }

    public RpcDispatcher dispatcher() {
        return dispatcher;
    }

    public ConnectionManager connection() {
        return connection;
    }

    public AgentRpc rpc() {
        return rpc;
    }

    public EventReporter eventReporter() {
        return events;
    }

    public MetricsCollector metricsCollector() {
        return metricsCollector;
    }

    public PunishSnapshot punishSnapshot() {
        return punishSnapshot;
    }

    public PunishModule punishModule() {
        return punishModule;
    }

    public LuckPermsHook luckPermsHook() {
        return luckPermsHook;
    }

    public VaultHook vaultHook() {
        return vaultHook;
    }

    public IdempotencyStore idempotencyStore() {
        return idempotencyStore;
    }

    private static String join(List<String> values) {
        StringBuilder builder = new StringBuilder();
        for (String value : values) {
            if (builder.length() > 0) {
                builder.append(", ");
            }
            builder.append(value);
        }
        return builder.toString();
    }
}
