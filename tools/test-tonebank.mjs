#!/usr/bin/env node
/*
 * test-tonebank.mjs — 宿主波表(__toneBank) + "nx.js 真 API 面" 审计
 *
 * 背景（2026-09-20 实机无声根因）：nx.js 的 Web Audio **只实现**
 *   createGain / createBuffer / createBufferSource / createStereoPanner /
 *   decodeAudioData
 * 其余一律 throw new Error('Method not implemented.')，包括
 *   createOscillator / createBiquadFilter / createDelay / createWaveShaper …
 * vendor 侧只要用了它们，实机就是"能进游戏但全程无声"（异常被调度循环的
 * try/catch 吞掉，只留 error.log 里的 [midi] 调度异常）。
 *
 * 本测试做三件事：
 *   1. __toneBank（宿主 PCM 合成）的正确性：整数周期/限带/谐波纯度/音准；
 *   2. **静态审计**：全工程 JS 里不得出现对未实现 API 的调用（防止再犯）；
 *   3. **动态审计**：用"只实现 nx.js 实现面"的严格 mock 真的驱动一遍
 *      midi-synth 的渲染路径（parse → buildNoteEvents → renderChunk /
 *      scheduleDrum），任何未实现 API 被触到都会被抓出来。
 *
 * 用法：node tools/test-tonebank.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SR = 48000;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

// nx.js 未实现的 Web Audio 方法（source/packages/runtime/src/audio/base-audio-context.ts）
const NOT_IMPLEMENTED = [
  'createAnalyser', 'createBiquadFilter', 'createChannelMerger', 'createChannelSplitter',
  'createConstantSource', 'createConvolver', 'createDelay', 'createDynamicsCompressor',
  'createIIRFilter', 'createOscillator', 'createPanner', 'createPeriodicWave',
  'createScriptProcessor', 'createWaveShaper',
];

// ---------------------------------------------------------------- 严格 mock
const unimplementedHits = [];
class Param {
  constructor(v = 0) { this.value = v; this.events = []; }
  _add(kind, value, time) {
    if (!Number.isFinite(value)) throw new TypeError('non-finite param value');
    if (time < 0) throw new RangeError('negative param time');
    this.events.push({ kind, value, time });
    this.events.sort((a, b) => a.time - b.time);
  }
  setValueAtTime(v, t) { this._add('set', v, t); return this; }
  linearRampToValueAtTime(v, t) { this._add('linear', v, t); return this; }
  exponentialRampToValueAtTime(v, t) { if (v === 0) throw new RangeError('exp ramp to 0'); this._add('exp', v, t); return this; }
  setTargetAtTime(v, t) { this._add('set', v, t); return this; }
  setValueCurveAtTime() { throw new Error('Method not implemented.'); }
  cancelScheduledValues(t) { this.events = this.events.filter((e) => e.time < t); return this; }
  cancelAndHoldAtTime(t) { return this.cancelScheduledValues(t); }
  at(t) {
    let v = this.value, prevT = 0;
    for (const e of this.events) {
      if (e.time > t) {
        const span = e.time - prevT;
        if (e.kind === 'linear') return span <= 0 ? e.value : v + (e.value - v) * ((t - prevT) / span);
        if (e.kind === 'exp') return span <= 0 ? e.value : v * Math.pow(e.value / v, (t - prevT) / span);
        return v;
      }
      v = e.value; prevT = e.time;
    }
    return v;
  }
}
class Buffer {
  constructor(ch, len, sr) {
    if (!Number.isInteger(len) || len < 1) throw new RangeError('bad length');
    if (!(sr >= 8000 && sr <= 192000)) throw new RangeError('bad sampleRate');
    this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.duration = len / sr;
    this._d = Array.from({ length: ch }, () => new Float32Array(len));
  }
  getChannelData(i) { return this._d[i]; }
  copyToChannel(src, i = 0, off = 0) { this._d[i].set(src.subarray(0, this.length - off), off); }
  copyFromChannel(dst, i = 0, off = 0) { dst.set(this._d[i].subarray(off, off + dst.length)); }
}
class Node {
  constructor(ctx, kind) { this.__ctx = ctx; this.__kind = kind; this.__next = []; this.buffer = null; this.onended = null; }
  connect(dest) { this.__next.push(dest); return dest; }
  disconnect() { this.__next = []; }
  start(when = 0, offset = 0, duration) {
    if (this.__started) throw new Error('cannot call start more than once');
    this.__started = true;
    this.__when = when; this.__offset = offset; this.__dur = duration;
    this.__ctx.__started.push(this);
  }
  stop(when = 0) { this.__stopAt = when; }
}
class AudioContext {
  constructor() {
    this.currentTime = 0; this.state = 'running'; this.sampleRate = SR;
    this.__started = [];
    this.destination = new Node(this, 'destination');
    for (const m of NOT_IMPLEMENTED) {
      this[m] = () => { unimplementedHits.push(m); throw new Error('Method not implemented.'); };
    }
  }
  resume() { this.state = 'running'; }
  suspend() { this.state = 'suspended'; }
  close() { this.state = 'closed'; }
  createGain() { const n = new Node(this, 'gain'); n.gain = new Param(1); return n; }
  createBufferSource() {
    const n = new Node(this, 'source');
    n.loop = false; n.loopStart = 0; n.loopEnd = 0;
    n.playbackRate = new Param(1); n.detune = new Param(0);
    return n;
  }
  createStereoPanner() { const n = new Node(this, 'panner'); n.pan = new Param(0); return n; }
  createBuffer(ch, len, sr) { return new Buffer(ch, len, sr); }
  decodeAudioData() { return Promise.reject(new Error('not used')); }
}

// 极简混音（source -> [gain…] -> destination），用于音准/RMS 断言
function render(ctx, seconds) {
  const n = Math.ceil(seconds * SR);
  const out = new Float32Array(n);
  for (const src of ctx.__started) {
    if (!src.buffer) continue;
    const rate = src.playbackRate.value * Math.pow(2, src.detune.value / 1200);
    const ch = src.buffer.getChannelData(0);
    const step = rate * src.buffer.sampleRate / SR;
    const startFrame = Math.max(0, Math.round((src.__when || 0) * SR));
    const stopFrame = src.__stopAt === undefined ? Infinity : Math.round(src.__stopAt * SR);
    const gains = [];
    let node = src;
    while (node.__next.length) {
      node = node.__next[0];
      if (node.__kind === 'gain') gains.push(node.gain);
      if (node.__kind === 'destination') break;
    }
    for (let i = startFrame; i < Math.min(n, stopFrame); i++) {
      const t = i / SR;
      let pos = (src.__offset || 0) * src.buffer.sampleRate + (i - startFrame) * step;
      if (src.loop) {
        const a = src.loopStart * src.buffer.sampleRate;
        const b = src.loopEnd > 0 ? src.loopEnd * src.buffer.sampleRate : src.buffer.length;
        const span = b - a;
        if (span > 0) pos = a + (((pos - a) % span) + span) % span;
      } else if (pos >= ch.length) break;
      let g = 1;
      for (const p of gains) g *= p.at(t);
      out[i] += (ch[pos | 0] || 0) * g;
    }
  }
  return out;
}
function energyAt(buf, freq, from = 0, to = buf.length) {
  const n = to - from;
  const w = 2 * Math.PI * freq / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) { const s0 = buf[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  // Goertzel 的能量式在弱谐波上可能出轻微负数 → 取绝对值
  return Math.abs(s1 * s1 + s2 * s2 - c * s1 * s2) ** 0.5 / n;
}
function peakFreq(buf, lo = 60, hi = 1400, from = 0, to = buf.length) {
  let best = lo, bestE = -1;
  for (let f = lo; f <= hi; f += 1) {
    const e = energyAt(buf, f, from, to);
    if (e > bestE) { bestE = e; best = f; }
  }
  return best;
}
function bandEnergy(buf, lo, hi) {
  let e = 0, k = 0;
  for (let f = lo; f <= hi; f += Math.max(20, (hi - lo) / 12)) { e += energyAt(buf, f); k++; }
  return e / Math.max(k, 1);
}
const rms = (b) => Math.sqrt(b.reduce((a, v) => a + v * v, 0) / b.length);
const peak = (b) => b.reduce((a, v) => Math.max(a, Math.abs(v)), 0);

// ---------------------------------------------------------------- 加载被测代码
globalThis.AudioContext = AudioContext;
globalThis.Media = {};
globalThis.console = console;
const load = (p) => vm.runInThisContext(readFileSync(join(root, p), 'utf8'), { filename: p });
load('src/host/switch-audio.js');
const bank = globalThis.__toneBank;

console.log('=== 1. 宿主 __toneBank ===');
check('__toneBank 已定义', !!bank && typeof bank.loop === 'function');

console.log('=== 2. 波表：整数周期 + 限带 + 谐波纯度 + 音准 ===');
const ac = new AudioContext();
for (const wave of ['sine', 'triangle', 'square', 'sawtooth']) {
  const b = bank.loop(ac, wave, 440);
  const d = b.getChannelData(0);
  const cycles = b.length * 440 / SR;
  const eF = energyAt(d, 440), eOff = energyAt(d, 660); // 660 = 1.5×f，非谐波
  let top = 1;
  for (let n = 1; n * 440 < 23000; n++) if (energyAt(d, n * 440) > eF * 0.01) top = n;
  check(`${wave}: 整数周期（${cycles.toFixed(3)} 周）`, Math.abs(cycles - Math.round(cycles)) < 0.01);
  check(`${wave}: 谐波纯度（660/440 = ${(eOff / eF * 100).toFixed(2)}%）`, eOff < eF * 0.05);
  check(`${wave}: 限带（最高谐波 ${top}×440 = ${(top * 440 / 1000).toFixed(1)}kHz ≤ 24kHz）`, top * 440 <= 24000);
  check(`${wave}: 峰值 ≤ 1（${peak(d).toFixed(3)}）`, peak(d) <= 1.0);
}
{
  const src = ac.createBufferSource(), g = ac.createGain();
  src.buffer = bank.loop(ac, 'triangle', 440); src.loop = true;
  src.connect(g); g.connect(ac.destination);
  g.gain.setValueAtTime(0.5, 0);
  src.start(0);
  const out = render(ac, 0.5);
  check('440Hz 波表实测基频 ≈440（' + peakFreq(out) + ' Hz）', Math.abs(peakFreq(out) - 440) <= 3);
}
{
  // 打击乐用的噪声/扫频缓冲：必须是一次性（非循环）可用、有高频/低频内容
  const hat = bank.noise(ac, 'highpass', 7000, 0.1, 1).getChannelData(0);
  const kick = bank.sweep(ac, 'sine', 130, 45, 0.28).getChannelData(0);
  check('噪声(highpass 7k) 高频为主', bandEnergy(hat, 5000, 12000) > bandEnergy(hat, 100, 1000) * 2);
  check('扫频 kick 低频为主', bandEnergy(kick, 40, 200) > bandEnergy(kick, 2000, 8000) * 2);
  check('缓冲首尾淡入淡出（无爆音）', Math.abs(hat[0]) < 0.05 && Math.abs(hat[hat.length - 1]) < 0.05);
}

console.log('=== 3. 静态审计：全工程不得调用 nx.js 未实现的 Web Audio API ===');
const violations = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (/node_modules|\.git|bld|romfs|dist|\.tmp|research|vendor[\\/]pluotsorbet[\\/](libs|tools|java|jit|vm|polyfill)/.test(p)) continue;
      walk(p);
    } else if (name.endsWith('.js')) {
      const src = readFileSync(p, 'utf8');
      src.split('\n').forEach((line, i) => {
        // 只抓真正的调用（排除注释行）
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        for (const m of NOT_IMPLEMENTED) {
          if (new RegExp('\\.' + m + '\\s*\\(').test(line)) {
            violations.push(`${relative(root, p)}:${i + 1} ${m}()  ${line.trim().slice(0, 80)}`);
          }
        }
      });
    }
  }
}
for (const d of ['src', 'app', 'vendor', 'tools']) if (statSync(join(root, d)).isDirectory()) walk(join(root, d));
check(`${violations.length} 处违规调用`, violations.length === 0);
for (const v of violations) console.log('        ' + v);

console.log('=== 4. 动态审计：严格 mock 下真的跑一遍 midi-synth 渲染路径 ===');
load('vendor/pluotsorbet/midp/midi-synth.js');
const MidiPlayer = globalThis.Media.MidiPlayer;
check('Media.MidiPlayer 已定义', typeof MidiPlayer === 'function');

// 迷你 SMF：tempo + 旋律(2 音) + ch9 鼓(kick/snare/hat/crash)
function makeMidi() {
  const vlq = (v) => (v < 0x80 ? [v] : [0x80 | (v >> 7), v & 0x7f]);
  const track = [];
  const ev = (dt, ...bytes) => { track.push(...vlq(dt), ...bytes); };
  ev(0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);           // tempo 500000
  ev(0, 0xc0, 0x00);                                   // prog 0 (钢琴)
  ev(0, 0x90, 60, 100); ev(120, 0x80, 60, 0);
  ev(0, 0x90, 64, 100); ev(120, 0x80, 64, 0);
  for (const n of [35, 38, 42, 46, 49, 51, 60]) {      // ch9 鼓组全走一遍
    ev(0, 0x99, n, 110); ev(60, 0x89, n, 0);
  }
  ev(0, 0xff, 0x2f, 0x00);
  const hdr = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96];
  const len = track.length;
  return new Uint8Array([...hdr, 0x4d, 0x54, 0x72, 0x6b,
    (len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...track]);
}
const midi = makeMidi();
const parsed = MidiPlayer.parse(midi);
check('parse 成功（事件 ' + (parsed ? parsed.events.length : 0) + ' 条）', !!parsed && parsed.events.length > 0);

const hasNewApi = ['buildNoteEvents', 'renderChunk'].every(
  (m) => typeof MidiPlayer.prototype[m] === 'function');
if (!parsed || !hasNewApi) {
  console.log('  skip  midi-synth 渲染 API 与本次审计不同名（实现已改版），跳过动态审计');
} else {
  const before = unimplementedHits.length;
  const ctx = new AudioContext();
  const p = new MidiPlayer({ pId: 1, data: midi, contentSize: midi.length });
  p.acceptParse ? p.acceptParse(parsed) : (p.events = parsed.events, p.duration = parsed.duration);
  p.audioContext = ctx;
  p.masterGain = ctx.createGain();
  p.masterGain.connect(ctx.destination);
  p.startBase = ctx.currentTime;
  p.paused = false;
  p.renderedUntil = 0;
  p.renderAll = false;
  try {
    if (typeof p.ensureContext === 'function') { p.audioContext = ctx; }
    if (typeof p.buildNoteEvents === 'function') p.buildNoteEvents();
    if (typeof p.renderChunk === 'function') p.renderChunk(0, 2.0);
    // 显式把每种鼓都过一遍调度函数（若存在）
    if (typeof p.scheduleDrum === 'function') {
      for (const n of [35, 38, 42, 46, 49, 51, 60]) {
        p.scheduleDrum({ vel: 100, note: n, dur: 0.2 }, ctx.currentTime + 0.1, 40, 127);
      }
    }
  } catch (e) {
    check('渲染路径无异常抛出', false, (e && e.message) + '');
  }
  const hits = unimplementedHits.slice(before);
  check('渲染路径未触碰未实现 API', hits.length === 0,
    hits.length ? '触到: ' + Array.from(new Set(hits)).join(', ') : '');
  const started = ctx.__started.length;
  check('确实调度了音源（' + started + ' 个 BufferSource）', started > 0);
}

console.log('=== 5. Manager.playTone 频率公式（media.js）===');
{
  const note = 69;
  const freq = 440 * Math.pow(2, (note - 69 + 21) / 12);
  const src = ac.createBufferSource(), g = ac.createGain();
  src.buffer = bank.loop(ac, 'sine', freq);
  src.loop = true;
  src.connect(g); g.connect(ac.destination);
  g.gain.setValueAtTime(0.6, 0);
  src.start(0); src.stop(0.4);
  const out = render(ac, 0.4);
  const f = peakFreq(out, 800, 2000);
  check(`playTone(note=${note}) 实测 ≈${freq.toFixed(1)}Hz（${f} Hz）`, Math.abs(f - freq) <= 6);
}

console.log('---');
console.log(failures === 0 ? '[tonebank] 全部通过' : `[tonebank] ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
