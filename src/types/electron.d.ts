import type { InstalledExtension, ExtensionCatalogItem, PiRuntimeInfo, FileDiff, AgentAsk, AgentStatusEvent, SymbolHit, Checkpoint, BuiltinCapabilities, AgentTodo, McpServer } from './index'

export {}

declare global {
  interface Window {
    piAPI: {
      /** 启动时从主进程同步读到的状态快照（工作区/对话/扩展等），key 为字符串 */
      initialState: Record<string, string>
      /** 合并写入状态到主进程的文件存储；值为 null 表示删除该 key */
      saveState: (patch: Record<string, string | null>) => void

      // Window controls
      minimize: () => void
      maximize: () => void
      close: () => void
      /** 全局界面缩放（设置 → 通用 → 字号大小） */
      setZoomFactor: (factor: number) => void

      // Terminal
      createTerminal: (opts: { cwd?: string; shell?: string; pythonEnv?: string; cols?: number; rows?: number }) => Promise<string>
      writeTerminal: (id: string, data: string) => void
      resizeTerminal: (id: string, cols: number, rows: number) => void
      killTerminal: (id: string) => Promise<void>
      /** 该终端底下是否还有子进程在跑（关闭前用来决定要不要确认） */
      hasTerminalChildren: (id: string) => Promise<boolean>
      onTerminalData: (id: string, callback: (data: string) => void) => () => void
      onTerminalClose: (id: string, callback: (code: number) => void) => () => void

      // Dialogs
      openFolderDialog: () => Promise<string | null>
      openFileDialog: () => Promise<string | null>
      createFile: () => Promise<string | null>
      openFolder: () => Promise<string | null>

      // Python environments
      listPythonEnvs: () => Promise<{ name: string; path: string; version?: string }[]>
      /** 校验目录是否为可用的 Python 环境 */
      inspectPythonEnv: (dirPath: string) => Promise<
        { ok: true; env: { name: string; path: string } } | { ok: false; error: string }
      >

      // File system
      readFS: (filePath: string) => Promise<string>
      writeFS: (filePath: string, content: string) => Promise<void>
      listFS: (dirPath: string) => Promise<{ name: string; isDirectory: boolean; path: string }[]>
      deleteFS: (targetPath: string) => Promise<void>
      renameFS: (oldPath: string, newPath: string) => Promise<void>
      mkdirFS: (dirPath: string) => Promise<void>
      copyFS: (sourcePath: string, targetDir: string) => Promise<string>
      /** 移动文件/文件夹到目标目录（剪切+粘贴），返回落地路径 */
      moveFS: (sourcePath: string, targetDir: string) => Promise<string>
      /** 从系统外部（拖拽 / 资源管理器复制）导入路径到目标目录，返回落地路径列表 */
      importPaths: (sourcePaths: string[], targetDir: string) => Promise<string[]>
      /** 读取系统剪贴板中复制的文件路径列表 */
      readClipboardFiles: () => Promise<string[]>
      /** 把文件/文件夹写进系统剪贴板（cut=true 表示剪切），供外部软件 Ctrl+V 粘贴 */
      writeClipboardFiles: (paths: string[], cut: boolean) => Promise<{ ok: boolean; error?: string }>
      /** 让主进程监听该目录，外部改动文件后通过 onDirChanged 推送 */
      watchDir: (dirPath: string) => Promise<{ success: boolean }>
      onDirChanged: (callback: (data: { dirPath: string }) => void) => () => void
      /** 在系统资源管理器中定位并选中该文件 */
      showItemInFolder: (targetPath: string) => Promise<void>

      // Security
      setAllowedDir: (dirPath: string) => void

      // Browser control (agent)
      browserOpen: (url: string, opts?: { width?: number; height?: number }) => Promise<{ id: string; url: string }>
      browserNavigate: (url: string) => Promise<{ success: boolean; error?: string }>
      browserExecute: (script: string) => Promise<{ success: boolean; result?: unknown; error?: string }>
      browserScreenshot: () => Promise<{ success: boolean; path?: string; error?: string }>
      browserClose: () => Promise<{ success: boolean }>

      // Agent
      sendToAgent: (message: string) => Promise<void>
      setAgentModel: (config: { provider: string; model: string; apiKey: string; baseUrl: string; contextWindow: number; maxInputTokens: number; maxOutputTokens: number; supportsMultimodal: boolean; disableThinking?: boolean; thinkingControl?: 'qwen' | 'openai' | 'deepseek' | 'none' }) => Promise<void>
      /** 模型自测：返回「登记到 Pi / 端点连通 / Pi 可识别」三步的逐步结果 */
      testModel: (config: { provider: string; model: string; displayName?: string; apiKey?: string; baseUrl: string; contextWindow?: number; maxOutputTokens?: number; disableThinking?: boolean; thinkingControl?: 'qwen' | 'openai' | 'deepseek' | 'none' }) => Promise<{
        ok: boolean
        steps: { name: string; ok: boolean; detail: string }[]
      }>
      onAgentResponse: (callback: (data: string) => void) => () => void
      onAgentStatus: (callback: (status: AgentStatusEvent) => void) => () => void
      /** 真实 token 用量（API usage）：输入 / 输出 / 上限 / 速度 */
      onAgentUsage: (callback: (usage: {
        inputTokens: number
        outputTokens: number
        tokensPerSecond: number
        inputLimit: number
        contextWindow: number
        live: boolean
      }) => void) => () => void
      /** 流式增量：思考过程 / 正文 */
      onAgentStream: (callback: (delta: { type: 'reasoning' | 'content'; text: string }) => void) => () => void
      /** 每次文件改动推来的 diff */
      onAgentDiff: (callback: (diff: FileDiff) => void) => () => void
      /** Agent 用 ask_user 提问 */
      onAgentAsk: (callback: (ask: AgentAsk) => void) => () => void
      /** 回答 ask_user 的提问 */
      answerAgent: (id: string, answer: string) => Promise<{ success: boolean }>
      /** ctrl+左键跳转定义：优先 LSP 语义定义，拿不到再按名字扫工程（相对路径） */
      findSymbol: (name: string, at?: { filePath: string; line: number; column: number }) => Promise<SymbolHit[]>
      /** 中断当前执行 */
      interruptAgent: () => Promise<{ success: boolean }>
      /** 设置 Agent 的工作目录（跟随左侧资源管理器） */
      setAgentProjectDir: (dirPath: string) => Promise<{ success: boolean }>
      /** 同步已启用且已安装的 Skill（正文会注入到 Agent 系统提示词，真正影响其行为） */
      setAgentExtensions: (extensions: { id: string; name: string; description: string; content?: string }[]) => Promise<{ success: boolean }>
      /** 计划模式：开启后 Agent 只读不改，先出计划再动手 */
      setPlanMode: (enabled: boolean) => Promise<{ success: boolean; planMode: boolean }>
      /** Agent 自己切换计划模式（计划获批后自动退出），界面据此同步开关 */
      onAgentPlanMode: (callback: (enabled: boolean) => void) => () => void
      /** 护栏命中时是先弹卡问用户（true）还是直接拦下（false） */
      setRiskConfirm: (enabled: boolean) => Promise<{ success: boolean; askBeforeRisk: boolean }>
      /** 改完文件是否自动把诊断结果回灌给 Agent */
      setAutoDiagnostics: (enabled: boolean) => Promise<{ success: boolean; autoDiagnostics: boolean }>
      /** 把某个会话的历史灌回 Agent 上下文（切换会话 / 重启后恢复）。
       *  chatId 是聊天标签 id：Pi 后端按「目录 + 标签」对应一个 pi 会话 */
      loadAgentContext: (messages: { role: string; content: string }[], chatId?: string) => Promise<{ success: boolean }>
      /** Agent 的任务清单，界面实时展示进度 */
      onAgentTodos: (callback: (todos: AgentTodo[]) => void) => () => void
      /** 内置能力清单：已原生生效、不依赖 Pi 扩展的那些 */
      listBuiltins: () => Promise<BuiltinCapabilities>
      /** 改动检查点：列出 / 回退到某个快照 */
      listCheckpoints: () => Promise<Checkpoint[]>
      restoreCheckpoint: (sha?: string, removePaths?: string[]) => Promise<{
        ok: boolean
        sha?: string | null
        /** 一并删掉的「快照之后新建的文件」 */
        removed?: string[]
        error?: string
      }>
      /** Agent 每轮任务开始前打下的检查点（用于提示「改坏了能回退」） */
      onAgentCheckpoint: (callback: (cp: { sha: string; at: number }) => void) => () => void
      /** 编辑历史消息重跑前，把 Agent 的对话上下文退回那条消息之前。
       *  Pi 后端按 forkText / forkIndex 分叉会话，自研后端按 messages 整段替换 */
      rewindAgent: (payload: {
        messages?: { role: string; content: string }[]
        chatId?: string
        forkText?: string
        forkIndex?: number
      }) => Promise<{ ok: boolean; error?: string }>

      // Extensions（真实落盘，目录约定与 Pi 一致）
      /** 扫描已安装：skills 目录里的 Skill + Pi 包里的 Skill + pi CLI 认的包 */
      listExtensions: (projectDir?: string) => Promise<InstalledExtension[]>
      /** 可安装清单（含 installed 标记，状态取自 pi list） */
      extensionCatalog: () => Promise<ExtensionCatalogItem[]>
      /** 安装：交给内置的 pi CLI（`pi install`）。来源形如 npm:<包名> / git:<仓库地址> / <本地目录> */
      installExtension: (source: string) => Promise<{
        source: string
        ok: boolean
        error?: string
        /** pi 登记进包清单的 source */
        packages?: string[]
        /** 包里提供、本应用可以直接注入 Agent 的 skill 名 */
        skills?: string[]
        /** pi CLI 自己的输出，原样给用户看 */
        piOutput?: string
        /** 需要如实告知用户的提示，例如「该包含 Pi 原生扩展，本应用无法执行」 */
        warning?: string
      }>
      /** 卸载：Pi 包走 `pi remove`，手工放进 skills 目录的 Skill 删目录 */
      uninstallExtension: (id: string, projectDir?: string) => Promise<{ ok: boolean; error?: string }>
      /** 用系统文件管理器打开扩展目录 */
      openExtensionsDir: () => Promise<{ success: boolean; error?: string }>
      /** Pi 运行时状态：内置 / 用户自装 / 未找到 */
      piInfo: () => Promise<PiRuntimeInfo>
      /** 应用自身版本号（菜单栏「帮助 → 关于 Yu Code」显示用） */
      appVersion: () => Promise<string>

      // MCP：外部工具（自研客户端，stdio 子进程，不执行第三方扩展代码）
      /** 所有 server 的配置 + 连接状态 + 已发现的工具 */
      listMcpServers: () => Promise<McpServer[]>
      /** 新增一个 server，加完立即尝试连接 */
      addMcpServer: (server: { name: string; command: string; args?: string }) => Promise<{ ok: boolean; id?: string; error?: string }>
      removeMcpServer: (id: string) => Promise<{ ok: boolean; error?: string }>
      toggleMcpServer: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
      /** 不带 id 时重连全部启用的 server */
      refreshMcpServers: (id?: string) => Promise<{ ok: boolean; error?: string }>

      // File open (from OS context menu)
      onFileOpen: (callback: (filePath: string) => void) => () => void
      /** 右键文件夹「用 Yu Code 打开」传入的目录，作为工作区打开 */
      onFolderOpen: (callback: (dirPath: string) => void) => () => void
      /** 渲染进程监听注册完毕，通知主进程派发启动时待打开的路径 */
      notifyRendererReady: () => void
    }
  }
}
