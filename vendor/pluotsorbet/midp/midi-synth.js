/* -*- Mode: Java; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/*
 * midi-synth.js — 纯 JS MIDI 合成器（j2me-nx-port 移植层）
 *
 * 背景：J2ME 游戏背景音乐绝大多数是 audio/midi。nx.js 的 FFmpeg 解码线程
 * 解不了 MIDI 且 beta.6 出过原生崩溃（见 switch-audio.js 的 DECODABLE 门禁），
 * 所以 MIDI 走纯 JS 合成。
 *
 * ★ 2026-09-20 无声根因修复：原实现每颗音符用 ac.createOscillator() ——
 *   mv2switch 实机核实 nx.js 的 BaseAudioContext **没有实现** createOscillator
 *   （createConstantSource/createConvolver/createDelay/createDynamicsCompressor/
 *   createIIRFilter/createOscillator/createPanner/createPeriodicWave/
 *   createScriptProcessor/createWaveShaper 一律 throw "Method not implemented."），
 *   异常被调度循环 try/catch 吞掉 → 每颗音符静默失败 = 全程无声。
 *
 *   新方案（只用 mv2switch 验证过能响的 API：createBuffer/createBufferSource/
 *   createGain/createBiquadFilter/AudioBuffer.getChannelData live view）：
 *     - 旋律：纯 JS 逐样本合成 PCM（波形 + ADSR 包络自己算），写进 AudioBuffer，
 *       用 BufferSource 按曲内时刻调度播放（start(when) 支持未来时刻）；
 *     - 分块渲染：2 秒/块，提前 5 秒，避免整首 PCM 的内存占用；
 *     - 打击乐：噪声 BufferSource + BiquadFilter + Gain（live 节点，同旧实现——
 *       旧实现里坏掉的只是 osc 分支），kick 用预渲染的正弦扫频 buffer。
 *   实现：SMF format 0/1、running status、meta（tempo/end）、sysex 全支持；
 *   解析期预计算绝对秒；渲染期预处理 note-on/off 配对 → 完整音符对象。
 */

'use strict';

// [midi] 探针：立即落盘（同 media.js mediaMark）。冻结/无声时最后一条 mark
// = 现场位置，实机日志的主要观察点。
//
// PATCH(j2me-nx-port perfZ24)：**限流**。__sdMark = sdLog + 立即 flush = 一次同步写卡，
// 而 MIDI/音效路径是"每个播放器/每个音效一条"——有的游戏每个音效建一个 Player，
// 于是"每个声音卡一下"（写卡几十毫秒全砸在游戏里）。现在：
//   * 每个 key 前 3 次完整落盘（首次现场最有价值）；
//   * 之后**每 25 次**留一条（这样"最后一条 mark = 死点"的语义仍然成立，
//     最多只会偏 25 次调用）；
//   * 每 ≥10s 追加一行"累计 N 次"（走批量 sdLog，不写卡）。
// key 取消息里 '=' 之前的部分（把 fmt=…/url=… 这些变量归并成同一类）。
var midiMarkStats = Object.create(null);

function midiMark(s) {
    try {
        var gg = (typeof globalThis !== "undefined" && globalThis) ||
                 (typeof jsGlobal !== "undefined" && jsGlobal) || null;
        if (!gg || typeof gg.__sdMark !== "function") {
            try { console.error(s); } catch (e2) { /* 忽略 */ }
            return;
        }
        var k = String(s).split("=")[0].slice(0, 60);
        var st = midiMarkStats[k];
        if (!st) { st = midiMarkStats[k] = { n: 0, logged: 0, last: 0 }; }
        st.n++;
        var now = Date.now();
        if (st.logged < 3) {
            st.logged++;
            gg.__sdMark(s);
            return;
        }
        if (st.n % 25 === 0) {
            gg.__sdMark(s);
            return;
        }
        if (now - st.last > 10000) {
            st.last = now;
            if (typeof gg.__sdLog === "function") {
                gg.__sdLog("[midi] " + k + " 累计 " + st.n + " 次（探针已限流，每 25 次留一条）");
            }
        }
    } catch (e) { /* 忽略 */ }
}

// GM program → timbre category. Returns a spec: {wave, attack, decay,
// sustain, release, gain}
Media.gmTimbre = function (program) {
    var p = program | 0;
    function spec(wave, attack, decay, sustain, release, gain) {
        return { wave: wave, attack: attack, decay: decay, sustain: sustain, release: release, gain: gain };
    }
    if (p <= 7) return spec("triangle", 0.005, 0.9, 0.25, 0.12, 0.55);      // 钢琴
    if (p <= 15) return spec("sine", 0.002, 0.5, 0.1, 0.1, 0.55);           // 半音打击
    if (p <= 23) return spec("square", 0.02, 0.1, 0.8, 0.1, 0.38);          // 风琴
    if (p <= 31) return spec("sawtooth", 0.005, 0.6, 0.2, 0.12, 0.42);      // 吉他
    if (p <= 39) return spec("triangle", 0.005, 0.15, 0.85, 0.1, 0.65);     // 贝斯
    if (p <= 47) return spec("sawtooth", 0.08, 0.1, 0.85, 0.3, 0.4);        // 弦乐
    if (p <= 55) return spec("sawtooth", 0.1, 0.1, 0.8, 0.35, 0.4);         // 合奏
    if (p <= 63) return spec("sawtooth", 0.04, 0.1, 0.8, 0.15, 0.42);       // 铜管
    if (p <= 79) return spec("square", 0.05, 0.1, 0.8, 0.15, 0.38);         // 簧管
    if (p <= 95) return spec("square", 0.01, 0.1, 0.75, 0.1, 0.38);         // 合成主音
    if (p <= 103) return spec("sawtooth", 0.2, 0.1, 0.8, 0.4, 0.35);        // 合成铺垫
    return spec("triangle", 0.01, 0.4, 0.4, 0.15, 0.5);                      // 其余
};

