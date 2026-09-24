#!/usr/bin/env node
/*
 * make-gbk-table.mjs — 生成 vendor/pluotsorbet/midp/gbk-table.js（GBK/CP936 → Unicode 映射表）
 *
 * 为什么需要自带表：
 *   2026-09-23 实机反馈「Forgotten Warrior 能进去了，但丢文字」。真凶是**默认编码**：
 *   游戏用 `new String(byte[])`（走平台默认编码）读剧情文本，而它的 .sn 文件是 **GBK**
 *   （实测：`1.sn` 按 UTF-8 解出 91 个 U+FFFD，按 GBK 解是"糟糕，我的悠悠球忘拿了"）。
 *   我们 VM 的 `microedition.encoding` 报的是上游默认的 **UTF-8**（native.js），于是整段
 *   剧情文字被替换字符吃掉 —— 用户看到的"丢文字"。
 *
 *   改成 GBK 之后还有第二个坑：本移植层的 GBK 转换在 `vendor/pluotsorbet/midp/conv.js`，
 *   而它是靠 `new TextDecoder('gbk')` 实现的 —— **nx.js(Switch) 的 TextDecoder 只有 utf-8**
 *   （见 src/host/env-prelude.js 里 utf-16 兼容层的注释，那是上一轮实机踩出来的）。
 *   也就是说桌面 Node 上能跑通的 GBK 解码，在真机上根本不存在。
 *   → 所以把 GBK 映射表**打进包里**，运行时不再依赖宿主 ICU。
 *
 * 表结构（与 conv.js 的 isGbkLead/isGbkTrail 一致）：
 *   索引 = (lead - 0x81) * 190 + trailIndex
 *     lead  : 0x81..0xFE            （126 个）
 *     trail : 0x40..0x7E、0x80..0xFE（190 个，跳过 0x7F）
 *   值 = Unicode 码点；0 表示未映射（GBK 里 0x0000 不是合法映射）。
 *   共 126 × 190 = 23,940 项，直接写成 JS 字符串（charCodeAt 即查表，零解码开销）。
 *
 * 用法：node tools/make-gbk-table.mjs [--check]
 *   --check  只比对现有文件是否与重新生成的一致（CI/测试用，不写盘）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'vendor', 'pluotsorbet', 'midp', 'gbk-table.js');
const CHECK = process.argv.includes('--check');

const LEADS = 126;            // 0x81..0xFE
const TRAILS = 190;           // 0x40..0x7E + 0x80..0xFE
const dec = new TextDecoder('gbk', { fatal: false });

/** trail 字节 → 表内下标（0x40..0x7E → 0..62；0x80..0xFE → 63..189）。 */
export function trailIndex(b) {
  return b < 0x7f ? b - 0x40 : b - 0x41;
}

/** 生成 23,940 项的表（0 = 未映射）。 */
export function buildTable() {
  const table = new Uint16Array(LEADS * TRAILS);
  let mapped = 0;
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let t = 0x40; t <= 0xfe; t++) {
      if (t === 0x7f) continue;
      const s = dec.decode(Uint8Array.of(lead, t));
      if (s.length === 1) {
        const cp = s.charCodeAt(0);
        if (cp !== 0xfffd && cp !== 0) {
          table[(lead - 0x81) * TRAILS + trailIndex(t)] = cp;
          mapped++;
        }
      }
    }
  }
  return { table, mapped };
}

/** 表 → 源文件文本（每个 lead 一行，方便 diff）。 */
export function render(table) {
  const lines = [];
  lines.push('/*');
  lines.push(' * gbk-table.js — GBK(CP936) 双字节 → Unicode 映射表【本文件由脚本生成，请勿手改】');
  lines.push(' *');
  lines.push(' * 生成：node tools/make-gbk-table.mjs（改了生成脚本要重跑并提交）');
  lines.push(' * 用途：nx.js(Switch) 的 TextDecoder 只有 utf-8，GBK 文本必须靠这张表解');
  lines.push(' *       （见 vendor/pluotsorbet/midp/conv.js 的 getDecoder 兜底、src/host/env-prelude.js 的说明）。');
  lines.push(' *');
  lines.push(' * 结构：索引 = (lead-0x81)*190 + trailIndex，lead 0x81..0xFE，trail 0x40..0x7E/0x80..0xFE（跳过 0x7F），');
  lines.push(' *       值 = Unicode 码点，\\u0000 = 未映射。126×190 = 23,940 项，按 lead 每行一段。');
  lines.push(' */');
  lines.push('(function (global) {');
  lines.push('    "use strict";');
  lines.push('    global.J2MEGbkTable =');
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    let chunk = '';
    for (let t = 0x40; t <= 0xfe; t++) {
      if (t === 0x7f) continue;
      chunk += '\\u' + table[(lead - 0x81) * TRAILS + trailIndex(t)].toString(16).padStart(4, '0');
    }
    const hex = '0x' + lead.toString(16);
    const tail = lead === 0xfe ? ';' : ' +';
    lines.push('        /* ' + hex + ' */ "' + chunk + '"' + tail);
  }
  lines.push('})(typeof globalThis !== "undefined" ? globalThis : this);');
  lines.push('');
  return lines.join('\n');
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { table, mapped } = buildTable();
  const text = render(table);
  if (CHECK) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    const same = cur === text;
    console.log((same ? 'OK  ' : 'FAIL') + ' gbk-table.js 与重新生成的一致（映射 ' + mapped + '/23940 项，' +
      text.length + ' 字节）');
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(OUT, text);
  console.log('生成 ' + path.relative(ROOT, OUT));
  console.log('  映射项 ' + mapped + ' / 23940（未映射 ' + (23940 - mapped) + '）');
  console.log('  文件 ' + text.length + ' 字节（每 lead 一行，' + (0xfe - 0x81 + 1) + ' 行）');
}
