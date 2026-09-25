/**
 * 工具定义（OpenAI function calling 格式）。
 * 只放 schema，实现全在 agent-tools.js —— 两边要改同一个工具时一起改。
 */

// 联网工具（需要互联网上的实时/外部信息时由模型自行调用）
const WEB_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网搜索互联网上的实时信息（最新文档、新闻、版本号、报错、第三方资料等）。凡是项目内查不到、或需要最新信息的问题，都应该先用它搜索，而不是只搜本地文件。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          count: { type: 'number', description: '返回结果数量，默认 5，最多 10' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取指定网址的正文内容（纯文本），用于阅读搜索结果里的具体页面',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '网页地址' },
          max_chars: { type: 'number', description: '最多返回字符数，默认 4000' },
        },
        required: ['url'],
      },
    },
  },
]

const FILE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在项目目录中搜索文件内容（正则表达式）',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '搜索的正则表达式' },
          directory: { type: 'string', description: '搜索目录（相对于项目根）' },
          file_pattern: { type: 'string', description: '文件过滤 glob，如 ts,js,py' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径（相对于项目根）' },
          start_line: { type: 'number', description: '起始行（可选）' },
          end_line: { type: 'number', description: '结束行（可选）' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入/创建文件',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径（相对于项目根）' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        '精确编辑已有文件。给出「要被替换的原文」和「替换后的新内容」，一次可以改多处。\n' +
        'old_content 必须与文件里的内容逐字一致，而且必须能在整个文件中唯一定位（建议连同前后几行一起复制）；' +
        '如果这段原文在文件中出现多次，修改会被拒绝并提示你补充上下文。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径（相对于项目根）' },
          edits: {
            type: 'array',
            description: '要做的修改，可一次给出多处；每处都针对修改前的原始内容匹配',
            items: {
              type: 'object',
              properties: {
                old_content: { type: 'string', description: '要被替换的原文，需在文件中唯一' },
                new_content: { type: 'string', description: '替换后的新内容' },
              },
              required: ['old_content', 'new_content'],
            },
          },
        },
        required: ['file_path', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: '执行终端命令（在项目根目录）',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: '列出目录内容',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: '目录路径（相对于项目根，默认为根）' },
        },
      },
    },
  },
]

// 人机交互工具：需求不清时让模型停下来问，而不是猜
const ASK_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        '当需求存在你无法自行判断的分歧时（例如要在几种方案里选一个、缺少关键信息导致两种做法都说得通），' +
        '停下来向用户提问，等他回答后再继续。\n' +
        '能靠读代码、读文档或常识决定的事情不要问 —— 尽量自主完成，只在真的需要用户拍板时才用。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的问题，尽量具体' },
          options: {
            type: 'array',
            description: '2-4 个候选答案，用户也可以自己输入别的答案',
            items: { type: 'string' },
          },
        },
        required: ['question'],
      },
    },
  },
]

// 子代理：把一次独立任务外包出去，翻文件的噪音只留在子代理自己的上下文里
const TASK_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'task',
      description:
        '派发子代理去完成一次独立任务，它有自己的干净上下文，只把结论回给你。\n' +
        'subagent_type：explore = 只读调研（默认）；review = 只读代码审查，专挑 bug/风险/边界问题；general = 可以读也可以改文件、跑命令（大改动适合拆给它做）。\n' +
        '要并行的活，就在同一轮里一次发多个 task —— 它们会同时跑，比一个一个排队快得多。\n' +
        'background: true 让它在后台跑，你先继续做别的，完成后它的结论会自动进你的上下文。\n' +
        '适合：需要翻很多文件、搜很多轮才能有结论的活。不适合：自己读一两个文件就能确定的小事。',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: '三五个字说明这个子代理在干什么（界面上展示，如「查调用方」）',
          },
          prompt: {
            type: 'string',
            description: '任务描述，写清楚要找什么、判断标准是什么、希望结论包含哪些内容',
          },
          subagent_type: {
            type: 'string',
            enum: ['explore', 'review', 'general'],
            description: '子代理类型，缺省 explore（只读调研）',
          },
          background: {
            type: 'boolean',
            description: 'true = 后台跑，立刻返回不阻塞你；完成后结果自动回到上下文',
          },
        },
        required: ['prompt'],
      },
    },
  },
]

// 改动回退：动手前系统会自动打检查点，这两个工具用来查看与回退
const CHECKPOINT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_checkpoints',
      description: '列出本次工作目录里已有的改动检查点（快照），用于回退前先确认目标',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'restore_checkpoint',
      description:
        '把工作目录里的文件还原到某个检查点（即你开始改动之前的样子）。\n' +
        '只在改坏了、需要整体回退时使用；只还原快照里已有的文件，不会删除检查点之后新建的文件。',
      parameters: {
        type: 'object',
        properties: {
          sha: { type: 'string', description: '检查点 sha；省略则用最近的一个' },
        },
      },
    },
  },
]

