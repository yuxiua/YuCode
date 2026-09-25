/**
 * 内置安全护栏。
 *
 * 对应 Pi 生态里的 protected-paths 与 permission-gate 两个 TypeScript 扩展——
 * 它们是「放手让 Agent 干活」的前提，但 Pi 扩展在本应用的自研 Agent 里跑不起来，
 * 所以这里原生实现，默认生效，不需要装任何扩展。
 *
 * 设计原则：宁可少拦，也不要天天误伤正常开发。只挡两类东西：
 *   1. 写入受保护目录（.git / node_modules）或写出工作目录之外
 *   2. 真正不可逆的破坏性命令（磁盘级删除、强推、reset --hard 等）
 * 其余一律放行——用户要的是类似 Trae 的完全访问，不是事事审批。
 *
 * 拦截结果统一返回结构化对象 { kind, title, detail }，这样上层有两种处理方式：
 *   危险确认开（默认）→ 先弹卡问用户，用户点了「确认执行」就照做；
 *   危险确认关 → 直接拒执行，不打断用户。
 */

const path = require('path')

/** 任意层级出现这些目录名即拒绝写入。它们由工具链自动维护，手改只会坏事 */
const PROTECTED_DIRS = new Set(['.git', 'node_modules', '.pi'])

/** target 是否位于 root 之内（含 root 自身） */
function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  if (rel === '') return true
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

// ==================== 敏感文件 ====================
// 凭据一旦被读进上下文，就会随每一次请求发到模型服务商那里，事后无法收回；
// 被写坏（覆盖成示例值、清空）同样不可逆。所以读写敏感文件都要先过用户。

/** 示例/模板/文档类文件即使名字像凭据也是给人看的，直接放行 */
const SECRET_ALLOW_RE = /\.(example|sample|template|dist|md|mdx)$/i

const SECRET_PATH_RES = [
  /(^|[\\/])\.env(\.[\w.-]+)?$/i, // .env / .env.local / .env.production
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i, // SSH 私钥
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i, // AWS 凭据与配置
  /(^|[\\/])\.npmrc$/i, // npm token
  /(^|[\\/])\.pypirc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])credentials(\.json)?$/i,
  /(^|[\\/])service[-_]?account.*\.json$/i, // GCP 服务账号
  /(^|[\\/])secrets?\.(json|ya?ml|toml|ini|txt)$/i,
  /\.(pem|p12|pfx|keystore|jks|asc|ppk)$/i,
]

