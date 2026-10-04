package com.kokuustudio.kokuupanel.agent.hooks;

import java.util.UUID;

/**
 * 经济后端的抽象。实现类才引用 Vault 的类型。
 *
 * <p>抽这一层的唯一目的是让「没装 Vault」和「装了 Vault 但没有经济插件」
 * 两种情况都能被**运行时探测**到，而不是抛出 {@code NoClassDefFoundError}。
 */
public interface EcoBridge {

    /** 经济插件名，用于日志与 {@code backend} 描述。 */
    String name();

    /** 货币名（Vault 的复数名优先）。 */
    String currency();

    double balance(UUID uuid, String name);

    /** 入账，返回交易后的余额（从后端重新读）。 */
    double deposit(UUID uuid, String name, double amount);

    /** 出账，返回交易后的余额（从后端重新读）。 */
    double withdraw(UUID uuid, String name, double amount);
}
