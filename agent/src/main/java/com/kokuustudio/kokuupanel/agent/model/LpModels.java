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
