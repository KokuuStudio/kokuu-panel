package com.kokuustudio.kokuupanel.agent.punish;

import com.kokuustudio.kokuupanel.agent.KokuuAgentPlugin;
import com.kokuustudio.kokuupanel.agent.model.Punishment;
import com.kokuustudio.kokuupanel.agent.util.Text;
import com.kokuustudio.kokuupanel.agent.ws.ConnectionManager;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.UUID;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerLoginEvent;

/**
 * 登录拦截。
 *
 * <p><b>架构文档 §3 的硬要求：这里只读内存快照，绝不做网络请求。</b>
 * {@code PlayerLoginEvent} 跑在主线程上，一个阻塞的网络请求会把整个服务器卡住。
 *
 * <p>断连 / 快照过期时怎么办由 {@code punish.failClosed} 决定：
 * <ul>
 *   <li>默认 fail-open：放进来。「漏放一个该封的人」比「把全服玩家挡在门外」轻。</li>
 *   <li>fail-closed：拦下来。不接受任何漏网，同时接受误拦。</li>
 * </ul>
 * 这是刻意的取舍，不是没实现好。
 */
public final class PunishLoginListener implements Listener {

    /** 快照过期的 WARN 最多每 5 分钟打一次，免得刷屏。 */
    private static final long STALE_WARN_INTERVAL_MS = 5L * 60L * 1000L;

    private final KokuuAgentPlugin plugin;
    private final PunishSnapshot snapshot;
    private final ConnectionManager connection;
    private volatile long lastStaleWarnAt;

    public PunishLoginListener(KokuuAgentPlugin plugin, PunishSnapshot snapshot,
                               ConnectionManager connection) {
        this.plugin = plugin;
        this.snapshot = snapshot;
        this.connection = connection;
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onLogin(PlayerLoginEvent event) {
        long now = System.currentTimeMillis();
        String nodeId = plugin.config().nodeId;
        UUID uuid = event.getPlayer().getUniqueId();

        // 1) 命中封禁：直接拦。这一步不碰网络。
        Punishment ban = snapshot.findActive("ban", uuid, nodeId, now);
        if (ban != null) {
            event.disallow(PlayerLoginEvent.Result.KICK_BANNED,
                    describe(plugin.config().punishBanMessage, ban, now));
            return;
        }

        long age = snapshot.ageMs();
        int staleMinutes = plugin.config().punishStaleWarnMinutes;
        long staleMillis = staleMinutes * 60_000L;
        boolean stale = !snapshot.isLoaded() || (staleMillis > 0L && age > staleMillis);

        if (stale && staleMinutes > 0 && now - lastStaleWarnAt > STALE_WARN_INTERVAL_MS) {
            lastStaleWarnAt = now;
            plugin.getLogger().warning("封禁快照"
                    + (snapshot.isLoaded() ? "已 " + (age / 60_000L) + " 分钟未更新" : "从未加载成功")
                    + "（阈值 " + staleMinutes + " 分钟）。"
                    + (plugin.config().punishFailClosed ? "当前 fail-closed，将拦截登录。" : "当前 fail-open，放行。"));
        }

        // 2) fail-closed：快照不可信时才拦。
        if (plugin.config().punishFailClosed) {
            if (!connection.isAuthenticated() || stale) {
                event.disallow(PlayerLoginEvent.Result.KICK_OTHER,
                        Text.colorize(plugin.config().punishUnavailableMessage));
            }
        }
    }

    /** 组装给玩家看的封禁提示：${reason} / ${expires} 替换 + & 颜色代码。 */
    static String describe(String template, Punishment punishment, long now) {
        String reason = punishment.reason == null || punishment.reason.isEmpty()
                ? "未填写原因" : punishment.reason;
        String expires;
        if (punishment.expiresAt == null) {
            expires = "（永久）";
        } else {
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm");
            expires = "（解封时间 " + format.format(new Date(punishment.expiresAt.longValue())) + "）";
        }
        String text = Text.fill(template, "reason", reason);
        text = Text.fill(text, "expires", expires);
        return Text.colorize(text);
    }
}
