/*
 node-jvm
 Copyright (c) 2013 Yaroslav Gaponov <yaroslav.gaponov@gmail.com>
*/

var $: J2ME.Runtime; // The currently-executing runtime.

var tempReturn0 = 0;

interface Math {
  fround(value: number): number;
}

interface CompiledMethodCache {
  get(key: string): {
    key: string;
    args: string[];
    body: string;
    referencedClasses: string[];
    onStackReplacementEntryPoints: any;
  };
  put(obj: {
    key: string;
    args: string[];
    body: string;
    referencedClasses: string[];
    onStackReplacementEntryPoints: any;
  }): Promise<any>;
}

interface AOTMetaData {
  /**
   * On stack replacement pc entry points.
   */
  osr: number [];
}

declare var throwHelper;
declare var throwPause;
declare var throwYield;

module J2ME {

  export function returnLong(l: number, h: number) {
    tempReturn0 = h;
    return l;
  }

  export function returnDouble(l: number, h: number) {
    tempReturn0 = h;
    return l;
  }

  export function returnDoubleValue(v: number) {
    aliasedF64[0] = v;
    return returnDouble(aliasedI32[0], aliasedI32[1]);
  }

  declare var Native, config;
  declare var VM;
  declare var CompiledMethodCache;

  export var aotMetaData = <{string: AOTMetaData}>Object.create(null);

  /**
   * Turns on just-in-time compilation of methods.
   */
  export var enableRuntimeCompilation = true;

  /**
   * Turns on onStackReplacement
   */
  // PATCH(j2me-nx-port): OSR 开关 config 化（config/switch.js enableOSR）
  export var enableOnStackReplacement = config.enableOSR !== false;

  /**
   * Turns on caching of JIT-compiled methods.
   */
  export var enableCompiledMethodCache = true && typeof CompiledMethodCache !== "undefined";

  /**
   * Traces method execution.
   */
  export var traceWriter = null;

  /**
   * Traces bytecode execution.
   */
  export var traceStackWriter = null;

  /**
   * Traces performance problems.
   */
  export var perfWriter = null;

  /**
   * Traces linking and class loading.
   */
  export var linkWriter = null;

  /**
   * Traces JIT compilation.
   */
  export var jitWriter = null;

  /**
   * Traces class loading.
   */
  export var loadWriter = null;

  /**
   * Traces winding and unwinding.
   */
  export var windingWriter = null;

  /**
   * Traces class initialization.
   */
  export var initWriter = null;

  /**
   * Traces thread execution.
   */
  export var threadWriter = null;

  /**
   * Traces generated code.
   */
  export var codeWriter = null;

  export const enum MethodState {
    /**
     * All methods start in this state.
     */
    Cold = 0,

    /**
     * Methods have this state if code has been compiled for them or
     * there is a native implementation that needs to be used.
     */
    Compiled = 1,

    /**
     * We don't want to compiled these methods, they may be too large
     * to benefit from JIT compilation.
     */
    NotCompiled = 2,

    /**
     * Methods are not compiled because of some exception.
     */
    CannotCompile = 3
  }

  declare var Shumway;

  export var timeline;
  export var threadTimeline;
  export var methodTimelines = [];
  export var gcCounter = release ? null : new Metrics.Counter(true);
  export var nativeCounter = release ? null : new Metrics.Counter(true);
  export var runtimeCounter = release ? null : new Metrics.Counter(true);
  export var baselineMethodCounter = release ? null : new Metrics.Counter(true);
  export var asyncCounter = release ? null : new Metrics.Counter(true);

  export var unwindCount = 0;

  if (typeof Shumway !== "undefined") {
    timeline = new Shumway.Tools.Profiler.TimelineBuffer("Runtime");
    threadTimeline = new Shumway.Tools.Profiler.TimelineBuffer("Threads");
  }

  export function enterTimeline(name: string, data?: any) {
    timeline && timeline.enter(name, data);
  }

  export function leaveTimeline(name?: string, data?: any) {
    timeline && timeline.leave(name, data);
  }

  function Int64Array(buffer: ArrayBuffer, offset: number, length: number) {
    this.length = length;
    this.byteOffset = offset;
    this.buffer = buffer;
  }

  /**
   * We can't always mutate the |__proto__|.
   */
  function isPrototypeOfFunctionMutable(fn: Function): boolean {
    // We don't list all builtins here, since not all of them are used in the object
    // hierarchy.
    switch (fn) {
      case Object:
      case Array:
      case Uint8Array:
      case Uint16Array:
      case Float32Array:
      case Float64Array:
      case Int8Array:
      case Int16Array:
      case Int32Array:
      case Int64Array:
        return false;
      default:
        return true;
    }
  }

  export var stdoutWriter = new IndentingWriter();
  export var stderrWriter = new IndentingWriter(false, IndentingWriter.stderr);

  export const enum ExecutionPhase {
    /**
     * Default runtime behaviour.
     */
    Runtime = 0,

    /**
     * When compiling code statically.
     */
    Compiler = 1
  }

  export var phase = ExecutionPhase.Runtime;

  // Initial capacity of the interned strings is the capacity of a large midlet after startup.
  export var internedStrings: TypedArrayHashtable = new TypedArrayHashtable(767);

  declare var util;

  import assert = J2ME.Debug.assert;

  export const enum RuntimeStatus {
    New       = 1,
    Started   = 2,
    Stopping  = 3, // Unused
    Stopped   = 4
  }

  export const enum MethodType {
    Interpreted,
    Native,
    Compiled
  }

  export function getMethodTypeName(methodType: MethodType) {
    return (<any>J2ME).MethodType[methodType];
  }

  var hashMap = Object.create(null);

  var hashArray = new Int32Array(1024);

  function hashString(s: string) {
    if (hashArray.length < s.length) {
      hashArray = new Int32Array((hashArray.length * 2 / 3) | 0);
    }
    var data = hashArray;
    for (var i = 0; i < s.length; i++) {
      data[i] = s.charCodeAt(i);
    }
    var hash = HashUtilities.hashBytesTo32BitsMurmur(data, 0, s.length);

    if (!release) { // Check to see that no collisions have ever happened.
      if (hashMap[hash] && hashMap[hash] !== s) {
        assert(false, "Collision detected!!!")
      }
      hashMap[hash] = s;
    }

    return hash;
  }

  export function hashUTF8String(s: Uint8Array): number {
    var hash = HashUtilities.hashBytesTo32BitsMurmur(s, 0, s.length);
    if (!release) { // Check to see that no collisions have ever happened.
      if (hashMap[hash] && hashMap[hash] !== s) {
        assert(false, "Collision detected in hashUTF8String!!!")
      }
      hashMap[hash] = s;
    }

    return hash;
  }

  function isIdentifierChar(c: number): boolean {
    return (c >= 97   && c <= 122)   || // a .. z
           (c >= 65   && c <=  90)   || // A .. Z
           (c === 36) || (c === 95);    // $ && _
  }

  function isDigit(c: number): boolean {
    return c >= 48 && c <= 57;
  }

  function needsEscaping(s: string): boolean {
    var l = s.length;
    for (var i = 0; i < l; i++) {
      var c = s.charCodeAt(i);
      if (!isIdentifierChar(c)) {
        return true;
      }
    }
    return false;
  }

  // Fast lookup table.
  var map = new Array(128);
  for (var i = 0; i < 128; i++) {
    map[i] = String.fromCharCode(i);
  }

  // Patch up some entries.
  var invalidChars = "[];/<>()";
  var replaceChars = "abc_defg";
  for (var i = 0; i < invalidChars.length; i++) {
    map[invalidChars.charCodeAt(i)] = replaceChars[i];
  }

  // Reuse array.
  var T = new Array(1024);

  export function escapeString(s: string): string {
    if (!needsEscaping(s)) {
      return s;
    }
    var l = s.length;
    var r = T;
    r.length = l;
    for (var i = 0; i < l; i++) {
      var c = s.charCodeAt(i);
      if (i === 0 && isDigit(c)) {
        r[i] = String.fromCharCode(c - 48 + 97); // Map 0 .. 9 to a .. j
      } else if (c < 128) {
        r[i] = map[c]
      } else {
        r[i] = s[i];
      }
    }
    return r.join("");
  }

  var stringHashes = Object.create(null);
  var stringHashCount = 0;

  function hashStringStrong(s): string {
    // Hash with Murmur hash.
    var result = StringUtilities.variableLengthEncodeInt32(hashString(s));
    // Also use the length for some more precision.
    result += StringUtilities.toEncoding(s.length & 0x3f);
    return result;
  }

  export function hashStringToString(s: string) {
    if (stringHashCount > 1024) {
      return hashStringStrong(s);
    }
    var c = stringHashes[s];
    if (c) {
      return c;
    }
    c = stringHashes[s] = hashStringStrong(s);
    stringHashCount ++;
    return c;
  }

  /**
   * This class is abstract and should never be initialized. It only acts as a template for
   * actual runtime objects.
   */
  export class RuntimeTemplate {
    static all = new Set();

    jvm: JVM;
    status: RuntimeStatus;
    waiting: any [];
    threadCount: number;
    initialized: Int8Array;
    staticObjectAddresses: Int32Array;
    classObjectAddresses: Int32Array;

    I: Int8Array; // Compiler alias for initialized
    SA: Int32Array; // Compiler alias for staticObjectAddresses
    CO: Int32Array; // Compiler alias for classObjectAddresses

    ctx: Context;
    allCtxs: Set<Context>;

    isolateId: number;
    isolateAddress: number;
    priority: number = ISOLATE_NORM_PRIORITY;
    // XXX Rename mainThread to mainThreadAddress so it's clearly an address.
    mainThread: number;

    private static _nextRuntimeId: number = 0;
    private _runtimeId: number;
    private _nextHashCode: number;

    constructor(jvm: JVM) {
      this.jvm = jvm;
      this.status = RuntimeStatus.New;
      this.waiting = [];
      this.threadCount = 0;
      this.I = this.initialized = new Int8Array(Constants.MAX_CLASS_ID);
      this.SA = this.staticObjectAddresses = new Int32Array(Constants.INITIAL_MAX_CLASS_ID + 1);
      this.CO = this.classObjectAddresses = new Int32Array(Constants.INITIAL_MAX_CLASS_ID + 1);
      this.ctx = null;
      this.allCtxs = new Set();
      this._runtimeId = RuntimeTemplate._nextRuntimeId++;
      this._nextHashCode = (this._runtimeId << 24) | 1; // Increase by one so the first hashcode isn't zero.
      // GC(20260922-gc1)：登记到全局存活表，供根集合采集遍历
      liveRuntimes.push(this);
    }

    preInitializeClasses(ctx: Context) {
      var prevCtx = $ ? $.ctx : null;
      var preInit = CLASSES.preInitializedClasses;
      ctx.setAsCurrentContext();
      for (var i = 0; i < preInit.length; i++) {
        preemptionLockLevel++;
        var classInfo = preInit[i];
        classInitCheck(classInfo);
        release || Debug.assert(!U, "Unexpected unwind during preInitializeClasses.");
        preemptionLockLevel-- ;
      }
      ctx.clearCurrentContext();
      if (prevCtx) {
        prevCtx.setAsCurrentContext();
      }
    }

    /**
     * After class initialization is finished the init9 method will invoke this so
     * any further initialize calls can be avoided. This isn't set on the first call
     * to a class initializer because there can be multiple calls into initialize from
     * different threads that need trigger the Class.initialize() code so they block.
     */
    setClassInitialized(classId: number) {
      this.initialized[classId] = 1;
    }

    getClassObjectAddress(classInfo: ClassInfo): number {
      var id = classInfo.id;
      if (!this.classObjectAddresses[classInfo.id]) {
        var addr = allocUncollectableObject(CLASSES.java_lang_Class);
        var handle = <java.lang.Class>getHandle(addr);
        handle.vmClass = id;
        // Ensure that maps are large enough.
        this.SA = this.staticObjectAddresses = ArrayUtilities.ensureInt32ArrayLength(this.staticObjectAddresses, id + 1);
        this.CO = this.classObjectAddresses = ArrayUtilities.ensureInt32ArrayLength(this.classObjectAddresses, id + 1);
        this.classObjectAddresses[id] = addr;
        this.staticObjectAddresses[id] = gcMallocUncollectable(J2ME.Constants.OBJ_HDR_SIZE + classInfo.sizeOfStaticFields);
        linkWriter && linkWriter.writeLn("Initializing Class Object For: " + classInfo.getClassNameSlow());
        if (classInfo === CLASSES.java_lang_Object ||
            classInfo === CLASSES.java_lang_Class ||
            classInfo === CLASSES.java_lang_String ||
            classInfo === CLASSES.java_lang_Thread) {
          handle.status = 4;
          this.setClassInitialized(id);
        }
      }
      return this.classObjectAddresses[id];
    }

