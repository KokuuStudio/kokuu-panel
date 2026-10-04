package com.kokuustudio.kokuupanel.agent.events;

import com.google.gson.JsonObject;
import com.kokuustudio.kokuupanel.agent.KokuuAgentPlugin;
import com.kokuustudio.kokuupanel.agent.util.Playtime;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.AsyncPlayerChatEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;

/**
 * 玩家相关事件上报（协议 §7）。
 *
 * <p>全部用 {@code EventPriority.MONITOR}：只观察，不改别的插件的处理结果。
 * 唯一例外是禁言（在 {@link com.kokuustudio.kokuupanel.agent.punish.PunishChatListener}
 * 里，用 LOWEST 抢在别人前面取消）。
 */
public final class PlayerEventListener implements Listener {

    private final KokuuAgentPlugin plugin;
    private final EventReporter reporter;
    private final Map<UUID, Long> sessionStart = new ConcurrentHashMap<UUID, Long>();

    public PlayerEventListener(KokuuAgentPlugin plugin, EventReporter reporter) {
        this.plugin = plugin;
        this.reporter = reporter;
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        sessionStart.put(player.getUniqueId(), Long.valueOf(System.currentTimeMillis()));
        JsonObject data = new JsonObject();
        data.addProperty("uuid", player.getUniqueId().toString());
        data.addProperty("name", player.getName());
        data.addProperty("ip", address(player));
        reporter.emit("player.join", data);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent event) {
        Player player = event.getPlayer();
        Long started = sessionStart.remove(player.getUniqueId());
        long playtimeSeconds;
        if (started != null) {
            playtimeSeconds = Math.max(0L, (System.currentTimeMillis() - started.longValue()) / 1000L);
        } else {
            // 插件在玩家在线时被 /reload 过：没有本次会话的起点，
            // 退回到服务端的统计数据（拿不到就是 0）。
            playtimeSeconds = Playtime.seconds(player);
        }
        JsonObject data = new JsonObject();
        data.addProperty("uuid", player.getUniqueId().toString());
        data.addProperty("name", player.getName());
        data.addProperty("playtimeSeconds", playtimeSeconds);
        reporter.emit("player.quit", data);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onChat(AsyncPlayerChatEvent event) {
        if (!reporter.enabled("player.chat")) {
            return;
        }
        Player player = event.getPlayer();
        JsonObject data = new JsonObject();
        data.addProperty("uuid", player.getUniqueId().toString());
        data.addProperty("name", player.getName());
        data.addProperty("message", event.getMessage());
        reporter.emit("player.chat", data);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onDeath(PlayerDeathEvent event) {
        Player player = event.getEntity();
        String cause = "UNKNOWN";
        if (player.getLastDamageCause() != null
                && player.getLastDamageCause().getCause() != null) {
            cause = player.getLastDamageCause().getCause().name();
        }
        Player killer = player.getKiller();
        JsonObject data = new JsonObject();
        data.addProperty("uuid", player.getUniqueId().toString());
        data.addProperty("name", player.getName());
        data.addProperty("cause", cause);
        data.addProperty("killer", killer == null ? "" : killer.getName());
        reporter.emit("player.death", data);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onCommand(PlayerCommandPreprocessEvent event) {
        String message = event.getMessage();
        if (message == null) {
            return;
        }
        // /kp 是我们自己的管理命令，上报它只会污染事件流
        // （而且 /kp ban 已经会走 punish.applied）。
        if (message.regionMatches(true, 0, "/kp", 0, 3)) {
            return;
        }
        Player player = event.getPlayer();
        JsonObject data = new JsonObject();
        data.addProperty("uuid", player.getUniqueId().toString());
        data.addProperty("name", player.getName());
        data.addProperty("command", message);
        reporter.emit("player.command", data);
    }

    /** 玩家 IP。拿不到时给空串（协议里 ip 是非空 string）。 */
    private static String address(Player player) {
        try {
            if (player.getAddress() != null && player.getAddress().getAddress() != null) {
                return player.getAddress().getAddress().getHostAddress();
            }
        } catch (Throwable ignored) {
            // 有些代理端实现会让 getAddress() 抛异常。
        }
        return "";
    }
}
