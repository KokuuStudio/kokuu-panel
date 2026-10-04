# 与现有 kokuu 生态的对接契约

> 本文是**修正性文档**。它推翻了本仓库早期设计里的一个错误决定，
> 写它的起因是读了 KokuuStudio 现有仓库的 README 与 Blessing Skin 的源码。
> 对接代码之前**必须先读完本文**。

---

## 0. 一个必须先承认的错误

本仓库早期把经济做成了**平台自带的账本**：

```
economy_accounts (uuid → balance)
economy_ledger   (event_id 唯一索引的流水)
```

而你的生态里**已经有唯一账本**：

| 位置 | 内容 |
|---|---|
| `users.score` | **唯一事实来源**（Blessing Skin 的 `users` 表） |
| `credit_ledger` | 流水 + 幂等（`event_id` 唯一索引） |
| `kokuu_credit_ledger()` | 唯一的写入函数 |

`kokuu-credit` 的 README 把理由写得很清楚：

> 论坛的定位是「**加分事件来源**」，不是账本。皮肤站的 `users.score` 是唯一事实来源……
> **账本只有一份，就不会有「两边余额对不上」的问题。**

`kokuu-coupon` 的 README 又补了同一条纪律的另一面：

> 底仓 `min_keep` 与 kokuu-exchange 共用……**本插件只读这个配置，不写它。**
> 两个插件若各写各的，会出现「兑换插件按 100 拦、抽奖按 0 拦」，把余额扣穿。

**平台自建账本正是这条纪律要防的事。** 装上它就会立刻多出第二个余额，
而且因为平台侧也有 `event_id` 幂等，两边会各自「正确地」记成两笔不同的钱 ——
这不是 bug，是设计错误，而且是最难查的那一类。

**所以：平台不持有积分账本。** 平台的定位是**这些账本的操作界面与审计层**，
外加 Blessing Skin 管不到的那一半（游戏服务端本身）。

---

## 1. 生态全貌

```
                        ┌──────────────────────────────────────┐
                        │  auth.kokuu.org  (Blessing Skin 6.0) │
                        │  KokuuAuth                           │
                        │                                      │
   玩家注册 / 角色管理 ──▶│  users    uid / email / nickname     │
   服务端验证(Yggdrasil)─▶│           / score / permission       │
                        │           / register_at / last_sign_at│
                        │  players  pid / uid / name           │
                        │           / tid_skin / tid_cape      │
                        └───────────────┬──────────────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
        ▼                               ▼                               ▼
  kokuu-credit                   kokuu-coupon                    kokuu-exchange
  唯一账本 + OAuth2 服务端        兑换码 / 抽奖（产出端）           积分 → 游戏内货币
        │                       共用 min_keep 底仓 ◀──────────────▶ 共用 min_keep 底仓
        ▼
  kokuu-forum / kokuu-forum-points（论坛侧，只加分不扣分）
  kokuu-core（共享内核：FlarumClient / PlainText）
  kokuu-home / kokuu-quote（主题与展示）

                        ┌──────────────────────────────────────┐
                        │  KokuuPanel（本仓库）                 │
                        │  · 管「Blessing Skin 管不到的那一半」 │
                        │    = MC 服务端：封禁 / 权限组 / 控制台 │
                        │  · 做「已有数据的操作界面与审计层」    │
                        │    = 不新建账本，只读写上面那一个      │
                        └──────────────────────────────────────┘
```

---

## 2. 已经核实的事实（可直接照着写代码）

以下全部来自源码或项目 README，不是推测。

### 2.1 `users` 表

| 列 | 说明 |
|---|---|
| `uid` | 主键 |
| `email` | 登录名 / 找人的主要键 |
| `nickname` | **昵称字段是 `nickname`，不是 `username`** |
| `score` | **积分，唯一事实来源** |
| `password` | 哈希（有多种算法，见 `app/Services/Cipher/`） |
| `verified` | 邮箱是否验证 |
| `permission` | 权限等级（`0` 普通 / `1` 待审 / `2` 管理员 / 更高=超管） |
| `register_at` | 注册时间（int 时间戳） |
| `last_sign_at` | **最后一次签到**（datetime） |

