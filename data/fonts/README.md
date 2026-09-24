# CJK 字体请放在这里 / Put a CJK font here

## 中文

把任意**支持简体中文**的 TrueType/OpenType 字体重命名为 `cjk.ttf` 放在本目录，
构建（`node tools/package.mjs`）时会打进 romfs 并注册为字体族 `j2mecjk`。

- 需要的字形：简体中文常用字 + 拉丁字母 + 数字 + 常用标点。
- 大小：本项目原先使用 SimHei（约 9.7MB）。开源替代：
  **Noto Sans CJK SC**、**Source Han Sans SC**、**文泉驿微米黑 (WenQuanYi Micro Hei)**、
  **思源黑体** 等。
- ⚠️ **不要**把商业字体的 ttf 提交到公开仓库（SimHei 等不允许再分发），
  让使用者自己放字体即可 —— 构建脚本会在缺文件时明确报错。
- 竖屏/横屏游戏都用同一个字体；粗体/斜体是同一份数据注册的额外变体，不需要你提供多个文件。

## English

Rename any TrueType/OpenType font that covers **Simplified Chinese** to `cjk.ttf` and drop it
in this folder. The build (`node tools/package.mjs`) embeds it into the romfs and registers it
as the font family `j2mecjk`.

- Needed glyphs: common Simplified Chinese, Latin letters, digits, and punctuation.
- Size: the original port used SimHei (~9.7 MB). Open-source alternatives:
  **Noto Sans CJK SC**, **Source Han Sans SC**, **WenQuanYi Micro Hei**, etc.
- ⚠️ Do **not** commit a commercial font (SimHei and friends are not redistributable). Let users
  supply their own — the build fails with a clear message when the file is missing.
- One file is enough: bold/italic are extra variants registered from the same data.
