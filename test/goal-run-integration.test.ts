import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { processGoalRun, reconcileGoalRun } from "../src/cluster/coordinator/goal-run-service.js";
import { defaultTraceContext } from "../src/observability/trace-context.js";
import { registerFixtureNodes } from "./helpers/registered-node.js";
import { AutonomousDiscoveryService } from "../src/cluster/discovery/autonomous-discovery-service.js";

test("superseded foreground owner cannot create, start or patch a graph", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const store = new InMemoryClusterStore();
  await store.saveConversation({ id: "c", title: "fixture", createdAt: 1, updatedAt: 1, messages: [{ id: "u", conversationId: "c", sender: "user", content: "inspect", timestamp: 1 }] });
  await store.createGoalRun({ goalRunId: "g", conversationId: "c", userMessageId: "u", rootGoal: "inspect", status: "planning", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  const old = (await store.claimGoalTurnLease("g", "u", "old", 100))!;
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: {} as any });
  const proposal = { parentGoal: "inspect", reasoning: "fixture", requiresMultiAgent: true, nodes: [{ nodeId: "n", title: "n", goal: "n", dependencies: [] }] };
  const context = { projectId: "coordinator", sessionId: "c", traceId: "t", goalRunId: "g", goalTurnFence: old };
  const graph = await defaultTraceContext.run(context, () => orchestrator.createGraph(proposal));
  t.mock.timers.tick(101);
  const current = (await store.claimGoalTurnLease("g", "u", "new", 100))!;
  await assert.rejects(defaultTraceContext.run(context, () => orchestrator.createGraph(proposal)), /lease expired or was superseded/);
  await assert.rejects(defaultTraceContext.run(context, () => orchestrator.startGraph(graph.graphId)), /lease expired or was superseded/);
  await assert.rejects(defaultTraceContext.run(context, () => store.applyGraphPatchAtomic({ graphId: graph.graphId, expectedRevision: 1, nextRevision: 2, operationId: "old", reason: "injected stale patch", newGraphStatus: "running" })), /lease expired or was superseded/);
  await assert.rejects(defaultTraceContext.run(context, () => store.saveScheduledTask({ id: "late-schedule" } as any)), /lease expired or was superseded/);
  assert.equal(await store.getScheduledTask("late-schedule"), null);
  await store.saveTaskWithGoal({ taskId: "controlled", nodeId: "worker", projectId: "p", goal: "inspect", status: "running", dispatchAttempt: 1, createdAt: 1, updatedAt: 1 }, "g", current);
  let sent = 0;
  const scheduler = new TaskScheduler(store, { getConnection: () => ({ ws: { readyState: 1, send: () => { sent++; } } }) } as any, "coord", 100);
  const staleControl = await defaultTraceContext.run(context, () => scheduler.sendControl("controlled", "cancel"));
  assert.equal(staleControl.success, false);
  assert.equal(sent, 0);
  assert.equal((await store.getTask("controlled"))?.status, "running");
  assert.equal(await store.executeGoalTaskControl("g", current, "controlled", "cancelling", undefined, () => { sent++; }), true);
  assert.equal(sent, 1);
  assert.equal((await store.getGraph(graph.graphId))?.status, "ready");
  assert.equal((await store.listGraphs()).length, 1);
  assert.equal(current.generation, old.generation + 1);
});

