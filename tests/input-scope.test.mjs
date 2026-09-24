/*
 * 按键映射"作用范围"回归测试（2026-09-23 用户要求）
 *
 * 规则：自定义映射**只在游戏运行时生效**（g.__gameRunning === true）。
 * 没进游戏之前，宿主菜单键必须完全不受映射影响：
 *   Y=游戏菜单  X=分辨率  A=确认  B=返回  L/R=翻页  +=退出
 * main.js 的菜单轮询直接读物理按钮索引（dn(0/1/2/3/4/5/12/13)），
 * 而 switch-input.js 侧另有一道 __gameRunning 硬闸兜底——本测试把
 * 这两条都钉住：
 *   A 组：硬闸行为（门关着不发键、门开了才发、开门瞬间不补假边沿、+ 不开门不回调）
 *   B 组：宿主菜单轮询源码里不出现 __keyMap（改映射改不动菜单键）
 *
 * 运行：node tests/input-scope.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'src/host/switch-input.js'), 'utf8');
const mainSrc = readFileSync(join(root, 'app/main.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

// ---- 手柄仿真：可手动驱动的一帧 ----
function makeHarness() {
  const sent = [];          // [键码, down]
  const quit = [];          // __requestGameQuit 调用记录
  const logs = [];
  const timers = [];
  const buttons = new Array(16).fill(false);
  const pad = {
    connected: true, id: 'fake pad', mapping: 'standard', axes: [0, 0, 0, 0],
    get buttons() { return buttons.map(p => ({ pressed: p, value: p ? 1 : 0 })); },
  };
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    navigator: { getGamepads: () => [pad] },
    requestAnimationFrame: () => 0,
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    setTimeout: () => 0,
    Event: class { constructor(t) { this.type = t; } },
    dispatchEvent: () => true,
    __sdLog: (l) => { logs.push(String(l)); },
    __sendKeyPress: (c) => { sent.push([c, true]); },
    __sendKeyRelease: (c) => { sent.push([c, false]); },
    __requestGameQuit: (why) => { quit.push(why); },
    __keyMap: undefined,
  };
  sandbox.globalThis = sandbox;
  const realGlobal = globalThis;
  // 在沙箱里求值（switch-input.js 是 IIFE，只依赖 globalThis 上的东西）
  const fn = new Function('globalThis', 'navigator', 'console', 'requestAnimationFrame',
    'setInterval', 'setTimeout', 'Event', 'dispatchEvent', 'Switch', src);
  fn.call(sandbox, sandbox, sandbox.navigator, sandbox.console, sandbox.requestAnimationFrame,
    sandbox.setInterval, sandbox.setTimeout, sandbox.Event, sandbox.dispatchEvent, undefined);
  const installed = sandbox.__installSwitchInput ? sandbox.__installSwitchInput() : false;
  // 取到轮询函数（setInterval 兜底那条）
  const tick = timers[timers.length - 1];
  return { sandbox, sent, quit, logs, buttons, tick, installed, realGlobal };
}

// ---- A 组：__gameRunning 硬闸 ----
{
  const h = makeHarness();
  check('轮询已安装', h.installed, true);
  check('拿到轮询函数', typeof h.tick, 'function');

  // 1) 菜单阶段（__gameRunning 不存在）：按 A(1) → 一个键都不发
  h.sandbox.__gameRunning = false;
  h.tick();                        // 建立基线快照
  h.buttons[1] = true;             // 物理 A 按下
  h.tick();
  check('菜单阶段：按 A 不发任何键', h.sent.length, 0);
  h.buttons[1] = false;
  h.tick();
  check('菜单阶段：松开也不发键', h.sent.length, 0);

  // 2) 菜单阶段按十字上(12)、B(0)、X(3)、Y(2)、L(4)、+(9) 全部静默，
  //    且 + 不触发退出（菜单里误按不应重启流程）
  [12, 0, 3, 2, 4, 5, 14, 15, 13, 9].forEach(i => { h.buttons[i] = true; });
  h.tick();
  check('菜单阶段：全键位乱按都不发键', h.sent.length, 0);
  check('菜单阶段：+ 不触发退出', h.quit.length, 0);
  [12, 0, 3, 2, 4, 5, 14, 15, 13, 9].forEach(i => { h.buttons[i] = false; });
  h.tick();

  // 3) 开门（游戏开始）后：按 A(1) → 默认表 -5（FIRE）
  h.sandbox.__gameRunning = true;
  h.buttons[1] = true;
  h.tick();
  check('游戏内：按 A 发 FIRE(-5)', h.sent.map(x => x[0]).join(','), '-5');
  check('游戏内：按下方向正确', h.sent[0][1], true);
  h.buttons[1] = false;
  h.tick();
  check('游戏内：松开发 release', h.sent[1][1], false);

  // 4) 菜单阶段按下并保持 → 开门瞬间不能补发一次假边沿
  h.sandbox.__gameRunning = false;
  h.buttons[13] = true;            // 十字下按住不放
  h.tick();
  const before = h.sent.length;
  h.sandbox.__gameRunning = true;
  h.tick();
  check('按住不放时开门：不补发假按下', h.sent.length, before);
  h.buttons[13] = false;
  h.tick();
  check('开门后松开才发 release', h.sent.length, before + 1);
  check('十字下 = 数字 8（边沿只一次）', h.sent[h.sent.length - 1][0], 56);

  // 5) 游戏内 + 键才触发退出，且不发给 VM
  const sentBeforePlus = h.sent.length;
  h.buttons[9] = true;
  h.tick();
  check('游戏内：+ 触发退出', h.quit.length, 1);
  check('游戏内：+ 不发给 VM', h.sent.length, sentBeforePlus);
  h.buttons[9] = false;
  h.tick();

  // 6) 自定义映射改写后：菜单阶段仍然静默（映射对菜单零影响）
  h.sandbox.__gameRunning = false;
  h.sandbox.__keyMap.setBinding(0, -5);      // 物理 B → 确认
  h.sandbox.__keyMap.setBinding(1, 53);      // 物理 A → 数字 5
  h.tick();
  h.buttons[0] = true; h.buttons[1] = true;
  h.tick();
  check('菜单阶段：改过映射后依然零输出', h.sent.length, sentBeforePlus);
  h.buttons[0] = false; h.buttons[1] = false;
  h.tick();
  // 开门后按新映射发键
  h.sandbox.__gameRunning = true;
  h.buttons[0] = true;
  h.tick();
  check('游戏内：新映射生效（B → -5）', h.sent[h.sent.length - 1][0], -5);

  // 7) 摇杆同样受门控（走同一张表：默认十字左 = 数字 4(52)）
  h.sandbox.__gameRunning = false;
  h.buttons[0] = false;
  h.sandbox.__keyMap.reset();
  h.tick();
  const st = h.sent.length;
  h.sandbox.navigator.getGamepads()[0].axes[0] = -1;   // 左推
  h.tick();
  check('菜单阶段：摇杆不发键', h.sent.length, st);
  h.sandbox.__gameRunning = true;
  h.tick();
  check('推着摇杆开门：不补发假边沿', h.sent.length, st);
  h.sandbox.navigator.getGamepads()[0].axes[0] = 0;    // 回中
  h.tick();
  check('回中发 release', h.sent[h.sent.length - 1][1], false);
  h.sandbox.navigator.getGamepads()[0].axes[0] = -1;   // 再左推
  h.tick();
  check('游戏内：摇杆左 = 十字左默认键码 52', h.sent[h.sent.length - 1][0], 52);
  check('摇杆左是按下', h.sent[h.sent.length - 1][1], true);
  void h.realGlobal;
}

// ---- B 组：宿主菜单轮询源码不读映射表 ----
{
  const iList = mainSrc.indexOf("} else if (mode === 'list') {");
  const iAct = mainSrc.indexOf("} else if (mode === 'act') {");
  check('找到菜单轮询分支', iList > 0 && iAct > iList, true);
  const listBranch = mainSrc.slice(iList, iAct);
  check('菜单分支不读 __keyMap', /__keyMap/.test(listBranch), false);
  check('菜单分支不读 __buttonMap', /__buttonMap/.test(listBranch), false);
  check('菜单分支用物理索引 12/13（十字上下）', /dn\(12\)/.test(listBranch) || /up\b/.test(listBranch), true);
  // 索引定义处必须是原始 b[idx]，没有被映射表插一层
  const iDn = mainSrc.indexOf('function dn(idx) {');
  check('找到 dn() 定义', iDn > 0, true);
  const dnBody = mainSrc.slice(iDn, iDn + 220);
  check('dn() 直接读物理索引', /b\[idx\]/.test(dnBody), true);
  check('dn() 不读映射表', /__keyMap|__buttonMap/.test(dnBody), false);
  // 六个宿主菜单键的取法
  check('Y=物理索引2（游戏菜单）', /yBtn = dn\(2\)/.test(mainSrc), true);
  check('X=物理索引3（分辨率）', /xBtn = dn\(3\)/.test(mainSrc), true);
  check('A=物理索引1（确认）', /aBtn = dn\(1\)/.test(mainSrc), true);
  check('B=物理索引0（返回）', /bBtn = dn\(0\)/.test(mainSrc), true);
  check('L/R=物理索引4/5（翻页）', /lBtn = dn\(4\)/.test(mainSrc) && /rBtn = dn\(5\)/.test(mainSrc), true);
  // switch-input 侧：+ 的回调必须带门控
  check('+ 退出带 __gameRunning 门控', /vmActive && typeof g\.__requestGameQuit/.test(src), true);
  // ⚠️ 断言随源码形态更新（2026-09-23 perfZ5）：内置软键盘（perfZ3）把按钮边沿改成了
  //     if (now !== was) { if (kbActive) 宿主键盘; else if (vmActive) sendKey(...) }
  // 门控**没有被去掉**（键盘激活时交宿主键盘，否则必须 vmActive），只是不再是单行形式；
  // 原来那条 `if (now !== was && vmActive) sendKey` 正则自源码改形起恒假（陈旧断言，
  // 与 perfZ5 改动无关 —— 备份里 18:13 那份 switch-input.js 同样不匹配）。
  check('按钮派发带门控（键盘激活→宿主键盘，否则必须 vmActive）',
    /if \(kbActive\)[\s\S]{0,220}else if \(vmActive\)/.test(src), true);
}

// ---- C 组：玩家配置必须在 host 脚本 eval 之后才载入（时序回归） ----
// 事故：loadKeyMap() 曾写在模块级 → 那时 boot() 的异步 eval 链还没跑，
// g.__keyMap 不存在 → 永远打印"输入层未就绪，跳过"，玩家的 keys.txt 等于没生效。
// 桌面仿真 bld\sim-perfM.txt 抓到，改为 afterHostScripts() 在 __installSwitchInput() 之后调。
{
  const iDef = mainSrc.indexOf('function afterHostScripts()');
  const iCall = mainSrc.indexOf('afterHostScripts();', iDef);
  const iInput = mainSrc.indexOf('g.__installSwitchInput();');
  check('存在 afterHostScripts() 定义', iDef > 0, true);
  check('找到 afterHostScripts() 调用点', iCall > iDef, true);
  check('__installSwitchInput() 在调用点之前', iInput > 0 && iCall > iInput, true);
  check('模块级没有裸调 loadKeyMap()', mainSrc.indexOf('\n  loadKeyMap();') < 0, true);
  check('模块级没有裸调 refreshSdMasks()', mainSrc.indexOf('\n  refreshSdMasks();') < 0, true);
  check('SD 遮罩初始化收进 initMaskSel()', mainSrc.indexOf('function initMaskSel()') > 0, true);
  const body = mainSrc.slice(iDef, iDef + 700);
  check('afterHostScripts 里载入按键映射', /\n\s+loadKeyMap\(\);/.test(body), true);
  check('afterHostScripts 里重扫 SD 遮罩', /initMaskSel\(\)/.test(body), true);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
