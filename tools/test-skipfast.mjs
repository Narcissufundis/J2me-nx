#!/usr/bin/env node
/*
 * test-skipfast.mjs — 资源流 skip 快进回归（perfZ22）
 *
 * 由来（2026-09-24 实机）：重装机兵2-火线突击"进图卡住"。
 *   [hot-top10] java/io/InputStream.skip=22% + com/sun/cldc/io/ResourceInputStream.read=19%，
 *   [vm-sample] 抓到当次 skip 的实参 64202 字节 —— 逐字节实现 = 6.4 万次 native 调用。
 * 这份测试跑 tools/skip-test/skiptest.jar（真 MIDlet，从自己 jar 里开资源流 → skip → read），
 * 断言两件事：
 *   ① 语义没被改坏：返回值 / EOF / n<=0 / mark-reset / skip 后批量 read 的对齐 / 交替走全程的校验和；
 *   ② 快进真的是 O(1)：512KB 里跳 500000 字节必须在阈值内完成（逐字节实现做不到）。
 *
 * 用法：node tools/skip-test/build.mjs && node tools/test-skipfast.mjs
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const TEST_JAR = join(root, 'tools', 'skip-test', 'skiptest.jar');
const SIZE = 512 * 1024;
// 500KB 的快进阈值：逐字节实现要 50 万次 native 调用（Node 上实测数百 ms~秒级），
// O(1) 推进是 0ms。取 300ms 既留出机器差异余量，又能把"退回逐字节"钉住。
const BIG_SKIP_MS_LIMIT = 300;

if (!existsSync(TEST_JAR)) {
  console.error('缺少 ' + TEST_JAR + '：先跑 node tools/skip-test/build.mjs');
  process.exit(1);
}
process.env.J2ME_TEST_JAR = TEST_JAR;

// 日志基线：data/error.log 是追加的，只统计**本次运行新写进去**的 [jit-trap] 行
const LOG_PATH = join(root, 'data', 'error.log');
let logBase = 0;
try { logBase = readFileSync(LOG_PATH).length; } catch (e) { logBase = 0; }
function newLogText() {
  try { return readFileSync(LOG_PATH).slice(logBase).toString('utf8'); } catch (e) { return ''; }
}

const results = [];
function assert(cond, label) {
  results.push((cond ? 'PASS ' : 'FAIL ') + label);
  console.log((cond ? '[PASS] ' : '[FAIL] ') + label);
}

// ---- 抓 MIDlet 输出（console.log 与 process.stdout.write 两条路都要）----
const output = [];
const origLog = console.log;
console.log = function () {
  const line = Array.prototype.map.call(arguments, String).join(' ');
  output.push(line);
  origLog(line);
};
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, ...rest) {
  try { output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); }
  catch (e) { /* 忽略 */ }
  return origWrite(chunk, ...rest);
};
function all() {
  let txt = output.join('\n');
  try { txt += '\n' + readFileSync(join(root, 'data', 'error.log'), 'utf8'); } catch (e) { /* 忽略 */ }
  return txt;
}
function marker(re) {
  const m = all().match(re);
  return m ? m : null;
}

