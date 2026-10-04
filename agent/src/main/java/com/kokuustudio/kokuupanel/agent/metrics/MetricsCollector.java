package com.kokuustudio.kokuupanel.agent.metrics;

import com.kokuustudio.kokuupanel.agent.AgentConfig;
import com.kokuustudio.kokuupanel.agent.model.Metrics;
import java.lang.management.ManagementFactory;
import org.bukkit.Bukkit;
import org.bukkit.World;

/**
 * 采集 {@code Metrics}（协议 §5.1）。
 *
 * <p>TPS / MSPT 的取值顺序：
 * <ol>
 *   <li>Paper 的 {@code getTPS()} / {@code getAverageTickTime()}（真实读数）</li>
 *   <li>tick 计数降级实现（也是真实读数，见 {@link TickCounter}）</li>
 *   <li>都拿不到 → <b>null</b>。绝不填 20.0。</li>
 * </ol>
 *
 * <p>注意：这个类只能在主线程调用（世界/实体 API 不是线程安全的）。
 */
public final class MetricsCollector {

    private final long startMillis = System.currentTimeMillis();
    private final TickCounter tickCounter = new TickCounter();
    private volatile AgentConfig config;

    public MetricsCollector(AgentConfig config) {
        this.config = config;
    }

    public void setConfig(AgentConfig config) {
        this.config = config;
    }

    public TickCounter tickCounter() {
        return tickCounter;
    }

    public Metrics collect() {
        AgentConfig current = config;
        Metrics metrics = new Metrics();
        metrics.online = Bukkit.getOnlinePlayers().size();
        metrics.maxPlayers = Bukkit.getMaxPlayers();

        metrics.tps = resolveTps(current);
        metrics.mspt = resolveMspt(current);

        Runtime runtime = Runtime.getRuntime();
        long max = runtime.maxMemory();
        long used = runtime.totalMemory() - runtime.freeMemory();
        // free 用 max-used：平台侧展示的是「已用 / 上限」，free 跟着上限走才自洽。
        metrics.memory = new Metrics.Memory(used, max, Math.max(0L, max - used));

        metrics.threads = threadCount();
        metrics.uptimeSeconds = uptimeSeconds();

        int entities = 0;
        int chunks = 0;
        for (World world : Bukkit.getWorlds()) {
            entities += world.getEntities().size();
            chunks += world.getLoadedChunks().length;
        }
        metrics.entities = entities;
        metrics.chunks = chunks;
        return metrics;
    }

    private double[] resolveTps(AgentConfig current) {
        double[] paper = PaperMetricsProbe.tps();
        if (paper != null) {
            return paper;
        }
        if (current == null || current.tickCounterFallback) {
            return tickCounter.tpsTriplet();
        }
        return null;
    }

    private Double resolveMspt(AgentConfig current) {
        Double paper = PaperMetricsProbe.mspt();
        if (paper != null) {
            return paper;
        }
        if (current == null || current.tickCounterFallback) {
            return tickCounter.mspt();
        }
        return null;
    }

    private long uptimeSeconds() {
        return (System.currentTimeMillis() - startMillis) / 1000L;
    }

    private int threadCount() {
        try {
            return ManagementFactory.getThreadMXBean().getThreadCount();
        } catch (Throwable t) {
            // JMX 被裁掉的极简 JRE 上兜底。
            return Thread.activeCount();
        }
    }
}