// ---------- libADLMIDI wasm 引擎（2026-09-20 音质路线更换） ----------
//
// 限带波表合成（下文）修好了蜂鸣，但对照 freej2me-web（用户自己的网页版
// J2ME 模拟器，D:/新建文件夹/myjump）实测听感仍明显是"合成器"而非"音源"。
// freej2me-web 的 6 条 MIDI 后端里默认的是 libADLMIDI（OPL3 FM 合成，wasm），
// 且 nx.js beta.6 的 V8 原生支持 WebAssembly（runtime/src/index.ts 明确注释
// "WebAssembly is provided NATIVELY by V8"）。Node 离线实测：47.5s 曲目
// 渲染仅 2.8s CPU（≈17 倍实时），贝斯/鼓点结构与 FluidSynth 参照完全对齐。
// 因此 MIDI 播放改为优先走本引擎，失败（无 WebAssembly/wasm 缺失/解析错）
// 回落纯 JS 波表合成——两条路径共用同一套分块调度骨架。
//
// glue：midp/adlmidi-core.js（转换后的 emscripten 模块，挂
// globalThis.__AdlMidiFactory）；wasm：romfs:/j2me/adlmidi.full.core.wasm。
// C API 细节见 adlmidi-core.js 头注释；关键点：_adl_play 的 count 是
// **int16 交错立体声样本数**（帧数*2），返回值 = 实际生成的样本数，< 请求
// 即曲终（含衰减尾音自然收完，不截断）。
Media.Adlmidi = {
    BANK: 58,          // freej2me-web 默认内嵌 FM 音色库
    ROMFS_WASM: 'romfs:/j2me/adlmidi.full.core.wasm',

    _module: null,
    _modulePromise: null,
    failed: false,

    readWasmBytes: function () {
        return new Promise(function (resolve, reject) {
            try {
                var g = typeof globalThis !== "undefined" ? globalThis : null;
                if (typeof Switch !== "undefined" && Switch && Switch.readFileSync) {
                    var ab = Switch.readFileSync(Media.Adlmidi.ROMFS_WASM);
                    if (!ab) { reject(new Error('wasm 读取为 null: ' + Media.Adlmidi.ROMFS_WASM)); return; }
                    resolve(ab instanceof ArrayBuffer ? new Uint8Array(ab) : new Uint8Array(ab.buffer, ab.byteOffset, ab.byteLength));
                    return;
                }
                // Node 仿真（离线验证引擎路径用）：测试脚本注入 __nodeRequire +
                // __adlmidiWasmPath 后可用；缺省视为不可用，走 JS 合成回落。
                if (g && g.__nodeRequire && g.__adlmidiWasmPath) {
                    var buf = g.__nodeRequire('fs').readFileSync(g.__adlmidiWasmPath);
                    resolve(new Uint8Array(buf));
                    return;
                }
                reject(new Error('无 wasm 读取通道（非 Switch 且未注入测试钩子）'));
            } catch (e) {
                reject(e);
            }
        });
    },

    // 首次调用编译 wasm 模块（全局缓存，多首歌共用一个 Module）
    loadModule: function () {
        var self = this;
        if (this._modulePromise) return this._modulePromise;
        this._modulePromise = new Promise(function (resolve, reject) {
            var g = typeof globalThis !== "undefined" ? globalThis : null;
            if (typeof WebAssembly === "undefined") { reject(new Error('WebAssembly 不可用')); return; }
            if (!g || typeof g.__AdlMidiFactory !== "function") { reject(new Error('adlmidi glue 未加载')); return; }
            self.readWasmBytes().then(function (bytes) {
                midiMark("[adl] wasm " + bytes.byteLength + "B，开始实例化");
                return g.__AdlMidiFactory({ wasmBinary: bytes });
            }).then(function (mod) {
                if (!mod || typeof mod._adl_init !== "function") {
                    reject(new Error('adlmidi 模块导出不完整'));
                    return;
                }
                self._module = mod;
                midiMark("[adl] 模块就绪");
                resolve(mod);
            }, reject);
        });
        this._modulePromise.catch(function (e) {
            self.failed = true;
            midiMark("[adl] 模块加载失败: " + ((e && e.message) || e));
        });
        return this._modulePromise;
    },

    // 打开一个引擎播放器（同一样本率可开多个 player，句柄式 C API）。
    // 失败 resolve(null)，绝不 reject——调用方据此回落 JS 合成。
    open: function (sampleRate) {
        return this.loadModule().then(function (mod) {
            var player = mod._adl_init(sampleRate | 0);
            if (!player) { midiMark("[adl] _adl_init 失败"); return null; }
            mod._adl_setBank(player, Media.Adlmidi.BANK);
            mod._adl_setLoopEnabled(player, 0); // 循环由 Java BasicPlayer 管
            return {
                mod: mod,
                player: player,
                bufPtr: 0,
                bufSamples: 0,
                // u8: Uint8Array 原始 SMF 字节
                loadMidi: function (u8) {
                    var ptr = this.mod._malloc(u8.length);
                    if (!ptr) return false;
                    this.mod.HEAPU8.set(u8, ptr);
                    var rc = this.mod._adl_openData(this.player, ptr, u8.length);
                    this.mod._free(ptr);
                    return rc === 0;
                },
                // 渲染 frames 帧（交错立体声 int16），返回实际生成样本数；
                // < 请求值 = 曲终。数据写入 wasm 堆，用 HEAP16 视图读。
                play: function (frames) {
                    var samples = frames * 2;
                    if (this.bufSamples < samples) {
                        if (this.bufPtr) this.mod._free(this.bufPtr);
                        this.bufPtr = this.mod._malloc(samples * 2);
                        if (!this.bufPtr) { midiMark("[adl] _malloc 失败"); return -1; }
                        this.bufSamples = samples;
                    }
                    var ret = this.mod._adl_play(this.player, samples, this.bufPtr);
                    return ret < 0 ? 0 : ret;
                },
                readInterleaved: function (outL, outR, frames, skip) {
                    var heap = this.mod.HEAP16, base = this.bufPtr >> 1;
                    for (var i = 0; i < frames; i++) {
                        outL[i] = heap[base + (i + skip) * 2] / 32768;
                        outR[i] = heap[base + (i + skip) * 2 + 1] / 32768;
                    }
                },
                positionSec: function () { return this.mod._adl_positionTell(this.player); },
                atEnd: function () { return this.mod._adl_atEnd(this.player) !== 0; },
                close: function () {
                    try { if (this.bufPtr) this.mod._free(this.bufPtr); } catch (e0) { }
                    try { this.mod._adl_close(this.player); } catch (e1) { }
                    this.bufPtr = 0; this.bufSamples = 0;
                }
            };
        }, function (e) {
            midiMark("[adl] open 失败: " + ((e && e.message) || e));
            return null;
        });
    }
};

function MidiPlayer(playerContainer) {
    this.playerContainer = playerContainer;

    this.audioContext = null;
    this.masterGain = null;
    this.noiseBuffer = null;   // 打击乐共用（live 节点方案）
    this.kickBuffer = null;    // 预渲染正弦扫频 kick

    this.events = null;        // 原始事件 [{t, kind, ch, note, vel, prog}]
    this.noteEvents = null;    // 预处理后的完整音符（含 dur / 音色 / 音量）
    this.duration = 0;         // 秒
    this.parseOk = false;

    this.paused = true;
    this.startedOnce = false;
    this.playOffset = 0;       // 暂停时的曲内位置（秒）
    this.startBase = 0;        // ctx.currentTime - playOffset
    this.renderIdx = 0;        // noteEvents 渲染指针
    this.renderedUntil = 0;    // 已渲染到的曲内秒
    this.carryNotes = [];      // 跨块的延音音符
    this.sources = [];         // 已调度的 BufferSource（pause 时统一停）
    this.renderAll = false;
    this.endSent = false;
    this.renderTimer = null;

    // libADLMIDI 引擎路径（useEngine=false 时走纯 JS 波表合成回落）
    this.useEngine = false;
    this.engine = null;        // {mod, player, play(), readInterleaved(), ...}
    this.engineDone = false;   // _adl_play 返回不足 = 曲终（尾音已入队）

    this.volume = 100;
    this.muted = false;

    this.isVideoControlSupported = false;
    this.isVolumeControlSupported = true;
}

