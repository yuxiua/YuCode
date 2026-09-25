// 扩展引擎：安装 / 卸载 / 列举 全部交给内置的 pi CLI（`pi install` / `pi remove` / `pi list`）。
//
// Pi 扩展不是独立工具，而是插进 Pi 运行时 API 的模块（package.json 里的 pi.extensions，
// 外加指向 pi-coding-agent / pi-ai / pi-tui 的 peerDependency），只有 pi 引擎能加载它们。
// 本应用就是把 pi 引擎装进界面里，所以界面上看到的就是 pi 真正认的扩展 —— 不做二次解释。
//
// 这里只做两件事：
//   1. 展示 —— 把 pi CLI 认的包原样列出来，连它自己的输出一起给界面看；
//   2. 复用 —— 包里声明的 Skill 是纯提示词内容，本应用能读出来注入 Agent 提示词。
//
// 目录约定（与 Pi 一致，因此天然互通）：
//   已装的包     ~/.pi/agent/npm/node_modules/<pkg>   （pi install / 内置扩展同步的落盘处）
//   包清单       ~/.pi/agent/settings.json 的 packages 数组
//   全局 Skill   ~/.pi/agent/skills/<name>/SKILL.md
//   项目 Skill   <项目>/.agents/skills/、<项目>/.pi/skills/
//   扩展清单     electron/extensions-catalog.js（随应用打包的 8 个内置扩展）
const fs = require('fs')
const os = require('os')
const path = require('path')

const { runPi, listPiPackages } = require('./pi')

const HOME = os.homedir()
const PI_AGENT_DIR = path.join(HOME, '.pi', 'agent')
const GLOBAL_SKILL_DIR = path.join(PI_AGENT_DIR, 'skills')
const GLOBAL_EXT_DIR = path.join(PI_AGENT_DIR, 'extensions')
const CATALOG_PATH = path.join(PI_AGENT_DIR, 'extensions.catalog.json')

// 内置扩展清单在 extensions-catalog.js（纯数据）
const { DEFAULT_CATALOG, normalizePkg } = require('./extensions-catalog')

// ==================== SKILL.md 解析 ====================

/** 解析 SKILL.md：YAML frontmatter 里的 name/description + 正文 */
function parseSkillMd(text) {
  let name = ''
  let description = ''
  let body = text
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (m) {
    body = text.slice(m[0].length)
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim())
      if (!kv) continue
      const key = kv[1].toLowerCase()
      const value = kv[2].trim().replace(/^["']|["']$/g, '')
      if (key === 'name') name = value
      else if (key === 'description') description = value
    }
  }
  return { name, description, body: body.trim() }
}

/** Skill 的搜索路径：全局 + 项目级，与 Pi 一致 */
function skillRoots(projectDir) {
  const roots = [
    { dir: GLOBAL_SKILL_DIR, scope: 'global' },
    { dir: path.join(HOME, '.agents', 'skills'), scope: 'global' },
  ]
  if (projectDir) {
    roots.push({ dir: path.join(projectDir, '.agents', 'skills'), scope: 'project' })
    roots.push({ dir: path.join(projectDir, '.pi', 'skills'), scope: 'project' })
  }
  return roots
}

function listDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 扫描手工放进 skills 目录的 Skill（真实读磁盘） */
function listSkills(projectDir) {
  const out = []
  for (const { dir, scope } of skillRoots(projectDir)) {
    for (const entry of listDirSafe(dir)) {
      if (!entry.isDirectory()) continue
      const skillDir = path.join(dir, entry.name)
      let text
      try {
        text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')
      } catch {
        continue // 没有 SKILL.md 就不是 skill
      }
      const meta = parseSkillMd(text)
      out.push({
        kind: 'skill',
        id: `${scope}:${entry.name}`,
        folder: entry.name,
        name: meta.name || entry.name,
        description: meta.description,
        content: meta.body,
        scope,
        dir: skillDir,
      })
    }
  }
  return out
}

// ==================== 已装的 Pi 包 ====================

/** 从包目录的 pi 字段里提取 skills（支持指向 SKILL.md 或包含多个 skill 的目录） */
function collectSkillDirs(pkgDir, piField) {
  const found = []
  for (const rel of piField.skills || []) {
    const abs = path.resolve(pkgDir, rel)
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      for (const sub of listDirSafe(abs)) {
        if (!sub.isDirectory()) continue
        if (fs.existsSync(path.join(abs, sub.name, 'SKILL.md'))) {
          found.push({ src: path.join(abs, sub.name), name: sub.name })
        }
      }
    } else if (path.basename(abs).toLowerCase() === 'skill.md') {
      found.push({ src: path.dirname(abs), name: path.basename(path.dirname(abs)) })
    }
  }
  return found
}

