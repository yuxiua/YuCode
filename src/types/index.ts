export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  status?: 'thinking' | 'editing' | 'searching' | 'done'
  attachments?: { name: string; type: string; url?: string }[]
  /** 这条消息触发的任务开始前的检查点 sha。编辑重跑时据此把代码退回这条消息之前 */
  checkpointSha?: string
  /** 执行过程数据（仅 assistant 消息） */
  process?: {
    events: ProcessEvent[]
    durationMs: number
  }
}

export interface AgentStatus {
  state:
    | 'idle'
    | 'thinking'
    | 'thinking_output'
    | 'reading'
    | 'editing'
    | 'searching'
    | 'web_searching'
    | 'web_fetching'
    | 'executing'
    | 'asking'
    | 'action'
    | 'tool'
    | 'notice'
    | 'tool_output'
    | 'tool_end'
    | 'done'
    | 'error'
    | 'interrupted'
  detail?: string
}

/** agent:status 事件：tool_output / tool_end 靠 toolCallId 回到时间线上的那一条 */
export interface AgentStatusEvent extends AgentStatus {
  toolCallId?: string
  toolName?: string
  isError?: boolean
  durationMs?: number
  noticeType?: 'info' | 'warning' | 'error'
}

/** 一次文件改动的差异，展示在过程时间线里 */
export interface FileDiff {
  /** 相对工作目录的路径 */
  filePath: string
  /** unified diff 文本，新建文件时为空 */
  patch: string
  added: number
  removed: number
  /** true = 这次是新创建的文件 */
  created: boolean
}

/** 过程时间线上的一个节点：思考 / 中途输出 / 通知 / 工具动作 / 文件改动 */
export interface ProcessEvent {
  kind: 'thinking' | 'text' | 'notice' | 'tool' | 'diff'
  /** thinking / text / notice 的内容 */
  text?: string
  /** notice 的级别 */
  noticeType?: 'info' | 'warning' | 'error'
  /** tool 的状态与详情 */
  state?: string
  detail?: string
  /** tool 的执行 id（pi 的 toolCallId）：实时输出与结束回填靠它对号 */
  ref?: string
  /** tool 的实时输出（长命令跑的时候的输出） */
  output?: string
  status?: 'running' | 'done' | 'error'
  durationMs?: number
  /** kind === 'diff' 时的改动详情 */
  diff?: FileDiff
}

/** Agent 通过 ask_user 抛出的问题，需要用户回答后才继续 */
export interface AgentAsk {
  id: string
  question: string
  options: string[]
}

/** ctrl+左键跳转定义命中的位置 */
export interface SymbolHit {
  /** 相对工作目录的路径 */
  file: string
  /** 1 起的行号 */
  line: number
  /** 0 起的列号 */
  column: number
}

/** 一次改动检查点（git 快照）。动手前系统自动打点，改坏了可整体回退 */
export interface Checkpoint {
  sha: string
  /** 打点时间（毫秒时间戳） */
  at: number
}

/**
 * 原生内置的能力项。
 * 与 Pi 扩展的区别：这些直接实现在自研 Agent 里，不依赖 pi CLI，打包即生效。
 */
export interface BuiltinCapability {
  id: string
  name: string
  description: string
  /** 固定为「内置」，用于和扩展列表区分 */
  source: string
}

/** 内置能力汇总（设置页展示） */
export interface BuiltinCapabilities {
  /** 当前是否处于计划模式（只读） */
  planMode: boolean
  /** 本轮任务开始前打下的检查点，没有则为 null */
  checkpoint: { sha: string; head: string; at: number } | null
  /** 护栏实际拦截的范围（人类可读的描述行） */
  guard: string[]
  items: BuiltinCapability[]
}

/** Agent 流式增量（思考过程 / 正文） */
export interface AgentStreamDelta {
  type: 'reasoning' | 'content'
  text: string
}

