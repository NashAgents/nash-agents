/**
 * Job 相关的强类型错误定义
 */

export class JobNotFoundError extends Error {
  readonly code = "JOB_NOT_FOUND";
  constructor(jobId: string) {
    super(`Job '${jobId}' 不存在。`);
    this.name = "JobNotFoundError";
  }
}

export class JobPermissionDeniedError extends Error {
  readonly code = "JOB_PERMISSION_DENIED";
  constructor(jobId: string, currentAgentId: string, ownerAgentId: string) {
    super(
      `Agent '${currentAgentId}' 无权操作由 Agent '${ownerAgentId}' 拥有的 Job '${jobId}'。`
    );
    this.name = "JobPermissionDeniedError";
  }
}

export class JobExecutionTimeoutError extends Error {
  readonly code = "JOB_EXECUTION_TIMEOUT";
  constructor(jobId: string, hardTimeoutMs: number) {
    super(`Job '${jobId}' 超过了允许的最大硬超时时间 (${hardTimeoutMs}ms)，已被系统终止。`);
    this.name = "JobExecutionTimeoutError";
  }
}
