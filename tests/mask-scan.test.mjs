/*
 * 玩家自定义遮罩：SD 目录扫描纯逻辑（host/mask-scan.js）回归测试
 *
 * 运行：node tests/mask-scan.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'src/host/mask-scan.js'), 'utf8');
(0, eval)(src);
const scan = globalThis.__maskScan;
const readme = globalThis.__maskReadme;

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

check('导出 __maskScan', typeof scan, 'function');
check('导出 __maskReadme', typeof readme, 'function');

// ---- 1. 过滤规则 ----
{
  const out = scan(['my.png', 'hero.PNG', 'a.raw', 'note.txt', '说明.txt', 'sub', '.hidden.png',
    '_readme.png', 'noext', '.png', 'x.jpg']);
  const names = out.map(o => o.name);
  check('只收 .png/.raw（大小写不敏感）', names.join(','), 'a.raw,hero.PNG,my.png');
  check('忽略 .txt', names.indexOf('note.txt'), -1);
  check('忽略 . 开头', names.filter(n => n.charAt(0) === '.').length, 0);
  check('忽略 _ 开头', names.indexOf('_readme.png'), -1);
  check('忽略空基名（.png）', names.indexOf('.png'), -1);
}
check('空输入返回空数组', scan([]).length, 0);
check('undefined 输入安全', scan(undefined).length, 0);

// ---- 2. id / label / kind ----
{
  const out = scan(['cool_mask.png', 'raw1.raw']);
  const png = out.filter(o => o.name === 'cool_mask.png')[0];
  const raw = out.filter(o => o.name === 'raw1.raw')[0];
  check('png id 形式', png.id, 'sd:cool_mask.png');
  check('png label 去扩展名', png.label, 'cool_mask');
  check('png kind', png.kind, 'png');
  check('raw kind', raw.kind, 'raw');
  check('raw 期望字节数 = 1280*720*4', raw.rawBytes, 3686400);
  check('png 无 rawBytes 约束', png.rawBytes, 0);
}

// ---- 3. 排序与重名 ----
{
  const out = scan(['b.png', 'a.png', 'c.png']);
  check('按名字排序', out.map(o => o.label).join(','), 'a,b,c');
  const dup = scan(['x.png', 'x.raw']);
  check('同名不同类型也各自成条', dup.length, 2);
  check('重名第二条加后缀', dup[1].label.indexOf('(2)') >= 0, true);
}

// ---- 4. 中文名照收（是否可读由 FAT/运行时决定，纯逻辑不丢）+ 标注出来 ----
{
  const out = scan(['我的遮罩.png']);
  check('中文名保留（带（中文名）标注，提示 FAT 读不稳）',
    out.length === 1 && out[0].label === '我的遮罩（中文名）', true);
  check('中文名 id 保留原名', out[0].id, 'sd:我的遮罩.png');
  check('ascii 标志=false', out[0].ascii, false);
  const en = scan(['my mask.png']);
  check('英文名不加标注', en[0].label, 'my mask');
  check('英文名 ascii 标志=true', en[0].ascii, true);
}

// ---- 5. 说明文本 ----
{
  const t = readme();
  check('说明含目录提示', t.indexOf('switch/j2me-nx/masks') >= 0, true);
  check('说明含 png 与 raw 两种格式', t.indexOf('.png') >= 0 && t.indexOf('.raw') >= 0, true);
  check('说明含 3686400（raw 精确尺寸）', t.indexOf('3686400') >= 0, true);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
