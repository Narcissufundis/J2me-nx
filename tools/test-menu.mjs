#!/usr/bin/env node
/*
 * test-menu.mjs — 菜单新功能 E2E（Node 仿真，J2ME_TEST_MENU=1）
 *
 * 用脚本手柄（fake gamepad）按时间线按键，验证：
 *   1. R/L 翻页（20 个 jar，maxRows=7 → 3 页；R 后 sel 应跳到第 8 项）
 *   1b. **L/R 循环翻页**（2026-09-23 perfZ6）：首页按 L 应到末页（3/3）、末页按 R 应回首页（1/3）
 *   1c. **"+" 回列表停在当前页**：软重启后菜单应停在上次那一页（2/3），而不是被打回首页
 *   2. Y → 游戏菜单 → 改名 → 系统键盘 stub submit → names.txt 落盘
 *   3. Y → 删除 → 二次确认 → jar 文件真的被 unlink + names.txt 条目清理
 *   4. A → 启动 resolve
 * 产物目录 tools/tmp-menutest/（测试自建自清理，不动 data/java）。
 *
 * 观察手段：stub canvas 的 fillText 被录下来（drawnText），菜单右上角那行
 * "第 N/M 页" 就是翻页/记忆行为的直接证据 —— 不用去读菜单内部闭包变量。
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, copyFileSync, existsSync, rmSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const T0 = Date.now();
const t = () => ((Date.now() - T0) / 1000).toFixed(2);

const results = [];
function assert(cond, label) {
  results.push((cond ? 'PASS ' : 'FAIL ') + label);
  console.log((cond ? '[PASS] ' : '[FAIL] ') + label);
}
function log(msg) { console.log('[t=' + t() + 's] ' + msg); }

// 菜单每帧 fillText 的文本（只留我们需要判断的短串，避免刷屏）
const drawnText = [];
let fillCalls = 0;
let s2Fills = 0;
// 宿主日志留一份（断言"启动的到底是哪个 jar"）
const hostLog = [];
const origConsoleLog = console.log;
console.log = function () {
  const s = Array.prototype.map.call(arguments, String).join(' ');
  hostLog.push(s);
  origConsoleLog(s);
};

// ---- 准备 20 个测试 jar（拷贝现成的小 jar）----
// PATCH(perfZ24)：夹具 = 自制的 tools/fixture/fixture.jar（旧路径仅作本机兼容回退）
const fixtureJar = join(root, 'tools', 'fixture', 'fixture.jar');
const legacyJar = join(root, 'tools', 'tmp-softrestart', 'A_176x220.jar');
const srcJar = existsSync(fixtureJar) ? fixtureJar : legacyJar;
const gameDir = join(root, 'tools', 'tmp-menutest');
rmSync(gameDir, { recursive: true, force: true });
mkdirSync(gameDir, { recursive: true });
if (!existsSync(srcJar)) {
  console.error('缺少测试夹具 jar：' + fixtureJar +
    '\n请先运行：node tools/build-classes.mjs && node tools/fixture/build.mjs');
  process.exit(1);
}
const JARS = [];
for (let i = 0; i < 20; i++) {
  const name = 'G' + String(i).padStart(2, '0') + '_test.jar';
  copyFileSync(srcJar, join(gameDir, name));
  JARS.push(name);
}
const RENAME_TARGET = JARS[7];   // 翻页后第 8 项（R 键应选中它）
const DELETE_TARGET = JARS[7];   // 改名后的同一游戏再删除（验证 names 条目联动清理）
const LAUNCH_TARGET = JARS[8];   // 删除后 sel 滑到 G08，A 启动它
const RENAME_VALUE = '测试改名abc';
const namesFile = join(root, 'data', 'names.txt');
try { if (existsSync(namesFile)) unlinkSync(namesFile); } catch (e) { /* 忽略 */ }

process.env.J2ME_TEST_GAMEDIR = gameDir;
process.env.J2ME_TEST_MENU = '1';
// perfZ26：仿真保真 —— 读盘结果按实机形态（ArrayBuffer）交给宿主，让"类型没规整"这类
// 只在真机上出现的 bug 在仿真里也变红（实机 ArrayBuffer 没有 .length，Node Buffer 有）。
process.env.J2ME_TEST_ARRAYBUFFER = '1';
// 不设 J2ME_TEST_RESTART / J2ME_TEST_JAR

