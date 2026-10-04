package io.github.kokuustudio.exchange;

import org.bukkit.Bukkit;
import org.bukkit.OfflinePlayer;
import org.bukkit.entity.Player;
import org.bukkit.plugin.RegisteredServiceProvider;

import java.lang.reflect.Method;
import java.util.UUID;

/**
 * PlayerPoints（点券）的适配层。
 *
 * <p>★ 为什么全反射、且要同时兼容两代 API —— 这是本类存在的全部理由：
 *
 * <pre>
 *   PlayerPoints 2.x / 3.2.x :  api.look(String 玩家名)
 *   PlayerPoints 3.3.x      :  api.look(UUID 玩家)
 * </pre>
 *
 * 3.3.0 起把 PlayerPointsAPI 全部方法从 String 改成了 UUID。
 * 我们若按 3.3.x 签名编译，插件在 3.2.x 服务器上会
 * {@code NoSuchMethodError}；反之亦然。所以两种签名都探测，
 * 用哪个由运行时决定 —— 构建期不对任何一版产生硬依赖。
 *
 * <p>⚠️ 与 {@link EconomyHook} 同理：PlayerPoints 不在 Maven 中央仓库，
 * 且服务器可能没装（测试服/空服）。直接 import 会让插件在没装它的
 * 服务器上加载即崩。反射保证「没装时插件照常加载，只是点券功能不可用」。
 *
 * <p>★ 另有 2.x 时代的老 API {@code PlayerPoints.getAPI().look(String)}
 * 但插件主类上取实例的方式也变了（3.x 需要
 * {@code Bukkit.getServicesManager().getRegistration} 或直接
 * {@code getPlugin("PlayerPoints")}），这里优先走 ServicesManager，
 * 拿不到再退回 getPlugin 强转。
 */
public final class PointsHook {

    private static final String PP_API = "org.black_ixx.playerpoints.PlayerPointsAPI";

    private Object api;
    private Method mLook, mGive, mTake, mSet;
    /** true = 3.3.x 的 UUID 签名；false = 2.x/3.2.x 的 String 签名 */
    private boolean uuidStyle = false;
    private String resolvedClass;
    private String lastError;

    private PointsHook() { }

    public static PointsHook bind() {
        PointsHook h = new PointsHook();

        // 路径 A：ServicesManager（3.x 推荐）
        Object plugin = null;
        try {
            Class<?> apiIface = Class.forName(PP_API);
            RegisteredServiceProvider<?> rsp =
                    Bukkit.getServicesManager().getRegistration((Class) apiIface);
            if (rsp != null) plugin = rsp.getProvider();
        } catch (Throwable ignored) {
            // 没装 PlayerPoints，或版本太老没有这个接口 —— 走路径 B
        }

        // 路径 B：直接从插件管理器取主类实例
        if (plugin == null) {
            try {
                plugin = Bukkit.getPluginManager().getPlugin("PlayerPoints");
            } catch (Throwable t) {
                h.lastError = "取 PlayerPoints 实例失败：" + t;
                return h;
            }
        }
        if (plugin == null) {
            h.lastError = "未安装 PlayerPoints（或未启用）";
            return h;
        }

        h.resolvedClass = plugin.getClass().getName();

        // 3.3.x：getAPI() 在主类上；部分版本改名为 getAPI() 返回值同类型
        Object api;
        try {
            Method getApi = plugin.getClass().getMethod("getAPI");
            api = getApi.invoke(plugin);
        } catch (Throwable t) {
            h.lastError = h.resolvedClass + " 没有可用的 getAPI()："
                    + t.getClass().getSimpleName();
            return h;
        }
        if (api == null) {
            h.lastError = h.resolvedClass + ".getAPI() 返回 null";
            return h;
        }
        h.api = api;

        // ★ 关键：先按 3.3.x 的 UUID 签名试，失败再退 2.x/3.2.x 的 String 签名。
        //   顺序不能反 —— 两个签名的方法名相同，getMethod 只会返回其中之一，
        //   必须用「参数类型」区分，不能只按名字取。
        if (h.tryBind(UUID.class)) {
            h.uuidStyle = true;
        } else if (h.tryBind(String.class)) {
            h.uuidStyle = false;
        } else {
            h.lastError = h.resolvedClass
                    + " 的 PlayerPointsAPI 没有可识别的 look/give/take 方法"
                    + "（试过 UUID 与 String 两种签名）";
            h.api = null;
            return h;
        }
        return h;
    }

