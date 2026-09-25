import type { AgentStatusEvent, FileDiff, ProcessEvent } from '../../types'

// ==================== 状态 → 时间线 ====================

/**
 * 会被记进过程时间线的状态。
 * asking / action 也必须记：模型停下来等你回答、或去更新任务清单时，
 * 时间线上什么都不出现的话，界面看起来就是「卡住了」，其实它在等你。
 * 注意不含 thinking —— 那是每轮都有的临时状态（正在调用模型…），记下来只会刷屏。
 */
export const TIMELINE_STATES = [
  'reading', 'searching', 'web_searching', 'web_fetching', 'editing', 'executing', 'asking', 'action', 'tool',
]

export function isTimelineState(state: string): boolean {
  return TIMELINE_STATES.includes(state)
}

/**
 * agent:status → 时间线事件。纯函数，便于在界面里直接当 reducer 用。
 * tool_output / tool_end 不是新动作，而是回填已经在跑的那一条。
 */
export function appendStatusEvent(prev: ProcessEvent[], status: AgentStatusEvent): ProcessEvent[] {
  switch (status.state) {
    case 'notice':
      // 扩展的通知、压缩结果、重试结果：没有 detail 就没什么可说的
      return status.detail
        ? [...prev, { kind: 'notice', text: status.detail, noticeType: status.noticeType }]
        : prev
    case 'thinking_output':
      return status.detail ? [...prev, { kind: 'text', text: status.detail }] : prev
    case 'tool_output':
    case 'tool_end':
      return patchTool(prev, status)
    default:
      if (!isTimelineState(status.state)) return prev
      // 同一次工具调用会被上报两次：模型开始生成参数时（只有工具名，用来早点亮出
      // 「正在编辑」）、真正执行时（带文件名）。两次的 id 未必一致，所以先按 id 认，
      // 认不出来就把「还在跑、还没有细节」的同类条目认领过来 —— 否则时间线上会多一条。
      const claimed = claimRunningTool(prev, status)
      if (claimed) return claimed
      return [...prev, {
        kind: 'tool',
        state: status.state,
        detail: status.detail,
        ref: status.toolCallId,
        status: 'running',
      }]
  }
}

/** 把新的工具状态并进已经存在的那条，没有可并的就返回 null */
function claimRunningTool(events: ProcessEvent[], status: AgentStatusEvent): ProcessEvent[] | null {
  let idx = -1
  if (status.toolCallId) {
    idx = events.findIndex((ev) => ev.kind === 'tool' && ev.ref === status.toolCallId)
    if (idx === -1) {
      idx = events.findIndex((ev) => (
        ev.kind === 'tool' && ev.status === 'running' && !ev.detail && ev.state === status.state
      ))
    }
  }
  if (idx === -1) return null
  const next = events.slice()
  const current = next[idx]
  next[idx] = {
    ...current,
    state: status.state,
    detail: status.detail || current.detail,
    ref: status.toolCallId || current.ref,
    status: 'running',
  }
  return next
}

/** 把流式输出 / 结束状态回填到对应那条工具动作上（pi 用 toolCallId 关联整条生命周期） */
function patchTool(events: ProcessEvent[], update: AgentStatusEvent): ProcessEvent[] {
  if (!update.toolCallId) return events
  let patched = false
  const next = events.map((ev) => {
    if (patched || ev.kind !== 'tool' || ev.ref !== update.toolCallId) return ev
    patched = true
    if (update.state === 'tool_output') return { ...ev, output: update.detail || ev.output }
    return {
      ...ev,
      status: update.isError ? 'error' as const : 'done' as const,
      durationMs: update.durationMs,
      // 失败时 detail 带的是原因，覆盖显示，不然只能看到工具名
      output: update.detail || ev.output,
    }
  })
  return patched ? next : events
}