test("a graph and a scout dispatched from a turn retain their GoalRun ownership", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  await store.createGoalRun({ goalRunId: "g1", conversationId: "c1", userMessageId: "m1", rootGoal: "inspect", status: "planning", currentStage: "planning", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  const scheduler = new TaskScheduler(store, { getConnection: () => undefined } as any, "coord");
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler });
  const result = await defaultTraceContext.run({ projectId: "coordinator", sessionId: "c1", traceId: "trace", goalRunId: "g1" }, async () => {
    const graph = await orchestrator.createGraph({ parentGoal: "inspect", reasoning: "fixture", requiresMultiAgent: true, nodes: [{ nodeId: "n", title: "n", goal: "n", dependencies: [] }] });
    const scout = await scheduler.createTask({ nodeId: "worker", projectId: "p", goal: "inspect", contextOverrides: { isDiscovery: true, readOnly: true } });
    return { graph, scout };
  });
  const goal = (await store.getGoalRun("g1"))!;
  assert.deepEqual(goal.linkedGraphIds, [result.graph.graphId]);
  assert.equal(goal.coverageHistory?.[0]?.graphId, result.graph.graphId);
  assert.equal(goal.coverageHistory?.[0]?.rootGoalMatches, true);
  assert.equal(goal.coverageHistory?.[0]?.scopeStatus, "unverified");
  assert.equal((goal.requiredExecutionScope as any)?.completeness, "unverified");
  assert.deepEqual(goal.linkedTaskIds, [result.scout.taskId]);
  assert.equal(result.scout.dispatchOptions?.contextOverrides?.goalRunId, "g1");
  assert.equal(result.scout.dispatchOptions?.contextOverrides?.taskType, "scout");
  assert.equal((await reconcileGoalRun(store, "g1")).status, "running");
});

test("a committed graph revision records its changed checks without rewriting the original coverage", async () => {
  const store = new InMemoryClusterStore();
  await store.createGoalRun({ goalRunId: "g", conversationId: "c", userMessageId: "u", rootGoal: "inspect", status: "planning", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: {} as any });
  const graph = await defaultTraceContext.run({ projectId: "p", sessionId: "c", traceId: "t", goalRunId: "g" }, () => orchestrator.createGraph({ parentGoal: "inspect", reasoning: "fixture", requiresMultiAgent: true, nodes: [{ nodeId: "n", title: "n", goal: "inspect source", dependencies: [] }] }));
  const first = (await store.getGraphNode(graph.graphId, "n"))!;
  const result = await store.applyGraphPatchAtomic({ graphId: graph.graphId, expectedRevision: 1, nextRevision: 2, reason: "add verification", addNodes: [{ ...first, nodeId: "verification", goal: "verify source" }] });
  assert.equal(result.success, true);
  const goal = (await store.getGoalRun("g"))!;
  assert.deepEqual(goal.coverageHistory?.map(item => [item.version, item.graphRevision, item.source]), [[1, 1, "admitted_graph"], [2, 2, "graph_replan"]]);
  assert.deepEqual(goal.coverageHistory?.[0]?.checks.map(check => check.graphNodeId), ["n"]);
  assert.deepEqual(goal.coverageHistory?.[1]?.checks.map(check => check.graphNodeId).sort(), ["n", "verification"]);
  assert.equal(goal.coverageHistory?.[1]?.scopeStatus, "unverified");
});

test("SIMULATED_EVIDENCE: a coverage check requires verification bound to the current attempt and run", async () => {
  const store = new InMemoryClusterStore();
  await store.createGoalRun({ goalRunId: "g", conversationId: "c", userMessageId: "u", rootGoal: "inspect", status: "running", currentStage: "awaiting_verification", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: {} as any });
  const graph = await defaultTraceContext.run({ projectId: "p", sessionId: "c", traceId: "t", goalRunId: "g" }, () => orchestrator.createGraph({ parentGoal: "inspect", reasoning: "fixture", requiresMultiAgent: true, nodes: [{ nodeId: "n", title: "n", goal: "inspect", candidateNodeId: "worker", dependencies: [] }] }));
  await store.saveTaskWithGoal({ taskId: "t", runId: "run", nodeId: "worker", projectId: "p", goal: "inspect", status: "completed", dispatchAttempt: 1, createdAt: 1, updatedAt: 1, dispatchOptions: { graphContext: { graphId: graph.graphId, graphNodeId: "n", inputs: [], outputs: [] } } }, "g");
  await store.updateGraphNodeStatus(graph.graphId, "n", "completed", { taskId: "t", assignedNodeId: "worker" });
  await store.updateGraphStatus(graph.graphId, "completed");
  await store.recordGraphVerification({ graphId: graph.graphId, graphNodeId: "n", verificationType: "simulated", status: "passed", evidence: { taskId: "t", runId: "wrong", executionSource: "authenticated_worker_runtime" }, verifiedAt: 1 });
  const first = await processGoalRun(store, "g");
  assert.equal(first.reportEvidence?.coverageChecks?.[0]?.status, "completed_unverified");
  assert.equal(first.status, "partially_completed");
  await store.recordGraphVerification({ graphId: graph.graphId, graphNodeId: "n", verificationType: "simulated", status: "passed", evidence: { taskId: "t", runId: "run", executionSource: "authenticated_worker_runtime" }, verifiedAt: 2 });
  const revised = await processGoalRun(store, "g");
  assert.equal(revised.reportEvidence?.coverageChecks?.[0]?.status, "verified");
  // Only the attempt-bound receipt can complete the goal; the wrong-run receipt above could not.
  assert.equal(revised.status, "completed");
  assert.equal(revised.reportEvidence?.coverage?.completion, "completed");
  assert.match(revised.finalReport!, /目标已完成/);
  assert.equal(revised.reportRevision, first.reportRevision + 1);
});

