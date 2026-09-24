#!/usr/bin/env node
/*
 * scan-3d-usage.mjs — 扫一个游戏目录，统计"哪些 jar 需要 3D API、具体用到哪些类/方法"
 *
 * 用途：评估接入 3D（Mascot Capsule / M3G）的收益与工作量，回答三件事：
 *   ① 库里到底有多少游戏真用 3D、分别是哪套 API（micro3d.v3 / M3G / Nokia m3d / …）；
 *   ② 每个类被用到哪些**方法签名** —— 这就是"接入契约"（与 tests/samsung-api.test.mjs
 *      对三星 API 做反向校验同一套路），可直接拿去比对参考实现覆盖没覆盖；
 *   ③ 哪几个 jar 值得先做（命中最多、API 面最小的先做）。
 *
 * 用法：node tools/scan-3d-usage.mjs <游戏目录> [输出文件]     # 默认 .3d-scan.txt
 *
 * ⚠️ 模拟器 jar（如 KEmulator.jar）本身**内置**了 M3G/Micro3D 实现，会把它自己引用的
 *    类算进来 —— 统计时要手动排除（2026-09-23 实测：863 个 jar 里 11 个命中 3D，
 *    其中 KEmulator 自己就贡献了大半的 M3G 引用）。
 * 输出一律写 UTF-8 文件（PowerShell 重定向会毁掉中文）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readZipEntries } from './zip-read.mjs';

const ROOT = process.argv[2] || 'D:\\新建文件夹\\游戏相关\\修改版游戏\\J2ME整理';
const OUT = process.argv[3] || '.3d-scan.txt';

const FAMILIES = [
  ['Mascot Capsule v3（com/mascotcapsule/micro3d/v3）', (c) => c.startsWith('com/mascotcapsule/micro3d/v3/')],
  ['Mascot Capsule 其它版本（micro3d 非 v3）', (c) => c.startsWith('com/mascotcapsule/micro3d/') && !c.startsWith('com/mascotcapsule/micro3d/v3/')],
  ['com/mascotcapsule 其它包', (c) => c.startsWith('com/mascotcapsule/') && !c.includes('/micro3d/')],
  ['M3G / JSR-184（javax/microedition/m3g）', (c) => c.startsWith('javax/microedition/m3g/')],
  ['Nokia m3d（com/nokia/mid/m3d）', (c) => c.startsWith('com/nokia/mid/m3d/')],
  ['com/micro3d（另一套别名）', (c) => c.startsWith('com/micro3d/')],
  ['Superscape/Sprint 3D', (c) => /^(com\/superscape|com\/sprint)/.test(c)],
];

/** 从 class 字节里抓 Methodref（类|方法|描述符）。 */
function refs(data, match) {
  const out = new Set();
  let p = 8;
  const cpCount = data.readUInt16BE(p); p += 2;
  const cp = new Array(cpCount);
  for (let i = 1; i < cpCount; i++) {
    const tag = data[p++];
    if (tag === 1) { const len = data.readUInt16BE(p); p += 2; cp[i] = { tag, s: data.toString('utf8', p, p + len) }; p += len; }
    else if (tag === 3 || tag === 4) { p += 4; cp[i] = { tag }; }
    else if (tag === 5 || tag === 6) { p += 8; cp[i] = { tag }; i++; }
    else if (tag === 7 || tag === 8 || tag === 16) { cp[i] = { tag, idx: data.readUInt16BE(p) }; p += 2; }
    else if (tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 18) { cp[i] = { tag, a: data.readUInt16BE(p), b: data.readUInt16BE(p + 2) }; p += 4; }
    else if (tag === 15) { p += 3; cp[i] = { tag }; }
    else return out;
  }
  const utf8 = (i) => (cp[i] && cp[i].s) || '';
  for (let i = 1; i < cpCount; i++) {
    const e = cp[i];
    if (!e) continue;
    if (e.tag === 10 || e.tag === 11) {
      const cls = cp[e.a], nt = cp[e.b];
      if (!cls || !nt || cls.tag !== 7) continue;
      const cn = utf8(cls.idx);
      if (!match(cn)) continue;
      out.add(cn + '|' + utf8(nt.a) + '|' + utf8(nt.b));
    } else if (e.tag === 7) {
      const cn = utf8(e.idx);
      if (match(cn)) out.add(cn + '|' + '<class>' + '|');
    }
  }
  return out;
}

const jars = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.jar$/i.test(e.name)) jars.push(p);
  }
})(ROOT);
jars.sort();

const famJars = new Map(FAMILIES.map(([n]) => [n, []]));
const clsRefs = new Map();     // 类全名 -> { methods:Set, jars:Set }
const jarFamilies = new Map(); // jar -> Set(family)

for (const jar of jars) {
  let entries;
  try { entries = readZipEntries(fs.readFileSync(jar)); } catch (e) { continue; }
  const hit = new Set();
  for (const [name, data] of entries) {
    if (!name.endsWith('.class')) continue;
    let refsList;
    try {
      refsList = refs(data, (c) => c.startsWith('com/mascotcapsule/') || c.startsWith('javax/microedition/m3g/') ||
        c.startsWith('com/nokia/mid/m3d/') || c.startsWith('com/micro3d/') || /^(com\/superscape|com\/sprint)/.test(c));
    } catch (e) { continue; }
    for (const r of refsList) {
      const [cn, m, d] = r.split('|');
      if (!clsRefs.has(cn)) clsRefs.set(cn, { methods: new Set(), jars: new Set() });
      const rec = clsRefs.get(cn);
      if (m !== '<class>') rec.methods.add(m + d);
      rec.jars.add(path.basename(jar));
      for (const [fam, test] of FAMILIES) if (test(cn)) { hit.add(fam); famJars.get(fam).push(path.basename(jar)); }
    }
  }
  if (hit.size) jarFamilies.set(path.basename(jar), hit);
}

const L = [];
L.push('# 3D API 使用扫描');
L.push('扫描根目录：' + ROOT);
L.push('jar 总数：' + jars.length);
L.push('');
L.push('## 各 API 家族命中（jar 数）');
for (const [fam, list] of famJars) {
  const uniq = [...new Set(list)];
  L.push('- ' + fam + ' : **' + uniq.length + '** 个 jar');
  if (uniq.length) L.push('    ' + uniq.slice(0, 40).join('、') + (uniq.length > 40 ? ' …' : ''));
}
L.push('');
L.push('## 被引用的 3D 类（按 jar 数排序，含方法名）');
const clsSorted = [...clsRefs.entries()].sort((a, b) => b[1].jars.size - a[1].jars.size);
for (const [cn, rec] of clsSorted) {
  L.push('- ' + cn + ' —— ' + rec.jars.size + ' 个 jar，方法 ' + rec.methods.size + ' 个');
  if (rec.methods.size) L.push('    ' + [...rec.methods].sort().join('  '));
}
L.push('');
L.push('## 每个命中 jar → 家族');
for (const [jar, fams] of [...jarFamilies.entries()].sort()) L.push('- ' + jar + ' → ' + [...fams].join(' / '));

fs.writeFileSync(OUT, L.join('\n'), 'utf8');
console.log('jar 总数 ' + jars.length + '，命中 3D API 的 jar ' + jarFamilies.size + ' 个');
for (const [fam, list] of famJars) console.log('  ' + fam + ': ' + new Set(list).size);
console.log('报告已写 ' + OUT);
