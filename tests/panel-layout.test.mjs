/*
 * 面板文字宽度回归测试（2026-09-23 perfZ8；perfZ21 扩到中英双语）
 *
 * 事故：Y 菜单 → 选择遮罩 的说明文案把"路径 + 分辨率 + 体积上限 + 文件名规则"全塞一行，
 * 实机约 1300px 宽，而面板只有 780px（文字从 px+40 起 → 可用 700px），于是文字冲出面板
 * 右边被截断（用户截图反馈"这个提示超长了，搞短一点"）。这类"文案超宽"在桌面仿真里
 * 完全看不出来（stub canvas 的 measureText 是 `长度×8` 的假实现），只能靠断言守。
 *
 * perfZ21 起屏显文字有中/英两套，而**英文普遍比中文长**（同样意思 ASCII 更多字符、
 * 而且我们用的是等宽字体）：同一个面板中文塞得下、英文可能就冲出边框。所以这里对
 * 每一行**两种语言都量一遍** —— 译文取自 host/ui-lang.js 的字典（真源，不是抄一份）。
 *
 * 本测试扫 app/main.js 里各面板的 fillText，按等宽 CJK 字体估宽（CJK ≈ 1 em、ASCII ≈ 0.5 em），
 * 断言每行都塞得进它所在面板的可用宽度。
 *
 * 运行：node tests/panel-layout.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'app/main.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

// 屏幕 1280x720（Switch 物理屏）；变量取值按**最长**的那种（Switch 路径比 Node 长）
const VARS = { W: 1280, H: 720, MASK_DIR: 'sdmc:/switch/j2me-nx/masks' };

// 英文译文从字典真源取（host/ui-lang.js），避免测试里再抄一份、两边漂移
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'src/host/ui-lang.js'), 'utf8'), sandbox);
const DICT = sandbox.__uiLang.DICT;

function textWidth(s, fontPx) {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) > 127 ? fontPx : fontPx * 0.55);
  return Math.round(w);
}

// ---- 切出每个面板函数体 ----
const panels = [];
{
  const re = /function (draw\w*Panel)\s*\(\)\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // 用花括号配平找函数体结束
    let i = m.index + m[0].length - 1, depth = 0, end = -1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    panels.push({ name: m[1], body: src.slice(m.index, end + 1), at: m.index });
  }
}
check('扫到若干面板绘制函数（>=5 个）', panels.length >= 5, true);

// ---- 估算每个面板的可用宽度：pw（或 W-120）+ 文字左边距 ----
// ⚠ 两种写法都要认：`var pw = 780, ph = …` 与 `var px = 60, py = 204, pw = W - 120, rowH = 48;`。
// 只认前者的旧版本把「按键映射」「按键机型」两个面板整个跳过（panelWidth=null），
// 那两个面板的文案从来没人量过 —— 这次顺手补上。
function panelWidth(body) {
  const m = body.match(/var pw = ([^,;]+)[,;]/) || body.match(/[,;{]\s*pw = ([^,;]+)[,;]/);
  if (!m) return null;
  let expr = m[1].trim();
  for (const [k, v] of Object.entries(VARS)) expr = expr.replace(new RegExp('\\b' + k + '\\b', 'g'), v);
  if (!/^[\d\s+\-*/().]+$/.test(expr)) return null;
  try { return eval(expr); } catch (e) { return null; }   // eslint-disable-line no-eval
}

// ---- 解析 fillText 的第一个参数：字符串字面量 / 已知变量 / T(模板, 参数) ----
// 返回 { zh, en }（en 取字典；字典没有就与 zh 相同 —— 缺译由 tests/ui-lang.test.mjs 报）；
// 含无法静态求值的东西（变量拼串、三目）→ null，跳过以免误报。
function matchParen(s, open) {
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === "'") inStr = false;
      continue;
    }
    if (c === "'") { inStr = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return s.slice(open + 1, i); }
  }
  return null;
}
function splitTop(s) {
  const out = []; let depth = 0, cur = '', inStr = false, esc = false;
  for (const c of s) {
    if (inStr) {
      cur += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === "'") inStr = false;
      continue;
    }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}
// 模板 = 字面量用 '+' 拼起来（'+' 出现在字符串**里面**不算拼接 —— 旧实现按 '+' split 会在这里翻车）
function templateOf(first) {
  let i = 0, out = '';
  for (;;) {
    while (i < first.length && /\s/.test(first[i])) i++;
    if (first[i] !== "'") return null;
    i++;
    let buf = '';
    while (i < first.length) {
      const c = first[i];
      if (c === '\\') { buf += first[i + 1]; i += 2; continue; }
      if (c === "'") { i++; break; }
      buf += c; i++;
    }
    out += buf;
    while (i < first.length && /\s/.test(first[i])) i++;
    if (i >= first.length) return out;
    if (first[i] === '+') { i++; continue; }
    return null;
  }
}
function resolveSimple(p) {
  if (VARS[p] !== undefined) return String(VARS[p]);
  if (/^-?\d+(\.\d+)?$/.test(p)) return p;
  return null;
}
const fillTpl = (tpl, args) =>
  tpl.replace(/\{(\d)\}/g, (m, d) => (args[+d - 1] !== undefined ? args[+d - 1] : m));

