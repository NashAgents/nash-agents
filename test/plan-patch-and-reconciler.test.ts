import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/observability/event-bus.js";
import { TaskManager } from "../src/task/task-manager.js";
import { PlanPatcher } from "../src/plan/plan-patcher.js";
import { formatTaskCentricView } from "../src/projection/index.js";

describe("PlanPatcher & Adaptive Plan Reconciler Subsystem", () => {
  describe("Plan Patch Execution & Invariant Guarantees", () => {
    it("1. reconcilePlan 能够保留已 completed 任务，并作废冲突未完成任务，动态接入新任务", () => {
      const eventBus = new EventBus();
      const taskManager = new TaskManager({ eventBus });
      const patcher = new PlanPatcher({ taskManager, eventBus });

      // 1. 初始化原始计划任务图
      const t1 = taskManager.createTask({
        id: "task-scan",
        subject: "项目结构扫描与依赖分析",
      });
      taskManager.claimTask(t1.id, "scanner");
      taskManager.completeTask(t1.id, { summary: "扫描完成发现 3 个待修模块" }, { agentId: "scanner" });

      const t2 = taskManager.createTask({
        id: "task-edit-auth",
        subject: "修改认证模块代码",
        dependencies: [t1.id],
      });
      taskManager.claimTask(t2.id, "backend-agent");

      const t3 = taskManager.createTask({
        id: "task-edit-ui",
        subject: "修改前端登录页面组件",
        dependencies: [t2.id],
      });

      const t4 = taskManager.createTask({
        id: "task-run-tests",
        subject: "运行修改后的回归测试套件",
        dependencies: [t3.id],
      });

      // 结构化 Reconcile：作废 t2, t3, t4，接入纯分析诊断任务
      const patchResult = patcher.reconcilePlan({
        supersedeTaskIds: [t2.id, t3.id, t4.id],
        newTasks: [
          {
            id: "task-analyze-report",
            subject: "代码只读审计与修复建议报告",
            description: "分析认证与前端缺陷，不产生代码写副作用",
          },
        ],
        reason: "User steer: switch to read-only diagnostics",
      });

      assert.equal(patchResult.preservedTasks.length, 1);
      assert.equal(patchResult.preservedTasks[0].id, "task-scan", "已完成的扫描任务必须被保留");

      // 验证未完成任务已被置为 superseded/cancelled
      const taskEditAuth = taskManager.getTask("task-edit-auth");
      const taskEditUi = taskManager.getTask("task-edit-ui");
      const taskRunTests = taskManager.getTask("task-run-tests");

      assert.equal(taskEditAuth?.status, "cancelled");
      assert(taskEditAuth?.supersededReason?.includes("User steer"));

      assert.equal(taskEditUi?.status, "cancelled");
      assert.equal(taskRunTests?.status, "cancelled");

      // 验证新生成的分析任务
      assert.equal(patchResult.createdTasks.length, 1);
      const newTask = patchResult.createdTasks[0];
      assert.equal(newTask.id, "task-analyze-report");
      assert.deepEqual(newTask.dependencies, ["task-scan"], "新任务应以前置已完成任务为依赖");
      assert.equal(newTask.status, "ready", "由于依赖已完成，新任务状态应立即可用 (ready)");

      // 验证最终 Task-Centric 视图呈现
      const view = formatTaskCentricView(taskManager);
      assert(view.includes("✓ [task-scan]"));
      assert(view.includes("(scanner · completed)"));
      assert(view.includes("⊘ [task-edit-auth]"));
      assert(view.includes("(superseded)"));
      assert(view.includes("⊘ [task-edit-ui]"));
      assert(view.includes("○ [task-analyze-report]"));
      assert(view.includes("(ready)"));
    });

    it("2. replaceTask 能够单任务原子置换并继承依赖", () => {
      const taskManager = new TaskManager();
      const patcher = new PlanPatcher({ taskManager });

      const t1 = taskManager.createTask({
        id: "task-test-integration",
        subject: "执行跨服务集成测试",
      });
      taskManager.claimTask(t1.id, "qa-agent");

      const { oldTask, newTask } = patcher.replaceTask(
        t1.id,
        {
          id: "task-test-perf",
          subject: "执行单元与基准性能测试",
        },
        "User steer: focus on unit performance only"
      );

      assert.equal(oldTask.status, "cancelled");
      assert.equal(oldTask.supersededByTaskId, "task-test-perf");
      assert.equal(newTask.id, "task-test-perf");
      assert.equal(newTask.subject, "执行单元与基准性能测试");
    });
  });
});
