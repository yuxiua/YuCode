import { useState, useCallback, useEffect, useMemo } from 'react'
import { useAppStore } from '../../stores/appStore'
import FileIcon from '../common/FileIcon'
import ConfirmDialog from '../common/ConfirmDialog'
import CodeEditor from './CodeEditor'

// ─── Markdown renderer ───────────────────────────────────────────────────────

function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content])
  return (
    <div
      className="p-6 max-w-3xl mx-auto prose-pi"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function renderMarkdown(md: string): string {
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Fenced code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre class="bg-[#161922] border border-[#2a2e3a] rounded-lg p-4 my-4 overflow-x-auto text-sm font-mono"><code>${code}</code></pre>`
  })

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="bg-[#1e2231] px-1.5 py-0.5 rounded text-[13px] text-[#a78bfa] font-mono">$1</code>')

  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="rounded-lg my-4 max-w-full" />')

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-[#6366f1] hover:underline" target="_blank" rel="noopener">$1</a>')

  // Tables
  html = html.replace(/^\|(.+)\|\n\|[-\s|:]+\|\n((?:\|.+\|\n?)*)/gm, (_match, header, body) => {
    const headers = header.split('|').map((h: string) => h.trim()).filter(Boolean)
    const rows = body.trim().split('\n').map((row: string) =>
      row.split('|').map((c: string) => c.trim()).filter(Boolean)
    )
    const thead = `<thead><tr>${headers.map((h: string) => `<th class="px-3 py-2 text-left font-semibold text-[#e4e4e7] border-b border-[#2a2e3a]">${h}</th>`).join('')}</tr></thead>`
    const tbody = `<tbody>${rows.map((row: string[]) => `<tr>${row.map((c: string) => `<td class="px-3 py-2 text-[#a1a1aa] border-b border-[#2a2e3a]/50">${c}</td>`).join('')}</tr>`).join('')}</tbody>`
    return `<table class="w-full my-4 text-sm border-collapse">${thead}${tbody}</table>`
  })

  // Headings
  html = html.replace(/^###### (.+)$/gm, '<h6 class="text-sm font-semibold mt-4 mb-2 text-[#e4e4e7]">$1</h6>')
  html = html.replace(/^##### (.+)$/gm, '<h5 class="text-base font-semibold mt-5 mb-2 text-[#e4e4e7]">$1</h5>')
  html = html.replace(/^#### (.+)$/gm, '<h4 class="text-base font-semibold mt-6 mb-2 text-[#e4e4e7]">$1</h4>')
  html = html.replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold mt-7 mb-3 text-[#e4e4e7]">$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2 class="text-xl font-bold mt-8 mb-3 text-[#e4e4e7]">$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold mt-8 mb-4 text-[#e4e4e7]">$1</h1>')

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr class="my-6 border-[#2a2e3a]" />')

  // Bold + Italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="text-[#e4e4e7]">$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/~~(.+?)~~/g, '<del class="text-[#71717a]">$1</del>')

  // Blockquote
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote class="border-l-4 border-[#6366f1] pl-4 my-3 text-[#a1a1aa] italic">$1</blockquote>')

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li class="ml-6 list-decimal my-1 text-[#e4e4e7]">$1</li>')

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li class="ml-6 list-disc my-1 text-[#e4e4e7]">$1</li>')

  // Paragraphs (lines that are not already tags)
  html = html.replace(/^([^<\n][^\n]*)$/gm, '<p class="my-2 leading-relaxed text-[#e4e4e7]">$1</p>')

  return html
}

// ─── 过大的文件不做编辑 ──────────────────────────────────────────────────────
// 太大时既不该高亮也不该编辑：CodeMirror 建文档本身就要吃掉可观内存，
// 二进制被误读成文本时更是灾难（历史上出现过渲染进程涨到十几 GB 后崩溃）。
const MAX_EDITABLE_SIZE = 2 * 1024 * 1024

function TooLargeNotice({ size }: { size: number }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center select-none p-6">
      <div className="w-12 h-12 rounded-2xl bg-pi-surface flex items-center justify-center mb-3">
        <span className="text-xl">📄</span>
      </div>
      <p className="text-sm text-pi-text-muted">文件过大，已关闭编辑与高亮</p>
      <p className="text-[11px] text-pi-text-dim mt-1">{(size / 1024 / 1024).toFixed(1)} MB</p>
    </div>
  )
}

// ─── Toolbar ─────────────────────────────────────────────────────────────────

function Toolbar({
  language,
  isMarkdown,
  isPython,
  mdMode,
  dirty,
  saveHint,
  onToggleMdMode,
  onRunPython,
  onSave,
  onCopy,
  copied,
}: {
  language: string
  isMarkdown: boolean
  isPython: boolean
  mdMode: 'preview' | 'edit'
  dirty: boolean
  saveHint: string | null
  onToggleMdMode: (mode: 'preview' | 'edit') => void
  onRunPython: () => void
  onSave: () => void
  onCopy: () => void
  copied: boolean
}) {
  return (
    <div className="h-8 flex items-center gap-2 px-3 border-b border-pi-border bg-pi-surface/50 shrink-0">
      {/* Language badge */}
      <span className="text-[10px] px-2 py-0.5 rounded-full bg-pi-hover text-pi-text-muted font-medium uppercase tracking-wide">
        {language}
      </span>

      {dirty && (
        <span className="text-[10px] text-pi-accent" title="有未保存的改动">
          ● 未保存
        </span>
      )}

      <div className="flex-1" />

      {/* 保存提示：只占位一小会儿，不打断视线 */}
      {saveHint && <span className="text-[10px] text-pi-text-muted">{saveHint}</span>}

      {/* Markdown toggle */}
      {isMarkdown && (
        <div className="flex items-center gap-0.5 bg-pi-bg rounded-md p-0.5">
          <button
            onClick={() => onToggleMdMode('preview')}
            className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
              mdMode === 'preview'
                ? 'bg-pi-accent/20 text-pi-accent'
                : 'text-pi-text-muted hover:text-pi-text'
            }`}
          >
            预览
          </button>
          <button
            onClick={() => onToggleMdMode('edit')}
            className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
              mdMode === 'edit'
                ? 'bg-pi-accent/20 text-pi-accent'
                : 'text-pi-text-muted hover:text-pi-text'
            }`}
          >
            编辑
          </button>
        </div>
      )}

      {/* Save */}
      <button
        onClick={onSave}
        className={`px-2 py-0.5 text-[11px] rounded-md transition-colors ${
          dirty
            ? 'bg-pi-accent/20 text-pi-accent hover:bg-pi-accent/30'
            : 'text-pi-text-muted hover:text-pi-text hover:bg-pi-hover'
        }`}
        title="保存 (Ctrl+S)"
      >
        保存
      </button>

      {/* Python run */}
      {isPython && (
        <button
          onClick={onRunPython}
          className="px-2.5 py-0.5 text-[11px] rounded-md bg-pi-accent/15 text-pi-accent hover:bg-pi-accent/25 transition-colors font-medium"
        >
          ▶ 运行
        </button>
      )}

      {/* Copy */}
      <button
        onClick={onCopy}
        className="px-2 py-0.5 text-[11px] rounded-md text-pi-text-muted hover:text-pi-text hover:bg-pi-hover transition-colors"
        title="复制内容"
      >
        {copied ? '✓ 已复制' : '复制'}
      </button>
    </div>
  )
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center select-none">
      <div className="w-14 h-14 rounded-2xl bg-pi-surface flex items-center justify-center mb-3">
        <span className="text-2xl">📄</span>
      </div>
      <p className="text-sm text-pi-text-muted">从左侧目录选择文件打开</p>
      <p className="text-[11px] text-pi-text-dim mt-1">支持代码、Markdown、JSON 等格式</p>
    </div>
  )
}

// ─── Path utilities (renderer-safe) ──────────────────────────────────────────

function pathDirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return '.'
  if (lastSlash === 0) return '/'
  return normalized.slice(0, lastSlash)
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function CodeViewer() {
  const {
    openFiles,
    activeFilePath,
    currentDir,
    setActiveFile,
    closeFile,
    requestRun,
    setFileContent,
    saveFile,
    revealTarget,
    clearReveal,
    openFileAt,
  } = useAppStore()
  const activeFile = openFiles.find((f) => f.path === activeFilePath)

  const [mdMode, setMdMode] = useState<'preview' | 'edit'>('preview')
  const [copied, setCopied] = useState(false)
  const [saveHint, setSaveHint] = useState<string | null>(null)
  // 关有未保存改动的文件前先问一句，用自绘弹窗（样式跟随应用，而不是系统原生 confirm）
  const [pendingClose, setPendingClose] = useState<{ path: string; name: string } | null>(null)

  const requestClose = useCallback((path: string, name: string, dirty?: boolean) => {
    if (dirty) setPendingClose({ path, name })
    else closeFile(path)
  }, [closeFile])

  const isMarkdown = activeFile?.language === 'markdown'
  const isPython = activeFile?.language === 'python'
  const tooLarge = (activeFile?.content.length ?? 0) > MAX_EDITABLE_SIZE

  // 换文件时回到预览；跳转目标只对当前文件有效
  useEffect(() => {
    setMdMode('preview')
    setSaveHint(null)
  }, [activeFilePath])

  const handleChange = useCallback((value: string) => {
    if (!activeFile) return
    setFileContent(activeFile.path, value)
  }, [activeFile, setFileContent])

  const handleToggleMdMode = useCallback((mode: 'preview' | 'edit') => {
    setMdMode(mode)
  }, [])

  const handleSave = useCallback(async () => {
    if (!activeFile) return
    try {
      await saveFile(activeFile.path)
      setSaveHint('已保存')
    } catch (e) {
      setSaveHint(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setTimeout(() => setSaveHint(null), 1500)
  }, [activeFile, saveFile])

  // ctrl+左键：本文件里没有定义，就去工程范围里找，找到后打开那个文件并跳过去
  const handleJumpOutside = useCallback(async (word: string, at: { line: number; column: number }) => {
    if (!window.piAPI?.findSymbol) return
    // 把当前文件转成「相对工作目录」的写法，方便和扫描结果比对
    const dir = currentDir.replace(/[\\/]+$/, '')
    const relActive = activeFile && activeFile.path.startsWith(dir)
      ? activeFile.path.slice(dir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
      : ''
    try {
      // 带上文件与位置：主进程会优先用 LSP 查语义上的真定义（跨文件跨包都准），
      // 语言服务不可用时它会自动退回按名字扫全工程
      const hits = await window.piAPI.findSymbol(word, activeFile ? {
        filePath: activeFile.path,
        line: at.line,
        column: at.column,
      } : undefined)
      if (!hits || hits.length === 0) return
      // 优先跳别的文件：当前文件里的定义刚才已经找过了
      const hit = hits.find((h) => h.file.replace(/\\/g, '/') !== relActive) || hits[0]
      await openFileAt(hit.file, hit.line)
    } catch {
      /* 找不到就什么都不做，不打扰用户 */
    }
  }, [activeFile, currentDir, openFileAt])

  const handleCopy = useCallback(async () => {
    if (!activeFile) return
    try {
      await navigator.clipboard.writeText(activeFile.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // fallback
      const ta = document.createElement('textarea')
      ta.value = activeFile.content
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [activeFile])

  const handleRunPython = useCallback(() => {
    if (!activeFile) return
    const cwd = pathDirname(activeFile.path)
    // 交给终端面板新开一个标签页真实执行，这样能看到运行过程与报错。
    // -u 关闭 Python 输出缓冲，否则 print 的结果要等进程结束才刷出来。
    requestRun({
      cwd,
      title: `运行 ${activeFile.name}`,
      command: `python -u "${activeFile.path}"`,
    })
  }, [activeFile, requestRun])

  return (
    <div className="h-full flex flex-col bg-pi-bg overflow-hidden">
      {/* File tabs */}
      <div className="h-9 flex items-center border-b border-pi-border bg-pi-surface overflow-x-auto shrink-0">
        {openFiles.length === 0 ? (
          <span className="px-4 text-[11px] text-pi-text-dim">未打开文件</span>
        ) : (
          openFiles.map((file) => (
            <div
              key={file.path}
              className={`group flex items-center gap-1.5 px-3 h-full border-r border-pi-border text-[11px] cursor-pointer select-none whitespace-nowrap ${
                activeFilePath === file.path
                  ? 'bg-pi-bg text-pi-text border-t-2 border-t-pi-accent'
                  : 'text-pi-text-muted hover:bg-pi-hover'
              }`}
              onClick={() => setActiveFile(file.path)}
            >
              <FileIcon name={file.name} isDirectory={false} />
              <span>{file.name}</span>
              {file.dirty && <span className="text-pi-accent" title="未保存">●</span>}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  requestClose(file.path, file.name, file.dirty)
                }}
                className="ml-1 opacity-0 group-hover:opacity-100 text-pi-text-dim hover:text-pi-text text-xs"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {/* Toolbar */}
      {activeFile && (
        <Toolbar
          language={activeFile.language}
          isMarkdown={isMarkdown}
          isPython={isPython}
          mdMode={mdMode}
          dirty={Boolean(activeFile.dirty)}
          saveHint={saveHint}
          onToggleMdMode={handleToggleMdMode}
          onRunPython={handleRunPython}
          onSave={handleSave}
          onCopy={handleCopy}
          copied={copied}
        />
      )}

      {/* File content */}
      <div className="flex-1 overflow-hidden">
        {activeFile ? (
          tooLarge ? (
            <TooLargeNotice size={activeFile.content.length} />
          ) : isMarkdown && mdMode === 'preview' ? (
            <div className="h-full overflow-auto">
              <MarkdownPreview content={activeFile.content} />
            </div>
          ) : (
            <CodeEditor
              key={activeFile.path}
              filePath={activeFile.path}
              fileName={activeFile.name}
              content={activeFile.content}
              dirty={Boolean(activeFile.dirty)}
              revealLine={revealTarget?.path === activeFile.path ? revealTarget.line : null}
              onRevealed={clearReveal}
              onChange={handleChange}
              onSave={handleSave}
              onJumpOutside={handleJumpOutside}
            />
          )
        ) : (
          <EmptyState />
        )}
      </div>

      <ConfirmDialog
        open={Boolean(pendingClose)}
        title="这个文件还有未保存的改动"
        description={
          <>
            关闭 <span className="text-pi-text">{pendingClose?.name}</span> 会丢掉未保存的修改。
          </>
        }
        confirmText="放弃改动并关闭"
        cancelText="继续编辑"
        danger
        onConfirm={() => {
          if (pendingClose) closeFile(pendingClose.path)
          setPendingClose(null)
        }}
        onCancel={() => setPendingClose(null)}
      />
    </div>
  )
}
