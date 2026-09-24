/*
 * 读盘类型契约回归（perfZ26）
 *
 * 实机事故：`Switch.readFileSync` 返回 **ArrayBuffer**，Node 的 `fs.readFileSync` 返回
 * **Buffer**（有 `.length`）。源码里 `if (bytes && bytes.length)` 在仿真里恒真、实机恒假，
 * 于是三个功能在真机上静默失效（语言/按键映射/按键机型），日志还撒谎说"没有文件"。
 * 本测试钉两件事：
 *   ① `g.__toU8` 的类型规整矩阵（ArrayBuffer 是重点：规整后必须有可用的 .length）；
 *   ② `app/main.js` 的唯一读盘入口 `readFileSyncLocal` 必须过 `__toU8`
 *      （谁再直接返回原始值，实机就会重演那个 bug）；
 *   ③ 启动日志必须给出落盘文件的存在性/字节数（否则下次又只能靠猜）。
 *
 * 运行：node tests/readfile-contract.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (ok) { passed++; } else { failed++; console.error(`FAIL ${name}: actual=${actual} expected=${expected}`); }
}

// ---- ① 在**本 realm** 里求值 src/host/bytes.js，拿到 __toU8 ----
// ⚠ 必须在本 realm 求值：bytes.js 内部用 `x instanceof Uint8Array` 判断，
//   在 vm 沙箱里跑会得到另一个 realm 的构造器，测出来的结论对实机没有意义。
const fake = { console: { log() {}, warn() {}, error() {} } };
// eslint-disable-next-line no-new-func
new Function('globalThis', readFileSync(join(root, 'src/host/bytes.js'), 'utf8'))(fake);
const toU8 = fake.__toU8;
check('bytes.js 导出 __toU8', typeof toU8, 'function');
check('bytes.js 自检标记 __toU8ContractOk', fake.__toU8ContractOk, true);

// 实机场景：ArrayBuffer（**关键**：规整后 .length 必须等于字节数）
{
  const ab = new Uint8Array([0x7b, 0x22, 0x6c, 0x61, 0x6e, 0x67, 0x22, 0x3a, 0x22, 0x65, 0x6e, 0x22, 0x7d]).buffer;
  const u8 = toU8(ab);
  check('ArrayBuffer → Uint8Array', u8 instanceof Uint8Array, true);
  check('ArrayBuffer 规整后 .length 可用（当初就是这里挂的）', u8.length, 13);
  check('ArrayBuffer 内容不丢', new TextDecoder().decode(u8), '{"lang":"en"}');
}
// 仿真场景：Node Buffer（本身就是 Uint8Array）
{
  const buf = Buffer.from('{"lang":"zh"}\n', 'utf8');
  const u8 = toU8(buf);
  check('Buffer 原样透传（不复制）', u8 === buf, true);
  check('Buffer .length 可用', u8.length, 14);
}
// 带偏移的视图不能被规整歪
{
  const backing = new Uint8Array([9, 9, 65, 66, 67, 9]).buffer;
  const view = new Uint8Array(backing, 2, 3);
  const u8 = toU8(view);
  check('偏移视图原样透传', u8.byteOffset, 2);
  check('偏移视图内容正确', [...u8].join(','), '65,66,67');
}
// 空值一律 null（调用方靠它判断"文件不存在"）
check('null → null', toU8(null), null);
check('undefined → null', toU8(undefined), null);
check('0 → null', toU8(0), null);
check('空字符串 → null', toU8(''), null);
check('空 ArrayBuffer → 长度 0 的视图（不是 null）', toU8(new ArrayBuffer(0)).length, 0);

// ---- ② 唯一读盘入口必须过 __toU8 ----
const mainSrc = readFileSync(join(root, 'app/main.js'), 'utf8');
const rfs = mainSrc.slice(mainSrc.indexOf('function readFileSyncLocal'));
const rfsBody = rfs.slice(0, rfs.indexOf('\n  }'));
const flat = rfsBody.replace(/\s+/g, ' ');
check('readFileSyncLocal 走 __toU8（实机 ArrayBuffer 规整）',
  flat.indexOf('toU8(g.Switch.readFileSync(path))') > 0, true);
check('readFileSyncLocal 走 __toU8（Node Buffer 规整）',
  flat.indexOf("require('fs').readFileSync(path)") > 0 && flat.indexOf('return toU8(b);') > 0, true);
check('契约注释写明了返回值是 Uint8Array',
  mainSrc.indexOf('契约：返回 Uint8Array 或 null') > 0, true);
// 反面：不许再出现"把读到的原始值直接 return 出去"的写法（实机就是 ArrayBuffer）
check('没有裸返回 Switch.readFileSync 的写法',
  /return\s+g\.Switch\.readFileSync\(/.test(mainSrc), false);
check('没有裸返回 require(\'fs\').readFileSync 的写法',
  /return\s+require\('fs'\)\.readFileSync\(/.test(mainSrc), false);

// ---- ③ SCRIPTS 表里 bytes.js 必须第一个 eval（读盘前就绪）----
{
  const i = mainSrc.indexOf('var SCRIPTS');
  const table = mainSrc.slice(i, mainSrc.indexOf('];', i));
  const first = table.match(/\['([^']+)'\s*,\s*'([^']+)'\]/);
  check('SCRIPTS 第一项是 src/host/bytes.js', first && first[1], 'src/host/bytes.js');
  const pkgSrc = readFileSync(join(root, 'tools/package.mjs'), 'utf8');
  check('package.mjs 拷贝 host/bytes.js', pkgSrc.indexOf("'host/bytes.js'") > 0, true);
}
// ---- ④ 启动日志给出落盘文件存在性与字节数 ----
check('启动打印落盘文件清单 [io] 落盘文件',
  mainSrc.indexOf('[io] 落盘文件: ') > 0, true);
check('语言载入日志带字节数（内容 + 长度）',
  mainSrc.indexOf("'字符 内容=\"'") > 0, true);
check('三个落盘文件都在诊断清单里',
  mainSrc.indexOf("['lang.json', LANG_FILE]") > 0 &&
  mainSrc.indexOf("['keys.txt', KEYS_FILE]") > 0 &&
  mainSrc.indexOf("['keyprofiles.json', KEYPROF_FILE]") > 0, true);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
