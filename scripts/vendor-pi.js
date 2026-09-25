/**
 * 构建前把 Pi 运行时「原样 vendor」到本地，供安装包一起分发。
 *
 * 四件事，前两件是下载 + 落盘，不碰 Pi 的任何源码（见 .trae/rules.md）：
 *   1. vendor/node → 官方 Node 发行版解压（Pi 要求 Node >= 22，用户机器上不一定有）
 *   2. vendor/pi   → npm 装出 @earendil-works/pi-coding-agent 及其依赖
 *   3. vendor/pi   → 删掉依赖里的 dist-types 类型声明目录（运行时不加载，但路径最深）
 *   4. vendor/pi-extensions → 本应用自带的 8 个扩展（pi 引擎启动时加载它们）
 *      并压成 vendor/pi-extensions.zip 进安装包（1.7 万个小文件装起来太慢，运行时解压）
 *
 * 幂等：版本对得上就直接跳过，重复构建不会重复下载。
 * 强制重来：删掉对应目录，或设 PI_FORCE_VENDOR=1。
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const os = require('os')
const { spawnSync } = require('child_process')

const PI_PKG = '@earendil-works/pi-coding-agent'
// 版本写死，避免"今天构建出来和昨天不是同一个 Pi"。升级时改这里。
const PI_VERSION = '0.87.1'
const NODE_VERSION = '24.21.0'

const ROOT = path.resolve(__dirname, '..')
const VENDOR_DIR = path.join(ROOT, 'vendor')
const PI_DIR = path.join(VENDOR_DIR, 'pi')
const NODE_DIR = path.join(VENDOR_DIR, 'node')
const EXT_DIR = path.join(VENDOR_DIR, 'pi-extensions')
const EXT_STAMP = path.join(EXT_DIR, '.yucode-stamp.json')
// 打进安装包的是这个压缩包，不是 EXT_DIR 本身（见 ensureExtensionsArchive）
const EXT_ZIP = path.join(VENDOR_DIR, 'pi-extensions.zip')

// 内置扩展。改这里就要同步改 electron/extensions-catalog.js（版本与描述在那边）。
// 末尾的 pi-tui 是扩展的 peer 依赖：平时由 pi install 放进包目录，随包分发时得自己带上。
const EXT_PACKAGES = [
  'pi-subagents@0.71.0',
  'pi-hermes-memory@0.9.9',
  'pi-lens@4.2.1',
  'pi-simplify@0.2.3',
  'cc-safety-net@2.4.6',
  'rpiv-todo@1.1.0',
  '@narumitw/pi-plan-mode@0.58.3',
  'pi-web-access@0.31.0',
  '@earendil-works/pi-tui@0.87.1',
]

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const FORCE = process.env.PI_FORCE_VENDOR === '1'

const pkgJsonPath = path.join(PI_DIR, 'node_modules', ...PI_PKG.split('/'), 'package.json')
const piCliPath = path.join(PI_DIR, 'node_modules', ...PI_PKG.split('/'), 'dist', 'bundle', 'cli.js')
const nodeExePath = path.join(NODE_DIR, process.platform === 'win32' ? 'node.exe' : 'bin/node')

function log(msg) {
  console.log(`[vendor] ${msg}`)
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return null }
}

/** 优先用 Windows 自带的 bsdtar 解压（比 Expand-Archive 快很多），失败再退回 PowerShell */
function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const tar = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true })
  if (tar.status === 0) return
  log('tar 解压失败，改用 PowerShell Expand-Archive')
  const script =
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' ` +
    `-DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, stdio: 'inherit' })
  if (ps.status !== 0) throw new Error('解压 Node 压缩包失败')
}

/** 下载并跟随重定向（nodejs.org 会跳 CDN），带简单的进度输出 */
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向次数过多'))
    const req = https.get(url, (res) => {
      const { statusCode, headers } = res
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume()
        return resolve(download(new URL(headers.location, url).toString(), dest, redirects + 1))
      }
      if (statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${statusCode}: ${url}`))
      }

      const total = Number(headers['content-length'] || 0)
      let received = 0
      let lastLogged = 0

      const file = fs.createWriteStream(dest)
      res.on('data', (chunk) => {
        received += chunk.length
        // 每 5MB 报一次，避免刷屏
        if (received - lastLogged > 5 * 1024 * 1024) {
          lastLogged = received
          const pct = total ? ` (${Math.round((received / total) * 100)}%)` : ''
          log(`  已下载 ${(received / 1024 / 1024).toFixed(1)}MB${pct}`)
        }
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('下载超时')))
  })
}

