/**
 * LSP 客户端：跳转到定义 + 文档诊断，跑在 ./jsonrpc 传输层之上。
 *
 * 与 symbol-search.js 的分工：那边是零依赖的正则兜底，这边是「装了 language server 才走的精确路径」。
 * server 一律不联网、不自动安装；本机没有就静默降级（返回 null / 空数组），任何错误都不抛给调用方。
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { pathToFileURL, fileURLToPath } = require('url')
const { createClient } = require('./jsonrpc')

const IS_WIN = process.platform === 'win32'
const DIAG_TIMEOUT = 12000
const MAX_FILE_SIZE = 2 * 1024 * 1024
const MAX_MESSAGE = 300
const SEVERITY_NAMES = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

/** 扩展名 → languageId，未列出的语言直接视为不支持 */
const EXT_TO_LANGUAGE = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
}

/** 连接缓存：`projectDir\u0000languageId` → conn */
const connections = new Map()
/** 探测结果缓存：避免每次调用都起一个 where/which 进程 */
const serverCache = new Map()

function languageIdFor(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null
  return EXT_TO_LANGUAGE[path.extname(filePath).toLowerCase()] || null
}

function connKey(projectDir, languageId) {
  return `${projectDir}\u0000${languageId}`
}

function fileUri(filePath) {
  return pathToFileURL(filePath).toString()
}

/** server 路径含空格时，shell:true 会把它拆开，必须补引号 */
function quoteCommand(cmd) {
  return IS_WIN && /\s/.test(cmd) ? `"${cmd}"` : cmd
}

// ---------------------------------------------------------------- server 发现

function whichCommand(name) {
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', [name], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 3000,
    })
    return String(out).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null
  } catch {
    return null // 命令不存在，where/which 会非零退出
  }
}

function whichAny(names) {
  for (const n of names) {
    const found = whichCommand(n)
    if (found) return found
  }
  return null
}

function findTypeScriptServer(projectDir) {
  const binName = IS_WIN ? 'typescript-language-server.cmd' : 'typescript-language-server'
  const env = { NODE_PATH: path.join(projectDir, 'node_modules') }
  const local = path.join(projectDir, 'node_modules', '.bin', binName)
  if (fs.existsSync(local)) {
    return { command: local, args: ['--stdio'], env, display: 'node_modules/.bin/typescript-language-server' }
  }
  const onPath = whichAny(IS_WIN ? [binName, 'typescript-language-server'] : [binName])
  if (onPath) {
    return { command: onPath, args: ['--stdio'], env, display: 'typescript-language-server' }
  }
  return null
}

function findPythonServer(projectDir) {
  const binDir = IS_WIN ? 'Scripts' : 'bin'
  const exe = IS_WIN ? '.exe' : ''
  for (const venv of ['.venv', 'venv']) {
    const cmd = path.join(projectDir, venv, binDir, `pyright-langserver${exe}`)
    if (fs.existsSync(cmd)) {
      return { command: cmd, args: ['--stdio'], env: {}, display: `${venv}/${binDir}/pyright-langserver` }
    }
  }
  const pyright = whichAny(IS_WIN ? ['pyright-langserver.cmd', 'pyright-langserver'] : ['pyright-langserver'])
  if (pyright) return { command: pyright, args: ['--stdio'], env: {}, display: 'pyright-langserver' }
  const pylsp = whichAny(IS_WIN ? ['pylsp.cmd', 'pylsp'] : ['pylsp'])
  if (pylsp) return { command: pylsp, args: [], env: {}, display: 'pylsp' }
  return null
}

/** 找到就返回 { command, args, env, display }，找不到返回 null。结果按 projectDir+languageId 缓存 */
function resolveServer(projectDir, languageId) {
  if (!projectDir) return null
  const key = connKey(projectDir, languageId)
  if (serverCache.has(key)) return serverCache.get(key)
  let server = null
  try {
    if (languageId === 'typescript' || languageId === 'javascript') server = findTypeScriptServer(projectDir)
    else if (languageId === 'python') server = findPythonServer(projectDir)
  } catch {
    server = null
  }
  serverCache.set(key, server)
  return server
}

// ---------------------------------------------------------------- 文件读取

function readFileSafe(filePath) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 连接与握手

function clearPending(conn) {
  for (const [, p] of conn.pending) {
    clearTimeout(p.timer)
    try { p.resolve() } catch { /* 调用方自己会兜底 */ }
  }
  conn.pending.clear()
}