⚠️ **没有 `username` 列**，也**没有 `last_login_at` 列**。
`kokuu-credit` 的 README 明确记过这两条都是踩过的坑。
「最后一次访问」与「最后一次签到」是两个字段，别混。

### 2.2 `players` 表（角色）

```php
// app/Models/Player.php
public $primaryKey = 'pid';
protected $fillable = ['uid', 'name', 'tid_skin', 'tid_cape', 'last_modified'];
```

| 列 | 说明 |
|---|---|
| `pid` | 主键，**角色 ID** |
| `uid` | 所属账号 |
| `name` | **角色名**（就是游戏内 ID） |
| `tid_skin` / `tid_cape` | 当前皮肤 / 披风纹理 |
| `last_modified` | 即 `updated_at`（`const UPDATED_AT = 'last_modified'`） |

**关键：一个账号（`uid`）可以拥有多个角色（`pid`）。**
这是`auth.kokuu.org`首页宣传的「Multi Player — You can add multiple players
within one registered account」。

### 2.3 `credit_ledger` 表

| 列 | 说明 |
|---|---|
| `id` | 自增 |
| `event_id` | **幂等键，唯一索引** |
| `uid` | 目标账号 |
| `delta` | 变动值 |
| `balance_after` | 变动后余额 |
| `source` | 来源标记 |
| `ref` | 来源引用 |
| `note` | 备注 |
| `created_at` | 时间 |

⚠️ 表名**没有 `kokuu_` 前缀**。
⚠️ **没有 `reason` 列**，来源是 `source`。

### 2.4 `event_id` 的既有命名约定

写新的 `event_id` 必须沿用这些前缀，否则流水页的来源分组会乱：

| 前缀 | 来源 |
|---|---|
| `thread:<id>` / `reply:<id>` / `liked:<id>` | 论坛加分 |
| `coupon:<rid>` | 兑换码 |
| `draw:<did>` | 抽奖 |
| `manual:<操作者uid>:<目标uid>:<nonce>` | 管理员调分 |
| `admin:coin:<玩家名>:<时间戳>` | 金币下发（exchange-bridge） |
| `rf:<uuid无横线>:<毫秒时间戳>` | 金币回流 |

### 2.5 `source` 中文标签只有一处定义

```php
kokuu_credit_source_labels(): array   // 权威映射表
kokuu_credit_source_label($source)    // 单值查询，内部委托上面那个
```

历史教训（`kokuu-credit` README）：这份表曾散在**三个地方**，
结果 `manual` 在一个页面写「手动调整」、另一个页面写「管理员手动」——
**同一笔流水两个文案**。平台若要展示来源标签，**必须**调这两个函数之一，
不许自己再写一份映射。

### 2.6 底仓 `min_keep` 是共享配置

- option key：`kokuu_exchange_min_keep`（默认 100）
- `kokuu-exchange` 与 `kokuu-coupon` **都读它，都不写它**
- 语义：用户自己兑换 / 抽奖时不允许把余额扣到底仓以下

平台若涉及扣积分的功能，**必须读同一个 option**。
另外记住 `kokuu-credit` 已确立的例外：**管理员调分不受底仓约束**，
但**负余额仍然拒绝**（管理员需要能纠错，但不能把余额搞成负数）。

### 2.7 `kokuu-credit` 已有的接口

| 路径 | 中间件 | 用途 |
|---|---|---|
| `POST api/earn` | `api` | 论坛加分上报，**HMAC-SHA256 签名**（`ts`+`nonce`+`event_id`+`sign`） |
| `GET api/balance` | `api` | 查余额 |
| `GET api/ledger` | `api` | 流水分页 |
| `GET api/users?q=` | `web` | 搜索（`uid` / 昵称 / 邮箱），20 条 |
| `POST api/adjust` | `web` | **管理员调分，需要 session + CSRF** |
| `GET api/userinfo` | `api` | OAuth2 userinfo 端点 |

⚠️ **服务端到服务端不能用 `web` 中间件** —— `VerifyCsrfToken` 会拦成
`419 Page Expired`。所以 `api/adjust` **不能**被平台直接调用。

### 2.8 `kokuu-credit` 是 OAuth2 授权服务器

