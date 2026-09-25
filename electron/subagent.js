/**
 * 内置子代理（subagent）。
 *
 * 对应 Pi 生态的 pi-subagents 扩展：主 Agent 可以把一次独立任务派给一个子代理去跑。
 * 子代理有**自己的消息数组**，翻多少文件、看多少网页都只留在它自己的上下文里，
 * 最后只把结论交回主 Agent —— 这正是主上下文最容易爆炸的地方，隔离掉之后长任务才跑得下去。
 *
 * 三种角色（对应 pi-subagents 的 explore / review / general）：
 *   explore  只读调研：搜索、读文件、列目录、联网
 *   review   只读审查：刻意挑 bug、边界、风险，给 file:line
 *   general  可以改文件、跑命令：大改动拆给它做（护栏与检查点仍然生效）
 */

const READ_PROMPT = `你是 Yu Code 的子代理，负责完成主 Agent 派来的一次调研任务。

工作方式：
1. 只在只读工具范围内活动：搜索、读文件、列目录、联网查资料
2. 不要试图修改任何文件（你没有写权限），也不要派发下级子代理
3. 找不到就说找不到，不要编造文件内容或行号
4. 结论要短、要具体：给出文件路径、行号、关键代码片段，以及你的判断
5. 用中文回复，最后直接输出结论本身，不要写「我已完成任务」这类过程性废话`

const REVIEW_PROMPT = `你是 Yu Code 的子代理，负责对指定范围做一次严格的代码审查。

工作方式：
1. 只读：读文件、搜代码、必要时联网查证，不要改任何东西
2. 只报真问题，并且必须能落到具体位置：file:line + 为什么是问题 + 什么情况下会出错
3. 优先挑：边界与空值、错误处理、并发与状态、资源释放、越界与注入、明显的性能坑
4. 不确定的写成「存疑」并说明还需要什么信息，不要为了凑数编问题
5. 不要复述代码本身，不要写客套话；按严重程度从高到低列出，最多 10 条`

const WORKER_PROMPT = `你是 Yu Code 的子代理，负责在主 Agent 指定的范围内把改动实际做出来。

工作方式：
1. 动手前先读清楚要改的文件和它的调用方，别猜
2. 改动用 edit_file / write_file；命令用 execute_command。改动要小而准，不做任务之外的「顺手重构」
3. 不要派发下级子代理，也不要问用户问题 —— 需要用户拍板时，把问题写进结论里交回主 Agent
4. 收尾时报告：改了哪些文件（路径）、每个文件改了什么、有没有没做完的部分、有什么风险
5. 用中文回复，直接给结果，不要写过程性废话`

const PROMPTS = {
  explore: READ_PROMPT,
  review: REVIEW_PROMPT,
  general: WORKER_PROMPT,
}

/**
 * 跑一次子代理。
 *
 * @param role        explore / review / general，决定系统提示词（工具集由调用方给）
 * @param prompt      任务描述（主 Agent 写的）
 * @param tools       允许子代理使用的工具 schema 列表
 * @param callModel   (messages, tools) => Promise<{ content, tool_calls }>
 * @param executeTool (name, args) => Promise<string>
 * @param maxSteps    子代理自己的最大工具轮数
 * @param onStep      每轮开始时的回调（用于把进度透传给界面）
 * @returns {{ text: string, steps: number }} 子代理的结论文本与实际用的轮数
 */
async function runSubagent({ role, prompt, tools, callModel, executeTool, maxSteps = 10, onStep }) {
  const task = String(prompt || '').trim()
  if (!task) return { text: '子代理缺少任务描述', steps: 0 }

  // 子代理自己的上下文，与主对话完全隔离
  const messages = [
    { role: 'system', content: PROMPTS[role] || READ_PROMPT },
    { role: 'user', content: task },
  ]

  for (let step = 1; step <= maxSteps; step++) {
    onStep?.(step)
    const msg = await callModel(messages, tools)
    if (!msg) return { text: '子代理未返回有效响应', steps: step }

    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter((t) => t.function?.name) : []
    if (calls.length === 0) {
      return { text: (msg.content || '').trim() || '（子代理未给出结论）', steps: step }
    }

    messages.push({ role: 'assistant', content: msg.content, tool_calls: calls })

    for (const tc of calls) {
      let args = {}
      try {
        args = JSON.parse(tc.function.arguments || '{}')
      } catch {
        /* 参数不是合法 JSON 时按空对象处理，让工具自己报缺参 */
      }
      const result = await executeTool(tc.function.name, args)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) })
    }
  }

  return {
    text: `（子代理已达最大步数 ${maxSteps}，未能收敛出结论。请缩小任务范围后重试）`,
    steps: maxSteps,
  }
}

module.exports = { runSubagent, SYSTEM_PROMPT: READ_PROMPT, PROMPTS }
