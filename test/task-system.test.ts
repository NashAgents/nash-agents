import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskManager,
  TaskGraph,
  TaskNotReadyError,
  TaskAlreadyOwnedError,
  TaskRevisionConflictError,
  TaskInvalidDependencyError,
  TaskCycleDependencyError,
  TaskInvalidStateTransitionError,
} from "../src/task/index.js";
import { EventBus } from "../src/observability/event-bus.js";

describe("Phase A: Task System & TaskGraph", () => {
  it("1. 无依赖任务直接进入 ready 状态，有依赖任务初始为 pending", () => {
    const taskManager = new TaskManager();

    const t1 = taskManager.createTask({
      id: "task-1",
      subject: "Task 1 (No deps)",
    });
    assert.equal(t1.status, "ready");

    const t2 = taskManager.createTask({
      id: "task-2",
      subject: "Task 2 (Depends on task-1)",
      dependencies: ["task-1"],
    });
    assert.equal(t2.status, "pending");
  });

  it("2. dependency 完成后自动级联推进后继任务变为 ready", () => {
    const taskManager = new TaskManager();

    taskManager.createTask({ id: "t1", subject: "t1" });
    taskManager.createTask({ id: "t2", subject: "t2", dependencies: ["t1"] });
    taskManager.createTask({ id: "t3", subject: "t3", dependencies: ["t2"] });

    assert.equal(taskManager.getTask("t2")?.status, "pending");
    assert.equal(taskManager.getTask("t3")?.status, "pending");

    // t1 被认领并完成
    taskManager.claimTask("t1", "agent-a");
    taskManager.completeTask("t1", { summary: "t1 done" });

    assert.equal(taskManager.getTask("t1")?.status, "completed");
    assert.equal(taskManager.getTask("t2")?.status, "ready");
    assert.equal(taskManager.getTask("t3")?.status, "pending");

    // t2 被认领并完成
    taskManager.claimTask("t2", "agent-b");
    taskManager.completeTask("t2", { summary: "t2 done" });

    assert.equal(taskManager.getTask("t2")?.status, "completed");
    assert.equal(taskManager.getTask("t3")?.status, "ready");
  });

  it("3. 合法状态转移与非法状态转移拒绝", () => {
    const taskManager = new TaskManager();
    taskManager.createTask({ id: "t1", subject: "t1" });

    // ready -> running
    taskManager.claimTask("t1", "agent-1");
    assert.equal(taskManager.getTask("t1")?.status, "running");

    // running -> blocked -> ready
    taskManager.blockTask("t1", "waiting for db credentials");
    assert.equal(taskManager.getTask("t1")?.status, "blocked");
    taskManager.unblockTask("t1");
    assert.equal(taskManager.getTask("t1")?.status, "ready");

    // ready -> running -> completed
    taskManager.claimTask("t1", "agent-1");
    taskManager.completeTask("t1", { summary: "all done" });
    assert.equal(taskManager.getTask("t1")?.status, "completed");

    // completed 无法再被 claim 或修改
    assert.throws(
      () => taskManager.claimTask("t1", "agent-2"),
      TaskInvalidStateTransitionError
    );
  });

  it("4. 非法引用与循环依赖 (Cycle Detection) 校验", () => {
    const taskManager = new TaskManager();

    // 自依赖拒绝
    assert.throws(
      () =>
        taskManager.createTask({
          id: "self",
          subject: "self",
          dependencies: ["self"],
        }),
      TaskInvalidDependencyError
    );

    // 不存在的依赖拒绝
    assert.throws(
      () =>
        taskManager.createTask({
          id: "orphan",
          subject: "orphan",
          dependencies: ["not-exist"],
        }),
      TaskInvalidDependencyError
    );

    // 循环依赖 A -> B -> C -> A
    taskManager.createTask({ id: "A", subject: "A" });
    taskManager.createTask({ id: "B", subject: "B", dependencies: ["A"] });
    taskManager.createTask({ id: "C", subject: "C", dependencies: ["B"] });

    // 修改 A 依赖 C -> 形成环
    assert.throws(
      () => taskManager.updateTask("A", { dependencies: ["C"] }),
      TaskCycleDependencyError
    );
  });

  it("5. 原子 Claim 与并发版本冲突 CAS", () => {
    const taskManager = new TaskManager();
    taskManager.createTask({ id: "t1", subject: "t1" });

    const current = taskManager.requireTask("t1");
    assert.equal(current.revision, 1);

    // agent-A 使用 revision=1 成功 claim
    const claimedA = taskManager.claimTask("t1", "agent-A", 1);
    assert.equal(claimedA.ownerAgentId, "agent-A");
    assert.equal(claimedA.revision, 2);

    // agent-B 同时使用过期的 revision=1 尝试 claim -> 抛出 TaskRevisionConflictError
    assert.throws(
      () => taskManager.claimTask("t1", "agent-B", 1),
      TaskRevisionConflictError
    );

    // agent-B 即使知道 revision=2，但由于已被 agent-A 占用且状态为 running -> 抛出 TaskAlreadyOwnedError 或 TaskInvalidStateTransitionError
    assert.throws(
      () => taskManager.claimTask("t1", "agent-B", 2),
      TaskInvalidStateTransitionError
    );
  });

  it("6. Task block/unblock, cancel 与 EventBus 事件发布", () => {
    const eventBus = new EventBus();
    const emittedEvents: string[] = [];
    eventBus.subscribe("*", (e) => {
      emittedEvents.push(e.type);
    });

    const taskManager = new TaskManager({ eventBus });

    taskManager.createTask({ id: "t1", subject: "t1" });
    assert(emittedEvents.includes("task.created"));
    assert(emittedEvents.includes("task.ready"));

    taskManager.claimTask("t1", "agent-x");
    assert(emittedEvents.includes("task.started"));

    taskManager.blockTask("t1", "network issue");
    assert(emittedEvents.includes("task.blocked"));

    taskManager.cancelTask("t1", "no longer needed");
    assert(emittedEvents.includes("task.cancelled"));
  });

  it("7. TaskGraph.getTopologicalOrder 能够正确计算执行顺序", () => {
    const taskManager = new TaskManager();
    taskManager.createTasks([
      { id: "D", subject: "D", dependencies: ["B", "C"] },
      { id: "B", subject: "B", dependencies: ["A"] },
      { id: "A", subject: "A" },
      { id: "C", subject: "C", dependencies: ["A"] },
    ]);

    const order = TaskGraph.getTopologicalOrder(taskManager.getTasks());
    assert.equal(order[0], "A");
    assert(order.indexOf("B") > order.indexOf("A"));
    assert(order.indexOf("C") > order.indexOf("A"));
    assert(order.indexOf("D") > order.indexOf("B"));
    assert(order.indexOf("D") > order.indexOf("C"));
  });
});