// ---- stub canvas（菜单画布）----
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
    // 录下菜单画的字：只看"第 N/M 页"这种短标记（翻页/记忆行为的直接证据）
    fillText: (s) => {
      const str = String(s);
      if (/第 \d+\/\d+ 页/.test(str)) drawnText.push({ t: Date.now() - T0, s: str });
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
globalThis.OffscreenCanvas = StubCanvas; // env-prelude 画布工厂优先用它
// main.js 在求值期捕获 native rAF 做世代理包装（__origRAF）——Node 没有
// 原生 rAF，必须在 main.js 之前提供一个，否则世代理包装退化为静默 no-op
//（实机 nx.js 有原生 rAF，无此问题）
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.screen = new StubCanvas(1280, 720);
globalThis.innerWidth = 1280; globalThis.innerHeight = 720;

// ---- 脚本手柄：{t, idx} 按下 60ms ----
// 物理→索引：0=B 1=A 2=Y 3=X 4=L 5=R 12=上 13=下
// ⚠️ ACT_ITEMS 现在的顺序是 ['启动','改名','选择遮罩','按键映射','按键机型','删除','返回列表']，
//    所以"删除"要吃 5 次 down（旧脚本只按 2 次 → 落在"选择遮罩"上，删除断言一直红着）。
const presses = [
  { t: 2500, idx: 5 },   // R 翻页 → sel=7 (G07)
  { t: 3000, idx: 2 },   // Y → act 菜单
  { t: 3400, idx: 13 },  // down → 改名
  { t: 3800, idx: 1 },   // A → startRename（vk stub 300ms 后 submit）
  { t: 5600, idx: 2 },   // Y → act 菜单
  { t: 5900, idx: 13 },  // down → 改名
  { t: 6100, idx: 13 },  // down → 选择遮罩
  { t: 6300, idx: 13 },  // down → 按键映射
  { t: 6500, idx: 13 },  // down → 按键机型
  { t: 6700, idx: 13 },  // down → 删除
  { t: 6950, idx: 1 },   // A → 删除确认面板
  { t: 7300, idx: 13 },  // down → 确认删除
  { t: 7600, idx: 1 },   // A → doDelete（19 个 jar，sel 滑到 G08=下标7，第 2/3 页）
  // ---- 1b. 循环翻页（删完之后：页2 → L → 页1 → L → 页3 → R → 页1 → R → 页2）----
  { t: 8000, idx: 4 },   // L：页 2 → 页 1（1/3）
  { t: 8400, idx: 4 },   // L：页 1 → 末页（3/3）  ← 循环，旧版这里毫无反应
  { t: 8800, idx: 5 },   // R：末页 → 页 1（1/3）  ← 循环，旧版这里毫无反应
  { t: 9200, idx: 5 },   // R：页 1 → 页 2（2/3），sel 回到下标 7 = G08
  { t: 9600, idx: 1 },   // A → 启动（resolve 菜单）
];
const pad = { connected: true, buttons: Array.from({ length: 20 }, () => ({ pressed: false, value: 0 })) };
let gpCalls = 0;
const fakeNavigator = {
  getGamepads() {
    gpCalls++;
    const now = Date.now() - T0;
    // 聚合：同一按钮可能排了多次按键，任一命中即按下（逐条覆盖会被后条吃掉）
    const state = Array(20).fill(false);
    for (const p of presses) {
      if (now >= p.t && now < p.t + 80) state[p.idx] = true;
    }
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
// 事件循环心跳：如果被长任务阻塞，这里会断流
let lastBeat = Date.now();
setInterval(() => {
  const now = Date.now();
  const gap = now - lastBeat;
  lastBeat = now;
  if (gap > 400) log('!! 事件循环阻塞 ' + gap + 'ms（getGamepads 已调用 ' + gpCalls + ' 次）');
}, 250);
// 虚拟键盘 stub：show() 后 300ms 自动 submit
const vk = {
  type: 0, okButtonText: '', maxLength: 0, value: '', _ls: {},
  addEventListener(t2, f) { (this._ls[t2] = this._ls[t2] || []).push(f); },
  removeEventListener(t2, f) { this._ls[t2] = (this._ls[t2] || []).filter((x) => x !== f); },
  dispatchEvent(ev) { for (const f of this._ls[ev.type] || []) f.call(this, ev); return true; },
  show() {
    log('>>> vk.show() 预填值=' + JSON.stringify(this.value) + ' type=' + this.type);
    setTimeout(() => {
      this.value = RENAME_VALUE;
      log('>>> vk.submit 值=' + JSON.stringify(this.value));
      this.dispatchEvent({ type: 'submit' });
    }, 300);
  },
  hide() {},
};
Object.defineProperty(fakeNavigator, 'virtualKeyboard', { get: () => vk });
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: fakeNavigator, configurable: true, writable: false,
  });
} catch (e) {
  console.error('navigator 不可替换: ' + e.message); process.exit(1);
}

