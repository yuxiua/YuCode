/**
 * 项目全局规则（.yucode/rules.md）—— 补上 pi 缺失的「把项目硬约束记住并每次都遵守」。
 *
 * 为什么需要它：
 * pi 的 --append-system-prompt 只在进程启动时生效一次，而项目的硬约束是用户随时
 * 可能改的短文本（技术栈、目录约定、禁止的写法、必须走的流程）。更关键的是：
 * 模型没有一个明确的工具把「用户刚说定的规矩」落到磁盘上，它只能在回复里口头答应，
 * 下次会话就忘了 —— 这和 write_plan / remember 是同一类缺口。
 *
 * 本扩展只补一个工具：write_rules，把规则整份写进项目的 .yucode/rules.md。
 * 「每一步执行前都读一遍」由应用侧完成：electron/agent-pi.js 每次要启动参数时
 * 都重新读这个文件并拼进 --append-system-prompt，规则一变就带着同一个 session-id
 * 重启会话，规则当场生效（历史由 pi 自己续上）。
 *
 * 由应用写进 ~/.pi/agent/extensions/ 后随 pi 启动自动加载（见 electron/pi-custom-extensions.js）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DIR_NAME = ".yucode";
const RULES_FILE = "rules.md";

function ok(text: string) {
  return { content: [{ type: "text", text }], details: undefined };
}

function rulesPath(cwd: string): string {
  return path.join(cwd, DIR_NAME, RULES_FILE);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "write_rules",
    label: "写项目规则",
    description:
      "把项目的「全局规则」整份写进 .yucode/rules.md。这份规则会在每一次执行前重新注入你的提示词，" +
      "跨会话、跨任务一直有效 —— 用来记用户定下的硬约束：技术栈与版本、目录/命名约定、" +
      "禁止的写法与库、必须走的流程（比如「单文件不超过 500 行」「不要用原生弹窗」）。\n" +
      "和 write_plan 的分工：规则管长期约束（不管当前任务做到哪），计划管当前任务怎么做。\n" +
      "传空字符串清空全部规则。",
    promptSnippet: "把用户定下的项目全局规则写进 .yucode/rules.md（每步都会重新注入）",
    promptGuidelines: [
      "用户说「以后都这样」「这个项目不许用 X」「记住这个约定」这类长期约束时，用 write_rules 写进项目规则，不要只在回复里答应。",
      "规则要短：一条一行，写清约束本身和必要的原因；别把当前任务的进度写进去（那是 write_plan / todo_write 的活）。",
      "每次提交完整规则（整份覆盖），只改一条也要带上其余原有内容；不确定原有内容时先读 .yucode/rules.md 再写。",
    ],
    parameters: Type.Object({
      rules: Type.String({
        description: "完整的规则正文（Markdown，建议用短横线列表）。传空字符串清空全部规则。",
      }),
    }),
    async execute(_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const cwd = ctx?.cwd || process.cwd();
      const body = String(params?.rules ?? "").trim();
      const file = rulesPath(cwd);

      try {
        if (!body) {
          try { fs.unlinkSync(file); } catch { /* 本来就没有 */ }
          return ok("项目规则已清空（.yucode/rules.md 已删除）。");
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${body}\n`, "utf-8");
        return ok(
          `项目规则已写入 .yucode/rules.md（${body.length} 字）。` +
            "它会在下一次提问前重新读入并生效，之后每一步都带着它。",
        );
      } catch (e) {
        return ok(`写入项目规则失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });
}
