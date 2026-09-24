/*
 * png-decoder.js — 纯 JS PNG 解码器（j2me-nx-port 宿主层）
 *
 * 为什么自己写：PluotSorbet 的 Image.createImage 走浏览器 Blob+Image+URL，
 * nx.js（Switch）的 Image 只支持文件路径加载，两者都吃不到"JAR 内存中的 PNG"。
 * 纯 JS 解码（inflate + PNG）桌面/Switch 通用。
 *
 * 支持：
 *   - DEFLATE (RFC 1951)：stored / fixed / dynamic Huffman
 *   - 颜色类型 0(灰度)/2(RGB)/3(调色板)/4(灰度+alpha)/6(RGBA)
 *   - 位深 1/2/4/8（灰度与调色板），8/16（RGB/RGBA/灰度+alpha，16 取高字节）
 *   - tRNS 透明（调色板 alpha / 灰度与真彩 color-key）
 *   - Adam7 隔行扫描
 *
 * 导出：decodePNG(bytesOrView) -> { width, height, data: Uint8Array(RGBA) }
 *        失败抛 Error（调用方决定 onerror 语义）。
 *       pngSize(bytesOrView) -> { width, height, bitDepth, colorType, interlace } | null
 *        只读 IHDR，零大分配（调用方先探尺寸再决定要不要解）。
 *       ⚠️ decodePNG 内部有 16MP（RGBA 64MB）尺寸闸门：超过直接抛错而不是
 *          尝试分配——超限分配是 V8/native 级 fatal，try/catch 拦不住
 *          （2026-09-23 实机"选完自定义遮罩模拟器直接退出"就是这么来的）。
 */
'use strict';

