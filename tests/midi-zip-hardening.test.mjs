// midi-zip-hardening.test.mjs — 2026-09-20 冻结修复回归测试
// 背景：实机"音频一启动即系统级冻结"根因 = MidiPlayer.parse 用截断数据
// 解析时死循环（主线程冻结）。zipfile.js 同类隐患一并加固。
// 运行：node tests/midi-zip-hardening.test.mjs

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS ' + name); passed++; }
  catch (e) { console.log('FAIL ' + name + ' :: ' + (e && e.message)); failed++; }
}

// ---------- 加载 midi-synth（需要 Media/jsGlobal 全局桩） ----------
globalThis.Media = {};
globalThis.jsGlobal = globalThis;
require(path.join(root, 'vendor/pluotsorbet/midp/midi-synth.js'));
const MidiPlayer = globalThis.Media.MidiPlayer;

// ---------- 加载 zipfile（需要 J2ME.ArrayUtilities.makeArrays 桩） ----------
globalThis.J2ME = {
  ArrayUtilities: {
    makeArrays: (n) => Array.from({ length: n + 1 }, (_, i) => new Array(i)),
  },
};
const { ZipFile } = require(path.join(root, 'vendor/pluotsorbet/libs/zipfile.js'));

// ---------- 工具 ----------
function u32be(v) { return [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]; }
function u16be(v) { return [(v >>> 8) & 0xFF, v & 0xFF]; }

// 最小合法 SMF：1 轨，2 个 note-on/off + tempo meta
function makeValidMidi() {
  const track = [];
  // tempo meta
  track.push(0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20);
  // note on ch0 note60 vel100 @0
  track.push(0x00, 0x90, 60, 100);
  // note off @ +96 ticks (0.5s @ 120bpm, division 96)
  track.push(0x60, 0x80, 60, 0);
  // end of track
  track.push(0x00, 0xFF, 0x2F, 0x00);
  const head = [0x4D, 0x54, 0x68, 0x64, ...u32be(6), ...u16be(0), ...u16be(1), ...u16be(96)];
  return new Uint8Array([...head, 0x4D, 0x54, 0x72, 0x6B, ...u32be(track.length), ...track]);
}

// 冻结复现数据：MTrk 声称 100 字节但实际截断（模拟 fgDownload 流式喂数据中途）
// 旧代码：pos 越过数据末尾后 d[pos]=undefined → continue 不推进 → 死循环
function makeTruncatedMidi() {
  const head = [0x4D, 0x54, 0x68, 0x64, ...u32be(6), ...u16be(0), ...u16be(1), ...u16be(96)];
  const trackPart = [0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20]; // tempo meta 后戛然而止
  return new Uint8Array([...head, 0x4D, 0x54, 0x72, 0x6B, ...u32be(100), ...trackPart]);
}

// ---------- MIDI parse 测试 ----------
test('midi: 合法 MIDI 正常解析', () => {
  const r = MidiPlayer.parse(makeValidMidi());
  if (!r) throw new Error('返回 null');
  if (r.events.length !== 2) throw new Error('事件数=' + r.events.length);
  if (!(r.duration > 0)) throw new Error('duration=' + r.duration);
});

test('midi: 截断数据（旧版死循环场景）快速返回 null 不挂死', () => {
  const t0 = Date.now();
  const r = MidiPlayer.parse(makeTruncatedMidi());
  const dt = Date.now() - t0;
  if (r !== null) throw new Error('应返回 null，实际 ' + JSON.stringify(r).slice(0, 50));
  if (dt > 1000) throw new Error('耗时 ' + dt + 'ms，疑似仍挂死');
});

test('midi: 半截数据 null → 补全后成功（模拟轮询喂完）', () => {
  const full = makeValidMidi();
  if (MidiPlayer.parse(full.subarray(0, 20)) !== null) throw new Error('半截应返回 null');
  const r = MidiPlayer.parse(full);
  if (!r || r.events.length !== 2) throw new Error('补全后应解析成功');
});

test('midi: 全垃圾数据返回 null', () => {
  if (MidiPlayer.parse(new Uint8Array(1024).fill(0x80)) !== null) throw new Error('应返回 null');
});

test('midi: division=0 返回 null（防 Infinity 时间）', () => {
  const bad = [0x4D, 0x54, 0x68, 0x64, ...u32be(6), ...u16be(0), ...u16be(1), ...u16be(0)];
  if (MidiPlayer.parse(new Uint8Array(bad)) !== null) throw new Error('应返回 null');
});

// ---------- zip 测试 ----------
// PATCH(perfZ24)：**现场生成**一个小 zip（不再依赖 bld/selfzip.bin 这个手工产物）。
// 原因：那个文件在构建产物目录里，干净 clone（或发布快照）里根本不存在，
// 于是"新克隆跑 npm test"会挂在这两条上。现在用 node:zlib 现打一个 deflate 压缩的
// 最小 zip，自包含、可重复，正好也覆盖我们要测的 inflate 路径。
const SELFZIP_TEXT = 'hello j2me zip roundtrip ' + 'x'.repeat(64);
function buildSelfZip() {
  const name = Buffer.from('hello.txt', 'utf8');
  const data = Buffer.from(SELFZIP_TEXT, 'utf8');
  const comp = zlib.deflateRawSync(data);
  const crc = zlib.crc32 ? zlib.crc32(data) : (() => {
    // Node 20 以前没有 zlib.crc32 —— 自己算一份（标准 CRC-32）
    let c = ~0 >>> 0;
    for (let i = 0; i < data.length; i++) {
      c ^= data[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return (~c) >>> 0;
  })();
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);              // version needed
  local.writeUInt16LE(0, 6);               // flags
  local.writeUInt16LE(8, 8);               // method = deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);            // local header offset
  const centralSize = central.length + name.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(local.length + name.length + comp.length, 16);
  return Buffer.concat([local, name, comp, central, name, eocd]);
}

test('zip: 合法 zip 解析 + inflate 内容一致', () => {
  const buf = buildSelfZip();
  const zf = new ZipFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), true);
  const out = zf.read('hello.txt');
  if (!out) throw new Error('entry 未找到');
  const s = Buffer.from(out).toString('utf8');
  if (!s.startsWith('hello j2me zip roundtrip')) throw new Error('内容不符: ' + s.slice(0, 40));
});

test('zip: 截断 deflate 流抛异常不挂死', () => {
  const buf = buildSelfZip();
  const zf = new ZipFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), true);
  const dirKey = Object.keys(zf.directory)[0];
  const entry = zf.directory[dirKey];
  const cut = entry.compressed_data.subarray(0, Math.max(1, entry.compressed_data.length >> 1));
  const t0 = Date.now();
  let threw = false;
  try { ZipFile.prototype.read.call({ directory: { [dirKey]: { compression_method: 8, compressed_data: cut, uncompressed_len: entry.uncompressed_len } } }, dirKey); }
  catch (e) { threw = true; }
  const dt = Date.now() - t0;
  if (!threw) throw new Error('应抛异常');
  if (dt > 1000) throw new Error('耗时 ' + dt + 'ms，疑似仍挂死');
});

test('zip: 空构造（非 zip 数据）不炸', () => {
  const zf = new ZipFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, true);
  if (zf.directory !== undefined) throw new Error('应无 directory');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
