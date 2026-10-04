package com.kokuustudio.kokuupanel.agent.util;

import java.util.regex.Pattern;

/** 文本处理：颜色代码剥离与占位符替换。 */
public final class Text {

    /** 传统 § 颜色代码（含 §x 的十六进制写法）。 */
    private static final Pattern COLOR = Pattern.compile("(?i)\u00A7[0-9A-FK-ORX]");

    /** config.yml 里写的是 &a 这种好输入的写法。 */
    private static final Pattern AMPERSAND_COLOR = Pattern.compile("(?i)&([0-9A-FK-OR])");

    private Text() {
    }

    /** 把配置里的 {@code &a} 转成服务端认识的 {@code §a}。 */
    public static String colorize(String input) {
        if (input == null) {
            return null;
        }
        return AMPERSAND_COLOR.matcher(input).replaceAll("\u00A7$1");
    }

    /**
     * 剥掉 § 颜色代码。
     *
     * <p>平台是 Web 界面，不认识 Minecraft 的颜色代码，原样显示会变成
     * 「§a完成」这种噪音。控制台回显与昵称都过这一层。
     */
    public static String stripColor(String input) {
        if (input == null) {
            return null;
        }
        return COLOR.matcher(input).replaceAll("");
    }

    /** 把 {@code ${key}} 换成 value。 */
    public static String fill(String template, String key, String value) {
        if (template == null) {
            return null;
        }
        return template.replace("${" + key + "}", value == null ? "" : value);
    }

    /** 空字符串安全判断。 */
    public static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }

    /** 把可能为 null 的字符串变成「空串」。 */
    public static String nvl(String value) {
        return value == null ? "" : value;
    }
}
