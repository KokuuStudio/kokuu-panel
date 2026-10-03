package io.github.kokuustudio.exchange;

import org.bukkit.Bukkit;
import org.bukkit.OfflinePlayer;
import org.bukkit.entity.Player;
import org.bukkit.plugin.RegisteredServiceProvider;

import java.lang.reflect.Method;
import java.util.UUID;

/**
 * 经济插件的适配层。
 *
 * <p>⚠️ 为什么用反射而��直接 compileOnly 依赖经济插件的 API：
 * <ol>
 *   <li>CMI 是商业插件，不在 Maven 中央仓库，构建机上不一定有 jar；</li>
 *   <li>服务器可能装了也可能没装（测试服/空服）——
 *       直接 import 会让插件在「没装该插件」的服务器上加载即崩，
 *       连带整个插件不可用。反射可以做到「没装时插件照常加载，只是发放不可用」。</li>
 * </ol>
 *
 * <h3>★ 两条绑定路径（顺序即优先级）</h3>
 * <pre>
 *   路径 A：Vault API（首选）
 *     Bukkit.getServicesManager().getRegistration(Economy.class).getProvider()
 *     → 拿到 com.Zrips.Economy_CMI 实例（它 extends Vault 的 AbstractEconomy）
 *     → 调 depositPlayer(OfflinePlayer, double) / getBalance(OfflinePlayer)
 *
 *   路径 B：静态单例（回退）
 *     Class.forName(候选类名).getMethod("getInstance").invoke(null)
 *     → 调 deposit(玩家, 金额)
 * </pre>
 *
 * <p><b>为什么必须有路径 A</b>：CMI 9.8.x 起把经济功能拆到了独立的
 * {@code CMIEInjector} 插件里，类名是 {@code com.Zrips.Economy_CMI}，
 * 它 {@code extends net.milkbowl.vault.economy.AbstractEconomy}，
 * 实例由 <b>Vault 的 ServicesManager</b> 反射创建并持有 ——
 * <b>没有 {@code getInstance()} 静态方法</b>，只有 {@code Economy_CMI(Plugin)} 构造器。
 * 所以只认静态单例的实现对现代 CMI 完全失效。
 * Vault 是几乎所有经济插件（Cmi/EssentialsX/…）的通用适配层，走它最稳。
 *
 * <p>★ 两条路径都失败时，{@link #available()} 为 false，
 * 插件仍正常加载，只是发放会失败并退款（不会崩服）。
 *
 * <p>★ 主流经济插件大多没有 HTTP/REST 接口 —— 这是整个模块选 Redis 队列的根本原因：
 * 发放动作只能由 MC 服务端的 Java 代码执行。
 */
public final class EconomyHook {

    /** Vault 经济接口的全限定名（服务器没装 Vault 时这个 Class 就不存在）。 */
    private static final String VAULT_ECONOMY = "net.milkbowl.vault.economy.Economy";

    /**
     * 静态单例路径的候选类名（新→旧）。
     * <p>仅作回退；现代 CMI 走 Vault 路径，详见类注释。
     */
    public static final String[] ECON_CLASSES = {
            "com.Zrips.Economy_CMI",           // CMI 9.8.x（CMIEInjector 提供，走 Vault）
            "net.Zrips.ECO.CMI.CMI_Economy",   // 早期 CMI ECO
    };

    /** 绑定方式，用于 status 展示与排查 */
    public enum Mode {
        VAULT("Vault API"),
        STATIC_SINGLETON("静态单例"),
        NONE("未绑定");

        private final String label;

        Mode(String label) { this.label = label; }

        public String label() { return label; }
    }

    private Mode mode = Mode.NONE;
    private Object ecoInstance;

    // ── Vault 路径的方法签名（Economy 接口）──────────────────────────
    private Method vaultDepositOffline;   // depositPlayer(OfflinePlayer, double) -> EconomyResponse
    private Method vaultDepositName;      // depositPlayer(String, double) -> EconomyResponse
    private Method vaultBalanceOffline;   // getBalance(OfflinePlayer) -> double
    private Method vaultHasOffline;       // has(OfflinePlayer, double) -> boolean
    private Method respTransactionSuccess; // EconomyResponse.transactionSuccess() -> boolean
    private Method respErrorMessage;       // EconomyResponse.errorMessage -> String (getter)

    // ── 静态单例路径的方法签名 ────────────────────────────────────────
    private Method depositPlayer;
    private Method depositOffline;
    private Method depositName;
    private Method getBalance;

    private String resolvedClass;
    private String lastError;