// 2026-09-22 卡顿修复：块从 2.0s 降到 0.6s。旧参数下每 250ms 泵要同步渲染
// 96000 样本（48kHz×2s），JS 波表合成一块要上百 ms——游戏主循环被周期性顶住，
// 实机表现为"玩着玩着卡一下"。小块+高频泵把单次停顿摊薄。AHEAD 5→2 同理：
// 起 BGM/循环重播时不再一口气渲染 5 秒（2~3 块连发 = 秒级冻结）。
MidiPlayer.CHUNK_SEC = 0.6;    // 每块渲染时长
MidiPlayer.AHEAD_SEC = 2.0;    // 渲染提前量
// 临时禁用 ADLMIDI 引擎（BGM 循环未修通，见 beginPlayback 内注释）
MidiPlayer.ENGINE_DISABLED = true;
MidiPlayer.TIMER_MS = 120;     // 渲染泵间隔

// ---------- 共享 AudioContext（2026-09-22 卡顿修复） ----------
// 旧实现每个 MidiPlayer（含每次音效）都 new AudioContext 且 close() 从不调
// audioContext.close()——实机日志证实钻石rush每次 SFX 都新建 ctx。nx.js 侧
// 每次 new 都要走 SDL 设备/流分配（几十~几百 ms，主线程同步），且旧 ctx 泄漏
// 积压，Play 中后期出现"时不时卡几秒"。改为全局单例：各 Player 自挂
// masterGain 控音量，鼓组 buffer 全局缓存一份。

MidiPlayer._sharedCtx = null;
MidiPlayer._sharedDrums = null;

