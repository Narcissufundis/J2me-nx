#!/usr/bin/env node
/*
 * simulate-audio.mjs — 音频测试 MIDlet 桌面验证
 * 在 simulate.mjs 基础上加最小 AudioContext stub，验证：
 *   1. 手搓的 AudioTest.class 能被 VM 解析并执行 startApp
 *   2. playTone / createPlayer(WAV) 调用链不抛错
 * 用法：先把 audiotest.jar/jad 复制为 data/midlet.jar/jad（外部脚本负责恢复）
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToURLSafe(import.meta.url)) + '/..';
function fileURLToURLSafe(u) { return fileURLToPath(u); }

const drawStats = { calls: 0, lastCall: '' };
globalThis.__drawStats = drawStats;

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
  constructor(w, h) { this.width = w || 300; this.height = h || 150; this.style = {}; this._ctx = null; }
  getContext() { if (!this._ctx) this._ctx = makeCtx(this); return this._ctx; }
  addEventListener() {} removeEventListener() {}
}
globalThis.__stubCanvasClass = StubCanvas;

// ---- AudioContext stub：严格照抄 nx.js 的实现面 ----
// nx.js 的 Web Audio 只实现了 createGain / createBuffer / createBufferSource /
// createStereoPanner / decodeAudioData，其余 create* 一律
// throw new Error('Method not implemented.')。
// 旧版 stub "什么都返回一个空节点"，把这一类 bug 全部掩盖了 —— 实机表现就是
// "能进游戏但全程无声"（createOscillator 在每个音符上抛异常）。
const NX_UNIMPLEMENTED = [
  'createAnalyser', 'createBiquadFilter', 'createChannelMerger', 'createChannelSplitter',
  'createConstantSource', 'createConvolver', 'createDelay', 'createDynamicsCompressor',
  'createIIRFilter', 'createOscillator', 'createPanner', 'createPeriodicWave',
  'createScriptProcessor', 'createWaveShaper',
];
const unimplementedHits = [];
function param(init = 0) {
  const p = {
    value: init,
    setValueAtTime() { return p; },
    linearRampToValueAtTime() { return p; },
    exponentialRampToValueAtTime(v) { if (v === 0) throw new RangeError('exp ramp to 0'); return p; },
    setTargetAtTime() { return p; },
    cancelScheduledValues() { return p; },
    cancelAndHoldAtTime() { return p; },
  };
  return p;
}
function audionode(kind) {
  const n = { __kind: kind, onended: null };
  n.connect = (d) => d;
  n.disconnect = () => {};
  n.start = () => {};
  n.stop = () => {};
  return n;
}
function audiobuffer(ch, len, sr) {
  if (!Number.isInteger(len) || len < 1) throw new RangeError('bad buffer length');
  if (!(sr >= 8000 && sr <= 192000)) throw new RangeError('bad sampleRate');
  const data = Array.from({ length: ch }, () => new Float32Array(len));
  return {
    numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr,
    getChannelData: (i) => data[i],
    copyToChannel: (src, i = 0, off = 0) => data[i].set(src.subarray(0, len - off), off),
    copyFromChannel: (dst, i = 0, off = 0) => dst.set(data[i].subarray(off, off + dst.length)),
  };
}
globalThis.AudioContext = class {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 48000;
    this.destination = audionode('destination');
    for (const m of NX_UNIMPLEMENTED) {
      this[m] = function () {
        unimplementedHits.push(m);
        throw new Error('Method not implemented.');
      };
    }
  }
  resume() {}
  suspend() {}
  close() {}
  createGain() { const n = audionode('gain'); n.gain = param(1); return n; }
  createBufferSource() {
    const n = audionode('source');
    n.buffer = null; n.loop = false; n.loopStart = 0; n.loopEnd = 0;
    n.playbackRate = param(1); n.detune = param(0);
    return n;
  }
  createStereoPanner() { const n = audionode('panner'); n.pan = param(0); return n; }
  createBuffer(ch, len, sr) { return audiobuffer(ch, len, sr); }
  decodeAudioData() {
    return Promise.resolve(audiobuffer(2, 72000, 48000));
  }
};
globalThis.__nxUnimplementedHits = unimplementedHits;

const deadline = setTimeout(() => {
  console.error('[sim-audio] 超时（30s）');
  process.exit(2);
}, 30000);

process.on('unhandledRejection', (reason) => {
  console.log('[sim-audio] 未处理 rejection: ' + reason);
});

import(pathToFileURL(join(root, 'app', 'main.js'))).catch((err) => {
  console.error('[sim-audio] 入口异常: ' + (err && err.stack || err));
  process.exit(1);
});

setTimeout(() => {
  const ok = typeof globalThis.J2ME !== 'undefined' && typeof globalThis.JVM !== 'undefined';
  console.log('---');
  const hits = globalThis.__nxUnimplementedHits || [];
  if (hits.length) {
    console.log(`[sim-audio] 用到了 nx.js 未实现的 Web Audio API ${hits.length} 次：` +
      Array.from(new Set(hits)).join(', ') + ' → 实机这些调用会抛异常（无声）');
  } else {
    console.log('[sim-audio] 未触碰任何 nx.js 未实现的 Web Audio API');
  }
  console.log('[sim-audio] 结论: ' + (ok ? 'VM 装配成功，见上方 AudioTest 输出' : '装配失败'));
  process.exit(ok && hits.length === 0 ? 0 : 1);
}, 20000);
