import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../../stores/appStore'
import ConfirmDialog from '../common/ConfirmDialog'

interface TermTab {
  id: string
  title: string
  /** 该标签页的工作目录（不传则跟随当前工作区） */
  cwd?: string
  /** 建好终端后自动执行的首条命令（「运行代码」用） */
  initialCommand?: string
}

const TERM_THEME = {
  background: '#141414',
  foreground: '#e7e4df',
  cursor: '#89b4fa',
  cursorAccent: '#141414',
  selectionBackground: 'rgba(137, 180, 250, 0.3)',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#cba6f7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#cba6f7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
}

export default function TerminalPanel() {
  const {
    activePythonEnv, setPythonEnv, pythonEnvs, toggleTerminal, currentDir, uiSettings,
    runRequest, clearRunRequest, terminalCreateRequest,
  } = useAppStore()
  const [tabs, setTabs] = useState<TermTab[]>([{ id: 'term-0', title: 'PowerShell' }])
  const [activeTab, setActiveTab] = useState('term-0')
  const [showEnvSelect, setShowEnvSelect] = useState(false)
  /** 关闭前需要确认的标签页（关标签会 kill 掉底下的 PTY） */
  const [pendingClose, setPendingClose] = useState<{ id: string; title: string } | null>(null)
  const counterRef = useRef(1)
  /** 上一次消费过的「新建终端」计数，用来区分"计数真的涨了"和"组件刚挂载" */
  const lastCreateRequestRef = useRef<number | null>(null)
  /** 标签页 id → 主进程 PTY id。只有拿到 PTY id 才能问主进程"里面还有没有在跑的程序" */
  const ptyIdsRef = useRef<Map<string, string>>(new Map())

  const addTerminal = () => {
    const id = `term-${counterRef.current++}`
    setTabs((prev) => [...prev, { id, title: 'PowerShell' }])
    setActiveTab(id)
  }

  // 顶部菜单栏的「新建终端」：标签页是这里的内部 state，菜单栏够不着，
  // 只能靠 store 里的自增计数当信号。只在计数真正递增时新建，
  // 挂载/StrictMode 重挂载时不动它，否则点「显示终端」会凭空多出几个终端。
  useEffect(() => {
    const prev = lastCreateRequestRef.current
    lastCreateRequestRef.current = terminalCreateRequest
    if (prev === null || terminalCreateRequest === prev) return
    const id = `term-${counterRef.current++}`
    setTabs((t) => [...t, { id, title: 'PowerShell' }])
    setActiveTab(id)
  }, [terminalCreateRequest])

  // 编辑器点了「运行」：新开一个标签页并在其中执行命令。
  // 之前是在后台偷偷建 PTY 再写命令，但没有任何地方接收输出，所以"点了没反应"。
  useEffect(() => {
    if (!runRequest) return
    const id = `term-${counterRef.current++}`
    setTabs((prev) => [
      ...prev,
      { id, title: runRequest.title, cwd: runRequest.cwd, initialCommand: runRequest.command },
    ])
    setActiveTab(id)
    clearRunRequest()
  }, [runRequest, clearRunRequest])

  /** 问主进程：这个终端底下还有没有活着的子进程（即"命令还在跑"） */
  const hasRunningProcess = async (tabId: string): Promise<boolean> => {
    const ptyId = ptyIdsRef.current.get(tabId)
    if (!ptyId || !window.piAPI?.hasTerminalChildren) return false
    try {
      return await window.piAPI.hasTerminalChildren(ptyId)
    } catch {
      // 查不到就别拦着用户关终端
      return false
    }
  }

  const doCloseTerminal = (id: string) => {
    ptyIdsRef.current.delete(id)
    const newTabs = tabs.filter((t) => t.id !== id)
    setTabs(newTabs)
    if (activeTab === id && newTabs.length > 0) setActiveTab(newTabs[newTabs.length - 1].id)
  }

  const closeTerminal = async (tab: TermTab) => {
    if (tabs.length <= 1) return
    // 关掉标签页会 kill 掉底下的 PTY，正在跑的命令会一起没掉，所以先确认
    if (await hasRunningProcess(tab.id)) {
      setPendingClose({ id: tab.id, title: tab.title })
      return
    }
    doCloseTerminal(tab.id)
  }

  /** 关闭整个终端面板 = 只隐藏，终端与其中的进程都保留，下次显示原样回来 */
  const closePanel = () => {
    toggleTerminal()
  }

  return (
    <div className="h-full flex flex-col bg-pi-bg overflow-hidden">
      {/* Terminal tab bar */}
      <div className="h-8 flex items-center border-b border-pi-border bg-pi-surface px-2 shrink-0">
        <div className="flex items-center gap-0 overflow-x-auto flex-1">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group flex items-center gap-1.5 px-2.5 h-6 rounded text-[11px] cursor-pointer select-none ${
                activeTab === tab.id
                  ? 'bg-pi-bg text-pi-text'
                  : 'text-pi-text-muted hover:bg-pi-hover'
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="text-[9px]">▸</span>
              <span>{tab.title}</span>
              {tabs.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); closeTerminal(tab) }}
                  className="opacity-0 group-hover:opacity-100 text-pi-text-dim hover:text-pi-text text-[10px]"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button onClick={addTerminal} className="ml-1 w-5 h-5 flex items-center justify-center text-pi-text-muted hover:text-pi-accent text-xs" title="新建终端">
            +
          </button>
        </div>

        {/* Python env + close */}
        <div className="flex items-center gap-1.5 ml-2">
          <div className="relative">
            <button
              onClick={() => setShowEnvSelect(!showEnvSelect)}
              className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] bg-pi-hover rounded hover:bg-pi-border"
              title="选择 Python 环境"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="#a6e3a1" strokeWidth="1.2" />
                <path d="M5 7l2 2-2 2" stroke="#a6e3a1" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="9" y1="11" x2="12" y2="11" stroke="#a6e3a1" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              <span>{activePythonEnv}</span>
            </button>
            {showEnvSelect && (
              <div className="absolute bottom-full right-0 mb-1 w-56 bg-pi-surface border border-pi-border rounded-lg shadow-lg py-1 z-50">
                <button onClick={() => { setPythonEnv('system'); setShowEnvSelect(false) }}
                  className={`w-full text-left px-3 py-1.5 hover:bg-pi-hover ${activePythonEnv === 'system' ? 'text-pi-accent' : 'text-pi-text'}`}>
                  <div className="text-[11px] font-medium">system</div>
                  <div className="text-[10px] text-pi-text-dim truncate">python (PATH)</div>
                </button>
                {pythonEnvs.map((env) => (
                  <button key={env.name} onClick={() => { setPythonEnv(env.name); setShowEnvSelect(false) }}
                    className={`w-full text-left px-3 py-1.5 hover:bg-pi-hover ${activePythonEnv === env.name ? 'text-pi-accent' : 'text-pi-text'}`}>
                    <div className="text-[11px] font-medium">{env.name}</div>
                    <div className="text-[10px] text-pi-text-dim truncate">{env.path}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={closePanel} className="w-5 h-5 flex items-center justify-center text-pi-text-dim hover:text-pi-text text-xs" title="关闭终端面板">
            ×
          </button>
        </div>
      </div>

      {/* Terminal instances：用 hidden 保留实例，切回来时再 fit，避免 PTY 被销毁重建 */}
      <div className="flex-1 overflow-hidden">
        {tabs.map((tab) => (
          <div key={tab.id} className={`h-full ${activeTab === tab.id ? 'block' : 'hidden'}`}>
            <TerminalInstance
              pythonEnv={activePythonEnv}
              cwd={tab.cwd || currentDir}
              initialCommand={tab.initialCommand}
              visible={activeTab === tab.id}
              scaleKey={uiSettings.uiScale}
              onReady={(ptyId) => ptyIdsRef.current.set(tab.id, ptyId)}
            />
          </div>
        ))}
      </div>

      {/* 终端里有命令在跑时的关闭确认 */}
      <ConfirmDialog
        open={pendingClose !== null}
        title="终端里还有程序在运行"
        description={`「${pendingClose?.title ?? ''}」里的命令尚未结束，关闭这个终端会一并结束它。`}
        confirmText="仍然关闭"
        cancelText="返回"
        danger
        onCancel={() => setPendingClose(null)}
        onConfirm={() => {
          const target = pendingClose
          setPendingClose(null)
          if (target) doCloseTerminal(target.id)
        }}
      />
    </div>
  )
}

function TerminalInstance({
  pythonEnv, cwd, initialCommand, visible, scaleKey, onReady,
}: {
  pythonEnv: string
  cwd: string
  initialCommand?: string
  visible: boolean
  scaleKey: number
  /** PTY 建好后把主进程的终端 id 告诉父组件（关闭前要用它查有没有程序在跑） */
  onReady?: (ptyId: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termIdRef = useRef<string | null>(null)
  const createdRef = useRef(false)
  const disposedRef = useRef(false)
  // 延迟销毁的定时器句柄（见下方 effect 注释）
  const pendingDisposeRef = useRef<number | null>(null)
  // 初始化 effect 只跑一次，用 ref 保证回调不是旧的
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  const safeFit = useCallback(() => {
    const term = termRef.current
    const fit = fitRef.current
    const host = hostRef.current
    if (!term || !fit || !host) return
    // 已销毁的终端再次 fit/write 会在 xterm 内部读到 undefined 的 renderer
    if (disposedRef.current) return
    // 容器不可见（宽高为 0）时 fit 会算出错误的行列数，跳过
    if (host.clientWidth === 0 || host.clientHeight === 0) return
    try {
      fit.fit()
      if (termIdRef.current && window.piAPI) {
        window.piAPI.resizeTerminal(termIdRef.current, term.cols, term.rows)
      }
    } catch { /* 忽略 */ }
  }, [])

  // 初始化 xterm。
  // React 18 StrictMode 在开发模式下会「挂载 → 卸载 → 再挂载」，若卸载时立刻 dispose，
  // 已排队的异步任务（IntersectionObserver / 渲染防抖 / createTerminal 的 Promise）仍可能
  // 访问已销毁的渲染器，抛 "Cannot read properties of undefined (reading 'dimensions')"。
  // 因此把真正的销毁延迟到下一个事件循环，并在下一次 effect 运行时取消它 —— 实现「只创建一次」。
  useEffect(() => {
    // 上一次清理安排过延迟销毁，说明这次是 StrictMode 的“假卸载”重挂载：取消销毁，复用已有终端
    if (pendingDisposeRef.current !== null) {
      window.clearTimeout(pendingDisposeRef.current)
      pendingDisposeRef.current = null
    }
    disposedRef.current = false
    if (!hostRef.current || createdRef.current) return
    createdRef.current = true

    // 仅当真正销毁时为 false，用于丢弃迟到的 createTerminal Promise
    let alive = true

    const term = new Terminal({
      theme: TERM_THEME,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      convertEol: false,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    termRef.current = term
    fitRef.current = fit
    safeFit()

    let cleanupData: (() => void) | undefined
    let cleanupClose: (() => void) | undefined

    if (window.piAPI) {
      // 键盘输入原样送给 PTY（包括方向键、Tab、Ctrl+C 等控制序列）
      term.onData((data) => {
        if (alive && termIdRef.current) {
          window.piAPI!.writeTerminal(termIdRef.current, data)
        }
      })
      term.onResize(({ cols, rows }) => {
        if (alive && termIdRef.current) {
          window.piAPI!.resizeTerminal(termIdRef.current, cols, rows)
        }
      })

      window.piAPI
        .createTerminal({ cwd, pythonEnv, cols: term.cols, rows: term.rows })
        .then((tid: string) => {
          // 终端可能在 PTY 创建完成前就被关闭，此时必须立刻回收，否则 PTY 会泄漏
          if (!alive) {
            window.piAPI!.killTerminal(tid)
            return
          }
          termIdRef.current = tid
          onReadyRef.current?.(tid)
          cleanupData = window.piAPI!.onTerminalData(tid, (data: unknown) => {
            if (!alive) return
            // 主进程发来的是 Buffer/Uint8Array，交给 xterm 自己按 UTF-8 解码（避免多字节字符被截断）
            if (data instanceof Uint8Array) term.write(data)
            else term.write(new TextEncoder().encode(String(data)))
          })
          cleanupClose = window.piAPI!.onTerminalClose(tid, () => {
            if (!alive) return
            term.write('\r\n\x1b[90m[进程已退出，重新打开终端可恢复]\x1b[0m\r\n')
          })
          term.focus()
          safeFit()
          // 「运行代码」场景：等 shell 起来后再写入首条命令（PTY 下回车是 \r）
          if (initialCommand) {
            window.setTimeout(() => {
              if (!alive) return
              window.piAPI!.writeTerminal(tid, `${initialCommand}\r`)
            }, 400)
          }
        })
    }

    return () => {
      disposedRef.current = true
      // 延迟销毁：StrictMode 的“假卸载”会在同一次提交里立刻重跑 effect
      pendingDisposeRef.current = window.setTimeout(() => {
        pendingDisposeRef.current = null
        alive = false
        createdRef.current = false
        cleanupData?.()
        cleanupClose?.()
        const tid = termIdRef.current
        termIdRef.current = null
        if (tid && window.piAPI) window.piAPI.killTerminal(tid)
        term.dispose()
        termRef.current = null
        fitRef.current = null
      }, 0)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 容器尺寸变化时重新 fit
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => safeFit())
    ro.observe(host)
    return () => ro.disconnect()
  }, [safeFit])

  // 切回该标签页时容器才真正有尺寸，此时重新 fit
  useEffect(() => {
    if (visible) {
      const t = setTimeout(() => safeFit(), 50)
      return () => clearTimeout(t)
    }
  }, [visible, safeFit])

  // 全局缩放变化后容器 CSS 尺寸会变，需要重新 fit
  useEffect(() => {
    const t = setTimeout(() => safeFit(), 60)
    return () => clearTimeout(t)
  }, [scaleKey, safeFit])

  return <div ref={hostRef} className="h-full w-full pl-2 pt-1 bg-pi-bg" />
}
