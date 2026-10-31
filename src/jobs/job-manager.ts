import { defaultTraceContext } from "../observability/trace-context.js";
import type { EventBus } from "../observability/event-bus.js";
import type { HarnessEvent } from "../observability/types.js";
import { ProcessJob } from "./process-job.js";
import type {
  JobRecord,
  JobStatus,
  CreateProcessJobOptions,
} from "./types.js";
import {
  JobNotFoundError,
  JobPermissionDeniedError,
} from "./errors.js";

export interface JobManagerOptions {
  eventBus?: EventBus;
  defaultProjectId?: string;
  defaultSessionId?: string;
  sandboxService?: import("../sandbox/sandbox-service.js").SandboxService;
  maxConsecutiveWakes?: number;
}

/**
 * 统一管理所有后台 Job 实例的生命周期、并发状态与事件分发管理器
 *
 * 铁律：
 * 1. 严格区分 Task (目标工作单元) 与 Job (工具后台执行实例)，绝不混淆；
 * 2. 统一通过 EventBus 向订阅方（如 CliPresenter、AgentLoop）分发强类型事件；
 * 3. 严格校验 Agent 权限边界：非 owner 且非 Main/Lead 严禁越权终止他人 Job；
 * 4. 彻底杜绝孤儿进程：在 Run 被取消、中断或异常时安全回收全部运行中 Job；
 * 5. 崩溃自愈：Session 重放或启动检测到旧 running 状态时收敛为 interrupted。
 */
export class JobManager {
  private readonly jobs = new Map<string, ProcessJob>();
  private readonly archivedRecords = new Map<string, JobRecord>();
  private readonly eventBus?: EventBus;
  private readonly defaultProjectId: string;
  private readonly defaultSessionId: string;
  private readonly sandboxService?: import("../sandbox/sandbox-service.js").SandboxService;
  readonly maxConsecutiveWakes: number;

  private jobCounter = 0;

  constructor(options?: JobManagerOptions) {
    this.eventBus = options?.eventBus;
    this.defaultProjectId = options?.defaultProjectId ?? "default";
    this.defaultSessionId = options?.defaultSessionId ?? "default";
    this.sandboxService = options?.sandboxService;
    this.maxConsecutiveWakes = options?.maxConsecutiveWakes ?? 20;
  }

  /**
   * 生成人类可读的递增 Job ID (如 job-1, job-2)
   */
  generateJobId(): string {
    this.jobCounter++;
    return `job-${this.jobCounter}`;
  }

  /**
   * 启动一个新的受沙箱治理的 ProcessJob
   */
  spawnJob(options: CreateProcessJobOptions): ProcessJob {
    const id = options.id ?? this.generateJobId();
    const sessionId = options.sessionId || this.defaultSessionId;
    const projectId = options.projectId || this.defaultProjectId;
    const sandboxService = options.sandboxService || this.sandboxService;

    const processJob = new ProcessJob({
      ...options,
      id,
      sessionId,
      projectId,
      sandboxService,
    });

    this.jobs.set(id, processJob);

    // 触发 job.created 事件
    this.emitEvent("job.created", processJob.getRecord());

    // 真实启动进程
    try { processJob.start(); }
    catch (error) {
      this.archivedRecords.set(id, processJob.getRecord());
      this.emitEvent("job.failed", processJob.getRecord());
      throw error;
    }
    this.emitEvent("job.started", processJob.getRecord());

    if (processJob.getRecord().promoted) {
      this.emitEvent("job.promoted", processJob.getRecord());
    }

    // 监听完成生命周期事件
    processJob.onComplete((record) => {
      this.archivedRecords.set(record.id, record);

      switch (record.status) {
        case "completed":
          this.emitEvent("job.completed", record);
          break;
        case "failed":
          this.emitEvent("job.failed", record);
          break;
        case "cancelled":
          this.emitEvent("job.cancelled", record);
          break;
        case "timed_out":
          this.emitEvent("job.timed_out", record);
          break;
        default:
          break;
      }
    });

    return processJob;
  }

  /**
   * 获取指定的运行中或已完成的 ProcessJob
   */
  getJob(jobId: string): ProcessJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * 获取所有当前正在运行的 ProcessJob 实例
   */
  getRunningJobs(): ProcessJob[] {
    return Array.from(this.jobs.values()).filter(
      (job) => job.getRecord().status === "running"
    );
  }

  /**
   * 获取指定的 Job 记录快照（包含归档记录）
   */
  getJobRecord(jobId: string): JobRecord | undefined {
    const job = this.jobs.get(jobId);
    if (job) {
      return job.getRecord();
    }
    return this.archivedRecords.get(jobId);
  }