/** 这个路径是不是「装着凭据的东西」 */
function isSecretPath(target) {
  const p = String(target || '').trim().replace(/^["']|["']$/g, '')
  if (!p) return false
  if (SECRET_ALLOW_RE.test(p)) return false
  return SECRET_PATH_RES.some((re) => re.test(p))
}

/** 读文件前的准入检查（凭据类文件默认要用户点头才读） */
function checkRead(fullPath) {
  if (!isSecretPath(fullPath)) return null
  return {
    kind: 'secret',
    title: '读取可能包含凭据的文件',
    detail: `${fullPath} 看起来存着密钥 / token。读出来的内容会作为上下文发给模型服务商，之后无法撤回。若只是想知道有哪些字段，改读同名的 .env.example 或配置模板。`,
  }
}

/**
 * 写入 / 改动前的准入检查。
 * @returns 放行返回 null，否则返回 { kind, title, detail }
 */
function checkWrite(projectDir, fullPath) {
  if (!projectDir) return null

  if (isSecretPath(fullPath)) {
    return {
      kind: 'secret',
      title: '写入可能包含凭据的文件',
      detail: `${fullPath} 看起来存着密钥 / token。覆盖或清空它可能让本机已有的配置直接失效，且无法恢复。`,
    }
  }

  if (!isInside(projectDir, fullPath)) {
    return {
      kind: 'outside',
      title: '写入工作目录之外的位置',
      detail: `目标 ${fullPath} 不在工作目录内（${projectDir}）。所有改动都必须落在工作目录里。`,
    }
  }

  const hit = path
    .resolve(fullPath)
    .split(/[\\/]/)
    .find((seg) => PROTECTED_DIRS.has(seg.toLowerCase()))
  if (hit) {
    return {
      kind: 'protected',
      title: `写入受保护目录「${hit}」`,
      detail: `${fullPath} 位于「${hit}」下。该目录由工具链自动维护，手改容易损坏仓库或依赖。`,
    }
  }
  return null
}

// 只收录真正不可逆、且正常开发中几乎不该由 Agent 主动执行的命令
const DANGEROUS_COMMANDS = [
  { re: /\brm\s+(-[a-z]+\s+)*-[a-z]*[rf][a-z]*\b/i, why: '递归强制删除' },
  { re: /\b(del|erase)\s+\/[a-z]*[sq]/i, why: '递归强制删除' },
  { re: /\b(rmdir|rd)\s+\/[sq]/i, why: '递归删除目录' },
  { re: /\bformat\s+[a-z]:/i, why: '格式化磁盘分区' },
  { re: /\bmkfs(\.\w+)?\b/i, why: '创建文件系统' },
  { re: /\bdiskpart\b/i, why: '操作磁盘分区表' },
  { re: /\bdd\s+[^\n]*of=\/dev\//i, why: '直接写块设备' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: '关机 / 重启本机' },
  { re: /\bgit\s+push\b[^\n]*(\s--force(-with-lease)?\b|\s-f\b)/i, why: '强推远端分支' },
  { re: /\bgit\s+reset\s+--hard\b/i, why: '丢弃工作区未提交的改动' },
  { re: /\bgit\s+clean\b[^\n]*-[a-z]*f/i, why: '删除未跟踪文件' },
  { re: /\b(npm|yarn|pnpm)\s+publish\b/i, why: '发布包到公共仓库' },
  { re: /\breg\s+delete\b|\bregedit\b/i, why: '修改 Windows 注册表' },
  { re: /\b(sc|net)\s+delete\s+(service|user)\b/i, why: '删除系统服务 / 用户' },
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, why: 'fork bomb' },
]

/**
 * 命令准入检查。
 * @returns 放行返回 null，否则返回 { kind, title, detail }
 */
function checkCommand(command) {
  const cmd = String(command || '')
  if (!cmd.trim()) return null
  for (const { re, why } of DANGEROUS_COMMANDS) {
    if (re.test(cmd)) {
      return {
        kind: 'dangerous',
        title: `可能不可逆：${why}`,
        detail: `这条命令属于「${why}」，一旦执行可能无法恢复。`,
      }
    }
  }
  // 命令里直接点到凭据文件（cat .env、type id_rsa、curl -d @secrets.json）也拦：
  // 这类内容一旦进了终端输出，就会原样进上下文。带反斜杠转义点的 token（正则里的 \.env）不算。
  for (const token of cmd.split(/\s+/)) {
    if (/\\\./.test(token)) continue
    if (isSecretPath(token)) {
      return {
        kind: 'secret',
        title: '命令会碰可能包含凭据的文件',
        detail: `命令里出现了 ${token}，它看起来存着密钥 / token。输出会被原样记进上下文并随请求发出去。若只想确认字段，改看同名的 .env.example。`,
      }
    }
  }
  return null
}

/**
 * 只读命令判定：计划模式（只读规划）下用来放行「看一眼」的命令。
 *
 * 为什么需要它：计划模式如果一刀切禁掉 execute_command，连 `git status`、`cat` 都执行不了，
 * Agent 就没法调研，只能凭想象写计划——那计划必然是空的。
 *
 * 判法保守：按 shell 分隔符拆成若干段，每一段的首个词都必须在白名单里；
 * 出现重定向、命令替换、管道到未知程序，一律视为非只读。
 */
const READ_ONLY_EXECUTABLES = new Set([
  // 列目录 / 看文件 / 文本检索
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'more', 'less', 'wc', 'find', 'grep', 'rg', 'ag',
  'file', 'tree', 'stat', 'du', 'df', 'pwd', 'echo', 'sort', 'uniq', 'cut', 'tr', 'fold',
  'basename', 'dirname', 'realpath', 'readlink', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum',
  // 环境信息
  'whoami', 'hostname', 'date', 'uname', 'which', 'where', 'env', 'printenv', 'ver',
])

/** 只读的 git 子命令（后面还会单独排掉会写仓库的参数，例如 branch -d） */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'ls-files', 'ls-tree', 'rev-parse', 'describe',
  'blame', 'shortlog', 'cat-file', 'grep', 'reflog', 'config', 'remote', 'tag', 'stash',
  'whatchanged', 'worktree', 'name-rev', 'merge-base', 'symbolic-ref',
])

