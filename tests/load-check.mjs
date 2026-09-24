// 验证 png-decoder.js 在 "0; 前缀 + 间接 eval" 下的行为（与 app/main.js 一致）
import { readFileSync } from 'node:fs';
const code = readFileSync('F:/Deepseek/j2me-nx-port/src/host/png-decoder.js', 'utf8');
(0, eval)('0;\n' + code);
console.log('typeof __decodePNG =', typeof globalThis.__decodePNG);
console.log('typeof __inflateRaw =', typeof globalThis.__inflateRaw);
if (typeof globalThis.__decodePNG === 'function') {
  const z = require('node:zlib');
  const buf = z.deflateSync(Buffer.alloc(100, 5));
  console.log('inflate 自检:', globalThis.__inflateRaw(new Uint8Array(buf), 2).length);
}
