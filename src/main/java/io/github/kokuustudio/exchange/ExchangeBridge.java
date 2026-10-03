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
    private ExchangeWorker worker;
    private QueuePoller poller;

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
        startWorker();

        getLogger().info("ExchangeBridge 已启用");
        getLogger().info("  队列：queue=" + cfg.queueKey + "  result=" + cfg.resultKey);
        if (!eco.available()) {
            getLogger().warning("⚠ 未检测到可用的经济插件 —— 插件已加载，但**所有兑换都会失败并退款**。");
            getLogger().warning("  原因：" + eco.lastError());
        } else {
            getLogger().info("  经济插件：" + eco.mode().label() + " → "
                + eco.resolvedClass() + "  " + eco.describeMethods());
        }
    }

    @Override
    public void onDisable() {
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

    private void startWorker() {
        worker = new ExchangeWorker(this, cfg, eco);
        poller = new QueuePoller(this, cfg, worker);
        poller.start();
    }

    private void reload() {
        if (poller != null) poller.stop();
        reloadConfig();
        cfg = BridgeConfig.load(getConfig());
        List<String> problems = cfg.problems();
        if (!problems.isEmpty()) {
            getLogger().severe("配置有问题，未重载：" + String.join("；", problems));
            return;
        }
        bindEconomy();
        startWorker();
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
            String bal = eco.balance(args[1]);
            sender.sendMessage(bal == null
                    ? ChatColor.YELLOW + "查不到该玩家的余额（需在线且经济插件可用）"
                    : ChatColor.GREEN + args[1] + " 的余额：" + bal);
            return true;
        }

        sender.sendMessage(ChatColor.YELLOW + "用法：/exbridge status|reconnect|balance <玩家>|reload");
        return true;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command cmd, String alias, String[] args) {
        if (!cmd.getName().equalsIgnoreCase("exbridge")) {
            return Collections.emptyList();
        }
        if (args.length == 1) {
            List<String> out = new ArrayList<>();
            List<String> all = new ArrayList<>(Arrays.asList("status", "reconnect", "balance", "reload"));
            if (sender.hasPermission(PERM_ADMIN)) {
                all.addAll(Arrays.asList("诊断", "重连", "重载"));
            }
            for (String s : all) {
                if (s.startsWith(args[0].toLowerCase())) {
                    out.add(s);
                }
            }
            return out;
        }
        if (args.length == 2 && "balance".equalsIgnoreCase(args[0]) && sender instanceof Player) {
            return Arrays.asList(((Player) sender).getName());
        }
        return Collections.emptyList();
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
        s.sendMessage(ChatColor.GRAY + " 轮询：" + (worker != null && worker.isRunning() ? "运行中" : "已停止")
                + "，每 " + cfg.pollIntervalMs + "ms，单批 " + cfg.batchSize + " 条");

        // 队列深度：直接读 Redis，不经过 worker
        long queueLen = -1, resultLen = -1;
        String err = null;
        if (poller != null && poller.pool() != null) {
            try (Jedis j = poller.pool().getResource()) {
                queueLen = j.llen(cfg.queueKey);
                resultLen = j.llen(cfg.resultKey);
            } catch (Exception e) {
                err = e.getMessage();
            }
        }
        if (err != null) {
            s.sendMessage(ChatColor.RED + " Redis 读取失败：" + err);
        } else {
            s.sendMessage(ChatColor.GRAY + " 待发放：" + queueLen + " 条    待回传：" + resultLen + " 条");
            if (resultLen > 20) {
                s.sendMessage(ChatColor.YELLOW + " ⚠ 回传队列积压 " + resultLen
                        + " 条 —— 皮肤站要有人访问页面才会消费（无 worker），请提醒玩家刷新");
            }
        }

        s.sendMessage(ChatColor.GRAY + " 经济插件：" + (eco.available()
                ? eco.mode().label() + " → " + eco.resolvedClass() + "  " + eco.describeMethods()
                : ChatColor.RED + "不可用 —— " + eco.lastError()));

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
        if (!eco.available()) {
            s.sendMessage(ChatColor.RED + " 结论：兑换功能当前**不可用**，玩家下单会立刻失败退款");
        }
        return true;
    }
}
