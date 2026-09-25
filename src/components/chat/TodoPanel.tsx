import { useState } from 'react'
import type { AgentTodo } from '../../types'

/**
 * Agent 的任务清单（todo_write 维护）。
 *
 * 多步任务里用户最想知道的是「它在干第几步、还剩几件」，只在对话流里写文字看不懂。
 * 所以钉在输入框上方实时显示，卡片本身可以收起。
 */
const ICON: Record<AgentTodo['status'], string> = {
  completed: '✓',
  in_progress: '▶',
  pending: '○',
}

const ICON_COLOR: Record<AgentTodo['status'], string> = {
  completed: 'text-green-400',
  in_progress: 'text-pi-accent',
  pending: 'text-pi-text-dim',
}

export default function TodoPanel({ todos }: { todos: AgentTodo[] }) {
  const [collapsed, setCollapsed] = useState(false)
  if (todos.length === 0) return null

  const done = todos.filter((t) => t.status === 'completed').length
  const active = todos.find((t) => t.status === 'in_progress')

  return (
    <div className="border-t border-pi-border bg-pi-surface/50 px-3 py-2 shrink-0">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 text-left"
      >
        <span className="text-[10px] font-medium text-pi-text-muted">
          任务进度 {done}/{todos.length}
        </span>
        {active && !collapsed && (
          <span className="text-[10px] text-pi-text-dim truncate flex-1">{active.content}</span>
        )}
        {collapsed && <span className="flex-1" />}
        <span className="text-[9px] text-pi-text-dim">{collapsed ? '展开' : '收起'}</span>
      </button>

      {!collapsed && (
        <div className="mt-1.5 space-y-0.5 max-h-32 overflow-y-auto">
          {todos.map((t) => (
            <div key={t.id} className="flex items-start gap-1.5">
              <span className={`text-[10px] w-3 shrink-0 ${ICON_COLOR[t.status]}`}>{ICON[t.status]}</span>
              <span
                className={`text-[10px] leading-relaxed ${
                  t.status === 'completed'
                    ? 'text-pi-text-dim line-through'
                    : t.status === 'in_progress'
                      ? 'text-pi-text'
                      : 'text-pi-text-muted'
                }`}
              >
                {t.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
