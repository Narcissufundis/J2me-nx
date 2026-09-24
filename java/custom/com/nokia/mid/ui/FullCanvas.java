/*
 * Copyright (c) 2026 j2me-nx-port contributors
 * Nokia UI API 兼容层 —— FullCanvas（MIDP-1.0 时代 Nokia 专有 API）。
 * 大量早期 Nokia 游戏（如凡人修仙传等）以 FullCanvas 为游戏画布基类。
 * 参考公开的 Nokia UI API 规范实现；软键/箭头键码常量与真机一致。
 */
package com.nokia.mid.ui;

import javax.microedition.lcdui.Canvas;

public abstract class FullCanvas extends Canvas {

    public static final int KEY_UP_ARROW = -1;
    public static final int KEY_DOWN_ARROW = -2;
    public static final int KEY_LEFT_ARROW = -3;
    public static final int KEY_RIGHT_ARROW = -4;
    public static final int KEY_SOFTKEY3 = -5;   // 中键/选择键
    public static final int KEY_SOFTKEY1 = -6;   // 左软键
    public static final int KEY_SOFTKEY2 = -7;   // 右软键
    public static final int KEY_CLEAR = -8;
    public static final int KEY_SEND = -10;
    public static final int KEY_END = -11;

    protected FullCanvas() {
        super();
    }

    /**
     * 画布即将上屏时回调（真机由系统调用；本实现仅保留空实现，
     * 兼容依赖该回调初始化的游戏）。
     */
    protected void onShow() {
    }

    /**
     * 画布即将离屏时回调。
     */
    protected void onHide() {
    }
}
