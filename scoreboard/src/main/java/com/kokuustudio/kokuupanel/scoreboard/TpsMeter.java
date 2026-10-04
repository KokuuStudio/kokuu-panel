package com.kokuustudio.kokuupanel.scoreboard;

/**
 * TPS（每秒 tick 数）测量。
 *
 * <h2>为什么不直接问服务端</h2>
 *
 * {@code Server#getTPS()} 在 1.16.1 才加进 API，而本插件要能跑在 1.12.2 上
 * （那正是 pom 钉住 1.12.2 的原因）。绕这个限制有三个办法，选了第三个：
 *
 * <ol>
 *   <li>反射调用 {@code getTPS()} —— 1.12.2 上根本没有，只能一直走降级路径，
 *       等于白写；</li>
 *   <li>读 {@code Bukkit.spigot()} —— 1.12.2 的 {@code Server.Spigot} 里
 *       只有 {@code getConfig/broadcast/restart}，也没有；</li>
 *   <li><b>自己量</b> —— 每 tick 记一次时间，用最近 N 个间隔算平均。</li>
 * </ol>
 *
 * 自己量的好处是**在所有版本上语义一致**，坏处是它反映的是「本插件被调度到的
 * 节奏」而不是服务端内核自报的 TPS。两者在主线程拥塞时一致；
 * 内核自报值会额外做平滑，所以本类的读数会比它**更跳一点** ——
 * 对「看一眼服务器卡不卡」这个用途，这反而更真实。
 *
 * <p>窗口取 1200 tick（约 60 秒）：太短会被单个卡顿带飞，太长则反应迟钝。
 */
final class TpsMeter {

    private static final int WINDOW_TICKS = 1200;

    /** 单个 tick 的期望时长（毫秒）。20 TPS。 */
    private static final long EXPECTED_TICK_NANOS = 50_000_000L;

    private final long[] intervals = new long[WINDOW_TICKS];

    private int cursor;
    private int filled;
    private long lastNanos;

    /**
     * 记录一次 tick。由每 tick 跑一次的任务调用。
     *
     * 第一次调用只记起点（没有「上一个 tick」可减），所以不产生样本。
     */
    void tick() {
        long now = System.nanoTime();
        if (lastNanos != 0L) {
            intervals[cursor] = now - lastNanos;
            cursor = (cursor + 1) % WINDOW_TICKS;
            if (filled < WINDOW_TICKS) {
                filled++;
            }
        }
        lastNanos = now;
    }

    /**
     * 当前 TPS，一位小数由调用方格式化。
     *
     * 还没攒够样本时返回 20.0 —— 插件刚启动的那一两秒报 0 或 NaN 只会让人
     * 以为出问题了。上限也压在 20：服务端不会「超过」20 TPS，
     * 但调度抖动会让测出来的平均值偶尔高于 20，那是个假的惊喜。
     */
    double tps() {
        if (filled == 0) {
            return 20.0D;
        }

        long sum = 0L;
        for (int i = 0; i < filled; i++) {
            sum += intervals[i];
        }
        if (sum <= 0L) {
            return 20.0D;
        }

        double seconds = sum / 1_000_000_000D;
        double measured = filled / seconds;
        return Math.min(20.0D, measured);
    }

    /** 单个 tick 平均耗时（毫秒）。给将来的调试输出用。 */
    double averageTickMillis() {
        if (filled == 0) return 0D;
        long sum = 0L;
        for (int i = 0; i < filled; i++) {
            sum += intervals[i];
        }
        return filled == 0 ? 0D : (sum / (double) filled) / 1_000_000D;
    }
}
