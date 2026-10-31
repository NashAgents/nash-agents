import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { processGoalRun, reconcileGoalRun, changeGoalRun } from "../src/cluster/coordinator/goal-run-service.js";
import { defaultTraceContext } from "../src/observability/trace-context.js";

const baseGoal = {
  conversationId: "c", userMessageId: "m", rootGoal: "探查哪一个节点有知识库项目",
  status: "running" as const, currentStage: "awaiting_verification",
  linkedGraphIds: [] as string[], linkedTaskIds: [] as string[],
  requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1,
};

async function graphFixture(store: InMemoryClusterStore, goalRunId: string, nodes: Array<Record<string, unknown>>) {
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: {} as any });
  return defaultTraceContext.run({ projectId: "coordinator", sessionId: "c", traceId: `t-${goalRunId}`, goalRunId }, () =>
    orchestrator.createGraph({ parentGoal: "探查哪一个节点有知识库项目", reasoning: "fixture", requiresMultiAgent: true, nodes: nodes as any }));
}

/** Complete one graph node with an authenticated, attempt-bound verification receipt. */
async function completeNode(store: InMemoryClusterStore, goalRunId: string, graphId: string, nodeId: string, worker: string, options: { run?: string; verifiedRun?: string; artifact?: string } = {}) {
  const taskId = `task-${nodeId}`, runId = options.run ?? `run-${nodeId}`;
  await store.saveTaskWithGoal({
    taskId, runId, nodeId: worker, projectId: "p", goal: nodeId, status: "completed", dispatchAttempt: 1,
    createdAt: 1, updatedAt: 1, completedAt: 2,
    dispatchOptions: { graphContext: { graphId, graphNodeId: nodeId, inputs: [], outputs: [] } },
  }, goalRunId);
  if (options.artifact) {
    await store.saveArtifact({
      artifactId: `art-${nodeId}`, graphId, graphNodeId: nodeId, name: options.artifact, contentType: "application/json",
      sha256: "a".repeat(64), sizeBytes: 2, producerTaskId: taskId, producerNodeId: worker, status: "available",
      storagePath: "/tmp/fixture", metadata: {}, createdAt: 2,
    } as any);
  }
  await store.updateGraphNodeStatus(graphId, nodeId, "completed", { taskId, assignedNodeId: worker });
  await store.recordGraphVerification({
    graphId, graphNodeId: nodeId, verificationType: "simulated", status: "passed",
    evidence: { taskId, runId: options.verifiedRun ?? runId, workerNodeId: worker, executionSource: "authenticated_worker_runtime" } as any,
    verifiedAt: 3,
  });
  return { taskId, runId };
}

test("CASE_A: fully verified coverage completes the goal with one durable, scoped report", async () => {
  const store = new InMemoryClusterStore();
  await store.createGoalRun({ ...baseGoal, goalRunId: "g-a", rootGoal: "探查哪一个节点有知识库项目" });
  const graph = await graphFixture(store, "g-a", [
    { nodeId: "probe-node1", title: "probe", goal: "探查 node1", candidateNodeId: "worker-a", dependencies: [] },
    { nodeId: "probe-node2", title: "probe", goal: "探查 node2", candidateNodeId: "worker-b", dependencies: [] },
  ]);
  const first = await completeNode(store, "g-a", graph.graphId, "probe-node1", "worker-a");
  const second = await completeNode(store, "g-a", graph.graphId, "probe-node2", "worker-b");
  await store.updateGraphStatus(graph.graphId, "completed");

  const goal = await processGoalRun(store, "g-a");
  assert.equal(goal.status, "completed");
  assert.equal(goal.reportState, "ready");
  assert.match(goal.finalReport!, /目标已完成/);
  assert.match(goal.finalReport!, /边界说明/);
  assert.equal(goal.reportEvidence?.coverage?.completion, "completed");
  assert.deepEqual(goal.reportEvidence?.coverageChecks?.map(check => check.status), ["verified", "verified"]);
  const checks = goal.reportEvidence!.coverageChecks!;
  assert.deepEqual(checks.map(check => [check.taskId, check.runId, check.nodeId]), [
    [first.taskId, first.runId, "worker-a"], [second.taskId, second.runId, "worker-b"],
  ]);
  assert.equal(goal.reportEvidence?.coverage?.counts.requirements, 2);
  assert.equal(goal.reportEvidence?.coverage?.counts.verified, 2);

  // Idempotent: a second pass must not create a second final report.
  const again = await processGoalRun(store, "g-a");
  assert.equal(again.reportRevision, goal.reportRevision);
  assert.equal(again.reportHistory?.length, 1);
  assert.equal((await reconcileGoalRun(store, "g-a")).status, "completed");
});

