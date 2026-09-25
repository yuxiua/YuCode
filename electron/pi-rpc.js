/**
 * Pi RPC 会话 —— 把内置的 pi CLI 当长驻子进程驱动起来。
 *
 * 这是本应用与 Pi 的唯一接口。之所以走 `--mode rpc` 而不是自己实现 Agent：
 * Pi 的扩展（pi-subagents / pi-lens / pi-plan-mode / cc-safety-net …）都是插进
 * Pi 运行时 API 的模块，只有在 Pi 进程里才能生效。我们负责「把它的能力显示出来」，
 * 它负责「把能力做出来」。
 *
 * 协议要点（来自 pi 自带的 docs/rpc.md、docs/json.md）：
 *   - stdin 收命令：{"id","type","...参数"}，一行一条，LF 结尾
 *   - stdout 出两种记录：type=response（对某条命令的应答，带同一个 id）
 *     和会话事件（agent_start / message_update / tool_execution_* / agent_settled …）
 *   - 分帧只能用 LF 切，且不能用 readline —— readline 还会在 U+2028/U+2029 上切分，
 *     而这两个字符在 JSON 字符串里是合法的，会把记录切坏。所以这里手写缓冲切分。
 *   - stdout 只走协议数据，日志和报错都在 stderr，不能当协议解析
 *   - 关掉 stdin 就是请求有序退出
 */

const { spawn } = require('child_process')
const { StringDecoder } = require('string_decoder')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { getPiInfo } = require('./pi')

// 排查用：把 pi 的原始事件与界面发出的状态按时间顺序写进同一个文件。
// 「过程没显示出来」时，看这个文件就能判断是 pi 没发、还是我们没翻译。
// 设环境变量 YU_CODE_TRACE=0 关闭。稳定后应删掉这里与所有调用点。
const TRACE_FILE = path.join(os.tmpdir(), 'yu-code-pi-trace.log')
let traceStarted = false
// 上一次记下的流式增量类型，用来把连续的同类增量合并成一行
let traceLastDelta = ''

function trace(scope, data) {
  if (process.env.YU_CODE_TRACE === '0') return
  try {
    if (!traceStarted) {
      fs.writeFileSync(TRACE_FILE, `# ${new Date().toISOString()}\n`)
      traceStarted = true
    }
    fs.appendFileSync(TRACE_FILE, `${new Date().toISOString().slice(11, 23)} ${scope} ${JSON.stringify(data)}\n`)
  } catch { /* 排查用，写不进去也不能影响正常流程 */ }
}

// 单条命令的默认超时。用 RPC 时很多命令是「受理即返回」，真正的耗时在事件流里，
// 所以这个只用来兜底「命令根本没被应答」的情况。
const DEFAULT_TIMEOUT = 30000
// stderr 只保留尾部若干行，用于把启动失败的原因展示给用户
const STDERR_TAIL = 40

class PiRpcSession {
  /**
   * @param {object} opts
   * @param {string} opts.cwd        pi 的工作目录（即用户打开的项目）
   * @param {string[]} [opts.args]   追加到 `pi --mode rpc` 后面的参数
   * @param {object} [opts.env]      追加的环境变量
   * @param {boolean} [opts.persist] true 用磁盘会话，false 用内存会话（默认）
   */
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd()
    this.extraArgs = opts.args || []
    this.extraEnv = opts.env || {}
    this.persist = Boolean(opts.persist)

    this.child = null
    this.decoder = new StringDecoder('utf8')
    this.buffer = ''
    this.pending = new Map()
    this.listeners = new Set()
    this.stderrTail = []
    this.seq = 0

