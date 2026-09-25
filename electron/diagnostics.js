/**
 * 诊断（Diagnostics）—— 让 Agent 改完代码能立刻知道「改出错了没有」。
 *
 * 这是 Codex / Trae 里很关键的一环：写完不校验，模型就会自信地交付一堆编译不过的代码。
 * 本模块给出两套后端，按可用性自动选：
 *   1. LSP（lsp.js）：装了 typescript-language-server / pyright 时用，精确且快
 *   2. 工程自带检查器：node_modules 里的 tsc、或 python 的 py_compile —— 不需要额外装东西
 * 两套都不满足时返回空数组，不打扰用户、不阻塞流程。
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const lsp = require('./lsp')

const TSC_TIMEOUT = 25000
/** tsc 是工程级检查：结果按「工程」缓存，一次编辑风暴里只跑一遍 */
const PROJECT_CACHE_TTL = 15000
/** LSP / py_compile 是单文件检查：按文件缓存 */
const FILE_CACHE_TTL = 15000
const MAX_ITEMS = 10
const MAX_PROJECT_ITEMS = 30

const fileCache = new Map() // filePath → { at, result }
const projectCache = new Map() // projectDir → { at, items, backend, note }

const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts'])
const JS_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs'])

/** 语言判定与 lsp.js 保持一致：js 也交给 typescript 这套工具链 */
function langOf(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  if (TS_EXT.has(ext)) return 'typescript'
  if (JS_EXT.has(ext)) return 'javascript'
  if (ext === '.py') return 'python'
  return null
}

// ---------------------------------------------------------------- 工具链探测

/** 工程内自带的 tsc（typescript/bin/tsc 是纯 JS，用 Electron 自带的 Node 跑，不依赖 PATH） */
function findTsc(projectDir) {
  const js = path.join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc')
  return fs.existsSync(js) ? js : null
}

function findPython(projectDir) {
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin'
  const exe = process.platform === 'win32' ? 'python.exe' : 'python'
  for (const venv of ['.venv', 'venv']) {
    const p = path.join(projectDir, venv, binDir, exe)
    if (fs.existsSync(p)) return p
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** 当前工程能用哪些诊断后端。设置页与内置能力清单会展示这个 */
function describe(projectDir) {
  const out = {}
  try {
    const lspInfo = lsp.describe(projectDir)
    out.typescript = lspInfo.typescript?.available
      ? { available: true, backend: 'LSP', command: lspInfo.typescript.command }
      : findTsc(projectDir) && fs.existsSync(path.join(projectDir, 'tsconfig.json'))
        ? { available: true, backend: 'tsc', command: 'node_modules/typescript/bin/tsc' }
        : { available: false, reason: '既没有 language server，也没有 node_modules/typescript + tsconfig.json' }
    out.python = lspInfo.python?.available
      ? { available: true, backend: 'LSP', command: lspInfo.python.command }
      : { available: true, backend: 'py_compile', command: findPython(projectDir) }
  } catch (e) {
    console.error('[diagnostics] describe 失败：', e?.message)
  }
  return out
}

// ---------------------------------------------------------------- 执行

/** 跑一个子进程并收集 stdout/stderr，超时杀进程。永不 reject */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}) },
        windowsHide: true,
        shell: Boolean(opts.shell),
      })
    } catch (e) {
      return resolve({ ok: false, out: '', err: e.message })
    }
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 已经退出 */ }
      resolve({ ok: false, out, err: err || `超时（${opts.timeout}ms）`, timedOut: true })
    }, opts.timeout || 20000)

    child.stdout?.on('data', (c) => { if (out.length < 200000) out += c.toString('utf-8') })
    child.stderr?.on('data', (c) => { if (err.length < 200000) err += c.toString('utf-8') })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, out, err: e.message })
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: true, out, err })
    })
  })
}

/** tsc 的输出行形如 `src/a.ts(12,3): error TS2304: Cannot find name 'X'.` */
function parseTsc(out, projectDir, limit) {
  const cap = limit || MAX_ITEMS
  const items = []
  for (const raw of String(out || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('error TS5')) continue // 配置类错误（无文件无位置），不作为文件诊断回灌
    const m = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/.exec(line)
    if (!m) continue
    // tsc 打印的是「相对它自己 cwd（= projectDir）」的路径，必须相对 projectDir 还原；
    // 直接用 path.resolve 会按本进程的 cwd 解析，得到错的绝对路径。
    const file = path.resolve(projectDir, m[1])
    items.push({
      file,
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] === 'error' ? 'error' : 'warning',
      message: m[6],
      source: m[5],
    })
    if (items.length >= cap) break
  }
  return items
}

/** py_compile 的报错形如 `  File "a.py", line 3` + 下一行的 `SyntaxError: ...` */
function parsePyCompile(err) {
  const text = String(err || '')
  const m = /File "(.+?)", line (\d+)([\s\S]*)/.exec(text)
  if (!m) return []
  const detail = m[3].split('\n').filter((l) => l.trim()).slice(-1)[0] || '语法错误'
  return [{
    file: path.resolve(m[1]),
    line: Number(m[2]),
    column: 1,
    severity: 'error',
    message: detail.trim().slice(0, 300),
    source: 'python',
  }]
}

/**
 * 编辑序号：每次文件被改动就 +1。
 * 工程级缓存的「有效」判据是「这次 tsc 开始之后没再改过文件」，
 * 这样既不会把改之前的旧结果当成本次结果，也不会在连续编辑时反复重跑。
 */
let editSeq = 0

