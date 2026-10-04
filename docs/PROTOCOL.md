# KokuuPanel Agent 协议 v1

平台与 MC 服务端之间**唯一**的通信契约。后端（`apps/server`）、插件（`agent/`）、
以及测试用的模拟 Agent（`tools/mock-agent.mjs`）都必须按本文实现。

> 改这个文件之前先想清楚：三端各有一份实现，改一处不改另两处就是线上故障。

---

## 1. 为什么是「插件主动外连」

| | 插件主动外连（本方案） | 平台反连插件 HTTP |
|---|---|---|
| MC 侧开放端口 | **不需要** | 每台机器都要对外开一个口 |
| 防火墙 / NAT / 家宽 | 直接可用 | 要端口映射，玩家自建服基本做不到 |
| 实时推送（日志、事件） | 长连接天然支持 | 要轮询或 SSE |
| 请求-响应语义 | 同一个连接上带 `id` 即可 | 要另建一套 |
| 平台地址变更 | 改插件 `config.yml` 重启 | 改平台侧配置 |

MC 服务端绝大多数跑在 NAT 后面。**只有主动外连这一条路是普适的**，
所以协议建立在插件的出站长连接上。

---

## 2. 连接与握手

- **端点**：`GET {panelUrl}/agent`，标准 WebSocket upgrade
- **子协议**：不使用，纯 JSON 文本帧
- **TLS**：生产环境必须 `wss://`。节点密钥在 `hello` 里明文传输，走 `ws://` 等于裸奔

### 握手时序

```
Agent                                     Server
  │──── WS upgrade ─────────────────────────>│
  │──── {"type":"request","method":"hello"} ─>│   必须在 5s 内发出
  │<─── {"type":"response","ok":true,...} ───│   含 heartbeatInterval / capabilities
  │<═══ 双向请求 / 事件 / 心跳 ═══════════════>│
```

`hello` **必须**是连接建立后的第一个帧。服务端在收到 `hello` 之前
不接受任何其他帧，超时（5s）未收到则直接关闭连接。

### hello（Agent → Server）

```jsonc
{
  "type": "request",
  "id": "1",
  "method": "hello",
  "params": {
    "protocolVersion": 1,
    "nodeId": "survival-01",              // 平台创建节点时生成
    "secret": "…",                        // 平台创建节点时只显示一次
    "agent": {
      "version": "1.0.0",
      "mcVersion": "1.20.6",              // Bukkit.getBukkitVersion()
      "brand": "Paper",                   // Bukkit.getName()
      "javaVersion": "21.0.5"
    },
    "capabilities": ["console", "players", "punish", "whitelist", "luckperms", "economy"]
  }
}
```

`capabilities` 是**能力自述**：插件没装 LuckPerms 就不该报 `luckperms`。
平台据此在前端隐藏对应入口，而不是让用户点了才报错。

### hello 响应（Server → Agent）

握手失败用 `ok:false` + `error.code`：

| code | 含义 | Agent 行为 |
|---|---|---|
| `UNAUTHORIZED` | nodeId 不存在或 secret 错 | 记 ERROR 日志，退避重连（最长 5min） |
| `PROTOCOL_MISMATCH` | 协议版本不兼容 | 记 ERROR 并**停止重连**，提示升级插件 |
| `NODE_DISABLED` | 节点被平台停用 | 记 WARN，退避重连 |

成功后：

```jsonc
{
  "type": "response", "id": "1", "ok": true,
  "result": {
    "protocolVersion": 1,
    "sessionId": "…",
    "heartbeatIntervalMs": 15000,
    "serverTime": 1735000000000,
    "capabilities": ["console","players","punish","whitelist","luckperms","economy"],
    "punish": { "revision": 42, "active": [ /* Punishment[] */ ] },
    "economy": { "backend": "vault", "currency": "金币" }
  }
}
```

**握手上直接下发封禁快照**，而不是让 Agent 再发一次请求 —— 少一个往返，
且保证「连上就一定拿到了当前封禁状态」这个不变量。

---

## 3. 帧格式

三个类型，都有 `type` 字段。

