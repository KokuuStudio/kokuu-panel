package io.github.kokuustudio.exchange;

import org.bukkit.configuration.file.FileConfiguration;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * 插件配置。
 *
 * <p>⚠️ 队列键名必须与皮肤站管理页保存的配置一致（默认值相同）：
 * <pre>
 *   queue_key   = bs:exchange:queue    皮肤站 LPUSH，MC 端 BRPOP
 *   result_key  = bs:exchange:result   MC 端 LPUSH，皮肤站 RPOP
 * </pre>
 * 改了一边就必须改另一边，否则订单会「凭空消失」（写进 A 队列、MC 从 B 队列取）。
 */
public final class BridgeConfig {

    public String redisHost = "127.0.0.1";
    public int redisPort = 6379;
    public String redisPassword = "";
    public int redisDatabase = 0;
    public int redisTimeoutMs = 3000;

    public String queueKey = "bs:exchange:queue";
    public String resultKey = "bs:exchange:result";

    /**
     * 静态单例路径的候选全限定名，按顺序尝试。
     * <p>★ 首选路径其实是 <b>Vault API</b>（见 {@link EconomyHook}），
     * 这份列表只是回退 —— 覆盖 CMI 新旧包名。接别的经济插件时加一行即可。
     */
    public List<String> economyClassNames = new ArrayList<>(Arrays.asList(
            "com.Zrips.Economy_CMI",
            "net.Zrips.ECO.CMI.CMI_Economy",
            "net.Zrips.CMI.CMI_Economy"));

    /** 消费间隔（毫秒）。太小会空转烧 CPU，太大会让玩家等。 */
    public long pollIntervalMs = 1000L;
    /**
     * BRPOP 的阻塞超时（**秒**，Redis 只认整数秒）。
     *
     * <p>取一条订单时的阻塞时长：队列空时最多阻塞这么久就返回，
     * 让线程能周期性醒来做重连检查与计数刷新。
     *
     * <p>必须 &lt;= pollIntervalMs 的秒数向上取整，否则 brpop 会比轮询间隔还久，
     * 关闭插件时 stop() 的 join(3000) 会等不到线程退出。
     */
    public int blockTimeoutSec = 2;
    /** 单次唤醒最多处理几条，避免积压时一次卡住主线程太久 */
    public int batchSize = 8;
    /** 发放操作的超时（毫秒）—— 超时按失败回传，让皮肤站退款 */
    public long depositTimeoutMs = 5000L;
    /** Redis 断开后重连等待（毫秒） */
    public long reconnectDelayMs = 5000L;
    /**
     * 「处理中订单」的本地留存时间（毫秒）。
     * 用于幂等：同一 order_no 重复投递时不重复发钱。
     */
    public long processedTtlMs = 86400000L; // 24h
    /** 调试模式：把每条消息的原始内容打到控制台 */
    public boolean debug = false;

    public static BridgeConfig load(FileConfiguration c) {
        BridgeConfig cfg = new BridgeConfig();
        cfg.redisHost = c.getString("redis.host", cfg.redisHost);
        cfg.redisPort = c.getInt("redis.port", cfg.redisPort);
        cfg.redisPassword = c.getString("redis.password", cfg.redisPassword);
        cfg.redisDatabase = c.getInt("redis.database", cfg.redisDatabase);
        cfg.redisTimeoutMs = c.getInt("redis.timeout", cfg.redisTimeoutMs);

        cfg.queueKey = c.getString("queue.key", cfg.queueKey);
        cfg.resultKey = c.getString("queue.result-key", cfg.resultKey);

        // 读成列表：用户在 config.yml 里写 economy.class-names: [ 'a.B', 'c.D' ]
        if (c.isList("economy.class-names")) {
            List<String> names = c.getStringList("economy.class-names");
            List<String> clean = new ArrayList<>();
            for (String n : names) {
                if (n != null && !n.trim().isEmpty()) {
                    clean.add(n.trim());
                }
            }
            // 全部为空时保留默认值 —— 全空等于没配，不该让插件直接瘫掉
            if (!clean.isEmpty()) {
                cfg.economyClassNames = clean;
            }
        }

        cfg.pollIntervalMs = c.getLong("worker.poll-interval", cfg.pollIntervalMs);
        cfg.blockTimeoutSec = c.getInt("worker.block-timeout", cfg.blockTimeoutSec);
        cfg.batchSize = c.getInt("worker.batch-size", cfg.batchSize);
        cfg.depositTimeoutMs = c.getLong("worker.deposit-timeout", cfg.depositTimeoutMs);
        cfg.reconnectDelayMs = c.getLong("worker.reconnect-delay", cfg.reconnectDelayMs);
        cfg.processedTtlMs = c.getLong("worker.processed-ttl", cfg.processedTtlMs);
        cfg.debug = c.getBoolean("debug", cfg.debug);
        return cfg;
    }

    public List<String> problems() {
        List<String> out = new ArrayList<>();
        if (redisHost == null || redisHost.trim().isEmpty()) out.add("redis.host 为空");
        if (redisPort <= 0 || redisPort > 65535) out.add("redis.port 非法：" + redisPort);
        if (queueKey.equals(resultKey)) {
            // 两个键相同会互相吃掉：MC 端从队列取出的消息，
            // 回传时又 LPUSH 进同一个键，下一轮立刻被自己取回来 —— 死循环。
            out.add("queue.key 与 queue.result-key 相同，会造成消息自我循环");
        }
        if (economyClassNames.isEmpty()) {
            out.add("economy.class-names 为空 —— 不知道该连哪个经济插件，无法发放");
        }
        for (String n : economyClassNames) {
            if (n.indexOf('.') <= 0 || n.endsWith(".") || n.startsWith(".")) {
                out.add("economy.class-names 里有不像是全限定类名的条目：" + n);
            }
        }
        if (pollIntervalMs < 100) out.add("worker.poll-interval 太小（<100ms），会空转烧 CPU");
        if (blockTimeoutSec < 1) out.add("worker.block-timeout 必须 >=1（秒）");
        if (batchSize < 1) out.add("worker.batch-size 必须 >=1");
        if (batchSize > 64) out.add("worker.batch-size 过大（>64），单次处理会卡主线程太久");
        return out;
    }
}
