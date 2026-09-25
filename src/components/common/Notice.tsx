import { useEffect } from 'react'
import { useAppStore } from '../../stores/appStore'

/** 顶部居中的一次性提示条：几秒后自动消失，也可手动关掉 */
export default function Notice() {
  const notice = useAppStore((s) => s.notice)
  const clearNotice = useAppStore((s) => s.clearNotice)

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(clearNotice, 6000)
    return () => window.clearTimeout(timer)
  }, [notice, clearNotice])

  if (!notice) return null

  return (
    <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[150] flex items-start gap-2.5 max-w-[540px] px-3.5 py-2.5 rounded-lg border border-pi-border bg-pi-surface shadow-xl">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="mt-0.5 shrink-0 text-pi-accent">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
        <path d="M12 7.6v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="12" cy="16" r="1" fill="currentColor" />
      </svg>
      <span className="text-[11px] leading-5 text-pi-text-muted break-all">{notice.text}</span>
      <button
        onClick={clearNotice}
        className="shrink-0 text-pi-text-dim hover:text-pi-text text-xs leading-5"
        title="关闭"
      >
        ×
      </button>
    </div>
  )
}
