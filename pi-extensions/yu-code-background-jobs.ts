/**
 * 后台任务三件套 —— 补上 pi 缺失的「起一个不会退出的进程，然后继续干活」。
 *
 * 为什么需要它：
 * pi 的 shell 工具（bash / powershell）的 timeout 是可选参数、没有默认值，
 * 它只等进程自己退出。模型一旦在前台跑 `npm run dev`，那一轮任务就永久卡住：
 * 界面上只有一条「执行: npm run dev」，既不结束也没有下一步 —— 实测能卡十几分钟。
 * pi 内核里没有任何后台进程能力（8 个内置工具里没有，bash 入参只有 command + timeout），
 * 所以这个能力只能由扩展补。本扩展就是那个扩展，由应用写进 ~/.pi/agent/extensions/ 后
 * 随 pi 启动自动加载（见 electron/pi-custom-extensions.js）。
 *
 * 三个工具：
 *   run_in_background  起后台任务，立刻拿到 job_id，不阻塞
 *   bash_output        读它的增量输出与状态（可带 wait_seconds 轮询等待）
 *   kill_shell         连子进程一起收掉它
 *
 * 另外在 tool_call 上装了道闸：模型硬要用前台跑常驻命令时直接拦下来，
 * 并把「改用 run_in_background」写进错误里 —— 护栏提示词只降低概率，实测拦不住。
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 后台任务的日志落在系统临时目录：不进项目，也不占内存（长跑的服务会一直吐日志） */
const JOB_DIR = path.join(os.tmpdir(), "yu-code-bg-jobs");
/** 单次最多交给模型这么多字符，再多就只说「还有更多，用 read 看日志文件」 */
const READ_CHUNK = 20000;
/** 只记最近这些任务，免得一个长会话里无限涨 */
const MAX_JOBS = 20;
const WAIT_STEP_MS = 200;
const MAX_WAIT_S = 60;
const DEFAULT_START_WAIT_S = 3;

interface Job {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  logFile: string;
  startedAt: number;
  /** bash_output 已经交付过的字节数，下次从这里接着读 */
  readOffset: number;
  /** 存着没凑齐的多字节字符，避免把中文切出乱码 */
  decoder: StringDecoder;
  exited: boolean;
  exitCode: number | null;
  killed: boolean;
}

const jobs = new Map<string, Job>();
let seq = 0;

// ==================== 小工具 ====================

function ok(value: string) {
  return { content: [{ type: "text", text: value }], details: undefined };
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logSize(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

// ==================== 任务的读写与回收 ====================

/** 从日志文件增量读一段；没有新内容返回空串 */
function readNewOutput(job: Job): string {
  const size = logSize(job.logFile);
  // 文件被外部清空/换掉过：从头重读，别把读位置卡在一个不存在的偏移上
  if (size < job.readOffset) job.readOffset = 0;
  if (size <= job.readOffset) return "";

  const end = Math.min(size, job.readOffset + READ_CHUNK);
  const fd = fs.openSync(job.logFile, "r");
  try {
    const buf = Buffer.alloc(end - job.readOffset);
    fs.readSync(fd, buf, 0, buf.length, job.readOffset);
    job.readOffset = end;
    return job.decoder.write(buf);
  } finally {
    fs.closeSync(fd);
  }
}

/** 有新输出、或任务已收尾就提前返回；否则最多等满 seconds 秒（这就是「轮询等待」） */
async function waitFor(job: Job, seconds: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, seconds) * 1000;
  while (Date.now() < deadline) {
    if (job.exited) return;
    if (logSize(job.logFile) > job.readOffset) return;
    await sleep(Math.min(WAIT_STEP_MS, Math.max(1, deadline - Date.now())));
  }
}

function elapsedSeconds(job: Job): number {
  return Math.round((Date.now() - job.startedAt) / 1000);
}

function statusLine(job: Job): string {
  if (!job.exited) return `运行中（已运行 ${elapsedSeconds(job)} 秒）`;
  const head = job.killed ? "已被终止" : "已结束";
  return `${head}（exit code ${job.exitCode}）`;
}

function listJobs(): string {
  if (jobs.size === 0) return "当前没有后台任务。";
  const lines = [...jobs.values()].map(
    (job) => `- ${job.id}：${statusLine(job)}｜${job.command.slice(0, 80)}`,
  );
  return `后台任务：\n${lines.join("\n")}`;
}

/**
 * 连子进程一起收：开发服务器会自己派生一串 worker，
 * 只杀 shell 会把它们留成孤儿进程，继续占着端口。
 */
function killTree(pid: number): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    } catch { /* 进程可能刚好自己退了 */ }
    return;
  }
  // 非 Windows：spawn 时 detached 过，负号 = 整个进程组一起收
  try { process.kill(-pid, "SIGKILL"); return; } catch { /* 没有这个组 */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ }
}