    /**
     * Generates a new hash code for the specified |object|.
     */
    nextHashCode(): number {
      return this._nextHashCode ++;
    }

    waitStatus(callback) {
      this.waiting.push(callback);
    }

    updateStatus(status: RuntimeStatus) {
      this.status = status;
      var waiting = this.waiting;
      this.waiting = [];
      waiting.forEach(function (callback) {
        try {
          callback();
        } catch (ex) {
          // If the callback calls Runtime.prototype.waitStatus to continue waiting,
          // then waitStatus will throw VM.Pause, which shouldn't propagate up to
          // the caller of Runtime.prototype.updateStatus, so we silently ignore it
          // (along with any other exceptions thrown by the callback, so they don't
          // propagate to the caller of updateStatus).
        }
      });
    }

    addContext(ctx) {
      ++this.threadCount;
      RuntimeTemplate.all.add(this);
      this.allCtxs.add(ctx);
    }

    removeContext(ctx) {
      if (!--this.threadCount) {
        RuntimeTemplate.all.delete(this);
        this.updateStatus(RuntimeStatus.Stopped);
      }
      this.allCtxs.delete(ctx);
    }

    newStringConstant(utf16ArrayAddr: number): number {
      var utf16Array = getArrayFromAddr(utf16ArrayAddr);
      var javaStringAddr = internedStrings.get(utf16Array);
      if (javaStringAddr !== null) {
        return javaStringAddr;
      }

      setUncollectable(utf16ArrayAddr);

      // It's ok to create and intern an object here, because we only return it
      // to ConstantPool.resolve, which itself is only called by a few callers,
      // which should be able to convert it into an address if needed.  But we
      // should confirm that all callers of ConstantPool.resolve really do that.
      javaStringAddr = allocUncollectableObject(CLASSES.java_lang_String);
      var javaString = <java.lang.String>getHandle(javaStringAddr);
      javaString.value = utf16ArrayAddr;
      javaString.offset = 0;
      javaString.count = utf16Array.length;
      internedStrings.put(utf16Array, javaStringAddr);

      unsetUncollectable(utf16ArrayAddr);

      return javaStringAddr;
    }

    newIOException(str?: string): java.io.IOException {
      return <java.io.IOException>$.ctx.createException(
        "java/io/IOException", str);
    }

    newUnsupportedEncodingException(str?: string): java.io.UnsupportedEncodingException {
      return <java.io.UnsupportedEncodingException>$.ctx.createException(
        "java/io/UnsupportedEncodingException", str);
    }

    newUTFDataFormatException(str?: string): java.io.UTFDataFormatException {
      return <java.io.UTFDataFormatException>$.ctx.createException(
        "java/io/UTFDataFormatException", str);
    }

    newSecurityException(str?: string): java.lang.SecurityException {
      return <java.lang.SecurityException>$.ctx.createException(
        "java/lang/SecurityException", str);
    }

    newIllegalThreadStateException(str?: string): java.lang.IllegalThreadStateException {
      return <java.lang.IllegalThreadStateException>$.ctx.createException(
        "java/lang/IllegalThreadStateException", str);
    }

    newRuntimeException(str?: string): java.lang.RuntimeException {
      return <java.lang.RuntimeException>$.ctx.createException(
        "java/lang/RuntimeException", str);
    }

    newIndexOutOfBoundsException(str?: string): java.lang.IndexOutOfBoundsException {
      return <java.lang.IndexOutOfBoundsException>$.ctx.createException(
        "java/lang/IndexOutOfBoundsException", str);
    }

    newArrayIndexOutOfBoundsException(str?: string): java.lang.ArrayIndexOutOfBoundsException {
      return <java.lang.ArrayIndexOutOfBoundsException>$.ctx.createException(
        "java/lang/ArrayIndexOutOfBoundsException", str);
    }

    newStringIndexOutOfBoundsException(str?: string): java.lang.StringIndexOutOfBoundsException {
      return <java.lang.StringIndexOutOfBoundsException>$.ctx.createException(
        "java/lang/StringIndexOutOfBoundsException", str);
    }

    newArrayStoreException(str?: string): java.lang.ArrayStoreException {
      return <java.lang.ArrayStoreException>$.ctx.createException(
        "java/lang/ArrayStoreException", str);
    }

    newIllegalMonitorStateException(str?: string): java.lang.IllegalMonitorStateException {
      return <java.lang.IllegalMonitorStateException>$.ctx.createException(
        "java/lang/IllegalMonitorStateException", str);
    }

    newClassCastException(str?: string): java.lang.ClassCastException {
      return <java.lang.ClassCastException>$.ctx.createException(
        "java/lang/ClassCastException", str);
    }

    newArithmeticException(str?: string): java.lang.ArithmeticException {
      return <java.lang.ArithmeticException>$.ctx.createException(
        "java/lang/ArithmeticException", str);
    }

    newClassNotFoundException(str?: string): java.lang.ClassNotFoundException {
      return <java.lang.ClassNotFoundException>$.ctx.createException(
        "java/lang/ClassNotFoundException", str);
    }

    newIllegalArgumentException(str?: string): java.lang.IllegalArgumentException {
      return <java.lang.IllegalArgumentException>$.ctx.createException(
        "java/lang/IllegalArgumentException", str);
    }

    newIllegalStateException(str?: string): java.lang.IllegalStateException {
      return <java.lang.IllegalStateException>$.ctx.createException(
        "java/lang/IllegalStateException", str);
    }

    newNegativeArraySizeException(str?: string): java.lang.NegativeArraySizeException {
      return <java.lang.NegativeArraySizeException>$.ctx.createException(
        "java/lang/NegativeArraySizeException", str);
    }

    newNullPointerException(str?: string): java.lang.NullPointerException {
      return <java.lang.NullPointerException>$.ctx.createException(
        "java/lang/NullPointerException", str);
    }

    newMediaException(str?: string): javax.microedition.media.MediaException {
      return <javax.microedition.media.MediaException>$.ctx.createException(
        "javax/microedition/media/MediaException", str);
    }

    newInstantiationException(str?: string): java.lang.InstantiationException {
      return <java.lang.InstantiationException>$.ctx.createException(
        "java/lang/InstantiationException", str);
    }

    newException(str?: string): java.lang.Exception {
      return <java.lang.Exception>$.ctx.createException(
        "java/lang/Exception", str);
    }

    static classInfoComplete(classInfo: ClassInfo) {
      if (phase !== ExecutionPhase.Runtime) {
        return;
      }

      if (!classInfo.isInterface) {
        // Pre-allocate linkedVTableMap.
        ensureDenseObjectMapLength(linkedVTableMap, classInfo.id + 1);
        ensureDenseObjectMapLength(flatLinkedVTableMap, (classInfo.id + 1) << Constants.LOG_MAX_FLAT_VTABLE_SIZE);
        linkedVTableMap[classInfo.id] = ArrayUtilities.makeDenseArray(classInfo.vTable.length, null);
      }
    }
  }

  export const enum VMState {
    Running = 0,
    Yielding = 1,
    Pausing = 2,
    Stopping = 3
  }

  export function getVMStateName(vmState: VMState): string {
    return (<any>J2ME).VMState[vmState];
  }

  export const enum Constants {
    BYTE_MIN = -128,
    BYTE_MAX = 127,
    SHORT_MIN = -32768,
    SHORT_MAX = 32767,
    CHAR_MIN = 0,
    CHAR_MAX = 65535,
    INT_MIN = -2147483648,
    INT_MAX =  2147483647,

    LONG_MAX_LOW = 0xFFFFFFFF,
    LONG_MAX_HIGH = 0x7FFFFFFF,

    LONG_MIN_LOW = 0,
    LONG_MIN_HIGH = 0x80000000,

    // PATCH(j2me-nx-port): 上游为 FirefoxOS 手机设的 4KB 线程栈太小（约 20~40 层
    // Java 帧），深递归/长调用链游戏会写穿 bump 堆（assert 只在日志里喊一声不拦截）。
    // Switch 内存充裕，提到 32KB；每线程常驻 32KB，游戏通常 <10 线程，代价可忽略。
    MAX_STACK_SIZE = 32 * 1024,

    TWO_PWR_32_DBL = 4294967296,
    TWO_PWR_63_DBL = 9223372036854776000,

    // The size in bytes of the header in the memory allocated to the object.
    OBJ_HDR_SIZE = 8,

    // The offset in bytes from the beginning of the allocated memory
    // to the location of the class id.
    OBJ_CLASS_ID_OFFSET = 0,
    // The offset in bytes from the beginning of the allocated memory
    // to the location of the hash code.
    HASH_CODE_OFFSET = 4,

    ARRAY_HDR_SIZE = 8,

    ARRAY_LENGTH_OFFSET = 4,
    NULL = 0,

    // PATCH(j2me-nx-port): 上游 16383/4095 的 method/class id 上限是老机器容量假设，
    // 超限只有 release 断言（当前 release=false 会刷日志且不拦截，initialized 标记
    // Int8Array 越界写静默丢弃 → 类重复初始化）。J2ME 方法上限 64KB，这里给足余量。
    MAX_METHOD_ID = 65535,
    INITIAL_MAX_METHOD_ID = 511,

    MAX_CLASS_ID = 32767,
    INITIAL_MAX_CLASS_ID = 511,

    // PATCH(j2me-nx-port): 6→7，平坦虚表快速路径从 64 槽扩到 128 槽。
    // >64 个虚方法的类（混淆器常见）此前每次虚调用都走 GLVM 慢路径查表。
    LOG_MAX_FLAT_VTABLE_SIZE = 7 // 128
  }

  export class Runtime extends RuntimeTemplate {
    private static _nextId: number = 0;
    id: number;
    /**
     * Bailout callback whenever a JIT frame is unwound.
     */
    B(methodId: number, pc: number, lockObjectAddress: number) {
      var methodInfo = methodIdToMethodInfoMap[methodId];
      var localCount = methodInfo.codeAttribute.max_locals;
      var argumentCount = 3;
      // Figure out the |stackCount| from the number of arguments.
      var stackCount = arguments.length - argumentCount - localCount;
      // TODO: use specialized $.B functions based on the local and stack size so we don't have to use the arguments variable.
      var bailoutFrameAddress = createBailoutFrame(methodId, pc, localCount, stackCount, lockObjectAddress);
      for (var j = 0; j < localCount; j++) {
        i32[(bailoutFrameAddress + BailoutFrameLayout.HeaderSize >> 2) + j] = arguments[argumentCount + j];
      }
      for (var j = 0; j < stackCount; j++) {
        i32[(bailoutFrameAddress + BailoutFrameLayout.HeaderSize >> 2) + j + localCount] = arguments[argumentCount + localCount + j];
      }
      this.ctx.bailout(bailoutFrameAddress);
    }

    yield(reason: string) {
      unwindCount ++;
      threadWriter && threadWriter.writeLn("yielding " + reason);
      runtimeCounter && runtimeCounter.count("yielding " + reason);
      U = VMState.Yielding;
      profile && $.ctx.pauseMethodTimeline();
      this.ctx.nativeThread.beginUnwind();
    }

    nativeBailout(returnKind: Kind, opCode?: Bytecode.Bytecodes) {
      var pc = returnKind === Kind.Void ? 0 : 1;
      var methodInfo = CLASSES.getUnwindMethodInfo(returnKind, opCode);
      var bailoutFrameAddress = createBailoutFrame(methodInfo.id, pc, 0, 0, Constants.NULL);
      this.ctx.bailout(bailoutFrameAddress);
    }

    pause(reason: string) {
      unwindCount ++;
      threadWriter && threadWriter.writeLn("pausing " + reason);
      runtimeCounter && runtimeCounter.count("pausing " + reason);
      U = VMState.Pausing;
      profile && $.ctx.pauseMethodTimeline();
      this.ctx.nativeThread.beginUnwind();
    }

    stop() {
      U = VMState.Stopping;
    }

    constructor(jvm: JVM) {
      super(jvm);
      this.id = Runtime._nextId ++;
    }
  }

  export var classIdToClassInfoMap = [];
  export var methodIdToMethodInfoMap = [];
  export var linkedMethods = [];

  function ensureDenseObjectMapLength(array: Array<Object>, length: number) {
    while (array.length < length) {
      array.push(null);
    }
    release || Debug.assertNonDictionaryModeObject(array);
  }

