#!/usr/bin/env node
/*
 * pack-output.mjs — 把 nx.js 打包器产出的文件改名到 dist/ 并打印校验信息（perfZ24）
 *
 * 由来：`@nx.js/nro` 的输出名取自 package.json 的 `name`（我们的 name 必须是合法 npm 名
 * "j2me-nx"），而发布产物要叫 **J2me-nx.nro**（NACP 里的显示标题同样是 "J2me-nx"）。
 * 这里统一做：复制到 dist/J2me-nx.<ext> → 删掉根目录那份 → 打印大小 + sha256
 * （发版说明直接抄这个哈希；也是"用户手上那个包到底是哪一版"的唯一凭据）。
 *
 * 用法：node tools/pack-output.mjs nro | nsp
 */
import { copyFileSync, existsSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ext = (process.argv[2] || 'nro').toLowerCase();
if (ext !== 'nro' && ext !== 'nsp') {
  console.error('用法: node tools/pack-output.mjs nro|nsp');
  process.exit(1);
}

// 打包器按 package.json 的 name 命名；两者都试一下，避免 name 改来改去时静默失败
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const candidates = [`${pkg.name}.${ext}`, `j2me-nx.${ext}`, `j2me-nx-port.${ext}`];
const src = candidates.map((f) => path.join(ROOT, f)).find((p) => existsSync(p));
if (!src) {
  console.error('找不到打包产物（试过: ' + candidates.join(', ') + '）—— 先跑 npm run ' + ext);
  process.exit(1);
}

const outDir = path.join(ROOT, 'dist');
mkdirSync(outDir, { recursive: true });
// 最终产物名固定为 J2me-nx.<ext>（复制而非改名：Windows 上"只改大小写"的改名不稳）
const outName = `J2me-nx.${ext}`;
const dst = path.join(outDir, outName);
copyFileSync(src, dst);
try { unlinkSync(src); } catch (e) { /* 根目录那份删不掉也不影响 */ }

const size = statSync(dst).size;
const sha = createHash('sha256').update(readFileSync(dst)).digest('hex').toUpperCase();
console.log('');
console.log('  ' + pkg.nacp?.title + ' v' + pkg.version + '  (' + (pkg.author || '?') + ')');
console.log('  产物: dist/' + outName + '  ' + size + ' B  (' + (size / 1048576).toFixed(2) + ' MB)');
console.log('  sha256: ' + sha);
console.log('');
