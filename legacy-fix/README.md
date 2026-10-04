# KokuuLegacyFix —— 让 CMILib 在 Minecraft 1.12.2 上正确解析材质

一个几十行的 Bukkit 插件，只做一件事：**补全 CMILib 在 1.12.2 上解析不出来的材质映射。**

解决的表面症状有两个，但它们是**同一个根因**：

| 症状 | 表现 |
|---|---|
| `ClassCastException` | `CraftMetaItem cannot be cast to SkullMeta`，每次启动刷若干条 |
| 物品价值表缺失 | `Can't load worth value for POPPY / OAK_LEAVES / ...`，约 40 条 |

---

## 1. 根因

CMILib 1.6+ 是**按 Minecraft 1.13+ 写的**：它的 `CMIMaterial` 枚举常量用扁平化（1.13+）
名字，靠 `updateMaterial()` 反查 Bukkit 的 `Material`。在 1.12.2 上那条反查**三条路全断**：

**① 按数字 ID 匹配 —— 永远不中**

```java
public Integer getLegacyId() { return -1; }        // 基类直接 -1，无人覆写
...
if (Version.isCurrentEqualOrLower(v1_13_R2) && this.getId() != null) {
    for (Material one : Material.class.getEnumConstants()) {
        if (one.getId() != this.getId().intValue()) continue;   // 永远不等于 -1
        this.mat = one;
    }
}
```

**② 按名字匹配 —— 依赖 1.13+ 才存在的兼容材质**

```java
if (!one.name().replace("LEGACY_", "").replace("_", "")
        .equalsIgnoreCase(this.name().replace("_", ""))) continue;
```

`LEGACY_OAK_LEAVES` 这类兼容材质**是 1.13+ 才有的**；1.12.2 的枚举里根本没有
`OAK_LEAVES` 这种名字（它叫 `LEAVES`），剥掉 `LEGACY_` 也没用。

**③ 按旧版别名匹配 —— 这段循环写错了**

```java
if (this.mat == null && !this.getLegacyNames().isEmpty()) {
    outer: for (Material one : Material.class.getEnumConstants()) {
        for (String legacy : this.getLegacyNames()) {
            if (匹配) continue;
            continue outer;        // ← 一个不匹配就跳过整个材质
        }
        this.mat = one;
        break;
    }
}
```

内层循环跑完才会赋值，而 `continue outer` 在**任一**别名不匹配时触发。于是：

- 只带**一个**别名的常量能成功 —— `ACACIA_LEAVES("LEAVES_2", ...)` → 命中 `LEAVES_2`；
- 带**两个及以上**的永远失败 —— `CRAFTING_TABLE("Crafting Table", "WORKBENCH")`
  需要同一个材质名既等于 `CraftingTable` 又等于 `WORKBENCH`，不可能。

**这就是「207 个成功、40 个失败」那条精确的分界线。**

## 2. 失败之后为什么会变成那两种症状

`mat` 为 null 时，`newItemStack()` 会**返回一块石头**：

```java
public ItemStack newItemStack(int amount) {
    if (this.mat == null) {
        return new ItemStack(Material.STONE);      // ← 退化
    }
    ...
    ItemStack stack = new ItemStack(this.mat, 1, this.getLegacyData());   // 1.12.2 分支
}
```

于是：

- 任何把它当头颅用的地方 —— `CMIItemStack.getHead()` 里
  `(SkullMeta) item.getItemMeta()` —— 对石头取 meta 得到 `CraftMetaItem`，
  强转 `SkullMeta` 直接抛 **`ClassCastException`**；
- CMI 的价值表加载器拿不到物品，于是 `consoleMessage("&cCan't load worth value for ...")`
  并 `continue` 跳过该条目。

## 3. 为什么「直接把 mat 补上」不管用

这是本插件第一版的失败原因，值得单独记一笔。

真正决定 `getItem("POPPY")` 能否查到东西的，是 `ItemManager.load()` 建的 `byName` 查找表：

```java
public void load() {
    byRealMaterial.clear();
    for (CMIMaterial one : CMIMaterial.values()) {
        one.updateMaterial();
        Material mat = one.getMaterial();
        if (mat == null) continue;                 // ★ 材质为 null 的常量被整个跳过
        ...
        byName.put(materialName, one);             // ★ 这张表才是 getItem() 查的
    }
}
```

而 `WorthManager` 是这么读 `Worth.yml` 的：

