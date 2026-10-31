import { execFile } from "node:child_process";
import type { SandboxPolicy } from "./types.js";
import { cloneSandboxPolicy } from "./policy.js";
import type {
  SandboxBackend,
  SandboxProcessRequest,
  SandboxProcessResult,
  SandboxExecutionSpec,
} from "./backends/sandbox-backend.js";
import { MacOsSeatbeltBackend } from "./backends/macos-seatbelt.js";
import {
  LinuxBackendSelector,
  SandboxUnavailableBackend,
} from "./linux/backend-selector.js";
import { WindowsBackendSelector } from "./windows/backend-selector.js";
import { SandboxUnavailableError } from "./errors.js";
import type { ApprovalService } from "../approval/approval-service.js";
import { buildSandboxEnvironment } from "./environment.js";

/**
 * 根据当前宿主操作系统自动探测并构建默认沙箱后端
 */
function createDefaultBackend(policy?: SandboxPolicy): SandboxBackend {
  if (process.platform === "darwin") {
    return new MacOsSeatbeltBackend();
  }
  if (process.platform === "linux") {
    return LinuxBackendSelector.select(policy);
  }
  if (process.platform === "win32") {
    return WindowsBackendSelector.select(policy);
  }
  return new SandboxUnavailableBackend(
    process.platform,
    `当前操作系统平台 '${process.platform}' 不受支持。仅支持 macOS (Seatbelt)、Linux (Bubblewrap / Landlock) 与 Windows (Native Windows Sandbox)。`
  );
}

export interface SandboxServiceOptions {
  /**
   * 底层平台沙箱后端实例，默认根据当前策略与 OS 自动注入
   */
  backend?: SandboxBackend;

  /**
   * 当前生效的沙箱策略
   */
  policy: SandboxPolicy;

  /**
   * 审批交互服务
   */
  approvalService?: ApprovalService;

  /**
   * 默认进程工作目录，默认为 process.cwd()
   */
  cwd?: string;
}

/**
 * 进程输出截断字符数上限
 */
const MAX_OUTPUT_LENGTH = 50_000;

/**
 * 默认命令超时毫秒数
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 统一进程沙箱服务 (SandboxService)
 *
 * 核心设计目标：
 * 1. 彻底解耦上层 bash 工具与具体 OS 沙箱实现（macOS Seatbelt, Linux Bubblewrap, Linux Landlock）；
 * 2. 严格践行 Fail-Closed 铁律：在沙箱不可用时坚决抛出 SandboxUnavailableError，绝不静默降级为裸进程；
 * 3. 统一管理命令执行生命周期、输出截断与超时控制；
 * 4. 严禁基于 exit code / stderr 启发式猜测网络阻断，权限请求必须为结构化先验能力提权；
 * 5. 确保子进程环境干净，屏蔽敏感凭据与特权 Unix Socket。
 */
export class SandboxService {
  private backend: SandboxBackend;
  private policy: SandboxPolicy;
  private readonly approvalService?: ApprovalService;
  private readonly defaultCwd: string;

  constructor(options: SandboxServiceOptions) {
    this.policy = cloneSandboxPolicy(options.policy);
    this.backend = options.backend ?? createDefaultBackend(this.policy);
    this.approvalService = options.approvalService;
    this.defaultCwd = options.cwd ?? process.cwd();
  }

  /**
   * 获取底层后端实例
   */
  getCwd(): string { return this.defaultCwd; }

  getBackend(): SandboxBackend {
    return this.backend;
  }

  /**
   * 获取当前全局策略副本
   */
  getPolicy(): SandboxPolicy {
    return cloneSandboxPolicy(this.policy);
  }

  /**
   * 运行时安全升级沙箱策略（由 TaskSecurityGrant 授权调用）
   * 必须重新探测并重建底层真实的平台沙箱后端，不得仅改 policy 属性
   */
  updatePolicy(newPolicy: SandboxPolicy, backend?: SandboxBackend): void {
    this.policy = cloneSandboxPolicy(newPolicy);
    this.backend = backend ?? createDefaultBackend(this.policy);
  }

