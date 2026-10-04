# KokuuPanel REST API

后端：`apps/server`。前端按本文对接，两端以本文为准。
Agent 协议见 [`PROTOCOL.md`](./PROTOCOL.md) —— 那是另一条通道（WebSocket），
本文只讲浏览器 ↔ 平台。

---

## 约定

> 🛑 **先读下面的「实际响应形状（权威）」一节。**
>
> 本文是**先写的设计稿**，实现时为「列表带分页」这类需求调整过响应信封，
> 所以后半部分的行文与实现在信封上有系统性差异（例如 `GET /nodes` 实际是
> `{items:[…]}` 而不是裸数组）。
>
> 「实际响应形状」一节描述的是**实现在做的事**；两处冲突时以它为准，
> 并且应当回头修本文。

- **前缀** `/_api`（避开与前端路由冲突）
- **编码** 请求与响应都是 JSON；`Content-Type: application/json`
- **认证** HttpOnly Cookie 会话（`kp_session`）。**不用** `Authorization` 头
  —— 那需要把 token 存在 `localStorage`，等于把会话暴露给 XSS
- **CSRF** 所有非 `GET` 请求必须带 `X-CSRF-Token` 头，值与
  `kp_csrf` 非 HttpOnly Cookie 相同。用双提交模式
- **时间** 一律毫秒时间戳（number），不用字符串日期

### 错误响应

```jsonc
{ "error": { "code": "FORBIDDEN", "message": "缺少权限 luckperms.manage", "data": {} } }
```

| HTTP | code | 含义 |
|---|---|---|
| 400 | `INVALID_PARAMS` | 参数校验失败，`data.issues` 带字段明细 |
| 401 | `UNAUTHENTICATED` | 未登录或会话过期 |
| 403 | `FORBIDDEN` | 已登录但缺权限点 |
| 404 | `NOT_FOUND` | 资源不存在 |
| 409 | `CONFLICT` | 幂等键冲突 / 并发修改 |
| 422 | `NODE_REJECTED` | 节点在线但拒绝了操作（透传 Agent 的 `code`） |
| 429 | `RATE_LIMITED` | 限流 |
| 502 | `NODE_OFFLINE` | 目标节点不在线 |
| 502 | `NODE_ERROR` | 节点返回了错误（透传 Agent 的 `code` 到 `data.agentCode`） |

**`NODE_OFFLINE` 与 `NODE_ERROR` 必须区分。** 前者是「连不上」，
后者是「连上了但它说不行」—— 运维排查方向完全不同。

---

## ⚠️ 实际响应形状（权威，以本节为准）

本文后半部分是**先写的设计稿**，实现时为了「列表带分页」这类需求做了调整，
两者在响应信封上有系统性差异。前端在 `api/endpoints.ts` 里做了统一拆解
与字段归一化，每处都标了 `⚠️ 文档 vs 实现`。

**整合方请直接看下面这张表 —— 它描述的是实现在做的事。**
本节与实现不一致时，以实现为准，并且**应该修本节**。

### 统一约定

| 情况 | 实际形状 |
|---|---|
| 列表接口 | `{ "items": [...], "total": n, "page": n, "size": n }` |
| 单资源接口 | 包一层具名键：`{ "node": {...} }` / `{ "player": {...} }` / `{ "info": {...} }` |
| 写操作 | 多为 `{ "ok": true }`，或 `{ "ok": true, "changed": bool }` |
| 错误 | `{ "error": { "code", "message", "data" } }`（这一点与下文一致） |

### 逐接口速查

