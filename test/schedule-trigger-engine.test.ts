import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ScheduleTriggerEngine } from "../src/cluster/scheduled/schedule-trigger-engine.js";
import { InMemoryClusterStore, type ScheduledTaskRecord } from "../src/cluster/storage/cluster-store.js";
import { EventBus } from "../src/observability/event-bus.js";

function createMockScheduler() {
  const dispatched: any[] = [];
  return {
    dispatched,
    async createTask(opts: any) {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      dispatched.push({ taskId, ...opts });
      return {
        taskId,
        nodeId: opts.nodeId,
        projectId: opts.projectId,
        goal: opts.goal,
        prompt: opts.prompt,
        status: "created",
        dispatchAttempt: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
  };
}

describe("ScheduleTriggerEngine Core Lifecycle & Concurrency Policies", () => {
  test("引擎启动能自动计算并到期触发任务", async () => {
    const store = new InMemoryClusterStore();
    const scheduler = createMockScheduler();
    const eventBus = new EventBus();

    const engine = new ScheduleTriggerEngine({
      store,
      scheduler: scheduler as any,
      coordinatorNodeId: "test-coord",
      eventBus,
      misfireThresholdMs: 60000,
    });

    const now = Date.now();
    const task: ScheduledTaskRecord = {
      id: "sched-1",
      name: "测试定期巡检",
      description: "检查节点状态",
      enabled: true,
      triggerType: "interval",
      intervalMs: 1000,
      nextRunAt: now - 100, // 故意设置为已到期
      targetType: "single_task",
      taskConfig: { goal: "检查状态", nodeId: "worker-1", projectId: "test-proj" },
      concurrencyPolicy: "SKIP_IF_RUNNING",
      misfirePolicy: "RUN_ONCE_IMMEDIATELY",
      maxConcurrency: 1,
      runCount: 0,
      createdBy: "test",
      createdAt: now,
      updatedAt: now,
    };

    await store.saveScheduledTask(task);
    await engine.start();

    // 等待引擎完成初始 tick
    await new Promise((resolve) => setTimeout(resolve, 300));

    // 验证 scheduler 是否被调用
    assert.strictEqual(scheduler.dispatched.length, 1);
    assert.strictEqual(scheduler.dispatched[0].goal, "检查状态");
    assert.strictEqual(scheduler.dispatched[0].nodeId, "worker-1");

    // 验证执行历史记录
    const runs = await store.listScheduledTaskRuns("sched-1");
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].status, "running");
    assert.strictEqual(runs[0].taskId, scheduler.dispatched[0].taskId);

    // 模拟底层任务完成事件，验证状态回写
    eventBus.emit({
      id: "ev-1",
      type: "task.completed" as any,
      timestamp: new Date().toISOString(),
      projectId: "test-proj",
      sessionId: "test-session",
      data: { taskId: runs[0].taskId, resultSummary: "巡检全部正常，无异常" },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const updatedRuns = await store.listScheduledTaskRuns("sched-1");
    assert.strictEqual(updatedRuns[0].status, "completed");
    assert.strictEqual(updatedRuns[0].resultSummary, "巡检全部正常，无异常");

    engine.stop();
  });

  test("SKIP_IF_RUNNING 策略：上一次未完成时跳过并记录 skipped", async () => {
    const store = new InMemoryClusterStore();
    const scheduler = createMockScheduler();

    const engine = new ScheduleTriggerEngine({
      store,
      scheduler: scheduler as any,
      coordinatorNodeId: "test-coord",
      misfireThresholdMs: 60000,
    });

    const now = Date.now();
    const task: ScheduledTaskRecord = {
      id: "sched-skip-test",
      name: "长耗时任务",
      description: "长任务",
      enabled: true,
      triggerType: "interval",
      intervalMs: 100,
      nextRunAt: now - 50,
      targetType: "single_task",
      taskConfig: { goal: "跑很久的任务" },
      concurrencyPolicy: "SKIP_IF_RUNNING",
      misfirePolicy: "RUN_ONCE_IMMEDIATELY",
      maxConcurrency: 1,
      runCount: 0,
      createdBy: "test",
      createdAt: now,
      updatedAt: now,
    };

    await store.saveScheduledTask(task);
    await engine.start();

    // 等待第一次触发
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(scheduler.dispatched.length, 1);

    // 强行把下一次触发时间提前至当前，触发第二次调度
    await store.updateScheduledTask("sched-skip-test", { nextRunAt: Date.now() - 10 });
    await engine.reschedule();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 第二次应该被跳过，scheduler 仍然只有 1 次派发
    assert.strictEqual(scheduler.dispatched.length, 1);

    // 执行历史中应当出现 skipped 记录
    const runs = await store.listScheduledTaskRuns("sched-skip-test");
    const skipped = runs.find((r) => r.status === "skipped");
    assert.ok(skipped, "应该有一条 skipped 状态的运行记录");
    assert.strictEqual(skipped?.skipReason, "concurrency_skip");

    engine.stop();
  });

  test("手动立即执行 runNow 触发单次派发，且不破坏自然周期下一次执行时间", async () => {
    const store = new InMemoryClusterStore();
    const scheduler = createMockScheduler();

    const engine = new ScheduleTriggerEngine({
      store,
      scheduler: scheduler as any,
      coordinatorNodeId: "test-coord",
    });

    const futureTime = Date.now() + 1000000;
    const task: ScheduledTaskRecord = {
      id: "sched-run-now",
      name: "未来任务",
      description: "在遥远的未来执行",
      enabled: true,
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      nextRunAt: futureTime,
      targetType: "single_task",
      taskConfig: { goal: "测试手动运行" },
      concurrencyPolicy: "SKIP_IF_RUNNING",
      misfirePolicy: "RUN_ONCE_IMMEDIATELY",
      maxConcurrency: 1,
      runCount: 0,
      createdBy: "test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.saveScheduledTask(task);
    await engine.start();

    // 立即执行一次
    const run = await engine.runNow("sched-run-now");
    assert.ok(run.id);
    assert.strictEqual(run.status, "running");
    assert.strictEqual(scheduler.dispatched.length, 1);

    // 检查原定时计划的 nextRunAt 是否依然保持在遥远的未来
    const checkTask = await store.getScheduledTask("sched-run-now");
    assert.strictEqual(checkTask?.nextRunAt, futureTime, "runNow 绝不能篡改原本计划的自然下次时间");

    engine.stop();
  });
});
