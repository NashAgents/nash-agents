import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { ScheduleTriggerEngine } from "../src/cluster/scheduled/schedule-trigger-engine.js";
import { createScheduledAgentTools } from "../src/cluster/scheduled/scheduled-tools.js";

function setupTools() {
  const store = new InMemoryClusterStore();
  const dispatched: any[] = [];
  const scheduler = {
    dispatched,
    async createTask(opts: any) {
      const taskId = `task-${Date.now()}`;
      dispatched.push({ taskId, ...opts });
      return { taskId, status: "created", ...opts };
    },
  };
  const engine = new ScheduleTriggerEngine({
    store,
    scheduler: scheduler as any,
    coordinatorNodeId: "coord-test",
  });
  const toolsList = createScheduledAgentTools({
    store,
    engine,
    coordinatorNodeId: "coord-test",
  });
  const tools = new Map(toolsList.map((t) => [t.name, t]));
  return { store, engine, tools, dispatched };
}

describe("Coordinator Scheduled Task Tools (All 9 Tools)", () => {
  test("create_scheduled_task: 支持创建 Cron 与自然周期计划", async () => {
    const { tools, store } = setupTools();
    const createTool = tools.get("create_scheduled_task")!;

    const result: any = await createTool.execute({
      name: "WSL2字幕巡检",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      goal: "检查字幕转换服务与CUDA",
      nodeId: "node-wsl2-gpu",
      projectId: "offline-subtitles",
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.name, "WSL2字幕巡检");
    assert.ok(result.scheduledTaskId);
    assert.strictEqual(result.targetNodeId, "node-wsl2-gpu");

    // 检查 store 持久化
    const saved = await store.getScheduledTask(result.scheduledTaskId);
    assert.ok(saved);
    assert.strictEqual(saved?.taskConfig?.goal, "检查字幕转换服务与CUDA");
    assert.strictEqual(saved?.taskConfig?.nodeId, "node-wsl2-gpu");
  });

  test("list_scheduled_tasks & get_scheduled_task: 查询列表与详情", async () => {
    const { tools } = setupTools();
    const createTool = tools.get("create_scheduled_task")!;
    const listTool = tools.get("list_scheduled_tasks")!;
    const getTool = tools.get("get_scheduled_task")!;

    const created: any = await createTool.execute({
      name: "Tencent节点健康检查",
      triggerType: "interval",
      intervalMs: 3600000,
      goal: "检查 Docker 与内存",
    });

    const listRes: any = await listTool.execute({});
    assert.strictEqual(listRes.total, 1);
    assert.strictEqual(listRes.tasks[0].id, created.scheduledTaskId);

    const getRes: any = await getTool.execute({ scheduledTaskId: created.scheduledTaskId });
    assert.strictEqual(getRes.id, created.scheduledTaskId);
    assert.strictEqual(getRes.intervalMs, 3600000);
  });

  test("update_scheduled_task: 修改时间与目标", async () => {
    const { tools, store } = setupTools();
    const createTool = tools.get("create_scheduled_task")!;
    const updateTool = tools.get("update_scheduled_task")!;

    const created: any = await createTool.execute({
      name: "原始任务",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      goal: "每天9点检查",
    });

    // 用户说“刚才那个改成每天10点”
    const updateRes: any = await updateTool.execute({
      scheduledTaskId: created.scheduledTaskId,
      cronExpression: "0 10 * * *",
      goal: "每天10点检查",
    });

    assert.strictEqual(updateRes.success, true);
    const updated = await store.getScheduledTask(created.scheduledTaskId);
    assert.strictEqual(updated?.cronExpression, "0 10 * * *");
    assert.strictEqual(updated?.taskConfig?.goal, "每天10点检查");
  });

  test("pause_scheduled_task & resume_scheduled_task: 暂停与恢复", async () => {
    const { tools, store } = setupTools();
    const createTool = tools.get("create_scheduled_task")!;
    const pauseTool = tools.get("pause_scheduled_task")!;
    const resumeTool = tools.get("resume_scheduled_task")!;

    const created: any = await createTool.execute({
      name: "待暂停任务",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      goal: "目标",
    });

    // 暂停
    const pauseRes: any = await pauseTool.execute({ scheduledTaskId: created.scheduledTaskId });
    assert.strictEqual(pauseRes.status, "paused");
    let task = await store.getScheduledTask(created.scheduledTaskId);
    assert.strictEqual(task?.enabled, false);

    // 恢复
    const resumeRes: any = await resumeTool.execute({ scheduledTaskId: created.scheduledTaskId });
    assert.strictEqual(resumeRes.status, "active");
    task = await store.getScheduledTask(created.scheduledTaskId);
    assert.strictEqual(task?.enabled, true);
    assert.ok(task?.nextRunAt);
  });

  test("run_scheduled_task_now & get_scheduled_task_history: 立即执行并查历史", async () => {
    const { tools, store } = setupTools();
    const createTool = tools.get("create_scheduled_task")!;
    const runNowTool = tools.get("run_scheduled_task_now")!;
    const historyTool = tools.get("get_scheduled_task_history")!;

    const created: any = await createTool.execute({
      name: "测试立即执行",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      goal: "立即执行测试",
    });

    const runRes: any = await runNowTool.execute({ scheduledTaskId: created.scheduledTaskId });
    assert.strictEqual(runRes.success, true);
    assert.ok(runRes.runId);

    const histRes: any = await historyTool.execute({ scheduledTaskId: created.scheduledTaskId });
    assert.strictEqual(histRes.totalRuns, 1);
    assert.strictEqual(histRes.history[0].runId, runRes.runId);
  });

  test("delete_scheduled_task: 永久删除", async () => {
    const { tools, store } = setupTools();
    const createTool = tools.get("create_scheduled_task")!;
    const deleteTool = tools.get("delete_scheduled_task")!;

    const created: any = await createTool.execute({
      name: "将被删除的任务",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      goal: "删除",
    });

    const delRes: any = await deleteTool.execute({ scheduledTaskId: created.scheduledTaskId });
    assert.strictEqual(delRes.success, true);

    const check = await store.getScheduledTask(created.scheduledTaskId);
    assert.strictEqual(check, null);
  });
});
