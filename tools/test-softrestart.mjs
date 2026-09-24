#!/usr/bin/env node
/*
 * test-softrestart.mjs — 「连续换游戏（软重启）」端到端回归
 *
 * 复刻用户实测场景：启动游戏 → 退出回列表 → 再启动 → 再退出 → 再启动，
 * 检查三件事：
 *   ① 每次软重启后**还能正常启动下一个游戏**（`[session] 摘 VM 全局` 之后最容易坏的就是这条：
 *      摘多了会把下一次 boot 需要的东西一起摘掉）；
 *   ② `[session] 第 N 次软重启：摘 VM 全局 N 个；GC=… used A→B` 出现且摘到的个数 > 0
 *      （= perfZ13 的"按来源精确摘全局"真的生效了，而不是空转）；
 *   ③ 每次都真的起了 isolate（`jvm startIsolate0`），不是"菜单还在但游戏起不来"。
 *
 * 用法：node tools/test-softrestart.mjs
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const T0 = Date.now();
const logs = [];
const log = (s) => { logs.push(s); console.log(s); };

// ---- 测试游戏目录：3 个同款 jar（每次启动选中的都是同一个，但不影响结论）----
// PATCH(perfZ24)：夹具改成**自制**的 tools/fixture/fixture.jar（过去用商业游戏 jar，
// 不能进公开源码库；旧路径仅作本机兼容回退）。缺夹具时先跑 node tools/fixture/build.mjs。
const fixtureJar = join(root, 'tools', 'fixture', 'fixture.jar');
const legacyJar = join(root, 'tools', 'tmp-softrestart', 'A_176x220.jar');
const srcJar = existsSync(fixtureJar) ? fixtureJar : legacyJar;
if (!existsSync(srcJar)) {
  console.error('缺少测试夹具 jar：' + fixtureJar +
    '\n请先运行：node tools/build-classes.mjs && node tools/fixture/build.mjs');
  process.exit(1);
}
const gameDir = join(root, 'tools', 'tmp-softrestart-run');
rmSync(gameDir, { recursive: true, force: true });
mkdirSync(gameDir, { recursive: true });
for (let i = 0; i < 3; i++) copyFileSync(srcJar, join(gameDir, 'SR' + i + '_test.jar'));
process.env.J2ME_TEST_GAMEDIR = gameDir;

// [session] 账本落在 data/error.log（sdLog），记下起点只读增量
let appLogOffset = 0;
try {
  const p = join(root, 'data', 'error.log');
  if (existsSync(p)) appLogOffset = statSync(p).size;
} catch (e) { /* 忽略 */ }

// ---- stub canvas ----
class StubCanvas {
  constructor(w, h) { this.__w = w | 0 || 640; this.__h = h | 0 || 480; this.style = {}; this._ctx = null; }
  get width() { return this.__w; } set width(v) { this.__w = v | 0; }
  get height() { return this.__h; } set height(v) { this.__h = v | 0; }
  getContext() { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  addEventListener() {} removeEventListener() {} dispatchEvent() {}
}
function makeCtx(canvas) {
  const special = {
    measureText: (s) => ({ width: String(s).length * 8 }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
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

// ---- 按键：idx=1 是 A（启动游戏），时间轴见 presses ----
const presses = [
  { t: 4000, idx: 1 },    // A → 启动第 1 个游戏
  { t: 12000, idx: 1 },   // 软重启 #1 之后 → 启动第 2 个
  { t: 20000, idx: 1 },   // 软重启 #2 之后 → 启动第 3 个
];
const pad = { connected: true, buttons: Array.from({ length: 20 }, () => ({ pressed: false, value: 0 })) };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    getGamepads() {
      const now = Date.now() - T0;
      const state = Array(20).fill(false);
      for (const p of presses) if (now >= p.t && now < p.t + 80) state[p.idx] = true;
      for (let i = 0; i < 20; i++) {
        if (pad.buttons[i].pressed !== state[i]) {
          pad.buttons[i].pressed = state[i];
          pad.buttons[i].value = state[i] ? 1 : 0;
        }
      }
      return [pad];
    },
    language: 'zh-CN',
  },
});

// 宿主日志：捕获 app 的 sdLog（console.log 桥接）
const hostLines = [];
const origLog = console.log;
console.log = function () {
  const s = Array.prototype.map.call(arguments, String).join(' ');
  hostLines.push(s);
  origLog(s);
};

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  console.error('[probe] 入口异常: ' + ((err && err.stack) || err));
  process.exit(1);
});

