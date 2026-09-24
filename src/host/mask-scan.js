/*
 * mask-scan.js — 玩家自定义遮罩的"目录 → 条目"纯逻辑（j2me-nx-port 宿主层）
 *
 * 为什么单独一个文件：app/main.js 是一整个闭包（没法在 Node 里 import 单测），
 * 而"扫描哪些文件、怎么生成 id/显示名"是纯字符串逻辑，抽出来就能单测。
 * 真正的读取/解码仍在 app/main.js（那里才有 readFileBytes / __decodePNG）。
 *
 * 约定（对玩家可见，也会写进 SD 上的 说明.txt）：
 *   目录 sdmc:/switch/j2me-nx/masks/
 *     任意名字.png —— 推荐 1280x720；中间留"透明窗口"，游戏画面画在遮罩上层，
 *                     所以窗口区会被游戏盖住，四周装饰留在边缘。
 *     <名字>.raw   —— 兼容内置格式：严格 1280x720 RGBA 裸数据（720*1280*4 = 3,686,400 B）。
 *   非 .png/.raw 的文件、目录、以 . 或 _ 开头的文件一律忽略；按名字排序；
 *   与内置遮罩重名时加后缀，避免覆盖。
 *
 * 导出：globalThis.__maskScan(names) → [{ name, id, label, kind, ext }]
 *   names: readDirSync 返回的名字数组（可含目录名——本函数按扩展名过滤）
 *   id:    'sd:<文件名>'（选择持久化用；与内置的 id 空间隔离）
 */

'use strict';

(function (g) {
  var OK_EXT = { '.png': 'png', '.raw': 'raw' };

  function extOf(name) {
    var i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i).toLowerCase();
  }

  function scan(names) {
    var out = [];
    var seen = Object.create(null);
    if (!names || !names.length) return out;
    for (var i = 0; i < names.length; i++) {
      var n = String(names[i] || '');
      if (!n) continue;
      if (n.charAt(0) === '.' || n.charAt(0) === '_') continue;   // 隐藏/说明文件
      var ext = extOf(n);
      var kind = OK_EXT[ext];
      if (!kind) continue;
      var base = n.slice(0, n.length - ext.length);
      if (!base) continue;
      // 文件名是否纯 ASCII：Switch 的 FAT 驱动读中文名不稳，面板里直接标注出来，
      // 免得玩家"加了遮罩却读不到"（读不到时的报错在 readFileBytes 那层）。
      var ascii = /^[\x20-\x7e]+$/.test(n);
      // PATCH(perfZ21)：后缀走宿主语言字典（英文界面下显示 " (CJK name)"）。
      // 字典缺失时原样返回，不会出现空标签。
      var cjkTag = '（中文名）';
      try {
        if (g.__uiLang && typeof g.__uiLang.t === 'function') cjkTag = g.__uiLang.t(cjkTag);
      } catch (eI18n) { /* 忽略：保持中文后缀 */ }
      var label = base + (ascii ? '' : cjkTag);
      var dup = 1;
      while (seen[label]) { label = base + '(' + (++dup) + ')'; }
      seen[label] = 1;
      out.push({
        name: n,
        id: 'sd:' + n,
        label: label,
        kind: kind,
        ext: ext,
        ascii: ascii,
        rawBytes: kind === 'raw' ? 720 * 1280 * 4 : 0,
      });
    }
    out.sort(function (a, b) { return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0); });
    return out;
  }

  g.__maskScan = scan;

  // 首次运行写进 SD 的说明文本（纯 ASCII 之外的字符由调用方用 __utf8 编码）
  g.__maskReadme = function () {
    return [
      'j2me-nx-port 自定义遮罩说明',
      '=================================',
      '把图片放进本目录（sdmc:/switch/j2me-nx/masks/），然后在游戏列表按 Y →',
      '“选择遮罩”里选它即可；面板每次打开都会重新扫描，不用重启。',
      '',
      '格式：',
      '  *.png  —— 推荐 1280x720。图片中间留出“透明窗口”（alpha=0 的区域），',
      '            游戏画面会等比放大画在遮罩上层盖住窗口区，四周装饰留在屏幕边缘。',
      '            只要不是 1280x720 也会被拉伸铺满，但比例会变形。',
      '  *.raw  —— 兼容内置格式：1280x720 RGBA 裸数据，正好 3686400 字节。',
      '',
      '注意：',
      '  1) 文件名建议用英文/数字（Switch 的 FAT 对中文名支持不稳）。',
      '  2) 以 . 或 _ 开头的文件会被忽略；本说明文件不会被当成遮罩。',
      '  3) 与内置遮罩同名的会加 (2) 后缀区分。',
      '  4) 竖屏游戏用窄竖窗、横屏游戏用宽横窗；遮罩选择对所有游戏生效。',
      '  5) 体积硬上限：PNG 必须 ≤ 1280x720（= 掌机屏分辨率）且文件 ≤ 8MB',
      '     （raw 必须正好 3686400 字节）。遮罩是"缩放到整屏铺满"画的，比屏幕还大',
      '     的图对画面毫无增益，只会多占内存；超限会被拒绝并回落默认遮罩。',
      '     解码一张 1920x1080 的 PNG 瞬时要约 40MB，超过内存档位会把模拟器',
      '     直接顶出去（无报错退出），所以这是硬限制不是建议。',
      '',
    ].join('\n');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