test("CASE_B: a failed node keeps a partial verdict and never claims the project is absent", async () => {
  const store = new InMemoryClusterStore();
  await store.createGoalRun({ ...baseGoal, goalRunId: "g-b" });
  const graph = await graphFixture(store, "g-b", [
    { nodeId: "probe-good", title: "probe", goal: "探查 node1", candidateNodeId: "worker-a", dependencies: [] },
    { nodeId: "probe-bad", title: "probe", goal: "探查 node2", candidateNodeId: "worker-b", dependencies: [] },
  ]);
  await completeNode(store, "g-b", graph.graphId, "probe-good", "worker-a");
  await store.saveTaskWithGoal({
    taskId: "task-bad", runId: "run-bad", nodeId: "worker-b", projectId: "p", goal: "probe", status: "failed",
    dispatchAttempt: 1, createdAt: 1, updatedAt: 1, error: "EXECUTION_TIMEOUT",
    dispatchOptions: { graphContext: { graphId: graph.graphId, graphNodeId: "probe-bad", inputs: [], outputs: [] } },
  }, "g-b");
  await store.updateGraphNodeStatus(graph.graphId, "probe-bad", "failed", { taskId: "task-bad", assignedNodeId: "worker-b" });
  await store.updateGraphStatus(graph.graphId, "partially_completed");

  const goal = await processGoalRun(store, "g-b");
  assert.equal(goal.status, "partially_completed");
  assert.equal(goal.reportEvidence?.coverage?.completion, "partially_completed");
  assert.deepEqual(goal.reportEvidence?.coverageChecks?.map(check => [check.graphNodeId, check.status]), [
    ["probe-good", "verified"], ["probe-bad", "failed"],
  ]);
  assert.match(goal.finalReport!, /部分结果/);
  assert.match(goal.finalReport!, /不能据此判断未检查范围/);
  assert.doesNotMatch(goal.finalReport!, /没有发现与被探查目标相关的项目/);
  assert.match(goal.finalReport!, /probe-bad/);
});