test("missing GoalRun rejects graph and task creation before any execution is persisted", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  const scheduler = new TaskScheduler(store, { getConnection: () => undefined } as any, "coord");
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler });
  await defaultTraceContext.run({ projectId: "coordinator", sessionId: "c", traceId: "t", goalRunId: "missing" }, async () => {
    await assert.rejects(orchestrator.createGraph({ parentGoal: "inspect", reasoning: "test", requiresMultiAgent: true, nodes: [{ nodeId: "n", title: "n", goal: "n", dependencies: [] }] }), /GoalRun not found/);
    await assert.rejects(scheduler.createTask({ nodeId: "worker", projectId: "p", goal: "inspect", contextOverrides: { isDiscovery: true, readOnly: true } }), /GoalRun not found/);
  });
  assert.equal((await store.listGraphs()).length, 0);
  assert.equal((await store.listTasks()).length, 0);
});

test("graph task attempt history preserves the failed prior execution", async () => {
  const store = new InMemoryClusterStore();
  const context = { graphId: "graph", graphNodeId: "n", inputs: [], outputs: [] };
  const base = { nodeId: "worker", projectId: "p", goal: "inspect", dispatchAttempt: 1, createdAt: 1, updatedAt: 1 };
  await store.saveTask({ ...base, taskId: "first", status: "failed", error: "timeout", dispatchOptions: { graphContext: { ...context, executionAttempt: 1 } } });
  await store.saveTask({ ...base, taskId: "second", status: "running", dispatchOptions: { graphContext: { ...context, executionAttempt: 2, retryOfTaskId: "first" } } });
  const attempts = await store.listGraphTaskAttempts("graph", "n");
  assert.deepEqual(attempts.map(task => task.taskId), ["first", "second"]);
  assert.equal(attempts[0]?.error, "timeout");
  assert.equal(attempts[1]?.dispatchOptions?.graphContext?.retryOfTaskId, "first");
});

test("attempt order uses execution sequence when timestamps and IDs do not indicate chronology", async () => {
  const store = new InMemoryClusterStore();
  const base = { nodeId: "worker", projectId: "p", goal: "inspect", dispatchAttempt: 1, createdAt: 1, updatedAt: 1, status: "failed" as const };
  const graphContext = { graphId: "graph", graphNodeId: "n", inputs: [], outputs: [] };
  await store.saveTask({ ...base, taskId: "a-second", dispatchOptions: { graphContext: { ...graphContext, executionAttempt: 2 } } });
  await store.saveTask({ ...base, taskId: "z-first", dispatchOptions: { graphContext: { ...graphContext, executionAttempt: 1 } } });
  assert.deepEqual((await store.listGraphTaskAttempts("graph", "n")).map(task => task.taskId), ["z-first", "a-second"]);
});

