package io.github.kokuustudio.exchange;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 资产指令执行器：消费中间件下发的「给某人加/减 N 金币或点券」指令。
 *
 * <p>与 {@link ExchangeWorker} 的区别：
 * <ul>
 *   <li>ExchangeWorker 走的是**皮肤站原有**的兑换队列（Redis 换金币）；</li>
 *   <li>本类走的是**新队列**，由中间件（管理台后端）写入，来源是管理员在
 *       管理台上的手动操作，或游戏内赚取金币的自动回流。</li>
 * </ul>
 * 两边队列 key 不同，互不干扰。
 *
 * <p>⚠️ 线程模型：与 ExchangeWorker 一致 —— 异步线程轮询 Redis，
 * 但**执行必须切回主线程**（Bukkit 玩家 API 非线程安全）。
 *
 * <p>★ 幂等：每条指令带唯一 event_id，插件本地缓存已处理的。
 * 中间件重发（网络抖动、管理台重复点击）不会重复执行。
 */
public final class AssetWorker {

    private final JavaPlugin plugin;
    private final BridgeConfig cfg;
    private final EconomyHook eco;
    private final PointsHook pts;

    /** event_id -> 处理时刻，用于幂等 */
    private final Map<String, Long> processed = new ConcurrentHashMap<>();

    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicReference<String> lastError = new AtomicReference<>("");
    private final AtomicLong consumed = new AtomicLong(0);
    private final AtomicLong succeeded = new AtomicLong(0);
    private final AtomicLong failed = new AtomicLong(0);
    private final AtomicLong skippedDup = new AtomicLong(0);

    public AssetWorker(JavaPlugin plugin, BridgeConfig cfg, EconomyHook eco, PointsHook pts) {
        this.plugin = plugin;
        this.cfg = cfg;
        this.eco = eco;
        this.pts = pts;
    }

    public boolean isRunning() { return running.get(); }
    public String lastError() { return lastError.get(); }
    public long consumedCount() { return consumed.get(); }
    public long successCount() { return succeeded.get(); }
    public long failedCount() { return failed.get(); }
    public long dupCount() { return skippedDup.get(); }

