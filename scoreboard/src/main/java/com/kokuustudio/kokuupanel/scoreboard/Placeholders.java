package com.kokuustudio.kokuupanel.scoreboard;

import java.lang.management.ManagementFactory;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.regex.Pattern;

import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.entity.Player;

/**
 * 把 config.yml 里的 {@code %xxx%} 换成当前玩家此刻的值。
 *
 * <h2>替换顺序：颜色码先转，占位符后换</h2>
 *
 * {@code &7} → {@code §7} 的转换**必须在占位符替换之前**完成。反过来的话，
 * 玩家名里出现的 {@code &} 会被当成颜色码吃掉 —— 名字里带 {@code &} 是合法的，
 * 而配置里的颜色码是我们自己写的，先转它们不会有副作用。
 *
 * <p>所以模板的颜色码在 {@link BoardSettings#load} 里就已经转好了，
 * 本类拿到的模板只含 {@code §}。这里只需要管占位符本身。
 *
 * <h2>认不出来的占位符原样留着</h2>
 *
 * 比如把 {@code %world%} 打成了 {@code %word%}。原样输出的话，服主一眼就能在
 * 侧边栏里看到自己写错了；换成空串则表现为「这一行莫名其妙少了半截」，
 * 反而更难查。
 *
 * <h2>为什么留着 {@link TpsMeter} 和 {@link EconomyBridge} 的引用</h2>
 *
 * 它们都是「一次测量、多个玩家共享」的东西（TPS 是全服一个值，经济后端
 * 也只需要注册一次），所以由插件持有、注入到这里，而不是每个玩家各造一份。
 */
final class Placeholders {

    /**
     * 什么样的名字才算「占位符名」。
     *
     * 只有字母数字下划线、且以字母或下划线开头。用 {@link java.util.regex.Pattern}
     * 预编译一次 —— 这是刷新循环（每秒 × 在线人数）里的热路径。
     */
    private static final Pattern PLACEHOLDER_NAME = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*");

    private final EconomyBridge economy;
    private final TpsMeter tps;
    private final PingReader ping;

    /** 只在主线程用，所以不必担心 SimpleDateFormat 不是线程安全的。 */
    private final SimpleDateFormat timeFormat = new SimpleDateFormat("HH:mm", Locale.ROOT);
    private final SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);

    Placeholders(EconomyBridge economy, TpsMeter tps, PingReader ping) {
        this.economy = economy;
        this.tps = tps;
        this.ping = ping;
    }

    /** 展开一行。{@code template} 里的颜色码应当已经转成 {@code §}。 */
    String resolve(String template, Player player, BoardSettings settings) {
        if (template == null || template.isEmpty()) return "";
        if (template.indexOf('%') < 0) return template;

        StringBuilder out = new StringBuilder(template.length() + 32);
        int i = 0;
        while (i < template.length()) {
            char c = template.charAt(i);
            if (c != '%') {
                out.append(c);
                i++;
                continue;
            }

            int close = template.indexOf('%', i + 1);
            if (close < 0) {
                // 落单的 % —— 原样输出剩下的部分
                out.append(template, i, template.length());
                break;
            }

            String key = template.substring(i + 1, close);

            /*
             * 「100% 与 %player%」这种情况：第一个 % 和后面那个 % 之间夹着
             * 空格和中文，显然不是占位符名。如果把它当成占位符去找，
             * 就会把「% 与 %」整段当作未知占位符原样输出，后面的 %player%
             * 反而永远轮不到替换。
             *
             * 所以只把**长得像占位符名**的当成占位符；否则这个 % 就是普通字符，
             * 往后挪一位继续扫。
             */
            if (!PLACEHOLDER_NAME.matcher(key).matches()) {
                out.append(c);
                i++;
                continue;
            }

            String value = value(key, player, settings);
            if (value == null) {
                out.append(template, i, close + 1);
            } else {
                out.append(value);
            }
            i = close + 1;
        }
        return out.toString();
    }

    /** 返回 null 表示「不认识这个占位符」，调用方原样保留。 */
    private String value(String key, Player player, BoardSettings settings) {
        String k = key.toLowerCase(Locale.ROOT);

        if ("player".equals(k)) return player.getName();
        if ("displayname".equals(k)) return player.getDisplayName();
        if ("world".equals(k)) return player.getWorld().getName();
        if ("x".equals(k)) return String.valueOf(player.getLocation().getBlockX());
        if ("y".equals(k)) return String.valueOf(player.getLocation().getBlockY());
        if ("z".equals(k)) return String.valueOf(player.getLocation().getBlockZ());
        if ("online".equals(k)) return String.valueOf(Bukkit.getOnlinePlayers().size());
        if ("max".equals(k)) return String.valueOf(Bukkit.getMaxPlayers());

        if ("ping".equals(k)) {
            int ms = ping.ping(player);
            // 读不到就显示占位文案，而不是一个看着像真的的 0ms。
            return ms == PingReader.UNKNOWN ? settings.unknownFallback() : String.valueOf(ms);
        }

        if ("tps".equals(k)) {
            return String.format(Locale.ROOT, "%.1f", tps.tps());
        }

        if ("balance".equals(k)) {
            if (!economy.available()) return settings.balanceFallback();
            return economy.format(player, economy.balance(player));
        }
        if ("balance_raw".equals(k)) {
            if (!economy.available()) return settings.unknownFallback();
            // 取整再输出：Vault 的余额是 double，但经济插件普遍只当整数用，
            // 直接打印会冒出 1234.0 这种尾巴，做数值比较时也更麻烦。
            return String.valueOf(Math.round(economy.balance(player)));
        }
        if ("currency".equals(k)) {
            return economy.available() ? economy.currencyName(player) : "";
        }

        if ("health".equals(k)) return String.valueOf((int) Math.round(player.getHealth()));
        if ("food".equals(k)) return String.valueOf(player.getFoodLevel());
        if ("level".equals(k)) return String.valueOf(player.getLevel());
        if ("gamemode".equals(k)) return gameModeName(player.getGameMode());

        if ("time".equals(k)) return timeFormat.format(new Date());
        if ("date".equals(k)) return dateFormat.format(new Date());
        if ("uptime".equals(k)) return uptime();

        return null;
    }

    /**
     * 服务端已运行时长。
     *
     * 用 JVM 的 uptime 而不是自己记一个「插件 enable 时刻」：后者在
     * {@code /reload} 之后会归零，显示的就不是服务端运行多久了。
     */
    private String uptime() {
        long millis = ManagementFactory.getRuntimeMXBean().getUptime();
        long totalSeconds = millis / 1000L;
        long days = totalSeconds / 86_400L;
        long hours = (totalSeconds % 86_400L) / 3_600L;
        long minutes = (totalSeconds % 3_600L) / 60L;

        StringBuilder out = new StringBuilder();
        if (days > 0) out.append(days).append('天');
        if (days > 0 || hours > 0) out.append(hours).append('时');
        out.append(minutes).append('分');
        return out.toString();
    }

    private static String gameModeName(GameMode mode) {
        if (mode == null) return "";
        switch (mode) {
            case SURVIVAL: return "生存";
            case CREATIVE: return "创造";
            case ADVENTURE: return "冒险";
            case SPECTATOR: return "旁观";
            default: return mode.name();
        }
    }
}
