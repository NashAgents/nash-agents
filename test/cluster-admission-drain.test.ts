import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { AdmissionControl, AdmissionFrozenError } from "../src/cluster/coordinator/admission-control.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";
import type { NodeDrainStatusPayload } from "../src/cluster/protocol/types.js";
import { registerFixtureNodes } from "./helpers/registered-node.js";

function fakeRegistry(nodeIds: string[]) {
  return {
    listOnlineConnections: () => nodeIds.map((nodeId) => ({
      nodeId, generation: 1, ws: {} as any, connectedAt: 1, lastHeartbeatAt: 1,
      metadata: { nodeId, name: nodeId, role: "worker" },
    })),
  } as any;
}

function fakeGateway(responder: (nodeId: string) => NodeDrainStatusPayload | null) {
  return { probeDrainStatus: async (nodeId: string) => responder(nodeId) } as any;
}

function drainStatus(nodeId: string, activeTaskIds: string[] = [], pendingDispatches = 0): NodeDrainStatusPayload {
  return { nodeId, probeId: "probe", activeRuns: activeTaskIds.length, activeTaskIds, pendingDispatches, acceptingTasks: false, respondingAt: Date.now() };
}

async function seedTask(store: InMemoryClusterStore, taskId: string, status: "running" | "completed" = "running", nodeId = "worker-1") {
  await store.saveTask({ taskId, nodeId, projectId: "p", goal: "g", prompt: "p", status, dispatchAttempt: 1, createdAt: 1, updatedAt: 1 });
}

test("admission never reports readyToStop without an explicit freeze", async () => {
  const store = new InMemoryClusterStore();
  const admission = new AdmissionControl({ store, registry: fakeRegistry(["worker-1"]), gateway: fakeGateway(id => drainStatus(id)) });
  const first = await admission.snapshot();
  assert.equal(first.settled, true);
  assert.equal(first.frozen, false);
  assert.equal(first.readyToStop, false, "settled without a freeze does not authorize a stop");
});

test("drain requires two consecutive settled probes and a live worker round-trip", async () => {
  const store = new InMemoryClusterStore();
  let active: string[] = [];
  const admission = new AdmissionControl({ store, registry: fakeRegistry(["worker-1"]), gateway: fakeGateway(id => drainStatus(id, active)) });
  admission.freeze("test", "drain");
  const first = await admission.snapshot();
  assert.equal(first.settled, true);
  assert.equal(first.settledStreak, 1);
  assert.equal(first.readyToStop, false, "a single settled probe may race an in-flight dispatch");
  const second = await admission.snapshot();
  assert.equal(second.readyToStop, true);
  assert.equal(second.nodes[0]?.reachable, true);

  active = ["task-late"];
  const third = await admission.snapshot();
  assert.equal(third.settled, false);
  assert.equal(third.settledStreak, 0, "a task observed really running resets the streak");
  assert.match(third.unsettledReasons.join(";"), /node worker-1 runs 1 task/);
});

test("a node that cannot answer the drain probe is never treated as settled", async () => {
  const store = new InMemoryClusterStore();
  const admission = new AdmissionControl({ store, registry: fakeRegistry(["worker-1"]), gateway: fakeGateway(() => null) });
  admission.freeze("test");
  const snapshot = await admission.snapshot();
  assert.equal(snapshot.settled, false);
  assert.equal(snapshot.nodes[0]?.reachable, false);
  assert.match(snapshot.unsettledReasons.join(";"), /could not prove drain/);
});

test("drain snapshot surfaces active tasks, pending approvals and live turns", async () => {
  const store = new InMemoryClusterStore();
  await seedTask(store, "task-live");
  await store.saveApproval({ approvalId: "appr-1", taskId: "task-live", runId: "run-1", nodeId: "worker-1", agentId: "a", capability: "c", reason: "r", status: "pending", requestedAt: 1, expiresAt: Date.now() + 60_000 });
  const admission = new AdmissionControl({
    store, registry: fakeRegistry(["worker-1"]), gateway: fakeGateway(id => drainStatus(id)),
    liveTurns: () => ["conv-1"],
  });
  admission.freeze("test");
  const snapshot = await admission.snapshot();
  assert.equal(snapshot.settled, false);
  assert.deepEqual(snapshot.coordinator.pendingApprovals, ["appr-1"]);
  assert.deepEqual(snapshot.coordinator.liveTurns, ["conv-1"]);
  assert.deepEqual(snapshot.coordinator.activeTasks.map(task => task.taskId), ["task-live"]);
  const reasons = snapshot.unsettledReasons.join(";");
  assert.match(reasons, /1 live coordinator turn/);
  assert.match(reasons, /1 active task/);
  assert.match(reasons, /1 pending approval/);
});

test("waitForSettled keeps polling until the required consecutive proofs arrive", async () => {
  const store = new InMemoryClusterStore();
  let active: string[] = ["task-1"];
  const admission = new AdmissionControl({ store, registry: fakeRegistry(["worker-1"]), gateway: fakeGateway(id => drainStatus(id, active)) });
  admission.freeze("test", "wait");
  setTimeout(() => { active = []; }, 50);
  const snapshot = await admission.waitForSettled({ timeoutMs: 5000, pollMs: 25, consecutive: 2 });
  assert.equal(snapshot.readyToStop, true);
  assert.ok(snapshot.settledStreak >= 2);
});

