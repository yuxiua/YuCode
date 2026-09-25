/**
 * pi 的工具名与消息结构 → 界面认识的东西。
 *
 * pi 有自己的工具命名和 content 块约定，界面有自己的工具状态与内容块格式，
 * 两边的差异集中在这里翻译，PiAgent 只管流程。
 */

const fs = require('fs')

/** 会落盘改文件的内置工具。执行前后各读一次文件，就能把 diff 算给界面 */
const FILE_TOOLS = new Set(['edit', 'write', 'multiedit', 'apply_patch'])

function firstString(...values) {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim()
  return ''
}

/** pi 的工具名 → 界面认识的工具状态。名字对不上的按「调用工具」显示原名 */
const TOOL_STATUS = {
  read: (a) => ({ state: 'reading', detail: `读取: ${firstString(a.path, a.file_path, a.file)}` }),
  write: (a) => ({ state: 'editing', detail: `写入: ${firstString(a.path, a.file_path, a.file)}` }),
  edit: (a) => ({ state: 'editing', detail: `编辑: ${firstString(a.path, a.file_path, a.file)}` }),
  multiedit: (a) => ({ state: 'editing', detail: `多处编辑: ${firstString(a.path, a.file_path, a.file)}` }),
  apply_patch: () => ({ state: 'editing', detail: '应用补丁' }),
  bash: (a) => ({ state: 'executing', detail: `执行: ${firstString(a.command).slice(0, 50)}` }),
  powershell: (a) => ({ state: 'executing', detail: `执行: ${firstString(a.command).slice(0, 50)}` }),
  // 后台任务三件套（electron/pi-custom-extensions.js 装的那个扩展提供的工具）
  run_in_background: (a) => ({ state: 'executing', detail: `后台启动: ${firstString(a.command).slice(0, 50)}` }),
  bash_output: (a) => ({ state: 'executing', detail: `后台输出: ${firstString(a.job_id) || '全部任务'}` }),
  kill_shell: (a) => ({ state: 'executing', detail: `停止后台任务: ${firstString(a.job_id)}` }),
  // 项目全局规则（同一个安装器装的 yu-code-rules.ts 提供的工具）
  write_rules: () => ({ state: 'action', detail: '更新项目规则' }),
  grep: (a) => ({ state: 'searching', detail: `搜索: ${firstString(a.pattern, a.query, a.regex)}` }),
  find: (a) => ({ state: 'searching', detail: `查找: ${firstString(a.pattern, a.glob, a.path)}` }),
  glob: (a) => ({ state: 'searching', detail: `查找: ${firstString(a.pattern, a.glob)}` }),
  ls: (a) => ({ state: 'searching', detail: `列目录: ${firstString(a.path, a.dir)}` }),
  web_search: (a) => ({ state: 'web_searching', detail: `联网搜索: ${firstString(a.query)}` }),
  web_fetch: (a) => ({ state: 'web_fetching', detail: `抓取网页: ${firstString(a.url)}` }),
  task: (a) => ({ state: 'searching', detail: `派发子代理: ${firstString(a.description, a.prompt).slice(0, 60)}` }),
  ask_question: (a) => ({ state: 'asking', detail: firstString(a.question).slice(0, 80) }),
  todo_write: (a) => todoStatus(a),
  todo: (a) => todoStatus(a),
  todowrite: (a) => todoStatus(a),
}

/** 清单类工具：扩展（如 rpiv-todo）也叫 todo，统一说成「更新任务清单」 */
function todoStatus(a) {
  const count = Array.isArray(a?.todos) ? a.todos.length : 0
  return { state: 'action', detail: count ? `更新任务清单（${count} 项）` : '更新任务清单' }
}

/**
 * 只按工具名判断状态。模型刚开始写工具参数（toolcall_start）时还看不到 args，
 * 但这时候已经知道它要写文件了 —— 界面据此提前亮出「正在编辑」，
 * 否则整个编辑过程都会停在「正在调用模型…」。
 */
function stateOfTool(toolName) {
  const mapper = TOOL_STATUS[toolName]
  return mapper ? mapper({}).state : ''
}

/** assistant 消息的 content 是块数组，正文和工具调用都在里面 */
function blocksOf(message) {
  return Array.isArray(message?.content) ? message.content : []
}

function textOf(message) {
  return blocksOf(message).filter((b) => b?.type === 'text').map((b) => b.text || '').join('').trim()
}

function hasToolCall(message) {
  return blocksOf(message).some((b) => b?.type === 'toolCall')
}

/** 读文件内容；不存在（说明是新建文件）和读失败都返回 null */
function readTextFile(file) {
  try { return fs.readFileSync(file, 'utf-8') } catch { return null }
}

/** 工具结果（含流式 partialResult）里的文本：pi 统一用 content 块数组装 */
function resultText(result) {
  if (typeof result === 'string') return result.trim()
  const blocks = Array.isArray(result?.content) ? result.content : []
  return blocks
    .filter((b) => b?.type === 'text' && b.text)
    .map((b) => String(b.text))
    .join('\n')
    .trim()
}

module.exports = {
  FILE_TOOLS, firstString, TOOL_STATUS, stateOfTool, blocksOf, textOf, hasToolCall, readTextFile, resultText,
}
