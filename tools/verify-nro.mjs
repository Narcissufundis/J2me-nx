/*
 * verify-nro.mjs — NRO 产物字节自检
 *
 * 用法：node tools/verify-nro.mjs <nro 路径> [--expect-kb 103xxx]
 *
 * 为什么需要：实机测试成本高，凡是"源码里有、产物里没有"的漏拷（png-decoder.js
 * 曾漏过一次），只有在 Switch 上启动那一刻才暴露。这里直接把 romfs 里的关键
 * 标记、脚本个数、遮罩张数从 NRO 字节里数出来，构建完立刻能判断包对不对。
 *
 * 注意：中文标记按 UTF-8 原样找（romfs 里的 .js 是不压缩存储的）；
 *      若某天 romfs 改成压缩存储，本脚本会退化成"找不到标记"，届时用
 *      `strings` 式的解压校验替代。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = process.argv[2];
if (!file) { console.error('用法: node tools/verify-nro.mjs <nro 路径> [--out 文件]'); process.exit(2); }
// --out：直接写 UTF-8 文件（PowerShell 的 `>` 会把中文写坏）
const oi = process.argv.indexOf('--out');
const outPath = oi >= 0 ? process.argv[oi + 1] : null;
const buf = readFileSync(file);
const count = (s) => {
  const needle = Buffer.from(s, 'utf8');
  let n = 0, i = 0;
  for (;;) {
    const at = buf.indexOf(needle, i);
    if (at < 0) break;
    n++; i = at + needle.length;
  }
  return n;
};
// romfs/main.js 经过 esbuild → 中文被转义成 ASCII 的 \uXXXX 字面量，
// 直接找 UTF-8 中文会得到 0。所以中文标记两种形态都数一遍。
const esc = (s) => [...s].map((c) => '\\u' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join('');
const countBoth = (s) => count(s) + count(esc(s));
// 标记写成 're:<正则>' 时按正则数（打包器会压空格/换引号，比如
// `"-20": 8` 会变成 `"-20":8`，字面量匹配就会漏）
const countRe = (pattern) => {
  const re = new RegExp(pattern, 'g');
  const text = buf.toString('latin1');
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
};
const countMark = (m) => (m.indexOf('re:') === 0 ? countRe(m.slice(3)) : countBoth(m));

const rows = [];
rows.push(`文件        ${file}`);
rows.push(`大小        ${buf.length} B (${(buf.length / 1048576).toFixed(2)} MB)`);
rows.push(`sha256      ${createHash('sha256').update(buf).digest('hex').toUpperCase()}`);
rows.push('');

// ---- 结构：nx.js NRO 头（前 16 字节内含 HOMEBREW 魔数） ----
const head = buf.subarray(0, 64).toString('latin1');
rows.push(`NRO 头      ${head.includes('HOMEBREW') || head.includes('NRO0') ? 'ok' : '异常: ' + JSON.stringify(head.slice(0, 24))}`);
rows.push(`main.js     ${count('__installSwitchInput') > 0 ? '含宿主入口' : '缺失!'}`);
rows.push('');

// ---- host 脚本是否都在（漏拷一次就少个功能） ----
const HOST = ['switch-input.js', 'mask-scan.js', 'png-decoder.js', 'switch-audio.js',
  'idb-shim.js', 'pipe-host.js', 'env-prelude.js', 'ui-lang.js',
  // perfZ26：读盘类型规整（ArrayBuffer → Uint8Array）。漏拷 = 语言/按键映射/按键机型
  // 三个落盘功能在实机上静默失效（实机读回的是 ArrayBuffer，没有 .length）。
  'bytes.js'];
rows.push('--- host 脚本 ---');
for (const h of HOST) rows.push(`  ${h.padEnd(20)} ${count('host/' + h) > 0 ? '在' : '缺失!'}`);

// ---- 关键实现标记 ----
rows.push('');
rows.push('--- 关键标记（出现次数） ---');
// 构建标记从 app/main.js 现读：以前是写死在这里，每轮改标记都要记得回来改一遍
// （忘了就会出现"标记 0"的假失败）。现在包里的值必须与源码一致，改标记不用动本脚本。
const MARKER = (() => {
  const src = readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');
  const m = src.match(/build=([0-9A-Za-z._-]+)'/);
  if (!m) throw new Error('app/main.js 里找不到 build= 标记');
  return m[1];
})();
const MARKS = [
  ['构建标记 ' + MARKER, MARKER],
  ['三星兼容层 AudioClip', 'com/samsung/util/AudioClip'],
  ['三星兼容层 Vibration', 'com/samsung/util/Vibration'],
  ['自带 GBK 映射表', 'J2MEGbkTable'],
  ['GBK 解码兜底', 'J2MEGbkDecoder'],
  ['ini·代码空间 0', 'code_headroom_mb = 0'],
  ['ini·GPU 缓存 256', 'gpu_cache = 256'],
  ['Nokia drawImage 实现', 'DirectGraphicsImp.drawImage'],
  ['文本输入钩子', '__hostTextInput'],
  ['输入法注入钩子', '__sendInputMethodText'],
  ['LCDUI 命令软键直通', '__lcdInvokeCommand'],
  ['按键机型 诺基亚竖屏', '诺基亚竖屏（N86 软-6/-7 确认-5）'],
  ['按键机型 诺基亚横屏', '诺基亚横屏（E52/E63）'],
  ['vendor 认 QWERTY 字符码', 're:\\b116\\s*:\\s*1'],
  ['按键映射面板', 'openKeyMap'],
  ['遮罩选择面板', 'openMaskSel'],
  ['输入层 __keyMap', 'g.__keyMap = {'],
  ['输入层独占绑定', 'bindExclusive'],
  ['输入层硬闸 vmActive', 'var vmActive = (g.__gameRunning === true)'],
  ['SD 遮罩扫描', '__maskScan'],
  ['PNG 解码入口', '__decodePNG'],
  ['PNG 尺寸探测', '__pngSize'],
  ['遮罩像素上限', 'MASK_MAX_PX'],
  ['按键机型 摩托罗拉软键', '摩托罗拉（左-21 右-22 OK-20）'],
  ['vendor 认 OK(-20)=FIRE 补丁', 're:"-20"\\s*:\\s*8'],
  ['按键机型存档', 'keyprofiles.json'],
  ['遮罩选择存档 mask.json', 'mask.json'],
  ['按键映射存档 keys.txt', 'keys.txt'],
  ['屏显·语言落盘 lang.json', 'lang.json'],
  ['屏显·语言弹窗', 'drawLangPanel'],
  ['屏显·右上角双语提示', '按 ZR+ZL 切换中/英文'],
  ['屏显·字典（英文标题）', 'Games ({1})'],
  ['屏显·语言弹窗双语', 'Switch to English'],
  ['屏显·落盘校验', '回读不一致'],
  ['探针限流·jit-trap', '同类只记次数，不再每次写卡'],
  ['探针限流·media/midi', '探针已限流，每 25 次留一条'],
  ['资源流快进 skipBytes', 'skipBytes'],
  ['中文·按键映射', '按键映射'],
  ['中文·选择遮罩', '选择遮罩'],
  ['中文·加自己的遮罩', '加自己的遮罩'],
  ['中文·尺寸超限', '尺寸超限'],
  ['中文·说明.txt', '说明.txt'],
  // perfZ25：入口耗时账本 / 原生图像解码 / 原子合成（防"进游戏黑屏闪屏"回归）
  ['入口·耗时账本', '入口账本'],
  ['入口·耗时窗口行', '[cost] '],
  // ⚠ esc() 会把**整串**（含 ASCII）转义，所以中英混排的标记一律只取纯中文片段，
  // 否则 esbuild 产物里 ASCII 是原样、中文是 \uXXXX，两头都不匹配（数出 0）。
  ['入口·20s 兜底', '未出首帧'],
  ['图像·原生解码', '原生解码'],
  ['图像·JS 回落', '回落'],
  ['呈现·原子合成', '合成缓冲'],
  ['呈现·耗时明细', '真空闲'],
];
for (const [name, needle] of MARKS) rows.push(`  ${name.padEnd(24)} ${countMark(needle)}`);

// ---- romfs 内容规模 ----
rows.push('');
rows.push('--- romfs 内容 ---');
rows.push(`  内置遮罩 romfs:/masks/ 引用 ${count('romfs:/masks/')}`);
rows.push(`  遮罩文件名命中 ${count('.raw')} (含内置 8 张 + mask.raw)`);
// perfZ6 起内置遮罩只有 raw：包里出现 mask.png 就说明又退回了 PNG 兜底路径
rows.push(`  内置遮罩 png 残留 ${count('mask.png')} (perfZ6 起应为 0)`);
rows.push(`  遮罩窗口 GX,GY,GW,GH ${/var GX = (\d+), GY = (\d+), GW = (\d+), GH = (\d+)/.test(buf.toString('utf8')) ?
  RegExp.$1 + ',' + RegExp.$2 + ' ' + RegExp.$3 + 'x' + RegExp.$4 : '未匹配!'}`);
rows.push(`  CJK 字体 ${count('cjk.ttf') > 0 ? '在' : '缺失!'}`);
// perfZ25：字体换成 Noto Sans SC（SIL OFL 1.1）后，许可证必须一起进 romfs，
// 否则等于分发字体而没带许可（OFL 第 1 条要求）。
rows.push(`  字体许可证 ${count('OFL') > 0 ? '在（fonts/OFL.txt）' : '缺失!（OFL 要求随字体分发）'}`);
rows.push(`  j2me.js ${count('main-all.js') > 0 ? '在' : '缺失!'}`);
rows.push(`  nxjs.ini ${count('nxjs.ini') > 0 ? '在' : '缺失!'}`);

if (outPath) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outPath, rows.join('\n') + '\n', 'utf8');
} else {
  console.log(rows.join('\n'));
}
