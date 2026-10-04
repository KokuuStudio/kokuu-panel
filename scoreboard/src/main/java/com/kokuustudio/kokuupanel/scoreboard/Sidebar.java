package com.kokuustudio.kokuupanel.scoreboard;

import java.util.ArrayList;
import java.util.List;
import java.util.logging.Logger;

import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.scoreboard.DisplaySlot;
import org.bukkit.scoreboard.Objective;
import org.bukkit.scoreboard.Scoreboard;
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

    private final Scoreboard board;
    private final Objective objective;
    private final List<Team> teams = new ArrayList<Team>();
    private final Logger logger;

    private final int prefixLimit;
    private final int suffixLimit;

    /** 哪些行的中间段被丢过（只警告一次，避免每秒刷屏）。 */
    private final boolean[] truncated;

    Sidebar(Logger logger, String objectiveName, String title, List<String> lines) {
        this.logger = logger;

        boolean legacy = isLegacy();
        this.prefixLimit = legacy ? PREFIX_LIMIT_LEGACY : PREFIX_LIMIT_MODERN;
        this.suffixLimit = legacy ? SUFFIX_LIMIT_LEGACY : SUFFIX_LIMIT_MODERN;

        this.board = Bukkit.getScoreboardManager().getNewScoreboard();
        this.objective = board.registerNewObjective(objectiveName, "dummy");
        objective.setDisplaySlot(DisplaySlot.SIDEBAR);

        // 标题也有上限：1.12 是 16，1.13+ 是 32。超了客户端会截断，这里先自己截，
        // 免得看起来像随机丢字。
        objective.setDisplayName(truncate(title, legacy ? 16 : 32));

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
                    + (isLegacy() ? "1.12 及以下" : "1.13+") + "）每行上限是 "
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
     */
    static boolean isLegacy() {
        return isLegacy(Bukkit.getBukkitVersion());
    }

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
}
