package io.github.kokuustudio.exchange;

import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.PluginCommand;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;
import redis.clients.jedis.Jedis;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * ExchangeBridge —— Blessing Skin 积分兑换的 MC 端执行器。
 *
 * <p>职责：消费皮肤站写入 Redis 的订单 → 调经济插件发放游戏内货币 → 回传结果。
 * 皮肤站侧（{@code kokuu-exchange} 插件）负责扣积分、订单状态机、退款。
 *
 * <p>为什么用 Redis 队列而不是 HTTP 回调：
 * <ul>
 *   <li>主流经济后端（Vault / EssentialsX 等）大多没有 HTTP/REST 接口，发放只能在服务端执行；</li>
 *   <li>Redis 只监听 127.0.0.1，服务器不必开任何公网端口；</li>
 *   <li>RPOP「取走即消失」天然避免两实例重复消费，不需要额外加锁。</li>
 * </ul>
 *
 * <p>命令：
 * <pre>
 *   /exbridge status            查看队列深度、经济插件绑定情况、收发计数
 *   /exbridge reconnect         手动重建 Redis 连接（排查断连用）
 *   /exbridge balance &lt;玩家&gt;查该玩家的货币余额
 *   /exbridge reload            重读 config.yml
 * </pre>
 *
 * <p>★ 兼容目标：Minecraft 1.12.2 ~ 最新（Java 8 字节码，见 pom.xml 的 release=8）。
 */
public final class ExchangeBridge extends JavaPlugin implements CommandExecutor, TabCompleter {

    /** 权限节点 */
    public static final String PERM_ADMIN = "exchangebridge.admin";

    private BridgeConfig cfg;
    private EconomyHook eco;
    private PointsHook pts;
    private ExchangeWorker worker;
    private AssetWorker assetWorker;
    private QueuePoller poller;
    private EarningsWatcher reflow;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        cfg = BridgeConfig.load(getConfig());

        List<String> problems = cfg.problems();
        if (!problems.isEmpty()) {
            getLogger().severe("配置有 " + problems.size() + " 个问题，插件已禁用：");
            for (String p : problems) {
                getLogger().severe("  - " + p);
            }
            Bukkit.getPluginManager().disablePlugin(this);
            return;
        }

        registerCommands();
        bindEconomy();
        bindPoints();
        startWorker();
        startReflow();