// 任务清单：多步任务先拆开、逐条推进，进度对用户可见，也避免自己漏步
const TODO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        '把「接下来要做的事」写成一份清单，并在推进过程中随时更新它。\n' +
        '适合：任务超过 2~3 步、或用户给的是一句笼统需求需要你自己拆解时。\n' +
        '用法：每次都提交**完整清单**（覆盖上一次），用 status 标记进行到哪一步：同一时刻只应该有一条 in_progress；做完就改成 completed，不要攒着一次性改。\n' +
        '不适合：一步就能做完的小事 —— 不要为它建清单。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整的任务清单（会覆盖上一次的内容）',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '要做的事，一句话说清楚' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: '当前状态；同一时刻只应有一条 in_progress',
                },
                priority: {
                  type: 'string',
                  enum: ['high', 'medium', 'low'],
                  description: '重要程度，默认 medium',
                },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
]

// 诊断：改完代码主动验一遍，别把编译不过的东西交付出去
const DIAG_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description:
        '跑一遍语言检查，拿到类型错误 / 语法错误。\n' +
        '传 file_path 只看一个文件；不传则检查整个工程（更适合收尾前自查）。写完或改完代码后不确定有没有引入错误，先用它自查再交付。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '只看这个文件（相对于项目根）；省略则检查整个工程' },
        },
      },
    },
  },
]

// 格式化（对应 pi-lens 的格式化能力）：只调工程自己装的 prettier / ruff / black，不自带风格
const FORMAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'format_file',
      description:
        '用这个工程自己装好的格式化器（js/ts/样式/文档用工程内的 prettier，python 用 ruff 或 black）就地格式化一个文件，并把排版改动作为 diff 返回。\n' +
        '什么时候用：刚写完或改完一个文件、想让它符合本工程既有排版风格时。它只动缩进/换行/引号这类排版，不改逻辑、不改名字。工程没装格式化器时会如实告诉你 —— 那种情况下不要自己动手排版，先问用户要不要装。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '要格式化的文件路径（相对于项目根）' },
        },
        required: ['file_path'],
      },
    },
  },
]

// 项目全局规则：写进磁盘（.yucode/rules.md），每一步执行前都会重新拼进系统提示词。
// 和 write_plan 的分工：规则是跨任务的长期硬约束（技术栈、目录约定、禁止的写法），
// 计划是「当前这个任务怎么做」。
const RULES_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_rules',
      description:
        '把项目的「全局规则」整份写进磁盘（.yucode/rules.md）。这份规则会在每一次执行前重新出现在你的提示词里，' +
        '跨会话、跨任务一直有效 —— 用来记用户定下的硬约束：技术栈与版本、目录/命名约定、禁止的写法与库、' +
        '必须走的流程（比如「单文件不超过 500 行」「不要用原生弹窗」）。\n' +
        '和 write_plan 的分工：规则管长期约束（与当前任务进度无关），计划管当前任务怎么做。\n' +
        '每次提交完整规则（整份覆盖），只改一条也要带上其余原有内容；传空字符串清空全部规则。',
      parameters: {
        type: 'object',
        properties: {
          rules: {
            type: 'string',
            description:
              '完整的规则正文（Markdown，建议用短横线列表，一条一行）。传空字符串清空全部规则。',
          },
        },
        required: ['rules'],
      },
    },
  },
]

// 实施计划：写到磁盘上（.yucode/plan.md），每轮都会重新拼进系统提示词。
// 这是长任务能撑过上下文压缩的关键 —— 上下文里被丢掉的是过程，计划本身留在磁盘上。
const PLAN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_plan',
      description:
        '把当前任务的实施计划写到磁盘上（.yucode/plan.md）。\n' +
        '重要：这份计划**不会**被上下文压缩丢掉，之后每一轮都会重新出现在你的提示词里 —— 所以长任务开工前必须先写计划；中途方案有变也要更新它（每次提交完整计划，覆盖旧的）。\n' +
        '和 todo_write 的分工：write_plan 记「怎么做」（目标、要改哪些文件、关键决策、当前进度），todo_write 记「做到哪了」（可勾选的短条目）。两者配合使用。\n' +
        '传空字符串表示清空计划（任务已结束或用户换了目标）。',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description:
              '完整的实施计划（Markdown）。建议包含：目标、要改动/新建的文件清单、实现步骤、' +
              '关键取舍与约束、当前进行到哪一步。传空字符串清空。',
          },
        },
        required: ['plan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_plan',
      description: '读回当前磁盘上的实施计划全文（提示词里的计划被截断时用它看完整内容）',
      parameters: { type: 'object', properties: {} },
    },
  },
]

// 长期记忆（对应 Pi 的 hermes-memory 扩展）：跨会话留下的结论，写一次以后每轮都在提示词里
const MEMORY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        '把一条「以后还用得上的结论」写进项目长期记忆（.yucode/memory.md），之后每次对话它都会出现在你的提示词里。\n' +
        '值得记：这个项目的约定与非显然的约束、踩过的坑与它的真实原因、需要跑的特殊命令、用户明确说过的偏好；不值得记：当前任务的临时进度（那是 write_plan / todo_write 的事）、读一遍代码就能知道的事实、密钥之类的敏感内容。一次只写一条，写具体：带上文件路径、命令、以及为什么。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要记住的内容，一句话说清「是什么 + 为什么」' } },
        required: ['text'],
      },
    },
  },
]

