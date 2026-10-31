import { createHash, randomUUID } from "node:crypto";
import type { IClusterStore, ScheduledTaskRecord, ScheduledTaskRunRecord, ScheduledTaskRunStatus } from "../storage/cluster-store.js";
import type { TaskScheduler } from "../coordinator/task-scheduler.js";
import type { DistributedGraphOrchestrator } from "../graph/graph-orchestrator.js";
import type { EventBus } from "../../observability/event-bus.js";
import { computeNextCronTime, computeNextIntervalTime } from "./cron-parser.js";

export class ScheduleExecutionError extends Error {
  constructor(message: string) { super(message); this.name = "ScheduleExecutionError"; }
}
export interface ScheduleTriggerEngineOptions {
  store: IClusterStore;
  scheduler: TaskScheduler;
  coordinatorNodeId: string;
  orchestrator?: DistributedGraphOrchestrator;
  eventBus?: EventBus;
  misfireThresholdMs?: number;
}

/** Durable admission precedes dispatch. An uncertain dispatch is never automatically repeated. */
export class ScheduleTriggerEngine {
  private readonly store: IClusterStore;
  private readonly scheduler: TaskScheduler;
  private readonly coordinatorNodeId: string;
  private readonly orchestrator?: DistributedGraphOrchestrator;
  private readonly eventBus?: EventBus;
  private readonly misfireThresholdMs: number;
  private activeTimer?: NodeJS.Timeout;
  private isRunning = false;
  private processing?: Promise<void>;
  private rescanRequested = false;
  private recovering = true;
  private readonly eventUnsubscribers: Array<() => void> = [];

  constructor(options: ScheduleTriggerEngineOptions) {
    this.store = options.store;
    this.scheduler = options.scheduler;
    this.coordinatorNodeId = options.coordinatorNodeId;
    this.orchestrator = options.orchestrator;
    this.eventBus = options.eventBus;
    this.misfireThresholdMs = options.misfireThresholdMs ?? 60000;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    if (!this.store.claimScheduledTaskRun || !this.store.listScheduledTasksForExecution || !this.store.listUnsettledScheduledRuns) throw new ScheduleExecutionError("Durable schedule store is unavailable");
    this.isRunning = true;
    this.recovering = true;
    if (this.eventBus) {
      this.eventUnsubscribers.push(this.eventBus.subscribe("*", event => {
        const data = event.data as { taskId?: string; graphId?: string; resultSummary?: string; finalAnswer?: string; partialResult?: string; error?: string; reason?: string };
        if (["task.completed", "task.failed", "task.cancelled", "task.outcome_unknown"].includes(event.type)) {
          void this.handleTaskTerminal(data?.taskId, event.type === "task.completed" ? "completed" : event.type === "task.outcome_unknown" ? "outcome_unknown" : "failed", data?.finalAnswer ?? data?.resultSummary ?? data?.partialResult, data?.error ?? data?.reason)
            .catch(() => console.warn("[ScheduleTriggerEngine] Terminal update deferred to reconciliation"));
        } else if (["graph.completed", "graph.failed", "graph.cancelled", "graph.partially_completed", "graph.outcome_unknown"].includes(event.type)) {
          void this.reschedule().catch(() => console.warn("[ScheduleTriggerEngine] Graph update deferred to reconciliation"));
        }
      }));
    }
    await this.processDueTasks();
  }

  stop(): void {
    this.isRunning = false;
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.activeTimer = undefined;
    for (const unsub of this.eventUnsubscribers.splice(0)) unsub();
  }

  async reschedule(): Promise<void> {
    if (!this.isRunning) return;
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.activeTimer = undefined;
    if (this.processing) { this.rescanRequested = true; return; }
    await this.processDueTasks();
  }

  static calculateNextRunTime(task: Pick<ScheduledTaskRecord, "triggerType" | "cronExpression" | "intervalMs" | "runAt" | "timezone">, fromTimeMs = Date.now()): number | undefined {
    if (task.triggerType === "cron") return task.cronExpression ? computeNextCronTime(task.cronExpression, fromTimeMs, task.timezone ?? "UTC") : undefined;
    if (task.triggerType === "interval") return task.intervalMs ? computeNextIntervalTime(task.intervalMs, fromTimeMs) : undefined;
    if (task.triggerType === "once") return task.runAt && task.runAt > fromTimeMs ? task.runAt : undefined;
    throw new ScheduleExecutionError("Unsupported schedule trigger type");
  }