/** Agent 的任务清单项（todo_write 维护，界面实时展示进度） */
export interface AgentTodo {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

/**
 * 一个 MCP（Model Context Protocol）server 的配置与实时状态。
 * 本应用自带客户端，直接把外部 server 的工具注册给模型；不依赖 pi CLI。
 */
export interface McpServer {
  id: string
  name: string
  description: string
  /** 随应用内置（不能删除，只能禁用） */
  builtin: boolean
  enabled: boolean
  command: string
  args: string[]
  /** idle = 还没连 | connecting | ready | error */
  status: 'idle' | 'connecting' | 'ready' | 'error'
  /** 连接失败的原因，供设置页显示 */
  error: string
  /** 子进程输出的最后一段错误日志 */
  stderr: string
  tools: { name: string; raw: string; description: string }[]
}

export interface QueuedMessage {
  id: string
  content: string
  tabId: string
  attachments?: { name: string; type: string; url?: string }[]
}

export interface Model {
  id: string
  /** 显示名称（用户自定义，便于区分同款模型不同 key） */
  displayName: string
  /** 实际模型名（如 gpt-4o, claude-3-5-sonnet） */
  name: string
  provider: 'openai' | 'anthropic' | 'deepseek' | 'alibaba' | 'custom'
  apiKey?: string
  baseUrl?: string
  /** 上下文窗口大小 (tokens)，默认 200000 */
  contextWindow: number
  /** 最大输入 tokens */
  maxInputTokens: number
  /** 最大输出 tokens */
  maxOutputTokens: number
  /** 是否支持多模态 */
  supportsMultimodal: boolean
  /**
   * 关闭该模型的思考（推理）输出。
   * 部分网关（llama.cpp / vLLM 上的 Qwen 等）默认必定返回 reasoning_content，
   * 思考会挤占输出预算并拖慢整轮，勾上后登记给 Pi 时带上关闭参数。
   */
  disableThinking?: boolean
  /**
   * 关闭思考时用哪种控制方式（各家网关的写法互不相通）。
   * 只在 disableThinking 为真时有意义；不勾关闭思考时这一项不生效。
   */
  thinkingControl?: ThinkingControl
}

/** 模型自测的入参：只带登记与连通需要的字段 */
export interface ModelTestConfig {
  provider: string
  model: string
  displayName?: string
  apiKey?: string
  baseUrl: string
  contextWindow?: number
  maxOutputTokens?: number
  /** 与 Model.disableThinking 同义，自测时按同样的规则登记 */
  disableThinking?: boolean
  /** 与 Model.thinkingControl 同义 */
  thinkingControl?: ThinkingControl
}

/**
 * 「关闭思考」的控制方式，对应主进程 pi-agent-model.js 的 THINKING_CONTROL：
 * qwen = chat_template_kwargs（vLLM / llama.cpp），openai = reasoning_effort，
 * deepseek = 顶层 thinking，none = 只声明能力、不额外发关闭参数。
 */
export type ThinkingControl = 'qwen' | 'openai' | 'deepseek' | 'none'

/** 模型自测结果：三步依次是「登记到 Pi」「端点连通」「Pi 可识别」 */
export interface ModelTestReport {
  /** 界面里这次结果属于谁：表单固定用 'form'，已保存的模型用它的 id */
  id: string
  ok: boolean
  steps: { name: string; ok: boolean; detail: string }[]
}

export interface TokenUsage {
  /** 最近一次模型请求的输入 token 数（来自 API usage，约等于当前上下文占用） */
  inputTokens: number
  /** 最近一次模型请求的输出 token 数 */
  outputTokens: number
  /** 输入上限（上下文窗口内可用于输入的部分） */
  inputLimit: number
  /** 模型上下文窗口大小 */
  contextWindow: number
  /** 输出速度 (tokens/s) */
  tokensPerSecond: number
  /** 是否仍在流式输出（此时 token 数与速度是按字数估算的） */
  live: boolean
}

export interface Plugin {
  id: string
  name: string
  description: string
  enabled: boolean
  version: string
  /** 安装来源: local=本地预置, registry=从扩展市场安装 */
  source: 'local' | 'registry'
  /** 类别 */
  category: 'core' | 'enhancement' | 'creative'
}

/** 可安装清单里的一项（来自 ~/.pi/agent/extensions.catalog.json，可手工编辑扩充） */
export interface ExtensionCatalogItem {
  id: string
  /** 展示名（npm 包名 / 仓库名） */
  name: string
  /** 安装来源：npm:<包名> / git:<仓库地址> */
  source: string
  version: string
  description: string
  /** 是否提供 SKILL.md。含 skill 的包，其技能可单独启用 / 禁用 */
  hasSkills: boolean
  tags: string[]
  /** 是否已经装到本机（状态取自 `pi list` 与 settings.json） */
  installed: boolean
  /** 已装时是 pi 真正的落盘路径，未装为空串 */
  dir: string
}

/** 已安装的扩展：Skill 读自磁盘，Pi 包的状态读自 pi CLI */
export interface InstalledExtension {
  /** skill → global:<folder> / pkgskill:<source>:<name>；package → pkg:<pi 的 source> */
  id: string
  kind: 'skill' | 'package'
  name: string
  description: string
  /** skill 的正文（会注入 Agent 系统提示词）；Pi 包没有 */
  content?: string
  /** Pi 包的安装来源（pi install 用的那个 source） */
  source?: string
  scope: 'global' | 'project'
  /** 磁盘上的绝对路径 */
  dir: string
  /** 属于某个 Pi 包、不能单独卸载（卸载要连包一起 remove） */
  readonly?: boolean
  /** readonly 的技能所属的包名 */
  viaPackage?: string
}

/** Pi 运行时：随安装包内置、用户自装到 ~/.pi/agent/pi_engine，或 PATH 上的全局 pi */
export interface PiRuntimeInfo {
  available: boolean
  /** bundled = 随安装包内置；path = 用户全局安装；none = 没找到 */
  source: 'bundled' | 'path' | 'none'
  /** Pi 自身版本（PATH 安装的探测不到时为空） */
  version: string
  /** 运行 Pi 用的 Node 版本 */
  nodeVersion: string
  cliPath: string
  nodePath: string
}

export interface Skill {
  id: string
  name: string
  description: string
  enabled: boolean
  category: string
  source: 'builtin' | 'custom'
}

export interface TerminalSession {
  id: string
  title: string
  cwd: string
  pythonEnv?: string
}

export interface PythonEnv {
  name: string
  path: string
  version?: string
}

export interface Settings {
  activeModel: string
  models: Model[]
  plugins: Plugin[]
  skills: Skill[]
  pythonDefaultEnv: string
  theme: 'dark' | 'light'
}
