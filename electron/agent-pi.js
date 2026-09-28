/**
 * PiAgent —— 用内置的 pi CLI 当 Agent 后端。
 *
 * 和 YuCodeAgent 是同一位置的替代品：主进程调用它的方法完全一样，
 * 它产出的事件（agent:status / stream / diff / ask / response / usage …）也完全一样，
 * 所以界面不需要知道自己面对的是哪个引擎。差别只在里面：
 * 自研引擎自己调模型、自己跑工具；这里把活全交给 pi，
 * 我们只做两件事 —— 把 pi 的活动翻译成界面的事件，把界面的意图翻译成 pi 的命令。
 *
 * 翻译对照（pi → 界面）：
 *   message_update.thinking_delta   → agent:stream {type:'reasoning'}
 *   message_update.text_delta       → agent:stream {type:'content'}
 *   带 toolCall 的 message_end      → agent:status thinking_output（模型动手前说的话）
 *   tool_execution_start            → agent:status 工具动作
 *   写文件类工具执行前后各读一次文件 → agent:diff
 *   turn_end.message.usage          → agent:usage（流式过程中的估算）
 *   get_session_stats.contextUsage  → agent:usage（真实上下文占用，百分比圈靠它）
 *   agent_settled                   → agent:response + done
 *   extension_ui_request            → agent:ask 卡片，用户回答后回 extension_ui_response
 *
 * 会话：pi 自己把会话按 id 落盘（--session-id / --session-dir），所以
 * 「每个聊天标签一个 pi 会话」是天然的 —— 换标签就是换会话 id，历史由 pi 自己接着。
 * 也正因如此，改模型、切计划模式都不用重建上下文：参数变了就带着同一个
 * session-id 重启进程，pi 会把这段对话原样读回来。
 */

const crypto = require('crypto')
const os = require('os')
const path = require('path')

const { PiRpcSession, trace } = require('./pi-rpc')
const { getPiInfo } = require('./pi')
const { events } = require('./agent-events')
const { unifiedDiff } = require('./edit-engine')
const { registerModel } = require('./pi-agent-model')
const { AskQueue } = require('./pi-agent-ask')
const {
  FILE_TOOLS, TOOL_STATUS, stateOfTool, firstString, textOf, hasToolCall, readTextFile, resultText,
} = require('./pi-agent-tools')
const builtins = require('./builtins')
const checkpoint = require('./checkpoint')
const { readRules } = require('./plan-store')

/** 计划模式：只给只读工具。这正是 pi 的 --tools 白名单的用途 */
const READONLY_TOOLS = 'read,grep,find,ls'

/** 界面把「打开的项目就是你自己的工作区」当默认信任，这里跟它保持一致 */
const PROJECT_TRUST = '-a'

/**
 * 常驻命令护栏。
 *
 * pi 的 shell 工具 timeout 是可选参数且「没有默认超时」，它只等进程自己退出。
 * 模型一旦在前台跑 `npm run dev` 这类永不退出的命令，整轮任务就会永远卡在那里：
 * 界面上只有一条「执行: npm run dev」，任务既不结束也没有下一步 —— 实测能卡十几分钟。
 * pi 支持 --append-system-prompt，把这条规矩补进它自己的提示词，从源头避免。
 */
const LONG_RUNNING_GUARD = `【命令执行护栏（必须遵守）】
- 绝对不要在前台运行「不会自己退出的命令」：开发服务器（npm run dev / vite / next dev / python -m http.server 等）、watch 模式、tail -f、常驻代理服务。它们不会返回，会让任务永久卡住。
- 要起这类常驻命令时，用 run_in_background 工具启动它：它立刻返回 job_id，不阻塞你继续干活。
  例：run_in_background({ command: "npm run dev" })
- 启动之后必须用 bash_output 轮询它的输出（可带 wait_seconds，例如 10），确认服务真的起来了（端口、编译结果、报错），不要凭空假设启动成功，也不要反复空转试探。
- 服务验证完、或改了方案之后，用 kill_shell 收掉它，别让服务一直挂在后台占着端口。
- 一次性命令（构建、测试、lint、类型检查）继续用 bash 前台跑；任何可能超过 60 秒的一次性命令要显式传 timeout。`

/**
 * 运行环境说明。
 *
 * pi 自己的系统提示只带 cwd，一个字都没提平台（vendor/pi 的 system-prompt.js 里
 * 除 cwd 外没有平台段），模型于是按 Linux 习惯写命令：ls 找不存在的目录、apt、
 * ~/.bashrc、纯 Linux 路径……在本机这些大多会直接 Command exited with code N。
 * 自研引擎的 prompt.js 一直写着「当前系统：Windows」，pi 这条路径此前是缺的，补上。
 */
const ENV_PROMPT = `【运行环境（写命令必须按这个来）】
- 当前操作系统是 Windows，不是 Linux / macOS；bash 工具实际跑在 Git Bash 上，POSIX 语法可用（ls、grep、管道、2>/dev/null 都正常）。
- 路径写法：Windows 路径用正斜杠（C:/Users/xxx/project），相对路径直接用；含空格的路径必须加引号。不要假设 /usr、/etc、~/.bashrc 这类 Linux 路径存在。
- 不要用 Linux 专属命令（apt/yum、readlink -f、xdg-open）；判断命令是否存在用 command -v（bash 里）或 where（Windows）。
- 用 ls / find 列目录前先确认路径真实存在；不确定就先 ls 父目录，别猜路径 —— 目录不存在会直接报错中断命令链（&& 之后的都不会执行）。
- 需要 Windows 原生能力（服务、注册表、进程、.ps1 脚本）时改用 powershell 工具，其中错误重定向写 2>$null，不是 2>/dev/null。
- 命令失败先看退出码和报错内容再改写法，不要原样重试。`

