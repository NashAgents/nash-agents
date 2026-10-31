import { type Tool, defineTool } from "./tool.js";
import { SandboxService } from "../sandbox/sandbox-service.js";
import { createDefaultSandboxPolicy } from "../sandbox/policy.js";
import { JobManager } from "../jobs/job-manager.js";
import type { ToolTimingPolicy } from "../jobs/types.js";
import { DEFAULT_BASH_TIMING_POLICY } from "../jobs/types.js";
import type { ToolResult } from "./executor.js";
import type { ToolExecutionContext } from "./tool.js";
import type { ProcessJob } from "../jobs/process-job.js";

/**
 * bash 工具的参数类型定义
 */
export interface BashArgs {
  /**
   * 需要在 bash 环境中执行的命令行语句
   */
  command: string;

  /**
   * 是否显式指定在后台异步执行（默认为 false）。
   * 若为 true，将立即返回 Job ID，进程在后台持续运行；
   * 若为 false，将在软超时 (如 120s) 内同步等待，超时后自动转入后台。
   */
  background?: boolean;

  /**
   * 当前命令是否需要访问外网/互联网。
   * 若策略配置为 network: deny，显式传入 true 会在执行前主动触发结构化网络提权审批 (allow-once)。
   * 默认为 false。
   */
  requires_network?: boolean;
}

/**
 * 创建 bash 工具的详细配置项
 */
export interface CreateBashToolOptions {
  sandboxService?: SandboxService;
  jobManager?: JobManager;
  ownerAgentId?: string;
  sessionId?: string;
  projectId?: string;
  timingPolicy?: Partial<ToolTimingPolicy>;
  cwd?: string;
  scopedWritePaths?: string[];
  extraAllowedWritePaths?: string[];
}

/**
 * 执行 bash 命令的可选配置
 */
export interface ExecuteBashOptions {
  cwd?: string;
  timeoutMs?: number;
}

/**
 * 创建并配置 bash 工具实例（支持依赖注入与 JobManager 后台治理）
 */
