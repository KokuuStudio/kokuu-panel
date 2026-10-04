package com.kokuustudio.kokuupanel.scoreboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * {@link Sidebar} 的切分行为。
 *
 * <h2>为什么这个测试重要</h2>
 *
 * 1.12 服务端对 Team 的 prefix / suffix 各限 16 个字符（**含 § 颜色码**），
 * 超了 CraftBukkit 直接抛 {@code IllegalArgumentException} —— 而抛出点在
 * 刷新任务里，表现是「每秒刷一次报错、侧边栏空白」。
 *
 * <p>这个 bug 只有在**有玩家在线时**才会出现。所以本项目不依赖「开客户端试一下」，
 * 而是让假记分板把每次 {@code setPrefix}/{@code setSuffix} 的内容记下来，
 * 直接断言那条不变量：交给服务端的字符串永远不超限。
 */
class SidebarTest {

    private static final boolean LEGACY = true;
    private static final boolean MODERN = false;

    private static final String COLOR = "\u00A7";

    private static Sidebar sidebar(Fakes.FakeBoard board, boolean legacy, String title, List<String> lines) {
        return new Sidebar(Fakes.quietLogger(), board.manager(), legacy, "kokuu_sb", title, lines);
    }

    @Test
    @DisplayName("短行：整行进 prefix，suffix 为空")
    void shortLineGoesEntirelyIntoPrefix() {
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        Sidebar sidebar = sidebar(board, LEGACY, "标题", Arrays.asList("%player%"));

        sidebar.update(Arrays.asList(COLOR + "7玩家: " + COLOR + "fSteve"));

        assertEquals(COLOR + "7玩家: " + COLOR + "fSteve", board.prefixOf(0));
        assertEquals("", board.suffixOf(0));
    }

    @Test
    @DisplayName("超过 16 字符的彩色行：切分后两段都不超限（1.12 不会抛异常）")
    void longColoredLineIsSplitWithinLimits() {
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        Sidebar sidebar = sidebar(board, LEGACY, "标题", Arrays.asList("x"));

        // 这一行是 30 个字符，其中颜色码占 4 个 —— 在 1.12 上必须被切开。
        String line = COLOR + "7余额: " + COLOR + "f1,234,567";
        assertTrue(line.length() > 16, "构造的测试行本来就应该超过 16 字符");

        assertDoesNotThrow(() -> sidebar.update(Arrays.asList(line)));

        String prefix = board.prefixOf(0);
        String suffix = board.suffixOf(0);
        assertNotNull(prefix);
        assertNotNull(suffix);
        assertTrue(prefix.length() <= 16, "prefix 超限会被服务端拒绝：" + prefix);
        assertTrue(suffix.length() <= 16, "suffix 超限会被服务端拒绝：" + suffix);
    }

    @Test
    @DisplayName("切点不落在 § 上：prefix 不以孤立的 § 结尾")
    void neverCutsThroughColorCode() {
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        Sidebar sidebar = sidebar(board, LEGACY, "标题", Arrays.asList("x"));

        // 让第 16 个字符正好是 § —— 从中间切开会把颜色码劈成两半。
        String line = "123456789012345" + COLOR + "a后面还有很多字";
        assertDoesNotThrow(() -> sidebar.update(Arrays.asList(line)));

        String prefix = board.prefixOf(0);
        assertFalse(prefix.endsWith(COLOR), "prefix 以孤立 § 结尾会让后半段格式错乱：" + prefix);
    }

    @Test
    @DisplayName("后半段继承切点处的颜色，不会退回默认白")
    void suffixCarriesActiveColor() {
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        Sidebar sidebar = sidebar(board, LEGACY, "标题", Arrays.asList("x"));

        // 22 个字符：颜色码 2 个 + 20 个汉字。
        // 前 16 个字符进 prefix，剩下 6 个进 suffix —— 而 suffix 必须自带 §c，
        // 否则它会退回默认白色，看起来像「这行后半截坏了」。
        String line = COLOR + "c" + repeat('一', 20);
        assertTrue(line.length() > 16, "构造的测试行本来就应该超过 16 字符");

        assertDoesNotThrow(() -> sidebar.update(Arrays.asList(line)));

        String suffix = board.suffixOf(0);
        assertNotNull(suffix);
        assertTrue(suffix.startsWith(COLOR + "c"),
                "后半段应当补上 §c，否则颜色会掉回默认白色：" + suffix);
        assertTrue(suffix.length() <= 16, "补颜色之后仍不能超限：" + suffix);
    }