/** TypeScript 后端：跑一次工程级 tsc --noEmit，结果按「工程」复用 */
async function projectTsc(projectDir) {
  const tsc = findTsc(projectDir)
  if (!tsc || !fs.existsSync(path.join(projectDir, 'tsconfig.json'))) {
    return { items: [], backend: 'none', note: '工程里没有 node_modules/typescript + tsconfig.json' }
  }
  const res = await run(process.execPath, [tsc, '--noEmit', '--pretty', 'false'], {
    cwd: projectDir,
    timeout: TSC_TIMEOUT,
    // Electron 的可执行文件加这个环境变量就当纯 Node 用，打包后也能跑（不依赖系统 node）
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })
  return {
    items: parseTsc(`${res.out}\n${res.err}`, projectDir, MAX_PROJECT_ITEMS),
    backend: 'tsc',
    note: res.timedOut ? `检查超时（${TSC_TIMEOUT / 1000}s）` : '',
    ranAt: Date.now(),
  }
}

async function cachedProjectTsc(projectDir, seqAtStart) {
  const hit = projectCache.get(projectDir)
  if (hit && hit.seq === seqAtStart && hit.ranAt && Date.now() - hit.ranAt < 120000) return hit
  const entry = { ...(await projectTsc(projectDir)), seq: seqAtStart }
  projectCache.set(projectDir, entry)
  return entry
}

async function runPyCompile(projectDir, filePath) {
  const py = findPython(projectDir)
  const res = await run(py, ['-c', 'import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)', filePath], {
    cwd: projectDir,
    timeout: 20000,
    shell: process.platform === 'win32' && !path.isAbsolute(py),
  })
  if (res.ok) return { items: [] }
  return { items: parsePyCompile(res.err), note: res.timedOut ? '检查超时' : '' }
}

/**
 * 对一个文件做诊断。永不抛异常。
 * @returns Promise<{ items: Array, backend: string, note?: string }>
 */
async function diagnose(projectDir, filePath) {
  const lang = langOf(filePath)
  if (!lang) return { items: [], backend: 'none' }

  // 优先 LSP：装了 language server 就精确又便宜，单文件粒度
  try {
    if (lsp.isAvailable(projectDir, lang)) {
      const key = path.resolve(filePath)
      const hit = fileCache.get(key)
      if (hit && Date.now() - hit.at < FILE_CACHE_TTL) return hit.result
      const raw = await lsp.getDiagnostics(projectDir, filePath)
      const result = {
        items: (raw || []).slice(0, MAX_ITEMS).map((d) => ({ ...d, file: filePath })),
        backend: 'LSP',
        note: '',
      }
      fileCache.set(key, { at: Date.now(), result })
      return result
    }
  } catch (e) {
    console.error('[diagnostics] LSP 失败，回落到工程自带检查器：', e?.message)
  }

  if (lang === 'python') {
    const key = path.resolve(filePath)
    const hit = fileCache.get(key)
    if (hit && Date.now() - hit.at < FILE_CACHE_TTL) return hit.result
    const r = await runPyCompile(projectDir, filePath)
    const result = { items: r.items.slice(0, MAX_ITEMS), backend: 'py_compile', note: r.note || '' }
    fileCache.set(key, { at: Date.now(), result })
    return result
  }

  // js/ts 且没有 language server：跑工程级 tsc，再挑出这个文件的
  const seq = editSeq
  const entry = await cachedProjectTsc(projectDir, seq)
  const abs = path.resolve(filePath)
  return {
    items: entry.items.filter((i) => path.resolve(i.file) === abs).slice(0, MAX_ITEMS),
    backend: entry.backend,
    note: entry.note || '',
  }
}

/** 整工程检查（get_diagnostics 工具在没指定文件时用） */
async function diagnoseProject(projectDir) {
  const seq = editSeq
  const entry = await cachedProjectTsc(projectDir, seq)
  return { items: entry.items, backend: entry.backend, note: entry.note || '' }
}

/** 文件刚被改过：让缓存失效，下次检查一定重跑 */
function invalidate() {
  editSeq++
}

/** 格式化成给模型看的一段话。没有问题是空字符串，不占上下文 */
function format(result, projectDir, filePath) {
  if (!result || result.items.length === 0) return ''
  const rel = path.relative(projectDir, filePath) || filePath
  const head = `\n\n[诊断] 改完之后 ${rel} 报出 ${result.items.length} 个问题（${result.backend}${result.note ? '，' + result.note : ''}）：`
  const body = result.items
    .map((d) => `  ${d.line}:${d.column} ${d.severity} ${d.source || ''} ${d.message}`.replace(/\s+/g, ' '))
    .join('\n')
  return `${head}\n${body}\n请根据这些诊断继续修复；如果不确定是否由本次改动引起，先读代码确认再动手。`
}

/** 整工程诊断的文本形式：每条都带文件路径 */
function formatProject(result, projectDir) {
  if (!result) return '诊断不可用'
  if (result.backend === 'none') return `当前工程没有可用的检查器：${result.note || ''}`
  if (result.items.length === 0) return `工程检查通过（${result.backend}${result.note ? '，' + result.note : ''}），没有报出问题。`
  const head = `工程检查（${result.backend}${result.note ? '，' + result.note : ''}）共 ${result.items.length} 个问题：`
  const body = result.items
    .map((d) => {
      const rel = path.relative(projectDir, d.file) || d.file
      return `  ${rel}:${d.line}:${d.column} ${d.severity} ${d.source || ''} ${d.message}`.replace(/\s+/g, ' ')
    })
    .join('\n')
  return `${head}\n${body}`
}

module.exports = { diagnose, diagnoseProject, format, formatProject, describe, invalidate, langOf }
