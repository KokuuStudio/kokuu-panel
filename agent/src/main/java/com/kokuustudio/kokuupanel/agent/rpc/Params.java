package com.kokuustudio.kokuupanel.agent.rpc;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.kokuustudio.kokuupanel.agent.protocol.AgentException;
import com.kokuustudio.kokuupanel.agent.protocol.ErrorCode;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 入站参数校验。对应 packages/protocol/src/schemas.ts 的 zod schema。
 *
 * <p>设计要点：
 * <ul>
 *   <li><b>收集而不是首抛</b>：一次请求里所有字段的问题都收集起来，
 *       最后 {@code done()} 统一抛 —— 只说「参数错误」的接口在排查时等于没说。</li>
 *   <li><b>严格</b>：没被读过的字段算未知字段。和 zod 的 {@code .strict()} 一致。</li>
 *   <li>失败一律 {@code INVALID_PARAMS}，{@code data.issues} =
 *       {@code [{"path":"uuid","message":"UUID 格式不正确"}]}。</li>
 * </ul>
 *
 * <p><b>调用约定</b>：处理器必须在**产生任何副作用之前**调用 {@code done()}。
 * 否则会出现「命令已经执行了，却回了 INVALID_PARAMS」这种自相矛盾的结果。
 */
public final class Params {

    /** 严格 UUID（带横线）。与 packages/protocol 的 UUID_RE 一致。 */
    private static final Pattern UUID_RE = Pattern.compile(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    /** 全 0 UUID：Bukkit 对「从未上线过的名字」返回它，当成真实身份会把不同玩家合并。 */
    private static final String NIL_UUID = "00000000-0000-0000-0000-000000000000";

    /** 玩家名：MC 只允许 1–16 位字母数字下划线。 */
    private static final Pattern PLAYER_NAME_RE = Pattern.compile("^[A-Za-z0-9_]{1,16}$");

    /** 权限节点：允许 * 通配。 */
    private static final Pattern PERMISSION_RE = Pattern.compile("^[A-Za-z0-9_.*\\-]+$");

    /** LuckPerms 组名：小写字母数字下划线连字符，与 LP 自身约束一致。 */
    private static final Pattern GROUP_RE = Pattern.compile("^[a-z0-9_\\-]+$");

    private final JsonObject object;
    /** 本层字段名的限定前缀（嵌套时为 "punishment."）。 */
    private final String levelPrefix;
    /** 整棵树共享的问题列表。 */
    private final List<JsonObject> issues;
    /** 整棵树共享的「已读字段」集合，用于严格模式下发现未知字段。 */
    private final Set<String> consumed;
    /** 树里所有层的 Params；根 done() 会把每一层都检查一遍。 */
    private final List<Params> all;
    /** true 表示本层已经没有可信数据（父字段缺失/类型错），后续读取静默返回默认值。 */
    private final boolean poisoned;

    private boolean checked;

    private Params(JsonObject object, String levelPrefix, List<JsonObject> issues,
                   Set<String> consumed, List<Params> all, boolean poisoned) {
        this.object = object;
        this.levelPrefix = levelPrefix;
        this.issues = issues;
        this.consumed = consumed;
        this.all = all;
        this.poisoned = poisoned;
    }

    public static Params of(JsonElement raw) {
        List<JsonObject> issues = new ArrayList<JsonObject>();
        List<Params> all = new ArrayList<Params>();
        Set<String> consumed = new LinkedHashSet<String>();
        if (raw == null || raw.isJsonNull()) {
            Params params = new Params(new JsonObject(), "", issues, consumed, all, false);
            all.add(params);
            return params;
        }
        if (!raw.isJsonObject()) {
            issues.add(issue("", "params 必须是 JSON 对象"));
            Params params = new Params(new JsonObject(), "", issues, consumed, all, true);
            all.add(params);
            return params;
        }
        Params params = new Params(raw.getAsJsonObject(), "", issues, consumed, all, false);
        all.add(params);
        return params;
    }

    public JsonObject raw() {
        return object;
    }

    // ── 读取 ──────────────────────────────────────────────────────────────

    private JsonElement take(String key) {
        consumed.add(levelPrefix + key);
        if (poisoned) {
            return null;
        }
        JsonElement element = object.get(key);
        if (element == null || element.isJsonNull()) {
            return null;
        }
        return element;
    }

    private void fail(String path, String message) {
        if (poisoned && !path.isEmpty()) {
            return;
        }
        issues.add(issue(path, message));
    }

    private boolean absent(String key, boolean required) {
        if (required) {
            fail(levelPrefix + key, "必填字段缺失");
            return true;
        }
        return false;
    }

    /** 必填/可选字符串。{@code maxLen} 与 {@code pattern} 可为 null 表示不限制。 */
    public String string(String key, boolean required, Integer maxLen, Pattern pattern, String patternMessage) {
        JsonElement element = take(key);
        if (element == null) {
            absent(key, required);
            return null;
        }
        if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
            fail(levelPrefix + key, "必须是字符串");
            return null;
        }
        String value = element.getAsString();
        if (maxLen != null && value.length() > maxLen) {
            fail(levelPrefix + key, "长度不能超过 " + maxLen);
            return null;
        }
        if (pattern != null && !pattern.matcher(value).matches()) {
            fail(levelPrefix + key, patternMessage == null ? "格式不正确" : patternMessage);
            return null;
        }
        return value;
    }

    /** 可选字符串；缺失或显式 null 都返回 null。 */
    public String optionalString(String key, Integer maxLen) {
        return string(key, false, maxLen, null, null);
    }

