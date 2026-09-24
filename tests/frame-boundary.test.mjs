/*
 * frame-boundary.test.mjs — 回归：宿主必须**按帧边界**合成，不能按任意 rAF 合成
 *
 * 实机症状（2026-09-24 玩家报，见 PERF §46）：
 *   · "游戏场景中移动镜头，人物会出现重影"
 *   · 早先还报过"宠物王国黑屏闪屏"
 *
 * 通路：游戏 → offscreenCanvas（LCDUI 后备缓冲） --DisplayDevice.refresh0(每个脏矩形一次, 每次等一个 rAF)-->
 *       设备画布（document.getElementById("canvas")） --宿主 present()--> scene --> screen
 *
 * 旧逻辑：present() 里 `drawTickNow !== lastDrawTick` 就合成，而 __drawTick 记的是**画进 offscreen 的动作**，
 * 与"设备画布何时被刷新"并不同步。于是：
 *   · 一帧被拆成多个脏矩形时，设备画布在两次 refresh0 之间是半新半旧的混合
 *     → 合成出来就是"新背景 + 旧位置的角色" = 重影；
 *   · 清屏与绘制分开时 → 中间那次合成就是"黑屏一闪"。
 * 新逻辑：等"有刷新落地 且 游戏这一拍没再画"再合成（或超时兜底）。
 *
 * 运行：node tests/frame-boundary.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

const gfx = readFileSync(join(root, 'vendor/pluotsorbet/midp/gfx.js'), 'utf8');
const main = readFileSync(join(root, 'app/main.js'), 'utf8');

// ---- vendor 侧：refresh0 必须留下"帧边界"信号 ----
check('refresh0 记录刷新序号 __refreshSeq', gfx.indexOf('g.__refreshSeq = (g.__refreshSeq | 0) + 1') > 0, true);
check('refresh0 区分整屏/局部刷新', gfx.indexOf('g.__refreshFull = (g.__refreshFull | 0) + 1') > 0 &&
  gfx.indexOf('g.__refreshPart = (g.__refreshPart | 0) + 1') > 0, true);
check('refresh0 记录最近刷新时刻 __refreshLastAt', gfx.indexOf('g.__refreshLastAt = Date.now()') > 0, true);

// ---- 宿主侧：合成必须由帧边界驱动 ----
check('present 读 __refreshSeq', main.indexOf('var refreshNow = g.__refreshSeq | 0;') > 0, true);
check('present 有 pendingComposite（等帧完整落地）', main.indexOf('pendingComposite') > 0, true);
check('present 判"游戏这一拍没再画"（gameIdleThisTick）',
  main.indexOf('var gameIdleThisTick = (drawTickNow === lastCheckTick);') > 0, true);
check('present 保留了兜底（等到一拍 16ms 就合成，不再无限等）',
  main.indexOf('nowMs - pendingSince >= 16') > 0, true);
check('从不刷新的游戏仍走旧脏帧规则（refreshNow === 0）',
  main.indexOf('(refreshNow === 0 && drawTickNow !== lastDrawTick)') > 0, true);
check('[present] 行打印刷新统计与两种合成计数',
  main.indexOf("' | 上屏刷新=' + (g.__refreshSeq | 0)") > 0 && main.indexOf('边界合成=') > 0, true);

// ---- copyArea：上游是空实现，我们必须补上（滚动原语）----
check('copyArea 已实现（不再只打 not implemented）',
  gfx.indexOf('console.warn("javax/microedition/lcdui/Graphics.copyArea') < 0, true);
check('copyArea 用临时画布做重叠安全复制',
  gfx.indexOf('copyAreaSnapshotCtx.drawImage(canvas, 0, 0);') > 0, true);
check('copyArea 处理 anchor 对齐',
  gfx.indexOf('if (0 !== (anchor & HCENTER)) { dx -= ((width >>> 1) | 0); }') > 0, true);
// PATCH(perfZ48)：**必须允许屏幕 Graphics**。宠物王国4-白金用 copyArea 做整幅地图滚动
// （e.a(Graphics) 的 bci=771：setClip(0,0,256,336) + copyArea(...,20)），
// 我们原来照抄 MIDP 那条 IllegalStateException 限制 ⇒ 每帧一滚动就在"清完黑还没画"处整帧中断，
// 玩家看到"黑 1 秒 → 正常 → 循环"。我们的屏幕 Graphics 就是 LCDUI 后备缓冲，自拷贝安全。
check('copyArea 不再对 screen graphics 抛 IllegalStateException（黑屏根因）',
  /copyArea[\s\S]{0,400}isScreenGraphics\(self\)[\s\S]{0,200}newIllegalStateException/.test(gfx), false);
check('copyArea 快照画布复用（每帧滚动不再反复分配）',
  gfx.indexOf('var copyAreaSnapshot = null, copyAreaSnapshotCtx = null;') > 0, true);
check('copyArea 首次调用留一条日志（好知道哪个游戏在用）',
  gfx.indexOf('[gfx] copyArea 首次被调用') > 0, true);

// ---- 关键回归：不允许再出现"只看 drawTick 就合成"的老写法 ----
const oldRule = /var needComposite = \(drawTickNow !== lastDrawTick\) \|\| \(layoutSig !== lastLayoutSig\)/;
check('旧的一行式脏帧判定已被替换（防止回退）', oldRule.test(main), false);

// ---- perfZ40：整块镜像（治"拖影/残影：旧位置没擦掉"）----
// 残影是**持久**的 ⇒ 那些像素根本没被送到设备画布，而不是时序抖动：
// 设备画布不是显示缓冲，而是靠 refresh0 逐脏矩形"拼"出来的镜子，漏一块就永远停在上一次的状态。
check('refresh0 默认整块镜像 offscreen → 设备画布',
  gfx.indexOf('MIDP.deviceContext.drawImage(offscreenCanvas, 0, 0);') > 0, true);
check('整块镜像按 tick 合并（mirrorScheduled）', gfx.indexOf('mirrorScheduled = true;') > 0, true);
check('合并后逐个唤醒被 pause 的 Java 线程',
  gfx.indexOf('var cs = pendingMirrorCtxs;') > 0 && gfx.indexOf('J2ME.Scheduler.enqueue(cs[i]);') > 0, true);
check('保留 partial-blit 逃生开关（退回旧行为做 A/B）',
  gfx.indexOf('var usePartial = !!(g2 && g2.__partialBlit);') > 0, true);
check('宿主读 sdmc:/switch/j2me-nx/partial-blit 开关',
  main.indexOf("readFileSyncLocal('sdmc:/switch/j2me-nx/partial-blit')") > 0, true);
check('[present] 行打印镜像次数', main.indexOf("' 镜像=' + (g.__mirrorFull | 0)") > 0, true);
// perfZ40：矩形"含端点"修正（Java 侧 x2/y2 是右下角）——少一行一列会让那条像素永远不更新
check('刷新矩形按含端点算宽高（x2-x1+1）', gfx.indexOf('var width = x2 - x1 + 1;') > 0 &&
  gfx.indexOf('var height = y2 - y1 + 1;') > 0, true);
check('x2/y2 上界收到 max-1（防源矩形越界）', gfx.indexOf('x2 = Math.min(maxX - 1, x2);') > 0 &&
  gfx.indexOf('y2 = Math.min(maxY - 1, y2);') > 0, true);
check('前 3 次刷新把原始矩形落盘（实机确认含端点）',
  gfx.indexOf('g.__refreshSeq <= 3 && g.__sdMark') > 0, true);
check('整屏判定改用修正后的 width/height',
  gfx.indexOf('width >= offscreenCanvas.width && height >= offscreenCanvas.height') > 0, true);
check('[present] 行不再出现旧的"只拷脏矩形"整屏拷贝路径（在 usePartial 分支里）',
  gfx.indexOf('if (usePartial) {') > 0 &&
  gfx.indexOf('MIDP.deviceContext.drawImage(offscreenCanvas, x1, y1, width, height, x1, y1, width, height);') >
  gfx.indexOf('if (usePartial) {'), true);

// ---- perfZ41：自拷贝 blit 必须先快照（剧情强制平移镜头时的拖影）----
// 玩家补充的关键信息：**自己走位/推镜头正常，只有"剧情强制移动镜头"时拖影**。
// 这种不对称正指向两种不同绘制手法：剧情平移为了省 CPU，习惯用"把画面整体挪一格、
// 只画新露出来的那条"的滚动写法，在 MIDP 里就是 drawRegion(自己, …) 这种**自我拷贝**
// （上游没实现 copyArea，老游戏普遍拿它代替）。我们把它直接交给 Skia（同一个 canvas
// 既当源又当目标）→ 边读边写、逐行涂开 = 拖影，每挪一格累积一次。
check('renderRegion 检测自拷贝（源画布 == 目标画布）',
  gfx.indexOf('if (dstContext && srcCanvas && dstContext.canvas === srcCanvas) {') > 0, true);
check('自拷贝时先快照到（复用的）快照画布、再用快照画',
  gfx.indexOf('snapCtx.drawImage(srcCanvas, 0, 0);') > 0 &&
  gfx.indexOf('srcCanvas = snap;') > 0, true);
check('自拷贝计数 + 前 3 次落盘（知道哪个游戏在滚动）',
  gfx.indexOf('g.__selfBlitN = (g.__selfBlitN | 0) + 1;') > 0 &&
  gfx.indexOf('[scroll] 自拷贝 blit（先快照再画）') > 0, true);
check('[present] 行打印自拷贝/copyArea 计数',
  main.indexOf("' 自拷贝blit=' + (g.__selfBlitN | 0)") > 0 &&
  main.indexOf("' copyArea=' + (g.__copyAreaN | 0)") > 0, true);

// ---- perfZ42：绘制轨迹探针（诊断笑傲武林那种"部分上屏"写法）----
check('有 traceDraw 探针且默认关（traceArmed 模块内布尔量把关）',
  gfx.indexOf('function traceDraw(kind, detail, ctx)') > 0 &&
  gfx.indexOf('if (!traceArmed) return;') > 0, true);
check('drawRegion/drawRGB/setClip 都接了探针',
  gfx.indexOf('traceDraw("REGION"') > 0 && gfx.indexOf('traceDraw("RGB"') > 0 &&
  gfx.indexOf('traceDraw("CLIP"') > 0, true);
check('裁剪区挂在 ctx 上供探针读取',
  gfx.indexOf('this.context.__j2meClipX = graphicsInfo.clipX1;') > 0, true);
check('宿主用 sdmc:/switch/j2me-nx/trace-draw 开关探针（8 秒预算）',
  main.indexOf("readFileSyncLocal('sdmc:/switch/j2me-nx/trace-draw')") > 0 &&
  main.indexOf('g.__traceDrawLeft = 8;') > 0, true);

// ---- perfZ43：性能回归守卫（perfZ39 的 120ms 兜底把"每帧都在画"的游戏限流成 8fps）----
check('帧边界合成的兜底窗口是一拍（16ms），不是 120ms',
  main.indexOf('nowMs - pendingSince >= 16') > 0 && main.indexOf('pendingSince > 120') < 0, true);
check('有 no-frame-gate 逃生开关（完全退回旧行为）',
  main.indexOf("readFileSyncLocal('sdmc:/switch/j2me-nx/no-frame-gate')") > 0 &&
  main.indexOf('g.__noFrameGate = noGate') > 0, true);
check('探针默认关，且调用点先过 traceArmed（不拼字符串）',
  gfx.indexOf('if (traceArmed) {') > 0 &&
  gfx.indexOf('traceDraw("REGION", "src=" + sx') > gfx.indexOf('if (traceArmed) {'), true);
check('探针开关是 vendor 侧模块内布尔量（宿主用 __setDrawTrace）',
  gfx.indexOf('function setDrawTrace(on)') > 0 && gfx.indexOf('globalThis.__setDrawTrace') >= 0 ||
  main.indexOf('g.__setDrawTrace(true)') > 0, true);
check('自拷贝快照复用同一张画布（不再每次 new）',
  gfx.indexOf('var snap = selfBlitSnapshot;') > 0, true);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
