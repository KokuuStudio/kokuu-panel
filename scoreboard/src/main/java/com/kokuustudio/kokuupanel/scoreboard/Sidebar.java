package com.kokuustudio.kokuupanel.scoreboard;

import java.util.ArrayList;
import java.util.List;
import java.util.logging.Logger;

import org.bukkit.ChatColor;
import org.bukkit.scoreboard.DisplaySlot;
import org.bukkit.scoreboard.Objective;
import org.bukkit.scoreboard.Scoreboard;
import org.bukkit.scoreboard.ScoreboardManager;
import org.bukkit.scoreboard.Team;

/**
 * 一个玩家的侧边栏。
 *
 * <h2>为什么每个玩家一个 Scoreboard</h2>
 *
 * 侧边栏的内容里有 {@code %player%}、{@code %balance%} 这类**因人而异**的占位符，
 * 所以不同玩家看到的行不一样。Bukkit 的 Team 是挂在 Scoreboard 上的，
 * 多个玩家共用一个 Scoreboard 就没法让同一行在他们眼里显示不同内容。
 * 因此每人一份 —— 这也是所有显示个人数据的侧边栏插件的做法。
 *
 * <h2>为什么整行放进 prefix，而不是每行一个 entry</h2>
 *
 * {@code Team.addEntry(entry)} 一旦调用，这个 Team 绑定的 entry 就固定了；
 * 之后能改的只有 prefix / suffix。而「用 entry 承载文本」那种写法每次刷新都要
 * {@code removeEntry} + {@code addEntry} 重绑一次 —— 后果是侧边栏**每秒闪一下**。
 *
 * 所以这里：entry 只是一个「看不见但唯一」的颜色码标记（占位用的），
 * 文本全部走 prefix / suffix，刷新时只改文本，不碰 entry，因此不闪。
 *
 * <h2>1.12 的 16 字符上限（本类存在的主要理由）</h2>
 *
 * prefix / suffix 的长度上限**随版本不同**：
 * <ul>
 *   <li>1.8 ~ 1.12：各 <b>16</b> 个字符</li>
 *   <li>1.13+：各 <b>64</b> 个字符</li>
 * </ul>
 *
 * 这不是「大概」：反汇编 CatServer 1.12.2 的 jar 可以看到 CraftTeam 里
 * 就是 {@code Validate.isTrue(prefix.length() <= 16, "...limit of 16 characters")}，
 * 超了直接抛 {@code IllegalArgumentException}。
 *
 * 而且算的是**原始字符串长度，包含 {@code §} 颜色码**。
 * {@code §7余额: §f1,234} 这种看着很短的行走完颜色码就已经 16 个字符了 ——
 * 1.12 上不做处理就会直接抛 {@code IllegalArgumentException}。
 *
 * 本类的处理：放得进 prefix 就放 prefix；放不进就把**末尾**那段挪到 suffix
 * （并补上切点处仍在生效的颜色，否则后半段会变白）。两段都放不下的中间部分
 * 会被丢弃，并对该行打一次警告 —— 与其静默少字，不如让服主知道该把那行写短点。
 */
final class Sidebar {

    private static final char SECTION = '\u00A7';

    /** 给每行造「看不见的唯一标记」用的颜色码字符。16 个颜色 × 16 = 256 行上限。 */
    private static final char[] PALETTE = "0123456789abcdef".toCharArray();

    private static final int PREFIX_LIMIT_LEGACY = 16;
    private static final int SUFFIX_LIMIT_LEGACY = 16;
    private static final int PREFIX_LIMIT_MODERN = 64;
    private static final int SUFFIX_LIMIT_MODERN = 64;

    /**
     * 标题上限。
     *
     * <h2>为什么 legacy 也是 32，而不是 16</h2>
     *
     * 反汇编 CatServer 1.12.2 的 jar 可以看到，CraftObjective#setDisplayName
     * 的校验是 {@code displayName.length() <= 32} —— 也就是说 1.12.2 服务端
     * **接受** 32 个字符的标题。
     *
     * 我原来把 legacy 的标题上限设成 16，理由是「1.12 大概只显示得下 16」。
     * 那个理由是**没有依据的**：16 是 prefix/suffix 的上限（CraftTeam 里明确校验），
     * 跟标题不是一回事。按 16 截断的后果是：用户配了 20 个字符的标题时，
     * 服务端明明能收下，却被我们砍掉 4 个字符。
     *
     * 所以这里用**服务端真正强制的上限**。至于客户端渲染宽度有限、
     * 长标题可能显示不全 —— 那是观感问题，由 config.yml 的注释提醒，
     * 不该由代码替他决定。
     */
    private static final int TITLE_LIMIT_LEGACY = 32;
    private static final int TITLE_LIMIT_MODERN = 32;

    private final Scoreboard board;
    private final Objective objective;
    private final List<Team> teams = new ArrayList<Team>();
    private final Logger logger;

    /** 本服务端是不是 1.12 及以下（决定 prefix/suffix/标题的上限）。 */
    private final boolean legacy;