| 接口 | 实际响应 |
|---|---|
| `GET /_api/health` | `{ok, uptimeSeconds, nodes, browserClients}` |
| `GET /_api/auth/providers` | `{oauth:{enabled,skinUrl,startUrl,minPermission}, local:{enabled}}` |
| `GET /_api/auth/oauth/start` | **302** 跳转到皮肤站授权页（或 501 未配置） |
| `GET /_api/auth/oauth/callback` | **302** 回前端（成功）或 `/login?oauth_error=…`（失败） |
| `GET /_api/nodes` | `{items:[Node]}` |
| `POST /_api/nodes` | `{node, secret, warning}` —— **`secret` 只此一次** |
| `GET /_api/nodes/:id` | `{node}` |
| `PATCH /_api/nodes/:id` | `{node}` |
| `DELETE /_api/nodes/:id` | `{ok:true}` |
| `POST /_api/nodes/:id/rotate-secret` | `{secret, warning}` |
| `GET /_api/nodes/:id/info` | `{info: ServerInfo, cached: bool}` |
| `GET /_api/nodes/:id/metrics` | `{metrics: Metrics, ageMs: number}` |
| `GET /_api/nodes/:id/online` | `{players:[PlayerEntry]}` |
| `GET /_api/nodes/:id/console/history` | `{lines:[{ts,line,level}]}` |
| `POST /_api/nodes/:id/console` | `{success, output:[string]}` |
| `GET /_api/players` | `{items,total,page,size}` |
| `GET /_api/players/:uuid` | `{player: PlayerProfile}` |
| `GET /_api/players/:uuid/ips` | `{items:[{ip,firstSeenAt,lastSeenAt,seenCount}]}` |
| `GET /_api/players/:uuid/names` | `{items:[{name,firstSeenAt,lastSeenAt}]}` |
| `GET /_api/players/:uuid/sessions` | `{items:[{id,nodeId,ip?,joinedAt,leftAt,playtimeSeconds}]}` |
| `GET /_api/players/:uuid/audit` | `{items:[AuditEntry],total,page,size}` |
| `POST /_api/players/resolve` | `{uuid,name,online}` |
| `GET /_api/punishments` | `{items,total,page,size}`；每项额外带 `bsPid` / `revokedAt` / `revokedBy` |
| `POST /_api/punishments` | `{punishment, dispatched, bsPid, warning}` |
| `POST /_api/punishments/:id/revoke` | `{punishment, dispatched}` |
| `GET /_api/punishments/by-player/:uuid` | `{items, bsPid, renameBypassable}` |
| `GET /_api/characters/status` | 见下文「角色目录」 |
| `GET /_api/characters` | `{items,total,page,size}` |
| `GET /_api/characters/:pid` | `{character, punishments, activePunishments}` |
| `GET /_api/luckperms/nodes/:id/groups` | `{groups:[LpGroup]}`（已按 weight 降序） |
| `POST/DELETE /_api/luckperms/...` | `{ok:true, changed:bool}` |
| `GET /_api/economy/config` | `{config:{'economy.ratio':'1000', …}}` —— **点号键 + 全字符串值** |
| `GET /_api/economy/stats` | `{accounts,totalBalance,ledgerCount,last24hDelta,topBalances,sources,config}` |
| `GET /_api/economy/accounts` | `{items,total,page,size}`，每项 `{uuid,name,balance,updatedAt}` |
| `GET /_api/economy/accounts/:uuid` | `{account:{uuid,name,balance,updatedAt}, ledger:[…]}` |
| `POST /_api/economy/accounts/:uuid/adjust` | `{balance, ledgerId}` |
| `POST /_api/economy/accounts/:uuid/game-currency` | `{ok:true, balanceAfter}` |
| `GET /_api/economy/ledger` | `{items,total,page,size}` |
| `GET /_api/economy/new-event-id` | `{eventId}` |
| `GET /_api/audit` | `{items,total,page,size}` |
| `GET /_api/audit/actions` | `{actions:[string]}` |
| `GET /_api/audit/punishments` | `{items,total,page,size}` |
| `GET /_api/accounts` | `{items,total,page,size,roles}` —— 每项 `{id,username,displayName,role,permissions,disabled,createdAt,lastLoginAt,lastLoginIp,authProvider,skinUid}` |
| `POST /_api/accounts` | `{account}` |
| `PATCH /_api/accounts/:id` | `{account}` |
| `DELETE /_api/accounts/:id` | `{ok:true}` |

### 节点对象的 `null`

`onlinePlayers` / `maxPlayers` / `metrics` **可能是 `null`** ——
节点在线但从没上报过指标时就是这样。前端必须显示 `—`，
**不能**显示 0 或 20.0。另外有 `metricsAgeMs` 表示这份数据多旧。

### 权限节点的删除用 DELETE，不是 `value:null`

```
POST   /_api/luckperms/nodes/:id/groups/:name/permissions   { permission, value: boolean }
DELETE /_api/luckperms/nodes/:id/groups/:name/permissions   { permission }
```

两个都实现了。下文写的 `value:null` 表示删除**不可用**。

---

## 角色目录（身份锚点）

> 这一节是**新增**的，下文没有。它是本平台「封禁扛得住改名」的地基。
> 背景见 [`ECOSYSTEM.md §4.1`](ECOSYSTEM.md) —— 本站 Yggdrasil 用 UUID v3
> （`md5("OfflinePlayer:" + 角色名)`），所以名字与 UUID 等价，
> **只有 Blessing Skin 的 `pid` 是稳定的**。

### `GET /_api/characters/status`（权限 `punish.view`）

