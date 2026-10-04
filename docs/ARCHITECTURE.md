# KokuuPanel 架构

综合性 Minecraft Java 版服务器管理平台。替代并扩展
[kokuu-credit-admin](https://github.com/KokuuStudio/kokuu-credit-admin)
（只做经济）与 [exchange-bridge](https://github.com/KokuuStudio/exchange-bridge)
（只在游戏侧执行发钱）。

---

## 1. 全貌

```
┌─────────────────────────────────────────────────────────────────┐
│  apps/web            Vue 3 + TS + Element Plus                   │
│  浏览器 ──HTTP/REST──┐                                            │
│         ──WebSocket──┤  实时事件推送（节点状态、控制台、在线变化）    │
└──────────────────────┼────────────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  apps/server         Node 24 + TS + Fastify + ws                  │
│                                                                   │
│   REST /api/*  ──▶  services/  ──▶  store/ (SQLite / MySQL)       │
│                        │                                          │
│                        ├──▶ agent/AgentGateway  ── 节点连接注册表   │
│                        └──▶ agent/RpcClient     ── 请求-响应        │
│                        │                                          │
│                        └──▶ events/EventBus     ── 推给浏览器       │
└───────────────────────┬───────────────────────────────────────────┘
                        │  WebSocket（Agent 主动外连）
        ┌───────────────┼───────────────┬───────────────┐
        ▼               ▼               ▼               ▼
   ┌─────────┐    ┌─────────┐     ┌─────────┐    ┌─────────┐
   │ survival│    │ creative│     │  skyblock│   │   …     │
   │ Agent   │    │ Agent   │     │  Agent  │    │         │
   │ LuckPerms│   │ LuckPerms│    │         │    │         │
   │ Vault   │    │ Vault   │     │ Vault   │    │         │
   └─────────┘    └─────────┘     └─────────┘    └─────────┘
```

**核心不变式：一份权威状态在平台，Agent 是无状态执行器 + 只读快照。**
唯一的例外是封禁快照，它有明确的失效语义（见 §3）。

---

## 2. 为什么不复用 Redis 队列

现有 `kokuu-credit-admin` + `exchange-bridge` 用 Redis 列表做单向队列。
管经济够用，但**队列模型有三个硬伤**，正好都是管理平台的核心场景：

| 硬伤 | 队列下的表现 | 管理平台需要什么 |
|---|---|---|
| 没有回执 | `BRPOP` 取走即消失，Agent 崩溃 = 消息永久丢失 | 改权限要**知道成功没有**，失败要报错给操作人 |
| 没有请求-响应 | 「查在线玩家」没法表达 | 大量操作是「查询后展示」 |
| 没有推送 | 只能轮询 | 控制台日志、在线人数、TPS 要**实时** |

队列能表达「执行一个副作用」，表达不了「读取一个值」。
所以管理平台换成长连接上的 RPC。

**但经济模块不推倒重来。** `exchange-bridge` 的队列路径继续可用：
Blessing Skin 皮肤站是既成事实的调用方，它走 HTTP → 平台 → Redis 队列
这条路不动；同时 Agent 新增 `economy.adjust` RPC 供平台直接调用。
两条路共用 Agent 侧同一个执行器核心（幂等缓存、Vault 调用、主线程切换），
所以不会出现「两条路行为不一致」。

---

## 3. 权威模型：封禁为什么在平台侧

多服场景下最典型的投诉是「在 A 服被封的人跑去 B 服玩」。
如果封禁存在各服自己的 `banned-players.json`，这个投诉无法根治 ——
两份文件必然会漂移。

所以：

- **平台是唯一权威**。封禁记录存在平台数据库。
- **Agent 只持有快照**。连接时通过 `hello` 响应拿到全量 active 列表，
  之后每次变更收 `punish.sync` 广播。
- **登录检查读内存，不做网络请求**。`PlayerLoginEvent` 在主线程上，
  阻塞它等于卡住整个服务器。网络请求在登录路径上是不可接受的。

### 快照失效怎么处理

平台不可达时快照会过期。三种处理，按危险方向排序：

| 策略 | 断连期间新封的人 | 断连期间被解封的人 | 适用 |
|---|---|---|---|
| **fail-open（默认）** | 能进服 | 能进服 | 绝大多数服务器 |
| fail-closed | 能进服 | **被误拦** | 不接受任何漏网 |

默认 fail-open：断连时「漏放一个该封的人」比「把全服玩家挡在门外」轻。
快照带 `revision`，Agent 在 `/kp status` 里显示快照年龄；
超过 `punish.staleWarnMinutes`（默认 30）打 WARN 日志。

> 这是**刻意的取舍**，不是没实现好。要 fail-closed 就在
> `agent.yml` 里显式打开，并接受它带来的误拦。

---

## 4. 跨版本策略（这是本项目最难的部分）

服务端 API 在 1.12.2 → 1.21 之间变化极大。策略分四层：

### 4.1 字节码：Java 8

编译到 Java 8 字节码。**字节码兼容是单向的** —— Java 8 字节码能在所有
更高运行时上跑，反过来直接 `UnsupportedClassVersionError`。
构建机是 JDK 25，用 `--release 8` 压下去。

> ⚠️ `--release 8` 在 JDK 25 上**已弃用**（会有警告，未来版本移除）。
> 真到那天，退路是改 `--release 11` 并放弃 1.12.2（那是 Java 8 时代）。

### 4.2 `plugin.yml` 的 `api-version: 1.13`

1.12.2 用 Properties 加载 `plugin.yml`，会**忽略**它不认识的键；
而 1.13+ 需要它才肯加载新插件。写 `1.13` 是唯一同时满足两头的值。
（沿用 `exchange-bridge` 已验证的做法。）

### 4.3 依赖：编译期探针 + 运行期软依赖

| 依赖 | 方式 | 理由 |
|---|---|---|
| Bukkit / Paper API | `provided` | 服务端自带 |
| Vault API | `provided` + `softdepend` | API 极稳定，十年没破坏性变更 |
| LuckPerms API 5.x | `provided` + `softdepend` | 5.x 支持 MC 1.8+ 且是 Java 8 字节码，覆盖面足够 |
| Java-WebSocket | **shade** | Java 8 没有内置 WebSocket 客户端 |
| Gson | **shade** | JSON 编解码 |

> ⚠️ **LuckPerms 的 Maven 坐标是 `net.luckperms:api:5.4`，不是
> `net.luckperms:luckperms-api`** —— 后者在 Maven Central 上根本不存在
> （这条是实测踩出来的，写 pom 时别再照直觉拼）。
> 版本区间 Central 上有 5.0–5.5。

**不硬依赖**：`softdepend` + 运行时三步探测（插件在不在 → `net.luckperms.api`
包在不在 → 桥接类能否构造）。没装 LuckPerms 就不声明 `luckperms` capability，
平台前端自动隐藏入口 —— 用户看不到点了会报错的功能。
运行期再遇到 `LinkageError` 也会**永久降级**成 `NO_LUCKPERMS`，
而不是让每次调用都抛一次。

> LuckPerms **4.x 不支持**（API 完全不同）。启动时探测版本，
> 不兼容就明确报错而不是抛 `NoSuchMethodError`。
> 这是有意的取舍：为 2018 年的老版本维护两套反射调用，
> 维护成本远大于收益。

### 4.4 能力探测优先于版本判断

```java
// 好：探测能力
boolean hasTps = server.getTPS() != null;

// 坏：判断版本号
if (mcVersion >= 1.16) { ... }
```

版本判断在每个小版本上都会被打破（Paper 会把新 API backport 到老版本，
Purpur 又不一样）。探测能力是唯一稳的做法。TPS 采集就是例子：
Paper 有 `getTPS()`，1.12.2 Spigot 没有 —— 用 tick 计数的降级实现，
取不到就给 `null` 而不是编一个假值。

---

## 5. 主线程调度

Bukkit 的玩家 / 世界 API **只能在主线程调用**。Agent 的 WS 线程收到请求后：

```java
Future<T> call = new FutureTask<>(() -> handleOnMainThread(params));
Bukkit.getScheduler().runTask(plugin, call);
return call.get(timeoutMs, MILLISECONDS);   // 阻塞 WS 线程，不阻塞主线程
```

三个必须注意的点：

1. **阻塞的是 WS 读线程，不是主线程。** 每个连接一个读线程，
   主线程只做任务体的执行。
2. **带超时**。主线程卡住（插件死循环）时，WS 线程不能跟着永久阻塞 ——
   超时返回 `TIMEOUT`，平台侧看到明确的错误而不是无限等待。
3. **关服时 `runTask` 会抛 `IllegalStateException`**（scheduler 已停止），
   必须捕获并返回 `INTERNAL`，不能让异常吃掉响应导致平台侧等满超时。

---

## 6. 存储

> ⚠️ **本节的账本部分是错的，已被 [`ECOSYSTEM.md`](ECOSYSTEM.md) 推翻。**
>
> 平台**不应**自建 `economy_accounts` / `economy_ledger`：
> kokuu 生态里已经有唯一账本（Blessing Skin 的 `users.score` +
> `credit_ledger`），自建第二个余额正是 `kokuu-credit` 与 `kokuu-coupon`
> 的 README 反复警告的「两个真相源」。
>
> 玩家身份的锚点也从 MC UUID 改成 Blessing Skin 的 `pid`
> （一个账号可以有多个角色，且 UUID 可能随角色改名而变）。
>
> **读 [`ECOSYSTEM.md`](ECOSYSTEM.md) 再动这一块。**
> 下面保留原文，作为「哪些设计仍然成立」的对照。

### 6.1 驱动

接口在 `apps/server/src/store/`，两个实现：

| 驱动 | 用途 |
|---|---|
| **SQLite**（`node:sqlite`，Node 内置） | 默认。单机部署、开发、演示。零外部依赖 |
| MySQL | 生产 / 已有 Blessing Skin 库 |

`node:sqlite` 是 Node 24 内置模块 —— **不需要任何原生依赖编译**，
这在 `better-sqlite3` 常年卡在 node-gyp 的现实下是实质优势。

SQL 方言差异用 `store/dialect.ts` 收敛：自增主键、`UPSERT` 语法、
时间类型三处不同，其余 SQL 两边共用。

### 6.2 表

| 表 | 权威内容 |
|---|---|
| `accounts` | 后台登录账号 |
| `nodes` | 纳管的 MC 服务端（含密钥哈希、能力、最后心跳） |
| `players` | 玩家主档（UUID 为键） |
| `player_names` | 曾用名历史 |
| `player_ips` | 登录 IP 历史 |
| `player_sessions` | 上下线记录（在线时长来源） |
| `punishments` | 封禁 / 禁言 / 警告（**权威**） |
| `economy_accounts` | 站点积分余额 |
| `economy_ledger` | 积分流水 |
| `config` | 键值配置（兑换比例等） |
| `audit_log` | 所有写操作的审计 |

### 6.3 从 kokuu-credit-admin 迁移

> ⚠️ **这一节的前提已被推翻。** 原文设想「把旧账本迁进平台」，
> 但正确做法是**不迁移账本**——只把管理界面并过来，
> 账本仍留在皮肤站。详见 [`ECOSYSTEM.md`](ECOSYSTEM.md) §3 与 §5。

原文记载的三条原则本身**依然成立**，而且现在要落到「怎么安全地读写
**别人那个**账本」上，而不是「怎么建一个新账本」：

1. 事务 + 行锁
2. `event_id` 唯一索引做幂等
3. 余额一律从库里读，**不信任调用方传入的余额**

`local-ledger.js` / `skin-ledger.js` / `ledger.js` 的三层结构里，
只有 `skin-ledger.js`（读写皮肤站账本）那一层是有价值的 ——
它正是平台应该做的事。另两层（自带账本）应当废弃。

---

## 7. 安全

| 面 | 措施 |
|---|---|
| 节点密钥 | 只在创建时显示一次；库里存哈希（`scrypt`），不存明文 |
| 传输 | 生产必须 `wss://` + `https://`。密钥在 `hello` 里明文传输 |
| 后台登录 | `scrypt` 密码哈希 + HttpOnly Cookie 会话 + CSRF token |
| 权限 | 角色 → 权限点映射；每个写接口单独校验 |
| 命令注入 | 平台侧**不允许**把用户输入拼进控制台命令。`console.execute` 只对持有 `console.execute` 权限点的账号开放，且写审计 |
| 玩家名污染 | 白名单正则 `^[A-Za-z0-9_]{1,16}$` |
| UUID 污染 | 严格 UUID 格式 + 排除全 0（「从未上线」的假 UUID 会把不同玩家合并成一个账号） |
| 幂等 | 经济 `eventId` 唯一索引；封禁 `id` 为主键 |
| 审计 | 每个写操作落 `audit_log`，含操作者、IP、参数、结果 |
| 限流 | 登录按 IP 限流；`console.execute` 按账号限流 |

**唯一不设防的地方是 Agent→平台方向的事件**：Agent 被认为可信
（它持有节点密钥）。平台对事件内容仍做长度截断与转义，
但**不**校验「这个玩家真的在线吗」这类语义 —— 那会让事件处理变重，
而事件本来就只用于观察。

---

## 8. 分期

### 已完成（当前仓库）

- Agent 协议 v1（`docs/PROTOCOL.md`）
- 共享协议包（`packages/protocol`）
- 后端：Agent 网关、RPC、REST、鉴权（本地账号 + 皮肤站 OAuth2）、审计、SQLite
- **身份锚点**：皮肤站角色目录（`characters` 表），封禁按 `pid` 存 —— **扛得住改名**。
  解析不出角色时明确告警，并把风险暴露成 `renameBypassable` 计数
- 前端：节点、玩家、封禁、LuckPerms、经济、审计、账号
- Java Agent：WS 客户端、握手、心跳、RPC 分发、六个功能模块
  （已产出可加载的 `kokuu-agent-1.0.0.jar`，Java 8 字节码）
- 模拟 Agent（`tools/mock-agent.mjs`）：无 MC 服务端也能端到端演示
- 验证：43 项不变量测试、44 项端到端、11 项静态托管
- 对接契约（[`ECOSYSTEM.md`](ECOSYSTEM.md)）：表结构与接口**在实测环境上核实过**

### 后续（按价值排序）

1. **物品栏 / 末影箱查看** —— 需要 NBT 序列化，且格式跨版本差异大，
   是纯技术难点。方案：Agent 侧用 Bukkit 的 `ItemStack` 序列化，
   平台不做结构解析，只做展示与「删除某格」这类粗粒度操作
2. **目录同步自动化** —— 现在是手工或 `cron` 跑 `import-characters.mjs`；
   下一步内置定时任务（做法已写在 `ECOSYSTEM.md §5b`）
3. **实时控制台全量日志** —— 通道已经有了，缺的是采样策略与前端虚拟滚动
4. **性能图表** —— 需要一个时间序列表（现在只有瞬时值）
5. **任务调度**（定时重启、定时公告）
6. **MySQL 驱动** —— 单机 SQLite 够用，多实例部署要换
7. **拆掉自建账本**（`economy_accounts` / `economy_ledger`）——
   默认已按 `external` 模式回 501，但表还在，等积分对接方案定了一起删

### 明确不做

- **不接管服务端启动 / 停止**。那要求平台能操作宿主机进程，
  把「一个 Web 应用被攻破」的后果从「数据泄露」升级成「服务器被控」。
  真需要就用现成的容器编排面板（Pterodactyl 等），本平台专注于
  「服务器已经在跑」之后的管理。
- **不做聊天室 / 论坛**。那是另一个产品，塞进来只会让两边都做不好。
