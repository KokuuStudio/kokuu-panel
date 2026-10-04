package com.kokuustudio.kokuupanel.agent.hooks;

import com.kokuustudio.kokuupanel.agent.model.LpModels.LpGroup;
import com.kokuustudio.kokuupanel.agent.model.LpModels.LpUser;
import java.util.List;

/**
 * LuckPerms 的抽象。实现类才引用 {@code net.luckperms.api.*}。
 *
 * <p>这就是架构文档 §4.3 说的「编译期探针 + 运行期软依赖」：
 * 编译时依赖 {@code net.luckperms:api:5.4}（provided，不进 jar），
 * 运行时先探测，探测不过就永远不加载 {@link LuckPermsBridge} 这个类，
 * 于是「没装 LuckPerms」不会变成 {@code NoClassDefFoundError}。
 *
 * <p>所有写方法返回 {@code changed}：false 表示「本来就是这个值」，
 * 平台据此决定审计日志记「已修改」还是「无需修改」。
 * 所有方法都可能抛 {@code AgentException}（NOT_FOUND / INTERNAL 等）。
 */
public interface LpBridge {

    /** 版本描述，用于启动日志与 /kp status。 */
    String versionDescription();

    LpUser getUser(String uuid, String name);

    boolean setPrimaryGroup(String uuid, String group);

    boolean addGroup(String uuid, String group);

    boolean removeGroup(String uuid, String group);

    boolean setPermission(String uuid, String permission, boolean value);

    boolean unsetPermission(String uuid, String permission);

    /** prefix / suffix 为 null 表示「这一项不动」。 */
    boolean setMeta(String uuid, String prefix, String suffix);

    List<LpGroup> groups();

    boolean createGroup(String name);

    boolean deleteGroup(String name);

    boolean groupSetPermission(String name, String permission, boolean value);

    boolean groupUnsetPermission(String name, String permission);

    boolean groupSetParent(String name, String parent, boolean add);

    boolean groupSetWeight(String name, int weight);

    boolean groupSetMeta(String name, String prefix, String suffix);
}
