/**
 * 文件系统沙箱模式：
 * - read-only: 允许读取工作区和系统必要路径，禁止修改工作区及工作区外任意写入
 * - workspace-write: 允许工作区内读写及受控临时目录写入，禁止工作区外写入
 * - full-capability: 完整开发者能力模式，允许合法代码读写与执行，由 Pre-Tool Security Monitor 审查安全边界
 * - danger-full-access: 显式高权限模式，不施加工作区文件系统限制
 */
export type FilesystemMode =
  | "read-only"
  | "workspace-write"
  | "full-capability"
  | "danger-full-access";

/**
 * 网络沙箱模式：
 * - deny: 禁止进程发起外部网络访问（默认模式）
 * - allow: 允许进程网络访问
 */
export type NetworkMode = "deny" | "allow";

/**
 * 审批交互模式：
 * - never: 策略违规时直接拒绝，绝不向用户发起审批
 * - ask: 策略违规且具备提权可能时向用户交互式请求一次性放行（默认模式）
 */
/**
 * 审批交互模式：
 * - never: 策略违规时直接拒绝，绝不向用户发起审批
 * - ask: 策略违规且具备提权可能时向用户交互式请求一次性放行（受限模式默认）
 * - auto-grant: 安全审查通过的调用直接放行，不逐次打扰用户（完全访问自主模式的默认值）。
 *   注意：auto-grant 不是「跳过安全检查」——
 *   确定性硬拦截（BLOCK / isHardBlock）依然不可放行；
 *   安全审查模型不可用导致的 Fail-Closed 升级也绝不自动放行。
 */
export type ApprovalMode = "never" | "ask" | "auto-grant";

/**
 * 统一沙箱安全策略定义
 */
export interface SandboxPolicy {
  filesystem: {
    mode: FilesystemMode;
  };
  network: {
    mode: NetworkMode;
  };
  approval: {
    mode: ApprovalMode;
  };
}

/**
 * 进程执行请求参数
 */
export interface SandboxProcessRequest {
  /**
   * 执行的命令或程序名称（如 "bash"）
   */
  command: string;

  /**
   * 命令行参数数组（如 ["-lc", "ls -la"]）
   */
  args?: string[];

  /**
   * 子进程工作目录（绝对路径）
   */
  cwd: string;

  /**
   * 传递给子进程的环境变量
   */
  env?: Record<string, string>;

  /**
   * 当前执行所适用的沙箱策略
   */
  policy: SandboxPolicy;

  /**
   * 命令执行超时时间（毫秒）
   */
  timeout?: number;

  /**
   * stdout / stderr 最大缓冲区大小（字节）
   */
  maxBuffer?: number;

  /**
   * 额外允许写入的文件或目录路径（如经过用户一次性审批放行的路径）
   */
  extraAllowedWritePaths?: string[];

  /**
   * 精确限定的可写范围路径列表（当 Task 声明了 writeScopes 时用于将 OS 沙箱限制在精确子目录）
   */
  scopedWritePaths?: string[];

  /**
   * 结构化声明：当前执行是否需要外部网络访问权限（用于在 network: deny 下先验发起审批）
   */
  requiresNetwork?: boolean;
}

/**
 * 进程执行结果
 */
export interface SandboxProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed?: boolean;
}

/**
 * 平台沙箱能力指示器
 */
export interface SandboxBackendCapabilities {
  /**
   * 是否支持文件系统沙箱隔离（只读/工作区可写/路径白名单）
   */
  filesystemIsolation: boolean;

  /**
   * 是否支持网络栈命名空间隔离
   */
  networkIsolation: boolean;

  /**
   * 是否支持独立的进程隔离（PID 命名空间）
   */
  processIsolation: boolean;

  /**
   * 是否支持底层系统调用白名单/黑名单过滤 (如 seccomp)
   */
  syscallFiltering: boolean;

  /**
   * 是否强制 no_new_privs
   */
  noNewPrivileges?: boolean;

  /**
   * 是否隔离 Unix Domain Socket / 宿主 IPC 能力
   */
  unixSocketIsolation?: boolean;

  /**
   * 是否支持资源限额 (如 cgroup v2 CPU/Memory/PID limit)
   */
  resourceLimits: boolean;
}

/**
 * 沙箱进程启动执行规格
 */
export interface SandboxExecutionSpec {
  /** Backend-owned process tree termination when a wrapper creates nested groups. */
  terminate?: (pid: number, signal: NodeJS.Signals) => void;
  /** Release resources after spawn failure or process close. */
  cleanup?: () => void;
  /**
   * 实际启动的底层隔离可执行文件（如 /usr/bin/sandbox-exec 或 /usr/bin/bwrap，或裸命令）
   */
  executable: string;

  /**
   * 传递给底层隔离程序的完整命令行参数数组
   */
  args: string[];

  /**
   * 子进程工作目录（绝对路径）
   */
  cwd: string;

  /**
   * 已净化的安全环境变量
   */
  env: Record<string, string>;
}

/**
 * 平台沙箱底层后端接口
 */
export interface SandboxBackend {
  readonly name: string;

  /**
   * 探测当前系统环境该沙箱后端是否可用且可信
   */
  isAvailable(): boolean;

  /**
   * 获取当前沙箱后端支持的能力特征
   */
  getCapabilities?(): SandboxBackendCapabilities;

  /**
   * 根据当前安全策略与请求参数，构建底层可执行程序及沙箱隔离参数
   */
  buildExecutionSpec?(request: SandboxProcessRequest): SandboxExecutionSpec;

  /**
   * 在沙箱约束环境中启动并执行进程
   */
  run(request: SandboxProcessRequest): Promise<SandboxProcessResult>;
}