    private EconomyHook() { }

    /**
     * 尝试绑定经济插件 API。应在插件启用时调用一次。
     *
     * @param cfg 提供候选类名列表（可为空，此时用 {@link #ECON_CLASSES}）
     * @return 一个 Hook；{@link #available()} 为 false 表示没绑上
     */
    public static EconomyHook bind(BridgeConfig cfg) {
        EconomyHook h = new EconomyHook();

        // 路径 A：Vault（优先）
        if (h.bindVault()) {
            return h;
        }
        String vaultErr = h.lastError;

        // 路径 B：静态单例（回退）
        String[] candidates = (cfg == null || cfg.economyClassNames.isEmpty())
                ? ECON_CLASSES
                : cfg.economyClassNames.toArray(new String[0]);

        for (String cn : candidates) {
            if (cn == null || cn.trim().isEmpty()) {
                continue;
            }
            cn = cn.trim();
            try {
                Class<?> cls = Class.forName(cn);
                Method get = cls.getMethod("getInstance");
                Object inst = get.invoke(null);
                if (inst == null) {
                    h.lastError = cn + ".getInstance() 返回了 null";
                    continue;
                }

                h.ecoInstance = inst;
                h.mode = Mode.STATIC_SINGLETON;
                h.resolvedClass = cn;

                h.depositPlayer = tryMethod(cls, "deposit", Player.class, double.class);
                h.depositOffline = tryMethod(cls, "deposit", OfflinePlayer.class, double.class);
                h.depositName = tryMethod(cls, "deposit", String.class, double.class);
                h.getBalance = tryMethod(cls, "getBalance", Player.class);

                if (h.depositPlayer == null && h.depositOffline == null && h.depositName == null) {
                    h.lastError = cn + " 找到了，但没有 deposit(Player|OfflinePlayer|String, double) 方法";
                    h.ecoInstance = null;
                    h.mode = Mode.NONE;
                    h.resolvedClass = null;
                    continue;
                }
                return h;
            } catch (ClassNotFoundException ignored) {
                // 试下一个候选类名
            } catch (Exception e) {
                h.lastError = cn + " 初始化失败：" + e.getClass().getSimpleName()
                        + (e.getMessage() == null ? "" : " — " + e.getMessage());
            }
        }

        if (h.lastError == null) {
            h.lastError = "未找到经济插件的经济类（试过 " + String.join("、", candidates) + "）";
        } else {
            h.lastError = "Vault 路径：" + vaultErr + "；静态单例路径：" + h.lastError;
        }
        return h;
    }

    /**
     * 路径 A：通过 Vault 的 ServicesManager 拿经济实例。
     *
     * <p>全反射实现（连 {@code Economy} 接口本身都用 {@code Class.forName} 取），
     * 这样构建期完全不需要 Vault 的 jar —— 服上没装 Vault 也不会 {@code NoClassDefFoundError}。
     *
     * @return true 表示绑定成功
     */
    private boolean bindVault() {
        try {
            Class<?> ecoIface = Class.forName(VAULT_ECONOMY);
            RegisteredServiceProvider<?> rsp =
                    Bukkit.getServicesManager().getRegistration((Class) ecoIface);
            if (rsp == null) {
                lastError = "Vault 已加载但没有已注册的经济提供者"
                        + "（经济插件可能没启动成功，或它不提供 Vault 适配）";
                return false;
            }

            Object provider = rsp.getProvider();
            if (provider == null) {
                lastError = "Vault 返回了空的 provider";
                return false;
            }

            Class<?> pc = provider.getClass();

            // Vault Economy 接口的标准方法。声明在接口上，用接口 Class 取更稳
            // （实现类可能桥接/继承，getMethod 也能拿到 public 方法，但接口更明确）
            vaultDepositOffline = tryMethod(ecoIface, "depositPlayer", OfflinePlayer.class, double.class);
            vaultDepositName = tryMethod(ecoIface, "depositPlayer", String.class, double.class);
            vaultBalanceOffline = tryMethod(ecoIface, "getBalance", OfflinePlayer.class);
            vaultHasOffline = tryMethod(ecoIface, "has", OfflinePlayer.class, double.class);

            // EconomyResponse：必须检查 transactionSuccess()，
            // 否则「余额不足」「跨服失败」也会被当成成功 —— 扣了积分却没到账。
            // 它的 Class 从返回类型拿：depositPlayer 的返回值就是 EconomyResponse。
            Class<?> respCls = resolveResponseClass(vaultDepositOffline, vaultDepositName);
            if (respCls != null) {
                respTransactionSuccess = tryMethod(respCls, "transactionSuccess");
                respErrorMessage = tryMethod(respCls, "errorMessage");
            }

            if (vaultDepositOffline == null && vaultDepositName == null) {
                lastError = "Vault 绑到了 " + pc.getName() + "，但它没有 depositPlayer 方法";
                ecoInstance = null;
                return false;
            }

            ecoInstance = provider;
            mode = Mode.VAULT;
            resolvedClass = pc.getName();
            return true;
        } catch (ClassNotFoundException e) {
            lastError = "未安装 Vault（找不到 " + VAULT_ECONOMY + "）";
            return false;
        } catch (Throwable t) {
            // 反射链上任何一环炸了都不能让插件加载失败
            lastError = "Vault 反射失败：" + t.getClass().getSimpleName()
                    + (t.getMessage() == null ? "" : " — " + t.getMessage());
            ecoInstance = null;
            mode = Mode.NONE;
            return false;
        }
    }