  async runNow(scheduleId: string, force = false): Promise<ScheduledTaskRunRecord> {
    const task = await this.store.getScheduledTask?.(scheduleId);
    if (!task) throw new ScheduleExecutionError(`Scheduled task '${scheduleId}' not found`);
    return this.executeTrigger(task, Date.now(), true, force);
  }

  private async processDueTasks(): Promise<void> {
    if (!this.isRunning || this.processing) return;
    let wakeup = Date.now() + 30000;
    this.processing = (async () => {
      await this.reconcileRuns();
      this.recovering = false;
      let cursor = "";
      while (this.isRunning) {
        const batch = await this.store.listScheduledTasksForExecution!(cursor, 100);
        if (!batch.length) break;
        for (const task of batch) {
          if (!this.isRunning) break;
          try {
            const now = Date.now();
            if (!task.nextRunAt) {
              task.nextRunAt = ScheduleTriggerEngine.calculateNextRunTime(task, now);
              await this.store.updateScheduledTask?.(task.id, { nextRunAt: task.nextRunAt });
            }
            if (task.nextRunAt && task.nextRunAt <= now) await this.handleDueTask(task, now);
            const latest = await this.store.getScheduledTask?.(task.id);
            if (latest?.enabled && latest.nextRunAt) wakeup = Math.min(wakeup, latest.nextRunAt);
          } catch {
            // A malformed plan or transient database error cannot permanently stop all scheduling.
            console.warn(`[ScheduleTriggerEngine] Plan ${task.id} could not advance`);
          }
        }
        cursor = batch[batch.length - 1].id;
      }
    })();
    try { await this.processing; }
    finally {
      this.processing = undefined;
      if (this.isRunning) {
        const delay = this.rescanRequested ? 100 : Math.max(100, Math.min(wakeup - Date.now(), 30000));
        this.rescanRequested = false;
        this.activeTimer = setTimeout(() => {
          this.activeTimer = undefined;
          void this.processDueTasks().catch(() => console.warn("[ScheduleTriggerEngine] Reconciliation will retry"));
        }, delay);
        this.activeTimer.unref();
      }
    }
  }

  private async handleDueTask(task: ScheduledTaskRecord, now: number): Promise<void> {
    let scheduledTime = task.nextRunAt ?? now;
    const misfired = now - scheduledTime > this.misfireThresholdMs;
    if (misfired && task.misfirePolicy === "SKIP_MISFIRE") {
      await this.recordSkippedRun(task, scheduledTime, "misfire_skip");
      await this.store.updateScheduledTask?.(task.id, { nextRunAt: ScheduleTriggerEngine.calculateNextRunTime(task, now), ...(task.triggerType === "once" ? { enabled: false } : {}) });
      return;
    }
    // Catch-up is bounded per pass and advances from the missed time; remaining misses stay durable.
    const maxRuns = misfired && task.misfirePolicy === "CATCH_UP" ? 5 : 1;
    for (let i = 0; i < maxRuns && scheduledTime <= now; i++) {
      const run = await this.executeTrigger(task, scheduledTime);
      const next = ScheduleTriggerEngine.calculateNextRunTime(task, task.misfirePolicy === "CATCH_UP" ? scheduledTime : now);
      await this.store.updateScheduledTask?.(task.id, { nextRunAt: next, lastRunAt: now, lastRunStatus: run.status, runCount: (task.runCount || 0) + i + 1, ...(task.triggerType === "once" ? { enabled: false } : {}) });
      if (next === undefined) break;
      scheduledTime = next;
    }
  }

