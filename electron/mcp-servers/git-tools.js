'use strict';

// Yu Code 内置 Git MCP Server（只读工具集）
// 传输：stdio。协议为换行分隔的 JSON-RPC 2.0，每行一条紧凑 JSON。
// 约束：stdout 只允许出现协议消息，任何日志都必须走 stderr，否则会污染协议流。

const { execFileSync } = require('child_process');
const path = require('path');

const SERVER_NAME = 'yu-code-git';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';

const MAX_DIFF = 8000;
const MAX_SHOW = 8000;
const MAX_BLAME = 6000;

// 工作目录优先级：环境变量 -> 启动参数 -> 进程 cwd
const projectDir = path.resolve(
  process.env.YU_CODE_PROJECT_DIR || process.argv[2] || process.cwd()
);

function log(message) {
  process.stderr.write(`[yu-code-git] ${message}\n`);
}

log(`已启动，工作目录: ${projectDir}`);

// ---------------- git 执行与通用工具 ----------------

function runGit(args) {
  return execFileSync('git', args, {
    cwd: projectDir,
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf-8',
    windowsHide: true,
  });
}

function isGitRepo() {
  try {
    return runGit(['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

// 参数校验类错误：与 git 执行失败区分开，提示原样返回给调用方
class ArgumentError extends Error {}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n…（已截断）';
}

// 校验模型传入的 path：必须是工作目录内的相对路径，且不能以 - 开头（防选项注入）
function safePath(input, required) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    if (required) throw new ArgumentError('参数 path 必填');
    return null;
  }
  if (raw.startsWith('-')) {
    throw new ArgumentError(`拒绝访问非法路径（不能以 - 开头）：${raw}`);
  }
  const resolved = path.resolve(projectDir, raw);
  const rel = path.relative(projectDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ArgumentError(`拒绝访问工作目录之外的路径：${raw}`);
  }
  return resolved;
}

// ---------------- 各工具实现 ----------------

function handleGitStatus() {
  const raw = runGit(['status', '--porcelain=v1', '-b']);
  const lines = raw.split('\n').filter((line) => line.length > 0);
  let branch = '未知';
  const changes = [];
  for (const line of lines) {
    if (line.startsWith('##')) {
      const info = line.slice(2).trim();
      branch = info.split('...')[0].split(' ')[0] || info;
    } else {
      changes.push(line);
    }
  }
  if (changes.length === 0) return `分支 ${branch}；工作区干净`;
  return `分支 ${branch}；共 ${changes.length} 处改动\n${changes.join('\n')}`;
}

function handleGitDiff(args) {
  const argv = ['diff'];
  if (args.staged === true) argv.push('--cached');
  const file = safePath(args.path, false);
  if (file) argv.push('--', file);
  const out = runGit(argv);
  return out.trim() ? truncate(out, MAX_DIFF) : '没有差异。';
}

function handleGitLog(args) {
  let limit = toInt(args.limit) || 15;
  if (limit > 100) limit = 100;
  const argv = ['log', '--oneline', '-n', String(limit)];
  const file = safePath(args.path, false);
  if (file) argv.push('--', file);
  const out = runGit(argv).trim();
  return out || '没有提交记录';
}

function handleGitShow(args) {
  const rev = typeof args.rev === 'string' ? args.rev.trim() : '';
  if (!rev) throw new ArgumentError('参数 rev 必填');
  if (rev.startsWith('-')) throw new ArgumentError(`参数 rev 非法（不能以 - 开头）：${rev}`);
  return truncate(runGit(['show', '--stat', rev]), MAX_SHOW);
}

function handleGitBlame(args) {
  const file = safePath(args.path, true);
  const start = toInt(args.start_line);
  const end = toInt(args.end_line);
  const argv = ['blame'];
  let hint = '';
  if (start && end) {
    argv.push('-L', `${start},${end}`);
  } else {
    hint = '提示：未指定行号范围，结果可能很长，建议传入 start_line / end_line。\n';
  }
  argv.push('--', file);
  return hint + truncate(runGit(argv), MAX_BLAME);
}

const TOOLS = [
  {
    name: 'git_status',
    description: '查看当前 Git 工作区状态：所在分支与改动文件列表（只读）。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'git_diff',
    description: '查看工作区或暂存区的代码差异（只读）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '限定比较的相对路径，可选' },
        staged: {
          type: 'boolean',
          description: '是否查看已暂存（git diff --cached）的差异，默认 false',
        },
      },
      required: [],
    },
  },
  {
    name: 'git_log',
    description: '查看最近的提交记录（只读）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回的提交条数，默认 15，最大 100' },
        path: { type: 'string', description: '只看某个路径的提交历史，可选' },
      },
      required: [],
    },
  },
  {
    name: 'git_show',
    description: '查看某次提交或某个对象的详情与改动统计（只读）。',
    inputSchema: {
      type: 'object',
      properties: {
        rev: { type: 'string', description: 'Git 版本号，如 HEAD、HEAD~1、commit hash' },
      },
      required: ['rev'],
    },
  },
  {
    name: 'git_blame',
    description: '查看文件逐行归属（只读），建议同时指定行号范围。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件相对路径' },
        start_line: { type: 'number', description: '起始行号，可选' },
        end_line: { type: 'number', description: '结束行号，可选' },
      },
      required: ['path'],
    },
  },
];

const HANDLERS = {
  git_status: handleGitStatus,
  git_diff: handleGitDiff,
  git_log: handleGitLog,
  git_show: handleGitShow,
  git_blame: handleGitBlame,
};

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// 业务错误不抛 JSON-RPC error，而是包成 isError 的文本结果
function gitErrorText(err) {
  const stdout = err && typeof err.stdout === 'string' ? err.stdout.trim() : '';
  if (stdout) return `git 命令执行失败：\n${stdout}`;
  const message = err && err.message ? err.message : String(err);
  return `git 命令执行失败：${message}`;
}

function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) return errorResult(`未知工具：${name}`);
  if (!isGitRepo()) return errorResult(`当前目录不是 git 仓库：${projectDir}`);
  try {
    return { content: [{ type: 'text', text: handler(args || {}) }] };
  } catch (err) {
    if (err instanceof ArgumentError) return errorResult(err.message);
    return errorResult(gitErrorText(err));
  }
}

// ---------------- JSON-RPC 协议层 ----------------

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendResult(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const { id, method, params } = message;

  // 通知（notifications/* 或无 id）一律不响应
  if (typeof method === 'string' && method.startsWith('notifications/')) return;
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      return sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case 'ping':
      return sendResult(id, {});
    case 'tools/list':
      return sendResult(id, { tools: TOOLS });
    case 'tools/call':
      return sendResult(
        id,
        callTool(params && params.name, (params && params.arguments) || {})
      );
    default:
      return sendError(id, -32601, `Method not found: ${method}`);
  }
}

function handleLine(line) {
  const text = line.replace(/\r$/, '').trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    log(`忽略无法解析的输入行：${text.slice(0, 200)}`);
    return;
  }
  handleMessage(message);
}

// 按行读取 stdin：最后一段不完整的内容留在 buffer 里等待后续数据
let buffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));
