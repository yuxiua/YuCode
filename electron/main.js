const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const http = require('http')
const os = require('os')
const { spawn, execFile } = require('child_process')
const YuCodeAgent = require('./agent')
const PiAgent = require('./agent-pi')
const stateStore = require('./state')
const extensionsEngine = require('./extensions')
const piRuntime = require('./pi')
const bundledExtensions = require('./pi-bundled-extensions')
const customExtensions = require('./pi-custom-extensions')
const { testModel } = require('./pi-agent-model')
const symbolSearch = require('./symbol-search')
const checkpointEngine = require('./checkpoint')
const builtinsEngine = require('./builtins')
const { McpManager } = require('./mcp')
const lsp = require('./lsp')

// MCP 客户端全局共享：多个工作区共用一个连接池。
let mcp

// ─── 多窗口 / 多工作区 ───────────────────────────────────────────────────────
// 支持多开：每个窗口是一个独立的工作区；窗口内每个聊天会话（chatId）又各有一个
// 独立的 Agent 实例，所以多个窗口、同一窗口里的多个会话都能并发干活、互不打扰。
// 以 webContents.id 作为窗口上下文的键，所有原先的模块级单例都挪进 ctx。
const windows = new Map()

function ctxOf(event) {
  return windows.get(event.sender.id)
}

/** 该 IPC 来自哪个窗口；极端情况下拿不到就退回第一个还活着的窗口 */
function ctxWin(event) {
  const ctx = ctxOf(event)
  if (ctx && !ctx.win.isDestroyed()) return ctx.win
  return BrowserWindow.fromWebContents(event.sender) || firstWindow()
}

function firstWindow() {
  for (const ctx of windows.values()) {
    if (!ctx.win.isDestroyed()) return ctx.win
  }
  return null
}

// 是否开发模式（--dev 或 NODE_ENV=development），模块级常量供多处使用
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev')

// ─── Dev URL resolution ──────────────────────────────────────────────────────
// Vite 可能因 5173 被占用而自动换端口,主进程读取 .dev-port 拿到实际端口并探测,
// 避免写死 5173 导致窗口连到残留/失效的旧服务。
const DEV_PORT_FILE = path.join(__dirname, '..', '.dev-port')
const DEFAULT_DEV_URL = 'http://localhost:5173'

function readDevPort() {
  try {
    const raw = require('fs').readFileSync(DEV_PORT_FILE, 'utf-8').trim()
    const port = parseInt(raw, 10)
    if (Number.isInteger(port) && port > 0 && port < 65536) return port
  } catch {
    /* ignore */
  }
  return 5173
}

