package com.kokuustudio.kokuupanel.agent.events;

import java.text.MessageFormat;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

/**
 * 把服务端日志接成 {@code console.line} 事件。
 *
 * <p>做法是给 {@code Bukkit.getLogger()}（即 "Minecraft" logger）挂一个 Handler。
 * 插件的 logger（"Minecraft.KokuuAgent"）是它的子 logger，日志会向上传播到这里，
 * 所以服务端日志和插件日志都能收到。
 *
 * <p><b>已知边界（如实说明）</b>：直接往 {@code System.out} 写的内容（少数老插件
 * 这么干）不经过 java.util.logging，抓不到。要抓就得改写 System.out，
 * 那会干扰服务端自己的控制台重定向，代价大于收益。
 *
 * <p>重入保护：本 Handler 内部会走「发 WebSocket 帧」这条路，万一失败路径再打日志，
 * 就会形成「日志 → 事件 → 日志」的自激。用 ThreadLocal 掐死。
 */
public final class ConsoleLogHandler extends Handler {

    private final EventReporter reporter;
    private final ThreadLocal<Boolean> inHandler = new ThreadLocal<Boolean>();

    public ConsoleLogHandler(EventReporter reporter) {
        this.reporter = reporter;
        setLevel(Level.INFO);
    }

    @Override
    public void publish(LogRecord record) {
        if (record == null || !isLoggable(record)) {
            return;
        }
        if (Boolean.TRUE.equals(inHandler.get())) {
            return;
        }
        inHandler.set(Boolean.TRUE);
        try {
            reporter.consoleLine(format(record), record.getLevel().getName());
        } catch (Throwable ignored) {
            // 控制台事件绝不能让服务端日志路径炸掉。
        } finally {
            inHandler.set(Boolean.FALSE);
        }
    }

    @Override
    public void flush() {
        // 无缓冲。
    }

    @Override
    public void close() throws SecurityException {
        // 无资源。
    }

    private static String format(LogRecord record) {
        String message = record.getMessage();
        Object[] parameters = record.getParameters();
        if (message != null && parameters != null && parameters.length > 0) {
            try {
                message = MessageFormat.format(message, parameters);
            } catch (IllegalArgumentException ignored) {
                // 消息里带 {} 但不是 MessageFormat 语法，保持原样。
            }
        }
        if (message == null) {
            message = "";
        }
        StringBuilder builder = new StringBuilder();
        String loggerName = record.getLoggerName();
        if (loggerName != null && !"Minecraft".equals(loggerName) && !loggerName.isEmpty()) {
            builder.append('[').append(shortName(loggerName)).append("] ");
        }
        builder.append(message);
        Throwable thrown = record.getThrown();
        if (thrown != null) {
            builder.append(" | ").append(thrown.getClass().getName());
            if (thrown.getMessage() != null) {
                builder.append(": ").append(thrown.getMessage());
            }
        }
        return builder.toString();
    }

    private static String shortName(String loggerName) {
        int index = loggerName.lastIndexOf('.');
        return index < 0 ? loggerName : loggerName.substring(index + 1);
    }

    /** 挂到服务端 logger 上。 */
    public static ConsoleLogHandler attach(Logger serverLogger, EventReporter reporter) {
        ConsoleLogHandler handler = new ConsoleLogHandler(reporter);
        serverLogger.addHandler(handler);
        return handler;
    }

    /** 摘掉。不摘的话 /reload 多次会在同一个 logger 上堆多个 Handler，日志会被重复发。 */
    public static void detach(Logger serverLogger, ConsoleLogHandler handler) {
        if (serverLogger != null && handler != null) {
            serverLogger.removeHandler(handler);
        }
    }
}
