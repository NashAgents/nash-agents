/**
 * Plan Mode 强类型错误
 */

export class PlanModeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "PlanModeError";
    this.code = code;
  }
}

export class PlanNotApprovedError extends PlanModeError {
  readonly planId: string;

  constructor(planId: string) {
    super(
      "PLAN_NOT_APPROVED",
      `方案 '${planId}' 尚未获得用户批准，严禁直接转入实际任务执行！`
    );
    this.name = "PlanNotApprovedError";
    this.planId = planId;
  }
}

export class PlanRejectedError extends PlanModeError {
  readonly planId: string;
  readonly feedback?: string;

  constructor(planId: string, feedback?: string) {
    super(
      "PLAN_REJECTED",
      `方案 '${planId}' 已被用户拒绝${feedback ? `: ${feedback}` : ""}。`
    );
    this.name = "PlanRejectedError";
    this.planId = planId;
    this.feedback = feedback;
  }
}

export class MaterialDeviationApprovalRequiredError extends PlanModeError {
  readonly reason: string;

  constructor(reason: string) {
    super(
      "MATERIAL_DEVIATION_APPROVAL_REQUIRED",
      `执行过程发生重大方案偏离 (Material Deviation)，必须向用户提交新的方案进行审核审批: ${reason}`
    );
    this.name = "MaterialDeviationApprovalRequiredError";
    this.reason = reason;
  }
}

export class PlanExecutionBlockedError extends PlanModeError {
  readonly state: string;

  constructor(state: string, operation: string) {
    super(
      "PLAN_EXECUTION_BLOCKED",
      `当前处于 Plan Mode (${state}) 状态，在方案获得用户批准前禁止执行操作 '${operation}'。`
    );
    this.name = "PlanExecutionBlockedError";
    this.state = state;
  }
}
