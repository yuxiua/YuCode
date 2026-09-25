// 打包入口：`npm run build`
//
// 五步走：算版本号 → 备齐 pi 引擎与内置扩展 → 构建前端 → 出安装包 → 清理旧版本
// （最后一步只留最近 3 个版本的安装包，由 scripts/prune-versions.py 干）。
//
// 版本号默认 patch 自增，想手动选就往后面带参数（npm 需要在参数前加一个 --）：
//   npm run build              1.0.0 → 1.0.1
//   npm run build -- minor     1.0.0 → 1.1.0
//   npm run build -- major     1.0.0 → 2.0.0
//   npm run build -- 2.0.0     直接指定
//   npm run build -- none      不改版本号（本地反复验证同一个版本时用）
//
// 第二个参数可以指定输出目录，默认跟着 electron-builder.json 走（工作区外的
// ../yu_code-release）。输出目录千万别放回工作区里：Trae 这类 IDE 会一直开着
// win-unpacked\resources\app.asar 的句柄，electron-builder 删不掉它就报 EBUSY。
// 真要放回工作区时，绕开的写法：npm run build -- patch release2
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const bumpArg = process.argv[2] || 'patch'
const outDir = process.argv[3] || ''

function builderArgs() {
  const args = ['electron-builder']
  if (outDir) args.push(`--config.directories.output=${outDir}`)
  return args
}

/** 安装包最后落在哪，从配置里读，免得提示跟实际不一致 */
function outputDir() {
  if (outDir) return outDir
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron-builder.json'), 'utf-8'))
    return cfg.directories?.output || 'release'
  } catch {
    return 'release'
  }
}

/**
 * 上个版本留下的 app.asar 被别的进程占着时，electron-builder 会先跑两分钟再抛
 * EBUSY 失败。这里提前探一下，把失败变成一句能照做的提示。
 */
function blockedByOldAsar(dir) {
  const asar = path.resolve(ROOT, dir, 'win-unpacked', 'resources', 'app.asar')
  if (!fs.existsSync(asar)) return false
  const probe = `${asar}.lockcheck`
  try {
    fs.renameSync(asar, probe)
  } catch {
    return true
  }
  try {
    fs.renameSync(probe, asar)
  } catch {
    // 改回来失败也无所谓，下次打包会重新生成
  }
  return false
}

/** 清理旧安装包：只留最近 3 个版本。python 不在或脚本出错都只提醒，不中断打包 */
function pruneArtifacts(dir) {
  const script = path.join(__dirname, 'prune-versions.py')
  console.log('\n[build] python scripts/prune-versions.py')
  for (const py of ['python', 'py']) {
    const res = spawnSync(py, [script, '--dir', dir], { cwd: ROOT, stdio: 'inherit' })
    if (res.error && res.error.code === 'ENOENT') continue
    if (res.status !== 0) console.warn('[build] 旧版本清理没跑成，不影响本次打包结果')
    return
  }
  console.warn('[build] 没找到 python / py，跳过旧版本清理')
}

const dir = outputDir()
if (blockedByOldAsar(dir)) {
  console.error(
    `\n[build] ${dir}\\win-unpacked\\resources\\app.asar 正被别的程序占用，打包到这一步必然失败。\n` +
      '[build] 最常见的是 Trae CN / VS Code 这类打开着本项目的编辑器（它会一直读 app.asar）。\n' +
      '[build] 三个办法任选：\n' +
      '[build]   1. 把输出目录放到工作区外（现在的默认配置就是 ../yu_code-release，不受影响）\n' +
      '[build]   2. 换一个输出目录：npm run build -- ' + bumpArg + ' out1\n' +
      '[build]   3. 重启 IDE 或机器，占用会释放'
  )
  process.exit(1)
}

const steps = [
  ['node', [path.join(__dirname, 'bump-version.js'), bumpArg]],
  ['node', [path.join(__dirname, 'vendor-pi.js')]],
  ['npx', ['vite', 'build']],
  ['npx', builderArgs()],
]

for (const [cmd, args] of steps) {
  console.log(`\n[build] ${cmd} ${args.join(' ')}`)
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true })
  if (res.status !== 0) {
    console.error(`\n[build] 中断在「${cmd} ${args.join(' ')}」，退出码 ${res.status ?? 'unknown'}`)
    process.exit(res.status ?? 1)
  }
}

pruneArtifacts(dir)
console.log(`\n[build] 完成，安装包在 ${dir}/ 下`)

