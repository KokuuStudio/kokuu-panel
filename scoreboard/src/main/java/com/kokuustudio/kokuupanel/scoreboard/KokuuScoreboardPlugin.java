package com.kokuustudio.kokuupanel.scoreboard;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;
import org.bukkit.scoreboard.Scoreboard;
import org.bukkit.scoreboard.ScoreboardManager;

/**
 * KokuuScoreboard —— 由 config.yml 驱动的侧边栏记分牌。
 *
 * <h2>职责边界</h2>
 *
 * 本插件**只管显示**：它不持有任何数据、不写文件、不连数据库、不和平台通信。
 * 显示什么由 config.yml 里的占位符决定，值从服务端现取（Vault 余额、
 * 玩家状态、自己量的 TPS）。这样它不会成为「另一个真相源」，
 * 出问题也只是少显示一行，不影响任何业务。
 *
 * <h2>刷新模型</h2>
 *
 * <ul>
 *   <li>每 tick 一个任务，只为 {@link TpsMeter} 记时间戳（极轻）；</li>
 *   <li>每 {@code updateIntervalTicks} tick 一个任务，展开占位符并写进
 *       每个玩家自己的 {@link Sidebar}。文本写进 Team 的 prefix/suffix，
 *       不碰 entry —— 所以刷新**不会闪**（原因见 {@link Sidebar} 的类注释）。</li>
 * </ul>
 *
 * <h2>为什么设置侧边栏要「自己抢回来」</h2>
 *
 * 一个玩家同一时刻只能有一块侧边栏。如果还有别的插件（CMI 之类）也在设，
 * 后设置的赢，表现就是两边互相覆盖、看起来在闪。本插件的策略是：
 * 每轮刷新发现当前不是自己的板子就重新设一次，并且**只提醒一次**
 * ——告诉服主去把另一个插件的侧边栏关掉，而不是无限刷日志。
 */
public final class KokuuScoreboardPlugin extends JavaPlugin {

    /** 能看见记分牌。 */
    static final String PERM_USE = "kokuusb.use";
    /** 能用 /kokuusb 开关与重载。 */
    static final String PERM_ADMIN = "kokuusb.admin";

    private BoardSettings settings;
    private EconomyBridge economy;
    private Placeholders placeholders;
    private TpsMeter tps;
    private PingReader ping;

    /** 每个在线玩家一块板子。玩家退出时移除。 */
    private final Map<UUID, Sidebar> boards = new HashMap<UUID, Sidebar>();

    /** 玩家的显式开关（/kokuusb on|off）。没记录过就走 config 的 defaultEnabled。 */
    private final Map<UUID, Boolean> preferences = new HashMap<UUID, Boolean>();

    /** 已经提醒过「板子被别人接管」的玩家，避免每秒刷一行日志。 */
    private final Set<UUID> foreignBoardWarned = new HashSet<UUID>();

    /** 「板子建不出来」只提醒一次 —— 它会在每个玩家 × 每轮刷新上发生。 */
    private boolean sidebarFailureWarned;

    private BukkitTask tickTask;
    private BukkitTask refreshTask;

    @Override
    public void onEnable() {
        saveDefaultConfig();

        tps = new TpsMeter();
        ping = new PingReader(getLogger());
        economy = EconomyBridges.create(getLogger());

        settings = BoardSettings.load(getConfig(), getLogger(), isLegacyServer());
        placeholders = new Placeholders(economy, tps, ping);

        getServer().getPluginManager().registerEvents(new PlayerListener(this), this);

        SbCommand command = new SbCommand(this);
        if (getCommand("kokuusb") != null) {
            getCommand("kokuusb").setExecutor(command);
            getCommand("kokuusb").setTabCompleter(command);
        } else {
            // plugin.yml 里声明了却拿不到，只可能是打包时漏了 plugin.yml。
            getLogger().warning("找不到 kokuusb 命令（plugin.yml 是否打进 jar 了？），/kokuusb 不可用。");
        }

        startTasks();

        /*
         * 延后一 tick 再画第一遍。
         *
         * 不要在 onEnable 里直接构造 Sidebar：那要经过
         * Bukkit.getScoreboardManager()，而它在服务端启动早期可能是 null
         * （世界还没加载完）。跑到下一个 tick 就一定就绪了。
         * 顺带也覆盖了 /reload 场景 —— 那时在线玩家需要立刻重新拿到板子。
         */
        getServer().getScheduler().runTaskLater(this, new Runnable() {
            @Override
            public void run() {
                refreshAll();
            }
        }, 1L);

        getLogger().info("已启用：每 " + settings.updateIntervalTicks() + " tick 刷新一次，共 "
                + settings.lines().size() + " 行。");
    }

