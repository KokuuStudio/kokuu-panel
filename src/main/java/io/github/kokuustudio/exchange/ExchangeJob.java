package io.github.kokuustudio.exchange;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;

/**
 * 一条待发放的兑换订单（皮肤站 LPUSH 进队列的 JSON）。
 *
 * <p>⚠️ 字段名必须与皮肤站 {@code bs_exchange_push_job()} 完全一致 ——
 * 两边独立演进，任何一侧改字段名都会导致订单「取到了但字段全 null」。
 * 皮肤站侧字段：order_no / uid / player_name / units / created_at
 */
public final class ExchangeJob {

    public final String orderNo;
    public final int uid;
    public final String playerName;
    public final int units;
    public final String createdAt;

    private ExchangeJob(String orderNo, int uid, String playerName, int units, String createdAt) {
        this.orderNo = orderNo;
        this.uid = uid;
        this.playerName = playerName;
        this.units = units;
        this.createdAt = createdAt;
    }

    /**
     * 解析队列消息。
     *
     * @return 解析成功返回对象；失败返回 null（调用方负责回传失败原因）
     */
    public static ExchangeJob parse(String raw) {
        if (raw == null || raw.trim().isEmpty()) return null;
        try {
            JsonObject o = JsonParser.parseString(raw).getAsJsonObject();

            // ⚠️ 逐个字段做「存在 + 类型」校验，不要直接 asXxx：
            // GSON 的 getAsString() 在字段缺失时**不抛异常而是返回 null**，
            // getAsInt() 同理返回 0 —— 于是「字段名拼错」会静默变成
            // 「玩家名 null、数量 0」，等到给玩家发 0 个货币才炸。
            // 这里显式检查，坏消息立刻识别出来回传失败。
            String orderNo = str(o, "order_no");
            String playerName = str(o, "player_name");

            if (isBlank(orderNo)) return null;
            if (isBlank(playerName)) return null;
            if (!o.has("units")) return null;

            int units;
            try {
                units = o.get("units").getAsInt();
            } catch (Exception e) {
                return null;
            }
            // 数量必须是正数：0 或负数一定是数据有问题，绝不能「照单发下去」
            if (units <= 0) return null;

            int uid = 0;
            if (o.has("uid")) {
                try { uid = o.get("uid").getAsInt(); } catch (Exception ignored) { }
            }

            return new ExchangeJob(orderNo.trim(), uid, playerName.trim(), units, str(o, "created_at"));
        } catch (JsonSyntaxException | IllegalStateException e) {
            return null;
        }
    }

    private static String str(JsonObject o, String key) {
        if (!o.has(key) || o.get(key).isJsonNull()) return null;
        try {
            return o.get(key).getAsString();
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    @Override
    public String toString() {
        return "ExchangeJob{" + orderNo + " uid=" + uid + " player=" + playerName
                + " units=" + units + " at=" + createdAt + "}";
    }
}
