import type { Task } from "./types.js";
import {
  TaskInvalidDependencyError,
  TaskCycleDependencyError,
} from "./errors.js";

/**
 * TaskGraph - 纯声明式任务依赖关系图管理
 *
 * 职责：
 * 1. 验证任务依赖引用的合法性；
 * 2. 检测有向图是否存在循环依赖 (DAG Cycle Check)；
 * 3. 获取前置依赖、下游后继节点以及拓扑排序序列。
 */
export class TaskGraph {
  /**
   * 校验给定任务集或增量依赖是否形成合法的有向无环图 (DAG)
   *
   * @param tasks - 当前任务映射或列表
   * @param additionalTask - 可选的新增/修改任务
   */
  static validate(
    tasks: Map<string, Task> | Task[],
    additionalTask?: { id: string; dependencies: string[] }
  ): void {
    const taskMap = new Map<string, string[]>();

    if (Array.isArray(tasks)) {
      for (const t of tasks) {
        taskMap.set(t.id, [...t.dependencies]);
      }
    } else {
      for (const [id, t] of tasks.entries()) {
        taskMap.set(id, [...t.dependencies]);
      }
    }

    if (additionalTask) {
      taskMap.set(additionalTask.id, [...additionalTask.dependencies]);
    }

    // 1. 检查是否存在对不存在任务的引用或自依赖
    for (const [taskId, deps] of taskMap.entries()) {
      for (const depId of deps) {
        if (depId === taskId) {
          throw new TaskInvalidDependencyError(
            taskId,
            depId,
            "任务不能依赖自身 (Self dependency)"
          );
        }
        if (!taskMap.has(depId)) {
          throw new TaskInvalidDependencyError(
            taskId,
            depId,
            `引用的前置依赖任务 '${depId}' 在任务图中不存在`
          );
        }
      }
    }

    // 2. 检测 DAG 环 (Tarjan / DFS 3-Color 染色法: 0=White, 1=Gray, 2=Black)
    const visited = new Map<string, number>();
    const recursionStack: string[] = [];

    const dfs = (currentId: string) => {
      visited.set(currentId, 1); // Gray
      recursionStack.push(currentId);

      const deps = taskMap.get(currentId) ?? [];
      for (const depId of deps) {
        const state = visited.get(depId) ?? 0;
        if (state === 1) {
          // 发现灰色节点 -> 存在环
          const cycleStartIndex = recursionStack.indexOf(depId);
          const cyclePath = [...recursionStack.slice(cycleStartIndex), depId];
          throw new TaskCycleDependencyError(cyclePath);
        }
        if (state === 0) {
          dfs(depId);
        }
      }

      recursionStack.pop();
      visited.set(currentId, 2); // Black
    };

    for (const taskId of taskMap.keys()) {
      if ((visited.get(taskId) ?? 0) === 0) {
        dfs(taskId);
      }
    }
  }

  /**
   * 计算依赖拓扑排序序列（若存在依赖，被依赖的任务在前）
   */
  static getTopologicalOrder(tasks: Map<string, Task> | Task[]): string[] {
    this.validate(tasks);

    const taskList = Array.isArray(tasks) ? tasks : Array.from(tasks.values());
    const inDegree = new Map<string, number>();
    const dependentsMap = new Map<string, string[]>(); // depId -> tasks that depend on it

    for (const t of taskList) {
      inDegree.set(t.id, t.dependencies.length);
      for (const depId of t.dependencies) {
        const list = dependentsMap.get(depId) ?? [];
        list.push(t.id);
        dependentsMap.set(depId, list);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) {
        queue.push(id);
      }
    }

    const result: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      const nextNodes = dependentsMap.get(current) ?? [];
      for (const next of nextNodes) {
        const deg = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, deg);
        if (deg === 0) {
          queue.push(next);
        }
      }
    }

    return result;
  }
}
