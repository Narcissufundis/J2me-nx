#!/usr/bin/env node
/*
 * midi-to-wav.mjs — 用工程自己的合成器离线渲染 .mid → .wav（电脑上试听用）
 *
 * 用途：实机"无声"排障时，先在电脑上听一遍"合成器应该出来的声音"，
 * 区分"合成器/波形的问题"还是"实机输出链路的问题"。
 *
 * 波形与实机同源：宿主 __toneBank（src/host/switch-audio.js）——同一套
 * 整数周期波表 / 扫频 / JS 预滤波噪声，所以这个 WAV 就是 Switch 上应有的音色。
 * 解析优先用 vendor 的 MidiPlayer.parse（能验证工程解析器），失败则退回内置
 * 紧凑 SMF 解析器（跑另一 agent 正在改的文件时不至于卡住）。
 *
 * 用法：
 *   node tools/midi-to-wav.mjs <input.mid> [output.wav] [--sr 48000]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------- 参数
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sr') flags.sr = Number(args[++i]);
  else positional.push(args[i]);
}
if (!positional.length) {
  console.error('用法: node tools/midi-to-wav.mjs <input.mid> [output.wav] [--sr 48000]');
  process.exit(2);
}
const inPath = positional[0];
const outPath = positional[1] || join(dirname(inPath), basename(inPath, extname(inPath)) + '.wav');
const SR = flags.sr || 48000;

// ---------------------------------------------------------------- 最小 AudioContext
// __toneBank 只需要 sampleRate + createBuffer(getChannelData)；不实现任何
// nx.js 没有的 API（nx.js 只有 Gain/Buffer/BufferSource/StereoPanner/decode）。
class OfflineBuffer {
  constructor(ch, len, sr) {
    this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.duration = len / sr;
    this._d = Array.from({ length: ch }, () => new Float32Array(len));
  }
  getChannelData(i) { return this._d[i]; }
}
globalThis.AudioContext = class {
  constructor() { this.sampleRate = SR; this.currentTime = 0; this.state = 'running'; }
  createBuffer(ch, len, sr) { return new OfflineBuffer(ch, len, sr); }
};
globalThis.Media = {};
globalThis.console = console;

vm.runInThisContext(readFileSync(join(root, 'src/host/switch-audio.js'), 'utf8'), { filename: 'switch-audio.js' });
const bank = globalThis.__toneBank;
if (!bank) { console.error('__toneBank 未定义（src/host/switch-audio.js 加载失败）'); process.exit(1); }
const ac = new AudioContext();

// ---------------------------------------------------------------- 解析 MIDI
const bytes = new Uint8Array(readFileSync(inPath));

let parserUsed = 'vendor MidiPlayer.parse';
let song = null;
try {
  vm.runInThisContext(readFileSync(join(root, 'vendor/pluotsorbet/midp/midi-synth.js'), 'utf8'), { filename: 'midi-synth.js' });
  const parsed = globalThis.Media.MidiPlayer.parse(bytes);
  if (parsed && parsed.events && parsed.events.length) {
    song = { events: parsed.events, duration: parsed.duration };
  } else { throw new Error('parse 返回空'); }
} catch (e) {
  console.warn(`[warn] vendor 解析器不可用（${e && e.message}），退回内置解析器`);
  parserUsed = '内置 SMF 解析器';
  song = null;
}
if (!song) song = parseSmf(bytes);

// 内置紧凑 SMF 解析（format 0/1，running status，tempo 变化，program/cc/bend）
function parseSmf(d) {
  let pos = 0;
  const u32 = () => { const v = (d[pos] << 24 | d[pos + 1] << 16 | d[pos + 2] << 8 | d[pos + 3]) >>> 0; pos += 4; return v; };
  const u16 = () => { const v = (d[pos] << 8) | d[pos + 1]; pos += 2; return v; };
  if (String.fromCharCode(d[0], d[1], d[2], d[3]) !== 'MThd') throw new Error('不是 MIDI 文件');
  pos = 4; u32(); u16(); const ntracks = u16(); const division = u16();
  pos = 8 + u32();
  const evs = [];
  let tempo = 500000; // µs/quarter
  for (let tr = 0; tr < ntracks; tr++) {
    if (String.fromCharCode(d[pos], d[pos + 1], d[pos + 2], d[pos + 3]) !== 'MTrk') break;
    pos += 4; const len = u32(); const end = pos + len;
    let tick = 0, running = 0;
    const vlq = () => { let v = 0, c; do { c = d[pos++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80); return v; };
    while (pos < end) {
      tick += vlq();
      let status = d[pos];
      if (status & 0x80) pos++; else status = running;
      running = status;
      const sec = tick / division * (tempo / 1e6);
      if (status === 0xff) {
        const type = d[pos++]; const l = vlq();
        if (type === 0x51 && l === 3) { tempo = (d[pos] << 16) | (d[pos + 1] << 8) | d[pos + 2]; evs.push({ t: sec, kind: 'tempo', val: tempo }); }
        pos += l;
      } else if (status === 0xf0 || status === 0xf7) {
        pos += vlq();
      } else {
        const hi = status & 0xf0, ch = status & 0x0f;
        if (hi === 0x90 || hi === 0x80) {
          const note = d[pos++], vel = d[pos++];
          evs.push({ t: sec, kind: (hi === 0x90 && vel > 0) ? 'on' : 'off', ch, note, vel });
        } else if (hi === 0xa0 || hi === 0xb0 || hi === 0xe0) {
          const a = d[pos++], b = d[pos++];
          if (hi === 0xb0) evs.push({ t: sec, kind: 'cc', ch, cc: a, val: b });
          else if (hi === 0xe0) evs.push({ t: sec, kind: 'bend', ch, val: ((b << 7) | a) });
        } else if (hi === 0xc0) {
          evs.push({ t: sec, kind: 'prog', ch, prog: d[pos++] });
        } else if (hi === 0xd0) { pos++; }
        else { pos += 2; }
      }
    }
    pos = end;
  }
  evs.sort((a, b) => a.t - b.t);
  const duration = evs.length ? evs[evs.length - 1].t : 0;
  return { events: evs, duration };
}

// ---------------------------------------------------------------- 离线渲染
const gmTimbre = globalThis.Media.gmTimbre || ((p) => ({ wave: 'triangle', attack: 0.005, decay: 0.5, sustain: 0.2, release: 0.12, gain: 0.5 }));
const HEADROOM = 0.35;                         // 与实机 MidiPlayer.VOICE_HEADROOM 同量级
const total = Math.ceil((song.duration + 1.5) * SR);
const mix = new Float32Array(total);

const programs = new Array(16).fill(0);
const cc7 = new Array(16).fill(100);
const cc11 = new Array(16).fill(127);
const bend = new Array(16).fill(8192);

// note-on/off 配对
const pending = new Map();
const notes = [];
for (const e of song.events) {
  if (e.kind === 'prog') programs[e.ch] = e.prog;
  else if (e.kind === 'cc') { if (e.cc === 7) cc7[e.ch] = e.val; else if (e.cc === 11) cc11[e.ch] = e.val; }
  else if (e.kind === 'bend') bend[e.ch] = e.val;
  else if (e.kind === 'on' && e.ch !== 9) {
    const key = e.ch + ':' + e.note;
    if (!pending.has(key)) pending.set(key, []);
    pending.get(key).push({ t: e.t, vel: e.vel, prog: programs[e.ch], cc7: cc7[e.ch], cc11: cc11[e.ch], bend: bend[e.ch] });
  } else if (e.kind === 'off' && e.ch !== 9) {
    const key = e.ch + ':' + e.note;
    const st = pending.get(key);
    if (st && st.length) notes.push(Object.assign(st.shift(), { offT: e.t }));
  } else if (e.kind === 'on' && e.ch === 9) {
    notes.push({ drum: true, t: e.t, note: e.note, vel: e.vel });
  }
}
for (const st of pending.values()) for (const n of st) notes.push(Object.assign(n, { offT: n.t + 0.5 }));
notes.sort((a, b) => a.t - b.t);

let rendered = 0;
function add(buf, at, gain, fadeOut = 0) {
  const d = buf.getChannelData(0);
  const i0 = Math.max(0, Math.round(at * SR));
  for (let i = 0; i < d.length; i++) {
    const j = i0 + i;
    if (j >= total) break;
    let g = gain;
    if (fadeOut > 0) { const left = d.length - i; if (left < fadeOut) g *= left / fadeOut; }
    mix[j] += d[i] * g;
  }
}

for (const n of notes) {
  if (n.drum) {
    const v = Math.pow(n.vel / 127, 1.4) * HEADROOM;
    switch (n.note) {
      case 35: case 36: add(bank.sweep(ac, 'sine', 130, 45, 0.28), n.t, 1.1 * v); break;
      case 38: case 40:
        add(bank.noise(ac, 'bandpass', 1800, 0.16, 1), n.t, 0.7 * v);
        add(bank.sweep(ac, 'triangle', 190, 120, 0.1), n.t, 0.4 * v); break;
      case 42: case 44: add(bank.noise(ac, 'highpass', 7000, 0.05, 1), n.t, 0.45 * v); break;
      case 46: add(bank.noise(ac, 'highpass', 7000, 0.3, 1), n.t, 0.4 * v); break;
      case 49: case 55: case 57: add(bank.noise(ac, 'highpass', 5000, 0.8, 1), n.t, 0.4 * v); break;
      case 51: add(bank.noise(ac, 'highpass', 6000, 0.5, 1), n.t, 0.3 * v); break;
      default: add(bank.noise(ac, 'bandpass', 1000 + (n.note % 12) * 300, 0.09, 1), n.t, 0.4 * v); break;
    }
    rendered++;
    continue;
  }
  const semis = (n.bend - 8192) / 8192 * 2;                 // ±2 半音
  const freq = 440 * Math.pow(2, (n.note - 69 + semis) / 12);
  const timbre = gmTimbre(n.prog | 0);
  const wave = bank.loop(ac, timbre.wave, freq);
  const wd = wave.getChannelData(0);
  const L = wave.length; // L 个采样含 k 个周期 → 每周期 L/k = SR/f 采样，输出采样与波表采样一一对应

  const peak = Math.pow(n.vel / 127, 1.5) * (n.cc7 / 127) * (n.cc11 / 127) * timbre.gain * HEADROOM;
  const sus = timbre.sustain * HEADROOM;
  const dur = Math.max((n.offT - n.t), timbre.attack + 0.05);
  const rel = timbre.release;
  const len = Math.ceil((dur + rel + 0.02) * SR);
  const i0 = Math.round(n.t * SR);
  for (let i = 0; i < len; i++) {
    const j = i0 + i;
    if (j >= total) break;
    const t = i / SR;
    // 包络
    let g;
    if (t < timbre.attack) g = peak * (t / timbre.attack);
    else if (sus < peak && t < timbre.attack + timbre.decay) {
      const k = (t - timbre.attack) / timbre.decay;
      g = peak * Math.pow(sus / peak, k);                     // 指数衰减
    } else if (t < dur) g = sus < peak ? sus : peak;
    else if (t < dur + rel) g = (sus < peak ? sus : peak) * (1 - (t - dur) / rel);
    else continue;
    // 波表读取：步进 1 个输出采样＝1 个波表采样（波表已按该音高量化好周期）
    mix[j] += wd[i % L] * g;
  }
  rendered++;
}

// ---------------------------------------------------------------- 归一化 + 写 WAV
let pk = 0;
for (let i = 0; i < total; i++) { const a = Math.abs(mix[i]); if (a > pk) pk = a; }
const gain = pk > 0.89 ? 0.89 / pk : 1;
let sum = 0;
const pcm = Buffer.alloc(total * 2);
for (let i = 0; i < total; i++) {
  const v = Math.max(-1, Math.min(1, mix[i] * gain));
  sum += v * v;
  pcm.writeInt16LE(Math.round(v * 32767), i * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
writeFileSync(outPath, Buffer.concat([header, pcm]));

console.log(`输入      : ${inPath} (${bytes.length} 字节)`);
console.log(`解析器    : ${parserUsed}`);
console.log(`事件/音符 : ${song.events.length} 事件 / 渲染 ${rendered} 个音（含打击乐）`);
console.log(`时长      : ${song.duration.toFixed(2)}s（输出 ${(total / SR).toFixed(2)}s）`);
console.log(`峰值/RMS  : ${(pk * gain).toFixed(3)} / ${Math.sqrt(sum / total).toFixed(4)}（归一化增益 ×${gain.toFixed(3)}）`);
console.log(`输出      : ${outPath} (${((44 + pcm.length) / 1048576).toFixed(2)} MB, ${SR}Hz 16bit mono)`);
