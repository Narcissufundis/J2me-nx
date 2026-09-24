// Node 离线验证：libadlmidi wasm 直接渲染 s_mid0.mid -> wav
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SRC = 'D:/新建文件夹/myjump/java/js/libadlmidi/dist/libadlmidi.full.core.js';
const WASM = 'D:/新建文件夹/myjump/java/js/libadlmidi/dist/libadlmidi.full.core.wasm';
const MID = 'C:/Users/Admin/WorkBuddy/2026-09-19-09-58-01/midi-real/s_mid0.mid';
const SR = 48000;

// ESM import 需要 .mjs 后缀
copyFileSync(SRC, 'F:/Deepseek/j2me-nx-port/tools/_adlmidi.core.test.mjs');
const mod = await import(pathToFileURL('F:/Deepseek/j2me-nx-port/tools/_adlmidi.core.test.mjs').href);
const factory = mod.default;

const wasmBinary = readFileSync(WASM);
console.log('wasm bytes:', wasmBinary.length);
const Module = await factory({ wasmBinary });
console.log('module ready, exports:', Object.keys(Module).filter(k => k.startsWith('_adl')).join(','));

const player = Module._adl_init(SR);
if (!player) throw new Error('adl_init failed');
Module._adl_setBank(player, 58);
Module._adl_setLoopEnabled(player, 0);

const data = readFileSync(MID);
const ptr = Module._malloc(data.length);
Module.HEAPU8.set(data, ptr);
const rc = Module._adl_openData(player, ptr, data.length);
Module._free(ptr);
console.log('openData rc:', rc);

const CHUNK_FRAMES = SR / 2; // 0.5s
const samplesPerChunk = CHUNK_FRAMES * 2;
const bufPtr = Module._malloc(samplesPerChunk * 2);
const out = [];
let posSec = 0;
const t0 = Date.now();
while (true) {
  if (Module._adl_atEnd(player)) break;
  Module._adl_play(player, samplesPerChunk, bufPtr);
  const heap16 = Module.HEAP16;
  const base = bufPtr >> 1;
  const chunk = new Float32Array(samplesPerChunk);
  for (let i = 0; i < samplesPerChunk; i++) chunk[i] = heap16[base + i] / 32768;
  out.push(chunk);
  posSec += CHUNK_FRAMES / SR;
  if (posSec > 120) break; // 防御
}
const elapsed = Date.now() - t0;
const totalSamples = out.reduce((a, c) => a + c.length, 0);
console.log('rendered sec:', (totalSamples / 2 / SR).toFixed(2), 'cpu ms:', elapsed);

// 交错立体声 -> WAV 16bit
const nFrames = totalSamples / 2;
const wav = Buffer.alloc(44 + nFrames * 4);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + nFrames * 4, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(nFrames * 4, 40);
let o = 44;
for (const c of out) {
  const b = Buffer.alloc(c.length * 2);
  for (let i = 0; i < c.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, c[i] * 32767)), i * 2);
  b.copy(wav, o); o += b.length;
}
writeFileSync('C:/Users/Admin/WorkBuddy/2026-09-19-09-58-01/adlmidi-test/s_mid0.wav', wav);
console.log('wav written');