function readPkgJson(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
    return pkg && typeof pkg === 'object' ? pkg : {}
  } catch {
    return {}
  }
}

/**
 * 读一个 Pi 包里声明的 Skill。扩展本身由 pi 引擎加载，这里额外把包里的 Skill
 * 正文读出来，好让界面能单独控制它是否注入 Agent 提示词。
 */
function packageSkills(source, dir) {
  const pkg = readPkgJson(dir)
  const out = []
  for (const { src, name } of collectSkillDirs(dir, pkg.pi || {})) {
    let text
    try {
      text = fs.readFileSync(path.join(src, 'SKILL.md'), 'utf-8')
    } catch {
      continue
    }
    const meta = parseSkillMd(text)
    out.push({
      kind: 'skill',
      // 带上包名，避免不同包里的同名 skill 互相顶掉
      id: `pkgskill:${source}:${name}`,
      folder: name,
      name: meta.name || name,
      description: meta.description || `来自 ${pkg.name || source} 的技能`,
      content: meta.body,
      scope: 'global',
      dir: src,
      // 它属于整个包，要卸载得连包一起 remove，所以界面上不给单独的卸载按钮
      readonly: true,
      viaPackage: pkg.name || source,
    })
  }
  return out
}

/** 所有 Pi 包在本应用里的处境是一样的：装好即被 pi 引擎加载 */
const PACKAGE_DESC = '已装好，pi 引擎启动时自动加载，无需额外操作'

/** 把 pi CLI 认的包整理成界面条目 */
async function listPiPackageItems() {
  const { packages } = await listPiPackages()
  return packages.map((p) => ({
    kind: 'package',
    id: `pkg:${p.source}`,
    folder: path.basename(p.dir || '') || p.source,
    name: p.name,
    description: PACKAGE_DESC,
    source: p.source,
    scope: 'global',
    dir: p.dir,
  }))
}

/**
 * 已安装清单 = 手工 Skill + 包内 Skill + Pi 包本身。
 * 界面按这个顺序展示；Agent 拿到的 Skill 正文也来自这里。
 * 同名只留第一个：手写在自己 skills 目录里的优先，避免同一个技能既从目录
 * 又从包里各注入一遍，白占上下文。
 */
async function listInstalled(projectDir) {
  const packages = await listPiPackageItems()
  const skills = []
  const seenId = new Set()
  const seenName = new Set()
  const push = (skill) => {
    const nameKey = String(skill.name || '').trim().toLowerCase()
    if (seenId.has(skill.id) || (nameKey && seenName.has(nameKey))) return
    seenId.add(skill.id)
    if (nameKey) seenName.add(nameKey)
    skills.push(skill)
  }

  for (const skill of listSkills(projectDir)) push(skill)
  for (const item of packages) {
    if (!item.dir) continue
    for (const skill of packageSkills(item.source, item.dir)) push(skill)
  }
  return [...skills, ...packages]
}

// ==================== 内置扩展清单 ====================

/**
 * 内置扩展清单。以代码里的 DEFAULT_CATALOG 为准，同时把它镜像到
 * ~/.pi/agent/extensions.catalog.json（旧版本会在这里留过时条目，一并覆盖掉）。
 */
function getCatalog() {
  try {
    const raw = fs.readFileSync(CATALOG_PATH, 'utf-8')
    if (raw.trim() !== JSON.stringify(DEFAULT_CATALOG, null, 2).trim()) {
      fs.writeFileSync(CATALOG_PATH, JSON.stringify(DEFAULT_CATALOG, null, 2), 'utf-8')
    }
  } catch {
    try {
      fs.mkdirSync(PI_AGENT_DIR, { recursive: true })
      fs.writeFileSync(CATALOG_PATH, JSON.stringify(DEFAULT_CATALOG, null, 2), 'utf-8')
    } catch (e) {
      console.error('[extensions] 写入清单失败:', e.message)
    }
  }
  return DEFAULT_CATALOG
}

/**
 * 把清单里的写法归一成 pi install 认的 source。
 * pi 接受 npm:xxx、https://直链、git:git@host:path、./本地目录。
 */
function normalizeSource(spec) {
  const s = String(spec || '').trim()
  if (!s) return ''
  if (s.startsWith('git:')) {
    const rest = s.slice(4)
    // 带 :// 的（https/ssh）pi 喜欢直接给 URL；git@host:path 这种保持原样
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(rest) ? rest : s
  }
  return s
}

