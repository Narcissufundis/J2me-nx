/*
 * PATCH(j2me-nx-port) 2026-09-23: 补三星 SDK 的 com.samsung.util.AudioClip。
 *
 * 为什么需要它：Forgotten Warrior.jar（D:\...\J2ME整理\能玩）的 GameScreen 在构造时
 * 直接 `new AudioClip(3, "/7.mid")`（字节码：bipush 3 / ldc "/7.mid" /
 * invokespecial <init>(ILjava/lang/String;)V），并调用 play(II)V / stop()V。
 * 我们类库里没有 com.samsung.util.*，于是 MIDlet 的 startApp 抛
 *   ClassNotFoundException: com/samsung/util/AudioClip.class
 * —— 游戏在类加载阶段就死了（实机日志 "listener error"，仿真里表现为 15s 零帧）。
 *
 * 实现策略：**真播**，不是打桩。本移植层的 MIDI 不走 FFmpeg，而是纯 JS 合成器
 * （vendor/pluotsorbet/midp/midi-synth.js，经 Manager.createPlayer(is,"audio/midi") 进入），
 * 而三星游戏的 AudioClip 资源 99% 是 .mid → 用 Manager 建 Player 就能真的出声。
 *
 * 兼容性要点（都是实机踩过的坑）：
 *   ① 构造函数**不声明任何受检异常**：游戏调用点没有 try/catch（它是照三星 SDK 写的），
 *      所有失败（资源缺失、MediaException、连不上音频管道）一律内部吞掉 → 静默降级，
 *      游戏照常跑，只是没声音。绝不能因为配音效把游戏搞崩。
 *   ② 资源名按 **jar 根**解析（"7.mid" 与 "/7.mid" 等价）：三星设备就是这么解析的，
 *      而 java.lang.Class.getResourceAsStream 的相对格式会按包名拼路径，不能用。
 *   ③ 音量刻度兼容两种写法：三星老 SDK 的 volume 有 0~10 与 0~100 两种习惯，
 *      ≤10 视为 0~10 刻度并 ×10（例：play(1,3) → 30%），>10 直接当百分比。
 *   ④ 设备是**单音频通道**：新 clip 播放时停掉上一个正在播的 clip（静态 active）。
 */

package com.samsung.util;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import javax.microedition.media.Manager;
import javax.microedition.media.Player;
import javax.microedition.media.control.VolumeControl;

public class AudioClip {

    /* 资源类型常量。三星 SDK 官方只公开 TYPE_MMF/TYPE_WAV；
     * Forgotten Warrior 传的是 3 且资源是 "/7.mid"，故此处把 3 记为 TYPE_MIDI。
     * 真正决定用哪种解码的是**扩展名**（见 contentTypeOf），type 只作兜底。 */
    public static final int TYPE_MMF = 0;
    public static final int TYPE_WAV = 1;
    public static final int TYPE_MP3 = 2;
    public static final int TYPE_MIDI = 3;

    /** 当前正在播的 clip（设备单通道语义）。 */
    private static AudioClip active = null;

    /*
     * PATCH(j2me-nx-port) 2026-09-23：Player 复用缓存。
     * 三星游戏的"背景音乐循环"写法是**每轮重新 `new AudioClip(3, "/3.mid")` 再 play()**
     * （实机日志实测：Forgotten Warrior 每 1~2 秒一次）。不复用的话每次都要重读 jar 资源 +
     * 新建一个 MidiPlayer，实机表现为约 **1MB/秒**的分配增长（`[alloc] 窗口10s=7.02MB byte[]=100%`）
     * 和每秒 3 行 [midi] 日志。这里按"jar 内资源名"缓存 Player，重复播放走 setMediaTime(0)+start。
     */
    private static final java.util.Hashtable PLAYER_CACHE = new java.util.Hashtable();
    /** 缓存上限：正常游戏最多几十首曲子，16 个够用，避免异常游戏把内存吃光。 */
    private static final int CACHE_MAX = 16;

    /** true = 名字构造（参与缓存）；false = byte[] 构造（没有资源名可做键）。 */
    private final boolean named;
    /** 该实例在缓存里的键（null = 没进缓存）。 */
    private String cacheKey = null;

    private final int type;
    private final String name;
    private Player player = null;
    private boolean playing = false;
    private int volume = 100;
    private boolean logged = false;

    /**
     * @param type 资源类型（TYPE_*），只作兜底，实际按扩展名判定
     * @param name jar 内的资源名，如 "/7.mid" 或 "7.mid"
     */
    public AudioClip(int type, String name) {
        this.type = type;
        this.name = name;
        this.named = true;
        InputStream is = null;
        try {
            is = getClass().getResourceAsStream(fixName(name));
        } catch (Throwable t) {
            logOnce("资源打开异常：" + name + " / " + t);
        }
        open(fixName(name), is);
    }

    /**
     * 三星 SDK 的第二种构造：直接把内存里的音频数据喂进来。
     * 目前没有游戏用到，但留着以免别的 jar 一碰就 NoSuchMethodError。
     */
    public AudioClip(int type, byte[] data, int offset, int length) {
        this.type = type;
        this.name = "<内存数据>";
        this.named = false;
        InputStream is = null;
        try {
            if (data != null && length > 0 && offset >= 0 && offset + length <= data.length) {
                is = new ByteArrayInputStream(data, offset, length);
            }
        } catch (Throwable t) {
            logOnce("内存音频数据无效：" + t);
        }
        open(this.name, is);
    }