    @Override
    public void onDisable() {
        if (tickTask != null) {
            tickTask.cancel();
            tickTask = null;
        }
        if (refreshTask != null) {
            refreshTask.cancel();
            refreshTask = null;
        }
        // 把板子还回主记分板，否则插件卸载后玩家客户端上还留着最后那一帧，
        // 直到他重连或别的插件覆盖它。
        hideAll();
        getLogger().info("已停用。");
    }

    // ── 任务 ────────────────────────────────────────────────────

    private void startTasks() {
        // 每 tick 一次，只记一个时间戳。这是 TpsMeter 唯一的数据来源。
        tickTask = getServer().getScheduler().runTaskTimer(this, new Runnable() {
            @Override
            public void run() {
                tps.tick();
            }
        }, 1L, 1L);

        scheduleRefresh();
    }

    private void scheduleRefresh() {
        if (refreshTask != null) {
            refreshTask.cancel();
        }
        refreshTask = getServer().getScheduler().runTaskTimer(this, new Runnable() {
            @Override
            public void run() {
                refreshAll();
            }
        }, settings.updateIntervalTicks(), settings.updateIntervalTicks());
    }

    // ── 刷新 ────────────────────────────────────────────────────

    void refreshAll() {
        if (getScoreboardManager() == null) {
            // 服务端还没到能造记分板的阶段，这一轮跳过就好。
            return;
        }
        for (Player player : getServer().getOnlinePlayers()) {
            refresh(player);
        }
    }

    /** 按当前配置重画某个玩家的侧边栏；不该显示时把它收掉。 */
    void refresh(Player player) {
        if (player == null || !player.isOnline()) return;

        if (!shouldDisplay(player)) {
            hide(player);
            return;
        }

        ScoreboardManager manager = getScoreboardManager();
        if (manager == null) return;

        UUID id = player.getUniqueId();
        Sidebar sidebar = boards.get(id);

        // 行数变了（reload 过配置）就必须重建 —— Sidebar 不支持增删行。
        if (sidebar != null && sidebar.size() != settings.lines().size()) {
            boards.remove(id);
            sidebar = null;
        }
        if (sidebar == null) {
            try {
                sidebar = new Sidebar(getLogger(), manager, settings.legacy(),
                        settings.objectiveName(), settings.title(), settings.lines());
            } catch (Throwable failure) {
                /*
                 * 构造 Sidebar 会经过 CraftBukkit 的几处长度校验
                 * （registerNewObjective ≤16、registerNewTeam ≤16、
                 * setDisplayName ≤32）。配置里的值都已经过 BoardSettings 校验，
                 * 所以正常不会走到这里 —— 但**必须兜住**：
                 *
                 * 这个异常如果抛出去，会穿过 runTaskTimer 的任务体，
                 * 而 Bukkit 遇到任务抛异常会**取消那个任务**。后果是侧边栏
                 * 从此再也不出现，控制台只刷一次错，看起来像「插件没生效」。
                 *
                 * 所以这里降级成「这一轮不显示」，任务继续活着 ——
                 * 服主改完配置 reload 就能恢复，不必重启。
                 */
                warnSidebarFailureOnce(failure);
                return;
            }
            boards.put(id, sidebar);
        }

        List<String> expanded = new ArrayList<String>(settings.lines().size());
        for (String line : settings.lines()) {
            expanded.add(placeholders.resolve(line, player, settings));
        }
        sidebar.update(expanded);

        if (player.getScoreboard() != sidebar.board()) {
            player.setScoreboard(sidebar.board());
            warnForeignBoardOnce(player);
        }
    }

    /** 这个玩家现在该不该看见记分牌。 */
    private boolean shouldDisplay(Player player) {
        if (!settings.hasContent()) return false;
        if (!player.hasPermission(PERM_USE)) return false;
        if (!settings.allowsWorld(player.getWorld().getName())) return false;

        Boolean preference = preferences.get(player.getUniqueId());
        return preference != null ? preference.booleanValue() : settings.defaultEnabled();
    }

