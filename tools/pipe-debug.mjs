// pipe-debug.mjs — 临时诊断：完整启动序列 + 管道流动观察
process.on('unhandledRejection', (r) => console.log('[unhandled] ' + (r && r.stack || r)));
process.on('uncaughtException', (e) => console.log('[uncaught] ' + (e && e.stack || e)));

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

class StubCanvas {
  constructor(w, h) {
    this.width = w || 300; this.height = h || 150; this.style = {}; this._ctx = null;
  }
  getContext(kind) { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  addEventListener() {} removeEventListener() {}
}
globalThis.__stubCanvasClass = StubCanvas;
globalThis.__debugPipes = true;

import('file:///F:/Deepseek/j2me-nx-port/app/main.js').catch(e => console.error('入口: ' + e.stack));

setTimeout(() => {
  const g = globalThis;
  console.log('--- 状态 ---');
  console.log('DumbPipe: ' + typeof g.DumbPipe + ', start: ' + typeof g.start + ', jvm: ' + typeof g.jvm);
  console.log('bigBang: ' + g.bigBang);
  console.log('MIDP.midletStarted: ' + (g.MIDP && g.MIDP.midletStarted));
  process.exit(0);
}, 10000);