MidiPlayer.getSharedContext = function () {
    if (MidiPlayer._sharedCtx) {
        var sc = MidiPlayer._sharedCtx;
        if (sc.state === "suspended" && sc.resume) { try { sc.resume(); } catch (eR) { } }
        return sc;
    }
    var g = typeof globalThis !== "undefined" ? globalThis :
            (typeof jsGlobal !== "undefined" ? jsGlobal : null);
    var AC = (typeof AudioContext !== "undefined" && AudioContext) ||
             (g && g.AudioContext) || (g && g.webkitAudioContext) || null;
    if (!AC) return null;
    midiMark("[midi] 创建共享 AudioContext（全局唯一）");
    var ac = new AC();
    var sr = ac.sampleRate;
    // 鼓组预渲染 buffer（原 per-player 版本逐字节照搬，只换成挂在模块级缓存）
    var noiseBuffer = ac.createBuffer(1, sr * 0.5 | 0, sr);
    var nd = noiseBuffer.getChannelData(0);
    for (var i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    // 高通噪声（hat 类）：一阶差分
    var hatBuffer = ac.createBuffer(1, sr * 0.5 | 0, sr);
    var hd = hatBuffer.getChannelData(0);
    var hPrev = 0;
    for (var h = 0; h < hd.length; h++) {
        var w = Math.random() * 2 - 1;
        hd[h] = (w - hPrev) * 0.7;
        hPrev = w;
    }
    // 带通味噪声（snare）：白噪声减低通
    var snareBuffer = ac.createBuffer(1, sr * 0.3 | 0, sr);
    var sd = snareBuffer.getChannelData(0);
    var lp = 0;
    for (var s2 = 0; s2 < sd.length; s2++) {
        var w2 = Math.random() * 2 - 1;
        lp += (w2 - lp) * 0.25;
        sd[s2] = (w2 - lp) * Math.exp(-(s2 / sr) * 22) * 0.9;
    }
    // kick：预渲染正弦扫频（130→45Hz，指数衰减）
    var kLen = (sr * 0.3) | 0;
    var kickBuffer = ac.createBuffer(1, kLen, sr);
    var kd = kickBuffer.getChannelData(0);
    var phase = 0;
    for (var k = 0; k < kLen; k++) {
        var frac = k / kLen;
        var f = 130 + (45 - 130) * frac;
        phase += 2 * Math.PI * f / sr;
        kd[k] = Math.sin(phase) * Math.exp(-frac * 7);
    }
    // crash/ride：高通噪声长衰减
    var crashBuffer = ac.createBuffer(1, sr * 1.0 | 0, sr);
    var cd = crashBuffer.getChannelData(0);
    var cp = 0;
    for (var c2 = 0; c2 < cd.length; c2++) {
        var w3 = Math.random() * 2 - 1;
        cd[c2] = (w3 - cp) * 0.6 * Math.exp(-(c2 / sr) * 4);
        cp = w3;
    }
    MidiPlayer._sharedCtx = ac;
    MidiPlayer._sharedDrums = {
        noiseBuffer: noiseBuffer, hatBuffer: hatBuffer,
        snareBuffer: snareBuffer, kickBuffer: kickBuffer,
        crashBuffer: crashBuffer
    };
    midiMark("[midi] 共享 ctx 就绪 state=" + ac.state + " sr=" + sr);
    return ac;
};

// ---------- SMF 解析 ----------

// bytes: Int8Array（playerContainer.data 视图），恒 & 0xFF。
// 成功 → {events, duration}；失败 → null。
MidiPlayer.parse = function (bytes) {
    try {
        var u8 = new Uint8Array(bytes.length);
        for (var i0 = 0; i0 < bytes.length; i0++) u8[i0] = bytes[i0] & 0xFF;
        var d = u8, pos = 0;

        // 2026-09-20 冻结根因修复：本函数在主线程 setInterval 轮询里跑，而
        // fgDownload 是流式喂数据——游戏 start 时 MIDI 常常只到一半。旧实现
        // 拿截断数据硬解析，有两类挂死点（与 zipfile.js 修过的"越界无限
        // 零喂"同款）：
        //   1) 轨长字段超出已到缓冲 → pos 越界读 undefined → `continue` 不
        //      推进 pos → 主线程死循环 → 系统级冻结（HOME 无响应）；
        //   2) vlq 对越界/全续位数据无界循环。
        // 修复：所有读取严格边界检查，越界/畸形一律整体返回 null——语义为
        // "数据未到齐或损坏"，start 的轮询会在数据到齐后自然重试成功，
        // 绝不挂死主线程。
        function eof() { throw new RangeError("smf-eof"); }
        function need(n) { if (pos + n > d.length) eof(); }
        function u32() {
            need(4);
            var v = (d[pos] << 24) | (d[pos + 1] << 16) | (d[pos + 2] << 8) | d[pos + 3];
            pos += 4; return v >>> 0;
        }
        function u16() {
            need(2);
            var v = (d[pos] << 8) | d[pos + 1]; pos += 2; return v;
        }
        // SMF VLQ 最多 4 字节；越界或第 5 字节仍带续位 → 数据坏
        function vlq() {
            var v = 0, n = 0;
            for (;;) {
                if (n >= 4 || pos >= d.length) eof();
                var b = d[pos++];
                n++;
                v = (v << 7) | (b & 0x7F);
                if (!(b & 0x80)) return v;
            }
        }

        if (u32() !== 0x4D546864) return null; // "MThd"
        var headerLen = u32();
        var format = u16(), ntrks = u16(), division = u16();
        if (format > 2) return null;
        if (headerLen < 6 || headerLen > 64) return null;
        need(headerLen - 6);
        pos += headerLen - 6;
        if (division === 0) return null; // division=0 会让全部时间变 Infinity

        // SMPTE: 高位 1。negative SMPTE format: -fps, then ticks/frame
        var smpteFps = 0;
        if (division & 0x8000) {
            var fps = 256 - (division >> 8); // two's complement
            var tpf = division & 0xFF;
            smpteFps = fps * tpf; // ticks per second
            if (smpteFps <= 0) return null;
        }

        var events = [];
        var tempo = 500000; // us per quarter

        for (var t = 0; t < ntrks && pos < d.length; t++) {
            if (u32() !== 0x4D54726B) return null; // "MTrk"
            var len = u32();
            var end = pos + len;
            // 截断保护：轨声明长度超出已到数据 → 本次失败，等数据到齐重试
            if (end > d.length) return null;
            var tick = 0;
            var running = 0;
            var guard = len + 16; // 每个事件至少消耗 1 字节，兜底防一切意外死循环

            while (pos < end) {
                if (--guard < 0) return null;
                tick += vlq();
                need(1);
                var status = d[pos];
                if (status & 0x80) { pos++; } else if (running) { status = running; } else { return null; }
                running = (status >= 0x80 && status < 0xF0) ? status : running;

                if (status === 0xFF) { // meta
                    need(1);
                    var type = d[pos++];
                    var mlen = vlq();
                    if (pos + mlen > end) return null;
                    if (type === 0x51 && mlen === 3) { // tempo
                        tempo = (d[pos] << 16) | (d[pos + 1] << 8) | d[pos + 2];
                    }
                    pos += mlen;
                } else if (status === 0xF0 || status === 0xF7) { // sysex
                    var slen = vlq();
                    if (pos + slen > end) return null;
                    pos += slen;
                } else {
                    var hi = status & 0xF0, ch = status & 0x0F;
                    var sec;
                    if (smpteFps > 0) {
                        sec = tick / smpteFps;
                    } else {
                        sec = tick * (tempo / 1000000) / division;
                    }
                    if (hi === 0x90) { // note on/off
                        need(2);
                        var note = d[pos++] & 0x7F, vel = d[pos++] & 0x7F;
                        events.push({ t: sec, kind: vel > 0 ? "on" : "off", ch: ch, note: note, vel: vel });
                    } else if (hi === 0x80) {
                        need(2);
                        var note2 = d[pos++] & 0x7F; pos++;
                        events.push({ t: sec, kind: "off", ch: ch, note: note2, vel: 0 });
                    } else if (hi === 0xB0) { // CC
                        need(2);
                        var cc = d[pos++] & 0x7F, val = d[pos++] & 0x7F;
                        if (cc === 7 || cc === 11 || cc === 123) {
                            events.push({ t: sec, kind: "cc", ch: ch, cc: cc, val: val });
                        }
                    } else if (hi === 0xC0) { // program change
                        need(1);
                        var prog = d[pos++] & 0x7F;
                        events.push({ t: sec, kind: "prog", ch: ch, prog: prog });
                    } else if (hi === 0xE0) { // pitch bend
                        need(2);
                        var lo = d[pos++] & 0x7F, hi2 = d[pos++] & 0x7F;
                        events.push({ t: sec, kind: "bend", ch: ch, val: ((hi2 << 7) | lo) });
                    } else if (hi === 0xA0 || hi === 0xD0) {
                        need(2);
                        pos += 2;
                    } else {
                        return null; // 未知状态，宁可失败不乱响
                    }
                }
            }
            pos = end;
        }

        events.sort(function (a, b) { return a.t - b.t; });
        var duration = events.length ? events[events.length - 1].t + 0.5 : 0;
        return { events: events, duration: duration, division: division };
    } catch (e) {
        return null;
    }
};

// ---------- 音频上下文（只用验证过的 API） ----------

MidiPlayer.prototype.ensureContext = function () {
    // 2026-09-22 卡顿修复：改用全局共享 AudioContext（见 getSharedContext 注释）。
    // 每个 Player 只自建 masterGain 控音量/静音；鼓组 buffer 引用模块级缓存。
    if (!this.audioContext) {
        var ac = MidiPlayer.getSharedContext();
        if (!ac) {
            midiMark("[midi] AudioContext 不可用（typeof=" + (typeof AudioContext) + "）");
            return false;
        }
        this.audioContext = ac;
        this.masterGain = ac.createGain();
        this.masterGain.gain.value = this.muted ? 0 : this.volume / 100;
        this.masterGain.connect(ac.destination);
        var drums = MidiPlayer._sharedDrums;
        this.noiseBuffer = drums.noiseBuffer;
        this.hatBuffer = drums.hatBuffer;
        this.snareBuffer = drums.snareBuffer;
        this.kickBuffer = drums.kickBuffer;
        this.crashBuffer = drums.crashBuffer;
    }
    if (this.audioContext.state === "suspended" && this.audioContext.resume) {
        this.audioContext.resume();
    }
    return true;
};

// ---------- 音符预处理（解析后一次） ----------

// 把 events 加工成完整音符对象：配对 on/off 得 dur，现场取音色/弯音/通道音量。
// 之后渲染阶段不再需要处理任何 MIDI 事件语义。
MidiPlayer.prototype.buildNoteEvents = function () {
    var programs = new Array(16).fill(0);
    var cc7 = new Array(16).fill(100);
    var cc11 = new Array(16).fill(127);
    var bends = new Array(16).fill(8192);
    // on/off 配对表
    var onStack = {};
    var offMap = {};
    var evs = this.events;
    for (var i = 0; i < evs.length; i++) {
        var ev = evs[i];
        var key = ev.ch + ":" + ev.note;
        if (ev.kind === "on" && ev.ch !== 9) {
            if (!onStack[key]) onStack[key] = [];
            onStack[key].push(ev.t);
        } else if (ev.kind === "off" && ev.ch !== 9) {
            var stack = onStack[key];
            if (stack && stack.length) {
                var onT = stack.shift();
                offMap[onT.toFixed(4) + ":" + key] = Math.max(ev.t - onT, 0.05);
            }
        }
    }
    var notes = [];
    for (var j = 0; j < evs.length; j++) {
        var e = evs[j];
        switch (e.kind) {
            case "on": {
                var dur = 0.5;
                if (e.ch !== 9) {
                    var offT = offMap[e.t.toFixed(4) + ":" + e.ch + ":" + e.note];
                    if (offT !== undefined) dur = offT;
                } else {
                    dur = 0; // 打击乐时长由鼓组映射决定
                }
                var bend = bends[e.ch];
                var semis = (bend - 8192) / 8192 * 2; // ±2 半音
                var freq = 440 * Math.pow(2, (e.note - 69 + semis) / 12);
                var chanVol = Math.pow(cc7[e.ch] / 127, 1.5) * (cc11[e.ch] / 127);
                notes.push({
                    t: e.t, ch: e.ch, note: e.note, dur: dur,
                    drum: e.ch === 9,
                    freq: freq,
                    vel: Math.pow(e.vel / 127, 1.5) * chanVol,
                    timbre: e.ch === 9 ? null : Media.gmTimbre(programs[e.ch] | 0)
                });
                break;
            }
            case "prog": if (e.ch !== 9) programs[e.ch] = e.prog; break;
            case "bend": bends[e.ch] = e.val; break;
            case "cc":
                if (e.cc === 7) cc7[e.ch] = e.val;
                else if (e.cc === 11) cc11[e.ch] = e.val;
                // cc123（all-notes-off）不追溯已预配对的 dur——J2ME BGM 少用，
                // 换来渲染管线零状态，值得。
                break;
        }
    }
    this.noteEvents = notes; // events 已按 t 排序，notes 天然有序
};

// ---------- 波形与包络（纯 JS 逐样本） ----------

// note 包络值：tLocal = 距 note-on 的秒数。
// ★ 2026-09-20 蜂鸣根因修复：sustain 一度被当成**绝对电平**（如贝斯 0.85、
//   弦乐 0.85 都大于 peak=vel*gain），导致 decay 分支永远不生效——每个音
//   从起音直接满幅保持到 note-off，整条贝斯/弦乐线变成连续蜂鸣，谱分析
//   实测 46–156Hz 贝斯成为全曲最响成分、盖住旋律。ADSR 的 S 是**相对
//   peak 的比例**（0..1），这里改为 sus = timbre.sustain * peak。
MidiPlayer.envValue = function (tLocal, timbre, peak, dur) {
    var a = timbre.attack, dec = timbre.decay, sus = timbre.sustain * peak, rel = timbre.release;
    var v;
    if (tLocal < a) {
        v = peak * tLocal / a;
    } else if (tLocal < a + dec) {
        v = sus + (peak - sus) * (a + dec - tLocal) / dec;
    } else {
        v = sus;
    }
    if (tLocal > dur) {
        var x = tLocal - dur;
        if (x >= rel) return 0;
        // release 起点 = tLocal=dur 时的包络值，线性衰减到 0
        var base;
        if (dur < a) base = peak * dur / a;
        else if (dur < a + dec) base = sus + (peak - sus) * (a + dec - dur) / dec;
        else base = sus;
        v = base * (1 - x / rel);
    }
    return v;
};

// ---------- 限带波表（2026-09-20 音质修复） ----------

// ★ 原实现的旋律波形是逐样本原始 square/sawtooth（waveSample）——矩形/锯齿
//   的谐波直落到 Nyquist 之外，高频混叠产生金属质感的"蜂鸣"；且 sine 每样本
//   调 Math.sin 在 Switch 上偏慢。参照宿主 __toneBank（与 krkrsdl2 移植里
//   sonivox 波表合成同一思路）：按 (波形,频率) 预生成**整数周期、限带**的
//   加法合成波表，渲染时逐样本查表 + 环绕，音色干净且更快。
//
//   波表要点（缺一会出问题）：
//     1) 长度 L = 整数个周期（L = round(cycles*sr/f)）→ 循环点零相位跳变；
//     2) 谐波数 ≤ L/(2*cycles) - 1（表自身 Nyquist）→ 加法合成天生无混叠。
//   查表播放：每输出 1 样本表内推进 1 格，频率 = cycles*sr/L ≈ f
//   （取整误差 ≈ 0.5/L 半音的 0.2 音分级别，听不出）。

MidiPlayer.TABLE_TARGET = 4096; // 波表目标长度（样本）
MidiPlayer.TABLE_MAX_HARM = 48; // 谐波上限
MidiPlayer.TABLE_MIN_LEN = 256;
MidiPlayer.TABLE_CACHE_MAX = 256; // FIFO 淘汰上限
MidiPlayer.wavTables = {};

// 谐波幅度表（n 从 1 起）：正弦只有基波，方波奇次 1/n，
// 锯齿 ±1/n（交替符号＝真实相位），三角奇次 1/n² 交替。
MidiPlayer.tableHarm = function (wave, n) {
    switch (wave) {
        case "square": return (n & 1) ? 1 / n : 0;
        case "sawtooth": return ((n & 1) ? 1 : -1) / n;
        case "triangle": return (n & 1) ? (((n & 3) === 1 ? 1 : -1) / (n * n)) : 0;
        default: return n === 1 ? 1 : 0; // sine
    }
};

// 取 (波形,频率) 波表；未命中则构建。Float32Array，长度 = 整数周期。
MidiPlayer.getTable = function (sr, wave, freq) {
    if (!(freq > 0)) return null;
    var key = wave + "@" + sr + ":" + freq.toFixed(3);
    var t = MidiPlayer.wavTables[key];
    if (t) return t;

    var cycles = Math.max(1, Math.round(MidiPlayer.TABLE_TARGET * freq / sr));
    var len = Math.round(cycles * sr / freq);
    if (len < MidiPlayer.TABLE_MIN_LEN) len = MidiPlayer.TABLE_MIN_LEN;
    if (len > 65536) len = 65536;
    var maxH = Math.floor(len / (2 * cycles)) - 1;
    if (maxH > MidiPlayer.TABLE_MAX_HARM) maxH = MidiPlayer.TABLE_MAX_HARM;
    if (maxH < 1) maxH = 1;

    var amps = [], norm = 0;
    for (var n = 1; n <= maxH; n++) {
        var a = MidiPlayer.tableHarm(wave, n);
        amps.push(a);
        norm += a < 0 ? -a : a;
    }
    if (!(norm > 1e-6)) norm = 1;

    var table = new Float32Array(len);
    var step = 2 * Math.PI * cycles / len;
    for (var i = 0; i < len; i++) {
        var ph = step * i, v = 0;
        for (var h = 0; h < amps.length; h++) {
            var amp = amps[h];
            if (amp !== 0) v += amp * Math.sin((h + 1) * ph);
        }
        table[i] = v / norm;
    }
    MidiPlayer.wavTables[key] = table;
    var keys = Object.keys(MidiPlayer.wavTables);
    if (keys.length > MidiPlayer.TABLE_CACHE_MAX) {
        delete MidiPlayer.wavTables[keys[0]];
    }
    return table;
};

// ---------- 分块渲染 ----------

// 渲染曲内 [t0, t1) 的旋律 PCM 到 AudioBuffer 并调度播放。
MidiPlayer.prototype.renderChunk = function (t0, t1) {
    // PATCH(j2me-nx-port): 帧时间三分账探针——音频 PCM 渲染耗时计数
    var __at0 = Date.now();
    try {
    return renderChunkBody.call(this, t0, t1);
    } finally {
        var g = typeof globalThis !== "undefined" ? globalThis : null;
        if (g) g.__audMsAcc = (g.__audMsAcc || 0) + (Date.now() - __at0);
    }
};

function renderChunkBody(t0, t1) {
    var ac = this.audioContext;
    var sr = ac.sampleRate;
    var n = Math.round((t1 - t0) * sr);
    var buf = ac.createBuffer(1, n, sr);
    var data = buf.getChannelData(0);

    // 收集与块重叠的音符：carry（上块延音）+ 新到的
    var pool = [];
    for (var c = 0; c < this.carryNotes.length; c++) pool.push(this.carryNotes[c]);
    var evs = this.noteEvents;
    while (this.renderIdx < evs.length && evs[this.renderIdx].t < t1) {
        var ne = evs[this.renderIdx++];
        if (ne.drum) {
            // 打击乐走预渲染 buffer（2026-09-20：beta.6 无 BiquadFilter，
            // 不能让单颗鼓的异常炸掉整个块的旋律 PCM——独立 try/catch）
            try {
                this.scheduleDrum(ne, this.startBase + ne.t);
            } catch (eDrum) {
                midiMark("[midi] 鼓调度异常 note=" + ne.note + " @" + ne.t.toFixed(1) + "s " +
                    ((eDrum && eDrum.message) || eDrum));
            }
            continue;
        }
        if (ne.t + ne.dur + ne.timbre.release > t0) pool.push(ne);
    }
    this.carryNotes = [];

    for (var p = 0; p < pool.length; p++) {
        var note = pool[p];
        try {
        var tim = note.timbre;
        if (!tim) continue; // 异常音符防护（音色缺失不炸块）
        var peak = note.vel * tim.gain;
        if (peak <= 0) continue;
        var total = note.dur + tim.release;
        var s0 = Math.max(note.t, t0), s1 = Math.min(note.t + total, t1);
        if (s1 <= s0) continue;
        if (note.t + total > t1) this.carryNotes.push(note); // 延音续到下块
        var i0 = Math.round((s0 - t0) * sr), i1 = Math.round((s1 - t0) * sr);
        var table = MidiPlayer.getTable(sr, tim.wave, note.freq);
        if (!table) continue;
        var tlen = table.length;
        // 表内起始位置：距 note-on 的样本数（1 样本 = 表内 1 格）
        var idx = Math.round((s0 - note.t) * sr) % tlen;
        if (idx < 0) idx += tlen;
        for (var i = i0; i < i1; i++) {
            var tLocal = (i / sr) + (t0 - note.t);
            var env = MidiPlayer.envValue(tLocal, tim, peak, note.dur);
            if (env > 0) {
                data[i] += table[idx] * env;
            }
            idx++;
            if (idx >= tlen) idx -= tlen;
        }
        } catch (eNote) {
            midiMark("[midi] 音符渲染异常 note=" + note.note + " @" + note.t.toFixed(1) + "s " +
                ((eNote && eNote.message) || eNote));
        }
    }

    // 峰值钳位（nx.js 没有 DynamicsCompressor，不钳会爆音——mv2switch 教训）
    var peakV = 0;
    for (var q = 0; q < n; q++) { var av = data[q] < 0 ? -data[q] : data[q]; if (av > peakV) peakV = av; }
    if (peakV > 0.9) {
        var scale = 0.9 / peakV;
        for (var r = 0; r < n; r++) data[r] *= scale;
    }

    var src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(this.masterGain);
    var when = this.startBase + t0;
    if (when < ac.currentTime) when = ac.currentTime; // 迟到块立即播
    src.start(when);
    this.sources.push(src);
    if (this.sources.length > 16) {
        // 早期 source 已播完，引用及时丢弃
        this.sources.splice(0, this.sources.length - 8);
    }
};

// 打击乐（ch9）：全部预渲染 buffer + Gain（2026-09-20：beta.6 没有
// createBiquadFilter，滤波在 buffer 生成时做；BufferSource/Gain beta.6 可用）。
MidiPlayer.prototype.scheduleDrum = function (ne, when) {
    var ac = this.audioContext;
    if (when < ac.currentTime - 0.05) return; // 迟到太多直接扔
    if (!this.kickBuffer || !this.noiseBuffer || !this.hatBuffer ||
        !this.snareBuffer || !this.crashBuffer) return; // 上下文未初始化的防护
    var v = ne.vel;
    var self = this;
    function emit(buffer, dur, gainVal, rate) {
        var g = ac.createGain();
        g.gain.value = gainVal;
        g.connect(self.masterGain);
        var s = ac.createBufferSource();
        s.buffer = buffer;
        if (rate && s.playbackRate) s.playbackRate.value = rate;
        s.connect(g);
        s.start(when);
        s.stop(when + dur + 0.05);
    }
    var note = ne.note;
    switch (note) {
        case 35: case 36: // kick
            emit(this.kickBuffer, 0.28, 0.9 * v);
            break;
        case 38: case 40: // snare（噪声 + 高频 kick 点）
            emit(this.snareBuffer, 0.16, 0.6 * v);
            emit(this.kickBuffer, 0.1, 0.3 * v, 1.6);
            break;
        case 42: case 44: emit(this.hatBuffer, 0.05, 0.35 * v); break;         // closed hat
        case 46: emit(this.hatBuffer, 0.3, 0.3 * v); break;                    // open hat
        case 49: case 55: case 57: emit(this.crashBuffer, 0.8, 0.3 * v); break; // crash/ride
        case 51: emit(this.crashBuffer, 0.5, 0.25 * v); break;                 // ride
        default: emit(this.snareBuffer, 0.09, 0.3 * v, 1 + (note % 5) * 0.15); break;
    }
};

// 引擎块渲染：_adl_play 生成 [t0,t1) 的交错立体声 PCM → 双声道 AudioBuffer。
// 返回实际生成的帧数（< 请求帧数 = 曲终，剩余补零入队以收尾音）。
MidiPlayer.prototype.engineRenderChunk = function (t0, t1) {
    var ac = this.audioContext;
    var sr = ac.sampleRate;
    var frames = Math.round((t1 - t0) * sr);
    var eng = this.engine;
    var generated = eng.play(frames); // int16 样本数（=帧数*2 的满值即整块）
    if (generated < 0) return 0;
    var genFrames = Math.min(frames, generated >> 1);
    var buf = ac.createBuffer(2, frames, sr);
    var L = buf.getChannelData(0), R = buf.getChannelData(1);
    eng.readInterleaved(L, R, genFrames, 0);
    // 曲终块：未生成区清零（wasm 堆里那段可能是上块旧数据），尾音自然收完
    for (var z = genFrames; z < frames; z++) { L[z] = 0; R[z] = 0; }
    var src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(this.masterGain);
    var when = this.startBase + t0;
    if (when < ac.currentTime) when = ac.currentTime; // 迟到块立即播
    src.start(when);
    this.sources.push(src);
    if (this.sources.length > 16) {
        this.sources.splice(0, this.sources.length - 8);
    }
    return genFrames;
};

// 渲染泵：把 PCM 渲染保持到 currentTime + AHEAD_SEC。
MidiPlayer.prototype.renderTick = function () {
    var self = this;
    if (this.useEngine) {
        function enginePump() {
            if (self.paused || !self.audioContext || !self.engine) return;
            try {
                var now = self.audioContext.currentTime - self.startBase; // 曲内秒
                var horizon = now + MidiPlayer.AHEAD_SEC;
                while (self.renderedUntil < horizon && !self.engineDone) {
                    var t0 = self.renderedUntil;
                    var t1 = t0 + MidiPlayer.CHUNK_SEC;
                    var gen = self.engineRenderChunk(t0, t1);
                    self.renderedUntil = t0 + gen / self.audioContext.sampleRate;
                    // 曲终判定（2026-09-20 Node 实测）：_adl_play 在曲终后仍返回
                    // 满帧静音（整曲 95 块全部满帧，atEnd 后第一拍仍 48000/48000），
                    // "返回不足"不可靠，必须联合 _adl_atEnd()。
                    if (gen < Math.round((t1 - t0) * self.audioContext.sampleRate) ||
                        self.engine.atEnd()) {
                        self.engineDone = true; // 曲终：尾音已入队
                        break;
                    }
                }
                if (self.engineDone && !self.endSent &&
                    (now >= self.renderedUntil + 0.3 || now >= self.duration + 0.5)) {
                    self.endSent = true;
                    self.paused = true;
                    var ms = Math.round(Math.min(self.renderedUntil, self.duration) * 1000);
                    midiMark("[midi] 曲终，发送 EOM pId=" + self.playerContainer.pId +
                        " ms=" + ms + "（doLoop 重播走 BasicPlayer）");
                    MIDP.sendEndOfMediaEvent(self.playerContainer.pId, ms);
                    return;
                }
            } catch (e) {
                midiMark("[adl] 渲染异常 @" + self.renderedUntil.toFixed(1) + "s " +
                    ((e && e.message) || e));
                // 引擎路径失败一次即整体回落 JS 合成（从当前曲内位置续播）
                try { self.engine.close(); } catch (eC) { }
                self.engine = null;
                self.useEngine = false;
                self.engineDone = false;
                self.renderIdx = 0;
                self.carryNotes = [];
                while (self.renderIdx < self.noteEvents.length &&
                       self.noteEvents[self.renderIdx].t < self.renderedUntil) {
                    self.renderIdx++;
                }
            }
            self.renderTimer = setTimeout(enginePump, MidiPlayer.TIMER_MS);
        }
        clearTimeout(this.renderTimer);
        this.renderTimer = setTimeout(enginePump, MidiPlayer.TIMER_MS);
        return;
    }
    function pump() {
        if (self.paused || !self.audioContext) return;
        try {
            var now = self.audioContext.currentTime - self.startBase; // 曲内秒
            var horizon = now + MidiPlayer.AHEAD_SEC;
            // 兜底：引擎回落恢复时 renderedUntil 可能已越过曲长，renderIdx 已
            // 走完且无延音——此时 renderAll 永远不会被下面的循环置位，EOM 失联。
            if (self.renderIdx >= self.noteEvents.length && !self.carryNotes.length) {
                self.renderAll = true;
            }
            while (self.renderedUntil < horizon &&
                   (self.renderIdx < self.noteEvents.length || self.carryNotes.length)) {
                var t0 = self.renderedUntil;
                var t1 = t0 + MidiPlayer.CHUNK_SEC;
                if (t1 > self.duration + 1) t1 = self.duration + 1;
                self.renderChunk(t0, t1);
                self.renderedUntil = t1;
                if (self.renderIdx >= self.noteEvents.length && !self.carryNotes.length) {
                    self.renderAll = true;
                    break;
                }
            }
            if (self.renderAll && now >= self.duration + 0.5 && !self.endSent) {
                self.endSent = true;
                self.paused = true;
                var ms = Math.round(self.duration * 1000);
                MIDP.sendEndOfMediaEvent(self.playerContainer.pId, ms);
                return;
            }
        } catch (e) {
            midiMark("[midi] 渲染异常 @" + self.renderedUntil.toFixed(1) + "s " +
                ((e && e.message) || e));
            // 失败块直接跳过。绝不能停在原地重试——renderIdx 已推进，重试
            // 只会渲染出缺音符的块（旧版炸块丢旋律的帮凶之一）。
            self.renderedUntil = Math.min(self.renderedUntil + MidiPlayer.CHUNK_SEC,
                self.duration + 1);
        }
        self.renderTimer = setTimeout(pump, MidiPlayer.TIMER_MS);
    }
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(pump, MidiPlayer.TIMER_MS);
};

// ---------- 播放控制 ----------

MidiPlayer.prototype.realize = function () {
    var self = this;
    // 2026-09-20 关键修复：realize 绝不能等数据。
    // 反汇编 PlayerImpl.realize（classes.jar）证实：nRealize(native, 73) 挂起
    // 游戏线程等本 promise resolve，而喂数据的 MediaDownload.fgDownload()
    // 要到 215 才被调用——即 nRealize 返回之后。在这里等数据 = 死锁。
    // 数据会在 realize 返回后立刻由 fgDownload 同步灌入（writeBuffer）。
    return new Promise(function (resolve) {
        var d = self.playerContainer.data;
        if (d && self.playerContainer.contentSize >= 14) {
            try {
                var p = MidiPlayer.parse(d.subarray(0, self.playerContainer.contentSize));
                if (p && p.events.length) {
                    self.acceptParse(p);
                    console.error("[midi] realize 即解析成功：事件=" + p.events.length +
                        " 时长=" + p.duration.toFixed(1) + "s");
                    resolve(1);
                    return;
                }
            } catch (e) { /* 落到延迟解析 */ }
        }
        console.error("[midi] realize 放行（数据由 fgDownload 在 realize 后灌入，start 时解析）");
        resolve(1);
    });
};

MidiPlayer.prototype.acceptParse = function (parsed) {
    this.events = parsed.events;
    this.duration = parsed.duration;
    this.buildNoteEvents();
    this.parseOk = true;
};

/*
 * PATCH(j2me-nx-port) 2026-09-23：播放循环的游戏（Forgotten Warrior 每 1~2 秒就
 * stop→start 一次）会让下面几条诊断日志 1:1 打到 SD 卡上的 error.log
 * （3 行/次 ≈ 每小时 200KB，且都是 console.error）。前 3 次照旧全打（首次排障要看），
 * 之后每 50 次打一行并注明次数。真正的错误（超时/无 AudioContext）不降频。
 */
var midiStartLogCount = 0;
function midiStartLog(msg) {
    midiStartLogCount++;
    if (midiStartLogCount <= 3 || midiStartLogCount % 50 === 0) {
        console.error(msg + (midiStartLogCount > 3 ? "（第 " + midiStartLogCount + " 次起降频）" : ""));
    }
}

MidiPlayer.prototype.start = function () {
    var self = this;
    midiStartLog("[midi] start parseOk=" + this.parseOk +
        " data=" + (this.playerContainer.data ? this.playerContainer.contentSize + "B" : "null"));
    if (this.parseOk) { this.beginPlayback(); return; }
    // 数据可能刚好在 fgDownload 灌入途中（少见）或尚未到（异常路径）：
    // 异步轮询等解析，绝不阻塞 JS 线程。最多 8 秒。
    var waited = 0;
    this.waitTimer = setInterval(function () {
        waited += 100;
        if (self.parseOk) { clearInterval(self.waitTimer); self.waitTimer = null; self.beginPlayback(); return; }
        try {
            var d = self.playerContainer.data, sz = self.playerContainer.contentSize;
            if (d && sz >= 14) {
                var p = MidiPlayer.parse(d.subarray(0, sz));
                if (p && p.events.length) {
                    clearInterval(self.waitTimer); self.waitTimer = null;
                    midiStartLog("[midi] start 等待 " + waited + "ms 后解析成功：事件=" + p.events.length +
                        " 时长=" + p.duration.toFixed(1) + "s");
                    self.acceptParse(p);
                    self.beginPlayback();
                    return;
                }
            }
        } catch (e) { /* 数据不完整时解析可能抛错，下轮再试 */ }
        if (waited >= 8000) {
            clearInterval(self.waitTimer); self.waitTimer = null;
            var d2 = self.playerContainer.data;
            console.error("[midi] start 超时：8s 内数据未到（data=" +
                (d2 ? d2.length + "B 缓冲, size=" + self.playerContainer.contentSize : "null") +
                "）。若 data=null 说明 fgDownload 未跑或 SourceStream.read 不通");
        }
    }, 100);
};

MidiPlayer.prototype.beginPlayback = function () {
    if (!this.parseOk) {
        console.error("[midi] beginPlayback：解析未成功，放弃");
        return;
    }
    if (!this.ensureContext()) {
        console.error("[midi] 无法 start：AudioContext 不可用");
        return;
    }
    // 优先 ADLMIDI wasm 引擎（音质对齐 freej2me-web 默认后端）；任何失败
    // 都回落纯 JS 波表合成，绝不因引擎问题阻断播放。
    // 2026-09-20 临时禁用：引擎路径 BGM 不循环（曲终 EOM 链路仍未修通），
    // 用户决定先用 JS 波表合成（可正常循环）。修复循环后把下面改回 false。
    var self = this;
    if (MidiPlayer.ENGINE_DISABLED) {
        // 引擎被临时关闭：一次性提示，然后固定走 JS 合成
        if (!MidiPlayer._engineOffLogged) {
            MidiPlayer._engineOffLogged = true;
            console.error("[adl] 引擎已临时关闭（循环问题），使用 JS 波表合成");
        }
        this.beginPlaybackJS();
        return;
    }
    if (Media.Adlmidi && !Media.Adlmidi.failed) {
        Media.Adlmidi.open(this.audioContext.sampleRate).then(function (eng) {
            if (!eng || !self.parseOk) { self.beginPlaybackJS(); return; }
            var n = self.playerContainer.contentSize;
            var d = self.playerContainer.data;
            var raw = new Uint8Array(n);
            for (var i = 0; i < n; i++) raw[i] = d[i] & 0xFF; // data 是 Int8Array 视图
            if (!eng.loadMidi(raw)) {
                midiMark("[adl] openData 失败（数据未到齐或损坏），回落 JS 合成");
                eng.close();
                self.beginPlaybackJS();
                return;
            }
            self.engine = eng;
            self.useEngine = true;
            self.paused = false;
            self.playOffset = 0;
            self.renderIdx = 0;
            self.renderedUntil = 0;
            self.engineDone = false;
            self.startBase = self.audioContext.currentTime;
            console.error("[midi] ADLMIDI 引擎开始 duration=" + self.duration.toFixed(1) +
                "s sr=" + self.audioContext.sampleRate + " state=" + self.audioContext.state);
            self.renderTick();
        }).catch(function (e) {
            midiMark("[adl] start 异常: " + ((e && e.message) || e));
            self.beginPlaybackJS();
        });
        return;
    }
    this.beginPlaybackJS();
};

// 纯 JS 波表合成路径（原 beginPlayback 主体）
MidiPlayer.prototype.beginPlaybackJS = function () {
    this.paused = false;
    this.playOffset = 0;
    this.renderIdx = 0;
    this.renderedUntil = 0;
    this.carryNotes = [];
    this.renderAll = false;
    this.endSent = false;
    this.startBase = this.audioContext.currentTime;
    midiStartLog("[midi] 开始分块渲染 duration=" + this.duration.toFixed(1) +
        "s noteEvents=" + this.noteEvents.length + " state=" + this.audioContext.state);
    this.renderTick();
};

MidiPlayer.prototype.pause = function () {
    if (this.paused) return;
    if (this.useEngine) {
        // 引擎的合成状态停在 renderedUntil（比实际听到的多 AHEAD 内的已排队
        // 音频，stopSources 会截掉）。恢复只能从引擎状态处续播，会产生 ≤5s
        // 的跳段——J2ME BGM 的 pause 少见，以状态一致性优先。
        this.playOffset = this.renderedUntil;
    } else {
        this.playOffset = this.audioContext.currentTime - this.startBase;
    }
    this.paused = true;
    this.stopSources();
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
};

MidiPlayer.prototype.resume = function () {
    if (!this.paused || !this.parseOk || !this.ensureContext()) return;
    this.paused = false;
    this.startBase = this.audioContext.currentTime - this.playOffset;
    if (this.useEngine) {
        // 引擎合成状态本就停在 renderedUntil == playOffset，直接续泵
        this.endSent = false;
        this.renderTick();
        return;
    }
    // 跳过已过去的位置：从 playOffset 重新开始渲染
    this.renderIdx = 0;
    this.renderedUntil = this.playOffset;
    this.carryNotes = [];
    this.renderAll = false;
    this.endSent = false;
    while (this.renderIdx < this.noteEvents.length &&
           this.noteEvents[this.renderIdx].t < this.playOffset) {
        this.renderIdx++;
    }
    this.renderTick();
};

MidiPlayer.prototype.stopSources = function () {
    var now = this.audioContext ? this.audioContext.currentTime : 0;
    for (var i = 0; i < this.sources.length; i++) {
        try { this.sources[i].stop(now); } catch (e) { /* 忽略 */ }
    }
    this.sources = [];
};

MidiPlayer.prototype.close = function () {
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
    if (this.waitTimer) { clearInterval(this.waitTimer); this.waitTimer = null; }
    this.stopSources();
    if (this.engine) {
        try { this.engine.close(); } catch (eEng) { /* 忽略 */ }
        this.engine = null;
    }
    this.useEngine = false;
    if (this.masterGain) {
        try { this.masterGain.disconnect(); } catch (e) { /* 忽略 */ }
    }
    this.audioContext = null;
    this.masterGain = null;
    this.paused = true;
};

// ---------- Player 接口 ----------

MidiPlayer.prototype.getMediaTime = function () {
    if (this.paused && !this.audioContext) return 0;
    if (this.useEngine && this.engine) {
        // positionTell 是引擎曲内秒（权威值，含暂停恢复后的续播位置）
        try { return Math.round(Math.max(this.engine.positionSec(), 0) * 1000); }
        catch (eAdl) { /* 落到通用路径 */ }
    }
    var pos = this.paused ? this.playOffset : (this.audioContext.currentTime - this.startBase);
    return Math.round(Math.max(pos, 0) * 1000);
};

MidiPlayer.prototype.setMediaTime = function (ms) {
    // 不支持 seek；回报 0
    return 0;
};

MidiPlayer.prototype.getVolume = function () {
    return this.volume;
};

MidiPlayer.prototype.setVolume = function (level) {
    if (level < 0) level = 0; else if (level > 100) level = 100;
    this.volume = level;
    if (this.masterGain && !this.muted) {
        this.masterGain.gain.value = level / 100;
    }
    return level;
};

MidiPlayer.prototype.getMute = function () {
    return this.muted;
};

MidiPlayer.prototype.setMute = function (mute) {
    this.muted = mute;
    if (this.masterGain) {
        this.masterGain.gain.value = mute ? 0 : this.volume / 100;
    }
};

MidiPlayer.prototype.getDuration = function () {
    return Math.round(this.duration * 1000);
};

Media.MidiPlayer = MidiPlayer;
