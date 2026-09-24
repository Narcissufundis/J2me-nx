#!/usr/bin/env node
/*
 * test-nokia-dg.mjs — Nokia DirectGraphics 端到端回归（2026-09-23 perfZ7）
 *
 * 背景：1.jar 进游戏后立绘/地图整片黑，根因是 DirectGraphicsImp.drawImage 从未实现
 * （VM 对缺失 native 只打日志、不画、不抛，所以是"静默消失"）。
 *
 * 做法：跑 tools/nokia-test/DgTest.java（把 DirectGraphics 画一遍），宿主侧用一个
 * **跟踪画布变换矩阵**的 stub canvas 记录每次绘制，然后核对：
 *   ① 整段日志里不能出现 com/nokia/mid/ui 的 "does not have an implementation"
 *      —— 这条就是本次 bug 的直接指纹（少了它直接漏掉整块画面）
 *   ② 8 种 manipulation 各自的画布变换序列（rotate/scale）必须与映射表一致
 *      （⚠️ Nokia ROTATE_90 是逆时针 → TRANS_ROT270 → rotate(1.5π)）
 *   ③ 变换后目标矩形的包围盒必须正好落在调用点给的 (x,y) 上、旋转时宽高互换
 *      —— 只断言"有调用"是不够的：方向/锚点错了画面照样错位
 *   ④ fillTriangle/drawTriangle/fillPolygon 的填充色与顶点
 *   ⑤ drawPixels(byte[]) 单色位图逐像素展开正确（含 mask）
 *
 * 用法：node tools/test-nokia-dg.mjs
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const TEST_JAR = join(root, 'tools', 'nokia-test', 'dgtest.jar');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Math.abs(actual - expected) < 1e-6 || String(actual) === String(expected);
  if (ok) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + ': actual=' + actual + ' expected=' + expected); }
}
function checkStr(name, actual, expected) {
  if (actual === expected) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + ': actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected)); }
}

// ---- 画布：跟踪 2D 变换矩阵 + 记录绘制调用 ----
const PI = Math.PI;
const draws = [];      // 每次 drawImage：{ t, dx, dy, dw, dh, bbox, ops }
const pens = [];       // fill/stroke：{ style, pts }
const imageDataLog = [];
const logs = [];

function mul(m, n) {   // 画布 2D 矩阵按 [a,b,c,d,e,f] 约定：x' = a*x + c*y + e
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function makeCtx(canvas) {
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let ops = [];               // 自上次 drawImage 以来的变换操作
  let path = [];
  const state = { fillStyle: '#000', strokeStyle: '#000' };
  const handlers = {
    save() { stack.push(m.slice()); },
    restore() { if (stack.length) m = stack.pop(); },
    translate(x, y) { m = mul(m, [1, 0, 0, 1, x, y]); ops.push('translate:' + x + ',' + y); },
    scale(x, y) { m = mul(m, [x, 0, 0, y, 0, 0]); ops.push('scale:' + x + ',' + y); },
    rotate(a) { m = mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); ops.push('rotate:' + a.toFixed(3)); },
    drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
      if (arguments.length === 3) {   // c.drawImage(canvas, x, y) 形式
        dx = sx; dy = sy; dw = src.width; dh = src.height; sx = sy = 0; sw = dw; sh = dh;
      }
      const pts = [[dx, dy], [dx + dw, dy], [dx, dy + dh], [dx + dw, dy + dh]].map(([x, y]) =>
        [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      draws.push({
        dx, dy, dw, dh, ops: ops.slice(),
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      });
      ops = [];
    },
    createImageData(w, h) {
      const d = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      imageDataLog.push(d);
      return d;
    },
    getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() {},
    beginPath() { path = []; },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    closePath() {},
    fill() { pens.push({ kind: 'fill', style: state.fillStyle, pts: path.slice() }); },
    stroke() { pens.push({ kind: 'stroke', style: state.strokeStyle, pts: path.slice() }); },
    fillRect() {}, strokeRect() {}, fillText() {}, strokeText() {}, drawString() {},
    setTransform() {}, measureText: (s) => ({ width: String(s).length * 8 }),
  };
  return new Proxy({}, {
    get(obj, p) {
      if (p === 'canvas') return canvas;
      if (p in handlers) return handlers[p];
      if (p === 'fillStyle' || p === 'strokeStyle') return state[p];
      if (p === 'globalAlpha') return 1;
      return () => {};
    },
    set(obj, p, v) { if (p === 'fillStyle' || p === 'strokeStyle') state[p] = v; return true; },
  });
}

class StubCanvas {
  constructor(w, h) { this.width = w || 300; this.height = h || 150; this.style = {}; this._ctx = null; }
  getContext() { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  addEventListener() {} removeEventListener() {} dispatchEvent() {}
}
globalThis.__stubCanvasClass = StubCanvas;
globalThis.OffscreenCanvas = StubCanvas;

// 采集日志（宿主把 Java 的 println 桥到 console）
const origLog = console.log, origWarn = console.warn, origErr = console.error;
const capture = (orig) => function (...a) {
  const s = a.map(String).join(' ');
  logs.push(s);
  if (/\[dg\]|implementation|not implemented/.test(s)) { try { orig(s); } catch (e) { /* 忽略 */ } }
};
console.log = capture(origLog);
console.warn = capture(origWarn);
console.error = capture(origErr);

