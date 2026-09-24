# 运行时说明：nx.js 的 JIT 补丁 / Runtime notes: the nx.js JIT patch

本页说明本项目为什么需要一个"打过补丁"的 nx.js 运行时、补丁改了什么、怎么自行构建与校验。
This page explains why this project needs a *patched* nx.js runtime, what exactly the patch changes,
and how to build and verify it yourself.

---

## 1. 三种组合 / Three combinations

| 运行时 / Runtime | `nxjs.ini` 的 `[v8] jit` | 结果 / Result |
|---|---|---|
| 官方 nx.js `1.0.0-beta.6` / stock nx.js | `off` | 可用（纯解释器，较慢）/ works, interpreter only, slower |
| 官方 nx.js `1.0.0-beta.6` / stock nx.js | `on` | 启动即崩：Atmosphère `Data Abort` / aborts at boot with `Data Abort` |
| 打过 W^X 补丁的 nx.js / W^X-patched nx.js | `on` | 可用且快（本项目发行版采用）/ works and is fast (what this project ships) |

本项目的发行二进制**自带**打过补丁的运行时：单文件 NRO（`--fat`）把它嵌在里面；
slim 路线（NSP 前端）从 SD 卡读取同一份 `sdmc:/nx.js/nxjs-v1.0.0-beta.6.nro`。
This project's released binaries **include** the patched runtime: the single-file NRO (`--fat`) embeds
it; the slim route (NSP forwarder) loads the same `sdmc:/nx.js/nxjs-v1.0.0-beta.6.nro` from the SD card.

---

## 2. 崩溃现象与根因 / Symptom and root cause

`jit = on` 时，运行时在启动阶段（V8 初始化 + 首次代码页分配）崩溃，Atmosphère 崩溃报告给出：
With `jit = on` the runtime aborts during startup (V8 init / first code-page allocation); the
Atmosphère crash report shows:

```
Exception: Data Abort
Address: nxjs + 0x5c8430      ; stp x1, x2, [x0]
                              ; first instruction of v8::internal::MemoryChunk::MemoryChunk(Flags, BasePage*)
                              ; reached from the code-page allocation path (MemoryAllocator::AllocateLargePage)
                              ; X1 = 0x84
```

根因：Horizon 把 libnx 的 JIT 内存以**只读 rx 别名**暴露出来；`switch-v8 15.0.243-9` 只带了三个
Horizon 全 JIT W^X 修复中的两个（`MutablePage::SetOldGenerationPageFlags`、
`Sweeper::ZeroOrDiscardUnusedMemory`），**第三个写入点**——`MemoryChunk` 构造函数里把 chunk header
写进页首的那条 `stp`——没有补。于是 V8 在代码空间里分配大对象时，这条 store 直接 Data Abort。
Root cause: Horizon exposes libnx's JIT memory through a **read-only rx alias**. `switch-v8 15.0.243-9`
carries two of the three Horizon full-JIT W^X fixes (`MutablePage::SetOldGenerationPageFlags`,
`Sweeper::ZeroOrDiscardUnusedMemory`) but **not the third** — the `stp` in the `MemoryChunk`
constructor that writes the chunk header into the page. Under full JIT, any large allocation in the
code space dies on that store.

该路径只在 JIT 分配代码页时走到，所以 `jit = off` 不受影响（代价是所有 JS 都走解释器）。
That path is only taken when JIT allocates a code page, which is why `jit = off` is unaffected
(the cost being that all JS runs in the interpreter).

---

## 3. 补丁做了什么 / What the patch does

1. **改一条指令**：把 `MemoryChunk::MemoryChunk(Flags, BasePage*)` 的**首条指令（4 字节）**改成一条
   相对分支，跳到补丁 shim。
   **Rewrite one instruction**: the **first instruction (4 bytes)** of
   `MemoryChunk::MemoryChunk(Flags, BasePage*)` becomes a relative branch to the shim.
