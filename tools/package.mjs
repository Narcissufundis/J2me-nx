#!/usr/bin/env node
/*
 * package.mjs — 组装 romfs/ 目录（nro/nsp 打包的输入）
 *
 * nx.js 的打包约定：romfs/main.js 是运行时入口；其余文件可用 romfs:/ 访问。
 * 本脚本把 bld/ 产物、宿主层与 vendor 需要的文件按 app/main.js 的 romfs
 * 布局复制进 romfs/。
 *
 * 产物链：
 *   npm run build   —— 预处理 + tsc + 拼接（tools/build.mjs）
 *   npm run romfs   —— 组装 romfs/（本脚本）
 *   npm run nro     —— romfs + nxjs-nro -> j2me-nx-port.nro
 *   npm run nsp     —— romfs + nxjs-nsp -> j2me-nx-port.nsp
 *
 * 换用自编译 JIT 运行时（runtime_jitfix）时：nro/nsp 产物里的 nxjs 运行时
 * 用 runtime_jitfix 的 nxjs.nso/nro 替换（对齐 mv2switch 的做法），或直接把
 * 本目录 romfs/ 交给 mv2switch_nr/tools/build.mjs --nsp 流水线。
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const romfs = join(root, 'romfs');

// 清理重建
rmSync(romfs, { recursive: true, force: true });
mkdirSync(romfs, { recursive: true });

function copy(relSrc, relDst) {
  const src = join(root, relSrc);
  if (!existsSync(src)) throw new Error(`缺少: ${relSrc}（先跑 npm run build）`);
  const dst = join(romfs, relDst);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  console.log(`  ${relSrc} -> romfs/${relDst}`);
}

console.log('[package] 复制宿主层与 VM 产物 ...');
copy('src/host/png-decoder.js', 'host/png-decoder.js');
copy('src/host/mask-scan.js', 'host/mask-scan.js');
copy('src/host/env-prelude.js', 'env-prelude.js');
copy('src/host/ui-lang.js', 'host/ui-lang.js');   // PATCH(perfZ21)：屏显文字中/英切换
copy('src/host/idb-shim.js', 'host/idb-shim.js');
copy('src/host/pipe-host.js', 'host/pipe-host.js');
copy('src/host/switch-audio.js', 'host/switch-audio.js');
copy('src/host/switch-input.js', 'host/switch-input.js');
copy('bld/native.js', 'j2me/native.js');
copy('bld/j2me.js', 'j2me/j2me.js');
copy('bld/main-all.js', 'j2me/main-all.js');
copy('bld/config-build.js', 'j2me/config-build.js');
copy('vendor/pluotsorbet/config/default.js', 'vendor/config/default.js');
copy('vendor/pluotsorbet/config/urlparams.js', 'vendor/config/urlparams.js');
copy('config/switch.js', 'config/switch.js');

console.log('[package] 内置类库与证书 ...');
copy('data/java/classes.jar', 'java/classes.jar');
// PATCH(perfZ24)：ADLMIDI wasm **可选**（默认 `[v8] wasm = off`，MIDI 走自带波表合成器；
// 发布快照里故意不带这个第三方 wasm，见 NOTICE.md）。缺了就跳过，别让整条构建链断在这。
{
  const wasmSrc = join(root, 'data', 'adlmidi', 'libadlmidi.full.core.wasm');
  if (existsSync(wasmSrc)) {
    copy('data/adlmidi/libadlmidi.full.core.wasm', 'j2me/adlmidi.full.core.wasm');
  } else {
    console.log('  [skip] 没有 data/adlmidi/libadlmidi.full.core.wasm（可选；MIDI 用内置波表合成器）');
  }
}
copy('data/certs/_main.ks', 'certs/_main.ks');

console.log('[package] CJK 字体（SimHei，实机 canvas 无内置汉字字形）...');copy('data/fonts/cjk.ttf', 'fonts/cjk.ttf');
// 内置遮罩（2026-09-23 perfZ6）：**只有 raw，没有 png**。
// mask.raw = 默认遮罩（复古诺基亚，1280x720 RGBA 裸数据）；masks/*.raw = 8 张可选项。
// 以前这里还拷一份 data/mask.png 作兜底，实机跑 PNG 解码是大分配/秒退的嫌疑源
// （PERF 记录 §17），而且那张 png 是 1920x1080 旧图、与 raw 不同步 —— 已删除。
console.log('[package] 竖屏遮罩图（1280x720 RGBA 裸数据，白区透明）...');copy('data/mask.raw', 'mask.raw');
// 可选遮罩 8 张（4横屏+4竖屏，1280x720 RGBA 裸文件，Y 菜单 → 选择遮罩）
{
  const masksSrc = join(root, 'data', 'masks');
  if (existsSync(masksSrc)) {
    mkdirSync(join(romfs, 'masks'), { recursive: true });
    let n = 0;
    for (const f of readdirSync(masksSrc)) {
      if (f.endsWith('.raw')) { cpSync(join(masksSrc, f), join(romfs, 'masks', f)); n++; }
    }
    console.log(`  data/masks -> romfs/masks（${n} 张）`);
  }
}

// nx.js 运行时配置：libuv 线程池 size=1（规避 beta.6 libuv-worker condvar 崩溃竞态）
copy('data/nxjs.ini', 'nxjs.ini');

console.log('[package] esbuild 打包入口 app/main.js -> romfs/main.js');
const esbuild = join(root, 'tools', 'node_modules', 'esbuild', 'bin', 'esbuild');
execFileSync(process.execPath, [
  esbuild,
  join(root, 'app', 'main.js'),
  '--bundle',
  '--platform=node',
  '--external:fs',
  '--format=cjs',
  '--target=es2022',
  '--outfile=' + join(romfs, 'main.js'),
], { stdio: 'inherit' });

// data/ 目录说明（游戏放 SD 卡 java/ 目录，不打进 romfs；仅放 README）
writeFileSync(join(romfs, 'DATA-README.txt'), [
  'j2me-nx-port 运行数据说明：',
  '  romfs 内置: java/classes.jar (phoneME 类库)、字体、遮罩、证书',
  '  游戏: 把 .jar 放进 SD 卡 sdmc:/switch/java/，启动菜单会列出全部游戏',
  '  存档: sdmc:/switch/j2me-nx/save/<jar文件名去后缀>/idb-fs.json（按游戏分开；jar 文件名请用英文，Switch FAT 读不了中文文件名）',
  '  日志: sdmc:/switch/j2me-nx/error.log',
].join('\n'));

console.log('[package] romfs/ 组装完成。下一步: npm run nro 或 npm run nsp');

// 防回归校验：romfs 必须包含 main.js 的 SCRIPTS 清单要求的每个文件。
// （png-decoder.js 曾漏拷，Node 仿真读仓库路径发现不了，实机一启动就崩）
{
  const mainSrc = readFileSync(join(root, 'app', 'main.js'), 'utf8');
  const listMatch = mainSrc.match(/var SCRIPTS = \[([\s\S]*?)\];/);
  if (listMatch) {
    const targets = [...listMatch[1].matchAll(/['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g)]
      .map(m => m[2]);
    const missing = targets.filter(t => !existsSync(join(romfs, t)));
    if (missing.length) {
      throw new Error('romfs 缺少 SCRIPTS 依赖文件: ' + missing.join(', ') +
        ' —— 请在 package.mjs 的 copy 清单里补上');
    }
    console.log(`[package] SCRIPTS 校验通过（${targets.length} 个文件齐全）`);
  }
}
