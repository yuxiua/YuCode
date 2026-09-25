import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentStatus, ProcessEvent } from '../../types'
import Markdown from '../common/Markdown'
import DiffCard from './DiffCard'
import {
  buildTimeline, formatDuration, getStatusLabel, getToolGroupLabel,
} from './processTimelineModel'
import type { TimelineNode, ToolItem } from './processTimelineModel'

// ==================== 渲染 ====================

function TimelineNodeView({ node }: { node: TimelineNode }) {
  if (node.type === 'thinking') return <ThinkingCard text={node.text} />
  if (node.type === 'text') {
    // 「输出」与「思考」必须一眼区分开：思考是灰底可收起的卡片，
    // 输出是模型真正写给用户的话，正常字号正常颜色，只加一个小标签。
    return (
      <div className="space-y-0.5">
        <span className="text-[10px] text-pi-text-dim">输出</span>
        <p className="text-[13px] leading-relaxed text-pi-text whitespace-pre-wrap break-words">{node.text}</p>
      </div>
    )
  }
  if (node.type === 'notice') {
    const tone = node.noticeType === 'error'
      ? 'text-red-400'
      : node.noticeType === 'warning' ? 'text-amber-400' : 'text-pi-text-dim'
    return (
      <div className={`flex items-start gap-1.5 text-[11.5px] leading-relaxed whitespace-pre-wrap break-words ${tone}`}>
        <span className="shrink-0">•</span>
        <span>{node.text}</span>
      </div>
    )
  }
  if (node.type === 'diff') return <DiffCard diff={node.diff} />
  return <ToolGroup state={node.state} items={node.items} />
}

/**
 * 「思考 >」开关：默认收起，点开才把推理内容铺进时间线。
 * 多轮任务的思考最多能累积几十段，默认展开会把真正的输出淹掉。
 */
