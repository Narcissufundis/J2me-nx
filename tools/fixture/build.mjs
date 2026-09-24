#!/usr/bin/env node
/*
 * build.mjs — 构建回归测试夹具 fixture.jar（perfZ24）
 *
 * 说明：菜单 / 软重启 / 界面语言这几条端到端测试需要一个"能被菜单选中、能启动、能画帧"的
 * jar。过去用的是商业游戏 jar（不能公开），现在换成这里自制的 FixtureMidlet。
 *
 * 用法：node tools/fixture/build.mjs   （需要 JDK 8，JDK_BIN 可指定）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..', '..');
const JDK = process.env.JDK_BIN || 'D:/j2me/jdk1.8.0_281/bin';
const CLASSES_JAR = path.join(ROOT, 'data', 'java', 'classes.jar');

const javac = path.join(JDK, 'javac.exe');
if (!fs.existsSync(javac)) throw new Error('找不到 javac: ' + javac + '（用 JDK_BIN 环境变量指定 JDK 8 的 bin 目录）');
if (!fs.existsSync(CLASSES_JAR)) throw new Error('找不到 ' + CLASSES_JAR + '，先跑 node tools/build-classes.mjs');

execFileSync(javac, ['-encoding', 'UTF-8', '-nowarn', '-Xlint:none', '-source', '1.3', '-target', '1.3',
  '-bootclasspath', '', '-extdirs', '', '-cp', CLASSES_JAR, '-d', HERE, 'FixtureMidlet.java'],
  { cwd: HERE, stdio: 'inherit' });

fs.writeFileSync(path.join(HERE, 'MANIFEST.MF'), [
  'Manifest-Version: 1.0',
  'MIDlet-Name: Fixture',
  'MIDlet-Version: 1.0.0',
  'MIDlet-Vendor: j2me-nx-port',
  'MIDlet-1: Fixture, , FixtureMidlet',
  'MicroEdition-Configuration: CLDC-1.1',
  'MicroEdition-Profile: MIDP-2.0',
  '',
].join('\r\n'));

const jarPath = path.join(HERE, 'fixture.jar');
if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
execFileSync(path.join(JDK, 'jar.exe'),
  ['cfm', jarPath, 'MANIFEST.MF', 'FixtureMidlet.class', 'FixtureMidlet$FixtureCanvas.class'],
  { cwd: HERE, stdio: 'inherit' });
console.log('[fixture] ' + jarPath + ' ' + fs.statSync(jarPath).size + 'B');
