import { useEffect, useState } from 'react'
import { useAppStore, UI_FONT_OPTIONS } from '../../stores/appStore'
import ToggleSwitch from '../common/ToggleSwitch'
import McpSection from './McpSection'
import type { Model, ModelTestConfig, ModelTestReport, ThinkingControl, ExtensionCatalogItem, InstalledExtension, PiRuntimeInfo } from '../../types'

type Tab = 'general' | 'model' | 'extension' | 'skill' | 'terminal' | 'env'

const providerPresets: Record<string, { label: string; baseUrl: string }> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  custom: { label: '自定义', baseUrl: '' },
}

/** 关闭思考的控制方式：各家网关关思考的写法互不相通，只能按后端选 */
const thinkingControlOptions: { value: ThinkingControl; label: string }[] = [
  { value: 'qwen', label: 'Qwen / vLLM / llama.cpp' },
  { value: 'openai', label: 'OpenAI（reasoning_effort）' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'none', label: '不额外控制' },
]

export default function SettingsPanel() {
  const { setSettingsOpen } = useAppStore()
  const [tab, setTab] = useState<Tab>('model')

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'general', label: '通用', icon: 'G' },
    { id: 'model', label: '模型', icon: 'M' },
    { id: 'extension', label: '扩展', icon: 'E' },
    { id: 'skill', label: '技能', icon: 'S' },
    { id: 'terminal', label: '终端', icon: 'T' },
    { id: 'env', label: '环境', icon: '⚙' },
  ]

  return (
    <div className="h-full flex bg-pi-bg overflow-hidden">
      {/* Left sidebar - Settings navigation */}
      <div className="w-44 shrink-0 border-r border-pi-border bg-pi-surface flex flex-col">
        <div className="h-9 flex items-center justify-between px-3 border-b border-pi-border">
          <span className="text-[11px] font-medium text-pi-text">设置</span>
          <button
            onClick={() => setSettingsOpen(false)}
            title="关闭设置"
            className="w-6 h-6 -mr-1 flex items-center justify-center rounded text-pi-text-muted hover:text-pi-text hover:bg-pi-hover transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <nav className="flex-1 py-2 px-2 space-y-0.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs font-medium transition-colors ${
                tab === t.id
                  ? 'bg-pi-accent/10 text-pi-accent'
                  : 'text-pi-text-muted hover:text-pi-text hover:bg-pi-hover'
              }`}
            >
              <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold ${
                tab === t.id ? 'bg-pi-accent/20 text-pi-accent' : 'bg-pi-bg text-pi-text-dim'
              }`}>
                {t.icon}
              </span>
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content area - wide and spacious */}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'general' && <GeneralSection />}
        {tab === 'model' && <ModelSection />}
        {tab === 'extension' && <ExtensionSection />}
        {tab === 'skill' && <SkillSection />}
        {tab === 'terminal' && <TerminalSection />}
        {tab === 'env' && <EnvSection />}
      </div>
    </div>
  )
}

