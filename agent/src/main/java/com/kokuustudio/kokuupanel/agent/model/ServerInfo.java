package com.kokuustudio.kokuupanel.agent.model;

import java.util.List;

/** 服务器静态信息。逐字对应协议 §5.1 的 {@code ServerInfo}。 */
public final class ServerInfo {

    public String name;
    public String brand;
    public String version;
    public String bukkitVersion;
    public int port;
    public boolean onlineMode;
    public int maxPlayers;
    public int viewDistance;
    public String motd;
    public List<PluginInfo> plugins;
    public List<WorldInfo> worlds;
    public boolean whitelistEnabled;

    public static final class PluginInfo {
        public String name;
        public String version;

        public PluginInfo(String name, String version) {
            this.name = name;
            this.version = version;
        }
    }

    public static final class WorldInfo {
        public String name;
        public String environment;
        public int players;
        public int entities;
        public int chunks;

        public WorldInfo(String name, String environment, int players, int entities, int chunks) {
            this.name = name;
            this.environment = environment;
            this.players = players;
            this.entities = entities;
            this.chunks = chunks;
        }
    }
}
