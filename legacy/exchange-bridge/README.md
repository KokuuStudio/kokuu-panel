# ExchangeBridge

Blessing Skin 积分兑换的 **Minecraft 服务端执行器**。

玩家在皮肤站点一下兑换 → 生成订单（已扣积分）→ 皮肤站 LPUSH 进 Redis 队列
→ 本插件 BRPOP 领取 → 切主线程调经济插件 `deposit()` 发放游戏内货币
→ LPUSH 结果回传 → 皮肤站标记完成。

玩家体验是「点了就到账，不用进游戏输任何兑换码」。

> 本插件只负责 MC 端。皮肤站那一半是 [`kokuu-exchange`](https://github.com/KokuuStudio/kokuu-exchange)（Blessing Skin 插件）。
> **两端必须成对使用**，缺一端兑换流程走不通。

---

## 为什么需要它

主流经济插件（Vault / EssentialsX 等）**没有 HTTP/REST 接口** —— 发放货币这个动作只能由
MC 服务端里的 Java 代码执行。所以「直连发放」不是浏览器直连游戏，
而是靠一个服务端插件把指令执行掉。

通信方式选了 Redis 队列而不是 HTTP 回调：

| | Redis 队列（本方案） | HTTP 回调 |
|---|---|---|
| 公网端口 | **不需要**，Redis 只监听 127.0.0.1 | 需要对外暴露一个接口 |
| 防重复消费 | BRPOP「取走即消失」，天然互斥 | 要自己维护「谁领到了」的标记位 |
| 防重放 | Redis 认证已挡住外部调用 | 要自己写签名/nonce/时间戳 |
| 断线处理 | 重连即可，队列里的消息还在 | 丢失请求，需要重试机制 |

---

## 兼容范围

| 项目 | 支持 |
|---|---|
| Minecraft | **1.12.2 ~ 最新**（一个 jar 通吃） |
| Java 运行时 | 8 / 11 / 17 / 21（编译为 Java 8 字节码） |
| 服务端类型 | Spigot / Paper / Purpur |
| 经济插件 | 任何经**Vault API** 接入的经济后端（EssentialsX / CMI 等）。首选 Vault 路径，静态单例仅作兼容回退 |

**关于 Java 8 字节码**：MC 服务器的 Java 版本随版本走（1.12.2 是 Java 8，
1.18+ 是 Java 17，1.20.5+ 是 Java 21）。字节码兼容是**单向**的 ——
Java 8 字节码能在所有新运行时上跑，反过来则直接
`UnsupportedClassVersionError`。所以即使构建机是 JDK 17，也压到 8 编译。

**关于 1.12.2**：`plugin.yml` 的 `api-version` 写的是 `1.13`。
1.12.2 用 Properties 加载 plugin.yml，会**忽略**这个它不认识的键；
而 1.13+ 的服务器需要它才肯加载新插件。写 `1.13` 是唯一同时满足两头的值。

---

## 安装

1. 下载 `exchange-bridge-1.0.0.jar`，丢进 MC 服务器的 `plugins/` 目录。
2. 启动一次，生成 `plugins/ExchangeBridge/config.yml`。
3. 编辑 `config.yml`（见下）。
4. 皮肤站侧安装 `kokuu-exchange` 插件，**两边的队列 key 必须填一样的值**。
5. 重启服务器，控制台应出现：
   ```
   [ExchangeBridge] ExchangeBridge 已启用
   [ExchangeBridge]   队列：queue=bs:exchange:queue  result=bs:exchange:result
   [ExchangeBridge]   经济插件：Vault API  depositPlayer(...)...
   [ExchangeBridge] 已连接 Redis 127.0.0.1:6379 db0
   ```
   看到「已连接 Redis」和「经济插件」两行才算装好。

无需安装任何额外库 —— Jedis / Gson / slf4j 都已打包进 jar。

---

## 配置

### 必填

```yaml
redis:
  host: 127.0.0.1
  port: 6379
  password: '你的Redis密码'      # Redis 设了 requirepass 就必须填
  database: 0

queue:
  key: 'bs:exchange:queue'      # ⚠️ 必须与皮肤站后台保存的值一致
  result-key: 'bs:exchange:result'
```

> **队列 key 是最容易踩的坑**：两边不一致时，订单写进 A 队列、本插件从 B 队列取，
> 表现为「订单凭空消失」—— 玩家积分已扣，但订单永远停在「发放中」，
> 直到超期退款。先去皮肤站后台「兑换配置」里确认值，再填到这里。

> ⚠️⚠️ **还有一种更隐蔽的「不一致」：键前缀。**（2026-10-03 实际发生过一起）
>
> 本插件用的是**裸 Jedis**，键名就是你写的字面量 —— `bs:exchange:queue`。
> 但 Blessing Skin 那边用的是 Laravel 的 Redis 门面，而内核
> `config/database.php` 会给 redis 设一个 `prefix`
> （默认 `Str::slug(env('APP_NAME','blessing_skin'),'_').'_database_'`，
>  本站没设 `APP_NAME`，所以恒为 `blessing_skin_database_`）。
> phpredis 在**扩展层**应用这个前缀，于是皮肤站实际写的是
> `blessing_skin_database_bs:exchange:queue` —— 和本插件读的永远对不上。
>
> 症状与「名字写错」**完全一样**（静默、订单卡 pending、无任何报错），
> 但改 config.yml 里的 key 名**解决不了**，因为问题在皮肤站侧的前缀。
> 皮肤站那边的正确做法是给兑换功能单开一个**清空前缀**的连接
> （见 `kokuu-exchange/bootstrap.php` 的 `kokuu_exchange_redis()`）。
>
> 自查一条命令就能看出有没有踩（在皮肤站机器上）：
> ```bash
> redis-cli --scan --pattern '*exchange*'
> # 若结果带 blessing_skin_database_ 前缀 → 皮肤站侧没清前缀，必坏
> ```

### 接其它经济插件

**绝大多数情况不需要做任何配置**：EssentialsX Economy 之类都经 Vault API
注册，插件启动时会自动绑定（路径 A）。

只有当你的经济后端**没有**实现 Vault 接口时，才需要在这里填它的
**经济类全限定名**（走静态单例回退路径 B）：

```yaml
economy:
  class-names:
    - '你的插件.经济类全限定名'
```

目标类需要满足：

1. 有 `public static getInstance()`
2. 有 `deposit(OfflinePlayer, double)` / `deposit(Player, double)` /
   `deposit(String, double)` 三者之一

有 `OfflinePlayer` 重载最好 —— 玩家不在线时也能发放，
这是「点了就到账」体验的前提。

找不到类时插件**仍会正常加载**，只是发放会失败并让皮肤站退款，
不会因为缺依赖而整体崩掉。控制台会打印试过的类名。

### 性能相关

```yaml
worker:
  poll-interval: 1000      # 轮询间隔（毫秒），越小玩家等越久
  block-timeout: 2         # BRPOP 阻塞超时（秒），不要大于 poll-interval
  batch-size: 8            # 单次唤醒最多处理几条
  deposit-timeout: 5000    # 单笔发放等主线程的上限，超时按失败退款
  processed-ttl: 86400000  # 幂等缓存保留时长，应 >= 皮肤站的 order_ttl
```

---

## 命令与权限

| 命令 | 权限 | 说明 |
|---|---|---|
| `/exbridge status` | `exchangebridge.use` | 队列深度、经济插件绑定、收发与回流计数 |
| `/exbridge balance <玩家>` | `exchangebridge.use` | 查余额（普通玩家只能查自己） |
| `/exbridge reconnect` | `exchangebridge.admin` | 手动重建 Redis 连接 |
| `/exbridge reload` | `exchangebridge.admin` | 重读 config.yml |
| `/exbridge coin/points <玩家> <±数额>` | `exchangebridge.admin` | 直接改金币/点券 |
| `/exbridge give/take coin\|points <玩家> <数额>` | `exchangebridge.admin` | 同上，等价写法 |
| `/exbridge reflow [scan\|on\|off]` | `exchangebridge.admin` | 金币回流：立刻扫描 / 开关 |

`/exbridge` 也能用中文：`/exbridge 诊断`、`/exbridge 重连`、`/exbridge 重载`、
`/exbridge 金币`、`/exbridge 点券`、`/exbridge 回流`。

### 资产指令队列（`queue.asset-key`）

中间件管理台下发「给某人加/减金币或点券」走这个队列，消息格式：

```json
{ "event_id": "admin:coin:Steve:1735...", "player": "Steve",
  "uuid": "1a2b3c4d-...", "asset": "coin", "delta": 1000, "note": "活动补发" }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `event_id` | 是 | 幂等键，重复的会被本地缓存挡掉 |
| `player` | 是 | 玩家名，会拼进经济插件的指令 |
| `uuid` | 否 | 玩家 UUID。**带上才有的身份校验**，见下 |
| `asset` | 是 | `coin` 或 `points` |
| `delta` | 是 | 非 0 整数，正加负减 |
| `note` | 否 | 仅记录用 |

**关于 uuid 校验**：uuid 非空且玩家**在线**时，插件会核对
「这个名字在线的人是不是那个 uuid」，不符就拒绝执行并在日志里说明。
玩家名可重名 —— 服务器上两个 `Steve` 时，按名字发钱发给谁全看经济插件
找到哪一个，uuid 是唯一能验的锚点。离线玩家不校验（Bukkit 对没上线过的
名字只能返回全 0 UUID，校验只会误杀）。

老版本中间件不带 uuid 时插件照常按名字执行（降级路径），
日志会标 `（无 uuid，按名字执行）`。

### 回流事件队列（`queue.event-key`）

金币自动回流时插件写进这个队列，消息格式：

```json
{ "event_id": "rf:1a2b3c4d...:1735...", "player": "Steve",
  "uuid": "1a2b3c4d-...", "asset": "coin",
  "delta": 5000, "credit": 5, "balance_after": 12340, "ts": 1735... }
```

| 字段 | 说明 |
|---|---|
| `event_id` | 幂等键，格式 `rf:<uuid无横线>:<毫秒时间戳>` |
| `uuid` | 必带，中间件靠它定位账户，改名不影响入账 |
| `delta` | 实际扣掉的金币数（不是增量原值，是扣完的净数） |
| `credit` | 按插件侧比例算出的积分。**中间件不重算，以这个为准** |
| `balance_after` | 扣完后的余额，负数表示查不到 |

---

## 金币自动回流

玩家在游戏里赚到的金币，按比例自动抽走零头换成积分。

**默认关闭。** 这功能会动玩家的钱，`reflow.enabled: false` 是开箱即用的
安全值 —— 比例没配好（ratio 太小 = 抽太狠）会直接引发投诉。

```yaml
reflow:
  enabled: false        # 要开就改 true，然后重启
  ratio: 1000           # 多少金币 = 1 积分
  interval-seconds: 30  # 扫描间隔
  min-delta: 1000       # 单次增量低于此值不抽（滤掉零碎进账）
  max-delta: 10000000   # 单次增量上限，超过按此截断
```

### 它是怎么算的

每 `interval-seconds` 秒扫一遍**在线**玩家余额，跟上次快照比：

```
delta  = 当前余额 − 上次余额          # 只认正向增量
credit = floor(delta / ratio)
taken  = credit × ratio              # 实际抽走的金币
```

玩家赚 5500 金币、比例 1000:1 → 抽走 5000 换 5 积分，**剩 500 金币零头**。
效果等于「每次兑换自动抹掉零头」，只是省掉玩家手动敲命令。

### 为什么是「先扣币，再上报」

这是整个回流设计里最重要的决定。

Redis 队列**没有回执**，中间件无法知道扣币成功没有。如果反过来
（先给积分、再让中间件扣币），扣币失败时玩家就凭空多出一笔积分 ——
而积分能换金币，等于直接造币。

现在的顺序：金币在插件侧**已经真实扣掉**（`EconomyHook.withdraw` 有返回值
能判成败），上报的一定是「确实扣掉了的数额」。中间件加分失败的最坏后果是
「玩家亏了币没拿到积分」—— 可追溯、可人工补，方向是安全的那一侧。

### 为什么比例写在插件这边

扣币必须在插件这里发生（只有插件能操作经济插件），所以
「扣多少币换多少积分」这个算式必须在同一处完成。两边各算一半、
比例一旦漂移就是凭空造币或吞钱。

中间件**不重算比例**，但会检测：它用自己的比例反算一遍，对不上就打日志告警
（见 `/api/reflow/status` 的 `drift` 计数）。**检测到漂移仍然入账** ——
玩家的金币已经扣了，不入账等于让玩家白亏。

> 所以两边必须填同一个数：插件 `reflow.ratio` ↔ 中间件后台「兑换比例」。

### 为什么不做成监听经济事件

Vault 生态**没有**统一的「玩家赚钱」事件。EssentialsX 有自己的、
CMI 有自己的、PlayerPoints 又是一套，三家 API 全不一样，
而本插件不硬依赖任何一个后端。只有 `getBalance(OfflinePlayer)`
是所有后端都保证的。

代价是精度取决于扫描间隔：期间玩家花掉的钱会被算进净值，
但那只会让本次抽成**偏少**，不会偏多 —— 方向是安全的。

### 开关与排查

```
/exbridge reflow scan   # 立刻扫一次（玩家说没收到积分时自查）
/exbridge reflow on     # 运行期开启（仅内存，重启后以 config.yml 为准）
/exbridge reflow off    # 停止
```

`on`/`off` **不写 config.yml** —— 运行时开关与持久配置混在一起会出现
「重启后行为突变」这类极难复现的问题。要持久化就改配置文件再 `/exbridge reload`。

回流统计在 `/exbridge status` 里：扫描次数、上报数、跳过数、失败数、跟踪人数。

---

## 排查

先跑 `/exbridge status`，它会一次性告诉你：

| 现象 | 原因 |
|---|---|
| `Redis 读取失败: Connection refused` | Redis 没起，或 host/port 错 |
| `NOAUTH Authentication required` | `redis.password` 没填 |
| `WRONGPASS` | 密码填错 |
| `未找到经济插件的经济类` | 目标插件没装 / 类名不对，试着加进 `economy.class-names` |
| `待发放：N 条` 一直涨 | 队列 key 与皮肤站不一致 |
| `待回传：N 条` 一直涨 | 皮肤站页面没人访问（结果靠页面访问时消费） |
| `身份核对失败，指令已拒绝` | 指令里的 uuid 与该玩家在线时的 uuid 不符 —— 玩家改了名，或有人冒名。到中间件管理台重新查一次 uuid 再下发 |
| `待处理回流事件：N 条` 一直涨 | **中间件的回流消费循环没在跑或已掉线**。玩家的金币已经扣了但积分没入账 —— 查中间件日志 |
| `[回流] X 事件入队失败，玩家已扣 N 金币但未获得积分` | Redis 断了。注意插件**已经扣了玩家的钱**，需人工补发积分。凭日志里的 `rf:` 开头 event_id 去中间件 `POST /api/reflow/simulate` 补（带同一个 eventId，幂等只会补一次） |
| 回流开着但比例生效不对 | 两边比例不一致：插件 `reflow.ratio` ↔ 中间件后台「兑换比例」。中间件日志会有「比例漂移」告警 |

**「待回传积压」是设计上的取舍，不是 bug**：皮肤站侧没有常驻 worker，
结果是玩家访问兑换页时顺手消费的。站点冷清时订单状态会延迟更新，
但钱已经发到账上了。介意的话在皮肤站加个 cron 调 `drain_results()`。

---

## 设计上的几个取舍

**幂等靠数据库唯一键，不靠「先查状态再改」。**
MC 端可能在「已发放、结果回传失败」时重推同一条结果。若用
`SELECT status` 判断再更新，两个并发回传会都通过检查。所以皮肤站侧
用 `UNIQUE(order_no, action)` 让数据库做唯一防线。

**超期退款可能双发，但不会卡死玩家。**
`BRPOP` 没有 ack，MC 端取走消息后崩溃会让订单永远停在 pending。
兜底策略是超期（默认 24h）一律退款 —— 此时若 MC 其实已经发了钱，
玩家会拿到双份。这是「必然发生的坏结果」与「极小概率的坏结果」之间的取舍。
不想承担双发风险就把 `order_ttl` 设大（如 7 天）。

**经济插件调用必须切回主线程。**
Bukkit 的玩家 API 不是线程安全的。本插件用
`Bukkit.getScheduler().runTask()` 切回主线程，并用 `CountDownLatch`
带超时等待。超时按失败回传，让玩家立刻退款，而不是干等。

**回流用「余额快照差分」而不是「监听经济事件」。**
没有一个跨后端的通用事件可用（见「金币自动回流」小节）。
快照法的代价是精度受扫描间隔影响，但误差方向是安全的 ——
只可能少抽，不会多抽。

**事件队列不做 ack，积压时玩家会「亏币但没拿到积分」。**
与兑换队列同一个取舍：`BRPOP` 取走即消失，消息不会重投。
好在这个方向的损失是「玩家吃亏」而非「系统造币」，
且凭 `rf:` 开头的 event_id 可以精确定位并补发。

---

## 从源码构建

```bash
mvn clean package
# 产物：target/exchange-bridge-1.0.0.jar
```

需要 JDK 8+（构建机上用更高版本也会压到 Java 8 字节码输出）。

## License

MIT
