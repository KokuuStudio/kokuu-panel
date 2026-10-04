# KokuuPanel

综合性 Minecraft Java 版服务器管理平台。

从 [kokuu-credit-admin](https://github.com/KokuuStudio/kokuu-credit-admin)（只管经济）  
与 [exchange-bridge](https://github.com/KokuuStudio/exchange-bridge)（只在游戏侧执行）扩展而来，  
把「管钱」升级成「管服务器」。

```
浏览器 ──HTTP/WebSocket──▶ 平台后端 ◀──WebSocket（插件主动外连）── MC 服务端 Agent
```

---

## 目录

- [⚠️ 关于经济模块的重要修正](#️-关于经济模块的重要修正)
- [它能做什么](#它能做什么)
- [和现有仓库的关系](#和现有仓库的关系)
- [快速开始](#快速开始)
- [配置](#配置)
- [验证](#验证)
- [架构](#架构)
- [目录结构](#目录结构)
- [安全](#安全)
- [跨版本支持](#跨版本支持)
- [路线图](#路线图)
- [License](#license)

---

## ⚠️ 关于经济模块的重要修正

**当前代码里的经济模块需要改造，改造方案见 [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md)。**

读完 KokuuStudio 现有仓库的 README 与 Blessing Skin 源码后，  
我发现本仓库早期把经济做成了**平台自带的账本**，而这与生态里已确立的纪律冲突：

|        | 现状                                         | 应该是                                                                    |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------- |
| 积分账本   | 平台自建 `economy_accounts` / `economy_ledger` | **不自建**。唯一账本是皮肤站的 `users.score` + `credit_ledger`（由 `kokuu-credit` 维护） |
| 玩家身份锚点 | MC UUID                                    | Blessing Skin 的 **`pid`**（一个账号可有多个角色；UUID 可能随改名而变）                     |
| 后台登录   | 平台自建用户名口令                                  | 优先接 `kokuu-credit` 的 **OAuth2**                                        |

理由直接来自你自己的文档：

> 账本只有一份，就不会有「两边余额对不上」的问题。 —— `kokuu-credit`
>
> 本插件只读这个配置，不写它。两个插件若各写各的，会出现「兑换插件按 100 拦、  
> 抽奖按 0 拦」，把余额扣穿。 —— `kokuu-coupon`（讲共享底仓 `min_keep`）

平台自建账本正是这条纪律要防的事。**装上它就会立刻多出第二个余额。**

**除此之外的模块不受影响**，而且它们才是平台真正的价值 ——  
封禁、LuckPerms、控制台、性能、审计，全都在  
「Blessing Skin 管不到的那一半」里：

| 平台的能力               | 现有生态里的状态                            |
| ------------------- | ----------------------------------- |
| 跨服一致的封禁 / 禁言        | 只在各服 `banned-players.json` 里，多服必然漂移 |
| LuckPerms 权限组管理     | 只能敲命令，没有界面                          |
| 实时控制台 / 在线玩家 / 性能指标 | 空白                                  |
| **操作审计**            | 皮肤站记积分流水，但没人记「谁在哪个服封了谁、改了什么权限」      |
| 玩家档案聚合              | 要看「这个人」得同时开皮肤站后台 + 进游戏敲命令           |

**在按 [ECOSYSTEM.md](docs/ECOSYSTEM.md) 改造之前，请勿把经济模块接到生产。**

---

## 它能做什么

| 模块            | 能力                                                  |
| ------------- | --------------------------------------------------- |
| **节点**        | 纳管多台 MC 服务端，实时在线状态、能力探测、插件与世界列表、TPS/MSPT/内存指标       |
| **玩家**        | 在线列表、玩家档案、曾用名、IP 历史、上下线记录与在线时长、踢出 / OP / 游戏模式 / 白名单 |
| **身份锚点**      | 以 Blessing Skin 角色 `pid` 为准 —— **封禁扛得住改名**（见下）      |
| **封禁**        | 封禁 / 禁言 / 警告，全平台或按节点生效，定时到期自动解除，跨服一致                |
| **LuckPerms** | 组列表与权重、继承关系、权限节点、前缀后缀；玩家主组与直接权限                     |
| **经济**        | 游戏内货币下发（Vault）；站点积分**不自建账本**，接现有的唯一账本               |
| **审计**        | 每一次写操作落库：谁、什么时候、从哪个 IP、对谁、参数、成功还是失败                 |
| **实时**        | 浏览器 WebSocket：节点上下线、玩家上下线、聊天、控制台日志                  |
| **鉴权**        | 皮肤站 OAuth2（`permission ≥ 2`）或本地账号回退 + 14 个权限点       |

### 为什么「身份锚点」是独立一行

实测确认（见 [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md)）：本站的 Yggdrasil 用  
**UUID v3**，即 `uuid = md5("OfflinePlayer:" + 角色名)`。  
所以**名字与 UUID 是等价标识 —— 玩家改个名，两个一起变**。

按 UUID 存封禁的后果很具体：**玩家改个名就绕过了**，而管理员只会看到  
「封禁莫名其妙丢了」。平台上还看不出异常。

唯一稳定的身份是 Blessing Skin 的 `players.pid`。所以：

```bash
# 从皮肤站导出角色目录（工具会告诉你 SQL 怎么写）
node tools/import-characters.mjs --print-sql
node tools/import-characters.mjs --file characters.tsv
```

导入后，封禁按 `pid` 存，改名也拦得住。**解析不出角色时会明确告警**，  
不会默默存一条看起来正常、实际能被绕过的封禁。

`GET /_api/characters/status` 的 `renameBypassable` 把这个风险暴露成数字 ——  
它 > 0 就说明有封禁可以被改名绕过。

### 四个刻意的设计决定

**1. 插件主动外连，MC 侧不开任何端口。**  
绝大多数服务器在 NAT 后面（家宽、云主机安全组、容器网络）。只有主动外连  
这一条路是普适的，这也是现有 Redis 队列方案思路的延续。

**2. 封禁的权威在平台，不在服务端。**  
「在 A 服被封的人跑去 B 服玩」是多服场景最典型的投诉。如果封禁存在各服  
自己的 `banned-players.json`，两份文件必然漂移。所以平台是唯一权威，  
Agent 只持有可失效的内存快照 —— 登录检查读内存，**登录路径上不做网络请求**  
（阻塞 `PlayerLoginEvent` 等于卡住整个服务器）。

**3. 经济账本沿用已被生产验证的三条原则。**  
事务 + 行锁；`event_id` 唯一索引做幂等；余额一律从库里读，不信任调用方。  
「最小代价的取舍」写在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

**4. 矛盾配置直接拒绝写入，而不是在页面上警告。**  
现有仓库把「`min_coin < ratio`」这类会让**每一笔兑换都被拒**的配置以警告  
形式展示。这里改成 400 拒绝 —— 一个自相矛盾的配置不该进数据库。

---

## 和现有两个仓库的关系

|                                 | 现在                      | 之后                                          |
| ------------------------------- | ----------------------- | ------------------------------------------- |
| `exchange-bridge`（Java 插件）      | 只有兑换队列消费者               | 由本仓库的 Agent 取代；Redis 队列路径**仍然可用**，皮肤站集成不受影响 |
| `kokuu-credit-admin`（中间件 + 管理台） | Redis 队列 + MySQL + 独立前端 | 经济成为本平台的一个模块；队列换成能带回执的 Agent RPC            |
| 新能力                             | 无                       | 玩家、封禁、LuckPerms、控制台、审计、实时事件                 |

**没有推倒重来。** 皮肤站（Blessing Skin）是既成事实的调用方，  
它走 `HTTP → 平台 → Redis 队列` 这条路不动；平台同时新增  
Agent RPC 直连路径。两条路共用 Agent 侧同一个执行器核心  
（幂等缓存、Vault 调用、主线程切换），所以不会出现行为不一致。

迁移步骤见 [docs/MIGRATION.md](docs/MIGRATION.md)。

---

## 快速开始

### 依赖

- **Node.js ≥ 22.5**（用到了内置 `node:sqlite`）
- **pnpm 11**
- 不需要 MySQL、不需要 Redis、不需要编译工具链

### 三步跑起来

```bash
git clone <本仓库>
cd kokuu-panel

pnpm install

# 1) 建管理员（口令省略时会随机生成并打印一次）
node apps/server/src/cli/seed.ts user admin

# 2) 建一个节点，记下打印出来的密钥（只显示一次）
node apps/server/src/cli/seed.ts node survival-01 生存服

# 3) 启动
pnpm start
```

打开 <http://127.0.0.1:8787>。

### 没有 MC 服务端也想看效果

`tools/mock-agent.mjs` 是一个**完整的协议参考实现**：老老实实握手、回心跳、  
实现全部一期方法、按周期上报事件。用它可以把平台完整跑一遍：

```bash
# 另开一个终端
node tools/mock-agent.mjs --secret <上一步的密钥> --players 8
```

界面里立刻会有在线玩家、TPS 曲线、控制台日志、可操作的 LuckPerms 组。

> 它同时是写 Java 插件时最好的对照物 —— 比读协议文档快。

### 接到真实服务端

1. 从 `agent/` 构建插件（需要 JDK 8+）：
   ```bash
   cd agent && mvn clean package
   # 产物 target/kokuu-agent-1.0.0.jar
   ```
2. 丢进服务端的 `plugins/`，启动一次生成 `plugins/KokuuAgent/config.yml`
3. 填入 `seed node` 打印的三行（`panel-url` / `node-id` / `secret`）
4. 重启服务端，控制台应出现：
   ```
   [KokuuAgent] 已连接 ws://127.0.0.1:8787/agent
   [KokuuAgent] 握手成功，能力 [console, players, punish, whitelist, luckperms, economy]
   ```

### Docker

```bash
cp .env.example .env
# 必改：KP_SESSION_SECRET、KP_ADMIN_PASSWORD
docker compose up -d
```

---

## 配置

全部走环境变量（容器里比配置文件好管）。

| 变量                                    | 默认              | 说明                                  |
| ------------------------------------- | --------------- | ----------------------------------- |
| `KP_HOST`                             | `127.0.0.1`     | 监听地址。公网部署请保持默认并前置反代                 |
| `KP_PORT`                             | `8787`          | 端口                                  |
| `KP_DATA_DIR`                         | `data`          | SQLite 库与会话密钥目录                     |
| `KP_SESSION_SECRET`                   | 自动生成            | **多实例部署必须显式设置**，否则各实例会话互不认          |
| `KP_WEB_DIST`                         | `apps/web/dist` | 前端产物路径，存在则后端直接托管                    |
| `KP_ADMIN_USER` / `KP_ADMIN_PASSWORD` | —               | 首次启动播种管理员，之后不再生效                    |
| `KP_TRUST_PROXY`                      | `0`             | 反代后面才打开。直接监听时打开 = 任何人都能伪造来源 IP      |
| `KP_LOG_LEVEL`                        | `info`          | `debug` / `info` / `warn` / `error` |

经济参数（兑换比例、限额、是否开启）在管理台的**经济 → 配置**页改，改完立刻生效。

---

## 验证

不靠人点页面确认「能跑」。

```bash
# 账本与封禁的不变量（24 个用例，内存数据库，不需要起服务）
pnpm test

# 端到端：起好服务与 mock agent 之后跑
pnpm verify --password <管理员口令>

# 静态托管：起好服务且已 pnpm build 之后跑
pnpm verify:static

# 提交前扫一遍有没有把口令/密钥写进会被提交的文件（不需要起服务）
pnpm verify:secrets
```

`pnpm verify` 覆盖 44 项，其中相当一部分是**刻意设计的边界**：

| 验证项                          | 防的是什么                     |
| ---------------------------- | ------------------------- |
| 未登录 → 401 / 缺 CSRF 头 → 403   | 双提交防护真的在工作                |
| 对离线节点操作 → 502 `NODE_OFFLINE` | 与 `NODE_ERROR` 区分（排查方向不同） |
| 命令里的换行被拒绝                    | 控制台注入                     |
| 同 `eventId` 重复调整 → 409 且余额不变 | **网络重试不会发两遍钱**            |
| `min_coin < ratio` → 400     | 矛盾配置不进库                   |
| 重复撤销封禁 → 404                 | 不静默成功                     |
| `changed:false` 路径           | 前端要能区分「已修改」与「无需修改」        |
| 平台在线数与节点上报一致                 | 平台刚装上时看不见已在线的玩家           |
| 审计含失败记录                      | 「谁试过但没成功」在排查越权时最有用        |
| **目录里没有的角色 → 封禁时明确告警**       | 不默默创建一条能被改名绕过的封禁          |
| **目录里存在的角色 → 封禁关联到 `pid`**   | 改名后封禁依然生效                 |
| 节点连接稳定 70 秒                  | 心跳计数必须在收到任何帧时重置           |

`pnpm verify` 可重复执行（幂等键与权重值按运行生成）。  
`pnpm verify:static` 另有 11 项，覆盖 SPA 回退、MIME、缓存头、  
`/_api` 未知路径不返回 HTML、目录穿越。

`pnpm verify:secrets` 是提交前的最后一道闸：`.gitignore` 只能挡**路径**，  
挡不住「把口令写进某个会被提交的源文件里」。本仓库就出过一次 ——  
`tools/verify-static.mjs` 里留了个默认口令兜底值。它退出码即结论  
（0 = 干净，1 = 有可疑内容），适合挂进 CI 或 pre-commit。

---

## 架构

三份文档，改代码前先读对应那份：

| 文档                                           | 内容                                                              |
| -------------------------------------------- | --------------------------------------------------------------- |
| [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md)       | **先读这份。** 与 kokuu 生态的对接契约：表结构、接口、`event_id` 约定、共享底仓、以及经济模块的正确做法 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 权威模型、为什么不复用 Redis 队列、跨版本策略、主线程调度、安全模型                           |
| [docs/PROTOCOL.md](docs/PROTOCOL.md)         | Agent WebSocket 协议 v1：帧格式、握手、心跳、全部方法、错误码                        |
| [docs/API.md](docs/API.md)                   | 浏览器 ↔ 平台 REST + WebSocket 契约                                    |
| [docs/MIGRATION.md](docs/MIGRATION.md)       | 从 `kokuu-credit-admin` + `exchange-bridge` 迁移（不停机、可回滚）          |

```
┌──────────────────────────────────────────────────────────────┐
│  apps/web     Vue 3 + TS + Vite + Element Plus                │
└───────────────────────┬──────────────────────────────────────┘
                        │ HTTP / WebSocket
┌───────────────────────▼──────────────────────────────────────┐
│  apps/server  Node 24 + TS + Fastify + ws                     │
│                                                               │
│    REST ──▶ services ──▶ store（node:sqlite）                  │
│                 │                                             │
│                 ├──▶ AgentGateway ── 节点连接注册表 + RPC       │
│                 └──▶ EventsHub   ── 推给浏览器                 │
└───────────────────────┬──────────────────────────────────────┘
                        │ Agent 主动外连
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   生存服 Agent     创造服 Agent     空岛服 Agent
   LuckPerms        LuckPerms        LuckPerms
   Vault            Vault            Vault
```

**核心不变式：一份权威状态在平台，Agent 是无状态执行器 + 只读快照。**  
唯一有明确失效语义的例外是封禁快照（见架构文档 §3）。

---

## 目录结构

```
kokuu-panel/
├─ apps/
│  ├─ server/            Node 24 + TS 后端
│  │  └─ src/
│  │     ├─ agent/       Agent 网关：握手、心跳、双向 RPC
│  │     ├─ events/      浏览器实时事件中枢
│  │     ├─ http/        Fastify 路由、鉴权、审计包装
│  │     ├─ store/       node:sqlite 存储 + 不变量测试
│  │     └─ cli/         seed（建账号 / 建节点）
│  └─ web/               Vue 3 + TS + Element Plus 前端
├─ packages/
│  └─ protocol/          三端共用的协议类型、方法表、zod 校验
├─ agent/                Java Agent 插件（Maven，Java 8 字节码）
├─ legacy-fix/           1.12.2 兼容补丁插件（Maven，Java 8 字节码）
│                        让 CMILib + CMI 在 1.12.2 上能解析材质，见其 README
├─ tools/
│  ├─ mock-agent.mjs     协议参考实现 + 无 MC 服务端的演示
│  ├─ scan-secrets.mjs   提交前的凭据扫描（pnpm verify:secrets）
│  └─ verify-e2e.mjs     端到端验证
└─ docs/                 架构 / 协议 / API / 迁移
```

---

## 安全

| 面    | 措施                                                   |
| ---- | ---------------------------------------------------- |
| 节点密钥 | 只在创建与轮换时显示一次；库里存 `scrypt` 哈希，找不回来只能轮换                |
| 传输   | 生产必须 `wss://` + `https://`。密钥在 `hello` 里明文传输         |
| 后台登录 | `scrypt` 密码哈希 + HttpOnly Cookie + CSRF 双提交 + 按 IP 限流 |
| 权限   | 角色 → 权限点；每个写接口显式声明所需权限，**没有默认放行**                    |
| 命令注入 | 拒绝含换行的命令；`console.execute` 单独授权并全程审计                 |
| 输入校验 | 玩家名与组名白名单正则；UUID 严格格式并排除全 0                          |
| 幂等   | 经济 `eventId` 唯一索引；封禁 `id` 为主键                        |
| 审计   | 每个写操作落库，含失败尝试；不提供删除接口                                |
| 路径穿越 | 静态托管校验解析后的路径仍在产物目录内                                  |

**明文部署的红线只有两条**，但必须守住：

1. **别把 `KP_HOST` 改成 `0.0.0.0` 就完事。** 节点密钥与会话 Cookie 都是明文  
   传输，公网环境必须前置 TLS 反代。
2. **别省 `KP_SESSION_SECRET`。** 多实例部署时各自随机生成，  
   表现为「刷新页面随机被登出」——这个现象极难排查。

---

## 跨版本支持

| 项目        | 支持范围                                                             |
| --------- | ---------------------------------------------------------------- |
| Minecraft | 1.13 ~ 最新（`plugin.yml` 的 `api-version: 1.13`；1.12.2 会忽略该键因而也能加载） |
| Java 运行时  | 8 / 11 / 17 / 21 / 25（编译为 **Java 8 字节码**，单向兼容）                   |
| 服务端       | Spigot / Paper / Purpur                                          |
| LuckPerms | **5.x**（未安装或版本不符时返回 `NO_LUCKPERMS`，不抛 `NoClassDefFoundError`）    |
| 经济        | 任何经 **Vault API** 接入的后端                                          |

**关于 LuckPerms 4.x**：API 完全不同，不支持。启动时探测版本并明确报错，  
而不是抛 `NoSuchMethodError`。这是取舍 —— 为 2018 年的老版本维护两套  
反射调用，维护成本远大于收益。

**关于 1.12.2 上的 CMI/CMILib**：CMILib 1.6+ 是按 1.13+ 写的，在 1.12.2 上  
材质反查会失败，表现为 `SkullMeta` 的 `ClassCastException` 和物品价值表大面积  
`Can't load worth value`。这不是 Agent 的问题，用 [`legacy-fix/`](legacy-fix/README.md)  
这个独立小插件修（含完整的根因分析）。

**装 LuckPerms 时注意**：`bukkit-legacy` 指的是「支持的 **MC** 版本老」，


不是「**Java** 版本老」。5.5.x 起要求 Java 11，在 Java 8 上会报
`Cannot find main class`。判断任意插件能否在 Java 8 上跑：

```bash
javap -verbose -cp <jar> <main类> | grep "major version"   # 52 = Java 8, 55 = Java 11
```

细节见 [docs/ARCHITECTURE.md §4](docs/ARCHITECTURE.md)。

---

## 路线图

### 已完成

协议 v1、共享协议包、后端（网关 / RPC / REST / 鉴权 / 审计 / SQLite）、
前端（节点 / 玩家 / 封禁 / LuckPerms / 经济 / 审计）、
Java Agent（WS 客户端 + 六个功能模块）、模拟 Agent、39 项端到端验证、24 项不变量测试。

### 接下来（按价值排序）

1. **物品栏 / 末影箱查看与编辑** —— 需要 NBT 序列化，跨版本格式差异大。
   方案：Agent 侧用 Bukkit 的 `ItemStack` 序列化，平台只做展示与粗粒度操作
2. **性能图表** —— 通道已有（`server.metrics` 事件），缺一个时间序列表
3. **MySQL 驱动** —— 单机 SQLite 够用，多实例部署需要换
4. **任务调度** —— 定时重启、定时公告
5. **控制台全量日志** —— 通道已有，缺采样策略与前端虚拟滚动
6. **多平台账号绑定**（QQ / 邮箱验证码）

### 明确不做

- **不接管服务端启动与停止。** 那要求平台能操作宿主机进程，会把
  「Web 应用被攻破」的后果从「数据泄露」升级成「服务器被控」。
  真需要就用现成的容器编排面板（Pterodactyl 等），本平台专注
  「服务器已经在跑」之后的管理。
- **不做聊天室 / 论坛。** 那是另一个产品，塞进来只会两边都做不好。

---

## License

[MIT](LICENSE) © KokuuStudio
