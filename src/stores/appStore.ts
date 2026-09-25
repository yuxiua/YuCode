import { create } from 'zustand'
import type { Message, AgentStatus, Model, Plugin, Skill, ExtensionCatalogItem, InstalledExtension, QueuedMessage, TokenUsage, AgentAsk } from '../types'
import { storage } from './persist'
import { getLanguageFromExt } from '../utils/language'

interface PanelSizes {
  left: number
  right: number
}

/**
 * 把「相对工作目录」的路径补成绝对路径。
 * 编辑器里打开的路径一律是绝对路径，而 Agent 的 diff、符号扫描给的都是相对路径，
 * 两边对不上就没法把磁盘上的改动同步回编辑器。
 */
function toAbsolutePath(dir: string, p: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')) return p
  if (!dir) return p
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${p.replace(/[\\/]/g, sep)}`
}

// 界面外观与 Agent 行为开关（持久化到文件存储）
export interface UiSettings {
  /** 全局缩放，1 = 100%。默认略放大，让整体字号更舒适 */
  uiScale: number
  /** 全局字体族 */
  fontFamily: string
  /** 护栏命中时先弹卡问用户；关掉则直接拦下不让执行。默认开 */
  askBeforeRisk?: boolean
  /** 改完文件自动把诊断（类型/语法错误）回灌给 Agent。默认开 */
  autoDiagnostics?: boolean
}

const UI_FONT_OPTIONS = ['Inter', 'Microsoft YaHei', 'system-ui', 'JetBrains Mono'] as const

const DEFAULT_UI_SETTINGS: UiSettings = {
  uiScale: 1.1,
  fontFamily: 'Inter',
  askBeforeRisk: true,
  autoDiagnostics: true,
}

function loadUiSettings(): UiSettings {
  try {
    const raw = storage.getItem('pi-ui-settings')
    if (raw) return { ...DEFAULT_UI_SETTINGS, ...(JSON.parse(raw) as Partial<UiSettings>) }
  } catch { /* ignore */ }
  return DEFAULT_UI_SETTINGS
}

function saveUiSettings(s: UiSettings) {
  try {
    storage.setItem('pi-ui-settings', JSON.stringify(s))
  } catch { /* ignore */ }
}

// 记住上次打开的工作目录：重启后自动恢复，避免每次都要重新选目录
function loadCurrentDir(): string {
  try {
    return storage.getItem('pi-current-dir') || ''
  } catch {
    return ''
  }
}

function saveCurrentDir(dir: string) {
  try {
    if (dir) storage.setItem('pi-current-dir', dir)
    else storage.removeItem('pi-current-dir')
  } catch { /* ignore */ }
}

// 扩展安装串行化：pi install 会同时改 settings.json 与 node_modules，并发跑会互相踩，
// 所以后面排的队等前一个结束再开始（界面上仍然各自显示「安装中…」）
let installQueue: Promise<unknown> = Promise.resolve()

// 已安装扩展的启用开关。扩展本体是磁盘上的真实文件（~/.pi/agent/skills 等），
// 这里只记「用户是否启用」；启用的 Skill 正文会注入 Agent 系统提示词。
const EXT_ENABLED_KEY = 'pi-ext-enabled'

function loadExtEnabled(): Record<string, boolean> {
  try {
    const raw = storage.getItem(EXT_ENABLED_KEY)
    if (raw) return JSON.parse(raw) as Record<string, boolean>
  } catch { /* ignore */ }
  return {}
}

function saveExtEnabled(map: Record<string, boolean>) {
  try {
    storage.setItem(EXT_ENABLED_KEY, JSON.stringify(map))
  } catch { /* ignore */ }
}

// Python 环境列表：conda 扫描只是「发现」环境，用户删掉的环境要跨重启记住，
// 否则每次启动都会被扫描结果原样塞回来（表现为「删了又出现」）。
const PY_ENVS_KEY = 'pi-python-envs'
const PY_ACTIVE_KEY = 'pi-active-python-env'
const PY_REMOVED_KEY = 'pi-removed-python-envs'

function loadPythonEnvs(): { name: string; path: string }[] {
  try {
    const raw = storage.getItem(PY_ENVS_KEY)
    if (raw) return JSON.parse(raw) as { name: string; path: string }[]
  } catch { /* ignore */ }
  return []
}

function loadActivePythonEnv(): string {
  try {
    return storage.getItem(PY_ACTIVE_KEY) || 'system'
  } catch {
    return 'system'
  }
}

function loadRemovedPythonEnvs(): string[] {
  try {
    const raw = storage.getItem(PY_REMOVED_KEY)
    // 过滤掉不含路径分隔符的脏数据：旧版本解析 conda 输出有 bug，
    // 所有环境都退化成了 'python.exe'，这类标记匹配不到任何真实环境，留着没意义
    if (raw) return (JSON.parse(raw) as string[]).filter((p) => typeof p === 'string' && /[\\/]/.test(p))
  } catch { /* ignore */ }
  return []
}

function savePythonEnvs(envs: { name: string; path: string }[]) {
  try {
    storage.setItem(PY_ENVS_KEY, JSON.stringify(envs))
  } catch { /* ignore */ }
}

function saveRemovedPythonEnvs(paths: string[]) {
  try {
    storage.setItem(PY_REMOVED_KEY, JSON.stringify(paths))
  } catch { /* ignore */ }
}

/** 「运行代码」请求：由编辑器发出，终端面板接管并在新标签页里执行 */
export interface RunRequest {
  /** 每次请求的唯一标识，保证同一命令重复执行也能触发 */
  id: number
  cwd: string
  title: string
  command: string
}

export { UI_FONT_OPTIONS }

interface AppState {
  // Panel sizes (left/right fixed, center = flex-1)
  panelSizes: PanelSizes
  settingsOpen: boolean

  /** 一次性提示条（例如「该文件类型不支持打开」），展示后自动消失 */
  notice: { id: number; text: string } | null
  showNotice: (text: string) => void
  clearNotice: () => void

  /** Agent 用 ask_user 抛出的提问；不为 null 时代表正在等用户回答 */
  pendingAsk: AgentAsk | null
  setPendingAsk: (ask: AgentAsk | null) => void

  // 界面外观
  uiSettings: UiSettings
  setUiSettings: (patch: Partial<UiSettings>) => void

  // Chat
  messages: Message[]
  agentStatus: AgentStatus
  history: { id: string; title: string; time: string }[]
  activeChatId: string | null

  // Task queue
  queue: QueuedMessage[]
  isRunning: boolean
  isInterrupted: boolean

  // File tree
  currentDir: string
  openFiles: { path: string; name: string; content: string; language: string; dirty?: boolean }[]
  activeFilePath: string | null
  /** 编辑器待跳转的位置（ctrl+左键跳转定义后滚动到这里），消费完由 clearReveal 清空 */
  revealTarget: { path: string; line: number } | null

  // Terminal
  terminalVisible: boolean
  setTerminalVisible: (visible: boolean) => void
  /**
   * 「新建终端」请求计数。终端的标签页列表是 TerminalPanel 的内部 state，
   * 菜单栏够不着，所以用这个自增计数当信号：变了就说明外面要求开一个新标签页。
   */
  terminalCreateRequest: number
  requestNewTerminal: () => void
  /** 最近的「运行代码」请求：编辑器发出，终端面板接管执行 */
  runRequest: RunRequest | null
  requestRun: (req: { cwd: string; title: string; command: string }) => void
  /** 终端面板消费完请求后清空，避免面板重新挂载时重复执行 */
  clearRunRequest: () => void

  // Settings
  models: Model[]
  activeModelId: string
  plugins: Plugin[]
  skills: Skill[]
  extensions: ExtensionCatalogItem[]
  /** 已安装的扩展（真实读自磁盘） */
  installedExtensions: InstalledExtension[]
  /** 已安装扩展的启用开关，key 为 InstalledExtension.id；缺省视为启用 */
  extEnabled: Record<string, boolean>
  /** 正在安装的清单项 source（可同时多点几个，逐个串行执行） */
  extInstalling: string[]
  /** 安装/卸载结果提示 */
  extMessage: { kind: 'ok' | 'error'; text: string } | null
  pythonEnvs: { name: string; path: string }[]
  activePythonEnv: string
  /** 用户删掉过的环境（按 python 解释器路径记），刷新扫描时不再自动出现 */
  removedPythonEnvPaths: string[]
  /** 计划模式：开启后 Agent 只读不改，先出计划 */
  planMode: boolean
  setPlanMode: (enabled: boolean) => void

  // Actions
  setPanelSizes: (sizes: Partial<PanelSizes>) => void
  setSettingsOpen: (open: boolean) => void
  addMessage: (msg: Message) => void
  setAgentStatus: (status: AgentStatus) => void
  newChat: () => void
  setActiveChat: (id: string) => void
  setCurrentDir: (dir: string) => void
  openFile: (file: { path: string; name: string; content: string; language: string }) => void
  closeFile: (path: string) => void
  setActiveFile: (path: string) => void
  /** 编辑器里改了内容：更新 store 并标记未保存 */
  setFileContent: (path: string, content: string) => void
  /** 落盘（ctrl+S / 工具栏保存），成功后清掉未保存标记 */
  saveFile: (path: string) => Promise<void>
  /** 打开某个文件的指定行并跳过去，供 ctrl+左键跨文件跳转使用 */
  openFileAt: (filePath: string, line: number) => Promise<void>
  /** 磁盘上的文件被外部改动了（Agent 写文件、回退）：若它正开着且本地没未保存改动，就刷新 */
  syncOpenFile: (path: string) => Promise<void>
  clearReveal: () => void
  toggleTerminal: () => void
  addModel: (model: Model) => void
  removeModel: (id: string) => void
  updateModel: (id: string, updates: Partial<Model>) => void
  setActiveModel: (id: string) => void
  togglePlugin: (id: string) => void
  toggleSkill: (id: string) => void
  addSkill: (skill: Skill) => void
  removeSkill: (id: string) => void
  setPythonEnv: (name: string) => void
  /** 用一次系统扫描结果刷新列表：新发现的环境自动加入，用户删掉的不再回来 */
  refreshPythonEnvs: (detected: { name: string; path: string }[]) => void
  addPythonEnv: (env: { name: string; path: string }) => void
  removePythonEnv: (env: { name: string; path: string }) => void
  clearMessages: () => void

  // Queue actions
  enqueueMessage: (msg: QueuedMessage) => void
  dequeueMessage: (id: string) => void
  clearQueue: () => void
  setRunning: (running: boolean) => void
  setInterrupted: (interrupted: boolean) => void

  // Extension actions
  /** 重新扫描已安装扩展 + 拉取可安装清单 */
  refreshExtensions: () => Promise<void>
  /** 真实安装：source 形如 npm:<包名> / git:<仓库地址> */
  installExtension: (source: string) => Promise<void>
  uninstallExtension: (id: string) => Promise<void>
  /** 启用 / 禁用已安装扩展；禁用后其 Skill 不再注入 Agent */
  toggleExtension: (id: string) => void
  clearExtMessage: () => void

  // Token usage
  tokenUsage: TokenUsage
  setTokenUsage: (usage: Partial<TokenUsage>) => void

  // File operations
  newFile: () => void
  openFolder: () => void
}

// 不预置任何模型：安装包里不内置 API（地址、密钥一律不带），
// 模型全部由用户自己在设置面板添加 → userData/yu-code-state.json。
function loadUserModels(): Model[] {
  try {
    const raw = storage.getItem('pi-user-models')
    if (raw) return JSON.parse(raw) as Model[]
  } catch { /* ignore */ }
  return []
}

function saveUserModels(models: Model[]) {
  storage.setItem('pi-user-models', JSON.stringify(models))
}

// 记住上次选中的模型：重启后继续用它，而不是每次都退回列表里的第一个。
// 存的 id 可能已经失效（模型被删了），所以取用时要核对列表，不在就回落到第一个。
const ACTIVE_MODEL_KEY = 'pi-active-model'

function loadActiveModelId(models: Model[]): string {
  try {
    const saved = storage.getItem(ACTIVE_MODEL_KEY)
    if (saved && models.some((m) => m.id === saved)) return saved
  } catch { /* ignore */ }
  return models[0]?.id || ''
}

function saveActiveModelId(id: string) {
  try {
    if (id) storage.setItem(ACTIVE_MODEL_KEY, id)
  } catch { /* ignore */ }
}

const defaultModels: Model[] = loadUserModels()

const defaultPlugins: Plugin[] = [
  { id: 'script-creator', name: '剧本创建', description: 'AI 驱动的剧本/场景创作工具', enabled: true, version: '1.0.0', source: 'local', category: 'creative' },
  { id: 'code-writer', name: '写代码', description: 'AI 辅助编码，支持多语言', enabled: true, version: '1.0.0', source: 'local', category: 'core' },
]

// 扩展清单与「已安装」列表都由主进程提供：
//   清单   → ~/.pi/agent/extensions.catalog.json（可手工编辑扩充）
//   已安装 → ~/.pi/agent/skills、~/.pi/agent/extensions，以及项目内的 .agents/skills、.pi/skills
// 主进程启动前（浏览器里跑 vite）拿不到数据，此时列表为空。

const defaultSkills: Skill[] = [
  { id: 'web-search', name: 'Web 搜索', description: '联网搜索获取实时信息', enabled: true, category: 'research', source: 'builtin' },
  { id: 'file-ops', name: '文件操作', description: '读取/写入/管理项目文件', enabled: true, category: 'tools', source: 'builtin' },
  { id: 'terminal-exec', name: '终端执行', description: '在终端中运行命令', enabled: true, category: 'tools', source: 'builtin' },
  { id: 'code-review', name: '代码审查', description: '自动审查代码质量', enabled: false, category: 'analysis', source: 'builtin' },
]

export const useAppStore = create<AppState>((set, get) => ({
  panelSizes: { left: 220, right: 360 },
  settingsOpen: false,
  notice: null,
  pendingAsk: null,
  uiSettings: loadUiSettings(),
  setUiSettings: (patch) => set((s) => {
    const next = { ...s.uiSettings, ...patch }
    saveUiSettings(next)
    return { uiSettings: next }
  }),
  messages: [],
  agentStatus: { state: 'idle' },
  history: [{ id: '1', title: '新对话', time: '刚刚' }],
  activeChatId: '1',
  currentDir: loadCurrentDir(),
  openFiles: [],
  activeFilePath: null,
  revealTarget: null,
  terminalVisible: true,
  terminalCreateRequest: 0,
  runRequest: null,
  models: defaultModels,
  activeModelId: loadActiveModelId(defaultModels),
  plugins: defaultPlugins,
  skills: defaultSkills,
  extensions: [],
  installedExtensions: [],
  extEnabled: loadExtEnabled(),
  extInstalling: [],
  extMessage: null,
  pythonEnvs: loadPythonEnvs(),
  activePythonEnv: loadActivePythonEnv(),
  removedPythonEnvPaths: loadRemovedPythonEnvs(),
  planMode: false,

  // Queue state
  queue: [],
  isRunning: false,
  isInterrupted: false,

  // Token usage
  tokenUsage: { inputTokens: 0, outputTokens: 0, inputLimit: 0, contextWindow: 0, tokensPerSecond: 0, live: false },

  setPanelSizes: (sizes) => set((s) => ({ panelSizes: { ...s.panelSizes, ...sizes } })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  showNotice: (text) => set({ notice: { id: Date.now(), text } }),
  clearNotice: () => set({ notice: null }),
  setPendingAsk: (ask) => set({ pendingAsk: ask }),
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  setAgentStatus: (status) => set({ agentStatus: status }),
  newChat: () => set((s) => {
    const id = Date.now().toString()
    return {
      history: [...s.history, { id, title: '新对话', time: '刚刚' }],
      activeChatId: id,
      messages: [],
      agentStatus: { state: 'idle' },
    }
  }),
  setActiveChat: (id) => set({ activeChatId: id, messages: [] }),
  setCurrentDir: (dir) => {
    set({ currentDir: dir })
    saveCurrentDir(dir)
    // 安全边界与 Agent 工作目录都跟随左侧资源管理器打开的目录
    if (dir && window.piAPI) {
      window.piAPI.setAllowedDir(dir)
      window.piAPI.setAgentProjectDir?.(dir)
    }
  },
  openFile: (file) => set((s) => {
    const existing = s.openFiles.find((f) => f.path === file.path)
    // 已经打开过：用磁盘上的最新内容刷新，但本地未保存的改动不覆盖
    if (existing) {
      return {
        activeFilePath: file.path,
        openFiles: existing.dirty
          ? s.openFiles
          : s.openFiles.map((f) => (f.path === file.path ? { ...f, content: file.content } : f)),
      }
    }
    return { openFiles: [...s.openFiles, file], activeFilePath: file.path }
  }),
  closeFile: (path) => set((s) => ({
    // 未保存的确认交给界面层（ConfirmDialog），这里只负责关
    openFiles: s.openFiles.filter((f) => f.path !== path),
    activeFilePath: s.activeFilePath === path ? null : s.activeFilePath,
  })),
  setActiveFile: (path) => set({ activeFilePath: path }),
  setFileContent: (path, content) => set((s) => ({
    openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, content, dirty: true } : f)),
  })),
  saveFile: async (path) => {
    const file = get().openFiles.find((f) => f.path === path)
    if (!file || !window.piAPI) return
    await window.piAPI.writeFS(path, file.content)
    set((s) => ({
      openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, dirty: false } : f)),
    }))
  },
  openFileAt: async (filePath, line) => {
    // 符号扫描返回的是相对工作目录的路径，这里补成绝对路径再读
    const full = toAbsolutePath(get().currentDir, filePath)
    const name = full.split(/[\\/]/).pop() || full
    if (window.piAPI) {
      try {
        const content = await window.piAPI.readFS(full)
        get().openFile({ path: full, name, content, language: getLanguageFromExt(name) })
      } catch {
        return
      }
    }
    set({ revealTarget: { path: full, line } })
  },
  syncOpenFile: async (filePath) => {
    const path = toAbsolutePath(get().currentDir, filePath)
    const file = get().openFiles.find((f) => f.path === path)
    // 没开着、或本地有未保存改动，都不动 —— 不能把用户正在写的东西冲掉
    if (!file || file.dirty || !window.piAPI) return
    try {
      const content = await window.piAPI.readFS(path)
      if (content === file.content) return
      set((s) => ({
        openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, content } : f)),
      }))
    } catch { /* 文件被删或读不了：保持原样，不打扰用户 */ }
  },
  clearReveal: () => set({ revealTarget: null }),
  // 计划模式只影响 Agent 的行为，主进程那边才是权威，这里同步一份供界面显示
  setPlanMode: (enabled) => {
    set({ planMode: enabled })
    window.piAPI?.setPlanMode(enabled)
  },
  toggleTerminal: () => set((s) => ({ terminalVisible: !s.terminalVisible })),
  setTerminalVisible: (visible) => set({ terminalVisible: visible }),
  requestNewTerminal: () => set((s) => ({
    terminalVisible: true,
    terminalCreateRequest: s.terminalCreateRequest + 1,
  })),
  requestRun: (req) => set({ terminalVisible: true, runRequest: { ...req, id: Date.now() } }),
  clearRunRequest: () => set({ runRequest: null }),

  // Model actions
  addModel: (model) => set((s) => {
    const models = [...s.models, model]
    saveUserModels(models)
    return { models }
  }),
  removeModel: (id) => set((s) => {
    const models = s.models.filter((m) => m.id !== id)
    saveUserModels(models)
    const activeModelId = s.activeModelId === id ? (models[0]?.id || '') : s.activeModelId
    if (activeModelId !== s.activeModelId) saveActiveModelId(activeModelId)
    return { models, activeModelId }
  }),
  updateModel: (id, updates) => set((s) => {
    const models = s.models.map((m) => (m.id === id ? { ...m, ...updates } : m))
    saveUserModels(models)
    return { models }
  }),
  setActiveModel: (id) => {
    saveActiveModelId(id)
    set({ activeModelId: id })
  },

  // Plugin/Skill actions
  togglePlugin: (id) => set((s) => ({
    plugins: s.plugins.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)),
  })),
  toggleSkill: (id) => set((s) => ({
    skills: s.skills.map((sk) => (sk.id === id ? { ...sk, enabled: !sk.enabled } : sk)),
  })),
  addSkill: (skill) => set((s) => ({ skills: [...s.skills, skill] })),
  removeSkill: (id) => set((s) => ({ skills: s.skills.filter((sk) => sk.id !== id) })),
  setPythonEnv: (name) => {
    try {
      storage.setItem(PY_ACTIVE_KEY, name)
    } catch { /* ignore */ }
    set({ activePythonEnv: name })
  },
  refreshPythonEnvs: (detected) => set((s) => {
    // 扫描结果里排除用户删过的，再并上手动添加的（按解释器路径去重）
    const merged = detected.filter((d) => !s.removedPythonEnvPaths.includes(d.path))
    for (const e of s.pythonEnvs) {
      if (!merged.some((m) => m.path === e.path)) merged.push(e)
    }
    savePythonEnvs(merged)
    return { pythonEnvs: merged }
  }),
  addPythonEnv: (env) => set((s) => {
    const next = s.pythonEnvs.some((e) => e.path === env.path) ? s.pythonEnvs : [...s.pythonEnvs, env]
    // 手动添加说明用户又需要它了，从「已删除」名单里撤销，否则下一次刷新又被过滤掉
    const removed = s.removedPythonEnvPaths.filter((p) => p !== env.path)
    savePythonEnvs(next)
    saveRemovedPythonEnvs(removed)
    return { pythonEnvs: next, removedPythonEnvPaths: removed }
  }),
  removePythonEnv: (env) => set((s) => {
    const next = s.pythonEnvs.filter((e) => e.path !== env.path)
    const removed = s.removedPythonEnvPaths.includes(env.path)
      ? s.removedPythonEnvPaths
      : [...s.removedPythonEnvPaths, env.path]
    savePythonEnvs(next)
    saveRemovedPythonEnvs(removed)
    return { pythonEnvs: next, removedPythonEnvPaths: removed }
  }),
  clearMessages: () => set({ messages: [], agentStatus: { state: 'idle' } }),

  // Queue actions
  enqueueMessage: (msg) => set((s) => ({ queue: [...s.queue, msg] })),
  dequeueMessage: (id) => set((s) => ({ queue: s.queue.filter((q) => q.id !== id) })),
  clearQueue: () => set({ queue: [] }),
  setRunning: (running) => set({ isRunning: running }),
  setInterrupted: (interrupted) => set({ isInterrupted: interrupted }),

  // Extension actions
  refreshExtensions: async () => {
    const api = window.piAPI
    if (!api?.listExtensions || !api.extensionCatalog) return
    const projectDir = get().currentDir || undefined
    try {
      const [extensions, installedExtensions] = await Promise.all([
        api.extensionCatalog(),
        api.listExtensions(projectDir),
      ])
      set({ extensions, installedExtensions })
    } catch { /* 扫描失败时保留旧列表，避免界面闪空 */ }
  },
  installExtension: async (source) => {
    const api = window.piAPI
    if (!api?.installExtension) return
    // 已在这一项上等着的重复点击直接忽略，避免排两次队
    if (get().extInstalling.includes(source)) return
    set((s) => ({ extInstalling: [...s.extInstalling, source], extMessage: null }))

    const task = installQueue.then(async () => {
      try {
        const res = await api.installExtension(source)
        if (!res?.ok) {
          set({ extMessage: { kind: 'error', text: res?.error || '安装失败' } })
          return
        }
        // 安装是交给 pi CLI 做的，所以把它自己说的话一并显示出来 —— 用户据此确认真的生效了
        const parts: string[] = []
        if (res.packages?.length) parts.push(`pi 已登记：${res.packages.join('、')}`)
        if (res.skills?.length) parts.push(`可注入 Agent 的技能：${res.skills.join('、')}`)
        if (res.warning) parts.push(res.warning)
        if (res.piOutput) parts.push(`pi 输出：\n${res.piOutput.slice(-400)}`)
        set({ extMessage: { kind: 'ok', text: parts.join('；') || '安装完成' } })
        await get().refreshExtensions()
      } catch (e) {
        set({ extMessage: { kind: 'error', text: e instanceof Error ? e.message : String(e) } })
      } finally {
        set((s) => ({ extInstalling: s.extInstalling.filter((x) => x !== source) }))
      }
    })
    installQueue = task.catch(() => {})
    await task
  },
  uninstallExtension: async (id) => {
    const api = window.piAPI
    if (!api?.uninstallExtension) return
    set({ extMessage: null })
    try {
      const res = await api.uninstallExtension(id, get().currentDir || undefined)
      if (!res?.ok) {
        set({ extMessage: { kind: 'error', text: res?.error || '卸载失败' } })
        return
      }
      const extEnabled = { ...get().extEnabled }
      delete extEnabled[id]
      saveExtEnabled(extEnabled)
      set({ extEnabled })
      await get().refreshExtensions()
    } catch (e) {
      set({ extMessage: { kind: 'error', text: e instanceof Error ? e.message : String(e) } })
    }
  },
  toggleExtension: (id) => set((s) => {
    const extEnabled = { ...s.extEnabled, [id]: s.extEnabled[id] === false }
    saveExtEnabled(extEnabled)
    return { extEnabled }
  }),
  clearExtMessage: () => set({ extMessage: null }),

  // Token usage
  setTokenUsage: (usage) => set((s) => ({
    tokenUsage: { ...s.tokenUsage, ...usage },
  })),

  // File operations
  newFile: () => {
    if (window.piAPI?.createFile) {
      window.piAPI.createFile()
    }
  },
  openFolder: async () => {
    if (window.piAPI?.openFolder) {
      const dir = await window.piAPI.openFolder()
      if (dir) {
        set({ currentDir: dir })
        saveCurrentDir(dir)
        window.piAPI.setAllowedDir(dir)
        window.piAPI.setAgentProjectDir?.(dir)
      }
    } else {
      // Fallback: just set a default path
      set({ currentDir: 'C:\\Users' })
    }
  },
}))
