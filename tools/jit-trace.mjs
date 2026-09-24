#!/usr/bin/env node
/*
 * jit-trace.mjs — Node 仿真下跑 data/midlet.jar，观察 JIT 行为探针
 * 输出过滤：[jit-try] / [jit] / [jit-fail] / [jit-skip] / [hot-top10] /
 *           [drawRGB-guard] / [present] / [boot]
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const WINDOW_MS = Number(process.argv[2] || 45000);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const origLog = console.log;
console.log = function (...args) { origLog(args.map(String).join(' ')); };

let canvasSeq = 0;
class StubCanvas {
  constructor(w, h) {
    this.__id = ++canvasSeq;
    this.__w = w | 0 || 300;
    this.__h = h | 0 || 150;
    this.style = {};
    this._ctx = null;
  }
  get width() { return this.__w; }
  set width(v) { this.__w = v | 0; }
  get height() { return this.__h; }
  set height(v) { this.__h = v | 0; }
  getContext() { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {}
}
globalThis.__stubCanvasClass = StubCanvas;
globalThis.OffscreenCanvas = StubCanvas;
globalThis.screen = new StubCanvas(1280, 720);
globalThis.requestAnimationFrame = function (cb) { return setTimeout(() => cb(Date.now()), 16); };

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
      return function () {};
    },
    set(obj, prop, value) { obj[prop] = value; return true; },
  });
}

process.on('unhandledRejection', (reason) => {
  origLog('[probe] 未处理 rejection: ' + reason);
});

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  origLog('[probe] 入口异常: ' + (err && err.stack || err));
  process.exit(1);
});

setTimeout(() => {
  origLog('[jit-trace] 观察窗口结束');
  process.exit(0);
}, WINDOW_MS);
