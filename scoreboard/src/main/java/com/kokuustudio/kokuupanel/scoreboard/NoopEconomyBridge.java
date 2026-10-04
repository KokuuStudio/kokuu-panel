package com.kokuustudio.kokuupanel.scoreboard;

import java.text.NumberFormat;
import java.util.Locale;

import org.bukkit.entity.Player;

/**
 * 没有经济后端时用的空实现。
 *
 * 它存在的意义不是「凑数」，而是让**没有 Vault 的服也能正常用记分牌** ——
 * 只有余额那一行会显示成占位文案，其它行照常。
 *
 * 注意 {@link #format} 仍然给出带千分位的数字：调用方只在
 * {@link #available()} 为 true 时才会用到它，但让降级路径也保持合理输出，
 * 免得将来有人改调用顺序时拿到一个像是坏掉的字符串。
 */
final class NoopEconomyBridge implements EconomyBridge {

    @Override
    public boolean available() {
        return false;
    }

    @Override
    public double balance(Player player) {
        return 0D;
    }

    @Override
    public String currencyName(Player player) {
        return "";
    }

    @Override
    public String format(Player player, double amount) {
        return NumberFormat.getNumberInstance(Locale.US).format(Math.round(amount));
    }
}
