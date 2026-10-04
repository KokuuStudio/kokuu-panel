package com.kokuustudio.kokuupanel.agent.hooks;

import com.kokuustudio.kokuupanel.agent.model.LpModels.LpGroup;
import com.kokuustudio.kokuupanel.agent.model.LpModels.LpGroupRef;
import com.kokuustudio.kokuupanel.agent.model.LpModels.LpMeta;
import com.kokuustudio.kokuupanel.agent.model.LpModels.LpPermission;
import com.kokuustudio.kokuupanel.agent.model.LpModels.LpUser;
import com.kokuustudio.kokuupanel.agent.protocol.AgentException;
import com.kokuustudio.kokuupanel.agent.protocol.ErrorCode;
import com.kokuustudio.kokuupanel.agent.util.Text;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Predicate;
import net.luckperms.api.LuckPerms;
import net.luckperms.api.LuckPermsProvider;
import net.luckperms.api.cacheddata.CachedMetaData;
import net.luckperms.api.model.PermissionHolder;
import net.luckperms.api.model.data.NodeMap;
import net.luckperms.api.model.group.Group;
import net.luckperms.api.model.user.User;
import net.luckperms.api.node.Node;
import net.luckperms.api.node.NodeType;
import net.luckperms.api.node.types.ChatMetaNode;
import net.luckperms.api.node.types.InheritanceNode;
import net.luckperms.api.node.types.PermissionNode;
import net.luckperms.api.node.types.PrefixNode;
import net.luckperms.api.node.types.SuffixNode;
import net.luckperms.api.node.types.WeightNode;
import net.luckperms.api.platform.PluginMetadata;
import net.luckperms.api.query.QueryOptions;

/**
 * LuckPerms 5.x API 的真实实现。
 *
 * <p><b>这个类只会被反射加载</b>（见 {@link LuckPermsHook}）：
 * 它直接引用 {@code net.luckperms.api.*}，在没装 LuckPerms 的服务端上加载它会
 * 直接 {@code NoClassDefFoundError}。
 *
 * <p>为什么用编译期直接调用而不是全反射：LP 5.x 的 API 面对 MC 1.8+ 且是
 * Java 8 字节码，覆盖面足够（架构文档 §4.3）。全反射会让这套很长的 API 面
 * 变成一堆字符串，编译期一个拼写错误都发现不了。真正需要保护的只有
 * 「类在不在」—— 那一层由 Hook 的探测 + 这里的构造器兜住。
 *
 * <p>存储 IO（{@code loadUser} / {@code saveUser}）是有界等待：
 * 不等待就没法如实返回 {@code changed}，无限等又可能卡住主线程。
 */
public final class LuckPermsBridge implements LpBridge {

    /** 单次存储 IO 的等待上限。 */
    private static final long IO_TIMEOUT_MS = 5000L;
    /**
     * 聊天前缀/后缀节点的默认优先级。
     * 已有直接节点时沿用它的优先级，避免一个玩家身上出现两个同优先级的直接前缀。
     */
    private static final int DEFAULT_META_PRIORITY = 100;

    private final LuckPerms api;

    public LuckPermsBridge() {
        // LP 还没加载完会抛 IllegalStateException —— 由 Hook 捕获。
        this.api = LuckPermsProvider.get();
        PluginMetadata metadata = api.getPluginMetadata();
        if (metadata != null) {
            String apiVersion = metadata.getApiVersion();
            String major = majorOf(apiVersion);
            if (major != null && !"5".equals(major)) {
                // 明确报错，而不是等到某个调用抛 NoSuchMethodError 才让人去猜。
                throw new IllegalStateException("不支持 LuckPerms API " + apiVersion
                        + "（本插件按 5.x 编译；架构文档 §4.3 只承诺 5.x）");
            }
        }
    }

    private static String majorOf(String version) {
        if (version == null) {
            return null;
        }
        int index = version.indexOf('.');
        String head = index < 0 ? version : version.substring(0, index);
        for (int i = 0; i < head.length(); i++) {
            if (!Character.isDigit(head.charAt(i))) {
                return null;
            }
        }
        return head.isEmpty() ? null : head;
    }

