# 游戏内文本输入测试包（texttest.jar / textok.jar）

这个目录是**验证"游戏需要打字时自动弹出键盘、并且游戏能拿到打进去的字"**这条链路的测试 MIDlet。
两个包分工不同：

| 包 | 源文件 | 覆盖什么 |
|---|---|---|
| `texttest.jar` | `TextTest.java` | 注入链路：Form+TextField 与 TextBox 各来一遍，**定时器**读 `getString()` |
| `textok.jar` | `TextOkTest.java` | 完整取名流程：Canvas → 取名 Form（OK/BACK 命令）→ 注入 → **派发 ZR 触发游戏自己的"确定"** → `commandAction` 里读 `getString()` |

⚠️ 为什么要第二个包：`texttest.jar` 是定时器读值，**从不走按键**，所以"软键触发不了 LCDUI 命令"
（2026-09-23 perfZ5 的真凶，见 `PERF-修复记录-perfA-perfB.md` §22）它一直测不到。

## textok.jar：游戏取名端到端（推荐用它验收）

```powershell
node tools/test-text-ok.mjs          # 默认注入"阿凡达"
node tools/test-text-ok.mjs 萧煜      # 也可指定文字
```

期望（修好后）：

```
[textinput] 检测到文本框 nativeId=2 constraints=0
[textinput] 已注入文本：3 字
[textinput] 已写入 Form 里的 TextField，3 字      ← Java 侧确认（中文可读）
[input] [cmd] soft-right → 触发 LCDUI ok 命令      ← ZR 触发了命令
[textok] OK 触发 len=3 codes=963f,51e1,8fbe       ← 游戏 commandAction 里 getString() 的结果
[textok] 名字被接受
结果: 全部通过 ✔
```

`codes=` 是逐字符码点（`963f,51e1,8fbe` = 阿凡达），用十六进制报值是为了不受日志编码影响。
实机验收：`textok.jar` 拷到 `sdmc:/switch/java/` → 游戏列表里选 TextOkTest →
键盘里选字 → **按 ZR = 触发"确定"** → 日志同上。

## texttest.jar：注入链路（定时器版）

## 它做什么

```java
TextBox tb = new TextBox("请输入名字", "", 16, TextField.ANY);
display.setCurrent(tb);                      // 显示文本框
// 3 秒后自动打印内容并退出（免去按软键）
System.out.println("[texttest] getString=" + tb.getString());
```

## 怎么在 Switch 上用

1. 把 `texttest.jar` 拷到 `sdmc:/switch/java/`（和其它游戏 jar 放一起）；
2. 启动 j2me-nx-port，在游戏列表里选 **TextTest**；
3. 进入后应当**自动弹出 Switch 系统键盘**（不需要按任何键）；
4. 输入几个字 → 按「确定」；
5. 约 3 秒后它会把文本打进日志并退出到菜单。

期望日志（`sdmc:/switch/j2me-nx/error.log`）：

```
[textinput] 检测到文本框 nativeId=… constraints=0
[textinput] 已弹出系统键盘（nativeId=…）
[textinput] 键盘关闭（确定）
[textinput] 已注入文本：N 字
[texttest] getString=<你输入的内容> (长度 N)
```

## 怎么在电脑上跑（不用真机）

```powershell
$env:J2ME_TEST_JAR="$PWD\tools\textinput-test\texttest.jar"
$env:J2ME_TEST_TEXT="Hello世界"      # 仿真里不弹键盘，直接把这段文字注入
node tools/simulate.mjs
# 期望看到：[texttest] getString=Hello世界 (长度 7)
```

## 重新编译

```powershell
$jdk="$env:JAVA_HOME\bin"          # 或改成你的 JDK 8 安装目录下的 bin，或用 $env:JDK_BIN
$env:Path="$jdk;$env:Path"
cd tools\textinput-test
javac -nowarn -Xlint:none -source 1.3 -target 1.3 -cp ..\..\java\classes.jar TextTest.java
jar cfm texttest.jar MANIFEST.MF TextTest.class 'TextTest$1.class'   # 别漏内部类
```

## 实现要点（出问题时查这里）

| 环节 | 位置 | 说明 |
|---|---|---|
| 触发 | `vendor/pluotsorbet/midp/gfx.js` 的 `TextFieldLFImpl.createNativeResource0` | Java 建文本框控件时回调 `__hostTextInput()`；LCDUI 里 TextBox 就是 Form+TextField |
| 宿主 | `app/main.js` 的 `hostTextInput()` / `openKbOverlay()` | 弹宿主内置古风软键盘（触摸或手柄导航），确定后注入；取消则冷却 30s。仿真里走 `J2ME_TEST_TEXT` 自动注入 |
| 注入 | `vendor/pluotsorbet/midp/midp.js` 的 `window.__sendInputMethodText(text)` | 原生事件 `{type: KEY_EVENT, intParam1: 4(EventConstants.IME), stringParam1: text}` |
| 落地 | `java/custom/…/lcdui/Display.java` 的 `handleInputMethodEvent` | ⚠️ 上游写的是 `current instanceof TextBox`，本移植里 `current` 是 **DisplayableLF**（TextBox 的 LF 是 FormLFImpl），那句**永远为假** → 已改成先 `current.lGetDisplayable()` 再判断 |
| 游戏读值 | 游戏自己的 `CommandListener.commandAction` | ⚠️ 上游这套要靠 **ZL/ZR 触发 COMMAND_EVENT**；本移植的 DOM 垫片让 gfx.js 的命令 onclick 挂到了 `#displayable-N .button0/.button1`，宿主软键却点 `#header-ok-button`/`#back-button` → ZL/ZR 曾是死键（§22.3）→ 已加 `g.__lcdInvokeCommand()` 直通 |

编译 `TextOkTest.java` 时 **`-encoding UTF-8` 必须带**：中文 Windows 上 javac 默认按 GBK 读
UTF-8 源码，中文字面量会在 class 里烂掉（实测过，见 `PERF-修复记录-perfA-perfB.md` §22.4）。
