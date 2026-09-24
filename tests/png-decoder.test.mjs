#!/usr/bin/env node
/*
 * png-decoder.test.mjs — PNG 解码器测试
 *  1. inflate 对拍 node:zlib（stored/fixed/dynamic 各策略）
 *  2. 生成各颜色类型/位深/滤镜的合成 PNG 验证像素
 *  3. 解码游戏 jar 里的真实 PNG（zxx/fr/zx 各抽几张）
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

const src = join(import.meta.dirname, '..', 'src', 'host', 'png-decoder.js');
const code = readFileSync(src, 'utf8');
const g = globalThis;
(new Function('globalThis', code))(g);
const decodePNG = g.__decodePNG;
const inflateRaw = g.__inflateRaw;

// ---------- 1. inflate 对拍 ----------
console.log('[1] inflate vs node:zlib');
const sources = {
  stored: Buffer.alloc(1000, 7),
  'fixed-huffman': Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  'huffman-only': Buffer.from('abcabcabcabcabcabcabcabcabcabcabc'),
  rle: Buffer.alloc(5000, 3),
  'dynamic-max': Buffer.from(Array.from({ length: 30000 }, (_, i) => (i * 31 + i % 7) & 0xff)),
  random: Buffer.from(Array.from({ length: 8192 }, () => Math.floor(Math.random() * 256))),
};
const cases = [
  ['stored', sources.stored, zlib.deflateSync(sources.stored, { level: 0 })],
  ['fixed-huffman', sources['fixed-huffman'], zlib.deflateSync(sources['fixed-huffman'], { strategy: zlib.constants.Z_FIXED })],
  ['huffman-only', sources['huffman-only'], zlib.deflateSync(sources['huffman-only'], { strategy: zlib.constants.Z_HUFFMAN_ONLY })],
  ['rle', sources.rle, zlib.deflateSync(sources.rle, { strategy: zlib.constants.Z_RLE })],
  ['dynamic-max', sources['dynamic-max'], zlib.deflateSync(sources['dynamic-max'], { level: 9 })],
  ['random', sources.random, zlib.deflateSync(sources.random, { level: 6 })],
];
for (const [name, srcBuf, zbuf] of cases) {
  // zlib = 2 字节头 + deflate + 4 字节 adler
  const out = inflateRaw(new Uint8Array(zbuf), 2);
  let ok = out.length === srcBuf.length;
  if (ok) for (let i = 0; i < out.length; i++) if (out[i] !== srcBuf[i]) { ok = false; break; }
  check('inflate ' + name, ok, `decoded ${out.length} vs source ${srcBuf.length}`);
}

// ---------- 2. 合成 PNG ----------
console.log('[2] 合成 PNG 各变体');
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const bodyAndType = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(bodyAndType));
  return Buffer.concat([len, bodyAndType, crc]);
}
function makePNG({ w, h, bitDepth, colorType, palette, trns, pixelBytes, interlace = 0, filters = null }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[12] = interlace;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', Buffer.from(palette)));
  if (trns) parts.push(chunk('tRNS', Buffer.from(trns)));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  let raw;
  if (interlace === 1) {
    // Adam7：逐 pass 逐行打包（全部 filter 0），行数据取自完整源图像素
    const ADAM7 = [
      [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
    ];
    raw = [];
    for (const [x0, y0, dx, dy] of ADAM7) {
      const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
      if (!pw || !ph) continue;
      const stride = Math.ceil(pw * channels * bitDepth / 8);
      for (let py = 0; py < ph; py++) {
        raw.push(0); // filter None
        const sy = y0 + py * dy;
        for (let pxx = 0; pxx < pw; pxx++) {
          const sx = x0 + pxx * dx;
          const srcIdx = (sy * w + sx) * channels;
          if (bitDepth === 8) {
            for (let c = 0; c < channels; c++) raw.push(pixelBytes[srcIdx + c]);
          } else if (bitDepth === 1 || bitDepth === 2 || bitDepth === 4) {
            // 子字节位深：按 x 顺序拼位
            let byte = 0, nbits = 0, outBits = 0;
            // 简化：本测试只用 8bit 走 interlace，这里不实现
            throw new Error('test generator: interlace 仅支持 8bit');
          }
        }
      }
    }
  } else {
    raw = [];
    const stride = Math.ceil(w * channels * bitDepth / 8);
    for (let y = 0; y < h; y++) {
      const f = filters ? filters(y) : 0;
      raw.push(f);
      for (let x = 0; x < stride; x++) {
        const i = y * stride + x;
        const prev = i - stride;
        const a = x >= channels ? pixelBytes[i - channels] : 0;
        const b = prev >= 0 ? pixelBytes[prev] : 0;
        const c = (x >= channels && prev >= 0) ? pixelBytes[prev - channels] : 0;
        const paeth = (() => { const p = a + b - c, A = Math.abs(p - a), B = Math.abs(p - b), C = Math.abs(p - c); return (A <= B && A <= C) ? a : (B <= C ? b : c); })();
        let v = pixelBytes[i];
        if (f === 1) v = (v - a) & 0xff;
        else if (f === 2) v = (v - b) & 0xff;
        else if (f === 3) v = (v - ((a + b) >> 1)) & 0xff;
        else if (f === 4) v = (v - paeth) & 0xff;
        raw.push(v & 0xff);
      }
    }
  }
  parts.push(chunk('IDAT', zlib.deflateSync(Buffer.from(raw))));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// 2a. RGBA 8-bit，全部 5 种滤镜逐行
{
  const w = 5, h = 5;
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + 11) & 0xff;
  px[3] = 255; // 首像素 alpha（filter0 行首字节也是 filter 标记，避免混淆）
  const png = makePNG({ w, h, bitDepth: 8, colorType: 6, pixelBytes: px, filters: (y) => y });
  const r = decodePNG(new Uint8Array(png));
  let ok = r.width === w && r.height === h && r.data.length === w * h * 4;
  if (ok) for (let i = 0; i < px.length; i++) if (r.data[i] !== px[i]) { ok = false; break; }
  check('RGBA 8bit + 5 种滤镜逐行还原', ok);
}
// 2b. 灰度 8-bit
{
  const w = 7, h = 3;
  const px = Uint8Array.from({ length: w * h }, (_, i) => (i * 13) & 0xff);
  const png = makePNG({ w, h, bitDepth: 8, colorType: 0, pixelBytes: px });
  const r = decodePNG(new Uint8Array(png));
  check('灰度 8bit', r.width === w && r.height === h && r.data[4] === r.data[5] && r.data[5] === r.data[6] && r.data[7] === 255);
}
// 2c. 调色板 4-bit + tRNS
{
  const w = 4, h = 2;
  const palette = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0];
  const trns = [255, 128, 0, 64];
  // 像素索引: 行0 = 0,1,2,3；行1 = 3,2,1,0（每像素 4 bit，两像素一字节）
  const px = new Uint8Array([0x01, 0x23, 0x32, 0x10]);
  const png = makePNG({ w, h, bitDepth: 4, colorType: 3, palette, trns, pixelBytes: px });
  const r = decodePNG(new Uint8Array(png));
  // 期望：像素(0,0)=红/255，(1,0)=绿/128，(2,0)=蓝/0，(3,0)=黄/64，(0,1)=黄/64
  const ok = r.width === w && r.height === h &&
    r.data[0] === 255 && r.data[1] === 0 && r.data[2] === 0 && r.data[3] === 255 &&
    r.data[4] === 0 && r.data[5] === 255 && r.data[6] === 0 && r.data[7] === 128 &&
    r.data[11] === 0 &&   // (2,0) alpha = trns[2] = 0
    r.data[15] === 64 &&  // (3,0) alpha = trns[3] = 64
    r.data[16 + 0] === 255 && r.data[16 + 1] === 255 && r.data[16 + 2] === 0 && r.data[16 + 3] === 64;
  check('调色板 4bit + tRNS alpha', ok);
}
// 2d. 灰度 1-bit
{
  const w = 8, h = 1;
  const px = new Uint8Array([0b10110010]);
  const png = makePNG({ w, h, bitDepth: 1, colorType: 0, pixelBytes: px });
  const r = decodePNG(new Uint8Array(png));
  // 0xB2 = 1,0,1,1,0,0,1,0（高位在前）
  const bits = [1, 0, 1, 1, 0, 0, 1, 0];
  let ok = r.width === 8;
  for (let x = 0; x < 8 && ok; x++) ok = r.data[x * 4] === bits[x] * 255 && r.data[x * 4 + 3] === 255;
  check('灰度 1bit', ok);
}
// 2e. RGB 16-bit（取高字节）
{
  const w = 2, h = 1;
  const px = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33, 0x44]);
  const png = makePNG({ w, h, bitDepth: 16, colorType: 2, pixelBytes: px });
  const r = decodePNG(new Uint8Array(png));
  const ok = r.data[0] === 0x12 && r.data[1] === 0x34 && r.data[2] === 0x56 && r.data[3] === 255;
  check('RGB 16bit 高字节', ok);
}
// 2f. Adam7 隔行（灰度 8，容易手算）
{
  const w = 5, h = 5;
  const px = Uint8Array.from({ length: w * h }, (_, i) => i);
  const png = makePNG({ w, h, bitDepth: 8, colorType: 0, pixelBytes: px, interlace: 1 });
  let r = null, err = null;
  try { r = decodePNG(new Uint8Array(png)); } catch (e) { err = e; }
  let ok = r && r.width === w && r.height === h;
  if (ok) {
    // 逐像素验证：adam7 展开后 (x,y) 的值应等于 y*w+x
    for (let y = 0; y < h && ok; y++) for (let x = 0; x < w && ok; x++) {
      if (r.data[(y * w + x) * 4] !== y * w + x) ok = false;
    }
  }
  check('Adam7 隔行还原', ok, err && err.message);
}

// ---------- 3. 游戏 jar 真实 PNG ----------
console.log('[3] 游戏 jar 真实 PNG');
const JAR_TOOL = 'D:/j2me/jdk1.8.0_281/bin/jar.exe';
const games = ['zxx', 'fr', 'zx'];
const gamesDir = 'D:/BaiduNetdiskDownload/幼儿园伙伴版/j2me4ns/j2me-vm/games';
let totalDecoded = 0, totalFailed = 0;
for (const game of games) {
  const tmp = mkdtempSync(join(tmpdir(), 'png-'));
  try {
    execFileSync(JAR_TOOL, ['xf', join(gamesDir, game + '.jar')], { cwd: tmp });
    const pngs = readdirSync(tmp, { recursive: true }).filter((f) => f.toLowerCase().endsWith('.png')).slice(0, 12);
    let okCount = 0, failCount = 0, failMsg = '';
    for (const f of pngs) {
      try {
        const bytes = readFileSync(join(tmp, f));
        const r = decodePNG(new Uint8Array(bytes));
        if (r.width > 0 && r.height > 0 && r.data.length === r.width * r.height * 4) okCount++;
        else { failCount++; failMsg = f + ' 尺寸异常'; }
      } catch (e) { failCount++; failMsg = f + ': ' + e.message; }
    }
    totalDecoded += okCount; totalFailed += failCount;
    check(`${game}.jar PNG 解码 ${okCount}/${pngs.length}`, failCount === 0, failMsg);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`---\n通过 ${passed}，失败 ${failed}；真实 PNG: 解码成功 ${totalDecoded}，失败 ${totalFailed}`);
process.exit(failed || totalFailed ? 1 : 0);
