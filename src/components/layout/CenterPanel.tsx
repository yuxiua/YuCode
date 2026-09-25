import { useRef, useState, useCallback } from 'react'
import { useAppStore } from '../../stores/appStore'
import CodeViewer from '../code/CodeViewer'
import TerminalPanel from '../terminal/TerminalPanel'

export default function CenterPanel() {
  const { terminalVisible } = useAppStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const [terminalHeight, setTerminalHeight] = useState(240)
  const isResizing = useRef(false)

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    const startY = e.clientY
    const startHeight = terminalHeight

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current) return
      const dy = startY - ev.clientY // up = positive
      const newHeight = Math.max(100, Math.min(600, startHeight + dy))
      setTerminalHeight(newHeight)
    }

    const onMouseUp = () => {
      isResizing.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
    }

    document.body.style.cursor = 'row-resize'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [terminalHeight])

  return (
    <div ref={containerRef} className="h-full flex flex-col overflow-hidden">
      {/* Code/File Viewer (top) */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <CodeViewer />
      </div>

      {/* Terminal (bottom)。关闭终端只是隐藏，不卸载组件：
          否则 TerminalPanel 的标签页 state 会丢，重新显示时会重建终端。 */}
      <div
        className={`h-1 cursor-row-resize bg-pi-border hover:bg-pi-accent/50 transition-colors shrink-0 ${
          terminalVisible ? '' : 'hidden'
        }`}
        onMouseDown={startResize}
      />
      <div
        style={{ height: terminalVisible ? terminalHeight : 0 }}
        className={`shrink-0 overflow-hidden ${terminalVisible ? '' : 'hidden'}`}
      >
        <TerminalPanel />
      </div>
    </div>
  )
}