    /**
     * 收掉某个玩家的侧边栏。
     *
     * <h2>顺序不能换</h2>
     *
     * {@code dispose()}（注销 objective）必须在 {@code setScoreboard} 之前 ——
     * 注销是**服务端主动给正在看这块板子的人发清除包**的唯一途径；一旦先把玩家
     * 换回主记分板，他就不再看这块板子了，清除包发不出去，客户端会留着最后一帧。
     * 实测结论与原因见 {@link Sidebar#dispose()}。
     */
    void hide(Player player) {
        if (player == null) return;

        Sidebar sidebar = boards.remove(player.getUniqueId());
        if (sidebar == null) return;

        // 1) 先注销：这一步才会真的把侧边栏从屏幕上清掉。
        sidebar.dispose();

        // 2) 再把玩家换回主记分板，让他回到「没有自定义板子」的干净状态 ——
        //    否则别的插件之后调 player.getScoreboard() 会拿到我们这块空板子。
        if (player.isOnline() && player.getScoreboard() == sidebar.board()) {
            ScoreboardManager manager = getScoreboardManager();
            if (manager != null) {
                player.setScoreboard(manager.getMainScoreboard());
            }
        }
    }

    private void hideAll() {
        for (Player player : getServer().getOnlinePlayers()) {
            hide(player);
        }

        // 兜底：boards 里可能还剩不在线的玩家留下的板子（掉线时 quit 事件没走到，
        // 或者插件正在关停）。没人看它们，但 objective / team 还注册在各自的
        // board 上一并注销掉，别让对象图白白挂着。
        for (Sidebar sidebar : boards.values()) {
            sidebar.dispose();
        }
        boards.clear();
    }

    /**
     * 发现板子被别人接管时提醒一次。
     *
     * 之所以值得占用一行日志：这几乎是**配置问题**的确定信号
     * （服上还有另一个插件的侧边栏开着），而不是本插件的 bug。
     * 不说的话，服主看到的现象是「侧边栏在闪」，很难联想到另一个插件。
     */
    private void warnForeignBoardOnce(Player player) {
        UUID id = player.getUniqueId();
        if (!foreignBoardWarned.add(id)) return;
        getLogger().warning("玩家 " + player.getName() + " 的侧边栏被其它插件改写了，已重新接管。"
                + "如果反复出现，请把那个插件（常见的是 CMI）的 Scoreboard / 侧边栏功能关掉 —— "
                + "一个玩家同一时刻只能有一块侧边栏。");
    }

    /**
     * 板子建不出来时只提醒一次。
     *
     * 只提醒一次很重要：这个错误发生在**每个玩家 × 每一轮刷新**上，
     * 每轮都打会把日志刷满，反而盖住真正有用的信息。
     */
    private void warnSidebarFailureOnce(Throwable failure) {
        if (sidebarFailureWarned) return;
        sidebarFailureWarned = true;
        getLogger().warning("侧边栏创建失败，暂时不显示（刷新任务仍在运行，改完配置 /kokuusb reload 即可恢复）："
                + failure.getClass().getSimpleName() + ": " + failure.getMessage());
        getLogger().warning("  常见原因是超过了服务端的硬限制：objectiveName 不能超过 16 字符，"
                + "标题不能超过 32 字符，prefix/suffix 在 1.12 上各不能超过 16 字符。");
    }

    private static ScoreboardManager getScoreboardManager() {
        return Bukkit.getScoreboardManager();
    }

    /**
     * 本服务端是不是 1.12 及以下。
     *
     * 只在启用与 reload 时算一次并往下传 —— 判定散在多处的话，
     * 很容易出现「警告按旧版算、实际切分按新版算」这种自相矛盾的情况。
     */
    private static boolean isLegacyServer() {
        return Sidebar.isLegacy(Bukkit.getBukkitVersion());
    }

    // ── 给监听器与命令用 ────────────────────────────────────────

    /**
     * 玩家退出时清掉状态。
     *
     * 不调 {@link #hide}：人已经走了，{@code setScoreboard} 没有意义。
     * 但板子还是注销掉 —— 它已经不在任何玩家的屏幕上，注销只是让
     * objective / team 尽早从对象图里摘下来。
     */
    void forget(UUID playerId) {
        Sidebar sidebar = boards.remove(playerId);
        if (sidebar != null) {
            sidebar.dispose();
        }
        foreignBoardWarned.remove(playerId);
        // preferences 刻意**不**清 —— 玩家用 /kokuusb off 关掉后重连应当还是关的。
    }

    Boolean preference(UUID playerId) {
        return preferences.get(playerId);
    }

    void setPreference(UUID playerId, boolean enabled) {
        preferences.put(playerId, Boolean.valueOf(enabled));
    }

    boolean defaultEnabled() {
        return settings.defaultEnabled();
    }

