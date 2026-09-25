/**
 * 计划与项目记忆的磁盘持久化。
 *
 * 为什么必须有这个文件：模型的上下文会被压缩（见 context.js），而压缩必然要
 * 丢掉一些东西。把「当前计划」「任务清单」「项目约定」放在**磁盘上、每轮重新
 * 拼进系统提示词**，它们就不参与压缩、也不会因为重启而消失 —— 这是让 Agent
 * 能跨过上下文上限、把一个项目做完的关键：忘掉的是过程，记住的是结论和计划。
 *
 * 落盘位置（都在用户自己的工作目录下，不污染 App 安装目录）：
 *   .yucode/rules.md    项目全局规则：用户/模型定下的硬约束，每一步执行前都重读一遍
 *   .yucode/plan.md     当前的实施计划（由 write_plan 工具维护）
 *   .yucode/todos.json  任务清单（由 todo_write 工具维护）
 *   .yucode/memory.md   长期记忆：这个项目里踩过的坑与定下来的约定（由 remember 工具维护）
 *   AGENTS.md           项目约定，用户手写，只读不改（沿用 Codex/社区的通用约定）
 */

const fs = require('fs')
const path = require('path')

const DIR_NAME = '.yucode'
const RULES_FILE = 'rules.md'
const PLAN_FILE = 'plan.md'
const TODOS_FILE = 'todos.json'
const MEMORY_FILE = 'memory.md'
const AGENTS_FILE = 'AGENTS.md'

/** 注入提示词时的上限：计划再长也不能把系统提示词撑爆 */
const MAX_PLAN_CHARS = 6000
const MAX_TODOS = 30
const MAX_AGENTS_CHARS = 4000
const MAX_MEMORY_CHARS = 3000
/** 规则是「每一步都读的短约束」，本身就要求简短，超了直接截断 */
const MAX_RULES_CHARS = 4000

function dirPath(projectDir) {
  return path.join(projectDir, DIR_NAME)
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return '' // 文件不存在、没权限、是目录……一律当空
  }
}

/** 写文件：先建目录，再走临时文件改名，避免写一半被读到 */
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf-8')
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------- 项目全局规则

function rulesPath(projectDir) {
  return path.join(dirPath(projectDir), RULES_FILE)
}

/** 读规则。这份内容每一步执行前都会重新注入提示词，所以每次都是现读的 */
function readRules(projectDir) {
  const raw = readText(rulesPath(projectDir)).trim()
  if (raw.length <= MAX_RULES_CHARS) return raw
  // 规则本是短约束，真写超了要说一声，否则被截掉的部分会悄无声息地失效
  return `${raw.slice(0, MAX_RULES_CHARS)}\n…（规则过长已截断，完整内容见 .yucode/rules.md）`
}

/** 覆盖写入规则。传空字符串等于清空 */
function writeRules(projectDir, text) {
  const body = String(text || '').trim()
  const file = rulesPath(projectDir)
  if (!body) {
    try { fs.unlinkSync(file) } catch { /* 本来就没有 */ }
    return ''
  }
  writeText(file, `${body}\n`)
  return body
}

// ---------------------------------------------------------------- 计划

function planPath(projectDir) {
  return path.join(dirPath(projectDir), PLAN_FILE)
}

function readPlan(projectDir) {
  return readText(planPath(projectDir)).trim()
}

/** 覆盖写入计划。传空字符串等于清空 */
function writePlan(projectDir, text) {
  const body = String(text || '').trim()
  const file = planPath(projectDir)
  if (!body) {
    try { fs.unlinkSync(file) } catch { /* 本来就没有 */ }
    return ''
  }
  writeText(file, `${body}\n`)
  return body
}

// ---------------------------------------------------------------- 任务清单

function todosPath(projectDir) {
  return path.join(dirPath(projectDir), TODOS_FILE)
}

/** 读回上次的任务清单。文件损坏时返回空数组，不抛异常打断任务 */
function readTodos(projectDir) {
  try {
    const raw = JSON.parse(readText(todosPath(projectDir)))
    if (!Array.isArray(raw)) return []
    return raw
      .filter((t) => t && typeof t.content === 'string' && t.content.trim())
      .slice(0, MAX_TODOS)
  } catch {
    return []
  }
}

function writeTodos(projectDir, todos) {
  const list = Array.isArray(todos) ? todos.slice(0, MAX_TODOS) : []
  if (list.length === 0) {
    try { fs.unlinkSync(todosPath(projectDir)) } catch { /* 本来就没有 */ }
    return
  }
  writeText(todosPath(projectDir), `${JSON.stringify(list, null, 2)}\n`)
}

