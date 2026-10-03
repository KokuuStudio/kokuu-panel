package io.github.kokuustudio.exchange;

import com.google.gson.JsonObject;

/**
 * 发放结果，回传给皮肤站的 JSON（MC 端 LPUSH 进 result 队列）。
 *
 * <p>⚠️ 字段名必须与皮肤站 {@code bs_exchange_drain_results()} 一致：
 * <ul>
 *   <li>{@code order_no} —— 必填，缺了皮肤站直接 continue 丢弃</li>
 *   <li>{@code success} —— 真值表示成功，否则皮肤站把订单判 failed 并退款</li>
 *   <li>{@code reason} —— 失败原因，会展示给玩家看，别写堆栈</li>
 * </ul>
 */
public final class ExchangeResult {

    public final String orderNo;
    public final boolean success;
    public final String reason;
    public final String playerName;
    public final int units;
    /** 玩家当前是否在线（离线时 CMI 仍可发放，取决于 CMI 配置） */
    public final boolean playerOnline;
    /** 发放耗时（毫秒），用于排查卡顿 */
    public final long elapsedMs;

    private ExchangeResult(String orderNo, boolean success, String reason,
                           String playerName, int units, boolean playerOnline, long elapsedMs) {
        this.orderNo = orderNo;
        this.success = success;
        this.reason = reason;
        this.playerName = playerName;
        this.units = units;
        this.playerOnline = playerOnline;
        this.elapsedMs = elapsedMs;
    }

    public static ExchangeResult ok(ExchangeJob job, boolean online, long elapsedMs) {
        return new ExchangeResult(job.orderNo, true, "", job.playerName, job.units, online, elapsedMs);
    }

    public static ExchangeResult fail(ExchangeJob job, String reason, boolean online, long elapsedMs) {
        return new ExchangeResult(job.orderNo, false, reason, job.playerName,
                job == null ? 0 : job.units, online, elapsedMs);
    }

    /**
     * 订单号都无法解析时的兜底回传。
     *
     * <p>⚠️ 注意：这种情况**不会**被皮肤站采纳（它只认 order_no），
     * 但仍然要写进日志 —— 否则玩家点了兑换、页面一直显示「发放中」，
     * 而服务端日志里什么都没有，排查时完全瞎。
     */
    public static ExchangeResult malformed(String raw, String reason) {
        return new ExchangeResult(null, false, reason, null, 0, false, 0);
    }

    public String toJson() {
        JsonObject o = new JsonObject();
        if (orderNo != null) o.addProperty("order_no", orderNo);
        o.addProperty("success", success);
        o.addProperty("reason", reason == null ? "" : reason);
        if (playerName != null) o.addProperty("player_name", playerName);
        if (units > 0) o.addProperty("units", units);
        o.addProperty("player_online", playerOnline);
        if (elapsedMs > 0) o.addProperty("elapsed_ms", elapsedMs);
        if (orderNo == null) {
            // 订单号都拿不到，只能把原文带回去给运维看
            o.addProperty("raw", truncate(reason, 200));
        }
        return o.toString();
    }

    private static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "...";
    }

    @Override
    public String toString() {
        return (success ? "OK   " : "FAIL ") + orderNo + " player=" + playerName
                + " units=" + units + " (" + elapsedMs + "ms)"
                + (success ? "" : " reason=" + reason);
    }
}
