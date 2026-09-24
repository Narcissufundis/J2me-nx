/*
 * perfE — GC「免扫」(NOSCAN) 语义测试
 *
 * 背景：实机 [gc] 显示每次 GC 停顿 1.1~1.4s，而 Node 复现里 43 万块 sweep 仅 17ms
 * → 停顿在 traceMarkedBlocks 的保守 mark（把每个存活块 payload 的每个 word 当候选指针）。
 * perfE 让基本类型数组（byte[]/char[]/…）打 NOSCAN 标记、mark 阶段整块跳过。
 *
 * 本测试锁定四条不变量：
 *   1) 普通块仍被保守扫描（payload 里的指针保活目标）
 *   2) NOSCAN 块 payload 不被扫（里面的数值不再保活任何东西）
 *   3) 块头 size 掩码对 NOSCAN 位处理正确（否则堆链 walk 会 desync → gcBroken）
 *   4) freelist 复用会清掉 NOSCAN 位（复用块必须是保守扫描的——安全方向）
 *   5) perm 块 _gcFree 的延迟回收路径不受影响
 *
 * 运行：node tests/gc-noscan.test.mjs
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

function freshASM() {
  (0, eval)(src);
  const a = globalThis.ASM;
  if (!a) throw new Error('ASM 未导出');
  return a;
}
function gcR(ASM, roots) {
  return ASM.__collect(function (addRoot) {
    for (let i = 0; i < roots.length; i++) addRoot(roots[i]);
  });
}

// ---- 0. 接口存在 ----
{
  const ASM = freshASM();
  check('接口 _gcMallocAtomicNoScan 存在', typeof ASM._gcMallocAtomicNoScan, 'function');
  const p = ASM._gcMallocAtomicNoScan(24);
  check('NOSCAN 分配非 0', p > 0, true);
  check('NOSCAN 分配 8 对齐', p % 8, 0);
}

// ---- 1. 普通块被保守扫描：payload 里的指针保活目标 ----
{
  const ASM = freshASM();
  gcR(ASM, []);                       // 清掉模块初始化可能留下的垃圾，保证下面计数是绝对的
  const i32 = ASM.HEAP32;
  const holder = ASM._gcMalloc(24);
  const target = ASM._gcMalloc(24);
  i32[holder >> 2] = target;          // 块 payload 第 0 个 word 写目标地址（8 对齐）
  const s = gcR(ASM, [holder]);
  check('1 gc 未损坏', ASM.__gcBroken(), false);
  check('1 两块都存活', s.keptBlocks, 2);
  check('1 无回收', s.freedBlocks, 0);
  check('1 扫描字节 > 0', s.scanB > 0, true);
  check('1 本次无免扫块', s.skipBlocks, 0);
}

// ---- 2. NOSCAN 块 payload 不被扫：里面的指针不保活 ----
{
  const ASM = freshASM();
  gcR(ASM, []);
  const i32 = ASM.HEAP32;
  const holder = ASM._gcMallocAtomicNoScan(24);
  const target = ASM._gcMalloc(24);
  i32[holder >> 2] = target;
  const s = gcR(ASM, [holder]);
  check('2 gc 未损坏', ASM.__gcBroken(), false);
  check('2 免扫块存活', s.keptBlocks, 1);
  check('2 免扫块计数', s.skipBlocks, 1);
  check('2 免扫字节=24', s.skipB, 24);
  check('2 目标被回收（免扫生效）', s.freedBlocks, 1);
  check('2 bump 回退到持有块之后', ASM.__bump(), holder + 24);
}

// ---- 3. size 掩码正确：存活 NOSCAN 块跨多次 GC 不能让堆链 walk desync ----
{
  const ASM = freshASM();
  gcR(ASM, []);
  const a = ASM._gcMallocAtomicNoScan(24);
  const b = ASM._gcMalloc(16);
  const c = ASM._gcMallocAtomicNoScan(4096);
  const bump0 = ASM.__bump();
  const s1 = gcR(ASM, [a, b, c]);
  const s2 = gcR(ASM, [a, b, c]);
  const s3 = gcR(ASM, [a, b, c]);
  check('3 三次 GC 未损坏', ASM.__gcBroken(), false);
  check('3 三次 GC 后 bump 不变', ASM.__bump(), bump0);
  check('3 三次都存活 3 块', s3.keptBlocks, 3);
  check('3 免扫 2 块', s3.skipBlocks, 2);
  check('3 无回收', s3.freedBlocks, 0);
  check('3 分期字段齐全', typeof s3.markMs === 'number' && typeof s3.sweepMs === 'number', true);
}

// ---- 4. freelist 复用必须清掉 NOSCAN 位（复用块要按保守扫）----
{
  const ASM = freshASM();
  gcR(ASM, []);
  const keep1 = ASM._gcMalloc(24);
  const middle = ASM._gcMallocAtomicNoScan(24);
  const keep2 = ASM._gcMalloc(24);
  const s1 = gcR(ASM, [keep1, keep2]);       // middle 死（中间空洞）→ 进 freelist
  check('4 中间免扫块被回收', s1.freedBlocks, 1);
  check('4 freelist 有 1 块', ASM.__freelistCount(), 1);
  const reused = ASM._gcMalloc(24);          // 普通分配复用该块
  check('4 复用原地址', reused, middle);
  const t = ASM._gcMalloc(24);
  ASM.HEAP32[reused >> 2] = t;               // 复用块里存指针
  const s2 = gcR(ASM, [keep1, keep2, reused]);
  check('4 复用块被重新扫描（标签已清）', s2.freedBlocks, 0);
  check('4 目标保活', s2.keptBlocks, 4);
  check('4 gc 未损坏', ASM.__gcBroken(), false);
}

// ---- 5. perm 块 _gcFree 延迟回收路径不受 NOSCAN 改动影响 ----
{
  const ASM = freshASM();
  gcR(ASM, []);
  const p = ASM._gcMallocUncollectable(24);
  const s0 = gcR(ASM, []);
  check('5 perm 块默认当根存活', s0.keptBlocks, 1);
  ASM._gcFree(p);
  const s1 = gcR(ASM, []);
  check('5 free 后成为普通垃圾被回收', s1.freedBlocks, 1);
  check('5 gc 未损坏', ASM.__gcBroken(), false);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
