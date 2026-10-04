package io.github.kokuustudio.exchange;

import com.google.gson.JsonObject;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;
import redis.clients.jedis.Jedis;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 金币自动回流：定时比对在线玩家余额，把「正向增量」按比例抽成积分上报。
 *
 * <h3>★ 为什么是「轮询余额快照」而不是监听经济事件</h3>
 * <pre>
 *   Vault 生态**没有**统一的「玩家赚钱」事件。
 *   EssentialsX 有自己的事件、CMI 有自己的、PlayerPoints 又是一套 —— 三家 API 全不一样，
 *   而本插件要兼容 1.12.2 ~ 最新、且不硬依赖任何一个后端。
 *   → 用「只有所有后端都保证的东西」：{@code getBalance(OfflinePlayer)}。
 * </pre>
 * 余额快照法对后端无要求，代价是精度取决于扫描间隔（期间玩家花掉的钱会被算进净值，
 * 但那只会让本次抽成**偏少**，不会偏多 —— 方向是安全的）。
 *
 * <h3>★ 为什么「先扣币，再上报」</h3>
 * 这是本类最重要的设计决定。若反过来（先加积分，再让中间件扣币）：
 * <ul>
 *   <li>Redis 队列没有回执，中间件**无法知道扣币成功没有**，加分就成了无本之木；</li>
 *   <li>更糟的是回滚：加分成功、扣币失败，玩家凭空多一笔积分 —— 双产出，
 *       而积分能换成金币，等于直接造币。</li>
 * </ul>
 * 现在这个顺序：金币在插件侧**已经真实扣掉**（EconomyHook 有返回值能判成败），
 * 上报的一定是「确实扣掉的数额」。中间件加分失败的最坏后果是玩家亏了币，
 * 这与 convertCoin 的失败模式一致 —— 已知、可追溯、可人工补，不会造币。
 *
 * <h3>★ 抽成公式</h3>
 * <pre>
 *   credit = floor(delta / ratio)
 *   taken  = credit * ratio          // 抽走的金币
 *   余下 delta - taken 的零头留给玩家
 * </pre>
 * 效果就是「玩家每赚一笔金币，零头自动换成积分」。数学上等价于
 * 「每次兑换都把零头抹掉」，只是省掉了玩家手动敲命令。
 *
 * <h3>★ 为什么比例写在插件配置里，而不是让中间件算</h3>
 * 扣币必须在插件侧发生（只有这里能操作经济插件），所以比例的计算也必须在插件侧 ——
 * 否则中间件算出 credit=5、插件按另一个比例扣了 3000 金币，
 * 两边比例一旦漂移就等于凭空造币或吞钱。
 * <br>中间件侧仍保留独立的限额开关作为**安全阀**（reflow_enabled / daily_limit），
 * 但**不再重算比例**，以本类上报的 credit 为准。
 *
 * <h3>线程模型</h3>
 * 全流程在主线程的一次 {@code runTaskTimer} 里完成 —— 经济插件的读与写
 * 都不是线程安全的，切线程反而更容易出诡异问题。间隔默认 30 秒，
 * 在线玩家通常几十个，一次内存读 + 一次 withdraw 在主线程上耗时可忽略。
 */
public final class EarningsWatcher implements Listener {

    private final JavaPlugin plugin;
    private final BridgeConfig cfg;
    private final EconomyHook eco;
    private final QueuePoller poller;

    /** uuid（小写）→ 上次扫描到的余额。只保留在线玩家。 */
    private final Map<String, Double> lastBalance = new HashMap<>();
    /** uuid → 玩家名，供 withdraw 用（EconomyHook 按名字解析 OfflinePlayer）。 */
    private final Map<String, String> lastName = new HashMap<>();

    private BukkitTask task;

    private final AtomicLong scanned = new AtomicLong(0);
    private final AtomicLong reported = new AtomicLong(0);
    private final AtomicLong skipped = new AtomicLong(0);
    private final AtomicLong failed = new AtomicLong(0);

