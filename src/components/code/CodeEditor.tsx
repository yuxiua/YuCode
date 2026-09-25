import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { undo, redo } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { getCmLanguage } from './cmLanguages'
import { findDefinitionInText, wordAtOffset } from '../../utils/symbols'
import { EDIT_ACTION_EVENT } from '../layout/FileTree'

/**
 * 真正可编辑的代码编辑器（CodeMirror 6）。
 *
 * 三个要点：
 * 1. 编辑器实例只在「换文件」时重建 —— 回调都放在 ref 里，否则每敲一个字都会
 *    重建一次，光标和撤销历史会跟着丢。
 * 2. ctrl+左键先在本文件里找定义，就地跳；找不到才让外部去工程里扫。
 * 3. 外部把文件改掉（例如 Agent 写盘后文件树刷新）时要同步进编辑器，但用户
 *    正在编辑时不覆盖，免得把人正在写的字冲掉。
 */

interface CodeEditorProps {
  /** 当前文件绝对路径，变了就重建编辑器 */
  filePath: string
  fileName: string
  content: string
  /** 当前文件是否有未保存改动 */
  dirty: boolean
  /** 只读（例如文件过大时降级） */
  readOnly?: boolean
  /** 要跳转到的行（1 起）；跳完由父组件清空 */
  revealLine?: number | null
  onRevealed?: () => void
  onChange: (value: string) => void
  onSave: () => void
  /** 本文件内没找到定义时，交给上层去工程里找；at 是点击处位置（1 起），LSP 判断光标下符号要用 */
  onJumpOutside: (word: string, at: { line: number; column: number }) => void
}

/**
 * 编辑器主题：用 App 自己的色板（pi-bg / pi-surface / pi-border …），
 * 不再套 oneDark 的深灰蓝底。
 *
 * 之前的问题：oneDark 会把整块背景刷成 #282c34 并把行号压暗，叠在 transparent 上
 * 就成了「灰蒙蒙、和周围对不上」；行号 #4b5563 落在 #141414 上几乎看不见。
 * 这里只借 oneDark 的**语法高亮配色**（syntaxHighlighting），底色全用 App 的。
 */
const appTheme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent', color: '#e7e4df' },
    '.cm-scroller': {
      fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, 'Courier New', monospace",
      lineHeight: '1.65',
    },
    '.cm-content': { padding: '8px 0', caretColor: '#89b4fa' },
    // 行号：底色比正文浅一档，字色提亮到能看清
    '.cm-gutters': {
      backgroundColor: '#1c1c1c',
      borderRight: '1px solid #2f2f2f',
      color: '#6b6b6b',
      userSelect: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 8px' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#89b4fa' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.045)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#89b4fa', borderLeftWidth: '2px' },
    '.cm-selectionBackground, .cm-content ::selection, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(137,180,250,0.24)',
    },
    '.cm-selectionMatch': { backgroundColor: 'rgba(137,180,250,0.14)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgba(137,180,250,0.18)',
      outline: '1px solid rgba(137,180,250,0.45)',
      color: 'inherit',
    },
    '.cm-nonmatchingBracket': { color: '#f87171' },
    '.cm-foldPlaceholder': { backgroundColor: '#272727', border: '1px solid #2f2f2f', color: '#a6a6a6' },
    '.cm-tooltip': { backgroundColor: '#1c1c1c', border: '1px solid #2f2f2f', color: '#e7e4df' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: '#1e3a5f', color: '#e7e4df' },
    '.cm-panels': { backgroundColor: '#1c1c1c', color: '#e7e4df' },
    '.cm-searchMatch': { backgroundColor: 'rgba(249,226,175,0.22)', outline: '1px solid rgba(249,226,175,0.35)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(249,226,175,0.4)' },
  },
  { dark: true },
)

/**
 * 忽略换行符差异的文本比较。
 * CodeMirror 内部一律按 \n 存行，磁盘上的 CRLF 内容跟它字面上不相等，
 * 直接比字符串会把「只是换行符不同」误判成外部改动。
 */
function sameText(a: string, b: string): boolean {
  if (a === b) return true
  return a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n')
}

