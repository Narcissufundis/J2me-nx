// classes.jar 一键构建（2026-09-21 固化，按踩坑教训定序）
// 顺序铁律：源码汇集(custom 覆盖 midp) → javac → jar cf0 → prebuilt 注入 →
// l10n 资源 → 同步 data/java/classes.jar（权威源）→ 反汇编字节码终验。
// 用法: node tools/build-classes.mjs [--skip-compile]（跳过 javac，仅重打包）
import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const JAVA = path.join(ROOT, 'java');
// JDK 路径：优先环境变量 JDK_BIN（别的机器/CI 上必须能指定），其次 JAVA_HOME/bin，
// 最后才回落作者本机默认位置。
// ⚠ 需要 **JDK 8**（javac -source 1.3 -target 1.3 + -bootclasspath ""）。
// PATCH(perfZ49)：工具名后缀按平台取 —— Windows 是 `javac.exe`，POSIX 是 `javac`。
// 由来：仓库发布时带上了 .github/workflows/ci.yml（ubuntu-latest），而本文件原先写死 `.exe`，
// CI 上必然 "command not found"。保持 Windows 行为不变（win32 仍取 .exe）。
const JDK = process.env.JDK_BIN ||
  (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : 'D:/j2me/jdk1.8.0_281/bin');
const EXE = process.platform === 'win32' ? '.exe' : '';
const JAVAC = `${JDK}/javac${EXE}`;
const JAR = `${JDK}/jar${EXE}`;
const JAVAP = `${JDK}/javap${EXE}`;
const DIRS = ['cldc1.1.1', 'vm', 'midp', 'custom', 'jsr-256', 'jsr-179', 'jsr-082'];
const skipCompile = process.argv.includes('--skip-compile');

// 全程以 java/ 为工作目录（javac/jar 相对路径依赖）
process.chdir(JAVA);

const sh = (cmd, cwd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], cwd });

// 1) 汇集 build-src（后者覆盖前者）
fs.rmSync(path.join(JAVA, 'build-src'), { recursive: true, force: true });
fs.mkdirSync(path.join(JAVA, 'build-src'));
for (const d of DIRS) {
  const src = path.join(JAVA, d);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(JAVA, 'build-src'), { recursive: true });
}
const files = [];
(function walk(d, rel) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (f.isDirectory()) walk(d + '/' + f.name, rel + '/' + f.name);
    else if (/\.java$/.test(f.name)) files.push('.' + rel + '/' + f.name);
  }
})(path.join(JAVA, 'build-src'), '/build-src');
fs.writeFileSync(path.join(JAVA, 'build-srcs.txt'), files.join('\n') + '\n');
console.log('[1] build-src 汇集完成，java 文件:', files.length);

// 2) 编译
// ⚠️ -encoding UTF-8 不能省（2026-09-23 实机排查踩到）：源文件是 UTF-8，而中文 Windows 上
// javac 默认按 GBK 解码，于是 javac 把 "后"(E5 90 8E) 读成 "钥"+U+FFFD —— **class 里的中文
// 字面量全烂**。后果不是乱码那么简单：Display.java 里 "[textinput] 当前界面没有可写的文本框"
// 在实机日志里变成 "褰撳墠鐣岄潰..."，排查时按中文关键字找不到这行，直接误判成"补丁没走这个分支"，
// 白花了一轮实机（本文件末尾有对应的终验项守这道门）。
if (!skipCompile) {
  fs.rmSync(path.join(JAVA, 'build'), { recursive: true, force: true });
  fs.mkdirSync(path.join(JAVA, 'build'));
  sh(`"${JAVAC}" -encoding UTF-8 -nowarn -Xlint:none -cp build-src -g:none -source 1.3 -target 1.3 -bootclasspath "" -extdirs "" -d ./build @build-srcs.txt`);
  console.log('[2] javac 完成（-encoding UTF-8）');
} else {
  console.log('[2] 跳过编译 (--skip-compile)');
}

// 3) 打 jar
process.chdir(path.join(JAVA, 'build'));
sh(`"${JAR}" cf0 ../classes.jar .`);
process.chdir(JAVA);
console.log('[3] jar cf0 完成');

// 4) 注入 prebuilt class（无源码的类：GBK Reader 等）
if (fs.existsSync(path.join(JAVA, 'prebuilt-classes'))) {
  process.chdir(path.join(JAVA, 'prebuilt-classes'));
  sh(`"${JAR}" uf0 ../classes.jar com`);
  process.chdir(JAVA);
  console.log('[4] prebuilt-classes 注入完成');
}

// 5) l10n 资源
const l10n = fs.existsSync(path.join(JAVA, 'l10n')) ? fs.readdirSync(path.join(JAVA, 'l10n')).filter(f => f.endsWith('.json')) : [];
if (l10n.length) {
  sh(`"${JAR}" uf0 classes.jar ${l10n.map(f => 'l10n/' + f).join(' ')}`);
  console.log('[5] l10n 资源注入:', l10n.join(', '));
}

// 6) 同步权威源
// PATCH(perfZ24)：目标目录可能不存在（干净 clone 里 data/java/ 是空的，因为 classes.jar
// 本来就不入库）—— 先建目录再拷，否则首次构建会 ENOENT 挂在这里。
fs.mkdirSync(path.dirname(path.join(ROOT, 'data/java/classes.jar')), { recursive: true });
fs.copyFileSync(path.join(JAVA, 'classes.jar'), path.join(ROOT, 'data/java/classes.jar'));
console.log('[6] 已同步 data/java/classes.jar', (fs.statSync(path.join(ROOT, 'data/java/classes.jar')).size / 1048576).toFixed(2) + 'MB');

// 7) 清理 build-src（build/ 保留以便 --skip-compile 复用）
fs.rmSync(path.join(JAVA, 'build-src'), { recursive: true, force: true });