    /** 从 deposit 方法的返回值类型推出 EconomyResponse 的 Class（拿不到返回 null） */
    private static Class<?> resolveResponseClass(Method... deposits) {
        for (Method m : deposits) {
            if (m == null) continue;
            Class<?> rt = m.getReturnType();
            // 声明返回值就是接口 EconomyResponse，最直接
            if (rt != null && rt.getSimpleName().equals("EconomyResponse")) {
                return rt;
            }
        }
        return null;
    }

    private static Method tryMethod(Class<?> cls, String name, Class<?>... params) {
        try {
            return cls.getMethod(name, params);
        } catch (Throwable e) {
            return null;
        }
    }

    public boolean available() {
        return ecoInstance != null;
    }

    public Mode mode() {
        return mode;
    }

    public String resolvedClass() {
        return resolvedClass;
    }

    public String lastError() {
        return lastError;
    }

    /** 当前绑定了哪些重载，用于 status 展示 */
    public String describeMethods() {
        if (!available()) return "（未绑定）";
        if (mode == Mode.VAULT) {
            return "Vault depositPlayer(OfflinePlayer)=" + (vaultDepositOffline != null)
                    + " depositPlayer(String)=" + (vaultDepositName != null)
                    + " has=" + (vaultHasOffline != null);
        }
        return "deposit(Player)=" + (depositPlayer != null)
                + " deposit(OfflinePlayer)=" + (depositOffline != null)
                + " deposit(String)=" + (depositName != null);
    }

    /**
     * 给玩家发货币。
     *
     * <p>★ 必须在**主线程**调用 —— Bukkit 的实体/玩家 API 不是线程安全的，
     * 而队列消费跑在异步线程上，所以由 {@link ExchangeWorker} 切回主线程执行。
     *
     * @return null 表示成功；非 null 为失败原因（已截断到 180 字，可直接展示给玩家）
     */
    public String deposit(String playerName, int units) {
        if (!available()) {
            return "服务器未启用经济插件，无法发放：" + lastError;
        }
        if (units <= 0) {
            return "发放数量非法：" + units;
        }

        // 优先按名字拿离线玩家：货币是账号级的，
        // 玩家不在线也必须能发 —— 这是「直连发放」体验的前提。
        OfflinePlayer offline = resolveOffline(playerName);
        if (offline == null) {
            return "找不到叫「" + playerName + "」的玩家（可能从未上线过）";
        }

        double amount = units;

        if (mode == Mode.VAULT) {
            return depositViaVault(playerName, offline, amount);
        }
        return depositViaSingleton(playerName, offline, amount);
    }

    /** 路径 A：走 Vault Economy API */
    private String depositViaVault(String playerName, OfflinePlayer offline, double amount) {
        try {
            Object resp;
            if (vaultDepositOffline != null) {
                resp = vaultDepositOffline.invoke(ecoInstance, offline, amount);
            } else if (vaultDepositName != null) {
                resp = vaultDepositName.invoke(ecoInstance, playerName, amount);
            } else {
                return "经济插件版本不兼容：Vault 接口没有 depositPlayer（" + describeMethods() + "）";
            }

            // ★ 必须检查返回的 EconomyResponse —— 它是 Vault 报告失败的唯一途径
            String err = checkResponse(resp);
            if (err != null) {
                return err;
            }
            return null;
        } catch (Exception e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            return "发放失败：" + cause.getClass().getSimpleName()
                    + (cause.getMessage() == null ? "" : " — " + truncate(cause.getMessage(), 140));
        }
    }

