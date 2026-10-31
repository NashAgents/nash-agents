import { registerFixtureNodes } from "./helpers/registered-node.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import type { ClusterTaskRecord } from "../src/cluster/storage/cluster-store-types.js";
import { TaskSupervisor } from "../src/cluster/coordinator/task-supervisor.js";
import type { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { DispatchClusterTaskTool } from "../src/cluster/tools/cluster-tools.js";
import { AutonomousDiscoveryService } from "../src/cluster/discovery/autonomous-discovery-service.js";
import { EventBus } from "../src/observability/event-bus.js";

const ONLINE = { getConnection: () => ({ generation: 1 }) } as unknown as NodeRegistry;

const baseTask = (overrides: Partial<ClusterTaskRecord> = {}): ClusterTaskRecord => ({
  taskId: `t-${Math.random().toString(16).slice(2, 10)}`,
  runId: "r",
  nodeId: "worker",
  projectId: "p",
  goal: "goal",
  status: "running",
  dispatchAttempt: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

async function seededStore(task: ClusterTaskRecord): Promise<InMemoryClusterStore> {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  await store.saveTask(task);
  return store;
}

test("A2A 不得用墙钟杀死仍在工作的 Agent：超长运行任务不被 Supervisor 终止", async () => {
  // 一天前创建、仍在 running 的任务：Worker 自有预算才是唯一裁决者。
  const task = baseTask({ status: "running", createdAt: Date.now() - 86_400_000, updatedAt: Date.now() });
  const store = await seededStore(task);
  const cancels: string[] = [];
  const supervisor = new TaskSupervisor(store, ONLINE, 1000, {
    sendControl: async (taskId: string) => { cancels.push(taskId); return { success: true }; },
  } as never);

  await supervisor.superviseTasks();

  assert.deepEqual(cancels, [], "running task must not be cancelled by A2A wall clock");
  assert.equal((await store.getTask(task.taskId))?.status, "running");
});

test("等待人工审批不计入任何任务预算：Supervisor 跳过 waiting_approval", async () => {
  const task = baseTask({ status: "waiting_approval", createdAt: Date.now() - 86_400_000, timeoutMs: 1000 });
  const store = await seededStore(task);
  const cancels: string[] = [];
  const supervisor = new TaskSupervisor(store, ONLINE, 1000, {
    sendControl: async (taskId: string) => { cancels.push(taskId); return { success: true }; },
  } as never);

  await supervisor.superviseTasks();

  assert.deepEqual(cancels, []);
  assert.equal((await store.getTask(task.taskId))?.status, "waiting_approval");
});

test("派发后从未被 Worker 接受的任务仍会被回收", async () => {
  const task = baseTask({ status: "dispatched", createdAt: Date.now() - 60_000 });
  const store = await seededStore(task);
  const cancels: string[] = [];
  const supervisor = new TaskSupervisor(store, ONLINE, 1000, {
    sendControl: async (taskId: string) => { cancels.push(taskId); return { success: true }; },
  } as never);

  await supervisor.superviseTasks();

  assert.deepEqual(cancels, [task.taskId]);
  assert.equal((await store.getTask(task.taskId))?.status, "cancelling");
});

test("Worker 掉线仍收敛为 outcome_unknown，绝不自动重派", async () => {
  const task = baseTask({ status: "running" });
  const store = await seededStore(task);
  const offline = { getConnection: () => undefined } as unknown as NodeRegistry;
  const supervisor = new TaskSupervisor(store, offline, 1000, { sendControl: async () => ({ success: true }) } as never);

  await supervisor.superviseTasks();

  const stored = await store.getTask(task.taskId);
  assert.equal(stored?.status, "outcome_unknown");
  assert.match(String(stored?.error), /Outcome is unknown/);
});

test("dispatch_cluster_task 的前台等待窗口不再变成 Worker 的硬执行预算", async () => {
  const captured: Array<{ timeoutMs?: number }> = [];
  const router = {
    runAutonomous: async (_goal: string, options: { constraints?: { timeoutMs?: number } }) => {
      captured.push({ timeoutMs: options.constraints?.timeoutMs });
      return {
        decision: { decisionType: "DISPATCH" },
        validation: { valid: true, reason: "" },
        dispatchResult: { success: true, taskId: "t-1", nodeId: "worker", projectId: "p", status: "queued" },
      };
    },
  } as never;

  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  await store.saveTask(baseTask({ taskId: "t-1", status: "completed", finalAnswer: "done" }));

  const tool = new DispatchClusterTaskTool(router, store);
  // 调用方只想要 3 分钟前台等待，绝不能让 Worker 内的 Agent 3 分钟必死。
  const result = await tool.execute({ goal: "long job", timeoutMs: 180_000 });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.timeoutMs, undefined, "wait window must not be forwarded as the worker run budget");
  assert.equal((result as { taskId?: string }).taskId, "t-1");
});

test("显式 taskTimeoutMs 才会成为 Worker 执行预算", async () => {
  const captured: Array<{ timeoutMs?: number }> = [];
  const router = {
    runAutonomous: async (_goal: string, options: { constraints?: { timeoutMs?: number } }) => {
      captured.push({ timeoutMs: options.constraints?.timeoutMs });
      return {
        decision: { decisionType: "DISPATCH" },
        validation: { valid: true, reason: "" },
        dispatchResult: { success: true, taskId: "t-2", nodeId: "worker", projectId: "p", status: "queued" },
      };
    },
  } as never;

  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  await store.saveTask(baseTask({ taskId: "t-2", status: "completed", finalAnswer: "done" }));

  const tool = new DispatchClusterTaskTool(router, store);
  await tool.execute({ goal: "long job", taskTimeoutMs: 900_000, waitTimeoutMs: 5_000 });

  assert.equal(captured[0]!.timeoutMs, 900_000);
});

/**
 * Scout 结论语义：前台等待超时绝不能被呈现为「扫描完成、没有发现」。
 */
test("Scout 前台等待超时如实返回 timed_out，而不是空候选的假成功", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  const registry = { getConnection: () => ({ generation: 1 }) } as unknown as NodeRegistry;
  const created: string[] = [];
  const scheduler = {
    createTask: async (input: { nodeId: string; projectId: string; goal: string; timeoutMs?: number }) => {
      const taskId = `t-${created.length}`;
      created.push(taskId);
      await store.saveTask(baseTask({ taskId, nodeId: input.nodeId, projectId: input.projectId, goal: input.goal, status: "running" }));
      return { taskId, runId: "r", nodeId: input.nodeId, projectId: input.projectId, goal: input.goal, status: "running", dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now() };
    },
    sendControl: async () => ({ success: true }),
  } as never;

  const eventBus = new EventBus(); const events: any[] = []; eventBus.subscribe("*", event => { events.push(event); });
  const service = new AutonomousDiscoveryService({ store, registry, scheduler, eventBus });
  const result = await service.discover("knowledge base projects", { nodeIds: ["worker"], scoutTimeoutMs: 60 });

  assert.equal(result.scoutReports.length, 1);
  const report = result.scoutReports[0]!;
  assert.equal(report.nodeId, "worker");
  assert.equal(report.outcome, "timed_out");
  assert.equal(report.stillRunning, true);
  assert.equal(report.candidates.length, 0);
  assert.match(report.summary, /still running/i);
  assert.ok(events.some(event => event.type === "discovery.scout_wait_expired" && event.data.taskId === report.taskId));
  assert.equal(events.some(event => event.type === "discovery.scout_completed"), false);
});

test("Scout 任务真实失败时返回 failed，不伪装成无候选的成功扫描", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  const registry = { getConnection: () => ({ generation: 1 }) } as unknown as NodeRegistry;
  const scheduler = {
    createTask: async (input: { nodeId: string; projectId: string; goal: string }) => {
      const taskId = "t-failed";
      await store.saveTask(baseTask({ taskId, nodeId: input.nodeId, projectId: input.projectId, goal: input.goal, status: "failed", error: "sandbox unavailable" }));
      return { taskId, runId: "r", nodeId: input.nodeId, projectId: input.projectId, goal: input.goal, status: "running", dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now() };
    },
    sendControl: async () => ({ success: true }),
  } as never;

  const service = new AutonomousDiscoveryService({ store, registry, scheduler });
  const result = await service.discover("knowledge base projects", { nodeIds: ["worker"], scoutTimeoutMs: 2000 });

  const report = result.scoutReports[0]!;
  assert.equal(report.outcome, "failed");
  assert.equal(report.stillRunning, undefined);
  assert.match(String(report.error), /sandbox unavailable/);
});