// ---------------------------------------------------------------- 长期记忆

function memoryPath(projectDir) {
  return path.join(dirPath(projectDir), MEMORY_FILE)
}

function readMemory(projectDir) {
  return readText(memoryPath(projectDir)).trim()
}

/**
 * 追加一条记忆。旧的先留着（记忆是累积的），只在超过上限时按条裁剪最旧的部分。
 * @returns 追加后的全文，方便调用方回报给模型
 */
function appendMemory(projectDir, text) {
  const body = String(text || '').trim()
  if (!body) return readMemory(projectDir)

  const file = memoryPath(projectDir)
  const stamp = new Date().toISOString().slice(0, 10)
  // 一条记忆固定占一行：多行会把这个文件变成一锅粥，也不利于按条裁剪
  const entry = `- （${stamp}）${body.replace(/\n+/g, ' ')}`
  const old = readText(file).trim()
  let next = old ? `${old}\n${entry}` : `# 项目记忆\n${entry}`

  if (next.length > MAX_MEMORY_CHARS) {
    const lines = next.split('\n')
    const head = lines[0] && lines[0].startsWith('#') ? [lines[0]] : []
    const kept = lines.filter((l) => l.trim().startsWith('- '))
    // 删最旧的条目，直到塞得下；最新的那条永远保留
    while (kept.length > 1 && `${[...head, ...kept].join('\n')}`.length > MAX_MEMORY_CHARS) kept.shift()
    next = [...head, ...kept].join('\n')
  }

  writeText(file, `${next}\n`)
  return next
}

// ---------------------------------------------------------------- 项目约定

function readAgents(projectDir) {
  return readText(path.join(projectDir, AGENTS_FILE)).trim().slice(0, MAX_AGENTS_CHARS)
}

// ---------------------------------------------------------------- 供提示词使用

/** 有没有值得注入的内容（没有就别在提示词里占地方） */
function hasContent(projectDir) {
  return Boolean(readRules(projectDir) || readPlan(projectDir) || readAgents(projectDir) || readMemory(projectDir))
}

/** 计划 + 项目约定的文本块，由 prompt.js 拼进系统提示词 */
function contextBlock(projectDir) {
  const parts = []

  // 规则排最前：它是这个项目的硬约束，优先级高于计划与记忆
  const rules = readRules(projectDir)
  if (rules) {
    parts.push(`【项目全局规则（.yucode/rules.md，用户定下的硬约束，每一步都必须遵守；与当次需求冲突时先说明再照做）】\n${rules}`)
  }

  const agents = readAgents(projectDir)
  if (agents) {
    parts.push(`【项目约定（AGENTS.md，用户写的，必须遵守）】\n${agents}`)
  }

  // 长期记忆排在计划前面：它是跨会话攒下来的结论，方向性比当前计划更强
  const memory = readMemory(projectDir)
  if (memory) {
    const clipped = memory.length > MAX_MEMORY_CHARS
      ? `${memory.slice(0, MAX_MEMORY_CHARS)}\n…（记忆过长已截断，完整内容见 .yucode/memory.md）`
      : memory
    parts.push(`【项目长期记忆（.yucode/memory.md，跨会话累积，直接当作已知事实）】\n${clipped}`)
  }

  const plan = readPlan(projectDir)
  if (plan) {
    const clipped = plan.length > MAX_PLAN_CHARS
      ? `${plan.slice(0, MAX_PLAN_CHARS)}\n…（计划过长已截断，请用 read_plan 看全文）`
      : plan
    parts.push(`【当前实施计划（.yucode/plan.md）】\n${clipped}`)
  }

  const todos = readTodos(projectDir)
  if (todos.length > 0) {
    const done = todos.filter((t) => t.status === 'completed').length
    const body = todos
      .map((t) => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'} ${t.content}`)
      .join('\n')
    parts.push(`【任务清单（${done}/${todos.length} 完成）】\n${body}`)
  }

  return parts.join('\n\n')
}

module.exports = {
  DIR_NAME,
  rulesPath,
  readRules,
  writeRules,
  planPath,
  readPlan,
  writePlan,
  readTodos,
  writeTodos,
  memoryPath,
  readMemory,
  appendMemory,
  readAgents,
  hasContent,
  contextBlock,
}
