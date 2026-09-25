// `npm run dev` 启动前的清理。
//
// 关掉窗口时，Windows 上 concurrently 的 SIGTERM 不一定能带走子进程，上一次
// 的 vite 会继续占着 5173；而 vite.config 里为了固定 origin 开了 strictPort，
// 于是下一次启动直接失败（Port 5173 is already in use）。
//
// 这里在启动前把「本项目 node_modules 下的残留 node/electron/esbuild 进程」清掉，
// 同时删掉 .dev-port（vite 会重新写）。
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

try {
  fs.rmSync(path.join(root, '.dev-port'), { force: true })
} catch {
  /* ignore */
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], ...opts })
}

/** 用 stdin 传 PowerShell 脚本，省去在命令行里层层转义引号和竖线 */
function runPowerShell(script) {
  return execSync('powershell -NoProfile -Command -', {
    encoding: 'utf-8',
    windowsHide: true,
    // stdin 必须是 pipe，否则 input 会被丢弃
    stdio: ['pipe', 'pipe', 'ignore'],
    input: script,
    timeout: 20000,
  })
}

// 只清理本项目的残留进程：命令行里必须同时出现项目根目录和 \node_modules。
// 这样既不会误杀别的项目，也不会杀掉 powershell/cmd（否则会把发起启动的终端一起关掉）。
function leftoverPids() {
  // 必须是单行：`powershell -Command -` 从 stdin 逐行读取，跨行管道符容易解析失败
  const ps =
    `$root = '${root.replace(/'/g, "''")}'; ` +
    'Get-CimInstance Win32_Process | ' +
    "Where-Object { $_.CommandLine -like ('*' + $root + '\\node_modules*') -and $_.Name -match '^(node|electron|esbuild)\\.exe$' } | " +
    'ForEach-Object { $_.ProcessId }'
  try {
    const out = runPowerShell(ps)
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map(Number)
      .filter((pid) => pid !== process.pid)
  } catch (e) {
    // 查不到就跳过，交给 vite 自己报端口占用
    console.warn(`[dev] 清理残留进程时出错（可忽略）：${e.message}`)
    return []
  }
}

if (process.platform === 'win32') {
  const pids = leftoverPids()
  if (pids.length > 0) {
    for (const pid of pids) {
      try {
        run(`taskkill /F /T /PID ${pid}`)
      } catch {
        /* 可能已经退出 */
      }
    }
    console.log(`[dev] 已清理上一次残留的进程：${pids.join(', ')}`)
  }
}
