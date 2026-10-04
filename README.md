# kokuu-credit-admin

Minecraft 游戏内金币 / 点券 ↔ 网站积分的**双向**桥接中间件与管理台。

- 🎮 **游戏侧**：[exchange-bridge](https://github.com/KokuuStudio/exchange-bridge)（Spigot/Paper 插件，1.12.2 ~ 最新）
- 🌐 **中间件 + 管理台**：本仓库

一套系统，两种用法：

| 模式 | 账本存在哪 | 适合 |
|---|---|---|
| `standalone` | 自带的 MySQL（或 JSONL） | 独立运营，不依赖 Blessing Skin |
| `skin` | Blessing Skin 的 `users.score` | 已有皮肤站，积分就是站内的分 |

**除皮肤站模式外不需要任何外部依赖** —— 不装皮肤站也能完整跑（兑换、限流、流水、管理台）。

---

## 目录

- [它能做什么](#它能做什么)
- [快速开始](#快速开始)
- [安装（详细）](#安装详细)
- [配置说明](#配置说明)
- [架构](#架构)
- [HTTP 接口](#http-接口)
- [部署与运维](#部署与运维)
- [安全说明](#安全说明)
- [License](#license)

---

## 它能做什么

**积分 → 游戏资产**（发钱）
管理台或皮肤站下单 → 写 Redis 队列 → MC 插件取出 → 调经济插件发放 → 回传结果。

**游戏资产 → 积分**（回流 / 兑换）
玩家在游戏里赚金币 → 插件按比例抽走零头 → 上报 → 中间件入账积分。

**管理台**
账户查询、全站流水（时间 / 玩家 / 来源多维筛选）、数值调整、兑换比例与限额配置、
游戏资产增减下发、金币回流开关与实时统计。

---

## 快速开始

### Docker（推荐）

```bash
git clone https://github.com/KokuuStudio/kokuu-credit-admin.git
cd kokuu-credit-admin

cp .env.example .env
# ⚠️ 必改：ADMIN_TOKEN
#   生成：node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

docker compose up -d
```

打开 <http://127.0.0.1:8787>，用 `ADMIN_TOKEN` 登录。

数据全在三个 Docker 卷里（`kokuu-data` / `kokuu-mysql` / `kokuu-redis`），
备份用 `bash scripts/backup.sh`。

### 连已有皮肤站

```bash
cp .env.example .env
# 编辑 .env：
#   BACKEND=skin
#   DB_* / REDIS_* 填皮肤站的
docker compose -f docker-compose.skin.yml up -d
```

详见 [INSTALL.md](INSTALL.md)。

---

## 它能做什么

### 三个方向的数据流

```
   ┌──────────────┐   ①积分→金币    ┌────────────┐  队列  ┌──────────────┐
   │  管理台/皮肤站 │ ──────────────> │  中间件     │ ────> │ MC 插件       │
   │              │ <──────────────  │ (本仓库)   │ <──── │ (exchange-   │
   └──────────────┘   ②金币→积分    └────────────┘  队列  │  bridge)     │
                                  ③改余额/限流  └──────┘ └──────────────┘
```

| 方向 | 触发 | 链路 |
|---|---|---|
| ① 积分 → 金币 | 玩家下单兑换 | 队列 `bs:exchange:queue` → 插件发放 → 回传 `bs:exchange:result` |
| ② 金币 → 积分 | 玩家在游戏里赚金币 | 插件抽成 → 队列 `bs:asset:event` → 中间件入账 |
| ③ 改余额 / 限流 | 管理员操作 | HTTP 直写账本（事务 + 行锁 + 幂等） |
| ④ 资产下发 | 管理员调整金币/点券 | HTTP → 队列 `bs:asset:cmd` → 插件执行 |

### 关键设计

**低耦合、可插拔后端。**
整个系统只有 `server/src/runtime.js` 一个文件知道「皮肤站存在」。
换后端时它切换的是实现，`routes.js` / `bridge.js` 一行都不用改。

**接口能力探测而非硬依赖。**
`bridge.js` 用 `typeof ledger.uidByUuid === 'function'` 判断账本支不支持某能力，
而不是往抽象基类里塞一堆抛 `NotImplemented` 的方法。

**UUID 作为身份锚点。**
玩家名可变且可抢注 —— 改了名找不到人，重名了更糟（找到别人）。
MC UUID 由服务器首次进服生成，不可变、不可伪造，离线模式下同样稳定。

**账本三原则。**
事务 + `SELECT ... FOR UPDATE` 行锁；`event_id` 唯一索引做幂等；余额一律从库里读，
不信任调用方传的余额。

**顺序消除跨存储事务。**
先 `ledger.change()`（权威 + 幂等），再 `exchangeLog.record()`（审计明细）。
反过来的话「明细写了、记账失败」会导致重试再扣一次币。

---

## 配置说明

全部可在管理台 `/config` 页改，改完**立即对新交易生效**。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `1` | 金币换积分总开关 |
| `ratio` | `1000` | 兑换比例：多少金币 = 1 积分 |
| `daily_limit` | `200` | 单用户每日兑换积分上限（0 = 不限） |
| `single_limit` | `50` | 单笔最多换多少积分（0 = 不限） |
| `min_coin` | `1000` | 单笔最少消耗多少金币 |
| `auto_source` | `game` | 流水来源标记 |
| `reflow_enabled` | `0` | **金币自动回流开关**（默认关，见下） |
| `reflow_daily_limit` | `0` | 单用户每日回流积分上限（0 = 不限） |

> ⚠️ `min_coin` 必须 ≥ `ratio`，否则「按最低门槛提交也换不到 1 积分」，
> 每一笔兑换都会被拒。管理台会在页面上直接警告这个矛盾。

### 关于金币自动回流

`reflow_enabled` **默认关闭**。这功能会自动扣玩家的金币，比例没配好就是直接引发投诉。

打开后：插件每 30 秒扫一次在线玩家余额，正向增量按比例抽走零头换成积分。
玩家赚 5500 金币、比例 1000:1 → 抽走 5000 换 5 积分，**剩 500 金币零头**。

设计上有两个刻意的选择，写在这里以免被误改：

1. **先扣币，再上报积分。** Redis 队列没有回执，中间件无法知道扣币成功没有。
   反过来做的话，扣币失败时玩家凭空多一笔积分 —— 而积分能换金币，等于造币。
2. **比例以插件侧为准，中间件不重算。** 扣币发生在插件侧，算式必须在同一处完成。
   中间件会检测漂移并打日志告警，但**检测到也照样入账** —— 玩家的金币已经扣了。

---

## HTTP 接口

所有接口都在 `/api` 下，需要 `X-Admin-Token` 头（除 `/api/ping`）。

<details>
<summary>账户</summary>

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/users?kw=&page=&size=` | 账户列表，支持昵称/邮箱/UID/UUID 搜索 |
| GET | `/users/:uid` | 账户详情 + 最近 100 条流水 |
| POST | `/users/:uid/score` | 改积分 `{delta, note, eventId}` |
| POST | `/users` | 建账户（**仅 standalone**，skin 模式下账户由注册流程产生） |
| GET | `/players/suggest?kw=` | 玩家名前缀候选 |
</details>

<details>
<summary>流水与统计</summary>

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ledger?source=&kw=&from=&to=&page=&size=` | 全站流水，多维筛选 |
| GET | `/stats` | 概览 + 余额榜 + 队列深度 + 回流统计 |
| GET | `/game/exchanges?limit=` | 兑换明细 |
</details>

<details>
<summary>兑换与资产</summary>

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/game/convert` | 金币换积分 `{player, uuid, coin, eventId, reason, note}` |
| GET | `/game/quota?player=&uuid=` | 玩家兑换额度与积分余额 |
| POST | `/assets/adjust` | 改游戏内金币/点券 `{asset, player, uuid, delta, note}` |
| POST | `/reflow/simulate` | 手工补发一条回流事件（幂等） |
| GET | `/reflow/status` | 回流运行状态与统计 |
</details>

<details>
<summary>配置</summary>

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/config` | 读配置 |
| PUT | `/config` | 改配置（白名单 + 全量校验后才写） |
</details>

---

## 部署与运维

### 备份

```bash
bash scripts/backup.sh              # → ./backups/<时间戳>/
bash scripts/backup.sh /mnt/nas     # 备份到指定目录
```

生成 `data.tar.gz`（账本与配置）+ `db.sql` + `redis.tar.gz`，附 `RESTORE.txt` 恢复步骤。

> ⚠️ **Redis 也要备份。** 回流事件在队列里等着被消费，
> 队列丢了等于「玩家金币已扣、积分没入账」。

### 反向代理

默认只绑 `127.0.0.1`，前面放 nginx / Caddy 做 TLS：

```nginx
server {
    listen 443 ssl http2;
    server_name credit.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 不用 Docker

```bash
cd server && npm ci
cd ../web && npm ci && npm run build     # 产物在 web/dist

cd ../server
BACKEND=standalone ADMIN_TOKEN=你的口令 SERVE_WEB=1 \
  HOST=127.0.0.1 PORT=8787 node src/index.js
```

前置：Node 22+、MySQL 8（standalone 也支持纯 JSONL，见 `DATA_DIR`）、
Redis（只有资产下发与金币回流需要）。

---

## 安全说明

已实现的防护，以及它们各自挡的具体手法：

| 防护 | 挡住什么 |
|---|---|
| `X-Admin-Token` 鉴权 | 未授权访问所有写接口 |
| `assertSafeName` 白名单 | 控制台命令注入（`a;shutdown`） |
| `assertSafeUuid` 白名单 + 排除全 0 | SQL 注入；「从未上线」的假 UUID 把不同玩家合并成一个账户 |
| `event_id` 唯一索引 | 重放攻击导致重复加分 |
| 余额从库读 + 行锁 | 并发请求算错余额 |
| 每日 / 单笔限额 | 工作室批量小号刷分 |
| UUID 在线身份核对 | 重名时给错人发钱 |
| 只查不建（手动操作） | 凭空开出账户 |

**部署时必须注意的两条**：

1. **别把 `BIND_ADDR` 改成 `0.0.0.0` 就完事。** 管理口令和账本数据都是明文传输，
   公网环境必须前置 TLS 反代。
2. **别把 MySQL / Redis 端口映射到宿主机。** 容器间用服务名通信即可；
   映射出去等于把积分账本裸露在公网。

---

## License

[MIT](LICENSE) © KokuuStudio

贡献请看 [CONTRIBUTING.md](CONTRIBUTING.md)。
问题反馈请开 issue，附上 `/api/stats` 的输出与后端日志（**口令打码**）。
