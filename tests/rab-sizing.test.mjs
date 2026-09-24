/*
 * perfK — RAB 预算自适应回归测试（偏紧档能不能正常玩的关键）
 *
 * 实机事实：偏紧档 heapSizeLimit=425MB 时，旧公式 rabmax = 425-128-96 = 201MB，
 * V8 构造 RAB 会按 maxByteLength 预提交物理页且不回收 → 只剩 ~224MB 给 V8，
 * 实测 heapTotal 卡在 57MB 涨不上去（正常档 821MB 能到 114.2MB 并稳住）。
 * 新公式：initial=32MB、max=clamp(lim-256-32, 64, 512)。
 *
 * 运行：node tests/rab-sizing.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'src/native-heap.js'), 'utf8');
const MB = 1048576;

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

// 造一个假的 Switch.memoryUsage，模拟不同启动档位
function loadWithLimit(limMB) {
  delete globalThis.ASM;
  delete globalThis.__j2mePersistentRAB;   // 否则会复用上一轮 RAB（带旧 max）
  if (limMB > 0) {
    globalThis.Switch = { memoryUsage: function () { return { heapSizeLimit: limMB * MB }; } };
  } else {
    delete globalThis.Switch;
  }
  (0, eval)(src);
  const a = globalThis.ASM;
  if (!a) throw new Error('ASM 未导出');
  return a;
}
function maxMB(a) { return Math.round(a.__maxMemory() / MB); }
function usedMB(a) { return Math.round(a.__totalMemory() / MB); }

// 各档位的期望值：
//   正常档（>=700MB）→ 初始 128MB / 上限 512MB（与实测稳定的 perfI 完全一致，零改动）
//   偏紧档（<700MB） → 初始 32MB / 上限 clamp(lim-256-32, 64, 512)
const cases = [
  [425, 32, 137],   // 偏紧档（实测偏低档）  旧 128/201
  [468, 32, 180],   // 之前见过的另一档
  [512, 32, 224],
  [699, 32, 411],
  [700, 128, 512],  // 正常档边界
  [821, 128, 512],  // 正常档 = perfI 配置一字不改
];
for (const [lim, initMB, want] of cases) {
  const a = loadWithLimit(lim);
  check(`档位 ${lim}MB → rabmax ${want}MB`, maxMB(a), want);
  check(`档位 ${lim}MB → 初始 ${initMB}MB`, usedMB(a), initMB);
  const d = a.__diag();
  check(`档位 ${lim}MB diag 含 rabinit:${initMB}MB`, d.indexOf('rabinit:' + initMB + 'MB') >= 0, true);
  check(`档位 ${lim}MB diag 含 rabmax:${want}MB`, d.indexOf('rabmax:' + want + 'MB') >= 0, true);
  if (lim === 425) {
    check('425 档比旧公式（128/201）省 ≥64MB 上限', 201 - maxMB(a) >= 64, true);
    check('425 档初始比旧值小 96MB', 128 - usedMB(a), 96);
  }
  if (lim >= 700) {
    check(`正常档 ${lim}MB 与 perfI 完全一致（128/512）`, usedMB(a) === 128 && maxMB(a) === 512, true);
  }
  // 可扩容 + 真的能扩（32MB 起步，连分 48MB 逼 growHeap 走 resize，且数据保留）
  check(`档位 ${lim}MB 可扩容`, a.__resizable(), true);
  const p = a._gcMalloc(1024);
  a.HEAP32[p >> 2] = 0x12345678;
  let grew = false;
  try {
    for (let i = 0; i < 48; i++) a._gcMalloc(1 * MB);   // 48MB > 初始 32MB
    grew = a.__totalMemory() > 32 * MB;
  } catch (e) { grew = false; }
  check(`档位 ${lim}MB 按需扩容`, grew, true);
  check(`档位 ${lim}MB 扩容后数据保留`, a.HEAP32[p >> 2], 0x12345678);
  check(`档位 ${lim}MB 未超上限`, a.__totalMemory() <= a.__maxMemory(), true);
}

// 没有 Switch（Node 仿真）时的兜底：保持默认 128/512（与改动前一致，不影响 Node 回归）
{
  const a = loadWithLimit(0);
  check('无 Switch 兜底 rabmax 512MB', maxMB(a), 512);
  check('无 Switch 兜底初始 128MB', usedMB(a), 128);
}

// ASM_CONFIG.memoryBytes 覆盖初始容量（老接口不能被破坏）
{
  delete globalThis.ASM;
  delete globalThis.__j2mePersistentRAB;
  globalThis.Switch = { memoryUsage: function () { return { heapSizeLimit: 821 * MB }; } };
  globalThis.ASM_CONFIG = { memoryBytes: 64 * MB };
  (0, eval)(src);
  const a = globalThis.ASM;
  check('ASM_CONFIG.memoryBytes=64MB 生效', usedMB(a), 64);
  delete globalThis.ASM_CONFIG;
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
