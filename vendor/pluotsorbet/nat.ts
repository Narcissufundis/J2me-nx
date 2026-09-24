/**
 * Asm.js native module declaration, this is defined by lib/native.js
 */
declare var ASM;

var Native = Object.create(null);

/**
 * Asm.js heap buffer and views.
 */
var buffer = ASM.buffer;
var i8: Int8Array = ASM.HEAP8;
var u8: Uint8Array = ASM.HEAPU8;
var i16: Int16Array = ASM.HEAP16;
var u16: Uint16Array = ASM.HEAPU16;
var i32: Int32Array = ASM.HEAP32;
var u32: Uint32Array = ASM.HEAPU32;
var f32: Float32Array = ASM.HEAPF32;
var f64: Float64Array = ASM.HEAPF64;

var aliasedI32 = J2ME.IntegerUtilities.i32;
var aliasedF32 = J2ME.IntegerUtilities.f32;
var aliasedF64 = J2ME.IntegerUtilities.f64;

module J2ME {
  import assert = Debug.assert;
  import Bytecodes = Bytecode.Bytecodes;
  import toHEX = IntegerUtilities.toHEX;

  export function asyncImplOld(returnKind: string, promise: Promise<any>, cleanup?: Function) {
    return asyncImpl(kindCharacterToKind(returnKind), promise, cleanup);
  }

  /**
   * Suspends the execution of the current thread and resumes it later once the specified
   * |promise| is fulfilled.
   *
   * |onFulfilled| is called with one or two arguments |l| and |h|. |l| can be any
   * value, while |h| can only ever be the high bits of a long value.
   *
   * |onRejected| is called with a java.lang.Exception object.
   */
  export function asyncImpl(returnKind: Kind, promise: Promise<any>, cleanup?: Function) {
    var ctx = $.ctx;

    promise.then(function onFulfilled(l: any, h?: number) {
      var thread = ctx.nativeThread;
      thread.pushPendingNativeFrames();

      // Push return value.
      var sp = thread.sp;
      switch (returnKind) {
        case Kind.Double: // Doubles are passed in as a number value.
          aliasedF64[0] = l;
          i32[sp++] = aliasedI32[0];
          i32[sp++] = aliasedI32[1];
          break;
        case Kind.Float:
          f32[sp++] = l;
          break;
        case Kind.Long:
          i32[sp++] = l;
          i32[sp++] = h;
          break;
        case Kind.Int:
        case Kind.Byte:
        case Kind.Char:
        case Kind.Short:
        case Kind.Boolean:
          i32[sp++] = l;
          break;
        case Kind.Reference:
          release || assert(l !== "number", "async native return value is a number");
          i32[sp++] = l;
          break;
        case Kind.Void:
          break;
        default:
          release || J2ME.Debug.assert(false, "Invalid Kind: " + getKindName(returnKind));
      }
      thread.sp = sp;

      cleanup && cleanup();

      Scheduler.enqueue(ctx);
    }, function onRejected(exception: java.lang.Exception) {
      var thread = ctx.nativeThread;
      thread.pushPendingNativeFrames();
      var classInfo = CLASSES.getClass("org/mozilla/internal/Sys");
      var methodInfo = classInfo.getMethodByNameString("throwException", "(Ljava/lang/Exception;)V");

      thread.pushMarkerFrame(FrameType.Interrupt);
      thread.pushFrame(methodInfo);
      thread.frame.setParameter(J2ME.Kind.Reference, 0, exception._address);

      cleanup && cleanup();

      Scheduler.enqueue(ctx);
    });

    $.pause("Async");
    $.nativeBailout(returnKind);
  }

  Native["java/lang/Thread.sleep.(J)V"] = function(addr: number, delayL: number, delayH: number) {
    asyncImpl(Kind.Void, new Promise(function(resolve, reject) {
      window.setTimeout(resolve, longToNumber(delayL, delayH));
    }));
  };

  Native["java/lang/Thread.isAlive.()Z"] = function(addr: number) {
    var self = <java.lang.Thread>getHandle(addr);
    return self.nativeAlive ? 1 : 0;
  };

