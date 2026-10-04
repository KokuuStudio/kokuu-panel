package com.kokuustudio.kokuupanel.scoreboard;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.logging.Logger;

import org.bukkit.ChatColor;
import org.bukkit.configuration.file.FileConfiguration;

/**
 * config.yml 的类型化快照。
 *
 * <h2>为什么要在启动时一次性读出来</h2>
 *
 * 刷新任务每秒跑一次、每个玩家一遍。如果每次都去问 {@code FileConfiguration}
 * 要字符串、再现场解析世界名单，那些字符串比较和 List 构造就被乘上了
 * 「每秒 × 在线人数」—— 完全是白花的。所以 {@code /kokuusb reload} 时
 * 重新构造一份，之后刷新只读这些 final 字段。
 *
 * <p>顺带把所有校验（行数上限、世界名小写化）也放在这里做一次，
 * 而不是散在刷新循环里。
 */
final class BoardSettings {

    /**
     * 侧边栏最多能显示多少行。
     *
     * 这是**客户端**的限制，不是本插件加的：Minecraft 的侧边栏固定 15 行，
     * 多出来的分数客户端根本不渲染。config 里写 30 行不会报错，
     * 只会静默少一半 —— 所以这里主动截断并提醒。
     */
    static final int MAX_LINES = 15;

    private final String objectiveName;
    private final String title;
    private final List<String> lines;
    private final int updateIntervalTicks;
    private final boolean whitelistMode;
    private final Set<String> worlds;
    private final boolean defaultEnabled;
    private final String balanceFallback;
    private final String unknownFallback;
    /** 本服务端是不是 1.12 及以下。决定长度校验的上限与 Sidebar 的切分策略。 */
    private final boolean legacy;
    /** config.yml 里原本写了多少行（可能超过 {@link #MAX_LINES}，用于自检报告）。 */
    private final int rawLineCount;

    private BoardSettings(String objectiveName, String title, List<String> lines,
                          int updateIntervalTicks, boolean whitelistMode, Set<String> worlds,
                          boolean defaultEnabled, String balanceFallback, String unknownFallback,
                          boolean legacy, int rawLineCount) {
        this.objectiveName = objectiveName;
        this.title = title;
        this.lines = Collections.unmodifiableList(lines);
        this.updateIntervalTicks = updateIntervalTicks;
        this.whitelistMode = whitelistMode;
        this.worlds = Collections.unmodifiableSet(worlds);
        this.defaultEnabled = defaultEnabled;
        this.balanceFallback = balanceFallback;
        this.unknownFallback = unknownFallback;
        this.legacy = legacy;
        this.rawLineCount = rawLineCount;
    }

    static BoardSettings load(FileConfiguration config, Logger logger, boolean legacy) {
        String objectiveName = config.getString("objectiveName", "kokuu_sb");
        /*
         * 上限是 **16**，而且这条是**服务端硬限制**，不是我们的偏好。
         *
         * 依据：把 CatServer 1.12.2 的 CatServer-*.jar 反汇编出来看
         * CraftScoreboard#registerNewObjective，里面是
         *   Validate.isTrue(name.length() <= 16,
         *                   "The name '<x>' is longer than the limit of 16 characters")
         * 超了会抛 IllegalArgumentException。
         *
         * ⚠️ 别把这里放宽到 32：那是 CraftObjective#setDisplayName（标题）的
         * 上限，不是**名字**的。两者容易看混，混了的后果是配置写到 17~32 字符时
         * Sidebar 构造抛异常 —— 而抛出点在刷新任务里，任务会被 Bukkit 取消，
         * 表现是「侧边栏永远不出现、控制台刷一次错就没了」，很难查。
         */
        if (objectiveName == null || !objectiveName.matches("[a-zA-Z0-9_.-]{1,16}")) {
            logger.warning("objectiveName「" + objectiveName + "」不合法"
                    + "（只允许字母数字和 _.- ，且必须是 1~16 字符 —— 16 是服务端"
                    + " registerNewObjective 的硬限制），已改回默认值 kokuu_sb。");
            objectiveName = "kokuu_sb";
        }

        String title = config.getString("title", "&6Kokuu");
        if (title == null) title = "";

        List<String> rawLines = config.getStringList("lines");
        List<String> lines = new ArrayList<String>(Math.min(rawLines.size(), MAX_LINES));
        for (int i = 0; i < rawLines.size() && i < MAX_LINES; i++) {
            String line = rawLines.get(i);
            lines.add(line == null ? "" : line);
        }
        if (rawLines.size() > MAX_LINES) {
            logger.warning("config.yml 里配了 " + rawLines.size() + " 行侧边栏，"
                    + "但客户端最多只显示 " + MAX_LINES + " 行，第 " + (MAX_LINES + 1) + " 行起已被忽略。");
        }

        int interval = config.getInt("updateIntervalTicks", 20);
        if (interval < 10) {
            // 低于 10 tick 玩家看不出差别，纯粹多烧主线程时间。
            logger.warning("updateIntervalTicks=" + interval + " 太短（没有视觉收益），已提升到 10。");
            interval = 10;
        }

        boolean whitelistMode = "whitelist".equalsIgnoreCase(config.getString("worlds.mode", "blacklist"));
        Set<String> worlds = new HashSet<String>();
        for (String world : config.getStringList("worlds.list")) {
            if (world != null && !world.trim().isEmpty()) {
                // 世界名大小写敏感（Bukkit 的 getWorld 是精确匹配），
                // 但 config 里手写难免大小写不一致，所以统一小写后比较。
                worlds.add(world.trim().toLowerCase(Locale.ROOT));
            }
        }

        boolean defaultEnabled = config.getBoolean("defaultEnabled", true);
        String balanceFallback = config.getString("balanceFallback", "&8—");
        String unknownFallback = config.getString("unknownFallback", "&8—");

        /*
         * 颜色码在这里一次性转换完，之后整条链路（含 Sidebar 的长度计算）
         * 只见 § 形式。放在这里而不是刷新循环里，是因为刷新是
         * 「每秒 × 在线人数」的量级。
         *
         * 长度不变（&7 → §7 都是两个字符），所以下面的长度校验用哪种形式
         * 结果都一样 —— 校验放在转换之后只是为了统一。
         */
        title = translate(title);
        for (int i = 0; i < lines.size(); i++) {
            lines.set(i, translate(lines.get(i)));
        }
        balanceFallback = translate(balanceFallback);
        unknownFallback = translate(unknownFallback);

        BoardSettings settings = new BoardSettings(objectiveName, title, lines, interval,
                whitelistMode, worlds, defaultEnabled, balanceFallback, unknownFallback,
                legacy, rawLines.size());

        settings.warnAboutLengths(logger);
        return settings;
    }