function disposeConn(conn) {
  clearPending(conn)
  try { conn.client.dispose() } catch { /* 已退出 */ }
}

function createConnection(key, projectDir, languageId, server) {
  const rootUri = pathToFileURL(projectDir).toString()
  const conn = {
    projectDir,
    languageId,
    client: null,
    /** uri → { version, text }，用于判断能否跳过重复 didChange */
    docs: new Map(),
    /** uri → 最近一次收到的原始 diagnostics（null 表示已失效） */
    diagnostics: new Map(),
    /** uri → { timer, resolve }，一个 uri 同时只挂一个等待 */
    pending: new Map(),
    ready: null,
  }

  conn.client = createClient({
    command: quoteCommand(server.command),
    args: server.args,
    cwd: projectDir,
    env: server.env,
    framing: 'content-length',
    onNotification(method, params) {
      if (method !== 'textDocument/publishDiagnostics' || !params?.uri) return
      conn.diagnostics.set(params.uri, Array.isArray(params.diagnostics) ? params.diagnostics : [])
      const p = conn.pending.get(params.uri)
      if (p) {
        conn.pending.delete(params.uri)
        clearTimeout(p.timer)
        p.resolve()
      }
    },
    onRequest(method, params) {
      // 服务端会等这些请求的响应，必须回值
      if (method === 'workspace/configuration') {
        const items = Array.isArray(params?.items) ? params.items : []
        return items.map(() => ({}))
      }
      return null // registerCapability / unregisterCapability 及未知方法统一回 null
    },
    onClose() {
      if (connections.get(key) === conn) connections.delete(key)
      clearPending(conn) // 唤醒所有等待诊断的调用方，避免一直挂着
    },
  })

  conn.ready = (async () => {
    await conn.client.request('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: { textDocument: { definition: {}, publishDiagnostics: {} } },
      workspaceFolders: [{ uri: rootUri, name: path.basename(projectDir) || projectDir }],
    })
    conn.client.notify('initialized', {})
  })()

  return conn
}

/** 惰性取连接：已有可用连接直接复用，握手失败或进程已退出则重建 */
async function getConnection(projectDir, languageId) {
  const key = connKey(projectDir, languageId)
  const cached = connections.get(key)
  if (cached) {
    try {
      await cached.ready
      if (!cached.client.isDisposed()) return cached
    } catch { /* 握手失败或中途断开，下面重建 */ }
    disposeConn(cached)
    if (connections.get(key) === cached) connections.delete(key)
  }

  const server = resolveServer(projectDir, languageId)
  if (!server) return null

  const conn = createConnection(key, projectDir, languageId, server)
  connections.set(key, conn)
  try {
    await conn.ready
  } catch (e) {
    console.error('[lsp] 初始化失败：', e?.message, conn.client.getStderr())
    disposeConn(conn)
    if (connections.get(key) === conn) connections.delete(key)
    return null
  }
  return conn
}

/**
 * 把最新内容同步给 server。返回 true 表示确实发了 didOpen/didChange。
 * 内容没变就不重发，避免白白触发一次全量重算。
 */
function syncDocument(conn, filePath, text, languageId) {
  const uri = fileUri(filePath)
  const doc = conn.docs.get(uri)
  if (!doc) {
    conn.docs.set(uri, { version: 1, text })
    conn.client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    })
    return true
  }
  if (doc.text === text) return false
  doc.version += 1
  doc.text = text
  conn.client.notify('textDocument/didChange', {
    textDocument: { uri, version: doc.version },
    contentChanges: [{ text }],
  })
  return true
}

/** 等某个 uri 的下一批诊断，最多等 timeoutMs */
function waitForDiagnostics(conn, uri, timeoutMs) {
  return new Promise((resolve) => {
    const prev = conn.pending.get(uri)
    if (prev) { // 同一 uri 上一次等待还挂着：先放它走，保证不堆积
      clearTimeout(prev.timer)
      prev.resolve()
    }
    const timer = setTimeout(() => {
      conn.pending.delete(uri)
      resolve()
    }, timeoutMs)
    conn.pending.set(uri, { timer, resolve })
  })
}