  private async executeTrigger(task: ScheduledTaskRecord, scheduledTime: number, isManual = false, force = false, queued?: ScheduledTaskRunRecord): Promise<ScheduledTaskRunRecord> {
    if (!this.store.claimScheduledTaskRun) throw new ScheduleExecutionError("Atomic schedule admission is unavailable");
    const now = Date.now();
    const id = isManual ? `srun-${randomUUID()}` : `srun-${createHash("sha256").update(`${task.id}:${scheduledTime}`).digest("hex").slice(0, 48)}`;
    const admission = await this.store.claimScheduledTaskRun(queued ?? {
      id, scheduledTaskId: task.id, targetType: task.targetType, triggerTime: scheduledTime,
      startedAt: now, status: "running", createdAt: now, metrics: { isManual },
    }, force);
    const run = admission.run;
    if (!admission.admitted) return run;
    try {
      if (task.targetType === "single_task") {
        const config = task.taskConfig ?? { goal: task.name };
        const created = await this.scheduler.createTask({ ...config, goal: config.goal || task.name,
          nodeId: config.nodeId || this.coordinatorNodeId, projectId: config.projectId || "default",
          beforeDispatch: async createdTask => {
            run.taskId = createdTask.taskId;
            await this.store.updateScheduledTaskRun?.(run.id, { taskId: run.taskId });
          },
        });
        run.taskId = created.taskId;
        await this.store.updateScheduledTaskRun?.(run.id, { taskId: run.taskId });
      } else if (task.targetType === "graph") {
        if (!this.orchestrator) throw new ScheduleExecutionError("DistributedGraphOrchestrator is unavailable");
        const graph = await this.orchestrator.createGraph({ parentGoal: task.graphConfig?.parentGoal || task.name,
          reasoning: `Scheduled execution for ${task.name}`, requiresMultiAgent: true, nodes: task.graphConfig?.nodes ?? [] });
        run.graphId = graph.graphId;
        await this.store.updateScheduledTaskRun?.(run.id, { graphId: graph.graphId });
        await this.orchestrator.startGraph(graph.graphId);
      } else throw new ScheduleExecutionError("Unsupported scheduled target");
    } catch (error) {
      // Once an execution identity exists, a transport failure cannot prove that no side effect happened.
      run.status = run.taskId || run.graphId ? "outcome_unknown" : "failed";
      run.error = error instanceof Error ? error.message : String(error);
      if (run.status === "failed") run.completedAt = Date.now();
      await this.store.updateScheduledTaskRun?.(run.id, run);
    }
    return run;
  }

  private async recordSkippedRun(task: ScheduledTaskRecord, triggerTime: number, reason: string): Promise<void> {
    const now = Date.now();
    await this.store.saveScheduledTaskRun?.({ id: `srun-skip-${createHash("sha256").update(`${task.id}:${triggerTime}`).digest("hex").slice(0,48)}`,
      scheduledTaskId: task.id, targetType: task.targetType, triggerTime, startedAt: now, completedAt: now,
      status: "skipped", skipReason: reason, createdAt: now });
  }

  private async handleTaskTerminal(taskId: string | undefined, status: ScheduledTaskRunStatus, summary?: string, error?: string): Promise<void> {
    if (!taskId) return;
    const run = await this.store.getScheduledRunByExecution?.(taskId);
    if (!run) return;
    await this.settleRun(run, status, summary, error);
    if (this.isRunning) await this.reschedule();
  }

  private async settleRun(run: ScheduledTaskRunRecord, status: ScheduledTaskRunStatus, summary?: string, error?: string): Promise<void> {
    await this.store.updateScheduledTaskRun?.(run.id, { status, completedAt: ["completed", "failed"].includes(status) ? Date.now() : undefined, ...(summary !== undefined ? { resultSummary: summary } : {}), ...(error !== undefined ? { error } : {}) });
    await this.store.updateScheduledTask?.(run.scheduledTaskId, { lastRunStatus: status });
  }

  private async reconcileRuns(): Promise<void> {
    let cursor = "";
    const queued: ScheduledTaskRunRecord[] = [];
    while (this.isRunning) {
      const batch = await this.store.listUnsettledScheduledRuns!(cursor, 100);
      if (!batch.length) break;
      for (const run of batch) {
        if (run.status === "queued") { queued.push(run); continue; }
        const execution = run.taskId ? await this.store.getTask(run.taskId) : run.graphId ? await this.store.getGraph?.(run.graphId) : undefined;
        if (execution && ["completed", "failed", "cancelled", "partially_completed"].includes(execution.status)) {
          await this.settleRun(run, execution.status === "completed" ? "completed" : "failed", "taskId" in execution ? execution.finalAnswer ?? execution.resultSummary : execution.finalSummary, execution.error);
        } else if (execution?.status === "outcome_unknown") {
          await this.settleRun(run, "outcome_unknown", undefined, "Execution outcome requires reconciliation");
        } else if (this.recovering && !run.taskId && !run.graphId) {
          await this.settleRun(run, "outcome_unknown", undefined, "Dispatch interrupted before execution identity was linked; manual reconciliation required");
        }
        // A running record without an execution ID remains blocking: never guess it is safe to redispatch.
      }
      cursor = batch[batch.length - 1].id;
    }
    for (const run of queued.sort((a,b) => a.triggerTime - b.triggerTime || a.id.localeCompare(b.id))) {
      const task = await this.store.getScheduledTask?.(run.scheduledTaskId);
      if (this.isRunning && task?.enabled) await this.executeTrigger(task, run.triggerTime, Boolean(run.metrics?.isManual), false, run);
    }
  }
}
