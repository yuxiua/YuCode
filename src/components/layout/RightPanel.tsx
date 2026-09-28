import { useState, useRef, useEffect, useCallback } from 'react'
import { useAppStore } from '../../stores/appStore'
import { storage } from '../../stores/persist'
import type { Message, Model, AgentStreamDelta, ProcessEvent, AgentAsk, AgentStatusEvent, FileDiff, AgentTodo, TokenUsage, QueuedMessage } from '../../types'
import type { AgentModelConfig } from '../../types/electron'
import Markdown from '../common/Markdown'
import ConfirmDialog from '../common/ConfirmDialog'
import AskUserCard from '../chat/AskUserCard'
import TodoPanel from '../chat/TodoPanel'
import { ProcessSection, RunningProcess } from '../chat/ProcessTimeline'
import { appendStatusEvent, isTimelineState } from '../chat/processTimelineModel'

interface ChatTab {
  id: string
  title: string
  messages: Message[]
  version: number
  /** 这个会话绑定用哪个模型。留空表示跟随窗口当前模型（新会话默认如此） */
  modelId?: string
}

/** 模型配置 → 下发给主进程做登记的载荷 */
function toModelPayload(m: Model): AgentModelConfig {
  return {
    provider: m.provider,
    model: m.name,
    apiKey: m.apiKey || '',
    baseUrl: m.baseUrl || '',
    contextWindow: m.contextWindow,
    maxInputTokens: m.maxInputTokens,
    maxOutputTokens: m.maxOutputTokens,
    supportsMultimodal: m.supportsMultimodal,
    disableThinking: m.disableThinking,
    thinkingControl: m.thinkingControl,
  }
}

/** 编辑历史消息重跑前的回退方案：代码退回哪、对话丢到哪、重跑什么 */
interface RevertPlan {
  /** 重跑用的新内容 */
  next: string
  /** 回退到的检查点；没有就不动已有文件，只清理新建文件 */
  sha?: string
  /** 这条之后新建的文件，回退时一并删掉 */
  removePaths: string[]
  /** 被丢弃那几轮里有没有文件改动 —— 没有检查点时用它决定要不要如实告诉用户「没退成」 */
  hasChanges: boolean
  /** 截断后的历史（不含被编辑的这条） */
  truncated: Message[]
  /** 交给 pi 分叉用的原问题文本与序号 */
  forkText: string
  forkIndex: number
}

// 会话按「工作目录」隔离存储：切换项目时互不干扰，重开同一个目录能接着上次聊。
const CHAT_TAB_KEY = (dir: string) => `pi-chat-tabs::${dir || '__default__'}`
const CHAT_ACTIVE_KEY = (dir: string) => `pi-chat-active-tab::${dir || '__default__'}`

interface ChatState {
  tabs: ChatTab[]
  activeTabId: string
}

const emptyChatState = (): ChatState => ({
  tabs: [{ id: '1', title: '新任务', messages: [], version: 1 }],
  activeTabId: '1',
})

// 读取某个工作目录的会话。只认当前目录的记录，不再回退旧版全局历史，
// 否则每次打开新目录都会看到遗留的测试会话。
function loadChatState(dir: string): ChatState {
  try {
    const saved = storage.getItem(CHAT_TAB_KEY(dir))
    if (saved) {
      const parsed = JSON.parse(saved) as ChatTab[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        return {
          tabs: parsed,
          activeTabId: storage.getItem(CHAT_ACTIVE_KEY(dir)) || parsed[0].id,
        }
      }
    }
  } catch { /* ignore */ }
  return emptyChatState()
}

/** 这几轮里 Agent 新建的文件。编辑重跑要回退时一并删掉，否则会残留成孤儿文件 */
function createdFilesIn(messages: Message[]): string[] {
  const paths = new Set<string>()
  for (const m of messages) {
    for (const ev of m.process?.events ?? []) {
      if (ev.kind === 'diff' && ev.diff?.created && ev.diff.filePath) paths.add(ev.diff.filePath)
    }
  }
  return [...paths]
}

/** 这几轮里有没有文件改动（含改已有文件，不只是新建） */
function hasFileChanges(messages: Message[]): boolean {
  return messages.some((m) => (m.process?.events ?? []).some((ev) => ev.kind === 'diff'))
}

/**
 * 一个会话的运行态。会话之间各存一份，所以同一窗口里多个会话可以同时跑、
 * 互不打扰（和 Trae 一致）：切到别的标签时，正在跑的那个继续在后台推进。
 * 放在 ref 里（不放进 React state）是因为事件回调来得又密又快，
 * 每来一个事件都整体重建对象代价太高；改完调 bump() 触发一次重渲染即可。
 */
interface TabRuntime {
  running: boolean
  status: AgentStatusEvent
  events: ProcessEvent[]
  liveContent: string
  todos: AgentTodo[]
  ask: AgentAsk | null
  usage: TokenUsage
  queue: QueuedMessage[]
  /** 本轮任务开始的时间戳，用来算耗时 */
  startedAt: number
  /** 新一轮推理开始时，思考内容要新开一张卡片，而不是接在上一张后面 */
  newThinking: boolean
}

const emptyRuntime = (): TabRuntime => ({
  running: false,
  status: { state: 'idle' },
  events: [],
  liveContent: '',
  todos: [],
  ask: null,
  usage: { inputTokens: 0, outputTokens: 0, inputLimit: 0, contextWindow: 0, tokensPerSecond: 0, live: false },
  queue: [],
  startedAt: 0,
  newThinking: false,
})