test("dispatch recovery preserves a task and its GoalRun after interrupted preparation", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  await store.createGoalRun({ goalRunId: "g", conversationId: "c", userMessageId: "m", rootGoal: "inspect", status: "running", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  await store.saveTaskWithGoal({ taskId: "t", runId: "r", nodeId: "worker", projectId: "p", goal: "inspect", status: "created", dispatchAttempt: 1, createdAt: 1, updatedAt: 1, dispatchOptions: { contextOverrides: { goalRunId: "g", taskType: "scout" } } }, "g");
  const scheduler = new TaskScheduler(store, { getConnection: () => undefined } as any, "coord");
  await scheduler.flushOutbox();
  assert.equal((await store.getTask("t"))?.status, "queued");
  assert.deepEqual((await store.getGoalRun("g"))?.linkedTaskIds, ["t"]);
  await scheduler.flushOutbox();
  assert.deepEqual((await store.getGoalRun("g"))?.linkedTaskIds, ["t"]);
});

test("recovery Scout explicitly references the latest failed attempt of the same GoalRun", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  await store.createGoalRun({ goalRunId: "g", conversationId: "c", userMessageId: "m", rootGoal: "inspect", status: "running", linkedGraphIds: ["graph"], linkedTaskIds: ["first"], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  await store.saveTask({ taskId: "first", nodeId: "worker", projectId: "p", goal: "inspect", dispatchAttempt: 1, status: "failed", error: "unavailable", createdAt: 1, updatedAt: 1, dispatchOptions: { graphContext: { graphId: "graph", graphNodeId: "n", inputs: [], outputs: [] } } });
  let dispatched: any;
  const service = new AutonomousDiscoveryService({ store, registry: { getConnection: () => ({}) } as any, scheduler: { createTask: async (options: any) => { dispatched = options; throw new Error("injected dispatch failure"); } } as any });
  const context = { projectId: "p", sessionId: "c", traceId: "trace", goalRunId: "g" };
  await defaultTraceContext.run(context, () => service.discover("inspect", { nodeIds: ["worker"], recoveryOf: { graphId: "graph", graphNodeId: "n", reason: "investigate failure" } }));
  assert.deepEqual(dispatched.contextOverrides.recoveryOf, { graphId: "graph", graphNodeId: "n", taskId: "first", reason: "investigate failure" });
  await assert.rejects(defaultTraceContext.run(context, () => service.discover("inspect", { recoveryOf: { graphId: "other", graphNodeId: "n", reason: "invalid ownership" } })), /belonging to the current GoalRun/);
  await store.saveTask({ taskId: "second", nodeId: "worker", projectId: "p", goal: "inspect", dispatchAttempt: 1, status: "completed", createdAt: 2, updatedAt: 2, dispatchOptions: { graphContext: { graphId: "graph", graphNodeId: "n", inputs: [], outputs: [] } } });
  await assert.rejects(defaultTraceContext.run(context, () => service.discover("inspect", { recoveryOf: { graphId: "graph", graphNodeId: "n", reason: "already resolved" } })), /latest attempt to have failed/);
});

test("discovery scope is durable before dispatch and missing dispatch remains outcome unknown", async () => {
  const store = new InMemoryClusterStore(); await registerFixtureNodes(store, "worker-a", "worker-b");
  await store.createGoalRun({ goalRunId: "g", conversationId: "c", userMessageId: "m", rootGoal: "inspect", status: "planning", currentStage: "planning", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  const service = new AutonomousDiscoveryService({ store, registry: { getConnection: () => ({}) } as any,
    scheduler: { createTask: async () => { throw new Error("injected failure before task persistence"); } } as any });
  await defaultTraceContext.run({ projectId: "p", sessionId: "c", traceId: "t", goalRunId: "g" }, () => service.discover("inspect", { nodeIds: ["worker-a", "worker-b"], maxNodesToScout: 1 }));
  const goal = (await store.getGoalRun("g"))!;
  assert.deepEqual(goal.discoveryScopes?.[0]?.requestedNodeIds, ["worker-a", "worker-b"]);
  assert.deepEqual(goal.discoveryScopes?.[0]?.selectedNodeIds, ["worker-a"]);
  assert.equal(goal.discoveryScopes?.[0]?.truncatedByLimit, true);
  assert.equal(goal.discoveryScopes?.[0]?.snapshot.length, 2);
  assert.equal(goal.finalReport, undefined);
  const running = await reconcileGoalRun(store, "g");
  assert.equal(running.status, "running");
  await store.updateGoalRun({ ...running, currentStage: "awaiting_verification", revision: running.revision + 1 }, running.revision);
  const unknown = await reconcileGoalRun(store, "g");
  assert.equal(unknown.status, "outcome_unknown");
  assert.equal(unknown.executionState, "outcome_unknown");
  assert.equal((await store.getGoalRun("g"))?.finalReport, undefined);
});

test("no available discovery targets converges to a partial report without claiming absence", async () => {
  const store = new InMemoryClusterStore();
  await store.createGoalRun({ goalRunId: "g", conversationId: "c", userMessageId: "m", rootGoal: "inspect", status: "planning", currentStage: "planning", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  const service = new AutonomousDiscoveryService({ store, registry: { getConnection: () => undefined, listOnlineConnections: () => [] } as any });
  const discovery = await defaultTraceContext.run({ projectId: "p", sessionId: "c", traceId: "t", goalRunId: "g" }, () => service.discover("inspect"));
  assert.equal(discovery.status, "no_online_nodes");
  const goal = (await store.getGoalRun("g"))!;
  await store.updateGoalRun({ ...goal, currentStage: "awaiting_verification", revision: goal.revision + 1 }, goal.revision);
  const final = await processGoalRun(store, "g");
  assert.equal(final.status, "partially_completed");
  assert.match(final.finalReport!, /没有可核验的关联执行记录/);
  assert.match(final.finalReport!, /不能据此判断未检查范围/);
});

test("pending security application blocks new task admission and queued dispatch", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  let ready = false, online = false, sent = 0;
  const registry = { getConnection: () => online ? { connectionGeneration: 1, ws: { readyState: 1, send: () => { sent++; } } } : undefined } as any;
  const scheduler = new TaskScheduler(store, registry, "coord", 10000, () => ready);
  await assert.rejects(scheduler.createTask({ nodeId: "worker", projectId: "p", goal: "inspect", contextOverrides: { readOnly: true } }), /SECURITY_APPLY_PENDING/);
  ready = true;
  const task = await scheduler.createTask({ nodeId: "worker", projectId: "p", goal: "inspect", contextOverrides: { readOnly: true } });
  online = true; ready = false;
  await scheduler.flushOutbox();
  assert.equal(sent, 0);
  assert.equal((await store.getTask(task.taskId))?.status, "queued");
  ready = true;
  await scheduler.flushOutbox();
  assert.equal(sent, 1);
});

test("a graph attempt waiting for approval is reflected in the GoalRun", async () => {
  const store = new InMemoryClusterStore();
  await store.createGoalRun({ goalRunId: "g", conversationId: "c", userMessageId: "m", rootGoal: "inspect", status: "running", currentStage: "awaiting_verification", linkedGraphIds: ["graph"], linkedTaskIds: ["t"], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  await store.saveGraph({ graphId: "graph", status: "running" } as any);
  await store.saveTask({ taskId: "t", nodeId: "worker", projectId: "p", goal: "inspect", dispatchAttempt: 1, status: "waiting_approval", createdAt: 1, updatedAt: 1, dispatchOptions: { graphContext: { graphId: "graph", graphNodeId: "n", inputs: [], outputs: [] } } });
  const waiting = await reconcileGoalRun(store, "g");
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(waiting.executionState, "waiting_approval");
});

test("security tightening during dispatch prevents the actual send", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  let ready = true, sent = 0;
  const update = store.updateTaskStatus.bind(store);
  store.updateTaskStatus = async (...args) => { await update(...args); if (args[1] === "dispatched") ready = false; };
  const registry = { getConnection: () => ({ generation: 1, ws: { readyState: 1, send: () => { sent++; } } }) } as any;
  const scheduler = new TaskScheduler(store, registry, "coord", 10000, () => ready);
  await scheduler.createTask({ nodeId: "worker", projectId: "p", goal: "inspect", contextOverrides: { readOnly: true } });
  assert.equal(sent, 0);
});

test("Scout policy is determined by structured context, not a task title", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  const scheduler = new TaskScheduler(store, { getConnection: () => undefined } as any, "coord");
  const ordinary = await scheduler.createTask({ nodeId: "worker", projectId: "p", goal: "Scout 探查任务" });
  const scout = await scheduler.createTask({ nodeId: "worker", projectId: "p", goal: "inspect", contextOverrides: { isDiscovery: true } });
  assert.equal((ordinary.dispatchOptions?.contextOverrides?.requiredPolicy as any).filesystem, "workspace-write");
  assert.equal((scout.dispatchOptions?.contextOverrides?.requiredPolicy as any).filesystem, "read-only");
});
