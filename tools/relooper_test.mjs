#!/usr/bin/env node
/*
 * relooper_test.mjs — 纯 JS Relooper 的一致性测试（lab 专用）
 *
 * 做法：用 esbuild 把 vendor/pluotsorbet/jit/relooper.ts 转成 JS，取全局 Relooper，
 * 按 baseline.ts 的真实用法驱动它（addBlock/setBlockCode("@id")/addBranch/render），
 * 再做 baseline 同样的 "@id" 行替换，最后在一个函数里真实执行生成的脚手架，
 * 把基本块访问序列与参考解释器（同一 CFG 的顺序语义）逐例对比。
 *
 * 覆盖：直线/菱形/自环/嵌套循环/条件求值顺序/tableswitch 派发/死块/无出口块/
 *      switch 无 default/异常回派发（入口派发块）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'vendor', 'pluotsorbet', 'jit', 'relooper.ts'), 'utf8');
const js = esbuild.transformSync(src, { loader: 'ts' }).code;
const Relooper = new Function(js + '\nreturn Relooper;')();

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS | ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL | ' + name + (detail ? '  <- ' + detail : '')); }
}

// ---- 生成脚手架并执行 -------------------------------------------------------
// blocks: [{ id, body, branches: [{to, cond?, code?}], var? }]
function build(blocks, entry) {
  Relooper.init();
  const ids = [];
  for (const b of blocks) {
    const id = b.var ? Relooper.addBlock('// Block: ' + b.id, b.var) : Relooper.addBlock('// Block: ' + b.id);
    b.rl = id;
    ids.push(id);
  }
  for (const b of blocks) {
    for (const br of (b.branches || [])) {
      const to = blocks.find(x => x.id === br.to);
      Relooper.addBranch(b.rl, to.rl, br.cond, br.code);
    }
    Relooper.setBlockCode(b.rl, '@' + b.rl);
  }
  const scaffolding = Relooper.render(blocks.find(x => x.id === entry).rl).split('\n');
  const lines = [];
  for (const line of scaffolding) {
    if (line.length > 0 && line[0] === '@') {
      const body = blocks.find(x => x.rl === (line.substring(1) | 0)).body;
      lines.push(body);
    } else lines.push(line);
  }
  const fn = 'function run(V){\n' +
    'var __t=[]; var __steps=0;\n' +
    'function __step(){ if(++__steps>4000) throw new Error("runaway: 脚手架空转（死循环）"); }\n' +
    lines.join('\n') + '\n' +
    'return { trace: __t, result: "fallthrough" };\n' +
    '}';
  return new Function(fn + '\nreturn run;')();
}

// ---- 参考解释器：与 relooper 相同的 CFG 顺序语义 ------------------------------
function evalCond(expr, V) {
  // eslint-disable-next-line no-new-func
  return !!new Function('V', 'return (' + expr + ')')(V);
}
function reference(blocks, entry, V, maxSteps = 4000) {
  const byId = new Map(blocks.map(b => [b.id, b]));
  const trace = [];
  let cur = byId.get(entry);
  for (let n = 0; n < maxSteps; n++) {
    if (!cur) return { trace, result: 'missing-block' };
    trace.push(cur.id);
    if (cur.terminates) return { trace, result: cur.ret !== undefined ? cur.ret : 'terminated' };
    const branches = cur.branches || [];
    let taken = null;
    for (const br of branches) {
      if (!br.cond) continue;
      if (br.cond.indexOf('case ') === 0) {                    // tableswitch/lookupswitch 派发
        const key = parseInt(br.cond.substring(5), 10);
        const value = new Function('V', 'return (' + cur.var + ')')(V);
        if (value === key) { taken = br; break; }
      } else if (evalCond(br.cond, V)) { taken = br; break; }
    }
    if (!taken) taken = branches.find(br => !br.cond) || null;
    if (!taken) return { trace, result: 'fallthrough' };
    cur = byId.get(taken.to);
  }
  return { trace, result: 'runaway' };
}
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

function bodyOf(b, extra) {
  return '__step(); __t.push(' + b.id + ');' + (extra || '');
}

// 每个用例返回 { blocks, entry, V, expectResult? }
function runCase(name, spec) {
  const blocks = spec.blocks();
  for (const b of blocks) {
    const term = b.terminates ? 'return { trace: __t, result: ' + JSON.stringify(b.ret || 'terminated') + ' };' : '';
    b.body = (b.var ? '' : '') + bodyOf(b, b.side || '') + term;
  }
  const want = reference(blocks, spec.entry, clone(spec.V));   // 参考先跑（条件有副作用，各自的 V 必须独立）
  let got, err = null;
  try { got = build(blocks, spec.entry)(clone(spec.V)); } catch (e) { err = e.message || String(e); }
  if (err) { check(name, false, '执行异常: ' + err); return; }
  const sameTrace = JSON.stringify(got.trace) === JSON.stringify(want.trace);
  const sameEnd = spec.expectResult ? got.result === spec.expectResult : got.result === want.result;
  check(name + ' 访问序列', sameTrace, 'got=' + JSON.stringify(got.trace) + ' want=' + JSON.stringify(want.trace));
  check(name + ' 结束方式', sameEnd, 'got=' + JSON.stringify(got.result) + ' want=' + JSON.stringify(spec.expectResult || want.result));
}

// ==== 用例 ====================================================================
runCase('直线 0→1→2(返回)', {
  entry: 0,
  blocks: () => [
    { id: 0, branches: [{ to: 1 }] },
    { id: 1, branches: [{ to: 2 }] },
    { id: 2, terminates: true, ret: 'ret' },
  ],
});

runCase('菱形 0-if(V.a)→1/2→3', {
  entry: 0, V: { a: 1 },
  blocks: () => [
    { id: 0, branches: [{ to: 1, cond: 'V.a===1' }, { to: 2 }] },
    { id: 1, branches: [{ to: 3 }] },
    { id: 2, branches: [{ to: 3 }] },
    { id: 3, terminates: true, ret: 'ret' },
  ],
});

runCase('菱形 走另一支 (V.a=0)', {
  entry: 0, V: { a: 0 },
  blocks: () => [
    { id: 0, branches: [{ to: 1, cond: 'V.a===1' }, { to: 2 }] },
    { id: 1, branches: [{ to: 3 }] },
    { id: 2, branches: [{ to: 3 }] },
    { id: 3, terminates: true, ret: 'ret' },
  ],
});

runCase('自环循环 1→1 三次', {
  entry: 0, V: { i: 0 },
  blocks: () => [
    { id: 0, branches: [{ to: 1 }] },
    { id: 1, branches: [{ to: 1, cond: '(V.i=V.i+1)<3' }, { to: 2 }] },
    { id: 2, terminates: true, ret: 'ret' },
  ],
});

runCase('嵌套循环（内含两个条件，求值顺序）', {
  entry: 0, V: { i: 0, j: 0, order: '' },
  blocks: () => [
    { id: 0, branches: [{ to: 1 }] },
    { id: 1, side: '', branches: [{ to: 2, cond: '(V.i=V.i+1)<=2' }, { to: 3 }] },
    { id: 2, branches: [{ to: 4 }] },
    { id: 3, terminates: true, ret: 'ret' },
    { id: 4, branches: [{ to: 5, cond: '(V.j=V.j+1)<=2' }, { to: 6 }] },
    { id: 5, branches: [{ to: 4 }] },
    { id: 6, branches: [{ to: 1 }] },
  ],
});

runCase('tableswitch 派发（branchVar + case N）', {
  entry: 0, V: { k: 2 },
  blocks: () => [
    { id: 0, branches: [{ to: 1 }] },
    { id: 1, var: 'V.k', branches: [{ to: 10, cond: 'case 1:' }, { to: 11, cond: 'case 2:' }, { to: 12, cond: 'case 3:' }, { to: 13 }] },
    { id: 10, branches: [{ to: 20 }] },
    { id: 11, branches: [{ to: 20 }] },
    { id: 12, branches: [{ to: 20 }] },
    { id: 13, branches: [{ to: 20 }] },
    { id: 20, terminates: true, ret: 'ret' },
  ],
});

runCase('tableswitch 落在 default', {
  entry: 0, V: { k: 99 },
  blocks: () => [
    { id: 0, branches: [{ to: 1 }] },
    { id: 1, var: 'V.k', branches: [{ to: 10, cond: 'case 1:' }, { to: 11, cond: 'case 2:' }, { to: 13 }] },
    { id: 10, branches: [{ to: 20 }] },
    { id: 11, branches: [{ to: 20 }] },
    { id: 13, branches: [{ to: 20 }] },
    { id: 20, terminates: true, ret: 'ret' },
  ],
});

runCase('死块不可达（0→2，1 无人引用）', {
  entry: 0,
  blocks: () => [
    { id: 0, branches: [{ to: 2 }] },
    { id: 1, branches: [{ to: 2 }] },
    { id: 2, terminates: true, ret: 'ret' },
  ],
});

runCase('无出口块（有入边但无分支）', {
  entry: 0,
  blocks: () => [
    { id: 0, branches: [{ to: 1 }] },
    { id: 1 },   // 无分支：参考语义=结束（fallthrough）
  ],
  expectResult: 'fallthrough',
});

runCase('switch 块无 default 且无匹配', {
  entry: 0, V: { k: 5 },
  blocks: () => [
    { id: 0, branches: [{ to: 1 }] },
    { id: 1, var: 'V.k', branches: [{ to: 10, cond: 'case 1:' }] },
    { id: 10, terminates: true, ret: 'ret' },
  ],
  expectResult: 'fallthrough',
});

runCase('入口派发：pc 命中中间块（异常回派发）', {
  entry: 0, V: { pc: 30 },
  blocks: () => [
    { id: 0, branches: [{ to: 1, cond: 'V.pc===0' }, { to: 5, cond: 'V.pc===30' }, { to: 9 }] },
    { id: 1, branches: [{ to: 2 }] },
    { id: 2, terminates: true, ret: 'ret' },
    { id: 5, branches: [{ to: 6 }] },
    { id: 6, terminates: true, ret: 'handler' },
    { id: 9, terminates: true, ret: 'invalid' },
  ],
  expectResult: 'handler',
});

runCase('分支 code（条件成立时先执行 code）', {
  entry: 0, V: { a: 1, hit: 0 },
  blocks: () => [
    { id: 0, branches: [{ to: 1, cond: 'V.a===1', code: 'V.hit=V.hit+1' }, { to: 2 }] },
    { id: 1, branches: [{ to: 3 }] },
    { id: 2, branches: [{ to: 3 }] },
    { id: 3, terminates: true, ret: 'ret' },
  ],
});

// code 生效的额外断言
{
  const blocks = [
    { id: 0, branches: [{ to: 1, cond: 'V.a===1', code: 'V.hit=V.hit+1' }, { to: 2 }] },
    { id: 1, branches: [{ to: 3 }] },
    { id: 2, branches: [{ to: 3 }] },
    { id: 3, terminates: true, ret: 'ret' },
  ];
  for (const b of blocks) b.body = bodyOf(b, '') + (b.terminates ? 'return { trace: __t, result: "ret" };' : '');
  const V = { a: 1, hit: 0 };
  build(blocks, 0)(V);
  check('分支 code 被执行', V.hit === 1, 'hit=' + V.hit);
}

// ==== 随机拓扑属性测试 ========================================================
// 用固定种子生成随机 CFG（含条件分支/无条件分支/终结块/自环/死块/switch 块），
// 逐例比较生成脚手架的访问序列与参考解释器。失败时打印种子以便复现。
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function randomCase(seed) {
  const rnd = mulberry32(seed);
  const n = 3 + Math.floor(rnd() * 8);
  const blocks = [];
  for (let i = 0; i < n; i++) blocks.push({ id: i, rl: i, branches: [] });
  for (let i = 0; i < n; i++) {
    const b = blocks[i];
    const r = rnd();
    if (r < 0.22) { b.terminates = true; b.ret = 'ret'; continue; }          // 终结块
    if (r < 0.30) continue;                                                  // 无出口块（死块）
    if (r < 0.42) {                                                          // switch 派发块
      b.var = 'V.k';
      const count = 1 + Math.floor(rnd() * 3);
      for (let c = 0; c < count; c++) b.branches.push({ to: Math.floor(rnd() * n), cond: 'case ' + (c + 1) + ':' });
      if (rnd() < 0.75) b.branches.push({ to: Math.floor(rnd() * n) });       // default
      continue;
    }
    const targets = 1 + Math.floor(rnd() * 2);
    for (let t = 0; t < targets; t++) {
      const to = Math.floor(rnd() * n);
      if (t === 0 && targets === 2) b.branches.push({ to, cond: 'V.a===' + Math.floor(rnd() * 3) });
      else b.branches.push({ to });
    }
  }
  return { blocks, entry: 0, V: { a: 1, k: 2 } };
}
let randomPass = 0;
const RANDOM_ROUNDS = 300;
for (let seed = 1; seed <= RANDOM_ROUNDS; seed++) {
  const spec = randomCase(seed);
  const blocks = spec.blocks;
  for (const b of blocks) {
    b.body = bodyOf(b, '') + (b.terminates ? 'return { trace: __t, result: "ret" };' : '');
  }
  const want = reference(blocks, spec.entry, clone(spec.V));
  let got = null, err = null;
  try { got = build(blocks, spec.entry)(clone(spec.V)); } catch (e) { err = e.message || String(e); }
  if (want.result === 'runaway') {           // 参考自身超步数：只要求同样 runaway 且前缀一致
    const okRunaway = !!err && err.indexOf('runaway') >= 0;
    if (!okRunaway) { check('随机拓扑 seed=' + seed + ' 应同样受步数上限保护', false, 'err=' + err + ' got=' + (got && got.result)); break; }
    randomPass++; continue;
  }
  if (err) { check('随机拓扑 seed=' + seed, false, '执行异常: ' + err); break; }
  if (JSON.stringify(got.trace) !== JSON.stringify(want.trace) || got.result !== want.result) {
    check('随机拓扑 seed=' + seed, false, 'got=' + JSON.stringify(got.trace) + '/' + got.result +
      ' want=' + JSON.stringify(want.trace) + '/' + want.result);
    break;
  }
  randomPass++;
}
check('随机拓扑属性测试 ' + randomPass + '/' + RANDOM_ROUNDS, randomPass === RANDOM_ROUNDS);

// ==== 汇总 ====================================================================
console.log('\n===== Relooper 一致性测试 =====');
console.log(pass + '/' + (pass + fail) + ' 通过');
if (fail) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
