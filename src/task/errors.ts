/**
 * Task 系统标准化强类型错误体系
 */

export class TaskError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "TaskError";
    this.code = code;
  }
}

export class TaskNotFoundError extends TaskError {
  readonly taskId: string;

  constructor(taskId: string) {
    super("TASK_NOT_FOUND", `未找到 ID 为 '${taskId}' 的任务。`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

export class TaskAlreadyExistsError extends TaskError {
  readonly taskId: string;

  constructor(taskId: string) {
    super("TASK_ALREADY_EXISTS", `任务 ID '${taskId}' 已存在。`);
    this.name = "TaskAlreadyExistsError";
    this.taskId = taskId;
  }
}

export class TaskNotReadyError extends TaskError {
  readonly taskId: string;
  readonly uncompletedDependencies: string[];

  constructor(taskId: string, uncompletedDependencies: string[]) {
    super(
      "TASK_NOT_READY",
      `任务 '${taskId}' 的前置依赖尚未满足，不能认领或执行: [${uncompletedDependencies.join(
        ", "
      )}]`
    );
    this.name = "TaskNotReadyError";
    this.taskId = taskId;
    this.uncompletedDependencies = uncompletedDependencies;
  }
}

export class TaskAlreadyOwnedError extends TaskError {
  readonly taskId: string;
  readonly currentOwner: string;
  readonly attemptOwner: string;

  constructor(taskId: string, currentOwner: string, attemptOwner: string) {
    super(
      "TASK_ALREADY_OWNED",
      `任务 '${taskId}' 已被 Agent '${currentOwner}' 认领/持有，Agent '${attemptOwner}' 无法重复认领。`
    );
    this.name = "TaskAlreadyOwnedError";
    this.taskId = taskId;
    this.currentOwner = currentOwner;
    this.attemptOwner = attemptOwner;
  }
}

export class TaskRevisionConflictError extends TaskError {
  readonly taskId: string;
  readonly currentRevision: number;
  readonly expectedRevision: number;

  constructor(
    taskId: string,
    currentRevision: number,
    expectedRevision: number
  ) {
    super(
      "TASK_REVISION_CONFLICT",
      `任务 '${taskId}' 发生并发修改版本冲突：预期 revision 为 ${expectedRevision}，但当前最新 revision 为 ${currentRevision} (CAS 失败)。`
    );
    this.name = "TaskRevisionConflictError";
    this.taskId = taskId;
    this.currentRevision = currentRevision;
    this.expectedRevision = expectedRevision;
  }
}

export class TaskInvalidDependencyError extends TaskError {
  readonly taskId: string;
  readonly dependencyId: string;

  constructor(taskId: string, dependencyId: string, reason?: string) {
    super(
      "TASK_INVALID_DEPENDENCY",
      `任务 '${taskId}' 声明了非法依赖 '${dependencyId}'${
        reason ? `: ${reason}` : ""
      }。`
    );
    this.name = "TaskInvalidDependencyError";
    this.taskId = taskId;
    this.dependencyId = dependencyId;
  }
}

export class TaskCycleDependencyError extends TaskError {
  readonly cyclePath: string[];

  constructor(cyclePath: string[]) {
    super(
      "TASK_CYCLE_DEPENDENCY",
      `检测到任务依赖关系图中存在循环依赖 (Cycle): ${cyclePath.join(" -> ")}。`
    );
    this.name = "TaskCycleDependencyError";
    this.cyclePath = cyclePath;
  }
}

export class TaskInvalidStateTransitionError extends TaskError {
  readonly taskId: string;
  readonly fromStatus: string;
  readonly toStatus: string;

  constructor(taskId: string, fromStatus: string, toStatus: string, reason?: string) {
    super(
      "TASK_INVALID_STATE_TRANSITION",
      `任务 '${taskId}' 状态转移非法: 无法从 '${fromStatus}' 转移至 '${toStatus}'${
        reason ? ` (${reason})` : ""
      }。`
    );
    this.name = "TaskInvalidStateTransitionError";
    this.taskId = taskId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}