        getLogger().info("ExchangeBridge 已启用");
        getLogger().info("  兑换队列：queue=" + cfg.queueKey + "  result=" + cfg.resultKey);
        getLogger().info("  资产队列：asset=" + cfg.assetQueueKey + "  event=" + cfg.eventQueueKey);
        if (!eco.available()) {
            getLogger().warning("⚠ 未检测到可用的经济插件 —— 插件已加载，但**所有兑换都会失败并退款**。");
            getLogger().warning("  原因：" + eco.lastError());
        } else {
            getLogger().info("  经济插件：" + eco.mode().label() + " → "
                + eco.resolvedClass() + "  " + eco.describeMethods());
        }
        if (pts.available()) {
            getLogger().info("  点券插件：" + pts.describeMethods());
        } else {
            getLogger().info("  点券插件：未绑定（" + pts.lastError() + "）—— 点券功能不可用");
        }
    }

    @Override
    public void onDisable() {
        if (reflow != null) reflow.stop();
        if (poller != null) poller.stop();
        getLogger().info("ExchangeBridge 已卸载");
    }

    private void bindEconomy() {
        eco = EconomyHook.bind(cfg);
        if (eco.available()) return;

        // 常见原因：经济插件没装、或类名随版本变了。
        // 这里给可操作的排查指引，而不是只丢一个类名。
        getLogger().warning("未找到经济插件的经济类。已尝试："
                + String.join("、", cfg.economyClassNames));
        getLogger().warning("  · 首选路径是 Vault API —— 确认 Vault 与经济插件都已装且启动完成");
        getLogger().warning("  · 若它不走 Vault，在 config.yml 的 economy.class-names 里补上它的经济类全名");
    }

    /**
     * 绑定 PlayerPoints。
     *
     * <p>绑不上不算故障 —— 服务器可能压根没装点券插件。
     * 只打 info 不打 warning，避免每次启动都刷一条让人以为坏了的警告。
     */
    private void bindPoints() {
        pts = PointsHook.bind();
    }

    private void startWorker() {
        worker = new ExchangeWorker(this, cfg, eco);
        assetWorker = new AssetWorker(this, cfg, eco, pts);
        poller = new QueuePoller(this, cfg, worker, assetWorker);
        poller.start();
    }

    /**
     * 启动金币回流监听。
     *
     * <p>只有开关打开才注册事件监听器 —— 关着的时候连 PlayerJoin 都不接，
     * 完全零开销。
     */
    private void startReflow() {
        if (!cfg.reflowEnabled) {
            getLogger().info(" 金币回流：未启用（reflow.enabled=false）");
            return;
        }
        reflow = new EarningsWatcher(this, cfg, eco, poller);
        getServer().getPluginManager().registerEvents(reflow, this);
        reflow.start();
    }

    /**
     * 重载配置。
     *
     * <p>★ 顺序刻意是「先校验、后停旧实例」：
     *   反过来写（先 stop 再校验）的话，新配置有问题时直接 return，
     *   旧 worker 已经停了 —— 插件进入「加载着但什么都不工作」的半死状态，
     *   日志里只有一行「配置有问题，未重载」，非常难排查。
     */
    private void reload() {
        reloadConfig();
        BridgeConfig next = BridgeConfig.load(getConfig());
        List<String> problems = next.problems();
        if (!problems.isEmpty()) {
            getLogger().severe("配置有问题，未重载（插件仍在用旧配置运行）："
                    + String.join("；", problems));
            return;
        }

        if (reflow != null) reflow.stop();
        if (poller != null) poller.stop();

        cfg = next;
        bindEconomy();
        bindPoints();
        startWorker();
        startReflow();
        getLogger().info("配置已重载");
    }

    // ──────────────────────────── 命令 ────────────────────────────
    //
    // ⚠️⚠️ 必须 implements CommandExecutor，且 plugin.yml 里要声明 commands。
    //    之前只写了一个 public boolean onCommand(...) 但没 implements ——
    //    Bukkit 找不到执行器，四个命令全是死的，调用只回 "Unknown command"。
    //    这是「碰巧同名的 public 方法」与「真正实现接口」的本质区别：
    //    不实现接口时，方法不会被注册到任何地方，编译器也不会提醒你。

    @Override
    public boolean onCommand(CommandSender sender, Command cmd, String label, String[] args) {
        if (!cmd.getName().equalsIgnoreCase("exbridge")) {
            return false;
        }

        String sub = args.length == 0 ? "status" : args[0].toLowerCase();

        // status / balance 是只读诊断，普通玩家可看自己的；改动类操作要管理权限
        if ((sub.equals("reconnect") || sub.equals("reload")) && !sender.hasPermission(PERM_ADMIN)) {
            sender.sendMessage(ChatColor.RED + "你没有权限（" + PERM_ADMIN + "）");
            return true;
        }

        if (sub.equals("status") || sub.equals("诊断")) {
            return diag(sender);
        }
        if (sub.equals("reconnect") || sub.equals("重连")) {
            if (poller != null) poller.stop();
            poller.start();
            sender.sendMessage(ChatColor.GREEN + "已重建 Redis 连接");
            return true;
        }
        if (sub.equals("reload") || sub.equals("重载")) {
            reload();
            sender.sendMessage(ChatColor.GREEN + "配置已重载");
            return true;
        }
        if (sub.equals("balance") || sub.equals("余额")) {
            if (args.length < 2) {
                sender.sendMessage(ChatColor.YELLOW + "用法：/exbridge balance <玩家名>");
                return true;
            }
            // 只能查自己，除非有管理权限 —— 避免普通玩家窥探他人余额
            boolean self = sender instanceof Player
                    && ((Player) sender).getName().equalsIgnoreCase(args[1]);
            if (!self && !sender.hasPermission(PERM_ADMIN)) {
                sender.sendMessage(ChatColor.RED + "只能查询自己的余额");
                return true;
            }
            String coin = eco.balance(args[1]);
            String points = pts == null ? null : String.valueOf(pts.look(args[1]));
            sender.sendMessage(ChatColor.GREEN + args[1] + " 的余额：");
            sender.sendMessage(ChatColor.GRAY + "  金币：" + (coin == null ? "查不到" : coin));
            sender.sendMessage(ChatColor.GRAY + "  点券：" + (points == null ? "查不到" : points));
            return true;
        }

        // ── 资产操作：coin / points 的查看与增减 ──────────────────
        // 全部要求管理权限。这些命令直接改玩家资产，
        // 普通玩家能调就等于随便给自己加钱。
        if (sub.equals("coin") || sub.equals("金币")
                || sub.equals("points") || sub.equals("点券")
                || sub.equals("give") || sub.equals("take")) {
            if (!sender.hasPermission(PERM_ADMIN)) {
                sender.sendMessage(ChatColor.RED + "你没有权限（" + PERM_ADMIN + "）");
                return true;
            }
            return assetCommand(sender, sub, args);
        }

        // ── 金币回流的手动操作 ────────────────────────────────────
        // scan = 立刻扫一次（不重启监听，用于「玩家说没收到积分」时自查）
        // on / off = 运行期开关（不写盘，重启后仍以 config.yml 为准）
        if (sub.equals("reflow") || sub.equals("回流")) {
            if (!sender.hasPermission(PERM_ADMIN)) {
                sender.sendMessage(ChatColor.RED + "你没有权限（" + PERM_ADMIN + "）");
                return true;
            }
            return reflowCommand(sender, sub, args);
        }

        sender.sendMessage(ChatColor.YELLOW
                + "用法：/exbridge status|reconnect|balance <玩家>|reload|reflow [scan|on|off]");
        return true;
    }

    /**
     * 回流的手动操作。
     *
     * <p>on/off 只改内存里的 flag，**不写 config.yml** —— 运行时开关与持久配置
     * 混在一起会出现「重启后行为突变」这类极难复现的问题。真要持久化就改配置文件再 reload。
     */
    private boolean reflowCommand(CommandSender s, String sub, String[] args) {
        String act = args.length >= 2 ? args[1].toLowerCase() : "scan";

        if (act.equals("on") || act.equals("开")) {
            if (reflow != null && reflow.isRunning()) {
                s.sendMessage(ChatColor.YELLOW + "回流已在运行");
                return true;
            }
            if (!eco.available()) {
                s.sendMessage(ChatColor.RED + "经济插件不可用，回流无法启动：" + eco.lastError());
                return true;
            }
            cfg.reflowEnabled = true;
            startReflow();
            s.sendMessage(ChatColor.GREEN + "回流已开启（本次仅内存生效，重启后以 config.yml 为准）");
            return true;
        }
        if (act.equals("off") || act.equals("关")) {
            if (reflow != null) reflow.stop();
            cfg.reflowEnabled = false;
            s.sendMessage(ChatColor.YELLOW + "回流已停止（本次仅内存生效，重启后以 config.yml 为准）");
            return true;
        }
        if (act.equals("scan") || act.equals("扫描")) {
            if (!cfg.reflowEnabled || reflow == null || !reflow.isRunning()) {
                s.sendMessage(ChatColor.YELLOW + "回流没在运行，先 /exbridge reflow on");
                return true;
            }
            if (!eco.available()) {
                s.sendMessage(ChatColor.RED + "经济插件不可用：" + eco.lastError());
                return true;
            }
            long before = reflow.reportedCount();
            reflow.scanNow();
            long after = reflow.reportedCount();
            s.sendMessage(ChatColor.GREEN + "已手动扫描一次，新增上报 " + (after - before) + " 条");
            return true;
        }
        s.sendMessage(ChatColor.YELLOW + "用法：/exbridge reflow [scan|on|off]");
        return true;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command cmd, String alias, String[] args) {
        if (!cmd.getName().equalsIgnoreCase("exbridge")) {
            return Collections.emptyList();
        }
        if (args.length == 1) {
            List<String> out = new ArrayList<>();
            List<String> all = new ArrayList<>(Arrays.asList(
                    "status", "reconnect", "balance", "reload", "reflow"));
            if (sender.hasPermission(PERM_ADMIN)) {
                all.addAll(Arrays.asList("coin", "points", "give", "take",
                        "诊断", "重连", "重载", "金币", "点券", "回流"));
            }
            for (String s : all) {
                if (s.startsWith(args[0].toLowerCase())) {
                    out.add(s);
                }
            }
            return out;
        }
        if (args.length == 2 && args[0].equalsIgnoreCase("reflow")
                && sender.hasPermission(PERM_ADMIN)) {
            return Arrays.asList("scan", "on", "off");
        }
        if (args.length == 2 && sender.hasPermission(PERM_ADMIN)) {
            // 资产类命令的第二个参数是玩家名 —— 补全在线玩家
            String sub = args[0].toLowerCase();
            boolean wantsPlayer = sub.equals("coin") || sub.equals("金币")
                    || sub.equals("points") || sub.equals("点券")
                    || sub.equals("give") || sub.equals("take");
            if (wantsPlayer) {
                List<String> names = new ArrayList<>();
                for (Player p : Bukkit.getOnlinePlayers()) {
                    names.add(p.getName());
                }
                return names;
            }
        }
        if (args.length == 2 && "balance".equalsIgnoreCase(args[0]) && sender instanceof Player) {
            return Arrays.asList(((Player) sender).getName());
        }
        return Collections.emptyList();
    }

    /**
     * 资产操作命令的实现。
     *
     * <p>支持两种写法：
     * <pre>
     *   /exbridge coin &lt;玩家&gt; &lt;+|-&gt;&lt;数额&gt;     改金币
     *   /exbridge points &lt;玩家&gt; &lt;+|-&gt;&lt;数额&gt;   改点券
     *   /exbridge give coin|points &lt;玩家&gt; &lt;数额&gt;   等价写法
     * </pre>
     *
     * <p>★ 经济操作必须在主线程执行。这里能直接调，是因为命令本身
     * 就跑在主线程（Bukkit 的命令回调），不像队列消费那样需要切线程。
     */
    private boolean assetCommand(CommandSender s, String sub, String[] args) {
        String asset;
        String rest;

        if (sub.equals("coin") || sub.equals("金币")) {
            asset = "coin";
            rest = String.join(" ", java.util.Arrays.copyOfRange(args, 1, args.length));
        } else if (sub.equals("points") || sub.equals("点券")) {
            asset = "points";
            rest = String.join(" ", java.util.Arrays.copyOfRange(args, 1, args.length));
        } else {
            // give / take 写法：第二个参数是资产种类
            if (args.length < 4) {
                s.sendMessage(ChatColor.YELLOW + "用法：/exbridge " + sub + " <coin|points> <玩家> <数额>");
                return true;
            }
            asset = args[1].toLowerCase();
            rest = args[2] + " " + args[3];
        }

        if (!asset.equals("coin") && !asset.equals("points")) {
            s.sendMessage(ChatColor.RED + "未知资产类型「" + asset + "」，只支持 coin 或 points");
            return true;
        }

        String[] parts = rest.trim().split("\\s+");
        if (parts.length < 2) {
            s.sendMessage(ChatColor.YELLOW + "用法：/exbridge " + asset + " <玩家> <+|-><数额>");
            return true;
        }

        String player = parts[0];
        int delta;
        try {
            delta = Integer.parseInt(parts[1]);
        } catch (NumberFormatException e) {
            s.sendMessage(ChatColor.RED + "数额必须是整数：" + parts[1]);
            return true;
        }
        if (delta == 0) {
            s.sendMessage(ChatColor.RED + "数额不能为 0");
            return true;
        }

        String reason;
        if (asset.equals("coin")) {
            if (!eco.available()) {
                s.sendMessage(ChatColor.RED + "经济插件不可用：" + eco.lastError());
                return true;
            }
            reason = delta > 0 ? eco.deposit(player, delta) : eco.withdraw(player, -delta);
        } else {
            if (pts == null || !pts.available()) {
                s.sendMessage(ChatColor.RED + "PlayerPoints 不可用："
                        + (pts == null ? "未初始化" : pts.lastError()));
                return true;
            }
            reason = delta > 0 ? pts.give(player, delta) : pts.take(player, -delta);
        }

        if (reason == null) {
            String label = asset.equals("coin") ? "金币" : "点券";
            s.sendMessage(ChatColor.GREEN + "已给 " + player + " " + label + " "
                    + (delta > 0 ? "+" : "") + delta);
        } else {
            s.sendMessage(ChatColor.RED + "操作失败：" + reason);
        }
        return true;
    }

    /** 注册命令执行器。必须在 plugin.yml 声明过 commands 后调用，否则 getCommand 返回 null。 */
    private void registerCommands() {
        PluginCommand pc = getCommand("exbridge");
        if (pc == null) {
            // 走到这里说明 plugin.yml 的 commands 段被改坏了，属代码事故
            getLogger().severe("plugin.yml 里缺少 exbridge 命令声明，命令功能不可用");
            return;
        }
        pc.setExecutor(this);
        pc.setTabCompleter(this);
    }

    private boolean diag(CommandSender s) {
        s.sendMessage(ChatColor.AQUA + "──── ExchangeBridge 诊断 ────");
        s.sendMessage(ChatColor.GRAY + " Redis：" + cfg.redisHost + ":" + cfg.redisPort
                + " db" + cfg.redisDatabase
                + (cfg.redisPassword == null || cfg.redisPassword.isEmpty() ? "（无密码）" : "（有密码）"));
        s.sendMessage(ChatColor.GRAY + " 队列：" + cfg.queueKey + " → " + cfg.resultKey);
        s.sendMessage(ChatColor.GRAY + " 资产队列：" + cfg.assetQueueKey);
        s.sendMessage(ChatColor.GRAY + " 轮询：" + (worker != null && worker.isRunning() ? "运行中" : "已停止")
                + "，每 " + cfg.pollIntervalMs + "ms，单批 " + cfg.batchSize + " 条");

        // 队列深度：直接读 Redis，不经过 worker
        long queueLen = -1, resultLen = -1, assetLen = -1, eventLen = -1;
        String err = null;
        if (poller != null && poller.pool() != null) {
            try (Jedis j = poller.pool().getResource()) {
                queueLen = j.llen(cfg.queueKey);
                resultLen = j.llen(cfg.resultKey);
                assetLen = j.llen(cfg.assetQueueKey);
                eventLen = j.llen(cfg.eventQueueKey);
            } catch (Exception e) {
                err = e.getMessage();
            }
        }
        if (err != null) {
            s.sendMessage(ChatColor.RED + " Redis 读取失败：" + err);
        } else {
            s.sendMessage(ChatColor.GRAY + " 待发放：" + queueLen + " 条    待回传：" + resultLen
                    + " 条    待执行资产指令：" + assetLen + " 条");
            s.sendMessage(ChatColor.GRAY + " 待处理回流事件：" + eventLen + " 条");
            if (eventLen > 20) {
                s.sendMessage(ChatColor.YELLOW + " ⚠ 回流事件积压 " + eventLen
                        + " 条 —— 中间件的 consumer 没在跑或已掉线，玩家已扣币但积分未入账，"
                        + "请检查中间件（/exbridge status 看不出这个，得查中间件日志）");
            }
            if (resultLen > 20) {
                s.sendMessage(ChatColor.YELLOW + " ⚠ 回传队列积压 " + resultLen
                        + " 条 —— 皮肤站要有人访问页面才会消费（无 worker），请提醒玩家刷新");
            }
        }

        s.sendMessage(ChatColor.GRAY + " 经济插件：" + (eco.available()
                ? eco.mode().label() + " → " + eco.resolvedClass() + "  " + eco.describeMethods()
                : ChatColor.RED + "不可用 —— " + eco.lastError()));

        s.sendMessage(ChatColor.GRAY + " 点券插件：" + (pts != null && pts.available()
                ? pts.describeMethods()
                : ChatColor.YELLOW + "不可用 —— " + (pts == null ? "未初始化" : pts.lastError())));

        if (assetWorker != null) {
            s.sendMessage(ChatColor.GRAY + " 资产计数：取到 " + assetWorker.consumedCount()
                    + "，成功 " + assetWorker.successCount()
                    + "，失败 " + assetWorker.failedCount()
                    + "，重复跳过 " + assetWorker.dupCount());
            String ae = assetWorker.lastError();
            if (ae != null && !ae.isEmpty()) {
                s.sendMessage(ChatColor.RED + " 资产最近错误：" + ae);
            }
        }

        if (worker != null) {
            s.sendMessage(ChatColor.GRAY + " 计数：取到 " + worker.consumedCount()
                    + "，成功 " + worker.successCount()
                    + "，失败 " + worker.failedCount()
                    + "，重复跳过 " + worker.dupCount()
                    + "，坏消息 " + worker.malformedCount());
            String le = worker.lastError();
            if (le != null && !le.isEmpty()) {
                s.sendMessage(ChatColor.RED + " 最近错误：" + le);
            }
        }

        // 回流
        if (!cfg.reflowEnabled) {
            s.sendMessage(ChatColor.GRAY + " 金币回流：未启用（reflow.enabled=false）");
        } else if (reflow == null || !reflow.isRunning()) {
            s.sendMessage(ChatColor.YELLOW + " 金币回流：开关已开但监听未运行 —— 请检查上方启动日志");
        } else {
            s.sendMessage(ChatColor.GRAY + " 金币回流：运行中（每 " + cfg.reflowIntervalSec
                    + " 秒，" + cfg.reflowRatio + ":1，跟踪 " + reflow.trackingCount() + " 人）");
            s.sendMessage(ChatColor.GRAY + "   扫描 " + reflow.scannedCount()
                    + " 次，上报 " + reflow.reportedCount()
                    + "，跳过 " + reflow.skippedCount()
                    + "，失败 " + reflow.failedCount());
            if (reflow.failedCount() > 0) {
                s.sendMessage(ChatColor.YELLOW + "   ⚠ 有失败记录 —— 若原因是「事件入队失败」，"
                        + "那些玩家已被扣币但没拿到积分，需人工补发（见日志里带 rf: 的 event_id）");
            }
        }

        if (!eco.available()) {
            s.sendMessage(ChatColor.RED + " 结论：兑换功能当前**不可用**，玩家下单会立刻失败退款");
        }
        return true;
    }
}