function probeUrl(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume()
      resolve(true)
      req.destroy()
    })
    req.setTimeout(1000, () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

async function resolveDevUrl() {
  const start = Date.now()
  // 最长等待 30s:期间反复读取端口文件并探测,直到 Vite 真正就绪
  while (Date.now() - start < 30000) {
    const url = `http://localhost:${readDevPort()}`
    if (await probeUrl(url)) return url
    await new Promise((r) => setTimeout(r, 250))
  }
  return DEFAULT_DEV_URL
}

/**
 * 建一个新窗口。targetDir 是这次要打开的工作区目录（为空表示沿用上次的目录）。
 * 支持多开：菜单「打开文件夹」、右键目录打开、启动参数都会走到这里。
 */
function createWindow(targetDir) {
  const dir = isExistingDir(targetDir) ? path.resolve(targetDir) : ''
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    // 注意：frame:false 时不能再叠加 titleBarStyle/titleBarOverlay。
    // 实测在 Windows 上两者同时设置会导致窗口内容无法合成绘制，
    // 只剩 backgroundColor 一片空白（表现为"黑屏且点什么都没反应"）。
    frame: false,
    title: 'Yu Code',
    icon: path.join(__dirname, '../resources/icon.png'),
    // 与首屏底色保持一致，避免启动瞬间出现明显的色块跳变
    backgroundColor: '#141414',
    // 立刻显示窗口，不再等 ready-to-show。
    // 窗口里 index.html 自带启动进度条（#app-splash），而 ready-to-show 在部分机器上
    // 要么迟迟不触发、要么被主进程里的同步初始化拖后，表现就是「右键打开后几秒没反应，
    // 然后才蹦出进度条」。底色已经设成首屏色，直接显示不会黑屏。
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const wcId = win.webContents.id
  const ctx = {
    win,
    /** chatId → Agent 实例 */
    agents: new Map(),
    /** 该窗口的工作目录（安全边界 + 文件监听 + 检查点都以它为准） */
    allowedDir: dir || null,
    watcher: null,
    watchTimer: null,
    /** Agent 操控的浏览器窗口 */
    browserWindow: null,
    /** 该窗口创建的终端 id，窗口关闭时一并收掉 */
    terminalIds: new Set(),
    /** 待打开的路径（右键传入的文件，渲染进程没挂载前先存着） */
    pendingOpen: targetDir && !dir ? targetDir : null,
    rendererReady: false,
    /** 该窗口的 Agent 参数（模型、目录、计划模式、扩展…），新会话创建时套用 */
    settings: {
      model: null,
      projectDir: dir || '',
      planMode: false,
      extensions: [],
      riskConfirm: true,
      autoDiagnostics: true,
    },
  }
  windows.set(wcId, ctx)

  // 渲染进程崩溃/加载失败时把原因输出到终端，便于排查白屏
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process gone:', details)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`)
  })
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[renderer] preload error:', preloadPath, error)
  })

  if (isDev) {
    // 开发模式下把渲染进程的控制台输出转发到终端，便于排查
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} @ ${sourceId}:${line}`)
    })
    // 仅在显式设置 DEBUG_DEVTOOLS=1 时才弹出开发者工具，避免默认遮挡主窗口
    if (process.env.DEBUG_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' })
    }
    resolveDevUrl().then((url) => {
      console.log(`[dev] loading ${url}`)
      if (!win.isDestroyed()) win.loadURL(url)
    })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 窗口关闭：把它名下的 Agent、文件监听、终端、浏览器窗口都收干净，
  // 否则关掉工作区后后台还留着 pi 子进程和文件句柄。
  win.on('closed', () => {
    for (const id of ctx.terminalIds) killTerminal(id)
    ctx.terminalIds.clear()
    stopCtxWatch(ctx)
    for (const a of ctx.agents.values()) {
      try { a.shutdown?.() } catch { /* ignore */ }
    }
    ctx.agents.clear()
    if (ctx.browserWindow && !ctx.browserWindow.isDestroyed()) ctx.browserWindow.close()
    ctx.browserWindow = null
    windows.delete(wcId)
  })

  // 新窗口立刻按目标目录建立文件监听，右键去重也能马上认出来
  if (dir) startCtxWatch(ctx, dir)
  return ctx
}

// Terminal management
const terminals = new Map()
let terminalCounter = 0

/** 窗口可能已经关了，别往销毁的 webContents 上发（会抛异常） */
function safeSend(wc, channel, ...args) {
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
}

function killTerminal(id) {
  const proc = terminals.get(id)
  if (!proc) return
  terminals.delete(id)
  const pid = proc.pid
  try { proc.kill() } catch { /* 已退出 */ }
  // Windows 上 pty.kill() 走的是异步清理（fork 一个 agent 进程查控制台进程列表，再逐个 process.kill），
  // 应用退出时事件循环马上停摆，这段逻辑来不及跑完，powershell/conhost 就会残留成孤儿，
  // 进而把主进程卡在原生收尾阶段——表现就是关掉窗口后任务管理器里还挂着 Yu Code.exe 和 powershell.exe。
  // 这里直接 taskkill /F /T 强杀整棵终端进程树兜底（复用 agent-tools/jsonrpc 的既有做法）。
  if (process.platform === 'win32' && pid) {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true })
    } catch { /* ignore */ }
  }
}

// 真实 PTY（node-pty）。拿不到就退回到管道模式，保证终端仍可用、且不会拖垮应用启动。
let pty = null
let ptyLoadError = ''
try {
  pty = require('@homebridge/node-pty-prebuilt-multiarch')
} catch (e1) {
  try {
    pty = require('node-pty')
  } catch (e2) {
    ptyLoadError = e2.message
  }
}
console.log(pty ? '[terminal] 使用 PTY 模式' : `[terminal] PTY 不可用，退回管道模式: ${ptyLoadError}`)

// 获取 conda/python 路径（Windows）
function getPythonPaths() {
  const paths = []
  const home = process.env.USERPROFILE || ''
  const candidates = [
    `${home}\\anaconda3`, `${home}\\Anaconda3`,
    `${home}\\miniconda3`, `${home}\\Miniconda3`,
    'C:\\ProgramData\\anaconda3', 'C:\\ProgramData\\Anaconda3',
    'C:\\ProgramData\\miniconda3', 'C:\\ProgramData\\Miniconda3',
  ]
  const fs = require('fs')
  for (const base of candidates) {
    if (fs.existsSync(base)) {
      paths.push(base, `${base}\\Scripts`, `${base}\\Library\\bin`)
      break
    }
  }
  // 也尝试 py launcher
  if (fs.existsSync('C:\\Python39') || fs.existsSync('C:\\Python310') || fs.existsSync('C:\\Python311') || fs.existsSync('C:\\Python312')) {
    for (const ver of ['39', '310', '311', '312']) {
      const p = `C:\\Python${ver}`
      if (fs.existsSync(p)) { paths.push(p, `${p}\\Scripts`); break }
    }
  }
  return paths
}

/**
 * 终端的工作目录必须是真实存在的目录。
 *
 * 渲染进程传过来的是「上次打开的工作目录」，它可能已经被删除或改名；而 spawn /
 * pty.spawn 遇到不存在的 cwd 会直接以 ENOENT 失败（报错信息写作
 * `spawn powershell.exe ENOENT`，看着像找不到 powershell，其实是 cwd 无效）。
 * 管道模式下那条链路没有 error 监听，于是变成主进程未捕获异常，
 * 用户看到的就是「A JavaScript error occurred in the main process」。
 */
function resolveTerminalCwd(cwd) {
  try {
    if (cwd && require('fs').statSync(cwd).isDirectory()) return cwd
  } catch { /* 不存在 / 无权限：走下面的回退 */ }
  if (cwd) console.warn(`[terminal] 工作目录不可用，改用用户主目录: ${cwd}`)
  return os.homedir() || process.cwd()
}

ipcMain.handle('terminal:create', (event, { cwd, shell, pythonEnv, cols, rows }) => {
  const id = `term-${++terminalCounter}`
  // 记下这个终端属于哪个窗口，窗口关闭时一并收掉
  const ctx = ctxOf(event)
  if (ctx) ctx.terminalIds.add(id)
  const isWin = process.platform === 'win32'

  let shellPath, args
  if (isWin) {
    shellPath = 'powershell.exe'
    // 用 PowerShell 自带的编码设置让输出走 UTF-8（否则中文版 Windows 的 GBK 输出会乱码）。
    // 不要用 chcp：chcp 是 System32 下的外部程序，一旦 PATH 被 conda 等改写就可能找不到，
    // 会报 "无法将 chcp 项识别为 cmdlet、函数、脚本文件或可运行程序的名称"。
    const utf8 =
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8'
    // -ExecutionPolicy Bypass：不少机器（含默认的 Restricted 策略）一开 PowerShell 就报
    // 「无法加载 profile.ps1，因为在此系统上禁止运行脚本」，终端一打开先糊一屏红字。
    // 这里不能改用 -NoProfile —— 用户的 conda init / 别名都写在 profile 里，跳过就 activate 不了环境。
    if (pythonEnv && pythonEnv !== 'system') {
      args = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `${utf8}; conda activate ${pythonEnv}`]
    } else {
      args = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', utf8]
    }
  } else {
    shellPath = shell || 'bash'
    if (pythonEnv && pythonEnv !== 'system') {
      args = ['-c', `source activate ${pythonEnv} 2>/dev/null || conda activate ${pythonEnv}; exec bash -i`]
    } else {
      args = ['-i']
    }
  }

  // 构建环境变量（加入 python/conda 路径）
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }
  if (isWin) {
    // Windows 环境变量名大小写不敏感，spread 出来的可能是 `Path`。
    // 若同时存在 `Path` 和 `PATH` 两个键，子进程可能拿到被覆盖的那一份，
    // 导致 System32 丢失、连 chcp 之类的系统命令都找不到。这里统一成 `PATH` 再传。
    const basePath = env.PATH || env.Path || ''
    delete env.Path
    // 只有当不激活 conda 环境时才预置 conda 路径：
    // 否则 PATH 里已有一份基础 env 目录、缺 <prefix>\bin，
    // conda activate 移除旧 prefix 时会输出 "Did not find path entry ...\bin" 的噪音警告。
    const shouldInject = !pythonEnv || pythonEnv === 'system'
    const pyPaths = shouldInject ? getPythonPaths() : []
    env.PATH = pyPaths.length > 0 ? `${pyPaths.join(';')};${basePath}` : basePath
  }

  const workDir = resolveTerminalCwd(cwd)

  // 优先使用真实 PTY：交互式程序、彩色输出、光标控制、方向键历史都能正常工作
  if (pty) {
    try {
      const p = pty.spawn(shellPath, args, {
        name: 'xterm-256color',
        cols: cols || 100,
        rows: rows || 30,
        cwd: workDir,
        env,
        useConpty: true,
      })
      p.onData((data) => {
        safeSend(event.sender, `terminal:data:${id}`, data)
      })
      p.onExit(({ exitCode }) => {
        safeSend(event.sender, `terminal:close:${id}`, exitCode)
        terminals.delete(id)
      })
      terminals.set(id, p)
      return id
    } catch (e) {
      console.error('[terminal] PTY 启动失败，退回管道模式:', e.message)
    }
  }

  // 管道模式（PTY 不可用时的兜底）
  const proc = spawn(shellPath, args, {
    cwd: workDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  terminals.set(id, proc)

  proc.stdout.on('data', (data) => {
    safeSend(event.sender, `terminal:data:${id}`, data)
  })
  proc.stderr.on('data', (data) => {
    safeSend(event.sender, `terminal:data:${id}`, data)
  })
  // 启动失败（shell 找不到、cwd 无效等）会走 error 事件而不是 close：
  // 不接住它就是主进程未捕获异常，整个应用弹「A JavaScript error occurred in the main process」。
  proc.on('error', (e) => {
    console.error(`[terminal] 启动失败: ${e.message}`)
    terminals.delete(id)
    safeSend(event.sender, `terminal:close:${id}`, -1)
  })
  proc.on('close', (code) => {
    safeSend(event.sender, `terminal:close:${id}`, code)
    terminals.delete(id)
  })

  return id
})

ipcMain.on('terminal:write', (event, { id, data }) => {
  const proc = terminals.get(id)
  if (!proc) return
  if (proc.write) proc.write(data) // pty
  else if (proc.stdin) proc.stdin.write(data) // 管道
})

ipcMain.on('terminal:resize', (event, { id, cols, rows }) => {
  const proc = terminals.get(id)
  if (proc && proc.resize) {
    try { proc.resize(cols, rows) } catch { /* 忽略尺寸异常 */ }
  }
})

ipcMain.handle('terminal:kill', (event, { id }) => {
  killTerminal(id)
})

// 终端里是否还有命令在跑：查 shell 进程的子进程。
// 只看一层就够——用户敲的命令都挂在 shell 下面（node.exe / python.exe / …），shell 自己不算。
// 关闭终端前用它决定要不要弹确认框。
//
// 注意 conhost.exe：Windows 上每个控制台程序都会挂一个 conhost 子进程，
// PowerShell 里执行纯 cmdlet（如 Start-Sleep）也会带一个。实测空闲的 shell 就有 1 个
// conhost 子进程，所以必须把它（以及 ConPTY 用的 OpenConsole）排除掉，
// 否则永远判定成"正在运行"，弹窗会一直骚扰用户。
const TERMINAL_INFRA_PROCESSES = new Set(['conhost.exe', 'openconsole.exe', 'windowsterminal.exe'])

ipcMain.handle('terminal:has-children', (event, { id }) => {
  const proc = terminals.get(id)
  const pid = proc && proc.pid
  if (!pid) return false

  if (process.platform !== 'win32') {
    return new Promise((resolve) => {
      execFile('pgrep', ['-P', String(pid)], (error, stdout) => {
        resolve(!error && stdout.trim().length > 0)
      })
    })
  }

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").Name -join ';'`],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        // 查不到就当没有：不能因为查询失败反而拦着用户关终端
        if (error) return resolve(false)
        const names = String(stdout).split(/[;\r\n]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
        resolve(names.some((name) => !TERMINAL_INFRA_PROCESSES.has(name)))
      },
    )
  })
})

