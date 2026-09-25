/**
 * 内置能力清单。
 *
 * 用来如实告诉用户「哪些能力已经原生生效、不需要装 Pi 扩展」——这些能力全部
 * 实现在自研 Agent 里，打包即带走、开箱即用，不依赖 pi CLI。
 * 设置页据此展示，避免用户以为「扩展没装 = 没这能力」。
 */
const guard = require('./guard')

const ITEMS = [
  { id: 'guard-command', name: '命令护栏', description: '拦截递归删除、格式化磁盘、强推远端、git reset --hard 等不可逆命令' },
  { id: 'guard-write', name: '写入护栏', description: '拦截对 .git / node_modules 以及工作目录之外的写入' },
  { id: 'guard-secret', name: '凭据保护', description: '读写 .env / 私钥 / .npmrc / *.pem 等敏感文件要先经用户确认；文件检索直接跳过它们，避免密钥进上下文' },
  { id: 'checkpoint', name: '改动检查点', description: '动手前自动在 git 仓库里留快照，改坏了可整体回退' },
  { id: 'subagent', name: '子代理（并行 / 后台 / 可写）', description: 'task 工具：explore 调研 / review 审查 / general 执行三种角色；同一轮发多个 task 会并行跑；background 后台跑完自动把结论送回上下文' },
  { id: 'context-blocks', name: '分层上下文压缩', description: 'compress 把一段对话压成摘要块（T1→T2→T3 逐层蒸馏），原文存档；search_context 检索、decompress 取回原文' },
  { id: 'plan-mode', name: '计划模式', description: '只读规划，不改任何文件，先出方案再动手' },
  { id: 'ask-user', name: '需求澄清', description: '需求有无法自行判断的分歧时，停下来问用户' },
  { id: 'web', name: '联网搜索 / 抓取', description: 'web_search + web_fetch，查最新文档、版本与报错' },
  { id: 'skills', name: 'Skill 注入', description: '把已安装 Skill 的说明注入系统提示词，真实改变 Agent 行为' },
  { id: 'diff', name: '改动可视', description: '每次改文件都回传 unified diff，改了什么一眼可见' },
  { id: 'mcp', name: 'MCP 工具接入', description: '自研 MCP 客户端：外部 server 的工具直接注册给模型，内置 Git server 开箱即用' },
  { id: 'diagnostics', name: '诊断回灌', description: '改完文件自动跑类型/语法检查，把错误附在工具结果里，Agent 能立刻接着修' },
  { id: 'format', name: '格式化', description: 'format_file 只调工程自己装的 prettier / ruff / black，用工程自己的配置整理排版；工程没装就如实说没有' },
  { id: 'todo', name: '任务清单', description: '多步任务先用 todo_write 拆开并逐步更新状态，界面实时显示进度' },
  { id: 'rules', name: '项目全局规则', description: 'write_rules 把项目的硬约束写进 .yucode/rules.md，每一步执行前都重新注入提示词，跨会话有效' },
  { id: 'plan-store', name: '持久计划', description: 'write_plan 把计划写到 .yucode/plan.md，每轮重新注入提示词，不被上下文压缩丢掉、重启也不丢' },
  { id: 'memory', name: '长期记忆', description: 'remember 把结论写进 .yucode/memory.md，跨会话累积并每轮注入' },
  { id: 'simplify', name: '简化审查', description: '用只读的 review 子代理审查最近的改动，专挑冗余、重复与过度设计，只报不改' },
]

/** @param agent 可选，用来带上运行时的计划模式 / 检查点状态 */
function list(agent) {
  return {
    planMode: Boolean(agent?.planMode),
    checkpoint: agent?.checkpoint || null,
    guard: guard.describe(),
    items: ITEMS.map((it) => ({ ...it, source: '内置' })),
  }
}

/**
 * 注入系统提示词的内置能力说明。
 * 说清楚是为了让模型正确使用、而不是去猜「我到底有没有这个能力」。
 */
function prompt(planMode) {
  const lines = [
    '内置能力（已生效，不需要安装任何扩展）：',
    '- 安全护栏：不能写入 .git / node_modules，也不能写出工作目录之外；递归删除、格式化磁盘、强推远端、git reset --hard 这类不可逆命令会被直接拦下并说明原因。.env、私钥、.npmrc、*.pem 这类凭据文件的读写也会先问过用户，检索时会自动跳过它们。遇到拦截不要换写法绕过去，如实告诉用户。',
    '- 改动检查点：每次任务开始前，系统会在 git 仓库里自动留一个快照。改坏了可以用 list_checkpoints 查看、用 restore_checkpoint 回退。',
    '- 子代理（task）：把「要翻很多文件/搜很多轮才能得出结论」的活外包出去，它只把结论交回来，不占用我们的上下文。三种角色：explore（只读调研，默认）、review（专挑 bug 与风险，给 file:line）、general（可改文件、跑命令，适合独立成块的小改动）。',
    '- 并行子代理：同一轮里发多个 task 调用，它们会**同时**开始跑（本来互不依赖的活别串着等）。需要先干别的、稍后再看结论时用 background: true，它会立刻返回并在跑完后自动把结论送进你的上下文，不需要轮询。',
    '- 上下文管理：对话里每条消息都有形如 [m00012] 的引用。一段过程做完、结论已经明确后，用 compress({ from, to, title, summary }) 把它压成一个摘要块 —— 原文会存档，之后随时能用 decompress 取回、或 search_context 按关键词检索。压的是「过程」，summary 里必须写清改过的路径、关键决策、错误原文与结论。同一段内容反复被压会自动蒸馏成 T2、T3。拿不准该不该压时先用 context_status 看占用和可压区间。',
    '- 项目全局规则：.yucode/rules.md 里的硬约束每一步都会重新注入给你，跨会话、跨任务一直有效。用户说定「以后都这样」「这个项目不许用 X」「记住这个约定」这类长期约束时，用 write_rules 整份写入（每次提交完整内容，只改一条也要带上其余原有内容）。它和 write_plan 的分工：规则管长期约束，计划管当前任务怎么做。',
    '- 持久计划：write_plan 把当前计划写到磁盘（.yucode/plan.md），之后每一轮都会重新出现在你的提示词里，不会被上下文压缩丢掉。写多文件的改动用它记「怎么做」；read_plan 看全文。',
    '- 长期记忆：这个项目的长期结论存在 .yucode/memory.md，每轮都会重新注入给你，跨会话有效。踩到非显然的坑、或用户明确了某个约定之后，用 remember 记一条（一次一条，带路径和原因）；别把当前任务的临时进度记进去。',
  ]
  if (planMode) {
    lines.push(
      '- 【当前为计划模式（只读）】你不能改任何文件。调研是允许的：read_file / search_files / list_directory 照常用，execute_command 也能用，但**只能执行只读命令**（git status、git diff、git log、cat、grep、ls 等），改文件或改状态的命令会被拦下。',
      '- 调研清楚后调用 exit_plan_mode 提交完整计划（目标、要改哪些文件、怎么改、为什么、有什么风险）。界面会把计划展示给用户请他批准：批准后自动退出计划模式，你就可以动手；被否决则按用户意见改好再提交一次。',
      '- 不要在没有调研、没读代码的情况下就提交计划；也不要只是把计划写在回复里而不调用 exit_plan_mode，那样用户无法交接。',
    )
  }
  return `${lines.join('\n')}\n`
}

module.exports = { list, prompt, ITEMS }
