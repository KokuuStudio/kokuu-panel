package com.kokuustudio.kokuupanel.agent.modules;

import com.google.gson.JsonObject;
import com.kokuustudio.kokuupanel.agent.Capabilities;
import com.kokuustudio.kokuupanel.agent.KokuuAgentPlugin;
import com.kokuustudio.kokuupanel.agent.model.PlayerEntry;
import com.kokuustudio.kokuupanel.agent.protocol.AgentException;
import com.kokuustudio.kokuupanel.agent.protocol.ErrorCode;
import com.kokuustudio.kokuupanel.agent.rpc.Params;
import com.kokuustudio.kokuupanel.agent.rpc.RpcDispatcher;
import com.kokuustudio.kokuupanel.agent.util.Pings;
import com.kokuustudio.kokuupanel.agent.util.Playtime;
import com.kokuustudio.kokuupanel.agent.util.Text;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.OfflinePlayer;
import org.bukkit.entity.Player;

/**
 * 玩家方法（协议 §5.2）。
 *
 * <p>贯穿这一节的两条规则：
 * <ul>
 *   <li>{@code players.list} 的 {@code withIp} <b>默认 false</b>：玩家 IP 属于个人信息，
 *       默认关掉可以让「不小心把 IP 打进日志」的概率降到零。</li>
 *   <li>UUID 是身份锚点，名字会改。所有按玩家的操作都收 uuid。</li>
 * </ul>
 */
public final class PlayerModule {

    private final KokuuAgentPlugin plugin;

    public PlayerModule(KokuuAgentPlugin plugin) {
        this.plugin = plugin;
    }

