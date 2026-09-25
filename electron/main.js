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

let mainWindow
let agent
let mcp

// 右键"用 Yu Code 打开"在冷启动时传入的路径。
// 渲染进程挂载完成前发的 IPC 会直接丢掉，所以先存下来，等渲染进程报到后再派发。
let pendingOsOpen = null
let rendererReady = false

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

function createWindow() {
  // 新窗口的渲染进程还没挂载，等它发 app:renderer-ready 后再派发待打开的路径
  rendererReady = false
  mainWindow = new BrowserWindow({
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

  // 渲染进程崩溃/加载失败时把原因输出到终端，便于排查白屏
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process gone:', details)
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`)
  })
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[renderer] preload error:', preloadPath, error)
  })

  if (isDev) {
    // 开发模式下把渲染进程的控制台输出转发到终端，便于排查
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} @ ${sourceId}:${line}`)
    })
    // 仅在显式设置 DEBUG_DEVTOOLS=1 时才弹出开发者工具，避免默认遮挡主窗口
    if (process.env.DEBUG_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
    resolveDevUrl().then((url) => {
      console.log(`[dev] loading ${url}`)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(url)
      }
    })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// Terminal management
const terminals = new Map()
let terminalCounter = 0

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
        event.sender.send(`terminal:data:${id}`, data)
      })
      p.onExit(({ exitCode }) => {
        event.sender.send(`terminal:close:${id}`, exitCode)
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
    event.sender.send(`terminal:data:${id}`, data)
  })
  proc.stderr.on('data', (data) => {
    event.sender.send(`terminal:data:${id}`, data)
  })
  // 启动失败（shell 找不到、cwd 无效等）会走 error 事件而不是 close：
  // 不接住它就是主进程未捕获异常，整个应用弹「A JavaScript error occurred in the main process」。
  proc.on('error', (e) => {
    console.error(`[terminal] 启动失败: ${e.message}`)
    terminals.delete(id)
    event.sender.send(`terminal:close:${id}`, -1)
  })
  proc.on('close', (code) => {
    event.sender.send(`terminal:close:${id}`, code)
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
  const proc = terminals.get(id)
  if (proc) {
    proc.kill()
    terminals.delete(id)
  }
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
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择文件夹',
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// Native dialog - open file
ipcMain.handle('dialog:open-file', async (event) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: '选择文件',
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// Create new file (save dialog)
ipcMain.handle('file:create', async (event) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '新建文件',
    defaultPath: path.join(process.cwd(), 'untitled.txt'),
  })
  if (result.canceled || !result.filePath) return null
  const fs = require('fs/promises')
  await fs.writeFile(result.filePath, '', 'utf-8')
  event.sender.send('file:created', { filePath: result.filePath })
  return result.filePath
})