// Native dialog - open folder
ipcMain.handle('dialog:open-folder', async (event) => {
  const result = await dialog.showOpenDialog(ctxWin(event), {
    properties: ['openDirectory'],
    title: '选择文件夹',
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// Native dialog - open file
ipcMain.handle('dialog:open-file', async (event) => {
  const result = await dialog.showOpenDialog(ctxWin(event), {
    properties: ['openFile'],
    title: '选择文件',
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// Create new file (save dialog)
ipcMain.handle('file:create', async (event) => {
  const result = await dialog.showSaveDialog(ctxWin(event), {
    title: '新建文件',
    defaultPath: path.join(process.cwd(), 'untitled.txt'),
  })
  if (result.canceled || !result.filePath) return null
  const fs = require('fs/promises')
  await fs.writeFile(result.filePath, '', 'utf-8')
  safeSend(event.sender, 'file:created', { filePath: result.filePath })
  return result.filePath
})

// 菜单「打开文件夹」：弹出选择框，选中的目录在新窗口里打开，当前窗口保持不变。
// 若该目录已经打开，则聚焦那个窗口、不再新起（与右键目录打开一致）。
ipcMain.handle('window:open-folder', async (event) => {
  const parent = ctxWin(event)
  const result = await dialog.showOpenDialog(parent, {
    properties: ['openDirectory'],
    title: '打开文件夹',
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return openTarget(result.filePaths[0])
})

// Python environment detection
ipcMain.handle('python:list-envs', async () => {
  const { exec } = require('child_process')
  const { promisify } = require('util')
  const execAsync = promisify(exec)
  const isWin = process.platform === 'win32'
  const pyExe = isWin ? 'python.exe' : 'python'
  // conda env list 每行是「名字 + 可选 * / + 标记 + 环境路径」，之间用空格对齐，
  // 不是制表符分隔；而且路径本身可能含空格（C:\Program Files\...），
  // 所以从行尾反向定位路径起点，不能直接按空白 split。
  // 之前按 \t 切分切不开，所有环境的 path 都退化成了同一个 'python.exe'，
  // 导致按 path 删除时误删多个环境。
  const parseLine = (line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return null
    const tokens = trimmed.split(/\s+/)
    // 路径一定以盘符（Windows）或 /（POSIX）开头
    const isPathToken = (t) => (isWin ? /^[A-Za-z]:[\\/]/.test(t) : t.startsWith('/'))
    let start = -1
    for (let i = tokens.length - 1; i >= 1; i--) {
      if (isPathToken(tokens[i])) {
        start = i
        break
      }
    }
    if (start < 0) return null
    const envPath = tokens.slice(start).join(' ')
    // 名字部分可能跟着 * (active) / + (frozen) 标记，一并去掉
    const name = tokens.slice(0, start).join(' ').replace(/[*+]/g, '').trim()
    if (!envPath || !name) return null
    return { name, path: path.join(envPath, isWin ? 'python.exe' : 'bin/python'), envPath }
  }
  try {
    const { stdout } = await execAsync('conda env list', { timeout: 5000 })
    const envs = []
    for (const line of stdout.split('\n')) {
      const env = parseLine(line)
      // 同一个环境可能被多个 envs_dirs 重复列出，按解释器路径去重
      if (env && !envs.some((e) => e.path === env.path)) envs.push(env)
    }
    return envs
  } catch {
    // Fallback: 找系统中的 python
    try {
      const { stdout } = await execAsync(`where ${pyExe}`, { timeout: 3000 })
      const pyPath = stdout.split('\n')[0].trim()
      return [{ name: 'system', path: pyPath || pyExe, envPath: '' }]
    } catch {
      return [{ name: 'system', path: pyExe, envPath: '' }]
    }
  }
})

// 校验用户选中的目录是不是一个可用的 Python 环境，并推出环境名与解释器路径
ipcMain.handle('python:inspect-env', async (event, { dirPath }) => {
  const fs = require('fs/promises')
  if (!dirPath) return { ok: false, error: '未选择目录' }
  const dir = path.resolve(dirPath)
  try {
    const stat = await fs.stat(dir)
    if (!stat.isDirectory()) return { ok: false, error: '请选择环境文件夹，而不是文件' }
  } catch {
    return { ok: false, error: '目录不存在或无法访问' }
  }
  const isWin = process.platform === 'win32'
  // conda 环境的解释器在环境根目录，venv 在 Scripts / bin 下
  const candidates = isWin
    ? [path.join(dir, 'python.exe'), path.join(dir, 'Scripts', 'python.exe')]
    : [path.join(dir, 'bin', 'python'), path.join(dir, 'python')]
  for (const exe of candidates) {
    try {
      await fs.access(exe)
      // 环境名取目录名：与 conda env list 里的 name 语义一致，终端按名字 activate
      return { ok: true, env: { name: path.basename(dir), path: exe } }
    } catch {
      // 继续看下一个候选位置
    }
  }
  return { ok: false, error: '该目录下没有找到 python 解释器，不是有效的 Python 环境' }
})

// ─── Agent Security Layer ────────────────────────────────────────────────────
// 限制 agent 只能访问已打开的项目目录及其子目录（每个窗口一个边界，互不影响）
ipcMain.on('security:set-allowed-dir', (event, { dirPath }) => {
  const ctx = ctxOf(event)
  if (!ctx) return
  const dir = dirPath ? path.resolve(dirPath) : null
  ctx.allowedDir = dir
  console.log(`[Security] Allowed directory set to: ${dir}`)
  // 工作目录变化时同步切换文件监听
  if (dir) startCtxWatch(ctx, dir)
  // MCP 是全局共享的：工作目录跟随最后一次设置的窗口（多工作区下只能取近似值）
  if (dir) mcp?.setProjectDir?.(dir)
})

function isPathAllowed(allowedDir, targetPath) {
  if (!allowedDir) return true // 未设置时不限制（兼容手动操作）
  const resolved = path.resolve(targetPath)
  return resolved.startsWith(allowedDir + path.sep) || resolved === allowedDir
}

// 敏感路径黑名单（即使在工作目录内也禁止）
const sensitivePatterns = [
  /\/\.git\/(config|hooks)/i,
  /\/\.env(\..*)?$/i,
  /\/id_(rsa|ed25519|ecdsa)$/i,
  /\/\.ssh\//i,
  /\/\.aws\//i,
  /\/credentials/i,
]
function isSensitivePath(targetPath) {
  return sensitivePatterns.some((p) => p.test(targetPath))
}

// File system operations for agent (with security)
//
// 单文件读取上限，与渲染进程的 src/utils/fileTypes.ts 保持一致
const MAX_TEXT_READ_SIZE = 5 * 1024 * 1024

ipcMain.handle('fs:read', async (event, { filePath }) => {
  const fs = require('fs/promises')
  if (isSensitivePath(filePath)) {
    throw new Error(`安全限制：禁止访问敏感文件 ${filePath}`)
  }
  // 渲染进程已经按扩展名过滤过，这里再兜一层：按大小 + 二进制特征挡一次。
  // exe/dll 之类被当文本读进来，轻则满屏乱码，重则把渲染进程撑爆卡死。
  const stat = await fs.stat(filePath)
  if (stat.size > MAX_TEXT_READ_SIZE) {
    throw new Error(`文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），不在编辑器中打开`)
  }
  const buf = await fs.readFile(filePath)
  if (buf.includes(0)) {
    throw new Error('这是二进制文件，不在编辑器中打开')
  }
  return buf.toString('utf-8')
})

ipcMain.handle('fs:write', async (event, { filePath, content }) => {
  const fs = require('fs/promises')
  const allowedDir = ctxOf(event)?.allowedDir
  if (isSensitivePath(filePath)) {
    throw new Error(`安全限制：禁止写入敏感文件 ${filePath}`)
  }
  if (allowedDir && !isPathAllowed(allowedDir, filePath)) {
    throw new Error(`安全限制：路径超出工作目录范围 (${allowedDir})`)
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
  // 文件内容变了，之前扫出来的符号位置可能已经失效
  symbolSearch.clearSymbolCache()
})

ipcMain.handle('fs:list', async (event, { dirPath }) => {
  const fs = require('fs/promises')
  const allowedDir = ctxOf(event)?.allowedDir
  if (allowedDir && !isPathAllowed(allowedDir, dirPath)) {
    throw new Error(`安全限制：目录超出工作目录范围 (${allowedDir})`)
  }
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  return entries.map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory(),
    path: path.join(dirPath, e.name),
  }))
})

// Create directory
ipcMain.handle('fs:mkdir', async (event, { dirPath }) => {
  const fs = require('fs/promises')
  const allowedDir = ctxOf(event)?.allowedDir
  if (allowedDir && !isPathAllowed(allowedDir, dirPath)) {
    throw new Error(`安全限制：路径超出工作目录范围 (${allowedDir})`)
  }
  await fs.mkdir(dirPath, { recursive: true })
})

// 把 src 复制进 targetDir，重名自动加「- 副本」序号，返回落地路径
async function copyInto(srcPath, targetDir, allowedDir) {
  const fs = require('fs/promises')
  if (isSensitivePath(srcPath)) {
    throw new Error('安全限制：禁止复制敏感文件')
  }
  let dest = path.join(targetDir, path.basename(srcPath))
  if (allowedDir && !isPathAllowed(allowedDir, dest)) {
    throw new Error(`安全限制：路径超出工作目录范围 (${allowedDir})`)
  }
  // 目标已存在时自动加序号，避免覆盖
  let counter = 1
  const ext = path.extname(dest)
  const baseName = path.basename(dest, ext)
  while (true) {
    try {
      await fs.access(dest)
      const dir = path.dirname(dest)
      dest = path.join(dir, `${baseName} - 副本${counter > 1 ? ` ${counter}` : ''}${ext}`)
      counter++
    } catch {
      break
    }
  }
  await fs.cp(srcPath, dest, { recursive: true })
  return dest
}

// Copy file/folder (recursive)
ipcMain.handle('fs:copy', async (event, { sourcePath, targetDir }) => {
  return copyInto(sourcePath, targetDir, ctxOf(event)?.allowedDir)
})

// 把 src 移动到 targetDir（剪切+粘贴），重名自动加「- 副本」序号，返回落地路径
async function moveInto(srcPath, targetDir, allowedDir) {
  const fs = require('fs/promises')
  if (isSensitivePath(srcPath)) {
    throw new Error('安全限制：禁止移动敏感文件')
  }
  const src = path.resolve(srcPath)
  const destDir = path.resolve(targetDir)
  // 不能把文件夹移动到它自己内部，否则会丢失
  if (src === destDir || destDir.startsWith(src + path.sep)) {
    throw new Error('安全限制：不能把文件夹移动到它自己内部')
  }
  let dest = path.join(destDir, path.basename(src))
  if (allowedDir && !isPathAllowed(allowedDir, dest)) {
    throw new Error(`安全限制：路径超出工作目录范围 (${allowedDir})`)
  }
  // 源和目标就是同一个位置，什么都不用做
  if (src === dest) return dest
  // 目标已存在时自动加序号，避免覆盖
  let counter = 1
  const ext = path.extname(dest)
  const baseName = path.basename(dest, ext)
  while (true) {
    try {
      await fs.access(dest)
      dest = path.join(path.dirname(dest), `${baseName} - 副本${counter > 1 ? ` ${counter}` : ''}${ext}`)
      counter++
    } catch {
      break
    }
  }
  try {
    await fs.rename(src, dest)
  } catch (e) {
    // 跨盘符时 rename 会抛 EXDEV，退化成「复制 + 删除」
    if (e && e.code === 'EXDEV') {
      await fs.cp(src, dest, { recursive: true })
      await fs.rm(src, { recursive: true, force: true })
    } else {
      throw e
    }
  }
  return dest
}

// Move file/folder into target directory
ipcMain.handle('fs:move', async (event, { sourcePath, targetDir }) => {
  return moveInto(sourcePath, targetDir, ctxOf(event)?.allowedDir)
})

// 从系统外部（拖拽 / 资源管理器复制）导入文件或文件夹到目标目录
ipcMain.handle('fs:import-paths', async (event, { sourcePaths, targetDir }) => {
  const fs = require('fs/promises')
  const allowedDir = ctxOf(event)?.allowedDir
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) return []
  const destDir = path.resolve(targetDir)
  if (allowedDir && !isPathAllowed(allowedDir, destDir)) {
    throw new Error(`安全限制：目录超出工作目录范围 (${allowedDir})`)
  }
  const imported = []
  for (const src of sourcePaths) {
    if (!src) continue
    const resolvedSrc = path.resolve(src)
    // 不允许把目录复制进它自己内部，否则会无限递归
    if (resolvedSrc === destDir || destDir.startsWith(resolvedSrc + path.sep)) continue
    try {
      await fs.access(resolvedSrc)
    } catch {
      continue // 源路径已不存在，跳过
    }
    imported.push(await copyInto(resolvedSrc, destDir, allowedDir))
  }
  return imported
})

// 读取系统剪贴板里的文件列表
// 注意：Electron 的 readBuffer('FileNameW') 在部分 Windows 环境下只返回第一个文件
// （实测选中 3 个文件时它只吐出第一个路径、且没有 DROPFILES 头），所以先走系统 API，
// 拿不到再退回解析 Electron 的缓冲区。
const PS_FILE_DROP_LIST = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$l = [System.Windows.Forms.Clipboard]::GetFileDropList()',
  'foreach ($f in $l) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($f)) }',
].join('; ')

function readClipboardFilesNative() {
  const { execFile } = require('child_process')
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', PS_FILE_DROP_LIST],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err || !stdout) return resolve([])
        resolve(
          stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((b64) => Buffer.from(b64, 'base64').toString('utf8'))
            .filter(Boolean),
        )
      },
    )
  })
}

/** 兜底解析：缓冲区可能是带 DROPFILES 头的 CF_HDROP，也可能是空字符分隔的路径列表 */
function parseClipboardFileBuffer(buf) {
  if (!buf || buf.length === 0) return []
  const headerOffset = buf.length >= 20 ? buf.readUInt32LE(0) : 0
  const body = headerOffset > 0 && headerOffset < buf.length ? buf.subarray(headerOffset) : buf
  return body
    .toString('utf16le')
    .split('\0')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/[\u0000-\u001f]/.test(s))
}

ipcMain.handle('clipboard:read-files', async () => {
  let fast = []
  try {
    const { clipboard } = require('electron')
    fast = parseClipboardFileBuffer(clipboard.readBuffer('FileNameW'))
  } catch {
    fast = []
  }
  // 读到多个说明这条链路是好的，直接用；只读到 0~1 个可能是被截断了，用系统 API 复核一次
  if (fast.length > 1) return fast
  if (process.platform === 'win32') {
    const list = await readClipboardFilesNative()
    if (list.length > 0) return list
  }
  return fast
})

// 把文件/文件夹写进系统剪贴板：这样在本应用里剪切/复制后，可以在资源管理器（或别的软件）
// 里直接 Ctrl+V。Windows 上要写入 CF_HDROP（文件拖放列表）才算「文件」，
// 顺带设置 Preferred DropEffect 让「剪切」在粘贴后表现为移动。
const PS_SET_FILE_DROP_LIST = (encodedPaths, cut) => [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$c = New-Object System.Collections.Specialized.StringCollection',
  ...encodedPaths.map(
    (b64) => `$c.Add([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
  ),
  '$d = New-Object System.Windows.Forms.DataObject',
  '$d.SetFileDropList($c)',
  // 这个格式必须是裸的 4 字节 DWORD：直接传 byte[] 会被 WinForms 序列化成一个 .NET 对象
  // （实测 48 字节），资源管理器按 DWORD 读只会拿到垃圾值、认不出「复制」，
  // 同盘粘贴就按移动处理，源文件被删 —— 也就是「Ctrl+C 复制变成了剪切」。
  // 只有 MemoryStream 才会把字节原样写进剪贴板。
  // DROPEFFECT_MOVE=2（剪切）/ DROPEFFECT_COPY|LINK=5（复制），与资源管理器一致
  `$ms = New-Object System.IO.MemoryStream(,[byte[]]@(${cut ? '2,0,0,0' : '5,0,0,0'}))`,
  `$d.SetData('Preferred DropEffect', $ms)`,
  // 第二个参数 $true = 离开本进程后剪贴板内容依然保留
  '[System.Windows.Forms.Clipboard]::SetDataObject($d, $true)',
].join('; ')

ipcMain.handle('clipboard:write-files', async (event, { paths, cut }) => {
  const list = (Array.isArray(paths) ? paths : [])
    .filter(Boolean)
    .map((p) => path.resolve(p))
  if (list.length === 0) return { ok: false }
  if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows' }
  const encoded = list.map((p) => Buffer.from(p, 'utf8').toString('base64'))
  const script = PS_SET_FILE_DROP_LIST(encoded, Boolean(cut))
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 6000 },
      (err) => resolve({ ok: !err, error: err ? err.message : undefined }),
    )
  })
})

// ─── 目录变更监听 ────────────────────────────────────────────────────────────
// 外部（资源管理器、其他软件、agent）改动文件后主动推给渲染进程，文件树无需手动刷新。
// 每个窗口各自监听自己的工作目录：多开时互不影响。
function startCtxWatch(ctx, dirPath) {
  stopCtxWatch(ctx)
  if (!dirPath || !ctx) return
  const fs = require('fs')
  try {
    // recursive 在 Windows/macOS 上原生支持，可覆盖整个子树
    ctx.watcher = fs.watch(dirPath, { recursive: true }, () => {
      // 编辑器保存/批量复制会触发大量事件，做防抖避免渲染进程被打爆
      if (ctx.watchTimer) clearTimeout(ctx.watchTimer)
      ctx.watchTimer = setTimeout(() => {
        ctx.watchTimer = null
        safeSend(ctx.win.webContents, 'fs:dir-changed', { dirPath })
      }, 300)
    })
    ctx.watcher.on('error', (e) => {
      console.error('[fs:watch] 监听失败:', e.message)
      stopCtxWatch(ctx)
    })
  } catch (e) {
    console.error('[fs:watch] 无法监听目录:', e.message)
  }
}

function stopCtxWatch(ctx) {
  if (!ctx) return
  if (ctx.watchTimer) {
    clearTimeout(ctx.watchTimer)
    ctx.watchTimer = null
  }
  if (ctx.watcher) {
    try { ctx.watcher.close() } catch { /* 忽略 */ }
    ctx.watcher = null
  }
}

function stopAllWatches() {
  for (const ctx of windows.values()) stopCtxWatch(ctx)
}

ipcMain.handle('fs:watch-dir', (event, { dirPath }) => {
  const ctx = ctxOf(event)
  if (ctx) startCtxWatch(ctx, dirPath)
  return { success: true }
})

// 在系统资源管理器中定位文件/文件夹
ipcMain.handle('shell:show-item', (event, { targetPath }) => {
  shell.showItemInFolder(path.resolve(targetPath))
  return { success: true }
})

// Delete file/folder
ipcMain.handle('fs:delete', async (event, { targetPath }) => {
  const fs = require('fs/promises')
  const allowedDir = ctxOf(event)?.allowedDir
  if (isSensitivePath(targetPath)) {
    throw new Error(`安全限制：禁止删除敏感文件`)
  }
  if (allowedDir && !isPathAllowed(allowedDir, targetPath)) {
    throw new Error(`安全限制：路径超出工作目录范围`)
  }
  await fs.rm(targetPath, { recursive: true })
})

// Rename file/folder
ipcMain.handle('fs:rename', async (event, { oldPath, newPath }) => {
  const fs = require('fs/promises')
  const allowedDir = ctxOf(event)?.allowedDir
  if (isSensitivePath(oldPath) || isSensitivePath(newPath)) {
    throw new Error(`安全限制：禁止重命名敏感文件`)
  }
  if (allowedDir && (!isPathAllowed(allowedDir, oldPath) || !isPathAllowed(allowedDir, newPath))) {
    throw new Error(`安全限制：路径超出工作目录范围`)
  }
  await fs.rename(oldPath, newPath)
})

// ─── Browser Control (Agent) ─────────────────────────────────────────────────
// Agent 可以通过内置 BrowserWindow 操控浏览器（每个窗口一个，互不干扰）
ipcMain.handle('browser:open', async (event, { url, width, height }) => {
  const ctx = ctxOf(event)
  if (!ctx) return { id: 'browser-main', url }
  const { BrowserWindow: BW } = require('electron')
  if (ctx.browserWindow && !ctx.browserWindow.isDestroyed()) {
    ctx.browserWindow.loadURL(url)
    ctx.browserWindow.focus()
    return { id: 'browser-main', url }
  }
  ctx.browserWindow = new BW({
    width: width || 1200,
    height: height || 800,
    parent: ctx.win,
    title: 'Yu Code Browser',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  ctx.browserWindow.loadURL(url)
  ctx.browserWindow.on('closed', () => { ctx.browserWindow = null })
  return { id: 'browser-main', url }
})

ipcMain.handle('browser:navigate', async (event, { url }) => {
  const bw = ctxOf(event)?.browserWindow
  if (bw && !bw.isDestroyed()) {
    await bw.loadURL(url)
    return { success: true }
  }
  return { success: false, error: 'No browser window open' }
})

ipcMain.handle('browser:execute', async (event, { script }) => {
  const bw = ctxOf(event)?.browserWindow
  if (bw && !bw.isDestroyed()) {
    const result = await bw.webContents.executeJavaScript(script)
    return { success: true, result }
  }
  return { success: false, error: 'No browser window open' }
})

ipcMain.handle('browser:screenshot', async (event) => {
  const ctx = ctxOf(event)
  const bw = ctx?.browserWindow
  if (bw && !bw.isDestroyed()) {
    const image = await bw.webContents.capturePage()
    const pngData = image.toPNG()
    const savePath = path.join(ctx.allowedDir || process.cwd(), `screenshot-${Date.now()}.png`)
    require('fs').writeFileSync(savePath, pngData)
    return { success: true, path: savePath }
  }
  return { success: false, error: 'No browser window open' }
})

ipcMain.handle('browser:close', async (event) => {
  const ctx = ctxOf(event)
  const bw = ctx?.browserWindow
  if (bw && !bw.isDestroyed()) {
    bw.close()
    if (ctx) ctx.browserWindow = null
  }
  return { success: true }
})

// ─── Agent 实例（每个窗口 × 每个会话一个）────────────────────────────────────
// 事件要能区分来自哪个会话：用一层 shim 顶替 agent 的 mainWindow，
// 发送时统一带上 __chatId，渲染进程据此把事件投递到对应会话的时间线。
// 这样同一窗口里多个会话可以各跑各的、互不打扰。
function agentShim(ctx, chatId) {
  return {
    isDestroyed: () => ctx.win.isDestroyed(),
    webContents: {
      send: (channel, payload) => {
        if (ctx.win.isDestroyed()) return
        ctx.win.webContents.send(channel, { __chatId: chatId, data: payload })
      },
    },
  }
}

// 默认用内置的 pi CLI 当引擎；自研引擎（YuCodeAgent）保留成回退路径。
// 切换方式：环境变量 YUCODE_AGENT_BACKEND=native|pi，或状态文件里的 agentBackend。
function pickBackend() {
  const fromEnv = String(process.env.YUCODE_AGENT_BACKEND || '').trim().toLowerCase()
  if (fromEnv === 'native' || fromEnv === 'pi') return fromEnv
  const saved = stateStore.getAll()?.agentBackend
  if (saved === 'native' || saved === 'pi') return saved
  return 'pi'
}

function newAgentInstance(ctx, chatId) {
  const wanted = pickBackend()
  const usePi = wanted === 'pi' && piRuntime.getPiInfo().available
  if (wanted === 'pi' && !usePi) {
    console.warn('[agent] 没有找到 pi CLI，回退到自研引擎')
  }
  const shim = agentShim(ctx, chatId)
  const projectDir = ctx.settings.projectDir || __dirname + '/..'
  let a
  if (usePi) {
    // pi 的会话落盘在 userData 下，不和用户自己的 ~/.pi 混在一起
    a = new PiAgent(shim, projectDir, {
      sessionDir: path.join(app.getPath('userData'), 'pi-sessions'),
    })
  } else {
    a = new YuCodeAgent(shim, projectDir)
  }
  if (mcp) a.setMcp?.(mcp)
  return a
}

/** 把窗口的 Agent 参数套到某个实例上（新会话也要按当前设置初始化） */
function applyAgentSettings(a, ctx) {
  const s = ctx.settings
  if (s.model) a.setModelConfig?.(s.model)
  a.setExtensions?.(s.extensions || [])
  a.setRiskConfirm?.(s.riskConfirm !== false)
  a.setAutoDiagnostics?.(s.autoDiagnostics !== false)
  // 计划模式默认关闭，只在开启时下发，避免新建会话时刷出「已关闭计划模式」的噪音
  if (s.planMode) a.setPlanMode?.(true)
}

/** 取该窗口下某个会话的 Agent；没有就按当前设置建一个（惰性创建，支持并发会话） */
function agentFor(ctx, chatId) {
  const key = chatId || 'default'
  let a = ctx.agents.get(key)
  if (a) return a
  a = newAgentInstance(ctx, key)
  // Pi 后端按 chatId 区分会话；自研后端按 messages 整段替换上下文
  a.loadContext?.({ chatId: key })
  applyAgentSettings(a, ctx)
  ctx.agents.set(key, a)
  return a
}

function forEachAgent(ctx, fn) {
  for (const a of ctx.agents.values()) {
    try { fn(a) } catch { /* 单个会话出错不影响其它会话 */ }
  }
}

// 发消息：必须带上 chatId，否则会把不同会话的内容串到一起
ipcMain.handle('agent:send', (event, { message, chatId, model } = {}) => {
  const ctx = ctxOf(event)
  if (!ctx) return { success: false, error: 'Window not found' }
  const a = agentFor(ctx, chatId)
  // 模型随消息一起来：每个会话按自己绑定的模型跑。
  // 放在 handleMessage 之前，pi 起会话时才能把 --model 带上。
  if (model) a.setModelConfig?.(model)
  a.handleMessage(message)
  return { success: true }
})

// 模型配置按会话下发：同一窗口里会话 1 用 A 模型、会话 2 用 B 模型都成立。
// 不带 chatId 时才作为窗口默认，广播给该窗口所有会话。
ipcMain.handle('agent:set-model', (event, payload) => {
  const ctx = ctxOf(event)
  if (!ctx) return
  const config = payload?.config ?? payload
  const chatId = payload?.chatId
  if (!config) return
  if (chatId) {
    // 只改已经存在的会话实例。这里不能走 agentFor —— 那会顺手新建 Agent 并调
    // loadContext，而自研引擎的 loadContext({}) 会把上下文清空，
    // 于是「切到正在跑的会话」就会把它的历史冲掉。还没建实例的会话，
    // 等它下次发消息时由 agent:send 带着模型一起建，不会漏。
    ctx.agents.get(chatId)?.setModelConfig?.(config)
    return
  }
  ctx.settings.model = config
  forEachAgent(ctx, (a) => a.setModelConfig?.(config))
})

// 设置页的「测试」：登记到 pi → 直连端点 → 让 pi 认一遍。
// 三步都在主进程做，渲染进程只负责显示 —— 直连端点在渲染进程会被 CORS 挡掉。
ipcMain.handle('model:test', (_event, config = {}) => testModel(config))

// 中断：只中断指定的那个会话，其它会话继续跑
ipcMain.handle('agent:interrupt', (event, { chatId } = {}) => {
  const ctx = ctxOf(event)
  if (ctx) agentFor(ctx, chatId).interrupt()
  return { success: true }
})

// 用户回答了 ask_user 的提问，把答案回填给挂起中的 Agent
ipcMain.handle('agent:answer', (event, { id, answer, chatId } = {}) => {
  const ctx = ctxOf(event)
  if (!ctx || !id) return { success: false }
  return { success: agentFor(ctx, chatId).answerQuestion(id, answer) }
})

// 让 Agent 的工作目录跟随左侧资源管理器打开的目录（该窗口下所有会话一起切）
ipcMain.handle('agent:set-project-dir', (event, { dirPath } = {}) => {
  const ctx = ctxOf(event)
  if (!ctx || !dirPath) return { success: true }
  ctx.settings.projectDir = dirPath
  forEachAgent(ctx, (a) => a.setProjectDir?.(dirPath))
  return { success: true }
})

// ctrl+左键跳转定义：优先问 LSP（能拿到语义上的真定义，跨文件跨包都准），
// 拿不到再退回「按名字扫全工程」。LSP 不可用时是静默降级，不影响原来的体验。
ipcMain.handle('search:symbol', async (event, { name, filePath, line, column } = {}) => {
  if (!name) return []
  const dir = ctxOf(event)?.allowedDir || process.cwd()
  if (filePath && line) {
    try {
      const hit = await lsp.findDefinition(dir, filePath, line, column || 1)
      // LSP 返回的是绝对路径，接口约定是「相对工作目录」，这里换算一次
      if (hit?.filePath) {
        const rel = path.relative(dir, hit.filePath)
        if (rel && !rel.startsWith('..')) {
          return [{ file: rel.replace(/\\/g, '/'), line: hit.line, column: hit.column }]
        }
      }
    } catch {
      /* 降级到符号扫描 */
    }
  }
  try {
    return symbolSearch.findSymbol(dir, String(name))
  } catch {
    return []
  }
})

ipcMain.handle('agent:clear', (event, { chatId } = {}) => {
  const ctx = ctxOf(event)
  if (ctx) agentFor(ctx, chatId).clearContext()
})

// 把「已安装且启用」的扩展同步给 Agent，让设置页的安装/开关真正生效
ipcMain.handle('agent:set-extensions', (event, { extensions } = {}) => {
  const ctx = ctxOf(event)
  if (!ctx) return { success: true }
  ctx.settings.extensions = Array.isArray(extensions) ? extensions : []
  forEachAgent(ctx, (a) => a.setExtensions?.(ctx.settings.extensions))
  return { success: true }
})

// 计划模式：只读规划，改文件/执行命令会被 Agent 拦下
ipcMain.handle('agent:set-plan-mode', (event, { enabled } = {}) => {
  const ctx = ctxOf(event)
  if (!ctx) return { success: true, planMode: Boolean(enabled) }
  ctx.settings.planMode = Boolean(enabled)
  forEachAgent(ctx, (a) => a.setPlanMode?.(Boolean(enabled)))
  return { success: true, planMode: Boolean(enabled) }
})

// 内置能力清单：如实展示哪些能力已原生生效、不需要装 Pi 扩展
ipcMain.handle('builtins:list', (event) => {
  const ctx = ctxOf(event)
  const a = ctx ? ctx.agents.values().next().value : null
  return a ? a.builtinCapabilities() : builtinsEngine.list(null)
})

// 危险操作确认开关：护栏命中时是「弹卡问用户」还是「直接拦下」
ipcMain.handle('agent:set-risk-confirm', (event, { enabled } = {}) => {
  const ctx = ctxOf(event)
  if (!ctx) return { success: true, askBeforeRisk: Boolean(enabled) }
  ctx.settings.riskConfirm = Boolean(enabled)
  forEachAgent(ctx, (a) => a.setRiskConfirm?.(Boolean(enabled)))
  return { success: true, askBeforeRisk: Boolean(enabled) }
})

// 改完文件是否自动把诊断结果回灌给 Agent
ipcMain.handle('agent:set-auto-diagnostics', (event, { enabled } = {}) => {
  const ctx = ctxOf(event)
  if (!ctx) return { success: true, autoDiagnostics: Boolean(enabled) }
  ctx.settings.autoDiagnostics = Boolean(enabled)
  forEachAgent(ctx, (a) => a.setAutoDiagnostics?.(Boolean(enabled)))
  return { success: true, autoDiagnostics: Boolean(enabled) }
})

// 把某个会话的历史灌回 Agent 上下文（切换会话、或重启后接着上次聊）
// chatId 是前端的聊天标签 id：Pi 后端按它对应一个 pi 会话，换标签就是换会话
ipcMain.handle('agent:load-context', (event, { messages, chatId } = {}) => {
  const ctx = ctxOf(event)
  if (!ctx) return { success: true }
  agentFor(ctx, chatId).loadContext({ messages, chatId })
  return { success: true }
})

// 列出 / 回退改动检查点（原生内置，等价于 Pi 的 git-checkpoint 扩展）
ipcMain.handle('checkpoints:list', (event) => {
  return checkpointEngine.list(ctxOf(event)?.allowedDir || process.cwd())
})

ipcMain.handle('checkpoints:restore', (event, { sha, removePaths } = {}) => {
  return checkpointEngine.restore(ctxOf(event)?.allowedDir || process.cwd(), sha, { removePaths })
})

// 编辑历史消息重跑：把 Agent 的对话上下文退回那条消息之前。
// pi 后端用它自己的 fork（会话存在 pi 里，改不了上下文），自研后端直接整段替换。
ipcMain.handle('agent:rewind', async (event, payload = {}) => {
  const ctx = ctxOf(event)
  if (!ctx) return { ok: false, error: 'Window not found' }
  const a = agentFor(ctx, payload.chatId)
  if (typeof a.rewind !== 'function') return { ok: false, error: '当前后端不支持回退' }
  try {
    return await a.rewind(payload)
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
})

// ─── MCP：外部工具（自研客户端，不依赖 pi CLI、不执行第三方扩展代码）─────────
// 每个 server 是一个子进程，连上后它的工具会以 mcp__<server>__<tool> 注册给模型
ipcMain.handle('mcp:list', () => (mcp ? mcp.listServers() : []))

ipcMain.handle('mcp:add', async (_event, { name, command, args } = {}) => {
  if (!mcp) return { ok: false, error: 'MCP 未初始化' }
  const added = mcp.addServer({ name, command, args })
  if (!added.ok) return added
  // 加完就试着连一次：连不上也要把 server 留在列表里，让用户看到失败原因
  const conn = await mcp.connect(added.id)
  return conn.ok ? { ok: true, id: added.id } : { ok: false, id: added.id, error: conn.error }
})

ipcMain.handle('mcp:remove', (_event, { id } = {}) => (mcp ? mcp.removeServer(id) : { ok: false, error: 'MCP 未初始化' }))

ipcMain.handle('mcp:toggle', async (_event, { id, enabled } = {}) => {
  if (!mcp) return { ok: false, error: 'MCP 未初始化' }
  const r = mcp.setEnabled(id, enabled)
  if (r.ok && enabled) await mcp.connect(id)
  return r
})

// 不带 id：所有启用的 server 重连一遍；带 id：只重连这一个
ipcMain.handle('mcp:refresh', async (_event, { id } = {}) => {
  if (!mcp) return { ok: false, error: 'MCP 未初始化' }
  if (!id) {
    await mcp.connectAll()
    return { ok: true }
  }
  const r = await mcp.refresh(id)
  return r.ok ? { ok: true } : { ok: false, error: r.error }
})

// ─── 扩展管理（安装 / 卸载 / 状态一律走内置的 pi CLI）────────────────────────
// 已安装：放进 skills 目录的 Skill + Pi 包里的 Skill + pi CLI 认的包本身
ipcMain.handle('extensions:list', (_event, { projectDir } = {}) => extensionsEngine.listInstalled(projectDir))

// 可安装清单（含是否已安装），清单文件可手工编辑扩充；安装状态取自 `pi list`
ipcMain.handle('extensions:catalog', () => extensionsEngine.catalogWithState())

// 真实安装：交给 `pi install <source>`
ipcMain.handle('extensions:install', async (_event, { source }) => extensionsEngine.install(source))

// 真实卸载：Pi 包走 `pi remove`，手工放进去的 Skill 删目录
ipcMain.handle('extensions:uninstall', (_event, { id, projectDir }) => extensionsEngine.uninstall(id, projectDir))

// 用系统文件管理器打开扩展目录，方便用户手动放 skill
ipcMain.handle('extensions:open-dir', async () => {
  const err = await shell.openPath(extensionsEngine.PI_AGENT_DIR)
  return { success: !err, error: err || undefined }
})

// Pi 运行时状态（内置在安装包里的那份，或用户自装的）
ipcMain.handle('pi:info', () => piRuntime.getPiInfo())

// 应用自身版本号（菜单栏「帮助 → 关于 Yu Code」显示用）
ipcMain.handle('app:version', () => app.getVersion())

// ─── 工作区状态持久化 ────────────────────────────────────────────────────────
// 用同步 IPC 把整个快照交给 preload：渲染进程创建 store 时需要同步拿到初始值。
// 数据量很小（几 KB 的 JSON），同步读取的开销可以接受。
//
// 快照里的「上次工作目录」在这里顺手校正一次，否则界面会先按旧目录渲染一遍
// （文件树、终端、Agent 都跟着走），之后才被纠正过来：
//   - 这个窗口自己的目标目录优先 —— 它是用户这一次要打开的工作区（多开时各不一样）；
//   - 上次的目录若已被删除/改名，直接去掉 —— 否则启动即报「读取目录失败」，
//     终端也会拿这个不存在的目录去 spawn。
ipcMain.on('state:load-sync', (event) => {
  const state = { ...stateStore.getAll() }
  const launchDir = ctxOf(event)?.allowedDir || ''
  if (launchDir) {
    state['pi-current-dir'] = launchDir
  } else if (state['pi-current-dir'] && !isExistingDir(state['pi-current-dir'])) {
    delete state['pi-current-dir']
  }
  event.returnValue = state
})

ipcMain.on('state:save', (_event, patch) => {
  stateStore.set(patch)
})

// Window controls（哪个窗口点的按钮就操作哪个窗口）
ipcMain.on('window:minimize', (event) => ctxWin(event)?.minimize())
ipcMain.on('window:maximize', (event) => {
  const win = ctxWin(event)
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
ipcMain.on('window:close', (event) => ctxWin(event)?.close())

// ─── 系统右键"用 Yu Code 打开"────────────────────────────────────────────────
// 从命令行参数里挑出路径。argv[0] 是 Electron 自身（形如 E:\...\electron.exe），必须排除，
// 否则会被当成待打开的路径，启动后把 180MB 的 exe 当文本读，直接把渲染进程撑爆。
function pathArgsFrom(argv) {
  return argv.filter((a, i) => {
    if (i === 0 || a.startsWith('-')) return false
    return /^[A-Za-z]:[\\/]/.test(a) || a.startsWith('\\\\') || a.startsWith('/')
  })
}

// 路径是不是一个真实存在的目录（不存在 / 无权限 / 是文件都算否）
function isExistingDir(target) {
  try { return Boolean(target) && require('fs').statSync(target).isDirectory() } catch { return false }
}

// 启动参数里的工作区目录：右键「用 Yu Code 打开」传进来的那个文件夹。
// 右击文件（走「打开方式」）时返回空串 —— 那种情况要保留上次的工作目录。
function launchTargetDir() {
  const target = pathArgsFrom(process.argv)[0]
  return isExistingDir(target) ? target : ''
}

// macOS：open-file 事件可能在 app ready 之前触发，先存下来
let pendingOsOpen = null

// 目录 → 当成工作区打开；文件 → 在编辑器里打开
function dispatchOsOpen(ctx, target) {
  if (!ctx || !target || ctx.win.isDestroyed()) return
  // 路径不存在时按文件处理，交给渲染进程提示打开失败
  safeSend(ctx.win.webContents, isExistingDir(target) ? 'folder:open' : 'file:open', target)
}

// 派发右键传入的路径。渲染进程还没挂载就先记下来，
// 等它注册好监听并发来 app:renderer-ready 再补发——否则冷启动时事件丢失，
// 界面只会显示上次持久化的工作目录（表现为"打开了上级目录"）。
function queueOsOpen(ctx, target) {
  if (!ctx || !target) return
  if (!ctx.rendererReady) {
    ctx.pendingOpen = target
    return
  }
  dispatchOsOpen(ctx, target)
}

/**
 * 打开一个来自系统（右键 / 启动参数 / 菜单选择）的路径，是多开的统一入口：
 *   目录 → 已经打开就聚焦那个窗口，没打开就新起一个窗口（原来的窗口保持不变）；
 *   文件 → 在聚焦窗口里打开（没有窗口就新建一个）。
 */
function openTarget(target) {
  if (!target) {
    // 没有具体路径（例如重复点击图标）：聚焦已有窗口
    const win = firstWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    } else {
      createWindow('')
    }
    return { ok: true, opened: 'focused' }
  }

  if (isExistingDir(target)) {
    const resolved = path.resolve(target)
    // 该目录已经打开过：聚焦原来的窗口，不再新起，避免同一个工作区开两遍
    for (const ctx of windows.values()) {
      if (ctx.win.isDestroyed()) continue
      if (ctx.allowedDir && path.resolve(ctx.allowedDir) === resolved) {
        if (ctx.win.isMinimized()) ctx.win.restore()
        ctx.win.focus()
        return { ok: true, dir: resolved, opened: 'focused' }
      }
    }
    createWindow(resolved)
    return { ok: true, dir: resolved, opened: 'created' }
  }

  // 文件：在当前聚焦的窗口里打开；一个窗口都没有就先建一个
  const focused = BrowserWindow.getFocusedWindow()
  let ctx = focused ? windows.get(focused.webContents.id) : null
  if (!ctx) ctx = windows.values().next().value
  if (!ctx) createWindow(target)
  else queueOsOpen(ctx, target)
  return { ok: true, path: target, opened: 'created' }
}

ipcMain.on('app:renderer-ready', (event) => {
  const ctx = ctxOf(event)
  if (!ctx) return
  ctx.rendererReady = true
  const target = ctx.pendingOpen
  ctx.pendingOpen = null
  dispatchOsOpen(ctx, target)
})

app.whenReady().then(() => {
  // 状态文件路径依赖 app.getPath('userData')，必须在 app ready 之后再初始化
  stateStore.init()
  // 改动检查点：自建的文件快照（不用 git）统一存到 userData 下，
  // 免得往用户的桌面/项目目录里塞东西。
  checkpointEngine.setStoreRoot(path.join(app.getPath('userData'), 'code-snapshots'))
  // 先建窗口，再去做耗时的同步初始化：启动进度条要在第一时间就能看到。
  // 启动参数里的目录/文件由窗口自己带过去（多开时每个窗口各有自己的目标）。
  createWindow(pathArgsFrom(process.argv)[0] || '')
  // 内置扩展：把随包分发的扩展补进 pi 的包目录，必须在建 Agent 之前完成。
  // 只在扩展集合变化时做一次，之后用户自己的增删不会被覆盖。
  bundledExtensions.ensure()
  // 自定义扩展（后台任务、项目规则写入）：写进 pi 的全局扩展目录，让 pi 起会话时
  // 自动加载。同样要在建 Agent 之前完成。
  customExtensions.ensure()

  // MCP 客户端：内置 git server 开箱即连，用户自加的 server 落盘在 userData 下。
  // 连不上只是这个 server 不可用，不影响应用启动，所以这里不 await。
  mcp = new McpManager(path.join(app.getPath('userData'), 'mcp-servers.json'))
  mcp.setProjectDir(launchTargetDir() || stateStore.getAll()?.['pi-current-dir'] || process.cwd())
  mcp.connectAll().catch((e) => console.error('[mcp] 启动连接失败:', e?.message || e))

  // Agent 是惰性创建的（窗口真的发消息/切会话时才建），但可能已有窗口抢在
  // mcp 初始化前就建好了会话，这里补一次 setMcp，避免它们拿不到 MCP 工具。
  for (const ctx of windows.values()) forEachAgent(ctx, (a) => a.setMcp?.(mcp))

  // macOS：ready 之前收到的 open-file 在这里补发
  if (pendingOsOpen) {
    const t = pendingOsOpen
    pendingOsOpen = null
    openTarget(t)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow('')
  })
})

// macOS: open-file 事件（把文件/目录拖到 Dock 图标上）
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (app.isReady()) openTarget(filePath)
  else pendingOsOpen = filePath
})

// Windows: 单实例 + second-instance 接收新文件
// 开发模式下不抢锁：否则先启动的 dev 实例会占住锁，
// 后启动的实例 requestSingleInstanceLock 失败后直接 app.quit()（退出码 0），
// 表现就是"npm run dev 打开了但桌面应用窗口弹不出来"。
if (isDev) {
  console.log('[dev] 开发模式：跳过单实例锁，避免多实例互相挤掉')
} else {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    app.on('second-instance', (_event, argv) => {
      // 带目录：已打开就聚焦，没打开就新起一个窗口（支持多开）；
      // 不带目录（例如重复点图标）：聚焦已有窗口，不再新起。
      openTarget(pathArgsFrom(argv)[0] || '')
    })
  }
}

app.on('window-all-closed', () => {
  try { stopAllWatches() } catch { /* 监听清理失败不能拦住退出 */ }
  if (process.platform !== 'darwin') app.quit()
})

// 退出前把防抖中未落盘的状态写掉，避免最后几步操作丢失；
// 同时把每个窗口的 MCP / LSP / pi 子进程收干净，否则会留下孤儿进程占着端口
app.on('before-quit', () => {
  stateStore.flush()
  // 终端（powershell/conhost 及其命令子进程）也必须在这里收掉：
  // 有的退出路径不经过窗口 closed（或 closed 里 pty.kill 的异步清理来不及跑完），
  // 残留的终端进程会把主进程卡死，表现为关闭应用后任务管理器仍有残余进程。
  for (const id of [...terminals.keys()]) killTerminal(id)
  for (const ctx of windows.values()) {
    ctx.terminalIds.clear()
    for (const a of ctx.agents.values()) {
      try { a.shutdown?.() } catch { /* ignore */ }
    }
  }
  try { mcp?.disposeAll() } catch { /* ignore */ }
  try { lsp.disposeAll() } catch { /* ignore */ }
})
