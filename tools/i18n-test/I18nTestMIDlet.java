import javax.microedition.midlet.MIDlet;
import javax.microedition.lcdui.game.LayerManager;

/**
 * 类库补全验证 MIDlet（GBK 编码 + StringBuilder + LayerManager）。
 * 输出标记行供 Node E2E 断言：
 *   GBK-TEST / SB-TEST / LM-TEST / ALL-DONE / TEST-FAIL
 */
public class I18nTestMIDlet extends MIDlet {

    public I18nTestMIDlet() {
    }

    public void startApp() {
        try {
            // 1) GBK 解码：0xD6D0=中 0xCEC4=文；输出码点（20013=中 25991=文）
            byte[] gbk = new byte[]{(byte) 0xD6, (byte) 0xD0, (byte) 0xCE, (byte) 0xC4, 'O', 'K'};
            String s = new String(gbk, "GBK");
            System.out.println("GBK-TEST:codes=" + (int) s.charAt(0) + "," + (int) s.charAt(1)
                    + "," + (int) s.charAt(2) + "," + (int) s.charAt(3) + ",len=" + s.length());

            // 2) GBK 编码回环：中文 -> GBK 字节 -> 长度
            String src = "中文测试";
            byte[] enc = src.getBytes("GBK");
            System.out.println("GBK-ENC:len=" + enc.length + " first=" + (enc[0] & 0xff) + "," + (enc[1] & 0xff));

            // 3) StringBuilder（我们 jar 原本没有此类）
            StringBuilder sb = new StringBuilder();
            sb.append("SB:").append(123).append('-').append(true).append('-').append(4.5);
            System.out.println(sb.toString());

            // 4) LayerManager（我们 jar 原本没有此类）
            LayerManager lm = new LayerManager();
            lm.setViewWindow(0, 0, 176, 220);
            System.out.println("LM-TEST:size=" + lm.getSize() + " view=" + 176 + "x" + 220);

            System.out.println("ALL-DONE");
        } catch (Throwable t) {
            System.out.println("TEST-FAIL: " + t);
            t.printStackTrace();
        }
        notifyDestroyed();
    }

    public void pauseApp() {
    }

    public void destroyApp(boolean unconditional) {
    }
}
