# J2me-nx — 在 Nintendo Switch 上运行 J2ME 游戏
# J2me-nx — Run J2ME games on Nintendo Switch

> 版本 / Version: **1.0.0** ｜ 作者 / Author: **Narcissufundis** ｜ 产物 / Artifact: **`dist/J2me-nx.nro`**
>
> 基于 Mozilla [PluotSorbet](https://github.com/mozilla/pluotsorbet)（纯 JavaScript 的 J2ME 虚拟机）
> 与 [nx.js](https://github.com/TooTallNate/nx.js)（Switch 上的 V8 运行时）。
> Built on Mozilla [PluotSorbet](https://github.com/mozilla/pluotsorbet) (a pure-JavaScript J2ME VM)
> and [nx.js](https://github.com/TooTallNate/nx.js) (V8 runtime for the Switch).

---

## 1. 这是什么 / What this is

把 Java 手机（J2ME / MIDP）游戏搬到 Switch 上跑的**自制模拟器**。
A homebrew emulator that runs Java ME (J2ME / MIDP) mobile games on the Switch.

游戏本体不需要任何改动、不需要重新编译，直接放 jar 就能玩。
Games need no modification and no recompilation — drop the `.jar` in and play.

整个虚拟机是 JavaScript 写的，跑在 Switch 自制固件（Atmosphère）的 homebrew 环境里。
The whole virtual machine is written in JavaScript and runs as homebrew on Atmosphère CFW.

安装：把 `J2me-nx.nro` 放到 `sdmc:/switch/`，游戏 `.jar` 放到 `sdmc:/switch/java/`。
Install: copy `J2me-nx.nro` to `sdmc:/switch/` and your game `.jar` files to `sdmc:/switch/java/`.

---

## 2. 优势 / Advantages

- 纯 JavaScript 虚拟机：游戏 jar 开箱即用，不需要为 Switch 重新编译，也不需要改游戏文件。
  Pure-JavaScript VM: game jars work as-is — no recompilation for the Switch, no patching of game files.
- 中文游戏开箱可用：自动识别 GBK / UTF-8 文本编码，自带 GBK 映射表与 CJK 字体注册（含粗体/斜体变体）。
  Chinese games work out of the box: automatic GBK/UTF-8 detection, a built-in GBK table, and CJK font registration (including bold/italic variants).
- 带完整的游戏菜单：自动扫描 SD 卡、改名、每游戏分辨率、遮罩、按键映射、按键机型、删除，全部落盘保存。
  A full built-in game menu: scans the SD card, rename, per-game resolution, masks, key mapping, key profile, delete — all persisted to the SD card.
- 每个游戏独立存档：以 jar 文件名分目录存放（RMS / IndexedDB 落到 SD 上的 JSON），换游戏互不干扰。
  Per-game save data: one folder per jar file (RMS/IndexedDB stored as JSON on the SD card), so games never step on each other.
- 手柄映射齐全：A/B/X/Y、L/R、ZL/ZR 软键、十字键、L3/R3、+/-，并且可以把任意物理键绑到任意 MIDP 键。
  Complete controller mapping: A/B/X/Y, L/R, ZL/ZR soft keys, D-pad, L3/R3, +/- — and any physical button can be bound to any MIDP key.
- 游戏内打字两套方案：内置文字键盘（手柄选择）＋ Switch 系统键盘（可切中文输入）。
  Two ways to type in-game: a built-in on-screen keyboard (driven by the controller) and the Switch system keyboard (with Chinese IME).
- 界面中英双语：主页右上角提示「按 ZR+ZL 切换中/英文」，选择后写入 SD 并记住；日志保持中文便于排障。
  Bilingual UI (Chinese/English): the main page shows "press ZR+ZL to switch language"; the choice is saved to the SD card and remembered. Logs stay in Chinese for troubleshooting.
- 音频可用：采样音效走 WebAudio，MIDI 用自研波表合成器（不依赖 wasm）。
  Working audio: sampled sound effects use WebAudio; MIDI uses a purpose-built wavetable synth (no wasm required).
- 内存自保：启动时检测内存档位，紧档自动跳过自定义 PNG 遮罩；GC 有紧急线/棘轮/余量线三道闸。
  Memory safeguards: the memory tier is detected at boot, PNG masks are skipped in the tight tier, and the GC has three trigger lines (emergency / ratchet / reserve).
- 游戏内按 `+` 可回游戏列表（软重启会话），不必退出程序。
  Press `+` in-game to return to the game list (soft session restart) without quitting the app.
- 桌面端可回归：同一套代码在 Node 里跑仿真测试（600+ 断言），改代码不必每次都上真机。
  Desktop-testable: the same code runs under Node in a simulation harness (600+ assertions), so changes don't need a real console for every iteration.

---

## 3. 边界与限制 / Boundaries and limitations

- 进游戏/换场景时会卡几秒：Switch 上关掉了 VM 的 baseline JIT（解释执行），资源重的游戏启动要几秒到几十秒。
  A few seconds of stall when entering a game or a new scene: the VM's baseline JIT is disabled on the Switch (interpreted execution), so resource-heavy games take seconds to tens of seconds to start.
- 帧率随游戏而异：2D 游戏常见 15~60fps，重绘密集的场景会掉帧。
  Frame rate depends on the game: typically 15–60 fps for 2D games, with drops in draw-heavy scenes.
- 内存档位不稳定：开机有时拿到「正常档」（约 821MB），有时是「偏紧档」（约 425MB）；紧档会跳过 PNG 遮罩、更容易出现内存失败。
  Boot memory tier is not stable: sometimes the normal tier (~821 MB), sometimes the tight tier (~425 MB); the tight tier skips PNG masks and hits memory failures sooner.
- 连续换游戏 2~4 次后可能静默退出（旧会话的代码空间与原生内存棘轮）；根治方案（软重启不重求值 bundle）尚未实现。
  Switching games 2–4 times in a row can end in a silent exit (code space and native memory ratchet from old sessions); the root fix (soft restart without re-evaluating the bundle) is not implemented yet.
- 只保证在 Atmosphère 自制固件的 homebrew（nro）环境下运行，其它加载器/模拟器未验证。
  Only the homebrew (nro) environment on Atmosphère CFW is supported; other loaders/emulators are untested.
- 目前进游戏前请**手动指定分辨率**（默认自动探测对「万能壳」类游戏可能偏小，会裁掉边缘）。
  For now, set the resolution manually before launching: auto-detection can pick a too-small size for "universal shell" games and crop the edges.
- 从源码构建只需 npm 依赖与 JDK 8：第三方资产里的中文字体（Noto Sans SC，SIL OFL 1.1）已随仓库提供，可直接再分发。
  Building from source needs only npm dependencies and JDK 8: the CJK font (Noto Sans SC, SIL OFL 1.1) ships with the repo and may be redistributed.
- 中文支持的是**文本**：游戏里预渲染成图片的文字无法替换或翻译。
  Chinese support applies to text: words baked into images cannot be replaced or translated.
- MIDI 音色是简化合成，与真机或 ADLMIDI 有差距；个别格式/机型可能无声。
  MIDI timbre is a simplified synth and differs from real hardware or ADLMIDI; some formats/devices may be silent.
- 存档只保证本模拟器自身的格式，不能读取真机手机上的存档。
  Save data uses this emulator's own format only — saves from real phones cannot be imported.
- 界面双语覆盖的是**屏显文字**；日志、以及 SD 卡上的 `说明.txt` / `keys.txt` 注释仍是中文。
  The bilingual UI covers on-screen text only; logs and the SD-card `说明.txt` / `keys.txt` comments remain Chinese.

---

## 4. 不支持 / Not supported

- 网络游戏：Socket / HTTP 通道目前是「立即失败」的桩实现。
  Network games: the Socket/HTTP pipes are stubs that fail immediately.
- 3D 游戏：M3G（JSR-184）与 Mascot Capsule 未实现，3D 游戏会黑屏或报错。
  3D games: M3G (JSR-184) and Mascot Capsule are not implemented — 3D games blank out or error.
- 外设类 API：摄像头、录音、蓝牙/OBEX（JSR-82）、定位（JSR-179）、PIM/联系人、加速度计等。
  Peripheral APIs: camera, audio recording, Bluetooth/OBEX (JSR-82), location (JSR-179), PIM/contacts, accelerometer, and similar.
- 视频播放（MMAPI video）与部分音频格式（AMR 取决于固件；ADLMIDI wasm 默认关闭）。
  Video playback (MMAPI video) and some audio formats (AMR depends on firmware; ADLMIDI wasm is off by default).
- OTA/JAD 在线安装、多 MIDlet 套件、DRM 与强制签名校验。
  OTA/JAD installation, multi-MIDlet suites, DRM, and mandatory signature verification.
- 触摸操作：Switch 没有触摸屏，只支持按键。
  Touch input: the Switch has no touchscreen — controller only.
- 厂商私有 API 只做了常用子集（三星 `AudioClip`/`Vibration`、诺基亚 `DirectGraphics`/`FullCanvas`/`Sound` 等）。
  Vendor-specific APIs are only partially covered (Samsung `AudioClip`/`Vibration`, Nokia `DirectGraphics`/`FullCanvas`/`Sound`, etc.).

---

## 5. 支持但还没做 / Supported but not implemented yet

- 系统语言自动跟随（当前默认中文，需要手动切一次）。
  Auto-detect the system language (currently defaults to Chinese and must be switched manually).
- 英文全覆盖（日志、SD 卡上的文本文件仍是中文）。
  Full English coverage (logs and SD-card text files are still Chinese).
- 即时存档/读档（save state）、快进、金手指。
  Save states, fast-forward, and cheats.
- 每游戏独立的音量/音频开关界面（当前跟随游戏自己的设置）。
  Per-game volume/audio toggles in the UI (currently follows the game's own settings).
- 遮罩与按键档案的导入/导出（一键备份到 SD）。
  Import/export of mask and key profiles (one-click backup to the SD card).
- 3D 的「不崩但没画面」桩实现（让 3D 游戏至少能进菜单）。
  Stub 3D so games don't crash but render nothing (at least reaching the game's menu).
- 更多机型档位（西门子、索尼爱立信的软键码）。
  More device profiles (Siemens, Sony Ericsson soft-key codes).
- 震动、截图/录像（运行时有能力，尚未接）。
  Vibration, screenshots, video capture (possible with the runtime, not wired up).
- 更完整的第三方运行时（内置 JIT 代码空间修复）随包分发，让用户不必自己构建。
  Shipping a fully pre-patched runtime so users don't have to build one themselves.

---

## 6. 操作说明 / Controls

| 菜单（游戏列表）/ Menu (game list) | | 游戏内 / In-game | |
|---|---|---|---|
| `A` | 启动选中的游戏 / Launch selected game | `A` | 确认（FIRE）/ OK (FIRE) |
| `X` | 分辨率设置 / Resolution | `B` | 数字 5 / Key 5 |
| `Y` | 游戏菜单（改名/遮罩/按键/删除）/ Game menu | `X` | 数字 1 / Key 1 |
| `L` / `R` | 翻页（循环）/ Page (cyclic) | `Y` | 数字 3 / Key 3 |
| `十字上下` | 选择 / Move selection | `L` / `R` | `*` / `#` |
| `ZR`+`ZL` | 切换中/英文界面 / Switch UI language | `ZL` / `ZR` | 左/右软键 / Left/Right soft key |
| | | `L3` / `R3` | 数字 7 / 数字 9 |
| | | `-` / `+` | 数字 0 / 退出并回列表（Quit to list） |

按键可在菜单 → `Y` → **按键映射**里改，写进 `sdmc:/switch/j2me-nx/keys.txt`（可直接手改）。
Remap buttons via `Y` → **Key mapping**; stored in `sdmc:/switch/j2me-nx/keys.txt` (hand-editable).

---

## 7. SD 卡目录 / SD card layout

```
sdmc:/switch/J2me-nx.nro                  程序本体 / the emulator itself
sdmc:/switch/java/*.jar                   游戏放这里 / put your games here
sdmc:/switch/j2me-nx/keys.txt             按键映射 / key mapping
sdmc:/switch/j2me-nx/keyprofiles.json     每游戏的按键机型 / per-game key profile
sdmc:/switch/j2me-nx/names.txt            游戏显示名（改名用）/ display names (rename)
sdmc:/switch/j2me-nx/mask.json            遮罩选择 / mask selection
sdmc:/switch/j2me-nx/masks/               自定义遮罩 + 说明.txt / custom masks + readme
sdmc:/switch/j2me-nx/lang.json            界面语言 / UI language
sdmc:/switch/j2me-nx/save/<游戏名>/idb-fs.json   存档 / save data
sdmc:/switch/j2me-nx/error.log            运行日志（排障用）/ runtime log (for troubleshooting)
```

---

## 8. 仓库结构 / Repository layout

| 路径 / Path | 内容 / Contents |
|---|---|
| `app/main.js` | 宿主入口：菜单、呈现层、输入、资源、日志 / host entry: menu, presenter, input, resources, logging |
| `src/host/*.js` | 宿主层脚本（输入、音频、遮罩扫描、PNG 解码、中英界面）/ host-layer scripts |
| `vendor/pluotsorbet/**` | J2ME 虚拟机（含本移植的补丁）/ the J2ME VM (with this port's patches) |
| `java/**` | phoneME 类库源码 + 本移植新增类（GBK、Nokia/三星兼容层）/ CLDC/MIDP sources + port-specific classes |
| `config/switch.js` | 虚拟机在 Switch 上的配置（JIT 开关、屏幕、旋转）/ VM config for the Switch |
| `data/nxjs.ini` | 运行时配置（堆上限、V8 flags、GPU 缓存）/ runtime config |
| `tools/**` | 构建与测试脚本 / build and test scripts |
| `tests/**` | 静态守卫测试（字典覆盖、面板宽度、产物自检等）/ static guard tests |
| `release/**` | 发布文档模板（本文件由它生成）/ release doc templates |

---

## 9. 编译与测试 / Building and testing

见 `BUILD.md`（中文与英文两段完整说明）。
See `BUILD.md` (complete instructions in Chinese and English).

日常回归：`npm test` —— 在 Node 里跑全套仿真与断言（不需要真机）。
Daily regression: `npm test` — runs the whole simulation suite and assertions under Node (no console needed).

---

## 10. 已知问题 / Known issues

- 入口/加载卡顿数秒（解释执行所致），换场景同样。
  Multi-second stalls at entry/loading (interpreted execution), same when loading new scenes.
- 内存档位随机：紧档时自定义 PNG 遮罩被跳过；想拿到正常档可退出重开，直到日志出现 `★档位=正常`。
  Random memory tier: in the tight tier custom PNG masks are skipped; relaunch until the log shows the normal tier.
- 连续换游戏可能静默退出：建议换 2 次后重开一次程序。
  Repeated game switching may exit silently: restart the app after ~2 switches.
- 少数游戏进图/进战斗时可能长时间无响应（资源过大或 API 缺失）。
  A few games hang for a long time when loading a map/battle (oversized resources or missing APIs).
- 若界面语言切换后提示「写盘失败」，说明 SD 卡写入有问题，日志里会写明原因。
  If switching the UI language reports a save failure, SD writes are failing; the log states the reason.

反馈问题时请附上 `sdmc:/switch/j2me-nx/error.log`（以及 `sdmc:/switch/nxjs-debug.log`，若存在）。
When reporting issues, please attach `sdmc:/switch/j2me-nx/error.log` (and `sdmc:/switch/nxjs-debug.log` if present).

---

## 11. 鸣谢与许可 / Credits and license

- 虚拟机：[PluotSorbet](https://github.com/mozilla/pluotsorbet)（Mozilla）；类库源自 phoneME（Sun/Oracle）。
  VM: [PluotSorbet](https://github.com/mozilla/pluotsorbet) (Mozilla); class libraries derived from phoneME (Sun/Oracle).
- 运行时：[nx.js](https://github.com/TooTallNate/nx.js)（TooTallNate）及其 JIT 内存补丁。
  Runtime: [nx.js](https://github.com/TooTallNate/nx.js) (TooTallNate) plus the JIT memory patch.
- 本移植的补丁与宿主层：作者 Narcissufundis。
  Port patches and host layer: Narcissufundis.
- 第三方组件、许可证与**未随包分发**的资产清单见 `NOTICE.md`。
  Third-party components, licenses, and assets **not** bundled here: see `NOTICE.md`.
- 本项目按 **GPL-2.0-or-later** 发布（见 `LICENSE.md`）。
  This project is released under **GPL-2.0-or-later** (see `LICENSE.md`).

> 本程序不包含任何游戏本体。请自行准备你有权使用的游戏 jar。
> This project bundles no games. Supply game jars that you are legally entitled to use.
