#!/usr/bin/env node
/*
 * jit-compile-all.mjs — 对 data/midlet.jar 全类直编 JIT 验证
 *
 * 不跑游戏（绕开 Node 仿真下游戏的初始化差异）：stub 引导 VM 后，
 * 用 python 列出 jar 内全部 .class 条目 → 逐类 CLASSES.loadClass →
 * 对每个带 code 的方法直接调 J2ME.compileAndLinkMethod，
 * 统计 [jit-fail]（Too many loops / referencedClasses 等）。
 *
 * 用法: node tools/jit-compile-all.mjs [类名过滤前缀，如 u.]
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
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

// ---- 等 VM 就绪后全类直编 ----
const PY = 'C:/Users/Admin/.workbuddy/binaries/python/versions/3.13.12/python.exe';
let probeCount = 0;
const waitAndCompile = setInterval(() => {
  probeCount++;
  const J2ME = globalThis.J2ME;
  if (probeCount % 4 === 0) {
    origLog('[jit-all] probe J2ME=' + (typeof J2ME) +
      ' CLASSES=' + (J2ME && typeof J2ME.CLASSES) +
      ' JARStore=' + (J2ME && typeof J2ME.JARStore) +
      ' compileFn=' + (J2ME && typeof J2ME.compileAndLinkMethod) +
      ' gJARStore=' + (typeof globalThis.JARStore) +
      ' gJVM=' + (typeof globalThis.JVM) +
      ' gMIDP=' + (typeof globalThis.MIDP));
  }
  if (!J2ME || !J2ME.CLASSES || !J2ME.compileAndLinkMethod) return;
  const JARStore = J2ME.JARStore || globalThis.JARStore;
  if (!JARStore) return;
  // 再等一拍，让 main.js 自身的启动序列先跑完（避免与 VM 启动互相踩）
  clearInterval(waitAndCompile);
  setTimeout(() => {
    try {
      // python 列 jar 条目（bash 无 unzip；javap 链同款套路）
      const out = execFileSync(PY, ['-c',
        'import zipfile;print("\\n".join(n[:-6] for n in zipfile.ZipFile("data/midlet.jar").namelist() if n.endswith(".class")))'
      ], { cwd: root, encoding: 'utf8', timeout: 30000 });
      const classNames = out.split('\n').map(s => s.trim()).filter(s => s && s !== 'module-info');
      origLog('[jit-all] jar 类总数: ' + classNames.length);

      let loaded = 0, loadErr = 0;
      const classInfos = [];
      for (const name of classNames) {
        try {
          classInfos.push(J2ME.CLASSES.loadClass(name));
          loaded++;
        } catch (e) {
          loadErr++;
        }
      }
      origLog('[jit-all] 类加载: ok=' + loaded + ' err=' + loadErr);

      const MS = J2ME.MethodState;
      // 直编验证必须绕过编译预算门（每秒 80ms 节流会推迟方法），强制全量编译
      if (globalThis.config) globalThis.config.forceRuntimeCompilation = true;
      let compiled = 0, failed = 0, skipped = 0;
      const fails = [];
      for (const ci of classInfos) {
        let methods;
        try { methods = ci.getMethods(); } catch (e) { continue; }
        for (const mi of methods) {
          try {
            if (!mi.codeAttribute || mi.isAbstract || mi.isNative) continue;
            J2ME.compileAndLinkMethod(mi);
            if (mi.state >= MS.Compiled) compiled++;
            else if (mi.state === MS.CannotCompile) { failed++; fails.push(mi.implKey); }
            else skipped++;
          } catch (e) {
            failed++;
            fails.push(mi.implKey + ' :: ' + (e && e.message || e));
          }
        }
      }
      origLog('===== JIT 直编结果 =====');
      origLog('compiled=' + compiled + ' failed=' + failed + ' skipped=' + skipped);
      for (const f of fails.slice(0, 30)) origLog('  FAIL ' + f);
      if (failed === 0) origLog('ALL-COMPILE-CLEAN');
      process.exit(failed === 0 ? 0 : 3);
    } catch (e) {
      origLog('[jit-all] 执行失败: ' + (e && e.stack || e));
      process.exit(1);
    }
  }, 8000);
}, 500);

// 总超时
setTimeout(() => { origLog('[jit-all] 90s 超时'); process.exit(2); }, 90000);
