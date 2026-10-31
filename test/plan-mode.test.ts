import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PlanMode,
  TaskGraphBuilder,
  Replanner,
  PlanNotApprovedError,
  PlanRejectedError,
  MaterialDeviationApprovalRequiredError,
} from "../src/plan/index.js";
import { TaskManager } from "../src/task/index.js";
import { ConcurrencyController, ReplanLimitError } from "../src/concurrency/index.js";
import { EventBus } from "../src/observability/event-bus.js";

describe("Phase E: Plan Mode, TaskGraphBuilder & Replanner", () => {
  it("1. Plan Mode 完整生命周期: enter -> propose -> approve -> exit", () => {
    const eventBus = new EventBus();
    const events: string[] = [];
    eventBus.subscribe("*", (e) => {
      events.push(e.type);
    });

    const planMode = new PlanMode({ eventBus });
    assert.equal(planMode.getState(), "inactive");

    // Enter
    planMode.enter("Refactor User Authentication");
    assert.equal(planMode.getState(), "exploring");
    assert(events.includes("plan.entered"));

    // Propose
    const proposed = planMode.proposePlan({
      summary: "Migrate session tokens to JWT",
      steps: [
        { id: "step-1", subject: "Read auth middleware", writeScopes: ["src/auth/**"] },
        { id: "step-2", subject: "Implement JWT validation", dependencies: ["step-1"], writeScopes: ["src/auth/**"] },
        { id: "step-3", subject: "Run integration tests", dependencies: ["step-2"] },
      ],
      assumptions: ["Node 18+ crypto supported"],
    });

    assert.equal(planMode.getState(), "proposed");
    assert.equal(proposed.steps.length, 3);
    assert(events.includes("plan.proposed"));

    // Approve
    const decision = planMode.resolveApproval(true, "Looks good, proceed!");
    assert.equal(decision.approved, true);
    assert.equal(planMode.getState(), "approved");
    assert(events.includes("plan.approved"));

    // Exit
    planMode.exit();
    assert.equal(planMode.getState(), "executed");
    assert(events.includes("plan.exited"));
  });

  it("2. 未经用户批准的方案禁止构建 TaskGraph (PlanNotApprovedError)", () => {
    const planMode = new PlanMode();
    planMode.enter("Do something");
    planMode.proposePlan({
      summary: "Draft proposal",
      steps: [{ subject: "Step 1" }],
    });

    assert.throws(() => planMode.requireApprovedPlan(), PlanNotApprovedError);
  });

  it("3. 用户拒绝方案触发 PlanRejectedError", () => {
    const planMode = new PlanMode();
    planMode.enter("Dangerous task");
    planMode.proposePlan({
      summary: "Delete everything",
      steps: [{ subject: "rm -rf" }],
    });

    planMode.resolveApproval(false, "Unsafe approach");
    assert.equal(planMode.getState(), "rejected");

    assert.throws(() => planMode.requireApprovedPlan(), PlanRejectedError);
  });

  it("4. TaskGraphBuilder 忠实将已批准方案转化为运行时 TaskGraph", () => {
    const planMode = new PlanMode();
    planMode.enter("Feature implementation");
    planMode.proposePlan({
      summary: "Full feature",
      steps: [
        { id: "s1", subject: "Schema migration", writeScopes: ["db/**"] },
        { id: "s2", subject: "API route", dependencies: ["s1"], writeScopes: ["api/**"] },
      ],
    });
    planMode.resolveApproval(true);

    const approved = planMode.requireApprovedPlan();
    const taskManager = new TaskManager();

    const tasks = TaskGraphBuilder.buildIntoTaskManager(approved, taskManager);

    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, `task-${approved.planId}-s1`);
    assert.equal(tasks[0].status, "ready");
    assert.equal(tasks[0].writeScopes?.[0], "db/**");

    assert.equal(tasks[1].id, `task-${approved.planId}-s2`);
    assert.equal(tasks[1].status, "pending");
    assert.deepEqual(tasks[1].dependencies, [tasks[0].id]);
  });

  it("5. Minor Replan 受到 maxReplans 计数控制与增量任务追加", () => {
    const concurrency = new ConcurrencyController({ maxReplans: 2 });
    const taskManager = new TaskManager();
    const replanner = new Replanner({
      taskManager,
      concurrencyController: concurrency,
    });

    taskManager.createTask({ id: "t1", subject: "Task 1" });

    // 第 1 次小调整：增加验证步骤
    replanner.applyMinorReplan({
      reason: "Add verification step",
      newTasks: [{ id: "t2", subject: "Task 2 (Verify)", dependencies: ["t1"] }],
    });
    assert.equal(taskManager.getTasks().length, 2);

    // 第 2 次小调整
    replanner.applyMinorReplan({
      reason: "Second minor adjustment",
    });

    // 第 3 次超限 -> ReplanLimitError
    assert.throws(
      () =>
        replanner.applyMinorReplan({
          reason: "Third adjustment",
        }),
      ReplanLimitError
    );
  });

  it("6. 重大方案偏离 (Material Deviation) 必须拦截并要求用户审批", () => {
    const concurrency = new ConcurrencyController();
    const taskManager = new TaskManager();
    const replanner = new Replanner({
      taskManager,
      concurrencyController: concurrency,
    });

    const evalRes = replanner.evaluate({
      reason: "Discovered need to rewrite whole identity provider",
      isMaterialDeviation: true,
    });

    assert.equal(evalRes.type, "material_deviation");
    assert.equal(evalRes.requiresUserApproval, true);

    assert.throws(
      () => replanner.assertMaterialDeviationHandled(evalRes),
      MaterialDeviationApprovalRequiredError
    );
  });
});
