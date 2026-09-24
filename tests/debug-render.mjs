import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mediaSrc = readFileSync(join(root, "vendor/pluotsorbet/midp/media.js"), "utf8");
const synthSrc = readFileSync(join(root, "vendor/pluotsorbet/midp/midi-synth.js"), "utf8");
globalThis.__AC__ = null;
const wrapped = `(function(){
    var jsGlobal = globalThis;
    var console = jsGlobal.console;
    var Native = {};
    function addUnimplementedNative() {}
    var MIDP = { sendEndOfMediaEvent() {} };
    ${mediaSrc}
    ${synthSrc}
    return { Media, MidiPlayer };
})()`;
const mod = (0, eval)(wrapped);
const MidiPlayer = mod.MidiPlayer;

// 1s A4 音符的包络/波形诊断
const tim = { wave: "triangle", attack: 0.005, decay: 0.9, sustain: 0.25, release: 0.12, gain: 0.55 };
console.log("env 0.001:", MidiPlayer.envValue(0.001, tim, 0.34, 0.25));
console.log("env 0.5:", MidiPlayer.envValue(0.5, tim, 0.34, 0.25));
console.log("wave tri:", MidiPlayer.waveSample("triangle", 1.0));

// 走完整 renderChunk
function vlqBytes(n){const o=[n&0x7F];n=Math.floor(n/128);while(n>0){o.unshift(0x80|(n&0x7F));n=Math.floor(n/128);}return o;}
const SR = 44100;
class MockAudioBuffer { constructor(len){this.length=len;this._d=new Float32Array(len);} getChannelData(){return this._d;} }
class MockNode { constructor(k){this.kind=k;this.buffer=null;this.startedAt=null;this.gain={value:0};this.playbackRate={value:1};} connect(n){return n;} start(w){this.startedAt=w;} stop(){} }
const ac = {
    sampleRate: SR, currentTime: 100, state: "running",
    destination: new MockNode("dest"), resume(){},
    createGain(){return new MockNode("gain");},
    createBufferSource(){return new MockNode("src");},
    createBiquadFilter(){return new MockNode("filter");},
    createBuffer(c,len){return new MockAudioBuffer(len);},
    __scheduled: [],
};
const ev = [0,0xC0,0, 0,0x90,60,100, ...vlqBytes(240),0x80,60,0, 0,0xFF,0x2F,0];
const bytes = [
    0x4D,0x54,0x68,0x64,0,0,0,6,0,0,0,1,0x01,0xE0,
    0x4D,0x54,0x72,0x6B, (ev.length>>24)&0xFF,(ev.length>>16)&0xFF,(ev.length>>8)&0xFF,ev.length&0xFF, ...ev
];
const parsed = MidiPlayer.parse(new Int8Array(bytes.map(b=>(b<<24)>>24)));
console.log("parsed:", parsed && parsed.events.length, parsed && parsed.duration);
const p = new MidiPlayer({ pId: 1 });
p.events = parsed.events; p.duration = parsed.duration;
p.buildNoteEvents();
console.log("noteEvents:", JSON.stringify(p.noteEvents));
p.ensureContext();
p.startBase = 100;
p.renderIdx = 0; p.renderedUntil = 0; p.carryNotes = [];
try {
    p.renderChunk(0, 2.0);
} catch (e) { console.log("renderChunk THREW:", e.stack); }
const mel = ac.__scheduled.find(s => s.buffer && s.buffer.length === SR * 2);
console.log("scheduled:", ac.__scheduled.map(s => s.buffer ? s.buffer.length : "nullbuf"));
if (mel) {
    const d = mel.buffer.getChannelData(0);
    let nz = 0; for (const v of d) if (v !== 0) nz++;
    console.log("nonzero:", nz, "of", d.length);
} else {
    console.log("NO melody chunk scheduled");
}
