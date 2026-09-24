/*
 * PATCH(j2me-nx-port): 纯 JS Relooper 替代品。
 *
 * 上游 Relooper 是 emscripten 编译产物（_rl_* natives + Module 运行时），本仓库
 * 没有该产物——这也是移植初期把 JIT 整体关掉的原因（README"JIT 关闭"）。
 * 这里不做形状分析（shape analysis），直接以"基本块 switch 派发"实现同面 glue API：
 *   - render(entry) 输出 var __rl_pc=<entry>; __rl:while(true){switch(__rl_pc){...}}
 *   - 每个基本块一个 case；块代码以 "@"<blockID> 标记行内联（baseline.ts 后处理
 *     会把该行替换为真实块体）；
 *   - 普通条件分支 → if(cond){__rl_pc=to;continue __rl;}；无条件分支 → default 尾跳；
 *   - tableswitch/lookupswitch 的 branchVar 块（"case N:" 条件）→ 内层 switch；
 *   - 异常处理器回派发（catch 里 pc=handler_bci; continue; 回外层 while(1) 重新
 *     进入本脚手架）依赖入口派发块按 pc===startBci 分发，与上游语义一致。
 * 生成代码没有逐字节码派发，V8 将 switch 编译为跳转表，性能远高于解释器；
 * 正确性由 tools/relooper_test.mjs（CFG 一致性 + 随机拓扑属性测试）与
 * tools/test-i18n.mjs / tools/game-test.mjs Node 冒烟回归验证。
 *
 * 2026-09-22 修复（lab 版）：
 *   ① 无出口块原来发 continue __rl —— __rl_pc 未变 → 同一 case 反复进入 = 空转死循环，
 *      真机表现为主线程卡死。改为 break __rl（掉出脚手架，语义同上游 Relooper）。
 *   ② branchVar 内层 switch 缺 default 时同样会空转 → 补 default:break __rl。
 *   ③ 内层 switch 的键改为 verbatim 复用 "case N:" 原文，去掉 parseInt 解析。
 */
var Relooper = (function () {
  var blocks: any = null;
  var blockCount: number = 0;

  function RLBlock(id: number) {
    this.id = id;
    this.text = "";
    this.branchVar = null;
    this.branches = [];
  }

  return {
    init: function () {
      blocks = {};
      blockCount = 0;
    },
    cleanup: function () {
      blocks = null;
    },
    addBlock: function (text?: string, branchVar?: string): number {
      var b = new RLBlock(blockCount++);
      b.text = text || "";
      b.branchVar = branchVar || null;
      blocks[b.id] = b;
      return b.id;
    },
    setBlockCode: function (block: number, text: string) {
      blocks[block].text = text;
    },
    addBranch: function (from: number, to: number, condition?: string, code?: string) {
      blocks[from].branches.push({ to: to, condition: condition || null, code: code || null });
    },
    setDebug: function () { /* no-op */ },
    setAsmJSMode: function (on: any) { /* no-op：无 asm.js 约束 */ },
    render: function (entry: number): string {
      var lines: string [] = [];
      lines.push("var __rl_pc=" + entry + ";");
      lines.push("__rl:while(true){");
      lines.push("switch(__rl_pc){");
      for (var id = 0; id < blockCount; id++) {
        var b: any = blocks[id];
        lines.push("case " + id + ":");
        if (b.text) {
          lines.push(b.text);
        }
        var cases: any [] = [], plain: any [] = [], dflt: any = null;
        for (var i = 0; i < b.branches.length; i++) {
          var br: any = b.branches[i];
          if (!br.condition) {
            if (!dflt) dflt = br;
          } else if (b.branchVar && br.condition.indexOf("case ") === 0) {
            cases.push(br);
          } else {
            plain.push(br);
          }
        }
        for (var i = 0; i < plain.length; i++) {
          var p: any = plain[i];
          var pre: string = p.code ? p.code + ";" : "";
          lines.push("if(" + p.condition + "){" + pre + "__rl_pc=" + p.to + ";continue __rl;}");
        }
        if (cases.length) {
          lines.push("switch(" + b.branchVar + "){");
          for (var i = 0; i < cases.length; i++) {
            var c: any = cases[i];
            // 直接复用 "case N:" 原文（原来 parseInt(substring(5)) 遇到 "case -1:" 之外的
            // 写法或带注释的键会解析错，这里保持 verbatim）
            lines.push(c.condition + "__rl_pc=" + c.to + ";continue __rl;");
          }
          // FIX(2026-09-22): 无 default 分支时也必须给出路——原来内层 switch 落空后
          // 紧跟 continue __rl，__rl_pc 没变，会用同一个值重新进 switch 空转到死。
          lines.push("default:" + (dflt ? "__rl_pc=" + dflt.to + ";continue __rl;" : "break __rl;"));
          lines.push("}");
        } else if (dflt) {
          lines.push("__rl_pc=" + dflt.to + ";continue __rl;");
        } else {
          // FIX(2026-09-22): 无出口块（return/throw 终结块，或 sp<0 的死块）。
          // 原来写 continue __rl —— 同一个 __rl_pc 重新进 switch = 空转死循环
          // （真机上是主线程 CPU 100% 卡死）。语义对齐上游 Relooper：块没有出边就
          // 掉出脚手架，由 baseline 的收尾断言/隐式返回接管。
          lines.push("break __rl;");
        }
      }
      lines.push("}");
      lines.push("break __rl;");
      lines.push("}");
      return lines.join("\n");
    }
  };
})();
