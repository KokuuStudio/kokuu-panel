package com.kokuustudio.kokuupanel.agent.modules;

import com.kokuustudio.kokuupanel.agent.util.Text;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import net.kyori.adventure.text.Component;
import net.md_5.bungee.api.chat.BaseComponent;
import org.bukkit.Bukkit;
import org.bukkit.Server;
import org.bukkit.command.CommandSender;
import org.bukkit.permissions.Permission;
import org.bukkit.permissions.PermissionAttachment;
import org.bukkit.permissions.PermissionAttachmentInfo;
import org.bukkit.plugin.Plugin;

/**
 * 一个只负责「收集回显」的 {@link CommandSender}，用来实现
 * {@code console.execute} 的输出捕获（协议 §5.1）。
 *
 * <p>为什么不用 {@code Bukkit.getConsoleSender()} 直接执行：那样拿不到任何输出，
 * 只能回 {@code success:true} 和一个空数组 —— 平台上的控制台就变成了「黑盒」。
 *
 * <p><b>跨版本注意</b>：这个类实现的是 **1.20.6 编译期**的 {@code CommandSender}，
 * 但要在 1.12.2 上运行。所以：
 * <ul>
 *   <li>1.12.2 接口里的抽象方法（含 {@code addAttachment(Plugin, Permission, boolean)} 这组
 *       新版已删除的重载）全部实现，否则运行期会 {@code AbstractMethodError}。</li>
 *   <li>新版才有的方法（{@code name()}、{@code sendMessage(UUID,…)}）多实现几个不算错，
 *       老版本上它们只是「没人调用得多余方法」。</li>
 * </ul>
 */
public final class CapturingCommandSender implements CommandSender {

    private static final String NAME = "KokuuPanel";

    private final List<String> lines = Collections.synchronizedList(new ArrayList<String>());
    private final int maxLines;
    private final Server server;

    public CapturingCommandSender(int maxLines) {
        this.maxLines = maxLines;
        this.server = Bukkit.getServer();
    }

    public List<String> lines() {
        synchronized (lines) {
            return new ArrayList<String>(lines);
        }
    }

    private void add(String message) {
        if (message == null) {
            return;
        }
        synchronized (lines) {
            if (lines.size() >= maxLines) {
                return;
            }
            // 平台是 Web 界面，显示 §a 这种颜色代码只会变成噪音。
            lines.add(Text.stripColor(message));
        }
    }

    // ── CommandSender ─────────────────────────────────────────────────────

    @Override
    public void sendMessage(String message) {
        add(message);
    }

    @Override
    public void sendMessage(String[] messages) {
        if (messages == null) {
            return;
        }
        for (String message : messages) {
            add(message);
        }
    }

    @Override
    public void sendMessage(UUID sender, String message) {
        add(message);
    }

    @Override
    public void sendMessage(UUID sender, String[] messages) {
        sendMessage(messages);
    }

    @Override
    public void sendMessage(BaseComponent component) {
        if (component != null) {
            add(BaseComponent.toLegacyText(component));
        }
    }

    @Override
    public void sendMessage(BaseComponent... components) {
        if (components != null && components.length > 0) {
            add(BaseComponent.toLegacyText(components));
        }
    }

    @Override
    public String getName() {
        return NAME;
    }

    @Override
    public Server getServer() {
        return server;
    }

    @Override
    public Component name() {
        return Component.text(NAME);
    }

    /**
     * 有些插件走 Spigot 的 {@code sender.spigot().sendMessage(...)} 发消息，
     * 不覆盖这个就会漏掉它们的输出（甚至因为默认返回 null 直接 NPE）。
     */
    @Override
    public Spigot spigot() {
        return new Spigot() {
            @Override
            public void sendMessage(BaseComponent component) {
                CapturingCommandSender.this.sendMessage(component);
            }

            @Override
            public void sendMessage(BaseComponent... components) {
                CapturingCommandSender.this.sendMessage(components);
            }

            @Override
            public void sendMessage(UUID sender, BaseComponent component) {
                CapturingCommandSender.this.sendMessage(component);
            }

            @Override
            public void sendMessage(UUID sender, BaseComponent... components) {
                CapturingCommandSender.this.sendMessage(components);
            }
        };
    }

    // ── Permissible / ServerOperator ──────────────────────────────────────

    @Override
    public boolean isPermissionSet(String name) {
        return true;
    }

    @Override
    public boolean isPermissionSet(Permission permission) {
        return true;
    }

    /** 控制台身份：一律有权限，否则 {@code /stop} 这类命令会被权限挡掉。 */
    @Override
    public boolean hasPermission(String name) {
        return true;
    }

    @Override
    public boolean hasPermission(Permission permission) {
        return true;
    }

    @Override
    public boolean isOp() {
        return true;
    }

    @Override
    public void setOp(boolean value) {
        // 控制台本来就是 op，改不了也不需要改。
    }

    @Override
    public Set<PermissionAttachmentInfo> getEffectivePermissions() {
        return Collections.emptySet();
    }

    @Override
    public PermissionAttachment addAttachment(Plugin plugin) {
        return null;
    }

    @Override
    public PermissionAttachment addAttachment(Plugin plugin, int ticks) {
        return null;
    }

    @Override
    public PermissionAttachment addAttachment(Plugin plugin, String name, boolean value) {
        return null;
    }

    @Override
    public PermissionAttachment addAttachment(Plugin plugin, String name, boolean value, int ticks) {
        return null;
    }

    /** 1.12.2 的 {@code Permissible} 有这组重载，新版删掉了；保留实现以兼容老服务端。 */
    public PermissionAttachment addAttachment(Plugin plugin, Permission permission, boolean value) {
        return null;
    }

    public PermissionAttachment addAttachment(Plugin plugin, Permission permission, boolean value, int ticks) {
        return null;
    }

    @Override
    public void removeAttachment(PermissionAttachment attachment) {
        // 不接受 attachment，就没有要移除的。
    }

    @Override
    public void recalculatePermissions() {
        // 权限恒为 true，无需重算。
    }
}
