import { simulatedSandbox, completeSimulatedTask } from "./helpers/runtime-truth-fixtures.js";
import { registerFixtureNodes } from "./helpers/registered-node.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { SimulatedPlanner as AutonomousPlanner } from "./helpers/runtime-truth-fixtures.js";
import { ArtifactService } from "../src/cluster/artifacts/artifact-service.js";
import { RunDistributedTaskGraphTool } from "../src/cluster/tools/cluster-tools.js";
import type { DistributedGraphNodeRecord } from "../src/cluster/graph/types.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

test("任务先于图节点外键持久化，两分支在任何完成前均已派发，Join 后统一返回", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nash-graph-dispatch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new InMemoryClusterStore(); const sent: any[] = [];
  await registerFixtureNodes(store, "A", "B", "summary");
  const twoSent = deferred();
  const scheduler = new TaskScheduler(store, { getConnection: () => ({ ws: { readyState: 1, send: (raw: string) => {
    sent.push(JSON.parse(raw).payload); if (sent.length === 2) twoSent.resolve();
  } }, generation: 1 }) } as any, "coordinator");
  const save = store.saveGraphNode.bind(store);
  t.mock.method(store, "saveGraphNode", async (node: DistributedGraphNodeRecord) => {
    if (node.taskId) assert.ok(await store.getTask(node.taskId), "PostgreSQL foreign key requires the task to exist first");
    await save(node);
  });
  const graph = new DistributedGraphOrchestrator({ store, scheduler, artifactService: new ArtifactService(store, directory),
    validator: { validateCandidate: async () => ({ valid: true, code: "VALID", reason: "fixture" }) } });
  let graphId = "";
  const tool = new RunDistributedTaskGraphTool(new AutonomousPlanner(), graph, (id) => { graphId = id; }, { store });
  const branch = (id: string) => ({ nodeId: id, title: id, goal: id, operation: "analyze" as const, dependencies: [],
    candidateNodeId: id, candidateProjectId: "project", producedArtifacts: [{ name: `${id}.md`, contentType: "text/markdown" }],
    acceptanceCriteria: [{ type: "artifact_exists" as const, expected: `${id}.md`, description: "report" }] });
  let settled = false;
  const execution = tool.execute({ goal: "parallel reports", nodes: [branch("A"), branch("B"), {
    ...branch("summary"), dependencies: ["A", "B"], requiredArtifacts: [{ name: "A.md", producerNodeId: "A" }, { name: "B.md", producerNodeId: "B" }],
  }] }).then((result) => { settled = true; return result; });
  await Promise.race([twoSent.promise, execution.then(() => { throw new Error("Graph ended before dispatching both branches"); })]);
  assert.equal(sent.length, 2); assert.equal(settled, false);
  assert.ok(sent.every((task) => task.graphContext.graphId === graphId));
  await completeSimulatedTask(store, graph, graphId, sent[0].taskId, "A report", [{ name: "A.md", contentType: "text/markdown", content: "A report" }]);
  assert.equal(sent.length, 2); assert.equal(settled, false);
  await completeSimulatedTask(store, graph, graphId, sent[1].taskId, "B report", [{ name: "B.md", contentType: "text/markdown", content: "B report" }]);
  assert.equal(sent.length, 3); assert.equal(sent[2].graphContext.inputs.length, 2);
  await completeSimulatedTask(store, graph, graphId, sent[2].taskId, "comparison", [{ name: "summary.md", contentType: "text/markdown", content: "comparison" }]);
  const result = await execution;
  assert.equal(result.status, "completed"); assert.equal(result.success, true);
  assert.equal(result.nodeResults.find((node) => node.nodeId === "summary")?.result, "comparison");
});

