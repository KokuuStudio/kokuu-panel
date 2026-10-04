package com.kokuustudio.kokuupanel.scoreboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.bukkit.configuration.InvalidConfigurationException;
import org.bukkit.configuration.file.YamlConfiguration;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * 配置读取与校验。
 *
 * <h2>重点：把「静默失效」的配置项挡住</h2>
 *
 * 服主改配置时最容易踩的三类坑，都会**不报错**：
 *
 * <ol>
 *   <li>行数超过 15 —— 客户端根本不渲染，看起来像「配置没生效」；</li>
 *   <li>刷新间隔填了 1 —— 能跑，但每秒 20 次重画纯属浪费；</li>
 *   <li>世界名单大小写不一致 —— 精确匹配查不到，表现为「在某些世界不显示」。</li>
 * </ol>
 *
 * <p>这些都在 {@link BoardSettings#load} 里被规范化或警告，测试把它们钉住。
 */
class BoardSettingsTest {

    private static final String COLOR = "\u00A7";

    private static BoardSettings load(String yaml, boolean legacy) {
        YamlConfiguration config = new YamlConfiguration();
        try {
            config.loadFromString(yaml);
        } catch (InvalidConfigurationException broken) {
            throw new IllegalStateException("测试用的 YAML 自己写错了", broken);
        }
        return BoardSettings.load(config, Fakes.quietLogger(), legacy);
    }

    @Test
    @DisplayName("颜色码在读取时就转好，刷新循环里不必再转")
    void translatesColorCodesAtLoadTime() {
        BoardSettings settings = load(
                "title: \"&6&lKokuuStudio\"\n"
                + "lines:\n  - \"&7玩家: &f%player%\"\n"
                + "balanceFallback: \"&8无\"\n"
                + "unknownFallback: \"&8—\"\n",
                true);

        assertEquals(COLOR + "6" + COLOR + "lKokuuStudio", settings.title());
        assertEquals(COLOR + "7玩家: " + COLOR + "f%player%", settings.lines().get(0));
        assertEquals(COLOR + "8无", settings.balanceFallback());
        assertEquals(COLOR + "8—", settings.unknownFallback());
    }

    @Test
    @DisplayName("超过 15 行只取前 15 行（客户端本来就只显示这么多）")
    void truncatesToClientLineLimit() {
        StringBuilder yaml = new StringBuilder("lines:\n");
        for (int i = 1; i <= 20; i++) {
            yaml.append("  - \"第").append(i).append("行\"\n");
        }

        BoardSettings settings = load(yaml.toString(), true);

        assertEquals(BoardSettings.MAX_LINES, settings.lines().size());
        assertEquals("第1行", settings.lines().get(0));
        assertEquals("第15行", settings.lines().get(14));
    }

    @Test
    @DisplayName("刷新间隔过短会被抬到 10 tick（再短玩家看不出差别）")
    void clampsUpdateInterval() {
        assertEquals(10, load("updateIntervalTicks: 1\n", true).updateIntervalTicks());
        assertEquals(10, load("updateIntervalTicks: 9\n", true).updateIntervalTicks());
        assertEquals(20, load("updateIntervalTicks: 20\n", true).updateIntervalTicks());
        assertEquals(100, load("updateIntervalTicks: 100\n", true).updateIntervalTicks());
        // 没配时用默认值
        assertEquals(20, load("title: x\n", true).updateIntervalTicks());
    }

    @Test
    @DisplayName("黑名单：名单里的世界不显示，其余都显示")
    void blacklistMode() {
        BoardSettings settings = load(
                "worlds:\n  mode: blacklist\n  list:\n    - world_the_end\n", true);

        assertFalse(settings.allowsWorld("world_the_end"));
        assertTrue(settings.allowsWorld("world"));
    }

    @Test
    @DisplayName("白名单：只有名单里的世界显示")
    void whitelistMode() {
        BoardSettings settings = load(
                "worlds:\n  mode: whitelist\n  list:\n    - world\n", true);

        assertTrue(settings.allowsWorld("world"));
        assertFalse(settings.allowsWorld("world_nether"));
    }

    @Test
    @DisplayName("空名单：黑名单=全显示，白名单=全不显示")
    void emptyListBehaviour() {
        assertTrue(load("worlds:\n  mode: blacklist\n  list: []\n", true).allowsWorld("任意世界"));
        assertFalse(load("worlds:\n  mode: whitelist\n  list: []\n", true).allowsWorld("任意世界"));
    }

    @Test
    @DisplayName("世界名大小写不敏感（配置里手写难免不一致）")
    void worldNamesAreCaseInsensitive() {
        BoardSettings settings = load(
                "worlds:\n  mode: whitelist\n  list:\n    - World_The_Nether\n", true);

        assertTrue(settings.allowsWorld("world_the_nether"));
        assertTrue(settings.allowsWorld("WORLD_THE_NETHER"));
    }

    @Test
    @DisplayName("objectiveName 不合法时退回默认值，而不是带着坏名字去注册")
    void rejectsInvalidObjectiveName() {
        assertEquals("kokuu_sb", load("objectiveName: \"有 空 格\"\n", true).objectiveName());
        assertEquals("kokuu_sb", load("objectiveName: \"\"\n", true).objectiveName());
        assertEquals("my_sb", load("objectiveName: \"my_sb\"\n", true).objectiveName());
        // 默认值本身
        assertEquals("kokuu_sb", load("title: x\n", true).objectiveName());
    }

    @Test
    @DisplayName("objectiveName 上限是 16（registerNewObjective 的硬限制），17 字符必须被换掉")
    void rejectsObjectiveNameOverSixteen() {
        /*
         * 这不是保守估计：CraftScoreboard#registerNewObjective 里校验的是
         * name.length() <= 16，超了抛 IllegalArgumentException。
         * 而那个异常会穿过刷新任务，导致 Bukkit 取消任务 ——
         * 表现为「侧边栏永远不出现」，极难排查。所以在配置层就挡掉。
         */
        String fifteen = "abcdefghijklmno";          // 15
        String sixteen = "abcdefghijklmnop";         // 16 —— 合法上限
        String seventeen = "abcdefghijklmnopq";      // 17 —— 必须被换掉

        assertEquals(15, fifteen.length());
        assertEquals(16, sixteen.length());
        assertEquals(17, seventeen.length());

        assertEquals(fifteen, load("objectiveName: \"" + fifteen + "\"\n", true).objectiveName());
        assertEquals(sixteen, load("objectiveName: \"" + sixteen + "\"\n", true).objectiveName());
        assertEquals("kokuu_sb", load("objectiveName: \"" + seventeen + "\"\n", true).objectiveName());
    }

    @Test
    @DisplayName("全是空行时视为没有内容，不占用玩家的侧边栏")
    void blankLinesMeanNoContent() {
        assertFalse(load("lines:\n  - \"\"\n  - \"   \"\n", true).hasContent());
        assertTrue(load("lines:\n  - \"\"\n  - \"有东西\"\n", true).hasContent());
        assertFalse(load("lines: []\n", true).hasContent());
    }

    @Test
    @DisplayName("legacy 标记往下传给 Sidebar（版本判定只有一处）")
    void carriesLegacyFlag() {
        assertTrue(load("title: x\n", true).legacy());
        assertFalse(load("title: x\n", false).legacy());
    }
}
