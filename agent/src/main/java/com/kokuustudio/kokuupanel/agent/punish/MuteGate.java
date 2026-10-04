package com.kokuustudio.kokuupanel.agent.punish;

import com.kokuustudio.kokuupanel.agent.KokuuAgentPlugin;
import com.kokuustudio.kokuupanel.agent.model.Punishment;
import java.util.UUID;
import org.bukkit.entity.Player;

/**
 * 禁言判定的唯一入口。
 *
 * <p>抽出来是为了让传统 {@code AsyncPlayerChatEvent} 与 Paper 的
 * {@code AsyncChatEvent} 两份监听器共用同一套判断，
 * 不会出现「一个事件上禁言生效、另一个上不生效」的漂移。
 *
 * <p>只读内存快照 —— 聊天事件是异步的，绝不能在这里碰主线程 API 或发网络请求。
 */
public final class MuteGate {

    private final KokuuAgentPlugin plugin;
    private final PunishSnapshot snapshot;

    public MuteGate(KokuuAgentPlugin plugin, PunishSnapshot snapshot) {
        this.plugin = plugin;
        this.snapshot = snapshot;
    }

    /** @return 生效中的禁言记录，没有就 null */
    public Punishment muteOf(Player player) {
        UUID uuid = player.getUniqueId();
        return snapshot.findActive("mute", uuid, plugin.config().nodeId, System.currentTimeMillis());
    }

    /** 给玩家的禁言提示（已做 ${reason}/${expires} 替换与颜色转换）。 */
    public String messageFor(Punishment mute) {
        return PunishLoginListener.describe(plugin.config().punishMuteMessage, mute,
                System.currentTimeMillis());
    }

    /**
     * 处理一次聊天：命中禁言就取消并提示。
     *
     * @return true 表示这次聊天被拦下了
     */
    public boolean deny(Player player, Runnable cancel) {
        Punishment mute = muteOf(player);
        if (mute == null) {
            return false;
        }
        cancel.run();
        player.sendMessage(messageFor(mute));
        return true;
    }
}
