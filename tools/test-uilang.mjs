#!/usr/bin/env node
/*
 * test-uilang.mjs — 中/英界面切换端到端（Node 仿真，J2ME_TEST_MENU=1）
 *
 * 验证 2026-09-23 perfZ21 的整条链：
 *   ① 菜单右上角常显两行提示（中文一行 + 英文一行，两种语言下都在）；
 *   ② ZR+ZL（手柄索引 6+7 同时按下）弹出语言选项；
 *   ③ 选完**再问一次确认**（B 退回选项、A 真的切）；
 *   ④ 切到英文后菜单文字变英文（"选择游戏 (N)" → "Games (N)"、"第 N/M 页" → "Page N/M"）；
 *   ⑤ lang.json 真的落盘，切回中文也照样落盘；
 *   ⑥ 语言文件写在 J2ME_TEST_LANG_FILE 指定的临时目录 —— **绝不能**是
 *      data/lang.json（否则 lang=en 会泄漏给后续测试：它们断言的是中文菜单文字）。
 *
 * 观察手段与 test-menu.mjs 一致：stub canvas 的 fillText 被录下来 —— 屏上到底画了
 * 什么字，是"切没切"的唯一直接证据（不去读菜单内部闭包变量）。
 *
 * 注意：别与 tools/test-i18n.mjs 搞混（那是 Java 类库 i18n：GBK/StringBuilder/
 * LayerManager 的端到端验证，名字里的 i18n 是 Java 侧概念）。
 *
 * 运行：node tools/test-uilang.mjs
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, copyFileSync, existsSync, rmSync, readFileSync, unlinkSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const T0 = Date.now();
const t = () => ((Date.now() - T0) / 1000).toFixed(2);

const results = [];
function assert(cond, label) {
  results.push((cond ? 'PASS ' : 'FAIL ') + label);
  console.log((cond ? '[PASS] ' : '[FAIL] ') + label);
}
function log(msg) { console.log('[t=' + t() + 's] ' + msg); }

// 菜单每帧 fillText 的文本（带时间戳；上限 20000 条防跑飞）
const drawn = [];
const hostLog = [];
const origConsoleLog = console.log;
console.log = function () {
  const s = Array.prototype.map.call(arguments, String).join(' ');
  hostLog.push(s);
  origConsoleLog(s);
};

// ---- 临时目录：2 个 jar（菜单要有内容才画列表）+ lang.json 落点 ----
// PATCH(perfZ24)：夹具 = 自制的 tools/fixture/fixture.jar（旧路径仅作本机兼容回退）
const fixtureJar = join(root, 'tools', 'fixture', 'fixture.jar');
const legacyJar = join(root, 'tools', 'tmp-softrestart', 'A_176x220.jar');
const srcJar = existsSync(fixtureJar) ? fixtureJar : legacyJar;
if (!existsSync(srcJar)) {
  console.error('缺少测试夹具 jar：' + fixtureJar +
    '\n请先运行：node tools/build-classes.mjs && node tools/fixture/build.mjs');
  process.exit(1);
}
const gameDir = join(root, 'tools', 'tmp-uilang');
const langDir = join(root, 'tools', 'tmp-uilang-lang');
rmSync(gameDir, { recursive: true, force: true });
rmSync(langDir, { recursive: true, force: true });
mkdirSync(gameDir, { recursive: true });
mkdirSync(langDir, { recursive: true });
copyFileSync(srcJar, join(gameDir, 'Z00_test.jar'));
copyFileSync(srcJar, join(gameDir, 'Z01_test.jar'));
const langFile = join(langDir, 'lang.json');
const defaultLangFile = join(root, 'data', 'lang.json');

process.env.J2ME_TEST_GAMEDIR = gameDir;
process.env.J2ME_TEST_MENU = '1';
process.env.J2ME_TEST_LANG_FILE = langFile;
// 防御：仓库里真有一份 lang.json=en 的话，本测试的结论会被它带偏
try { if (existsSync(defaultLangFile)) unlinkSync(defaultLangFile); } catch (e) { /* 忽略 */ }