test("Outbox 不能抢跑未完成的派发准备，准备失败不会变成后台孤立任务", async () => {
  const store = new InMemoryClusterStore(); const sent: unknown[] = [];
  const scheduler = new TaskScheduler(store, { getConnection: () => ({ ws: { readyState: 1, send: (raw: unknown) => sent.push(raw) }, generation: 1 }) } as any, "coordinator");
  await registerFixtureNodes(store, "worker");
  const entered = deferred(); const release = deferred();
  const result = scheduler.createTask({ nodeId: "worker", projectId: "project", goal: "inspect", beforeDispatch: async (task) => {
    assert.ok(await store.getTask(task.taskId)); entered.resolve(); await release.promise; throw new Error("grant failed");
  } });
  const rejected = assert.rejects(result, /grant failed/);
  try {
    await entered.promise; await scheduler.flushOutbox();
    assert.equal(sent.length, 0); assert.deepEqual(await store.pollPendingOutbox(), []);
  } finally { release.resolve(); }
  await rejected; await scheduler.flushOutbox();
  assert.equal((await store.listTasks())[0]!.status, "failed"); assert.equal(sent.length, 0);
});

test("崩溃在图认领前的 created 任务不得由 Outbox 脱图重放", async () => {
  const store = new InMemoryClusterStore();
  await store.saveTask({ taskId: "unclaimed", runId: "run", nodeId: "worker", projectId: "project", goal: "inspect", status: "created", dispatchAttempt: 1, createdAt: 1, updatedAt: 1,
    dispatchOptions: { graphContext: { graphId: "graph", graphNodeId: "node", inputs: [], outputs: [] } } });
  await new TaskScheduler(store, { getConnection: () => undefined } as any, "coordinator").flushOutbox();
  assert.equal((await store.getTask("unclaimed"))!.status, "failed"); assert.deepEqual(await store.pollPendingOutbox(), []);
});

test("等待图完成支持取消，立即完成的图不丢终态通知", async () => {
  const store = new InMemoryClusterStore(); const graph = new DistributedGraphOrchestrator({ store, scheduler: {} as any });
  await store.saveGraph({ graphId: "completed", status: "completed" } as any);
  assert.equal((await graph.waitForCompletion("completed", 1000)).status, "completed");
  await store.saveGraph({ graphId: "running", status: "running" } as any);
  const abort = new AbortController(); const wait = graph.waitForCompletion("running", 1000, abort.signal);
  abort.abort(new Error("cancel wait")); await assert.rejects(wait, /cancel wait/);
});

test("图节点跟随真实任务进入审批与运行，终态不会被迟到活动事件改写", async () => {
  const { GraphStateProjection } = await import("../src/cluster/graph/graph-state-projection.js");
  const { WorkerGraphArtifacts } = await import("../src/cluster/worker/graph-artifacts.js");
  const store = new InMemoryClusterStore(); const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: {} as any });
  await store.saveGraph({ graphId: "graph", status: "running" } as any);
  await store.saveGraphNode({ graphId: "graph", nodeId: "branch", taskId: "task", status: "dispatched" } as any);
  await store.saveTask({ taskId: "task", status: "waiting_approval", dispatchOptions: { graphContext: { graphId: "graph", graphNodeId: "branch", inputs: [], outputs: [] } } } as any);
  await store.saveApproval({ approvalId: "approval", taskId: "task", status: "pending", requestedAt: Date.now(), expiresAt: Date.now() + 60000 } as any);
  await store.saveApproval({ approvalId: "unrelated", taskId: "other", status: "pending", expiresAt: Date.now() + 60000 } as any);
  await orchestrator.syncTaskActivity("task");
  assert.equal((await store.getGraphNode("graph", "branch"))?.status, "waiting_approval");
  assert.equal((await new GraphStateProjection(store).projectGraphState("graph"))?.pendingApprovalsCount, 1);
  await store.resolveApproval("approval", "deny");
  assert.equal((await store.listApprovalHistory())[0]?.decision, "deny");
  await store.updateTaskStatus("task", "running"); await orchestrator.syncTaskActivity("task");
  assert.equal((await store.getGraphNode("graph", "branch"))?.status, "running");
  await store.updateGraphNodeStatus("graph", "branch", "completed"); await orchestrator.syncTaskActivity("task");
  assert.equal((await store.getGraphNode("graph", "branch"))?.status, "completed");
  const prompt = new WorkerGraphArtifacts({ graphId: "graph", graphNodeId: "branch", inputs: [], outputs: [] }, () => Date.parse("2026-10-20T18:28:35Z")).prompt();
  assert.match(prompt, /2026-10-20T18:28:35.000Z/); assert.match(prompt, /2026-10-21 02:28:35/);
});
