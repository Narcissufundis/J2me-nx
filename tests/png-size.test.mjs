/*
 * PNG 尺寸探测与解码闸门回归测试（2026-09-23 perfM 实机事故）
 *
 * 事故：玩家把自定义遮罩 PNG 放进 SD 后一选"模拟器直接退出、无报错"。
 * 根因：纯 JS 解码链一次要开 4~5 份 w*h*4（zdata → inflated → rgba →
 * ImageData → canvas 后备），1920x1080 ≈ 40~50MB，偏紧档直接 V8 fatal
 * （症状与 perfA~perfI 那批"干净退出"一致，try/catch 拦不住）。而且解码器
 * 对 IHDR 声明的尺寸毫无闸门——头部写多大就申请多大。
 *
 * 本测试钉住：
 *   A. __pngSize 只读 IHDR、零大分配、能在真实 PNG 上取到正确尺寸
 *   B. __decodePNG 自带 16MP 闸门（超限抛错，不尝试分配）
 *   C. 遮罩路径的硬上限常量存在（1920x1080 / 8MB）且解码前先探尺寸
 *
 * ⚠️ 2026-09-23 perfZ6：内置遮罩**全部改成 raw**、`data/mask.png` 已删除，所以
 * "真实 PNG"不再是随包发布的文件 —— 改成本测试**自己生成**一张 1280x720 RGBA PNG
 * 当夹具（四角不透明、中间竖窗 alpha=0，与真遮罩同形）。这样既不依赖发布产物，
 * 也顺手修掉了旧断言"romfs/mask.png 应该是 1280x720"与实际发的是 1920x1080 的
 * 历史不一致（那条以前一直红着）。
 *
 * 运行：node tests/png-size.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeMaskPng } from './lib/make-png.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'src/host/png-decoder.js'), 'utf8');
const mainSrc = readFileSync(join(root, 'app/main.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}
function fresh() {
  delete globalThis.__decodePNG;
  delete globalThis.__pngSize;
  (0, eval)(src);
  if (typeof globalThis.__pngSize !== 'function') throw new Error('__pngSize 未导出');
  return { size: globalThis.__pngSize, decode: globalThis.__decodePNG };
}

// ---- 造 PNG 头部 ----
function pngHeader(w, h, extra = 0) {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(b.buffer);
  dv.setUint32(8, 13);                       // IHDR 长度
  b.set([0x49, 0x48, 0x44, 0x52], 12);       // 'IHDR'
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  b[24] = 8;    // bitDepth
  b[25] = 6;    // colorType RGBA
  b[26] = 0; b[27] = 0; b[28] = 0;           // 压缩/filter/隔行
  return b;
}

// ---- 造一张"真"PNG（1280x720 RGBA，中间竖窗透明）当遮罩夹具 ----
// 生成器抽到 tests/lib/make-png.mjs（png-decode.test.mjs 也用它）
const REAL_PNG = makeMaskPng(1280, 720);

// ---- A. __pngSize ----
{
  const { size } = fresh();
  const s1 = size(pngHeader(1280, 720));
  check('探到 1280x720', s1.width + 'x' + s1.height, '1280x720');
  check('探到 colorType=6', s1.colorType, 6);
  check('探到 bitDepth=8', s1.bitDepth, 8);
  check('探到 interlace=0', s1.interlace, 0);
  const s2 = size(pngHeader(1920, 1080));
  check('探到 1920x1080', s2.width + 'x' + s2.height, '1920x1080');
  const s3 = size(pngHeader(3840, 2160));    // 4K：能探到（拒绝在调用方/闸门）
  check('4K 也能探到（探测不做限制）', s3.width + 'x' + s3.height, '3840x2160');
  check('非 PNG → null', size(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33])), null);
  check('太短 → null', size(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  check('空 → null', size(new Uint8Array(0)), null);
  // 真实 PNG：本测试自造的 1280x720 遮罩夹具（内置遮罩已全 raw，不再随包发 png）
  {
    const rs = size(REAL_PNG);
    check('真实 PNG 夹具探到 1280x720', rs.width + 'x' + rs.height, '1280x720');
    check('真实 PNG 夹具 colorType=6', rs.colorType, 6);
  }
}

// ---- B. 解码闸门 ----
{
  const { decode } = fresh();
  let msg = '';
  try { decode(pngHeader(30000, 30000)); } catch (e) { msg = e.message; }
  check('超限（9 亿像素）解码前就抛错', /尺寸过大/.test(msg), true);
  check('错误信息带尺寸', /30000x30000/.test(msg), true);
  let msg2 = '';
  try { decode(pngHeader(5000, 4000)); } catch (e) { msg2 = e.message; }   // 20MP > 16MP
  check('20MP 也被拒（16MP 上限）', /尺寸过大/.test(msg2), true);
  // 16MP 附近的合法尺寸不该被闸门拦（会因缺 IDAT 抛别的错）
  let msg3 = '';
  try { decode(pngHeader(4000, 4000)); } catch (e) { msg3 = e.message; }   // 刚好 16MP
  check('刚好 16MP 不触发尺寸闸门', /尺寸过大/.test(msg3), false);
  check('16MP 因缺 IDAT 抛别的错', /IDAT/.test(msg3), true);
  check('源码含 16MP 常量', src.indexOf('MAX_DECODE_PIXELS = 16 * 1024 * 1024') > 0, true);
}

// ---- C. 遮罩路径的硬上限与顺序 ----
{
  check('遮罩像素上限常量 = 1280x720（屏幕同尺寸）', /MASK_MAX_PX = 1280 \* 720/.test(mainSrc), true);
  check('遮罩文件上限常量', /MASK_MAX_BYTES = 8 \* 1024 \* 1024/.test(mainSrc), true);
  // 1920x1080 必须在业务闸门之外（实机崩溃就是它那个量级）
  const m = mainSrc.match(/MASK_MAX_PX = (\d+) \* (\d+)/);
  const cap = m ? Number(m[1]) * Number(m[2]) : 0;
  check('上限值解析出来', cap, 921600);
  check('1920x1080 超限（会被拒）', 1920 * 1080 > cap, true);
  check('1280x720 刚好通过', 1280 * 720 > cap, false);
  const iSize = mainSrc.indexOf('g.__pngSize(bytes)');
  const iDecode = mainSrc.indexOf('g.__decodePNG(bytes)', iSize > 0 ? iSize : 0);
  check('先探尺寸再解码', iSize > 0 && iDecode > iSize, true);
  check('超限抛错（不是警告）', /throw new Error\('尺寸超限 /.test(mainSrc), true);
  check('超限错误里给出上限说明', mainSrc.indexOf('上限 1280x720') > 0, true);
  check('解码前记录尺寸与内存水位', mainSrc.indexOf("'PNG ' + w + 'x' + h +") > 0, true);
  check('失败时提示玩家格式要求', mainSrc.indexOf('自定义遮罩请用 1280x720 的 PNG') > 0, true);
  check('失败时清空已加载画布', /st\.loaded = null;/.test(mainSrc), true);
  check('画布有 Node 回落实现', mainSrc.indexOf('function makeMaskCanvas(w, h)') > 0, true);
  // 崩前现场：遮罩路径日志必须逐条落盘（sdLog 攒批 400ms 会吞掉死前几行）
  check('遮罩路径有即时落盘日志函数', mainSrc.indexOf('function maskLog(line)') > 0, true);
  check('maskLog 内部调 __logFlush', /function maskLog\(line\)[\s\S]{0,200}__logFlush\(\)/.test(mainSrc), true);
  check('选遮罩的时刻立即落盘', mainSrc.indexOf("maskLog('选择 ' + d.id") > 0, true);
  check('扫描结果立即落盘', /sdMasks\.map[\s\S]{0,300}__logFlush\(\)/.test(mainSrc), true);
  check('读文件前先用 statSync 量大小', mainSrc.indexOf('g.Switch.statSync(def.file)') > 0, true);
  check('有 V8 堆水位闸门常量', /MASK_HEAP_GUARD_MB = 88/.test(mainSrc), true);
  check('堆水位超限时拒绝加载', /内存水位偏高（V8 堆 /.test(mainSrc), true);
}

// ---- D. 扫描层：中文文件名标注 ----
{
  const scanSrc = readFileSync(join(root, 'src/host/mask-scan.js'), 'utf8');
  check('扫描条目带 ascii 标志', /ascii: ascii/.test(scanSrc), true);
  check('中文名会加标注', scanSrc.indexOf('（中文名）') > 0, true);
  check('说明文本写了体积硬上限', scanSrc.indexOf('体积硬上限') > 0, true);
  check('说明文本写了 raw 精确字节数', scanSrc.indexOf('3686400') > 0, true);
}

// ---- E. inflate 输出必须是类型化缓冲（**实机 fatal 的真正根因**） ----
// 事故：1280x720 RGBA 的 PNG，IDAT 解压出来 3,686,760 字节。旧实现用
// `var out = []` + `out.push(byte)` 攒，再 `Uint8Array.from(out)` 拷一份 ——
// 370 万个元素的普通数组（15~30MB + 翻倍扩容瞬时再多一份）把偏紧档的
// V8 堆顶死，日志停在 `[mask] PNG 1280x720 …` 的下一行。桌面 Node 内存大，
// 所以仿真一直"通过"：这一组断言就是防这种"小机器上才炸"的写法回归。
{
  const { decode } = fresh();
  check('存在 GrowBuf 类型化缓冲实现', src.indexOf('function GrowBuf(cap, max)') > 0, true);
  check('inflate 不再用普通数组', !/function inflateRaw\(data, pos, maxOut\) \{\s*var out = \[\]/.test(src), true);
  check('输出是零拷贝视图（不再 Uint8Array.from）', src.indexOf('return { bytes: out.bytes(), nextPos: br.pos };') > 0, true);
  check('stored 块整块 set（不逐字节 push）', /out\.buf\.set\(br\.data\.subarray/.test(src), true);
  check('有压缩炸弹上限', /输出超出预期上限/.test(src), true);

  // 真机同尺寸的真图：解出来必须是 Uint8Array，且缓冲容量 ≤ 输出 ×2
  {
    const t0 = Date.now();
    const png = decode(REAL_PNG);
    const ms = Date.now() - t0;
    check('真图解码成功 1280x720', png.width + 'x' + png.height, '1280x720');
    check('RGBA 长度正确', png.data.length, 1280 * 720 * 4);
    check('数据是 Uint8Array', png.data instanceof Uint8Array, true);
    const st = globalThis.__pngLastStats;
    check('有 inflate 统计', !!(st && st.inflateBytes > 0), true);
    if (st) {
      // 普通数组方案在这里会是「数组长度 = 3.69M」；类型化缓冲的容量只比输出略大
      check('inflate 输出量 = 扫描行总量', st.inflateBytes, 720 * (1280 * 4 + 1));
      check('缓冲容量 ≤ 输出 ×2（类型化增长，不是数组翻倍）',
        st.inflateBufCapacity <= st.inflateBytes * 2, true);
    }
    check('解码耗时 < 3000ms（桌面）', ms < 3000, true);
    // 像素自检：夹具中间是透明窗（alpha=0），四角是装饰（alpha>0）
    const mid = (360 * 1280 + 640) * 4 + 3;
    check('窗口中心 alpha=0（透明）', png.data[mid], 0);
    check('左上角 alpha=255（不透明装饰）', png.data[3], 255);
  }
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
