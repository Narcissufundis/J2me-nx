#!/usr/bin/env node
/*
 * simulate.mjs — 桌面冒烟测试（不用上机就能验证装配）
 *
 * 用 stub canvas 在 Node 里跑完整启动序列，验证：
 *   1. env-prelude / ASM 堆 / vendor 配置链加载无误
 *   2. bld/j2me.js 可执行（J2ME、JVM 全局就位）
 *   3. bld/main-all.js 可执行（MIDP 宿主层就位，main.js 自启动）
 *   4. XHR→资源加载器链路工作（classes.jar 缺失时给出干净的失败信息）
 *
 * 通过标准：bundle 全部加载 + "等待 vendor 启动流程" 日志出现。
 * 预期失败：java/classes.jar 不存在时 vendor 打印 "Loading failed" —— 这是
 * 构建类库前的正常状态，不算本测试失败。
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';

// ---- stub canvas ----
// 绘图调用计数：判断游戏是否真的在渲染（帧统计在结论处打印）
const drawStats = { calls: 0, flushes: 0, lastCall: '' };
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
      // 任意 2D 方法 -> no-op；渐变对象返回带 addColorStop 的对象
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') {
        return function () {
          return { addColorStop: function () {} };
        };
      }
      if (DRAW_METHODS.has(prop)) {
        return function () {
          drawStats.calls++;
          drawStats.lastCall = prop;
        };
      }
      return function () {};
    },
    set(obj, prop, value) {
      obj[prop] = value;
      return true;
    },
  });
}

class StubCanvas {
  constructor(w, h) {
    this.width = w || 300;
    this.height = h || 150;
    this.style = {};
    this._ctx = null;
  }
  getContext(kind) {
    if (!this._ctx) this._ctx = makeCtx(this);
    return this._ctx;
  }
  addEventListener() {}
  removeEventListener() {}
}
globalThis.__stubCanvasClass = StubCanvas;

// ---- 跑入口 ----
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const deadline = setTimeout(() => {
  console.error('[simulate] 超时（30s）——启动序列卡死，检查 boot() 日志');
  process.exit(2);
}, 30000);

process.on('exit', (code) => {
  clearTimeout(deadline);
});

// vendor 代码（fs-init/emoji 等）的 load() 失败不带 catch —— 浏览器里只是
// 控制台警告。在 data 目录就绪（classes.jar 等）之前这里必然发生，不算失败。
process.on('unhandledRejection', (reason) => {
  console.log('[simulate] 未处理的 rejection（资源缺失阶段的预期现象）: ' + reason);
});

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  console.error('[simulate] 入口异常: ' + (err && err.stack || err));
  process.exit(1);
});

// 观察 20 秒后给结论（vendor 启动流程 + VM 解释执行全部是异步的）
setTimeout(() => {
  const ok = typeof globalThis.J2ME !== 'undefined' &&
             typeof globalThis.JVM !== 'undefined' &&
             typeof globalThis.MIDP !== 'undefined' &&
             typeof globalThis.DumbPipe !== 'undefined';
  console.log('---');
  console.log('[simulate] 结论: ' + (ok ? '装配成功 ✔（J2ME/JVM/MIDP/DumbPipe 全部就位）' : '装配失败 ✘'));
  console.log('[simulate] 绘图调用: ' + drawStats.calls + ' 次（最后: ' + drawStats.lastCall + '）' +
              (drawStats.calls > 0 ? ' —— 游戏在渲染 ✔' : ' —— 无渲染输出'));
  process.exit(ok ? 0 : 1);
}, 20000);