// Java 侧字符串经桥接后每字节 = 一个 U+FFxx 码位
const decodeBridge = (str) => {
  const bytes = []; let suspicious = false;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c >= 0xff00 && c <= 0xffff) { bytes.push(c & 0xff); suspicious = true; }
    else return str;
  }
  if (!suspicious) return str;
  const d = Buffer.from(bytes).toString('utf8');
  return d.includes('\uFFFD') ? str : d;
};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.J2ME_TEST_JAR = TEST_JAR;
console.log('=== test-nokia-dg: jar=' + TEST_JAR + ' ===');

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  console.error('[dg] 入口异常: ' + ((err && err.stack) || err));
  process.exit(1);
});

setTimeout(() => {
  // 结论阶段恢复正常输出（采集期把 console.log 换成了过滤器，PASS/FAIL 行会被吞掉）
  console.log = origLog;
  console.warn = origWarn;
  console.error = origErr;

  const lines = logs.map(decodeBridge);
  const joined = lines.join('\n');

  console.log('\n--- test-nokia-dg 结论 ---');
  checkStr('MIDlet 跑完（[dg] done）', /\[dg\] done/.test(joined), true);

  // ① 缺失 native 指纹：com/nokia 下任何一条都不该出现
  const missing = lines.filter((l) => /com\/nokia[^\s]*.*does not have an implementation/.test(l));
  checkStr('没有 com/nokia 未实现 native 的报错（本次 bug 的直接指纹）',
    missing.length ? missing[0].slice(0, 150) : '无', '无');
  const missingDrawImage = lines.filter((l) => /DirectGraphicsImp\.drawImage/.test(l));
  checkStr('drawImage 没有落成"未实现"', missingDrawImage.length ? missingDrawImage[0].slice(0, 120) : '无', '无');

  // ② 8 种 manipulation 的变换序列 + ③ 目标矩形包围盒
  //    manipulation → 期望的 rotate/scale 序列（renderRegion 实现）
  //    ⚠️ 必须用**有序数组**而不是 Object.keys：JS 会把整数样式的键按数值升序重排，
  //       顺序一乱，(画第 i 次) 与 (第 i 种 manipulation) 就对不上了（踩过）
  const cases = [
    [0, []],
    [8192, ['scale:-1,1']],
    [16384, ['scale:1,-1']],
    [90, ['rotate:4.712']],             // Nokia 逆时针 90 == MIDP TRANS_ROT270
    [180, ['rotate:3.142']],
    [270, ['rotate:1.571']],
    [8192 | 90, ['rotate:1.571', 'scale:-1,1']],   // TRANS_MIRROR_ROT90
    [16384 | 90, ['rotate:4.712', 'scale:-1,1']],  // TRANS_MIRROR_ROT270
  ];
  check('drawImage 共 9 次（8 种 manipulation + drawPixels 内部那次 blit）', draws.length, 9);
  cases.forEach(([man, wantOps], i) => {
    const d = draws[i];
    if (!d) { check('man=' + man + ' 有 drawImage', 'missing', 'present'); return; }
    // renderRegion 画完会把画布变换**还原**（比如 rotate(1.5π) 再 draw 完 rotate(0.5π)），
    // 那些补偿操作会留在下一次调用的 ops 前缀里；Graphics 状态应用还会插 translate。
    // 所以只取 rotate/scale 序列的**尾部**与被测那一次自己的变换比 —— 尾部正好是它的。
    const tf = d.ops.filter((o) => o.indexOf('rotate:') === 0 || o.indexOf('scale:') === 0);
    checkStr('man=' + man + ' 变换序列（尾部）', tf.slice(-wantOps.length).join('|'), wantOps.join('|'));
    if (!wantOps.length) check('man=' + man + ' 不带任何 rotate/scale', tf.length, 0);
    // 调用点给的 x=10+i*20, y=30；旋转时目标框宽高互换（4x2 → 2x4）
    const x = 10 + i * 20, y = 30;
    const rot = man & ~(8192 | 16384);
    const rotated = rot === 90 || rot === 270;
    const want = rotated ? [x, y, x + 2, y + 4] : [x, y, x + 4, y + 2];
    const got = d.bbox.map((v) => Math.round(v * 1000) / 1000);
    check('man=' + man + ' 目标框包围盒 = [' + want.join(',') + ']', got.join(','), want.join(','));
  });

  // ④ 三角形 / 多边形
  checkStr('fillTriangle 顶点与颜色',
    JSON.stringify(pens.filter((p) => p.kind === 'fill' && p.pts.length === 3 && p.style === 'rgba(0,255,0,1)')[0] || null),
    JSON.stringify({ kind: 'fill', style: 'rgba(0,255,0,1)', pts: [[5, 100], [25, 100], [15, 120]] }));
  checkStr('drawTriangle 顶点与颜色（stroke）',
    JSON.stringify(pens.filter((p) => p.kind === 'stroke' && p.style === 'rgba(0,0,255,1)')[0] || null),
    JSON.stringify({ kind: 'stroke', style: 'rgba(0,0,255,1)', pts: [[5, 130], [25, 130], [15, 150]] }));
  checkStr('fillPolygon 顶点与颜色',
    JSON.stringify(pens.filter((p) => p.kind === 'fill' && p.style === 'rgba(255,0,0,1)')[0] || null),
    JSON.stringify({ kind: 'fill', style: 'rgba(255,0,0,1)', pts: [[40, 100], [60, 100], [50, 120]] }));
  checkStr('setARGBColor/getAlphaComponent', /\[dg\] alpha=255/.test(joined), true);
  checkStr('getNativePixelFormat 报 4444（我们自己支持的那个）', /\[dg\] fmt=4444/.test(joined), true);
  checkStr('MIDlet 里没有异常', /\[dg\] 异常/.test(joined), false);

  // ⑤ 单色位图逐像素：0xB1 = 1011 0001（位=1 → 黑 0，位=0 → 白 255），mask 全 1 → 全不透明
  const px = imageDataLog.filter((d) => d.width === 8 && d.height === 1)[0];
  if (!px) { check('drawPixels 产生了 8x1 的 ImageData', 'missing', 'present'); }
  else {
    const got = [];
    for (let i = 0; i < 8; i++) got.push(px.data[i * 4] === 0 ? 'K' : (px.data[i * 4] === 255 ? 'W' : '?'));
    checkStr('drawPixels(byte[]) 单色展开（K=黑 W=白）', got.join(''), 'K W K K W W W K'.replace(/ /g, ''));
    check('drawPixels alpha 全不透明', px.data[3], 255);
    check('drawPixels 第 5 像素透明位正确（mask=1 → 255）', px.data[4 * 4 + 3], 255);
  }

  console.log('');
  console.log(`结果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}, 12000);
