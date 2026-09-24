#!/usr/bin/env node
/*
 * test-samsung-api.mjs — 三星兼容层端到端回归（VM 里真的跑一遍）
 *
 * 被测链路（= Forgotten Warrior.jar 的启动路径）：
 *   MIDlet.startApp
 *     → new AudioClip(3, "/test.mid")      ← perfZ8 之前这一步是 ClassNotFoundException
 *     → play(1, 3) / stop()
 *     → Vibration.start(500, 3)
 *   每一步都要求**不抛异常**；抛了就会被 MIDletSuiteLoader 的 listener 记成
 *   "listener error: ..." 并干掉 MIDlet（实机表现：游戏打不开 / 15 秒零帧）。
 *
 * 断言来自 MIDlet 自己打印的 [samtest] 行（Java 侧输出经 console 桥接，
 * 中文会变成 U+FF00|byte 的码位，所以下面统一走 decodeBridge 还原）。
 *
 * 用法：node tools/samsung-test/build.mjs && node tools/test-samsung-api.mjs
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const TEST_JAR = join(root, 'tools', 'samsung-test', 'samsungtest.jar');

// ---- stub canvas（与 tools/simulate.mjs / test-text-ok.mjs 同一套）----
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

// Java 侧字符串经 console 桥接后每个**字节**变成 U+FF00|byte 的码位；ASCII 原样。
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

console.log('=== test-samsung-api: jar=' + TEST_JAR + ' ===');

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  console.error('[samtest] 入口异常: ' + ((err && err.stack) || err));
  process.exit(1);
});

function finish() {
  const decoded = lines.map(decodeBridge);
  const joined = decoded.join('\n');
  const has = (re) => re.test(joined);

  const cases = [
    ['类加载没炸（AudioClip/Vibration 都在类库里）', has(/\[samtest\] Vibration\.isSupported=/)],
    ['Vibration.start/stop 无异常', has(/\[samtest\] PASS Vibration start\/stop/)],
    ['AudioClip 构造无异常', has(/\[samtest\] PASS AudioClip 构造完成/)],
    ['play(1,3) 无异常（音量 0~10 刻度 → 30）', has(/\[samtest\] PASS play\(1,3\) 无异常，vol=30/)],
    ['play/stop 反复调用无异常', has(/\[samtest\] PASS play\/stop 反复调用无异常/)],
    ['缺资源 / 相对资源名不崩', has(/\[samtest\] PASS 缺资源\/相对名不崩/)],
    ['byte[] 重载构造不崩', has(/\[samtest\] PASS 内存数据构造不崩/)],
    ['反复 new AudioClip 循环播放无异常', has(/\[samtest\] PASS 反复 new AudioClip 循环播放无异常/)],
    ['startApp 跑到底（打印 DONE）', has(/\[samtest\] DONE/)],
    ['没有任何 FAIL 行', !has(/\[samtest\] FAIL/)],
  ];

  // 复用行为：同一个资源只应"载入"一次，其余走复用（游戏每秒 new 一次时这是内存的解药）
  const loadCount = decoded.filter((l) => l.includes('[samsung] AudioClip 载入 /test.mid')).length;
  const reuseCount = decoded.filter((l) => /\[samsung\] AudioClip 复用/.test(l)).length;
  cases.push(['同一资源只载入一次（实际 ' + loadCount + ' 次）', loadCount === 1]);
  cases.push(['循环播放走了复用（' + reuseCount + ' 次 ≥ 4）', reuseCount >= 4]);

  console.log('');
  console.log('--- test-samsung-api 结论 ---');
  let bad = 0;
  for (const [name, ok] of cases) { if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + name); }
  if (has(/\[samtest\] FAIL/)) {
    decoded.filter((l) => l.includes('[samtest] FAIL')).forEach((l) => console.log('    ' + l));
  }

  // 环境相关信息：仿真里没有 AudioContext（真机才出声），所以"载入成功"与"静音降级"都算正常，
  // 但两条必有一条 —— 两条都没有说明 AudioClip 的实现根本没被走到。
  const loaded = decoded.find((l) => l.includes('[samsung] AudioClip 载入'));
  const degraded = decoded.find((l) => /\[samsung\] AudioClip (载入失败|jar 里找不到资源|没有可用播放器)/.test(l));
  console.log((loaded || degraded ? 'INFO ' : 'FAIL ') +
    '音频路径走到了：' + (loaded ? loaded.replace(/^.*\[samsung\]/, '[samsung]') :
      (degraded ? degraded.replace(/^.*\[samsung\]/, '[samsung]') : '(没有任何 [samsung] 音频日志)')));
  if (!loaded && !degraded) bad++;

  console.log('结果: ' + (bad ? '失败 ✘（' + bad + ' 项）' : '全部通过 ✔'));
  process.exit(bad ? 1 : 0);
}

setTimeout(finish, 9000);
