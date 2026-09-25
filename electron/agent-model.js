/**
 * 模型调用、消息引用、token 用量上报。
 *
 * 和 agent-events.js 一样以方法形式混进 YuCodeAgent 原型（this 就是 Agent），
 * 拆出来只是为了守住 agent.js 的单文件行数。
 */

const { streamChat } = require('./model-client')
const context = require('./context')

const modelMethods = {
  /**
   * 给每条消息前缀一个稳定引用（[m00012] 正文）。
   * 模型只能看见文本，没法「按第几条」指定范围 —— 有了引用才能用
   * from/to 让 compress 精确圈定要折叠的那一段。
   * ref 本身不进请求体，只在文本前缀里出现，避免严格校验的网关拒收未知字段。
   */
  withRefs(messages) {
    return messages.map((m) => {
      if (!m || m.role === 'system') return m
      const { ref, ...rest } = m
      // 只带 tool_calls、没有正文的 assistant 消息不加前缀：前缀会和工具调用结构打架
      if (!ref || !rest.content || !String(rest.content).trim()) return rest
      return { ...rest, content: `[${ref}] ${rest.content}` }
    })
  },

  /**
   * @param onDelta 流式增量回调
   * @param opts.messages 自定义消息数组（子代理用）；缺省时用系统提示词 + 主上下文
   * @param opts.tools    自定义工具集（子代理用只读子集）；缺省时用全部可用工具
   */
  async callModel(onDelta, opts = {}) {
    let messages = opts.messages
    if (!messages) {
      // 每次调用模型前先看上下文占用，超阈值就先压缩，避免超长请求被拒
      this.compactContext()
      messages = [
        { role: 'system', content: this.getSystemPrompt() },
        ...this.context,
      ]
    }

    const startedAt = Date.now()
    // 实时速度用的估算 token：必须按「真实的增量文本」估。以前写成
    // estimateText('x'.repeat(outChars))，把所有字都当 ASCII 算（4 字/token），
    // 中文实际约 1.5 字/token，于是流式阶段的速度被压掉近 3 倍。
    let outTokens = 0
    let firstDeltaAt = 0
    let lastDeltaAt = 0
    let lastTick = 0

    const res = await streamChat({
      config: this.modelConfig,
      messages: this.withRefs(messages),
      tools: opts.tools || this.allTools(),
      onDelta: (delta) => {
        // 边流边报，让速度条动起来。这里的 token 数是按字数估的，
        // 请求结束后会被 API 返回的真实 usage 覆盖掉。
        if (delta?.text) {
          outTokens += context.estimateText(delta.text)
          const now = Date.now()
          if (!firstDeltaAt) firstDeltaAt = now
          lastDeltaAt = now
          // 从首个 token 起算，排除预填充与首字等待 —— 那段时间不产 token，
          // 算进分母会让速度显示得比模型真实解码速度慢一大截。
          if (now - firstDeltaAt >= 300 && now - lastTick >= 300) {
            lastTick = now
            this.reportUsage({
              outputTokens: outTokens,
              elapsedMs: now - firstDeltaAt,
              live: true,
            })
          }
        }
        onDelta(delta)
      },
      aborted: () => this.aborted,
    })

    // 头部带 usage 才用得上；没有就保留上一次的数字，不假装知道
    if (res.usage) {
      // 分母同样只取「解码窗口」：首字 → 末字。完全没流式增量时退回整体耗时。
      const decodeMs = lastDeltaAt > firstDeltaAt ? lastDeltaAt - firstDeltaAt : 0
      this.reportUsage({
        inputTokens: res.usage.prompt_tokens || 0,
        outputTokens: res.usage.completion_tokens || 0,
        elapsedMs: decodeMs || (Date.now() - startedAt),
      })
    }
    return res
  },

  /**
   * 汇总并把 token 用量推给界面。
   * inputTokens 直接用 API 报的 prompt_tokens —— 它就是真实上下文占用，
   * 比本地估算准，也不再需要「模拟 token」那套假数据。
   * @param patch.live true 表示流式过程中的估算值（速度还没稳定）
   */
  reportUsage(patch) {
    const merged = { ...this.usage, ...patch }
    const limit = this.modelConfig.maxInputTokens || this.modelConfig.contextWindow || 131072
    const speed = patch.elapsedMs > 0
      ? Math.round((merged.outputTokens || 0) / (patch.elapsedMs / 1000))
      : merged.tokensPerSecond
    this.usage = {
      inputTokens: merged.inputTokens || 0,
      outputTokens: merged.outputTokens || 0,
      tokensPerSecond: speed,
    }
    this.sendUsage({
      ...this.usage,
      inputLimit: limit,
      contextWindow: this.modelConfig.contextWindow || limit,
      live: Boolean(patch.live),
    })
  },
}

module.exports = { modelMethods }
