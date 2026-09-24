#!/usr/bin/env node
/*
 * probe-geom.mjs — 复现"176x220 不居中"：
 * 跑 simulate 同款装配，但 ctx stub 记录每笔绘图的坐标 bbox，
 * 观察游戏在给定分辨率下的实际作画范围。
 * 用法: node tools/probe-geom.mjs <jar路径> [WxH|-]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const jar = resolve(process.argv[2] || '');
const forceRes = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : '';
process.env.J2ME_TEST_JAR = jar;
if (forceRes) process.env.J2ME_TEST_RES = forceRes;

// ---- 带坐标记录的 stub canvas（复刻 simulate.mjs + bbox 记录）----
const drawStats = { calls: 0, flushes: 0, lastCall: '' };
globalThis.__drawStats = drawStats;

// 每个"会话帧"的 bbox：按 200 次调用分桶输出，避免刷屏
const ops = [];
globalThis.__opLog = [];
globalThis.__borderStacks = [];
let bucket = { n: 0, minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9, methods: {} };
const buckets = [bucket];

const DRAW_METHODS = new Set(['drawImage', 'drawRect', 'fillRect', 'drawLine', 'drawString',
  'drawChars', 'drawArc', 'fillArc', 'drawRoundRect', 'fillRoundRect', 'drawRegion',
  'fillTriangle', 'drawRGB', 'drawSubstring', 'setClip', 'translate', 'drawPixels',
  'fillText', 'strokeRect', 'clearRect', 'drawText']);

function recordOp(prop, args) {
  // 抓边条绘制调用栈（fillRect(0,0,32,320)/(208,0,32,320)/(32,0,176,50)/(32,270,176,50)）
  if (prop === 'fillRect' && args.length >= 4 &&
      ((args[0] === 0 && args[1] === 0 && args[2] === 32) ||
       (args[0] === 208 && args[2] === 32) ||
       (args[0] === 32 && (args[1] === 0 || args[1] === 270) && args[3] === 50))) {
    if (globalThis.__borderStacks.length < 4) {
      globalThis.__borderStacks.push(prop + '(' + args.join(',') + ')\n' +
        new Error().stack.split('\n').slice(1, 10).map(s => s.trim().slice(0, 150)).join('\n'));
    }
  }
  // 前 40 笔：完整参数 dump（定位游戏布局假设）；其后记入 bbox 分桶
  if (globalThis.__opLog.length < 40) {
    globalThis.__opLog.push(prop + '(' + args.map(a =>
      typeof a === 'number' ? (Math.round(a * 100) / 100) : typeof a).join(', ').slice(0, 120) + ')');
  }
  // 取前两个数值参数作为 x,y（vendor gfx 层的绘制基本都是 x,y 打头）
  let x = null, y = null;
  for (let i = 0; i < Math.min(4, args.length); i++) {
    if (typeof args[i] === 'number' && isFinite(args[i])) {
      if (x === null) { x = args[i]; continue; }
      y = args[i]; break;
    }
  }
  if (x === null || y === null) return;
  if (bucket.n >= 400) {
    bucket = { n: 0, minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9, methods: {} };
    buckets.push(bucket);
  }
  bucket.n++;
  if (x < bucket.minX) bucket.minX = x;
  if (y < bucket.minY) bucket.minY = y;
  if (x > bucket.maxX) bucket.maxX = x;
  if (y > bucket.maxY) bucket.maxY = y;
  bucket.methods[prop] = (bucket.methods[prop] || 0) + 1;
}

function makeCtx(canvas) {
  const special = {
    measureText: (t) => ({ width: String(t).length * 8 }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  const target = {};
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === 'canvas') return canvas;
      if (prop in obj) return obj[prop];
      if (prop in special) return special[prop];
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') {
        return function () { return { addColorStop: function () {} }; };
      }
      if (DRAW_METHODS.has(prop)) {
        return function (...args) {
          drawStats.calls++;
          drawStats.lastCall = prop;
          recordOp(prop, args);
        };
      }
      return function () {};
    },
    set(obj, prop, value) { obj[prop] = value; return true; },
  });
}

class StubCanvas {
  constructor(w, h) { this.width = w || 300; this.height = h || 150; this.style = {}; this._ctx = null; }
  getContext() { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  addEventListener() {} removeEventListener() {}
}
globalThis.__stubCanvasClass = StubCanvas;

// ---- 跑 main.js（与 simulate.mjs 相同的加载方式）----
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const deadline = setTimeout(() => {
  console.error('[probe] 超时（35s）');
  printReport();
  process.exit(2);
}, 35000);

function printReport() {
  console.log('\n===== 边条绘制调用栈 =====');
  if (globalThis.__borderStacks.length) {
    console.log(globalThis.__borderStacks.join('\n\n---\n\n'));
  } else {
    console.log('(无边条绘制)');
  }
  console.log('\n===== 前 40 笔绘图完整参数 =====');
  console.log(globalThis.__opLog.join('\n'));
  console.log('\n===== 绘图坐标 bbox 分桶（每桶 400 次调用）=====');
  const live = buckets.filter(b => b.n > 0);
  for (let i = 0; i < live.length; i++) {
    const b = live[i];
    if (i < 6 || i >= live.length - 3) {
      console.log('桶' + i + ': n=' + b.n + '  x[' + b.minX + '..' + b.maxX + ']  y[' + b.minY + '..' + b.maxY + ']  方法=' + JSON.stringify(b.methods));
    } else if (i === 6) console.log('  ...（中间桶省略）');
  }
}

process.on('exit', printReport);

import { pathToFileURL } from 'node:url';

process.on('exit', printReport);

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  console.error('[probe] 入口异常: ' + (err && err.stack || err));
  process.exit(1);
});