/**
 * 项目全局规则（.yucode/rules.md）。
 *
 * 为什么放在这里：pi 没有「每轮重读一段规则」的接口，而项目的硬约束是用户随时
 * 可能改的短文本。做法是把它拼进 --append-system-prompt，并且每次要参数时都重新
 * 读盘 —— 规则一变，_fingerprint() 就变，下一条消息发出前 ensureSession 会自动
 * 带着同一个 session-id 重启 pi 进程（历史由 pi 自己续上），规则当场生效。
 * 所以「每一步执行时读一遍规则」在 pi 引擎上就等于「发消息前比对一次规则」。
 */
function rulesPrompt(projectDir) {
  let rules = ''
  try {
    rules = readRules(projectDir)
  } catch {
    return '' // 规则读不出来不能影响整个会话
  }
  if (!rules) return ''
  return `\n\n【项目全局规则（.yucode/rules.md，用户定下的硬约束，每一步都必须遵守）】\n${rules}`
}

/**
 * 单条命令跑多久就提醒用户一次。
 * 护栏只能降低概率，兜底还得有：真卡在常驻进程上时，界面此前只有「执行: xxx」加一个转圈，
 * 用户分不清是在跑还是死了。超过这个时长主动说一声，并把「点停止可中断」的退路给出来。
 */
const LONG_TOOL_NOTICE_MS = 120000

/**
 * pi 的报错原文 → 用户能照着做的提示。
 * 只翻译「配置类」的失败：这类报错从 pi 那侧看不出是我们的登记没生效，
 * 每次都得到处翻日志才知道，所以直接把下一步动作写出来。
 */
function explainPiFailure(text) {
  const source = String(text || '')
  if (/Model "(.+?)" not found/.test(source)) {
    return 'Pi 不认识这个模型：模型配置没有成功登记到 Pi（~/.pi/agent/models.json）。'
      + '请到「设置 → 模型」给这个模型点「测试」，确认「登记到 Pi」与「Pi 可识别」两步都通过。'
  }
  return ''
}

/**
 * 模型这一轮结束却一个字都没吐（界面上表现为「(无回复)」）→ 说清楚原因。
 *
 * 实测 MiMo（小米）长思考时会这样：thinking 跑了十几分钟，然后 thinking_end →
 * message_end → agent_end 一路正常，但消息里既没有 text 也没有 toolCall。
 * pi 那侧 stopReason 不是 error / length，既不自动重试也不压缩，直接 settled ——
 * 我们此前只能兜底发「(无回复)」，用户完全无从判断发生了什么。
 * 这里按 pi 报的 stopReason 分类，给出原因 + 下一步动作，并附诊断字段。
 */
function describeEmptyReply(info) {
  const stop = info?.stopReason || '（未上报）'
  const thinkSec = info?.thinkMs > 0 ? Math.round(info.thinkMs / 1000) : 0
  const think = thinkSec > 0 ? `（思考约 ${thinkSec} 秒）` : ''
  const diag = `诊断：stopReason=${stop}${info?.rawStopReason ? `，rawStopReason=${info.rawStopReason}` : ''}`
    + `${info?.errorMessage ? `，errorMessage=${info.errorMessage}` : ''}`

  let body
  if (stop === 'length') {
    body = `输出被截断${think}：思考占满了本轮输出额度，没剩下空间写正文。建议重发一次，或在「设置 → 模型」里调低思考长度。`
  } else if (stop === 'error') {
    body = `模型接口报错${think}：${info?.errorMessage || '未知错误'}。多半是服务端超时或限流，稍等重发一次即可。`
  } else if (stop === 'aborted') {
    body = `请求被中断${think}，没有产出正文。`
  } else if (info?.sawReasoning) {
    body = `模型思考结束后没有输出正文${think}。MiMo 这类长思考模型思考过久时偶发（思考吃满额度、但 stopReason 仍报正常结束，pi 不会自动重试）。建议直接重发一次同样的消息；若频繁出现，可在「设置 → 模型」里调低思考长度或换个模型。`
  } else {
    body = `模型返回了空回复${think}，既没有正文也没有工具调用。建议重发一次；若持续如此，检查模型服务是否正常，或换个模型。`
  }
  return `本轮没有生成回复。\n\n${body}\n\n${diag}`
}

/** pi 运行时来自哪里、什么版本：模型类报错时这一行往往是关键线索（跑到了别的 pi 上） */
function describeRuntime() {
  try {
    const info = getPiInfo()
    if (!info.available) return '\n\nPi 运行时：未找到内置 Pi（会退回 PATH 上的 pi，问题多半在这里）'
    const source = info.source === 'bundled' ? '随包内置' : info.source === 'path' ? 'PATH 上自装的 pi' : info.source
    return `\n\nPi 运行时：${source} v${info.version || '未知'}（${info.cliPath}）`
  } catch {
    return ''
  }
}

