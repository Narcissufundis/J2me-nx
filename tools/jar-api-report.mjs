#!/usr/bin/env node
/*
 * jar-api-report.mjs — "这个 jar 需要哪些可选 API、我们现在支持到什么程度"
 *
 * 用途：库里有几百个游戏时，想知道某个游戏为什么表现不对（黑屏/没声音/存不了档），
 * 先跑这个：它把 jar 里引用到的**可选 API** 列出来，并逐项标注我们的实现状态：
 *
 *   ✅ 已实现      该类声明的 native 我们注册了真实实现
 *   ⚠️ 仅打桩      注册成"只告警一次"的空实现（不崩、但也不干活）
 *   ❌ 静默失效    类在、native 声明了但没人管 → 调用等于什么都不做（最阴的一种）
 *   🚫 无此类      我们类库里连这个类都没有 → 游戏一碰就 NoClassDefFoundError
 *
 * 用法：
 *   node tools/jar-api-report.mjs <jar> [更多 jar...]
 *   node tools/jar-api-report.mjs --all <目录>      # 扫目录下所有 jar，汇总（慢）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const JDK = process.env.JDK_BIN || 'D:/j2me/jdk1.8.0_281/bin';

const PRIM = { void: 'V', int: 'I', long: 'J', boolean: 'Z', byte: 'B', short: 'S', char: 'C', float: 'F', double: 'D' };
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

// ---------- 我们类库的类 + 每个类的 native（声明/实现/打桩） ----------
const DIRS = ['cldc1.1.1', 'vm', 'midp', 'custom', 'jsr-256', 'jsr-179', 'jsr-082'];
const classNatives = new Map();   // 类全名(斜杠) -> [implKey]
{
  const byRel = new Map();
  for (const d of DIRS) {
    const base = path.join(ROOT, 'java', d);
    if (!fs.existsSync(base)) continue;
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p); else if (e.name.endsWith('.java')) byRel.set(path.relative(base, p), p);
      }
    })(base);
  }
  const paramNoName = (raw) => { let s = raw.trim(); const m = s.match(/^(.*?)\s*([A-Za-z_]\w*)\s*((?:\[\s*\])*)$/); if (m) s = m[1] + m[3]; return s.replace(/\s+/g, ''); };
  const toDesc = (t) => { let d = 0; while (/\[\s*\]$/.test(t)) { d++; t = t.slice(0, t.lastIndexOf('[')); } return '['.repeat(d) + (PRIM[t] ? PRIM[t] : 'L' + t.replace(/\./g, '/') + ';'); };
  for (const [, file] of byRel) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const pkg = (src.match(/\bpackage\s+([\w.]+)\s*;/m) || [])[1];
    if (!pkg) continue;
    const simple = Object.create(null);
    for (const m of src.matchAll(/\bimport\s+([\w.]+)\s*;/g)) { const fq = m[1]; simple[fq.slice(fq.lastIndexOf('.') + 1)] = fq; }
    const fix = (t) => PRIM[t] || t.includes('.') || t.includes('[') ? t
      : (t === 'String' ? 'java.lang.String' : t === 'Object' ? 'java.lang.Object' : (simple[t] || pkg + '.' + t));
    const evts = [];
    for (const m of src.matchAll(/\b(?:class|interface)\s+(\w+)/g)) evts.push({ i: m.index, k: 'c', n: m[1] });
    for (const m of src.matchAll(/\bnative\s+([\w.$]+(?:\s*\[\s*\])*)\s+(\w+)\s*\(([^)]*)\)\s*;/g)) evts.push({ i: m.index, k: 'n', ret: m[1], name: m[2], params: m[3] });
    evts.sort((a, b) => a.i - b.i);
    let cls = null;
    for (const e of evts) {
      if (e.k === 'c') { cls = e.n; continue; }
      if (!cls) continue;
      const full = pkg.replace(/\./g, '/') + '/' + cls;
      const params = e.params.trim() === '' ? [] : e.params.split(',').map(paramNoName).map(fix);
      const key = full + '.' + e.name + '.(' + params.map(toDesc).join('') + ')' + toDesc(fix(e.ret.replace(/\s+/g, '')));
      if (!classNatives.has(full)) classNatives.set(full, []);
      classNatives.get(full).push(key);
    }
  }
}
const regs = new Set(), stubs = new Set();
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git/.test(e.name)) walk(p); continue; }
    if (!/\.(js|ts)$/.test(e.name)) continue;
    const s = fs.readFileSync(p, 'utf8');
    for (const m of s.matchAll(/Native\[\s*"([^"]+)"\s*\]/g)) regs.add(m[1]);
    for (const m of s.matchAll(/addUnimplementedNative\(\s*"([^"]+)"/g)) stubs.add(m[1]);
  }
})(path.join(ROOT, 'vendor', 'pluotsorbet'));
(function walk(d) {   // src/ 与 app/ 也有注册
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.js$/.test(e.name)) continue;
    const s = fs.readFileSync(p, 'utf8');
    for (const m of s.matchAll(/Native\[\s*"([^"]+)"\s*\]/g)) regs.add(m[1]);
    for (const m of s.matchAll(/addUnimplementedNative\(\s*"([^"]+)"/g)) stubs.add(m[1]);
  }
})(path.join(ROOT, 'src'));
const ourClasses = new Set(execSync(`"${JDK}/jar.exe" tf "${path.join(ROOT, 'java/classes.jar')}"`)
  .toString().split(/\r?\n/).filter((l) => l.endsWith('.class')).map((l) => l.replace(/\.class$/, '')));

// ---------- jar 里引用了哪些类 ----------
function classRefs(buf) {
  const refs = new Set();
  if (buf.length < 10 || buf.readUInt32BE(0) !== 0xCAFEBABE) return refs;
  const count = buf.readUInt16BE(8);
  const utf8 = new Array(count), clsIdx = [];
  let p = 10;
  for (let i = 1; i < count; i++) {
    const tag = buf[p];
    switch (tag) {
      case 1: { const len = buf.readUInt16BE(p + 1); utf8[i] = buf.toString('utf8', p + 3, p + 3 + len); p += 3 + len; break; }
      case 7: clsIdx.push(buf.readUInt16BE(p + 1)); p += 3; break;
      case 8: case 16: p += 3; break;
      case 15: p += 4; break;
      case 3: case 4: case 9: case 10: case 11: case 12: case 18: p += 5; break;
      case 5: case 6: p += 9; i++; break;
      default: return refs;
    }
  }
  for (const i of clsIdx) if (utf8[i]) refs.add(utf8[i].replace(/^\[+/, '').replace(/^L/, '').replace(/;$/, ''));
  return refs;
}

const AREAS = [
  ['3D 引擎', ['javax/microedition/m3g', 'com/mascotcapsule/micro3d', 'com/nokia/mid/m3d', 'ru/woesss/j2me/micro3d']],
  ['Nokia UI', ['com/nokia/mid/ui']],
  ['Nokia 声音', ['com/nokia/mid/sound']],
  ['媒体/音乐', ['javax/microedition/media', 'com/sun/mmedia']],
  ['文件(JSR-75)', ['javax/microedition/io/file', 'com/sun/cdc/io/j2me/file']],
  ['PIM', ['javax/microedition/pim', 'com/sun/j2me/pim']],
  ['定位', ['javax/microedition/location', 'com/sun/j2me/location']],
  ['传感器', ['javax/microedition/sensor', 'com/sun/javame/sensor']],
  ['蓝牙', ['javax/bluetooth', 'com/sun/jsr082/bluetooth']],
  ['短信/推送', ['javax/wireless/messaging', 'com/sun/midp/io/j2me/sms', 'com/sun/midp/io/j2me/push']],
  ['网络', ['javax/microedition/io', 'com/sun/midp/io/j2me/http', 'com/sun/midp/io/j2me/socket', 'com/sun/cldc/io/j2me/socket']],
  ['游戏类库', ['javax/microedition/lcdui/game']],
  ['UI 控件', ['javax/microedition/lcdui']],
  ['厂商 API', ['com/siemens/mp', 'com/vodafone/v10', 'com/samsung/util', 'com/sprintpcs', 'com/motorola']],
];
function areaOf(cls) { for (const [name, pres] of AREAS) if (pres.some((p) => cls.startsWith(p + '/'))) return name; return null; }

function statusOne(cls) {
  if (!ourClasses.has(cls)) return { s: '🚫', t: '无此类（会 NoClassDefFoundError）' };
  const natives = classNatives.get(cls) || [];
  if (!natives.length) return { s: '✅', t: '纯 Java 实现，无 native' };
  const impl = natives.filter((k) => regs.has(k)).length;
  const stub = natives.filter((k) => stubs.has(k)).length;
  const miss = natives.length - impl - stub;
  if (miss === 0 && stub === 0) return { s: '✅', t: '已实现（' + impl + ' 个 native）' };
  if (miss === 0) return { s: '⚠️', t: '仅打桩（' + stub + '/' + natives.length + ' 个是空实现）' };
  if (impl === 0 && stub === 0) return { s: '❌', t: '静默失效（' + miss + ' 个 native 没人管）' };
  return { s: '⚠️', t: '部分：实现 ' + impl + ' / 桩 ' + stub + ' / 缺口 ' + miss };
}

/*
 * ⚠️ 接口/抽象类本身没有 native，真正干活的是 `<名字>Imp` / `<名字>Impl`
 * （例如游戏只引用 com/nokia/mid/ui/DirectGraphics，实际实现是 DirectGraphicsImp）。
 * 只看被引用的那个类会漏报 —— 所以把这两个实现类一起看，取最差的状态。
 */