export default function RightPanel() {
  const {
    models, activeModelId, setActiveModel, setAgentStatus,
    currentDir, showNotice,
  } = useAppStore()
  // 只解析一次初始会话（loadChatState 带迁移副作用，不能重复调用）
  const chatInitRef = useRef<ChatState | null>(null)
  if (!chatInitRef.current) chatInitRef.current = loadChatState(currentDir)
  const [tabs, setTabs] = useState<ChatTab[]>(chatInitRef.current.tabs)
  const [activeTabId, setActiveTabId] = useState(chatInitRef.current.activeTabId)
  // tabs 里的会话属于哪个目录。切目录时它和 tabs 一起更新，
  // 用来避免「目录已换、会话还没换」的那一帧把旧会话灌进新目录。
  const [tabsDir, setTabsDir] = useState(currentDir)
  const [input, setInput] = useState('')
  const [showModelSelect, setShowModelSelect] = useState(false)
  const [showTaskSelect, setShowTaskSelect] = useState(false)
  const [editingMessage, setEditingMessage] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  // 待确认的回退：要还原文件、删新建文件，动手前先把影响讲清楚
  const [pendingRevert, setPendingRevert] = useState<RevertPlan | null>(null)
  const [attachments, setAttachments] = useState<{ name: string; type: string }[]>([])
  // 每个会话各自的运行态（过程时间线、流式正文、清单、提问、用量、队列）
  const runtimesRef = useRef<Map<string, TabRuntime>>(new Map())
  // runtime 是 mutable 的 ref，改完靠这个计数触发重渲染
  const [runtimeTick, setRuntimeTick] = useState(0)
  const bump = useCallback(() => setRuntimeTick((n) => n + 1), [])
  /** 取某个会话的运行态；没有就建一个空的 */
  const runtimeOf = useCallback((chatId: string): TabRuntime => {
    let rt = runtimesRef.current.get(chatId)
    if (!rt) {
      rt = emptyRuntime()
      runtimesRef.current.set(chatId, rt)
    }
    return rt
  }, [])
  const bottomRef = useRef<HTMLDivElement>(null)
  // 过程窗滚动容器：用来判断用户是否已经上拉离开底部
  const scrollRef = useRef<HTMLDivElement>(null)
  // 只有视图停留在底部时才自动跟随最新过程；用户上拉后暂停，避免过程不断刷新把历史顶走
  const autoFollowRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const modelSelectRef = useRef<HTMLDivElement>(null)
  const taskSelectRef = useRef<HTMLDivElement>(null)

  // 兜底：本地存储里的 activeTabId 可能失效（如历史数据不匹配），回退到第一个会话避免整页崩溃
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]
  // 会话绑定的模型优先；没绑（新会话）就跟随窗口当前模型。
  // 绑定的模型被删掉时逐级回退，避免拿到 undefined 让界面和 Agent 都失去模型。
  const activeModel =
    models.find((m) => m.id === (activeTab.modelId || activeModelId)) ??
    models.find((m) => m.id === activeModelId) ??
    models[0]
  const supportsMultimodal = activeModel?.supportsMultimodal ?? false
  // 当前显示的这个会话的运行态。切标签就是切它，别的会话照常在后台跑。
  const rt = runtimeOf(activeTab.id)
  const isRunning = rt.running

  // 持久化对话历史：写入「这些 tabs 所属」的工作目录，而不是当前目录，
  // 避免切换目录的那一帧把旧会话写进新目录。
  const loadedDirRef = useRef(currentDir)
  useEffect(() => {
    try {
      storage.setItem(CHAT_TAB_KEY(loadedDirRef.current), JSON.stringify(tabs))
      storage.setItem(CHAT_ACTIVE_KEY(loadedDirRef.current), activeTabId)
    } catch { /* ignore */ }
  }, [tabs, activeTabId])

  // 切换工作区：载入该目录的历史会话，并清掉上一目录残留的运行态
  useEffect(() => {
    if (loadedDirRef.current === currentDir) return
    loadedDirRef.current = currentDir
    const st = loadChatState(currentDir)
    setTabs(st.tabs)
    setActiveTabId(st.activeTabId)
    setTabsDir(currentDir)
    // 旧目录的会话已不再显示，其运行态一并丢弃（新目录的会话会重新建）
    runtimesRef.current.clear()
    bump()
  }, [currentDir, bump])

  // 会话切换 / 重启后，把该会话的历史灌回主进程里的 Agent 上下文。
  // 上下文在主进程、会话在前端，两边不同步就会出现「界面有历史、模型却失忆」，
  // 或者切个标签把上一个会话的内容串进来。
  // 只认「目录 + 会话 id」的组合变化：消息是在任务运行中不断追加的，
  // 跟着 messages 变化重灌会把 Agent 正在跑的上下文重置掉。
  const contextKeyRef = useRef('')
  useEffect(() => {
    // 目录刚切过、新目录的会话还没装进 tabs 的那一帧不做，否则会拿旧会话灌新目录
    if (tabsDir !== currentDir) return
    const key = `${currentDir}::${activeTabId}`
    if (contextKeyRef.current === key) return
    contextKeyRef.current = key
    // 这个会话正在后台跑：绝不能重灌上下文、也不能清它的运行态，
    // 否则切回来看一眼就会把它的进度冲掉（多会话并发的前提）。
    if (runtimeOf(activeTabId).running) return
    const msgs = (tabs.find((t) => t.id === activeTabId)?.messages ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    }))
    window.piAPI?.loadAgentContext?.(msgs, activeTabId)
    runtimeOf(activeTabId).todos = []
    bump()
  }, [currentDir, activeTabId, tabs, tabsDir, runtimeOf, bump])

  // 顶部状态条显示「当前这个会话」的状态。后台会话在跑不影响它 ——
  // 切过去才会看到那个会话的在跑状态（render 用 rt.status，这里只为 StatusBar 同步一份）。
  useEffect(() => {
    setAgentStatus(runtimesRef.current.get(activeTabId)?.status ?? { state: 'idle' })
  }, [activeTabId, runtimeTick, setAgentStatus])

  // Auto-resize textarea
  const autoResize = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    const maxH = 120 // 最大高度 120px (约5行)
    el.style.height = Math.min(el.scrollHeight, maxH) + 'px'
  }, [])

  useEffect(() => {
    autoResize()
  }, [input, autoResize])

  // 上拉（scrollTop 变小）就停掉自动跟随；重新滚回底部再恢复。
  // 只认「向上」这一个方向，程序化滚到底部时 scrollTop 只会变大，不会误判。
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    const scrolledUp = el.scrollTop < lastScrollTopRef.current - 2
    lastScrollTopRef.current = el.scrollTop
    if (atBottom) autoFollowRef.current = true
    else if (scrolledUp) autoFollowRef.current = false
  }, [])

  // 切换会话时回到最新位置
  useEffect(() => {
    autoFollowRef.current = true
    lastScrollTopRef.current = 0
  }, [activeTabId])

  useEffect(() => {
    if (!autoFollowRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeTab.id, activeTab.messages, rt.status, rt.events, rt.liveContent])

  // Close model dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelSelectRef.current && !modelSelectRef.current.contains(e.target as Node)) {
        setShowModelSelect(false)
      }
      if (taskSelectRef.current && !taskSelectRef.current.contains(e.target as Node)) {
        setShowTaskSelect(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const addTab = () => {
    const id = Date.now().toString()
    setTabs((prev) => [...prev, { id, title: '新任务', messages: [], version: 1 }])
    setActiveTabId(id)
  }

  const closeTab = (id: string) => {
    if (tabs.length <= 1) return
    // 关掉一个还在跑的会话：连它的 Agent 一起停掉，别留个看不见的任务在后台空转
    if (runtimeOf(id).running) {
      window.piAPI?.interruptAgent?.(id)
    }
    runtimesRef.current.delete(id)
    const newTabs = tabs.filter((t) => t.id !== id)
    setTabs(newTabs)
    if (activeTabId === id) setActiveTabId(newTabs[newTabs.length - 1].id)
    bump()
  }

  // 同步模型配置到 Electron Agent。
  // 依赖不能只看 activeModelId：模型详情（地址、密钥、上下文）是就地编辑的，
  // 只改详情时 id 不变，以前那样就不会重新推送 —— pi 那边的登记还停在上一次的值。
  // 所以把参与登记的几个字段拼成一个签名，任一变化都重新同步。
  //
  // 只下发到「当前这个会话」（带 chatId）：会话之间可以各用各的模型，
  // 切一次模型不该把别的会话正在用的模型一起改掉。
  const modelSignature = activeModel
    ? [
      activeModel.provider, activeModel.name, activeModel.apiKey || '', activeModel.baseUrl || '',
      activeModel.contextWindow, activeModel.maxInputTokens, activeModel.maxOutputTokens,
      activeModel.supportsMultimodal, activeModel.disableThinking, activeModel.thinkingControl,
    ].join('\u0000')
    : ''

  useEffect(() => {
    if (!window.piAPI || !activeModel) return
    window.piAPI.setAgentModel(toModelPayload(activeModel), activeTab.id)
  }, [modelSignature, activeTab.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Electron 模式下监听 agent 响应和状态
  const isElectron = typeof window !== 'undefined' && !!window.piAPI
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  // tabs / handleSend 的最新值。事件回调、队列消费都可能在若干次渲染之后才触发，
  // 直接闭包捕获会拿到旧值，这里用 ref 取最新的。
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  /**
   * 某个会话实际该用哪个模型：绑了就用绑的，没绑用窗口当前模型。
   * 每次发消息都按它把模型下发一遍 —— 会话的模型以「发消息那一刻」为准，
   * 这样即便中途在设置里改过模型详情，也不会出现某会话还在用旧配置。
   */
  const modelForTab = (tabId: string): Model | undefined => {
    const id = tabsRef.current.find((t) => t.id === tabId)?.modelId || activeModelId
    return models.find((m) => m.id === id) ?? models.find((m) => m.id === activeModelId) ?? models[0]
  }
  const handleSendRef = useRef<(text?: string, chatId?: string, atts?: QueuedMessage['attachments']) => void>(() => {})
  const processQueueRef = useRef<(chatId: string) => void>(() => {})
  // 事件没带 chatId 时的兜底：当作当前显示的会话
  const cidOf = (chatId?: string) => chatId || activeTabIdRef.current

  useEffect(() => {
    if (!isElectron) return
    let cleanupResp: (() => void) | undefined
    let cleanupStatus: (() => void) | undefined
    let cleanupStream: (() => void) | undefined
    let cleanupDiff: (() => void) | undefined
    let cleanupAsk: (() => void) | undefined
    let cleanupCheckpoint: (() => void) | undefined
    let cleanupTodos: (() => void) | undefined
    let cleanupPlanMode: (() => void) | undefined
    let cleanupUsage: (() => void) | undefined
    let cleanupModelFix: (() => void) | undefined

    // 任务清单：Agent 每推进一步就推一次，界面据此显示进度
    cleanupTodos = window.piAPI!.onAgentTodos((list, chatId) => {
      runtimeOf(cidOf(chatId)).todos = Array.isArray(list) ? list : []
      bump()
    })

    // 每轮任务开始前的检查点：挂到本轮的用户消息上 ——
    // 编辑那条消息重跑时，据此把代码退回它之前
    cleanupCheckpoint = window.piAPI!.onAgentCheckpoint((cp, chatId) => {
      if (!cp || !cp.sha) return
      const tabId = cidOf(chatId)
      setTabs((prev) => prev.map((t) => {
        if (t.id !== tabId) return t
        const at = t.messages.map((m) => m.role).lastIndexOf('user')
        if (at === -1 || t.messages[at].checkpointSha) return t
        const messages = t.messages.slice()
        messages[at] = { ...messages[at], checkpointSha: cp.sha }
        return { ...t, messages }
      }))
    })

    // 流式增量：思考过程累积成「思考卡片」，正文逐字追加展示
    cleanupStream = window.piAPI!.onAgentStream((delta: AgentStreamDelta, chatId) => {
      if (!delta || !delta.text) return
      const r = runtimeOf(cidOf(chatId))
      if (delta.type === 'reasoning') {
        const last = r.events[r.events.length - 1]
        if (!r.newThinking && last && last.kind === 'thinking') {
          r.events = [...r.events.slice(0, -1), { ...last, text: (last.text || '') + delta.text }]
        } else {
          r.newThinking = false
          r.events = [...r.events, { kind: 'thinking', text: delta.text }]
        }
      } else if (delta.type === 'content') {
        r.liveContent += delta.text
      }
      bump()
    })

    // 文件改动：把 diff 记进时间线，做完这步才看得到 AI 到底改了什么
    cleanupDiff = window.piAPI!.onAgentDiff((diff: FileDiff, chatId) => {
      if (!diff || !diff.filePath) return
      const r = runtimeOf(cidOf(chatId))
      r.events = [...r.events, { kind: 'diff', diff }]
      r.newThinking = true
      bump()
      // 这个文件要是正开在编辑器里，得把磁盘上的新内容刷进去 ——
      // 否则用户盯着旧内容，会以为 Agent 没改到地方。
      void useAppStore.getState().syncOpenFile(diff.filePath)
    })

    // ask_user：停在输入框上方等用户回答，回答后 Agent 才继续
    cleanupAsk = window.piAPI!.onAgentAsk((ask: AgentAsk, chatId) => {
      if (!ask || !ask.id) return
      runtimeOf(cidOf(chatId)).ask = ask
      bump()
    })

    // Agent 自己退出计划模式（计划获批）时同步开关。
    // 这里只改本地状态、不回推 IPC —— 回推会形成 setPlanMode 的来回死循环。
    // 计划模式是窗口级开关（不按会话区分），所以忽略 chatId。
    cleanupPlanMode = window.piAPI!.onAgentPlanMode((enabled: boolean) => {
      if (useAppStore.getState().planMode !== enabled) {
        useAppStore.setState({ planMode: enabled })
      }
    })

    // 真实 token 用量：Agent 每轮请求从 API 的 usage 里取，直接显示，不再模拟
    cleanupUsage = window.piAPI!.onAgentUsage((u, chatId) => {
      runtimeOf(cidOf(chatId)).usage = {
        inputTokens: u.inputTokens || 0,
        outputTokens: u.outputTokens || 0,
        inputLimit: u.inputLimit || 0,
        contextWindow: u.contextWindow || 0,
        tokensPerSecond: u.tokensPerSecond || 0,
        live: Boolean(u.live),
      }
      bump()
    })

    // 服务端报错说出了真实的上下文上限（配置的 200000，实际 60160）：
    // 把 store 里的模型配置改过来并持久化，否则下一条消息又会带着旧值覆盖回去。
    // 匹配用 provider + name + baseUrl 三元组 —— 这正是 AgentModelConfig 的身份。
    cleanupModelFix = window.piAPI!.onModelCorrected((fix) => {
      if (!fix || !fix.contextWindow) return
      const store = useAppStore.getState()
      const target = store.models.find((m) =>
        m.provider === fix.provider
        && m.name === fix.model
        && (m.baseUrl || '') === (fix.baseUrl || '')
      )
      if (!target || target.contextWindow === fix.contextWindow) return
      const patch: Partial<Model> = { contextWindow: fix.contextWindow }
      if (fix.maxInputTokens && target.maxInputTokens) patch.maxInputTokens = fix.maxInputTokens
      store.updateModel(target.id, patch)
      showNotice(`「${target.displayName || target.name}」上下文上限已纠正为 ${fix.contextWindow} tokens`)
    })

    cleanupStatus = window.piAPI!.onAgentStatus((status, chatId) => {
      if (status.state === 'idle') return
      const r = runtimeOf(cidOf(chatId))
      // 任务被中断时挂起的提问已经作废，把卡片收掉，否则会一直停在那里
      if (status.state === 'interrupted') r.ask = null
      // 新一轮开始：本轮正文要重新累积
      if (status.state === 'thinking' || status.state === 'thinking_output') r.liveContent = ''
      // 过程记录：工具动作、提问、清单更新、扩展通知、长命令的实时输出都进时间线；
      // tool_output / tool_end 不是新动作，只是回填在跑的那一条，由 appendStatusEvent 处理
      r.events = appendStatusEvent(r.events, status)
      // 工具动作之后模型的推理要新开一张思考卡，不能接在动作之前那一段后面
      if (isTimelineState(status.state) || status.state === 'thinking_output' || status.state === 'notice') {
        r.newThinking = true
      }
      // 只进时间线、不代表当前状态的事件不动状态条
      if (status.state !== 'tool_output' && status.state !== 'tool_end' && status.state !== 'notice') {
        r.status = { state: status.state, detail: status.detail }
      }
      bump()
    })

    cleanupResp = window.piAPI!.onAgentResponse((data: string, chatId) => {
      const tabId = cidOf(chatId)
      const r = runtimeOf(tabId)
      const durationMs = r.startedAt ? Date.now() - r.startedAt : 0
      const events = r.events
      const response: Message = {
        id: Date.now().toString(),
        role: 'assistant',
        content: data,
        timestamp: Date.now(),
        status: 'done',
        process: events.length > 0 ? { events, durationMs } : undefined,
      }
      setTabs((prev) => prev.map((t) =>
        t.id === tabId
          ? { ...t, messages: [...t.messages, response] }
          : t
      ))
      // 重置这个会话的运行态
      r.events = []
      r.liveContent = ''
      r.newThinking = false
      r.ask = null
      r.status = { state: 'done' }
      bump()
      setTimeout(() => {
        r.status = { state: 'idle' }
        r.running = false
        bump()
        // 这个会话自己排的队，下一棒交给它自己（不打扰别的会话）
        processQueueRef.current(tabId)
      }, 300)
    })

    return () => {
      cleanupResp?.()
      cleanupStatus?.()
      cleanupStream?.()
      cleanupDiff?.()
      cleanupAsk?.()
      cleanupCheckpoint?.()
      cleanupTodos?.()
      cleanupPlanMode?.()
      cleanupUsage?.()
      cleanupModelFix?.()
    }
  }, [isElectron, runtimeOf, bump]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = async (
    overrideText?: string,
    targetChatId?: string,
    overrideAttachments?: QueuedMessage['attachments'],
  ) => {
    const tabId = targetChatId || activeTabId
    const isActive = tabId === activeTabId
    // 只有「从当前输入框直接发」才动输入框；处理队列消息时输入框属于别的会话，不能碰
    const raw = (overrideText ?? (isActive ? input : '')).trim()
    // 队列里的消息自带附件；直接发送用输入框里的附件
    const sendAttachments = overrideAttachments ?? (overrideText ? undefined : attachments)
    if (!raw) return

    // 没打开工作区就发任务：Agent 的文件工具、检查点、会话隔离都挂在「工作目录」上，
    // 目录为空时它们会落到应用自身的工作目录去，读写的根本不是用户想要的项目。
    // 直接拦下并引导用户先打开文件夹，别让他看到一堆莫名其妙的报错。
    if (!currentDir) {
      showNotice('未打开工作区：请先在左侧「资源管理器」打开一个文件夹，再发起任务')
      return
    }

    if (isActive && overrideText === undefined) {
      setInput('')
      setAttachments([])
    }

    const r = runtimeOf(tabId)

    // 自动命名任务：首次发送时用内容摘要命名
    const tab = tabsRef.current.find((t) => t.id === tabId)
    if (tab && tab.messages.length === 0) {
      const name = raw.length > 20 ? raw.slice(0, 20) + '…' : raw
      setTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, title: name } : t))
    }

    // 这个会话已经在跑：排进它自己的队列，等它本轮结束再发（别的会话不受影响）
    if (r.running) {
      r.queue = [...r.queue, { id: Date.now().toString(), content: raw, tabId, attachments: sendAttachments }]
      bump()
      return
    }

    r.running = true
    r.startedAt = Date.now()
    r.liveContent = ''
    r.newThinking = false
    r.usage = { ...r.usage, inputTokens: 0, outputTokens: 0, tokensPerSecond: 0, live: false }
    // 自己发了新任务：无论之前停在哪段历史，都回到最新
    if (isActive) autoFollowRef.current = true

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: raw,
      timestamp: Date.now(),
      attachments: sendAttachments,
    }

    setTabs((prev) => prev.map((t) =>
      t.id === tabId ? { ...t, messages: [...t.messages, userMsg] } : t
    ))

    // Electron 模式：调用真实 agent
    if (isElectron) {
      r.events = []
      r.status = { state: 'thinking', detail: '正在调用模型...' }
      bump()
      try {
        // 模型随消息一起带上：按这个会话绑定的模型跑，
        // 同一窗口里 A 会话用 A 模型、B 会话用 B 模型互不影响。
        const boundModel = modelForTab(tabId)
        await window.piAPI!.sendToAgent(raw, tabId, boundModel ? toModelPayload(boundModel) : undefined)
        // 响应通过 onAgentResponse 回调处理
      } catch (err) {
        const errMsg: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: `调用失败: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
          status: 'done',
        }
        setTabs((prev) => prev.map((t) =>
          t.id === tabId ? { ...t, messages: [...t.messages, errMsg] } : t
        ))
        r.status = { state: 'idle' }
        r.running = false
        bump()
      }
      return
    }

    // 浏览器模式（无 Electron）：直接调用 API
    const controller = new AbortController()
    abortRef.current = controller

    const tabModel = modelForTab(tabId)
    if (!tabModel) {
      r.status = { state: 'idle' }
      r.running = false
      bump()
      return
    }

    r.events = []
    r.status = { state: 'thinking', detail: '调用模型...' }
    bump()
    try {
      // 浏览器模式走 Vite 代理避免 CORS
      const apiUrl = `/api-proxy/chat/completions`
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tabModel.apiKey}`,
        },
        body: JSON.stringify({
          model: tabModel.name,
          messages: [{ role: 'user', content: raw }],
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
      const data = await res.json()
      const content = data.choices?.[0]?.message?.content || '(无回复)'
      const response: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
        status: 'done',
      }
      setTabs((prev) => prev.map((t) =>
        t.id === tabId ? { ...t, messages: [...t.messages, response] } : t
      ))
      r.usage = {
        inputTokens: data.usage?.prompt_tokens || data.usage?.total_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        inputLimit: tabModel.maxInputTokens || tabModel.contextWindow || 0,
        contextWindow: tabModel.contextWindow || 0,
        tokensPerSecond: 0,
        live: false,
      }
    } catch (err) {
      const errMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `调用失败: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
        status: 'done',
      }
      setTabs((prev) => prev.map((t) =>
        t.id === tabId ? { ...t, messages: [...t.messages, errMsg] } : t
      ))
    }
    r.status = { state: 'idle' }
    r.running = false
    bump()
    processQueue(tabId)
  }
  handleSendRef.current = handleSend

  // 中断当前显示的会话（后台会话不受影响）
  const handleInterrupt = async () => {
    try {
      await window.piAPI?.interruptAgent?.(activeTabId)
    } catch { /* 忽略中断异常 */ }
  }

  // 回答 ask_user 的提问：回填给 Agent（它会接着往下跑），并把这次问答记进时间线
  const handleAnswer = async (answer: string) => {
    const r = runtimeOf(activeTabId)
    const ask = r.ask
    if (!ask) return
    r.ask = null
    r.events = [...r.events, { kind: 'text', text: `已回答：${answer}` }]
    bump()
    try {
      await window.piAPI?.answerAgent?.(ask.id, answer, activeTabId)
    } catch { /* 回填失败时，Agent 会在中断或结束时自行放行 */ }
  }

  // 消费某个会话自己的队列：一个会话跑完，接着跑它自己排的下一条。
  // 队列按会话隔离，所以一个会话在排队不会挡住别的会话。
  const processQueue = (chatId: string) => {
    const r = runtimeOf(chatId)
    if (r.queue.length === 0 || r.running) return
    const next = r.queue[0]
    r.queue = r.queue.slice(1)
    bump()
    handleSendRef.current(next.content, chatId, next.attachments)
  }
  processQueueRef.current = processQueue

  const clearQueue = (chatId: string) => {
    runtimeOf(chatId).queue = []
    bump()
  }

  const removeQueued = (chatId: string, id: string) => {
    const r = runtimeOf(chatId)
    r.queue = r.queue.filter((q) => q.id !== id)
    bump()
  }

  const handleEditMessage = (msg: Message) => {
    if (msg.role !== 'user') return
    setEditingMessage(msg.id)
    setEditContent(msg.content)
  }

  /**
   * 旧记录没挂 checkpointSha（这个功能上线前聊出来的会话）：按消息时间就近找一个检查点。
   * 检查点是发起这条消息的任务时打下的，时间上紧跟在消息之后，所以取时间差最小的一个。
   */
  const checkpointNear = async (timestamp: number): Promise<string | undefined> => {
    try {
      const list = await window.piAPI?.listCheckpoints?.()
      if (!Array.isArray(list)) return undefined
      let best: { sha: string; gap: number } | null = null
      for (const cp of list) {
        const gap = Math.abs((cp.at || 0) - timestamp)
        if (gap > 120000) continue
        if (!best || gap < best.gap) best = { sha: cp.sha, gap }
      }
      return best?.sha
    } catch { return undefined }
  }

  /**
   * 编辑历史消息重跑前，把工作区和对话一起退回这条消息之前（对齐 Devin / Trae）。
   * 代码：用这条消息对应的检查点还原，并删掉被丢弃那几轮新建的文件。
   * 对话：交给主进程 —— pi 从这条消息分叉，自研引擎整段替换上下文。
   * 回退是破坏性的（文件改动不可逆），所以每一步的结果都要如实告诉用户。
   */
  const revertToMessage = async (plan: RevertPlan) => {
    const notes: string[] = []
    if (plan.sha || plan.removePaths.length > 0) {
      try {
        const res = await window.piAPI?.restoreCheckpoint?.(plan.sha, plan.removePaths)
        if (res?.ok) {
          notes.push(plan.sha ? '代码已回退到这条消息之前' : '这条消息没有检查点，只清理了它之后新建的文件')
          if (res.removed?.length) notes.push(`删掉 ${res.removed.length} 个新建文件`)
          // 回退是直接改磁盘，不会走 diff 事件，开着的文件得手动刷一遍
          const store = useAppStore.getState()
          await Promise.all(store.openFiles.map((f) => store.syncOpenFile(f.path)))
        } else {
          notes.push(`代码回退失败：${res?.error || '未知原因'}`)
        }
      } catch (e) {
        notes.push(`代码回退失败：${e instanceof Error ? e.message : String(e)}`)
      }
    } else if (plan.hasChanges) {
      // 没有检查点、也没有新建文件可删，等于一点没退。这种「静默失败」必须说出来，
      // 否则用户会以为自己已经把改动撤掉了。
      notes.push('这条消息没有对应检查点，被丢弃那几轮的代码改动没能回退')
    }
    try {
      const res = await window.piAPI?.rewindAgent?.({
        messages: plan.truncated.map((m) => ({ role: m.role, content: m.content })),
        chatId: activeTabId,
        forkText: plan.forkText,
        forkIndex: plan.forkIndex,
      })
      if (res && res.ok === false) notes.push(`对话上下文没能回退（${res.error}）`)
    } catch { /* 上下文退不回去，最坏就是模型多记得几轮 */ }
    if (notes.length > 0) showNotice(notes.join('；'))
  }

  /** 回退完成后：历史截断到这条消息之前，再用新内容重跑 */
  const runRevertPlan = async (plan: RevertPlan) => {
    await revertToMessage(plan)
    setTabs((prev) => prev.map((t) =>
      t.id === activeTabId
        ? { ...t, messages: plan.truncated, version: t.version + 1 }
        : t
    ))
    handleSend(plan.next)
  }

  const handleConfirmEdit = async () => {
    if (!editingMessage) return
    const msgIdx = activeTab.messages.findIndex((m) => m.id === editingMessage)
    if (msgIdx === -1) return

    const next = editContent.trim()
    // 内容清空了就当作取消：不能先把后面的对话截掉，再什么都不发
    if (!next) {
      setEditingMessage(null)
      return
    }

    const edited = activeTab.messages[msgIdx]
    // 被丢弃的是这条之后的所有轮次（含这条自己的回复），它们产生的改动都要回退
    const discarded = activeTab.messages.slice(msgIdx + 1)
    // 只截断到这一条之前，编辑后的这条交给 handleSend 追加 ——
    // 这里再 push 一次的话，同一个问题会出现两条。
    const truncated = activeTab.messages.slice(0, msgIdx)
    const removePaths = createdFilesIn(discarded)
    setEditingMessage(null)

    const hasChanges = hasFileChanges(discarded)
    const sha = edited.checkpointSha || await checkpointNear(edited.timestamp)
    const plan: RevertPlan = {
      next, sha, removePaths, hasChanges, truncated,
      forkText: edited.content,
      forkIndex: truncated.filter((m) => m.role === 'user').length,
    }

    // 这条之后动过文件就拦一下：还原会覆盖改动、删文件，得先讲清楚。
    // 没有检查点也要拦 —— 那意味着改过的文件还原不了，用户有权先知道再决定。
    if (sha || removePaths.length > 0 || hasChanges) {
      setPendingRevert(plan)
      return
    }
    await runRevertPlan(plan)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleFileUpload = () => {
    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    // 多模态模型支持图片，纯文本模型只支持文件
    fileInput.accept = supportsMultimodal
      ? 'image/*,.txt,.md,.json,.csv,.py,.ts,.js,.tsx,.html,.css'
      : '.txt,.md,.json,.csv,.py,.ts,.js,.tsx,.html,.css'
    fileInput.multiple = true
    fileInput.onchange = () => {
      if (fileInput.files?.length) {
        const newFiles = Array.from(fileInput.files).map((f) => ({
          name: f.name,
          type: f.type.startsWith('image/') ? 'image' : 'file',
        }))
        setAttachments((prev) => [...prev, ...newFiles])
      }
    }
    fileInput.click()
  }

  // 上下文占用比例：分子是 API 报的真实 prompt_tokens（不是本地估算），
  // 分母优先用输入上限（maxInputTokens 比 contextWindow 更贴近真实可用量）
  const ctxLimit = rt.usage.inputLimit || activeModel?.maxInputTokens || activeModel?.contextWindow || 0
  const ctxPct = ctxLimit > 0 ? Math.min(100, Math.round((rt.usage.inputTokens / ctxLimit) * 100)) : 0

  return (
    <div className="h-full flex flex-col bg-pi-bg overflow-hidden">
      {/* Task bar */}
      <div className="h-9 flex items-center border-b border-pi-border bg-pi-surface shrink-0 px-2 gap-1">
        <span className="text-[11px] text-pi-text truncate flex-1 select-none">
          {activeTab.title}
          {activeTab.version > 1 && (
            <span className="text-[9px] px-1 rounded bg-pi-accent/10 text-pi-accent ml-1.5">v{activeTab.version}</span>
          )}
        </span>
        <button
          onClick={addTab}
          className="w-6 h-6 flex items-center justify-center text-pi-text-muted hover:text-pi-accent text-sm shrink-0 rounded hover:bg-pi-hover"
          title="新建任务"
        >
          +
        </button>
        {/* Clock icon - task history dropdown */}
        <div className="relative shrink-0" ref={taskSelectRef}>
          <button
            onClick={() => setShowTaskSelect(!showTaskSelect)}
            className="w-6 h-6 flex items-center justify-center text-pi-text-dim hover:text-pi-accent rounded hover:bg-pi-hover"
            title="历史任务"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="8" cy="8" r="6.5" />
              <path d="M8 4.5V8l2.5 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {showTaskSelect && (
            <div className="absolute top-full right-0 mt-1 w-56 bg-pi-surface border border-pi-border rounded-lg shadow-xl py-1 z-50 max-h-60 overflow-y-auto">
              {tabs.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-pi-text-dim">暂无任务</div>
              ) : [...tabs].reverse().map((tab) => (
                <div key={tab.id} className="group/task flex items-center">
                  <button
                    onClick={() => { setActiveTabId(tab.id); setShowTaskSelect(false) }}
                    className={`flex-1 text-left px-3 py-1.5 text-[11px] hover:bg-pi-hover truncate ${
                      activeTabId === tab.id ? 'text-pi-accent' : 'text-pi-text'
                    }`}
                  >
                    {tab.title}
                    {runtimeOf(tab.id).running && (
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-pi-accent pulse-dot ml-1.5 align-middle" title="正在运行" />
                    )}
                    {tab.messages.length > 0 && <span className="text-pi-text-dim ml-1.5">({tab.messages.length})</span>}
                  </button>
                  {tabs.length > 1 && (
                    <button
                      onClick={() => closeTab(tab.id)}
                      className="opacity-0 group-hover/task:opacity-100 px-2 text-[10px] text-pi-text-dim hover:text-red-400"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 py-3">
        {activeTab.messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <div className="w-12 h-12 rounded-xl bg-pi-accent/10 flex items-center justify-center mb-3">
              <span className="text-lg text-pi-accent font-bold">Yu</span>
            </div>
            <p className="text-xs text-pi-text-muted">开始新任务</p>
            <p className="text-[10px] text-pi-text-dim mt-1">描述需求，我来帮你完成</p>
          </div>
        ) : (
          <div className="space-y-3">
            {activeTab.messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isEditable={msg.role === 'user' && !isRunning}
                onEdit={handleEditMessage}
                isEditing={editingMessage === msg.id}
                editContent={editContent}
                setEditContent={setEditContent}
                onConfirmEdit={handleConfirmEdit}
                onCancelEdit={() => setEditingMessage(null)}
              />
            ))}
            {isRunning && rt.status.state !== 'done' && rt.status.state !== 'idle' && (
              <RunningProcess
                status={rt.status}
                events={rt.events}
                liveContent={rt.liveContent}
              />
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Queue display：只显示当前会话自己的排队（各会话队列互相独立） */}
      {rt.queue.length > 0 && (
        <div className="border-t border-pi-border bg-pi-surface/50 px-3 py-2 shrink-0 max-h-24 overflow-y-auto">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-medium text-pi-text-muted">排队中 ({rt.queue.length})</span>
            <button
              onClick={() => clearQueue(activeTab.id)}
              className="text-[9px] text-pi-text-dim hover:text-red-400"
            >
              清空
            </button>
          </div>
          {rt.queue.map((q, idx) => (
            <div key={q.id} className="flex items-center gap-2 py-0.5 group/queue">
              <span className="text-[9px] text-pi-text-dim w-4">{idx + 1}.</span>
              <span className="text-[11px] text-pi-text-muted truncate flex-1">{q.content}</span>
              <button
                onClick={() => removeQueued(activeTab.id, q.id)}
                className="text-[9px] text-pi-text-dim opacity-0 group-hover/queue:opacity-100 hover:text-red-400"
              >
                移除
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 任务清单：多步任务的进度，先于提问显示，用户一眼看到还剩几件 */}
      <TodoPanel todos={rt.todos} />

      {/* ask_user 的提问：Agent 正卡在等这个回答，钉在输入框上方避免被忽略 */}
      {rt.ask && <AskUserCard ask={rt.ask} onAnswer={handleAnswer} />}

      {/* Input area */}
      <div className="border-t border-pi-border p-2.5 pt-1.5 shrink-0">
        {/* 真实用量：输入 / 输出 / 上下文占用 / 速度，来自 API 的 usage */}
        <UsageLine usage={rt.usage} />

        {/* Attachment preview */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2 px-1">
            {attachments.map((att, i) => (
              <span key={i} className="flex items-center gap-1 px-2 py-0.5 bg-pi-surface border border-pi-border rounded-full text-[10px] text-pi-text">
                {att.type === 'image' ? '🖼️' : '📄'} {att.name}
                <button onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  className="text-pi-text-dim hover:text-red-400">×</button>
              </span>
            ))}
          </div>
        )}

        <div className="relative bg-pi-surface border border-pi-border rounded-xl focus-within:border-pi-accent/40 transition-colors">
          {/* Auto-resize textarea */}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? '正在执行...发送将加入队列' : '描述你的需求...'}
            rows={1}
            className="w-full bg-transparent text-[13px] resize-none outline-none placeholder:text-pi-text-dim px-4 pt-3 pb-1 leading-relaxed"
            style={{ minHeight: '40px', maxHeight: '120px' }}
          />

          {/* Bottom bar */}
          <div className="flex items-center justify-between px-3 pb-2.5">
            {/* Left: upload + model selector + context ring */}
            <div className="flex items-center gap-2">
              {/* Upload button */}
              <button
                onClick={handleFileUpload}
                className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${
                  supportsMultimodal
                    ? 'text-pi-text-muted hover:text-pi-text hover:bg-pi-hover'
                    : 'text-pi-text-dim hover:text-pi-text-muted hover:bg-pi-hover/50'
                }`}
                title={supportsMultimodal ? '上传图片/文件' : '上传文件 (当前模型仅支持文本)'}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>

              {/* Model selector */}
              <div className="relative" ref={modelSelectRef}>
                <button
                  onClick={() => setShowModelSelect(!showModelSelect)}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-pi-text-muted hover:text-pi-text hover:bg-pi-hover transition-colors"
                >
                  <span className="max-w-[120px] truncate">{activeModel?.displayName || '选择模型'}</span>
                  {!supportsMultimodal && activeModel && (
                    <span className="text-[8px] px-1 py-px rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">纯文本</span>
                  )}
                  {supportsMultimodal && activeModel && (
                    <span className="text-[8px] px-1 py-px rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">多模态</span>
                  )}
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="opacity-60">
                    <path d="M2 4L5 7L8 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
                {showModelSelect && (
                  <div className="absolute bottom-full left-0 mb-1 w-48 bg-pi-surface border border-pi-border rounded-lg shadow-xl py-1 z-50">
                    {models.length === 0 && (
                      <div className="px-3 py-2 text-[11px] text-pi-text-dim">
                        暂无模型，请在设置中添加
                      </div>
                    )}
                    {models.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => {
                          // 绑定到「当前这个会话」，别的会话用什么模型不受影响
                          setTabs((prev) => prev.map((t) => t.id === activeTabId ? { ...t, modelId: m.id } : t))
                          // 同时作为窗口默认：新会话不选就用它（想各用各的，再逐个改即可）
                          setActiveModel(m.id)
                          setShowModelSelect(false)
                        }}
                        className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-pi-hover transition-colors ${
                          activeModel?.id === m.id ? 'text-pi-accent' : 'text-pi-text'
                        }`}
                      >
                        {m.displayName}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Context ring：上下文占比只看这个环 */}
              {activeModel && <ContextRing percentage={ctxPct} />}
            </div>

            {/* Right: running indicator or send */}
            {isRunning ? (
              <button
                onClick={handleInterrupt}
                title="停止本次执行"
                className="group/stop w-7 h-7 rounded-lg flex items-center justify-center bg-pi-accent/10 hover:bg-red-500/20 border border-transparent hover:border-red-500/40 transition-colors cursor-pointer"
              >
                {/* 默认显示脉冲点，hover 时变成停止方块，提示可点击中断 */}
                <div className="flex gap-0.5 group-hover/stop:hidden">
                  <span className="w-1 h-1 rounded-full bg-pi-accent pulse-dot" />
                  <span className="w-1 h-1 rounded-full bg-pi-accent pulse-dot" style={{ animationDelay: '0.2s' }} />
                  <span className="w-1 h-1 rounded-full bg-pi-accent pulse-dot" style={{ animationDelay: '0.4s' }} />
                </div>
                <span className="hidden group-hover/stop:block w-2.5 h-2.5 rounded-sm bg-red-400" />
              </button>
            ) : (
              <button
                onClick={() => handleSend()}
                disabled={!input.trim()}
                className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all ${
                  input.trim()
                    ? 'bg-pi-accent text-pi-bg hover:bg-pi-accent-dim'
                    : 'bg-pi-border text-pi-text-dim cursor-not-allowed'
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 12V2M3 6l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 回退确认：要还原文件、要删新建文件、要丢对话，动手前先讲清楚 */}
      <ConfirmDialog
        open={!!pendingRevert}
        danger
        title="回退代码并重跑？"
        confirmText="回退并重跑"
        description={pendingRevert && (
          <div className="space-y-1">
            <div>
              · {pendingRevert.sha
                ? '工作区还原到这条消息之前，这条之后改过的文件都会回到原样'
                : pendingRevert.removePaths.length > 0
                  ? '没有可用检查点，改过的文件无法还原，只能删掉它之后新建的文件'
                  : '没有可用检查点，这条之后改过的文件无法自动还原'}
            </div>
            {pendingRevert.removePaths.length > 0 && (
              <div>
                · 删除这条之后新建的 {pendingRevert.removePaths.length} 个文件：
                {pendingRevert.removePaths.slice(0, 3).join('、')}
                {pendingRevert.removePaths.length > 3 ? ' 等' : ''}
              </div>
            )}
            <div>· 这条之后的对话会被丢弃，然后用新内容重新执行</div>
          </div>
        )}
        onConfirm={() => {
          const plan = pendingRevert
          setPendingRevert(null)
          if (plan) runRevertPlan(plan)
        }}
        onCancel={() => setPendingRevert(null)}
      />
    </div>
  )
}

// ==================== 真实 token 用量（pi 风格） ====================
/**
 * 显示在对话框最下方的用量行：`↑1.5k ↓43 43 tok/s (auto)`
 * ↑ 是本次请求的输入（约等于当前上下文占用），↓ 是本次输出，全部来自 API 的 usage。
 * (auto) 表示上下文会自动压缩，不需要用户手动清理。
 * 上下文占比只由旁边的圆环表示（这里不再重复数字/数字）。
 */
function UsageLine({ usage }: { usage: TokenUsage }) {
  return (
    <div
      className="flex items-center gap-3 px-1 pb-1.5 text-[10px] font-mono tabular-nums select-none"
      title="模型 API 返回的真实用量：↑ 输入（当前上下文占用） ↓ 输出"
    >
      <span className="text-pi-text-dim">↑{formatTokens(usage.inputTokens)}</span>
      <span className="text-pi-text-dim">↓{formatTokens(usage.outputTokens)}</span>
      {usage.tokensPerSecond > 0 && (
        <span className={usage.live ? 'text-pi-accent/80' : 'text-pi-text-dim'}>
          {usage.tokensPerSecond} tok/s
        </span>
      )}
      <span className="text-pi-text-dim">(auto)</span>
    </div>
  )
}

/** 1500 → 1.5k，1000000 → 1.0M */
function formatTokens(n: number): string {
  if (!n || n <= 0) return '0'
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

/**
 * 上下文占用圆环。比例 = 上次请求的真实 prompt_tokens / 模型输入上限，
 * 数据来自 API 的 usage，不做本地估算，所以环里的百分比就是真实占用。
 */
function ContextRing({ percentage }: { percentage: number }) {
  const size = 24
  const strokeWidth = 2.5
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - Math.min(percentage, 100) / 100)
  const color = percentage > 80 ? '#f87171' : percentage > 60 ? '#fbbf24' : '#6366f1'

  return (
    <div className="relative flex items-center justify-center" title={`上下文已用 ${percentage}%（超出会自动压缩）`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="currentColor" strokeWidth={strokeWidth}
          className="text-pi-border" opacity={0.4}
        />
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={color} strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          className="transition-all duration-300"
        />
      </svg>
      <span className="absolute text-[7px] font-bold" style={{ color }}>{percentage}%</span>
    </div>
  )
}

// ==================== MessageBubble ====================
function MessageBubble({
  message, isEditable, onEdit, isEditing, editContent, setEditContent, onConfirmEdit, onCancelEdit,
}: {
  message: Message
  isEditable: boolean
  onEdit: (msg: Message) => void
  isEditing: boolean
  editContent: string
  setEditContent: (s: string) => void
  onConfirmEdit: () => void
  onCancelEdit: () => void
}) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <span className="text-[11px] text-amber-400 bg-amber-500/10 px-3 py-1 rounded-full">{message.content}</span>
      </div>
    )
  }

  if (isEditing) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[90%] bg-pi-surface border border-pi-accent/50 rounded-2xl rounded-br-md p-3 space-y-2">
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            rows={3}
            className="w-full bg-pi-bg border border-pi-border rounded-lg px-3 py-2 text-xs outline-none focus:border-pi-accent/50 resize-none"
          />
          <div className="flex gap-2 justify-end">
            <button onClick={onCancelEdit} className="px-2 py-1 text-[10px] text-pi-text-muted hover:text-pi-text">
              取消
            </button>
            <button onClick={onConfirmEdit} className="px-2 py-1 text-[10px] bg-pi-accent text-pi-bg rounded font-medium">
              确认重跑
            </button>
          </div>
        </div>
      </div>
    )
  }

  const processEvents = !isUser && message.process ? message.process.events || [] : []

  return (
    <div className={`group flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      {/* 执行过程独占整行：不再被回复气泡的 85% 宽度限制，右侧不留白 */}
      {processEvents.length > 0 && (
        <ProcessSection events={processEvents} durationMs={message.process?.durationMs || 0} />
      )}
      <div
        className={`select-text rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
          isUser
            ? 'max-w-[85%] bg-pi-accent/15 text-pi-text rounded-br-md'
            : 'w-full bg-pi-surface text-pi-text border border-pi-border rounded-bl-md'
        } ${isEditable ? 'cursor-pointer hover:ring-1 hover:ring-pi-accent/30 transition-all' : ''}`}
        onClick={() => isEditable && onEdit(message)}
        title={isEditable ? '点击编辑并重跑' : undefined}
      >
        {/* 回复统一按 Markdown 渲染（含「你好」这类简单回复） */}
        {isUser ? (
          <div className="whitespace-pre-wrap">{message.content}</div>
        ) : (
          <Markdown content={message.content} />
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {message.attachments.map((att, i) => (
              <span key={i} className="text-[9px] px-1.5 py-0.5 bg-pi-bg/50 rounded text-pi-text-dim">
                {att.type === 'image' ? '🖼️' : '📄'} {att.name}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[9px] text-pi-text-dim">
            {new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          </span>
          {isEditable && (
            <span className="text-[9px] text-pi-text-dim opacity-0 group-hover:opacity-100 transition-opacity">
              ✏️ 编辑
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// 过程时间线（完成态的任务耗时卡片与运行态的实时过程）在 ProcessTimeline.tsx