### 请求（双向）

```jsonc
{ "type": "request", "id": "7f3a…", "method": "players.list", "params": { } }
```

`id`：请求方生成的字符串，**只在发起方一侧唯一**。两边各自维护 id 空间，
不共享。实现上用递增整数即可（协议不要求 UUID）。

### 响应

```jsonc
{ "type": "response", "id": "7f3a…", "ok": true,  "result": { } }
{ "type": "response", "id": "7f3a…", "ok": false, "error": { "code": "NOT_FOUND", "message": "玩家不在线", "data": {} } }
```

### 事件（单向，无 `id`，不回响应）

```jsonc
{ "type": "event", "event": "player.join", "ts": 1735000000000, "data": { } }
```

### 心跳

平台每 `heartbeatIntervalMs` 发一个 `ping` **请求**，Agent 用**普通的
response 帧**回答它（没有单独的 `pong` 方法）。**连续 3 次未回即判定节点离线**
（`15s × 3 = 45s` 内发现掉线）。Agent 侧同样在超时未收到 `ping` 时主动重连 ——
防止半开连接（TCP 已断但对端未感知，表现为「平台显示在线但所有操作超时」）。

> ⚠️ **双方都必须把「收到任何一帧」视为存活证据**，而不是只认 `ping` 的响应。
> 心跳衡量的是「对端还在不在」，不是「它答了哪一题」。
>
> 这不是理论问题：早期实现里平台只在收到名为 `pong` 的事件时重置计数，
> 而 Agent 回的是 `ping` 的 response —— 计数永不归零，连接每 60 秒被
> 服务端以「心跳超时」踢掉一次。因为自动重连很快，界面上几乎看不出异常，
> 只在插件日志里留下每分钟一条的 `connection closed`。
> 「对端卡住」是另一种故障，由 RPC 超时单独发现，不该混进心跳。

---

## 4. 错误码

| code | 何时返回 |
|---|---|
| `UNAUTHORIZED` | 密钥错误 / 会话失效 |
| `PROTOCOL_MISMATCH` | 协议版本不兼容 |
| `NODE_DISABLED` | 节点被停用 |
| `INVALID_PARAMS` | 参数校验失败（`data.issues` 带明细） |
| `NOT_FOUND` | 目标玩家 / 组 / 封禁记录不存在 |
| `NOT_ONLINE` | 操作要求玩家在线，但不在线 |
| `UNSUPPORTED` | 节点未声明该 capability |
| `NO_LUCKPERMS` | 服务端没装 LuckPerms 或版本不兼容 |
| `NO_ECONOMY` | 没有可用的 Vault 经济后端 |
| `READ_ONLY` | 节点处于只读模式（配置项） |
| `CONFLICT` | 幂等键冲突 / 并发修改 |
| `RATE_LIMITED` | 触发限流 |
| `TIMEOUT` | 请求超时。**两侧都可能产生**，见下面说明 |
| `INTERNAL` | Agent 内部异常，`message` 带堆栈摘要 |

> **关于 `TIMEOUT` 的归属**（曾在本仓库的文档里自相矛盾过，这里定死）：
>
> 两侧都会产生这个错误码，语义是「这次操作没能在期限内得到结果」，
> 而**不是**「只有平台会返回它」：
>
> | 产生方 | 场景 | 调用方看到的 |
> |---|---|---|
> | 平台 | 等 Agent 响应超过 RPC 超时（默认 10s） | 请求被 reject，`code: TIMEOUT` |
> | Agent | 主线程执行体超过自己的等待上限（例：LuckPerms 保存等待 5s） | `ok:false` + `code: TIMEOUT` |
>
> Agent **必须**自己也有超时：主线程被别的插件卡住时，它不能跟着永久阻塞 ——
> 那会让平台侧看到的是「等满超时」而不是一个明确的失败原因。
> 对调用方而言两者含义相同，**不需要区分**；但排查时要看日志是哪一侧报的。

**Agent 侧执行失败必须返回 `ok:false`，不允许「指挥台吞掉错误当成功」。**
平台的审计日志记的是真实结果。