test("waitForSettled returns an honest timeout snapshot instead of claiming success", async () => {
  const store = new InMemoryClusterStore();
  const admission = new AdmissionControl({ store, registry: fakeRegistry(["worker-1"]), gateway: fakeGateway(id => drainStatus(id, ["task-stuck"])) });
  admission.freeze("test");
  const snapshot = await admission.waitForSettled({ timeoutMs: 120, pollMs: 20, consecutive: 2 });
  assert.equal(snapshot.settled, false);
  assert.equal(snapshot.readyToStop, false);
  assert.match(snapshot.unsettledReasons.join(";"), /task-stuck|runs 1 task/);
});

test("freeze rejects new work through the explicit admission assertion", async () => {
  const store = new InMemoryClusterStore();
  const admission = new AdmissionControl({ store, registry: fakeRegistry([]) });
  admission.assertAdmitting("task creation");
  admission.freeze("operator", "maintenance");
  assert.throws(() => admission.assertAdmitting("task creation"), AdmissionFrozenError);
  admission.unfreeze();
  admission.assertAdmitting("task creation");
});

test("task scheduler refuses to create tasks while admission is frozen", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker-1");
  let frozen = false;
  const scheduler = new TaskScheduler(store, { getConnection: () => undefined } as any, "coord", 100, () => true, () => frozen);
  frozen = true;
  await assert.rejects(
    scheduler.createTask({ nodeId: "worker-1", projectId: "p", goal: "g" }),
    /ADMISSION_FROZEN/,
  );
  frozen = false;
  const task = await scheduler.createTask({ nodeId: "worker-1", projectId: "p", goal: "g" });
  assert.ok(["created", "queued"].includes(task.status), "an unfrozen scheduler admits the task");
});

test("outbox flush stops dispatching tasks while frozen but keeps delivering approvals", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker-1");
  const sent: string[] = [];
  const registry = {
    getConnection: (nodeId: string) => nodeId === "worker-1" ? { nodeId, generation: 1, ws: { readyState: 1, send: (raw: string) => sent.push(raw) } } : undefined,
    listOnlineConnections: () => [],
  } as any;
  let frozen = false;
  const scheduler = new TaskScheduler(store, registry, "coord", 100, () => true, () => frozen);
  const task = await scheduler.createTask({ nodeId: "worker-1", projectId: "p", goal: "g" });
  sent.length = 0;

  frozen = true;
  await store.enqueueOutbox({ targetNodeId: "worker-1", messageId: "msg-approval", messageType: "approval.resolved", payload: { approvalId: "appr-1", taskId: task.taskId, runId: task.runId, decision: "allow-once", resolvedAt: Date.now(), resolvedBy: "admin" }, status: "pending", attempts: 0, nextRetryAt: 0, createdAt: Date.now() });
  await store.saveApproval({ approvalId: "appr-1", taskId: task.taskId, runId: task.runId!, nodeId: "worker-1", agentId: "a", capability: "c", reason: "r", status: "resolved", decision: "allow-once", requestedAt: Date.now(), expiresAt: Date.now() + 60_000, resolvedAt: Date.now(), resolvedBy: "admin" });
  await scheduler.flushOutbox();
  assert.ok(!sent.some(raw => raw.includes("task.dispatch")), "no task.dispatch may reach a worker during a drain");
  assert.ok(sent.some(raw => raw.includes("approval.resolved")), "in-flight work still needs its approval decisions");

  frozen = false;
  // 新调度器实例 = 清空重试退避，验证冻结解除后确实恢复分发。
  const resumed = new TaskScheduler(store, registry, "coord", 100, () => true, () => frozen);
  await resumed.flushOutbox();
  assert.ok(sent.some(raw => raw.includes("task.dispatch")), "dispatch resumes after unfreeze");
});

test("goal turn leases are only released by their own generation", async () => {
  const store = new InMemoryClusterStore();
  await store.saveConversation({ id: "c", title: "t", createdAt: 1, updatedAt: 1, messages: [{ id: "u", conversationId: "c", sender: "user", content: "g", messageType: "text", timestamp: 1, metadata: { goalRunId: "g" } }] });
  await store.createGoalRun({ goalRunId: "g", conversationId: "c", userMessageId: "u", rootGoal: "g", status: "planning", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  const lease = (await store.claimGoalTurnLease("g", "u", "owner-1", 60_000))!;
  assert.equal(await store.releaseGoalTurnLease("g", "other-owner", lease.generation), false);
  if (!store.releaseGoalTurnLease) throw new Error("missing releaseGoalTurnLease");
  assert.equal(await store.releaseGoalTurnLease("g", "owner-1", lease.generation), true);
  assert.equal((await store.getGoalRun("g"))?.turnLease, undefined, "a normal turn exit must hand the lease back immediately");
  const newer = (await store.claimGoalTurnLease("g", "u", "owner-2", 60_000))!;
  assert.equal(await store.releaseGoalTurnLease("g", "owner-1", lease.generation), false, "a superseded owner must not clear the new lease");
  assert.ok((await store.getGoalRun("g"))?.turnLease, "the new generation still owns the lease");
  assert.equal(await store.releaseGoalTurnLease("g", "owner-2", newer.generation), true);
  assert.equal((await store.getGoalRun("g"))?.turnLease, undefined);
});