    public void register(RpcDispatcher dispatcher) {
        dispatcher.register("players.list", Capabilities.PLAYERS, false, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                return list(params);
            }
        });
        dispatcher.register("players.detail", Capabilities.PLAYERS, false, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                return detail(params);
            }
        });
        dispatcher.register("players.kick", Capabilities.PLAYERS, true, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                return kick(params);
            }
        });
        dispatcher.register("players.setOp", Capabilities.PLAYERS, true, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                return setOp(params);
            }
        });
        dispatcher.register("players.setGamemode", Capabilities.PLAYERS, true, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                return setGamemode(params);
            }
        });
        dispatcher.register("players.setWhitelist", Capabilities.WHITELIST, true, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                return setWhitelist(params);
            }
        });
        dispatcher.register("players.resolve", Capabilities.PLAYERS, false, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                return resolve(params);
            }
        });
    }

    // ── 查询 ──────────────────────────────────────────────────────────────

    /** 只返回**在线**玩家（对应 REST 的 /_api/nodes/:id/online）。 */
    private Object list(Params params) {
        Boolean withIp = params.bool("withIp", false);
        params.done();
        boolean includeIp = withIp != null && withIp.booleanValue();

        List<PlayerEntry> entries = new ArrayList<PlayerEntry>();
        for (Player player : Bukkit.getOnlinePlayers()) {
            entries.add(describe(player, includeIp));
        }
        return entries;
    }

    /**
     * 玩家详情。
     *
     * <p>玩家不在线时回 {@code NOT_ONLINE} 而不是编一个「所有字段都是 0」的条目 ——
     * 平台侧本来就有离线档案（{@code GET /_api/players/:uuid}），
     * 用半真半假的数据去覆盖它只会更难排查。
     */
    private Object detail(Params params) {
        String uuid = params.uuid("uuid");
        params.done();
        Player player = player(uuid);
        if (player == null) {
            throw new AgentException(ErrorCode.NOT_ONLINE, "玩家不在线，无法读取实时详情");
        }
        return describe(player, true);
    }

    /**
     * 按名字解析玩家。
     *
     * <p>刻意**不用** {@code Bukkit.getOfflinePlayer(String)}：那个方法在老版本上会
     * 阻塞主线程去做名字→UUID 的网络查询。这里改成扫本地 usercache
     * （{@code Bukkit.getOfflinePlayers()}），永远不会卡住主线程。
     */
    private Object resolve(Params params) {
        String name = params.playerName("name", true);
        params.done();

        Player online = Bukkit.getPlayerExact(name);
        if (online != null) {
            return resolveResult(online.getUniqueId().toString(), online.getName(), true, online);
        }

        for (OfflinePlayer candidate : Bukkit.getOfflinePlayers()) {
            if (candidate == null || candidate.getName() == null) {
                continue;
            }
            if (candidate.getName().equalsIgnoreCase(name)) {
                boolean isOnline = candidate.isOnline();
                return resolveResult(candidate.getUniqueId().toString(), candidate.getName(),
                        isOnline, candidate.isOnline() ? candidate.getPlayer() : null);
            }
        }
        throw new AgentException(ErrorCode.NOT_FOUND, "本地记录里没有玩家 " + name);
    }

    private JsonObject resolveResult(String uuid, String name, boolean online, Player player) {
        JsonObject result = new JsonObject();
        result.addProperty("uuid", uuid);
        result.addProperty("name", name);
        result.addProperty("online", online);
        if (player != null) {
            result.addProperty("displayName", Text.stripColor(player.getDisplayName()));
            result.addProperty("world", player.getWorld().getName());
        }
        return result;
    }

    // ── 操作 ──────────────────────────────────────────────────────────────

    private Object kick(Params params) {
        String uuid = params.uuid("uuid");
        String reason = params.string("reason", true, 500, null, null);
        params.done();
        Player player = player(uuid);
        if (player == null) {
            throw new AgentException(ErrorCode.NOT_ONLINE, "玩家不在线，无法踢出");
        }
        player.kickPlayer(reason);
        return ok();
    }

    /**
     * 设置 OP。
     *
     * <p>用 {@code OfflinePlayer} 而不是 {@code Player}：OP 状态是持久化的
     * （ops.json），离线也能设，没必要因为人不在线就拒绝一个能完成的动作。
     */
    private Object setOp(Params params) {
        String uuid = params.uuid("uuid");
        Boolean value = params.bool("value", true);
        params.done();
        OfflinePlayer offline = offlinePlayer(uuid);
        boolean target = value != null && value.booleanValue();
        if (offline.isOp() == target) {
            // 幂等：本来就是目标状态，不用重复写文件，也不算失败。
            return ok();
        }
        offline.setOp(target);
        return ok();
    }

    private Object setGamemode(Params params) {
        String uuid = params.uuid("uuid");
        String gamemode = params.enumOf("gamemode", true,
                "SURVIVAL", "CREATIVE", "ADVENTURE", "SPECTATOR");
        params.done();

        Player player = player(uuid);
        if (player == null) {
            throw new AgentException(ErrorCode.NOT_ONLINE, "玩家不在线，无法切换游戏模式");
        }
        GameMode mode;
        try {
            mode = GameMode.valueOf(gamemode);
        } catch (IllegalArgumentException e) {
            // 理论上被上面的 enumOf 挡住了，留个兜底。
            throw Params.invalid("gamemode", "不支持的游戏模式 " + gamemode);
        }
        player.setGameMode(mode);
        return ok();
    }

    private Object setWhitelist(Params params) {
        String uuid = params.uuid("uuid");
        params.playerName("name", true);
        Boolean value = params.bool("value", true);
        params.done();
        OfflinePlayer offline = offlinePlayer(uuid);
        boolean target = value != null && value.booleanValue();
        offline.setWhitelisted(target);
        return ok();
    }

    // ── 工具 ──────────────────────────────────────────────────────────────

    private PlayerEntry describe(Player player, boolean withIp) {
        PlayerEntry entry = new PlayerEntry();
        entry.uuid = player.getUniqueId().toString();
        entry.name = player.getName();
        entry.displayName = Text.stripColor(player.getDisplayName());
        entry.online = true;
        entry.world = player.getWorld().getName();
        entry.x = player.getLocation().getX();
        entry.y = player.getLocation().getY();
        entry.z = player.getLocation().getZ();
        entry.ping = Pings.of(player);
        entry.gamemode = String.valueOf(player.getGameMode());
        entry.health = player.getHealth();
        entry.food = player.getFoodLevel();
        entry.level = player.getLevel();
        entry.op = player.isOp();
        entry.whitelisted = player.isWhitelisted();
        entry.firstPlayed = player.getFirstPlayed();
        entry.lastSeen = System.currentTimeMillis();
        entry.playtimeSeconds = Playtime.seconds(player);
        if (withIp) {
            entry.ip = address(player);
        }
        return entry;
    }

    private static String address(Player player) {
        try {
            if (player.getAddress() != null && player.getAddress().getAddress() != null) {
                return player.getAddress().getAddress().getHostAddress();
            }
        } catch (Throwable ignored) {
            // 代理端实现可能抛异常。
        }
        return "";
    }

    private static Player player(String uuid) {
        try {
            return Bukkit.getPlayer(UUID.fromString(uuid));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static OfflinePlayer offlinePlayer(String uuid) {
        return Bukkit.getOfflinePlayer(UUID.fromString(uuid));
    }

    private static JsonObject ok() {
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        return result;
    }
}
