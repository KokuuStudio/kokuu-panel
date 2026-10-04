package com.kokuustudio.kokuupanel.agent.model;

/**
 * 玩家条目。逐字对应协议 §5.2 的 {@code Player}。
 *
 * <p>{@code ip} 只有 {@code players.list} 带 {@code withIp:true} 时才填。
 * 默认不传：玩家 IP 属于个人信息，默认关掉可以让「不小心把 IP 打进日志」的概率降到零。
 */
public final class PlayerEntry {

    public String uuid;
    public String name;
    public String displayName;
    public boolean online;
    public String world;
    public double x;
    public double y;
    public double z;
    public int ping;
    public String gamemode;
    public double health;
    public int food;
    public int level;
    public boolean op;
    public boolean whitelisted;
    /** 仅 withIp=true 时返回；null 时 Gson 会直接省略这个字段。 */
    public String ip;
    public long firstPlayed;
    public long lastSeen;
    public long playtimeSeconds;
}
