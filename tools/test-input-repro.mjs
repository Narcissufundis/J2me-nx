#!/usr/bin/env node
/*
 * test-input-repro.mjs — 带按键注入的游戏复现（Node）
 *
 * 用法: node tools/test-input-repro.mjs <game.jar> [入口类]
 * 流程: 复用 game-test.mjs 的装配（data/midlet.jar + jad），跑 simulate 环境，
 *       在 8s/10s/12s/14s 注入 上/下/确认 键，观察 [console.error]/异常输出。
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const jarPath = process.argv[2];
const entryOverride = process.argv[3];

if (!jarPath) {
  console.error('用法: node tools/test-input-repro.mjs <game.jar> [入口类]');
  process.exit(1);
}

const JAR_TOOL = 'D:/j2me/jdk1.8.0_281/bin/jar.exe';
const tmp = join(root, '.tmp-manifest');
mkdirSync(tmp, { recursive: true });
execFileSync(JAR_TOOL, ['xf', jarPath, 'META-INF/MANIFEST.MF'], { cwd: tmp });
const manifest = readFileSync(join(tmp, 'META-INF/MANIFEST.MF'), 'utf8');

let entry = entryOverride;
if (!entry) {
  // 与设备端一致的续行处理：去掉续行首空格直接拼接
  const fixed = manifest.replace(/\r\n|\r/g, '\n').replace(/\n /g, '');
  const m = fixed.match(/^MIDlet-1\s*:\s*(.+)$/m);
  if (m) {
    const parts = m[1].split(',');
    entry = parts[parts.length - 1].trim().replace(/\//g, '.');
  }
}
console.log('[input-repro] 入口类: ' + entry);

copyFileSync(jarPath, join(root, 'data', 'midlet.jar'));
const jad = [
  'MIDlet-1: Game, icon.png, ' + entry,
  'MIDlet-Name: Game',
  'MIDlet-Vendor: test',
  'MIDlet-Version: 1.0',
  'MicroEdition-Profile: MIDP-2.0',
  'MicroEdition-Configuration: CLDC-1.1',
  'MIDlet-Jar-URL: midlet.jar',
  'MIDlet-Jar-Size: 999999',
  '',
].join('\n');
writeFileSync(join(root, 'data', 'midlet.jad'), jad);

// ---- stub canvas（与 simulate.mjs 相同的最小桩）----
const drawStats = { calls: 0, lastCall: '' };
globalThis.__drawStats = drawStats;
const DRAW_METHODS = new Set(['drawImage', 'drawRect', 'fillRect', 'drawLine', 'drawString',
  'drawChars', 'drawArc', 'fillArc', 'drawRoundRect', 'fillRoundRect', 'drawRegion',
  'fillTriangle', 'drawRGB', 'drawSubstring', 'setClip', 'translate', 'drawPixels']);
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
        return function () { drawStats.calls++; drawStats.lastCall = prop; };
      }
      return function () {};
    },
    set(obj, prop, value) { obj[prop] = value; return true; },
  });
}
class StubCanvas {
  constructor(w, h) { this.width = w || 240; this.height = h || 320; this.style = {}; this._ctx = null; }
  getContext() { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  addEventListener() {} removeEventListener() {}
}
globalThis.__stubCanvasClass = StubCanvas;

// ---- 启动 + 定时注入按键 ----
setTimeout(() => {
  const MIDP = globalThis.MIDP;
  if (!MIDP || !MIDP.sendKeyPress) { console.log('[input-repro] MIDP.sendKeyPress 不可用'); return; }
  const seq = [
    [115, 'down'], [119, 'up'], [32, 'fire'], [13, 'enter'], [115, 'down2'], [32, 'fire2'],
  ];
  let i = 0;
  const timer = setInterval(() => {
    if (i >= seq.length) { clearInterval(timer); return; }
    const [code, name] = seq[i++];
    console.log('[input-repro] key ' + name + ' (' + code + ')');
    try { MIDP.sendKeyPress(code); } catch (e) { console.log('[input-repro] press 异常: ' + (e && e.message)); }
    setTimeout(() => { try { MIDP.sendKeyRelease(code); } catch (e) {} }, 120);
  }, 1500);
}, 8000);

setTimeout(() => {
  console.log('[input-repro] 结束，绘制调用=' + drawStats.calls + ' 最后=' + drawStats.lastCall);
  process.exit(0);
}, 26000);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.on('unhandledRejection', (reason) => {
  console.log('[input-repro] unhandledRejection: ' + reason);
});

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  console.error('[input-repro] 入口异常: ' + (err && err.stack || err));
  process.exit(1);
});
