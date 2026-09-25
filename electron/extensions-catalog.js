/**
 * 内置扩展清单（纯数据）。
 *
 * 这 8 个扩展是本应用的一部分：构建时由 scripts/vendor-pi.js 装进 vendor/pi-extensions，
 * 随安装包一起分发；首次启动时 electron/pi-bundled-extensions.js 把它们放进 pi 引擎的
 * 包目录（~/.pi/agent），之后 pi 引擎启动即自动加载 —— 用户不需要自己执行任何 pi 命令。
 *
 * 每个包都在 npm 上核实存在，版本号与描述不虚构。
 */

const DEFAULT_CATALOG = [
  {
    id: 'pi-subagents',
    name: 'pi-subagents',
    source: 'npm:pi-subagents',
    version: '0.71.0',
    description: '子智能体编排：并行分派多个子代理，各自独立跑完再汇总',
    hasSkills: true,
    tags: ['subagent', 'parallel'],
  },
  {
    id: 'pi-hermes-memory',
    name: 'pi-hermes-memory',
    source: 'npm:pi-hermes-memory',
    version: '0.9.9',
    description: '跨会话长期记忆：把结论沉淀下来，之后的会话自动带上',
    hasSkills: false,
    tags: ['memory', 'context'],
  },
  {
    id: 'pi-lens',
    name: 'pi-lens',
    source: 'npm:pi-lens',
    version: '4.2.1',
    description: '代码洞察：LSP 诊断、结构分析与自动格式化',
    hasSkills: true,
    tags: ['lsp', 'lint', 'format'],
  },
  {
    id: 'pi-simplify',
    name: 'pi-simplify',
    source: 'npm:pi-simplify',
    version: '0.2.3',
    description: '简化审查：对最近的改动找出冗余与过度设计',
    hasSkills: false,
    tags: ['review', 'refactor'],
  },
  {
    id: 'cc-safety-net',
    name: 'cc-safety-net',
    source: 'npm:cc-safety-net',
    version: '2.4.6',
    description: '安全护栏：拦截不可逆命令，保护凭据文件',
    hasSkills: false,
    tags: ['safety', 'guard'],
  },
  {
    id: 'rpiv-todo',
    name: 'rpiv-todo',
    source: 'npm:rpiv-todo',
    version: '1.1.0',
    description: '待办清单驱动：把任务拆成可勾选的步骤并推进',
    hasSkills: false,
    tags: ['todo', 'workflow'],
  },
  {
    id: 'pi-plan-mode',
    name: '@narumitw/pi-plan-mode',
    source: 'npm:@narumitw/pi-plan-mode',
    version: '0.58.3',
    description: '计划模式：先只读调研并提交计划，确认后才动手改代码',
    hasSkills: false,
    tags: ['plan', 'confirm'],
  },
  {
    id: 'pi-web-access',
    name: 'pi-web-access',
    source: 'npm:pi-web-access',
    version: '0.31.0',
    description: '联网能力：网页搜索与抓取、仓库克隆、PDF 解析、视频理解',
    hasSkills: false,
    tags: ['web', 'search', 'fetch'],
  },
]

/** 包名归一化：@scope/pkg、缓存目录的 _scope_pkg 都归到 pkg */
function normalizePkg(name) {
  let s = String(name || '').trim().toLowerCase().replace(/^npm:/, '')
  s = s.replace(/^_+/, '').replace(/\/+$/, '')
  if (s.includes('/')) s = s.slice(s.lastIndexOf('/') + 1)
  else if (s.includes('_')) s = s.slice(s.lastIndexOf('_') + 1)
  return s
}

module.exports = { DEFAULT_CATALOG, normalizePkg }
