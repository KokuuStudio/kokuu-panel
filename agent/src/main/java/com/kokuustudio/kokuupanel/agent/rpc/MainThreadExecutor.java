package com.kokuustudio.kokuupanel.agent.rpc;

import com.kokuustudio.kokuupanel.agent.protocol.AgentException;
import com.kokuustudio.kokuupanel.agent.protocol.ErrorCode;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.bukkit.Bukkit;
import org.bukkit.plugin.Plugin;

/**
 * 把 RPC 处理体切回服务端主线程执行。见 docs/ARCHITECTURE.md §5。
 *
 * <p>Bukkit 的玩家 / 世界 API 只能在主线程调用。WS 读线程收到请求后：
 *
 * <pre>
 * Future&lt;T&gt; call = new FutureTask&lt;&gt;(() -&gt; handleOnMainThread(params));
 * Bukkit.getScheduler().runTask(plugin, call);
 * return call.get(timeoutMs, MILLISECONDS);   // 阻塞 WS 线程，不阻塞主线程
 * </pre>
 *
 * <p>架构文档 §5 的三个坑，这里逐个处理：
 * <ol>
 *   <li>阻塞的是 WS 读线程，不是主线程 —— 每个连接一个读线程，主线程只做任务体。</li>
 *   <li>必须带超时 —— 主线程卡住（插件死循环）时 WS 线程不能跟着永久阻塞。</li>
 *   <li><b>关服时 runTask 会抛 IllegalStateException</b>（scheduler 已停止），
 *       必须捕获并回 INTERNAL，不能让异常吃掉响应导致平台侧等满超时。</li>
 * </ol>
 */
public final class MainThreadExecutor {

    private final Plugin plugin;
    private volatile long timeoutMs;

    public MainThreadExecutor(Plugin plugin, long timeoutMs) {
        this.plugin = plugin;
        this.timeoutMs = timeoutMs;
    }

    public void setTimeoutMs(long timeoutMs) {
        this.timeoutMs = timeoutMs;
    }

    public long getTimeoutMs() {
        return timeoutMs;
    }

    /**
     * 在主线程上执行并等待结果。
     *
     * @throws AgentException TIMEOUT / INTERNAL
     */
    public <T> T call(final Callable<T> task) {
        // 已经在主线程上（例如 /kp 命令的处理体里间接调用）就直接跑 ——
        // 否则 runTask + get 会自己等自己，死锁。
        if (Bukkit.isPrimaryThread()) {
            try {
                return task.call();
            } catch (RuntimeException e) {
                throw e;
            } catch (Exception e) {
                throw new AgentException(ErrorCode.INTERNAL, describe(e), e);
            }
        }

        FutureTask<T> future = new FutureTask<T>(task);
        try {
            Bukkit.getScheduler().runTask(plugin, future);
        } catch (Throwable t) {
            // 关服：scheduler 已经停了（IllegalStateException）。
            // 必须收敛成 INTERNAL 并立刻回响应，见架构文档 §5.3。
            throw new AgentException(ErrorCode.INTERNAL,
                    "无法调度到主线程（服务器可能正在关闭）: " + describe(t), t);
        }

        try {
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            // 任务可能还在主线程上排队/执行，取消不了就让它跑完，但响应必须现在回。
            future.cancel(false);
            throw new AgentException(ErrorCode.TIMEOUT,
                    "主线程执行超时（" + timeoutMs + "ms），任务可能仍在执行");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            if (cause instanceof RuntimeException) {
                throw (RuntimeException) cause;
            }
            if (cause instanceof Error) {
                throw (Error) cause;
            }
            throw new AgentException(ErrorCode.INTERNAL, describe(cause), cause);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AgentException(ErrorCode.INTERNAL, "等待主线程结果时被中断");
        }
    }

    /** 异常摘要：类名 + message + 第一处本项目栈帧。协议 §4 说 INTERNAL 的 message 带堆栈摘要。 */
    public static String describe(Throwable throwable) {
        if (throwable == null) {
            return "未知异常";
        }
        StringBuilder builder = new StringBuilder();
        builder.append(throwable.getClass().getName());
        String message = throwable.getMessage();
        if (message != null && !message.isEmpty()) {
            builder.append(": ").append(message);
        }
        builder.append(stackHint(throwable));
        Throwable cause = throwable.getCause();
        if (cause != null && cause != throwable) {
            builder.append(" ← ").append(cause.getClass().getName());
            if (cause.getMessage() != null && !cause.getMessage().isEmpty()) {
                builder.append(": ").append(cause.getMessage());
            }
        }
        return builder.toString();
    }

    private static String stackHint(Throwable throwable) {
        StackTraceElement[] frames = throwable.getStackTrace();
        if (frames == null) {
            return "";
        }
        for (StackTraceElement frame : frames) {
            String className = frame.getClassName();
            if (className.startsWith("com.kokuustudio.kokuupanel")) {
                return " @ " + className + "." + frame.getMethodName() + "(" + frame.getFileName()
                        + ":" + frame.getLineNumber() + ")";
            }
        }
        return frames.length > 0 ? " @ " + frames[0].toString() : "";
    }
}
