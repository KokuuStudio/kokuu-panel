package com.kokuustudio.kokuupanel.agent.modules;

import com.google.gson.JsonObject;
import com.kokuustudio.kokuupanel.agent.Capabilities;
import com.kokuustudio.kokuupanel.agent.events.EventReporter;
import com.kokuustudio.kokuupanel.agent.model.SmallModels;
import com.kokuustudio.kokuupanel.agent.rpc.Params;
import com.kokuustudio.kokuupanel.agent.rpc.RpcDispatcher;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.bukkit.Bukkit;
import org.bukkit.OfflinePlayer;

/**
 * 白名单（协议 §5.4）。
 *
 * <p>增删白名单不在这里，走 {@code players.setWhitelist}（按玩家维度，语义更清楚）。
 * 这一节只管「列出来」和「开关」。
 */
public final class WhitelistModule {

    private final EventReporter events;

    public WhitelistModule(EventReporter events) {
        this.events = events;
    }

    public void register(RpcDispatcher dispatcher) {
        dispatcher.register("whitelist.list", Capabilities.WHITELIST, false, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                return list(params);
            }
        });
        dispatcher.register("whitelist.setEnabled", Capabilities.WHITELIST, true, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                return setEnabled(params);
            }
        });
    }

    private Object list(Params params) {
        params.done();
        List<SmallModels.WhitelistEntry> entries = new ArrayList<SmallModels.WhitelistEntry>();
        Set<OfflinePlayer> whitelisted = Bukkit.getWhitelistedPlayers();
        if (whitelisted != null) {
            for (OfflinePlayer player : whitelisted) {
                if (player == null) {
                    continue;
                }
                String name = player.getName();
                // 协议里 name 是非空 string：名字拿不到的（从未进过服的条目）
                // 用空串而不是编一个名字。
                entries.add(new SmallModels.WhitelistEntry(
                        player.getUniqueId().toString(), name == null ? "" : name));
            }
        }
        return entries;
    }

    private Object setEnabled(Params params) {
        Boolean value = params.bool("value", true);
        params.done();
        boolean target = value != null && value.booleanValue();
        boolean current = Bukkit.hasWhitelist();
        boolean changed = current != target;
        if (changed) {
            Bukkit.setWhitelist(target);
            JsonObject data = new JsonObject();
            data.addProperty("enabled", target);
            events.emit("whitelist.changed", data);
        }
        return new SmallModels.WriteResult(changed);
    }
}
