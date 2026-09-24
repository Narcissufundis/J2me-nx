#!/usr/bin/env node
/*
 * render-midi-wav.mjs — 用 midi-synth.js 的真实渲染路径离线渲染 WAV
 *
 * 目的：桌面复现实机音色（蜂鸣/走调/断续）而不必每次打包上机。
 *   - mock AudioContext 与 tools/test-tonebank.mjs 同一套"nx.js beta.6 实现面"
 *     （未实现 API 一调即抛，防止回归）；
 *   - 渲染走 MidiPlayer.parse → acceptParse → renderChunk 分块（含 carryNotes
 *     延音、scheduleDrum 鼓组、块内峰值钳位），与实机完全同码；
 *   - 混音按 source→gain*→destination 链求积，输出 48kHz/16bit/stereo WAV。
 *
 * 用法：node tools/render-midi-wav.mjs <in.mid|目录> <out.wav|目录>
 */
import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SR = 48000;

// ------------------------------------------------- nx.js beta.6 实现面 mock
const NOT_IMPLEMENTED = [
  'createAnalyser', 'createBiquadFilter', 'createChannelMerger', 'createChannelSplitter',
  'createConstantSource', 'createConvolver', 'createDelay', 'createDynamicsCompressor',
  'createIIRFilter', 'createOscillator', 'createPanner', 'createPeriodicWave',
  'createScriptProcessor', 'createWaveShaper',
];
const unimplementedHits = [];
class AudioBufferMock {
  constructor(ch, len, sr) {
    if (!Number.isInteger(len) || len < 1) throw new RangeError('bad length: ' + len);
    if (!(sr >= 8000 && sr <= 192000)) throw new RangeError('bad sampleRate');
    this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.duration = len / sr;
    this._d = Array.from({ length: ch }, () => new Float32Array(len));
  }
  getChannelData(i) { return this._d[i]; }
}
class Node {
  constructor(ctx, kind) { this.__ctx = ctx; this.__kind = kind; this.__next = []; this.buffer = null; this.onended = null; }
  connect(dest) { this.__next.push(dest); return dest; }
  disconnect() { this.__next = []; }
  start(when = 0) {
    if (this.__started) throw new Error('cannot call start more than once');
    this.__started = true; this.__when = when;
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
  createGain() { const n = new Node(this, 'gain'); n.gain = { value: 1 }; return n; }
  createBufferSource() {
    const n = new Node(this, 'source');
    n.loop = false; n.loopStart = 0; n.loopEnd = 0;
    n.playbackRate = { value: 1 };
    return n;
  }
  createBuffer(ch, len, sr) { return new AudioBufferMock(ch, len, sr); }
}

// ------------------------------------------------- 加载被测代码
globalThis.AudioContext = AudioContext;
globalThis.Media = {};
const load = (p) => vm.runInThisContext(readFileSync(join(root, p), 'utf8'), { filename: p });
load('vendor/pluotsorbet/midp/adlmidi-core.js'); // 挂 globalThis.__AdlMidiFactory
load('vendor/pluotsorbet/midp/midi-synth.js');
const MidiPlayer = globalThis.Media.MidiPlayer;

// ------------------------------------------------- 立体声混音（引擎路径为 2ch buffer）
function mixdownStereo(ctx, seconds) {
  const n = Math.ceil(seconds * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (const src of ctx.__started) {
    if (!src.buffer) continue;
    const rate = src.playbackRate ? src.playbackRate.value : 1;
    const ch0 = src.buffer.getChannelData(0);
    const ch1 = src.buffer.numberOfChannels > 1 ? src.buffer.getChannelData(1) : ch0;
    const step = rate * src.buffer.sampleRate / SR;
    const startFrame = Math.max(0, Math.round((src.__when || 0) * SR));
    const stopFrame = src.__stopAt === undefined ? Infinity : Math.round(src.__stopAt * SR);
    let g = 1, node = src;
    while (node.__next.length) {
      node = node.__next[0];
      if (node.__kind === 'gain') g *= node.gain.value;
      if (node.__kind === 'destination') break;
    }
    const last = Math.min(n, stopFrame);
    for (let i = startFrame; i < last; i++) {
      const pos = (i - startFrame) * step;
      if (pos >= ch0.length) break;
      L[i] += ch0[pos | 0] * g;
      R[i] += ch1[pos | 0] * g;
    }
  }
  return { L, R };
}

function writeWavStereo(path, L, R, sr) {
  const n = L.length;
  const dataBytes = n * 4;
  const buf = Buffer.alloc(dataBytes + 44);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); };
  const u32 = (off, v) => buf.writeUInt32LE(v, off);
  const u16 = (off, v) => buf.writeUInt16LE(v, off);
  w(0, 'RIFF'); u32(4, dataBytes + 36); w(8, 'WAVE');
  w(12, 'fmt '); u32(16, 16); u16(20, 1); u16(22, 2); u32(24, sr); u32(28, sr * 4); u16(32, 4); u16(34, 16);
  w(36, 'data'); u32(40, dataBytes);
  const cl = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(cl(L[i]), 44 + i * 4);
    buf.writeInt16LE(cl(R[i]), 44 + i * 4 + 2);
  }
  writeFileSync(path, buf);
}

