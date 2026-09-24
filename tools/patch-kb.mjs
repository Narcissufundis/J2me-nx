// 一次性补丁：内置键盘的触摸多目标绑定 + 手柄导航（2026-09-23 perfZ3）
import { readFileSync, writeFileSync } from 'node:fs';

function patch(path, pairs) {
  let s = readFileSync(path, 'utf8');
  for (const [from, to] of pairs) {
    if (s.indexOf(from) < 0) { console.error('ANCHOR MISS in ' + path + ': ' + from.slice(0, 60)); process.exit(1); }
    s = s.split(from).join(to);
  }
  writeFileSync(path, s, 'utf8');
  console.log('patched ' + path);
}

// ---- ① app/main.js：触摸多目标绑定 + 触摸日志 + 手柄导航入口 ----
patch('app/main.js', [
  [
`      var tgt = (g.document && g.document.getElementById && g.document.getElementById('canvas')) || g;
      try { tgt.addEventListener('touchstart', kbTouchHandler, { passive: false }); } catch (e1) { /* 无触摸则忽略 */ }
      try { tgt.addEventListener('touchmove', kbTouchHandler, { passive: false }); } catch (e2) { /* 忽略 */ }`,
`      // ⚠️ 上一版只绑了 document.getElementById('canvas')（拿不到就退回 globalThis），
      // 实机点了没反应 —— nx.js 的触摸目标不一定是那个元素。现在所有可能目标都绑，
      // 且前 3 次触摸打日志（[kb] touch …），下次看日志就能判定目标与坐标系。
      var targets = [];
      try { if (g) targets.push(g); } catch (e0) { /* 忽略 */ }
      try { if (g && g.document) targets.push(g.document); } catch (e1) { /* 忽略 */ }
      try {
        if (g && g.document && g.document.getElementsByTagName) {
          var cs = g.document.getElementsByTagName('canvas') || [];
          for (var ci = 0; ci < cs.length; ci++) targets.push(cs[ci]);
        }
      } catch (e2) { /* 忽略 */ }
      var seen = 0;
      var wrap = function (ev) {
        if (seen < 3) {
          seen++;
          var t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || {};
          sdLog('[kb] touch ' + ev.type + ' x=' + (t.clientX || t.pageX || t.x || '?') +
            ' y=' + (t.clientY || t.pageY || t.y || '?'));
        }
        kbTouchHandler(ev);
      };
      for (var ti = 0; ti < targets.length; ti++) {
        try { targets[ti].addEventListener('touchstart', wrap, { passive: false }); } catch (e3) { /* 忽略 */ }
        try { targets[ti].addEventListener('touchmove', wrap, { passive: false }); } catch (e4) { /* 忽略 */ }
      }
      sdLog('[kb] 触摸监听绑定到 ' + targets.length + ' 个目标');`
  ],
  [
`  g.__hostTextInput = hostTextInput;`,
`  // ---- 手柄导航内置键盘（switch-input 在键盘激活时把按键边沿交到这里）----
  // 设计：不依赖触摸。摇杆/十字移高亮，A=确认（输入/确定），B=退格，+=关闭。
  function kbMove(dir) {
    if (!kbState || !kbState.active) return;
    var cells = kbState.cells || [];
    if (!cells.length) return;
    if (kbState.sel === undefined || kbState.sel === null) { kbState.sel = 0; return; }
    var cur = cells[kbState.sel] || cells[0];
    var best = -1, bestD = 1e9;
    for (var i = 0; i < cells.length; i++) {
      if (i === kbState.sel) continue;
      var c = cells[i];
      var dx = (c.x + c.w / 2) - (cur.x + cur.w / 2);
      var dy = (c.y + c.h / 2) - (cur.y + cur.h / 2);
      var okDir = (dir === 'left') ? (dx < -8) : (dir === 'right') ? (dx > 8) : (dir === 'up') ? (dy < -8) : (dy > 8);
      if (!okDir) continue;
      var d = Math.abs(dx) + Math.abs(dy) +
        (((dir === 'left') || (dir === 'right')) ? Math.abs(dy) * 3 : Math.abs(dx) * 3);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) kbState.sel = best;
  }

  g.__kbOverlayActive = function () { return !!(kbState && kbState.active); };
  g.__kbOverlayKey = function (idx, down) {
    if (!down || !kbState || !kbState.active) return true;
    if (idx === 12) { kbMove('up'); return true; }
    if (idx === 13) { kbMove('down'); return true; }
    if (idx === 14) { kbMove('left'); return true; }
    if (idx === 15) { kbMove('right'); return true; }
    if (idx === 9) { kbClose('关闭'); return true; }          // + 键 = 关闭
    var cells = kbState.cells || [];
    var cur = cells[kbState.sel || 0];
    if (idx === 0) {                                           // B = 退格
      if (kbState.buf) kbState.buf = kbState.buf.slice(0, -1);
      return true;
    }
    if (idx === 1 || idx === 6 || idx === 7) {                 // A / ZL / ZR = 确认当前格
      if (cur) kbPress(cur);
      return true;
    }
    return true;
  };

  g.__hostTextInput = hostTextInput;`
  ],
  // 高亮当前格（手柄导航可见）
  [
`        ctx.fillStyle = '#ffffff';
        ctx.font = c.fs + 'px "j2mecjk", monospace';
        ctx.fillText(label, c.x + (c.w - c.tw) / 2, c.y + c.h / 2 + c.fs * 0.36);`,
`        if (kbState.sel === i) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#ffd479';
          ctx.lineWidth = 4;
          ctx.strokeRect(c.x + 2, c.y + 2, c.w - 4, c.h - 4);
          ctx.lineWidth = 1;
        }
        ctx.fillStyle = '#ffffff';
        ctx.font = c.fs + 'px "j2mecjk", monospace';
        ctx.fillText(label, c.x + (c.w - c.tw) / 2, c.y + c.h / 2 + c.fs * 0.36);`
  ],
  // 打开时初始化高亮
  [
`    kbState = { active: true, buf: '', cells: null, hoverKey: '' };   // 布局在绘制时按物理屏算`,
`    kbState = { active: true, buf: '', cells: null, hoverKey: '', sel: 0 };   // 布局在绘制时按物理屏算`
  ]
]);

