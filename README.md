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
| `/exbridge status` | `exchangebridge.use` | 队列深度、经济插件绑定、收发计数 |
| `/exbridge balance <玩家>` | `exchangebridge.use` | 查余额（普通玩家只能查自己） |
| `/exbridge reconnect` | `exchangebridge.admin` | 手动重建 Redis 连接 |
| `/exbridge reload` | `exchangebridge.admin` | 重读 config.yml |

`/exbridge` 也能用中文：`/exbridge 诊断`、`/exbridge 重连`、`/exbridge 重载`。

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

---

## 从源码构建

```bash
mvn clean package
# 产物：target/exchange-bridge-1.0.0.jar
```

需要 JDK 8+（构建机上用更高版本也会压到 Java 8 字节码输出）。

## License

MIT
