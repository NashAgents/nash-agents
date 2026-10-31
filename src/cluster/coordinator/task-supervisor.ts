import crypto from "node:crypto";
import type { IClusterStore } from "../storage/cluster-store.js";
import type { NodeRegistry } from "./node-registry.js";
import type { EventBus } from "../../observability/event-bus.js";

import type { TaskScheduler } from "./task-scheduler.js";

/**
 * 任务一旦进入这些状态，就说明 Worker 已经真正接手执行。
 * 执行期的时间预算由 Worker 自身 AgentLoop（maxRunMs / maxSteps / maxToolCalls）
 * 与单次工具/模型超时共同约束，A2A 层不得再叠加第二个墙钟把它杀掉。
 */
const WORKER_OWNED_STATUSES = new Set(["accepted", "running", "interrupting"]);

/**
 * 等待人工审批不计入任何执行预算，也不受派发死线管辖。
 */
const APPROVAL_WAITING_STATUS = "waiting_approval";

/**
 * 唯一允许被 Supervisor 回收的状态：已派发但从未被 Worker 接受。
 * 必须用正向白名单判定，任何其它状态（含 outcome_unknown 与全部终态）
 * 都不能进入 cancel 控制命令路径，否则会与 Worker 端权威结果互相覆盖。
 */
const RECLAIMABLE_STATUSES = new Set(["dispatched"]);

/**
 * 已收敛/未知/终态：显式跳过，不参与任何回收判断。
 * outcome_unknown 表示结果不可确认，只能人工对账，绝不能自动重投控制命令。
 */
const SETTLED_STATUSES = new Set([
  "outcome_unknown",
  "completed",
  "failed",
  "cancelled",
  "cancelling",
  APPROVAL_WAITING_STATUS,
  "interrupted",
]);

/**
 * 默认的「未开工」派发死线：任务创建后迟迟没有被 Worker 接受才回收，
 * 与 Agent 执行时长无关。
 */
const DEFAULT_DISPATCH_TIMEOUT_MS = 180_000;

/**
 * 单个未开工任务的取消投递上限；超过后停止重投并收敛为可审计的 outcome_unknown。
 */
const MAX_RECLAIM_ATTEMPTS = 3;

/**
 * 单轮过期审批扫描的上限：有界，避免一次性拉爆历史表。
 * 未在单轮内处理的记录会在下一个监控周期继续收敛。
 */
const APPROVAL_SWEEP_HISTORY_LIMIT = 1000;

/** Coordinator 侧审批超时的裁决来源与错误文案前缀。 */
const APPROVAL_TIMEOUT_RESOLVER = "approval-timeout";

export class TaskSupervisor {
  private supervising = false;
  private timer?: NodeJS.Timeout;
  /** 仅内存的重投计数，避免污染持久化 schema；进程重启后重新计次是安全的。 */
  private readonly reclaimAttempts = new Map<string, number>();

  constructor(
    private readonly store: IClusterStore,
    private readonly registry: NodeRegistry,
    /**
     * 仅用于回收「已派发但从未被 Worker 接受」的任务。
     * 历史上这里是 Agent 全局墙钟（1800000ms），会把仍在工作的 Agent 杀掉。
     */
    private readonly dispatchTimeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS,
    private readonly scheduler?: TaskScheduler,
    /** 复用既有事件总线，让过期审批与任务终态能推送到 SSE/UI。 */
    private readonly eventBus?: EventBus
  ) {}

