#!/usr/bin/env node
/*
 * build.mjs — 构建三星兼容层测试包 samsungtest.jar
 *
 * 做三件事（都可重复跑，幂等）：
 *   ① 生成 test.mid：一个**最小合法 SMF（Type 0）**，两只音符 + 结束事件。
 *      自造而不是从游戏 jar 里抠，是为了仓库里不放游戏素材。
 *   ② javac 编译 SamsungTest.java（**必须 -encoding UTF-8**：中文 Windows 上
 *      javac 默认按 GBK 读 UTF-8 源码，中文字面量会在 class 里烂掉，见 textinput-test/README）。
 *   ③ jar 打包（含内部类 SamsungTest$MainCanvas.class + MANIFEST 指定入口）。
 *
 * 用法：node tools/samsung-test/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..', '..');
const JDK = process.env.JDK_BIN || 'D:/j2me/jdk1.8.0_281/bin';
const CLASSES_JAR = path.join(ROOT, 'data', 'java', 'classes.jar');

// ---------- ① 最小合法 MIDI（SMF format 0） ----------
function makeMinimalMidi() {
  const vlq = (n) => (n < 0x80 ? [n] : [((n >> 7) & 0x7f) | 0x80, n & 0x7f]);
  const ev = [];
  // 0 拍：音色 0（钢琴）→ 音高 60 → 力度 100
  ev.push(...vlq(0), 0xC0, 0x00);
  ev.push(...vlq(0), 0x90, 60, 100);
  ev.push(...vlq(96), 0x80, 60, 0);      // 96 ticks 后停
  ev.push(...vlq(0), 0x90, 64, 100);     // 再一个音
  ev.push(...vlq(96), 0x80, 64, 0);
  ev.push(...vlq(0), 0xFF, 0x2F, 0x00);  // End of Track
  const track = Buffer.from([0x4d, 0x54, 0x72, 0x6b, ...be32(ev.length), ...ev]);
  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, ...be32(6),
    0x00, 0x00,            // format 0
    0x00, 0x01,            // 1 track
    0x00, 0x60,            // division = 96 ticks/quarter
  ]);
  return Buffer.concat([header, track]);
}
function be32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

const midPath = path.join(HERE, 'test.mid');
const mid = makeMinimalMidi();
const oldMid = fs.existsSync(midPath) ? fs.readFileSync(midPath) : null;
if (!oldMid || !oldMid.equals(mid)) {
  fs.writeFileSync(midPath, mid);
  console.log('[1] 生成 test.mid ' + mid.length + 'B（SMF Type 0，自造）');
} else {
  console.log('[1] test.mid 已是最新 ' + mid.length + 'B');
}

// ---------- ② javac ----------
const javac = path.join(JDK, 'javac.exe');
if (!fs.existsSync(javac)) throw new Error('找不到 javac: ' + javac + '（可用 JDK_BIN 环境变量指定）');
if (!fs.existsSync(CLASSES_JAR)) throw new Error('找不到 ' + CLASSES_JAR + '，先跑 node tools/build-classes.mjs');
execFileSync(javac, ['-encoding', 'UTF-8', '-nowarn', '-Xlint:none', '-source', '1.3', '-target', '1.3',
  '-bootclasspath', '', '-extdirs', '', '-cp', CLASSES_JAR, '-d', HERE, 'SamsungTest.java'],
  { cwd: HERE, stdio: 'inherit' });
console.log('[2] javac 完成（-encoding UTF-8）');

// ---------- ③ jar ----------
const mfPath = path.join(HERE, 'MANIFEST.MF');
fs.writeFileSync(mfPath, [
  'Manifest-Version: 1.0',
  'MIDlet-Name: SamsungTest',
  'MIDlet-Version: 1.0.0',
  'MIDlet-Vendor: j2me-nx-port',
  'MIDlet-1: SamsungTest, , SamsungTest',
  'MicroEdition-Configuration: CLDC-1.1',
  'MicroEdition-Profile: MIDP-2.0',
  '',
].join('\r\n'));

const jarPath = path.join(HERE, 'samsungtest.jar');
if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
execFileSync(path.join(JDK, 'jar.exe'),
  ['cfm', jarPath, 'MANIFEST.MF', 'SamsungTest.class', 'SamsungTest$MainCanvas.class', 'test.mid'],
  { cwd: HERE, stdio: 'inherit' });
const size = fs.statSync(jarPath).size;
console.log('[3] samsungtest.jar ' + size + 'B');
console.log('OK  构建完成 → ' + jarPath);
