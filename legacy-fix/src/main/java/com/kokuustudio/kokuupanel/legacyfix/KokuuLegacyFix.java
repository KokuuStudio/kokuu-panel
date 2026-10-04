package com.kokuustudio.kokuupanel.legacyfix;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.bukkit.Material;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * 为 1.12.2 补全 CMILib 缺失的材质映射。
 *
 * <h2>问题是什么</h2>
 *
 * CMILib 1.6.0.1 是按 Minecraft <b>1.13+</b> 写的：它的 {@code CMIMaterial}
 * 枚举常量用扁平化（1.13+）名字，靠 {@code updateMaterial()} 反查 Bukkit 的
 * {@code Material}。在 1.12.2 上那条反查会失败，三条路都断了：
 *
 * <ol>
 *   <li>{@code getLegacyId()} 基类直接 {@code return -1}，所以「按数字 ID 匹配」
 *       永远匹配不到任何材质；</li>
 *   <li>按名字匹配时会剥掉 {@code LEGACY_} 前缀 —— 而 {@code LEGACY_*} 兼容材质
 *       是 1.13+ 才有的，1.12.2 的枚举里根本没有 {@code OAK_LEAVES} 这类名字；</li>
 *   <li>按 {@code getLegacyNames()} 匹配的那段循环<b>写错了</b>：
 *       <pre>
 * for (Material one : Material.values()) {
 *     for (String legacy : this.getLegacyNames()) {
 *         if (匹配) continue;
 *         continue outer;    // ← 要求「这个常量的所有别名都等于同一个材质名」
 *     }
 *     this.mat = one; break;
 * }
 *       </pre>
 *       于是只带<b>一个</b>别名的常量能成功（如 {@code ACACIA_LEAVES("LEAVES_2")}），
 *       带<b>两个及以上</b>的永远失败（{@code CRAFTING_TABLE("Crafting Table","WORKBENCH")}
 *       要同时等于 {@code CraftingTable} 和 {@code WORKBENCH}，不可能）。</li>
 * </ol>
 *
 * <h2>为什么「直接补 mat」不够</h2>
 *
 * {@code ItemManager.load()} 才是真正建索引的地方：
 *
 * <pre>
 * for (CMIMaterial one : CMIMaterial.values()) {
 *     one.updateMaterial();
 *     if (one.getMaterial() == null) continue;   // ← 材质为 null 的被整个跳过
 *     byName.put(materialName, one);             // ← 而 byName 是 getItem("POPPY") 查的表
 * }
 * </pre>
 *
 * 所以只把 {@code mat} 补上而不重建 {@code byName}，{@code getItem("POPPY")}
 * 依然返回 null，CMI 照样报 {@code Can't load worth value for POPPY}。
 * （第一版就是这么失败的。）
 *
 * <h2>正确的修法</h2>
 *
 * 往每个常量的 {@code legacyName} 字段里塞<b>恰好一个</b>正确的 1.12.2 材质名，
 * 然后调用 {@code ItemManager.load()}。这样：
 *
 * <ul>
 *   <li>那个 buggy 循环收到单元素列表 → 条件恒真 → {@code updateMaterial()} 成功；</li>
 *   <li>{@code load()} 顺手把常量收进 {@code byName} → {@code getItem()} 查得到；</li>
 *   <li>不碰任何私有逻辑，走的是 CMILib 自己的代码路径 —— 它是幂等的，
 *       而且下次 CMILib 自己再调 {@code load()} 也不会退回去。</li>
 * </ul>
 *
 * <h2>加载顺序为什么这么写</h2>
 *
 * <pre>
 * CMILib.onEnable   → updateMaterial() + ItemManager.load()（此时 mat/byName 都是残缺的）
 * 本插件   onEnable  → 补 legacyName + 重跑 load() + 清头颅缓存   ← 必须在这之间
 * CMI.onEnable      → 读 Worth.yml / 家 / kit                    ← 这时已经修好了
 * </pre>
 *
 * 所以是 {@code depend: [CMILib]} + {@code loadbefore: [CMI]}。
 *
 * <h2>已知做不到的</h2>
 *
 * <b>CMILib 启动过程中自己打的 ClassCastException 消不掉。</b>
 * 它们发生在 {@code updateMaterial()} 之后、本插件运行之前。
 * 那些 CCE 来自 CMILib 自己的 GUI 图标配置（{@code GlobalGui.Pages.*} 等
 * 默认值是 {@code head:<纹理>}）—— <b>把配置里那几个 head 换成普通物品就没有了</b>，
 * 那是配置层面的修法，不需要插件。
 * 本插件对这些残留日志不做处理，因为挡不住。
 */
public final class KokuuLegacyFix extends JavaPlugin {

    private static final String CMILIB_MAIN = "net.Zrips.CMILib.CMILib";
    private static final String CMILIB_MATERIAL = "net.Zrips.CMILib.Items.CMIMaterial";
    private static final String CMILIB_ITEM_MANAGER = "net.Zrips.CMILib.Items.ItemManager";
    private static final String CMILIB_ENTITY_TYPE = "net.Zrips.CMILib.Entities.CMIEntityType";

    /**
     * 1.13+ 名字 → 1.12.2 名字。
     *
     * 只列「一眼能看出对应关系」的那些；其余交给逐级回退与 aliases.yml。
     */
    private static final Map<String, String> ALIASES = new LinkedHashMap<String, String>();

    static {
        // 头颅
        ALIASES.put("PLAYER_HEAD", "SKULL_ITEM");
        ALIASES.put("PLAYER_WALL_HEAD", "SKULL_ITEM");
        ALIASES.put("SKELETON_SKULL", "SKULL_ITEM");
        ALIASES.put("SKELETON_WALL_SKULL", "SKULL_ITEM");
        ALIASES.put("WITHER_SKELETON_SKULL", "SKULL_ITEM");
        ALIASES.put("ZOMBIE_HEAD", "SKULL_ITEM");
        ALIASES.put("ZOMBIE_WALL_HEAD", "SKULL_ITEM");
        ALIASES.put("CREEPER_HEAD", "SKULL_ITEM");
        ALIASES.put("CREEPER_WALL_HEAD", "SKULL_ITEM");
        ALIASES.put("DRAGON_HEAD", "SKULL_ITEM");
        ALIASES.put("DRAGON_WALL_HEAD", "SKULL_ITEM");

        // 树与木
        ALIASES.put("OAK_LEAVES", "LEAVES");
        ALIASES.put("SPRUCE_LEAVES", "LEAVES");
        ALIASES.put("BIRCH_LEAVES", "LEAVES");
        ALIASES.put("JUNGLE_LEAVES", "LEAVES");
        ALIASES.put("DARK_OAK_LEAVES", "LEAVES_2");
        ALIASES.put("OAK_LOG", "LOG");
        ALIASES.put("SPRUCE_LOG", "LOG");
        ALIASES.put("BIRCH_LOG", "LOG");
        ALIASES.put("JUNGLE_LOG", "LOG");
        ALIASES.put("DARK_OAK_LOG", "LOG_2");
        ALIASES.put("OAK_PLANKS", "WOOD");
        ALIASES.put("SPRUCE_PLANKS", "WOOD");
        ALIASES.put("BIRCH_PLANKS", "WOOD");
        ALIASES.put("JUNGLE_PLANKS", "WOOD");
        ALIASES.put("DARK_OAK_PLANKS", "WOOD");
        ALIASES.put("OAK_SAPLING", "SAPLING");
        ALIASES.put("SPRUCE_SAPLING", "SAPLING");
        ALIASES.put("BIRCH_SAPLING", "SAPLING");
        ALIASES.put("JUNGLE_SAPLING", "SAPLING");
        ALIASES.put("DARK_OAK_SAPLING", "SAPLING");
        ALIASES.put("OAK_WOOD", "LOG");
        ALIASES.put("SPRUCE_WOOD", "LOG");
        ALIASES.put("BIRCH_WOOD", "LOG");
        ALIASES.put("JUNGLE_WOOD", "LOG");
        ALIASES.put("DARK_OAK_WOOD", "LOG_2");
        ALIASES.put("OAK_SLAB", "WOOD_STEP");
        ALIASES.put("SPRUCE_SLAB", "WOOD_STEP");
        ALIASES.put("BIRCH_SLAB", "WOOD_STEP");
        ALIASES.put("JUNGLE_SLAB", "WOOD_STEP");
        ALIASES.put("DARK_OAK_SLAB", "WOOD_STEP");
        ALIASES.put("OAK_STAIRS", "WOOD_STAIRS");
        ALIASES.put("SPRUCE_STAIRS", "SPRUCE_WOOD_STAIRS");
        ALIASES.put("BIRCH_STAIRS", "BIRCH_WOOD_STAIRS");
        ALIASES.put("JUNGLE_STAIRS", "JUNGLE_WOOD_STAIRS");
        ALIASES.put("DARK_OAK_STAIRS", "DARK_OAK_STAIRS");
        ALIASES.put("OAK_FENCE", "FENCE");
        ALIASES.put("OAK_FENCE_GATE", "FENCE_GATE");
        ALIASES.put("OAK_BUTTON", "WOOD_BUTTON");
        ALIASES.put("ACACIA_BUTTON", "WOOD_BUTTON");
        ALIASES.put("BIRCH_BUTTON", "WOOD_BUTTON");
        ALIASES.put("DARK_OAK_BUTTON", "WOOD_BUTTON");
        ALIASES.put("JUNGLE_BUTTON", "WOOD_BUTTON");
        ALIASES.put("SPRUCE_BUTTON", "WOOD_BUTTON");
        ALIASES.put("OAK_DOOR", "WOODEN_DOOR");
        ALIASES.put("OAK_PRESSURE_PLATE", "WOOD_PLATE");
        ALIASES.put("ACACIA_PRESSURE_PLATE", "WOOD_PLATE");
        ALIASES.put("BIRCH_PRESSURE_PLATE", "WOOD_PLATE");
        ALIASES.put("DARK_OAK_PRESSURE_PLATE", "WOOD_PLATE");
        ALIASES.put("JUNGLE_PRESSURE_PLATE", "WOOD_PLATE");
        ALIASES.put("SPRUCE_PRESSURE_PLATE", "WOOD_PLATE");
        ALIASES.put("OAK_TRAPDOOR", "TRAP_DOOR");
        ALIASES.put("ACACIA_TRAPDOOR", "TRAP_DOOR");
        ALIASES.put("BIRCH_TRAPDOOR", "TRAP_DOOR");
        ALIASES.put("DARK_OAK_TRAPDOOR", "TRAP_DOOR");
        ALIASES.put("JUNGLE_TRAPDOOR", "TRAP_DOOR");
        ALIASES.put("SPRUCE_TRAPDOOR", "TRAP_DOOR");
        ALIASES.put("OAK_SIGN", "SIGN");
        ALIASES.put("OAK_BOAT", "BOAT");
        ALIASES.put("ACACIA_BOAT", "BOAT_ACACIA");
        ALIASES.put("BIRCH_BOAT", "BOAT_BIRCH");
        ALIASES.put("DARK_OAK_BOAT", "BOAT_DARK_OAK");
        ALIASES.put("JUNGLE_BOAT", "BOAT_JUNGLE");
        ALIASES.put("SPRUCE_BOAT", "BOAT_SPRUCE");

        // 石头类
        ALIASES.put("STONE_SLAB", "STEP");
        ALIASES.put("SMOOTH_STONE_SLAB", "STEP");
        ALIASES.put("COBBLESTONE_SLAB", "STEP");
        ALIASES.put("BRICK_SLAB", "STEP");
        ALIASES.put("SANDSTONE_SLAB", "STEP");
        ALIASES.put("NETHER_BRICK_SLAB", "STEP");
        ALIASES.put("QUARTZ_SLAB", "STEP");
        ALIASES.put("PURPUR_SLAB", "STEP");
        ALIASES.put("PRISMARINE_SLAB", "STEP");
        ALIASES.put("DARK_PRISMARINE_SLAB", "STEP");
        ALIASES.put("RED_SANDSTONE_SLAB", "STEP");
        ALIASES.put("SMOOTH_RED_SANDSTONE", "RED_SANDSTONE");
        ALIASES.put("CUT_RED_SANDSTONE", "RED_SANDSTONE");
        ALIASES.put("CHISELED_RED_SANDSTONE", "RED_SANDSTONE");
        ALIASES.put("CUT_SANDSTONE", "SANDSTONE");
        ALIASES.put("CHISELED_SANDSTONE", "SANDSTONE");
        ALIASES.put("SMOOTH_SANDSTONE", "SANDSTONE");
        ALIASES.put("CHISELED_QUARTZ_BLOCK", "QUARTZ_BLOCK");
        ALIASES.put("STONE_BRICKS", "SMOOTH_BRICK");
        ALIASES.put("CRACKED_STONE_BRICKS", "SMOOTH_BRICK");
        ALIASES.put("MOSSY_STONE_BRICKS", "SMOOTH_BRICK");
        ALIASES.put("CHISELED_STONE_BRICKS", "SMOOTH_BRICK");
        ALIASES.put("GRASS_BLOCK", "GRASS");
        ALIASES.put("ANDESITE", "STONE");
        ALIASES.put("DIORITE", "STONE");
        ALIASES.put("GRANITE", "STONE");
        ALIASES.put("POLISHED_ANDESITE", "STONE");
        ALIASES.put("POLISHED_DIORITE", "STONE");
        ALIASES.put("POLISHED_GRANITE", "STONE");
        ALIASES.put("CARVED_PUMPKIN", "PUMPKIN");
        ALIASES.put("CHIPPED_ANVIL", "ANVIL");
        ALIASES.put("DAMAGED_ANVIL", "ANVIL");
        ALIASES.put("DARK_PRISMARINE", "PRISMARINE");
        ALIASES.put("TERRACOTTA", "HARD_CLAY");
        ALIASES.put("BRICKS", "BRICK");
        ALIASES.put("NETHER_BRICKS", "NETHER_BRICK");
        ALIASES.put("FARMLAND", "SOIL");
        ALIASES.put("COARSE_DIRT", "DIRT");
        ALIASES.put("PODZOL", "DIRT");
        ALIASES.put("MYCELIUM", "MYCEL");
        ALIASES.put("LILY_PAD", "WATER_LILY");
        ALIASES.put("COBWEB", "WEB");
        ALIASES.put("MELON", "MELON_BLOCK");
        ALIASES.put("MELON_SLICE", "MELON");
        ALIASES.put("CAVE_AIR", "AIR");
        ALIASES.put("VOID_AIR", "AIR");
        ALIASES.put("BLUE_ICE", "PACKED_ICE");

        // 染色
        ALIASES.put("WHITE_CARPET", "CARPET");
        ALIASES.put("WHITE_WOOL", "WOOL");
        ALIASES.put("WHITE_STAINED_GLASS", "STAINED_GLASS");
        ALIASES.put("WHITE_STAINED_GLASS_PANE", "STAINED_GLASS_PANE");
        ALIASES.put("WHITE_TERRACOTTA", "STAINED_CLAY");
        ALIASES.put("WHITE_BANNER", "BANNER");
        ALIASES.put("WHITE_WALL_BANNER", "BANNER");

        // 花与植物
        ALIASES.put("POPPY", "RED_ROSE");
        ALIASES.put("DANDELION", "YELLOW_FLOWER");
        ALIASES.put("SUNFLOWER", "DOUBLE_PLANT");
        ALIASES.put("LILAC", "DOUBLE_PLANT");
        ALIASES.put("ROSE_BUSH", "DOUBLE_PLANT");
        ALIASES.put("PEONY", "DOUBLE_PLANT");
        ALIASES.put("TALL_GRASS", "LONG_GRASS");
        ALIASES.put("FERN", "LONG_GRASS");
        ALIASES.put("AZURE_BLUET", "RED_ROSE");
        ALIASES.put("BLUE_ORCHID", "RED_ROSE");
        ALIASES.put("OXEYE_DAISY", "RED_ROSE");
        ALIASES.put("ORANGE_TULIP", "RED_ROSE");
        ALIASES.put("PINK_TULIP", "RED_ROSE");
        ALIASES.put("RED_TULIP", "RED_ROSE");
        ALIASES.put("WHITE_TULIP", "RED_ROSE");

        // 杂项改名
        ALIASES.put("CRAFTING_TABLE", "WORKBENCH");
        ALIASES.put("ENDER_EYE", "EYE_OF_ENDER");
        ALIASES.put("EXPERIENCE_BOTTLE", "EXP_BOTTLE");
        ALIASES.put("GLASS_PANE", "THIN_GLASS");
        ALIASES.put("IRON_BARS", "IRON_FENCE");
        ALIASES.put("GLISTERING_MELON_SLICE", "SPECKLED_MELON");
        ALIASES.put("INK_SAC", "INK_SACK");
        ALIASES.put("PUFFERFISH", "RAW_FISH");
        ALIASES.put("COD", "RAW_FISH");
        ALIASES.put("SALMON", "RAW_FISH");
        ALIASES.put("TROPICAL_FISH", "RAW_FISH");
        ALIASES.put("COOKED_COD", "COOKED_FISH");
        ALIASES.put("COOKED_SALMON", "COOKED_FISH");
        ALIASES.put("REPEATER", "DIODE");
        ALIASES.put("COMPARATOR", "REDSTONE_COMPARATOR");
        ALIASES.put("REDSTONE_TORCH", "REDSTONE_TORCH_ON");
        ALIASES.put("HEAVY_WEIGHTED_PRESSURE_PLATE", "GOLD_PLATE");
        ALIASES.put("LIGHT_WEIGHTED_PRESSURE_PLATE", "IRON_PLATE");
        ALIASES.put("CHEST_MINECART", "STORAGE_MINECART");
        ALIASES.put("FURNACE_MINECART", "POWERED_MINECART");
        ALIASES.put("TNT_MINECART", "EXPLOSIVE_MINECART");
        ALIASES.put("CRAFT_MINECART", "MINECART");
        ALIASES.put("COMMAND_BLOCK_MINECART", "COMMAND_MINECART");
        ALIASES.put("BONE_MEAL", "INK_SACK");
        ALIASES.put("COCOA_BEANS", "INK_SACK");
        ALIASES.put("LAPIS_LAZULI", "INK_SACK");
        ALIASES.put("CACTUS_GREEN", "INK_SACK");
        ALIASES.put("DANDELION_YELLOW", "INK_SACK");
        ALIASES.put("ROSE_RED", "INK_SACK");
        ALIASES.put("WHEAT_SEEDS", "SEEDS");
        ALIASES.put("GUNPOWDER", "SULPHUR");
        ALIASES.put("NETHER_WART", "NETHER_STALK");
        ALIASES.put("FIREWORK_ROCKET", "FIREWORK");
        ALIASES.put("FIREWORK_STAR", "FIREWORK_CHARGE");
        ALIASES.put("CHARCOAL", "COAL");
        ALIASES.put("BAT_SPAWN_EGG", "MONSTER_EGG");
        ALIASES.put("BLAZE_SPAWN_EGG", "MONSTER_EGG");
        ALIASES.put("CAVE_SPIDER_SPAWN_EGG", "MONSTER_EGG");
        ALIASES.put("CHICKEN_SPAWN_EGG", "MONSTER_EGG");
        ALIASES.put("COW_SPAWN_EGG", "MONSTER_EGG");
        ALIASES.put("CREEPER_SPAWN_EGG", "MONSTER_EGG");
        ALIASES.put("BUBBLE_COLUMN", "WATER");
        ALIASES.put("CONDUIT", "SEA_LANTERN");
        ALIASES.put("BRAIN_CORAL", "CORAL");
        ALIASES.put("BRAIN_CORAL_BLOCK", "CORAL_BLOCK");
        ALIASES.put("BRAIN_CORAL_FAN", "CORAL_FAN");
        ALIASES.put("BUBBLE_CORAL", "CORAL");
        ALIASES.put("BUBBLE_CORAL_BLOCK", "CORAL_BLOCK");
        ALIASES.put("BUBBLE_CORAL_FAN", "CORAL_FAN");
        ALIASES.put("ATTACHED_MELON_STEM", "MELON_STEM");
        ALIASES.put("ATTACHED_PUMPKIN_STEM", "PUMPKIN_STEM");
        ALIASES.put("CHAIN_COMMAND_BLOCK", "COMMAND_CHAIN");
        ALIASES.put("REPEATING_COMMAND_BLOCK", "COMMAND_REPEATING");

        ALIASES.put("MUSIC_DISC_11", "RECORD_11");
        ALIASES.put("MUSIC_DISC_13", "RECORD_13");
        ALIASES.put("MUSIC_DISC_BLOCKS", "RECORD_BLOCKS");
        ALIASES.put("MUSIC_DISC_CAT", "RECORD_CAT");
        ALIASES.put("MUSIC_DISC_CHIRP", "RECORD_CHIRP");
        ALIASES.put("MUSIC_DISC_FAR", "RECORD_FAR");
        ALIASES.put("MUSIC_DISC_MALL", "RECORD_MALL");
        ALIASES.put("MUSIC_DISC_MELLOHI", "RECORD_MELLOHI");
        ALIASES.put("MUSIC_DISC_STAL", "RECORD_STAL");
        ALIASES.put("MUSIC_DISC_STRAD", "RECORD_STRAD");
        ALIASES.put("MUSIC_DISC_WAIT", "RECORD_WAIT");
        ALIASES.put("MUSIC_DISC_WARD", "RECORD_WARD");
        ALIASES.put("MUSIC_DISC_5", "RECORD_11");
        ALIASES.put("MUSIC_DISC_PIGSTEP", "RECORD_CAT");
    }

    /** 1.13 的 16 色。 */
    private static final List<String> COLORS = Arrays.asList(
            "WHITE", "ORANGE", "MAGENTA", "LIGHT_BLUE", "YELLOW", "LIME", "PINK", "GRAY",
            "LIGHT_GRAY", "CYAN", "PURPLE", "BLUE", "BROWN", "GREEN", "RED", "BLACK");

    @Override
    public void onEnable() {
        Class<?> materialClass;
        try {
            // depend: [CMILib] 保证这个类此时可见，而且拿到的是 CMILib 自己的那一份。
            materialClass = Class.forName(CMILIB_MATERIAL);
        } catch (Throwable t) {
            getLogger().severe("找不到 " + CMILIB_MATERIAL + "，本插件不会起作用。");
            getLogger().severe("原因：" + t);
            return;
        }

        int before = countResolved(materialClass);

        Map<String, String> userAliases = loadUserAliases();
        if (!userAliases.isEmpty()) {
            getLogger().info("从 aliases.yml 读取到 " + userAliases.size() + " 条额外映射");
        }

        int patched = patchLegacyNames(materialClass, userAliases);
        int afterPatch = countResolved(materialClass);

        // 关键一步：重跑 CMILib 自己的索引构建。
        // 不跑这一步，byName 里依然没有那些常量，getItem("POPPY") 照样返回 null。
        boolean reloaded = reloadItemManager();

        int afterReload = countResolved(materialClass);
        clearHeadCache();

        getLogger().info("材质解析：" + before + " → 补 legacyName 后 " + afterPatch
                + " → 重建索引后 " + afterReload + "（共 " + totalConstants(materialClass) + " 个常量）");
        if (patched > 0) {
            getLogger().info("已为 " + patched + " 个常量写入 1.12.2 别名");
        }
        if (!reloaded) {
            getLogger().warning("重建 CMILib 索引失败 —— 材质虽然解析出来了，"
                    + "但 CMILib 的按名查找表可能仍是旧的。");
        }

        // 剩下解析不出来的绝大多数是 1.12.2 之后才加入的材质（蜡烛/铜/Sculk 等），
        // 它们在本版本世界里根本不会出现，属于正常。所以只报个数，明细写文件。
        List<String> unresolved = listUnresolved(materialClass);
        if (!unresolved.isEmpty()) {
            java.io.File dump = new java.io.File(getDataFolder(), "unresolved.txt");
            writeLines(dump, unresolved);
            getLogger().info("另有 " + unresolved.size() + " 个常量在本版本无对应材质"
                    + "（多为 1.13+ 新增内容，属正常）。完整清单：" + dump.getPath());
        }
    }

    /**
     * 给解析不出材质的常量写入「恰好一个」1.12.2 材质名到 {@code legacyName}。
     *
     * 一个而不是多个，是因为 {@code updateMaterial()} 里那段循环要求列表里
     * <b>所有</b>名字都等于同一个材质名才能命中 —— 给它一个元素，条件恒真。
     */
    private int patchLegacyNames(Class<?> materialClass, Map<String, String> userAliases) {
        Field legacyField;
        Field matField;
        Method legacyNamesMethod;
        try {
            legacyField = materialClass.getDeclaredField("legacyName");
            legacyField.setAccessible(true);
            matField = materialClass.getDeclaredField("mat");
            matField.setAccessible(true);
        } catch (Throwable t) {
            getLogger().severe("拿不到 CMIMaterial 的字段（CMILib 版本变了？）：" + t);
            return 0;
        }
        try {
            legacyNamesMethod = materialClass.getMethod("getLegacyNames");
        } catch (Throwable t) {
            legacyNamesMethod = null;
        }

        Object[] constants = materialClass.getEnumConstants();
        if (constants == null) {
            return 0;
        }

        int patched = 0;
        for (Object constant : constants) {
            String name = ((Enum<?>) constant).name();

            try {
                if (matField.get(constant) != null) {
                    continue;
                }
            } catch (Throwable t) {
                continue;
            }

            List<String> existing = Collections.emptyList();
            if (legacyNamesMethod != null) {
                try {
                    Object raw = legacyNamesMethod.invoke(constant);
                    if (raw instanceof List) {
                        existing = (List<String>) raw;
                    }
                } catch (Throwable ignored) {
                    // 拿不到就当没有
                }
            }

            Material resolved = resolve(name, existing, userAliases);
            if (resolved == null) {
                continue;
            }

            try {
                // 单元素列表 → updateMaterial() 里那段 buggy 循环就能命中
                legacyField.set(constant, new ArrayList<String>(
                        Collections.singletonList(resolved.name())));
                patched++;
            } catch (Throwable t) {
                getLogger().fine("写 legacyName 失败（" + name + "）：" + t);
            }
        }
        return patched;
    }

    /**
     * 重跑 CMILib 的 {@code ItemManager.load()}，让 {@code byName} 把这些常量收进去。
     *
     * 这是整个修复的收尾：{@code load()} 内部会对每个常量重新调
     * {@code updateMaterial()}，而我们已经把 {@code legacyName} 改成能命中的值，
     * 所以这一次它算得出正确的 {@code mat}，进而把常量放进查找表。
     */
    private boolean reloadItemManager() {
        try {
            Class<?> cmilib = Class.forName(CMILIB_MAIN);
            Object instance = cmilib.getMethod("getInstance").invoke(null);
            Object itemManager = cmilib.getMethod("getItemManager").invoke(instance);
            Class<?> itemManagerClass = Class.forName(CMILIB_ITEM_MANAGER);
            itemManagerClass.getMethod("load").invoke(itemManager);
            return true;
        } catch (Throwable t) {
            getLogger().warning("调用 ItemManager.load() 失败：" + t);
            return false;
        }
    }

    /**
     * 清掉头颅的静态缓存。
     *
     * {@code CMIItemStack.getHead()} 会把生成好的 ItemStack 按纹理字符串缓存。
     * CMILib 启动时 {@code PLAYER_HEAD} 还解析不出来，那批缓存里存的是「石头」，
     * 只修材质不清缓存，它们永远不会重建。
     */
    private void clearHeadCache() {
        try {
            Class<?> type = Class.forName(CMILIB_ENTITY_TYPE);
            for (Field f : type.getDeclaredFields()) {
                if (!"cache".equals(f.getName()) || !Map.class.isAssignableFrom(f.getType())) {
                    continue;
                }
                f.setAccessible(true);
                Object value = f.get(null);
                if (value instanceof Map) {
                    int size = ((Map<?, ?>) value).size();
                    ((Map<?, ?>) value).clear();
                    if (size > 0) {
                        getLogger().info("已清空头颅缓存（" + size + " 条），它们会用修正后的材质重建");
                    }
                }
                return;
            }
        } catch (Throwable t) {
            getLogger().warning("清头颅缓存失败（不影响材质修复，只是已缓存的头颅可能仍是坏的）：" + t);
        }
    }

    private int countResolved(Class<?> materialClass) {
        int n = 0;
        try {
            Field matField = materialClass.getDeclaredField("mat");
            matField.setAccessible(true);
            for (Object constant : materialClass.getEnumConstants()) {
                if (matField.get(constant) != null) {
                    n++;
                }
            }
        } catch (Throwable ignored) {
            // 返回已统计到的数量
        }
        return n;
    }

    private int totalConstants(Class<?> materialClass) {
        Object[] constants = materialClass.getEnumConstants();
        return constants == null ? 0 : constants.length;
    }

    private List<String> listUnresolved(Class<?> materialClass) {
        List<String> out = new ArrayList<String>();
        try {
            Field matField = materialClass.getDeclaredField("mat");
            matField.setAccessible(true);
            for (Object constant : materialClass.getEnumConstants()) {
                if (matField.get(constant) == null) {
                    out.add(((Enum<?>) constant).name());
                }
            }
        } catch (Throwable ignored) {
            // 返回已收集到的
        }
        return out;
    }

    /**
     * 逐级回退找出 1.12.2 上的对应材质。
     *
     * 从「最可信」到「最像猜」：常量名本身 → CMILib 自带别名 → 用户 aliases.yml
     * → 内置别名表 → 规则推断。
     */
    private Material resolve(String name, List<String> legacyNames, Map<String, String> userAliases) {
        Material m = valueOfOrNull(name);
        if (m != null) {
            return m;
        }

        for (String legacy : legacyNames) {
            m = valueOfOrNull(sanitize(legacy));
            if (m != null) {
                return m;
            }
        }

        String user = userAliases.get(name);
        if (user != null) {
            m = valueOfOrNull(sanitize(user));
            if (m != null) {
                return m;
            }
        }

        String alias = ALIASES.get(name);
        if (alias != null) {
            m = valueOfOrNull(alias);
            if (m != null) {
                return m;
            }
        }

        return byRule(name);
    }

    /**
     * 规则推断。
     *
     * 只处理有确定答案的情况；拿不准就返回 null 让它进 unresolved ——
     * 猜错会把物品变成另一种东西，比缺一条价值更糟。
     */
    private Material byRule(String name) {
        // 16 色前缀：1.13 把染色方块拆成 WHITE_WOOL 这类独立材质，
        // 1.12.2 是「同一材质 + 数据值」。CMILib 在本版本拿不到数据值
        // （getLegacyData() 恒 -1），所以只能映射到基础材质名。
        // 对价值表够用（按材质计价），但颜色都会是「第一个色」。
        for (String color : COLORS) {
            if (!name.startsWith(color + "_")) {
                continue;
            }
            String tail = name.substring(color.length() + 1);
            String target = null;

            if ("WOOL".equals(tail)) {
                target = "WOOL";
            } else if ("CARPET".equals(tail)) {
                target = "CARPET";
            } else if ("STAINED_GLASS".equals(tail)) {
                target = "STAINED_GLASS";
            } else if ("STAINED_GLASS_PANE".equals(tail)) {
                target = "STAINED_GLASS_PANE";
            } else if ("TERRACOTTA".equals(tail)) {
                target = "STAINED_CLAY";
            } else if ("BANNER".equals(tail) || "WALL_BANNER".equals(tail)) {
                target = "BANNER";
            } else if ("SHULKER_BOX".equals(tail)) {
                target = "SHULKER_BOX";
            } else if ("BED".equals(tail)) {
                target = "BED";
            }

            if (target != null) {
                Material m = valueOfOrNull(target);
                if (m != null) {
                    return m;
                }
            }
        }

        return null;
    }

    private static Material valueOfOrNull(String name) {
        if (name == null || name.isEmpty()) {
            return null;
        }
        try {
            return Material.valueOf(name);
        } catch (Throwable notFound) {
            return null;
        }
    }

    /** "Crafting Table" → "CRAFTING_TABLE"；"Workbench" → "WORKBENCH"。 */
    private static String sanitize(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.trim().toUpperCase(Locale.ENGLISH);
        s = s.replaceAll("[^A-Z0-9]+", "_");
        s = s.replaceAll("^_+|_+$", "");
        return s.replaceAll("_+", "_");
    }

    private void writeLines(java.io.File file, List<String> lines) {
        try {
            if (!getDataFolder().isDirectory() && !getDataFolder().mkdirs()) {
                return;
            }
            java.nio.file.Files.write(file.toPath(), lines,
                    java.nio.charset.Charset.forName("UTF-8"));
        } catch (Throwable t) {
            getLogger().warning("写 " + file.getName() + " 失败：" + t);
        }
    }

    /** 读取可选的 aliases.yml，让用户不用重新编译就能补映射。 */
    @SuppressWarnings("unchecked")
    private Map<String, String> loadUserAliases() {
        Map<String, String> out = new HashMap<String, String>();
        try {
            java.io.File file = new java.io.File(getDataFolder(), "aliases.yml");
            if (!file.isFile()) {
                writeDefaultAliases(file);
                return out;
            }
            org.bukkit.configuration.file.YamlConfiguration yml =
                    org.bukkit.configuration.file.YamlConfiguration.loadConfiguration(file);
            for (String key : yml.getKeys(false)) {
                String value = yml.getString(key);
                if (key != null && value != null) {
                    out.put(key.trim().toUpperCase(Locale.ENGLISH), sanitize(value));
                }
            }
        } catch (Throwable t) {
            getLogger().warning("读取 aliases.yml 失败：" + t);
        }
        return out;
    }

    private void writeDefaultAliases(java.io.File file) {
        List<String> lines = new ArrayList<String>();
        lines.add("# KokuuLegacyFix —— 补充材质映射（CMILib 常量名: 1.12.2 材质名）");
        lines.add("#");
        lines.add("# 插件启动时会在控制台报「无对应材质」的个数，完整清单写在 unresolved.txt。");
        lines.add("# 如果里面有你想修好的，把对应关系加到下面（一行一条），重启服务端即可，无需重新编译。");
        lines.add("# 注意：unresolved.txt 里绝大多数是 1.13+ 才加入的材质（蜡烛/铜/Sculk 等），");
        lines.add("#       它们在 1.12.2 世界里不会出现，不用管。");
        lines.add("#");
        lines.add("# 例：");
        lines.add("#   OAK_LEAVES: LEAVES");
        lines.add("#   POPPY: RED_ROSE");
        lines.add("#");
        lines.add("# 右边必须是 1.12.2 的 Material 枚举名。查法：");
        lines.add("#   javap -classpath CatServer-1.12.2-build31.jar org.bukkit.Material");
        lines.add("");
        writeLines(file, lines);
    }
}
