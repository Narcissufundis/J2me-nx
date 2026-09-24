#!/usr/bin/env node
/*
 * preprocess.mjs — PluotSorbet 的 .in 模板预处理（Node 版）
 *
 * 支持两种语法（与 tools/preprocess-1.1.0 兼容的子集）：
 *   @VAR@            —— 变量替换（config.ts.in 用 @RELEASE@ 风格）
 *   // #if X == 1    —— 行级条件块（bindings.ts.in 用）
 *   // #endif
 *
 * 用法：node tools/preprocess.mjs <in> <out> VAR=value [VAR=value ...]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , inFile, outFile, ...defs] = process.argv;
if (!inFile || !outFile) {
  console.error('用法: node preprocess.mjs <in> <out> VAR=value ...');
  process.exit(1);
}

const vars = {};
for (const d of defs) {
  const eq = d.indexOf('=');
  vars[d.slice(0, eq)] = d.slice(eq + 1);
}

let text = readFileSync(inFile, 'utf8');
const lines = text.split('\n');
const out = [];

// 条件栈：每层 { active, matched }
const condStack = [];
function isActive() {
  return condStack.every((c) => c.active);
}

for (const line of lines) {
  const ifMatch = line.match(/^\s*\/\/\s*#if\s+(\w+)\s*==\s*(\S+)\s*$/);
  if (ifMatch) {
    const [, name, value] = ifMatch;
    const parentActive = condStack.every((c) => c.active);
    condStack.push({ active: parentActive && vars[name] === value });
    continue;
  }
  if (/^\s*\/\/\s*#endif\b/.test(line)) {
    condStack.pop();
    continue;
  }
  if (/^\s*\/\/\s*#else\b/.test(line)) {
    if (condStack.length) {
      const top = condStack[condStack.length - 1];
      top.active = !top.active && condStack.slice(0, -1).every((c) => c.active);
    }
    continue;
  }
  if (isActive()) {
    out.push(line.replace(/@(\w+)@/g, (m, name) => {
      if (!(name in vars)) {
        throw new Error(`未定义的变量 @${name}@ (文件 ${inFile})`);
      }
      return vars[name];
    }));
  }
}

if (condStack.length) {
  throw new Error(`${inFile}: #if/#endif 不匹配`);
}

writeFileSync(outFile, out.join('\n'));
console.log(`preprocess: ${inFile} -> ${outFile}`);
