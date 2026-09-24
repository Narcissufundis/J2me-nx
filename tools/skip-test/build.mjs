#!/usr/bin/env node
/*
 * build.mjs — 构建资源流测试包 skiptest.jar（perfZ22）
 *
 *   ① 生成 big.bin：512 KiB，第 i 字节 = i & 0xFF（纯模式，跳过/读取错位立刻暴露）
 *   ② javac 编译 SkipTest.java（-encoding UTF-8，与其它测试包一致）
 *   ③ jar 打包（含内部类 Canvas + big.bin）
 *
 * 用法：node tools/skip-test/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..', '..');
const JDK = process.env.JDK_BIN || 'D:/j2me/jdk1.8.0_281/bin';
const CLASSES_JAR = path.join(ROOT, 'data', 'java', 'classes.jar');

// ---------- ① big.bin ----------
const SIZE = 512 * 1024;
const bin = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) bin[i] = i & 0xFF;
fs.writeFileSync(path.join(HERE, 'big.bin'), bin);
console.log('[1] big.bin ' + SIZE + 'B（模式 i&0xFF）');

// ---------- ② javac ----------
const javac = path.join(JDK, 'javac.exe');
if (!fs.existsSync(javac)) throw new Error('找不到 javac: ' + javac + '（可用 JDK_BIN 环境变量指定）');
if (!fs.existsSync(CLASSES_JAR)) throw new Error('找不到 ' + CLASSES_JAR + '，先跑 node tools/build-classes.mjs');
execFileSync(javac, ['-encoding', 'UTF-8', '-nowarn', '-Xlint:none', '-source', '1.3', '-target', '1.3',
  '-bootclasspath', '', '-extdirs', '', '-cp', CLASSES_JAR, '-d', HERE, 'SkipTest.java'],
  { cwd: HERE, stdio: 'inherit' });
console.log('[2] javac 完成（-encoding UTF-8）');

// ---------- ③ jar ----------
fs.writeFileSync(path.join(HERE, 'MANIFEST.MF'), [
  'Manifest-Version: 1.0',
  'MIDlet-Name: SkipTest',
  'MIDlet-Version: 1.0.0',
  'MIDlet-Vendor: j2me-nx-port',
  'MIDlet-1: SkipTest, , SkipTest',
  'MicroEdition-Configuration: CLDC-1.1',
  'MicroEdition-Profile: MIDP-2.0',
  '',
].join('\r\n'));

const jarPath = path.join(HERE, 'skiptest.jar');
if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
execFileSync(path.join(JDK, 'jar.exe'),
  ['cfm', jarPath, 'MANIFEST.MF', 'SkipTest.class', 'SkipTest$MainCanvas.class', 'big.bin'],
  { cwd: HERE, stdio: 'inherit' });
console.log('[3] skiptest.jar ' + fs.statSync(jarPath).size + 'B');
console.log('OK  构建完成 → ' + jarPath);
