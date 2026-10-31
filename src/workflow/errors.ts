/**
 * Workflow 运行时强类型错误
 */

export class WorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "WorkflowError";
    this.code = code;
  }
}

export class WorkflowCancelledError extends WorkflowError {
  constructor(reason?: string) {
    super(
      "WORKFLOW_CANCELLED",
      `Workflow 执行被取消${reason ? `: ${reason}` : ""}。`
    );
    this.name = "WorkflowCancelledError";
  }
}

export class WorkflowExecutionError extends WorkflowError {
  readonly originalError?: Error;

  constructor(message: string, originalError?: Error) {
    super(
      "WORKFLOW_EXECUTION_ERROR",
      `Workflow 执行失败: ${message}${
        originalError ? `\nCaused by: ${originalError.message}` : ""
      }`
    );
    this.name = "WorkflowExecutionError";
    this.originalError = originalError;
  }
}
