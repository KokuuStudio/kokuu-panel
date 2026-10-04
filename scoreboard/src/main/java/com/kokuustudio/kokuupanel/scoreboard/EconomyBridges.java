package com.kokuustudio.kokuupanel.scoreboard;

import java.util.logging.Logger;

import org.bukkit.Bukkit;
import org.bukkit.plugin.Plugin;

/**
 * 决定用哪个 {@link EconomyBridge}。
 *
 * <h2>为什么判断顺序是「先问 Vault 插件，再 forName 类」</h2>
 *
 * 两个条件都得满足，而且顺序不能反：
 * <ol>
 *   <li>{@code getPlugin("Vault")} 能挡住「压根没装 Vault」的绝大多数情况，
 *       而且这一步不会碰任何 Vault 的类；</li>
 *   <li>{@code Class.forName} 才真正去解析 {@link VaultEconomyBridge} 引用的
 *       {@code net.milkbowl.vault.*}。</li>
 * </ol>
 *
 * 反过来先 forName 的话，没装 Vault 的服会在启动时看到一次
 * {@code ClassNotFoundException} 堆栈 —— 那是个**预期之内**的情况，
 * 用异常刷屏会让人以为插件坏了。
 *
 * <p>VaultAPI 的 jar **不打包进本插件**（provided），运行期由 Vault 提供。
 */
final class EconomyBridges {

    private static final String VAULT_PLUGIN = "Vault";
    private static final String VAULT_IMPL = "com.kokuustudio.kokuupanel.scoreboard.VaultEconomyBridge";

    private EconomyBridges() {
    }

    static EconomyBridge create(Logger logger) {
        Plugin vault = Bukkit.getPluginManager().getPlugin(VAULT_PLUGIN);
        if (vault == null) {
            logger.info("未检测到 Vault，%balance% 将显示为占位文案（其余占位符不受影响）。");
            return new NoopEconomyBridge();
        }

        try {
            Class<?> impl = Class.forName(VAULT_IMPL);
            EconomyBridge bridge = (EconomyBridge) impl.getDeclaredConstructor().newInstance();
            if (bridge.available()) {
                logger.info("已接入 Vault 经济后端，%balance% 可用。");
            } else {
                // Vault 在，但它后面的经济插件还没注册 —— 下一轮刷新会自己好。
                logger.info("检测到 Vault，但经济后端尚未注册，%balance% 暂时显示占位文案。");
            }
            return bridge;
        } catch (Throwable failure) {
            // 这里用 Throwable 而不是 Exception：类加载失败可能是
            // NoClassDefFoundError / ExceptionInInitializerError，那都是 Error，
            // 不是 Exception。漏掉的话整个插件会因为一个可选依赖而 enable 失败。
            logger.warning("Vault 已安装但经济桥接加载失败，%balance% 将显示为占位文案："
                    + failure.getClass().getSimpleName() + ": " + failure.getMessage());
            return new NoopEconomyBridge();
        }
    }
}
