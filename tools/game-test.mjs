#!/usr/bin/env node
/*
 * game-test.mjs — 游戏兼容性测试
 *
 * 用法: node tools/game-test.mjs <game.jar> [入口类名]
 *   - 复制 jar 到 data/midlet.jar
 *   - 自动从 jar 内 MANIFEST 提取 MIDlet-1 入口类（或用第二个参数）
 *   - 生成规范 midlet.jad
 *   - 跑 simulate 冒烟 + 25 秒观察窗，输出到 /tmp 或项目根日志
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const jarPath = process.argv[2];
const entryOverride = process.argv[3];

if (!jarPath) {
  console.error('用法: node tools/game-test.mjs <game.jar> [入口类名]');
  process.exit(1);
}

// ---- 从 jar 里读 MANIFEST（jar 是 zip，用 JDK 的 unzip 不行，手解 zip 中央目录太重；
//      直接调用 JDK jar 工具）----
const JAR_TOOL = 'D:/j2me/jdk1.8.0_281/bin/jar.exe';
const tmp = join(root, '.tmp-manifest');
mkdirSync(tmp, { recursive: true });
execFileSync(JAR_TOOL, ['xf', jarPath, 'META-INF/MANIFEST.MF'], { cwd: tmp });
const manifest = readFileSync(join(tmp, 'META-INF/MANIFEST.MF'), 'utf8');

// MIDlet-1: 名称, 图标, 类
let entry = entryOverride;
if (!entry) {
  const m = manifest.match(/^MIDlet-1\s*:\s*(.+)$/m);
  if (m) {
    const parts = m[1].split(',');
    entry = parts[parts.length - 1].trim().replace(/\//g, '.');
  }
}
if (!entry) {
  console.error('无法从 MANIFEST 提取入口类，请用第二参数指定');
  process.exit(1);
}
console.log('[game-test] 入口类: ' + entry);

// ---- 写 data/midlet.jar + midlet.jad ----
copyFileSync(jarPath, join(root, 'data', 'midlet.jar'));
const jarSize = 999999; // JAD 里仅参考
const jad = [
  'MIDlet-1: Game, icon.png, ' + entry,
  'MIDlet-Name: Game',
  'MIDlet-Vendor: test',
  'MIDlet-Version: 1.0',
  'MicroEdition-Profile: MIDP-2.0',
  'MicroEdition-Configuration: CLDC-1.1',
  'MIDlet-Jar-URL: midlet.jar',
  'MIDlet-Jar-Size: ' + jarSize,
  '',
].join('\n');
writeFileSync(join(root, 'data', 'midlet.jad'), jad);
console.log('[game-test] data/midlet.jar + midlet.jad 就绪，跑 simulate...');

// ---- 跑 simulate（25 秒观察窗）----
const NODE = process.execPath;
try {
  const out = execFileSync(NODE, [join(root, 'tools', 'simulate.mjs')], {
    timeout: 40000,
    encoding: 'utf8',
  });
  console.log(out);
} catch (e) {
  // exit code 非 0 也要输出
  console.log((e.stdout || '') + (e.stderr || ''));
}
