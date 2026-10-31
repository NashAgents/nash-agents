import * as crypto from "node:crypto";
import type {
  PlanModeState,
  ProposedPlan,
  PlanStep,
  PlanApprovalDecision,
  PlanApprovalResult,
} from "./types.js";
import { PlanNotApprovedError, PlanRejectedError } from "./errors.js";
import type { EventBus } from "../observability/event-bus.js";
import type { FileSystemAccess } from "../sandbox/filesystem-access.js";
import type { SandboxPolicy } from "../sandbox/types.js";
import type { DecisionController } from "../decision/decision-controller.js";
import type { TaskManager } from "../task/task-manager.js";
import { TaskGraphBuilder } from "./task-graph-builder.js";

export interface PlanModeOptions {
  eventBus?: EventBus;
  projectId?: string;
  sessionId?: string;
  fsAccess?: FileSystemAccess;
  decisionController?: DecisionController;
  taskManager?: TaskManager;
}

/**
 * Plan Mode 治理控制器
 *
 * 铁律：
 * 1. Plan 模式阶段只负责探索研究和生成方案提案；
 * 2. 进入 Plan Mode 后，强制将安全策略收紧为 read-only，拦截一切写入；
 * 3. 只有在经过用户显式 approve 退出 Plan Mode 之后，才恢复写入权限并交由 TaskGraphBuilder 转为执行任务；
 * 4. propose_plan 必须真正 await Decision，成为 Human Execution Barrier。
 */
export class PlanMode {
  private state: PlanModeState = "inactive";
  private currentGoal?: string;
  private currentPlan?: ProposedPlan;
  private approvalDecision?: PlanApprovalDecision;
  private originalPolicy?: SandboxPolicy;

  private readonly eventBus?: EventBus;
  private readonly projectId: string;
  private readonly sessionId: string;
  private readonly fsAccess?: FileSystemAccess;
  private decisionController?: DecisionController;
  private taskManager?: TaskManager;

  private pendingApprovalPromiseResolve?: (result: PlanApprovalResult) => void;
  private pendingRevisionPromiseResolve?: (feedback: string) => void;

  constructor(options?: PlanModeOptions) {
    this.eventBus = options?.eventBus;
    this.projectId = options?.projectId ?? "default-project";
    this.sessionId = options?.sessionId ?? "default-session";
    this.fsAccess = options?.fsAccess;
    this.decisionController = options?.decisionController;
    this.taskManager = options?.taskManager;
  }

  setDecisionController(controller: DecisionController): void {
    this.decisionController = controller;
  }

  setTaskManager(taskManager: TaskManager): void {
    this.taskManager = taskManager;
  }

  getState(): PlanModeState {
    return this.state;
  }

  getProposedPlan(): ProposedPlan | undefined {
    return this.currentPlan ? { ...this.currentPlan } : undefined;
  }

  getApprovalDecision(): PlanApprovalDecision | undefined {
    return this.approvalDecision ? { ...this.approvalDecision } : undefined;
  }

  /**
   * 进入 Plan Mode（并将文件沙箱强制切换为物理只读模式）
   */
  enter(goal: string): void {
    this.state = "exploring";
    this.currentGoal = goal;
    this.currentPlan = undefined;
    this.approvalDecision = undefined;

    if (this.fsAccess) {
      this.originalPolicy ??= this.fsAccess.getPolicy();
      // 将策略强制收敛为 read-only 且禁用审批提权 (approval: never)，严禁在 Plan 探索期间通过提权写入
      (this.fsAccess as any).policy = {
        ...this.originalPolicy,
        filesystem: { mode: "read-only" },
        approval: { mode: "never" },
      };
    }

    this.emitEvent("plan.entered", { goal });
  }

  /**
   * 提交方案提案 (Propose Plan)
   */
  proposePlan(input: {
    summary: string;
    steps: PlanStep[];
    assumptions?: string[];
    risks?: string[];
  }): ProposedPlan {
    if (this.state !== "exploring" && this.state !== "rejected") {
      throw new Error(`当前状态 '${this.state}' 无法提交方案，必须处于 exploring 状态。`);
    }

    const plan: ProposedPlan = {
      planId: `plan-${crypto.randomUUID().slice(0, 8)}`,
      goal: this.currentGoal ?? "No explicit goal provided",
      summary: input.summary,
      steps: input.steps.map((s, idx) => ({
        id: s.id ?? `step-${idx + 1}`,
        subject: s.subject,
        description: s.description,
        dependencies: s.dependencies ? [...s.dependencies] : [],
        writeScopes: s.writeScopes ? [...s.writeScopes] : undefined,
        metadata: s.metadata ? { ...s.metadata } : undefined,
      })),
      assumptions: input.assumptions ? [...input.assumptions] : undefined,
      risks: input.risks ? [...input.risks] : undefined,
      createdAt: Date.now(),
    };

    this.currentPlan = plan;
    this.state = "proposed";

    this.emitEvent("plan.proposed", { plan });
    return { ...plan };
  }

