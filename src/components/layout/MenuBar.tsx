import { useState, useRef, useEffect } from 'react'
import { useAppStore } from '../../stores/appStore'
import { EDIT_ACTION_EVENT } from './FileTree'

type MenuName = '文件' | '编辑' | '终端' | '帮助' | null

interface MenuItem {
  label: string
  shortcut?: string
  action?: () => void
  separator?: boolean
}

export default function MenuBar() {
  const [openMenu, setOpenMenu] = useState<MenuName>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { setSettingsOpen, openFolder, toggleTerminal, terminalVisible, requestNewTerminal, showNotice } = useAppStore()

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // 新建文件 / 新建文件夹不在这里：左侧资源管理器右键就能建，重复入口容易让人以为点了没反应
  const fileItems: MenuItem[] = [
    { label: '打开文件夹...', shortcut: 'Ctrl+O', action: () => openFolder() },
    { separator: true, label: '' },
    { label: '选项', shortcut: 'Ctrl+,', action: () => setSettingsOpen(true) },
    { separator: true, label: '' },
    { label: '退出', shortcut: 'Alt+F4', action: () => window.piAPI?.close() },
  ]

  // 编辑菜单自己不知道焦点在哪，统一派发事件：
  // 撤销/重做由代码编辑器接，剪切/复制/粘贴/全选由文件树接。
  const fireEditAction = (action: string) => {
    window.dispatchEvent(new CustomEvent(EDIT_ACTION_EVENT, { detail: action }))
  }

  const editItems: MenuItem[] = [
    { label: '撤销', shortcut: 'Ctrl+Z', action: () => fireEditAction('undo') },
    { label: '重做', shortcut: 'Ctrl+Y', action: () => fireEditAction('redo') },
    { separator: true, label: '' },
    { label: '剪切', shortcut: 'Ctrl+X', action: () => fireEditAction('cut') },
    { label: '复制', shortcut: 'Ctrl+C', action: () => fireEditAction('copy') },
    { label: '粘贴', shortcut: 'Ctrl+V', action: () => fireEditAction('paste') },
    { separator: true, label: '' },
    { label: '全选', shortcut: 'Ctrl+A', action: () => fireEditAction('selectAll') },
  ]

  const terminalItems: MenuItem[] = [
    // 「新建终端」往终端面板里加一个标签页，并顺带把面板显示出来。
    { label: '新建终端', shortcut: 'Ctrl+`', action: () => requestNewTerminal() },
    // 「关闭终端」只关闭下方显示，终端实例与其中进程都保留，再点可原样显示回来。
    { label: terminalVisible ? '关闭终端' : '显示终端', shortcut: 'Ctrl+`', action: () => toggleTerminal() },
  ]

  // 「关于」只报版本号：走应用自己的顶部提示条，不弹系统对话框
  const showAbout = async () => {
    const version = await window.piAPI?.appVersion?.()
    showNotice(version ? `Yu Code v${version}` : 'Yu Code（版本号读取失败）')
  }

  const helpItems: MenuItem[] = [
    { label: '关于 Yu Code', action: () => showAbout() },
  ]

  const menus: { name: MenuName; items: MenuItem[] }[] = [
    { name: '文件', items: fileItems },
    { name: '编辑', items: editItems },
    { name: '终端', items: terminalItems },
    { name: '帮助', items: helpItems },
  ]

  return (
    <div
      ref={menuRef}
      className="drag-region h-9 flex items-center px-2 bg-pi-surface border-b border-pi-border select-none text-xs"
    >
      {/* App icon */}
      <div className="flex items-center gap-1.5 mr-4 no-drag">
        <div className="w-5 h-5 rounded bg-pi-accent/20 flex items-center justify-center">
          <span className="text-pi-accent text-[10px] font-bold">Y</span>
        </div>
        <span className="text-[11px] font-medium text-pi-text-muted">Yu Code</span>
      </div>

      {/* Menu items */}
      {menus.map((menu) => (
        <div key={menu.name} className="relative no-drag">
          <button
            onClick={() => setOpenMenu(openMenu === menu.name ? null : menu.name)}
            className={`px-3 py-1.5 rounded transition-colors ${
              openMenu === menu.name
                ? 'bg-pi-hover text-pi-text'
                : 'text-pi-text-muted hover:text-pi-text hover:bg-pi-hover'
            }`}
          >
            {menu.name}
          </button>

          {/* Dropdown */}
          {openMenu === menu.name && (
            <div className="absolute top-full left-0 mt-1 w-48 bg-pi-surface border border-pi-border rounded-lg shadow-xl py-1 z-[100]">
              {menu.items.map((item, i) =>
                item.separator ? (
                  <div key={i} className="h-px bg-pi-border my-1 mx-2" />
                ) : (
                  <button
                    key={i}
                    onClick={() => {
                      item.action?.()
                      setOpenMenu(null)
                    }}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-pi-text hover:bg-pi-hover transition-colors"
                  >
                    <span>{item.label}</span>
                    {item.shortcut && (
                      <span className="text-pi-text-dim text-[10px]">{item.shortcut}</span>
                    )}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}

      {/* Window controls */}
      <div className="ml-auto flex items-center no-drag self-stretch">
        <button
          onClick={() => window.piAPI?.minimize()}
          title="最小化"
          className="w-11 h-full flex items-center justify-center text-pi-text-muted hover:text-pi-text hover:bg-pi-hover transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2.5 7h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <button
          onClick={() => window.piAPI?.maximize()}
          title="最大化"
          className="w-11 h-full flex items-center justify-center text-pi-text-muted hover:text-pi-text hover:bg-pi-hover transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="2.5" y="2.5" width="9" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
        <button
          onClick={() => window.piAPI?.close()}
          title="关闭"
          className="w-11 h-full flex items-center justify-center text-pi-text-muted hover:text-white hover:bg-red-500/80 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