- 基于内核自带的 Passport
- **PKCE S256 强制**
- scope = `User.Read`
- `state` 存 session，`hash_equals` 比对，取出即清，TTL 600s
- access_token 是 **JWT（RS256）**，不是随机串
- `userinfo` 返回 `{ sub, user: { uid, nickname, email, verified, score, permission, register_at, last_seen_at } }`

论坛（`kokuu-forum`）就是它的一个 OAuth2 客户端。
**平台可以作为第二个客户端接入** —— 这样平台的后台账号可以直接用皮肤站账号，
不用再自建一套用户名口令。

### 2.9 Yggdrasil（服务端验证）不在 Blessing Skin 核心里

我拉取了 Blessing Skin `master` 的 `app/` 完整文件树：**没有 Yggdrasil 控制器**。
它由插件提供（`kokuu-coupon` README 提到的 grid 回调链里就有「Yggdrasil」，
说明贵站装了该插件）。

**这带来一个必须验证的问题**（见 §4 第 1 条）。

---

## 3. 因此，平台的设计如何改

| 模块 | 原设计（错） | 修正后 |
|---|---|---|
| **积分账本** | 平台自建 `economy_accounts` / `economy_ledger` | **不自建**。读写 `users.score` / `credit_ledger`，或经 `kokuu-credit` 的签名接口 |
| **玩家身份** | 以 MC UUID 为锚点 | **以 Blessing Skin `pid` 为锚点**，UUID 与角色名都是它的属性 |
| **账号体系** | 平台自建用户名口令 | 优先接 `kokuu-credit` 的 **OAuth2**；自建仅作为无皮肤站部署的降级路径 |
| **封禁** | 按 UUID | 按 `pid`（**见 §4 第 1 条**：UUID 可能随角色改名而变），执行时再解析出当前 UUID/角色名 |
| **LuckPerms** | 保持 | **保持**——这确实是 Blessing Skin 管不到的一半，是平台的独有价值 |
| **控制台 / 性能 / 白名单** | 保持 | **保持**——同上 |
| **审计** | 保持 | **保持**——而且这是平台相对皮肤站后台的真正增量：皮肤站记了积分流水，但没人记「谁在哪个服封了谁」 |
| **来源标签 / 底仓** | 平台自配置 | 复用 `kokuu_credit_source_labels()` 与 `kokuu_exchange_min_keep`，**不复制** |

一句话概括修正后的定位：

> **KokuuPanel 是「只对管理员开放」的玩家管理后台。**
> 它管两件事：① Blessing Skin 管不到的那一半（MC 服务端本身）；
> ② 把已有数据（积分、角色、流水）聚合成一个能操作、能审计的界面。
>
> 它**不是**玩家门户：没有面向玩家的页面，只有皮肤站管理员
> （`users.permission ≥ 2`）能登入。

---

## 4. 已核实的事实（在测试环境上实测）

> 数据来源：`38.22.95.63`（Ubuntu 22.04，`/var/www/kokuu-auth`），只读查询。
> 已装插件：`kokuu-core` / `kokuu-coupon` / `kokuu-credit` / `kokuu-exchange` /
> `kokuu-forum` / `kokuu-home` / `kokuu-quote` / `kokuu-ui` /
> **`single-player-limit` 3.0.4** / **`yggdrasil-api` 5.2.1**。

### 4.1 ✅ UUID 是按「角色名」派生的，不是稳定身份

**这是本次最重要的一条，它直接决定封禁该怎么存。**

`yggdrasil-api` 的 `Profile::getUuidFromName()`：

```php
$result = DB::table('uuid')->where('name', $name)->first();
if ($result) return $result->uuid;                    // 惰性分配后持久化
$uuid = option('ygg_uuid_algorithm') === 'v3'
    ? static::generateUuidV3($name)                   // md5('OfflinePlayer:'.$name)
    : Uuid::uuid4()->getHex()->toString();
DB::table('uuid')->insert(['name' => $name, 'uuid' => $uuid]);
```

本站配置：**`ygg_uuid_algorithm = v3`**。

实测对照（玩家 `Kansamu`）：

