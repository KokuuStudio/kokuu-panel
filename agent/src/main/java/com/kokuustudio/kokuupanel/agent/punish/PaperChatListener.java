package com.kokuustudio.kokuupanel.agent.punish;

import io.papermc.paper.event.player.AsyncChatEvent;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;

/**
 * 禁言拦截：Paper 的 {@code AsyncChatEvent}。
 *
 * <p><b>这个类只会被反射加载</b>（见 {@code KokuuAgentPlugin.registerPaperChatListener}）：
 * 它直接引用了 {@code io.papermc.paper.event.player.AsyncChatEvent}（1.19+ 才有），
 * 在没有这个类的服务端上加载它会直接 {@code NoClassDefFoundError}。
 * 所以调用方必须先 {@code Class.forName} 探测，再反射 newInstance。
 *
 * <p>取消逻辑与 {@link PunishChatListener} 共用 {@link MuteGate}，
 * 两个事件上禁言行为一致。
 */
public final class PaperChatListener implements Listener {

    private final MuteGate gate;

    public PaperChatListener(MuteGate gate) {
        this.gate = gate;
    }

    @EventHandler(priority = EventPriority.LOWEST, ignoreCancelled = true)
    public void onChat(AsyncChatEvent event) {
        if (event.isCancelled()) {
            return;
        }
        final AsyncChatEvent target = event;
        gate.deny(event.getPlayer(), new Runnable() {
            @Override
            public void run() {
                target.setCancelled(true);
            }
        });
    }
}
