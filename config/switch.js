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
