package com.kokuustudio.kokuupanel.scoreboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * TPS 测量。
 *
 * <h2>为什么这个也要测</h2>
 *
 * 它是自己量的（1.12.2 没有 {@code Server#getTPS()}），所以「量的对不对」
 * 完全由这里的算法决定。三个必须成立的边界：
 *
 * <ol>
 *   <li>还没样本时报 20.0 而不是 0 —— 插件刚启动的那一两秒不该显示成卡死；</li>
 *   <li>上限压在 20 —— 调度抖动会让平均值偶尔高于 20，那是个假的惊喜；</li>
 *   <li>真的慢下来时读数要跟着掉。</li>
 * </ol>
 */
class TpsMeterTest {

    @Test
    @DisplayName("还没有样本时报 20.0，不报 0 或 NaN")
    void reportsFullValueBeforeAnySample() {
        TpsMeter meter = new TpsMeter();

        assertEquals(20.0D, meter.tps(), 0.0001D);
        assertEquals(0.0D, meter.averageTickMillis(), 0.0001D);
    }

    @Test
    @DisplayName("只 tick 一次还不构成样本，仍是 20.0")
    void singleTickIsNotASample() {
        TpsMeter meter = new TpsMeter();
        meter.tick();

        assertEquals(20.0D, meter.tps(), 0.0001D);
    }

    @Test
    @DisplayName("调度比 50ms 快时不会报出高于 20 的 TPS")
    void neverReportsAboveTwenty() {
        TpsMeter meter = new TpsMeter();
        // 忙循环：间隔只有微秒级，算出来的「TPS」会是几万 —— 必须被压到 20。
        for (int i = 0; i < 50; i++) {
            meter.tick();
        }

        assertEquals(20.0D, meter.tps(), 0.0001D);
    }

    @Test
    @DisplayName("每 tick 100ms 时读数掉到 10 附近")
    void reportsSlowdowns() throws InterruptedException {
        TpsMeter meter = new TpsMeter();
        for (int i = 0; i < 5; i++) {
            meter.tick();
            Thread.sleep(100L);
        }

        double tps = meter.tps();
        // 给足容差：CI 机器上 sleep 的精度很差，只要求「明显低于 20、又没掉到 0」。
        assertTrue(tps > 5.0D && tps < 15.0D, "期望 10 上下，实际 " + tps);

        double millis = meter.averageTickMillis();
        assertTrue(millis > 50.0D, "平均 tick 耗时应当大于 50ms，实际 " + millis);
    }

    @Test
    @DisplayName("窗口是环形缓冲：样本再多也不会越界")
    void ringBufferWrapsAround() {
        TpsMeter meter = new TpsMeter();
        for (int i = 0; i < 5000; i++) {
            meter.tick();
        }

        double tps = meter.tps();
        assertTrue(tps > 0D && tps <= 20.0D, "绕圈后仍应是合法读数，实际 " + tps);
    }
}
