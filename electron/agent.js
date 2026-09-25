/**
 * Yu Code Agent - 完整 Agent 循环（支持工具调用）
 *
 * 本文件只保留四件事：主循环、状态、与界面通信、需要访问自身状态的工具。
 * 其余都在各自的模块里：
 *   tool-schemas.js  工具定义      agent-tools.js        工具实现
 *   prompt.js        系统提示词    model-client.js       模型调用（流式）
 *   agent-model.js   模型调用/用量（混入原型）
 *   edit-engine.js   编辑匹配      web-fetch.js          联网抓取
 *   guard.js         安全护栏      checkpoint.js         改动检查点
 *   subagent.js      子代理执行    agent-subagents.js    子代理派发（并行/后台/角色）
 *   context.js       上下文压缩    context-blocks.js     压缩块存档
 *   agent-context-tools.js  压缩/检索/还原工具
 *   agent-interactions.js   ask_user / 护栏确认 / 任务清单 / 计划收尾（混入原型）
 *   diagnostics.js   诊断回灌      mcp.js                外部 MCP 工具
 *
 * 这些能力全部原生内置：不依赖 pi CLI、不需要安装任何 Pi 扩展，打包即生效。
 */

const { TOOLS } = require('./tool-schemas')
const { TOOL_IMPL } = require('./agent-tools')
const { systemPrompt } = require('./prompt')
const { events } = require('./agent-events')
const { modelMethods } = require('./agent-model')
const { interactions } = require('./agent-interactions')
const subagents = require('./agent-subagents')
const contextTools = require('./agent-context-tools')
const checkpoint = require('./checkpoint')
const builtins = require('./builtins')
const guard = require('./guard')
const context = require('./context')
const diagnostics = require('./diagnostics')
const planStore = require('./plan-store')

/** MCP 工具统一用这个前缀注册，避免和内置工具撞名（命名规则归 mcp.js 管） */
const MCP_PREFIX = require('./mcp').TOOL_PREFIX

class YuCodeAgent {
  constructor(mainWindow, projectDir) {
    this.mainWindow = mainWindow
    this.projectDir = projectDir || process.cwd()
    // 默认值只是兜底，真正生效的是渲染进程在启动/切模型时推过来的配置（agent:set-model）。
    // 这里不内置任何模型/地址/密钥：用户没配模型时就是空的，不会偷偷走内置 API。
    this.modelConfig = {
      provider: '',
      model: '',
      apiKey: '',
      baseUrl: '',
      contextWindow: 131072,
      maxInputTokens: 131072,
      maxOutputTokens: 8192,
      supportsMultimodal: false,
    }
    this.context = []
    // 单轮任务的工具调用轮数上限。这只是防止死循环的安全阀，不该是任务预算：
    // 一个「把某个功能做完」的任务动辄几十上百次工具调用，卡在十几步等于永远做不完。
    this.maxSteps = 100
    this.aborted = false
    // 「已安装且启用」的扩展，其能力说明会注入系统提示词
    this.enabledExtensions = []
    // 计划模式：只读规划，任何改动类工具都被拦下
    this.planMode = false
    // 护栏命中时是先问用户（true）还是直接拦掉（false）
    this.askBeforeRisk = true
    // 改完文件自动回灌诊断（类型/语法错误）
    this.autoDiagnostics = true
    // 本轮任务开始前打的 git 检查点（没有改动 / 不是 git 仓库时为 null）
    this.checkpoint = null
    // 当前任务清单（todo_write 维护），界面实时展示
    this.todos = []
    // 正在等待用户回答的提问（ask_user 会挂在这里，等渲染进程回话）
    this.pendingAsk = null
    this.askCounter = 0
    // 真实 token 用量（来自 API 的 usage 字段），界面显示在对话框最下方
    this.usage = { inputTokens: 0, outputTokens: 0, tokensPerSecond: 0 }
    // MCP 客户端由主进程注入，用来接外部 MCP server 的工具
    this.mcp = null
    // 消息引用序号：每条消息拿到一个不会变的 [m00012]，模型据此指定要压缩哪一段
    this.refSeq = 0
    // 后台子代理：正在跑的、以及跑完等着并回上下文的
    this.bgTasks = new Map()
    this.pendingBgNotices = []
    this.bgSeq = 0
  }

