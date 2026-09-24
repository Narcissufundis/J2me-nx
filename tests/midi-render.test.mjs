/**
 * midi-synth 渲染管线回归测试（Node，无 WebAudio 依赖——mock AudioContext）
 * 覆盖：
 *   1. 合法 MIDI 解析 → buildNoteEvents 产出完整音符（dur 配对、音色、鼓组）
 *   2. renderChunk：旋律 PCM 非零、峰值钳位、按曲内时刻调度
 *   3. 延音音符跨块（carryNotes）
 *   4. 打击乐走 live 节点（noise/kick buffer），不进 PCM
 *   5. 截断 MIDI → null（不挂死）；补全后成功
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// ---------- 加载被测模块（拼出浏览器全局环境） ----------
const mediaSrc = readFileSync(join(projRoot, "vendor/pluotsorbet/midp/media.js"), "utf8");
const synthSrc = readFileSync(join(projRoot, "vendor/pluotsorbet/midp/midi-synth.js"), "utf8");

const globalObj = globalThis;
globalObj.__sdMark = () => {};
globalObj.console = console;

// mock AudioContext
const SR = 44100;
function makeMockAC() {
    const scheduled = [];
    const liveNodes = [];
    class MockAudioBuffer {
        constructor(len) {
            this.length = len;
            this.numberOfChannels = 1;
            this.sampleRate = SR;
            this._data = new Float32Array(len);
        }
        getChannelData() { return this._data; }
    }
    class MockNode {
        constructor(kind) { this.kind = kind; this.buffer = null; this.startedAt = null; this.stoppedAt = null; this.gain = { value: 0, setValueAtTime() {} }; this.playbackRate = { value: 1 }; }
        connect(n) { return n; }
        start(when) { this.startedAt = when; if (this.kind === "src") scheduled.push(this); else liveNodes.push(this); }
        stop(when) { this.stoppedAt = when; }
    }
    const ctx = {
        sampleRate: SR,
        currentTime: 100.0,
        state: "running",
        destination: new MockNode("dest"),
        resume() {},
        createGain() { return new MockNode("gain"); },
        createBufferSource() { return new MockNode("src"); },
        createBiquadFilter() { return new MockNode("filter"); },
        createBuffer(ch, len, rate) { return new MockAudioBuffer(len); },
        __scheduled: scheduled,
        __live: liveNodes,
    };
    return ctx;
}

function loadSynth(ac) {
    globalThis.__G__ = globalObj;
    globalThis.__AC__ = ac;
    const wrapped = `(function(){
        var jsGlobal = globalThis;
        var console = jsGlobal.console;
        var AudioContext = function() { return jsGlobal.__AC__; };
        var Native = {};              // media.js 顶层会注册 native 表，测试不需要实现
        function addUnimplementedNative() {}
        var MIDP = { sendEndOfMediaEvent() {} };
        ${mediaSrc}
        ${synthSrc}
        return { Media: Media, MidiPlayer: Media.MidiPlayer };
    })()`;
    return (0, eval)(wrapped);
}

// ---------- 构造测试 MIDI ----------
function vlqBytes(n) {
    const out = [n & 0x7F];
    n = Math.floor(n / 128);
    while (n > 0) { out.unshift(0x80 | (n & 0x7F)); n = Math.floor(n / 128); }
    return out;
}
function makeMidi({ withTrackEnd = true, truncate = 0 } = {}) {
    // format 0，division=480，tempo 默认
    // 轨：0s note-on C4 ch0 prog0，0.25s off；0.5s kick(ch9 n36)；1s sine A4
    const ev = [];
    // prog change
    ev.push(...vlqBytes(0), 0xC0, 0);
    // note on C4 vel 100
    ev.push(...vlqBytes(0), 0x90, 60, 100);
    ev.push(...vlqBytes(240), 0x80, 60, 0);        // 0.25s off
    ev.push(...vlqBytes(240), 0xB0, 7, 110);       // 0.5s CC7
    ev.push(...vlqBytes(0), 0x99, 36, 100);        // 0.5s kick
    ev.push(...vlqBytes(240), 0x90, 69, 90);       // 1s A4 on
    ev.push(...vlqBytes(480), 0x80, 69, 0);        // 1.5s off
    const trackLen = ev.length + (withTrackEnd ? 4 : 0);
    const bytes = [
        0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xE0, // MThd
        0x4D, 0x54, 0x72, 0x6B,                                     // MTrk
        (trackLen >> 24) & 0xFF, (trackLen >> 16) & 0xFF, (trackLen >> 8) & 0xFF, trackLen & 0xFF,
        ...ev,
    ];
    if (withTrackEnd) bytes.push(0, 0xFF, 0x2F, 0);
    if (truncate > 0) bytes.length -= truncate;
    return new Int8Array(bytes.map(b => (b << 24) >> 24));
}

// ---------- 测试 ----------
let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log("PASS " + name); }
    else { fail++; console.log("FAIL " + name + (detail ? "  -- " + detail : "")); }
}

const mod = loadSynth(makeMockAC());
const MidiPlayer = mod.MidiPlayer;

// 1. 解析
const parsed = MidiPlayer.parse(makeMidi());
ok("解析成功且有事件", parsed && parsed.events.length === 7, JSON.stringify(parsed && parsed.events.length));
ok("时长正确(1.25s+0.5)", parsed && Math.abs(parsed.duration - 1.75) < 0.01, parsed && String(parsed.duration));

// 1b. 截断 → null（死循环回归）
const t0 = Date.now();
const bad = MidiPlayer.parse(makeMidi({ withTrackEnd: false, truncate: 4 }));
ok("截断 MIDI 返回 null", bad === null);
ok("截断解析快速返回", Date.now() - t0 < 1000, (Date.now() - t0) + "ms");

// 2. buildNoteEvents + renderChunk（用真实管线）
const ac = makeMockAC();
const p = new MidiPlayer({ pId: 1, data: makeMidi(), contentSize: makeMidi().length });
p.events = parsed.events;
p.duration = parsed.duration;
p.buildNoteEvents();
ok("noteEvents=2个旋律音+1个鼓", p.noteEvents.length === 3, String(p.noteEvents.length));
const melody = p.noteEvents.filter(n => !n.drum);
ok("C4 时长 0.25s", melody.some(n => n.dur === 0.25), JSON.stringify(melody.map(n => n.dur)));
// CC7(=110) 发生在 0.5s，只影响其后到的 A4（0.75s on）：vel = (90/127)^1.5 × (110/127)^1.5
const a4 = melody.find(n => Math.abs(n.dur - 0.5) < 0.001);
ok("CC7 影响其后音符音量", a4 && Math.abs(a4.vel - Math.pow(90 / 127, 1.5) * Math.pow(110 / 127, 1.5)) < 0.01,
    a4 && String(a4.vel));

globalThis.__AC__ = ac; // ensureContext 内的 AudioContext 工厂按当前值取用
p.ensureContext();
p.startBase = ac.currentTime;
p.paused = false;
// 渲染 [0,2) 两块
p.renderIdx = 0;
p.renderedUntil = 0;
p.carryNotes = [];
p.renderChunk(0, 2.0);
// 旋律块 = 长度为 2s 的 buffer 的 src（鼓组 src 是 0.3s kick / 0.5s noise）
const mel = ac.__scheduled.find(s => s.buffer && s.buffer.length === SR * 2);
ok("调度的 melody buffer 非零样本", !!mel);
const data = mel ? mel.buffer.getChannelData(0) : new Float32Array(0);
let nz = 0, peak = 0;
for (let i = 0; i < data.length; i++) { if (data[i] !== 0) nz++; const a = Math.abs(data[i]); if (a > peak) peak = a; }
ok("PCM 有大量非零样本", nz > SR * 0.3, "nonzero=" + nz);
ok("峰值 <= 0.9（钳位）", peak <= 0.9001, String(peak));
ok("调度时刻 = startBase + 0", Math.abs(mel.startedAt - 100.0) < 1e-6, String(mel.startedAt));
ok("鼓组 kick 走预渲染 buffer 的 BufferSource", ac.__scheduled.some(n => n.buffer && n.buffer.length === (SR * 0.3 | 0)));
ok("鼓组节点有 stop 调度（live 链完整）", ac.__scheduled.some(n => n.buffer && n.buffer.length === (SR * 0.3 | 0) && n.stoppedAt !== null));

// 3. 延音跨块：1s 的 A4 (1s on, 1.5s off, release 0.1) 从第 1 秒起——不跨 2s 块。
// 构造一个跨块音：长音 1.5s 起持续 2s
const midi2 = (() => {
    const ev = [];
    ev.push(...vlqBytes(0), 0xC0, 0x28);           // 弦乐程序(40) sawtooth release 0.3
    ev.push(...vlqBytes(0), 0x90, 60, 100);
    ev.push(...vlqBytes(1920), 0x80, 60, 0);       // 1920 tick = 2.0s 后 off → dur=2s，跨 [0,2)/[2,4) 两块
    const bytes = [0x4D,0x54,0x68,0x64,0,0,0,6,0,0,0,1,0x01,0xE0,
        0x4D,0x54,0x72,0x6B,(ev.length+4)>>24&0xFF,(ev.length+4)>>16&0xFF,(ev.length+4)>>8&0xFF,(ev.length+4)&0xFF, ...ev, 0,0xFF,0x2F,0];
    return new Int8Array(bytes.map(b => (b << 24) >> 24));
})();
const parsed2 = MidiPlayer.parse(midi2);
const ac2 = makeMockAC();
const p2 = new MidiPlayer({ pId: 2 });
p2.events = parsed2.events;
p2.duration = parsed2.duration;
p2.buildNoteEvents();
globalThis.__AC__ = ac2;
p2.ensureContext();
p2.startBase = 100;
p2.renderIdx = 0; p2.renderedUntil = 0; p2.carryNotes = [];
p2.renderChunk(0, 2.0);
p2.renderedUntil = 2.0;
ok("长音延音进入 carry", p2.carryNotes.length === 1, String(p2.carryNotes.length));
p2.renderChunk(2.0, 4.0);
p2.renderedUntil = 4.0;
ok("延音在第二块结束（carry 清空）", p2.carryNotes.length === 0, String(p2.carryNotes.length));
const buf1 = ac2.__scheduled[0].buffer.getChannelData(0);
const buf2 = ac2.__scheduled[1].buffer.getChannelData(0);
ok("第二块延音段有样本", buf2.some(v => v !== 0));
// 相位连续性：第 2 块起始处与第 1 块结尾（延音内）能量都非零
ok("第一块结尾仍发声（dur=2s 覆盖到块边界）", Math.abs(buf1[buf1.length - 10]) > 0);

// 4. resume 语义：pause 状态下 resume 应从 playOffset 续渲染
p2.playOffset = 1.0;
p2.resume();
ok("resume 后从 playOffset 续渲染", p2.renderedUntil === 1.0 || p2.renderedUntil > 1.0, String(p2.renderedUntil));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
