package com.kokuustudio.kokuupanel.agent.command;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.kokuustudio.kokuupanel.agent.KokuuAgentPlugin;
import com.kokuustudio.kokuupanel.agent.model.Metrics;
import com.kokuustudio.kokuupanel.agent.model.Punishment;
import com.kokuustudio.kokuupanel.agent.protocol.Protocol;
import com.kokuustudio.kokuupanel.agent.punish.PunishModule;
import com.kokuustudio.kokuupanel.agent.ws.AgentRpc;
import com.kokuustudio.kokuupanel.agent.ws.PendingRequests;
import com.kokuustudio.kokuupanel.agent.ws.ConnectionManager;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;

/**
 * {@code /kp} 命令。
 *
 * <p>设计原则：**需要平台数据的一律走 Agent→平台 RPC**。
 * {@code /kp info} 与 {@code /kp ban} 先问平台的 {@code player.resolve}，
 * 这样游戏内的操作也会落进平台的审计日志 —— 否则「谁在游戏里封了人」
 * 在平台上查不到，只能翻服务器日志。
 *
 * <p>权限：{@code kokuuagent.admin}（管理子命令）/ {@code kokuuagent.use}（查询子命令）。
 */
public final class KpCommand implements CommandExecutor, TabCompleter {

    private static final String PREFIX = "\u00A76[KokuuPanel] \u00A7r";

    private final KokuuAgentPlugin plugin;