// ---- 中途快照（改名后、删除前）----
let namesMid = '(未捕获)';
setTimeout(() => {
  try { namesMid = readFileSync(namesFile, 'utf8'); } catch (e) { namesMid = '(读取失败: ' + e.message + ')'; }
  log('>>> t=5.5s names.txt 快照: ' + JSON.stringify(namesMid));
}, 5500);

// ---- 1c. 启动游戏后模拟"游戏内按 + 回列表"（软重启）----
// 软重启只重新求值 vendor bundle，app/main.js 这个模块不重载 —— 所以模块级的
// menuSel 能把"上次停在第几页"带过去。重启后菜单应停在 2/3 页而不是被打回 1/3。
let quitRel = 0;
setTimeout(() => {
  quitRel = Date.now() - T0;
  log('>>> t=10.5s 触发软重启（模拟游戏内按 + 回列表）');
  try { globalThis.__requestGameQuit('测试：回列表'); } catch (e) { log('!! requestGameQuit 异常: ' + (e && e.message)); }
}, 10500);
// ---- 结束与断言 ----
setTimeout(() => {
  // 断言 1：改名后 names.txt 落盘（中途快照）
  assert(namesMid.includes(RENAME_TARGET + '\t' + RENAME_VALUE),
    '改名落盘 names.txt（' + RENAME_TARGET + ' → ' + RENAME_VALUE + '）');
  // 断言 2：删除生效（jar 真被 unlink）
  assert(!existsSync(join(gameDir, DELETE_TARGET)), '删除生效（' + DELETE_TARGET + ' 已 unlink）');
  // 断言 3：删除后 names.txt 联动清理该条目
  let namesEnd = '';
  try { namesEnd = readFileSync(namesFile, 'utf8'); } catch (e) { namesEnd = '(无)'; }
  assert(!namesEnd.includes(RENAME_TARGET), '删除后 names 条目已联动清理');
  // 断言 4：没误删别的游戏
  assert(existsSync(join(gameDir, LAUNCH_TARGET)), '未误删相邻游戏（' + LAUNCH_TARGET + ' 仍在）');
  // 断言 5：启动的确实是删除后滑到的那个（sel 从 G07 滑到 G08）
  assert(hostLog.some((l) => l.indexOf('[menu] 选中: ') >= 0 && l.indexOf(LAUNCH_TARGET) >= 0),
    'A 启动的是 ' + LAUNCH_TARGET + '（删除后 sel 正确滑动）');

  // ---- 断言 6/7：循环翻页（"第 N/M 页"文字的实测序列）----
  const pageNum = (s) => {
    const m = s.match(/第 (\d+)\/(\d+) 页/);
    return m ? m[1] + '/' + m[2] : null;
  };
  const seqAll = [];
  for (const d of drawnText) {
    const n = pageNum(d.s);
    if (!n) continue;
    if (!seqAll.length || seqAll[seqAll.length - 1].n !== n) seqAll.push({ t: d.t, n: n });
  }
  log('>>> 页码序列: ' + seqAll.map((x) => x.n + '@' + (x.t / 1000).toFixed(1) + 's').join(' → '));
  // 翻页窗口（删除后 8.0s~9.4s）：页2 → L → 1/3 → L → 3/3 → R → 1/3 → R → 2/3
  const win = seqAll.filter((x) => x.t >= 7800 && x.t <= 9800).map((x) => x.n);
  assert(win.includes('3/3'), '首页按 L 能循环到末页（序列=' + win.join(',') + '）');
  assert(win.slice(-4).join(',') === '1/3,3/3,1/3,2/3',
    'L/R 循环翻页序列正确（期望 1/3,3/3,1/3,2/3，实际 ' + win.join(',') + '）');

  // ---- 断言 8：软重启后菜单停在上次那一页 ----
  // ⚠️ 必须用**原始**绘制记录：上面那个 seqAll 把连续相同页码折叠了，重启后画的
  // 仍是 2/3，会被折叠掉（踩过一次，误报"重启后没画出菜单"）。
  const after = drawnText.filter((x) => quitRel && x.t > quitRel)
    .map((x) => ({ t: x.t, n: pageNum(x.s) }));
  log('>>> 重启后页码绘制: ' + (after.length ?
    after.map((x) => x.n + '@' + (x.t / 1000).toFixed(1) + 's').join(' → ') : '(一张都没画)'));
  assert(after.length > 0 && after[0].n === '2/3',
    '软重启后菜单停在上次那一页（期望 2/3，实际 ' + (after.length ? after[0].n : '重启后没画出菜单') + '）');

  console.log('\n===== 结果汇总 =====');
  console.log(results.join('\n'));
  // 清理
  try { rmSync(gameDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
}, 20000);

process.on('unhandledRejection', (r) => console.log('[probe] rejection: ' + r));

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  console.error('[probe] 入口异常: ' + (err && err.stack || err));
  process.exit(1);
});
