/*
 * perfI — GC 假候选过滤（块起点位图）回归测试
 *
 * 实机证据（error.log 05:30:10）：
 *   [gc] 回收 3.6MB（91822 块）用时 755ms [prep=0 根=8 mark=730 sweep=17]
 *        扫=211.2MB 免扫=62.4MB(7042块) 存活块 9610 存活=0.9MB
 * 存活 payload 只有 0.9MB，mark 却扫了 211MB ⇒ markCandidate 的弱校验
 * （读 p-8 当 size、size>=8 且在堆内）把大量"指向对象内部"的 8 对齐假地址
 * 当成了合法块头，然后按那个假 size 大扫一遍（最坏 ~堆大小/个）。
 *
 * 修法：GC 第一次链遍历登记真实块起点位图，markCandidate 只认位图上的起点。
 * 本测试用"构造出来的整块假候选"复现该病理：修前 scan 会被放大到块大小的几十倍，
 * 修后 scan 恒等于真实块大小。
 *
 * 运行：node tests/gc-candidate.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'src/native-heap.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}
function freshASM() { (0, eval)(src); const a = globalThis.ASM; if (!a) throw new Error('ASM 未导出'); return a; }
function gcR(ASM, roots) {
  return ASM.__collect(function (addRoot) { for (let i = 0; i < roots.length; i++) addRoot(roots[i]); });
}

// ---- 1. 整块假候选：8B 单元 [size=1024][addr=块内 8 对齐地址] 重复 ----
{
  const ASM = freshASM();
  gcR(ASM, []);
  const i32 = ASM.HEAP32;
  const SIZE = 65536;                       // 一个"可扫描"的大对象（普通 _gcMalloc，不是 NOSCAN）
  const big = ASM._gcMalloc(SIZE);
  const units = (SIZE / 8) | 0;
  for (let m = 0; m < units; m++) {
    const off = m * 8;
    i32[(big + off) >> 2] = 1024;                      // 让下一个地址"看起来"是块头 size
    i32[(big + off + 4) >> 2] = big + 8 + off;         // 8 对齐的假候选地址（指向块内部）
  }
  const s = gcR(ASM, [big]);
  check('1 gc 未损坏', ASM.__gcBroken(), false);
  check('1 大块存活', s.keptBlocks, 1);
  // 修前：4096 个假候选 × 1024B ≈ 4MB 被扫；修后：只扫真实块 64KB（外加可能被误标的更靠后的块）
  check('1 扫描量 ≈ 真实块大小（未被假候选放大）', s.scanB <= SIZE, true);
  check('1 假候选被拒（>0）', s.rejCand > 0, true);
  check('1 扫描量远小于假块总量', s.scanB < 4 * 1024 * 1024, true);
}

// ---- 2. 真引用仍然生效（位图不能漏真根）----
{
  const ASM = freshASM();
  gcR(ASM, []);
  const i32 = ASM.HEAP32;
  const holder = ASM._gcMalloc(32);
  const target = ASM._gcMalloc(32);
  i32[holder >> 2] = target;                 // 真引用：payload 起点
  const s = gcR(ASM, [holder]);
  check('2 真引用保活', s.keptBlocks, 2);
  check('2 无回收', s.freedBlocks, 0);
  check('2 gc 未损坏', ASM.__gcBroken(), false);
}

// ---- 3. 假候选不再保活目标（过滤生效的方向性）----
{
  const ASM = freshASM();
  gcR(ASM, []);
  const i32 = ASM.HEAP32;
  const holder = ASM._gcMalloc(32);
  const target = ASM._gcMalloc(32);
  i32[(holder + 4) >> 2] = target + 8;       // 8 对齐但指向目标内部（非 payload 起点）→ 不该保活
  const s = gcR(ASM, [holder]);
  check('3 内部指针不保活目标', s.freedBlocks, 1);
  check('3 持有块存活', s.keptBlocks, 1);
  check('3 假候选被拒', s.rejCand > 0, true);
}

// ---- 4. 反复 GC 稳定（位图重建 + 合并 run 头仍被视为真实起点）----
{
  const ASM = freshASM();
  gcR(ASM, []);
  const keep = ASM._gcMalloc(64);
  const mid1 = ASM._gcMalloc(64);
  const mid2 = ASM._gcMalloc(64);
  const keep2 = ASM._gcMalloc(64);
  const s1 = gcR(ASM, [keep, keep2]);        // 中间两个成为死块 → freelist run
  check('4 中间两块被回收（合并成一个 run）', s1.freedBlocks, 2);
  const s2 = gcR(ASM, [keep, keep2]);
  const s3 = gcR(ASM, [keep, keep2]);
  check('4 三次 GC 未损坏', ASM.__gcBroken(), false);
  // 注意：freelist run 每轮 sweep 都会被"再回收一次"（设计如此，freedBytes 里
  // 会被 freelistBytesBefore 扣掉），所以判据看"真回收量"=freedMB 而不是块数。
  check('4 第二次 GC 无新增垃圾', s2.freedMB, 0);
  check('4 第三次 GC 无新增垃圾', s3.freedMB, 0);
  const t = ASM._gcMalloc(64);               // 复用 freelist run（run 头是真实块起点）
  check('4 复用 run 成功', t > 0, true);
  const s4 = gcR(ASM, [keep, keep2, t]);
  check('4 复用后 GC 未损坏', ASM.__gcBroken(), false);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
