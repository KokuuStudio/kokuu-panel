package com.kokuustudio.kokuupanel.agent.protocol;

/**
 * 协议错误码，逐字对应 docs/PROTOCOL.md §4。
 *
 * <p>枚举名就是线上传的 code —— 不要改名，改名等于改协议。
 */
public enum ErrorCode {

    /** 密钥错误 / 会话失效。 */
    UNAUTHORIZED,
    /** 协议版本不兼容。Agent 收到后必须**停止重连**（见 PROTOCOL.md §2）。 */
    PROTOCOL_MISMATCH,
    /** 节点被平台停用。退避重连。 */
    NODE_DISABLED,
    /** 参数校验失败，{@code data.issues} 带字段明细。 */
    INVALID_PARAMS,
    /** 目标玩家 / 组 / 封禁记录不存在。 */
    NOT_FOUND,
    /** 操作要求玩家在线，但不在线。 */
    NOT_ONLINE,
    /** 节点未声明该 capability / 平台发了本插件不认识的方法。 */
    UNSUPPORTED,
    /** 服务端没装 LuckPerms 或 API 版本不兼容。 */
    NO_LUCKPERMS,
    /** 没有可用的 Vault 经济后端。 */
    NO_ECONOMY,
    /** 节点处于只读模式。 */
    READ_ONLY,
    /** 幂等键冲突（同一个 eventId 配了不同的参数）/ 并发修改。 */
    CONFLICT,
    /** 触发限流。 */
    RATE_LIMITED,
    /**
     * 超时。
     *
     * <p>协议文档 §4 说这个码「平台侧生成，非 Agent 返回」，但架构文档 §5.2
     * 明确要求主线程执行超时时 Agent 回 TIMEOUT。两处冲突，这里按架构文档实现：
     * 主线程卡住时必须给平台一个明确的错误，而不是让它等满超时。
     * 已在交付说明里指出这处文档不一致。
     */
    TIMEOUT,
    /** Agent 内部异常，message 带堆栈摘要。 */
    INTERNAL
}
