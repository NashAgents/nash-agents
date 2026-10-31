import * as crypto from "node:crypto";
import path from "node:path";
import type {
  Task,
  TaskStatus,
  TaskResult,
  CreateTaskInput,
  UpdateTaskInput,
} from "./types.js";
import {
  TaskNotFoundError,
  TaskAlreadyExistsError,
  TaskNotReadyError,
  TaskAlreadyOwnedError,
  TaskRevisionConflictError,
  TaskInvalidStateTransitionError,
} from "./errors.js";
import { TaskGraph } from "./task-graph.js";
import type { EventBus } from "../observability/event-bus.js";
import { checkScopeOverlap } from "../filesystem/write-scope.js";
import { WriteScopeConflictError } from "../filesystem/errors.js";

export interface TaskManagerOptions {
  eventBus?: EventBus;
  projectId?: string;
  sessionId?: string;
  defaultWorkspacePath?: string;
}

/**
 * 允许的状态转移合法性判定矩阵
 */
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["ready", "blocked", "cancelled"],
  ready: ["running", "completed", "pending", "blocked", "cancelled"],
  running: ["completed", "failed", "blocked", "ready", "cancelled"],
  blocked: ["ready", "pending", "cancelled", "failed"],
  completed: [], // 终态
  failed: ["ready", "pending", "cancelled"], // 支持重试/Replan重新打开
  cancelled: [], // 终态
};

/**
 * 任务所有权获取选项
 */
export interface AcquireTaskOwnershipOptions {
  expectedRevision?: number;
  workspaceMode?: "shared" | "worktree";
  worktreePath?: string;
}

/**
 * TaskManager - 负责工作单元的状态一致性、DAG 依赖校验、原子 Claim 与生命周期
 */
export class TaskManager {
  private readonly tasks = new Map<string, Task>();
  private readonly eventBus?: EventBus;
  private readonly projectId: string;
  private readonly sessionId: string;
  private readonly defaultWorkspacePath: string;

  constructor(options?: TaskManagerOptions) {
    this.eventBus = options?.eventBus;
    this.projectId = options?.projectId ?? "default-project";
    this.sessionId = options?.sessionId ?? "default-session";
    this.defaultWorkspacePath = path.resolve(options?.defaultWorkspacePath ?? process.cwd());
  }

  getTasks(): Task[] {
    return Array.from(this.tasks.values()).map((t) => ({ ...t }));
  }

  clear(): void {
    this.tasks.clear();
  }