// ---- stub canvas ----
class StubCanvas {
  constructor(w, h) {
    this.__w = w | 0 || 640; this.__h = h | 0 || 480; this.style = {}; this._ctx = null;
  }
  get width() { return this.__w; }
  set width(v) { this.__w = v | 0; }
  get height() { return this.__h; }
  set height(v) { this.__h = v | 0; }
  getContext() {
    if (!this._ctx) this._ctx = makeCtx(this);
    return this._ctx;
  }
  addEventListener() {} removeEventListener() {} dispatchEvent() {}
}
function makeCtx(canvas) {
  const special = {
    measureText: (s) => ({ width: String(s).length * 8 }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    fillText: (s) => {
      const str = String(s);
      if (drawn.length < 20000) drawn.push({ t: Date.now() - T0, s: str });
    },
  };
  const o = {};
  return new Proxy(o, {
    get(obj, p) {
      if (p === 'canvas') return canvas;
      if (p in obj) return obj[p];
      if (p in special) return special[p];
      if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set(obj, p, v) { obj[p] = v; return true; },
  });
}
globalThis.__stubCanvasClass = StubCanvas;
globalThis.OffscreenCanvas = StubCanvas;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.screen = new StubCanvas(1280, 720);
globalThis.innerWidth = 1280; globalThis.innerHeight = 720;

// ---- 脚本手柄：{t, idx} 按下 200ms ----
// 时间线：ZR+ZL 弹窗（此时仍是中文）→ down 选"切换到英文" → A → A 确认 → 英文界面
//         → **软重启**（验证语言真的从 lang.json 里读回来了，用户实测反馈第二条）
//         → 再 ZR+ZL → down 选"切换到中文" → A → A 确认 → 回到中文
const CHORD = 2600, REOPEN = 7000, RESTART = 4800;
const presses = [
  { t: CHORD, idx: 6 },        // ZL
  { t: CHORD + 20, idx: 7 },   // ZR（20ms 后按下 → 两键同时落在 200ms 按住窗口里）
  { t: 3200, idx: 13 },        // down：光标 1(当前中文) → 0(切换到英文)
  { t: 3500, idx: 1 },         // A → 进入确认
  { t: 3900, idx: 1 },         // A → 真的切英文
  { t: REOPEN, idx: 6 },       // 再按 ZR+ZL（这次界面已经是英文）
  { t: REOPEN + 20, idx: 7 },
  { t: 7600, idx: 13 },        // down：光标 0(当前英文) → 1(切换到中文)
  { t: 7900, idx: 1 },         // A → 确认
  { t: 8300, idx: 1 },         // A → 切回中文
];
const pad = { connected: true, buttons: Array.from({ length: 20 }, () => ({ pressed: false, value: 0 })) };
const fakeNavigator = {
  getGamepads() {
    const now = Date.now() - T0;
    const state = Array(20).fill(false);
    for (const p of presses) if (now >= p.t && now < p.t + 200) state[p.idx] = true;
    for (let i = 0; i < 20; i++) {
      if (pad.buttons[i].pressed !== state[i]) {
        log('GP边沿 idx=' + i + ' -> ' + state[i] + ' (t=' + now.toFixed(0) + 'ms)');
        pad.buttons[i].pressed = state[i];
        pad.buttons[i].value = state[i] ? 1 : 0;
      }
    }
    return [pad];
  },
};
Object.defineProperty(fakeNavigator, 'virtualKeyboard', { get: () => null });
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: fakeNavigator, configurable: true, writable: false,
  });
} catch (e) {
  console.error('navigator 不可替换: ' + e.message); process.exit(1);
}

function langFileNow() {
  try { return readFileSync(langFile, 'utf8').trim(); } catch (e) { return '(无: ' + e.code + ')'; }
}
const texts = (fromMs, toMs) =>
  drawn.filter((d) => d.t >= fromMs && d.t <= toMs).map((d) => d.s);
const sawText = (list, needle) => list.some((s) => s.indexOf(needle) >= 0);

// ---- 软重启（模拟"游戏内按 + 回列表"）：语言必须从 lang.json 读回来 ----
// 这是用户实测反馈第二条（"选完英文，下次打开还是中文"）的**端到端**验证：
// 切换后重启会话，若 lang.json 的写/读这条链断了，这里就会看到中文菜单。
// ⚠ `__requestGameQuit` 有硬闸 `if (!g.__gameRunning) return`（软重启只对"正在运行
//   的游戏"生效），而本用例要的只是"重启一次会话"，所以这里直接把闸门打开 ——
//   走的仍然是真实路径：startSession → boot → afterHostScripts → loadLang。
let restartAt = 0;
setTimeout(() => {
  restartAt = Date.now() - T0;
  log('>>> t=' + (RESTART / 1000).toFixed(1) + 's 触发软重启（验证语言固化）');
  try {
    globalThis.__gameRunning = true;
    globalThis.__requestGameQuit('测试：验证语言固化');
  } catch (e) { log('!! requestGameQuit 异常: ' + (e && e.message)); }
}, RESTART);

