// 解析 V8 cpuprofile，输出 self-time Top 20
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'F:/Deepseek/j2me-nx-port/prof';
const f = readdirSync(dir).filter(n => n.endsWith('.cpuprofile'))[0];
const p = JSON.parse(readFileSync(join(dir, f), 'utf8'));

const byId = new Map(p.nodes.map(n => [n.id, n]));
// self time: compute from samples + timeDeltas
const self = new Map();
for (let i = 0; i < p.samples.length; i++) {
  const id = p.samples[i];
  const dt = p.timeDeltas[i] || 0;
  self.set(id, (self.get(id) || 0) + dt);
}
const rows = [];
for (const [id, t] of self) {
  const n = byId.get(id);
  if (!n) continue;
  const cf = n.callFrame;
  let name = cf.functionName || '(anon)';
  if (cf.url) {
    const short = cf.url.split(/[\\/]/).pop();
    name += ' @' + short + ':' + (cf.lineNumber + 1);
  }
  rows.push([t / 1000, name]);
}
rows.sort((a, b) => b[0] - a[0]);
const total = rows.reduce((s, r) => s + r[0], 0);
console.log('total sampled: ' + (total / 1000).toFixed(1) + 'ms');
for (const [t, name] of rows.slice(0, 25)) {
  console.log((t).toFixed(1).padStart(8) + 'ms  ' + name.slice(0, 120));
}
