#!/usr/bin/env node
/*
 * test-encoding.mjs — 文字编码端到端（GBK / UTF-8）
 *
 * 这条链就是实机「Forgotten Warrior 丢文字」的那条：
 *   jar 里的 GBK 字节 → new String(bytes)（平台默认编码）→ drawString
 *
 * ⚠️ 关键：本脚本在加载 app/main.js **之前**把 TextDecoder 换成 nx.js 那样的
 * "只认 utf-8" 版本。桌面 Node 带完整 ICU，new TextDecoder('gbk') 是能用的 ——
 * 如果直接在 Node 里跑，测的是宿主的 ICU，**测不到真机**（真机上那个解码器根本不存在，
 * 我们靠 vendor/pluotsorbet/midp/gbk-table.js 兜底）。换掉之后，这里跑的
 * 就是实机那条路径：conv.js 探测失败 → 走自带映射表。
 *
 * 用法：node tools/encoding-test/build.mjs && node tools/test-encoding.mjs
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const TEST_JAR = join(root, 'tools', 'encoding-test', 'enctest.jar');
const SENTENCE = '游戏文字测试：你好，世界。';
const EXPECT_TXT = Array.from(SENTENCE).map((c) => c.codePointAt(0).toString(16)).join(',');

// ---- ① 先把 TextDecoder 变成 nx.js 的样子（必须在任何库加载之前）----
const NativeTD = globalThis.TextDecoder;
function NxjsTextDecoder(label, options) {
  if (label != null && String(label) !== '' && !/^utf-?8$/i.test(String(label))) {
    throw new RangeError('Unsupported encoding: ' + label + '（模拟 nx.js 只有 utf-8）');
  }
  return new NativeTD('utf-8', options);
}
NxjsTextDecoder.prototype = NativeTD.prototype;
globalThis.TextDecoder = NxjsTextDecoder;
// 自检：确认"换掉"真的生效了，否则这个脚本会假绿
try {
  new globalThis.TextDecoder('gbk');
  console.log('!! 自检失败：TextDecoder("gbk") 仍然可用，本测试测不到真机路径');
  process.exit(1);
} catch (e) { /* 期望抛错 */ }
let nativeGbkOk = false;
try { nativeGbkOk = new NativeTD('gbk').decode(Uint8Array.of(0xc4, 0xe3)) === '你'; } catch (e) {}
console.log('=== test-encoding: 已切到 nx.js 式 TextDecoder（宿主 ICU 的 gbk 可用=' + nativeGbkOk + '，本测试不用它）===');

// ---- stub canvas（与其它端到端脚本同一套）----
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

// ---- 日志采集 ----
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

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  console.error('[enc] 入口异常: ' + ((err && err.stack) || err));
  process.exit(1);
});

function finish() {
  const decoded = lines.map(decodeBridge);
  const joined = decoded.join('\n');
  const grab = (re) => { const m = joined.match(re); return m ? m[1] : null; };
  const prop = grab(/\[enc\] prop=(\S+)/);
  const dflt = grab(/\[enc\] default codes=([\da-f,]+) \(len=\d+\)/);
  const gbk = grab(/\[enc\] GBK codes=([\da-f,]+) \(len=\d+\)/);
  const utf8 = grab(/\[enc\] utf8-as-default codes=([\da-f,]+) \(len=\d+\)/);
  const back = grab(/\[enc\] getBytes hex=(\S+)/);
  const rt = grab(/\[enc\] roundtrip codes=([\da-f,]+) \(len=\d+\)/);
  const txt = grab(/\[enc\] txt codes=([\da-f,]+) \(len=\d+\)/);
  const ascii = grab(/\[enc\] ascii codes=([\da-f,]+) \(len=\d+\)/);

  const cases = [
    ['microedition.encoding = GBK（模拟中文手机）', prop === 'GBK', '实际 ' + prop],
    ['new String(GBK 字节) → 你好', dflt === '4f60,597d', '实际 ' + dflt],
    ['new String(GBK 字节,"GBK") → 你好（自带映射表兜底）', gbk === '4f60,597d', '实际 ' + gbk],
    ['new String(UTF-8 字节) → 你好（自动判定照顾 UTF-8 游戏）', utf8 === '4f60,597d', '实际 ' + utf8],
    ['getBytes() 写回 GBK 字节 c4e3bac3', back === 'c4e3bac3', '实际 ' + back],
    ['getBytes() → new String() 往返 → 你好', rt === '4f60,597d', '实际 ' + rt],
    ['jar 内 GBK 文本文件 → 正确中文', txt === EXPECT_TXT, '实际 ' + txt + ' 期望 ' + EXPECT_TXT],
    ['纯 ASCII 不受影响', ascii === '41,42,43', '实际 ' + ascii],
    ['startApp 跑到底（DONE）', /\[enc\] DONE/.test(joined), ''],
    ['没有任何 FAIL 行', !/\[enc\] FAIL/.test(joined), ''],
  ];

  console.log('');
  console.log('--- test-encoding 结论 ---');
  let bad = 0;
  for (const [name, ok, extra] of cases) {
    if (!ok) bad++;
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !extra ? '' : '  ← ' + extra));
  }
  if (/\[enc\] FAIL/.test(joined)) {
    decoded.filter((l) => l.includes('[enc] FAIL')).forEach((l) => console.log('    ' + l.trim()));
  }
  console.log('结果: ' + (bad ? '失败 ✘（' + bad + ' 项）' : '全部通过 ✔'));
  process.exit(bad ? 1 : 0);
}

setTimeout(finish, 9000);
