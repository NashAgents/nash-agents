import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalClusterStore } from "../src/cluster/storage/local-cluster-store.js";
import { processGoalRun } from "../src/cluster/coordinator/goal-run-service.js";
import { ClusterApiHandler } from "../src/cluster/coordinator/api-server.js";
import { EventBus } from "../src/observability/event-bus.js";

test("a prior answer cannot finish a newer clarification turn", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-goal-old-answer-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createLocalClusterStore(path.join(dir, "store"));
  await store.saveConversation!({ id: "c", title: "fixture", createdAt: 1, updatedAt: 1, messages: [
    { id: "u1", conversationId: "c", sender: "user", content: "inspect", timestamp: 1 },
    { id: "a1", conversationId: "c", sender: "assistant", content: "choose", timestamp: 2, metadata: { goalRunId: "g", goalRunTurnId: "u1" } },
    { id: "u2", conversationId: "c", sender: "user", content: "choice", timestamp: 3, metadata: { goalRunId: "g" } },
  ] });
  await store.createGoalRun!({ goalRunId: "g", conversationId: "c", userMessageId: "u1", rootGoal: "inspect", status: "planning", currentStage: "planning", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 1, revision: 1, createdAt: 1, updatedAt: 1 });
  await store.claimGoalTurnLease!("g", "u2", "active", 60_000);
  const during = await processGoalRun(store, "g");
  assert.equal(during.currentStage, "planning");
  assert.equal(during.interimReport, undefined);
  assert.equal(during.finalReport, undefined);
});

test("SIMULATED_CRASH: restart takes over an unanswered turn without replaying its running scout", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-goal-owner-recovery-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "store"), before = createLocalClusterStore(file);
  const conversation = { id: "c", title: "fixture", createdAt: 1, updatedAt: 1, messages: [{ id: "u", conversationId: "c", sender: "user" as const, content: "inspect", timestamp: 1, metadata: { goalRunId: "g" } }] };
  await before.saveConversation!({ ...conversation, messages: [] });
  await before.createGoalRunWithConversation!({ goalRunId: "g", conversationId: "c", userMessageId: "u", rootGoal: "inspect", status: "planning", currentStage: "planning", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 }, conversation, { ownerId: "crashed", ttlMs: 60_000 });
  await before.saveTaskWithGoal!({ taskId: "scout", runId: "run", nodeId: "node1", projectId: "p", goal: "inspect", status: "running", dispatchAttempt: 1, createdAt: 1, updatedAt: 1, dispatchOptions: { contextOverrides: { goalRunId: "g", taskType: "scout" } } }, "g", { ownerId: "crashed", turnId: "u", generation: 1 });
  const crashed = (await before.getGoalRun!("g"))!;
  await before.updateGoalRun!({ ...crashed, turnLease: { ...crashed.turnLease!, expiresAt: 0 }, revision: crashed.revision + 1 }, crashed.revision);
  const store = createLocalClusterStore(file), eventBus = new EventBus();
  const handler = new ClusterApiHandler({ store, eventBus, scheduler: {} as any, registry: { listOnlineConnections: () => [] } as any, inviteManager: {} as any, coordinatorNodeId: "test", adminApiKey: "test" });
  t.after(() => { handler.close(); eventBus.clear(); });
  const deadline = Date.now() + 3000;
  while (!(await store.getGoalRun!("g"))?.turnRecovery && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const recovered = (await store.getGoalRun!("g"))!;
  assert.equal(recovered.turnRecovery?.turnId, "u");
  assert.equal(recovered.status, "running");
  assert.equal((await store.listTasks()).length, 1);
  assert.equal((await store.getConversation!("c"))?.messages.filter(message => message.sender === "assistant").length, 1);
  await store.updateTaskStatus("scout", "completed");
  const final = await processGoalRun(store, "g");
  assert.equal(final.status, "partially_completed");
  assert.equal(final.reportState, "ready");
  assert.match(final.finalReport!, /未完成独立核验/);
  await processGoalRun(store, "g");
  assert.equal((await store.getGoalRun!("g"))?.reportHistory?.length, 1);
});

