package io.github.kokuustudio.exchange;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;
import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.exceptions.JedisException;
import redis.clients.jedis.util.KeyValue;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 队列消费核心：BRPOP 取订单 → 主线程调经济插件发放 → LPUSH 回传结果。
 *
 * <p>线程模型（重要，改动前先看）：
 * <ul>
 *   <li><b>本类不是主线程</b>：由 {@link QueuePoller} 的独立线程驱动。</li>
 *   <li>Redis 读写在异步线程做 —— Jedis 不支持多线程共用一个连接，
 *       所以每个线程用 try-with-resources 单独开连接。</li>
 *   <li><b>发放必须切回主线程</b>：Bukkit 玩家 API 不是线程安全的。
 *       做法是 {@code Bukkit.getScheduler().runTask(...)} 并等待
 *       {@link CountDownLatch}，带超时。</li>
 * </ul>
 *
 * <p>★ 幂等：Redis 的 BRPOP 是「取走即消失」，天然不会两实例抢到同一条。
 * 但**重连时会丢消息**（已 RPOP 未回传时进程挂掉）。
 * 所以本地留一份「已处理 order_no」缓存，重连后重放时跳过 ——
 * 代价是若上次是「发放成功但回传失败」，重放时会被跳过，
 * 订单卡在 pending 直到 order_ttl 超期退款。这是有意的取舍：
 * <b>宁可让玩家损失一笔积分，也不能双发货币。</b>
 */
public final class ExchangeWorker {

    private final JavaPlugin plugin;
    private final BridgeConfig cfg;
    private final EconomyHook eco;

    /** order_no -> 处理时刻，用于幂等（同一单不重复发） */
    private final Map<String, Long> processed = new ConcurrentHashMap<>();
    private final Deque<String> processedOrder = new ArrayDeque<>();

    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicReference<String> lastError = new AtomicReference<>("");
    private final AtomicLong consumed = new AtomicLong(0);
    private final AtomicLong succeeded = new AtomicLong(0);
    private final AtomicLong failed = new AtomicLong(0);
    private final AtomicLong skippedDup = new AtomicLong(0);
    private final AtomicLong malformed = new AtomicLong(0);

    public ExchangeWorker(JavaPlugin plugin, BridgeConfig cfg, EconomyHook eco) {
        this.plugin = plugin;
        this.cfg = cfg;
        this.eco = eco;
    }

    public boolean isRunning() { return running.get(); }
    public String lastError() { return lastError.get(); }
    public long consumedCount() { return consumed.get(); }
    public long successCount() { return succeeded.get(); }
    public long failedCount() { return failed.get(); }
    public long dupCount() { return skippedDup.get(); }
    public long malformedCount() { return malformed.get(); }

    /**
     * 取一条任务并处理（由 QueuePoller 循环调用）。
     *
     * @return true 表示取到过消息（无论成功失败）；false 表示队列空
     */
    public boolean pollOnce(JedisPool pool) {
        String raw;
        try (Jedis jedis = pool.getResource()) {
            /* ⚠️⚠️ brpop 有**两个**长得几乎一样的重载，选错编译器不报错、
             * 但返回类型完全不对（实测踩过两次）：
             *
             *   brpop(int seconds, String key)     → List<String>
             *   brpop(double seconds, String key)   → KeyValue<String,String>   ← 要的是这个
             *
             * 传 int 字面量时，Java 会精确匹配到 int 版本，于是
             * 「List<String> 无法转换为 KeyValue」编译失败。
             *
             * 为什么必须用 brpop（double）而不是 rpop：
             *   - brpop 带超时，队列空时最多阻塞 N 秒就返回，
             *     线程能周期性醒来做重连检查与计数刷新；
             *   - rpop 是非阻塞的，队列空时返回 null，
             *     外面还得自己 sleep，白白多一次往返。
             *
             * 另一个好处：brpop 在 Redis 断线时抛 JedisException，
             * 而 rpop 会被当成「队列空」静默吞掉 —— 那会让断线看起来一切正常。
             */
            KeyValue<String, String> kv = jedis.brpop((double) cfg.blockTimeoutSec, cfg.queueKey);
            raw = (kv == null) ? null : kv.getValue();
        } catch (JedisException e) {
            lastError.set("读取队列失败：" + e.getMessage());
            return false;
        }

        if (raw == null) return false;   // 队列空
        consumed.incrementAndGet();
        if (cfg.debug) plugin.getLogger().info("[queue] 取到 " + raw);

        ExchangeJob job = ExchangeJob.parse(raw);
        if (job == null) {
            // 坏消息：计数 + 日志。**不回传** —— 回传没有 order_no，
            // 皮肤站会直接丢弃，回传只是污染结果队列。
            // 但必须打日志，否则玩家点了兑换页面一直「发放中」而日志空白。
            malformed.incrementAndGet();
            plugin.getLogger().warning("[queue] 收到无法解析的消息，已丢弃："
                    + abbreviate(raw, 300));
            lastError.set("收到无法解析的队列消息");
            return true;
        }

        if (isProcessed(job.orderNo)) {
            skippedDup.incrementAndGet();
            plugin.getLogger().info("[queue] 跳过重复订单 " + job.orderNo
                    + "（上次处理过，避免双发）");
            // ⚠️ 重复单不回传：皮肤站那边如果已经标记过状态，
            //    再回传一次会被幂等索引拦住；但若上次是「回传失败」，
            //    这里补一次回传反而能让订单正常收尾。
            //    → 稳妥做法：仍然回传，由皮肤站的 UNIQUE(order_no,action) 兜底。
            safePushResult(pool, ExchangeResult.ok(job, isOnline(job.playerName), 0));
            return true;
        }

        markProcessed(job.orderNo);
        ExchangeResult result = processJob(job);
        safePushResult(pool, result);
        return true;
    }