  getTask(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  requireTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }
    return { ...task };
  }

  createTask(input: CreateTaskInput): Task {
    const id = input.id ?? `task-${crypto.randomUUID().slice(0, 8)}`;
    if (this.tasks.has(id)) {
      throw new TaskAlreadyExistsError(id);
    }

    const dependencies = input.dependencies ? [...input.dependencies] : [];

    TaskGraph.validate(this.tasks, { id, dependencies });

    const isDependenciesCompleted = this.checkDependenciesSatisfied(dependencies);
    const initialStatus: TaskStatus = isDependenciesCompleted ? "ready" : "pending";

    const now = Date.now();
    const task: Task = {
      id,
      subject: input.subject,
      description: input.description,
      status: initialStatus,
      dependencies,
      ownerAgentId: input.ownerAgentId,
      writeScopes: input.writeScopes ? [...input.writeScopes] : undefined,
      metadata: input.metadata ? { ...input.metadata } : undefined,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(id, task);

    this.emitEvent("task.created", { task: { ...task } });
    if (initialStatus === "ready") {
      this.emitEvent("task.ready", { taskId: id, task: { ...task } });
    }

    return { ...task };
  }

  createTasks(inputs: CreateTaskInput[]): Task[] {
    const incomingIds = new Set<string>();
    for (const input of inputs) {
      const id = input.id ?? `task-${crypto.randomUUID().slice(0, 8)}`;
      if (this.tasks.has(id) || incomingIds.has(id)) {
        throw new TaskAlreadyExistsError(id);
      }
      incomingIds.add(id);
    }

    const tempMap = new Map<string, Task>(this.tasks);
    const preparedTasks: Task[] = [];
    const now = Date.now();

    for (const input of inputs) {
      const id = input.id ?? `task-${crypto.randomUUID().slice(0, 8)}`;
      const dependencies = input.dependencies ? [...input.dependencies] : [];
      const dummyTask: Task = {
        id,
        subject: input.subject,
        description: input.description,
        status: "pending",
        dependencies,
        ownerAgentId: input.ownerAgentId,
        writeScopes: input.writeScopes ? [...input.writeScopes] : undefined,
        metadata: input.metadata ? { ...input.metadata } : undefined,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      tempMap.set(id, dummyTask);
      preparedTasks.push(dummyTask);
    }

    TaskGraph.validate(tempMap);

    const created: Task[] = [];
    for (const task of preparedTasks) {
      const satisfied = this.checkDependenciesSatisfied(task.dependencies);
      task.status = satisfied ? "ready" : "pending";
      this.tasks.set(task.id, task);
      created.push({ ...task });

      this.emitEvent("task.created", { task: { ...task } });
      if (task.status === "ready") {
        this.emitEvent("task.ready", { taskId: task.id, task: { ...task } });
      }
    }

    return created;
  }

  updateTask(taskId: string, input: UpdateTaskInput): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (
      input.expectedRevision !== undefined &&
      task.revision !== input.expectedRevision
    ) {
      throw new TaskRevisionConflictError(
        taskId,
        task.revision,
        input.expectedRevision
      );
    }

    if (input.dependencies) {
      const updatedDeps = [...input.dependencies];
      const tempMap = new Map(this.tasks);
      tempMap.set(taskId, { ...task, dependencies: updatedDeps });
      TaskGraph.validate(tempMap);
      task.dependencies = updatedDeps;

      if (task.status === "pending" || task.status === "ready") {
        const satisfied = this.checkDependenciesSatisfied(updatedDeps);
        const nextStatus: TaskStatus = satisfied ? "ready" : "pending";
        if (task.status !== nextStatus) {
          task.status = nextStatus;
          if (nextStatus === "ready") {
            this.emitEvent("task.ready", { taskId, task: { ...task } });
          }
        }
      }
    }

    if (input.subject !== undefined) task.subject = input.subject;
    if (input.description !== undefined) task.description = input.description;
    if (input.ownerAgentId !== undefined) {
      const oldOwner = task.ownerAgentId;
      task.ownerAgentId = input.ownerAgentId;
      if (oldOwner !== input.ownerAgentId) {
        this.emitEvent("task.owner_changed", {
          taskId,
          previousOwner: oldOwner,
          newOwner: input.ownerAgentId,
        });
      }
    }
    if (input.writeScopes !== undefined) {
      task.writeScopes = [...input.writeScopes];
    }
    if (input.metadata !== undefined) {
      task.metadata = { ...input.metadata };
    }

    task.revision++;
    task.updatedAt = Date.now();

    return { ...task };
  }

  /**
   * 统一底层所有权获取核心 (acquireTaskOwnership)
   * 统一供 claimTask 和 assignTask 调用，确保权限校验、CAS 乐观锁与 writeScopes 冲突检查完全一致
   */
  private acquireTaskOwnership(
    taskId: string,
    agentId: string,
    action: "claim" | "assign",
    options?: AcquireTaskOwnershipOptions
  ): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (
      options?.expectedRevision !== undefined &&
      task.revision !== options.expectedRevision
    ) {
      throw new TaskRevisionConflictError(
        taskId,
        task.revision,
        options.expectedRevision
      );
    }

    // 状态转移合法性检查
    if (action === "claim") {
      if (task.status !== "ready") {
        if (task.status === "pending") {
          const uncompleted = task.dependencies.filter(
            (depId) => this.tasks.get(depId)?.status !== "completed"
          );
          throw new TaskNotReadyError(taskId, uncompleted);
        }
        throw new TaskInvalidStateTransitionError(
          taskId,
          task.status,
          "running",
          "只能认领状态为 ready 的任务"
        );
      }
    }

    if (action === "claim" && task.ownerAgentId && task.ownerAgentId !== agentId) {
      throw new TaskAlreadyOwnedError(taskId, task.ownerAgentId, agentId);
    }

    // 区分物理工作区进行 writeScopes 冲突检查
    // 只有在同一个物理工作区（shared workspace 且未指定独立 worktree）时才执行互斥拦截
    const targetWorkspace =
      options?.workspaceMode === "worktree" && options.worktreePath
        ? path.resolve(options.worktreePath)
        : this.defaultWorkspacePath;

    if (options?.workspaceMode !== "worktree" && task.writeScopes && task.writeScopes.length > 0) {
      for (const runningTask of this.tasks.values()) {
        if (
          runningTask.id !== taskId &&
          runningTask.status === "running" &&
          runningTask.writeScopes &&
          runningTask.writeScopes.length > 0
        ) {
          // 获取 runningTask 的物理工作区
          const runningWorkspace = runningTask.metadata?.worktreePath
            ? path.resolve(String(runningTask.metadata.worktreePath))
            : this.defaultWorkspacePath;

          // 仅当两个任务处于同一个物理工作区时发生硬冲突
          if (runningWorkspace === targetWorkspace) {
            const overlap = checkScopeOverlap(task.writeScopes, runningTask.writeScopes);
            if (overlap.conflict) {
              throw new WriteScopeConflictError(
                `Task [${runningTask.id}] '${runningTask.subject}' (在同一工作区运行中)`,
                task.writeScopes,
                runningTask.writeScopes
              );
            }
          }
        }
      }
    }

    const previousOwner = task.ownerAgentId;
    task.ownerAgentId = agentId;
    task.updatedAt = Date.now();
    task.revision++;

    if (options?.worktreePath) {
      task.metadata = {
        ...task.metadata,
        worktreePath: options.worktreePath,
      };
    }

    if (action === "claim") {
      task.status = "running";
      task.startedAt = task.startedAt ?? Date.now();
      this.emitEvent("task.started", {
        taskId,
        agentId,
        task: { ...task },
      });
    } else {
      this.emitEvent("task.owner_changed", {
        taskId,
        previousOwner,
        newOwner: agentId,
        task: { ...task },
      });
    }

    return { ...task };
  }

  /**
   * Agent 原子认领 (Claim) 任务
   */
  claimTask(
    taskId: string,
    agentId: string,
    expectedRevision?: number,
    options?: { workspaceMode?: "shared" | "worktree"; worktreePath?: string }
  ): Task {
    return this.acquireTaskOwnership(taskId, agentId, "claim", {
      expectedRevision,
      workspaceMode: options?.workspaceMode,
      worktreePath: options?.worktreePath,
    });
  }

  /**
   * Lead 明确分配任务所有权 (Assign)
   */
  assignTask(
    taskId: string,
    agentId: string,
    expectedRevision?: number,
    options?: { workspaceMode?: "shared" | "worktree"; worktreePath?: string }
  ): Task {
    return this.acquireTaskOwnership(taskId, agentId, "assign", {
      expectedRevision,
      workspaceMode: options?.workspaceMode,
      worktreePath: options?.worktreePath,
    });
  }

  /**
   * 释放任务认领 (Unclaim)
   */
  unclaimTask(taskId: string, agentId: string, expectedRevision?: number): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (
      expectedRevision !== undefined &&
      task.revision !== expectedRevision
    ) {
      throw new TaskRevisionConflictError(
        taskId,
        task.revision,
        expectedRevision
      );
    }

    if (task.ownerAgentId && task.ownerAgentId !== agentId) {
      throw new TaskAlreadyOwnedError(taskId, task.ownerAgentId, agentId);
    }

    const previousOwner = task.ownerAgentId;
    task.ownerAgentId = undefined;
    if (task.status === "running") {
      task.status = "ready";
    }
    task.updatedAt = Date.now();
    task.revision++;

    this.emitEvent("task.owner_changed", {
      taskId,
      previousOwner,
      newOwner: undefined,
      task: { ...task },
    });

    return { ...task };
  }

  /**
   * 标记任务完成，并触发下游依赖任务的 readiness 级联推进
   */
  private assertMutationActor(task: Task, actor?: { agentId?: string; isLead?: boolean }): void {
    // Calls without an actor are trusted runtime operations; tools always bind one.
    if (!actor?.agentId || actor.isLead) return;
    if (task.ownerAgentId !== actor.agentId && task.metadata?.delegatedTo !== actor.agentId) {
      throw new TaskAlreadyOwnedError(task.id, task.ownerAgentId ?? "unassigned", actor.agentId);
    }
  }

  completeTask(
    taskId: string,
    result: TaskResult,
    options?: { agentId?: string; expectedRevision?: number; isLead?: boolean }
  ): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (
      options?.expectedRevision !== undefined &&
      task.revision !== options.expectedRevision
    ) {
      throw new TaskRevisionConflictError(
        taskId,
        task.revision,
        options.expectedRevision
      );
    }

    this.assertMutationActor(task, options);

    this.validateTransition(task, "completed");

    const now = Date.now();
    task.status = "completed";
    task.result = result;
    task.completedByAgentId = options?.agentId ?? task.ownerAgentId;
    task.completedAt = now;
    task.updatedAt = now;
    task.revision++;

    this.emitEvent("task.completed", {
      taskId,
      result,
      agentId: options?.agentId ?? task.ownerAgentId,
      task: { ...task },
    });

    this.refreshDependentsReadiness(taskId);

    return { ...task };
  }

  failTask(
    taskId: string,
    error: { message: string; code?: string; stack?: string },
    options?: { agentId?: string; expectedRevision?: number; isLead?: boolean }
  ): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (
      options?.expectedRevision !== undefined &&
      task.revision !== options.expectedRevision
    ) {
      throw new TaskRevisionConflictError(
        taskId,
        task.revision,
        options.expectedRevision
      );
    }

    this.assertMutationActor(task, options);
    this.validateTransition(task, "failed");

    const now = Date.now();
    task.status = "failed";
    task.error = error;
    task.failedByAgentId = options?.agentId ?? task.ownerAgentId;
    task.completedAt = now;
    task.updatedAt = now;
    task.revision++;

    this.emitEvent("task.failed", {
      taskId,
      error,
      agentId: options?.agentId ?? task.ownerAgentId,
      task: { ...task },
    });

    return { ...task };
  }

  blockTask(
    taskId: string,
    reason: string,
    blockedBy?: string[],
    options?: { agentId?: string; expectedRevision?: number; isLead?: boolean }
  ): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (
      options?.expectedRevision !== undefined &&
      task.revision !== options.expectedRevision
    ) {
      throw new TaskRevisionConflictError(
        taskId,
        task.revision,
        options.expectedRevision
      );
    }

    this.assertMutationActor(task, options);
    this.validateTransition(task, "blocked");

    const now = Date.now();
    task.status = "blocked";
    task.blockedReason = reason;
    task.blockedBy = blockedBy ? [...blockedBy] : undefined;
    task.updatedAt = now;
    task.revision++;

    this.emitEvent("task.blocked", {
      taskId,
      reason,
      blockedBy,
      agentId: options?.agentId ?? task.ownerAgentId,
      task: { ...task },
    });

    return { ...task };
  }

  unblockTask(taskId: string, options?: { expectedRevision?: number }): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (
      options?.expectedRevision !== undefined &&
      task.revision !== options.expectedRevision
    ) {
      throw new TaskRevisionConflictError(
        taskId,
        task.revision,
        options.expectedRevision
      );
    }

    if (task.status !== "blocked") {
      return { ...task };
    }

    const satisfied = this.checkDependenciesSatisfied(task.dependencies);
    const nextStatus: TaskStatus = satisfied ? "ready" : "pending";

    task.status = nextStatus;
    task.blockedReason = undefined;
    task.blockedBy = undefined;
    task.updatedAt = Date.now();
    task.revision++;

    if (nextStatus === "ready") {
      this.emitEvent("task.ready", { taskId, task: { ...task } });
    }

    return { ...task };
  }

  cancelTask(
    taskId: string,
    reason?: string,
    options?: { expectedRevision?: number }
  ): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (
      options?.expectedRevision !== undefined &&
      task.revision !== options.expectedRevision
    ) {
      throw new TaskRevisionConflictError(
        taskId,
        task.revision,
        options.expectedRevision
      );
    }

    this.validateTransition(task, "cancelled");

    const now = Date.now();
    task.status = "cancelled";
    task.completedAt = now;
    task.updatedAt = now;
    task.revision++;

    this.emitEvent("task.cancelled", {
      taskId,
      reason,
      task: { ...task },
    });

    return { ...task };
  }

  /**
   * 将任务标记为被新任务取代 (superseded / cancelled)
   */
  supersedeTask(
    taskId: string,
    supersededByTaskId?: string,
    reason?: string,
    options?: { expectedRevision?: number }
  ): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (
      options?.expectedRevision !== undefined &&
      task.revision !== options.expectedRevision
    ) {
      throw new TaskRevisionConflictError(
        taskId,
        task.revision,
        options.expectedRevision
      );
    }

    if (task.status === "completed") {
      // 已完成任务不允许直接作废，保留历史
      return { ...task };
    }

    this.validateTransition(task, "cancelled");

    const now = Date.now();
    task.status = "cancelled";
    task.supersededByTaskId = supersededByTaskId;
    task.supersededReason = reason ?? `Superseded by task ${supersededByTaskId ?? "new plan"}`;
    task.completedAt = now;
    task.updatedAt = now;
    task.revision++;

    this.emitEvent("task.superseded", {
      taskId,
      supersededByTaskId,
      reason: task.supersededReason,
      task: { ...task },
    });

    return { ...task };
  }

  getReadyUnclaimedTasks(): Task[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.status === "ready" && !t.ownerAgentId)
      .map((t) => ({ ...t }));
  }

  private checkDependenciesSatisfied(dependencies: string[]): boolean {
    if (dependencies.length === 0) {
      return true;
    }
    for (const depId of dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep || dep.status !== "completed") {
        return false;
      }
    }
    return true;
  }

  private refreshDependentsReadiness(completedTaskId: string): void {
    for (const task of this.tasks.values()) {
      if (task.status === "pending" && task.dependencies.includes(completedTaskId)) {
        if (this.checkDependenciesSatisfied(task.dependencies)) {
          task.status = "ready";
          task.updatedAt = Date.now();
          task.revision++;
          this.emitEvent("task.ready", {
            taskId: task.id,
            task: { ...task },
          });
        }
      }
    }
  }

  private validateTransition(task: Task, toStatus: TaskStatus): void {
    const allowed = VALID_TRANSITIONS[task.status] ?? [];
    if (!allowed.includes(toStatus)) {
      throw new TaskInvalidStateTransitionError(
        task.id,
        task.status,
        toStatus
      );
    }
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
