/*
 * emoji-fallback.test.mjs — 回归：emoji 精灵图不在包里时，绘制必须"降级"而不是抛异常
 *
 * 实机事故（2026-09-24，轩辕剑-天之痕，见 PERF §45）：
 *   游戏画了一段含 emoji 区字符的文本 → gfx.js drawString 走 emoji 分支 →
 *   c.drawImage(images[sheet], …)，而 images[sheet] 是宿主 Image shim 造的"空壳"
 *   （src 指向 style/emoji/emojiN.png —— 这 12 张图不在我们的 romfs 里，
 *    shim 为了让 onload 流程不挂死会延迟触发 onload，但**不产生任何解码产物**）→
 *   Skia 抛 `Error: Image or Canvas expected` → 异常穿过 Graphics.drawString 的 native
 *   冒进游戏线程 → 游戏初始化/绘制链断掉，**永远画不出第一帧**（日志 `[enter] 20s 未出首帧`），
 *   实机表现就是"卡死"。
 *
 * 修法：emoji 模块明确声明不支持（regEx 永不匹配 + getData 返回 img=null + 加载失败也 settle），
 *       drawString 先判 emoji.supported 并在拿不到图像时回落普通文本绘制。
 *
 * 运行：node tests/emoji-fallback.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

// ---- 在隔离沙箱里加载 emoji 模块（不支持模式应当不碰 Image/URL/Blob/JARStore）----
const src = readFileSync(join(root, 'vendor/pluotsorbet/libs/emoji.js'), 'utf8');
const sandbox = { config: {}, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'emoji.js' });
const emoji = sandbox.emoji;

check('模块加载后能拿到 emoji 对象', typeof emoji, 'object');
check('明确声明不支持（EMOJI_SUPPORTED=false）', emoji.supported, false);
check('loadData() 不依赖图片即可完成', emoji.loaded, true);

// ---- 关键回归：emoji 区字符不再被 regEx 命中（否则又会走 drawImage 分支）----
const EMOJI_SAMPLES = [
  '\uD83C\uDF00',   // U+1F300 旋风（\ud83c[\udf00-\udfff] 覆盖）
  '\uD83D\uDE00',   // U+1F600 笑脸
  '\uD83D\uDE80',   // U+1F680 火箭
  '1\u20E3',        // 1️⃣
  '\uD83C\uDDEF\uD83C\uDDF5', // 🇯🇵
];
for (const s of EMOJI_SAMPLES) {
  emoji.regEx.lastIndex = 0;
  check('regEx 不再命中 ' + JSON.stringify(s), emoji.regEx.test(s), false);
}
// 反向对照：普通中文/ASCII 本来就不该命中（确保没把正则写坏）
for (const s of ['音乐开', '音乐关', '100%', 'A']) {
  emoji.regEx.lastIndex = 0;
  check('普通文本不命中 ' + JSON.stringify(s), emoji.regEx.test(s), false);
}

// ---- getData 必须返回 img=null（调用方据此回落），绝不能返回 undefined ----
const d = emoji.getData('\uD83C\uDF00', 15);
check('getData 返回对象', typeof d, 'object');
check('getData.img 是 null（不是 undefined）', d.img, null);
check('getData.x 是数字', typeof d.x, 'number');

// ---- gfx.js 侧的两道闸（源码级断言，避免以后被"优化"掉）----
const gfx = readFileSync(join(root, 'vendor/pluotsorbet/midp/gfx.js'), 'utf8');
check('drawString 先判 emoji.supported',
  gfx.indexOf('if (!emoji.supported || !emoji.regEx.test(str))') > 0, true);
check('drawString 在 img 为空时回落 fillText',
  gfx.indexOf('if (!emojiData || !emojiData.img)') > 0, true);
// 硬约束：drawImage 的实参不允许再出现"未经判空"的 emojiData.img —— 判空必须在前
check('emoji 分支里 drawImage 之前必有判空（源码顺序检查）',
  gfx.indexOf('if (!emojiData || !emojiData.img)') < gfx.indexOf('c.drawImage(emojiData.img'), true);

// ---- 宿主兜底闸门：自家 Image shim 无解码产物时跳过绘制 ----
const prelude = readFileSync(join(root, 'src/host/env-prelude.js'), 'utf8');
const main = readFileSync(join(root, 'app/main.js'), 'utf8');
check('Image shim 打标记 __j2meImageShim', prelude.indexOf('this.__j2meImageShim = true;') > 0, true);
check('drawImage 兜底跳过"无解码产物的自家 Image"',
  main.indexOf('img.__j2meImageShim && !img._bitmap && !img._decoded') > 0, true);
check('跳过时只记一次日志（不刷屏）', main.indexOf('g.__imgSkipCount === 1') > 0, true);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