  // PATCH(j2me-nx-port): yield 热自旋节流（2026-09-23 格斗之王3虎胆龙威 实锤）。
  // 该游戏主循环用 "while (deadline - now > 0) Thread.yield();" 做帧限位，
  // 解释器实测 91% 时间耗在这种自旋里：每次 yield = 整条 JS 栈展开 + 调度器
  // 重入（μs 级），游戏线程永远 runnable，事件循环被挤到只剩 80ms 窗口的
  // 缝隙，实机上直接饿死（[mem] 心跳停跳、按键/rAF 全停）。
  // 处理：同一 16ms 窗口内连续 yield 超 256 次 → 判定为热自旋，按 sleep(1)
  // 处理（真停泊 1ms，走事件循环）。50ms 帧预算会变成 ~15-25 次微停泊，
  // 帧节奏不变（自旋仍由 deadline 收口），但每次停泊都还给事件循环一拍。
  // 偶发 yield（线程调度）完全不受影响：16ms 无 yield 即清零计数。
  var yieldBurstCount: number = 0;
  var yieldBurstT0: number = 0;
  // PATCH(perfC): 统计 + 逃生开关。
  //  统计：每 5s 落一条 [yield]（总次数/热停泊次数/节流开关状态），
  //        用来证明"节流是否真的在起作用"，而不是靠猜。
  //  逃生开关：宿主（app/main.js）检测到 sdmc:/switch/j2me-nx/no-throttle
  //        文件时置 jsGlobal.__noYieldThrottle=true → 本函数退回原版纯
  //        $.yield（同一 build、同一次开机即可做 A/B，避免"档位"变量干扰）。
  var yieldTotal: number = 0;
  var yieldParked: number = 0;
  var yieldStatT0: number = 0;

  Native["java/lang/Thread.yield.()V"] = function(addr: number) {
    var now = Date.now();
    yieldTotal++;
    if (now - yieldBurstT0 > 16) {
      yieldBurstT0 = now;
      yieldBurstCount = 0;
    }
    var throttleOff = (typeof jsGlobal !== "undefined") && jsGlobal && jsGlobal.__noYieldThrottle;
    if (!throttleOff && ++yieldBurstCount > 256) {
      yieldBurstCount = 0;
      yieldParked++;
      asyncImpl(Kind.Void, new Promise(function(resolve) {
        window.setTimeout(resolve, 1);
      }));
      return;
    }
    if (now - yieldStatT0 > 5000) {
      yieldStatT0 = now;
      try {
        if (typeof jsGlobal !== "undefined" && jsGlobal) {
          // perfF：把节流统计挂到全局，供宿主 1s 崩溃面包屑读取
          jsGlobal.__yieldStats = { total: yieldTotal, parked: yieldParked };
          if (jsGlobal.__sdMark) {
            jsGlobal.__sdMark("[yield] 5s 窗口: yield=" + yieldTotal +
              " 热停泊=" + yieldParked + " 节流=" + (throttleOff ? "关(逃生开关)" : "开"));
          }
        }
      } catch (eYS) { /* 日志故障不干扰游戏 */ }
      yieldTotal = 0;
      yieldParked = 0;
    }
    $.yield("Thread.yield");
    $.nativeBailout(Kind.Void);
  };

  Native["java/lang/Object.wait.(J)V"] = function(addr: number, timeoutL: number, timeoutH: number) {
    $.ctx.wait(addr, longToNumber(timeoutL, timeoutH));
    if (U) {
      $.nativeBailout(Kind.Void);
    }
  };

  Native["java/lang/Object.notify.()V"] = function(addr: number) {
    $.ctx.notify(addr, false);
    // TODO Remove this assertion after investigating why wakeup on another ctx can unwind see comment in Context.notify..
    release || assert(!U, "Unexpected unwind in java/lang/Object.notify.()V.");
  };

  Native["java/lang/Object.notifyAll.()V"] = function(addr: number) {
    $.ctx.notify(addr, true);
    // TODO Remove this assertion after investigating why wakeup on another ctx can unwind see comment in Context.notify.
    release || assert(!U, "Unexpected unwind in java/lang/Object.notifyAll.()V.");
  };

  Native["java/lang/ref/WeakReference.initializeWeakReference.(Ljava/lang/Object;)V"] = function(addr: number, targetAddr: number): void {
      if (targetAddr === J2ME.Constants.NULL) {
        return;
      }

      var weakRef = (<java.lang.ref.WeakReference>getHandle(addr));
      weakRef.holder = gcMallocAtomic(4);
      i32[weakRef.holder >> 2] = targetAddr;
      ASM._gcRegisterDisappearingLink(weakRef.holder, targetAddr);
  };

  Native["java/lang/ref/WeakReference.get.()Ljava/lang/Object;"] = function(addr: number): number {
    var weakRef = (<java.lang.ref.WeakReference>getHandle(addr));
    if (weakRef.holder === J2ME.Constants.NULL) {
      return J2ME.Constants.NULL;
    }
    return i32[weakRef.holder >> 2];
  };

  Native["java/lang/ref/WeakReference.clear.()V"] = function(addr: number): void {
    var weakRef = (<java.lang.ref.WeakReference>getHandle(addr));
    ASM._gcUnregisterDisappearingLink(weakRef.holder);
    weakRef.holder = J2ME.Constants.NULL;
  };

  Native["org/mozilla/internal/Sys.getUnwindCount.()I"] = function(addr: number) {
    return unwindCount;
  };

