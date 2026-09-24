# 文字编码测试包（enctest.jar）

验证 **GBK / UTF-8 文本在 VM 里解得对不对**，也就是实机「游戏文字丢字」那条链：

```
jar 里的 GBK 字节 → new String(bytes)（平台默认编码）→ drawString
```

## 为什么要有它

2026-09-23 实机反馈「Forgotten Warrior 能进去了，但丢文字」。真凶是**默认编码**：
游戏的剧情文本（`<n>.sn`）是 **GBK**，而 VM 报的 `microedition.encoding` 是上游默认的
**UTF-8**，于是 `new String(bytes)` 把整段对白解成 U+FFFD（实测 `1.sn` 91 个替换字符）。

还有第二个坑：本移植层的 GBK 转换原本靠 `new TextDecoder('gbk')`，而 **nx.js 的
TextDecoder 只有 utf-8** —— 桌面 Node 有完整 ICU 所以仿真永远看不出问题。
现在运行时用自带的 `vendor/pluotsorbet/midp/gbk-table.js`（23,940 项）兜底。

## 跑法

```powershell
node tools/encoding-test/build.mjs   # 生成 test.txt(GBK) + javac + 打包
node tools/test-encoding.mjs         # 端到端（会把 TextDecoder 换成 nx.js 那样只有 utf-8 的）
node tests/gbk-table.test.mjs        # 表/解码器与宿主 ICU 的全量比对 + 真实游戏 .sn 校验
```

`tools/test-encoding.mjs` 开头会**自检**"TextDecoder 真的被换成只认 utf-8 了"，
否则它会直接失败退出 —— 避免在带 ICU 的 Node 上假绿。

期望（修好后）：

```
[enc] prop=GBK
[enc] default codes=4f60,597d (len=2)        ← new String(GBK 字节) = 你好
[enc] GBK codes=4f60,597d (len=2)            ← 显式 GBK（真机走自带映射表）
[enc] utf8-as-default codes=4f60,597d (len=2)← UTF-8 字节仍解得对
[enc] getBytes hex=c4e3bac3                  ← 回写也是 GBK
[enc] txt codes=6e38,620f,6587,... (len=13)  ← jar 内 GBK 文件 = 游戏文字测试：你好，世界。
结果: 全部通过 ✔
```

码点一律用十六进制打印，这样**不受日志编码影响**（实机上 Java 日志是桥接字节）。

## 三条解码路径（改坏了先查这里）

| 路径 | 位置 | 说明 |
|---|---|---|
| 默认编码 | `vendor/pluotsorbet/native.js` 的 `microedition.encoding` | 现为 **GBK**（模拟中文手机）；`String.getBytes()` 也按它写 |
| 自动判定 | `java/cldc1.1.1/com/sun/cldc/i18n/Helper.java` 的 `byteToCharArray([BII)` | 严格合法 UTF-8 → 按 UTF-8；否则按默认编码（GBK）。显式指定编码的调用不经过这里 |
| GBK 解码 | `vendor/pluotsorbet/midp/conv.js` + `gbk.js` + `gbk-table.js` | 原生 `TextDecoder` 不可用时走自带表；判定用**试解**（"你" C4 E3 → U+4F60），因为有的运行时不抛异常、直接按 UTF-8 解 |

`System.out`（`java/io/PrintStream.java`）固定 UTF-8：日志文件是 UTF-8，
不跟默认编码走，否则 Java 侧中文诊断行会全变乱码。

`test.txt` 的字节是 `build.mjs` 用**仓库里那张表**反查生成的（不依赖宿主 ICU），
内容 = `游戏文字测试：你好，世界。`
