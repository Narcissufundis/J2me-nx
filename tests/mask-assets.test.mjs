/*
 * 内置遮罩资产回归测试（2026-09-23 perfZ6）
 *
 * 用户要求（当天）：
 *   ① 遮罩全部统一 1280x720；
 *   ② 默认遮罩改用"复古诺基亚.png"（缩放到 1280x720）；
 *   ③ 内置遮罩**一律 raw**，删除 png 版本。
 *
 * 为什么值得钉死：内置遮罩是"游戏画面能不能正常露出"的唯一几何来源——游戏画在
 * 遮罩**下层**，遮罩的透明窗小了就把游戏边缘压掉、位置不对就露黑边，而这类问题
 * 在桌面上完全看不出来（presenter 只在 IS_SWITCH 时安装），必须靠断言守着。
 * 另外 png 版本曾经是"raw 缺失就回落 png 走 JS 解码"的兜底，而实机上跑 PNG 解码
 * 正是大分配/秒退的嫌疑源（PERF 记录 §17），所以"包里不能有遮罩 png"也要断言。
 *
 * 运行：node tests/mask-assets.test.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mainSrc = readFileSync(join(root, 'app/main.js'), 'utf8');
const pkgSrc = readFileSync(join(root, 'tools/package.mjs'), 'utf8');

const W = 1280, H = 720, RAW_BYTES = W * H * 4;   // 3,686,400

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

// ---- 1. 注册表：内置遮罩全部 raw、尺寸都是 1280x720 ----
const defs = [];
{
  const m = mainSrc.match(/var MASK_DEFS = \[([\s\S]*?)\n  \];/);
  check('找到 MASK_DEFS 注册表', !!m, true);
  if (m) {
    for (const line of m[1].split('\n')) {
      const g = line.match(/\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)',\s*file:\s*'([^']+)',\s*w:\s*(\d+),\s*h:\s*(\d+),\s*cut:\s*\[([^\]]+)\]/);
      if (g) defs.push({ id: g[1], name: g[2], file: g[3], w: +g[4], h: +g[5], cut: g[6].split(',').map((s) => +s.trim()) });
    }
  }
  check('解析出 9 张内置遮罩（1 默认 + 8 可选）', defs.length, 9);
  const notRaw = defs.filter((d) => !/\.raw$/.test(d.file));
  check('内置遮罩文件全部是 .raw（不再有 png）', notRaw.map((d) => d.file).join(',') || '无', '无');
  const badSize = defs.filter((d) => d.w !== W || d.h !== H);
  check('注册表尺寸全部 1280x720', badSize.map((d) => d.name).join(',') || '无', '无');
}

// ---- 2. 磁盘：raw 文件字节数正好 = 1280*720*4；没有任何遮罩 png ----
{
  check('默认遮罩 data/mask.raw 存在', existsSync(join(root, 'data/mask.raw')), true);
  check('默认遮罩字节数 = 1280x720x4', existsSync(join(root, 'data/mask.raw')) ?
    readFileSync(join(root, 'data/mask.raw')).length : -1, RAW_BYTES);
  check('默认遮罩 png 版本已删除（data/mask.png 不应存在）',
    existsSync(join(root, 'data/mask.png')), false);

  const dir = join(root, 'data/masks');
  const files = existsSync(dir) ? readdirSync(dir) : [];
  // PATCH(perfZ24)：发布快照里**故意不带**这 28MB 可选素材（内容资产，见 NOTICE.md），
  // 所以要允许"没有 data/masks"的情况 —— 跳过而不是判失败，但必须打印出来，
  // 免得有人以为自己测过了（静默跳过 = 假绿，这仓库踩过）。
  if (files.length === 0) {
    console.log('  [skip] 没有 data/masks（可选素材，发布快照里不带）—— 跳过 4 项遮罩素材断言');
  } else {
    check('data/masks 里有 8 张遮罩', files.length, 8);
    const pngs = files.filter((f) => /\.png$/i.test(f));
    check('data/masks 下没有 png（全 raw）', pngs.join(',') || '无', '无');
    const wrong = files.filter((f) => readFileSync(join(dir, f)).length !== RAW_BYTES);
    check('每张遮罩正好 1280x720x4 字节', wrong.join(',') || '无', '无');
    // 注册表里的 8 张可选遮罩都得在磁盘上（漏拷/改名会在这里报出来）
    const missing = defs.filter((d) => !d.file.startsWith('romfs:/mask.raw'))
      .map((d) => d.file.replace('romfs:/masks/', ''))
      .filter((f) => !files.includes(f));
    check('注册表 8 张都能在 data/masks 找到', missing.join(',') || '无', '无');
  }
}

// ---- 3. 默认遮罩：透明窗必须等于 presenter 的 GX/GY/GW/GH（换图忘了改 = 画面错位） ----
{
  const g = mainSrc.match(/var GX = (\d+), GY = (\d+), GW = (\d+), GH = (\d+);/);
  check('解析出 presenter 窗口常量 GX/GY/GW/GH', !!g, true);
  const win = g ? [+g[1], +g[2], +g[3], +g[4]] : null;

  // 实测 data/mask.raw 的 alpha==0 包围盒
  const buf = readFileSync(join(root, 'data/mask.raw'));
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (buf[(y * W + x) * 4 + 3] === 0) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  const measured = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  check('默认遮罩透明窗 == presenter 窗口常量（换图后要同步）',
    measured.join(','), win ? win.join(',') : '未解析');
  check('默认遮罩透明窗在屏内（不越界）',
    x0 >= 0 && y0 >= 0 && x1 < W && y1 < H && measured[2] > 0 && measured[3] > 0, true);
  // 窗口中心透明、四角不透明 —— 这才是"中间留窗、四周装饰"的遮罩
  check('窗口中心 alpha=0', buf[((H >> 1) * W + (W >> 1)) * 4 + 3], 0);
  check('四角 alpha=255',
    [0, W - 1, (H - 1) * W, (H - 1) * W + W - 1].every((i) => buf[i * 4 + 3] === 255), true);
  // MASK_DEFS 里 builtin 的 cut 与 presenter 窗口一致（同一份几何，别各写各的）
  const builtin = defs.filter((d) => d.id === 'builtin')[0];
  check('builtin.cut == presenter 窗口', builtin ? builtin.cut.join(',') : '缺失', win ? win.join(',') : '未解析');
}

// ---- 4. 不再有 png 回落路径；打包不再拷 png ----
{
  // ⚠️ 只管**内置**遮罩（romfs:/mask.raw）。SD 卡上玩家自己放的 png 照旧支持，
  // 见第 6 节 —— 别把这条读成"不支持 png"了。
  check('app/main.js 不再读内置 romfs:/mask.png', /romfs:\/mask\.png/.test(mainSrc), false);
  check('app/main.js 的遮罩常量里没有内置 mask.png 字样',
    /mask\.png/.test(mainSrc.replace(/\/\/[^\n]*/g, '')), false);
  check('package.mjs 不再拷 data/mask.png', /copy\('data\/mask\.png'/.test(pkgSrc), false);
  check('package.mjs 仍拷 data/mask.raw', /copy\('data\/mask\.raw', 'mask\.raw'\)/.test(pkgSrc), true);
  check('package.mjs 仍拷 data/masks/*.raw', /data\/masks/.test(pkgSrc) && /\.raw/.test(pkgSrc), true);
}

