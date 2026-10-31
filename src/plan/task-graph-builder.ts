import type { ProposedPlan } from "./types.js";
import type { Task, CreateTaskInput } from "../task/types.js";
import type { TaskManager } from "../task/task-manager.js";

/**
 * TaskGraphBuilder - 将已批准的 Plan 转换为运行时 TaskGraph / Tasks
 *
 * 铁律：
 * 1. 若方案已获用户审批，直接忠实映射为运行时 TaskGraph，绝对不重新唤起 Planner 再次从零规划；
 * 2. 负责补充与校验 task id、dependencies、writeScopes 与 metadata；
 * 3. 保证生成的任务图符合 DAG 依赖规范。
 */
export class TaskGraphBuilder {
  /**
   * 将 ProposedPlan 转换为 CreateTaskInput 列表
   */
  static planToTaskInputs(plan: ProposedPlan): CreateTaskInput[] {
    const idMapping = new Map<string, string>();

    // 1. 建立步骤 ID 映射关系
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const sourceId = step.id ?? `step-${i + 1}`;
      const targetId = `task-${plan.planId}-${sourceId}`;
      idMapping.set(sourceId, targetId);
    }

    // 2. 生成结构化 CreateTaskInput
    const taskInputs: CreateTaskInput[] = [];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const sourceId = step.id ?? `step-${i + 1}`;
      const mappedId = idMapping.get(sourceId)!;

      const rawDeps = step.dependencies ?? [];
      const mappedDeps = rawDeps.map((d) => idMapping.get(d) ?? d);

      taskInputs.push({
        id: mappedId,
        subject: step.subject,
        description: step.description,
        dependencies: mappedDeps,
        writeScopes: step.writeScopes ? [...step.writeScopes] : undefined,
        metadata: {
          planId: plan.planId,
          stepIndex: i,
          goal: plan.goal,
          ...step.metadata,
        },
      });
    }

    return taskInputs;
  }

  /**
   * 直接将已批准的方案构建并注入到 TaskManager 中
   */
  static buildIntoTaskManager(
    plan: ProposedPlan,
    taskManager: TaskManager
  ): Task[] {
    // 治理孤儿任务：作废之前未启动的旧 Plan 任务，避免残留堆叠
    const existingTasks = taskManager.getTasks();
    for (const t of existingTasks) {
      if (
        (t.status === "ready" || t.status === "pending") &&
        t.metadata?.planId &&
        t.metadata.planId !== plan.planId
      ) {
        try {
          taskManager.supersedeTask(t.id, undefined, `Superseded by new plan ${plan.planId}`);
        } catch {
          // 静默容错
        }
      }
    }

    const taskInputs = this.planToTaskInputs(plan);
    return taskManager.createTasks(taskInputs);
  }
}
