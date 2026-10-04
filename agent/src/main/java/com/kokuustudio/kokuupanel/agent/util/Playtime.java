package com.kokuustudio.kokuupanel.agent.util;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import org.bukkit.entity.Player;

/**
 * 玩家长度（秒）探测。
 *
 * <p>原理与架构文档 §4.1 的「能力探测优先于版本判断」一致：只认能不能拿到值。
 * Bukkit 没有「在线时长」API，得读统计项，而统计项跨版本改过名和单位：
 *
 * <ul>
 *   <li>1.13+ ：{@code Statistic.PLAY_ONE_MINUTE}（单位：分钟）</li>
 *   <li>≤1.12.2：{@code Statistic.PLAY_ONE_TICK}（单位：tick）</li>
 * </ul>
 *
 * <p>全程反射，因为直接引用常量字段在另一边会抛 {@code NoSuchFieldError}。
 * 探测不到就返回 0 —— 这里不给「估算值」，宁可少一个字段也不要编数据。
 */
public final class Playtime {

    private static boolean initialised;
    private static Method getStatistic;
    /** PLAY_ONE_MINUTE：值需要 ×60；PLAY_ONE_TICK：值需要 ÷20。 */
    private static Object statisticKey;
    private static double multiplier;

    private Playtime() {
    }

    public static long seconds(Player player) {
        init();
        if (getStatistic == null || statisticKey == null) {
            return 0L;
        }
        try {
            Object raw = getStatistic.invoke(player, statisticKey);
            if (!(raw instanceof Number)) {
                return 0L;
            }
            long seconds = (long) (((Number) raw).doubleValue() * multiplier);
            return seconds < 0 ? 0L : seconds;
        } catch (Throwable t) {
            // 统计项在某些服务端上被禁用，拿不到就算 0，不要抛。
            return 0L;
        }
    }

    private static synchronized void init() {
        if (initialised) {
            return;
        }
        initialised = true;
        try {
            Class<?> statisticClass = Class.forName("org.bukkit.Statistic");
            Field minute = field(statisticClass, "PLAY_ONE_MINUTE");
            if (minute != null) {
                statisticKey = minute.get(null);
                multiplier = 60.0D;
            } else {
                Field tick = field(statisticClass, "PLAY_ONE_TICK");
                if (tick != null) {
                    statisticKey = tick.get(null);
                    multiplier = 1.0D / 20.0D;
                }
            }
            if (statisticKey != null) {
                getStatistic = Player.class.getMethod("getStatistic", statisticClass);
            }
        } catch (Throwable t) {
            statisticKey = null;
            getStatistic = null;
        }
    }

    private static Field field(Class<?> owner, String name) {
        try {
            return owner.getField(name);
        } catch (Throwable t) {
            return null;
        }
    }
}
