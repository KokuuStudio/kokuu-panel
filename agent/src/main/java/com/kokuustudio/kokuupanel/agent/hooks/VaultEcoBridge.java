package com.kokuustudio.kokuupanel.agent.hooks;

import com.kokuustudio.kokuupanel.agent.protocol.AgentException;
import com.kokuustudio.kokuupanel.agent.protocol.ErrorCode;
import com.kokuustudio.kokuupanel.agent.util.Text;
import java.util.UUID;
import net.milkbowl.vault.economy.Economy;
import net.milkbowl.vault.economy.EconomyResponse;
import org.bukkit.Bukkit;
import org.bukkit.OfflinePlayer;
import org.bukkit.plugin.RegisteredServiceProvider;

/**
 * Vault 经济后端实现。
 *
 * <p><b>这个类只会被反射加载</b>（见 {@link VaultHook}）：它直接引用了
 * {@code net.milkbowl.vault.economy.Economy}。没装 Vault 的服务端上
 * 加载这个类会直接 {@code NoClassDefFoundError}，所以调用方必须先探测。
 *
 * <p>Vault API 极稳定（十年没破坏性变更），所以这里用编译期直接调用而不是全反射；
 * 稳定性由「探测不通过就不加载这个类」保证。
 *
 * <p>所有方法都在主线程调用（RPC 走 MainThreadExecutor）——
 * 部分经济插件要求主线程，这是最安全的做法。
 */
public final class VaultEcoBridge implements EcoBridge {

    private final Economy economy;
    private final String currency;

    public VaultEcoBridge() {
        RegisteredServiceProvider<Economy> registration =
                Bukkit.getServicesManager().getRegistration(Economy.class);
        if (registration == null || registration.getProvider() == null) {
            throw new IllegalStateException("Vault 已加载，但没有注册 Economy 服务"
                    + "（多半是没装经济插件，或经济插件还没启用）");
        }
        this.economy = registration.getProvider();
        if (!economy.isEnabled()) {
            throw new IllegalStateException("经济后端 " + economy.getName() + " 处于未启用状态");
        }
        this.currency = resolveCurrency(economy);
    }

    private static String resolveCurrency(Economy economy) {
        // 不编造「金币」这种名字：后端说是什么就是什么，实在没有就用 coins。
        String plural = safe(economy.currencyNamePlural());
        if (!plural.isEmpty()) {
            return plural;
        }
        String singular = safe(economy.currencyNameSingular());
        return singular.isEmpty() ? "coins" : singular;
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    @Override
    public String name() {
        String name = safe(economy.getName());
        return name.isEmpty() ? "Vault" : name;
    }

    @Override
    public String currency() {
        return currency;
    }

    @Override
    public double balance(UUID uuid, String name) {
        OfflinePlayer player = player(uuid, name);
        ensureAccount(player);
        try {
            return economy.getBalance(player);
        } catch (Throwable t) {
            throw new AgentException(ErrorCode.INTERNAL,
                    "读取余额失败（" + name() + "）: " + t.getMessage());
        }
    }

    @Override
    public double deposit(UUID uuid, String name, double amount) {
        OfflinePlayer player = player(uuid, name);
        ensureAccount(player);
        EconomyResponse response;
        try {
            response = economy.depositPlayer(player, amount);
        } catch (Throwable t) {
            throw new AgentException(ErrorCode.INTERNAL,
                    "入账失败（" + name() + "）: " + t.getMessage());
        }
        check(response, "入账");
        // 余额从后端重新读，不信返回值里的 balance 之外的任何东西。
        return balance(uuid, name);
    }

    @Override
    public double withdraw(UUID uuid, String name, double amount) {
        OfflinePlayer player = player(uuid, name);
        ensureAccount(player);
        EconomyResponse response;
        try {
            response = economy.withdrawPlayer(player, amount);
        } catch (Throwable t) {
            throw new AgentException(ErrorCode.INTERNAL,
                    "出账失败（" + name() + "）: " + t.getMessage());
        }
        check(response, "出账");
        return balance(uuid, name);
    }

    private void check(EconomyResponse response, String action) {
        if (response == null) {
            throw new AgentException(ErrorCode.INTERNAL, action + "失败：经济后端没有返回结果");
        }
        if (!response.transactionSuccess()) {
            throw new AgentException(ErrorCode.INTERNAL, action + "被经济后端拒绝："
                    + Text.nvl(response.errorMessage));
        }
    }

    private OfflinePlayer player(UUID uuid, String name) {
        if (uuid == null) {
            throw new AgentException(ErrorCode.INVALID_PARAMS, "缺少 uuid");
        }
        return Bukkit.getOfflinePlayer(uuid);
    }

    /** 账户不存在就先建一个；建不出来也不报错（有些后端会自动建）。 */
    private void ensureAccount(OfflinePlayer player) {
        try {
            if (!economy.hasAccount(player)) {
                economy.createPlayerAccount(player);
            }
        } catch (Throwable ignored) {
            // 忽略：接下来的 getBalance/deposit 会给出真实结果或真实错误。
        }
    }
}