```jsonc
{
  "count": 3,                    // 目录里的角色数
  "withUuid": 1,                 // 其中有多少个已分配 UUID
  "lastSyncedAt": 1735000000000, // 最近一次同步时间（null = 从没同步）
  "lastSyncedAgoMs": 3600000,
  "stale": false,                // 超过 24 小时未同步即为 true
  "staleAfterMs": 86400000,
  "renameBypassable": 0,         // ★ 没有关联 pid 的生效封禁数
  "multiCharacterAccounts": 0,   // 单账号多角色的账号数
  "configured": true,            // count > 0
  "hint": null                   // 需要行动时的可执行提示
}
```

**`renameBypassable` 是本接口存在的主要理由。**
它 > 0 就说明「有封禁看起来生效、实际玩家改个名就绕过」——
这是最危险的状态，因为管理员不会去查，直到有人在论坛上炫耀。
前端应在该值 > 0 时显著告警，并在 `configured === false` 时引导去导入目录。

### `GET /_api/characters`（权限 `punish.view`）

`?kw=&page=&size=`。`kw` 支持 pid / uid / 当前名 / **历史名** / uuid 子串。

```jsonc
{
  "items": [{
    "bsPid": 1, "bsUid": 2, "name": "Kansamu", "uuid": "fbde4894-…",
    "prevNames": ["OldName"],       // 改名历史 —— 按旧名也能找到同一个人
    "prevUuids": ["fbde4894-…"],
    "firstSeenAt": 1735000000000, "lastSeenAt": 1735000000000,
    "source": "import",             // import | ingame
    "activePunishments": 1
  }],
  "total": 3, "page": 1, "size": 20
}
```

### `GET /_api/characters/:pid`（权限 `punish.view`）

`{ character: {...}, punishments: [...], activePunishments: n }`

### 导入目录

目录不通过 HTTP 写入 —— 它是从皮肤站导出的。用 CLI：

```bash
node tools/import-characters.mjs --print-sql    # 打印在皮肤站机器上要跑的 SQL
node tools/import-characters.mjs --file characters.tsv
```

导入是幂等的；同一 pid 再次导入是更新。**名字变了会把旧名推进 `prevNames`**，
所以「按旧名找同一个人」永远可行。详见工具自身的 `--help`。

### 封禁的 `bsPid` 与 `warning`

`POST /_api/punishments` 会尝试把目标解析成角色：

| 情况 | 响应 |
|---|---|
| 解析成功 | `bsPid: 1`，`warning: null` —— 封禁**扛得住改名** |
| 解析不出来 | `bsPid: null`，`warning` 明确说明「改名后此封禁将不再生效」 |

**解析不出来时一定会告警，不会默默存一条看起来正常的封禁。**
`warning` 是可执行的中文说明，前端应原样展示。

---

## 认证

### `POST /_api/auth/login`

```jsonc
// 请求
{ "username": "admin", "password": "…" }
// 200
{ "account": { "id": 1, "username": "admin", "role": "owner",
               "permissions": ["node.view", "…"] } }
```
失败一律 401 `UNAUTHENTICATED`，**不区分「用户不存在」与「密码错误」**。
按 IP 限流：15 分钟内 10 次失败即锁定该 IP。

### `POST /_api/auth/logout` → `204`

### `GET /_api/auth/me` → `{ "account": {…} }` / 401

---

## 节点

节点是「一台 MC 服务端」。

```jsonc
// Node
{ "id": "survival-01", "name": "生存服", "enabled": true,
  "status": "online",            // online | offline | disabled
  "lastSeenAt": 1735000000000,
  "agentVersion": "1.0.0", "mcVersion": "1.20.6", "brand": "Paper",
  "capabilities": ["console","players","punish","whitelist","luckperms","economy"],
  "tags": ["生存"], "createdAt": 1735000000000,
  "onlinePlayers": 12, "maxPlayers": 100,
  "metrics": { /* Metrics | null，离线时为 null */ } }
```

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/_api/nodes` | `node.view` | 列表 |
| POST | `/_api/nodes` | `node.manage` | 建节点，**响应里带 `secret`，只此一次** |
| GET | `/_api/nodes/:id` | `node.view` | 详情 |
| PATCH | `/_api/nodes/:id` | `node.manage` | 改 `name` / `tags` / `enabled` |
| DELETE | `/_api/nodes/:id` | `node.manage` | 删除 |
| POST | `/_api/nodes/:id/rotate-secret` | `node.manage` | 换密钥，返回新 `secret` |
| GET | `/_api/nodes/:id/info` | `node.view` | 透传 `server.info` |
| GET | `/_api/nodes/:id/metrics` | `node.view` | 透传 `server.metrics` |
| GET | `/_api/nodes/:id/online` | `player.view` | 在线玩家（`PlayerEntry[]`） |
| POST | `/_api/nodes/:id/console` | `console.execute` | `{command}` → `{success, output}` |
| GET | `/_api/nodes/:id/console/history` | `console.execute` | 最近缓冲日志 |

`POST /_api/nodes` 请求体：`{ "id": "survival-01", "name": "生存服", "tags": [] }`
`id` 只允许 `^[a-z0-9][a-z0-9_-]{1,63}$`。

**密钥只在创建与轮换时返回。** 库里存 `scrypt` 哈希，
丢了只能轮换，找不回来 —— 这是刻意的。

---

## 玩家

```jsonc
// PlayerProfile
{ "uuid": "069a79f4-…", "name": "Notch", "knownNames": ["Notch","notch_old"],
  "firstSeenAt": 1735000000000, "lastSeenAt": 1735000000000,
  "playtimeSeconds": 36000, "lastIp": "203.0.113.7",
  "online": false, "nodeId": null,
  "punishments": [ /* Punishment[]，含已撤销 */ ],
  "economy": { "balance": 120.0 },
  "gameCurrency": { "survival-01": { "balance": 12345.0, "currency": "金币" } } }
