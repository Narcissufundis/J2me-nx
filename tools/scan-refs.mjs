#!/usr/bin/env node
// 扫描解包目录中所有 .class 的常量池，报告引用了哪些 com/nokia、javax 外部 API
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const targets = ['com/nokia', 'javax/microedition', 'com/sun'];
const found = new Map();

function scan(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) scan(p);
    else if (name.endsWith('.class')) {
      const buf = readFileSync(p);
      const text = buf.toString('latin1');
      for (const t of targets) {
        let idx = 0;
        while ((idx = text.indexOf(t, idx)) !== -1) {
          // 提取完整类路径（latin1 可打印段）
          let start = idx;
          while (start > 0 && /[\w\/$]/.test(text[start - 1])) start--;
          let end = idx + t.length;
          while (end < text.length && /[\w\/$;\Z]/.test(text[end])) end++;
          const ref = text.slice(start, end).replace(/;.*$/, '');
          if (!found.has(ref)) found.set(ref, new Set());
          found.get(ref).add(name);
          idx = end;
        }
      }
    }
  }
}
scan(root);
for (const [ref, files] of [...found.entries()].sort()) {
  console.log(ref + '  <- ' + [...files].slice(0, 3).join(', '));
}
