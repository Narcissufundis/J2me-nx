'use strict';

/*
 * config/switch.js — j2me-nx-port 应用配置（替代上游 config/xxx.js）
 *
 * 加载顺序：config/default.js（vendor 默认）→ 本文件 → bld/config-build.js
 * → config/urlparams.js（在 Switch 上 search 为空，无操作）
 */

// 运行时改写（config/default.js 先加载，直接覆盖属性）
config.main = 'com/sun/midp/main/MIDletSuiteLoader';

// ---- JIT 开关：主线 = perfI 形态（VM baseline JIT **全关**）----
// perfI 实机（821 档 / 171 秒 / 3198 帧）：稳态 15~19fps、轻场景 24~37fps、
// 三项内存全平（Java 堆 11.8MB 平线、V8 total 封顶 114.2MB、原生 peak 40.7MB）。
// perfJ（把 VM JIT 打开）实机反馈"时不时卡顿"⇒ 主线保持全关。
// 阈值语义：interpreterCallCount + backwardsBranchCount > 阈值才编译。
config.invokeThreshold = 1000000000;        // 小方法：永不编译
config.invokeThresholdBig = 1000000000;     // ≥512B 大方法：永不编译
config.backwardBranchThreshold = 1000000000; // 回边：永不触发就地编译
config.enableOSR = false;                   // OSR 关闭
// 说明：JIT 关闭后 jit/relooper.ts 只是死代码（不会被调用）；
// 上游 emscripten Relooper 的 C++ 源（jit/relooper/Relooper.cpp/.h/ministring.h + glue.js）一直在树里。
//
// PATCH(perfZ31/perfZ35)：**JIT 中间档（默认关，按 SD 标记文件开启，可分级）**。
// 由来：perfJ 把 JIT 全开 → 热点小方法编译太频繁，实机"时不时卡顿"⇒ 之后长期全关。
// 但纯解释在"游戏自己的逐字绘字"这类负载上代价极高：UFO Afterlight 实机
// [hot-top10] 显示 `PointFont.DrawChar` 占 VM 时间 **66~78%**，整局 vm=27.4s / 窗口 34.2s
// （300 帧要 34 秒 ≈ 8.8fps）—— VM 就是瓶颈，呈现层只占 ~16%。
//
// ⚠ 2026-09-24 实机事故（perfZ35 复核 error.log 后改档）：**perfZ32~Z34 的 hot 档并没有
//   按设计"只编采样器命中的热点"** —— 它同时继承了 `invokeThresholdBig = 3`，
//   于是**任何 ≥512B 的方法被调用 3 次就编译**。实机日志（UFO，偏紧档 425MB，JIT 档=hot）：
//     [jit-try] i.paint 3879B calls=4 / i.a.(Lj;Lk;)V 4702B calls=4 / d.b.()V 4415B calls=4
//     [jit] #25 d.a.()V 103.0ms codeSize=9269   ← 9KB 方法、只被调 3 次就编
//   两分半钟内编了 **29 个**方法（而"紧档每会话上限 8"这条策略根本没生效 —— 见下），
//   每次 30~103ms 的 Relooper 代码生成 + `new Function`，然后整机静默退出（日志无 [exit]）。
//   ⇒ 本版把档位语义收紧成"**只按采样热点编译**"，并给出**全局硬上限**：
//   ① 任何档位都不再设 `invokeThresholdBig = 3`（唯一例外是明确写着 all 的对照档）；
//   ② `config.jitCompileCap` = 全会话编译方法数硬上限（在 runtime 的编译入口处判定，
//      连解释器路径一起管住），紧档再砍一半；
//   ③ 偏紧档（host 侧 limit<700MB）**强制按 off 处理**：本项目所有实机崩溃都出现在
//      "偏紧档 + JIT" 这个组合里，这是**收敛风险**（不是已证因果），想用 JIT 请先退回
//      主页重开直到日志出现 `★档位=正常`。
//
// 分级由 SD 文件 `sdmc:/switch/j2me-nx/jit-big` 的**内容**决定（host 读取后写
// jsGlobal.__jitTier，本文件在 eval 时应用）—— **必须显式写出档位名**：
//   文件不存在 / 空 / 内容认不出 / 内容含 off  → off（默认，VM 全解释）
//   内容含 hot   → hot    ：只编译采样器实测热点（每榜 ≤2 个，全会话 ≤ jitCompileCap）
//   内容含 big   → big    ：同上，但只编 ≥512B 的（更保守）
//   内容含 osr   → bigosr ：再加 OSR
//   内容含 all   → all    ：**老 perfJ 形态**（小方法/回边阈值 10）—— 仅作对照，别长期开
(function () {
  var gl = (typeof globalThis !== 'undefined') ? globalThis : (typeof window !== 'undefined' ? window : null);
  var tier = (gl && gl.__jitTier) || 'off';
  var tight = !!(gl && gl.__memTight);
  var desc = 'off（VM 全解释）';
  // 硬上限：全会话最多编译这么多个方法（紧档减半）。0/负数=不限制。
  var cap = 8;
  if (tight) cap = 4;
  config.jitCompileCap = cap;
  if (gl) gl.__jitCompileCap = cap;   // 供宿主心跳行打印（[jit] … 上限=N 个方法）
  if (tier === 'big' || tier === 'bigosr' || tier === 'hot' || tier === 'all') {
    // perfZ35：**不再**动 invokeThresholdBig（当年就是它把 big 档变成"3 次调用就编"）。
    // 编译只由 int.ts 的采样热点队列触发：不看大小，只看实测热点。
    config.hotspotCompileLimit = 4;   // 每 10s 检查一次，每榜最多 4 个
    desc = 'big/hot（只按采样热点编译，不看方法大小）';
  }
  if (tier === 'big' && !gl.__jitBigOnly) gl.__jitBigOnly = true;  // 只编 ≥512B（在 int.ts 里判）
  if (tier === 'bigosr' || tier === 'all') {
    config.enableOSR = true;
    desc += ' + OSR';
  }
  if (tier === 'all') {
    // 唯一保留"按调用次数编译"的档位：明确标注为对照用。
    config.invokeThreshold = 10;
    config.invokeThresholdBig = 10;
    config.backwardBranchThreshold = 10;
    config.jitCompileCap = tight ? 8 : 24;
    if (gl) gl.__jitCompileCap = config.jitCompileCap;
    desc += ' + 小方法/回边阈值 10（≈perfJ，危险，仅对照）';
  }
  if (tier !== 'off' && typeof console !== 'undefined' && console.log) {
    console.log('[jit] 档位=' + desc + ' 全会话上限=' + config.jitCompileCap + ' 个方法' +
      (tight ? '（偏紧档：上限减半）' : ''));
  }
})();

