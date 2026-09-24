# 编译说明 / Build Instructions

产物：`dist/J2me-nx.nro`（Nintendo Switch homebrew，Atmosphère CFW 下运行）
Artifact: `dist/J2me-nx.nro` (Nintendo Switch homebrew, runs under Atmosphère CFW)

---

## 一、中文说明

### 0. 你需要准备的

| 项目 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows / Linux / macOS | 脚本是 Node 写的，与平台无关；本文命令在 Windows 下写成 `node xxx`，Linux/macOS 相同 |
| Node.js | **18 或更高** | 构建与打包都用它 |
| JDK | **必须 JDK 8**（javac + jar） | 用来编译 `java/` 下的类库与测试夹具；更高版本 JDK 会因为 `-source 1.3` 报错 |
| CJK 字体 | **必需**，自己放 | 放到 `data/fonts/cjk.ttf`（中文游戏要它才能显示汉字）。见 `data/fonts/README.md` |
| nx.js 运行时 | `tools/node_modules` 里，`npm install` 自带 | **注意**：官方运行时需要把 `data/nxjs.ini` 里的 `[v8] jit` 改成 `off`，否则启动即崩（见下） |
| 遮罩素材 | 可选 | 仓库已带默认遮罩 `data/mask.raw`；自定义遮罩放 SD 卡即可，不必进包 |

### 1. 安装依赖

```bash
cd tools
npm install
cd ..
```

依赖清单在 `tools/package.json`（`@nx.js/nro`、`@nx.js/nsp`、`esbuild`、`typescript`），
安装到 `tools/node_modules/`（构建脚本按这个路径找）。

### 2. 编译类库（生成 classes.jar）

```bash
node tools/build-classes.mjs
```

- 需要 JDK 8；如果 `javac` 不在默认位置，用环境变量指定：
  - Windows：`set JDK_BIN=D:\jdk1.8.0_281\bin`
  - Linux/macOS：`JDK_BIN=/usr/lib/jvm/java-8-openjdk/bin node tools/build-classes.mjs`
- 产物：`java/classes.jar` 与 `data/java/classes.jar`（脚本会做字节码终验，补丁没进包会直接报错退出）。

### 3. 构建测试夹具（可选，跑测试要用）

```bash
node tools/fixture/build.mjs       # 菜单/软重启/界面语言测试用的自制 MIDlet
node tools/skip-test/build.mjs     # 流读取测试用的 MIDlet（自带 512KiB 模式流）
node tools/encoding-test/build.mjs # GBK 编码测试
node tools/samsung-api/build.mjs   # 三星兼容层测试
```

### 4. 编译虚拟机与宿主层（生成 bld/）

```bash
node tools/build.mjs
```

把 `vendor/pluotsorbet/**`（TypeScript/JS）与宿主脚本编译成 `bld/native.js`、`bld/j2me.js`、
`bld/main-all.js`、`bld/config-build.js`。**改了 vendor 下的任何文件都必须重跑这一步**，
否则补丁不会进包（`tests/packaged-artifacts.test.mjs` 会抓这个）。

### 5. 组装 romfs

```bash
node tools/package.mjs
```

把宿主脚本、类库、字体、遮罩、`data/nxjs.ini` 与 esbuild 打包后的 `app/main.js` 组装到 `romfs/`。
缺资产（例如字体）时这一步会明确报错并告诉你缺哪个文件。

### 6. 打包成 nro

```bash
npm run nro
```

产出 `dist/J2me-nx.nro`，并打印大小与 sha256（发版说明直接用这个哈希）。
`npm run nsp` 打 NSP；`npm run release` 等价于 `npm run nro`。

### 7. 回归测试

```bash
npm test
```

在 Node 里跑全套仿真测试与静态守卫（600+ 断言）：虚拟机/宿主层单测、菜单与软重启端到端、
编码（GBK）、三星兼容层、按键机型、面板宽度、界面语言、产物自检等。**不需要真机**。

### 8. 装到 Switch

1. 把 `dist/J2me-nx.nro` 复制到 SD 卡 `sdmc:/switch/`；
2. 游戏 `.jar` 放到 `sdmc:/switch/java/`；
3. 从 homebrew 菜单启动 **J2me-nx**；
4. 首次运行会在 `sdmc:/switch/j2me-nx/` 下自动生成配置与日志。

### 9. 关键注意（最容易踩的三个坑）

1. **运行时 JIT**：本移植默认 `data/nxjs.ini` 里 `[v8] jit = on`，这要求运行时**带 JIT 内存写权限补丁**
   （原版 nx.js 运行时会因为 W^X 限制在分配代码页时 Data Abort 崩溃）。
   如果你 `npm install` 拿到的是官方运行时，请把 `data/nxjs.ini` 改成：
   ```ini
   [v8]
   jit = off
   ```
   改完重新 `node tools/package.mjs && npm run nro`。代价是整体更慢，但能跑。
