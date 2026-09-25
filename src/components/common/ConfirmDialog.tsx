import { useEffect, useRef, useState } from 'react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  /** 正文，可带文件/终端名的强调片段 */
  description?: React.ReactNode
  confirmText?: string
  cancelText?: string
  /** 危险操作用红色确认按钮 */
  danger?: boolean
  /** 是否显示「下次不再提示」（适合可重复的确认，如删除） */
  allowDontAskAgain?: boolean
  onConfirm: (dontAskAgain: boolean) => void
  onCancel: () => void
}

/**
 * 通用确认弹窗。
 * 用自绘弹窗替代 window.confirm：原生弹窗样式跟着系统走、无法加「下次不再提示」，
 * 而且不能控制焦点——危险操作的默认焦点必须落在「取消」上，避免一个回车就删了。
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  allowDontAskAgain = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [dontAsk, setDontAsk] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // 回调放在 ref 里：父组件通常传内联箭头函数，直接进 deps 会让 effect 每次渲染都重跑，
  // 导致勾选框被重置、焦点反复抢。
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  useEffect(() => {
    if (!open) return
    setDontAsk(false)
    const timer = window.setTimeout(() => cancelRef.current?.focus(), 0)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancelRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-[400px] max-w-[90vw] rounded-xl border border-pi-border bg-pi-surface shadow-2xl overflow-hidden">
        <div className="flex gap-3 px-5 pt-5">
          <div
            className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center ${
              danger ? 'bg-red-500/15 text-red-400' : 'bg-pi-accent/15 text-pi-accent'
            }`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 3.6L21 19.4H3L12 3.6Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <path d="M12 10v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <circle cx="12" cy="16.8" r="1" fill="currentColor" />
            </svg>
          </div>

          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-medium text-pi-text leading-6">{title}</h3>
            {description && (
              <div className="mt-1 text-[11px] leading-5 text-pi-text-muted break-all">{description}</div>
            )}
          </div>
        </div>

        {allowDontAskAgain && (
          <label className="mt-4 mx-5 flex items-center gap-2 text-[11px] text-pi-text-dim select-none cursor-pointer">
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={(e) => setDontAsk(e.target.checked)}
              className="w-3 h-3 accent-pi-accent cursor-pointer"
            />
            下次不再提示
          </label>
        )}

        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-3.5 py-1.5 rounded-lg text-[11px] border border-pi-border text-pi-text-muted hover:text-pi-text hover:bg-pi-hover transition-colors outline-none focus:ring-2 focus:ring-pi-accent/50"
          >
            {cancelText}
          </button>
          <button
            onClick={() => onConfirm(dontAsk)}
            className={`px-3.5 py-1.5 rounded-lg text-[11px] text-white transition-colors outline-none focus:ring-2 focus:ring-white/30 ${
              danger ? 'bg-red-500/90 hover:bg-red-500' : 'bg-pi-accent hover:bg-pi-accent-dim'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
