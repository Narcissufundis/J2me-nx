/*
 * switch-input.js — Joy-Con → MIDP 键盘映射（nx.js 适配层）
 *
 * ⚠️ 本 @nx.js 运行时没有 buttondown/buttonup 事件（nxjs.nro 二进制里
 * buttondown 零命中、getGamepads 有），输入只有标准 Gamepad API：
 * navigator.getGamepads() 轮询，按钮是 Xbox/W3C 标准索引
 * （0=底 1=右 2=左 3=顶 4=L 5=R 6=ZL 7=ZR 8=- 9=+ 12~15=十字键 16=HOME）。
 * ⚠️ 该布局与 Switch 物理键位相反（2026-09-20 实机确认）：
 * 索引 0=Switch物理B  1=物理A  2=物理Y  3=物理X。
 * 轮询驱动用 rAF + setInterval 双路（哪条通都行，边沿检测幂等）。
 *
 * 键码直发：vendor midp.js 已暴露 window.__sendKeyPress/__sendKeyRelease
 * （绕开合成 DOM 事件链，且尊重 GameCanvas 的 suppressKeyEvents）。
 * Node 仿真无此入口时回落合成 keydown/keyup。
 *
 * 键码 = 诺基亚 N86 标准键码：
 *   -1 UP  -2 DOWN  -3 LEFT  -4 RIGHT  -5 FIRE(确认)
 *   -6 左软键      -7 右软键
 *   48-57 数字 '0'-'9'    42='*'    35='#'
 *
 * Joy-Con 映射（2026-09-19 用户指定键表，2026-09-20 按物理键位修正 A/B、X/Y）：
 *   十字键 → 数字 2/8/4/6（键盘机方向惯例）  左摇杆 → 同方向（死区 0.5）
 *   物理A → -5 确认（索引1）     物理B → '5'(53)（索引0）
 *   物理X → '1'（索引3）  物理Y → '3'（索引2）   L/R → '*'(42) / '#'(35)
 *   ZL → -6 左软键（+ 直通触发 LCDUI BACK 类命令）   ZR → -7 右软键（+ 直通触发 OK 类命令）
 *   L3 → '7'（索引10）  R3 → '9'（索引11）      - → '0'（索引8）
 *   Plus → 关闭当前游戏回菜单（宿主钩子 __requestGameQuit，不发给 VM；仅游戏内）
 *
 * ⚠️ 作用范围（2026-09-23 用户要求）：玩家自定义映射**只在游戏运行时生效**。
 * 没进游戏之前的宿主菜单键（Y=游戏菜单 / X=分辨率 / A=确认 / B=返回 /
 * L,R=翻页 / +=退出）由 app/main.js 直接读物理按钮索引，与本表无关，
 * 玩家怎么改映射都不会影响它们（轮询里另有一道 __gameRunning 硬闸兜底）。
 *
 * 诊断全部走 g.__sdLog（console.log 不落实机日志文件）。
 */
'use strict';