    private final int prefixLimit;
    private final int suffixLimit;

    /** 哪些行的中间段被丢过（只警告一次，避免每秒刷屏）。 */
    private final boolean[] truncated;

    /**
     * @param manager 记分板管理器。**由调用方传入而不是在这里调
     *                {@code Bukkit.getScoreboardManager()}**：那个静态方法在服务端
     *                启动早期会返回 null，而且它让本类没法脱离服务端测试 ——
     *                而 1.12 的 16 字符切分逻辑恰恰是最需要被测试固化的部分。
     * @param legacy  是不是 1.12 及以下。同样由调用方算好传进来，
     *                这样判定「哪个版本」的地方只有一处。
     */
    Sidebar(Logger logger, ScoreboardManager manager, boolean legacy,
            String objectiveName, String title, List<String> lines) {
        this.logger = logger;
        this.legacy = legacy;

        this.prefixLimit = legacy ? PREFIX_LIMIT_LEGACY : PREFIX_LIMIT_MODERN;
        this.suffixLimit = legacy ? SUFFIX_LIMIT_LEGACY : SUFFIX_LIMIT_MODERN;

        this.board = manager.getNewScoreboard();
        this.objective = board.registerNewObjective(objectiveName, "dummy");
        objective.setDisplaySlot(DisplaySlot.SIDEBAR);

        // 标题也有上限：1.12 是 16，1.13+ 是 32。超了客户端会截断，这里先自己截，
        // 免得看起来像随机丢字。
        objective.setDisplayName(truncate(title, titleLimit(legacy)));

        this.truncated = new boolean[lines.size()];

        for (int i = 0; i < lines.size(); i++) {
            String mark = mark(i);
            Team team = board.registerNewTeam("kokuu_line_" + i);
            team.addEntry(mark);

            // 分数递减，让显示顺序与 config 里的顺序一致（侧边栏按分数从高到低排）。
            objective.getScore(mark).setScore(lines.size() - i);
            team.setPrefix("");
            team.setSuffix("");
            teams.add(team);
        }
    }

    Scoreboard board() {
        return board;
    }

    /** 行数（config 改了行数要重建 Sidebar，本类不支持增删行）。 */
    int size() {
        return teams.size();
    }

    /** 刷新全部行的文本。 */
    void update(List<String> lines) {
        int n = Math.min(lines.size(), teams.size());
        for (int i = 0; i < n; i++) {
            applyLine(i, lines.get(i));
        }
    }

    /**
     * 注销这块板子 —— **这是让侧边栏从玩家屏幕上消失的唯一可靠办法**。
     *
     * <h2>为什么不能只把玩家换回主记分板</h2>
     *
     * 实测（1.12.2 服务端 + 真实客户端协议抓包）：{@code player.setScoreboard(main)}
     * 之后服务端**一个包都不发**。原因是 CraftBukkit 的 setScoreboard 只按
     * 「新板子里有哪些显示槽位」去通知，而主记分板上通常没有 sidebar objective，
     * 于是它什么都不说 —— 客户端于是继续显示最后那一帧。
     *
     * 后果是玩家执行 {@code /kokuusb off} 之后，屏幕上侧边栏还在，
     * 得等重连或别的插件覆盖。命令看起来「没用」。
     *
     * {@code Objective#unregister()} 走的是 NMS 的
     * {@code ScoreboardServer.removeObjective}，它会**主动给所有正在看这块板子的
     * 玩家**发「清除该槽位」的包 —— 这正是我们要的。
     *
     * 顺序很重要：必须**在把玩家换回主记分板之前**调用，否则那时玩家已经
     * 不看这块板子了，清除包同样发不出去。
     */
    void dispose() {
        try {
            objective.unregister();
        } catch (IllegalStateException alreadyUnregistered) {
            // 服务端关停时可能已经清理过，重复注销是无害的。
        }
        for (Team team : teams) {
            try {
                team.unregister();
            } catch (IllegalStateException alreadyUnregistered) {
                // 同上
            }
        }
        teams.clear();
    }

    private void applyLine(int index, String text) {
        Team team = teams.get(index);
        String safe = text == null ? "" : text;

        if (safe.length() <= prefixLimit) {
            team.setPrefix(safe);
            team.setSuffix("");
            return;
        }

        int cut = safeCut(safe, prefixLimit);
        String head = safe.substring(0, cut);
        String rest = safe.substring(cut);

        // 后半段要补上切点处仍在生效的颜色，否则它会退回默认白色。
        String carry = activeColor(safe, cut);
        String tail = rest.length() <= suffixLimit
                ? carry + rest
                : carry + tailOf(rest, suffixLimit);

        team.setPrefix(head);
        team.setSuffix(tail);

        // 中间被丢掉了才警告，且每行只说一次。
        boolean dropped = rest.length() > suffixLimit;
        if (dropped && !truncated[index]) {
            truncated[index] = true;
            logger.warning("侧边栏第 " + (index + 1) + " 行太长，本服务端（"
                    + (legacy ? "1.12 及以下" : "1.13+") + "）每行上限是 "
                    + (prefixLimit + suffixLimit) + " 个字符（含 § 颜色码），中间部分已被丢弃："
                    + ChatColor.stripColor(safe));
            logger.warning("  把这行写短一点，或者去掉一些颜色码。");
        }
    }