async function ensureNode() {
  if (!FORCE && fs.existsSync(nodeExePath)) {
    const v = spawnSync(nodeExePath, ['-v'], { encoding: 'utf-8', windowsHide: true })
    if (v.status === 0) {
      log(`Node 已就绪：${String(v.stdout).trim()} → ${path.relative(ROOT, NODE_DIR)}`)
      return
    }
  }

  const zipName = `node-v${NODE_VERSION}-win-x64.zip`
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${zipName}`
  const tmpZip = path.join(os.tmpdir(), `yucode-${zipName}`)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yucode-node-'))

  try {
    log(`下载便携 Node v${NODE_VERSION}（约 30MB）…`)
    await download(url, tmpZip)
    log('解压中…')
    fs.rmSync(NODE_DIR, { recursive: true, force: true })
    extractZip(tmpZip, tmpDir)

    // 压缩包里是 node-vXX-win-x64/ 这一层，摊平到 vendor/node 才好调用
    const inner = path.join(tmpDir, `node-v${NODE_VERSION}-win-x64`)
    if (!fs.existsSync(path.join(inner, 'node.exe'))) {
      throw new Error(`压缩包结构不符合预期，找不到 ${inner}\\node.exe`)
    }
    fs.mkdirSync(NODE_DIR, { recursive: true })
    for (const entry of fs.readdirSync(inner)) {
      fs.cpSync(path.join(inner, entry), path.join(NODE_DIR, entry), { recursive: true, force: true })
    }

    const v = spawnSync(nodeExePath, ['-v'], { encoding: 'utf-8', windowsHide: true })
    if (v.status !== 0) throw new Error('解压后的 node.exe 无法执行')
    log(`Node 已就绪：${String(v.stdout).trim()} → ${path.relative(ROOT, NODE_DIR)}`)
  } finally {
    fs.rmSync(tmpZip, { force: true })
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

function ensurePi() {
  const installed = readJson(pkgJsonPath)?.version
  if (!FORCE && installed === PI_VERSION && fs.existsSync(piCliPath)) {
    log(`Pi 已就绪：${PI_PKG}@${installed} → ${path.relative(ROOT, PI_DIR)}`)
    return
  }

  log(`安装 ${PI_PKG}@${PI_VERSION}（含依赖，约 100MB）…`)
  fs.rmSync(PI_DIR, { recursive: true, force: true })
  fs.mkdirSync(PI_DIR, { recursive: true })

  const res = spawnSync(
    NPM,
    ['install', '--prefix', PI_DIR, '--no-save', '--no-package-lock', '--no-audit', '--no-fund',
      '--loglevel=error', `${PI_PKG}@${PI_VERSION}`],
    { stdio: 'inherit', windowsHide: true, cwd: ROOT },
  )
  if (res.status !== 0) throw new Error(`npm 安装 ${PI_PKG} 失败（退出码 ${res.status}）`)

  const version = readJson(pkgJsonPath)?.version
  if (!version) throw new Error('安装完成但找不到 package.json，vendor 结果不可信')
  if (!fs.existsSync(piCliPath)) throw new Error(`找不到 Pi 的入口 ${path.relative(ROOT, piCliPath)}`)
  log(`Pi 已就绪：${PI_PKG}@${version} → ${path.relative(ROOT, PI_DIR)}`)
}

/**
 * 删掉依赖里的 TypeScript 类型声明目录（dist-types）。
 *
 * 这些 .d.ts 运行时不加载：包的 main / module / exports 一律指向 dist-cjs、dist-es，
 * types 字段才用 dist-types。但它们恰好是整棵树里路径最深的文件——@smithy / @aws-sdk
 * 的 dist-types/ts3.4/submodules/... 一层套一层，最长的那个相对路径 180 字符，
 * 装到安装目录后越过 Windows 的 MAX_PATH，解压时会被静默丢掉（全新安装也一样）。
 * 裁掉后最深路径降到 169 字符，给不同的安装目录留出余量。
 */
function prunePiTypes() {
  const found = []
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name === 'dist-types') {
        found.push(full)
        continue
      }
      scan(full)
    }
  }
  scan(path.join(PI_DIR, 'node_modules'))

  if (found.length === 0) {
    log('类型声明目录已清理过，跳过')
    return
  }
  for (const dir of found) fs.rmSync(dir, { recursive: true, force: true })
  log(`已清理 ${found.length} 个 dist-types 类型声明目录（运行时不加载）`)
}

/**
 * 装内置扩展。必须用 vendor 出来的 Node 跑 npm：better-sqlite3 这类原生模块
 * 会按运行 npm 的那个 Node 的 ABI 取预编译包，用系统 Node 装出来的在应用里加载不了。
 */
function runNpmInstall(prefix, packages) {
  const npmCli = path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const args = ['install', '--prefix', prefix, '--no-save', '--no-package-lock', '--no-audit',
    '--no-fund', '--loglevel=error', '--legacy-peer-deps', ...packages]
  if (fs.existsSync(npmCli)) {
    return spawnSync(nodeExePath, [npmCli, ...args], { stdio: 'inherit', windowsHide: true, cwd: ROOT })
  }
  log('警告：vendor/node 里没有 npm，退回系统 npm（原生模块可能与应用不兼容）')
  return spawnSync(NPM, args, { stdio: 'inherit', windowsHide: true, cwd: ROOT })
}

function ensureExtensions() {
  const stamp = readJson(EXT_STAMP)
  const ready = !FORCE
    && stamp
    && Array.isArray(stamp.packages)
    && stamp.packages.join('|') === EXT_PACKAGES.join('|')
    && EXT_PACKAGES.every((spec) => {
      const name = spec.replace(/@[^@/]+$/, '')
      return fs.existsSync(path.join(EXT_DIR, 'node_modules', ...name.split('/'), 'package.json'))
    })
  if (ready) {
    log(`内置扩展已就绪：${EXT_PACKAGES.length} 个 → ${path.relative(ROOT, EXT_DIR)}`)
    return false
  }

  log(`安装 ${EXT_PACKAGES.length} 个内置扩展…`)
  fs.rmSync(EXT_DIR, { recursive: true, force: true })
  fs.mkdirSync(EXT_DIR, { recursive: true })

  const res = runNpmInstall(EXT_DIR, EXT_PACKAGES)
  if (res.status !== 0) throw new Error(`npm 安装内置扩展失败（退出码 ${res.status}）`)

  fs.writeFileSync(EXT_STAMP, JSON.stringify({ packages: EXT_PACKAGES }, null, 2), 'utf-8')
  log(`内置扩展已就绪：${EXT_PACKAGES.length} 个 → ${path.relative(ROOT, EXT_DIR)}`)
  return true
}

/**
 * 把扩展目录压成一个 zip 再进安装包。
 *
 * 这 1.7 万个小文件铺在安装包里，装机时逐个解压要花掉好几分钟；
 * 压成一个文件后装机只需落一个文件，第一次启动时再解压到临时目录用
 * （见 electron/pi-bundled-extensions.js）。所以压缩包里必须是 node_modules 这一层，
 * 运行时直接按 node_modules/... 展开就是 pi 要的目录结构。
 *
 * @param rebuild 扩展刚被重装过时必须重新打包，否则哈希对不上的旧包会被装进去
 */
function ensureExtensionsArchive(rebuild) {
  if (!fs.existsSync(path.join(EXT_DIR, 'node_modules'))) {
    log(`跳过扩展压缩包：${path.relative(ROOT, EXT_DIR)} 不存在`)
    return
  }
  if (!rebuild && fs.existsSync(EXT_ZIP)) {
    log(`扩展压缩包已就绪：${path.relative(ROOT, EXT_ZIP)}`)
    return
  }

  log('打包内置扩展（安装包里只带这一个文件）…')
  fs.rmSync(EXT_ZIP, { force: true })
  const res = spawnSync('tar', ['-a', '-cf', EXT_ZIP, '-C', EXT_DIR, 'node_modules'], { windowsHide: true })
  if (res.status !== 0 || !fs.existsSync(EXT_ZIP)) {
    throw new Error('打包内置扩展失败：需要 tar（Windows 10 1803+ 自带，其他平台也有）')
  }
  log(`扩展压缩包已就绪：${(fs.statSync(EXT_ZIP).size / 1024 / 1024).toFixed(1)}MB → ${path.relative(ROOT, EXT_ZIP)}`)
}

/** 用 vendor 出来的 Node 跑一遍 Pi，确认这套组合在本机真的能起得来 */
function smokeTest() {
  if (!fs.existsSync(nodeExePath) || !fs.existsSync(piCliPath)) {
    log('跳过自检：vendor 产物不完整')
    return
  }
  const res = spawnSync(nodeExePath, [piCliPath, '--version'], {
    encoding: 'utf-8', windowsHide: true, timeout: 60000,
  })
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n')[0]
  if (res.status === 0) log(`自检通过：pi --version → ${out}`)
  else log(`自检未通过（不影响打包，运行时再排查）：退出码 ${res.status} ${out}`)
}

async function main() {
  try {
    await ensureNode()
    ensurePi()
    prunePiTypes()
    // 扩展刚被重装过时必须重新打包，所以把「是否重装」的结果传下去
    ensureExtensionsArchive(ensureExtensions())
    smokeTest()
    log('完成。打包时会随 extraResources 一起进入安装包。')
  } catch (e) {
    console.error(`[vendor] 失败：${e.message}`)
    process.exit(1)
  }
}

main()
