/**
 * Pi 运行时：定位 + 驱动。
 *
 * Pi 对本项目是外部依赖：这里只做「找到它、跑它的子命令、读出结果」，
 * 不 import 它的内部模块，也不改它的源码。
 *
 * 查找顺序（第一优先的是随安装包分发的那份）：
 *   1. <resources>/vendor  —— 打包后由 extraResources 带进来的内置 Pi + 便携 Node
 *   2. <repo>/vendor       —— 开发态，scripts/vendor-pi.js 的产物
 *   3. ~/.pi/agent/pi_engine —— 用户自己装到数据目录里的运行时
 *   4. PATH 上的 pi        —— 用户自行全局安装（需要 Node >= 22）
 *
 * 扩展的安装/卸载/列举一律走这里（pi install / remove / list）：
 * Pi 扩展不是独立工具，而是插进 Pi 运行时 API 的模块，本应用的 Agent 引擎
 * 没有那套 host API，自己重新实现一份安装器只会和 pi 的约定越走越远。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync, execFile } = require('child_process')

const PI_PKG = '@earendil-works/pi-coding-agent'
const isWin = process.platform === 'win32'
// pi 认的「包清单」就是这个文件里的 packages 数组，pi list / install / remove 都读写它
const SETTINGS_PATH = path.join(os.homedir(), '.pi', 'agent', 'settings.json')
// pi 的模型/凭证都在这里；路径由 pi 写死，没有环境变量可改
const MODELS_PATH = path.join(os.homedir(), '.pi', 'agent', 'models.json')

function candidateRoots() {
  const roots = []
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'vendor'))
  roots.push(path.join(__dirname, '..', 'vendor'))
  roots.push(path.join(os.homedir(), '.pi', 'agent', 'pi_engine'))
  return roots
}

function runQuiet(cmd, args) {
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf-8', windowsHide: true, timeout: 15000 })
    return res.status === 0 ? String(res.stdout || '').trim() : ''
  } catch {
    return ''
  }
}

function readVersion(pkgJson) {
  try { return JSON.parse(fs.readFileSync(pkgJson, 'utf-8')).version || '' } catch { return '' }
}

/** vendor 布局：<root>/pi/node_modules/@earendil-works/pi-coding-agent + <root>/node/node.exe */
function fromVendor(root) {
  const pkgDir = path.join(root, 'pi', 'node_modules', ...PI_PKG.split('/'))
  const cliPath = path.join(pkgDir, 'dist', 'bundle', 'cli.js')
  if (!fs.existsSync(cliPath)) return null
  const bundledNode = path.join(root, 'node', isWin ? 'node.exe' : 'bin/node')
  return {
    source: 'bundled',
    cliPath,
    // 内置 Node 优先；没有就退回 PATH 上的 node（需要 >= 22 才跑得动 Pi）
    nodePath: fs.existsSync(bundledNode) ? bundledNode : 'node',
    version: readVersion(path.join(pkgDir, 'package.json')),
  }
}

function fromPath() {
  const which = runQuiet(isWin ? 'where' : 'which', ['pi']).split(/\r?\n/)[0].trim()
  if (!which) return null
  return { source: 'path', cliPath: which, nodePath: 'node', version: '' }
}

function getPiInfo() {
  for (const root of candidateRoots()) {
    const found = fromVendor(root)
    if (found) {
      return { available: true, ...found, nodeVersion: runQuiet(found.nodePath, ['-v']) }
    }
  }

  const onPath = fromPath()
  if (onPath) {
    return { available: true, ...onPath, nodeVersion: runQuiet('node', ['-v']) }
  }

  return {
    available: false,
    source: 'none',
    version: '',
    nodeVersion: '',
    cliPath: '',
    nodePath: '',
  }
}

// ==================== 驱动 pi CLI ====================

/** settings.json 是 pi 的开关：packages 数组就是它认的扩展清单 */
function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 跑一个 pi 子命令。参数以数组传入、不经过 shell，因此不存在命令注入。
 * 永不 reject：调用方统一看 ok / error，失败信息尽量带上 pi 自己的输出。
 */
function runPi(args, opts = {}) {
  const info = getPiInfo()
  if (!info.available) {
    return Promise.resolve({ ok: false, stdout: '', stderr: '', error: '没有找到 pi CLI' })
  }
  return new Promise((resolve) => {
    execFile(
      info.nodePath,
      [info.cliPath, ...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}) },
        windowsHide: true,
        timeout: opts.timeout || 300000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => resolve({
        ok: !err,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? err.message : '',
      })
    )
  })
}

/**
 * 解析 `pi list` 的分段文本。格式是两级缩进：
 *   User packages:
 *     npm:pi-simplify
 *       C:\Users\...\npm\node_modules\pi-simplify
 * 顶层行是分段名，2 空格行是 source，更深的是它的落盘路径。
 */
function parsePiList(text) {
  const out = []
  let section = ''
  let current = null
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    if (indent === 0) {
      section = line.replace(/:\s*$/, '')
      current = null
    } else if (indent <= 2) {
      current = { section, source: line, dir: '' }
      out.push(current)
    } else if (current && !current.dir) {
      current.dir = line
    }
  }
  return out
}

/** npm:foo → <pi agent>/npm/node_modules/foo；解析不出来就返回空串等 pi list 补 */
function npmDirOf(source) {
  if (!source.startsWith('npm:')) return ''
  const spec = source.slice(4).trim()
  if (!/^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?(@[a-z0-9._-]+)?$/i.test(spec)) return ''
  // 去掉 @version 后缀，@scope/name 这种开头的 @ 要保留
  const name = spec.includes('@', 1) ? spec.slice(0, spec.lastIndexOf('@')) : spec
  return path.join(path.dirname(SETTINGS_PATH), 'npm', 'node_modules', ...name.split('/'))
}

/** pi CLI 当前认的扩展包：以 settings.json 为准，路径优先用 `pi list` 给出的 */
async function listPiPackages() {
  const res = await runPi(['list'], { env: { PI_OFFLINE: '1' } })
  const parsed = parsePiList(res.stdout)
  const bySource = new Map(parsed.map((p) => [p.source, p]))

  const settings = readSettings()
  const declared = Array.isArray(settings.packages) ? settings.packages.map(String) : []
  const sources = [...new Set([...declared, ...parsed.map((p) => p.source)])]

  return {
    ok: res.ok || sources.length > 0,
    error: res.ok ? '' : res.error,
    raw: (res.stdout || '').trim(),
    packages: sources.map((source) => {
      const hit = bySource.get(source)
      return {
        source,
        // 展示名去掉来源前缀，@scope/name 保持原样
        name: source.replace(/^npm:/, '').replace(/^git:/, ''),
        dir: (hit && hit.dir) || npmDirOf(source),
      }
    }),
  }
}

module.exports = {
  getPiInfo,
  readSettings,
  runPi,
  listPiPackages,
  parsePiList,
  SETTINGS_PATH,
  MODELS_PATH,
}