// ------------------------------------------------- 混音
function mixdown(ctx, seconds) {
  const n = Math.ceil(seconds * SR);
  const out = new Float32Array(n);
  for (const src of ctx.__started) {
    if (!src.buffer) continue;
    const rate = src.playbackRate ? src.playbackRate.value : 1;
    const ch = src.buffer.getChannelData(0);
    const step = rate * src.buffer.sampleRate / SR;
    const startFrame = Math.max(0, Math.round((src.__when || 0) * SR));
    const stopFrame = src.__stopAt === undefined ? Infinity : Math.round(src.__stopAt * SR);
    // 沿链求增益积（drum 的 gain.value / masterGain.gain.value）
    let g = 1, node = src;
    while (node.__next.length) {
      node = node.__next[0];
      if (node.__kind === 'gain') g *= node.gain.value;
      if (node.__kind === 'destination') break;
    }
    const last = Math.min(n, stopFrame);
    for (let i = startFrame; i < last; i++) {
      const pos = (i - startFrame) * step;
      if (pos >= ch.length) break;
      out[i] += ch[pos | 0] * g;
    }
  }
  return out;
}

// ------------------------------------------------- WAV 写出（48k/16bit/stereo）
function writeWav(path, mono, sr) {
  const n = mono.length;
  const dataBytes = n * 4; // stereo 16bit
  const buf = Buffer.alloc(dataBytes + 44);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); };
  const u32 = (off, v) => buf.writeUInt32LE(v, off);
  const u16 = (off, v) => buf.writeUInt16LE(v, off);
  w(0, 'RIFF'); u32(4, dataBytes + 36); w(8, 'WAVE');
  w(12, 'fmt '); u32(16, 16); u16(20, 1); u16(22, 2); u32(24, sr); u32(28, sr * 4); u16(32, 4); u16(34, 16);
  w(36, 'data'); u32(40, dataBytes);
  for (let i = 0; i < n; i++) {
    let v = Math.max(-1, Math.min(1, mono[i]));
    const s = Math.round(v * 32767);
    buf.writeInt16LE(s, 44 + i * 4);
    buf.writeInt16LE(s, 44 + i * 4 + 2);
  }
  writeFileSync(path, buf);
}

// ------------------------------------------------- 渲染一个 MIDI
function renderFile(inPath, outPath) {
  const bytes = readFileSync(inPath);
  const parsed = MidiPlayer.parse(bytes);
  if (!parsed || !parsed.events.length) {
    console.log(`${basename(inPath)}: 解析失败`);
    return false;
  }
  // 统计 program
  const progs = new Set();
  for (const e of parsed.events) if (e.kind === 'prog') progs.add(e.prog);

  const ctx = new AudioContext();
  const p = new MidiPlayer({ pId: 1, data: bytes, contentSize: bytes.length });
  p.acceptParse(parsed);
  p.audioContext = ctx;
  p.masterGain = ctx.createGain();          // gain.value = 1
  p.masterGain.connect(ctx.destination);
  p.startBase = 0;
  p.paused = false;

  // 与实机 renderTick 相同的分块推进（2s/块，含 carryNotes 延音）
  const end = p.duration + 1;
  for (let t = 0; t < end; t += MidiPlayer.CHUNK_SEC) {
    const t1 = Math.min(t + MidiPlayer.CHUNK_SEC, end);
    p.renderChunk(t, t1);
  }
  const mono = mixdown(ctx, end + 0.5);
  writeWav(outPath, mono, SR);

  let peak = 0, sum = 0;
  for (let i = 0; i < mono.length; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; sum += mono[i] * mono[i]; }
  const rms = Math.sqrt(sum / mono.length);
  console.log(`${basename(inPath)} → ${basename(outPath)}: 事件=${parsed.events.length} ` +
    `音符=${p.noteEvents.length} 时长=${p.duration.toFixed(1)}s program={${[...progs].sort((a,b)=>a-b).join(',')}} ` +
    `波表=${Object.keys(MidiPlayer.wavTables).length} 峰值=${peak.toFixed(3)} RMS=${rms.toFixed(3)} ` +
    `sources=${ctx.__started.length}${unimplementedHits.length ? ' 未实现API命中:' + [...new Set(unimplementedHits)] : ''}`);
  return true;
}

