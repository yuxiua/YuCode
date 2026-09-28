const { contextBridge, ipcRenderer, webFrame } = require('electron')

// 同步取一次主进程的状态快照（工作区/对话/扩展等）。
// 渲染进程在模块初始化阶段就要用它建 store，只能用同步 IPC。
let initialState = {}
try {
  initialState = ipcRenderer.sendSync('state:load-sync') || {}
} catch {
  /* 主进程尚未就绪时降级为空状态 */
}

/**
 * Agent 事件都从主进程的「每会话 shim」发出，统一带一层 { __chatId, data }。
 * 这里解包，把业务数据交给回调、把 chatId 作为第二参数交出去，
 * 界面就能把事件投递到对应会话的时间线（同一窗口多会话并发靠它）。
 */
function onAgentEvent(channel, callback) {
  const listener = (_event, payload) => {
    if (payload && typeof payload === 'object' && '__chatId' in payload) {
      callback(payload.data, payload.__chatId)
    } else {
      // 兼容：万一有事件没经 shim（例如主进程直发），原样交给回调
      callback(payload, undefined)
    }
  }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('piAPI', {
  // 工作区状态（文件存储）
  initialState,
  /** 合并写入状态；值为 null 表示删除该 key */
  saveState: (patch) => ipcRenderer.send('state:save', patch),

  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // 全局界面缩放（设置里的字号大小）
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),

  // Terminal
  createTerminal: (opts) => ipcRenderer.invoke('terminal:create', opts),
  writeTerminal: (id, data) => ipcRenderer.send('terminal:write', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  killTerminal: (id) => ipcRenderer.invoke('terminal:kill', { id }),
  /** 该终端底下是否还有子进程在跑（关闭前用来决定要不要确认） */
  hasTerminalChildren: (id) => ipcRenderer.invoke('terminal:has-children', { id }),
  onTerminalData: (id, callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on(`terminal:data:${id}`, listener)
    return () => ipcRenderer.removeListener(`terminal:data:${id}`, listener)
  },
  onTerminalClose: (id, callback) => {
    const listener = (_event, code) => callback(code)
    ipcRenderer.on(`terminal:close:${id}`, listener)
    return () => ipcRenderer.removeListener(`terminal:close:${id}`, listener)
  },

  // Dialogs
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
  createFile: () => ipcRenderer.invoke('file:create'),
  /** 菜单「打开文件夹」：选一个目录，在新窗口里作为工作区打开（原窗口保持不变） */
  openFolderInNewWindow: () => ipcRenderer.invoke('window:open-folder'),

  // Python environments
  listPythonEnvs: () => ipcRenderer.invoke('python:list-envs'),
  /** 校验一个目录是不是可用的 Python 环境，返回 { ok, env?, error? } */
  inspectPythonEnv: (dirPath) => ipcRenderer.invoke('python:inspect-env', { dirPath }),

  // File system
  readFS: (filePath) => ipcRenderer.invoke('fs:read', { filePath }),
  writeFS: (filePath, content) => ipcRenderer.invoke('fs:write', { filePath, content }),
  listFS: (dirPath) => ipcRenderer.invoke('fs:list', { dirPath }),
  deleteFS: (targetPath) => ipcRenderer.invoke('fs:delete', { targetPath }),
  renameFS: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', { oldPath, newPath }),
  mkdirFS: (dirPath) => ipcRenderer.invoke('fs:mkdir', { dirPath }),
  copyFS: (sourcePath, targetDir) => ipcRenderer.invoke('fs:copy', { sourcePath, targetDir }),
  moveFS: (sourcePath, targetDir) => ipcRenderer.invoke('fs:move', { sourcePath, targetDir }),
  /** 从系统外部（拖拽 / 资源管理器复制）导入路径到目标目录 */
  importPaths: (sourcePaths, targetDir) => ipcRenderer.invoke('fs:import-paths', { sourcePaths, targetDir }),
  /** 读取系统剪贴板中复制的文件路径列表 */
  readClipboardFiles: () => ipcRenderer.invoke('clipboard:read-files'),
  /** 把文件/文件夹写进系统剪贴板，供资源管理器等外部软件 Ctrl+V 粘贴 */
  writeClipboardFiles: (paths, cut) => ipcRenderer.invoke('clipboard:write-files', { paths, cut }),
  /** 监听目录变更（外部改动文件后自动刷新文件树） */
  watchDir: (dirPath) => ipcRenderer.invoke('fs:watch-dir', { dirPath }),
  onDirChanged: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('fs:dir-changed', listener)
    return () => ipcRenderer.removeListener('fs:dir-changed', listener)
  },
  showItemInFolder: (targetPath) => ipcRenderer.invoke('shell:show-item', { targetPath }),

  // Security
  setAllowedDir: (dirPath) => ipcRenderer.send('security:set-allowed-dir', { dirPath }),

  // Browser control (agent)
  browserOpen: (url, opts) => ipcRenderer.invoke('browser:open', { url, ...opts }),
  browserNavigate: (url) => ipcRenderer.invoke('browser:navigate', { url }),
  browserExecute: (script) => ipcRenderer.invoke('browser:execute', { script }),
  browserScreenshot: () => ipcRenderer.invoke('browser:screenshot'),
  browserClose: () => ipcRenderer.invoke('browser:close'),

  // Agent（chatId 标识窗口内的哪个会话，多会话并发时不能省）
  /** 发消息；model 是这个会话绑定的模型配置（不同会话可以用不同模型） */
  sendToAgent: (message, chatId, model) => ipcRenderer.invoke('agent:send', { message, chatId, model }),
  /** 下发模型：带 chatId 只作用于该会话，不带则作为窗口默认广播给全部会话 */
  setAgentModel: (config, chatId) => ipcRenderer.invoke('agent:set-model', { config, chatId }),
  /** 模型连通性自测：登记到 Pi + 直连端点 + pi 是否识别，返回逐步结果 */
  testModel: (config) => ipcRenderer.invoke('model:test', config),
  interruptAgent: (chatId) => ipcRenderer.invoke('agent:interrupt', { chatId }),
  setAgentProjectDir: (dirPath) => ipcRenderer.invoke('agent:set-project-dir', { dirPath }),
  /** 同步「已安装且启用」的扩展，会注入到 Agent 系统提示词 */
  setAgentExtensions: (extensions) => ipcRenderer.invoke('agent:set-extensions', { extensions }),
  /** 计划模式：开启后 Agent 只读不改，先出计划 */
  setPlanMode: (enabled) => ipcRenderer.invoke('agent:set-plan-mode', { enabled }),
  /** Agent 自己切换计划模式（例如计划获批后自动退出），界面要同步开关状态 */
  onAgentPlanMode: (callback) => onAgentEvent('agent:plan-mode', callback),
  /** 护栏命中时是先弹卡问用户（true）还是直接拦下（false） */
  setRiskConfirm: (enabled) => ipcRenderer.invoke('agent:set-risk-confirm', { enabled }),
  /** 改完文件是否自动把诊断结果回灌给 Agent */
  setAutoDiagnostics: (enabled) => ipcRenderer.invoke('agent:set-auto-diagnostics', { enabled }),
  /** 把某个会话的历史灌回 Agent 上下文（切换会话 / 重启后恢复）。
   *  chatId 是聊天标签 id：Pi 后端按「目录 + 标签」对应一个 pi 会话 */
  loadAgentContext: (messages, chatId) => ipcRenderer.invoke('agent:load-context', { messages, chatId }),
  /** Agent 的任务清单（todo_write 维护），界面实时显示进度 */
  onAgentTodos: (callback) => onAgentEvent('agent:todos', callback),
  /** 内置能力清单：已原生生效、不依赖 Pi 扩展的那些 */
  listBuiltins: () => ipcRenderer.invoke('builtins:list'),
  /** 改动检查点：列出 / 回退到某个快照 */
  listCheckpoints: () => ipcRenderer.invoke('checkpoints:list'),
  restoreCheckpoint: (sha, removePaths) => ipcRenderer.invoke('checkpoints:restore', { sha, removePaths }),
  /** 编辑历史消息重跑前，把 Agent 上下文退回那条消息之前 */
  rewindAgent: (payload) => ipcRenderer.invoke('agent:rewind', payload),
  /** Agent 每轮任务开始前打下的检查点 */
  onAgentCheckpoint: (callback) => onAgentEvent('agent:checkpoint', callback),

  // Extensions（安装 / 卸载 / 状态一律走内置的 pi CLI）
  /** 扫描已安装：放进 skills 目录的 Skill + Pi 包里的 Skill + pi CLI 认的包本身 */
  listExtensions: (projectDir) => ipcRenderer.invoke('extensions:list', { projectDir }),
  /** 可安装清单（含是否已安装，状态取自 `pi list`） */
  extensionCatalog: () => ipcRenderer.invoke('extensions:catalog'),
  /** 真实安装：交给 `pi install <source>`，来源形如 npm:<包名> / git:<仓库地址> / <本地目录> */
  installExtension: (source) => ipcRenderer.invoke('extensions:install', { source }),
  uninstallExtension: (id, projectDir) => ipcRenderer.invoke('extensions:uninstall', { id, projectDir }),
  /** 用系统文件管理器打开扩展目录 */
  openExtensionsDir: () => ipcRenderer.invoke('extensions:open-dir'),
  /** Pi 运行时状态（内置在安装包里的那份，或用户自装的） */
  piInfo: () => ipcRenderer.invoke('pi:info'),
  /** 应用自身版本号（菜单栏「帮助 → 关于 Yu Code」显示用） */
  appVersion: () => ipcRenderer.invoke('app:version'),

  // MCP：外部工具（自研客户端，stdio 子进程，不执行第三方扩展代码）
  /** 所有 server 的配置 + 连接状态 + 已发现的工具 */
  listMcpServers: () => ipcRenderer.invoke('mcp:list'),
  /** 新增一个 server（command + args），加完立即尝试连接 */
  addMcpServer: (server) => ipcRenderer.invoke('mcp:add', server),
  removeMcpServer: (id) => ipcRenderer.invoke('mcp:remove', { id }),
  toggleMcpServer: (id, enabled) => ipcRenderer.invoke('mcp:toggle', { id, enabled }),
  /** 不带 id 时重连全部启用的 server */
  refreshMcpServers: (id) => ipcRenderer.invoke('mcp:refresh', { id }),
  onAgentResponse: (callback) => onAgentEvent('agent:response', callback),
  onAgentStatus: (callback) => onAgentEvent('agent:status', callback),
  /** 真实 token 用量（来自 API 的 usage），显示在对话框最下方 */
  onAgentUsage: (callback) => onAgentEvent('agent:usage', callback),
  /** 服务端报出真实的上下文上限，界面要把模型配置里的 contextWindow 改过来并持久化 */
  onModelCorrected: (callback) => onAgentEvent('agent:model-corrected', callback),
  onAgentStream: (callback) => onAgentEvent('agent:stream', callback),
  /** 每次文件改动推来的 diff（用于把「改了什么」展示给用户） */
  onAgentDiff: (callback) => onAgentEvent('agent:diff', callback),
  /** Agent 用 ask_user 提问，等用户作答后才继续 */
  onAgentAsk: (callback) => onAgentEvent('agent:ask', callback),
  /** 回答 ask_user 的提问（chatId 指明是哪个会话在问） */
  answerAgent: (id, answer, chatId) => ipcRenderer.invoke('agent:answer', { id, answer, chatId }),
  /** ctrl+左键跳转：优先 LSP 语义定义，拿不到再按名字在工程里找。
   *  at 是点击处的位置（1-based），有它 LSP 才能判断光标下是哪个符号 */
  findSymbol: (name, at) => ipcRenderer.invoke('search:symbol', { name, ...(at || {}) }),
  onFileOpen: (callback) => {
    const listener = (_event, filePath) => callback(filePath)
    ipcRenderer.on('file:open', listener)
    return () => ipcRenderer.removeListener('file:open', listener)
  },
  // 右键文件夹「用 Yu Code 打开」传入的是目录，当作工作区打开
  onFolderOpen: (callback) => {
    const listener = (_event, dirPath) => callback(dirPath)
    ipcRenderer.on('folder:open', listener)
    return () => ipcRenderer.removeListener('folder:open', listener)
  },
  /** 渲染进程监听注册完毕，通知主进程可以派发启动时待打开的路径了 */
  notifyRendererReady: () => ipcRenderer.send('app:renderer-ready'),
})