2. **shim 通过可写别名写回**：shim 向移植层导出的 `horizon_jit_rw_delta()` 询问该页的**读写别名偏移**，
   再通过它写 chunk header；对非 JIT（数据）页该函数返回 0，写入位置与官方指令完全一致。
   **The shim writes through the writable alias**: it asks the port's exported
   `horizon_jit_rw_delta()` for the page's rw-alias delta and stores the chunk header through it. For
   non-JIT (data) pages that function returns 0, so the store lands exactly where the stock instruction
   put it.
3. **链接要求**：shim 必须能在 `--gc-sections` 下存活，链接时加 `-Wl,-u,<shim 符号>`。
   **Link requirement**: the shim must survive `--gc-sections`; link with `-Wl,-u,<shim symbol>`.

shim 的核心（等价写法 / equivalent of the shim):

```cpp
extern "C" void *horizon_jit_rw_delta(void *addr);   // exported by the nx.js Switch port

#define MV_CHUNK_PAGE_MASK (~(unsigned long)0x3FFFF)  // 256 KiB granularity

extern "C" __attribute__((noinline, used)) void mv_chunk_ctor_fix(
	void *chunk, unsigned long flags, void *page) {
	unsigned long chunkAddr = (unsigned long)chunk;
	unsigned long pageBase  = chunkAddr & MV_CHUNK_PAGE_MASK;
	unsigned long delta     = (unsigned long)horizon_jit_rw_delta((void *)pageBase);
	unsigned long *dst      = (unsigned long *)(chunkAddr + delta);
	dst[0] = flags;                    // == stp x1, x2, [x0]
	dst[1] = (unsigned long)page;
}
```

**安全性 / Safety**

- 打补丁前逐字节校验原指令必须是 `01 08 00 a9  c0 03 5f d6`（`stp x1,x2,[x0]` + `ret`）；
  不匹配就拒绝打补丁（不同版本/不同布局的二进制不会被打坏）。
  Before patching, the original bytes must be exactly `01 08 00 a9  c0 03 5f d6`
  (`stp x1,x2,[x0]` + `ret`); otherwise the tool refuses to patch.
- 只改这 4 个字节；分支是相对的，与加载基址无关。
  Only those 4 bytes change; the branch is PC-relative, so it stays valid at any load base.
- 可逆：把原 4 字节写回即恢复官方行为。
  Reversible: restoring the original 4 bytes restores stock behaviour.

**本项目这份运行时另有一处改动 / One more change in the runtime this project ships**

`[memory] heap_limit` 的硬上限由 512 MiB 放宽到 800 MiB（改的是 `source/main.cc` 里的常量，
并按实机实测下调了 reserve）。可用运行时自身的字符串确认：
The hard cap for `[memory] heap_limit` is raised from 512 MiB to 800 MiB (a constant in
`source/main.cc`), with the reserve lowered based on on-device measurements. It is verifiable from the
binary itself:

```
[config] memory.heap_limit not honored: above 800 MiB cap, clamped to 800 MiB
```

---

## 4. 本项目分发的运行时 / The runtime this project distributes

| 项目 / Item | 值 / Value |
|---|---|
| 文件名 / File name | `nxjs-v1.0.0-beta.6.nro` |
| 大小 / Size | 55,260,697 B |
| sha256 | `B9862CB81EB2BF071976DDDB0308E1C8F295A5793FAC0F3349346C73B944AF0A` |
| 基线 / Base | nx.js `1.0.0-beta.6`，`switch-v8 15.0.243-9` |

构建链打包时读的就是这一份（与构建工具链目录下 `@nx.js/nro/dist/nxjs.nro` **同哈希**），
所以 `--fat` 产出的 NRO 与 slim 路线用的共享运行时是同一次构建。
The build pipeline packages exactly this file (byte-identical to `@nx.js/nro/dist/nxjs.nro` in the
toolchain directory), so a `--fat` NRO and the slim route's shared runtime come from the same build.