export default function CodeEditor({
  filePath,
  fileName,
  content,
  dirty,
  readOnly = false,
  revealLine = null,
  onRevealed,
  onChange,
  onSave,
  onJumpOutside,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)

  // 回调 / 最新内容放 ref：编辑器实例的生命周期只跟 filePath 绑定
  const contentRef = useRef(content)
  contentRef.current = content
  const cbRef = useRef({ onChange, onSave, onJumpOutside, onRevealed })
  cbRef.current = { onChange, onSave, onJumpOutside, onRevealed }

  // ─── 建编辑器（换文件时重建） ───────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const jump = (view: EditorView, pos: number) => {
      const doc = view.state.doc.toString()
      const word = wordAtOffset(doc, pos)
      if (!word) return
      const local = findDefinitionInText(doc, word)
      if (local) {
        const lineInfo = view.state.doc.line(local.line)
        const target = lineInfo.from + Math.min(local.column, lineInfo.length)
        // 定义就在当前光标处（说明点的就是定义本身）时，再去找别处
        if (Math.abs(target - pos) > 1) {
          view.dispatch({ selection: { anchor: target }, scrollIntoView: true })
          view.focus()
          return
        }
      }
      const clickLine = view.state.doc.lineAt(pos)
      cbRef.current.onJumpOutside(word, {
        line: clickLine.number,
        column: pos - clickLine.from + 1,
      })
    }

    const lang = getCmLanguage(fileName)
    const isMarkdown = /\.(md|markdown|mdx)$/i.test(fileName)

    const state = EditorState.create({
      doc: contentRef.current,
      extensions: [
        basicSetup,
        syntaxHighlighting(oneDarkHighlightStyle),
        appTheme,
        ...(lang ? [lang] : []),
        ...(isMarkdown ? [EditorView.lineWrapping] : []),
        EditorState.readOnly.of(readOnly),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              cbRef.current.onSave()
              return true
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) cbRef.current.onChange(update.state.doc.toString())
        }),
        EditorView.domEventHandlers({
          mousedown: (event, view) => {
            // ctrl（macOS 上是 cmd）+ 左键 = 跳转到定义
            if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
            if (pos === null) return false
            const word = wordAtOffset(view.state.doc.toString(), pos)
            if (!word) return false
            event.preventDefault()
            jump(view, pos)
            return true
          },
        }),
      ],
    })

    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [filePath, fileName, readOnly])

  // ─── 外部改了文件：同步进来（用户正在编辑时不覆盖） ─────────────────────────
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    // 只是换行符不同（CRLF ↔ LF）不算外部改动：这里若照旧 dispatch 一次，
    // 编辑器会报 docChanged，刚打开的文件就被误标成「未保存」。
    if (sameText(current, content)) return
    if (view.hasFocus) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: content } })
  }, [content])

  // ─── 跳到指定行 ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const view = viewRef.current
    if (!view || !revealLine) return
    const lineNo = Math.min(Math.max(revealLine, 1), view.state.doc.lines)
    const lineInfo = view.state.doc.line(lineNo)
    view.dispatch({ selection: { anchor: lineInfo.from }, scrollIntoView: true })
    view.focus()
    cbRef.current.onRevealed?.()
  }, [revealLine, filePath])

  // ─── 编辑菜单的撤销 / 重做 ──────────────────────────────────────────────────
  // 点菜单会把焦点从编辑器挪到菜单按钮上，所以这里不看 view.hasFocus，
  // 只要编辑器实例还在就执行（文件树那边没有撤销概念）。
  useEffect(() => {
    const onEditAction = (e: Event) => {
      const view = viewRef.current
      if (!view || view.state.readOnly) return
      const action = (e as CustomEvent<string>).detail
      if (action === 'undo') undo(view)
      else if (action === 'redo') redo(view)
    }
    window.addEventListener(EDIT_ACTION_EVENT, onEditAction)
    return () => window.removeEventListener(EDIT_ACTION_EVENT, onEditAction)
  }, [])

  return (
    <div
      ref={hostRef}
      className={`h-full w-full overflow-hidden ${dirty ? 'ring-1 ring-inset ring-pi-accent/20' : ''}`}
    />
  )
}