const WORSE = { '🚫': 4, '❌': 3, '⚠️': 2, '✅': 1 };
function statusOf(cls) {
  const cands = [cls, cls + 'Imp', cls + 'Impl'];
  let worst = null;
  const parts = [];
  for (const c of cands) {
    if (c !== cls && !ourClasses.has(c)) continue;      // 实现类不存在是正常的
    const st = statusOne(c);
    parts.push(c.split('/').pop() + ' ' + st.s + ' ' + st.t);
    if (!worst || WORSE[st.s] > WORSE[worst.s]) worst = st;
  }
  return parts.length > 1
    ? { s: worst.s, t: parts.join('  |  ') }
    : (worst || { s: '✅', t: '—' });
}

const jars = [];
const allIdx = process.argv.indexOf('--all');
if (allIdx >= 0) {
  const dir = process.argv[allIdx + 1];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.jar$/i.test(e.name)) jars.push(p); } })(dir);
} else {
  for (const a of process.argv.slice(2)) if (!a.startsWith('--') && fs.existsSync(a)) jars.push(a);
}
if (!jars.length) { console.error('用法: node tools/jar-api-report.mjs <jar> [...]  |  --all <目录>'); process.exit(2); }

const tmp = path.join(ROOT, '.tmp-jarreport');
for (const jar of jars) {
  console.log('\n================ ' + path.basename(jar) + ' ================');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  let classes = [];
  try {
    classes = execSync(`"${JDK}/jar.exe" tf "${jar}"`).toString().split(/\r?\n/).filter((l) => l.endsWith('.class'));
    execSync(`"${JDK}/jar.exe" xf "${jar}"`, { cwd: tmp });
  } catch (e) { console.log('  !! 解析失败（不是 zip/jar？）'); continue; }

  const refs = new Set();
  for (const rel of classes) {
    const f = path.join(tmp, rel);
    if (fs.existsSync(f)) for (const r of classRefs(fs.readFileSync(f))) refs.add(r);
  }

  const byArea = new Map();
  for (const r of refs) {
    const a = areaOf(r);
    if (!a) continue;
    if (!byArea.has(a)) byArea.set(a, new Set());
    byArea.get(a).add(r);
  }
  for (const [area, pres] of AREAS) {
    if (!byArea.has(area)) continue;
    const items = [...byArea.get(area)].sort();
    console.log('\n  【' + area + '】' + items.length + ' 个类');
    for (const c of items) {
      const st = statusOf(c);
      console.log('    ' + st.s + ' ' + c + '   ' + st.t);
    }
  }
  if (!byArea.size) console.log('  只用了标准 MIDP/CLDC（无专有 API）');
}
fs.rmSync(tmp, { recursive: true, force: true });