class PiAgent {
  /**
   * @param mainWindow 主窗口，事件都发到这里
   * @param projectDir 初始工作目录
   * @param opts.sessionDir pi 会话落盘目录（放 userData 下，不去污染用户的 ~/.pi）
   */
  constructor(mainWindow, projectDir, opts = {}) {
    this.mainWindow = mainWindow
    this.projectDir = projectDir || process.cwd()
    this.sessionDir = opts.sessionDir || path.join(os.tmpdir(), 'yucode-pi-sessions')

    this.session = null
    this.starting = null
    this.appliedArgs = ''
    this.busy = false
    this.abortRequested = false

    // 会话身份：同一个「目录 + 聊天标签」始终用同一个 pi 会话 id
    this.chatKey = 'default'
    // 「新建对话」时 +1，等于换一个全新的会话 id
    this.sessionNonce = 0

    this.modelConfig = null
    this.piModel = null
    this.planMode = false
    this.askBeforeRisk = true
    this.autoDiagnostics = true
    this.enabledExtensions = []
    this.mcp = null
    this.checkpoint = null

    /** agent-events 里的 sendTodos 会读这个字段 */
    this.todos = []

    /** 扩展的提问（界面一次只显示一张卡，队列内部串行） */
    this.asks = new AskQueue({
      emitAsk: (card) => this.sendAsk(card),
      reply: (payload) => (this.session ? this.session.send(payload) : Promise.resolve()),
    })

    /** 扩展的进度通知（setStatus / setWidget）上次的文本，用来去重，
     *  否则扩展每帧刷一次 widget 就会把时间线刷满 */
    this.extNotices = new Map()

    this.turn = null
    // 上一轮统计出来的真实上下文占用，用来在流式过程中也显示一个准的百分比
    this.lastInputTokens = 0
    this.lastLimit = 0
    this.lastSpeed = 0
  }

  // ==================== 会话生命周期 ====================

  _sid() {
    const key = `${this.projectDir}|${this.chatKey}|${this.sessionNonce}`
    return crypto.createHash('sha1').update(key).digest('hex').slice(0, 24)
  }

  /** 当前状态该用哪些启动参数。参数一变就意味着要带着同一个 session-id 换个进程 */
  _args() {
    const args = ['--session-id', this._sid(), '--session-dir', this.sessionDir, PROJECT_TRUST]
    if (this.piModel) args.push('--model', `${this.piModel.provider}/${this.piModel.modelId}`)
    if (this.planMode) args.push('--tools', READONLY_TOOLS)
    // 常驻命令护栏：见 LONG_RUNNING_GUARD 的注释；运行环境说明：见 ENV_PROMPT。
    // 项目全局规则每次现读（见 rulesPrompt），规则改了会走指纹变化 → 自动重启会话。
    args.push('--append-system-prompt', `${LONG_RUNNING_GUARD}\n\n${ENV_PROMPT}${rulesPrompt(this.projectDir)}`)
    return args
  }

  _fingerprint() {
    // contextWindow 也进指纹：pi 进程内的模型上限是启动时从 models.json 读的，
    // 服务端报错纠正了上限（_maybeCorrectContextWindow）之后必须让进程重启才认新值 ——
    // 指纹一变就是「带同一 session-id 换个进程」，pi 自己把历史续上。
    return `${this._args().join('\u0000')}\u0000cw:${this.modelConfig?.contextWindow || ''}`
  }

  /**
   * 从服务端报错里学出真实的上下文上限，自动纠正模型配置。
   *
   * 实测场景：设置页默认 contextWindow=200000，本地部署的 llama.cpp 只有 6w 上下文
   * 而这项没改 —— pi 的阈值压缩线是 contextWindow-16384=183616 永远碰不到，静默溢出
   * 检测（input>200000）也永不命中，请求一路涨到撞服务端硬墙：
   *   request (62244 tokens) exceeds the available context size (60160 tokens)
   * 之后每条消息都被 400 拒绝，编辑会话也救不回来（分叉点照样超限）。这里把 60160
   * 捕出来一次性纠正三处：内存 modelConfig、models.json（registerModel）、界面 store
   * （sendModelCorrected → updateModel 持久化，否则下一条消息还会带着旧 200000
   * 把纠正覆盖回去）。下次发消息时指纹已变 → pi 带同 session-id 重启 → 新进程按
   * 60160 算，prompt 前先做阈值压缩（60k > 60160-16384），摘要请求约 40k < 60160
   * 能成功 —— 会话当场自愈，不用用户手动改配置。
   *
   * @param text 任意一段可能来自服务端的错误文本（errorMessage / stderr / status detail）
   * @returns 本次是否真的纠正了配置
   */
  _maybeCorrectContextWindow(text) {
    const m = String(text || '').match(/exceeds the available context size \((\d+)\s*tokens?\)/i)
    if (!m || !this.modelConfig) return false
    const limit = Number(m[1])
    if (!Number.isFinite(limit) || limit <= 0) return false
    const prev = Number(this.modelConfig.contextWindow) || 0
    if (prev === limit) return false // 已纠正过，别重复刷提示

    this.modelConfig = { ...this.modelConfig, contextWindow: limit }
    // 输入上限比真实上限还大时一并对齐：界面用量的分母用的是它，留着旧值分母还是错的
    const maxInput = Number(this.modelConfig.maxInputTokens) || 0
    if (maxInput > limit) this.modelConfig.maxInputTokens = limit

    const res = registerModel(this.modelConfig)
    if (!res.ok) console.error('[pi-agent] 纠正上下文上限后登记失败:', res.error)
    // pi 重启前就按新上限当分母，上下文百分比圈别再按 200000 算
    this.lastLimit = limit

    this.sendStatus({
      state: 'notice',
      noticeType: 'info',
      detail: `服务端实际上下文上限为 ${limit} tokens（模型配置的是 ${prev || '未知'}），已自动纠正；下一条消息会先压缩上下文再继续。`,
    })
    this.sendModelCorrected({
      provider: this.modelConfig.provider || '',
      model: this.modelConfig.model || '',
      baseUrl: this.modelConfig.baseUrl || '',
      contextWindow: limit,
      maxInputTokens: this.modelConfig.maxInputTokens || 0,
    })
    // 任务进行中 _resync 会跳过；下一条消息的 ensureSession 见指纹变了就会重启生效
    this._resync().catch((e) => console.error('[pi-agent] 纠正上限后重启会话失败:', e.message))
    return true
  }

