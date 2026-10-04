package com.kokuustudio.kokuupanel.agent.modules;

import com.google.gson.JsonObject;
import com.kokuustudio.kokuupanel.agent.Capabilities;
import com.kokuustudio.kokuupanel.agent.KokuuAgentPlugin;
import com.kokuustudio.kokuupanel.agent.economy.IdempotencyStore;
import com.kokuustudio.kokuupanel.agent.hooks.EcoBridge;
import com.kokuustudio.kokuupanel.agent.hooks.VaultHook;
import com.kokuustudio.kokuupanel.agent.model.SmallModels;
import com.kokuustudio.kokuupanel.agent.rpc.Params;
import com.kokuustudio.kokuupanel.agent.rpc.RpcDispatcher;
import java.util.UUID;
import java.util.concurrent.Callable;

/**
 * 经济方法（协议 §5.6）。走 Vault。
 *
 * <p>{@code economy.adjust} 的 {@code eventId} 是**幂等键**：
 * 重复投递绝不能变成发两遍钱（协议 §5.6 明说）。
 * 幂等逻辑全在 {@link IdempotencyStore} 里，这里只负责参数与主线程调度。
 */
public final class EconomyModule {

    private final KokuuAgentPlugin plugin;
    private final VaultHook vault;
    private final IdempotencyStore idempotency;

    public EconomyModule(KokuuAgentPlugin plugin, VaultHook vault, IdempotencyStore idempotency) {
        this.plugin = plugin;
        this.vault = vault;
        this.idempotency = idempotency;
    }

    public void register(RpcDispatcher dispatcher) {
        dispatcher.register("economy.getBalance", Capabilities.ECONOMY, false, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                return balance(params);
            }
        });
        dispatcher.register("economy.adjust", Capabilities.ECONOMY, true, new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                return adjust(params);
            }
        });
    }

    private Object balance(Params params) {
        final String uuid = params.uuid("uuid");
        String name = params.playerName("name", false);
        params.done();

        final EcoBridge economy = vault.require();
        final UUID playerId = UUID.fromString(uuid);
        double balance = economy.balance(playerId, name);
        return new SmallModels.EconomyBalance(balance, economy.currency(), "vault");
    }

    private Object adjust(Params params) {
        final String uuid = params.uuid("uuid");
        final String name = params.playerName("name", true);
        Double amountValue = params.number("amount", true);
        params.optionalString("note", 200);
        final String eventId = params.string("eventId", true, 128, null, null);
        params.done();

        if (amountValue == null) {
            // 上面的 done() 已经抛了；这里只是让编译器安心。
            throw Params.invalid("amount", "调整数额必填");
        }
        final double amount = amountValue.doubleValue();
        if (amount == 0.0D) {
            // 与 schemas.ts 的 refine 一致：一次「加 0 金币」只会制造审计噪音。
            throw Params.invalid("amount", "调整数额不能为 0");
        }

        final EcoBridge economy = vault.require();
        final UUID playerId = UUID.fromString(uuid);

        IdempotencyStore.Outcome outcome = idempotency.executeIdempotent(eventId, uuid, amount,
                new Callable<Double>() {
                    @Override
                    public Double call() {
                        return Double.valueOf(amount > 0.0D
                                ? economy.deposit(playerId, name, amount)
                                : economy.withdraw(playerId, name, -amount));
                    }
                });

        if (outcome.duplicate) {
            plugin.getLogger().info("经济调整 eventId=" + eventId + " 是重复投递，已跳过执行"
                    + "（余额 " + outcome.balanceAfter + "）");
        }
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("balanceAfter", outcome.balanceAfter);
        // 额外字段（协议未定义）：让平台能区分「真的发了钱」和「重试被幂等挡住」。
        result.addProperty("duplicate", outcome.duplicate);
        return result;
    }
}
