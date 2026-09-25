/**
 * 上下文容量管理：token 估算、超限自动压缩、占用率统计。
 *
 * 抽成纯函数放在这里，一是让 agent.js 只关心主循环，二是压缩策略要能单独调，
 * 不必每次都去翻整个主循环。
 *
 * 压缩的取舍原则（这决定了 Agent 能不能啃下一个完整项目）：
 *   保住「要做什么」——原始需求、用户每一轮的请求、助手给出的结论与决策；
 *   牺牲「读过什么」——工具结果最占地方，也最容易重新获取，先摘要化、再丢弃。
 * 另外「当前计划 / 任务清单 / 项目约定」由 plan-store 存在磁盘上、每轮重新注入，
 * 根本不参与压缩，所以这里不必为它们操心。
 */

/** 超过输入上限的这个比例就压缩（留出输出与工具结果的余量） */
const COMPACT_RATIO = 0.7

/** 单条工具结果的保留上限，超出就掐头去尾留中间省略 */
const MAX_TOOL_CHARS = 4000

/** 最近这么多轮原样保留，其余轮次的工具结果会被摘要化 */
const KEEP_RECENT_ROUNDS = 3

/** 压缩块消息的抬头（形如 【压缩块 b3｜T2】） */
const BLOCK_RE = /^【压缩块 b\d+｜T\d+】/

/**
 * 估算一段文本的 token 数。
 * 按字符分档：中日韩等全角字符约 1.5 字/token，其余（代码、英文）约 4 字/token。
 * 统一按「字长/3」估会把代码高估近一倍，导致压缩过早触发、平白丢上下文。
 */
function estimateText(text) {
  let wide = 0
  let narrow = 0
  for (const ch of text) {
    if (ch.codePointAt(0) >= 0x2e80) wide++
    else narrow++
  }
  return Math.ceil(wide / 1.5 + narrow / 4)
}

/** 粗略估算消息数组的 token 占用（含 tool_calls 的参数） */
function estimateTokens(messages) {
  let total = 0
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')
    total += estimateText(content) + 4
    if (msg.tool_calls) total += estimateText(JSON.stringify(msg.tool_calls))
  }
  return total
}

/** 掐头去尾：工具结果的开头（是什么）和结尾（报错常在末尾）都留着，中间省略 */
function clipMiddle(text, max) {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head
  const omitted = text.length - max
  return `${text.slice(0, head)}\n...（中间省略 ${omitted} 字）...\n${text.slice(-tail)}`
}

/** 老工具结果摘要化：只留「调了哪个工具、结果大概多长、开头一行」 */
function summarizeToolResult(name, content) {
  const text = String(content || '')
  const firstLine = text.split('\n').find((l) => l.trim()) || ''
  const head = firstLine.replace(/\s+/g, ' ').slice(0, 120)
  return `[${name || 'tool'} 结果已摘要，原文 ${text.length} 字] ${head}`
}

/**
 * 把被丢弃的历史压成一段纯文本摘要，保证模型仍知道之前做过什么。
 * 重点保「需求」和「结论」，工具结果不在这里复述（上面已按名字摘要过）。
 */
function buildDigest(dropped, toolNames) {
  const lines = []
  // 压缩块单独收：它们不是「旧内容」，而是指向 .yucode/context-blocks.json 的索引，
  // 丢掉就等于模型再也想不起自己压过什么，也就永远不会去 decompress 取回细节。
  const blockLines = []
  let firstUserDone = false

  for (const m of dropped) {
    if (m.role === 'user' && typeof m.content === 'string') {
      const text = m.content.replace(/\s+/g, ' ').trim()
      if (!text) continue
      // 第一条用户消息就是原始需求，它决定整个任务的方向，不能只留个开头
      if (!firstUserDone) {
        lines.push(`- 【原始需求】${text.slice(0, 600)}`)
        firstUserDone = true
      } else {
        lines.push(`- 用户曾请求：${text.slice(0, 300)}`)
      }
    } else if (m.role === 'assistant') {
      const calls = (m.tool_calls || []).map((c) => c.function?.name).filter(Boolean)
      // 「改/看 哪些文件」比「调用过哪些工具」信息量大，能列文件就不再列工具名
      const files = (m.tool_calls || [])
        .map((c) => `${toolNames?.get(c.id) === 'write_file' || toolNames?.get(c.id) === 'edit_file' ? '改' : '看'}${filesOf(c.function?.arguments)}`)
        .filter(Boolean)
      if (files.length > 0) lines.push(`- ${[...new Set(files)].join('、')}`)
      // 不带工具调用的助手消息就是它给出的结论/说明，属于要保住的部分
      const text = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').trim() : ''
      if (BLOCK_RE.test(text)) {
        // 摘要本身要留全（含块 id 与标题），否则这个索引就白留了
        blockLines.push(`- 历史压缩块：${text.slice(0, 400)}`)
        continue
      }
      if (text && calls.length === 0) lines.push(`- 曾给出结论：${text.slice(0, 200)}`)
      else if (calls.length > 0 && files.length === 0) lines.push(`- 曾调用工具：${[...new Set(calls)].join('、')}`)
    }
  }

  // 太长就砍：但第一条（原始需求）和压缩块索引必须留下 —— 一个是方向，一个是记忆
  const MAX_DIGEST_LINES = 40
  const head = lines.slice(0, 1)
  const rest = lines.length > MAX_DIGEST_LINES ? lines.slice(-(MAX_DIGEST_LINES - 1)) : lines.slice(1)
  const merged = [...head, ...blockLines, ...rest]
  return merged.length > 0 ? merged.join('\n') : '（早期对话内容已省略）'
}

