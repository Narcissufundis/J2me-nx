/*
 * switch-audio.js — audioplayer 管道的 WebAudio 实现（nx.js 适配层）
 *
 * 协议（与 midp/media.js 对应）：
 *   vendor -> host: {type:"start", contentType, data: byte[]}
 *                   {type:"pause"} {type:"play"} {type:"stop"} {type:"close"}
 *                   {type:"setVolume", data:0-100} {type:"setMute", data:bool}
 *                   {type:"getMediaTime"} {type:"setMediaTime", data:ms}
 *                   {type:"getDuration"}
 *   host -> vendor: {type:"end", duration:ms} {type:"mediaTime", data:ms}
 *                   {type:"duration", data:ms}
 *
 * 实现：AudioContext.decodeAudioData 解码（wav/mp3/ogg 由 nx.js 的 FFmpeg
 * 管线支持；AMR/MIDI 视固件支持情况），BufferSource + GainNode 播放。
 * 音调（Manager.playTone）vendor 已用振荡器自行实现，不经过此管道。
 */
'use strict';

(function () {
  var g = typeof globalThis !== 'undefined' ? globalThis : this;

  var audioCtx = null;
  // FFmpeg 解码门禁：只放行确定可解的格式。J2ME 游戏的 MIDI/AMR 数据喂给
  // FFmpeg 原生管线解不出来，且 beta.6 的解码线程出过原生崩溃（libuv-worker
  // 等待已释放 condvar，Data Abort）——宁可静音也不能带崩整个进程。
  var DECODABLE = /^(audio\/(x-)?(wav|wave|mpeg|mp3|ogg)|application\/ogg)$/i;
  var MAX_DECODE_BYTES = 8 * 1024 * 1024;

  function ctx() {
    if (!audioCtx) {
      var AC = g.AudioContext || g.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended' && audioCtx.resume) {
      audioCtx.resume();
    }
    return audioCtx;
  }

  g.__audioPlayerPipe = function (handler, pipeID, reply) {
    var current = null; // { source, gain, startedAt, offset, durationMs, playing }
    var cached = null;  // 本管道已解码的 AudioBuffer（vendor 重播语义见 'start' 分支）

    function endOfMedia() {
      reply(pipeID, { type: 'end', duration: current ? current.durationMs : 0 });
      current = null;
    }

    function playBuffer(decoded) {
      var ac = ctx();
      if (!ac) return;
      var source = ac.createBufferSource();
      var gain = ac.createGain();
      gain.gain.value = 1;
      source.buffer = decoded;
      source.connect(gain).connect(ac.destination);
      source.onended = function () {
        if (current && current.source === source) {
          endOfMedia();
        }
      };
      source.start();
      current = {
        source: source,
        gain: gain,
        startedAt: ac.currentTime,
        durationMs: decoded.duration * 1000,
        playing: true,
      };
    }

    handler.onMessage = function (message) {
      try {
      switch (message.type) {
        case 'start': {
          stopCurrent();
          var ct = String(message.contentType || '');
          var bytes = message.data ? new Uint8Array(message.data) : null;
          // PATCH(j2me-nx-port): vendor 的 AudioPlayer.start 首播后置 loaded=true，
          // 同一 Player 再次 start 只发 data=null（上游浏览器复用 <audio> 元素，
          // 数据不重复传）。宿主必须缓存解码结果，否则重播音效全是 0 字节被跳过
          // ——实机表现即"音效只有第一次有声"。
          if (cached && (!bytes || !bytes.length)) {
            playBuffer(cached);
            return;
          }
          if (!DECODABLE.test(ct) || !bytes || !bytes.length ||
              bytes.length > MAX_DECODE_BYTES) {
            if (typeof g.__sdMark === 'function') {
              g.__sdMark('[audio] 跳过解码 type=' + ct + ' bytes=' + (bytes ? bytes.length : 0));
            }
            reply(pipeID, { type: 'end', duration: 0 });
            return;
          }
          if (typeof g.__sdMark === 'function') {
            g.__sdMark('[audio] 解码开始 type=' + ct + ' bytes=' + bytes.length);
          }
          var ac = ctx();
          if (!ac) {
            reply(pipeID, { type: 'end', duration: 0 });
            return;
          }
          var bufferCopy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          ac.decodeAudioData(bufferCopy).then(function (decoded) {
            cached = decoded;
            playBuffer(decoded);
            if (typeof g.__sdMark === 'function') {
              g.__sdMark('[audio] 解码完成 ' + decoded.duration.toFixed(1) + 's');
            }
          }, function (err) {
            console.warn('[audio] 解码失败 (' + message.contentType + '): ' + err);
            reply(pipeID, { type: 'end', duration: 0 });
          });
          break;
        }
        case 'pause':
          if (current && current.playing) {
            var ac2 = ctx();
            current.offset = (ac2.currentTime - current.startedAt) * 1000;
            try { current.source.stop(); } catch (e) {}
            current.playing = false;
          }
          break;
        case 'play': // resume
          if (current && !current.playing) {
            var ac3 = ctx();
            var source = ac3.createBufferSource();
            source.buffer = current.source.buffer;
            source.connect(current.gain);
            source.onended = function () {
              if (current && current.source === source) endOfMedia();
            };
            source.start(0, (current.offset || 0) / 1000);
            current.source = source;
            current.startedAt = ac3.currentTime - (current.offset || 0) / 1000;
            current.playing = true;
          }
          break;
        case 'stop':
          stopCurrent();
          break;
        case 'close':
          stopCurrent();
          break;
        case 'setVolume':
          if (current && current.gain) {
            current.gain.gain.value = Math.max(0, Math.min(100, message.data)) / 100;
          }
          break;
        case 'setMute':
          if (current && current.gain) {
            current.gain.gain.value = message.data ? 0 : 1;
          }
          break;
        case 'getMediaTime': {
          var ms = 0;
          if (current) {
            var ac4 = ctx();
            ms = current.playing
              ? (ac4.currentTime - current.startedAt) * 1000
              : (current.offset || 0);
          }
          reply(pipeID, { type: 'mediaTime', data: ms });
          break;
        }
        case 'getDuration':
          reply(pipeID, { type: 'duration', data: current ? current.durationMs : 0 });
          break;
        case 'setMediaTime':
          // 简化：不支持 seek，直接回报当前位置
          reply(pipeID, { type: 'mediaTime', data: 0 });
          break;
        default:
          console.warn('[audio] 未知消息: ' + message.type);
      }
      } catch (e) {
        // 消息处理异常不能带崩管道，回报 end 让游戏侧继续
        if (typeof g.__sdMark === 'function') {
          g.__sdMark('[audio] 消息处理异常: ' + (e && e.message));
        }
        try { reply(pipeID, { type: 'end', duration: 0 }); } catch (e2) { /* 忽略 */ }
      }
    };

    function stopCurrent() {
      if (current) {
        try { current.source.stop(); } catch (e) {}
        current = null;
      }
    }

    handler.onClose = function () {
      stopCurrent();
    };
  };

  /* =====================================================================
   * __toneBank — 纯 JS PCM 合成（振荡器 / 滤波器的替代品）
   *
   * 背景（2026-09-20 实机定位）：nx.js 的 Web Audio 只实现了
   *   createGain / createBuffer / createBufferSource / createStereoPanner /
   *   decodeAudioData
   * 其余（createOscillator、createBiquadFilter、createDelay…）一律
   *   throw new Error('Method not implemented.')
   * 所以 vendor 侧任何振荡器写法都会在每个音符上抛异常 —— 实机表现就是
   * "能进游戏但全程无声"（error.log: [midi] 调度异常 createOscillator /
   * createBiquadFilter）。这里改成：在 JS 里把波形算成 PCM AudioBuffer，
   * 再用 BufferSource（+ Gain 包络）播放，只走 nx.js 已实现的 API。
   *
   *   loop(ac, wave, freq)           -> k 个完整周期的波表，loop=true 无缝
   *   sweep(ac, wave, f0, f1, dur)   -> 指数扫频（鼓的 kick / tom）
   *   noise(ac, kind, freq, dur, q)  -> JS 预滤波噪声（代替 BiquadFilter）
   *
   * 波表要点（两个都必须满足，否则会有"嗡"声或音不准）：
   *   1) 长度 L 必须是整数个周期（L = round(k*sr/f)）→ 循环点零相位跳变；
   *   2) 谐波数 ≤ L/(2k) - 1（循环波表自身的 Nyquist）→ 加法合成天生无混叠。
   * 采样取整带来的音高误差约 0.5/L（L≈4096 → 约 0.2 音分，听不出来）。
   * ===================================================================== */
  var tbLoop = {}, tbSweep = {}, tbNoise = {}, tbWhite = {};
  var TB_LOOP_MAX = 192, TB_SWEEP_MAX = 32, TB_NOISE_MAX = 24;
  var TB_TARGET_LEN = 4096; // 波表目标长度（采样）
  var TB_MAX_HARM = 64;     // 谐波上限（音色亮度 / CPU 折中）
  var TB_MIN_LEN = 256;

  function tbRate(ac) {
    var sr = ac && ac.sampleRate;
    return (sr >= 8000 && sr <= 192000) ? sr : 48000;
  }

  // FIFO 淘汰：缓存上限内不回收，超了丢最早的一个（够用，省 LRU 复杂度）
  function tbPut(cache, key, buf, cap) {
    cache[key] = buf;
    var keys = Object.keys(cache);
    if (keys.length > cap) delete cache[keys[0]];
    return buf;
  }

  // 谐波幅度表（n 从 1 起）：正弦只有基波，方波奇次 1/n，
  // 锯齿 ±1/n（交替符号＝真实相位），三角奇次 1/n² 交替。
  function tbHarm(wave, n) {
    switch (wave) {
      case 'square': return (n & 1) ? 1 / n : 0;
      case 'sawtooth': return ((n & 1) ? 1 : -1) / n;
      case 'triangle': return (n & 1) ? (((n & 3) === 1 ? 1 : -1) / (n * n)) : 0;
      default: return n === 1 ? 1 : 0; // sine
    }
  }

  function tbLoopBuffer(ac, wave, freq) {
    var sr = tbRate(ac);
    if (!(freq > 0)) freq = 440;
    var maxF = sr * 0.45;
    if (freq > maxF) freq = maxF;
    var key = sr + ':' + wave + ':' + freq.toFixed(4);
    if (tbLoop[key]) return tbLoop[key];

    var cycles = Math.max(1, Math.round(TB_TARGET_LEN * freq / sr));
    var len = Math.round(cycles * sr / freq);
    if (len < TB_MIN_LEN) len = TB_MIN_LEN;
    if (len > 65536) len = 65536;
    // 循环波表能表示的最高谐波：n*cycles < len/2
    var maxH = Math.floor(len / (2 * cycles)) - 1;
    if (maxH > TB_MAX_HARM) maxH = TB_MAX_HARM;
    if (maxH < 1) maxH = 1;

    var amps = [], norm = 0, n;
    for (n = 1; n <= maxH; n++) {
      var a = tbHarm(wave, n);
      amps.push(a);
      if (a < 0) norm -= a; else norm += a;
    }
    if (!(norm > 1e-6)) norm = 1;

    var buf = ac.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    var step = 2 * Math.PI * cycles / len;
    for (var i = 0; i < len; i++) {
      var ph = step * i, v = 0;
      for (var h = 0; h < amps.length; h++) {
        var amp = amps[h];
        if (amp !== 0) v += amp * Math.sin((h + 1) * ph);
      }
      d[i] = v / norm;
    }
    return tbPut(tbLoop, key, buf, TB_LOOP_MAX);
  }

  function tbSweepBuffer(ac, wave, f0, f1, dur) {
    var sr = tbRate(ac);
    if (!(dur > 0)) dur = 0.2;
    if (!(f0 > 0)) f0 = 100;
    if (!(f1 > 0)) f1 = f0;
    var key = sr + ':' + wave + ':' + f0.toFixed(2) + ':' + f1.toFixed(2) + ':' + dur.toFixed(3);
    if (tbSweep[key]) return tbSweep[key];

    var len = Math.max(64, Math.round(dur * sr));
    var buf = ac.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    var ratio = Math.log(f1 / f0); // 指数扫频 f(t) = f0 * (f1/f0)^(t/dur)
    var fade = Math.min(Math.round(0.003 * sr), len >> 1);
    var ph = 0;
    for (var i = 0; i < len; i++) {
      var f = f0 * Math.exp(ratio * (i / len));
      var v = (wave === 'triangle')
        ? (2 / Math.PI) * Math.asin(Math.sin(ph))
        : Math.sin(ph);
      if (fade > 0) {
        if (i < fade) v *= i / fade;
        else if (i >= len - fade) v *= (len - i) / fade;
      }
      d[i] = v;
      ph += 2 * Math.PI * f / sr;
      if (ph > 6.283185307179586) ph -= 6.283185307179586;
    }
    return tbPut(tbSweep, key, buf, TB_SWEEP_MAX);
  }

  // 确定性白噪（LCG）——不用 Math.random，保证同一 (kind,freq) 命中缓存后音色一致
  function tbWhiteArray(sr) {
    if (tbWhite[sr]) return tbWhite[sr];
    var len = sr; // 1 秒
    var a = new Float32Array(len), s = 0x2545F491;
    for (var i = 0; i < len; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      a[i] = (s / 0x40000000) - 1;
    }
    return (tbWhite[sr] = a);
  }

  function tbNoiseBuffer(ac, kind, freq, dur, q) {
    var sr = tbRate(ac);
    if (!(dur > 0)) dur = 0.1;
    if (!(freq > 0)) freq = 1000;
    if (!(q > 0)) q = 1;
    var key = sr + ':' + kind + ':' + Math.round(freq) + ':' + dur.toFixed(3) + ':' + q.toFixed(2);
    if (tbNoise[key]) return tbNoise[key];

    // RBJ 双二阶系数（normalized：全部除以 a0）
    var f0 = freq > sr * 0.45 ? sr * 0.45 : freq;
    var w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0), sw = Math.sin(w0);
    var alpha = sw / (2 * q);
    var b0, b1, b2, a0, a1, a2;
    if (kind === 'highpass') {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    } else if (kind === 'lowpass') {
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    } else { // bandpass（0 dB 峰值）
      b0 = alpha; b1 = 0; b2 = -alpha;
    }
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;

    var src = tbWhiteArray(sr);
    var len = Math.max(64, Math.round(dur * sr));
    var buf = ac.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    var fade = Math.min(Math.round(0.002 * sr), len >> 1);
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < len; i++) {
      var x0 = src[i % src.length];
      var y = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y;
      if (fade > 0) {
        if (i < fade) y *= i / fade;
        else if (i >= len - fade) y *= (len - i) / fade;
      }
      d[i] = y;
    }
    return tbPut(tbNoise, key, buf, TB_NOISE_MAX);
  }

  g.__toneBank = {
    loop: tbLoopBuffer,
    sweep: tbSweepBuffer,
    noise: tbNoiseBuffer,
    report: function () {
      return {
        loop: Object.keys(tbLoop).length,
        sweep: Object.keys(tbSweep).length,
        noise: Object.keys(tbNoise).length,
      };
    },
  };
})();