2. **忘了重跑 tools/build.mjs**：改了 `vendor/` 下的代码只跑 `npm run nro`，补丁不会进包。
3. **字体**：没用 `data/fonts/cjk.ttf` 时中文会显示成方块（构建阶段就会提示缺文件）。

---

## 二、English instructions

### 0. Prerequisites

| Item | Requirement | Notes |
|---|---|---|
| OS | Windows / Linux / macOS | All scripts are plain Node.js |
| Node.js | **18 or newer** | Used for building and packaging |
| JDK | **JDK 8 required** (javac + jar) | Compiles `java/` (class library and test fixtures); newer JDKs reject `-source 1.3` |
| CJK font | **Required**, you supply it | Put it at `data/fonts/cjk.ttf` (needed to render Chinese text). See `data/fonts/README.md` |
| nx.js runtime | Comes from `npm install` | **Note**: with the stock runtime you must set `[v8] jit = off` in `data/nxjs.ini`, otherwise it crashes at boot (see below) |
| Mask assets | Optional | A default mask ships in `data/mask.raw`; custom masks live on the SD card |

### 1. Install dependencies

```bash
cd tools
npm install
cd ..
```

Dependencies are declared in `tools/package.json` (`@nx.js/nro`, `@nx.js/nsp`, `esbuild`,
`typescript`) and are installed into `tools/node_modules/` — the build scripts look there.

### 2. Build the class library (classes.jar)

```bash
node tools/build-classes.mjs
```

- Requires JDK 8. Point the script at it with `JDK_BIN` when it is not in the default location:
  - Windows: `set JDK_BIN=D:\jdk1.8.0_281\bin`
  - Linux/macOS: `JDK_BIN=/usr/lib/jvm/java-8-openjdk/bin node tools/build-classes.mjs`
- Output: `java/classes.jar` and `data/java/classes.jar`. The script verifies the bytecode
  afterwards and exits with an error if a patch did not make it into the jar.

### 3. Build test fixtures (optional — needed to run the test suite)

```bash
node tools/fixture/build.mjs       # self-made MIDlet fixture (menu/restart/UI-language tests)
node tools/skip-test/build.mjs     # stream/MIDlet test (generates the 512 KiB pattern stream)
node tools/encoding-test/build.mjs # GBK encoding test
node tools/samsung-api/build.mjs   # Samsung compatibility test
```

### 4. Compile the VM and host layer (bld/)

```bash
node tools/build.mjs
```

Compiles `vendor/pluotsorbet/**` (TypeScript/JS) plus the host scripts into `bld/native.js`,
`bld/j2me.js`, `bld/main-all.js` and `bld/config-build.js`.
**Any change under `vendor/` requires re-running this step**, otherwise your patch will not
be in the artifact (`tests/packaged-artifacts.test.mjs` catches that).

### 5. Assemble the romfs

```bash
node tools/package.mjs
```

Collects the host scripts, class library, font, masks, `data/nxjs.ini` and the esbuild-bundled
`app/main.js` into `romfs/`. Missing assets (e.g. the font) make this step fail with the exact
file name it needs.

### 6. Package the NRO

```bash
npm run nro
```

Produces `dist/J2me-nx.nro` and prints its size and sha256 (use that hash in release notes).
`npm run nsp` builds an NSP; `npm run release` is an alias for `npm run nro`.

### 7. Run the regression suite

```bash
npm test
```

Runs the full Node-based simulation suite and static guards (600+ assertions): VM/host unit
tests, menu and soft-restart end-to-end, encoding (GBK), Samsung compatibility, key profiles,
panel layout, UI language, and packaged-artifact self-checks. **No console required.**

### 8. Install on the Switch

1. Copy `dist/J2me-nx.nro` to `sdmc:/switch/`;
2. Put game `.jar` files into `sdmc:/switch/java/`;
3. Launch **J2me-nx** from the homebrew menu;
4. On first run, configuration files and logs are created under `sdmc:/switch/j2me-nx/`.

### 9. The three most common pitfalls

1. **Runtime JIT**: this port ships `[v8] jit = on` in `data/nxjs.ini`, which requires a runtime
   carrying the JIT memory-write patch (the stock nx.js runtime aborts with a Data Abort while
   allocating code pages because Horizon exposes JIT memory as read-only).
   With the stock runtime, change `data/nxjs.ini` to:
   ```ini
   [v8]
   jit = off
   ```
   then re-run `node tools/package.mjs && npm run nro`. Slower overall, but it works.
2. **Forgetting `tools/build.mjs`**: editing anything under `vendor/` and only running
   `npm run nro` leaves your patch out of the artifact.
3. **Font**: without `data/fonts/cjk.ttf`, Chinese text renders as boxes — and the packaging
   step fails early with a clear message.

---

## 三、产物与校验 / Artifact and verification

```bash
node tools/verify-nro.mjs dist/J2me-nx.nro --out verify.txt
```

会打印：大小 / sha256 / 构建标记 / 关键功能标记是否都在包里（缺哪条一眼就能看到）。
Prints size, sha256, the build marker, and whether each key feature marker is present in the
package — a missing one is immediately visible.