    @Override
    public String versionDescription() {
        PluginMetadata metadata = api.getPluginMetadata();
        String version = metadata == null ? "?" : metadata.getVersion();
        String apiVersion = metadata == null ? "?" : metadata.getApiVersion();
        return "LuckPerms " + version + "（api " + apiVersion + "，server " + api.getServerName() + "）";
    }

    // ── 查询 ──────────────────────────────────────────────────────────────

    @Override
    public LpUser getUser(String uuid, String name) {
        User user = requireUser(uuid);
        LpUser out = new LpUser();
        out.uuid = user.getUniqueId().toString();
        String username = user.getUsername();
        if (username == null || username.isEmpty()) {
            username = name != null ? name : user.getFriendlyName();
        }
        out.name = Text.nvl(username);
        out.primaryGroup = Text.nvl(user.getPrimaryGroup());

        List<LpGroupRef> groups = new ArrayList<LpGroupRef>();
        Set<String> directGroups = new LinkedHashSet<String>();
        for (InheritanceNode node : user.getNodes(NodeType.INHERITANCE)) {
            if (node.hasExpired() || !node.getValue()) {
                continue;
            }
            String groupName = node.getGroupName();
            if (directGroups.add(groupName)) {
                groups.add(new LpGroupRef(groupName, weightOf(groupName), true));
            }
        }
        try {
            for (Group group : user.getInheritedGroups(QueryOptions.nonContextual())) {
                if (group == null) {
                    continue;
                }
                String groupName = group.getName();
                if (directGroups.contains(groupName)) {
                    continue;
                }
                groups.add(new LpGroupRef(groupName, group.getWeight().orElse(0), false));
            }
        } catch (Throwable ignored) {
            // 继承组算不出来不影响直接组的信息。
        }
        out.groups = groups;

        List<LpPermission> permissions = new ArrayList<LpPermission>();
        for (PermissionNode node : user.getNodes(NodeType.PERMISSION)) {
            if (node.hasExpired()) {
                continue;
            }
            permissions.add(new LpPermission(node.getPermission(), node.getValue(), true));
        }
        out.permissions = permissions;

        LpMeta meta = new LpMeta();
        CachedMetaData cached = user.getCachedData().getMetaData();
        meta.prefix = Text.nvl(cached.getPrefix());
        meta.suffix = Text.nvl(cached.getSuffix());
        meta.weight = weightOf(user.getPrimaryGroup());
        out.meta = meta;

        try {
            out.inheritedPermissionsCount =
                    user.getCachedData().getPermissionData().getPermissionMap().size();
        } catch (Throwable ignored) {
            out.inheritedPermissionsCount = 0;
        }
        return out;
    }

    @Override
    public List<LpGroup> groups() {
        List<LpGroup> result = new ArrayList<LpGroup>();
        for (Group group : api.getGroupManager().getLoadedGroups()) {
            if (group == null) {
                continue;
            }
            LpGroup out = new LpGroup();
            out.name = group.getName();
            String displayName = group.getDisplayName();
            out.displayName = displayName == null || displayName.isEmpty() ? out.name : displayName;
            out.weight = group.getWeight().orElse(0);

            List<String> parents = new ArrayList<String>();
            for (InheritanceNode node : group.getNodes(NodeType.INHERITANCE)) {
                if (node.hasExpired() || !node.getValue()) {
                    continue;
                }
                String parent = node.getGroupName();
                if (parent.equals(out.name) || parents.contains(parent)) {
                    continue;
                }
                parents.add(parent);
            }
            out.parents = parents;

            List<LpPermission> permissions = new ArrayList<LpPermission>();
            for (PermissionNode node : group.getNodes(NodeType.PERMISSION)) {
                if (node.hasExpired()) {
                    continue;
                }
                permissions.add(new LpPermission(node.getPermission(), node.getValue(), true));
            }
            out.permissions = permissions;

            LpMeta meta = new LpMeta();
            CachedMetaData cached = group.getCachedData().getMetaData();
            meta.prefix = Text.nvl(cached.getPrefix());
            meta.suffix = Text.nvl(cached.getSuffix());
            meta.weight = out.weight;
            out.meta = meta;

            // 协议 §5.5：userCount 统计全量用户开销大，Agent 可选实现。
            // 这里如实返回 null（前端显示 —），而不是拿「已加载用户」凑一个假数字。
            out.userCount = null;
            result.add(out);
        }
        Collections.sort(result, new Comparator<LpGroup>() {
            @Override
            public int compare(LpGroup left, LpGroup right) {
                int byWeight = Integer.compare(right.weight, left.weight);
                return byWeight != 0 ? byWeight : left.name.compareTo(right.name);
            }
        });
        return result;
    }

