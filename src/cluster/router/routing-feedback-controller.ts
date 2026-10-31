/**
 * Routing Feedback Controller
 * 负责消费 TaskSupervisor 事件与 Worker 反馈，驱动受控重新规划 (Controlled Replanning)
 * 并实施 Outcome Unknown 副作用防御与 Replan 预算控制
 */

import * as crypto from "node:crypto";
import { defaultTraceContext } from "../../observability/trace-context.js";
import type { IClusterStore, ClusterTaskRecord } from "../storage/cluster-store.js";
import type { TaskScheduler } from "../coordinator/task-scheduler.js";
import type {
  ReplanTriggerType,
  ReplanEvaluation,
  RoutingReplanRecord,
  RoutingDecision,
} from "./types.js";

export interface FeedbackControllerOptions {
  store: IClusterStore;
  scheduler: TaskScheduler;
  maxReplansPerTask?: number;
  replanCooldownMs?: number;
}

export class RoutingFeedbackController {
  private readonly maxReplans: number;
  private readonly cooldownMs: number;
  // 记录每个 Task 的 Replan 尝试次数与上次时间戳
  private readonly taskReplanBudget = new Map<string, { count: number; lastTime: number }>();

  constructor(
    private readonly store: IClusterStore,
    private readonly scheduler: TaskScheduler,
    options?: FeedbackControllerOptions
  ) {
    this.maxReplans = options?.maxReplansPerTask ?? 2;
    this.cooldownMs = options?.replanCooldownMs ?? 5000;
  }

  /**
   * 评估是否应当触发重新规划
   */
  async evaluateIntervention(
    task: ClusterTaskRecord,
    trigger: ReplanTriggerType,
    details: string,
    context?: {
      hasSideEffects?: boolean;
      workerEvents?: Array<{ eventType: string; data?: any; payload?: any }>;
    }
  ): Promise<ReplanEvaluation> {
    const budget = this.taskReplanBudget.get(task.taskId) ?? { count: 0, lastTime: 0 };
    const now = Date.now();

    // 1. 检查 Replan 预算上限
    if (budget.count >= this.maxReplans) {
      return {
        shouldReplan: false,
        trigger,
        reason: `已达到任务最大重新规划预算 (${budget.count}/${this.maxReplans})，停止自动重试`,
        requiresUserConfirmation: true,
        originalRunReconciled: true,
        hasSideEffectsOccurred: context?.hasSideEffects ?? false,
        outcomeUnknown: false,
      };
    }

    // 2. 检查冷却时间
    if (now - budget.lastTime < this.cooldownMs) {
      return {
        shouldReplan: false,
        trigger,
        reason: `重新规划处于冷却期中 (间隔需大于 ${this.cooldownMs}ms)`,
        requiresUserConfirmation: false,
        originalRunReconciled: false,
        hasSideEffectsOccurred: context?.hasSideEffects ?? false,
        outcomeUnknown: false,
      };
    }

    // 3. 检查是否有未确认副作用 (Outcome Unknown 防线)
    // 如果任务已经在运行态产生文件修改工具调用 (edit_file / write_file / bash 写操作)，且 Worker 异常失联
    let sideEffectsDetected = context?.hasSideEffects ?? false;
    const hasSideEffect = (event: { eventType: string; data?: any; payload?: any }): boolean => {
      const data = event.data ?? event.payload;
      return event.eventType === "file.modified" ||
        (["tool.started", "tool.result", "tool.call_start", "tool.call_end"].includes(event.eventType) &&
          (["write", "process"].includes(data?.executionKind) || ["write_file", "edit_file", "bash"].includes(data?.toolName ?? data?.["tool.name"] ?? data?.name ?? "")));
    };
    if (!sideEffectsDetected && context?.workerEvents) sideEffectsDetected = context.workerEvents.some(hasSideEffect);
    if (!sideEffectsDetected && !context?.workerEvents && trigger === "NODE_OFFLINE") {
      let cursor = 0;
      while (true) {
        const batch = await this.store.getEventsForTask(task.taskId, cursor, 1000);
        if (batch.some(hasSideEffect)) { sideEffectsDetected = true; break; }
        if (batch.length < 1000) break;
        cursor = batch.at(-1)!.seq + 1;
      }
    }

    sideEffectsDetected ||= task.status === "outcome_unknown";
    if (sideEffectsDetected && trigger === "NODE_OFFLINE") {
      // 存在写副作用且节点失联，坚决拒绝盲目重新派发！
      return {
        shouldReplan: false,
        trigger,
        reason: `任务可能已在节点产生写副作用，且 Worker 掉线未能确认状态。严格收敛为 Outcome Unknown，杜绝跨节点双写冲突。`,
        requiresUserConfirmation: true,
        originalRunReconciled: false,
        hasSideEffectsOccurred: true,
        outcomeUnknown: true,
      };
    }

    // 4. 根据 Trigger 类型决定策略
    switch (trigger) {
      case "AUTHENTICATION_REQUIRED":
        return {
          shouldReplan: false,
          trigger,
          reason: "目标服务需要认证，应提示用户完成认证而非盲目换节点",
          requiresUserConfirmation: true,
          originalRunReconciled: true,
          hasSideEffectsOccurred: false,
          outcomeUnknown: false,
        };

      case "NODE_OFFLINE":
      case "PROJECT_UNAVAILABLE":
      case "CAPABILITY_UNAVAILABLE":
      case "EXECUTION_BLOCKED":
      case "REPEATED_FAILURE":
      case "USER_GOAL_CHANGED":
      case "WORKER_REQUESTS_HELP":
        return {
          shouldReplan: true,
          trigger,
          reason: `满足重新规划条件 (${trigger}): ${details}`,
          requiresUserConfirmation: false,
          originalRunReconciled: true,
          hasSideEffectsOccurred: sideEffectsDetected,
          outcomeUnknown: false,
        };

      default:
        return {
          shouldReplan: false,
          trigger,
          reason: `普通局部问题 (${trigger})，应由 Worker 内部处理，不触发全局 Replan`,
          requiresUserConfirmation: false,
          originalRunReconciled: false,
          hasSideEffectsOccurred: false,
          outcomeUnknown: false,
        };
    }
  }