// 8) 字节码终验（补丁必须真的在包里）
const VERIFY_DIR = path.join(JAVA, '.verify-jar');
fs.rmSync(VERIFY_DIR, { recursive: true, force: true });
fs.mkdirSync(VERIFY_DIR);
process.chdir(VERIFY_DIR);
// ⚠️ 文本输入补丁在 **内部类** Display$DisplayEventConsumerImpl 里（handleInputMethodEvent /
// handleCommandEvent 都在那），不是外层 Display —— 只反汇编外层会"验证通过"但什么都没查到。
const CONSUMER_CLASS = 'javax/microedition/lcdui/Display$DisplayEventConsumerImpl.class';
sh(`"${JAR}" xf ../classes.jar javax/microedition/lcdui/Display.class javax/microedition/lcdui/Displayable.class "${CONSUMER_CLASS}" com/sun/cldc/io/ResourceInputStream.class java/io/InputStream.class`);
const disDisplay = sh(`"${JAVAP}" -p -c javax/microedition/lcdui/Display.class`);
const disDisplayable = sh(`"${JAVAP}" -p -c javax/microedition/lcdui/Displayable.class`);
const disConsumer = sh(`"${JAVAP}" -p -c "${CONSUMER_CLASS}"`);
// ⚠️ 包名是 com/sun/cldc/io（源码放在 java/custom/com/sun/cldchi/io/ 目录下，
//    但 package 声明是 com.sun.cldc.io）—— 目录名带 "hi" 会 jar xf 找不到（踩过）。
const disResIn = sh(`"${JAVAP}" -p -c com/sun/cldc/io/ResourceInputStream.class`);
const disInputStream = sh(`"${JAVAP}" -p -c java/io/InputStream.class`);
// 中文诊断字面量不能在 javap 输出里匹配：JDK8 的 javap 按 Windows 控制台代码页
// （cp936）输出，管道里拿到的是 GBK 字节，用 UTF-8 正则去匹配永远不中（踩过一次）。
// 直接查 class 文件字节里的 UTF-8 序列，与代码页无关。
const consumerBytes = fs.readFileSync(path.join(VERIFY_DIR, CONSUMER_CLASS));
const hasUtf8Literal = (s) => consumerBytes.indexOf(Buffer.from(s, 'utf8')) !== -1;
const hasCnGuard = hasUtf8Literal('没有可写的文本框');
const hasCnWritten = hasUtf8Literal('已写入');
process.chdir(ROOT);
fs.rmSync(VERIFY_DIR, { recursive: true, force: true });

// 取方法签名后固定窗口（isShown 方法体很小，1500 字符足够；
// InputStream.skip 的字节码有 ~100 行，窗口得给大些，否则会把分块 read 的调用切掉 —— 踩过）
const bodyOf = (dis, sig, size) => {
  const i = dis.indexOf(sig);
  return i < 0 ? '' : dis.slice(i, i + (size || 1500));
};
const isShownBody = bodyOf(disDisplay, 'boolean isShown(javax.microedition.lcdui.DisplayableLF)');
const dispShownBody = bodyOf(disDisplayable, 'public boolean isShown()');
const skipResInBody = bodyOf(disResIn, 'public long skip(long)', 6000);
const skipBaseBody = bodyOf(disInputStream, 'public long skip(long)', 6000);

const checks = [
  ['isShown 新代码 (transitionCurrent)', /transitionCurrent/.test(isShownBody)],
  ['isShown 无 hasForeground 残留', !/hasForeground/.test(isShownBody)],
  ['isShown yield 自愈', /yield/.test(dispShownBody)],
  // 中文诊断字面量必须原样进包（见第 2 步 -encoding UTF-8 的注释：
  // 少了 -encoding，class 里会变成 "褰撳墠鐣岄潰..."，实机日志按中文关键字就搜不到，
  // 排查时会误判成"补丁没走这个分支"—— 2026-09-23 取名那次就是这么被带偏的）
  ['textinput 中文诊断字面量未被 javac 编码搞坏', hasCnGuard],
  ['textinput 写入确认字面量存在', hasCnWritten],
  ['textinput 补丁在内部类里（handleInputMethodEvent）', /handleInputMethodEvent/.test(disConsumer)],
  // perfZ22：资源流 skip 的 O(1) 快进补丁必须真的在包里（少了它 = 逐字节 native 调用，
  // 实机表现是"进图卡住"）。子类覆盖 + 基类分块兜底两处都查。
  ['ResourceInputStream 覆盖 skip → 调 skipBytes', /skipBytes/.test(skipResInBody)],
  ['InputStream.skip 已改为分块 read(byte[])', /read:\(\[BII\)I/.test(skipBaseBody)],
];
let bad = 0;
for (const [name, ok] of checks) { console.log((ok ? 'OK  ' : 'FAIL ') + name); if (!ok) bad++; }

// 条目验证
const entries = execSync(`"${JAR}" tf data/java/classes.jar`, { cwd: ROOT }).toString().split(/\r?\n/).filter(l => l.trim());
const need = [
  'com/sun/cldc/i18n/j2me/GBK_Reader.class',
  'com/sun/midp/l10n/LocalizedStrings_zh_CN.class',
  'javax/microedition/lcdui/game/LayerManager.class',
  'java/lang/StringBuilder.class',
  'javax/microedition/lcdui/Display.class',
];
for (const n of need) {
  const ok = entries.includes(n);
  console.log((ok ? 'OK  ' : 'FAIL ') + n);
  if (!ok) bad++;
}
console.log('总条目:', entries.length);
if (bad) { console.error('!!! 终验失败', bad, '项'); process.exit(1); }
console.log('=== classes.jar 构建完成，全部验证通过 ===');
