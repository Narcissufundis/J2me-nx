#!/usr/bin/env node
/*
 * test-text-ok.mjs — "游戏内打字 + 游戏自己的 OK 确认" 端到端回归测试
 *
 * 被测链路（= 实机 1.jar 取名走的那条）：
 *   ① MIDlet 先显示 Canvas，再从 Canvas 里 setCurrent(取名 Form)（含 TextField + OK/BACK 命令）
 *   ② Form 上的 TextField 建原生资源 → vendor gfx.js 回调 g.__hostTextInput() → 宿主注入文字
 *   ③ 文字进 LCDUI：Display$DisplayEventConsumerImpl.handleInputMethodEvent → TextField.setString
 *   ④ **宿主软键 ZR（右软键）→ 触发 LCDUI Command** → commandAction 里 getString()
 *
 * 第 ④ 步是 2026-09-23 实机"按游戏自己的 OK 也读不到"的真凶：
 *   src/host/switch-input.js 的 fireSoftButton() 去点 #header-ok-button / #back-button，
 *   但 env-prelude 的 DOM 垫片 getElementById 对**任意 id** 都返回一个自动创建的 stub（永远
 *   truthy），于是 gfx.js 的 updateCommands 里 `if (el)` 分支恒真 —— 命令的 onclick 挂在
 *   #displayable-N .button0/.button1 上，header/back 那两个按钮的 onclick 从来没被赋值，
 *   ZL/ZR 点了等于没点。之前的 TextTest.java 是定时器读 getString()，压根不走按键，测不到。
 *
 * 判定：拿到 [textok] OK 触发 len=N codes=<hex,...>，且 codes 与注入文字逐字符相等 → PASS。
 * 用法：node tools/test-text-ok.mjs [文字]（默认 阿凡达）
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const TEST_TEXT = process.argv[2] || '阿凡达';
const TEST_JAR = join(root, 'tools', 'textinput-test', 'textok.jar');

// ---- stub canvas（与 tools/simulate.mjs 同一套）----
globalThis.__drawStats = { calls: 0, flushes: 0, lastCall: '' };
const DRAW_METHODS = new Set(['drawImage', 'drawRect', 'fillRect', 'drawLine', 'drawString',
  'drawChars', 'drawArc', 'fillArc', 'drawRoundRect', 'fillRoundRect', 'drawRegion',
  'fillTriangle', 'drawRGB', 'drawSubstring', 'setClip', 'translate', 'drawPixels']);

function makeCtx(canvas) {
  const special = {
    measureText: (t) => ({ width: String(t).length * 8 }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  return new Proxy({}, {
    get(obj, prop) {
      if (prop === 'canvas') return canvas;
      if (prop in obj) return obj[prop];
      if (prop in special) return special[prop];
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') {
        return function () { return { addColorStop: function () {} }; };
      }
      if (DRAW_METHODS.has(prop)) {
        return function () { globalThis.__drawStats.calls++; globalThis.__drawStats.lastCall = prop; };
      }
      return function () {};
    },
    set(obj, prop, value) { obj[prop] = value; return true; },
  });
}
class StubCanvas {
  constructor(w, h) { this.width = w || 300; this.height = h || 150; this.style = {}; this._ctx = null; }
  getContext() { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  addEventListener() {}
  removeEventListener() {}
}
globalThis.__stubCanvasClass = StubCanvas;

// ---- 日志采集（落盘 + 断言）----
const lines = [];
const origLog = console.log, origWarn = console.warn, origErr = console.error;
const capture = (orig) => function (...a) {
  const s = a.map(String).join(' ');
  lines.push(s);
  try { orig(s); } catch (e) { /* 忽略 */ }
};
console.log = capture(origLog);
console.warn = capture(origWarn);
console.error = capture(origErr);

// Java 侧的字符串经 console 桥接后，每个**字节**会变成 U+FF00|byte 的一个码位
// （实机/仿真日志里中文变 "￥ﾷﾲ..." 就是这个）。ASCII 原样保留；只要出现
// 0x80~0xFEFF 的码位就说明这行本来就是正常 UTF-8（JS 侧日志），原样返回。
const decodeBridge = (str) => {
  const bytes = [];
  let suspicious = false;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c >= 0xff00 && c <= 0xffff) { bytes.push(c & 0xff); suspicious = true; }
    else return str;
  }
  if (!suspicious) return str;
  const decoded = Buffer.from(bytes).toString('utf8');
  return decoded.includes('\uFFFD') ? str : decoded;
};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.J2ME_TEST_JAR = TEST_JAR;
process.env.J2ME_TEST_TEXT = TEST_TEXT;

const expectedCodes = Array.from(TEST_TEXT).map((c) => c.codePointAt(0).toString(16)).join(',');

console.log('=== test-text-ok: jar=' + TEST_JAR + ' text=' + TEST_TEXT + ' 期望 codes=' + expectedCodes + ' ===');

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  console.error('[textok] 入口异常: ' + ((err && err.stack) || err));
  process.exit(1);
});

function dispatchSoftRight() {
  const g = globalThis;
  if (typeof g.__dispatchKey !== 'function') {
    console.log('[textok] !! g.__dispatchKey 不存在（switch-input 未装载）');
    return false;
  }
  console.log('[textok] >>> 模拟按下 ZR（右软键），触发 LCDUI 命令');
  try { g.__dispatchKey('soft-right', true); } catch (e) {
    console.log('[textok] !! 派发软键异常: ' + (e && e.message));
    return false;
  }
  return true;
}

function finish() {
  const decoded = lines.map(decodeBridge);
  const joined = decoded.join('\n');
  const sawForm = /\[textok\] 已显示取名 Form/.test(joined);
  const sawInject = /已注入文本/.test(joined);
  const okLine = decoded.find((l) => /\[textok\] OK 触发 len=/.test(l));
  let codesOk = false, gotCodes = '(未触发)';
  if (okLine) {
    const m = okLine.match(/codes=(\S*)/);
    gotCodes = m ? m[1] : '';
    codesOk = gotCodes === expectedCodes;
  }
  const accepted = /\[textok\] 名字被接受/.test(joined);

  console.log('');
  console.log('--- test-text-ok 结论 ---');
  console.log((sawForm ? 'PASS ' : 'FAIL ') + '取名 Form 已显示');
  console.log((sawInject ? 'PASS ' : 'FAIL ') + '宿主已注入文字');
  console.log((okLine ? 'PASS ' : 'FAIL ') + 'ZR 触发了游戏的确定命令' + (okLine ? '' : '  ← 命令桥断了'));
  console.log((codesOk ? 'PASS ' : 'FAIL ') + '游戏 getString() 读到注入文字：' + gotCodes +
    (codesOk ? '' : '（期望 ' + expectedCodes + '）'));
  console.log((accepted ? 'PASS ' : 'FAIL ') + '名字被接受（非空）');

  const pass = sawForm && sawInject && !!okLine && codesOk && accepted;
  console.log('结果: ' + (pass ? '全部通过 ✔' : '失败 ✘'));
  process.exit(pass ? 0 : 1);
}

setTimeout(dispatchSoftRight, 8000);
setTimeout(finish, 13000);