  /**
   * 执行原任务安全收敛并记录 Replan
   */
  async recordAndReconcileReplan(
    task: ClusterTaskRecord,
    trigger: ReplanTriggerType,
    details: string,
    evaluation: ReplanEvaluation
  ): Promise<RoutingReplanRecord> {
    const replanId = `replan-${crypto.randomUUID().slice(0, 10)}`;
    const now = Date.now();

    // 更新预算
    const budget = this.taskReplanBudget.get(task.taskId) ?? { count: 0, lastTime: 0 };
    budget.count += 1;
    budget.lastTime = now;
    this.taskReplanBudget.set(task.taskId, budget);

    // 1. 若为 Outcome Unknown，持久化标记任务状态
    if (evaluation.outcomeUnknown) {
      const trace = defaultTraceContext.get();
      if (trace?.goalRunId && trace.goalTurnFence) {
        if (!this.store.executeGoalTaskControl) throw new Error("Fenced task control is unavailable");
        await this.store.executeGoalTaskControl(trace.goalRunId, trace.goalTurnFence, task.taskId, "outcome_unknown", evaluation.reason);
      } else await this.store.updateTaskStatus(task.taskId, "outcome_unknown", { error: evaluation.reason });
    }

    // 2. 尝试向原任务下发取消以确保停止旧 Run
    if (evaluation.shouldReplan) {
      await this.scheduler.sendControl(task.taskId, "cancel", {
        reason: `Task cancelled due to Coordinator replanning: ${details}`,
      });
    }

    const record: RoutingReplanRecord = {
      replanId,
      routeId: task.taskId,
      taskId: task.taskId,
      originalRunId: `run-orig-${task.taskId}`,
      trigger,
      triggerDetails: details,
      originalCandidate: {
        nodeId: task.nodeId,
        projectId: task.projectId,
      },
      status: evaluation.outcomeUnknown
        ? "outcome_unknown"
        : evaluation.shouldReplan
        ? "proposed"
        : "blocked",
      outcomeUnknownReason: evaluation.outcomeUnknown ? evaluation.reason : undefined,
      createdAt: now,
      updatedAt: now,
    };

    // 持久化记录 Replan
    await this.store.recordRouteReplan?.(record);
    return record;
  }
}