许可 / Licence：nx.js 为 MIT（Copyright (c) 2023 Nathan Rajlich）。本补丁只改写 4 个字节并调整一处常量，
发行二进制随附，第三方组件清单见 `NOTICE.md`。
nx.js is MIT-licensed (Copyright (c) 2023 Nathan Rajlich). This patch rewrites 4 bytes and adjusts one
constant; the resulting binary ships with the release, and the third-party inventory is in `NOTICE.md`.

---

## 5. 自行构建与校验 / Building and verifying it yourself

需要 devkitPro（devkitA64）与 nx.js `1.0.0-beta.6` 源码；补丁校验基线依赖 `switch-v8 15.0.243-9`
（不同 portlib 版本会改变布局，校验会按设计拒绝打补丁）。
Requires devkitPro (devkitA64) and the nx.js `1.0.0-beta.6` sources. The byte-pattern check assumes
`switch-v8 15.0.243-9`; a different portlib version changes the layout, and the check then refuses by
design.

1. 把 shim 加进 `source/`（上面的等价写法），并在 `Makefile` 的链接参数里加 `-Wl,-u,mv_chunk_ctor_fix`。
   需要 800 MiB 上限时，同时改 `source/main.cc` 里的上限常量。
   Add the shim to `source/` and `-Wl,-u,mv_chunk_ctor_fix` to the link flags. Adjust the cap constant
   in `source/main.cc` if you want the 800 MiB ceiling.
2. `make -j` 链接出 `nxjs.elf`。
3. 校验补丁点与打补丁：`--check` 期望输出 `patchable`；`--apply` 期望输出 `verify OK`；
   对已经打过补丁的 ELF 再跑 `--check` 会输出 `ALREADY PATCHED`。
   Check then patch: `--check` prints `patchable`, `--apply` prints `verify OK`, and re-running
   `--check` on a patched ELF prints `ALREADY PATCHED`.
4. 按 nx.js 的常规流程产出运行时 NRO（bundle 运行时 → 嵌入 → `make`），得到 `nxjs.nro`。
   Produce the runtime NRO the usual nx.js way (bundle the runtime, embed it, `make`).
5. 实机校验：启动日志出现 `[v8] … mode=jit (Ignition+Sparkplug+Maglev+TurboFan)`，且不再出现
   `Data Abort`。
   On-device check: the startup log shows `[v8] … mode=jit (Ignition+Sparkplug+Maglev+TurboFan)` and no
   `Data Abort` follows.

补丁工具（`patch_chunk_fix.py` 与 shim）出自开发时使用的 mv2switch 工具链，不随本仓库分发；
本节给出的是等价流程与校验方法，shim 的完整逻辑已在上文给出。
The patch tooling (`patch_chunk_fix.py` and the shim) comes from the mv2switch toolchain used during
development and is not distributed with this repository; the equivalent procedure and the shim's full
logic are given above.

---

## 6. 不想自行构建时的两条路线 / Two alternatives without building a runtime

- **用官方运行时 + 解释器**：构建本项目时设 `J2ME_STOCK_RUNTIME=1`，打包会把 romfs 里的
  `nxjs.ini` 写成 `jit = off`，官方运行时即可直接使用（慢，但不需要任何补丁）。
  **Stock runtime + interpreter**: build this project with `J2ME_STOCK_RUNTIME=1`; packaging then
  writes `jit = off` into the romfs `nxjs.ini`, so the stock runtime is used as-is (slower, no patch
  required).
- **自行改配置**：在 `data/nxjs.ini` 里把 `[v8] jit` 设为 `off`，然后按常规流程构建。
  **Edit the config**: set `[v8] jit = off` in `data/nxjs.ini` and build normally.

两种路线都会用官方运行时那份二进制，因此需要它出现在打包路径上；构建说明见 `BUILD.md`。
Both routes use the stock runtime binary, so it has to be present on the packaging path; see `BUILD.md`
for the build steps.
