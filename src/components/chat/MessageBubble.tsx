import type { Message } from '../../types'

export default function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          isUser
            ? 'bg-pi-accent/15 text-pi-text rounded-br-md'
            : 'bg-pi-surface text-pi-text border border-pi-border rounded-bl-md'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="whitespace-pre-wrap">
            {renderContent(message.content)}
          </div>
        )}
        <div className={`text-[10px] mt-2 ${isUser ? 'text-pi-text-dim text-right' : 'text-pi-text-dim'}`}>
          {new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  )
}

function renderContent(content: string) {
  const parts = content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="text-pi-text font-semibold">{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="bg-pi-bg px-1.5 py-0.5 rounded text-xs font-mono text-pi-accent">{part.slice(1, -1)}</code>
    }
    return <span key={i}>{part}</span>
  })
}