  export function registerClassId(classId: number, classInfo: ClassInfo) {
    release || assert(phase === ExecutionPhase.Compiler || classId <= Constants.MAX_CLASS_ID, "Maximum class id was exceeded, " + classId);
    ensureDenseObjectMapLength(classIdToClassInfoMap, classId + 1);
    classIdToClassInfoMap[classId] = classInfo;
  }

  export function registerMethodId(methodId: number, methodInfo: MethodInfo) {
    release || assert(phase === ExecutionPhase.Compiler || methodId <= Constants.MAX_METHOD_ID, "Maximum method id was exceeded, " + methodId);
    ensureDenseObjectMapLength(methodIdToMethodInfoMap, methodId + 1);
    ensureDenseObjectMapLength(linkedMethods, methodId + 1);
    methodIdToMethodInfoMap[methodId] = methodInfo;
  }

  /**
   * Maps classIds to vTables containing JS functions.
   */
  export var linkedVTableMap = [];

  /**
   * Flat map of classId and vTableIndex to JS functions. This allows the compiler to
   * emit a single memory load to lookup a vTable entry
   *  flatLinkedVTableMap[classId << LOG_MAX_FLAT_VTABLE_SIZE + vTableIndex]
   * instead of the slower more general
   *  linkedVTableMap[classId][vTableIndex]
   */
  export var flatLinkedVTableMap = [];

  export function getClassInfo(addr: number) {
    release || assert(addr !== Constants.NULL, "addr !== Constants.NULL");
    release || assert(i32[addr + Constants.OBJ_CLASS_ID_OFFSET >> 2] != 0,
                      "i32[addr + Constants.OBJ_CLASS_ID_OFFSET >> 2] != 0");
    return classIdToClassInfoMap[i32[addr + Constants.OBJ_CLASS_ID_OFFSET >> 2]];
  }

  /**
   * A map from addresses to monitors, which are JS objects that we use to track
   * the lock state of Java objects.
   *
   * In most cases, we create the JS objects via Object.create(null), but we use
   * java.lang.Class objects for classes, since those continue to be represented
   * by JS objects in the runtime.  We also overload this map to retrieve those
   * class objects for other purposes.
   *
   * XXX Consider storing lock state in the ASM heap.
   */
  export var monitorMap = Object.create(null);

  // XXX Figure out correct return type(s).
  export function getMonitor(ref: number): Lock {
    release || assert(typeof ref === "number", "monitor reference is a number");

    var hash = i32[ref + Constants.HASH_CODE_OFFSET >> 2];
    if (hash === Constants.NULL) {
      hash = i32[ref + Constants.HASH_CODE_OFFSET >> 2] = $.nextHashCode()
    }

    return monitorMap[hash] || (monitorMap[hash] = new Lock(Constants.NULL, 0));
  }

  /**
   * Representation of a Java class with JS object.
   */
  export interface Handle extends Function {
    new (address?: number): java.lang.Object;

    _address: number;
    classInfo: ClassInfo;
  }

  export class Lock {
    ready: Context [];
    waiting: Context [];

    constructor(public threadAddress: number, public level: number) {
      this.ready = [];
      this.waiting = [];
    }
  }

  function findNativeMethodBinding(methodInfo: MethodInfo) {
    var classBindings = BindingsMap.get(methodInfo.classInfo.utf8Name);
    if (classBindings && classBindings.native) {
      var method = classBindings.native[methodInfo.name + "." + methodInfo.signature];
      if (method) {
        return method;
      }
    }
    return null;
  }

  function reportError(method, key) {
    return function() {
      try {
        return method.apply(this, arguments);
      } catch (e) {
        // Filter JAVA exception and only report the native js exception, which
        // cannnot be handled properly by the JAVA code.
        if (!e.classInfo) {
          stderrWriter.errorLn("Native " + key + " throws: " + e);
        }
        throw e;
      }
    };
  }

  function findNativeMethodImplementation(methodInfo: MethodInfo) {
    // Look in bindings first.
    var binding = findNativeMethodBinding(methodInfo);
    if (binding) {
      return release ? binding : reportError(binding, methodInfo.implKey);
    }
    if (methodInfo.isNative) {
      var implKey = methodInfo.implKey;
      if (implKey in Native) {
        return release ? Native[implKey] : reportError(Native[implKey], implKey);
      } else {
        // Some Native MethodInfos are constructed but never called;
        // that's fine, unless we actually try to call them.
        return function missingImplementation() {
          stderrWriter.errorLn("implKey " + implKey + " is native but does not have an implementation.");
        }
      }
    }
    return null;
  }

  var frameView = new FrameView();

  function findCompiledMethod(methodInfo: MethodInfo): Function {
    return;
    // Use aotMetaData to find AOT methods instead of jsGlobal because runtime compiled methods may
    // be on the jsGlobal.
    //var mangledClassAndMethodName = methodInfo.mangledClassAndMethodName;
    //if (aotMetaData[mangledClassAndMethodName]) {
    //  aotMethodCount++;
    //  methodInfo.onStackReplacementEntryPoints = aotMetaData[methodInfo.mangledClassAndMethodName].osr;
    //  release || assert(jsGlobal[mangledClassAndMethodName], "function must be present when aotMetaData exists");
    //  return jsGlobal[mangledClassAndMethodName];
    //}
    //if (enableCompiledMethodCache) {
    //  var cachedMethod;
    //  if ((cachedMethod = CompiledMethodCache.get(methodInfo.implKey))) {
    //    cachedMethodCount ++;
    //    linkMethod(methodInfo, cachedMethod.source, cachedMethod.referencedClasses, cachedMethod.onStackReplacementEntryPoints);
    //  }
    //}
    //
    //return jsGlobal[mangledClassAndMethodName];
  }

  /**
   * Creates convenience getters / setters on Java objects.
   */
  function linkHandleFields(handleConstructor, classInfo: ClassInfo) {
    // Get all the parent classes so their fields are linked first.
    var classes = [classInfo];
    var superClass = classInfo.superClass;
    while (superClass) {
      classes.unshift(superClass);
      superClass = superClass.superClass;
    }
    for (var i = 0; i < classes.length; i++) {
      var classInfo = classes[i];
      var classBindings = BindingsMap.get(classInfo.utf8Name);
      if (classBindings && classBindings.fields) {
        release || assert(!classBindings.fields.staticSymbols, "Static fields are not supported yet");

        var instanceSymbols = classBindings.fields.instanceSymbols;

        for (var fieldName in instanceSymbols) {
          var fieldSignature = instanceSymbols[fieldName];

          var field = classInfo.getFieldByName(toUTF8(fieldName), toUTF8(fieldSignature), false);

          release || assert(!field.isStatic, "Static field was defined as instance in BindingsMap");
          var object = field.isStatic ? handleConstructor : handleConstructor.prototype;
          release || assert(!object.hasOwnProperty(fieldName), "Should not overwrite existing properties.");
          var getter;
          var setter;
          if (true || release) {
            switch (field.kind) {
              case Kind.Reference:
                setter = new Function("value", "i32[this._address + " + field.byteOffset + " >> 2] = value;");
                getter = new Function("return i32[this._address + " + field.byteOffset + " >> 2];");
                break;
              case Kind.Boolean:
                setter = new Function("value", "i32[this._address + " + field.byteOffset + " >> 2] = value ? 1 : 0;");
                getter = new Function("return i32[this._address + " + field.byteOffset + " >> 2];");
                break;
              case Kind.Byte:
              case Kind.Short:
              case Kind.Int:
                setter = new Function("value", "i32[this._address + " + field.byteOffset + " >> 2] = value;");
                getter = new Function("return i32[this._address + " + field.byteOffset + " >> 2];");
                break;
              case Kind.Float:
                setter = new Function("value", "f32[this._address + " + field.byteOffset + " >> 2] = value;");
                getter = new Function("return f32[this._address + " + field.byteOffset + " >> 2];");
                break;
              case Kind.Long:
                setter = new Function("value",
                  "i32[this._address + " + field.byteOffset + " >> 2] = J2ME.returnLongValue(value);" +
                  "i32[this._address + " + field.byteOffset + " + 4 >> 2] = tempReturn0;");
                getter = new Function("return J2ME.longToNumber(i32[this._address + " + field.byteOffset + " >> 2]," +
                  "                         i32[this._address + " + field.byteOffset + " + 4 >> 2]);");
                break;
              case Kind.Double:
                setter = new Function("value",
                  "aliasedF64[0] = value;" +
                  "i32[this._address + " + field.byteOffset + " >> 2] = aliasedI32[0];" +
                  "i32[this._address + " + field.byteOffset + " + 4 >> 2] = aliasedI32[1];");
                getter = new Function("aliasedI32[0] = i32[this._address + " + field.byteOffset + " >> 2];" +
                  "aliasedI32[1] = i32[this._address + " + field.byteOffset + " + 4 >> 2];" +
                  "return aliasedF64[0];");
                break;
              default:
                Debug.assert(false, getKindName(field.kind));
                break;
            }
          } else {
            setter = FunctionUtilities.makeDebugForwardingSetter(field.mangledName, getKindCheck(field.kind));
          }
          Object.defineProperty(object, fieldName, {
            get: getter,
            set: setter,
            configurable: true,
            enumerable: false
          });
        }
      }
    }
  }

  function profilingWrapper(fn: Function, methodInfo: MethodInfo, methodType: MethodType) {
    if (methodType === MethodType.Interpreted) {
      // Profiling for interpreted functions is handled by the context.
      return fn;
    }
    var code;
    if (methodInfo.isNative) {
      if (methodInfo.returnKind === Kind.Void) {
        code = new Uint8Array([Bytecode.Bytecodes.RETURN]);
      } else if (isTwoSlot(methodInfo.returnKind)) {
        code = new Uint8Array([Bytecode.Bytecodes.LRETURN]);
      } else {
        code = new Uint8Array([Bytecode.Bytecodes.IRETURN]);
      }
    }


    return function (a, b, c, d) {
      var key = methodInfo.implKey;
      try {
        var ctx = $.ctx;
        ctx.enterMethodTimeline(key, methodType);
        var r;
        switch (arguments.length) {
          case 0:
            r = fn.call(this);
            break;
          case 1:
            r = fn.call(this, a);
            break;
          case 2:
            r = fn.call(this, a, b);
            break;
          case 3:
            r = fn.call(this, a, b, c);
            break;
          default:
            r = fn.apply(this, arguments);
        }
        if (U) {
          release || assert(ctx.paused, "context is paused");

          if (methodInfo.isNative) {
            // A fake frame that just returns is pushed so when the ctx resumes from the unwind
            // the frame will be popped triggering a leaveMethodTimeline.
            //REDUX
            //var fauxFrame = Frame.create(null, []);
            //fauxFrame.methodInfo = methodInfo;
            //fauxFrame.code = code;
            //ctx.bailoutFrames.unshift(fauxFrame);
          }
        } else {
          ctx.leaveMethodTimeline(key, methodType);
        }
      } catch (e) {
        ctx.leaveMethodTimeline(key, methodType);
        throw e;
      }
      return r;
    };
  }

  function tracingWrapper(fn: Function, methodInfo: MethodInfo, methodType: MethodType) {
    var wrapper = function() {
      // jsGlobal.getBacktrace && traceWriter.writeLn(jsGlobal.getBacktrace());
      var args = Array.prototype.slice.apply(arguments);
      traceWriter.enter("> " + getMethodTypeName(methodType)[0] + " " + methodInfo.implKey);
      var s = performance.now();
      try {
        var value = fn.apply(this, args);
      } catch (e) {
        traceWriter.leave("< " + getMethodTypeName(methodType)[0] + " Throwing");
        throw e;
      }
      traceWriter.leave("< " + getMethodTypeName(methodType)[0] + " " + methodInfo.implKey);
      return value;
    };
    (<any>wrapper).methodInfo = methodInfo;
    return wrapper;
  }

  export function getLinkedMethod(methodInfo: MethodInfo) {
    if (methodInfo.fn) {
      return methodInfo.fn;
    }
    linkMethod(methodInfo);
    release || assert (methodInfo.fn, "bad fn in getLinkedMethod");
    return methodInfo.fn;
  }

  export function getLinkedMethodById(methodId: number) {
    return getLinkedMethod(methodIdToMethodInfoMap[methodId]);
  }

