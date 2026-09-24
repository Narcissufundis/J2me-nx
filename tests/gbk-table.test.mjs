#!/usr/bin/env node
/*
 * gbk-table.test.mjs — 自带 GBK 映射表 + 解码器的完整性与来源守卫
 *
 * 为什么需要这张表：nx.js(Switch) 的 TextDecoder **只有 utf-8**，而中文 J2ME 游戏的
 * 文本几乎都是 GBK。桌面 Node 有完整 ICU，所以"GBK 能解"这件事在仿真里天然成立、
 * 在真机上根本不存在 —— 2026-09-23 实机「Forgotten Warrior 丢文字」就吃了这个亏。
 *
 * 本测试做三件事：
 *   ① 表是**可复现的**：vendor/pluotsorbet/midp/gbk-table.js 必须与
 *      `node tools/make-gbk-table.mjs` 重新生成的结果逐字节一致（手改表会被抓）；
 *   ② 解码器（vendor/pluotsorbet/midp/gbk.js，测试直接加载**真代码**）与宿主 ICU
 *      `TextDecoder('gbk')` 在 2 字节区**完全等价**：全表 23,940 项逐项比、整段拼接流
 *      逐字符比、随机字节串比对（含非法序列与截断）；
 *   ③ 源码/构建守卫：conv.js 的探针兜底、native.js 的默认编码、Helper.java 的自动判定、
 *      build.mjs 的打包清单都在（漏一个都会让实机重新丢文字，而仿真照样全绿）。
 *
 * 用法：node tests/gbk-table.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildTable, render } from '../tools/make-gbk-table.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TABLE_FILE = path.join(ROOT, 'vendor', 'pluotsorbet', 'midp', 'gbk-table.js');
const GBK_JS = path.join(ROOT, 'vendor', 'pluotsorbet', 'midp', 'gbk.js');

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, extra = '') => {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
};
const skipCheck = (name, why) => { skip++; console.log('SKIP ' + name + '  ' + why); };

const LEADS = 126, TRAILS = 190, SIZE = LEADS * TRAILS;
const trailIndex = (b) => (b < 0x7f ? b - 0x40 : b - 0x41);
const icu = new TextDecoder('gbk', { fatal: false });
let icuOk = true;
try { icuOk = icu.decode(Uint8Array.of(0xc4, 0xe3)) === '你'; } catch (e) { icuOk = false; }

console.log('=== gbk-table: 自带 GBK 表与解码器 ===');

/* ---------------- ① 表可复现 ---------------- */
const onDisk = fs.readFileSync(TABLE_FILE, 'utf8');
const { table, mapped } = buildTable();
const regenerated = render(table);
check('gbk-table.js 与 tools/make-gbk-table.mjs 生成结果逐字节一致', onDisk === regenerated,
  onDisk === regenerated ? '' : '差 ' + Math.abs(onDisk.length - regenerated.length) + ' 字节（手改过？重跑生成脚本）');
check('映射项数量 23940（126 lead × 190 trail 全覆盖）', mapped === SIZE, 'mapped=' + mapped);

/* ---------------- ② 加载真解码器 ---------------- */
const sandbox = {};
new Function('global', onDisk.replace(/typeof globalThis !== "undefined" \? globalThis : this/, 'global'))(sandbox);
check('表载入成功且长度正确', !!sandbox.J2MEGbkTable && sandbox.J2MEGbkTable.length === SIZE,
  'len=' + (sandbox.J2MEGbkTable ? sandbox.J2MEGbkTable.length : 'null'));
const gbkSrc = fs.readFileSync(GBK_JS, 'utf8');
new Function('global', gbkSrc.replace(/typeof globalThis !== "undefined" \? globalThis : this/, 'global'))(sandbox);
const dec = sandbox.J2MEGbkDecoder;
check('gbk.js 导出 J2MEGbkDecoder.decode', !!dec && typeof dec.decode === 'function');
const T = sandbox.J2MEGbkTable;
const idx = (lead, t) => (lead - 0x81) * TRAILS + trailIndex(t);

