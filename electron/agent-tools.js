/**
 * Agent 工具实现。
 * 全部是无状态函数，签名统一为 (ctx, args)，ctx 至少提供：
 *   projectDir —— 相对路径的解析基准
 *   sendDiff   —— 把文件改动推给界面（可选）
 * 这样 agent.js 只需要保留主循环和提示词，不再被工具细节撑大。
 */

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { applyEdits, unifiedDiff } = require('./edit-engine')
const { decodeEntities, stripTags, htmlToText, httpGet } = require('./web-fetch')
const { checkRead, checkWrite, checkCommand, isSecretPath, explain } = require('./guard')
const checkpoint = require('./checkpoint')
const diagnostics = require('./diagnostics')
const formatter = require('./formatter')
const planStore = require('./plan-store')

/** 读取/比对文件的大小上限，超过就不去读，避免把巨型文件或二进制读进来 */
const MAX_EDIT_SIZE = 5 * 1024 * 1024

/** 把相对路径解析到项目目录下；已经是绝对路径的原样使用 */
function resolve(ctx, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(ctx.projectDir, filePath)
}

/**
 * 准入检查 + 可选的用户确认。
 * 返回 null 表示放行；返回字符串表示拒绝理由（直接作为工具结果回给模型）。
 *
 * ctx.confirmRisk 由 agent.js 提供：开关关闭时返回 null（硬拒绝），
 * 开关打开时弹一张确认卡，用户点「确认执行」才放行。
 */
async function gate(ctx, blocked, payload) {
  if (!blocked) return null
  let verdict = null
  try {
    verdict = await ctx.confirmRisk?.(blocked, payload)
  } catch {
    verdict = null // 确认过程出错就按最保守处理：不放行
  }
  if (verdict === 'allow') return null
  return explain(blocked, verdict === 'deny')
}

/** 改完之后把诊断（类型/语法错误）一起回给模型，让它自己接着修 */
async function withDiagnostics(ctx, fullPath, baseText) {
  if (!ctx.diagnostics) return baseText
  try {
    const text = await ctx.diagnostics(fullPath)
    return text ? `${baseText}${text}` : baseText
  } catch {
    return baseText
  }
}

function searchFiles(ctx, { pattern, directory = '', file_pattern = '' }) {
  const searchDir = path.join(ctx.projectDir, directory)
  if (!fs.existsSync(searchDir)) return `目录不存在: ${directory}`

  const results = []
  const regex = new RegExp(pattern, 'gi')
  const extFilter = file_pattern ? file_pattern.replace(/\*/g, '').split(',').map(s => s.trim()) : null

  const walk = (dir, depth = 0) => {
    if (depth > 4 || results.length > 30) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
      // 凭据文件不进检索结果：命中的那一行会连同密钥一起回给模型，且逐个弹确认太吵
      if (isSecretPath(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else {
        if (extFilter) {
          const ext = path.extname(entry.name).replace('.', '')
          if (!extFilter.includes(ext)) continue
        }
        try {
          const content = fs.readFileSync(full, 'utf-8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push(`${path.relative(ctx.projectDir, full)}:${i + 1}: ${lines[i].trim().slice(0, 120)}`)
              if (results.length >= 30) return
            }
            regex.lastIndex = 0
          }
        } catch { /* skip binary */ }
      }
    }
  }

  walk(searchDir)
  return results.length > 0 ? results.join('\n') : '未找到匹配结果'
}

async function readFileContent(ctx, { file_path, start_line, end_line }) {
  const full = resolve(ctx, file_path)
  // 护栏：凭据文件读进来就会随请求发给模型服务商，先问过用户
  const denied = await gate(ctx, checkRead(full), { action: 'read', target: full })
  if (denied) return denied
  if (!fs.existsSync(full)) return `文件不存在: ${file_path}`
  let content = fs.readFileSync(full, 'utf-8')
  const lines = content.split('\n')
  if (start_line || end_line) {
    const start = (start_line || 1) - 1
    const end = end_line || lines.length
    content = lines.slice(start, end).map((l, i) => `${start + i + 1}  ${l}`).join('\n')
  } else if (lines.length > 200) {
    content = lines.slice(0, 200).map((l, i) => `${i + 1}  ${l}`).join('\n') + `\n... (${lines.length} lines total)`
  } else {
    content = lines.map((l, i) => `${i + 1}  ${l}`).join('\n')
  }
  return content
}

