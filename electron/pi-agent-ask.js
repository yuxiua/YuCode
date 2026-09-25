/**
 * 扩展的 UI 请求 → 界面的提问卡片。
 *
 * pi 的扩展（子代理、技能、计划模式…）要问用户问题时，会在 RPC 上发一条
 * extension_ui_request 然后阻塞等 extension_ui_response。
 * 界面一次只放得下一张卡，所以这里排成队列逐个问；用户回答、超时、中断之后
 * 都要立刻把应答写回 pi，不能让它一直等。
 *
 * 其余方法（notify / setStatus / setWidget / setTitle / set_editor_text）是单向通知，
 * pi 不等待应答，这里一律忽略（PiAgent 会把 notify / setStatus / setWidget 当作过程记录）。
 */

const BLOCKING_METHODS = new Set(['select', 'confirm', 'input', 'editor'])

class AskQueue {
  /**
   * @param {object} io
   * @param {(card: object) => void} io.emitAsk       把提问卡片发给界面
   * @param {(payload: object) => Promise<any>} io.reply  把应答写回 pi
   */
  constructor({ emitAsk, reply }) {
    this.emitAsk = emitAsk
    this.reply = reply
    this.queue = []
    this.pending = null
  }

  /** 当前在等用户回答的那条（界面据此校验回答是不是针对它） */
  get current() {
    return this.pending
  }

  /**
   * 收一条 extension_ui_request。
   * @returns {boolean} 是不是需要用户作答的请求
   */
  push(request) {
    const method = String(request.method || '')
    if (!BLOCKING_METHODS.has(method)) return false
    this.queue.push(toEntry(request, method))
    this._pump()
    return true
  }

  /** 用户回答 / 超时，统一走这里 */
  resolve(answer) {
    const entry = this.pending
    if (!entry) return false
    if (entry.timer) clearTimeout(entry.timer)
    this.pending = null
    this._reply(entry, answer)
    this._pump()
    return true
  }

  /** 中断时把挂起的和排队的全部放掉，别让扩展干等 */
  drain(answer) {
    for (const entry of this.queue) this._reply(entry, answer)
    this.queue.length = 0
    this.resolve(answer)
  }

  _pump() {
    if (this.pending || this.queue.length === 0) return
    const entry = this.queue.shift()
    if (entry.timeout) entry.timer = setTimeout(() => this.resolve('(超时未作答)'), entry.timeout)
    this.pending = entry
    this.emitAsk(entry.card)
  }

  _reply(entry, answer) {
    this.reply(toResponse(entry, answer)).catch(() => { /* 进程已经退了 */ })
  }
}

function toEntry(request, method) {
  const id = String(request.id)
  const question = method === 'confirm'
    ? [request.title, request.message].filter(Boolean).join('\n\n')
    : [request.title, request.placeholder].filter(Boolean).join('\n')
  const options = method === 'select'
    ? (Array.isArray(request.options) ? request.options.map(String) : [])
    : method === 'confirm' ? ['确认', '取消'] : []
  return {
    id,
    method,
    timeout: Number(request.timeout) || 0,
    card: { id, question: question || '扩展需要你确认', options: options.slice(0, 6) },
  }
}

/** pi 的应答有三种形态：给值 / 给真假 / 取消 */
function toResponse(entry, answer) {
  const text = typeof answer === 'string' ? answer : ''
  if (entry.method === 'confirm') {
    return { type: 'extension_ui_response', id: entry.id, confirmed: /^(确认|是|同意|yes|ok)/i.test(text.trim()) }
  }
  return { type: 'extension_ui_response', id: entry.id, value: text }
}

module.exports = { AskQueue }
