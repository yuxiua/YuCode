/**
 * 上下文压缩工具的实现在这里（schema 在 tool-schemas.js 的 CONTEXT_TOOLS）。
 *
 * 这些工具必须碰得到 Agent 的 messages 数组，所以按「传入 agent 实例」的方式实现，
 * agent.js 只负责按名字分发。对应 Pi 生态的 billion-context-pi。
 */

const context = require('./context')
const blocks = require('./context-blocks')

// 最近若干条消息不参与压缩：那是模型当前的工作集，压掉就等于失忆
const PROTECT_RECENT = 4
// 单块最多覆盖多少条消息，避免一次压掉整段历史、摘要失真
const MAX_RANGE = 200

/** 块消息的抬头，用来识别「这条消息本身就是一个压缩块」 */
const BLOCK_RE = /^【压缩块 (b\d+)｜T(\d+)】/

function messageText(msg) {
  const parts = []
  if (typeof msg.content === 'string' && msg.content.trim()) parts.push(msg.content)
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      parts.push(`→ 调用 ${tc.function?.name}(${String(tc.function?.arguments || '').slice(0, 400)})`)
    }
  }
  return parts.join('\n')
}

function blockMessage(block) {
  return `【压缩块 ${block.id}｜T${block.level}】${block.title}\n${block.summary}\n` +
    `（原文 ${block.charsOriginal} 字已存档，不在上下文里了：需要细节用 decompress("${block.id}")，` +
    `或先用 search_context 按关键词找）`
}

/** 消息引用列表（供模型判断该压哪一段） */
function refRangeText(messages) {
  const withRef = messages.filter((m) => m.ref)
  if (withRef.length === 0) return '（没有可引用的消息）'
  // 块消息是后补的引用（序号更大）却坐在更靠前的位置，所以按序号排一遍再报区间
  const nums = withRef.map((m) => String(m.ref)).sort()
  return `${nums[0]} ~ ${nums[nums.length - 1]}（共 ${withRef.length} 条）`
}

/**
 * 把一段消息压成一个块。范围用消息引用指定（形如 m00012），界面上每条消息都以
 * [m00012] 开头，模型据此选范围。
 */
function compress(agent, { from, to, title, summary } = {}) {
  const messages = agent.context
  const text = String(summary || '').trim()
  if (!text) return 'compress 需要提供 summary（这段内容的摘要，要写详细：保留路径、决策、错误原文、结论）'

  const start = messages.findIndex((m) => m.ref === String(from || '').trim())
  const end = messages.findIndex((m) => m.ref === String(to || '').trim())
  if (start < 0 || end < 0) {
    return `找不到这段消息引用。当前可引用区间：${refRangeText(messages)}。用法：compress({ from: "m00003", to: "m00018", title, summary })`
  }
  let lo = Math.min(start, end)
  let hi = Math.max(start, end)

  // 不能把「助手请求调用工具」和「工具返回结果」拆开：拆了发出去的请求会被网关拒收。
  // 边界落在 tool 消息上就往前收，落在带 tool_calls 的助手消息上就往后再收一条。
  while (lo > 0 && messages[lo].role === 'tool') lo--
  while (hi + 1 < messages.length && messages[hi].role === 'assistant' && Array.isArray(messages[hi].tool_calls)) hi++

  if (hi - lo + 1 > MAX_RANGE) {
    return `一次最多压缩 ${MAX_RANGE} 条消息，这次给了 ${hi - lo + 1} 条。请分成几次压。`
  }

  // 保护：最后一条用户消息 + 最近的若干条
  const lastUser = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return i
    return -1
  })()
  const protectedFrom = messages.length - PROTECT_RECENT
  if (lastUser >= lo && lastUser <= hi) {
    return '这段范围包含了最后一条用户消息（用户的原始需求必须留在上下文里），不能压缩。请缩小区间。'
  }
  // 第一条用户消息是最初的需求，也是整个任务的方向；另外消息序列必须以 user 开头，
  // 压掉它会让上下文变成「助手消息打头」，有些网关会直接拒收。
  const firstUser = messages.findIndex((m) => m.role === 'user')
  if (firstUser >= 0 && firstUser >= lo && firstUser <= hi) {
    return `这段范围包含了最初那条用户消息（原始需求，也是整个任务的方向），不能压缩。请从 ${messages[firstUser + 1]?.ref || '它的下一条'} 开始。`
  }
  if (hi >= protectedFrom) {
    return `最近的 ${PROTECT_RECENT} 条消息是当前工作集，不能压缩。当前可压缩的最靠后引用是 ${messages[protectedFrom - 1]?.ref || '(无)'}。`
  }

  const covered = messages.slice(lo, hi + 1)
  const coveredBlockLevels = covered
    .map((m) => BLOCK_RE.exec(String(m.content || '')))
    .filter(Boolean)
    .map((m) => Number(m[2]) || 1)
  // 压的如果本身就是块，那就是再蒸馏一代（T1 → T2 → T3）
  const level = coveredBlockLevels.length > 0 ? Math.max(...coveredBlockLevels) + 1 : 1

  const block = blocks.createBlock(agent.projectDir, {
    title,
    summary: text,
    level,
    items: covered.map((m) => ({ ref: m.ref, role: m.role, text: messageText(m) })),
  })

  const replacement = {
    role: 'assistant',
    ref: agent.nextRef(),
    content: blockMessage(block),
  }
  messages.splice(lo, hi - lo + 1, replacement)

  const saved = Math.max(0, block.tokensOriginal - block.tokensSummary)
  return `已压缩 ${covered.length} 条消息 → 块 ${block.id}（T${block.level}，约省 ${saved} tokens）。` +
    `原文在 .yucode/context-blocks.json 里，需要时 decompress("${block.id}") 取回原文，` +
    `或 search_context 按关键词检索。继续干活即可。`
}

