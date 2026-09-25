/**
 * 内置改动检查点：自建文件快照，**不依赖 git**。对应 Pi 生态的 git-checkpoint 扩展：
 * 动手改代码之前先留一个可回退的快照，这样「完全访问」才敢真的放权给 Agent。
 *
 * 为什么不用 git：Trae / Cursor / Devin 都不要求用户机器上装 git，做法是自己存文件快照。
 * 我们照这条路走 —— 遍历工作区，每个文件按内容 sha256 存成一个 blob（同样内容只留一份），
 * 再写一份 manifest 记下「相对路径 → 内容哈希」。还原时按 manifest 把内容写回磁盘。
 * 工作目录是不是 git 仓库、机器上有没有 git 可执行文件，都与这里无关。
 *
 * 快照存在应用数据目录（userData/code-snapshots/<工作目录哈希>/），用户的目录里不会多出
 * 任何东西。二进制文件按字节原样存，不做文本转换。
 *
 * 与 git 版的取舍：不读 .gitignore —— 我们只关心「Agent 改了什么」，被 ignore 的文件
 * （.env 之类）同样需要能回退，所以改用一份固定的排除名单挡住依赖/产物目录；
 * 超过 MAX_FILE_SIZE 的文件不进快照，免得一次快照把大二进制也读进来。
 *
 * 已知边界：还原只把 manifest 里的文件写回去，快照之后**新建**的文件不会被自动删掉 ——
 * 这是刻意保守的选择，宁可少恢复也不误删用户的新文件。编辑重跑时除外：那几轮 Agent
 * 新建的文件会被调用方明确列进 removePaths 一并删掉，否则重跑会看到一堆孤儿文件。
 */

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

/** 目录名命中就整棵跳过：依赖、版本库、构建产物、缓存 */
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'release', 'target',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.turbo',
])

/** 文件名命中就跳过：系统垃圾文件 */
const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db'])

/** 扩展名命中就跳过：日志这类只增不减、没有回退价值的东西 */
const EXCLUDE_EXT = new Set(['.log'])

/** 单个文件超过这个大小就不进快照（源码/配置远够用，避免把大二进制读进来） */
const MAX_FILE_SIZE = 10 * 1024 * 1024

/** 快照存放根目录，由主进程在 app ready 后注入（userData/code-snapshots） */
let storeRoot = path.join(os.tmpdir(), 'yu-code-snapshots')

function setStoreRoot(dir) {
  if (dir) storeRoot = String(dir)
}

/** 某个工作目录对应的快照仓库（同一个目录永远映射到同一个桶） */
function projectStore(projectDir) {
  const key = crypto.createHash('sha1').update(path.resolve(projectDir)).digest('hex').slice(0, 16)
  return path.join(storeRoot, key)
}

function indexPath(store) {
  return path.join(store, 'index.json')
}

function blobPath(store, hash) {
  return path.join(store, 'blobs', hash.slice(0, 2), hash.slice(2))
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function hashOf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 快照清单（新的在前） */
function readIndex(store) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(store), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function readManifest(store, sha) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(store, 'manifests', `${sha}.json`), 'utf8'))
    return parsed && Array.isArray(parsed.files) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 遍历工作区，返回 [相对路径(正斜杠), 绝对路径] 列表。
 * 只收普通文件：软链接、特殊文件一律跳过，免得还原时把链接目标也写坏。
 */
function walk(projectDir) {
  const out = []
  const stack = [projectDir]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry.name)) stack.push(abs)
        continue
      }
      if (!entry.isFile()) continue
      if (EXCLUDE_FILES.has(entry.name) || EXCLUDE_EXT.has(path.extname(entry.name).toLowerCase())) continue
      out.push([path.relative(projectDir, abs).split(path.sep).join('/'), abs])
    }
  }
  return out
}

/**
 * 打一个检查点：把整棵工作区（含从未被任何版本控制跟踪过的文件）存进快照。
 * @returns {{ sha: string, at: number, files: number, bytes: number } | null}
 *          工作目录无效或快照写不出来时返回 null —— 调用方按「这轮没有检查点」处理
 */
