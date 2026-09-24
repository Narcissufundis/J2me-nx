/*
 * 原生 PNG 解码的**格式闸门**回归（perfZ25）
 *
 * 由来：perfZ25 把 JAR 内 PNG 的解码从"纯 JS"改成"优先用 runtime 的原生 libpng
 * 解码（线程池，不占主线程）"。但读完 runtime 的 source/image.cc 后发现它的
 * decode_png 只覆盖了一部分 PNG 形态：
 *   · 只 `png_set_bgr + png_set_expand`，**没有** `png_set_gray_to_rgb`/`png_set_strip_16`；
 *   · 只在 colorType == RGBA 时预乘 alpha，而下游（canvas.cc 包 SkImage）按**预乘 BGRA** 解释；
 *   · 行距固定按 4*width 排。
 * 于是三类 PNG 交给它会出错甚至**堆越界**：
 *   ① 灰度（0/4）→ 像素错位；
 *   ② 位深≠8（16bit）→ 每行字节数 > 4*width，libpng 写越界（堆破坏）；
 *   ③ 调色板 + tRNS → 展开出的是非预乘 alpha，被按预乘解释 → 透明像素彩边。
 * 本测试把"哪些进原生、哪些必须回落 JS"的判定表钉死（判定函数由 env-prelude 导出）。
 *
 * 运行：node tests/native-png-gate.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

// ---- 在假全局里求值 env-prelude.js，取回判定函数 ----
const src = readFileSync(join(root, 'src/host/env-prelude.js'), 'utf8');
const fake = { console: { log() {}, warn() {}, error() {} } };
fake.window = fake; fake.self = fake; fake.globalThis = fake;
// eslint-disable-next-line no-new-func
const run = new Function('globalThis', 'window', 'self', src);
run(fake, fake, fake);
const nativePngSafe = fake.__nativePngSafe;
check('env-prelude 导出了判定函数 __nativePngSafe', typeof nativePngSafe, 'function');
check('env-prelude 导出了格式回落统计 __imgFmtSkip', typeof fake.__imgFmtSkip, 'object');

// ---- 造一个带指定 IHDR 的 PNG 头（签名 + IHDR + 可选 tRNS chunk） ----
function pngHeader(bitDepth, colorType, opts = {}) {
  const bytes = [];
  for (const b of [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) bytes.push(b);
  const push32 = (v) => { bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); };
  push32(13);                                   // IHDR 长度
  for (const ch of 'IHDR') bytes.push(ch.charCodeAt(0));
  push32(opts.width ?? 64); push32(opts.height ?? 64);
  bytes.push(bitDepth, colorType, 0, 0, 0);     // 位深/色彩类型/压缩/滤波/隔行
  push32(0);                                    // CRC（判定不看）
  if (opts.trns) {                              // tRNS chunk（内容不重要，只看类型名 + 长度）
    push32(6);
    for (const ch of 'tRNS') bytes.push(ch.charCodeAt(0));
    for (let i = 0; i < 6; i++) bytes.push(0);
    push32(0);
  }
  const idat = [];
  push32(0);
  for (const ch of 'IDAT') idat.push(ch.charCodeAt(0));
  return Uint8Array.from(bytes.concat(idat));
}

// ---- 允许进原生：8bit 且（RGB / RGBA / 无 tRNS 调色板）----
check('8bit 真彩 RGB → 原生', nativePngSafe(pngHeader(8, 2)), true);
check('8bit 真彩+alpha RGBA → 原生', nativePngSafe(pngHeader(8, 6)), true);
check('8bit 调色板（无 tRNS）→ 原生', nativePngSafe(pngHeader(8, 3)), true);

// ---- 必须回落纯 JS ----
check('调色板 + tRNS → 回落（非预乘 alpha 会被当成预乘）',
  nativePngSafe(pngHeader(8, 3, { trns: true })) !== true, true);
check('灰度 8bit → 回落（没做 gray→RGB）', nativePngSafe(pngHeader(8, 0)) !== true, true);
check('灰度+alpha 8bit → 回落', nativePngSafe(pngHeader(8, 4)) !== true, true);
check('真彩 16bit → 回落（否则 libpng 写越界）', nativePngSafe(pngHeader(16, 2)) !== true, true);
check('RGBA 16bit → 回落（否则 libpng 写越界）', nativePngSafe(pngHeader(16, 6)) !== true, true);
check('调色板 4bit → 回落', nativePngSafe(pngHeader(4, 3)) !== true, true);
check('非 PNG 数据 → 回落', nativePngSafe(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33])), false);
check('空数据 → 回落', nativePngSafe(new Uint8Array(0)), false);
check('null → 回落', nativePngSafe(null), false);

// ---- 回落原因要能读出人话（日志里出现的就是这个串） ----
check('灰度回落原因里写明 colorType', String(nativePngSafe(pngHeader(8, 0))).indexOf('0') >= 0, true);
check('16bit 回落原因里写明位深', String(nativePngSafe(pngHeader(16, 6))).indexOf('16') >= 0, true);
check('调色板+tRNS 的原因写明 tRNS', String(nativePngSafe(pngHeader(8, 3, { trns: true }))).indexOf('tRNS') >= 0, true);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