// ------------------------------------------------- 引擎模式渲染（与实机 MidiPlayer 引擎路径同码）
async function renderFileEngine(inPath, outPath) {
  const { createRequire } = await import('node:module');
  globalThis.__nodeRequire = createRequire(import.meta.url);
  globalThis.__adlmidiWasmPath = join(root, 'data/adlmidi/libadlmidi.full.core.wasm');

  const bytes = readFileSync(inPath);
  const parsed = MidiPlayer.parse(bytes);
  if (!parsed || !parsed.events.length) {
    console.log(`${basename(inPath)}: 解析失败`);
    return false;
  }
  const eng = await Media.Adlmidi.open(SR);
  if (!eng) { console.log(`${basename(inPath)}: 引擎打开失败`); return false; }
  const raw = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) raw[i] = bytes[i] & 0xFF;
  if (!eng.loadMidi(raw)) { console.log(`${basename(inPath)}: openData 失败`); eng.close(); return false; }

  const ctx = new AudioContext();
  const p = new MidiPlayer({ pId: 1, data: new Int8Array(bytes), contentSize: bytes.length });
  p.acceptParse(parsed);
  p.audioContext = ctx;
  p.masterGain = ctx.createGain();
  p.masterGain.connect(ctx.destination);
  p.startBase = 0;
  p.paused = false;
  p.engine = eng;
  p.useEngine = true;

  const end = p.duration + 6; // 引擎天然在曲终后返回不足，防御性上限
  let rendered = 0, t = 0;
  while (t < end) {
    const t1 = t + MidiPlayer.CHUNK_SEC;
    const gen = p.engineRenderChunk(t, t1);
    rendered = t + gen / SR;
    if (gen < Math.round(MidiPlayer.CHUNK_SEC * SR)) break; // 曲终（尾音已入队）
    t = t1;
  }
  const { L, R } = mixdownStereo(ctx, rendered + 1.0);
  writeWavStereo(outPath, L, R, SR);
  eng.close();
  let peak = 0, sum = 0;
  for (let i = 0; i < L.length; i++) { const a = Math.abs(L[i] + R[i]) / 2; if (a > peak) peak = a; const v = (L[i] + R[i]) / 2; sum += v * v; }
  const rms = Math.sqrt(sum / L.length);
  console.log(`[engine] ${basename(inPath)} → ${basename(outPath)}: 时长=${rendered.toFixed(1)}s 峰值=${peak.toFixed(3)} RMS=${rms.toFixed(3)} sources=${ctx.__started.length}`);
  return true;
}

// ------------------------------------------------- 入口
function mkdirSync2(p) { mkdirSync(p, { recursive: true }); }
const arg1 = process.argv[2], arg2 = process.argv[3], arg3 = process.argv[4];
const engineMode = arg1 === '--engine';
const inArg = engineMode ? arg2 : arg1;
const outArg = engineMode ? arg3 : arg2;
if (!inArg || !outArg) { console.error('用法: node render-midi-wav.mjs [--engine] <in.mid|目录> <out.wav|目录>'); process.exit(2); }
const st1 = statSync(inArg);
if (engineMode) {
  const mids = st1.isFile() ? [basename(inArg)] : readdirSync(inArg).filter((f) => extname(f).toLowerCase() === '.mid').sort();
  const inDir = st1.isFile() ? dirname(inArg) : inArg;
  mkdirSync2(outArg);
  let fail = 0;
  for (const f of mids) {
    if (!(await renderFileEngine(join(inDir, f), join(outArg, f.replace(/\.mid$/i, '.wav'))))) fail++;
  }
  process.exit(fail ? 1 : 0);
}
if (st1.isFile()) {
  process.exit(renderFile(inArg, outArg) ? 0 : 1);
} else {
  const mids = readdirSync(inArg).filter((f) => extname(f).toLowerCase() === '.mid').sort();
  let fail = 0;
  for (const f of mids) {
    unimplementedHits.length = 0;
    if (!renderFile(join(inArg, f), join(outArg, f.replace(/\.mid$/i, '.wav')))) fail++;
  }
  process.exit(fail ? 1 : 0);
}
