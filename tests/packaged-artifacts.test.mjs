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
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// PATCH(perfZ44)：**没打包时优雅跳过**。
// 这个测试原本只被单独跑（`npm run test:artifacts`），因为它在 romfs/ 不存在时会直接抛异常；
// 外部评审指出 README/BUILD 都宣称"产物自检在 npm test 里"，于是把它并进默认测试链，
// 但必须保证干净克隆（还没 build/package 过）跑 `npm test` 不会被它弄失败。
if (!existsSync(join(root, 'romfs', 'main.js')) || !existsSync(join(root, 'romfs', 'j2me', 'main-all.js'))) {
  console.log('SKIP 产物自检：romfs/ 尚未打包（先跑 node tools/build.mjs && node tools/package.mjs）');
  console.log('0 passed, 0 failed (skipped)');
  process.exit(0);
}
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
  '构建标记 perfZ48': '20260924-perfZ48-copyarea',
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
  // perfZ25：入口耗时账本 + 原子合成（防"进入游戏卡几秒/黑屏闪屏"回退成不可观测）
  '入口耗时账本：汇总函数': 'enterSummary',
  '入口耗时账本：时间轴标记': '__enterMark',
  '入口耗时账本：20s 兜底': '\u672A\u51FA\u9996\u5E27',
  '呈现：离屏合成缓冲': '合成缓冲',
  '呈现：逐段耗时（真空闲）': '\u771F\u7A7A\u95F2',
  '耗时账本：记账函数': '__costAdd',
  '耗时账本：窗口行': '[cost] ',
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

// ---- 读盘类型契约（perfZ26：实机 ArrayBuffer 没有 .length，三个落盘功能静默失效） ----
{
  check('bytes.js 在 romfs（读盘类型规整模块）',
    existsSync(join(root, 'romfs/host/bytes.js')), true);
  check('romfs/main.js 走 __toU8 规整读盘结果', rm.indexOf('__toU8') > 0, true);
  check('romfs/main.js 打印落盘文件清单（诊断）', rm.indexOf('[io] 落盘文件: ') > 0, true);
}

// ---- 字体与许可证（perfZ25：换掉不可再分发的 SimHei） ----
// 背景：旧内置字体 SimHei 的 OS/2.fsType = 8（仅允许嵌入）→ 发布即侵权。
// 现在内置 SIL OFL 1.1 的 Noto Sans SC，**许可证必须随字体一起打包**（OFL 第 1 条）。
{
  const envSrc = readFileSync(join(root, 'src/host/env-prelude.js'), 'utf8');
  check('字体：package.mjs 拷贝 CJK 字体到 romfs', pkgSrc.indexOf("'fonts/cjk.ttf'") >= 0, true);
  check('字体：package.mjs 拷贝 OFL 许可证到 romfs', pkgSrc.indexOf("'fonts/OFL.txt'") >= 0, true);
  check('字体：仓库带 OFL 许可证全文',
    existsSync(join(root, 'data/fonts/OFL-NotoSansSC.txt')), true);
  check('字体：许可证是 SIL OFL 1.1',
    readFileSync(join(root, 'data/fonts/OFL-NotoSansSC.txt'), 'utf8')
      .indexOf('SIL Open Font License, Version 1.1') >= 0, true);
  check('字体：字体说明文档在（data/fonts/README.md）',
    existsSync(join(root, 'data/fonts/README.md')), true);
  const font = readFileSync(join(root, 'data/fonts/cjk.ttf'));
  // 真 TTF：sfnt 版本 0x00010000 或 'true'；同时排除 SimHei（Windows 字体不允许再分发）
  const sfnt = font.readUInt32BE(0);
  check('字体：是静态 sfnt/TTF（不是 woff/otf-CFF 包装）', sfnt === 0x00010000 || sfnt === 0x74727565, true);
  check('字体：不含 SimHei 字样（名字表里不许出现）',
    font.indexOf(Buffer.from('SimHei', 'latin1')) < 0, true);
  check('字体：大小合理（8~14MB）', font.length > 8e6 && font.length < 14e6, true);

  // ---- perfZ25：原生图像解码（runtime libpng + 线程池）----
  check('图像：env-prelude 抓原生 Blob 类', envSrc.indexOf('__nativeBlobClass') > 0, true);
  check('图像：env-prelude 用 createImageBitmap 原生解码',
    envSrc.indexOf('__nativeCreateImageBitmap') > 0, true);
  check('图像：原生失败回落纯 JS 解码', envSrc.indexOf('回落 JS') > 0, true);
  check('图像：我们的 Blob 打了 shim 标记（软重启不误抓）',
    envSrc.indexOf('__j2meBlobShim') > 0, true);
  // 格式闸门（安全关键）：runtime 的 decode_png 不做 gray→RGB、不 strip 16bit、
  // 只对 RGBA 预乘 alpha —— 灰度/16bit/调色板+tRNS 必须回落纯 JS，否则像素错位、
  // 堆越界或透明边彩边。判定表由 tests/native-png-gate.test.mjs 逐条断言。
  check('图像：有原生解码格式闸门 __nativePngSafe',
    envSrc.indexOf('g.__nativePngSafe = nativePngSafe') > 0, true);
  check('图像：闸门认 tRNS（非预乘 alpha 不走原生）',
    envSrc.indexOf("pngHasChunk(bytes, 'tRNS')") > 0, true);
  check('图像：闸门卡位深（16bit 会被 libpng 写越界）',
    envSrc.indexOf('if (bitDepth !== 8)') > 0, true);
  check('图像：drawImage 包装层认原生 _bitmap', mainSrc.indexOf('img._bitmap') > 0, true);
}