  export function getLinkedVirtualMethodById(classId: number, vTableIndex: number) {
    var methodInfo = classIdToClassInfoMap[classId].vTable[vTableIndex];
    var fn = getLinkedMethod(methodInfo);
    // Only cache compiled methods in the |linkedVTableMap| and |flatLinkedVTableMap|.
    if (methodInfo.state === MethodState.Compiled) {
      var vTable = linkedVTableMap[classId];
      release || Debug.assertNonDictionaryModeObject(vTable);
      vTable[vTableIndex] = fn;
      // Only cache methods in the |flatLinkedVTableMap| if there is room.
      if (vTableIndex < (1 << Constants.LOG_MAX_FLAT_VTABLE_SIZE)) {
        release || Debug.assertNonDictionaryModeObject(flatLinkedVTableMap);
        flatLinkedVTableMap[(classId << Constants.LOG_MAX_FLAT_VTABLE_SIZE) + vTableIndex] = fn;
      }
    }
    return fn;
  }

  function linkMethod(methodInfo: MethodInfo) {
    runtimeCounter && runtimeCounter.count("linkMethod");
    var fn;
    var methodType;
    var nativeMethod = findNativeMethodImplementation(methodInfo);
    if (nativeMethod) {
      linkWriter && linkWriter.writeLn("Method: " + methodInfo.name + methodInfo.signature + " -> Native");
      fn = nativeMethod;
      methodType = MethodType.Native;
      methodInfo.state = MethodState.Compiled;
    } else {
      fn = findCompiledMethod(methodInfo);
      if (fn) {
        linkWriter && linkWriter.greenLn("Method: " + methodInfo.name + methodInfo.signature + " -> Compiled");
        methodType = MethodType.Compiled;
        methodInfo.state = MethodState.Compiled;
      } else {
        linkWriter && linkWriter.warnLn("Method: " + methodInfo.name + methodInfo.signature + " -> Interpreter");
        methodType = MethodType.Interpreted;
        fn = prepareInterpretedMethod(methodInfo);
      }
    }
    linkMethodFunction(methodInfo, fn, methodType);
  }

  /**
   * Number of methods that have been compiled thus far.
   */
  export var compiledMethodCount = 0;

  /**
   * Maximum number of methods to compile.
   */
  export var maxCompiledMethodCount = -1;

  /**
   * Number of methods that have not been compiled thus far.
   */
  export var notCompiledMethodCount = 0;

  /**
   * Number of methods that have been loaded from the code cache thus far.
   */
  export var cachedMethodCount = 0;

  /**
   * Number of methods that have been loaded from ahead of time compiled code thus far.
   */
  export var aotMethodCount = 0;

  /**
   * Number of ms that have been spent compiled code thus far.
   */
  var totalJITTime = 0;

  // PATCH(j2me-nx-port): 编译预算节流——1540osr 实机数据：JIT 同步编译持续整场
  // （763 个 × 30~84ms ≈ 34s 摊在 2.5 分钟里），新场景推进时一帧内叠多个编译
  // 造成 10fps 卡顿段。限制每 1000ms 墙钟最多 80ms 编译时间，超出则推迟：
  // 方法保持 Cold，调用/回边计数继续增长，下个预算窗口再编（不丢编译机会）。
  // 1550budget 实机：菜单段 60fps 达标，但比赛场景新热方法排队等编译期间继续
  // 被解释（vm 仍 90%）。因此推迟改为进 pending 队列，由 app/main.js 的 present
  // 循环每帧调用 drainCompileQueue(6ms) 在帧间隙消化（≈360ms/s，摊得更细更快）。
  var compileBudgetWindowStart = 0;
  var compileBudgetUsed = 0;
  var compileDrainDepth = 0;

  var pendingCompiles: MethodInfo [] = [];
  var pendingCompileSet: any = {};

  /**
   * PATCH(perfZ34)：**只排队、不编译**的编译请求入口。
   *
   * 由来（实机事故）：perfZ33 的"热点定向编译"是**在解释器内部同步调用**
   * `compileAndLinkMethod` 的（采样钩子跑在 interpretBody 的热路径上，每 10s 触发一次、
   * 一次最多 8 个方法）—— 等于在游戏帧中间做 8 次 Relooper 代码生成，既造成长停顿，
   * 也在紧档（V8 堆上限 ~404MB、Java 堆 RAB 只有 32MB）下把 V8 推到大分配失败的那条路上
   * （历史上"自己退出"就是这个形态：日志没有任何 [exit] 行就断掉）。
   * 现在改成：热点榜只把方法**排进既有队列**，真正的编译一律由宿主在场间隙
   * `drainCompileQueue(6)` 里做（那里有 maxMs 上限、一次一个、天然错开游戏帧）。
   */
  export function requestCompile(methodInfo: MethodInfo): void {
    if (!enableRuntimeCompilation || !methodInfo) {
      return;
    }
    if (methodInfo.state !== MethodState.Cold) {
      return;
    }
    // PATCH(perfZ35): 排队入口也要挡上限——否则队列里会堆一批"注定不会编"的方法，
    // 每帧 drain 反复 pop/push 白烧时间（实机日志里 待编译 一直是 0，就是因为 drain 很快，
    // 但上限没生效时队列会以另一种方式持续吃编译时间）。
    if (!jitCompileBudgetLeft()) {
      return;
    }
    var pk = methodInfo.implKey;
    if (pendingCompileSet[pk]) {
      return;   // 已在队列里
    }
    pendingCompileSet[pk] = true;
    pendingCompiles.push(methodInfo);
  }

  // PATCH(perfZ35): 编译上限判定（供编译入口与排队入口共用）。
  var jitCapLogged = false;
  function jitCompileBudgetLeft(): boolean {
    var cap = ConfigThresholds.JitCompileCap | 0;
    if (cap <= 0) return true;                       // 0/负数 = 不限制（off 档本来就不编）
    if (compiledMethodCount < cap) return true;
    if (!jitCapLogged) {
      jitCapLogged = true;
      if (jsGlobal && jsGlobal.__sdMark) {
        jsGlobal.__sdMark("[jit-cap] 已达本会话编译上限 " + cap + " 个方法，停止编译" +
          "（已编译=" + compiledMethodCount + " 累计=" + totalJITTime.toFixed(0) + "ms）——" +
          "想多编请重开（或删掉 sdmc:/switch/j2me-nx/jit-big 彻底关掉 JIT）");
      }
    }
    return false;
  }

  // PATCH(perfZ35): 编译前后各留一条现场（含宿主探针的 V8 堆/原生内存数字）。
  // 由来：perfZ32~Z34 的静默退出后面总是紧跟着一次编译，但日志里看不到"编译当时的堆"，
  // 无法判断是不是编译期分配把运行时推下悬崖。宿主通过 jsGlobal.__jitMemProbe 提供数字。
  function jitMemProbeText(): string {
    try {
      if (jsGlobal && typeof jsGlobal.__jitMemProbe === "function") {
        var s = jsGlobal.__jitMemProbe();
        return s ? " " + s : "";
      }
    } catch (eProbe) { /* 探针故障不干扰编译 */ }
    return "";
  }

  export function pendingCompileCount(): number {
    return pendingCompiles.length;
  }

  // PATCH(perfZ35): 还剩几个编译名额（-1 = 不限制）。给 int.ts 的热点采样器判"该不该再排队"。
  export function jitCompileRemaining(): number {
    var cap = ConfigThresholds.JitCompileCap | 0;
    if (cap <= 0) return -1;
    return cap - compiledMethodCount;
  }

  function compileBudgetAvailable(): boolean {
    // 帧间隙 drain 上下文自带 maxMs 上限，不受秒级预算限制
    if (compileDrainDepth > 0) {
      return true;
    }
    var now = performance.now();
    if (now - compileBudgetWindowStart >= 1000) {
      compileBudgetWindowStart = now;
      compileBudgetUsed = 0;
    }
    return compileBudgetUsed < 80;
  }

  /**
   * PATCH(j2me-nx-port): 在帧间隙（present 循环）消化待编译队列。
   * maxMs 为本次调用的编译时间上限；返回剩余队列长度（0=已清空）。
   * LIFO 弹出：最新触发的（最热的）方法优先编译。
   */
  export function drainCompileQueue(maxMs: number): number {
    if (!enableRuntimeCompilation) {
      return 0;
    }
    var start = performance.now();
    compileDrainDepth++;
    try {
      while (pendingCompiles.length > 0 && performance.now() - start < maxMs) {
        var mi = pendingCompiles.pop();
        if (!mi || mi.state >= MethodState.Compiled || mi.state === MethodState.CannotCompile) {
          continue;
        }
        try {
          compileAndLinkMethod(mi);
        } catch (e) {
          // 与解释器路径同待遇：单方法编译失败不拖垮 drain 循环
        }
      }
    } finally {
      compileDrainDepth--;
    }
    return pendingCompiles.length;
  }

