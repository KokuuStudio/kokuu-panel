package com.kokuustudio.kokuupanel.agent.punish;

import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerChatEvent;

/**
 * 禁言拦截：传统聊天事件 {@code AsyncPlayerChatEvent}。
 *
 * <p>这个事件能覆盖 1.13 → 1.21 的绝大多数服务端（Paper 至今仍然为兼容插件发它）。
 * Paper 新引入的 {@code AsyncChatEvent} 由 {@link PaperChatListener} 兜底，
 * 两个都注册，谁先命中谁取消，另一个看到 cancelled 就直接返回，不会提示两遍。
 *
 * <p>用 {@code LOWEST} 优先级：禁言必须在别的插件动这条消息之前生效。
 *
 * <p>和登录拦截一样：只读内存快照，不做网络请求。
 */
public final class PunishChatListener implements Listener {

    private final MuteGate gate;

    public PunishChatListener(MuteGate gate) {
        this.gate = gate;
    }

    @EventHandler(priority = EventPriority.LOWEST, ignoreCancelled = true)
    public void onChat(AsyncPlayerChatEvent event) {
        if (event.isCancelled()) {
            return;
        }
        final AsyncPlayerChatEvent target = event;
        gate.deny(event.getPlayer(), new Runnable() {
            @Override
            public void run() {
                target.setCancelled(true);
            }
        });
    }

    /** 供测试/调试：判断某个玩家现在是否被禁言。 */
    public boolean isMuted(Player player) {
        return gate.muteOf(player) != null;
    }
}