function killJob(job: Job): void {
  if (job.exited) return;
  job.killed = true;
  killTree(job.pid);
}

function killAll(): void {
  for (const job of jobs.values()) killJob(job);
}

/** 只淘汰已经结束的老任务；还在跑的一律留着（它自己还在写日志） */
function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (job.exited) jobs.delete(id);
  }
}

function startJob(command: string, cwd: string): Job {
  fs.mkdirSync(JOB_DIR, { recursive: true });
  const id = `bg-${++seq}`;
  const logFile = path.join(JOB_DIR, `${id}.log`);

  // 日志直接落文件、而不是走管道：我们的进程先走一步（应用退出、pi 被重启）时，
  // 后台进程照常跑、照常记日志，不会因为管道断开而报 EPIPE。
  const fd = fs.openSync(logFile, "w");
  let child;
  try {
    child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", fd, fd],
      // Windows 上 taskkill /T 已经能整棵树收，不用新建进程组；
      // 非 Windows 得靠新进程组才能一次收掉 npm 起出来的一串子进程
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } finally {
    fs.closeSync(fd);
  }

  const job: Job = {
    id,
    command,
    cwd,
    pid: child.pid ?? 0,
    logFile,
    startedAt: Date.now(),
    readOffset: 0,
    decoder: new StringDecoder("utf8"),
    exited: false,
    exitCode: null,
    killed: false,
  };

  child.on("error", (err: Error) => {
    job.exited = true;
    job.exitCode = -1;
    try { fs.appendFileSync(logFile, `\n[启动失败] ${err.message}\n`); } catch { /* 日志写不进去就算了 */ }
  });
  child.on("exit", (code: number | null) => {
    job.exited = true;
    job.exitCode = code;
  });
  // 别让后台任务拖着我们不退出：它的存活不该影响 pi 进程的收尾
  child.unref?.();

  jobs.set(id, job);
  pruneJobs();
  return job;
}

// ==================== 前台起常驻命令的闸 ====================

/** 包管理器里的常驻脚本：npm run dev / pnpm dev / yarn serve / bun run watch */
const PKG_DEV = /(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch|preview)\b/i;
/** 框架自带的开发服务器 */
const FRAMEWORK_DEV =
  /(?:^|[;&|]\s*|\s)(?:vite|next|nuxt|astro|gatsby|ng|webpack(?:-dev-server)?|parcel)\s+(?:dev|serve|start|watch)\b/i;
/** nodemon 不管后面跟什么都是常驻的 watcher */
const NODEMON = /(?:^|[;&|]\s*|\s)nodemon\b/i;
/** 裸着跑就是起服务的（npm run vite / npx vite …） */
const BARE_DEV = /(?:^|[;&|]\s*|\s)(?:vite|webpack-dev-server)\s*$/i;
/** Python 系常驻服务 */
const PY_DEV =
  /(?:^|[;&|]\s*|\s)(?:uvicorn|gunicorn|flask\s+run|python[0-9.]*\s+-m\s+(?:http\.server|uvicorn)|streamlit\s+run|django-admin\s+runserver)\b/i;
/** 其他一眼就能看出不会退出的 */
const MISC_DEV = [
  /(?:^|[;&|]\s*|\s)(?:tail|tail\.exe)\s+-\w*f\b/i,
  /(?:^|[;&|]\s*|\s)dotnet\s+watch\b/i,
  /(?:^|[;&|]\s*|\s)(?:rails\s+s(?:erver)?|mix\s+phx\.server)\b/i,
  /\bdocker(?:\s+compose|-compose)\s+up\b(?![\s\S]*\s-d\b)/i,
];

/** 已经自己做了后台化的写法，不再拦（注意：只重定向到日志文件不算后台化，仍然会阻塞） */
const ALREADY_BACKGROUNDED = /(?:^|[;&|]\s*)start\s+(?:\/b|""|'')|Start-Process|nohup\s/i;