    /** 按给定的「玩家标识类型」绑定一组方法。成功返回 true。 */
    private boolean tryBind(Class<?> idType) {
        try {
            Class<?> apiIface = Class.forName(PP_API);
            Method look = apiIface.getMethod("look", idType);
            Method give = apiIface.getMethod("give", idType, int.class);
            Method take = apiIface.getMethod("take", idType, int.class);
            // set 是可选的，3.2.x 早期没有
            Method set;
            try {
                set = apiIface.getMethod("set", idType, int.class);
            } catch (Throwable ignored) {
                set = null;
            }
            this.mLook = look;
            this.mGive = give;
            this.mTake = take;
            this.mSet = set;
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    public boolean available() { return api != null && mLook != null; }
    public String lastError() { return lastError; }
    public String resolvedClass() { return resolvedClass; }
    public boolean uuidStyle() { return uuidStyle; }

    public String describeMethods() {
        if (!available()) return "（未绑定）";
        return "PlayerPoints " + (uuidStyle ? "3.3.x UUID 签名" : "2.x/3.2.x String 签名")
                + " → " + resolvedClass
                + "  look=" + (mLook != null) + " give=" + (mGive != null)
                + " take=" + (mTake != null) + " set=" + (mSet != null);
    }

    /** 把玩家名解析成当前 API 风格所需的标识参数。 */
    private Object ident(String playerName) {
        if (!uuidStyle) return playerName;      // 2.x/3.2.x 直接传名字
        // 3.3.x 要 UUID。取不到就返回 null，由调用方转成失败原因 ——
        // 绝不能把 null 丢给反射，那样抛的是 InvocationTargetException，
        // 报错信息完全看不出真实原因。
        OfflinePlayer off = resolve(playerName);
        if (off == null) return null;
        return off.getUniqueId();
    }

    private OfflinePlayer resolve(String name) {
        Player online = Bukkit.getPlayerExact(name);
        if (online != null) return online;
        OfflinePlayer known = Bukkit.getOfflinePlayer(name);
        if (known != null && (known.hasPlayedBefore() || known.isOnline())) return known;
        return null;
    }

    /** 查点券余额。失败返回 null。 */
    public Integer look(String playerName) {
        if (!available()) return null;
        try {
            Object id = ident(playerName);
            if (id == null) return null;
            return (Integer) mLook.invoke(api, id);
        } catch (Throwable e) {
            return null;
        }
    }

    /**
     * 加点券。
     *
     * @return null 成功；否则为失败原因（可直接展示给玩家）
     */
    public String give(String playerName, int amount) {
        if (!available()) return "点券功能不可用：" + lastError;
        if (amount <= 0) return "发放数量非法：" + amount;
        try {
            Object id = ident(playerName);
            if (id == null) return "找不到玩家「" + playerName + "」";
            Object ok = mGive.invoke(api, id, amount);
            // ★ 必须检查返回值：PlayerPoints 的 give 在事件被取消、
            //   或底层数据库写失败时返回 false，不检查会「以为发成功了」。
            return Boolean.TRUE.equals(ok) ? null : "PlayerPoints 拒绝了本次发放（事件被取消或写入失败）";
        } catch (Throwable e) {
            Throwable c = e.getCause() != null ? e.getCause() : e;
            return "发放点券失败：" + c.getClass().getSimpleName()
                    + (c.getMessage() == null ? "" : " — " + truncate(c.getMessage(), 140));
        }
    }

    /**
     * 扣点券。
     *
     * @return null 成功；否则为失败原因
     */
    public String take(String playerName, int amount) {
        if (!available()) return "点券功能不可用：" + lastError;
        if (amount <= 0) return "扣除数量非法：" + amount;
        try {
            Object id = ident(playerName);
            if (id == null) return "找不到玩家「" + playerName + "」";
            Object ok = mTake.invoke(api, id, amount);
            return Boolean.TRUE.equals(ok) ? null : "点券余额不足或扣除被拒绝";
        } catch (Throwable e) {
            Throwable c = e.getCause() != null ? e.getCause() : e;
            return "扣除点券失败：" + c.getClass().getSimpleName()
                    + (c.getMessage() == null ? "" : " — " + truncate(c.getMessage(), 140));
        }
    }

    /**
     * 直接设定余额（管理台用）。
     *
     * <p>⚠️ 这不是「增减」而是「覆盖」，破坏账本可加性 ——
     * 中间件下发时必须用 delta（give/take），不要用 set。
     * 保留它只为兼容没有 give/take 的老版本兜底。
     *
     * @return null 成功；否则为失败原因
     */
    public String set(String playerName, int amount) {
        if (!available()) return "点券功能不可用：" + lastError;
        if (mSet == null) return "该 PlayerPoints 版本没有 set 方法，请改用加减";
        try {
            Object id = ident(playerName);
            if (id == null) return "找不到玩家「" + playerName + "」";
            Object ok = mSet.invoke(api, id, amount);
            return Boolean.TRUE.equals(ok) ? null : "PlayerPoints 拒绝了本次设定";
        } catch (Throwable e) {
            Throwable c = e.getCause() != null ? e.getCause() : e;
            return "设定点券失败：" + c.getClass().getSimpleName()
                    + (c.getMessage() == null ? "" : " — " + truncate(c.getMessage(), 140));
        }
    }

    private static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }
}
