/**
 * 项目级符号扫描：给定一个名字，在工程里找出它的定义位置。
 *
 * 这是 ctrl+左键跳转的「慢路径」——当前文件里找不到时才走这里。
 * 不做真正的语义分析，纯正则 + 行扫描，因此结果是「最可能的定义」而非编译器级答案；
 * 但零依赖、对任意语言都能给出可用的落点。
 * 匹配规则与 src/utils/symbols.ts 保持一致，改规则时请一起改。
 */

const path = require('path')
const fs = require('fs')

/** 只扫这些扩展名的文件，避免把图片、二进制、压缩包读进来 */
const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'pyi', 'rs', 'go', 'java', 'kt', 'kts', 'scala', 'swift', 'dart', 'cs',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'm', 'mm', 'php', 'rb', 'pl', 'lua', 'r',
  'sql', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'vb', 'vbs',
])

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '__pycache__',
  '.venv', 'venv', '.next', '.nuxt', '.cache', 'coverage', '.idea', '.vscode',
  'vendor', '.gradle', 'bin', 'obj',
])

const MAX_FILES = 3000
const MAX_FILE_SIZE = 512 * 1024
const MAX_DEPTH = 8
const TIME_BUDGET_MS = 4000

function buildPatterns(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?type\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?enum\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:async\\s+)?def\\s+${esc}\\b`),
    new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${esc}\\b`),
    new RegExp(`^\\s*type\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:pub\\s+)?(?:struct|enum|trait|union)\\s+${esc}\\b`),
    new RegExp(`^\\s*module\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:(?:public|private|protected|static)\\s+)*function\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:(?:public|private|protected|static|final|internal|open|override)\\s+)*[\\w<>\\[\\]?,\\.:\\s]*\\b${esc}\\s*[(<]`),
    new RegExp(`^\\s*(?:export\\s+)?\\$?${esc}\\s*[:=]`),
  ]
}

/** 结果缓存：同一目录同一个名字重复点不再重扫 */
const cache = new Map()
const CACHE_LIMIT = 200

function fileCandidate(name) {
  const ext = path.extname(name).replace('.', '').toLowerCase()
  if (ext) return CODE_EXTS.has(ext)
  // 无扩展名的常见脚本
  return name === 'Makefile' || name === 'CMakeLists.txt'
}

/**
 * @returns {{ file: string, line: number, column: number, patternIndex: number }[]}
 */
function findSymbol(projectDir, name, limit = 20) {
  if (!projectDir || !name) return []
  const key = `${projectDir}\u0000${name}`
  const cached = cache.get(key)
  if (cached) return cached

  const patterns = buildPatterns(name)
  const results = []
  const deadline = Date.now() + TIME_BUDGET_MS
  let scanned = 0

  // 广度优先：先看浅层目录，命中更可能是用户想要的定义
  const queue = [{ dir: projectDir, depth: 0 }]
  while (queue.length > 0 && results.length < limit) {
    const { dir, depth } = queue.shift()
    if (depth > MAX_DEPTH) continue

    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }

    for (const entry of entries) {
      if (Date.now() > deadline) break
      if (results.length >= limit) break

      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (scanned >= MAX_FILES) break
      if (!fileCandidate(entry.name)) continue

      let content
      try {
        const stat = fs.statSync(full)
        if (stat.size > MAX_FILE_SIZE) continue
        content = fs.readFileSync(full, 'utf-8')
      } catch { continue }
      scanned++

      const lines = content.split('\n')
      for (let p = 0; p < patterns.length; p++) {
        const re = patterns[p]
        let hit = null
        for (let i = 0; i < lines.length; i++) {
          const m = re.exec(lines[i])
          if (!m) continue
          const col = lines[i].indexOf(name, m.index)
          hit = { line: i + 1, column: col >= 0 ? col : m.index, patternIndex: p }
          break
        }
        if (hit) {
          results.push({ file: path.relative(projectDir, full), ...hit })
          break // 一个文件只报一处，避免同一个符号刷屏
        }
      }
    }
  }

  // 越靠前的规则越可信，同规则按路径排序，结果稳定可预期
  results.sort((a, b) => a.patternIndex - b.patternIndex || a.file.localeCompare(b.file))

  if (cache.size > CACHE_LIMIT) cache.clear()
  cache.set(key, results)
  return results
}

/** 目录切换 / 文件被改动后清缓存，避免跳转到已经不存在的位置 */
function clearSymbolCache() {
  cache.clear()
}

module.exports = { findSymbol, clearSymbolCache }
