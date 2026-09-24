// 生成 vendor/pluotsorbet/midp/adlmidi-core.js：
// 把 freej2me-web 的 libadlmidi emscripten glue（ESM）转成可在 j2me-nx-port
// 拼接 bundle（全局 eval、非 module）里运行的普通脚本。
// 转换点：
//   1) import.meta.url -> 字符串字面量（eval 场景 import.meta 是语法错误；
//      且这些路径只在 Node env / locateFile 兜底分支用到，我们不传 wasmBinary 时才走）
//   2) export default createADLMIDI; -> globalThis.__AdlMidiFactory = ...
// 用法: node tools/make-adlmidi-core.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';

const SRC = 'D:/新建文件夹/myjump/java/js/libadlmidi/dist/libadlmidi.full.core.js';
const WASM = 'D:/新建文件夹/myjump/java/js/libadlmidi/dist/libadlmidi.full.core.wasm';
const OUT_JS = 'F:/Deepseek/j2me-nx-port/vendor/pluotsorbet/midp/adlmidi-core.js';
const OUT_WASM_DIR = 'F:/Deepseek/j2me-nx-port/data/adlmidi';

let s = readFileSync(SRC, 'utf8');
const n1 = (s.match(/import\.meta\.url/g) || []).length;
// 占位必须是 Windows 合法的 file URL（带盘符），否则 Node env 分支里
// fileURLToPath(_scriptName) 会抛 "File URL path must be absolute"。
// Switch 上无 process，该分支不会执行；仅影响本机 Node 测试环境。
s = s.split('import.meta.url').join('"file:///C:/adlmidi.full.core.wasm"');
// findWasmBinary 里的 new URL 在 Switch 上必炸：instantiateAsync 无论是否传了
// wasmBinary 都会先无条件调 findWasmBinary()，而 nx.js 的 eval 环境里 URL 不是
// 构造器（实机日志："[adl] 模块加载失败: URL is not a constructor"）。
// 它只用来算 wasm 文件名，直接替换为静态 romfs 路径。
const n3 = (s.match(/new URL\("libadlmidi\.full\.core\.wasm","file:\/\/\/C:\/adlmidi\.full\.core\.wasm"\)\.href/g) || []).length;
s = s.replace(/new URL\("libadlmidi\.full\.core\.wasm","file:\/\/\/C:\/adlmidi\.full\.core\.wasm"\)\.href/g,
    '"/j2me/adlmidi.full.core.wasm"');
if (n3 !== 1) throw new Error('findWasmBinary 的 new URL 替换数=' + n3 + '（预期 1），glue 版本变了？');
// Node env 分支的动态 import：bundle 是普通脚本（eval/vm），没有动态 import
// 能力；Switch 上也没有 process，该分支本就不会走。直接换成空 stub。
const n2 = (s.match(/import\("node:module"\)/g) || []).length;
s = s.split('import("node:module")').join('Promise.resolve({createRequire:function(){var r=globalThis.__nodeRequire;if(!r)throw new Error("require disabled");return r;}})');
const marker = 'export default createADLMIDI;';
if (!s.includes(marker)) throw new Error('export default 标记未找到，glue 版本变了？');
s = s.replace(marker, 'globalThis.__AdlMidiFactory = createADLMIDI;');
if (s.includes('import.meta')) throw new Error('仍残留 import.meta');
if (/^\s*export\s/m.test(s)) throw new Error('仍残留顶层 export');

writeFileSync(OUT_JS, `/* -*- Mode: Java; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/*
 * adlmidi-core.js — libADLMIDI wasm 模块的 emscripten glue（ADLMIDI 2.x，LGPL）。
 * 来源：freej2me-web 项目 java/js/libadlmidi/dist/libadlmidi.full.core.js
 * （用户自建项目，D:/新建文件夹/myjump），经 tools/make-adlmidi-core.mjs 转换：
 *   1) import.meta.url -> 字符串字面量（bundle 是全局 eval 的普通脚本，
 *      import.meta 在解析期就是语法错误；这些路径只在 locateFile 兜底分支
 *      用到，我们恒传 wasmBinary，不会走到）；
 *   2) await import("node:module") -> 空 stub（动态 import 在脚本环境不可用；
 *      Switch 无 process，Node env 分支本就不会执行）；
 *   3) export default -> globalThis.__AdlMidiFactory；
 *   4) findWasmBinary() 里的 new URL(...).href -> 静态 romfs 路径
 *      （Switch eval 环境无 URL 构造器，见实机 2026-09-20 日志）。
 * wasm 本体从 romfs:/j2me/adlmidi.full.core.wasm 读取（Switch.readFileSync，
 * 已验证的同步读取路径），以 {wasmBinary} 传给工厂。
 * C API 面（引擎封装见 midi-synth.js 的 Media.Adlmidi）：
 *   _adl_init(sr) -> player | 0
 *   _adl_setBank(player, idx)          — 内嵌 FM 音色库（freej2me-web 默认 58）
 *   _adl_setLoopEnabled(player, 0/1)
 *   _adl_openData(player, ptr, len) -> 0 成功
 *   _adl_play(player, nSamples, ptr)   — nSamples 为 int16 交错立体声样本数
 *   _adl_atEnd(player) / _adl_positionTell(player) / _adl_totalTimeLength(player)
 *   _adl_positionRewind(player) / _adl_close(player) / _malloc / _free / HEAP16
 */
'use strict';
` + s + '\n');
console.log('written', OUT_JS, 'import.meta.url x' + n1 + ', node:import x' + n2);

mkdirSync(OUT_WASM_DIR, { recursive: true });
copyFileSync(WASM, OUT_WASM_DIR + '/libadlmidi.full.core.wasm');
console.log('written', OUT_WASM_DIR + '/libadlmidi.full.core.wasm');
