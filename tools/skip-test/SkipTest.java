/*
 * SkipTest.java — 资源流 skip/read 语义 + 快进性能回归（perfZ22）
 *
 * 由来（2026-09-24 实机）：重装机兵2-火线突击"进图卡住"。实机采样榜
 *   [hot-top10] java/io/InputStream.skip=22% + com/sun/cldc/io/ResourceInputStream.read=19%
 * 且 [vm-sample] 抓到当次调用的 locals[1]=0xfaca —— **一次 skip 要跳过 64202 字节**。
 * 根因：ResourceInputStream 没覆盖 skip()，继承 InputStream.skip 的**逐字节**实现，
 * 而每次 read() 都是一次 JS native 调用 → 6.4 万次调用才跳过一个记录；游戏从 .rc
 * 包里按偏移取图，整个地图的资源加载从秒级退化到分钟级（玩家看到的就是卡死）。
 *
 * 本 MIDlet 就是那条链的最小复现：从自己的 jar 里开资源流 → skip → read。
 * 断言：语义（返回值/EOF/n<=0/mark-reset/bulk read 一致性）+ 大 skip 的耗时。
 *
 * 标记行（tools/test-skipfast.mjs 解析）：
 *   T1..T6 逐项 ok=true/false，T7 打印耗时，T8 打印 skip+read 交替走完全程的校验和。
 */
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;

import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Display;
import javax.microedition.lcdui.Graphics;
import javax.microedition.midlet.MIDlet;

public class SkipTest extends MIDlet {
    private static final int SIZE = 512 * 1024;   // big.bin 的字节数（build.mjs 生成）

    protected void startApp() {
        try {
            run();
        } catch (Throwable t) {
            System.out.println("TEST-FAIL:" + t);
        }
        System.out.println("ALL-DONE");
        try { notifyDestroyed(); } catch (Throwable t) { /* 忽略 */ }
    }

    protected void pauseApp() { }
    protected void destroyApp(boolean unconditional) { }

    private InputStream open() throws IOException {
        InputStream in = getClass().getResourceAsStream("/big.bin");
        if (in == null) {
            throw new IOException("jar 里没有 /big.bin");
        }
        return in;
    }

