package com.kokuustudio.kokuupanel.agent.protocol;

/**
 * 带协议错误码的异常。抛出后被 {@code RpcDispatcher} 统一转成
 * {@code {"ok":false,"error":{"code":…,"message":…,"data":…}}}。
 *
 * <p>对应 packages/protocol 里的 {@code AgentError}。
 */
public class AgentException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final ErrorCode code;
    private final transient Object data;

    public AgentException(ErrorCode code, String message) {
        this(code, message, null);
    }

    public AgentException(ErrorCode code, String message, Object data) {
        super(message);
        this.code = code;
        this.data = data;
    }

    public AgentException(ErrorCode code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.data = null;
    }

    public ErrorCode getCode() {
        return code;
    }

    public Object getData() {
        return data;
    }
}