    // ── 用户写操作 ────────────────────────────────────────────────────────

    @Override
    public boolean setPrimaryGroup(String uuid, String group) {
        requireGroup(group);
        User user = requireUser(uuid);
        String current = user.getPrimaryGroup();
        if (group.equals(current)) {
            return false;
        }
        user.setPrimaryGroup(group);
        saveUser(user);
        return true;
    }

    @Override
    public boolean addGroup(String uuid, String group) {
        requireGroup(group);
        User user = requireUser(uuid);
        final String key = groupKey(group);
        if (hasDirect(user, NodeType.INHERITANCE, key, Boolean.TRUE)) {
            return false;
        }
        // 先清掉同 key 的任何节点：如果玩家身上有一条 -group.vip 的否定节点，
        // 直接 add 正节点会变成「两个节点打架」，LP 里否定优先，玩家仍然进不去。
        clear(user, keyPredicate(NodeType.INHERITANCE, key));
        user.data().add(InheritanceNode.builder(group).build());
        saveUser(user);
        return true;
    }

    @Override
    public boolean removeGroup(String uuid, String group) {
        User user = requireUser(uuid);
        final String key = groupKey(group);
        if (!hasDirect(user, NodeType.INHERITANCE, key, Boolean.TRUE)) {
            return false;
        }
        clear(user, keyPredicate(NodeType.INHERITANCE, key));
        saveUser(user);
        return true;
    }

    @Override
    public boolean setPermission(String uuid, String permission, boolean value) {
        User user = requireUser(uuid);
        if (hasDirect(user, NodeType.PERMISSION, permission, Boolean.valueOf(value))) {
            return false;
        }
        clearPermission(user, permission);
        user.data().add(PermissionNode.builder(permission).value(value).build());
        saveUser(user);
        return true;
    }

    @Override
    public boolean unsetPermission(String uuid, String permission) {
        User user = requireUser(uuid);
        if (!hasDirect(user, NodeType.PERMISSION, permission, null)) {
            return false;
        }
        clearPermission(user, permission);
        saveUser(user);
        return true;
    }

    @Override
    public boolean setMeta(String uuid, String prefix, String suffix) {
        User user = requireUser(uuid);
        CachedMetaData cached = user.getCachedData().getMetaData();
        String currentPrefix = Text.nvl(cached.getPrefix());
        String currentSuffix = Text.nvl(cached.getSuffix());

        boolean prefixChanged = prefix != null && !prefix.equals(currentPrefix);
        boolean suffixChanged = suffix != null && !suffix.equals(currentSuffix);
        if (!prefixChanged && !suffixChanged) {
            return false;
        }
        if (prefixChanged) {
            int priority = directPriority(user, NodeType.PREFIX, DEFAULT_META_PRIORITY);
            clearKind(user, NodeType.PREFIX);
            user.data().add(PrefixNode.builder(prefix, priority).build());
        }
        if (suffixChanged) {
            int priority = directPriority(user, NodeType.SUFFIX, DEFAULT_META_PRIORITY);
            clearKind(user, NodeType.SUFFIX);
            user.data().add(SuffixNode.builder(suffix, priority).build());
        }
        saveUser(user);
        return true;
    }

    // ── 权限组写操作 ──────────────────────────────────────────────────────