---

## 5. 平台 → Agent 方法

所有方法都要求 agent 侧在主线程执行（Bukkit 玩家 API 不是线程安全的）。
实现方式见 `docs/ARCHITECTURE.md` 的「主线程调度」。

### 5.1 系统

| method | params | result |
|---|---|---|
| `ping` | `{}` | `{ "nonce": "…" }` |
| `server.info` | `{}` | `ServerInfo` |
| `server.metrics` | `{}` | `Metrics`（主动拉取；常规推送走 `server.metrics` 事件） |
| `console.execute` | `{ "command": "say hi" }` | `{ "success": true, "output": ["…"] }` |

`ServerInfo`：
```jsonc
{ "name":"Survival", "brand":"Paper", "version":"1.20.6-R0.1-SNAPSHOT",
  "bukkitVersion":"1.20.6-R0.1-SNAPSHOT", "port":25565, "onlineMode":true,
  "maxPlayers":100, "viewDistance":10, "motd":"…",
  "plugins":[{"name":"LuckPerms","version":"5.4.102"}],
  "worlds":[{"name":"world","environment":"NORMAL","players":12,"entities":1043,"chunks":441}],
  "whitelistEnabled":true }
```

`Metrics`：
```jsonc
{ "tps":[20.0,19.98,19.95], "mspt":4.2, "online":12, "maxPlayers":100,
  "memory":{"used":2147483648,"max":4294967296,"free":2147483648},
  "threads":58, "uptimeSeconds":86400,
  "entities":1043, "chunks":441 }
```

> `tps` / `mspt` 取不到时给 `null`，不要填假值。1.12.2 没有 `getTPS()`，
> 走 `TicksPerSecond` 计数的降级实现（见架构文档）。

### 5.2 玩家

| method | params | result |
|---|---|---|
| `players.list` | `{ "withIp": false }` | `Player[]` |
| `players.detail` | `{ "uuid": "…" }` | `Player` |
| `players.kick` | `{ "uuid":"…", "reason":"…" }` | `{ "ok": true }` |
| `players.setOp` | `{ "uuid":"…", "value": true }` | `{ "ok": true }` |
| `players.setGamemode` | `{ "uuid":"…", "gamemode":"CREATIVE" }` | `{ "ok": true }` |
| `players.setWhitelist` | `{ "uuid":"…", "name":"…", "value": true }` | `{ "ok": true }` |
| `players.resolve` | `{ "name": "Steve" }` | `{ "uuid":"…", "name":"Steve", "online":true }` |

`Player`：
```jsonc
{ "uuid":"069a79f4-44e9-4726-a5be-fca90e38aaf5", "name":"Notch",
  "displayName":"Notch", "online":true,
  "world":"world", "x":0.5, "y":64.0, "z":0.5,
  "ping":32, "gamemode":"SURVIVAL", "health":20.0, "food":20, "level":30,
  "op":false, "whitelisted":true,
  "ip":"203.0.113.7",                    // 仅 withIp=true 时返回，需权限
  "firstPlayed":1735000000000, "lastSeen":1735000000000, "playtimeSeconds":36000 }
```

> **`withIp` 默认 false。** 玩家 IP 属于个人信息，只有显式需要时才传输，
> 且平台侧单独做权限校验。默认关掉可以让「不小心把 IP 打进日志」的概率降到零。

### 5.3 封禁 / 禁言

平台是**唯一权威**。Agent 不自己维护封禁表，只持有平台下发的快照。

| method | params | result |
|---|---|---|
| `punish.apply` | `{ "punishment": Punishment }` | `{ "ok": true }` |
| `punish.revoke` | `{ "id": "…" }` | `{ "ok": true }` |
| `punish.kickNow` | `{ "uuid":"…", "reason":"…" }` | `{ "ok": true }`（封禁后把人踢下线） |

`Punishment`：
```jsonc
{ "id":"p_01H…", "type":"ban",          // ban | mute | warn | kick
  "uuid":"069a79f4-…", "name":"Notch",
  "reason":"使用作弊客户端", "operator":"admin",
  "nodeId":null,                         // null = 全平台生效；否则只在该节点生效
  "createdAt":1735000000000,
  "expiresAt":null,                      // null = 永久
  "active":true }
```

