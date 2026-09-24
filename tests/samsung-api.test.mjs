#!/usr/bin/env node
/*
 * samsung-api.test.mjs — 三星 SDK 兼容层（com.samsung.util.AudioClip / Vibration）类契约守卫
 *
 * 为什么要有这个测试：
 *   2026-09-23 用户报 "Forgotten Warrior.jar 打不开"，实机日志是
 *     listener error: ClassNotFoundException: com/samsung/util/AudioClip.class
 *   ——游戏在 **类加载阶段** 就死了，画面都没出来。
 *   这类"缺类/缺方法"故障的判据是 class 文件的**名字与签名**，与运行环境无关：
 *   签名对得上游戏就一定链接得上，错一个字符就是 NoSuchMethodError。
 *   所以这里直接解析 data/java/classes.jar 里的 class 字节做断言（不跑 VM、不依赖
 *   javap —— javap 输出会按控制台代码页转码，靠不住）。
 *
 * 另外做一次**反向校验**：把游戏 class 里对 com.samsung/util/* 的 Methodref 全抓出来，
 * 逐条确认我们都有 —— 这才是"游戏能打开"的真正契约。
 * （找不到游戏 jar 时该项 SKIP，不影响其它断言。）
 *
 * 用法：node tests/samsung-api.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLASSES_JAR = path.join(ROOT, 'data', 'java', 'classes.jar');

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, extra = '') => {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
};
const skipCheck = (name, why) => { skip++; console.log('SKIP ' + name + '  ' + why); };

/* ------------------------------------------------------------------ *
 * 最小 zip 读取（中央目录 + inflateRaw），沿用 tools/classdump.mjs 的做法
 * ------------------------------------------------------------------ */
function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip/jar（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * 最小 class 解析：常量池 + 字段/方法表（只要名字、描述符、访问标志、属性名）
 * ------------------------------------------------------------------ */
function parseClass(data) {
  let p = 0;
  const u1 = () => data[p++];
  const u2 = () => { const v = data.readUInt16BE(p); p += 2; return v; };
  const u4 = () => { const v = data.readUInt32BE(p); p += 4; return v; };
  if (u4() !== 0xcafebabe) throw new Error('bad magic');
  u2(); u2();                                   // minor / major
  const cpCount = u2();
  const cp = new Array(cpCount);
  for (let i = 1; i < cpCount; i++) {
    const tag = u1();
    switch (tag) {
      case 1: { const len = u2(); cp[i] = { tag, s: data.toString('utf8', p, p + len) }; p += len; break; }
      case 3: case 4: cp[i] = { tag }; u4(); break;
      case 5: case 6: cp[i] = { tag }; u4(); u4(); i++; break;
      case 7: case 8: case 16: cp[i] = { tag, idx: u2() }; break;
      case 9: case 10: case 11: case 12: case 18: cp[i] = { tag, a: u2(), b: u2() }; break;
      case 15: cp[i] = { tag }; u1(); u2(); break;
      default: throw new Error('未知常量池 tag ' + tag + ' @' + i);
    }
  }
  const utf8 = (i) => (cp[i] && cp[i].s) || '';
  const className = (i) => utf8(cp[i].idx);
  const readMembers = () => {
    const n = u2();
    const out = [];
    for (let i = 0; i < n; i++) {
      const access = u2();
      const name = utf8(u2());
      const desc = utf8(u2());
      const attrCount = u2();
      const attrNames = [];
      for (let a = 0; a < attrCount; a++) {
        const an = utf8(u2());
        const len = u4();
        attrNames.push(an);
        p += len;
      }
      out.push({ access, name, desc, attrNames });
    }
    return out;
  };
  const access = u2();
  const thisName = className(u2());
  const superName = className(u2());
  const ifCount = u2();
  for (let i = 0; i < ifCount; i++) u2();
  return { access, thisName, superName, fields: readMembers(), methods: readMembers() };
}

/** 精确抓出某 class 里对 com/samsung/util/* 的 Methodref（返回 "类|方法|描述符"）。 */
function refsToSamsung(data) {
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
    else if (tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 18) {
      cp[i] = { tag, a: data.readUInt16BE(p), b: data.readUInt16BE(p + 2) }; p += 4;
    } else if (tag === 15) { p += 3; cp[i] = { tag }; }
    else return out;
  }
  const utf8 = (i) => (cp[i] && cp[i].s) || '';
  for (let i = 1; i < cpCount; i++) {
    const e = cp[i];
    if (!e || (e.tag !== 10 && e.tag !== 11)) continue;
    const cls = cp[e.a], nt = cp[e.b];
    if (!cls || !nt || cls.tag !== 7) continue;
    const cn = utf8(cls.idx);
    if (cn.indexOf('com/samsung/util/') !== 0) continue;
    out.add(cn + '|' + utf8(nt.a) + '|' + utf8(nt.b));
  }
  return out;
}

/* ------------------------------------------------------------------ */
console.log('=== samsung-api: 三星兼容层类契约 ===');
if (!fs.existsSync(CLASSES_JAR)) {
  console.error('FAIL 找不到 ' + CLASSES_JAR + '，先跑 node tools/build-classes.mjs');
  process.exit(1);
}
const jar = readZipEntries(fs.readFileSync(CLASSES_JAR));

