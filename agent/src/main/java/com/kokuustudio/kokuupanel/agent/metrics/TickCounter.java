package com.kokuustudio.kokuupanel.agent.metrics;

/**
 * tick 计数降级实现（协议 §5.1 与架构文档 §4.4 要求）。
 *
 * <p>1.12.2 的 Spigot 没有 {@code getTPS()}，标准做法是自己数 tick：
 * 每 tick 跑一次任务，按秒分桶，TPS = 窗口内 tick 数 / 窗口秒数。
 *
 * <p><b>这是真实测量值，不是「编一个 20.0」。</b>区别很关键：
 * 编造的值会让运维看着「一切正常」；数出来的值会如实反映卡服
 * （服务器冻住 3 秒 → 那 3 个桶的 tick 数是 0 → TPS 直接掉下来）。
 *
 * <p>观测不足 {@code MIN_SECONDS} 秒时返回 null —— 刚启动的头几秒
 * 没资格给结论。
 */
public final class TickCounter implements Runnable {

    private static final int MAX_SECONDS = 900; // 15 分钟
    /** 少于这个观测秒数就不给值：数据不够时宁可 null。 */
    private static final int MIN_SECONDS = 10;
    /** 单次 tick 间隔超过这个值多半是 GC/线程挂起，不计入 MSPT 平均。 */
    private static final double MAX_PLAUSIBLE_TICK_MS = 5000.0D;

    private final long[] tickCounts = new long[MAX_SECONDS];
    private final double[] tickMillis = new double[MAX_SECONDS];
    private int writeIndex;
    private int completedSeconds;

    private long currentSecondStartMillis = -1L;
    private long currentTicks;
    private double currentMillis;
    private long lastTickNanos = -1L;
    private long totalTicks;

    @Override
    public void run() {
        long nowNanos = System.nanoTime();
        long nowMillis = System.currentTimeMillis();
        long second = nowMillis / 1000L;

        if (lastTickNanos > 0L) {
            double deltaMs = (nowNanos - lastTickNanos) / 1_000_000.0D;
            if (deltaMs > 0.0D && deltaMs < MAX_PLAUSIBLE_TICK_MS) {
                currentMillis += deltaMs;
            }
        }
        lastTickNanos = nowNanos;

        if (currentSecondStartMillis < 0L) {
            currentSecondStartMillis = second;
        }

        currentTicks++;
        totalTicks++;

        long elapsedSeconds = second - currentSecondStartMillis;
        if (elapsedSeconds > 0) {
            pushBucket(currentTicks, currentMillis);
            // 服务器冻住时中间那几秒一个 tick 都没有 —— 必须补 0 桶，
            // 否则 TPS 会被「跳过的时间」稀释成正常值。
            for (long i = 1; i < elapsedSeconds && i - 1 < MAX_SECONDS; i++) {
                pushBucket(0L, 0.0D);
            }
            currentTicks = 0L;
            currentMillis = 0.0D;
            currentSecondStartMillis = second;
        }
    }

    private void pushBucket(long ticks, double millis) {
        tickCounts[writeIndex] = ticks;
        tickMillis[writeIndex] = millis;
        writeIndex = (writeIndex + 1) % MAX_SECONDS;
        if (completedSeconds < MAX_SECONDS) {
            completedSeconds++;
        }
    }

    public int completedSeconds() {
        return completedSeconds;
    }

    public long totalTicks() {
        return totalTicks;
    }

    /**
     * @param windowSeconds 1m=60 / 5m=300 / 15m=900
     * @return TPS，观测不足时 null
     */
    public Double tps(int windowSeconds) {
        int available = Math.min(completedSeconds, Math.min(windowSeconds, MAX_SECONDS));
        if (available < MIN_SECONDS) {
            return null;
        }
        long ticks = 0L;
        for (int i = 1; i <= available; i++) {
            ticks += tickCounts[index(-i)];
        }
        double value = (double) ticks / (double) available;
        return Double.valueOf(round(value, 2));
    }

    /** [1m,5m,15m]；连 1 分钟的值都没有时返回 null（整个数组）。 */
    public double[] tpsTriplet() {
        Double oneMinute = tps(60);
        if (oneMinute == null) {
            return null;
        }
        Double fiveMinute = tps(300);
        Double fifteenMinute = tps(900);
        return new double[] {
                oneMinute.doubleValue(),
                fiveMinute == null ? oneMinute.doubleValue() : fiveMinute.doubleValue(),
                fifteenMinute == null
                        ? (fiveMinute == null ? oneMinute.doubleValue() : fiveMinute.doubleValue())
                        : fifteenMinute.doubleValue()
        };
    }

    /** 平均 tick 耗时（毫秒），观测不足时 null。 */
    public Double mspt() {
        int available = Math.min(completedSeconds, 60);
        if (available < MIN_SECONDS) {
            return null;
        }
        double millis = 0.0D;
        long ticks = 0L;
        for (int i = 1; i <= available; i++) {
            int index = index(-i);
            millis += tickMillis[index];
            ticks += tickCounts[index];
        }
        if (ticks <= 0L) {
            return null;
        }
        return Double.valueOf(round(millis / (double) ticks, 2));
    }

    private int index(int offsetFromWrite) {
        int index = (writeIndex + offsetFromWrite) % MAX_SECONDS;
        return index < 0 ? index + MAX_SECONDS : index;
    }

    private static double round(double value, int digits) {
        double factor = Math.pow(10.0D, digits);
        return Math.round(value * factor) / factor;
    }
}