test("CASE_C: a skipped check needs a verified replacement in the current revision", async () => {
  const store = new InMemoryClusterStore();
  await store.createGoalRun({ ...baseGoal, goalRunId: "g-c" });
  const graph = await graphFixture(store, "g-c", [
    { nodeId: "probe", title: "probe", goal: "探查 node1", candidateNodeId: "worker-a", dependencies: [] },
  ]);
  await store.saveTaskWithGoal({
    taskId: "task-old", runId: "run-old", nodeId: "worker-a", projectId: "p", goal: "probe", status: "failed",
    dispatchAttempt: 1, createdAt: 1, updatedAt: 1, error: "EXECUTION_TIMEOUT",
    dispatchOptions: { graphContext: { graphId: graph.graphId, graphNodeId: "probe", inputs: [], outputs: [], executionAttempt: 1 } },
  }, "g-c");
  await store.updateGraphNodeStatus(graph.graphId, "probe", "failed", { taskId: "task-old", assignedNodeId: "worker-a" });
  const node = (await store.getGraphNode(graph.graphId, "probe"))!;
  const patched = await store.applyGraphPatchAtomic({
    graphId: graph.graphId, expectedRevision: 1, nextRevision: 2, reason: "replace failed probe",
    addNodes: [{ ...node, nodeId: "probe-retry", goal: "重新探查 node1", candidateNodeId: "worker-a", taskId: undefined, status: "ready" } as any],
  });
  assert.equal(patched.success, true);
  await store.updateGraphNodeStatus(graph.graphId, "probe", "skipped");

  // A receipt from the failed attempt must not satisfy the replacement check.
  const taskId = "task-probe-retry";
  await store.saveTaskWithGoal({
    taskId, runId: "run-retry", nodeId: "worker-a", projectId: "p", goal: "probe", status: "completed",
    dispatchAttempt: 1, createdAt: 2, updatedAt: 2,
    dispatchOptions: { graphContext: { graphId: graph.graphId, graphNodeId: "probe-retry", inputs: [], outputs: [], executionAttempt: 2, retryOfTaskId: "task-old" } },
  }, "g-c");
  await store.updateGraphNodeStatus(graph.graphId, "probe-retry", "completed", { taskId, assignedNodeId: "worker-a" });
  await store.recordGraphVerification({
    graphId: graph.graphId, graphNodeId: "probe-retry", verificationType: "simulated", status: "passed",
    evidence: { taskId: "task-old", runId: "run-old", workerNodeId: "worker-a", executionSource: "authenticated_worker_runtime" } as any,
    verifiedAt: 3,
  });
  await store.updateGraphStatus(graph.graphId, "completed");

  const stale = await processGoalRun(store, "g-c");
  const staleCheck = stale.reportEvidence?.coverageChecks?.find(check => check.graphNodeId === "probe-retry");
  assert.equal(staleCheck?.status, "completed_unverified");
  assert.equal(stale.status, "partially_completed");

  await store.recordGraphVerification({
    graphId: graph.graphId, graphNodeId: "probe-retry", verificationType: "simulated", status: "passed",
    evidence: { taskId, runId: "run-retry", workerNodeId: "worker-a", executionSource: "authenticated_worker_runtime" } as any,
    verifiedAt: 4,
  });
  const recovered = await processGoalRun(store, "g-c");
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.reportEvidence?.coverageChecks?.find(check => check.graphNodeId === "probe-retry")?.status, "verified");
  // The superseded check is traced to its verified replacement rather than silently dropped.
  assert.equal(recovered.reportEvidence?.coverageChecks?.find(check => check.graphNodeId === "probe")?.status, "superseded");
});

test("CASE_D: a scout that finishes after the turn upgrades an unknown goal to completed", async () => {
  const store = new InMemoryClusterStore();
  await store.createGoalRun({ ...baseGoal, goalRunId: "g-d" });
  await changeGoalRun(store, "g-d", goal => {
    goal.discoveryScopes = [{
      version: 1, discoveryId: "disc-1", query: "知识库项目", selectedAt: 1, snapshotStartedAt: 1, snapshotCompletedAt: 2,
      selectionSource: "explicit_nodes", selectedNodeIds: ["worker-a"], knownClueNodeIds: [],
      snapshot: [{ nodeId: "worker-a", connected: true }], allowUnregisteredScanning: true, truncatedByLimit: false,
    }];
    return goal;
  });
  const before = await processGoalRun(store, "g-d");
  assert.equal(before.status, "outcome_unknown");
  assert.match(before.finalReport!, /不能据此判断未检查范围/);

  await store.saveTaskWithGoal({
    taskId: "task-scout", runId: "run-scout", nodeId: "worker-a", projectId: "p", goal: "探查", status: "completed",
    dispatchAttempt: 1, createdAt: 3, updatedAt: 4,
    dispatchOptions: { contextOverrides: { goalRunId: "g-d", taskType: "scout", isDiscovery: true, discoveryId: "disc-1" } },
  }, "g-d");
  await store.appendEvents([{
    taskId: "task-scout", runId: "run-scout", nodeId: "worker-a", seq: 1, timestamp: 4,
    eventType: "discovery.report_persisted",
    data: { report: { nodeId: "worker-a", candidates: [], outcome: "completed", scanReceipts: [
      { authorizedRoots: ["/srv/projects"], scope: "bounded local directory names; maximum depth 3", truncated: false, errors: [] },
    ] } },
  }]);

  const after = await processGoalRun(store, "g-d");
  assert.equal(after.status, "completed");
  assert.ok(after.reportRevision > before.reportRevision);
  assert.match(after.finalReport!, /没有发现与被探查目标相关的项目/);
  assert.match(after.finalReport!, /\/srv\/projects/);
  assert.equal(after.reportEvidence?.coverageScopes?.[0]?.status, "verified");
  assert.deepEqual(after.reportEvidence?.coverageScopes?.[0]?.nodes.map(node => [node.nodeId, node.status]), [["worker-a", "verified"]]);
});

