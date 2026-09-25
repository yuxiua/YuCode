import { useState } from 'react'
import type { AgentAsk } from '../../types'

/**
 * Agent 用 ask_user 提问时，停在输入框上方的回答卡片。
 * 回答之后 Agent 才会继续执行；只要有这张卡，就说明任务正卡在等你拍板。
 */
export default function AskUserCard({ ask, onAnswer }: {
  ask: AgentAsk
  onAnswer: (answer: string) => void
}) {
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)

  const answer = (value: string) => {
    const v = value.trim()
    if (!v || sent) return
    setSent(true)
    onAnswer(v)
  }

  return (
    <div className="border-t border-pi-accent/40 bg-pi-accent/5 px-3 py-2.5 shrink-0">
      <div className="flex items-start gap-2">
        <span className="text-[13px] shrink-0 mt-px">❓</span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-pi-text leading-relaxed whitespace-pre-wrap break-words">
            {ask.question}
          </div>

          {ask.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {ask.options.map((opt, i) => (
                <button
                  key={i}
                  disabled={sent}
                  onClick={() => answer(opt)}
                  className="px-2.5 py-1 rounded-md text-[11.5px] text-pi-text bg-pi-surface border border-pi-border hover:border-pi-accent/60 hover:text-pi-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {opt}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5 mt-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') answer(text) }}
              placeholder={sent ? '已提交，等待继续…' : '也可以直接输入你的答案'}
              disabled={sent}
              className="flex-1 bg-pi-surface border border-pi-border rounded-md px-2 py-1 text-[11.5px] outline-none focus:border-pi-accent/50 placeholder:text-pi-text-dim disabled:opacity-50"
            />
            <button
              onClick={() => answer(text)}
              disabled={!text.trim() || sent}
              className={`px-2.5 py-1 rounded-md text-[11.5px] font-medium transition-colors ${
                text.trim() && !sent
                  ? 'bg-pi-accent text-pi-bg hover:bg-pi-accent-dim'
                  : 'bg-pi-border text-pi-text-dim cursor-not-allowed'
              }`}
            >
              回答
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