  /**
   * Compiles method and links it up at runtime.
   */
  export function compileAndLinkMethod(methodInfo: MethodInfo) {
    if (!enableRuntimeCompilation) {
      return;
    }

    // Don't do anything if we're past the compiled state.
    if (methodInfo.state >= MethodState.Compiled) {
      return;
    }

    // Don't compile if we've compiled too many methods.
    if (maxCompiledMethodCount >= 0 && compiledMethodCount >= maxCompiledMethodCount) {
      return;
    }
    // PATCH(perfZ35): 本会话硬上限（唯一总闸）——所有触发路径都过这里。
    if (!config.forceRuntimeCompilation && !jitCompileBudgetLeft()) {
      return;
    }
    // PATCH(perfZ35): tier=big 只编 ≥512B 的方法（其余交给采样器按热点决定）。
    if (ConfigThresholds.JitBigOnly && !config.forceRuntimeCompilation &&
        methodInfo.codeAttribute && methodInfo.codeAttribute.code.length < 512) {
      return;
    }
    // Don't compile methods that are too large.
    // 2026-09-22 法拉利GT3 根因：上游 4000 字节上限把最热渲染方法
    // a.e(IIIIII)V（4524 字节）拒之门外 → 终生走解释器 → 重场景 8~14fps。
    // J2ME 方法上限 64KB，16000 足以覆盖所有性能关键的大方法。
    if (methodInfo.codeAttribute.code.length > 16000 && !config.forceRuntimeCompilation) {
      jitWriter && jitWriter.writeLn("Not compiling: " + methodInfo.implKey + " because it's too large. " + methodInfo.codeAttribute.code.length);
      methodInfo.state = MethodState.NotCompiled;
      notCompiledMethodCount ++;
      if (jsGlobal && jsGlobal.__sdMark) {
        jsGlobal.__sdMark("[jit-skip] " + methodInfo.implKey + " size=" + methodInfo.codeAttribute.code.length);
      }
      return;
    }

    if (enableCompiledMethodCache) {
      var cachedMethod;
      if (cachedMethod = CompiledMethodCache.get(methodInfo.implKey)) {
        cachedMethodCount ++;
        jitWriter && jitWriter.writeLn("Retrieved " + methodInfo.implKey + " from compiled method cache");

        var referencedClasses = [];
        // Ensure referenced classes are loaded.
        // We only need to do this for cached methods, since referenced classes
        // get loaded automatically during JIT compilation.
        for (var i = 0; i < cachedMethod.referencedClasses.length; i++) {
          referencedClasses.push(CLASSES.getClass(cachedMethod.referencedClasses[i]));
        }
        linkMethodSource(methodInfo, cachedMethod.args, cachedMethod.body, referencedClasses, cachedMethod.onStackReplacementEntryPoints);
        return;
      }
    }

    var mangledClassAndMethodName = methodInfo.mangledClassAndMethodName;

    // PATCH(j2me-nx-port): 编译预算门（forceRuntimeCompilation 直编工具豁免）；
    // 推迟改为进 pending 队列，由 present 帧间隙 drainCompileQueue 消化
    if (!config.forceRuntimeCompilation && !compileBudgetAvailable()) {
      var pk = methodInfo.implKey;
      if (!pendingCompileSet[pk]) {
        pendingCompileSet[pk] = true;
        pendingCompiles.push(methodInfo);
      }
      return;
    }

    // PATCH(j2me-nx-port): 大方法编译尝试探针——确认 compileAndLinkMethod 真被
    // 调用及当时的计数状态。放在预算门之后：预算推迟会反复重入，只记真正要编的。
    if (jsGlobal && jsGlobal.__sdMark && methodInfo.codeAttribute &&
        methodInfo.codeAttribute.code.length >= 2000) {
      jsGlobal.__sdMark("[jit-try] " + methodInfo.implKey +
        " st=" + methodInfo.state +
        " calls=" + methodInfo.stats.interpreterCallCount +
        " bb=" + methodInfo.stats.backwardsBranchCount +
        " size=" + methodInfo.codeAttribute.code.length);
    }

    // PATCH(perfZ35): 编译前现场（含宿主探针）。静默退出前的最后一次编译就是嫌疑点，
    // 所以这里必须留下"编的是谁、多大、当时堆多少"。
    var jitPreProbe = jitMemProbeText();
    if (jsGlobal && jsGlobal.__sdMark) {
      jsGlobal.__sdMark("[jit-pre] #" + (compiledMethodCount + 1) + " " + methodInfo.implKey +
        " size=" + (methodInfo.codeAttribute ? methodInfo.codeAttribute.code.length : -1) +
        " calls=" + methodInfo.stats.interpreterCallCount +
        " bb=" + methodInfo.stats.backwardsBranchCount + jitPreProbe);
    }

    jitWriter && jitWriter.enter("Compiling: " + compiledMethodCount + " " + methodInfo.implKey + ", interpreterCallCount: " + methodInfo.stats.interpreterCallCount + " backwardsBranchCount: " + methodInfo.stats.backwardsBranchCount + " currentBytecodeCount: " + methodInfo.stats.bytecodeCount);
    var s = performance.now();

    var compiledMethod;
    enterTimeline("Compiling");
    try {
      compiledMethod = baselineCompileMethod(methodInfo, enableCompiledMethodCache ? CompilationTarget.Static : CompilationTarget.Runtime);
      compiledMethodCount ++;
    } catch (e) {
      methodInfo.state = MethodState.CannotCompile;
      jitWriter && jitWriter.writeLn("Cannot compile: " + methodInfo.implKey + " because of " + e);
      if (jsGlobal && jsGlobal.__sdMark) {
        jsGlobal.__sdMark("[jit-fail] " + methodInfo.implKey + " :: " + (e && e.message || e));
      }
      leaveTimeline("Compiling");
      return;
    }
    leaveTimeline("Compiling");
    if (codeWriter) {
      codeWriter.writeLn("// Method: " + methodInfo.implKey);
      codeWriter.writeLn("// Arguments: " + compiledMethod.args.join(", "));
      codeWriter.writeLn("// Referenced Classes: ");
      for (var i = 0; i < compiledMethod.referencedClasses.length; i++) {
        codeWriter.writeLn("// " + i + ": " + compiledMethod.referencedClasses[i].getClassNameSlow());
      }
      codeWriter.writeLns(compiledMethod.body)
    }

    if (enableCompiledMethodCache) {
      CompiledMethodCache.put({
        key: methodInfo.implKey,
        args: compiledMethod.args,
        body: compiledMethod.body,
        referencedClasses: compiledMethod.referencedClasses.map(function(v) { return v.getClassNameSlow() }),
        onStackReplacementEntryPoints: compiledMethod.onStackReplacementEntryPoints
      });
    }

    linkMethodSource(methodInfo, compiledMethod.args, compiledMethod.body, compiledMethod.referencedClasses, compiledMethod.onStackReplacementEntryPoints);
    var methodJITTime = (performance.now() - s);
    totalJITTime += methodJITTime;
    // PATCH(perfZ32b)：把编译开销挂到全局，供宿主心跳量化"JIT 值不值"（编译毫秒 vs 帧率收益）。
    if (jsGlobal) {
      jsGlobal.__jitCompileMs = (jsGlobal.__jitCompileMs || 0) + methodJITTime;
      jsGlobal.__jitCompileN = compiledMethodCount;
    }
    // PATCH(j2me-nx-port): 编译计费（与预算门配套；失败编译同样计费——它们也是卡顿源）；
    // 成功/失败都从 pending 集合摘除标记
    compileBudgetUsed += methodJITTime;
    delete pendingCompileSet[methodInfo.implKey];
    // PATCH(j2me-nx-port): JIT 编译可观测性——慢编译（>30ms）与前 3 次编译逐条落盘；
    // 100/500/1000 里程碑报总量（防启动编译风暴无感知）。
    if (jsGlobal && jsGlobal.__sdMark) {
      if (methodJITTime > 30 || compiledMethodCount <= 3) {
        jsGlobal.__sdMark("[jit] #" + compiledMethodCount + " " + methodInfo.implKey + " " + methodJITTime.toFixed(1) + "ms codeSize=" + methodInfo.codeAttribute.code.length);
      }
      // PATCH(perfZ35): 编译后现场 —— 与 [jit-pre] 成对，一眼看出这次编译吃掉了多少堆。
      jsGlobal.__sdMark("[jit-post] #" + compiledMethodCount + " " + methodInfo.implKey +
        " " + methodJITTime.toFixed(1) + "ms codeSize=" + methodInfo.codeAttribute.code.length +
        " 累计=" + totalJITTime.toFixed(0) + "ms" + jitMemProbeText());
      // PATCH(perfZ35): 单次编译超过 60ms 或方法超过 4KB 单独标一条（历史上出事的都在这一档）。
      if (methodJITTime > 60 || methodInfo.codeAttribute.code.length > 4000) {
        jsGlobal.__sdMark("[jit-heavy] " + methodInfo.implKey +
          " " + methodJITTime.toFixed(1) + "ms codeSize=" + methodInfo.codeAttribute.code.length +
          " calls=" + methodInfo.stats.interpreterCallCount + jitPreProbe);
      }
      if (compiledMethodCount === 100 || compiledMethodCount === 500 || compiledMethodCount === 1000) {
        jsGlobal.__sdMark("[jit] milestone=" + compiledMethodCount + " totalJITTime=" + totalJITTime.toFixed(0) + "ms");
      }
    }
    if (jitWriter) {
      jitWriter.leave(
        "Compilation Done: " + methodJITTime.toFixed(2) + " ms, " +
        "codeSize: " + methodInfo.codeAttribute.code.length + ", " +
        "sourceSize: " + compiledMethod.body.length);
      jitWriter.writeLn("Total: " + totalJITTime.toFixed(2) + " ms");
    }
  }

  function wrapMethod(fn, methodInfo: MethodInfo, methodType: MethodType) {
    if (profile) {
      fn = profilingWrapper(fn, methodInfo, methodType);
    }

    if (traceWriter) {
      fn = tracingWrapper(fn, methodInfo, methodType);
    }
    return fn;
  }

  function linkMethodFunction(methodInfo: MethodInfo, fn: Function, methodType: MethodType) {
    if (profile || traceWriter) {
      fn = wrapMethod(fn, methodInfo, methodType);
    }

    methodInfo.fn = fn;
    linkedMethods[methodInfo.id] = fn;
  }

  // Make sure class and method symbol references can be parsed as identifiers. This allows closure and other tools
  // to process this code as JS files.
  export var classInfoSymbolPrefix =  "$C"; // "$C123
  export var methodInfoSymbolPrefix = "$M"; // "$M123_456
  var classInfoSymbolPrefixPattern =  /\$C(\d+)/g;
  var methodInfoSymbolPrefixPattern = /\$M(\d+)_(\d+)/g;

  /**
   * Enable this if you want your profiles to have nice function names. Naming eval'ed functions
   * using: |new Function("return function displayName {}");| can cause performance problems and
   * we keep it disabled by default.
   */
  var nameJITFunctions = false;

  /**
   * Links up compiled method at runtime.
   */
  export function linkMethodSource(methodInfo: MethodInfo, args: string[], body: string, referencedClasses: ClassInfo [], onStackReplacementEntryPoints: any) {
    jitWriter && jitWriter.writeLn("Link method: " + methodInfo.implKey);
    // TODO: Don't use RegExp ever ever.
    // Patch class and method symbols in relocatable code.
    body = body.replace(classInfoSymbolPrefixPattern, <any>function (match, symbol) {
      // jitWriter && jitWriter.writeLn("Linking Class Symbol: " + symbol + " to " + referencedClasses[symbol]);
      return referencedClasses[symbol].id;
    }).replace(methodInfoSymbolPrefixPattern, <any>function (match, symbol, index) {
      // jitWriter && jitWriter.writeLn("Linking Method Symbol: " + symbol + ":" + index + " to " + referencedClasses[symbol].getMethodByIndex(index));
      return referencedClasses[symbol].getMethodByIndex(index).id;
    });
    enterTimeline("Eval Compiled Code");
    // This overwrites the method on the global object.

    var fn = null;
    // PATCH(j2me-nx-port): 链接失败时把 body 抛给宿主（jsGlobal.__jitDump），
    // Node 调试工具据此落盘分析。正式运行无副作用。
    try {
      if (!release || nameJITFunctions) {
        fn = new Function("return function fn_" + methodInfo.implKey.replace(/\W+/g, "_") + "(" + args.join(",") + "){ " + body + "}")();
      } else {
        fn = new Function(args.join(','), body);
      }
    } catch (linkError) {
      if (jsGlobal) {
        jsGlobal.__jitDump = { key: methodInfo.implKey, body: body, err: String(linkError) };
      }
      throw linkError;
    }

    leaveTimeline("Eval Compiled Code");

    methodInfo.state = MethodState.Compiled;
    methodInfo.onStackReplacementEntryPoints = onStackReplacementEntryPoints;

    linkMethodFunction(methodInfo, fn, MethodType.Compiled);
  }

  export function isAssignableTo(from: ClassInfo, to: ClassInfo): boolean {
    return from.isAssignableTo(to);
  }

  export function instanceOfKlass(objectAddr: number, classId: number): boolean {
    release || assert(typeof classId === "number", "Class id must be a number.");
    return objectAddr !== Constants.NULL && isAssignableTo(classIdToClassInfoMap[i32[objectAddr + Constants.OBJ_CLASS_ID_OFFSET >> 2]], classIdToClassInfoMap[classId]);
  }

  export function instanceOfInterface(objectAddr: number, classId: number): boolean {
    release || assert(typeof classId === "number", "Class id must be a number.");
    release || assert(classIdToClassInfoMap[classId].isInterface, "instanceOfInterface called on non interface");
    return objectAddr !== Constants.NULL && isAssignableTo(classIdToClassInfoMap[i32[objectAddr + Constants.OBJ_CLASS_ID_OFFSET >> 2]], classIdToClassInfoMap[classId]);
  }

  export function checkCastKlass(objectAddr: number, classId: number) {
    release || assert(typeof classId === "number", "Class id must be a number.");
    if (objectAddr !== Constants.NULL && !isAssignableTo(classIdToClassInfoMap[i32[objectAddr + Constants.OBJ_CLASS_ID_OFFSET >> 2]], classIdToClassInfoMap[classId])) {
       throw $.newClassCastException();
     }
   }

  export function checkCastInterface(objectAddr: number, classId: number) {
    if (objectAddr !== Constants.NULL && !isAssignableTo(classIdToClassInfoMap[i32[objectAddr + Constants.OBJ_CLASS_ID_OFFSET >> 2]], classIdToClassInfoMap[classId])) {
      throw $.newClassCastException();
    }
  }

  var handleConstructors = Object.create(null);

  // PROBE(20260922-allocprobe)：分配热点普查（方案2）。native-heap 是永不回收
  // 的 bump 分配器，jheap 涨速 = Java 垃圾产出率（格斗之王3 实测 ≈1MB/s，撑满
  // 上限即 OOM）。本探针在三个带类信息的分配入口按类累计字节，宿主 main.js
  // 心跳（10s）取走 Top-N 并清零，从而定位高分配率游戏的垃圾来源。
  // 状态挂 jsGlobal.__allocProbe（跨 bundle 重求值存活），类名按 classInfo.id
  // 缓存（getClassNameSlow 慢，只允许每类调一次）。探针绝不能抛异常。
  function probeAlloc(classInfo: ClassInfo, bytes: number): void {
    try {
      var p = jsGlobal.__allocProbe;
      if (!p) {
        p = jsGlobal.__allocProbe = { byName: Object.create(null), cache: Object.create(null), windowTotal: 0 };
      }
      var id = classInfo.id;
      var name = p.cache[id];
      if (name === undefined) {
        name = classInfo.getClassNameSlow();
        // 原始数组类名是 [B/[C/[I 风格，转成可读名
        if (name.length === 2 && name.charAt(0) === "[") {
          name = ({ "[Z": "boolean[]", "[B": "byte[]", "[C": "char[]", "[S": "short[]",
                    "[I": "int[]", "[J": "long[]", "[F": "float[]", "[D": "double[]" })[name] || name;
        }
        p.cache[id] = name;
      }
      p.byName[name] = (p.byName[name] | 0) + bytes;
      p.windowTotal += bytes;
    } catch (e) { /* 探针故障不干扰游戏 */ }
  }

  export function allocUncollectableObject(classInfo: ClassInfo): number {
    var size = Constants.OBJ_HDR_SIZE + classInfo.sizeOfFields;
    probeAlloc(classInfo, size);
    var address = gcMallocUncollectable(size);
    i32[address >> 2] = classInfo.id | 0;
    return address;
  }