function resolveBoth(expr) {
  let zh = '', en = '', i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c) || c === '+') { i++; continue; }
    if (c === "'") {
      let j = i + 1, buf = '';
      while (j < expr.length) {
        if (expr[j] === '\\') { buf += expr[j + 1]; j += 2; continue; }
        if (expr[j] === "'") break;
        buf += expr[j]; j++;
      }
      zh += buf; en += buf; i = j + 1; continue;
    }
    if (expr.startsWith('T(', i)) {
      const inner = matchParen(expr, i + 1);
      if (inner === null) return null;
      const parts = splitTop(inner);
      const args = parts.slice(1).map(resolveSimple);
      if (args.some((a) => a === null)) return null;
      const tpl = templateOf(parts[0]);
      if (tpl === null) return null;
      zh += fillTpl(tpl, args);
      en += fillTpl(DICT[tpl] !== undefined ? DICT[tpl] : tpl, args);
      i += 2 + inner.length + 1; continue;
    }
    // TB(zh, en)：语言弹窗的双语字面量（两种语言下都是同一串 → zh/en 同值）。
    // perfZ23 起弹窗文字走 TB()，不覆盖这里它就整段跳过宽度检查了。
    // ⚠ matchParen 的第二个参数是**左括号**的下标：'TB(' 的左括号在 i+2（踩过：
    //   传 i+1 会把 'B' 当成起点，返回的 inner 多带一层括号，解析直接失败 → 静默跳过）。
    if (expr.startsWith('TB(', i)) {
      const inner = matchParen(expr, i + 2);
      if (inner === null) return null;
      const parts = splitTop(inner);
      if (parts.length !== 2) return null;
      const a = templateOf(parts[0]);
      const b = templateOf(parts[1]);
      if (a === null || b === null) return null;
      const both = a + '  /  ' + b;
      zh += both; en += both;
      i += 3 + inner.length + 1; continue;
    }
    return null;   // 未知表达式
  }
  return { zh, en };
}

const overflows = [];
for (const p of panels) {
  const pw = panelWidth(p.body);
  if (process.env.PANEL_DEBUG) console.log(`  [dbg] 面板 ${p.name} pw=${pw}`);
  if (pw === null) continue;
  const mPx = p.body.match(/var px = ([^,;]+)[,;]/);
  let leftInset = 40;
  if (mPx) {
    const mm = mPx[1].match(/px\s*\+\s*(\d+)/);
    if (mm) leftInset = +mm[1];
    else if (/^\s*60\s*$/.test(mPx[1])) leftInset = 60;
  }
  const avail = pw - leftInset * 2;   // 右边也留同样宽的边距

  // 收集本函数里的字号设置与 fillText（字号按最近的 setFont 算）
  const body = p.body;
  const fontRes = [...body.matchAll(/ctx\.font = '(\d+)px/g)];
  const calls = [...body.matchAll(/fillText\(/g)];
  for (const c of calls) {
    // 取第一个参数的表达式
    let i = c.index + c[0].length, depth = 0, end = -1;
    const start = i;
    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') { if (depth === 0) { end = i - 1; break; } depth--; }
      else if (ch === ',' && depth === 0) { end = i - 1; break; }
    }
    if (end < 0) continue;
    const expr = body.slice(start, end + 1).trim();
    const texts = resolveBoth(expr);
    if (texts === null) continue;   // 变量拼串：无法静态求值 → 跳过
    // 最近一次 font 设置
    let fontPx = 19;
    for (const f of fontRes) if (f.index < c.index - start) fontPx = +f[1];
    for (const [lang, text] of [['zh', texts.zh], ['en', texts.en]]) {
      const w = textWidth(text, fontPx);
      if (process.env.PANEL_DEBUG) {
        console.log(`  [dbg] ${p.name}[${lang}] avail=${avail} font=${fontPx} w=${w} 「${text}」`);
      }
      if (w > avail) {
        overflows.push(`${p.name}[${lang}]: ${w}px > ${avail}px  「${text.slice(0, 40)}${text.length > 40 ? '…' : ''}」`);
      }
    }
  }
}
check('没有超出面板宽度的文字（超了就在下面列出来）', overflows.join(' || ') || '无', '无');

// ---- 关键面板单独钉一下（这几处最容易被写长）----
{
  const mask = panels.find((p) => p.name === 'drawMaskPanel');
  check('找到 drawMaskPanel', !!mask, true);
  if (mask) {
    // perfZ21：文案进了 T()（key 就是中文原文），路径仍必须是 MASK_DIR 变量
    const t = mask.body.match(/fillText\(T\('自加遮罩：\{1\} 放 1280x720 png\/raw', MASK_DIR\)/);
    check('遮罩面板的"自加遮罩"提示已缩短（用 MASK_DIR 变量而非全路径长句）', !!t, true);
    check('遮罩面板不再出现旧的长文案', /≤8MB，文件名用英文数字/.test(mask.body), false);
  }
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