  /** 起会话；参数和当前进程不一致就带着同一个 session-id 重启（上下文由 pi 自己续上） */
  ensureSession() {
    if (this.session && this.session.isRunning() && this.appliedArgs === this._fingerprint()) {
      return this.starting || Promise.resolve()
    }
    if (this.starting) return this.starting
    this.starting = this._boot().catch((e) => {
      console.error('[pi-agent] 启动 pi 会话失败:', e.message)
      throw e
    }).finally(() => { this.starting = null })
    return this.starting
  }

  async _boot() {
    await this._teardown()
    const args = this._args()
    const session = new PiRpcSession({ cwd: this.projectDir, args, persist: true })
    session.onEvent((e) => this._onEvent(e))
    this.session = session
    this.appliedArgs = this._fingerprint()
    await session.start()
    // 把 pi 实际用上的模型记下来：界面选的模型和真正在跑的模型对不上时，这行日志是唯一的线索
    try {
      const state = await session.getState()
      const m = state?.model
      if (m) console.log(`[pi-agent] 会话就绪：模型 ${m.provider}/${m.id}，思考级别 ${state.thinkingLevel || '默认'}`)
    } catch { /* 拿不到不影响对话 */ }
    await this._reportStats()
  }

  async _teardown() {
    const session = this.session
    this.session = null
    this.appliedArgs = ''
    if (session) await session.stop().catch(() => { /* 已经退了就无所谓 */ })
  }

  /** 关掉 pi 子进程（应用退出时调用） */
  async shutdown() {
    await this._teardown()
  }

  /** 参数变了才重启，而且不在任务进行中重启（会打断正在跑的一轮） */
  async _resync() {
    if (!this.session || !this.session.isRunning() || this.busy) return
    if (this.appliedArgs === this._fingerprint()) return
    await this.ensureSession()
  }

  // ==================== 界面推过来的意图 ====================

  async handleMessage(message) {
    this.abortRequested = false
    this.turn = {
      finalText: '', snapshots: new Map(), toolStarts: new Map(), startedAt: Date.now(), output: 0,
      // 只累计「模型真的在吐 token」的时间：genMs 是各次请求的解码时长之和，
      // req* 是当前这次请求的起点/首个增量时间戳。
      genMs: 0, reqStartAt: 0, reqFirstAt: 0, reqLastAt: 0,
      toolTimers: new Map(),
      // 空回复诊断：本轮是否见过思考增量、最后一次 turn_start 时间（算思考时长）、
      // 以及「结束时既无正文也无工具调用」的那条消息的 stopReason 等证据。
      sawReasoning: false, lastTurnStartAt: 0, emptyReply: null,
    }
    this.busy = true

    try { this.checkpoint = checkpoint.create(this.projectDir) } catch { this.checkpoint = null }
    if (this.checkpoint) this.sendCheckpoint(this.checkpoint)

    try {
      await this.ensureSession()
      this.sendStatus({ state: 'thinking', detail: '正在启动 pi…' })
      await this.session.prompt(message)
    } catch (e) {
      this.busy = false
      this._maybeCorrectContextWindow(e.message)
      this.sendStatus({ state: 'error', detail: e.message })
      const hint = explainPiFailure(e.message)
      this.sendResponse(`Pi 启动失败：${e.message}${hint ? `\n\n${hint}` : ''}`)
    }
  }

  interrupt() {
    this.abortRequested = true
    // 挂起的提问必须一并放掉，否则扩展那边会一直等着
    this.asks.drain('(用户中断了任务，未作答)')
    if (this.session?.isRunning()) this.session.abort().catch(() => { /* 进程可能刚好退了 */ })
    this.sendStatus({ state: 'interrupted', detail: '已中断' })
  }

  answerQuestion(id, answer) {
    const current = this.asks.current
    if (!current || current.id !== id) return false
    return this.asks.resolve(answer || '(用户未作答)')
  }

  setModelConfig(config) {
    this.modelConfig = { ...this.modelConfig, ...config }
    const res = registerModel(this.modelConfig)
    if (res.ok) {
      this.piModel = { provider: res.provider, modelId: res.modelId }
    } else if (this.modelConfig.model && this.modelConfig.baseUrl) {
      // 用户确实填了模型却没登记上：必须当场说出来。
      // 否则现象是对话时 pi 报 Model not found 直接退出，看不出根因在登记这一步。
      // 登记失败时保留上一次的 piModel，别把一个本来能用的会话弄坏。
      console.error('[pi-agent] 模型未登记到 Pi:', res.error)
      this.sendStatus({ state: 'error', detail: `模型未登记到 Pi：${res.error}` })
    }
    this._resync().catch((e) => console.error('[pi-agent] 切模型失败:', e.message))
  }