  export function allocObject(classInfo: ClassInfo): number {
    var size = Constants.OBJ_HDR_SIZE + classInfo.sizeOfFields;
    probeAlloc(classInfo, size);
    var address = gcMalloc(size);
    i32[address >> 2] = classInfo.id | 0;
    return address;
  }

  // PROBE：JIT baseline 把 NEWARRAY 内联成 gcMallocAtomic 直连（别名 MA），
  // 完全绕过 newArray——首次探针实测该路径承担了游戏的全部大流量分配
  // （[alloc] 窗口 0.00MB 但 jheap 1MB/s）。JIT 发射改为 PA(bytes, classId)
  // 走本函数：按类记账后照旧 gcMallocAtomic。
  export function probeArrayAlloc(bytes: number, classId: number): number {
    var classInfo = classIdToClassInfoMap[classId];
    if (classInfo) {
      probeAlloc(classInfo, bytes);
    }
    // perfE：JIT 发射的 NEWARRAY 都是基本类型数组（对象数组走 NA/NM→newArray）。
    // 仍显式校验一次类型，防止将来把对象数组接到这条路上（对象数组必须保守扫）。
    if (classInfo && classInfo instanceof PrimitiveArrayClassInfo) {
      return gcMallocAtomicNoScan(bytes);
    }
    return ASM._gcMallocAtomic(bytes);
  }

  // ------------------------------------------------------------------
  // GC(20260922-gc1)：安全点式保守 mark-sweep。native-heap.js 执行标记/
  // 清扫/自由表，本侧只负责根集合采集——在 scheduler 的 ctx.execute() 返回
  // 后调用（此时所有线程帧已同步进堆：解释器帧在 threadData、JIT 帧在
  // preempt 时物化的 bailout 帧，全部位于 ASM 堆内），JS 栈上无 Java 引用
  // 在途，根集合完备。
  // 根来源：
  //   1. 每线程已用栈区间 [tp, sp<<2)（保守逐字扫描）
  //   2. 每类静态字段块（SA）+ java/lang/Class 实例（CO）
  //   3. internedStrings 值、NativeMap 键（native peer 永活）
  //   4. uncollectable 块（threadData/bailout 帧等）由 native-heap 侧
  //      以 perm 标记永久保留并保守扫描内容
  // ------------------------------------------------------------------
  export var liveRuntimes: any [] = [];

  export function collectGarbage(addRoot: (addr: number) => void, addRootRange: (b0: number, b1: number) => void): void {
    for (var ri = 0; ri < liveRuntimes.length; ri++) {
      var r = liveRuntimes[ri];
      try {
        // 静态字段块（保守扫整块）
        var sa = r.staticObjectAddresses;
        for (var id = 0; id < sa.length; id++) {
          var sAddr = sa[id];
          if (sAddr) {
            var ci = classIdToClassInfoMap[id];
            if (ci) {
              addRootRange(sAddr, sAddr + Constants.OBJ_HDR_SIZE + ci.sizeOfStaticFields);
            }
          }
        }
        // java/lang/Class 实例
        var co = r.classObjectAddresses;
        for (var id2 = 0; id2 < co.length; id2++) {
          if (co[id2]) addRoot(co[id2]);
        }
        // 线程已用栈区间（帧数据全在此；保守逐字扫描）
        r.allCtxs.forEach(function (ctx) {
          try {
            var t = ctx.nativeThread;
            var end = t.sp << 2;
            var maxEnd = t.tp + Constants.MAX_STACK_SIZE;
            if (end > maxEnd) end = maxEnd;
            if (end > t.tp) addRootRange(t.tp, end);
            // gc5：挂起线程的 pending bailout 帧是 JS 数组里的裸地址，
            // 保守扫描看不见，必须显式补根——否则 GC 会回收仍被引用的帧
            var pnf = ctx.pendingNativeFrames;
            if (pnf && pnf.length) {
              for (var pi = 0; pi < pnf.length; pi++) {
                if (pnf[pi]) addRoot(pnf[pi]);
              }
            }
          } catch (eCtx) { /* 单线程失败不影响整体 */ }
        });
      } catch (eR) { /* 单 runtime 失败不影响整体 */ }
    }
    // interned 字符串（值 = String 对象地址）
    try {
      var table = internedStrings.table;
      for (var bi = 0; bi < table.length; bi++) {
        for (var e = table[bi]; e !== null; e = e.next) {
          if (e.value) addRoot(e.value);
        }
      }
    } catch (eI) { /* 忽略 */ }
    // native peer（按键地址保活）
    try {
      NativeMap.forEach(function (v: any, key: number) {
        addRoot(key);
      });
    } catch (eN) { /* 忽略 */ }
  }

  export function getFreeMemory(): number {
    // PATCH(j2me-nx-port): 上游按 asmJsTotalMemory(64MB) 算 free，但本移植的
    // native-heap.js 实际堆是 128MB 起步 + RAB 自适应扩容——64MB-用量甚至会算出
    // 负数。改为读真实 buffer 容量（随 RAB 扩容自动更新）。
    return ASM.buffer.byteLength - ASM._getUsedHeapSize();
  }

  export function onFinalize(addr: number): void {
    NativeMap.delete(addr);
  }

  export const enum BailoutFrameLayout {
    MethodIdOffset = 0,
    PCOffset = 4,
    LocalCountOffset = 8,
    StackCountOffset = 12,
    LockOffset = 16,
    HeaderSize = 20
  }

  export function createBailoutFrame(methodId: number, pc: number, localCount: number, stackCount: number, lockObjectAddress: number): number {
    var address = gcMallocUncollectable(BailoutFrameLayout.HeaderSize + ((localCount + stackCount) << 2));
    release || assert(typeof methodId === "number" && methodIdToMethodInfoMap[methodId], "Must be valid method info.");
    i32[address + BailoutFrameLayout.MethodIdOffset >> 2] = methodId;
    i32[address + BailoutFrameLayout.PCOffset >> 2] = pc;
    i32[address + BailoutFrameLayout.LocalCountOffset >> 2] = localCount;
    i32[address + BailoutFrameLayout.StackCountOffset >> 2] = stackCount;
    i32[address + BailoutFrameLayout.LockOffset >> 2] = lockObjectAddress;
    return address;
  }

  /**
   * A map from Java object addresses to native objects.
   *
   * Currently this only supports mapping an address to a single native.
   * Will we ever want to map multiple natives to an address?  If so, we'll need
   * to do something more sophisticated here.
   */
  export var NativeMap = new Map<number,Object>();

  export function setNative(addr: number, obj: Object): void {
    NativeMap.set(addr, obj);
    ASM._registerFinalizer(addr);
  }

  /**
   * Get a handle for an object in the ASM heap.
   *
   * Currently, we implement this using JS constructors (i.e. Klass instances)
   * with a prototype chain that reflects the Java class hierarchy and getters/
   * setters for fields.
   */
  export function getHandle(address: number): java.lang.Object {
    if (address === Constants.NULL) {
      return null;
    }

    release || assert(typeof address === "number", "address is number");

    var classId = i32[address + Constants.OBJ_CLASS_ID_OFFSET >> 2];

    var classInfo = classIdToClassInfoMap[classId];
    release || assert(classInfo, "object has class info");
    release || assert(!classInfo.elementClass, "object isn't an array");

    if (!handleConstructors[classId]) {
      var constructor = function(address) {
        this._address = address;
      };
      constructor.prototype.classInfo = classInfo;
      // Link the field bindings.
      linkHandleFields(constructor, classInfo);
      handleConstructors[classId] = constructor;
    }
    return new handleConstructors[classId](address);
  }

  // TODO: TextEncoder('utf-16') was removed, this is some polyfil code,
  // but there probably is a faster way to do this.
  function encode_utf16(jsString: string, littleEndian: boolean) {
    let a = new Uint8Array(jsString.length * 2);
    let view = new DataView(a.buffer);
    jsString.split('').forEach(function(c, i) {
      view.setUint16(i * 2, c.charCodeAt(0), littleEndian);
    });
    return a;
  }

  export function newString(jsString: string): number {
    if (jsString === null || jsString === undefined) {
      return Constants.NULL;
    }

    var objectAddr = allocObject(CLASSES.java_lang_String);
    setUncollectable(objectAddr);
    var object = <java.lang.String>getHandle(objectAddr);

    var encoded = new Uint16Array(encode_utf16(jsString, true).buffer);
    var arrayAddr = newCharArray(encoded.length);
    u16.set(encoded, Constants.ARRAY_HDR_SIZE + arrayAddr >> 1);

    object.value = arrayAddr;
    object.offset = 0;
    object.count = encoded.length;
    unsetUncollectable(objectAddr);
    return objectAddr;
  }

  export function getArrayFromAddr(addr: number) {
    if (addr === Constants.NULL) {
      return null;
    }

    release || assert(typeof addr === "number", "addr is number");
    var classInfo = classIdToClassInfoMap[i32[addr + Constants.OBJ_CLASS_ID_OFFSET >> 2]];
    var constructor;
    if (classInfo instanceof PrimitiveArrayClassInfo) {
      switch (classInfo) {
        case PrimitiveArrayClassInfo.Z:
          constructor = Uint8Array;
          break;
        case PrimitiveArrayClassInfo.C:
          constructor = Uint16Array;
          break;
        case PrimitiveArrayClassInfo.F:
          constructor = Float32Array;
          break;
        case PrimitiveArrayClassInfo.D:
          constructor = Float64Array;
          break;
        case PrimitiveArrayClassInfo.B:
          constructor = Int8Array;
          break;
        case PrimitiveArrayClassInfo.S:
          constructor = Int16Array;
          break;
        case PrimitiveArrayClassInfo.I:
          constructor = Int32Array;
          break;
        case PrimitiveArrayClassInfo.J:
          constructor = Int64Array;
          break;
        default:
          Debug.assertUnreachable("Bad primitive array" + classInfo.getClassNameSlow());
          break;
      }
    } else {
      constructor = Int32Array;
    }
    var arrayObject = new constructor(ASM.buffer, Constants.ARRAY_HDR_SIZE + addr, i32[addr + Constants.ARRAY_LENGTH_OFFSET >> 2]);
    arrayObject.classInfo = classInfo;
    return arrayObject;
  }

  var uncollectableMaxNumber = 16;
  var uncollectableAddress = gcMallocUncollectable(uncollectableMaxNumber << 2);
  export function setUncollectable(addr: number) {
    for (var i = 0; i < uncollectableMaxNumber; i++) {
      var address = (uncollectableAddress >> 2) + i;
      if (i32[address] === Constants.NULL) {
        i32[address] = addr;
        return;
      }
    }
    release || Debug.assertUnreachable("There must be a free slot.");
  }
  export function unsetUncollectable(addr: number) {
    for (var i = 0; i < uncollectableMaxNumber; i++) {
      var address = (uncollectableAddress >> 2) + i;
      if (i32[address] === addr) {
        i32[address] = Constants.NULL;
        return;
      }
    }
    release || Debug.assertUnreachable("The adddress was not found in the uncollectables.");
  }

  export function newArray(elementClassInfo: ClassInfo, size: number): number {
    release || assert(elementClassInfo instanceof ClassInfo, "elementClassInfo instanceof ClassInfo");
    if (size < 0) {
      throwNegativeArraySizeException();
    }

    var arrayClassInfo = CLASSES.getClass("[" + elementClassInfo.getClassNameSlow());
    var addr;
    var bytes;

    if (elementClassInfo instanceof PrimitiveClassInfo) {
      bytes = Constants.ARRAY_HDR_SIZE + size * (<PrimitiveArrayClassInfo>arrayClassInfo).bytesPerElement;
      // perfE：基本类型数组 payload 内不可能有引用 → NOSCAN 标记，GC mark 阶段免扫
      addr = gcMallocAtomicNoScan(bytes);
    } else {
      // We need to hold an integer to define the length of the array
      // and *size* references.
      bytes = Constants.ARRAY_HDR_SIZE + size * 4;
      addr = gcMalloc(bytes);
    }

    probeAlloc(arrayClassInfo, bytes);

    i32[addr + Constants.OBJ_CLASS_ID_OFFSET >> 2] = arrayClassInfo.id;
    i32[addr + Constants.ARRAY_LENGTH_OFFSET >> 2] = size;

    return addr;
  }

  export function newMultiArray(classInfo: ClassInfo, lengths: number[]): number {
    var length = lengths[0];
    var arrayAddr = newArray(classInfo.elementClass, length);
    if (lengths.length > 1) {
      setUncollectable(arrayAddr);

      lengths = lengths.slice(1);

      var start = (arrayAddr + Constants.ARRAY_HDR_SIZE >> 2);
      for (var i = start; i < start + length; i++) {
        i32[i] = newMultiArray(classInfo.elementClass, lengths);
      }

      unsetUncollectable(arrayAddr);
    }
    return arrayAddr;
  }

