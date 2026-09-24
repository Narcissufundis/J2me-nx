/*
 * 玩家自定义按键映射（host/switch-input.js 的纯逻辑）回归测试
 *
 * 覆盖：默认表 → importText 解析（含注释/大小写/非法行/数字键码/NONE 解绑）
 *      → exportText 往返 → setBinding/reset/rows/bindingsOf。
 * 注意：本测试只加载 host 层逻辑（不 install 手柄轮询），不需要 nx.js 运行时。
 *
 * 运行：node tests/keymap.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'src/host/switch-input.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}
function fresh() {
  delete globalThis.__keyMap;
  delete globalThis.__buttonMap;
  delete globalThis.__KEY;
  (0, eval)(src);
  const km = globalThis.__keyMap;
  if (!km) throw new Error('__keyMap 未导出');
  return km;
}

// ---- 1. 默认表与导出 ----
{
  const km = fresh();
  const rows = km.rows();
  check('可映射的物理键 15 个', rows.length, 15);
  check('默认：物理A → 确认(-5)', rows.filter(r => r.phys === 'A')[0].code, -5);
  check('默认：物理B → 数字5(53)', rows.filter(r => r.phys === 'B')[0].code, 53);
  check('默认：ZL → 左软键', rows.filter(r => r.phys === 'ZL')[0].code, 'soft-left');
  check('默认：十字上 → 数字2(50)', rows.filter(r => r.phys === 'UP')[0].code, 50);
  check('目标键清单 20 项', km.targets.length, 20);
  const text = km.exportText();
  check('导出含表头注释', text.indexOf('# j2me-nx-port 按键映射') === 0, true);
  // 只数非注释行（表头注释里也有 '='）
  check('导出含全部 15 行', text.split('\n').filter(l => l.indexOf('=') > 0 && l.charAt(0) !== '#').length, 15);
  check('导出含 FIRE 名', /^A\s*=\s*FIRE/m.test(text), true);
  check('软键导出成可解析名（SOFT_LEFT/SOFT_RIGHT）',
    /^ZL\s*=\s*SOFT_LEFT/m.test(text) && /^ZR\s*=\s*SOFT_RIGHT/m.test(text), true);
}

// ---- 2. importText：解析与覆盖 ----
{
  const km = fresh();
  const n = km.importText([
    '# 注释行忽略',
    'A = FIRE        # 行尾注释',
    'B = SOFT_RIGHT',
    'ZL = 53',            // 允许直接写数字键码
    'X = NONE',           // 解绑
    'NOTABUTTON = FIRE',  // 物理键名非法 → 忽略
    'Y = NOSUCHKEY',      // 目标键名非法 → 忽略
    '这一行没有等号',      // 非法 → 忽略
    '',
  ].join('\n'));
  check('生效条数 = 4', n, 4);
  const rows = km.rows();
  const code = p => rows.filter(r => r.phys === p)[0].code;
  check('A → -5', code('A'), -5);
  check('B → 右软键', code('B'), 'soft-right');
  check('ZL → 53（数字写法）', code('ZL'), 53);
  check('X 已解绑', code('X'), null);
  check('Y 保持默认（非法目标被忽略）', code('Y'), 51);
  check('L 保持默认（未出现在文件里）', code('L'), 42);
  // 解绑后 bindingsOf 不应再列出它
  check('bindingsOf(51) 含物理Y', km.bindingsOf(51).indexOf('物理Y') >= 0, true);
  check('bindingsOf(-5) 含物理A', km.bindingsOf(-5).indexOf('物理A') >= 0, true);
}

// ---- 3. exportText → importText 往返一致 ----
{
  const km = fresh();
  km.setBinding(1, 35);        // A → '#'
  km.setBinding(6, null);      // ZL 解绑
  const text = km.exportText();
  const km2 = fresh();
  const n = km2.importText(text);
  check('往返生效条数 15', n, 15);
  const rows1 = km.rows(), rows2 = km2.rows();
  const same = rows1.every((r, i) => String(r.code) === String(rows2[i].code));
  check('往返后 15 条绑定完全一致', same, true);
  check('往返保留解绑（ZL=null）', rows2.filter(r => r.phys === 'ZL')[0].code, null);
}

// ---- 4. setBinding / reset / 未知目标 ----
{
  const km = fresh();
  km.setBinding(13, -2);       // 十字下 → UP 键码（故意交叉）
  check('交叉绑定生效', km.rows().filter(r => r.phys === 'DOWN')[0].code, -2);
  km.reset();
  check('reset 后十字下回默认 56', km.rows().filter(r => r.phys === 'DOWN')[0].code, 56);
  check('reset 后 A 回 -5', km.rows().filter(r => r.phys === 'A')[0].code, -5);
  // 解绑后 live 表不应再有该索引（轮询侧 for..in 会跳过 → 该键不发）
  km.setBinding(4, null);
  check('解绑后 live 表无索引4', (4 in km.live), false);
  // 空文本 = 全默认
  check('importText("") 生效 0 条', km.importText(''), 0);
  check('空文本后 A 仍默认', km.rows().filter(r => r.phys === 'A')[0].code, -5);
}

// ---- 6. 独占绑定（面板换键 = 旧键自动解绑） ----
// 实机反馈：第一版只追加，把 X 绑到确认后物理A 也还是确认 →
// 玩家看到"原版按键没被替换、一个键有两个映射"。
{
  const km = fresh();
  // 默认 A(1) → FIRE(-5)
  const cleared = km.bindExclusive(3, -5);      // 把物理X 绑到确认
  check('换绑返回被解除的物理键', Array.isArray(cleared) && cleared.join(','), '物理A');
  check('新键生效 X → FIRE', km.rows().filter(r => r.phys === 'X')[0].code, -5);
  check('旧键已解绑 A → null', km.rows().filter(r => r.phys === 'A')[0].code, null);
  check('FIRE 只剩一个物理键', km.bindingsOf(-5).join(','), '物理X');
  // 解绑不牵连别人
  km.setBinding(1, -5);                          // 手动再加回去（raw 模式允许重复）
  check('raw setBinding 允许重复（手改文件用）', km.bindingsOf(-5).join(','), '物理A,物理X');
  check('占位（bindingsOf 排序按表序）', km.bindingsOf(-5).length, 2);
  const c2 = km.bindExclusive(3, null);          // 独占解绑：只解绑自己
  check('bindExclusive(idx,null) 不牵连同目标别的键', c2.length, 0);
  check('解绑后 X 为空', km.rows().filter(r => r.phys === 'X')[0].code, null);
  check('A 仍在', km.rows().filter(r => r.phys === 'A')[0].code, -5);
  // 文件导入不独占（文件是权威）
  const km2 = fresh();
  const n2 = km2.importText('L = STAR\nR = STAR\nZL = STAR\n');
  check('importText 允许同一目标多键（不独占）', n2, 3);
  check('L/R/ZL 都是 STAR', km2.bindingsOf(42).length, 3);
}

// ---- 7. 大小写与空白容忍 ----
{
  const km = fresh();
  const n = km.importText('  a   =   fire  \n  zl=soft_left\n');
  check('小写+多空格容忍', n, 2);
  check('a → -5', km.rows().filter(r => r.phys === 'A')[0].code, -5);
  check('zl → 左软键', km.rows().filter(r => r.phys === 'ZL')[0].code, 'soft-left');
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
