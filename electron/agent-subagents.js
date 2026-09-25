/**
 * 子代理的派发逻辑（对应 Pi 的 pi-subagents 扩展）。
 *
 * 相比最早的版本，这里补齐了 pi-subagents 的三件事：
 *   1. 并行：同一轮里发多个 task 会同时跑，而不是一个个排队
 *   2. 后台：background: true 立刻返回，跑完再把结论塞回主上下文
 *   3. 可写角色：general 子代理能改文件、跑命令（护栏和检查点照旧生效）
 *
 * 放在单独文件里是因为 agent.js 要守 500 行；这里只依赖 agent 实例暴露的
 * callModel / sendStatus / projectDir / confirmRisk 等接口，不碰别的状态。
 */

const { runSubagent } = require('./subagent')
const { READ_TOOLS, WRITE_TOOLS } = require('./tool-schemas')
const { TOOL_IMPL } = require('./agent-tools')

const ROLE_SPECS = {
  // 只读角色：读、搜、联网，改不了东西
  explore: { tools: READ_TOOLS, maxSteps: 12, state: 'searching', label: '调研' },
  review: { tools: READ_TOOLS, maxSteps: 12, state: 'searching', label: '审查' },
  // 可写角色：工具集是全量减去派子代理/提问/上下文管理那几件
  general: { tools: WRITE_TOOLS, maxSteps: 30, state: 'executing', label: '执行' },
}

function normalizeRole(value) {
  const role = String(value || '').trim()
  return ROLE_SPECS[role] ? role : 'explore'
}

/** 子代理能用的工具：只有读角色的 ctx 是空的，写角色要带上差异推送与护栏 */
function executeSubTool(agent, role, name, args) {
  const impl = TOOL_IMPL[name]
  if (!impl) return `子代理不允许使用工具: ${name}`
  const ctx = role === 'general'
    ? {
        projectDir: agent.projectDir,
        sendDiff: (payload) => agent.sendDiff(payload),
        confirmRisk: (blocked, payload) => agent.confirmRisk(blocked, payload),
        diagnostics: (fullPath) => agent.runDiagnostics(fullPath),
      }
    : { projectDir: agent.projectDir }
  return impl(ctx, args)
}

/** 跑一次子代理，返回结论文本 */
async function runOne(agent, { role, prompt, description }) {
  const spec = ROLE_SPECS[role]
  const name = description || spec.label
  const text = await runSubagent({
    role,
    prompt,
    tools: spec.tools,
    maxSteps: spec.maxSteps,
    onStep: (step) => agent.sendStatus({ state: spec.state, detail: `${name}（子代理·第 ${step} 轮）` }),
    // 子代理复用同一个模型配置，但消息数组完全是它自己的
    callModel: (messages, tools) => agent.callModel(() => {}, { messages, tools }),
    executeTool: (toolName, args) => executeSubTool(agent, role, toolName, args),
  })
  return text.text
}

/** 派发一个后台子代理：立刻返回，跑完把结论排进队列等主循环取走 */
function spawnBackground(agent, args) {
  const role = normalizeRole(args.subagent_type)
  const description = String(args.description || '').slice(0, 40) || ROLE_SPECS[role].label
  const id = `bg${++agent.bgSeq}`
  const startedAt = Date.now()
  agent.bgTasks.set(id, { id, role, description, state: 'running', startedAt })
  agent.sendStatus({ state: ROLE_SPECS[role].state, detail: `后台子代理「${description}」已派发` })

  const finish = (text, failed) => {
    const task = agent.bgTasks.get(id) || { id, role, description }
    agent.bgTasks.set(id, { ...task, state: failed ? 'failed' : 'done', elapsedMs: Date.now() - startedAt })
    agent.pendingBgNotices.push({
      id,
      role,
      description,
      text: failed ? `后台子代理执行失败：${text}` : text,
    })
    agent.sendStatus({
      state: 'thinking',
      detail: `后台子代理「${description}」${failed ? '失败' : '已完成'}，结论会在下一轮进入上下文`,
    })
  }

  runOne(agent, { role, prompt: args.prompt, description })
    .then((text) => finish(text, false))
    .catch((e) => finish(e?.message || String(e), true))

  return `已在后台派发子代理「${description}」（${id}，${role}）。你继续做手头的事，` +
    `它的结论会在下一轮自动出现在你的上下文里，不需要你来轮询。`
}

/** 主循环在安全的时机（工具结果都落完之后）调用，把后台结论并进上下文 */
function flushBackgroundNotices(agent) {
  const list = agent.pendingBgNotices || []
  if (list.length === 0) return
  agent.pendingBgNotices = []
  for (const n of list) {
    agent.pushContext({
      role: 'user',
      content: `【后台子代理「${n.description}」${n.id} 已完成】\n${n.text}`,
    })
  }
}

/** 单个 task 调用 */
function runTask(agent, args) {
  const role = normalizeRole(args?.subagent_type)
  const prompt = String(args?.prompt || '').trim()
  if (!prompt) return 'task 需要提供 prompt'
  if (agent.aborted) return '(任务已中断，跳过子代理)'
  if (agent.planMode && role === 'general') {
    return '已拦截：计划模式下子代理不能改文件。请用 explore / review 角色调研，方案用 exit_plan_mode 交给用户。'
  }
  if (args?.background) return spawnBackground(agent, args)
  return runOne(agent, { role, prompt, description: args?.description })
}

/**
 * 一轮里同时发了多个 task：并行跑。
 * 这些活本来就是互相独立的，串着跑会让长任务慢好几倍。
 */
async function runTaskBatch(agent, calls) {
  return Promise.all(
    calls.map(async (call) => {
      const args = call.args || {}
      if (agent.planMode && normalizeRole(args.subagent_type) === 'general') {
        return '已拦截：计划模式下子代理不能改文件。'
      }
      return runOne(agent, {
        role: normalizeRole(args.subagent_type),
        prompt: String(args.prompt || '').trim(),
        description: args.description,
      })
    }),
  )
}

module.exports = { runTask, runTaskBatch, flushBackgroundNotices, ROLE_SPECS }
