import { useState } from 'react'
import type { FileDiff } from '../../types'

/** 给 diff 行着色：@@ 是 hunk 头，+/- 是增删，其余是上下文 */
function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'text-pi-accent bg-pi-accent/5'
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-pi-text-dim'
  if (line.startsWith('+')) return 'text-emerald-400 bg-emerald-500/10'
  if (line.startsWith('-')) return 'text-red-400 bg-red-500/10'
  return 'text-pi-text-muted'
}

/**
 * 一次文件改动的 diff 卡片。
 * Agent 改完文件后会把 diff 推过来，这里把它原样展示 —— 改了什么必须看得见。
 */
export default function DiffCard({ diff }: { diff: FileDiff }) {
  const [open, setOpen] = useState(false)

  if (diff.created) {
    return (
      <div className="rounded-lg border border-pi-border bg-pi-bg/40 px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 text-[11.5px]">
          <span className="text-emerald-400 shrink-0">新建</span>
          <span className="text-pi-text font-mono truncate">{diff.filePath}</span>
          <span className="text-pi-text-dim shrink-0">{diff.added} 行</span>
        </div>
      </div>
    )
  }

  const lines = diff.patch ? diff.patch.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === '')) : []

  return (
    <div className="rounded-lg border border-pi-border bg-pi-bg/40 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-pi-hover/50 transition-colors"
      >
        <svg
          width="9" height="9" viewBox="0 0 16 16" fill="none"
          className={`shrink-0 text-pi-text-dim transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[11.5px] text-pi-text font-mono truncate flex-1">{diff.filePath}</span>
        {diff.added > 0 && <span className="text-[11px] text-emerald-400 shrink-0">+{diff.added}</span>}
        {diff.removed > 0 && <span className="text-[11px] text-red-400 shrink-0">-{diff.removed}</span>}
      </button>

      {open && lines.length > 0 && (
        <div className="border-t border-pi-border max-h-72 overflow-auto">
          <pre className="text-[11px] leading-[1.6] font-mono py-1">
            {lines.map((line, i) => (
              <div key={i} className={`px-2.5 whitespace-pre ${lineClass(line)}`}>
                {line || ' '}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}