function ThinkingToggle({ open, count, onToggle }: {
  open: boolean
  count: number
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-1.5 text-[12px] text-pi-text-muted hover:text-pi-text transition-colors"
    >
      <span>思考</span>
      {count > 0 && <span className="text-[10px] text-pi-text-dim">{count}</span>}
      <svg
        width="10" height="10" viewBox="0 0 16 16" fill="none"
        className={`transition-transform ${open ? 'rotate-90' : ''}`}
      >
        <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

// 思考卡片：默认收起，只留一行预览
function ThinkingCard({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const preview = text.replace(/\s+/g, ' ').trim()

  return (
    <div className="rounded-xl border border-pi-border/70 bg-pi-bg/40 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-pi-text-muted hover:text-pi-text transition-colors"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="shrink-0">
          <path
            d="M6 2.5a3.2 3.2 0 0 0-3.2 3.2c0 .8.3 1.5.8 2.1-.5.5-.8 1.2-.8 1.9a3 3 0 0 0 3 3v1.1c0 .4.3.7.7.7h1.4c.4 0 .7-.3.7-.7V10a3 3 0 0 0 3-3c0-.7-.3-1.4-.8-1.9.5-.6.8-1.3.8-2.1A3.2 3.2 0 0 0 8.4 2.5H6Z"
            stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"
          />
          <path d="M8 3v9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
        <span className="text-[11px] shrink-0">思考</span>
        {!expanded && preview && (
          <span className="text-[11px] text-pi-text-dim truncate flex-1 text-left">{preview.slice(0, 90)}</span>
        )}
        {expanded && <span className="flex-1" />}
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="none"
          className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {expanded && (
        <div className="px-3 pt-2 pb-2.5 text-[11.5px] leading-[1.75] text-pi-text-muted whitespace-pre-wrap break-words border-t border-pi-border/60">
          {text}
        </div>
      )}
    </div>
  )
}

// 工具摘要行，展开看具体条目与实时输出
function ToolGroup({ state, items }: { state: string; items: ToolItem[] }) {
  // 有工具正在往外吐输出时自动铺开，用户手动点过就以用户的为准
  const live = items.some((i) => i.status === 'running' && i.output)
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? live
  const running = items.some((i) => i.status === 'running')

  return (
    <div>
      <button
        onClick={() => setUserOpen(!open)}
        className="flex items-center gap-1.5 text-[12px] text-pi-text-muted hover:text-pi-text transition-colors"
      >
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="none"
          className={`transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{getToolGroupLabel(state, items.length, running)}</span>
        {running && <span className="w-1.5 h-1.5 rounded-full bg-pi-accent pulse-dot" />}
      </button>

      {open && (
        <div className="mt-1.5 ml-4 space-y-1.5">
          {items.map((item, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-2 text-[11.5px] text-pi-text-muted">
                <ToolIcon state={state} />
                <span className={`truncate ${item.status === 'error' ? 'text-red-400' : ''}`}>{item.text}</span>
                <ToolStateMark status={item.status} durationMs={item.durationMs} />
              </div>
              {item.output && <ToolOutput output={item.output} failed={item.status === 'error'} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 工具输出：只留尾部若干行，长命令的输出不能把时间线撑爆 */
function ToolOutput({ output, failed }: { output: string; failed?: boolean }) {
  const lines = output.replace(/\s+$/, '').split('\n')
  const max = 12
  const tail = lines.length <= max ? lines.join('\n') : `…（省略前 ${lines.length - max} 行）\n${lines.slice(-max).join('\n')}`

  return (
    <pre
      className={`ml-5 max-h-40 overflow-auto rounded-lg border border-pi-border/70 bg-pi-bg/60 px-2 py-1.5 text-[10.5px] leading-[1.6] whitespace-pre-wrap break-all ${
        failed ? 'text-red-400' : 'text-pi-text-muted'
      }`}
    >
      {tail}
    </pre>
  )
}

function ToolStateMark({ status, durationMs }: { status?: ToolItem['status']; durationMs?: number }) {
  return (
    <span className="ml-auto flex items-center gap-1.5 shrink-0">
      {typeof durationMs === 'number' && durationMs > 0 && (
        <span className="text-[10px] text-pi-text-dim font-mono">{formatDuration(durationMs)}</span>
      )}
      {status === 'running' ? (
        <span className="w-1.5 h-1.5 rounded-full bg-pi-accent pulse-dot" />
      ) : status === 'error' ? (
        <span className="text-[10px] text-red-400">✗</span>
      ) : status === 'done' ? (
        <span className="text-[10px] text-emerald-400">✓</span>
      ) : null}
    </span>
  )
}

function ToolIcon({ state }: { state: string }) {
  const common = { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', className: 'shrink-0 text-pi-text-dim' }
  switch (state) {
    case 'web_searching':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 12.4 8 13.5C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.5Z"
            stroke="currentColor" strokeWidth="1.2"
          />
        </svg>
      )
    case 'web_fetching':
      return (
        <svg {...common}>
          <path
            d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1"
            stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      )
    case 'searching':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M10.2 10.2L13.5 13.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )
    case 'editing':
      return (
        <svg {...common}>
          <path d="M11 2.5l2.5 2.5L6 12.5H3.5V10L11 2.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      )
    case 'executing':
      return (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M4.5 6.5l1.5 1.5-1.5 1.5M8 9.5h3"
            stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      )
    case 'asking':
      return (
        <svg {...common}>
          <path
            d="M2.5 3.5h11v7h-6L5 13.5v-3H2.5v-7Z"
            stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
          />
        </svg>
      )
    case 'action':
      return (
        <svg {...common}>
          <path d="M3 4.5h10M3 8h10M3 11.5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )
    case 'tool':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M8 2.5v1.8M8 11.7v1.8M13.5 8h-1.8M4.3 8H2.5M11.9 4.1l-1.3 1.3M5.4 10.6l-1.3 1.3M11.9 11.9l-1.3-1.3M5.4 5.4 4.1 4.1"
            stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"
          />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <path d="M4 2h5l3 3v9H4V2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      )
  }
}

// ==================== 完成态：任务耗时 + 思考过程 ====================
export function ProcessSection({ events, durationMs }: {
  events: ProcessEvent[]
  durationMs: number
}) {
  const [expanded, setExpanded] = useState(true)
  // 思考默认收起：一段任务里的推理往往有几十段，展开会把真正的输出淹掉
  const [showThinking, setShowThinking] = useState(false)
  const nodes = useMemo(() => buildTimeline(events, true), [events])
  const visible = showThinking ? nodes : nodes.filter((n) => n.type !== 'thinking')
  const thinkingCount = nodes.filter((n) => n.type === 'thinking').length

  return (
    <div className="mb-3 w-full">
      {/* 任务耗时 header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[12px] text-pi-text-muted hover:text-pi-text transition-colors"
      >
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="none"
          className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>任务耗时</span>
        <span className="font-mono text-pi-text">{formatDuration(durationMs)}</span>
      </button>

      {expanded && (
        <div className="mt-2">
          {thinkingCount > 0 && (
            <ThinkingToggle open={showThinking} count={thinkingCount} onToggle={() => setShowThinking(!showThinking)} />
          )}
          <div className="mt-2.5 ml-1 space-y-2.5 border-l border-pi-border pl-3">
            {visible.map((node, i) => <TimelineNodeView key={i} node={node} />)}
          </div>
        </div>
      )}
    </div>
  )
}

// ==================== 运行态：实时过程时间线 ====================
export function RunningProcess({ status, events, liveContent }: {
  status: AgentStatus
  events: ProcessEvent[]
  liveContent: string
}) {
  const [expanded, setExpanded] = useState(true)
  // 同上：运行中也不把思考铺开，只保留一个「思考 >」入口
  const [showThinking, setShowThinking] = useState(false)
  const startRef = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)
  const nodes = useMemo(() => buildTimeline(events), [events])
  const visible = showThinking ? nodes : nodes.filter((n) => n.type !== 'thinking')
  const thinkingCount = nodes.filter((n) => n.type === 'thinking').length

  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - startRef.current), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="flex justify-start">
      <div className="bg-pi-surface border border-pi-border rounded-2xl rounded-bl-md w-full overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left hover:bg-pi-hover/50 transition-colors"
        >
          <span className="w-2 h-2 rounded-full bg-pi-accent pulse-dot shrink-0" />
          <span className="text-[12px] font-medium text-pi-text text-shimmer shrink-0">
            {getStatusLabel(status.state)}
          </span>
          {status.detail && (
            <span className="text-[10px] text-pi-text-dim truncate flex-1">{status.detail}</span>
          )}
          <span className="text-[10px] text-pi-text-dim shrink-0 font-mono">
            任务耗时 {formatDuration(elapsed)}
          </span>
          <svg
            width="10" height="10" viewBox="0 0 16 16" fill="none"
            className={`shrink-0 text-pi-text-dim transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {expanded && (
          <div className="px-3.5 pb-3 border-t border-pi-border">
            {thinkingCount > 0 && (
              <div className="mt-2">
                <ThinkingToggle open={showThinking} count={thinkingCount} onToggle={() => setShowThinking(!showThinking)} />
              </div>
            )}
            <div className="mt-2.5 ml-1 space-y-2.5 border-l border-pi-border pl-3">
              {visible.map((node, i) => <TimelineNodeView key={i} node={node} />)}
              {liveContent && <Markdown content={liveContent} className="text-[13px]" />}
              {visible.length === 0 && !liveContent && (
                <div className="text-[11px] text-pi-text-dim">正在准备…</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