/* 抽查：汉字、标点、ASCII、欧元 */
check('C4E3 → 你', T.charCodeAt(idx(0xc4, 0xe3)) === 0x4f60);
check('BAC3 → 好', T.charCodeAt(idx(0xba, 0xc3)) === 0x597d);
check('D3CE → 游', T.charCodeAt(idx(0xd3, 0xce)) === 0x6e38);
check('A3AC → ，(全角逗号)', T.charCodeAt(idx(0xa3, 0xac)) === 0xff0c);
check('A1A1 → 　(全角空格)', T.charCodeAt(idx(0xa1, 0xa1)) === 0x3000);

/* 全表逐项 vs 宿主 ICU（仅当宿主真有 gbk 解码器时；没有就只做结构断言） */
if (icuOk) {
  let diff = 0, firstDiff = '';
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let t = 0x40; t <= 0xfe; t++) {
      if (t === 0x7f) continue;
      const s = icu.decode(Uint8Array.of(lead, t));
      const mine = T.charCodeAt(idx(lead, t));
      const theirs = s.length === 1 ? s.charCodeAt(0) : 0xfffd;
      if (mine !== theirs && diff++ === 0) firstDiff = lead.toString(16) + t.toString(16) + ': ' + mine.toString(16) + ' vs ' + theirs.toString(16);
    }
  }
  check('全表 23940 项与宿主 ICU(TextDecoder gbk) 完全一致', diff === 0, diff ? diff + ' 项不符，首个 ' + firstDiff : '');
  /* 整段拼接流：一次性解 47,880 字节，验证分块与边界 */
  const all = new Uint8Array(SIZE * 2);
  let k = 0;
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let t = 0x40; t <= 0xfe; t++) {
      if (t === 0x7f) continue;
      all[k++] = lead; all[k++] = t;
    }
  }
  check('整段 23940 对字节的流式解码与 ICU 逐字符一致', dec.decode(all) === icu.decode(all));
} else {
  skipCheck('与宿主 ICU 全表比对', '本机 Node 没有 gbk 解码器（无完整 ICU）');
}

/* 边界：ASCII / 0x80 / 非法尾字节 / 截断 / 随机串 */
check('ASCII 直通', dec.decode(Uint8Array.of(0x41, 0x42, 0x43)) === 'ABC');
check('0x80 → €（CP936）', dec.decode(Uint8Array.of(0x80)) === '\u20ac');
check('非法尾字节 81 20 → U+FFFD + 空格（不吞字节）', dec.decode(Uint8Array.of(0x81, 0x20)) === '\ufffd ');
check('非法尾字节 81 7F → U+FFFD + DEL', dec.decode(Uint8Array.of(0x81, 0x7f)) === '\ufffd\u007f');
check('截断的 81 → U+FFFD', dec.decode(Uint8Array.of(0x81)) === '\ufffd');
check('0xFF 非法首字节 → U+FFFD', dec.decode(Uint8Array.of(0xff)) === '\ufffd');
check('空输入 → 空串', dec.decode(new Uint8Array(0)) === '');