  /**
   * 异步请求人类审批方案提案 (核心 Barrier)
   */
  async requestApproval(input: {
    summary: string;
    steps: PlanStep[];
    assumptions?: string[];
    risks?: string[];
  }): Promise<PlanApprovalResult> {
    const plan = this.proposePlan(input);

    if (this.decisionController) {
      const stepsPreview = plan.steps
        .slice(0, 3)
        .map((s, idx) => `  ${idx + 1}. ${s.subject}`)
        .join("\n");
      const moreSteps =
        plan.steps.length > 3
          ? `\n  ... 还有 ${plan.steps.length - 3} 个步骤`
          : "";

      try {
        const optionId = await this.decisionController.requestDecision({
          id: `plan-appr-${plan.planId}`,
          kind: "plan-approval",
          title: "Plan ready for approval",
          description: `Goal: ${plan.goal}\nSummary: ${plan.summary}\n${stepsPreview}${moreSteps}`,
          options: [
            { id: "approve", label: "Approve & execute", shortcut: "a" },
            { id: "revise", label: "Revise plan", shortcut: "r" },
            { id: "cancel", label: "Cancel", destructive: true, shortcut: "c" },
          ],
          defaultIndex: 0,
          metadata: { plan },
        });

        if (optionId === "approve") {
          this.resolveApproval(true);
          this.exit();
          return { approved: true };
        } else if (optionId === "revise") {
          this.state = "exploring";
          // 等待用户通过 submitRevision 提交的修改意见
          const feedback = await new Promise<string>((resolve) => {
            this.pendingRevisionPromiseResolve = resolve;
          });
          return { approved: false, revisionFeedback: feedback };
        } else {
          this.resolveApproval(false, "User cancelled");
          this.exit();
          return { approved: false, cancelled: true };
        }
      } catch (err: any) {
        this.resolveApproval(false, err?.message ?? "Decision aborted");
        this.exit();
        if (err?.name === "AbortError" || err?.name === "DecisionCancelledError") return { approved: false, cancelled: true };
        throw err;
      }
    }

    // 若未注入 decisionController（单测模式），挂起 Promise 等待外部 resolveApproval / resolveRevision
    return new Promise<PlanApprovalResult>((resolve) => {
      this.pendingApprovalPromiseResolve = resolve;
    });
  }

  /**
   * 提交修订意见（唤醒等待中的 requestApproval）
   */
  submitRevision(feedback: string): void {
    this.state = "exploring";
    if (this.pendingRevisionPromiseResolve) {
      const resolve = this.pendingRevisionPromiseResolve;
      this.pendingRevisionPromiseResolve = undefined;
      resolve(feedback);
    } else if (this.pendingApprovalPromiseResolve) {
      const resolve = this.pendingApprovalPromiseResolve;
      this.pendingApprovalPromiseResolve = undefined;
      resolve({ approved: false, revisionFeedback: feedback });
    }
  }

  /**
   * 用户审批方案 (Approve or Reject)
   */
  resolveApproval(approved: boolean, feedback?: string): PlanApprovalDecision {
    if (this.state === "approved" || this.state === "executed") {
      if (this.approvalDecision) {
        return { ...this.approvalDecision };
      }
    }

    if (this.state !== "proposed" && this.state !== "awaiting_approval") {
      throw new Error(`无法审批方案: 当前状态不是 proposed/awaiting_approval (当前为 ${this.state})。`);
    }

    const decision: PlanApprovalDecision = {
      approved,
      feedback,
      approvedAt: Date.now(),
    };

    if (approved && this.taskManager && this.currentPlan) {
      TaskGraphBuilder.buildIntoTaskManager(this.currentPlan, this.taskManager);
    }

    this.approvalDecision = decision;

    if (approved) {
      this.state = "approved";
      // 恢复原始写入策略
      if (this.fsAccess && this.originalPolicy) {
        (this.fsAccess as any).policy = { ...this.originalPolicy };
      }
      this.emitEvent("plan.approved", {
        planId: this.currentPlan?.planId,
        feedback,
        plan: this.currentPlan ? { ...this.currentPlan } : undefined,
      });
    } else {
      this.state = "rejected";
      this.emitEvent("plan.rejected", {
        planId: this.currentPlan?.planId,
        feedback,
      });
    }

    if (this.pendingApprovalPromiseResolve) {
      const resolve = this.pendingApprovalPromiseResolve;
      this.pendingApprovalPromiseResolve = undefined;
      if (approved) {
        this.exit();
        resolve({ approved: true });
      } else {
        this.exit();
        resolve({ approved: false, cancelled: true });
      }
    }

    return { ...decision };
  }

  /**
   * 获取已批准的方案。若未批准或被拒绝则抛出异常
   */
  requireApprovedPlan(): ProposedPlan {
    const isApprovedState =
      (this.state === "approved" || this.state === "executed") &&
      this.approvalDecision?.approved;

    if (!isApprovedState || !this.currentPlan) {
      if (this.state === "rejected") {
        throw new PlanRejectedError(
          this.currentPlan?.planId ?? "unknown",
          this.approvalDecision?.feedback
        );
      }
      throw new PlanNotApprovedError(this.currentPlan?.planId ?? "unknown");
    }
    return { ...this.currentPlan };
  }

  /**
   * 退出 Plan Mode，转入执行状态
   */
  exit(): void {
    const prevState = this.state;
    this.state = prevState === "approved" ? "executed" : "inactive";

    if (this.fsAccess && this.originalPolicy) {
      (this.fsAccess as any).policy = { ...this.originalPolicy };
    }
    this.originalPolicy = undefined;

    this.emitEvent("plan.exited", {
      previousState: prevState,
      finalState: this.state,
    });
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: this.projectId,
        sessionId: this.sessionId,
        data,
      });
    }
  }
}
