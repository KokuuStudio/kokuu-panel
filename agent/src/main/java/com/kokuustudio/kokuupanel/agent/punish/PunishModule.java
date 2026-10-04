package com.kokuustudio.kokuupanel.agent.punish;

import com.kokuustudio.kokuupanel.agent.Capabilities;
import com.kokuustudio.kokuupanel.agent.KokuuAgentPlugin;
import com.kokuustudio.kokuupanel.agent.events.EventReporter;
import com.kokuustudio.kokuupanel.agent.model.Punishment;
import com.kokuustudio.kokuupanel.agent.model.SmallModels;
import com.kokuustudio.kokuupanel.agent.protocol.AgentException;
import com.kokuustudio.kokuupanel.agent.protocol.ErrorCode;
import com.kokuustudio.kokuupanel.agent.rpc.Params;
import com.kokuustudio.kokuupanel.agent.rpc.RpcDispatcher;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

/**
 * 封禁 / 禁言模块（协议 §5.3）。
 *
 * <p>三个方法都是**平台 → Agent 的执行指令**，Agent 只是执行器：
 * 更新本地快照 + 该踢就踢。Agent 不写任何本地封禁文件。
 *
 * <p>关于 {@code punish.applied} / {@code punish.revoked} 事件：
 * 协议 §7 把 {@code punish.applied} 标注为「游戏内 /kp ban 触发」。
 * 也就是说这两个事件是**本地发起**的变更用来通知平台的方式；
 * 平台自己下发的 {@code punish.apply} 平台早就知道了，再上报一遍
 * 只会让审计/事件流出现重复记录。所以这里**不上报**，
 * 只有 /kp 命令走 {@link #emitLocalApplied} / {@link #emitLocalRevoked}。
 */
public final class PunishModule {

    private final KokuuAgentPlugin plugin;
    private final PunishSnapshot snapshot;
    private final EventReporter events;

    public PunishModule(KokuuAgentPlugin plugin, PunishSnapshot snapshot, EventReporter events) {
        this.plugin = plugin;
        this.snapshot = snapshot;
        this.events = events;
    }

    public void register(RpcDispatcher dispatcher) {
        dispatcher.register("punish.apply", Capabilities.PUNISH, true,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        return apply(params);
                    }
                });
        dispatcher.register("punish.revoke", Capabilities.PUNISH, true,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        return revoke(params);
                    }
                });
        dispatcher.register("punish.kickNow", Capabilities.PUNISH, true,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        return kickNow(params);
                    }
                });
    }

    // ── punish.apply ──────────────────────────────────────────────────────

    private Object apply(Params params) {
        Params q = params.nested("punishment", true);
        String id = q.string("id", true, 64, null, null);
        String type = q.enumOf("type", true, "ban", "mute", "warn", "kick");
        String uuid = q.uuid("uuid");
        String name = q.playerName("name", true);
        String reason = q.string("reason", true, 500, null, null);
        String operator = q.string("operator", true, 64, null, null);
        String nodeId = q.optionalString("nodeId", 64);
        Long createdAt = q.longValue("createdAt", true);
        Long expiresAt = q.longValue("expiresAt", false);
        Boolean active = q.bool("active", true);
        // 参数没过就不许有副作用。
        params.done();

        Punishment punishment = new Punishment();
        punishment.id = id;
        punishment.type = type;
        punishment.uuid = uuid;
        punishment.name = name;
        punishment.reason = reason;
        punishment.operator = operator;
        punishment.nodeId = nodeId;
        punishment.createdAt = createdAt == null ? System.currentTimeMillis() : createdAt.longValue();
        punishment.expiresAt = expiresAt;
        punishment.active = active == null || active.booleanValue();

        snapshot.put(punishment);
        plugin.getLogger().info("已应用处罚 " + id + "（" + type + " " + name + "）：" + reason);

        if ("kick".equals(type)) {
            // type=kick 的语义就是「立刻踢下线」；ban 不在这里踢，
            // 协议 §5.3 把「封禁后把人踢下线」单独放在 punish.kickNow。
            kickQuietly(uuid, reason);
        }
        return SmallModels.OkResult.of();
    }

    // ── punish.revoke ─────────────────────────────────────────────────────

    private Object revoke(Params params) {
        String id = params.string("id", true, 64, null, null);
        params.done();

        Punishment removed = snapshot.remove(id);
        if (removed == null) {
            // 快照里没有不等于「撤销失败」：Agent 的快照本来就可能落后
            // （刚重连拿到的新快照里已经没有这条了）。按幂等处理，返回 ok，
            // 免得平台的 dispatched 报告里出现假的「节点未生效」。
            plugin.getLogger().fine("撤销 " + id + "：快照里没有这条记录，按幂等处理");
            return SmallModels.OkResult.of();
        }
        plugin.getLogger().info("已撤销处罚 " + id + "（" + removed.type + " " + removed.name + "）");
        return SmallModels.OkResult.of();
    }

    // ── punish.kickNow ────────────────────────────────────────────────────

    private Object kickNow(Params params) {
        String uuid = params.uuid("uuid");
        String reason = params.string("reason", true, 500, null, null);
        params.done();

        Player player = player(uuid);
        if (player == null) {
            throw new AgentException(ErrorCode.NOT_ONLINE, "玩家不在线，无法踢出");
        }
        player.kickPlayer(reason);
        return SmallModels.OkResult.of();
    }

    // ── 本地发起（/kp ban 等） ────────────────────────────────────────────

    /**
     * 构造一条本地发起的处罚记录。
     *
     * <p>id 用 {@code p_} 前缀 + 随机十六进制，和平台的 id 形状一致但不会撞车。
     */
    public Punishment createLocal(String type, String uuid, String name, String reason,
                                  String operator, Long durationSeconds) {
        Punishment punishment = new Punishment();
        punishment.id = "p_" + UUID.randomUUID().toString().replace("-", "");
        punishment.type = type;
        punishment.uuid = uuid;
        punishment.name = name;
        punishment.reason = reason;
        punishment.operator = operator;
        punishment.nodeId = null;
        punishment.createdAt = System.currentTimeMillis();
        punishment.expiresAt = durationSeconds == null || durationSeconds.longValue() <= 0L
                ? null
                : Long.valueOf(System.currentTimeMillis() + durationSeconds.longValue() * 1000L);
        punishment.active = true;
        return punishment;
    }

    /** 本地记录生效 + 上报给平台（平台据此写审计）。 */
    public void applyLocal(Punishment punishment) {
        snapshot.put(punishment);
        events.emit("punish.applied", punishment);
        if ("kick".equals(punishment.type)) {
            kickQuietly(punishment.uuid, punishment.reason);
        }
    }

    /** 本地撤销 + 上报给平台。 */
    public void revokeLocal(Punishment punishment) {
        snapshot.remove(punishment.id);
        java.util.Map<String, String> data = new java.util.HashMap<String, String>();
        data.put("id", punishment.id);
        events.emit("punish.revoked", data);
    }

    // ── 工具 ──────────────────────────────────────────────────────────────

    /** 按 UUID 找到在线玩家（UUID 是身份锚点，名字会改）。 */
    public static Player player(String uuid) {
        if (uuid == null) {
            return null;
        }
        try {
            return Bukkit.getPlayer(UUID.fromString(uuid));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private void kickQuietly(String uuid, String reason) {
        Player player = player(uuid);
        if (player != null) {
            player.kickPlayer(reason == null ? "" : reason);
        }
    }
}
