package com.kokuustudio.kokuupanel.agent.model;

import java.util.List;

/**
 * LuckPerms 的用户 / 组视图。逐字对应协议 §5.5 的 {@code LpUser} 与 {@code LpGroup}。
 *
 * <p>这两个类是**纯数据**，不含任何 LuckPerms 类型 ——
 * 这样「LP 没装时不要抛 NoClassDefFoundError」这条要求天然成立：
 * 只有 {@code LuckPermsBridge} 才引用 LP 的类型，而它只在探测成功后才被加载。
 */
public final class LpModels {

    private LpModels() {
    }

    public static final class LpUser {
        public String uuid;
        public String name;
        public String primaryGroup;
        public List<LpGroupRef> groups;
        public List<LpPermission> permissions;
        public LpMeta meta;
        public int inheritedPermissionsCount;
    }

    public static final class LpGroupRef {
        public String name;
        public int weight;
        public boolean direct;

        public LpGroupRef(String name, int weight, boolean direct) {
            this.name = name;
            this.weight = weight;
            this.direct = direct;
        }
    }

    public static final class LpPermission {
        public String key;
        public boolean value;
        public boolean direct;

        public LpPermission(String key, boolean value, boolean direct) {
            this.key = key;
            this.value = value;
            this.direct = direct;
        }
    }

    public static final class LpMeta {
        public String prefix;
        public String suffix;
        public int weight;
    }

    /**
     * 权限目录里的一条：这个服务端上**存在**这个权限节点。
     *
     * <p>来源是 {@code Bukkit.getPluginManager().getPermissions()} —— 各插件启动时
     * 注册进来的权限。它是判断「某个节点到底存不存在」的权威依据：手敲一个没人注册过的
     * 节点，LuckPerms 会照样存下来，但它永远不会生效，而管理员从界面上看不出区别。
     *
     * <p>刻意不含任何 LuckPerms 类型 —— 这个目录跟 LP 没关系，没装 LP 也拿得到。
     */
    public static final class LpPermissionInfo {
        public String node;
        public String description;
        public String defaultValue;
        /** 注册它的插件名（CMI / LuckPerms / …），null 表示拿不到。 */
        public String plugin;

        public LpPermissionInfo(String node, String description, String defaultValue, String plugin) {
            this.node = node;
            this.description = description;
            this.defaultValue = defaultValue;
            this.plugin = plugin;
        }
    }

    /** 权限目录的查询结果。 */
    public static final class LpPermissionCatalog {
        public List<LpPermissionInfo> items;
        /** 过滤之前服务端注册的权限总数。 */
        public int total;
        /** 是否因为 limit 被截断。 */
        public boolean truncated;

        public LpPermissionCatalog(List<LpPermissionInfo> items, int total, boolean truncated) {
            this.items = items;
            this.total = total;
            this.truncated = truncated;
        }
    }

    public static final class LpGroup {
        public String name;
        public String displayName;
        public int weight;
        public List<String> parents;
        public List<LpPermission> permissions;
        public LpMeta meta;
        /** 统计全量用户开销大；本插件不实现，恒为 null（前端显示 —）。 */
        public Integer userCount;
    }
}
