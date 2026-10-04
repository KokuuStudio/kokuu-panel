package com.kokuustudio.kokuupanel.scoreboard;

import org.bukkit.entity.Player;

/**
 * 游戏内余额的读取口。
 *
 * <h2>为什么要抽一层接口</h2>
 *
 * 余额的唯一权威在服务端上的经济插件（Vault 后面的 CMI / Essentials 等）。
 * 但 Vault **是软依赖** —— 没装它的时候插件不能崩，也不能把自己的类
 * 初始化到一半就 {@code NoClassDefFoundError}。
 *
 * Java 的类加载是按需的：只要不去碰 {@link VaultEconomyBridge}，
 * 它引用的 {@code net.milkbowl.vault.*} 就永远不会被解析。
 * 所以这里用一个接口 + 两个实现，由 {@link EconomyBridges} 决定加载哪个：
 *
 * <ul>
 *   <li>装了 Vault → 通过 {@code Class.forName} 加载 {@link VaultEconomyBridge}</li>
 *   <li>没装 / 加载失败 → {@link NoopEconomyBridge}（余额显示成可配置的占位文案）</li>
 * </ul>
 */
interface EconomyBridge {

    /** 现在能不能读到余额。false 时 {@code %balance%} 走 {@code balanceFallback}。 */
    boolean available();

    /** 玩家余额。{@link #available()} 为 false 时不该被调用。 */
    double balance(Player player);

    /** 货币名（Vault 的 currencyNamePlural）。拿不到时返回空串。 */
    String currencyName(Player player);

    /** 按经济插件自己的习惯格式化金额（千分位、符号位置等）。 */
    String format(Player player, double amount);
}
