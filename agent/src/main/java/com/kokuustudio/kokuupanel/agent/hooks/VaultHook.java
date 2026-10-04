package com.kokuustudio.kokuupanel.agent.hooks;

import com.kokuustudio.kokuupanel.agent.protocol.AgentException;
import com.kokuustudio.kokuupanel.agent.protocol.ErrorCode;
import java.util.logging.Logger;
import org.bukkit.Bukkit;
import org.bukkit.plugin.Plugin;

/**
 * Vault 运行时探测。
 *
 * <p>架构文档 §4.3：「softdepend + 运行时探测。没装 Vault 就不声明 economy
 * capability，平台前端自动隐藏入口 —— 用户看不到点了会报错的功能。」
 *
 * <p>探测分三步，任何一步失败都算「没有经济能力」，绝不抛 {@code NoClassDefFoundError}：
 * <ol>
 *   <li>Vault 插件在不在</li>
 *   <li>{@code net.milkbowl.vault.economy.Economy} 这个类在不在</li>
 *   <li>{@link VaultEcoBridge} 能不能构造出来（即有没有注册 Economy 服务且后端已启用）</li>
 * </ol>
 */
public final class VaultHook {

    private static final String ECONOMY_CLASS = "net.milkbowl.vault.economy.Economy";

    private final Logger logger;
    private volatile EcoBridge bridge;
    private volatile boolean available;
    private volatile boolean pluginPresent;

    public VaultHook(Logger logger) {
        this.logger = logger;
    }

    /** Vault 插件本身在不在（无论有没有可用的经济后端）。 */
    public boolean pluginPresent() {
        return pluginPresent;
    }

    /** 可重复调用（启动时与 /kp reload 时）。 */
    public void probe() {
        probe(false);
    }

    /**
     * 探测 Vault 经济后端。
     *
     * @param quiet {@code true} 时不打日志。给「能力看门狗」用 ——
     *              它会周期性重探，而重探失败的日志对运维没有价值，
     *              只会每 30 秒刷一条。状态真正变化时才由调用方打日志。
     */
    public void probe(boolean quiet) {
        available = false;
        bridge = null;

        Plugin vault = Bukkit.getPluginManager().getPlugin("Vault");
        pluginPresent = vault != null;
        if (vault == null) {
            if (!quiet) {
                logger.info("未检测到 Vault：不声明 economy 能力（平台会隐藏经济入口）");
            }
            return;
        }
        try {
            Class.forName(ECONOMY_CLASS);
        } catch (Throwable t) {
            if (!quiet) {
                logger.warning("Vault 存在但缺少 " + ECONOMY_CLASS + "：" + t
                        + "；不声明 economy 能力");
            }
            return;
        }
        try {
            Class<?> impl = Class.forName(VaultEcoBridge.class.getName());
            EcoBridge created = (EcoBridge) impl.getDeclaredConstructor().newInstance();
            bridge = created;
            available = true;
            if (!quiet) {
                logger.info("已接入 Vault 经济后端：" + created.name() + "（货币 " + created.currency() + "）");
            }
        } catch (Throwable t) {
            if (!quiet) {
                logger.warning("Vault 存在但没有可用的经济后端：" + describe(t)
                        + "；不声明 economy 能力（平台会隐藏经济入口）");
            }
        }
    }

    public boolean isAvailable() {
        return available && bridge != null;
    }

    /** 取后端；不可用直接抛 {@code NO_ECONOMY}。 */
    public EcoBridge require() {
        EcoBridge current = bridge;
        if (!available || current == null) {
            throw new AgentException(ErrorCode.NO_ECONOMY,
                    "本节点没有可用的 Vault 经济后端（未安装 Vault 或没有经济插件）");
        }
        return current;
    }

    public String describe() {
        EcoBridge current = bridge;
        if (current == null) {
            return "无";
        }
        return current.name() + " / " + current.currency();
    }

    private static String describe(Throwable throwable) {
        Throwable cause = throwable.getCause() == null ? throwable : throwable.getCause();
        String message = cause.getMessage();
        return cause.getClass().getSimpleName() + (message == null ? "" : ": " + message);
    }
}