    /** 进程退出信息；未退出为 null */
    this.exit = null
    this.startPromise = null
    this.stopPromise = null
    /** 子进程还没起来时也要把命令排好队，起来后按序发出 */
    this.ready = false
  }

  // ==================== 生命周期 ====================

  isRunning() {
    return Boolean(this.child) && this.exit === null
  }

  /** 启动并完成握手。重复调用返回同一个 Promise。 */
  start() {
    if (this.startPromise) return this.startPromise
    this.startPromise = this._spawn().then(() => this._handshake())
    return this.startPromise
  }

  _spawn() {
    const info = getPiInfo()
    if (!info.available) {
      return Promise.reject(new Error('没有找到 pi CLI，无法启动 Pi 会话'))
    }
    const args = [info.cliPath, '--mode', 'rpc']
    if (!this.persist) args.push('--no-session')
    args.push(...this.extraArgs)

    const child = spawn(info.nodePath, args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    child.stdout.on('data', (chunk) => this._onStdout(chunk))
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.stderrTail.push(line.trim())
      }
      if (this.stderrTail.length > STDERR_TAIL) {
        this.stderrTail = this.stderrTail.slice(-STDERR_TAIL)
      }
    })
    child.stdin.on('error', () => { /* 进程已退出时的写入报错，交给 exit 统一处理 */ })

    child.on('error', (err) => this._onExit(-1, null, err.message))
    child.on('exit', (code, signal) => this._onExit(code, signal, ''))

    return Promise.resolve()
  }

  /** 探活：能正常回答 get_state 才算真的起来了 */
  async _handshake() {
    try {
      await this.request('get_state', {}, { timeout: 20000 })
      this.ready = true
    } catch (err) {
      const detail = this.stderrTail.join('\n')
      this.stop()
      throw new Error(detail ? `${err.message}\n${detail}` : err.message)
    }
  }

  _onExit(code, signal, spawnError) {
    if (this.exit) return
    this.exit = { code, signal, spawnError, stderr: this.stderrTail.join('\n') }
    this.ready = false
    const reason = spawnError || `pi 进程已退出（code=${code}${signal ? ` signal=${signal}` : ''}）`
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.pending.clear()
    this._emit({ type: 'pi_exit', code, signal, error: spawnError || '', stderr: this.exit.stderr })
  }

  /** 关 stdin 请求有序退出；超时还没走就强杀 */
  async stop() {
    if (this.stopPromise) return this.stopPromise
    const child = this.child
    if (!child) {
      this.child = null
      return
    }
    this.stopPromise = new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已经没了 */ }
        resolve()
      }, 3000)
      child.once('exit', done)
      try { child.stdin.end() } catch { done() }
    })
    await this.stopPromise
    this.child = null
    this.startPromise = null
    this.stopPromise = null
    return undefined
  }

  // ==================== 事件 ====================

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  _emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (e) {
        console.error('[pi-rpc] 事件监听器抛错:', e.message)
      }
    }
  }

  // ==================== 收数据 ====================

  _onStdout(chunk) {
    this.buffer += this.decoder.write(chunk)
    let idx
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line.trim()) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        // 协议外的噪音（不该出现）不该弄死整个会话，记下来继续读
        console.error('[pi-rpc] 无法解析的记录:', line.slice(0, 200))
        continue
      }
      this._dispatch(record)
    }
  }

  _dispatch(record) {
    if (record.type !== 'response') {
      // 只记类型与关键字段，不记正文，日志才不会被工具输出撑爆。
      // message_update 是按 token 来的，只在「增量类型变了」时记一行，避免日志爆炸。
      if (record.type === 'message_update') {
        const kind = record.assistantMessageEvent && record.assistantMessageEvent.type
        if (kind !== traceLastDelta) {
          traceLastDelta = kind
          trace('pi', { type: 'message_update', delta: kind })
        }
      } else {
        traceLastDelta = ''
        trace('pi', {
          type: record.type,
          tool: record.toolName,
          method: record.method,
          statusKey: record.statusKey,
        })
      }
    }
    if (record.type === 'response') {
      const entry = this.pending.get(record.id)
      if (entry) {
        clearTimeout(entry.timer)
        this.pending.delete(record.id)
        if (record.success === false) {
          entry.reject(new Error(record.error || `${record.command} 执行失败`))
        } else {
          entry.resolve(record.data)
        }
        return
      }
      // 没有对应请求的应答（比如解析失败的无 id 应答）当事件抛给界面，便于显示
      this._emit(record)
      return
    }
    this._emit(record)
  }

  // ==================== 发命令 ====================

  /** 写一行 JSON 到 stdin，尊重背压 */
  _write(record) {
    const line = `${JSON.stringify(record)}\n`
    return new Promise((resolve, reject) => {
      try {
        if (this.child.stdin.write(line)) resolve()
        else this.child.stdin.once('drain', resolve)
      } catch (e) {
        reject(e)
      }
    })
  }

  /**
   * 发一条命令并等它的应答。命令 id 自动分配，所以调用方不用管关联。
   * @returns {Promise<any>} response.data
   */
  async request(type, payload = {}, { timeout = DEFAULT_TIMEOUT } = {}) {
    if (!this.child || this.exit) {
      throw new Error(this.exit?.spawnError || 'pi 会话没有在运行')
    }
    const id = `r${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${type} 超时（${timeout}ms）未收到应答`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this._write({ id, type, ...payload }).catch((e) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      })
    })
  }

  // ==================== 常用命令 ====================

  /** 发提示词。应答只代表「已受理」，正文与工具过程都走事件流 */
  prompt(message, images) {
    const payload = { message }
    if (images && images.length) payload.images = images
    return this.request('prompt', payload)
  }

  /**
   * 发一条不需要应答的记录。extension_ui_response 走这里 ——
   * 它是事件（不是命令），pi 不会给它回一条 response。
   */
  send(record) {
    if (!this.child || this.exit) return Promise.reject(new Error('pi 会话没有在运行'))
    return this._write(record)
  }

  abort() { return this.request('abort') }
  clearQueue() { return this.request('clear_queue') }
  getState() { return this.request('get_state') }
  getSessionStats() { return this.request('get_session_stats') }
  getLastAssistantText() { return this.request('get_last_assistant_text').then((d) => d.text || '') }

  // 下面几个 pi 的应答都包了一层容器字段，这里直接拆出来，调用方拿到的就是数组
  getMessages() { return this.request('get_messages').then((d) => d.messages) }
  getAvailableModels() { return this.request('get_available_models').then((d) => d.models) }
  getAvailableThinkingLevels() {
    return this.request('get_available_thinking_levels').then((d) => d.levels)
  }
  getCommands() { return this.request('get_commands').then((d) => d.commands) }
  getForkMessages() { return this.request('get_fork_messages').then((d) => d.messages) }

  setThinkingLevel(level) { return this.request('set_thinking_level', { level }) }
  compact(customInstructions) {
    return this.request('compact', customInstructions ? { customInstructions } : {}, { timeout: 180000 })
  }
  setAutoCompaction(enabled) { return this.request('set_auto_compaction', { enabled }) }
  setAutoRetry(enabled) { return this.request('set_auto_retry', { enabled }) }
  newSession() { return this.request('new_session') }
  setSessionName(name) { return this.request('set_session_name', { name }) }
  /** 从某条历史消息处分叉（这就是「编辑之前的问题重发」的正解） */
  fork(entryId) { return this.request('fork', { entryId }) }
  getEntries(since) { return this.request('get_entries', since ? { since } : {}) }
  exportHtml(outputPath) { return this.request('export_html', outputPath ? { outputPath } : {}, { timeout: 60000 }) }

  /** model 既可以给 "provider/id"，也可以分别给 provider 与 modelId */
  setModel({ provider, modelId }) {
    return this.request('set_model', { provider, modelId })
  }
}

module.exports = { PiRpcSession, trace }