  /**
   * 列出符合条件的 Job 记录列表
   */
  listJobs(filter?: {
    ownerAgentId?: string;
    sessionId?: string;
    projectId?: string;
    status?: JobStatus;
  }): JobRecord[] {
    const allRecords: JobRecord[] = [];

    for (const job of this.jobs.values()) {
      allRecords.push(job.getRecord());
    }

    for (const [id, record] of this.archivedRecords.entries()) {
      if (!this.jobs.has(id)) {
        allRecords.push(record);
      }
    }

    return allRecords.filter((rec) => {
      if (filter?.ownerAgentId && rec.ownerAgentId !== filter.ownerAgentId) {
        return false;
      }
      if (filter?.sessionId && rec.sessionId !== filter.sessionId) {
        return false;
      }
      if (filter?.projectId && rec.projectId !== filter.projectId) {
        return false;
      }
      if (filter?.status && rec.status !== filter.status) {
        return false;
      }
      return true;
    });
  }

  /**
   * 等待指定的 Job 完成或主动等待超时
   */
  async waitForJob(
    jobId: string,
    timeoutMs?: number,
    callerAgentId?: string
  ): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) {
      const archived = this.archivedRecords.get(jobId);
      if (archived) return archived;
      throw new JobNotFoundError(jobId);
    }

    // 权限校验（只读查看允许 Lead 或自身）
    if (
      callerAgentId &&
      callerAgentId !== "main" &&
      callerAgentId !== "main-agent" &&
      callerAgentId !== job.ownerAgentId
    ) {
      // 允许查询状态，但记录日志
    }

    return await job.waitFor(timeoutMs);
  }

  /**
   * 终止指定的 Job，实施权限隔离
   */
  async killJob(
    jobId: string,
    callerAgentId?: string,
    signal: NodeJS.Signals = "SIGTERM"
  ): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) {
      const archived = this.archivedRecords.get(jobId);
      if (archived) return archived;
      throw new JobNotFoundError(jobId);
    }

    // 权限校验：仅允许 Main / Leader 或 Job 自身的拥有者进行 kill
    if (
      callerAgentId &&
      callerAgentId !== "main" &&
      callerAgentId !== "main-agent" &&
      callerAgentId !== job.ownerAgentId
    ) {
      throw new JobPermissionDeniedError(jobId, callerAgentId, job.ownerAgentId);
    }

    await job.kill(signal);
    return job.getRecord();
  }

  /**
   * 清理指定会话下的所有运行中 Job（防止孤儿进程）
   */
  async cleanupSession(sessionId: string): Promise<void> {
    const killPromises: Promise<void>[] = [];
    for (const job of this.jobs.values()) {
      if (job.sessionId === sessionId) {
        killPromises.push(job.kill("SIGTERM"));
      }
    }
    await Promise.allSettled(killPromises);
  }

  /**
   * 清理所有运行中的 Job（程序退出或崩溃时调用）
   */
  async cleanupAll(): Promise<void> {
    const killPromises: Promise<void>[] = [];
    for (const job of this.jobs.values()) {
      killPromises.push(job.kill("SIGTERM"));
    }
    await Promise.allSettled(killPromises);
  }

  /**
   * 崩溃恢复：将重放/重启发现的 running 状态 Job 安全收敛为 interrupted
   */
  recoverSessionJobs(savedRecords: JobRecord[]): JobRecord[] {
    return savedRecords.map((record) => {
      if (record.status === "running") {
        const interrupted: JobRecord = {
          ...record,
          status: "interrupted",
          error: "PROCESS_CRASH_RECOVERED: Nash 重新启动，旧进程句柄已自动释放",
          completedAt: Date.now(),
        };
        this.archivedRecords.set(interrupted.id, interrupted);
        return interrupted;
      }
      this.archivedRecords.set(record.id, record);
      return record;
    });
  }

  private emitEvent(
    type:
      | "job.created"
      | "job.started"
      | "job.promoted"
      | "job.completed"
      | "job.failed"
      | "job.cancelled"
      | "job.timed_out",
    data: JobRecord
  ): void {
    if (!this.eventBus) return;

    const ctx = defaultTraceContext.get();
    const event: HarnessEvent<JobRecord & { toolCallId?: string }> = {
      id: `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      timestamp: new Date().toISOString(),
      projectId: data.projectId,
      sessionId: data.sessionId,
      agentId: data.ownerAgentId,
      traceId: ctx?.traceId, spanId: ctx?.spanId, parentSpanId: ctx?.parentSpanId,
      data: { ...data, toolCallId: ctx?.toolCallId },
    };

    this.eventBus.emit(event);
  }
}