function formatDiagnostics(list) {
  if (!Array.isArray(list)) return []
  return list.map((d) => {
    const start = d?.range?.start || {}
    return {
      line: (start.line ?? 0) + 1,
      column: (start.character ?? 0) + 1,
      severity: SEVERITY_NAMES[d?.severity] || 'info',
      // 多行报错压成一行并截断，方便直接喂给模型/展示
      message: String(d?.message ?? '').replace(/\s*\r?\n\s*/g, ' ').slice(0, MAX_MESSAGE),
      source: d?.source || '',
    }
  })
}

/** Location / Location[] / LocationLink[] 统一取第一个 */
function firstLocation(result) {
  if (!result) return null
  const item = Array.isArray(result) ? result[0] : result
  if (!item || typeof item !== 'object') return null
  const uri = item.uri || item.targetUri
  const range = item.range || item.targetSelectionRange || item.targetRange
  if (!uri || !range?.start) return null
  let filePath
  try {
    filePath = fileURLToPath(uri) // Windows 的 file:///C:/.. 会被还原成 C:\..
  } catch {
    return null
  }
  return { filePath, line: range.start.line + 1, column: range.start.character + 1 }
}

// ---------------------------------------------------------------- 对外接口

function isAvailable(projectDir, languageId) {
  try {
    return !!resolveServer(projectDir, languageId)
  } catch {
    return false
  }
}

function describe(projectDir) {
  const out = {}
  try {
    const ts = resolveServer(projectDir, 'typescript')
    out.typescript = ts
      ? { available: true, command: ts.display }
      : { available: false, reason: '未找到 typescript-language-server' }
    // js/jsx 复用同一个 typescript server，只是 languageId 不同
    out.javascript = ts
      ? { available: true, command: ts.display }
      : { available: false, reason: '未找到 typescript-language-server' }
    const py = resolveServer(projectDir, 'python')
    out.python = py
      ? { available: true, command: py.display }
      : { available: false, reason: '未找到 pyright-langserver / pylsp' }
  } catch (e) {
    console.error('[lsp] describe 失败：', e?.message)
  }
  return out
}

async function findDefinition(projectDir, filePath, line, column) {
  try {
    const languageId = languageIdFor(filePath)
    if (!languageId) return null
    const text = readFileSafe(filePath)
    if (text == null) return null

    const conn = await getConnection(projectDir, languageId)
    if (!conn) return null

    const uri = fileUri(filePath)
    syncDocument(conn, filePath, text, languageId)

    const result = await conn.client.request('textDocument/definition', {
      textDocument: { uri },
      position: {
        line: Math.max(0, (Number(line) || 1) - 1),
        character: Math.max(0, (Number(column) || 1) - 1),
      },
    })
    return firstLocation(result)
  } catch (e) {
    console.error('[lsp] findDefinition 失败：', e?.message)
    return null
  }
}

async function getDiagnostics(projectDir, filePath) {
  try {
    const languageId = languageIdFor(filePath)
    if (!languageId) return []
    const text = readFileSafe(filePath)
    if (text == null) return []

    const conn = await getConnection(projectDir, languageId)
    if (!conn) return []

    const uri = fileUri(filePath)
    const changed = syncDocument(conn, filePath, text, languageId)
    if (!changed) {
      // 内容没动，server 不会重推：有缓存就直接给，没有才等
      const cached = conn.diagnostics.get(uri)
      if (cached) return formatDiagnostics(cached)
    }
    conn.diagnostics.delete(uri) // 丢掉旧结果，等这一轮新的
    await waitForDiagnostics(conn, uri, DIAG_TIMEOUT)
    return formatDiagnostics(conn.diagnostics.get(uri))
  } catch (e) {
    console.error('[lsp] getDiagnostics 失败：', e?.message)
    return []
  }
}

function didChange(projectDir, filePath, text) {
  try {
    if (typeof text !== 'string') return
    const languageId = languageIdFor(filePath)
    if (!languageId) return
    const conn = connections.get(connKey(projectDir, languageId))
    if (!conn || conn.client.isDisposed()) return // 还没连上就等下次真正需要时再说
    syncDocument(conn, filePath, text, languageId)
  } catch (e) {
    console.error('[lsp] didChange 失败：', e?.message)
  }
}

function disposeAll() {
  for (const [, conn] of connections) disposeConn(conn)
  connections.clear()
}

module.exports = {
  isAvailable,
  describe,
  findDefinition,
  getDiagnostics,
  didChange,
  disposeAll,
}
