import type { CreateTaskInput } from "../task/types.js";

/**
 * Plan Mode 状态
 */
export type PlanModeState =
  | "inactive"
  | "exploring"
  | "awaiting_approval"
  | "proposed"
  | "approved"
  | "rejected"
  | "executed";

export interface PlanApprovalResult {
  approved: boolean;
  revisionFeedback?: string;
  cancelled?: boolean;
}

/**
 * 方案中的单个规划步骤
 */
export interface PlanStep {
  id?: string;
  subject: string;
  description?: string;
  dependencies?: string[];
  writeScopes?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * 结构化方案提案
 */
export interface ProposedPlan {
  planId: string;
  goal: string;
  summary: string;
  steps: PlanStep[];
  assumptions?: string[];
  risks?: string[];
  createdAt: number;
}

/**
 * 用户审批决策
 */
export interface PlanApprovalDecision {
  approved: boolean;
  feedback?: string;
  approvedAt: number;
}

/**
 * 重规划判定类型
 */
export type ReplanType = "minor_adjustment" | "material_deviation";

/**
 * 重规划请求与评估
 */
export interface ReplanEvaluation {
  type: ReplanType;
  reason: string;
  impactedTasks: string[];
  proposedChanges?: CreateTaskInput[];
  requiresUserApproval: boolean;
}
