module J2ME {
  declare var config;

  import assert = Debug.assert;
  import Bytecodes = Bytecode.Bytecodes;
  import isInvoke = Bytecode.isInvoke;
  import toHEX = IntegerUtilities.toHEX;


  function toName(o) {
    if (o instanceof MethodInfo) {
      return "MI: " + o.implKey;
    }
    function getArrayInfo(o) {
      var s = [];
      var x = [];
      for (var i = 0; i < Math.min(o.length, 8); i++) {
        s.push(o[i]);
        x.push(String.fromCharCode(o[i]));
      }
      var suffix = (o.length > 8 ? "..." : "");
      return fromUTF8(o.classInfo.utf8Name) +
        ", length: " + o.length +
        ", values: [" + s.join(", ") + suffix + "]" +
        ", chars: \"" + x.join("") + suffix + "\"";
    }
    function getObjectInfo(o) {
      if (o.length !== undefined) {
        return getArrayInfo(o);
      }
      return fromUTF8(o.classInfo.utf8Name) + (o._address ? " " + toHEX(o._address) : "");
    }
    if (o && !o.classInfo) {
      return o;
    }
    if (o && o.classInfo === CLASSES.java_lang_Class) {
      return "[" + getObjectInfo(o) + "] " + classIdToClassInfoMap[o.vmClass].getClassNameSlow();
    }
    if (o && o.classInfo === CLASSES.java_lang_String) {
      return "[" + getObjectInfo(o) + "] \"" + fromStringAddr(o._address) + "\"";
    }
    return o ? ("[" + getObjectInfo(o) + "]") : "null";
  }

  /**
   * The number of opcodes executed thus far.
   */
  export var bytecodeCount = 0;

  /**
   * The number of times the interpreter method was called thus far.
   */
  export var interpreterCount = 0;

  export var onStackReplacementCount = 0;

  function wordsToDouble(l: number, h: number): number {
    aliasedI32[0] = l;
    aliasedI32[1] = h;
    return aliasedF64[0];
  }

  /**
   * Calling Convention:
   *
   * Interpreter -> Interpreter:
   *   This follows the JVM bytecode calling convention. This interpreter is highly
   *   optimized for this calling convention.
   *
   * Compiled / Native -> Compiled / Native:
   *   64-bit floats and single word values can be encoded using only one JS value. However, 64-bit longs cannot and
   *   require a (low, high) JS value pair. For example, the signature: "foo.(IDJi)J" is expressed as:
   *
   *   function foo(i, d, lowBits, highBits, i) {
   *     return tempReturn0 = highBits, lowBits;
   *   }
   *
   *   Returning longs is equally problamatic, the convention is to return the lowBits, and save the highBits in a
   *   global |tempReturn0| variable.
   */

  /*
   * Stack Frame Layout:
   *
   *   LP  --->  +--------------------------------+
   *             | Parameter 0                    |
   *             +--------------------------------+
   *             |              ...               |
   *             +--------------------------------+
   *             | Parameter (P-1)                |
   *             +--------------------------------+
   *             | Non-Parameter Local 0          |
   *             +--------------------------------+
   *             |              ...               |
   *             +--------------------------------+
   *             | Non-Parameter Local (L-1)      |
   *   FP  --->  +--------------------------------+
   *             | Caller Return Address          | // The opPC of the caller's invoke bytecode.
   *             +--------------------------------+
   *             | Caller FP                      |
   *             +--------------------------------+
   *             | Callee Method Info | Marker    |
   *             +--------------------------------+
   *             | Monitor                        |
   *             +--------------------------------+
   *             | Stack slot 0                   |
   *             +--------------------------------+
   *             |              ...               |
   *             +--------------------------------+
   *             | Stack slot (S-1)               |
   *   SP  --->  +--------------------------------+
   */

  export enum FrameType {
    /**
     * Normal interpreter frame.
     */
    Interpreter = 0x00000000,

    /**
     * Marks the beginning of a sequence of interpreter frames. If we see this
     * frame when returning we need to exit the interpreter loop.
     */
    ExitInterpreter = 0x10000000,

    /**
     * Native frames are pending and need to be pushed on the stack.
     */
    PushPendingFrames = 0x20000000,

    /**
     * Marks the beginning of frames that were not invoked by the previous frame.
     */
    Interrupt = 0x30000000,

    /**
     * Marks the beginning of native/compiled code called from the interpreter.
     */
    Native = 0x40000000
  }

  export const enum FrameLayout {
    /**
     * Stored in the lower 28 bits.
     */
    CalleeMethodInfoOffset      = 2,
    CalleeMethodInfoMask        = 0x0FFFFFFF,
    /**
     * Stored in the upper 4 bits.
     */
    FrameTypeOffset             = 2,
    FrameTypeMask               = 0xF0000000,
    CallerFPOffset              = 1,
    CallerRAOffset              = 0,
    MonitorOffset               = 3,
    CallerSaveSize              = 4
  }

  export class FrameView {
    public fp: number;
    public sp: number;
    public pc: number;
    public thread: Thread;
    constructor() {

    }

