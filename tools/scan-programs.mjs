// 扫描 MIDI 用到的 GM program（含 bank CC）与鼓组通道
import { readFileSync, writeFileSync } from 'node:fs';

function scan(path) {
  const b = readFileSync(path);
  let p = 0;
  const u32 = () => (b[p++] << 24 | b[p++] << 16 | b[p++] << 8 | b[p++]) >>> 0;
  const u16 = () => (b[p++] << 8 | b[p++]);
  const u8 = () => b[p++];
  if (u32() !== 0x4d546864) throw new Error('no MThd');
  u32(); const fmt = u16(), ntrk = u16(), div = u16();
  const programs = {}; // channel -> Set("bank:prog")
  let drums = new Set();
  for (let t = 0; t < ntrk; t++) {
    if (u32() !== 0x4d54726b) throw new Error('no MTrk');
    const len = u32(); const end = p + len;
    let run = 0, cc0 = 0, cc32 = 0;
    while (p < end) {
      let d = 0, c;
      do { c = u8(); d = (d << 7) | (c & 0x7f); } while (c & 0x80);
      let st = u8();
      if (st < 0x80) { p--; st = run; } else run = st;
      const hi = st & 0xf0, ch = st & 0x0f;
      if (st === 0xff) { const type = u8(); let l = 0; do { c = u8(); l = (l << 7) | (c & 0x7f); } while (c & 0x80); p += l; }
      else if (st === 0xf0 || st === 0xf7) { let l = 0; do { c = u8(); l = (l << 7) | (c & 0x7f); } while (c & 0x80); p += l; }
      else if (hi === 0x80 || hi === 0x90) { p += 2; }
      else if (hi === 0xa0 || hi === 0xb0) { const op = u8(); const v = u8(); if (hi === 0xb0) { if (op === 0) cc0 = v; else if (op === 32) cc32 = v; } }
      else if (hi === 0xc0) { const prog = u8(); const bank = cc32 << 7 | cc0; if (ch === 9) drums.add(prog); else { (programs[ch] ||= new Set()).add(bank + ':' + prog); } }
      else if (hi === 0xd0) { p += 1; }
      else if (hi === 0xe0) { p += 2; }
    }
    p = end;
  }
  return { fmt, div, programs: Object.fromEntries(Object.entries(programs).map(([k, v]) => [k, [...v]])), drums: [...drums] };
}

const dir = process.argv[2];
const out = {};
for (const n of ['s_mid0', 's_mid1', 's_mid2', 's_mid3']) {
  try { out[n] = scan(dir + '/' + n + '.mid'); } catch (e) { out[n] = 'ERR ' + ((e && e.message) || e); }
}
writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
