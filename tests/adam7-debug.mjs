import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const code = readFileSync(join(import.meta.dirname, '..', 'src', 'host', 'png-decoder.js'), 'utf8');
const g = globalThis;
(new Function('globalThis', code))(g);
const decodePNG = g.__decodePNG;

function crc32t() { /* reuse minimal */ }
// 直接复用测试里的 makePNG 逻辑太长，这里手写一个 5x5 灰度 Adam7
const w = 5, h = 5;
const px = Uint8Array.from({ length: w * h }, (_, i) => i);
const ADAM7 = [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
const raw = [];
for (const [x0,y0,dx,dy] of ADAM7) {
  const pw = Math.ceil((w-x0)/dx), ph = Math.ceil((h-y0)/dy);
  if (!pw || !ph) continue;
  for (let pyi = 0; pyi < ph; pyi++) {
    raw.push(0);
    const sy = y0 + pyi*dy;
    for (let pxx = 0; pxx < pw; pxx++) {
      raw.push(px[sy*w + x0 + pxx*dx]);
    }
  }
}
console.log('raw bytes:', raw.join(','));

// 手写 PNG 组装
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const bt = Buffer.concat([Buffer.from(type,'ascii'), body]);
  const CRC_TABLE = (()=>{const t=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c;}return t;})();
  function crc32(buf){let c=-1;for(let i=0;i<buf.length;i++)c=CRC_TABLE[(c^buf[i])&0xff]^(c>>>8);return (c^-1)>>>0;}
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(bt));
  return Buffer.concat([len, bt, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=0; ihdr[12]=1;
const png = Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
  chunk('IEND', Buffer.alloc(0)),
]);
const r = decodePNG(new Uint8Array(png));
for (let y = 0; y < h; y++) {
  const row = [];
  for (let x = 0; x < w; x++) row.push(r.data[(y*w+x)*4]);
  console.log('row', y, '=', row.join(','), '  expect', Array.from({length:w},(_,x)=>y*w+x).join(','));
}
