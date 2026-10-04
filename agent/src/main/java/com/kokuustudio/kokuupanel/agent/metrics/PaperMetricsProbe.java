package com.kokuustudio.kokuupanel.agent.metrics;

import java.lang.reflect.Method;
import org.bukkit.Bukkit;

/**
 * Paper 的 TPS / MSPT 探测。
 *
 * <p>架构文档 §4.4 的原则是「能力探测优先于版本判断」：这里只看能不能拿到值，
 * 不做 {@code if (mcVersion >= 1.16)} 这种判断 —— 那种判断在每个小版本上都会被
 * Paper 的 backport 和 Purpur 之类的分支打破。
 *
 * <p>所以走反射：
 * <ul>
 *   <li>{@code Server#getTPS()} → {@code double[3]}（Paper 有，1.12.2 Spigot 没有）</li>
 *   <li>{@code Server#getAverageTickTime()} → {@code double}（毫秒）</li>
 * </ul>
 *
 * <p><b>取不到就返回 null，绝不编造 20.0。</b>探测结果会缓存，
 * 免得每 10 秒反射一次；失败也只探一次。
 */
public final class PaperMetricsProbe {

    private static boolean initialised;
    private static Method getTps;
    private static Method getAverageTickTime;

    private PaperMetricsProbe() {
    }

    /** @return [1m,5m,15m]，取不到返回 null */
    public static double[] tps() {
        init();
        if (getTps == null) {
            return null;
        }
        try {
            Object value = getTps.invoke(Bukkit.getServer());
            if (!(value instanceof double[])) {
                return null;
            }
            double[] tps = (double[]) value;
            if (tps.length < 3) {
                return null;
            }
            return new double[] { tps[0], tps[1], tps[2] };
        } catch (Throwable t) {
            // 调用失败（版本变了/实现抛异常）→ 认为不可用，不要每 10 秒重试。
            getTps = null;
            return null;
        }
    }

    /** @return 平均 tick 耗时（毫秒），取不到返回 null */
    public static Double mspt() {
        init();
        if (getAverageTickTime == null) {
            return null;
        }
        try {
            Object value = getAverageTickTime.invoke(Bukkit.getServer());
            return value instanceof Number ? Double.valueOf(((Number) value).doubleValue()) : null;
        } catch (Throwable t) {
            getAverageTickTime = null;
            return null;
        }
    }

    /** 供 /kp status 展示：探测到的能力。 */
    public static String describe() {
        init();
        StringBuilder builder = new StringBuilder();
        builder.append("tps=").append(getTps != null ? "paper" : "none");
        builder.append(", mspt=").append(getAverageTickTime != null ? "paper" : "none");
        return builder.toString();
    }

    private static synchronized void init() {
        if (initialised) {
            return;
        }
        initialised = true;
        Class<?> serverClass = Bukkit.getServer().getClass();
        getTps = method(serverClass, "getTPS");
        getAverageTickTime = method(serverClass, "getAverageTickTime");
        if (getAverageTickTime == null) {
            // 少数实现把它放在 Server 接口上而不是 CraftServer 上。
            getAverageTickTime = method(org.bukkit.Server.class, "getAverageTickTime");
        }
    }

    private static Method method(Class<?> owner, String name) {
        try {
            return owner.getMethod(name);
        } catch (Throwable t) {
            return null;
        }
    }
}
