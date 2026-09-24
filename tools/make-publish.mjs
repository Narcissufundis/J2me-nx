#!/usr/bin/env node
/*
 * make-publish.mjs — 组装"可公开的源码快照"（perfZ24）
 *
 * 为什么需要它：工作树里混了大量**不该公开**的东西 —— 商业游戏 jar（测试夹具、
 * tmp-games/）、几 MB 的临时日志、历史备份、romfs/dist 等构建产物，以及若干
 * **第三方二进制**（SimHei 字体、ADLMIDI wasm、打补丁的 nx.js 运行时）。靠手抄一遍
 * 迟早漏东西，所以这里把"哪些进、哪些不进"写成**可重复执行的规则 + 打印清单**。
 *
 * 用法：node tools/make-publish.mjs [目标目录]     默认 F:/Deepseek/j2me-nx-publish
 *      （目标目录里已有的内容会被清空重建）
 *
 * 进包原则：**能重建的东西进包；别人的东西、纯内容资产、构建产物不进包**
 *   * 进：我们的源码（app/src/config/java 源码/vendor 补丁）、构建与测试脚本、
 *         文档模板、CI 无关的最小 npm 依赖声明（package.json）
 *   * 不进：node_modules（npm install 自己拉）、bld/romfs/dist（构建产物）、
 *           data/java/classes.jar（由 java/ 源码现编）、商业游戏 jar、
 *           字体与 ADLMIDI wasm（NOTICE.md 说明怎么自备）、日志/备份/研究目录
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DST = path.resolve(process.argv[2] || 'F:/Deepseek/j2me-nx-publish');

// ---- 目录白名单（递归拷贝，再按后缀/名字剔除）----
const DIRS = ['app', 'src', 'config', 'vendor', 'java', 'tools', 'tests', 'data'];
// ---- 目录黑名单（任何层级出现即跳过）----
const SKIP_DIRS = new Set([
  'node_modules', 'build', 'build-src', '.verify-jar', 'tmp',
  'tmp-softrestart', 'tmp-softrestart-run', 'tmp-menutest', 'tmp-uilang', 'tmp-uilang-lang',
  'tmp-ratchet', 'tmp-i18ntest', 'tmp-i18nlang', 'save', 'prof', '_adlmidi',
  // 28MB 可选遮罩素材：属于"内容资产"不是源码，想发就自己决定加不加（见 NOTICE.md）
  'masks',
]);
// ---- 文件黑名单（后缀 / 精确名 / 前缀）----
// ⚠ `.jar` **不能**一刀切排除：tools/ 下的测试夹具（fixture/skiptest/enctest/samsungtest/
// textok/dgtest/I18nTest）都是我们自制的 MIDlet，正是 `npm test` 需要的东西，要进包；
// 要排除的是**商业游戏 jar**（按名字列出来，见 SKIP_NAMES）。
const SKIP_EXT = new Set(['.log', '.nro', '.nsp', '.tmp', '.hidden', '.jad', '.bak']);
const SKIP_NAMES = new Set([
  'classes.jar',        // 由 java/ 源码经 tools/build-classes.mjs 现编
  'big.bin',            // tools/skip-test 生成物（512KiB 模式流）
  'error.log', 'names.txt', 'keys.txt', 'keyprofiles.json', 'lang.json', 'mask.json',
  'resolutions.json', 'idb-fs.json',
  'nxjs-debug.log',     // 运行期状态
  'cjk.ttf',            // 第三方字体（SimHei）→ 见 NOTICE.md，请自备
  'libadlmidi.full.core.wasm', // 第三方 wasm（默认 wasm=off，用不到）
  // ⛔ 商业游戏 jar：测试夹具已换成自制的 tools/fixture/fixture.jar；data/midlet.jar 是
  //    仿真期把游戏拷进 data/ 的中间产物。都不许进公开仓库。
  'A_176x220.jar', 'midlet.jar', 'midlet.jad',
]);
const SKIP_PREFIX = ['jartmp', 'ferrari_', 'work-pluotsorbet', '._'];
// 例外：prebuilt-classes 下的 .class 必须进包（**没有源码**，是 phoneME 的 GBK_Reader 等，
// 构建 classes.jar 时要注入；见 NOTICE.md 的合规说明）
const KEEP_CLASS_DIR = /(^|[\\/])prebuilt-classes([\\/]|$)/;

let copied = 0, skipped = 0, bytes = 0;
const skipReport = [];

function walk(srcDir, rel) {
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const relPath = rel ? rel + '/' + e.name : e.name;
    const src = path.join(srcDir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) { skipReport.push('目录 ' + relPath); continue; }
      walk(src, relPath);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    let skip = null;
    if (SKIP_EXT.has(ext)) skip = '后缀 ' + ext;
    else if (SKIP_NAMES.has(e.name)) skip = '按名排除';
    else if (SKIP_PREFIX.some((p) => e.name.startsWith(p))) skip = '前缀排除';
    else if (ext === '.class' && !KEEP_CLASS_DIR.test(rel)) skip = '.class（编译产物）';
    else if (/^\.(perf|z\d|wb-|gap|sr|ratchet|session|window|timeline|memgroups)/.test(e.name)) skip = '临时脚本';
    if (skip) { skipped++; skipReport.push(relPath + '（' + skip + '）'); continue; }
    const dst = path.join(DST, relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied++;
    bytes += fs.statSync(dst).size;
  }
}

console.log('[publish] 目标目录: ' + DST);
fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });

for (const d of DIRS) {
  const src = path.join(ROOT, d);
  if (!fs.existsSync(src)) { console.log('  ! 缺少目录 ' + d); continue; }
  walk(src, d);
}
// 仓库根的"源码级"文件
for (const f of ['package.json', 'README.md', 'PERF-修复记录-perfA-perfB.md']) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(DST, f)); copied++; }
}
// 文档模板（放在 release/ 里统一维护 —— 这里只做覆盖式复制）
const TEMPLATES = ['README.md', 'BUILD.md', 'NOTICE.md', 'LICENSE.md', '.gitignore', 'assets-README.md'];
let tmpl = 0;
for (const t of TEMPLATES) {
  const src = path.join(ROOT, 'release', t);
  if (!fs.existsSync(src)) { console.log('  ! 缺少文档模板 release/' + t); continue; }
  const dstName = t === 'assets-README.md' ? 'data/fonts/README.md' : t;
  const dst = path.join(DST, dstName);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  tmpl++;
}

fs.writeFileSync(path.join(DST, '_publish-excluded.txt'),
  '# 组装快照时**未**进包的东西（由 tools/make-publish.mjs 打印，供复核）\n' +
  skipReport.sort().join('\n') + '\n', 'utf8');

console.log('[publish] 复制 ' + copied + ' 个文件 / ' + (bytes / 1048576).toFixed(1) + ' MB；' +
  '跳过 ' + skipped + ' 项（清单见 _publish-excluded.txt）；文档模板 ' + tmpl + ' 个');
console.log('[publish] 完成 → ' + DST);
