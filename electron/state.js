// 工作区状态的文件存储（userData/yu-code-state.json）
//
// 为什么不用 localStorage：localStorage 按 origin 隔离，
// dev 模式换端口（5173→5174）、dev 与打包版（file://）之间数据都不互通，
// 而且有 5~10MB 上限，对话一长就可能写不进去。
// 存到 userData 下的文件则与启动方式无关，也没有容量限制。
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

let statePath = ''
let cache = null
let writeTimer = null

function init() {
  statePath = path.join(app.getPath('userData'), 'yu-code-state.json')
}

function load() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
    cache = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // 首次运行文件不存在，或文件损坏——都从空状态开始
    cache = {}
  }
  return cache
}

/** 整个状态快照。preload 用同步 IPC 读取，保证渲染进程建 store 时就能拿到 */
function getAll() {
  return load()
}

/** 合并写入。渲染进程调用频繁（每次编辑都存），所以做防抖 + 原子写 */
function set(patch) {
  if (!patch || typeof patch !== 'object') return
  const cur = load()
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete cur[key]
    else cur[key] = value
  }
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(flush, 300)
}

/** 先写临时文件再 rename，避免写到一半崩溃把状态文件写坏 */
function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  if (!statePath || !cache) return
  try {
    const tmp = `${statePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf-8')
    fs.renameSync(tmp, statePath)
  } catch (e) {
    console.error('[state] 保存失败:', e.message)
  }
}

module.exports = { init, getAll, set, flush }