| | 前 12 位 | 版本位 | 后 20 位 |
|---|---|---|---|
| `uuid` 表存的 | `fbde4894fff2` | **`3`** | `30a3ca4be322076961` |
| `MD5('OfflinePlayer:Kansamu')` | `fbde4894fff2` | **`1`** | `3023ca4be322076961` |

只有 UUID v3 的版本位与变体位不同 —— **这就是离线模式算法**。
`uuid` 表只有 1 行而 `players` 有 3 行，也印证了「首次经 Yggdrasil
登录时才惰性分配」。

#### 由此推出的硬约束

| 结论 | 后果 |
|---|---|
| **UUID 是角色名的纯函数** | 改名 → 立刻得到**新 UUID**，旧 UUID 对应旧名字 |
| **按 UUID 存封禁可以被改名绕过** | 玩家改个名就回来了，而管理员会以为「封禁莫名其妙丢了」 |
| **`pid` 才是稳定身份** | 一个角色一条 `players` 行，改名不换 `pid` |
| **UUID 可能还没被分配** | 从没通过 Yggdrasil 登录过的角色在 `uuid` 表里没有行 |

**所以封禁必须按 `pid` 存，执行时再解析出当前 `name` 与当前 `uuid`。**
平台侧 `players` 表也因此要以 `pid` 为业务键，`uuid` 退化成
「当前解析结果」这样的可缓存属性，而不是主键。

### 4.2 ✅ 表结构（实测，非推测）

**`users`**（16 列）：`uid`(PK) `email`(UNI) `nickname` `locale` `score`
`avatar` `password` `ip` `is_dark_mode` `permission` `last_sign_at`
`register_at` `verified` `verification_token` `remember_token`

- 确认**没有 `username` 列**，昵称字段是 `nickname`
- 确认**没有 `last_login_at`**；`last_sign_at` 是**签到**时间
- **`ip` 列已存在** —— 皮肤站自己记了最后登录 IP。
  平台不必从零收集 IP，可以直接复用这一个值（但它只有「最后一次」，
  没有历史；平台若要 IP 历史仍需自己累积）

**`players`**（6 列）：`pid`(PK) `uid` `name` `tid_cape` `last_modified` `tid_skin`

**`uuid`**（3 列）：`id`(PK) `name` `uuid` —— name → uuid 的惰性分配表

**`credit_ledger`**（10 列）：`id`(PK) `event_id`(UNI, **varchar(80)**)
`uid` `delta` `balance_after` `source`(varchar 32) `ref` `note` `created_at` `updated_at`

- ⚠️ **`event_id` 上限 80 字符**。平台生成幂等键时必须留够余量 ——
  `manual:12:34:<32位nonce>` 就已经 50+ 字符了，别再加长前缀
- 确认**没有 `reason` 列**，来源是 `source`
- 表名**没有 `kokuu_` 前缀**

**`mojang_verifications` 表不存在** → 本站不接 Mojang 正版验证，
纯粹是「离线模式 + 自建 Yggdrasil」。所以**不要**为「正版 UUID」写任何分支。

### 4.3 ✅ 积分要从哪条路走？

三条路，各有代价：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 签名 HTTP 接口**（推荐） | 给 `kokuu-credit` 加一个 `POST api/adjust-signed`，仿照已验证的 `api/earn` 用 HMAC 签名，允许带符号 `delta` | 要改 `kokuu-credit` 一个文件；换来平台**完全不碰皮肤站数据库** |
| **B. 直连皮肤站 MySQL** | 平台连同一个库，在事务里写 `users.score` + `credit_ledger` | 平台需要数据库凭据；但这是 `kokuu-credit` 自己在做的事，语义一致 |
| **C. 平台自建账本** | 原设计 | ❌ **不建议**：两个余额，不可对账 |

**仍然倾向 A。** 理由与 `kokuu-credit` 否决 `forum-integration` 的理由一致：
跨库直写会绕过 ORM 与模型事件，而一个签名接口把「谁能改钱」收敛到一处。

> 补充：`kokuu-credit` **已经有**管理员调分（`POST api/adjust`，含 add/sub/set
> 三种模式与完整校验清单），但它挂的是 `web` 中间件 —— 需要 session + CSRF，
> **服务端到服务端调不了**。所以方案 A 只需把那段逻辑包一层签名校验，
> 不必重写业务规则。