  start(intervalMs = 15000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.supervising) return;
      this.supervising = true;
      this.superviseTasks().catch((err) => {
        console.error(`[TaskSupervisor] Error in supervise pass:`, err);
      }).finally(() => { this.supervising = false; });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async superviseTasks(): Promise<void> {
    const now = Date.now();

    // 0. 审批过期是权威事实：先收敛过期审批与其任务，再基于最新状态做回收判断。
    await this.sweepExpiredApprovals(now);

    const tasks = await this.store.listTasks({ limit: 100000 });

    const stillReclaimable = new Set<string>();

    for (const task of tasks) {
      const conn = this.registry.getConnection(task.nodeId);

      // 0. 等待审批中的任务若 Worker 连接已消失，结论不可确认：
      //    绝不能让 waiting_approval 被 SETTLED 白名单永久跳过。
      if (task.status === APPROVAL_WAITING_STATUS && !conn) {
        await this.store.updateTaskStatus(task.taskId, "outcome_unknown", {
          error: `Worker ${task.nodeId} disconnected while awaiting approval. Approval and execution outcomes are unknown; awaiting reconnect or manual reconciliation.`,
        });
        this.emitEvent("task.outcome_unknown", {
          taskId: task.taskId, runId: task.runId, nodeId: task.nodeId,
          error: "Worker disconnected while awaiting approval",
        });
        continue;
      }

      // 1. 已收敛/未知/终态一律跳过：绝不对这些状态发起 cancel 控制命令。
      if (SETTLED_STATUSES.has(task.status)) continue;

      // 2. Worker 连接丢失：结果无法确认，只能收敛为 outcome_unknown，绝不自动重派。
      if (!conn) {
        if (["dispatched", "accepted", "running", "interrupting"].includes(task.status)) {
          await this.store.updateTaskStatus(task.taskId, "outcome_unknown", {
            error: `Worker ${task.nodeId} disconnected during execution. Outcome is unknown; awaiting manual check or reconnect.`,
          });
        }
        continue;
      }

      // 3. Worker 已接手：执行时长的唯一裁决者是 Worker 自身的执行预算。
      //    A2A 外层不再设置固定墙钟，避免排队/派发/沙箱初始化耗时把仍在工作的 Agent 杀掉。
      //    注意：等待审批本身依然不消耗任何执行预算——它只受审批自身的 expiresAt 约束。
      if (WORKER_OWNED_STATUSES.has(task.status)) continue;

      // 4. 仅回收「已派发但始终没有开工」的任务（正向白名单判定）。
      if (!RECLAIMABLE_STATUSES.has(task.status)) continue;

      const neverStartedForMs = now - task.createdAt;
      const attempts = this.reclaimAttempts.get(task.taskId) ?? 0;
      // 指数退避：第 n 次投递从派发死线起按 1x / 2x / 4x 的节奏进行。
      const requiredElapsedMs = this.dispatchTimeoutMs * 2 ** attempts;
      if (neverStartedForMs <= requiredElapsedMs) {
        stillReclaimable.add(task.taskId);
        continue;
      }

      const result = await this.scheduler?.sendControl(task.taskId, "cancel", {
        reason: "Task was never accepted by the worker within the dispatch deadline",
      });

      if (result?.success) {
        this.reclaimAttempts.delete(task.taskId);
        await this.store.updateTaskStatus(task.taskId, "cancelling", {
          error: `Task was not accepted by worker ${task.nodeId} within ${Math.floor(this.dispatchTimeoutMs / 1000)}s of dispatch (waited ${Math.floor(neverStartedForMs / 1000)}s).`,
        });
        continue;
      }

      const nextAttempts = attempts + 1;
      if (nextAttempts >= MAX_RECLAIM_ATTEMPTS) {
        // 达到重投上限：停止投递，保留可审计的终态说明，交由人工对账。
        this.reclaimAttempts.delete(task.taskId);
        await this.store.updateTaskStatus(task.taskId, "outcome_unknown", {
          error: `Task was not accepted by worker ${task.nodeId} within ${Math.floor(this.dispatchTimeoutMs / 1000)}s of dispatch; cancelled ${nextAttempts} time(s) without worker acknowledgement. Automatic reclaim stopped after ${MAX_RECLAIM_ATTEMPTS} attempts (waited ${Math.floor(neverStartedForMs / 1000)}s). Outcome must be reconciled with the worker ledger.`,
        });
        continue;
      }

      this.reclaimAttempts.set(task.taskId, nextAttempts);
      stillReclaimable.add(task.taskId);
    }

    // 清理已离开 dispatched 状态的计数，防止内存无限增长。
    for (const taskId of [...this.reclaimAttempts.keys()]) {
      if (!stillReclaimable.has(taskId)) this.reclaimAttempts.delete(taskId);
    }
  }

  /**
   * 有界过期审批扫描（复用既有监控周期，不新增常驻定时器）。
   *
   * 过期即权威结论：把仍为 pending 的审批收敛为 deny，并把对应任务移出 waiting_approval，
   * 否则任务图会因为「审批记录从 UI 消失、任务却永远 waiting_approval」而无法收敛。
   */
  private async sweepExpiredApprovals(now: number): Promise<void> {
    if (!this.store.listApprovalHistory) return;
    const history = await this.store.listApprovalHistory(APPROVAL_SWEEP_HISTORY_LIMIT);
    // InMemory 会把「pending 且已过期」的项目映射为 expired；Postgres 返回原始 pending。
    const expired = history.filter((approval) =>
      (approval.status === "pending" || approval.status === "expired") && approval.expiresAt <= now,
    );
    if (expired.length === 0) return;

    for (const approval of expired) {
      try {
        await this.store.resolveApproval(approval.approvalId, "deny", APPROVAL_TIMEOUT_RESOLVER);
      } catch (err) {
        console.error(`[TaskSupervisor] Failed to expire approval ${approval.approvalId}:`, err);
        continue;
      }

      const task = await this.store.getTask(approval.taskId);
      if (task?.status === APPROVAL_WAITING_STATUS) {
        const conn = this.registry.getConnection(task.nodeId);
        if (!conn) {
          // Worker 都不在了：无法确认审批后的执行状态，收敛为 outcome_unknown。
          await this.store.updateTaskStatus(task.taskId, "outcome_unknown", {
            error: `Approval ${approval.approvalId} expired without a decision while worker ${task.nodeId} was disconnected. Approval and execution outcomes are unknown; awaiting reconnect or manual reconciliation.`,
          });
          this.emitEvent("task.outcome_unknown", {
            taskId: task.taskId, runId: task.runId, nodeId: task.nodeId,
            error: "Approval expired while worker was disconnected",
          });
        } else {
          const error = `Approval ${approval.approvalId} expired at ${new Date(approval.expiresAt).toISOString()} without a human decision; operation denied and task failed (${APPROVAL_TIMEOUT_RESOLVER}).`;
          await this.store.updateTaskStatus(task.taskId, "failed", { error });
          this.emitEvent("task.failed", {
            taskId: task.taskId, runId: task.runId, nodeId: task.nodeId, error,
          });
        }
      }

      this.emitEvent("approval.resolved", {
        approvalId: approval.approvalId,
        taskId: approval.taskId,
        runId: approval.runId,
        decision: "deny",
        resolvedBy: APPROVAL_TIMEOUT_RESOLVER,
        expired: true,
      });
    }
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    this.eventBus?.emit({
      id: crypto.randomUUID(),
      type: type as never,
      timestamp: new Date().toISOString(),
      projectId: "coordinator",
      sessionId: "main-coordinator",
      data,
    });
  }
}