    // ── 文本切分 ──────────────────────────────────────────────

    /**
     * 找出不超过 {@code limit} 的安全切点。
     *
     * 「安全」指不切开 {@code §} 和它后面的格式码 —— 从中间切开的话，
     * 前半段会以孤立的 {@code §} 结尾（那之后的文字格式全乱），
     * 后半段则从一个裸格式码字符开始。
     */
    private static int safeCut(String text, int limit) {
        if (text.length() <= limit) return text.length();

        int cut = limit;
        // § 落在切点前一个位置 → 退一格，把它整体留给后半段
        while (cut > 0 && text.charAt(cut - 1) == SECTION) {
            cut--;
        }
        // 不要切开代理对（emoji 这类补充平面字符占两个 char）
        if (cut > 0 && cut < text.length() && Character.isHighSurrogate(text.charAt(cut - 1))) {
            cut--;
        }
        return Math.max(0, cut);
    }

    /** 从末尾取 {@code limit} 个字符，同样避开切在 § 中间。 */
    private static String tailOf(String text, int limit) {
        if (text.length() <= limit) return text;

        int start = text.length() - limit;
        // 从后往前找，别让后半段以裸格式码开头
        while (start < text.length() && text.charAt(start) == SECTION) {
            start++;
        }
        if (start > 0 && Character.isLowSurrogate(text.charAt(start))) {
            start--;
        }
        return text.substring(Math.max(0, start));
    }

    /**
     * 取 {@code text} 前 {@code end} 个字符里**最后一个颜色码**（{@code §0}~{@code §f}）。
     *
     * 只认颜色码、不认粗体斜体那类格式码 —— 格式是会跨段继承的，
     * 而颜色必须显式补，否则后半段会变回默认白色。
     */
    private static String activeColor(String text, int end) {
        String last = "";
        int stop = Math.min(end, text.length());
        for (int i = 0; i + 1 < stop; i++) {
            if (text.charAt(i) != SECTION) continue;
            char code = Character.toLowerCase(text.charAt(i + 1));
            if ((code >= '0' && code <= '9') || (code >= 'a' && code <= 'f')) {
                last = "" + SECTION + code;
            }
            i++; // 跳过格式码字符本身
        }
        return last;
    }

    private static String truncate(String text, int limit) {
        if (text == null) return "";
        return text.length() <= limit ? text : text.substring(0, safeCut(text, limit));
    }

    /** 第 {@code index} 行的「看不见的唯一标记」。 */
    private static String mark(int index) {
        char a = PALETTE[index % PALETTE.length];
        char b = PALETTE[(index / PALETTE.length) % PALETTE.length];
        // 结尾补一个重置码：标记里的颜色不该影响后面的文字
        return "" + SECTION + a + SECTION + b + SECTION + 'r';
    }

    /**
     * 是不是 1.12 及以下（prefix/suffix 上限 16）。
     *
     * 按 {@code Bukkit.getBukkitVersion()} 的次版本号判断，例如
     * {@code "1.12.2-R0.1-SNAPSHOT"} → 12 ≤ 12 → legacy。
     *
     * <p>刻意不提供「无参版本」：那会让本类（以及调用它的 {@link BoardSettings}）
     * 依赖 {@code Bukkit} 的静态状态，既没法脱离服务端测试，也会把
     * 「解析版本号」这件事散到多处。版本号由插件在启用时读一次传进来。
     */
    static boolean isLegacy(String bukkitVersion) {
        if (bukkitVersion == null) return false;
        String[] parts = bukkitVersion.split("[.\\-]");
        if (parts.length < 2) return false;
        try {
            return Integer.parseInt(parts[1]) <= 12;
        } catch (NumberFormatException notANumber) {
            // 拿不准就当新版（上限更宽松，最多是少显示一点，不会抛异常）
            return false;
        }
    }

    /**
     * 一行的字符上限（prefix + suffix）。
     *
     * 给启动时的配置校验用 —— 校验必须和运行时**同一个口径**，
     * 否则会出现「启动说没问题、运行起来却在丢字」。所以这里的返回值
     * 直接从本类实际使用的上限算出来，而不是在别处再写一遍 32 / 128。
     */
    static int lineLimit(boolean legacy) {
        return legacy ? PREFIX_LIMIT_LEGACY + SUFFIX_LIMIT_LEGACY
                : PREFIX_LIMIT_MODERN + SUFFIX_LIMIT_MODERN;
    }

    /** 标题的字符上限。同上，与运行时的取值保持一致。 */
    static int titleLimit(boolean legacy) {
        return legacy ? TITLE_LIMIT_LEGACY : TITLE_LIMIT_MODERN;
    }
}