### 4.4 ✅ 后台登录用哪套账号？

| 方案 | 说明 |
|---|---|
| **A. 接 OAuth2**（推荐，已实现） | 平台作为 `kokuu-credit` 的第二个客户端，`scope=User.Read`，`permission ≥ 2` 才放行。**没有第二套口令，且天然只有皮肤站管理员能登** |
| B. 平台自建账号 | 已实现，作为**无皮肤站部署的显式回退** |

两者都已实现：配齐 `KP_SKIN_URL` / `KP_OAUTH_CLIENT_ID` /
`KP_OAUTH_CLIENT_SECRET` / `KP_OAUTH_REDIRECT_URI` 就走 OAuth2，
否则回落到本地账号，且启动日志与登录页都会说明当前用的是哪一种。

---

## 5. 落地顺序（在 §4 有答案之后）

### ✅ 已完成（身份锚点改造）

| 步骤 | 落点 |
|---|---|
| 玩家身份改造 | `characters` 表（角色目录）+ `players.bs_pid` / `punishments.bs_pid`（schema v3） |
| 封禁改按 `pid` | `createPunishment` 存 `bs_pid`；`listActivePunishmentsForPid` 是判罚主查询 |
| 改名可检测 | 目录保留 `prev_names` / `prev_uuids`，按旧名旧 UUID 都能定位同一个人 |
| 身份刷新 | `updatePunishmentIdentity` 在改名后刷新下发快照并递增 revision |
| **可绕过风险显式化** | `GET /_api/characters/status` 的 `renameBypassable`；创建封禁解析不出 pid 时返回 `warning` |
| 目录导入 | `tools/import-characters.mjs`（幂等，支持 TSV/CSV/JSON/stdin/mysql） |
| 验证 | `characters.test.ts` 19 项（含改名后封禁仍生效 + 反面对照）；e2e 新增「身份锚点」4 项 |

**关键设计取舍**：解析不出 pid 时**不猜**。假造一个 pid 会把不同的人合并成
同一个账号 —— 那比「解析不出来」危险得多。宁可留空并告警。

### ⏳ 仍然待办

1. **目录同步自动化**：现在靠手工跑 `import-characters.mjs`。
   要做到「改名当天就拦住」，需要定时同步。做法见下面「目录同步怎么做」。

   这个阈值已经用 `staleAfterMs`（默认 24h）暴露出来了 ——
   目录超过一天没同步，`GET /_api/characters/status` 就会报 `stale: true`。
2. **拆掉自建账本**：`economy_accounts` / `economy_ledger` 仍在库里。
   默认已是 `KP_LEDGER_MODE=external`（接口回 501），但表还没删 ——
   等积分对接方案（§4.3）定了再一起动。
3. **来源标签与底仓改为读取皮肤站**（调 `kokuu_credit_source_labels()` /
   读 `kokuu_exchange_min_keep`），**不在平台侧重复定义**。
4. **接入 OAuth2 后台登录**：代码已完成，缺皮肤站侧建客户端 +
   配 `KP_OAUTH_*`。见 §4.4。

> ⚠️ 在配好 OAuth2 之前，登录页与启动日志都会明确标注
> 「本地账号（未配置 OAuth2）」，不会让人误以为已经接了皮肤站。

---

## 5b. 目录同步怎么做

原则：**导出在皮肤站机器上做，导入在平台机器上做。** 两边各用最顺手的工具，
中间只传一个文本文件。

### 平台与皮肤站同机（最简单）

```bash
# 每 6 小时同步一次。放在 crontab -e 里：
0 */6 * * * cd /opt/kokuu-panel && \
  node tools/import-characters.mjs --mysql "mysql -u kokuu_ro -p<口令> kokuu_auth" \
  >> /var/log/kokuu-characters.log 2>&1
```

### 平台与皮肤站不同机

皮肤站机器上导出到一个两边都能拿到的地方（或 `scp` 过去）：