    /**
     * 重新读配置。
     *
     * 先 {@link #hideAll()} 再刷新：行数、世界筛选、标题都可能变了，
     * 直接改现有的板子做不到（行数不能变），整体重建最省事，
     * 代价是这一瞬间所有人闪一下 —— 手动 reload 才发生，可以接受。
     */
    void reloadSettings() {
        reloadConfig();
        settings = BoardSettings.load(getConfig(), getLogger(), isLegacyServer());
        placeholders = new Placeholders(economy, tps, ping);

        hideAll();
        scheduleRefresh();
        refreshAll();

        // reload 之后重新给一次机会：上次失败可能正是因为配置写超了。
        sidebarFailureWarned = false;

        getLogger().info("配置已重载：每 " + settings.updateIntervalTicks() + " tick 刷新一次，共 "
                + settings.lines().size() + " 行。");
    }

    /**
     * {@code /kokuusb verify} —— 不依赖玩家在线的一次自检。
     *
     * <h2>为什么需要它</h2>
     *
     * 「配置写超了导致服务端拒绝、侧边栏整块不显示」这个问题，只会在
     * **有玩家在线**时才暴露。服主改完配置重启服务端，如果当时没人在线，
     * 控制台一切正常；等玩家进来才发现侧边栏没有 —— 而那时离改动已经过去了很久。
     *
     * 这个命令用当前配置**真的造一块板子**（走 CraftBukkit 的
     * {@code registerNewObjective} / {@code registerNewTeam} / {@code setPrefix}，
     * 那些地方才有长度校验），造得出来就说明配置没问题，造不出来就当场把原因说清。
     * 造完即丢，不影响任何玩家。
     *
     * @return 给执行者看的报告行
     */
    List<String> verify() {
        List<String> report = new ArrayList<String>();

        report.add(settings.describe());

        // ── 1. 能不能真的把板子造出来 ──
        ScoreboardManager manager = Bukkit.getScoreboardManager();
        if (manager == null) {
            report.add("✗ 记分板管理器还不可用（服务端尚未完成启动）。稍后再试。");
            return report;
        }

        Sidebar probe;
        try {
            probe = new Sidebar(getLogger(), manager, settings.legacy(),
                    settings.objectiveName(), settings.title(), settings.lines());
        } catch (Throwable failure) {
            report.add("✗ 板子创建失败：" + failure.getClass().getSimpleName() + ": " + failure.getMessage());
            report.add("  检查这两处（都是服务端硬限制）：objectiveName ≤ 16 字符、标题 ≤ 32 字符。");
            return report;
        }

        report.add("✓ 板子创建成功（" + settings.lines().size() + " 行）—— 服务端接受了 objectiveName 与标题。");

        // ── 2. 逐行跑一遍切分，报出每行实际会被设成什么 ──
        //
        // 这里刻意用「不含占位符的原始模板」来跑：自检要回答的是
        // 「这一行的长度在**最坏情况下**安不安全」，而展开后的长度随玩家变化，
        // 拿一个具体玩家的值来量反而会漏掉名字特别长的那种情况。
        List<String> expanded = new ArrayList<String>(settings.lines().size());
        for (String line : settings.lines()) {
            expanded.add(line);
        }
        try {
            probe.update(expanded);
        } catch (Throwable failure) {
            probe.dispose();
            report.add("✗ 写入行文本失败：" + failure.getClass().getSimpleName() + ": " + failure.getMessage());
            return report;
        }

        int limit = Sidebar.lineLimit(settings.legacy());
        report.add("✓ 全部 " + settings.lines().size() + " 行写入成功，每行上限 " + limit + " 字符。");
        report.add("  最长一行（按模板算）：" + longestTemplate());

        // 自检用的板子没人挂着，注销掉即可 —— 不注销的话它会一直留在
        // 服务端的记分板集合里，反复 verify 就反复堆积。
        probe.dispose();

        // ── 3. 经济后端 ──
        if (economy.available()) {
            report.add("✓ Vault 经济后端可用，%balance% 会显示真实余额。");
        } else {
            report.add("· 没有可用的 Vault 经济后端，%balance% 显示为 balanceFallback（"
                    + settings.balanceFallback() + "）。");
        }

        report.add("· TPS 是插件自己量的（1.12.2 没有 Server#getTPS）：当前 "
                + String.format(java.util.Locale.ROOT, "%.1f", tps.tps()) + "。");
        report.add("· 在线玩家 " + Bukkit.getOnlinePlayers().size() + " 人。");
        return report;
    }

    /** 模板里最长的一行有多长（含颜色码），用于自检报告。 */
    private String longestTemplate() {
        int longest = 0;
        int index = -1;
        List<String> lines = settings.lines();
        for (int i = 0; i < lines.size(); i++) {
            int length = lines.get(i).length();
            if (length > longest) {
                longest = length;
                index = i;
            }
        }
        return "第 " + (index + 1) + " 行 " + longest + " 字符";
    }
}
