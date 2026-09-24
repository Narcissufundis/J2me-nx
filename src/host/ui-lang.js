/*
 * ui-lang.js — 屏显文字中/英切换（j2me-nx-port 宿主层 · 纯逻辑，可单测）
 *
 * ⚠ 命名：本文件是**界面语言**（UI language）。仓库里另有 tools/i18n-test/，
 * 那是 Java 类库 i18n（GBK 编码 / StringBuilder / LayerManager 的端到端验证），
 * 两者毫无关系 —— 所以这里统一叫 ui-lang，不去挤 "i18n" 这个词。
 *
 * 用户需求（2026-09-23）：主页右上角提示"按 ZR+ZL 切换中/英文"，ZR+ZL 弹出
 * 两项（切换英文 / 切换中文），选完再问一次确认；选英文后**模拟器自己的屏显文字**
 * 全部变英文。日志（error.log 里的 sdLog/maskLog/console）**不翻译**——用户明确
 * "日志不用"，而且日志是排障凭据，翻译只会让历史记录对不上。
 *
 * 为什么字典的 key 是中文原文：
 *   代码里 4000+ 行、屏显字符串上百处，若改成 key:'menu.title' 这种间接层，
 *   每次改文案都要同步两个文件，漏一处就是线上英文界面里蹦出一句中文。
 *   这里让调用点保持中文原文、由 T() 查表替换：
 *     源码可读性不变；未命中字典时原样返回（不会出现空白/undefined）；
 *     tests/ui-lang.test.mjs 反过来扫源码里所有 T('…') 字面量，只要有一个没进
 *     字典就红 —— 覆盖率是**被断言钉住的**，不靠人记。
 *
 * 与 main.js 的分工（本仓库一贯的分层）：
 *   本文件只管"查表 + 当前语言 + 通知"；**文件读写由 main.js 负责**
 *   （那边才有 readFileSyncLocal/__utf8 与 Switch/Node 双路径），通过
 *   api.onChange(lang) 回调落盘 sdmc:/switch/j2me-nx/lang.json。
 *   于是本文件在 Node 里可以直接 eval 出来单测，不需要任何运行时。
 *
 * 导出：globalThis.__uiLang = {
 *   lang      当前语言（'zh' | 'en'，只读 getter）
 *   t(s, a1..a4)  取译文并替换 {1}..{4} 占位符；未命中/异常一律返回原文
 *   set(lang, silent) 切语言并回调 onChange（silent=true 时不回调，供开机载入用）
 *   has(key)      字典里有没有这条
 *   DICT      只读字典（测试用）
 *   takeMisses()  取走"英文模式下没查到译文、且原文含汉字"的串（main.js 定期落日志）
 *   onChange  由 main.js 安装：function (lang) { …写盘… }
 * }
 */

