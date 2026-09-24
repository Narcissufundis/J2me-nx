/*
 * DgTest.java — Nokia DirectGraphics 端到端测试 MIDlet（2026-09-23 perfZ7）
 *
 * 为什么要有它：1.jar（武林Q传）进游戏后**立绘和地图整片全黑**，根因是
 * com.nokia.mid.ui.DirectGraphicsImp.drawImage **从未实现** —— 而 VM 对"没实现的 native"
 * 不抛异常、只是打个日志然后什么都不画（见 vm/runtime.ts:904），于是那块画面静默消失。
 *
 * 本 MIDlet 把 DirectGraphics 的绘制路径全打一遍，配合 tools/test-nokia-dg.mjs
 * （记录并复核画布上的变换与像素）验收：
 *   · drawImage 的 8 种 manipulation（0 / FLIP_H / FLIP_V / 90 / 180 / 270 / 两种组合）
 *   · setARGBColor + getAlphaComponent + getNativePixelFormat
 *   · fillTriangle / drawTriangle / fillPolygon
 *   · drawPixels(byte[], byte[], …) 单色位图（宽度 8 刚好一个字节，便于逐像素核对）
 *
 * 编译（-encoding UTF-8 必须带）：
 *   javac -encoding UTF-8 -nowarn -source 1.3 -target 1.3 -bootclasspath "" -cp java/classes.jar DgTest.java
 * 打包：
 *   jar cfm dgtest.jar MANIFEST.MF DgTest.class 'DgTest$C.class' 'DgTest$1.class'
 */
import javax.microedition.midlet.MIDlet;
import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Display;
import javax.microedition.lcdui.Graphics;
import javax.microedition.lcdui.Image;
import com.nokia.mid.ui.DirectGraphics;
import com.nokia.mid.ui.DirectUtils;

public class DgTest extends MIDlet {

    private Display display;
    private boolean painted = false;

    public DgTest() {
        display = Display.getDisplay(this);
    }

    public void startApp() {
        display.setCurrent(new C());
        System.out.println("[dg] 已显示 Canvas");
        new Thread(new Runnable() {
            public void run() {
                try { Thread.sleep(2500); } catch (InterruptedException e) { }
                System.out.println("[dg] 退出");
                notifyDestroyed();
            }
        }).start();
    }

    public void pauseApp() { }

    public void destroyApp(boolean unconditional) { }

    class C extends Canvas {
        public void paint(Graphics g) {
            if (painted) return;      // 只跑一遍，日志干净
            painted = true;
            try {
                run(g);
            } catch (Throwable t) {
                System.out.println("[dg] 异常: " + t);
            }
        }

        private void run(Graphics g) {
            // 4x2 的图：内容不重要（几何由宿主记录），但要有非平凡尺寸才能看出旋转
            Image img = Image.createImage(4, 2);
            Graphics ig = img.getGraphics();
            ig.setColor(0x00FF00);
            ig.fillRect(0, 0, 4, 2);

            DirectGraphics dg = DirectUtils.getDirectGraphics(g);

            int[] mans = { 0, 8192, 16384, 90, 180, 270, 8192 | 90, 16384 | 90 };
            for (int i = 0; i < mans.length; i++) {
                int x = 10 + i * 20, y = 30;
                System.out.println("[dg] drawImage man=" + mans[i] + " x=" + x + " y=" + y + " w=4 h=2");
                dg.drawImage(img, x, y, Graphics.TOP | Graphics.LEFT, mans[i]);
            }

            dg.setARGBColor(0xFF804020);
            System.out.println("[dg] alpha=" + dg.getAlphaComponent());
            System.out.println("[dg] fmt=" + dg.getNativePixelFormat());

            System.out.println("[dg] fillTriangle");
            dg.fillTriangle(5, 100, 25, 100, 15, 120, 0xFF00FF00);
            System.out.println("[dg] drawTriangle");
            dg.drawTriangle(5, 130, 25, 130, 15, 150, 0xFF0000FF);

            System.out.println("[dg] fillPolygon");
            int[] xs = new int[] { 40, 60, 50 };
            int[] ys = new int[] { 100, 100, 120 };
            dg.fillPolygon(xs, 0, ys, 0, 3, 0xFFFF0000);

            // 单色位图：8x1，模式 0xB1 = 1011 0001（位=1 画黑、0 画白），mask 全 1（全不透明）
            System.out.println("[dg] drawPixels8x1");
            dg.drawPixels(new byte[] { (byte) 0xB1 }, new byte[] { (byte) 0xFF },
                          0, 1, 200, 200, 8, 1, 0, 1);

            System.out.println("[dg] done");
        }
    }
}
