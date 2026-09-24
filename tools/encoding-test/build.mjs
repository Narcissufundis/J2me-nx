#!/usr/bin/env node
/*
 * build.mjs — 构建编码测试包 enctest.jar
 *
 *   ① 用**仓库里那张 GBK 表**（vendor/pluotsorbet/midp/gbk-table.js）反查，造出
 *      test.txt 的 GBK 字节（内容 = "游戏文字测试：你好，世界。"）。
 *      刻意不依赖宿主 ICU：同一份数据在真机上也要能被自带的表解回来。
 *   ② javac 编译 EncTest.java（必须 -encoding UTF-8）
 *   ③ jar 打包（含内部类 + test.txt）
 *
 * 用法：node tools/encoding-test/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..', '..');
const JDK = process.env.JDK_BIN || 'D:/j2me/jdk1.8.0_281/bin';
const CLASSES_JAR = path.join(ROOT, 'data', 'java', 'classes.jar');

// ---------- ① GBK 反查表（从仓库里的表建，保证与运行时一致） ----------
const tableSrc = fs.readFileSync(path.join(ROOT, 'vendor', 'pluotsorbet', 'midp', 'gbk-table.js'), 'utf8');
const sandbox = {};
new Function('global', tableSrc.replace(/typeof globalThis !== "undefined" \? globalThis : this/, 'global'))(sandbox);
const TABLE = sandbox.J2MEGbkTable;
if (!TABLE || TABLE.length !== 23940) throw new Error('gbk-table.js 载入失败（表长 ' + (TABLE && TABLE.length) + '）');

const reverse = new Map();
for (let lead = 0x81; lead <= 0xfe; lead++) {
  for (let t = 0x40; t <= 0xfe; t++) {
    if (t === 0x7f) continue;
    const cp = TABLE.charCodeAt((lead - 0x81) * 190 + (t < 0x7f ? t - 0x40 : t - 0x41));
    if (cp && !reverse.has(cp)) reverse.set(cp, [lead, t]);
  }
}
function gbkEncode(str) {
  const out = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { out.push(cp); continue; }
    const b = reverse.get(cp);
    if (!b) throw new Error('GBK 表里没有 U+' + cp.toString(16) + '（' + ch + '）');
    out.push(b[0], b[1]);
  }
  return Buffer.from(out);
}

const SENTENCE = '游戏文字测试：你好，世界。';
const txt = gbkEncode(SENTENCE);
fs.writeFileSync(path.join(HERE, 'test.txt'), txt);
console.log('[1] test.txt ' + txt.length + 'B（GBK，来自自带表反查）：' + SENTENCE);
console.log('    hex = ' + txt.toString('hex'));

// ---------- ② javac ----------
const javac = path.join(JDK, 'javac.exe');
if (!fs.existsSync(javac)) throw new Error('找不到 javac: ' + javac + '（可用 JDK_BIN 环境变量指定）');
if (!fs.existsSync(CLASSES_JAR)) throw new Error('找不到 ' + CLASSES_JAR + '，先跑 node tools/build-classes.mjs');
execFileSync(javac, ['-encoding', 'UTF-8', '-nowarn', '-Xlint:none', '-source', '1.3', '-target', '1.3',
  '-bootclasspath', '', '-extdirs', '', '-cp', CLASSES_JAR, '-d', HERE, 'EncTest.java'],
  { cwd: HERE, stdio: 'inherit' });
console.log('[2] javac 完成（-encoding UTF-8）');

// ---------- ③ jar ----------
fs.writeFileSync(path.join(HERE, 'MANIFEST.MF'), [
  'Manifest-Version: 1.0',
  'MIDlet-Name: EncTest',
  'MIDlet-Version: 1.0.0',
  'MIDlet-Vendor: j2me-nx-port',
  'MIDlet-1: EncTest, , EncTest',
  'MicroEdition-Configuration: CLDC-1.1',
  'MicroEdition-Profile: MIDP-2.0',
  '',
].join('\r\n'));

const jarPath = path.join(HERE, 'enctest.jar');
if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
execFileSync(path.join(JDK, 'jar.exe'),
  ['cfm', jarPath, 'MANIFEST.MF', 'EncTest.class', 'EncTest$MainCanvas.class', 'test.txt'],
  { cwd: HERE, stdio: 'inherit' });
console.log('[3] enctest.jar ' + fs.statSync(jarPath).size + 'B');
console.log('OK  构建完成 → ' + jarPath);
