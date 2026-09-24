/*
 * FixtureMidlet.java — 回归测试用的**自制**最小 MIDlet（perfZ24）
 *
 * 为什么需要它：菜单 / 软重启 / 界面语言这几条端到端测试，过去直接拿一个**商业游戏 jar**
 * （tools/tmp-softrestart/A_176x220.jar）当夹具 —— 那是别人的游戏，**不能进公开源码库**。
 * 这里用我们自己写的 MIDlet 顶上：能被菜单扫描出 MIDlet-1 入口、能启动、能画一帧、
 * 能被 notifyDestroyed 正常退出，就够了（测试不关心游戏内容）。
 *
 * 行为：startApp → 建一个 Canvas 并显示（菜单/呈现层因此能拿到帧）→ 可选延时自退
 *      （J2ME_FIXTURE_EXIT_MS 用 System.getProperty 读不到，所以固定不自退，由测试驱动）。
 */
import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Display;
import javax.microedition.lcdui.Graphics;
import javax.microedition.midlet.MIDlet;

public class FixtureMidlet extends MIDlet {
    private Display display;
    private FixtureCanvas canvas;

    protected void startApp() {
        if (display == null) {
            display = Display.getDisplay(this);
            canvas = new FixtureCanvas();
        }
        display.setCurrent(canvas);
        System.out.println("FIXTURE-START");
    }

    protected void pauseApp() {
        System.out.println("FIXTURE-PAUSE");
    }

    protected void destroyApp(boolean unconditional) {
        System.out.println("FIXTURE-DESTROY");
    }

    static class FixtureCanvas extends Canvas {
        private int tick = 0;

        protected void paint(Graphics g) {
            int w = getWidth();
            int h = getHeight();
            g.setColor(0x000000);
            g.fillRect(0, 0, w, h);
            g.setColor(0x00FF00);
            g.drawRect(1, 1, w - 3, h - 3);
            g.drawString("FIXTURE " + (tick++), w / 2, h / 2, Graphics.HCENTER | Graphics.BASELINE);
        }

        protected void keyPressed(int keyCode) {
            repaint();
        }
    }
}