```

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/_api/players` | `player.view` | `?kw=&online=&node=&page=&size=` |
| GET | `/_api/players/:uuid` | `player.view` | 档案 |
| GET | `/_api/players/:uuid/ips` | `player.view_ip` | IP 历史 |
| GET | `/_api/players/:uuid/names` | `player.view` | 曾用名 |
| GET | `/_api/players/:uuid/sessions` | `player.view` | 上下线记录 |
| GET | `/_api/players/:uuid/audit` | `audit.view` | 该玩家的操作历史 |
| POST | `/_api/players/resolve` | `player.view` | `{name}` → `{uuid, name, online}` |
| POST | `/_api/players/:uuid/kick` | `player.manage` | `{nodeId, reason}` |
| POST | `/_api/players/:uuid/op` | `player.manage` | `{nodeId, value}` |
| POST | `/_api/players/:uuid/gamemode` | `player.manage` | `{nodeId, gamemode}` |
| POST | `/_api/players/:uuid/whitelist` | `player.manage` | `{nodeId, value}` |

`lastIp` 与 `/ips` 需要 `player.view_ip`。**没有该权限时字段直接不返回**，
而不是返回占位值 —— 前端不需要为「有这个 key 但不能看」写额外分支。

---

## 封禁 / 禁言

```jsonc
// Punishment
{ "id": "p_01H…", "type": "ban", "uuid": "…", "name": "Notch",
  "reason": "使用作弊客户端", "operator": "admin",
  "nodeId": null,                  // null = 全平台
  "createdAt": 1735000000000, "expiresAt": null, "active": true,
  "revokedAt": null, "revokedBy": null }
```

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/_api/punishments` | `punish.view` | `?type=&active=&uuid=&node=&kw=&page=&size=` |
| POST | `/_api/punishments` | `punish.manage` | 新建 |
| POST | `/_api/punishments/:id/revoke` | `punish.manage` | 撤销 |

新建请求体：

```jsonc
{ "type": "ban", "uuid": "…", "name": "Notch", "reason": "…",
  "durationSeconds": 86400,   // null = 永久
  "nodeId": null,             // null = 全平台
  "kickNow": true }           // ban 时是否立刻踢下线，默认 true
```

**建封禁是一个跨系统动作**，响应里带下发结果：

```jsonc
{ "punishment": {…},
  "dispatched": [ { "nodeId": "survival-01", "ok": true },
                  { "nodeId": "creative-01", "ok": false, "code": "TIMEOUT" } ] }
```

节点下发失败**不影响封禁生效**（平台是权威，记录已落库）。
前端必须把 `dispatched` 里失败的节点显式展示出来 ——
静默吞掉会让管理员以为已经全服生效。

---

## LuckPerms

按节点操作（LP 是每个服务端各自的数据）。

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/_api/luckperms/nodes/:nodeId/users/:uuid` | `luckperms.view` |
| POST | `/_api/luckperms/nodes/:nodeId/users/:uuid/primary-group` | `luckperms.manage` |
| POST | `/_api/luckperms/nodes/:nodeId/users/:uuid/groups` | `luckperms.manage` |
| POST | `/_api/luckperms/nodes/:nodeId/users/:uuid/permissions` | `luckperms.manage` |
| POST | `/_api/luckperms/nodes/:nodeId/users/:uuid/meta` | `luckperms.manage` |
| GET | `/_api/luckperms/nodes/:nodeId/groups` | `luckperms.view` |
| POST | `/_api/luckperms/nodes/:nodeId/groups` | `luckperms.manage` |
| DELETE | `/_api/luckperms/nodes/:nodeId/groups/:name` | `luckperms.manage` |
| POST | `/_api/luckperms/nodes/:nodeId/groups/:name/permissions` | `luckperms.manage` |
| POST | `/_api/luckperms/nodes/:nodeId/groups/:name/parents` | `luckperms.manage` |
| POST | `/_api/luckperms/nodes/:nodeId/groups/:name/weight` | `luckperms.manage` |
| POST | `/_api/luckperms/nodes/:nodeId/groups/:name/meta` | `luckperms.manage` |

