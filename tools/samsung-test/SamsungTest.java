/*
 * SamsungTest.java — 三星 SDK 兼容层（com.samsung.util.AudioClip / Vibration）端到端测试 MIDlet
 *
 * 复刻 Forgotten Warrior.jar 的真实调用序列（见 GameScreen 反汇编）：
 *     new AudioClip(3, "/7.mid") → play(1, 3) → stop()
 *     Vibration.start(duration, 3)
 * 判定标准只有一条：**任何一步都不能抛异常**。
 *   - 类不存在 → NoClassDefFoundError（修之前实机就是这条，游戏在 startApp 里直接死）
 *   - 方法签名不对 → NoSuchMethodError
 *   - 内部实现把 MediaException 漏出来 → 游戏崩
 * 所以每一步都单独 try/catch 并把结论打进日志，宿主脚本按行断言。
 *
 * 用法：node tools/samsung-test/build.mjs && node tools/test-samsung-api.mjs
 */
import javax.microedition.midlet.MIDlet;
import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Display;
import javax.microedition.lcdui.Graphics;
import com.samsung.util.AudioClip;
import com.samsung.util.Vibration;

public class SamsungTest extends MIDlet {

    private static final String T = "[samtest] ";

    public void startApp() {
        /* ① Vibration：游戏 call_vib(I)V 里是裸调用，一抛异常就带崩主循环 */
        try {
            System.out.println(T + "Vibration.isSupported=" + Vibration.isSupported()
                    + " TYPE_MIDI=" + AudioClip.TYPE_MIDI);
            Vibration.start(500, 3);
            Vibration.stop();
            System.out.println(T + "PASS Vibration start/stop 无异常");
        } catch (Throwable t) {
            System.out.println(T + "FAIL Vibration: " + t);
        }

        /* ② AudioClip：构造 + 播放 + 停止（正常路径，jar 内有 /test.mid） */
        try {
            AudioClip ac = new AudioClip(3, "/test.mid");
            System.out.println(T + "PASS AudioClip 构造完成");
            ac.play(1, 3);
            System.out.println(T + "PASS play(1,3) 无异常，vol=" + ac.getVolume());
            ac.stop();
            ac.play(-1, 100);
            ac.stop();
            System.out.println(T + "PASS play/stop 反复调用无异常");
        } catch (Throwable t) {
            System.out.println(T + "FAIL AudioClip: " + t);
        }

        /* ③ 资源缺失 + 无前导 '/' 的名字：都得静默降级，不能崩 */
        try {
            AudioClip miss = new AudioClip(3, "/no_such_file.mid");
            miss.play(1, 3);
            miss.stop();
            AudioClip rel = new AudioClip(3, "test.mid");
            rel.play(1, 3);
            rel.stop();
            System.out.println(T + "PASS 缺资源/相对名不崩");
        } catch (Throwable t) {
            System.out.println(T + "FAIL 缺资源: " + t);
        }

        /* ④ 内存数据构造（另一种三星重载） */
        try {
            byte[] junk = new byte[16];
            AudioClip mem = new AudioClip(1, junk, 0, 16);
            mem.stop();
            System.out.println(T + "PASS 内存数据构造不崩");
        } catch (Throwable t) {
            System.out.println(T + "FAIL 内存数据构造: " + t);
        }

        /* ④ 音乐循环：游戏（Forgotten Warrior）每秒都会 new 一次同一个曲子的 AudioClip ——
         *    必须复用已载入的 Player，否则实机是 ~1MB/秒的分配增长 + 每秒 3 行 midi 日志 */
        try {
            for (int i = 0; i < 4; i++) {
                AudioClip loop = new AudioClip(3, "/test.mid");
                loop.play(1, 3);
                loop.stop();
            }
            System.out.println(T + "PASS 反复 new AudioClip 循环播放无异常");
        } catch (Throwable t) {
            System.out.println(T + "FAIL 循环播放: " + t);
        }

        Display.getDisplay(this).setCurrent(new MainCanvas());
        System.out.println(T + "DONE");
    }

    public void pauseApp() { }

    public void destroyApp(boolean unconditional) { }

    static class MainCanvas extends Canvas {
        protected void paint(Graphics g) {
            g.setColor(0x000000);
            g.fillRect(0, 0, getWidth(), getHeight());
            g.setColor(0xFFFFFF);
            g.drawString("samtest", 4, 4, Graphics.TOP | Graphics.LEFT);
        }
    }
}
