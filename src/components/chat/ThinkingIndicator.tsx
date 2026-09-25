import type { AgentStatus } from '../../types'

export default function ThinkingIndicator({ status }: { status: AgentStatus }) {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-3 bg-pi-surface border border-pi-border rounded-2xl rounded-bl-md px-4 py-3">
        {/* Animated icon based on state */}
        <StatusIcon state={status.state} />
        <div className="flex flex-col">
          <span className="text-xs font-medium text-pi-text">{getStatusLabel(status.state)}</span>
          {status.detail && (
            <span className="text-[10px] text-pi-text-muted">{status.detail}</span>
          )}
        </div>
        {/* Scan light bar */}
        <div className="w-20 h-1 bg-pi-border rounded-full overflow-hidden scan-light ml-2">
          <div className="w-full h-full bg-gradient-to-r from-transparent via-pi-accent/50 to-transparent" />
        </div>
      </div>
    </div>
  )
}

function StatusIcon({ state }: { state: AgentStatus['state'] }) {
  switch (state) {
    case 'thinking':
      return (
        <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
          <div className="flex gap-0.5">
            <span className="w-1 h-1 rounded-full bg-purple-400 pulse-dot" />
            <span className="w-1 h-1 rounded-full bg-purple-400 pulse-dot" style={{ animationDelay: '0.2s' }} />
            <span className="w-1 h-1 rounded-full bg-purple-400 pulse-dot" style={{ animationDelay: '0.4s' }} />
          </div>
        </div>
      )
    case 'searching':
      return (
        <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-blue-400">
            <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.5" />
            <path d="M9 9L12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      )
    case 'editing':
      return (
        <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-amber-400">
            <path d="M10 2L12 4L4 12H2V10L10 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )
    case 'executing':
      return (
        <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-green-400">
            <path d="M3 4L7 7L3 10V4Z" fill="currentColor" />
            <rect x="9" y="4" width="2" height="6" rx="0.5" fill="currentColor" />
          </svg>
        </div>
      )
    default:
      return (
        <div className="w-8 h-8 rounded-lg bg-pi-accent/10 flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-pi-accent pulse-dot" />
        </div>
      )
  }
}

function getStatusLabel(state: AgentStatus['state']): string {
  switch (state) {
    case 'thinking': return '思考中'
    case 'searching': return '搜索代码库'
    case 'editing': return '编辑文件'
    case 'executing': return '执行命令'
    default: return '处理中'
  }
}
