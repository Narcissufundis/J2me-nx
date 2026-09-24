/*
 * bytes.js — 文件读取结果的类型规整（j2me-nx-port 宿主层）
 *
 * 由来（实机事故，perfZ26）：
 *   nx.js 的 `Switch.readFileSync(path)` 返回的是 **ArrayBuffer**（运行时 source/fs.cc
 *   走 `ArrayBuffer::New`），而 Node 的 `fs.readFileSync(path)` 返回 **Buffer**
 *   （Buffer 是 Uint8Array 子类，有 `.length`）。
 *   于是源码里那句最常见的判空 `if (bytes && bytes.length)` 在**仿真里恒真、在实机上恒假**
 *   （`ArrayBuffer.prototype.length === undefined`），三个功能在真机上全部静默失效：
 *     · `sdmc:/switch/j2me-nx/lang.json`        → 语言永远读不回来（"选了英文下次还是中文"）
 *     · `sdmc:/switch/j2me-nx/keys.txt`         → 自定义按键映射被当成"文件不存在"重置成默认
 *     · `sdmc:/switch/j2me-nx/keyprofiles.json` → 每个游戏的按键机型永不生效
 *   而且日志还会撒谎（打印"没有文件"），因为判空就是在那一行失败的。
 *
 * 结论：**只在唯一的读取入口做一次规整**，返回 Uint8Array（有 `.length`/`.subarray`），
 * 任何调用方都不必自己 `instanceof` 判断。谁再直接拿 `Switch.readFileSync` 的返回值
 * 当字节视图用，就会重新踩这个坑（tests/readfile-contract.test.mjs 盯着）。
 *
 * 导出：`g.__toU8(x) -> Uint8Array | null`
 */
(function () {
  'use strict';
  var g = typeof globalThis !== 'undefined' ? globalThis : this;

  g.__toU8 = function (x) {
    if (!x) return null;                                   // null / undefined / 0 / ''
    if (x instanceof Uint8Array) return x;                 // 已是字节视图（Node Buffer 也是）
    if (typeof x.byteLength !== 'number') return null;
    // ⚠ 实机走这条：Switch.readFileSync 给的是 ArrayBuffer。
    // 这里不写 `instanceof ArrayBuffer` 是为了跨 realm 也成立（vm 沙箱/测试环境里
    // 构造出来的 ArrayBuffer 不等于本 realm 的构造器，用实例判断会漏）。
    if (x.buffer === undefined) return new Uint8Array(x);
    // 其它带 buffer 的视图（DataView / 别的 TypedArray）
    return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength);
  };

  // 自检：把一个 ArrayBuffer 过一遍后必须能安全取到字节数（这就是当初踩的那个坑）
  try {
    var probe = new Uint8Array([1, 2, 3]).buffer;
    var ok = g.__toU8(probe) && g.__toU8(probe).length === 3;
    g.__toU8ContractOk = !!ok;
  } catch (eP) {
    g.__toU8ContractOk = false;
  }
  if (g.__toU8ContractOk !== true && g.console && g.console.warn) {
    g.console.warn('[bytes] __toU8 自检失败：ArrayBuffer → Uint8Array 规整不可用');
  }
})();