test("Scout outcome_unknown is reported immediately without dispatching a retry", async (t) => {
  const store = new InMemoryClusterStore(); await registerFixtureNodes(store, "worker");
  const eventBus = new EventBus();
  t.after(() => eventBus.clear());
  const events: any[] = [];
  eventBus.subscribe("*", event => { events.push(event); });
  let dispatches = 0;
  const scheduler = { createTask: async () => {
    dispatches++;
    const task = baseTask({ taskId: "t-unknown", status: "outcome_unknown", error: "worker disconnected" });
    await store.saveTask(task); return task;
  } } as never;
  const result = await new AutonomousDiscoveryService({ store, registry: ONLINE, scheduler, eventBus }).discover("knowledge base", { nodeIds: ["worker"], scoutTimeoutMs: 2000 });
  assert.equal(result.scoutReports[0]?.outcome, "outcome_unknown");
  assert.equal(dispatches, 1);
  assert.deepEqual(result.aggregatedCandidates, []);
  assert.ok(events.some(event => event.type === "discovery.scout_outcome_unknown"));
  assert.ok(events.some(event => event.type === "discovery.completed" && event.data.status === "outcome_unknown"));
  assert.equal(events.some(event => event.type === "discovery.scout_completed"), false);
});

test("completed Scout cannot promote model text or a different run's receipt into coverage", async () => {
  const store = new InMemoryClusterStore(); await registerFixtureNodes(store, "worker");
  const scheduler = { createTask: async () => {
    const task = baseTask({ taskId: "t-untrusted", status: "completed", finalAnswer: JSON.stringify({ candidates: [{ projectName: "invented", canonicalPath: "/invented", evidences: [{ matchedContent: "plausible text" }] }] }) });
    await store.saveTask(task);
    await store.appendEvents([{ taskId: task.taskId, runId: "other", nodeId: "worker", seq: 1, timestamp: Date.now(), eventType: "discovery.report_persisted", data: { report: { nodeId: "worker", candidates: [] } } }]);
    return task;
  } } as never;
  const result = await new AutonomousDiscoveryService({ store, registry: ONLINE, scheduler }).discover("knowledge base", { nodeIds: ["worker"], scoutTimeoutMs: 2000 });
  assert.equal(result.scoutReports[0]?.outcome, "failed");
  assert.deepEqual(result.aggregatedCandidates, []);
  assert.equal((await store.listProjectsCatalog()).length, 0);
});

