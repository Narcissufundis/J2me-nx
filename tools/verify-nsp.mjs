/*
 * verify-nsp.mjs — 检查 NSP 产物是不是"能启动"的那种形态（perfZ28）
 *
 * 由来：玩家试装 NSP「直接报错」。查下来是**打包模式**问题：
 *   `--fat` 会把**官方未打补丁的运行时**当作 exefs/main 塞进去，而我们的 nxjs.ini 是
 *   `jit = on`（需要打过 W^X 补丁的 runtime_jitfix）→ 正好是官方运行时在 Switch 上
 *   分配 JIT 代码页即 Data Abort 的老问题（见 data/nxjs.ini 的历史注释），启动就报错。
 *   正确的 NSP 是 **slim**：exefs/main 只是 165KB 的 forwarder（补丁版 nx-hbloader），
 *   它按 nyjs.ini 里注入的 `[runtime] version` 去 SD 上找共享运行时
 *   `sdmc:/nx.js/nxjs-v<版本>.nro`（放我们那份打过补丁的即可，JIT 照常可用）。
 *
 * 判定方式：NSP 里是 NCA，内容多为压缩存放，所以不猜内容 —— 直接比大小：
 *   program NCA ≈ 本仓库 romfs 目录大小 + 一点元数据  → slim（forwarder 165KB）
 *   program NCA ≈ romfs + 30MB（运行时 NSO）          → fat ⚠
 *
 * 用法：node tools/verify-nsp.mjs [dist/J2me-nx.nsp]
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const file = process.argv[2] || path.join(ROOT, 'dist', 'J2me-nx.nsp');
if (!existsSync(file)) {
  console.error('找不到 ' + file + '（先 npm run nsp）');
  process.exit(1);
}
const buf = readFileSync(file);
const rows = [];
let problems = 0;

rows.push(`文件        ${path.relative(ROOT, file).replace(/\\/g, '/')}`);
rows.push(`大小        ${buf.length} B (${(buf.length / 1048576).toFixed(2)} MB)`);
rows.push(`sha256      ${createHash('sha256').update(buf).digest('hex').toUpperCase()}`);
rows.push('');

// ---- PFS0 顶层（NSP = PFS0 包着几条 NCA）----
function readPfs0(b, base) {
  if (b.toString('latin1', base, base + 4) !== 'PFS0') throw new Error('不是 PFS0');
  const count = b.readUInt32LE(base + 4);
  const strTabSize = b.readUInt32LE(base + 8);
  const strBase = base + 0x10 + count * 0x18;
  const out = [];
  for (let i = 0; i < count; i++) {
    const off = base + 0x10 + i * 0x18;
    const dataOff = Number(b.readBigUInt64LE(off));
    const size = Number(b.readBigUInt64LE(off + 8));
    const nameOff = b.readUInt32LE(off + 16);
    let end = strBase + nameOff;
    while (b[end] !== 0) end++;
    out.push({ name: b.toString('utf8', strBase + nameOff, end), size, offset: strBase + strTabSize + dataOff });
  }
  return out;
}

const top = readPfs0(buf, 0);
rows.push('--- PFS0 顶层（NCA 清单）---');
for (const e of top) rows.push(`  ${e.name.padEnd(38)} ${e.size} B`);
const program = top.filter((e) => e.name.endsWith('.nca') && !e.name.endsWith('.cnmt.nca'))
  .sort((a, b) => b.size - a.size)[0];
if (!program) { rows.push('✗ 找不到 program NCA'); problems++; }

// ---- 与 romfs 目录比大小判断 fat/slim ----
function dirBytes(d) {
  let n = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) n += dirBytes(p); else if (e.isFile()) n += statSync(p).size;
  }
  return n;
}
const romfsDir = path.join(ROOT, 'romfs');
const romfsBytes = existsSync(romfsDir) ? dirBytes(romfsDir) : 0;
rows.push('');
rows.push(`本仓库 romfs 目录  ${romfsBytes} B (${(romfsBytes / 1048576).toFixed(2)} MB)`);

// perfZ35：先认"NRO→NSP 前端"（forwarder）—— 那种 NSP 只有几百 KB，
// program NCA 里是补丁版 hbloader + 硬编码的 NRO 路径，跟"我们自己的应用 NSP"完全不同形态，
// 不能用 romfs 大小去套（否则会算出负数差值、误报）。
const hasRomfs = top.some((e) => e.name === 'romfs');
if (program && program.size < 8 * 1024 * 1024 && !hasRomfs) {
  rows.push(`program NCA        ${program.size} B`);
  rows.push('');
  rows.push('形态        **NRO→NSP 前端（forwarder）**');
  rows.push('说明        这份 NSP 不带应用本体，只负责把 SD 上的某个 NRO 当标题启动');
  rows.push('            （因此请勿移动/改名被指向的那个 NRO，路径是硬编码的）');
  rows.push('验收        日志里 [heap] bootlim: 应为「正常档 821MB」；[boot] 形态= 应为 NRO-独立');
  rows.push(problems ? `结论：发现 ${problems} 处问题` : '结论：结构正常（NRO 前端）');
  console.log(rows.join('\n'));
  if (process.argv[3]) (await import('node:fs')).writeFileSync(process.argv[3], rows.join('\n') + '\n', 'utf8');
  process.exit(problems ? 1 : 0);
}

if (program) {
  const extra = program.size - romfsBytes;
  rows.push(`program NCA 多出   ${extra} B（forwarder≈165KB；30MB 级＝内嵌了完整运行时）`);
  rows.push('');
  if (extra < 2 * 1024 * 1024) {
    rows.push('形态        **slim**（exefs/main = forwarder）✔');
    rows.push('装好后 SD 上需要: sdmc:/nx.js/nxjs-v<[runtime] version>.nro（用打过补丁的运行时，JIT 才安全）');
    rows.push('            tip: npm run nsp 会把共享运行时一并放成 dist/nxjs-v<版本>.nro');
  } else if (extra > 20 * 1024 * 1024) {
    rows.push('形态        **fat**（内嵌完整运行时）⚠');
    rows.push('风险        内嵌的是官方未打补丁的运行时；nxjs.ini 里 jit = on 时，Switch 上启动即 Data Abort。');
    rows.push('            要用 fat 就把 nxjs.ini 的 jit 改成 off，或改用 slim（npm run nsp 已是 slim）。');
    problems++;
  } else {
    rows.push('形态        无法判定（program NCA 大小异常）');
    problems++;
  }
}

rows.push('');
rows.push(problems ? `结论：发现 ${problems} 处问题` : '结论：结构正常（slim NSP）');
const out = rows.join('\n');
console.log(out);
if (process.argv[3]) (await import('node:fs')).writeFileSync(process.argv[3], out + '\n', 'utf8');
if (problems) process.exit(1);