**为什么封禁不放 Agent 侧**：多服场景下「在 A 服封的人在 B 服还能玩」是
最典型的投诉。权威放平台，Agent 只做执行，才能保证跨服一致。

**下发链路**：
1. 平台写库（权威）
2. 向所有相关节点发 `punish.apply`
3. 平台广播事件 `punish.sync`，携带新的 `revision` 与**完整** active 列表

第 3 步故意发全量而非增量：快照小（通常几十条），全量发送让
「Agent 本地状态」永远可以自愈，不必处理丢包后的增量缺口。

### 5.4 白名单

| method | params | result |
|---|---|---|
| `whitelist.list` | `{}` | `[{ "uuid":"…", "name":"…" }]` |
| `whitelist.setEnabled` | `{ "value": true }` | `{ "ok": true }` |

增删白名单走 `players.setWhitelist`（按玩家维度，语义更清楚）。

### 5.5 LuckPerms

未声明 `luckperms` capability 时，全部返回 `NO_LUCKPERMS`。

| method | params | result |
|---|---|---|
| `luckperms.user.get` | `{ "uuid":"…", "name":"…" }` | `LpUser` |
| `luckperms.user.setPrimaryGroup` | `{ "uuid":"…", "group":"vip" }` | `{ "ok":true, "changed":true }` |
| `luckperms.user.addGroup` | `{ "uuid":"…", "group":"vip" }` | `{ "ok":true, "changed":true }` |
| `luckperms.user.removeGroup` | `{ "uuid":"…", "group":"vip" }` | `{ "ok":true, "changed":true }` |
| `luckperms.user.setPermission` | `{ "uuid":"…", "permission":"x.y", "value":true }` | `{ "ok":true, "changed":true }` |
| `luckperms.user.unsetPermission` | `{ "uuid":"…", "permission":"x.y" }` | `{ "ok":true, "changed":true }` |
| `luckperms.user.setMeta` | `{ "uuid":"…", "prefix":"…", "suffix":"…" }` | `{ "ok":true, "changed":true }` |
| `luckperms.groups.list` | `{}` | `LpGroup[]` |
| `luckperms.group.create` | `{ "name":"vip" }` | `{ "ok":true, "changed":true }` |
| `luckperms.group.delete` | `{ "name":"vip" }` | `{ "ok":true, "changed":true }` |
| `luckperms.group.setPermission` | `{ "name":"vip","permission":"x.y","value":true }` | `{ "ok":true, "changed":true }` |
| `luckperms.group.unsetPermission` | `{ "name":"vip","permission":"x.y" }` | `{ "ok":true, "changed":true }` |
| `luckperms.group.setParent` | `{ "name":"vip","parent":"default" }` | `{ "ok":true, "changed":true }` |
| `luckperms.group.removeParent` | `{ "name":"vip","parent":"default" }` | `{ "ok":true, "changed":true }` |
| `luckperms.group.setWeight` | `{ "name":"vip","weight":10 }` | `{ "ok":true, "changed":true }` |
| `luckperms.group.setMeta` | `{ "name":"vip","prefix":"…","suffix":"…" }` | `{ "ok":true, "changed":true }` |

`LpUser`：
```jsonc
{ "uuid":"…", "name":"Notch",
  "primaryGroup":"default",
  "groups":[ { "name":"default", "weight":0, "direct":true },
             { "name":"vip",     "weight":10, "direct":true } ],
  "permissions":[ { "key":"essentials.fly", "value":true, "direct":true },
                  { "key":"essentials.heal", "value":false, "direct":true } ],
  "meta": { "prefix":"[VIP] ", "suffix":"", "weight":0 },
  "inheritedPermissionsCount": 218 }
```

`LpGroup`：
```jsonc
{ "name":"vip", "displayName":"VIP", "weight":10,
  "parents":["default"],
  "permissions":[ { "key":"essentials.fly", "value":true } ],
  "meta": { "prefix":"[VIP] ", "suffix":"" },
  "userCount": 37 }
```