test("CASE_D2: a truncated or erroring scan cannot license an absence claim", async () => {
  const store = new InMemoryClusterStore();
  await store.createGoalRun({ ...baseGoal, goalRunId: "g-d2" });
  await changeGoalRun(store, "g-d2", goal => {
    goal.discoveryScopes = [{
      version: 1, discoveryId: "disc-2", query: "知识库项目", selectedAt: 1, snapshotStartedAt: 1, snapshotCompletedAt: 2,
      selectionSource: "explicit_nodes", selectedNodeIds: ["worker-a"], knownClueNodeIds: [],
      snapshot: [{ nodeId: "worker-a", connected: true }], allowUnregisteredScanning: true, truncatedByLimit: false,
    }];
    return goal;
  });
  await store.saveTaskWithGoal({
    taskId: "task-scout", runId: "run-scout", nodeId: "worker-a", projectId: "p", goal: "探查", status: "completed",
    dispatchAttempt: 1, createdAt: 3, updatedAt: 4,
    dispatchOptions: { contextOverrides: { goalRunId: "g-d2", taskType: "scout", isDiscovery: true, discoveryId: "disc-2" } },
  }, "g-d2");
  await store.appendEvents([{
    taskId: "task-scout", runId: "run-scout", nodeId: "worker-a", seq: 1, timestamp: 4,
    eventType: "discovery.report_persisted",
    data: { report: { nodeId: "worker-a", candidates: [], outcome: "partial", scanReceipts: [
      { authorizedRoots: ["/srv/projects"], scope: "bounded local directory names", truncated: true, errors: [] },
    ] } },
  }]);

  const goal = await processGoalRun(store, "g-d2");
  assert.equal(goal.status, "partially_completed");
  assert.doesNotMatch(goal.finalReport!, /没有发现与被探查目标相关的项目/);
  assert.match(goal.finalReport!, /扫描收据标记为被截断/);
});

test("CASE_F: concurrent report generation commits exactly one completed report", async () => {
  const store = new InMemoryClusterStore();
  await store.createGoalRun({ ...baseGoal, goalRunId: "g-f" });
  const graph = await graphFixture(store, "g-f", [
    { nodeId: "probe", title: "probe", goal: "探查 node1", candidateNodeId: "worker-a", dependencies: [] },
  ]);
  await completeNode(store, "g-f", graph.graphId, "probe", "worker-a");
  await store.updateGraphStatus(graph.graphId, "completed");
  const [a, b] = await Promise.all([processGoalRun(store, "g-f"), processGoalRun(store, "g-f")]);
  assert.equal(a.status, "completed");
  assert.equal(b.status, "completed");
  const persisted = (await store.getGoalRun("g-f"))!;
  assert.equal(persisted.reportHistory?.length, 1);
  assert.equal(persisted.reportRevision, 1);
  assert.equal(persisted.finalReport, a.finalReport ?? b.finalReport);
});

