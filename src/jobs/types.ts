/**
 * Job 运行时生命周期状态
 */
export type JobStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

/**
 * 单个 Tool 的时间与超时策略
 */
export interface ToolTimingPolicy {
  /**
   * 工具是否支持脱离当前 Agent Loop 并在后台异步继续执行
   */
  backgroundable: boolean;

  /**
   * 软超时（毫秒）：Agent 同步等待的最长时间。
   * 超过该时间不 kill 进程，而是自动 promote 为后台 Job 返回 jobId 并恢复 Agent Loop。
   * 仅在 backgroundable = true 时有效。
   */
  softTimeoutMs?: number;

  /**
   * 硬超时（毫秒）：真实底层进程允许存活的最长生命周期。
   * 达到硬超时后系统将依次发送 SIGTERM -> gracePeriod -> SIGKILL。
   */
  hardTimeoutMs: number;

  /**
   * 主动等待超时（毫秒）：Agent 调用 job_output(wait=true) 时最多同步等待的时间。
   * 超时后返回 running 状态，绝不 kill Job。
   */
  waitTimeoutMs?: number;

  /**
   * SIGTERM 发出后的清理宽限期（毫秒），宽限期满若未退出则发送 SIGKILL。
   */
  killGraceMs?: number;
}

/**
 * 默认 Bash 工具时间策略
 */
export const DEFAULT_BASH_TIMING_POLICY: ToolTimingPolicy = {
  backgroundable: true,
  softTimeoutMs: 120_000, // 120 秒软超时
  hardTimeoutMs: 1_800_000, // 30 分钟硬超时
  waitTimeoutMs: 30_000, // 30 秒主动等待
  killGraceMs: 5_000, // 5 秒 SIGKILL 宽限期
};

/**
 * 默认只读/短工具时间策略
 */
export const DEFAULT_SHORT_TOOL_TIMING_POLICY: ToolTimingPolicy = {
  backgroundable: false,
  hardTimeoutMs: 30_000, // 30 秒硬超时
};

/**
 * 后台 Job 记录结构
 */
export interface JobRecord {
  /**
   * 统一 Job 唯一标识 (如 job-1, job-2)
   */
  id: string;

  /**
   * 所属 Agent 标识
   */
  ownerAgentId: string;

  /**
   * 所属会话 ID
   */
  sessionId: string;

  /**
   * 所属项目 ID
   */
  projectId: string;

  /**
   * Job 类别，当前主要为 process
   */
  kind: "process";

  /**
   * 启动的命令语句
   */
  command: string;

  /**
   * 当前状态
   */
  status: JobStatus;

  /**
   * 是否是由软超时自动提升 (promoted) 至后台
   */
  promoted?: boolean;

  /** 调用方显式请求后台运行，而非普通前台命令的内部 Job 记录。 */
  backgroundRequested?: boolean;

  /**
   * 启动时间戳
   */
  startedAt: number;

  /**
   * 完成时间戳
   */
  completedAt?: number;

  /**
   * 实际执行总耗时（毫秒）
   */
  durationMs?: number;

  /**
   * 软超时与硬超时设定
   */
  softTimeoutMs?: number;
  hardTimeoutMs: number;

  /**
   * 底层 OS 进程 PID
   */
  pid?: number;

  /**
   * 进程退出码
   */
  exitCode?: number | null;

  /**
   * 终止信号（如 SIGTERM / SIGKILL）
   */
  signal?: string | null;

  /**
   * 错误描述（若失败）
   */
  error?: string;

  /**
   * 格式化最终输出结果（成功或失败）
   */
  resultSummary?: string;
}

/**
 * 创建进程 Job 的配置参数
 */
export interface CreateProcessJobOptions {
  id?: string;
  ownerAgentId: string;
  sessionId: string;
  projectId: string;
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  timingPolicy?: Partial<ToolTimingPolicy>;
  scopedWritePaths?: string[];
  extraAllowedWritePaths?: string[];
  policy?: import("../sandbox/types.js").SandboxPolicy;
  sandboxService?: import("../sandbox/sandbox-service.js").SandboxService;
  promoted?: boolean;
  backgroundRequested?: boolean;
  requiresNetwork?: boolean;
}

/**
 * BoundedOutputBuffer 状态快照
 */
export interface OutputBufferSnapshot {
  totalBytes: number;
  retainedBytes: number;
  truncated: boolean;
  stdoutTail: string;
  stderrTail: string;
  combinedTail: string;
}