function create(projectDir) {
  if (!projectDir) return null
  try {
    if (!fs.statSync(projectDir).isDirectory()) return null
  } catch {
    return null
  }

  const store = projectStore(projectDir)
  const manifestRoot = path.join(store, 'manifests')
  try {
    ensureDir(path.join(store, 'blobs'))
    ensureDir(manifestRoot)
  } catch {
    return null
  }

  const files = []
  let bytes = 0
  for (const [rel, abs] of walk(projectDir)) {
    let content, mode
    try {
      const st = fs.statSync(abs)
      if (!st.isFile() || st.size > MAX_FILE_SIZE) continue
      content = fs.readFileSync(abs)
      mode = st.mode & 0o777
    } catch {
      continue
    }
    const hash = hashOf(content)
    const blob = blobPath(store, hash)
    try {
      // 内容相同就是同一个 blob：文件没改过的轮次不会重复占空间
      if (!fs.existsSync(blob)) {
        ensureDir(path.dirname(blob))
        fs.writeFileSync(blob, content)
      }
    } catch {
      continue
    }
    files.push({ path: rel, hash, mode })
    bytes += content.length
  }

  const at = Date.now()
  const sha = crypto.randomBytes(20).toString('hex')
  try {
    fs.writeFileSync(
      path.join(manifestRoot, `${sha}.json`),
      JSON.stringify({ sha, at, files }),
    )
    const index = readIndex(store)
    index.push({ sha, at })
    fs.writeFileSync(indexPath(store), JSON.stringify(index))
  } catch {
    return null
  }

  return { sha, at, files: files.length, bytes }
}

/** 列出本项目已有检查点，新的在前 */
function list(projectDir, limit = 20) {
  if (!projectDir) return []
  return readIndex(projectStore(projectDir))
    .filter((c) => c && c.sha)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, limit)
    .map((c) => ({ sha: c.sha, at: c.at || 0 }))
}

/**
 * 删掉「快照之后新建的文件」（相对工作目录的路径）。
 * 只认工作目录内的普通文件：越界路径、目录一律跳过，删不动也不报错。
 */
function removeFiles(projectDir, relPaths) {
  const removed = []
  for (const rel of Array.isArray(relPaths) ? relPaths : []) {
    const name = String(rel || '').trim()
    if (!name) continue
    const abs = path.resolve(projectDir, name)
    const inside = path.relative(projectDir, abs)
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) continue
    try {
      if (!fs.lstatSync(abs).isFile()) continue
      fs.rmSync(abs, { force: true })
      removed.push(name)
    } catch { /* 已经不在了就算了 */ }
  }
  return removed
}

/**
 * 还原到某个检查点：按 manifest 把每个文件的内容写回工作区。
 * @param sha 省略时用最近的一个；只传 removePaths 时跳过还原，只删新建文件
 * @param opts.removePaths 需要一并删掉的「快照之后新建的文件」（相对路径）
 */
function restore(projectDir, sha, opts = {}) {
  if (!projectDir) return { ok: false, error: '没有工作目录' }
  const removePaths = Array.isArray(opts.removePaths) ? opts.removePaths : []
  const store = projectStore(projectDir)
  let target = String(sha || '').trim()

  if (!target && removePaths.length === 0) {
    target = list(projectDir, 1)[0]?.sha || ''
    if (!target) return { ok: false, error: '没有可用的检查点' }
  }

  if (target) {
    const manifest = readManifest(store, target)
    if (!manifest) return { ok: false, error: `检查点不存在或已损坏: ${target}` }

    for (const file of manifest.files) {
      const abs = path.resolve(projectDir, file.path)
      // 越界路径不碰：manifest 是我们自己写的，但读文件时多一道检查不吃亏
      const inside = path.relative(projectDir, abs)
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) continue

      let content
      try {
        content = fs.readFileSync(blobPath(store, file.hash))
      } catch {
        continue // blob 丢了：跳过这个文件，别的照常还原
      }
      try {
        // 磁盘上已经一致就不写：省一次 IO，也不白白动文件的修改时间
        if (fs.readFileSync(abs).equals(content)) continue
      } catch { /* 文件不在或被删了：下面直接写回去 */ }
      try {
        ensureDir(path.dirname(abs))
        fs.writeFileSync(abs, content)
        if (process.platform !== 'win32' && typeof file.mode === 'number') {
          try { fs.chmodSync(abs, file.mode) } catch { /* 权限位还原失败不影响内容 */ }
        }
      } catch { /* 单个文件写不进去（被占用等）：继续还原剩下的 */ }
    }
  }

  return { ok: true, sha: target || null, removed: removeFiles(projectDir, removePaths) }
}

module.exports = { setStoreRoot, create, list, restore }
