/* 一次性证据脚本：打印各机型下"逻辑键 → 实际发出的 keyCode"（不参与测试） */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'src/host/switch-input.js'), 'utf8');
// switch-input.js 走 globalThis（Node ESM 下间接 eval 就在全局作用域），
// 所以先给它备上要用的全局入口，再求值。
globalThis.__sdLog = () => {};
(0, eval)(src);

const P = globalThis.__keyProfiles;
const setP = globalThis.__setKeyProfile;
const rows = [];
rows.push('机型表：');
P.list().forEach(p => {
  rows.push('  ' + p.id.padEnd(10) + ' 左软键=' + String(p.softLeft).padStart(4) +
    '  右软键=' + String(p.softRight).padStart(4) +
    '  OK/确认=' + String(p.fire).padStart(4) +
    '  清除=' + String(p.clear).padStart(3) + '   ' + p.label);
});
rows.push('');
rows.push('实际发出的 keyCode（宿主 sendKey 的翻译结果）：');
rows.push('  逻辑键'.padEnd(16) + P.list().map(p => p.id.padStart(12)).join(''));
const logical = [
  ['确定(确认/-5)', -5],
  ['左软键', 'soft-left'],
  ['右软键', 'soft-right'],
  ['方向-上(-1)', -1],
  ['方向-下(-2)', -2],
  ['方向-左(-3)', -3],
  ['方向-右(-4)', -4],
  ['数字 1(49)', 49],
  ['数字 2(50)', 50],
  ['数字 3(51)', 51],
  ['数字 4(52)', 52],
  ['数字 5(53)', 53],
  ['数字 6(54)', 54],
  ['数字 7(55)', 55],
  ['数字 8(56)', 56],
  ['数字 9(57)', 57],
  ['*(42)', 42],
  ['0(48)', 48],
  ['#(35)', 35],
];
const saved = P.current();
for (const [name, code] of logical) {
  let line = '  ' + name.padEnd(16);
  for (const p of P.list()) {
    setP(p.id);
    const out = (typeof code === 'string') ? P.softCode(code) : P.mapOutCode(code);
    line += String(out).padStart(12);
  }
  rows.push(line);
}
setP(saved);
// 支持 --out <file>：直接写 UTF-8 文件（PowerShell 重定向会把中文写坏）
const oi = process.argv.indexOf('--out');
if (oi >= 0 && process.argv[oi + 1]) {
  writeFileSync(process.argv[oi + 1], rows.join('\n') + '\n', 'utf8');
} else {
  console.log(rows.join('\n'));
}
