/**
 * JSON-RPC 2.0 子进程传输层 —— MCP 客户端与 LSP 客户端共用。
 *
 * 两种分帧协议（同一套 JSON-RPC 消息，只是「消息之间怎么分隔」不同）：
 *   - newline        ：一行一个 JSON。MCP 的 stdio 传输用的就是这个
 *   - content-length ：`Content-Length: N\r\n\r\n{json}`。LSP 用的这个
 *
 * 只负责「把消息发出去、把消息收回来」，不认识任何 MCP/LSP 语义。
 */

const { spawn } = require('child_process')
const { execFile } = require('child_process')

const DEFAULT_TIMEOUT = 30000

/** Windows 上杀掉整棵进程树。server 常由 npx/shell 包一层，只杀 shell 会留下孤儿进程 */
function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
  }
}

/**
 * 启动一个 JSON-RPC 子进程。
 * @param command 可执行文件
 * @param args    参数数组
 * @param cwd     工作目录（决定 server 相对哪个项目找文件）
 * @param env     额外环境变量（与 process.env 合并）
 * @param framing 'newline' | 'content-length'
 * @param onNotification (method, params) 服务端主动推的通知，如 LSP 的诊断
 * @param onRequest      (method, params) 服务端反向请求，如 LSP 要 workspace/configuration
 * @param onClose        (info) 进程退出/启动失败
 */
function createClient(opts = {}) {
  const {
    command,
    args = [],
    cwd,
    env = {},
    framing = 'newline',
    onNotification,
    onRequest,
    onClose,
    timeout = DEFAULT_TIMEOUT,
  } = opts

  // Windows 上 npx.cmd / 全局命令都要靠 shell 才能解析；shell:true 会把 args 交给 shell 拼接，
  // 所以这里的参数必须自己保证不含空格等特殊字符（server 名字与路径都由配置给出）。
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
  })

  let buffer = Buffer.alloc(0)
  let nextId = 1
  let disposed = false
  const pending = new Map()
  /** 服务端 stderr 的尾巴，进程异常退出时用来解释原因 */
  let stderrTail = ''

  const failAll = (reason) => {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    pending.clear()
  }

  const finish = (info) => {
    if (disposed) return
    disposed = true
    failAll(`${command} 已断开：${info.reason}`)
    onClose?.({ ...info, stderr: stderrTail.slice(-800) })
  }

  child.on('error', (e) => finish({ reason: `启动失败 ${e.message}` }))
  child.on('exit', (code, signal) => finish({ reason: `进程退出（code=${code} signal=${signal}）` }))
  child.stderr.on('data', (chunk) => {
    stderrTail += chunk.toString('utf-8')
    if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-2000)
  })

  const encode = (msg) => {
    const body = Buffer.from(JSON.stringify(msg), 'utf-8')
    if (framing === 'content-length') {
      return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
    }
    return Buffer.concat([body, Buffer.from('\n', 'utf-8')])
  }

  const send = (msg) => {
    if (disposed) return false
    try {
      child.stdin.write(encode(msg))
      return true
    } catch {
      return false
    }
  }

  /** 从缓冲区里切出尽可能多的完整消息，返回剩余部分 */
  const sliceMessages = () => {
    const out = []
    for (;;) {
      if (framing === 'content-length') {
        const sep = buffer.indexOf('\r\n\r\n')
        if (sep === -1) break
        const header = buffer.subarray(0, sep).toString('ascii')
        const m = /content-length:\s*(\d+)/i.exec(header)
        if (!m) {
          // 头部坏了：丢掉这一段，避免整个连接卡死
          buffer = buffer.subarray(sep + 4)
          continue
        }
        const len = parseInt(m[1], 10)
        if (buffer.length < sep + 4 + len) break
        const body = buffer.subarray(sep + 4, sep + 4 + len).toString('utf-8')
        buffer = buffer.subarray(sep + 4 + len)
        out.push(body)
      } else {
        const nl = buffer.indexOf('\n')
        if (nl === -1) break
        const line = buffer.subarray(0, nl).toString('utf-8').trim()
        buffer = buffer.subarray(nl + 1)
        if (line) out.push(line)
      }
    }
    return out
  }

  const handle = (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return // 分帧坏了一两条，跳过即可，不该让整个连接挂掉
    }

    // 服务端反向请求：必须回一个响应，否则对方会一直等
    if (msg.id !== undefined && msg.method) {
      Promise.resolve()
        .then(() => onRequest?.(msg.method, msg.params))
        .then((result) => send({ jsonrpc: '2.0', id: msg.id, result: result ?? null }))
        .catch((e) => send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: e?.message || 'client handler failed' },
        }))
      return
    }

    // 服务端的响应
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else p.resolve(msg.result)
      return
    }

    // 通知（没有 id）
    if (msg.method) onNotification?.(msg.method, msg.params)
  }

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (const raw of sliceMessages()) handle(raw)
  })

  return {
    /** 发一个请求并等响应。超时/断开都会 reject。timeoutMs 可覆盖默认超时 */
    request(method, params, timeoutMs) {
      if (disposed) return Promise.reject(new Error(`${command} 未连接`))
      const wait = Number(timeoutMs) > 0 ? Number(timeoutMs) : timeout
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} 超时（${wait}ms）`))
        }, wait)
        pending.set(id, { resolve, reject, timer })
        if (!send({ jsonrpc: '2.0', id, method, params })) {
          clearTimeout(timer)
          pending.delete(id)
          reject(new Error(`${command} 写入失败`))
        }
      })
    },

    /** 发一个不需要响应的通知 */
    notify(method, params) {
      send({ jsonrpc: '2.0', method, params })
    },

    /** stderr 尾巴，用于给用户解释 server 为什么起不来 */
    getStderr: () => stderrTail.slice(-800),
    isDisposed: () => disposed,

    dispose() {
      if (disposed) return
      disposed = true
      failAll('客户端已关闭')
      try { child.stdin.end() } catch { /* ignore */ }
      killTree(child.pid)
    },
  }
}

module.exports = { createClient, killTree, DEFAULT_TIMEOUT }
