import type {
  ReplanEvaluation,
  ReplanType,
} from "./types.js";
import { MaterialDeviationApprovalRequiredError } from "./errors.js";
import type { TaskManager } from "../task/task-manager.js";
import type { ConcurrencyController } from "../concurrency/concurrency-controller.js";
import type { CreateTaskInput } from "../task/types.js";

export interface ReplannerOptions {
  taskManager: TaskManager;
  concurrencyController: ConcurrencyController;
}

/**
 * Replanner - 负责执行中动态变化的自适应调整与重大偏离拦截
 */
export class Replanner {
  private readonly taskManager: TaskManager;
  private readonly concurrencyController: ConcurrencyController;

  constructor(options: ReplannerOptions) {
    this.taskManager = options.taskManager;
    this.concurrencyController = options.concurrencyController;
  }

  /**
   * 评估执行变化是属于小范围自适应调整 (Minor Replan) 还是重大方案偏离 (Material Deviation)
   */
  evaluate(context: {
    reason: string;
    isMaterialDeviation?: boolean;
    impactedTasks?: string[];
    proposedNewTasks?: CreateTaskInput[];
  }): ReplanEvaluation {
    const isMaterial = Boolean(context.isMaterialDeviation);
    const type: ReplanType = isMaterial ? "material_deviation" : "minor_adjustment";

    return {
      type,
      reason: context.reason,
      impactedTasks: context.impactedTasks ? [...context.impactedTasks] : [],
      proposedChanges: context.proposedNewTasks,
      requiresUserApproval: isMaterial,
    };
  }

  /**
   * 执行小范围调整 (Minor Replan)
   */
  applyMinorReplan(input: {
    reason: string;
    newTasks?: CreateTaskInput[];
    retryTasks?: string[];
  }): void {
    // 检查并累计 Replan 次数上限 (受 ConcurrencyController 约束)
    this.concurrencyController.recordReplan();

    // 重新打开需要重试的任务
    if (input.retryTasks) {
      for (const taskId of input.retryTasks) {
        const task = this.taskManager.getTask(taskId);
        if (task && (task.status === "failed" || task.status === "blocked")) {
          this.taskManager.unblockTask(taskId);
        }
      }
    }

    // 增量添加新任务
    if (input.newTasks && input.newTasks.length > 0) {
      for (const t of input.newTasks) {
        this.concurrencyController.registerTask();
        this.taskManager.createTask(t);
      }
    }
  }

  /**
   * 提交重大偏离评估，若为重大偏离则强制要求触发用户审批
   */
  assertMaterialDeviationHandled(evaluation: ReplanEvaluation): void {
    if (evaluation.requiresUserApproval) {
      throw new MaterialDeviationApprovalRequiredError(evaluation.reason);
    }
  }
}