// ---- NSP 打包形态（perfZ28）：必须是 slim；fat 内嵌官方未打补丁运行时会启动即崩 ----
// 事故背景：玩家试装 NSP「直接报错」—— npm run nsp 以前传的是 --fat，而 fat 把**官方
// 未打补丁的运行时**当 exefs/main 内嵌，配 nxjs.ini 的 jit = on 正好是官方运行时在 Switch
// 上分配 JIT 代码页即 Data Abort 的老问题。现在固定 --slim + 自动附带共享运行时 + 结构自检。
{
  const pkgJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  check('npm run nsp 用 --slim（fat 内嵌官方运行时 → jit=on 启动即 Data Abort）',
    /nsp[^"]*--slim/.test(pkgJson.scripts.nsp), true);
  check('npm run nsp 里不再有 --fat', /--fat/.test(pkgJson.scripts.nsp), false);
  check('npm run nsp 会跑 verify-nsp 自检', pkgJson.scripts.nsp.indexOf('verify-nsp.mjs') >= 0, true);
  check('npm run nsp 会一并产出共享运行时',
    readFileSync(join(root, 'tools/pack-output.mjs'), 'utf8').indexOf('nxjs-v') >= 0, true);
  check('存在 tools/verify-nsp.mjs', existsSync(join(root, 'tools/verify-nsp.mjs')), true);
  const buildDoc = readFileSync(join(root, 'release/BUILD.md'), 'utf8');
  check('BUILD.md 写了 NSP 需要 SD 上的共享运行时', buildDoc.indexOf('sdmc:/nx.js/') >= 0, true);
  check('BUILD.md 写了为什么不能打 fat（官方运行时 / Data Abort）',
    buildDoc.indexOf('--fat') >= 0 && buildDoc.indexOf('Data Abort') >= 0, true);
}

// ---- NRO 前端 NSP（perfZ35）：主页图标 + application 模式，本体仍是 SD 上的 NRO ----
// 背景：用户要"单纯启动 SD 上那个 J2me-nx.nro"的主页入口。用 NTON 生成 322KB 的前端 NSP，
// 里面的 NRO 路径是**硬编码**的 —— 所以本仓库必须固定用 sdmc:/switch/J2me-nx.nro 这个名字，
// 而且 verify-nsp 不能拿 romfs 大小去套它（会算出负数差值、误判成 fat）。
{
  const verifySrc = readFileSync(join(root, 'tools/verify-nsp.mjs'), 'utf8');
  check('verify-nsp 认「NRO 前端」形态（小 program NCA + 无 romfs）',
    verifySrc.indexOf('forwarder') > 0 && verifySrc.indexOf('NRO→NSP 前端') > 0, true);
  const fwDoc = join(root, 'release/FORWARDER.md');
  check('存在 release/FORWARDER.md（前端说明，中英双语）', existsSync(fwDoc), true);
  if (existsSync(fwDoc)) {
    const doc = readFileSync(fwDoc, 'utf8');
    check('前端说明写明硬编码路径不能改（sdmc:/switch/J2me-nx.nro）',
      doc.indexOf('sdmc:/switch/J2me-nx.nro') >= 0 && doc.indexOf('硬编码') >= 0, true);
    check('前端说明写明仍需共享运行时', doc.indexOf('sdmc:/nx.js/nxjs-v') >= 0, true);
    check('前端说明有验收标志（正常档 821MB / NRO-独立）',
      doc.indexOf('正常档 821MB') >= 0 && doc.indexOf('NRO-独立') >= 0, true);
    check('前端说明有英文段（Forwarder NSP / application mode）',
      doc.indexOf('Forwarder NSP') >= 0 && doc.indexOf('application mode') >= 0, true);
  }
  const readmeDoc = readFileSync(join(root, 'release/README.md'), 'utf8');
  check('README 列了前端 NSP 这条装法', readmeDoc.indexOf('J2me-nx-forwarder.nsp') > 0, true);
  check('README 的 SD 目录表里有共享运行时',
    readmeDoc.indexOf('sdmc:/nx.js/nxjs-v1.0.0-beta.6.nro') > 0, true);
  const buildDoc2 = readFileSync(join(root, 'release/BUILD.md'), 'utf8');
  check('BUILD.md 写了 nton build 的用法', buildDoc2.indexOf('nton build') >= 0, true);
  const pkg2 = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  check('存在 tools/pack-forwarder.mjs（收前端产物 + 自检）',
    existsSync(join(root, 'tools/pack-forwarder.mjs')), true);
  check('npm run forwarder 指向 pack-forwarder.mjs',
    /pack-forwarder\.mjs/.test(pkg2.scripts.forwarder || ''), true);
  check('pack-forwarder 会拦住"不是前端的大包"（>8MB 报错）',
    readFileSync(join(root, 'tools/pack-forwarder.mjs'), 'utf8').indexOf('8 * 1024 * 1024') > 0, true);
  // perfZ35：要发 Git 就必须让"README 说的"和".gitignore 做的"一致 ——
  // README 承诺字体随仓库提供、开箱可构建，而 .gitignore 以前把 data/fonts/*.ttf 全忽略掉，
  // 克隆下来根本构建不了。内置 cjk.ttf 是 SIL OFL 1.1（可再分发），改成不忽略。
  const gitignoreSrc = readFileSync(join(root, 'release/.gitignore'), 'utf8');
  check('.gitignore 不再把内置字体一刀切忽略（README 承诺随仓库提供）',
    /^data\/fonts\/\*\.ttf$/m.test(gitignoreSrc), false);
  check('.gitignore 仍忽略不可再分发的第三方 wasm',
    gitignoreSrc.indexOf('data/adlmidi/*.wasm') > 0, true);
  const publishSrc = readFileSync(join(root, 'tools/make-publish.mjs'), 'utf8');
  check('发布快照带上图标输入 icon.jpg（否则克隆后只能得到默认图标）',
    publishSrc.indexOf("'icon.jpg'") > 0, true);
  check('发布快照带上 FORWARDER.md',
    publishSrc.indexOf("'FORWARDER.md'") > 0, true);
  const fwNsp = join(root, 'dist/forwarder/J2me-nx-forwarder.nsp');
  if (existsSync(fwNsp)) {
    const sz = statSync(fwNsp).size;
    check('前端 NSP 存在且是"小包"形态（<2MB）', sz > 0 && sz < 2 * 1024 * 1024, true);
    check('前端 NSP 里不含应用 romfs（不会被误当作完整 NSP）',
      readFileSync(fwNsp).indexOf(Buffer.from('main.js', 'latin1')) < 0, true);
  }
}

// ---- 版本可辨认（perfZ26）：屏显标记必须与 boot 日志标记一致 ----
// 事故背景：玩家报"重启还是中文"，日志里跑的其实是两轮前的旧包 —— SD 卡上同名 NRO
// 是哪一版分不清。现在主页右下角直接写 build 标记，二者必须同源。
{
  const m = /build=([0-9A-Za-z._-]+)/.exec(mainSrc);
  check('app/main.js 有 build= 标记', !!m, true);
  const tag = /var BUILD_TAG = '([^']+)'/.exec(mainSrc);
  check('app/main.js 定义了 BUILD_TAG', !!tag, true);
  if (m && tag) {
    check('BUILD_TAG 与 build= 标记尾段一致', tag[1], m[1].replace(/^\d{8}-/, ''));
  }
  // perfZ30：用户明确要求"不许打在屏幕上" —— 调试标记必须默认关闭（开关 SHOW_BUILD_TAG=false）
  check('调试标记默认不在屏幕上（SHOW_BUILD_TAG=false）',
    mainSrc.indexOf('var SHOW_BUILD_TAG = false;') > 0, true);
  check('调试标记的绘制被开关包住',
    /if \(SHOW_BUILD_TAG\) \{[\s\S]{0,400}?drawTextRight\('build '/.test(mainSrc), true);
  check('内存档位只进日志（[boot] 形态=… ｜ 内存 limit=…）',
    mainSrc.indexOf("'[boot] 形态='") > 0, true);
  // perfZ31：脏帧跳过（无变化帧不合成）+ 大方法 JIT 中间档开关
  check('呈现层有脏帧跳过', mainSrc.indexOf('needComposite') > 0, true);
  check('跳帧率进 [present] 日志', mainSrc.indexOf("' | 跳帧='") > 0, true);
  check('JIT 中间档由 SD 文件 jit-big 控制',
    mainSrc.indexOf('sdmc:/switch/j2me-nx/jit-big') > 0, true);
  check('运行时编译改为只排队（requestCompile）',
    readFileSync(join(root, 'vendor/pluotsorbet/vm/runtime.ts'), 'utf8').indexOf('export function requestCompile') > 0, true);
  check('解释器里不存在未包 forceRuntimeCompilation 的直接编译',
    /^\s*compileAndLinkMethod\(/m.test(readFileSync(join(root, 'vendor/pluotsorbet/int.ts'), 'utf8')), false);
  check('热点定向编译在 int.ts（maybeCompileHotspots）',
    readFileSync(join(root, 'vendor/pluotsorbet/int.ts'), 'utf8').indexOf('maybeCompileHotspots') > 0, true);
  check('热点榜带字节码长度 len=',
    readFileSync(join(root, 'vendor/pluotsorbet/int.ts'), 'utf8').indexOf('/len=') > 0, true);
  check('config/switch.js 读 __jitTier 并设大方法阈值',
    readFileSync(join(root, 'config/switch.js'), 'utf8').indexOf('__jitTier') > 0, true);
  check('vendor gfx 侧有脏帧计数 __drawTick',
    readFileSync(join(root, 'vendor/pluotsorbet/midp/gfx.js'), 'utf8').indexOf('__drawTick') > 0, true);
  // perfZ30：开机必须能分辨「NSP-slim 还是独立 NRO」与本次内存档位（否则又只能猜）
  check('开机打印形态（NSP-slim / NRO-独立）', mainSrc.indexOf("'[boot] 形态='") > 0, true);
  check('形态判定读的是 romfs:/nxjs.ini 的 [runtime]', mainSrc.indexOf('readFileSyncLocal(\'romfs:/nxjs.ini\')') > 0, true);
  check('菜单右下角显示内存档位', mainSrc.indexOf('内存档位') > 0, true);
  check('打包脚本产出带版本戳的文件名',
    readFileSync(join(root, 'tools/pack-output.mjs'), 'utf8').indexOf('J2me-nx-${tag}') > 0, true);
}

// ---- JIT 安全策略（perfZ35）：把"档位"从"按调用次数乱编"改回"只按采样热点 + 硬上限" ----
// 事故背景（PERF §42）：hot 档同时继承了 invokeThresholdBig = 3，于是任何 ≥512B 方法被调 3 次
// 就编译 —— 实机两分半编了 29 个（含 9KB 的 d.a.()V / 103ms），随后整机静默退出；
// 而脚本里写的"紧档每会话 ≤8"只挡了采样器那条路，压根没管住解释器路径。
{
  const swSrc = readFileSync(join(root, 'config/switch.js'), 'utf8');
  const rtSrc = readFileSync(join(root, 'vendor/pluotsorbet/vm/runtime.ts'), 'utf8');
  const intSrc = readFileSync(join(root, 'vendor/pluotsorbet/int.ts'), 'utf8');
  check('档位不再把 invokeThresholdBig 压到 3（乱编大方法的元凶）',
    /config\.invokeThresholdBig\s*=\s*3\b/.test(swSrc), false);
  check('config/switch.js 设全会话编译上限 jitCompileCap', swSrc.indexOf('config.jitCompileCap = cap') > 0, true);
  check('偏紧档上限减半（cap=4）', /if \(tight\) cap = 4;/.test(swSrc), true);
  check('runtime 有硬上限判定 jitCompileBudgetLeft', rtSrc.indexOf('function jitCompileBudgetLeft') > 0, true);
  check('编译入口处判上限（compileAndLinkMethod 里调用）',
    /if \(!config\.forceRuntimeCompilation && !jitCompileBudgetLeft\(\)\)/.test(rtSrc), true);
  check('排队入口也判上限（requestCompile 里调用）',
    rtSrc.indexOf('if (!jitCompileBudgetLeft()) {') > 0, true);
  check('上限到达时打一条 [jit-cap]', rtSrc.indexOf('"[jit-cap] 已达本会话编译上限') > 0, true);
  check('上限对采样器可见（jitCompileRemaining 导出）',
    rtSrc.indexOf('export function jitCompileRemaining') > 0 && intSrc.indexOf('jitCompileRemaining()') > 0, true);
  check('tier=big 只编 ≥512B（JitBigOnly 闸门）', rtSrc.indexOf('ConfigThresholds.JitBigOnly') > 0, true);
  check('采样器用同一个上限（不再各写各的 8/24）', intSrc.indexOf('hotCompileCount >= (tight ? 4 : 12)') > 0, true);
  // 取证：编译前后各留一条现场，否则下次静默退出又是黑的
  check('编译前留 [jit-pre] 现场', rtSrc.indexOf('"[jit-pre] #"') > 0, true);
  check('编译后留 [jit-post] 现场', rtSrc.indexOf('"[jit-post] #"') > 0, true);
  check('慢/大编译单独标 [jit-heavy]', rtSrc.indexOf('"[jit-heavy] "') > 0, true);
  const mainSrc2 = mainSrc;
  check('宿主提供堆探针 __jitMemProbe', mainSrc2.indexOf('g.__jitMemProbe = function') > 0, true);
  check('偏紧档强制关 JIT（收敛风险）', mainSrc2.indexOf('强制关闭 JIT') > 0, true);
  check('档位名认不出/写 off → 按 off 处理（fail-safe）',
    mainSrc2.indexOf("jbTxt.indexOf('off') >= 0 || jbTxt === ''") > 0, true);
  check('心跳行打印本会话上限', mainSrc2.indexOf("' 上限=' + (g.__jitCompileCap | 0)") > 0, true);
}

// ---- 原生堆可见性（perfZ36）：两次静默退出时 JS 堆账全健康，缺的正是这本账 ----
// 事故背景（§42/§43）：JIT 开/关各崩一次，都是偏紧档 425MB，崩前 used≈70/94MB、peakMalloc 37MB
// 毫无征兆；而 runtime 文档写明 native heap / JIT code arena / render surface / ArrayBuffer backing
// 共用一个预算（applet 小得多）。Switch.memoryUsage() 本来就有这些字段，我们从来没打过。
{
  const mainSrc3 = readFileSync(join(root, 'app/main.js'), 'utf8');
  check('有原生堆读数函数 nativeMemText', mainSrc3.indexOf('function nativeMemText()') > 0, true);
  check('读 nativeHeapUsed/Free/Arena/Total', mainSrc3.indexOf('m.nativeHeapUsed') > 0 &&
    mainSrc3.indexOf('m.nativeHeapFree') > 0 && mainSrc3.indexOf('m.nativeHeapArena') > 0 &&
    mainSrc3.indexOf('m.nativeHeapTotal') > 0, true);
  check('读可执行代码段 totalHeapSizeExecutable', mainSrc3.indexOf('m.totalHeapSizeExecutable') > 0, true);
  check('读离堆内存 externalMemory（ArrayBuffer backing）', mainSrc3.indexOf('m.externalMemory') > 0, true);
  check('面包屑行带原生读数（死前最后一行必须有）',
    /java堆=' \+ jh \+ nativeMemText\(\)/.test(mainSrc3), true);
  check('[mem] 心跳带原生读数', mainSrc3.indexOf("'MB' + jh +\n              nativeMemText()") > 0 ||
    /\+\s*jh \+\s*\n\s*nativeMemText\(\);/.test(mainSrc3), true);
  check('开机 [boot] 形态行带原生底数', /nativeMemText\(\) \+   \/\/ perfZ36/.test(mainSrc3), true);
  check('原生余量低会报警并可防御性回收（nativeMemGuard）',
    mainSrc3.indexOf('function nativeMemGuard()') > 0 && mainSrc3.indexOf('[nmem-warn]') > 0, true);
  // perfZ37：离堆尖峰要单独记（实机 ext 在场景加载时冲到 148.6MB，那一刻 free 只剩 19.7MB）
  check('离堆内存尖峰单独记录（[nmem-spike]）', mainSrc3.indexOf('[nmem-spike]') > 0, true);
  check('回收阈值提到 16MB 并加"ext 尖峰且余量偏低"条件',
    /freeMB < 16/.test(mainSrc3) && /extMB > 96 && freeMB < 32/.test(mainSrc3), true);
  check('占用守卫也挂在启动时（菜单阶段没有面包屑）',
    mainSrc3.indexOf("sdLog(memLine('启动时'));\n        nativeMemGuard();") > 0, true);
}

// ---- emoji 崩溃（perfZ38）：精灵图不在包里，却"假装支持"→ drawImage 抛异常把游戏带走 ----
// 实机事故（轩辕剑-天之痕）：游戏画含 emoji 区字符的文本 → drawString 走 emoji 分支 →
// images[sheet] 是个"没有任何解码产物的 Image" → Skia 抛 "Image or Canvas expected" →
// 异常冒进游戏线程 → 永远画不出首帧（[enter] 20s 未出首帧），看起来就是"卡死"。
{
  const emojiSrc = readFileSync(join(root, 'vendor/pluotsorbet/libs/emoji.js'), 'utf8');
  const gfxSrc = readFileSync(join(root, 'vendor/pluotsorbet/midp/gfx.js'), 'utf8');
  const mainSrc4 = readFileSync(join(root, 'app/main.js'), 'utf8');
  check('emoji 明确声明"不支持"（EMOJI_SUPPORTED=false）',
    emojiSrc.indexOf('var EMOJI_SUPPORTED = false;') > 0, true);
  check('不支持时 regEx 永不匹配（不再走进 emoji 分支）',
    emojiSrc.indexOf('EMOJI_SUPPORTED ? new RegExp(regexString') > 0, true);
  check('暴露 supported 供绘制层判定', emojiSrc.indexOf('supported: EMOJI_SUPPORTED,') > 0, true);
  check('getData 在拿不到精灵图时返回 img=null（不再把 undefined 交给 drawImage）',
    emojiSrc.indexOf('return { img: null, x: 0 };') > 0, true);
  check('图片加载失败也要 settle（onerror=resolve，防 gainedForeground0 永久挂起）',
    emojiSrc.indexOf('images[i].onerror = resolve;') > 0, true);
  check('drawString 先判 emoji.supported', gfxSrc.indexOf('if (!emoji.supported || !emoji.regEx.test(str))') > 0, true);
  check('drawString 里 emojiData.img 为空时回落普通文本',
    gfxSrc.indexOf('if (!emojiData || !emojiData.img)') > 0, true);
  // 宿主兜底：无解码产物的自家 Image 不再交给 Skia（只跳过这一笔绘制）
  check('Image shim 打标记 __j2meImageShim', readFileSync(join(root, 'src/host/env-prelude.js'), 'utf8')
    .indexOf('this.__j2meImageShim = true;') > 0, true);
  check('drawImage 兜底跳过无解码产物的 Image', mainSrc4.indexOf('img.__j2meImageShim && !img._bitmap && !img._decoded') > 0, true);
  // 长阻塞取证
  check('慢落盘记账 [io-slow]', mainSrc4.indexOf('[io-slow] 日志落盘耗时') > 0, true);
  check('长 sleep 记账 [sleep]（>30s 才记）',
    readFileSync(join(root, 'vendor/pluotsorbet/nat.ts'), 'utf8').indexOf('"[sleep] Java 线程请求 sleep "') > 0, true);
  check('JIT 现场探针带原生读数', mainSrc4.indexOf("'MB' + nativeMemText();") > 0, true);
  // perfZ36：挂起看门狗把 pc 纳入判定（否则"同方法被连调十几秒"会误报成卡死）
  const intSrc2 = readFileSync(join(root, 'vendor/pluotsorbet/int.ts'), 'utf8');
  check('挂起判定加 pc（同方法名不再误报卡死）', intSrc2.indexOf("var site = key + '@' + pc;") > 0, true);
  check('挂起文案改成"同一处已连续采样"', intSrc2.indexOf('同一处已连续采样') > 0, true);
}

// ---- 外部评审整改（perfZ44）：构建一致性 / CI / 存档耐久 / 注释漂移 ----
// 由来：一份对**已发布仓库**的第三方评审指出六件事，其中四条低成本、可立刻收口：
//   ① packaged-artifacts 自称在 npm test 里，实际没挂；② 根 package.json 有第二套过时依赖；
//   ③ 没有 CI；④ 存档是覆盖写、可能留半截 JSON；⑤ native-heap 头部注释与实现漂移；
//   ⑥ 默认 nxjs.ini 依赖仓库外的"打过补丁的运行时"。这一块就是防它们回退。
{
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  check('npm test 里包含产物自检（评审 ①）', /packaged-artifacts\.test\.mjs/.test(pkg.scripts.test), true);
  check('根 package.json 不再有第二套 devDependencies（评审 ②）', pkg.devDependencies === undefined, true);
  check('根 package.json 指向 tools/ 作为唯一依赖清单',
    JSON.stringify(pkg).indexOf('tools/package.json') > 0, true);
  check('CI workflow 存在（评审 ③）', existsSync(join(root, '.github/workflows/ci.yml')), true);
  const ciSrc = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  check('CI 跑构建 + 产物自检 + 全套测试',
    ciSrc.indexOf('tools/build-classes.mjs') > 0 && ciSrc.indexOf('packaged-artifacts.test.mjs') > 0 &&
    ciSrc.indexOf('npm test') > 0, true);
  // 存档原子化（评审 ④）
  check('存档改为原子替换（atomicWrite）', mainSrc.indexOf('function atomicWrite(') > 0, true);
  check('存档写 .tmp → 旧档转 .bak → 原子改名',
    mainSrc.indexOf("var tmp = path + '.tmp';") > 0 && mainSrc.indexOf("var bak = path + '.bak';") > 0 &&
    mainSrc.indexOf('rename(tmp, path);') > 0, true);
  check('读档在主档损坏时回落到 .bak', mainSrc.indexOf("saveFile + '.bak'") > 0, true);
  // 注释漂移（评审 ⑤）
  const nhSrc = readFileSync(join(root, 'src/native-heap.js'), 'utf8');
  check('native-heap 头部不再声称"free 是 no-op / 地址永不复用"',
    nhSrc.indexOf('_gcFree 是 no-op') < 0, true);
  check('native-heap 头部写明有完整 GC 与地址复用', nhSrc.indexOf('勘误（perfZ44') > 0, true);
  // stock runtime 构建路线（评审 ⑥）
  const pkgSrc2 = readFileSync(join(root, 'tools/package.mjs'), 'utf8');
  check('package.mjs 支持 J2ME_STOCK_RUNTIME=1 生成 jit=off 的 romfs',
    pkgSrc2.indexOf('J2ME_STOCK_RUNTIME') > 0 && pkgSrc2.indexOf("'$1off'") > 0, true);
  const buildDoc = readFileSync(join(root, 'release/BUILD.md'), 'utf8');
  check('BUILD.md 写了 stock runtime 构建路线',
    buildDoc.indexOf('J2ME_STOCK_RUNTIME') > 0, true);
  // perfZ46：**perfZ45 的帧落盘取证已整体删除**（玩家实测性能不足以边跑边取证，改为给截图）。
  // 这里反向断言"确实删干净了"——留着无人使用的调试入口/死文件才是真隐患。
  check('png-encode.js 已不在 SCRIPTS 表里',
    pairs.some(p => p.dst === 'host/png-encode.js'), false);
  check('romfs 里没有 host/png-encode.js',
    existsSync(join(root, 'romfs/host/png-encode.js')), false);
  check('src/host 里没有 png-encode.js',
    existsSync(join(root, 'src/host/png-encode.js')), false);
  // 注意：**只断代码形态，不断注释文字**——删除说明里会写到这些名字。
  check('宿主不再有 dumpFramePair / dump-frames 开关',
    mainSrc.indexOf('function dumpFramePair()') < 0 &&
    mainSrc.indexOf("readFileSyncLocal('sdmc:/switch/j2me-nx/dump-frames')") < 0 &&
    mainSrc.indexOf('g.__dumpArmed') < 0, true);
  check('vendor 侧不再暴露 __j2meGet*Canvas 钩子',
    readFileSync(join(root, 'vendor/pluotsorbet/midp/gfx.js'), 'utf8')
      .indexOf('globalThis.__j2meGetScreenCanvas') < 0, true);
  check('已删除的 PNG 编码测试不再进 npm test',
    /png-encode\.test\.mjs/.test(pkg.scripts.test), false);
  // perfZ47：镜像快照探针 + 当场同步快照（默认都关，靠 SD 空文件开）
  const gfxSrcP47 = readFileSync(join(root, 'vendor/pluotsorbet/midp/gfx.js'), 'utf8');
  check('宿主有两个新开关：probe-mirror / sync-mirror（默认关）',
    mainSrc.indexOf("readFileSyncLocal('sdmc:/switch/j2me-nx/probe-mirror')") > 0 &&
    mainSrc.indexOf("readFileSyncLocal('sdmc:/switch/j2me-nx/sync-mirror')") > 0 &&
    mainSrc.indexOf('g.__probeMirror = probeMirror;') > 0 &&
    mainSrc.indexOf('g.__syncMirror = syncMirror;') > 0, true);
  check('vendor：同步快照分支在 refresh0 内当场拷贝',
    gfxSrcP47.indexOf('if (useSync) {') > 0 &&
    gfxSrcP47.indexOf("g2.__mirrorSync = (g2.__mirrorSync | 0) + 1") > 0, true);
  check('vendor：延后 rAF 分支在同步模式下不再重复拷贝',
    gfxSrcP47.indexOf('if (!syncNow) {') > 0, true);
  check('vendor：采样探针只读 3 个像素（getImageData 1x1）',
    gfxSrcP47.indexOf('function sampleOffscreenPixels()') > 0 &&
    gfxSrcP47.indexOf('getImageData(xs[i], ys[i], 1, 1)') > 0, true);
  // perfZ48：copyArea 允许屏幕 Graphics（宠物王国4-白金黑屏根因）+ jit-trap 日志可读化
  check('copyArea 不再对屏幕 Graphics 抛 IllegalStateException',
    gfxSrcP47.indexOf('throw $.newIllegalStateException();') < 0, true);
  check('copyArea 快照画布复用（不再每次 createElement）',
    gfxSrcP47.indexOf('var copyAreaSnapshot = null, copyAreaSnapshotCtx = null;') > 0 &&
    gfxSrcP47.indexOf('if (!tmp || tmp.width !== canvas.width || tmp.height !== canvas.height)') > 0, true);
  check('copyArea 首次调用日志写明允许屏幕 Graphics 自拷贝',
    gfxSrcP47.indexOf('我们的屏幕 Graphics 就是 LCDUI 后备缓冲，允许自拷贝') > 0, true);
  const intSrcP48 = readFileSync(join(root, 'vendor/pluotsorbet/int.ts'), 'utf8');
  check('[jit-trap] 打印 Java 异常类名而不是 [object Object]',
    intSrcP48.indexOf('function describeTrapError(e: any): string') > 0 &&
    intSrcP48.indexOf("'java:' + cls + '(地址=' + e._address + ')'") > 0 &&
    intSrcP48.indexOf('describeTrapError(e)') > 0, true);
  // perfZ49：公开面只放"面向第三方"的文档；内部开发日志不进快照。
  const mpSrcP49 = readFileSync(join(root, 'tools/make-publish.mjs'), 'utf8');
  check('内部开发日志不进发布快照',
    mpSrcP49.indexOf("'PERF-修复记录-perfA-perfB.md'") < 0, true);
  check('RUNTIME.md 作为文档模板进快照',
    mpSrcP49.indexOf("'RUNTIME.md'") > 0, true);
  const noticeP49 = readFileSync(join(root, 'release/NOTICE.md'), 'utf8');
  check('NOTICE 不再有"上线前建议处理（待办）"章节',
    noticeP49.indexOf('上线前建议处理') < 0 && noticeP49.indexOf('Suggested TODOs') < 0, true);
  check('NOTICE 改成维护说明并指向 RUNTIME.md',
    noticeP49.indexOf('维护说明') > 0 && noticeP49.indexOf('RUNTIME.md') > 0, true);
  check('公开文档里没有本机绝对路径（盘符/用户名）',
    [readFileSync(join(root, 'release/BUILD.md'), 'utf8'),
     readFileSync(join(root, 'release/README.md'), 'utf8'),
     readFileSync(join(root, 'release/RUNTIME.md'), 'utf8'),
     noticeP49].every((t) => !/[A-F]:\\Users|C:\\Users\\|[A-F]:\\[a-zA-Z0-9_]+\\jdk/.test(t)), true);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);