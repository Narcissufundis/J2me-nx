/*
 * 结构守卫：菜单项必须有对应的分发（perfL 2026-09-23）
 *
 * 背景：实机"选择遮罩选不了"——`ACT_ITEMS` 里有 '选择遮罩'，
 * openMaskSel()/drawMaskPanel()/mask 模式按键分支/8 张 raw 全都在，
 * 唯独 game 菜单确认函数 actPick() 里漏了 `if (item === '选择遮罩') {...}`，
 * 按 A 就落到末尾的 mode='list' 回列表。这类"菜单加了一项但忘了接分发"
 * 的漏改以前发生过（工作树被回滚 / 同文件多个 Edit 互相覆盖），
 * 所以用本测试把它钉死。
 *
 * 注意：本文件必须用"按缩进切函数块"的方式取函数体，不能用
 * /function f()\s*\{([\s\S]*?)\n\s*\}/ 这种非贪婪正则——它会停在第一个
 * 嵌套块的右花括号上，导致函数体被截断、断言假失败（第一版就踩了这个坑）。
 *
 * 运行：node tests/menu-items.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'app', 'main.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}
// 取 "function NAME(...)" 到下一个同缩进的 function 之间（同文件里这些函数都是 6 空格缩进）
function extractFn(text, name) {
  const start = text.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const end = text.indexOf('\n      function ', start + 10);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}
// 取 "var NAME = [ ... ];" 整块（用行首缩进闭合符定位，避免嵌套对象干扰）
function extractArray(text, name) {
  const start = text.indexOf('var ' + name + ' ');
  if (start < 0) return '';
  const end = text.indexOf('\n  ];', start);
  return end < 0 ? text.slice(start) : text.slice(start, end + 4);
}

// ---- 1. ACT_ITEMS 与分发 ----
const itemsBlock = src.match(/var ACT_ITEMS\s*=\s*\[([^\]]*)\]/);
check('找得到 ACT_ITEMS', !!itemsBlock, true);
const items = itemsBlock
  ? itemsBlock[1].split(',').map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ''); }).filter(Boolean)
  : [];
check('ACT_ITEMS 项数', items.length, 7);
check("含 '选择遮罩'", items.indexOf('选择遮罩') >= 0, true);
check("含 '按键映射'", items.indexOf('按键映射') >= 0, true);

const actPick = extractFn(src, 'actPick');
check('找得到 actPick()', actPick.length > 0, true);
check('actPick 抓到完整函数体（含末尾 fallthrough）', actPick.indexOf("mode = 'list'") >= 0, true);

// 除"返回列表"（本就靠 fallthrough 回列表）外，每项都要有显式分发
const FALLTHROUGH_OK = ['返回列表'];
const missing = items.filter(function (it) {
  return FALLTHROUGH_OK.indexOf(it) < 0 && actPick.indexOf("item === '" + it + "'") < 0;
});
check('每个菜单项都有分发: ' + (missing.length ? missing.join(',') : '(全部)'), missing.length, 0);

// ---- 2. 选择遮罩链路：菜单 → openMaskSel → mode='mask' → draw() ----
check("actPick: '选择遮罩' → openMaskSel()",
  /item === '选择遮罩'\)\s*\{\s*openMaskSel\(\);\s*return;/.test(actPick), true);
const openMaskSel = extractFn(src, 'openMaskSel');
check('openMaskSel 存在', openMaskSel.length > 0, true);
check("openMaskSel 设置 mode = 'mask'", openMaskSel.indexOf("mode = 'mask'") >= 0, true);
check('openMaskSel 调用 draw()', /\bdraw\(\);/.test(openMaskSel), true);
check('openMaskSel 定义了（不是只被调用）', src.indexOf('function openMaskSel(') >= 0, true);

// ---- 3. 每个面板 mode 都要既有绘制分支又有按键分支 ----
const drawFn = extractFn(src, 'draw');
['mask', 'keymap', 'res', 'del', 'rename'].forEach(function (md) {
  check("draw() 有 mode === '" + md + "' → 面板绘制", drawFn.indexOf("mode === '" + md + "') draw") >= 0, true);
});
const pollBlock = src.indexOf("mode === 'mask'", src.indexOf('function actPick('));
check("按键轮询含 mode === 'mask' 分支", pollBlock > 0, true);
check("按键轮询含 mode === 'keymap' 分支", src.indexOf("mode === 'keymap'", src.indexOf('function actPick(')) > 0, true);
check('mask 分支里调 pickMask()', src.indexOf('pickMask();') >= 0, true);
check('keymap 分支里调 kmPick()', src.indexOf('kmPick();') >= 0, true);

// ---- 3b. 按键映射链路：菜单 → openKeyMap → kmList/drawKeyMapPanel ----
check("actPick: '按键映射' → openKeyMap()",
  /item === '按键映射'\)\s*\{\s*openKeyMap\(\);\s*return;/.test(actPick), true);
const openKeyMap = extractFn(src, 'openKeyMap');
check('openKeyMap 存在', openKeyMap.length > 0, true);
check("openKeyMap 设置 mode = 'keymap'", openKeyMap.indexOf("mode = 'keymap'") >= 0, true);
check('keymap 面板有行表 kmList()', src.indexOf('function kmList()') > 0, true);
check('keymap 面板有绘制函数 drawKeyMapPanel()', src.indexOf('function drawKeyMapPanel()') > 0, true);
check('绑定写盘走 saveKeyMap()', src.indexOf('saveKeyMap(true)') > 0, true);
// 开机载入 keys.txt：必须发生在 host 脚本 eval 之后（afterHostScripts），
// 不能在模块级裸调——那时 g.__keyMap 还不存在（2026-09-23 桌面仿真抓到过）
check('开机载入 keys.txt（afterHostScripts → loadKeyMap）',
  /afterHostScripts[\s\S]{0,600}?loadKeyMap\(\);/.test(src), true);
check('模块级不裸调 loadKeyMap()', src.indexOf('\n  loadKeyMap();') < 0, true);

// ---- 3c. 自定义遮罩链路：SD 扫描 → 列表 → 加载 ----
check('挂载了 host/mask-scan.js（SCRIPTS）', src.indexOf("'host/mask-scan.js'") > 0, true);
check('开机扫 SD 遮罩目录（initMaskSel → refreshSdMasks）',
  /initMaskSel[\s\S]{0,300}?refreshSdMasks\(\)/.test(src), true);
check('打开遮罩面板时重扫（新增文件免重启）',
  extractFn(src, 'openMaskSel').indexOf('refreshSdMasks()') >= 0, true);
check("maskList() 合并 SD 条目（'SD: ' 前缀）", src.indexOf("'SD: ' +") > 0, true);
check('PNG 自定义遮罩走 __decodePNG', src.indexOf('g.__decodePNG(bytes)') > 0, true);
check('SD 遮罩 id 前缀 sd:', src.indexOf("'sd:'") > 0, true);

// ---- 4. 遮罩注册表：1 张内置 + 8 张用户（romfs:/masks/）----
const defsBlock = extractArray(src, 'MASK_DEFS');
check('找得到 MASK_DEFS 整块', defsBlock.length > 0, true);
const entries = [...defsBlock.matchAll(/\{\s*id:\s*'([^']+)'[^}]*file:\s*'([^']+)'/g)]
  .map(function (x) { return { id: x[1], file: x[2] }; });
check('MASK_DEFS 条目数（1 内置 + 8 用户）', entries.length, 9);
const userMasks = entries.filter(function (e) { return e.file.indexOf('romfs:/masks/') === 0; });
check('用户遮罩 8 张', userMasks.length, 8);
check('内置遮罩指向 romfs:/mask.raw',
  entries.some(function (e) { return e.id === 'builtin' && e.file === 'romfs:/mask.raw'; }), true);
check('内置遮罩也在列（不只是 8 张）', entries.length === userMasks.length + 1, true);

// ---- 5. 持久化文件与预载挂钩 ----
check('mask.json 持久化路径存在', src.indexOf('mask.json') >= 0, true);
check('游戏启动前预载遮罩（ensureMaskLoaded 被调用）',
  src.indexOf('ensureMaskLoaded(g.__maskState && g.__maskState.sel)') >= 0, true);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