    @Override
    public boolean createGroup(String name) {
        if (api.getGroupManager().getGroup(name) != null) {
            return false;
        }
        try {
            api.getGroupManager().createAndLoadGroup(name).get(IO_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            throw ioFailure("创建权限组 " + name + " 失败", e);
        }
        return true;
    }

    @Override
    public boolean deleteGroup(String name) {
        if ("default".equals(name)) {
            // 删掉 default 会让所有没显式设组的玩家失去基础权限，平台侧也恢复不了。
            throw new AgentException(ErrorCode.CONFLICT, "不允许删除 default 权限组");
        }
        Group group = requireGroup(name);
        try {
            api.getGroupManager().deleteGroup(group).get(IO_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            throw ioFailure("删除权限组 " + name + " 失败", e);
        }
        return true;
    }

    @Override
    public boolean groupSetPermission(String name, String permission, boolean value) {
        Group group = requireGroup(name);
        if (hasDirect(group, NodeType.PERMISSION, permission, Boolean.valueOf(value))) {
            return false;
        }
        clearPermission(group, permission);
        group.data().add(PermissionNode.builder(permission).value(value).build());
        saveGroup(group);
        return true;
    }

    @Override
    public boolean groupUnsetPermission(String name, String permission) {
        Group group = requireGroup(name);
        if (!hasDirect(group, NodeType.PERMISSION, permission, null)) {
            return false;
        }
        clearPermission(group, permission);
        saveGroup(group);
        return true;
    }

    @Override
    public boolean groupSetParent(String name, String parent, boolean add) {
        if (name.equals(parent)) {
            throw new AgentException(ErrorCode.CONFLICT, "权限组不能把自己设成父组");
        }
        Group group = requireGroup(name);
        Group parentGroup = requireGroup(parent);
        final String key = groupKey(parent);
        boolean present = hasDirect(group, NodeType.INHERITANCE, key, Boolean.TRUE);
        if (add == present) {
            return false;
        }
        clear(group, keyPredicate(NodeType.INHERITANCE, key));
        if (add) {
            group.data().add(InheritanceNode.builder(parentGroup).build());
        }
        saveGroup(group);
        return true;
    }

    @Override
    public boolean groupSetWeight(String name, int weight) {
        Group group = requireGroup(name);
        if (group.getWeight().orElse(0) == weight) {
            return false;
        }
        clearKind(group, NodeType.WEIGHT);
        group.data().add(WeightNode.builder(weight).build());
        saveGroup(group);
        return true;
    }

    @Override
    public boolean groupSetMeta(String name, String prefix, String suffix) {
        Group group = requireGroup(name);
        CachedMetaData cached = group.getCachedData().getMetaData();
        String currentPrefix = Text.nvl(cached.getPrefix());
        String currentSuffix = Text.nvl(cached.getSuffix());

        boolean prefixChanged = prefix != null && !prefix.equals(currentPrefix);
        boolean suffixChanged = suffix != null && !suffix.equals(currentSuffix);
        if (!prefixChanged && !suffixChanged) {
            return false;
        }
        if (prefixChanged) {
            int priority = directPriority(group, NodeType.PREFIX, DEFAULT_META_PRIORITY);
            clearKind(group, NodeType.PREFIX);
            group.data().add(PrefixNode.builder(prefix, priority).build());
        }
        if (suffixChanged) {
            int priority = directPriority(group, NodeType.SUFFIX, DEFAULT_META_PRIORITY);
            clearKind(group, NodeType.SUFFIX);
            group.data().add(SuffixNode.builder(suffix, priority).build());
        }
        saveGroup(group);
        return true;
    }

    // ── 内部工具 ──────────────────────────────────────────────────────────

    private User requireUser(String uuid) {
        UUID id;
        try {
            id = UUID.fromString(uuid);
        } catch (IllegalArgumentException e) {
            throw new AgentException(ErrorCode.INVALID_PARAMS, "UUID 格式不正确: " + uuid);
        }
        User user = api.getUserManager().getUser(id);
        if (user == null) {
            // 离线玩家通常没被载入，需要从存储读一次。
            // LP 的 loadUser 在自己的线程池上做 IO，这里做**有界**等待：
            // 无限等会卡死主线程，不等又没法如实回答。
            try {
                user = api.getUserManager().loadUser(id).get(IO_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                throw new AgentException(ErrorCode.TIMEOUT,
                        "LuckPerms 加载用户超时（" + IO_TIMEOUT_MS + "ms）: " + uuid);
            } catch (Exception e) {
                throw ioFailure("LuckPerms 加载用户失败: " + uuid, e);
            }
        }
        if (user == null) {
            throw new AgentException(ErrorCode.NOT_FOUND, "LuckPerms 里没有这个玩家: " + uuid);
        }
        return user;
    }

    private Group requireGroup(String name) {
        Group group = api.getGroupManager().getGroup(name);
        if (group == null) {
            try {
                Optional<Group> loaded = api.getGroupManager().loadGroup(name)
                        .get(IO_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                if (loaded.isPresent()) {
                    group = loaded.get();
                }
            } catch (Exception ignored) {
                // 落到下面的 NOT_FOUND
            }
        }
        if (group == null) {
            throw new AgentException(ErrorCode.NOT_FOUND, "LuckPerms 里没有权限组 " + name);
        }
        return group;
    }

    private void saveUser(User user) {
        try {
            api.getUserManager().saveUser(user).get(IO_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            throw ioFailure("保存用户 " + user.getUniqueId() + " 失败", e);
        }
    }

    private void saveGroup(Group group) {
        try {
            api.getGroupManager().saveGroup(group).get(IO_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            throw ioFailure("保存权限组 " + group.getName() + " 失败", e);
        }
    }

    private int weightOf(String groupName) {
        if (groupName == null) {
            return 0;
        }
        Group group = api.getGroupManager().getGroup(groupName);
        return group == null ? 0 : group.getWeight().orElse(0);
    }

    private static String groupKey(String group) {
        return "group." + group;
    }

    /**
     * @param value null 表示不比较值
     */
    private static boolean hasDirect(PermissionHolder holder, NodeType<?> type, String key,
                                     Boolean value) {
        for (Node node : holder.getNodes()) {
            if (!type.matches(node) || node.hasExpired()) {
                continue;
            }
            if (!key.equalsIgnoreCase(node.getKey())) {
                continue;
            }
            if (value == null || value.booleanValue() == node.getValue()) {
                return true;
            }
        }
        return false;
    }

    private static void clear(PermissionHolder holder, Predicate<Node> predicate) {
        NodeMap data = holder.data();
        data.clear(predicate);
    }

    private void clearPermission(PermissionHolder holder, String permission) {
        clear(holder, keyPredicate(NodeType.PERMISSION, permission));
    }

    /** 「同一类型 + 同一 key」的节点，不管值是正是负、有没有过期。 */
    private static Predicate<Node> keyPredicate(final NodeType<?> type, final String key) {
        return new Predicate<Node>() {
            @Override
            public boolean test(Node node) {
                return type.matches(node) && key.equalsIgnoreCase(node.getKey());
            }
        };
    }

    private void clearKind(PermissionHolder holder, NodeType<?> type) {
        final NodeType<?> target = type;
        clear(holder, new Predicate<Node>() {
            @Override
            public boolean test(Node node) {
                return target.matches(node);
            }
        });
    }

    /** 同类节点里已有的最高优先级；没有就用默认值。 */
    private static int directPriority(PermissionHolder holder, NodeType<?> type, int fallback) {
        int highest = Integer.MIN_VALUE;
        Collection<Node> nodes = holder.getNodes();
        for (Node node : nodes) {
            if (!type.matches(node) || node.hasExpired()) {
                continue;
            }
            if (node instanceof ChatMetaNode) {
                int priority = ((ChatMetaNode<?, ?>) node).getPriority();
                if (priority > highest) {
                    highest = priority;
                }
            }
        }
        return highest == Integer.MIN_VALUE ? fallback : highest;
    }

    private static AgentException ioFailure(String message, Exception cause) {
        Throwable root = cause;
        if (root instanceof java.util.concurrent.ExecutionException && root.getCause() != null) {
            root = root.getCause();
        }
        return new AgentException(ErrorCode.INTERNAL,
                message + ": " + root.getClass().getSimpleName()
                        + (root.getMessage() == null ? "" : ": " + root.getMessage()), cause);
    }
}