// ---- 时间轴：两次"回列表（软重启）" ----
const quits = [];
setTimeout(() => {
  quits.push(Date.now() - T0);
  log('>>> t=9.0s 触发第 1 次软重启（模拟游戏内按 + 回列表）');
  try { globalThis.__requestGameQuit('测试：第 1 次回列表'); } catch (e) { log('!! 异常: ' + (e && e.message)); }
}, 9000);
setTimeout(() => {
  quits.push(Date.now() - T0);
  log('>>> t=17.0s 触发第 2 次软重启');
  try { globalThis.__requestGameQuit('测试：第 2 次回列表'); } catch (e) { log('!! 异常: ' + (e && e.message)); }
}, 17000);

// ---- 结论 ----
const results = [];
const assert = (ok, name) => results.push((ok ? 'PASS ' : 'FAIL ') + name);

setTimeout(() => {
  const joined = hostLines.join('\n');
  const launches = hostLines.filter((l) => l.indexOf('[menu] 选中: ') >= 0);
  const isolates = hostLines.filter((l) => l.indexOf('jvm startIsolate0') >= 0 && l.indexOf('返回') < 0);
  // ⚠️ [session] 账本走 sdLog 落盘（node 下写 data/error.log），不在 stdout 里 —— 必须读文件增量。
  let appLog = '';
  try {
    const p = join(root, 'data', 'error.log');
    if (existsSync(p)) {
      const buf = readFileSync(p);
      appLog = buf.slice(appLogOffset).toString('utf8');
    }
  } catch (e) { /* 忽略 */ }
  const sessions = appLog.split(/\r?\n/).filter((l) => l.indexOf('[session] 第 ') >= 0);
  // ⚠️ 别用 '[session] 软重启前回收' 做筛选：计数那行的文案里也提到了这几个字（会误匹配）
  const reclaims = appLog.split(/\r?\n/).filter((l) => l.indexOf('摘 VM 全局') >= 0);
  const droppedNums = reclaims.map((l) => {
    const m = l.match(/摘 VM 全局 (\d+) 个/);
    return m ? +m[1] : -1;
  });

  log('');
  log('--- 观测 ---');
  log('  选中/启动次数: ' + launches.length);
  log('  startIsolate0 次数: ' + isolates.length);
  sessions.forEach((l) => log('  ' + l.trim().slice(0, 170)));

  assert(launches.length >= 3, '三次启动都发生了（实际 ' + launches.length + ' 次）');
  assert(isolates.length >= 3, '每次都真的起了 isolate（实际 ' + isolates.length + ' 次）');
  assert(sessions.length >= 2, '两次软重启都打了 [session] 计数（实际 ' + sessions.length + ' 次）');
  assert(reclaims.length >= 2, '两次软重启都执行了"摘全局+GC"回收（实际 ' + reclaims.length + ' 次）');
  assert(droppedNums.length >= 2 && droppedNums.every((n) => n > 0),
    '每次都摘到了 VM 根全局（实际 ' + JSON.stringify(droppedNums) + '）');
  assert(!/\[probe\] 入口异常/.test(joined), '没有入口级异常');

  console.log('\n===== 结果汇总 =====');
  console.log(results.join('\n'));
  try { rmSync(gameDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
}, 25000);
