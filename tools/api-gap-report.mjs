#!/usr/bin/env node
/*
 * api-gap-report.mjs — API 缺口清单（报告型工具，不参与 CI、永远 exit 0）
 *
 * 回答的问题：我们类库里**声明了 native、JS/TS 侧却没人管**的都是哪些？
 * 为什么重要：VM 对"没注册的 native"不抛异常、不崩，只打一行日志就返回空函数
 *   （见 vendor/pluotsorbet/vm/runtime.ts:904）。于是缺口的症状是"**那块功能静默消失**"，
 *   从日志几乎看不出因果 —— 1.jar 立绘/地图全黑（DirectGraphics.drawImage 从未实现）就是这么来的。
 *
 * 用法：
 *   node tools/api-gap-report.mjs                 # 按包汇总 + 逐条清单
 *   node tools/api-gap-report.mjs --by-class      # 按类汇总（更好定位）
 *   node tools/api-gap-report.mjs --out gap.txt   # 落 UTF-8 文件
 *   node tools/api-gap-report.mjs --ref <参考源码树>   # 标注"参考实现已有"的条目
 *
 * 口径：
 *   · 我们声明 = java/{cldc1.1.1,vm,midp,custom,jsr-256,jsr-179,jsr-082} 里的 native 声明
 *     （同名文件按 build-classes.mjs 的顺序后者覆盖前者）
 *   · 已实现   = 仓库里任意 .js/.ts 的 Native["..."]（含 VM 层 nat.ts，编译进 j2me.js）
 *   · 已打桩   = addUnimplementedNative("...")（只告警一次、不画、不抛）
 *   · 缺口     = 声明了但上面两者都没有 —— 调用它 = 静默什么都不做
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIRS = ['cldc1.1.1', 'vm', 'midp', 'custom', 'jsr-256', 'jsr-179', 'jsr-082'];
const PRIM = { void: 'V', int: 'I', long: 'J', boolean: 'Z', byte: 'B', short: 'S', char: 'C', float: 'F', double: 'D' };

const args = process.argv.slice(2);
const byClass = args.includes('--by-class');
const oi = args.indexOf('--out');
const outPath = oi >= 0 ? args[oi + 1] : null;
const ri = args.indexOf('--ref');
const REF = ri >= 0 ? args[ri + 1] : null;

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
const paramTypeNoName = (raw) => {
  let s = raw.trim();
  const m = s.match(/^(.*?)\s*([A-Za-z_]\w*)\s*((?:\[\s*\])*)$/);
  if (m) s = m[1] + m[3];
  return s.replace(/\s+/g, '');
};
const toDesc = (t) => {
  let dims = 0;
  while (/\[\s*\]$/.test(t)) { dims++; t = t.slice(0, t.lastIndexOf('[')); }
  return '['.repeat(dims) + (PRIM[t] ? PRIM[t] : 'L' + t.replace(/\./g, '/') + ';');
};

// ---- 1) 我们声明的 native ----
const declared = new Map();
{
  const byRel = new Map();
  for (const d of DIRS) {
    const base = path.join(ROOT, 'java', d);
    if (!fs.existsSync(base)) continue;
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.java')) byRel.set(path.relative(base, p), p);
      }
    })(base);
  }
  for (const [, file] of byRel) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const pkg = (src.match(/\bpackage\s+([\w.]+)\s*;/m) || [])[1];
    if (!pkg) continue;
    const simple = Object.create(null);
    for (const m of src.matchAll(/\bimport\s+([\w.]+)\s*;/g)) {
      const fq = m[1];
      simple[fq.slice(fq.lastIndexOf('.') + 1)] = fq;
    }
    const fix = (t) => {
      if (PRIM[t] || t.includes('.') || t.includes('[')) return t;
      if (t === 'String') return 'java.lang.String';
      if (t === 'Object') return 'java.lang.Object';
      return simple[t] || pkg + '.' + t;
    };
    const evts = [];
    // ⚠️ native 归属要用**花括号跨度**判定，不能"最近的前一个 class 声明"——
    // phoneME 里常见 `class SecurityTrusted {}` 这种标记类，它会把后面同文件里的
    // native 全算到自己头上（曾把 Display.drawTrustedIcon0 记成 SecurityTrusted 的）。
    const spans = [];
    for (const m of src.matchAll(/\b(?:class|interface)\s+(\w+)[^{;]*\{/g)) {
      let d = 0, end = -1;
      for (let i = m.index + m[0].length - 1; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}') { d--; if (d === 0) { end = i; break; } }
      }
      if (end > 0) spans.push({ name: m[1], start: m.index, end });
    }
    const ownerOf = (i) => {
      let best = null;
      for (const s of spans) if (i > s.start && i < s.end && (!best || (s.end - s.start) < (best.end - best.start))) best = s;
      return best ? best.name : null;
    };
    for (const m of src.matchAll(/\bnative\s+([\w.$]+(?:\s*\[\s*\])*)\s+(\w+)\s*\(([^)]*)\)\s*;/g)) {
      evts.push({ i: m.index, k: 'n', cls: ownerOf(m.index), ret: m[1], name: m[2], params: m[3] });
    }
    for (const e of evts) {
      const cls = e.cls;
      if (!cls) continue;
      const params = e.params.trim() === '' ? [] : e.params.split(',').map(paramTypeNoName).map(fix);
      const key = pkg.replace(/\./g, '/') + '/' + cls + '.' + e.name +
        '.(' + params.map(toDesc).join('') + ')' + toDesc(fix(e.ret.replace(/\s+/g, '')));
      declared.set(key, path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
}

// ---- 2) JS/TS 侧的注册 ----
function scanRegs(dirs) {
  const impl = new Set(), stub = new Set();
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|\.git/.test(e.name)) walk(p); continue; }
      if (!/\.(js|ts)$/.test(e.name)) continue;
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.matchAll(/Native\[\s*"([^"]+)"\s*\]/g)) impl.add(m[1]);
      for (const m of s.matchAll(/addUnimplementedNative\(\s*"([^"]+)"/g)) stub.add(m[1]);
    }
  };
  dirs.forEach(walk);
  return { impl, stub };
}
const ours = scanRegs([path.join(ROOT, 'vendor', 'pluotsorbet'), path.join(ROOT, 'src'), path.join(ROOT, 'app')]);
const ref = REF ? scanRegs([REF]) : null;

const missing = [...declared.keys()].filter((k) => !ours.impl.has(k) && !ours.stub.has(k));
const clsOf = (k) => k.slice(0, k.indexOf('.'));
const pkgOf = (k) => clsOf(k).split('/').slice(0, -1).join('/');

// ---- 3) 输出 ----
const rows = [];
rows.push('j2me-nx-port API 缺口报告');
rows.push('  声明的 native : ' + declared.size);
rows.push('  已实现        : ' + ours.impl.size + '（含 VM 层 .ts）');
rows.push('  已打桩(只告警): ' + ours.stub.size);
rows.push('  ★ 缺口(静默)  : ' + missing.length + '   ← 调用它 = 什么都不做，且每帧打一行日志');
if (ref) rows.push('  参考实现已有  : ' + missing.filter((k) => ref.impl.has(k)).length + ' 条可直接移植');
rows.push('');

const group = new Map();
for (const k of missing) {
  const key = byClass ? clsOf(k) : pkgOf(k);
  if (!group.has(key)) group.set(key, []);
  group.get(key).push(k);
}
rows.push('=== 按' + (byClass ? '类' : '包') + '汇总 ===');
[...group.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([k, ks]) => {
  const p = ref ? ks.filter((x) => ref.impl.has(x)).length : 0;
  rows.push(String(ks.length).padStart(4) + '  ' + k + (p ? '   （参考已有 ' + p + '）' : ''));
});

rows.push('');
rows.push('=== 逐条清单 ===');
[...group.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([k, ks]) => {
  rows.push('');
  rows.push('--- ' + k + '  (' + ks.length + ') ---');
  const byCls = new Map();
  for (const x of ks) {
    const c = clsOf(x);
    if (!byCls.has(c)) byCls.set(c, []);
    byCls.get(c).push(x.slice(c.length + 1));
  }
  for (const [c, ms] of byCls) {
    rows.push('  ' + c);
    ms.forEach((m) => rows.push('      ' + m + (ref && ref.impl.has(c + '.' + m) ? '   ★ 参考已有' : '')));
  }
});

if (outPath) {
  fs.writeFileSync(outPath, rows.join('\n') + '\n', 'utf8');
  console.log('已写 ' + outPath + '（' + rows.length + ' 行）');
} else {
  console.log(rows.join('\n'));
}
