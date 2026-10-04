package com.kokuustudio.kokuupanel.agent.rpc;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.kokuustudio.kokuupanel.agent.protocol.AgentException;
import com.kokuustudio.kokuupanel.agent.protocol.ErrorCode;
import com.kokuustudio.kokuupanel.agent.protocol.Protocol;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * 方法名 → 处理器的注册表与分发。
 *
 * <p>核心规则（协议 §8）：**未知方法必须回 {@code UNSUPPORTED}**，不能静默忽略。
 * 静默忽略会让平台侧等满超时才失败，运维排查时看到的只有「卡住」。
 *
 * <p>另外两类「不能做」在这里也一并拦掉：
 * <ul>
 *   <li>节点没声明该 capability（如没装 LuckPerms）—— 协议 §5.5/§5.6 要求
 *       回 {@code NO_LUCKPERMS} / {@code NO_ECONOMY}，其余的才回 {@code UNSUPPORTED}。</li>
 *   <li>只读模式下的写方法 —— 回 {@code READ_ONLY}。</li>
 * </ul>
 *
 * <p>所有处理器都在主线程执行（{@link MainThreadExecutor}），带超时。
 */
public final class RpcDispatcher {

    /** 处理器只负责「读参数 + 干活」，返回的 Object 会被 Gson 序列化成 result。 */
    public interface Handler {
        Object handle(Params params) throws Exception;
    }

    private static final class Definition {
        final String method;
        final String capability;
        final boolean write;
        final Handler handler;

        Definition(String method, String capability, boolean write, Handler handler) {
            this.method = method;
            this.capability = capability;
            this.write = write;
            this.handler = handler;
        }
    }

    private final Logger logger;
    private final MainThreadExecutor mainThread;
    private final Map<String, Definition> definitions = new LinkedHashMap<String, Definition>();

    private volatile Set<String> capabilities = Collections.emptySet();
    private volatile boolean readOnly;

    public RpcDispatcher(Logger logger, MainThreadExecutor mainThread) {
        this.logger = logger;
        this.mainThread = mainThread;
    }

    /**
     * @param capability 需要的能力；null 表示基础能力（console/players/punish/whitelist 恒有）
     * @param write      true 表示这是写操作，只读模式下会被拒
     */
    public void register(String method, String capability, boolean write, Handler handler) {
        definitions.put(method, new Definition(method, capability, write, handler));
    }

    public void setCapabilities(Collection<String> declared) {
        this.capabilities = Collections.unmodifiableSet(new LinkedHashSet<String>(declared));
    }

    public Set<String> getCapabilities() {
        return capabilities;
    }

    public void setReadOnly(boolean readOnly) {
        this.readOnly = readOnly;
    }

    public boolean isReadOnly() {
        return readOnly;
    }

    public Set<String> registeredMethods() {
        return Collections.unmodifiableSet(definitions.keySet());
    }

    /**
     * 分发一个入站请求，返回可以直接发出去的响应帧。
     *
     * <p>这个方法**不抛异常** —— 任何失败都要变成 {@code ok:false} 的响应，
     * 因为「指挥台吞掉错误当成功」和「静默超时」都是不能接受的。
     */
    public JsonObject dispatch(final String id, String method, JsonElement rawParams) {
        Definition definition = definitions.get(method);
        if (definition == null) {
            // 协议 §8：不认识的返回 UNSUPPORTED，不要静默忽略。
            logger.warning("收到未知方法 " + method + "（id=" + id + "），回 UNSUPPORTED");
            return Protocol.responseError(id, ErrorCode.UNSUPPORTED, "本插件不支持方法 " + method, null);
        }

        if (definition.capability != null && !capabilities.contains(definition.capability)) {
            return Protocol.responseError(id, missingCapabilityCode(definition.capability),
                    "节点未声明能力 " + definition.capability, null);
        }

        if (readOnly && definition.write) {
            return Protocol.responseError(id, ErrorCode.READ_ONLY,
                    "节点处于只读模式（config.yml 的 readOnly），写操作已被拒绝", null);
        }

        final Params params;
        try {
            params = Params.of(rawParams);
        } catch (RuntimeException e) {
            return Protocol.responseError(id, ErrorCode.INVALID_PARAMS, e.getMessage(), null);
        }

        try {
            Object result = mainThread.call(new java.util.concurrent.Callable<Object>() {
                @Override
                public Object call() throws Exception {
                    return definition.handler.handle(params);
                }
            });
            if (!params.wasChecked()) {
                // 处理器忘了 done() —— 参数校验就漏了。这是实现 bug，记下来别静默。
                logger.warning("方法 " + definition.method + " 的处理器没有调用 params.done()，"
                        + "本次跳过未知字段检查");
            }
            return Protocol.responseOk(id, result);
        } catch (AgentException e) {
            if (e.getCode() == ErrorCode.INVALID_PARAMS) {
                // 参数问题不算异常，用 FINE 免得刷日志。
                logger.fine("方法 " + definition.method + " 参数校验失败: " + e.getMessage());
            } else {
                logger.log(Level.WARNING, "方法 " + definition.method + " 失败: "
                        + e.getCode() + " " + e.getMessage());
            }
            return Protocol.responseError(id, e.getCode(), e.getMessage(), e.getData());
        } catch (Throwable t) {
            // 协议 §4：INTERNAL 的 message 要带堆栈摘要；完整堆栈进服务端日志。
            logger.log(Level.SEVERE, "方法 " + definition.method + " 内部异常", t);
            return Protocol.responseError(id, ErrorCode.INTERNAL,
                    MainThreadExecutor.describe(t), null);
        }
    }

    /**
     * 能力缺失时的错误码。
     *
     * <p>协议 §5.5 / §5.6 明确要求 luckperms / economy 各自回专用码，
     * 这样平台前端能区分「这个节点没装 LuckPerms」和「这个节点不认识这个方法」。
     */
    private static ErrorCode missingCapabilityCode(String capability) {
        if ("luckperms".equals(capability)) {
            return ErrorCode.NO_LUCKPERMS;
        }
        if ("economy".equals(capability)) {
            return ErrorCode.NO_ECONOMY;
        }
        return ErrorCode.UNSUPPORTED;
    }
}
