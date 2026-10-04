package com.kokuustudio.kokuupanel.scoreboard;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;

/**
 * {@code /kokuusb} —— 记分牌的开关与重载。
 *
 * <h2>用法</h2>
 *
 * <pre>
 *   /kokuusb              看自己的状态与用法
 *   /kokuusb on|off       自己开关（记在内存里，重连仍生效，重启服务端恢复默认）
 *   /kokuusb on|off &lt;玩家&gt; 管理员替别人开关（需要 kokuusb.admin）
 *   /kokuusb reload       重载 config.yml（需要 kokuusb.admin）
 *   /kokuusb verify       按当前配置真的造一块板子做自检（需要 kokuusb.admin）
 * </pre>
 *
 * <p>{@code verify} 的价值在于**不需要玩家在线**：配置写超了会被服务端拒绝，
 * 而那种错误只在有人进服时才暴露。见 {@code KokuuScoreboardPlugin#verify}。
 *
 * <h2>为什么自己也能关</h2>
 *
 * 侧边栏占着屏幕右边一条。有的玩家就是不想看 —— 给他一个自己关掉的开关，
 * 比让他来找管理员，或者干脆装着没看见要省事得多。
 */
final class SbCommand implements CommandExecutor, TabCompleter {

    private static final List<String> ACTIONS = Arrays.asList("on", "off", "reload", "verify");

    private final KokuuScoreboardPlugin plugin;

    SbCommand(KokuuScoreboardPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0) {
            showStatus(sender, label);
            return true;
        }

        String action = args[0].toLowerCase(Locale.ROOT);

        if ("reload".equals(action)) {
            if (!sender.hasPermission(KokuuScoreboardPlugin.PERM_ADMIN)) {
                sender.sendMessage(ChatColor.RED + "你没有权限重载配置。");
                return true;
            }
            plugin.reloadSettings();
            sender.sendMessage(ChatColor.GREEN + "配置已重载。");
            return true;
        }

        if ("verify".equals(action)) {
            if (!sender.hasPermission(KokuuScoreboardPlugin.PERM_ADMIN)) {
                sender.sendMessage(ChatColor.RED + "你没有权限做自检。");
                return true;
            }
            sender.sendMessage(ChatColor.GOLD + "记分牌自检：");
            for (String line : plugin.verify()) {
                sender.sendMessage(ChatColor.GRAY + "  " + line);
            }
            return true;
        }

        if (!"on".equals(action) && !"off".equals(action)) {
            sender.sendMessage(ChatColor.RED + "未知操作「" + args[0] + "」。用法：" + usage(label));
            return true;
        }

        boolean enable = "on".equals(action);

        // 目标：没给名字就是自己。
        Player target;
        if (args.length >= 2) {
            if (!sender.hasPermission(KokuuScoreboardPlugin.PERM_ADMIN)) {
                sender.sendMessage(ChatColor.RED + "你没有权限替别人开关记分牌。");
                return true;
            }
            target = Bukkit.getPlayerExact(args[1]);
            if (target == null) {
                // 只认在线玩家：开关存在内存里，对不在线的人设了也没处生效，
                // 反而会让人以为「设过了却没用」。
                sender.sendMessage(ChatColor.RED + "玩家 " + args[1] + " 不在线。"
                        + "（开关记在内存里，只能对在线玩家设置）");
                return true;
            }
        } else {
            if (!(sender instanceof Player)) {
                sender.sendMessage(ChatColor.RED + "控制台请指定玩家名：" + usage(label));
                return true;
            }
            target = (Player) sender;
        }

        plugin.setPreference(target.getUniqueId(), enable);
        // 立刻重画，不等下一个刷新周期 —— 玩家点完应该马上看到变化。
        plugin.refresh(target);

        sender.sendMessage(ChatColor.GREEN + (enable ? "已打开" : "已关闭") + " " + target.getName() + " 的记分牌。");
        if (!target.equals(sender)) {
            target.sendMessage(ChatColor.GRAY + "管理员"
                    + (enable ? "打开了" : "关闭了") + "你的侧边栏记分牌。");
        }
        return true;
    }

    private void showStatus(CommandSender sender, String label) {
        if (!(sender instanceof Player)) {
            sender.sendMessage(ChatColor.GRAY + "用法：" + usage(label));
            return;
        }

        Player player = (Player) sender;
        Boolean preference = plugin.preference(player.getUniqueId());
        boolean effective = preference != null ? preference.booleanValue() : plugin.defaultEnabled();

        sender.sendMessage(ChatColor.GOLD + "侧边栏记分牌：" + ChatColor.WHITE
                + (effective ? "开启" : "关闭")
                + ChatColor.GRAY + (preference == null ? "（跟随服务器默认值）" : "（你手动设置的）"));
        sender.sendMessage(ChatColor.GRAY + "用法：" + usage(label));
    }

    private static String usage(String label) {
        return "/" + label + " <on|off|reload|verify> [玩家]";
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        List<String> out = new ArrayList<String>();

        if (args.length == 1) {
            String prefix = args[0].toLowerCase(Locale.ROOT);
            for (String action : ACTIONS) {
                // 管理类动作（reload / verify）要权限，就不给没权限的人提示
                boolean adminOnly = "reload".equals(action) || "verify".equals(action);
                if (adminOnly && !sender.hasPermission(KokuuScoreboardPlugin.PERM_ADMIN)) {
                    continue;
                }
                if (action.startsWith(prefix)) {
                    out.add(action);
                }
            }
            return out;
        }

        if (args.length == 2 && sender.hasPermission(KokuuScoreboardPlugin.PERM_ADMIN)) {
            String prefix = args[1].toLowerCase(Locale.ROOT);
            for (Player online : Bukkit.getOnlinePlayers()) {
                if (online.getName().toLowerCase(Locale.ROOT).startsWith(prefix)) {
                    out.add(online.getName());
                }
            }
        }

        return out;
    }
}