    public KpCommand(KokuuAgentPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0) {
            usage(sender, label);
            return true;
        }
        String sub = args[0].toLowerCase(Locale.ROOT);
        if ("status".equals(sub)) {
            if (require(sender, "kokuuagent.use")) {
                status(sender);
            }
            return true;
        }
        if ("reload".equals(sub)) {
            if (require(sender, "kokuuagent.admin")) {
                reload(sender);
            }
            return true;
        }
        if ("info".equals(sub)) {
            if (require(sender, "kokuuagent.use")) {
                info(sender, args);
            }
            return true;
        }
        if ("ban".equals(sub) || "mute".equals(sub)) {
            if (require(sender, "kokuuagent.admin")) {
                punish(sender, sub, args);
            }
            return true;
        }
        if ("unban".equals(sub) || "unmute".equals(sub)) {
            if (require(sender, "kokuuagent.admin")) {
                revoke(sender, sub.equals("unban") ? "ban" : "mute", args);
            }
            return true;
        }
        usage(sender, label);
        return true;
    }

    // ── /kp status ────────────────────────────────────────────────────────

    private void status(CommandSender sender) {
        ConnectionManager connection = plugin.connection();
        sender.sendMessage(PREFIX + "\u00A76KokuuAgent \u00A77v"
                + plugin.getDescription().getVersion() + " \u00A78(协议 v" + Protocol.VERSION
                + ", Java 8 字节码)");
        sender.sendMessage("\u00A77连接：\u00A7f" + connection.getConnectionState()
                + " \u00A78" + connection.getPanelUrl());
        sender.sendMessage("\u00A77节点：\u00A7f" + plugin.config().nodeId
                + " \u00A78session=" + (connection.getSessionId().isEmpty() ? "-" : connection.getSessionId())
                + " \u00A78心跳=" + (connection.getServerHeartbeatMs() / 1000L) + "s");
        sender.sendMessage("\u00A77能力：\u00A7f" + join(plugin.declaredCapabilities()));
        sender.sendMessage("\u00A77LuckPerms：\u00A7f" + plugin.luckPermsHook().describe()
                + " \u00A78| \u00A77经济：\u00A7f" + plugin.vaultHook().describe());
        long age = plugin.punishSnapshot().ageMs();
        sender.sendMessage("\u00A77封禁快照：\u00A7frevision "
                + plugin.punishSnapshot().revision() + ", 生效 "
                + plugin.punishSnapshot().size() + " 条, 年龄 "
                + (age < 0L ? "从未加载" : (age / 1000L) + "s"));
        sender.sendMessage("\u00A77队列：\u00A7f出站等待 " + connection.pendingCount()
                + ", 发送队列 " + connection.outQueueDepth()
                + " \u00A78| \u00A77重连尝试 " + connection.getReconnectAttempts()
                + " \u00A78| \u00A77最后收帧 " + ageOf(connection.getLastInboundAt()));
        sender.sendMessage("\u00A77只读模式：\u00A7f" + (plugin.config().readOnly ? "是" : "否")
                + " \u00A78| \u00A77fail-closed：\u00A7f"
                + (plugin.config().punishFailClosed ? "是" : "否")
                + " \u00A78| \u00A77console 事件：\u00A7f"
                + (plugin.config().eventsConsole ? "开" : "关"));
        Metrics metrics = plugin.metricsCollector().collect();
        sender.sendMessage("\u00A77TPS：\u00A7f" + format(metrics.tps)
                + " \u00A78MSPT：\u00A7f" + (metrics.mspt == null ? "null" : metrics.mspt.toString())
                + " \u00A78在线：\u00A7f" + metrics.online + "/" + metrics.maxPlayers);
        sender.sendMessage("\u00A77幂等缓存：\u00A7f" + plugin.idempotencyStore().size() + " 条"
                + " \u00A78| \u00A77console 已发/丢弃：\u00A7f"
                + plugin.eventReporter().consoleSentTotal() + "/"
                + plugin.eventReporter().consoleDroppedTotal());
        if (connection.isHalted()) {
            sender.sendMessage("\u00A7c已停止重连：" + connection.getHaltReason());
            sender.sendMessage("\u00A7c处理完问题后用 \u00A7f/kp reload \u00A7c重新连接。");
        }
    }

    // ── /kp reload ────────────────────────────────────────────────────────

    private void reload(CommandSender sender) {
        plugin.reloadEverything();
        sender.sendMessage(PREFIX + "\u00A7a配置已重载。");
        sender.sendMessage("\u00A77连接：\u00A7f" + plugin.connection().getConnectionState());
        sender.sendMessage("\u00A77能力：\u00A7f" + join(plugin.declaredCapabilities()));
    }

    // ── /kp info ──────────────────────────────────────────────────────────

    private void info(final CommandSender sender, String[] args) {
        if (args.length < 2) {
            sender.sendMessage(PREFIX + "\u00A7c用法：/kp info <玩家>");
            return;
        }
        final String name = args[1];
        sender.sendMessage(PREFIX + "\u00A77正在向平台查询 \u00A7f" + name + "\u00A77 …");
        plugin.rpc().resolvePlayer(name).whenComplete(new java.util.function.BiConsumer<JsonObject, Throwable>() {
            @Override
            public void accept(final JsonObject response, final Throwable error) {
                plugin.runOnMain(new Runnable() {
                    @Override
                    public void run() {
                        if (error != null) {
                            sender.sendMessage(PREFIX + "\u00A7c查询失败：" + describe(error));
                            sender.sendMessage("\u00A77（平台数据需要连接正常；连接状态见 /kp status）");
                            return;
                        }
                        JsonObject result = AgentRpc.resultOf(response);
                        String uuid = Protocol.string(result, "uuid");
                        String resolvedName = Protocol.string(result, "name");
                        boolean known = Protocol.bool(result, "known", false);
                        boolean online = Protocol.bool(result, "online", false);
                        sender.sendMessage(PREFIX + "\u00A77玩家：\u00A7f"
                                + (resolvedName == null ? name : resolvedName));
                        sender.sendMessage("\u00A77UUID：\u00A7f" + (uuid == null ? "-" : uuid));
                        sender.sendMessage("\u00A77平台记录：\u00A7f" + (known ? "有" : "无")
                                + " \u00A78| \u00A77在线：\u00A7f" + (online ? "是" : "否"));
                        JsonElement punishments = result.get("punishments");
                        if (punishments != null && punishments.isJsonArray()) {
                            JsonArray array = punishments.getAsJsonArray();
                            sender.sendMessage("\u00A77历史处罚：\u00A7f" + array.size() + " 条");
                            int shown = 0;
                            for (JsonElement element : array) {
                                if (shown >= 5 || !element.isJsonObject()) {
                                    break;
                                }
                                JsonObject item = element.getAsJsonObject();
                                sender.sendMessage("\u00A78 - " + Protocol.string(item, "type")
                                        + " " + (Protocol.bool(item, "active", false) ? "生效中" : "已结束")
                                        + " " + Protocol.string(item, "reason"));
                                shown++;
                            }
                            if (array.size() > shown) {
                                sender.sendMessage("\u00A78 …（其余 " + (array.size() - shown)
                                        + " 条请在平台查看）");
                            }
                        }
                    }
                });
            }
        });
    }

    // ── /kp ban | /kp mute ────────────────────────────────────────────────

    private void punish(final CommandSender sender, String type, String[] args) {
        if (args.length < 2) {
            sender.sendMessage(PREFIX + "\u00A7c用法：/kp " + type + " <玩家> [原因] [时长]");
            sender.sendMessage("\u00A77时长写法：30m / 12h / 7d，省略或写 perm 表示永久");
            return;
        }
        final String name = args[1];
        String durationToken = null;
        if (args.length >= 3) {
            String last = args[args.length - 1];
            if (isPermanent(last) || parseDurationSeconds(last) != null) {
                durationToken = last;
            }
        }
        int reasonEnd = args.length - (durationToken == null ? 0 : 1);
        StringBuilder reasonBuilder = new StringBuilder();
        for (int i = 2; i < reasonEnd; i++) {
            if (reasonBuilder.length() > 0) {
                reasonBuilder.append(' ');
            }
            reasonBuilder.append(args[i]);
        }
        final String reason = reasonBuilder.length() == 0 ? "未填写原因" : reasonBuilder.toString();
        long defaultSeconds = plugin.config().commandDefaultBanSeconds;
        final Long durationSeconds;
        if (durationToken == null) {
            durationSeconds = defaultSeconds > 0 ? Long.valueOf(defaultSeconds) : null;
        } else if (isPermanent(durationToken)) {
            durationSeconds = null;
        } else {
            durationSeconds = parseDurationSeconds(durationToken);
        }

        final String operator = sender instanceof Player ? sender.getName() : "console";
        final String finalType = type;
        sender.sendMessage(PREFIX + "\u00A77正在向平台确认玩家 \u00A7f" + name + "\u00A77 …");
        plugin.rpc().resolvePlayer(name).whenComplete(new java.util.function.BiConsumer<JsonObject, Throwable>() {
            @Override
            public void accept(final JsonObject response, final Throwable error) {
                plugin.runOnMain(new Runnable() {
                    @Override
                    public void run() {
                        if (error != null) {
                            sender.sendMessage(PREFIX + "\u00A7c无法确认玩家："
                                    + describe(error) + "\u00A77；游戏内处罚需要平台在线，已取消。");
                            return;
                        }
                        JsonObject result = AgentRpc.resultOf(response);
                        String uuid = Protocol.string(result, "uuid");
                        String resolvedName = Protocol.string(result, "name");
                        if (uuid == null) {
                            sender.sendMessage(PREFIX + "\u00A7c平台返回里没有 UUID，已取消。");
                            return;
                        }
                        if (!Protocol.bool(result, "known", false)) {
                            sender.sendMessage(PREFIX + "\u00A7c平台没有玩家 \u00A7f"
                                    + (resolvedName == null ? name : resolvedName)
                                    + "\u00A7c 的记录（可能是拼错了），已取消。");
                            return;
                        }
                        Punishment punishment = plugin.punishModule().createLocal(finalType, uuid,
                                resolvedName == null ? name : resolvedName, reason, operator,
                                durationSeconds);
                        plugin.punishModule().applyLocal(punishment);
                        sender.sendMessage(PREFIX + "\u00A7a已" + ("mute".equals(finalType) ? "禁言" : "封禁")
                                + " \u00A7f" + punishment.name + "\u00A7a：\u00A7f" + reason
                                + "\u00A77（" + describeDuration(punishment) + "，id " + punishment.id + "）");
                        sender.sendMessage("\u00A77该记录已作为 punish.applied 事件上报平台，会进平台审计日志。");
                    }
                });
            }
        });
    }

    // ── /kp unban | /kp unmute ────────────────────────────────────────────

    private void revoke(CommandSender sender, String type, String[] args) {
        if (args.length < 2) {
            sender.sendMessage(PREFIX + "\u00A7c用法：/kp " + ("ban".equals(type) ? "unban" : "unmute")
                    + " <玩家|处罚ID>");
            return;
        }
        final String target = args[1];

        Punishment direct = plugin.punishSnapshot().byId(target);
        if (direct != null) {
            finishRevoke(sender, direct);
            return;
        }
        // 先在本服快照里按名字找
        for (Punishment punishment : plugin.punishSnapshot().active()) {
            if (type.equals(punishment.type) && punishment.name != null
                    && punishment.name.equalsIgnoreCase(target)) {
                finishRevoke(sender, punishment);
                return;
            }
        }
        // 快照里没有：问平台拿 UUID 再找一次
        sender.sendMessage(PREFIX + "\u00A77本服快照里没有找到，正在向平台确认 \u00A7f" + target + "\u00A77 …");
        plugin.rpc().resolvePlayer(target).whenComplete(new java.util.function.BiConsumer<JsonObject, Throwable>() {
            @Override
            public void accept(final JsonObject response, final Throwable error) {
                plugin.runOnMain(new Runnable() {
                    @Override
                    public void run() {
                        if (error != null) {
                            sender.sendMessage(PREFIX + "\u00A7c查询失败：" + describe(error));
                            return;
                        }
                        String uuid = Protocol.string(AgentRpc.resultOf(response), "uuid");
                        Punishment found = null;
                        if (uuid != null) {
                            for (Punishment punishment : plugin.punishSnapshot().active()) {
                                if (type.equals(punishment.type) && uuid.equalsIgnoreCase(punishment.uuid)) {
                                    found = punishment;
                                    break;
                                }
                            }
                        }
                        if (found == null) {
                            sender.sendMessage(PREFIX + "\u00A7c本服快照里没有 " + target
                                    + " 的生效中记录。");
                            sender.sendMessage("\u00A77（平台的处罚是权威数据，如果平台上有这条记录，"
                                    + "请在平台页面上撤销；本服快照只反映下发到本节点的部分。）");
                            return;
                        }
                        finishRevoke(sender, found);
                    }
                });
            }
        });
    }

    private void finishRevoke(CommandSender sender, Punishment punishment) {
        plugin.punishModule().revokeLocal(punishment);
        sender.sendMessage(PREFIX + "\u00A7a已撤销 \u00A7f" + punishment.type + " \u00A7a（"
                + punishment.name + "，id " + punishment.id + "）");
        sender.sendMessage("\u00A77该撤销已作为 punish.revoked 事件上报平台。");
    }

    // ── 工具 ──────────────────────────────────────────────────────────────

    /**
     * 解析时长：{@code 30m / 12h / 7d / 2w} 或纯秒数。
     *
     * @return 秒数；无法解析时返回 null（调用方据此把这一段当成原因文本）
     */
    static Long parseDurationSeconds(String token) {
        if (token == null || token.isEmpty() || isPermanent(token)) {
            return null;
        }
        char unit = token.charAt(token.length() - 1);
        long multiplier;
        String digits;
        if (Character.isDigit(unit)) {
            multiplier = 1L;
            digits = token;
        } else {
            String lower = String.valueOf(Character.toLowerCase(unit));
            if ("s".equals(lower)) {
                multiplier = 1L;
            } else if ("m".equals(lower)) {
                multiplier = 60L;
            } else if ("h".equals(lower)) {
                multiplier = 3600L;
            } else if ("d".equals(lower)) {
                multiplier = 86400L;
            } else if ("w".equals(lower)) {
                multiplier = 604800L;
            } else {
                return null;
            }
            digits = token.substring(0, token.length() - 1);
        }
        if (digits.isEmpty() || digits.length() > 9) {
            return null;
        }
        for (int i = 0; i < digits.length(); i++) {
            if (!Character.isDigit(digits.charAt(i))) {
                return null;
            }
        }
        long value = Long.parseLong(digits);
        return Long.valueOf(value <= 0L ? 0L : value * multiplier);
    }

    static boolean isPermanent(String token) {
        if (token == null) {
            return false;
        }
        String lower = token.toLowerCase(Locale.ROOT);
        return "perm".equals(lower) || "permanent".equals(lower) || "forever".equals(lower)
                || "永久".equals(token) || "-".equals(token);
    }

    /** 「最后收帧」的年龄；0 表示还没连上过。 */
    private static String ageOf(long timestamp) {
        if (timestamp <= 0L) {
            return "-";
        }
        long seconds = Math.max(0L, (System.currentTimeMillis() - timestamp) / 1000L);
        return seconds + "s 前";
    }

    private static String describeDuration(Punishment punishment) {        if (punishment.expiresAt == null) {
            return "永久";
        }
        long seconds = Math.max(0L, (punishment.expiresAt.longValue() - System.currentTimeMillis()) / 1000L);
        if (seconds >= 86400L) {
            return (seconds / 86400L) + "天";
        }
        if (seconds >= 3600L) {
            return (seconds / 3600L) + "小时";
        }
        return (seconds / 60L) + "分钟";
    }

    private static String format(double[] tps) {
        if (tps == null || tps.length < 3) {
            return "null（本服务端没有可用的 TPS 采集途径）";
        }
        return round(tps[0]) + "/" + round(tps[1]) + "/" + round(tps[2]);
    }

    private static String round(double value) {
        return String.valueOf(Math.round(value * 100.0D) / 100.0D);
    }

    private static String join(List<String> values) {
        StringBuilder builder = new StringBuilder();
        for (String value : values) {
            if (builder.length() > 0) {
                builder.append(", ");
            }
            builder.append(value);
        }
        return builder.toString();
    }

    private static String describe(Throwable error) {
        if (error instanceof PendingRequests.PlatformError) {
            return ((PendingRequests.PlatformError) error).getCode() + " " + error.getMessage();
        }
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }

    private static boolean require(CommandSender sender, String permission) {
        if (sender.hasPermission(permission)) {
            // Bukkit 只认注册过的权限点；kokuuagent.* 已在 plugin.yml 里声明。
            return true;
        }
        sender.sendMessage(PREFIX + "\u00A7c缺少权限 " + permission);
        return false;
    }

    private void usage(CommandSender sender, String label) {
        sender.sendMessage(PREFIX + "\u00A77用法：");
        sender.sendMessage("\u00A78/" + label + " status \u00A77- 连接状态、快照年龄、队列、能力");
        sender.sendMessage("\u00A78/" + label + " reload \u00A77- 重载 config.yml 并重连");
        sender.sendMessage("\u00A78/" + label + " info <玩家> \u00A77- 向平台查询玩家");
        sender.sendMessage("\u00A78/" + label + " ban|unban|mute|unmute <玩家> [原因] [时长]");
    }

    // ── Tab 补全 ──────────────────────────────────────────────────────────

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        List<String> result = new ArrayList<String>();
        if (args.length == 1) {
            String prefix = args[0].toLowerCase(Locale.ROOT);
            for (String candidate : new String[] { "status", "reload", "info", "ban", "unban", "mute", "unmute" }) {
                if (candidate.startsWith(prefix)) {
                    result.add(candidate);
                }
            }
            return result;
        }
        if (args.length == 2) {
            String sub = args[0].toLowerCase(Locale.ROOT);
            if ("info".equals(sub) || "ban".equals(sub) || "unban".equals(sub)
                    || "mute".equals(sub) || "unmute".equals(sub)) {
                String prefix = args[1].toLowerCase(Locale.ROOT);
                for (Player player : Bukkit.getOnlinePlayers()) {
                    if (player.getName().toLowerCase(Locale.ROOT).startsWith(prefix)) {
                        result.add(player.getName());
                    }
                }
            }
            return result;
        }
        if (args.length == 4) {
            String sub = args[0].toLowerCase(Locale.ROOT);
            if ("ban".equals(sub) || "mute".equals(sub)) {
                for (String candidate : new String[] { "30m", "1h", "12h", "1d", "7d", "perm" }) {
                    if (candidate.startsWith(args[3].toLowerCase(Locale.ROOT))) {
                        result.add(candidate);
                    }
                }
            }
        }
        return result;
    }
}
