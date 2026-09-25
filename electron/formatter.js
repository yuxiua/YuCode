/**
 * 格式化（Formatter）—— 补齐 pi-lens 里「格式化」那一半能力（诊断那半在 diagnostics.js）。
 *
 * 原则：只用工程自己装好的格式化器，绝不自带、绝不猜风格。
 *   js / ts / 样式 / 文档 → 工程 node_modules 里的 prettier（且工程确实在用它）
 *   python                → venv 或 PATH 里的 ruff（优先，快）或 black
 * 工程没配就如实说「没有可用的格式化器」，让用户自己决定装不装 ——
 * 硬塞一个默认风格去重排用户的文件，比不格式化更糟。
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TIMEOUT = 30000
const MAX_OUT = 100000

/** prettier 认得的文件类型（粗筛，具体能不能格由 prettier 自己决定） */
const PRETTIER_EXT = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.json', '.json5', '.css', '.scss', '.less', '.html', '.vue',
  '.md', '.mdx', '.yaml', '.yml',
])
const PY_EXT = new Set(['.py'])

function exists(p) {
  try { return fs.existsSync(p) } catch { return false }
}

/** 跑一个子进程并收集输出。命令不存在时标记 missing（用于回落到下一个候选）。永不 reject */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}) },
        windowsHide: true,
      })
    } catch (e) {
      return resolve({ ok: false, missing: true, out: '', err: e.message })
    }
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 已经退出 */ }
      resolve({ ok: false, out, err: `超时（${TIMEOUT / 1000}s）` })
    }, TIMEOUT)

    child.stdout?.on('data', (c) => { if (out.length < MAX_OUT) out += c.toString('utf-8') })
    child.stderr?.on('data', (c) => { if (err.length < MAX_OUT) err += c.toString('utf-8') })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, missing: e.code === 'ENOENT', out, err: e.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, out, err: err || (code ? `退出码 ${code}` : '') })
    })
  })
}

// ---------------------------------------------------------------- 工具探测

/** 工程内的 prettier：v3 是 bin/prettier.cjs，v2 是 bin-prettier.js */
function findPrettier(projectDir) {
  for (const rel of ['node_modules/prettier/bin/prettier.cjs', 'node_modules/prettier/bin-prettier.js']) {
    const p = path.join(projectDir, rel)
    if (exists(p)) return p
  }
  return null
}

/**
 * prettier 被装进来（哪怕是别的包的依赖）但工程自己没配风格时，它会按默认风格重排整个文件，
 * 对用户来说就是一堆莫名其妙的改动。所以要有配置文件、package.json 里有 prettier 字段、
 * 或它本来就在依赖里，才算「这个工程在用 prettier」。
 */
function prettierInUse(projectDir) {
  const names = [
    '.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.js',
    '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.toml',
    'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
  ]
  if (names.some((n) => exists(path.join(projectDir, n)))) return true
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'))
    return Boolean(pkg.prettier) || Boolean(pkg.devDependencies?.prettier) || Boolean(pkg.dependencies?.prettier)
  } catch {
    return false
  }
}

/** js/ts 侧候选：只有工程内的 prettier，不依赖 PATH 里的全局安装 */
function jsCandidates(projectDir) {
  const bin = findPrettier(projectDir)
  if (!bin || !prettierInUse(projectDir)) return []
  // Electron 的可执行文件加这个环境变量就当纯 Node 用，打包后也能跑（不依赖系统 node）
  return [{ tool: 'prettier', cmd: process.execPath, args: [bin, '--write'], env: { ELECTRON_RUN_AS_NODE: '1' } }]
}

/** python 侧候选：venv 里的 ruff / black 优先，其次 PATH 里的 */
function pythonCandidates(projectDir) {
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin'
  const exeOf = (n) => (process.platform === 'win32' ? `${n}.exe` : n)
  const list = []
  for (const tool of ['ruff', 'black']) {
    const args = tool === 'ruff' ? ['format'] : []
    for (const venv of ['.venv', 'venv']) {
      list.push({ tool, cmd: path.join(projectDir, venv, binDir, exeOf(tool)), args })
    }
    list.push({ tool, cmd: exeOf(tool), args })
  }
  return list
}

/** 这个文件该用哪些候选（按优先级）；返回空数组表示类型不认识或工程没配格式化器 */
function candidatesFor(projectDir, filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  if (PY_EXT.has(ext)) return pythonCandidates(projectDir)
  if (PRETTIER_EXT.has(ext)) return jsCandidates(projectDir)
  return []
}

/** 当前工程能用哪些格式化器（设置页 / 内置能力清单展示用） */
function describe(projectDir) {
  const out = {}
  try {
    out.javascript = jsCandidates(projectDir).length > 0
      ? { available: true, tool: 'prettier' }
      : { available: false, reason: '工程里没有 node_modules/prettier，或工程自己没配 prettier' }
    // 只看「文件确实存在」的候选：PATH 里的要跑起来才知道，探测阶段不执行任何东西
    const py = pythonCandidates(projectDir).find((c) => c.cmd.includes(path.sep) && exists(c.cmd))
    out.python = py ? { available: true, tool: py.tool } : { available: false, reason: 'venv 与 PATH 里都没有 ruff / black' }
  } catch (e) {
    console.error('[formatter] describe 失败：', e?.message)
  }
  return out
}

// ---------------------------------------------------------------- 执行

/**
 * 就地格式化一个文件。永不抛异常。
 * @returns Promise<{ ok: boolean, tool: string, changed?: boolean, reason?: string }>
 */
async function formatFile(projectDir, filePath) {
  const list = candidatesFor(projectDir, filePath)
  if (list.length === 0) {
    return {
      ok: false,
      tool: '',
      reason: '这个文件类型没有可用的格式化器（js/ts 需要在工程里装并配置 prettier；python 需要 ruff 或 black）',
    }
  }

  let before = ''
  try {
    before = fs.readFileSync(filePath, 'utf-8')
  } catch (e) {
    return { ok: false, tool: '', reason: `读不到文件：${e.message}` }
  }

  let last = ''
  for (const c of list) {
    const res = await run(c.cmd, [...c.args, filePath], { cwd: projectDir, env: c.env })
    if (res.missing) {
      last = `${c.tool} 没找到`
      continue
    }
    if (!res.ok) {
      return { ok: false, tool: c.tool, reason: (res.err || res.out || '格式化失败').trim().slice(0, 600) }
    }
    let after = before
    try { after = fs.readFileSync(filePath, 'utf-8') } catch { /* 读不回来就按未改动处理 */ }
    return { ok: true, tool: c.tool, changed: after !== before }
  }
  return { ok: false, tool: '', reason: last || '没有找到可用的格式化器' }
}

module.exports = { formatFile, describe, candidatesFor }