(function () {
  var g = globalThis;

  // ---- 字典：中文原文 → 英文。{1}..{4} 是调用点传进来的参数占位符。 ----
  // 约定：英文值里**不允许出现汉字**（tests/ui-lang.test.mjs 断言），符号（▶ ← ↑↓ ● … ⚠）
  // 保留 —— 它们不依赖字体语言，且面板里的光标标记靠它们对齐。
  var DICT = {
    // ---- 主列表 ----
    '选择游戏 ({1})': 'Games ({1})',
    '第 {1}/{2} 页': 'Page {1}/{2}',
    'A 启动   X 分辨率   Y 菜单(改名/遮罩/按键/删除)   L/R 翻页(循环)':
      'A Play   X Resolution   Y Menu (rename / mask / keys / delete)   L/R Page',
    '游戏内: A=确认 B=5 X=1 Y=3 L=* R=# ZL/ZR=软键 L3=7 R3=9 -=0 +=退出':
      'In game: A=OK B=5 X=1 Y=3 L=* R=# ZL/ZR=soft keys L3=7 R3=9 -=0 +=Quit',
    '（无入口）': ' (no entry)',

    // ---- 分辨率面板 ----
    '分辨率设置': 'Resolution',
    '{1}（{2}）': '{1} ({2})',
    '自动探测': 'Auto detect',
    '  横屏铺满': '  Landscape',
    '  竖屏遮罩': '  Portrait',

    // ---- Y 键游戏菜单 ----
    '游戏操作': 'Game actions',
    '启动': 'Play',
    '改名': 'Rename',
    '选择遮罩': 'Select mask',
    '按键映射': 'Key mapping',
    '按键机型': 'Key profile',
    '删除': 'Delete',
    '返回列表': 'Back to list',
    '（不可恢复）': ' (permanent)',

    // ---- 遮罩面板 ----
    '默认（竖屏内置遮罩，横屏铺满）': 'Default (built-in portrait mask, landscape fills)',
    '内置竖屏遮罩': 'Built-in portrait mask',
    '横屏-可爱小熊': 'Landscape - cute bear',
    '横屏-复古手柄': 'Landscape - retro pad',
    '横屏-怀旧游戏机': 'Landscape - retro console',
    '横屏-秋日风景': 'Landscape - autumn view',
    '竖屏-机械风格1': 'Portrait - mech 1',
    '竖屏-机械风格2': 'Portrait - mech 2',
    '竖屏-机械风格3': 'Portrait - mech 3',
    '竖屏-机械风格4': 'Portrait - mech 4',
    '（中文名）': ' (CJK name)',
    '遮罩垫底，游戏居中（A 立即生效）': 'Mask behind, game centered (A applies now)',
    '自加遮罩：{1} 放 1280x720 png/raw': 'Custom mask: put 1280x720 png/raw in {1}',
    '  ●当前': '  ●current',
    '   ↑↓ 滚动': '   ↑↓ Scroll',

    // ---- 按键映射面板 ----
    '（未绑定）': '(unbound)',
    '恢复默认映射': 'Restore default mapping',
    '返回': 'Back',
    '已恢复默认映射（写入 keys.txt）': 'Default mapping restored (written to keys.txt)',
    '恢复失败: {1}': 'Restore failed: {1}',
    '请按手柄上要绑定到「{1}」的键…（B 取消，+ 解除）':
      'Press the controller button to bind to "{1}"… (B cancel, + unbind)',
    '已取消': 'Cancelled',
    '已解除「{1}」的绑定': 'Unbound "{1}"',
    '已绑定：{1} → {2}': 'Bound: {1} → {2}',
    '（已解除 {1} 的原绑定）': ' (released {1})',
    '、': ', ',
    '保存失败: {1}': 'Save failed: {1}',
    '配置文件 sdmc:/switch/j2me-nx/keys.txt（对所有游戏生效，可直接手改；B 键留作取消）':
      'Config: sdmc:/switch/j2me-nx/keys.txt (all games, hand-editable; B stays Cancel)',
    'A 选中目标键 → 再按手柄上的键完成绑定（B 取消 / + 解除绑定）':
      'A select a target key → press a controller button to bind (B cancel / + unbind)',
    '⚠ 对所有游戏生效；换绑会自动解除旧键；进游戏前的 Y/X/A/B/L/R/+ 不受影响':
      '⚠ Applies to all games; rebinding releases the old button; menu keys Y/X/A/B/L/R/+ are unaffected',

    // MIDP 目标键名（来自 host/switch-input.js 的 MIDP_TARGETS.label）
    '确认(FIRE)': 'Fire (OK)',
    '左软键': 'Soft left',
    '右软键': 'Soft right',
    '方向-上': 'Up',
    '方向-下': 'Down',
    '方向-左': 'Left',
    '方向-右': 'Right',
    '数字 0': 'Num 0',
    '数字 1': 'Num 1',
    '数字 2': 'Num 2',
    '数字 3': 'Num 3',
    '数字 4': 'Num 4',
    '数字 5': 'Num 5',
    '数字 6': 'Num 6',
    '数字 7': 'Num 7',
    '数字 8': 'Num 8',
    '数字 9': 'Num 9',
    '* 键': '* key',
    '# 键': '# key',
    '清除键': 'Clear key',

    // 物理键名（同上的 SW_BUTTONS.label）
    '物理A': 'A button',
    '物理B': 'B button',
    '物理X': 'X button',
    '物理Y': 'Y button',
    'L 肩键': 'L bumper',
    'R 肩键': 'R bumper',
    '- 键': '- button',
    'L3 摇杆按': 'L3 (stick)',
    'R3 摇杆按': 'R3 (stick)',
    '十字上': 'D-pad up',
    '十字下': 'D-pad down',
    '十字左': 'D-pad left',
    '十字右': 'D-pad right',

    // ---- 按键机型面板 ----
    '只影响发给游戏的软键键值（数字/方向/确认是 MIDP 统一值，不受影响）':
      'Only the soft-key codes sent to the game change (digits / d-pad / fire are standard MIDP)',
    '本游戏：{1}': 'This game: {1}',
    '(未选中)': '(none selected)',
    '左{1} / 右{2} / 确定{3} / 清除{4}': 'L{1} / R{2} / Fire{3} / Clear{4}',
    '数字 {1}': 'Digits {1}',
    '没有选中的游戏': 'No game selected',
    '已设为「{1}」—— 只对这个游戏生效': 'Set to "{1}" — this game only',
    '诺基亚竖屏（N86 软-6/-7 确认-5）': 'Nokia portrait (N86: soft -6/-7, fire -5)',
    '诺基亚横屏（E52/E63）': 'Nokia landscape (E52/E63)',
    '摩托罗拉（左-21 右-22 OK-20）': 'Motorola (left -21, right -22, OK -20)',
    'A 确认   B 返回   ↑↓ 选择   诺基亚=默认（-6/-7）':
      'A OK   B Back   ↑↓ Select   Nokia = default (-6/-7)',

    // ---- 通用底部提示 ----
    'A 确认   B 返回': 'A OK   B Back',
    'A 确认   B 返回   ↑↓ 选择': 'A OK   B Back   ↑↓ Select',

    // ---- 改名横幅 ----
    '正在改名': 'Renaming',
    '原名：{1}': 'Old name: {1}',
    '在这里输入新名字…': 'Type a new name here…',
    '按 确定 保存（整体替换原名）/ B 取消':
      'Press OK to save (replaces the old name) / B to cancel',

    // ---- 删除确认 ----
    '确认删除游戏？': 'Delete this game?',
    '取消': 'Cancel',
    '确认删除': 'Delete',
    '⚠ 将从 SD 卡永久删除 jar 文件，此操作不可恢复！':
      '⚠ The jar file is permanently deleted from the SD card!',
    '删除失败: {1}': 'Delete failed: {1}',

    // ---- 内置文字键盘覆盖层 ----
    '确定': 'OK',
    '关闭': 'Close',
    '←退格': '←Del',
    '空格': 'Space',
    '已输入：{1}': 'Input: {1}',

    // ---- 错误页 / 游戏内横幅 ----
    '详细日志: {1}': 'Log file: {1}',
    '没有找到游戏': 'No games found',
    'SD 卡 java 文件夹是空的。': 'The java folder on the SD card is empty.',
    '请把游戏 .jar 放进 sdmc:/switch/java 后重新启动本软件。':
      'Put your game .jar files into sdmc:/switch/java, then restart this app.',
    '游戏异常退出': 'Game crashed',
    '即将自动返回游戏菜单 ...': 'Returning to the game menu ...',
    '运行时错误（{1}）': 'Runtime error ({1})',
    '内存不足，无法进入游戏': 'Not enough memory to start',
    '开机时运行时只拿到 {1}MB 堆（正常应拿到 800MB）。':
      'The runtime only got {1}MB of heap at boot (800MB expected).',
    '请退出本软件后重新启动，连续打不开时：':
      'Please exit and start the app again. If it keeps failing:',
    '回到 HOME 主菜单等几秒再进（实测连开 2~3 次必成功），':
      'go back to the HOME menu, wait a few seconds, then retry (2-3 tries usually work),',
    '或重启机器再试。': 'or reboot the console and try again.',
    '启动失败，即将自动重试': 'Boot failed, retrying',
    '第 {1}/2 次重试，3 秒后返回游戏菜单 ...':
      'Retry {1}/2 — returning to the game menu in 3s ...',
    'j2me-nx-port 启动失败': 'j2me-nx-port failed to start',
    '正在返回游戏菜单 ...': 'Returning to the game menu ...',

    // ---- 语言弹窗（ZR+ZL）----
    // ⚠ 弹窗自己的标题/选项/底部提示**不进字典**：它们必须是双语常显的
    //（main.js 的 TB(zh, en) 字面量）—— 英文用户当前的设置很可能是中文，
    //  而"看不懂中文"正是他进来改语言的原因（2026-09-24 用户实测反馈第一条）。
    // 这里只留"切换结果"提示条（它可以用新语言说，因为切完就已经是新语言了）。
    '已切换为英文（已写入 lang.json）': 'Switched to English (saved to lang.json)',
    '已切换为中文（已写入 lang.json）': 'Switched to Chinese (saved to lang.json)',
    '已切换为英文（⚠ 写盘失败，本次有效）': 'Switched to English (⚠ save failed, this session only)',
    '已切换为中文（⚠ 写盘失败，本次有效）': 'Switched to Chinese (⚠ save failed, this session only)',
  };

  var MEMO = Object.create(null);   // 英文命中缓存（语言切回中文即弃用）
  var state = { lang: 'zh' };
  // 英文模式下"没查到译文"的串（含汉字才算，且去重、封顶）。
  // 用途（2026-09-24 加入）：实机上英文界面里到底还有哪些地方是中文，**只有玩家看得到**。
  // 让运行时把这些串攒起来，由 main.js 定期落日志 —— 有它下次就能一次点齐，不用靠截图。
  var MISSES = Object.create(null);
  var missList = [];
  var CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

  function norm(lang) {
    var s = String(lang == null ? '' : lang).toLowerCase();
    if (s === 'en' || s === 'en-us' || s === 'english') return 'en';
    return 'zh';
  }

  // {1}..{4} 占位符替换（两种语言都要走 —— 中文模板里也有占位符）
  function fill(tpl, args) {
    if (!args.length) return tpl;
    return String(tpl).replace(/\{(\d)\}/g, function (m, d) {
      var i = +d - 1;
      if (i < 0 || i >= args.length) return m;
      return args[i] == null ? '' : String(args[i]);
    });
  }

  function t(s, a1, a2, a3, a4) {
    var key = (s == null) ? '' : String(s);
    var args = [a1, a2, a3, a4];
    if (state.lang !== 'en') return fill(key, args);
    var hit = MEMO[key];
    if (hit === undefined) {
      hit = Object.prototype.hasOwnProperty.call(DICT, key) ? DICT[key] : key;
      MEMO[key] = hit;
      // 未命中 + 原文含汉字 = 一句没翻译的屏显文案（字典漏条 / 玩家自定的名字）
      if (hit === key && CJK_RE.test(key) && missList.length < 40 && !MISSES[key]) {
        MISSES[key] = 1;
        missList.push(key);
      }
    }
    return fill(hit, args);
  }

  function set(lang, silent) {
    var next = norm(lang);
    var changed = (next !== state.lang);
    state.lang = next;
    // 落盘交给 main.js（这里不做任何 IO —— 保持纯逻辑，Node 单测不需要运行时）。
    // silent = true：开机载入语言时用，避免"读一次就把盘写一次"。
    if (!silent && typeof api.onChange === 'function') {
      try { api.onChange(next); } catch (e) { /* 写盘失败不影响本次切换 */ }
    }
    return changed;
  }

  var api = {
    t: t,
    set: set,
    has: function (key) { return Object.prototype.hasOwnProperty.call(DICT, key); },
    DICT: DICT,
    onChange: null,
    // 取走（并清空）"英文界面下没翻译的串"。main.js 定期落日志用。
    takeMisses: function () {
      var out = missList.slice(0);
      missList.length = 0;
      for (var i = 0; i < out.length; i++) delete MISSES[out[i]];
      return out;
    },
    missCount: function () { return missList.length; },
  };
  Object.defineProperty(api, 'lang', {
    get: function () { return state.lang; },
    enumerable: true,
  });

  g.__uiLang = api;
  // 短别名：宿主脚本（main.js 之外的）想在提示里用也可以直接调
  if (typeof g.__T !== 'function') g.__T = t;
})();