test("background scout produces one durable partial report after the turn ends", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-goal-background-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "store");
  const store = createLocalClusterStore(file);
  await store.createGoalRun!({ goalRunId: "goal", conversationId: "conv", userMessageId: "msg", rootGoal: "inspect", status: "running", currentStage: "awaiting_verification", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1, interimReport: "Scout is running" });
  await store.saveTaskWithGoal!({ taskId: "scout", runId: "run", nodeId: "node1", projectId: "p", goal: "inspect", status: "running", dispatchAttempt: 1, createdAt: 1, updatedAt: 1, dispatchOptions: { contextOverrides: { goalRunId: "goal", taskType: "scout" } } }, "goal");
  assert.equal((await processGoalRun(store, "goal")).status, "running");
  assert.equal((await store.getGoalRun!("goal"))?.finalReport, undefined);
  await store.appendEvents([{ taskId: "scout", runId: "run", nodeId: "node1", seq: 1, timestamp: 2, eventType: "discovery.report_persisted", data: { report: { nodeId: "node1", candidates: [{ projectName: "example", canonicalPath: "/work/example", evidences: [{ sourcePath: "/work/example/README.md", matchedContent: "observed text" }] }] } } },
    { taskId: "scout", runId: "other", nodeId: "node1", seq: 2, timestamp: 3, eventType: "discovery.report_persisted", data: { report: { nodeId: "node1", candidates: [{ projectName: "wrong-run", canonicalPath: "/wrong", evidences: [{}] }] } } }]);
  await store.updateTaskStatus("scout", "completed", { finalAnswer: "unverified model text" });
  await Promise.all([processGoalRun(store, "goal"), processGoalRun(store, "goal")]);
  const restored = createLocalClusterStore(file);
  const saved = (await restored.getGoalRun!("goal"))!;
  assert.equal(saved.status, "partially_completed");
  assert.equal(saved.reportRevision, 1);
  assert.ok(saved.completedAt);
  assert.equal(saved.reportHistory?.length, 1);
  assert.match(saved.finalReport!, /范围.*尚未完成独立核验/);
  assert.doesNotMatch(saved.finalReport!, /unverified model text/);
  assert.match(saved.finalReport!, /Scout 上报候选（尚未独立核验） "example"/);
  assert.doesNotMatch(saved.finalReport!, /wrong-run/);
  assert.deepEqual(saved.reportEvidence?.scoutEvents, [{ taskId: "scout", seq: 1 }]);
  await processGoalRun(restored, "goal");
  assert.equal((await restored.getGoalRun!("goal"))?.reportRevision, 1);
  await restored.appendEvents([{ taskId: "scout", runId: "run", nodeId: "node1", seq: 3, timestamp: 4, eventType: "discovery.report_persisted", data: { report: { nodeId: "node1", candidates: [], scanReceipts: [{ authorizedRoots: ["/bounded"], scope: "bounded search", truncated: true, errors: [] }] } } }]);
  const refreshed = await processGoalRun(restored, "goal");
  assert.equal(refreshed.reportRevision, 2);
  assert.deepEqual(refreshed.reportEvidence?.scoutScans, [{ taskId: "scout", nodeId: "node1", seq: 3, authorizedRoots: ["/bounded"], scope: "bounded search", truncated: true, errorCount: 0 }]);
  await restored.saveTaskWithGoal!({ taskId: "scout2", runId: "run2", nodeId: "node1", projectId: "p", goal: "inspect", status: "running", dispatchAttempt: 1, createdAt: 2, updatedAt: 2, dispatchOptions: { contextOverrides: { goalRunId: "goal", taskType: "scout" } } }, "goal");
  const running = (await restored.getGoalRun!("goal"))!;
  assert.equal(running.status, "running");
  assert.equal(running.finalReport, undefined);
  assert.equal(running.completedAt, undefined);
  assert.equal(running.reportHistory?.length, 2);
  await restored.updateTaskStatus("scout2", "completed");
  await processGoalRun(restored, "goal");
  assert.equal((await restored.getGoalRun!("goal"))?.reportRevision, 3);
});