async function writeFileContent(ctx, { file_path, content }) {
  const full = resolve(ctx, file_path)
  // 护栏：受保护目录 / 工作目录之外默认不写；开了「危险操作确认」时由用户拍板
  const denied = await gate(ctx, checkWrite(ctx.projectDir, full), { action: 'write', target: full })
  if (denied) return denied
  const existed = fs.existsSync(full)

  // 覆盖已有文件时先把原文读出来，才能算出「这次改了什么」给界面展示
  let original = null
  if (existed) {
    try {
      if (fs.statSync(full).size <= MAX_EDIT_SIZE) original = fs.readFileSync(full, 'utf-8')
    } catch { /* 读不到就只报告写入结果，不硬凑 diff */ }
  }

  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
  diagnostics.invalidate()

  const rel = path.relative(ctx.projectDir, full) || file_path
  if (!existed) {
    const lineCount = String(content).split('\n').length
    ctx.sendDiff?.({ filePath: rel, patch: '', added: lineCount, removed: 0, created: true })
    return withDiagnostics(ctx, full, `已创建文件: ${rel}（${lineCount} 行）`)
  }
  if (original === null) {
    return withDiagnostics(ctx, full, `文件已覆盖写入: ${rel}`)
  }

  const { patch, added, removed } = unifiedDiff(original, content, rel)
  ctx.sendDiff?.({ filePath: rel, patch, added, removed, created: false })
  return withDiagnostics(ctx, full, `文件已覆盖写入: ${rel}，+${added} -${removed}\n\n${patch}`)
}

async function editFileContent(ctx, { file_path, edits, old_content, new_content }) {
  const full = resolve(ctx, file_path)
  const denied = await gate(ctx, checkWrite(ctx.projectDir, full), { action: 'edit', target: full })
  if (denied) return denied
  if (!fs.existsSync(full)) return `文件不存在: ${file_path}`

  const stat = fs.statSync(full)
  if (stat.size > MAX_EDIT_SIZE) {
    return `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），不适合做搜索替换。`
  }

  const original = fs.readFileSync(full, 'utf-8')
  // 兼容只给单处 old_content / new_content 的老写法
  const list = Array.isArray(edits) && edits.length > 0
    ? edits
    : (typeof old_content === 'string' ? [{ old_content, new_content }] : [])

  const result = applyEdits(original, list)
  // 匹配不到、多处匹配、范围重叠都在这里被挡住，文件保持原样 —— 这正是「改得准」的关键
  if (!result.ok) return `修改未生效，文件未改动：\n${result.error}`

  fs.writeFileSync(full, result.content, 'utf-8')
  diagnostics.invalidate()

  const rel = path.relative(ctx.projectDir, full) || file_path
  const { patch, added, removed } = unifiedDiff(original, result.content, rel)
  ctx.sendDiff?.({ filePath: rel, patch, added, removed, created: false })

  const fuzzyNote = result.fuzzyCount > 0
    ? `（其中 ${result.fuzzyCount} 处忽略了行尾空白后匹配上）`
    : ''
  return withDiagnostics(ctx, full, `已修改 ${rel}：${result.applied} 处，+${added} -${removed}${fuzzyNote}\n\n${patch}`)
}

