# KokuuScoreboard

由 `config.yml` 驱动的侧边栏记分牌。显示玩家、在线数、延迟、余额、TPS 等基础信息。

**它只管显示。** 不持有数据、不写文件、不连数据库、不和平台通信 ——
所以它不会成为「另一个真相源」，出问题最多是少显示一行。

```
玩家 ──▶ 侧边栏（本插件）
           ├─ 玩家状态  ← Bukkit API
           ├─ 余额      ← Vault（软依赖，没装就显示占位文案）
           └─ TPS       ← 插件自己量（1.12.2 没有 Server#getTPS）
```

---

## 安装

1. 从 `scoreboard/` 构建：`mvn package`（需要 JDK 8+，产物是 Java 8 字节码）
2. 把 `target/kokuu-scoreboard-1.0.0.jar` 丢进服务端的 `plugins/`
3. 启动一次，生成 `plugins/KokuuScoreboard/config.yml`
4. 改配置 → `/kokuusb reload`（不用重启）

> **装了 CMI 之类的插件请把它的侧边栏关掉。**
> 一个玩家同一时刻只能有一块侧边栏，两边都开会互相覆盖、看起来在闪。
> 本插件发现被接管会重新抢回来并在控制台提醒一次。

---

## 命令

| 命令 | 权限 | 说明 |
| --- | --- | --- |
| `/kokuusb` | — | 看自己的状态与用法 |
| `/kokuusb on\|off` | `kokuusb.use` | 自己开关（重连后仍生效，重启服务端恢复默认） |
| `/kokuusb on\|off <玩家>` | `kokuusb.admin` | 管理员替别人开关 |
| `/kokuusb reload` | `kokuusb.admin` | 重载 `config.yml` |
| `/kokuusb verify` | `kokuusb.admin` | 按当前配置**真的造一块板子**做自检 |

`/kokuusb verify` 值得单独说：配置写超了会被服务端拒绝，而那种错误**只在有玩家进服时才暴露**。
服主改完配置重启、当时没人在线，控制台一切正常；等玩家进来才发现侧边栏没有。
`verify` 不需要玩家在线就能把问题当场说清。

---

## 占位符

| 占位符 | 说明 |
| --- | --- |
| `%player%` `%displayname%` | 玩家名 / 显示名（含称号前缀） |
| `%world%` `%x%` `%y%` `%z%` | 所在世界与整数坐标 |
| `%online%` `%max%` | 当前在线 / 最大人数 |
| `%ping%` | 延迟（毫秒） |
| `%balance%` `%balance_raw%` `%currency%` | 游戏内余额（Vault）、纯数字、货币名 |
| `%tps%` | TPS，一位小数 |
| `%health%` `%food%` `%level%` `%gamemode%` | 生命 / 饥饿 / 等级 / 游戏模式 |
| `%time%` `%date%` `%uptime%` | 时间 / 日期 / 服务端已运行时长 |

写错的占位符**原样显示**（`%word%` 就显示成 `%word%`），这样一眼能看出是自己拼错了，
而不是变成空串让人以为是少了半行。

读不到的值显示成 `unknownFallback` 而不是 `0` —— 一个看起来像真实读数的 `0`
会被当成「延迟很好」。

---

## 长度限制（这一节是本插件存在的主要理由）

prefix / suffix 的长度上限**随版本不同，而且是服务端强制的**：

| 位置 | 1.8 ~ 1.12 | 1.13+ |
| --- | --- | --- |
| `Team` prefix / suffix | **各 16 字符**（含 `§` 颜色码） | 各 64 |
| `Objective` 名字 | **16 字符** | 16 |
| `Objective` 标题 | 32 字符 | 32 |

这些不是估计值 —— 是把 CatServer 1.12.2 的 jar 反汇编出来读到的：

```java
// CraftTeam#setPrefix
Validate.isTrue(prefix.length() <= 16,
                "Prefix '" + prefix + "' is longer than the limit of 16 characters");
// CraftScoreboard#registerNewObjective
Validate.isTrue(name.length() <= 16, "The name '...' is longer than the limit of 16 characters");
// CraftObjective#setDisplayName
Validate.isTrue(displayName.length() <= 32, "... limit of 32 characters");
```

超了会抛 `IllegalArgumentException`。**本插件的处理**：

- 放得进 prefix 就放 prefix；
- 放不进就把**末尾**那段挪到 suffix，并补上切点处仍在生效的颜色
  （不补的话后半段会变回默认白色）；
- 两段都放不下的中间部分才丢弃，并对该行**警告一次**（不是每秒刷屏）。

⚠️ 容易看混的一处：`objectiveName` 的上限是 **16**，标题的上限是 **32**。
把 `objectiveName` 写到 17 个字符的后果格外难查 ——
异常会穿过刷新任务，而 Bukkit 遇到任务抛异常会**取消那个任务**，
表现是「侧边栏永远不出现、控制台只刷一次错」。所以配置校验在启动时就挡掉它。

---

## 开发

```bash
cd scoreboard
mvn package        # 构建 + 跑测试
```

测试有 42 项，重点钉住两件靠人工很难验的事：

1. **切分不超限** —— 假记分板把每次 `setPrefix` / `setSuffix` 的内容记下来，
   直接断言「交给服务端的字符串永远 ≤ 16」。这个 bug 只在有玩家在线时出现，
   开客户端去试太不可靠。
2. **`dispose()` 真的注销了 objective** —— 见下。

注意 `pom.xml` 里的 `maven.compiler.release=8` 是**硬约束**：
1.12.2 服务端只能跑 Java 8，调高的后果是生产上 `UnsupportedClassVersionError`。
CI 里有一步 `tools/check-java8-bytecode.mjs` 机器化地卡住它。

---

## 一个真实踩过的坑：`setScoreboard` 不会让侧边栏消失

「关闭侧边栏」最直觉的写法是把玩家换回主记分板：

```java
player.setScoreboard(Bukkit.getScoreboardManager().getMainScoreboard());
```

**这没用。** 用真实客户端协议抓包实测：执行之后服务端**一个包都不发** ——
CraftBukkit 的 `setScoreboard` 只按「新板子里有哪些显示槽位」去通知，
而主记分板上通常没有 sidebar objective，于是它什么都不说，
客户端继续显示最后那一帧。玩家执行 `/kokuusb off` 之后侧边栏还在，命令看起来「没用」。

正确做法是 `Objective#unregister()` —— 它走 NMS 的
`ScoreboardServer.removeObjective`，会**主动给正在看这块板子的玩家**发
`scoreboard_objective action=1`（移除 objective，客户端会连槽位一起清掉）
以及各队伍的移除包。

顺序不能换：**必须先注销、再换回主记分板**。一旦先换了，玩家已经不看这块板子了，
清除包就发不出去。

```
$ kokuusb off <玩家>
  → scoreboard_objective {"name":"kokuu_sb","action":1}    ← 侧边栏整个消失
  → teams {"team":"kokuu_line_0","mode":1}                ← 10 行依次移除
  → ...
```