/** 从工具参数里抠出涉及的文件路径，用于摘要「改过/看过哪些文件」 */
function filesOf(rawArgs) {
  try {
    const args = JSON.parse(rawArgs || '{}')
    const p = args.file_path || args.path || args.directory
    return typeof p === 'string' && p ? p : ''
  } catch {
    return ''
  }
}

/** 只以 user 消息为边界切轮：assistant(tool_calls) 与其后的 tool 结果必须成对 */
function roundStarts(messages) {
  const starts = []
  messages.forEach((m, i) => {
    if (m.role === 'user') starts.push(i)
  })
  return starts
}

/**
 * 压缩到输入上限之内，分三步逐级加重，能用轻的就不用重的：
 *   1. 超长工具结果掐头去尾；
 *   2. 较老轮次的工具结果摘要化（保留调用关系与用户/助手消息，只丢最占地方的原文）；
 *   3. 仍然超限，才丢弃最老的整轮，并把它们的需求与结论压成摘要挂回开头。
 * @returns {{ messages: object[], before: number, after: number }}
 */
function compact(messages, limit) {
  const threshold = Math.floor((limit || 131072) * COMPACT_RATIO)
  const before = estimateTokens(messages)
  if (before <= threshold) return { messages, before, after: before }

  // 浅拷贝：不改动调用方持有的对象
  const result = messages.map((m) => ({ ...m }))

  // tool_call_id → 工具名，后面摘要老结果时用来标明「这是哪个工具的结果」
  const toolNames = new Map()
  for (const m of result) {
    for (const c of m.tool_calls || []) toolNames.set(c.id, c.function?.name)
  }

  // 第一步：单条过长的工具结果掐头去尾
  for (const m of result) {
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > MAX_TOOL_CHARS) {
      m.content = clipMiddle(m.content, MAX_TOOL_CHARS)
    }
  }
  if (estimateTokens(result) <= threshold) {
    return { messages: result, before, after: estimateTokens(result) }
  }

  // 第二步：较老轮次的工具结果摘要化，最近的 KEEP_RECENT_ROUNDS 轮保持原样
  const starts = roundStarts(result)
  if (starts.length > KEEP_RECENT_ROUNDS) {
    const recentFrom = starts[starts.length - KEEP_RECENT_ROUNDS]
    for (let i = 0; i < recentFrom; i++) {
      const m = result[i]
      if (m.role === 'tool' && typeof m.content === 'string') {
        m.content = summarizeToolResult(toolNames.get(m.tool_call_id), m.content)
      }
    }
  }
  if (estimateTokens(result) <= threshold) {
    return { messages: result, before, after: estimateTokens(result) }
  }

  // 第三步：还是超限，才真的丢轮次。从最近的轮开始往前找，留下尽量多的完整轮次
  if (starts.length > 1) {
    let cut = starts[starts.length - 1]
    for (let k = starts.length - 1; k >= 1; k--) {
      if (estimateTokens(result.slice(starts[k])) <= threshold * 0.8) {
        cut = starts[k]
        break
      }
    }
    const digest = buildDigest(result.slice(0, cut), toolNames)
    const kept = result.slice(cut)
    const first = kept[0]
    if (first && first.role === 'user' && typeof first.content === 'string') {
      kept[0] = { ...first, content: `【此前对话已自动压缩】\n${digest}\n\n【当前请求】\n${first.content}` }
    } else {
      kept.unshift({ role: 'user', content: `【此前对话已自动压缩】\n${digest}` })
    }
    return { messages: kept, before, after: estimateTokens(kept) }
  }

  return { messages: result, before, after: estimateTokens(result) }
}

/** 给界面用的上下文占用快照 */
function usage(messages, modelConfig) {
  const currentTokens = estimateTokens(messages)
  const inputLimit = modelConfig.maxInputTokens || 131072
  return {
    currentTokens,
    inputLimit,
    usagePercent: Math.round((currentTokens / inputLimit) * 100),
    contextWindow: modelConfig.contextWindow,
    messageCount: messages.length,
  }
}

module.exports = { estimateText, estimateTokens, buildDigest, compact, usage }
