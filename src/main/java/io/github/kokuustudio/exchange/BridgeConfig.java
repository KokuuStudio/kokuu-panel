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
     * 资产指令队列（中间件 → 插件）。
     *
     * <p>与上面两个兑换队列**必须分开**：那对队列的消息格式是订单 JSON，
     * 这里的消息格式是 {event_id, player, uuid, asset, delta, note}。
     * 共用一个键会导致解析错乱、且坏消息会互相污染。
     *
     * <p>uuid 可能为空（老版本中间件不带），此时插件退化为按名字执行；
     * 非空时会做在线身份核对，防止重名时发错人。
     */
    public String assetQueueKey = "bs:asset:cmd";

    /**
     * 事件队列（插件 → 中间件）。
     *
     * <p>消息格式与上面两个队列都不同，这里是
     * {@code {event_id, player, uuid, asset, delta, credit, balance_after, ts}}。
     * 当前唯一的生产者是 {@link EarningsWatcher}（金币回流）。
     */
    public String eventQueueKey = "bs:asset:event";

    /**
     * 金币自动回流的「金币 : 积分」比例。
     *
     * <p>★ 为什么比例在插件侧而不是中间件侧：扣币必须在插件这里发生
     * （只有插件能操作经济插件），所以「扣多少币换多少积分」这个算式
     * 必须在同一处完成。两边各算一半、比例一旦漂移就等于凭空造币或吞钱。
     *
     * <p>中间件侧保留独立的限额开关作安全阀，但不再重算比例。
     */
    public int reflowRatio = 1000;

    /** 回流总开关。默认关 —— 开箱即用就自动扣玩家金币是危险行为。 */
    public boolean reflowEnabled = false;
    /** 扫描间隔（秒）。最小 1。 */
    public int reflowIntervalSec = 30;
    /** 单次增量低于这个值不抽 —— 滤掉零花钱式的小额进账。 */
    public long reflowMinDelta = 1000L;
    /** 单次增量上限。超过按此值截断，防止管理员一次大额下发被误判成「赚到的」。 */
    public long reflowMaxDelta = 10000000L;

    /**
     * 静态单例路径的候选全限定名，按顺序尝试。
     * <p>★ 首选路径其实是 <b>Vault API</b>（见 {@link EconomyHook}），
     * 这份列表只是回退 —— 覆盖 CMI 新旧包名（历史兼容）。
     * 走 Vault 的经济后端无需配置，接其它非 Vault 后端时加一行即可。
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
        cfg.assetQueueKey = c.getString("queue.asset-key", cfg.assetQueueKey);
        cfg.eventQueueKey = c.getString("queue.event-key", cfg.eventQueueKey);

        cfg.reflowEnabled = c.getBoolean("reflow.enabled", cfg.reflowEnabled);
        cfg.reflowRatio = c.getInt("reflow.ratio", cfg.reflowRatio);
        cfg.reflowIntervalSec = c.getInt("reflow.interval-seconds", cfg.reflowIntervalSec);
        cfg.reflowMinDelta = c.getLong("reflow.min-delta", cfg.reflowMinDelta);
        cfg.reflowMaxDelta = c.getLong("reflow.max-delta", cfg.reflowMaxDelta);

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
        if (assetQueueKey.equals(queueKey) || assetQueueKey.equals(resultKey)) {
            // 消息格式不同，共用键会导致坏消息互相污染
            out.add("queue.asset-key 必须与另外两个队列键不同（消息格式不同，不能共用）");
        }
        if (eventQueueKey.equals(queueKey) || eventQueueKey.equals(resultKey)
                || eventQueueKey.equals(assetQueueKey)) {
            out.add("queue.event-key 必须与另外三个队列键不同（消息格式不同，不能共用）");
        }
        if (reflowEnabled) {
            if (reflowRatio <= 0) out.add("reflow.ratio 必须 >=1");
            if (reflowIntervalSec < 1) out.add("reflow.interval-seconds 必须 >=1（秒）");
            if (reflowMinDelta < 1) out.add("reflow.min-delta 必须 >=1（金币）");
            if (reflowMaxDelta < reflowMinDelta) {
                out.add("reflow.max-delta 必须 >= reflow.min-delta（上限低于下限会让每次扫描都被截断）");
            }
            if (reflowMinDelta < reflowRatio) {
                // 不是错误，但按公式 credit = floor(delta / ratio)，低于 ratio 永远抽不出积分
                out.add("提示：reflow.min-delta（" + reflowMinDelta + "）小于 reflow.ratio（"
                        + reflowRatio + "），低于该值的增量永远换不出积分，建议调大");
            }
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