    /**
     * 启动时先把「必然会被截断」的配置指出来。
     *
     * 运行时 {@link Sidebar} 也会在真的截断时警告一次，但那要等到有玩家在线 ——
     * 服主改完配置重启，应该马上在控制台看到问题，而不是等玩家进来说「少字了」。
     */
    private void warnAboutLengths(Logger logger) {
        int lineLimit = Sidebar.lineLimit(legacy);
        int titleLimit = Sidebar.titleLimit(legacy);
        String version = legacy ? "1.12 及以下" : "1.13+";

        if (title.length() > titleLimit) {
            logger.warning("标题超过本服务端（" + version + "）的 " + titleLimit
                    + " 字符上限，会被截断：" + title);
        }

        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i);
            if (line.length() > lineLimit) {
                logger.warning("侧边栏第 " + (i + 1) + " 行超过本服务端（" + version + "）的 "
                        + lineLimit + " 字符上限，中间部分会被丢弃：" + line);
            }
        }
    }

    /** 这个世界该不该显示记分牌。 */
    boolean allowsWorld(String worldName) {
        if (worldName == null) return !whitelistMode;
        boolean listed = worlds.contains(worldName.toLowerCase(Locale.ROOT));
        return whitelistMode == listed;
    }

    String objectiveName() {
        return objectiveName;
    }

    String title() {
        return title;
    }

    List<String> lines() {
        return lines;
    }

    int updateIntervalTicks() {
        return updateIntervalTicks;
    }

    boolean defaultEnabled() {
        return defaultEnabled;
    }

    String balanceFallback() {
        return balanceFallback;
    }

    String unknownFallback() {
        return unknownFallback;
    }

    /** 本服务端是不是 1.12 及以下（要转给 {@link Sidebar} 用）。 */
    boolean legacy() {
        return legacy;
    }

    /** 供 {@code /kokuusb verify} 做自检用：把关键信息一次性说清。 */
    String describe() {
        return "服务端版本判定：" + (legacy ? "1.12 及以下" : "1.13+")
                + "（prefix/suffix 各 " + (legacy ? 16 : 64) + " 字符，标题上限 " + Sidebar.titleLimit(legacy) + "）\n"
                + "  objectiveName：" + objectiveName + "（上限 16）\n"
                + "  生效行数：" + lines.size()
                + (rawLineCount > lines.size()
                    ? "（配置里有 " + rawLineCount + " 行，超出客户端 " + MAX_LINES + " 行上限的部分已忽略）"
                    : "")
                + "\n"
                + "  刷新间隔：" + updateIntervalTicks + " tick\n"
                + "  世界策略：" + (whitelistMode ? "白名单（只有下列世界显示）" : "黑名单（下列世界不显示）")
                + (worlds.isEmpty() ? "，名单为空" : "：" + worlds);
    }

    /** 有没有内容可显示。空行列表等于没东西，不必占用玩家的侧边栏。 */
    boolean hasContent() {
        for (String line : lines) {
            if (!line.trim().isEmpty()) return true;
        }
        return false;
    }

    /** {@code &7} 这类颜色码转成 {@code §7}。null 当空串处理。 */
    private static String translate(String text) {
        return text == null ? "" : ChatColor.translateAlternateColorCodes('&', text);
    }
}
