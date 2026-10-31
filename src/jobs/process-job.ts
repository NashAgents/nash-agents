import { spawn, type ChildProcess } from "node:child_process";
import type {
  JobRecord,
  JobStatus,
  CreateProcessJobOptions,
  ToolTimingPolicy,
} from "./types.js";
import { DEFAULT_BASH_TIMING_POLICY } from "./types.js";
import { BoundedOutputBuffer } from "./output-buffer.js";
import { SandboxService } from "../sandbox/sandbox-service.js";
import { buildSandboxEnvironment } from "../sandbox/environment.js";
import { createDefaultSandboxPolicy } from "../sandbox/policy.js";
import { SandboxUnavailableError } from "../sandbox/errors.js";
import {
  type ProcessTreeTerminator,
  createDefaultProcessTreeTerminator,
} from "./process-tree-terminator.js";

/**
 * 单个受沙箱隔离与时间治理的真实进程 Job 实例 (ProcessJob)
 *
 * 铁律：
 * 1. 严格受到 Sandbox 策略约束，绝不脱离 Seatbelt 或泄漏宿主环境变量；
 * 2. 支持 softTimeout (自动转后台)、hardTimeout (SIGTERM -> grace -> SIGKILL) 与 waitTimeout (主动等待不杀进程)；
 * 3. 统一使用 BoundedOutputBuffer 收集 stdout/stderr，杜绝内存撑爆；
 * 4. 具备确定性的事件生命周期与状态收敛。
 */
export class ProcessJob {
  readonly id: string;
  readonly ownerAgentId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly command: string;
  readonly kind = "process" as const;

  private readonly timingPolicy: Required<ToolTimingPolicy>;
  private readonly buffer: BoundedOutputBuffer;
  private readonly options: CreateProcessJobOptions;
  private readonly treeTerminator: ProcessTreeTerminator;

  private childProcess?: ChildProcess;
  private executionCleanup?: () => void;
  private executionTerminator?: (pid: number, signal: NodeJS.Signals) => void;
  private status: JobStatus = "running";
  private startedAt = 0;
  private startedMonotonic?: number;
  private completedDurationMs?: number;
  private completedAt?: number;
  private pid?: number;
  private exitCode: number | null = null;
  private signal: string | null = null;
  private error?: string;
  private promoted = false;

  private hardTimeoutTimer?: NodeJS.Timeout;
  private graceTimer?: NodeJS.Timeout;

  private readonly completionListeners: Array<(record: JobRecord) => void> = [];
  private resolveTermination!: () => void;
  private readonly termination = new Promise<void>((resolve) => { this.resolveTermination = resolve; });