  setProjectDir(dir) {
    if (!dir || dir === this.projectDir) return
    this.projectDir = dir
    // 换目录 = 换会话身份，和 pi 的按项目存会话是一致的
    this.sessionNonce = 0
    this.mcp?.setProjectDir?.(dir)
    this.todos = []
    this.sendTodos()
    this._resync().catch((e) => console.error('[pi-agent] 切目录失败:', e.message))
    this.sendStatus({ state: 'idle', detail: `工作目录: ${dir}` })
  }

  /**
   * 界面切聊天标签 / 切目录时把当前会话告诉主进程。
   * pi 的会话是按 id 存在磁盘上的，所以换 id 就够了 —— 那个标签聊过什么，pi 自己记得。
   */
  loadContext({ chatId } = {}) {
    const key = firstString(chatId) || 'default'
    if (key === this.chatKey) return
    this.chatKey = key
    this.todos = []
    this.sendTodos()
    this._resync().catch((e) => console.error('[pi-agent] 切会话失败:', e.message))
  }

  clearContext() {
    // 换个会话 id 就等于清空：新 id 对应 pi 那边一份全新的空会话
    this.sessionNonce += 1
    this.todos = []
    this.sendTodos()
    this._resync().catch((e) => console.error('[pi-agent] 清空会话失败:', e.message))
  }