    /**
     * 检查 Vault 的 EconomyResponse。
     *
     * @return null 表示成功；非 null 为可直接展示给玩家的失败原因
     */
    private String checkResponse(Object resp) {
        if (resp == null) {
            // 没有返回响应对象（理论上不该发生），保守当成功
            return null;
        }
        if (respTransactionSuccess == null) {
            return null;   // 找不到检查手段，不阻塞发放
        }
        try {
            Object ok = respTransactionSuccess.invoke(resp);
            if (Boolean.TRUE.equals(ok)) {
                return null;
            }
            String msg = null;
            if (respErrorMessage != null) {
                try {
                    Object m = respErrorMessage.invoke(resp);
                    if (m != null) {
                        msg = String.valueOf(m);
                    }
                } catch (Exception ignored) {
                    // 取不到 message 就用兜底文案
                }
            }
            return "经济插件拒绝了本次发放"
                    + (msg == null || msg.isEmpty() ? "" : "：" + truncate(msg, 120));
        } catch (Exception e) {
            return null;   // 检查本身失败，不影响主流程
        }
    }

    /** 路径 B：静态单例的 deposit(玩家, 金额) */
    private String depositViaSingleton(String playerName, OfflinePlayer offline, double amount) {
        try {
            // 优先用 OfflinePlayer 重载 —— 不要求玩家在线
            if (depositOffline != null) {
                depositOffline.invoke(ecoInstance, offline, amount);
                return null;
            }
            // 在线玩家优先用 Player 重载（部分版本对离线玩家处理不同）
            Player online = offline.getPlayer();
            if (online != null && depositPlayer != null) {
                depositPlayer.invoke(ecoInstance, online, amount);
                return null;
            }
            if (depositName != null) {
                depositName.invoke(ecoInstance, playerName, amount);
                return null;
            }
            return "经济插件版本不兼容：没有可用的 deposit 方法（" + describeMethods() + "）";
        } catch (Exception e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            return "发放失败：" + cause.getClass().getSimpleName()
                    + (cause.getMessage() == null ? "" : " — " + truncate(cause.getMessage(), 140));
        }
    }

    /** 查余额，仅用于 status 与问题排查 */
    public String balance(String playerName) {
        if (!available()) return null;
        try {
            if (mode == Mode.VAULT) {
                if (vaultBalanceOffline == null) return null;
                OfflinePlayer off = resolveOffline(playerName);
                if (off == null) return null;
                return String.valueOf(vaultBalanceOffline.invoke(ecoInstance, off));
            }
            if (getBalance == null) return null;
            Player p = Bukkit.getPlayerExact(playerName);
            if (p == null) return null;
            return String.valueOf(getBalance.invoke(ecoInstance, p));
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 找玩家。
     *
     * <p>顺序很重要：先查在线（快、拿到的是真实 Player 对象），
     * 再查已知离线玩家，最后才走「按名字构造 OfflinePlayer」——
     * 最后那步对**从未上线过**的名字会返回一个 UUID 全 0 的假对象，
     * 拿着它调 deposit 可能静默失败。所以必须先确认玩家真的存在。
     *
     * <p>⚠️ 1.12.2 上 {@code getOfflinePlayer(String)} 对未知名字会**阻塞主线程**
     * 去请求 Mojang 的 API（1.16.5 之后改成纯本地查缓存了）。
     * 这在离线模式的服务器上会卡到超时。
     * 所以这里只在「玩家确实有过记录」时才去构造 —— 先 hasPlayedBefore 判定，
     * 而它本身要求先有 OfflinePlayer 对象……
     * <p>折中做法：先看在线，再看 {@link #knownOffline} 里皮肤站传来的离线缓存。
     * 目前皮肤站传的是玩家名，所以最坏情况就是 1.12.2 上的一次 Mojang 查询，
     * 发生在「玩家不在线时兑换」——频率低、可接受，且 1.13+ 完全没有这个问题。
     */
    private OfflinePlayer resolveOffline(String name) {
        Player online = Bukkit.getPlayerExact(name);
        if (online != null) return online;

        OfflinePlayer known = Bukkit.getOfflinePlayer(name);
        if (known != null && (known.hasPlayedBefore() || known.isOnline())) {
            return known;
        }
        return null;
    }

    private static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    /** UUID 形式的备用查找（玩家改过名时有用） */
    public static OfflinePlayer byUuid(UUID uuid) {
        if (uuid == null) return null;
        return Bukkit.getOfflinePlayer(uuid);
    }
}
