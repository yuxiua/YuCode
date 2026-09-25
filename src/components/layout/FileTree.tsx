import { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../../stores/appStore'
import { storage } from '../../stores/persist'
import FileIcon from '../common/FileIcon'
import ConfirmDialog from '../common/ConfirmDialog'
import { unopenableReason } from '../../utils/fileTypes'

/** 「删除时不再确认」的偏好键 */
const SKIP_DELETE_CONFIRM_KEY = 'pi-skip-delete-confirm'

/** 编辑菜单点击后广播的操作名（文件树 / 编辑器各自认领自己支持的那些） */
export const EDIT_ACTION_EVENT = 'pi-edit-action'

interface FileNode {
  name: string
  path: string
  isDirectory: boolean
  children?: FileNode[]
}

interface ContextMenuState {
  x: number
  y: number
  /** null 表示在空白处右键（作用于当前打开的目录） */
  node: FileNode | null
}

// ─── Context Menu Component ────────────────────────────────────────────────────

interface ContextMenuItem {
  label: string
  icon: string
  action: () => void
  danger?: boolean
  /** 分隔线（此时 label/icon/action 会被忽略） */
  separator?: boolean
}

function ContextMenu({
  state,
  canPaste,
  onClose,
  onNewItem,
  onNewFolder,
  onRename,
  onDelete,
  onCut,
  onCopy,
  onPaste,
  onCopyPath,
  onRevealInExplorer,
  onRefresh,
}: {
  state: ContextMenuState
  canPaste: boolean
  onClose: () => void
  onNewItem: (node: FileNode | null) => void
  onNewFolder: (node: FileNode | null) => void
  onRename: (node: FileNode) => void
  onDelete: (node: FileNode) => void
  onCut: (node: FileNode) => void
  onCopy: (node: FileNode) => void
  onPaste: (node: FileNode | null) => void
  onCopyPath: (node: FileNode) => void
  onRevealInExplorer: (node: FileNode) => void
  onRefresh: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  const node = state.node
  // 空白处右键 = 作用于当前目录；文件夹上右键同样视为作用于该文件夹
  const isDirTarget = !node || node.isDirectory

  const items: ContextMenuItem[] = []
  // 目录 / 空白处右键：新建类操作固定在最上面
  if (isDirTarget) {
    items.push({
      label: '新建文件', icon: '📄',
      action: () => { onNewItem(node); onClose() },
    })
    items.push({
      label: '新建文件夹', icon: '📁',
      action: () => { onNewFolder(node); onClose() },
    })
    if (canPaste) {
      items.push({ label: '粘贴', icon: '📥', action: () => { onPaste(node); onClose() } })
    }
  }
  items.push({ label: '刷新', icon: '🔄', action: () => { onRefresh(); onClose() } })
  if (node) {
    items.push({ label: '重命名', icon: '✏️', action: () => { onRename(node); onClose() } })
    items.push({
      label: '在资源管理器中显示', icon: '📂',
      action: () => { onRevealInExplorer(node); onClose() },
    })
    items.push({ label: '剪切', icon: '✂️', action: () => { onCut(node); onClose() } })
    items.push({ label: '复制', icon: '📎', action: () => { onCopy(node); onClose() } })
    items.push({ label: '复制路径', icon: '📋', action: () => { onCopyPath(node); onClose() } })
  }

  // 删除是不可撤销的破坏性操作，单独放在最下面并用分隔线隔开，避免和上面那些安全操作挨着误点
  if (node) {
    items.push({ separator: true, label: '', icon: '', action: () => {} })
    items.push({
      label: '删除', icon: '🗑️',
      action: () => { onDelete(node); onClose() }, danger: true,
    })
  }

  // Clamp position to viewport
  const menuWidth = 180
  const menuItemCount = items.filter((i) => !i.separator).length
  const menuSeparatorCount = items.length - menuItemCount
  const menuHeight = menuItemCount * 32 + menuSeparatorCount * 9 + 16
  const x = Math.min(state.x, window.innerWidth - menuWidth - 8)
  const y = Math.min(state.y, window.innerHeight - menuHeight - 8)

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-pi-surface border border-pi-border rounded-lg shadow-xl py-1 min-w-[170px]"
      style={{ left: x, top: y }}
    >
      {items.map((item, idx) =>
        item.separator ? (
          <div key={idx} className="h-px bg-pi-border my-1 mx-2" />
        ) : (
          <button
            key={idx}
            onClick={item.action}
            className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
              item.danger
                ? 'text-red-400 hover:bg-red-500/10'
                : 'text-pi-text-muted hover:bg-pi-hover hover:text-pi-text'
            }`}
          >
            <span className="text-[11px] w-4 text-center">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ),
      )}
    </div>
  )
}

// ─── Main FileTree Component ───────────────────────────────────────────────────

export default function FileTree() {
  const { currentDir, setCurrentDir, openFile, activeFilePath, showNotice } = useAppStore()
  const [nodes, setNodes] = useState<FileNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** 选中项集合：支持多选，快捷键与批量剪切/复制/删除都作用在它上面 */
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  /** 范围选择（Shift+点击）的锚点 */
  const [anchorPath, setAnchorPath] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [creatingIn, setCreatingIn] = useState<{ dir: FileNode; type: 'file' | 'folder' } | null>(null)
  const [createValue, setCreateValue] = useState('')
  /** 应用内剪贴板：记录「复制 / 剪切」的节点，供「粘贴」使用（同时会写进系统剪贴板） */
  const [clipboard, setClipboard] = useState<{ paths: string[]; cut: boolean } | null>(null)
  /** 等待确认删除的节点（用自绘弹窗替代 window.confirm） */
  const [pendingDelete, setPendingDelete] = useState<FileNode[] | null>(null)
  /** 读取目录失败时的错误提示（区别于「目录为空」） */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rootExpanded, setRootExpanded] = useState(true)
  /** 外部文件拖到面板上时的落点高亮 */
  const [dragOver, setDragOver] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const createInputRef = useRef<HTMLInputElement>(null)
  /** 新建已提交/取消过：紧接着的 blur 不再重复处理（Enter 提交后输入框卸载也会触发 blur） */
  const createSettledRef = useRef(false)

  /** 已展开目录集合的 ref：整棵树重建时需要读最新值，避免闭包拿到旧 state */
  const expandedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])

  // 选中集合 / 剪贴板 / 节点树的 ref：全局键盘与粘贴回调里要读最新值，不能靠闭包
  const selectedRef = useRef(selectedPaths)
  selectedRef.current = selectedPaths
  const clipboardRef = useRef(clipboard)
  clipboardRef.current = clipboard
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  /** 同步展开某个目录（state 与 ref 一起更新，紧跟着的 refreshTree 才能读到） */
  const expandDir = (dirPath: string) => {
    const next = new Set(expandedRef.current)
    next.add(dirPath)
    expandedRef.current = next
    setExpanded(next)
  }

  /** 按显示顺序摊平「当前可见」的节点（展开的目录才带出子节点），Shift 连选/全选都按这个顺序 */
  const flattenVisible = useCallback((list: FileNode[]) => {
    const out: FileNode[] = []
    const walk = (items: FileNode[]) => {
      for (const n of items) {
        out.push(n)
        if (n.isDirectory && expandedRef.current.has(n.path) && n.children) walk(n.children)
      }
    }
    walk(list)
    return out
  }, [])

  // 读取目录树（递归带上已展开的子目录），外部改动后也能整棵刷新
  const refreshTree = useCallback(async () => {
    const dirPath = currentDir
    if (!window.piAPI || !dirPath) {
      setNodes([])
      return
    }
    const sortNodes = (list: FileNode[]) =>
      list.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })
    try {
      const build = async (dir: string): Promise<FileNode[]> => {
        const entries = await window.piAPI!.listFS(dir)
        const list: FileNode[] = entries.map((e) => ({
          name: e.name,
          path: e.path,
          isDirectory: e.isDirectory,
        }))
        sortNodes(list)
        // 只对已展开的目录继续往下读，避免把整棵子树都拉进来
        await Promise.all(
          list.map(async (n) => {
            if (n.isDirectory && expandedRef.current.has(n.path)) {
              // 单个子目录读不了（无权限等）时留空即可，不能因此把整棵树清掉
              try {
                n.children = await build(n.path)
              } catch { /* ignore */ }
            }
          }),
        )
        return list
      }
      const tree = await build(dirPath)
      setNodes(tree)
      setLoadError(null)
    } catch (e) {
      setNodes([])
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [currentDir])

  useEffect(() => {
    refreshTree()
  }, [refreshTree])

  // 主进程监听当前工作目录：外部（资源管理器、其他软件、agent）改动文件后自动刷新
  useEffect(() => {
    if (!currentDir || !window.piAPI?.watchDir || !window.piAPI?.onDirChanged) return
    window.piAPI.watchDir(currentDir)
    return window.piAPI.onDirChanged(() => {
      refreshTree()
    })
  }, [currentDir, refreshTree])

  // 从系统外部拖拽 / 复制粘贴进来的文件
  const importExternal = useCallback(async (paths: string[], targetDir: string) => {
    if (!targetDir || paths.length === 0 || !window.piAPI?.importPaths) return
    try {
      await window.piAPI.importPaths(paths, targetDir)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
    refreshTree()
  }, [refreshTree])

  // ─── 外部文件拖入（从资源管理器拖文件/文件夹到面板） ────────────────────────────
  const handleDragOver = (e: React.DragEvent) => {
    if (!currentDir || !e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dragOver) setDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    // 在面板内部子元素之间移动也会触发 leave，只有真正离开面板才取消高亮
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (!currentDir) return
    // Electron 会把真实磁盘路径挂在 File 对象上（文件夹同样有 path）
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => !!p)
    if (paths.length > 0) importExternal(paths, currentDir)
  }

  // Focus rename input
  useEffect(() => {
    if (renamingPath && renameInputRef.current) {
      renameInputRef.current.focus()
      const dotIndex = renameValue.lastIndexOf('.')
      const name = renamingPath.split(/[\\/]/).pop() || ''
      renameInputRef.current.setSelectionRange(0, dotIndex > 0 ? dotIndex : name.length)
    }
  }, [renamingPath]) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus create input
  useEffect(() => {
    if (creatingIn && createInputRef.current) {
      createInputRef.current.focus()
    }
  }, [creatingIn])

  // ─── 选中 ──────────────────────────────────────────────────────────────────

  const clearSelection = () => {
    setSelectedPaths(new Set())
    setAnchorPath(null)
  }

  /** 当前选中对应的节点（按显示顺序） */
  const selectedNodes = () => {
    const sel = selectedRef.current
    if (sel.size === 0) return []
    return flattenVisible(nodesRef.current).filter((n) => sel.has(n.path))
  }

  /** 全选当前可见的文件与文件夹（Ctrl+A） */
  const selectAllNodes = () => {
    const list = flattenVisible(nodesRef.current)
    if (list.length === 0) return
    setSelectedPaths(new Set(list.map((n) => n.path)))
    setAnchorPath(list[0].path)
  }

  /**
   * 把「操作目标节点」扩展成真正要处理的节点集合：
   * 右键/快捷键命中的节点在多选集合里时，整批一起处理。
   */
  const effectiveTargets = (node: FileNode): FileNode[] => {
    const sel = selectedRef.current
    if (sel.size > 1 && sel.has(node.path)) {
      return flattenVisible(nodesRef.current).filter((n) => sel.has(n.path))
    }
    return [node]
  }

  /** 粘贴落点：优先选中的目录，其次选中文件所在目录，都没有就用当前目录 */
  const resolvePasteTarget = (): FileNode | null => {
    const picked = selectedNodes()
    return picked.find((n) => n.isDirectory) ?? picked[0] ?? null
  }

  // 展开 / 折叠目录：展开集合与 ref 同步更新后整棵重建，
  // 这样「已展开的子孙目录」也会一起读出来，深层目录不会显示成空的
  const toggleDir = async (node: FileNode) => {
    const next = new Set(expandedRef.current)
    if (next.has(node.path)) {
      next.delete(node.path)
    } else {
      next.add(node.path)
    }
    expandedRef.current = next
    setExpanded(next)
    await refreshTree()
  }

  const handleFileClick = async (node: FileNode) => {
    if (node.isDirectory) {
      toggleDir(node)
      return
    }
    // 只打开可编辑的文本文件：exe/dll/图片/压缩包之类一律不读，
    // 否则会把二进制当文本塞进编辑器（乱码、甚至把渲染进程撑爆）
    const reason = unopenableReason(node.name)
    if (reason) {
      showNotice(reason)
      return
    }
    if (window.piAPI) {
      try {
        const content = await window.piAPI.readFS(node.path)
        const language = getLanguageFromExt(node.name)
        openFile({ path: node.path, name: node.name, content, language })
      } catch (e) {
        showNotice(`打开「${node.name}」失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** 单击：普通点击 = 选中并打开/展开；Ctrl 点击 = 加减选；Shift 点击 = 连选一段 */
  const handleNodeClick = async (e: React.MouseEvent, node: FileNode) => {
    if (e.shiftKey && anchorPath) {
      const list = flattenVisible(nodesRef.current)
      const from = list.findIndex((n) => n.path === anchorPath)
      const to = list.findIndex((n) => n.path === node.path)
      if (from !== -1 && to !== -1) {
        const [a, b] = from <= to ? [from, to] : [to, from]
        setSelectedPaths(new Set(list.slice(a, b + 1).map((n) => n.path)))
        return
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelectedPaths((prev) => {
        const next = new Set(prev)
        if (next.has(node.path)) next.delete(node.path)
        else next.add(node.path)
        return next
      })
      setAnchorPath(node.path)
      return
    }
    setSelectedPaths(new Set([node.path]))
    setAnchorPath(node.path)
    await handleFileClick(node)
  }

  const handleContextMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault()
    e.stopPropagation()
    // 右键未选中的节点就把它设为唯一选中，保证菜单操作的就是看得见的这一项
    if (!selectedRef.current.has(node.path)) {
      setSelectedPaths(new Set([node.path]))
      setAnchorPath(node.path)
    }
    setContextMenu({ x: e.clientX, y: e.clientY, node })
  }

  // 空白处右键：作用对象为当前打开的目录
  const handleBlankContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, node: null })
  }

  /** 点击空白区域清空选中 */
  const handleTreeAreaClick = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement
    if (el.closest('button, [data-file-node], input')) return
    clearSelection()
  }

  // ─── Context Menu Actions ───────────────────────────────────────────────────

  // 右键目标对应的目标目录：文件夹 → 自身；文件 → 所在目录；空白 → 当前目录
  const getTargetDir = (node: FileNode | null) => {
    if (!node) return currentDir
    return node.isDirectory ? node.path : getParentPath(node.path)
  }

  const handleNewItem = (node: FileNode | null) => {
    createSettledRef.current = false
    setCreatingIn({ dir: { name: '', path: getTargetDir(node), isDirectory: true }, type: 'file' })
    setCreateValue('')
    if (node?.isDirectory) setExpanded((prev) => new Set(prev).add(node.path))
  }

  const handleNewFolder = (node: FileNode | null) => {
    createSettledRef.current = false
    setCreatingIn({ dir: { name: '', path: getTargetDir(node), isDirectory: true }, type: 'folder' })
    setCreateValue('')
    if (node?.isDirectory) setExpanded((prev) => new Set(prev).add(node.path))
  }

  const handleRename = (node: FileNode) => {
    setRenamingPath(node.path)
    setRenameValue(node.name)
  }

  const performDelete = async (targets: FileNode[]) => {
    for (const node of targets) {
      try {
        await window.piAPI?.deleteFS(node.path)
      } catch (e) {
        showNotice(`删除「${node.name}」失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      for (const node of targets) next.delete(node.path)
      return next
    })
    refreshTree()
  }

  const handleDeleteNodes = (targets: FileNode[]) => {
    if (targets.length === 0) return
    // 勾过「下次不再提示」就直接删，不再弹窗
    if (storage.getItem(SKIP_DELETE_CONFIRM_KEY) === '1') {
      performDelete(targets)
      return
    }
    setPendingDelete(targets)
  }

  /** 把文件写进系统剪贴板。写失败必须说出来：否则系统剪贴板会留着上一次剪切的
   *  「移动」状态，之后在软件外粘贴就把文件搬走了 —— 看起来就像「复制变成了剪切」。 */
  const writeSystemClipboard = async (paths: string[], cut: boolean) => {
    const res = await window.piAPI?.writeClipboardFiles?.(paths, cut)
    if (res && !res.ok) {
      showNotice(`写入系统剪贴板失败${res.error ? `：${res.error}` : ''}，请勿在软件外粘贴`)
    }
  }

  const handleCopy = (node: FileNode) => {
    const paths = effectiveTargets(node).map((n) => n.path)
    setClipboard({ paths, cut: false })
    // 同步写系统剪贴板，这样在资源管理器里也能直接 Ctrl+V
    void writeSystemClipboard(paths, false)
  }

  // 剪切只做标记，真正的移动发生在「粘贴」时
  const handleCut = (node: FileNode) => {
    const paths = effectiveTargets(node).map((n) => n.path)
    setClipboard({ paths, cut: true })
    void writeSystemClipboard(paths, true)
  }

  const handlePaste = async (node: FileNode | null) => {
    const targetDir = getTargetDir(node)
    if (!targetDir) return
    const clip = clipboardRef.current
    try {
      if (clip?.cut) {
        // 应用内剪切：逐个移动过去
        for (const p of clip.paths) await window.piAPI?.moveFS(p, targetDir)
        setClipboard(null)
      } else {
        // 复制：优先用系统剪贴板（外部复制进来的文件也走这条路），拿不到再用应用内剪贴板
        let paths = (await window.piAPI?.readClipboardFiles?.()) ?? []
        if (paths.length === 0) paths = clip?.paths ?? []
        if (paths.length > 0) await importExternal(paths, targetDir)
      }
    } catch (e) {
      showNotice(`粘贴失败：${e instanceof Error ? e.message : String(e)}`)
    }
    if (node?.isDirectory) expandDir(node.path)
    // refreshTree 会带着已展开的子目录一起重建，无需再单独刷子节点
    refreshTree()
  }

  /** 快捷键 / Ctrl+V 的粘贴落点 */
  const pasteIntoSelection = () => handlePaste(resolvePasteTarget())

  const handleCopyPath = (node: FileNode) => {
    navigator.clipboard.writeText(node.path).catch(() => {
      // Fallback
      const ta = document.createElement('textarea')
      ta.value = node.path
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    })
  }

  const handleRevealInExplorer = (node: FileNode) => {
    // 交给主进程调用 shell.showItemInFolder（渲染进程没有 node 环境，不能用 process.platform）
    window.piAPI?.showItemInFolder(node.path)
  }

  const handleRefresh = () => {
    refreshTree()
  }

  // ─── Rename handlers ────────────────────────────────────────────────────────

  const confirmRename = async () => {
    const newName = renameValue.trim()
    const oldPath = renamingPath
    setRenamingPath(null)
    setRenameValue('')
    if (!newName || !oldPath) return

    const oldNode = findNodeByPath(nodes, oldPath)
    if (!oldNode || newName === oldNode.name) return
    const dirPath = getParentPath(oldPath)
    const newPath = dirPath ? `${dirPath}${getSep(oldPath)}${newName}` : newName
    try {
      await window.piAPI?.renameFS(oldPath, newPath)
    } catch { /* 忽略重命名失败 */ }
    refreshTree()
  }

  const cancelRename = () => {
    setRenamingPath(null)
    setRenameValue('')
  }

  // ─── Create handlers ────────────────────────────────────────────────────────

  const confirmCreate = async () => {
    // 已经提交/取消过就不再重复（Enter 提交后输入框卸载也会触发 blur）
    if (createSettledRef.current) return
    createSettledRef.current = true
    const newName = createValue.trim()
    const target = creatingIn
    setCreatingIn(null)
    setCreateValue('')
    if (!newName || !target) return

    const dirPath = target.dir.path
    const newPath = dirPath ? `${dirPath}${getSep(dirPath)}${newName}` : newName

    try {
      if (target.type === 'file') {
        await window.piAPI?.writeFS(newPath, '')
      } else {
        await window.piAPI?.mkdirFS(newPath)
      }
    } catch { /* 忽略创建失败 */ }
    // 新建后目标目录一定是展开状态，refreshTree 会连它的子节点一起重建
    if (dirPath && dirPath !== currentDir) expandDir(dirPath)
    refreshTree()
  }

  const cancelCreate = () => {
    if (createSettledRef.current) return
    createSettledRef.current = true
    setCreatingIn(null)
    setCreateValue('')
  }

  // ─── 键盘快捷键 ──────────────────────────────────────────────────────────────
  // 这里只处理必须「焦点在文件树上」才有意义的键（粘贴落点、删除、重命名、打开）；
  // 复制/剪切/全选见下面的全局监听，不依赖焦点。

  const handleTreeKeyDown = (e: React.KeyboardEvent) => {
    // 正在输入框里打字（重命名 / 新建）时全部让给输入框
    if (isEditableTarget(e.target)) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()

    // Ctrl+A / Ctrl+C / Ctrl+X 不在这里处理：它们由下面的全局监听兜住，
    // 这样点到编辑器、聊天框之后再按也依然作用在文件树上。
    if (mod && key === 'v') {
      e.preventDefault()
      pasteIntoSelection()
      return
    }
    if (e.key === 'Delete') {
      e.preventDefault()
      handleDeleteNodes(selectedNodes())
      return
    }
    if (e.key === 'F2') {
      e.preventDefault()
      const picked = selectedNodes()
      if (picked.length === 1) handleRename(picked[0])
      return
    }
    // 焦点在按钮上时 Enter 会自己触发点击，这里不用再处理，避免打开两次
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
      e.preventDefault()
      const picked = selectedNodes()
      if (picked.length > 0) handleFileClick(picked[0])
    }
  }

  // 编辑菜单里的操作：作用到文件树当前选中的节点上。
  // 用 ref 承接最新闭包，监听只注册一次，免得每次渲染都重挂。
  const editActionRef = useRef<(action: string) => void>(() => {})
  editActionRef.current = (action: string) => {
    const picked = selectedNodes()
    if (action === 'cut' && picked[0]) handleCut(picked[0])
    else if (action === 'copy' && picked[0]) handleCopy(picked[0])
    else if (action === 'paste') pasteIntoSelection()
    else if (action === 'selectAll') selectAllNodes()
    else if (action === 'delete') handleDeleteNodes(picked)
    else if (action === 'rename' && picked.length === 1) handleRename(picked[0])
  }
  useEffect(() => {
    const onEditAction = (e: Event) => editActionRef.current((e as CustomEvent<string>).detail)
    window.addEventListener(EDIT_ACTION_EVENT, onEditAction)
    return () => window.removeEventListener(EDIT_ACTION_EVENT, onEditAction)
  }, [])

  // 支持把资源管理器里 Ctrl+C 复制的文件在文件树上 Ctrl+V 进来。
  // 应用内剪切（clipboard.cut）由 handlePaste 负责移动，其余走系统剪贴板导入。
  const pasteRef = useRef<() => void>(() => {})
  pasteRef.current = pasteIntoSelection
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!currentDir) return
      // 正在编辑输入框时不抢粘贴
      if (isEditableTarget(e.target)) return
      e.preventDefault()
      pasteRef.current()
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [currentDir])

  // Ctrl+A / Ctrl+C / Ctrl+X：全选、复制、剪切，作用对象是文件树的选中项。
  // 刻意不要求焦点在文件树上：点开一个文件后焦点常常已经跑到编辑器或聊天框，
  // 那时快捷键会静默失效——特别是 Ctrl+C 失效后，系统剪贴板还停在上一次剪切的
  // 「移动」状态，下一次粘贴就把文件移走了，看起来就像「Ctrl+C 变成了剪切」。
  // 界面文字默认不可选中（见 globals.css），Ctrl+A 也不该把整个界面的文字框起来。
  const globalKeyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  globalKeyRef.current = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return
    const key = e.key.toLowerCase()
    if (key !== 'a' && key !== 'c' && key !== 'x') return

    if (key === 'a') {
      // 全选：焦点在能打字的地方就让给它们，那里要选的是文字
      if (isEditableTarget(e.target)) return
      e.preventDefault()
      selectAllNodes()
      return
    }

    // 文件树里没有选中项就别动手：免得把用户刚在别处复制的文字从系统剪贴板里挤掉
    const picked = selectedNodes()
    if (picked.length === 0) return
    // 已经框选了文字（聊天正文、代码块、编辑器选区）时要复制的是文字，别抢
    if ((window.getSelection()?.toString().length ?? 0) > 0) return
    // 输入框里选了文字、或焦点在终端里（那里 Ctrl+C 是中断信号）时让给它们
    if (isBusyFocusedControl(e.target)) return

    e.preventDefault()
    if (key === 'c') handleCopy(picked[0])
    else handleCut(picked[0])
  }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => globalKeyRef.current(e)
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // ─── Render tree nodes ──────────────────────────────────────────────────────

  // 新建输入框（可出现在文件夹下方，也可出现在列表末尾）
  const renderCreateInput = (depth: number) => (
    <div className="flex items-center gap-1 px-2 py-[2px]" style={{ paddingLeft: `${depth * 12 + 8}px` }}>
      {creatingIn?.type === 'folder' ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M2 4C2 3.44772 2.44772 3 3 3H6.2L7.5 4.5H13C13.5523 4.5 14 4.94772 14 5.5V11.5C14 12.0523 13.5523 12.5 13 12.5H3C2.44772 12.5 2 12.0523 2 11.5V4Z" fill="#4a8fd4" opacity="0.5"/>
        </svg>
      ) : (
        <FileIcon name="new" isDirectory={false} />
      )}
      <input
        ref={createInputRef}
        value={createValue}
        onChange={(e) => setCreateValue(e.target.value)}
        onKeyDown={(e) => {
          // 回车提交，Esc 取消；点别处（失焦）同样按提交处理，跟资源管理器一致
          if (e.key === 'Enter') { e.preventDefault(); confirmCreate() }
          if (e.key === 'Escape') { e.preventDefault(); cancelCreate() }
        }}
        onBlur={confirmCreate}
        placeholder={creatingIn?.type === 'file' ? '新建文件...' : '新建文件夹...'}
        className="flex-1 bg-pi-bg border border-pi-accent rounded px-1 py-0.5 text-xs text-pi-text outline-none placeholder:text-pi-text-dim"
      />
    </div>
  )

  const renderNode = (node: FileNode, depth: number) => {
    const isRenaming = renamingPath === node.path
    const isSelected = selectedPaths.has(node.path)

    return (
      <div key={node.path}>
        {isRenaming ? (
          <div
            className="flex items-center gap-1 px-2 py-[2px]"
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            <FileIcon name={node.name} isDirectory={node.isDirectory} expanded={expanded.has(node.path)} />
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmRename()
                if (e.key === 'Escape') cancelRename()
              }}
              onBlur={confirmRename}
              className="flex-1 bg-pi-bg border border-pi-accent rounded px-1 py-0.5 text-xs text-pi-text outline-none"
            />
          </div>
        ) : (
          <>
            <button
              data-file-node
              onClick={(e) => handleNodeClick(e, node)}
              onContextMenu={(e) => handleContextMenu(e, node)}
              className={`w-full flex items-center gap-1.5 px-2 py-[3px] text-xs transition-colors ${
                isSelected
                  ? 'bg-pi-accent/20 text-pi-text'
                  : activeFilePath === node.path
                    ? 'bg-pi-selected text-pi-text'
                    : 'text-pi-text-muted hover:bg-pi-hover'
              }`}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
            >
              {node.isDirectory && (
                <span className={`text-[8px] text-pi-text-dim transition-transform w-3 ${
                  expanded.has(node.path) ? 'rotate-90' : ''
                }`}>▶</span>
              )}
              <FileIcon name={node.name} isDirectory={node.isDirectory} expanded={expanded.has(node.path)} />
              <span className="truncate">{node.name}</span>
            </button>

            {/* Show create input when creating in this directory */}
            {node.isDirectory && creatingIn?.dir.path === node.path && renderCreateInput(depth + 1)}
          </>
        )}

        {/* Render children */}
        {node.isDirectory && expanded.has(node.path) && node.children?.map((child) =>
          renderNode(child, depth + 1)
        )}
      </div>
    )
  }

  return (
    <div
      className="h-full flex flex-col bg-pi-surface border-r border-pi-border overflow-hidden relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="h-9 flex items-center justify-between px-3 border-b border-pi-border">
        <span className="text-[11px] font-medium text-pi-text-muted uppercase tracking-wide">
          资源管理器
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRefresh}
            className="text-pi-text-dim hover:text-pi-text text-xs p-0.5"
            title="刷新"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M13.5 8C13.5 11.0376 11.0376 13.5 8 13.5C5.69 13.5 3.7 12.19 2.8 10.25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M2.5 8C2.5 4.96243 4.96243 2.5 8 2.5C10.31 2.5 12.3 3.81 13.2 5.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M13.5 2.5V5.5H10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M2.5 13.5V10.5H5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      {/* File tree */}
      <div
        tabIndex={0}
        onKeyDown={handleTreeKeyDown}
        onClick={handleTreeAreaClick}
        className="flex-1 overflow-y-auto py-1 outline-none"
        onContextMenu={handleBlankContextMenu}
      >
        {currentDir ? (
          <>
            {/* Trae 风格：只显示文件夹名 + 折叠箭头，不显示完整路径 */}
            <button
              onClick={() => setRootExpanded(!rootExpanded)}
              className="w-full flex items-center gap-1 px-2 py-[3px] text-[11px] font-medium text-pi-text hover:bg-pi-hover/60 transition-colors"
              title={currentDir}
            >
              <span className={`text-[8px] text-pi-text-dim transition-transform w-3 ${
                rootExpanded ? 'rotate-90' : ''
              }`}>▶</span>
              <span className="truncate">{getBaseName(currentDir)}</span>
            </button>

            {rootExpanded && (
              <div>
                {nodes.map((node) => renderNode(node, 1))}
                {creatingIn?.dir.path === currentDir && renderCreateInput(1)}
                {loadError ? (
                  <p className="px-3 py-2 text-[11px] text-red-400 break-all">读取目录失败：{loadError}</p>
                ) : nodes.length === 0 && !creatingIn && (
                  <p className="px-3 py-2 text-[11px] text-pi-text-dim">目录为空</p>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="px-3 py-4 text-center">
            <p className="text-[11px] text-pi-text-muted mb-2">未打开文件夹</p>
            <button
              onClick={async () => {
                if (window.piAPI?.openFolderDialog) {
                  const path = await window.piAPI.openFolderDialog()
                  if (path) setCurrentDir(path)
                }
              }}
              className="text-[11px] text-pi-accent hover:text-pi-accent-dim"
            >
              打开文件夹
            </button>
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          state={contextMenu}
          canPaste={!!clipboard}
          onClose={() => setContextMenu(null)}
          onNewItem={handleNewItem}
          onNewFolder={handleNewFolder}
          onRename={handleRename}
          onDelete={(node) => handleDeleteNodes(effectiveTargets(node))}
          onCut={handleCut}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onCopyPath={handleCopyPath}
          onRevealInExplorer={handleRevealInExplorer}
          onRefresh={handleRefresh}
        />
      )}

      {/* 删除确认 */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除后无法恢复"
        description={
          pendingDelete && pendingDelete.length > 1 ? (
            <>确定要删除选中的 {pendingDelete.length} 项吗？删除后不进回收站，无法撤销。</>
          ) : (
            <>
              确定要删除{pendingDelete?.[0]?.isDirectory ? '文件夹' : '文件'}「
              <span className="text-pi-text">{pendingDelete?.[0]?.name}</span>」吗？删除后不进回收站，无法撤销。
            </>
          )
        }
        confirmText="删除"
        danger
        allowDontAskAgain
        onCancel={() => setPendingDelete(null)}
        onConfirm={(dontAskAgain) => {
          const targets = pendingDelete
          if (dontAskAgain) storage.setItem(SKIP_DELETE_CONFIRM_KEY, '1')
          setPendingDelete(null)
          if (targets) performDelete(targets)
        }}
      />

      {/* 外部文件拖入时的落点提示 */}
      {dragOver && (
        <div className="absolute inset-0 z-30 pointer-events-none border-2 border-dashed border-pi-accent bg-pi-accent/5 flex items-center justify-center">
          <span className="text-[11px] text-pi-accent bg-pi-surface px-3 py-1 rounded-full border border-pi-accent/40">
            松开即可复制到 {getBaseName(currentDir)}
          </span>
        </div>
      )}
    </div>
  )
}

// ─── Utility Functions ─────────────────────────────────────────────────────────

/** 焦点是否在「能打字的」控件里：输入框 / textarea / contenteditable / 代码编辑器。
 *  这些地方要保留浏览器默认的复制粘贴与全选，文件树快捷键不能抢。 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true
  return !!el.closest?.('.cm-editor')
}

/** 焦点控件此刻是不是在忙自己的「复制 / 剪切」。
 *  终端一律算忙（Ctrl+C 在那边是中断信号，选区也走自己的实现）；
 *  输入框与代码编辑器只有在真的选了文字时才算忙 —— 光标光停在那里不算，
 *  否则用户在编辑器里点一下、再回文件树按 Ctrl+C 就会被静默吞掉。 */
function isBusyFocusedControl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.closest?.('.xterm')) return true
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const input = el as HTMLInputElement
    return (input.selectionStart ?? 0) !== (input.selectionEnd ?? 0)
  }
  return false
}

function getParentPath(path: string): string {
  const sep = path.includes('\\') ? '\\' : '/'
  const idx = path.lastIndexOf(sep)
  return idx > 0 ? path.substring(0, idx) : ''
}

/** 按路径自身的分隔符返回分隔符（Windows 用 \，其他用 /） */
function getSep(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

/** 取路径最后一段作为显示名 */
function getBaseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

function findNodeByPath(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.children) {
      const found = findNodeByPath(node.children, path)
      if (found) return found
    }
  }
  return null
}

function getLanguageFromExt(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    md: 'markdown', json: 'json', css: 'css', html: 'html',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', sh: 'bash',
  }
  return map[ext] || 'plaintext'
}
