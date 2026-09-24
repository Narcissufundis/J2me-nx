/*
 * native-heap 单元测试 — 验证 ASM 长整数运算符合 Java 语义
 * 运行：node tests/native-heap.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'src/native-heap.js'), 'utf8');
// 以脚本方式执行（产生全局 ASM）
(0, eval)(src);

const ASM = globalThis.ASM;
if (!ASM) throw new Error('ASM 未导出');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

function i64(v) { return BigInt.asIntN(64, v); }
const MIN = -0x8000000000000000n;

// ---- 分配器 ----
const a = ASM._gcMalloc(16);
const b = ASM._gcMalloc(16);
check('alloc nonzero', a > 0, true);
check('alloc distinct', a !== b, true);
check('alloc 8-aligned', a % 8 === 0, true);
check('alloc zeroed', ASM.HEAPU8[a + 7], 0);
ASM._gcFree(a); // no-op，不应抛错
ASM._gcFree(0); // NULL 也不应崩
check('usedHeapSize > 0', ASM._getUsedHeapSize() > 0, true);
check('gcMallocAtomic also ok', ASM._gcMallocAtomic(8) > 0, true);
check('gcMallocUncollectable also ok', ASM._gcMallocUncollectable(8) > 0, true);

// 巨大分配应返回 0（OOM 约定）
check('OOM returns 0', ASM._gcMalloc(1024 * 1024 * 1024 * 8), 0);

// ---- 64 位读写 + 运算 ----
// 工具：把 JS BigInt 写入 addr，跑 op，读回
function binop(op, x, y) {
  ASM.HEAP32[a >> 2] = Number(i64(x) & 0xffffffffn) | 0;
  ASM.HEAP32[(a + 4) >> 2] = Number((i64(x) >> 32n) & 0xffffffffn) | 0;
  ASM.HEAP32[b >> 2] = Number(i64(y) & 0xffffffffn) | 0;
  ASM.HEAP32[(b + 4) >> 2] = Number((i64(y) >> 32n) & 0xffffffffn) | 0;
  ASM[op](a, a, b);
  return BigInt.asIntN(64, BigInt(ASM.HEAP32[(a + 4) >> 2] | 0) << 32n | BigInt(ASM.HEAP32[a >> 2] >>> 0));
}

check('lAdd basic', binop('_lAdd', 1n, 2n), 3n);
check('lAdd wrap', binop('_lAdd', MIN, -1n), 0x7fffffffffffffffn); // MIN + -1 回绕成 MAX
check('lAdd neg', binop('_lAdd', -5n, 5n), 0n);
check('lAdd carry', binop('_lAdd', 0xffffffffn, 1n), 0x100000000n);
check('lSub basic', binop('_lSub', 10n, 3n), 7n);
check('lSub wrap', binop('_lSub', MIN, 1n), 0x7fffffffffffffffn);
check('lMul basic', binop('_lMul', 123456789n, 987654321n), i64(123456789n * 987654321n));
check('lMul overflow', binop('_lMul', 0x7fffffffffffffffn, 3n), i64(0x7fffffffffffffffn * 3n));
check('lDiv trunc', binop('_lDiv', -7n, 2n), -3n); // Java 向零截断
check('lDiv MIN/-1', binop('_lDiv', MIN, -1n), MIN);
check('lRem basic', binop('_lRem', -7n, 2n), -1n); // Java 余数符号随被除数
check('lRem 7/-2', binop('_lRem', 7n, -2n), 1n);

// 位移（第三参是数值不是地址）
function shiftop(op, x, s) {
  ASM.HEAP32[a >> 2] = Number(i64(x) & 0xffffffffn) | 0;
  ASM.HEAP32[(a + 4) >> 2] = Number((i64(x) >> 32n) & 0xffffffffn) | 0;
  ASM[op](a, a, s);
  return BigInt.asIntN(64, BigInt(ASM.HEAP32[(a + 4) >> 2] | 0) << 32n | BigInt(ASM.HEAP32[a >> 2] >>> 0));
}
check('lShl 1<<40', shiftop('_lShl', 1n, 40), 1n << 40n);
check('lShl mask63', shiftop('_lShl', 1n, 64), 1n); // shift&63
check('lShr arith', shiftop('_lShr', -8n, 1n), -4n);
check('lShr MIN', shiftop('_lShr', MIN, 63), -1n);
check('lUshr logical', shiftop('_lUshr', -1n, 1), i64(0x7fffffffffffffffn));
check('lUshr MIN', shiftop('_lUshr', MIN, 63), 1n);

// lCmp：dst 写 i32
ASM.HEAP32[a >> 2] = Number(MIN & 0xffffffffn) | 0;
ASM.HEAP32[(a + 4) >> 2] = Number((MIN >> 32n) & 0xffffffffn) | 0;
ASM.HEAP32[b >> 2] = 0; ASM.HEAP32[(b + 4) >> 2] = 0;
ASM._lCmp(a + 8, a, b);
check('lCmp MIN<0', ASM.HEAP32[(a + 8) >> 2], -1);

// lNeg
ASM.HEAP32[a >> 2] = 5; ASM.HEAP32[(a + 4) >> 2] = 0;
ASM._lNeg(a, a);
check('lNeg', BigInt.asIntN(64, BigInt(ASM.HEAP32[(a + 4) >> 2] | 0) << 32n | BigInt(ASM.HEAP32[a >> 2] >>> 0)), -5n);

// 弱链接注册/注销不抛错且计数正确
const h = ASM._gcMalloc(4);
ASM._gcRegisterDisappearingLink(h, b);
check('link count 1', ASM.__disappearingLinkCount(), 1);
ASM._gcUnregisterDisappearingLink(h);
check('link count 0', ASM.__disappearingLinkCount(), 0);
ASM._registerFinalizer(a);
ASM._forceCollection();
ASM._collectALittle();

// f64 视图可用性（VM 依赖存取 double 字段）
ASM.HEAPF64[a >> 2] = 3.14159;
check('f64 roundtrip', ASM.HEAPF64[a >> 2], 3.14159);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
