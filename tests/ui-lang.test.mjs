/*
 * ui-lang 回归测试（2026-09-23 perfZ21）
 *
 * 用户需求：主页右上角提示"按 ZR+ZL 切换中/英文"；ZR+ZL 弹出两项（切换英文 /
 * 切换中文），选完再问一次确认；选英文后**模拟器自己的屏显文字**全变英文，
 * 日志保持中文（用户明确"日志不用"）。
 *
 * ⚠ 别和 tools/i18n-test/ 搞混：那是 Java 类库 i18n（GBK/StringBuilder/
 * LayerManager）的端到端验证；本测试守的是**界面语言**。
 *
 * 这个测试守的是最容易悄悄坏掉的三件事：
 *   ① 覆盖：源码里每个 T('…') 字面量都必须在字典里 —— 漏一条，英文界面里就会
 *      蹦出一句中文，而这种事在实机上只有玩家看得到（我们看不到屏）。
 *      所以这里反过来扫源码：T() 的模板参数（含跨行拼接）全部抽出来比对字典。
 *   ② 漏包：上屏的字符串（fillText/showFatalError/drawTextRight 第一参数）只要
 *      含汉字就必须出现 T( —— 覆盖测试查不出"忘了包"的。
 *   ③ 字典质量与查表行为：英文值里不许有汉字；占位符 {1}..{4} 两边一致；
 *      未命中回原文、切换回调/silent、默认中文。
 *
 * 运行：node tests/ui-lang.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}
function ok(name, cond, detail) { check(name + (detail ? '（' + detail + '）' : ''), !!cond, true); }
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

// ---- 1. 把 host/ui-lang.js 装进干净上下文里跑 ----
const src = readFileSync(join(root, 'src/host/ui-lang.js'), 'utf8');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'src/host/ui-lang.js' });
const ui = sandbox.__uiLang;
ok('host/ui-lang.js 导出 g.__uiLang', !!ui);
if (!ui) { console.log(`${passed} passed, ${failed} failed`); process.exit(1); }
const DICT = ui.DICT;

// ---- 2. 扫源码里的 T() 调用 ----
// 解析规则（够用且严格）：
//   T('a' + 'b')    → 模板 = 'ab'（跨行拼接也是这个形态）
//   T('a' , x)      → 模板 = 'a'（逗号之后的参数不参与）
//   T(变量 / 三目)   → 调用里出现的**含汉字**字面量都是运行期会进 T() 的 key
function callArgs(src2, open) {
  let depth = 0, out = '', inStr = false, esc = false;
  for (let i = open; i < src2.length; i++) {
    const c = src2[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === "'") inStr = false;
      out += c; continue;
    }
    if (c === "'") { inStr = true; out += c; continue; }
    if (c === '(') { depth++; if (depth === 1) { out = ''; continue; } }
    if (c === ')') { depth--; if (depth === 0) return out; }
    out += c;
  }
  return out;
}
const unesc = (s) => s.replace(/\\(['"\\])/g, '$1');
function parseCall(argText) {
  const trimmed = argText.trim();
  if (!trimmed) return { kind: 'empty', keys: [] };
  const lits = [];
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(argText))) lits.push(unesc(m[1]));
  if (!/^'/.test(trimmed)) {
    // 动态参数：只有含汉字的字面量才是待翻译文案（'en' 这种条件字面量不算）
    return { kind: 'dynamic', keys: lits.filter((s) => CJK.test(s)) };
  }
  // 模板：取到第一个深度 0 的逗号，且字面量之间只能是 + 与空白
  let depth = 0, inStr = false, esc = false, head = '';
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === "'") inStr = false;
      head += c; continue;
    }
    if (c === "'") { inStr = true; head += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) break;
    head += c;
  }
  const parts = head.match(/'((?:[^'\\]|\\.)*)'/g);
  if (!parts) return { kind: 'dynamic', keys: lits.filter((s) => CJK.test(s)) };
  const between = head.replace(/'((?:[^'\\]|\\.)*)'/g, '').replace(/\s+/g, '');
  const key = parts.map((p) => unesc(p.slice(1, -1))).join('');
  if (between !== '+' && between !== '') return { kind: 'dynamic', keys: lits.filter((s) => CJK.test(s)) };
  return { kind: 'template', keys: [key] };
}

const sources = [{ name: 'app/main.js', src: readFileSync(join(root, 'app/main.js'), 'utf8') }];
for (const f of readdirSync(join(root, 'src/host'))) {
  if (!f.endsWith('.js') || f === 'ui-lang.js') continue;
  sources.push({ name: 'src/host/' + f, src: readFileSync(join(root, 'src/host', f), 'utf8') });
}
const mainSrc = sources[0].src;

const required = new Map();   // key -> [来源:行号]
let tCalls = 0;
for (const { name, src: s } of sources) {
  let idx = 0;
  while ((idx = s.indexOf('T(', idx)) >= 0) {
    const at = idx;
    idx += 2;
    const prev = at > 0 ? s[at - 1] : '';
    if (/[A-Za-z0-9_$.]/.test(prev)) continue;                 // 标识符尾巴（.hostText( 等）
    if (/function\s+$/.test(s.slice(Math.max(0, at - 12), at))) continue;
    const parsed = parseCall(callArgs(s, at + 1));
    if (parsed.kind === 'empty') continue;                     // 注释里的 "T()" 不是调用
    tCalls++;
    const line = s.slice(0, at).split('\n').length;
    for (const k of parsed.keys) {
      if (!required.has(k)) required.set(k, []);
      required.get(k).push(name + ':' + line + '(' + parsed.kind + ')');
    }
  }
}
ok('解析到 >= 40 处 T() 调用', tCalls >= 40, '实际 ' + tCalls);

// ---- 3. 覆盖：每个 T() key 都在字典里 ----
const missing = [];
for (const [k, where] of required) if (!ui.has(k)) missing.push(JSON.stringify(k) + ' ← ' + where[0]);
check('T() 字面量全部在字典里（漏的：' + (missing.length ? missing.join(' | ') : '无') + '）',
  missing.length, 0);

// ---- 4. 字典里的每条都被用到（否则是死条目/打错字） ----
const allSrc = sources.map((s) => s.src).join('\n');
const allLiterals = new Set();
{
  // 单引号 + 双引号都算（host/switch-input.js 的 MIDP 键名表用的是双引号）。
  // ⚠ 必须**逐行**扫：注释里成对出现的引号会让跨行匹配把中间整段代码吞掉，
  // 于是"确实存在的字面量"被漏判成死条目（踩过一次）。
  for (const line of allSrc.split('\n')) {
    const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(line))) allLiterals.add(unesc(m[1] !== undefined ? m[1] : m[2]));
  }
}
const dead = Object.keys(DICT).filter((k) => !required.has(k) && !allLiterals.has(k));
check('字典没有死条目（未被引用的：' + (dead.length ? dead.join(' , ') : '无') + '）', dead.length, 0);

// ---- 5. 字典质量 ----
const withCjk = Object.entries(DICT).filter(([, v]) => CJK.test(v));
check('英文值里没有汉字（有汉字的：' + withCjk.map(([k]) => k).join(' , ') + '）', withCjk.length, 0);
check('英文值都非空', Object.entries(DICT).filter(([, v]) => !String(v).trim()).length, 0);
const phMismatch = [];
for (const [k, v] of Object.entries(DICT)) {
  const ph = (x) => (String(x).match(/\{\d\}/g) || []).sort().join(',');
  if (ph(k) !== ph(v)) phMismatch.push(k + ' [' + ph(k) + ' vs ' + ph(v) + ']');
}
check('占位符两边一致（不一致的：' + (phMismatch.length ? phMismatch.join(' | ') : '无') + '）',
  phMismatch.length, 0);
ok('字典条目 >= 90', Object.keys(DICT).length >= 90, '实际 ' + Object.keys(DICT).length);

// ---- 6. 查表行为 ----
check('默认语言 = zh', ui.lang, 'zh');
check('zh 下原文返回（占位符照样替换）', ui.t('第 {1}/{2} 页', 2, 3), '第 2/3 页');
check('zh 下未命中回原文', ui.t('随便一句没进字典的话'), '随便一句没进字典的话');
check('切到 en 返回 true（状态真的变了）', ui.set('en'), true);
check('en 下命中字典', ui.t('第 {1}/{2} 页', 2, 3), 'Page 2/3');
check('en 下未命中回原文（不吐 undefined）', ui.t('随便一句没进字典的话'), '随便一句没进字典的话');
check('en 下 null/undefined 输入安全', ui.t(null) + '|' + ui.t(undefined), '|');
check('en 下多余占位符参数被忽略', ui.t('确定', 1, 2, 3), 'OK');
check('切回 zh', ui.set('zh'), true);
check('切到同一个语言返回 false', ui.set('zh'), false);
check('非法语言值一律按 zh', (ui.set('klingon'), ui.lang), 'zh');
check('别名/大小写 en 可识别', (ui.set('EN-US'), ui.lang), 'en');
ui.set('zh', true);

let saved = null, savedCount = 0;
ui.onChange = (lang) => { saved = lang; savedCount++; };
ui.set('en');
check('set() 触发 onChange 并带上新语言', saved, 'en');
ui.set('zh');
check('再次 set() 再触发一次', savedCount, 2);
ui.set('en', true);
check('silent=true 不触发 onChange', savedCount, 2);
check('silent 仍然真的改了语言', ui.lang, 'en');
ui.onChange = null;
ui.set('zh');

// ---- 6b. 英文模式下"没翻译的串"会被记下来（实机排查用）----
ui.set('en', true);
ui.takeMisses();   // 先倒掉前面用例留下的（前面故意喂过没进字典的中文）
ui.t('这是一个没进字典的界面文案');
ui.t('Games ({1})');                      // 未命中但不含汉字 → 不该记（那是英文本身）
const misses = ui.takeMisses();
check('未翻译的汉字串被记下 1 条', misses.length, 1);
ok('记下的就是那一句（' + misses.join(' | ') + '）',
  misses.indexOf('这是一个没进字典的界面文案') >= 0);
check('takeMisses 取走后清空', ui.takeMisses().length, 0);
ui.t('又一句没翻译的中文');
check('清空后能重新累积', ui.takeMisses().length, 1);
ui.set('zh');

// ---- 7. main.js / host 接线（改坏了这里等于功能不在） ----
ok('main.js 注册了 host/ui-lang.js 到 SCRIPTS', mainSrc.indexOf("'host/ui-lang.js'") > 0);
ok('main.js 有 lang.json 落盘路径', mainSrc.indexOf('sdmc:/switch/j2me-nx/lang.json') > 0);
ok('main.js 装了 onChange 落盘钩子', mainSrc.indexOf('g.__uiLang.onChange = function (lang)') > 0);
ok('afterHostScripts 里载入语言', mainSrc.indexOf('loadLang();') > 0);
ok('Node 仿真可用 J2ME_TEST_LANG_FILE 覆盖落点',
  mainSrc.indexOf('J2ME_TEST_LANG_FILE') > 0);
ok('右上角中文提示存在', mainSrc.indexOf('按 ZR+ZL 切换中/英文') > 0);
ok('右上角英文提示存在', mainSrc.indexOf('Press ZR+ZL to switch language') > 0);
ok('ZR/ZL 索引 6/7 被读', mainSrc.indexOf('dn(6), zrBtn = dn(7)') > 0);
ok('有语言弹窗模式', mainSrc.indexOf("mode === 'lang'") > 0);
ok('弹窗两步确认', mainSrc.indexOf('langConfirm = true') > 0 && mainSrc.indexOf('applyLang(langSel)') > 0);
ok('切语言后清掉旧语言的面板提示串', mainSrc.indexOf("kmMsg = ''; profMsg = ''; delErr = '';") > 0);
ok('切语言后内置键盘布局缓存失效', mainSrc.indexOf('kbState.laidOutFor = null') > 0);
ok('弹窗只在菜单轮询里（游戏运行时 ZL/ZR 是软键，不能抢）',
  mainSrc.indexOf('function poll()') > 0 && mainSrc.indexOf('openLang();', mainSrc.indexOf('function poll()')) > 0);
ok('mask-scan 的「（中文名）」后缀走字典',
  readFileSync(join(root, 'src/host/mask-scan.js'), 'utf8').indexOf('g.__uiLang.t(cjkTag)') > 0);

// 日志不翻译：T() 只能包屏显字符串，不能包 sdLog/maskLog/console 的参数
const logWrapped = mainSrc.match(/(sdLog|maskLog|console\.(log|warn|error))\(\s*T\(/g) || [];
check('没有把日志包进 T()（日志保持中文）', logWrapped.length, 0);

// ---- 8. 漏包检查：上屏的汉字必须走 T() 或 TB() ----
// （第一参数是变量时跳过 —— 那些是在拼串处翻好的：label/text/delErr/kmMsg…）
const HINT_ALLOW = ['按 ZR+ZL 切换中/英文', 'Press ZR+ZL to switch language'];  // 故意双语常显
function firstArg(s, open) {
  let depth = 0, out = '', inStr = false, esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === "'" || c === '"') inStr = false;
      continue;
    }
    if (c === "'" || c === '"') { inStr = true; out += c; continue; }
    if (c === '(') { depth++; if (depth === 1) { out = ''; continue; } }
    if (c === ')') { depth--; if (depth === 0) return out; }
    if (c === ',' && depth === 1) return out;
    out += c;
  }
  return out;
}
const unwrapped = [];
for (const fn of ['fillText', 'showFatalError', 'drawTextRight']) {
  let idx = 0;
  while ((idx = mainSrc.indexOf(fn + '(', idx)) >= 0) {
    const at = idx;
    idx += fn.length + 1;
    const prev = at > 0 ? mainSrc[at - 1] : '';
    if (/[A-Za-z0-9_$.]/.test(prev)) continue;
    if (new RegExp('function\\s+' + fn + '\\s*$').test(mainSrc.slice(Math.max(0, at - 24), at))) continue;
    const arg = firstArg(mainSrc, at + fn.length);
    if (!CJK.test(arg)) continue;
    if (arg.indexOf('T(') >= 0) continue;
    // TB(zh, en) = 双语字面量（**只允许语言弹窗用**：那个面板必须在两种语言下都可读）。
    // 用量单独钉住（见第 9 节），避免它变成"哪里都能绕开字典"的后门。
    if (arg.indexOf('TB(') >= 0) continue;
    if (HINT_ALLOW.some((h) => arg.indexOf("'" + h + "'") >= 0)) continue;
    unwrapped.push(fn + ' @main.js:' + mainSrc.slice(0, at).split('\n').length + ' ← ' + arg.trim().slice(0, 60));
  }
}
check('上屏汉字都包了 T()/TB()（漏包的：' + (unwrapped.length ? unwrapped.join(' | ') : '无') + '）',
  unwrapped.length, 0);

// ---- 9. 语言弹窗必须双语常显（2026-09-24 用户实测反馈第一条）----
// 场景：英文用户当前的设置是中文 —— 他进来就是为了把界面改成英文，此时中文提示对他
// 毫无意义。所以弹窗的标题/两个选项/二次确认/底部提示全部用 TB(zh, en) 双语。
{
  const need = [
    ["TB('语言', 'Language')", '弹窗标题'],
    ["TB('切换到英文', 'Switch to English')", '选项一（切英文）'],
    ["TB('切换到中文', 'Switch to Chinese')", '选项二（切中文）'],
    ["TB('确认切换语言？', 'Switch language?')", '二次确认'],
  ];
  const missing = need.filter(([pat]) => mainSrc.indexOf(pat) < 0).map(([, name]) => name);
  check('语言弹窗双语常显（缺的：' + (missing.length ? missing.join(' , ') : '无') + '）', missing.length, 0);
  const tbUses = (mainSrc.match(/\bTB\(/g) || []).length;
  ok('TB() 仅在语言弹窗里使用（用量 ' + tbUses + ' 次，≤ 12）', tbUses >= 4 && tbUses <= 12, '实际 ' + tbUses);
  check('TB() 用法之外没有别的双语后门', (mainSrc.match(/function TB\(/g) || []).length, 1);
}

// ---- 10. 落盘必须是"写 + 回读校验"，且提示如实（用户实测反馈第二条）----
// 上一次"选完英文下次还是中文"的直接原因就是：写盘链只写不验、弹窗无条件显示
// "已写入 lang.json"，把唯一的线索骗掉了。
ok('落盘走 saveLangTo（含回读校验）', mainSrc.indexOf('function saveLangTo(') > 0);
ok('回读校验会比对内容', mainSrc.indexOf('回读不一致') > 0);
ok('有兜底落点（主路径失败再试一次）', mainSrc.indexOf('LANG_FILE_FALLBACK') > 0
  && mainSrc.indexOf('j2me-lang.json') > 0);
ok('载入会依次尝试两个路径', /var paths = \[LANG_FILE, LANG_FILE_FALLBACK\]/.test(mainSrc));
ok('载入把读到什么打出来（文件/内容）', mainSrc.indexOf('内容="') > 0);
ok('切换提示反映真实落盘结果（不再无条件说"已写入"）',
  mainSrc.indexOf('var saved = langLastSave && langLastSave.ok;') > 0
  && mainSrc.indexOf('写盘失败，本次有效') > 0);

// ---- 11. 按键面板里的"物理键名/机型名"必须走字典（用户实测反馈第三条）----
// 事故：keymap 面板右列的绑定键名来自 switch-input.js 的 SW_BUTTONS.label（"物理A"/"- 键"/
// "L3 摇杆按"），过去没走字典 → 英文界面下右列还是中文。这里把 switch-input.js 里
// **所有会显示给玩家的 label** 逐个要求有译文，以后新增键位忘了加字典会当场红。
{
  const siSrc = readFileSync(join(root, 'src/host/switch-input.js'), 'utf8');
  const labels = new Set();
  for (const m of siSrc.matchAll(/label:\s*'([^']+)'/g)) labels.add(m[1]);
  for (const m of siSrc.matchAll(/label:\s*"([^"]+)"/g)) labels.add(m[1]);
  const noTr = [...labels].filter((s) => CJK.test(s) && !ui.has(s));
  check('switch-input 的键位/机型标签都有译文（缺的：' + (noTr.length ? noTr.join(' , ') : '无') + '）',
    noTr.length, 0);
  ok('keymap 面板的绑定键名逐词翻译（不是整串 T）',
    mainSrc.indexOf('bt.push(T(bl[bi]))') > 0);
  ok('解除绑定提示里的键名也逐词翻译', mainSrc.indexOf('cleared.map(T).join') > 0);
  ok('扫到了足够多的键位标签（防止正则失效假绿）', labels.size >= 25, '实际 ' + labels.size);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
