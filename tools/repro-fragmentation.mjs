// 复现 gc6 实机现象：GC 大回收后，后续分配是否真的复用 freelist？
// 判据：GC 后分配的地址应 < GC 前的 bump 高水位（落在死块区域）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'src', 'native-heap.js'), 'utf8');
globalThis.ASM_CONFIG = { memoryBytes: 256 * 1048576, maxMemoryBytes: 256 * 1048576 };
new Function(src)();

const ASM = globalThis.ASM;
const HEAP32 = ASM.HEAP32;

function scanner(roots) {
  return function (addRoot, addRootRange) {
    for (const r of roots) addRoot(r);
  };
}
function used() { return ASM._getUsedHeapSize(); }

// 模拟 gc6 实机节奏：大量小帧（~88B，uncollectable，分配后 free）+ 少量大块
// （~150KB collectable，活着）交错，持续到堆 ~60MB；然后 GC；再分配看落点。
const live = [];
let frames = 0;
const smallSize = 88;
for (let i = 0; i < 500000; i++) {
  const f = ASM._gcMallocUncollectable(smallSize); // 帧
  ASM._gcFree(f);                                   // 立即 deferred free
  frames++;
  if (i % 2000 === 0) {
    const big = ASM._gcMalloc(150 * 1024);          // 大块交错
    if (live.length < 300) live.push(big);          // 前 300 个存活（~44MB）
  }
  if (used() > 60 * 1048576) break;
}
console.log('ramp done: frames=' + frames + ' used=' + (used() / 1048576).toFixed(1) + 'MB live=' + live.length);

const bumpBefore = used();
const st1 = ASM.__collect(scanner(live));
console.log('GC#1: ' + JSON.stringify(st1) + ' usedAfter=' + (used() / 1048576).toFixed(1) + 'MB');

// GC 后分配：小帧与大块各来一批，看是否落在 < bumpBefore 的死块区
let smallHits = 0, smallTotal = 0, bigHits = 0, bigTotal = 0;
for (let i = 0; i < 2000; i++) {
  const a = ASM._gcMallocUncollectable(smallSize);
  ASM._gcFree(a);
  smallTotal++; if (a + smallSize <= bumpBefore) smallHits++;
  const b = ASM._gcMalloc(150 * 1024);
  bigTotal++; if (b + 150 * 1024 <= bumpBefore) bigHits++;
  if (b === 0) { console.log('OOM at big #' + i); break; }
}
console.log('small reuse: ' + smallHits + '/' + smallTotal);
console.log('big reuse:   ' + bigHits + '/' + bigTotal);
console.log('used after reuse test: ' + (used() / 1048576).toFixed(1) + 'MB (bumpBefore=' + (bumpBefore / 1048576).toFixed(1) + 'MB)');

// 再来一轮 GC 确认链完好
const st2 = ASM.__collect(scanner(live));
console.log('GC#2: ' + JSON.stringify(st2));
