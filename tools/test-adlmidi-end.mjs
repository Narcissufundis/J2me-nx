// 验证曲终行为：_adl_play 在 atEnd 后返回满帧静音还是不足？
import { readFileSync, copyFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SRC = 'D:/新建文件夹/myjump/java/js/libadlmidi/dist/libadlmidi.full.core.js';
const WASM = 'D:/新建文件夹/myjump/java/js/libadlmidi/dist/libadlmidi.full.core.wasm';
const MID = 'C:/Users/Admin/WorkBuddy/2026-09-19-09-58-01/midi-real/s_mid0.mid';
const SR = 48000;

copyFileSync(SRC, 'F:/Deepseek/j2me-nx-port/tools/_adlmidi.core.test.mjs');
const mod = await import(pathToFileURL('F:/Deepseek/j2me-nx-port/tools/_adlmidi.core.test.mjs').href);
const Module = await mod.default({ wasmBinary: readFileSync(WASM) });

const player = Module._adl_init(SR);
Module._adl_setBank(player, 58);
Module._adl_setLoopEnabled(player, 0);

const data = readFileSync(MID);
const ptr = Module._malloc(data.length);
Module.HEAPU8.set(data, ptr);
console.log('openData rc:', Module._adl_openData(player, ptr, data.length));
Module._free(ptr);

const FR = SR / 2, samples = FR * 2;
const bufPtr = Module._malloc(samples * 2);
// 播到 atEnd
let n = 0, shortHits = 0;
while (!Module._adl_atEnd(player)) {
  const ret = Module._adl_play(player, samples, bufPtr);
  if (ret < samples) shortHits++;
  n++;
  if (n > 400) { console.log('防御溢出'); break; }
}
console.log('播完块数:', n, '返回不足的块数:', shortHits, '末块 atEnd=', Module._adl_atEnd(player));

// 关键验证：atEnd 后继续 play，返回值是多少？
for (let i = 0; i < 5; i++) {
  const ret = Module._adl_play(player, samples, bufPtr);
  // 检查是不是静音
  const heap = Module.HEAP16, base = bufPtr >> 1;
  let peak = 0;
  for (let j = 0; j < ret >> 1; j++) {
    const v = Math.abs(heap[base + j]);
    if (v > peak) peak = v;
  }
  console.log(`atEnd 后 play#${i}: 返回=${ret}/${samples} (${(ret === samples ? '满帧' : ret === 0 ? '零' : '不足')}) 峰值=${peak} atEnd=${Module._adl_atEnd(player)}`);
}