test("a reconciler cannot erase a report owned by another live turn", async () => {
  const store = new InMemoryClusterStore();
  await store.createGoalRun({
    ...baseGoal, goalRunId: "g-own", status: "completed", currentStage: "report_ready",
    finalReport: "delivered", reportState: "ready", reportFingerprint: "fp", reportRevision: 1,
    linkedTaskIds: ["t"], turnLease: { ownerId: "owner-x", turnId: "m", generation: 3, expiresAt: Date.now() + 60_000 },
    turnLeaseGeneration: 3,
  });
  await store.saveTask({ taskId: "t", runId: "r", nodeId: "worker", projectId: "p", goal: "g", status: "running", dispatchAttempt: 1, createdAt: 1, updatedAt: 1 });
  const reconciled = await reconcileGoalRun(store, "g-own");
  assert.equal(reconciled.status, "completed");
  assert.equal(reconciled.finalReport, "delivered");
  assert.equal(reconciled.reportState, "ready");

  // Once the lease expires, the same reconciler may converge the derived state again.
  await store.updateGoalRun({ ...reconciled, turnLease: { ...reconciled.turnLease!, expiresAt: 1 }, revision: reconciled.revision + 1 }, reconciled.revision);
  const after = await reconcileGoalRun(store, "g-own");
  assert.equal(after.status, "running");
  assert.equal(after.finalReport, undefined);
});

test("CASE_F2: a background replan invalidates the verdict without erasing another turn's report", async () => {
  const store = new InMemoryClusterStore();
  await store.createGoalRun({ ...baseGoal, goalRunId: "g-f2" });
  const graph = await graphFixture(store, "g-f2", [
    { nodeId: "probe", title: "probe", goal: "探查 node1", candidateNodeId: "worker-a", dependencies: [] },
  ]);
  await completeNode(store, "g-f2", graph.graphId, "probe", "worker-a");
  await store.updateGraphStatus(graph.graphId, "completed");
  const delivered = await processGoalRun(store, "g-f2");
  assert.equal(delivered.status, "completed");

  // Another live turn owns the GoalRun while a concurrent background patch reopens the graph.
  const lease = { ownerId: "owner-x", turnId: "m", generation: 4, expiresAt: Date.now() + 60_000 };
  const leased = { ...delivered, turnLease: lease, turnLeaseGeneration: 4, revision: delivered.revision + 1 };
  await store.updateGoalRun(leased, delivered.revision);
  await store.updateGraphStatus(graph.graphId, "running");
  const reopened = (await store.getGraph(graph.graphId))!.revision;
  const foreign = await store.applyGraphPatchAtomic({ graphId: graph.graphId, expectedRevision: reopened, nextRevision: reopened + 1, reason: "background replan" });
  assert.equal(foreign.success, true);
  const after = (await store.getGoalRun("g-f2"))!;
  assert.equal(after.status, "completed");
  assert.equal(after.reportState, "ready");
  assert.equal(after.finalReport, delivered.finalReport);
  assert.equal(after.coverageEvaluation, undefined); // the old revision's verdict can no longer be trusted
  assert.ok(after.revision > leased.revision);

  // The owning turn may still restart delivery state from a replan it triggered itself.
  const owned = await defaultTraceContext.run(
    { projectId: "coordinator", sessionId: "c", traceId: "t-owned", goalRunId: "g-f2", goalTurnFence: lease },
    () => store.applyGraphPatchAtomic({ graphId: graph.graphId, expectedRevision: reopened + 1, nextRevision: reopened + 2, reason: "owner replan" }),
  );
  assert.equal(owned.success, true);
  const restarted = (await store.getGoalRun("g-f2"))!;
  assert.equal(restarted.status, "running");
  assert.equal(restarted.finalReport, undefined);
  assert.equal(restarted.reportState, "pending");
});

test("coverage without any check cannot complete even when every task succeeded", async () => {
  const store = new InMemoryClusterStore();
  await store.createGoalRun({ ...baseGoal, goalRunId: "g-none" });
  await store.saveTaskWithGoal({
    taskId: "t", runId: "r", nodeId: "worker", projectId: "p", goal: "探查", status: "completed",
    dispatchAttempt: 1, createdAt: 1, updatedAt: 1,
    dispatchOptions: { contextOverrides: { goalRunId: "g-none", taskType: "standalone" } },
  }, "g-none");
  const goal = await processGoalRun(store, "g-none");
  assert.equal(goal.status, "partially_completed");
  assert.match(goal.finalReport!, /没有任何可核验的覆盖计划|部分结果/);
});
