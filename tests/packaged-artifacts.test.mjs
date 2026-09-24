/*
 * 打包产物守卫：romfs/ 里的每个 SCRIPTS 文件必须与 src/ 逐字节一致，
 * 且新功能的关键标记必须真的进了 romfs/main.js。
 *
 * 由来（两次真实事故）：
 *   ① png-decoder.js 漏拷贝 —— Node 仿真读仓库路径发现不了，实机一启动就崩；
 *   ② 本次新增 host/mask-scan.js，package.mjs 与 SCRIPTS 任何一处漏了就静默少个功能。
 * 所以这里把 app/main.js 的 SCRIPTS 表解析出来，逐条比对 sha256。
 *
 * 运行：node tests/packaged-artifacts.test.mjs
 *      （需先跑过 node tools/package.mjs；没打包时会明确报"romfs 未打包"）
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mainSrc = readFileSync(join(root, 'app/main.js'), 'utf8');
const pkgSrc = readFileSync(join(root, 'tools/package.mjs'), 'utf8');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase();

// ---- 解析 SCRIPTS 表：['src/x/y.js', 'host/y.js'] ----
const iScripts = mainSrc.indexOf('var SCRIPTS');
const iEnd = mainSrc.indexOf('];', iScripts);
check('找到 SCRIPTS 表', iScripts > 0 && iEnd > iScripts, true);
const table = mainSrc.slice(iScripts, iEnd);
const pairs = [...table.matchAll(/\['([^']+)'\s*,\s*'([^']+)'\]/g)]
  .map(m => ({ src: m[1], dst: m[2] }));
check('SCRIPTS 条目 >= 14', pairs.length >= 14, true);
check('SCRIPTS 含 host/mask-scan.js',
  pairs.some(p => p.dst === 'host/mask-scan.js'), true);
check('SCRIPTS 含 host/png-decoder.js',
  pairs.some(p => p.dst === 'host/png-decoder.js'), true);
check('SCRIPTS 含 host/switch-input.js',
  pairs.some(p => p.dst === 'host/switch-input.js'), true);
check('SCRIPTS 含 host/ui-lang.js（屏显中/英）',
  pairs.some(p => p.dst === 'host/ui-lang.js'), true);

// ---- package.mjs 的 copy() 也要覆盖同一批文件 ----
for (const p of pairs) {
  check(`package.mjs 拷贝 ${p.dst}`, pkgSrc.indexOf(`'${p.dst}'`) >= 0, true);
}

// ---- src ↔ romfs 逐字节一致 ----
for (const p of pairs) {
  const s = join(root, p.src);
  const d = join(root, 'romfs', p.dst);
  if (!existsSync(d)) { check(`romfs 存在 ${p.dst}`, 'MISSING', 'exists'); continue; }
  check(`romfs 与 src 一致 ${p.dst}`, sha(d) === sha(s), true);
}

// ---- romfs/main.js 里新功能标记 ----
// ⚠️ esbuild 会把中文转义成 \uXXXX 字面量（如 \u9009\u62E9\u906E\u7F69），
// 而且会压掉语句后的空格（'openKeyMap();return;'），所以：
//   ① 先做一次 \uXXXX 反解再找中文；② 代码形态只断言标识符本身。
const rmRaw = readFileSync(join(root, 'romfs/main.js'), 'utf8');
const rm = rmRaw.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const MARK = {
  '构建标记 perfZ24': '20260924-perfZ24-trapfix',
  '文本输入钩子': '__hostTextInput',
  '输入法注入钩子': '__sendInputMethodText',
  '按键映射面板入口': 'openKeyMap',
  '按键机型面板入口': 'openProfSel',
  '按键机型存档': 'keyprofiles.json',
  '按键映射写盘': '__saveKeyMap',
  '按键映射载入': '__loadKeyMap',
  'SD 遮罩扫描': '__maskScan',
  'SD 遮罩读说明': '__maskReadme',
  'PNG 解码调用': '__decodePNG',
  'PNG 尺寸探测': '__pngSize',
  '遮罩像素上限': 'MASK_MAX_PX',
  '遮罩文件上限': 'MASK_MAX_BYTES',
  '遮罩面板提示（自加遮罩）': '\u81EA\u52A0\u906E\u7F69',
  '按键映射面板标题': '\u6309\u952E\u6620\u5C04',
  '选择遮罩面板标题': '\u9009\u62E9\u906E\u7F69',
  '菜单项：按键映射': '\u6309\u952E\u6620\u5C04',
  '说明文件写入': '\u8BF4\u660E.txt',
  // ⚠ 产物侧只断言**标识符/中文**：esbuild 会把 'lang' 这种字符串字面量统一成双引号，
  // 所以 "mode === 'lang'" 这种带引号的源码形态在 bundle 里找不到。
  '屏显中/英：语言弹窗绘制函数': 'drawLangPanel',
  '屏显中/英：二次确认状态': 'langConfirm',
  '屏显中/英：落盘路径': 'lang.json',
  '屏显中/英：右上角双语提示（中文行）': '\u6309 ZR+ZL \u5207\u6362\u4E2D/\u82F1\u6587',
  '屏显中/英：右上角双语提示（英文行）': 'Press ZR+ZL to switch language',
  '屏显中/英：弹窗两项': '\u5207\u6362\u5230\u82F1\u6587',
};
for (const [name, needle] of Object.entries(MARK)) {
  check(`romfs/main.js 含 ${name}`, rm.indexOf(needle) >= 0, true);
}
// 菜单分发（源码侧有格式，产物侧被压缩 → 分别在各自文件里断言）
check('源码菜单分发到按键映射面板', mainSrc.indexOf('openKeyMap(); return;') >= 0, true);
check('产物里 openKeyMap 至少两处（定义+分发）',
  (rmRaw.match(/openKeyMap/g) || []).length >= 2, true);
check('产物里选择遮罩分发存在',
  (rmRaw.match(/openMaskSel/g) || []).length >= 2, true);

// ---- vendor 补丁必须真的进了 bundle ----
// 事故（2026-09-23 perfR）：改了 vendor/pluotsorbet/midp/midp.js 后只跑了
// tools/package.mjs（它只拷 bld/ 里现成的产物），没跑 tools/build.mjs，
// 于是补丁静默没进 bundle —— 产物自检里那一条计数是 0 才发现。
// 这里把"vendor 补丁必须出现在 romfs 的 bundle 里"钉死。
{
  const bundle = readFileSync(join(root, 'romfs/j2me/main-all.js'), 'utf8');
  check('vendor：getKeyName 查宿主软键名表', bundle.indexOf('__softKeyNameMap') > 0, true);
  check('vendor：摩托罗拉 OK -20 → FIRE(8)', /"-20"\s*:\s*8/.test(bundle), true);
  check('vendor：QWERTY 横屏字符码 → 方向/确认',
    /\b116\s*:\s*1/.test(bundle) && /\b98\s*:\s*6/.test(bundle) && /\b103\s*:\s*8/.test(bundle), true);
  check('vendor：文本输入钩子（__hostTextInput）', bundle.indexOf('__hostTextInput') > 0, true);
  check('vendor：输入法注入（__sendInputMethodText）', bundle.indexOf('__sendInputMethodText') > 0, true);
  // 2026-09-23 perfZ5：软键（ZL/ZR）触发 LCDUI 命令的直通钩子必须在 bundle 里。
  // 事故背景：命令 onclick 被挂在 #displayable-N 的 .button0/.button1 上，而宿主软键点的是
  // #header-ok-button / #back-button，于是 ZL/ZR 对所有 Command 界面（取名 Form/TextBox、
  // Alert、List）都没反应 —— "打得进字、按确定却读不到"。
  check('vendor：LCDUI 命令软键直通（__lcdInvokeCommand）', bundle.indexOf('__lcdInvokeCommand') > 0, true);
  check('vendor：命令表在无命令界面会被清空（lcdCommands = [])',
    /lcdCommands = \[\];/.test(bundle), true);
  check('vendor：header/back 按钮的 onclick 也补挂（DOM 回落路径）',
    /headerBtnFallback/.test(bundle), true);
  // 2026-09-24 perfZ22：资源流 skip 的 O(1) 快进。事故背景：ResourceInputStream 没覆盖
  // skip → 继承 InputStream 的逐字节实现 → 每个字节一次 native 调用；实机
  // [hot-top10] InputStream.skip=22% + ResourceInputStream.read=19%，一次 skip 6.4 万字节
  // → "进图卡死"。这里钉住"JS 侧 native + classes.jar 里的 skip 覆盖"两半都在包里。
  check('vendor：资源流 O(1) 快进 native（skipBytes）', bundle.indexOf('skipBytes') > 0, true);
  // perfZ24：探针限流（[jit-trap] / [media] / [midi] 不许每次同步写卡）。
  // ⚠ ① 中文标记必须在**反解 \uXXXX 之后**的文本里找（esbuild 会把中文转义）；
  //    ② [jit-trap] 的解释器代码在 **j2me.js**（int.ts 编译产物），不在 main-all.js。
  const bundleZh = bundle.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  check('vendor：媒体探针已限流（mediaMark）', bundleZh.indexOf('探针已限流，每 25 次留一条') > 0, true);
  {
    const vmJs = readFileSync(join(root, 'romfs/j2me/j2me.js'), 'utf8')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    check('vendor：jit-trap 探针已限流', vmJs.indexOf('同类只记次数，不再每次写卡') > 0, true);
  }
  {
    const cj = readFileSync(join(root, 'romfs/java/classes.jar'));
    check('classes.jar：ResourceInputStream 含 skipBytes（skip 覆盖真的编进去了）',
      cj.indexOf(Buffer.from('skipBytes')) >= 0, true);
    check('classes.jar：ResourceInputStream 类在包里',
      cj.indexOf(Buffer.from('com/sun/cldc/io/ResourceInputStream')) >= 0, true);
  }
  // bld 与 romfs 必须一致（忘了重新 package 会被抓到）
  const bldBundle = readFileSync(join(root, 'bld/main-all.js'), 'utf8');
  check('romfs bundle 与 bld 一致', bundle.length === bldBundle.length, true);
}

// ---- 输入层产物里的关键实现 ----
const ri = readFileSync(join(root, 'romfs/host/switch-input.js'), 'utf8');
check('输入层：默认表 DEFAULT_PAD_TO_MIDP', ri.indexOf('var DEFAULT_PAD_TO_MIDP') > 0, true);
check('输入层：活动表 PAD_TO_MIDP', ri.indexOf('var PAD_TO_MIDP') > 0, true);
check('输入层：__keyMap 导出', ri.indexOf('g.__keyMap = {') > 0, true);
check('输入层：__gameRunning 硬闸', ri.indexOf('var vmActive = (g.__gameRunning === true)') > 0, true);
check('输入层：+ 键也走硬闸', ri.indexOf('plusNow && !plusWas && vmActive') > 0, true);
check('输入层：软键字符串映射', ri.indexOf("KEY_NAME_TO_CODE['SOFT_LEFT'] = 'soft-left'") > 0, true);
check('输入层：独占绑定 bindExclusive', ri.indexOf('function bindExclusive(idx, code)') > 0, true);
check('输入层：bindExclusive 已挂到 __keyMap', ri.indexOf('bindExclusive: bindExclusive') > 0, true);
check('输入层：没夹带 BOM', readFileSync(join(root, 'romfs/host/switch-input.js'))[0] !== 0xEF, true);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
