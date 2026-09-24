// 批量测试游戏分辨率探测算法（与 app/main.js detectGameResolution 同逻辑）
// 用法: node test-resolution.mjs <jar或目录>...  报告写 bld/resolution-report.txt
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const STD_RESOLUTIONS = [
  '128x128', '128x160', '132x176', '176x182', '176x200', '176x208',
  '176x220', '208x208', '240x260', '240x300', '240x320', '240x400',
  '240x432', '320x480', '352x416', '360x640', '480x640', '480x800',
  '480x854', '540x960',
];

function listJars(a) {
  const st = fs.statSync(a);
  if (st.isFile()) return [a];
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.jar$/i.test(e.name)) out.push(p);
    }
  })(a);
  return out;
}

// ---- 最小 zip 中央目录读取（method 0/8）----
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad CD sig @' + pos);
    const method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const lho = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('latin1');
    entries.push({ name, method, csize, lho });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: entries.map(e => e.name),
    read(name) {
      const e = entries.find(x => x.name === name);
      if (!e) return null;
      const nl = buf.readUInt16LE(e.lho + 26);
      const el = buf.readUInt16LE(e.lho + 28);
      const dataOff = e.lho + 30 + nl + el;
      const raw = buf.slice(dataOff, dataOff + e.csize);
      if (e.method === 0) return raw;
      if (e.method === 8) return zlib.inflateRawSync(raw);
      throw new Error('method ' + e.method);
    },
  };
}

function validSize(w, h) {
  if (w < 96 || h < 96 || w > 1280 || h > 1280) return false;
  const lo = Math.min(w, h), hi = Math.max(w, h);
  return STD_RESOLUTIONS.includes(lo + 'x' + hi);
}

function detect(zf) {
  const res = { w: 240, h: 320, how: '默认' };
  const names = zf.names;
  const counts = Object.create(null);
  const rx = /(?:^|[^0-9])(\d{2,4})[xX](\d{2,4})(?:[^0-9]|$)/;
  for (const nm of names) {
    const m = rx.exec(nm);
    if (!m) continue;
    const w = +m[1], h = +m[2];
    if (!validSize(w, h)) continue;
    const key = w + 'x' + h;
    counts[key] = (counts[key] || 0) + (nm.indexOf('/') >= 0 ? 2 : 1);
  }
  let best = null, bestScore = 0;
  for (const k in counts) {
    const [w, h] = k.split('x').map(Number);
    const score = counts[k] * 1e6 + w * h;
    if (score > bestScore) { bestScore = score; best = k; }
  }
  if (best) {
    const [w, h] = best.split('x').map(Number);
    return { w, h, how: '条目名x' + counts[best] };
  }
  const pngCount = Object.create(null);
  let inflated = 0, scanned = 0;
  for (const nm of names) {
    if (scanned >= 150 || inflated > 6 * 1024 * 1024) break;
    if (!/\.png$/i.test(nm)) continue;
    let data = null;
    try { data = zf.read(nm); } catch { continue; }
    if (!data || data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50) continue;
    inflated += data.length; scanned++;
    const pw = data.readUInt32BE(16), ph = data.readUInt32BE(20);
    if (!validSize(pw, ph)) continue;
    const pk = pw + 'x' + ph;
    pngCount[pk] = (pngCount[pk] || 0) + 1;
  }
  let bestPng = null, bestN = 0, bestArea = 0;
  for (const k in pngCount) {
    const [w, h] = k.split('x').map(Number);
    const a = w * h;
    if (pngCount[k] > bestN || (pngCount[k] === bestN && a > bestArea)) {
      bestN = pngCount[k]; bestArea = a; bestPng = k;
    }
  }
  if (bestPng && bestN >= 2) {
    const [w, h] = bestPng.split('x').map(Number);
    return { w, h, how: 'PNG尺寸x' + bestN };
  }
  return res;
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法: node test-resolution.mjs <jar或目录>...');
  process.exit(1);
}
const jars = [...new Set(args.flatMap(listJars))];
const lines = [];
for (const p of jars) {
  const row = { jar: p, name: '', cls: '', size: '', how: '', err: '' };
  try {
    const buf = fs.readFileSync(p);
    const zf = readZip(buf);
    const r = detect(zf);
    row.size = r.w + 'x' + r.h;
    row.how = r.how;
    row.orient = r.w > r.h ? '横屏' : '竖屏';
    // 顺带取游戏名
    try {
      const mf = zf.read('META-INF/MANIFEST.MF');
      if (mf) {
        const t = mf.toString('utf8');
        const mn = t.match(/^MIDlet-Name:\s*(.+)$/m);
        if (mn) row.name = mn[1].trim();
      }
    } catch { /* 无清单 */ }
  } catch (e) {
    row.err = String(e && e.message || e);
  }
  lines.push(`jar: ${p}`);
  lines.push(`  游戏名: ${row.name || '?'} | 探测: ${row.size} (${row.how}, ${row.orient || '-'})${row.err ? ' | 错误: ' + row.err : ''}`);
}
lines.push('');
lines.push(`共 ${jars.length} 个 jar`);
fs.mkdirSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'bld'), { recursive: true });
const out = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'bld', 'resolution-report.txt');
fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log('report written: ' + out);
