/*
 * 字体字形覆盖守卫（perfZ27）
 *
 * 由来：改名标记用的是铅笔符号 '✎'（U+270E），而这一组铅笔字形
 * （U+270D~U+2712）在**中文字体里普遍没有** —— 旧内置 SimHei 没有，新内置
 * Noto Sans SC 也没有（cmap 无映射）。于是实机上那个标记一直渲染成 .notdef 方块，
 * 玩家看到的是"游戏名后面跟了两个口口"。这类问题**构建期就能查出来**，
 * 不该等玩家对着屏幕猜。
 *
 * 本测试自己做一个小 TTF cmap 解析器（format 4 + format 12，够用），然后：
 *   ① 界面代码里出现的每个非 ASCII 字符都必须在内置字体里有字形；
 *   ② 改名标记这类"附件标记"字符单独断言；
 *   ③ 反向自检：拿一个已知不存在的码位（U+270E）验证解析器会说"没有"
 *      （否则解析器写错了会把所有检查变成永远通过）。
 *
 * 运行：node tests/font-coverage.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (ok) passed++; else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

// ---------- 极简 TTF cmap 解析（大端） ----------
function parseCmap(buf) {
  const numTables = buf.readUInt16BE(4);
  let cmapOff = 0;
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    if (buf.toString('latin1', off, off + 4) === 'cmap') { cmapOff = buf.readUInt32BE(off + 8); break; }
  }
  if (!cmapOff) throw new Error('找不到 cmap 表');
  const n = buf.readUInt16BE(cmapOff + 2);
  const subtables = [];
  for (let i = 0; i < n; i++) {
    const rec = cmapOff + 4 + i * 8;
    subtables.push({ platform: buf.readUInt16BE(rec), encoding: buf.readUInt16BE(rec + 2), offset: cmapOff + buf.readUInt32BE(rec + 4) });
  }
  const set = new Set();
  for (const st of subtables) {
    const format = buf.readUInt16BE(st.offset);
    if (format === 4) {
      const segX2 = buf.readUInt16BE(st.offset + 6);
      const endO = st.offset + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = buf.readUInt16BE(endO + s * 2);
        const start = buf.readUInt16BE(startO + s * 2);
        const delta = buf.readInt16BE(deltaO + s * 2);
        const rangeOff = buf.readUInt16BE(rangeO + s * 2);
        if (start === 0xffff) continue;
        for (let c = start; c <= end && c !== 0xffff; c++) {
          if (rangeOff === 0) { set.add(c); continue; }
          const gi = rangeO + s * 2 + rangeOff + (c - start) * 2;
          if (gi + 1 < buf.length && buf.readUInt16BE(gi) !== 0) set.add(c);
        }
      }
    } else if (format === 12) {
      const nGroups = buf.readUInt32BE(st.offset + 12);
      for (let g = 0; g < nGroups; g++) {
        const go = st.offset + 16 + g * 12;
        const start = buf.readUInt32BE(go), end = buf.readUInt32BE(go + 4);
        for (let c = start; c <= end; c++) set.add(c);
      }
    }
  }
  return set;
}

const font = readFileSync(join(root, 'data/fonts/cjk.ttf'));
const covered = parseCmap(font);
check('解析出 cmap（码位数 > 20000）', covered.size > 20000, true);
check('cmap 含常用汉字「测」', covered.has(0x6D4B), true);
check('cmap 含拉丁 A', covered.has(0x41), true);
// 反向自检：解析器必须能报"没有"，否则上面全是假通过
check('反向自检：U+270E（铅笔 ✎）确实不在字体里', covered.has(0x270E), false);

// ---------- 扫界面代码里所有非 ASCII 字符 ----------
// 只扫会真正上屏的文件；注释行（// 与 * 开头）跳过 —— 注释里的生僻字不该让测试变红。
const UI_FILES = ['app/main.js', 'src/host/ui-lang.js', 'src/host/mask-scan.js', 'src/host/switch-input.js'];
// 不可见/格式字符不参与字形检查：变体选择符（U+FE00~FE0F，emoji 后面那一位）、
// 零宽字符、BOM 等本来就不该有字形（例如 '⚠️' = U+26A0 + U+FE0F，只看 U+26A0）。
const INVISIBLE = (cp) =>
  (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff || cp === 0x2060;
const drawn = new Map();   // 字符 → 出处
for (const rel of UI_FILES) {
  const lines = readFileSync(join(root, rel), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (cp < 128 || INVISIBLE(cp)) continue;
      if (!drawn.has(ch)) drawn.set(ch, rel + ':' + (i + 1));
    }
  });
}
check('扫到的界面字符数 > 500', drawn.size > 500, true);

const missing = [...drawn.entries()].filter(([ch]) => !covered.has(ch.codePointAt(0)));
if (missing.length) {
  for (const [ch, where] of missing) {
    console.error(`  缺字形: ${JSON.stringify(ch)} U+${ch.codePointAt(0).toString(16).toUpperCase()} (${where})`);
  }
}
check('界面用到的每个字符在字体里都有字形（缺字形会渲染成方块）', missing.length, 0);

// ---------- 改名标记：必须是字体里**确有字形**的符号 ----------
const mainSrc = readFileSync(join(root, 'app/main.js'), 'utf8');
const markMatch = /var RENAME_MARK = '([^']+)'/.exec(mainSrc);
check('main.js 定义了 RENAME_MARK', !!markMatch, true);
if (markMatch) {
  const mark = markMatch[1];
  check('RENAME_MARK 只有一个字符', [...mark].length, 1);
  check('RENAME_MARK 在字体里有字形（这是"口口"事故的正面断言）',
    covered.has(mark.codePointAt(0)), true);
  check('RENAME_MARK 不是被判为缺字形的 U+270E 那类',
    mark.codePointAt(0) !== 0x270e, true);
  check('列表里真的用了 RENAME_MARK', mainSrc.includes("'  ' + RENAME_MARK"), true);
}
check('旧的铅笔符号 U+270E 已从源码里清掉（含注释）', mainSrc.includes('\u270e'), false);
// 注释里列出的备选符号也必须都有字形（免得备选清单本身是坑）
{
  // 备选清单写在 var RENAME_MARK 上方的注释里（可能跨多行），先取出那段注释再抽符号
  const lines = mainSrc.split(/\r?\n/);
  const markLine = lines.findIndex((l) => l.includes('var RENAME_MARK'));
  const blockLines = lines.slice(Math.max(0, markLine - 12), markLine).filter((l) => l.trim().startsWith('//'));
  // 只取"清单行"（一行里有 ≥3 个 `符号 U+XXXX`）；说明性文字里也会提到 U+270D/U+270E
  // 这类**反面例子**（它们本来就是没字形的），不参与断言。
  const cands = [];
  for (const l of blockLines) {
    const ms = [...l.matchAll(/(\S)\s+U\+([0-9A-Fa-f]{4})/g)];
    if (ms.length >= 3) for (const m of ms) cands.push(String.fromCodePoint(parseInt(m[2], 16)));
  }
  check('找到备选符号清单注释', cands.length >= 5, true);
  const badCands = cands.filter((c) => !covered.has(c.codePointAt(0)));
  if (badCands.length) console.error('  备选清单里缺字形的: ' + badCands.map((c) => `U+${c.codePointAt(0).toString(16)}`).join(' '));
  check('注释里列出的每个备选符号都有字形', badCands.length, 0);
}

// ---------- 运行期审计钩子必须在（菜单文字以前完全没被检测） ----------
check('宿主提供菜单文字审计入口 __j2meFontAudit',
  mainSrc.includes('g.__j2meFontAudit = function'), true);
check('菜单绘制时真的调用审计', mainSrc.includes('g.__j2meFontAudit(auditRows'), true);
check('审计结果落 [font-audit] 日志', mainSrc.includes("'[font-audit] 列表文字 '"), true);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