/** 判断清单项是否已装：以 pi 的包清单为准，和 `pi list` 看到的一致 */
function matchInstalled(item, bySource) {
  return bySource.get(item.source) || bySource.get(normalizeSource(item.source)) || bySource.get(item.name) || null
}

/** 清单 + 安装状态（状态直接取自 pi CLI） */
async function catalogWithState() {
  const { packages } = await listPiPackages()
  const bySource = new Map()
  for (const p of packages) {
    bySource.set(p.source, p)
    bySource.set(normalizeSource(p.source), p)
    bySource.set(p.name, p)
    bySource.set(normalizePkg(p.name), p)
  }
  return getCatalog().map((item) => {
    const hit = matchInstalled(item, bySource)
    return {
      ...item,
      installed: Boolean(hit),
      /** 已装的话是 pi 真正的落盘路径，未装为空串 */
      dir: hit ? hit.dir : '',
    }
  })
}

// ==================== 安装 / 卸载 ====================

/** 安装：全权交给 `pi install`，装完回读一次它自己的清单来确认 */
async function doInstall(source) {
  const spec = normalizeSource(source)
  if (!spec) return { ok: false, error: '空的安装来源' }

  const before = new Set((await listPiPackages()).packages.map((p) => p.source))
  const res = await runPi(['install', spec])
  const output = `${res.stdout}\n${res.stderr}`.trim()
  if (!res.ok) {
    return { ok: false, error: (output || res.error || 'pi install 失败').slice(0, 600) }
  }

  const after = (await listPiPackages()).packages
  const added = after.filter((p) => !before.has(p.source))
  const skills = added.flatMap((p) => (p.dir ? packageSkills(p.source, p.dir) : [])).map((s) => s.name)

  return {
    ok: true,
    piOutput: output,
    packages: added.map((p) => p.source),
    skills,
    warning: added.length === 0 ? 'pi 没有报错，但它的包清单里没看到新增项，可在下面重新扫描确认' : '',
  }
}

/** 安装入口：统一补上 source，便于前端定位是哪一条清单项 */
async function install(source) {
  const spec = String(source || '').trim()
  const result = await doInstall(spec)
  return { source: spec, ...result }
}

/** 卸载。Pi 包交给 `pi remove`（它自己会清 settings 和 node_modules），手工 Skill 直接删文件夹 */
async function uninstall(id, projectDir) {
  const raw = String(id || '').trim()
  if (!raw) return { ok: false, error: '空的扩展标识' }

  if (raw.startsWith('pkgskill:')) {
    return { ok: false, error: '这个技能属于某个 Pi 包，请卸载它所属的包' }
  }
  if (raw.startsWith('pkg:')) {
    const spec = raw.slice(4)
    if (!spec) return { ok: false, error: '无效的包标识' }
    const res = await runPi(['remove', spec])
    if (!res.ok) {
      const output = `${res.stdout}\n${res.stderr}`.trim()
      return { ok: false, error: (output || res.error || 'pi remove 失败').slice(0, 600) }
    }
    return { ok: true, piOutput: `${res.stdout}\n${res.stderr}`.trim() }
  }

  // 手工放进 skills 目录的：只允许删已知根目录下的下一层子目录
  const folder = raw.replace(/^(global|project|ext):/, '')
  if (!folder || folder.includes('..') || /[\\/]/.test(folder)) {
    return { ok: false, error: `非法的扩展标识: ${id}` }
  }
  const allowedRoots = [
    GLOBAL_SKILL_DIR,
    GLOBAL_EXT_DIR,
    path.join(HOME, '.agents', 'skills'),
    ...(projectDir ? [path.join(projectDir, '.agents', 'skills'), path.join(projectDir, '.pi', 'skills')] : []),
  ].map((p) => path.resolve(p))
  for (const root of allowedRoots) {
    const target = path.resolve(root, folder)
    if (path.dirname(target) !== root) continue // 必须正好在根目录下一层
    if (!fs.existsSync(target)) continue
    try {
      fs.rmSync(target, { recursive: true, force: true })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }
  return { ok: false, error: `未找到已安装的扩展: ${folder}` }
}

module.exports = {
  PI_AGENT_DIR,
  GLOBAL_SKILL_DIR,
  GLOBAL_EXT_DIR,
  CATALOG_PATH,
  parseSkillMd,
  listInstalled,
  getCatalog,
  catalogWithState,
  install,
  uninstall,
}
