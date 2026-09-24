/*
 * tests/lib/make-png.mjs — 测试用 PNG 夹具生成器
 *
 * 为什么需要自己造 PNG：2026-09-23 perfZ6 起内置遮罩**全部改成 raw**，
 * `data/mask.png` 已删除（实机上跑 PNG 解码是大分配/秒退的嫌疑源），于是
 * "拿一张随包发布的真 PNG 当夹具"这条路没了。测试改成自己生成：
 * 不依赖发布产物，也不会因为发布内容变化而无声降级。
 *
 * makeMaskPng(w, h) 造一张与真遮罩同形的 RGBA PNG：四角不透明、中间一条竖窗
 * 完全透明（alpha=0），窗口位置与 app/main.js 里默认遮罩的透明窗一致
 * （x 373..911，见 tools/make-default-mask.mjs 的实测输出）。
 *
 * 只用 node:zlib，不引入第三方依赖。
 */
import { deflateSync } from 'node:zlib';

let CRC_TABLE = null;
export function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export const MASK_WIN_X = 373;   // 默认遮罩透明窗：x 373..911
export const MASK_WIN_W = 539;

export function makeMaskPng(w = 1280, h = 720, winX = MASK_WIN_X, winW = MASK_WIN_W) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    const off = y * (w * 4 + 1);
    raw[off] = 0;                                  // filter type 0（None）
    for (let x = 0; x < w; x++) {
      const i = off + 1 + x * 4;
      const inWin = (x >= winX && x < winX + winW);
      raw[i] = inWin ? 0 : 40;
      raw[i + 1] = inWin ? 0 : 40;
      raw[i + 2] = inWin ? 0 : 40;
      raw[i + 3] = inWin ? 0 : 255;                // 窗内全透明、窗外不透明
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