(function () {
  var g = typeof globalThis !== 'undefined' ? globalThis : this;

  // 诺基亚 N86 标准键码（MIDP 规范 keyCode）
  var KEY = {
    UP: -1,
    DOWN: -2,
    LEFT: -3,
    RIGHT: -4,
    FIRE: -5,
    SOFT_LEFT: -6,
    SOFT_RIGHT: -7,
    NUM0: 48,
    NUM1: 49,
    NUM2: 50,
    NUM3: 51,
    NUM4: 52,
    NUM5: 53,
    NUM6: 54,
    NUM7: 55,
    NUM8: 56,
    NUM9: 57,
    STAR: 42,
    POUND: 35,
    CLEAR: 8,
  };

  // 标准 Gamepad 按钮索引 → MIDP 键码（'soft-left'/'soft-right' = 软键双路）
  // ⚠️ nx.js 手柄是 Xbox/W3C 标准布局，面键索引与 Switch 物理键位相反
  // （2026-09-20 实机确认：索引 0=Switch物理B 1=物理A 2=物理Y 3=物理X）：
  // 十字键=数字 2/8/4/6（键盘机方向惯例），ZL/ZR=左右软键，
  // L3/R3=7/9、-=0（补全手机键盘 0-9），+ 不映射（防误触）
  // 默认表（玩家自定义映射的复位基准；改动后由 g.__keyMap.reset() 原地还原）
  var DEFAULT_PAD_TO_MIDP = {
    0: KEY.NUM5,      // 索引0 = Switch 物理B
    1: KEY.FIRE,      // 索引1 = Switch 物理A（确认）
    2: KEY.NUM3,      // 索引2 = Switch 物理Y
    3: KEY.NUM1,      // 索引3 = Switch 物理X
    4: KEY.STAR,      // L = '*'
    5: KEY.POUND,     // R = '#'
    6: 'soft-left',   // ZL = 左软键
    7: 'soft-right',  // ZR = 右软键
    8: KEY.NUM0,      // - = '0'（+ 不映射，保留防误触）
    10: KEY.NUM7,     // L3（左摇杆按下）= '7'
    11: KEY.NUM9,     // R3（右摇杆按下）= '9'
    12: KEY.NUM2,     // D-pad 上 → '2'
    13: KEY.NUM8,     // D-pad 下 → '8'
    14: KEY.NUM4,     // D-pad 左 → '4'
    15: KEY.NUM6,     // D-pad 右 → '6'
  };
  var PAD_TO_MIDP = {
    0: KEY.NUM5,      // 索引0 = Switch 物理B
    1: KEY.FIRE,      // 索引1 = Switch 物理A（确认）
    2: KEY.NUM3,      // 索引2 = Switch 物理Y
    3: KEY.NUM1,      // 索引3 = Switch 物理X
    4: KEY.STAR,      // L = '*'
    5: KEY.POUND,     // R = '#'
    6: 'soft-left',   // ZL = 左软键
    7: 'soft-right',  // ZR = 右软键
    8: KEY.NUM0,      // - = '0'（+ 不映射，保留防误触）
    10: KEY.NUM7,     // L3（左摇杆按下）= '7'
    11: KEY.NUM9,     // R3（右摇杆按下）= '9'
    12: KEY.NUM2,     // D-pad 上 → '2'
    13: KEY.NUM8,     // D-pad 下 → '8'
    14: KEY.NUM4,     // D-pad 左 → '4'
    15: KEY.NUM6,     // D-pad 右 → '6'
  };

  // ==================================================================
  // 玩家自定义按键映射（2026-09-23 perfM）
  //
  // 分工：**纯逻辑在这里**（可 Node 单测），文件的读写由 app/main.js 负责
  // （它才有 __utf8 / readFileSyncLocal，且要落 SD 卡）。
  //
  // 配置文件 sdmc:/switch/j2me-nx/keys.txt，格式（# 后可写注释）：
  //     <Switch 物理键名> = <MIDP 目标键名 或 数字键码>
  //   物理键名：B A Y X L R ZL ZR MINUS L3 R3 UP DOWN LEFT RIGHT
  //   目标键名：FIRE(确认) SOFT_LEFT SOFT_RIGHT UP DOWN LEFT RIGHT
  //             NUM0..NUM9 STAR POUND CLEAR NONE(=解除绑定)
  //   PLUS（+ 键）恒为"退出到菜单"，不参与映射，也不出现在文件里。
  //   映射是**全局一份**（所有游戏共用，同 mask.json 的遮罩选择）。
  //   面板绑定 = 独占（换键会自动解除该目标键上旧的物理键）。
  // ==================================================================
  var SW_BUTTONS = [
    { idx: 0,  name: 'B',     label: '物理B' },
    { idx: 1,  name: 'A',     label: '物理A' },
    { idx: 2,  name: 'Y',     label: '物理Y' },
    { idx: 3,  name: 'X',     label: '物理X' },
    { idx: 4,  name: 'L',     label: 'L 肩键' },
    { idx: 5,  name: 'R',     label: 'R 肩键' },
    { idx: 6,  name: 'ZL',    label: 'ZL' },
    { idx: 7,  name: 'ZR',    label: 'ZR' },
    { idx: 8,  name: 'MINUS', label: '- 键' },
    { idx: 10, name: 'L3',    label: 'L3 摇杆按' },
    { idx: 11, name: 'R3',    label: 'R3 摇杆按' },
    { idx: 12, name: 'UP',    label: '十字上' },
    { idx: 13, name: 'DOWN',  label: '十字下' },
    { idx: 14, name: 'LEFT',  label: '十字左' },
    { idx: 15, name: 'RIGHT', label: '十字右' },
  ];
  // MIDP 目标键（UI 与文件解析共用）
  // ⚠️ 软键在**活动表里的值**必须是字符串 'soft-left'/'soft-right'——
  // sendKey() 靠 typeof === 'string' 走"键码直发 + LCDUI 命令按钮 click"双路。
  // 所以这里的 code 对软键就是字符串（否则 codeName/bindingsOf 对不上，
  // 导出会写出 soft-left 这种解析不了的名字——2026-09-23 单测抓到过）。
  var MIDP_TARGETS = [
    { code: KEY.FIRE,        name: 'FIRE',       label: '确认(FIRE)' },
    { code: 'soft-left',     name: 'SOFT_LEFT',  label: '左软键' },
    { code: 'soft-right',    name: 'SOFT_RIGHT', label: '右软键' },
    { code: KEY.UP,          name: 'UP',         label: '方向-上' },
    { code: KEY.DOWN,        name: 'DOWN',       label: '方向-下' },
    { code: KEY.LEFT,        name: 'LEFT',       label: '方向-左' },
    { code: KEY.RIGHT,       name: 'RIGHT',      label: '方向-右' },
    { code: KEY.NUM0,        name: 'NUM0',       label: "数字 0" },
    { code: KEY.NUM1,        name: 'NUM1',       label: "数字 1" },
    { code: KEY.NUM2,        name: 'NUM2',       label: "数字 2" },
    { code: KEY.NUM3,        name: 'NUM3',       label: "数字 3" },
    { code: KEY.NUM4,        name: 'NUM4',       label: "数字 4" },
    { code: KEY.NUM5,        name: 'NUM5',       label: "数字 5" },
    { code: KEY.NUM6,        name: 'NUM6',       label: "数字 6" },
    { code: KEY.NUM7,        name: 'NUM7',       label: "数字 7" },
    { code: KEY.NUM8,        name: 'NUM8',       label: "数字 8" },
    { code: KEY.NUM9,        name: 'NUM9',       label: "数字 9" },
    { code: KEY.STAR,        name: 'STAR',       label: "* 键" },
    { code: KEY.POUND,       name: 'POUND',      label: "# 键" },
    { code: KEY.CLEAR,       name: 'CLEAR',      label: '清除键' },
  ];
  var KEY_NAME_TO_CODE = { 'NONE': null };
  (function () {
    for (var i = 0; i < MIDP_TARGETS.length; i++) {
      KEY_NAME_TO_CODE[MIDP_TARGETS[i].name] = MIDP_TARGETS[i].code;
      KEY_NAME_TO_CODE[String(MIDP_TARGETS[i].code)] = MIDP_TARGETS[i].code;
    }
    // 数字键码也允许直接写 48..57 / 42 / 35（上面已通过 String(code) 覆盖）
    KEY_NAME_TO_CODE['FIRE'] = KEY.FIRE;
    KEY_NAME_TO_CODE['SOFT_LEFT'] = 'soft-left';
    KEY_NAME_TO_CODE['SOFT_RIGHT'] = 'soft-right';
  })();

  // ==================================================================
  // 按键机型（厂商键值方案）—— 2026-09-23 perfR
  //
  // MIDP 规范**只**统一了：数字键 48-57、'*'=42、'#'=35、方向 -1..-4、
  // FIRE(确认) -5、CLEAR=8。**软键（左右软键）是厂商自定的**，于是同一份
  // 游戏在诺基亚和摩托罗拉上必须发不同的 keyCode 才会被识别成软键。
  //
  // 数值来源：
  //   · **用户 2026-09-23 提供的摩托罗拉键表（以此为准）**：
  //       左软件 -21   右软件 -22   OK 键 -20
  //   · Stack Overflow「How to get the keycode for different mobiles using j2me」
  //     里流传的 KeyCodeAdapter（源自 iteye 移植实践）
  //   · Stack Overflow「J2ME Soft Key Wrapper」答案里的
  //     standard || Motorola || Siemens || Motorola 2 || Motorola 1
  //       左软键 -6 || -21 || -1 || -20 || 21
  //       右软键 -7 || -22 || -4 ||        22
  //   ⚠️ 那份流传表把 -20 归到"左软键"，但实机键表明确是 **OK 键**——
  //      两者冲突时以实机键表为准（-20 = fire，不是 softLeft）。
  //   诺基亚竖屏（N86 等 S60 竖屏）：软键 -6/-7，确认取 MIDP 规范值 -5
  //   诺基亚横屏（E52/E63 等 S60 横屏键盘机）：软键同为 -6/-7、清除 -8，
  //     但这类**非 N-Gage 键盘机**的游戏按键盘机惯例走数字键：
  //     方向 2/4/6/8、**确认 = '5'(53)**。所以这一档的差别在确认码（53 而不是 -5）。
  //     注：本模拟器物理十字键默认就发 2/8/4/6（数字），方向风格不用改；
  //     53 在 vendor 的 getGameAction 里也映射为 FIRE，两种判断方式都通。
  //     （网上查不到 E52/E63 专属的 J2ME 键值表，Nokia 官方 wiki 已下线；
  //       这一档数值可在 sdmc:/switch/j2me-nx/keyprofiles.json 的 __profiles 里
  //       直接改，不用重新出包。）
  //   摩托罗拉：软键 -21/-22，确认(OK) -20
  //   （正码 21/22 那种老机型变体按用户要求不内置；真要遇到，
  //     用 defineProfile 加一个即可，getKeyName 表里已经登记了正码软键名）
  //
  // 生效范围：**只改发给 VM 的 keyCode**，不动物理键→逻辑键的映射表。
  // 所以 keys.txt 里绑成 软键/确认 的那些键在任何机型下都还是软键/确认，
  // 只是发出去的数字跟着机型变。配套：vendor 的 KeyConverter.getGameAction
  // 要认得住 -20（否则用 getGameAction()==FIRE 判断的游戏在摩托罗拉档下失灵）。
  // ==================================================================
  var KEY_PROFILES = {
    nokia: {
      id: 'nokia', label: '诺基亚竖屏（N86 软-6/-7 确认-5）',
      softLeft: -6, softRight: -7, fire: -5, clear: 8,
    },
    nokiaLS: {
      id: 'nokiaLS', label: '诺基亚横屏（E52/E63）',
      softLeft: -6, softRight: -7, fire: -5, clear: 8,
      // ⚠️ E52/E63 这类 **QWERTY 横屏机**在 J2ME 里按键报的是**字符码**：
      // 数字键底下那层字母的 ASCII（用户 2026-09-23 提供的实机键表）：
      //   1=r(114) 2=t(116) 3=y(121)   *=u(117)
      //   4=f(102) 5=g(103) 6=h(104)   0=m(109)
      //   7=v(118) 8=b(98)  9=n(110)   #=j(106)
      // 也就是键盘上 r/f/v、t/g/b、y/h/n、u/j/m 那套九宫格叠层。
      // 软键/确定与竖屏相同（-6/-7/-5）。
      digits: {
        49: 114, 50: 116, 51: 121, 52: 102, 53: 103, 54: 104,
        55: 118, 56: 98, 57: 110, 42: 117, 48: 109, 35: 106,
      },
    },
    motorola: {
      id: 'motorola', label: '摩托罗拉（左-21 右-22 OK-20）',
      softLeft: -21, softRight: -22, fire: -20, clear: 8,
    },
  };
  var PROFILE_ORDER = ['nokia', 'nokiaLS', 'motorola'];
  var DEFAULT_PROFILE = 'nokia';
  var activeProfile = DEFAULT_PROFILE;

  function profileOf() { return activeProfile; }
  function profileList() {
    var out = [];
    for (var i = 0; i < PROFILE_ORDER.length; i++) {
      var p = KEY_PROFILES[PROFILE_ORDER[i]];
      if (p) out.push(p);
    }
    return out;
  }
  // 切换机型：只接受已定义的 id（防止 json 里写了错名字把表带崩）
  function setKeyProfile(id) {
    if (!id || !KEY_PROFILES[id]) {
      if (id && id !== DEFAULT_PROFILE) dlog('未知按键机型 "' + id + '"，回落 ' + DEFAULT_PROFILE);
      activeProfile = DEFAULT_PROFILE;
      return false;
    }
    activeProfile = id;
    return true;
  }
  // 软键在**当前机型**下的 keyCode
  function softCode(side) {
    var p = KEY_PROFILES[activeProfile] || KEY_PROFILES[DEFAULT_PROFILE];
    return (side === 'soft-left') ? p.softLeft : p.softRight;
  }
  // 确认(OK)键在当前机型下的 keyCode（诺基亚 -5 / 摩托罗拉 -20）
  function fireCode() {
    var p = KEY_PROFILES[activeProfile] || KEY_PROFILES[DEFAULT_PROFILE];
    return (typeof p.fire === 'number') ? p.fire : KEY.FIRE;
  }
  // 出站键码翻译：逻辑键码 → 当前机型的实际键码。
  //   ① 确认键（逻辑 -5）：换成机型确认码（摩托罗拉 -20；诺基亚都是 -5）
  //   ② 数字/*/#：机型若给了 digits 表就查表（E52/E63 横屏 → QWERTY 字符码）
  //   ③ 其余（方向 -1..-4 等）原样
  function mapOutCode(code) {
    if (code === KEY.FIRE) return fireCode();
    var p = KEY_PROFILES[activeProfile] || KEY_PROFILES[DEFAULT_PROFILE];
    if (p.digits && p.digits[code] !== undefined) return p.digits[code];
    return code;
  }
  // 允许玩家/以后从 SD 自定义机型（例如某型号软键/OK/数字码是别的数）
  function defineProfile(id, label, codes) {
    if (!id || !codes || typeof codes.softLeft !== 'number' || typeof codes.softRight !== 'number') return false;
    if (PROFILE_ORDER.indexOf(id) < 0) PROFILE_ORDER.push(id);
    KEY_PROFILES[id] = {
      id: id, label: label || id,
      softLeft: codes.softLeft, softRight: codes.softRight,
      fire: (typeof codes.fire === 'number') ? codes.fire : KEY.FIRE,
      clear: (typeof codes.clear === 'number') ? codes.clear : 8,
      digits: (codes.digits && typeof codes.digits === 'object') ? codes.digits : null,
    };
    return true;
  }

  function codeLabel(code) {
    if (code === null || code === undefined) return '（未绑定）';
    for (var i = 0; i < MIDP_TARGETS.length; i++) {
      if (MIDP_TARGETS[i].code === code) return MIDP_TARGETS[i].label;
    }
    return String(code);
  }
  function codeName(code) {
    if (code === null || code === undefined) return 'NONE';
    for (var i = 0; i < MIDP_TARGETS.length; i++) {
      if (MIDP_TARGETS[i].code === code) return MIDP_TARGETS[i].name;
    }
    return String(code);
  }
  function buttonLabel(idx) {
    for (var i = 0; i < SW_BUTTONS.length; i++) {
      if (SW_BUTTONS[i].idx === idx) return SW_BUTTONS[i].label;
    }
    return '索引' + idx;
  }

  // 恢复默认表（原地改 g.__buttonMap 指向的同一个对象，轮询侧立刻生效）
  function resetKeyMap() {
    for (var k in PAD_TO_MIDP) delete PAD_TO_MIDP[k];
    for (var dk in DEFAULT_PAD_TO_MIDP) PAD_TO_MIDP[dk] = DEFAULT_PAD_TO_MIDP[dk];
  }
  // 单条绑定：code = null 表示解除
  function setBinding(idx, code) {
    if (code === null || code === undefined) delete PAD_TO_MIDP[idx];
    else PAD_TO_MIDP[idx] = code;
    return true;
  }
  function bindingsOf(code) {
    var out = [];
    for (var k in PAD_TO_MIDP) {
      if (PAD_TO_MIDP[k] === code) out.push(buttonLabel(parseInt(k, 10)));
    }
    return out;
  }
  // 独占绑定（**面板用**）：把一个物理键绑到某目标键时，先把别的物理键上
  // 同一个目标键的旧绑定解除。
  // 实机反馈（2026-09-23）：第一版只做"追加"，于是把 X 绑到确认后，
  // 物理A（默认也是确认）仍然生效 —— 玩家看到的是"原版按键没被替换、
  // 一个键有两个映射"。玩家预期是"换键"，所以面板绑定必须独占。
  // 返回被解绑的物理键名数组（面板用来提示"原 物理A 的绑定已解除"）。
  // 手改 keys.txt 走 importText()，**不**独占：文件是权威，允许故意写重复
  //（比如想让 L 和 ZL 都是左软键）。
  function bindExclusive(idx, code) {
    var cleared = [];
    if (code !== null && code !== undefined) {
      for (var k in PAD_TO_MIDP) {
        var ki = parseInt(k, 10);
        if (ki !== idx && PAD_TO_MIDP[k] === code) {
          delete PAD_TO_MIDP[k];
          cleared.push(buttonLabel(ki));
        }
      }
    }
    setBinding(idx, code);
    return cleared;
  }
  // 解析文本（可被单测直接调用）：返回成功应用的条数
  function importText(text) {
    resetKeyMap();
    if (!text) return 0;
    var byName = {};
    for (var i = 0; i < SW_BUTTONS.length; i++) byName[SW_BUTTONS[i].name] = SW_BUTTONS[i].idx;
    var lines = String(text).split(/\r?\n/);
    var applied = 0, bad = 0;
    for (var li = 0; li < lines.length; li++) {
      var ln = lines[li];
      var hash = ln.indexOf('#');
      if (hash >= 0) ln = ln.slice(0, hash);
      ln = ln.replace(/^\s+|\s+$/g, '');
      if (!ln) continue;
      var eq = ln.indexOf('=');
      if (eq <= 0) { bad++; continue; }
      var phys = ln.slice(0, eq).replace(/^\s+|\s+$/g, '').toUpperCase();
      var tgt = ln.slice(eq + 1).replace(/^\s+|\s+$/g, '').toUpperCase();
      if (!(phys in byName)) { bad++; continue; }
      if (!(tgt in KEY_NAME_TO_CODE)) { bad++; continue; }
      setBinding(byName[phys], KEY_NAME_TO_CODE[tgt]);
      applied++;
    }
    if (bad) dlog('按键映射：忽略 ' + bad + ' 行无法识别的配置');
    return applied;
  }
  // 生成完整配置文件文本（含注释；玩家可直接手改）
  function exportText() {
    var out = [];
    out.push('# j2me-nx-port 按键映射（玩家可自行修改；改完在 Y 菜单 → 按键映射 里按 B 返回即生效，或重启）');
    out.push('# 格式：<Switch 物理键名> = <MIDP 目标键名>');
    out.push('# 物理键名：' + SW_BUTTONS.map(function (b) { return b.name; }).join(' '));
    out.push('# 目标键名：' + MIDP_TARGETS.map(function (t) { return t.name; }).join(' ') + ' NONE');
    out.push('# NONE = 解除该按钮的绑定；+ 键恒为"退出到菜单"，不在此表');
    out.push('# 映射对所有游戏生效（全局一份）。玩家在同一目标键上只该留一个物理键——');
    out.push('#   面板里换绑会自动解除旧的；手改本文件可以故意写重复（如 L 与 ZL 都要 STAR）。');
    out.push('# ⚠️ 本表只在游戏内生效：没进游戏前的宿主菜单键不受影响');
    out.push('#    （Y=游戏菜单 X=分辨率 A=确认 B=返回 L/R=翻页 +=退出，固定不映射）');
    out.push('# 当前（第一次生成时=默认值）：');
    for (var i = 0; i < SW_BUTTONS.length; i++) {
      var b = SW_BUTTONS[i];
      out.push(padRight(b.name, 6) + '= ' + codeName(PAD_TO_MIDP[b.idx]));
    }
    return out.join('\n') + '\n';
  }
  function padRight(s, n) {
    while (s.length < n) s += ' ';
    return s;
  }
  function keyMapRows() {
    var out = [];
    for (var i = 0; i < SW_BUTTONS.length; i++) {
      var b = SW_BUTTONS[i];
      var code = (b.idx in PAD_TO_MIDP) ? PAD_TO_MIDP[b.idx] : null;
      out.push({ idx: b.idx, phys: b.name, label: b.label, code: code, codeLabel: codeLabel(code) });
    }
    return out;
  }

  if (!g.__keyMap) {
    g.__keyMap = {
      buttons: SW_BUTTONS,
      targets: MIDP_TARGETS,
      codeLabel: codeLabel,
      buttonLabel: buttonLabel,
      bindingsOf: bindingsOf,
      rows: keyMapRows,
      setBinding: setBinding,
      bindExclusive: bindExclusive,
      reset: resetKeyMap,
      importText: importText,
      exportText: exportText,
      live: PAD_TO_MIDP,
    };
  }
  g.__keyResetMap = resetKeyMap;

  var prevButtons = null;  // 上一帧按钮快照（null = 尚未见手柄）
  var prevStick = null;    // 上一帧摇杆方向快照
  var keyLogCount = 0;     // 按键流水日志条数上限
  var noPadLogged = false; // "一直没见到手柄"只报一次
  var heartbeats = 0;      // 轮询心跳（前 3 次）

  function dlog(line) {
    try {
      if (typeof g.__sdLog === 'function') g.__sdLog('[input] ' + line);
      else console.log('[input] ' + line);
    } catch (e) { /* 日志绝不能引发二次问题 */ }
  }

  function fireKey(which, down) {
    var ev = new g.Event(down ? 'keydown' : 'keyup');
    ev.which = which;
    ev.keyCode = which;
    // window 与 globalThis 可能不是同一对象，两边都派发
    g.dispatchEvent(ev);
    try { if (g.window && g.window !== g && g.window.dispatchEvent) g.window.dispatchEvent(ev); } catch (e) { }
  }

  function fireSoftButton(which) {
    // PATCH(j2me-nx-port 2026-09-23): 先走"直接触发当前 LCDUI 命令"的直通路径。
    //
    // 【为什么】原来的 DOM click 路径在本移植里是死路：env-prelude 的 DOM 垫片对**任意
    // id** 都返回自动创建的元素（永远 truthy），gfx.js 的 NativeMenu.updateCommands
    // 于是总走 `if (el)` 分支，把命令 onclick 挂在 #displayable-N 的 .button0/.button1
    // 上；而这里点的是 #header-ok-button / #back-button —— 它们的 onclick 从来没被赋值。
    // 结果：ZL/ZR 对**所有** Command 界面（取名 Form/TextBox、Alert、List）都无效，
    // 游戏里按"确定"毫无反应（实机表现："取名打得进字，按游戏自己的确定读不到"）。
    // gfx.js 现在把命令表留在 JS 侧并暴露 __lcdInvokeCommand(kind)，这里优先用它。
    var kind = (which === 'soft-left') ? 'back' : 'ok';
    try {
      if (typeof g.__lcdInvokeCommand === 'function' && g.__lcdInvokeCommand(kind)) {
        if (keyLogCount < 40) {
          keyLogCount++;
          dlog('[cmd] ' + which + ' → 触发 LCDUI ' + kind + ' 命令');
        }
        return;
      }
    } catch (eC) { dlog('[cmd] 直通触发异常: ' + (eC && eC.message)); }

    // 回落：DOM 按钮 click（浏览器版路径；gfx.js 里也补挂了 onclick）
    var el = g.document && g.document.getElementById(which === 'soft-left' ? 'back-button' : 'header-ok-button');
    if (!el) return;
    var ev = new g.Event('click');
    // gfx.js 对软键元素可能用 onclick 或 addEventListener，两种都触发
    el.dispatchEvent(ev);
    if (typeof el.onclick === 'function') el.onclick(ev);
  }

  // 内部发送（边沿检测在轮询里做，这里不去重）
  function sendKey(which, down) {
    if (which === undefined || which === null) return;   // 玩家解绑过的按钮：不发键
    if (typeof which === 'string') {
      // 软键：键码按**当前机型**取（诺基亚 -6/-7、摩托罗拉 -21/-22…），
      // 同时走"键码直发（Canvas 游戏） + LCDUI 命令按钮 click（Form/List）"双路
      var code = softCode(which);
      sendCode(code, down);
      if (down) fireSoftButton(which);
      if (keyLogCount < 30) { keyLogCount++; dlog((down ? '↓ ' : '↑ ') + which + '(' + code + ')'); }
      return;
    }
    sendCode(mapOutCode(which), down);
    if (keyLogCount < 30) { keyLogCount++; dlog((down ? '↓ ' : '↑ ') + which); }
  }

  function sendCode(code, down) {
    if (typeof g.__sendKeyPress === 'function') {
      // 直发路径（Switch）：vendor midp.js 暴露的内部函数
      if (down) g.__sendKeyPress(code);
      else g.__sendKeyRelease(code);
    } else {
      // 回落路径（Node 仿真）：合成 DOM 键盘事件
      fireKey(code, down);
    }
  }

  // 供宿主/测试直接注入按键（数字 = 键码，'soft-left'/'soft-right' = 软键）
  g.__dispatchKey = sendKey;

  function pollPad() {
    var nav = g.navigator;
    if (!nav || typeof nav.getGamepads !== 'function') return;
    var pads;
    try { pads = nav.getGamepads(); } catch (e) { return; }
    if (!pads) return;
    var pad = null;
    for (var i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) { pad = pads[i]; break; }
    }
    if (!pad) {
      prevButtons = null; prevStick = null;
      if (!noPadLogged && ++heartbeats === 40) { // 40 次轮询（约 2s rAF / 2s 定时）仍无手柄
        noPadLogged = true;
        dlog('getGamepads 可用但未发现已连接手柄');
      }
      return;
    }

    var btns = pad.buttons || [];
    var cur = [];
    for (var b = 0; b < btns.length; b++) {
      cur[b] = !!(btns[b] && (btns[b].pressed || btns[b].value > 0.5));
    }
    if (!prevButtons) {
      dlog('手柄已连接: buttons=' + btns.length +
        ' axes=' + ((pad.axes && pad.axes.length) || 0) +
        ' mapping=' + pad.mapping + ' id=' + String(pad.id).slice(0, 60));
    }

    // ⚠️ 硬闸：只有游戏真正在跑（__gameRunning === true）才向 VM 发键。
    // 没进游戏之前（游戏列表 / Y 菜单 / 改名 / 遮罩 / 按键映射 / 分辨率面板）
    // **一根 MIDP 键都不发**，所以玩家自定义映射在菜单阶段完全无效——
    // "Y 开菜单、X 分辨率、A 确认、B 返回、L/R 翻页、+ 退出"这些宿主键
    // 永远由 app/main.js 直接读物理索引决定，任何映射都改不动它们。
    // （边沿检测照常跑：门关着也更新 prevButtons，避免开门瞬间补发一次假边沿。）
    var vmActive = (g.__gameRunning === true);

    // 内置软键盘激活时：按键边沿交给宿主键盘（摇杆移高亮/A 确认/B 退格/+=关闭），
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
    }
    // + 键（索引 9）不进游戏：按下边沿 = 关闭当前游戏回菜单（宿主钩子）。
    // 同样只在游戏运行时才转给宿主；菜单阶段（__gameRunning=false）连钩子都不调，
    // 免得菜单里误按 + 触发一次无意义的重启流程。
    var plusNow = !!cur[9];
    var plusWas = prevButtons ? !!prevButtons[9] : false;
    if (plusNow && !plusWas && vmActive && typeof g.__requestGameQuit === 'function') {
      g.__requestGameQuit('+ 键');
    }
    prevButtons = cur;

    // 左摇杆 → 与十字键同键码（死区 0.5，边沿检测）：
    // 走同一张表，所以玩家把"十字上"改成别的键时摇杆跟着变（解绑则摇杆也不发）。
    var axes = pad.axes || [];
    var ax = axes[0] || 0, ay = axes[1] || 0;
    var st = { l: ax < -0.5, r: ax > 0.5, u: ay < -0.5, d: ay > 0.5 };
    if (prevStick && vmActive) {
      if (st.l !== prevStick.l) sendKey(PAD_TO_MIDP[14], st.l);
      if (st.r !== prevStick.r) sendKey(PAD_TO_MIDP[15], st.r);
      if (st.u !== prevStick.u) sendKey(PAD_TO_MIDP[12], st.u);
      if (st.d !== prevStick.d) sendKey(PAD_TO_MIDP[13], st.d);
    }
    prevStick = st;
  }

  function safePoll() {
    try { pollPad(); } catch (e) {
      if (keyLogCount < 30) { keyLogCount++; dlog('轮询异常: ' + (e && e.message)); }
    }
  }

  // 接入手柄轮询（仅在真机上存在；Node 仿真无 getGamepads）。
  // 轮询循环是宿主常驻件（走 __noGen 直通定时器，软重启不重装）：
  // 它每拍动态读 g.__sendKeyPress 等全局入口，新会话的 VM 自动被驱动。
  g.__installSwitchInput = function () {
    if (g.__switchInputInstalled) return true;
    var nav = g.navigator;
    if (!nav || typeof nav.getGamepads !== 'function') {
      // 诊断：把 navigator 的可枚举键列出来（正常应有 getGamepads）
      try {
        var keys = nav ? Object.keys(nav).join(',') : '(navigator 不存在)';
        dlog('安装失败: navigator.getGamepads 缺失，navigator keys=[' + keys + ']');
      } catch (e) { }
      return false;
    }
    dlog('安装: getGamepads=' + (typeof nav.getGamepads) +
      ' 直发入口=' + (typeof g.__sendKeyPress) +
      ' rAF=' + (typeof g.requestAnimationFrame) +
      ' setInterval=' + (typeof g.setInterval));
    // 双驱动：rAF（nx.js 主循环每帧，mv2switch 同款）+ 定时器兜底。
    // pollPad 做边沿检测，重复调用幂等。
    var noGen = g.__noGen || g;
    var raf = noGen.requestAnimationFrame || g.requestAnimationFrame;
    var setInt = noGen.setInterval || g.setInterval;
    if (typeof raf === 'function') {
      var loop = function () { safePoll(); raf(loop); };
      raf(loop);
    }
    if (typeof setInt === 'function') {
      setInt(safePoll, 50);
    }
    g.__switchInputInstalled = true;
    return true;
  };

  g.__buttonMap = PAD_TO_MIDP;
  g.__KEY = KEY;

  // ---- 按键机型对外接口 ----
  g.__setKeyProfile = setKeyProfile;      // 宿主在游戏启动前调用
  g.__keyProfile = profileOf;            // 当前机型 id
  g.__keyProfiles = {                    // 面板/测试用
    list: profileList,
    define: defineProfile,
    softCode: softCode,
    fireCode: fireCode,
    mapOutCode: mapOutCode,
    current: profileOf,
    DEFAULT: DEFAULT_PROFILE,
  };
  // 供 vendor 的 KeyConverter.getKeyName 用：软键/确认码 → 名字。
  // 游戏常靠 getKeyName(code) 反查"这是不是软键"（见 SO 上流传的检测代码），
  // 所以把各机型的软键码都登记上，机型切到哪一版都能查到名字。
  g.__softKeyNameMap = {
    '-6': 'SoftKey1', '-7': 'SoftKey2',
    '-21': 'SoftKey1', '-22': 'SoftKey2',
    '21': 'SoftKey1', '22': 'SoftKey2',
    '-20': 'OK', '-23': 'SoftKey3', '-8': 'Clear',
  };
})();
