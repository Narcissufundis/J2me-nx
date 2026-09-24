/*
 * native-heap.js — PluotSorbet `bld/native.js` 的纯 JS 替代实现（Switch 移植版）
 *
 * 原版由 emscripten 编译 native.cpp + Boehm.js GC + Relooper 生成（asm.js）。
 * 本实现只覆盖 VM 实际使用的接口面（约 30 个符号，已全仓 grep 核实）：
 *
 *   ASM.buffer / HEAP8 / HEAPU8 / HEAP16 / HEAPU32 / HEAP32 / HEAPU16 / HEAPF32 / HEAPF64
 *   长整数运算（操作数为堆内字节地址，lo/hi 各占 4 字节，结果可与源别名）：
 *     _lAdd(dst,a,b) _lSub(dst,a,b) _lMul(dst,a,b) _lDiv(dst,a,b) _lRem(dst,a,b)
 *     _lNeg(dst,a) _lShl(dst,a,shift) _lShr(dst,a,shift) _lUshr(dst,a,shift)
 *     _lCmp(dst,a,b)
 *   GC：
 *     _gcMalloc(n) _gcMallocAtomic(n) _gcMallocUncollectable(n) _gcFree(addr)
 *     _gcRegisterDisappearingLink(holder,target) _gcUnregisterDisappearingLink(holder)
 *     _registerFinalizer(addr) _forceCollection() _collectALittle() _getUsedHeapSize()
 *
 * 设计要点（对照原版语义）：
 *  - NULL = 0：堆前 4KB 永不分配，malloc 返回 0 表示 OOM（runtime.ts 依赖此约定）。
 *  - 所有分配 8 字节对齐（Boehm 语义；Int32Array 视图也要求 4 对齐）。
 *  - _gcMalloc 分配清零（Boehm GC_malloc 语义）。
 *    ⚠️ **勘误（perfZ44，外部评审指出注释与实现漂移）**：本文件早期版本里 free 是 no-op、
 *    堆是"不回收的 bump 分配器"；**现在不是了** —— 后面已包含完整的保守 mark/sweep、
 *    freelist、弱引用处理与 `_gcFree` 的**延迟回收**语义（见下方 PATCH(perfA…) 各段与
 *    `_forceCollection`）。地址**会**被复用，所以 WeakReference/消失链接必须走
 *    `_gcRegisterDisappearingLink` + 本文件的弱引用清理流程（不要再按"地址永不复用"推理）。
 *  - 长整数运算用 i32 lo/hi 对实现，除/乘走 BigInt 保证 Java 截断与回绕语义。
 *
 * 配置：加载本文件前可设置全局 ASM_CONFIG = { memoryBytes: N, maxMemoryBytes: M }
 * （默认初始 128MB、上限 512MB；**偏紧档自动收紧**，见下方 PATCH(perfK)。
 * runtime 支持 Resizable ArrayBuffer 时堆按 2 倍自动扩容（地址不变、数据保留）；
 * 不支持时为固定初始容量）。
 */
'use strict';