const NEED = {
  'com/samsung/util/AudioClip': {
    methods: [
      ['<init>', '(ILjava/lang/String;)V'],   // 游戏：new AudioClip(3, "/7.mid")
      ['<init>', '(I[BII)V'],                 // 三星另一种重载（内存数据）
      ['play', '(II)V'],                      // 游戏：play(1, 3)
      ['stop', '()V'],                        // 游戏：stop()
      ['pause', '()V'], ['resume', '()V'],
      ['isPlaying', '()Z'],
      ['getVolume', '()I'], ['setVolume', '(I)V'],
      ['release', '()V'],
    ],
    fields: [['TYPE_MMF', 'I'], ['TYPE_WAV', 'I'], ['TYPE_MP3', 'I'], ['TYPE_MIDI', 'I']],
  },
  'com/samsung/util/Vibration': {
    methods: [
      ['isSupported', '()Z'],
      ['start', '(II)V'],                     // 游戏：call_vib → Vibration.start(d, 3)
      ['stop', '()V'],
    ],
    fields: [],
  },
};

const parsed = new Map();
for (const [clsName, spec] of Object.entries(NEED)) {
  const entry = clsName + '.class';
  const buf = jar.get(entry);
  check('classes.jar 含 ' + entry, !!buf);
  if (!buf) continue;
  const cls = parseClass(buf);
  parsed.set(clsName, cls);
  check(entry + ' 是 public 类', (cls.access & 0x0001) !== 0, 'access=0x' + cls.access.toString(16));
  check(entry + ' 父类是 java/lang/Object', cls.superName === 'java/lang/Object', cls.superName);

  for (const [m, d] of spec.methods) {
    const hit = cls.methods.find((x) => x.name === m && x.desc === d);
    check(entry + ' 方法 ' + m + d, !!hit);
    if (!hit) continue;
    check(entry + ' ' + m + d + ' 不是 native（纯 Java，无需 VM 注册）', (hit.access & 0x0100) === 0);
    // 三星 SDK 的调用点（游戏字节码）没有 try/catch，签名保持不声明受检异常
    check(entry + ' ' + m + d + ' 未声明受检异常', !hit.attrNames.includes('Exceptions'));
  }
  for (const [f, d] of spec.fields) {
    const hit = cls.fields.find((x) => x.name === f && x.desc === d);
    check(entry + ' 常量 ' + f + ':' + d, !!hit);
    if (hit) {
      check(entry + ' 常量 ' + f + ' 是 public static final',
        (hit.access & 0x0001) !== 0 && (hit.access & 0x0008) !== 0 && (hit.access & 0x0010) !== 0,
        'access=0x' + hit.access.toString(16));
    }
  }
}

/* ---- 源码侧守卫：补丁标记 + 不许悄悄退回"空实现" ---- */
for (const f of ['AudioClip.java', 'Vibration.java']) {
  const src = fs.readFileSync(path.join(ROOT, 'java', 'custom', 'com', 'samsung', 'util', f), 'utf8');
  check(f + ' 带 PATCH(j2me-nx-port) 标记', /PATCH\(j2me-nx-port\)/.test(src));
}
{
  const clip = fs.readFileSync(path.join(ROOT, 'java', 'custom', 'com', 'samsung', 'util', 'AudioClip.java'), 'utf8');
  check('AudioClip 真接 Manager.createPlayer（不是打桩）', /Manager\.createPlayer\s*\(/.test(clip));
  check('AudioClip 按扩展名判 content type（.mid → audio/midi）',
    /endsWith\("\.mid"\)[^\n]*return "audio\/midi"/.test(clip));
  check('AudioClip 所有失败路径都吞异常（游戏不许被音频带崩）',
    (clip.match(/catch \(Throwable/g) || []).length >= 6,
    'catch(Throwable) ×' + (clip.match(/catch \(Throwable/g) || []).length);
  const vib = fs.readFileSync(path.join(ROOT, 'java', 'custom', 'com', 'samsung', 'util', 'Vibration.java'), 'utf8');
  check('Vibration.start 是空实现（Switch 无马达）', /static void start\(int duration, int strength\)/.test(vib));
}

/* ---- 反向契约：游戏实际引用的每个 com.samsung.util 方法我们都有 ---- */
const GAME_CANDIDATES = [
  process.env.J2ME_FW_JAR,
  'D:\\新建文件夹\\游戏相关\\修改版游戏\\J2ME整理\\能玩\\Forgotten Warrior.jar',
].filter(Boolean);
const gameJar = GAME_CANDIDATES.find((p) => fs.existsSync(p));
if (!gameJar) {
  skipCheck('游戏反向契约（Forgotten Warrior.jar 的 Methodref 全覆盖）', '本机找不到游戏 jar');
} else {
  const g = readZipEntries(fs.readFileSync(gameJar));
  const want = new Set();
  for (const [name, data] of g) {
    if (!name.endsWith('.class')) continue;
    for (const ref of refsToSamsung(data)) want.add(ref);
  }
  check('从游戏 jar 抓到 com/samsung/util 引用', want.size > 0,
    want.size ? [...want].join(' , ') : '(一个都没抓到 → 游戏不碰三星 API？)');
  for (const ref of want) {
    const [clsName, mName, mDesc] = ref.split('|');
    const cls = parsed.get(clsName) || (jar.get(clsName + '.class') && parseClass(jar.get(clsName + '.class')));
    if (!cls) { check('游戏引用 ' + clsName + ' → 我们有这个类', false); continue; }
    check('游戏引用 ' + clsName.replace('com/samsung/util/', '') + '.' + mName + mDesc + ' → 已实现',
      !!cls.methods.find((x) => x.name === mName && x.desc === mDesc));
  }
}

console.log('');
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败' + (skip ? ' / ' + skip + ' 跳过' : ''));
process.exit(fail ? 1 : 0);