    @Test
    @DisplayName("代理对（emoji）不会被从中间切开")
    void doesNotSplitSurrogatePair() {
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        Sidebar sidebar = sidebar(board, LEGACY, "标题", Arrays.asList("x"));

        // 15 个半角字符 + 一个 emoji（占 2 个 char）+ 尾巴。
        // 若在第 16 个 char 处硬切，emoji 会被劈成两半。
        String line = "123456789012345" + "\uD83D\uDE00" + "尾巴";
        assertDoesNotThrow(() -> sidebar.update(Arrays.asList(line)));

        String prefix = board.prefixOf(0);
        assertFalse(Character.isHighSurrogate(prefix.charAt(prefix.length() - 1)),
                "prefix 以半个 emoji 结尾会显示成乱码方块");
    }

    @Test
    @DisplayName("每个玩家一份板子：setPrefix 的字符串就是最终显示内容")
    void multipleLinesAreIndependentlyAddressed() {
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        List<String> lines = Arrays.asList("第一行", "第二行", "第三行");
        Sidebar sidebar = sidebar(board, LEGACY, "标题", lines);

        sidebar.update(Arrays.asList("A", "B", "C"));

        assertEquals(3, board.teamCount());
        assertEquals(3, board.entries().size(), "每行一个 entry");
        assertEquals("A", board.prefixOf(0));
        assertEquals("B", board.prefixOf(1));
        assertEquals("C", board.prefixOf(2));
        assertEquals(3, sidebar.size());
    }

    @Test
    @DisplayName("刷新只改文本、不重绑 entry —— 否则侧边栏每秒会闪一下")
    void refreshDoesNotTouchEntries() {
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        Sidebar sidebar = sidebar(board, LEGACY, "标题", Arrays.asList("x"));

        sidebar.update(Arrays.asList("第一次"));
        List<String> afterFirst = new ArrayList<String>(board.entries());
        sidebar.update(Arrays.asList("第二次"));
        sidebar.update(Arrays.asList("第三次"));

        assertEquals(afterFirst, board.entries(), "entry 列表在刷新后不应变化");
        assertEquals("第三次", board.prefixOf(0));
    }

    @Test
    @DisplayName("现代服务端上限更宽：同样一行不用切")
    void modernLimitKeepsLineIntact() {
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        Sidebar sidebar = sidebar(board, MODERN, "标题", Arrays.asList("x"));

        String line = COLOR + "7余额: " + COLOR + "f1,234,567";
        sidebar.update(Arrays.asList(line));

        assertEquals(line, board.prefixOf(0));
        assertEquals("", board.suffixOf(0));
    }

    @Test
    @DisplayName("标题超限自己先截断，不交给客户端去丢字")
    void titleIsTruncated() {
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        sidebar(board, LEGACY, repeat('一', 40), Arrays.asList("x"));

        assertTrue(board.title().length() <= Sidebar.titleLimit(LEGACY),
                "标题超限会被服务端拒绝：" + board.title());
    }

    @Test
    @DisplayName("标题上限是 32（服务端的真实限制），1.12 上不该按 16 砍")
    void titleLimitMatchesServerNotGuesswork() {
        /*
         * 反汇编 CatServer 1.12.2 的 jar：CraftObjective#setDisplayName 校验的是
         * displayName.length() <= 32。所以 1.12.2 上 20 个字符的标题
         * **服务端是接受的**，我们不该替用户砍掉 4 个字。
         */
        assertEquals(32, Sidebar.titleLimit(LEGACY));

        String twenty = repeat('一', 20);
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        sidebar(board, LEGACY, twenty, Arrays.asList("x"));

        assertEquals(twenty, board.title(), "20 字符标题在 1.12 上应当原样保留");
    }

    @Test
    @DisplayName("队名不超 16（registerNewTeam 的硬限制），所以满 15 行也安全")
    void teamNamesStayWithinServerLimit() {
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        List<String> lines = new ArrayList<String>();
        for (int i = 0; i < BoardSettings.MAX_LINES; i++) {
            lines.add("行" + i);
        }
        sidebar(board, LEGACY, "t", lines);

        // 队名形如 kokuu_line_14 —— 最长的是最后一行，必须 ≤16。
        String longest = "kokuu_line_" + (BoardSettings.MAX_LINES - 1);
        assertTrue(longest.length() <= 16,
                "队名超过 registerNewTeam 的 16 字符上限会抛异常：" + longest);
        assertEquals(BoardSettings.MAX_LINES, board.teamCount());
    }

