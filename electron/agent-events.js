/**
 * Agent 与界面之间的事件通道。
 *
 * 全是单向推送：Agent 说，界面听。抽出来的理由只有一个 —— agent.js 要保持
 * 在 500 行以内，而这几个方法彼此无关、也不碰任何业务状态。
 *
 * 通过 Object.assign(YuCodeAgent.prototype, events) 混入，方法里的 this 就是 Agent。
 */

const { TOOL_PREFIX } = require('./mcp')
const { trace } = require('./pi-rpc')

/** 统一出口，省得每个方法都重写一遍窗口有效性判断 */
function emit(agent, channel, payload) {
  const win = agent.mainWindow
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// 终端转义序列：CSI（颜色、光标）与 OSC（终端标题）。
// 扩展是照着终端界面写的，颜色码会跟着文本一起发过来（pi-lens 的 LSP 状态就是这样），
// 网页上渲染出来就是一堆「[38;2;102;102;102m」，推到界面前必须清掉。
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI_RE, '') : text
}

const events = {
  sendStatus(status) {
    // 排查用：与 pi 的原始事件写在同一个文件里，能直接看出哪一步断了
    trace('ui', {
      state: status && status.state,
      detail: status && typeof status.detail === 'string' ? status.detail.slice(0, 80) : undefined,
    })
    emit(this, 'agent:status', status && typeof status.detail === 'string'
      ? { ...status, detail: stripAnsi(status.detail) }
      : status)
  },

  sendResponse(text) {
    trace('ui', { response: String(text || '').slice(0, 60), length: String(text || '').length })
    emit(this, 'agent:response', text)
  },

  // 流式增量：思考过程 / 正文，逐字推给前端
  sendStream(delta) {
    emit(this, 'agent:stream', delta)
  },

  sendToolStatus(toolName, args) {
    if (toolName.startsWith(TOOL_PREFIX)) {
      const label = toolName.split('__').slice(2).join('__') || toolName
      this.sendStatus({ state: 'tool', detail: `MCP: ${label}` })
      return
    }
    const statusMap = {
      search_files: { state: 'searching', detail: `搜索: ${args.pattern}` },
      read_file: { state: 'reading', detail: `读取: ${args.file_path}` },
      write_file: { state: 'editing', detail: `写入: ${args.file_path}` },
      edit_file: { state: 'editing', detail: `编辑: ${args.file_path}` },
      execute_command: { state: 'executing', detail: `执行: ${args.command?.slice(0, 50) || ''}` },
      list_directory: { state: 'searching', detail: `列目录: ${args.directory || '/'}` },
      ask_user: { state: 'asking', detail: String(args.question || '').slice(0, 80) },
      web_search: { state: 'web_searching', detail: `联网搜索: ${args.query || ''}` },
      web_fetch: { state: 'web_fetching', detail: `抓取网页: ${args.url || ''}` },
      task: {
        state: 'searching',
        detail: `派发子代理${args.subagent_type ? `（${args.subagent_type}）` : ''}: ${
          String(args.description || args.prompt || '').slice(0, 60)}`,
      },
      compress: { state: 'action', detail: `压缩上下文: ${String(args.title || '').slice(0, 40)}` },
      search_context: { state: 'searching', detail: `检索压缩块: ${String(args.query || '').slice(0, 40)}` },
      decompress: { state: 'reading', detail: `取回压缩块原文: ${String(args.block_id || '')}` },
      context_status: { state: 'action', detail: '检查上下文占用' },
      list_checkpoints: { state: 'searching', detail: '查看改动检查点' },
      restore_checkpoint: { state: 'editing', detail: '回退到检查点' },
      todo_write: {
        state: 'action',
        detail: `更新任务清单（${Array.isArray(args.todos) ? args.todos.length : 0} 项）`,
      },
      get_diagnostics: {
        state: 'searching',
        detail: args.file_path ? `诊断: ${args.file_path}` : '检查整个工程',
      },
      write_plan: { state: 'action', detail: '保存实施计划' },
      read_plan: { state: 'searching', detail: '查看实施计划' },
      remember: { state: 'action', detail: '记入项目长期记忆' },
      format_file: { state: 'editing', detail: `格式化: ${args.file_path || ''}` },
      exit_plan_mode: { state: 'asking', detail: '请你确认这份计划' },
      todo: {
        state: 'action',
        detail: `更新任务清单（${Array.isArray(args.todos) ? args.todos.length : 0} 项）`,
      },
    }
    this.sendStatus(statusMap[toolName] || { state: 'tool', detail: toolName })
  },

  /** 把「这次改了哪些行」推给界面。改了什么必须一眼能看到，不能只回一句「编辑成功」 */
  sendDiff(payload) {
    trace('ui', { diff: payload && payload.filePath, added: payload && payload.added, created: payload && payload.created })
    emit(this, 'agent:diff', payload)
  },

  /** 请求用户回答一个问题（ask_user / 危险操作确认，挂起期间） */
  sendAsk(payload) {
    trace('ui', { ask: String(payload && payload.question || '').slice(0, 60) })
    // 标题与选项同样来自扩展（pi-tui-kit 会按主题上色），一并清掉颜色码
    emit(this, 'agent:ask', {
      ...payload,
      question: stripAnsi(payload.question),
      options: Array.isArray(payload.options) ? payload.options.map((o) => stripAnsi(o)) : payload.options,
    })
  },

  /** 本轮任务开始前打下的检查点，界面可以据此提示「改坏了能回退」 */
  sendCheckpoint(payload) {
    emit(this, 'agent:checkpoint', payload)
  },

  /** 任务清单，界面实时展示进度 */
  sendTodos() {
    emit(this, 'agent:todos', this.todos)
  },

  /** 计划模式开关。Agent 自己退出计划模式（exit_plan_mode 获批准）时，界面要跟着变 */
  sendPlanMode(enabled) {
    emit(this, 'agent:plan-mode', Boolean(enabled))
  },

  /** 真实 token 用量：输入 / 输出 / 上限 / 速度。界面显示成 pi 那行 ↑↓ 就是它 */
  sendUsage(payload) {
    emit(this, 'agent:usage', payload)
  },
}

module.exports = { events, emit }
