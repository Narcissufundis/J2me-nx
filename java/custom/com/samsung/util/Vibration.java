/*
 * PATCH(j2me-nx-port) 2026-09-23: 补三星 SDK 的 com.samsung.util.Vibration。
 *
 * 背景：Forgotten Warrior.jar（"能玩" 目录）实机启动即死，日志为
 *   listener error: ClassNotFoundException: com/samsung/util/AudioClip.class
 * 同一个 MIDlet（GameScreen.call_vib(I)V）还会调 Vibration.start(II)V ——
 * 少了它，即使 AudioClip 补上，震动那一处照样 ClassNotFoundException。
 *
 * 语义：Nintendo Switch 手持/底座都没有振动马达（HD 震动只对 Joy-Con 开放，
 * 且 nx.js 音频/震动管道未接），所以这里是**纯空实现**，只保证不抛异常：
 * call_vib() 在字节码里是**裸调用**（无 try/catch 包裹），一旦抛异常会直接
 * 冒泡进游戏主循环，把游戏带崩。
 *
 * isSupported() 返回 true 是刻意的：老三星游戏常用它来决定"是否显示震动开关 /
 * 是否走震动分支"，返回 false 可能让某些游戏直接拒绝运行（比"没震动"更糟）。
 * 真机验证：游戏可正常进入，只是没有震感。
 */

package com.samsung.util;

public final class Vibration {

    /* 只在第一次调用时打一行日志，避免游戏每帧调用刷屏（实机 fps 成本）。 */
    private static boolean logged = false;

    /** 本机（Switch）没有振动马达，但对外声明"支持"，避免游戏因检测失败而拒跑。 */
    public static boolean isSupported() {
        return true;
    }

    /** 空实现：duration 毫秒、strength 强度均忽略。绝不抛异常。 */
    public static void start(int duration, int strength) {
        if (!logged) {
            logged = true;
            System.out.println("[samsung] Vibration.start(" + duration + "," + strength
                    + ")：Switch 无振动马达，已静默忽略");
        }
    }

    public static void stop() {
        /* 空实现 */
    }

    private Vibration() {
        /* 工具类，不可实例化 */
    }
}
