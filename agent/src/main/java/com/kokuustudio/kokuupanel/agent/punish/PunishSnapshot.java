package com.kokuustudio.kokuupanel.agent.punish;

import com.kokuustudio.kokuupanel.agent.model.Punishment;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

/**
 * 封禁 / 禁言快照（内存）。
 *
 * <p>协议 §5.3 与架构文档 §3：**平台是唯一权威，Agent 不自己维护封禁表。**
 * 这里两份来源：
 * <ol>
 *   <li>hello 响应里的 {@code punish.active}（连上就一定有当前状态）</li>
 *   <li>平台广播的 {@code punish.sync}（全量替换，不是增量）</li>
 * </ol>
 *
 * <p>第 2 条故意是全量：快照小（通常几十条），全量发送让本地状态永远能自愈，
 * 不必处理丢包后的增量缺口。
 *
 * <p><b>登录 / 聊天路径只读这个内存对象，绝不做网络请求</b> ——
 * {@code PlayerLoginEvent} 在主线程上，阻塞它等于卡住整个服务器。
 * 读操作拿到的是 volatile 的不可变列表，不加锁。
 */
public final class PunishSnapshot {

    private volatile long revision;
    private volatile boolean loaded;
    private volatile long updatedAt;
    private volatile List<Punishment> active = Collections.emptyList();

    /** 全量替换。返回替换前的条数，方便日志。 */
    public synchronized int replace(long newRevision, List<Punishment> punishments) {
        List<Punishment> copy = new ArrayList<Punishment>();
        if (punishments != null) {
            for (Punishment punishment : punishments) {
                if (punishment != null && punishment.id != null) {
                    copy.add(punishment);
                }
            }
        }
        int previous = active.size();
        active = Collections.unmodifiableList(copy);
        revision = newRevision;
        loaded = true;
        updatedAt = System.currentTimeMillis();
        return previous;
    }

    /** 单条新增/覆盖（punish.apply）。 */
    public synchronized void put(Punishment punishment) {
        if (punishment == null || punishment.id == null) {
            return;
        }
        List<Punishment> copy = new ArrayList<Punishment>(active);
        for (int i = 0; i < copy.size(); i++) {
            if (punishment.id.equals(copy.get(i).id)) {
                copy.set(i, punishment);
                active = Collections.unmodifiableList(copy);
                updatedAt = System.currentTimeMillis();
                return;
            }
        }
        copy.add(punishment);
        active = Collections.unmodifiableList(copy);
        updatedAt = System.currentTimeMillis();
    }

    /** 撤销一条。返回被移除的记录，没有就返回 null。 */
    public synchronized Punishment remove(String id) {
        if (id == null) {
            return null;
        }
        List<Punishment> copy = new ArrayList<Punishment>(active);
        for (int i = 0; i < copy.size(); i++) {
            Punishment candidate = copy.get(i);
            if (id.equals(candidate.id)) {
                copy.remove(i);
                active = Collections.unmodifiableList(copy);
                updatedAt = System.currentTimeMillis();
                return candidate;
            }
        }
        return null;
    }

    public List<Punishment> active() {
        return active;
    }

    public long revision() {
        return revision;
    }

    /** 是否至少成功加载过一次快照。false 表示「从来没拿到过」。 */
    public boolean isLoaded() {
        return loaded;
    }

    public long updatedAt() {
        return updatedAt;
    }

    /** 快照年龄（毫秒）；从未加载过返回 -1。 */
    public long ageMs() {
        if (!loaded) {
            return -1L;
        }
        return Math.max(0L, System.currentTimeMillis() - updatedAt);
    }

    public int size() {
        return active.size();
    }

    /**
     * 找到生效中的某类处罚。
     *
     * <p>只在内存里比对，不做任何网络请求 —— 这是登录路径的硬要求。
     */
    public Punishment findActive(String type, UUID uuid, String currentNodeId, long now) {
        if (uuid == null || type == null) {
            return null;
        }
        String target = uuid.toString();
        for (Punishment punishment : active) {
            if (!type.equals(punishment.type)) {
                continue;
            }
            if (punishment.uuid == null || !punishment.uuid.equalsIgnoreCase(target)) {
                continue;
            }
            if (punishment.appliesTo(currentNodeId, now)) {
                return punishment;
            }
        }
        return null;
    }

    public Punishment byId(String id) {
        if (id == null) {
            return null;
        }
        for (Punishment punishment : active) {
            if (id.equals(punishment.id)) {
                return punishment;
            }
        }
        return null;
    }
}
