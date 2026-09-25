/**
 * MCP（Model Context Protocol）客户端 —— 原生自研，不依赖 pi CLI、不执行任何第三方扩展代码。
 *
 * 作用：把外部 MCP server 的工具接进 Agent。每个 server 是一个子进程，通过 stdio 用
 * 换行分隔的 JSON-RPC 2.0 通信（传输层在 jsonrpc.js）。连上后拉 tools/list，
 * 把每个工具包装成 OpenAI function calling 格式注册给模型，名字统一加 `mcp__<server>__` 前缀。
 *
 * 随应用内置一个完全离线的 git server（mcp-servers/git-tools.js），所以装完开箱即有 MCP 能力。
 */

const fs = require('fs')
const path = require('path')
const { createClient } = require('./jsonrpc')

const PROTOCOL_VERSION = '2024-11-05'
const TOOL_PREFIX = 'mcp__'
const CLIENT_INFO = { name: 'yu-code', version: '1.0.0' }
const CONNECT_TIMEOUT = 25000
const CALL_TIMEOUT = 180000 // MCP 工具可能跑很久（拉数据、跑查询），给足时间

/** 内置 server：随包发布，不需要联网、不需要用户装任何东西 */
const BUILTIN_SERVERS = [
  {
    id: 'git',
    name: 'Git（内置）',
    description: '读取当前工作目录的 git 状态、diff、提交历史、blame。只读，随应用内置',
    builtin: true,
    enabled: true,
    // 用 Electron 自带的 Node 跑这个脚本（ELECTRON_RUN_AS_NODE）：
    // 用户机器上没装 node 也能用，打包后不依赖任何外部运行时。
    // 命令与脚本路径都过 quoteShellArg —— 安装目录形如 "C:\...\Yu Code\..."，带空格。
    command: process.execPath,
    args: [path.join(__dirname, 'mcp-servers', 'git-tools.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  },
]

/**
 * Windows 上 spawn 走 shell:true，Node 不会给带空格的参数补引号，
 * "C:\...\Yu Code\git-tools.js" 会被拆成两个参数。这里补上引号。
 * 已经带引号的（用户自己写的）原样返回，避免套两层引号。
 */
function quoteShellArg(value) {
  const s = String(value ?? '')
  if (process.platform !== 'win32' || !/\s/.test(s)) return s
  return s.startsWith('"') ? s : `"${s}"`
}

/** 名字里的非法字符换成下划线：工具名要能安全出现在 prompt 与函数调用里 */
function sanitize(name) {
  return String(name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_')
}

function toolFullName(serverId, toolName) {
  return `${TOOL_PREFIX}${sanitize(serverId)}__${sanitize(toolName)}`
}

/** inputSchema 直接当 function calling 的 parameters 用；缺字段时补成合法的空对象 */
function toSchema(serverId, tool) {
  let parameters = tool.inputSchema
  if (!parameters || typeof parameters !== 'object') parameters = { type: 'object', properties: {} }
  else if (parameters.type !== 'object') parameters = { ...parameters, type: 'object' }
  if (!parameters.properties) parameters = { ...parameters, properties: {} }

  return {
    type: 'function',
    function: {
      name: toolFullName(serverId, tool.name),
      description: `[MCP:${serverId}] ${tool.description || tool.name}`,
      parameters,
    },
  }
}

/** MCP 的返回是 content 数组，这里压成一段给模型看的纯文本 */
function formatResult(result) {
  if (!result) return '(MCP 工具没有返回内容)'
  const parts = Array.isArray(result.content) ? result.content : []
  const text = parts
    .map((c) => {
      if (typeof c === 'string') return c
      if (c?.type === 'text') return c.text || ''
      if (c?.type === 'image') return `（返回了一张图片，模型看不到）`
      if (c?.type === 'resource') return `（返回了资源 ${c.resource?.uri || ''}）`
      return ''
    })
    .filter(Boolean)
    .join('\n')
  const body = text.trim() || '(MCP 工具没有返回可读文本)'
  return result.isError ? `MCP 工具执行失败：${body}` : body
}

class McpManager {
  /** @param configPath 用户配置落盘路径（userData 下），内置 server 不写进去 */
  constructor(configPath) {
    this.configPath = configPath || ''
    this.custom = []
    // 内置 server 的启用状态：存「被禁用的 id」而不是存整份副本，
    // 这样内置项的 command/args 升级后不会被用户配置里的旧副本覆盖
    this.builtinDisabled = new Set()
    this.connections = new Map() // serverId → { client, status, tools, error, stderr }
    this.projectDir = process.cwd()
    this.load()
  }

  // ---------------------------------------------------------------- 配置

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'))
      this.custom = Array.isArray(raw?.servers) ? raw.servers.filter((s) => s && s.id && s.command) : []
      this.builtinDisabled = new Set(Array.isArray(raw?.builtinDisabled) ? raw.builtinDisabled : [])
    } catch {
      this.custom = [] // 文件不存在或损坏：只用内置 server
      this.builtinDisabled = new Set()
    }
  }

  save() {
    if (!this.configPath) return
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
      const tmp = `${this.configPath}.tmp`
      const data = { servers: this.custom, builtinDisabled: [...this.builtinDisabled] }
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
      fs.renameSync(tmp, this.configPath)
    } catch (e) {
      console.error('[mcp] 配置保存失败:', e.message)
    }
  }

  /** 内置 + 用户自定义合并 */
  allServers() {
    const builtins = BUILTIN_SERVERS.map((s) => ({ ...s, enabled: !this.builtinDisabled.has(s.id) }))
    return [...builtins, ...this.custom]
  }

  findServer(id) {
    return this.allServers().find((s) => s.id === id) || null
  }

  /** 设置页用：每个 server 的配置 + 当前连接状态 + 已发现的工具 */
  listServers() {
    return this.allServers().map((s) => {
      const conn = this.connections.get(s.id)
      return {
        id: s.id,
        name: s.name || s.id,
        description: s.description || '',
        builtin: Boolean(s.builtin),
        enabled: s.enabled !== false,
        command: s.command,
        args: s.args || [],
        status: conn?.status || 'idle',
        error: conn?.error || '',
        stderr: conn?.stderr || '',
        tools: (conn?.tools || []).map((t) => ({ name: toolFullName(s.id, t.name), raw: t.name, description: t.description || '' })),
      }
    })
  }

  addServer({ name, command, args, env }) {
    const id = sanitize(name || command || '').toLowerCase()
    if (!id) return { ok: false, error: '需要提供 name 或 command' }
    if (!command) return { ok: false, error: '需要提供 command' }
    if (this.allServers().some((s) => s.id === id)) return { ok: false, error: `已存在同名 server：${id}` }
    // args 允许传数组（推荐）或字符串；字符串按空格拆开，够用即可
    const argList = Array.isArray(args) ? args.map(String) : String(args || '').split(/\s+/).filter(Boolean)
    this.custom.push({ id, name: name || id, command: String(command), args: argList, env: env || {}, enabled: true })
    this.save()
    return { ok: true, id }
  }

  removeServer(id) {
    const before = this.custom.length
    this.custom = this.custom.filter((s) => s.id !== id)
    if (this.custom.length === before) {
      const s = this.findServer(id)
      return { ok: false, error: s ? `「${id}」是内置 server，不能删除，可以禁用` : `没有这个 server：${id}` }
    }
    this.disconnect(id)
    this.save()
    return { ok: true }
  }

  setEnabled(id, enabled) {
    const s = this.findServer(id)
    if (!s) return { ok: false, error: `没有这个 server：${id}` }
    if (s.builtin) {
      if (enabled) this.builtinDisabled.delete(id)
      else this.builtinDisabled.add(id)
    } else {
      s.enabled = Boolean(enabled)
    }
    if (!enabled) this.disconnect(id)
    this.save()
    return { ok: true }
  }

  /** 工作目录变了：现有连接是带着旧目录起的，全部断开，下次用新目录重连 */
  setProjectDir(dir) {
    if (!dir || dir === this.projectDir) return
    this.projectDir = dir
    for (const id of [...this.connections.keys()]) this.disconnect(id)
  }

  // ---------------------------------------------------------------- 连接

  disconnect(id) {
    const conn = this.connections.get(id)
    if (!conn) return
    this.connections.delete(id)
    try { conn.client?.dispose() } catch { /* 已经在退出了 */ }
  }

  /** 建连接并完成 MCP 握手 + 拉工具列表。失败时把原因留在连接状态里，供设置页展示 */
  async connect(id) {
    const server = this.findServer(id)
    if (!server) return { ok: false, error: `没有这个 server：${id}` }
    if (server.enabled === false) return { ok: false, error: `「${id}」已禁用` }

    const existing = this.connections.get(id)
    if (existing?.status === 'ready') return { ok: true, tools: existing.tools }

    this.disconnect(id)
    const conn = { client: null, status: 'connecting', tools: [], error: '', stderr: '' }
    this.connections.set(id, conn)

    try {
      conn.client = createClient({
        command: quoteShellArg(server.command),
        args: (server.args || []).map(quoteShellArg),
        cwd: this.projectDir,
        // 内置 git server 要靠这个环境变量知道该看哪个仓库
        env: { YU_CODE_PROJECT_DIR: this.projectDir, ...(server.env || {}) },
        framing: 'newline',
        timeout: CONNECT_TIMEOUT,
        onClose: (info) => {
          conn.stderr = info?.stderr || ''
          // 主动 dispose 时不报错，避免关闭应用时刷一堆噪音
          if (conn.status !== 'closing') {
            conn.status = 'error'
            conn.error = info?.reason || '连接已断开'
            conn.tools = []
          }
        },
      })

      await conn.client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false } },
        clientInfo: CLIENT_INFO,
      })
      conn.client.notify('notifications/initialized', {})

      const res = await conn.client.request('tools/list', {})
      conn.tools = Array.isArray(res?.tools) ? res.tools.filter((t) => t && t.name) : []
      conn.status = 'ready'
      conn.error = ''
      return { ok: true, tools: conn.tools }
    } catch (e) {
      conn.status = 'error'
      conn.error = e?.message || String(e)
      conn.stderr = conn.client?.getStderr() || ''
      conn.tools = []
      // 保留这条 error 记录而不是删掉：设置页要能显示「为什么连不上」。
      // 只把死掉的 client 放掉，下次 ensure 时会重新建连接。
      try { conn.client?.dispose() } catch { /* ignore */ }
      conn.client = null
      return { ok: false, error: conn.error }
    }
  }

  /** 已连好就直接用，否则连一次。调用失败不抛异常，返回错误对象 */
  async ensure(id) {
    const conn = this.connections.get(id)
    if (conn?.status === 'ready') return { ok: true }
    if (conn?.status === 'connecting') return { ok: false, error: '正在连接中' }
    return this.connect(id)
  }

  /** 重新连接（设置页「重试」用，也用于强制刷新工具列表） */
  async refresh(id) {
    this.disconnect(id)
    return this.connect(id)
  }

  /** 把所有启用的 server 连上。启动时调用，失败只记状态不影响应用启动 */
  async connectAll() {
    const servers = this.allServers().filter((s) => s.enabled !== false)
    return Promise.all(servers.map((s) => this.connect(s.id)))
  }

  /**
   * 补齐连接：把还没连过的启用 server 连上。Agent 每轮任务开始前调一次 ——
   * 切过工作目录后连接会被断掉，这里顺手补回来，工具列表才是全的。
   * 已经明确连失败的 server 不在这里自动重试（否则每个任务都要先等它超时一次），
   * 交给用户在设置页点「重试」。
   */
  async ensureReady() {
    const pending = []
    for (const server of this.allServers()) {
      if (server.enabled === false) continue
      const conn = this.connections.get(server.id)
      if (conn) continue // ready / connecting / error 都由它自己的状态决定，不在这里插手
      pending.push(this.connect(server.id))
    }
    if (pending.length) await Promise.all(pending)
  }

  // ---------------------------------------------------------------- 给 Agent 用

  /** 所有已连接 server 的工具，包装成 function calling 格式 */
  getToolSchemas() {
    const out = []
    for (const server of this.allServers()) {
      if (server.enabled === false) continue
      const conn = this.connections.get(server.id)
      if (conn?.status !== 'ready') continue
      for (const t of conn.tools) out.push(toSchema(server.id, t))
    }
    return out
  }

  hasTool(fullName) {
    return this.getToolSchemas().some((t) => t.function.name === fullName)
  }

  /** 调用一个 MCP 工具。名字形如 mcp__git__git_status，解析出 server 与原始工具名 */
  async callTool(fullName, args) {
    const rest = String(fullName).slice(TOOL_PREFIX.length)
    const sep = rest.indexOf('__')
    if (sep === -1) return `MCP 工具名不合法: ${fullName}`
    const serverId = rest.slice(0, sep)
    const toolName = rest.slice(sep + 2)

    const conn = this.connections.get(serverId)
    if (!conn || conn.status !== 'ready') {
      const r = await this.ensure(serverId)
      if (!r.ok) return `MCP server「${serverId}」不可用：${r.error}`
    }
    const live = this.connections.get(serverId)
    try {
      const result = await live.client.request(
        'tools/call',
        { name: toolName, arguments: args && typeof args === 'object' ? args : {} },
        CALL_TIMEOUT,
      )
      return formatResult(result)
    } catch (e) {
      return `MCP 工具 ${fullName} 调用失败：${e?.message || e}`
    }
  }

  disposeAll() {
    for (const [id, conn] of this.connections) {
      conn.status = 'closing'
      try { conn.client?.dispose() } catch { /* ignore */ }
      this.connections.delete(id)
    }
  }
}

module.exports = { McpManager, BUILTIN_SERVERS, TOOL_PREFIX, toolFullName }