> **所有写操作返回 `changed`**：`false` 表示「本来就是这个值」，没有实际改动。
> 平台据此决定审计日志记「已修改」还是「无需修改」，
> 避免审计表被无意义的重复提交灌满。

> **`userCount` 可能为 `null`**：统计全量用户开销大，Agent 可选实现。
> 前端必须能处理 `null`（显示 `—`），不能崩。

### 5.6 经济（Vault）

| method | params | result |
|---|---|---|
| `economy.getBalance` | `{ "uuid":"…", "name":"…" }` | `{ "balance": 12345.0, "currency":"金币", "backend":"vault" }` |
| `economy.adjust` | `{ "uuid":"…","name":"…","amount":1000.0,"note":"活动补发","eventId":"…" }` | `{ "ok":true, "balanceAfter":13345.0 }` |

`amount` 为正加负减。`eventId` 为**幂等键**，Agent 必须缓存已处理的
`eventId`（TTL ≥ 24h）并拒绝重复执行 —— 网络重试不能变成发两遍钱。

---

## 6. Agent → 平台方法

| method | params | result |
|---|---|---|
| `player.resolve` | `{ "uuid":"…", "name":"…" }` | `{ "uuid":"…", "name":"…", "known":true, "punishments":[…] }` |
| `punish.snapshot` | `{}` | `{ "revision":42, "active":[ Punishment ] }` |
| `economy.stats` | `{}` | 平台侧经济统计（供 `/kp status` 展示） |

`player.resolve` 的用途：游戏内 `/kp info <player>` 需要「平台知道的全名与历史」，
而 Bukkit 只能给当前名字。**改名玩家在平台侧能找到历史名**，这是
「UUID 作身份锚点」这个设计在插件侧的兑现。

---

## 7. Agent → 平台事件

| event | data |
|---|---|
| `player.join` | `{ "uuid":"…","name":"…","ip":"…" }` |
| `player.quit` | `{ "uuid":"…","name":"…","playtimeSeconds":3600 }` |
| `player.chat` | `{ "uuid":"…","name":"…","message":"…" }` |
| `player.death` | `{ "uuid":"…","name":"…","cause":"…","killer":"…" }` |
| `player.command` | `{ "uuid":"…","name":"…","command":"/home" }` |
| `console.line` | `{ "line":"…","level":"INFO" }` |
| `server.metrics` | `Metrics`（每 `metricsIntervalSeconds`，默认 10s） |
| `punish.applied` | `Punishment`（游戏内 `/kp ban` 触发） |
| `punish.revoked` | `{ "id":"…" }` |
| `punish.sync` | `{ "revision":42, "active":[ Punishment ] }`（平台 → Agent，见 §5.3） |
| `whitelist.changed` | `{ "enabled": true }` |
| `agent.log` | `{ "level":"WARN","message":"…" }` |

**事件不保证送达、不重传。** 事件用于「观察」而非「记账」：
平台重启期间丢掉的 join/quit 只会让在线时长统计少一段，
不会造成资金或封禁状态不一致。所有**需要保证**的状态都走请求-响应。

`console.line` 有采样与限流：单连接每秒最多 200 行，超出丢弃并
在下一条里带 `"dropped": N`。**默认关闭**（`agent.yml` 的
`events.console: false`）—— 全量转发日志在活动服务器上会打满带宽。

---

## 8. 版本与兼容

- 协议版本在 `hello` 里交换，**不做向后兼容**：不匹配直接
  `PROTOCOL_MISMATCH` 并停止重连。理由见架构文档「为什么协议不妥协」。
- 新增方法属于**次版本**变更，老 Agent 遇到不认识的方法返回
  `UNSUPPORTED` 即可，不需要升级。
- 修改已有方法的参数或语义属于**主版本**变更，两端必须同时升级。

Agent 对未知方法**必须**返回 `UNSUPPORTED` 而不是静默忽略 ——
静默忽略会让平台侧等满超时才失败，运维排查时看到的只有「卡住」。