// 计划模式的收尾：把方案交出去请用户批准，批准后自动退出计划模式开始动手
const PLAN_MODE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'exit_plan_mode',
      description:
        '计划模式专用：调研完成、方案已经想清楚后调用它，把完整计划交给用户确认。\n' +
        '调用时会在界面上向用户展示计划并请其批准按钮：用户同意后会自动退出计划模式，你随即按计划动手；用户不同意时会返回他的意见，你要据此修改计划，改好再调用一次。\n' +
        '注意：只在计划模式下有意义；不要在还没调研清楚时就急着调用。',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description:
              '要交给用户确认的完整实施计划（Markdown）。包含：目标、准备改动/新建的文件、实现步骤、' +
              '风险与取舍。这份计划会同时落盘到 .yucode/plan.md，退出计划模式后它仍会一直出现在你的提示词里。',
          },
        },
        required: ['plan'],
      },
    },
  },
]

// 上下文管理（对应 Pi 的 billion-context 扩展）：由模型自己决定何时把哪一段过程压成摘要。
// 自动压缩只在阈值处被动救火，这几个工具让模型主动腾地方，且压掉的东西还能查回来。
const CONTEXT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'compress',
      description:
        '把一段消息换成你自己写的高保真摘要，腾出上下文空间。原文会存档，随时能查回来。\n' +
        '何时用：一段工作已经收尾（调研完了、这个报错查清了、这个文件改完了），而它的过程占了很多地方时；' +
        '或者上下文快到上限、你想继续干很久时。\n' +
        'summary 要写详细：文件路径、函数/接口签名、关键决策与理由、错误原文、结论与待办，' +
        '这些必须逐字保留。丢掉路径和错误串的摘要等于没压。\n' +
        '不能压：最后一条用户消息、最近几条消息（当前工作集）。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '起始消息引用，形如 m00012（消息以 [m00012] 开头）' },
          to: { type: 'string', description: '结束消息引用（含），形如 m00018' },
          title: { type: 'string', description: '这段内容的一句话标题，如「登录接口调研」' },
          summary: { type: 'string', description: '高保真摘要，保留路径/签名/错误/决策/结论' },
        },
        required: ['from', 'to', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_context',
      description:
        '在已压缩的块里按关键词检索（连原文一起搜），不用解压就能找到当初记下的路径/报错/决策。' +
        '当你要回忆「之前那个报错是什么」「当时为什么这么改」时用它。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，如文件名、函数名、报错片段' },
          limit: { type: 'number', description: '最多返回几条，默认 8' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'decompress',
      description:
        '取回某个压缩块的原文。只在确实需要那段原始细节时用（比如要照着原来的代码改），' +
        '否则优先 search_context —— 原文拉回来会重新占地方。',
      parameters: {
        type: 'object',
        properties: {
          block_id: { type: 'string', description: '块编号，如 b1' },
        },
        required: ['block_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'context_status',
      description:
        '看当前上下文占用、消息引用区间、已有压缩块。任务很长时先看一眼，决定压哪一段。',
      parameters: { type: 'object', properties: {} },
    },
  },
]

const TOOLS = [
  ...FILE_TOOLS,
  ...ASK_TOOLS,
  ...WEB_TOOLS,
  ...TASK_TOOLS,
  ...CHECKPOINT_TOOLS,
  ...TODO_TOOLS,
  ...DIAG_TOOLS,
  ...FORMAT_TOOLS,
  ...RULES_TOOLS,
  ...PLAN_TOOLS,
  ...MEMORY_TOOLS,
  ...PLAN_MODE_TOOLS,
  ...CONTEXT_TOOLS,
]

// 子代理只能用只读工具：搜索 / 读文件 / 列目录 / 联网，改不了任何东西
const READ_TOOL_NAMES = new Set(['search_files', 'read_file', 'list_directory', 'web_search', 'web_fetch'])
const READ_TOOLS = TOOLS.filter((t) => READ_TOOL_NAMES.has(t.function.name))

// general 子代理能改文件：把它不该碰的剔掉 ——
// 派下级子代理、问用户、管理主上下文，以及会覆盖主 Agent 计划/清单/检查点的那些
const SUBAGENT_BLOCKED = new Set([
  'task', 'ask_user',
  'compress', 'decompress', 'search_context', 'context_status',
  'exit_plan_mode', 'todo_write', 'write_plan', 'read_plan', 'remember', 'write_rules', 'restore_checkpoint',
])
const WRITE_TOOLS = TOOLS.filter((t) => !SUBAGENT_BLOCKED.has(t.function.name))

module.exports = { TOOLS, READ_TOOLS, WRITE_TOOLS }