// ---- 结束与断言 ----
setTimeout(() => {
  const all = drawn.map((d) => d.s);
  log('drawn 总条数=' + drawn.length +
    ' 首=' + (drawn.length ? drawn[0].t.toFixed(0) + 'ms' : '-') +
    ' 末=' + (drawn.length ? drawn[drawn.length - 1].t.toFixed(0) + 'ms' : '-'));
  const beforeSwitch = texts(0, 3400);
  // 时间窗口按**按键时刻**切（applyLang 是按键当帧就重绘的，窗口起点不能晚于按键）：
  //   2600 弦 → 3200 down → 3500 A(确认步) → 3900 A(真切) → 4800 软重启
  //   → 7000 再弦 → 7600 down → 7900 A → 8300 A(切回)
  const afterEn = texts(3900, 4700);
  // 软重启要重新求值 1.7MB bundle（仿真里 1~3s），窗口一直开到第二次按弦之前
  const afterRestart = texts(restartAt ? restartAt + 300 : 5600, REOPEN - 100);
  const afterReopen = texts(REOPEN, 7600);
  const afterZh = texts(8300, 999999);
  const confirmStep = texts(3500, 3909);   // 确认步那一下画出来的字

  // ① 双语提示常显
  assert(sawText(all, '按 ZR+ZL 切换中/英文') && sawText(all, 'Press ZR+ZL to switch language'),
    '右上角中英两行提示都画出来了');

  // ② 弹窗（此时设置还是中文）必须**双语**：用户实测反馈第一条
  //    —— 英文用户进来改语言时，中文提示对他毫无意义。
  assert(sawText(beforeSwitch, 'Language'),
    'ZR+ZL 弹出语言面板（t=' + CHORD + 'ms 之后画了标题）');
  assert(sawText(beforeSwitch, '切换到英文') && sawText(beforeSwitch, 'Switch to English'),
    '选项一同时给出中文与英文（切换到英文 / Switch to English）');
  assert(sawText(beforeSwitch, '切换到中文') && sawText(beforeSwitch, 'Switch to Chinese'),
    '选项二同时给出中文与英文（切换到中文 / Switch to Chinese）');
  assert(sawText(beforeSwitch, 'B Back') || sawText(beforeSwitch, 'B 返回'),
    '面板底部提示也带英文（B Back）');

  // ③ 两步确认
  assert(sawText(confirmStep, '确认切换语言？') && sawText(confirmStep, 'Switch language?'),
    '二次确认也是双语的（确认切换语言？/ Switch language?）');

  // ④ 软重启后语言必须还在（读 lang.json 生效）
  log('软重启后画出的前 10 条文字: ' + afterRestart.slice(0, 10).map((s) => JSON.stringify(s)).join(' '));
  assert(afterRestart.length > 0, '软重启后菜单重新画出来了');
  assert(sawText(afterRestart, 'Games ('),
    '软重启后界面仍是英文（语言从 lang.json 读回来了，不再默认中文）');
  assert(!sawText(afterRestart, '选择游戏 ('), '软重启后没有退回中文菜单');

  // ⑤ 再次打开弹窗（此时英文界面）—— 中文项仍要看得懂
  assert(sawText(afterReopen, '切换到中文') && sawText(afterReopen, 'Switch to Chinese'),
    '英文界面下弹窗同样双语可读');

  // ⑥ 落盘
  const finalLang = langFileNow().replace(/\s+/g, '');
  log('lang.json 最终内容: ' + langFileNow());
  assert(finalLang.indexOf('"lang":"zh"') >= 0, '切回中文后 lang.json 是 zh（' + finalLang + '）');
  assert(!existsSync(defaultLangFile), '没有写到 data/lang.json（J2ME_TEST_LANG_FILE 覆盖生效）');

  // ⑦ 英文界面
  log('切英文后画出的前 12 条文字: ' + afterEn.slice(0, 12).map((s) => JSON.stringify(s)).join(' '));
  assert(sawText(afterEn, 'Games ('), '切英文后主标题变 "Games (2)"');
  assert(sawText(afterEn, 'Page '), '切英文后页码变 "Page 1/1"');
  assert(sawText(afterEn, 'In game: A=OK'), '切英文后底部操作提示变英文');
  assert(sawText(afterEn, 'Switched to English'), '切英文的确认条是英文（且证明落盘走了"已写入"分支）');

  // ⑧ 中文界面（切回来）
  log('切回中文后画出的前 8 条文字: ' + afterZh.slice(0, 8).map((s) => JSON.stringify(s)).join(' '));
  assert(sawText(afterZh, '选择游戏 ('), '切回中文后主标题恢复 "选择游戏 (2)"');
  assert(sawText(afterZh, '第 1/1 页'), '切回中文后页码恢复中文');
  assert(!sawText(afterZh, 'Games ('), '中文界面里没有英文残留');

  // ⑨ 日志（日志保持中文，且能证明"写 + 回读校验"真的跑了）
  const joined = hostLog.join('\n');
  assert(joined.indexOf('语言写入+校验 ok') >= 0, '日志显示写盘后回读校验通过');
  assert(joined.indexOf('弹窗切换语言 → en') >= 0 && joined.indexOf('弹窗切换语言 → zh') >= 0,
    '日志里两次弹窗切换都留痕（en / zh）');
  assert(joined.indexOf('[ui-lang] 语言=zh（') >= 0 && joined.indexOf('内容="{"lang":"en"}"') >= 0,
    '载入日志既打了路径也打了内容（软重启时读到 en）');

  console.log('\n===== 结果汇总 =====');
  console.log(results.join('\n'));
  try { rmSync(gameDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  try { rmSync(langDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
}, 11000);

process.on('unhandledRejection', (r) => console.log('[probe] rejection: ' + r));
process.on('exit', () => {
  try { rmSync(gameDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  try { rmSync(langDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
});

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  console.error('[probe] 入口异常: ' + (err && err.stack || err));
  process.exit(1);
});
