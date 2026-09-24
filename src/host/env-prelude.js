/*
 * env-prelude.js — 在所有 vendor 代码之前加载的浏览器环境 shim（nx.js 适配层，第 1 层）
 *
 * PluotSorbet 假定自己运行在 Gecko 浏览器页面里。本文件在全局作用域上
 * 构造它需要的最小浏览器表面。加载顺序：本文件 → ASM 堆 → vendor 配置 →
 * IDB shim → vendor bundle。
 *
 * 宿主钩子（由 app 入口注入）：
 *   __setCanvasFactory(fn)      fn(width, height) -> canvas 实例
 *   __setDisplayCanvas(canvas)  提供 id="canvas" 的显示画布
 *   __setResourceLoader(fn)     fn(path, responseType) -> Promise<ArrayBuffer|string|Blob>
 *                               用于 XHR shim；path 是 vendor 请求的相对路径
 *   __hostPipeMessage(envelope) DumbPipe 信封出口（alert 传输通道）
 */
'use strict';

/*
 * TextDecoder utf-16 兼容层。
 * nx.js 的 TextDecoder polyfill 只接受 "utf-8" 标签，而 PluotSorbet 的 VM
 * 顶层就有 `new TextDecoder('utf-16')`（vm/runtime.ts fromJavaChars 用，
 * 从 ASM 堆 u16 视图解 Java char[]）→ 实机一加载 j2me.js 就崩。
 * 这里只拦截 utf-16/utf-16le/utf-16be 标签手工解码，其余原样放行。
 * 数据来源是 u16.subarray（原生小端、无 BOM），与 WHATWG 'utf-16'（LE+BOM
 * 嗅探）语义一致；解出前剥掉可能存在的 U+FEFF。
 */
(function () {
  var g = typeof globalThis !== 'undefined' ? globalThis : this;
  var NativeTD = g.TextDecoder;
  if (typeof NativeTD !== 'function') return;

  function Utf16Decoder(label) {
    this._be = /utf-16be/i.test(String(label));
  }
  Utf16Decoder.prototype.decode = function (input) {
    if (!input) return '';
    var buf = input.buffer, off = input.byteOffset, len = input.byteLength;
    if (typeof buf !== 'object') { buf = input; off = 0; len = input.length * 2; }
    var bytes = new Uint8Array(buf, off, len);
    if (this._be) {
      var swapped = new Uint8Array(len);
      for (var i = 0; i + 1 < len; i += 2) {
        swapped[i] = bytes[i + 1];
        swapped[i + 1] = bytes[i];
      }
      bytes = swapped;
    }
    var u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    var out = '';
    var CHUNK = 0x8000; // fromCharCode 栈安全分块
    for (var j = 0; j < u16.length; j += CHUNK) {
      out += String.fromCharCode.apply(null, u16.subarray(j, Math.min(j + CHUNK, u16.length)));
    }
    if (out.charCodeAt(0) === 0xFEFF) out = out.slice(1);
    return out;
  };

  function PatchedTextDecoder(label, options) {
    if (label && /utf-16/i.test(String(label))) return new Utf16Decoder(label);
    return new NativeTD(label, options);
  }
  g.TextDecoder = PatchedTextDecoder;
})();