// ==================== 文案 ====================

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`
}

export function getStatusLabel(state: string): string {
  const map: Record<string, string> = {
    thinking: '思考中', thinking_output: '输出中', searching: '搜索代码库', reading: '读取文件',
    editing: '正在编辑文件', executing: '执行命令', web_searching: '联网搜索', web_fetching: '抓取网页',
    asking: '等待你的回答', action: '处理中', tool: '调用工具', notice: '扩展通知',
    tool_output: '执行中', tool_end: '执行中',
    interrupted: '已中断', error: '出错了',
  }
  return map[state] || '处理中'
}

/** 动完之前说进行时、动完才说过去时——不然「正在编辑」会被说成「已编辑」 */
const GROUP_LABEL: Record<string, { running: (n: number) => string; done: (n: number) => string }> = {
  reading: { running: (n) => `正在读取 ${n} 个文件`, done: (n) => `已读取 ${n} 个文件` },
  searching: { running: (n) => `正在搜索 ${n} 次`, done: (n) => `搜索了 ${n} 次文件` },
  web_searching: { running: (n) => `正在联网搜索 ${n} 次`, done: (n) => `联网搜索 ${n} 次` },
  web_fetching: { running: (n) => `正在抓取 ${n} 个网页`, done: (n) => `已抓取 ${n} 个网页` },
  editing: { running: (n) => `正在编辑 ${n} 个文件`, done: (n) => `已编辑 ${n} 个文件` },
  executing: { running: (n) => `正在执行 ${n} 条命令`, done: (n) => `已执行 ${n} 条命令` },
  asking: { running: (n) => `正在向你确认 ${n} 次`, done: (n) => `提问 ${n} 次` },
  action: { running: (n) => `正在更新状态 ${n} 次`, done: (n) => `状态更新 ${n} 次` },
  tool: { running: (n) => `正在调用工具 ${n} 次`, done: (n) => `调用工具 ${n} 次` },
}

/**
 * @param running 这一组里还有工具在跑：文案用进行时。
 */
export function getToolGroupLabel(state: string, count: number, running = false): string {
  const pair = GROUP_LABEL[state]
  if (pair) return (running ? pair.running : pair.done)(count)
  const fallback = getStatusLabel(state)
  return running ? `正在${fallback}` : `${fallback} ${count} 次`
}

/** 详情里已经带了动词（如「读取: xxx」），展示时换成统一说法 */
const ITEM_VERB: Record<string, [running: string, done: string]> = {
  reading: ['正在读取', '已读取'],
  editing: ['正在编辑', '已修改'],
  executing: ['正在执行', '已执行'],
  web_searching: ['正在联网搜索', '联网搜索'],
  web_fetching: ['正在抓取', '已抓取'],
  tool: ['正在调用', '调用'],
}

function toolItemText(state: string, detail?: string, running = false): string {
  const rest = (detail || '')
    .replace(/^(已?读取|写入|编辑|多处编辑|执行|搜索|列目录|联网搜索|抓取网页|抓取|应用补丁)\s*[:：]\s*/, '')
    .trim()
  if (state === 'asking') return rest ? `等待你的回答：${rest}` : '等待你的回答'
  const verb = ITEM_VERB[state]
  if (verb) {
    const text = running ? verb[0] : verb[1]
    return rest ? `${text} ${rest}` : text
  }
  return rest || getStatusLabel(state)
}

// ==================== 时间线结构 ====================

export type ToolItem = {
  text: string
  state: string
  ref?: string
  /** 工具跑的时候的输出（长命令就靠它看到进度） */
  output?: string
  status?: 'running' | 'done' | 'error'
  durationMs?: number
}

/** 时间线节点：连续的同类工具调用合并成一组，文件改动与其余内容原样保留 */
export type TimelineNode =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'notice'; text: string; noticeType?: string }
  | { type: 'tools'; state: string; items: ToolItem[] }
  | { type: 'diff'; diff: FileDiff }

/**
 * @param settle 任务已结束时传 true：自研引擎不回报工具的完成事件，
 *   那些条目会一直停在 running，收尾时按「状态未知」显示，不冒充完成也不假装还在跑。
 */
export function buildTimeline(events: ProcessEvent[], settle = false): TimelineNode[] {
  const nodes: TimelineNode[] = []
  for (const ev of events) {
    if (ev.kind === 'diff' && ev.diff) {
      nodes.push({ type: 'diff', diff: ev.diff })
    } else if (ev.kind === 'tool') {
      const state = ev.state || ''
      // 任务已经收尾（settle）时不认「还在跑」，文案统一回到过去时
      const running = !settle && ev.status === 'running'
      const item: ToolItem = {
        text: toolItemText(state, ev.detail, running),
        state,
        ref: ev.ref,
        output: ev.output,
        status: running ? 'running' : (settle && ev.status === 'running' ? undefined : ev.status),
        durationMs: ev.durationMs,
      }
      const last = nodes[nodes.length - 1]
      if (last && last.type === 'tools' && last.state === state) last.items.push(item)
      else nodes.push({ type: 'tools', state, items: [item] })
    } else if (ev.kind === 'notice' && ev.text) {
      nodes.push({ type: 'notice', text: ev.text, noticeType: ev.noticeType })
    } else if (ev.text) {
      nodes.push({ type: ev.kind === 'thinking' ? 'thinking' : 'text', text: ev.text })
    }
  }
  return nodes
}