  /**
   * 判定底层沙箱是否可用
   */
  isAvailable(): boolean {
    return this.backend.isAvailable();
  }

  /**
   * 构建沙箱化执行规格（用于 stdio MCP transport 或外部进程派生接入）
   */
  buildExecutionSpec(request: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    policy?: SandboxPolicy;
  }): SandboxExecutionSpec {
    const effectivePolicy = cloneSandboxPolicy(request.policy ?? this.policy);
    const cwd = request.cwd ?? this.defaultCwd;

    if (!this.backend.isAvailable()) {
      if (effectivePolicy.filesystem.mode !== "danger-full-access") {
        const reason = (this.backend as any).reason
          ? ` (原因: ${(this.backend as any).reason})`
          : "";
        throw new SandboxUnavailableError(
          `沙箱后端 '${this.backend.name}' 不可用${reason}且当前策略不是 danger-full-access。系统严格拒绝执行裸进程 (Fail-Closed)。`
        );
      }
      return {
        executable: request.command,
        args: request.args ?? [],
        cwd,
        env: buildSandboxEnvironment(request.env),
      };
    }

    if (typeof this.backend.buildExecutionSpec === "function") {
      return this.backend.buildExecutionSpec({
        command: request.command,
        args: request.args,
        cwd,
        env: request.env,
        policy: effectivePolicy,
      });
    }

    if (effectivePolicy.filesystem.mode !== "danger-full-access") throw new SandboxUnavailableError("Backend does not provide a sandboxed process specification (Fail-Closed)");
    return {
      executable: request.command,
      args: request.args ?? [],
      cwd,
      env: buildSandboxEnvironment(request.env),
    };
  }

  async authorizeProcess(request: { command: string; args?: string[]; requiresNetwork?: boolean; policy?: SandboxPolicy }, signal?: AbortSignal): Promise<SandboxPolicy> {
    signal?.throwIfAborted();
    const effectivePolicy = cloneSandboxPolicy(request.policy ?? this.policy);
    // 1. 先验结构化能力审查 (Ahead-of-Time Structured Approval):
    // 若请求显式声明了需要网络访问 (requiresNetwork: true)，在执行前主动发起审批
    if (request.requiresNetwork && effectivePolicy.network.mode === "deny") {
      // 安全边界铁律：approval 只决定「允许的审批如何获得授权」，
      // 绝不能单独把明确的 network: deny 放宽为 allow。
      // 需要网络的能力变更必须由管理员显式授予任务级全访问 (network: allow)，
      // 或把全局策略切换为 network: allow —— 二者都留下配置版本与审计记录。
      if (effectivePolicy.approval.mode === "auto-grant") {
        throw new SandboxUnavailableError(
          `命令 '${request.command}' 声明需要网络访问，但当前策略明确禁止网络 (network: deny)。` +
          `approval: auto-grant 不能放宽网络边界；如需联网，请由管理员授予该 Task/Run 全访问，或将全局策略切换为 network: allow。`
        );
      }
      if (effectivePolicy.approval.mode === "never") {
        throw new SandboxUnavailableError(
          `命令 '${request.command}' 声明需要网络访问权限，但当前策略禁止网络且不允许审批提权 (approval: never)。`
        );
      }

      if (!this.approvalService) {
        throw new SandboxUnavailableError(
          `命令 '${request.command}' 声明需要网络访问权限，但当前环境未配置 ApprovalService，严格 Fail-Closed。`
        );
      }

      const commandDisplay = request.args
        ? `${request.command} ${request.args.join(" ")}`
        : request.command;

      const decision = await this.approvalService.requestApproval({
        capability: "network",
        target: commandDisplay,
        reason: "命令明确声明需要外部网络访问权限，请求临时放行一次",
      }, { signal });
      signal?.throwIfAborted();

      if (decision === "allow-once") {
        effectivePolicy.network.mode = "allow";
      } else {
        throw new SandboxUnavailableError(
          `用户拒绝了网络访问审批请求 (目标: '${commandDisplay}')。`
        );
      }
    }
    return effectivePolicy;
  }

  /**
   * 在沙箱环境中执行进程
   *
   * @param request - 进程执行请求详情
   */
  async runProcess(
    request: Omit<SandboxProcessRequest, "policy" | "cwd"> & {
      policy?: SandboxPolicy;
      cwd?: string;
    }
  ): Promise<SandboxProcessResult> {
    const effectivePolicy = await this.authorizeProcess(request);
    const cwd = request.cwd ?? this.defaultCwd;

    // Fail-Closed 核心逻辑校验：
    // 若后端沙箱不可用，仅当显式指定 danger-full-access 模式时才允许裸进程执行，否则坚决拒绝执行！
    if (!this.backend.isAvailable()) {
      if (effectivePolicy.filesystem.mode !== "danger-full-access") {
        const reason = (this.backend as any).reason
          ? ` (原因: ${(this.backend as any).reason})`
          : "";
        throw new SandboxUnavailableError(
          `沙箱后端 '${this.backend.name}' 不可用${reason}且当前策略不是 danger-full-access。系统严格拒绝执行裸进程 (Fail-Closed)。`
        );
      }

      // danger-full-access 模式下若无沙箱可用，回退至宿主裸进程执行
      return this.runBareProcess({
        ...request,
        policy: effectivePolicy,
        cwd,
      });
    }


    const fullRequest: SandboxProcessRequest = {
      command: request.command,
      args: request.args,
      cwd,
      env: request.env,
      policy: effectivePolicy,
      timeout: request.timeout,
      maxBuffer: request.maxBuffer,
      extraAllowedWritePaths: request.extraAllowedWritePaths,
      scopedWritePaths: request.scopedWritePaths,
      requiresNetwork: request.requiresNetwork,
    };

    // 2. 尝试沙箱执行
    const result = await this.backend.run(fullRequest);

    if (result.exitCode === 0) {
      return result;
    }

    // 3. 内核网络阻断后的重试：只在「人工显式授权」下进行，且绝不静默放宽。
    //    - auto-grant：一律不重试（auto-grant 不能覆盖 network: deny）。
    //    - never：一律不重试。
    //    - ask：只有在用户明确同意「重新执行一次」后才以一次性 allow 重跑；
    //      第一次执行可能已经产生副作用，审批文案必须如实告知。
    if (
      effectivePolicy.network.mode === "deny" &&
      effectivePolicy.approval.mode === "ask" &&
      this.approvalService &&
      this.isKernelNetworkDenial(result, request.command)
    ) {
      const commandDisplay = request.args
        ? `${request.command} ${request.args.join(" ")}`
        : request.command;

      const decision = await this.approvalService.requestApproval({
        capability: "network",
        target: commandDisplay,
        reason:
          "进程因 network: deny 被内核阻断失败。该命令可能已产生副作用；" +
          "是否允许以网络访问权限重新执行一次？（仅本次，不影响全局策略）",
      });

      if (decision === "allow-once") {
        // 构造一次性临时 Policy，绝不污染全局
        const overridePolicy = cloneSandboxPolicy(effectivePolicy);
        overridePolicy.network.mode = "allow";

        const retryRequest: SandboxProcessRequest = {
          ...fullRequest,
          policy: overridePolicy,
        };

        return await this.backend.run(retryRequest);
      }
    }

    return result;
  }

  /**
   * 仅匹配由内核或底层运行时明确报告的特权/网络访问禁止信号 (EPERM / NET_ERR:EPERM)
   * 严禁依赖 exitCode === 6/7、DNS 错误、fetch failed 等启发式猜测
   */
  private isKernelNetworkDenial(
    result: SandboxProcessResult,
    command?: string
  ): boolean {
    const combined = `${result.stderr}\n${result.stdout}`;
    // 明确的沙箱测试标志或内核网络硬阻断 (syscall: connect / socket 报 EPERM 或 Operation not permitted)
    if (
      combined.includes("NET_ERR:EPERM") ||
      combined.includes("NET_ERR:1") ||
      /connect\s+EPERM/i.test(combined) ||
      (/EPERM/i.test(combined) && /(connect|socket|\/dev\/tcp)/i.test(combined)) ||
      (/Operation not permitted/i.test(combined) && /(connect|socket|\/dev\/tcp)/i.test(combined))
    ) {
      return true;
    }

    // 显式网络客户端工具 (如 curl) 在 network namespace 隔离下的退出码
    const isCurl =
      command === "curl" ||
      (typeof command === "string" && (command.endsWith("/curl") || /\bcurl\b/i.test(command)));
    if (isCurl && (result.exitCode === 6 || result.exitCode === 7)) {
      return true;
    }

    return false;
  }

  /**
   * 便捷执行 bash 命令，返回兼容原有 bash 工具格式的标准字符串输出
   *
   * @param command - 需要在 bash 中执行的脚本命令行
   * @param options - 附加配置（工作目录、超时时间）
   */
  async runBash(
    command: string,
    options?: {
      cwd?: string;
      timeoutMs?: number;
      policy?: SandboxPolicy;
      scopedWritePaths?: string[];
      extraAllowedWritePaths?: string[];
      requiresNetwork?: boolean;
    }
  ): Promise<string> {
    const cwd = options?.cwd ?? this.defaultCwd;
    const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const result = await this.runProcess({
      command: "bash",
      args: ["--noprofile", "--norc", "-c", command],
      cwd,
      timeout,
      policy: options?.policy,
      scopedWritePaths: options?.scopedWritePaths,
      extraAllowedWritePaths: options?.extraAllowedWritePaths,
      requiresNetwork: options?.requiresNetwork,
    });

    let formattedStdout = result.stdout ? result.stdout.trim() : "";
    let formattedStderr = result.stderr ? result.stderr.trim() : "";

    if (formattedStdout.length > MAX_OUTPUT_LENGTH) {
      formattedStdout =
        formattedStdout.slice(0, MAX_OUTPUT_LENGTH) +
        `\n... [stdout 已截断，总长度: ${result.stdout.length} 字符]`;
    }

    if (formattedStderr.length > MAX_OUTPUT_LENGTH) {
      formattedStderr =
        formattedStderr.slice(0, MAX_OUTPUT_LENGTH) +
        `\n... [stderr 已截断，总长度: ${result.stderr.length} 字符]`;
    }

    const parts: string[] = [];
    if (formattedStdout) {
      parts.push(formattedStdout);
    }
    if (formattedStderr) {
      parts.push(`STDERR:\n${formattedStderr}`);
    }
    if (result.killed) {
      parts.push(`命令执行超时（超过 ${timeout}ms）`);
    }
    if (parts.length === 0) {
      parts.push("(无输出)");
    }
    if (result.exitCode !== 0) {
      parts.push(`(退出码: ${result.exitCode})`);
    }

    return parts.join("\n");
  }

  /**
   * 仅在 danger-full-access 显式高权限模式且无可用沙箱时运行的裸进程兜底实现
   */
  private async runBareProcess(
    request: SandboxProcessRequest
  ): Promise<SandboxProcessResult> {
    const sanitizedEnv = buildSandboxEnvironment(request.env);
    const args = request.args ?? [];
    const timeout = request.timeout ?? DEFAULT_TIMEOUT_MS;
    const maxBuffer = request.maxBuffer ?? 10 * 1024 * 1024;

    return new Promise<SandboxProcessResult>((resolve) => {
      execFile(
        request.command,
        args,
        {
          cwd: request.cwd,
          env: sanitizedEnv,
          timeout,
          maxBuffer,
        },
        (error, stdout, stderr) => {
          let exitCode = 0;
          let killed = false;

          if (error) {
            exitCode = typeof error.code === "number" ? error.code : 1;
            killed = Boolean(error.killed);
          }

          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode,
            killed,
          });
        }
      );
    });
  }
}