  export var JavaRuntimeException = function(message) {
    this.message = message;
  };

  JavaRuntimeException.prototype = Object.create(Error.prototype);
  JavaRuntimeException.prototype.name = "JavaRuntimeException";
  JavaRuntimeException.prototype.constructor = JavaRuntimeException;

  export function throwNegativeArraySizeException() {
    throw $.newNegativeArraySizeException();
  }

  export function throwNullPointerException() {
    throw $.newNullPointerException();
  }

  export function newObjectArray(size: number): number {
    return newArray(CLASSES.java_lang_Object, size);
  }

  export function newStringArray(size: number): number {
    return newArray(CLASSES.java_lang_String, size);
  }

  export function newByteArray(size: number): number {
    return newArray(PrimitiveClassInfo.B, size);
  }

  export function newCharArray(size: number): number {
    return newArray(PrimitiveClassInfo.C, size);
  }

  export function newIntArray(size: number): number {
    return newArray(PrimitiveClassInfo.I, size);
  }

  var jStringDecoder = new TextDecoder('utf-16');

  export function fromJavaChars(charsAddr, offset, count): string {
    release || assert(charsAddr !== Constants.NULL, "charsAddr !== Constants.NULL");

    var start = (Constants.ARRAY_HDR_SIZE + charsAddr >> 1) + offset;

    return jStringDecoder.decode(u16.subarray(start, start + count));
  }

  export function fromStringAddr(stringAddr: number): string {
    if (stringAddr === Constants.NULL) {
      return null;
    }

    // XXX Retrieve the characters directly from memory, without indirecting
    // through getHandle.
    var javaString = <java.lang.String>getHandle(stringAddr);
    return fromJavaChars(javaString.value, javaString.offset, javaString.count);
  }

  export function checkDivideByZero(value: number) {
    if (value === 0) {
      throwArithmeticException();
    }
  }

  /**
   * Do bounds check using only one branch. The math works out because array.length
   * can't be larger than 2^31 - 1. So |index| >>> 0 will be larger than
   * array.length if it is less than zero. We need to make the right side unsigned
   * as well because otherwise the SM optimization that converts this to an
   * unsinged branch doesn't kick in.
   */
  export function checkArrayBounds(array: any [], index: number) {
    // XXX: This function is unused, should be updated if we're
    // ever going to use it
    if ((index >>> 0) >= (array.length >>> 0)) {
      throw $.newArrayIndexOutOfBoundsException(String(index));
    }
  }

  export function throwArrayIndexOutOfBoundsException(index: number) {
    throw $.newArrayIndexOutOfBoundsException(String(index));
  }

  export function throwArithmeticException() {
    throw $.newArithmeticException("/ by zero");
  }

  export function checkArrayStore(arrayAddr: number, valueAddr: number) {
    if (valueAddr === Constants.NULL) {
      return;
    }

    var arrayClassInfo = classIdToClassInfoMap[i32[arrayAddr + Constants.OBJ_CLASS_ID_OFFSET >> 2]];
    var valueClassInfo = classIdToClassInfoMap[i32[valueAddr + Constants.OBJ_CLASS_ID_OFFSET >> 2]];

    if (!isAssignableTo(valueClassInfo, arrayClassInfo.elementClass)) {
      throw $.newArrayStoreException();
    }
  }

  export function checkNull(object: java.lang.Object) {
    if (!object) {
      throw $.newNullPointerException();
    }
  }

  export class ConfigThresholds {
    static InvokeThreshold = config.invokeThreshold;
    // PATCH(j2me-nx-port): ≥512 字节大方法的调用阈值（config/switch.js 可配）
    static InvokeThresholdBig = typeof config.invokeThresholdBig === "number" ? config.invokeThresholdBig : config.invokeThreshold;
    static BackwardBranchThreshold = config.backwardBranchThreshold;
    // PATCH(perfZ32): 热点定向编译的每榜条数（0=关）。见 int.ts 的 maybeCompileHotspots：
    // 不看方法大小，只编译采样器实测出来的热点方法 —— 专治"热点方法小于 512B、
    // 大方法档碰不到它"这类游戏（UFO Afterlight 的 PointFont.DrawChar）。
    static HotspotCompileLimit = typeof config.hotspotCompileLimit === "number" ? config.hotspotCompileLimit : 0;
    // PATCH(perfZ35): **全会话编译方法数硬上限**（config/switch.js 按档位/内存档给值）。
    // 由来（实机事故复核，见 PERF §42）：perfZ32~Z34 的 hot 档同时继承了 invokeThresholdBig=3，
    // 于是"任何 ≥512B 方法被调用 3 次就编译"——两分半钟编了 29 个方法（含 9KB 的 d.a.()V，
    // 单次 103ms），而脚本里写的"紧档每会话最多 8 个"只挡了采样器那条路，根本没管住解释器路径。
    // 现在把上限放在**编译入口**（compileAndLinkMethod）与**排队入口**（requestCompile）两处，
    // 无论请求来自解释器阈值、回边还是热点采样，都一起受管。
    static JitCompileCap = typeof config.jitCompileCap === "number" ? config.jitCompileCap : -1;
    // PATCH(perfZ35): tier=big 只编 ≥512B 的方法（默认 false = 不看大小，只按热点）。
    static JitBigOnly = !!(jsGlobal && jsGlobal.__jitBigOnly);
  }

  export function monitorEnter(lock: Lock) {
    $.ctx.monitorEnter(lock);
  }

  export function monitorExit(lock: Lock) {
    $.ctx.monitorExit(lock);
  }

  export function translateException(e) {
    if (e.name === "TypeError") {
      // JavaScript's TypeError is analogous to a NullPointerException.
      return $.newNullPointerException(e.message);
    } else if (e.name === "JavaRuntimeException") {
      return $.newRuntimeException(e.message);
    }
    return e;
  }

  export function classInitCheck(classInfo: ClassInfo) {
    if (classInfo instanceof ArrayClassInfo || $.initialized[classInfo.id]) {
      return;
    }

    // TODO: make this more efficient when we decide on how to invoke code.
    var thread = $.ctx.nativeThread;
    thread.pushMarkerFrame(FrameType.Interrupt);
    thread.pushMarkerFrame(FrameType.Native);
    var frameTypeOffset = thread.fp + FrameLayout.FrameTypeOffset;
    getLinkedMethod(CLASSES.java_lang_Class.getMethodByNameString("initialize", "()V"))($.getClassObjectAddress(classInfo));
    if (U) {
      i32[frameTypeOffset] = FrameType.PushPendingFrames;
      thread.nativeFrameCount--;
      thread.unwoundNativeFrames.push(null);
      return;
    }
    thread.popMarkerFrame(FrameType.Native);
    thread.popMarkerFrame(FrameType.Interrupt);
  }

  export function preempt() {
    if (Scheduler.shouldPreempt()) {
      $.yield("preemption");
    }
  }

  export class UnwindThrowLocation {
    static instance: UnwindThrowLocation = new UnwindThrowLocation();
    pc: number;
    sp: number;
    nextPC: number;
    constructor() {
      this.pc = 0;
      this.sp = 0;
      this.nextPC = 0;
    }
    setLocation(pc: number, nextPC: number, sp: number) {
      this.pc = pc;
      this.sp = sp;
      this.nextPC = nextPC;
      return this;
    }
    getPC() {
      return this.pc;
    }
    getSP() {
      return this.sp;
    }
  }

  /**
   * Helper methods used by the compiler.
   */

  /**
   * Generic unwind throw.
   */
  export function throwUnwind(pc: number, nextPC: number = pc + 3, sp: number = 0) {
    throw UnwindThrowLocation.instance.setLocation(pc, nextPC, sp);
  }

  /**
   * Unwind throws with different stack heights. This is useful so we can
   * save a few bytes encoding the stack height in the function name.
   */
  export function throwUnwind0(pc: number, nextPC: number = pc + 3) {
    throwUnwind(pc, nextPC, 0);
  }

  export function throwUnwind1(pc: number, nextPC: number = pc + 3) {
    throwUnwind(pc, nextPC, 1);
  }

  export function throwUnwind2(pc: number, nextPC: number = pc + 3) {
    throwUnwind(pc, nextPC, 2);
  }

  export function throwUnwind3(pc: number, nextPC: number = pc + 3) {
    throwUnwind(pc, nextPC, 3);
  }

  export function throwUnwind4(pc: number, nextPC: number = pc + 3) {
    throwUnwind(pc, nextPC, 4);
  }

  export function throwUnwind5(pc: number, nextPC: number = pc + 3) {
    throwUnwind(pc, nextPC, 5);
  }

  export function throwUnwind6(pc: number, nextPC: number = pc + 3) {
    throwUnwind(pc, nextPC, 6);
  }

  export function throwUnwind7(pc: number, nextPC: number = pc + 3) {
    throwUnwind(pc, nextPC, 7);
  }

  export function fadd(a: number, b: number): number {
    aliasedI32[0] = a;
    aliasedI32[1] = b;
    aliasedF32[2] = aliasedF32[0] + aliasedF32[1];
    return aliasedI32[2];
  }

  export function fsub(a: number, b: number): number {
    aliasedI32[0] = a;
    aliasedI32[1] = b;
    aliasedF32[2] = aliasedF32[0] - aliasedF32[1];
    return aliasedI32[2];
  }

  export function fmul(a: number, b: number): number {
    aliasedI32[0] = a;
    aliasedI32[1] = b;
    aliasedF32[2] = aliasedF32[0] * aliasedF32[1];
    return aliasedI32[2];
  }

  export function fdiv(a: number, b: number): number {
    aliasedI32[0] = a;
    aliasedI32[1] = b;
    aliasedF32[2] = Math.fround(aliasedF32[0] / aliasedF32[1]);
    return aliasedI32[2];
  }

  export function frem(a: number, b: number): number {
    aliasedI32[0] = a;
    aliasedI32[1] = b;
    aliasedF32[2] = Math.fround(aliasedF32[0] % aliasedF32[1]);
    return aliasedI32[2];
  }

  export function fcmp(a: number, b: number, isLessThan: boolean): number {
    var x = (aliasedI32[0] = a, aliasedF32[0]);
    var y = (aliasedI32[0] = b, aliasedF32[0]);
    if (x !== x || y !== y) {
      return isLessThan ? -1 : 1;
    } else if (x > y) {
      return 1;
    } else if (x < y) {
      return -1;
    } else {
      return 0;
    }
  }

  export function fneg(a: number): number {
    aliasedF32[0] = -(aliasedI32[0] = a, aliasedF32[0]);
    return aliasedI32[0];
  }

  export function dcmp(al: number, ah: number, bl: number, bh: number, isLessThan: boolean) {
    var x = (aliasedI32[0] = al, aliasedI32[1] = ah, aliasedF64[0]);
    var y = (aliasedI32[0] = bl, aliasedI32[1] = bh, aliasedF64[0]);
    if (x !== x || y !== y) {
      return isLessThan ? -1 : 1;
    } else if (x > y) {
      return 1;
    } else if (x < y) {
      return -1;
    } else {
      return 0;
    }
  }

  export function dadd(al: number, ah: number, bl: number, bh: number): number {
    aliasedF64[0] = (aliasedI32[0] = al, aliasedI32[1] = ah, aliasedF64[0]) +
                    (aliasedI32[0] = bl, aliasedI32[1] = bh, aliasedF64[0]);
    return (tempReturn0 = aliasedI32[1], aliasedI32[0]);
  }

  export function dsub(al: number, ah: number, bl: number, bh: number): number {
    aliasedF64[0] = (aliasedI32[0] = al, aliasedI32[1] = ah, aliasedF64[0]) -
                    (aliasedI32[0] = bl, aliasedI32[1] = bh, aliasedF64[0]);
    return (tempReturn0 = aliasedI32[1], aliasedI32[0]);
  }

  export function dmul(al: number, ah: number, bl: number, bh: number): number {
    aliasedF64[0] = (aliasedI32[0] = al, aliasedI32[1] = ah, aliasedF64[0]) *
                    (aliasedI32[0] = bl, aliasedI32[1] = bh, aliasedF64[0]);
    return (tempReturn0 = aliasedI32[1], aliasedI32[0]);
  }

  export function ddiv(al: number, ah: number, bl: number, bh: number): number {
    aliasedF64[0] = (aliasedI32[0] = al, aliasedI32[1] = ah, aliasedF64[0]) /
                    (aliasedI32[0] = bl, aliasedI32[1] = bh, aliasedF64[0]);
    return (tempReturn0 = aliasedI32[1], aliasedI32[0]);
  }