// 必须异步执行：execSync 会阻塞 Electron 主进程，而渲染进程的窗口消息、
// 终端数据转发、IPC 都靠主进程的事件循环。一旦同步等命令跑完，整个界面
// （包括终端里的那个程序）都会跟着卡住，命令越久卡得越明显。
async function executeCommand(ctx, { command }) {
  const MAX_OUTPUT = 3000
  const TIMEOUT_MS = 30000
  // 护栏：不可逆的破坏性命令默认拦掉；开了「危险操作确认」时问过用户才执行
  const denied = await gate(ctx, checkCommand(command), { action: 'command', command })
  if (denied) return denied
  const isWin = process.platform === 'win32'
  const shell = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
  const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command]

  return new Promise((resolve) => {
    const child = spawn(shell, shellArgs, { cwd: ctx.projectDir, windowsHide: true })
    let out = ''
    let err = ''
    let overflowed = false
    let timedOut = false
    let settled = false

    const killTree = () => {
      if (isWin) {
        // Windows 上 child.kill() 只结束 cmd.exe 本身，命令派生的子进程会变成孤儿继续跑
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true })
      } else {
        child.kill('SIGKILL')
      }
    }

    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      killTree()
    }, TIMEOUT_MS)

    const collect = (chunk, isErr) => {
      const text = chunk.toString('utf-8')
      if (isErr) {
        if (err.length < MAX_OUTPUT) err += text.slice(0, MAX_OUTPUT - err.length)
        else overflowed = true
      } else if (out.length < MAX_OUTPUT) {
        out += text.slice(0, MAX_OUTPUT - out.length)
      } else {
        overflowed = true
      }
    }

    child.stdout?.on('data', (c) => collect(c, false))
    child.stderr?.on('data', (c) => collect(c, true))

    const finish = (text) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const notes = []
      if (timedOut) notes.push(`超过 ${TIMEOUT_MS / 1000}s 已终止`)
      if (overflowed) notes.push('输出过长已截断')
      resolve(notes.length > 0 ? `${text}\n…（${notes.join('；')}）` : text)
    }

    child.on('error', (e) => finish(`命令启动失败: ${e.message}`))
    child.on('close', (code) => {
      const body = [out, err].filter(Boolean).join('\n').trim()
      if (code === 0) return finish(body || '(无输出)')
      finish(`退出码: ${code}\n${(err.trim() || body).slice(0, 1000) || '(无输出)'}`)
    })
  })
}

function listDirectory(ctx, { directory = '' }) {
  const dir = path.join(ctx.projectDir, directory)
  if (!fs.existsSync(dir)) return `目录不存在: ${directory}`
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
    .map((e) => e.isDirectory() ? `${e.name}/` : e.name)
  return entries.join('\n') || '(空目录)'
}

