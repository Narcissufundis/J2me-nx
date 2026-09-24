# 三星 SDK 兼容层测试包（samsungtest.jar）

这个目录是**验证"三星游戏能打开"**这条链路的测试 MIDlet：`com.samsung.util.AudioClip` /
`Vibration` 在类库里到底有没有、签名对不对、跑起来会不会抛异常。

## 为什么要有它

2026-09-23 用户报「`Forgotten Warrior.jar` 打不开」，实机日志死因是：

```
listener error: ClassNotFoundException: com/samsung/util/AudioClip.class
```

游戏 `GameScreen` 在 `startApp` 里就 `new AudioClip(3, "/7.mid")`，类库里没有
`com.samsung.util.*` → MIDlet 在**类加载阶段**就死了，画面都没出来。
`SamsungTest.java` 复刻的就是这条调用序列（另外多测了缺资源 / 相对资源名 / `byte[]` 重载）。

## 跑法

```powershell
node tools/samsung-test/build.mjs      # 生成 test.mid + javac + 打包（幂等）
node tools/test-samsung-api.mjs        # 端到端：VM 里真跑一遍
node tests/samsung-api.test.mjs        # 类契约（不跑 VM，查 class 字节）
```

期望（修好后）：

```
[samtest] Vibration.isSupported=true TYPE_MIDI=3
[samsung] Vibration.start(500,3)：Switch 无振动马达，已静默忽略
[samtest] PASS Vibration start/stop 无异常
[samsung] AudioClip 载入 /test.mid（audio/midi）
[samtest] PASS AudioClip 构造完成
[samtest] PASS play(1,3) 无异常，vol=30
...
结果: 全部通过 ✔
```

实机验收：把 `samsungtest.jar` 拷到 `sdmc:/switch/java/` → 列表里选 **SamsungTest** →
应当直接进画面（不再零帧），日志里出现上面几行。

## 实现要点（出问题时查这里）

| 环节 | 位置 | 说明 |
|---|---|---|
| 资源解析 | `AudioClip.fixName()` | 三星按 **jar 根**解析资源名。`Class.getResourceAsStream` 的相对格式会按**包名**拼路径（这里是 `com/samsung/util/`），直接用会找不到 → 统一补前导 `/` |
| 播放 | `AudioClip.play(II)` | `Manager.createPlayer(is, "audio/midi")` → 本移植层的 MIDI 走纯 JS 合成器（`vendor/pluotsorbet/midp/midi-synth.js`），不经 FFmpeg |
| 音量 | `normalizeVolume()` | 三星老 SDK 的 volume 有 0~10 与 0~100 两种写法；本游戏传 `play(1, 3)`，按 ≤10 视为 0~10 刻度 ×10（→30%），>10 当百分比 |
| 异常 | 全部 `catch (Throwable)` | 游戏调用点照三星 SDK 写的、**没有 try/catch**（`call_vib` 是裸调用）→ 任何失败都必须内部吞掉，静默降级 |
| 单通道 | 静态 `active` | 真机是单音频通道：新 clip 播放前先停上一个，避免多 Player 同时出声 |

`test.mid` 由 `build.mjs` **自造**（45B，SMF Type 0，两只音符），仓库里不放游戏素材。
javac 必须带 `-encoding UTF-8`（中文 Windows 上默认 GBK 会把中文字面量编译坏）。
