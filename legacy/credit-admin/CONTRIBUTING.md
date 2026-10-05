# 贡献指南

## 这个项目的判据

**低耦合是硬要求，不是风格偏好。** 只有一个文件允许知道「皮肤站存在」：
`server/src/runtime.js`。往别的文件里加 `if (hasSkin)` 分支会让这个约束失效。

提 PR 前自问一句：**这个改动需要动几个文件？答案是 1 个的话，很可能放错地方了。**

---

## 开发

```bash
# 后端（standalone，不需要 MySQL）
cd server
BACKEND=standalone DATA_DIR=./data-test PORT=8799 \
  ADMIN_TOKEN=testtoken123 node src/index.js

# 前端
cd web && npm run dev     # → http://127.0.0.1:5273，代理到 8787
# 代理指向别处：VITE_API_TARGET=http://127.0.0.1:8799 npm run dev
```

---

## 测试

```bash
# 接口测试（同一份跑两种后端）
node src/apitest.mjs    http://127.0.0.1:8799 testtoken123
node src/reflowtest.mjs http://127.0.0.1:8799 testtoken123

# UI 验收：无头 Edge 打开页面，注入口令，走一遍所有页签并截图
node ops/verify-ui.mjs
```

**测试必须真的断言，不能只打印。** 断言失败要能一眼看出是什么坏了 ——
`console.log('ok')` 那种等于没写。

**不要写恒定的断言。** 硬编码的搜索词在换测试数据后就永远失败，
一个永远红的断言比没有断言更糟 —— 人会开始不信测试。
要动态读真实数据（比如从表格里取一个昵称的前缀）：

```js
// ✗ 换后端就挂
set.call(inp, 'Ko');
// ✓ 从真实数据推导
const nick = /* 从表格里读 */;
set.call(inp, nick.slice(0, 2));
```

---

## 代码风格

**注释解释「为什么」，不解释「是什么」。**

```js
// ✗ 把代码翻译一遍
// 加 1
i++;

// ✓ 解释那个不能被后人「顺手优化掉」的约束
// 索引登记必须放在这里无条件做，不能只在「uuid 变了」时做。
// 新建账户时构造对象已带上 uuid，a.uuid !== u 不成立，
// 索引会永远漏登记 —— 表现是「改名后彻底失联」。
if (u) this.byUuid.set(u, k);
```

**边界情况要在代码里留痕。** 这类系统里最贵的成本是「三个月后没人记得
为什么这里有个看起来多余的判空」。写下来。

---

## 安全相关的改动

改了以下任一处，**必须在 PR 描述里说明你考虑过哪些攻击手法**：

- 入参校验（`assets.js`）
- 鉴权（`auth.js`）
- 账本写入（`ledger.js` / `local-ledger.js` / `skin-ledger.js`）
- 消息格式（任何跨进程传的东西：Redis 队列、HTTP body）

判断标准：**这个字段能不能被玩家控制？** 能的话它就是攻击面。
玩家名能进控制台指令和日志，UUID 会进 SQL 参数和 Redis 消息体 ——
两者都必须过白名单。全 0 的「从未上线」UUID 也要挡，
拿它当主键会把所有没上线过的名字合并成同一个账户。

---

## 提交信息

用中文，动词开头，说明**为什么**而不是改了什么：

```
✓ 修掉 byUuid 索引漏登记导致改名后失联
✗ update ledger.js
✗ 修复若干问题
```

---

## 插件侧（exchange-bridge）

Java 插件在独立仓库。它的硬约束：

- **Java 8 字节码**（`maven.compiler.release=8`）。
  CI 会校验 `major version == 52`。
  开发用 JDK 17，不校验就会漏过 —— 症状是 1.12.2 服务端
  `UnsupportedClassVersionError`，而新版本一切正常。
- **经济插件 API 一律反射**，不硬依赖。
  服务器可能没装那个插件，直接 import 会让本插件加载即崩。
- **调经济 API 必须切回主线程**。Bukkit 玩家 API 不是线程安全的，
  包括读余额和查在线玩家。

---

## 提 PR 前

```bash
cd server && npm run build 2>/dev/null   # 或直接确认改动能起来
cd ../web && npm run build               # 前端必须能构建
```

- [ ] 测试全过（`apitest` + `reflowtest` + `verify-ui`）
- [ ] 前端能构建
- [ ] 新增配置项同步更新了：`.env.example`、`README.md` 配置表、
      管理台 `/config` 的 `INITIAL`、`CONFIG_LABELS`、前端 `FIELDS`
      （**漏一处就表现为「配了但不生效」或「开关点了没反应」**）
- [ ] 改过账本逻辑的话，同步 `schema.js` 的 `MIGRATIONS`
      （`CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作，
      老部署升级后不会自动多出新列）
- [ ] 安全相关改动已在描述里说明攻击面分析