  Native["org/mozilla/internal/Sys.constructCurrentThread.()V"] = function(addr: number) {
    var methodInfo = CLASSES.java_lang_Thread.getMethodByNameString("<init>", "(Ljava/lang/String;)V");
    getLinkedMethod(methodInfo)($.mainThread, J2ME.newString("main"));
    if (U) {
      $.nativeBailout(J2ME.Kind.Void, J2ME.Bytecode.Bytecodes.INVOKESPECIAL);
    }

    // We've already set this in JVM.createIsolateCtx, but calling the instance
    // initializer above resets it, so we set it again here.
    //
    // We used to store this state on the persistent native object, which was
    // unaffected by the instance initializer; but now we store it on the Java
    // object, which is susceptible to it, since there is no persistent native
    // object anymore).
    //
    // XXX Figure out a less hacky approach.
    //
    var thread = <java.lang.Thread>getHandle($.mainThread);
    thread.nativeAlive = true;
  };

  Native["org/mozilla/internal/Sys.getIsolateMain.()Ljava/lang/String;"] = function(addr: number): number {
    var isolate = <com.sun.cldc.isolate.Isolate>getHandle($.isolateAddress);
    return isolate._mainClass;
  };

  Native["org/mozilla/internal/Sys.executeMain.(Ljava/lang/Class;)V"] = function(addr: number, mainAddr: number) {
    var main = <java.lang.Class>getHandle(mainAddr);
    var entryPoint = CLASSES.getEntryPoint(J2ME.classIdToClassInfoMap[main.vmClass]);
    if (!entryPoint)
      throw new Error("Could not find isolate main.");

    var isolate = <com.sun.cldc.isolate.Isolate>getHandle($.isolateAddress);

    getLinkedMethod(entryPoint)(Constants.NULL, isolate._mainArgs);
    if (U) {
      $.nativeBailout(J2ME.Kind.Void, J2ME.Bytecode.Bytecodes.INVOKESTATIC);
    }
  };

  Native["java/lang/Throwable.fillInStackTrace.()V"] = function(addr: number) {
    var frame = $.ctx.nativeThread.frame;
    var tp = $.ctx.nativeThread.tp;
    var fp = frame.fp;
    var sp = frame.sp;
    var pc = frame.pc;
    var stackTrace = [];
    setNative(addr, stackTrace);
    while (true) {
      release || assert(fp >= (tp >> 2), "Invalid frame pointer.");
      if (frame.fp === (tp >> 2)) {
        break;
      }
      stackTrace.push({
        frameType: frame.type,
        methodInfo: frame.methodInfo,
        pc: frame.pc
      });

      frame.set(frame.thread, i32[frame.fp + FrameLayout.CallerFPOffset],
        frame.fp + frame.parameterOffset,
        i32[frame.fp + FrameLayout.CallerRAOffset]);
    }
    frame.fp = fp;
    frame.sp = sp;
    frame.pc = pc;
  };

  Native["java/lang/Throwable.obtainBackTrace.()Ljava/lang/Object;"] = function(addr: number): number {
    var resultAddr = J2ME.Constants.NULL;
    var stackTrace = <[any]>NativeMap.get(addr);
    if (stackTrace) {
      var depth = stackTrace.length;
      var classNamesAddr = J2ME.newStringArray(depth);
      var classNames = J2ME.getArrayFromAddr(classNamesAddr);
      var methodNamesAddr = J2ME.newStringArray(depth);
      var methodNames = J2ME.getArrayFromAddr(methodNamesAddr);
      var methodSignaturesAddr = J2ME.newStringArray(depth);
      var methodSignatures = J2ME.getArrayFromAddr(methodSignaturesAddr);
      var offsetsAddr = J2ME.newIntArray(depth);
      var offsets = J2ME.getArrayFromAddr(offsetsAddr);
      stackTrace.forEach(function(e, n) {
        if (e.frameType === FrameType.Interpreter) {
          var methodInfo = <MethodInfo>e.methodInfo;
          classNames[n] = J2ME.newString(methodInfo.classInfo.getClassNameSlow());
          methodNames[n] = J2ME.newString(methodInfo.name);
          methodSignatures[n] = J2ME.newString(methodInfo.signature);
          offsets[n] = e.pc;
        } else {
          classNames[n] = J2ME.newString("MARKER FRAME " + FrameType[e.frameType]);
          methodNames[n] = J2ME.newString("");
          methodSignatures[n] = J2ME.newString("");
          offsets[n] = e.pc;
        }
      });
      resultAddr = J2ME.newObjectArray(4);
      var result = J2ME.getArrayFromAddr(resultAddr);
      result[0] = classNamesAddr;
      result[1] = methodNamesAddr;
      result[2] = methodSignaturesAddr;
      result[3] = offsetsAddr;
    }
    return resultAddr;
  };

  Native["java/lang/Runtime.totalMemory.()J"] = function(addr: number): number {
    // PATCH(j2me-nx-port): 上游硬编码 64MB（FirefoxOS 时代假设），本移植真实堆
    // 是 native-heap.js 的 128MB 起步 + RAB 扩容，读真实容量让游戏做出正确的内存决策。
    return J2ME.returnLongValue(ASM.buffer.byteLength);
  };
}
