/* -*- Mode: Java; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim: set shiftwidth=4 tabstop=4 autoindent cindent expandtab: */

/**
 * CLDC Conv natives — Gen_Reader / Gen_Writer (GBK 等) 的字节↔Unicode 转换。
 * TextDecoder 负责解码；编码用解码表反查（浏览器 TextEncoder 仅支持 UTF-8）。
 */
(function (global) {
    "use strict";

    var handlers = Object.create(null);
    var nextId = 1;
    var encoderCache = Object.create(null);

    var LABEL_ALIASES = {
        gbk: "gbk",
        "x-gbk": "gbk",
        cp936: "gbk",
        ms936: "gbk",
        gb2312: "gbk",
        "gb2312-80": "gbk",
        euc_cn: "gbk",
        "euc-cn": "gbk",
        gb18030: "gb18030",
        windows_1252: "windows-1252",
        "windows-1252": "windows-1252",
        cp1252: "windows-1252",
        iso_8859_1: "iso-8859-1",
        "iso-8859-1": "iso-8859-1",
        iso8859_1: "iso-8859-1",
        latin1: "iso-8859-1",
        us_ascii: "us-ascii",
        "us-ascii": "us-ascii",
        ascii: "us-ascii",
        koi8_r: "koi8-r",
        "koi8-r": "koi8-r",
        koi18_r: "koi8-r",
        utf_8: "utf-8",
        "utf-8": "utf-8",
        utf8: "utf-8",
    };

    function normalizeEncoding(enc) {
        if (enc == null) {
            return null;
        }
        var key = String(enc).toLowerCase().replace(/[:\-]/g, "_").replace(/_+/g, "_");
        // re-map using both underscore and hyphen forms
        var hyphen = key.replace(/_/g, "-");
        if (LABEL_ALIASES[key]) {
            return LABEL_ALIASES[key];
        }
        if (LABEL_ALIASES[hyphen]) {
            return LABEL_ALIASES[hyphen];
        }
        return hyphen;
    }

    function maxBytesForLabel(label) {
        if (label === "utf-8") {
            return 4;
        }
        if (label === "gbk" || label === "gb18030") {
            return label === "gb18030" ? 4 : 2;
        }
        if (label.indexOf("utf-16") === 0) {
            return 4;
        }
        return 1;
    }

    /*
     * PATCH(j2me-nx-port) 2026-09-23：nx.js(Switch) 的 TextDecoder **只有 utf-8**
     * （见 src/host/env-prelude.js 里 utf-16 兼容层的注释 —— 那是上一轮实机踩出来的）。
     * 中文 J2ME 游戏的文本几乎都是 GBK：实机「Forgotten Warrior 丢文字」就是
     * `new String(byte[])`（平台默认编码）拿到 GBK 字节被当 UTF-8 解，整段剧情变成
     * U+FFFD（实测 1.sn：UTF-8 解出 91 个替换字符，GBK 解是"糟糕，我的悠悠球忘拿了"）。
     * 桌面 Node 带完整 ICU（TextDecoder('gbk') 可用），所以这个坑在仿真里完全看不见。
     * 兜底 = 自带映射表 vendor/pluotsorbet/midp/gbk-table.js（23,940 项，tools/make-gbk-table.mjs 生成）。
     *
     * ⚠️ 判定用**试解**而不是 try/catch：有的运行时对不认识的编码标签不抛异常、
     * 悄悄按 UTF-8 解 —— 那会把 GBK 文本解成乱码，比直接报错难查得多。
     * 拿 "你"(C4 E3) 探一次，解得对（U+4F60）才敢用原生解码器。
     */
    var nativeGbkUsableCache = null;
    function nativeGbkUsable() {
        if (nativeGbkUsableCache !== null) {
            return nativeGbkUsableCache;
        }
        try {
            var probe = new TextDecoder("gbk", { fatal: false }).decode(Uint8Array.of(0xc4, 0xe3));
            nativeGbkUsableCache = (probe === "\u4f60");
        } catch (e) {
            nativeGbkUsableCache = false;
        }
        return nativeGbkUsableCache;
    }

    /** 无宿主 ICU 时的 GBK 解码器（实现在 vendor/pluotsorbet/midp/gbk.js）。 */
    function embeddedGbkDecoder() {
        if (!global.J2MEGbkDecoder) {
            throw new Error("GBK 解码器缺失：vendor/pluotsorbet/midp/gbk.js 没进包？");
        }
        return global.J2MEGbkDecoder;
    }

    function getDecoder(label) {
        if (label === "gbk" || label === "gb18030") {
            if (nativeGbkUsable()) {
                try {
                    return new TextDecoder(label, { fatal: false });
                } catch (e) {
                    // gb18030 标签不被支持时退到 gbk（2 字节区相同）
                }
            }
            return embeddedGbkDecoder();
        }
        return new TextDecoder(label, { fatal: false });
    }

    function supportsLabel(label) {
        try {
            getDecoder(label);
            return true;
        } catch (e) {
            return false;
        }
    }

    function toUint8(bytes, offset, length) {
        var out = new Uint8Array(length);
        for (var i = 0; i < length; i++) {
            out[i] = bytes[offset + i] & 0xff;
        }
        return out;
    }

    function isGbkLead(b) {
        return b >= 0x81 && b <= 0xfe;
    }

    function isGbkTrail(b) {
        return b >= 0x40 && b <= 0xfe && b !== 0x7f;
    }

    function getByteLengthForLabel(label, bytes, offset, len) {
        if (len <= 0) {
            return 0;
        }
        var b0 = bytes[offset] & 0xff;
        if (label === "gbk" || label === "gb18030") {
            if (b0 < 0x80) {
                return 1;
            }
            if (isGbkLead(b0)) {
                if (len < 2) {
                    return -1;
                }
                // GB18030 四字节：第二字节 0x30-0x39
                if (label === "gb18030") {
                    var b1 = bytes[offset + 1] & 0xff;
                    if (b1 >= 0x30 && b1 <= 0x39) {
                        if (len < 4) {
                            return -1;
                        }
                        var b2 = bytes[offset + 2] & 0xff;
                        var b3 = bytes[offset + 3] & 0xff;
                        if (isGbkLead(b2) && b3 >= 0x30 && b3 <= 0x39) {
                            return 4;
                        }
                        return 0;
                    }
                }
                return isGbkTrail(bytes[offset + 1] & 0xff) ? 2 : 0;
            }
            return 0;
        }
        if (label === "utf-8") {
            if (b0 < 0x80) {
                return 1;
            }
            var need = 0;
            if ((b0 & 0xe0) === 0xc0) {
                need = 2;
            } else if ((b0 & 0xf0) === 0xe0) {
                need = 3;
            } else if ((b0 & 0xf8) === 0xf0) {
                need = 4;
            } else {
                return 0;
            }
            if (len < need) {
                return -1;
            }
            for (var i = 1; i < need; i++) {
                if (((bytes[offset + i] & 0xff) & 0xc0) !== 0x80) {
                    return 0;
                }
            }
            return need;
        }
        // 单字节编码
        return 1;
    }

    function buildEncoderMap(label) {
        if (encoderCache[label]) {
            return encoderCache[label];
        }
        var map = new Map();
        var dec = getDecoder(label);
        var maxB = maxBytesForLabel(label);

        if (label === "utf-8") {
            encoderCache[label] = null; // 使用 TextEncoder
            return null;
        }

        if (maxB === 1) {
            for (var b = 0; b < 256; b++) {
                var s1 = dec.decode(Uint8Array.of(b));
                if (s1.length === 1) {
                    var cp1 = s1.charCodeAt(0);
                    if (cp1 !== 0xfffd && !map.has(cp1)) {
                        map.set(cp1, [b]);
                    }
                }
            }
        } else {
            for (var i = 0; i < 0x80; i++) {
                map.set(i, [i]);
            }
            for (var b1 = 0x81; b1 <= 0xfe; b1++) {
                for (var b2 = 0x40; b2 <= 0xfe; b2++) {
                    if (b2 === 0x7f) {
                        continue;
                    }
                    var s2 = dec.decode(Uint8Array.of(b1, b2));
                    if (s2.length === 1) {
                        var cp2 = s2.charCodeAt(0);
                        if (cp2 !== 0xfffd && !map.has(cp2)) {
                            map.set(cp2, [b1, b2]);
                        }
                    }
                }
            }
        }
        encoderCache[label] = map;
        return map;
    }

    function encodeString(label, str) {
        if (label === "utf-8") {
            return new TextEncoder().encode(str);
        }
        if (label === "us-ascii") {
            var ascii = new Uint8Array(str.length);
            for (var a = 0; a < str.length; a++) {
                var c = str.charCodeAt(a);
                ascii[a] = c <= 0x7f ? c : 0x3f;
            }
            return ascii;
        }
        if (label === "iso-8859-1") {
            var latin = new Uint8Array(str.length);
            for (var i = 0; i < str.length; i++) {
                var ch = str.charCodeAt(i);
                latin[i] = ch <= 0xff ? ch : 0x3f;
            }
            return latin;
        }
        var map = buildEncoderMap(label);
        var tmp = [];
        for (var j = 0; j < str.length; j++) {
            var cp = str.charCodeAt(j);
            var bytes = map.get(cp);
            if (bytes) {
                for (var k = 0; k < bytes.length; k++) {
                    tmp.push(bytes[k]);
                }
            } else {
                tmp.push(0x3f);
            }
        }
        return Uint8Array.from(tmp);
    }

    function decodeBytes(label, u8) {
        return getDecoder(label).decode(u8);
    }

    function getHandler(encoding) {
        var label = normalizeEncoding(encoding);
        if (!label || !supportsLabel(label)) {
            return -1;
        }
        if (handlers[label] == null) {
            handlers[label] = nextId++;
            handlers["#" + handlers[label]] = {
                id: handlers[label],
                label: label,
                maxByteLen: maxBytesForLabel(label),
            };
        }
        return handlers[label];
    }

    function handlerOf(id) {
        return handlers["#" + id] || null;
    }

    function getMaxByteLength(id) {
        var h = handlerOf(id);
        return h ? h.maxByteLen : 0;
    }

    function getByteLength(id, b, offset, len) {
        var h = handlerOf(id);
        if (!h || !b || offset < 0 || len < 0 || offset + len > b.length) {
            return 0;
        }
        return getByteLengthForLabel(h.label, b, offset, len);
    }

    function byteToChar(id, input, inOffset, inLen, output, outOffset, outLen) {
        var h = handlerOf(id);
        if (!h || !input || !output || inLen < 0 || outLen < 0) {
            return 0;
        }
        if (inOffset < 0 || outOffset < 0 || inOffset + inLen > input.length || outOffset + outLen > output.length) {
            return 0;
        }
        if (inLen === 0 || outLen === 0) {
            return 0;
        }
        var u8 = toUint8(input, inOffset, inLen);
        var s = decodeBytes(h.label, u8);
        var n = s.length < outLen ? s.length : outLen;
        for (var i = 0; i < n; i++) {
            output[outOffset + i] = s.charCodeAt(i);
        }
        return n;
    }

    function charToByte(id, input, inOffset, inLen, output, outOffset, outLen) {
        var h = handlerOf(id);
        if (!h || !input || !output || inLen < 0 || outLen < 0) {
            return 0;
        }
        if (inOffset < 0 || outOffset < 0 || inOffset + inLen > input.length || outOffset + outLen > output.length) {
            return 0;
        }
        if (inLen === 0 || outLen === 0) {
            return 0;
        }
        var s = "";
        for (var i = 0; i < inLen; i++) {
            s += String.fromCharCode(input[inOffset + i]);
        }
        var encoded = encodeString(h.label, s);
        var n = encoded.length < outLen ? encoded.length : outLen;
        for (var j = 0; j < n; j++) {
            output[outOffset + j] = encoded[j];
        }
        return n;
    }

    function sizeOfByteInUnicode(id, b, offset, length) {
        var h = handlerOf(id);
        if (!h || !b || offset < 0 || length < 0 || offset + length > b.length) {
            return 0;
        }
        if (length === 0) {
            return 0;
        }
        return decodeBytes(h.label, toUint8(b, offset, length)).length;
    }

    function sizeOfUnicodeInByte(id, c, offset, length) {
        var h = handlerOf(id);
        if (!h || !c || offset < 0 || length < 0 || offset + length > c.length) {
            return 0;
        }
        if (length === 0) {
            return 0;
        }
        var s = "";
        for (var i = 0; i < length; i++) {
            s += String.fromCharCode(c[offset + i]);
        }
        return encodeString(h.label, s).length;
    }

    var J2MEConv = {
        normalizeEncoding: normalizeEncoding,
        getHandler: getHandler,
        getMaxByteLength: getMaxByteLength,
        getByteLength: getByteLength,
        byteToChar: byteToChar,
        charToByte: charToByte,
        sizeOfByteInUnicode: sizeOfByteInUnicode,
        sizeOfUnicodeInByte: sizeOfUnicodeInByte,
        encodeString: encodeString,
        decodeBytes: decodeBytes,
    };

    global.J2MEConv = J2MEConv;

    if (typeof Native !== "undefined") {
        Native["com/sun/cldc/i18n/j2me/Conv.getHandler.(Ljava/lang/String;)I"] = function (addr, encodingAddr) {
            return J2MEConv.getHandler(J2ME.fromStringAddr(encodingAddr));
        };

        Native["com/sun/cldc/i18n/j2me/Conv.getMaxByteLength.(I)I"] = function (addr, handler) {
            return J2MEConv.getMaxByteLength(handler | 0);
        };

        Native["com/sun/cldc/i18n/j2me/Conv.getByteLength.(I[BII)I"] = function (addr, handler, bAddr, offset, len) {
            var b = J2ME.getArrayFromAddr(bAddr);
            if (!b) {
                throw $.newNullPointerException();
            }
            return J2MEConv.getByteLength(handler | 0, b, offset | 0, len | 0);
        };

        Native["com/sun/cldc/i18n/j2me/Conv.byteToChar.(I[BII[CII)I"] = function (
            addr,
            handler,
            inputAddr,
            inOffset,
            inLen,
            outputAddr,
            outOffset,
            outLen
        ) {
            var input = J2ME.getArrayFromAddr(inputAddr);
            var output = J2ME.getArrayFromAddr(outputAddr);
            if (!input || !output) {
                throw $.newNullPointerException();
            }
            return J2MEConv.byteToChar(
                handler | 0,
                input,
                inOffset | 0,
                inLen | 0,
                output,
                outOffset | 0,
                outLen | 0
            );
        };

        Native["com/sun/cldc/i18n/j2me/Conv.charToByte.(I[CII[BII)I"] = function (
            addr,
            handler,
            inputAddr,
            inOffset,
            inLen,
            outputAddr,
            outOffset,
            outLen
        ) {
            var input = J2ME.getArrayFromAddr(inputAddr);
            var output = J2ME.getArrayFromAddr(outputAddr);
            if (!input || !output) {
                throw $.newNullPointerException();
            }
            return J2MEConv.charToByte(
                handler | 0,
                input,
                inOffset | 0,
                inLen | 0,
                output,
                outOffset | 0,
                outLen | 0
            );
        };

        Native["com/sun/cldc/i18n/j2me/Conv.sizeOfByteInUnicode.(I[BII)I"] = function (
            addr,
            handler,
            bAddr,
            offset,
            length
        ) {
            var b = J2ME.getArrayFromAddr(bAddr);
            if (!b) {
                throw $.newNullPointerException();
            }
            return J2MEConv.sizeOfByteInUnicode(handler | 0, b, offset | 0, length | 0);
        };

        Native["com/sun/cldc/i18n/j2me/Conv.sizeOfUnicodeInByte.(I[CII)I"] = function (
            addr,
            handler,
            cAddr,
            offset,
            length
        ) {
            var c = J2ME.getArrayFromAddr(cAddr);
            if (!c) {
                throw $.newNullPointerException();
            }
            return J2MEConv.sizeOfUnicodeInByte(handler | 0, c, offset | 0, length | 0);
        };

        /**
         * Override Helper.byteToCharArray so String(byte[], enc) never depends on
         * Class.forName(UTF_8_Reader) / StreamReader. Some midlets (灌篮高手) decrypt
         * configs to UTF-8-with-BOM; if that String() fails they swallow the error and
         * later NPE on a null logo String[].
         */
        Native["com/sun/cldc/i18n/Helper.byteToCharArray.([BIILjava/lang/String;)[C"] = function (
            addr,
            bufferAddr,
            offset,
            length,
            encAddr
        ) {
            var buffer = J2ME.getArrayFromAddr(bufferAddr);
            if (!buffer) {
                throw $.newNullPointerException();
            }
            offset = offset | 0;
            length = length | 0;
            if (offset < 0 || length < 0 || offset > buffer.length - length) {
                throw $.newIndexOutOfBoundsException();
            }
            if (encAddr === J2ME.Constants.NULL) {
                throw $.newNullPointerException();
            }
            var enc = J2ME.fromStringAddr(encAddr);
            var label = normalizeEncoding(enc);
            if (!label) {
                throw $.newUnsupportedEncodingException(String(enc));
            }

            var text;
            try {
                if (label === "iso-8859-1" || label === "us-ascii") {
                    var charsLatin = new Array(length);
                    for (var i = 0; i < length; i++) {
                        charsLatin[i] = buffer[offset + i] & 0xff;
                    }
                    var outLatin = J2ME.newCharArray(length);
                    var arrLatin = J2ME.getArrayFromAddr(outLatin);
                    for (var j = 0; j < length; j++) {
                        arrLatin[j] = charsLatin[j];
                    }
                    return outLatin;
                }
                var u8 = toUint8(buffer, offset, length);
                text = decodeBytes(label, u8);
            } catch (e) {
                console.warn("Helper.byteToCharArray failed", enc, label, e && e.message ? e.message : e);
                throw $.newUnsupportedEncodingException(String(enc));
            }

            var out = J2ME.newCharArray(text.length);
            var arr = J2ME.getArrayFromAddr(out);
            for (var k = 0; k < text.length; k++) {
                arr[k] = text.charCodeAt(k);
            }
            if (label === "utf-8" && typeof console !== "undefined" && console.log) {
                var preview = text.length > 120 ? text.substring(0, 120) : text;
                console.log("Helper.byteToCharArray UTF-8 len=", text.length, "hasLogo=", text.indexOf("logo=") >= 0, "preview=", JSON.stringify(preview));
            }
            return out;
        };
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
