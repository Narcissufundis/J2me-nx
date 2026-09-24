// 把用户给的"复古诺基亚.png"转成 1280x720 RGBA 裸数据，并设为默认遮罩
//
// 默认遮罩 = data/mask.raw（presenter 优先读 romfs:/mask.raw，package.mjs 会把它打进 romfs）。
//
// 2026-09-23 起不再需要 png 伴生文件：内置遮罩**全部**是 raw，`data/mask.png` 已删除，
// presenter 里那条"回落到 mask.png 走 JS 解码"的分支也一并删掉了（raw 缺失就是缺失，
// 不再用一张 1920x1080 的 PNG 去兜底——实机上那正是运行期大分配/秒退的嫌疑源）。
//
// 用法：node tools/make-default-mask.mjs
//   → 覆写 data/mask.raw，并打印"透明窗口"测量值。
// ⚠️ app/main.js 的 GX/GY/GW/GH 必须等于这个窗口（游戏画在遮罩**下层**，窗口小了
//    就会把游戏边缘压掉、大了就露黑边）。换源图后按打印值更新那两个常量，
//    tests/mask-assets.test.mjs 会盯着这件事。
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PNG } = require('./node_modules/pngjs');

const SRC = 'D:\\360MoveData\\Users\\Admin\\Desktop\\新建文件夹 (12)\\复古诺基亚.png';
const W = 1280, H = 720;
const OUT = 'data/mask.raw';

const png = PNG.sync.read(readFileSync(SRC));
console.log('源图: ' + png.width + 'x' + png.height + ' colorType=' + png.colorType);

// 缩放到 1280x720（最近邻：遮罩是像素风装饰图，最近邻不会糊边缘）
let rgba;
if (png.width === W && png.height === H) {
  rgba = png.data;
} else {
  rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(png.height - 1, Math.floor(y * png.height / H));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(png.width - 1, Math.floor(x * png.width / W));
      const si = (sy * png.width + sx) * 4, di = (y * W + x) * 4;
      rgba[di] = png.data[si]; rgba[di + 1] = png.data[si + 1];
      rgba[di + 2] = png.data[si + 2]; rgba[di + 3] = png.data[si + 3];
    }
  }
}

// 透明窗口 = alpha==0 像素的包围盒（游戏就画在这里，四角等装饰是 alpha=255 的不透明区）
let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, transparent = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (rgba[(y * W + x) * 4 + 3] === 0) {
      transparent++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
}
const win = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
const centerAlpha = rgba[((H >> 1) * W + (W >> 1)) * 4 + 3];

console.log('透明像素占比: ' + (transparent / (W * H) * 100).toFixed(1) + '%  中心 alpha=' + centerAlpha);
console.log('透明窗口: [' + win.x + ',' + win.y + ',' + win.w + ',' + win.h + ']');
if (centerAlpha !== 0 || win.w < W * 0.2 || win.h < H * 0.5) {
  console.error('!! 这张源图不像"中间透明窗"型遮罩（中心不透明或窗口过小），拒绝写入');
  process.exit(1);
}

writeFileSync(OUT, rgba);
console.log('已写 ' + OUT + ': ' + rgba.length + ' 字节（应为 ' + (W * H * 4) + '）');
console.log('→ 请确认 app/main.js 里 GX,GY,GW,GH = ' + win.x + ',' + win.y + ',' + win.w + ',' + win.h +
  '（MASK_DEFS 的 builtin.cut 同步）');
