#!/usr/bin/env node
// 临时探针：追查 zxx.jar 资源 PNG 解码链路
process.on('unhandledRejection', (r) => console.log('[unhandled] ' + (r && r.stack || r)));
function makeCtx(canvas) {
  const target = {};
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === 'canvas') return canvas;
      if (prop in obj) return obj[prop];
      return function () { };
    },
    set(obj, prop, value) { obj[prop] = value; return true; },
  });
}
class StubCanvas {
  constructor(w, h) { this.width = w || 300; this.height = h || 150; this.style = {}; this._ctx = null; }
  getContext() { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  addEventListener() { } removeEventListener() { }
}
globalThis.__stubCanvasClass = StubCanvas;

import('file:///F:/Deepseek/j2me-nx-port/app/main.js').catch(e => console.error('入口: ' + e.stack));

// 等环境就绪后挂钩 Image/Blob/URL 观察解码
setTimeout(() => {
  const g = globalThis;
  const OrigBlob = g.Blob;
  g.Blob = function (parts, opts) {
    const b = new OrigBlob(parts, opts);
    b._origLen = parts && parts[0] && parts[0].length;
    return b;
  };
  g.Blob.prototype = OrigBlob.prototype;

  const desc = Object.getOwnPropertyDescriptor(g.Image.prototype, 'src');
  Object.defineProperty(g.Image.prototype, 'src', {
    set: function (v) {
      console.log('[probe] img.src = ' + v + (this.__tag || ''));
      desc.set.call(this, v);
      const oldOnload = this.onload, oldOnerr = this.onerror;
      this.onload = function (e) { console.log('[probe] onload size=' + this.naturalWidth + 'x' + this.naturalHeight); oldOnload && oldOnload.call(this, e); };
      this.onerror = function (e) { console.log('[probe] onerror!'); oldOnerr && oldOnerr.call(this, e); };
    },
    get: desc.get,
  });
  console.log('[probe] 钩子已挂');
}, 1500);

setTimeout(() => process.exit(0), 22000);