  constructor(options: CreateProcessJobOptions) {
    this.id = options.id ?? `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.ownerAgentId = options.ownerAgentId;
    this.sessionId = options.sessionId;
    this.projectId = options.projectId;
    this.command = options.command;
    this.promoted = Boolean(options.promoted);
    this.options = options;

    this.timingPolicy = {
      backgroundable: options.timingPolicy?.backgroundable ?? DEFAULT_BASH_TIMING_POLICY.backgroundable,
      softTimeoutMs: options.timingPolicy?.softTimeoutMs ?? DEFAULT_BASH_TIMING_POLICY.softTimeoutMs!,
      hardTimeoutMs: options.timingPolicy?.hardTimeoutMs ?? DEFAULT_BASH_TIMING_POLICY.hardTimeoutMs,
      waitTimeoutMs: options.timingPolicy?.waitTimeoutMs ?? DEFAULT_BASH_TIMING_POLICY.waitTimeoutMs!,
      killGraceMs: options.timingPolicy?.killGraceMs ?? DEFAULT_BASH_TIMING_POLICY.killGraceMs!,
    };

    this.buffer = new BoundedOutputBuffer();
    this.treeTerminator = createDefaultProcessTreeTerminator();
  }

  getBuffer(): BoundedOutputBuffer {
    return this.buffer;
  }

  getRecord(): JobRecord {
    return {
      id: this.id,
      ownerAgentId: this.ownerAgentId,
      sessionId: this.sessionId,
      projectId: this.projectId,
      kind: this.kind,
      command: this.command,
      status: this.status,
      promoted: this.promoted,
      backgroundRequested: Boolean(this.options.backgroundRequested),
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      durationMs: this.startedMonotonic === undefined ? 0 : this.completedDurationMs ?? Math.max(0, performance.now() - this.startedMonotonic),
      softTimeoutMs: this.timingPolicy.softTimeoutMs,
      hardTimeoutMs: this.timingPolicy.hardTimeoutMs,
      pid: this.pid,
      exitCode: this.exitCode,
      signal: this.signal,
      error: this.error,
      resultSummary: this.buffer.getFormattedSummary(),
    };
  }

  getTimingPolicy(): Required<ToolTimingPolicy> {
    return { ...this.timingPolicy };
  }

  setPromoted(promoted = true): void {
    this.promoted = promoted;
  }

  /**
   * 在系统沙箱约束下真实启动子进程
   */
  start(): void {
    if (this.childProcess) {
      return;
    }

    this.startedAt = Date.now();
    this.startedMonotonic = performance.now();
    try {
    const policy = this.options.policy ?? this.options.sandboxService?.getPolicy() ?? createDefaultSandboxPolicy();
    const sandboxService =
      this.options.sandboxService ?? new SandboxService({ policy });
    const backend = sandboxService.getBackend();

    let cwd = this.options.cwd ?? process.cwd();
    let sanitizedEnv = buildSandboxEnvironment(
      this.options.env as Record<string, string> | undefined
    );

    let executable: string;
    let spawnArgs: string[];

    if (backend.isAvailable()) {
      if (typeof backend.buildExecutionSpec === "function") {
        const spec = backend.buildExecutionSpec({
          command: "bash",
          args: ["--noprofile", "--norc", "-c", this.command],
          cwd,
          env: sanitizedEnv,
          policy,
          timeout: this.timingPolicy.hardTimeoutMs,
          scopedWritePaths: this.options.scopedWritePaths,
          extraAllowedWritePaths: this.options.extraAllowedWritePaths,
          requiresNetwork: this.options.requiresNetwork,
        });
        this.executionCleanup = spec.cleanup;
        this.executionTerminator = spec.terminate;
        executable = spec.executable;
        spawnArgs = spec.args;
        cwd = spec.cwd;
        sanitizedEnv = spec.env;
      } else {
        if (policy.filesystem.mode !== "danger-full-access") throw new SandboxUnavailableError("沙箱后端缺少进程启动规格 (Fail-Closed)");
        executable = "bash";
        spawnArgs = ["--noprofile", "--norc", "-c", this.command];
      }
    } else {
      // Fail-Closed 检查：若无沙箱可用且非 danger-full-access，严格阻断
      if (policy.filesystem.mode !== "danger-full-access") {
        this.status = "failed";
        this.markCompleted();
        const reason = (backend as any).reason
          ? ` (${(backend as any).reason})`
          : "";
        this.error = `沙箱不可用${reason}且策略不是 danger-full-access (Fail-Closed)`;
        throw new SandboxUnavailableError(this.error);
      }

      executable = "bash";
      spawnArgs = ["--noprofile", "--norc", "-c", this.command];
    }

    try {
      this.childProcess = spawn(executable, spawnArgs, {
        cwd,
        env: sanitizedEnv,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      this.status = "failed";
      this.markCompleted();
      this.error = err instanceof Error ? err.message : String(err);
      this.notifyCompletion();
      throw err;
    }

    this.pid = this.childProcess.pid;

    // 绑定输出流
    if (this.childProcess.stdout) {
      this.childProcess.stdout.setEncoding("utf-8");
      this.childProcess.stdout.on("data", (chunk: string) => {
        this.buffer.appendStdout(chunk);
      });
    }

    if (this.childProcess.stderr) {
      this.childProcess.stderr.setEncoding("utf-8");
      this.childProcess.stderr.on("data", (chunk: string) => {
        this.buffer.appendStderr(chunk);
      });
    }

    this.childProcess.on("error", (err: Error) => {
      this.releaseExecution();
      if (this.status === "running") {
        this.status = "failed";
        this.error = err.message;
        this.markCompleted();
        this.clearTimers();
        this.notifyCompletion();
      }
    });

    this.childProcess.on("close", (code, sig) => {
      this.releaseExecution();
      // The shell can exit before descendants that ignored SIGTERM and detached stdio.
      if ((this.status === "cancelled" || this.status === "timed_out") && process.platform !== "win32" && this.pid) {
        try { process.kill(-this.pid, "SIGKILL"); } catch { /* The group already exited. */ }
      }
      this.exitCode = code;
      this.signal = sig;
      this.markCompleted();
      this.clearTimers();

      if (this.status === "running") {
        if (code === 0) {
          this.status = "completed";
        } else {
          this.status = "failed";
          this.error = `进程退出码非 0: ${code}${sig ? ` (信号: ${sig})` : ""}`;
        }
      }

      this.notifyCompletion();
    });

    // 启动硬超时计时器 (hardTimeout)
    if (this.timingPolicy.hardTimeoutMs > 0) {
      this.hardTimeoutTimer = setTimeout(() => {
        this.handleHardTimeout();
      }, this.timingPolicy.hardTimeoutMs);
    }
    } catch (error) {
      this.releaseExecution();
      if (this.completedAt === undefined) {
        this.status = "failed";
        this.error = error instanceof Error ? error.message : String(error);
        this.markCompleted();
        this.clearTimers();
        this.notifyCompletion();
      }
      throw error;
    }
  }

  private markCompleted(): void {
    this.completedAt = Date.now();
    this.completedDurationMs = this.startedMonotonic === undefined ? 0 : Math.max(0, performance.now() - this.startedMonotonic);
  }

  private releaseExecution(): void {
    const cleanup = this.executionCleanup;
    this.executionCleanup = undefined;
    try { cleanup?.(); } catch (error) { this.error = `Sandbox cleanup failed: ${String(error)}`; }
  }

  /**
   * 硬超时处理：SIGTERM -> gracePeriod -> SIGKILL
   */
  private handleHardTimeout(): void {
    if (this.status !== "running") return;

    this.status = "timed_out";
    this.error = `进程超过硬超时限制 (${this.timingPolicy.hardTimeoutMs}ms)`;

    this.terminate("SIGTERM");

    // 宽限期后如果仍未退出，执行 SIGKILL
    this.graceTimer = setTimeout(() => {
      this.terminate("SIGKILL");
    }, this.timingPolicy.killGraceMs);
  }

  /**
   * 主动终止进程 (如 Agent 调用 job_kill 或 Run Cancelled)
   */
  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.status !== "running") {
      if (this.startedAt && !this.completedAt) await this.termination;
      return;
    }

    this.status = "cancelled";
    this.error = "进程已被主动取消";
    this.terminate(signal);

    this.graceTimer = setTimeout(() => {
      this.terminate("SIGKILL");
    }, this.timingPolicy.killGraceMs);
    await this.termination;
  }

  private terminate(signal: NodeJS.Signals): void {
    if (!this.childProcess || this.completedAt !== undefined) return;
    if (this.pid) {
      if (this.executionTerminator) this.executionTerminator(this.pid, signal);
      else this.treeTerminator.terminate(this.pid, signal);
    } else {
      try {
        this.childProcess.kill(signal);
      } catch {
        // 忽略可能已经退出的异常
      }
    }
  }

  private clearTimers(): void {
    if (this.hardTimeoutTimer) {
      clearTimeout(this.hardTimeoutTimer);
      this.hardTimeoutTimer = undefined;
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
  }

  /**
   * 等待进程完成或指定超时时间到达（若超时仅返回当前状态，绝不 kill 进程）
   */
  async waitFor(timeoutMs?: number): Promise<JobRecord> {
    if (this.status !== "running" && this.completedAt !== undefined) {
      return this.getRecord();
    }

    const waitLimit = timeoutMs ?? this.timingPolicy.waitTimeoutMs;

    return new Promise<JobRecord>((resolve) => {
      let resolved = false;
      let timer: NodeJS.Timeout | undefined;

      const onDone = (rec: JobRecord) => {
        if (!resolved) {
          resolved = true;
          if (timer) clearTimeout(timer);
          resolve(rec);
        }
      };

      this.completionListeners.push(onDone);

      if (waitLimit && waitLimit > 0) {
        timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            // 移除当前回调
            const idx = this.completionListeners.indexOf(onDone);
            if (idx >= 0) {
              this.completionListeners.splice(idx, 1);
            }
            // 返回当前 running 状态快照，绝不杀掉进程！
            resolve(this.getRecord());
          }
        }, waitLimit);
      }
    });
  }

  /**
   * 注册进程完成事件回调
   */
  onComplete(listener: (record: JobRecord) => void): () => void {
    if (this.status !== "running" && this.completedAt !== undefined) {
      listener(this.getRecord());
      return () => {};
    }

    this.completionListeners.push(listener);
    return () => {
      const idx = this.completionListeners.indexOf(listener);
      if (idx >= 0) {
        this.completionListeners.splice(idx, 1);
      }
    };
  }

  private notifyCompletion(): void {
    this.resolveTermination();
    const record = this.getRecord();
    const listeners = [...this.completionListeners];
    this.completionListeners.length = 0;
    for (const listener of listeners) {
      try {
        listener(record);
      } catch {
        // 忽略监听器内部异常
      }
    }
  }
}