    /** 真正执行发放：切主线程 → 调经济后端 → 收集结果 */
    private ExchangeResult processJob(ExchangeJob job) {
        long t0 = System.currentTimeMillis();
        boolean online = isOnline(job.playerName);

        if (!eco.available()) {
            failed.incrementAndGet();
            // ⚠️ 经济插件不可用时**必须回传失败**，不能静默丢弃。
            //    静默丢弃 = 玩家积分已扣、订单卡 pending、24 小时后超期退款，
            //    玩家体验极差（钱扣了要等一天才回来）。立刻失败退款最干脆。
            return ExchangeResult.fail(job,
                    "服务器未启用经济插件，无法发放。请稍后重试或联系管理员。", online,
                    System.currentTimeMillis() - t0);
        }

        final String[] reason = new String[1];
        // CountDownLatch 而不是 AtomicBoolean：
        //   布尔量有两个真实缺陷 ——
        //   1) 主线程还没跑到时，上一单遗留的 true 会让本单**立即误判成功**
        //   2) 超时后主线程仍会执行完并 countDown，latch 状态污染下一单
        //   latch 每次新建，天然隔离。
        final CountDownLatch latch = new CountDownLatch(1);

        // 切主线程执行经济调用（Bukkit 玩家 API 不是线程安全的）
        try {
            Bukkit.getScheduler().runTask(plugin, () -> {
                try {
                    reason[0] = eco.deposit(job.playerName, job.units);
                } catch (Throwable t) {
                    reason[0] = "发放时发生异常：" + t.getClass().getSimpleName()
                            + (t.getMessage() == null ? "" : " — " + t.getMessage());
                } finally {
                    latch.countDown();
                }
            });
        } catch (IllegalStateException | IllegalArgumentException e) {
            // 插件正在关闭 / 调度器不可用
            return ExchangeResult.fail(job, "服务器正在关闭，暂时无法发放",
                    online, System.currentTimeMillis() - t0);
        }

        // 等主线程执行完，带超时 —— 主线程卡住时不能无限等
        boolean done;
        try {
            done = latch.await(cfg.depositTimeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            done = false;
        }
        long elapsed = System.currentTimeMillis() - t0;

        if (!done) {
            failed.incrementAndGet();
            plugin.getLogger().warning("[兑换] " + job.orderNo
                    + " 发放超时（主线程 " + cfg.depositTimeoutMs + "ms 未响应）");
            return ExchangeResult.fail(job,
                    "发放超时（服务器繁忙），积分已退回，请稍后重试。", online, elapsed);
        }

        if (reason[0] == null) {
            succeeded.incrementAndGet();
            plugin.getLogger().info("[兑换] " + job.orderNo + " → " + job.playerName
                    + " +" + job.units + "（" + elapsed + "ms，在线=" + online + "）");
            return ExchangeResult.ok(job, online, elapsed);
        }

        failed.incrementAndGet();
        plugin.getLogger().warning("[兑换] " + job.orderNo + " 失败：" + reason[0]);
        return ExchangeResult.fail(job, reason[0], online, elapsed);
    }

    /** 回传结果；失败只记日志，不抛出 —— 不能因为回传失败丢掉后续处理 */
    private void safePushResult(JedisPool pool, ExchangeResult result) {
        try (Jedis jedis = pool.getResource()) {
            jedis.lpush(cfg.resultKey, result.toJson());
            lastError.set("");
        } catch (JedisException e) {
            lastError.set("回传结果失败：" + e.getMessage());
            plugin.getLogger().severe("[兑换] 结果回传失败，皮肤站侧订单会停在「发放中」："
                    + result + " —— " + e.getMessage());
        }
    }

    private boolean isOnline(String name) {
        Player p = Bukkit.getPlayerExact(name);
        return p != null && p.isOnline();
    }

    private boolean isProcessed(String orderNo) {
        Long t = processed.get(orderNo);
        return t != null && (System.currentTimeMillis() - t) < cfg.processedTtlMs;
    }

    private void markProcessed(String orderNo) {
        processed.put(orderNo, System.currentTimeMillis());
        synchronized (processedOrder) {
            processedOrder.addLast(orderNo);
        }
        purgeOld();
    }

    /** 清理过期的幂等记录，防止内存无限增长（服务器跑几个月会积累几十万个 key） */
    private void purgeOld() {
        long cutoff = System.currentTimeMillis() - cfg.processedTtlMs;
        while (true) {
            String head;
            synchronized (processedOrder) {
                head = processedOrder.peekFirst();
            }
            if (head == null) return;
            Long t = processed.get(head);
            if (t == null || t < cutoff) {
                synchronized (processedOrder) {
                    if (processedOrder.peekFirst() != null
                            && processedOrder.peekFirst().equals(head)) {
                        processedOrder.pollFirst();
                    }
                }
                processed.remove(head);
            } else {
                return;   // 队列头都还没过期，后面的更不会过期
            }
        }
    }

    private static String abbreviate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }
}
