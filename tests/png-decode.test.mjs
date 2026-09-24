/*
 * PNG 解码语义回归测试（j2me-nx-port 宿主层）
 *
 * 为什么单独一个：2026-09-23 为了修实机 fatal 改了解码器两处内部结构
 *   A. inflate 输出：普通数组 push（3.7MB 输出要 33.6MB V8 堆）→ 类型化缓冲
 *   B. 反滤波：整图缓冲 → 逐行两行缓冲（省 3.7MB）
 * 两处都属于"像素结果必须一模一样"的重构，所以这里用**旧实现当参照**逐字节对比，
 * 并补上此前完全没测过的 **Adam7 隔行**分支（截图工具很爱输出隔行 PNG）。
 *
 * 参照实现：romfs/host/png-decoder.js（= perfP 打包进 NRO 的那一版，含旧的
 * 数组式 inflate + 整图 unfilter）。以后 romfs 更新到新版时本测试会退化为
 * "自己和自己比"，届时改用 git/备份里的旧文件当参照。
 *
 * 运行：node tests/png-decode.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeMaskPng } from './lib/make-png.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}
function loadSandbox(path) {
  const g = {};
  g.globalThis = g;
  vm.createContext(g);
  vm.runInContext(readFileSync(path, 'utf8'), g);
  return g;
}
const NEW = loadSandbox(join(root, 'src/host/png-decoder.js'));
const OLD_PATH = join(root, 'romfs/host/png-decoder.js');
const OLD = existsSync(OLD_PATH) ? loadSandbox(OLD_PATH) : null;
const sha = (b) => createHash('sha256').update(Buffer.from(b)).digest('hex').toUpperCase();

// ---- 手工造 PNG（可指定隔行），用来覆盖 Adam7 ----
const zlib = require('node:zlib');
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
// px: (x,y) -> [r,g,b,a]
function makePNG(w, h, px, interlace) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = interlace ? 1 : 0;
  const rows = [];
  if (!interlace) {
    for (let y = 0; y < h; y++) {
      const row = [0];
      for (let x = 0; x < w; x++) row.push(...px(x, y));
      rows.push(Buffer.from(row));
    }
  } else {
    const PASS = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
      [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
    for (const [x0, y0, dx, dy] of PASS) {
      for (let y = y0; y < h; y += dy) {
        const row = [0];
        let any = false;
        for (let x = x0; x < w; x += dx) { row.push(...px(x, y)); any = true; }
        if (any) rows.push(Buffer.from(row));
      }
    }
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const gradient = (x, y) => [x * 17 & 255, y * 23 & 255, (x * y) & 255, (x % 3 === 0) ? 128 : 255];

// ---- 1. 非隔行 vs 隔行：新实现自己解出来的像素必须都是"源像素" ----
for (const [w, h] of [[2, 2], [3, 3], [8, 8], [17, 9], [40, 24]]) {
  const plain = NEW.__decodePNG(makePNG(w, h, gradient, false));
  const adam = NEW.__decodePNG(makePNG(w, h, gradient, true));
  check(`隔行 ${w}x${h} 尺寸`, adam.width + 'x' + adam.height, `${w}x${h}`);
  check(`隔行 ${w}x${h} 与非隔行逐字节一致`, sha(adam.data) === sha(plain.data), true);
  // 抽 3 个点核对源值（防止"两边都错得一样"）
  let okAll = true;
  for (const [x, y] of [[0, 0], [w - 1, h - 1], [(w >> 1), (h >> 1)]]) {
    const i = (y * w + x) * 4, want = gradient(x, y);
    if (adam.data[i] !== want[0] || adam.data[i + 1] !== want[1] ||
        adam.data[i + 2] !== want[2] || adam.data[i + 3] !== want[3]) okAll = false;
  }
  check(`隔行 ${w}x${h} 抽样像素等于源值`, okAll, true);
}

// ---- 2. 与旧实现（perfP 那版）逐字节等价 ----
if (OLD) {
  const cases = [];
  for (const [w, h] of [[2, 2], [8, 8], [17, 9], [64, 48]]) {
    cases.push([`非隔行 ${w}x${h}`, makePNG(w, h, gradient, false)]);
    cases.push([`隔行 ${w}x${h}`, makePNG(w, h, gradient, true)]);
  }
  // 真机同尺寸的真图：以前读随包发布的 romfs/mask.png；perfZ6 起内置遮罩全 raw，
  // 该 png 已删除 → 改成自己造一张同尺寸同形（1280x720、中间透明窗）的 PNG。
  cases.push(['真 1280x720 遮罩（自造夹具）', makeMaskPng(1280, 720)]);
  let same = 0, diff = 0;
  for (const [name, buf] of cases) {
    let a, b;
    try { a = NEW.__decodePNG(buf); } catch (e) { a = null; }
    try { b = OLD.__decodePNG(buf); } catch (e) { b = null; }
    const eq = a && b && a.width === b.width && a.height === b.height && sha(a.data) === sha(b.data);
    if (eq) same++; else { diff++; console.error(`  ✗ ${name} 与旧实现不一致`); }
  }
  check(`与旧实现逐字节等价 ${cases.length} 例`, diff, 0);
  check('等价例数正确', same, cases.length);
} else {
  check('romfs 旧参照存在（打包后才删）', existsSync(OLD_PATH), true);
}

// ---- 3. inflate 三种块类型 ----
{
  const data = Buffer.alloc(5000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 255;
  // stored（level 0）
  const stored = zlib.deflateSync(data, { level: 0 });
  check('stored 块解压正确', Buffer.compare(Buffer.from(NEW.__inflateRaw(stored, 2)), data), 0);
  // dynamic Huffman（默认）
  const dyn = zlib.deflateSync(data);
  check('dynamic 块解压正确', Buffer.compare(Buffer.from(NEW.__inflateRaw(dyn, 2)), data), 0);
  // fixed Huffman：小数据 + level 1 常出 fixed 块
  const fx = zlib.deflateSync(data.subarray(0, 64), { strategy: zlib.constants.Z_FIXED });
  check('fixed 块解压正确', Buffer.compare(Buffer.from(NEW.__inflateRaw(fx, 2)), data.subarray(0, 64)), 0);
  // 长距离回引（重复数据）走 out.buf 重叠拷贝路径
  const rep = Buffer.alloc(100000, 0xab);
  check('重复数据（重叠回引）正确', Buffer.compare(Buffer.from(NEW.__inflateRaw(zlib.deflateSync(rep), 2)), rep), 0);
  // 压缩炸弹上限
  let msg = '';
  try { NEW.__inflateRaw(zlib.deflateSync(Buffer.alloc(2000000)), 2, 100000); } catch (e) { msg = e.message; }
  check('超上限时抛错（压缩炸弹防护）', /输出超出预期上限/.test(msg), true);
}

// ---- 4. 坏数据必须抛错而不是崩/挂 ----
{
  const bad = [Buffer.alloc(0), Buffer.from([1, 2, 3]), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)])];
  let threw = 0;
  for (const b of bad) { try { NEW.__decodePNG(b); } catch (e) { threw++; } }
  check('三种坏输入都抛错', threw, bad.length);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
