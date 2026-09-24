/*
 * TextTest.java — 文本输入端到端测试 MIDlet（两种界面各来一遍）
 *
 * 覆盖 j2me-nx-port 的"游戏内文本输入"两条落地路径：
 *   ① TextBox                （D:\新建文件夹\1.jar 的 b.class 这种）
 *   ② Form + TextField       （同一个 jar 的 g.class 这种 → 上游只处理 TextBox，
 *                              我们补了 Form 分支）
 *
 * 编译（沿用 tools/build-classes.mjs 的 javac 参数）：
 *   javac -nowarn -Xlint:none -source 1.3 -target 1.3 -cp java/classes.jar TextTest.java
 * 打包（⚠️ 别漏内部类）：
 *   jar cfm texttest.jar MANIFEST.MF TextTest.class 'TextTest$1.class' 'TextTest$2.class'
 * 运行：
 *   $env:J2ME_TEST_JAR='<绝对路径>\texttest.jar'; $env:J2ME_TEST_TEXT='阿凡达'
 *   node tools/simulate.mjs
 *
 * 期望日志：
 *   [texttest] 已显示 Form+TextField
 *   [textinput] 已注入文本：3 字
 *   [texttest] Form 收到=阿凡达
 *   [texttest] 已显示 TextBox
 *   [texttest] TextBox 收到=阿凡达
 */
import javax.microedition.midlet.MIDlet;
import javax.microedition.lcdui.Command;
import javax.microedition.lcdui.CommandListener;
import javax.microedition.lcdui.Display;
import javax.microedition.lcdui.Displayable;
import javax.microedition.lcdui.Form;
import javax.microedition.lcdui.TextBox;
import javax.microedition.lcdui.TextField;

public class TextTest extends MIDlet implements CommandListener {

    private Display display;
    private TextBox textBox;
    private Form form;
    private TextField field;
    private final Command okCommand = new Command("确定", Command.OK, 1);

    public TextTest() {
        display = Display.getDisplay(this);
    }

    public void startApp() {
        // ① 先测 Form + TextField（带一个默认值，验证是"整体替换"而不是拼接）
        form = new Form("请输入名字");
        field = new TextField("名字", "默认名", 16, TextField.ANY);
        form.append(field);
        form.addCommand(okCommand);
        form.setCommandListener(this);
        display.setCurrent(form);
        System.out.println("[texttest] 已显示 Form+TextField");
        scheduleReport(1, 3000);
    }

    private void scheduleReport(final int stage, final long delayMs) {
        new Thread(new Runnable() {
            public void run() {
                try { Thread.sleep(delayMs); } catch (InterruptedException e) { }
                if (stage == 1) {
                    System.out.println("[texttest] Form 收到=" + field.getString());
                    // ② 再测 TextBox
                    textBox = new TextBox("请输入名字", "默认名", 16, TextField.ANY);
                    textBox.addCommand(okCommand);
                    textBox.setCommandListener(TextTest.this);
                    display.setCurrent(textBox);
                    System.out.println("[texttest] 已显示 TextBox");
                    scheduleReport(2, 3000);
                } else {
                    System.out.println("[texttest] TextBox 收到=" + textBox.getString());
                    notifyDestroyed();
                }
            }
        }).start();
    }

    public void pauseApp() {
    }

    public void destroyApp(boolean unconditional) {
    }

    public void commandAction(Command c, Displayable d) {
        System.out.println("[texttest] 命令触发：" + c.getLabel());
    }
}
