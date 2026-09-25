import { useAppStore } from '../../stores/appStore'

/**
 * 底部状态栏：只放「和当前状态有关」的少量信息。
 * 模型名不在这里显示（输入框上方的选择器已经写明，重复只是噪音）；
 * token 用量也不在这里（真实用量显示在对话框最下方，靠近用户视线焦点）。
 */
export default function StatusBar() {
  const { agentStatus, activePythonEnv } = useAppStore()

  return (
    <footer className="h-6 flex items-center gap-3 px-3 border-t border-pi-border bg-pi-surface text-[10px] text-pi-text-muted select-none shrink-0">
      <div className="flex items-center gap-1.5">
        <div className={`w-1.5 h-1.5 rounded-full ${agentStatus.state === 'idle' ? 'bg-pi-text-dim' : 'bg-pi-accent pulse-dot'}`} />
        <span className="text-pi-text-dim">Python:</span>
        <span>{activePythonEnv}</span>
      </div>

      {agentStatus.state !== 'idle' && (
        <span className="text-pi-accent">{getStatusText(agentStatus.state)}</span>
      )}
    </footer>
  )
}

function getStatusText(state: string): string {
  switch (state) {
    case 'thinking': return '思考中...'
    case 'editing': return '正在编辑文件...'
    case 'searching': return '搜索中...'
    case 'executing': return '执行命令...'
    default: return '处理中'
  }
}
