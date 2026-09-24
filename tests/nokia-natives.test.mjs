/*
 * Nokia 原生实现覆盖测试（2026-09-23 perfZ7）
 *
 * 事故背景：1.jar（武林Q传）进游戏后**立绘和地图整片全黑**，而文字/菜单/软键盘都正常。
 * 根因：`com.nokia.mid.ui.DirectGraphicsImp.drawImage` **从来没实现过**。
 *
 * 机制（这条最值得记住）：VM 对"Java 声明了、JS 没注册"的 native **既不抛异常也不崩**，
 * 只打一行 console.error 就返回一个空函数（见 vendor/pluotsorbet/vm/runtime.ts:904
 * "is native but does not have an implementation"）。所以缺 native 的表现是
 * "**那块画面静默消失**"——从日志里几乎看不出因果，而且游戏每帧调用就每帧写一行日志
 * 并落卡（1.jar 实测 22 次），帧率白送。1.jar 的整张地图 + 立绘都走这条路，于是全黑。
 *
 * 本测试把"`java/custom` 里声明的每个 native 都必须在 JS 侧有交代"钉死：
 * 要么是真实现（Native[...]），要么是明确的一次性告警桩（addUnimplementedNative）。
 * 修这个 bug 时正是靠同一套扫描确认了"DirectGraphicsImp 里只剩 drawImage 没实现"。
 *
 * 运行：node tests/nokia-natives.test.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

// ---- Java native 声明 → implKey（implKey = 全名用 / 连接 + 方法名 + JVM 描述符）----
const PRIM = { void: 'V', int: 'I', long: 'J', boolean: 'Z', byte: 'B', short: 'S', char: 'C', float: 'F', double: 'D' };

function paramTypeNoName(raw) {
  let s = raw.trim();
  // 支持 `byte pixels[]` 与 `byte[] pixels` 两种写法
  const m = s.match(/^(.*?)\s*([A-Za-z_]\w*)\s*((?:\[\s*\])*)$/);
  if (m) s = m[1] + m[3];
  return s.replace(/\s+/g, '');
}
function toDesc(type) {
  let t = type;
  let dims = 0;
  while (/\[\s*\]$/.test(t)) { dims++; t = t.slice(0, t.lastIndexOf('[')); }
  return '['.repeat(dims) + (PRIM[t] ? PRIM[t] : 'L' + t.replace(/\./g, '/') + ';');
}

const declared = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!p.endsWith('.java')) continue;
    const src = readFileSync(p, 'utf8');
    const pkg = (src.match(/^\s*package\s+([\w.]+)\s*;/m) || [])[1];
    // ⚠️ 类名必须跟着 `{`（否则注释里的 "This class is undocumented." 会被当成 class is）
    const clsM = src.match(/^\s*(?:public\s+|final\s+|abstract\s+)*(?:class|interface)\s+(\w+)[^{;]*\{/m);
    if (!pkg || !clsM) continue;
    const cls = clsM[1];
    // import 表 + 同包简单名 → 全名
    const simple = Object.create(null);
    for (const m of src.matchAll(/^\s*import\s+([\w.]+)\s*;/gm)) {
      const fq = m[1];
      simple[fq.slice(fq.lastIndexOf('.') + 1)] = fq;
    }
    const fix = (t) => {
      if (PRIM[t] || t.indexOf('.') >= 0 || t.indexOf('[') >= 0) return t;   // 原始类型/数组/全名不动
      if (t === 'String') return 'java.lang.String';                          // java.lang 不用 import
      if (t === 'Object') return 'java.lang.Object';
      return simple[t] || (pkg + '.' + t);                                    // 其余按同包解析
    };
    const re = /native\s+([\w.$]+(?:\s*\[\s*\])*)\s+(\w+)\s*\(([^)]*)\)\s*;/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const params = m[3].trim() === '' ? [] : m[3].split(',').map(paramTypeNoName).map(fix);
      const ret = fix(m[1].replace(/\s+/g, ''));
      const desc = '(' + params.map(toDesc).join('') + ')' + toDesc(ret);
      declared.push({
        key: pkg.replace(/\./g, '/') + '/' + cls + '.' + m[2] + '.' + desc,
        where: relative(root, p).replace(/\\/g, '/'),
      });
    }
  }
})(join(root, 'java', 'custom', 'com', 'nokia'));

// ---- JS 侧注册表 ----
const registrations = new Set();
const stubs = new Set();
(function collect(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules') collect(p); continue; }
    if (!p.endsWith('.js')) continue;
    const src = readFileSync(p, 'utf8');
    for (const m of src.matchAll(/Native\[\s*"([^"]+)"\s*\]/g)) registrations.add(m[1]);
    for (const m of src.matchAll(/addUnimplementedNative\(\s*"([^"]+)"/g)) stubs.add(m[1]);
  }
})(join(root, 'vendor', 'pluotsorbet'));

// ---- A. 覆盖：声明了就必须有交代 ----
{
  check('扫到 com/nokia 下的 native 声明（>20 条）', declared.length > 20, true);
  const missing = declared.filter((d) => !registrations.has(d.key) && !stubs.has(d.key));
  check('没有"声明了却没人管"的 native（缺失清单见下）',
    missing.map((d) => d.key + ' @ ' + d.where).join(' | ') || '无', '无');
}

// ---- B. 关键绘图路径必须是**真实现**，不能退化成告警桩 ----
{
  const MUST_IMPLEMENT = [
    'com/nokia/mid/ui/DirectGraphicsImp.drawImage.(Ljavax/microedition/lcdui/Image;IIII)V',
    'com/nokia/mid/ui/DirectGraphicsImp.drawPixels.([SZIIIIIIII)V',
    'com/nokia/mid/ui/DirectGraphicsImp.drawPixels.([B[BIIIIIIII)V',
    'com/nokia/mid/ui/DirectGraphicsImp.fillPolygon.([II[IIII)V',
    'com/nokia/mid/ui/DirectGraphicsImp.drawPolygon.([II[IIII)V',
    'com/nokia/mid/ui/DirectGraphicsImp.fillTriangle.(IIIIIII)V',
    'com/nokia/mid/ui/DirectGraphicsImp.drawTriangle.(IIIIIII)V',
    'com/nokia/mid/ui/DirectGraphicsImp.setARGBColor.(I)V',
    'com/nokia/mid/ui/DirectGraphicsImp.getAlphaComponent.()I',
    'com/nokia/mid/ui/DirectUtils.setPixels.(Ljavax/microedition/lcdui/Image;I)V',
    'com/nokia/mid/ui/DirectUtils.makeMutable.(Ljavax/microedition/lcdui/Image;)V',
  ];
  for (const k of MUST_IMPLEMENT) {
    check('真实现（非桩）: ' + k.replace('com/nokia/mid/ui/', ''), registrations.has(k), true);
  }
  check('drawImage 不能只是告警桩',
    stubs.has('com/nokia/mid/ui/DirectGraphicsImp.drawImage.(Ljavax/microedition/lcdui/Image;IIII)V'), false);
}

// ---- C. manipulation → MIDP transform 映射（照参考实现；ROTATE_90 是逆时针）----
{
  const gfx = readFileSync(join(root, 'vendor/pluotsorbet/midp/gfx.js'), 'utf8');
  check('有 nokiaManipulationToMidpTransform', /function nokiaManipulationToMidpTransform/.test(gfx), true);
  const map = [
    ['case 0:', 'TRANS_NONE'],                          // 不翻不转
    ['case DG_FLIP_HORIZONTAL:', 'TRANS_MIRROR'],       // 8192
    ['case DG_FLIP_VERTICAL:', 'TRANS_MIRROR_ROT180'],  // 16384
    ['case DG_ROTATE_180:', 'TRANS_ROT180'],
    ['case DG_ROTATE_90:', 'TRANS_ROT270'],             // ⚠️ Nokia 逆时针 90 == MIDP 顺时针 270
    ['case DG_ROTATE_270:', 'TRANS_ROT90'],
    ['case DG_FLIP_HORIZONTAL | DG_ROTATE_90:', 'TRANS_MIRROR_ROT90'],
    ['case DG_FLIP_VERTICAL | DG_ROTATE_90:', 'TRANS_MIRROR_ROT270'],
  ];
  for (const [caseLine, want] of map) {
    const re = new RegExp(caseLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\n?\\s*return\\s+(\\w+);');
    const m = gfx.match(re);
    check('映射 ' + caseLine + ' → ' + want, m ? m[1] : '(未找到)', want);
  }
  check('翻转常量与 Nokia 一致（8192/16384）',
    /DG_FLIP_HORIZONTAL = 8192/.test(gfx) && /DG_FLIP_VERTICAL = 16384/.test(gfx), true);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
