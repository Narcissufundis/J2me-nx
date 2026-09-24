# CJK 字体 / CJK font

## 中文

本目录**已经内置**一份可自由再分发的中文字体：

| 文件 | 说明 |
| --- | --- |
| `cjk.ttf` | 内置中文字体：**Noto Sans SC Regular**（10.6MB，31,036 字形）。构建时打进 romfs，注册为字体族 `j2mecjk` |
| `OFL-NotoSansSC.txt` | 该字体的许可证全文（SIL Open Font License 1.1）。构建时一并复制到 romfs 的 `fonts/OFL.txt` |

### 为什么换掉原来的字体

1.0.0 之前的版本内置的是 **SimHei（黑体）**。它的 `OS/2.fsType = 8`（editable embedding），
**不允许再分发**，把 NRO/源码发到 Git 上有版权问题。现在换成 SIL OFL 1.1 的
Noto Sans SC（`fsType = 0`，可自由再分发、修改、商用）。

### 字体是怎么来的（可复现）

```bash
# 1) 取上游可变字体（OFL 1.1，Adobe/Google 联合开发）
curl -L -o NotoSansSC[wght].ttf \
  https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf
curl -L -o OFL.txt \
  https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt

# 2) 实例化成静态 Regular（wght=400），得到 glyf 轮廓的静态 TTF
python -c "from fontTools.ttLib import TTFont; from fontTools.varLib import instancer; \
f=TTFont('NotoSansSC[wght].ttf'); instancer.instantiateVariableFont(f,{'wght':400},inplace=True,updateFontNames=True); \
f.save('cjk.ttf')"
```

- 得到的字体族名仍是 **Noto Sans SC**：OFL 的保留字体名（RFN）是 `Source`，本字体没有使用该名字。
- 版权/许可信息完整保留在字体内部（`name` 表 0/7/8/13/14 项），并随 `OFL-NotoSansSC.txt` 一起分发。
- `fsType = 0`，无嵌入限制。

### 想换成别的字体

把任意**支持简体中文**的 TrueType/OpenType 字体重命名为 `cjk.ttf` 覆盖本文件即可
（构建 `node tools/package.mjs` 时会打进 romfs 并注册为 `j2mecjk`）。

- 需要的字形：简体中文常用字 + 拉丁字母 + 数字 + 常用标点。
- 开源替代：**Noto Sans CJK SC**、**Source Han Sans SC**、**文泉驿微米黑 (WenQuanYi Micro Hei)** 等。
- ⚠️ 不要提交商业字体（SimHei、微软雅黑等不允许再分发）。
- 竖屏/横屏游戏共用一个字体；粗体/斜体由同一份数据注册，不需要提供多个文件。

## English

This folder **already ships** a freely redistributable Chinese font:

| File | Purpose |
| --- | --- |
| `cjk.ttf` | Bundled font: **Noto Sans SC Regular** (10.6 MB, 31,036 glyphs). Packaged into the romfs and registered as the family `j2mecjk` |
| `OFL-NotoSansSC.txt` | Full text of that font's license (SIL Open Font License 1.1). The build also copies it to `fonts/OFL.txt` inside the romfs |

### Why the font changed

Versions before 1.0.0 bundled **SimHei**, whose `OS/2.fsType = 8` (editable embedding) does
**not** permit redistribution — a real problem when publishing the NRO or the sources to Git.
It is now Noto Sans SC under SIL OFL 1.1 (`fsType = 0`: free to redistribute, modify, use
commercially).

### How the bundled font was produced (reproducible)

```bash
# 1) Grab the upstream variable font (OFL 1.1, co-developed by Adobe and Google)
curl -L -o NotoSansSC[wght].ttf \
  https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf
curl -L -o OFL.txt \
  https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt

# 2) Instance it to a static Regular (wght=400) — a static TTF with glyf outlines
python -c "from fontTools.ttLib import TTFont; from fontTools.varLib import instancer; \
f=TTFont('NotoSansSC[wght].ttf'); instancer.instantiateVariableFont(f,{'wght':400},inplace=True,updateFontNames=True); \
f.save('cjk.ttf')"
```

- The resulting family name is still **Noto Sans SC**: the OFL Reserved Font Name is `Source`,
  which this font does not use.
- Copyright/license records are preserved inside the font (`name` IDs 0/7/8/13/14) and shipped
  alongside `OFL-NotoSansSC.txt`.
- `fsType = 0` — no embedding restrictions.

### Supplying your own font

Rename any TrueType/OpenType font covering **Simplified Chinese** to `cjk.ttf` and overwrite the
bundled file (`node tools/package.mjs` embeds it into the romfs as `j2mecjk`).

- Needed glyphs: common Simplified Chinese, Latin letters, digits, punctuation.
- Open-source alternatives: **Noto Sans CJK SC**, **Source Han Sans SC**, **WenQuanYi Micro Hei**, …
- ⚠️ Do **not** commit a commercial font (SimHei, Microsoft YaHei, … are not redistributable).
- One file is enough: bold/italic are extra variants registered from the same data.