if (icuOk) {
  // 随机串比对（避开 GB18030 四字节序列：自带表只覆盖 GBK 两字节区，见 gbk.js 的说明）
  let rnd = 12345;
  const next = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) % 256;
  const isFourByte = (b) => b.some((_, i) => i + 3 < b.length &&
    b[i] >= 0x81 && b[i] <= 0xfe && b[i + 1] >= 0x30 && b[i + 1] <= 0x39 &&
    b[i + 2] >= 0x81 && b[i + 2] <= 0xfe && b[i + 3] >= 0x30 && b[i + 3] <= 0x39);
  let cases = 0, bad = 0, skipped = 0, firstBad = '';
  for (let n = 0; n < 3000; n++) {
    const len = 1 + (next() % 24);
    const bytes = Array.from({ length: len }, next);
    if (isFourByte(bytes)) { skipped++; continue; }
    const u8 = Uint8Array.from(bytes);
    const a = dec.decode(u8), b = icu.decode(u8);
    cases++;
    if (a !== b) { bad++; if (!firstBad) firstBad = Buffer.from(bytes).toString('hex') + ' → ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b); }
  }
  check('3000 组随机字节串与 ICU 一致（跳过 GB18030 四字节 ' + skipped + ' 组）', bad === 0,
    bad ? bad + '/' + cases + ' 不符，首个 ' + firstBad : cases + ' 组比对');
}

/* ---------------- ③ 真实游戏数据（有 jar 才跑） ---------------- */
const GAME = 'D:\\新建文件夹\\游戏相关\\修改版游戏\\J2ME整理\\能玩\\Forgotten Warrior.jar';
if (!fs.existsSync(GAME)) {
  skipCheck('真实游戏剧情文本（1.sn/3.sn）', '本机找不到游戏 jar');
} else {
  const { readZipEntries } = await import('../tools/zip-read.mjs');
  const entries = readZipEntries(fs.readFileSync(GAME));
  for (const [name, expect] of [['1.sn', '糟糕，我的悠悠球忘拿了'], ['3.sn', '按照剧本']]) {
    const b = entries.get(name);
    if (!b) { check('jar 里有 ' + name, false); continue; }
    const text = dec.decode(new Uint8Array(b));
    check(name + ' 用自带表解出中文且无替换字符', !text.includes('\ufffd'), '长度 ' + text.length);
    check(name + ' 含预期剧情文字「' + expect + '」', text.includes(expect), text.slice(0, 40));
  }
}

/* ---------------- ④ 源码 / 构建守卫 ---------------- */
const conv = fs.readFileSync(path.join(ROOT, 'vendor', 'pluotsorbet', 'midp', 'conv.js'), 'utf8');
check('conv.js 用 "你" 做探针（防宿主悄悄忽略编码标签）', /0xc4,\s*0xe3[\s\S]{0,200}?\\u4f60/.test(conv));
check('conv.js 探针失败时走自带解码器', /embeddedGbkDecoder\(\)/.test(conv) && /J2MEGbkDecoder/.test(conv));
check('conv.js 对 gbk 与 gb18030 两个标签都兜底', /label === "gbk" \|\| label === "gb18030"/.test(conv));

const nativeJs = fs.readFileSync(path.join(ROOT, 'vendor', 'pluotsorbet', 'native.js'), 'utf8');
check('native.js: microedition.encoding = GBK', /case "microedition.encoding":[\s\S]{0,2000}?value = "GBK";/.test(nativeJs));

const helper = fs.readFileSync(path.join(ROOT, 'java', 'cldc1.1.1', 'com', 'sun', 'cldc', 'i18n', 'Helper.java'), 'utf8');
check('Helper.java 有严格 UTF-8 校验 isValidUtf8', /private static boolean isValidUtf8\(/.test(helper));
check('Helper.java 默认路径先试 UTF-8 再落默认编码',
  /isValidUtf8\(buffer, offset, length\)[\s\S]{0,400}?byteToCharArray\(buffer, offset, length, "UTF-8"\)/.test(helper));
check('Helper.java 保留 U+FFFD 计数兜底', /countReplacementChar\(/.test(helper));

const build = fs.readFileSync(path.join(ROOT, 'tools', 'build.mjs'), 'utf8');
check('build.mjs 打包 midp/gbk-table.js', /'midp\/gbk-table\.js'/.test(build));
check('build.mjs 打包 midp/gbk.js', /'midp\/gbk\.js'/.test(build));

console.log('');
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败' + (skip ? ' / ' + skip + ' 跳过' : ''));
process.exit(fail ? 1 : 0);
