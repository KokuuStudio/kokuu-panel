package com.kokuustudio.kokuupanel.agent.metrics;

import com.kokuustudio.kokuupanel.agent.model.ServerInfo;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import org.bukkit.Bukkit;
import org.bukkit.World;
import org.bukkit.plugin.Plugin;

/** 采集 {@code ServerInfo}（协议 §5.1）。只能在主线程调用。 */
public final class ServerInfoCollector {

    private ServerInfoCollector() {
    }

    /**
     * @param configuredName config.yml 的 {@code serverName}，空表示自动
     */
    public static ServerInfo collect(String configuredName) {
        ServerInfo info = new ServerInfo();
        info.name = resolveName(configuredName);
        info.brand = Bukkit.getName();
        info.version = Bukkit.getVersion();
        info.bukkitVersion = Bukkit.getBukkitVersion();
        info.port = Bukkit.getPort();
        info.onlineMode = Bukkit.getOnlineMode();
        info.maxPlayers = Bukkit.getMaxPlayers();
        info.viewDistance = Bukkit.getViewDistance();
        info.motd = Bukkit.getMotd();
        info.whitelistEnabled = Bukkit.hasWhitelist();

        List<ServerInfo.PluginInfo> plugins = new ArrayList<ServerInfo.PluginInfo>();
        for (Plugin plugin : Bukkit.getPluginManager().getPlugins()) {
            plugins.add(new ServerInfo.PluginInfo(plugin.getName(),
                    plugin.getDescription() == null ? "" : plugin.getDescription().getVersion()));
        }
        info.plugins = plugins;

        List<ServerInfo.WorldInfo> worlds = new ArrayList<ServerInfo.WorldInfo>();
        for (World world : Bukkit.getWorlds()) {
            worlds.add(new ServerInfo.WorldInfo(
                    world.getName(),
                    String.valueOf(world.getEnvironment()),
                    world.getPlayers().size(),
                    world.getEntities().size(),
                    world.getLoadedChunks().length));
        }
        info.worlds = worlds;
        return info;
    }

    /**
     * 服务端显示名。
     *
     * <p>Bukkit 没有稳定的「服务器名」API：Spigot 的 {@code Bukkit.getServerName()}
     * 读的是 server.properties 的 {@code server-name}，但 Paper 在较新版本里把它删了
     * （1.20.6 的 paper-api 上已经不存在）。所以这里按架构文档 §4.4 的思路做能力探测：
     * <ol>
     *   <li>config.yml 里显式配了 {@code serverName} 就用它</li>
     *   <li>反射 {@code Bukkit.getServerName()} / {@code Server.getServerName()}</li>
     *   <li>都没有就退回 {@code Bukkit.getName()}（品牌名）—— 实事求是，不编一个名字</li>
     * </ol>
     */
    private static String resolveName(String configuredName) {
        if (configuredName != null && !configuredName.trim().isEmpty()) {
            return configuredName.trim();
        }
        Object server = null;
        try {
            server = Bukkit.class.getMethod("getServer").invoke(null);
        } catch (Throwable ignored) {
            // 拿不到就只试 Bukkit 上的那个。
        }
        if (server != null) {
            String viaServer = invokeString(server.getClass(), server, "getServerName");
            if (viaServer != null) {
                return viaServer;
            }
        }
        String viaBukkit = invokeString(Bukkit.class, null, "getServerName");
        if (viaBukkit != null) {
            return viaBukkit;
        }
        return Bukkit.getName();
    }

    private static String invokeString(Class<?> owner, Object receiver, String name) {
        try {
            Method method = owner.getMethod(name);
            Object value = method.invoke(receiver);
            return value instanceof String && !((String) value).isEmpty() ? (String) value : null;
        } catch (Throwable t) {
            return null;
        }
    }
}