    /**
     * 处理一条已取出的资产指令（消息由 {@link QueuePoller} 取出后分发过来）。
     *
     * <p>执行必须切回主线程 —— Bukkit 玩家/经济 API 非线程安全，
     * 而本类跑在队列轮询线程上。
     *
     * @return true 表示处理过（无论成败）
     */
    public boolean handle(String raw) {
        consumed.incrementAndGet();
        if (cfg.debug) plugin.getLogger().info("[asset] 取到 " + raw);

        JsonObject job;
        try {
            job = JsonParser.parseString(raw).getAsJsonObject();
        } catch (Throwable t) {
            failed.incrementAndGet();
            plugin.getLogger().warning("[asset] 无法解析的指令，已丢弃：" + abbreviate(raw, 300));
            lastError.set("收到无法解析的资产指令");
            return true;
        }

        final String eventId = str(job, "event_id");
        final String player = str(job, "player");
        final String uuid = str(job, "uuid");
        final String asset = str(job, "asset");
        final int delta = (int) dbl(job, "delta");

        if (eventId.isEmpty() || player.isEmpty() || asset.isEmpty() || delta == 0) {
            failed.incrementAndGet();
            plugin.getLogger().warning("[asset] 指令字段不完整，已丢弃：" + abbreviate(raw, 300));
            lastError.set("资产指令字段不完整");
            return true;
        }

        if (isProcessed(eventId)) {
            skippedDup.incrementAndGet();
            plugin.getLogger().info("[asset] 跳过重复指令 " + eventId + "（已处理过）");
            return true;
        }
        markProcessed(eventId);

        // 切主线程执行：Bukkit API 非线程安全
        // ★ verifyIdentity 也必须在主线程 —— 它要查在线玩家，
        //   那是 Bukkit 状态，异步线程读会得到过期甚至空的结果。
        final String[] reason = new String[1];
        final CountDownLatch latch = new CountDownLatch(1);
        try {
            Bukkit.getScheduler().runTask(plugin, () -> {
                try {
                    // 身份核对：中间件带 uuid 时，必须确认「要改的这个人」
                    // 就是指令里那个 uuid。
                    //
                    // 为什么必须查：玩家名可重名。管理员在管理台看到「Steve」，
                    // 下发时服务器上可能有两个 Steve —— 钱发给谁完全取决于
                    // 经济插件按名字找到的第一个。uuid 唯一，是唯一能验的锚点。
                    //
                    // 为什么只在 uuid 非空时查：老版本中间件不带 uuid，
                    // 那时只能按名字执行（降级），不能因缺字段就全丢指令。
                    if (!uuid.isEmpty()) {
                        reason[0] = verifyIdentity(player, uuid);
                    }
                    if (reason[0] == null) {
                        reason[0] = execute(asset, player, delta);
                    }
                } catch (Throwable t) {
                    reason[0] = "执行时发生异常：" + t.getClass().getSimpleName()
                            + (t.getMessage() == null ? "" : " — " + t.getMessage());
                } finally {
                    latch.countDown();
                }
            });
        } catch (IllegalStateException | IllegalArgumentException e) {
            failed.incrementAndGet();
            plugin.getLogger().warning("[资产] 调度失败（服务器可能在关闭）：" + e.getMessage());
            return true;
        }

        boolean done;
        try {
            done = latch.await(cfg.depositTimeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            done = false;
        }

        if (!done) {
            failed.incrementAndGet();
            plugin.getLogger().warning("[资产] " + eventId + " 执行超时（主线程 "
                    + cfg.depositTimeoutMs + "ms 未响应）");
            return true;
        }

        if (reason[0] == null) {
            succeeded.incrementAndGet();
            plugin.getLogger().info("[资产] " + eventId + " → " + player + " " + asset
                    + " " + (delta > 0 ? "+" : "") + delta
                    + (uuid.isEmpty() ? "（无 uuid，按名字执行）" : ""));
        } else {
            failed.incrementAndGet();
            // 身份核对失败要能一眼看出来：那是「可能有人冒名」，
            // 与「经济插件报错」是完全不同性质的事故。
            if (reason[0].startsWith("玩家「")) {
                plugin.getLogger().warning("[资产] " + eventId + " 已拒绝：" + reason[0]);
            } else {
                plugin.getLogger().warning("[资产] " + eventId + " 失败：" + reason[0]);
            }
        }
        return true;
    }

    /**
     * 核对「玩家名 ↔ UUID」是否指向同一个人。**必须在主线程调用。**
     *
     * @return null 表示通过；否则是拒绝原因
     */
    private String verifyIdentity(String player, String uuid) {
        // 只能核在线玩家：离线玩家 Bukkit 只能按名字构造 OfflinePlayer，
        // 拿不到可靠的 UUID（未上线过的名字返回全 0）。
        // 离线不拦 —— 那是管理台给离线玩家发钱的正常场景。
        Player p = Bukkit.getPlayerExact(player);
        if (p == null || !p.isOnline()) return null;   // 离线，跳过核对

        String actual = p.getUniqueId().toString();
        if (actual.equalsIgnoreCase(uuid)) return null;

        // 名字对不上 uuid：要么中间件记的是旧名，要么有人冒名。
        // 两种情况都不能发钱 —— 宁可让管理员重下一遍。
        return "玩家「" + player + "」在线但 UUID 是 " + actual
                + "，与指令里的 " + uuid + " 不符（可能有人冒名或名字已改）";
    }

    /**
     * 执行一条资产变更。**必须在主线程调用。**
     *
     * @return null 成功；否则失败原因
     */
    private String execute(String asset, String player, int delta) {
        if ("coin".equals(asset)) {
            if (!eco.available()) return "经济插件不可用：" + eco.lastError();
            return delta >= 0
                    ? eco.deposit(player, Math.abs(delta))
                    : eco.withdraw(player, Math.abs(delta));
        }
        if ("points".equals(asset)) {
            if (!pts.available()) return "PlayerPoints 不可用：" + pts.lastError();
            return delta >= 0
                    ? pts.give(player, Math.abs(delta))
                    : pts.take(player, Math.abs(delta));
        }
        return "未知资产类型：" + asset;
    }

    private boolean isProcessed(String id) {
        Long t = processed.get(id);
        return t != null && (System.currentTimeMillis() - t) < cfg.processedTtlMs;
    }

    private void markProcessed(String id) {
        processed.put(id, System.currentTimeMillis());
        long cutoff = System.currentTimeMillis() - cfg.processedTtlMs;
        processed.entrySet().removeIf(e -> e.getValue() < cutoff);
    }

    private static String str(JsonObject o, String k) {
        try {
            return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString().trim() : "";
        } catch (Throwable t) {
            return "";
        }
    }

    private static double dbl(JsonObject o, String k) {
        try {
            return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsDouble() : 0;
        } catch (Throwable t) {
            return 0;
        }
    }

    private static String abbreviate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }
}
