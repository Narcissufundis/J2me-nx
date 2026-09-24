# 前端 NSP（主页启动器）/ Forwarder NSP (home-menu launcher)

> 产物 / Artifact: `dist/forwarder/J2me-nx-forwarder.nsp`
> 大小 / Size: **329,944 B (322 KB)** ｜ Title ID: **`01edecb97ac45000`**
> 生成工具 / Generator: [NTON](https://github.com/rlaphoenix/NTON) 3.0.0

---

## 1. 它是什么 / What it is

一个只有 322KB 的"启动器"标题：装到系统里之后，主页上会多一个 J2me-nx 图标，
点它就等于**以 application 模式启动 SD 卡上的 `sdmc:/switch/J2me-nx.nro`**。
它**不含**模拟器本体：更新模拟器只需覆盖那个 NRO，**不必重装这个 NSP**。

A 322 KB "launcher" title: after installing it, J2me-nx gets an icon on the home menu, and tapping it
**launches `sdmc:/switch/J2me-nx.nro` from the SD card in application mode**. It does **not** contain
the emulator itself, so updating the emulator means overwriting that NRO only — the NSP stays as is.

**为什么要它 / Why bother**：hbmenu 启动的 NRO 是 applet 模式（内存约 425MB、画布走 CPU 光栅）；
从主页启动是 **application 模式（内存约 3GB、GPU 画布）**，帧率和稳定性都好得多。
An NRO launched from hbmenu runs in applet mode (~425 MB, CPU-raster canvas); launching from the home
menu runs as an **application** (~3 GB, GPU canvas), which is markedly faster and more stable.

---

## 2. 装之前先准备好这两个文件 / Two files must be in place first

```
sdmc:/switch/J2me-nx.nro                  ← 模拟器本体（必须叫这个名字，见下）
sdmc:/nx.js/nxjs-v1.0.0-beta.6.nro        ← 共享运行时（打过 W^X 补丁的那份）
```

1. `sdmc:/switch/J2me-nx.nro` —— 前端里的路径是**硬编码**的，所以**不能改名、不能挪目录**。
   （`J2me-nx-<构建标记>.nro` 那种带版本戳的副本只用于在 hbmenu 里并排测新旧版本，不要把它当作这个。）
2. `sdmc:/nx.js/nxjs-v1.0.0-beta.6.nro` —— 跑起来的其实是我们的 NRO，它会按自己的 `nxjs.ini`
   去 SD 上找这份运行时；用官方未打补丁的运行时启动会直接 `Data Abort` 崩溃。

1. `sdmc:/switch/J2me-nx.nro` — the path is **hardcoded** inside the forwarder, so do **not** rename it
   or move it. (Stamped copies like `J2me-nx-<tag>.nro` are only for A/B testing through hbmenu.)
2. `sdmc:/nx.js/nxjs-v1.0.0-beta.6.nro` — what actually runs is our NRO, and it looks for this runtime
   on the SD card according to its own `nxjs.ini`. The official unpatched runtime aborts (`Data Abort`).

---

## 3. 安装 / Install

1. 用你惯用的标题安装器（DBI / Goldleaf / Awoo / Tinfoil 等）安装 `J2me-nx-forwarder.nsp`；
2. 确认上面那两个文件已经在 SD 卡上；
3. 回到主页，找到 **J2me-nx** 图标，启动。

1. Install `J2me-nx-forwarder.nsp` with your title installer (DBI / Goldleaf / Awoo / Tinfoil …).
2. Make sure the two files above are on the SD card.
3. Go back to the home menu, find the **J2me-nx** icon, launch it.

图标/名字取自生成时的参数：名字 `J2me-nx`、作者 `Narcissufundis`、版本 `1.0.0`。
The icon/name/author/version come from the build arguments: `J2me-nx` / `Narcissufundis` / `1.0.0`.

---

## 4. 怎么确认它真的跑在 application 模式 / Verify you really got application mode

看日志 `sdmc:/switch/j2me-nx/error.log`（或屏幕上的日志输出），应该能看到：
Check `sdmc:/switch/j2me-nx/error.log` (or the on-screen log) for:

- `[heap] bootlim: … 正常档 821MB` —— 拿到了正常档（applet 模式会是"偏紧档 425MB"）；
- `[boot] 形态=NRO-独立` —— 说明本体是按 NRO 跑的（不是 slim NSP 那条共享运行时路线）。

- `[heap] bootlim: … 正常档 821MB` — the normal memory tier (applet mode shows 偏紧档 425MB).
- `[boot] 形态=NRO-独立` — running as a standalone NRO (not through the slim NSP runtime route).

内存档位是**每次开机随机**的：同一天也可能一会儿正常档、一会儿偏紧档。
偏紧档下也能玩，只是会自动跳过自定义 PNG 遮罩、更容易内存不足；想拿正常档就退出重开，
直到日志出现 `正常档`。The memory tier is rolled per boot: relaunch until the log shows 正常档 if you
want the comfortable one (the tight tier still runs, but skips PNG masks and OOMs sooner).

---

## 5. 启动报错怎么办 / If it fails to start

| 现象 / Symptom | 原因 / Cause | 处理 / Fix |
|---|---|---|
| 提示找不到文件 / file not found | NRO 不在 `sdmc:/switch/J2me-nx.nro`（改名或挪走了）/ NRO missing or renamed | 放回原名原位置 / restore the exact name and path |
| 黑屏后回主页、日志停在 Allocation/Data Abort | 缺 `sdmc:/nx.js/nxjs-v1.0.0-beta.6.nro`，或用了官方未打补丁的运行时 / runtime missing or unpatched | 从 `dist/` 拷这份打过补丁的运行时过去 / copy the patched runtime from `dist/` |
| 图标点了没反应 / nothing happens | SD 卡接触或 `nx.js` 目录名拼写（必须是小写 `nx.js`）/ SD contact or directory spelling | 重新插卡、检查目录名 / reseat the card, check the directory name |
| 画面比 hbmenu 里还慢 / slower than hbmenu | 这次是偏紧档 / tight tier this boot | 退出重开，等 `正常档` / relaunch until 正常档 |

卸载：用安装器/系统设置的"数据管理"删掉这个标题即可，不会动 SD 卡上的模拟器和存档。
Uninstall: delete the title via your installer or System Settings → Data Management. Your emulator
files and saves on the SD card are untouched.

---

## 6. 想自己重新生成 / Rebuilding it yourself

```bash
python -m pip install nton
python -m nton build "dist/J2me-nx.nro" \
  --sdmc "/switch/J2me-nx.nro" \
  -n "J2me-nx" -p "Narcissufundis" -v "1.0.0" \
  -i "tools/icon-source.png"
```

产物在 `NTON/` 目录里（文件名带 Title ID）。生成完收进仓库 + 自检：
The output lands in `NTON/` (filename carries the Title ID). Then collect it and self-check:

```bash
npm run forwarder        # 找最新的 NTON 产物 → dist/forwarder/J2me-nx-forwarder.nsp → 自检
                         # finds the newest NTON output, copies it into dist/forwarder/, self-checks
node tools/verify-nsp.mjs dist/forwarder/J2me-nx-forwarder.nsp   # 也可以单独跑 / standalone
```

`tools/verify-nsp.mjs` 认得这种"前端"形态（小 program NCA + 无 romfs），会按前端判定，
而不是拿 romfs 大小误判成 fat；`npm run forwarder` 还会拦住"误把 49MB 的完整 NSP 当前端"的情况。
`tools/verify-nsp.mjs` recognises the forwarder shape (small program NCA, no romfs) instead of
misjudging it as fat via romfs sizes, and `npm run forwarder` also refuses to accept a 49 MB full NSP
as if it were a forwarder.
