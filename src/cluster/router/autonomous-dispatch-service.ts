/**
 * Autonomous Dispatch Service
 * 负责将通过 RoutingValidator 校验的决策安全接入 Phase 1 TaskScheduler
 * 并建立 Task ID ↔ Route ID ↔ Run ID 全链路持久化审计
 */

import type { TaskScheduler } from "../coordinator/task-scheduler.js";
import type { IClusterStore, ClusterTaskRecord } from "../storage/cluster-store.js";
import type { RoutingDecision, RoutingValidationResult } from "./types.js";

export interface AutonomousDispatchResult {
  success: boolean;
  taskId?: string;
  runId?: string;
  decisionId: string;
  nodeId: string;
  projectId: string;
  status: string;
  error?: string;
}

export class AutonomousDispatchService {
  constructor(
    private readonly scheduler: TaskScheduler,
    private readonly store: IClusterStore
  ) {}

  /**
   * 执行自主安全派发
   */
  async dispatch(
    decision: RoutingDecision,
    validationResult: RoutingValidationResult,
    options?: {
      timeoutMs?: number;
      maxSteps?: number;
    }
  ): Promise<AutonomousDispatchResult> {
    if (!validationResult.valid || decision.decisionType !== "DISPATCH" || !decision.selectedCandidate) {
      return {
        success: false,
        decisionId: decision.decisionId,
        nodeId: decision.selectedCandidate?.nodeId ?? "none",
        projectId: decision.selectedCandidate?.projectId ?? "none",
        status: "rejected",
        error: validationResult.reason || `Decision type is '${decision.decisionType}', cannot dispatch.`,
      };
    }

    const candidate = decision.selectedCandidate;
    const { nodeId, projectId } = candidate;

    // 1. 调用 Phase 1 TaskScheduler 创建并持久化 Durable Task
    const taskRecord = await this.scheduler.createTask({
      nodeId,
      projectId,
      goal: decision.intent.goal,
      prompt: decision.intent.originalRequest,
      timeoutMs: options?.timeoutMs ?? decision.intent.constraints.timeoutMs,
      maxSteps: options?.maxSteps ?? decision.intent.constraints.maxSteps,
      contextOverrides: {
        readOnly: decision.intent.constraints.readOnly,
        allowSideEffects: decision.intent.constraints.allowSideEffects,
        requiredPolicy: decision.intent.constraints.requiredPolicy,
      },
    });

    // 2. 将路由决策审计与 Task ID 建立强关联
    await this.store.recordRouteDecision?.({
      routeId: decision.decisionId,
      taskId: taskRecord.taskId,
      userRequest: decision.intent.originalRequest,
      intent: decision.intent,
      decisionType: decision.decisionType,
      selectedNodeId: nodeId,
      selectedProjectId: projectId,
      reason: decision.reason,
      status: taskRecord.status,
      candidatesSnapshot: [candidate, ...decision.alternativeCandidates],
      createdAt: decision.createdAt,
      updatedAt: Date.now(),
    });

    return {
      success: true,
      taskId: taskRecord.taskId,
      decisionId: decision.decisionId,
      nodeId,
      projectId,
      status: taskRecord.status,
    };
  }
}
