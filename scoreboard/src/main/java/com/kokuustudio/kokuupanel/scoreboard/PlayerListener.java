package com.kokuustudio.kokuupanel.scoreboard;

import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerChangedWorldEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;

/**
 * 玩家进出与换世界时的处理。
 *
 * <h2>为什么这些事件不能省</h2>
 *
 * 刷新任务是「每 N tick 遍历在线玩家」，它**不知道**谁刚进服、谁刚换世界。
 * 如果只靠它，新玩家要等最多一个刷新周期才看到板子（感觉像卡了一下），
 * 而换世界跨过白名单边界时板子会晚一个周期才消失 —— 在禁止显示的世界里
 * 多留了一小会儿。
 *
 * <p>所以这里只是把「该重画了」提前通知一次；真正的判断逻辑仍然只有
 * {@code refresh} 一处，避免出现两套「该不该显示」的规则。
 */
final class PlayerListener implements Listener {

    private final KokuuScoreboardPlugin plugin;

    PlayerListener(KokuuScoreboardPlugin plugin) {
        this.plugin = plugin;
    }

    /**
     * 优先级用 MONITOR：等别的插件（登录传送、出生点设置之类）都处理完了再画，
     * 免得我们画完之后某个插件又顺手 teleport 把玩家送到别的世界，
     * 那样这一轮画的板子就是错的。
     */
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onJoin(PlayerJoinEvent event) {
        plugin.refresh(event.getPlayer());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onWorldChange(PlayerChangedWorldEvent event) {
        // 换世界可能跨过 worlds 白名单/黑名单的边界 —— 重新判断一次。
        plugin.refresh(event.getPlayer());
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        plugin.forget(event.getPlayer().getUniqueId());
    }
}
