/*
 * make-icon.mjs — 生成 J2me-nx 的应用图标（perfZ35）
 *
 * 用途：
 *   ① icon.jpg 放到仓库根 → `npm run nro` / `npm run nsp` 会把它写进 NACP
 *      （@nx.js/nro 的规则：appRoot 下有 icon.jpg 就用，否则回落 nx.js 默认图标）；
 *   ② icon.png 给 NTON 之类的"NRO→NSP 前端"工具用（它们会自己转成 NACP 的 JPEG）。
 *
 * 设计：深蓝底 + 绿色"屏幕" + 手写 5x7 点阵字 "J2ME"（下方小字 nx）。
 * 不依赖任何字体文件，纯像素绘制，保证在 256x256 下清晰。
 *
 * 用法：node tools/make-icon.mjs [输出目录=仓库根]
 */
import { PNG } from '../tools/node_modules/pngjs/lib/png.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dirname, '..');
const S = 256;

// ---- 5x7 点阵字（只需这几个字符）----
const FONT = {
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10001, 0b10001, 0b10001, 0b10001],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  n: [0b00000, 0b00000, 0b10110, 0b11001, 0b10001, 0b10001, 0b10001],
  x: [0b00000, 0b00000, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001],
};
const GW = 5, GH = 7;

const png = new PNG({ width: S, height: S });
function px(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (S * y + x) << 2;
  png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a;
}
function rect(x, y, w, h, r, g, b) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(xx, yy, r, g, b);
}
function roundRect(x, y, w, h, rad, r, g, b) {
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      // 圆角裁切
      const cx = xx < rad ? rad - xx : (xx >= w - rad ? xx - (w - rad - 1) : 0);
      const cy = yy < rad ? rad - yy : (yy >= h - rad ? yy - (h - rad - 1) : 0);
      if (cx * cx + cy * cy > rad * rad) continue;
      px(x + xx, y + yy, r, g, b);
    }
  }
}
function text(str, x, y, scale, r, g, b) {
  let cx = x;
  for (const ch of str) {
    const glyph = FONT[ch];
    if (!glyph) { cx += (GW + 1) * scale; continue; }
    for (let gy = 0; gy < GH; gy++) {
      const row = glyph[gy];
      for (let gx = 0; gx < GW; gx++) {
        if (row & (1 << (GW - 1 - gx))) rect(cx + gx * scale, y + gy * scale, scale, scale, r, g, b);
      }
    }
    cx += (GW + 1) * scale;
  }
}
function textWidth(str, scale) { return str.length * (GW + 1) * scale - scale; }

// ---- 背景：竖向渐变（深蓝 → 近黑）+ 圆角外框 ----
for (let y = 0; y < S; y++) {
  const t = y / (S - 1);
  const r = Math.round(12 + 10 * (1 - t));
  const g = Math.round(22 + 26 * (1 - t));
  const b = Math.round(34 + 44 * (1 - t));
  rect(0, y, S, 1, r, g, b);
}
// 外圈：两像素的墨绿描边，像老掌机的塑料边
roundRect(0, 0, S, S, 26, 0, 0, 0);
for (let i = 0; i < 3; i++) {
  const inset = 6 + i * 2;
  roundRectStroke(inset, inset, S - inset * 2, S - inset * 2, 22 - i, 60 + i * 20, 150 + i * 20, 70 + i * 10);
}
function roundRectStroke(x, y, w, h, rad, r, g, b) {
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const cx = xx < rad ? rad - xx : (xx >= w - rad ? xx - (w - rad - 1) : 0);
      const cy = yy < rad ? rad - yy : (yy >= h - rad ? yy - (h - rad - 1) : 0);
      const d2 = cx * cx + cy * cy;
      if (d2 > rad * rad || d2 <= (rad - 2) * (rad - 2)) continue;
      px(x + xx, y + yy, r, g, b);
    }
  }
}

// ---- 中间的"游戏屏"：绿色发光面板 ----
const sw = 176, sh = 116, sx = (S - sw) >> 1, sy = 44;
roundRect(sx - 6, sy - 6, sw + 12, sh + 12, 14, 24, 34, 44);      // 机身
roundRect(sx, sy, sw, sh, 10, 8, 46, 24);                         // 屏幕底
// 屏幕内的两条扫描线纹理（淡淡的，增加"屏幕感"）
for (let y = sy + 2; y < sy + sh - 2; y += 4) rect(sx + 2, y, sw - 4, 1, 10, 62, 32);
// 标题文字（居中）
const t1 = 'J2ME';
text(t1, sx + ((sw - textWidth(t1, 5)) >> 1), sy + 22, 5, 226, 255, 232);
const t2 = 'nx';
text(t2, sx + ((sw - textWidth(t2, 4)) >> 1), sy + 74, 4, 130, 230, 150);

// ---- 底部按钮：十字键 + 两颗圆钮 ----
const by = sy + sh + 26;
rect(S - 116, by + 10, 34, 10, 40, 52, 62);   // 十字横
rect(S - 104, by - 2, 10, 34, 40, 52, 62);    // 十字竖
for (const [bx, col] of [[72, [210, 90, 90]], [104, [235, 180, 70]]]) {
  for (let yy = -10; yy <= 10; yy++) for (let xx = -10; xx <= 10; xx++) {
    const d = xx * xx + yy * yy;
    if (d <= 100) px(bx + xx, by + 15 + yy, col[0], col[1], col[2]);
  }
}

const pngPath = path.join(OUT, 'icon.png');
writeFileSync(pngPath, PNG.sync.write(png));
console.log('已生成 ' + pngPath + ' (' + S + 'x' + S + ')');