    /* ------------------------------------------------------------------ */

    /** 统一成 jar 根绝对路径：Class.getResourceAsStream 的绝对格式要求以 '/' 开头。 */
    private static String fixName(String n) {
        if (n == null || n.length() == 0) return "/";
        return n.charAt(0) == '/' ? n : "/" + n;
    }

    /** 按扩展名选 content type —— 这才是决定用哪个解码器的关键。 */
    private static String contentTypeOf(int type, String name) {
        String lower = name == null ? "" : name.toLowerCase();
        if (lower.endsWith(".mid") || lower.endsWith(".midi")) return "audio/midi";
        if (lower.endsWith(".wav")) return "audio/x-wav";
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".amr")) return "audio/amr";
        if (lower.endsWith(".mmf") || lower.endsWith(".smaf")) return "audio/mmf";
        if (lower.endsWith(".aac")) return "audio/aac";
        if (type == TYPE_WAV) return "audio/x-wav";
        if (type == TYPE_MP3) return "audio/mpeg";
        if (type == TYPE_MMF) return "audio/mmf";
        return "audio/midi"; /* 三星游戏里绝大多数是 MIDI，兜底选它 */
    }

    private void open(String fixedName, InputStream is) {
        if (is == null) {
            logOnce("jar 里找不到资源 " + fixedName + "，静音处理");
            return;
        }
        /* 同一个资源名已经建过 Player 就直接复用（音乐循环的游戏每秒都会 new 一次）——
         * 这也是"每轮重新载入"那条 1MB/秒分配增长的解药，见 PLAYER_CACHE 的注释。 */
        if (named) {
            Object hit = PLAYER_CACHE.get(fixedName);
            if (hit instanceof Player) {
                player = (Player) hit;
                cacheKey = fixedName;
                System.out.println("[samsung] AudioClip 复用 " + fixedName + "（不再重读资源）");
                return;
            }
        }
        try {
            String ct = contentTypeOf(type, fixedName);
            player = Manager.createPlayer(is, ct);
            player.realize();
            player.prefetch();
            if (named && PLAYER_CACHE.size() < CACHE_MAX) {
                PLAYER_CACHE.put(fixedName, player);
                cacheKey = fixedName;
            }
            System.out.println("[samsung] AudioClip 载入 " + fixedName + "（" + ct + "）");
        } catch (Throwable t) {
            player = null;
            logOnce("载入失败（静音继续）：" + fixedName + " / " + t);
        }
    }

    /** 只在第一次出问题时打一行日志，避免游戏循环里刷屏（实机 fps 成本）。 */
    private void logOnce(String msg) {
        if (logged) return;
        logged = true;
        System.out.println("[samsung] AudioClip " + msg);
    }

    /* ------------------------------------------------------------------ */

    /** 播放。loopCount<=0 视为无限循环；volume 见文件头 ③。 */
    public void play(int loopCount, int volume) {
        if (player == null) {
            logOnce("没有可用播放器（" + name + "），play() 忽略");
            return;
        }
        try {
            AudioClip prev = active;
            if (prev != null && prev != this) prev.stop();   /* 单通道：换曲先停上一首 */
            setVolume(volume);
            player.setLoopCount(loopCount <= 0 ? -1 : loopCount);
            try {
                player.setMediaTime(0);   /* stop() 后重新播放要从头开始 */
            } catch (Throwable t) {
                /* 不支持 setMediaTime 就原地续播，不阻断 */
            }
            player.start();
            active = this;
            playing = true;
            System.out.println("[samsung] AudioClip 播放 " + name
                    + "（loop=" + loopCount + " vol=" + volume + "）");
        } catch (Throwable t) {
            logOnce("播放失败（静音继续）：" + name + " / " + t);
        }
    }

    public void stop() {
        if (player == null) return;
        try {
            if (playing) player.stop();
        } catch (Throwable t) {
            /* 忽略：停不下来也不能影响游戏 */
        }
        playing = false;
        if (active == this) active = null;
    }

    public void pause() {
        stop();
    }

    public void resume() {
        play(1, volume);
    }

    public boolean isPlaying() {
        if (player == null || !playing) return false;
        try {
            return player.getState() == Player.STARTED;
        } catch (Throwable t) {
            return playing;
        }
    }

    public int getVolume() {
        return volume;
    }

    /** 0~10 视为 0~10 刻度（×10），>10 视为百分比。 */
    public void setVolume(int v) {
        volume = normalizeVolume(v);
        if (player == null) return;
        try {
            VolumeControl vc = (VolumeControl) player.getControl("VolumeControl");
            if (vc != null) vc.setLevel(volume);
        } catch (Throwable t) {
            /* 没有音量控制就算了，用设备默认音量播 */
        }
    }

    private static int normalizeVolume(int v) {
        if (v <= 0) return 0;
        if (v <= 10) return v * 10;
        if (v > 100) return 100;
        return v;
    }

    /** 兼容性兜底：万一有游戏自己调它。缓存里的条目要一并摘掉，否则复用会拿到已关闭的 Player。 */
    public void release() {
        stop();
        if (cacheKey != null) {
            PLAYER_CACHE.remove(cacheKey);
            cacheKey = null;
        }
        if (player != null) {
            try {
                player.deallocate();
                player.close();
            } catch (Throwable t) {
                /* 忽略 */
            }
            player = null;
        }
    }
}
