/*
 * app/main.js — j2me-nx-port 总入口
 *
 * 同时支持两种宿主：
 *   1. nx.js（Nintendo Switch 真机）：Canvas 类、Switch 手柄事件、SD 卡 fs
 *   2. Node（tools/simulate.mjs 冒烟测试）：stub canvas、本地磁盘 fs
 *
 * 职责：按浏览器 <script> 顺序执行 vendor 代码，并注入宿主钩子：
 *   __setCanvasFactory / __setDisplayCanvas / __setResourceLoader
 *   installPipeHost / __audioPlayerPipe / __installSwitchInput / __dispatchKey
 *
 * 数据目录（SD）：
 *   romfs 内置 —— java/classes.jar（类库）、字体、遮罩、证书
 *   sdmc:/switch/java/         —— 游戏 .jar（菜单选择，名字取自 MANIFEST.MF）
 *   sdmc:/switch/j2me-nx/save/ —— 存档（按游戏名分文件夹）
 */
'use strict';

(function () {
  var g = typeof globalThis !== 'undefined' ? globalThis : this;

  // ==================================================================
  // -1. 会话世代守卫：进程内软重启的基础设施
  // ==================================================================
  // 按退出键（+）回到游戏菜单 = 杀掉当前游戏并重新求值整个 vendor bundle。
  // 旧 VM 的 setInterval/rAF 链不能留着跑（会同时驱动新旧两个 VM），
  // 所以这里给所有"游戏侧"定时器打世代标记：重启时世代 +1，旧回调
  // 一律自灭。宿主自己的常驻循环（呈现层/手柄轮询）走 __noGen 直通
  // 表，跨世代存活。vendor 在 boot() 里求值，晚于本包装 → 全部被覆盖。
  var __sessionGen = 0;
  var __genIntervals = [];
  var __origSetTimeout = g.setTimeout.bind(g);
  var __origSetInterval = g.setInterval.bind(g);
  var __origClearInterval = g.clearInterval.bind(g);
  var __origRAF = g.requestAnimationFrame ? g.requestAnimationFrame.bind(g) : null;
  g.__noGen = {
    setTimeout: __origSetTimeout,
    setInterval: __origSetInterval,
    clearTimeout: g.clearTimeout ? g.clearTimeout.bind(g) : null,
    requestAnimationFrame: __origRAF,
  };
  g.setTimeout = function (fn, ms) {
    var gen = __sessionGen;
    var args = Array.prototype.slice.call(arguments, 2);
    return __origSetTimeout(function () {
      if (gen !== __sessionGen) return;
      return fn.apply(null, args);
    }, ms);
  };
  g.setInterval = function (fn, ms) {
    var gen = __sessionGen;
    var rec = null;
    var id = __origSetInterval(function () {
      if (gen !== __sessionGen) {
        __origClearInterval(rec.id); // 兜底自清（错过 killTimers 时）
        return;
      }
      return fn.apply(null, arguments);
    }, ms);
    rec = { id: id, gen: gen };
    __genIntervals.push(rec);
    return id;
  };
  g.requestAnimationFrame = function (fn) {
    if (!__origRAF) return 0;
    var gen = __sessionGen;
    return __origRAF(function (t) {
      if (gen !== __sessionGen) return;
      return fn(t);
    });
  };
  // 重启时调用：清掉所有旧世代的 interval（rAF/setTimeout 靠世代自灭）
  g.__killSessionTimers = function () {
    __sessionGen++;
    for (var i = 0; i < __genIntervals.length; i++) {
      if (__genIntervals[i].gen !== __sessionGen) {
        try { __origClearInterval(__genIntervals[i].id); } catch (e) { /* 忽略 */ }
      }
    }
    __genIntervals = [];
  };

  // ==================================================================
  // 0. 平台检测与文件系统适配
  // ==================================================================

  var IS_SWITCH = typeof g.Switch !== 'undefined';
  var IS_NODE = typeof process !== 'undefined' &&
    Object.prototype.toString.call(process) === '[object process]';

  // PATCH(perfZ24): Node 仿真（桌面回归测试）用的仓库根目录 —— **不再写死绝对路径**，
  // 否则别人 clone 下来跑测试会去读原作者的 F:\Deepseek\...。约定：在仓库根目录运行
  // （npm test / node tools/xxx.mjs 都是这么跑的）。
  var NODE_REPO_ROOT = (function () {
    try {
      if (IS_NODE && process.cwd) return String(process.cwd()).replace(/\\/g, '/');
    } catch (e) { /* 忽略 */ }
    return '.';
  })();

  var DATA_ROOT = IS_SWITCH
    ? 'sdmc:/switch/j2me-nx/data'
    : NODE_REPO_ROOT + '/data';

  // nx.js beta6 自带 TextEncoder.encode 输出缓冲只按 1.5×字符数分配
  // （polyfills/text-encoder.ts:31），中文 3 字节/字直接静默截断——names.txt
  // 曾被拦腰砍成 88 字节残卷（改完名读回来口口）。所有含中文的字符串写盘
  // 一律先用这个正确实现转 Uint8Array 再交给 Switch.writeFileSync。
  function __utf8(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000;
          i++;
        }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c < 0x10000) {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else {
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f),
                 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  // 游戏目录（SD，小写 java 避免大小写歧义；缺了会自动创建）。
  // 全部 *.jar 进菜单，游戏名取自 jar 内 META-INF/MANIFEST.MF。
  var GAME_ROOT = IS_SWITCH ? 'sdmc:/switch/java' : DATA_ROOT;
  // 存档根目录：每个游戏一个子文件夹（按游戏名），互不干扰。
  var SAVE_ROOT = IS_SWITCH ? 'sdmc:/switch/j2me-nx/save' : DATA_ROOT + '/save';
  // 旧版单游戏存档位置（迁移源：首次运行把它的内容搬到当前游戏的存档文件）
  var SAVE_LEGACY = IS_SWITCH
    ? 'sdmc:/switch/j2me-nx/data/idb-fs.json'
    : DATA_ROOT + '/idb-fs.json';

  // 手动分辨率覆盖表：{ jar文件名: "WxH" }，菜单里 X 键设置（Xbox 布局索引 3
  // = Switch 物理X）。auto = 删条目回自动探测。持久化到 json，跨次启动保留。
  var RES_FILE = IS_SWITCH
    ? 'sdmc:/switch/j2me-nx/resolutions.json'
    : DATA_ROOT + '/resolutions.json';
  var resOverrides = null;
  function loadResOverrides() {
    if (resOverrides) return resOverrides;
    resOverrides = {};
    try {
      var bytes = readFileSyncLocal(RES_FILE);
      if (bytes) {
        var text = typeof TextDecoder !== 'undefined'
          ? new TextDecoder().decode(bytes)
          : String(bytes);
        resOverrides = JSON.parse(text) || {};
      }
    } catch (e) { /* 无文件/坏 JSON 用空表 */ }
    return resOverrides;
  }
  function saveResOverrides() {
    try {
      var text = JSON.stringify(resOverrides || {});
      if (IS_SWITCH) {
        if (g.Switch && g.Switch.writeFileSync) g.Switch.writeFileSync(RES_FILE, __utf8(text));
      } else {
        require('fs').writeFileSync(RES_FILE, text);
      }
    } catch (e) {
      sdLog('[res] 覆盖表写盘失败: ' + (e && e.message));
    }
  }

  // ==================================================================
  // 可选遮罩注册表（Y 菜单 → 选择遮罩）
  // ==================================================================
  // 来源：用户自绘遮罩 8 张 + 默认 1 张（1280x720 RGBA **裸文件**，
  // romfs:/masks/ 与 romfs:/mask.raw，文件名沿用用户命名）。
  // ⚠️ 2026-09-23 perfZ6：内置遮罩**一律 raw，不再有 png 版本**（data/mask.png 已删）。
  //   理由：实机上跑 PNG 解码是大分配/秒退的嫌疑源（PERF 记录 §17），而且旧 mask.png
  //   是 1920x1080 的旧图，与 raw 不同步——留着只会让人误以为"兜底"还在。
  // cut = 透明窗口矩形 [x,y,w,h]（alpha==0 bbox）。注意 cut 目前只做记录/面板展示用，
  //   真正决定游戏画面位置的是 presenter 里的 GX/GY/GW/GH（默认遮罩路径）。
  // 运行时规则：遮罩整图垫底铺满（装饰贴屏幕边缘），游戏照常等比放大
  // 居中画在遮罩上层——中心透明窗口区域被游戏覆盖，游戏主体永不被盖。
  var MASK_DEFS = [
    { id: 'builtin', name: '内置竖屏遮罩', file: 'romfs:/mask.raw', w: 1280, h: 720, cut: [373, 0, 539, 720] },
    { id: 'land_bear', name: '横屏-可爱小熊', file: 'romfs:/masks/横屏-可爱小熊.raw', w: 1280, h: 720, cut: [213, 2, 855, 716] },
    { id: 'land_pad', name: '横屏-复古手柄', file: 'romfs:/masks/横屏-复古手柄.raw', w: 1280, h: 720, cut: [215, 2, 851, 716] },
    { id: 'land_retro', name: '横屏-怀旧游戏机', file: 'romfs:/masks/横屏-怀旧游戏机.raw', w: 1280, h: 720, cut: [146, 2, 987, 716] },
    { id: 'land_autumn', name: '横屏-秋日风景', file: 'romfs:/masks/横屏-秋日风景.raw', w: 1280, h: 720, cut: [150, 2, 984, 716] },
    { id: 'port_mech1', name: '竖屏-机械风格1', file: 'romfs:/masks/竖屏-机械风格1.raw', w: 1280, h: 720, cut: [372, 3, 535, 714] },
    { id: 'port_mech2', name: '竖屏-机械风格2', file: 'romfs:/masks/竖屏-机械风格2.raw', w: 1280, h: 720, cut: [372, 3, 535, 714] },
    { id: 'port_mech3', name: '竖屏-机械风格3', file: 'romfs:/masks/竖屏-机械风格3.raw', w: 1280, h: 720, cut: [373, 4, 533, 713] },
    { id: 'port_mech4', name: '竖屏-机械风格4', file: 'romfs:/masks/竖屏-机械风格4.raw', w: 1280, h: 720, cut: [374, 2, 534, 714] }
  ];
  // ---- 玩家自定义遮罩（SD 目录）------------------------------------
  // 目录：sdmc:/switch/j2me-nx/masks/，放 *.png（推荐 1280x720，中间留透明窗）
  // 或 *.raw（1280x720 RGBA 裸数据）。面板每次打开都重扫，新增文件不用重启。
  // 条目由 host/mask-scan.js 的纯逻辑生成（可单测）；读取/解码在这里。
  var MASK_DIR = IS_SWITCH ? 'sdmc:/switch/j2me-nx/masks' : DATA_ROOT + '/masks';
  var sdMasks = [];
  var sdMaskLogged = false;
  function refreshSdMasks() {
    try {
      if (IS_SWITCH && g.Switch && g.Switch.mkdirSync) {
        try { g.Switch.mkdirSync(MASK_DIR); } catch (eMk) { /* 已存在 */ }
      }
      var names = [];
      if (typeof g.Switch === 'object' && g.Switch && g.Switch.readDirSync) {
        names = g.Switch.readDirSync(MASK_DIR) || [];
      } else if (!IS_SWITCH) {
        try { names = require('fs').readdirSync(MASK_DIR); } catch (eRd) { names = []; }
      }
      sdMasks = (typeof g.__maskScan === 'function') ? g.__maskScan(names) : [];
      if (!sdMaskLogged || sdMasks.length) {
        sdMaskLogged = true;
        sdLog('[mask] SD 自定义遮罩 ' + sdMasks.length + ' 张' +
          (sdMasks.length ? '：' + sdMasks.map(function (m) { return m.name; }).join('、') : '') +
          '（目录 ' + MASK_DIR + '）');
        // 扫描结果立即落盘：实机日志曾断在这一行，导致"到底扫到几张"都无从判断
        try { if (typeof __logFlush === 'function') __logFlush(); } catch (eFl) { /* 忽略 */ }
      }
      // 首次运行放一份说明（写失败不影响任何功能）
      // ⚠️ readFileSync 在文件不存在时可能抛异常、也可能返回 null，两种都要兜住：
      // 之前写成 try{read}catch{} + if(!bytes)write，抛异常那条路会直接跳过写盘。
      if (IS_SWITCH && g.Switch && g.Switch.writeFileSync && typeof g.__maskReadme === 'function') {
        var rmBytes = null;
        try { rmBytes = g.Switch.readFileSync(MASK_DIR + '/说明.txt'); } catch (eRm) { rmBytes = null; }
        if (!rmBytes) {
          try {
            g.Switch.writeFileSync(MASK_DIR + '/说明.txt', __utf8(g.__maskReadme()));
            sdLog('[mask] 已写入 ' + MASK_DIR + '/说明.txt');
          } catch (eRmW) { /* 写不了就算了，不影响功能 */ }
        }
      }
    } catch (eScan) {
      sdLog('[mask] SD 遮罩扫描失败: ' + (eScan && eScan.message));
      sdMasks = [];
    }
  }
  function findMaskDef(id) {
    for (var i = 0; i < MASK_DEFS.length; i++) {
      if (MASK_DEFS[i].id === id) return MASK_DEFS[i];
    }
    for (var j = 0; j < sdMasks.length; j++) {
      if (sdMasks[j].id === id) {
        return {
          id: sdMasks[j].id,
          name: sdMasks[j].label,
          file: MASK_DIR + '/' + sdMasks[j].name,
          kind: sdMasks[j].kind,
          rawBytes: sdMasks[j].rawBytes,
          w: 1280, h: 720, cut: null,
        };
      }
    }
    return null;
  }
  // 选择持久化：sdmc:/switch/j2me-nx/mask.json → { mask: <id|'default'> }
  var MASK_FILE = IS_SWITCH
    ? 'sdmc:/switch/j2me-nx/mask.json'
    : DATA_ROOT + '/mask.json';
  function loadMaskSel() {
    try {
      var bytes = readFileSyncLocal(MASK_FILE);
      if (bytes) {
        var text = typeof TextDecoder !== 'undefined'
          ? new TextDecoder().decode(bytes)
          : String(bytes);
        var o = JSON.parse(text) || {};
        if (o.mask && (o.mask === 'default' || findMaskDef(o.mask))) return o.mask;
      }
    } catch (e) { /* 无文件/坏 JSON 用默认 */ }
    return 'default';
  }
  function saveMaskSel() {
    try {
      var text = JSON.stringify({ mask: (g.__maskState && g.__maskState.sel) || 'default' });
      if (IS_SWITCH) {
        if (g.Switch && g.Switch.writeFileSync) g.Switch.writeFileSync(MASK_FILE, __utf8(text));
      } else {
        require('fs').writeFileSync(MASK_FILE, text);
      }
    } catch (e) {
      sdLog('[mask] 选择写盘失败: ' + (e && e.message));
    }
  }
  // 玩家自定义遮罩的**硬上限**（宁可不加载，也不能把运行时顶死）。
  // 实机事故（2026-09-23）：选自定义遮罩后"模拟器直接退出、无报错"——
  // 症状和 perfA~perfI 那批 V8 fatal 一模一样。原因是 PNG 解码链一次要开
  // 4~5 份 w*h*4 缓冲（zdata → inflated → rgba → ImageData → canvas 后备），
  // 1280x720 约 15MB 还扛得住，1920x1080 就是 40~50MB，偏紧档直接 fatal。
  // ⚠️ 上限就定在 1280x720（= 掌机屏物理分辨率）：遮罩本来就是"缩放到整屏铺满"
  // 画的，再大的图对画面**毫无增益**（座机 1080p 也是把小图放大），只是白白多占
  // 内存。所以这不是保守，是"给多大都没用"。超出即在解码前拒绝。
  var MASK_MAX_PX = 1280 * 720;           // 921,600 像素（RGBA 3.7MB/份）
  var MASK_MAX_BYTES = 8 * 1024 * 1024;   // PNG 文件本身 ≤ 8MB
  function maskMemLine() {
    try {
      var m = g.Switch.memoryUsage();
      return ' used=' + (m.usedHeapSize / 1048576).toFixed(1) +
        ' total=' + (m.totalHeapSize / 1048576).toFixed(1) +
        ' avail=' + (m.totalAvailableSize / 1048576).toFixed(1) +
        ' limit=' + (m.heapSizeLimit / 1048576).toFixed(1);
    } catch (e) { return ' (内存读数不可用)'; }
  }
  // 遮罩路径专用日志：**立即落盘**。
  // 为什么要单独一个：sdLog 是攒批 + 400ms 防抖（20 行才强制刷），而"选了遮罩
  // 就崩"这种 fatal 恰好死在 400ms 窗口里 —— 2026-09-23 实机日志就断在
  // "[mask] SD 自定义遮罩 3 张"那一行，后面选遮罩 / 尺寸 / 解码的三行全丢了，
  // 现场等于没有。这里逐条 flush，保证"死前最后一句"一定在卡上。
  function maskLog(line) {
    sdLog('[mask] ' + line);
    try { if (typeof __logFlush === 'function') __logFlush(); } catch (eMF) { /* 忽略 */ }
  }
  // V8 堆水位闸门：偏紧档历史上在堆长到 ~86MB 时"堆增长分配失败"→ 直接 fatal
  // （见 perfA~perfI 的排障记录）。解码一份 PNG 要一次性顶起十几 MB，所以
  // 堆已经很高时**主动放弃加载**，宁可玩家这次看不到自定义遮罩，也别把模拟器带走。
  var MASK_HEAP_GUARD_MB = 88;
  // 造一张离屏画布：Switch 上是 OffscreenCanvas；Node 仿真退到
  // document.createElement('canvas')（stub canvas 提供），这样桌面仿真也能把
  // "读卡 → 体积闸门 → 解码 → ImageData → putImageData"整条链真正跑通。
  function makeMaskCanvas(w, h) {
    if (typeof g.OffscreenCanvas === 'function') return new g.OffscreenCanvas(w, h);
    if (g.document && typeof g.document.createElement === 'function') {
      var c = g.document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    throw new Error('没有可用的画布实现（OffscreenCanvas / document.createElement 都缺）');
  }
  // 选中遮罩画布缓存（只保留当前一张 1280x720 RGBA ≈3.7MB；builtin 由
  // 呈现层的 maskCanvas 承担，不走这里）。软重启会整体重求值 → 自动重载。
  function ensureMaskLoaded(id) {
    if (!id || id === 'default' || id === 'builtin') return;
    var st = g.__maskState;
    if (!st || (st.loaded && st.loaded.id === id) || st.loading === id) return;
    var def = findMaskDef(id);
    if (!def || !def.file) return;
    // PATCH(perfZ11-D)：紧档下跳过 SD 的 PNG 遮罩。
    // 理由：PNG 解码要一次 w*h*4（1280x720=3.7MB）+ zdata/滤波中间态，实测瞬时
    // 30~60MB；紧档（limit 400~700MB）里这正是把 V8 顶死的量级（见 PERF §17）。
    // .raw 只有一份 3.7MB 拷贝，紧档放行。**只改本次会话的内存选择，不写回
    // mask.json** —— 下次正常档启动仍用你自己选的那张。
    if (g.__memTight && def.kind === 'png' && String(id).indexOf('sd:') === 0) {
      st.loading = null;
      maskLog('紧档启动（limit=' + g.__memLimitMB + 'MB）：本次跳过 PNG 遮罩「' + def.name +
        '」，改用默认遮罩（mask.json 未改动，正常档启动会自动恢复）');
      if (st.sel === id) { st.sel = 'default'; st.loaded = null; }
      return;
    }
    st.loading = id;
    maskLog('加载 ' + def.name + '（' + def.file + '）');
    // 读之前先量文件大小（statSync 不分配）：超大文件连"读进来"都不该做
    try {
      if (g.Switch && typeof g.Switch.statSync === 'function') {
        var fst = g.Switch.statSync(def.file);
        if (fst && fst.size > MASK_MAX_BYTES) {
          throw new Error('文件过大 ' + (fst.size / 1048576).toFixed(1) + 'MB（上限 8MB）');
        }
        if (fst && fst.size) maskLog('文件 ' + (fst.size / 1048576).toFixed(2) + 'MB');
      }
    } catch (eSt) {
      if (eSt && /文件过大/.test(eSt.message || '')) {
        st.loading = null;
        maskLog('加载失败 ' + id + ': ' + eSt.message);
        if (st.sel === id && String(id).indexOf('sd:') === 0) {
          st.sel = 'default'; st.loaded = null; saveMaskSel();
          maskLog('已回落到 default');
        }
        return;
      }
      /* stat 不可用/文件不在：交给后面的 readFileBytes 报错 */
    }
    readFileBytes(def.file).then(function (bytes) {
      var mc, w, h;
      if (def.kind === 'png') {
        // ① 体积闸门：先读 IHDR（零大分配），超限直接抛，交由下面的 catch 回落
        var sz = (typeof g.__pngSize === 'function') ? g.__pngSize(bytes) : null;
        if (!sz || !sz.width || !sz.height) throw new Error('不是可识别的 PNG（或头部不完整）');
        w = sz.width; h = sz.height;
        // 逐条落盘：这几行是"崩了就崩了"时唯一的现场
        maskLog('PNG ' + w + 'x' + h + ' bitDepth=' + sz.bitDepth +
          ' colorType=' + sz.colorType + ' interlace=' + sz.interlace +
          ' 文件=' + (bytes.byteLength / 1048576).toFixed(2) + 'MB' + maskMemLine());
        if (w * h > MASK_MAX_PX) {
          throw new Error('尺寸超限 ' + w + 'x' + h + '（上限 1280x720，与掌机屏同尺寸；' +
            '更大的图也会被缩放到整屏，纯占内存）');
        }
        // ② V8 堆水位闸门：已经很满就放弃（见 MASK_HEAP_GUARD_MB 注释）
        try {
          var mu = g.Switch.memoryUsage();
          var heapMB = mu.totalHeapSize / 1048576;
          if (heapMB > MASK_HEAP_GUARD_MB) {
            throw new Error('内存水位偏高（V8 堆 ' + heapMB.toFixed(0) + 'MB > ' +
              MASK_HEAP_GUARD_MB + 'MB），本次不加载自定义遮罩以免模拟器退出；重启后再试');
          }
        } catch (eMu) {
          if (eMu && /内存水位偏高/.test(eMu.message || '')) throw eMu;
          /* 读不到内存就照常尝试 */
        }
        // ③ 解码：仍要 w*h*4 一份，这是纯 JS 解码器绕不开的最小代价
        if (typeof g.__decodePNG !== 'function') throw new Error('png 解码器未加载');
        var png = g.__decodePNG(bytes);
        if (!png || !png.width || !png.height) throw new Error('PNG 解码结果为空');
        w = png.width; h = png.height;
        maskLog('解码完成 ' + w + 'x' + h + maskMemLine());
        // ③ 画布：优先直接构造 ImageData（省掉 createImageData + set 的一整份拷贝）
        mc = makeMaskCanvas(w, h);
        var pctx = mc.getContext('2d');
        var pdata = null;
        try {
          if (typeof g.ImageData === 'function' && png.data && png.data.buffer) {
            pdata = new g.ImageData(
              new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength), w, h);
          }
        } catch (eID) { pdata = null; }
        if (!pdata) {
          pdata = pctx.createImageData(w, h);
          pdata.data.set(png.data);
        }
        pctx.putImageData(pdata, 0, 0);
        pdata = null;   // 尽快放开这一份，别和后面的绘制抢内存
        png = null;
      } else {
        // 内置/兼容格式：严格 1280x720 RGBA 裸数据
        var want = (def.rawBytes || (def.w * def.h * 4));
        if (bytes.byteLength !== want) {
          throw new Error('raw 尺寸不符: ' + bytes.byteLength + '（应为 ' + want + '）');
        }
        w = def.w; h = def.h;
        mc = makeMaskCanvas(w, h);
        var mctx = mc.getContext('2d');
        var imgData = mctx.createImageData(w, h);
        imgData.data.set(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        mctx.putImageData(imgData, 0, 0);
      }
      st.loaded = { id: id, canvas: mc, cut: def.cut, w: w, h: h };
      st.loading = null;
      maskLog('就绪 ' + def.name + '（' + w + 'x' + h + (def.kind === 'png' ? ' PNG' : ' raw') + '）');
    }).catch(function (e) {
      st.loading = null;
      maskLog('加载失败 ' + id + ': ' + (e && e.message));
      maskLog('提示：自定义遮罩请用 1280x720 的 PNG（≤8MB，文件名用英文数字），' +
        '或严格 1280x720 的 .raw');
      // 自定义遮罩坏了不至于让玩家裸黑边：回落内置/默认
      if (st.sel === id && String(id).indexOf('sd:') === 0) {
        st.sel = 'default';
        st.loaded = null;
        saveMaskSel();
        maskLog('已回落到 default（坏文件不会卡住游戏）');
      }
    });
  }
  // 扫描 SD 自定义遮罩要在 loadMaskSel() 之前（否则存档里的 sd: 选择会被判为无效）
  // ⚠️ 时序坑（2026-09-23 桌面仿真抓到）：本文件模块级代码执行时，host 脚本
  // 还躺在 boot() 的异步 eval 链里没跑，g.__maskScan / g.__keyMap **都还不存在**。
  // 所以这里只是一次"尽早尝试"，权威初始化放在 afterHostScripts()（脚本就位后）。
  function initMaskSel() {
    try { refreshSdMasks(); } catch (eMs) { /* 扫描失败保持旧表 */ }
    var sel = loadMaskSel();
    if (!g.__maskState) g.__maskState = { sel: sel, loaded: null, loading: null };
    else if (!g.__maskState.loaded && !g.__maskState.loading) g.__maskState.sel = sel;
    return g.__maskState.sel;
  }
  initMaskSel();

  // ==================================================================
  // 玩家自定义按键映射（文件 sdmc:/switch/j2me-nx/keys.txt）
  // 解析/生成逻辑在 host/switch-input.js（g.__keyMap，纯逻辑可单测）；
  // 这里只负责落盘与开机载入（本文件才有 readFileSyncLocal / __utf8）。
  // 布局：<Switch 物理键名> = <MIDP 目标键名>；详见文件内注释。
  // ==================================================================
  var KEYS_FILE = IS_SWITCH
    ? 'sdmc:/switch/j2me-nx/keys.txt'
    : DATA_ROOT + '/keys.txt';
  function decodeText(bytes) {
    if (!bytes) return '';
    try {
      if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
    } catch (e) { /* 回落 */ }
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  function saveKeyMap(silent) {
    try {
      if (!g.__keyMap) return false;
      var text = g.__keyMap.exportText();
      if (IS_SWITCH) {
        try { if (g.Switch && g.Switch.mkdirSync) g.Switch.mkdirSync('sdmc:/switch/j2me-nx'); } catch (eMk2) { /* 已存在 */ }
        if (g.Switch && g.Switch.writeFileSync) g.Switch.writeFileSync(KEYS_FILE, __utf8(text));
      } else {
        require('fs').writeFileSync(KEYS_FILE, text);
      }
      if (!silent) sdLog('[keymap] 已写入 ' + KEYS_FILE);
      return true;
    } catch (e) {
      sdLog('[keymap] 写盘失败: ' + (e && e.message));
      return false;
    }
  }
  function loadKeyMap() {
    try {
      if (!g.__keyMap) { sdLog('[keymap] 输入层未就绪，跳过'); return; }
      var bytes = readFileSyncLocal(KEYS_FILE);
      if (bytes && bytes.length) {
        var n = g.__keyMap.importText(decodeText(bytes));
        sdLog('[keymap] 载入 ' + KEYS_FILE + '：生效 ' + n + ' 条绑定');
      } else {
        g.__keyMap.reset();
        saveKeyMap(true);
        sdLog('[keymap] 未找到 ' + KEYS_FILE + '，已按默认表生成（可用 Y 菜单 → 按键映射 修改）');
      }
    } catch (e) {
      sdLog('[keymap] 载入失败: ' + (e && e.message));
    }
  }
  g.__saveKeyMap = saveKeyMap;
  g.__loadKeyMap = loadKeyMap;

  // ==================================================================
  // 按键机型（按游戏）—— 2026-09-23 perfR
  //
  // MIDP 只统一数字/方向/确认，**左右软键是厂商自定**：诺基亚 -6/-7、
  // 摩托罗拉 -21/-22（旧机型 -20/22）。同一份游戏要发对机型的 keyCode
  // 才认得出软键，所以按游戏记一份选择。
  //   文件 sdmc:/switch/j2me-nx/keyprofiles.json → { "<jar文件名>": "<机型id>" }
  //   面板：Y 菜单 → 按键机型（改完立即生效，也会在下次启动该游戏时应用）
  // 数值表与切换逻辑在 host/switch-input.js（g.__keyProfiles，可单测）。
  // ==================================================================
  var KEYPROF_FILE = IS_SWITCH
    ? 'sdmc:/switch/j2me-nx/keyprofiles.json'
    : DATA_ROOT + '/keyprofiles.json';
  var keyProfilesByJar = null;
  var keyProfilesRaw = null;   // 文件里的 __profiles 原样保留（写回时不能丢）
  function loadKeyProfiles() {
    if (keyProfilesByJar) return keyProfilesByJar;
    keyProfilesByJar = {};
    try {
      var bytes = readFileSyncLocal(KEYPROF_FILE);
      if (bytes && bytes.length) {
        var o = JSON.parse(decodeText(bytes));
        // ① __profiles：自定义/覆盖机型数值（不用重新出包就能改）
        //    "nokiaLS": { "label": "诺基亚横屏", "softLeft": -6, "softRight": -7,
        //                 "fire": 53, "clear": 8 }
        if (o && o.__profiles && typeof g.__keyProfiles === 'object' && g.__keyProfiles) {
          keyProfilesRaw = o.__profiles;
          for (var pid in o.__profiles) {
            if (!Object.prototype.hasOwnProperty.call(o.__profiles, pid)) continue;
            var d = o.__profiles[pid] || {};
            try {
              g.__keyProfiles.define(pid, d.label || pid, {
                softLeft: d.softLeft, softRight: d.softRight,
                fire: d.fire, clear: d.clear,
                digits: d.digits,   // 可选：数字键 → 机型字符码表
              });
              sdLog('[profile] 自定义机型 ' + pid + '：左' + d.softLeft + ' 右' + d.softRight +
                ' 确认' + d.fire);
            } catch (eDf) { sdLog('[profile] 自定义机型 ' + pid + ' 失败: ' + (eDf && eDf.message)); }
          }
        }
        // ② 其余键：jar 文件名 → 机型 id
        for (var k in o) {
          if (k === '__profiles') continue;
          if (Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] === 'string') {
            keyProfilesByJar[k] = o[k];
          }
        }
        sdLog('[profile] 载入 ' + KEYPROF_FILE + '：' + Object.keys(keyProfilesByJar).length + ' 个游戏已指定机型');
      }
    } catch (e) {
      sdLog('[profile] 载入失败（按默认机型走）: ' + (e && e.message));
      keyProfilesByJar = {};
    }
    return keyProfilesByJar;
  }
  function saveKeyProfiles() {
    try {
      // ⚠️ 必须把 __profiles（自定义机型数值）原样写回，否则玩家手改的机型
      // 会在第一次在面板里改游戏机型时被覆盖掉。
      var out = {};
      if (keyProfilesRaw && typeof keyProfilesRaw === 'object') out.__profiles = keyProfilesRaw;
      var m = keyProfilesByJar || {};
      for (var k in m) {
        if (Object.prototype.hasOwnProperty.call(m, k)) out[k] = m[k];
      }
      var text = JSON.stringify(out, null, 1);
      if (IS_SWITCH) {
        try { if (g.Switch && g.Switch.mkdirSync) g.Switch.mkdirSync('sdmc:/switch/j2me-nx'); } catch (eMk) { /* 已存在 */ }
        if (g.Switch && g.Switch.writeFileSync) g.Switch.writeFileSync(KEYPROF_FILE, __utf8(text));
      } else {
        require('fs').writeFileSync(KEYPROF_FILE, text);
      }
      return true;
    } catch (e) {
      sdLog('[profile] 写盘失败: ' + (e && e.message));
      return false;
    }
  }
  // 某个游戏该用哪个机型（没记过 = 默认诺基亚）
  function profileForJar(jar) {
    var m = loadKeyProfiles();
    return (jar && m[jar]) ? m[jar] : 'nokia';
  }
  // 应用到输入层（游戏启动前调用；立刻影响之后发出的软键码）
  function applyProfileForJar(jar) {
    var id = profileForJar(jar);
    var ok = (typeof g.__setKeyProfile === 'function') ? g.__setKeyProfile(id) : false;
    sdLog('[profile] ' + (jar || '(未选游戏)') + ' → 按键机型 ' + id +
      (ok ? '' : '（输入层未就绪或未知机型，按默认走）'));
    return id;
  }

  // ==================================================================
  // 游戏内文本输入：自动弹出系统键盘（2026-09-23）
  //
  // 链路（两端都在 vendor 里挂了钩子）：
  //   ① 触发：gfx.js 的 TextFieldLFImpl.createNativeResource0 被 Java 调用时
  //      回调 g.__hostTextInput()（LCDUI 里 TextBox = Form+TextField，
  //      所以 TextBox 与 Form 里的 TextField 都会走到这里）。
  //   ② 注入：宿主弹出 Switch 系统键盘（navigator.virtualKeyboard，和"改名"同一套），
  //      玩家输完按确定 → g.__sendInputMethodText(text)（midp.js）→ 以
  //      "输入法事件"（intParam1=4）进 MIDP → 当前焦点文本框收到文字。
  //      ⚠️ 不能用按键事件送字：LCDUI 的 handleKeyEvent 只有 (eventType, keyCode)，
  //      没有字符槽位（见 classes.jar 里 DisplayEventListener 的反汇编）。
  // 细节：取消后冷却 30s，免得同一个框反复弹；键盘显示期间不再响应新的触发。
  // ==================================================================
  // 内置软键盘字表（古风，2026-09-23 用户指定；不弹系统键盘，避免遮挡游戏画面）
  // 左栏：英文 A–Z（4 行）+ 退格/空格；右栏：10 行 × 4 列 = 20 古风姓 + 20 古风名用字。
  var KB_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  var KB_SURNAMES = '萧叶苏顾楚谢沈江陆白云墨温秦柳宋傅裴姜卫'.split('');
  var KB_GIVEN = '煜宸澈霄渊澜璃绯瑾瑜珩瑶芷竹鸾凰昭晏清寒'.split('');
  function kbGrid() {
    var rows = [];
    for (var i = 0; i < 10; i++) {
      rows.push([KB_SURNAMES[i * 2] || '', KB_SURNAMES[i * 2 + 1] || '',
        KB_GIVEN[i * 2] || '', KB_GIVEN[i * 2 + 1] || '']);
    }
    return rows;
  }

  var textInputActive = false;
  var textInputCoolUntil = 0;
  var textInputVK = null;
  var textInputHandlers = null;

  function injectTextToMidlet(text) {
    try {
      if (typeof g.__sendInputMethodText !== 'function') {
        sdLog('[textinput] __sendInputMethodText 不可用（旧运行时？）');
        return false;
      }
      g.__sendInputMethodText(text);
      sdLog('[textinput] 已注入文本：' + String(text).length + ' 字');
      return true;
    } catch (e) {
      sdLog('[textinput] 注入失败: ' + (e && e.message));
      return false;
    }
  }

  function closeTextKeyboard(reason) {
    var vk = textInputVK;
    try { if (vk && typeof vk.hide === 'function') vk.hide(); } catch (eH) { /* 忽略 */ }
    if (textInputHandlers && vk) {
      try { vk.removeEventListener('submit', textInputHandlers.onSubmit); } catch (e1) { /* 忽略 */ }
      try { vk.removeEventListener('cancel', textInputHandlers.onCancel); } catch (e2) { /* 忽略 */ }
    }
    textInputHandlers = null;
    textInputVK = null;
    textInputActive = false;
    sdLog('[textinput] 键盘关闭（' + reason + '）');
  }

  function openTextKeyboard(info) {
    var vk = null;
    try {
      vk = (g.navigator && g.navigator.virtualKeyboard) ? g.navigator.virtualKeyboard : null;
    } catch (eVk) { vk = null; }
    if (!vk || typeof vk.show !== 'function') {
      sdLog('[textinput] 系统键盘不可用（游戏内打字需要真机 nx.js 的 virtualKeyboard）');
      return;
    }
    textInputVK = vk;
    textInputActive = true;
    try {
      vk.type = 8;              // SwkbdType.All：可切中文
      vk.okButtonText = '确定';
      vk.maxLength = 32;
      vk.enableDictionary = true;
      vk.enableReturn = false;
      vk.value = '';
      try { vk.cursorIndex = 0; } catch (eCi) { /* 属性不支持则忽略 */ }
    } catch (eCfg) { /* 属性不支持就按默认来 */ }
    var onSubmit = function () {
      var text = '';
      try { text = String(vk.value || ''); } catch (eV) { /* 忽略 */ }
      closeTextKeyboard('确定');
      if (text) injectTextToMidlet(text);
    };
    var onCancel = function () {
      textInputCoolUntil = Date.now() + 30000;   // 30s 内不再自动弹（玩家明显不想打字）
      closeTextKeyboard('取消，冷却 30s');
    };
    textInputHandlers = { onSubmit: onSubmit, onCancel: onCancel };
    try {
      vk.addEventListener('submit', onSubmit);
      vk.addEventListener('cancel', onCancel);
      vk.show();
      sdLog('[textinput] 已弹出系统键盘（nativeId=' + (info && info.nativeId) + '）');
    } catch (eShow) {
      sdLog('[textinput] 弹出失败: ' + (eShow && eShow.message));
      closeTextKeyboard('弹出失败');
    }
  }

  // gfx.js 的回调入口
  function hostTextInput(info) {
    try {
      var id = info && info.nativeId;
      var cons = info && info.constraints;
      sdLog('[textinput] 检测到文本框 nativeId=' + id + ' constraints=' + cons);
      if (!g.__gameRunning) { sdLog('[textinput] 不在游戏内，忽略'); return; }
      if (textInputActive) { sdLog('[textinput] 键盘已显示，忽略'); return; }
      if (Date.now() < textInputCoolUntil) { sdLog('[textinput] 取消冷却中，忽略'); return; }
      // 仅 Node 仿真的自动注入钩子：直接把 J2ME_TEST_TEXT 送进去，端到端验证用
      if (IS_NODE && typeof process !== 'undefined' && process.env && process.env.J2ME_TEST_TEXT) {
        var t = process.env.J2ME_TEST_TEXT;
        g.__noGen.setTimeout(function () { injectTextToMidlet(t); }, 800);
        sdLog('[textinput] (仿真) 将自动注入 ' + t);
        return;
      }
      openKbOverlay(info);
    } catch (e) {
      sdLog('[textinput] 处理失败: ' + (e && e.message));
    }
  }
  // ==================================================================
  // 内置软键盘（古风字表）—— 2026-09-23
  // 为什么不用系统键盘：Switch 系统键盘会盖住整屏，把游戏画面挡了（用户反馈）。
  // 现在改成宿主自绘的小键盘：左右两栏贴边、中间留出游戏画面，
  // 触屏点选（nx.js 有 touchstart/touchmove/touchend），右下角贴右边缘 [确定][关闭]。
  // 输出仍走同一条注入链路（__sendInputMethodText → TextBox / Form 里的 TextField）。
  // ==================================================================
  var kbState = null;      // { active, buf, cells:[], touchY }
  var kbTouchBound = false;

  function kbCells(sw, sh) {
    // 返回全部可点格子（含 确定/关闭/退格/空格），供绘制与命中测试共用
    var cells = [];
    var pad = 10, cw = 62, chh = 52, x0 = pad, y0 = pad;
    // 左栏：英文 4 行（7/7/6/6）
    var idx = 0, perRow = 7, rows = 4;
    for (var r = 0; r < rows; r++) {
      var n = (r === 3) ? 5 : perRow;   // 最后一行留出退格/空格
      for (var c = 0; c < n && idx < KB_LETTERS.length; c++, idx++) {
        cells.push({ kind: 'ch', ch: KB_LETTERS[idx], x: x0 + c * cw, y: y0 + r * chh, w: cw - 4, h: chh - 4 });
      }
    }
    cells.push({ kind: 'back', label: '←退格', x: x0, y: y0 + 3 * chh, w: cw * 2 - 4, h: chh - 4 });
    cells.push({ kind: 'space', label: '空格', x: x0 + cw * 2, y: y0 + 3 * chh, w: cw * 3 - 4, h: chh - 4 });
    // 右栏：10 行 × 4 列（左两列姓、右两列名），贴右边缘
    var grid = kbGrid();
    var rw = 64, rhh = 48;
    var rx = sw - pad - rw * 4;
    for (var gr = 0; gr < grid.length; gr++) {
      for (var gc = 0; gc < 4; gc++) {
        var ch = grid[gr][gc];
        if (!ch) continue;
        cells.push({ kind: 'ch', ch: ch, x: rx + gc * rw, y: pad + gr * rhh, w: rw - 4, h: rhh - 4 });
      }
    }
    // 右下角贴右边缘：确定 / 关闭
    var bh = 56, by = sh - pad - bh;
    cells.push({ kind: 'ok', label: '确定', x: sw - pad - 190, y: by, w: 90, h: bh });
    cells.push({ kind: 'close', label: '关闭', x: sw - pad - 95, y: by, w: 95, h: bh });
    return cells;
  }

  function kbHit(cells, x, y) {
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return c;
    }
    return null;
  }

  function kbPress(cell) {
    if (!cell || !kbState) return;
    if (cell.kind === 'ch') {
      if (kbState.buf.length < 32) kbState.buf += cell.ch;
    } else if (cell.kind === 'space') {
      if (kbState.buf.length < 32) kbState.buf += ' ';
    } else if (cell.kind === 'back') {
      kbState.buf = kbState.buf.slice(0, -1);
    } else if (cell.kind === 'ok') {
      var t = kbState.buf;
      kbClose('确定');
      if (t) injectTextToMidlet(t);
      return;
    } else if (cell.kind === 'close') {
      kbClose('关闭');
      return;
    }
    if (typeof g.__kbDirty === 'function') g.__kbDirty();
  }

  function kbClose(reason) {
    kbState = null;
    textInputActive = false;
    if (reason === '关闭') textInputCoolUntil = Date.now() + 30000;   // 关掉就冷却，别反复冒
    sdLog('[kb] 内置键盘关闭（' + reason + '）');
  }

  function kbTouchHandler(ev) {
    if (!kbState || !kbState.active) return;
    var t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]);
    if (!t) return;
    var x = t.clientX || t.pageX || t.x || 0;
    var y = t.clientY || t.pageY || t.y || 0;
    if (ev.type === 'touchstart' || ev.type === 'touchmove') {
      var c = kbHit(kbState.cells, x, y);
      kbState.hoverKey = c ? (c.kind + ':' + (c.ch || c.label)) : '';
      if (ev.type === 'touchstart' && c) kbPress(c);
    }
    try { ev.preventDefault(); } catch (e) { /* 忽略 */ }
  }

  function openKbOverlay(info) {
    var sw = 1280, sh = 720;
    try {
      var c = g.MIDP && g.MIDP.deviceContext && g.MIDP.deviceContext.canvas;
      if (c && c.width) { sw = c.width; sh = c.height; }
    } catch (eS) { /* 用默认 */ }
    kbState = { active: true, buf: '', cells: null, hoverKey: '', sel: 0 };   // 布局在绘制时按物理屏算
    // 兜底：玩家若点不中（触摸坐标不对/摸不到屏），90 秒无操作自动关闭，
    // 免得又要"关不掉"。手柄导航下一轮补，这里先保证一定能退出。
    try {
      if (kbState.timer) g.clearTimeout(kbState.timer);
      kbState.timer = g.setTimeout(function () {
        if (kbState && kbState.active) { sdLog('[kb] 90 秒无操作，自动关闭'); kbClose('超时'); }
      }, 90000);
    } catch (eT) { /* 无定时器则忽略 */ }
    textInputActive = true;
    if (!kbTouchBound) {
      kbTouchBound = true;
      // ⚠️ 上一版只绑了 document.getElementById('canvas')（拿不到就退回 globalThis），
      // 实机点了没反应 —— nx.js 的触摸目标不一定是那个元素。现在所有可能目标都绑，
      // 且前 3 次触摸打日志（[kb] touch …），下次看日志就能判定目标与坐标系。
      var targets = [];
      try { if (g) targets.push(g); } catch (e0) { /* 忽略 */ }
      try { if (g && g.document) targets.push(g.document); } catch (e1) { /* 忽略 */ }
      try {
        if (g && g.document && g.document.getElementsByTagName) {
          var cs = g.document.getElementsByTagName('canvas') || [];
          for (var ci = 0; ci < cs.length; ci++) targets.push(cs[ci]);
        }
      } catch (e2) { /* 忽略 */ }
      var seen = 0;
      var wrap = function (ev) {
        if (seen < 3) {
          seen++;
          var t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || {};
          sdLog('[kb] touch ' + ev.type + ' x=' + (t.clientX || t.pageX || t.x || '?') +
            ' y=' + (t.clientY || t.pageY || t.y || '?'));
        }
        kbTouchHandler(ev);
      };
      for (var ti = 0; ti < targets.length; ti++) {
        try { targets[ti].addEventListener('touchstart', wrap, { passive: false }); } catch (e3) { /* 忽略 */ }
        try { targets[ti].addEventListener('touchmove', wrap, { passive: false }); } catch (e4) { /* 忽略 */ }
      }
      sdLog('[kb] 触摸监听绑定到 ' + targets.length + ' 个目标');
    }
    sdLog('[kb] 内置键盘打开（nativeId=' + (info && info.nativeId) + '，左侧英文 / 右侧 10x4 古风字表）');
  }

  function kbLayout(ctx, sw, sh) {
    // ⚠️ 必须用**物理屏**尺寸（present 传进来的 sw/sh），不能用 MIDP.deviceContext.canvas
    //（那是虚拟屏 240x320）——上一版用错空间，导致汉字列 x 为负被挤到左边、
    // 英文掉到下面、确定/关闭叠在上层，触摸命中也在错的空间里（点不中）。
    // 文本宽度在这里算一次缓存到格子上：每帧 40+ 次 measureText 会把 Switch
    // 帧率打没（表现就是"游戏卡死"）。
    var cells = [];
    var pad = 10, cw = 74, chh = 56, x0 = pad, y0 = pad;
    var idx = 0;
    for (var r = 0; r < 4; r++) {
      var n = (r === 3) ? 5 : 7;
      for (var c = 0; c < n && idx < KB_LETTERS.length; c++, idx++) {
        cells.push({ kind: 'ch', ch: KB_LETTERS[idx], x: x0 + c * cw, y: y0 + r * chh, w: cw - 6, h: chh - 6 });
      }
    }
    cells.push({ kind: 'back', label: T('←退格'), x: x0, y: y0 + 3 * chh, w: cw * 2 - 6, h: chh - 6 });
    cells.push({ kind: 'space', label: T('空格'), x: x0 + cw * 2, y: y0 + 3 * chh, w: cw * 3 - 6, h: chh - 6 });
    var grid = kbGrid();
    var rw = 76, rhh = 52;
    var rx = Math.max(pad, sw - pad - rw * 4);
    for (var gr = 0; gr < grid.length; gr++) {
      for (var gc = 0; gc < 4; gc++) {
        var ch = grid[gr][gc];
        if (!ch) continue;
        cells.push({ kind: 'ch', ch: ch, x: rx + gc * rw, y: y0 + gr * rhh, w: rw - 6, h: rhh - 6 });
      }
    }
    var bh = 60, by = sh - pad - bh;
    // PATCH(perfZ21)：标签在这里就翻好 —— 下面的 tw（居中用宽度）是按 label 量的，
    // 若留到绘制时才翻译，居中会按中文宽度算、英文标签会偏。
    // 切语言后由 applyLang() 置空 laidOutFor 让这份缓存失效。
    cells.push({ kind: 'ok', label: T('确定'), x: sw - pad - 200, y: by, w: 95, h: bh });
    cells.push({ kind: 'close', label: T('关闭'), x: sw - pad - 100, y: by, w: 95, h: bh });
    for (var i = 0; i < cells.length; i++) {
      var t = cells[i].kind === 'ch' ? cells[i].ch : (cells[i].label || '');
      var fs = cells[i].kind === 'ch' ? (cells[i].h > 50 ? 28 : 24) : 20;
      ctx.font = fs + 'px "j2mecjk", monospace';
      var tw = 0;
      try { tw = ctx.measureText(t).width; } catch (eM) { tw = t.length * fs * 0.6; }
      cells[i].tw = tw;
      cells[i].fs = fs;
    }
    kbState.cells = cells;
    kbState.laidOutFor = sw + 'x' + sh;
  }

  function drawKbOverlay(ctx, sw, sh) {
    try {
      if (!kbState || !kbState.active) return;
      if (!kbState.cells || kbState.laidOutFor !== (sw + 'x' + sh)) kbLayout(ctx, sw, sh);
      var cells = kbState.cells;
      for (var i = 0; i < cells.length; i++) {
        var c = cells[i];
        var label = c.kind === 'ch' ? c.ch : (c.label || '');
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = (c.kind === 'ok') ? '#1c5f2a' : ((c.kind === 'close') ? '#5f1c1c' : '#101822');
        ctx.fillRect(c.x, c.y, c.w, c.h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#3a6ea8';
        ctx.strokeRect(c.x, c.y, c.w, c.h);
        if (kbState.sel === i) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#ffd479';
          ctx.lineWidth = 4;
          ctx.strokeRect(c.x + 2, c.y + 2, c.w - 4, c.h - 4);
          ctx.lineWidth = 1;
        }
        ctx.fillStyle = '#ffffff';
        ctx.font = c.fs + 'px "j2mecjk", monospace';
        ctx.fillText(label, c.x + (c.w - c.tw) / 2, c.y + c.h / 2 + c.fs * 0.36);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.78)';
      ctx.fillRect(sw * 0.30, sh - 74, sw * 0.40, 48);
      ctx.fillStyle = '#ffd479';
      ctx.font = '26px "j2mecjk", monospace';
      ctx.fillText(T('已输入：{1}', kbState.buf || ''), sw * 0.31, sh - 40);
    } catch (e) { /* 绘制失败不影响游戏 */ }
  }

  // ---- 手柄导航内置键盘（switch-input 在键盘激活时把按键边沿交到这里）----
  // 设计：不依赖触摸。摇杆/十字移高亮，A=确认（输入/确定），B=退格，+=关闭。
  function kbMove(dir) {
    if (!kbState || !kbState.active) return;
    var cells = kbState.cells || [];
    if (!cells.length) return;
    if (kbState.sel === undefined || kbState.sel === null) { kbState.sel = 0; return; }
    var cur = cells[kbState.sel] || cells[0];
    var best = -1, bestD = 1e9;
    for (var i = 0; i < cells.length; i++) {
      if (i === kbState.sel) continue;
      var c = cells[i];
      var dx = (c.x + c.w / 2) - (cur.x + cur.w / 2);
      var dy = (c.y + c.h / 2) - (cur.y + cur.h / 2);
      var okDir = (dir === 'left') ? (dx < -8) : (dir === 'right') ? (dx > 8) : (dir === 'up') ? (dy < -8) : (dy > 8);
      if (!okDir) continue;
      var d = Math.abs(dx) + Math.abs(dy) +
        (((dir === 'left') || (dir === 'right')) ? Math.abs(dy) * 3 : Math.abs(dx) * 3);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) kbState.sel = best;
  }

  g.__kbOverlayActive = function () { return !!(kbState && kbState.active); };
  g.__kbOverlayKey = function (idx, down) {
    if (!down || !kbState || !kbState.active) return true;
    if (idx === 12) { kbMove('up'); return true; }
    if (idx === 13) { kbMove('down'); return true; }
    if (idx === 14) { kbMove('left'); return true; }
    if (idx === 15) { kbMove('right'); return true; }
    if (idx === 9) { kbClose('关闭'); return true; }          // + 键 = 关闭
    var cells = kbState.cells || [];
    var cur = cells[kbState.sel || 0];
    if (idx === 0) {                                           // B = 退格
      if (kbState.buf) kbState.buf = kbState.buf.slice(0, -1);
      return true;
    }
    if (idx === 1 || idx === 6 || idx === 7) {                 // A / ZL / ZR = 确认当前格
      if (cur) kbPress(cur);
      return true;
    }
    return true;
  };

  g.__hostTextInput = hostTextInput;

  // ==================================================================
  // 屏显文字中/英切换（2026-09-23 perfZ21）
  //
  // 字典与查表在 host/ui-lang.js（g.__uiLang，纯逻辑、可 Node 单测）；这里只做三件事：
  //   ① T() —— 调用点包装：未命中字典/异常一律返回原文，绝不吐 undefined；
  //   ② lang.json 读/写（本文件才有 readFileSyncLocal / __utf8 / Switch|Node 双路径）；
  //   ③ 主列表右上角双语提示 + ZR+ZL 弹窗（在 runGameMenu 里）。
  //
  // ⚠ 为什么不用"给 canvas.fillText 挂钩子"这种一行搞定的方案：
  //   游戏自己的渲染（J2ME drawString）画在**同一条画布**上，而中文 J2ME 游戏
  //   里"确定/返回/退出"满地都是 —— 全局挂钩子会把游戏内部文字也换掉（字库、
  //   排版、命中判定全乱）。所以只在**我们自己的**屏显字符串上包 T()。
  //
  // ⚠ 日志不翻译：sdLog/maskLog/console 全部保持中文（用户明确"日志不用"；
  //   日志是排障凭据，翻译后历史记录对不上，也会让 PERF 记录里的行号对不上）。
  // ==================================================================
  var LANG_FILE = IS_SWITCH
    ? 'sdmc:/switch/j2me-nx/lang.json'
    : DATA_ROOT + '/lang.json';
  // 兜底落点：主路径写失败时再试一次（`/switch` 根目录一定存在）。
  // 2026-09-24 用户实测反馈"选完英文，下次打开还是中文"——落盘/载入这条链
  // 之前是**只写不校验**（写失败也照样提示"已写入"），现在写完全部回读校验，
  // 并把结果如实告诉玩家 + 记日志。
  var LANG_FILE_FALLBACK = IS_SWITCH ? 'sdmc:/switch/j2me-lang.json'
                                     : DATA_ROOT + '/lang-fallback.json';
  var langLastSave = { ok: true, path: null, why: '' };
  // Node 仿真：测试用 J2ME_TEST_LANG_FILE 指到临时目录 —— 否则 i18n 端到端测试
  // 会在 data/lang.json 留下 lang=en，后面的测试断言的是**中文**菜单文字（"第 N/M 页"），
  // 会被上一次跑剩下的语言设置连累（这类"污染下一个测试"的坑本仓库踩过多次）。
  if (!IS_SWITCH && typeof process !== 'undefined' && process.env &&
      process.env.J2ME_TEST_LANG_FILE) {
    LANG_FILE = process.env.J2ME_TEST_LANG_FILE;
  }

  function T(s, a1, a2, a3, a4) {
    var ui = g.__uiLang;
    if (!ui || typeof ui.t !== 'function') return s;
    try { return ui.t(s, a1, a2, a3, a4); } catch (e) { return s; }
  }
  // 双语字面量：**只给语言弹窗用**（2026-09-24 用户实测反馈：把语言设成英文的
  // 那个提示框里全是中文，英文使用者看不懂 —— 这正是"要换语言的人"最容易卡住的地方，
  // 所以它必须在两种语言下都可读）。其余屏显文字一律走 T() 单语言。
  function TB(zh, en) { return zh + '  /  ' + en; }
  function langNow() {
    try { return (g.__uiLang && g.__uiLang.lang === 'en') ? 'en' : 'zh'; } catch (e) { return 'zh'; }
  }
  // 落盘：{ "lang": "en" }。**写完必须回读校验**——用户实测"选完英文下次还是中文"
  // 就是因为这条链以前只写不验：写失败也照样提示"已写入"。
  // 返回 true/false，并把 diagnostics 记进 langLastSave（弹窗据此给出**如实**的提示）。
  function saveLangTo(path, text) {
    try {
      if (IS_SWITCH) {
        try {
          if (g.Switch && g.Switch.mkdirSync) g.Switch.mkdirSync('sdmc:/switch/j2me-nx');
        } catch (eMk) { /* 目录已存在 */ }
        if (!g.Switch || !g.Switch.writeFileSync) return 'Switch.writeFileSync 不可用';
        g.Switch.writeFileSync(path, __utf8(text));
      } else {
        require('fs').writeFileSync(path, text);
      }
    } catch (eW) {
      return '写入抛错: ' + (eW && eW.message);
    }
    // 回读校验：内容必须一致（忽略尾部空白差异）
    try {
      var back = readFileSyncLocal(path);
      if (!back) return '回读为空（写入未生效）';
      var have = decodeText(back).replace(/\s+$/, '');
      var want = text.replace(/\s+$/, '');
      if (have !== want) return '回读不一致: "' + String(have).slice(0, 32) + '"';
      return null;   // null = 成功
    } catch (eR) {
      return '回读抛错: ' + (eR && eR.message);
    }
  }
  function saveLang(lang) {
    var want = (lang === 'en') ? 'en' : 'zh';
    var text = JSON.stringify({ lang: want }) + '\n';
    var why = saveLangTo(LANG_FILE, text);
    var path = LANG_FILE;
    if (why) {
      sdLog('[ui-lang] 主路径写盘失败（' + why + '），改用兜底路径 ' + LANG_FILE_FALLBACK);
      var why2 = saveLangTo(LANG_FILE_FALLBACK, text);
      if (why2) {
        langLastSave = { ok: false, path: null, why: why + ' / 兜底: ' + why2 };
        sdLog('[ui-lang] 语言写盘失败: ' + langLastSave.why +
          '（本次有效，重启会回到上次的语言）');
        return false;
      }
      path = LANG_FILE_FALLBACK;
    }
    langLastSave = { ok: true, path: path, why: '' };
    sdLog('[ui-lang] 语言写入+校验 ok → ' + path + ' 内容=' + text.replace(/\n$/, ''));
    return true;
  }
  // 载入：文件不存在 = 默认中文（首次运行不会生成文件，只有玩家真的切过才落盘）。
  // 损坏的 json 也按中文走 —— 宁可中文，也不要因为一个坏文件把界面变成看不懂的英文。
  function loadLang() {
    if (!g.__uiLang || typeof g.__uiLang.set !== 'function') return 'zh';
    if (typeof g.__uiLang.onChange !== 'function') {
      g.__uiLang.onChange = function (lang) { saveLang(lang); };
    }
    var lang = 'zh';
    var hit = null, raw = '';
    var paths = [LANG_FILE, LANG_FILE_FALLBACK];
    for (var pi = 0; pi < paths.length && !hit; pi++) {
      var bytes = readFileSyncLocal(paths[pi]);
      if (bytes && bytes.length) { hit = paths[pi]; raw = decodeText(bytes); }
    }
    if (hit) {
      try {
        var obj = JSON.parse(raw);
        var v = String((obj && obj.lang) || '').toLowerCase();
        lang = (v === 'en' || v === 'english' || v === 'en-us') ? 'en' : 'zh';
      } catch (eJ) {
        sdLog('[ui-lang] lang.json 解析失败，按中文走: ' + (eJ && eJ.message));
        lang = 'zh';
      }
    }
    g.__uiLang.set(lang, true);   // silent：载入不写回盘（软重启每次都读，别把盘写烂）
    // 把**读到什么**一并打出来：以后"语言没固化"这类问题，看日志一眼就能定位
    // 是"文件不在"、"内容是旧值"还是"读成功但没生效"。
    sdLog('[ui-lang] 语言=' + lang + '（' + (hit ? hit + ' 内容="' + String(raw).replace(/\s+$/, '') + '"'
      : '两个候选路径都没有文件: ' + paths.join(' , ')) + '）');
    return lang;
  }

  // host 脚本（switch-input.js / mask-scan.js）eval 完之后才能做的初始化。
  // 调用点只有一处：startSession() 里 boot() 的 .then，紧跟 __installSwitchInput()。
  // 放模块级调用是错的——那时 eval 链还没开始跑，只会打出"输入层未就绪，跳过"，
  // 玩家的 keys.txt 就等于没生效（2026-09-23 桌面仿真 bld\sim-perfM.txt 抓到）。
  function afterHostScripts() {
    // 语言先于一切 UI：菜单/错误页的任何一次绘制都要用对语言（也顺手装 onChange）
    try { loadLang(); } catch (eLang) { sdLog('[ui-lang] 载入失败: ' + (eLang && eLang.message)); }
    var sel = initMaskSel();   // 重扫 SD 遮罩（此时 g.__maskScan 才存在）
    sdLog('[mask] 启动初始化：选择=' + sel + '，SD 遮罩 ' + sdMasks.length + ' 张');
    loadKeyMap();              // 载入 keys.txt（此时 g.__keyMap 才存在）
    // 仅 Node 仿真的钩子：把选择的遮罩指定成某个 SD 条目，用来端到端验证
    // "SD 扫描 → readFileBytes → 体积闸门 → 解码 → 画布"整条链
    //（实机读不到 process.env，永远不会走这里）。
    //   例：J2ME_TEST_MASK='sd:big.png' node tools/simulate.mjs
    if (IS_NODE && typeof process !== 'undefined' && process.env && process.env.J2ME_TEST_MASK) {
      g.__maskState.sel = process.env.J2ME_TEST_MASK;
      sdLog('[mask] (仿真) 强制选择 ' + g.__maskState.sel);
      ensureMaskLoaded(g.__maskState.sel);
    }
  }

  // 游戏显示名表（菜单 Y 键 → 改名）：TSV 每行 `jar文件名<TAB>显示名`。
  // 只改显示名不动文件名——存档路径按 jar 文件名索引，改名文件会丢档。
  var NAMES_FILE = IS_SWITCH
    ? 'sdmc:/switch/j2me-nx/names.txt'
    : DATA_ROOT + '/names.txt';
  var gameNames = null;
  function loadGameNames() {
    if (gameNames) return gameNames;
    gameNames = {};
    try {
      var bytes = readFileSyncLocal(NAMES_FILE);
      if (bytes) {
        var text = typeof TextDecoder !== 'undefined'
          ? new TextDecoder().decode(bytes)
          : String(bytes);
        var lines = text.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
          var ln = lines[i];
          if (!ln || ln.charAt(0) === '#') continue;
          var tb = ln.indexOf('\t');
          if (tb <= 0) continue;
          var fn = ln.slice(0, tb).trim();
          var nm = ln.slice(tb + 1).trim();
          // 旧版 TextEncoder 截断 bug 留下的残行（含 U+FFFD）直接丢弃，回退 manifest 名
          if (fn && nm && nm.indexOf('\ufffd') === -1) gameNames[fn] = nm;
        }
      }
    } catch (e) { /* 无文件/坏行用空表 */ }
    return gameNames;
  }
  function saveGameNames() {
    try {
      var out = ['# j2me-nx-port 游戏显示名表：文件名<TAB>显示名（UTF-8）'];
      var m = gameNames || {};
      for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k) && m[k]) {
        out.push(k + '\t' + m[k]);
      }
      var text = out.join('\n') + '\n';
      if (IS_SWITCH) {
        if (g.Switch && g.Switch.writeFileSync) g.Switch.writeFileSync(NAMES_FILE, __utf8(text));
      } else {
        require('fs').writeFileSync(NAMES_FILE, text);
      }
    } catch (e) {
      sdLog('[names] 写盘失败: ' + (e && e.message));
    }
  }

  // ==================================================================
  // 0.5 崩溃日志与致命错误显示（实机排障：真机 console 不可见）
  // ==================================================================

  var LOG_PATH = IS_SWITCH ? 'sdmc:/switch/j2me-nx/error.log'
                           : DATA_ROOT + '/error.log';
  var LOG_FALLBACK = 'sdmc:/switch/j2me-error.log'; // 主目录建不出时的兜底（/switch 必存在）

  // 日志缓冲：攒批 + 防抖写卡（借鉴 mv2switch：逐条写卡太慢会拖垮启动）
  var __logBuf = [];
  var __logTimer = null;
  var __logPath = null;   // 实际使用的日志路径（首次 flush 后锁定）
  var __logFirst = true;  // 首次 flush 时写本次开机分隔行（日志跨运行追加不清空）

  function __logFlush() {
    __logTimer = null;
    if (!__logBuf.length) return;
    var batch = __logBuf.join('\n') + '\n';
    __logBuf.length = 0;
    if (!IS_SWITCH || !g.Switch || !g.Switch.appendFileSync) return;
    try {
      if (!__logPath) {
        try { g.Switch.mkdirSync('sdmc:/switch/j2me-nx'); } catch (e) { /* 已存在 */ }
        __logPath = LOG_PATH;
      }
      try {
        if (__logFirst) {
          __logFirst = false;
          // 轮转：上一次日志超 6MB 就挪到 error.old.log（留最近两轮的现场，
          // 防止批量测一百多个游戏后日志无限膨胀、写卡变慢）
          try {
            if (typeof g.Switch.statSync === 'function') {
              var st = g.Switch.statSync(__logPath);
              if (st && st.size > 6 * 1024 * 1024 &&
                  typeof g.Switch.renameSync === 'function') {
                g.Switch.renameSync(__logPath, __logPath + '.old');
              }
            }
          } catch (eR) { /* stat/rename 失败不影响追加 */ }
          g.Switch.appendFileSync(__logPath, __utf8(
            '==== j2me-nx-port 开机 ' + new Date().toISOString() + ' ====\n' + batch));
        } else {
          g.Switch.appendFileSync(__logPath, __utf8(batch));
        }
      } catch (e) {
        // 主路径失败（目录建不出/只读）→ 兜底写到 switch 根目录（必存在）
        if (__logPath !== LOG_FALLBACK) {
          __logPath = LOG_FALLBACK;
          g.Switch.appendFileSync(__logPath, __utf8(
            '==== j2me-nx-port 开机 (fallback) ' + new Date().toISOString() + ' ====\n' + batch));
        } else {
          throw e;
        }
      }
    } catch (e2) {
      // 写卡彻底失败：把数据塞回缓冲等下次，并在 console 留可见警告
      __logBuf = __logBuf.concat(batch.split('\n').filter(Boolean));
      try { console.log('[log] LOG WRITE FAILED: ' + e2); } catch (e3) { /* 忽略 */ }
    }
  }

  // 追加一行日志。内部所有异常静默吞掉——日志系统绝不能引发二次崩溃。
  function sdLog(line) {
    var msg;
    try { msg = new Date().toISOString().slice(11, 23) + ' ' + line; }
    catch (e) { msg = line; }
    try { console.log('[log] ' + msg); } catch (e) { /* 忽略 */ }
    if (IS_NODE) {
      try { require('fs').appendFileSync(LOG_PATH, msg + '\n'); } catch (e) { /* 忽略 */ }
      return;
    }
    __logBuf.push(msg);
    // 2026-09-19：阈值 100→20。秒退级原生崩溃（Fatal OOM）连 400ms 防抖都
    // 等不及，20 行一刷保证启动期崩溃必留现场。
    if (__logBuf.length >= 20) { __logFlush(); return; }
    if (!__logTimer && typeof g.setTimeout === 'function') {
      __logTimer = g.setTimeout(__logFlush, 400);
    }
  }
  g.__sdLog = sdLog;
  g.__logFlush = __logFlush;
  // 阶段标记：立即落盘（原生崩溃时 setTimeout 攒批的日志会丢，标记不会）
  g.__sdMark = function (label) {
    sdLog('[mark] ' + label);
    __logFlush();
  };

  // 内存快照：立即落盘。排查跨会话 native 内存棘轮（V8 计数不含 Skia/RAB
  // 物理提交，只做趋势参考）
  function memSnapshot(tag) {
    try {
      if (IS_SWITCH && g.Switch && typeof g.Switch.memoryUsage === 'function') {
        var m = g.Switch.memoryUsage();
        var rab = '';
        try {
          var pr = g.__j2mePersistentRAB;
          if (pr && pr.buf) rab = ' rab=' + (pr.buf.byteLength / 1048576).toFixed(0) +
            '/' + (pr.maxBytes / 1048576).toFixed(0) + 'MB(复用)';
        } catch (eR) { /* 忽略 */ }
        g.__sdMark('[mem] ' + tag + ' used=' + (m.usedHeapSize / 1048576).toFixed(1) +
          'MB avail=' + (m.totalAvailableSize / 1048576).toFixed(1) +
          'MB limit=' + (m.heapSizeLimit / 1048576).toFixed(1) + 'MB' + rab);
      }
    } catch (e) { /* 忽略 */ }
  }
  g.__memSnapshot = memSnapshot;

  // 致命错误直接画到物理屏（实机不至于只有黑屏）
  function showFatalError(title, detail) {
    g.__fatalShown = true; // 让呈现层 rAF 停止覆盖错误画面
    if (typeof g.__logFlush === 'function') {
      try { g.__logFlush(); } catch (e) { /* 忽略 */ } // 崩溃场景 setTimeout 未必有机会跑
    }
    try {
      if (typeof g.screen === 'undefined' || !g.screen || !g.screen.getContext) return;
      var ctx = g.screen.getContext('2d');
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, g.screen.width, g.screen.height);
      ctx.fillStyle = '#ff5050';
      ctx.font = '68px "j2mecjk", monospace';
      ctx.fillText(T(title), 40, 110);
      ctx.fillStyle = '#e0e0e0';
      ctx.font = '40px "j2mecjk", monospace';
      var lines = String(detail || '').split('\n');
      var y = 180;
      var lineH = 56;
      var maxLines = Math.floor((g.screen.height - 240) / lineH);
      // 折行宽度按语言：40px 下汉字约 40px/字、ASCII 约 22px/字符，
      // 英文还用 30 字折行会把 1280 屏只用掉一半（看着像排版坏了）。
      var foldAt = (langNow() === 'en') ? 56 : 30;
      for (var i = 0; i < lines.length && i < maxLines; i++) {
        var ln = lines[i];
        while (ln.length > foldAt) { // 超长行折行
          ctx.fillText(ln.slice(0, foldAt), 28, y);
          y += lineH; ln = '  ' + ln.slice(foldAt);
          if (i >= maxLines) break;
        }
        if (i >= maxLines) break;
        ctx.fillText(ln, 28, y);
        y += lineH;
      }
      ctx.fillStyle = '#909090';
      ctx.font = '36px "j2mecjk", monospace';
      ctx.fillText(T('详细日志: {1}', 'sdmc:/switch/j2me-nx/error.log'), 28, g.screen.height - 40);
    } catch (e) { /* 忽略 */ }
  }

  // 拦截 console.error → 落日志（VM panic、宿主错误大多走这条路）
  (function () {
    if (!g.console || !g.console.error || g.console.error.__sdLogged) return;
    var origError = g.console.error;
    // 同条消息折叠：同类错误每帧刷屏时（曾因 fillPolygon 缺失每帧几十条
    // 落卡写日志拖垮帧率），5 秒窗口内只记首条 + 一行折叠计数
    //
    // PATCH(perfZ22)：折叠行过去有两个坑，实机排查时被坑过（用户"一堆报错"）：
    //   ① 折叠行**永远写成 [console.error]**，而 console.warn/info 也共用这个 sink ——
    //      于是游戏刷屏的 info（"Actor callAPI :regActor"）被折叠后全被读成"报错"；
    //   ② 折叠行只有计数、**没有正文**，日志里看不出折的到底是什么。
    //   现在：折叠行按真实通道标注，并带上被折消息的前 60 字。
    var dupKey = null, dupCount = 0, dupStart = 0;
    function channelOf(msg) {
      var m = /^\[console\.(error|warn|info)\]/.exec(msg);
      return m ? m[1] : 'error';
    }
    function sink(msg) {
      var now = Date.now();
      if (msg === dupKey && now - dupStart < 5000) {
        dupCount++;
        return;
      }
      if (dupCount > 0) {
        sdLog('[console.' + channelOf(dupKey) + '] <同条重复 ' + dupCount +
          ' 次已折叠> 正文：' + String(dupKey).slice(0, 60));
        dupCount = 0;
      }
      dupKey = msg;
      dupStart = now;
      sdLog(msg);
    }
    var wrapped = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          if (typeof a === 'string') parts.push(a);
          else if (a && a.message) {
            // nx.js 的 stack 不含 message，两者都拼上
            parts.push(String(a.message) + (a.stack ? '\n' + a.stack : ''));
          } else {
            parts.push(a && a.stack ? a.stack : String(a));
          }
        }
        sink('[console.error] ' + parts.join(' '));
      } catch (e) { /* 忽略 */ }
      return origError.apply(g.console, arguments);
    };
    wrapped.__sdLogged = true;
    g.console.error = wrapped;
    // console.warn 同样桥接：vendor 关键告警走 warn 通道——最典型的是
    // AMS.sendNativeEventToAMSIsolate 的 "Dropping native event sent to
    // AMS isolate"（MIDlet 启动事件被丢 = 游戏永不启动且之前零日志）。
    if (g.console.warn && !g.console.warn.__sdLogged) {
      var origWarn = g.console.warn;
      var wrappedWarn = function () {
        try {
          var parts2 = [];
          for (var j = 0; j < arguments.length; j++) {
            var a2 = arguments[j];
            if (typeof a2 === 'string') parts2.push(a2);
            else if (a2 && a2.message) parts2.push(String(a2.message) + (a2.stack ? '\n' + a2.stack : ''));
            else parts2.push(a2 && a2.stack ? a2.stack : String(a2));
          }
          sink('[console.warn] ' + parts2.join(' '));
        } catch (e2) { /* 忽略 */ }
        return origWarn.apply(g.console, arguments);
      };
      wrappedWarn.__sdLogged = true;
      g.console.warn = wrappedWarn;
    }
    // console.info 桥接：Java 侧 System.out/err 走 ConsoleOutputStream →
    // console.info（pluotsorbet native.js flushConsoleBuffer）。之前未桥接，
    // 导致 Java 异常栈 printStackTrace / AMS reportError 信息从未落日志
    // （AHQSL 等启动错误告警无详情）。注意：绝不桥接 console.log——sdLog
    // 内部用它输出，桥了会递归。info 通道可能被游戏刷屏，加 10s/120 条限流。
    if (typeof g.console.info !== 'function') {
      try { g.console.info = g.console.log; } catch (eI) { /* 忽略 */ }
    }
    if (g.console.info && !g.console.info.__sdLogged) {
      var origInfo = g.console.info;
      var infoCount = 0, infoWinStart = 0, infoDropped = false;
      var wrappedInfo = function () {
        try {
          var now3 = Date.now();
          if (now3 - infoWinStart >= 10000) { infoWinStart = now3; infoCount = 0; if (infoDropped) { sdLog('[console.info] <限流恢复>'); infoDropped = false; } }
          if (++infoCount > 120) { if (!infoDropped) { sdLog('[console.info] <10s 超过 120 条，限流中>'); infoDropped = true; } }
          else {
            var parts3 = [];
            for (var k = 0; k < arguments.length; k++) {
              var a3 = arguments[k];
              if (typeof a3 === 'string') parts3.push(a3);
              else if (a3 && a3.message) parts3.push(String(a3.message) + (a3.stack ? '\n' + a3.stack : ''));
              else parts3.push(a3 && a3.stack ? a3.stack : String(a3));
            }
            sink('[console.info] ' + parts3.join(' '));
          }
        } catch (e3) { /* 忽略 */ }
        return origInfo.apply(g.console, arguments);
      };
      wrappedInfo.__sdLogged = true;
      g.console.info = wrappedInfo;
    }
  })();

  // 全局致命错误统一入口（未捕获异常 / error / unhandledrejection 共用）：
  // 游戏会话内的异常不再走死路 fatal 屏（旧版：一次异常 → fatal 屏 +
  // 呈现循环死亡 → 后续所有游戏都"打不开"），改为简要提示后自动存档回菜单。
  function handleFatal(tag, detail) {
    sdLog('[' + tag + '] ' + detail);
    if (typeof __logFlush === 'function') __logFlush(); // 异常必须立刻落盘
    if (g.__gameRunning && !g.__restarting &&
        typeof g.__requestGameQuit === 'function') {
      if (g.__crashQuitPending) return; // 异常风暴期间只提示一次
      g.__crashQuitPending = true;
      showFatalError(T('游戏异常退出'),
        String(detail || '').split('\n').slice(0, 6).join('\n') +
        '\n\n' + T('即将自动返回游戏菜单 ...'));
      g.__noGen.setTimeout(function () {
        var wasPending = g.__crashQuitPending;
        g.__crashQuitPending = false;
        if (wasPending && g.__gameRunning && !g.__restarting) {
          g.__requestGameQuit('游戏异常: ' + String(detail).slice(0, 80));
        }
      }, 2500);
      return;
    }
    showFatalError(T('运行时错误（{1}）', tag), detail);
  }
  try {
    g.onerror = function (msg, src, line, col, err) {
      var detail = (err && err.stack) ? err.stack
        : (msg + ' @' + src + ':' + line + ':' + col);
      handleFatal('uncaught', detail);
    };
  } catch (e) { /* 忽略 */ }
  // nx.js 全局 error / unhandledrejection 事件（d.ts：默认打印后整个 app 停摆，
  // preventDefault 可拦截——先落日志再画错误屏，尽力让程序继续跑）。
  // 注意：env-prelude 每次软重启重求值都会 EventTarget.call(g) 清空 window
  // 监听，所以这里只定义、不注册——由 startSession 在每次 boot 前后各装一次
  //（旧版只在顶层装一次，软重启后异常兜底永久失效）。
  function installFatalListeners() {
    try {
      if (typeof g.addEventListener === 'function') {
        var fatalEvt = function (tag) {
          return function (ev) {
            var e = ev && (ev.error || ev.reason);
            var detail = e ? (e.stack || e.message || String(e))
              : (ev && ev.message ? ev.message : '(无详情)');
            try { if (ev && typeof ev.preventDefault === 'function') ev.preventDefault(); } catch (e2) { /* 忽略 */ }
            handleFatal(tag, detail);
          };
        };
        g.addEventListener('error', fatalEvt('error'));
        g.addEventListener('unhandledrejection', fatalEvt('unhandledrejection'));
      }
    } catch (e) { /* 忽略 */ }
  }
  // 游戏主循环异常捕捞：rAF / setTimeout / setInterval 回调包 try/catch，
  // 异常先落日志再原样重抛（nx.js 对 onerror 的触发时机不保证，这层保底）
  (function () {
    function wrap(cb, tag) {
      return function () {
        var args = arguments, self = this;
        try {
          return cb.apply(self, args);
        } catch (e) {
          try {
            sdLog('[' + tag + '-err] ' + (e && (e.stack || e.message) ? (e.stack || e.message) : String(e)));
            __logFlush();
          } catch (e2) { /* 忽略 */ }
          throw e;
        }
      };
    }
    try {
      if (typeof g.requestAnimationFrame === 'function' && !g.requestAnimationFrame.__j2meWrapped) {
        var oRAF = g.requestAnimationFrame;
        var wRAF = function (cb) { return oRAF.call(g, wrap(cb, 'raf')); };
        wRAF.__j2meWrapped = true;
        g.requestAnimationFrame = wRAF;
      }
      ['setTimeout', 'setInterval'].forEach(function (name) {
        var orig = g[name];
        if (typeof orig !== 'function' || orig.__j2meWrapped) return;
        var wrapped = function (cb, t) {
          var args = Array.prototype.slice.call(arguments);
          if (typeof cb === 'function') args[0] = wrap(cb, name === 'setTimeout' ? 'timeout' : 'interval');
          return orig.apply(g, args);
        };
        wrapped.__j2meWrapped = true;
        g[name] = wrapped;
      });
    } catch (e) { /* 忽略 */ }
  })();
  sdLog('[boot] 入口加载，平台=' + (IS_SWITCH ? 'Switch' : (IS_NODE ? 'Node' : '未知')) + '，build=20260924-perfZ25-ofont');

  // romfs 挂载诊断：两条读取路径各探测一次，结果落日志
  if (IS_SWITCH) {
    try {
      var probe = g.Switch && g.Switch.readFileSync
        ? g.Switch.readFileSync('romfs:/main.js') : 'no-api';
      sdLog('[diag] readFileSync(romfs:/main.js) -> ' +
        (probe === 'no-api' ? 'API不存在'
          : probe ? (probe.byteLength || probe.length) + 'B' : 'null'));
    } catch (e) {
      sdLog('[diag] readFileSync(romfs:/main.js) 抛错: ' + (e && e.message));
    }
    // diag fetch 探测已移除：romfs 挂载与 readFileSync 路径均已实机验证。
    // fetch 内部可能走 libuv 线程池（beta.6 有 worker condvar 崩溃），不再使用。
  }

  // ==================================================================
  // 1.4 耗时账本（PATCH perfZ25）
  // ==================================================================
  // 背景：玩家实测"游戏刚进入卡几秒"，但 [present] 的 vm/gfx/aud/other 四笔账
  // 里 other 混进了 vsync 空转（300 帧/5.0s = 满帧时 other 必然 ≈4.4s），
  // 所以那四笔账定位不到入口卡顿。入口成本实际发生在宿主层：读盘、zip 解压、
  // PNG 解码、呈现合成——本账本按入口逐笔记 {次数, 毫秒, 字节}，每 10s 落一条
  // [cost]，把"卡几秒"直接摊到具体环节上。
  // 记账点：宿主读盘（本文件）、zip inflate（vendor/pluotsorbet/libs/zipfile.js）、
  // PNG 解码（src/host/env-prelude.js 原生/JS 两条路）、屏幕呈现（本文件）。
  function costBook() {
    if (!g.__cost) g.__cost = Object.create(null);
    return g.__cost;
  }
  function costAdd(name, ms, bytes) {
    var book = costBook();
    var b = book[name] || (book[name] = { n: 0, ms: 0, bytes: 0 });
    b.n++;
    b.ms += ms;
    if (bytes) b.bytes += bytes;
  }
  g.__costAdd = costAdd; // vendor/宿主其它脚本共用（都自带 typeof 守卫）

  // 读一条账并清零（窗口语义，与 [alloc] 探针一致）
  function costTake(name) {
    var book = costBook();
    var b = book[name];
    book[name] = { n: 0, ms: 0, bytes: 0 };
    return b || { n: 0, ms: 0, bytes: 0 };
  }
  function costText(name) {
    var b = costTake(name);
    return name + '=' + b.n + '次/' + (b.ms / 1000).toFixed(2) + 's' +
      (b.bytes ? '/' + (b.bytes / 1048576).toFixed(2) + 'MB' : '');
  }
  function costAllText() {
    return costText('读盘') + ' ' + costText('解压') + ' ' +
      costText('原生解码') + ' ' + costText('JS解码');
  }

  // ---- 入口时间轴（PATCH perfZ25）----
  // 玩家口径的"游戏刚进入卡几秒"必须能摊开：选中 → jar 读入 → 入库 →
  // isolate 启动 → isolate 返回 → 首帧。每笔落一条 [enter]，首帧时汇总。
  // 累计账（读盘/解压/解码）也在汇总里给出，用于回答"几秒花在哪个环节"。
  function enterMark(name) {
    var t = g.__enterT;
    if (!t) t = g.__enterT = { marks: [], t0: Date.now() };
    t.marks.push([name, Date.now()]);
  }
  g.__enterMark = enterMark;
  function enterNewGame() {
    g.__enterT = { marks: [], t0: Date.now() };
    costBook(); // 不清零：本次开机累计（含菜单/上一个游戏）也一并给出，便于对比
    // 兜底：20s 还没出首帧（游戏起不来/卡死）也要留下时间轴，别只有黑屏
    if (g.__enterWatchdog) clearTimeout(g.__enterWatchdog);
    g.__enterWatchdog = setTimeout(function () {
      if (g.__enterT) enterSummary('入口账本（20s 未出首帧）');
    }, 20000);
  }
  function enterSummary(tag) {
    var t = g.__enterT;
    if (g.__enterWatchdog) { clearTimeout(g.__enterWatchdog); g.__enterWatchdog = null; }
    if (!t || !t.marks.length) return;
    var parts = [], prev = null;
    for (var i = 0; i < t.marks.length; i++) {
      var nm = t.marks[i][0], ts = t.marks[i][1];
      parts.push(nm + (prev === null ? '=0' : '=' + (ts - prev)) + 'ms');
      prev = ts;
    }
    sdLog('[enter] ' + tag + '（自选中累计 ' + ((Date.now() - t.t0) / 1000).toFixed(1) + 's）: ' +
      parts.join(' → ') + ' | 累计 ' + costAllText());
    if (typeof __logFlush === 'function') __logFlush();
    g.__enterT = null; // 只汇总一次
  }

  function readFileBytes(path) {
    // 返回 Promise<Uint8Array>；失败时包装路径信息（实机日志定位用）
    var t0 = Date.now();
    return _readFileBytesImpl(path).then(function (bytes) {
      costAdd('读盘', Date.now() - t0, bytes ? bytes.byteLength : 0);
      return bytes;
    }, function (e) {
      costAdd('读盘', Date.now() - t0, 0);
      var msg = (e && e.message) ? e.message : String(e);
      throw new Error('readFileBytes 失败: ' + path + ' — ' + msg);
    });
  }

  function _readFileBytesImpl(path) {
    if (IS_SWITCH) {
      // 首选 Switch.readFileSync（mv2switch 实机验证过：romfs:/sdmc 都可靠；
      // 返回 ArrayBuffer|null，null = 文件不存在。全局 fs.readFile 读 romfs 会失败）
      if (g.Switch && typeof g.Switch.readFileSync === 'function') {
        return new Promise(function (resolve, reject) {
          var buf = null;
          try { buf = g.Switch.readFileSync(path); } catch (e) { reject(e); return; }
          if (buf === null || buf === undefined) {
            reject(new Error('readFileSync 返回 null（文件不存在？）'));
            return;
          }
          try {
            if (buf instanceof ArrayBuffer) resolve(new Uint8Array(buf));
            else if (buf.buffer) resolve(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
            else resolve(new Uint8Array(buf));
          } catch (e) { reject(e); }
        });
      }
      // Switch 上只走同步 readFileSync 单路：异步 fs（fs.promises/readFile 回调）
      // 和 fetch 都会进 libuv 线程池，beta.6 出过 worker condvar 原生崩溃，
      // 宁可报错暴露问题也不用异步路径。
      return Promise.reject(new Error('Switch.readFileSync 不可用'));
    }
    // Node
    var nodeFs = require('fs');
    return nodeFs.promises.readFile(path).then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  function pathJoin(base, rel) {
    if (!base) return rel;
    if (base.charAt(base.length - 1) !== '/') base += '/';
    return base + rel;
  }

  // ==================================================================
  // 1. 加载器：按浏览器 <script defer> 顺序执行
  // ==================================================================

  var projectRoot = IS_SWITCH
    ? 'romfs:'
    : NODE_REPO_ROOT;   // perfZ24：桌面仿真按 cwd（仓库根）解析，不再写死绝对路径

  // [开发布局（仓库内）, romfs 布局（打包后）]
  var SCRIPTS = [
    ['src/host/png-decoder.js',                 'host/png-decoder.js'],
    ['src/host/mask-scan.js',                   'host/mask-scan.js'],
    ['src/host/env-prelude.js',                 'env-prelude.js'],
    ['src/host/ui-lang.js',                     'host/ui-lang.js'],   // PATCH(perfZ21)：屏显文字中/英
    ['bld/native.js',                           'j2me/native.js'],
    ['vendor/pluotsorbet/config/default.js',    'vendor/config/default.js'],
    ['bld/config-build.js',                     'j2me/config-build.js'],
    ['config/switch.js',                        'config/switch.js'],
    ['vendor/pluotsorbet/config/urlparams.js',  'vendor/config/urlparams.js'],
    ['src/host/idb-shim.js',                    'host/idb-shim.js'],
    ['bld/j2me.js',                             'j2me/j2me.js'],
    ['bld/main-all.js',                         'j2me/main-all.js'],
    ['src/host/pipe-host.js',                   'host/pipe-host.js'],
    ['src/host/switch-audio.js',                'host/switch-audio.js'],
    ['src/host/switch-input.js',                'host/switch-input.js'],
  ];

  function scriptList() {
    var i = IS_SWITCH ? 1 : 0;
    return SCRIPTS.map(function (pair) { return pair[i]; });
  }

  function runScript(path) {
    // 读取并全局 eval（vendor 代码依赖全局作用域相互可见）
    return readFileBytes(path).then(function (bytes) {
      var code = new TextDecoder().decode(bytes);
      // eval 前立即落盘探针：上次无声崩溃死在"已加载 config-build"与下一
      // 条日志之间的 2ms 窗口，逐脚本标记才能把下一个死点钉到具体脚本
      g.__sdMark('eval ' + path.slice(path.lastIndexOf('/') + 1) +
        ' (' + (bytes && bytes.byteLength) + 'B)');
      // 浏览器 <script> 语义下顶层 var 会进全局；但 eval 中的 'use strict'
      // 程序会创建独立作用域。加 "0;" 前缀使 'use strict' 不再处于指令序言
      // 位置，代码按 sloppy 模式运行，var 正常进全局。
      // （移植决策，见 README"与上游的差异"）
      (0, eval)('0;\n' + code);
    });
  }

  // CJK 字体：nx.js canvas 内置字体（Geist Mono/system-ui）无汉字字形，
  // 中文 J2ME 游戏 drawString 会全是 .notdef 口框。从 romfs 读内置 CJK 字体
  // （Noto Sans SC，SIL OFL 1.1，允许再分发；见 data/fonts/README.md）注册为
  // FontFace 家族 "j2mecjk"。注册配方与 mv2switch 实机验证过的一致：
  //   fonts.add(new FontFace(family, 纯ArrayBuffer))  —— add 即生效；
  //   face.load() 在本运行时是空壳（Method not implemented），仅记录不作为判据。
  // __j2meFontFamily 只放单个 family 名（gfx.js 加引号使用）——逗号列表在
  // nx.js canvas 的 font 解析里不可靠，会整体失败回落默认字体（缺字根因）。
  function installCjkFont() {
    if (!IS_SWITCH) return Promise.resolve(false);
    // 跨会话缓存：g.fonts/g 是宿主常驻对象，字体注册一次终身有效。
    // 软重启重读 10.6MB ttf 再 add 一个同族 FontFace，纯粹浪费内存
    //（旧 typeface 要等 GC，Skia 侧 native 内存不计入 V8 预算）。
    if (g.__j2meCjkFontOK) return Promise.resolve(true);
    sdLog('[font] FontFace=' + typeof g.FontFace + ' fonts=' + typeof g.fonts);
    if (typeof g.FontFace !== 'function' || !g.fonts) return Promise.resolve(false);
    return readFileBytes('romfs:/fonts/cjk.ttf').then(function (bytes) {
      sdLog('[font] 字体文件 ' + (bytes && bytes.byteLength) + 'B');
      // FontFace 源必须是独立 ArrayBuffer（mv2switch 配方：Uint8Array 视图
      // 带 byteOffset 时可能解析失败，slice 成精确长度的纯 buffer）
      var ab;
      try {
        ab = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
          ? bytes.buffer
          : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      } catch (e0) {
        ab = bytes.buffer;
      }
      var face;
      try {
        face = new g.FontFace('j2mecjk', ab);
        sdLog('[font] FontFace 构造 OK');
      } catch (e) {
        sdLog('[font] FontFace 构造失败: ' + (e && e.message));
        return false;
      }
      try {
        g.fonts.add(face);
        g.__j2meCjkFontOK = true; // 注册成功即持久，软重启不再重装
        sdLog('[font] fonts.add OK（本运行时 add 即生效，不依赖 load）');
      } catch (e) {
        sdLog('[font] fonts.add 失败: ' + (e && e.message));
        return false;
      }
      // add 即设家族（load 仅记录状态，失败不回退——回退只会更糟）
      g.__j2meFontFamily = 'j2mecjk';
      // PATCH(j2me-nx-port): nx.js findFont 按 weight/style 【精确匹配】，
      // 只注册 normal 时，游戏画 'bold 19px "j2mecjk"' 找不到 face → setter
      // 静默跳过 → 保持上一个字体（系统字体）→ 系统字体缺的简体字（载/戏/
      // 键/帮）画成口口（Diamond Rush 缺字根因）。这里用同一 buffer 补注册
      // bold / italic / bold+italic 三个变体（FT_Face 各自独立，buffer 共享）。
      var variants = [
        { weight: 'bold', style: null },
        { weight: null, style: 'italic' },
        { weight: 'bold', style: 'italic' },
      ];
      for (var vi = 0; vi < variants.length; vi++) {
        var vv = variants[vi];
        try {
          var desc = {};
          if (vv.weight) desc.weight = vv.weight;
          if (vv.style) desc.style = vv.style;
          var vface = new g.FontFace('j2mecjk', ab, desc);
          g.fonts.add(vface);
          sdLog('[font] 变体注册 OK: ' + (vv.weight || 'normal') + '/' + (vv.style || 'normal'));
        } catch (ev) {
          sdLog('[font] 变体注册失败 ' + (vv.weight || 'normal') + '/' + (vv.style || 'normal') + ': ' + (ev && ev.message));
        }
      }
      try {
        Promise.resolve(face.load()).then(function () {
          sdLog('[font] face.load OK');
        }, function (e) {
          sdLog('[font] face.load 失败（已知空壳，不影响 add 生效）: ' + (e && e.message));
        });
      } catch (e1) { /* 同上 */ }
      return true;
    }, function (e) {
      sdLog('[font] 字体文件读取失败: ' + (e && e.message));
      return false;
    });
  }

  // CJK 字形探测：在一个小离屏画布上画字读回墨水像素数判断。
  // 关键修正：旧的"有像素=可画"会被 .notdef 口框（豆腐块）骗过——口框也是
  // 像素！这里画一个保证不存在的码点（\u0378 未分配）拿到"豆腐块墨水数"，
  // 真汉字墨水数应明显大于它且两者像素图案不同。
  function probeCjkGlyphs() {
    if (!IS_SWITCH || typeof g.OffscreenCanvas !== 'function') return;
    try {
      var c = new g.OffscreenCanvas(64, 64);
      var ctx = c.getContext('2d');
      // 返回墨水像素数；ref 为 true 时画未分配码点（豆腐块基准）
      function ink(fontSpec, ch) {
        try {
          ctx.clearRect(0, 0, 64, 64);
          ctx.font = fontSpec;
          ctx.fillStyle = '#ffffff';
          ctx.fillText(ch, 2, 40);
          var d = ctx.getImageData(0, 0, 64, 64).data;
          var n = 0, hash = 0;
          for (var i = 3; i < d.length; i += 4) {
            if (d[i] > 8) { n++; hash = (hash + (i % 97)) | 0; }
          }
          return { n: n, hash: hash };
        } catch (e) { return null; }
      }
      function looksReal(spec, ch, ref) {
        var r = ink(spec, ch);
        if (!r || r.n === 0) return false;          // 什么都没画出来
        if (!ref || ref.n === 0) return r.n > 0;    // 无豆腐块基准可对比
        // 墨水数与图案都和豆腐块几乎一样 → 就是 .notdef 口框
        return !(r.n <= ref.n + 2 && r.hash === ref.hash);
      }
      var tofu = ink('20px monospace', '\u0378'); // 未分配码点 → .notdef 豆腐块
      sdLog('[font-probe] 豆腐块基准 \\u0378 墨水=' + (tofu ? tofu.n : 'null'));
      sdLog('[font-probe] system-ui 汉字"测"真实=' + looksReal('20px "system-ui"', '\u6D4B', tofu) +
        ' 拉丁"A"真实=' + looksReal('20px "system-ui"', 'A', tofu));
      sdLog('[font-probe] j2mecjk 汉字"测"真实=' + looksReal('20px "j2mecjk"', '\u6D4B', tofu) +
        ' 默认monospace 汉字真实=' + looksReal('20px monospace', '\u6D4B', tofu));
      // 缺字定位：GBK 生僻字组（"堃喆镕"），内置字体全有 = 注册生效但渲染没用它
      var rare = ['\u5803', '\u5586', '\u9555']; // 堃 喆 镕
      var j2meRare = rare.map(function (ch) { return looksReal('20px "j2mecjk"', ch, tofu) ? 1 : 0; }).join('');
      var sysRare = rare.map(function (ch) { return looksReal('20px "system-ui"', ch, tofu) ? 1 : 0; }).join('');
      sdLog('[font-probe] GBK生僻字 堃喆镕 j2mecjk=' + j2meRare + ' system-ui=' + sysRare);
      // bold 维度：Diamond Rush 豆腐块全发生在 bold 19px（findFont weight 精确
      // 匹配失败→回落系统字体）。true=bold 也走 j2mecjk，修复生效。
      var boldOK = looksReal('bold 19px "j2mecjk"', '\u6D4B', tofu);
      var boldRare = ['\u8F7D', '\u620F', '\u952E', '\u5E2E'].map(function (ch) {
        return looksReal('bold 19px "j2mecjk"', ch, tofu) ? 1 : 0;
      }).join('');
      sdLog('[font-probe] bold19px 汉字"测"=' + boldOK + ' 载戏键帮=' + boldRare +
        '（1111=bold 全走内置 CJK 字体，修复生效）');
      sdLog('[font-probe] 判定: j2mecjk 汉字真实=' + looksReal('20px "j2mecjk"', '\u6D4B', tofu) +
        '（true=字体注册渲染全通；false=仍会缺字，需查注册链路）');
    } catch (e) {
      sdLog('[font-probe] 异常: ' + (e && e.message));
    }
  }

  // 文字诊断 spy：gfx.js 的 drawString 每画一串字就调这里。
  // 记录前 40 次调用（文本内容/字体/锚点），并对每次调用的文本逐字做
  // 豆腐块检测（与 \u0378 未分配码点的 .notdef 渲染比墨水数+图案哈希），
  // 直接点名"哪些字被画成了口口"。
  function installTextSpy() {
    if (!IS_SWITCH || typeof g.OffscreenCanvas !== 'function') return;
    try {
      var pc = new g.OffscreenCanvas(64, 64);
      var pctx = pc.getContext('2d');
      var cache = Object.create(null);
      function ink(fontCss, ch) {
        try {
          pctx.clearRect(0, 0, 64, 64);
          pctx.font = fontCss;
          pctx.fillStyle = '#ffffff';
          pctx.fillText(ch, 2, 40);
          var d = pctx.getImageData(0, 0, 64, 64).data;
          var n = 0, hash = 0;
          for (var i = 3; i < d.length; i += 4) {
            if (d[i] > 8) { n++; hash = (hash + (i % 97)) | 0; }
          }
          return { n: n, hash: hash };
        } catch (e) { return null; }
      }
      var tofuRef = null;
      function isTofu(fontCss, ch) {
        var key = fontCss + '|' + ch;
        if (cache[key] !== undefined) return cache[key];
        if (!tofuRef) tofuRef = ink(fontCss, '\u0378');
        var r = ink(fontCss, ch);
        var verdict;
        if (!r || r.n === 0) verdict = 'blank';          // 什么都画不出
        else if (!tofuRef || tofuRef.n === 0) verdict = (r.n > 0 ? 'ok' : 'blank');
        else if (r.n <= tofuRef.n + 2 && r.hash === tofuRef.hash) verdict = 'tofu';
        else verdict = 'ok';
        if (Object.keys(cache).length > 8192) cache = Object.create(null);
        cache[key] = verdict;
        return verdict;
      }
      var calls = 0;
      g.__j2meTextSpy = function (str, fontCss, anchor) {
        calls++;
        if (calls > 40 && calls % 500 !== 0) return;
        try {
          str = String(str == null ? '' : str);
          fontCss = String(fontCss == null ? '?' : fontCss);
          var tofu = [], blank = [], seen = Object.create(null);
          for (var i = 0; i < str.length; i++) {
            var ch = str.charAt(i);
            if (seen[ch]) continue;
            seen[ch] = 1;
            if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
            var v = isTofu(fontCss, ch);
            if (v === 'tofu' && tofu.length < 20) tofu.push('\\u' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') + '(' + ch + ')');
            else if (v === 'blank' && blank.length < 10) blank.push('\\u' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') + '(' + ch + ')');
          }
          sdLog('[text#' + calls + '] font=' + fontCss + ' anchor=' + anchor +
            ' text="' + str.slice(0, 40).replace(/\n/g, '\\n') + '"' +
            (tofu.length ? ' 豆腐块=' + tofu.join('') : '') +
            (blank.length ? ' 空白=' + blank.join('') : ''));
          if (calls === 1) {
            // PATCH(perfZ25)：首次文字绘制 = 游戏 UI 真正出现的时点，记进入口账本
            // （黑屏期的结束点；首帧可能只是全黑，文字才说明游戏开始画界面）
            try { enterMark('首次文字'); } catch (eEM) { /* 忽略 */ }
            if (typeof __logFlush === 'function') __logFlush();
          }
        } catch (e) { /* 忽略 */ }
      };
      sdLog('[text-spy] 已安装');
    } catch (e) {
      sdLog('[text-spy] 安装失败: ' + (e && e.message));
    }
  }

  // 文字测量器：vendor 的 Font 用 measureText 算字符串宽度，但本运行时在
  // 0 尺寸离屏画布上 measureText 返回 undefined（gfx.js 把测量画布故意压成
  // 0x0）→ Java 侧 stringWidth NPE。这里探测三级方案并注入 __hostMeasureText：
  //   1) 正常尺寸离屏画布的 measureText
  //   2) screen 上下文的 measureText（若离屏不支持）
  //   3) fillText + getImageData 像素扫描（万能兜底，有缓存）
  function installTextMeasurer() {
    if (!IS_SWITCH) return;
    var sctx = null, scrCtx = null, mode = 'pixels';
    function widthOf(m) { return !!m && typeof m.width === 'number'; }
    try {
      if (typeof g.OffscreenCanvas === 'function') {
        var c1 = new g.OffscreenCanvas(300, 150).getContext('2d');
        var m1 = c1.measureText('测A');
        var c2 = new g.OffscreenCanvas(300, 150).getContext('2d');
        c2.canvas.width = 0; c2.canvas.height = 0;
        var m2 = c2.measureText('测A');
        sdLog('[measure] offscreen 300x150=' + (widthOf(m1) ? m1.width : 'undefined') +
          ' 0x0=' + (widthOf(m2) ? m2.width : 'undefined'));
        if (widthOf(m1)) { mode = 'offscreen'; sctx = c1; }
      }
      if (mode === 'pixels' && g.screen && g.screen.getContext) {
        var c3 = g.screen.getContext('2d');
        var m3 = c3.measureText('测A');
        sdLog('[measure] screen=' + (widthOf(m3) ? m3.width : 'undefined'));
        if (widthOf(m3)) { mode = 'screen'; scrCtx = c3; }
      }
    } catch (e) {
      sdLog('[measure] 探测异常: ' + (e && e.message));
    }
    var pctx = null;
    if (mode === 'pixels' && typeof g.OffscreenCanvas === 'function') {
      pctx = new g.OffscreenCanvas(512, 96).getContext('2d');
    }
    var cache = Object.create(null);
    function pixelMeasure(fontCss, text) {
      var key = fontCss + '|' + text;
      if (cache[key] !== undefined) return cache[key];
      pctx.clearRect(0, 0, 512, 96);
      pctx.font = fontCss;
      pctx.fillStyle = '#ffffff';
      pctx.fillText(text, 4, 70);
      var d = pctx.getImageData(0, 0, 512, 96).data;
      var right = 3;
      for (var y = 0; y < 96; y++) {
        for (var x = 511; x > right; x--) {
          if (d[(y * 512 + x) * 4 + 3] > 0) { right = x; break; }
        }
      }
      var w = Math.max(0, right - 3);
      if (Object.keys(cache).length > 4096) cache = Object.create(null);
      cache[key] = w;
      return w;
    }
    g.__hostMeasureText = function (fontCss, text) {
      try {
        if (mode === 'offscreen' && sctx) {
          sctx.font = fontCss;
          var m = sctx.measureText(text);
          if (widthOf(m)) return m.width | 0;
        } else if (mode === 'screen' && scrCtx) {
          scrCtx.font = fontCss;
          var m2 = scrCtx.measureText(text);
          if (widthOf(m2)) return m2.width | 0;
        } else if (mode === 'pixels' && pctx) {
          return pixelMeasure(fontCss, text);
        }
      } catch (e) { /* 落到估算 */ }
      return (text.length * 10) | 0; // 最后的粗略估算
    };
    sdLog('[measure] 模式=' + mode);
  }

  function boot() {
    // 字体先于所有脚本就位（gfx.js 建第一个 Font 时就要能用）
    var p = installCjkFont();
    p = p.then(function () { probeCjkGlyphs(); installTextMeasurer(); installTextSpy(); });
    scriptList().forEach(function (rel) {
      p = p.then(function () {
        // canvas 工厂与资源加载器必须在 vendor bundle 之前就位
        // （midp.js 在加载期就 getElementById("canvas")）
        if (rel.indexOf('native.js') !== -1) {
          installCanvas();
          installResourceLoader();
          // PATCH(perfZ13)：就在这里回收上一会话（宿主初始化已完成、VM 还没重编译）
          try { reclaimPreviousSession(); } catch (eRC) { /* 忽略 */ }
        }
        var beforeEval = snapshotKeys();   // perfZ15：记录本次 eval 前的全局名集合
        return runScript(pathJoin(projectRoot, rel)).then(function () {
          sdLog('[boot] 已加载 ' + rel);
          // native.js 完成即 RAB 就位——软重启内存压力的临界点，落内存快照
          if (rel.indexOf('native.js') !== -1) {
            memSnapshot('RAB就位');
            sdLog('[heap] ' + (function () {
              try { return g.ASM && g.ASM.__diag ? g.ASM.__diag() : '(无diag)'; }
              catch (eD) { return '(diag失败:' + (eD && eD.message) + ')'; }
            })());
          }
          // 持久化注册：紧跟 idb-shim（indexedDB 定义处）之后、vendor bundle
          // （fs.js Store.init 发起 indexedDB.open）之前
          if (rel.indexOf('idb-shim') !== -1) {
            installIDBPersistence();
          }
          // PATCH(perfZ15)：必须在**本脚本的宿主钩子全部跑完之后**记录归属 —— 放前面会把
          // 宿主刚装的全局（如 __flushIDBPersistence）算到下一个脚本头上，软重启时被误摘，
          // 实测那版连 isolate 都起不来。第二个参数 = 本次 eval 前的全局名集合。
          recordNewGlobals(rel, beforeEval);
        });
      });
    });
    return p;
  }  // ==================================================================
  // 2. 资源加载器（XHR shim 的后端）
  // ==================================================================

  var MIME = {
    '.js': 'text/javascript',
    '.jar': 'application/java-archive',
    '.jad': 'text/vnd.sun.j2me.app-descriptor',
    '.ks': 'application/x-keystore',
  };

  function installResourceLoader() {
    g.__setResourceLoader(function (path, responseType) {
      // 两级查找：SD 数据目录（用户可自行替换）→ romfs/项目根（内置资源）
      // 特例：midlet.jar = 菜单选中的游戏（等待选择完成后从 java/ 目录读取）
      if (path === 'midlet.jar') {
        sdLog('[res] midlet.jar → 等待菜单选择 ...');
        return g.__gameSelection.then(function (sel) {
          enterNewGame();
          enterMark('选中jar');
          sdLog('[res] midlet.jar = ' + sel.file + '（' + sel.name + '）');
          return readFileBytes(sel.absPath);
        }).then(function (bytes) {
          enterMark('读入完成');
          sdLog('[res] 选中游戏读入 ' + bytes.byteLength + 'B');
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        });
      }
      var sdPath = pathJoin(DATA_ROOT, path);
      var romPath = pathJoin(projectRoot, path);
      sdLog('[res] 请求 ' + path + ' (type=' + responseType + ')');
      return readFileBytes(sdPath).then(function (bytes) {
        sdLog('[res] ' + path + ' 命中 SD ' + bytes.byteLength + 'B');
        return bytes;
      }, function () {
        return readFileBytes(romPath).then(function (bytes) {
          sdLog('[res] ' + path + ' 命中 romfs ' + bytes.byteLength + 'B');
          return bytes;
        });
      }).then(function (bytes) {
        switch (responseType) {
          case 'arraybuffer':
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          case 'text':
            return new TextDecoder().decode(bytes);
          case 'blob':
            return new Blob([bytes]);
          default:
            return bytes;
        }
      }, function (err) {
        return Promise.reject(new Error('资源不存在: ' + path + ' (查找于 ' + sdPath + ')'));
      });
    });
  }

  // ==================================================================
  // 3. Canvas 工厂
  // ==================================================================

  function installCanvas() {
    // 本 @nx.js/runtime 版本的全局画布类是 OffscreenCanvas(w,h)；
    // Canvas 类不存在（此前 typeof 检查静默失败 → vendor 拿到未注入的默认工厂）。
    // 兼容两种命名，都缺则显式留日志。
    var Ctor = (typeof g.OffscreenCanvas === 'function') ? g.OffscreenCanvas
      : (typeof g.Canvas === 'function') ? g.Canvas : null;
    sdLog('[canvas] OffscreenCanvas=' + typeof g.OffscreenCanvas +
      ' Canvas=' + typeof g.Canvas + ' screen=' + typeof g.screen);
    if (IS_SWITCH && Ctor) {
      g.__setCanvasFactory(function (w, h) {
        var c = new Ctor(w | 0, h | 0);
        wrapNxContext(c);
        return c;
      });
      return true;
    }
    if (IS_NODE) {
      // 冒烟测试用 stub canvas（由 simulate.mjs 注入 __stubCanvasClass）
      var Stub = g.__stubCanvasClass;
      if (!Stub) return false;
      g.__setCanvasFactory(function (w, h) {
        return new Stub(w, h);
      });
      return true;
    }
    return false;
  }

  // nx.js 的 drawImage 只接受原生 CanvasImageSource；PNG 解码产物是纯像素
  // 数据（伪 Image）。包装 ctx.drawImage：
  //   · 伪 Image 带 _bitmap（runtime 原生 ImageBitmap）→ 直接进原生 drawImage
  //     （Skia 路径，无需 putImageData 主线程拷贝，见 perfZ25 原生解码）
  //   · 伪 Image 带 _decoded（纯 JS 解码的像素）→ putImageData 回落
  function wrapNxContext(canvas) {
    var ctx = canvas.getContext('2d');
    if (!ctx || ctx.__j2meWrapped) return;
    var rawDrawImage = ctx.drawImage.bind(ctx);
    ctx.drawImage = function (img, a, b, c, d, e, f, gg, hh) {
      if (img && img._bitmap) {
        var src = img._bitmap;
        if (arguments.length === 3) return rawDrawImage(src, a, b);
        if (arguments.length === 5) return rawDrawImage(src, a, b, c, d);
        return rawDrawImage(src, a, b, c, d, e, f, gg, hh);
      }
      if (img && img._decoded) {
        var png = img._decoded;
        var clamped = new Uint8ClampedArray(png.data);
        var idata = (typeof g.ImageData === 'function')
          ? new g.ImageData(clamped, png.width, png.height)
          : { data: clamped, width: png.width, height: png.height };
        ctx.putImageData(idata, a | 0, b | 0);
        return;
      }
      if (arguments.length === 3) return rawDrawImage(img, a, b);
      if (arguments.length === 5) return rawDrawImage(img, a, b, c, d);
      return rawDrawImage(img, a, b, c, d, e, f, gg, hh);
    };
    ctx.__j2meWrapped = true;
  }

  // ==================================================================
  // 3.5 屏幕呈现层：游戏逻辑画面 → 物理屏幕（等比放大 + 居中）
  // ==================================================================
  // nx.js 的 new Canvas() 是离屏画布，渲染结果必须显式画到全局 screen
  // （Screen 单例，getContext('2d') 即上屏）。不做这一步真机就是黑屏。
  // 虚拟设备分辨率按所选游戏探测（detectGameResolution → __setDeviceScreenSize），
  // 默认 240x320。呈现按画面方向自适应（每帧判定）：
  //   竖屏（w<=h）：fit 遮罩白区（GX,GY 540x720），叠遮罩图
  //   横屏（w>h） ：铺满 1280x720 + 最少黑边，不叠遮罩
  function installPresenter() {
    if (!IS_SWITCH || typeof g.screen === 'undefined') return false;
    if (g.__presenterInstalled) return true; // 跨会话只装一次（软重启不重装）
    g.__presenterInstalled = true;
    // 设备画布与 screen 都不在这里缓存！软重启时 env-prelude/vendor 整体重求值
    // 会产出全新的 document 与画布对象，缓存旧引用会导致下个游戏"复用上个
    // 游戏的画布"且按旧宽高算布局（画面错位）。present() 每帧动态取当前对象。
    // 遮罩布局（2026-09-23 perfZ6：默认遮罩换成用户的"复古诺基亚.png"，1280x720）：
    // 游戏画面（竖屏 3:4）不旋转，等比放大后居中放进遮罩的**透明窗口**，两侧装饰由
    // 遮罩图盖在上层。⚠️ 游戏是画在遮罩**下层**的，所以窗口必须把游戏矩形完整包住——
    // 窗口小于游戏矩形就会把游戏边缘压掉。
    // 下面四个数是 mask.raw 里 alpha==0 像素的包围盒，由工具实测得出（换图后要重测）：
    //   node tools/make-default-mask.mjs     # 会打印"透明窗口: [x,y,w,h]"
    // tests/mask-assets.test.mjs 盯着"这四个数 == 实测窗口"，换图忘了改会报错。
    // （历史：旧蒸汽朋克遮罩的白区是 [368,0,540,720]，白区在屏上 x 368..907。）
    var GX = 373, GY = 0, GW = 539, GH = 720;
    var BUILTIN_CUT = [GX, GY, GW, GH]; // 内置遮罩透明窗（默认路径 + builtin 选择共用）
    // 有持久化的遮罩选择则预载（异步，就绪前回落内置遮罩/黑边）
    try { ensureMaskLoaded(g.__maskState && g.__maskState.sel); } catch (eML) { /* 忽略 */ }

    // 遮罩图：只读 romfs:/mask.raw（构建期预解码的 1280x720 RGBA 裸数据）。
    // ⚠️ 2026-09-23 perfZ6 起**没有 png 回落**了：内置遮罩全部是 raw，data/mask.png
    // 已删除。以前那条"raw 缺失就回落 mask.png 走 JS 解码"的路是隐患——实机上
    // PNG 解码正是 RAB 环境里的大分配/秒退嫌疑源（见 PERF 记录 §17），而且那张
    // png 还是 1920x1080 的旧图，兜底成功反而会画出错位的旧遮罩。缺了就是缺了：
    // 记一条日志、退化成纯黑边，游戏照常能玩。
    var maskCanvas = null;
    var MW = 1280, MH = 720;
    readFileBytes('romfs:/mask.raw').then(function (bytes) {
      if (bytes.byteLength !== MW * MH * 4) throw new Error('mask.raw 尺寸不符: ' + bytes.byteLength);
      var mc = new g.OffscreenCanvas(MW, MH);
      var mctx = mc.getContext('2d');
      var imgData = mctx.createImageData(MW, MH);
      imgData.data.set(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      mctx.putImageData(imgData, 0, 0);
      return mc;
    }).then(function (mc) {
      maskCanvas = mc;
      sdLog('[present] 遮罩图就绪 ' + MW + 'x' + MH + '（窗口 ' + GX + ',' + GY + ' ' + GW + 'x' + GH + '）');
      if (typeof __logFlush === 'function') __logFlush();
    }).catch(function (e) {
      sdLog('[present] mask.raw 加载失败（退化为纯黑边）: ' + (e && e.message));
      if (typeof __logFlush === 'function') __logFlush();
    });

    var __frames = 0;
    var lastScr = null, liveCtx = null; // screen 换了才重取 context
    // PATCH(perfZ25)：合成缓冲（离屏 scene）+ 呈现耗时明细。
    // 实测背景：other 那笔账里混着 vsync 空转（满帧时它必然 ≈窗口长度），
    // 所以呈现到底花多少毫秒只能自己记。清屏/游戏/遮罩/上屏四段分开累计，
    // 每 300 帧随 [present] 一起落盘 —— 由此判断呈现层是不是卡顿元凶。
    var scene = null, sceneCtx = null, sceneW = 0, sceneH = 0;
    var presAcc = 0, presMax = 0, presMiss = 0;
    var clearMsAcc = 0, gameMsAcc = 0, blitMsAcc = 0;
    function present() {
      // 循环常驻：fatal 画面显示中 / 菜单阶段 / 软重启间隙都只跳过绘制、
      // 继续排 rAF。旧版在 fatal 时直接 return 杀死 rAF 链——一次致命错误
      // 之后呈现层永久停摆，后续所有游戏即使正常跑起来屏幕也停在最后一帧
      //（实机表现："一个游戏打不开，剩余的游戏都打不开"）。
      if (g.__fatalShown || !g.__gameRunning) {
        g.__noGen.requestAnimationFrame(present);
        return;
      }
      __frames++;
      g.__presentFrames = __frames; // 启动看门狗读这里判断"游戏是否真的跑起来"
      // PATCH(j2me-nx-port): 帧间隙编译队列——预算门推迟的 JIT 编译每帧消化
      // ≤6ms（≈360ms/s 编译能力），LIFO 最新热方法优先。比赛场景新热方法
      // 几秒内编完，而不是排队期间一直被解释（1550budget 实机 vm 仍 90% 的根因）。
      if (typeof g.J2ME !== 'undefined' && g.J2ME && typeof g.J2ME.drainCompileQueue === 'function') {
        try { g.J2ME.drainCompileQueue(6); } catch (eDQ) { /* 不影响呈现 */ }
      }
      if (__frames === 1) {
        // 首帧探针：放行后游戏真正绘出第一画面的时点（逐条立即落盘）
        sdLog('[game] 首帧已绘（呈现层收到第一幅游戏画面）');
        // PATCH(perfZ25)：入口账本收口 —— 选中→读入→入库→isolate→首帧 每段毫秒
        try { enterMark('首帧'); enterSummary('入口账本'); } catch (eEnt) { /* 账本故障不影响游戏 */ }
        if (typeof __logFlush === 'function') __logFlush();
        // perfF/perfI：崩溃面包屑。实机现象是"模拟器自己退出、无报错、无 crash_reports"
        // （= runtime 的 V8 fatal 路径 clean exit），10s 心跳太稀，最后 10s 是黑的。
        // 改成游戏期内每 1s 一条并强制落盘：死前最后一个 crumb 就是现场。
        // 注意：memLine 定义在别的嵌套作用域里（present 循环里取不到），
        // 所以这里**自己内联**读 memoryUsage —— 上一版正是因此被 try/catch 静默吞掉、零输出。
        if (!g.__crumbTimer) {
          g.__crumbErrLogged = false;
          g.__crumbTimer = setInterval(function () {
            try {
              var m = g.Switch.memoryUsage();
              var jh = '?';
              try {
                if (g.ASM && g.ASM.__bump) {
                  jh = ((g.ASM.__bump() - g.ASM.__heapStart) / 1048576).toFixed(1) +
                    '/' + (g.ASM.__totalMemory() / 1048576).toFixed(0) + 'MB';
                }
              } catch (eJH) { /* 忽略 */ }
              var ys = g.__yieldStats || null;
              sdLog('[crumb] 帧=' + __frames +
                ' used=' + (m.usedHeapSize / 1048576).toFixed(1) +
                ' total=' + (m.totalHeapSize / 1048576).toFixed(1) +
                ' avail=' + (m.totalAvailableSize / 1048576).toFixed(1) +
                ' malloc=' + (m.mallocedMemory / 1048576).toFixed(1) +
                ' peakMalloc=' + (m.peakMallocedMemory / 1048576).toFixed(1) +
                ' java堆=' + jh +
                (ys ? ' yield5s=' + ys.total + ' 热停泊=' + ys.parked : ''));
              if (typeof __logFlush === 'function') __logFlush();
            } catch (eCrumb) {
              if (!g.__crumbErrLogged) {
                g.__crumbErrLogged = true;
                try { sdLog('[crumb] 面包屑故障（只报一次）: ' + (eCrumb && eCrumb.message)); } catch (eC2) { /* 忽略 */ }
              }
            }
          }, 1000);
        }
      }
      // 每帧动态取当前 screen 与设备画布（软重启后是新对象）
      var scr = g.screen;
      if (scr !== lastScr) { lastScr = scr; liveCtx = scr.getContext('2d'); }
      var sctx = liveCtx;
      var displayCanvas = null;
      try { displayCanvas = g.document.getElementById('canvas'); } catch (eC) { /* 未就绪 */ }
      var sw = scr.width, sh = scr.height;
      var dw = displayCanvas ? displayCanvas.width : 0;
      var dh = displayCanvas ? displayCanvas.height : 0;
      // 自愈：vendor 侧（setFullScreen0 → updateCanvas 链）会在游戏启动时把
      // 设备画布往回改；发现与所选分辨率漂移立即重设（重发 canvasresize）。
      if (displayCanvas && __frames % 60 === 0 && typeof g.__getDeviceScreenSize === 'function') {
        var want = g.__getDeviceScreenSize();
        if (dw !== want.width || dh !== want.height) {
          sdLog('[present] 画布漂移 ' + dw + 'x' + dh + ' → 重设 ' + want.width + 'x' + want.height);
          g.__setDeviceScreenSize(want.width, want.height);
          dw = displayCanvas.width; dh = displayCanvas.height;
        }
      }
      if (__frames % 300 === 1) {
        // 帧时间三分账：解释器(vm) / LCDUI 原语(gfx) / 音频渲染(aud)，
        // ⚠️ other 包含 vsync 空转：满帧时（300 帧/5.0s）窗口里必然有 ≈4.4s 是
        // 等垂直同步，不能当成"别处耗时"。真实呈现成本看下面的"呈现="。
        var nowMs = Date.now();
        var winMs = nowMs - (g.__lastSplitMs || nowMs);
        g.__lastSplitMs = nowMs;
        var vmMs = g.__vmMsAcc || 0; g.__vmMsAcc = 0;
        var gfxMs = g.__gfxMsAcc || 0; g.__gfxMsAcc = 0;
        var audMs = g.__audMsAcc || 0; g.__audMsAcc = 0;
        var otherMs = Math.max(0, winMs - vmMs - gfxMs - audMs);
        var nWin = Math.max(1, Math.min(__frames - 1, 300)); // 首帧那次窗口不到 300 帧
        var pAvg = presAcc / nWin;
        sdLog('[present] 帧 ' + __frames + ' 画布=' + dw + 'x' + dh +
          (dw > dh ? ' 横屏铺满' : ' 竖屏遮罩') +
          ' | 窗口' + (winMs / 1000).toFixed(1) + 's: vm=' + (vmMs / 1000).toFixed(1) +
          's gfx=' + (gfxMs / 1000).toFixed(1) +
          's aud=' + (audMs / 1000).toFixed(1) +
          's other=' + (otherMs / 1000).toFixed(1) + 's' +
          ' | 呈现=' + pAvg.toFixed(1) + 'ms/帧(峰' + presMax + 'ms >20ms帧=' + presMiss +
          ') 清=' + (clearMsAcc / nWin).toFixed(1) + ' 游戏=' + (gameMsAcc / nWin).toFixed(1) +
          ' 上屏=' + (blitMsAcc / nWin).toFixed(1) +
          ' | 真空闲=' + ((winMs - vmMs - gfxMs - audMs - presAcc) / 1000).toFixed(1) + 's ' +
          costAllText());
        presAcc = 0; presMax = 0; presMiss = 0;
        clearMsAcc = 0; gameMsAcc = 0; blitMsAcc = 0;
      }
      if (dw > 0 && dh > 0 && sw > 0 && sh > 0) {
        var scale, cw, ch, cx, cy;
        // ---- 遮罩选择（Y 菜单，g.__maskState.sel）----
        // 任选遮罩：遮罩整图垫底铺满（两侧装饰贴屏幕边缘），游戏照常等比
        // 放大居中（整屏最少黑边）画在遮罩上层——游戏主体永不被盖。
        // 默认（default）：竖屏游戏用内置遮罩白区（旧行为），横屏铺满不叠遮罩。
        var useMask = null, useCut = null;
        var maskSelId = g.__maskState ? g.__maskState.sel : 'default';
        if (maskSelId && maskSelId !== 'default') {
          if (maskSelId === 'builtin') {
            if (maskCanvas) { useMask = maskCanvas; useCut = BUILTIN_CUT; }
          } else {
            var mkLoaded = g.__maskState.loaded;
            if (mkLoaded && mkLoaded.id === maskSelId) {
              useMask = mkLoaded.canvas; useCut = mkLoaded.cut;
            } else if (dw <= dh && maskCanvas) {
              // 用户遮罩未就绪/加载失败：回落内置遮罩（不裸黑边）
              useMask = maskCanvas; useCut = BUILTIN_CUT;
            }
          }
        } else if (dw <= dh && maskCanvas) {
          useMask = maskCanvas; useCut = BUILTIN_CUT;
        }
        if (useMask) {
          // 遮罩垫底：遮罩整图 1:1 铺满（两侧装饰贴屏幕边缘），游戏照常等比
          // 放大居中（整屏最少黑边）画在遮罩上层——中心透明窗口区域被游戏
          // 覆盖，两侧只剩装饰条，游戏主体永不被遮罩压住。
          scale = Math.min(sw / dw, sh / dh);
          cw = dw * scale; ch = dh * scale;
          cx = (sw - cw) / 2; cy = (sh - ch) / 2;
        } else if (dw > dh) {
          // 横屏游戏（320x240、640x360 等）：铺满物理屏 + 最少黑边，不叠遮罩
          scale = Math.min(sw / dw, sh / dh);
          cw = dw * scale; ch = dh * scale;
          cx = (sw - cw) / 2; cy = (sh - ch) / 2;
        } else {
          // 竖屏游戏（240x320、176x220、128x160、128x128 等）：
          // fit 遮罩白区，最近邻放大保像素锐利
          scale = Math.min(GW / dw, GH / dh);
          cw = dw * scale; ch = dh * scale;
          cx = GX + (GW - cw) / 2; cy = GY + (GH - ch) / 2;
        }
        var tClear = Date.now();
        // PATCH(perfZ25)：合成缓冲 + 一次上屏。
        // 旧写法是往可见的 screen 画布上依次 fillRect/game/mask —— 每次调用都是
        // 一次可见表面写入，实机上表现为偶发半帧（清屏后的黑屏一闪、或遮罩还没
        // 盖上去的裸画面），也就是玩家报的"黑屏闪屏"。现在全部先画进离屏
        // scene，最后只做一次整屏 1:1 拷贝：可见表面每帧只被写一次 = 原子。
        if (!scene || sceneW !== sw || sceneH !== sh) {
          try {
            scene = new g.OffscreenCanvas(sw, sh);
            sceneCtx = scene.getContext('2d');
            sceneW = sw; sceneH = sh;
            sdLog('[present] 合成缓冲 ' + sw + 'x' + sh + '（单次上屏，防半帧闪屏）');
          } catch (eScene) {
            scene = null; sceneCtx = null;
            sdLog('[present] 合成缓冲创建失败，回落直画屏幕: ' + (eScene && eScene.message));
          }
        }
        var octx = sceneCtx || sctx; // 无离屏时退化为旧行为
        try {
        octx.imageSmoothingEnabled = false; // 像素风硬边放大（防文字发糊）
        octx.fillStyle = '#000';
        octx.fillRect(0, 0, sw, sh);
        var tGame0 = Date.now();
        clearMsAcc += tGame0 - tClear;
        if (useMask) {
          // 自选遮罩：垫底铺满，游戏画在上面（装饰贴边、游戏居中盖住窗口区）
          octx.drawImage(useMask, 0, 0, sw, sh);
          octx.drawImage(displayCanvas, cx, cy, cw, ch);
        } else {
          // 默认：竖屏游戏画进内置遮罩白区后遮罩盖在上（旧行为）；横屏纯铺满
          octx.drawImage(displayCanvas, cx, cy, cw, ch);
          if (maskCanvas && dw <= dh) octx.drawImage(maskCanvas, 0, 0, sw, sh);
        }
        var tBlit0 = Date.now();
        gameMsAcc += tBlit0 - tGame0;
        if (sceneCtx) sctx.drawImage(scene, 0, 0); // 唯一的可见表面写入
        var tEnd = Date.now();
        blitMsAcc += tEnd - tBlit0;
        var presMs = tEnd - tClear;
        presAcc += presMs;
        if (presMs > presMax) presMax = presMs;
        if (presMs > 20) presMiss++; // 20ms = 掉到 50fps 以下（一帧预算 16.7ms）
        costAdd('呈现', presMs, 0);
        // 文本输入时叠加内置软键盘（左右两侧留出游戏画面；键盘本身是静态覆盖层）
        if (kbState && kbState.active) {
          sctx.imageSmoothingEnabled = false;
          drawKbOverlay(sctx, sw, sh);
        }
        } catch (eDraw) {
          // PATCH(perfZ25)：呈现层**绝不能**因一次绘制异常就断掉 rAF 链
          // （历史事故：fatal 时 return 杀掉 rAF → 之后所有游戏都停在上个画面）。
          // 离屏合成是新引入的失败点（画布被回收/尺寸异常），异常时丢掉它并回落直画。
          if (!g.__presentDrawErr) {
            g.__presentDrawErr = true;
            try { sdLog('[present] 绘制异常（只报一次，已丢掉合成缓冲回落直画）: ' + (eDraw && eDraw.message)); } catch (eP2) { /* 忽略 */ }
          }
          scene = null; sceneCtx = null; sceneW = 0; sceneH = 0;
        }
      }
      g.__noGen.requestAnimationFrame(present);
    }
    g.__noGen.requestAnimationFrame(present);
    console.log('[host] 屏幕呈现层: 竖屏居中白区 ' + GX + ',' + GY + ' ' + GW + 'x' + GH + ' + 遮罩');
    return true;
  }

  // ==================================================================
  // 3.6 存档持久化：虚拟文件系统（含 RMS 存档）落 SD 卡
  // ==================================================================
  // PluotSorbet 用 IndexedDB（asyncStorage 库，fs4 store）存虚拟文件系统，
  // J2ME RMS 存档（/RecordStore/*）也在其中。idb-shim 默认全内存，重启即丢；
  // 这里注册持久化后端：启动时读回、变更后防抖写 SD 卡 JSON 文件。
  // 文件位置：多游戏后按 jar 文件名（去 .jar 后缀）分文件夹
  //   sdmc:/switch/j2me-nx/save/<jar文件名>/idb-fs.json（Node 仿真为 save/<jar文件名>/）
  // 注意：目录名取 jar 文件名而非 MIDlet-Name 显示名——Switch 的 FAT 驱动
  // 读不了中文名文件，jar 文件名用户保证是英文；显示名可能是中文。
  // 旧版单档 data/idb-fs.json 在首次选中游戏时一次性迁移过去。
  function sanitizeName(name) {
    var s = String(name || 'game')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/[^\x20-\x7e]/g, '_') // 非 ASCII 一律折叠成 _（FAT 中文保险）
      .replace(/_{2,}/g, '_').trim();
    if (s.length > 64) s = s.slice(0, 64);
    return s || 'game';
  }
  // 同步读文件（存在性探测/迁移用）。返回 Uint8Array 或 null。
  function readFileSyncLocal(path) {
    if (IS_SWITCH) {
      if (!g.Switch || !g.Switch.readFileSync) return null;
      try { return g.Switch.readFileSync(path); } catch (e) { return null; }
    }
    try { return require('fs').readFileSync(path); } catch (e) { return null; }
  }
  function installIDBPersistence() {
    var idb = g.indexedDB;
    if (!idb || !idb.__setPersistence) return false;

    // 存档文件路径：选中游戏后确定。load 在菜单选择完成前一直等待
    //（initFS → indexedDB.open → load，本就挂在启动等待链上）。
    var saveDir = null;      // 选中后 = SAVE_ROOT/<jar文件名去后缀>
    var saveFile = null;     // = saveDir + '/idb-fs.json'
    function ensureSaveDir() {
      if (IS_SWITCH) {
        if (!g.Switch || !g.Switch.mkdirSync) return;
        try { g.Switch.mkdirSync(SAVE_ROOT); } catch (e) { /* 已存在 */ }
        try { g.Switch.mkdirSync(saveDir); } catch (e) { /* 已存在 */ }
      } else {
        try { require('fs').mkdirSync(saveDir, { recursive: true }); } catch (e) { /* 已存在 */ }
      }
    }

    // base64（nx.js 无 btoa，手写）
    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    function bytesToBase64(bytes) {
      var out = '';
      var i;
      for (i = 0; i + 2 < bytes.length; i += 3) {
        var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
      }
      var rem = bytes.length - i;
      if (rem === 1) {
        var n1 = bytes[i] << 16;
        out += B64[(n1 >> 18) & 63] + B64[(n1 >> 12) & 63] + '==';
      } else if (rem === 2) {
        var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += B64[(n2 >> 18) & 63] + B64[(n2 >> 12) & 63] + B64[(n2 >> 6) & 63] + '=';
      }
      return out;
    }
    function base64ToBytes(b64) {
      var clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
      var len = clean.length;
      var out = new Uint8Array(Math.floor(len * 3 / 4));
      var o = 0, i, buf = 0, bits = 0;
      for (i = 0; i < len; i++) {
        buf = (buf << 6) | B64.indexOf(clean.charAt(i));
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          out[o++] = (buf >> bits) & 0xff;
        }
      }
      return out.subarray(0, o);
    }

    // record.data 是虚拟 Blob → base64；恢复时反向。补 pathname（fs.js Store
    // 恢复后用 record.pathname 作 map key）。
    function serialize(db) {
      var out = {};
      for (var sn in db._stores) {
        var obj = {};
        db._stores[sn].forEach(function (v, k) {
          if (v === null || v === undefined) return; // 删除标记不落盘
          var rec = { pathname: k };
          for (var f in v) {
            if (f === 'pathname' || f === 'data') continue;
            rec[f] = v[f];
          }
          if (v.data && typeof v.data.getBytes === 'function') {
            rec.data_b64 = bytesToBase64(v.data.getBytes());
          }
          obj[k] = rec;
        });
        out[sn] = obj;
      }
      return out;
    }

    var saveTimer = null;
    function writeNow(db) {
      if (!saveFile) { console.error('[host] 存档写入跳过：尚未选择游戏'); return; }
      try {
        var json = JSON.stringify(serialize(db));
        var bytes = new TextEncoder().encode(json);
        if (IS_SWITCH) {
          // Switch.writeFileSync 是实机验证过的写卡 API（fs.promises.writeFile 不可靠）
          if (!g.Switch || !g.Switch.writeFileSync) {
            console.error('[host] Switch.writeFileSync 不存在，存档未落盘');
            return;
          }
          g.Switch.writeFileSync(saveFile, bytes);
        } else {
          require('fs').writeFileSync(saveFile, Buffer.from(bytes));
        }
        console.log('[host] 存档已写入 ' + saveFile + '（' + bytes.length + ' 字节）');
      } catch (e) {
        console.error('[host] 存档写入失败: ' + (e && e.stack || e));
      }
    }

    idb.__setPersistence('asyncStorage', {
      load: function () {
        // 等菜单选完游戏才知道读哪个存档文件
        return g.__gameSelection.then(function (sel) {
          saveDir = SAVE_ROOT + '/' + sanitizeName(
            String(sel.file || '').replace(/^.*[\\/]/, '').replace(/\.jar$/i, '') || sel.name);
          saveFile = saveDir + '/idb-fs.json';
          ensureSaveDir();
          // 旧档迁移：per-game 文件不存在且旧单档存在 → 搬过来（一次性）
          var haveGame = false;
          try { haveGame = !!readFileSyncLocal(saveFile); } catch (e) { }
          if (!haveGame) {
            try {
              var legacy = readFileSyncLocal(SAVE_LEGACY);
              if (legacy) {
                if (IS_SWITCH) {
                  g.Switch.writeFileSync(saveFile, legacy);
                  try { g.Switch.unlinkSync ? g.Switch.unlinkSync(SAVE_LEGACY) : 0; }
                  catch (eU) { /* 删不掉就留着，无害 */ }
                } else {
                  require('fs').writeFileSync(saveFile, legacy);
                }
                sdLog('[save] 旧存档已迁移: ' + SAVE_LEGACY + ' -> ' + saveFile);
              }
            } catch (eL) { /* 无旧档，正常 */ }
          }
          return readFileBytes(saveFile);
        }).then(function (bytes) {
          var data = JSON.parse(new TextDecoder().decode(bytes));
          // 还原 Blob
          for (var sn in data) {
            var obj = data[sn];
            for (var k in obj) {
              var rec = obj[k];
              if (rec && rec.data_b64) {
                rec.data = new Blob([base64ToBytes(rec.data_b64)]);
                delete rec.data_b64;
              }
            }
          }
          console.log('[host] 存档已从 ' + saveFile + ' 读回');
          return data;
        }, function () {
          // 首次运行无存档文件，空库起步
          return {};
        });
      },
      save: function (db) {
        // 防抖合并：连续写档只落盘一次（500ms 窗口），writeNow 读的是活 Map
        if (saveTimer) return;
        saveTimer = setTimeout(function () {
          saveTimer = null;
          writeNow(db);
        }, 500);
      },
    });
    // MIDlet 退出前强制落盘：先 syncStore（fs 内存 → IDB，触发计数归零），
    // IDB put 完成后立即写 SD，回调通知可以安全退出
    g.__flushIDBPersistence = function (done) {
      var finish = function () {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        var db = idb.__getDatabase('asyncStorage');
        if (db) writeNow(db);
        if (done) done();
      };
      try {
        if (g.fs && g.fs.syncStore) {
          g.fs.syncStore(function () { setTimeout(finish, 50); });
        } else {
          finish();
        }
      } catch (e) {
        console.error('[host] 存档 flush 异常: ' + (e && e.message || e));
        finish();
      }
    };
    return true;
  }

  // ==================================================================
  // 4. 退出处理
  // ==================================================================

  g.__onMidletExit = function () {
    console.log('[host] MIDlet 已退出');
    sdLog('[exit] MIDlet 正常退出');
    if (typeof g.__logFlush === 'function') {
      try { g.__logFlush(); } catch (e) { /* 忽略 */ } // 退出前确保日志落卡
    }
    var doExit = function () {
      if (IS_SWITCH && typeof g.Switch !== 'undefined') {
        // 游戏内退出 → 回到游戏选择菜单（软重启），不再退整个模拟器。
        // 走 __requestGameQuit 的存档+过渡屏流程；它自己检查 __gameRunning。
        if (typeof g.__requestGameQuit === 'function') {
          g.__requestGameQuit('MIDlet 正常退出');
        } else {
          try { g.Switch.exit(); } catch (e) { console.error(e); }
        }
      } else if (IS_NODE) {
        process.exit(0);
      }
    };
    // 强制落盘存档后退出（清除防抖窗口 + sync 内存 fs → IDB → SD 卡）
    if (typeof g.__flushIDBPersistence === 'function') {
      try { g.__flushIDBPersistence(doExit); return; } catch (e) { console.error(e); }
    }
    doExit();
  };

  // ==================================================================
  // 主流程
  // ==================================================================

  // ==================================================================
  // 5. 游戏选择菜单：扫描 sdmc:/switch/java 下全部 .jar，名字取自
  //    META-INF/MANIFEST.MF（MIDlet-Name，缺省回落 MIDlet-1/文件名），
  //    入口类取 MIDlet-1 第三字段。选中后 midlet.jar 资源与存档读取
  //    才被放行（__gameSelection 闸门），遮罩呈现层也在此之后安装。
  // ==================================================================

  // 解析一个 jar 的 MANIFEST.MF → {file, absPath, name, midletClass, manifest}
  function parseJarManifest(absPath, fileName) {
    var entry = { file: fileName, absPath: absPath, name: null,
                  midletClass: null, manifest: {} };
    try {
      var u8 = readFileSyncLocal(absPath);
      if (u8 && typeof ZipFile === 'function') {
        // Switch.readFileSync 返回 ArrayBuffer 本体；Node 返回 Buffer。
        // 统一规整成 ArrayBuffer 再喂 ZipFile。
        var ab = u8 instanceof ArrayBuffer
          ? u8
          : (u8.buffer
              ? u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
              : new Uint8Array(u8).buffer);
        var zf = new ZipFile(ab, false);
        var mf = zf && zf.directory ? zf.read('META-INF/MANIFEST.MF') : null;
        if (mf) {
          // Manifest 规范：续行以单个空格开头，接回上一行（去掉该空格直接拼接；
          // 若替换成空格会把类名读成 "dkii.GameMIDle t" —— AHQSL 根因）
          var text = new TextDecoder().decode(mf)
            .replace(/\r\n|\r/g, '\n').replace(/\n /g, '');
          text.split('\n').forEach(function (line) {
            var c = line.indexOf(':');
            if (c <= 0) return;
            var k = line.slice(0, c).trim(), v = line.slice(c + 1).trim();
            if (k) entry.manifest[k] = v;
          });
          entry.name = entry.manifest['MIDlet-Name'] || null;
          var m1 = entry.manifest['MIDlet-1'];
          if (m1) {
            var parts = m1.split(',');
            if (!entry.name && parts[0]) entry.name = parts[0].trim();
            if (parts.length >= 3 && parts[2].trim()) {
              entry.midletClass = parts[2].trim().replace(/\//g, '.');
            }
          }
        }
      }
    } catch (e) {
      sdLog('[menu] 解析 ' + fileName + ' 失败: ' + (e && e.message));
    }
    if (!entry.name) entry.name = fileName.replace(/\.jar$/i, '');
    return entry;
  }

  // ---- 游戏原生分辨率探测 ----
  // 线索 1（快）：jar 条目名里的 WxH 模式——多分辨率包惯例按目录分
  //   （176x220/、128x160/、320X240/ 等），目录命中权重高于散文件。
  // 线索 2（慢）：PNG IHDR 实际尺寸统计——单分辨率包的资源尺寸=原生分辨率，
  //   限制解压总量防止大 jar 拖慢启动。
  // 都没有 → 默认 240x320。结果仅供 __setDeviceScreenSize 应用。
  // 标准 J2ME 手机分辨率表（宽高排序归一化存储，兼容横竖屏双向命中）
  var STD_RESOLUTIONS = [
    '128x128', '128x160', '132x176', '176x182', '176x200', '176x208',
    '176x220', '208x208', '240x260', '240x300', '240x320', '240x400',
    '240x432', '320x480', '352x416', '360x640', '480x640', '480x800',
    '480x854', '540x960',
  ];
  function detectGameResolution(absPath) {
    var res = { w: 240, h: 320, how: '默认' };
    try {
      var u8 = readFileSyncLocal(absPath);
      if (!u8 || typeof ZipFile !== 'function') return res;
      var ab = u8 instanceof ArrayBuffer
        ? u8
        : (u8.buffer
            ? u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
            : new Uint8Array(u8).buffer);
      var zf = new ZipFile(ab, false);
      if (!zf || !zf.directory) return res;
      var names = Object.keys(zf.directory);

      function validSize(w, h) {
        if (w < 96 || h < 96 || w > 1280 || h > 1280) return false;
        // 必须命中标准 J2ME 手机分辨率表（宽高排序归一化，横竖屏通吃）。
        // 否则精灵图/图标尺寸（如 150x150）会被误判为屏幕分辨率。
        var lo = Math.min(w, h), hi = Math.max(w, h);
        var key = lo + 'x' + hi;
        return STD_RESOLUTIONS.indexOf(key) >= 0;
      }

      // 线索 1：条目名
      var counts = Object.create(null);
      var rx = /(?:^|[^0-9])(\d{2,4})[xX](\d{2,4})(?:[^0-9]|$)/;
      for (var i = 0; i < names.length; i++) {
        var m = rx.exec(names[i]);
        if (!m) continue;
        var w0 = +m[1], h0 = +m[2];
        if (!validSize(w0, h0)) continue;
        var key = w0 + 'x' + h0;
        // 目录名（路径中出现）权重 x2：多分辨率包按目录组织，最可靠
        counts[key] = (counts[key] || 0) + (names[i].indexOf('/') >= 0 ? 2 : 1);
      }
      var best = null, bestScore = 0;
      for (var k in counts) {
        var p = k.split('x');
        var score = counts[k] * 1e6 + ((+p[0]) * (+p[1])); // 频次优先，面积破平
        if (score > bestScore) { bestScore = score; best = k; }
      }
      if (best) {
        var pp = best.split('x');
        res.w = +pp[0]; res.h = +pp[1];
        res.how = '条目名';
        return res;
      }

      // 线索 2：PNG IHDR 统计
      var pngCount = Object.create(null);
      var inflated = 0, scanned = 0;
      for (var j = 0; j < names.length && scanned < 150 && inflated < 6 * 1024 * 1024; j++) {
        var nm = names[j];
        if (!/\.png$/i.test(nm)) continue;
        var data = null;
        try { data = zf.read(nm); } catch (eR) { continue; }
        if (!data || data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50) continue;
        inflated += data.length; scanned++;
        var pw = ((data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19]) >>> 0;
        var ph = ((data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23]) >>> 0;
        if (!validSize(pw, ph)) continue;
        var pk = pw + 'x' + ph;
        pngCount[pk] = (pngCount[pk] || 0) + 1;
      }
      var bestPng = null, bestN = 0, bestArea = 0;
      for (var k2 in pngCount) {
        var p2 = k2.split('x');
        var a2 = (+p2[0]) * (+p2[1]);
        if (pngCount[k2] > bestN || (pngCount[k2] === bestN && a2 > bestArea)) {
          bestN = pngCount[k2]; bestArea = a2; bestPng = k2;
        }
      }
      if (bestPng && bestN >= 2) {
        var p3 = bestPng.split('x');
        res.w = +p3[0]; res.h = +p3[1];
        res.how = 'PNG尺寸x' + bestN;
      }
    } catch (e) {
      sdLog('[detect] 分辨率探测失败: ' + (e && e.message));
    }
    return res;
  }

  var __gameDir = null; // 实际扫描的目录（仿真指定 jar 时会偏离 GAME_ROOT）

  function listGameJars() {
    var names = [];
    __gameDir = GAME_ROOT;
    if (IS_SWITCH) {
      try {
        try { g.Switch.mkdirSync(GAME_ROOT); } catch (e) { /* 已存在 */ }
        var all = g.Switch.readDirSync(GAME_ROOT) || [];
        for (var i = 0; i < all.length; i++) {
          if (/\.jar$/i.test(all[i])) names.push(all[i]);
        }
        names.sort();
      } catch (e) {
        sdLog('[menu] 扫描 ' + GAME_ROOT + ' 失败: ' + (e && e.message));
      }
    } else {
      try {
        // 批量仿真支持：J2ME_TEST_JAR=完整路径 时只看这一个 jar；
        // J2ME_TEST_GAMEDIR=目录 时扫指定目录（菜单 UI 仿真用）
        var dir = GAME_ROOT, filter = null;
        if (process.env.J2ME_TEST_GAMEDIR) {
          dir = process.env.J2ME_TEST_GAMEDIR;
          __gameDir = dir;
        }
        if (process.env.J2ME_TEST_JAR) {
          var pf = require('path');
          dir = pf.dirname(process.env.J2ME_TEST_JAR);
          filter = pf.basename(process.env.J2ME_TEST_JAR);
          __gameDir = dir;
        }
        names = require('fs').readdirSync(dir)
          .filter(function (f) { return /\.jar$/i.test(f) && (!filter || f === filter); }).sort();
      } catch (e) {
        sdLog('[menu] 扫描 ' + GAME_ROOT + ' 失败: ' + (e && e.message));
      }
    }
    return names;
  }

  // 游戏列表"上次停在哪儿"（2026-09-23 perfZ6 用户反馈：进游戏后按 + 回列表被打回第一页）。
  // ⚠️ 必须是**模块级**：按 + 回列表走的是软重启（startSession → boot → runGameMenu），
  // 只重新求值 vendor bundle（bld/main-all.js），app/main.js 这个模块不会重新加载，
  // 所以这里的变量能活下来；写在 runGameMenu 里面就每次归零（旧行为）。
  var menuSel = 0;
  function runGameMenu() {
    var files = listGameJars();
    var scanDir = __gameDir || GAME_ROOT;
    sdLog('[menu] ' + scanDir + ' 共 ' + files.length + ' 个 jar');
    if (!files.length) {
      sdLog('[menu] 没有游戏，上屏提示后退出');
      showFatalError(T('没有找到游戏'),
        T('SD 卡 java 文件夹是空的。') + '\n' +
        T('请把游戏 .jar 放进 sdmc:/switch/java 后重新启动本软件。'));
      setTimeout(function () {
        try { g.Switch.exit(); } catch (e) { /* 忽略 */ }
      }, 6000);
      return new Promise(function () { /* 永不 resolve，等待退出 */ });
    }

    var entries = [];
    var nameMap = loadGameNames();
    sdLog('[menu] 扫描开始（' + files.length + ' 个 jar）');
    memSnapshot('菜单扫描前');
    if (typeof __logFlush === 'function') __logFlush();
    for (var i = 0; i < files.length; i++) {
      var en = null;
      try {
        en = parseJarManifest(scanDir + '/' + files[i], files[i]);
      } catch (eScan) {
        // 单个 jar 解析失败不拖垮整个列表（实机见过的 zip 损坏场景）
        sdLog('[menu] 解析失败 ' + files[i] + ': ' + (eScan && eScan.message));
        en = { file: files[i], name: files[i], midletClass: null, manifest: {} };
      }
      entries.push(en);
      if (i % 50 === 49 || i === files.length - 1) {
        // 探针：无声退出若发生在扫描期，这里能钉到具体区段（native abort 不写日志）
        sdLog('[menu] 扫描进度 ' + (i + 1) + '/' + files.length);
        // PATCH(perfZ14)：扫描期每 100 个 jar 主动回收一次。
        // 实测（2026-09-23 14:10，381 个 jar）：每 50 个涨 ~6.5MB、全程 ~50MB，而这些
        // 几乎都是"读进来解析完就没人要"的 jar 字节与中间字符串。紧档（425MB）历史上
        // 堆到 ~86MB 就 fatal，所以这一步在紧档里等于保命；--expose-gc 已在 ini 里。
        if (i % 100 === 99) {
          var usedS = '?', usedS2 = '?';
          try { usedS = (g.Switch.memoryUsage().usedHeapSize / 1048576).toFixed(1); } catch (eM1) { /* 忽略 */ }
          try { if (typeof globalThis.gc === 'function') globalThis.gc(); } catch (eG) { /* 忽略 */ }
          try { usedS2 = (g.Switch.memoryUsage().usedHeapSize / 1048576).toFixed(1); } catch (eM2) { /* 忽略 */ }
          sdLog('[menu] 扫描期回收：used ' + usedS + 'MB → ' + usedS2 + 'MB');
        }
        memSnapshot('扫描' + (i + 1));
        if (typeof __logFlush === 'function') __logFlush();
      }
    }
    for (var j = 0; j < entries.length; j++) {
      // 应用自定义显示名（改名功能）；原名保留供改名预填
      if (nameMap[entries[j].file]) {
        entries[j].orgName = entries[j].name;
        entries[j].name = nameMap[entries[j].file];
      }
      sdLog('[menu] #' + (j + 1) + ' ' + entries[j].name +
        (entries[j].midletClass ? '' : '（无入口类）') + ' <- ' + entries[j].file);
    }

    // Node 仿真无输入 UI：自动选第一个有入口类的游戏。
    // J2ME_TEST_MENU=1 时例外——跑真菜单 UI（配合脚本手柄做 E2E 测试）
    if (!IS_SWITCH && !(typeof process !== 'undefined' &&
        process.env && process.env.J2ME_TEST_MENU)) {
      var pick = null;
      for (var n = 0; n < entries.length; n++) {
        if (entries[n].midletClass) { pick = entries[n]; break; }
      }
      if (!pick) throw new Error('没有可启动的游戏（jar 缺 MIDlet-1 入口）');
      sdLog('[menu] Node 仿真自动选择: ' + pick.name);
      return Promise.resolve(pick);
    }

    return new Promise(function (resolveMenu) {
      var scr = g.screen;
      var ctx = scr.getContext('2d');
      var W = scr.width, H = scr.height;
      var rowH = 58, top = 150;
      var maxRows = Math.max(1, Math.floor((H - top - 110) / rowH));
      // 起手位置 = 上次离开列表时的那一项（"+" 回列表停在同一页/同一项，不再回第一页）。
      // 列表条目数可能变过（删了 jar），所以照样夹一次范围。
      var lastIdx = Math.min(Math.max(0, menuSel), Math.max(0, entries.length - 1));
      var sel = lastIdx, scroll = Math.min(Math.floor(lastIdx / maxRows) * maxRows,
        Math.max(0, entries.length - 1));
      var done = false;
      // 模式：list 主列表 | res 分辨率 | act 游戏菜单(改名/删除) | del 删除确认
      // rename = 系统键盘输入中（此模式下游戏键全部让位给键盘）
      var actSel = 0, delSel = 0, delErr = '';
      var ACT_ITEMS = ['启动', '改名', '选择遮罩', '按键映射', '按键机型', '删除', '返回列表'];

      function pageOf(s) { return Math.min(Math.max(0, s), Math.max(0, entries.length - 1)); }

      // 右对齐画一行（菜单里只有右上角提示用得到）：宽度优先问宿主测量器，      // 测不到就按"ASCII ≈0.55em / 其它 ≈1em"估算 —— 只是提示文字，差几像素无妨。
      function drawTextRight(text, rightX, y, px) {
        ctx.font = px + 'px "j2mecjk", monospace';
        var w = 0;
        try {
          if (typeof g.__hostMeasureText === 'function') w = g.__hostMeasureText(ctx.font, text) || 0;
        } catch (eM) { w = 0; }
        if (!w) {
          for (var i = 0; i < text.length; i++) {
            w += (text.charCodeAt(i) < 0x2e80) ? px * 0.55 : px;
          }
        }
        ctx.fillText(text, Math.max(8, rightX - w), y);
      }

      var menuDrawErr = 0;   // 列表绘制异常计数（见 draw() 的 catch：前 3 次落日志）

      function draw() {
        try {
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, W, H);
          ctx.fillStyle = '#ffffff';
          ctx.font = '44px "j2mecjk", monospace';
          ctx.fillText(T('选择游戏 ({1})', entries.length), 80, 96);
          ctx.fillStyle = '#7fa87f';
          ctx.font = '22px "j2mecjk", monospace';
          var pages = Math.max(1, Math.ceil(entries.length / maxRows));
          ctx.fillText(T('第 {1}/{2} 页', Math.floor(scroll / maxRows) + 1, pages), W - 260, 96);
          // 右上角双语提示（2026-09-23 perfZ21 用户要求）：中英**各一行常显**。
          // 两行都是固定字面量、不进字典 —— 英文界面下中文用户也要能看懂怎么切回来。
          ctx.fillStyle = '#5f8f5f';
          drawTextRight('按 ZR+ZL 切换中/英文', W - 40, 34, 19);
          drawTextRight('Press ZR+ZL to switch language', W - 40, 60, 19);
          ctx.fillStyle = '#8fc98f';
          ctx.font = '26px "j2mecjk", monospace';
          ctx.fillText(T('A 启动   X 分辨率   Y 菜单(改名/遮罩/按键/删除)   L/R 翻页(循环)'), 80, H - 56);
          ctx.fillStyle = '#6f9f6f';
          ctx.font = '22px "j2mecjk", monospace';
          ctx.fillText(T('游戏内: A=确认 B=5 X=1 Y=3 L=* R=# ZL/ZR=软键 L3=7 R3=9 -=0 +=退出'), 80, H - 22);
          for (var r = 0; r < maxRows && r + scroll < entries.length; r++) {
            var idx = r + scroll, en = entries[idx];
            var y = top + r * rowH;
            if (idx === sel) {
              ctx.fillStyle = '#1c3f7a';
              ctx.fillRect(56, y - 40, W - 112, rowH - 6);
            }
            ctx.fillStyle = idx === sel ? '#ffffff' : '#a8a8a8';
            ctx.font = '30px "j2mecjk", monospace';
            ctx.fillText((idx === sel ? '▶ ' : '  ') + en.name +
              (en.midletClass ? '' : T('（无入口）')) +
              (en.orgName ? '  ✎' : '') +
              (overrides[en.file] ? '  [' + overrides[en.file] + ']' : ''), 84, y);
            ctx.fillStyle = '#6c6c6c';
            ctx.font = '19px "j2mecjk", monospace';
            ctx.fillText(en.file, 118, y + 22);
          }
        } catch (e) {
          // 这个 catch 以前是静默的 —— 于是"切完语言菜单就再也不画了"这种问题只能
          // 靠盯屏猜（2026-09-23 perfZ21 端到端测试里真踩到）。绘制异常本来就罕见，
          // 报前 3 次 + 计数即可，别每帧刷屏。
          menuDrawErr = (menuDrawErr || 0) + 1;
          if (menuDrawErr <= 3) {
            sdLog('[menu] 列表绘制异常 #' + menuDrawErr + ': ' +
              (e && (e.stack || e.message) || e));
          }
        }
        if (mode === 'res') drawResPanel();
        else if (mode === 'act') drawActPanel();
        else if (mode === 'mask') drawMaskPanel();
        else if (mode === 'keymap') drawKeyMapPanel();
        else if (mode === 'profile') drawProfPanel();
        else if (mode === 'del') drawDelPanel();
        else if (mode === 'rename') drawRenameBanner();
        else if (mode === 'lang') drawLangPanel();
        // 切语言后的 3 秒确认条（画在最上层；到点由 applyLang 里的定时器清掉并重绘）
        if (langToast && Date.now() < langToastUntil) {
          try {
            ctx.fillStyle = '#ffd479';
            ctx.font = '24px "j2mecjk", monospace';
            ctx.fillText(langToast, 60, H - 96);
          } catch (eT) { /* 忽略 */ }
        }
      }

      function move(d) {
        var ns = Math.min(entries.length - 1, Math.max(0, sel + d));
        if (ns === sel) return;
        sel = ns;
        if (sel < scroll) scroll = sel;
        if (sel >= scroll + maxRows) scroll = sel - maxRows + 1;
        menuSel = sel;   // 记住：+"回列表"要停在附近
        draw();
      }

      // L/R 翻页：**循环**（2026-09-23 perfZ6 用户要求）。
      // 旧实现 pageOf() 把下标夹在 [0, len-1]，于是首页按 L、末页按 R 都毫无反应，
      // 长列表想从末页回首页得一路按回去。现在按"页"取模：末页 R → 首页、首页 L → 末页，
      // 并尽量停在页内同一行（第 3 行翻页后还是第 3 行）。
      function page(d) {
        var pages = Math.max(1, Math.ceil(entries.length / maxRows));
        if (pages <= 1) return;                       // 只有一页：翻页无意义
        var cur = Math.min(pages - 1, Math.floor(sel / maxRows));
        var nxt = ((cur + d) % pages + pages) % pages; // 循环
        var row = sel - cur * maxRows;                 // 页内行号（尽量保留）
        sel = Math.min(nxt * maxRows + row, entries.length - 1);
        scroll = Math.min(nxt * maxRows, Math.max(0, entries.length - 1));
        menuSel = sel;
        draw();
      }

      function confirm() {
        var en = entries[sel];
        if (!en.midletClass) { draw(); return; } // 无入口不可启动
        menuSel = sel;   // 启动前记下位置：+"回列表"就停在这个游戏上
        done = true;
        try {
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, W, H);
        } catch (e) { /* 忽略 */ }
        resolveMenu(en);
      }

      // ---- X 键分辨率选择器 ----
      // nx.js 手柄是 Xbox 标准布局，与 Switch 物理键位相反：
      // 索引 0=Switch物理B  1=物理A  2=物理Y  3=物理X  12/13=十字上/下。
      // 12 档：覆盖常见 J2ME 分辨率。注意"万能壳"游戏（如彩虹城堡系列，
      // 240x320 屏内居中一块硬编码的内容区）的 jar 名/PNG 往往标的是内容区
      // 尺寸，探测会选小——必须手动选外壳分辨率（如 240x320）才不裁切。
      var RES_OPTIONS = ['auto', '128x128', '128x160', '176x200', '176x208',
        '176x220', '208x208', '240x260', '240x320',
        '320x240', '360x640', '640x360'];
      var overrides = loadResOverrides();
      var mode = 'list';   // 'list' 主列表 | 'res' 分辨率面板
      var resSel = 0;

      function openRes() {
        var cur = overrides[entries[sel].file] || 'auto';
        resSel = Math.max(0, RES_OPTIONS.indexOf(cur));
        mode = 'res';
        draw();
      }

      function pickRes() {
        var en = entries[sel];
        var opt = RES_OPTIONS[resSel];
        if (opt === 'auto') delete overrides[en.file];
        else overrides[en.file] = opt;
        saveResOverrides();
        sdLog('[menu] ' + en.file + ' 分辨率手动指定: ' + opt);
        mode = 'list';
        draw();
      }

      function drawResPanel() {
        try {
          var en = entries[sel];
          ctx.globalAlpha = 0.88;
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
          var pw = 640, ph = 118 + RES_OPTIONS.length * 44 + 58;
          var px = (W - pw) / 2, py = (H - ph) / 2;
          ctx.fillStyle = '#101828';
          ctx.fillRect(px, py, pw, ph);
          ctx.strokeStyle = '#3a6ea8';
          ctx.strokeRect(px, py, pw, ph);
          ctx.fillStyle = '#ffffff';
          ctx.font = '30px "j2mecjk", monospace';
          ctx.fillText(T('分辨率设置'), px + 40, py + 50);
          ctx.fillStyle = '#9ab0c8';
          ctx.font = '19px "j2mecjk", monospace';
          ctx.fillText(T('{1}（{2}）', en.name, en.file), px + 40, py + 84);
          for (var i = 0; i < RES_OPTIONS.length; i++) {
            var oy = py + 122 + i * 44;
            var isCur = (overrides[en.file] || 'auto') === RES_OPTIONS[i];
            ctx.fillStyle = i === resSel ? '#1c3f7a' : '#000000';
            ctx.fillRect(px + 30, oy - 28, pw - 60, 38);
            ctx.fillStyle = i === resSel ? '#ffffff' : '#a8a8a8';
            ctx.font = '24px "j2mecjk", monospace';
            var label = RES_OPTIONS[i] === 'auto' ? T('自动探测') : RES_OPTIONS[i];
            if (RES_OPTIONS[i] !== 'auto') {
              var pp = RES_OPTIONS[i].split('x');
              label += +pp[0] > +pp[1] ? T('  横屏铺满') : T('  竖屏遮罩');
            }
            ctx.fillText((i === resSel ? '▶ ' : '  ') + label + (isCur ? '  ●' : ''),
              px + 44, oy);
          }
          ctx.fillStyle = '#8fc98f';
          ctx.font = '23px "j2mecjk", monospace';
          ctx.fillText(T('A 确认   B 返回'), px + 40, py + ph - 34);
        } catch (e) { /* 面板绘制失败不崩宿主 */ }
      }

      // ---- Y 键游戏菜单：启动 / 改名（系统键盘） / 删除（二次确认） ----
      function openAct() {
        sdLog('[menu] 打开游戏菜单: ' + entries[sel].file);
        actSel = 0;
        mode = 'act';
        draw();
      }

      function drawActPanel() {
        try {
          var en = entries[sel];
          if (!en) return;
          ctx.globalAlpha = 0.88;
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
          var pw = 560, ph = 150 + ACT_ITEMS.length * 56 + 50;
          var px = (W - pw) / 2, py = (H - ph) / 2;
          ctx.fillStyle = '#101828';
          ctx.fillRect(px, py, pw, ph);
          ctx.strokeStyle = '#3a6ea8';
          ctx.strokeRect(px, py, pw, ph);
          ctx.fillStyle = '#ffffff';
          ctx.font = '30px "j2mecjk", monospace';
          ctx.fillText(T('游戏操作'), px + 40, py + 50);
          ctx.fillStyle = '#9ab0c8';
          ctx.font = '20px "j2mecjk", monospace';
          var nm = en.name.length > 18 ? en.name.slice(0, 18) + '…' : en.name;
          ctx.fillText(nm, px + 40, py + 84);
          for (var i = 0; i < ACT_ITEMS.length; i++) {
            var oy = py + 120 + i * 56;
            ctx.fillStyle = i === actSel ? '#1c3f7a' : '#000000';
            ctx.fillRect(px + 30, oy - 30, pw - 60, 46);
            ctx.fillStyle = i === actSel ? '#ffffff' : '#a8a8a8';
            ctx.font = '26px "j2mecjk", monospace';
            var hot = ACT_ITEMS[i] === '删除' ? T('（不可恢复）') : '';
            ctx.fillText((i === actSel ? '▶ ' : '  ') + T(ACT_ITEMS[i]) + hot, px + 44, oy);
          }
          ctx.fillStyle = '#8fc98f';
          ctx.font = '22px "j2mecjk", monospace';
          ctx.fillText(T('A 确认   B 返回'), px + 40, py + ph - 30);
        } catch (e) { /* 面板绘制失败不崩宿主 */ }
      }

      function actPick() {
        var en = entries[sel];
        var item = ACT_ITEMS[actSel];
        sdLog('[menu] 游戏菜单选择: ' + item);
        if (item === '启动') {
          if (en.midletClass) { confirm(); }
          return;
        }
        if (item === '改名') { startRename(); return; }
        // PATCH(perfL 2026-09-23)：这一行曾被吞掉 —— ACT_ITEMS 里有"选择遮罩"、
        // openMaskSel/drawMaskPanel/mask 模式按键分支/8 张 raw 全都在，唯独这里没有
        // 分发，于是按 A 直接落到下面的 mode='list' 回列表，表现就是"选不了遮罩"。
        // 新增 tests/menu-items.test.mjs 守住这类"菜单项没有对应分发"的漏改。
        if (item === '选择遮罩') { openMaskSel(); return; }
        if (item === '按键映射') { openKeyMap(); return; }
        if (item === '按键机型') { openProfSel(); return; }
        if (item === '删除') { delSel = 0; delErr = ''; mode = 'del'; draw(); return; }
        mode = 'list';
        draw();
      }

      // ---- 选择遮罩面板：default / 内置 + 8 张自绘遮罩（4横屏+4竖屏）----
      // 选择全局生效（所有游戏共用），sdmc:/switch/j2me-nx/mask.json 持久化；
      // 遮罩垫底铺满，游戏等比居中画在上层，横竖屏都不会被遮罩盖住。
      var maskSelIdx = 0;
      var maskScroll = 0; // 可见窗口顶（长列表滚动）
      var MASK_ROWS = 8;
      function maskList() {
        // 默认 + 内置（builtin + 8 张自绘）+ SD 自定义（每次打开面板前已重扫）
        var sd = sdMasks.map(function (m) { return { id: m.id, name: 'SD: ' + m.label }; });
        return [{ id: 'default', name: '默认（竖屏内置遮罩，横屏铺满）' }].concat(MASK_DEFS, sd);
      }
      function openMaskSel() {
        try { refreshSdMasks(); } catch (eRs) { /* 扫描失败保持旧表 */ }
        var cur = (g.__maskState && g.__maskState.sel) || 'default';
        var defs = maskList();
        maskLog('打开面板：共 ' + defs.length + ' 项（含 SD ' + sdMasks.length + ' 张），当前=' + cur +
          maskMemLine());
        maskSelIdx = 0;
        for (var i = 0; i < defs.length; i++) {
          if (defs[i].id === cur) { maskSelIdx = i; break; }
        }
        maskScroll = Math.max(0, Math.min(maskSelIdx - MASK_ROWS + 1, defs.length - MASK_ROWS));
        if (maskScroll < 0) maskScroll = 0;
        mode = 'mask';
        draw();
      }
      function drawMaskPanel() {
        try {
          var defs = maskList();
          var cur = (g.__maskState && g.__maskState.sel) || 'default';
          ctx.globalAlpha = 0.88;
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
          var rows = Math.min(MASK_ROWS, defs.length);
          var pw = 780, ph = 118 + rows * 44 + 84;
          var px = (W - pw) / 2, py = (H - ph) / 2;
          ctx.fillStyle = '#101828';
          ctx.fillRect(px, py, pw, ph);
          ctx.strokeStyle = '#3a6ea8';
          ctx.strokeRect(px, py, pw, ph);
          ctx.fillStyle = '#ffffff';
          ctx.font = '30px "j2mecjk", monospace';
          ctx.fillText(T('选择遮罩'), px + 40, py + 50);
          // ⚠️ 这两行必须塞进面板宽度：面板 pw=780、文字从 px+40 起 → 可用约 700px。
          // 19px 等宽字体下 CJK ≈19px/字、ASCII ≈10px/字，所以一行别超过约 36 个汉字。
          // （2026-09-23 用户反馈"提示超长"：旧文案把路径 + 规格 + 文件名规则全写一行，
          //  实际约 1300px，直接冲出面板右边被截断。详细规则在 SD 卡上的
          //  masks/说明.txt 里，面板只留最短的一句。）
          ctx.fillStyle = '#9ab0c8';
          ctx.font = '19px "j2mecjk", monospace';
          ctx.fillText(T('遮罩垫底，游戏居中（A 立即生效）'), px + 40, py + 84);
          ctx.fillStyle = '#8fc98f';
          ctx.fillText(T('自加遮罩：{1} 放 1280x720 png/raw', MASK_DIR),
            px + 40, py + 110);
          for (var vi = 0; vi < rows + 1; vi++) {
            var i = maskScroll + vi;
            if (i >= defs.length) break;
            var d = defs[i];
            var oy = py + 150 + vi * 44;
            ctx.fillStyle = i === maskSelIdx ? '#1c3f7a' : '#000000';
            ctx.fillRect(px + 30, oy - 28, pw - 60, 38);
            ctx.fillStyle = i === maskSelIdx ? '#ffffff' : '#a8a8a8';
            ctx.font = '24px "j2mecjk", monospace';
            // T(d.name)：内置遮罩名进字典；SD 自定义遮罩名是玩家自己的文件名
            //（'SD: xxx'）——查不到就原样显示，绝不吞掉。
            var label = (i === maskSelIdx ? '▶ ' : '  ') + T(d.name);
            if (d.id === cur) label += T('  ●当前');
            ctx.fillText(label, px + 44, oy);
          }
          ctx.fillStyle = '#8fc98f';
          ctx.font = '23px "j2mecjk", monospace';
          ctx.fillText(T('A 确认   B 返回') + (defs.length > rows + 1 ? T('   ↑↓ 滚动') : ''),
            px + 40, py + ph - 34);
        } catch (e) { /* 面板绘制失败不崩宿主 */ }
      }
      function pickMask() {
        var d = maskList()[maskSelIdx];
        if (!d) return;
        g.__maskState.sel = d.id;
        saveMaskSel();
        // 这一行必须立即落盘：它是"玩家到底选了什么"的唯一凭据，
        // 而紧接着的预载解码就是历史上会 fatal 的那一步
        maskLog('选择 ' + d.id + '（' + d.name + '）');
        ensureMaskLoaded(d.id); // 立即预载，游戏启动即就绪
        mode = 'list';
        draw();
      }

      // ---- 按键映射面板（Y 菜单 → 按键映射）--------------------------------
      // 交互方向是"先说我要哪个 MIDP 键，再按手柄上的键"——
      // 因为 Switch 上没有 J2ME 键盘，反向选不成立。
      // 列表：MIDP 目标键（确认/软键/方向/0-9/*/#/清除，共 20 行）+ 恢复默认 + 返回。
      // 选中目标按 A 进入捕获：按手柄任意键=绑定；B=取消捕获；+=解除该目标的绑定。
      // 写盘 sdmc:/switch/j2me-nx/keys.txt（可直接手改，重启或再进面板即生效）。
      var kmSel = 0, kmScroll = 0, kmCapture = false, kmMsg = '', kmPrevAll = [];
      var KM_ROWS = 8;
      function kmList() {
        var rows = [];
        var tg = (g.__keyMap && g.__keyMap.targets) || [];
        for (var i = 0; i < tg.length; i++) {
          var bound = '';
          try {
            // PATCH(perfZ22)：绑定的物理键名（"物理A / - 键 / L3 摇杆按"）来自
            // switch-input.js 的 SW_BUTTONS.label，过去**没走字典** —— 英文界面下
            // 右列还是中文（用户实测反馈第三条）。这里逐个词翻（bindingsOf 返回的是
            // 数组，直接对整串 T() 永远命不中）。
            var bl = g.__keyMap.bindingsOf(tg[i].code) || [];
            var bt = [];
            for (var bi = 0; bi < bl.length; bi++) bt.push(T(bl[bi]));
            bound = bt.join(' / ');
          } catch (e) { bound = ''; }
          rows.push({ kind: 'target', code: tg[i].code, label: tg[i].label, bound: bound });
        }
        rows.push({ kind: 'reset', label: '恢复默认映射' });
        rows.push({ kind: 'back', label: '返回' });
        return rows;
      }
      function openKeyMap() {
        kmSel = 0; kmScroll = 0; kmCapture = false; kmMsg = ''; kmPrevAll = [];
        mode = 'keymap';
        draw();
      }
      function kmPick() {
        var rows = kmList();
        var r = rows[kmSel];
        if (!r) return;
        if (r.kind === 'back') { mode = 'list'; draw(); return; }
        if (r.kind === 'reset') {
          try {
            g.__keyMap.reset();
            saveKeyMap(true);
            kmMsg = T('已恢复默认映射（写入 keys.txt）');
            sdLog('[keymap] 恢复默认');
          } catch (e) { kmMsg = T('恢复失败: {1}', (e && e.message)); }
          draw();
          return;
        }
        kmCapture = true;
        kmMsg = T('请按手柄上要绑定到「{1}」的键…（B 取消，+ 解除）', T(r.label));
        draw();
      }
      function drawKeyMapPanel() {
        try {
          var rows = kmList();
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#ffffff';
          ctx.font = '40px "j2mecjk", monospace';
          ctx.fillText(T('按键映射'), 60, 84);
          ctx.fillStyle = '#9ab0c8';
          ctx.font = '19px "j2mecjk", monospace';
          ctx.fillText(T('A 选中目标键 → 再按手柄上的键完成绑定（B 取消 / + 解除绑定）'), 60, 118);
          ctx.fillStyle = '#8fc98f';
          ctx.fillText(T('⚠ 对所有游戏生效；换绑会自动解除旧键；进游戏前的 Y/X/A/B/L/R/+ 不受影响'), 60, 146);
          ctx.fillStyle = '#9ab0c8';
          if (kmSel < kmScroll) kmScroll = kmSel;
          if (kmSel >= kmScroll + KM_ROWS) kmScroll = kmSel - KM_ROWS + 1;
          if (kmScroll < 0) kmScroll = 0;
          var px = 60, py = 204, pw = W - 120, rowH = 48;
          for (var vi = 0; vi < KM_ROWS; vi++) {
            var i = kmScroll + vi;
            if (i >= rows.length) break;
            var r = rows[i];
            var sel = (i === kmSel);
            ctx.fillStyle = sel ? '#1c3f7a' : '#101010';
            ctx.fillRect(px, py + vi * rowH - 32, pw, rowH - 8);
            ctx.fillStyle = sel ? '#ffffff' : '#a8a8a8';
            ctx.font = '24px "j2mecjk", monospace';
            var text = (sel ? '▶ ' : '  ') + T(r.label);
            if (r.kind === 'target') text += '    ← ' + (r.bound || T('（未绑定）'));
            ctx.fillText(text, px + 16, py + vi * rowH - 2);
          }
          ctx.fillStyle = '#8fc98f';
          ctx.font = '19px "j2mecjk", monospace';
          ctx.fillText(T('配置文件 sdmc:/switch/j2me-nx/keys.txt（对所有游戏生效，可直接手改；'
            + 'B 键留作取消）'), 60, H - 78);
          if (kmMsg) { ctx.fillStyle = '#ffd479'; ctx.fillText(kmMsg, 60, H - 46); }
          else ctx.fillText(T('A 确认   B 返回   ↑↓ 选择'), 60, H - 46);
        } catch (e) { /* 面板绘制失败不崩宿主 */ }
      }

      // ---- 按键机型面板（Y 菜单 → 按键机型）-------------------------------
      // 只改"发给 VM 的软键 keyCode"（诺基亚 -6/-7、摩托罗拉 -21/-22…），
      // 物理键→逻辑键的映射（keys.txt）不动，所以绑在软键上的手柄键照样是软键。
      // 选择按 jar 文件名记进 keyprofiles.json，只对这个游戏生效。
      var profSel = 0, profMsg = '';
      function profList() {
        var list = (g.__keyProfiles && typeof g.__keyProfiles.list === 'function')
          ? g.__keyProfiles.list() : [];
        var rows = list.map(function (p) {
          // 数字键映射**直接写成数字**（1:114 2:116 …），不用"QWERTY 码"这种说法，
          // 免得玩家/自己看混。detail2 是第二行（只有带 digits 表的机型才有）。
          var d2 = '';
          if (p.digits) {
            var order = [49, 50, 51, 52, 53, 54, 55, 56, 57, 42, 48, 35];
            var nameOf = { 49: '1', 50: '2', 51: '3', 52: '4', 53: '5', 54: '6',
              55: '7', 56: '8', 57: '9', 42: '*', 48: '0', 35: '#' };
            var parts = [];
            for (var oi = 0; oi < order.length; oi++) {
              var k = order[oi];
              if (p.digits[k] !== undefined) parts.push(nameOf[k] + ':' + p.digits[k]);
            }
            d2 = T('数字 {1}', parts.join(' '));
          }
          return { kind: 'profile', id: p.id, label: p.label,
            detail: T('左{1} / 右{2} / 确定{3} / 清除{4}',
              p.softLeft, p.softRight,
              (typeof p.fire === 'number') ? p.fire : -5, p.clear),
            detail2: d2 };
        });
        rows.push({ kind: 'back', label: '返回' });
        return rows;
      }
      function openProfSel() {
        profSel = 0; profMsg = '';
        var en = entries[sel];
        var cur = en ? profileForJar(en.file) : 'nokia';
        var rows = profList();
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].kind === 'profile' && rows[i].id === cur) { profSel = i; break; }
        }
        mode = 'profile';
        sdLog('[profile] 打开面板：' + (en ? en.file : '?') + ' 当前=' + cur);
        draw();
      }
      function profPick() {
        var rows = profList();
        var r = rows[profSel];
        var en = entries[sel];
        if (!r) return;
        if (r.kind === 'back') { mode = 'list'; draw(); return; }
        if (!en) { profMsg = T('没有选中的游戏'); draw(); return; }
        var m = loadKeyProfiles();
        if (r.id === 'nokia') delete m[en.file];   // 默认值不必落盘
        else m[en.file] = r.id;
        saveKeyProfiles();
        applyProfileForJar(en.file);               // 立即生效（下次启动该游戏也生效）
        profMsg = T('已设为「{1}」—— 只对这个游戏生效', T(r.label));
        sdLog('[profile] ' + en.file + ' → ' + r.id);
        draw();
      }
      function drawProfPanel() {
        try {
          var rows = profList();
          var en = entries[sel];
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#ffffff';
          ctx.font = '40px "j2mecjk", monospace';
          ctx.fillText(T('按键机型'), 60, 84);
          ctx.fillStyle = '#9ab0c8';
          ctx.font = '19px "j2mecjk", monospace';
          ctx.fillText(T('只影响发给游戏的软键键值（数字/方向/确认是 MIDP 统一值，不受影响）'), 60, 118);
          ctx.fillStyle = '#8fc98f';
          ctx.fillText(T('本游戏：{1}', en ? T('{1}（{2}）', en.name, en.file) : T('(未选中)')), 60, 146);
          var px = 60, py = 200, pw = W - 120, rowH = 62;
          for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var selRow = (i === profSel);
            ctx.fillStyle = selRow ? '#1c3f7a' : '#101010';
            ctx.fillRect(px, py + i * rowH - 34, pw, rowH - 8);
            ctx.fillStyle = selRow ? '#ffffff' : '#a8a8a8';
            ctx.font = '25px "j2mecjk", monospace';
            ctx.fillText((selRow ? '▶ ' : '  ') + T(r.label), px + 16, py + i * rowH - 8);
            if (r.detail) {
              ctx.fillStyle = selRow ? '#cfe3ff' : '#9ab0c8';
              ctx.font = '19px "j2mecjk", monospace';
              ctx.fillText(r.detail, px + 470, py + i * rowH - 8);
            }
            if (r.detail2) {
              ctx.fillStyle = '#8fc98f';
              ctx.font = '17px "j2mecjk", monospace';
              ctx.fillText(r.detail2, px + 470, py + i * rowH + 12);
            }
          }
          if (profMsg) {
            ctx.fillStyle = '#ffd479';
            ctx.font = '21px "j2mecjk", monospace';
            ctx.fillText(profMsg, 60, py + rows.length * rowH + 14);
          }
          ctx.fillStyle = '#8fc98f';
          ctx.font = '19px "j2mecjk", monospace';
          ctx.fillText(T('A 确认   B 返回   ↑↓ 选择   诺基亚=默认（-6/-7）'), 60, H - 46);
        } catch (e) { /* 面板绘制失败不崩宿主 */ }
      }

      // ---- 改名：Switch 系统内联键盘（type=All 可切中文输入） ----
      // 2026-09-22 两个实机问题修复：
      // ① 键盘弹出后挡住列表里的游戏名 → 顶部常驻"正在改名"横幅钉屏显示原名；
      // ② 预填原名 + 光标默认在最前 → 输入新名变成"新名旧名拼接"（暗黑启示录AHQSL）。
      //    改为输入框留空，新名字整体替换旧名；原名只在顶部横幅里展示供参考。
      // ③ 用户要求能实时看到正在输入的新名字 → 顶部画一个输入框，逐帧同步
      //    vk.value（nx.js 的 swkbdUpdate 每帧回调 onChange 更新该值）。
      var vkHandlers = null;
      var renameVK = null;       // 当前改名用的键盘实例（供横幅读实时值）
      var renameLastVal = null;  // 上帧渲染过的输入值（变化才重绘）
      function renameCurValue() {
        try { return String((renameVK && renameVK.value) || ''); }
        catch (eV) { return ''; }
      }
      function drawRenameBanner() {
        try {
          var en = entries[sel];
          if (!en) return;
          // 顶部横幅：系统内联键盘只占屏幕下半部，顶部区域始终可见
          var bh = 230;
          ctx.fillStyle = '#101828';
          ctx.fillRect(0, 0, W, bh);
          ctx.strokeStyle = '#3a6ea8';
          ctx.lineWidth = 2;
          ctx.strokeRect(1, 1, W - 2, bh - 2);
          ctx.lineWidth = 1;
          ctx.fillStyle = '#ffffff';
          ctx.font = '34px "j2mecjk", monospace';
          ctx.fillText(T('正在改名'), 40, 48);
          var nm = en.name.length > 16 ? en.name.slice(0, 16) + '…' : en.name;
          ctx.fillStyle = '#ffd479';
          ctx.font = '26px "j2mecjk", monospace';
          ctx.fillText(T('原名：{1}', nm), 40, 90);
          // 实时输入框
          var ix = 40, iy = 112, iw = W - 80, ih = 62;
          ctx.fillStyle = '#000000';
          ctx.fillRect(ix, iy, iw, ih);
          ctx.strokeStyle = '#7fa8d8';
          ctx.strokeRect(ix, iy, iw, ih);
          var val = renameCurValue();
          var shown, col;
          if (val) {
            shown = val.length > 18 ? val.slice(0, 18) + '…' : val;
            col = '#ffffff';
          } else {
            shown = T('在这里输入新名字…');
            col = '#555f6e';
          }
          ctx.fillStyle = col;
          ctx.font = '30px "j2mecjk", monospace';
          ctx.fillText(shown, ix + 16, iy + 42);
          ctx.fillStyle = '#9ab0c8';
          ctx.font = '22px "j2mecjk", monospace';
          ctx.fillText(T('按 确定 保存（整体替换原名）/ B 取消'), 40, 210);
        } catch (e) { /* 横幅绘制失败不崩宿主 */ }
      }
      function startRename() {
        var en = entries[sel];
        var vk = null;
        try {
          vk = (g.navigator && g.navigator.virtualKeyboard)
            ? g.navigator.virtualKeyboard : null;
        } catch (eVk) { vk = null; }
        if (!vk || typeof vk.show !== 'function') {
          sdLog('[menu] 系统键盘不可用，改名失败');
          mode = 'list';
          draw();
          return;
        }
        mode = 'rename';
        renameVK = vk;
        renameLastVal = null;
        draw(); // 先画提示底（键盘弹出前）
        try {
          vk.type = 8;          // SwkbdType.All：全部语言键盘，可切中文
          vk.okButtonText = T('确定');
          vk.maxLength = 24;
          vk.enableDictionary = true;
          vk.enableReturn = false;
          vk.value = '';        // 留空：新名字整体替换旧名（原名见顶部横幅）
          try { vk.cursorIndex = 0; } catch (eCi) { /* 属性不支持则忽略 */ }
        } catch (eCfg) { /* 属性不支持就按默认来 */ }
        var cleanup = function () {
          try { vk.removeEventListener('submit', onSubmit); } catch (e1) { /* 忽略 */ }
          try { vk.removeEventListener('cancel', onCancel); } catch (e2) { /* 忽略 */ }
          vkHandlers = null;
          renameVK = null;
          renameLastVal = null;
          if (mode === 'rename') { mode = 'list'; draw(); }
        };
        var onSubmit = function () {
          var newName = '';
          try { newName = String(vk.value || '').trim(); } catch (eV) { /* 忽略 */ }
          if (newName && en && en.name !== newName) {
            if (!en.orgName) en.orgName = en.name; // 首次改名时记住"改过名"标记
            en.name = newName;
            loadGameNames()[en.file] = newName;
            saveGameNames();
            sdLog('[menu] ' + en.file + ' 改名: ' + newName);
          }
          cleanup();
        };
        var onCancel = function () { cleanup(); };
        vkHandlers = { onSubmit: onSubmit, onCancel: onCancel };
        try {
          vk.addEventListener('submit', onSubmit);
          vk.addEventListener('cancel', onCancel);
          vk.show();
        } catch (eShow) {
          sdLog('[menu] 键盘弹出失败: ' + (eShow && eShow.message));
          mode = 'list';
          draw();
        }
      }

      // ---- 删除：两步确认（Y菜单→删除 → 面板内选"确认删除"再 A） ----
      function drawDelPanel() {
        try {
          var en = entries[sel];
          if (!en) return;
          ctx.globalAlpha = 0.88;
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
          var pw = 720, ph = 330;
          var px = (W - pw) / 2, py = (H - ph) / 2;
          ctx.fillStyle = '#101828';
          ctx.fillRect(px, py, pw, ph);
          ctx.strokeStyle = '#a83a3a';
          ctx.strokeRect(px, py, pw, ph);
          ctx.fillStyle = '#ff7070';
          ctx.font = '32px "j2mecjk", monospace';
          ctx.fillText(T('确认删除游戏？'), px + 40, py + 56);
          ctx.fillStyle = '#e0e0e0';
          ctx.font = '24px "j2mecjk", monospace';
          var nm = en.name.length > 22 ? en.name.slice(0, 22) + '…' : en.name;
          ctx.fillText(nm, px + 40, py + 100);
          ctx.fillStyle = '#8a8a8a';
          ctx.font = '20px "j2mecjk", monospace';
          ctx.fillText(en.file, px + 40, py + 130);
          ctx.fillStyle = '#ffb060';
          ctx.fillText(T('⚠ 将从 SD 卡永久删除 jar 文件，此操作不可恢复！'), px + 40, py + 172);
          var items = ['取消', '确认删除'];
          for (var i = 0; i < items.length; i++) {
            var oy = py + 200 + i * 52;
            var isDel = i === 1;
            ctx.fillStyle = i === delSel ? (isDel ? '#7a1c1c' : '#1c3f7a') : '#000000';
            ctx.fillRect(px + 30, oy - 30, pw - 60, 44);
            ctx.fillStyle = i === delSel ? '#ffffff' : '#a8a8a8';
            ctx.font = '25px "j2mecjk", monospace';
            ctx.fillText((i === delSel ? '▶ ' : '  ') + T(items[i]), px + 44, oy);
          }
          if (delErr) {
            ctx.fillStyle = '#ff7070';
            ctx.font = '20px "j2mecjk", monospace';
            ctx.fillText(delErr, px + 40, py + ph - 36);
          } else {
            ctx.fillStyle = '#8fc98f';
            ctx.fillText(T('A 确认   B 返回'), px + 40, py + ph - 36);
          }
        } catch (e) { /* 面板绘制失败不崩宿主 */ }
      }

      function doDelete() {
        var en = entries[sel];
        if (!en) { mode = 'list'; draw(); return; }
        try {
          if (IS_SWITCH) g.Switch.removeSync(scanDir + '/' + en.file);
          else require('fs').unlinkSync(scanDir + '/' + en.file);
          entries.splice(sel, 1);
          // 清理两个持久化表里的对应条目
          if (gameNames && gameNames[en.file]) {
            delete gameNames[en.file];
            saveGameNames();
          }
          if (overrides[en.file]) {
            delete overrides[en.file];
            saveResOverrides();
          }
          // 按键机型记录也一并清掉（否则重装同名 jar 会莫名沿用旧机型）
          var lp = loadKeyProfiles();
          if (lp[en.file]) {
            delete lp[en.file];
            saveKeyProfiles();
          }
          sdLog('[menu] 已删除 ' + en.file + '（剩 ' + entries.length + ' 个）');
          sel = pageOf(sel);
          menuSel = sel;   // 列表短了，记住的位置也要跟着夹一下
          scroll = Math.min(scroll, Math.max(0, entries.length - 1));
          if (sel < scroll) scroll = sel;
          if (sel >= scroll + maxRows) scroll = sel - maxRows + 1;
          mode = 'list';
          draw();
        } catch (eD) {
          delErr = T('删除失败: {1}', (eD && eD.message) || eD);
          sdLog('[menu] 删除失败 ' + en.file + ': ' + delErr);
          draw();
        }
      }

      // ---- ZR+ZL 语言弹窗（2026-09-23 perfZ21）-----------------------------
      // 交互：ZR+ZL（同时按住）→ 两项（切换到英文 / 切换到中文）→ A 选中 → 再问一次
      // "确认切换语言？" → A 真的切（写入 lang.json）/ B 退回选项。
      // 为什么两步：这是全局设置项，误触一次就把整个界面换语言，玩家会以为软件坏了。
      //
      // 只在菜单（与它的各面板）里生效 —— 游戏运行时 ZL/ZR 是左右软键，绝不能抢。
      // 从面板里按 ZR+ZL 也能切，关掉弹窗后回到原面板（langPrevMode）。
      var langSel = 0, langConfirm = false, langPrevMode = 'list';
      var langToast = '', langToastUntil = 0;
      // ⚠ 这个面板的两项**必须双语常显**：英文用户当前的设置很可能是中文，
      //   而"看不懂中文"正是他要进来改语言的原因（用户实测反馈第一条就是这个）。
      var LANG_ITEMS = [TB('切换到英文', 'Switch to English'),
                        TB('切换到中文', 'Switch to Chinese')];
      function langItemLang(i) { return i === 0 ? 'en' : 'zh'; }
      function openLang() {
        if (mode !== 'lang') langPrevMode = mode;
        // 光标起点 = 当前语言（省一次移动；也让玩家看清现在是哪个）
        langSel = (langNow() === 'en') ? 0 : 1;
        langConfirm = false;
        langToast = '';
        mode = 'lang';
        draw();
      }
      function closeLang() {
        langConfirm = false;
        mode = langPrevMode || 'list';
        draw();
      }
      function applyLang(i) {
        var want = langItemLang(i);
        var changed = false;
        try {
          if (g.__uiLang && typeof g.__uiLang.set === 'function') changed = g.__uiLang.set(want);
        } catch (eL) { /* 切换失败就当没切（界面保持原语言） */ }
        // 弹窗里那几条临时提示是**切语言之前**拼好的中文串（kmMsg/profMsg/delErr），
        // 切完它们不会再变 → 直接清掉，免得英文界面里挂着一句中文。
        kmMsg = ''; profMsg = ''; delErr = '';
        // 内置键盘覆盖层的单元格标签+居中宽度是**布局期**缓存好的（laidOutFor），
        // 不清掉的话切完语言它还挂着旧语言的"确定/关闭/退格"。
        try { if (kbState) kbState.laidOutFor = null; } catch (eKb) { /* 忽略 */ }
        langConfirm = false;
        mode = langPrevMode || 'list';
        // 3 秒确认条。注意定时器里必须查 done：菜单一旦 resolve（游戏已启动），
        // 这里再 draw() 就会把菜单画面盖在游戏上。
        //
        // ⚠ 提示必须**如实**反映落盘结果（用户实测反馈第二条："选完英文下次打开还是中文"）：
        //   以前无论写没写成功都显示"已写入 lang.json"，等于把唯一的线索骗掉了。
        //   saveLang 现在写完全部回读校验，结果在 langLastSave.
        var saved = langLastSave && langLastSave.ok;
        langToast = T(want === 'en'
          ? (saved ? '已切换为英文（已写入 lang.json）' : '已切换为英文（⚠ 写盘失败，本次有效）')
          : (saved ? '已切换为中文（已写入 lang.json）' : '已切换为中文（⚠ 写盘失败，本次有效）'));
        langToastUntil = Date.now() + (saved ? 3000 : 6000);
        sdLog('[ui-lang] 弹窗切换语言 → ' + want + '（changed=' + changed +
          '，落盘=' + (saved ? 'ok ' + (langLastSave.path || '') : '失败: ' + (langLastSave.why || '?')) + '）');
        // 切到英文时立刻把"这次弹窗里没翻译的串"落一次日志（正常应为 0 条：
        // 弹窗自己走 TB() 双语，不依赖字典）
        try {
          if (want === 'en' && g.__uiLang && typeof g.__uiLang.takeMisses === 'function') {
            var missNow = g.__uiLang.takeMisses();
            sdLog('[ui-lang] 英文界面下未翻译的串 ' + missNow.length + ' 条' +
              (missNow.length ? ': ' + missNow.join(' , ') : ''));
          }
        } catch (eMiss2) { /* 忽略 */ }
        draw();
        g.__noGen.setTimeout(function () {
          if (done) return;
          langToast = '';
          try { draw(); } catch (eT2) { /* 忽略 */ }
        }, saved ? 3200 : 6200);
      }
      function drawLangPanel() {
        try {
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
          var pw = 820, ph = 300;
          var px = (W - pw) / 2, py = (H - ph) / 2;
          ctx.fillStyle = '#101828';
          ctx.fillRect(px, py, pw, ph);
          ctx.strokeStyle = '#3a6ea8';
          ctx.strokeRect(px, py, pw, ph);
          ctx.fillStyle = '#ffffff';
          ctx.font = '34px "j2mecjk", monospace';
          ctx.fillText(TB('语言', 'Language') + '   ZR+ZL', px + 40, py + 58);
          if (langConfirm) {
            ctx.fillStyle = '#e0e0e0';
            ctx.font = '28px "j2mecjk", monospace';
            ctx.fillText(TB('确认切换语言？', 'Switch language?'), px + 40, py + 128);
            ctx.fillStyle = '#ffd479';
            ctx.font = '30px "j2mecjk", monospace';
            ctx.fillText(LANG_ITEMS[langSel], px + 60, py + 182);
            ctx.fillStyle = '#8fc98f';
            ctx.font = '23px "j2mecjk", monospace';
            ctx.fillText(TB('A 确认', 'A OK') + '    ' + TB('B 取消', 'B Cancel'), px + 40, py + ph - 30);
          } else {
            var curLang = langNow();
            for (var i = 0; i < LANG_ITEMS.length; i++) {
              var oy = py + 130 + i * 62;
              ctx.fillStyle = i === langSel ? '#1c3f7a' : '#000000';
              ctx.fillRect(px + 30, oy - 34, pw - 60, 52);
              ctx.fillStyle = i === langSel ? '#ffffff' : '#a8a8a8';
              ctx.font = '30px "j2mecjk", monospace';
              // 当前语言那行标 ●（标记本身不翻译，两种语言下都认得出）
              var mark = (langItemLang(i) === curLang) ? '  ●' : '';
              ctx.fillText((i === langSel ? '▶ ' : '  ') + LANG_ITEMS[i] + mark, px + 48, oy);
            }
            ctx.fillStyle = '#8fc98f';
            ctx.font = '23px "j2mecjk", monospace';
            ctx.fillText(TB('A 确认', 'A OK') + '    ' + TB('B 返回', 'B Back'), px + 40, py + ph - 30);
          }
        } catch (e) { /* 面板绘制失败不崩宿主 */ }
      }

      var prev = {};
      var pollDbg = 0;
      function poll() {
        if (done) return;
        if (pollDbg < 3) { pollDbg++; sdLog('[menu] poll tick #' + pollDbg); }
        try {
          var pads = g.navigator.getGamepads();
          var pad = null;
          for (var i = 0; i < pads.length; i++) {
            if (pads[i] && pads[i].connected) { pad = pads[i]; break; }
          }
          if (pad && pad.buttons) {
            var b = pad.buttons;
            function dn(idx) {
              return !!(b[idx] && (b[idx].pressed || b[idx].value > 0.5));
            }
            // 注意布局反转：1=Switch物理A（确认） 0=物理B（返回） 3=物理X（分辨率）
            // 2=物理Y（游戏菜单） 4/5=L/R 肩键（翻页）
            var up = dn(12), down = dn(13), aBtn = dn(1), bBtn = dn(0), xBtn = dn(3);
            var yBtn = dn(2), lBtn = dn(4), rBtn = dn(5);
            // ZR+ZL（索引 7/6）＝语言弹窗。菜单里这两个键本来没有用途；游戏里它们是
            // 左右软键，但那时菜单轮询已经停了（poll 只在菜单里跑）——不会抢。
            var zlBtn = dn(6), zrBtn = dn(7);
            var chord = zlBtn && zrBtn;
            var chordPrev = !!(prev.zl && prev.zr);
            if (pollDbg < 2) {
              pollDbg++;
              sdLog('[menu] poll#' + pollDbg + ' mode=' + mode +
                ' a=' + aBtn + ' y=' + yBtn + ' l=' + lBtn + ' r=' + rBtn);
            }
            if (mode === 'lang') {
              if (!langConfirm) {
                if ((up && !prev.up) || (down && !prev.down)) {
                  langSel = (langSel + 1) % LANG_ITEMS.length;
                  draw();
                }
                if (aBtn && !prev.a) { langConfirm = true; draw(); }
                if (bBtn && !prev.b) closeLang();
              } else {
                if (aBtn && !prev.a) applyLang(langSel);
                if (bBtn && !prev.b) { langConfirm = false; draw(); }
              }
            } else if (mode !== 'rename' && chord && !chordPrev) {
              // 改名中由系统键盘接管输入，ZR+ZL 不抢（那时玩家在打字）
              openLang();
            } else if (mode === 'rename') {
              // 系统键盘接管输入：游戏键全部让位，等 submit/cancel 事件返回。
              // 顶部输入框实时同步：vk.value 变化才整帧重绘（swkbdUpdate
              // 每帧回调 onChange，等价于把 change 事件翻译成重绘）。
              var curVal = renameCurValue();
              if (curVal !== renameLastVal) {
                renameLastVal = curVal;
                draw();
              }
            } else if (mode === 'list') {
              if (up && !prev.up) move(-1);
              if (down && !prev.down) move(1);
              if (lBtn && !prev.l) page(-1);
              if (rBtn && !prev.r) page(1);
              if (aBtn && !prev.a) confirm();
              if (xBtn && !prev.x) openRes();
              if (yBtn && !prev.y) openAct();
            } else if (mode === 'act') {
              if (up && !prev.up) { actSel = (actSel + ACT_ITEMS.length - 1) % ACT_ITEMS.length; draw(); }
              if (down && !prev.down) { actSel = (actSel + 1) % ACT_ITEMS.length; draw(); }
              if (aBtn && !prev.a) actPick();
              if (bBtn && !prev.b) { mode = 'list'; draw(); }
            } else if (mode === 'del') {
              if ((up && !prev.up) || (down && !prev.down)) { delSel = (delSel + 1) % 2; draw(); }
              if (aBtn && !prev.a) {
                if (delSel === 1) doDelete();
                else { mode = 'list'; draw(); }
              }
              if (bBtn && !prev.b) { mode = 'list'; draw(); }
            } else if (mode === 'mask') {
              var mLen = maskList().length;
              if (up && !prev.up) {
                maskSelIdx = (maskSelIdx + mLen - 1) % mLen;
                if (maskSelIdx < maskScroll) maskScroll = maskSelIdx;
                if (maskSelIdx >= maskScroll + MASK_ROWS + 1) maskScroll = maskSelIdx - MASK_ROWS;
                draw();
              }
              if (down && !prev.down) {
                maskSelIdx = (maskSelIdx + 1) % mLen;
                if (maskSelIdx >= maskScroll + MASK_ROWS + 1) maskScroll = maskSelIdx - MASK_ROWS;
                if (maskSelIdx < maskScroll) maskScroll = maskSelIdx;
                draw();
              }
              if (aBtn && !prev.a) pickMask();
              if (bBtn && !prev.b) { mode = 'list'; draw(); }
            } else if (mode === 'keymap') {
              // 捕获模式要读 16 个原始按钮的上升沿（含 + 键 9），所以单独快照
              var kmPressed = [];
              for (var kb = 0; kb < 16; kb++) {
                var kv = dn(kb), kp = !!kmPrevAll[kb];
                if (kv && !kp) kmPressed.push(kb);
                kmPrevAll[kb] = kv;
              }
              if (kmCapture) {
                if (kmPressed.length) {
                  var kmRowsNow = kmList();
                  var kmR = kmRowsNow[kmSel];
                  if (kmPressed.indexOf(0) >= 0) {           // B = 取消捕获（B 在面板里不被绑定）
                    kmCapture = false; kmMsg = T('已取消'); draw();
                  } else if (kmR && kmR.kind === 'target') {
                    try {
                      if (kmPressed.indexOf(9) >= 0) {        // + = 解除该目标的所有绑定
                        var all = g.__keyMap.rows();
                        for (var ai = 0; ai < all.length; ai++) {
                          if (all[ai].code === kmR.code) g.__keyMap.setBinding(all[ai].idx, null);
                        }
                        kmMsg = T('已解除「{1}」的绑定', T(kmR.label));
                        sdLog('[keymap] 解除 ' + kmR.label);
                      } else {                               // 其余按键 = 绑定
                        var bindIdx = kmPressed[0];
                        // 独占绑定：同一目标键上旧的物理键自动解除。
                        // （实机反馈"原版按键没被替换、一个键有两个映射"——那是
                        //   第一版只追加不解除造成的，玩家预期是换键。）
                        var cleared = [];
                        try {
                          cleared = g.__keyMap.bindExclusive
                            ? (g.__keyMap.bindExclusive(bindIdx, kmR.code) || [])
                            : (g.__keyMap.setBinding(bindIdx, kmR.code), []);
                        } catch (eBE) { g.__keyMap.setBinding(bindIdx, kmR.code); }
                        kmMsg = T('已绑定：{1} → {2}',
                            T(g.__keyMap.buttonLabel(bindIdx)), T(kmR.label)) +
                          (cleared.length ? T('（已解除 {1} 的原绑定）',
                            cleared.map(T).join(T('、'))) : '');
                        sdLog('[keymap] ' + g.__keyMap.buttonLabel(bindIdx) + ' → ' + kmR.label +
                          (cleared.length ? '（解除 ' + cleared.join('、') + '）' : ''));
                      }
                      saveKeyMap(true);
                    } catch (eKm) { kmMsg = T('保存失败: {1}', (eKm && eKm.message)); }
                    kmCapture = false;
                    draw();
                  }
                }
              } else {
                var kmLen = kmList().length;
                if (up && !prev.up) { kmSel = (kmSel + kmLen - 1) % kmLen; draw(); }
                if (down && !prev.down) { kmSel = (kmSel + 1) % kmLen; draw(); }
                if (aBtn && !prev.a) kmPick();
                if (bBtn && !prev.b) { mode = 'list'; draw(); }
              }
            } else if (mode === 'profile') {
              var pfLen = profList().length;
              if (up && !prev.up) { profSel = (profSel + pfLen - 1) % pfLen; profMsg = ''; draw(); }
              if (down && !prev.down) { profSel = (profSel + 1) % pfLen; profMsg = ''; draw(); }
              if (aBtn && !prev.a) profPick();
              if (bBtn && !prev.b) { mode = 'list'; draw(); }
            } else { // res 分辨率面板
              if (up && !prev.up) { resSel = (resSel + RES_OPTIONS.length - 1) % RES_OPTIONS.length; draw(); }
              if (down && !prev.down) { resSel = (resSel + 1) % RES_OPTIONS.length; draw(); }
              if (aBtn && !prev.a) pickRes();
              if (bBtn && !prev.b) { mode = 'list'; draw(); }
            }
            prev = { up: up, down: down, a: aBtn, b: bBtn, x: xBtn,
              y: yBtn, l: lBtn, r: rBtn, zl: zlBtn, zr: zrBtn };
          }
        } catch (e) { /* 手柄不可见时保持画面 */ }
        if (!done) g.requestAnimationFrame(poll);
      }

      sdLog('[menu] UI 启动（rows=' + maxRows + '）');
      draw();
      g.requestAnimationFrame(poll);
    });
  }

  // 菜单选择闸门：midlet.jar 资源加载与存档读取都等它放行。
  // 资源加载器动态读 g.__gameSelection → 软重启时换新闸门即可（newGate）。
  // 必须在 boot() 之前建好（资源加载器在 bundle 求值期就要引用）。
  g.__gameRunning = false;  // 游戏运行中（+ 键退出 / presenter 门控）
  g.__restarting = false;
  function newGate() {
    g.__gameSelection = new Promise(function (resolve) {
      g.__gameSelectionResolve = resolve;
    });
  }

  // + 键（游戏中）→ 存档落卡 → 杀本会话定时器 → 重新求值 bundle → 回菜单。
  // VM 的类注册表/静态区都是 bundle 顶层的全局对象，重新求值即全新 VM，
  // 无跨游戏状态残留；旧 VM 的定时器全部带世代标记，重启即自灭。
  g.__requestGameQuit = function (reason) {
    if (!g.__gameRunning || g.__restarting) return;
    g.__restarting = true;
    g.__gameRunning = false;
    sdLog('[exit] 关闭游戏返回菜单（' + (reason || '+ 键') + '）');
    try { if (typeof __logFlush === 'function') __logFlush(); } catch (e0) { /* 忽略 */ }
    // 强制存档落卡（清除防抖窗口立即写 SD），等 900ms 保证写完再拆会话
    try {
      if (typeof g.__flushIDBPersistence === 'function') g.__flushIDBPersistence();
      else if (g.fs && g.fs.syncStore) g.fs.syncStore(function () {});
    } catch (eS) { /* 忽略 */ }
    g.__noGen.setTimeout(function () {
      try { // 过渡屏（boot 重新求值要几秒）
        var c = g.screen.getContext('2d');
        c.fillStyle = '#000';
        c.fillRect(0, 0, g.screen.width, g.screen.height);
        c.fillStyle = '#8fc98f';
        c.font = '30px "j2mecjk", monospace';
        c.fillText(T('正在返回游戏菜单 ...'), 60, g.screen.height / 2);
      } catch (eP) { /* 忽略 */ }
      try { g.__killSessionTimers(); } catch (eK) { /* 忽略 */ }
      // PATCH(perfZ11)：软重启的内存账本（先量后改，零风险）。
      //   实机证据：每轮软重启 used 基线 +8~12MB 且 total 只涨不落，13:35 那次直接
      //   死在 eval j2me.js 中途。机理是**上一会话的 VM 对象仍被 bundle 装在全局上
      //   引用着** → V8 既收不回对象、也收不回它们的编译代码。
      //   这一轮只做三件事：① 记第几次软重启；② 打出"比基线新增的全局名"
      //   （= 下一轮要精确摘掉的对象清单）；③ 逼一次 GC 并记 used 前后
      //   （--expose-gc 在实机生效过，日志里有 "applying app V8 flags: --expose-gc"）。
      //   摘全局要按清单来，不能一把全 null —— env-prelude 装的 window/document/screen
      //   也要在 boot() 里被重装，摘早了会让 installCanvas 先炸。
      // PATCH(perfZ11/perfZ13)：软重启只在这里计数；真正的"摘全局 + GC"挪到 boot() 里
      // eval native.js 之前（reclaimPreviousSession），因为那时宿主初始化已完成、
      // VM 还没重编译 —— 唯一既能回收又不炸宿主的安全点。逐项护栏：Node 仿真里
      // Switch 的内存 API 未必齐，测量失败也不能让日志消失。
      try {
        g.__softRestarts = (g.__softRestarts || 0) + 1;
        var usedA = '?';
        try { usedA = (g.Switch.memoryUsage().usedHeapSize / 1048576).toFixed(1); } catch (eM1) { /* 忽略 */ }
        sdLog('[session] 第 ' + g.__softRestarts + ' 次软重启：回列表前 used=' + usedA +
          'MB（摘全局/GC 在 boot 里做，见下一行 [session] 软重启前回收）');
        if (typeof __logFlush === 'function') __logFlush();
      } catch (eSG) {
        try { sdLog('[session] 软重启计数异常: ' + (eSG && eSG.message)); } catch (e0) { /* 忽略 */ }
      }
      g.__fatalShown = false;
      sdLog('[restart] 重新加载模拟器核心 ...');
      memSnapshot('重启前');
      startSession();
    }, 900);
  };

  // PATCH(perfZ11)：基线全局快照 —— 第一次 startSession 之前记下"bundle 还没装时的全局"，
  // 之后每一轮软重启就能点出"上一会话 bundle 装上去的全局名"（下一轮精确摘对象的清单，
  // 也是内存账本的证据）。只记名字，不碰值。
  var BASE_GLOBALS = null;
  function snapshotBaseGlobals() {
    if (BASE_GLOBALS) return;
    BASE_GLOBALS = {};
    try {
      var ks = Object.keys(g);
      for (var i = 0; i < ks.length; i++) BASE_GLOBALS[ks[i]] = 1;
    } catch (eS) { /* 忽略 */ }
  }
  function sessionGlobalsAdded() {
    var out = [];
    if (!BASE_GLOBALS) return out;
    try {
      var ks = Object.keys(g);
      for (var i = 0; i < ks.length; i++) {
        var k = ks[i];
        if (BASE_GLOBALS[k]) continue;
        if (k.indexOf('__') === 0) continue;   // 宿主自用（__noGen/__maskState/…）
        out.push(k);
      }
    } catch (eS) { /* 忽略 */ }
    return out;
  }

  /**
   * PATCH(perfZ13)：软重启的"最后一次机会"——摘掉上一会话的 VM 顶层全局 + GC。
   *
   * 为什么必须在这个时机（boot() 里、eval native.js 之前，即宿主初始化已完成、1.7MB 的
   * j2me.js/main-all.js 还没重编译）：
   *   * 早了（在 __requestGameQuit 里）→ env-prelude 的 window/document/addEventListener
   *     这些宿主全局也还没重装，摘掉会让 installCanvas/installFatalListeners 直接炸
   *     （实测：摘 350 个那版连 isolate 都起不来）；
   *   * 晚了（重编译之后）→ 没用，代码空间已经被旧+新两份代码占满了。
   *
   * 名单只放 VM 自己的**顶层根对象**：整个 VM 对象图（类注册表、JVM 实例、native 表、
   * address→native 对象映射、jar 表）都挂在这几个名字下面，摘了它们整张图和它们的
   * 编译代码才会变成可回收垃圾。宿主自己的全局（__j2mePersistentRAB/__flushIDBPersistence/
   * window/document/…）**一律不碰**。
   */
  var VM_ROOT_GLOBALS = ['J2ME', 'Runtime', 'jvm', 'Native', 'NativeMap', 'CLASSES',
    'JARStore', 'asmJsTotalMemory', 'tempReturn0', 'inBrowser'];

  /*
   * PATCH(perfZ15)：**按来源精确摘全局**（perfZ13 那版只摘 9 个根对象，够撑到第 4 次换游戏，
   * 但代码空间仍在涨：实测第 4 次死在菜单扫描期——堆还剩 700MB，耗尽的只有 JIT 代码空间）。
   * 要真正让 V8 释放旧 bundle 的**代码**，必须连它那批顶层函数对象一起摘（j2me.js 102 个
   * + main-all.js 239 个顶层声明）。
   *
   * 为什么之前摘 350 个会炸、现在不会：**差别在记录点与摘的时机**。
   *   * 记录点：`recordNewGlobals()` 必须放在每个脚本 .then 的**末尾**（宿主钩子之后）——
   *     否则 `installIDBPersistence()` 这类宿主函数会被算到下一个脚本头上（上次就是它把
   *     `__flushIDBPersistence`/`__j2mePersistentRAB`/`addEventListener` 一起摘掉，连 isolate 都起不来）。
   *   * 时机：在 boot() 装 `j2me/native.js` 那一步摘——此时本轮宿主脚本（env-prelude 等）
   *     已经重新求值完、宿主全局是**新的**且归属于宿主脚本；而 VM 脚本还没开始重编译，
   *     所以此刻归属仍是 VM 脚本的名字 = 上一会话的遗留。早于这个点摘就会炸宿主。
   * GLOBAL_OWNER 跨会话保留（后写覆盖），于是"本会话由宿主脚本新建的名字"会自动改成宿主归属。
   */
  var GLOBAL_OWNER = null;
  // ⚠️ 只认 j2me.js / main-all.js：`j2me/native.js` 其实是**宿主**的 ASM 堆（src/native-heap.js），
  // 它装着 __j2mePersistentRAB（跨会话复用的 RAB 缓冲），摘了它重启就断（实测）。
  var VM_SCRIPT_RE = /(j2me\.js|main-all\.js)$/;
  /** 当前全局名集合（只记名字）。用来算"某次 eval 真正新增了哪些全局"。 */
  function snapshotKeys() {
    var s = {};
    try {
      var ks = Object.keys(g);
      for (var i = 0; i < ks.length; i++) s[ks[i]] = 1;
    } catch (eS) { /* 忽略 */ }
    return s;
  }
  /**
   * 只在"这次 eval 新出现"的名字上盖归属章。
   * ⚠️ 不能写成"相对基线新增的全部名字都算这个脚本的"——本轮先跑的 env-prelude.js 会把
   * 上一会话遗留的 VM 全局一并认领，于是到 VM 脚本那步一个都摘不到（实测只摘到 9 个根对象）。
   */
  function recordNewGlobals(rel, before) {
    if (!BASE_GLOBALS || !before) return;
    if (!GLOBAL_OWNER) GLOBAL_OWNER = {};
    try {
      var ks = Object.keys(g);
      for (var i = 0; i < ks.length; i++) {
        var k = ks[i];
        if (BASE_GLOBALS[k] || before[k]) continue;   // 基线已有 / 这轮 eval 前就有 → 不动它的归属
        if (k === 'GLOBAL_OWNER' || k === 'BASE_GLOBALS') continue;
        GLOBAL_OWNER[k] = rel;
      }
    } catch (eS) { /* 忽略 */ }
  }

  function reclaimPreviousSession() {
    if (!g.__softRestarts) return;   // 首次启动没有"上一会话"
    var usedA = '?';
    try { usedA = (g.Switch.memoryUsage().usedHeapSize / 1048576).toFixed(1); } catch (eM1) { /* 忽略 */ }
    var dropped = [];
    var k;
    /*
     * ⚠️ 2026-09-23 perfZ15 实测结论：**"连 VM 顶层函数对象一起摘"这条路走不通**。
     * 两版都试过：
     *   ① 摘 349 个（含 __j2mePersistentRAB）→ 重启立刻断（native.js 其实是宿主的 ASM 堆文件）；
     *   ② 收紧到 340 个（只认 j2me.js/main-all.js 装的、且跳过 __ 前缀）→ 重启仍然立刻断。
     * 原因：`j2me/config-build.js`、`vendor/config/default.js`、`urlparams.js`、`config/switch.js`
     * 这些脚本在 **main-all.js 之前**求值，而它们要用 main-all.js 提供的东西（load/util 一类）——
     * 这些名字在**任何**时刻摘掉都不安全，除非已经不打算再求值它们。
     * 所以这里保留"只摘 9 个根对象"（实测能撑到第 4 次换游戏）；真正的解是 C：
     * 软重启不再重求值 bundle，只重建 VM/isolate（见 PERF §29.4 的勘察结论）。
     * 保留 recordNewGlobals 的归属表 —— 它是下一轮 C 的清单来源（谁装了哪些全局）。
     */
    var EXTENDED_DROP = false;
    if (EXTENDED_DROP && GLOBAL_OWNER) {
      for (k in GLOBAL_OWNER) {
        if (!VM_SCRIPT_RE.test(GLOBAL_OWNER[k])) continue;
        if (k.indexOf('__') === 0) continue;   // 宿主自用命名约定：一律不碰
        try {
          if (g[k] !== undefined && g[k] !== null) { g[k] = null; dropped.push(k); }
        } catch (eD) { /* 只读就跳过 */ }
      }
    }
    // ② 兜底：9 个根对象一定摘（归属表万一没记到，也不能漏掉整张 VM 图）
    for (var i = 0; i < VM_ROOT_GLOBALS.length; i++) {
      k = VM_ROOT_GLOBALS[i];
      if (dropped.indexOf(k) >= 0) continue;
      try {
        if (g[k] !== undefined && g[k] !== null) { g[k] = null; dropped.push(k); }
      } catch (eD2) { /* 只读就跳过 */ }
    }
    var gcOk = (typeof globalThis.gc === 'function');
    if (gcOk) { try { globalThis.gc(); globalThis.gc(); } catch (eG) { /* 忽略 */ } }
    var usedB = '?';
    try { usedB = (g.Switch.memoryUsage().usedHeapSize / 1048576).toFixed(1); } catch (eM2) { /* 忽略 */ }
    sdLog('[session] 软重启前回收：摘 VM 全局 ' + dropped.length + ' 个（' +
      dropped.slice(0, 14).join(',') + (dropped.length > 14 ? ',…' : '') +
      '）；GC=' + (gcOk ? '已执行×2' : '不可用') + ' used ' + usedA + 'MB → ' + usedB + 'MB');
    if (typeof __logFlush === 'function') __logFlush();
  }

  function startSession() {
    snapshotBaseGlobals();   // 必须在第一次 eval bundle 之前
    installFatalListeners(); // boot 期兜底（boot 内 prelude 重求值会清掉本批，.then 里补装）
    newGate();
    boot()
    .then(function () {
      sdLog('[boot] bundle 加载完成，安装宿主桥');
      g.installPipeHost();
      console.log('[host] DumbPipe 宿主桥已安装');
      console.log('[host] ASM 堆: ' + Math.round((g.ASM.__bump() - g.ASM.__heapStart) / 1024) + 'KB 已分配（VM 初始化）');
      console.log('[host] J2ME 命名空间: ' + (typeof g.J2ME !== 'undefined') +
                  ', JVM: ' + (typeof g.JVM !== 'undefined') +
                  ', MIDP: ' + (typeof g.MIDP !== 'undefined'));
      // 输入在 bundle 加载后接入（midp.js 已注册 window keydown 监听并暴露
      // __sendKeyPress/__sendKeyRelease 直发入口；若 window 与 globalThis
      // 不是同一对象，先把直发入口拷过来）
      try {
        if (!g.__sendKeyPress && g.window && g.window.__sendKeyPress) {
          g.__sendKeyPress = g.window.__sendKeyPress;
          g.__sendKeyRelease = g.window.__sendKeyRelease;
        }
      } catch (e) { /* 忽略 */ }
      var inputOK = g.__installSwitchInput();
      sdLog('[host] Switch 手柄输入: ' + (inputOK ? '已接入（Gamepad API 轮询）' : '未检测到（Node 仿真/桌面环境）'));
      // 玩家配置在这条线上才真正载入：host 脚本刚 eval 完，__keyMap / __maskScan 才在。
      // （软重启会再走一次 startSession → 顺便重读玩家手改过的 keys.txt / 新拷的遮罩）
      try { afterHostScripts(); } catch (eAHS) { sdLog('[boot] afterHostScripts 异常: ' + (eAHS && eAHS.message)); }
      // 内存水位监控：验证 nxjs.ini heap_limit 生效、观察堆增长曲线
      // （上次实机崩溃 = V8 MemoryChunk 初始化写未映射页，即堆增长分配失败）
      if (IS_SWITCH && g.Switch && typeof g.Switch.memoryUsage === 'function') {
        var memLine = function (tag) {
          try {
            var m = g.Switch.memoryUsage();
            var jh = '';
            try {
              if (typeof g.ASM === 'object' && g.ASM && g.ASM.__bump) {
                jh = ' jheap=' + ((g.ASM.__bump() - g.ASM.__heapStart) / 1048576).toFixed(1) +
                  '/' + (g.ASM.__totalMemory() / 1048576).toFixed(1) + 'MB';
              }
            } catch (e2) { /* 忽略 */ }
            return '[mem] ' + tag + ' used=' + (m.usedHeapSize / 1048576).toFixed(1) +
              'MB total=' + (m.totalHeapSize / 1048576).toFixed(1) +
              'MB avail=' + (m.totalAvailableSize / 1048576).toFixed(1) +
              'MB limit=' + (m.heapSizeLimit / 1048576).toFixed(1) +
              'MB malloc=' + (m.mallocedMemory / 1048576).toFixed(1) +
              'MB peakMalloc=' + (m.peakMallocedMemory / 1048576).toFixed(1) + 'MB' + jh;
          } catch (e) { return '[mem] ' + tag + ' 读取失败: ' + (e && e.message); }
        };
        sdLog(memLine('启动时'));
        // 抄录 runtime 自身日志（sdmc:/switch/nxjs-debug.log，上次运行退出时写盘，
        // 所以开机读到的是"上一次运行"的内容）。jitfix runtime 会在里面记录
        // [v8] mem_total/free/regime 与 heap_limit 夹取明细
        // "exceeds backable X MiB (ceiling Y - reserve Z MiB), clamped" 的实数——
        // 这是坏启动（limit=348）归因的决定性证据：ceiling 掉到多少、
        // regime 是 application 还是 applet，一看便知。
        try {
          var dbgText = '';
          var dbgPaths = ['sdmc:/switch/nxjs-debug.log', 'sdmc:/nxjs-debug.log'];
          for (var di = 0; di < dbgPaths.length && !dbgText; di++) {
            try {
              // 注意：nx.js 的 Switch.readFileSync 返回 ArrayBuffer（实机踩过）
              var dbgBuf = g.Switch.readFileSync(dbgPaths[di]);
              var u8dbg = dbgBuf instanceof Uint8Array ? dbgBuf : new Uint8Array(dbgBuf);
              var chunk = 8192, parts = [];
              for (var dbgOff = 0; dbgOff < u8dbg.length; dbgOff += chunk) {
                parts.push(String.fromCharCode.apply(null,
                  u8dbg.subarray(dbgOff, Math.min(dbgOff + chunk, u8dbg.length))));
              }
              dbgText = parts.join('').trim();
              if (dbgText) {
                // PATCH(perfZ22)：连文件的时间戳一起打 —— "这份 [rt] 到底是谁写的"
                // 是排查"静默死亡/卡住"的第一性问题：nxjs-debug.log 只在运行走到
                // 写盘那一步才更新，被强杀/卡死的运行不会更新它（实测连续四个开机的
                // [rt] 块逐字节相同）。有 size/mtime 就能一眼判断它是不是本次。
                var dbgStamp = '';
                try {
                  if (typeof g.Switch.statSync === 'function') {
                    var stDbg = g.Switch.statSync(dbgPaths[di]);
                    if (stDbg) {
                      var mt = stDbg.mtimeMs || stDbg.mtime;
                      if (mt) {
                        try { dbgStamp = ' size=' + stDbg.size + ' mtime=' + new Date(mt).toISOString(); }
                        catch (eMt) { dbgStamp = ' size=' + stDbg.size + ' mtimeMs=' + mt; }
                      } else {
                        dbgStamp = ' size=' + stDbg.size;
                      }
                    }
                  }
                } catch (eStDbg) { dbgStamp = ' (stat 不可用)'; }
                sdLog('[boot] runtime 日志来源（上一次运行写下的 stderr）: ' + dbgPaths[di] + dbgStamp);
              }
            } catch (eDbg2) { /* 该路径不存在则试下一个 */ }
          }
          if (dbgText) {
            var dbgLines = dbgText.split('\n').slice(-40); // 日志很小，40 行封顶
            // PATCH(perfZ22)：这句以前写"本次开机的 [v8]/[config]/[skia] 行"——**是错的**。
            // nxjs-debug.log 是运行时的 stderr 文件，开机读到的是**上一次运行**留下的内容，
            // 而且只有走到"写盘那一步"的运行才会更新它；连续几次"卡住被强杀"的会话会让它
            // 一直停在更早那次的现场（实测四个连续开机的 [rt] 块逐字节相同、连地址都一样）。
            // 实机排查时这种"像本次又不像本次"的日志最容易把人带偏，所以标题如实写清楚。
            sdLog('---- runtime 日志开始（⚠ 上一次运行写入的现场，可能已过期；' +
              '行内 [v8]/[config]/[skia] 与 FATAL 记录都属于那一次）----');
            for (var dli = 0; dli < dbgLines.length; dli++) {
              if (dbgLines[dli].trim()) sdLog('[rt] ' + dbgLines[dli]);
            }
            sdLog('---- runtime 日志结束 ----');
          } else {
            sdLog('[boot] 未找到 nxjs-debug.log（可能是首次运行或上次未正常退出）');
          }
          if (typeof __logFlush === 'function') __logFlush();
        } catch (eDbg) {
          sdLog('[boot] nxjs-debug.log 读取失败: ' + (eDbg && eDbg.message));
        }
        // 坏启动直接拒绝运行（用户要求：显示提示后退出，不再让游戏卡死在加载）。
        // 2026-09-21 实锤（error.log 21 次开机 + runtime 二进制字符串）：
        //   - jitfix runtime 对 heap_limit 有硬编码 512MiB 上限（"above 512 MiB
        //     cap, clamped to 512 MiB"），ini 写 800 也会被拍回 —— 满额档=512；
        //   - limit 只有两种实测值：512（好）/ 348（坏）。348 = ceiling(~528)
        //     - reserve(JIT 预留，新版源码已从 180 降下来)。ceiling 是开机瞬间
        //     系统侧决定的动态值，坏启动成串出现、连开 2~3 次后自愈；
        //   - 游戏运行期 V8 堆用量仅 ~43MB —— 800 是余量不是刚需，
        //     好处是坏启动也远高于旧 348，守卫几乎不可能再触发。
        // 2026-09-21 runtime 重编（beta6，cap 512->800 + reserve 下调）：
        //   limit >= 700  → 大内存档正常启动（ini 800 拿满）
        //   400..700      → ceiling 被挤占，放行但余量小
        //   limit < 400   → 拒绝运行，提示后退出
        try {
          var mBoot = g.Switch.memoryUsage();
          var limMB = mBoot.heapSizeLimit / 1048576;
          if (limMB >= 700) {
            sdLog('[boot] 内存正常 limit=' + limMB.toFixed(0) + 'MB（新 runtime 800 档）');
          } else if (limMB < 400) {
            sdLog('[boot] !!! 低内存启动 limit=' + limMB.toFixed(0) + 'MB (<400)：拒绝运行，上屏提示后 3 秒退出 !!!');
            showFatalError(T('内存不足，无法进入游戏'),
              T('开机时运行时只拿到 {1}MB 堆（正常应拿到 800MB）。', limMB.toFixed(0)) + '\n' +
              T('请退出本软件后重新启动，连续打不开时：') + '\n' +
              T('回到 HOME 主菜单等几秒再进（实测连开 2~3 次必成功），') + '\n' +
              T('或重启机器再试。'));
            setTimeout(function () {
              try {
                g.Switch.exit();
              } catch (eExit) {
                console.error('[boot] 低内存自动退出失败: ' + (eExit && eExit.message));
              }
            }, 3000);
            // 返回永不 resolve 的 promise，把后面的 .then(sel) 链停住——
            // 直接 return undefined 会落进下一环 sel.name 炸 TypeError，
            // 覆盖掉刚画的"内存不足"提示页（实机踩过）。
            return new Promise(function () { /* 停链，等 3 秒后自动退出 */ });
          } else {
            sdLog('[boot] 内存偏紧 limit=' + limMB.toFixed(0) +
              'MB（400~700，ceiling 被挤占）：继续运行但余量小');
          }
          // PATCH(perfZ11-D)：紧档自保。实机证据（2026-09-23）：两次"自己退出"
          // 都发生在紧档（limit 416/425MB），正常档（821MB）那次连玩 11 分钟没事。
          // 紧档下 V8 会以"堆里只有 27MB 却 OOM"的形态死掉（Mark-Compact last
          // resort 收不动 = 提交不到内存）。所以紧档时：① 全局标记，供 SD 遮罩等
          // 大分配路径降级；② 打一条显眼的 [tight] 行；③ 菜单上给用户一句提示。
          g.__memTight = (limMB < 700);
          g.__memLimitMB = Math.round(limMB);
          if (g.__memTight && limMB >= 400) {
            sdLog('[tight] 本次是紧档启动（limit=' + limMB.toFixed(0) +
              'MB）：SD 自定义 PNG 遮罩将被跳过；想看更多余量请退出重开，直到日志出现"★档位=正常"');
            if (typeof __logFlush === 'function') __logFlush();
          }
        } catch (eMemBoot) { /* 忽略 */ }
        // PATCH(perfC)：①档位显眼化 —— limit 是逐次开机 roll 出来的（ceiling
        // 被系统占用时掉到 425/468），偏紧档历史记录里会话全部异常，性能/稳定性
        // 对比必须在 limit≥700 的档位做；②yield 节流逃生开关 —— 存在
        // sdmc:/switch/j2me-nx/no-throttle 时退回原版纯 yield，用于同一次开机 A/B。
        try {
          if (typeof limMB === 'number') {
            sdLog('[boot] ★档位=' + (limMB >= 700 ? '正常' : '偏紧') + ' limit=' + limMB.toFixed(0) + 'MB' +
              (limMB >= 700 ? '（可用于性能对比）' : '（不要用于性能对比：退出重开，直到 limit≥700）'));
          }
          var noThr = readFileSyncLocal('sdmc:/switch/j2me-nx/no-throttle') !== null;
          g.__noYieldThrottle = noThr;
          sdLog('[yield] 节流=' + (noThr
            ? '关（存在 no-throttle 标记文件，走原版纯 yield）'
            : '开（同一 16ms 内 >256 次 yield → sleep(1) 真停泊）'));
          if (typeof __logFlush === 'function') __logFlush();
        } catch (eThr) { /* 忽略 */ }
        // PATCH(2026-09-23)：运行时身份打点。nxjs-debug.log 实测会停在陈旧
        // 内容上（stderr freopen 未生效时整份文件冻结在旧崩溃），error.log
        // 里看到的 [v8] 行不可信；改用 $.config（effective 值）直接证明
        // 本次开机真正的 jit/heapLimit/renderer。
        try {
          var effCfg = (typeof g.$ !== 'undefined' && g.$ && g.$.config) ? g.$.config : null;
          if (effCfg) {
            sdLog('[boot] runtime 有效配置: jit=' + effCfg.jit +
              ' heapLimit=' + Math.round((effCfg.heapLimit || 0) / 1048576) + 'MB' +
              ' renderer=' + effCfg.renderer +
              ' codeHeadroom=' + effCfg.codeHeadroomMb + 'MB');
          } else {
            sdLog('[boot] runtime 有效配置: $.config 不可用（旧 runtime）');
          }
          if (typeof __logFlush === 'function') __logFlush();
        } catch (eCfgLog) { /* 忽略 */ }
        if (typeof __logFlush === 'function') __logFlush(); // 启动期探针：立即落盘
        // [jheap] 探测本身只读常量（__maxMemory），真正的内存大头是
        // native-heap.js 装载时的 RAB 构造（按 maxByteLength 预留 mman），
        // 其上限已在 native-heap.js 内按启动预算自适应收紧（2026-09-21
        // 实机 nxjs-debug.log 实锤：坏启动 RAB@512 → native 645/651MB →
        // V8 young 晋升失败 FATAL OOM 无提示退出）。偏紧档只跳过日志输出。
        if (typeof limMB === 'number' && limMB < 700) {
          sdLog('[jheap] 偏紧档跳过 RAB 探测（避免低内存下分配 512MB RAB）');
          if (typeof __logFlush === 'function') __logFlush();
        }
        try {
          if (typeof limMB !== 'number' || limMB >= 700) {
            if (typeof g.ASM === 'object' && g.ASM && g.ASM.__resizable) {
              g.__sdMark('jheap RAB 探测前');
              var diagStr = '';
              try { diagStr = ' 探测=' + g.ASM.__diag(); } catch (e4) { /* 忽略 */ }
              var jheapMaxMB = Math.round(g.ASM.__maxMemory() / 1048576);
              sdLog('[jheap] 可扩容堆=' + g.ASM.__resizable() +
                ' 当前=' + (g.ASM.__totalMemory() / 1048576).toFixed(0) +
                'MB 上限=' + jheapMaxMB + 'MB' + diagStr);
              if (typeof __logFlush === 'function') __logFlush();
            }
          }
        } catch (e3) { /* 忽略 */ }
        var beatCount = 0;
        var lastBeatAt = Date.now();
        // GC(20260922-gc1)：scheduler 安全点回收后的统计上报
        g.__gcReport = function (stats) {
          try {
            if (!stats) return;
            try { if (typeof globalThis !== 'undefined') globalThis.__lastGCReport = stats; } catch (eRep) { /* 忽略 */ }
            if (stats.broken) {
              sdLog('[gc] 堆链校验失败，GC 已永久禁用（回退纯 bump）: ' + stats.err);
              return;
            }
            sdLog('[gc] 回收 ' + stats.freedMB + 'MB（' + stats.freedBlocks + ' 块）' +
              ' 用时 ' + stats.ms + 'ms [prep=' + stats.prepMs + ' 根=' + stats.rootsMs +
              ' mark=' + stats.markMs + ' sweep=' + stats.sweepMs + ']' +
              ' 扫=' + stats.scanMB + 'MB 免扫=' + stats.skipMB + 'MB(' + stats.skipBlocks + '块)' +
              ' 假候选拒=' + (stats.rejCand | 0) +
              ' 回收前 ' + stats.usedBeforeMB + 'MB 存活块 ' + stats.keptBlocks +
              ' 存活=' + stats.keptMB + 'MB perm块=' + stats.permBlocks);
          } catch (eGCR) { /* 忽略 */ }
        };
        setInterval(function () {
          // 阻塞检测：本回调是 macrotask，主线程被同步任务堵死时它停摆。
          // 间隔远超 10s = 期间发生卡死/长同步任务（2026-09-21 流星
          // 蝴蝶幻剑录2：启动后主线程阻塞，[mem] 心跳停跳、rAF 停摆、黑屏）。
          var now = Date.now();
          var gap = now - lastBeatAt;
          lastBeatAt = now;
          if (gap > 15000) {
            sdLog('[hang] 主线程阻塞 ' + (gap / 1000).toFixed(1) +
              's 后恢复（期间 macrotask/rAF 全停摆：卡加载/死循环/同步等待）。' +
              '最后一条 [media]/[mark] 探针即死点');
            if (typeof __logFlush === 'function') __logFlush();
          }
          sdLog(memLine('运行中#' + (++beatCount)));
          // PATCH(perfZ23)：英文界面里"还剩哪些中文"由运行时攒着，这里每 10s 落一次。
          // 实机上英文文案漏翻只有玩家看得到（我们看不到屏），有了这条日志，
          // 玩家只要在英文界面下把各面板翻一遍，日志里就直接列出漏掉的串。
          try {
            if (langNow() === 'en' && g.__uiLang && typeof g.__uiLang.takeMisses === 'function') {
              var missed = g.__uiLang.takeMisses();
              if (missed.length) {
                sdLog('[ui-lang] ⚠ 英文界面下未翻译的串 ' + missed.length + ' 条: ' +
                  missed.map(function (m) { return '"' + m.slice(0, 40) + '"'; }).join(' , '));
              }
            }
          } catch (eMiss) { /* 探针故障不干扰游戏 */ }
          // 分配热点普查（方案2）：runtime 探针按类累计本窗口分配字节，
          // 这里每 10s 打 Top-8 并清零。jheap 涨速 ≈ 垃圾产出率。
          // raw = native-heap 全量口径（必经咽喉），classified 与 raw 之差
          // 即未挂钩旁路流量；差值大时顺带打出分配栈采样定位来源。
          try {
            var ap = g.__allocProbe;
            var rawMB = -1;
            try {
              if (g.ASM && g.ASM.__rawWindow) rawMB = g.ASM.__rawWindow() / 1048576;
            } catch (eRaw) { /* 忽略 */ }
            if (ap && ap.byName) {
              var ents = [];
              for (var ak in ap.byName) ents.push([ak, ap.byName[ak]]);
              ents.sort(function (a, b) { return b[1] - a[1]; });
              var parts = [];
              for (var ai = 0; ai < ents.length && ai < 8; ai++) {
                parts.push(ents[ai][0] + '=' + (ents[ai][1] / 1048576).toFixed(2) + 'MB(' +
                  Math.round(ents[ai][1] * 100 / Math.max(1, ap.windowTotal)) + '%)');
              }
              sdLog('[alloc] 窗口10s=' + (ap.windowTotal / 1048576).toFixed(2) + 'MB' +
                (rawMB >= 0 ? ' raw=' + rawMB.toFixed(2) + 'MB' : '') +
                (parts.length ? ' | ' + parts.join(' ') : ' | 无分配'));
              if (rawMB > Math.max(0.5, ap.windowTotal / 1048576 * 1.5 + 0.5) &&
                  g.ASM && g.ASM.__allocSample) {
                var sample = String(g.ASM.__allocSample() || '').split('\n').slice(0, 5).join(' <- ');
                if (sample) sdLog('[alloc] 旁路采样: ' + sample);
              }
              ap.byName = Object.create(null);
              ap.windowTotal = 0;
            }
            // 分配卡顿探针（gc4）：单次 malloc >150ms 的现场（含 freelist/桶规模）
            if (g.ASM && g.ASM.__heapStats) {
              var hs = g.ASM.__heapStats();
              if (hs) sdLog('[alloc] 卡顿现场: ' + JSON.stringify(hs));
            }
          } catch (ape) { /* 探针倾倒故障不干扰游戏 */ }
          // PATCH(perfZ25)：耗时账本 —— 读盘/解压/解码窗口汇总。
          // 与 [present] 的 vm/gfx/aud 互补：那三笔只覆盖 VM 内部，入口卡顿几乎
          // 全发生在这几笔宿主账上（jar 读盘、zip 解压、PNG 解码）。
          try { sdLog('[cost] ' + costAllText()); } catch (eCost) { /* 忽略 */ }
          // 调试钩子（gc 冻结复现）：宿主侧请求强制 GC（走与 System.gc 相同路径）
          try {
            if (typeof globalThis !== 'undefined' && !globalThis.__forceGCRequest) {
              globalThis.__forceGCRequest = function () {
                try { if (g.ASM && g.ASM._forceCollection) { g.ASM._forceCollection(); return true; } } catch (eF) { /* 忽略 */ }
                return false;
              };
            }
          } catch (eHook) { /* 忽略 */ }
          if (beatCount % 5 === 0 && typeof __logFlush === 'function') __logFlush();
        }, 10000);
      }
      // + 键保留给游戏（右软键 -7）：拦下 nx.js 的默认退出行为，退出走 HOME 菜单
      installFatalListeners(); // prelude 重求值清过监听，会话期兜底在此重装
      if (inputOK && typeof g.addEventListener === 'function') {
        g.addEventListener('beforeunload', function (e) {
          if (e && typeof e.preventDefault === 'function') e.preventDefault();
        });
        console.log('[host] + 键默认退出已接管（beforeunload preventDefault）');
      }

      // vendor main.js 的 Promise.all(loadingPromises).then(start) 已排队，
      // 但 midlet.jar 加载挂在 __gameSelection 闸门上——菜单选完才会继续。
      console.log('[host] 进入游戏选择菜单 ...');
      return runGameMenu();
    })
    .then(function (sel) {
      // 防御：上游任何路径 resolve 出 undefined（如守卫提前返回）时停在这里，
      // 不让 sel.name 炸 TypeError 顶掉上屏提示。
      if (!sel) return;
      // 应用所选游戏：manifest 属性（等价旧 JAD）+ 入口类名
      sdLog('[menu] 选中: ' + sel.name + '（' + sel.file + '，入口 ' + sel.midletClass + '）');
      try {
        for (var k in sel.manifest) MIDP.manifest[k] = sel.manifest[k];
      } catch (eM) {
        sdLog('[menu] manifest 合并失败: ' + (eM && eM.message));
      }
      config.midletClassName = sel.midletClass;

      // 按键机型：按该游戏的记录切换软键 keyCode（诺基亚 -6/-7 / 摩托罗拉 -21/-22…）。
      // 必须在游戏开始收键之前应用——菜单阶段 __gameRunning=false，宿主不发键，
      // 这里改的是"之后发出去的数字"，所以放在放行闸门（__gameSelectionResolve）之前。
      try { applyProfileForJar(sel.file); } catch (ePf) {
        sdLog('[profile] 应用失败（按默认机型走）: ' + (ePf && ePf.message));
      }

      // 虚拟设备分辨率：探测该游戏原生分辨率并应用（必须在放行闸门前——
      // 游戏启动时才读 Display.WIDTH/HEIGHT，改晚了就缓存旧值了）。
      try {
        var sz = detectGameResolution(sel.absPath || (GAME_ROOT + '/' + sel.file));
        var ov = loadResOverrides()[sel.file]; // X 键手动指定优先于自动探测
        if (ov) {
          var pp2 = ov.split('x');
          sz = { w: +pp2[0], h: +pp2[1], how: '手动指定' };
        }
        g.__setDeviceScreenSize(sz.w, sz.h);
        sdLog('[detect] ' + sel.file + ' → ' + sz.w + 'x' + sz.h +
          '（' + sz.how + '，' + (sz.w > sz.h ? '横屏铺满' : '竖屏遮罩') + '）');
      } catch (eSz) {
        sdLog('[detect] 分辨率探测/应用失败，保持 240x320: ' + (eSz && eSz.message));
      }

      // 周期把虚拟 fs 的内存变更 sync 进 IDB（触发持久化后端写 SD 卡）。
      // 上游靠 pagehide 事件 + 20 秒后才启动的 5 秒周期 flushAll，宿主里
      // pagehide 不存在，这里用更短的周期保证存档及时落卡。
      if (g.fs && g.fs.syncStore) {
        setInterval(function () {
          try { g.fs.syncStore(function () {}); } catch (e) { /* 忽略周期 flush 异常 */ }
        }, 3000);
      }

      // 遮罩呈现层：游戏选中后才启用（菜单阶段屏幕由菜单自绘）
      var presenterOK = installPresenter();
      console.log('[host] 屏幕呈现: ' + (presenterOK ? '已启用（240x320 → 物理屏等比放大居中）' : '未启用'));

      // 放行闸门：vendor 开始读取所选 jar 并自动启动 VM
      console.log('[host] 放行启动流程，等待 VM 运行 MIDlet ...');
      g.__gameRunning = true;
      g.__restarting = false;
      g.__sessionEverRunning = true; // 走到过游戏会话（软重启失败自动重试的判据）
      g.__bootRetryCount = 0;        // 成功启动即清零重试计数
      g.__gameSelectionResolve(sel);
      // 仿真钩子：自动验证"退出回菜单 → 再启动"全链路（J2ME_TEST_RESTART=1）
      if (IS_NODE && process.env.J2ME_TEST_RESTART) {
        g.__noGen.setTimeout(function () { g.__requestGameQuit('仿真测试'); }, 8000);
      }
      // 保险：游戏启动早期 vendor 可能经 setFullScreen0 链重设画布，
      // 定时重申所选分辨率（present 循环的自愈是 60 帧粒度，这里补即时兜底）
      setTimeout(function () {
        try { g.__setDeviceScreenSize(sz.w, sz.h); } catch (eR1) { /* 忽略 */ }
      }, 500);
      setTimeout(function () {
        try { g.__setDeviceScreenSize(sz.w, sz.h); } catch (eR2) { /* 忽略 */ }
      }, 2000);

      // 启动看门狗：定位"部分游戏加载失败且零日志"——VM 核心（PluotSorbet
      // 上游）没有任何 uncaught exception 上报，MIDlet 线程静默死亡时
      // error.log 不留痕迹，只能靠帧计数旁路判断：
      //   零帧 → MIDlet 没跑起来（静默死在类加载/startApp，或卡加载挂起）
      //   有帧 → 呈现层正常，失败在更下游
      g.__presentFrames = 0;
      [15, 40].forEach(function (wdT) {
        g.__noGen.setTimeout(function () {
          try {
            var fr = (typeof g.__presentFrames === 'number') ? g.__presentFrames : 0;
            if (fr === 0) {
              sdLog('[watchdog] 放行 ' + wdT + 's 仍零帧：MIDlet 未启动' +
                '（静默死在类加载/startApp，或卡加载挂起——zip 全量解压/GC 风暴）。' +
                'VM/Java 层输出另查 sdmc:/switch/nxjs-debug.log');
              try { memSnapshot('watchdog' + wdT); } catch (eW) { /* 忽略 */ }
            } else if (wdT === 40) {
              sdLog('[watchdog] 放行 40s 帧数=' + fr + '（呈现层正常）');
            }
            if (typeof __logFlush === 'function') __logFlush();
          } catch (eW2) { /* 忽略 */ }
        }, wdT * 1000);
      });
    })
    .catch(function (err) {
      // 注意：nx.js 的 err.stack 不含 message 文本，必须显式拼接 message
      var msgPart = err && err.message ? String(err.message) : String(err);
      var stackPart = err && err.stack ? String(err.stack) : '';
      var detail = 'message: ' + msgPart + (stackPart ? '\nstack: ' + stackPart : '');
      console.error('[host] 启动失败: ' + detail);
      sdLog('[fatal] 启动失败 ' + detail);
      // 软重启会话的启动失败（bundle 重求值/菜单/内存波动）不死路：提示后
      // 自动重试回菜单，限 2 次——连续失败说明 romfs/内存出了持续性问题。
      // 首次开机失败仍维持旧行为（提示后等待用户重启软件）。
      if (IS_SWITCH && g.__sessionEverRunning &&
          (g.__bootRetryCount || 0) < 2) {
        g.__bootRetryCount = (g.__bootRetryCount || 0) + 1;
        sdLog('[boot] 软重启启动失败，3 秒后自动重试（第 ' +
          g.__bootRetryCount + '/2 次）');
        showFatalError(T('启动失败，即将自动重试'),
          detail.split('\n').slice(0, 5).join('\n') +
          '\n\n' + T('第 {1}/2 次重试，3 秒后返回游戏菜单 ...', g.__bootRetryCount));
        g.__noGen.setTimeout(function () {
          g.__fatalShown = false;
          startSession();
        }, 3000);
        return;
      }
      showFatalError(T('j2me-nx-port 启动失败'), detail);
      if (IS_NODE) process.exit(1);
    });
  }

  // 首次会话启动
  startSession();

  console.log('[j2me-nx-port] 平台: ' + (IS_SWITCH ? 'Switch (nx.js)' : (IS_NODE ? 'Node 仿真' : '未知')));
})();
