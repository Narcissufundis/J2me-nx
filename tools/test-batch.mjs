#!/usr/bin/env node
/*
 * test-batch.mjs — 批量本地仿真：对目录下每个 jar 各跑一次 simulate.mjs
 *
 * 用法: node tools/test-batch.mjs <jar目录> [输出报告]
 * 每个游戏独立进程 + 独立 20s 观察窗，汇总：菜单解析 / 分辨率探测 /
 * VM 启动 / 渲染调用 / 失败原因摘录。报告写到 bld/batch-report.txt。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const dir = resolve(process.argv[2] || '');
const reportPath = resolve(process.argv[3] || join(root, 'bld', 'batch-report.txt'));

const jars = readdirSync(dir).filter((f) => /\.jar$/i.test(f)).sort();
if (!jars.length) {
  console.error('目录里没有 jar: ' + dir);
  process.exit(1);
}

const results = [];
for (let i = 0; i < jars.length; i++) {
  const jar = join(dir, jars[i]);
  console.log(`[${i + 1}/${jars.length}] ${jars[i]} ...`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(root, 'tools', 'simulate.mjs')], {
    env: { ...process.env, J2ME_TEST_JAR: jar },
    timeout: 35000,
    encoding: 'utf8',
  });
  const out = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
  const dt = Math.round((Date.now() - t0) / 1000);

  // 完整日志落盘（bld/batch-logs/<jar名>.log），便于事后排查
  const logDir = join(dirname(reportPath), 'batch-logs');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, jars[i] + '.log'),
    out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '?'), 'utf8');

  const rec = {
    jar: jars[i],
    seconds: dt,
    exit: r.status,
    menuName: '',
    detect: '',
    started: false,
    draws: 0,
    fatal: '',
    tail: '',
  };

  const menuM = out.match(/\[menu\] #1 (.+?)(?:（无入口类）)? <- .*\n/);
  if (menuM) rec.menuName = menuM[1].trim();
  const detectM = out.match(/\[detect\][^\n]*/);
  if (detectM) rec.detect = detectM[0].trim();
  const drawM = out.match(/绘图调用: (\d+) 次/);
  if (drawM) rec.draws = +drawM[1];
  rec.started = /MIDletSuiteLoader|VM 启动|运行 MIDlet/.test(out) && rec.draws > 0;

  // 失败原因：取 Loading failed / 异常 / Error 行
  const bad = out.split('\n').filter((l) =>
    /Loading failed|Exception|Error|错误|失败|异常|无法|Cannot|undefined/.test(l) &&
    !/未处理的 rejection（资源缺失阶段/.test(l));
  rec.fatal = bad.slice(-3).join(' | ').trim();
  rec.tail = out.split('\n').slice(-12).join('\n');

  results.push(rec);
  console.log(`    -> ${rec.started ? 'OK' : 'FAIL'} draws=${rec.draws} (${dt}s)`);
}

// ---- 汇总 ----
const lines = [];
lines.push('J2ME 本地批量仿真报告  ' + new Date().toLocaleString('zh-CN'));
lines.push('目录: ' + dir);
lines.push('数量: ' + results.length);
lines.push('');
for (const r of results) {
  lines.push('== ' + r.jar);
  const hung = !r.started && r.seconds >= 30;
  lines.push('   游戏名: ' + (r.menuName || '(解析失败)') +
    (r.detect ? '   ' + r.detect : '') +
    '   ' + (r.started ? '可启动✔' : hung ? '卡死✘（事件循环被饿死）' : '启动失败✘') +
    '   绘图 ' + r.draws + ' 次   ' + r.seconds + 's');
  if (!r.started && r.fatal) lines.push('   原因: ' + r.fatal);
  if (hung) lines.push('   日志: bld/batch-logs/' + r.jar + '.log');
  lines.push('');
}

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, lines.join('\n'), 'utf8');

const okN = results.filter((r) => r.started).length;
console.log('---');
console.log(`汇总: ${okN}/${results.length} 可启动，报告: ${reportPath}`);
for (const r of results) {
  if (!r.started) console.log('  FAIL ' + r.jar + (r.fatal ? '  <- ' + r.fatal.slice(0, 160) : ''));
}
