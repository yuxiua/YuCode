/**
 * 模型调用（OpenAI 兼容的 chat/completions，流式）。
 *
 * 单独成文件的原因：这段 SSE 解析与分片归并逻辑有近百行，且与 Agent 状态无关，
 * 放在 agent.js 里只会把主循环淹掉。
 */

/**
 * 流式调用模型。
 * @param config  模型配置（baseUrl / apiKey / model / maxOutputTokens）
 * @param messages 消息数组
 * @param tools    function calling 工具定义
 * @param onDelta  (delta) => void，增量回调：{ type: 'reasoning' | 'content', text }
 * @param aborted  () => boolean，返回 true 时中止读取后续分片
 * @returns { content, tool_calls, usage }
 */
async function streamChat({ config, messages, tools, onDelta, aborted }) {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools,
      max_tokens: config.maxOutputTokens,
      temperature: 0.7,
      stream: true,
      // 不显式要，多数网关在流式模式下不返回 token 用量；要了才能显示真实占用
      stream_options: { include_usage: true },
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`API ${res.status}: ${errText.slice(0, 200)}`)
  }

  let content = ''
  let buffer = ''
  let usage = null
  const toolCalls = []

  const handleEvent = (payload) => {
    // 用量可能单独一帧（choices 为空）下发，必须在取 delta 之前接住
    if (payload.usage) usage = payload.usage

    const delta = payload.choices?.[0]?.delta
    if (!delta) return

    // 推理内容（Qwen/DeepSeek 等模型在单独字段里返回思考过程）
    const reasoning = delta.reasoning_content || delta.reasoning
    if (reasoning) onDelta?.({ type: 'reasoning', text: reasoning })

    if (delta.content) {
      content += delta.content
      onDelta?.({ type: 'content', text: delta.content })
    }

    // 工具调用也是分片下发的，按 index 归并
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? 0
      if (!toolCalls[i]) {
        toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } }
      }
      if (tc.id) toolCalls[i].id = tc.id
      if (tc.function?.name) toolCalls[i].function.name += tc.function.name
      if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments
    }
  }

  for await (const chunk of res.body) {
    if (aborted?.()) break
    buffer += Buffer.from(chunk).toString('utf-8')
    const lines = buffer.split('\n')
    buffer = lines.pop() || '' // 最后一段可能不完整，留在缓冲区
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || !line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        handleEvent(JSON.parse(data))
      } catch { /* 忽略无法解析的分片 */ }
    }
  }

  return {
    content,
    tool_calls: toolCalls.filter(Boolean).filter((t) => t.function.name),
    usage,
  }
}

module.exports = { streamChat }