  export function drem(al: number, ah: number, bl: number, bh: number): number {
    aliasedF64[0] = (aliasedI32[0] = al, aliasedI32[1] = ah, aliasedF64[0]) %
                    (aliasedI32[0] = bl, aliasedI32[1] = bh, aliasedF64[0]);
    return (tempReturn0 = aliasedI32[1], aliasedI32[0]);
  }

  export function dneg(al: number, ah: number): number {
    aliasedF64[0] = - (aliasedI32[0] = al, aliasedI32[1] = ah, aliasedF64[0]);
    tempReturn0 = aliasedI32[1];
    return aliasedI32[0];
  }

  export function f2i(a: number): number {
    var x = (aliasedI32[0] = a, aliasedF32[0]);
    if (x > Constants.INT_MAX) {
      return Constants.INT_MAX;
    } else if (x < Constants.INT_MIN) {
      return Constants.INT_MIN;
    } else {
      return x | 0;
    }
  }

  export function d2i(al: number, ah: number): number {
    var x = (aliasedI32[0] = al, aliasedI32[1] = ah, aliasedF64[0]);
    if (x > Constants.INT_MAX) {
      return Constants.INT_MAX;
    } else if (x < Constants.INT_MIN) {
      return Constants.INT_MIN;
    } else {
      return x | 0;
    }
  }

  export function i2f(a: number): number {
    aliasedF32[0] = a;
    return aliasedI32[0];
  }

  export function i2d(a: number): number {
    aliasedF64[0] = a;
    tempReturn0 = aliasedI32[1];
    return aliasedI32[0];
  }

  export function l2d(al: number, ah: number): number {
    aliasedF64[0] = longToNumber(al, ah);
    tempReturn0 = aliasedI32[1];
    return aliasedI32[0];
  }

  export function l2f(al: number, ah: number): number {
    aliasedF32[0] = Math.fround(longToNumber(al, ah));
    return aliasedI32[0];
  }

  export function f2d(l: number): number {
    aliasedF64[0] = (aliasedI32[0] = l, aliasedF32[0]);
    tempReturn0 = aliasedI32[1];
    return aliasedI32[0];
  }

  export function f2l(l: number): number {
    var x = (aliasedI32[0] = l, aliasedF32[0]);
    return returnLongValue(x);
  }

  export function d2l(al: number, ah: number): number {
    var x = (aliasedI32[0] = al, aliasedI32[1] = ah, aliasedF64[0]);
    if (x === Number.POSITIVE_INFINITY) {
      tempReturn0 = Constants.LONG_MAX_HIGH;
      return Constants.LONG_MAX_LOW;
    } else if (x === Number.NEGATIVE_INFINITY) {
      tempReturn0 = Constants.LONG_MIN_HIGH;
      return Constants.LONG_MIN_LOW;
    } else {
      return returnLongValue(x);
    }
  }

  export function d2f(al: number, ah: number): number {
    var x = (aliasedI32[0] = al, aliasedI32[1] = ah, aliasedF64[0]);
    aliasedF32[0] = Math.fround(x);
    return aliasedI32[0];
  }

  export function gcMalloc(size: number): number {
    release || gcCounter.count("gcMalloc");
    return ASM._gcMalloc(size);
  }

  export function gcMallocAtomic(size: number): number {
    release || gcCounter.count("gcMallocAtomic");
    return ASM._gcMallocAtomic(size);
  }

  // perfE：基本类型数组专用分配（NOSCAN）。调用方必须先确认类型。
  export function gcMallocAtomicNoScan(size: number): number {
    release || gcCounter.count("gcMallocAtomicNoScan");
    return ASM._gcMallocAtomicNoScan(size);
  }

  export function gcMallocUncollectable(size: number): number {
    release || gcCounter.count("gcMallocUncollectable");
    return ASM._gcMallocUncollectable(size);
  }

  var tmpAddress = gcMallocUncollectable(32);

  export function lcmp(al: number, ah: number, bl: number, bh: number) {
    i32[tmpAddress +  0 >> 2] = al;
    i32[tmpAddress +  4 >> 2] = ah;
    i32[tmpAddress +  8 >> 2] = bl;
    i32[tmpAddress + 12 >> 2] = bh;
    ASM._lCmp(tmpAddress, tmpAddress, tmpAddress + 8);
    return i32[tmpAddress >> 2];
  }

  export function ladd(al: number, ah: number, bl: number, bh: number) {
    i32[tmpAddress +  0 >> 2] = al;
    i32[tmpAddress +  4 >> 2] = ah;
    i32[tmpAddress +  8 >> 2] = bl;
    i32[tmpAddress + 12 >> 2] = bh;
    ASM._lAdd(tmpAddress, tmpAddress, tmpAddress + 8);
    tempReturn0 = i32[tmpAddress + 4 >> 2];
    return i32[tmpAddress >> 2];
  }

  export function lsub(al: number, ah: number, bl: number, bh: number) {
    i32[tmpAddress +  0 >> 2] = al;
    i32[tmpAddress +  4 >> 2] = ah;
    i32[tmpAddress +  8 >> 2] = bl;
    i32[tmpAddress + 12 >> 2] = bh;
    ASM._lSub(tmpAddress, tmpAddress, tmpAddress + 8);
    tempReturn0 = i32[tmpAddress + 4 >> 2];
    return i32[tmpAddress >> 2];
  }

  export function lmul(al: number, ah: number, bl: number, bh: number) {
    i32[tmpAddress +  0 >> 2] = al;
    i32[tmpAddress +  4 >> 2] = ah;
    i32[tmpAddress +  8 >> 2] = bl;
    i32[tmpAddress + 12 >> 2] = bh;
    ASM._lMul(tmpAddress, tmpAddress, tmpAddress + 8);
    tempReturn0 = i32[tmpAddress + 4 >> 2];
    return i32[tmpAddress >> 2];
  }

  export function ldiv(al: number, ah: number, bl: number, bh: number) {
    i32[tmpAddress +  0 >> 2] = al;
    i32[tmpAddress +  4 >> 2] = ah;
    i32[tmpAddress +  8 >> 2] = bl;
    i32[tmpAddress + 12 >> 2] = bh;
    ASM._lDiv(tmpAddress, tmpAddress, tmpAddress + 8);
    tempReturn0 = i32[tmpAddress + 4 >> 2];
    return i32[tmpAddress >> 2];
  }

  export function lrem(al: number, ah: number, bl: number, bh: number) {
    i32[tmpAddress +  0 >> 2] = al;
    i32[tmpAddress +  4 >> 2] = ah;
    i32[tmpAddress +  8 >> 2] = bl;
    i32[tmpAddress + 12 >> 2] = bh;
    ASM._lRem(tmpAddress, tmpAddress, tmpAddress + 8);
    tempReturn0 = i32[tmpAddress + 4 >> 2];
    return i32[tmpAddress >> 2];
  }

  export function lneg(al: number, ah: number): number {
    i32[tmpAddress + 0 >> 2] = al;
    i32[tmpAddress + 4 >> 2] = ah;
    ASM._lNeg(tmpAddress, tmpAddress);
    tempReturn0 = i32[tmpAddress + 4 >> 2];
    return i32[tmpAddress >> 2];
  }

  export function lshl(al: number, ah: number, shift: number): number {
    i32[tmpAddress + 0 >> 2] = al;
    i32[tmpAddress + 4 >> 2] = ah;
    ASM._lShl(tmpAddress, tmpAddress, shift);
    tempReturn0 = i32[tmpAddress + 4 >> 2];
    return i32[tmpAddress >> 2];
  }

  export function lshr(al: number, ah: number, shift: number): number {
    i32[tmpAddress + 0 >> 2] = al;
    i32[tmpAddress + 4 >> 2] = ah;
    ASM._lShr(tmpAddress, tmpAddress, shift);
    tempReturn0 = i32[tmpAddress + 4 >> 2];
    return i32[tmpAddress >> 2];
  }

  export function lushr(al: number, ah: number, shift: number): number {
    i32[tmpAddress + 0 >> 2] = al;
    i32[tmpAddress + 4 >> 2] = ah;
    ASM._lUshr(tmpAddress, tmpAddress, shift);
    tempReturn0 = i32[tmpAddress + 4 >> 2];
    return i32[tmpAddress >> 2];
  }
}

var Runtime = J2ME.Runtime;

var AOTMD = J2ME.aotMetaData;

/**
 * Are we currently unwinding the stack because of a Yield? This technically
 * belonges to a context but we store it in the global object because it is
 * read very often.
 */
var U: J2ME.VMState = J2ME.VMState.Running;

// To enable breaking when it is set in Chrome, define it as a getter/setter:
// http://stackoverflow.com/questions/11618278/how-to-break-on-property-change-in-chrome
// var _U: J2ME.VMState = J2ME.VMState.Running;
// declare var U;
// Object.defineProperty(jsGlobal, 'U', {
//     get: function () {
//         return jsGlobal._U;
//     },
//     set: function (value) {
//         jsGlobal._U = value;
//     }
// });

// Several unwind throws for different stack heights.

var B0 = J2ME.throwUnwind0;
var B1 = J2ME.throwUnwind1;
var B2 = J2ME.throwUnwind2;
var B3 = J2ME.throwUnwind3;
var B4 = J2ME.throwUnwind4;
var B5 = J2ME.throwUnwind5;
var B6 = J2ME.throwUnwind6;
var B7 = J2ME.throwUnwind7;

/**
 * OSR Frame.
 */
// REDUX
var O: J2ME.MethodInfo = null;

/**
 * Runtime exports for compiled code.
 * DO NOT use these short names outside of compiled code.
 */

var CI = J2ME.classIdToClassInfoMap;
var MI = J2ME.methodIdToMethodInfoMap;
var LM = J2ME.linkedMethods;
var GLM = J2ME.getLinkedMethodById;
var GLVM = J2ME.getLinkedVirtualMethodById;
var VT = J2ME.linkedVTableMap;
var FT = J2ME.flatLinkedVTableMap;

var CIC = J2ME.classInitCheck;
var GH = J2ME.getHandle;
var AO = J2ME.allocObject;

var IOK = J2ME.instanceOfKlass;
var IOI = J2ME.instanceOfInterface;

var CCK = J2ME.checkCastKlass;
var CCI = J2ME.checkCastInterface;

//var AK = J2ME.getArrayKlass;

var NA = J2ME.newArray;
var NM = J2ME.newMultiArray;



var CAB = J2ME.checkArrayBounds;
var CAS = J2ME.checkArrayStore;

// XXX Ensure these work with new monitor objects.
var GM = J2ME.getMonitor;
var ME = J2ME.monitorEnter;
var MX = J2ME.monitorExit;

var TE = J2ME.translateException;
var TI = J2ME.throwArrayIndexOutOfBoundsException;
var TA = J2ME.throwArithmeticException;
var TS = J2ME.throwNegativeArraySizeException;
var TN = J2ME.throwNullPointerException;

var PE = J2ME.preempt;
var PS = 0; // Preemption samples.

var MA = J2ME.gcMallocAtomic;
var PA = J2ME.probeArrayAlloc; // PATCH(probe): JIT NEWARRAY 经此记账后分配

var fadd = J2ME.fadd;
var fsub = J2ME.fsub;
var fmul = J2ME.fmul;
var fdiv = J2ME.fdiv;
var frem = J2ME.frem;
var fneg = J2ME.fneg;

var f2i = J2ME.f2i;
var f2l = J2ME.f2l;
var f2d = J2ME.f2d;
var i2f = J2ME.i2f;
var i2d = J2ME.i2d;
var d2i = J2ME.d2i;
var d2l = J2ME.d2l;
var d2f = J2ME.d2f;
var l2f = J2ME.l2f;
var l2d = J2ME.l2d;
var fcmp = J2ME.fcmp;

var dneg = J2ME.dneg;
var dcmp = J2ME.dcmp;
var dadd = J2ME.dadd;
var dsub = J2ME.dsub;
var dmul = J2ME.dmul;
var ddiv = J2ME.ddiv;
var drem = J2ME.drem;

var lneg = J2ME.lneg;
var ladd = J2ME.ladd;
var lsub = J2ME.lsub;
var lmul = J2ME.lmul;
var ldiv = J2ME.ldiv;
var lrem = J2ME.lrem;
var lcmp = J2ME.lcmp;
var lshl = J2ME.lshl;
var lshr = J2ME.lshr;
var lushr = J2ME.lushr;

var getHandle = J2ME.getHandle;

var NativeMap = J2ME.NativeMap;
var setNative = J2ME.setNative;