// ---- stub canvas（与其它端到端脚本同一套）----
function makeCtx(canvas) {
  const special = {
    measureText: (t) => ({ width: String(t).length * 8 }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  return new Proxy({}, {
    get(obj, prop) {
      if (prop === 'canvas') return canvas;
      if (prop in obj) return obj[prop];
      if (prop in special) return special[prop];
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') {
        return function () { return { addColorStop() {} }; };
      }
      return function () {};
    },
    set(obj, prop, value) { obj[prop] = value; return true; },
  });
}
class StubCanvas {
  constructor(w, h) {
    this.__w = w | 0 || 300; this.__h = h | 0 || 150; this.style = {}; this._ctx = null;
  }
  get width() { return this.__w; }
  set width(v) { this.__w = v | 0; }
  get height() { return this.__h; }
  set height(v) { this.__h = v | 0; }
  getContext() { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  addEventListener() {} removeEventListener() {} dispatchEvent() {}
}
globalThis.__stubCanvasClass = StubCanvas;
globalThis.OffscreenCanvas = StubCanvas;
globalThis.screen = new StubCanvas(1280, 720);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// T8 的期望值：JS 侧用同一算法走一遍 512KB 模式流。
// ⚠️ 必须**带 EOF 夹取**：Java 侧的 skip 到流尾只会返回"剩余字节数"（标准语义），
//    漏掉这一点会算出 pos=524947 这种超过文件大小的期望值（第一版就踩了）。
const t8Expected = (() => {
  let pos = 0, sum = 0;
  while (pos < SIZE) {
    const sk = Math.min(997, SIZE - pos);
    if (sk <= 0) break;
    pos += sk;
    if (pos >= SIZE) break;
    sum = (sum + (pos & 0xFF)) & 0xFFFF;
    pos++;
  }
  return { pos: pos, sum: sum };
})();

let summarized = false;
function summarize(code) {
  if (summarized) return;
  summarized = true;
  const txt = all();
  const fail = marker(/TEST-FAIL:([^\n]*)/);
  assert(!fail, '没有 TEST-FAIL' + (fail ? '（' + fail[1] + '）' : ''));
  assert(/ALL-DONE/.test(txt), 'MIDlet 跑完全部用例');

  for (const n of [1, 2, 3, 4, 5, 6]) {
    const m = txt.match(new RegExp('T' + n + ':([^\\n]*)'));
    const line = m ? m[1] : '(没有 T' + n + ' 行)';
    assert(m && /ok=true/.test(line), 'T' + n + ' ok=true  → ' + line);
  }

  const t7 = txt.match(/T7:big=(\d+)ms small=(\d+)ms skip=(\d+)\/(\d+)/);
  if (!t7) {
    assert(false, 'T7 有耗时行');
  } else {
    const big = +t7[1], small = +t7[2];
    console.log('[info] 500000 字节 skip 用时 ' + big + 'ms（小 skip ' + small + 'ms；阈值 ' + BIG_SKIP_MS_LIMIT + 'ms）');
    assert(+t7[3] === 500000 && +t7[4] === 1000, 'T7 跳过字节数正确（' + t7[3] + '/' + t7[4] + '）');
    assert(big <= BIG_SKIP_MS_LIMIT,
      'T7 大 skip 是 O(1)（' + big + 'ms ≤ ' + BIG_SKIP_MS_LIMIT + 'ms）');
  }

  const t8 = txt.match(/T8:pos=(\d+) sum=(\d+)/);
  if (!t8) {
    assert(false, 'T8 有校验和行');
  } else {
    assert(+t8[1] === t8Expected.pos && +t8[2] === t8Expected.sum,
      'T8 skip+read 交替走完全程一致（pos=' + t8[1] + '/' + t8Expected.pos +
      ' sum=' + t8[2] + '/' + t8Expected.sum + '）');
  }

  // ---- T9/T10：DataInputStream 基元读取（perfZ24）----
  // 期望值独立算一遍：模式流第 i 字节 = i & 0xFF，大端拼。
  const exp = (() => {
    const at = (i) => i & 0xFF;
    const u16 = (i) => (at(i) << 8) | at(i + 1);
    let v2 = 0;
    for (let k = 2; k < 6; k++) v2 = (v2 * 256) + at(k);
    let v4 = 0n;
    for (let k = 7; k < 15; k++) v4 = v4 * 256n + BigInt(at(k));
    const v5 = (u16(15) & 0x8000) ? u16(15) - 0x10000 : u16(15);
    return { v1: u16(0), v2, v3: at(6), v4: v4.toString(), v5 };
  })();
  const t9 = txt.match(/T9:vals=(-?\d+),(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);
  if (!t9) {
    assert(false, 'T9 有基元读数值行');
  } else {
    const got = [t9[1], t9[2], t9[3], t9[4], t9[5]].join(',');
    const want = [exp.v1, exp.v2, exp.v3, exp.v4, exp.v5].join(',');
    assert(got === want, 'T9 基元读取数值正确（got=' + got + ' want=' + want + '）');
  }
  const t9t = txt.match(/T9:time=(\d+)ms n=(\d+) sum=(\d+)/);
  if (!t9t) {
    assert(false, 'T9 有耗时行');
  } else {
    const ms = +t9t[1];
    console.log('[info] 20 万次 readUnsignedShort 用时 ' + ms + 'ms（本机参考 ~590ms；只防灾难性退化）');
    // ⚠ 这里**故意**只用一个宽松上限：perfZ24 实测过"把基元批量化"（一次 read(b,0,n)
    //   代替逐字节 in.read()），同一次运行内 batch=449ms vs bytewise=282ms —— 批量化反而
    //   慢 1.6×（多一层 Java 调用与虚拟派发，而我们的 native read() 本身很便宜）。
    //   所以基元保持逐字节读；这条断言只用来抓"灾难性倒退"，不作为性能指标。
    assert(ms <= 3000, 'T9 基元读取没有被灾难性拖慢（' + ms + 'ms ≤ 3000ms）');
  }
  const t10 = txt.match(/T10:eof=(true|false)/);
  assert(t10 && t10[1] === 'true', 'T10 流尾 readShort 抛 EOFException（批量读没丢语义）');
  // T11：批量化 vs 逐字节的对照（**记录用**）。
  // ⚠ 不要在两边之间做"应当相等"的断言：batch 分支必然多一层 DataInputStream 方法调用，
  //   就算实现完全相同也会慢 1.5~1.7×（第一版断言就是这么假红的）。真正的结论来自
  //   perfZ24 那次受控 A/B（同一次运行内 batch=449ms vs bytewise=282ms ⇒ 批量化更慢，
  //   于是基元保持逐字节读），这里只留"灾难性退化"的上限。
  const t11 = txt.match(/T11:batch=(\d+)ms bytewise=(\d+)ms/);
  if (t11) {
    console.log('[info] readInt 十万次：走 DataInputStream ' + t11[1] + 'ms vs 手写逐字节 ' + t11[2] + 'ms' +
      '（比值 ' + (+t11[1] / Math.max(1, +t11[2])).toFixed(2) + '，含一层方法调用开销，仅作记录）');
    assert(+t11[1] <= 3000 && +t11[2] <= 3000,
      'T11 两种读法都没有灾难性退化（' + t11[1] + ' / ' + t11[2] + ' ms）');
  }

  // ---- T12：[jit-trap] 落盘限流（perfZ24）----
  // 200 次正常控制流的 EOFException 过去 = 400 次 __sdMark = 400 次**同步写卡**，
  // 全砸在"进游戏最忙"的那几秒。现在每个方法只完整落盘前 3 次 + 每 10s 一行汇总。
  const t12 = txt.match(/T12:caught=(\d+)\/(\d+)/);
  assert(t12 && t12[1] === t12[2] && +t12[2] === 200,
    'T12 制造了 200 次 Java 异常（caught=' + (t12 ? t12[1] : '?') + '）');
  const trapLines = (newLogText().match(/\[jit-trap\]/g) || []).length;
  // 只数 T12 那一条链（readByte）的行数：3 条完整 + 1 条"累计 N 次"汇总 = 4
  const readByteTraps = (newLogText().match(/\[jit-trap\][^\n]*DataInputStream\.readByte\.\(\)B/g) || []).length;
  console.log('[info] 200 次异常后，本次运行新增的 [jit-trap] 行数 = ' + trapLines +
    '（其中 readByte 链 ' + readByteTraps + ' 行；限流前这条链应为 ~400 行）');
  assert(trapLines >= 1, 'T12 [jit-trap] 落盘机制仍在工作（≥1 行）');
  assert(readByteTraps >= 1 && readByteTraps <= 4,
    'T12 readByte 的 trap 已限流（' + readByteTraps + ' 行 ≤ 4 = 3 条完整 + 1 条汇总）');
  // 总数上限放宽到 12：同一次运行里还有 Display.getDisplay / exitLoader 等**别处**的 trap
  assert(trapLines <= 12, 'T12 本次运行 [jit-trap] 总行数已限流（' + trapLines + ' 行 ≤ 12，限流前 ~400）');

  // 反向证据：这条链真的走的是 ResourceInputStream（而不是别的流实现）。
  // 由 MIDlet 自己打印流类名（T0），不靠翻日志 —— 日志里那句"ResourceInputStream"
  // 只会在恰好发生异常落盘时出现，拿它当断言会假红/假绿（发布快照里就踩到了）。
  const t0 = txt.match(/T0:stream=([^\s]+)/);
  assert(t0 && t0[1] === 'com.sun.cldc.io.ResourceInputStream',
    'T0 走的是 com.sun.cldc.io.ResourceInputStream（实际 ' + (t0 ? t0[1] : '未打印') + '）');

  console.log('\n===== 结果汇总 =====');
  console.log(results.join('\n'));
  // ⚠️ 必须先把 process.exit 还原：下面这行原本会落回被覆盖的版本，
  //    summarize 里 `if (summarized) return;` 直接返回 → 进程永不退出（踩过，
  //    表现为脚本跑完了但 shell 一直挂着）。
  process.exit = origExit;
  origExit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
}

process.on('unhandledRejection', (r) => console.log('[probe] rejection: ' + r));
const origExit = process.exit;
process.exit = function (code) { summarize(code || 0); };
setTimeout(() => summarize(0), 25000);

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  console.error('[probe] 入口异常: ' + (err && err.stack || err));
  origExit(1);
});