(function (g) {
  // ==================================================================
  // DEFLATE 解压（RFC 1951）
  // ==================================================================

  function BitReader(data, pos) {
    this.data = data;
    this.pos = pos;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  BitReader.prototype.readBits = function (n) {
    while (this.bitCnt < n) {
      // PATCH(j2me-nx-port): 越界防护（同 zipfile.js——损坏流会无限喂零）
      if (this.pos > this.data.length) throw new Error('inflate: 数据耗尽');
      this.bitBuf |= this.data[this.pos++] << this.bitCnt;
      this.bitCnt += 8;
    }
    var v = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCnt -= n;
    return v;
  };
  BitReader.prototype.alignByte = function () {
    this.bitBuf = 0;
    this.bitCnt = 0;
  };

  // 规范 Huffman 解码表（code lengths -> 符号）
  function buildHuffTable(lengths) {
    var counts = new Uint16Array(16);
    for (var i = 0; i < lengths.length; i++) counts[lengths[i]]++;
    counts[0] = 0;
    var offs = new Uint16Array(16);
    for (var j = 1; j < 16; j++) offs[j] = offs[j - 1] + counts[j - 1];
    var symbols = new Uint16Array(offs[15] + counts[15]);
    for (var k = 0; k < lengths.length; k++) {
      if (lengths[k]) symbols[offs[lengths[k]]++] = k;
    }
    return { counts: counts, symbols: symbols };
  }

  // 逐位解码一个符号
  function decodeSymbol(br, table) {
    var code = 0, first = 0, index = 0;
    for (var len = 1; len < 16; len++) {
      code |= br.readBits(1);
      var count = table.counts[len];
      if (code - first < count) {
        return table.symbols[index + (code - first)];
      }
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('inflate: 无效 Huffman 码');
  }

  var LEN_BASE = new Uint16Array([3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258]);
  var LEN_EXTRA = new Uint8Array([0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0]);
  var DIST_BASE = new Uint16Array([1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577]);
  var DIST_EXTRA = new Uint8Array([0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13]);

  var CLEN_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

  // ==================================================================
  // 可增长的类型化输出缓冲（inflate 用）
  //
  // ⚠️ 2026-09-23 实机 fatal 的**真正根因**在这里。旧实现是 `var out = []` +
  // `out.push(byte)`，最后一个 `Uint8Array.from(out)`：
  // 一张 1280x720 RGBA 的 PNG，IDAT 解压出来是 3,686,760 字节 —— 作为普通
  // JS 数组就是 370 万个元素（V8 的 SMI 后备存储 4~8 字节/元素 → 15~30MB，
  // 而 push 触发翻倍扩容时瞬时还要再多一份），最后 `Uint8Array.from` 又拷一份。
  // 合计每解码一张图就要在 V8 堆里翻腾 30~60MB。
  // 桌面 Node 有几个 GB，看不出问题（所以仿真一直"通过"）；Switch 偏紧档
  // heapTotal 才 55MB，一按就 fatal —— 日志停在 `[mask] PNG 1280x720 …` 的
  // 下一行，正是解码途中。换成类型化缓冲后峰值 ≈ 输出大小 ×1.5~2（约 6~8MB）。
  // ==================================================================
  function GrowBuf(cap, max) {
    this.buf = new Uint8Array(cap || (1 << 16));
    this.len = 0;
    this.max = max || 0;      // 0 = 不限（防"压缩炸弹"：调用方按 IHDR 声明尺寸给上限）
  }
  GrowBuf.prototype.ensure = function (extra) {
    var need = this.len + extra;
    if (need <= this.buf.length) return;
    if (this.max && need > this.max) {
      throw new Error('inflate: 输出超出预期上限 ' + need + ' > ' + this.max);
    }
    var cap = this.buf.length;
    // 小容量翻倍（少拷贝），大容量线性涨（不浪费一半）
    while (cap < need) cap = cap < (1 << 21) ? cap * 2 : cap + (1 << 21);
    var nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  };
  GrowBuf.prototype.push = function (b) {
    if (this.len === this.buf.length) this.ensure(1);
    this.buf[this.len++] = b;
    return this.len;
  };
  // 零拷贝返回视图（不再是 Uint8Array.from 的整份拷贝）
  GrowBuf.prototype.bytes = function () { return this.buf.subarray(0, this.len); };

  function inflateBlock(br, out) {
    for (;;) {
      var sym = decodeSymbol(br, br.litTable);
      if (sym < 256) {
        out.push(sym);
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) throw new Error('inflate: 无效长度符号');
        var len = LEN_BASE[sym] + br.readBits(LEN_EXTRA[sym]);
        var dsym = decodeSymbol(br, br.distTable);
        var dist = DIST_BASE[dsym] + br.readBits(DIST_EXTRA[dsym]);
        var from = out.len - dist;   // out 是 GrowBuf：读它的 buf，写它的尾部
        if (from < 0) throw new Error('inflate: 距离越界');
        out.ensure(len);
        var ob = out.buf, ol = out.len;
        for (var i = 0; i < len; i++) ob[ol + i] = ob[from++];
        out.len = ol + len;
      }
    }
  }

  function inflateRaw(data, pos, maxOut) {
    var out = new GrowBuf(1 << 16, maxOut || 0);
    var br = new BitReader(data, pos);
    for (;;) {
      var bfinal = br.readBits(1);
      var btype = br.readBits(2);
      if (btype === 0) {
        // stored：整块 set 进去，不再逐字节 push
        br.alignByte();
        var len = br.data[br.pos] | (br.data[br.pos + 1] << 8);
        br.pos += 4; // LEN + NLEN
        out.ensure(len);
        out.buf.set(br.data.subarray(br.pos, br.pos + len), out.len);
        out.len += len;
        br.pos += len;
      } else if (btype === 1) {
        // fixed Huffman
        var litLengths = new Uint8Array(288);
        for (var j = 0; j < 144; j++) litLengths[j] = 8;
        for (var k = 144; k < 256; k++) litLengths[k] = 9;
        for (var m = 256; m < 280; m++) litLengths[m] = 7;
        for (var n = 280; n < 288; n++) litLengths[n] = 8;
        br.litTable = buildHuffTable(litLengths);
        br.distTable = buildHuffTable(new Uint8Array(30).fill(5));
        inflateBlock(br, out);
      } else if (btype === 2) {
        // dynamic Huffman
        var hlit = br.readBits(5) + 257;
        var hdist = br.readBits(5) + 1;
        var hclen = br.readBits(4) + 4;
        var clenLengths = new Uint8Array(19);
        for (var c = 0; c < hclen; c++) clenLengths[CLEN_ORDER[c]] = br.readBits(3);
        var clenTable = buildHuffTable(clenLengths);
        var lengths = new Uint8Array(hlit + hdist);
        var idx = 0;
        while (idx < lengths.length) {
          var s = decodeSymbol(br, clenTable);
          if (s < 16) {
            lengths[idx++] = s;
          } else if (s === 16) {
            var prev = lengths[idx - 1];
            var rep = 3 + br.readBits(2);
            while (rep--) lengths[idx++] = prev;
          } else if (s === 17) {
            var rep0 = 3 + br.readBits(3);
            while (rep0--) lengths[idx++] = 0;
          } else {
            var rep0b = 11 + br.readBits(7);
            while (rep0b--) lengths[idx++] = 0;
          }
        }
        br.litTable = buildHuffTable(lengths.subarray(0, hlit));
        br.distTable = buildHuffTable(lengths.subarray(hlit));
        inflateBlock(br, out);
      } else {
        throw new Error('inflate: 无效块类型');
      }
      if (bfinal) break;
    }
    // 零拷贝视图（旧实现是 Uint8Array.from(out)，多拷一份 3.7MB）
    return { bytes: out.bytes(), nextPos: br.pos };
  }

  // ==================================================================
  // PNG 解码
  // ==================================================================

  var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

  function paeth(a, b, c) {
    var p = a + b - c;
    var pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  // 逐行反滤波：只需要**两行**缓冲（旧实现一次性 new Uint8Array(h*stride)，
  // 1280x720 RGBA 就是 3.7MB 一整份）。每行反滤波完立刻交给 onRow 展开成 RGBA，
  // 于是解码期间的常驻缓冲从"整图"降到"两行"（10KB 级）。
  // ⚠️ onRow 必须**同步**消费掉 row（缓冲会被下一次迭代复用）。
  function unfilterRows(raw, h, bpp, stride, onRow) {
    var prev = new Uint8Array(stride);
    var cur = new Uint8Array(stride);
    for (var y = 0; y < h; y++) {
      var filter = raw[y * (stride + 1)];
      var src = y * (stride + 1) + 1;
      for (var x = 0; x < stride; x++) {
        var a = x >= bpp ? cur[x - bpp] : 0;
        var b = prev[x];
        var c = x >= bpp ? prev[x - bpp] : 0;
        var v = raw[src + x];
        var val;
        switch (filter) {
          case 0: val = v; break;
          case 1: val = v + a; break;
          case 2: val = v + b; break;
          case 3: val = v + ((a + b) >> 1); break;
          case 4: val = v + paeth(a, b, c); break;
          default: throw new Error('png: 未知 filter ' + filter);
        }
        cur[x] = val;   // Uint8Array 自动截断到 8 位（与原实现同语义）
      }
      onRow(cur, y);
      var t = prev; prev = cur; cur = t;   // 换缓冲：下一行写入旧 prev
    }
  }

  var ADAM7 = [
    { x0: 0, y0: 0, dx: 8, dy: 8 },
    { x0: 4, y0: 0, dx: 8, dy: 8 },
    { x0: 0, y0: 4, dx: 4, dy: 8 },
    { x0: 2, y0: 0, dx: 4, dy: 4 },
    { x0: 0, y0: 2, dx: 2, dy: 4 },
    { x0: 1, y0: 0, dx: 2, dy: 2 },
    { x0: 0, y0: 1, dx: 1, dy: 2 },
  ];

  // 把一行像素（按位深）展开到 RGBA
  function rowToRGBA(row, w, colorType, bitDepth, palette, trns, out, outOff) {
    function sample(xi) {
      // 取第 xi 个像素的原始值（灰度或调色板索引）
      var bitPos = xi * bitDepth;
      var byte = row[bitPos >> 3];
      var shift = 8 - bitDepth - (bitPos & 7);
      return (byte >> shift) & ((1 << bitDepth) - 1);
    }
    var p = outOff;
    if (colorType === 3) {
      for (var x = 0; x < w; x++) {
        var idx = sample(x);
        var o = idx * 3;
        out[p++] = palette[o]; out[p++] = palette[o + 1]; out[p++] = palette[o + 2];
        out[p++] = (trns && idx < trns.length) ? trns[idx] : 255;
      }
    } else if (colorType === 0) {
      var scale = 255 / ((1 << bitDepth) - 1);
      var key = trns ? (trns[0] << 8 | trns[1]) : -1;
      for (var x1 = 0; x1 < w; x1++) {
        var v8 = bitDepth === 16 ? row[x1 * 2] : Math.round(sample(x1) * scale);
        out[p++] = v8; out[p++] = v8; out[p++] = v8;
        out[p++] = (v8 === key && key >= 0) ? 0 : 255;
      }
    } else if (colorType === 2) {
      for (var x2 = 0; x2 < w; x2++) {
        var o2 = x2 * (bitDepth === 16 ? 6 : 3);
        out[p++] = row[o2]; out[p++] = row[o2 + 1]; out[p++] = row[o2 + 2];
        var key2 = trns ? [trns[0] << 8 | trns[1], trns[2] << 8 | trns[3], trns[4] << 8 | trns[5]] : null;
        out[p++] = (key2 && row[o2] === key2[0] && row[o2 + 1] === key2[1] && row[o2 + 2] === key2[2]) ? 0 : 255;
      }
    } else if (colorType === 4) {
      var step4 = bitDepth === 16 ? 4 : 2;
      for (var x3 = 0; x3 < w; x3++) {
        var o3 = x3 * step4;
        out[p++] = row[o3]; out[p++] = row[o3]; out[p++] = row[o3];
        out[p++] = bitDepth === 16 ? row[o3 + 2] : row[o3 + 1];
      }
    } else { // 6 = RGBA
      var step6 = bitDepth === 16 ? 8 : 4;
      for (var x4 = 0; x4 < w; x4++) {
        var o4 = x4 * step6;
        out[p++] = row[o4]; out[p++] = row[o4 + 1]; out[p++] = row[o4 + 2];
        out[p++] = bitDepth === 16 ? row[o4 + 4] : row[o4 + 3];
      }
    }
  }

  // 只读签名 + IHDR 的廉价尺寸探测：**不分配任何 w*h*4 缓冲**。
  // 用途：调用方（如玩家自定义遮罩）在真正解码前先看尺寸决定要不要解，
  // 避免"头部声明 30000x30000 → 直接申请 3.6GB → V8 fatal 干净退出"。
  // 失败返回 null（不是 PNG / 头部不完整），由调用方决定语义。
  function pngSize(data) {
    data = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (data.length < 33) return null;
    for (var s = 0; s < 8; s++) {
      if (data[s] !== PNG_SIG[s]) return null;
    }
    var len = (data[8] << 24 | data[9] << 16 | data[10] << 8 | data[11]) >>> 0;
    var type = String.fromCharCode(data[12], data[13], data[14], data[15]);
    if (type !== 'IHDR' || len < 13) return null;
    var b = 16;
    return {
      width: (data[b] << 24 | data[b + 1] << 16 | data[b + 2] << 8 | data[b + 3]) >>> 0,
      height: (data[b + 4] << 24 | data[b + 5] << 16 | data[b + 6] << 8 | data[b + 7]) >>> 0,
      bitDepth: data[b + 8],
      colorType: data[b + 9],
      interlace: data[b + 12],
    };
  }

  // 解码器自带一道"物理不可能"闸门：16MP（RGBA 64MB）以上一律拒绝。
  // 这不是给游戏用的业务限制（游戏内 JAR 图片都是小图），而是防止损坏/恶意
  // 头部把运行时一次顶死——那是 native/V8 级 fatal，JS 的 try/catch 拦不住。
  var MAX_DECODE_PIXELS = 16 * 1024 * 1024;

  function decodePNG(data) {
    data = data instanceof Uint8Array ? data : new Uint8Array(data);
    for (var s = 0; s < 8; s++) {
      if (data[s] !== PNG_SIG[s]) throw new Error('png: 签名不符');
    }
    var pos = 8;
    var w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
    var palette = null, trns = null;
    var idatChunks = [];
    var idatLen = 0;

    while (pos + 8 <= data.length) {
      var len = (data[pos] << 24 | data[pos + 1] << 16 | data[pos + 2] << 8 | data[pos + 3]) >>> 0;
      var type = String.fromCharCode(data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]);
      var body = pos + 8;
      if (type === 'IHDR') {
        w = (data[body] << 24 | data[body + 1] << 16 | data[body + 2] << 8 | data[body + 3]) >>> 0;
        h = (data[body + 4] << 24 | data[body + 5] << 16 | data[body + 6] << 8 | data[body + 7]) >>> 0;
        // 尺寸闸门：放在任何大分配之前（下面 zdata/inflated/rgba 都按它算）
        if (w && h && w * h > MAX_DECODE_PIXELS) {
          throw new Error('png: 尺寸过大 ' + w + 'x' + h + '（上限 ' +
            MAX_DECODE_PIXELS + ' 像素）');
        }
        bitDepth = data[body + 8];
        colorType = data[body + 9];
        if (data[body + 10] !== 0) throw new Error('png: 不支持的压缩方法');
        if (data[body + 11] !== 0) throw new Error('png: 不支持的 filter 方法');
        interlace = data[body + 12];
      } else if (type === 'PLTE') {
        palette = data.slice(body, body + len);
      } else if (type === 'tRNS') {
        trns = data.slice(body, body + len);
      } else if (type === 'IDAT') {
        idatChunks.push(data.subarray(body, body + len));
        idatLen += len;
      } else if (type === 'IEND') {
        break;
      }
      pos = body + len + 4; // 跳过 CRC
    }
    if (!w || !h) throw new Error('png: 缺少 IHDR');
    if (!idatChunks.length) throw new Error('png: 缺少 IDAT');

    var zdata = new Uint8Array(idatLen);
    var off = 0;
    for (var i = 0; i < idatChunks.length; i++) {
      zdata.set(idatChunks[i], off);
      off += idatChunks[i].length;
    }
    // zlib 头 2 字节 + Adler-32 尾 4 字节
    // 上限 = 声明尺寸算出的原始扫描行总量 ×2 + 64KB：正常 PNG 的 inflate 输出
    // 正好等于这个量，超了说明数据损坏或是"压缩炸弹"（会一路把内存吃光）。
    var inflCh = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] || 1;
    var expectRaw = h * (Math.ceil(w * inflCh * bitDepth / 8) + 1);
    var inflatedMax = expectRaw * 2 + 65536;
    var inflRes = inflateRaw(zdata, 2, inflatedMax);
    var inflated = inflRes.bytes;
    g.__pngLastStats = {
      inflateBytes: inflated.length,
      expectRaw: expectRaw,
      inflateBufCapacity: inflated.buffer ? inflated.buffer.byteLength : -1,
    };

    var channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!channels) throw new Error('png: 未知颜色类型 ' + colorType);

    var rgba = new Uint8Array(w * h * 4);

    function decodePass(x0, y0, dx, dy, srcOff) {
      var pw = Math.ceil((w - x0) / dx);
      var ph = Math.ceil((h - y0) / dy);
      if (!pw || !ph) return srcOff;
      var bpp = Math.max(1, Math.ceil(channels * bitDepth / 8));
      var stride = Math.ceil(pw * channels * bitDepth / 8);
      var rawLen = ph * (stride + 1);
      var raw = inflated.subarray(srcOff, srcOff + rawLen);
      var tmp = new Uint8Array(pw * 4);
      // 逐行：反滤波一行 → 立刻展开成 RGBA 并散射回整图（不再持有一整份 pixels）
      unfilterRows(raw, ph, bpp, stride, function (rowBytes, y) {
        rowToRGBA(rowBytes, pw, colorType, bitDepth, palette, trns, tmp, 0);
        // Adam7：pass 内像素按 dx 间隔、行按 dy 间隔散布回完整图
        for (var x = 0; x < pw; x++) {
          var src = x * 4;
          var dst = ((y0 + y * dy) * w + (x0 + x * dx)) * 4;
          rgba[dst] = tmp[src];
          rgba[dst + 1] = tmp[src + 1];
          rgba[dst + 2] = tmp[src + 2];
          rgba[dst + 3] = tmp[src + 3];
        }
      });
      return srcOff + rawLen;
    }

    if (interlace === 0) {
      decodePass(0, 0, 1, 1, 0);
    } else if (interlace === 1) {
      var srcOff = 0;
      for (var p = 0; p < 7; p++) {
        var pa = ADAM7[p];
        srcOff = decodePass(pa.x0, pa.y0, pa.dx, pa.dy, srcOff);
      }
    } else {
      throw new Error('png: 未知隔行模式 ' + interlace);
    }

    return { width: w, height: h, data: rgba };
  }

  g.__decodePNG = decodePNG;
  g.__pngSize = pngSize;
  g.__inflateRaw = function (data, pos, maxOut) { return inflateRaw(data, pos || 0, maxOut || 0).bytes; };
})(typeof globalThis !== 'undefined' ? globalThis : this);