function looksLongRunning(command: string): boolean {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  if (ALREADY_BACKGROUNDED.test(cmd)) return false;
  if (PKG_DEV.test(cmd) || FRAMEWORK_DEV.test(cmd) || NODEMON.test(cmd) || BARE_DEV.test(cmd) || PY_DEV.test(cmd)) {
    return true;
  }
  return MISC_DEV.some((re) => re.test(cmd));
}

function blockReason(command: string): string {
  return [
    `这条命令不会自己退出，前台跑会让整轮任务永久卡住（界面上只会停在「执行: ${command.trim().slice(0, 50)}」，既不结束也没有下一步）。`,
    "",
    "改用 run_in_background 工具启动它：",
    `  run_in_background({ command: ${JSON.stringify(command.trim())} })`,
    "拿到 job_id 之后用 bash_output 轮询它的输出，确认服务真的起来了（端口、报错）。",
    "不再需要这个服务时，用 kill_shell 收掉它，别让它一直挂在后台。",
  ].join("\n");
}

// ==================== 扩展本体 ====================

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_in_background",
    label: "后台执行",
    description:
      "在后台启动一个命令并立刻返回 job_id，不阻塞会话。用于开发服务器、watch 模式、" +
      "tail -f、常驻服务等「不会自己退出」的命令。启动后用 bash_output 读它的输出，" +
      "用 kill_shell 终止它。一次性命令（构建、测试、lint）请继续用 bash。",
    promptSnippet: "后台启动开发服务器/常驻进程，不阻塞会话",
    promptGuidelines: [
      "要起开发服务器（npm run dev / vite / next dev / python -m http.server 等）或任何不会自己退出的命令时，必须用 run_in_background，不要用 bash 在前台跑。",
      "后台起好之后要用 bash_output 轮询它的输出，确认服务真的起来了（端口、报错），不要凭空假设启动成功。",
      "验证完就 kill_shell 收掉后台服务，别把它一直挂在后台。",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "要执行的 shell 命令" }),
      cwd: Type.Optional(Type.String({ description: "工作目录，默认当前项目目录" })),
      wait_seconds: Type.Optional(
        Type.Number({ description: `启动后先等几秒收集输出（默认 ${DEFAULT_START_WAIT_S}，最大 30）` }),
      ),
    }),
    async execute(_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const command = String(params?.command || "").trim();
      if (!command) return ok("command 不能为空。");

      const cwd = params?.cwd ? path.resolve(ctx?.cwd || process.cwd(), String(params.cwd)) : ctx?.cwd || process.cwd();
      const wait = clamp(params?.wait_seconds, DEFAULT_START_WAIT_S, 0, 30);

      let job: Job;
      try {
        job = startJob(command, cwd);
      } catch (e) {
        return ok(`启动失败：${e instanceof Error ? e.message : String(e)}`);
      }

      await waitFor(job, wait);
      const output = readNewOutput(job);
      const head = [
        `后台任务已启动（job_id: ${job.id}，pid: ${job.pid}）`,
        `命令：${job.command}`,
        `目录：${job.cwd}`,
        `状态：${statusLine(job)}`,
        `日志文件：${job.logFile}`,
      ].join("\n");

      if (!output.trim()) {
        return ok(
          `${head}\n\n（等了 ${wait} 秒还没有任何输出）\n\n` +
            "下一步：用 bash_output 带 wait_seconds 轮询它的输出，确认服务是否就绪；不再需要时用 kill_shell 收掉。",
        );
      }

      const tail = job.exited
        ? "\n\n它启动后很快就自己退出了：看下面的输出判断是命令写错了、还是端口被占。"
        : "\n\n下一步：用 bash_output 继续轮询输出（确认端口/报错），不再需要时用 kill_shell 收掉。";
      return ok(`${head}\n\n--- 已捕获的输出 ---\n${output.trimEnd()}${tail}`);
    },
  });

  pi.registerTool({
    name: "bash_output",
    label: "后台输出",
    description:
      "读取 run_in_background 启动的后台任务的「新增」输出与运行状态。" +
      "不传 job_id 时列出所有后台任务。服务需要时间才就绪时，用 wait_seconds 等一会儿再返回，不要反复空转。",
    promptSnippet: "读取后台任务的新输出与状态",
    promptGuidelines: [
      "轮询后台服务是否就绪时，用 bash_output 并带上 wait_seconds（例如 10），不要用 sleep 加空转命令来回试探。",
    ],
    parameters: Type.Object({
      job_id: Type.Optional(Type.String({ description: "run_in_background 返回的 job_id；不填则列出全部后台任务" })),
      wait_seconds: Type.Optional(
        Type.Number({ description: `没有新输出时最多等几秒（默认 0，最大 ${MAX_WAIT_S}）` }),
      ),
    }),
    async execute(_toolCallId: string, params: any) {
      const id = String(params?.job_id || "").trim();
      if (!id) return ok(listJobs());

      const job = jobs.get(id);
      if (!job) return ok(`没有这个后台任务：${id}\n\n${listJobs()}`);

      const wait = clamp(params?.wait_seconds, 0, 0, MAX_WAIT_S);
      if (wait > 0) await waitFor(job, wait);
      const output = readNewOutput(job);

      const head = `任务 ${job.id}（pid ${job.pid}）\n命令：${job.command}\n状态：${statusLine(job)}`;
      const body = output.trim() ? `\n\n--- 新输出 ---\n${output.trimEnd()}` : "\n\n（没有新输出）";
      const tail = job.exited
        ? "\n\n任务已经结束，不用再轮询它了。"
        : "\n\n还在运行；要接着等就再调一次（可带 wait_seconds），不再需要时用 kill_shell 收掉。";
      return ok(`${head}${body}${tail}`);
    },
  });

  pi.registerTool({
    name: "kill_shell",
    label: "停止后台任务",
    description:
      "终止 run_in_background 启动的后台任务，连同它派生的子进程一起收掉。" +
      "job_id 传 all 表示终止全部。验证完、或换了方案之后要记得收，否则服务会一直占着端口。",
    promptSnippet: "终止后台任务（连同子进程）",
    parameters: Type.Object({
      job_id: Type.String({ description: "要终止的 job_id；all 表示全部终止" }),
    }),
    async execute(_toolCallId: string, params: any) {
      const id = String(params?.job_id || "").trim();
      if (!id) return ok(`要指定 job_id（all 表示全部）。\n\n${listJobs()}`);

      if (id === "all") {
        const running = [...jobs.values()].filter((job) => !job.exited);
        for (const job of running) killJob(job);
        if (running.length === 0) return ok("当前没有正在运行的后台任务。");
        await sleep(300);
        return ok(`已终止 ${running.length} 个后台任务：${running.map((job) => job.id).join(", ")}`);
      }

      const job = jobs.get(id);
      if (!job) return ok(`没有这个后台任务：${id}\n\n${listJobs()}`);
      if (job.exited) return ok(`任务 ${id} 早就结束了（exit code ${job.exitCode}），不用再终止。`);

      killJob(job);
      await sleep(300);
      return ok(
        `已终止任务 ${id}（pid ${job.pid}）。` +
          (job.exited ? `进程已退出（exit code ${job.exitCode}）。` : "终止信号已发出，进程还没有回报退出。"),
      );
    },
  });

  /**
   * 闸门：模型要把常驻命令丢给前台时直接拦下来。
   *
   * 这个钩子抛错会被 pi 当成「护栏失败」而拦掉工具，所以整段包在 try 里 ——
   * 宁可什么都不做，也不能因为闸门自己坏了导致所有 shell 命令都跑不了。
   */
  pi.on("tool_call", (event: any) => {
    try {
      if (event?.toolName !== "bash" && event?.toolName !== "powershell") return;
      const command = String(event?.input?.command || "");
      if (!looksLongRunning(command)) return;
      // 计划模式下后台工具不可用，拦了也没法照做，那就别拦
      if (!pi.getActiveTools().includes("run_in_background")) return;
      return { block: true, reason: blockReason(command) };
    } catch {
      return;
    }
  });

  // 会话收尾（退出、换会话、重载）时把后台任务一并收掉
  pi.on("session_shutdown", () => {
    killAll();
  });
}

// session_shutdown 覆盖不了「进程被强杀」（那时它不会跑），这里再兜一层：
// 否则用户点「停止」之后，Dev Server 会以孤儿进程留在后台占着端口。
// 扩展可能被重载，所以这个钩子只挂一次。
const guard = globalThis as unknown as { __yuCodeBgExitHook?: boolean };
if (!guard.__yuCodeBgExitHook) {
  guard.__yuCodeBgExitHook = true;
  process.on("exit", () => {
    killAll();
  });
}