// ---- MIDlet 来源：SD 卡 java 目录（sdmc:/switch/java）----
// XHR shim 会把相对路径映射到 DATA_ROOT（app/main.js 注入）。
// 多游戏：app/main.js 启动菜单列出 java/ 下全部 .jar（名字取自 jar 内
// MANIFEST.MF），选中后由资源加载器把 'midlet.jar' 映射到所选 jar。
config.jars = 'midlet.jar';
config.jad = null;        // 2026-09-20 JAD 链路整体移除（manifest 即 JAD）
config.downloadJAD = null; // 全部走本地 SD，不走网络下载

// 关闭游戏手柄屏幕按钮 UI（真机有自己的按键）
config.gamepad = 'no';

// ---- 屏幕尺寸：启用 autosize ----
// 必须开启：否则 midp.js 走"固定布局"分支，从 DOM 元素 #display 的 clientWidth
// 取屏幕尺寸（我们的宿主没有该元素，stub 返回 0），updateCanvas() 会把设备画布
// 压成 0x0，导致 Display.WIDTH/HEIGHT 为 0、依赖屏幕尺寸的游戏崩溃。
// autosize 分支用 window.outerWidth/outerHeight 计算（env-prelude 设为 240x320）。
config.autosize = '1';

// ---- 屏幕呈现方向（app/main.js installPresenter）----
// J2ME 逻辑屏 240x320（竖屏），Switch 物理屏 1280x720（横屏）。
//   90（默认）：横持 Switch，画面顺时针转 90°，放大到 960x720 居中
//   0        ：竖持画面直接放大到 540x720 居中
// 还可设 180 / 270。
config.j2meRotate = 90;

// 忽略文件：有些 MIDlet 往日志文件狂写但从不读
config.ignoredFiles.add('/Persistent/error.log');

// ---- MIDlet 类名 ----
// 多游戏后由菜单在选中时填写（MANIFEST.MF 的 MIDlet-1 第三字段）。
// 必须保持空串：vendor main.js 只有在 !config.midletClassName 时才把
// 游戏 jar 加载并入 Promise.all 等待链——非空会导致 VM 与 jar 加载赛跑。
config.midletClassName = '';