/** 会写仓库 / 改工作区的 git 参数，出现即不算只读 */
const GIT_WRITING_FLAGS = /(^|\s)(-d|-D|-m|-M|--delete|--move|--force|-f|--hard|--set-upstream|-u|--edit|-e|--amend|--no-edit)(\s|$)/

/** 两段式只读命令：「包管理器 子命令」 */
const READ_ONLY_PAIRS = [
  /^(npm|pnpm|yarn)\s+(ls|list|view|info|why|outdated|audit|config\s+get)\b/i,
  /^(pip|pip3)\s+(list|show|freeze)\b/i,
  /^(tsc|npx\s+tsc)\s+[^\n]*--no-?emit/i,
  /^(python|python3|node|npm|pnpm|yarn|git|tsc|java|go|rustc|cargo)\s+(--version|-v|-V)\s*$/i,
]

/** 会被当成「写」解析的重定向（> / >>），以及命令替换 */
const WRITES_OR_EVAL = /(^|[^0-9<])>>?(?!&)/

/** 按 shell 分隔符拆段：只读命令可以用 && / ; 串起来，但每一段都得只读 */
function splitSegments(command) {
  return String(command || '')
    .split(/&&|\|\||[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 单段是否只读 */
function isReadOnlySegment(segment) {
  const seg = segment.trim()
  if (!seg) return true
  // 重定向写文件、命令替换能执行任意代码 —— 直接不算只读
  if (WRITES_OR_EVAL.test(seg.replace(/^[a-zA-Z]:\\/, ''))) return false
  if (seg.includes('`') || seg.includes('$(')) return false
  // 管道交给每一段各自判定
  if (seg.includes('|')) return seg.split('|').every((p) => isReadOnlySegment(p))

  if (READ_ONLY_PAIRS.some((re) => re.test(seg))) return true

  const words = seg.split(/\s+/)
  const head = words[0].replace(/^["']|["']$/g, '').toLowerCase()
  const rest = words.slice(1).join(' ')

  if (head === 'git') {
    const sub = words[1] || ''
    if (!GIT_READ_ONLY_SUBCOMMANDS.has(sub)) return false
    if (GIT_WRITING_FLAGS.test(rest)) return false
    return true
  }

  // PowerShell 的 cmdlet 常见写法
  const psMatch = /^(get-childitem|get-content|select-string|test-path|get-item|measure-object|get-location)$/.exec(head)
  if (psMatch) return true

  return READ_ONLY_EXECUTABLES.has(head)
}

/**
 * 整条命令是否只读（计划模式下允许执行）。
 * 空命令按只读处理（execute_command 自己会报「未提供命令」）。
 */
function isReadOnlyCommand(command) {
  const segments = splitSegments(command)
  if (segments.length === 0) return true
  return segments.every(isReadOnlySegment)
}

/**
 * 把拦截结果转成给模型看的说明。
 * @param blocked checkWrite / checkCommand 的返回值
 * @param byUser true 表示用户看过之后选择不执行
 */
function explain(blocked, byUser) {
  if (!blocked) return ''
  if (byUser) {
    return `已取消：${blocked.title}。用户已经看过这条操作并选择不执行，不要重试，也不要换个写法再试一次。\n${blocked.detail}`
  }
  return `已拦截：${blocked.title}。Agent 不自行执行这类操作，请向用户说明原因并请他自己动手。\n${blocked.detail}`
}

/** 供设置页展示：内置护栏到底管了哪些事 */
function describe() {
  return [
    `禁止写入受保护目录：${[...PROTECTED_DIRS].join('、')}`,
    '禁止写入工作目录之外的位置',
    `拦截 ${DANGEROUS_COMMANDS.length} 类破坏性命令（递归删除、格式化磁盘、强推、reset --hard 等）`,
    '读写凭据文件（.env / 私钥 / .npmrc / *.pem 等）默认要用户确认，避免密钥进上下文或失效',
    '计划模式下只放行只读命令（git status/diff/log、cat、grep、ls 等），改文件的命令一律拦下',
  ]
}

module.exports = { PROTECTED_DIRS, isInside, isSecretPath, checkRead, checkWrite, checkCommand, isReadOnlyCommand, explain, describe }
