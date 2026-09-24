#!/usr/bin/env node
/*
 * build.mjs — j2me-nx-port 构建脚本
 *
 * 产物（全部输出到 bld/）：
 *   bld/native.js    纯 JS 的 ASM 堆（src/native-heap.js 拷贝 + 头注释）
 *   bld/j2me.js      tsc 编译 VM（references.ts 入口，interpreter 模式无需 Relooper）
 *   bld/main-all.js  其余 JS 依 Makefile MAIN_JS_SRCS 顺序拼接
 *   gen/config/*.js  预处理产物（config.ts、bindings.ts、config/build.js）
 *
 * 用法：node tools/build.mjs [--tsc-only|--bundle-only]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = join(root, 'vendor', 'pluotsorbet');
const bld = join(root, 'bld');
const gen = join(root, 'gen');

// ---- 构建参数（与上游 Makefile 默认值一致）----
const PARAMS = {
  RELEASE: 'false', // 上游语义：布尔量（不是 0/1）
  PROFILE: '0',
  PROFILE_FORMAT: 'PLAIN',
  BENCHMARK: '0',
  CONSOLE: '0', // 上游默认 1，但 console.js 依赖 WebGL 版 terminal.js，Switch 版裁掉
  JSR_179: '1',
  JSR_256: '1',
  ASMJS_TOTAL_MEMORY: String(64 * 1024 * 1024), // 实机内存紧张：128MB→64MB（J2ME 真机堆仅几 MB，64MB 对 MIDlet 富余）
  VERSION: String(Math.floor(Date.now() / 1000)),
};

function preprocess(inFile, outFile, extraVars = {}) {
  const vars = { ...PARAMS, ...extraVars };
  const defs = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  execFileSync(
    process.execPath,
    [join(root, 'tools', 'preprocess.mjs'), inFile, outFile, ...defs],
    { stdio: 'inherit' }
  );
}

function step(name, fn) {
  process.stdout.write(`[build] ${name} ... `);
  try {
    fn();
    console.log('ok');
  } catch (e) {
    console.log('FAILED');
    throw e;
  }
}

const arg = process.argv[2] || '';
mkdirSync(bld, { recursive: true });
mkdirSync(gen, { recursive: true });

// ---- 1. 预处理 ----
if (arg !== '--bundle-only') {
  step('preprocess config.ts', () => {
    preprocess(join(vendor, 'config.ts.in'), join(vendor, 'config.ts'));
  });
  step('preprocess bindings.ts', () => {
    preprocess(join(vendor, 'bindings.ts.in'), join(vendor, 'bindings.ts'));
  });
  step('preprocess config/build.js', () => {
    preprocess(join(vendor, 'config', 'build.js.in'), join(bld, 'config-build.js'));
  });
}

// ---- 2. tsc 编译 VM ----
if (arg !== '--bundle-only') {
  step('tsc j2me.js', () => {
    const tsc = join(root, 'tools', 'node_modules', 'typescript', 'lib', 'tsc.js');
    if (!existsSync(tsc)) throw new Error('typescript 未安装: node tools/install-typescript.mjs');
    // 与上游一致：--preserveConstEnums --target ES5 references.ts -d --out bld/j2me.js
    execFileSync(
      process.execPath,
      [
        tsc,
        '--preserveConstEnums',
        '--target', 'ES5',
        '--noEmitOnError', 'false',
        'references.ts',
        '-d',
        '--out', join(bld, 'j2me.js'),
      ],
      { cwd: vendor, stdio: 'inherit' }
    );
  });
}

// ---- 3. ASM 堆 ----
step('native.js (ASM heap)', () => {
  copyFileSync(join(root, 'src', 'native-heap.js'), join(bld, 'native.js'));
});

// ---- 4. main-all.js 拼接（顺序 = 上游 Makefile MAIN_JS_SRCS）----
step('main-all.js', () => {
  const files = [
    'polyfill/canvas-toblob.js',
    'polyfill/fromcodepoint.js',
    'polyfill/codepointat.js',
    'polyfill/map.js',
    'polyfill/contains.js',
    'polyfill/find.js',
    'polyfill/findIndex.js',
    'polyfill/fround.js',
    'blackBox.js',
    'timer.js',
    'util.js',
    'native.js',
    'libs/load.js',
    'libs/zipfile.js',
    'libs/jarstore.js',
    'libs/encoding.js',
    'libs/fs.js',
    'libs/fs-init.js',
    'libs/forge/util.js',
    'libs/forge/md5.js',
    'libs/jsbn/jsbn.js',
    'libs/jsbn/jsbn2.js',
    'libs/contacts.js',
    'libs/pipe.js',
    'libs/contact2vcard.js',
    'libs/emoji.js',
    'libs/FileSaver/FileSaver.js',
    'midp/midp.js',
    'midp/frameanimator.js',
    'midp/fs.js',
    'midp/crypto.js',
    'midp/gfx.js',
    'midp/text_editor.js',
    'midp/localmsg.js',
    'midp/socket.js',
    'midp/sms.js',
    'midp/codec.js',
    'midp/gbk-table.js', // j2me-nx-port: GBK 映射表（生成物，见 tools/make-gbk-table.mjs）
    'midp/gbk.js', // j2me-nx-port: 自带 GBK 解码器（nx.js 的 TextDecoder 只有 utf-8，必须兜底）
    'midp/conv.js', // j2me-nx-port: CLDC Conv natives（GBK 等编码，Gen_Reader/Writer + Helper.byteToCharArray）
    'midp/pim.js',
    'midp/device_control.js',
    'midp/background.js',
    'midp/media.js',
    'midp/adlmidi-core.js', // j2me-nx-port: libADLMIDI wasm glue（MIDI 引擎，转换版）
    'midp/midi-synth.js', // j2me-nx-port: 纯 JS MIDI 合成器（+ADLMIDI 引擎接入）
    'midp/content.js',
    'midp/location.js',   // JSR_179 = 1
    'midp/sensor.js',     // JSR_256 = 1
    'game-ui.js',
    'main.js',            // 最后加载
  ];
  // 上游不包含但宿主必需：排除 compiled-method-cache.js（自动禁用方法缓存）
  // 与 libs/console.js（CONSOLE=0）。

  const parts = [];
  for (const f of files) {
    const p = join(vendor, f);
    if (!existsSync(p)) {
      throw new Error(`缺少源文件: ${f}`);
    }
    parts.push(`// ======== ${f} ========\n` + readFileSync(p, 'utf8'));
  }
  writeFileSync(join(bld, 'main-all.js'), parts.join('\n'));
});

console.log('[build] 完成。产物: bld/native.js, bld/j2me.js, bld/main-all.js, bld/config-build.js');
