/**
 * 内置扩展的首次同步。
 *
 * 8 个内置扩展随安装包分发 —— 安装包里放的是 vendor/pi-extensions.zip
 * （1.7 万个小文件逐个安装要花好几分钟，压成一个文件装机就快得多），
 * 第一次启动时解压到临时目录，再从这里同步。
 * 开发态没有 zip，直接用手边的 vendor/pi-extensions 目录。
 *
 * 而 pi 引擎认三个地方：~/.pi/agent/npm/node_modules 里的包、settings.json 的 packages
 * 数组，以及 ~/.pi/agent/npm/package.json 的 dependencies。这里就是把这段差距补上 ——
 * 把缺的包复制过去，把 packages 收敛成正好这 8 个，并让 npm 清单也记上这些包。
 * 整个过程不需要联网，也不需要用户执行任何 pi 命令。
 *
 * 只在本应用带了「不同的扩展集合」时做一次（指纹落在 ~/.pi/agent/.yucode-bundled.json），
 * 之后没变化就整段跳过，不在每次启动时白搬一遍。
 *
 * 新版本应用覆盖安装后（扩展版本变了 → 指纹变了）：
 *   - 这 8 个自带扩展按安装包里的版本覆盖，否则更新完扩展还停在旧版；
 *   - 依赖只补缺，不覆盖用户自己升级过的；
 *   - 用户后来通过界面装的扩展保留在清单里，不会被收敛掉；
 *   - npm 清单里这 8 个的版本跟着安装包走，否则 pi 下次装扩展时会把它们当多余项清掉。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const { DEFAULT_CATALOG } = require('./extensions-catalog')

const PI_AGENT_DIR = path.join(os.homedir(), '.pi', 'agent')
const TARGET_DIR = path.join(PI_AGENT_DIR, 'npm', 'node_modules')
const SETTINGS_PATH = path.join(PI_AGENT_DIR, 'settings.json')
// pi 的 npm 工程清单：`npm install` 会照着它收敛整棵 node_modules，没留名的包会被删掉
const NPM_PACKAGE_PATH = path.join(PI_AGENT_DIR, 'npm', 'package.json')
const STAMP_PATH = path.join(PI_AGENT_DIR, '.yucode-bundled.json')
// 解压出来的扩展放这儿，按指纹分子目录，升级后新版能对上自己的那一份
const EXTRACT_ROOT = path.join(os.tmpdir(), 'yucode-pi-extensions')

/** vendor 可能来自安装包（resources）也可能是仓库里的开发态 */
function candidateRoots() {
  const roots = []
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'vendor'))
  roots.push(path.join(__dirname, '..', 'vendor'))
  return roots
}

