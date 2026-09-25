import { useEffect, useRef, useCallback } from 'react'
import { useAppStore } from './stores/appStore'
import MenuBar from './components/layout/MenuBar'
import FileTree from './components/layout/FileTree'
import CenterPanel from './components/layout/CenterPanel'
import RightPanel from './components/layout/RightPanel'
import SettingsPanel from './components/settings/SettingsPanel'
import StatusBar from './components/layout/StatusBar'
import Notice from './components/common/Notice'
import { unopenableReason } from './utils/fileTypes'

export default function App() {
  const { panelSizes, setPanelSizes, settingsOpen, refreshPythonEnvs, openFile, uiSettings, currentDir } = useAppStore()
  const containerRef = useRef<HTMLDivElement>(null)

  // 项目级 Skill 放在工作目录下的 .agents/skills、.pi/skills，切换目录后要重新扫描
  useEffect(() => {
    useAppStore.getState().refreshExtensions()
  }, [currentDir])

  // 应用「通用」外观设置：全局缩放 + 字体族
  useEffect(() => {
    // 用 webFrame.setZoomFactor 缩放整个界面，比 CSS zoom 更清晰，也不会破坏布局计算
    window.piAPI?.setZoomFactor?.(uiSettings.uiScale)
    document.body.style.fontFamily = uiSettings.fontFamily
      ? `"${uiSettings.fontFamily}", "Microsoft YaHei", system-ui, sans-serif`
      : ''
  }, [uiSettings.uiScale, uiSettings.fontFamily])

  // 两个 Agent 行为开关：主进程是权威，这里负责「开机按上次的选择恢复」+「改动后同步」。
  // 默认都是开，只有用户显式关掉时才传 false。
  useEffect(() => {
    window.piAPI?.setRiskConfirm?.(uiSettings.askBeforeRisk !== false)
    window.piAPI?.setAutoDiagnostics?.(uiSettings.autoDiagnostics !== false)
  }, [uiSettings.askBeforeRisk, uiSettings.autoDiagnostics])

  useEffect(() => {
    if (!window.piAPI) return
    // 恢复上次的工作目录：主进程的安全边界、Agent 工作目录、文件监听都要跟着回到上次的目录
    const savedDir = useAppStore.getState().currentDir
    if (savedDir) {
      window.piAPI.setAllowedDir(savedDir)
      window.piAPI.setAgentProjectDir?.(savedDir)
    }
    window.piAPI.listPythonEnvs().then(refreshPythonEnvs)

    // 扫描已安装扩展 + 拉取可安装清单（真实读磁盘）
    useAppStore.getState().refreshExtensions()

    // 把「已安装且启用」的 Skill 同步给 Agent（Skill 正文会注入系统提示词）。
    // 设置页安装 / 启用 / 禁用后由 subscribe 再推一次，因此开关是真正生效的。
    let lastExtKey = ''
    const pushExtensions = () => {
      const s = useAppStore.getState()
      const list = s.installedExtensions
        .filter((e) => e.kind === 'skill' && s.extEnabled[e.id] !== false)
        .map((e) => ({ id: e.id, name: e.name, description: e.description, content: e.content || '' }))
      const key = list.map((e) => e.id).join(',')
      if (key === lastExtKey) return
      lastExtKey = key
      window.piAPI!.setAgentExtensions?.(list)
    }
    pushExtensions()
    const unsubscribe = useAppStore.subscribe(pushExtensions)

    // 监听右键"用 Yu Code 打开"事件
    const cleanup = window.piAPI.onFileOpen(async (filePath: string) => {
      const name = filePath.split(/[\\/]/).pop() || filePath
      // 与文件树一致：只打开可编辑的文本文件，避免把二进制读进编辑器
      const reason = unopenableReason(name)
      if (reason) {
        useAppStore.getState().showNotice(reason)
        return
      }
      try {
        const content = await window.piAPI!.readFS(filePath)
        const ext = name.split('.').pop() || ''
        const langMap: Record<string, string> = { ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', py: 'python', json: 'json', md: 'markdown', html: 'html', css: 'css', sh: 'shell', yml: 'yaml', yaml: 'yaml' }
        openFile({ path: filePath, name, content, language: langMap[ext] || ext })
      } catch (e) {
        useAppStore.getState().showNotice(`打开「${name}」失败：${e instanceof Error ? e.message : String(e)}`)
      }
    })

    // 右键文件夹打开：直接把它设为工作目录（安全边界、Agent 目录、扩展扫描都会跟着切）
    const cleanupFolder = window.piAPI.onFolderOpen((dirPath: string) => {
      useAppStore.getState().setCurrentDir(dirPath)
    })

    // 监听注册完了才告诉主进程：启动时通过右键传入的目录此时才能安全下发，
    // 否则主进程发早了事件没人接，界面就会停在持久化的上次目录。
    window.piAPI.notifyRendererReady?.()
    return () => {
      unsubscribe()
      cleanup()
      cleanupFolder()
    }
  }, [])

  // Drag resize handlers - only left/right widths, center is flex-1
  const startResize = useCallback((which: 'left' | 'right') => {
    return (e: React.MouseEvent) => {
      e.preventDefault()
      const container = containerRef.current
      if (!container) return

      const startX = e.clientX
      const startSizes = { ...useAppStore.getState().panelSizes }
      const containerWidth = container.offsetWidth

      const onMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX

        if (which === 'left') {
          const newLeft = Math.max(120, Math.min(containerWidth * 0.4, startSizes.left + dx))
          setPanelSizes({ left: newLeft })
        } else if (which === 'right') {
          const newRight = Math.max(240, Math.min(containerWidth * 0.5, startSizes.right - dx))
          setPanelSizes({ right: newRight })
        }
      }

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
      }

      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    }
  }, [])

  return (
    <div className="h-screen w-screen flex flex-col bg-pi-bg text-pi-text overflow-hidden">
      {/* Menu Bar */}
      <MenuBar />

      {/* Main 3-panel layout - center uses flex-1 to fill remaining space */}
      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        {/* Left: File Tree */}
        <div style={{ width: panelSizes.left }} className="shrink-0 overflow-hidden">
          <FileTree />
        </div>

        {/* Left-Right Resizer */}
        <div
          className="w-1 cursor-col-resize bg-pi-border hover:bg-pi-accent/50 transition-colors shrink-0"
          onMouseDown={startResize('left')}
        />

        {/* Center: Code+Terminal 常驻挂载，设置页只是盖在上面。
            若用三元切换，关设置会让 CenterPanel 重新挂载、终端 PTY 被销毁重建，
            表现为「一开一关设置，底下的 PowerShell 就重启一次」 */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className={settingsOpen ? 'hidden' : 'h-full'}>
            <CenterPanel />
          </div>
          {settingsOpen && <SettingsPanel />}
        </div>

        {/* Center-Right Resizer：设置页打开时也要能拖动，右侧过程框宽度保持一致 */}
        <div
          className="w-1 cursor-col-resize bg-pi-border hover:bg-pi-accent/50 transition-colors shrink-0"
          onMouseDown={startResize('right')}
        />

        {/* Right: Chat panel */}
        <div style={{ width: panelSizes.right }} className="shrink-0 overflow-hidden">
          <RightPanel />
        </div>
      </div>

      {/* Status Bar */}
      <StatusBar />

      {/* 一次性提示条 */}
      <Notice />
    </div>
  )
}
