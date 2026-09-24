/*
 * EncTest.java — 文字编码（GBK/UTF-8）端到端测试 MIDlet
 *
 * 复刻 Forgotten Warrior 读剧情文本的方式：`GameScreen.get_bytes()` 拿到 jar 里的字节
 * → `new String(bytes)`（**平台默认编码**）→ drawString。修之前实机就是这里丢文字：
 * 游戏的 .sn 是 GBK，被当 UTF-8 解 → 每个汉字变 U+FFFD（实测 91 个替换字符）。
 *
 * 本 MIDlet 把 5 条解码路径都打出来（码点用十六进制，免日志编码干扰）：
 *   ① System.getProperty("microedition.encoding")          期望 GBK（模拟中文手机）
 *   ② new String(GBK 字节)      默认编码 + Helper 自动判定  期望 你好
 *   ③ new String(GBK 字节,"GBK") 显式编码 → Gen_Reader/Conv 期望 你好
 *   ④ new String(UTF-8 字节)    默认编码但字节本身是 UTF-8  期望 你好（自动判定照顾它）
 *   ⑤ getBytes() → 再 new String() 往返                     期望 你好
 *   ⑥ jar 里 /test.txt（GBK，构建脚本生成）→ new String()   期望 "游戏文字测试：你好，世界。"
 *
 * 用法：node tools/encoding-test/build.mjs && node tools/test-encoding.mjs
 */
import java.io.InputStream;
import javax.microedition.midlet.MIDlet;
import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Display;
import javax.microedition.lcdui.Graphics;

public class EncTest extends MIDlet {

    private static final String T = "[enc] ";

    /* GBK 的 "你好" */
    private static final byte[] GBK_NIHAO = { (byte) 0xC4, (byte) 0xE3, (byte) 0xBA, (byte) 0xC3 };
    /* UTF-8 的 "你好" */
    private static final byte[] UTF8_NIHAO = { (byte) 0xE4, (byte) 0xBD, (byte) 0xA0,
                                               (byte) 0xE5, (byte) 0xA5, (byte) 0xBD };

    public void startApp() {
        System.out.println(T + "prop=" + System.getProperty("microedition.encoding"));

        /* ② 默认编码：走 Helper.byteToCharArray 的自动判定 */
        try {
            System.out.println(T + "default codes=" + codes(new String(GBK_NIHAO)));
        } catch (Throwable t) {
            System.out.println(T + "FAIL default: " + t);
        }

        /* ③ 显式 GBK：走 Gen_Reader + Conv（真机上由自带映射表兜底） */
        try {
            System.out.println(T + "GBK codes=" + codes(new String(GBK_NIHAO, "GBK")));
        } catch (Throwable t) {
            System.out.println(T + "FAIL GBK: " + t);
        }

        /* ④ UTF-8 字节走默认编码：必须仍然解得对（自动判定要照顾 UTF-8 存档的游戏） */
        try {
            System.out.println(T + "utf8-as-default codes=" + codes(new String(UTF8_NIHAO)));
        } catch (Throwable t) {
            System.out.println(T + "FAIL utf8-as-default: " + t);
        }

        /* ⑤ getBytes() 往返 */
        try {
            byte[] back = new String(GBK_NIHAO, "GBK").getBytes();
            System.out.println(T + "getBytes hex=" + hex(back));
            System.out.println(T + "roundtrip codes=" + codes(new String(back)));
        } catch (Throwable t) {
            System.out.println(T + "FAIL roundtrip: " + t);
        }

        /* ⑥ jar 内 GBK 文本文件 → 默认编码（= 游戏读剧情文本那条路） */
        try {
            InputStream is = getClass().getResourceAsStream("/test.txt");
            if (is == null) {
                System.out.println(T + "FAIL test.txt 不在 jar 里");
            } else {
                byte[] buf = new byte[512];
                int n = is.read(buf);
                byte[] data = new byte[n < 0 ? 0 : n];
                System.arraycopy(buf, 0, data, 0, data.length);
                System.out.println(T + "txt codes=" + codes(new String(data)));
            }
        } catch (Throwable t) {
            System.out.println(T + "FAIL txt: " + t);
        }

        /* ⑦ 纯 ASCII 不受影响（GBK 是 ASCII 超集） */
        try {
            System.out.println(T + "ascii codes=" + codes(new String(new byte[] { 65, 66, 67 })));
        } catch (Throwable t) {
            System.out.println(T + "FAIL ascii: " + t);
        }

        Display.getDisplay(this).setCurrent(new MainCanvas());
        System.out.println(T + "DONE");
    }

    public void pauseApp() { }

    public void destroyApp(boolean unconditional) { }

    private static String codes(String s) {
        StringBuffer sb = new StringBuffer();
        for (int i = 0; i < s.length(); i++) {
            if (i > 0) sb.append(',');
            sb.append(Integer.toHexString(s.charAt(i)));
        }
        return sb.toString() + " (len=" + s.length() + ")";
    }

    private static String hex(byte[] b) {
        StringBuffer sb = new StringBuffer();
        for (int i = 0; i < b.length; i++) {
            int v = b[i] & 0xff;
            if (v < 16) sb.append('0');
            sb.append(Integer.toHexString(v));
        }
        return sb.toString();
    }

    static class MainCanvas extends Canvas {
        protected void paint(Graphics g) {
            g.setColor(0x000000);
            g.fillRect(0, 0, getWidth(), getHeight());
        }
    }
}