export function createBashTool(
  optionsOrService?: SandboxService | CreateBashToolOptions
): Tool<BashArgs> {
  let sandboxService: SandboxService | undefined;
  let jobManager: JobManager | undefined;
  let ownerAgentId = "main";
  let sessionId = "default";
  let projectId = "default";
  let timingPolicy: ToolTimingPolicy = { ...DEFAULT_BASH_TIMING_POLICY };
  let defaultCwd: string | undefined;
  let scopedWritePaths: string[] | undefined;
  let extraAllowedWritePaths: string[] | undefined;

  if (optionsOrService instanceof SandboxService) {
    sandboxService = optionsOrService;
  } else if (optionsOrService) {
    sandboxService = optionsOrService.sandboxService;
    jobManager = optionsOrService.jobManager;
    ownerAgentId = optionsOrService.ownerAgentId ?? "main";
    sessionId = optionsOrService.sessionId ?? "default";
    projectId = optionsOrService.projectId ?? "default";
    if (optionsOrService.timingPolicy) {
      timingPolicy = {
        ...DEFAULT_BASH_TIMING_POLICY,
        ...optionsOrService.timingPolicy,
      };
    }
    defaultCwd = optionsOrService.cwd;
    scopedWritePaths = optionsOrService.scopedWritePaths;
    extraAllowedWritePaths = optionsOrService.extraAllowedWritePaths;
  }

  const getSandboxService = () =>
    sandboxService ??
    new SandboxService({
      policy: createDefaultSandboxPolicy(),
    });

  const bindCancellation = (job: ProcessJob, signal?: AbortSignal) => {
    if (!signal) return;
    const cancel = () => { void job.kill("SIGTERM"); };
    signal.addEventListener("abort", cancel, { once: true });
    job.onComplete(() => signal.removeEventListener("abort", cancel));
    if (signal.aborted) cancel();
  };

  return defineTool({
    name: "bash",
    executionKind: "process",
    description:
      `在项目工作目录中执行${process.platform === "win32" ? "原生 Windows PowerShell 命令（工具名仍为 bash）；请使用 PowerShell 语法，调用带空格的可执行路径时使用 & 运算符" : "bash 命令"}。支持前台同步执行（短任务自动返回，超过 120s 软超时自动提升为后台 Job）与主动后台执行 (background=true)。受系统原生沙箱强安全策略约束。`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: process.platform === "win32" ? "需要执行的原生 PowerShell 命令语句。" : "需要执行的 bash 命令语句。",
        },
        background: {
          type: "boolean",
          description:
            "是否立即在后台异步运行该命令（适用于明确耗时较长的构建、安装、测试或评测任务）。默认为 false。",
        },
        requires_network: {
          type: "boolean",
          description:
            "当前命令是否需要访问外网/互联网。若策略配置为 network: deny，显式传入 true 会在执行前主动触发结构化网络提权审批 (allow-once)。默认为 false。",
        },
      },
      required: ["command"],
    },
    async execute(args: BashArgs, context?: ToolExecutionContext): Promise<string | ToolResult> {
      context?.signal?.throwIfAborted();
      if (!args || typeof args.command !== "string") {
        throw new Error("缺少必填参数 'command' 或参数类型不为 string。");
      }

      const svc = getSandboxService();
      jobManager ??= new JobManager({ sandboxService: svc, defaultProjectId: projectId, defaultSessionId: sessionId });
      const cwd = defaultCwd ?? svc.getCwd();
      const executionPolicy = await svc.authorizeProcess({ command: "bash", args: ["-lc", args.command], requiresNetwork: args.requires_network }, context?.signal);
      context?.signal?.throwIfAborted();

      // 1. 若显式指定了 background: true，且注入了 JobManager
      if (args.background && jobManager) {
        const job = jobManager.spawnJob({
          ownerAgentId,
          sessionId,
          projectId,
          command: args.command,
          backgroundRequested: true,
          cwd,
          timingPolicy,
          sandboxService: svc,
          policy: executionPolicy,
          scopedWritePaths,
          extraAllowedWritePaths,
          requiresNetwork: args.requires_network,
        });
        bindCancellation(job, context?.signal);

        return JSON.stringify(
          {
            jobId: job.id,
            status: "running",
            command: args.command,
            message: `命令已成功在后台启动 (Job ID: ${job.id})。你可以继续执行其他工作，待任务完成后 Runtime 会自动通知你。`,
          },
          null,
          2
        );
      }

      // 2. 默认前台执行：若有 JobManager，支持软超时 (softTimeout) 自动 promote
      if (jobManager) {
        const job = jobManager.spawnJob({
          ownerAgentId,
          sessionId,
          projectId,
          command: args.command,
          cwd,
          timingPolicy,
          sandboxService: svc,
          policy: executionPolicy,
          scopedWritePaths,
          extraAllowedWritePaths,
          requiresNetwork: args.requires_network,
        });
        bindCancellation(job, context?.signal);

        const softTimeoutMs = timingPolicy.softTimeoutMs ?? 120_000;
        const resultRecord = await job.waitFor(softTimeoutMs);

        // 如果在 softTimeout 内已完成
        if (resultRecord.status !== "running") {
          const parts: string[] = [];
          const output = job.getBuffer().getFormattedSummary();
          if (output) parts.push(output);

          if (resultRecord.status === "cancelled") {
            parts.push("(命令已被用户中断)");
          } else if (resultRecord.exitCode !== null && resultRecord.exitCode !== 0) {
            parts.push(`(退出码: ${resultRecord.exitCode})`);
          }
          if (resultRecord.status === "timed_out") {
            parts.push(`(命令执行硬超时，已被系统终止)`);
          }
          if (parts.length === 0) {
            parts.push("(无输出)");
          }
          const formattedResult = parts.join("\n");
          return resultRecord.status === "completed" && resultRecord.exitCode === 0 ? formattedResult : {
            success: false, output: formattedResult, exitCode: resultRecord.exitCode,
            interrupted: resultRecord.status === "cancelled",
            error: resultRecord.error ?? `Process ${resultRecord.status}`,
          };
        }

        // 超过 softTimeout 仍处于 running 状态：自动 promote 为后台 Job！
        job.setPromoted(true);
        return JSON.stringify(
          {
            jobId: job.id,
            status: "running",
            promoted: true,
            durationMs: resultRecord.durationMs,
            message: `命令前台执行已达到软超时 (${Math.round(softTimeoutMs / 1000)}s)，已自动转入后台继续运行 (Job ID: ${job.id})。底层进程未被中断。你可以继续处理其他工作，待执行完毕后 Runtime 将自动通知你。`,
          },
          null,
          2
        );
      }

      // 3. 兜底降级执行（未注入 JobManager 时的简单同步执行）
      const procResult = await svc.runProcess({
        command: "bash",
        args: ["-lc", args.command],
        cwd,
        timeout: timingPolicy.hardTimeoutMs,
        policy: executionPolicy,
        scopedWritePaths,
        extraAllowedWritePaths,
        requiresNetwork: args.requires_network,
      });

      const parts: string[] = [];
      const formattedStdout = procResult.stdout ? procResult.stdout.trim() : "";
      const formattedStderr = procResult.stderr ? procResult.stderr.trim() : "";
      if (formattedStdout) parts.push(formattedStdout);
      if (formattedStderr) parts.push(`STDERR:\n${formattedStderr}`);
      if (procResult.killed) parts.push("(命令执行超时，已被系统终止)");
      if (procResult.exitCode !== 0) parts.push(`(退出码: ${procResult.exitCode})`);
      if (parts.length === 0) parts.push("(无输出)");
      const output = parts.join("\n");

      if (procResult.exitCode === 0 && !procResult.killed) {
        return output;
      }

      return {
        success: false,
        output,
        exitCode: procResult.exitCode,
        interrupted: procResult.killed,
        error: procResult.stderr || `Process exited with code ${procResult.exitCode}`,
      };
    },
  });
}

/**
 * 遵循 Tool 接口标准的默认 bash 工具实例
 */
export const bashTool: Tool<BashArgs> = createBashTool();

/**
 * 执行 bash 命令的兼容底层函数
 */
export async function executeBash(
  command: string,
  options?: ExecuteBashOptions,
  customSandboxService?: SandboxService
): Promise<string> {
  const sandboxService =
    customSandboxService ??
    new SandboxService({
      policy: createDefaultSandboxPolicy(),
      cwd: options?.cwd,
    });

  return sandboxService.runBash(command, {
    cwd: options?.cwd,
    timeoutMs: options?.timeoutMs,
  });
}