    set(thread: Thread, fp: number, sp: number, pc: number) {
      this.thread = thread;
      this.fp = fp;
      this.sp = sp;
      this.pc = pc;

      if (!release) {
        assert(fp >= (thread.tp >> 2), "Frame pointer is not less than than the top of the stack.");
        assert(fp < (thread.tp + Constants.MAX_STACK_SIZE >> 2), "Frame pointer is not greater than the stack size.");
        var callee = methodIdToMethodInfoMap[i32[this.fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
        assert(
          !callee ||
          callee instanceof MethodInfo,
          "Callee @" + ((this.fp + FrameLayout.CalleeMethodInfoOffset) & FrameLayout.CalleeMethodInfoMask) + " is not a MethodInfo, " + toName(callee)
        );
      }
    }

    setParameter(kind: Kind, i: number, v: any) {
      i32[this.fp + this.parameterOffset + i] = v;
    }

    setStackSlot(kind: Kind, i: number, v: any) {
      switch (kind) {
        case Kind.Reference:
        case Kind.Int:
        case Kind.Byte:
        case Kind.Char:
        case Kind.Short:
        case Kind.Boolean:
          i32[this.fp + FrameLayout.CallerSaveSize + i] = v;
          break;
        default:
          release || assert(false, "Cannot set stack slot of kind: " + getKindName(kind));
      }
    }

    get methodInfo(): MethodInfo {
      return methodIdToMethodInfoMap[i32[this.fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
    }

    get type(): FrameType {
      return i32[this.fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
    }

    set methodInfo(methodInfo: MethodInfo) {
      i32[this.fp + FrameLayout.CalleeMethodInfoOffset] = (i32[this.fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask) | methodInfo.id;
    }

    get parameterOffset() {
      return this.methodInfo ? -this.methodInfo.codeAttribute.max_locals : 0;
    }

    get stackOffset(): number {
      return FrameLayout.CallerSaveSize;
    }

    traceStack(writer: IndentingWriter, details: boolean = false) {
      var fp = this.fp;
      var sp = this.sp;
      var pc = this.pc;
      while (true) {
        if (this.fp < (this.thread.tp >> 2)) {
          writer.writeLn("Bad frame pointer FP: " + this.fp + " TOP: " + (this.thread.tp >> 2));
          break;
        }
        this.trace(writer, details);
        if (this.fp === (this.thread.tp >> 2)) {
          break;
        }
        this.set(this.thread, i32[this.fp + FrameLayout.CallerFPOffset],
                 this.fp + this.parameterOffset,
                 i32[this.fp + FrameLayout.CallerRAOffset]);
      }
      this.fp = fp;
      this.sp = sp;
      this.pc = pc;
    }

    trace(writer: IndentingWriter, details: boolean = true) {
      function toNumber(v) {
        if (v < 0) {
          return String(v);
        } else if (v === 0) {
          return " 0";
        } else {
          return "+" + v;
        }
      }

      function clampString(v, n) {
        if (v.length > n) {
          return v.substring(0, n - 3) + "...";
        }
        return v;
      }

      var op = -1;
      if (this.methodInfo) {
        op = this.methodInfo.codeAttribute.code[this.pc];
      }
      var type  = i32[this.fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
      writer.writeLn("Frame: " + FrameType[type] + " " + (this.methodInfo ? this.methodInfo.implKey : "null") + ", FP: " + this.fp + "(" + (this.fp - (this.thread.tp >> 2)) + "), SP: " + this.sp + ", PC: " + this.pc + (op >= 0 ? ", OP: " + Bytecode.getBytecodesName(op) : ""));
      if (details) {
        for (var i = Math.max(0, this.fp + this.parameterOffset); i < this.sp; i++) {
          var prefix = "    ";
          if (i >= this.fp + this.stackOffset) {
            prefix = "S" + (i - (this.fp + this.stackOffset)) + ": ";
          } else if (i === this.fp + FrameLayout.CalleeMethodInfoOffset) {
            prefix = "MI: ";
          } else if (i === this.fp + FrameLayout.CallerFPOffset) {
            prefix = "CF: ";
          } else if (i === this.fp + FrameLayout.CallerRAOffset) {
            prefix = "RA: ";
          } else if (i === this.fp + FrameLayout.MonitorOffset) {
            prefix = "MO: ";
          } else if (i >= this.fp + this.parameterOffset) {
            prefix = "L" + (i - (this.fp + this.parameterOffset)) + ": ";
          }
          writer.writeLn(" " + prefix.padRight(' ', 5) + " " + toNumber(i - this.fp).padLeft(' ', 3) + " " + String(i).padLeft(' ', 4) + " " + toHEX(i << 2) + ": " +
            String(i32[i]).padLeft(' ', 12) + " " +
            toHEX(i32[i]) + " " +
            ((i32[i] >= 32 && i32[i] < 1024) ? String.fromCharCode(i32[i]) : "?") + " " +
            clampString(String(f32[i]), 12).padLeft(' ', 12) + " " +
            clampString(String(wordsToDouble(i32[i], i32[i + 1])), 12).padLeft(' ', 12) + " ");
            // XXX ref[i] could be an address, so update toName to handle that.
            //toName(ref[i]));
        }
      }
    }
  }

  export var interpreterCounter = new Metrics.Counter(true);

  export class Thread {

    /**
     * Thread base pointer.
     */
    tp: number;

    /**
     * Stack base pointer.
     */
    bp: number

    /**
     * Current frame pointer.
     */
    fp: number

    /**
     * Current stack pointer.
     */
    sp: number

    /**
     * Current program counter.
     */
    pc: number

    nativeFrameCount: number;

    /**
     * Context associated with this thread.
     */
    ctx: Context;

    view: FrameView;

    /**
     * Stack of native frames seen during unwinding. These appear in reverse order. If a marker frame
     * is seen during unwinding, a null value is also pushed on this stack to mark native frame ranges.
     */
    unwoundNativeFrames: any [];

    /**
     * Stack of native frames to push on the stack.
     */
    pendingNativeFrames: any [];

    constructor(ctx: Context) {
      this.tp = gcMalloc(Constants.MAX_STACK_SIZE);
      this.bp = this.tp >> 2;
      this.fp = this.bp;
      this.sp = this.fp;
      this.pc = -1;
      this.view = new FrameView();
      this.ctx = ctx;
      this.unwoundNativeFrames = [];
      this.pendingNativeFrames = [];
      this.nativeFrameCount = 0;
      release || threadWriter && threadWriter.writeLn("creatingThread: tp: " + toHEX(this.tp) + " " + toHEX(this.tp + Constants.MAX_STACK_SIZE));
    }

    set(fp: number, sp: number, pc: number) {
      this.fp = fp;
      this.sp = sp;
      this.pc = pc;
    }

    hashFrame(): number {
      var fp = this.fp << 2;
      var sp = this.sp << 2;
      return HashUtilities.hashBytesTo32BitsAdler(u8, fp, sp);
    }

    get frame(): FrameView {
      this.view.set(this, this.fp, this.sp, this.pc);
      return this.view;
    }

    pushMarkerFrame(frameType: FrameType) {
      if (frameType === FrameType.Native) {
        this.nativeFrameCount++;
      }
      this.pushFrame(null, 0, 0, null, frameType);
    }

    pushFrame(methodInfo: MethodInfo, sp: number = 0, pc: number = 0, monitorAddr: number = Constants.NULL, frameType: FrameType = FrameType.Interpreter) {
      var fp = this.fp;
      if (methodInfo) {
        this.fp = this.sp + methodInfo.codeAttribute.max_locals;
      } else {
        this.fp = this.sp;
      }
      release || assert(fp < (this.tp + Constants.MAX_STACK_SIZE >> 2), "Frame pointer is not greater than the stack size.");
      i32[this.fp + FrameLayout.CallerRAOffset] = this.pc;    // Caller RA
      i32[this.fp + FrameLayout.CallerFPOffset] = fp;         // Caller FP
      i32[this.fp + FrameLayout.CalleeMethodInfoOffset] = frameType | (methodInfo === null ? Constants.NULL : methodInfo.id); // Callee
      i32[this.fp + FrameLayout.MonitorOffset] = monitorAddr; // Monitor
      this.sp = this.fp + FrameLayout.CallerSaveSize + sp;
      this.pc = pc;
    }

    popMarkerFrame(frameType: FrameType): MethodInfo {
      if (frameType === FrameType.Native) {
        this.nativeFrameCount--;
      }
      return this.popFrame(null, frameType);
    }

    popFrame(methodInfo: MethodInfo, frameType: FrameType = FrameType.Interpreter): MethodInfo {
      var mi = methodIdToMethodInfoMap[i32[this.fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
      var type = i32[this.fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
      release || assert(mi === methodInfo && type === frameType, "mi === methodInfo && type === frameType");
      this.pc = i32[this.fp + FrameLayout.CallerRAOffset];
      var maxLocals = mi ? mi.codeAttribute.max_locals : 0;
      this.sp = this.fp - maxLocals;
      this.fp = i32[this.fp + FrameLayout.CallerFPOffset];
      release || assert(this.fp >= (this.tp >> 2), "Valid frame pointer after pop.");
      return methodIdToMethodInfoMap[i32[this.fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
    }

    run() {
      release || traceWriter && traceWriter.writeLn("Thread.run " + $.ctx.id);
      return interpret(this);
    }

    exceptionUnwind(e: java.lang.Exception) {
      release || traceWriter && traceWriter.writeLn("exceptionUnwind: " + toName(e));
      var pc = -1;
      var classInfo;
      while (true) {
        var frameType = i32[this.fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
        switch (frameType) {
          case FrameType.Interpreter:
            var mi = methodIdToMethodInfoMap[i32[this.fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
            release || traceWriter && traceWriter.writeLn("Looking for handler in: " + mi.implKey);
            for (var i = 0; i < mi.exception_table_length; i++) {
              var exceptionEntryView = mi.getExceptionEntryViewByIndex(i);
              release || traceWriter && traceWriter.writeLn("Checking catch range: " + exceptionEntryView.start_pc + " - " + exceptionEntryView.end_pc);
              if (this.pc >= exceptionEntryView.start_pc && this.pc < exceptionEntryView.end_pc) {
                if (exceptionEntryView.catch_type === 0) {
                  pc = exceptionEntryView.handler_pc;
                  break;
                } else {
                  classInfo = mi.classInfo.constantPool.resolveClass(exceptionEntryView.catch_type);
                  release || traceWriter && traceWriter.writeLn("Checking catch type: " + classInfo);
                  if (isAssignableTo(e.classInfo, classInfo)) {
                    pc = exceptionEntryView.handler_pc;
                    break;
                  }
                }
              }
            }

            if (pc >= 0) {
              this.pc = pc;
              this.sp = this.fp + FrameLayout.CallerSaveSize;
              release || assert(e instanceof Object && "_address" in e, "exception is object with address");
              i32[this.sp++] = e._address;
              return;
            }
            if (mi.isSynchronized) {
              this.ctx.monitorExit(getMonitor(i32[this.fp + FrameLayout.MonitorOffset]));
            }
            this.popFrame(mi);
            release || traceWriter && traceWriter.outdent();
            release || traceWriter && traceWriter.writeLn("<< I Unwind");
            break;
          case FrameType.ExitInterpreter:
            this.popMarkerFrame(FrameType.ExitInterpreter);
            throw e;
          case FrameType.PushPendingFrames:
            this.frame.thread.pushPendingNativeFrames();
            break;
          case FrameType.Interrupt:
            this.popMarkerFrame(FrameType.Interrupt);
            break;
          case FrameType.Native:
            this.popMarkerFrame(FrameType.Native);
            break;
          default:
            Debug.assertUnreachable("Unhandled frame type: " + frameType);
            break;
        }
      }
    }

    classInitAndUnwindCheck(fp: number, sp: number, pc: number, classInfo: ClassInfo) {
      this.set(fp, sp, pc);
      classInitCheck(classInfo);
    }

    throwException(fp: number, sp: number, pc: number, type: ExceptionType, a?) {
      this.set(fp, sp, pc);
      switch (type) {
        case ExceptionType.ArrayIndexOutOfBoundsException:
          throwArrayIndexOutOfBoundsException(a);
          break;
        case ExceptionType.ArithmeticException:
          throwArithmeticException();
          break;
        case ExceptionType.NegativeArraySizeException:
          throwNegativeArraySizeException();
          break;
        case ExceptionType.NullPointerException:
          throwNullPointerException();
          break;
      }
    }

    tracePendingFrames(writer: IndentingWriter) {
      for (var i = 0; i < this.pendingNativeFrames.length; i++) {
        var pendingFrame = this.pendingNativeFrames[i];
        writer.writeLn(pendingFrame ? methodIdToMethodInfoMap[i32[pendingFrame + BailoutFrameLayout.MethodIdOffset >> 2]].implKey : "-marker-");
      }
    }

    pushPendingNativeFrames() {
      traceWriter && traceWriter.writeLn("Pushing pending native frames.");

      if (traceWriter) {
        traceWriter.enter("Pending native frames before:");
        this.tracePendingFrames(traceWriter);
        traceWriter.leave("");

        traceWriter.enter("Stack before:");
        this.frame.traceStack(traceWriter);
        traceWriter.leave("");
      }

      while (true) {
        // We should have a |PushPendingFrames| marker frame on the stack at this point.
        this.popMarkerFrame(FrameType.PushPendingFrames);

        var pendingNativeFrameAddress = null;
        var frames = [];
        while (pendingNativeFrameAddress = this.pendingNativeFrames.pop()) {
          frames.push(pendingNativeFrameAddress);
        }
        while (pendingNativeFrameAddress = frames.pop()) {
          var methodInfo = methodIdToMethodInfoMap[i32[pendingNativeFrameAddress + BailoutFrameLayout.MethodIdOffset >> 2]];
          var stackCount = i32[pendingNativeFrameAddress + BailoutFrameLayout.StackCountOffset >> 2];
          var localCount = i32[pendingNativeFrameAddress + BailoutFrameLayout.LocalCountOffset >> 2];
          var pc = i32[pendingNativeFrameAddress + BailoutFrameLayout.PCOffset >> 2];
          var lockObjectAddress = i32[pendingNativeFrameAddress + BailoutFrameLayout.LockOffset >> 2];
          traceWriter && traceWriter.writeLn("Pushing frame: " + methodInfo.implKey);
          this.pushFrame(methodInfo, stackCount, pc, lockObjectAddress);
          var frame = this.frame;
          for (var j = 0; j < localCount; j++) {
            var value = i32[(pendingNativeFrameAddress + BailoutFrameLayout.HeaderSize >> 2) + j];
            frame.setParameter(Kind.Int, j, value);
          }
          for (var j = 0; j < stackCount; j++) {
            var value = i32[(pendingNativeFrameAddress + BailoutFrameLayout.HeaderSize >> 2) + j + localCount];
            frame.setStackSlot(Kind.Int, j, value);
          }
          ASM._gcFree(pendingNativeFrameAddress);
        }
        var frameType = i32[this.fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;

        if (frameType === FrameType.PushPendingFrames) {
          continue;
        }
        break;
      }

      if (traceWriter) {
        traceWriter.enter("Pending native frames after:");
        this.tracePendingFrames(traceWriter);
        traceWriter.leave("");

        traceWriter.enter("Stack after:");
        this.frame.traceStack(traceWriter);
        traceWriter.leave("");
      }
    }

    /**
     * Called when unwinding begins.
     */
    beginUnwind() {
      // The |unwoundNativeFrames| stack should be empty at this point.
      release || assert(this.unwoundNativeFrames.length === 0, "0 unwound native frames");
    }

    /*
     * Called when unwinding ends.
     *
     *  x: Interpreter Frame
     * x': Compiler Frame
     *  -: Skip Frame
     *  +: Push Pending Frames
     *  /: null
     *
     *
     * Suppose you have the following logical call stack: a, b, c, d', e', -, f, g, h', i', -, j, k. The physical call
     * stack doesn't have any of the native frames on it: a, b, c, -, f, g, -, j, k, so when we resume we need to
     * make sure that native frames are accounted for. During unwinding, we save the state of native frames in the
     * |unwoundNativeFrames| array. In order to keep track of how native frames interleave with interpreter frames we
     * insert null markers in the |unwoundNativeFrames| array. So in this example, the array will be: /, i', h', /,
     * e', d'. When we resume in the interpreter, our call stack is: a, b, c, +, f, g, +, j, k. During unwinding, the
     * skip marker frames have been converted to push pending frames. These indicate to the interpreter that some native
     * frames should be pushed on the stack. When we return from j, we need to push h and i. Similarly, when we return
     * from f, we need to push d and e. After unwiding is complete, all elements in |unwoundNativeFrames| are poped and
     * pushed into the |pendingNativeFrames| which keeps track of the native frames that need to be pushed once a
     * push pending prame marker is observed. In this case |pendingNativeFrames| is: d', e', /, h', i', /. When we return
     * from j and see the first push pending frames marker, we look for the last set of frames in the |pendingNativeFrames|
     * list and push those on the stack.
     *
     *
     * Before every unwind, the |unwoundNativeFrames| list must be empty. However, the |pendingNativeFrames| list may
     * have unprocessed frames in it. This can happen if after resuming and returning from j, we call some native code
     * that unwinds. Luckily, all new native frames must be further down on the stack than the current frames in the
     * |pendingNativeFrames| list, so we can just push them at the end.
     *
     * TODO: Do a better job explaining all this.
     */
    endUnwind() {
      var unwound = this.unwoundNativeFrames;
      var pending = this.pendingNativeFrames;
      while (unwound.length) {
        pending.push(unwound.pop());
      }
      // Garbage collection is disabled during compiled code which can lead to OOM's if
      // we consistently stay in compiled code. Most code unwinds often enough that we can
      // force collection here since at the end of an unwind all frames are
      // stored back on the heap.
      ASM._collectALittle();
    }

    /**
     * Walks the stack from the current fp to find the frame that will return
     * to the removeFP and make it instead return to the newCallerFP.
     */
    removeFrame(removeFP: number, newCallerFP: number, newCallerPC: number) {
      var fp = this.fp;
      release || assert(fp !== removeFP, "Cannot remove current fp.");
      while ((i32[fp + FrameLayout.CallerFPOffset]) !== removeFP) {
        fp = i32[fp + FrameLayout.CallerFPOffset];
      }
      release || assert(i32[fp + FrameLayout.CallerFPOffset] === removeFP, "Did not find the frame to remove.");
      i32[fp + FrameLayout.CallerFPOffset] = newCallerFP;
      i32[fp + FrameLayout.CallerRAOffset] = newCallerPC;
    }
  }

  export function prepareInterpretedMethod(methodInfo: MethodInfo): Function {
    var method = function fastInterpreterFrameAdapter() {
      runtimeCounter && runtimeCounter.count("fastInterpreterFrameAdapter");
      var calleeStats = methodInfo.stats;
      calleeStats.interpreterCallCount++;
      if (config.forceRuntimeCompilation ||
          calleeStats.interpreterCallCount + calleeStats.backwardsBranchCount > invokeThresholdFor(methodInfo)) {
        // PATCH(perfZ34)：只排队（见 runtime.ts requestCompile 说明）
        if (config.forceRuntimeCompilation) { compileAndLinkMethod(methodInfo); } else { requestCompile(methodInfo); }
        if (methodInfo.state === MethodState.Compiled) {
          return methodInfo.fn.apply(null, arguments);
        }
      }
      var ctx = $.ctx;
      var thread = ctx.nativeThread;
      var callerFP = thread.fp;
      var callerPC = thread.pc;
      // release || traceWriter && traceWriter.writeLn(">> I");
      thread.pushMarkerFrame(FrameType.ExitInterpreter);
      var exitFP = thread.fp;
      thread.pushFrame(methodInfo);
      var calleeFP = thread.fp;
      var frame = thread.frame;
      var kinds = methodInfo.signatureKinds;
      var index = 0;
      if (!methodInfo.isStatic) {
        frame.setParameter(Kind.Reference, index++, arguments[0]);
      }
      for (var i = 1, j = 1; i < kinds.length; i++) {
        frame.setParameter(kinds[i], index++, arguments[j++]);
        if (isTwoSlot(kinds[i])) {
          frame.setParameter(kinds[i], index++, arguments[j++]);
        }
      }
      if (methodInfo.isSynchronized) {
        var monitorAddr = methodInfo.isStatic ? $.getClassObjectAddress(methodInfo.classInfo) : arguments[0];
        i32[calleeFP + FrameLayout.MonitorOffset] = monitorAddr;
        $.ctx.monitorEnter(getMonitor(monitorAddr));
        release || assert(U !== VMState.Yielding, "Monitors should never yield.");
        if (U === VMState.Pausing || U === VMState.Stopping) {
          // Splice out the marker frame so the interpreter doesn't return early when execution is resumed.
          // The simple solution of using the calleeFP to splice the frame cannot be used since the frame
          // stack may have changed if an OSR occurred.
          thread.removeFrame(exitFP, callerFP, callerPC);
          return;
        }
      }
      var v = interpret(thread);
      if (U) {
        // Splice out the marker frame so the interpreter doesn't return early when execution is resumed.
        // The simple solution of using the calleeFP to splice the frame cannot be used since the frame
        // stack may have changed if an OSR occurred.
        thread.removeFrame(exitFP, callerFP, callerPC);
        return;
      }

      thread.popMarkerFrame(FrameType.ExitInterpreter);
      release || assert(callerFP === thread.fp, "callerFP === thread.fp");

      // release || traceWriter && traceWriter.writeLn("<< I");
      return v;
    };
    return method;
  }

  var args = new Array(16);

  export const enum ExceptionType {
    ArithmeticException,
    ArrayIndexOutOfBoundsException,
    NegativeArraySizeException,
    NullPointerException
  }

  /**
   * Debugging helper to make sure native methods were implemented correctly.
   */
  function checkReturnValue(methodInfo: MethodInfo, l: any, h: number) {
    if (U) {
      if (typeof l !== "undefined") {
        assert(false, "Expected undefined return value during unwind, got " + l + " in " + methodInfo.implKey);
      }
      return;
    }
    if (!(getKindCheck(methodInfo.returnKind)(l, h))) {
      assert(false, "Expected " + getKindName(methodInfo.returnKind) + " return value, got low: " + l + " high: " + h + " in " + methodInfo.implKey);
    }
  }

  /**
   * Main interpreter loop. This method is carefully written to avoid memory allocation and
   * function calls on fast paths. Therefore, everything is inlined, even if it makes the code
   * look ugly.
   *
   * The interpreter loop caches the thread state in local variables. Doing so avoids a lot of
   * property accesses but also makes the code brittle since you need to manually sync up the
   * thread state with the local thead state at precise points.
   *
   * At call sites, caller frame |pc|s are always at the beggining of invoke bytecodes. In the
   * interpreter return bytecodes advance the pc past the invoke bytecode. Native code that
   * unwinds and resumes execution at a later point needs to adjust the pc accordingly.
   *
   * Bytecodes that construct exception objects must save the tread state before executing any
   * code that may overwrite the frame. Use the |throwException| helper method to ensure that
   * the thread state is property saved.
   */
  // PATCH(j2me-nx-port): VM 挂起采样器。主线程被 Java 字节码死循环/长任务堵死时
  // rAF/setInterval 全停摆、外部无法观测——只有解释循环自己还在转，由它周期性
  // 采样"当前方法"，同一方法连续运行超阈值即通过 __sdMark 立即落盘。
  // 若卡点在某个 native 调用内部（循环停转），则最后一条采样是它的调用方。
  var hangTick: number = 0;
  var hangSampleKey: string = '';
  var hangSampleT0: number = 0;
  var hangSampleLastLog: number = 0;
  var hangPeriodicLast: number = 0;
  // PATCH(j2me-nx-port perfZ24): [jit-trap] 限流用的按方法统计（见下面 catch 里的说明）。
  // 键 = 方法 implKey，值 = { n 总次数, logged 已完整落盘次数, lastFlush 上次汇总时间 }。
  var trapStats: any = Object.create(null);

  // PATCH(j2me-nx-port perfZ48)：把 catch 到的东西描述成人看得懂的一行。
  // 三形态：① native 抛出的 **Java 异常对象句柄**（有 classInfo/_address，没 message/stack）
  //        ② JS 级 Error（有 message/stack）③ 其它（数字/字符串）。
  function describeTrapError(e: any): string {
    try {
      if (e === null || e === undefined) { return String(e); }
      var t = typeof e;
      if (t === 'string' || t === 'number' || t === 'boolean') { return String(e); }
      var cls = e.classInfo && (e.classInfo.className || e.classInfo.name);
      if (cls) { return 'java:' + cls + '(地址=' + e._address + ')'; }
      if (e.message) { return String(e.message); }
      if (e.stack) { return String(e.stack).split('\n')[0]; }
      var keys = '';
      try { keys = Object.keys(e).slice(0, 6).join(','); } catch (e3) { /* 忽略 */ }
      var ctor = (e.constructor && e.constructor.name) || '?';
      return '[object ' + ctor + (keys ? ' keys=' + keys : '') + ']';
    } catch (e2) {
      return '(无法描述)';
    }
  }

  function hangSample(mi: MethodInfo, pc: number, thread?: any, lp?: number, fp?: number) {
    try {
      var now = Date.now();
      var key = mi ? mi.implKey : '(no method)';
      // PATCH(j2me-nx-port): 冻死取证——采样时顺手转储当前帧前 8 个局部变量
      // （int32 原值十六进制）。游戏 o.run 的帧限位器 l1(deadline) 在 local 1/2，
      // l1-Date.now() 即剩余预算：能直接判"预算被读成天文数字"还是"时钟冻结"。
      var locDump: string = '';
      if (thread && lp >= 0 && fp > lp) {
        try {
          var parts: string[] = [];
          var n = fp - lp > 8 ? 8 : fp - lp;
          for (var li = 0; li < n; li++) {
            var v = i32[lp + li] >>> 0;
            parts.push(li + '=' + v.toString(16));
          }
          locDump = ' locals[' + parts.join(' ') + '] now=' + now;
        } catch (eLoc) { /* 取证不能引入二次故障 */ }
      }
      if (now - hangPeriodicLast > 5000) {
        hangPeriodicLast = now;
        if (jsGlobal && jsGlobal.__sdMark) {
          jsGlobal.__sdMark("[vm-sample] " + key + " (pc=" + pc + ")" + locDump);
        }
      }
      // PATCH(perfZ36)：**同方法 ≠ 同一次调用**。上一版只比方法名，于是"游戏在一帧里
      // 连调同一个热点方法十几秒"（UFO 的 PointFont.DrawChar 占采样 54~67%）被误报成
      // `[hang-vm] 已连续运行 11.9s` —— 实机日志里那条把我和玩家都带偏了。现在把
      // **pc 也纳入"同一个卡点"的判定**：同方法名但 pc 变了（=换了一次调用）就重新计时。
      var site = key + '@' + pc;
      if (site !== hangSampleKey) {
        hangSampleKey = site;
        hangSampleT0 = now;
        hangSampleLastLog = 0;
        return;
      }
      var stuck = now - hangSampleT0;
      if (stuck > 8000 && now - hangSampleLastLog > 5000) {
        hangSampleLastLog = now;
        if (jsGlobal && jsGlobal.__sdMark) {
          jsGlobal.__sdMark("[hang-vm] 解释器在 " + key + " (pc=" + pc + ") 同一处已连续采样 " + (stuck / 1000).toFixed(1) + "s" + locDump);
        }
      }
    } catch (e) { /* 日志系统绝不能引发二次崩溃 */ }
  }

  // PATCH(j2me-nx-port): 大小分档调用阈值——≥512 字节的大方法解释开销高，
  // 调 3 次即编译；小方法保持 InvokeThreshold（小方法编译不划算）。
  function invokeThresholdFor(mi: MethodInfo): number {
    return mi.codeAttribute.code.length >= 512
      ? ConfigThresholds.InvokeThresholdBig
      : ConfigThresholds.InvokeThreshold;
  }

  // PATCH(j2me-nx-port): 回边计数统一入口——2026-09-22 法拉利 u.b 疑案根因：
  // 原版只有 GOTO 向后跳计数，IF 系条件跳转与 TABLESWITCH/LOOKUPSWITCH 的
  // 向后跳完全不计数。混淆器优化会把 while-GOTO 改写成条件跳转/switch 状态机，
  // 导致这类"单次调用内自转的主循环方法"调用次数=1、回边计数=0，
  // 永远达不到任何编译阈值，终生解释（hot-top10 u.b=44% 的真相）。
  function countBackwardBranch(mi: MethodInfo) {
    var stats = mi.stats;
    stats.backwardsBranchCount++;
    if (config.forceRuntimeCompilation || (mi.state === MethodState.Cold &&
        stats.interpreterCallCount + stats.backwardsBranchCount > ConfigThresholds.BackwardBranchThreshold)) {
      // PATCH(perfZ34)：只排队（编译统一在场间隙做，避免帧中间同步编译造成停顿/内存尖峰；
      // 见 runtime.ts requestCompile 的说明）。forceRuntimeCompilation（工具链直编）仍同步编译。
      if (config.forceRuntimeCompilation) { compileAndLinkMethod(mi); } else { requestCompile(mi); }
    }
  }

  // PATCH(j2me-nx-port): 热点方法 Top10 采样器——每 2^20 条指令采样"当前方法"，
  // 累积直方图；每 >=30s（且 >=32 个样本）向 [hot-top10] 落盘 Top10 占比，
  // 用于确定编译优先级与剩余解释瓶颈。注意：JIT 生效后已编译方法不再经过
  // 解释循环，本榜反映的是"仍在解释执行"的热点。
  var hotTick: number = 0;
  var hotSamples: any = null;
  var hotSampleCount: number = 0;
  var hotLastFlush: number = 0;

  // PATCH(perfZ32)：**热点定向编译**（tier=hot，profile-guided）。
  // 由来：UFO Afterlight 实机 `[hot-top10]` 里 `PointFont.DrawChar` 常年占 VM 时间 66~78%
  // 且一直是 `(st0)`（解释态）；而 tier=big（只编译 ≥512B 的大方法）对它无效 —— 说明这个
  // 热点方法**小于 512 字节**，压根不在 big 档的适用范围内。反过来把阈值一律压到很小的值
  // （当年 perfJ 的形态）会让大量小方法都进编译，实测"时不时卡顿"。
  // 折中办法：不看方法大小，只看**采样器实测的热点**——每 30s 榜一刷新时，把榜上最热的
  // 前 N 个仍在解释态的方编译掉（N 由 config.hotspotCompileLimit 控制，0=关）。
  // 每会话编译数另有硬上限（24），编译本身走既有的"预算门 + 帧间隙 drainCompileQueue"，
  // 不会在游戏帧中间同步编译。
  var hotCompileDone: any = null;
  var hotCompileCount = 0;
  var hotLastCompileCheck = 0;
  var jitCapNoted = false;   // perfZ35：上限提示只打一次
  // PATCH(perfZ34)：**只排队，不在这里编译**。
  // 实机事故：perfZ33 直接在采样钩子里同步跑 compileAndLinkMethod（一次最多 8 个），
  // 等于在游戏帧中间做 8 次 Relooper 代码生成 → 长停顿 + 紧档下的大分配压力，
  // 实机表现是"游戏加载中直接退出、日志没有任何 [exit] 行就断掉"。
  // 现在这里只把方法塞进 pending 队列（O(1) 的 push），真正编译交给宿主帧间隙的
  // drainCompileQueue（一次一个、有 maxMs 上限）。每次检查的排队数也收紧到 2 个。
  function maybeCompileHotspots(arr: any []) {
    var limit = ConfigThresholds.HotspotCompileLimit | 0;
    if (limit <= 0) return;
    // PATCH(perfZ35): 全会话上限（config.jitCompileCap，紧档减半）到了一个就不再排队。
    // 由来：perfZ32~Z34 里"紧档每会话 ≤8"只管住了这条采样路径，解释器阈值那条路照样编了
    // 29 个（见 PERF §42）——现在上限统一在 runtime 的编译入口判定，这里只是不再白排队。
    var remaining = jitCompileRemaining();
    if (remaining === 0) {
      if (!jitCapNoted) {
        jitCapNoted = true;
        if (jsGlobal && jsGlobal.__sdMark) {
          jsGlobal.__sdMark("[jit-hot] 已达本会话编译上限（" + (ConfigThresholds.JitCompileCap | 0) +
            " 个），后续热点只记录不编译");
        }
      }
      return;
    }
    // 紧档（宿主在 app/main.js 里判定 limit<700MB 时置位）：排得更少、更保守
    var tight = !!(jsGlobal && jsGlobal.__memTight);
    if (tight && limit > 2) limit = 2;
    if (!hotCompileDone) hotCompileDone = {};
    var queuedThisRound = 0;
    for (var i = 0; i < arr.length && i < limit && queuedThisRound < 2; i++) {
      var rec = arr[i][1];
      var mi = rec.mi;
      if (!mi || mi.state !== MethodState.Cold) continue;
      // tier=big：只编 ≥512B 的（小方法留在解释器里，避免 perfJ 那种"小方法编译太频繁"）
      if (ConfigThresholds.JitBigOnly && mi.codeAttribute && mi.codeAttribute.code.length < 512) continue;
      var key = arr[i][0];
      if (hotCompileDone[key]) continue;
      if (hotCompileCount >= (tight ? 4 : 12)) break;   // perfZ35：自身上限收紧（原来 8/24）
      if (remaining > 0 && hotCompileCount >= remaining) break;
      hotCompileDone[key] = true;
      hotCompileCount++;
      queuedThisRound++;
      try {
        if (jsGlobal && jsGlobal.__sdMark) {
          jsGlobal.__sdMark("[jit-hot] 排入编译队列 #" + hotCompileCount + " " + key +
            " 占比=" + Math.round(rec.n * 100 / Math.max(1, hotSampleCount)) +
            "% size=" + (mi.codeAttribute ? mi.codeAttribute.code.length : -1) +
            " calls=" + mi.stats.interpreterCallCount +
            " bb=" + mi.stats.backwardsBranchCount +
            (tight ? " [紧档：本轮最多 2 个]" : ""));
        }
      } catch (eLH) { /* 日志故障不干扰 */ }
      requestCompile(mi);   // 只排队；编译在场间隙做（见 runtime.ts requestCompile 的说明）
    }
  }

  // PATCH(perfZ32b)：**快速爬坡**。原来只在 30s 榜刷新时才检查热点，导致一局游戏的前 30 秒
  // 完全没编译（而重载游戏的卡顿恰恰集中在刚进场景那段时间）。现在每 10s 用**当前累积的
  // 采样**做一次检查（不清空累积），榜刷新时再做一次完整检查。
  function hotCompileTick() {
    try {
      if ((ConfigThresholds.HotspotCompileLimit | 0) <= 0) return;
      if (!hotSamples) return;
      var now = Date.now();
      if (hotSampleCount < 8 || now - hotLastCompileCheck < 10000) return;
      hotLastCompileCheck = now;
      var arr: any [] = [];
      for (var k in hotSamples) arr.push([k, hotSamples[k]]);
      arr.sort(function (a: any, b: any) { return b[1].n - a[1].n; });
      maybeCompileHotspots(arr);
    } catch (eHC2) { /* 不影响游戏 */ }
  }

  function hotSample(mi: MethodInfo) {
    try {
      if (!hotSamples) hotSamples = {};
      var key = mi ? mi.implKey : "(no method)";
      var rec = hotSamples[key];
      if (!rec) {
        rec = hotSamples[key] = { n: 0, st: mi ? mi.state : -1 };
      }
      rec.n++;
      rec.st = mi ? mi.state : -1;
      rec.mi = mi;   // perfZ32：留引用给"热点定向编译"用
      hotSampleCount++;
      hotCompileTick();
      var now = Date.now();
      if (hotSampleCount >= 32 && now - hotLastFlush > 30000) {
        hotLastFlush = now;
        var arr: any [] = [];
        for (var k in hotSamples) arr.push([k, hotSamples[k]]);
        arr.sort(function (a: any, b: any) { return b[1].n - a[1].n; });
        var line = "[hot-top10] n=" + hotSampleCount;
        var n = arr.length < 10 ? arr.length : 10;
        for (var i = 0; i < n; i++) {
          // PATCH(j2me-nx-port): 附加采样时方法状态，判别"未触发编译"还是"编译后仍回解释"；
          // perfZ32 再加**字节码长度** len= —— 直接回答"这个方法够不够大、属于哪一档阈值"。
          var m2 = arr[i][1].mi;
          line += " | " + arr[i][0] + "=" + Math.round(arr[i][1].n * 100 / hotSampleCount) +
            "%(st" + arr[i][1].st + "/len=" + (m2 && m2.codeAttribute ? m2.codeAttribute.code.length : -1) + ")";
        }
        if (jsGlobal && jsGlobal.__sdMark) jsGlobal.__sdMark(line);
        try { maybeCompileHotspots(arr); } catch (eHC) { /* 定向编译故障不影响游戏 */ }
        hotSamples = {};
        hotSampleCount = 0;
      }
    } catch (e) { /* 日志系统绝不能引发二次崩溃 */ }
  }

  // PATCH(j2me-nx-port): 帧时间三分账探针——interpret 包一层计时，循环体不动。
  // 累积值由 app/main.js 的 present 循环每 300 帧读取并清零，与 gfx/音频计数
  // 对比得出"解释器 / LCDUI 原语 / 其他（编译代码+音频+事件）"的时间占比。
  // 2026-09-22 修正：OSR 后编译码内调用未编译方法会递归进 interpret，嵌套计时
  // 双重累加导致 vm 值大于墙钟（1540osr 实机 vm=34s/窗口30.1s）。改为只统计最外层。
  var interpretDepth = 0;
  export function interpret(thread: Thread): any {
    var outermost = interpretDepth++ === 0;
    var t0 = outermost ? Date.now() : 0;
    try {
      return interpretBody(thread);
    } finally {
      interpretDepth--;
      if (outermost) {
        var dt = Date.now() - t0;
        if (jsGlobal) {
          jsGlobal.__vmMsAcc = (jsGlobal.__vmMsAcc || 0) + dt;
          jsGlobal.__vmCallsAcc = (jsGlobal.__vmCallsAcc || 0) + 1;
        }
      }
    }
  }

  function interpretBody(thread: Thread) {
    release || interpreterCount ++;
    var frame = thread.frame;
    // Special case where a |PushPendingFrames| marker is on top of the stack. This happens when
    // native code is on top of the stack.
    if (frame.type === FrameType.PushPendingFrames) {
      thread.pushPendingNativeFrames();
      frame = thread.frame;
    }
    release || assert(frame.type === FrameType.Interpreter, "Must begin with interpreter frame.");
    var mi = frame.methodInfo;
    release || assert(mi, "Must have method info.");
    mi.stats.interpreterCallCount++;
    if (config.forceRuntimeCompilation || (mi.state === MethodState.Cold &&
        mi.stats.interpreterCallCount + mi.stats.backwardsBranchCount > invokeThresholdFor(mi))) {
      // PATCH(perfZ34)：只排队，不做帧中间同步编译（见 runtime.ts requestCompile）
      if (config.forceRuntimeCompilation) { compileAndLinkMethod(mi); } else { requestCompile(mi); }
      // TODO call the compiled method.
    }
    var maxLocals = mi.codeAttribute.max_locals;
    var ci = mi.classInfo;
    var cp = ci.constantPool;

    var code = mi ? mi.codeAttribute.code : null;

    var fp = thread.fp | 0;
    var lp = fp - maxLocals | 0;
    var sp = thread.sp | 0;
    var opPC = 0, pc = thread.pc | 0;

    var tag: TAGS;
    var type, size;
    var value, index, arrayAddr: number, offset, buffer, tag: TAGS, targetPC, jumpOffset;
    var address = 0, isStatic = false;
    var ia = 0, ib = 0; // Integer Operands
    var ll = 0, lh = 0; // Long Low / High

    var classInfo: ClassInfo;
    var otherClassInfo: ClassInfo;
    var fieldInfo: FieldInfo;

    var monitorAddr: number;

    // HEAD
    var lastPC = 0;
    while (true) {
      opPC = pc, op = code[pc], pc = pc + 1 | 0;
      lastPC = opPC;

      // PATCH(j2me-nx-port): 挂起采样（每 2^23 条指令一次，开销可忽略）
      if ((hangTick = hangTick - 1) <= 0) {
        hangTick = 8388608;
        hangSample(mi, opPC, thread, lp, fp);
      }

      // PATCH(j2me-nx-port): 热点 Top10 采样（每 2^20 条指令一次）
      if ((hotTick = hotTick - 1) <= 0) {
        hotTick = 1048576;
        hotSample(mi);
      }

      if (!release) {
        assert(code === mi.codeAttribute.code, "Bad Code.");
        assert(ci === mi.classInfo, "Bad Class Info.");
        assert(cp === ci.constantPool, "Bad Constant Pool.");
        assert(lp === fp - mi.codeAttribute.max_locals, "Bad lp.");
        assert(fp >= (thread.tp >> 2), "Frame pointer is not less than than the top of the stack.");
        assert(fp < (thread.tp + Constants.MAX_STACK_SIZE >> 2), "Frame pointer is not greater than the stack size.");
        bytecodeCount++;

        if (traceStackWriter) {
          frame.set(thread, fp, sp, opPC); frame.trace(traceStackWriter);
          traceStackWriter.writeLn();
          traceStackWriter.greenLn(mi.implKey + ": PC: " + opPC + ", FP: " + fp + ", " + Bytecode.getBytecodesName(op));
        }
      }

      try {
        switch (op) {
          case Bytecodes.NOP:
            continue;
          case Bytecodes.ACONST_NULL:
            i32[sp] = Constants.NULL;
            sp = sp + 1 | 0;
            continue;
          case Bytecodes.ICONST_M1:
          case Bytecodes.ICONST_0:
          case Bytecodes.ICONST_1:
          case Bytecodes.ICONST_2:
          case Bytecodes.ICONST_3:
          case Bytecodes.ICONST_4:
          case Bytecodes.ICONST_5:
            i32[sp] = op - Bytecodes.ICONST_0 | 0;
            sp = sp + 1 | 0;
            continue;
          case Bytecodes.FCONST_0:
          case Bytecodes.FCONST_1:
          case Bytecodes.FCONST_2:
            f32[sp] = op - Bytecodes.FCONST_0 | 0;
            sp = sp + 1 | 0;
            continue;
          case Bytecodes.DCONST_0:
            i32[sp] = 0;
            sp = sp + 1 | 0;
            i32[sp] = 0;
            sp = sp + 1 | 0;
            continue;
          case Bytecodes.DCONST_1:
            i32[sp] = 0;
            sp = sp + 1 | 0;
            i32[sp] = 1072693248;
            sp = sp + 1 | 0;
            continue;
          case Bytecodes.LCONST_0:
          case Bytecodes.LCONST_1:
            i32[sp] = op - Bytecodes.LCONST_0 | 0;
            sp = sp + 1 | 0;
            i32[sp] = 0;
            sp = sp + 1 | 0;
            continue;
          case Bytecodes.BIPUSH:
            i32[sp] = code[pc] << 24 >> 24;
            sp = sp + 1 | 0;
            pc = pc + 1 | 0;
            continue;
          case Bytecodes.SIPUSH:
            i32[sp] = (code[pc] << 8 | code[pc + 1 | 0]) << 16 >> 16;
            sp = sp + 1 | 0;
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.LDC:
          case Bytecodes.LDC_W:
            index = (op === Bytecodes.LDC) ? code[pc++] : code[pc++] << 8 | code[pc++];
            offset = cp.entries[index];
            buffer = cp.buffer;
            tag = buffer[offset++];
            if (tag === TAGS.CONSTANT_Integer || tag === TAGS.CONSTANT_Float) {
              i32[sp++] = buffer[offset++] << 24 | buffer[offset++] << 16 | buffer[offset++] << 8 | buffer[offset++];
            } else if (tag === TAGS.CONSTANT_String) {
              i32[sp++] = cp.resolve(index, tag, false);
            } else {
              release || assert(false, getTAGSName(tag));
            }
            continue;
          case Bytecodes.LDC2_W:
            index = code[pc++] << 8 | code[pc++];
            offset = cp.entries[index];
            buffer = cp.buffer;
            tag = buffer[offset++];
            if (tag === TAGS.CONSTANT_Long || tag === TAGS.CONSTANT_Double) {
              i32[sp + 1] = buffer[offset++] << 24 | buffer[offset++] << 16 | buffer[offset++] << 8 | buffer[offset++];
              i32[sp    ] = buffer[offset++] << 24 | buffer[offset++] << 16 | buffer[offset++] << 8 | buffer[offset++];
              sp += 2;
            } else {
              release || assert(false, getTAGSName(tag));
            }
            continue;
          case Bytecodes.ILOAD:
          case Bytecodes.FLOAD:
          case Bytecodes.ALOAD:
            i32[sp] = i32[lp + code[pc] | 0];
            sp = sp + 1 | 0;
            pc = pc + 1 | 0;
            continue;
          case Bytecodes.LLOAD:
          case Bytecodes.DLOAD:
            offset = lp + code[pc] | 0;
            i32[sp]         = i32[offset];
            i32[sp + 1 | 0] = i32[offset + 1 | 0];
            sp = sp + 2 | 0;
            pc = pc + 1 | 0;
            continue;
          case Bytecodes.ILOAD_0:
          case Bytecodes.ILOAD_1:
          case Bytecodes.ILOAD_2:
          case Bytecodes.ILOAD_3:
            i32[sp] = i32[(lp + op | 0) - Bytecodes.ILOAD_0 | 0];
            sp = sp + 1 | 0;
            continue;
          case Bytecodes.FLOAD_0:
          case Bytecodes.FLOAD_1:
          case Bytecodes.FLOAD_2:
          case Bytecodes.FLOAD_3:
            i32[sp] = i32[(lp + op | 0) - Bytecodes.FLOAD_0 | 0];
            sp = sp + 1 | 0;
            continue;
          case Bytecodes.ALOAD_0:
          case Bytecodes.ALOAD_1:
          case Bytecodes.ALOAD_2:
          case Bytecodes.ALOAD_3:
            i32[sp] = i32[(lp + op | 0) - Bytecodes.ALOAD_0 | 0];
            sp = sp + 1 | 0;
            continue;
          case Bytecodes.LLOAD_0:
          case Bytecodes.LLOAD_1:
          case Bytecodes.LLOAD_2:
          case Bytecodes.LLOAD_3:
            offset = (lp + op | 0) - Bytecodes.LLOAD_0 | 0;
            i32[sp]         = i32[offset];
            i32[sp + 1 | 0] = i32[offset + 1 | 0];
            sp = sp + 2 | 0;
            continue;
          case Bytecodes.DLOAD_0:
          case Bytecodes.DLOAD_1:
          case Bytecodes.DLOAD_2:
          case Bytecodes.DLOAD_3:
            offset = (lp + op | 0) - Bytecodes.DLOAD_0 | 0;
            i32[sp]         = i32[offset];
            i32[sp + 1 | 0] = i32[offset + 1 | 0];
            sp = sp + 2 | 0;
            continue;
          case Bytecodes.IALOAD:
          case Bytecodes.FALOAD:
            index = i32[--sp];
            arrayAddr = i32[--sp];
            if ((index >>> 0) >= (i32[arrayAddr + Constants.ARRAY_LENGTH_OFFSET >> 2] >>> 0)) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArrayIndexOutOfBoundsException, index);
            }
            i32[sp++] = i32[(arrayAddr + Constants.ARRAY_HDR_SIZE >> 2) + index];
            continue;
          case Bytecodes.BALOAD:
            index = i32[--sp];
            arrayAddr = i32[--sp];
            if ((index >>> 0) >= (i32[arrayAddr + Constants.ARRAY_LENGTH_OFFSET >> 2] >>> 0)) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArrayIndexOutOfBoundsException, index);
            }
            i32[sp++] = i8[arrayAddr + Constants.ARRAY_HDR_SIZE + index];
            continue;
          case Bytecodes.CALOAD:
            index = i32[--sp];
            arrayAddr = i32[--sp];
            if ((index >>> 0) >= (i32[arrayAddr + Constants.ARRAY_LENGTH_OFFSET >> 2] >>> 0)) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArrayIndexOutOfBoundsException, index);
            }
            i32[sp++] = u16[(arrayAddr + Constants.ARRAY_HDR_SIZE >> 1) + index];
            continue;
          case Bytecodes.SALOAD:
            index = i32[--sp];
            arrayAddr = i32[--sp];
            if ((index >>> 0) >= (i32[arrayAddr + Constants.ARRAY_LENGTH_OFFSET >> 2] >>> 0)) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArrayIndexOutOfBoundsException, index);
            }
            i32[sp++] = i16[(arrayAddr + Constants.ARRAY_HDR_SIZE >> 1) + index];
            continue;
          case Bytecodes.AALOAD:
            index = i32[--sp];
            arrayAddr = i32[--sp];

            if (arrayAddr === Constants.NULL) {
              thread.throwException(fp, sp, opPC, ExceptionType.NullPointerException);
              continue;
            }

            if ((index >>> 0) >= (i32[arrayAddr + Constants.ARRAY_LENGTH_OFFSET >> 2] >>> 0)) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArrayIndexOutOfBoundsException, index);
            }
            i32[sp++] = i32[(arrayAddr + Constants.ARRAY_HDR_SIZE >> 2) + index];
            continue;
          case Bytecodes.ISTORE:
          case Bytecodes.FSTORE:
          case Bytecodes.ASTORE:
            sp = sp - 1 | 0;
            i32[lp + code[pc] | 0] = i32[sp];
            pc = pc + 1 | 0;
            continue;
          case Bytecodes.LSTORE:
          case Bytecodes.DSTORE:
            offset = lp + code[pc] | 0;
            sp = sp - 1 | 0;
            i32[offset + 1 | 0] = i32[sp];
            sp = sp - 1 | 0;
            i32[offset]     = i32[sp];
            pc = pc + 1 | 0;
            continue;
          case Bytecodes.ISTORE_0:
          case Bytecodes.ISTORE_1:
          case Bytecodes.ISTORE_2:
          case Bytecodes.ISTORE_3:
            sp = sp - 1 | 0;
            i32[(lp + op | 0) - Bytecodes.ISTORE_0 | 0] = i32[sp];
            continue;
          case Bytecodes.FSTORE_0:
          case Bytecodes.FSTORE_1:
          case Bytecodes.FSTORE_2:
          case Bytecodes.FSTORE_3:
            sp = sp - 1 | 0;
            i32[(lp + op | 0) - Bytecodes.FSTORE_0 | 0] = i32[sp];
            continue;
          case Bytecodes.ASTORE_0:
          case Bytecodes.ASTORE_1:
          case Bytecodes.ASTORE_2:
          case Bytecodes.ASTORE_3:
            sp = sp - 1 | 0;
            i32[(lp + op | 0) - Bytecodes.ASTORE_0 | 0] = i32[sp];
            continue;
          case Bytecodes.LSTORE_0:
          case Bytecodes.LSTORE_1:
          case Bytecodes.LSTORE_2:
          case Bytecodes.LSTORE_3:
            offset = lp + op - Bytecodes.LSTORE_0;
            i32[offset + 1] = i32[--sp];
            i32[offset]     = i32[--sp];
            continue;
          case Bytecodes.DSTORE_0:
          case Bytecodes.DSTORE_1:
          case Bytecodes.DSTORE_2:
          case Bytecodes.DSTORE_3:
            offset = lp + op - Bytecodes.DSTORE_0;
            i32[offset + 1] = i32[--sp];
            i32[offset]     = i32[--sp];
            continue;
          case Bytecodes.IASTORE:
          case Bytecodes.FASTORE:
            value = i32[--sp];
            index = i32[--sp];
            arrayAddr = i32[--sp];
            if ((index >>> 0) >= (i32[arrayAddr + Constants.ARRAY_LENGTH_OFFSET >> 2] >>> 0)) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArrayIndexOutOfBoundsException, index);
            }
            i32[(arrayAddr + Constants.ARRAY_HDR_SIZE >> 2) + index] = value;
            continue;
          case Bytecodes.BASTORE:
            value = i32[--sp];
            index = i32[--sp];
            arrayAddr = i32[--sp];
            if ((index >>> 0) >= (i32[arrayAddr + Constants.ARRAY_LENGTH_OFFSET >> 2] >>> 0)) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArrayIndexOutOfBoundsException, index);
            }
            i8[arrayAddr + Constants.ARRAY_HDR_SIZE + index] = value;
            continue;
          case Bytecodes.CASTORE:
            value = i32[--sp];
            index = i32[--sp];
            arrayAddr = i32[--sp];
            if ((index >>> 0) >= (i32[arrayAddr + Constants.ARRAY_LENGTH_OFFSET >> 2] >>> 0)) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArrayIndexOutOfBoundsException, index);
            }
            u16[(arrayAddr + Constants.ARRAY_HDR_SIZE >> 1) + index] = value;
            continue;
          case Bytecodes.SASTORE:
            value = i32[--sp];
            index = i32[--sp];
            arrayAddr = i32[--sp];
            if ((index >>> 0) >= (i32[arrayAddr + Constants.ARRAY_LENGTH_OFFSET >> 2] >>> 0)) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArrayIndexOutOfBoundsException, index);
            }
            i16[(arrayAddr + Constants.ARRAY_HDR_SIZE >> 1) + index] = value;
            continue;
          case Bytecodes.LASTORE:
          case Bytecodes.DASTORE:
            lh = i32[--sp];
            ll = i32[--sp];
            index = i32[--sp];
            arrayAddr = i32[--sp];
            if ((index >>> 0) >= (i32[arrayAddr + Constants.ARRAY_LENGTH_OFFSET >> 2] >>> 0)) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArrayIndexOutOfBoundsException, index);
            }
            i32[(arrayAddr + Constants.ARRAY_HDR_SIZE >> 2) + index * 2    ] = ll;
            i32[(arrayAddr + Constants.ARRAY_HDR_SIZE >> 2) + index * 2 + 1] = lh;
            continue;
          case Bytecodes.LALOAD:
          case Bytecodes.DALOAD:
            index = i32[--sp];
            arrayAddr = i32[--sp];
            if ((index >>> 0) >= (i32[arrayAddr + Constants.ARRAY_LENGTH_OFFSET >> 2] >>> 0)) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArrayIndexOutOfBoundsException, index);
            }
            i32[sp++] = i32[(arrayAddr + Constants.ARRAY_HDR_SIZE >> 2) + index * 2    ];
            i32[sp++] = i32[(arrayAddr + Constants.ARRAY_HDR_SIZE >> 2) + index * 2 + 1];
            continue;
          case Bytecodes.AASTORE:
            address = i32[--sp];
            index = i32[--sp];
            arrayAddr = i32[--sp];

            if (arrayAddr === Constants.NULL) {
              thread.throwException(fp, sp, opPC, ExceptionType.NullPointerException);
              continue;
            }

            if ((index >>> 0) >= (i32[arrayAddr + Constants.ARRAY_LENGTH_OFFSET >> 2] >>> 0)) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArrayIndexOutOfBoundsException, index);
            }
            checkArrayStore(arrayAddr, address);
            i32[(arrayAddr + Constants.ARRAY_HDR_SIZE >> 2) + index] = address;
            continue;
          case Bytecodes.POP:
            sp = sp - 1 | 0;
            continue;
          case Bytecodes.POP2:
            sp = sp - 2 | 0;
            continue;
          case Bytecodes.DUP: // ... a -> ... a, a
            i32[sp] = i32[sp - 1 | 0];
            sp = sp + 1 | 0;
            continue;
          case Bytecodes.DUP2: // ... b, a -> ... b, a, b, a
            i32[sp    ] = i32[sp - 2]; // b
            i32[sp + 1] = i32[sp - 1]; // a
            sp += 2;
            continue;
          case Bytecodes.DUP_X1: // ... b, a -> ... a, b, a
            i32[sp    ] = i32[sp - 1]; // a
            i32[sp - 1] = i32[sp - 2]; // b
            i32[sp - 2] = i32[sp];     // a
            sp++;
            continue;
          case Bytecodes.DUP_X2: // ... c, b, a -> ... a, c, b, a
            i32[sp    ] = i32[sp - 1]; // a
            i32[sp - 1] = i32[sp - 2]; // b
            i32[sp - 2] = i32[sp - 3]; // c
            i32[sp - 3] = i32[sp];     // a
            sp++;
            continue;
          case Bytecodes.DUP2_X1: // ... c, b, a -> ... b, a, c, b, a
            i32[sp + 1] = i32[sp - 1]; // a
            i32[sp    ] = i32[sp - 2]; // b
            i32[sp - 1] = i32[sp - 3]; // c
            i32[sp - 2] = i32[sp + 1]; // a
            i32[sp - 3] = i32[sp    ]; // b
            sp += 2;
            continue;
          case Bytecodes.DUP2_X2: // ... d, c, b, a -> ... b, a, d, c, b, a
            i32[sp + 1] = i32[sp - 1]; // a
            i32[sp    ] = i32[sp - 2]; // b
            i32[sp - 1] = i32[sp - 3]; // c
            i32[sp - 2] = i32[sp - 4]; // d
            i32[sp - 3] = i32[sp + 1]; // a
            i32[sp - 4] = i32[sp    ]; // b
            sp += 2;
            continue;
          case Bytecodes.SWAP:
            ia = i32[sp - 1];
            i32[sp - 1] = i32[sp - 2];
            i32[sp - 2] = ia;
            continue;
          case Bytecodes.IINC:
            index = code[pc];
            value = code[pc + 1 | 0] << 24 >> 24;
            i32[lp + index | 0] = i32[lp + index | 0] + value | 0;
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IADD:
            i32[sp - 2 | 0] = (i32[sp - 2 | 0] + i32[sp - 1 | 0]) | 0;
            sp = sp - 1 | 0;
            continue;
          case Bytecodes.LADD:
            ASM._lAdd(sp - 4 << 2, sp - 4 << 2, sp - 2 << 2); sp -= 2;
            continue;
          case Bytecodes.FADD:
            f32[sp - 2] = f32[sp - 2] + f32[sp - 1]; sp--;
            continue;
          case Bytecodes.DADD:
            aliasedI32[0] = i32[sp - 4];
            aliasedI32[1] = i32[sp - 3]; ia = aliasedF64[0];
            aliasedI32[0] = i32[sp - 2];
            aliasedI32[1] = i32[sp - 1]; ib = aliasedF64[0];
            aliasedF64[0] = ia + ib;
            i32[sp - 4] = aliasedI32[0];
            i32[sp - 3] = aliasedI32[1];
            sp -= 2;
            continue;
          case Bytecodes.ISUB:
            i32[sp - 2 | 0] = (i32[sp - 2 | 0] - i32[sp - 1 | 0]) | 0;
            sp = sp - 1 | 0;
            continue;
          case Bytecodes.LSUB:
            ASM._lSub(sp - 4 << 2, sp - 4 << 2, sp - 2 << 2); sp -= 2;
            continue;
          case Bytecodes.FSUB:
            f32[sp - 2] = f32[sp - 2] - f32[sp - 1]; sp--;
            continue;
          case Bytecodes.DSUB:
            aliasedI32[0] = i32[sp - 4];
            aliasedI32[1] = i32[sp - 3]; ia = aliasedF64[0];
            aliasedI32[0] = i32[sp - 2];
            aliasedI32[1] = i32[sp - 1]; ib = aliasedF64[0];
            aliasedF64[0] = ia - ib;
            i32[sp - 4] = aliasedI32[0];
            i32[sp - 3] = aliasedI32[1];
            sp -= 2;
            continue;
          case Bytecodes.IMUL:
            i32[sp - 2 | 0] = Math.imul(i32[sp - 2 | 0], i32[sp - 1 | 0]) | 0;
            sp = sp - 1 | 0;
            continue;
          case Bytecodes.LMUL:
            ASM._lMul(sp - 4 << 2, sp - 4 << 2, sp - 2 << 2); sp -= 2;
            continue;
          case Bytecodes.FMUL:
            f32[sp - 2] = f32[sp - 2] * f32[sp - 1]; sp--;
            continue;
          case Bytecodes.DMUL:
            aliasedI32[0] = i32[sp - 4];
            aliasedI32[1] = i32[sp - 3]; ia = aliasedF64[0];
            aliasedI32[0] = i32[sp - 2];
            aliasedI32[1] = i32[sp - 1]; ib = aliasedF64[0];
            aliasedF64[0] = ia * ib;
            i32[sp - 4] = aliasedI32[0];
            i32[sp - 3] = aliasedI32[1];
            sp -= 2;
            continue;
          case Bytecodes.IDIV:
            if (i32[sp - 1] === 0) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArithmeticException);
            }
            ia = i32[sp - 2];
            ib = i32[sp - 1];
            i32[sp - 2] = (ia === Constants.INT_MIN && ib === -1) ? ia : ((ia / ib) | 0); sp--;
            continue;
          case Bytecodes.LDIV:
            if (i32[sp - 2] === 0 && i32[sp - 1] === 0) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArithmeticException);
            }
            ASM._lDiv(sp - 4 << 2, sp - 4 << 2, sp - 2 << 2); sp -= 2;
            continue;
          case Bytecodes.FDIV:
            f32[sp - 2] = Math.fround(f32[sp - 2] / f32[sp - 1]); sp--;
            continue;
          case Bytecodes.DDIV:
            aliasedI32[0] = i32[sp - 4];
            aliasedI32[1] = i32[sp - 3]; ia = aliasedF64[0];
            aliasedI32[0] = i32[sp - 2];
            aliasedI32[1] = i32[sp - 1]; ib = aliasedF64[0];
            aliasedF64[0] = ia / ib;
            i32[sp - 4] = aliasedI32[0];
            i32[sp - 3] = aliasedI32[1];
            sp -= 2;
            continue;
          case Bytecodes.IREM:
            if (i32[sp - 1] === 0) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArithmeticException);
            }
            i32[sp - 2] = (i32[sp - 2] % i32[sp - 1]) | 0; sp--;
            continue;
          case Bytecodes.LREM:
            if (i32[sp - 2] === 0 && i32[sp - 1] === 0) {
              thread.throwException(fp, sp, opPC, ExceptionType.ArithmeticException);
            }
            ASM._lRem(sp - 4 << 2, sp - 4 << 2, sp - 2 << 2); sp -= 2;
            continue;
          case Bytecodes.FREM:
            f32[sp - 2] = Math.fround(f32[sp - 2] % f32[sp - 1]); sp--;
            continue;
          case Bytecodes.DREM:
            aliasedI32[0] = i32[sp - 4];
            aliasedI32[1] = i32[sp - 3]; ia = aliasedF64[0];
            aliasedI32[0] = i32[sp - 2];
            aliasedI32[1] = i32[sp - 1]; ib = aliasedF64[0];
            aliasedF64[0] = ia % ib;
            i32[sp - 4] = aliasedI32[0];
            i32[sp - 3] = aliasedI32[1];
            sp -= 2;
            continue;
          case Bytecodes.INEG:
            i32[sp - 1] = -i32[sp - 1] | 0;
            continue;
          case Bytecodes.LNEG:
            ASM._lNeg(sp - 2 << 2, sp - 2 << 2);
            continue;
          case Bytecodes.FNEG:
            f32[sp - 1] = -f32[sp - 1];
            continue;
          case Bytecodes.DNEG:
            aliasedI32[0] = i32[sp - 2];
            aliasedI32[1] = i32[sp - 1];
            aliasedF64[0] = -aliasedF64[0];
            i32[sp - 2] = aliasedI32[0];
            i32[sp - 1] = aliasedI32[1];
            continue;
          case Bytecodes.ISHL:
            i32[sp - 2 | 0] = i32[sp - 2 | 0] << i32[sp - 1 | 0];
            sp = sp - 1 | 0;
            continue;
          case Bytecodes.LSHL:
            ASM._lShl(sp - 3 << 2, sp - 3 << 2, i32[sp - 1]); sp -= 1;
            continue;
          case Bytecodes.ISHR:
            i32[sp - 2 | 0] = i32[sp - 2 | 0] >> i32[sp - 1 | 0];
            sp = sp - 1 | 0;
            continue;
          case Bytecodes.LSHR:
            ASM._lShr(sp - 3 << 2, sp - 3 << 2, i32[sp - 1]); sp -= 1;
            continue;
          case Bytecodes.IUSHR:
            i32[sp - 2 | 0] = i32[sp - 2 | 0] >>> i32[sp - 1 | 0];
            sp = sp - 1 | 0;
            continue;
          case Bytecodes.LUSHR:
            ASM._lUshr(sp - 3 << 2, sp - 3 << 2, i32[sp - 1]); sp -= 1;
            continue;
          case Bytecodes.IAND:
            i32[sp - 2] &= i32[sp - 1 | 0];
            sp = sp - 1 | 0;
            continue;
          case Bytecodes.LAND:
            i32[sp - 4] &= i32[sp - 2];
            i32[sp - 3] &= i32[sp - 1]; sp -= 2;
            break;
          case Bytecodes.IOR:
            i32[sp - 2] |= i32[sp - 1 | 0];
            sp = sp - 1 | 0;
            continue;
          case Bytecodes.LOR:
            i32[sp - 4] |= i32[sp - 2];
            i32[sp - 3] |= i32[sp - 1]; sp -= 2;
            continue;
          case Bytecodes.IXOR:
            i32[sp - 2] ^= i32[sp - 1 | 0];
            sp = sp - 1 | 0;
            continue;
          case Bytecodes.LXOR:
            i32[sp - 4] ^= i32[sp - 2];
            i32[sp - 3] ^= i32[sp - 1]; sp -= 2;
            continue;
          case Bytecodes.LCMP:
            ASM._lCmp(sp - 4 << 2, sp - 4 << 2, sp - 2 << 2); sp -= 3;
            continue;
          case Bytecodes.FCMPL:
          case Bytecodes.FCMPG:
            var FCMP_fb = f32[--sp];
            var FCMP_fa = f32[--sp];
            if (FCMP_fa !== FCMP_fa || FCMP_fb !== FCMP_fb) {
              i32[sp++] = op === Bytecodes.FCMPL ? -1 : 1;
            } else if (FCMP_fa > FCMP_fb) {
              i32[sp++] = 1;
            } else if (FCMP_fa < FCMP_fb) {
              i32[sp++] = -1;
            } else {
              i32[sp++] = 0;
            }
            continue;
          case Bytecodes.DCMPL:
          case Bytecodes.DCMPG:
            aliasedI32[0] = i32[sp - 2];
            aliasedI32[1] = i32[sp - 1];
            var DCMP_fb = aliasedF64[0];
            aliasedI32[0] = i32[sp - 4];
            aliasedI32[1] = i32[sp - 3];
            var DCMP_fa = aliasedF64[0];
            sp -= 4;
            if (DCMP_fa !== DCMP_fa || DCMP_fb !== DCMP_fb) {
              i32[sp++] = op === Bytecodes.DCMPL ? -1 : 1;
            } else if (DCMP_fa > DCMP_fb) {
              i32[sp++] = 1;
            } else if (DCMP_fa < DCMP_fb) {
              i32[sp++] = -1;
            } else {
              i32[sp++] = 0;
            }
            continue;
          case Bytecodes.IFEQ:
            if (i32[--sp] === 0) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IFNE:
            if (i32[--sp] !== 0) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IFLT:
            if (i32[--sp] < 0) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IFGE:
            if (i32[--sp] >= 0) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IFGT:
            if (i32[--sp] > 0) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IFLE:
            if (i32[--sp] <= 0) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IF_ICMPEQ:
            if (i32[--sp] === i32[--sp]) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IF_ICMPNE:
            if (i32[--sp] !== i32[--sp]) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IF_ICMPLT:
            if (i32[--sp] > i32[--sp]) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IF_ICMPGE:
            if (i32[--sp] <= i32[--sp]) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IF_ICMPGT:
            if (i32[--sp] < i32[--sp]) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IF_ICMPLE:
            if (i32[--sp] >= i32[--sp]) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IF_ACMPEQ:
            if (i32[--sp] === i32[--sp]) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IF_ACMPNE:
            if (i32[--sp] !== i32[--sp]) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IFNULL:
            if (i32[--sp] === Constants.NULL) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.IFNONNULL:
            if (i32[--sp] !== Constants.NULL) {
              jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
              if (jumpOffset < 0) {
                countBackwardBranch(mi);
                // PATCH(j2me-nx-port): IF 系回边 OSR——与 GOTO 路径同款栈上替换。
                // 混淆器优化的主循环方法（回边=条件跳转）此前永远无法切编译码。
                if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                    mi.onStackReplacementEntryPoints.length > 0 &&
                    mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                    traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                    onStackReplacementCount++;
                    // Set the global OSR to the current method info.
                    O = mi;
                    thread.set(fp, sp, opPC + jumpOffset);
                    opPC = i32[fp + FrameLayout.CallerRAOffset];
                    fp = i32[fp + FrameLayout.CallerFPOffset];
                    var kind = Kind.Void;
                    var signatureKinds = mi.signatureKinds;
                    var returnValue;
                    // The osr will push a Native frame for us.
                    var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                    returnValue = mi.fn.call();
                    release || assert(O === null, "OSR frame must be removed.");
                    if (U) {
                      traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                      release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                      thread.nativeFrameCount--;
                      i32[frameTypeOffset] = FrameType.PushPendingFrames;
                      thread.unwoundNativeFrames.push(null);
                      return;
                    }
                    thread.popMarkerFrame(FrameType.Native);
                    sp = thread.sp | 0;
                    release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                    kind = signatureKinds[0];
                    if (previousFrameType === FrameType.ExitInterpreter) {
                      thread.set(fp, sp, opPC);
                      switch (kind) {
                        case Kind.Long:
                        case Kind.Double:
                          return returnLong(returnValue, tempReturn0);
                        case Kind.Int:
                        case Kind.Byte:
                        case Kind.Char:
                        case Kind.Float:
                        case Kind.Short:
                        case Kind.Boolean:
                        case Kind.Reference:
                          return returnValue;
                        case Kind.Void:
                          return;
                        default:
                          release || assert(false, "Invalid Kind: " + getKindName(kind));
                      }
                    }
                    mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                    type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                    maxLocals = mi.codeAttribute.max_locals;
                    lp = fp - maxLocals | 0;
                    ci = mi.classInfo;
                    cp = ci.constantPool;
                    code = mi.codeAttribute.code;
                    pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                    // Push return value.
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        i32[sp++] = returnValue;
                        i32[sp++] = tempReturn0;
                        continue;
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        i32[sp++] = returnValue;
                        continue;
                      case Kind.Void:
                        continue;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                }
              }
              pc = opPC + jumpOffset | 0;
              continue;
            }
            pc = pc + 2 | 0;
            continue;
          case Bytecodes.GOTO:
            jumpOffset = ((code[pc++] << 8 | code[pc++]) << 16 >> 16);
            if (jumpOffset < 0) {
              mi.stats.backwardsBranchCount++;
              if (config.forceRuntimeCompilation || (mi.state === MethodState.Cold &&
                  mi.stats.interpreterCallCount + mi.stats.backwardsBranchCount > ConfigThresholds.BackwardBranchThreshold)) {
                // PATCH(perfZ34)：只排队，不做帧中间同步编译（见 runtime.ts requestCompile）
                if (config.forceRuntimeCompilation) { compileAndLinkMethod(mi); } else { requestCompile(mi); }
              }
              if (enableOnStackReplacement && mi.state === MethodState.Compiled) {
                // Just because we've jumped backwards doesn't mean we are at a loop header but it does mean that we are
                // at the beginning of a basic block. This is a really cheap test and a convenient place to perform an
                // on stack replacement.
                var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;

                if ((previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) && mi.onStackReplacementEntryPoints.indexOf(opPC + jumpOffset) > -1) {
                  traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                  onStackReplacementCount++;

                  // Set the global OSR to the current method info.
                  O = mi;

                  thread.set(fp, sp, opPC + jumpOffset);
                  opPC = i32[fp + FrameLayout.CallerRAOffset];
                  fp = i32[fp + FrameLayout.CallerFPOffset];

                  var kind = Kind.Void;
                  var signatureKinds = mi.signatureKinds;
                  var returnValue;

                  // The osr will push a Native frame for us.
                  var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;

                  returnValue = mi.fn.call();
                  release || assert(O === null, "OSR frame must be removed.");
                  if (!release) {
                    //checkReturnValue(mi, returnValue, tempReturn0);
                  }

                  if (U) {
                    traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                    release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                    thread.nativeFrameCount--;
                    i32[frameTypeOffset] = FrameType.PushPendingFrames;
                    thread.unwoundNativeFrames.push(null);
                    return;
                  }
                  thread.popMarkerFrame(FrameType.Native);
                  sp = thread.sp | 0;

                  release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");

                  kind = signatureKinds[0];

                  if (previousFrameType === FrameType.ExitInterpreter) {
                    thread.set(fp, sp, opPC);
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        return returnLong(returnValue, tempReturn0);
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        return returnValue;
                      case Kind.Void:
                        return;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }

                  mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                  type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;

                  maxLocals = mi.codeAttribute.max_locals;
                  lp = fp - maxLocals | 0;
                  ci = mi.classInfo;
                  cp = ci.constantPool;
                  code = mi.codeAttribute.code;

                  pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                  // Push return value.
                  switch (kind) {
                    case Kind.Long:
                    case Kind.Double:
                      i32[sp++] = returnValue;
                      i32[sp++] = tempReturn0;
                      continue;
                    case Kind.Int:
                    case Kind.Byte:
                    case Kind.Char:
                    case Kind.Float:
                    case Kind.Short:
                    case Kind.Boolean:
                    case Kind.Reference:
                      i32[sp++] = returnValue;
                      continue;
                    case Kind.Void:
                      continue;
                    default:
                      release || assert(false, "Invalid Kind: " + getKindName(kind));
                  }
                }
              }
            }
            pc = opPC + jumpOffset | 0;
            continue;
          //        case Bytecodes.GOTO_W:
          //          frame.pc = frame.read32Signed() - 1;
          //          break;
          //        case Bytecodes.JSR:
          //          pc = frame.read16();
          //          stack.push(frame.pc);
          //          frame.pc = pc;
          //          break;
          //        case Bytecodes.JSR_W:
          //          pc = frame.read32();
          //          stack.push(frame.pc);
          //          frame.pc = pc;
          //          break;
          //        case Bytecodes.RET:
          //          frame.pc = frame.local[frame.read8()];
          //          break;
          case Bytecodes.I2L:
            i32[sp] = i32[sp - 1] < 0 ? -1 : 0; sp++;
            continue;
          case Bytecodes.I2F:
            aliasedF32[0] = i32[--sp];
            i32[sp++] = aliasedI32[0];
            continue;
          case Bytecodes.I2D:
            aliasedF64[0] = i32[--sp];
            i32[sp++] = aliasedI32[0];
            i32[sp++] = aliasedI32[1];
            continue;
          case Bytecodes.L2I:
            sp--;
            continue;
          case Bytecodes.L2F:
            aliasedF32[0] = Math.fround(longToNumber(i32[sp - 2], i32[sp - 1]));
            i32[sp - 2] = aliasedI32[0];
            sp --;
            continue;
          case Bytecodes.L2D:
            aliasedF64[0] = longToNumber(i32[sp - 2], i32[sp - 1]);
            i32[sp - 2] = aliasedI32[0];
            i32[sp - 1] = aliasedI32[1];
            continue;
          case Bytecodes.F2I:
            var F2I_fa = f32[sp - 1];
            if (F2I_fa > Constants.INT_MAX) {
              i32[sp - 1] = Constants.INT_MAX;
            } else if (F2I_fa < Constants.INT_MIN) {
              i32[sp - 1] = Constants.INT_MIN;
            } else {
              i32[sp - 1] = F2I_fa | 0;
            }
            continue;
          case Bytecodes.F2L:
            var F2L_fa = f32[--sp];
            i32[sp++] = returnLongValue(F2L_fa);
            i32[sp++] = tempReturn0;
            continue;
          case Bytecodes.F2D:
            aliasedF64[0] = f32[--sp];
            i32[sp++] = aliasedI32[0];
            i32[sp++] = aliasedI32[1];
            continue;
          case Bytecodes.D2I:
            aliasedI32[0] = i32[sp - 2];
            aliasedI32[1] = i32[sp - 1];
            var D2I_fa = aliasedF64[0];
            if (D2I_fa > Constants.INT_MAX) {
              i32[sp - 2] = Constants.INT_MAX;
            } else if (D2I_fa < Constants.INT_MIN) {
              i32[sp - 2] = Constants.INT_MIN;
            } else {
              i32[sp - 2] = D2I_fa | 0;
            }
            sp --;
            continue;
          case Bytecodes.D2L:
            aliasedI32[0] = i32[sp - 2];
            aliasedI32[1] = i32[sp - 1];
            var D2L_fa = aliasedF64[0];
            if (D2L_fa === Number.POSITIVE_INFINITY) {
              i32[sp - 2] = Constants.LONG_MAX_LOW;
              i32[sp - 1] = Constants.LONG_MAX_HIGH;
            } else if (D2L_fa === Number.NEGATIVE_INFINITY) {
              i32[sp - 2] = Constants.LONG_MIN_LOW;
              i32[sp - 1] = Constants.LONG_MIN_HIGH;
            } else {
              i32[sp - 2] = returnLongValue(D2L_fa);
              i32[sp - 1] = tempReturn0;
            }
            continue;
          case Bytecodes.D2F:
            aliasedI32[0] = i32[sp - 2];
            aliasedI32[1] = i32[sp - 1];
            f32[sp - 2] = Math.fround(aliasedF64[0]);
            sp --;
            continue;
          case Bytecodes.I2B:
            i32[sp - 1] = (i32[sp - 1] << 24) >> 24;
            continue;
          case Bytecodes.I2C:
            i32[sp - 1] &= 0xffff;
            continue;
          case Bytecodes.I2S:
            i32[sp - 1] = (i32[sp - 1] << 16) >> 16;
            continue;
          case Bytecodes.TABLESWITCH:
            pc = (pc + 3) & ~0x03; // Consume Padding
            offset = code[pc++] << 24 | code[pc++] << 16 | code[pc++] << 8 | code[pc++];
            ia = code[pc++] << 24 | code[pc++] << 16 | code[pc++] << 8 | code[pc++];
            ib = code[pc++] << 24 | code[pc++] << 16 | code[pc++] << 8 | code[pc++];
            value = i32[--sp];
            if (value >= ia && value <= ib) {
              pc += (value - ia) << 2;
              offset = code[pc++] << 24 | code[pc++] << 16 | code[pc++] << 8 | code[pc++];
            }
            if (offset < 0) {
              // PATCH(j2me-nx-port): switch 回边计数+OSR（原版完全缺失）
              countBackwardBranch(mi);
              if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                  mi.onStackReplacementEntryPoints.length > 0 &&
                  mi.onStackReplacementEntryPoints.indexOf(opPC + offset) > -1) {
                var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                  traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                  onStackReplacementCount++;
                  O = mi;
                  thread.set(fp, sp, opPC + offset);
                  opPC = i32[fp + FrameLayout.CallerRAOffset];
                  fp = i32[fp + FrameLayout.CallerFPOffset];
                  var kind = Kind.Void;
                  var signatureKinds = mi.signatureKinds;
                  var returnValue;
                  var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                  returnValue = mi.fn.call();
                  release || assert(O === null, "OSR frame must be removed.");
                  if (U) {
                    traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                    release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                    thread.nativeFrameCount--;
                    i32[frameTypeOffset] = FrameType.PushPendingFrames;
                    thread.unwoundNativeFrames.push(null);
                    return;
                  }
                  thread.popMarkerFrame(FrameType.Native);
                  sp = thread.sp | 0;
                  release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                  kind = signatureKinds[0];
                  if (previousFrameType === FrameType.ExitInterpreter) {
                    thread.set(fp, sp, opPC);
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        return returnLong(returnValue, tempReturn0);
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        return returnValue;
                      case Kind.Void:
                        return;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                  mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                  type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  maxLocals = mi.codeAttribute.max_locals;
                  lp = fp - maxLocals | 0;
                  ci = mi.classInfo;
                  cp = ci.constantPool;
                  code = mi.codeAttribute.code;
                  pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                  switch (kind) {
                    case Kind.Long:
                    case Kind.Double:
                      i32[sp++] = returnValue;
                      i32[sp++] = tempReturn0;
                      continue;
                    case Kind.Int:
                    case Kind.Byte:
                    case Kind.Char:
                    case Kind.Float:
                    case Kind.Short:
                    case Kind.Boolean:
                    case Kind.Reference:
                      i32[sp++] = returnValue;
                      continue;
                    case Kind.Void:
                      continue;
                    default:
                      release || assert(false, "Invalid Kind: " + getKindName(kind));
                  }
                }
              }
            }
            pc = opPC + offset;
            continue;
          case Bytecodes.LOOKUPSWITCH:
            pc = (pc + 3) & ~0x03; // Consume Padding
                offset = code[pc++] << 24 | code[pc++] << 16 | code[pc++] << 8 | code[pc++];
            var npairs = code[pc++] << 24 | code[pc++] << 16 | code[pc++] << 8 | code[pc++];
            value = i32[--sp];
            lookup:
            for (var i = 0; i < npairs; i++) {
              var key  = code[pc++] << 24 | code[pc++] << 16 | code[pc++] << 8 | code[pc++];
              if (key === value) {
                offset = code[pc++] << 24 | code[pc++] << 16 | code[pc++] << 8 | code[pc++];
              } else {
                pc += 4;
              }
              if (key >= value) {
                break lookup;
              }
            }
            if (offset < 0) {
              // PATCH(j2me-nx-port): switch 回边计数+OSR（原版完全缺失）
              countBackwardBranch(mi);
              if (enableOnStackReplacement && mi.state === MethodState.Compiled &&
                  mi.onStackReplacementEntryPoints.length > 0 &&
                  mi.onStackReplacementEntryPoints.indexOf(opPC + offset) > -1) {
                var previousFrameType = i32[i32[fp + FrameLayout.CallerFPOffset] + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                if (previousFrameType === FrameType.Interpreter || previousFrameType === FrameType.ExitInterpreter) {
                  traceWriter && traceWriter.writeLn("OSR: " + mi.implKey);
                  onStackReplacementCount++;
                  O = mi;
                  thread.set(fp, sp, opPC + offset);
                  opPC = i32[fp + FrameLayout.CallerRAOffset];
                  fp = i32[fp + FrameLayout.CallerFPOffset];
                  var kind = Kind.Void;
                  var signatureKinds = mi.signatureKinds;
                  var returnValue;
                  var frameTypeOffset = thread.fp - mi.codeAttribute.max_locals + FrameLayout.FrameTypeOffset;
                  returnValue = mi.fn.call();
                  release || assert(O === null, "OSR frame must be removed.");
                  if (U) {
                    traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                    release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                    thread.nativeFrameCount--;
                    i32[frameTypeOffset] = FrameType.PushPendingFrames;
                    thread.unwoundNativeFrames.push(null);
                    return;
                  }
                  thread.popMarkerFrame(FrameType.Native);
                  sp = thread.sp | 0;
                  release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
                  kind = signatureKinds[0];
                  if (previousFrameType === FrameType.ExitInterpreter) {
                    thread.set(fp, sp, opPC);
                    switch (kind) {
                      case Kind.Long:
                      case Kind.Double:
                        return returnLong(returnValue, tempReturn0);
                      case Kind.Int:
                      case Kind.Byte:
                      case Kind.Char:
                      case Kind.Float:
                      case Kind.Short:
                      case Kind.Boolean:
                      case Kind.Reference:
                        return returnValue;
                      case Kind.Void:
                        return;
                      default:
                        release || assert(false, "Invalid Kind: " + getKindName(kind));
                    }
                  }
                  mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                  type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                  maxLocals = mi.codeAttribute.max_locals;
                  lp = fp - maxLocals | 0;
                  ci = mi.classInfo;
                  cp = ci.constantPool;
                  code = mi.codeAttribute.code;
                  pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
                  switch (kind) {
                    case Kind.Long:
                    case Kind.Double:
                      i32[sp++] = returnValue;
                      i32[sp++] = tempReturn0;
                      continue;
                    case Kind.Int:
                    case Kind.Byte:
                    case Kind.Char:
                    case Kind.Float:
                    case Kind.Short:
                    case Kind.Boolean:
                    case Kind.Reference:
                      i32[sp++] = returnValue;
                      continue;
                    case Kind.Void:
                      continue;
                    default:
                      release || assert(false, "Invalid Kind: " + getKindName(kind));
                  }
                }
              }
            }
            pc = opPC + offset;
            continue;
          case Bytecodes.ANEWARRAY:
            index = code[pc++] << 8 | code[pc++];
            classInfo = cp.resolveClass(index);
            size = i32[--sp];
            if (size < 0) {
              thread.throwException(fp, sp, opPC, ExceptionType.NegativeArraySizeException);
            }
            i32[sp++] = newArray(classInfo, size);
            continue;
          case Bytecodes.MULTIANEWARRAY:
            index = code[pc++] << 8 | code[pc++];
            classInfo = cp.resolveClass(index);
            var dimensions = code[pc++];
            var lengths = new Array(dimensions);
            for (var i = 0; i < dimensions; i++) {
              lengths[i] = i32[--sp];
              if (size < 0) {
                thread.throwException(fp, sp, opPC, ExceptionType.NegativeArraySizeException);
              }
            }
            i32[sp++] = J2ME.newMultiArray(classInfo, lengths.reverse());
            continue;
          case Bytecodes.ARRAYLENGTH:
            arrayAddr = i32[--sp];
            if (arrayAddr === Constants.NULL) {
              thread.throwException(fp, sp, opPC, ExceptionType.NullPointerException);
              continue;
            }
            i32[sp++] = i32[(arrayAddr + Constants.ARRAY_LENGTH_OFFSET >> 2)];
            continue;
          case Bytecodes.GETFIELD:
          case Bytecodes.GETSTATIC:
            index = code[pc++] << 8 | code[pc++];
            fieldInfo = cp.resolved[index] || cp.resolveField(index, op === Bytecodes.GETSTATIC);
            if (op === Bytecodes.GETSTATIC) {
              thread.classInitAndUnwindCheck(fp, sp, opPC, fieldInfo.classInfo);
              if (U) {
                return;
              }
              address = $.staticObjectAddresses[fieldInfo.classInfo.id] + fieldInfo.byteOffset;

              if (address === Constants.NULL) {
                thread.throwException(fp, sp, opPC, ExceptionType.NullPointerException);
                continue;
              }
            } else {
              address = i32[--sp];

              if (address === Constants.NULL) {
                thread.throwException(fp, sp, opPC, ExceptionType.NullPointerException);
                continue;
              }

              address += fieldInfo.byteOffset;
            }

            switch (fieldInfo.kind) {
              case Kind.Reference:
                i32[sp++] = i32[address >> 2];
                continue;
              case Kind.Int:
              case Kind.Byte:
              case Kind.Char:
              case Kind.Short:
              case Kind.Boolean:
              case Kind.Float:
                i32[sp++] = i32[address >> 2];
                continue;
              case Kind.Long:
              case Kind.Double:
                i32[sp++] = i32[address     >> 2];
                i32[sp++] = i32[address + 4 >> 2];
                continue;
              default:
                release || assert(false, "fieldInfo.kind");
            }
            continue;
          case Bytecodes.PUTFIELD:
          case Bytecodes.PUTSTATIC:
            index = code[pc++] << 8 | code[pc++];
            fieldInfo = cp.resolved[index] || cp.resolveField(index, op === Bytecodes.PUTSTATIC);
            isStatic = op === Bytecodes.PUTSTATIC;
            if (isStatic) {
              thread.classInitAndUnwindCheck(fp, sp, opPC, fieldInfo.classInfo);
              if (U) {
                return;
              }
              address = $.staticObjectAddresses[fieldInfo.classInfo.id] + fieldInfo.byteOffset;
            } else {
              address = i32[sp - (isTwoSlot(fieldInfo.kind) ? 3 : 2)];

              if (address === Constants.NULL) {
                thread.throwException(fp, sp, opPC, ExceptionType.NullPointerException);
                continue;
              }

              address += fieldInfo.byteOffset;
            }
            switch (fieldInfo.kind) {
              case Kind.Reference:
                i32[address >> 2] = i32[--sp];
                break;
              case Kind.Int:
              case Kind.Byte:
              case Kind.Char:
              case Kind.Short:
              case Kind.Boolean:
              case Kind.Float:
                i32[address >> 2] = i32[--sp];
                break;
              case Kind.Long:
              case Kind.Double:
                i32[address + 4 >> 2] = i32[--sp];
                i32[address     >> 2] = i32[--sp];
                break;
              default:
                release || assert(false, "fieldInfo.kind");
            }
            if (!isStatic) {
              sp--; // Pop Reference
            }
            continue;
          case Bytecodes.NEW:
            index = code[pc++] << 8 | code[pc++];
            release || traceWriter && traceWriter.writeLn(mi.implKey + " " + index);
            classInfo = cp.resolveClass(index);
            thread.classInitAndUnwindCheck(fp, sp, opPC, classInfo);
            if (U) {
              return;
            }
            i32[sp++] = allocObject(classInfo);
            continue;
          case Bytecodes.CHECKCAST:
            index = code[pc++] << 8 | code[pc++];
            classInfo = cp.resolveClass(index);
            address = i32[sp - 1];

            if (address === Constants.NULL) {
              continue;
            }

            otherClassInfo = classIdToClassInfoMap[i32[address >> 2]];

            if (!isAssignableTo(otherClassInfo, classInfo)) {
              thread.set(fp, sp, opPC);
              throw $.newClassCastException (
                otherClassInfo.getClassNameSlow() + " is not assignable to " + classInfo.getClassNameSlow()
              );
            }
            continue;
          case Bytecodes.INSTANCEOF:
            index = code[pc++] << 8 | code[pc++];
            classInfo = cp.resolveClass(index);
            address = i32[--sp];

            if (address === Constants.NULL) {
              i32[sp++] = 0;
            } else {
              otherClassInfo = classIdToClassInfoMap[i32[address >> 2]];
              i32[sp++] = isAssignableTo(otherClassInfo, classInfo) ? 1 : 0;
            }
            continue;
          case Bytecodes.ATHROW:
            address = i32[--sp];
            if (address === Constants.NULL) {
              thread.throwException(fp, sp, opPC, ExceptionType.NullPointerException);
            }
            throw getHandle(address);
          case Bytecodes.MONITORENTER:
            thread.ctx.monitorEnter(getMonitor(i32[--sp]));
            release || assert(U !== VMState.Yielding, "Monitors should never yield.");
            if (U === VMState.Pausing || U === VMState.Stopping) {
              thread.set(fp, sp, pc); // We need to resume past the MONITORENTER bytecode.
              return;
            }
            continue;
          case Bytecodes.MONITOREXIT:
            thread.ctx.monitorExit(getMonitor(i32[--sp]));
            continue;
          case Bytecodes.WIDE:
            var op = code[pc++];
            switch (op) {
              case Bytecodes.ILOAD:
              case Bytecodes.FLOAD:
                i32[sp++] = i32[lp + (code[pc++] << 8 | code[pc++])];
                continue;
              case Bytecodes.ALOAD:
                i32[sp++] = i32[lp + (code[pc++] << 8 | code[pc++])];
                continue;
              case Bytecodes.LLOAD:
              case Bytecodes.DLOAD:
                offset = lp + (code[pc++] << 8 | code[pc++]);
                i32[sp++] = i32[offset];
                i32[sp++] = i32[offset + 1];
                continue;
              case Bytecodes.ISTORE:
              case Bytecodes.FSTORE:
                i32[lp + (code[pc++] << 8 | code[pc++])] = i32[--sp];
                continue;
              case Bytecodes.ASTORE:
                i32[lp + (code[pc++] << 8 | code[pc++])] = i32[--sp];
                continue;
              case Bytecodes.LSTORE:
              case Bytecodes.DSTORE:
                offset = lp + (code[pc++] << 8 | code[pc++]);
                i32[offset + 1] = i32[--sp];
                i32[offset]     = i32[--sp];
                continue;
              case Bytecodes.IINC:
                index = code[pc++] << 8 | code[pc++];
                value = (code[pc++] << 8 | code[pc++]) << 16 >> 16;
                i32[lp + index] = i32[lp + index] + value | 0;
                continue;
              //case Bytecodes.RET:
              //  this.pc = this.local[this.read16()];
              //  break;
              default:
                var opName = Bytecode.getBytecodesName(op);
                throw new Error("Wide opcode " + opName + " [" + op + "] not supported.");
            }
          case Bytecodes.NEWARRAY:
            type = code[pc++];
            size = i32[--sp];
            if (size < 0) {
              thread.throwException(fp, sp, opPC, ExceptionType.NegativeArraySizeException);
            }
            i32[sp++] = newArray(PrimitiveClassInfo["????ZCFDBSIJ"[type]], size);
            continue;
          case Bytecodes.LRETURN:
          case Bytecodes.DRETURN:
          case Bytecodes.IRETURN:
          case Bytecodes.FRETURN:
          case Bytecodes.ARETURN:
          case Bytecodes.RETURN:
            // Store the return values immediately since the values may be overwritten by a push pending frame.
            var returnOne, returnTwo;
            switch (op) {
              case Bytecodes.LRETURN:
              case Bytecodes.DRETURN:
                returnTwo = i32[sp - 2];
              // Fallthrough
              case Bytecodes.IRETURN:
              case Bytecodes.FRETURN:
              case Bytecodes.ARETURN:
                returnOne = i32[sp - 1];
                break;
            }
            var lastMI = mi;
            if (lastMI.isSynchronized) {
              $.ctx.monitorExit(getMonitor(i32[fp + FrameLayout.MonitorOffset]));
            }
            opPC = i32[fp + FrameLayout.CallerRAOffset];
            sp = fp - maxLocals | 0;
            fp = i32[fp + FrameLayout.CallerFPOffset];
            release || assert(fp >= (thread.tp >> 2), "Valid frame pointer after return.");
            mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
            type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
            release || assert(type === FrameType.Interpreter && mi || type !== FrameType.Interpreter && !mi, "Is valid frame type and method info after return.");
            var interrupt = false;
            while (type !== FrameType.Interpreter) {
              if (type === FrameType.ExitInterpreter) {
                thread.set(fp, sp, opPC);
                switch (op) {
                  case Bytecodes.ARETURN:
                  case Bytecodes.IRETURN:
                  case Bytecodes.FRETURN:
                    return returnOne;
                  case Bytecodes.LRETURN:
                    return returnLong(returnTwo, returnOne);
                  case Bytecodes.DRETURN:
                    return returnDouble(returnTwo, returnOne);
                  case Bytecodes.RETURN:
                    return;
                }
              } else if (type === FrameType.PushPendingFrames) {
                thread.set(fp, sp, opPC);
                thread.pushPendingNativeFrames();
                fp = thread.fp | 0;
                sp = thread.sp | 0;
                opPC = pc = thread.pc;
                type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                continue;
              } else if (type === FrameType.Interrupt) {
                thread.set(fp, sp, opPC);
                thread.popMarkerFrame(FrameType.Interrupt);
                fp = thread.fp | 0;
                sp = thread.sp | 0;
                opPC = pc = thread.pc;
                type = i32[fp + FrameLayout.FrameTypeOffset] & FrameLayout.FrameTypeMask;
                mi = methodIdToMethodInfoMap[i32[fp + FrameLayout.CalleeMethodInfoOffset] & FrameLayout.CalleeMethodInfoMask];
                interrupt = true;
                continue;
              } else {
                assert(false, "Bad frame type: " + FrameType[type]);
              }
            }
            release || assert(type === FrameType.Interpreter, "Cannot resume in frame type: " + FrameType[type]);
            maxLocals = mi.codeAttribute.max_locals;
            lp = fp - maxLocals | 0;
            release || traceWriter && traceWriter.outdent();
            release || traceWriter && traceWriter.writeLn("<< I " + lastMI.implKey);
            ci = mi.classInfo;
            cp = ci.constantPool;
            code = mi.codeAttribute.code;

            if (interrupt) {
              continue;
            }
            release || assert(isInvoke(code[opPC]), "Return must come from invoke op: " + mi.implKey + " PC: " + pc + Bytecode.getBytecodesName(op));
            // Calculate the PC based on the size of the caller's invoke bytecode.
            pc = opPC + (code[opPC] === Bytecodes.INVOKEINTERFACE ? 5 : 3);
            // Push return value.
            switch (op) {
              case Bytecodes.LRETURN:
              case Bytecodes.DRETURN:
                i32[sp++] = returnTwo; // Low Bits
              // Fallthrough
              case Bytecodes.IRETURN:
              case Bytecodes.FRETURN:
              case Bytecodes.ARETURN:
                i32[sp++] = returnOne;
                continue;
            }

            continue;
          case Bytecodes.INVOKEVIRTUAL:
          case Bytecodes.INVOKESPECIAL:
          case Bytecodes.INVOKESTATIC:
          case Bytecodes.INVOKEINTERFACE:

            index = code[pc++] << 8 | code[pc++];
            if (op === Bytecodes.INVOKEINTERFACE) {
              pc = pc + 2 | 0; // Args Number & Zero
            }
            isStatic = (op === Bytecodes.INVOKESTATIC);

            // Resolve method and do the class init check if necessary.
            var calleeMethodInfo: MethodInfo = cp.resolved[index] || cp.resolveMethod(index, isStatic);
            var calleeTargetMethodInfo: MethodInfo = null;

            var callee = null;

            if (isStatic) {
              address = Constants.NULL;
            } else {
              address = i32[sp - calleeMethodInfo.argumentSlots];
              classInfo = (address !== Constants.NULL) ? classIdToClassInfoMap[i32[address >> 2]] : null;
            }

            if (isStatic) {
              thread.classInitAndUnwindCheck(fp, sp, opPC, calleeMethodInfo.classInfo);
              if (U) {
                return;
              }
            }

            switch (op) {
              case Bytecodes.INVOKESPECIAL:
                if (address === Constants.NULL) {
                  thread.throwException(fp, sp, opPC, ExceptionType.NullPointerException);
                }
              case Bytecodes.INVOKESTATIC:
                calleeTargetMethodInfo = calleeMethodInfo;
                break;
              case Bytecodes.INVOKEVIRTUAL:
                calleeTargetMethodInfo = classInfo.vTable[calleeMethodInfo.vTableIndex];
                break;
              case Bytecodes.INVOKEINTERFACE:
                calleeTargetMethodInfo = classInfo.iTable[calleeMethodInfo.mangledName];
                break;
              default:
                release || traceWriter && traceWriter.writeLn("Not Implemented: " + Bytecode.getBytecodesName(op));
                assert(false, "Not Implemented: " + Bytecode.getBytecodesName(op));
            }

            // Call Native or Compiled Method.
            var callMethod = calleeTargetMethodInfo.isNative || calleeTargetMethodInfo.state === MethodState.Compiled;
            var calleeStats = calleeTargetMethodInfo.stats;
            calleeStats.interpreterCallCount++;
            if (callMethod === false) {
              if (config.forceRuntimeCompilation || (calleeTargetMethodInfo.state === MethodState.Cold &&
                  calleeStats.interpreterCallCount + calleeStats.backwardsBranchCount > invokeThresholdFor(calleeTargetMethodInfo))) {
                // PATCH(perfZ34)：只排队，不做帧中间同步编译（见 runtime.ts requestCompile）
                if (config.forceRuntimeCompilation) { compileAndLinkMethod(calleeTargetMethodInfo); } else { requestCompile(calleeTargetMethodInfo); }
                callMethod = calleeTargetMethodInfo.state === MethodState.Compiled;
              }
            }
            if (callMethod) {
              var kind = Kind.Void;
              var signatureKinds = calleeTargetMethodInfo.signatureKinds;
              callee = calleeTargetMethodInfo.fn || getLinkedMethod(calleeTargetMethodInfo);
              var returnValue;


              var frameTypeOffset = -1;
              // Fast path for the no-argument case.
              if (signatureKinds.length === 1) {
                if (!isStatic) {
                  --sp; // Pop Reference
                }

                thread.set(fp, sp, opPC);
                thread.pushMarkerFrame(FrameType.Native);
                frameTypeOffset = thread.fp + FrameLayout.FrameTypeOffset;

                returnValue = callee(address);
              } else {
                args.length = 0;

                for (var i = signatureKinds.length - 1; i > 0; i--) {
                  kind = signatureKinds[i];
                  switch (kind) {
                    case Kind.Long:
                    case Kind.Double:
                      args.unshift(i32[--sp]); // High Bits
                      // Fallthrough
                    case Kind.Int:
                    case Kind.Byte:
                    case Kind.Char:
                    case Kind.Float:
                    case Kind.Short:
                    case Kind.Boolean:
                    case Kind.Reference:
                      args.unshift(i32[--sp]);
                      break;
                    default:
                      release || assert(false, "Invalid Kind: " + getKindName(kind));
                  }
                }

                if (!isStatic) {
                  --sp; // Pop Reference
                }

                thread.set(fp, sp, opPC);
                thread.pushMarkerFrame(FrameType.Native);
                frameTypeOffset = thread.fp + FrameLayout.FrameTypeOffset;

                if (!release) {
                  // assert(callee.length === args.length, "Function " + callee + " (" + calleeTargetMethodInfo.implKey + "), should have " + args.length + " arguments.");
                }

                args.unshift(address);
                returnValue = callee.apply(null, args);
              }

              if (!release) {
                // checkReturnValue(calleeMethodInfo, returnValue, tempReturn0);
              }

              if (U) {
                traceWriter && traceWriter.writeLn("<< I Unwind: " + getVMStateName(U));
                release || assert(thread.unwoundNativeFrames.length, "Must have unwound frames.");
                thread.nativeFrameCount--;
                i32[frameTypeOffset] = FrameType.PushPendingFrames;
                thread.unwoundNativeFrames.push(null);
                return;
              }
              thread.popMarkerFrame(FrameType.Native);

              kind = signatureKinds[0];

              // Push return value.
              switch (kind) {
                case Kind.Long:
                case Kind.Double:
                  i32[sp++] = returnValue;
                  i32[sp++] = tempReturn0;
                  continue;
                case Kind.Int:
                case Kind.Byte:
                case Kind.Char:
                case Kind.Float:
                case Kind.Short:
                case Kind.Boolean:
                  i32[sp++] = returnValue;
                  continue;
                case Kind.Reference:
                  release || assert(returnValue !== "number", "native return value is a number");
                  i32[sp++] = returnValue;
                  continue;
                case Kind.Void:
                  continue;
                default:
                  release || assert(false, "Invalid Kind: " + getKindName(kind));
              }
              continue;
            }

            // Call Interpreted Method.
            release || traceWriter && traceWriter.writeLn(">> I " + calleeTargetMethodInfo.implKey);
            mi = calleeTargetMethodInfo;
            maxLocals = mi.codeAttribute.max_locals;
            ci = mi.classInfo;
            cp = ci.constantPool;

            var callerFPOffset = fp;
            // Reserve space for non-parameter locals.
            lp = sp - mi.argumentSlots | 0;
            fp = lp + maxLocals | 0;
            sp = fp + FrameLayout.CallerSaveSize | 0;

            // Caller saved values.
            i32[fp + FrameLayout.CallerRAOffset] = opPC;
            i32[fp + FrameLayout.CallerFPOffset] = callerFPOffset;
            i32[fp + FrameLayout.CalleeMethodInfoOffset] = FrameType.Interpreter | mi.id;
            i32[fp + FrameLayout.MonitorOffset] = Constants.NULL; // Monitor

            // Reset PC.
            opPC = pc = 0;
            lastPC = 0;

            if (calleeTargetMethodInfo.isSynchronized) {
              monitorAddr = calleeTargetMethodInfo.isStatic
                              ? $.getClassObjectAddress(calleeTargetMethodInfo.classInfo)
                              : address;
              i32[fp + FrameLayout.MonitorOffset] = monitorAddr;
              $.ctx.monitorEnter(getMonitor(monitorAddr));
              release || assert(U !== VMState.Yielding, "Monitors should never yield.");
              if (U === VMState.Pausing || U === VMState.Stopping) {
                thread.set(fp, sp, opPC);
                return;
              }
            }

            code = mi.codeAttribute.code;

            release || traceWriter && traceWriter.indent();
            continue;
          default:
            release || traceWriter && traceWriter.writeLn("Not Implemented: " + Bytecode.getBytecodesName(op) + ", PC: " + opPC + ", CODE: " + code.length);
            release || assert(false, "Not Implemented: " + Bytecode.getBytecodesName(op));
            continue;
        }
      } catch (e) {
        release || traceWriter && traceWriter.redLn("XXX I Caught: " + e + ", details: " + toName(e));
        release || traceWriter && traceWriter.writeLn(e.stack);
        // PATCH(j2me-nx-port perfZ24): 落盘"原始异常+当前方法"，但**必须限流**。
        //
        // 为什么限流（2026-09-24 实机四款游戏实测）：这个 catch 抓的是"解释器里抛出的
        // JS 级异常"，而**绝大多数是正常的 Java 异常控制流**过帧（游戏 try 一个不存在的
        // 资源 → ResourceInputStream.<init> 抛 IOException → 逐帧 unwind；或者
        // Display.getDisplay 的 null 引用）。旧实现每次都 `__sdMark` **两条**，
        // 而 `__sdMark` = sdLog + 立即 flush = **每次一次同步写卡**！
        // 实机日志里 AHQSL 启动那一分钟就有 30 条 [jit-trap] = 60 次同步写卡，
        // 全落在"进游戏最忙的那几秒"上 —— 纯粹是拿写卡拖慢启动。
        //
        // 现在：每个方法**前 3 次**照旧立即落盘（诊断价值最高的就是头几次），
        // 之后只累加计数，每 ≥10s 用**批量** sdLog 汇总一行"同类已折叠 N 次"。
        var __trapKey = mi ? mi.implKey : "?";
        var __trapNow = Date.now();
        var __ts = trapStats[__trapKey];
        if (!__ts) {
          __ts = trapStats[__trapKey] = { n: 0, logged: 0, lastFlush: 0 };
        }
        __ts.n++;
        if (jsGlobal && jsGlobal.__sdMark && __ts.logged < 3) {
          __ts.logged++;
          // PATCH(j2me-nx-port perfZ48)：**把 Java 异常对象描述成人看得懂的东西**。
          // 由来：宠物王国4-白金的黑屏根因（copyArea 抛 IllegalStateException）就是靠这条
          // 日志定位的，但它当时打的是 `err=[object Object]` —— 因为 native 抛的是
          // `$.ctx.createException()` 造出来的 **Java 对象句柄**（有 _address / classInfo，
          // 没有 message/stack）。现在优先打 Java 类名，其次才是 JS 错误的 message/stack。
          jsGlobal.__sdMark("[jit-trap] method=" + __trapKey + " pc=" + opPC + " err=" + describeTrapError(e));
          // PATCH(j2me-nx-port): 堆栈前 4 帧定位炸点在哪个编译方法里
          var __trapStack = (e && e.stack) ? String(e.stack).split("\n").slice(0, 4).join(" || ") : "";
          if (__trapStack) jsGlobal.__sdMark("[jit-trap] at " + __trapStack);
        } else if (__trapNow - __ts.lastFlush > 10000) {
          __ts.lastFlush = __trapNow;
          if (jsGlobal && jsGlobal.__sdLog) {
            jsGlobal.__sdLog("[jit-trap] " + __trapKey + " 累计 " + __ts.n +
              " 次（同类只记次数，不再每次写卡）");
          }
        }
        // release || traceWriter && traceWriter.writeLn(jsGlobal.getBacktrace());

        // If an exception is thrown from a native there will be a native marker frame at the top of the stack
        // which will be cut off when the the fp is set on the thread below. To keep the nativeFrameCount in
        // sync the native marker must be popped.
        if (thread.fp > fp && thread.frame.type === FrameType.Native) {
          release || assert(i32[thread.fp + FrameLayout.CallerFPOffset] === fp, "Only one extra frame is on the stack. " + (thread.fp - fp));
          thread.popMarkerFrame(FrameType.Native);
        }
        thread.set(fp, sp, opPC);
        e = translateException(e);
        if (!e.classInfo) {
          // A non-java exception was thrown. Rethrow so it is not handled by exceptionUnwind.
          throw e;
        }
        thread.exceptionUnwind(e);

        // Load thread state after exception unwind.
        fp = thread.fp | 0;
        sp = thread.sp | 0;
        pc = thread.pc | 0;

        mi = thread.frame.methodInfo;
        maxLocals = mi.codeAttribute.max_locals;
        lp = fp - maxLocals | 0;
        ci = mi.classInfo;
        cp = ci.constantPool;
        code = mi.codeAttribute.code;
        continue;
      }
    }
  }

  // print(disassemble(interpret));
}
