package com.kokuustudio.kokuupanel.scoreboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.List;

import org.bukkit.configuration.InvalidConfigurationException;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * 占位符替换。
 *
 * <h2>这里要钉住的三件事</h2>
 *
 * <ol>
 *   <li>认得的占位符换成正确的值；</li>
 *   <li>**认不出的原样保留** —— 写错 {@code %word%} 应当还能在侧边栏里看见，
 *       而不是变成空串让人以为是少了半行；</li>
 *   <li>取不到值时用占位文案，而不是 0 或者 null ——
 *       一个看起来像真实读数的 0 会被当成「延迟很好」。</li>
 * </ol>
 *
 * <p>不测 {@code %online%} 与 {@code %max%}：它们走 {@code Bukkit} 的静态方法，
 * 没有服务端就没法求值。那是这两个占位符的固有依赖，靠真实服务端验证。
 *
 * <p>配置走真实的 {@link BoardSettings#load} 路径（用一份 YAML 字符串），
 * 而不是另造一个「测试用」的构造函数 —— 那样测试跑的就不是生产走的那条路了，
 * 顺带也就把颜色码转换一起验了。
 */
class PlaceholdersTest {

    private static final String COLOR = "\u00A7";

    private static final String TEST_YAML =
            "title: \"&6Kokuu\"\n"
            + "lines:\n"
            + "  - \"&7x\"\n"
            + "updateIntervalTicks: 20\n"
            + "worlds:\n"
            + "  mode: blacklist\n"
            + "  list: []\n"
            + "defaultEnabled: true\n"
            + "balanceFallback: \"&8余额不可用\"\n"
            + "unknownFallback: \"&8读不到\"\n";

    private static BoardSettings settings() {
        YamlConfiguration config = new YamlConfiguration();
        try {
            config.loadFromString(TEST_YAML);
        } catch (InvalidConfigurationException broken) {
            throw new IllegalStateException("测试用的 YAML 自己写错了", broken);
        }
        return BoardSettings.load(config, Fakes.quietLogger(), true);
    }

    private static Placeholders placeholders() {
        return new Placeholders(new NoopEconomyBridge(), new TpsMeter(),
                new PingReader(Fakes.quietLogger()));
    }

    @Test
    @DisplayName("认得的占位符换成真实值")
    void substitutesKnownPlaceholders() {
        Player player = Fakes.player("Steve", "world_nether");
        String out = placeholders().resolve(
                "%player%|%displayname%|%world%|%x%|%y%|%z%|%health%|%food%|%level%|%gamemode%",
                player, settings());

        // 坐标取整（1.9 → 1，-2.7 → -3：Location#getBlockX/Y/Z 向下取整）
        assertEquals("Steve|Steve|world_nether|1|64|-3|20|20|5|生存", out);
    }

    @Test
    @DisplayName("认不出的占位符原样保留，好让写错的人一眼看见")
    void keepsUnknownPlaceholders() {
        Player player = Fakes.player("Steve", "world");
        String out = placeholders().resolve("你好 %word% 与 %player%", player, settings());

        assertEquals("你好 %word% 与 Steve", out);
    }

    @Test
    @DisplayName("字面量 % 后面还有占位符时，占位符仍会被替换")
    void literalPercentDoesNotSwallowLaterPlaceholders() {
        Player player = Fakes.player("Steve", "world");
        String out = placeholders().resolve("100% 与 %player%", player, settings());

        assertEquals("100% 与 Steve", out);
    }

    @Test
    @DisplayName("落单的 % 不会吃掉后面的内容")
    void toleratesLonePercent() {
        Player player = Fakes.player("Steve", "world");
        // 没有闭合的 % —— 原样输出剩下的部分，不丢字。
        String out = placeholders().resolve("进度 100% 完成", player, settings());

        assertEquals("进度 100% 完成", out);
    }

    @Test
    @DisplayName("没有经济后端时余额走 balanceFallback，而不是 0")
    void balanceFallsBackWhenNoEconomy() {
        Player player = Fakes.player("Steve", "world");
        String out = placeholders().resolve("%balance%|%balance_raw%", player, settings());

        assertEquals(COLOR + "8余额不可用|" + COLOR + "8读不到", out);
    }

    @Test
    @DisplayName("读不到延迟时用占位文案，而不是一个看起来正常的 0ms")
    void pingFallsBackWhenUnavailable() {
        Player player = Fakes.player("Steve", "world");
        String out = placeholders().resolve("延迟 %ping%ms", player, settings());

        assertEquals("延迟 " + COLOR + "8读不到ms", out);
    }

    @Test
    @DisplayName("没有样本时 TPS 报 20.0，不报 0（刚启动不该显示成卡死）")
    void tpsStartsAtFullValue() {
        Player player = Fakes.player("Steve", "world");
        String out = placeholders().resolve("%tps%", player, settings());

        assertEquals("20.0", out);
    }

    @Test
    @DisplayName("不含 % 的行原样返回，不做无谓的分配")
    void plainLineShortCircuits() {
        Player player = Fakes.player("Steve", "world");
        List<String> cases = Arrays.asList("", "没有占位符", COLOR + "7纯颜色");

        for (String line : cases) {
            assertEquals(line, placeholders().resolve(line, player, settings()));
        }
    }

    @Test
    @DisplayName("占位符之外的颜色码原样保留（& → § 在读取配置时已完成）")
    void keepsColorCodes() {
        Player player = Fakes.player("Steve", "world");
        String out = placeholders().resolve(COLOR + "7玩家: " + COLOR + "f%player%", player, settings());

        assertEquals(COLOR + "7玩家: " + COLOR + "fSteve", out);
        assertTrue(out.indexOf('&') < 0, "不该再有 & 形式的颜色码");
    }
}