  /** 给新消息分配一个稳定引用（压缩工具就是按它划范围的） */
  nextRef() {
    this.refSeq += 1
    return `m${String(this.refSeq).padStart(5, '0')}`
  }

  /** 所有往上下文里放消息的地方都走这里，保证每条消息都有引用 */
  pushContext(message) {
    this.context.push({ ...message, ref: message.ref || this.nextRef() })
    return this.context[this.context.length - 1]
  }

  // 同步已启用的扩展（设置页安装 / 开关后由主进程转发）
  setExtensions(list) {
    this.enabledExtensions = Array.isArray(list) ? list : []
  }

  /** 注入 MCP 客户端 */
  setMcp(mcp) {
    this.mcp = mcp
  }

  // 切换计划模式（只读规划）
  setPlanMode(enabled) {
    this.planMode = Boolean(enabled)
    // 同步推给界面：Agent 自己退出计划模式时，输入框上的开关也要跟着变
    this.sendPlanMode(this.planMode)
    this.sendStatus({
      state: 'idle',
      detail: this.planMode ? '已开启计划模式（只读调研，改文件的操作会被拦下）' : '已关闭计划模式',
    })
  }

  /** 危险操作确认开关 */
  setRiskConfirm(enabled) {
    this.askBeforeRisk = Boolean(enabled)
    this.sendStatus({
      state: 'idle',
      detail: this.askBeforeRisk ? '危险操作会先问你' : '危险操作直接拦截，不再询问',
    })
  }

  /** 改完文件自动诊断的开关 */
  setAutoDiagnostics(enabled) {
    this.autoDiagnostics = Boolean(enabled)
  }

  // 更新工作目录（跟随左侧资源管理器打开的目录）
  setProjectDir(dir) {
    if (!dir) return
    // 切到别的项目时清空上下文：对话历史按目录各自持久化在前端，
    // 上下文若继续累积会把上一个项目的内容带进来。
    if (this.projectDir && this.projectDir !== dir) {
      this.context = []
    }
    this.projectDir = dir
    // 计划与任务清单是按目录落在磁盘上的，切过来就把这个项目的进度接回去
    this.restoreTodos()
    this.mcp?.setProjectDir(dir)
    this.sendStatus({ state: 'idle', detail: `工作目录: ${dir}` })
  }

  /** 从磁盘接回本项目的任务清单（换项目 / 恢复会话时用） */
  restoreTodos() {
    try {
      this.todos = planStore.readTodos(this.projectDir)
    } catch {
      this.todos = []
    }
    this.sendTodos()
  }