(function () {
  // window === 全局对象，vendor 里 window.xxx 与裸 xxx 完全等价
  var g = typeof globalThis !== 'undefined' ? globalThis : this;
  g.window = g;
  g.self = g;
  g.parent = g;  // 上游 shell/polyfill.js 的约定：无 iframe，parent === window
  g.top = g;
  g.jsGlobal = g; // shumway 风格全局引用，main.js 里有用到

  // Node 21+ 等环境里 navigator/performance 是 getter-only 全局，
  // 直接赋值会抛错；统一用可重定义的方式写入。
  function defineGlobal(name, value) {
    try {
      Object.defineProperty(g, name, {
        value: value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } catch (e) {
      g.console && g.console.warn('[env] 无法定义全局 ' + name + ': ' + e.message);
    }
  }

  // ------------------------------------------------------------------
  // 极简 Event / EventTarget（够 timer.js、pipe.js、midp 事件用）
  // ------------------------------------------------------------------

  function Event(type, init) {
    this.type = type;
    this.data = init && init.data;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this._stopped = false;
  }
  Event.prototype.preventDefault = function () { this.defaultPrevented = true; };
  Event.prototype.stopPropagation = function () { this._stopped = true; };

  function EventTarget() {
    this._listeners = Object.create(null);
  }
  EventTarget.prototype.addEventListener = function (type, fn, capture) {
    (this._listeners[type] || (this._listeners[type] = [])).push(fn);
  };
  EventTarget.prototype.removeEventListener = function (type, fn) {
    var list = this._listeners[type];
    if (list) {
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }
  };
  EventTarget.prototype.dispatchEvent = function (event) {
    if (typeof event === 'string') event = new Event(event);
    event.target = event.target || this;
    event.currentTarget = this;
    var list = (this._listeners[event.type] || []).slice();
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].call(this, event);
      } catch (e) {
        if (g.console && g.console.error) g.console.error('listener error: ' + (e && e.stack || e));
      }
      if (event._stopped) break;
    }
    return !event.defaultPrevented;
  };
  g.Event = Event;
  g.EventTarget = EventTarget;

  // window 本身就是事件目标（midp.js: window.addEventListener('keydown') 等）
  EventTarget.call(g);
  g.addEventListener = EventTarget.prototype.addEventListener;
  g.removeEventListener = EventTarget.prototype.removeEventListener;
  g.dispatchEvent = EventTarget.prototype.dispatchEvent;

  // ------------------------------------------------------------------
  // classList / 通用 DOM 元素 stub
  // ------------------------------------------------------------------

  function ClassList(el) {
    this._set = Object.create(null);
    this._el = el;
  }
  ClassList.prototype.add = function (c) { this._set[c] = true; };
  ClassList.prototype.remove = function (c) { delete this._set[c]; };
  ClassList.prototype.contains = function (c) { return !!this._set[c]; };
  ClassList.prototype.toggle = function (c) { this._set[c] = !this._set[c]; };
  Object.defineProperty(ClassList.prototype, 'length', {
    get: function () { return Object.keys(this._set).length; }
  });

  function StubElement(tag) {
    EventTarget.call(this);
    this.tagName = (tag || 'div').toUpperCase();
    this.style = { display: '', cssText: '' };
    this.classList = new ClassList(this);
    this.children = [];
    this.attributes = Object.create(null);
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.checked = false;
    this.files = [];
    this.parentNode = null;
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.onload = null;
    this.onerror = null;
  }
  StubElement.prototype.appendChild = function (child) {
    if (child && child.parentNode) { /* allow move */ }
    this.children.push(child);
    if (child) child.parentNode = this;
    return child;
  };
  StubElement.prototype.removeChild = function (child) {
    var i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    return child;
  };
  StubElement.prototype.setAttribute = function (k, v) { this.attributes[k] = String(v); if (k === 'src') this._setSrc(v); };
  StubElement.prototype.getAttribute = function (k) { return this.attributes[k]; };
  StubElement.prototype._setSrc = function (src) {
    // <script src> 与 <img src>：XHR 加载成功 -> onload；失败 -> onerror
    var self = this;
    if (this.tagName === 'SCRIPT') {
      g.__loadResource(src, 'text').then(function (code) {
        (0, eval)(code);
        if (self.onload) self.onload({ type: 'load' });
      }, function () {
        if (self.onerror) self.onerror({ type: 'error' });
      });
    } else if (this.tagName === 'IMG') {
      // 图片资源（emoji 等）：直接视为加载成功（渲染为空白）
      setTimeout(function () { if (self.onload) self.onload({ type: 'load' }); }, 0);
    }
  };
  StubElement.prototype.querySelector = function (sel) {
    // LCDUI 原生层会对克隆的模板节点反复 querySelector 赋值（h1.title/p.text/
    // progress 等），缓存子桩保证写入可读回
    this._selCache = this._selCache || Object.create(null);
    if (!this._selCache[sel]) {
      var child = new StubElement('div');
      this.appendChild(child);
      this._selCache[sel] = child;
    }
    return this._selCache[sel];
  };
  StubElement.prototype.querySelectorAll = function (sel) { return []; };
  StubElement.prototype.getElementsByTagName = function (tag) {
    if (tag === 'head') return [g.document._head];
    return [];
  };
  StubElement.prototype.cloneNode = function (deep) {
    var c = new StubElement(this.tagName);
    c.id = this.id;
    c.attributes = Object.assign(Object.create(null), this.attributes);
    c.textContent = this.textContent;
    if (deep && this.children.length) {
      for (var i = 0; i < this.children.length; i++) {
        if (this.children[i] instanceof StubElement) c.appendChild(this.children[i].cloneNode(true));
      }
    }
    return c;
  };
  StubElement.prototype.addEventListener = EventTarget.prototype.addEventListener;
  StubElement.prototype.removeEventListener = EventTarget.prototype.removeEventListener;
  StubElement.prototype.dispatchEvent = EventTarget.prototype.dispatchEvent;

  // ------------------------------------------------------------------
  // document / window 表面
  // ------------------------------------------------------------------

  var document = new EventTarget();
  document.body = new StubElement('body');
  document.documentElement = new StubElement('html');
  document.documentElement.appendChild(document.body);

  var canvasFactory = function (w, h) {
    throw new Error('canvas factory 未注入（应在 app 入口调用 __setCanvasFactory）');
  };
  var displayCanvas = null;
  var resourceLoader = function (path, responseType) {
    return Promise.reject(new Error('resource loader 未注入: ' + path));
  };

  g.__setCanvasFactory = function (fn) { canvasFactory = fn; };
  g.__setDisplayCanvas = function (c) { displayCanvas = c; };
  g.__setResourceLoader = function (fn) { resourceLoader = fn; };
  g.__loadResource = function (path, responseType) { return resourceLoader(path, responseType); };

  var knownElements = Object.create(null);
  var stubCache = Object.create(null);

  function getOrCreateStub(id) {
    if (!stubCache[id]) {
      stubCache[id] = new StubElement('div');
      stubCache[id].id = id;
      // LCDUI 模板节点（lcdui-alert 等）会被 cloneNode 后 append 回父亲
      stubCache[id].parentNode = document.body;
    }
    return stubCache[id];
  }

  // 画布元素也是事件目标（midp.js 对 deviceCanvas addEventListener/dispatchEvent）
  function augmentCanvas(c) {
    if (!c) return c;
    if (typeof c.addEventListener !== 'function' ||
        typeof c.removeEventListener !== 'function' ||
        typeof c.dispatchEvent !== 'function' || !c._listeners) {
      EventTarget.call(c);
      c.addEventListener = EventTarget.prototype.addEventListener;
      c.removeEventListener = EventTarget.prototype.removeEventListener;
      c.dispatchEvent = EventTarget.prototype.dispatchEvent;
    }
    if (!c.style) c.style = {};
    if (typeof c.getBoundingClientRect !== 'function') {
      c.getBoundingClientRect = function () {
        return { left: 0, top: 0, width: c.width, height: c.height,
                 right: c.width, bottom: c.height };
      };
    }
    return c;
  }

  var deviceW = 240, deviceH = 320; // MIDP 虚拟设备逻辑屏（游戏选中后可改）
  function applyDeviceSize() {
    g.innerWidth = deviceW;
    g.innerHeight = deviceH;
    g.outerWidth = deviceW;
    g.outerHeight = deviceH;
    // PATCH(j2me-nx-port): 软重启跨分辨率画面错乱根因修复。
    //   旧路径 = 改画布尺寸 + 无条件派发 canvasresize/resize 事件，依赖 vendor
    //   onWindowResize 重算 physicalScreen。两个问题：
    //   ① nx.js 画布对 width/height 赋值（含同值）都会清空 Skia surface，gfx.js
    //      的 canvasresize 监听再赋值一次把离屏缓冲也清掉 —— 重申定时器/漂移
    //      自愈每次调用都白抹一遍游戏帧缓冲，事件驱动的游戏不重绘即画面错乱；
    //   ② resize 事件链任何一次失手，midp 的 updateCanvas 就会在游戏切换全屏时
    //      把画布重置回 eval 期缓存的旧 physicalScreen，与呈现层自愈互相打架。
    //   新路径优先走 MIDP.updatePhysicalScreenSize 直写（幂等，同值零开销，
    //   异值由 updateCanvas 派发一次 canvasresize）；MIDP 未就绪时回落旧路径，
    //   且只在尺寸真实变化时派发。
    if (g.MIDP && typeof g.MIDP.updatePhysicalScreenSize === 'function') {
      try {
        g.MIDP.updatePhysicalScreenSize(deviceW, deviceH);
        return;
      } catch (e) { /* 直写失败回落事件路径 */ }
    }
    if (displayCanvas) {
      var oldW = displayCanvas.width, oldH = displayCanvas.height;
      var changed = oldW !== deviceW || oldH !== deviceH;
      if (oldW !== deviceW) displayCanvas.width = deviceW;
      if (oldH !== deviceH) displayCanvas.height = deviceH;
      if (changed) {
        // midp.js 求值期就会创建设备画布；改尺寸后必须派发 canvasresize——
        // gfx.js 的 offscreenCanvas / getScreenWidth0(getScreenHeight0) 全链路
        // 靠这个事件同步，游戏读 Display.WIDTH/HEIGHT 才能拿到新值。
        try { displayCanvas.dispatchEvent(new Event('canvasresize')); } catch (e) { /* 忽略 */ }
        // vendor 的 onWindowResize 监听 window resize 并重算 physicalScreen +
        // updateCanvas——派发一次让它把物理屏同步成新尺寸。
        try { g.dispatchEvent(new Event('resize')); } catch (e) { /* 忽略 */ }
      }
      try {
        g.console && g.console.log('[env] 画布尺寸: ' + oldW + 'x' + oldH + ' → ' +
          deviceW + 'x' + deviceH + '（读回 ' + displayCanvas.width + 'x' + displayCanvas.height + '）');
      } catch (e) { /* 忽略 */ }
    }
  }
  g.__setDeviceScreenSize = function (w, h) {
    w = w | 0; h = h | 0;
    if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return false;
    deviceW = w; deviceH = h;
    applyDeviceSize();
    return true;
  };
  g.__getDeviceScreenSize = function () { return { width: deviceW, height: deviceH }; };

  document.getElementById = function (id) {
    if (id === 'canvas') {
      if (!displayCanvas) {
        displayCanvas = augmentCanvas(canvasFactory(deviceW, deviceH));
        g.console && g.console.log('[env] 设备画布创建: ' + displayCanvas.width + 'x' + displayCanvas.height);
      }
      return displayCanvas;
    }
    return getOrCreateStub(id);
  };
  document.createElement = function (tag) {
    tag = String(tag).toLowerCase();
    if (tag === 'canvas') {
      return augmentCanvas(canvasFactory(300, 150));
    }
    return new StubElement(tag);
  };
  document.querySelector = function (sel) { return getOrCreateStub(sel); };
  document.querySelectorAll = function () { return []; };
  document.getElementsByTagName = function (tag) {
    if (tag === 'head') return [document._head];
    return [];
  };
  document._head = new StubElement('head');
  document.body = new StubElement('body');
  document.documentElement = new StubElement('html');
  document.cookie = '';
  g.document = document;

  // 窗口几何：MIDP 逻辑屏（默认 240x320，__setDeviceScreenSize 可调整）
  g.innerWidth = deviceW;
  g.innerHeight = deviceH;
  g.outerWidth = deviceW;
  g.outerHeight = deviceH;
  g.devicePixelRatio = 1;
  g.pageXOffset = 0;
  g.pageYOffset = 0;

  g.location = {
    href: 'switch://j2me/index.html',
    search: '',
    hash: '',
    replace: function (url) { g.console && g.console.warn('location.replace(' + url + ')'); },
    reload: function () { g.console && g.console.warn('location.reload()'); },
  };

  // PATCH(j2me-nx-port): nx.js 真机自带 navigator（挂着手柄 API getGamepads），
  // 不能整个换掉——否则手柄输入彻底失效（之前按键全无效的元凶之一）。
  // 策略：有原生 navigator 就在其上补齐缺失的浏览器语义字段；没有才用纯 stub。
  (function () {
    var realNav = null;
    try { realNav = (typeof g.navigator === 'object' && g.navigator) ? g.navigator : null; } catch (e) { }
    var stub = {
      userAgent: 'Mozilla/5.0 (Nintendo Switch) nx.js j2me-switch',
      onLine: true,
      language: 'zh-CN',
      vibrate: function () { return false; },
    };
    if (realNav) {
      for (var k in stub) {
        if (realNav[k] === undefined) {
          try { realNav[k] = stub[k]; } catch (e) { /* getter-only 字段忽略 */ }
        }
      }
      // 保持原对象引用（真 navigator 可能是 getter-only 全局，只改内容不换对象）
      try { defineGlobal('navigator', realNav); } catch (e) { /* 原地补齐已足够 */ }
    } else {
      defineGlobal('navigator', stub);
    }
  })();

  defineGlobal('performance', g.performance || { now: function () { return Date.now(); } });

  // ------------------------------------------------------------------
  // postMessage / message 事件（timer.js 的 nextTickDuringEvents 依赖）
  // ------------------------------------------------------------------

  g.postMessage = function (data, origin) {
    // 必须用宏任务派发（浏览器 postMessage 语义）：vendor 的 VM 调度器
    // nextTickDuringEvents 依赖它连续自旋；若用微任务（Promise.then）会
    // 饿死 Node 的定时器阶段，PNG 解码等 setTimeout 回调永远无法执行。
    setTimeout(function () {
      var ev = new Event('message');
      ev.data = data;
      ev.source = g;
      g.dispatchEvent(ev);
    }, 0);
  };

  // ------------------------------------------------------------------
  // Image
  // ------------------------------------------------------------------

  function Image(w, h) {
    this.width = w || 0;
    this.height = h || 0;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.onload = null;
    this.onerror = null;
    this.complete = false;
    // 解码产物：{ width, height, data(Uint8Array RGBA) }，Switch 端 drawImage
    // 包装层据此 putImageData（见 app/main.js installCanvas）
    this._decoded = null;
  }
  Object.defineProperty(Image.prototype, 'src', {
    set: function (v) {
      var self = this;
      if (typeof v === 'string' && v.slice(0, 5) === 'blob:') {
        // JAR 内 PNG 解码路径：gfx.js 用 Blob+createObjectURL+Image 解码图片
        var bytes = blobUrls[v];
        setTimeout(function () {
          if (!bytes || typeof g.__decodePNG !== 'function') {
            g.console && g.console.warn('[img] PNG 解码前置条件不满足: bytes=' + !!bytes +
              ' decoder=' + typeof g.__decodePNG);
            if (self.onerror) self.onerror({ type: 'error' });
            return;
          }
          try {
            var png = g.__decodePNG(bytes);
            self._decoded = png;
            self.width = self.naturalWidth = png.width;
            self.height = self.naturalHeight = png.height;
            self.complete = true;
            if (self.onload) self.onload({ type: 'load' });
          } catch (e) {
            g.console && g.console.warn('[image] PNG 解码失败: ' + e.message);
            if (self.onerror) self.onerror({ type: 'error' });
          }
        }, 0);
        return;
      }
      // 其它（emoji 等资源路径）：延迟触发 onload，保证依赖 onload 的流程不挂死
      setTimeout(function () {
        self.complete = true;
        if (self.onload) self.onload({ type: 'load' });
      }, 0);
    },
    get: function () { return this._src || ''; }
  });
  g.Image = Image;

  // ---- URL.createObjectURL：Blob -> 内存注册表（PNG 解码用）----
  var blobUrls = Object.create(null);
  var nextBlobId = 1;
  g.URL = {
    createObjectURL: function (blob) {
      var id = 'blob:nx-' + (nextBlobId++);
      blobUrls[id] = (blob && typeof blob.getBytes === 'function')
        ? blob.getBytes() : new Uint8Array(0);
      return id;
    },
    revokeObjectURL: function (id) { delete blobUrls[id]; },
  };

  // ------------------------------------------------------------------
  // Blob / FileReader（libs/fs.js、FileSaver 依赖）
  // ------------------------------------------------------------------

  function blobToUint8(parts) {
    var arrays = [];
    var total = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var u;
      if (p instanceof Uint8Array) u = p;
      else if (p instanceof ArrayBuffer) u = new Uint8Array(p);
      else if (p && p.buffer instanceof ArrayBuffer) u = new Uint8Array(p.buffer, p.byteOffset || 0, p.byteLength);
      else if (typeof p === 'string') u = new TextEncoder().encode(p);
      else if (p && typeof p.getBytes === 'function') u = p.getBytes(); // 我们的 Blob
      else u = new Uint8Array(0);
      arrays.push(u);
      total += u.length;
    }
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < arrays.length; j++) {
      out.set(arrays[j], off);
      off += arrays[j].length;
    }
    return out;
  }

  function Blob(parts, options) {
    this._bytes = blobToUint8(parts || []);
    this.type = (options && options.type) || '';
    this.size = this._bytes.length;
  }
  Blob.prototype.getBytes = function () { return this._bytes; };
  Blob.prototype.slice = function (start, end) {
    var b = new Blob([]);
    b._bytes = this._bytes.subarray(start || 0, end || this._bytes.length);
    b.size = b._bytes.length;
    return b;
  };
  g.Blob = Blob;

  function FileReader() {
    this.result = null;
    this.readyState = 0; // EMPTY=0 LOADING=1 DONE=2
    this.onload = null;
    this.onerror = null;
    // libs/fs.js 用 addEventListener("load"/"error") 注册回调（上游 FileReader
    // 是 EventTarget），必须支持，否则 fs.open 永不回调、RMS 异步 native 挂死
    EventTarget.call(this);
    this.addEventListener = EventTarget.prototype.addEventListener;
    this.removeEventListener = EventTarget.prototype.removeEventListener;
    this.dispatchEvent = EventTarget.prototype.dispatchEvent;
  }
  FileReader.prototype._finish = function (result) {
    var self = this;
    this.result = result;
    this.readyState = 2;
    setTimeout(function () {
      self.dispatchEvent({ type: 'load' });
      if (self.onload) self.onload({ type: 'load' });
    }, 0);
  };
  FileReader.prototype.readAsArrayBuffer = function (blob) {
    var bytes = blob instanceof Blob ? blob.getBytes() : new Uint8Array(0);
    this._finish(bytes.slice().buffer);
  };
  FileReader.prototype.readAsText = function (blob) {
    var bytes = blob instanceof Blob ? blob.getBytes() : new Uint8Array(0);
    this._finish(new TextDecoder().decode(bytes));
  };
  g.FileReader = FileReader;

  // ------------------------------------------------------------------
  // XMLHttpRequest（load.js 依赖；用宿主 resource loader 实现）
  // ------------------------------------------------------------------

  function XMLHttpRequest() {
    this.readyState = 0;
    this.status = 0;
    this.response = null;
    this.onload = null;
    this.onerror = null;
    this.onprogress = null;
    this._method = 'GET';
    this._url = '';
    this._responseType = 'text';
  }
  XMLHttpRequest.prototype.open = function (method, url, async) {
    this._method = method;
    this._url = url;
    this.readyState = 1;
  };
  Object.defineProperty(XMLHttpRequest.prototype, 'responseType', {
    get: function () { return this._responseType; },
    set: function (v) { this._responseType = v; }
  });
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    g.__loadResource(this._url, this._responseType).then(function (data) {
      self.readyState = 4;
      self.status = 200;
      self.response = data;
      if (self.onload) self.onload({ type: 'load' });
    }, function (err) {
      self.readyState = 4;
      self.status = 404;
      g.console && g.console.warn('[xhr] 加载失败: ' + self._url);
      if (self.onerror) self.onerror({ type: 'error' });
    });
  };
  g.XMLHttpRequest = XMLHttpRequest;

  // ------------------------------------------------------------------
  // alert：DumbPipe 的传输通道（pipe.js 用 alert(JSON 信封) 发消息）
  // ------------------------------------------------------------------

  g.alert = function (message) {
    if (typeof message === 'string' && message.charAt(0) === '{' &&
        message.indexOf('"command"') !== -1) {
      try {
        var envelope = JSON.parse(message);
        if (envelope && 'pipeID' in envelope && 'command' in envelope) {
          if (g.__hostPipeMessage) {
            g.__hostPipeMessage(envelope);
          } else {
            // vendor bundle 求值期间的早期信封（如 main.js 的 mobileInfo）：
            // 微任务在 pipe-host 安装前 flush，必须缓存，安装后补发。
            g.__pendingPipeEnvelopes.push(envelope);
          }
          return;
        }
      } catch (e) { /* 普通文本，落到 console */ }
    }
    g.console && g.console.log('[alert] ' + message);
  };
  g.__pendingPipeEnvelopes = [];

  g.requestAnimationFrame = g.requestAnimationFrame || function (fn) {
    return setTimeout(function () { fn(performance.now()); }, 16);
  };
  g.cancelAnimationFrame = g.cancelAnimationFrame || clearTimeout;
  g.getComputedStyle = function () { return { getPropertyValue: function () { return ''; } }; };
  g.saveAs = function (blob, name) {
    g.console && g.console.warn('saveAs(' + name + ') 在 Switch 上不可用');
  };

  // polyfill/*.js 会对这些原型打补丁（如 canvas-toblob 给
  // HTMLCanvasElement.prototype.toBlob），提供壳类型即可。
  function StubHTMLType() {}
  ['HTMLElement', 'HTMLCanvasElement', 'HTMLImageElement', 'HTMLVideoElement',
   'HTMLAudioElement', 'HTMLInputElement', 'HTMLSelectElement']
    .forEach(function (name) {
      if (typeof g[name] === 'undefined') {
        g[name] = StubHTMLType;
      }
    });
  StubHTMLType.prototype.toBlob = function (cb) { cb && cb(null); };
})();
