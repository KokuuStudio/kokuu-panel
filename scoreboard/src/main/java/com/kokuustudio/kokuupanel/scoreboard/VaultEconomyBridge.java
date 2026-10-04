package com.kokuustudio.kokuupanel.scoreboard;

import java.text.NumberFormat;
import java.util.Locale;

import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.plugin.RegisteredServiceProvider;

import net.milkbowl.vault.economy.Economy;

/**
 * 通过 Vault 读余额。
 *
 * <h2>这个类只在装了 Vault 时才会被加载</h2>
 *
 * 它直接引用了 {@code net.milkbowl.vault.economy.Economy}，那是个**编译期 provided**
 * 的类 —— 运行期由服务端上的 Vault 插件提供。没装 Vault 时这个类一旦被加载就会
 * {@code NoClassDefFoundError}，所以 {@link EconomyBridges} 会用
 * {@code Class.forName} 按需加载它，并且只在确认 Vault 插件已启用之后才那么做。
 *
 * 构造函数必须是 {@code public}：{@code Class.forName(...).getDeclaredConstructor()}
 * 走的是反射，非 public 就得额外 setAccessible，没必要。
 */
public final class VaultEconomyBridge implements EconomyBridge {

    private final Economy economy;

    public VaultEconomyBridge() {
        RegisteredServiceProvider<Economy> registration =
                Bukkit.getServicesManager().getRegistration(Economy.class);
        // 注册可能还不存在：Vault 本身在 enable 了，但它后面的经济插件（CMI 等）
        // 可能更晚才把 provider 注册进来。那时 available() 返回 false，
        // 记分牌先显示占位文案，下一轮刷新自然就好了 —— 不需要在这里重试。
        this.economy = registration == null ? null : registration.getProvider();
    }

    @Override
    public boolean available() {
        return economy != null;
    }

    @Override
    public double balance(Player player) {
        return economy == null ? 0D : economy.getBalance(player);
    }

    @Override
    public String currencyName(Player player) {
        if (economy == null) return "";
        try {
            return economy.currencyNamePlural();
        } catch (Throwable ignored) {
            // 某些经济插件对 currencyNamePlural 的实现会抛异常（未初始化完时）。
            // 货币名只是装饰，不该让整行挂掉。
            return "";
        }
    }

    @Override
    public String format(Player player, double amount) {
        if (economy == null) {
            return NumberFormat.getNumberInstance(Locale.US).format(Math.round(amount));
        }
        try {
            return economy.format(amount);
        } catch (Throwable ignored) {
            // 同上：格式化失败就退回自己算，至少数字是对的。
            return NumberFormat.getNumberInstance(Locale.US).format(Math.round(amount));
        }
    }
}