  /**
   * 把某个会话的历史灌回上下文。
   *
   * 会话标签是前端存的，但模型的上下文在主进程 —— 两者不同步就会出现
   * 「界面里有历史、模型却失忆」，或者切个标签把上一个会话的内容串进来。
   */
  loadContext({ messages } = {}) {
    this.context = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: String(m.content || '') }))
      .filter((m) => m.content.trim())
      // 上限给得松一些：真正的容量控制交给 compact，而不是在这里硬砍历史
      .slice(-200)
      // 恢复的历史也要有引用（先裁再编号，被丢掉的消息不占用序号）
      .map((m) => ({ ...m, ref: this.nextRef() }))
    // 任务清单存在磁盘上，恢复会话时一起接回来，界面才不会空着
    this.restoreTodos()
  }

  /**
   * 编辑历史消息重跑：把上下文退回那条消息之前。
   * 自研引擎的上下文就在主进程里，直接整段换成截断后的历史即可。
   */
  rewind({ messages } = {}) {
    this.context = []
    this.loadContext({ messages })
    return { ok: true }
  }

  // 中断当前执行
  interrupt() {
    this.aborted = true
    // 正在等用户回答的提问必须一并放掉，否则主循环会一直挂在那个 Promise 上
    this.resolvePendingAsk('(用户中断了任务，未作答)')
    this.sendStatus({ state: 'interrupted', detail: '已中断' })
  }

  // ==================== 向用户提问 / 任务清单 / 计划收尾 ====================
  // resolvePendingAsk、answerQuestion、toolAskUser、confirmRisk、
  // toolTodoWrite、toolExitPlanMode 都在 agent-interactions.js，方法体混入原型。

  // ==================== 系统提示词 ====================
  /** 按当前实际可用情况说明额外能力，让模型不用去猜 */
  buildCapabilities() {
    const caps = []
    const mcpCount = this.mcp ? this.mcp.getToolSchemas().length : 0
    if (mcpCount > 0) {
      caps.push(`MCP 工具（${mcpCount} 个，名字以 ${MCP_PREFIX} 开头）：由外部 MCP server 提供，用法和内置工具完全一样，按名字直接调用。`)
    }
    if (this.autoDiagnostics) {
      caps.push('代码诊断：改完文件后，系统会自动把该文件的类型/语法错误附在工具结果末尾，请据此继续修复；想主动全量自查时用 get_diagnostics。')
    }
    caps.push('格式化：排版整理用 format_file，它只调这个工程自己装的 prettier / ruff / black，风格由工程自己的配置决定。工程没装格式化器时它会如实告诉你 —— 那种情况不要自己动手排版，先问用户要不要装。')
    caps.push('任务清单：多步任务先用 todo_write 拆开，之后每推进一步就更新一次状态，用户界面会实时显示进度。')
    caps.push('长期记忆：.yucode/memory.md 里的内容会一直在你的提示词里（跨会话有效）。认定某条结论以后还用得上时，用 remember 记下来；不确定写过什么时直接读这个文件。')
    return caps
  }

  getSystemPrompt() {
    return systemPrompt({
      projectDir: this.projectDir,
      extensions: this.enabledExtensions,
      planMode: this.planMode,
      capabilities: this.buildCapabilities(),
      // 计划 / 项目约定 / 任务清单来自磁盘，每轮重新注入：这是长任务不被压缩搞丢的关键
      planContext: planStore.contextBlock(this.projectDir),
    })
  }

  // ==================== Agent 主循环 ====================
  async handleMessage(message) {
    this.aborted = false
    try {
      // 新任务：先把上一轮的用量清零，界面不会继续显示旧数字
      this.reportUsage({ inputTokens: 0, outputTokens: 0, tokensPerSecond: 0 })

      // 动手之前先留一个可回退的快照（自建快照，不依赖 git）。工作目录无效或快照
      // 写不出来时 checkpoint.create 安静返回 null，这一轮就没有检查点。
      this.checkpoint = checkpoint.create(this.projectDir)
      if (this.checkpoint) this.sendCheckpoint(this.checkpoint)

      // MCP 连接是按工作目录起的，切过目录之后要重新连上，工具列表才是全的
      await this.mcp?.ensureReady()

      // 添加用户消息到上下文
      this.pushContext({ role: 'user', content: message })

      let finalResponse = ''
      let step = 0

      while (step < this.maxSteps) {
        if (this.aborted) break
        step++
        this.sendStatus({ state: 'thinking', detail: `第 ${step} 轮` })

        // 上一轮派出去的后台子代理如果跑完了，在这里并回上下文（此时消息序列是完整的）
        subagents.flushBackgroundNotices(this)

        // 调用模型（流式，思考/正文增量实时推给前端）
        const msg = await this.callModel((delta) => {
          this.sendStream(delta)
        })

        if (this.aborted) break

        if (!msg) {
          finalResponse = '模型未返回有效响应'
          break
        }

        // 如果有工具调用
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // 保存 assistant 消息（包含 tool_calls）
          this.pushContext({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls })

          if (msg.content && msg.content.trim()) {
            this.sendStatus({ state: 'thinking_output', detail: msg.content.trim() })
          }

          // 一轮里发了多个 task：它们本来就是互相独立的活，并行跑，别一个个排队
          const taskCalls = msg.tool_calls.filter((tc) => tc.function.name === 'task')
          if (taskCalls.length > 1 && taskCalls.length === msg.tool_calls.length) {
            const parsed = taskCalls.map((tc) => {
              let a = {}
              try { a = JSON.parse(tc.function.arguments || '{}') } catch { /* ignore */ }
              return { tc, args: a }
            })
            for (const p of parsed) this.sendToolStatus('task', p.args)
            const texts = await subagents.runTaskBatch(this, parsed)
            parsed.forEach((p, i) => {
              this.pushContext({ role: 'tool', tool_call_id: p.tc.id, content: texts[i] })
            })
            continue
          }

          for (const tc of msg.tool_calls) {
            if (this.aborted) break
            const toolName = tc.function.name
            let args = {}
            try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* ignore */ }

            // 发送状态
            this.sendToolStatus(toolName, args)

            // 执行工具
            const toolResult = await this.executeTool(toolName, args)

            // 保存工具结果
            this.pushContext({
              role: 'tool',
              tool_call_id: tc.id,
              content: toolResult,
            })
          }

          continue // 继续循环，让模型处理工具结果
        } else {
          // 无工具调用，最终回复
          finalResponse = msg.content || '(无回复)'
          this.pushContext({ role: 'assistant', content: finalResponse })
          break
        }
      }

      if (this.aborted) {
        this.sendStatus({ state: 'idle' })
        this.sendResponse(finalResponse || '（已中断）')
        return
      }

      if (step >= this.maxSteps) {
        // 不是「失败」，只是这一轮的步数阀门到了。计划与任务清单都在磁盘上，
        // 直接继续说「继续」就能接着往下做，不会从头再来。
        const progress = this.todos.length > 0
          ? `当前进度：${this.todos.filter((t) => t.status === 'completed').length}/${this.todos.length} 项已完成。`
          : ''
        finalResponse += `\n\n---\n（本轮已连续执行 ${this.maxSteps} 步，先在这里停一下防止失控。${progress}进度与计划都已保存，直接回复「继续」即可接着做，不必重头开始。）`
      }

      this.sendStatus({ state: 'done' })
      this.sendResponse(finalResponse)
    } catch (error) {
      console.error('Agent error:', error)
      if (this.aborted) {
        this.sendStatus({ state: 'idle' })
        this.sendResponse('（已中断）')
        return
      }
      this.sendStatus({ state: 'error', detail: error.message })
      this.sendResponse(`执行出错: ${error.message}`)
    }
  }

  // ==================== 模型调用 ====================
  /** 内置工具 + 已连接 MCP server 的工具 */
  allTools() {
    const mcpTools = this.mcp ? this.mcp.getToolSchemas() : []
    return mcpTools.length > 0 ? [...TOOLS, ...mcpTools] : TOOLS
  }

  // ==================== 模型调用 ====================
  // withRefs / callModel / reportUsage 在 agent-model.js，方法体混入原型。

  // ==================== 工具执行 ====================
  async executeTool(name, args) {
    try {
      // 上下文工具动的是主上下文数组本身，必须留在类里分发，也不能被计划模式拦下：
      // 压缩只是整理上下文，不产生任何副作用，计划模式下更需要它腾出调研空间。
      if (name === 'compress') return contextTools.compress(this, args)
      if (name === 'search_context') return contextTools.searchContext(this, args)
      if (name === 'decompress') return contextTools.decompress(this, args)
      if (name === 'context_status') return contextTools.contextStatus(this)

      // ask_user / task 需要访问本类的状态（挂起的提问、模型调用器），留在类里；
      // todo_write 要落进 todos 并推给界面，也留在类里。其余都是无状态实现，按名字查表。
      if (name === 'ask_user') return await this.toolAskUser(args)
      if (name === 'task') return await subagents.runTask(this, args)
      if (name === 'todo_write') return this.toolTodoWrite(args)
      if (name === 'exit_plan_mode') return await this.toolExitPlanMode(args)

      const isMcp = name.startsWith(MCP_PREFIX)

      // 计划模式：只读调研。改文件、外部 MCP 工具一律拦下；
      // execute_command 例外 —— 只读命令（git status/diff/log、cat、grep、ls……）要放行，
      // 否则 Agent 连项目当前状态都看不到，只能凭空编计划。
      if (this.planMode) {
        if (isMcp) {
          return `已拦截：当前是计划模式（只读），MCP 工具 ${name} 可能产生副作用，不会被执行。请把改动方案写成计划交给用户。`
        }
        if (name === 'write_file' || name === 'edit_file') {
          return `已拦截：当前是计划模式（只读），${name} 不会被执行。请把改动方案写成计划，用 exit_plan_mode 交给用户确认。`
        }
        if (name === 'execute_command' && !guard.isReadOnlyCommand(args?.command)) {
          return `已拦截：计划模式下只能执行只读命令（如 git status / git diff / cat / grep / ls）。这条命令可能改动文件或状态：${String(args?.command || '').slice(0, 120)}\n调研完成后请用 exit_plan_mode 提交计划。`
        }
      }

      if (isMcp) {
        if (!this.mcp) return 'MCP 客户端未初始化'
        return await this.mcp.callTool(name, args)
      }

      const impl = TOOL_IMPL[name]
      if (!impl) return `未知工具: ${name}`

      // 工具实现统一签名 (ctx, args)：projectDir 是相对路径基准，其余几个是回调
      return await impl(
        {
          projectDir: this.projectDir,
          sendDiff: (payload) => this.sendDiff(payload),
          confirmRisk: (blocked, payload) => this.confirmRisk(blocked, payload),
          diagnostics: (fullPath) => this.runDiagnostics(fullPath),
        },
        args,
      )
    } catch (e) {
      return `工具执行错误: ${e.message}`
    }
  }

  /** 改完文件后自动回灌诊断。失败静默 —— 不能因为检查器出问题就中断任务 */
  async runDiagnostics(fullPath) {
    if (!this.autoDiagnostics) return ''
    try {
      const result = await diagnostics.diagnose(this.projectDir, fullPath)
      return diagnostics.format(result, this.projectDir, fullPath)
    } catch {
      return ''
    }
  }

  /** 内置能力清单（设置页展示用）：哪些能力已经原生生效，不需要装扩展 */
  builtinCapabilities() {
    return builtins.list(this)
  }

  // ==================== 配置管理 ====================
  setModelConfig(config) {
    this.modelConfig = { ...this.modelConfig, ...config }
  }

  clearContext() {
    this.context = []
    this.todos = []
    this.sendTodos()
  }

  // ==================== 上下文自动压缩 ====================
  // 具体策略在 context.js，这里只负责在压缩生效后给界面一句提示
  compactContext() {
    const { messages, before, after } = context.compact(this.context, this.modelConfig.maxInputTokens)
    this.context = messages
    if (after < before) {
      this.sendStatus({
        state: 'thinking',
        detail: `上下文较长，已自动压缩（约 ${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k tokens）`,
      })
    }
  }

  getContextUsage() {
    return context.usage(this.context, this.modelConfig)
  }
}

// 界面通信（sendStatus / sendStream / sendToolStatus ...）、交互类工具
// （ask_user / 护栏确认 / todo_write / exit_plan_mode）、模型调用与用量上报
// 都以方法形式混入原型
Object.assign(YuCodeAgent.prototype, events, interactions, modelMethods)

module.exports = YuCodeAgent
