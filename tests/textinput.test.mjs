/*
 * 游戏内文本输入（LCDUI 文本框 + 系统键盘）回归测试 —— 2026-09-23 perfW
 *
 * 需求：游戏需要打字时自动弹出系统键盘，打完的字进到游戏的文本框。
 *
 * 链路（三处钩子，缺一不可）：
 *   ① 触发：gfx.js 的 TextFieldLFImpl.createNativeResource0（Java 建控件时调用）
 *           → globalThis.__hostTextInput()
 *   ② 注入：midp.js 的 window.__sendInputMethodText(text)
 *           → 原生事件 {type: KEY_EVENT, intParam1: 4(EventConstants.IME), stringParam1}
 *   ③ 落地：Java 的 DisplayEventConsumerImpl.handleInputMethodEvent(String)
 *           → 当前 TextBox.insert()
 *
 * ⚠️ 本轮踩到的真坑（写在这里防止复发）：上游那句 `current instanceof TextBox`
 * 在本移植里**永远为假**——Display.current 是 DisplayableLF（TextBox 的 LF 是
 * FormLFImpl），所以文字到 Java 就断了。修法：先 current.lGetDisplayable() 再判断。
 * 端到端验证靠 tools/textinput-test/（javac 编一个显示 TextBox 的 MIDlet，
 * J2ME_TEST_JAR + J2ME_TEST_TEXT 跑 tools/simulate.mjs，看 getString= 那行）。
 *
 * 运行：node tests/textinput.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const gfx = readFileSync(join(root, 'vendor/pluotsorbet/midp/gfx.js'), 'utf8');
const midp = readFileSync(join(root, 'vendor/pluotsorbet/midp/midp.js'), 'utf8');
const mainSrc = readFileSync(join(root, 'app/main.js'), 'utf8');
const displayJava = readFileSync(join(root, 'java/custom/javax/microedition/lcdui/Display.java'), 'utf8');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

// ---- ① 触发钩子（gfx.js） ----
{
  check('TextFieldLFImpl 钩子存在', gfx.indexOf('TextFieldLFImpl.createNativeResource0.(') > 0, true);
  check('钩子回调 __hostTextInput', /__hostTextInput/.test(gfx), true);
  check('钩子仍返回 nativeId（不能破坏原有控件流程）', /return nextMidpDisplayableId\+\+;/.test(gfx), true);
  check('钩子里有 try/catch（通知失败不影响控件）', /通知失败绝不影响控件创建/.test(gfx), true);
  check('钩子里不再是无脑 not implemented',
    /TextFieldLFImpl\.createNativeResource0\.[^"]*not implemented/.test(gfx), false);
}

// ---- ② 注入钩子（midp.js） ----
{
  check('导出 __sendInputMethodText', midp.indexOf('window.__sendInputMethodText = sendInputMethodText;') > 0, true);
  check('用 KEY_EVENT 事件类型', /function sendInputMethodText[\s\S]{0,400}type: KEY_EVENT/.test(midp), true);
  check('intParam1 = 4（EventConstants.IME）', /function sendInputMethodText[\s\S]{0,400}intParam1: 4/.test(midp), true);
  check('文字走 stringParam1', /function sendInputMethodText[\s\S]{0,400}stringParam1: String\(text\)/.test(midp), true);
}

// ---- ③ Java 侧落地（custom Display.java 覆盖） ----
{
  check('handleInputMethodEvent 存在', displayJava.indexOf('handleInputMethodEvent') > 0, true);
  check('已改成先取 Displayable（lGetDisplayable）',
    /handleInputMethodEvent[\s\S]{0,900}current\.lGetDisplayable\(\)/.test(displayJava), true);
  check('不再直接 current instanceof TextBox',
    /if \(current instanceof TextBox\)/.test(displayJava), false);
  check('保留写回文本框的调用（整体替换 setString）',
    /handleInputMethodEvent[\s\S]{0,4000}textBoxCopy\.setString\(inputText\)/.test(displayJava), true);
  check('Form+TextField 也走同一通道（上游只处理 TextBox）',
    /handleInputMethodEvent[\s\S]{0,4000}fieldCopy\.setString\(inputText\)/.test(displayJava), true);
  check('Form 分支存在（cur instanceof Form）',
    /handleInputMethodEvent[\s\S]{0,4000}cur instanceof Form/.test(displayJava), true);
  check('取不到可写文本框时打日志（便于定位）',
    /当前界面没有可写的文本框/.test(displayJava), true);
  check('不再用 insert（避免"默认名+输入"拼接）',
    /handleInputMethodEvent[\s\S]{0,4000}\.insert\(inputText/.test(displayJava), false);
  check('有 PATCH 说明（防后人改回去）', /PATCH\(j2me-nx-port 2026-09-23\)[\s\S]{0,600}handleInputMethodEvent|handleInputMethodEvent[\s\S]{0,300}PATCH\(j2me-nx-port 2026-09-23\)/.test(displayJava), true);
  check('没有残留调试打印', displayJava.indexOf('[dbg-ime]') < 0, true);
}

// ---- 宿主行为（app/main.js） ----
{
  check('安装 g.__hostTextInput', /g\.__hostTextInput = hostTextInput;/.test(mainSrc), true);
  check('只在游戏内响应', /function hostTextInput[\s\S]{0,600}if \(!g\.__gameRunning\)/.test(mainSrc), true);
  check('键盘显示中不重复弹', /textInputActive.*\{ sdLog\('\[textinput\] 键盘已显示/.test(mainSrc) ||
    /if \(textInputActive\)/.test(mainSrc), true);
  check('取消后冷却（避免反复弹）', /textInputCoolUntil = Date.now\(\) \+ 30000/.test(mainSrc), true);
  check('用系统键盘 virtualKeyboard', /navigator\.virtualKeyboard/.test(mainSrc), true);
  check('提交后注入 MIDlet', /function injectTextToMidlet[\s\S]{0,400}g\.__sendInputMethodText\(text\)/.test(mainSrc), true);
  check('仿真钩子 J2ME_TEST_TEXT', /J2ME_TEST_TEXT/.test(mainSrc), true);
  check('系统键盘不可用时有明确日志', mainSrc.indexOf('游戏内打字需要真机 nx.js 的 virtualKeyboard') > 0, true);
}

// ---- ④ 软键（ZL/ZR）→ LCDUI Command 直通（2026-09-23 perfZ5） ----
// 这一节是"取名打得进字、按游戏自己的确定却读不到"的防复发断言。
// 真凶：本移植的 DOM 垫片 getElementById 对任意 id 都返回自动创建的元素（永远 truthy），
// 于是 gfx.js 的 updateCommands 里 `if (el)` 分支恒真 —— 命令 onclick 挂在
// #displayable-N 的 .button0/.button1 上，而宿主软键点的是 #header-ok-button /
// #back-button（那两个 onclick 只在永远不会执行的 else 分支里赋值）。ZL/ZR 于是对
// **所有** Command 界面都无效，游戏 handler 根本不执行，自然"读不到"已经写进模型的名字。
{
  const inputJs = readFileSync(join(root, 'src/host/switch-input.js'), 'utf8');
  check('gfx.js 暴露软键直通入口', /__lcdInvokeCommand/.test(gfx), true);
  check('gfx.js 暴露命令表（诊断用）', /__lcdCommands/.test(gfx), true);
  check('gfx.js 记下当前界面的命令表', /lcdCommands = validCommands\.slice\(0\)/.test(gfx), true);
  check('gfx.js 无命令界面会清空命令表（防止留着上一个界面的命令）',
    /numItemCommands !== 0[\s\S]{0,600}lcdCommands = \[\];/.test(gfx), true);
  check('gfx.js 的 OK/BACK 选择语义（type 优先，再按优先级兜底）',
    /function lcdPickCommand[\s\S]{0,900}Wanted|function lcdPickCommand[\s\S]{0,900}BACK/.test(gfx), true);
  check('gfx.js 补挂 header/back 按钮 onclick（DOM 回落路径不再空点）',
    /headerBtnFallback[\s\S]{0,400}onclick/.test(gfx), true);
  check('输入层软键优先走直通（不再只依赖 DOM click）',
    /function fireSoftButton[\s\S]{0,1200}__lcdInvokeCommand/.test(inputJs), true);
  check('输入层直通失败仍有 DOM 回落', /function fireSoftButton[\s\S]{0,2000}dispatchEvent\(ev\)/.test(inputJs), true);
  check('输入层软键仍发 MIDP 键码（Canvas 游戏不受影响）',
    /var code = softCode\(which\);\s*\n\s*sendCode\(code, down\);/.test(inputJs), true);
}

// ---- ⑤ javac 编码：class 里的中文诊断字面量不能是乱码（2026-09-23 perfZ5） ----
// 事故：build-classes.mjs 没写 -encoding，中文 Windows 上 javac 按 GBK 解码 UTF-8 源码，
// "后"(E5 90 8E) 变成 "钥"+U+FFFD —— class 里中文全烂。后果是实机日志里
// "[textinput] 当前界面没有可写的文本框" 变成 "褰撳墠鐣岄潰..."，按中文关键字搜不到，
// 直接误判成"补丁没走这个分支"，白跑一轮实机。这里从**源文件**与**构建脚本**两头钉死。
{
  const buildClasses = readFileSync(join(root, 'tools/build-classes.mjs'), 'utf8');
  check('build-classes.mjs 用 -encoding UTF-8 编译', /javac\.exe" -encoding UTF-8/.test(buildClasses), true);
  check('build-classes.mjs 有中文编码终验项', /没有可写的文本框/.test(buildClasses), true);
  check('中文终验查的是 class 字节（javap 输出按控制台代码页转码，不可靠）',
    /hasUtf8Literal|Buffer\.from\(s, 'utf8'\)/.test(buildClasses), true);
  check('终验反汇编的是内部类（补丁在 Display$DisplayEventConsumerImpl 里）',
    /Display\$DisplayEventConsumerImpl\.class/.test(buildClasses), true);
  // 源码里必须有中文（防止有人为了"避免乱码"把诊断改成拼音 —— 那样日志就不好用了）
  check('诊断仍用中文（不因编码问题退化成 ASCII）', /当前界面没有可写的文本框/.test(displayJava), true);
}

// ---- ⑥ 端到端按键确认测试存在（tools/test-text-ok.mjs） ----
// 旧的 TextTest.java 是**定时器**读 getString()，从来不走按键，所以④那个坑一直没被测到。
{
  const e2e = join(root, 'tools/test-text-ok.mjs');
  check('端到端按键确认测试存在', existsSync(e2e), true);
  if (existsSync(e2e)) {
    const src = readFileSync(e2e, 'utf8');
    check('端到端测试会派发软键（ZR/右软键）', /__dispatchKey\('soft-right'/.test(src), true);
    check('端到端测试断言"ZR 触发了确定命令"', /ZR 触发了游戏的确定命令/.test(src), true);
  }
  check('取名流程测试 MIDlet 存在', existsSync(join(root, 'tools/textinput-test/TextOkTest.java')), true);
}

// ---- 打包一致性：romfs 里的 classes.jar 必须就是 data/java 那份（补丁要进包） ----
{
  const a = join(root, 'data/java/classes.jar');
  const b = join(root, 'romfs/java/classes.jar');
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();
  if (existsSync(b)) check('romfs/java/classes.jar 与 data/java 一致', sha(a) === sha(b), true);
  else check('romfs/java/classes.jar 存在（打包后才有）', existsSync(b), true);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