  /**
   * 编辑历史消息重跑：让 pi 从那条消息处分叉，它后面的对话就都丢掉了。
   * pi 自己按 session-id 存会话，没法像自研引擎那样直接改上下文，只能用它给的 fork。
   * forkIndex 是这条消息在「用户消息」里的序号；历史被压缩过时会对不上，再按文本兜底。
   */
  async rewind({ forkText, forkIndex } = {}) {
    try {
      await this.ensureSession()
    } catch (e) {
      return { ok: false, error: `pi 会话未就绪：${e.message}` }
    }
    if (!this.session) return { ok: false, error: 'pi 会话未就绪' }

    let list = []
    try { list = await this.session.getForkMessages() } catch { list = [] }

    const text = firstString(forkText)
    let target = null
    if (Number.isInteger(forkIndex) && forkIndex >= 0 && forkIndex < list.length) {
      const byIndex = list[forkIndex]
      if (byIndex && (!text || byIndex.text === text)) target = byIndex
    }
    if (!target && text) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].text === text) { target = list[i]; break }
      }
    }
    if (!target?.entryId) return { ok: false, error: '没找到要分叉的历史消息' }

    try {
      const res = await this.session.fork(target.entryId)
      if (res?.cancelled) return { ok: false, error: '分叉被扩展取消' }
      return { ok: true, text: res?.text || target.text }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  setPlanMode(enabled) {
    const next = Boolean(enabled)
    if (this.planMode !== next) {
      this.planMode = next
      this._resync().catch((e) => console.error('[pi-agent] 切换计划模式失败:', e.message))
    }
    this.sendPlanMode(this.planMode)
    this.sendStatus({
      state: 'idle',
      detail: this.planMode ? '已开启计划模式（pi 只挂只读工具）' : '已关闭计划模式',
    })
  }

  setExtensions(list) {
    this.enabledExtensions = Array.isArray(list) ? list : []
  }

  setRiskConfirm(enabled) {
    this.askBeforeRisk = Boolean(enabled)
  }

  setAutoDiagnostics(enabled) {
    this.autoDiagnostics = Boolean(enabled)
  }

  /** pi 的 MCP 由 pi 自己配置，这里只记着，别让调用方以为是空的 */
  setMcp(mcp) {
    this.mcp = mcp
  }

  builtinCapabilities() {
    return builtins.list(null)
  }

  getContextUsage() {
    const pct = this.lastLimit > 0 ? (this.lastInputTokens / this.lastLimit) * 100 : 0
    return { tokens: this.lastInputTokens, contextWindow: this.lastLimit, percent: pct }
  }

  /** 给设置页看：pi 当前跑在什么模型上、有哪些命令可用 */
  async describe() {
    if (!this.session?.isRunning()) return { running: false }
    try {
      const [state, commands] = await Promise.all([this.session.getState(), this.session.getCommands()])
      return {
        running: true,
        model: state?.model ? `${state.model.provider}/${state.model.id}` : '',
        contextWindow: state?.model?.contextWindow || 0,
        thinkingLevel: state?.thinkingLevel || '',
        sessionId: state?.sessionId || '',
        commands: (commands || []).map((c) => c.name),
      }
    } catch (e) {
      return { running: false, error: e.message }
    }
  }

  // ==================== pi 事件 → 界面事件 ====================

  _onEvent(e) {
    switch (e.type) {
      case 'turn_start':
        // 新的一次模型请求开始：记下起点。reqFirstAt 会在收到首个增量时覆盖它，
        // 这样首字等待（预填充）不算进解码耗时。
        if (this.turn) {
          this.turn.reqStartAt = Date.now()
          this.turn.reqFirstAt = 0
          this.turn.reqLastAt = 0
          // 最后一次 turn_start：空回复时用它算「模型思考了多久」
          this.turn.lastTurnStartAt = this.turn.reqStartAt
        }
        this.sendStatus({ state: 'thinking', detail: '正在调用模型...' })
        break
      case 'message_update':
        this._onUpdate(e.assistantMessageEvent)
        break
      case 'message_end':
        this._onMessageEnd(e.message)
        break
      case 'tool_execution_start':
        this._onToolStart(e)
        break
      case 'tool_execution_update':
        this._onToolUpdate(e)
        break
      case 'tool_execution_end':
        this._onToolEnd(e)
        break
      case 'turn_end':
        this._onTurnEnd(e)
        break
      case 'agent_settled':
        this._onSettled()
        break
      case 'compaction_start':
        // 过程时间线里也记一条：否则只有结束时的结果，中间这段（可能几十秒）看着像卡住了
        this.sendStatus({ state: 'notice', detail: '正在压缩上下文…', noticeType: 'info' })
        // 顶部状态条照旧显示压缩中
        this.sendStatus({ state: 'thinking', detail: '上下文较长，pi 正在压缩…' })
        break
      case 'compaction_end':
        this._onCompactionEnd(e)
        break
      case 'auto_retry_start':
        this.sendStatus({ state: 'thinking', detail: `请求失败，第 ${e.attempt}/${e.maxAttempts} 次重试…` })
        break
      case 'auto_retry_end':
        // 重试结束同样要说一声，否则界面上会停在「正在重试…」
        if (!e.success) this._maybeCorrectContextWindow(e.finalError)
        this.sendStatus({
          state: e.success ? 'notice' : 'error',
          detail: e.success ? `第 ${e.attempt} 次重试成功` : `重试失败：${e.finalError || '未知错误'}`,
          noticeType: e.success ? 'info' : 'error',
        })
        break
      case 'summarization_retry_scheduled':
        this._maybeCorrectContextWindow(e.errorMessage)
        this.sendStatus({
          state: 'notice',
          detail: `摘要失败（${e.errorMessage || '未知错误'}），第 ${e.attempt}/${e.maxAttempts} 次重试…`,
          noticeType: 'warning',
        })
        break
      case 'extension_error':
        // 扩展自己抛错时 pi 只发这个事件，接不住就完全看不见
        this.sendStatus({
          state: 'notice',
          detail: `扩展出错（${e.event || 'unknown'}）：${e.error || '未知错误'}`,
          noticeType: 'error',
        })
        break
      case 'extension_ui_request':
        this._onUiRequest(e)
        break
      case 'pi_exit':
        this._onExit(e)
        break
      default:
        break
    }
  }

  _onUpdate(update) {
    if (!update) return
    // 任何带增量的帧（text_delta / thinking_delta / toolcall_delta）都算「正在生成」。
    // 记下本次请求的首个与最后一个增量时间戳，用来算真实解码速度。
    if (this.turn && update.delta) {
      const now = Date.now()
      if (!this.turn.reqFirstAt) this.turn.reqFirstAt = now
      this.turn.reqLastAt = now
    }
    if (update.type === 'thinking_delta' && update.delta) {
      if (this.turn) this.turn.sawReasoning = true
      this.sendStream({ type: 'reasoning', text: update.delta })
    } else if (update.type === 'text_delta' && update.delta) {
      this.sendStream({ type: 'content', text: update.delta })
    } else if (update.type === 'toolcall_start') {
      // 模型开始写这次工具调用的参数：这时候就知道它要去改文件了。
      // 先亮出「正在编辑」，不然参数生成（可能好几秒）全被说成「正在调用模型…」；
      // 真正执行时 tool_execution_start 会带着文件名并进同一条。
      const state = stateOfTool(update.toolName)
      if (state) {
        this.sendStatus({ state, detail: '', toolCallId: update.id, toolName: update.toolName })
      }
    } else if (update.type === 'error') {
      this._maybeCorrectContextWindow(update.error || update.reason || update.message)
      this.sendStatus({ state: 'error', detail: update.error || update.reason || update.message || '模型返回了错误' })
    }
  }

  /** 带着工具调用的那一轮正文，是模型「动手前说的话」，单独作为一段插入时间线 */
  _onMessageEnd(message) {
    // 服务端 400（上下文超限）会挂在 errorMessage 上，任何分支前先拿它纠正上限
    if (message?.errorMessage) this._maybeCorrectContextWindow(message.errorMessage)
    if (message?.role !== 'assistant' || !this.turn) return
    const text = textOf(message)
    if (!text) {
      // 正文为空：带 toolCall 是「动手前没话说」，正常；既无正文也无工具调用则是
      // 模型这轮压根没吐字 —— 必须留下 stopReason 等证据，否则 settled 后只剩「(无回复)」。
      if (!hasToolCall(message)) {
        // 思考过没有：既看流式增量，也看消息自带的 reasoning 块（增量可能很稀疏）
        const blocks = Array.isArray(message.content) ? message.content : []
        const info = {
          stopReason: message.stopReason || '',
          rawStopReason: message.rawStopReason || '',
          errorMessage: message.errorMessage || '',
          thinkMs: this.turn.lastTurnStartAt ? Date.now() - this.turn.lastTurnStartAt : 0,
          sawReasoning: this.turn.sawReasoning || blocks.some((b) => b?.type === 'reasoning'),
        }
        this.turn.emptyReply = info
        trace('empty_reply', info)
        console.error('[pi-agent] 本轮无回复:', JSON.stringify(info))
      }
      return
    }
    this.turn.emptyReply = null
    if (hasToolCall(message)) this.sendStatus({ state: 'thinking_output', detail: text })
    else this.turn.finalText = text
  }

  _onToolStart(e) {
    const mapper = TOOL_STATUS[e.toolName]
    // 名字认得出来就说人话，认不出来（扩展自带的工具）老实报工具名，
    // 但别混进「已执行」里 —— 那是在说命令，不是在说工具。
    this.sendStatus({
      ...(mapper ? mapper(e.args || {}) : { state: 'tool', detail: e.toolName }),
      toolCallId: e.toolCallId,
      toolName: e.toolName,
    })
    if (this.turn) this.turn.toolStarts.set(e.toolCallId, Date.now())
    // 常驻命令兜底提醒：pi 的 shell 工具没有默认超时，命令不退出就永远等下去，
    // 界面会一直停在「执行: xxx」。超过两分钟主动说清楚，并告诉用户怎么中断。
    if (this.turn && (e.toolName === 'bash' || e.toolName === 'powershell')) {
      const id = e.toolCallId
      const timer = setTimeout(() => {
        if (!this.turn || !this.turn.toolStarts.has(id)) return
        this.turn.toolTimers.delete(id)
        this.sendStatus({
          state: 'notice',
          noticeType: 'warning',
          detail: `命令已运行超过 ${LONG_TOOL_NOTICE_MS / 60000} 分钟还没结束，可能卡在不会自己退出的常驻进程上（如 npm run dev）。需要中断请点「停止」。`,
        })
      }, LONG_TOOL_NOTICE_MS)
      timer.unref?.()
      this.turn.toolTimers.set(id, timer)
    }
    if (!FILE_TOOLS.has(e.toolName) || !this.turn) return

    const file = firstString(e.args?.path, e.args?.file_path, e.args?.file)
    if (!file) return
    const abs = path.isAbsolute(file) ? file : path.join(this.projectDir, file)
    this.turn.snapshots.set(e.toolCallId, { file: abs, before: readTextFile(abs) })
  }

  /** pi 给的是「最新的部分结果」而不是增量，替换着显示，长命令的输出就能实时看到 */
  _onToolUpdate(e) {
    const text = resultText(e.partialResult)
    if (!text) return
    this.sendStatus({ state: 'tool_output', detail: text.slice(-8000), toolCallId: e.toolCallId })
  }

  /** 写文件类工具跑完：前后内容都在手上，直接算 diff 给界面，不用等模型自述 */
  _onToolEnd(e) {
    const startedAt = this.turn?.toolStarts.get(e.toolCallId)
    if (this.turn) this.turn.toolStarts.delete(e.toolCallId)
    // 命令正常收尾了，兜底提醒就别再响
    const guard = this.turn?.toolTimers?.get(e.toolCallId)
    if (guard) {
      clearTimeout(guard)
      this.turn.toolTimers.delete(e.toolCallId)
    }
    // 工具说完了，界面上那条也要收尾：成功打勾、失败把原因带上（失败原因以前看不见）
    this.sendStatus({
      state: 'tool_end',
      detail: e.isError ? resultText(e.result).slice(-500) : '',
      toolCallId: e.toolCallId,
      isError: Boolean(e.isError),
      durationMs: startedAt ? Date.now() - startedAt : undefined,
    })
    if (!this.turn || e.isError) return

    const snap = this.turn.snapshots.get(e.toolCallId)
    if (!snap) return
    this.turn.snapshots.delete(e.toolCallId)

    const after = readTextFile(snap.file)
    if (after === null || after === snap.before) return
    const rel = path.relative(this.projectDir, snap.file).replace(/\\/g, '/')

    if (snap.before === null) {
      this.sendDiff({ filePath: rel, patch: '', added: after.split('\n').length, removed: 0, created: true })
      return
    }
    const { patch, added, removed } = unifiedDiff(snap.before, after, rel)
    if (patch) this.sendDiff({ filePath: rel, patch, added, removed, created: false })
  }

  /** 压缩结束要给出前后 token，不然界面上只看到「正在压缩…」然后就没了 */
  _onCompactionEnd(e) {
    // 「上下文压缩失败」很可能就是上限配大了导致的：先纠正，busy 判断放后面
    if (e.errorMessage) this._maybeCorrectContextWindow(e.errorMessage)
    if (!this.busy) return
    if (e.aborted) {
      this.sendStatus({ state: 'notice', detail: '上下文压缩已中止', noticeType: 'warning' })
      return
    }
    if (!e.result) {
      this.sendStatus({
        state: 'notice',
        detail: `上下文压缩失败：${e.errorMessage || '未知错误'}`,
        noticeType: 'error',
      })
      return
    }
    this.sendStatus({
      state: 'notice',
      detail: `上下文已压缩（${e.result.tokensBefore ?? '?'} → ${e.result.estimatedTokensAfter ?? '?'} tokens）`,
      noticeType: 'info',
    })
  }

  /**
   * 每次模型请求结束：累计真实用量，并刷新解码速度。
   *
   * 速度的口径要跟本地推理服务面板（如 llama.cpp / vLLM 报的 tok/s）一致：
   * 分子是这次任务真正生成出来的 token，分母只算「模型在解码」的那段时间。
   * 之前用的是「从任务开始到现在的全部耗时」，里面塞满了工具执行、读文件、等用户
   * 回答这些完全不产 token 的空转，于是显示的 30 tok/s 会远低于模型本身的 50 tok/s。
   */
  _onTurnEnd(e) {
    if (!this.turn) return
    const usage = e.message?.usage
    if (!usage) return

    const inputNow = (usage.input || 0) + (usage.cacheRead || 0)
    if (inputNow > 0) this.lastInputTokens = inputNow
    this.turn.output += usage.output || 0

    // 本次请求的解码窗口：首个增量 → 最后一个增量。一个增量都没收到（少见）时
    // 退回「本次请求起点 → 现在」，宁可把首字等待算进去，也别把这次输出漏掉。
    const now = Date.now()
    const winStart = this.turn.reqFirstAt || this.turn.reqStartAt
    if (winStart) this.turn.genMs += Math.max(0, (this.turn.reqLastAt || now) - winStart)
    this.turn.reqStartAt = 0
    this.turn.reqFirstAt = 0
    this.turn.reqLastAt = 0

    // 一次都没量到解码时间时退回旧口径，免得速度显示成离谱的巨值
    const busyMs = this.turn.genMs || (now - this.turn.startedAt)
    const seconds = Math.max(0.2, busyMs / 1000)
    this.lastSpeed = Math.round(this.turn.output / seconds)
    this.sendUsage({
      inputTokens: this.lastInputTokens,
      outputTokens: this.turn.output,
      inputLimit: this.lastLimit,
      contextWindow: this.lastLimit,
      tokensPerSecond: this.lastSpeed,
      live: true,
    })
  }

  async _reportStats() {
    if (!this.session?.isRunning()) return
    try {
      const stats = await this.session.getSessionStats()
      const usage = stats?.contextUsage || {}
      this.lastInputTokens = usage.tokens || 0
      this.lastLimit = usage.contextWindow || 0
      this.sendUsage({
        inputTokens: this.lastInputTokens,
        outputTokens: stats?.tokens?.output ?? this.turn?.output ?? 0,
        inputLimit: this.lastLimit,
        contextWindow: this.lastLimit,
        tokensPerSecond: this.lastSpeed,
        live: false,
      })
    } catch { /* 统计拿不到不影响对话，界面保留上一次的数字 */ }
  }

  async _onSettled() {
    if (!this.busy) return
    this.busy = false

    let text = this.turn?.finalText || ''
    if (!text) text = await this.session.getLastAssistantText().catch(() => '')
    // 到这还是空、且 message_end 留下了「无正文无工具」的证据 → 把原因说清楚，
    // 不再发干巴巴的「(无回复)」；时间线上也记一条 warning，用户至少知道发生过什么。
    if (!text && this.turn?.emptyReply) {
      const info = this.turn.emptyReply
      text = describeEmptyReply(info)
      const thinkSec = info.thinkMs > 0 ? `，思考约 ${Math.round(info.thinkMs / 1000)} 秒` : ''
      this.sendStatus({
        state: 'notice',
        detail: `模型本轮没有输出正文（stopReason=${info.stopReason || '未知'}${thinkSec}），原因见回复`,
        noticeType: 'warning',
      })
    }
    await this._reportStats()

    if (this.abortRequested) text = `${text}\n\n（已中断）`.trim()
    this.sendStatus({ state: 'done' })
    this.sendResponse(text || '(无回复)')
    this.turn = null
  }

  _onExit(e) {
    this._maybeCorrectContextWindow(e.stderr)
    this._maybeCorrectContextWindow(e.error)
    if (!this.busy) return
    this.busy = false
    const hint = explainPiFailure(e.stderr)
    const detail = e.error || `pi 进程已退出（code=${e.code}）`
    this.sendStatus({ state: 'error', detail: hint || detail })
    this.sendResponse(`Pi 进程退出了：${detail}${hint ? `\n\n${hint}` : ''}${e.stderr ? `\n\n${String(e.stderr).slice(-800)}` : ''}${describeRuntime()}`)
    this.turn = null
  }

  // ==================== 扩展 UI 请求 ====================

  _onUiRequest(e) {
    if (e.method === 'notify') {
      if (e.message) this.sendStatus({ state: 'notice', detail: String(e.message), noticeType: e.notifyType })
      return
    }
    // 扩展在状态栏/挂件里汇报自己的进度时，这是它唯一说明「我在干什么」的通道，
    // 记进时间线；文本为空表示清除，跳过。
    if (e.method === 'setStatus') {
      this._extNotice(`status:${e.statusKey || ''}`, e.statusText)
      return
    }
    if (e.method === 'setWidget') {
      const lines = Array.isArray(e.widgetLines) ? e.widgetLines.join('\n') : ''
      this._extNotice(`widget:${e.widgetKey || ''}`, lines)
      return
    }
    // setTitle / set_editor_text 与过程无关；要用户作答的进队列
    this.asks.push(e)
  }

  /** 扩展进度通知：同一段文本只记一次，否则扩展每帧刷一次就会把时间线刷满 */
  _extNotice(key, text) {
    const value = String(text || '').trim().slice(0, 2000)
    if (!value || this.extNotices.get(key) === value) return
    this.extNotices.set(key, value)
    this.sendStatus({ state: 'notice', detail: value, noticeType: 'info' })
  }
}

// 与界面通信的方法（sendStatus / sendStream / sendDiff / sendAsk …）与自研引擎完全共用，
// 这正是「界面零改动」的关键：换的是引擎，不是协议。
Object.assign(PiAgent.prototype, events)

module.exports = PiAgent