请求体：

```jsonc
{ "group": "vip" }                                  // primary-group
{ "group": "vip", "add": true }                     // groups
{ "permission": "essentials.fly", "value": true }   // value:null = 删除该节点
{ "prefix": "[VIP] ", "suffix": "" }                // meta
{ "parent": "default", "add": true }                // parents
{ "weight": 10 }                                    // weight
```

写操作统一返回 `{ "changed": boolean }`。`changed:false` 表示
「本来就是这个值」—— 前端据此提示「无需修改」而不是「已修改」。

---

## 经济

```jsonc
// EconomyAccount
{ "uuid": "…", "name": "Notch", "balance": 120.0, "updatedAt": 1735000000000 }
```

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/_api/economy/accounts` | `economy.view` | `?kw=&page=&size=` |
| GET | `/_api/economy/accounts/:uuid` | `economy.view` | 账户 + 最近流水 |
| POST | `/_api/economy/accounts/:uuid/adjust` | `economy.manage` | 改站点积分 |
| POST | `/_api/economy/accounts/:uuid/game-currency` | `economy.manage` | 改游戏内货币（经 Vault） |
| GET | `/_api/economy/ledger` | `economy.view` | `?uuid=&source=&from=&to=&page=&size=` |
| GET | `/_api/economy/stats` | `economy.view` | 概览 |
| GET | `/_api/economy/config` | `economy.view` | 配置 |
| PUT | `/_api/economy/config` | `economy.manage` | 改配置 |

```jsonc
// POST adjust
{ "delta": 50, "note": "活动补发", "eventId": "optional-幂等键" }
// → { "balance": 170.0, "ledgerId": 991 }

// POST game-currency
{ "nodeId": "survival-01", "amount": 1000, "note": "活动补发", "eventId": "…" }
// → { "balanceAfter": 13345.0 }
```

`delta` / `amount` 不接受 0。`eventId` 省略时服务端生成。

**经济配置的三个约束由服务端强制校验**：
`min_coin >= ratio`、`ratio >= 1`、各项限额 `>= 0`。
现有 `kokuu-credit-admin` 是把矛盾配置警告打在页面上，
这里改成**拒绝写入** —— 一个会让每笔兑换都被拒的配置不该存进库里。

---

## 审计

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/_api/audit` | `audit.view` |

`?actor=&action=&targetType=&targetId=&nodeId=&ok=&from=&to=&page=&size=`

```jsonc
// AuditEntry
{ "id": 1234, "ts": 1735000000000, "actor": "admin", "actorIp": "203.0.113.9",
  "action": "punish.create", "targetType": "player", "targetId": "069a79f4-…",
  "nodeId": null, "params": { "type": "ban", "reason": "…" },
  "ok": true, "error": null }
```

---

## 实时事件

`GET /_api/events`（WebSocket，与 REST 同端口）

握手：连接后客户端发

```jsonc
{ "type": "subscribe", "topics": ["nodes", "console:survival-01", "players"] }
```

服务端推：

```jsonc
{ "type": "event", "topic": "nodes", "event": "node.disconnected",
  "ts": 1735000000000, "data": { "nodeId": "survival-01", "reason": "heartbeat timeout" } }
```

| topic | 事件 |
|---|---|
| `nodes` | `node.connected` / `node.disconnected` / `node.metrics` |
| `players` | `player.join` / `player.quit` / `player.chat` |
| `console:<nodeId>` | `console.line` |
| `punish` | `punish.applied` / `punish.revoked` |

浏览器侧 WebSocket 同样要求会话 Cookie；未登录直接关闭。
`topics` 里带 `console:` 的需要 `console.execute` 权限，否则静默剔除该 topic
并在响应里回 `{ "type":"subscribed", "topics":[...实际生效的...] }` ——
**必须回实际生效的列表**，否则前端会一直显示「已订阅」但收不到东西。
