/*
 * gbk.js — 自带 GBK 解码器（配合 gbk-table.js 的映射表）
 *
 * PATCH(j2me-nx-port) 2026-09-23。为什么需要它：
 *   nx.js(Switch) 的 TextDecoder **只认 utf-8**（见 src/host/env-prelude.js 里 utf-16
 *   兼容层的注释 —— 那是上一轮实机踩出来的），而中文 J2ME 游戏的文本几乎都是 GBK。
 *   上游 conv.js 是直接 `new TextDecoder('gbk')` 的，在桌面 Node（带完整 ICU）上跑得通、
 *   在真机上根本不存在 —— 这类"仿真过、实机崩"的差别本轮就吃了一次（游戏丢文字）。
 *
 * 对外只暴露 `global.J2MEGbkDecoder`：一个 TextDecoder 形状的对象（只有 decode），
 * 供 vendor/pluotsorbet/midp/conv.js 的 getDecoder() 在原生解码器不可用时兜底。
 * 表由 tools/make-gbk-table.mjs 生成；解码规则按 WHATWG/CP936：
 *   * 0x00-0x7F 原样；0x80 = €(U+20AC)；
 *   * 0x81-0xFE + 合法尾字节(0x40-0x7E/0x80-0xFE，不含 0x7F) → 查表；
 *   * 其它一律 U+FFFD，且**不吞掉**当前这个尾字节（与 WHATWG 的 prepend 行为一致）。
 * 不支持的：GB18030 四字节序列（中文 J2ME 游戏用不到，会退化成 U+FFFD）。
 */
(function (global) {
    "use strict";

    var LEADS = 126;   // 0x81..0xFE
    var TRAILS = 190;  // 0x40..0x7E + 0x80..0xFE（跳过 0x7F）
    var CHUNK = 4096;  // fromCharCode.apply 的分块大小（避免参数栈溢出）

    /** trail 字节 → 表内下标（0x40..0x7E → 0..62；0x80..0xFE → 63..189）。 */
    function trailIndex(b) {
        return b < 0x7f ? b - 0x40 : b - 0x41;
    }

    function decode(u8) {
        var table = global.J2MEGbkTable;
        if (!table) {
            throw new Error("GBK 映射表缺失：vendor/pluotsorbet/midp/gbk-table.js 没进包？");
        }
        var out = "";
        var chunk = [];
        var n = u8.length;
        var i = 0;
        while (i < n) {
            var b0 = u8[i++] & 0xff;
            var b1;
            if (b0 < 0x80) {
                chunk.push(b0);
            } else if (b0 === 0x80) {
                chunk.push(0x20ac);                                  /* CP936: 0x80 = € */
            } else if (b0 <= 0xfe && i < n
                       && (b1 = u8[i] & 0xff) >= 0x40 && b1 <= 0xfe && b1 !== 0x7f) {
                i++;
                var cp = table.charCodeAt((b0 - 0x81) * TRAILS + trailIndex(b1));
                chunk.push(cp || 0xfffd);
            } else {
                chunk.push(0xfffd);                                  /* 非法首/尾字节 */
            }
            if (chunk.length >= CHUNK) {
                out += String.fromCharCode.apply(null, chunk);
                chunk = [];
            }
        }
        if (chunk.length) {
            out += String.fromCharCode.apply(null, chunk);
        }
        return out;
    }

    global.J2MEGbkDecoder = { decode: decode };
    global.J2MEGbkTableInfo = { leads: LEADS, trails: TRAILS, size: LEADS * TRAILS, trailIndex: trailIndex };
})(typeof globalThis !== "undefined" ? globalThis : this);