/** 在已压缩块里检索，不需要解压 */
function searchContext(agent, { query, limit } = {}) {
  const q = String(query || '').trim()
  if (!q) return 'search_context 需要提供 query'
  const hits = blocks.searchBlocks(agent.projectDir, q, limit)
  if (hits.length === 0) {
    const all = blocks.listBlocks(agent.projectDir)
    if (all.length === 0) return '还没有任何压缩块可检索（用 compress 压过的内容才会进档）。'
    return `没有命中「${q}」。现有压缩块：${all.map((b) => `${b.id}(${b.title})`).join('、')}`
  }
  return hits
    .map((h) => `${h.id}（T${h.level}，命中 ${h.hits} 次）${h.title}\n摘要：${h.summary}\n片段：${h.snippet}`)
    .join('\n\n')
}

/** 取回某块的原文 */
function decompress(agent, { block_id } = {}) {
  const id = String(block_id || '').trim()
  if (!id) return 'decompress 需要提供 block_id'
  const block = blocks.getBlock(agent.projectDir, id)
  if (!block) {
    const all = blocks.listBlocks(agent.projectDir)
    return `没有 ${id} 这个块。现有压缩块：${all.map((b) => b.id).join('、') || '(无)'}`
  }
  const head = `【${block.id}｜T${block.level}】${block.title}（原文 ${block.charsOriginal} 字）\n摘要：${block.summary}\n\n`
  return head + block.original
}

/** 上下文体检：占用多少、有哪些块、哪一段还能压 */
function contextStatus(agent) {
  const u = context.usage(agent.context, agent.modelConfig)
  const list = blocks.listBlocks(agent.projectDir)
  const s = blocks.stats(agent.projectDir)
  const lines = [
    `上下文占用：约 ${u.currentTokens} / ${u.inputLimit} tokens（${u.usagePercent}%），共 ${u.messageCount} 条消息`,
    `消息引用区间：${refRangeText(agent.context)}`,
  ]
  if (list.length === 0) {
    lines.push('压缩块：暂无（内容较多、或一段时间的工作已经收尾时，用 compress 把过程压成摘要）')
  } else {
    lines.push(`压缩块：${s.count} 个，原文合计约 ${s.tokensOriginal} tokens → 摘要约 ${s.tokensSummary} tokens`)
    for (const b of list.slice(-10)) {
      lines.push(`  ${b.id}（T${b.level}）${b.title}：原文 ${b.tokensOriginal} → 摘要 ${b.tokensSummary} tokens`)
    }
  }
  return lines.join('\n')
}

module.exports = { compress, searchContext, decompress, contextStatus, messageText, blockMessage }
