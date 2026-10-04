package com.kokuustudio.kokuupanel.agent.economy;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import com.kokuustudio.kokuupanel.agent.protocol.AgentException;
import com.kokuustudio.kokuupanel.agent.protocol.ErrorCode;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.io.Writer;
import java.lang.reflect.Type;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * 经济幂等缓存（协议 §5.6）。
 *
 * <p>「{@code eventId} 为幂等键，Agent 必须缓存已处理的 eventId（TTL ≥ 24h）并拒绝重复执行
 * —— 网络重试不能变成发两遍钱。」
 *
 * <p>三种情况分开处理：
 * <ul>
 *   <li><b>同一个 eventId + 同样的 uuid/金额</b>：不重复执行，直接返回第一次的
 *       {@code balanceAfter}（重试返回与原请求相同的结果，这才是幂等的正确语义）。</li>
 *   <li><b>同一个 eventId + 不同的 uuid/金额</b>：真冲突，回 {@code CONFLICT}。</li>
 *   <li>没见过的 eventId：执行，然后记账。</li>
 * </ul>
 *
 * <p>缓存落盘到 {@code plugins/KokuuAgent/idempotency.json}：只放内存的话，
 * 「平台重试 → Agent 正好重启 → 再发一次」就变成发两遍钱。落盘是异步的，
 * 关服时同步刷一次。
 */
public final class IdempotencyStore {

    private static final Charset UTF8 = Charset.forName("UTF-8");

    public static final class Entry {
        public String eventId;
        public String uuid;
        public double amount;
        public double balanceAfter;
        public long ts;
    }

    /** 幂等执行的结果。 */
    public static final class Outcome {
        public final double balanceAfter;
        /** true 表示这次是重复投递，没有真正执行。 */
        public final boolean duplicate;

        Outcome(double balanceAfter, boolean duplicate) {
            this.balanceAfter = balanceAfter;
            this.duplicate = duplicate;
        }
    }

    private static final class FileModel {
        int version = 1;
        List<Entry> events = new ArrayList<Entry>();
    }

    private final Logger logger;
    private final File file;
    private final long ttlMillis;
    private final Gson gson = new GsonBuilder().disableHtmlEscaping().setPrettyPrinting().create();

    private final Map<String, Entry> entries = new LinkedHashMap<String, Entry>();
    private volatile boolean dirty;
    private volatile boolean loaded;

    public IdempotencyStore(Logger logger, File file, int ttlHours) {
        this.logger = logger;
        this.file = file;
        // 协议要求 TTL >= 24h。
        this.ttlMillis = Math.max(24, ttlHours) * 3600_000L;
    }

    /** 启动时读一次。可以在异步线程调用。 */
    public synchronized void load() {
        loaded = true;
        if (file == null || !file.isFile()) {
            return;
        }
        Reader reader = null;
        try {
            reader = new InputStreamReader(new FileInputStream(file), UTF8);
            Type type = new TypeToken<FileModel>() { }.getType();
            FileModel model = gson.fromJson(reader, type);
            if (model != null && model.events != null) {
                long now = System.currentTimeMillis();
                for (Entry entry : model.events) {
                    if (entry != null && entry.eventId != null && now - entry.ts <= ttlMillis) {
                        entries.put(entry.eventId, entry);
                    }
                }
            }
            logger.info("经济幂等缓存已载入 " + entries.size() + " 条（TTL "
                    + (ttlMillis / 3600_000L) + "h）");
        } catch (Throwable t) {
            // 缓存坏了不能让插件起不来：最坏情况是重试可能重复发钱，
            // 但那也比整个节点连不上平台好。如实记 ERROR。
            logger.log(Level.SEVERE, "经济幂等缓存读取失败（已忽略，注意重复投递风险）: " + file, t);
            entries.clear();
        } finally {
            closeQuietly(reader);
        }
    }

    public boolean isLoaded() {
        return loaded;
    }

    /**
     * 幂等执行一次经济调整。
     *
     * <p>整个「查 → 执行 → 记账」在同一把锁里完成。RPC 处理本身在主线程上是串行的，
     * 加锁是为了防住将来第二个调用方（例如 exchange-bridge 的队列路径）并发进来。
     */
    public Outcome executeIdempotent(String eventId, String uuid, double amount,
                                     Callable<Double> action) {
        synchronized (this) {
            prune();
            Entry existing = entries.get(eventId);
            if (existing != null) {
                boolean sameRequest = existing.uuid != null && existing.uuid.equals(uuid)
                        && Double.compare(existing.amount, amount) == 0;
                if (!sameRequest) {
                    throw new AgentException(ErrorCode.CONFLICT,
                            "eventId " + eventId + " 已经用于另一笔调整（"
                                    + existing.uuid + " / " + existing.amount
                                    + "），拒绝执行以避免重复发钱");
                }
                return new Outcome(existing.balanceAfter, true);
            }

            double balanceAfter;
            try {
                balanceAfter = action.call().doubleValue();
            } catch (AgentException e) {
                throw e;
            } catch (Exception e) {
                throw new AgentException(ErrorCode.INTERNAL, "经济调整失败: " + e.getMessage(), e);
            }

            Entry entry = new Entry();
            entry.eventId = eventId;
            entry.uuid = uuid;
            entry.amount = amount;
            entry.balanceAfter = balanceAfter;
            entry.ts = System.currentTimeMillis();
            entries.put(eventId, entry);
            dirty = true;
            return new Outcome(balanceAfter, false);
        }
    }

    public synchronized Entry lookup(String eventId) {
        prune();
        return entries.get(eventId);
    }

    public synchronized int size() {
        return entries.size();
    }

    /** 异步调用；只在真的有变化时写盘。 */
    public synchronized void flushIfDirty() {
        if (!dirty) {
            return;
        }
        dirty = false;
        save();
    }

    /** 关服时同步调用。 */
    public synchronized void flush() {
        dirty = false;
        save();
    }

    private void prune() {
        long now = System.currentTimeMillis();
        Iterator<Map.Entry<String, Entry>> iterator = entries.entrySet().iterator();
        while (iterator.hasNext()) {
            Entry entry = iterator.next().getValue();
            if (entry == null || now - entry.ts > ttlMillis) {
                iterator.remove();
                dirty = true;
            }
        }
    }

    private void save() {
        if (file == null) {
            return;
        }
        FileModel model = new FileModel();
        model.events = new ArrayList<Entry>(entries.values());
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            logger.warning("无法创建目录 " + parent + "，经济幂等缓存未能写入");
            return;
        }
        Writer writer = null;
        try {
            writer = new OutputStreamWriter(new FileOutputStream(file), UTF8);
            gson.toJson(model, writer);
            writer.flush();
        } catch (Throwable t) {
            logger.log(Level.WARNING, "经济幂等缓存写入失败: " + file, t);
        } finally {
            closeQuietly(writer);
        }
    }

    private static void closeQuietly(java.io.Closeable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (IOException ignored) {
            // 忽略
        }
    }
}