// ==================== 联网工具 ====================
async function webSearch(_ctx, { query, count }) {
  const n = Math.min(Math.max(Number(count) || 5, 1), 10)
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&setlang=zh-CN`
  let html
  try {
    html = await httpGet(url)
  } catch (e) {
    return `联网搜索失败: ${e.message}`
  }

  const results = []
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    if (results.length >= n) break
    const link = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/)
    if (!link) continue
    const title = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    results.push(
      `${results.length + 1}. ${stripTags(title?.[1] || '') || '(无标题)'}\n   ${decodeEntities(link[1])}\n   ${stripTags(snippet?.[1] || '')}`,
    )
  }
  if (results.length === 0) return `未搜索到「${query}」的结果`
  return `联网搜索「${query}」结果：\n${results.join('\n')}\n\n需要正文时用 web_fetch 打开具体链接。`
}

async function webFetch(_ctx, { url, max_chars }) {
  const limit = Math.min(Math.max(Number(max_chars) || 4000, 500), 20000)
  let html
  try {
    html = await httpGet(url)
  } catch (e) {
    return `抓取失败: ${e.message}`
  }
  const text = htmlToText(html)
  if (!text) return '(页面无正文内容)'
  return text.length > limit ? `${text.slice(0, limit)}\n...（已截断，原文共 ${text.length} 字）` : text
}

// ==================== 检查点（改动回退） ====================
function listCheckpoints(ctx) {
  const items = checkpoint.list(ctx.projectDir)
  if (items.length === 0) return '当前工作目录还没有打过检查点（每轮任务开始时会自动打一个）'
  return items
    .map((c) => `${c.sha}  ${new Date(c.at).toLocaleString('zh-CN')}`)
    .join('\n')
}

function restoreCheckpoint(ctx, { sha } = {}) {
  const res = checkpoint.restore(ctx.projectDir, sha)
  if (!res.ok) return `回退失败：${res.error}`
  return `已把工作目录还原到检查点 ${res.sha}（之后新建的文件仍在，需要的话把路径告诉我一并删掉）。`
}

// ==================== 诊断 ====================
/** 显式要一次检查：强制重跑，不吃缓存 */
async function getDiagnosticsTool(ctx, { file_path } = {}) {
  diagnostics.invalidate()
  if (file_path) {
    const full = resolve(ctx, file_path)
    if (!fs.existsSync(full)) return `文件不存在: ${file_path}`
    const result = await diagnostics.diagnose(ctx.projectDir, full)
    const text = diagnostics.format(result, ctx.projectDir, full)
    const rel = path.relative(ctx.projectDir, full) || file_path
    if (!text) return `${rel} 没有报出问题（检查器：${result.backend}${result.note ? '，' + result.note : ''}）。`
    return `${rel} 的诊断：\n${text.trim()}`
  }
  const result = await diagnostics.diagnoseProject(ctx.projectDir)
  return diagnostics.formatProject(result, ctx.projectDir)
}

// ==================== 格式化 ====================
/** 用工程自己装的格式化器就地整理一个文件（pi-lens 的格式化那一半能力） */
async function formatFileTool(ctx, { file_path } = {}) {
  const full = resolve(ctx, file_path)
  if (!fs.existsSync(full)) return `文件不存在: ${file_path}`
  // 格式化也是写文件，走同一套护栏（凭据文件、.git / node_modules 之类照样要挡）
  const denied = await gate(ctx, checkWrite(ctx.projectDir, full), { action: 'edit', target: full })
  if (denied) return denied

  const original = fs.readFileSync(full, 'utf-8')
  const res = await formatter.formatFile(ctx.projectDir, full)
  const rel = path.relative(ctx.projectDir, full) || file_path
  if (!res.ok) return `${rel} 格式化失败：${res.reason}`
  if (!res.changed) return `${rel} 已用 ${res.tool} 检查过，没有需要调整的排版。`

  const after = fs.readFileSync(full, 'utf-8')
  diagnostics.invalidate()
  const { patch, added, removed } = unifiedDiff(original, after, rel)
  ctx.sendDiff?.({ filePath: rel, patch, added, removed, created: false })
  return withDiagnostics(ctx, full, `${rel} 已用 ${res.tool} 格式化：+${added} -${removed}\n\n${patch}`)
}

// ==================== 实施计划 ====================
/** 写计划到磁盘：这份计划不参与上下文压缩，之后每轮都会重新出现在提示词里 */
function writePlanTool(ctx, { plan } = {}) {
  const text = planStore.writePlan(ctx.projectDir, plan)
  if (!text) return '计划已清空。'
  return `计划已保存（${text.length} 字）。这份计划不会被上下文压缩丢掉，之后每一轮都会重新注入给你。`
}

function readPlanTool(ctx) {
  const text = planStore.readPlan(ctx.projectDir)
  return text || '当前没有保存任何计划。先用 write_plan 写一份。'
}

// ==================== 长期记忆 ====================
/** 记一条跨会话的项目记忆：写进 .yucode/memory.md，之后每轮都会重新注入提示词 */
function rememberTool(ctx, { text } = {}) {
  const body = String(text || '').trim()
  if (!body) return '没有可记的内容（text 为空）。'
  const all = planStore.appendMemory(ctx.projectDir, body)
  const count = all.split('\n').filter((l) => l.trim().startsWith('- ')).length
  return `已记入项目长期记忆（.yucode/memory.md，共 ${count} 条）。以后每次对话都会带上它。`
}

// ==================== 项目全局规则 ====================
/** 整份写入项目规则：这份规则每一步执行前都会重新注入提示词，跨会话有效 */
function writeRulesTool(ctx, { rules } = {}) {
  const text = planStore.writeRules(ctx.projectDir, rules)
  if (!text) return '项目规则已清空。'
  return `项目规则已保存（${text.length} 字，.yucode/rules.md）。它会在每一步执行前重新注入给你，跨会话一直有效。`
}

/** 工具名 → 实现。agent.js 的 executeTool 直接按名字取，不再写 switch */
const TOOL_IMPL = {
  search_files: searchFiles,
  read_file: readFileContent,
  write_file: writeFileContent,
  edit_file: editFileContent,
  execute_command: executeCommand,
  list_directory: listDirectory,
  web_search: webSearch,
  web_fetch: webFetch,
  list_checkpoints: listCheckpoints,
  restore_checkpoint: restoreCheckpoint,
  get_diagnostics: getDiagnosticsTool,
  format_file: formatFileTool,
  write_rules: writeRulesTool,
  write_plan: writePlanTool,
  read_plan: readPlanTool,
  remember: rememberTool,
}

module.exports = { TOOL_IMPL }
