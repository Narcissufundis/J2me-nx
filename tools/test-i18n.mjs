#!/usr/bin/env node
/*
 * test-i18n.mjs — 类库补全端到端验证（GBK 编码 / StringBuilder / LayerManager）
 *
 * 装配同 test-softrestart.mjs（stub canvas + eval app/main.js），
 * J2ME_TEST_JAR 指向 I18nTest.jar；VM 跑 I18nTestMIDlet 输出标记行：
 *   GBK-TEST / GBK-ENC / SB / LM-TEST / ALL-DONE / TEST-FAIL
 * 20s 后断言并退出。
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';

process.env.J2ME_TEST_JAR = join(root, 'tools', 'i18n-test', 'I18nTest.jar');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const output = [];
const origLog = console.log;
console.log = function (...args) {
  const line = args.map(String).join(' ');
  output.push(line);
  origLog(line);
};

// MIDlet System.out 在 Node 仿真下走 pluot.js 的 process.stdout.write（绕过 console.log），必须单独捕获
const rawStdout = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, ...rest) {
  try { rawStdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); } catch (e) { /* 忽略 */ }
  return origStdoutWrite(chunk, ...rest);
};

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
// main.js 求值期捕获 rAF（Node 无原生 rAF），必须预置
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

function summarize(code) {
  // MIDlet System.out 捕获源：① console.log 拦截 ② process.stdout.write 拦截 ③ data/error.log
  let all = output.join('\n') + '\n' + rawStdout.join('');
  try {
    all += '\n' + readFileSync(join(root, 'data', 'error.log'), 'utf8');
  } catch (e) { /* 忽略 */ }
  const checks = [
    ['GBK 解码（Helper/GBK_Reader/Conv）', /GBK-TEST:codes=20013,25991,79,75,len=4/.test(all)],
    ['GBK 编码回环', /GBK-ENC:len=8 first=214,208/.test(all)],
    ['StringBuilder', /SB:123-true-4\.5/.test(all)],
    ['LayerManager', /LM-TEST:size=0 view=176x220/.test(all)],
    ['全部完成', /ALL-DONE/.test(all)],
    ['无 TEST-FAIL', !/TEST-FAIL/.test(all)],
  ];
  console.log('\n===== 类库补全验证结果 =====');
  let pass = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name);
    if (ok) pass++;
  }
  console.log(pass + '/' + checks.length + ' 通过');
  process.reallyExit(code);
}

// main.js 在 MIDlet 退出时会调 process.exit——先出报告再真退
const origExit = process.exit;
process.exit = function (code) {
  summarize(code || 0);
};

setTimeout(() => {
  summarize(0);
}, 20000);

process.on('unhandledRejection', (reason) => {
  console.log('[probe] 未处理 rejection: ' + reason);
});

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  console.error('[probe] 入口异常: ' + (err && err.stack || err));
  process.exit(1);
});