(function () {
  // 初始容量默认 128MB（= perfI 实测稳定的值）；偏紧档会在下方 bootlim IIFE 里
  // 自动降到 32MB（Java 堆真实需求只有十几 MB，RAB 原地扩容对 VM 完全透明）。
  var TOTAL_MEMORY = 128 * 1024 * 1024;
  if (typeof ASM_CONFIG !== 'undefined' && ASM_CONFIG && ASM_CONFIG.memoryBytes) {
    TOTAL_MEMORY = ASM_CONFIG.memoryBytes | 0;
  }

  // 堆起始地址：跳过前 4KB，保证 0（NULL）与低地址永不出现在分配结果里。
  var HEAP_START = 4096;
  // bump 游标：仅在 freelist 找不到合适块时向前推进（早期版本是无回收的纯 bump 分配器，
  // 现在配合下面的 freelist 做复用 —— 别按"只增不减"读这段代码）。
  var bump = HEAP_START;

  // PATCH(j2me-nx-port): 可扩容堆。bump 分配器不回收，128MB 固定堆在长游玩
  // （剧情/切图狂产 Java 垃圾）下必然耗尽：new 返回地址 0（=Java null），
  // 事件泵 waitForNativeEvent 收到 null 抛 TypeError 后线程死亡 → 整机卡死
  // （2026-09-19 实机日志已证实）。VM 无 OOM 检查、真 GC 需精确根枚举风险高，
  // 故优先用 Resizable ArrayBuffer：原地 resize、数据保留、地址不变、
  // length-tracking 视图自动跟踪，对 VM 完全透明。
  //
  // 分配策略（PATCH perfK 2026-09-23：偏紧档重算）：
  //
  // 实机事实链：
  //   ① V8 构造 RAB 时按 maxByteLength 预提交物理页且不回收（自家 09-21 mman 日志实锤：
  //      "RAB@512 把 native 堆吃到 645/651MB，V8 连 young GC 晋升都分配不到"）。
  //   ② 偏紧档（heapSizeLimit=425MB）旧公式 want = 425 − 128 − 96 = 201MB
  //      → RAB 预提交 201MB，剩给 V8 的物理内存只有 ~224MB；实测 heapTotal 卡死在 57MB
  //      再也涨不上去（perfA/perfD/perfH 三次会话一致）→ 游戏加载图片时物理内存压穿
  //      → V8 fatal → runtime clean exit（无 crash report、日志突然断）。
  //   ③ 对照正常档（821MB）：rabmax = min(512, 821−224) = 512MB，V8 拿到 114.2MB 稳住，
  //      连续跑 171 秒三项内存全平。⇒ 差别就是"RAB 预提交了多少"。
  //   ④ Java 堆真实需求很小：perfI 实机 live 0.6~0.7MB、jheap 峰值 11.8MB。
  //
  // 新公式（档位自适应，正常档**一字不改**，只动偏紧档）：
  //   limMB >= 700（正常档）→ initial 128MB / max 512MB  ← 与 perfI 实测稳定的配置完全一致
  //   limMB <  700（偏紧档）→ initial 32MB / max clamp(limMB − 256 − 32, 64, 512)
  //   V8_RESERVE_MB = 256（实测 heapTotal 需求 114MB + V8 代码区/杂项；旧公式只留 96 太乐观）
  //   ⇒ 425 档 → 32/137MB（旧 128/201MB，省出最多 ~160MB 物理内存给 V8）
  //   ⇒ 468 档 → 32/180MB
  //   下限 64MB：Java 堆 live 只有十几 MB 量级、GC 兜底，足够；也避免 resize 到顶后
  //   malloc 返 0（VM 无 OOM 检查，null 会扩散成事件泵 TypeError）。
  var RAB_INITIAL_MB = 128;
  var RAB_TIGHT_INITIAL_MB = 32;
  var RAB_TIGHT_BELOW_MB = 700;
  var V8_RESERVE_MB = 256;
  var RAB_MAX_MB = 512;
  var RAB_CANDIDATES_MB = [512, 256, 128, 64];
  var MB = 1048576;
  // ASM_CONFIG.maxMemoryBytes（若有）插到候选首位；不用 |0，超 2GB 的值会回绕成负数
  if (typeof ASM_CONFIG !== 'undefined' && ASM_CONFIG && ASM_CONFIG.maxMemoryBytes > 0) {
    var cfgMax = ASM_CONFIG.maxMemoryBytes;
    RAB_MAX_MB = Math.round(cfgMax / MB);
  }
  var resizable = false;
  var buffer = null;
  var currentCapacity = TOTAL_MEMORY;
  var MAX_MEMORY = TOTAL_MEMORY; // 默认与初始容量一致；RAB 成功后更新为实际上限
  var diagParts = [];

  // 按启动档位自适应收紧 RAB 上限（必须在 diagParts 就绪后执行；此刻尚未构造 RAB）
  (function () {
    var limMB = 0;
    try {
      if (typeof Switch !== 'undefined' && Switch &&
          typeof Switch.memoryUsage === 'function') {
        limMB = Math.floor(Switch.memoryUsage().heapSizeLimit / MB);
      }
    } catch (eBootLim) { /* 忽略 */ }
    if (limMB >= RAB_TIGHT_BELOW_MB) {
      diagParts.push('bootlim:' + limMB + 'MB->正常档 rabinit:128MB rabmax:512MB(与perfI一致)');
      return;
    }
    if (limMB > 0) {
      RAB_INITIAL_MB = RAB_TIGHT_INITIAL_MB;
      var want = limMB - V8_RESERVE_MB - RAB_INITIAL_MB;
      RAB_MAX_MB = Math.max(64, Math.min(512, want));
      // 初始容量与上限必须一致地落到堆结构上（IIFE 在本文件构造 RAB 之前执行）
      TOTAL_MEMORY = RAB_INITIAL_MB * MB;
      currentCapacity = TOTAL_MEMORY;
      MAX_MEMORY = TOTAL_MEMORY;
      RAB_CANDIDATES_MB = [RAB_MAX_MB].concat(
        [512, 256, 128, 64].filter(function (m) { return m < RAB_MAX_MB; }));
      diagParts.push('bootlim:' + limMB + 'MB->偏紧档 rabinit:' + RAB_INITIAL_MB +
        'MB rabmax:' + RAB_MAX_MB + 'MB(v8reserve' + V8_RESERVE_MB + ')');
    } else {
      RAB_CANDIDATES_MB = [RAB_MAX_MB, 256, 128, 64];
    }
  })();

  function tryRab(maxBytes) {
    try {
      var b = new ArrayBuffer(TOTAL_MEMORY, { maxByteLength: maxBytes });
      // 验证 resize 真能用（有些实现允许构造但不允许扩）
      if (typeof b.resize === 'function' && b.byteLength === TOTAL_MEMORY) {
        b.resize(TOTAL_MEMORY + 8);
        b.resize(TOTAL_MEMORY);
        return b;
      }
      diagParts.push('rab@' + Math.round(maxBytes / MB) + 'MB:no-resize');
    } catch (e) {
      diagParts.push('rab@' + Math.round(maxBytes / MB) + 'MB:' + ((e && e.message) || e));
    }
    return null;
  }

  // PATCH(j2me-nx-port): RAB 跨会话复用。软重启会整体重求值本文件并新建
  // RAB@maxByteLength——实机 mman 会为 max 预提交物理页且不随对象失联立即
  // 回收（mman 日志实锤"reserved 812 of 1024"），旧 RAB 全靠 V8 GC 兜底。
  // 多会话叠加时 GC 时机稍有失手就把物理 arena 压穿：表现为 native.js 加载
  // 成功后 2ms 内无声 abort（2026-09-21 07:12 第 4 会话实录，无任何 JS fatal）。
  // 把 RAB 挂宿主全局跨会话复用：boot 时恢复全量容量并清零（等价新缓冲
  // 语义），此后软重启不再产生新的 512MB 物理提交。
  function tryReuseRab() {
    var persisted = null;
    try {
      persisted = (typeof globalThis !== 'undefined' && globalThis)
        ? globalThis.__j2mePersistentRAB : null;
    } catch (eP) { return false; }
    if (!persisted || !persisted.buf || !(persisted.maxBytes > 0)) {
      diagParts.push('rab:reuse:none');
      return false;
    }
    var b = persisted.buf;
    try {
      if (typeof b.resize !== 'function' || b.byteLength < TOTAL_MEMORY) {
        diagParts.push('rab:reuse:invalid');
        return false;
      }
      // 先恢复到全量容量再整体清零：mman 按 max 预提交，resize 上去不产生
      // 新物理提交；清零后与"新建的全零缓冲"语义完全一致（后续 growHeap
      // 露出的区域也是本次清过的）。
      b.resize(persisted.maxBytes);
      new Uint8Array(b).fill(0);
      b.resize(TOTAL_MEMORY);
      buffer = b;
      resizable = true;
      currentCapacity = TOTAL_MEMORY;
      MAX_MEMORY = persisted.maxBytes;
      diagParts.push('rab:reuse@' + Math.round(persisted.maxBytes / MB) + 'MB');
      return true;
    } catch (eR) {
      diagParts.push('rab:reuse:' + ((eR && eR.message) || eR));
      return false;
    }
  }

  if (!tryReuseRab()) {
    for (var ri = 0; ri < RAB_CANDIDATES_MB.length; ri++) {
      var capBytes = RAB_CANDIDATES_MB[ri] * MB;
      if (capBytes < TOTAL_MEMORY) continue;
      var rab = tryRab(capBytes);
      if (rab) {
        buffer = rab;
        resizable = true;
        currentCapacity = TOTAL_MEMORY;
        MAX_MEMORY = capBytes;
        diagParts.push('rab:ok@' + RAB_CANDIDATES_MB[ri] + 'MB');
        break;
      }
    }
  }
  // 成功拿到可扩容堆后持久化到宿主全局（下次会话直接复用）
  if (buffer && resizable) {
    try {
      if (typeof globalThis !== 'undefined' && globalThis) {
        globalThis.__j2mePersistentRAB = { buf: buffer, maxBytes: MAX_MEMORY };
      }
    } catch (eStore) { /* 忽略 */ }
  }
  if (!buffer) {
    // 最后兜底：初始 128MB 固定堆（原行为；不支持 RAB 的运行时走这里）。
    buffer = new ArrayBuffer(TOTAL_MEMORY);
    currentCapacity = TOTAL_MEMORY;
    MAX_MEMORY = Math.max(MAX_MEMORY, TOTAL_MEMORY);
    diagParts.push('fallback:128MB-fixed');
  }

  function growHeap(needed) {
    if (!resizable) return false;
    var target = currentCapacity;
    while (target < needed) {
      target = target * 2;
      if (target > MAX_MEMORY) { target = MAX_MEMORY; break; } // 过冲截到上限
    }
    if (target > MAX_MEMORY) target = MAX_MEMORY;
    if (target <= currentCapacity) return false;
    try {
      // 原地扩容：数据与地址全部保留，length-tracking 视图自动跟踪
      buffer.resize(target);
      currentCapacity = target;
      return true;
    } catch (e) {
      diagParts.push('grow:' + Math.round(target / MB) + 'MB:' + ((e && e.message) || e));
      return false;
    }
  }

  var HEAP8   = new Int8Array(buffer);
  var HEAPU8  = new Uint8Array(buffer);
  var HEAP16  = new Int16Array(buffer);
  var HEAPU16 = new Uint16Array(buffer);
  var HEAP32  = new Int32Array(buffer);
  var HEAPU32 = new Uint32Array(buffer);
  var HEAPF32 = new Float32Array(buffer);
  var HEAPF64 = new Float64Array(buffer);

  // ------------------------------------------------------------------
  // GC / bump allocator
  //
  // PATCH(20260922-gc1): 保守 mark-sweep GC（安全点式）。
  //   块布局：[word0 = size|PERM][word1 = 保留] payload...（块头 8B）
  //   mark 位在堆外位图（绝不写堆 payload，误标只会多留不会损坏）。
  //   sweep 从 HEAP_START 顺序走链，相邻空闲合并，尾部自由区回退 bump。
  //   GC 只在安全点跑（scheduler ctx.execute() 返回后，帧已全部同步进堆）；
  //   堆余量不足 GC_RESERVE 时置 gcPending，安全点回收；slack 耗尽才 OOM。
  //   任何链校验失败 → gcBroken=true，永久回退纯 bump（等同旧行为）。
  // ------------------------------------------------------------------

  var GC_RESERVE = 16 * MB;      // 堆尾预留：给"已请求未执行"的 GC 兜底
  var GC_RETRIGGER = 4 * MB;     // 迟滞：GC 后 bump 需再涨这么多才允许重新触发
                                 // （gc5 实机教训：高水位停在线上 → 每个安全点
                                 // 都重触发 → GC 每 825ms 一次、每次 825ms，
                                 // VM 一半时间在 GC）
  var GC_RAMP = 16 * MB;         // 棘轮护栏（gc7）：距上次 GC bump 涨 16MB 就 GC，
                                 // 不让死帧坟场攒到 112MB 才首次回收（30 万块头
                                 // 拖慢链遍历 + freelist 迟迟不可用）
  var gcPending = false;
  var gcBroken = false;          // 一旦损坏立即永久禁用，退回纯 bump
  var bumpAtLastGC = 0;          // 上次 GC 结束时的 bump（迟滞基线）
  var collecting = false;
  var lastGCStats = null;
  // PATCH(perfE 2026-09-23)：块头 word0 的 bit1 = NOSCAN「payload 内不含引用，mark 免扫」。
  // 实机证据（error.log 05:06:34 [gc] 回收 6.5MB（43341 块）用时 1141ms + [alloc] 旁路采样）：
  // GC 停顿 1.1~1.4s，而 Node 复现里 43 万块 sweep 只要 17ms → 停顿不在 sweep，
  // 在 traceMarkedBlocks 的保守 mark——它把每个存活块 payload 的**每个 4 字节 word**
  // 都当候选指针，而游戏存活集里最大的是图片 byte[]（[alloc] 窗口 byte[]=10.31MB/97%）。
  // 基本类型数组（byte[]/char[]/short[]/int[]/long[]/float[]/double[]/boolean[]）
  // 的 payload 在 Java 语义上只放基本类型，永远不可能是指针 → 打标记后免扫，
  // 但对象数组（[Ljava/lang/Object; 等）与普通对象仍按原样保守扫。
  var NOSCAN = 2;
  var scanStats = { words: 0, bytes: 0, skipBytes: 0, skipBlocks: 0, rejCand: 0 };
  var markBits = null;           // 每 8 字节 slot 1 bit
  var markBitsSlots = 0;
  // PATCH(perfI 2026-09-23)：块起点位图。
  // 实机证据（error.log 05:30:10 [gc] 回收 3.6MB（91822 块）用时 755ms
  // [prep=0 根=8 mark=730 sweep=17] 扫=211.2MB 免扫=62.4MB 存活块 9610 存活=0.9MB）：
  // 存活 payload 只有 0.9MB，mark 却扫了 211MB —— 唯一的解释是**假块**：
  // markCandidate 原来只做"读 p-8 当 size、size>=8 且落在堆内"的弱校验，
  // 于是一个指向某对象内部的 8 对齐地址（游戏图片 byte[] 里到处都是这种数），
  // 只要它前面 4 字节恰好是个合理的小整数，就会被当成合法块头 → 标记 → 被
  // traceMarkedBlocks 按那个假 size 大扫一遍（最坏 ~堆大小）。
  // 修法：GC 第一次链遍历时把**真实块起点**记进位图，markCandidate 只认位图上的起点。
  // 只是过滤假候选（不会漏真根：本 VM 的引用一律指向 payload 起点 = 块起点+8），
  // 因此 mark 扫描量从"假块大小之和"回到"真实存活 payload"。
  var blockBits = null;
  var blockBitsSlots = 0;
  var freelist = [];             // [{a: blockStart, s: payloadSize}] 按地址序
  var freelistBytes = 0;         // freelist 里立即可复用的总字节数（含块头）
                                 //（gc8：紧急线的真压力判断——bump 顶到容量线
                                 // 但 freelist 有大把内存时根本不缺内存，
                                 // gc6-run1 实机 125MB freelist + 紧急线粘连
                                 // = 每 1.5s 白跑一次 1.46s 的 GC 饿死游戏）；
                                 // 只由 sweep 供给 + 原位余量替换（gc7，桶已废）
  var markStack = [];

  // 触发判定（malloc 与 _collectALittle 共用）：
  //   紧急线（距 OOM 2MB）：无视迟滞立即请求；
  //   棘轮护栏（gc7）：距上次 GC 涨 GC_RAMP 即请求（压坟场深度）；
  //   常规线（GC_RESERVE）：需距上次 GC bump 再涨 GC_RETRIGGER 才请求。
  // 稳态下分配全部来自 freelist 复用、bump 不再增长 → 不再 GC（平台化）。
  function shouldTriggerGC() {
    // 紧急线：真·内存耗尽（bump 顶到容量线且 freelist 几乎为空）。
    // freelist 充裕时绝不触发——那是"高水位+可复用"，不是压力。
    if (bump > currentCapacity - 2 * MB && freelistBytes < 16 * MB) {
      gcSrcCount("紧急线");
      return true;
    }
    if (bump - bumpAtLastGC >= GC_RAMP) {
      gcSrcCount("常规棘轮");
      return true;
    }
    if (bump > currentCapacity - GC_RESERVE &&
        bump - bumpAtLastGC >= GC_RETRIGGER) {
      gcSrcCount("余量线");
      return true;
    }
    return false;
  }

  /*
   * PATCH(perfZ18)：GC 触发源计数（**只量不改**）。
   * 实机 perfZ16/perfZ18 六次换游戏后出现过"每 ~20ms 回收 0MB、扫=0.2MB（堆几乎空）"的痉挛。
   * 第一版只装了紧急线，结果**一次都没触发** → 说明痉挛来自常规棘轮或余量线。这里把三条都装上，
   * 下次日志直接看是哪个名字在涨。盲改 GC 是历史"实机假死"的来源，所以坚持先量后改。
   */
  function gcSrcCount(which, a, b) {
    if (typeof gcSrc === "undefined") {
      gcSrc = { emerg: 0, ramp: 0, reserve: 0, grow: 0, growFail: 0, last: "" };
    }
    if (which === "紧急线") gcSrc.emerg++;
    else if (which === "常规棘轮") gcSrc.ramp++;
    else gcSrc.reserve++;
    gcSrc.last = which;
    var tot = gcSrc.emerg + gcSrc.ramp + gcSrc.reserve;
    if (tot <= 6 || tot % 100 === 0) {
      try {
        console.log("[gc-src] " + which + " 触发（累计 紧急 " + gcSrc.emerg + " / 常规棘轮 " +
          gcSrc.ramp + " / 余量线 " + gcSrc.reserve + "；扩容成功 " + gcSrc.grow + " 失败 " +
          gcSrc.growFail + "）bump=" + Math.round(bump / MB) + "MB cap=" +
          Math.round(currentCapacity / MB) + "MB freelist=" + Math.round(freelistBytes / MB) + "MB");
      } catch (eL) { /* 忽略 */ }
    }
  }

  // 分配卡顿探针：单次 malloc > STALL_MS 记现场（主心跳经 __heapStall 读取）
  var STALL_MS = 150;
  var stallInfo = null;

  // 探针：全量分配口径（native-heap 是必经咽喉）——[alloc] 报告对比
  // classified（runtime 按类记账）与 raw（本处累计）之差即第三旁路流量。
  var rawWindow = 0;
  var rawAllocCount = 0;

  function align8(n) {
    return (n + 7) & ~7;
  }

  function ensureMarkBits() {
    var slots = (currentCapacity - HEAP_START) >> 3;
    if (!markBits || markBitsSlots < slots) {
      markBits = new Uint8Array((slots + 7) >> 3);
      markBitsSlots = slots;
    } else {
      markBits.fill(0, 0, ((bump - HEAP_START) >> 3) + 8 >> 3);
    }
    if (!blockBits || blockBitsSlots < slots) {
      blockBits = new Uint8Array((slots + 7) >> 3);
      blockBitsSlots = slots;
    }
  }

  function clearMarkRange() {
    // 只清本次堆范围内用到的位（bump 之后是高水位残留，sweep 会重写）
    var usedSlots = (bump - HEAP_START) >> 3;
    markBits.fill(0, 0, (usedSlots >> 3) + 1);
    // 块起点位图每次 GC 由第一次链遍历重建（堆在 GC 期间不变），所以这里只需清零
    blockBits.fill(0, 0, (usedSlots >> 3) + 1);
  }

  function markSlot(blockStart) {
    var slot = (blockStart - HEAP_START) >> 3;
    markBits[slot >> 3] |= (1 << (slot & 7));
  }

  function isMarked(blockStart) {
    var slot = (blockStart - HEAP_START) >> 3;
    return (markBits[slot >> 3] & (1 << (slot & 7))) !== 0;
  }

  function setBlockBit(blockStart) {
    var slot = (blockStart - HEAP_START) >> 3;
    blockBits[slot >> 3] |= (1 << (slot & 7));
  }

  function isBlockStart(blockStart) {
    var slot = (blockStart - HEAP_START) >> 3;
    return (blockBits[slot >> 3] & (1 << (slot & 7))) !== 0;
  }

  // candidate 校验 + 标记。只读堆 + 写堆外位图：误标无害（多留一轮）。
  // 最小合法 payload = HEAP_START+8（第一块），阈值取 +8。
  function markCandidate(p) {
    if (p < HEAP_START + 8 || p >= bump || (p & 7) !== 0) return;
    var bs = p - 8;
    // perfI：只认真实块起点（假候选一律拒绝——这是 mark 扫描量爆炸的根源）
    if (!isBlockStart(bs)) { scanStats.rejCand++; return; }
    var sizeWord = HEAP32[bs >> 2] >>> 0;
    var size = sizeWord & 0xFFFFFFFC; // 去掉 perm 位 + NOSCAN 位
    if (size < 8 || bs + 8 + size > bump) return;
    if (isMarked(bs)) return;
    markSlot(bs);
    markStack.push(bs);
  }

  // DFS 标记：块 payload 内每个 4 字节 word 都视为潜在引用（保守）。
  // perfE：带 NOSCAN 位的基本类型数组整块跳过（省掉 mark 阶段的大头）。
  function traceMarkedBlocks() {
    while (markStack.length) {
      var bs = markStack.pop();
      var sizeWord = HEAP32[bs >> 2] >>> 0;
      var size = sizeWord & 0xFFFFFFFC;
      if (sizeWord & NOSCAN) {
        scanStats.skipBlocks++;
        scanStats.skipBytes += size;
        continue;
      }
      var payload = bs + 8;
      var words = size >> 2;
      scanStats.words += words;
      scanStats.bytes += words << 2;
      for (var w = 0; w < words; w++) {
        var v = HEAP32[(payload + (w << 2)) >> 2];
        if (v >= HEAP_START + 8 && v < bump) {
          markCandidate(v);
        }
      }
    }
  }

  function allocFromFreelist(size, perm, noScan) {
    var aligned = align8(size);
    // first-fit + 原位余量替换（gc7）：
    //   gc5 的"余量投精确尺寸桶"是实机 OOM 棘轮的根因——余量(~180KB)按精确
    //   key 入桶，后续分配要 88B/150KB 永远匹配不上，几百 MB 余量搁浅，
    //   分配 100% 落 bump 直到 OOM（本地复现：92 次命中后全 miss）。
    //   原位替换后余量留在 freelist 同槽位，任意尺寸都能 first-fit 复用；
    //   小分配稳定命中低地址槽位（O(1)~O(i)），free 又是延迟回收不进链表，
    //   gc3 的 O(n²) 不会复发。
    for (var i = 0; i < freelist.length; i++) {
      var f = freelist[i];
      if (f.s >= aligned) {
        var bs = f.a;
        var rest = f.s - aligned - 8;
        if (rest >= 32) {
          freelist[i] = { a: bs + 8 + aligned, s: rest }; // 原位替换（不 splice 不 push）
          freelistBytes -= aligned + 8;                   // 拆出的部分变成已用
          HEAP32[(bs + 8 + aligned) >> 2] = rest; // 余量块头（非 perm）
          HEAP32[(bs + 8 + aligned + 4) >> 2] = 0; // 字2 清零（防陈旧 freed 标志误判双 free）
        } else {
          aligned = f.s; // 余量太小，整块给出去（内部少量 padding）
          freelist.splice(i, 1);
          freelistBytes -= f.s + 8;
        }
        HEAP32[bs >> 2] = aligned | (perm ? 1 : 0) | (noScan ? NOSCAN : 0);
        HEAP32[(bs + 4) >> 2] = 0;
        return bs + 8;
      }
    }
    return 0;
  }

  function malloc(size, zero, perm, noScan) {
    // 注意：不能用 size|0——超大请求会回绕成小整数造成错误分配。
    // 非 normal 数字（NaN/负数/超堆容量）一律按 OOM 处理返回 0。
    if (!(size >= 0) || size > MAX_MEMORY - HEAP_START) {
      return 0;
    }
    size = size | 0;
    if (gcBroken) {
      return mallocBump(size, zero, perm, noScan);
    }
    var aligned = align8(size);
    // 分配卡顿采样（1/256）：单次 >STALL_MS 记现场，心跳经 __heapStats 读出
    var sampled = (rawAllocCount & 255) === 0;
    var t0 = sampled ? (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) : 0;
    // 频繁命中 freelist 前先快速判断：freelist 有块才进分配函数
    if (freelist.length) {
      var addr = allocFromFreelist(size, perm, noScan);
      if (addr) {
        if (zero) HEAPU8.fill(0, addr, addr + size);
        rawWindow += size; rawAllocCount++;
        if (sampled) recordStall(t0, size, 'freelist');
        return addr;
      }
    }
    // 余量触发线：见 shouldTriggerGC（含迟滞，gc6）
    if (shouldTriggerGC()) {
      gcPending = true;
    }
    var addr2 = mallocBump(size, zero, perm, noScan);
    if (!addr2) return 0;
    rawWindow += size; rawAllocCount++;
    if (sampled) recordStall(t0, size, 'bump');
    if ((rawAllocCount & 16383) === 0 && typeof globalThis !== 'undefined') {
      try { globalThis.__allocSample = new Error().stack; } catch (eS) { /* 忽略 */ }
    }
    return addr2;
  }

  function recordStall(t0, size, path) {
    if (!t0) return;
    var t1 = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    var dt = t1 - t0;
    if (dt > STALL_MS) {
      stallInfo = { ms: Math.round(dt), size: size, path: path, freelist: freelist.length };
    }
  }

  function mallocBump(size, zero, perm, noScan) {
    var aligned = align8(size);
    var blockStart = align8(bump);
    var end = blockStart + 8 + aligned;
    if (end > currentCapacity) {
      // 当前容量不够：先尝试扩容（地址不变、数据保留）
      if (!growHeap(end)) {
        // 扩不了（到上限或运行时不支持）：OOM，返回 0（NULL）
        return 0;
      }
    }
    bump = end;
    HEAP32[blockStart >> 2] = aligned | (perm ? 1 : 0) | (noScan ? NOSCAN : 0);
    HEAP32[(blockStart + 4) >> 2] = 0;
    if (zero) {
      HEAPU8.fill(0, blockStart + 8, end);
    }
    return blockStart + 8;
  }

  // 安全点 GC 本体。collectRoots(addRoot, addRootRange) 由 VM 提供：
  //   addRoot(addr)          — 单个 Java 对象地址
  //   addRootRange(b0, b1)   — [b0,b1) 字节区间，逐 4 字节当候选（线程栈等）
  // 返回统计对象；链损坏抛异常并由本函数捕获置 gcBroken（回退纯 bump）。
  function collect(collectRoots) {
    if (gcBroken || collecting || !collectRoots) return null;
    collecting = true;
    try {
      var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      var usedBefore = bump - HEAP_START;
      ensureMarkBits();
      clearMarkRange();
      markStack.length = 0;
      scanStats.words = 0; scanStats.bytes = 0; scanStats.skipBytes = 0; scanStats.skipBlocks = 0; scanStats.rejCand = 0;
      var tPrep = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      // 上一轮 GC 留下的 freelist 总量（gc8）：sweep 会把它们重新数进
      // freedBytes——gc6-run1 实机"每 1.5s 回收 125.1MB"就是这笔假账
      //（raw 分配率只有 0.19MB/10s，真正新增垃圾≈0）。减掉才是真回收量。
      var freelistBytesBefore = 0;
      for (var flb = 0; flb < freelist.length; flb++) freelistBytesBefore += freelist[flb].s + 8;

      // uncollectable（perm）块全部视为根：标记自身 + 保守扫其内容
      var walk = HEAP_START;
      var permBlocks = 0;
      while (walk < bump) {
        var sizeWord = HEAP32[walk >> 2] >>> 0;
        var size = sizeWord & 0xFFFFFFFC;
        if (size < 8 || walk + 8 + size > bump) {
          throw new Error('heap walk desync @' + walk + ' size=' + size);
        }
        setBlockBit(walk);   // perfI：登记真实块起点（markCandidate 的唯一合法目标）
        if (sizeWord & 1) {
          markSlot(walk);
          markStack.push(walk);
          permBlocks++;
        }
        walk += 8 + size;
      }
      if (walk !== bump) throw new Error('heap walk misalign end');

      // VM 根集合
      collectRoots(function (addr) { markCandidate(addr); },
                   function (b0, b1) {
                     if (b1 > bump) b1 = bump;
                     for (var a = b0 & ~7; a < b1; a += 4) {
                       var v = HEAP32[a >> 2];
                       if (v >= HEAP_START + 8 && v < bump) markCandidate(v);
                     }
                   });

      var tRoots = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      traceMarkedBlocks();
      var tMark = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

      // sweep：顺序走链，未标记非 perm 的进 freelist / 回退 bump
      freelist.length = 0;
      var lastKeptEnd = HEAP_START;
      var freedBytes = 0, freedBlocks = 0, keptBlocks = 0, keptBytes = 0;
      walk = HEAP_START;
      while (walk < bump) {
        var sizeWord2 = HEAP32[walk >> 2] >>> 0;
        var size2 = sizeWord2 & 0xFFFFFFFC;
        var end2 = walk + 8 + size2;
        if (size2 < 8 || end2 > bump) {
          throw new Error('sweep walk desync @' + walk);
        }
        if ((sizeWord2 & 1) || isMarked(walk)) {
          HEAP32[(walk + 4) >> 2] = 0; // 清 mark 位（下次 GC 前全量清也行，双保险）
          keptBlocks++;
          keptBytes += size2 + 8;
          lastKeptEnd = end2;
        } else {
          freedBytes += size2 + 8;
          freedBlocks++;
        }
        walk = end2;
      }
      // 尾部自由区：直接回退 bump（最常见——byte[] 垃圾都在堆顶）
      if (lastKeptEnd < bump) {
        bump = lastKeptEnd;
      }
      // 中部空洞：走一遍 freelist 合并（sweep 已按地址序，直接收集）。
      // gc7 关键优化：合并 run 的块头写回堆链——30 万个死帧头坍缩成一个
      // 块头，下一轮 GC 的链遍历从"历史全部块数"降到"存活块+run 数"。
      // run 内部旧块头成为合并块 payload 里的死数据，永不再被遍历。
      walk = HEAP_START;
      var freeRunStart = -1;
      while (walk < bump) {
        var sizeWord3 = HEAP32[walk >> 2] >>> 0;
        var size3 = sizeWord3 & 0xFFFFFFFC;
        var end3 = walk + 8 + size3;
        if (isMarked(walk) || (sizeWord3 & 1)) {
          if (freeRunStart >= 0) {
            var runSize = walk - freeRunStart - 8;
            HEAP32[freeRunStart >> 2] = runSize;    // 合并块头（非 perm）
            HEAP32[(freeRunStart + 4) >> 2] = 0;
            freelist.push({ a: freeRunStart, s: runSize });
            freelistBytes += runSize + 8;
            freeRunStart = -1;
          }
        } else if (freeRunStart < 0) {
          freeRunStart = walk;
        }
        walk = end3;
      }
      if (freeRunStart >= 0) {
        var tailSize = bump - freeRunStart - 8;
        HEAP32[freeRunStart >> 2] = tailSize;
        HEAP32[(freeRunStart + 4) >> 2] = 0;
        freelist.push({ a: freeRunStart, s: tailSize });
        freelistBytes += tailSize + 8;
      }

      // 弱引用清理：目标已死（不在堆内或未被标记）→ 清空 holder 槽位并删链接
      disappearingLinks.forEach(function (target, holder) {
        var alive = target >= HEAP_START + 8 && target < bump && isMarked(target - 8);
        if (!alive) {
          HEAP32[holder >> 2] = 0;
          disappearingLinks.delete(holder);
        }
      });

      var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      var freedReal = freedBytes > freelistBytesBefore ? freedBytes - freelistBytesBefore : 0;
      lastGCStats = {
        ms: Math.round((t1 - t0) * 10) / 10,
        usedBeforeMB: Math.round(usedBefore / MB * 10) / 10,
        freedMB: Math.round(freedReal / MB * 10) / 10,
        freedBlocks: freedBlocks,
        keptBlocks: keptBlocks,
        freelistMB: Math.round(freelistBytes / MB * 10) / 10,
        // perfE 分期：prep(清位图)/roots(根集合)/mark(保守 mark)/sweep(走链+合并)
        prepMs: Math.round((tPrep - t0) * 10) / 10,
        rootsMs: Math.round((tRoots - tPrep) * 10) / 10,
        markMs: Math.round((tMark - tRoots) * 10) / 10,
        sweepMs: Math.round((t1 - tMark) * 10) / 10,
        permBlocks: permBlocks,
        keptMB: Math.round(keptBytes / MB * 10) / 10,
        scanMB: Math.round(scanStats.bytes / MB * 10) / 10,
        skipMB: Math.round(scanStats.skipBytes / MB * 10) / 10,
        scanB: scanStats.bytes,
        skipB: scanStats.skipBytes,
        skipBlocks: scanStats.skipBlocks,
        rejCand: scanStats.rejCand
      };
      gcPending = false;
      bumpAtLastGC = bump; // 迟滞基线（gc6）：防止高水位滞留线上导致抖动
      // 紧急线粘连兜底（gc8，gc6-run1 实机教训）：GC 后 bump 仍顶在
      // 紧急线上 = 存活/perm 块钉住堆顶、GC 无力回天。此时不扩容的话，
      // 紧急线（无迟滞）在每个安全点重触发 → GC 每 1.5s 一次、每次
      // 1.46s，游戏被饿死假死。扩 64MB 让紧急线挪走（RAB 上限内免费）。
      if (bump > currentCapacity - 2 * MB) {
        var grewOk = growHeap(currentCapacity + 64 * MB);
        gcSrc.grow++;
        // PATCH(perfZ18)：扩容成不成功必须计数。实机 perfZ16 六次换游戏后出现过痉挛
        // （每 ~20ms 回收 0MB、扫=0.2MB，堆几乎是空的），而"GC 后仍顶线 → growHeap"
        // 这条兜底本来就在上面那段 gc8 里；若 growHeap 被 RAB 上限卡住而失败，
        // 紧急线就永远挪不走 → 只能靠计数钉死是"扩容失败"还是"别的触发源"。
        if (!grewOk) gcSrc.growFail++;
        bumpAtLastGC = bump; // 扩容不改变 bump，但确保基线一致
      }
      return lastGCStats;
    } catch (eGC) {
      // 链损坏：永久禁用 GC，回退纯 bump（分配语义与旧版一致）
      gcBroken = true;
      freelist.length = 0;
      freelistBytes = 0;
      bumpAtLastGC = bump;
      lastGCStats = { broken: true, err: String(eGC && eGC.message || eGC) };
      return lastGCStats;
    } finally {
      collecting = false;
      markStack.length = 0;
    }
  }

  // holder 地址 -> target 地址。无 GC 时链接永不失效，
  // 弱引用表现为"目标对象存活期内有效"（本实现中即永远）。
  var disappearingLinks = new Map();
  var finalizers = new Set();

  // ------------------------------------------------------------------
  // 64 位读/写（字节地址，lo = [addr], hi = [addr + 4]，均为 i32）
  // ------------------------------------------------------------------

  function read64(addr) {
    var lo = HEAP32[addr >> 2] >>> 0;
    var hi = HEAP32[(addr + 4) >> 2] | 0;
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  function write64(addr, valueBig) {
    var v = BigInt.asIntN(64, valueBig);
    HEAP32[addr >> 2] = Number(v & 0xffffffffn) | 0;
    HEAP32[(addr + 4) >> 2] = Number((v >> 32n) & 0xffffffffn) | 0;
  }

  // 加减法快速路径（i32 lo/hi + 进位），不用 BigInt，解释器热路径用。
  function lAdd(dst, a, b) {
    var alo = HEAP32[a >> 2] | 0, ahi = HEAP32[(a + 4) >> 2] | 0;
    var blo = HEAP32[b >> 2] | 0, bhi = HEAP32[(b + 4) >> 2] | 0;
    var lo = (alo + blo) | 0;
    var carry = (((alo >>> 0) + (blo >>> 0)) > 0xffffffff) ? 1 : 0;
    HEAP32[dst >> 2] = lo;
    HEAP32[(dst + 4) >> 2] = (ahi + bhi + carry) | 0;
  }

  function lSub(dst, a, b) {
    var alo = HEAP32[a >> 2] | 0, ahi = HEAP32[(a + 4) >> 2] | 0;
    var blo = HEAP32[b >> 2] | 0, bhi = HEAP32[(b + 4) >> 2] | 0;
    var lo = (alo - blo) | 0;
    var borrow = ((alo >>> 0) < (blo >>> 0)) ? 1 : 0;
    HEAP32[dst >> 2] = lo;
    HEAP32[(dst + 4) >> 2] = (ahi - bhi - borrow) | 0;
  }

  function lNeg(dst, a) {
    var lo = HEAP32[a >> 2] | 0, hi = HEAP32[(a + 4) >> 2] | 0;
    if (lo === 0) {
      HEAP32[dst >> 2] = 0;
      HEAP32[(dst + 4) >> 2] = (-hi) | 0;
    } else {
      HEAP32[dst >> 2] = (-lo) | 0;
      HEAP32[(dst + 4) >> 2] = (~hi) | 0;
    }
  }

  function lShl(dst, a, shift) {
    shift = Number(shift) & 63;
    if (shift === 0) {
      if (dst !== a) { lCopy(dst, a); }
      return;
    }
    var lo = HEAP32[a >> 2] >>> 0, hi = HEAP32[(a + 4) >> 2] >>> 0;
    var loBig = (BigInt(hi) << 32n) | BigInt(lo);
    write64(dst, BigInt.asIntN(64, loBig << BigInt(shift)));
  }

  function lShr(dst, a, shift) {
    shift = Number(shift) & 63;
    if (shift === 0) {
      if (dst !== a) { lCopy(dst, a); }
      return;
    }
    write64(dst, read64(a) >> BigInt(shift));
  }

  function lUshr(dst, a, shift) {
    shift = Number(shift) & 63;
    if (shift === 0) {
      if (dst !== a) { lCopy(dst, a); }
      return;
    }
    var lo = HEAP32[a >> 2] >>> 0, hi = HEAP32[(a + 4) >> 2] >>> 0;
    var u = (BigInt(hi) << 32n) | BigInt(lo);
    write64(dst, BigInt.asIntN(64, u >> BigInt(shift)));
  }

  function lCopy(dst, a) {
    HEAP32[dst >> 2] = HEAP32[a >> 2];
    HEAP32[(dst + 4) >> 2] = HEAP32[(a + 4) >> 2];
  }

  function lMul(dst, a, b) {
    write64(dst, read64(a) * read64(b));
  }

  function lDiv(dst, a, b) {
    var x = read64(a), y = read64(b);
    if (y === 0n) {
      // 与原版一致：除零交给 Java 侧抛 ArithmeticException，
      // asm.js 原版会触发 trap，这里直接写回 0 并由 VM 的显式检查兜底。
      write64(dst, 0n);
      return;
    }
    if (x === BigInt(-9223372036854775808) && y === -1n) {
      write64(dst, x); // Long.MIN_VALUE / -1 = Long.MIN_VALUE（Java 语义回绕）
      return;
    }
    write64(dst, x / y); // BigInt 除法天然向零截断
  }

  function lRem(dst, a, b) {
    var x = read64(a), y = read64(b);
    if (y === 0n) {
      write64(dst, 0n);
      return;
    }
    if (x === BigInt(-9223372036854775808) && y === -1n) {
      write64(dst, 0n);
      return;
    }
    write64(dst, x % y); // BigInt % 符号跟随被除数，与 Java 一致
  }

  function lCmp(dst, a, b) {
    var x = read64(a), y = read64(b);
    HEAP32[dst >> 2] = x < y ? -1 : (x > y ? 1 : 0);
  }

  // ------------------------------------------------------------------
  // 导出全局 ASM（j2me.js 在其后加载，nat.ts 顶层即取 ASM.buffer 等）
  // ------------------------------------------------------------------

  var ASM = {
    buffer: buffer,
    HEAP8: HEAP8,
    HEAPU8: HEAPU8,
    HEAP16: HEAP16,
    HEAPU16: HEAPU16,
    HEAP32: HEAP32,
    HEAPU32: HEAPU32,
    HEAPF32: HEAPF32,
    HEAPF64: HEAPF64,

    _gcMalloc: function (size) { return malloc(size, true, false); },
    _gcMallocAtomic: function (size) { return malloc(size, true, false); },
    // perfE：基本类型数组专用（payload 内无引用）→ 打 NOSCAN 位，GC mark 免扫。
    // 只允许 VM 在确认 classInfo 是 PrimitiveArrayClassInfo 时调用；
    // 复用 freelist 时该位会被清掉（保守退回扫描，方向安全）。
    _gcMallocAtomicNoScan: function (size) { return malloc(size, true, false, true); },
    _gcMallocUncollectable: function (size) { return malloc(size, true, true); },
    // free = 延迟回收（20260922-gc5，实机教训：gc3/gc4 的"free 立即复用"
    // 让游戏必死在资源加载节点——gc2 同节点畅通，gc3(线性freelist)/gc4(O(1)桶)
    // 都冻死且全程 0 次 GC，排除性能因素后唯一变量就是立即复用本身。上游
    // 对 freed uncollectable 块存在我们扫不出来的残余别名假设，Boehm 的
    // free 有 free-list 延迟与调试钩子并不完全等价）。
    // 实现：只清 perm 位 + 打 freed 标志（防双 free），块留在堆链里；
    // 下一轮 GC 时它按普通垃圾参与保守裁定——若仍有引用（挂起线程的
    // pending 帧等，collectGarbage 已显式补根）会被重新标记存活，确认
    // 无引用才由 sweep 进 freelist 复用。GC 之前的分配行为与 gc2（纯
    // bump O(1)）完全一致——实机已验证可进游戏。
    _gcFree: function (addr) {
      if (!addr || gcBroken || collecting) return;
      var bs = addr - 8;
      if (bs < HEAP_START || bs >= bump) return;
      var sizeWord = HEAP32[bs >> 2] >>> 0;
      var size = sizeWord & 0xFFFFFFFC;
      if (size < 8 || bs + 8 + size > bump) return; // 非法地址防御
      if (HEAP32[(bs + 4) >> 2] & 1) return;        // 已释放（双 free 无害忽略）
      if (!(sizeWord & 1)) return;                  // 非 perm 块上游不该 free
      HEAP32[bs >> 2] = size;     // 清 perm 位（GC 视为普通垃圾参与裁定）
      HEAP32[(bs + 4) >> 2] = 1;  // freed 标志
      // 不入 freelist/桶：立即复用是 gc3/gc4 假死的根因，见上
    },
    _gcRegisterDisappearingLink: function (holder, target) {
      disappearingLinks.set(holder, target);
      return 1;
    },
    _gcUnregisterDisappearingLink: function (holder) {
      disappearingLinks.delete(holder);
      return 1;
    },
    _registerFinalizer: function (addr) {
      finalizers.add(addr);
      return 1;
    },
    _forceCollection: function () { gcPending = true; },
    // collectALittle 在 int.ts endUnwind() 每次 unwind 都会调（原版 bump 下是
    // 空操作）。若无条件置 pending，会变成"每个安全点都 GC"的风暴——实机
    // 实测 6.2MB/128MB 堆却每 100~300ms 一次 47~59ms 的 GC，加载期直接卡死。
    // 语义保留：仅在堆压临近预留线时请求回收（分配路径也有同样触发，双保险）。
    // 语义保留：仅按堆压触发（含迟滞，gc6——无条件置 pending 会重现
    // gc1 的 GC 风暴，高水位滞留线上会重现 gc5 的 825ms 抖动）
    _collectALittle: function () {
      if (shouldTriggerGC()) gcPending = true;
    },
    _getUsedHeapSize: function () { return bump - HEAP_START; },

    // ---- GC 扩展接口（安全点由 scheduler 调用）----
    __gcPending: function () { return gcPending && !gcBroken; },
    __collect: function (collectRoots) { return collect(collectRoots); },
    __lastGCStats: function () { return lastGCStats; },
    __gcBroken: function () { return gcBroken; },
    __freelistCount: function () { return freelist.length; },
    // 探针：全量分配口径（含未挂钩旁路）
    __rawWindow: function () { var r = rawWindow; rawWindow = 0; return r; },
    __allocSample: function () {
      try { return globalThis.__allocSample || null; } catch (e) { return null; }
    },
    __heapStats: function () { var s = stallInfo; stallInfo = null; return s; },

    _lAdd: lAdd,
    _lSub: lSub,
    _lMul: lMul,
    _lDiv: lDiv,
    _lRem: lRem,
    _lNeg: lNeg,
    _lShl: lShl,
    _lShr: lShr,
    _lUshr: lUshr,
    _lCmp: lCmp,

    // 扩展诊断接口（宿主用，VM 不依赖）
    __heapStart: HEAP_START,
    __bump: function () { return bump; },
    __disappearingLinkCount: function () { return disappearingLinks.size; },
    __totalMemory: function () { return currentCapacity; },
    __maxMemory: function () { return MAX_MEMORY; },
    __resizable: function () { return resizable; },
    __diag: function () { return diagParts.join('; '); },
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.ASM = ASM;
  } else if (typeof self !== 'undefined') {
    self.ASM = ASM;
  } else {
    this.ASM = ASM;
  }
})();