// Open folder and notify renderer
ipcMain.handle('folder:open-and-set', async (event) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '打开文件夹',
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const dirPath = result.filePaths[0]
  event.sender.send('folder:opened', { dirPath })
  return dirPath
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
// 限制 agent 只能访问已打开的项目目录及其子目录
let allowedDir = null

ipcMain.on('security:set-allowed-dir', (event, { dirPath }) => {
  allowedDir = path.resolve(dirPath)
  console.log(`[Security] Allowed directory set to: ${allowedDir}`)
  // 工作目录变化时同步切换文件监听
  startDirWatch(allowedDir)
})

function isPathAllowed(targetPath) {
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
  if (isSensitivePath(filePath)) {
    throw new Error(`安全限制：禁止写入敏感文件 ${filePath}`)
  }
  if (allowedDir && !isPathAllowed(filePath)) {
    throw new Error(`安全限制：路径超出工作目录范围 (${allowedDir})`)
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
  // 文件内容变了，之前扫出来的符号位置可能已经失效
  symbolSearch.clearSymbolCache()
})

ipcMain.handle('fs:list', async (event, { dirPath }) => {
  const fs = require('fs/promises')
  if (allowedDir && !isPathAllowed(dirPath)) {
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
  if (allowedDir && !isPathAllowed(dirPath)) {
    throw new Error(`安全限制：路径超出工作目录范围 (${allowedDir})`)
  }
  await fs.mkdir(dirPath, { recursive: true })
})

// 把 src 复制进 targetDir，重名自动加「- 副本」序号，返回落地路径
async function copyInto(srcPath, targetDir) {
  const fs = require('fs/promises')
  if (isSensitivePath(srcPath)) {
    throw new Error('安全限制：禁止复制敏感文件')
  }
  let dest = path.join(targetDir, path.basename(srcPath))
  if (allowedDir && !isPathAllowed(dest)) {
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
  return copyInto(sourcePath, targetDir)
})

// 把 src 移动到 targetDir（剪切+粘贴），重名自动加「- 副本」序号，返回落地路径
async function moveInto(srcPath, targetDir) {
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
  if (allowedDir && !isPathAllowed(dest)) {
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
  return moveInto(sourcePath, targetDir)
})

// 从系统外部（拖拽 / 资源管理器复制）导入文件或文件夹到目标目录
ipcMain.handle('fs:import-paths', async (event, { sourcePaths, targetDir }) => {
  const fs = require('fs/promises')
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) return []
  const destDir = path.resolve(targetDir)
  if (allowedDir && !isPathAllowed(destDir)) {
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
    imported.push(await copyInto(resolvedSrc, destDir))
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
// 外部（资源管理器、其他软件、agent）改动文件后主动推给渲染进程，文件树无需手动刷新
let dirWatcher = null
let watchTimer = null

function startDirWatch(dirPath) {
  stopDirWatch()
  if (!dirPath) return
  const fs = require('fs')
  try {
    // recursive 在 Windows/macOS 上原生支持，可覆盖整个子树
    dirWatcher = fs.watch(dirPath, { recursive: true }, () => {
      // 编辑器保存/批量复制会触发大量事件，做防抖避免渲染进程被打爆
      if (watchTimer) clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        watchTimer = null
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('fs:dir-changed', { dirPath })
        }
      }, 300)
    })
    dirWatcher.on('error', (e) => {
      console.error('[fs:watch] 监听失败:', e.message)
      stopDirWatch()
    })
  } catch (e) {
    console.error('[fs:watch] 无法监听目录:', e.message)
  }
}

function stopDirWatch() {
  if (watchTimer) {
    clearTimeout(watchTimer)
    watchTimer = null
  }
  if (dirWatcher) {
    try { dirWatcher.close() } catch { /* 忽略 */ }
    dirWatcher = null
  }
}

ipcMain.handle('fs:watch-dir', (event, { dirPath }) => {
  startDirWatch(dirPath)
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
  if (isSensitivePath(targetPath)) {
    throw new Error(`安全限制：禁止删除敏感文件`)
  }
  if (allowedDir && !isPathAllowed(targetPath)) {
    throw new Error(`安全限制：路径超出工作目录范围`)
  }
  await fs.rm(targetPath, { recursive: true })
})

// Rename file/folder
ipcMain.handle('fs:rename', async (event, { oldPath, newPath }) => {
  const fs = require('fs/promises')
  if (isSensitivePath(oldPath) || isSensitivePath(newPath)) {
    throw new Error(`安全限制：禁止重命名敏感文件`)
  }
  if (allowedDir && (!isPathAllowed(oldPath) || !isPathAllowed(newPath))) {
    throw new Error(`安全限制：路径超出工作目录范围`)
  }
  await fs.rename(oldPath, newPath)
})

// ─── Browser Control (Agent) ─────────────────────────────────────────────────
// Agent 可以通过内置 BrowserWindow 操控浏览器
let browserWindow = null

ipcMain.handle('browser:open', async (event, { url, width, height }) => {
  const { BrowserWindow: BW } = require('electron')
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.loadURL(url)
    browserWindow.focus()
    return { id: 'browser-main', url }
  }
  browserWindow = new BW({
    width: width || 1200,
    height: height || 800,
    parent: mainWindow,
    title: 'Yu Code Browser',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  browserWindow.loadURL(url)
  browserWindow.on('closed', () => { browserWindow = null })
  return { id: 'browser-main', url }
})

ipcMain.handle('browser:navigate', async (event, { url }) => {
  if (browserWindow && !browserWindow.isDestroyed()) {
    await browserWindow.loadURL(url)
    return { success: true }
  }
  return { success: false, error: 'No browser window open' }
})

ipcMain.handle('browser:execute', async (event, { script }) => {
  if (browserWindow && !browserWindow.isDestroyed()) {
    const result = await browserWindow.webContents.executeJavaScript(script)
    return { success: true, result }
  }
  return { success: false, error: 'No browser window open' }
})

ipcMain.handle('browser:screenshot', async (event) => {
  if (browserWindow && !browserWindow.isDestroyed()) {
    const image = await browserWindow.webContents.capturePage()
    const pngData = image.toPNG()
    const savePath = path.join(allowedDir || process.cwd(), `screenshot-${Date.now()}.png`)
    require('fs').writeFileSync(savePath, pngData)
    return { success: true, path: savePath }
  }
  return { success: false, error: 'No browser window open' }
})

ipcMain.handle('browser:close', async () => {
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.close()
    browserWindow = null
  }
  return { success: true }
})

// Agent service
ipcMain.handle('agent:send', (event, { message }) => {
  if (agent) {
    agent.handleMessage(message)
    return { success: true }
  }
  return { success: false, error: 'Agent not initialized' }
})

ipcMain.handle('agent:set-model', (event, config) => {
  if (agent) agent.setModelConfig(config)
})

// 设置页的「测试」：登记到 pi → 直连端点 → 让 pi 认一遍。
// 三步都在主进程做，渲染进程只负责显示 —— 直连端点在渲染进程会被 CORS 挡掉。
ipcMain.handle('model:test', (_event, config = {}) => testModel(config))

// 中断当前执行
ipcMain.handle('agent:interrupt', () => {
  if (agent) agent.interrupt()
  return { success: true }
})

// 用户回答了 ask_user 的提问，把答案回填给挂起中的 Agent
ipcMain.handle('agent:answer', (event, { id, answer } = {}) => {
  if (agent && id) return { success: agent.answerQuestion(id, answer) }
  return { success: false }
})

// 让 Agent 的工作目录跟随左侧资源管理器打开的目录
ipcMain.handle('agent:set-project-dir', (event, { dirPath }) => {
  if (agent && dirPath) agent.setProjectDir(dirPath)
  return { success: true }
})

// ctrl+左键跳转定义：优先问 LSP（能拿到语义上的真定义，跨文件跨包都准），
// 拿不到再退回「按名字扫全工程」。LSP 不可用时是静默降级，不影响原来的体验。
ipcMain.handle('search:symbol', async (event, { name, filePath, line, column } = {}) => {
  if (!name) return []
  const dir = allowedDir || (agent && agent.projectDir) || process.cwd()
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

ipcMain.handle('agent:clear', () => {
  if (agent) agent.clearContext()
})

// 把「已安装且启用」的扩展同步给 Agent，让设置页的安装/开关真正生效
ipcMain.handle('agent:set-extensions', (event, { extensions }) => {
  if (agent) agent.setExtensions(extensions)
  return { success: true }
})

// 计划模式：只读规划，改文件/执行命令会被 Agent 拦下
ipcMain.handle('agent:set-plan-mode', (_event, { enabled } = {}) => {
  if (agent) agent.setPlanMode(enabled)
  return { success: true, planMode: Boolean(enabled) }
})

// 内置能力清单：如实展示哪些能力已原生生效、不需要装 Pi 扩展
ipcMain.handle('builtins:list', () => (agent ? agent.builtinCapabilities() : builtinsEngine.list(null)))

// 危险操作确认开关：护栏命中时是「弹卡问用户」还是「直接拦下」
ipcMain.handle('agent:set-risk-confirm', (_event, { enabled } = {}) => {
  if (agent) agent.setRiskConfirm(enabled)
  return { success: true, askBeforeRisk: Boolean(enabled) }
})

// 改完文件是否自动把诊断结果回灌给 Agent
ipcMain.handle('agent:set-auto-diagnostics', (_event, { enabled } = {}) => {
  if (agent) agent.setAutoDiagnostics(enabled)
  return { success: true, autoDiagnostics: Boolean(enabled) }
})

// 把某个会话的历史灌回 Agent 上下文（切换会话、或重启后接着上次聊）
// chatId 是前端的聊天标签 id：Pi 后端按它对应一个 pi 会话，换标签就是换会话
ipcMain.handle('agent:load-context', (_event, { messages, chatId } = {}) => {
  if (agent) agent.loadContext({ messages, chatId })
  return { success: true }
})

// 列出 / 回退改动检查点（原生内置，等价于 Pi 的 git-checkpoint 扩展）
ipcMain.handle('checkpoints:list', () => {
  const dir = allowedDir || (agent && agent.projectDir) || process.cwd()
  return checkpointEngine.list(dir)
})

ipcMain.handle('checkpoints:restore', (_event, { sha, removePaths } = {}) => {
  const dir = allowedDir || (agent && agent.projectDir) || process.cwd()
  return checkpointEngine.restore(dir, sha, { removePaths })
})

// 编辑历史消息重跑：把 Agent 的对话上下文退回那条消息之前。
// pi 后端用它自己的 fork（会话存在 pi 里，改不了上下文），自研后端直接整段替换。
ipcMain.handle('agent:rewind', async (_event, payload = {}) => {
  if (!agent || typeof agent.rewind !== 'function') return { ok: false, error: '当前后端不支持回退' }
  try {
    return await agent.rewind(payload)
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
// （文件树、终端、Agent 都跟着走），之后才被 folder:open 纠正过来：
//   - 右键「用 Yu Code 打开」传入的目录优先 —— 它才是用户这一次要打开的工作区；
//   - 上次的目录若已被删除/改名，直接去掉 —— 否则启动即报「读取目录失败」，
//     终端也会拿这个不存在的目录去 spawn。
ipcMain.on('state:load-sync', (event) => {
  const state = { ...stateStore.getAll() }
  const launchDir = launchTargetDir()
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

// Window controls
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('window:close', () => mainWindow?.close())

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

// 目录 → 当成工作区打开；文件 → 在编辑器里打开
function dispatchOsOpen(target) {
  if (!target || !mainWindow || mainWindow.isDestroyed()) return
  // 路径不存在时按文件处理，交给渲染进程提示打开失败
  mainWindow.webContents.send(isExistingDir(target) ? 'folder:open' : 'file:open', target)
}

// 派发右键传入的路径。渲染进程还没挂载就先记下来，
// 等它注册好监听并发来 app:renderer-ready 再补发——否则冷启动时事件丢失，
// 界面只会显示上次持久化的工作目录（表现为"打开了上级目录"）。
function queueOsOpen(target) {
  if (!target) return
  if (!rendererReady) {
    pendingOsOpen = target
    return
  }
  dispatchOsOpen(target)
}

ipcMain.on('app:renderer-ready', () => {
  rendererReady = true
  const target = pendingOsOpen
  pendingOsOpen = null
  dispatchOsOpen(target)
})

// ─── Agent 后端选择 ─────────────────────────────────────────────────────────
// 默认用内置的 pi CLI 当引擎：工具、扩展、子代理、技能全部由 pi 提供，本应用负责展示。
// 自研引擎（YuCodeAgent）保留成回退路径，pi 不可用或显式要求时启用。
// 切换方式：环境变量 YUCODE_AGENT_BACKEND=native|pi，或状态文件里的 agentBackend。
function pickBackend() {
  const fromEnv = String(process.env.YUCODE_AGENT_BACKEND || '').trim().toLowerCase()
  if (fromEnv === 'native' || fromEnv === 'pi') return fromEnv
  const saved = stateStore.getAll()?.agentBackend
  if (saved === 'native' || saved === 'pi') return saved
  return 'pi'
}

function createAgent() {
  const wanted = pickBackend()
  const usePi = wanted === 'pi' && piRuntime.getPiInfo().available
  if (wanted === 'pi' && !usePi) {
    console.warn('[agent] 没有找到 pi CLI，回退到自研引擎')
  }
  if (usePi) {
    // pi 的会话落盘在 userData 下，不和用户自己的 ~/.pi 混在一起
    return new PiAgent(mainWindow, __dirname + '/..', {
      sessionDir: path.join(app.getPath('userData'), 'pi-sessions'),
    })
  }
  const native = new YuCodeAgent(mainWindow, __dirname + '/..')
  return native
}

app.whenReady().then(() => {
  // 状态文件路径依赖 app.getPath('userData')，必须在 app ready 之后再初始化
  stateStore.init()
  // 改动检查点：自建的文件快照（不用 git）统一存到 userData 下，
  // 免得往用户的桌面/项目目录里塞东西。
  checkpointEngine.setStoreRoot(path.join(app.getPath('userData'), 'code-snapshots'))
  // 先建窗口，再去做耗时的同步初始化：启动进度条要在第一时间就能看到。
  createWindow()
  // 内置扩展：把随包分发的扩展补进 pi 的包目录，必须在建 Agent 之前完成。
  // 只在扩展集合变化时做一次，之后用户自己的增删不会被覆盖。
  bundledExtensions.ensure()
  // 自定义扩展（后台任务、项目规则写入）：写进 pi 的全局扩展目录，让 pi 起会话时
  // 自动加载。同样要在建 Agent 之前完成。
  customExtensions.ensure()
  agent = createAgent()

  // MCP 客户端：内置 git server 开箱即连，用户自加的 server 落盘在 userData 下。
  // 连不上只是这个 server 不可用，不影响应用启动，所以这里不 await。
  mcp = new McpManager(path.join(app.getPath('userData'), 'mcp-servers.json'))
  mcp.setProjectDir(agent.projectDir)
  agent.setMcp(mcp)
  mcp.connectAll().catch((e) => console.error('[mcp] 启动连接失败:', e?.message || e))

  // 处理通过右键"用 Yu Code 打开"传入的路径。
  // 不能在这里定时器硬发：冷启动时渲染进程要几秒才挂载完，固定延迟要么太早（事件丢失）
  // 要么太晚（窗口已经亮着空目录）。改成等渲染进程就绪的信号。
  queueOsOpen(pathArgsFrom(process.argv)[0])

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// macOS: open-file 事件
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  queueOsOpen(filePath)
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
      const target = pathArgsFrom(argv)[0]
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
        // 走队列：窗口存在但渲染进程首次还没挂载完时，事件同样会丢
        queueOsOpen(target)
      }
    })
  }
}

app.on('window-all-closed', () => {
  stopDirWatch()
  if (process.platform !== 'darwin') app.quit()
})

// 退出前把防抖中未落盘的状态写掉，避免最后几步操作丢失；
// 同时把 MCP / LSP / pi 拉起的子进程收干净，否则会留下孤儿进程占着端口
app.on('before-quit', () => {
  stateStore.flush()
  try { agent?.shutdown?.() } catch { /* ignore */ }
  try { mcp?.disposeAll() } catch { /* ignore */ }
  try { lsp.disposeAll() } catch { /* ignore */ }
})
