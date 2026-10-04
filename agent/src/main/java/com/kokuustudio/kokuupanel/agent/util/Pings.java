package com.kokuustudio.kokuupanel.agent.util;

import java.lang.reflect.Method;
import org.bukkit.entity.Player;

/**
 * 玩家延迟（毫秒）探测。
 *
 * <ul>
 *   <li>1.16.2+ ：{@code Player#getPing()}</li>
 *   <li>更老（含 1.12.2）：{@code Player#spigot()#getPing()}</li>
 * </ul>
 *
 * <p>两条路都是真实读数；都拿不到时返回 0 —— 协议里 {@code ping} 是非空 int，
 * 没有 null 可用，这里如实说明「0 表示未知」而不是编一个看起来正常的数。
 */
public final class Pings {

    private static boolean initialised;
    private static Method getPing;
    private static Method spigot;
    private static Method spigotGetPing;

    private Pings() {
    }

    public static int of(Player player) {
        init();
        if (getPing != null) {
            try {
                Object value = getPing.invoke(player);
                if (value instanceof Number) {
                    return ((Number) value).intValue();
                }
            } catch (Throwable ignored) {
                // 落到 spigot() 那条路
            }
        }
        if (spigot != null && spigotGetPing != null) {
            try {
                Object handle = spigot.invoke(player);
                if (handle != null) {
                    Object value = spigotGetPing.invoke(handle);
                    if (value instanceof Number) {
                        return ((Number) value).intValue();
                    }
                }
            } catch (Throwable ignored) {
                // 返 0
            }
        }
        return 0;
    }

    private static synchronized void init() {
        if (initialised) {
            return;
        }
        initialised = true;
        try {
            getPing = Player.class.getMethod("getPing");
        } catch (Throwable t) {
            getPing = null;
        }
        try {
            spigot = Player.class.getMethod("spigot");
            Class<?> spigotClass = spigot.getReturnType();
            spigotGetPing = spigotClass.getMethod("getPing");
        } catch (Throwable t) {
            spigot = null;
            spigotGetPing = null;
        }
    }
}
