import { useEffect, useState } from 'react'
import type { McpServer } from '../../types'

/**
 * MCP server 管理。
 *
 * MCP 是把「外部工具」接进 Agent 的标准协议：每个 server 是一个子进程，
 * 它暴露的工具会以 mcp__<server>__<tool> 的名字注册给模型，用法和内置工具一样。
 * 客户端是本应用自研的，不依赖 pi CLI，也不执行任何第三方扩展代码。
 *
 * 内置的 git server 随包发布、只读、无需安装，所以这里开箱就有一项是绿的。
 */
const STATUS_STYLE: Record<McpServer['status'], { dot: string; label: string }> = {
  ready: { dot: 'bg-green-400', label: '已连接' },
  connecting: { dot: 'bg-amber-400', label: '连接中' },
  error: { dot: 'bg-red-400', label: '连接失败' },
  idle: { dot: 'bg-pi-text-dim', label: '未连接' },
}

export default function McpSection() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', command: '', args: '' })

  const reload = async () => {
    try {
      setServers((await window.piAPI?.listMcpServers?.()) || [])
    } catch {
      setServers([])
    }
  }

  useEffect(() => {
    reload()
  }, [])

  // 每个操作都走这里：期间禁用按钮，结束后刷新列表把最新的连接状态显示出来
  const run = async (key: string, fn: () => Promise<{ ok?: boolean; error?: string } | undefined>) => {
    setBusy(key)
    setMessage('')
    try {
      const r = await fn()
      if (r && r.ok === false && r.error) setMessage(r.error)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
    setBusy('')
    await reload()
  }

  const handleAdd = async () => {
    if (!form.command.trim()) {
      setMessage('至少要填启动命令')
      return
    }
    await run('add', () =>
      window.piAPI!.addMcpServer({
        name: form.name.trim() || form.command.trim(),
        command: form.command.trim(),
        args: form.args.trim(),
      }),
    )
    setForm({ name: '', command: '', args: '' })
    setAdding(false)
  }

  return (
    <div className="mb-5 rounded-xl border border-pi-border bg-pi-surface p-3.5">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-[12px] font-semibold text-pi-text">MCP 工具</h3>
        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
          自研客户端
        </span>
        <div className="flex-1" />
        <button
          onClick={() => run('all', () => window.piAPI!.refreshMcpServers())}
          disabled={busy !== ''}
          className="text-[10px] px-2 py-1 rounded-md text-pi-text-muted hover:text-pi-text hover:bg-pi-hover transition-colors disabled:opacity-50"
        >
          {busy === 'all' ? '重连中…' : '全部重连'}
        </button>
      </div>
      <p className="text-[10px] text-pi-text-dim leading-relaxed mb-3">
        server 连上后，它提供的工具会以 <span className="text-pi-text-muted">mcp__server__tool</span> 的名字
        直接交给 Agent 使用，和内置工具没有区别。内置的 Git server 随包发布、只读，因此开箱即用。
      </p>

      <div className="space-y-2">
        {servers.map((s) => {
          const st = STATUS_STYLE[s.status] || STATUS_STYLE.idle
          return (
            <div key={s.id} className="rounded-lg border border-pi-border/60 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.dot}`} />
                <span className="text-[11px] text-pi-text truncate">{s.name}</span>
                {s.builtin && (
                  <span className="text-[9px] px-1 py-px rounded bg-pi-hover text-pi-text-dim">内置</span>
                )}
                <span className="text-[9px] text-pi-text-dim">{st.label}</span>
                {s.status === 'ready' && (
                  <span className="text-[9px] text-pi-text-dim">· {s.tools.length} 个工具</span>
                )}
                <div className="flex-1" />
                {s.status !== 'ready' && s.enabled && (
                  <button
                    onClick={() => run(s.id, () => window.piAPI!.refreshMcpServers(s.id))}
                    disabled={busy !== ''}
                    className="text-[9px] text-pi-text-dim hover:text-pi-accent disabled:opacity-50"
                  >
                    重试
                  </button>
                )}
                <button
                  onClick={() => run(`t${s.id}`, () => window.piAPI!.toggleMcpServer(s.id, !s.enabled))}
                  disabled={busy !== ''}
                  className={`text-[9px] disabled:opacity-50 ${s.enabled ? 'text-pi-text-dim hover:text-amber-400' : 'text-pi-accent'}`}
                >
                  {s.enabled ? '禁用' : '启用'}
                </button>
                {!s.builtin && (
                  <button
                    onClick={() => run(`d${s.id}`, () => window.piAPI!.removeMcpServer(s.id))}
                    disabled={busy !== ''}
                    className="text-[9px] text-pi-text-dim hover:text-red-400 disabled:opacity-50"
                  >
                    删除
                  </button>
                )}
              </div>

              <div className="text-[10px] text-pi-text-dim mt-1 truncate font-mono">
                {s.command} {(s.args || []).join(' ')}
              </div>
              {s.description && (
                <div className="text-[10px] text-pi-text-dim mt-0.5 leading-relaxed">{s.description}</div>
              )}
              {s.status === 'error' && s.error && (
                <div className="text-[10px] text-red-400/90 mt-1 leading-relaxed">{s.error}</div>
              )}
              {s.status === 'ready' && s.tools.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {s.tools.map((t) => (
                    <span key={t.name} className="text-[9px] px-1.5 py-px rounded bg-pi-bg text-pi-text-muted border border-pi-border/60">
                      {t.raw}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {message && <div className="text-[10px] text-amber-400 mt-2 leading-relaxed">{message}</div>}

      {adding ? (
        <div className="mt-3 pt-2.5 border-t border-pi-border/60 space-y-2">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="名称（英文或数字，如 filesystem）"
            className="w-full bg-pi-bg border border-pi-border rounded-md px-2 py-1.5 text-[11px] text-pi-text outline-none focus:border-pi-accent/40"
          />
          <input
            value={form.command}
            onChange={(e) => setForm({ ...form, command: e.target.value })}
            placeholder="启动命令（如 npx）"
            className="w-full bg-pi-bg border border-pi-border rounded-md px-2 py-1.5 text-[11px] text-pi-text outline-none focus:border-pi-accent/40"
          />
          <input
            value={form.args}
            onChange={(e) => setForm({ ...form, args: e.target.value })}
            placeholder="参数（空格分隔，如 -y @modelcontextprotocol/server-filesystem D:\\work）"
            className="w-full bg-pi-bg border border-pi-border rounded-md px-2 py-1.5 text-[11px] text-pi-text outline-none focus:border-pi-accent/40"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleAdd}
              disabled={busy !== ''}
              className="text-[10px] px-2.5 py-1 rounded-md bg-pi-accent text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'add' ? '连接中…' : '添加并连接'}
            </button>
            <button
              onClick={() => { setAdding(false); setMessage('') }}
              className="text-[10px] px-2 py-1 rounded-md text-pi-text-muted hover:text-pi-text"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mt-3 pt-2.5 border-t border-pi-border/60 w-full text-left text-[10px] text-pi-text-muted hover:text-pi-accent"
        >
          + 添加 MCP server
        </button>
      )}
    </div>
  )
}
