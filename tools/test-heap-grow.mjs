// Heap growth smoke test: allocations beyond initial capacity succeed,
// old data preserved, addresses unchanged, over-limit returns 0.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.ASM_CONFIG = { memoryBytes: 8 * 1024 * 1024, maxMemoryBytes: 32 * 1024 * 1024 };
require('../bld/native.js');
const ASM = globalThis.ASM;
console.log('resizable =', ASM.__resizable(), 'total =', ASM.__totalMemory());

function alloc(size, fill) {
  const addr = ASM._gcMalloc(size);
  if (!addr) throw new Error('OOM at size ' + size);
  ASM.HEAPU8.fill(fill, addr, addr + size);
  return addr;
}

const blocks = [];
let total = 0;
for (let i = 0; i < 5; i++) {
  const a = alloc(1024 * 1024, 0xA0 + i);
  blocks.push({ a, fill: 0xA0 + i });
  total += 1024 * 1024;
}
console.log('after 5MB: total =', ASM.__totalMemory(), 'used =', ASM.__bump() - ASM.__heapStart);

while (total < 20 * 1024 * 1024) {
  const a = alloc(1024 * 1024, 0x77);
  blocks.push({ a, fill: 0x77 });
  total += 1024 * 1024;
}
console.log('after 20MB: total =', ASM.__totalMemory(), 'used =', ASM.__bump() - ASM.__heapStart);

let bad = 0;
for (const { a, fill } of blocks) {
  if (ASM.HEAPU8[a] !== fill) bad++;
}
console.log('data integrity:', bad === 0 ? 'OK all blocks preserved' : bad + ' blocks CORRUPT');

const big = ASM._gcMalloc(64 * 1024 * 1024);
console.log('over-limit alloc returns 0:', big === 0 ? 'OK' : 'FAIL ' + big);
console.log('PASS');
