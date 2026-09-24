/*
 * pack-forwarder.mjs — 把 NTON 生成的「NRO→NSP 前端」收进 dist/forwarder/（perfZ35）
 *
 * 由来：用户要主页上有个入口，点了就启动 SD 上的 sdmc:/switch/J2me-nx.nro。用 NTON 生成
 * 一个 322KB 的前端 NSP 即可（不含模拟器本体，更新模拟器只要覆盖那个 NRO）。
 *
 * NTON 把产物写在它自己的输出目录（默认桌面上的 NTON/，文件名带 Title ID），
 * 本脚本负责：找最新的那个 .nsp → 复制成 dist/forwarder/J2me-nx-forwarder.nsp
 * → 把 release/FORWARDER.md 同步成 dist/forwarder/README.md（跟包一起发）
 * → 跑 tools/verify-nsp.mjs 自检（前端形态判定）。
 *
 * 用法：
 *   node tools/pack-forwarder.mjs                      # 自动找 %USERPROFILE%/Desktop/NTON
 *   node tools/pack-forwarder.mjs "D:/某个目录/x.nsp"  # 指定文件或目录
 */
import { readdirSync, statSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist', 'forwarder');
const OUT_NSP = path.join(OUT_DIR, 'J2me-nx-forwarder.nsp');

/** NTON 默认输出目录（Windows 桌面 / 家目录下的 NTON）。 */
function defaultDirs() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return [
    path.join(home, 'Desktop', 'NTON'),
    path.join(home, 'NTON'),
    path.join(ROOT, 'NTON'),
  ].filter(Boolean);
}

function newestNsp(dir) {
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.nsp'))
    .map((n) => path.join(dir, n))
    .map((p) => ({ p, t: statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return hits.length ? hits[0].p : null;
}

const arg = process.argv[2];
let src = null;
if (arg) {
  const abs = path.resolve(arg);
  if (!existsSync(abs)) { console.error('找不到 ' + abs); process.exit(1); }
  src = statSync(abs).isDirectory() ? newestNsp(abs) : abs;
  if (!src) { console.error('目录里没有 .nsp：' + abs); process.exit(1); }
} else {
  for (const d of defaultDirs()) { src = newestNsp(d); if (src) break; }
  if (!src) {
    console.error('没找到 NTON 产物。先跑：');
    console.error('  python -m pip install nton');
    console.error('  python -m nton build "dist/J2me-nx.nro" --sdmc "/switch/J2me-nx.nro" ' +
      '-n "J2me-nx" -p "Narcissufundis" -v "1.0.0" -i "tools/icon-source.png"');
    console.error('或直接把它生成的 .nsp 路径作为参数传进来。');
    process.exit(1);
  }
}

const size = statSync(src).size;
if (size > 8 * 1024 * 1024) {
  console.error(`⚠ ${path.basename(src)} 有 ${(size / 1048576).toFixed(1)}MB —— 前端不该这么大；`);
  console.error('  这份看起来不是"前端"（NTON 的 --sdmc 前端约 322KB）。确认后再人工复制。');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(src, OUT_NSP);
const doc = path.join(ROOT, 'release', 'FORWARDER.md');
if (existsSync(doc)) copyFileSync(doc, path.join(OUT_DIR, 'README.md'));

console.log(`来源      ${src}`);
console.log(`产物      ${path.relative(ROOT, OUT_NSP).replace(/\\/g, '/')}  ${size} B`);
console.log(`说明      ${existsSync(doc) ? 'dist/forwarder/README.md（= release/FORWARDER.md）' : '（缺 release/FORWARDER.md）'}`);
console.log('');
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'verify-nsp.mjs'), OUT_NSP], { stdio: 'inherit' });
