import { registerFixtureNodes } from "./helpers/registered-node.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryClusterStore, CLUSTER_TASK_TERMINAL } from "../src/cluster/storage/cluster-store.js";
import type { ClusterTaskRecord, ClusterTaskStatus } from "../src/cluster/storage/cluster-store-types.js";
import { TaskSupervisor } from "../src/cluster/coordinator/task-supervisor.js";
import type { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";

const ONLINE = { getConnection: () => ({ generation: 1 }) } as unknown as NodeRegistry;
const OFFLINE = { getConnection: () => undefined } as unknown as NodeRegistry;

const baseTask = (overrides: Partial<ClusterTaskRecord> = {}): ClusterTaskRecord => ({
  taskId: `t-${Math.random().toString(16).slice(2, 10)}`,
  runId: "r",
  nodeId: "worker",
  projectId: "p",
  goal: "goal",
  status: "dispatched",
  dispatchAttempt: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

async function seededStore(...tasks: ClusterTaskRecord[]): Promise<InMemoryClusterStore> {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  for (const task of tasks) await store.saveTask(task);
  return store;
}

/** 记录调用、可配置成败的假 scheduler。 */
function fakeScheduler(result: { success: boolean } = { success: true }) {
  const calls: Array<{ taskId: string; action: string }> = [];
  const scheduler = {
    sendControl: async (taskId: string, action: string) => {
      calls.push({ taskId, action });
      return result;
    },
  };
  return { scheduler, calls };
}

test("历史 outcome_unknown 任务：Worker 在线时多轮 supervise 不产生任何 cancel 控制命令", async () => {
  const task = baseTask({
    status: "outcome_unknown",
    createdAt: Date.now() - 86_400_000,
    error: "Worker disconnected during execution. Outcome is unknown.",
  });
  const store = await seededStore(task);
  const { scheduler, calls } = fakeScheduler();
  const supervisor = new TaskSupervisor(store, ONLINE, 1000, scheduler as never);

  for (let i = 0; i < 5; i++) await supervisor.superviseTasks();

  assert.deepEqual(calls, [], "outcome_unknown 绝不能被重投 cancel");
  const stored = await store.getTask(task.taskId);
  assert.equal(stored?.status, "outcome_unknown");
  assert.match(String(stored?.error), /Outcome is unknown/);
});

test("已派发未接受的任务成功取消后只回收一次", async () => {
  const task = baseTask({ status: "dispatched", createdAt: Date.now() - 60_000 });
  const store = await seededStore(task);
  const { scheduler, calls } = fakeScheduler({ success: true });
  const supervisor = new TaskSupervisor(store, ONLINE, 1000, scheduler as never);

  for (let i = 0; i < 5; i++) await supervisor.superviseTasks();

  assert.deepEqual(calls, [{ taskId: task.taskId, action: "cancel" }]);
  assert.equal((await store.getTask(task.taskId))?.status, "cancelling");
});

test("取消投递失败时重投有上限，达到上限后停止并收敛为可审计的 outcome_unknown", async () => {
  const task = baseTask({ status: "dispatched", createdAt: Date.now() - 60_000 });
  const store = await seededStore(task);
  const { scheduler, calls } = fakeScheduler({ success: false });
  const supervisor = new TaskSupervisor(store, ONLINE, 1000, scheduler as never);

  for (let i = 0; i < 10; i++) await supervisor.superviseTasks();

  assert.equal(calls.length, 3, "最多投递 3 次，不得无限重投");
  const stored = await store.getTask(task.taskId);
  assert.equal(stored?.status, "outcome_unknown");
  assert.match(String(stored?.error), /Automatic reclaim stopped after 3 attempts/);
  assert.match(String(stored?.error), /reconciled with the worker ledger/);
});

test("重投间隔从派发死线起指数退避", async () => {
  // 死线 1000ms，已等 2500ms：仅第一次（1x = 1000ms）有资格，第二次（2x = 2000ms）尚未到点。
  const task = baseTask({ status: "dispatched", createdAt: Date.now() - 2500 });
  const store = await seededStore(task);
  const { scheduler, calls } = fakeScheduler({ success: false });
  const supervisor = new TaskSupervisor(store, ONLINE, 1000, scheduler as never);

  await supervisor.superviseTasks();
  assert.equal(calls.length, 1);
  await supervisor.superviseTasks();
  assert.equal(calls.length, 2, "2x 退避点已到，允许第二次投递");
  await supervisor.superviseTasks();
  assert.equal(calls.length, 2, "4x 退避点未到，不得投递");
});

test("终态与已收敛状态（completed/failed/cancelled/cancelling/waiting_approval）从不触发 cancel", async () => {
  const statuses: ClusterTaskStatus[] = ["completed", "failed", "cancelled", "cancelling", "waiting_approval"];
  const tasks = statuses.map((status) => baseTask({ status, createdAt: Date.now() - 86_400_000 }));
  const store = await seededStore(...tasks);
  const { scheduler, calls } = fakeScheduler({ success: true });
  const supervisor = new TaskSupervisor(store, ONLINE, 1000, scheduler as never);

  for (let i = 0; i < 3; i++) await supervisor.superviseTasks();

  assert.deepEqual(calls, []);
  for (const task of tasks) {
    assert.equal((await store.getTask(task.taskId))?.status, task.status);
  }
});

test("Worker 离线时 dispatched/accepted/running 仍收敛为 outcome_unknown", async () => {
  const tasks = (["dispatched", "accepted", "running"] as const).map((status) => baseTask({ status }));
  const store = await seededStore(...tasks);
  const { scheduler } = fakeScheduler();
  const supervisor = new TaskSupervisor(store, OFFLINE, 1000, scheduler as never);

  await supervisor.superviseTasks();

  for (const task of tasks) {
    const stored = await store.getTask(task.taskId);
    assert.equal(stored?.status, "outcome_unknown");
    assert.match(String(stored?.error), /Outcome is unknown/);
  }
});

test("TaskScheduler.sendControl 对 outcome_unknown 直接拒绝，不产生任何 WS 流量", async () => {
  const task = baseTask({ status: "outcome_unknown" });
  const store = await seededStore(task);
  const sends: unknown[] = [];
  const registry = {
    getConnection: () => ({ generation: 1, ws: { readyState: 1, send: (raw: unknown) => sends.push(raw) } }),
  } as unknown as NodeRegistry;
  const scheduler = new TaskScheduler(store, registry, "coordinator", 50);

  const result = await scheduler.sendControl(task.taskId, "cancel");

  assert.equal(result.success, false);
  assert.equal(result.status, "rejected");
  assert.equal(
    result.message,
    "Task outcome is unknown; control commands cannot be confirmed. Reconcile with the worker ledger first."
  );
  assert.deepEqual(sends, [], "不得向 Worker 发送任何控制命令");
  assert.equal((await store.getTask(task.taskId))?.status, "outcome_unknown");
});

test("outcome_unknown 不属于终态集合，晚到的真实终态仍然可以落库", async () => {
  assert.equal(CLUSTER_TASK_TERMINAL.has("outcome_unknown"), false);
  const task = baseTask({ status: "outcome_unknown" });
  const store = await seededStore(task);
  await store.updateTaskStatus(task.taskId, "completed");
  assert.equal((await store.getTask(task.taskId))?.status, "completed");
});
