/*
 * Copyright (c) 2026 j2me-nx-port contributors
 * Nokia UI API 兼容层 —— Sound（单调/波形声音播放）。
 * 在本模拟器中为桩实现：不发声，但保持状态机兼容，
 * 依赖 getState()/setGain() 等调用的游戏可正常运行。
 */
package com.nokia.mid.sound;

public class Sound {

    public static final int FORMAT_TONE = 1;
    public static final int FORMAT_WAV = 5;

    public static final int SOUND_PLAYING = 3;
    public static final int SOUND_STOPPED = 0;

    private SoundListener listener;
    private int state = SOUND_STOPPED;
    private int gain = 255;

    public Sound(byte[] data, int offset, int size) {
    }

    public Sound(int freq, int duration) {
    }

    public void play(int loop) {
        state = SOUND_PLAYING;
    }

    public void stop() {
        if (state == SOUND_PLAYING) {
            state = SOUND_STOPPED;
            if (listener != null) {
                listener.soundStopped(this);
            }
        }
    }

    public void setGain(int gain) {
        this.gain = gain;
    }

    public int getGain() {
        return gain;
    }

    public int getState() {
        return state;
    }

    public void release() {
        state = SOUND_STOPPED;
    }

    public void setSoundListener(SoundListener soundListener) {
        this.listener = soundListener;
    }

    public static int getConcurrentSound(int type) {
        return 1;
    }
}
