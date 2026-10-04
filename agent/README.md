# KokuuAgent —— KokuuPanel 的 Minecraft 服务端侧插件

把服务端接进 [KokuuPanel](../docs/ARCHITECTURE.md) 管理平台。Agent **主动外连**平台
（MC 服务端基本都在 NAT 后面，反连不可行），之后平台通过这条长连接做 RPC 与事件推送。

契约只有一份：[`docs/PROTOCOL.md`](../docs/PROTOCOL.md)。
跨版本取舍见 [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §4/§5。

---

## 构建

```bash
mvn package          # 产物 target/kokuu-agent-1.0.0.jar
```

- 字节码目标 **Java 8**（`maven.compiler.release=8`）。字节码兼容是单向的：
  Java 8 字节码能在所有更高运行时上跑，反过来直接 `UnsupportedClassVersionError`。
  **不要**为了消警告把目标调高（架构文档 §4.1）。
- `plugin.yml` 的 `api-version: 1.13`：1.12.2 会忽略不认识的键，1.13+ 需要它才加载（§4.2）。
- LuckPerms / Vault 是 `provided` + `softdepend`；Gson / Java-WebSocket / slf4j 被
  shade 进 jar 并重定位到 `com.kokuustudio.kokuupanel.libs.*`，不会和别的插件撞车。

## 安装

1. 把 jar 丢进 `plugins/`，启动一次服务端 —— 会生成 `plugins/KokuuAgent/config.yml`。
2. 在平台的节点页面创建节点，把 `nodeId` / `secret` 填进 config.yml。
3. 生产环境把 `panelUrl` 写成 `wss://…`（密钥在 hello 帧里明文传输）。
4. `/kp status` 看连接与能力；`/kp reload` 改完配置重载。

## 命令

| 命令 | 权限 | 说明 |
|---|---|---|
| `/kp status` | `kokuuagent.use` | 连接状态、快照年龄、队列深度、能力列表 |
| `/kp info <玩家>` | `kokuuagent.use` | 走 Agent→平台 RPC，查平台侧的全名与历史处罚 |
| `/kp ban\|mute <玩家> [原因] [时长]` | `kokuuagent.admin` | 时长写 `30m`/`12h`/`7d`/`perm`；结果作为 `punish.applied` 上报平台 |
| `/kp unban\|unmute <玩家\|处罚ID>` | `kokuuagent.admin` | 上报 `punish.revoked` |
| `/kp reload` | `kokuuagent.admin` | 重载配置、重探能力、按需重连 |

游戏内的处罚操作**先问平台**（`player.resolve`），所以也会落进平台的审计日志 ——
否则「谁在游戏里封了人」在平台上查不到。

## 能力自述

`hello` 里上报的 capabilities 按实际探测结果决定：没装 LuckPerms 就不报 `luckperms`，
没装 Vault 就不报 `economy`。平台据此隐藏入口，用户看不到「点了才报错」的功能。

这套东西有两个**实测踩出来的**约束，改连接时机前请先读这段：

1. **连接要等主线程跑起来再发。** Bukkit 的调度器只在主循环里跑，而主循环在
   `Done (Xs)!` 之后才开始 —— 所以从 `runTaskLater` 里发起连接，等价于「服务端已就绪」。
   在 `onEnable` 里直接连会踩两个坑：能力集残缺（CMI 的经济后端比本插件晚约 12 秒
   才注册进 Vault，而 `hello` 的能力集在握手那一刻就定格了，平台会一直以为这个节点
   没有 economy）；以及平台的 `server.info` 在主线程忙着加载插件时超时（实测 8 秒超时）。
2. **能力是会被岁月补上的，所以要盯。** 协议里没有「能力变更」帧，因此有一个 30 秒周期的
   看门狗：只在「插件在但还没就绪」时才真去探测，探到能力集与上次 `hello` 发出去的不同
   就**重连一次**，让新的 `hello` 带上完整能力集。常态下它什么都不做。

对应实现：`startConnectionAfterStartup()` / `watchCapabilities()`，
以及 `LuckPermsHook.probe(boolean quiet)` / `VaultHook.probe(boolean quiet)`。

## 代码结构

```
ws/          连接层：ConnectionManager（握手/心跳/退避重连/半开检测）、WsConnection、
             PendingRequests（出站 id 空间）、AgentRpc（Agent→平台请求）
protocol/    帧编解码与错误码（唯一对应 PROTOCOL.md §3/§4）
rpc/         RpcDispatcher（方法注册与分发）、MainThreadExecutor（切主线程 + 超时）、Params（校验）
modules/     六个方法模块 + CapturingCommandSender（console.execute 的输出捕获）
punish/      封禁快照 + 登录/聊天拦截（只读内存，不做网络请求）
events/      事件上报、控制台日志采集（默认关闭，200 行/秒限流）
metrics/     TPS/MSPT 探测（Paper 优先，tick 计数降级，都拿不到给 null）
hooks/       LuckPerms / Vault 运行时探测与适配（反射加载，避免 NoClassDefFoundError）
command/     /kp 命令
```

连接层只依赖 `ws/ConnectionHost` 接口，不认识 Bukkit —— 这一层因此可以在
不启动服务端的情况下做端到端测试。
