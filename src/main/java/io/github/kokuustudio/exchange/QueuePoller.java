package io.github.kokuustudio.exchange;

import org.bukkit.Bukkit;
import org.bukkit.plugin.java.JavaPlugin;
import redis.clients.jedis.DefaultJedisClientConfig;
import redis.clients.jedis.HostAndPort;
import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;
import redis.clients.jedis.exceptions.JedisException;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 轮询线程：建连接池 → 循环取任务 → 断线自动重连。
 *
 * <p>★ 为什么自己写轮询而不用 Bukkit 的 sync/async task：
 * <ul>
 *   <li>Redis 阻塞读取（RPOP 带超时）会占住线程，用自管线程更可控；</li>
 *   <li>需要在连接断开时重建连接池，Bukkit 调度器不好做这个；</li>
 *   <li>插件 disable 时能干净地中断线程 —— 调度器里的任务无法真正取消。</li>
 * </ul>
 */
public final class QueuePoller {

    private final JavaPlugin plugin;
    private final BridgeConfig cfg;
    private final ExchangeWorker worker;

    private final AtomicBoolean stop = new AtomicBoolean(false);
    private Thread thread;
    private volatile JedisPool pool;

    public QueuePoller(JavaPlugin plugin, BridgeConfig cfg, ExchangeWorker worker) {
        this.plugin = plugin;
        this.cfg = cfg;
        this.worker = worker;
    }

    public JedisPool pool() { return pool; }

    public void start() {
        if (thread != null) return;
        stop.set(false);
        thread = new Thread(this::loop, "ExchangeBridge-Queue");
        thread.setDaemon(true);   // 服务器关停时不该卡住 JVM
        thread.start();
        plugin.getLogger().info("队列轮询线程已启动（每 " + cfg.pollIntervalMs + "ms 一次）");
    }

    public void stop() {
        stop.set(true);
        Thread t = thread;
        if (t != null) {
            t.interrupt();
            try {
                t.join(3000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        thread = null;
        closePool();
        plugin.getLogger().info("队列轮询线程已停止");
    }

    private void closePool() {
        JedisPool p = pool;
        pool = null;
        if (p != null) {
            try { p.close(); } catch (Exception ignored) { }
        }
    }

    private void loop() {
        while (!stop.get()) {
            try {
                if (pool == null) {
                    pool = buildPool();
                    // 连上之后先做一次 ping —— Redis 配了 requirepass 时
                    // 密码错的话 AUTH 会在第一条命令时才报错，
                    // 这里提前探一次，好给出明确的错误信息。
                    try (Jedis j = pool.getResource()) {
                        j.ping();
                    }
                    plugin.getLogger().info("已连接 Redis " + cfg.redisHost + ":" + cfg.redisPort
                            + " db" + cfg.redisDatabase);
                }

                int handled = 0;
                while (handled < cfg.batchSize && !stop.get()) {
                    boolean got = worker.pollOnce(pool);
                    if (!got) break;
                    handled++;
                }

                if (handled == 0) sleep(cfg.pollIntervalMs);

            } catch (JedisException e) {
                plugin.getLogger().warning("Redis 连接异常，" + cfg.reconnectDelayMs
                        + "ms 后重连：" + e.getMessage());
                closePool();
                if (!sleepQuietly(cfg.reconnectDelayMs)) return;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;                       // stop() 触发的正常退出
            } catch (Throwable t) {
                // 兜底：worker 里任何未预料的异常都不能让线程静默死掉
                plugin.getLogger().severe("队列线程异常（已忽略并继续）：" + t);
                if (!sleepQuietly(cfg.reconnectDelayMs)) return;
            }
        }
        closePool();
    }

    /**
     * 建连接池。
     *
     * <p>⚠️ Jedis 5.x 的 API 与 4.x 差别很大，这里是**实测踩出来的**正确写法：
     * <ol>
     *   <li>没有 {@code (config, host, port, timeout, password, database)} 这样的六参构造器。
     *       5.1.0 的 {@code JedisPool} 只有 {@code int} 版本的 timeout，
     *       要同时指定 password + database 必须走
     *       {@link redis.clients.jedis.DefaultJedisClientConfig.Builder} + {@link redis.clients.jedis.HostAndPort}。</li>
     *   <li>用 {@code javap -cp jedis.jar redis.clients.jedis.JedisPool} 看真实签名，
     *       不要照抄 4.x 的示例代码或凭记忆写 —— 我照抄了一次，直接编译失败。</li>
     * </ol>
     */
    private JedisPool buildPool() {
        JedisPoolConfig pc = new JedisPoolConfig();
        pc.setMaxTotal(4);
        pc.setMaxIdle(2);
        pc.setMinIdle(1);
        pc.setTestOnBorrow(true);
        pc.setBlockWhenExhausted(true);
        // 连接池借出连接的最长等待。
        // ⚠️ Jedis 5.x 这里要 java.time.Duration，传 TimeUnit 编译不过。
        pc.setMaxWait(Duration.ofMillis(2000));

        DefaultJedisClientConfig.Builder b = DefaultJedisClientConfig.builder()
                .connectionTimeoutMillis(cfg.redisTimeoutMs)
                .socketTimeoutMillis(cfg.redisTimeoutMs)
                .database(cfg.redisDatabase)
                .clientName("ExchangeBridge");

        String pwd = cfg.redisPassword == null ? "" : cfg.redisPassword;
        if (!pwd.isEmpty()) {
            b.password(pwd);
        }

        HostAndPort addr = new HostAndPort(cfg.redisHost, cfg.redisPort);
        return new JedisPool(pc, addr, b.build());
    }

    private void sleep(long ms) throws InterruptedException {
        Thread.sleep(Math.max(20, ms));
    }

    /**
     * 在 catch 块里用的休眠。
     *
     * <p>⚠️ 为什么需要它：catch 块里调 {@code sleep()}（声明 throws InterruptedException）
     * 会在 catch 内部再抛一次检查异常，而那个 catch 块自己**没有** throws 声明 ——
     * Java 禁止在 catch 块里抛出一个没被外层处理的新受检异常，编译直接失败。
     * sleepQuietly 把它吞掉并用返回值表达「是否被中断」。
     *
     * @return false 表示被中断了（该退出线程），true 表示睡满了
     */
    private boolean sleepQuietly(long ms) {
        try {
            sleep(ms);
            return true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }
}
