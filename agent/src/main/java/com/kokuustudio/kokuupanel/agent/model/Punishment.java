package com.kokuustudio.kokuupanel.agent.model;

/**
 * 封禁 / 禁言 / 警告 / 踢出记录。逐字对应协议 §5.3 的 {@code Punishment}。
 *
 * <p>字段名就是 JSON 名，Gson 直接按字段名映射 —— 改字段名等于改协议。
 *
 * <p><b>权威在平台，Agent 只持有快照。</b>这里出现 {@code nodeId} 是因为
 * 「只在该节点生效」的封禁需要 Agent 自己判断要不要拦。
 */
public final class Punishment {

    public String id;
    /** ban | mute | warn | kick */
    public String type;
    public String uuid;
    public String name;
    public String reason;
    public String operator;
    /** null = 全平台生效；否则只在该节点生效。 */
    public String nodeId;
    public long createdAt;
    /** null = 永久。 */
    public Long expiresAt;
    public boolean active;

    public boolean isExpired(long now) {
        return expiresAt != null && expiresAt.longValue() <= now;
    }

    /** 这条记录在本节点上是否生效。 */
    public boolean appliesTo(String currentNodeId, long now) {
        if (!active || isExpired(now)) {
            return false;
        }
        return nodeId == null || nodeId.equals(currentNodeId);
    }

    public boolean matchesType(String expected) {
        return expected.equals(type);
    }
}
