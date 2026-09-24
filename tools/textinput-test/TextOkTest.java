/*
 * TextOkTest.java — "游戏取名"端到端回归 MIDlet（照抄 1.jar g.class 取名流程）
 *
 * 为什么要有它：2026-09-23 实机发现"内置软键盘能打字、但按游戏自己的 OK 读不到"。
 * 根因不是文本没进模型，而是**宿主软键（ZL/ZR）永远触发不了 LCDUI 的 Command**
 * （见 src/host/switch-input.js fireSoftButton 与 vendor gfx.js updateCommands 的补丁注释）。
 * 之前 tools/textinput-test/TextTest.java 是**定时器**读 getString()，从来不走按键 → 
 * 这个缺口一直没被测到，所以这里补一条真正按键确认的用例。
 *
 * 复刻的 g.class 取名流程（反汇编 D:\新建文件夹\1.jar 得到）：
 *   <init>:  Command("返回", BACK, 0) / Command("确定", OK, 0)
 *   选"新建角色": new Form("新建角色") + new TextField("输入玩家名字:", "", 6, ANY)
 *               append(TextField) append(StringItem) addCommand(OK) addCommand(BACK)
 *               setCommandListener(this) display.setCurrent(Form)
 *   commandAction: if (c == 确定) { s = textField.getString(); if (s.trim().length() <= 0) return; 接受 }
 *
 * 期望日志（宿主软键 ZR = 右软键）：
 *   [textok] 已显示 Canvas
 *   [textok] 已显示取名 Form
 *   [textok] OK 触发 len=3 codes=963F,51E1,8FBE      ← 3 字 = 阿凡达
 *   [textok] 名字被接受
 *
 * 编译（-encoding UTF-8 必须带，否则中文字面量在 class 里就烂了）：
 *   javac -encoding UTF-8 -nowarn -source 1.3 -target 1.3 -bootclasspath "" -cp java/classes.jar TextOkTest.java
 * 打包：
 *   jar cfm textok.jar MANIFEST.MF TextOkTest.class 'TextOkTest$1.class'
 * 运行：
 *   node tools/test-text-ok.mjs
 */
import javax.microedition.midlet.MIDlet;
import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Command;
import javax.microedition.lcdui.CommandListener;
import javax.microedition.lcdui.Display;
import javax.microedition.lcdui.Displayable;
import javax.microedition.lcdui.Form;
import javax.microedition.lcdui.Graphics;
import javax.microedition.lcdui.StringItem;
import javax.microedition.lcdui.TextField;

public class TextOkTest extends MIDlet implements CommandListener {

    private Display display;
    private Form form;
    private TextField field;
    private StringItem hint;

    // 与 g.class 完全一致：先 addCommand(确定)，再 addCommand(返回)
    private final Command okCommand   = new Command("确定", Command.OK,   0);
    private final Command backCommand = new Command("返回", Command.BACK, 0);

    public TextOkTest() {
        display = Display.getDisplay(this);
    }

    public void startApp() {
        // 主界面是 Canvas（和游戏一样：取名 Form 是从 Canvas 里 setCurrent 上去的）
        display.setCurrent(new MainCanvas());
        System.out.println("[textok] 已显示 Canvas");
        showNamingForm();
    }

    private void showNamingForm() {
        form = new Form("新建角色");
        field = new TextField("输入玩家名字:", "", 6, TextField.ANY);
        hint = new StringItem("", "");
        form.append(field);
        form.append(hint);
        form.addCommand(okCommand);
        form.addCommand(backCommand);
        form.setCommandListener(this);
        display.setCurrent(form);
        System.out.println("[textok] 已显示取名 Form");
    }

    /** 逐字符打码点（纯 ASCII 输出，仿真/实机日志都不会被编码问题骗到）。 */
    private static String codes(String s) {
        StringBuffer sb = new StringBuffer();
        for (int i = 0; i < s.length(); i++) {
            if (i > 0) sb.append(',');
            sb.append(Integer.toHexString(s.charAt(i)));
        }
        return sb.toString();
    }

    public void commandAction(Command c, Displayable d) {
        if (c == okCommand) {
            String s = field.getString();
            System.out.println("[textok] OK 触发 len=" + s.length() + " codes=" + codes(s));
            if (s.trim().length() > 0) {
                System.out.println("[textok] 名字被接受");
            } else {
                System.out.println("[textok] 名字为空 -> 游戏会当作没输入（取名失败）");
            }
        } else {
            System.out.println("[textok] 返回 命令触发");
        }
    }

    public void pauseApp() { }

    public void destroyApp(boolean unconditional) { }

    /** 主界面 Canvas：只为"游戏是 Canvas + 弹出 Form"这条结构兜底。 */
    class MainCanvas extends Canvas {
        public void paint(Graphics g) {
            g.setColor(0x000000);
            g.fillRect(0, 0, getWidth(), getHeight());
            g.setColor(0xFFFFFF);
            g.drawString("naming test", 4, 4, Graphics.TOP | Graphics.LEFT);
        }
    }
}