// ==================== 通用设置 ====================
function GeneralSection() {
  const { uiSettings, setUiSettings } = useAppStore()

  return (
    <div className="max-w-xl">
      <div className="mb-5">
        <h2 className="text-sm font-semibold text-pi-text">通用设置</h2>
        <p className="text-[11px] text-pi-text-muted mt-0.5">调整整体字号与字体，设置会自动保存</p>
      </div>

      <div className="space-y-5">
        {/* 字号大小（全局缩放） */}
        <div className="p-4 rounded-xl border border-pi-border bg-pi-surface">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-xs font-medium text-pi-text">字号大小</p>
              <p className="text-[10px] text-pi-text-dim mt-0.5">缩放整个界面，比 100% 略大更舒适</p>
            </div>
            <span className="text-xs font-mono text-pi-accent">{Math.round(uiSettings.uiScale * 100)}%</span>
          </div>
          <input
            type="range"
            min={0.8}
            max={1.6}
            step={0.05}
            value={uiSettings.uiScale}
            onChange={(e) => setUiSettings({ uiScale: Number(e.target.value) })}
            className="w-full accent-pi-accent cursor-pointer"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-[10px] text-pi-text-dim">小</span>
            <button
              onClick={() => setUiSettings({ uiScale: 1.1 })}
              className="text-[10px] text-pi-text-muted hover:text-pi-accent transition-colors"
            >
              恢复默认 (110%)
            </button>
            <span className="text-[10px] text-pi-text-dim">大</span>
          </div>
        </div>

        {/* 字体 */}
        <div className="p-4 rounded-xl border border-pi-border bg-pi-surface">
          <p className="text-xs font-medium text-pi-text mb-1">界面字体</p>
          <p className="text-[10px] text-pi-text-dim mb-3">选择全局字体族</p>
          <div className="flex flex-wrap gap-2">
            {UI_FONT_OPTIONS.map((font) => (
              <button
                key={font}
                onClick={() => setUiSettings({ fontFamily: font })}
                style={{ fontFamily: `"${font}", "Microsoft YaHei", system-ui, sans-serif` }}
                className={`px-3 py-1.5 rounded-lg border text-xs transition-colors ${
                  uiSettings.fontFamily === font
                    ? 'border-pi-accent/50 bg-pi-accent/10 text-pi-accent'
                    : 'border-pi-border text-pi-text-muted hover:border-pi-border/80 hover:text-pi-text'
                }`}
              >
                {font}
              </button>
            ))}
          </div>
          {/* 预览 */}
          <div
            className="mt-3 p-3 rounded-lg bg-pi-bg border border-pi-border text-pi-text"
            style={{ fontFamily: `"${uiSettings.fontFamily}", "Microsoft YaHei", system-ui, sans-serif` }}
          >
            <p className="text-xs">预览： Yu Code Agent 智能编程助手 1234567890</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ==================== 模型设置 ====================
function ModelSection() {
  const { models, activeModelId, setActiveModel, addModel, removeModel, updateModel } = useAppStore()
  const [showAdd, setShowAdd] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [modelName, setModelName] = useState('')
  const [provider, setProvider] = useState<Model['provider']>('openai')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [contextWindow, setContextWindow] = useState('200000')
  const [maxInput, setMaxInput] = useState('199000')
  const [maxOutput, setMaxOutput] = useState('8192')
  const [multimodal, setMultimodal] = useState(false)
  const [disableThinking, setDisableThinking] = useState(false)
  const [thinkingControl, setThinkingControl] = useState<ThinkingControl>('qwen')
  // 自测：一次只测一个（表单或某个已保存的模型），结果贴在对应的位置下面
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testReport, setTestReport] = useState<ModelTestReport | null>(null)

  const runTest = async (id: string, cfg: ModelTestConfig) => {
    setTestingId(id)
    setTestReport(null)
    try {
      if (!window.piAPI?.testModel) throw new Error('只有桌面版能测（浏览器预览下没有主进程）')
      setTestReport({ id, ...(await window.piAPI.testModel(cfg)) })
    } catch (e) {
      setTestReport({ id, ok: false, steps: [{ name: '测试', ok: false, detail: e instanceof Error ? e.message : String(e) }] })
    } finally {
      setTestingId(null)
    }
  }

  /** 表单里的这组输入 —— 测试用它，所以「先测通再保存」是可行的 */
  const formConfig = (): ModelTestConfig => ({
    provider,
    model: modelName.trim(),
    displayName: displayName.trim(),
    apiKey: apiKey.trim(),
    baseUrl: baseUrl.trim(),
    contextWindow: Number(contextWindow) || 0,
    maxOutputTokens: Number(maxOutput) || 0,
    disableThinking,
    thinkingControl,
  })

  const renderReport = (id: string) => {
    const report = testReport?.id === id ? testReport : null
    if (!report) return null
    return (
      <div className={`mt-2 rounded-lg border p-2 space-y-1 ${report.ok ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
        {report.steps.map((step) => (
          <div key={step.name} className="flex items-start gap-2 text-[10px] leading-relaxed">
            <span className={step.ok ? 'text-emerald-400' : 'text-red-400'}>{step.ok ? '✓' : '×'}</span>
            <span className="text-pi-text shrink-0">{step.name}</span>
            <span className="font-mono text-pi-text-dim break-all">{step.detail}</span>
          </div>
        ))}
      </div>
    )
  }

  const handleProviderChange = (p: Model['provider']) => {
    setProvider(p)
    const preset = providerPresets[p]
    if (preset) setBaseUrl(preset.baseUrl)
  }

  const handleAdd = () => {
    if (!displayName.trim() || !modelName.trim()) return
    addModel({
      id: `${provider}-${Date.now()}`,
      displayName: displayName.trim(),
      name: modelName.trim(),
      provider,
      apiKey: apiKey.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
      contextWindow: Number(contextWindow) || 0,
      maxInputTokens: Number(maxInput) || 0,
      maxOutputTokens: Number(maxOutput) || 0,
      supportsMultimodal: multimodal,
      disableThinking,
      thinkingControl,
    })
    resetForm()
  }

  const handleEdit = (m: Model) => {
    setEditingId(m.id)
    setDisplayName(m.displayName)
    setModelName(m.name)
    setProvider(m.provider)
    setApiKey(m.apiKey || '')
    setBaseUrl(m.baseUrl || '')
    setContextWindow(String(m.contextWindow))
    setMaxInput(String(m.maxInputTokens))
    setMaxOutput(String(m.maxOutputTokens))
    setMultimodal(m.supportsMultimodal)
    setDisableThinking(!!m.disableThinking)
    setThinkingControl(m.thinkingControl || 'qwen')
  }

  const handleSaveEdit = () => {
    if (!editingId) return
    updateModel(editingId, {
      displayName: displayName.trim(),
      name: modelName.trim(),
      provider,
      apiKey: apiKey.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
      contextWindow: Number(contextWindow) || 0,
      maxInputTokens: Number(maxInput) || 0,
      maxOutputTokens: Number(maxOutput) || 0,
      supportsMultimodal: multimodal,
      disableThinking,
      thinkingControl,
    })
    resetForm()
  }

  const resetForm = () => {
    setShowAdd(false)
    setEditingId(null)
    setDisplayName(''); setModelName(''); setApiKey(''); setBaseUrl('')
    setProvider('openai'); setContextWindow('200000'); setMaxInput('199000'); setMaxOutput('8192'); setMultimodal(false); setDisableThinking(false); setThinkingControl('qwen')
  }

  const isEditing = editingId !== null

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-sm font-semibold text-pi-text">模型管理</h2>
          <p className="text-[11px] text-pi-text-muted mt-0.5">配置 AI 模型及上下文参数</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-pi-accent text-pi-bg rounded-lg text-xs font-medium hover:bg-pi-accent-dim transition-colors"
        >
          + 添加模型
        </button>
      </div>

      {/* Add/Edit form */}
      {(showAdd || isEditing) && (
        <div className="mb-5 p-4 bg-pi-surface rounded-xl border border-pi-border space-y-3">
          <p className="text-[11px] font-medium text-pi-accent">{isEditing ? '编辑模型' : '添加新模型'}</p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-pi-text-muted block mb-1">显示名称</label>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="如：主力 Claude"
                className="w-full bg-pi-bg border border-pi-border rounded-lg px-3 py-2 text-xs outline-none focus:border-pi-accent/50" />
            </div>
            <div>
              <label className="text-[10px] text-pi-text-muted block mb-1">模型名称</label>
              <input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="如：claude-3-5-sonnet"
                className="w-full bg-pi-bg border border-pi-border rounded-lg px-3 py-2 text-xs outline-none focus:border-pi-accent/50" />
            </div>
            <div>
              <label className="text-[10px] text-pi-text-muted block mb-1">提供商</label>
              <select value={provider} onChange={(e) => handleProviderChange(e.target.value as Model['provider'])}
                className="w-full bg-pi-bg border border-pi-border rounded-lg px-3 py-2 text-xs outline-none focus:border-pi-accent/50">
                {Object.entries(providerPresets).map(([key, v]) => (
                  <option key={key} value={key}>{v.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-pi-text-muted block mb-1">API Key</label>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." type="password"
                className="w-full bg-pi-bg border border-pi-border rounded-lg px-3 py-2 text-xs outline-none focus:border-pi-accent/50" />
            </div>
            <div className="col-span-2">
              <label className="text-[10px] text-pi-text-muted block mb-1">Base URL</label>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1"
                className="w-full bg-pi-bg border border-pi-border rounded-lg px-3 py-2 text-xs outline-none focus:border-pi-accent/50" />
            </div>
          </div>

          {/* Context settings */}
          <div className="border-t border-pi-border pt-3">
            <p className="text-[10px] text-pi-text-muted mb-2 font-medium">上下文配置</p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] text-pi-text-dim block mb-1">上下文窗口</label>
                <div className="flex items-center gap-1">
                  <input type="number" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)}
                    className="w-full bg-pi-bg border border-pi-border rounded-lg px-2 py-1.5 text-[11px] outline-none focus:border-pi-accent/50" />
                  <span className="text-[9px] text-pi-text-dim">tok</span>
                </div>
              </div>
              <div>
                <label className="text-[10px] text-pi-text-dim block mb-1">最大输入</label>
                <div className="flex items-center gap-1">
                  <input type="number" value={maxInput} onChange={(e) => setMaxInput(e.target.value)}
                    className="w-full bg-pi-bg border border-pi-border rounded-lg px-2 py-1.5 text-[11px] outline-none focus:border-pi-accent/50" />
                  <span className="text-[9px] text-pi-text-dim">tok</span>
                </div>
              </div>
              <div>
                <label className="text-[10px] text-pi-text-dim block mb-1">最大输出</label>
                <div className="flex items-center gap-1">
                  <input type="number" value={maxOutput} onChange={(e) => setMaxOutput(e.target.value)}
                    className="w-full bg-pi-bg border border-pi-border rounded-lg px-2 py-1.5 text-[11px] outline-none focus:border-pi-accent/50" />
                  <span className="text-[9px] text-pi-text-dim">tok</span>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-pi-border/50">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-pi-text">多模态支持</span>
                {!multimodal && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    不支持图片输入
                  </span>
                )}
                {multimodal && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                    支持图片 + 文件
                  </span>
                )}
              </div>
              <ToggleSwitch checked={multimodal} onChange={() => setMultimodal(!multimodal)} />
            </div>
            <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-pi-border/50">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-pi-text">关闭思考</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-pi-surface text-pi-text-dim border border-pi-border">
                  {disableThinking ? '不返回推理内容' : '模型默认'}
                </span>
              </div>
              <ToggleSwitch checked={disableThinking} onChange={() => setDisableThinking(!disableThinking)} />
            </div>
            {disableThinking && (
              <div className="mt-2.5 pt-2 border-t border-pi-border/50 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-[11px] text-pi-text">控制方式</span>
                  <p className="text-[9px] text-pi-text-dim mt-0.5">按后端网关选，选错会因参数不被识别而报错</p>
                </div>
                <select value={thinkingControl} onChange={(e) => setThinkingControl(e.target.value as ThinkingControl)}
                  className="shrink-0 bg-pi-bg border border-pi-border rounded-lg px-2 py-1 text-[11px] outline-none focus:border-pi-accent/50">
                  {thinkingControlOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="flex gap-2 pt-1">
            {isEditing && (
              <button onClick={resetForm} className="px-4 py-1.5 border border-pi-border rounded-lg text-xs text-pi-text-muted hover:text-pi-text">
                取消
              </button>
            )}
            <button
              onClick={() => runTest('form', formConfig())}
              disabled={testingId !== null || !modelName.trim() || !baseUrl.trim()}
              title={!modelName.trim() || !baseUrl.trim() ? '先填模型名称与 Base URL' : '写入 Pi 并试连一次端点'}
              className="px-4 py-1.5 border border-pi-border rounded-lg text-xs text-pi-text hover:border-pi-accent/50 hover:text-pi-accent disabled:opacity-40 disabled:hover:border-pi-border disabled:hover:text-pi-text"
            >
              {testingId === 'form' ? '测试中…' : '测试连接'}
            </button>
            <button onClick={isEditing ? handleSaveEdit : handleAdd} className="px-4 py-1.5 bg-pi-accent text-pi-bg rounded-lg text-xs font-medium hover:bg-pi-accent-dim">
              {isEditing ? '保存' : '添加'}
            </button>
          </div>
          {renderReport('form')}
        </div>
      )}

      {/* Model list */}
      <div className="space-y-2">
        {models.map((m) => (
          <div
            key={m.id}
            className={`p-3.5 rounded-xl border transition-colors ${
              activeModelId === m.id ? 'border-pi-accent/40 bg-pi-accent/5' : 'border-pi-border bg-pi-surface'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button onClick={() => setActiveModel(m.id)}
                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                    activeModelId === m.id ? 'border-pi-accent' : 'border-pi-border'
                  }`}>
                  {activeModelId === m.id && <div className="w-2 h-2 rounded-full bg-pi-accent" />}
                </button>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-medium text-pi-text">{m.displayName}</p>
                    <span className="text-[10px] text-pi-text-dim font-mono">{m.name}</span>
                    {/* Multimodal badge */}
                    {m.supportsMultimodal ? (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">多模态</span>
                    ) : (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">纯文本</span>
                    )}
                  </div>
                  <p className="text-[10px] text-pi-text-dim mt-0.5">
                    {providerPresets[m.provider]?.label || m.provider} · {(m.contextWindow / 1000).toFixed(0)}K 上下文 · 输入 {(m.maxInputTokens / 1000).toFixed(0)}K / 输出 {(m.maxOutputTokens / 1000).toFixed(0)}K
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => runTest(m.id, {
                    provider: m.provider, model: m.name, displayName: m.displayName,
                    apiKey: m.apiKey || '', baseUrl: m.baseUrl || '',
                    contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens,
                    disableThinking: m.disableThinking,
                    thinkingControl: m.thinkingControl,
                  })}
                  disabled={testingId !== null}
                  className="text-[11px] text-pi-text-dim hover:text-pi-accent transition-colors disabled:opacity-40"
                >
                  {testingId === m.id ? '测试中…' : '测试'}
                </button>
                <button onClick={() => handleEdit(m)} className="text-[11px] text-pi-text-dim hover:text-pi-accent transition-colors">编辑</button>
                <button onClick={() => removeModel(m.id)} className="text-[11px] text-pi-text-dim hover:text-red-400 transition-colors">删除</button>
              </div>
            </div>
            {renderReport(m.id)}
          </div>
        ))}
      </div>
    </div>
  )
}

// ==================== 扩展管理 ====================
function ExtensionSection() {
  const {
    extensions, installedExtensions, extEnabled, extInstalling, extMessage,
    installExtension, uninstallExtension, toggleExtension, refreshExtensions, clearExtMessage,
  } = useAppStore()
  const [search, setSearch] = useState('')
  const [piInfo, setPiInfo] = useState<PiRuntimeInfo | null>(null)

  // Pi 运行时是随安装包内置的，这里只读状态用于展示，不会去下载任何东西
  useEffect(() => {
    window.piAPI?.piInfo?.().then(setPiInfo).catch(() => setPiInfo(null))
  }, [])

  const q = search.trim().toLowerCase()
  const catalog = q
    ? extensions.filter((e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q)))
    : extensions

  return (
    <div className="max-w-3xl">
      {/* MCP 是「外部工具」的正规接入方式，和扩展一起讲清楚 */}
      <McpSection />
      <div className="mb-5">
        <h2 className="text-sm font-semibold text-pi-text">扩展</h2>
        <p className="text-[11px] text-pi-text-muted mt-0.5">
          pi 引擎与下面这些扩展都随应用一起安装，启动即生效 —— 不用你自己装 pi，也不用敲任何命令
        </p>
        <p className="text-[10px] text-pi-text-dim mt-1 leading-relaxed">
          本应用就是 pi 引擎的可视化前端：引擎在后台负责加载扩展、调用模型、执行工具，
          界面负责展示与操作。这里的安装 / 卸载、启用 / 禁用直接作用于 pi 引擎自己的配置
          （~/.pi/agent），状态与 <span className="text-pi-text-muted">pi list</span> 完全一致。
        </p>
        <p className="text-[10px] text-pi-text-dim mt-1 leading-relaxed">
          扩展里若带 SKILL.md（纯提示词），可以单独启用 / 禁用：启用的技能会注入 Agent 系统提示词，
          禁用后立刻停止注入。
        </p>
        <div className="flex items-center gap-2 mt-2.5">
          <button
            onClick={() => window.piAPI?.openExtensionsDir?.()}
            className="px-2.5 py-1 rounded-lg text-[10px] text-pi-text-muted border border-pi-border hover:text-pi-text transition-colors"
          >
            打开扩展目录
          </button>
          <button
            onClick={() => { clearExtMessage(); refreshExtensions() }}
            className="px-2.5 py-1 rounded-lg text-[10px] text-pi-text-muted border border-pi-border hover:text-pi-text transition-colors"
          >
            重新扫描
          </button>
        </div>
        <p className="text-[10px] text-pi-text-dim mt-1.5">
          {piInfo === null
            ? 'Pi 引擎：检测中…'
            : piInfo.available
              ? `Pi 引擎：${piInfo.source === 'bundled' ? '已内置' : '已安装'}${piInfo.version ? ` v${piInfo.version}` : ''}${piInfo.nodeVersion ? ` · Node ${piInfo.nodeVersion}` : ''}`
              : 'Pi 引擎：未找到 —— 请确认安装包完整'}
        </p>
      </div>

      {extMessage && (
        <div className={`mb-4 px-3 py-2 rounded-lg text-[11px] flex items-start justify-between gap-3 ${
          extMessage.kind === 'ok' ? 'bg-pi-accent/10 text-pi-accent' : 'bg-red-500/10 text-red-400'
        }`}>
          <span className="leading-relaxed whitespace-pre-line break-all">{extMessage.text}</span>
          <button onClick={clearExtMessage} className="shrink-0 opacity-70 hover:opacity-100">×</button>
        </div>
      )}

      {/* 已安装：真实读磁盘 */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-xs font-medium text-pi-text">已安装</h3>
          <span className="text-[10px] text-pi-text-dim">{installedExtensions.length}</span>
        </div>
        <div className="space-y-2">
          {installedExtensions.map((ext) => (
            <InstalledCard
              key={ext.id}
              ext={ext}
              enabled={extEnabled[ext.id] !== false}
              onToggle={() => toggleExtension(ext.id)}
              onUninstall={() => uninstallExtension(ext.id)}
            />
          ))}
          {installedExtensions.length === 0 && (
            <p className="text-[11px] text-pi-text-dim py-5 text-center border border-dashed border-pi-border rounded-xl">
              还没有已安装的扩展，可从下面的内置扩展补齐
            </p>
          )}
        </div>
      </div>

      {/* 内置扩展：随应用打包，首次启动自动同步 */}
      <div>
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium text-pi-text">内置扩展</h3>
            <span className="text-[10px] text-pi-text-dim">{extensions.length}</span>
          </div>
          <div className="relative">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索名称、功能或标签..."
              className="w-52 bg-pi-surface border border-pi-border rounded-lg pl-7 pr-3 py-1.5 text-[11px] outline-none focus:border-pi-accent/50"
            />
            <svg className="absolute left-2 top-2 text-pi-text-dim" width="11" height="11" viewBox="0 0 14 14" fill="none">
              <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.5" />
              <path d="M9 9L12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        </div>
        <p className="text-[10px] text-pi-text-dim mb-2.5">
          随应用一起发布，首次启动已自动装好；万一某项缺失，点「安装」即可补回来。
        </p>
        <div className="space-y-2">
          {catalog.map((item) => (
            <CatalogCard
              key={item.id}
              item={item}
              installing={extInstalling.includes(item.source)}
              onInstall={() => installExtension(item.source)}
            />
          ))}
          {catalog.length === 0 && (
            <p className="text-xs text-pi-text-dim text-center py-8">无匹配扩展</p>
          )}
        </div>
      </div>
    </div>
  )
}

function InstalledCard({ ext, enabled, onToggle, onUninstall }: {
  ext: InstalledExtension
  enabled: boolean
  onToggle: () => void
  onUninstall: () => void
}) {
  const isSkill = ext.kind === 'skill'
  return (
    <div className={`p-3.5 rounded-xl border ${
      isSkill && enabled ? 'border-pi-accent/30 bg-pi-accent/5' : 'border-pi-border bg-pi-surface'
    }`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs font-medium text-pi-text truncate">{ext.name}</p>
            <span className={`text-[9px] px-1.5 py-0.5 rounded shrink-0 ${
              isSkill ? 'bg-purple-500/10 text-purple-400' : 'bg-blue-500/10 text-blue-400'
            }`}>
              {isSkill ? '技能' : 'Pi 包'}
            </span>
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-pi-bg border border-pi-border text-pi-text-dim shrink-0">
              {ext.scope === 'global' ? '全局' : '项目'}
            </span>
          </div>
          {ext.description && <p className="text-[11px] text-pi-text-dim mt-1.5">{ext.description}</p>}
          {ext.viaPackage && (
            <p className="text-[10px] text-pi-text-dim mt-1">来自 pi 包 {ext.viaPackage}，可单独启用 / 禁用</p>
          )}
          <p className="text-[10px] text-pi-text-dim mt-1.5 truncate" title={ext.dir}>{ext.dir}</p>
        </div>

        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {isSkill ? (
            <>
              <ToggleSwitch checked={enabled} onChange={onToggle} />
              {ext.readonly ? (
                <span className="text-[10px] text-pi-text-dim text-right leading-tight max-w-[150px]">
                  随包安装，卸载请删上面的包
                </span>
              ) : (
                <button onClick={onUninstall} className="text-[10px] text-pi-text-dim hover:text-red-400 transition-colors">卸载</button>
              )}
            </>
          ) : (
            <>
              <span className="text-[9px] text-pi-text-dim text-right leading-tight max-w-[150px]">
                已装好，pi 引擎启动时自动加载
              </span>
              <button onClick={onUninstall} className="text-[10px] text-pi-text-dim hover:text-red-400 transition-colors">卸载</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function CatalogCard({ item, installing, onInstall }: {
  item: ExtensionCatalogItem
  installing: boolean
  onInstall: () => void
}) {
  return (
    <div className="p-3.5 rounded-xl border border-pi-border bg-pi-bg">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs font-medium text-pi-text truncate">{item.name}</p>
            {item.version && <span className="text-[10px] text-pi-text-dim shrink-0">v{item.version}</span>}
            <span className={`text-[9px] px-1.5 py-0.5 rounded shrink-0 ${
              item.hasSkills
                ? 'bg-purple-500/10 text-purple-400'
                : 'bg-pi-surface border border-pi-border text-pi-text-dim'
            }`}>
              {item.hasSkills ? '含技能' : '扩展'}
            </span>
          </div>
          <p className="text-[11px] text-pi-text-dim mt-1.5">{item.description}</p>
          {item.tags.length > 0 && (
            <div className="flex items-center gap-1 mt-1.5 flex-wrap">
              {item.tags.map((t) => (
                <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-pi-surface border border-pi-border text-pi-text-dim">{t}</span>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0">
          {item.installed ? (
            <span className="text-[10px] text-pi-accent">已安装</span>
          ) : (
            <button
              onClick={onInstall}
              disabled={installing}
              className="px-2.5 py-1.5 bg-pi-accent text-pi-bg rounded-lg text-[10px] font-medium hover:bg-pi-accent-dim transition-colors disabled:opacity-60"
            >
              {installing ? '安装中…' : '安装'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ==================== 技能管理 ====================
function SkillSection() {
  const { skills, toggleSkill, addSkill, removeSkill } = useAppStore()
  const [showAdd, setShowAdd] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('tools')

  const handleAdd = () => {
    if (!name.trim()) return
    addSkill({
      id: `custom-${Date.now()}`,
      name: name.trim(),
      description: description.trim() || '自定义技能',
      enabled: true,
      category,
      source: 'custom',
    })
    setShowAdd(false)
    setName(''); setDescription(''); setCategory('tools')
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-sm font-semibold text-pi-text">技能管理</h2>
          <p className="text-[11px] text-pi-text-muted mt-0.5">控制 Agent 可用的工具和技能</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-pi-accent text-pi-bg rounded-lg text-xs font-medium hover:bg-pi-accent-dim transition-colors"
        >
          + 添加技能
        </button>
      </div>

      {showAdd && (
        <div className="mb-4 p-4 bg-pi-surface rounded-xl border border-pi-border space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="技能名称"
            className="w-full bg-pi-bg border border-pi-border rounded-lg px-3 py-2 text-xs outline-none focus:border-pi-accent/50" />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="描述"
            className="w-full bg-pi-bg border border-pi-border rounded-lg px-3 py-2 text-xs outline-none focus:border-pi-accent/50" />
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className="w-full bg-pi-bg border border-pi-border rounded-lg px-3 py-2 text-xs outline-none">
            <option value="tools">工具</option>
            <option value="research">研究</option>
            <option value="analysis">分析</option>
            <option value="creative">创作</option>
            <option value="custom">自定义</option>
          </select>
          <button onClick={handleAdd} className="w-full py-2 bg-pi-accent text-pi-bg rounded-lg text-xs font-medium hover:bg-pi-accent-dim">
            添加
          </button>
        </div>
      )}

      <div className="space-y-2">
        {skills.map((s) => (
          <div key={s.id} className={`flex items-center justify-between p-3 rounded-xl border ${
            s.enabled ? 'border-pi-accent/20 bg-pi-surface' : 'border-pi-border bg-pi-bg'
          }`}>
            <div className="min-w-0 flex-1">
              <p className={`text-xs font-medium ${s.enabled ? 'text-pi-text' : 'text-pi-text-muted'}`}>{s.name}</p>
              <p className="text-[10px] text-pi-text-dim">{s.description}</p>
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
              <ToggleSwitch checked={s.enabled} onChange={() => toggleSkill(s.id)} />
              {s.source === 'custom' && (
                <button onClick={() => removeSkill(s.id)} className="text-[10px] text-pi-text-dim hover:text-red-400">删除</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ==================== 终端设置 ====================
function TerminalSection() {
  const { pythonEnvs, activePythonEnv, setPythonEnv } = useAppStore()

  return (
    <div className="max-w-xl">
      <div className="mb-5">
        <h2 className="text-sm font-semibold text-pi-text">终端设置</h2>
        <p className="text-[11px] text-pi-text-muted mt-0.5">选择默认 Python 运行环境</p>
      </div>
      <div className="space-y-2">
        <button
          onClick={() => setPythonEnv('system')}
          className={`w-full flex items-center gap-3 p-3 rounded-xl border text-xs transition-colors ${
            activePythonEnv === 'system' ? 'border-pi-accent/50 bg-pi-accent/5' : 'border-pi-border bg-pi-surface hover:border-pi-border/80'
          }`}
        >
          <span className="w-6 h-6 rounded bg-green-500/10 flex items-center justify-center text-[10px]">Py</span>
          <div className="text-left">
            <p className="text-pi-text font-medium">System Python</p>
            <p className="text-[10px] text-pi-text-dim">系统默认 Python</p>
          </div>
          {activePythonEnv === 'system' && <span className="ml-auto text-pi-accent text-xs">✓</span>}
        </button>
        {pythonEnvs.map((env) => (
          <button
            key={env.name}
            onClick={() => setPythonEnv(env.name)}
            className={`w-full flex items-center gap-3 p-3 rounded-xl border text-xs transition-colors ${
              activePythonEnv === env.name ? 'border-pi-accent/50 bg-pi-accent/5' : 'border-pi-border bg-pi-surface hover:border-pi-border/80'
            }`}
          >
            <span className="w-6 h-6 rounded bg-blue-500/10 flex items-center justify-center text-[10px]">Py</span>
            <div className="text-left">
              <p className="text-pi-text font-medium">{env.name}</p>
              {env.path && <p className="text-[10px] text-pi-text-dim">{env.path}</p>}
            </div>
            {activePythonEnv === env.name && <span className="ml-auto text-pi-accent text-xs">✓</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

// ==================== 环境设置 ====================
function EnvSection() {
  const {
    pythonEnvs, activePythonEnv, setPythonEnv, refreshPythonEnvs, addPythonEnv, removePythonEnv, currentDir,
  } = useAppStore()
  const [refreshing, setRefreshing] = useState(false)
  /** 从目录选择器选中的、已通过校验的环境（null 表示还没选到有效环境） */
  const [pickedEnv, setPickedEnv] = useState<{ name: string; path: string } | null>(null)
  const [addError, setAddError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [shellType, setShellType] = useState<'powershell' | 'cmd' | 'bash'>('powershell')

  const refreshEnvs = async () => {
    setRefreshing(true)
    try {
      const envs = await window.piAPI?.listPythonEnvs() || []
      refreshPythonEnvs(envs.map((e) => ({ name: e.name, path: e.path })))
    } catch {
      // ignore
    }
    setRefreshing(false)
  }

  // 只能通过目录选择器添加：手填路径没法保证真的是一个可用的 Python 环境
  const handlePickEnvDir = async () => {
    const dir = await window.piAPI?.openFolderDialog?.()
    if (!dir) return
    const res = await window.piAPI?.inspectPythonEnv?.(dir)
    if (!res || !res.ok) {
      setPickedEnv(null)
      setAddError(res?.error || '该目录不是有效的 Python 环境')
      return
    }
    if (pythonEnvs.some((e) => e.path === res.env.path)) {
      setPickedEnv(null)
      setAddError(`「${res.env.name}」已在环境列表中`)
      return
    }
    setAddError('')
    setPickedEnv(res.env)
  }

  const handleAddEnv = () => {
    if (!pickedEnv) return
    addPythonEnv(pickedEnv)
    setShowAdd(false)
    setPickedEnv(null)
    setAddError('')
  }

  const handleRemoveEnv = (env: { name: string; path: string }) => {
    removePythonEnv(env)
    if (activePythonEnv === env.name) setPythonEnv('system')
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-5">
        <h2 className="text-sm font-semibold text-pi-text">环境设置</h2>
        <p className="text-[11px] text-pi-text-muted mt-0.5">配置 Python 环境和默认 Shell，Agent 和手动运行共用</p>
      </div>

      {/* 当前工作目录 */}
      {currentDir && (
        <div className="mb-4 p-3 rounded-xl bg-pi-surface border border-pi-border">
          <p className="text-[10px] text-pi-text-dim mb-1">当前工作目录</p>
          <p className="text-xs font-mono text-pi-text truncate">{currentDir}</p>
        </div>
      )}

      {/* Python 环境 */}
      <div className="mb-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-pi-text">Python 环境</p>
          <div className="flex gap-2">
            <button
              onClick={refreshEnvs}
              disabled={refreshing}
              className="flex items-center gap-1 px-2.5 py-1 text-[10px] text-pi-text-muted hover:text-pi-text border border-pi-border rounded-lg transition-colors disabled:opacity-50"
            >
              <span className={refreshing ? 'animate-spin inline-block' : ''}>↻</span> 刷新
            </button>
            <button
              onClick={() => setShowAdd(!showAdd)}
              className="flex items-center gap-1 px-2.5 py-1 text-[10px] text-pi-accent border border-pi-accent/30 rounded-lg hover:bg-pi-accent/5 transition-colors"
            >
              + 添加
            </button>
          </div>
        </div>

        {showAdd && (
          <div className="mb-3 p-3 bg-pi-surface rounded-xl border border-pi-border space-y-2">
            <button
              onClick={handlePickEnvDir}
              className="w-full flex items-center gap-2 bg-pi-bg border border-pi-border rounded-lg px-3 py-2 text-xs text-pi-text-muted hover:text-pi-text hover:border-pi-accent/50 transition-colors"
            >
              <span>📂</span>
              <span>选择环境目录…</span>
            </button>
            {pickedEnv && (
              <div className="px-1">
                <p className="text-xs font-medium text-pi-text">{pickedEnv.name}</p>
                <p className="text-[10px] text-pi-text-dim font-mono break-all">{pickedEnv.path}</p>
              </div>
            )}
            {addError && <p className="text-[10px] text-red-400">{addError}</p>}
            <button
              onClick={handleAddEnv}
              disabled={!pickedEnv}
              className="px-3 py-1.5 bg-pi-accent text-pi-bg rounded-lg text-[10px] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              添加
            </button>
          </div>
        )}

        <div className="space-y-1.5">
          {/* System Python */}
          <button
            onClick={() => setPythonEnv('system')}
            className={`w-full flex items-center gap-3 p-2.5 rounded-xl border text-xs transition-colors ${
              activePythonEnv === 'system' ? 'border-pi-accent/50 bg-pi-accent/5' : 'border-pi-border bg-pi-surface hover:border-pi-border/80'
            }`}
          >
            <span className="w-6 h-6 rounded bg-green-500/10 flex items-center justify-center text-[10px]">Py</span>
            <div className="text-left flex-1">
              <p className="text-pi-text font-medium">System Python</p>
              <p className="text-[10px] text-pi-text-dim">系统默认 Python</p>
            </div>
            {activePythonEnv === 'system' && <span className="text-pi-accent text-xs">✓</span>}
          </button>

          {pythonEnvs.map((env) => (
            <div
              key={env.name}
              className={`w-full flex items-center gap-3 p-2.5 rounded-xl border text-xs transition-colors ${
                activePythonEnv === env.name ? 'border-pi-accent/50 bg-pi-accent/5' : 'border-pi-border bg-pi-surface'
              }`}
            >
              <button onClick={() => setPythonEnv(env.name)} className="flex items-center gap-3 flex-1 text-left">
                <span className="w-6 h-6 rounded bg-blue-500/10 flex items-center justify-center text-[10px]">Py</span>
                <div className="flex-1">
                  <p className="text-pi-text font-medium">{env.name}</p>
                  {env.path && <p className="text-[10px] text-pi-text-dim font-mono truncate">{env.path}</p>}
                </div>
                {activePythonEnv === env.name && <span className="text-pi-accent text-xs">✓</span>}
              </button>
              <button onClick={() => handleRemoveEnv(env)} className="text-[10px] text-pi-text-dim hover:text-red-400 transition-colors shrink-0">删除</button>
            </div>
          ))}

          {pythonEnvs.length === 0 && (
            <p className="text-[11px] text-pi-text-dim text-center py-3">未检测到 conda 环境，点击刷新或手动添加</p>
          )}
        </div>
      </div>

      {/* Shell 设置 */}
      <div className="mb-5">
        <p className="text-xs font-medium text-pi-text mb-3">默认 Shell</p>
        <div className="space-y-1.5">
          {[
            { id: 'powershell' as const, label: 'PowerShell', desc: 'Windows PowerShell' },
            { id: 'cmd' as const, label: 'CMD', desc: '命令提示符' },
            { id: 'bash' as const, label: 'Bash', desc: 'Git Bash / WSL' },
          ].map((s) => (
            <button
              key={s.id}
              onClick={() => setShellType(s.id)}
              className={`w-full flex items-center gap-3 p-2.5 rounded-xl border text-xs transition-colors ${
                shellType === s.id ? 'border-pi-accent/50 bg-pi-accent/5' : 'border-pi-border bg-pi-surface hover:border-pi-border/80'
              }`}
            >
              <span className="w-6 h-6 rounded bg-amber-500/10 flex items-center justify-center text-[10px]">&gt;_</span>
              <div className="text-left flex-1">
                <p className="text-pi-text font-medium">{s.label}</p>
                <p className="text-[10px] text-pi-text-dim">{s.desc}</p>
              </div>
              {shellType === s.id && <span className="text-pi-accent text-xs">✓</span>}
            </button>
          ))}
        </div>
      </div>

      {/* 安全说明 */}
      <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/10">
        <p className="text-[10px] font-medium text-amber-400 mb-1">安全提示</p>
        <p className="text-[11px] text-pi-text-muted leading-relaxed">
          Agent 的文件操作仅限于当前工作目录内。敏感文件（.env、SSH 密钥、.git/config 等）受保护不可修改。
          打开新目录时安全边界自动更新。
        </p>
      </div>
    </div>
  )
}
