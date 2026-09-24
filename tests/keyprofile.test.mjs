/*
 * 按键机型（厂商软键键值）回归测试 —— 2026-09-23 perfR
 *
 * 需求：游戏菜单里能"针对某个游戏"把键值切到摩托罗拉（默认诺基亚）。
 *
 * 背景（为什么需要这个功能）：MIDP 只统一了数字键 48-57 / '*'42 / '#'35 /
 * 方向 -1..-4 / FIRE -5；**左右软键是厂商自定的**：
 *   诺基亚/索爱/三星 -6/-7     摩托罗拉 -21/-22（旧机型 -20/22）
 * 数值依据：SO「How to get the keycode for different mobiles using j2me」
 * 里流传的 KeyCodeAdapter，与 SO「J2ME Soft Key Wrapper」答案里
 * `standard || Motorola || Siemens || Motorola 2 || Motorola 1`
 * → 左 `-6 || -21 || -1 || -20 || 21`、右 `-7 || -22 || -4 || 22` 互相印证。
 *
 * 覆盖：
 *   A 组 纯逻辑：机型表数值、切换/回落、自定义机型、软键名映射表
 *   B 组 端到端：假手柄按 ZL/ZR，断言**真正发出去的 keyCode** 随机型变
 *   C 组 宿主接线：菜单项/分发/面板/绘制/轮询分支/启动前应用/持久化/删除清理
 *   D 组 vendor：getKeyName 会查宿主登记的软键名表
 *
 * 运行：node tests/keyprofile.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'src/host/switch-input.js'), 'utf8');
const mainSrc = readFileSync(join(root, 'app/main.js'), 'utf8');
const midpSrc = readFileSync(join(root, 'vendor/pluotsorbet/midp/midp.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

// ---- 假手柄沙箱（驱动真实 pollPad，验证真正发出的键码） ----
function makeHarness() {
  const sent = [];
  const timers = [];
  const buttons = new Array(16).fill(false);
  const pad = {
    connected: true, id: 'fake', mapping: 'standard', axes: [0, 0, 0, 0],
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
    __sdLog: () => {},
    __sendKeyPress: (c) => sent.push(c),
    __sendKeyRelease: () => {},
  };
  sandbox.globalThis = sandbox;
  const fn = new Function('globalThis', 'navigator', 'console', 'requestAnimationFrame',
    'setInterval', 'setTimeout', 'Event', 'dispatchEvent', src);
  fn.call(sandbox, sandbox, sandbox.navigator, sandbox.console, sandbox.requestAnimationFrame,
    sandbox.setInterval, sandbox.setTimeout, sandbox.Event, sandbox.dispatchEvent);
  sandbox.__installSwitchInput();
  return { sandbox, sent, buttons, tick: timers[timers.length - 1] };
}

// ---- A. 机型表与切换 ----
{
  const h = makeHarness();
  const P = h.sandbox.__keyProfiles;
  check('导出 __keyProfiles', typeof P, 'object');
  const list = P.list();
  check('内置 3 个机型（诺基亚竖屏/诺基亚横屏/摩托罗拉）', list.length, 3);
  const byId = {};
  list.forEach(p => { byId[p.id] = p; });
  check('诺基亚竖屏 左软键 -6', byId.nokia.softLeft, -6);
  check('诺基亚竖屏 右软键 -7', byId.nokia.softRight, -7);
  check('诺基亚竖屏 确认(OK) -5', byId.nokia.fire, -5);
  check('诺基亚竖屏 标签含"竖屏"', byId.nokia.label.indexOf('竖屏') > 0, true);
  check('诺基亚横屏 左软键 -6', byId.nokiaLS.softLeft, -6);
  check('诺基亚横屏 右软键 -7', byId.nokiaLS.softRight, -7);
  check('诺基亚横屏 确定 -5', byId.nokiaLS.fire, -5);
  check('诺基亚横屏 标签含 E52/E63', /E52\/E63/.test(byId.nokiaLS.label), true);
  check('标签里不写"QWERTY"字样（用户要求直接写数字）',
    byId.nokiaLS.label.indexOf('QWERTY') < 0, true);
  // 数字 → QWERTY 字符码（用户提供的实机键表）
  const D = byId.nokiaLS.digits;
  check('横屏有 digits 表', !!D, true);
  check('1→r(114)', D[49], 114);
  check('2→t(116)', D[50], 116);
  check('3→y(121)', D[51], 121);
  check('4→f(102)', D[52], 102);
  check('5→g(103)', D[53], 103);
  check('6→h(104)', D[54], 104);
  check('7→v(118)', D[55], 118);
  check('8→b(98)', D[56], 98);
  check('9→n(110)', D[57], 110);
  check('*→u(117)', D[42], 117);
  check('0→m(109)', D[48], 109);
  check('#→j(106)', D[35], 106);
  check('竖屏没有 digits 表（数字是 MIDP 标准码）', !!byId.nokia.digits, false);
  check('摩托罗拉没有 digits 表', !!byId.motorola.digits, false);
  check('摩托罗拉 左软键 -21', byId.motorola.softLeft, -21);
  check('摩托罗拉 右软键 -22', byId.motorola.softRight, -22);
  check('摩托罗拉 OK 键 -20（用户实机键表）', byId.motorola.fire, -20);
  check('没有 motorola2（用户要求只留两个摩托档）', !!byId.motorola2, false);
  check('默认机型 = 诺基亚', P.current(), 'nokia');
  check('softCode 左（默认）', P.softCode('soft-left'), -6);
  check('softCode 右（默认）', P.softCode('soft-right'), -7);
  check('fireCode（默认 -5）', P.fireCode(), -5);
  check('mapOutCode 翻译确认键', P.mapOutCode(-5), -5);
  check('mapOutCode 不动方向键', P.mapOutCode(-1), -1);
  check('切摩托罗拉成功', h.sandbox.__setKeyProfile('motorola'), true);
  check('切后 current', P.current(), 'motorola');
  check('softCode 左（摩托）', P.softCode('soft-left'), -21);
  check('softCode 右（摩托）', P.softCode('soft-right'), -22);
  check('fireCode 摩托 = -20', P.fireCode(), -20);
  check('mapOutCode 摩托把 -5 翻成 -20', P.mapOutCode(-5), -20);
  check('未知机型被拒', h.sandbox.__setKeyProfile('nokla'), false);
  check('未知机型后回落到默认', P.current(), 'nokia');
  // 自定义机型（以后可从 SD 加某型号的真值）
  check('defineProfile 自定义',
    P.define('siemens', '西门子（-1/-4）', { softLeft: -1, softRight: -4, clear: 8 }), true);
  check('自定义机型进列表', P.list().length, 4);   // 3 内置 + 1 自定义
  check('切自定义机型', h.sandbox.__setKeyProfile('siemens'), true);
  check('自定义机型 softCode', P.softCode('soft-left'), -1);
  check('自定义机型默认 fire 回落 -5', P.fireCode(), -5);
  // 软键名表（给 vendor 的 getKeyName 用）
  const nm = h.sandbox.__softKeyNameMap;
  check('软键名表 诺基亚左', nm['-6'], 'SoftKey1');
  check('软键名表 摩托罗拉左', nm['-21'], 'SoftKey1');
  check('软键名表 摩托罗拉右', nm['-22'], 'SoftKey2');
  check('软键名表 摩托罗拉 OK', nm['-20'], 'OK');
  check('软键名表 清除键', nm['-8'], 'Clear');
}

// ---- B. 端到端：ZL/ZR 实际发出的 keyCode 随机型变 ----
{
  const h = makeHarness();
  const press = (idx) => { h.tick(); h.buttons[idx] = true; h.tick(); h.buttons[idx] = false; h.tick(); };
  // 菜单阶段（未进游戏）一根键都不发
  press(6);
  check('菜单阶段不发键', h.sent.length, 0);
  h.sandbox.__gameRunning = true;
  press(6);
  check('诺基亚：ZL 发 -6', h.sent[0], -6);
  h.sent.length = 0;
  press(7);
  check('诺基亚：ZR 发 -7', h.sent[0], -7);
  h.sent.length = 0;
  h.sandbox.__setKeyProfile('motorola');
  press(6);
  check('摩托罗拉：ZL 发 -21', h.sent[0], -21);
  h.sent.length = 0;
  press(7);
  check('摩托罗拉：ZR 发 -22', h.sent[0], -22);
  h.sent.length = 0;
  // 诺基亚横屏档：软键/确定同竖屏，**数字改成 QWERTY 字符码**
  h.sandbox.__setKeyProfile('nokiaLS');
  press(6);
  check('诺基亚横屏：ZL 发 -6', h.sent[0], -6);
  h.sent.length = 0;
  press(7);
  check('诺基亚横屏：ZR 发 -7', h.sent[0], -7);
  h.sent.length = 0;
  press(1);   // 物理A → 确定
  check('诺基亚横屏：确定发 -5', h.sent[0], -5);
  h.sent.length = 0;
  // 十字键默认发数字 2/8/4/6 → 横屏档应变成 t/b/f/h 的字符码
  press(12);  // 十字上 → 数字 2 → 't'
  check('诺基亚横屏：十字上发 116(t)', h.sent[0], 116);
  h.sent.length = 0;
  press(13);  // 十字下 → 数字 8 → 'b'
  check('诺基亚横屏：十字下发 98(b)', h.sent[0], 98);
  h.sent.length = 0;
  press(14);  // 十字左 → 数字 4 → 'f'
  check('诺基亚横屏：十字左发 102(f)', h.sent[0], 102);
  h.sent.length = 0;
  press(15);  // 十字右 → 数字 6 → 'h'
  check('诺基亚横屏：十字右发 104(h)', h.sent[0], 104);
  h.sent.length = 0;
  press(0);   // 物理B → 默认 '5'(53) → 'g'
  check('诺基亚横屏：物理B(=5)发 103(g)', h.sent[0], 103);
  h.sent.length = 0;
  press(4);   // L → '*'(42) → 'u'
  check('诺基亚横屏：L(=*)发 117(u)', h.sent[0], 117);
  h.sent.length = 0;
  // 回到竖屏档应恢复 MIDP 标准数字码
  h.sandbox.__setKeyProfile('nokia');
  press(12);
  check('竖屏档：十字上仍是标准 50', h.sent[0], 50);
  h.sent.length = 0;
  // 摩托罗拉：确认发 OK 键 -20（数字保持标准）
  h.sandbox.__setKeyProfile('motorola');
  press(1);
  check('摩托罗拉：确认发 -20（不是 -5）', h.sent[0], -20);
  h.sent.length = 0;
  press(12);
  check('摩托罗拉：十字上仍是标准 50', h.sent[0], 50);
  h.sent.length = 0;
  // 非软键/非确认不受机型影响
  h.sandbox.__setKeyProfile('motorola');
  press(12);  // 十字上 → 数字 2
  check('机型不影响方向键（50）', h.sent[0], 50);
  h.sent.length = 0;
  h.sandbox.__keyMap.setBinding(8, 'soft-left');   // - 键 → 左软键
  press(8);
  check('绑到软键的键也随机型（-21）', h.sent[0], -21);
}

// ---- C. 宿主接线（菜单项 / 面板 / 启动前应用 / 持久化） ----
{
  const items = mainSrc.match(/var ACT_ITEMS\s*=\s*\[([^\]]*)\]/);
  check('找得到 ACT_ITEMS', !!items, true);
  check("ACT_ITEMS 含 '按键机型'", items[1].indexOf("'按键机型'") >= 0, true);
  check('菜单项数 = 7', items[1].split(',').length, 7);
  check('面板行数 = 机型数 + 返回', /rows\.push\(\{ kind: 'back'/.test(mainSrc), true);
  check('分发：按键机型 → openProfSel()',
    /item === '按键机型'\)\s*\{\s*openProfSel\(\);\s*return;/.test(mainSrc), true);
  ['profList', 'openProfSel', 'profPick', 'drawProfPanel'].forEach(f => {
    check(`存在 ${f}()`, mainSrc.indexOf('function ' + f + '(') > 0, true);
  });
  check("draw() 有 profile 分支", mainSrc.indexOf("else if (mode === 'profile') drawProfPanel();") > 0, true);
  check('轮询有 profile 分支', /mode === 'profile'\)\s*\{/.test(mainSrc), true);
  check("openProfSel 设置 mode='profile'", /function openProfSel\(\)[\s\S]{0,700}mode = 'profile';/.test(mainSrc), true);
  // 启动前应用（必须在放行闸门之前）
  const iApply = mainSrc.indexOf('applyProfileForJar(sel.file)');
  const iResolve = mainSrc.indexOf('g.__gameSelectionResolve(sel)');
  check('启动时应用机型', iApply > 0, true);
  check('应用在放行闸门之前', iApply > 0 && iResolve > 0 && iApply < iResolve, true);
  // 持久化
  check('机型存档 keyprofiles.json', mainSrc.indexOf('keyprofiles.json') > 0, true);
  check('按 jar 文件名索引', /function profileForJar\(jar\)/.test(mainSrc), true);
  check('默认值不落盘（诺基亚=删记录）', /if \(r\.id === 'nokia'\) delete m\[en\.file\]/.test(mainSrc), true);
  check('删除游戏时清机型记录', /delete lp\[en\.file\];/.test(mainSrc), true);
  check('面板提示只影响软键', mainSrc.indexOf('只影响发给游戏的软键键值') > 0, true);
  // 面板要把数字映射"直接写成数字"（1:114 2:116 …），不含"QWERTY"这种说法
  check('面板拼数字表（nameOf 映射）', /nameOf = \{ 49: '1'/.test(mainSrc), true);
  check('面板有 detail2 第二行', /detail2: d2/.test(mainSrc), true);
  check('面板 detail2 画第二行', /r\.detail2/.test(mainSrc) && /fillText\(r\.detail2/.test(mainSrc), true);
}

// ---- D. vendor：getKeyName 查宿主登记表；getGameAction 认摩托罗拉 OK -20 ----
{
  check('getKeyName 查 __softKeyNameMap', midpSrc.indexOf('__softKeyNameMap') > 0, true);
  check('查表失败仍回落原行为', /return J2ME\.newString\(\(keyCode in keyNames\)/.test(midpSrc), true);
  // −20 必须被 getGameAction 翻成 FIRE(8)，否则摩托罗拉档下"用 getGameAction
  // 判断确认"的游戏会失灵（实机摩托罗拉 OK 硬件键报的就是 -20）
  check('gameKeys 含 "-20": 8（摩托罗拉 OK → FIRE）', /"-20": 8/.test(midpSrc), true);
  check('gameKeys 仍含 "-5": 8', /"-5": 8/.test(midpSrc), true);
  // QWERTY 横屏机的字符码也要能翻成方向/确认，否则 getGameAction 判断会失灵
  check('gameKeys: 116(t)=UP', /\b116: 1,/.test(midpSrc), true);
  check('gameKeys: 102(f)=LEFT', /\b102: 2,/.test(midpSrc), true);
  check('gameKeys: 104(h)=RIGHT', /\b104: 5,/.test(midpSrc), true);
  check('gameKeys: 98(b)=DOWN', /\b98: 6,/.test(midpSrc), true);
  check('gameKeys: 103(g)=FIRE', /\b103: 8,/.test(midpSrc), true);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