// ---- ② switch-input.js：键盘激活时按键交给内置键盘，不再发给游戏 ----
patch('src/host/switch-input.js', [
  [
`    // 按钮边沿检测 → 键码直发
    for (var idx in PAD_TO_MIDP) {
      var now = !!cur[idx];
      var was = prevButtons ? !!prevButtons[idx] : false;
      if (now !== was && vmActive) sendKey(PAD_TO_MIDP[idx], now);
    }`,
`    // 内置软键盘激活时：按键边沿交给宿主键盘（摇杆移高亮/A 确认/B 退格/+=关闭），
    // **不再发给游戏** —— 否则选字会同时触发游戏逻辑。不依赖触摸，座机也能打字。
    var kbActive = false;
    try { kbActive = (typeof g.__kbOverlayActive === 'function') && g.__kbOverlayActive(); } catch (eKb) { kbActive = false; }

    // 按钮边沿检测 → 键码直发
    for (var idx in PAD_TO_MIDP) {
      var now = !!cur[idx];
      var was = prevButtons ? !!prevButtons[idx] : false;
      if (now !== was) {
        if (kbActive) {
          try { if (typeof g.__kbOverlayKey === 'function') g.__kbOverlayKey(parseInt(idx, 10), now); } catch (eK2) { /* 忽略 */ }
        } else if (vmActive) {
          sendKey(PAD_TO_MIDP[idx], now);
        }
      }
    }
    // 十字键/摇杆在键盘上也走上面那张表（默认映射到数字），所以这里额外把
    // 原始方向索引的边沿也交给键盘：12~15 已在表里，9(+)=关闭单独处理。
    if (kbActive) {
      var plusNow2 = !!cur[9], plusWas2 = prevButtons ? !!prevButtons[9] : false;
      if (plusNow2 && !plusWas2) { try { g.__kbOverlayKey(9, true); } catch (eP2) { /* 忽略 */ } }
    }`
  ]
]);
console.log('ALL PATCHED');