/** 优先用 Windows 自带的 bsdtar（比 Expand-Archive 快很多），失败再退回 PowerShell */
function extractZip(zipPath, destDir) {
  const tar = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true })
  if (tar.status === 0) return true
  const script =
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' ` +
    `-DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, stdio: 'ignore' })
  return ps.status === 0
}

/** 返回可用的扩展目录（内含 node_modules），拿不到就返回空串 */
function resolveSourceDir() {
  for (const root of candidateRoots()) {
    const dir = path.join(root, 'pi-extensions')
    if (fs.existsSync(path.join(dir, 'node_modules'))) return dir
  }

  const fp = fingerprint()
  const dest = path.join(EXTRACT_ROOT, fp)
  if (fs.existsSync(path.join(dest, 'node_modules'))) return dest

  for (const root of candidateRoots()) {
    const zip = path.join(root, 'pi-extensions.zip')
    if (!fs.existsSync(zip)) continue
    const started = Date.now()
    try {
      // 上一个版本解压出来的那份已经没用了，顺手清掉，别把临时目录越堆越大
      for (const entry of listDirSafe(EXTRACT_ROOT)) {
        if (entry.isDirectory() && entry.name !== fp) {
          try { fs.rmSync(path.join(EXTRACT_ROOT, entry.name), { recursive: true, force: true }) } catch { /* 正被占用就算了 */ }
        }
      }
      fs.rmSync(dest, { recursive: true, force: true })
      fs.mkdirSync(dest, { recursive: true })
      if (!extractZip(zip, dest)) throw new Error('tar / Expand-Archive 都失败')
      if (!fs.existsSync(path.join(dest, 'node_modules'))) throw new Error('解压结果里没有 node_modules')
      console.log(`[bundled-ext] 解压内置扩展：${Date.now() - started}ms → ${dest}`)
      return dest
    } catch (e) {
      console.error('[bundled-ext] 解压内置扩展失败:', e.message)
      return ''
    }
  }
  return ''
}

function readStamp() {
  try { return JSON.parse(fs.readFileSync(STAMP_PATH, 'utf-8')) } catch { return null }
}

// 同步逻辑本身改了也要让老机器重跑一次：
// 1 → 只搬 node_modules 并收敛 packages；2 → 再补上 npm 清单的 dependencies
const SYNC_VERSION = 2

/** 这批扩展的指纹：来源 + 版本，或同步逻辑本身变了，就要重新同步一次 */
function fingerprint() {
  const spec = DEFAULT_CATALOG.map((it) => `${it.source}@${it.version}`).join('|')
  return crypto.createHash('sha1').update(`${SYNC_VERSION}|${spec}`).digest('hex').slice(0, 12)
}

function listDirSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}

/** 这 8 个扩展的包名（含 scope），它们是应用的一部分，跟着安装包版本走 */
function bundledNames() {
  return new Set(DEFAULT_CATALOG.map((it) => it.source.replace(/^npm:/, '')))
}

/**
 * 把 vendor 树搬进 pi 的包目录。
 * @param prefix    递归到 @scope 时累积的目录名，用来还原出完整包名
 * @param overwrite 自带扩展的包名集合：命中就覆盖（版本升级靠这个生效），
 *                  没命中且目标已存在就跳过，避免把用户自己升级过的依赖顶回去
 */
function copyTree(srcDir, destDir, prefix, overwrite) {
  let copied = 0
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of listDirSafe(srcDir)) {
    // .bin / .package-lock.json 这类 npm 元数据不用搬
    if (entry.name.startsWith('.')) continue
    const from = path.join(srcDir, entry.name)
    const to = path.join(destDir, entry.name)
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      copied += copyTree(from, to, entry.name, overwrite)
      continue
    }
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    const force = overwrite.has(name)
    if (!force && fs.existsSync(to)) continue
    try {
      // 覆盖前先清掉旧的，免得上个版本删掉的文件留在原地
      if (force && fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true })
      fs.cpSync(from, to, { recursive: true, force: true })
      copied += 1
    } catch (e) {
      console.error(`[bundled-ext] 复制 ${name} 失败:`, e.message)
    }
  }
  return copied
}

/**
 * 把 pi 的包清单收敛成「这 8 个 + 用户自己后来装的」（其余设置项原样保留）。
 * @param previousBundled 上一次同步时写进去的清单；没有记录（首次）时不做保留，
 *                        因为那时的清单多半是历史残留，按当前定义收敛即可
 */
function convergePackages(previousBundled) {
  let settings = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed
  } catch { /* 文件不存在/损坏 → 从零写 */ }

  const wanted = DEFAULT_CATALOG.map((it) => it.source)
  const current = Array.isArray(settings.packages) ? settings.packages.map(String) : []
  const extras = Array.isArray(previousBundled)
    ? current.filter((p) => !previousBundled.includes(p))
    : []
  const next = [...wanted, ...extras.filter((p) => !wanted.includes(p))]
  if (current.join('|') === next.join('|')) return false

  settings.packages = next
  try {
    fs.mkdirSync(PI_AGENT_DIR, { recursive: true })
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8')
  } catch (e) {
    console.error('[bundled-ext] 写入 settings.json 失败:', e.message)
    return false
  }
  return true
}

/**
 * 让 pi 的 npm 清单也记上这 8 个包。
 *
 * pi 装新扩展时执行的是 `npm install <spec> --prefix ~/.pi/agent/npm`，npm 会照着
 * package.json 的 dependencies 收敛整棵 node_modules —— 只躺在 node_modules 里、
 * 没在 dependencies 留名的包会被当成多余项，连子依赖一起删掉（曾经把随包带的
 * pi-web-access 连同 204 个包一起清了）。所以随包复制过来的包必须在这里留名。
 *
 * 版本跟着安装包走：copyTree 已经把文件覆盖成安装包里的版本，清单要跟它一致，
 * 否则下次 `npm install` 会因为对不上而把扩展换回去。用户自己装的包原样保留。
 * @param packageJsonPath 仅供测试注入，默认就是 pi 那份清单
 */
function convergeNpmDependencies(packageJsonPath = NPM_PACKAGE_PATH) {
  let pkg = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) pkg = parsed
  } catch { /* 文件不存在/损坏 → 从零写 */ }

  const current = pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies)
    ? pkg.dependencies : {}
  const merged = { ...current }
  for (const it of DEFAULT_CATALOG) {
    merged[it.source.replace(/^npm:/, '')] = `^${it.version}`
  }
  // 排一次序，写出来的清单稳定，重复跑也不会因为顺序不同而误判成「变了」
  const next = {}
  for (const name of Object.keys(merged).sort()) next[name] = merged[name]
  if (JSON.stringify(next) === JSON.stringify(current)) return false

  pkg.name = pkg.name || 'pi-extensions'
  pkg.private = true
  pkg.dependencies = next
  try {
    fs.mkdirSync(path.dirname(packageJsonPath), { recursive: true })
    fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2), 'utf-8')
  } catch (e) {
    console.error('[bundled-ext] 写入 npm 清单失败:', e.message)
    return false
  }
  return true
}

/**
 * 启动时调用一次。返回 { synced, copied, converged, declared, reason }，只用于日志。
 * 任何一步失败都不抛：扩展缺失只会让某些能力不可用，不该挡住应用启动。
 */
function ensure() {
  const stamp = readStamp()
  const fp = fingerprint()
  if (stamp && stamp.fingerprint === fp) return { synced: false, reason: 'up-to-date' }

  const src = resolveSourceDir()
  if (!src) {
    console.warn('[bundled-ext] 安装包里既没有 vendor/pi-extensions 目录也没有 pi-extensions.zip，跳过同步')
    return { synced: false, reason: 'no-vendor' }
  }

  const started = Date.now()
  try {
    const copied = copyTree(path.join(src, 'node_modules'), TARGET_DIR, '', bundledNames())
    const converged = convergePackages(stamp?.bundled)
    const declared = convergeNpmDependencies()
    fs.writeFileSync(STAMP_PATH, JSON.stringify({
      fingerprint: fp,
      bundled: DEFAULT_CATALOG.map((it) => it.source),
      at: Date.now(),
    }, null, 2), 'utf-8')
    console.log(`[bundled-ext] 同步完成：补入 ${copied} 个包，包清单${converged ? '已收敛' : '无需改动'}，npm 清单${declared ? '已登记' : '无需改动'}，耗时 ${Date.now() - started}ms`)
    return { synced: true, copied, converged, declared }
  } catch (e) {
    console.error('[bundled-ext] 同步失败:', e.message)
    return { synced: false, reason: e.message }
  }
}

module.exports = { ensure, convergeNpmDependencies, PI_AGENT_DIR }