    @Test
    @DisplayName("版本判定：1.12 及以下是 legacy，1.13+ 不是")
    void legacyDetection() {
        assertTrue(Sidebar.isLegacy("1.12.2-R0.1-SNAPSHOT"));
        assertTrue(Sidebar.isLegacy("1.8.8-R0.1-SNAPSHOT"));
        assertFalse(Sidebar.isLegacy("1.13-R0.1-SNAPSHOT"));
        assertFalse(Sidebar.isLegacy("1.20.4-R0.1-SNAPSHOT"));
        // 认不出来时按新版处理：上限更宽松，最多少显示，不会抛异常。
        assertFalse(Sidebar.isLegacy(null));
        assertFalse(Sidebar.isLegacy("不知道什么版本"));
    }

    @Test
    @DisplayName("长度上限与运行时用的值一致（校验口径不能有两套）")
    void limitsMatchRuntimeBehaviour() {
        assertEquals(32, Sidebar.lineLimit(LEGACY));
        assertEquals(128, Sidebar.lineLimit(MODERN));
        assertEquals(32, Sidebar.titleLimit(LEGACY));
        assertEquals(32, Sidebar.titleLimit(MODERN));

        /*
         * 32 是 legacy 的**整行**上限，也就是 prefix(16) + suffix(16)。
         * 所以 32 个字符走上限时仍然要分两段放 —— 关键在于**一个字都不丢**：
         * 两段拼起来必须等于原文，而且没有触发「中间被丢弃」的警告路径。
         */
        String exactly32 = repeat('a', 32);
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        Sidebar sidebar = sidebar(board, LEGACY, "t", Arrays.asList("x"));
        sidebar.update(Arrays.asList(exactly32));

        assertEquals(16, board.prefixOf(0).length(), "prefix 用满 16");
        assertEquals(16, board.suffixOf(0).length(), "suffix 用满 16");
        assertEquals(exactly32, board.prefixOf(0) + board.suffixOf(0), "两段拼起来必须是原文，不能丢字");

        // 再多一个字符就要丢中间了 —— 那是「配置太长」的信号，测试只确认它不抛异常。
        Fakes.FakeBoard tight = new Fakes.FakeBoard();
        Sidebar tightSidebar = sidebar(tight, LEGACY, "t", Arrays.asList("x"));
        assertDoesNotThrow(() -> tightSidebar.update(Arrays.asList(repeat('a', 33))));
    }

    @Test
    @DisplayName("空行与 null 不会抛异常")
    void toleratesEmptyAndNull() {
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        Sidebar sidebar = sidebar(board, LEGACY, "t", Arrays.asList("a", "b"));

        assertDoesNotThrow(() -> sidebar.update(Arrays.asList("", null)));
        assertEquals("", board.prefixOf(0));
        assertEquals("", board.prefixOf(1));
    }

    private static String repeat(char c, int times) {
        StringBuilder out = new StringBuilder(times);
        for (int i = 0; i < times; i++) {
            out.append(c);
        }
        return out.toString();
    }

    // ── 注销 ────────────────────────────────────────────────────

    @Test
    @DisplayName("dispose 会注销 objective —— 这是让侧边栏从屏幕上消失的唯一可靠途径")
    void disposeUnregistersObjective() {
        /*
         * 实测（1.12.2 + 真实客户端抓包）：把玩家 setScoreboard 换回主记分板
         * 之后，服务端**一个包都不发**，客户端会继续显示最后一帧。
         * 只有 Objective#unregister() 会走 NMS 的 removeObjective，
         * 主动给正在看这块板子的玩家发「清除该槽位」的包。
         */
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        Sidebar sidebar = sidebar(board, LEGACY, "标题", Arrays.asList("a", "b", "c"));

        assertEquals(0, board.objectiveUnregisters(), "还没注销");

        sidebar.dispose();

        assertEquals(1, board.objectiveUnregisters(), "objective 应当被注销一次");
    }

    @Test
    @DisplayName("dispose 把队伍一并注销，不留残渣")
    void disposeUnregistersTeams() {
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        Sidebar sidebar = sidebar(board, LEGACY, "标题", Arrays.asList("a", "b", "c"));
        assertEquals(3, board.teamCount());

        sidebar.dispose();

        assertEquals(3, board.teamUnregisters(), "每个队伍都应当被注销");
        assertEquals(0, sidebar.size(), "注销后不该还认为有行");
    }

    @Test
    @DisplayName("重复 dispose 不会抛异常（服务端关停时可能已经清理过）")
    void disposeIsIdempotent() {
        Fakes.FakeBoard board = new Fakes.FakeBoard();
        Sidebar sidebar = sidebar(board, LEGACY, "标题", Arrays.asList("a"));

        assertDoesNotThrow(() -> {
            sidebar.dispose();
            sidebar.dispose();
        });
    }
}