test("failed report write remains retryable without duplicating a report", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-goal-report-failure-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createLocalClusterStore(path.join(dir, "store"));
  await store.createGoalRun!({ goalRunId: "g", conversationId: "c", userMessageId: "m", rootGoal: "inspect", status: "running", currentStage: "awaiting_verification", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  await store.saveTaskWithGoal!({ taskId: "t", nodeId: "node1", projectId: "p", goal: "inspect", status: "completed", dispatchAttempt: 1, createdAt: 1, updatedAt: 1 }, "g");
  const original = store.updateGoalRun!.bind(store);
  let fail = true;
  const injected = new Proxy(store, { get(target, key) {
    if (key === "updateGoalRun") return async (goal: import("../src/cluster/storage/cluster-store.js").GoalRunRecord, revision: number) => {
      if (fail && goal.reportState === "ready") { fail = false; throw new Error("injected report write failure"); }
      return original(goal, revision);
    };
    return Reflect.get(target, key);
  } });
  await assert.rejects(processGoalRun(injected, "g"), /injected report write failure/);
  assert.equal((await store.getGoalRun!("g"))?.reportState, "failed");
  assert.equal((await store.getGoalRun!("g"))?.executionState, "settled");
  assert.equal((await store.getGoalRun!("g"))?.finalReport, undefined);
  const result = await processGoalRun(injected, "g");
  assert.equal(result.reportState, "ready");
  assert.equal(result.reportHistory?.length, 1);
  assert.equal((await processGoalRun(store, "g")).reportHistory?.length, 1);
});

test("a delayed failing handler cannot erase a concurrently committed report", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-goal-report-race-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createLocalClusterStore(path.join(dir, "store"));
  await store.createGoalRun!({ goalRunId: "g", conversationId: "c", userMessageId: "m", rootGoal: "inspect", status: "running", currentStage: "awaiting_verification", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  await store.saveTaskWithGoal!({ taskId: "t", runId: "r", nodeId: "node1", projectId: "p", goal: "inspect", status: "completed", dispatchAttempt: 1, createdAt: 1, updatedAt: 1, dispatchOptions: { contextOverrides: { goalRunId: "g", taskType: "scout" } } }, "g");
  let unblock!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const injected = new Proxy(store, { get(target, key) {
    if (key === "getEventsForTask") return async () => { entered(); await blocked; throw new Error("delayed event read failure"); };
    return Reflect.get(target, key);
  } });
  const failing = processGoalRun(injected, "g");
  await waiting;
  const committed = await processGoalRun(store, "g");
  assert.equal(committed.reportState, "ready");
  unblock();
  await assert.rejects(failing, /delayed event read failure/);
  const persisted = (await store.getGoalRun!("g"))!;
  assert.equal(persisted.reportState, "ready");
  assert.equal(persisted.finalReport, committed.finalReport);
  assert.equal(persisted.reportHistory?.length, 1);
});

test("failed evidence refresh invalidates the previous report until retry succeeds", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-goal-stale-report-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createLocalClusterStore(path.join(dir, "store"));
  await store.createGoalRun!({ goalRunId: "g", conversationId: "c", userMessageId: "m", rootGoal: "inspect", status: "running", currentStage: "awaiting_verification", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  await store.saveTaskWithGoal!({ taskId: "t", runId: "r", nodeId: "node1", projectId: "p", goal: "inspect", status: "completed", dispatchAttempt: 1, createdAt: 1, updatedAt: 1, dispatchOptions: { contextOverrides: { goalRunId: "g", taskType: "scout" } } }, "g");
  assert.equal((await processGoalRun(store, "g")).reportState, "ready");
  const injected = new Proxy(store, { get(target, key) {
    if (key === "getEventsForTask") return async () => { throw new Error("evidence unavailable"); };
    return Reflect.get(target, key);
  } });
  await assert.rejects(processGoalRun(injected, "g"), /evidence unavailable/);
  const failed = (await store.getGoalRun!("g"))!;
  assert.equal(failed.reportState, "failed");
  assert.equal(failed.finalReport, undefined);
  assert.equal(failed.reportHistory?.length, 1);
  assert.equal((await processGoalRun(store, "g")).reportState, "ready");
});

test("restart recovers a durably answered turn before processing its background Scout", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-goal-turn-recovery-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "store"), store = createLocalClusterStore(file);
  await store.createGoalRun!({ goalRunId: "g", conversationId: "c", userMessageId: "m", rootGoal: "inspect", status: "planning", currentStage: "planning", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  await store.saveConversation!({ id: "c", title: "fixture", createdAt: 1, updatedAt: 2, messages: [{ id: "answer", conversationId: "c", sender: "assistant", content: "Scout still running", timestamp: 2, metadata: { goalRunId: "g" } }] });
  await store.saveTaskWithGoal!({ taskId: "t", nodeId: "node1", projectId: "p", goal: "inspect", status: "running", dispatchAttempt: 1, createdAt: 1, updatedAt: 1 }, "g");
  const restored = createLocalClusterStore(file);
  const recovered = await processGoalRun(restored, "g");
  assert.equal(recovered.status, "running");
  assert.equal(recovered.currentStage, "awaiting_verification");
  assert.equal(recovered.interimReport, "Scout still running");
  assert.equal(recovered.finalReport, undefined);
  await restored.updateTaskStatus("t", "completed");
  const final = await processGoalRun(restored, "g");
  assert.equal(final.status, "partially_completed");
  assert.equal(final.reportRevision, 2);
});