    public EarningsWatcher(JavaPlugin plugin, BridgeConfig cfg, EconomyHook eco, QueuePoller poller) {
        this.plugin = plugin;
        this.cfg = cfg;
        this.eco = eco;
        this.poller = poller;
    }

    // ─────────────────────────── 生命周期 ───────────────────────────

    public void start() {
        if (task != null) return;
        long ticks = Math.max(20L, cfg.reflowIntervalSec * 20L);
        task = Bukkit.getScheduler().runTaskTimer(plugin, this::scan, ticks, ticks);
        plugin.getLogger().info("金币回流监听已启动（每 " + cfg.reflowIntervalSec
                + " 秒扫描一次，比例 " + cfg.reflowRatio + ":1，最低增量 "
                + cfg.reflowMinDelta + " 金币）");
    }

    public void stop() {
        if (task != null) {
            try { task.cancel(); } catch (Throwable ignored) { }
            task = null;
        }
        lastBalance.clear();
        lastName.clear();
    }

    public boolean isRunning() { return task != null; }

    /**
     * 立刻手动扫一次。
     *
     * <p>供 {@code /exbridge reflow scan} 调用，而 Bukkit 的命令回调本来就跑在
     * 主线程，所以这里可以直接执行 —— 不需要也不应该再切线程。
     * 定时任务那条路径由 {@link #start()} 的 runTaskTimer 保证主线程。
     */
    public void scanNow() {
        scan();
    }

    // ─────────────────────────── 事件：维护快照 ───────────────────────────

    /**
     * 玩家上线：立刻打一个基线快照，<b>不</b>上报。
     *
     * <p>★ 为什么上线时不直接上报余额当增量：玩家可能攒了 10 万金币再上线，
     * 那一瞬间的「增量」是历史存量，拿它当回流会直接把他全部身家抽走。
     * 基线必须在**第一次扫描之前**就位，扫描时只跟基线比。
     */
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onJoin(PlayerJoinEvent e) {
        snapshot(e.getPlayer());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent e) {
        drop(e.getPlayer().getUniqueId());
    }

    private void drop(UUID uuid) {
        String k = uuid.toString().toLowerCase();
        lastBalance.remove(k);
        lastName.remove(k);
    }

    /** 记录当前余额为基线。失败（玩家不存在/后端查不到）时静默跳过。 */
    private void snapshot(Player p) {
        Double bal = eco.balanceOf(p.getName());
        if (bal == null) return;
        String k = p.getUniqueId().toString().toLowerCase();
        lastBalance.put(k, bal);
        lastName.put(k, p.getName());
    }

    // ─────────────────────────── 周期扫描 ───────────────────────────

