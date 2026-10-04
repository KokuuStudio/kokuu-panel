package com.kokuustudio.kokuupanel.agent.hooks;

import com.kokuustudio.kokuupanel.agent.protocol.AgentException;
import com.kokuustudio.kokuupanel.agent.protocol.ErrorCode;
import java.util.logging.Logger;
import org.bukkit.Bukkit;
import org.bukkit.plugin.Plugin;

/**
 * LuckPerms 运行时探测。
 *
 * <p>架构文档 §4.3：LuckPerms 是 {@code provided} + {@code softdepend}，
 * **启动时探测版本，不兼容就明确报错而不是抛 {@code NoSuchMethodError}**。
 *
 * <p>探测逻辑（任何一步失败都算「没有 LuckPerms 能力」，绝不抛 {@code NoClassDefFoundError}）：
 * <ol>
 *   <li>LuckPerms 插件在不在</li>
 *   <li>{@code net.luckperms.api.LuckPermsProvider} 在不在
 *       —— LP 4.x 及更早的 API 包名完全不同，这一步就会失败</li>
 *   <li>{@link LuckPermsBridge} 能不能构造出来（{@code LuckPermsProvider.get()} 成功，
 *       且 {@code PluginMetadata.getApiVersion()} 的主版本是 5）</li>
 * </ol>
 *
 * <p>本类**不引用任何 {@code net.luckperms} 类型**，只引用接口与类名字符串 ——
 * 这是「没装 LuckPerms 也不会炸」的关键。
 */
public final class LuckPermsHook {

    private static final String PROVIDER_CLASS = "net.luckperms.api.LuckPermsProvider";

    private final Logger logger;
    private volatile LpBridge bridge;
    private volatile boolean available;
    private volatile boolean pluginPresent;
    private volatile String description = "无";

    public LuckPermsHook(Logger logger) {
        this.logger = logger;
    }

    /** LuckPerms 插件本身在不在（无论 API 可不可用）。 */
    public boolean pluginPresent() {
        return pluginPresent;
    }

    /** 可重复调用（启动时与 /kp reload 时）。 */
    public void probe() {
        probe(false);
    }

    /**
     * 探测 LuckPerms。
     *
     * @param quiet {@code true} 时不打日志。给「能力看门狗」用 ——
     *              它会周期性重探，而重探失败的日志只会刷屏；
     *              状态真正变化时才由调用方打日志。
     */
    public void probe(boolean quiet) {
        available = false;
        bridge = null;
        description = "无";

        Plugin plugin = Bukkit.getPluginManager().getPlugin("LuckPerms");
        pluginPresent = plugin != null;
        if (plugin == null) {
            if (!quiet) {
                logger.info("未检测到 LuckPerms：不声明 luckperms 能力（平台会隐藏权限入口）");
            }
            return;
        }
        String version = plugin.getDescription() == null ? "?" : plugin.getDescription().getVersion();

        try {
            Class.forName(PROVIDER_CLASS);
        } catch (Throwable t) {
            if (!quiet) {
                logger.warning("检测到 LuckPerms " + version + "，但 " + PROVIDER_CLASS
                        + " 不存在：本插件只支持 5.x 的 API（4.x 的 API 完全不同，"
                        + "为 2018 年的老版本维护两套反射调用不划算 —— 架构文档 §4.3）。"
                        + "不声明 luckperms 能力。");
            }
            return;
        }

        try {
            Class<?> impl = Class.forName(LuckPermsBridge.class.getName());
            LpBridge created = (LpBridge) impl.getDeclaredConstructor().newInstance();
            String described = created.versionDescription();
            bridge = created;
            available = true;
            description = described;
            if (!quiet) {
                logger.info("已接入 " + described);
            }
        } catch (Throwable t) {
            if (!quiet) {
                logger.warning("LuckPerms " + version + " 的 API 不可用：" + describe(t)
                        + "；不声明 luckperms 能力（平台会隐藏权限入口）。");
            }
        }
    }

    public boolean isAvailable() {
        return available && bridge != null;
    }

    /** 取实现；不可用直接抛 {@code NO_LUCKPERMS}。 */
    public LpBridge require() {
        LpBridge current = bridge;
        if (!available || current == null) {
            throw new AgentException(ErrorCode.NO_LUCKPERMS,
                    "本节点没有可用的 LuckPerms 5.x（未安装或 API 版本不兼容）");
        }
        return current;
    }

    public String describe() {
        return available ? description : "无";
    }

    /**
     * 运行中出现了链接错误（{@code NoSuchMethodError} / {@code NoClassDefFoundError} 等），
     * 说明 API 实际不兼容。降级为「不可用」，后续请求统一回 {@code NO_LUCKPERMS}，
     * 而不是每次都抛一个看不懂的链接错误。
     */
    public void markBroken(Throwable cause) {
        if (!available) {
            return;
        }
        available = false;
        bridge = null;
        description = "无";
        logger.severe("LuckPerms API 运行期不兼容（" + cause.getClass().getName()
                + ": " + cause.getMessage() + "），已降级为不可用；"
                + "后续 luckperms.* 请求统一返回 NO_LUCKPERMS");
    }

    private static String describe(Throwable throwable) {
        Throwable cause = throwable.getCause() == null ? throwable : throwable.getCause();
        String message = cause.getMessage();
        return cause.getClass().getSimpleName() + (message == null ? "" : ": " + message);
    }
}
