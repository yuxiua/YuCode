/**
 * 需要「一边改状态、一边等用户回话」的那几个工具：ask_user、护栏确认、
 * todo_write、exit_plan_mode。
 *
 * 它们和 agent-events.js 一样，以方法形式混进 YuCodeAgent 原型（里面的 this 就是 Agent），
 * 之所以拆出来只是因为 agent.js 要守住单文件 500 行的约定。
 */

const planStore = require('./plan-store')

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])
const TODO_PRIORITIES = new Set(['high', 'medium', 'low'])

const interactions = {
  // ==================== 向用户提问（ask_user） ====================
  /** 放掉挂起的提问。没有挂起时返回 false */
  resolvePendingAsk(answer) {
    const pending = this.pendingAsk
    if (!pending) return false
    this.pendingAsk = null
    pending.resolve(answer)
    return true
  },

  /** 渲染进程回答后回填。id 对不上（例如已经中断）就忽略 */
  answerQuestion(id, answer) {
    const pending = this.pendingAsk
    if (!pending || pending.id !== id) return false
    return this.resolvePendingAsk(answer || '(用户未作答)')
  },

  // 挂起并等用户回答。渲染进程答题后由 answerQuestion 放行；
  // 用户点「停止」时 interrupt() 也会把它放掉，否则主循环会永远卡住。
  toolAskUser({ question, options } = {}) {
    const text = String(question || '').trim()
    if (!text) return 'ask_user 需要提供 question'
    if (this.aborted) return '(任务已中断，跳过提问)'

    return new Promise((resolve) => {
      const id = `ask-${Date.now()}-${++this.askCounter}`
      this.pendingAsk = { id, resolve }
      this.sendAsk({
        id,
        question: text,
        options: (Array.isArray(options) ? options : [])
          .filter((o) => typeof o === 'string' && o.trim())
          .slice(0, 6),
      })
    })
  },

  /**
   * 护栏命中后的用户确认。走的就是 ask_user 那张卡，所以不需要额外界面。
   * @returns 'allow' 用户确认执行 | 'deny' 用户拒绝 | null 没有确认机制（按硬拒绝处理）
   */
  async confirmRisk(blocked, payload = {}) {
    if (!this.askBeforeRisk) return null
    if (this.aborted) return 'deny'

    const what = payload.command
      ? `命令：${payload.command}`
      : `位置：${payload.target || '(未知)'}`
    const answer = await this.toolAskUser({
      question: `护栏拦下了 Agent 的一个操作，需要你拍板。\n\n【${blocked.title}】\n${what}\n\n${blocked.detail}\n\n确认执行吗？`,
      options: ['确认执行', '取消'],
    })
    // 只认「确认」开头：用户自己敲的其它内容一律当拒绝，宁可少做也不要误伤
    return typeof answer === 'string' && /^确认/.test(answer.trim()) ? 'allow' : 'deny'
  },

  // ==================== 任务清单（todo_write） ====================
  toolTodoWrite({ todos } = {}) {
    const list = (Array.isArray(todos) ? todos : [])
      .map((t, i) => ({
        id: `t${i + 1}`,
        content: String(t?.content || '').trim().slice(0, 200),
        status: TODO_STATUSES.has(t?.status) ? t.status : 'pending',
        priority: TODO_PRIORITIES.has(t?.priority) ? t.priority : 'medium',
      }))
      .filter((t) => t.content)
      .slice(0, 30)

    // 同一时刻只留一条 in_progress，否则界面会出现两个「进行中」，用户看不懂在干哪件
    let seenActive = false
    for (const t of list) {
      if (t.status !== 'in_progress') continue
      if (seenActive) t.status = 'pending'
      seenActive = true
    }

    this.todos = list
    // 同步落盘：清单和计划一样必须扛得住上下文压缩与重启
    try { planStore.writeTodos(this.projectDir, list) } catch { /* 落盘失败不影响本轮 */ }
    this.sendTodos()
    if (list.length === 0) return '清单已清空。'

    const done = list.filter((t) => t.status === 'completed').length
    const active = list.find((t) => t.status === 'in_progress')
    const body = list
      .map((t) => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'} ${t.content}`)
      .join('\n')
    return `清单已更新（${done}/${list.length} 完成${active ? `，当前在做：${active.content}` : ''}）：\n${body}`
  },

  // ==================== 计划模式的收尾（exit_plan_mode） ====================
  /**
   * 把方案交给用户拍板。这是计划模式工作流的关键一环：
   * 没有它，Agent 出完计划就只能干等用户手动关掉只读开关，中间没有交接。
   * 批准 → 自动退出计划模式并按计划动手；否决 → 把意见带回模型让它改。
   * 计划同时落盘，所以退出计划模式后它仍会每轮注入，不会因为压缩而丢。
   */
  async toolExitPlanMode({ plan } = {}) {
    const text = String(plan || '').trim()
    if (!text) return 'exit_plan_mode 需要提供 plan'

    // 先把计划写下来：无论用户批不批准，这次调研的结论都不该丢
    try { planStore.writePlan(this.projectDir, text) } catch { /* 落盘失败不影响确认流程 */ }

    if (!this.planMode) {
      return '当前不在计划模式，计划已保存到 .yucode/plan.md。可以直接按它开始执行。'
    }
    if (this.aborted) return '(任务已中断)'

    const answer = await this.toolAskUser({
      question: `【计划待你确认】\n\n${text}\n\n同意按这份计划动手吗？（同意后会自动退出计划模式开始改代码）`,
      options: ['同意，开始执行', '先别动手，我有意见'],
    })
    if (this.aborted) return '(任务已中断)'

    if (typeof answer === 'string' && /^同意/.test(answer.trim())) {
      this.setPlanMode(false)
      return (
        '用户已批准计划，计划模式已关闭，现在可以改文件、执行命令了。\n' +
        '计划已保存到 .yucode/plan.md（每轮都会重新注入给你）。\n' +
        '请先用 todo_write 把计划拆成可勾选的小步，然后逐步动手，每完成一步更新一次清单。'
      )
    }
    return (
      `用户暂未批准这份计划，需要按他的意见改完再提交一次。\n` +
      `用户意见：${answer || '(未说明)'}\n` +
      '补充调研（只读命令仍可执行），改好计划后再调用 exit_plan_mode。'
    )
  },
}

module.exports = { interactions }