```bash
# 皮肤站机器，crontab：
0 */6 * * * mysql -u kokuu_ro -p<口令> kokuu_auth -B -e "
  SELECT 'pid','uid','name','uuid' UNION ALL
  SELECT p.pid, p.uid, p.name, COALESCE(u.uuid,'')
    FROM players p LEFT JOIN uuid u ON u.name = p.name ORDER BY p.pid" \
  > /srv/share/characters.tsv

# 平台机器，crontab（错开半小时）：
15 */6 * * * cd /opt/kokuu-panel && \
  node tools/import-characters.mjs --file /srv/share/characters.tsv \
  >> /var/log/kokuu-characters.log 2>&1
```

### 只读账号

给同步用的账号**只需要 `SELECT` 两列**，不要用 root：

```sql
CREATE USER 'kokuu_ro'@'%' IDENTIFIED BY '<口令>';
GRANT SELECT ON kokuu_auth.players TO 'kokuu_ro'@'%';
GRANT SELECT ON kokuu_auth.uuid    TO 'kokuu_ro'@'%';
FLUSH PRIVILEGES;
```

> 这条与 §6「平台明确不碰的东西」不矛盾：平台不**写**皮肤站的表，
> 只读一张名字到 UUID 的映射，用来把游戏里的身份认成同一个人。
> 写操作（改积分、改角色）仍然只走 kokuu-credit / 皮肤站自己。

### 怎么确认它在工作

```bash
curl -s localhost:8787/_api/characters/status -H "cookie: …" | jq
```

看两个数字：

- `lastSyncedAgoMs` —— 应该接近你的同步周期，而不是几个小时前的
- `renameBypassable` —— **应该是 0**。不是 0 就说明有封禁可以被改名绕过



---

## 6. 平台明确不碰的东西

| 不碰 | 原因 |
|---|---|
| 玩家注册 / 登录 / 改密 | 那是 Blessing Skin 的职责，重复实现必然漂移 |
| 角色创建 / 删除 / 改名 | 同上（改名还会牵动 UUID，见 §4.1） |
| 皮肤上传 / 衣柜 | `kokuu-skin-server` + Blessing Skin 已有，且做得比我们好 |
| 论坛帖子 / 积分加分规则 | `kokuu-credit` + `kokuu-forum` 已有 |
| 兑换码与抽奖 | `kokuu-coupon` 已有，且它的幂等与底仓实现是对的 |
| 底仓 `min_keep` 的写入 | 共享配置，多写必漂 |

---

## 7. 平台**应该**碰的东西（真正的增量）

| 能力 | 为什么现有生态没有 |
|---|---|
| **封禁 / 禁言（跨服一致）** | 现在只在各服的 `banned-players.json` 里，多服必然漂移 |
| **LuckPerms 权限组管理** | 只能敲命令，没有界面 |
| **实时控制台 / 在线玩家 / 性能** | 完全空白 |
| **操作审计** | 皮肤站记积分流水，但**没人记「谁在哪个服封了谁、改了什么权限」** |
| **玩家档案聚合** | 现在要看「这个人」得同时开皮肤站后台和进游戏敲命令 |
| **白名单管理** | 只能敲命令 |

这七条就是平台的价值所在。**它们全都在「Blessing Skin 管不到的那一半」里** ——
这也解释了为什么平台的定位不该是「第二个皮肤站后台」。

---

## 8. 附：本次核实用到的来源

- `KokuuStudio/kokuu-credit` README —— 账本唯一性、OAuth2、接口与字段名、踩坑清单
- `KokuuStudio/kokuu-coupon` README —— 底仓共享、`event_id` 用法、`users` 表结构
- `KokuuStudio/kokuu-core` README —— 共享内核的抽取标准
- `bs-community/blessing-skin-server` `app/Models/Player.php` —— `players` 表列
- `bs-community/blessing-skin-server` `app/` 完整文件树 —— 确认核心无 Yggdrasil
- `auth.kokuu.org` —— Blessing Skin 6.0，站名 KokuuAuth
- `KokuuStudio/*` 仓库列表 —— 生态全貌（`kokuu-home` / `kokuu-quote` /
  `kokuu-skin-server` / `kokuu-forum` / `kokuu-forum-points` / `kokuu-core`）

> 本文引用的都是**外部项目的内容**，仅供对接参考。
> 字段名与行为在对方升级后可能变化 —— 写代码前 `DESCRIBE` 一次，
> 这是 `kokuu-credit` README 用惨痛经历换来的建议。
