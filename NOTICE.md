# 第三方组件与未随包分发的资产 / Third-party components and non-bundled assets

> 这份文件是**第三方组件与资产清单**：哪些东西是别人的、各自什么许可证、哪些资产故意没进包，
> 以及仓库维护上需要知道的事实。请连同 `README.md` / `BUILD.md` / `RUNTIME.md` 一起保留。
> This file is the third-party component and asset inventory: what belongs to others, under which
> license, which assets are deliberately not included, and the facts needed to maintain this
> repository. Keep it together with `README.md` / `BUILD.md` / `RUNTIME.md`.

---

## 1. 本仓库包含的第三方代码 / Third-party code included here

| 组件 / Component | 来源 / Origin | 许可证 / License | 说明 / Notes |
|---|---|---|---|
| PluotSorbet（J2ME 虚拟机，JS） | [mozilla/pluotsorbet](https://github.com/mozilla/pluotsorbet) | GPL-2.0（含 Classpath 例外的 Java 部分） | `vendor/pluotsorbet/**`；本移植在其上打了补丁（补丁点都在代码里用 `PATCH(j2me-nx-port)` 标注） |
| phoneME / CLDC-HI 类库源码 | Sun / Oracle（`phoneME` 项目） | GPL-2.0 + Classpath 例外 | `java/cldc1.1.1/**`、`java/midp/**`；与 GPL-2.0-or-later 兼容 |
| 预编译类 `java/prebuilt-classes/**` | phoneME（如 `GBK_Reader`） | GPL-2.0 + Classpath 例外 | 8 个二进制 class，仓库内没有对应源码；构建 `classes.jar` 时注入，详见 §4 |
| nx.js 运行时 | [TooTallNate/nx.js](https://github.com/TooTallNate/nx.js) | MIT | 由 `npm install` 获取（`tools/node_modules`），本仓库不附带其二进制；移植文档里描述的 JIT 内存补丁属于"构建时的本地修改" |
| 字体 `data/fonts/cjk.ttf` | [Noto Sans SC](https://github.com/google/fonts/tree/main/ofl/notosanssc)（Adobe + Google，由 Source Han Sans 派生） | **SIL Open Font License 1.1** | 上游可变字体 `NotoSansSC[wght].ttf` 用 fontTools 实例化成静态 Regular（`wght=400`）。保留字体名（RFN）是 `Source`，本字体未使用该名。版权/许可信息保留在字体内部，许可证全文见 `data/fonts/OFL-NotoSansSC.txt`（打包后是 romfs 的 `fonts/OFL.txt`）。`fsType=0`，允许再分发 |
| 遮罩素材 `data/mask.raw` | 由本项目处理生成（1280×720 RGBA 裸数据） | 视原始图片来源而定 | 再分发前请确认原始图片的权利归属，见 §3 |
| 遮罩素材 `data/masks/*.raw` | 本项目自绘 / 自行生成 | 随本仓库许可证 | 8 张可选遮罩 |

**字体变更说明（1.0.0 起）**：1.0.0 之前的版本内置 SimHei，其 `OS/2.fsType = 8`
（editable embedding）**不允许再分发**，发布到 Git 有版权问题。现改为 OFL 的
Noto Sans SC，可自由再分发/修改/商用。
**Font change (since 1.0.0)**: earlier builds bundled SimHei, whose `OS/2.fsType = 8`
(editable embedding) **forbids redistribution** — a genuine problem for a public release. The
bundle now uses Noto Sans SC under the OFL, which is free to redistribute, modify and use
commercially.

---

## 2. 故意**不**包含在仓库里的东西 / Deliberately not included

| 未包含 / Not included | 原因 / Reason | 你需要怎么补 / How to supply it |
|---|---|---|
| `data/adlmidi/libadlmidi.full.core.wasm` | 第三方 wasm（LGPL/GPL 的 ADLMIDI 打包产物），且本移植默认 `wasm = off` | 想用 ADLMIDI 时自行获取；不放也能跑（MIDI 走自带波表合成器） |
| `data/java/classes.jar`、`java/classes.jar` | 构建产物 | `node tools/build-classes.mjs` 从 `java/` 源码现编 |
| `bld/`、`romfs/`、`dist/` | 构建产物 | `node tools/build.mjs` → `node tools/package.mjs` → `npm run nro` |
| `tools/node_modules/` | npm 依赖 | `cd tools && npm install` |
| 任何游戏 `.jar` | 版权属于游戏厂商 | 用户自备；仓库里连测试夹具都换成了自制的 `tools/fixture/fixture.jar` |
| 运行日志、备份、研究资料 | 与源码无关（且含个人信息/体积大） | 无 |

> 关于运行时 JIT：官方 nx.js 运行时在 Switch 上会因为 W^X 限制在分配 JIT 代码页时崩溃
> （`Data Abort`，见 `data/nxjs.ini` 的历史注释）。本移植在开发机上使用的是一个**打了
> 4 字节补丁**（在 chunk 构造里通过可写别名写回）的运行时构建，**该二进制不随仓库分发**。
> 用官方运行时的用户请把 `data/nxjs.ini` 的 `[v8] jit` 设为 `off`（慢一些但可用）。
> About JIT: the official nx.js runtime aborts on the Switch (`Data Abort`) when allocating JIT
> code pages because Horizon exposes them read-only. This port was developed against a runtime
> build with a 4-byte patch (writing back through the writable alias); **that binary is not
> distributed here**. With the official runtime, set `[v8] jit = off` in `data/nxjs.ini`
> (slower, but it works).

---

## 3. 用户需要注意的版权问题 / Copyright notes for users

- 本程序**不包含任何游戏**；请自行准备你有权使用的游戏 jar（正版卡带/自购应用导出的自有备份等）。
  This project ships **no games**; supply jars you are legally entitled to use.
- 遮罩素材里的默认遮罩由图片处理得到，若原始图片非你所有，请替换成自制图。
  The default mask was processed from an image; if you do not own the original, replace it with your own.

---

## 4. 维护说明 / Repository maintenance notes

- `release/` 下的这些模板是公开发布文档的**唯一来源**；改完模板后重跑 `node tools/make-publish.mjs`
  即可刷新发布快照（该脚本会打印进了包与没进包的清单）。
  The templates under `release/` are the single source of the published documents; after editing them,
  re-run `node tools/make-publish.mjs` to refresh the snapshot (it prints the included and the excluded
  file lists).
- `java/prebuilt-classes/**` 里有 8 个**没有随仓库携带源码**的编译产物
  （`com/sun/cldc/i18n/j2me/` 下的中文与西欧编码读写器，以及
  `com/sun/midp/l10n/LocalizedStrings_zh_CN`），构建 `classes.jar` 时注入；`classes.jar` 里其余的
  class 全部由 `java/` 下的源码现编。删除该目录即可得到完全由源码构建的 `classes.jar`
  （受影响的编码会回落到仓库内的实现）。
  `java/prebuilt-classes/**` holds eight compiled classes **whose sources are not in this repository**
  (the Chinese and Western-European i18n readers under `com/sun/cldc/i18n/j2me/`, plus
  `com/sun/midp/l10n/LocalizedStrings_zh_CN`); they are injected while `classes.jar` is built.
  Every other class in `classes.jar` is compiled from the sources under `java/`; removing that
  directory yields a fully source-built `classes.jar` (the affected encodings then fall back to the
  in-repo implementations).
- 运行时的 JIT 补丁说明见 `RUNTIME.md`。
  The runtime's JIT patch is documented in `RUNTIME.md`.
