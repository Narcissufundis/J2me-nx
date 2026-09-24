/*
 * classdump.mjs — 从 jar 里反汇编 class，专治"这个游戏到底认哪些键值"
 *
 * 为什么需要：MIDP 只统一数字/方向/确认，软键与确认的键码各厂商不同；
 * 而具体某一款游戏到底按哪个数字判断软键/OK，只有看它自己的字节码最准。
 * 本工具把 jar 里的 class 拆出来，列出每个方法用到的整数常量
 * （bipush/sipush/ldc/lookupswitch…），于是"它比较过 -21 吗？比过 53 吗？"一目了然。
 *
 * 用法：
 *   node tools/classdump.mjs <jar> --list                    # 列出所有 class
 *   node tools/classdump.mjs <jar> --consts [子串]           # 各方法的整数常量（默认全部）
 *   node tools/classdump.mjs <jar> --dis <类名子串>[#方法名] # 反汇编指定类/方法
 *   node tools/classdump.mjs <jar> --keys                    # 只看"像按键判断"的方法
 *   node tools/classdump.mjs <jar> --natives [类名子串]      # 列出 native 方法（宿主可挂钩的点）
 *   node tools/classdump.mjs <jar> --grep <文本>             # 全 jar 扫常量池，找谁引用了某名字
 *   node tools/classdump.mjs <jar> --out <文件>              # 输出写 UTF-8 文件（PS 重定向会写坏）
 *
 * 实现说明：zip 用手工解析中央目录 + node:zlib.inflateRawSync（不依赖第三方包）；
 * class 解析到 Code 属性，按 JVM 指令长度表线性扫描。tableswitch/lookupswitch/
 * wide 按规范对齐处理。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// ---------- zip ----------
function readZipEntries(buf) {
  // 找 EOCD（0x06054b50）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('latin1', off + 46, off + 46 + nameLen);
    // local header：跳过它自己的 name/extra
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataOff, dataOff + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else data = null;   // 其它压缩法（极罕见）跳过
    if (data) out.set(name, data);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------- class ----------
function parseClass(buf) {
  let p = 0;
  if (buf.readUInt32BE(0) !== 0xCAFEBABE) throw new Error('不是 class 文件');
  p = 8;
  const cpCount = buf.readUInt16BE(p); p += 2;
  const cp = new Array(cpCount);
  for (let i = 1; i < cpCount; i++) {
    const tag = buf[p++];
    switch (tag) {
      case 1: { const len = buf.readUInt16BE(p); p += 2; cp[i] = { t: 'utf8', v: buf.toString('utf8', p, p + len) }; p += len; break; }
      case 3: cp[i] = { t: 'int', v: buf.readInt32BE(p) }; p += 4; break;
      case 4: cp[i] = { t: 'float' }; p += 4; break;
      case 5: cp[i] = { t: 'long' }; p += 8; i++; break;
      case 6: cp[i] = { t: 'double' }; p += 8; i++; break;
      case 7: cp[i] = { t: 'class', v: buf.readUInt16BE(p) }; p += 2; break;
      case 8: cp[i] = { t: 'string', v: buf.readUInt16BE(p) }; p += 2; break;
      case 9: case 10: case 11: cp[i] = { t: 'ref', a: buf.readUInt16BE(p), b: buf.readUInt16BE(p + 2) }; p += 4; break;
      case 12: cp[i] = { t: 'nat', a: buf.readUInt16BE(p), b: buf.readUInt16BE(p + 2) }; p += 4; break;
      default: cp[i] = { t: 'other' }; p += (tag === 15 ? 3 : 2); break;
    }
  }
  const cpUtf = (i) => (cp[i] && cp[i].t === 'utf8') ? cp[i].v : ('#' + i);
  const className = (i) => { const c = cp[i]; return c && c.t === 'class' ? cpUtf(c.v) : ('#' + i); };
  const refName = (i) => {
    const r = cp[i]; if (!r || r.t !== 'ref') return '#' + i;
    const nat = cp[r.b];
    return className(r.a) + '.' + (nat ? cpUtf(nat.a) : '?') + (nat ? cpUtf(nat.b) : '');
  };
  p += 2; // access flags
  p += 2; // this class
  p += 2; // super class
  const ifCount = buf.readUInt16BE(p); p += 2 + ifCount * 2;   // interfaces
  function skipMembers() {
    const n = buf.readUInt16BE(p); p += 2;
    const members = [];
    for (let i = 0; i < n; i++) {
      const flags = buf.readUInt16BE(p); p += 2;
      const nameI = buf.readUInt16BE(p); p += 2;
      const descI = buf.readUInt16BE(p); p += 2;
      const attrN = buf.readUInt16BE(p); p += 2;
      const attrs = [];
      for (let a = 0; a < attrN; a++) {
        const an = buf.readUInt16BE(p); p += 2;
        const al = buf.readUInt32BE(p); p += 4;
        attrs.push({ name: cpUtf(an), off: p, len: al });
        p += al;
      }
      members.push({ flags, name: cpUtf(nameI), desc: cpUtf(descI), attrs });
    }
    return members;
  }
  const fields = skipMembers();
  const methods = skipMembers();
  return { cp, cpUtf, className, refName, fields, methods, buf };
}

// ---------- JVM 指令长度表 ----------
const LEN = new Uint8Array(256).fill(1);
const setLen = (from, to, len) => { for (let i = from; i <= to; i++) LEN[i] = len; };
LEN[0x10] = 2; LEN[0x11] = 3; LEN[0x12] = 2; LEN[0x13] = 3; LEN[0x14] = 3;
setLen(0x15, 0x19, 2); LEN[0x36] = 2; setLen(0x37, 0x3a, 2);
LEN[0x84] = 3;
setLen(0x99, 0xa8, 3); LEN[0xa9] = 2;
setLen(0xb2, 0xb8, 3); LEN[0xb9] = 5; LEN[0xba] = 5;
LEN[0xbb] = 3; LEN[0xbc] = 2; LEN[0xbd] = 3;
LEN[0xc0] = 3; LEN[0xc1] = 3; LEN[0xc5] = 4; LEN[0xc6] = 3; LEN[0xc7] = 3;
LEN[0xc8] = 5; LEN[0xc9] = 5;
const OPNAME = {
  0x02: 'iconst_m1', 0x03: 'iconst_0', 0x04: 'iconst_1', 0x05: 'iconst_2',
  0x06: 'iconst_3', 0x07: 'iconst_4', 0x08: 'iconst_5',
  0x10: 'bipush', 0x11: 'sipush', 0x12: 'ldc', 0x13: 'ldc_w', 0x14: 'ldc2_w',
  0x15: 'iload', 0x1a: 'iload_0', 0x1b: 'iload_1', 0x1c: 'iload_2', 0x1d: 'iload_3',
  0x2a: 'aload_0', 0x2b: 'aload_1', 0x2c: 'aload_2', 0x2d: 'aload_3',
  0x36: 'istore', 0x3b: 'istore_0', 0x3c: 'istore_1', 0x3d: 'istore_2', 0x3e: 'istore_3',
  0x4b: 'astore_0', 0x4c: 'astore_1', 0x4d: 'astore_2', 0x4e: 'astore_3',
  0x57: 'pop', 0x58: 'pop2', 0x59: 'dup', 0x5f: 'swap',
  0x60: 'iadd', 0x64: 'isub', 0x68: 'imul', 0x6c: 'idiv', 0x70: 'irem',
  0x74: 'ineg', 0x78: 'ishl', 0x7a: 'ishr', 0x7c: 'iushr', 0x7e: 'iand',
  0x80: 'ior', 0x82: 'ixor', 0x84: 'iinc',
  0xa7: 'goto',
  0xb2: 'getstatic', 0xb3: 'putstatic', 0xb4: 'getfield', 0xb5: 'putfield',
  0xb6: 'invokevirtual', 0xb7: 'invokespecial', 0xb8: 'invokestatic',
  0xb9: 'invokeinterface', 0xbb: 'new', 0xbc: 'newarray', 0xbd: 'anewarray',
  0xbe: 'arraylength', 0xbf: 'athrow', 0xc0: 'checkcast', 0xc1: 'instanceof',
  0xc6: 'ifnull', 0xc7: 'ifnonnull', 0xaa: 'tableswitch', 0xab: 'lookupswitch', 0xc4: 'wide',
};
for (let i = 0x99; i <= 0xa6; i++) OPNAME[i] = 'if_icmp' + (i - 0x99);
OPNAME[0x99] = 'ifeq'; OPNAME[0x9a] = 'ifne'; OPNAME[0x9b] = 'iflt'; OPNAME[0x9c] = 'ifge';
OPNAME[0x9d] = 'ifgt'; OPNAME[0x9e] = 'ifle';
OPNAME[0x9f] = 'if_icmpeq'; OPNAME[0xa0] = 'if_icmpne'; OPNAME[0xa1] = 'if_icmplt';
OPNAME[0xa2] = 'if_icmpge'; OPNAME[0xa3] = 'if_icmpgt'; OPNAME[0xa4] = 'if_icmple';
OPNAME[0xa5] = 'if_acmpeq'; OPNAME[0xa6] = 'if_acmpne';
OPNAME[0xa8] = 'jsr'; OPNAME[0xa9] = 'ret';
OPNAME[0xac] = 'ireturn'; OPNAME[0xad] = 'lreturn'; OPNAME[0xae] = 'freturn';
OPNAME[0xaf] = 'dreturn'; OPNAME[0xb0] = 'areturn'; OPNAME[0xb1] = 'return';

// 走一遍 Code，同时收集"整数常量"与"反汇编文本"
function scanCode(code, ctx) {
  const consts = new Map();   // 值 → 出现次数
  const lines = [];
  const add = (v, at) => { consts.set(v, (consts.get(v) || 0) + 1); };
  let pc = 0;
  while (pc < code.length) {
    const op = code[pc];
    let len = LEN[op];
    let text = OPNAME[op] || ('op_' + op.toString(16));
    if (op === 0xaa) {   // tableswitch
      let q = pc + 1; while ((q & 3) !== 0) q++;
      const def = code.readInt32BE(q); const lo = code.readInt32BE(q + 4); const hi = code.readInt32BE(q + 8);
      len = (q + 12 + (hi - lo + 1) * 4) - pc;
      text = 'tableswitch ' + lo + '..' + hi + ' default=' + def;
      for (let v = lo; v <= hi; v++) add(v);
    } else if (op === 0xab) {   // lookupswitch
      let q = pc + 1; while ((q & 3) !== 0) q++;
      const def = code.readInt32BE(q); const npairs = code.readInt32BE(q + 4);
      len = (q + 8 + npairs * 8) - pc;
      const keys = [];
      for (let i = 0; i < npairs; i++) { const k = code.readInt32BE(q + 8 + i * 8); keys.push(k); add(k); }
      text = 'lookupswitch {' + keys.join(', ') + '} default=' + def;
    } else if (op === 0x10) { const v = code.readInt8(pc + 1); add(v); text = 'bipush ' + v; }
    else if (op === 0x11) { const v = code.readInt16BE(pc + 1); add(v); text = 'sipush ' + v; }
    else if (op === 0x12 || op === 0x13) {
      const idx = op === 0x12 ? code[pc + 1] : code.readUInt16BE(pc + 1);
      const c = ctx.cp[idx];
      if (c && c.t === 'int') add(c.v);
      text = 'ldc #' + idx + (c && c.t === 'int' ? ' (' + c.v + ')' : (c && c.t === 'string' ? ' "' + ctx.cpUtf(c.v) + '"' : ''));
    } else if (op === 0x84) { text = 'iinc ' + code[pc + 1] + ' ' + code.readInt8(pc + 2); }
    else if (op >= 0xb6 && op <= 0xb9) {
      const idx = code.readUInt16BE(pc + 1);
      text += ' ' + ctx.refName(idx);
    } else if (op >= 0xb2 && op <= 0xb5) {
      // 字段访问：解析成 Class.field（读反汇编时最关键的一类操作数）
      const idx = code.readUInt16BE(pc + 1);
      text += ' ' + ctx.refName(idx);
    } else if (op === 0xbb || op === 0xbd || op === 0xc0 || op === 0xc1 || op === 0xbc) {
      const idx = code.readUInt16BE(pc + 1);
      text += ' ' + (op === 0xbc ? ('atype ' + idx) : ctx.className(idx));
    } else if (op >= 0x99 && op <= 0xa7) {
      text += ' ' + (pc + code.readInt16BE(pc + 1));
    }
    lines.push(pc + ': ' + text);
    pc += len;
  }
  return { consts, lines };
}

// ---------- 主流程 ----------
// ⚠️ 输出统一走 emit：PowerShell 的 `>` 重定向会把 UTF-8 写坏（中文变乱码、
// 甚至 UTF-16），所以需要落文件时用 --out <file>，由 node 自己写 UTF-8。
const rawArgs = process.argv.slice(2);
const outIdx = rawArgs.indexOf('--out');
const outFile = outIdx >= 0 ? rawArgs[outIdx + 1] : null;
const argList = outIdx >= 0 ? rawArgs.filter((_, i) => i !== outIdx && i !== outIdx + 1) : rawArgs;
const outLines = [];
function emit(line) {
  if (outFile) outLines.push(String(line));
  else console.log(line);
}
function finish() {
  if (outFile) {
    writeFileSync(outFile, outLines.join('\n') + '\n', 'utf8');
  }
}
const args = argList;
const jarPath = args[0];
if (!jarPath) { console.error('用法: node tools/classdump.mjs <jar> [--list|--consts [子串]|--dis 类[#方法]|--keys] [--out 文件]'); process.exit(2); }
const mode = args[1] || '--list';
const target = args[2] || '';
const entries = readZipEntries(readFileSync(jarPath));
const classNames = [...entries.keys()].filter((n) => n.endsWith('.class'));

if (mode === '--list') {
  emit(classNames.length + ' 个 class：');
  classNames.forEach((n) => emit('  ' + n));
  finish();
  process.exit(0);
}

// nameFilter 省略时用 target（--consts 模式）；--dis 传"类名部分"（不含 #方法名），
// 否则会拿 'u.class#keyPressed' 去匹配类名，永远匹配不到（踩过）。
function eachMethod(cb, nameFilter) {
  const f = (nameFilter === undefined) ? target : nameFilter;
  for (const name of classNames) {
    if (f && name.indexOf(f) < 0) continue;
    let cls;
    try { cls = parseClass(entries.get(name)); } catch (e) { continue; }
    for (const m of cls.methods) {
      const codeAttr = m.attrs.find((a) => a.name === 'Code');
      if (!codeAttr) continue;
      const codeLen = cls.buf.readUInt32BE(codeAttr.off + 4);
      const code = cls.buf.subarray(codeAttr.off + 8, codeAttr.off + 8 + codeLen);
      cb({ cls, file: name, method: m, code });
    }
  }
}

if (mode === '--consts') {
  eachMethod(({ cls, file, method, code }) => {
    const { consts } = scanCode(code, cls);
    if (!consts.size) return;
    const vals = [...consts.keys()].sort((a, b) => a - b);
    const interesting = vals.filter((v) => v < 0 || (v >= 32 && v <= 90) || v >= 100);
    emit(file + '  ' + method.name + method.desc);
    emit('    常量(' + vals.length + '): ' + vals.join(' '));
    if (interesting.length !== vals.length) {
      emit('    其中可疑键值: ' + interesting.join(' '));
    }
  });
  finish();
  process.exit(0);
}

if (mode === '--keys') {
  // "像按键判断"的方法：有 int 参数、且常量里出现负数或 48..57 区间的数字
  eachMethod(({ cls, file, method, code }) => {
    if (method.desc.indexOf('(I') < 0 && method.desc.indexOf('(II') < 0) return;
    const { consts } = scanCode(code, cls);
    const vals = [...consts.keys()];
    const negs = vals.filter((v) => v < 0);
    const digits = vals.filter((v) => v >= 48 && v <= 57);
    const softish = vals.filter((v) => v <= -6 && v >= -30);
    if (!negs.length && digits.length < 2) return;
    emit('== ' + file + '  ' + method.name + method.desc);
    emit('   负数: ' + (negs.join(' ') || '(无)'));
    emit('   数字键 48-57: ' + (digits.join(' ') || '(无)'));
    emit('   软键候选(-6..-30): ' + (softish.join(' ') || '(无)'));
  });
  finish();
  process.exit(0);
}

if (mode === '--grep') {
  // 全 jar 扫常量池字符串：找"哪个类引用了某个方法名/字段名/字符串"
  const needle = target;
  if (!needle) { console.error('用法: --grep <文本>'); process.exit(2); }
  let hits = 0;
  for (const name of classNames) {
    let cls;
    try { cls = parseClass(entries.get(name)); } catch (e) { continue; }
    const found = [];
    for (let i = 1; i < cls.cp.length; i++) {
      const c = cls.cp[i];
      if (c && c.t === 'utf8' && c.v.indexOf(needle) >= 0) found.push(c.v);
    }
    if (found.length) {
      hits++;
      emit('== ' + name);
      found.slice(0, 12).forEach((s) => emit('     ' + s));
    }
  }
  emit('（共 ' + hits + ' 个 class 命中 "' + needle + '"）');
  finish();
  process.exit(0);
}

if (mode === '--natives') {
  // 列出所有 **native 方法**（ACC_NATIVE = 0x0100）：这些是 Java 会回调到宿主 JS 的点，
  // 想"自动检测游戏是否进入了文本输入"就得在这类地方挂钩子。
  let hits = 0;
  for (const name of classNames) {
    if (target && name.indexOf(target) < 0) continue;
    let cls;
    try { cls = parseClass(entries.get(name)); } catch (e) { continue; }
    const natives = [];
    for (const m of cls.fields.concat(cls.methods)) {
      if ((m.flags & 0x0100) && m.name && m.name !== '<init>' && m.name !== '<clinit>') {
        natives.push(m.name + m.desc);
      }
    }
    if (natives.length) {
      hits++;
      emit('== ' + name);
      natives.forEach((s) => emit('     ' + s));
    }
  }
  emit('（共 ' + hits + ' 个 class 含 native 方法）');
  finish();
  process.exit(0);
}

if (mode === '--dis') {
  const [clsFilter, methFilter] = target.split('#');
  eachMethod(({ cls, file, method, code }) => {
    if (methFilter && method.name.indexOf(methFilter) < 0) return;
    const { lines, consts } = scanCode(code, cls);
    emit('===== ' + file + '  ' + method.name + method.desc + ' =====');
    lines.forEach((l) => emit('  ' + l));
    emit('  -- 整数常量: ' + [...consts.keys()].sort((a, b) => a - b).join(' '));
  }, clsFilter);
  finish();
  process.exit(0);
}
console.error('未知模式 ' + mode);
process.exit(2);