```java
if ((item = CMILib.getInstance().getItemManager().getItem(name)) == null
        || item.getItemStack() == null) {
    plugin.consoleMessage("&cCan't load worth value for " + name);
    continue;
}
```

所以：**只补 `mat` 而不重建 `byName`，`getItem()` 依然返回 null，价值表一条都不会修好。**
第一版的日志诚实地打了「已补全 291 个材质映射」—— 那句话是真的，但毫无用处。

> 教训：改完状态要验证**最终指标**（`Loaded (245) worth values`），
> 而不是「中间步骤有没有执行」。

## 4. 本插件的做法

1. 对每个 `mat == null` 的常量，往它的私有 `legacyName` 字段写入**恰好一个**
   正确的 1.12.2 材质名 —— 一个元素正好绕过 §1 ③ 那个「全部匹配」条件；
2. 调用 CMILib 自己的 `ItemManager.load()` 重建索引。这一步会重跑
   `updateMaterial()`，而由于 `legacyName` 已经对了，这次它算得出正确的 `mat`，
   进而把常量放进 `byName`；
3. 清空头颅静态缓存（`CMIEntityType.cache`）—— CMILib 启动时那批「石头头颅」
   已经被缓存住了，不清就不会重建。

材质名怎么来：`Material.valueOf(常量名)` → CMILib 自带别名 → 用户 `aliases.yml`
→ 内置别名表 → 16 色/后缀规则。拿不准就**不猜**（猜错会把物品变成另一种东西，
比缺一条价值更糟），写进 `unresolved.txt` 让用户自己补。

## 5. 加载顺序是功能的一部分

```
CMILib.onEnable    updateMaterial() + ItemManager.load()   ← 此时 mat 与 byName 都残缺
本插件 onEnable    写 legacyName + 重跑 load() + 清缓存     ← 必须夹在中间
CMI.onEnable       读 Worth.yml / 家 / kit                 ← 这时才是对的
```

因此：

```yaml
depend: [CMILib]      # 要它先把 updateMaterial() 跑完
loadbefore: [CMI]     # 要赶在 CMI 读价值表之前
```

**不要**改成 `loadbefore: [CMILib]`（想更早跑）：那样写入的值会被随后的
`updateMaterial()` 重新置空 —— 这是实测踩过的坑，不是推测。

## 6. 构建与安装

```bash
mvn package          # 产物 target/kokuu-legacy-fix-1.0.0.jar
```

把 jar 丢进 `plugins/`，重启服务端。首次运行会生成
`plugins/KokuuLegacyFix/aliases.yml` 与 `unresolved.txt`。

## 7. 实测效果（CatServer 1.12.2 + CMI 9.8.10.3 + CMILib 1.6.0.1）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `ClassCastException` | 每次启动 5 条 | 0 条 * |
| 物品价值表 | 207 条，40 条失败 | **245 条，零失败** |
| 材质解析 | 402 / 1852 | **682 / 1852** |
| 启动日志 | 上千行常量清单 | 一行汇总，明细写文件 |

\* 那 5 条 CCE 来自 CMILib **自己**的 GUI 图标配置，本插件挡不住（它跑在那之后）。
**修法是改配置，不需要插件**：`plugins/CMILib/config.yml` 的
`GlobalGui.Pages.Previous/Next/Middle`、`GlobalGui.Close`、`GlobalGui.Info`
默认值是 `head:<皮肤纹理>`，换成普通物品（`ARROW` / `PAPER` / `BARRIER` / `BOOK`）即可。

## 8. 已知限制

- **物品数据值拿不到。** CMILib 在 1.12.2 上 `getLegacyData()` 恒返回 `-1`
  （基类实现，无人覆写），所以 1.13 拆分开的彩色方块只能映射到基础材质名，
  颜色会统一成「第一个色」。价值表按材质计价不受影响，但别指望染色正确。
- **`unresolved.txt` 里 1000+ 条是正常的。** CMI 9.8 覆盖到 1.21+，
  里面有蜡烛、铜、Sculk 之类 1.12.2 根本没有的东西。
- **只为 1.12.2 存在。** 在 1.13+ 上 CMILib 本来就正常，本插件会什么都不做。

## 9. 许可

MIT，见仓库根目录的 [LICENSE](../LICENSE)。

本插件通过反射调用 CMILib，**不包含也不分发 CMILib / CMI 的任何代码**
（两者是 Zrips 的付费插件）。