// ---- 5. 生成工具存在且会报"实测窗口"（换图时的操作入口） ----
{
  const toolPath = join(root, 'tools/make-default-mask.mjs');
  check('默认遮罩生成工具存在', existsSync(toolPath), true);
  if (existsSync(toolPath)) {
    const t = readFileSync(toolPath, 'utf8');
    check('工具会打印实测透明窗', /透明窗口:/.test(t), true);
    check('工具会拒绝非"中间透明窗"型源图', /拒绝写入/.test(t), true);
    check('工具源图 = 复古诺基亚.png', /复古诺基亚\.png/.test(t), true);
  }
}

// ---- 6. SD 卡片玩家自定义遮罩（png / raw）读取必须不受内置改造影响 ----
// 用户明确要求（2026-09-23）：改成全 raw 只针对**内置**遮罩，SD 卡上自己放的
// 一般就是 png，那条路一分别动。这里把 SD 路径的关键实现钉住。
{
  const scanSrc = readFileSync(join(root, 'src/host/mask-scan.js'), 'utf8');
  const pngDec = join(root, 'src/host/png-decoder.js');

  check('SD 遮罩目录仍是 sdmc:/switch/j2me-nx/masks',
    /sdmc:\/switch\/j2me-nx\/masks/.test(mainSrc), true);
  check('SD 扫描仍接受 .png', /'\.png'\s*:\s*'png'/.test(scanSrc), true);
  check('SD 扫描仍接受 .raw', /'\.raw'\s*:\s*'raw'/.test(scanSrc), true);
  check('加载器仍有 png 分支（kind === png → 解码）', /def\.kind === 'png'/.test(mainSrc), true);
  check('加载器仍调 __pngSize 探尺寸（解码前零大分配）',
    /__pngSize\(bytes\)/.test(mainSrc), true);
  check('加载器仍调 __decodePNG 解码玩家 PNG', /g\.__decodePNG\(bytes\)/.test(mainSrc), true);
  check('PNG 尺寸闸门仍在（≤1280x720，防实机 fatal）',
    /MASK_MAX_PX = 1280 \* 720/.test(mainSrc) && /尺寸超限/.test(mainSrc), true);
  check('PNG 文件大小闸门仍在（≤8MB）', /MASK_MAX_BYTES = 8 \* 1024 \* 1024/.test(mainSrc), true);
  check('解码器仍在仓库里（打包会带上 host/png-decoder.js）', existsSync(pngDec), true);
  check('加载失败会回落而不是崩（catch 分支存在）',
    /def\.kind === 'png'[\s\S]{0,3000}\.catch\(function \(e\)/.test(mainSrc), true);
  // 内置改造只动了 romfs:/mask.raw 的读取与窗口常量，不该出现"顺手把 png 关掉"的痕迹
  check('没有把 __decodePNG 从宿主里摘掉', /__decodePNG/.test(mainSrc), true);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