    /** 必填：严格 UUID，且不接受全 0。 */
    public String uuid(String key) {
        String value = string(key, true, null, UUID_RE, "UUID 格式不正确");
        if (value != null && NIL_UUID.equalsIgnoreCase(value)) {
            fail(levelPrefix + key, "不接受全 0 UUID");
            return null;
        }
        return value;
    }

    public String playerName(String key, boolean required) {
        return string(key, required, 16, PLAYER_NAME_RE, "玩家名只能是 1–16 位字母、数字或下划线");
    }

    public String permissionNode(String key, boolean required) {
        return string(key, required, 128, PERMISSION_RE, "权限节点含有非法字符");
    }

    public String groupName(String key, boolean required) {
        return string(key, required, 64, GROUP_RE, "组名只能是小写字母、数字、下划线或连字符");
    }

    public Boolean bool(String key, boolean required) {
        JsonElement element = take(key);
        if (element == null) {
            absent(key, required);
            return null;
        }
        if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isBoolean()) {
            fail(levelPrefix + key, "必须是布尔值");
            return null;
        }
        return Boolean.valueOf(element.getAsBoolean());
    }

    public Double number(String key, boolean required) {
        JsonElement element = take(key);
        if (element == null) {
            absent(key, required);
            return null;
        }
        if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isNumber()) {
            fail(levelPrefix + key, "必须是数字");
            return null;
        }
        double value = element.getAsDouble();
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            fail(levelPrefix + key, "必须是有限数字");
            return null;
        }
        return Double.valueOf(value);
    }

    public Long longValue(String key, boolean required) {
        JsonElement element = take(key);
        if (element == null) {
            absent(key, required);
            return null;
        }
        if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isNumber()) {
            fail(levelPrefix + key, "必须是数字");
            return null;
        }
        double asDouble = element.getAsDouble();
        if (Double.isNaN(asDouble) || Double.isInfinite(asDouble)
                || asDouble != Math.floor(asDouble)) {
            fail(levelPrefix + key, "必须是整数");
            return null;
        }
        return Long.valueOf((long) asDouble);
    }

    /** 枚举值：必须精确命中其中之一（大小写敏感，与 zod 的 enum 一致）。 */
    public String enumOf(String key, boolean required, String... allowed) {
        String value = string(key, required, null, null, null);
        if (value == null) {
            return null;
        }
        for (String candidate : allowed) {
            if (candidate.equals(value)) {
                return value;
            }
        }
        fail(levelPrefix + key, "必须是 " + join(allowed, " / ") + " 之一");
        return null;
    }

    /** 嵌套对象。返回的子 Params 与父共享问题列表与已读集合。 */
    public Params nested(String key, boolean required) {
        JsonElement element = take(key);
        if (element == null) {
            absent(key, required);
            Params dead = new Params(new JsonObject(), levelPrefix + key + ".", issues, consumed, all, true);
            all.add(dead);
            return dead;
        }
        if (!element.isJsonObject()) {
            fail(levelPrefix + key, "必须是对象");
            Params dead = new Params(new JsonObject(), levelPrefix + key + ".", issues, consumed, all, true);
            all.add(dead);
            return dead;
        }
        Params child = new Params(element.getAsJsonObject(), levelPrefix + key + ".", issues, consumed, all, false);
        all.add(child);
        return child;
    }

    // ── 收尾 ──────────────────────────────────────────────────────────────

    /**
     * 结束校验：检查每一层有没有未知字段，然后有问题就抛 {@code INVALID_PARAMS}。
     * 只需要在根 Params 上调用一次。
     */
    public void done() {
        checked = true;
        for (Params params : all) {
            params.checkUnknownKeys();
        }
        if (issues.isEmpty()) {
            return;
        }
        JsonObject data = new JsonObject();
        data.add("issues", com.kokuustudio.kokuupanel.agent.protocol.Protocol.gson().toJsonTree(issues));
        throw new AgentException(ErrorCode.INVALID_PARAMS, summarize(), data);
    }

    public boolean wasChecked() {
        return checked;
    }

    private void checkUnknownKeys() {
        if (poisoned) {
            return;
        }
        for (String key : object.keySet()) {
            if (!consumed.contains(levelPrefix + key)) {
                issues.add(issue(levelPrefix + key, "未知字段"));
            }
        }
    }

    private String summarize() {
        StringBuilder builder = new StringBuilder();
        int shown = 0;
        for (JsonObject issue : issues) {
            if (shown >= 3) {
                break;
            }
            if (shown > 0) {
                builder.append('；');
            }
            String path = issue.get("path").getAsString();
            String message = issue.get("message").getAsString();
            if (!path.isEmpty()) {
                builder.append(path).append(": ");
            }
            builder.append(message);
            shown++;
        }
        return builder.length() == 0 ? "参数校验失败" : builder.toString();
    }

    private static JsonObject issue(String path, String message) {
        JsonObject issue = new JsonObject();
        issue.addProperty("path", path);
        issue.addProperty("message", message);
        return issue;
    }

    /**
     * 手工构造一个 {@code INVALID_PARAMS} 异常，data 形状与 {@link #done()} 抛出的完全一致。
     * 用于 zod schema 之外的语义校验（例如「金额不能为 0」）。
     */
    public static AgentException invalid(String path, String message) {
        List<JsonObject> issues = new ArrayList<JsonObject>();
        issues.add(issue(path, message));
        JsonObject data = new JsonObject();
        data.add("issues",
                com.kokuustudio.kokuupanel.agent.protocol.Protocol.gson().toJsonTree(issues));
        return new AgentException(ErrorCode.INVALID_PARAMS,
                path.isEmpty() ? message : path + ": " + message, data);
    }

    private static String join(String[] values, String separator) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < values.length; i++) {
            if (i > 0) {
                builder.append(separator);
            }
            builder.append(values[i]);
        }
        return builder.toString();
    }
}
