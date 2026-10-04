package com.kokuustudio.kokuupanel.scoreboard;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.logging.Logger;

import org.bukkit.entity.Player;

/**
 * 读玩家延迟（毫秒）。
 *
 * <h2>为什么必须用反射</h2>
 *
 * {@code Player#getPing()} **在 1.12.2 的 API 里不存在**（已用 javap 对着
 * pom 里那个 spigot-api 1.12.2 的 jar 确认过），它到 1.16.1 才进 API。
 * 而本插件要同时跑 1.12.2 和最新版，所以两条路都得留着：
 *
 * <ol>
 *   <li>1.16.1+：直接调 {@code Player#getPing()}；</li>
 *   <li>更早的版本：{@code CraftPlayer#getHandle()} 拿到 NMS 的 {@code EntityPlayer}，
 *       读它的 {@code ping} 字段。</li>
 * </ol>
 *
 * <p>字段名在不同版本间改过（1.20.2 之后叫 {@code latency}），所以两个名字都试。
 * 全都失败时返回 {@link #UNKNOWN} —— 让调用方显示占位文案，
 * 而不是报一个看起来像真的的 {@code 0ms}。
 *
 * <p>解析结果一次性缓存：每次刷新都重新遍历方法/字段会白白吃掉主线程时间，
 * 而「哪个版本用哪条路」在进程生命周期内不会变。
 */
final class PingReader {

    /** 读不到时的返回值。 */
    static final int UNKNOWN = -1;

    private final Logger logger;

    private boolean resolved;
    private Method playerGetPing;
    private Method craftGetHandle;
    private Field handlePingField;
    private String handlePingFieldName;
    private boolean warnedOnce;

    PingReader(Logger logger) {
        this.logger = logger;
    }

    /** 玩家延迟（毫秒），读不到返回 {@link #UNKNOWN}。 */
    int ping(Player player) {
        if (!resolved) {
            resolve(player);
        }

        if (playerGetPing != null) {
            try {
                Object value = playerGetPing.invoke(player);
                if (value instanceof Integer) {
                    return (Integer) value;
                }
            } catch (Throwable ignored) {
                // 掉到下面那条路再试一次
            }
        }

        if (craftGetHandle != null && handlePingField != null) {
            try {
                Object handle = craftGetHandle.invoke(player);
                return handlePingField.getInt(handle);
            } catch (Throwable ignored) {
                // 下面统一处理
            }
        }

        warnOnce();
        return UNKNOWN;
    }

    private void resolve(Player sample) {
        resolved = true;

        // 路 1：1.16.1+ 的 Player#getPing()
        try {
            playerGetPing = Player.class.getMethod("getPing");
        } catch (NoSuchMethodException notInThisVersion) {
            playerGetPing = null;
        }

        // 路 2：CraftPlayer#getHandle() → EntityPlayer.ping / .latency
        try {
            craftGetHandle = sample.getClass().getMethod("getHandle");
            Object handle = craftGetHandle.invoke(sample);
            for (String candidate : new String[] { "ping", "latency" }) {
                try {
                    Field field = handle.getClass().getField(candidate);
                    if (field.getType() == int.class) {
                        handlePingField = field;
                        handlePingFieldName = candidate;
                        break;
                    }
                } catch (NoSuchFieldException tryNext) {
                    // 换下一个名字
                }
            }
        } catch (Throwable notAvailable) {
            craftGetHandle = null;
        }

        if (playerGetPing == null && handlePingField == null) {
            logger.warning("这个服务端上读不到玩家延迟（%ping% 会显示占位文案）。"
                    + "已尝试 Player#getPing() 与 CraftPlayer#getHandle().ping/latency 两条路，都不存在。");
        }
    }

    private void warnOnce() {
        if (warnedOnce) return;
        warnedOnce = true;
        logger.warning("%ping% 这一轮读取失败"
                + (handlePingFieldName == null ? "" : "（字段 " + handlePingFieldName + "）")
                + "，本行会显示占位文案。");
    }
}
