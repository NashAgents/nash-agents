import type { TaskManager } from "../task/task-manager.js";
import type { Task, CreateTaskInput } from "../task/types.js";
import type { EventBus } from "../observability/event-bus.js";

export interface ReconcilePlanOptions {
  supersedeTaskIds?: string[];
  newTasks?: CreateTaskInput[];
  reason: string;
}

export interface PlanPatchResult {
  preservedTasks: Task[];
  supersededTasks: Task[];
  createdTasks: Task[];
  summary: string;
}

/**
 * PlanPatcher - TaskGraph 增量更新与一致性协调器
 *
 * 核心设计原则：
 * 1. 语义决策归 LLM：Runtime 绝不在代码中通过关键词正则猜测自然语言意图；
 * 2. 状态机保证一致性：负责执行结构化的任务置换、DAG 依赖重连与 completed 任务归属保护；
 * 3. 幂等与版本控制：更新时自动维护 Task revision 递增与事件广播。
 */
export class PlanPatcher {
  private readonly taskManager: TaskManager;
  private readonly eventBus?: EventBus;

  constructor(options: { taskManager: TaskManager; eventBus?: EventBus }) {
    this.taskManager = options.taskManager;
    this.eventBus = options.eventBus;
  }

  /**
   * 结构化置换单个任务 (由 LLM 或协调层显式调用)
   */
  replaceTask(
    oldTaskId: string,
    newTaskInput: CreateTaskInput,
    reason: string
  ): { oldTask: Task; newTask: Task } {
    const oldTask = this.taskManager.getTask(oldTaskId);
    if (!oldTask) {
      throw new Error(`Task [${oldTaskId}] 不存在，无法执行置换。`);
    }

    // 1. 创建新任务，继承原任务的前置依赖与写范围（若未显式指定）
    const newTask = this.taskManager.createTask({
      ...newTaskInput,
      dependencies: newTaskInput.dependencies ?? oldTask.dependencies,
      writeScopes: newTaskInput.writeScopes ?? oldTask.writeScopes,
    });

    // 2. 将旧任务原子标记为 superseded
    const supersededOldTask = this.taskManager.supersedeTask(
      oldTaskId,
      newTask.id,
      reason
    );

    this.emitEvent("plan.task_replaced", {
      oldTaskId,
      newTaskId: newTask.id,
      reason,
    });

    return { oldTask: supersededOldTask, newTask };
  }

  /**
   * 批量结构化增量修订计划 (Plan Patch Reconcile)
   *
   * 保留原则：所有 status === 'completed' 的任务一律保留历史成果，
   * 指定的失效任务转为 superseded/cancelled，新任务自动接入依赖。
   */
  reconcilePlan(options: ReconcilePlanOptions): PlanPatchResult {
    const allTasks = this.taskManager.getTasks();
    const completedTasks = allTasks.filter((t) => t.status === "completed");
    const completedIds = completedTasks.map((t) => t.id);

    const supersededTasks: Task[] = [];
    const createdTasks: Task[] = [];

    this.emitEvent("plan.patch_started", { reason: options.reason });

    // 1. 作废指定的冲突或失效任务
    if (options.supersedeTaskIds && options.supersedeTaskIds.length > 0) {
      for (const taskId of options.supersedeTaskIds) {
        const task = this.taskManager.getTask(taskId);
        if (task && task.status !== "completed") {
          const superseded = this.taskManager.supersedeTask(
            taskId,
            undefined,
            options.reason
          );
          supersededTasks.push(superseded);
        }
      }
    }

    // 2. 注入新任务并连接前置依赖
    if (options.newTasks && options.newTasks.length > 0) {
      for (const input of options.newTasks) {
        const deps = input.dependencies && input.dependencies.length > 0
          ? input.dependencies
          : completedIds;

        const created = this.taskManager.createTask({
          ...input,
          dependencies: deps,
        });
        createdTasks.push(created);
      }
    }

    const currentTasks = this.taskManager.getTasks();
    const preservedTasks = currentTasks.filter(
      (t) => !supersededTasks.some((s) => s.id === t.id) && !createdTasks.some((c) => c.id === t.id)
    );

    const summary = `Plan revised · ${supersededTasks.length} superseded, ${createdTasks.length} created`;
    this.emitEvent("plan.patch_completed", { summary, reason: options.reason });

    return {
      preservedTasks,
      supersededTasks,
      createdTasks,
      summary,
    };
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: "default-project",
        sessionId: "default-session",
        data,
      });
    }
  }
}