    private void run() throws IOException {
        // T0：证明这条链真的走的是 com.sun.cldc.io.ResourceInputStream（被修的那个类）。
        //     早期版本靠"日志里出现 ResourceInputStream"来判，脆弱且会假绿/假红；
        //     直接在 Java 里把流类名打出来，稳定可断言。
        InputStream in0 = open();
        System.out.println("T0:stream=" + in0.getClass().getName());
        in0.close();

        // T1/T2：基本语义 —— 跳过 K 字节后读到的必须是第 K 个字节（模式 i&0xFF）
        InputStream in = open();
        long s1 = in.skip(1000);
        int b1 = in.read();
        System.out.println("T1:skip=" + s1 + " next=" + b1 + " expect=" + (1000 & 0xFF) +
            " ok=" + (s1 == 1000 && b1 == (1000 & 0xFF)));
        long s2 = in.skip(200000);
        int b2 = in.read();
        // 注意：T1 末尾那次 read() 已经把游标推到 1001，所以这里读到的应是第 201001 字节
        System.out.println("T2:skip=" + s2 + " next=" + b2 + " expect=" + (201001 & 0xFF) +
            " ok=" + (s2 == 200000 && b2 == (201001 & 0xFF)));
        in.close();

        // T3：skip 之后的批量 read(byte[],int,int) 仍要对齐
        in = open();
        in.skip(4096);
        byte[] buf = new byte[64];
        int got = in.read(buf, 0, 64);
        boolean ok3 = (got == 64);
        for (int i = 0; i < 64 && ok3; i++) {
            if (buf[i] != (byte) ((4096 + i) & 0xFF)) {
                ok3 = false;
            }
        }
        System.out.println("T3:got=" + got + " ok=" + ok3);
        in.close();

        // T4：跳过流尾 —— 只能跳到尾，之后 read() = -1
        in = open();
        long s4 = in.skip(SIZE + 100000L);
        int r4 = in.read();
        System.out.println("T4:skip=" + s4 + " read=" + r4 +
            " ok=" + (s4 == SIZE && r4 == -1));
        in.close();

        // T5：n<=0 一律 0，且不动游标
        in = open();
        long s5 = in.skip(0);
        long s6 = in.skip(-5);
        int r5 = in.read();
        System.out.println("T5:zero=" + s5 + " neg=" + s6 + " next=" + r5 +
            " ok=" + (s5 == 0 && s6 == 0 && r5 == 0));
        in.close();

        // T6：mark/reset（perfZ22 把 native clone 改成共享 data，reset 语义必须不变）
        in = open();
        in.skip(500);
        in.mark(1000);
        in.skip(100);              // 游标 600
        in.reset();                // 回到 500
        int r6a = in.read();       // 500
        int r6b = in.read();       // 501
        System.out.println("T6:mark=" + r6a + " next=" + r6b +
            " ok=" + (r6a == (500 & 0xFF) && r6b == (501 & 0xFF)));
        in.close();

        // T7：大 skip 耗时。逐字节实现 = 50 万次 native 调用（实机上秒级）。
        in = open();
        long t0 = System.currentTimeMillis();
        long s7 = in.skip(500000);
        long dt7 = System.currentTimeMillis() - t0;
        long t1 = System.currentTimeMillis();
        long s7b = in.skip(1000);      // 暖过之后再来一次小的
        long dt7b = System.currentTimeMillis() - t1;
        System.out.println("T7:big=" + dt7 + "ms small=" + dt7b + "ms skip=" + s7 + "/" + s7b);
        in.close();

        // T8：skip 与 read 交替走完全程 —— 只要有一处"跳过头/跳不够"，校验和立刻不对。
        //     期望值由 runner 用同一算法在 JS 侧算一遍（模式 i&0xFF）。
        in = open();
        int pos = 0, sum = 0;
        while (pos < SIZE) {
            long sk = in.skip(997);
            if (sk <= 0) {
                break;
            }
            pos += (int) sk;
            if (pos >= SIZE) {
                break;
            }
            int v = in.read();
            if (v < 0) {
                break;
            }
            sum = (sum + v) & 0xFFFF;
            pos++;
        }
        System.out.println("T8:pos=" + pos + " sum=" + sum);
        in.close();

        // T9：DataInputStream 基元读取（perfZ24 起改成"一次批量读"）。
        // 旧实现里每个基元 = **每字节一次 native 调用**：readShort 2 次、readInt 4 次、
        // readLong 8 次 —— 数据表型游戏（从 .rc 包里读记录）入口那几秒就是这么堆出来的。
        in = open();
        DataInputStream din = new DataInputStream(in);
        int v1 = din.readUnsignedShort();      // 字节 0..1  = 00 01
        int v2 = din.readInt();                // 字节 2..5  = 02 03 04 05
        int v3 = din.readUnsignedByte();       // 字节 6     = 06
        long v4 = din.readLong();              // 字节 7..14 = 07 08 09 0A 0B 0C 0D 0E
        int v5 = din.readShort();              // 字节 15..16= 0F 10（有符号）
        System.out.println("T9:vals=" + v1 + "," + v2 + "," + v3 + "," + v4 + "," + v5);
        int n9 = 200000;
        long t9 = System.currentTimeMillis();
        int sum9 = 0;
        for (int i = 0; i < n9; i++) {
            sum9 = (sum9 + din.readUnsignedShort()) & 0xFFFF;
        }
        long dt9 = System.currentTimeMillis() - t9;
        System.out.println("T9:time=" + dt9 + "ms n=" + n9 + " sum=" + sum9);
        in.close();

        // T10：流尾只剩 1 字节时 readShort 必须抛 EOFException —— 批量读不能把这条语义丢了
        in = open();
        in.skip(SIZE - 1);
        boolean eofOk = false;
        try {
            din = new DataInputStream(in);
            din.readShort();
        } catch (EOFException eEof) {
            eofOk = true;
        }
        System.out.println("T10:eof=" + eofOk);
        in.close();

        // T11：**同一次运行内**对比两种基元读法，用来决定"要不要把基元批量化"：
        //   batch   = DataInputStream.readInt()（本版实现：一次 read(b,0,4)）
        //   bytewise= 自己用 4 次 in.read() 拼（= 旧实现的等价物）
        // 只看桌面仿真不够：两边都是"解释执行 + JS native 调用"，比值才是可迁移的结论。
        int n11 = 100000;
        in = open();
        din = new DataInputStream(in);
        long tA0 = System.currentTimeMillis();
        int sA = 0;
        for (int i = 0; i < n11; i++) {
            sA += din.readInt();
        }
        long tA = System.currentTimeMillis() - tA0;
        in.close();

        in = open();
        long tB0 = System.currentTimeMillis();
        int sB = 0;
        for (int i = 0; i < n11; i++) {
            int a1 = in.read();
            int a2 = in.read();
            int a3 = in.read();
            int a4 = in.read();
            sB += ((a1 & 0xFF) << 24) | ((a2 & 0xFF) << 16) | ((a3 & 0xFF) << 8) | (a4 & 0xFF);
        }
        long tB = System.currentTimeMillis() - tB0;
        in.close();
        System.out.println("T11:batch=" + tA + "ms bytewise=" + tB + "ms sum=" + sA + "/" + sB);

        // T12：大量"正常控制流"的 Java 异常 —— 验证 [jit-trap] 落盘被限流。
        // 背景：解释器 catch 到 JS 级异常时会 __sdMark（**同步写卡**）两条；而游戏里
        // "读越界/资源不存在 → catch" 是极常见的正常流程（实机 AHQSL 启动一分钟 30 条）。
        // 这里制造 200 次 EOFException，runner 数日志里新增的 [jit-trap] 行数。
        int n12 = 200;
        in = open();
        in.skip(SIZE);
        din = new DataInputStream(in);
        int caught = 0;
        for (int i = 0; i < n12; i++) {
            try {
                din.readByte();
            } catch (EOFException eEx) {
                caught++;
            }
        }
        in.close();
        System.out.println("T12:caught=" + caught + "/" + n12);

        // 面板只是为了不让 Display 空转（与其它测试 MIDlet 一致）
        try {
            Display.getDisplay(this).setCurrent(new MainCanvas());
        } catch (Throwable t) { /* 不关心 */ }
    }

    static class MainCanvas extends Canvas {
        protected void paint(Graphics g) {
            g.setColor(0xFFFFFF);
            g.fillRect(0, 0, getWidth(), getHeight());
        }
    }
}
