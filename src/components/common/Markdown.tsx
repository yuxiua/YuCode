import { useMemo } from 'react'

// 简易 Markdown 渲染（无外部依赖）。
// 样式统一走 pi-* 主题类，聊天区与代码区共用同一套渲染逻辑。

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderMarkdown(md: string): string {
  // 先把围栏代码块抽成占位符，避免其中的符号被后续行内规则误伤
  const codeBlocks: string[] = []
  let html = md.replace(/```[ \t]*(\w*)\r?\n?([\s\S]*?)```/g, (_m, _lang: string, code: string) => {
    const index = codeBlocks.length
    codeBlocks.push(
      `<pre class="my-2 p-2.5 bg-pi-bg border border-pi-border rounded-md overflow-x-auto"><code class="font-mono text-[12px] leading-relaxed text-pi-text whitespace-pre">${escapeHtml(code.replace(/\r?\n$/, ''))}</code></pre>`
    )
    return `\u0000B${index}\u0000`
  })

  html = escapeHtml(html)

  // 表格
  html = html.replace(/^\|(.+)\|\r?\n\|[-\s|:]+\|\r?\n((?:\|.+\|\r?\n?)*)/gm, (_match, header: string, body: string) => {
    const headers = header.split('|').map((h) => h.trim()).filter(Boolean)
    const rows = body.trim().split(/\r?\n/).filter(Boolean).map((row) =>
      row.split('|').map((c) => c.trim()).filter(Boolean)
    )
    const thead = `<thead><tr>${headers.map((h) => `<th class="px-2.5 py-1.5 text-left font-semibold text-pi-text border-b border-pi-border break-words">${h}</th>`).join('')}</tr></thead>`
    const tbody = `<tbody>${rows.map((row) => `<tr>${row.map((c) => `<td class="px-2.5 py-1.5 text-pi-text-muted border-b border-pi-border/50 break-words">${c}</td>`).join('')}</tr>`).join('')}</tbody>`
    return `<table class="w-full my-2 text-[12px] border-collapse">${thead}${tbody}</table>`
  })

  // 标题
  html = html.replace(/^###### (.+)$/gm, '<h6 class="text-[12px] font-semibold mt-3 mb-1.5 text-pi-text">$1</h6>')
  html = html.replace(/^##### (.+)$/gm, '<h5 class="text-[13px] font-semibold mt-3 mb-1.5 text-pi-text">$1</h5>')
  html = html.replace(/^#### (.+)$/gm, '<h4 class="text-[13px] font-semibold mt-3 mb-1.5 text-pi-text">$1</h4>')
  html = html.replace(/^### (.+)$/gm, '<h3 class="text-[14px] font-semibold mt-3.5 mb-2 text-pi-text">$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2 class="text-[15px] font-bold mt-4 mb-2 text-pi-text">$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1 class="text-[16px] font-bold mt-4 mb-2 text-pi-text">$1</h1>')

  // 分隔线
  html = html.replace(/^\s*(?:---+|\*\*\*+)\s*$/gm, '<hr class="my-3 border-pi-border" />')

  // 行内代码
  html = html.replace(/`([^`\n]+)`/g, '<code class="px-1.5 py-0.5 rounded bg-pi-bg border border-pi-border font-mono text-[12px] text-pi-accent">$1</code>')

  // 图片 / 链接
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" class="rounded-md my-2 max-w-full" />')
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" class="text-pi-accent hover:underline" target="_blank" rel="noopener noreferrer">$1</a>')

  // 加粗 / 斜体 / 删除线
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-pi-text">$1</strong>')
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  html = html.replace(/~~(.+?)~~/g, '<del class="text-pi-text-dim">$1</del>')

  // 引用
  html = html.replace(/^&gt; ?(.*)$/gm, '<blockquote class="border-l-2 border-pi-accent pl-3 my-2 text-pi-text-muted italic break-words">$1</blockquote>')

  // 列表
  html = html.replace(/^\s*[-*+] (.+)$/gm, '<li class="ml-5 list-disc my-0.5 text-pi-text break-words">$1</li>')
  html = html.replace(/^\s*\d+\. (.+)$/gm, '<li class="ml-5 list-decimal my-0.5 text-pi-text break-words">$1</li>')

  // 段落（未被上面规则包成标签的行）
  html = html.replace(/^([^<\n\u0000][^\n]*)$/gm, '<p class="my-1.5 leading-relaxed text-pi-text whitespace-pre-wrap break-words">$1</p>')

  // 还原代码块
  html = html.replace(/\u0000B(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)] || '')

  return html
}

export default function Markdown({ content, className = '' }: { content: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(content || ''), [content])
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
}