test("authenticated Scout receipt remains partial until its search scope is verified", async () => {
  const store = new InMemoryClusterStore(); await registerFixtureNodes(store, "worker");
  const scheduler = { createTask: async () => {
    const task = baseTask({ taskId: "t-receipt", status: "completed" });
    await store.saveTask(task);
    await store.appendEvents([{ taskId: task.taskId, runId: task.runId!, nodeId: task.nodeId, seq: 1, timestamp: Date.now(), eventType: "discovery.report_persisted", data: { report: { nodeId: "worker", candidates: [], investigatedPaths: ["/bounded"], investigatedMcpServers: [], summary: "bounded inspection" } } }]);
    return task;
  } } as never;
  const result = await new AutonomousDiscoveryService({ store, registry: ONLINE, scheduler }).discover("knowledge base", { nodeIds: ["worker"], scoutTimeoutMs: 2000 });
  assert.equal(result.scoutReports[0]?.outcome, "partial");
  assert.deepEqual(result.scoutReports[0]?.investigatedPaths, ["/bounded"]);
  assert.deepEqual(result.aggregatedCandidates, []);
});

test("missing scheduler never probes the Coordinator filesystem under a Worker identity", async () => {
  const store = new InMemoryClusterStore(); await registerFixtureNodes(store, "worker");
  const result = await new AutonomousDiscoveryService({ store, registry: ONLINE }).discover("knowledge base", { nodeIds: ["worker"], scoutTimeoutMs: 2000 });
  assert.equal(result.scoutReports[0]?.outcome, "failed");
  assert.match(result.scoutReports[0]?.error ?? "", /refusing to probe Coordinator filesystem/);
  assert.deepEqual(result.aggregatedCandidates, []);
});

test("CLI 兜底 Coordinator 地址必须与 Coordinator 默认监听端口一致", async () => {
  const { DEFAULT_COORDINATOR_URL } = await import("../src/cluster/cli/cluster-commands.js");
  assert.equal(DEFAULT_COORDINATOR_URL, "http://127.0.0.1:18443");
});