    /**
     * 扫一遍在线玩家，把正向增量按比例抽成积分并上报。
     *
     * <p>调度的 tick 内执行 —— 经济插件的读与写都要求主线程。
     */
    private void scan() {
        scanned.incrementAndGet();
        if (!eco.available()) {
            return;
        }
        // Redis 连接池不在（断线重连中）就只更新基线、不抽成：
        // 否则这段时间赚的钱会在重连后被一次性抽走，玩家会觉得莫名其妙。
        if (poller.pool() == null) {
            for (Player p : Bukkit.getOnlinePlayers()) snapshot(p);
            return;
        }

        final int ratio = Math.max(1, cfg.reflowRatio);

        for (Player p : Bukkit.getOnlinePlayers()) {
            String k = p.getUniqueId().toString().toLowerCase();
            Double bal = eco.balanceOf(p.getName());
            if (bal == null) {
                drop(p.getUniqueId());
                continue;
            }
            Double prev = lastBalance.get(k);
            lastBalance.put(k, bal);
            lastName.put(k, p.getName());

            // 第一次见到这个玩家：只立基线，不抽。理由见 onJoin 的注释。
            if (prev == null) continue;

            double delta = bal - prev;
            if (delta < cfg.reflowMinDelta) continue;
            if (delta > cfg.reflowMaxDelta) {
                // 单次增量异常大（管理员一次发了 10 万、或后端刚同步完数据）。
                // 按上限截断并留日志，不能让一次异常把玩家的全部余额抽干。
                plugin.getLogger().warning("[回流] " + p.getName() + " 单次增量 " + (long) delta
                        + " 金币超过上限 " + cfg.reflowMaxDelta + "，已截断");
                delta = cfg.reflowMaxDelta;
            }

            long credit = (long) Math.floor(delta / ratio);
            long taken = credit * ratio;
            if (credit < 1 || taken < 1) {
                skipped.incrementAndGet();
                continue;
            }
            if (taken > bal) {
                // 余额已经花掉了（扫描间隔内先赚后花）—— 宁可不抽，
                // 也不能把余额扣成负数。
                skipped.incrementAndGet();
                continue;
            }

            // ★ 先扣币。扣失败就绝不上报 —— 否则中间件会白加一份积分。
            String err = eco.withdraw(p.getName(), (int) taken);
            if (err != null) {
                failed.incrementAndGet();
                plugin.getLogger().warning("[回流] " + p.getName() + " 扣币失败，未上报："
                        + abbreviate(err, 160));
                continue;
            }
            // 扣完立刻更新基线：否则下一轮扫描会把「-taken」当成负增量忽略掉，
            // 随后玩家再赚 100 会被算成 100-(-taken) = 巨量增量。
            Double after = eco.balanceOf(p.getName());
            if (after != null) lastBalance.put(k, after);

            if (pushEvent(p, (int) taken, (int) credit, after)) {
                reported.incrementAndGet();
            } else {
                failed.incrementAndGet();
            }
        }
    }

    /**
     * 把一次成功的抽取写进事件队列（插件 → 中间件）。
     *
     * <p>消息格式与 {@link Queue} 的 eventKey 约定一致：
     * <pre>
     *   {event_id, player, uuid, asset, delta, credit, balance_after, ts}
     * </pre>
     * uuid 必带 —— 中间件靠它定位账户，玩家改名不影响入账。
     *
     * @return true 表示已入队
     */
    private boolean pushEvent(Player p, int taken, int credit, Double after) {
        JsonObject o = new JsonObject();
        o.addProperty("event_id", "rf:" + p.getUniqueId().toString().replace("-", "")
                + ":" + System.currentTimeMillis());
        o.addProperty("player", p.getName());
        o.addProperty("uuid", p.getUniqueId().toString());
        o.addProperty("asset", "coin");
        o.addProperty("delta", taken);
        o.addProperty("credit", credit);
        o.addProperty("balance_after", after == null ? -1 : after.longValue());
        o.addProperty("ts", System.currentTimeMillis());

        String payload = o.toString();
        try {
            // ⚠️ JedisPool 上没有 lpush —— 池只管借还连接，
            //   命令要借一个 Jedis 出来发，写完必须还（try-with-resources）。
            //   写成 poller.pool().lpush(...) 编译直接失败。
            try (Jedis j = poller.pool().getResource()) {
                j.lpush(cfg.eventQueueKey, payload);
            }
            plugin.getLogger().info("[回流] " + p.getName() + " −" + taken + " 金币 → +"
                    + credit + " 积分（余额 " + (after == null ? "?" : (long) (double) after) + "）");
            return true;
        } catch (Throwable t) {
            // 入队失败 = 这笔积分作废。注意金币**已经扣了**：
            // 玩家会实际损失 taken 金币却没拿到积分。
            // 这是「先扣后加」顺序的已知代价 —— 方向安全（不会造币），
            // 且玩家报损失时凭 event_id 里的 uuid+时间戳可以精确定位并人工补。
            plugin.getLogger().severe("[回流] " + p.getName() + " 事件入队失败，玩家已扣 "
                    + taken + " 金币但未获得积分，请人工补发：" + t);
            return false;
        }
    }

    // ─────────────────────────── 诊断 ───────────────────────────

    public long scannedCount() { return scanned.get(); }
    public long reportedCount() { return reported.get(); }
    public long skippedCount() { return skipped.get(); }
    public long failedCount() { return failed.get(); }
    public int trackingCount() { return lastBalance.size(); }

    private static String abbreviate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }
}
