import { simulatedCapabilities, simulatedSandbox, completeSimulatedTask, recordSimulatedExecution } from "./helpers/runtime-truth-fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { ArtifactService } from "../src/cluster/artifacts/artifact-service.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { GraphReplanner } from "../src/cluster/graph/graph-replanner.js";
import { defaultTraceContext } from "../src/observability/trace-context.js";
import { processGoalRun } from "../src/cluster/coordinator/goal-run-service.js";
import { SimulatedPlanner as AutonomousPlanner } from "./helpers/runtime-truth-fixtures.js";
import { RoutingValidator } from "../src/cluster/router/routing-validator.js";
import { WorkerGraphArtifacts } from "../src/cluster/worker/graph-artifacts.js";
import type { CreateTaskOptions } from "../src/cluster/coordinator/task-scheduler.js";
import type { GraphProposalNode } from "../src/cluster/graph/types.js";

function graphFixture(t: any) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nash-graph-boundaries-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new InMemoryClusterStore();
  const artifacts = new ArtifactService(store, directory);
  const sent: CreateTaskOptions[] = [];
  const scheduler = { createTask: async (options: CreateTaskOptions) => {
    const task = { taskId: `test-${sent.length}`, nodeId: options.nodeId, projectId: options.projectId, runId: "simulation", dispatchOptions: { graphContext: options.graphContext }, goal: options.goal, status: "running" as const, dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now() };
    sent.push(options); await options.beforeDispatch?.(task); await store.saveTask(task); return task;
  } };
  const validator = { validateCandidate: async () => ({ valid: true, code: "VALID" as const, reason: "test fixture" }) };
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: scheduler as any, validator, artifactService: artifacts });
  return { directory, store, artifacts, sent, scheduler, orchestrator };
}
const node = (id: string): GraphProposalNode => ({ nodeId: id, title: id, goal: id, operation: "execute", dependencies: [], candidateNodeId: "worker", candidateProjectId: "project" });

test("产物拒绝路径穿越、同名前缀目录与符号链接目录，临时数据完整清理", async (t) => {
  const { directory, store, artifacts } = graphFixture(t);
  await assert.rejects(artifacts.publishArtifact({ graphId: "../outside", producerTaskId: "t", producerNodeId: "w", name: "x", content: "x" }), /Invalid graph ID/);
  const sibling = directory + "-sibling"; fs.mkdirSync(sibling); t.after(() => fs.rmSync(sibling, { recursive: true, force: true }));
  fs.symlinkSync(sibling, path.join(directory, "linked"));
  await assert.rejects(artifacts.publishArtifact({ graphId: "linked", producerTaskId: "t", producerNodeId: "w", name: "x", content: "x" }), /symbolic link/);
  const art = await artifacts.publishArtifact({ graphId: "safe", producerTaskId: "t", producerNodeId: "w", name: "x", content: "valid" });
  fs.writeFileSync(path.join(sibling, "x"), "outside");
  await store.saveArtifact({ ...art, storagePath: path.join(sibling, "x") });
  await assert.rejects(artifacts.readArtifactContent(art.artifactId, "w"), /escapes/);
});

test("未注入校验器及实际无效项目均不能派发，固定目标同样受安全校验", async (t) => {
  const { store, scheduler, sent } = graphFixture(t);
  for (const validator of [undefined, new RoutingValidator(store, { getConnection: () => undefined } as any)]) {
    const graph = new DistributedGraphOrchestrator({ store, scheduler: scheduler as any, validator });
    if (validator) {
      await assert.rejects(graph.createGraph({ reasoning: "test", requiresMultiAgent: true, parentGoal: "goal", nodes: [node("A")] }), /PLANNING_CONSTRAINT_VIOLATION/);
      continue;
    }
    const record = await graph.createGraph({ reasoning: "test", requiresMultiAgent: true, parentGoal: "goal", nodes: [node("A")] }); await graph.startGraph(record.graphId);
    assert.equal((await store.getGraphNode(record.graphId, "A"))!.status, "blocked");
  }
  assert.equal(sent.length, 0);
});

test("暂停图保留同项目写租约，暂停期间完成也能正确收敛", async (t) => {
  const { store, sent, orchestrator } = graphFixture(t);
  const first = await orchestrator.createGraph({ reasoning: "test", requiresMultiAgent: true, parentGoal: "first", nodes: [node("A")] }); await orchestrator.startGraph(first.graphId);
  await orchestrator.pauseGraph(first.graphId);
  const second = await orchestrator.createGraph({ reasoning: "test", requiresMultiAgent: true, parentGoal: "second", nodes: [node("B")] }); await orchestrator.startGraph(second.graphId);
  assert.equal(sent.length, 1); assert.equal((await store.getGraphNode(second.graphId, "B"))!.status, "ready");
  const taskId = (await store.getGraphNode(first.graphId, "A"))!.taskId!;
  await completeSimulatedTask(store, orchestrator, first.graphId, taskId, "done");
  assert.equal((await store.getGraph(first.graphId))!.status, "completed");
  await orchestrator.advanceGraph(second.graphId); assert.equal(sent.length, 2);
});

test("实际传输上下游报告并通过 Join Barrier，Worker 使用受限产物工具发布", async (t) => {
  const { store, sent, orchestrator } = graphFixture(t);
  const a = { ...node("A"), operation: "analyze" as const, producedArtifacts: [{ name: "report.json", contentType: "application/json" }], acceptanceCriteria: [{ type: "artifact_exists" as const, expected: "report.json", description: "report" }] };
  const b = { ...node("B"), dependencies: ["A"], requiredArtifacts: [{ name: "report.json", producerNodeId: "A" }] };
  const graph = await orchestrator.createGraph({ reasoning: "test", requiresMultiAgent: true, parentGoal: "analyze and aggregate", nodes: [a, b] }); await orchestrator.startGraph(graph.graphId);
  assert.equal(sent.length, 1);
  const worker = new WorkerGraphArtifacts(sent[0]!.graphContext!); worker.publish("report.json", '{"ok":true}');
  await completeSimulatedTask(store, orchestrator, graph.graphId, (await store.getGraphNode(graph.graphId, "A"))!.taskId!, "report ready", worker.finish("done"));
  assert.equal(sent.length, 2);
  const consumer = new WorkerGraphArtifacts(sent[1]!.graphContext!);
  const read = await consumer.tools().find((tool) => tool.name === "read_graph_artifact")!.execute({ name: "report.json" });
  assert.equal((read as any).content, '{"ok":true}');
  assert.throws(() => consumer.publish("undeclared.txt", "content"), /not declared/);
});

test("SIMULATED_INTEGRATION: rejected replan is corrected, retried, produces artifact and completes the join", async t => {
  const { store, sent, orchestrator, scheduler } = graphFixture(t);
  await store.createGoalRun({ goalRunId: "goal-replan", conversationId: "conv", userMessageId: "msg", rootGoal: "inspect and join", status: "running", currentStage: "awaiting_verification", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  scheduler.createTask = async (options: CreateTaskOptions) => {
    const task = { taskId: `task-${sent.length}`, nodeId: options.nodeId, projectId: options.projectId, runId: `run-${sent.length}`, dispatchOptions: { graphContext: options.graphContext }, goal: options.goal, status: "running" as const, dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now() };
    sent.push(options); await store.saveTaskWithGoal(task, "goal-replan"); await options.beforeDispatch?.(task); return task;
  };
  const source = { ...node("source"), operation: "analyze" as const, producedArtifacts: [{ name: "report.json", contentType: "application/json" }], acceptanceCriteria: [{ type: "artifact_exists" as const, expected: "report.json", description: "report" }] };
  const join = { ...node("join"), dependencies: ["source"], requiredArtifacts: [{ name: "report.json", producerNodeId: "source" }] };
  const graph = await defaultTraceContext.run({ projectId: "p", sessionId: "conv", traceId: "trace", goalRunId: "goal-replan" }, () => orchestrator.createGraph({ reasoning: "fixture", requiresMultiAgent: true, parentGoal: "inspect and join", nodes: [source, join] }));
  await orchestrator.startGraph(graph.graphId);
  const first = (await store.getGraphNode(graph.graphId, "source"))!.taskId!;
  await store.updateTaskStatus(first, "failed", { error: "first attempt failed" });
  await orchestrator.handleNodeTaskFailed(graph.graphId, first, "first attempt failed");
  const prompts: string[] = [];
  const replanner = new GraphReplanner(store, orchestrator, { chat: async (messages: any[]) => {
    prompts.push(messages[1].content);
    return { content: JSON.stringify(prompts.length === 1 ? { reason: "invalid", rewireDependencies: [{ nodeId: "join", removeDependencies: ["source"] }] } : { reason: "retry", retryNodeIds: ["source"] }) };
  } } as any);
  const result = await replanner.replanWithLlm({ graphId: graph.graphId, trigger: "task_failed", failedNodeId: "source" });
  assert.equal(result.success, true);
  assert.equal(prompts.length, 2);
  const second = (await store.getGraphNode(graph.graphId, "source"))!.taskId!;
  assert.notEqual(second, first);
  assert.equal((await store.getTask(second))?.dispatchOptions?.graphContext?.retryOfTaskId, first);
  const worker = new WorkerGraphArtifacts(sent[1]!.graphContext!);
  worker.publish("report.json", '{"ok":true}');
  await store.updateTaskStatus(second, "completed");
  await completeSimulatedTask(store, orchestrator, graph.graphId, second, "report ready", worker.finish("done"));
  const joinTask = (await store.getGraphNode(graph.graphId, "join"))!.taskId!;
  assert.ok(joinTask);
  await store.updateTaskStatus(joinTask, "completed");
  await completeSimulatedTask(store, orchestrator, graph.graphId, joinTask, "joined");
  assert.equal((await store.getGraph(graph.graphId))?.status, "completed");
  assert.equal((await store.getTask(first))?.status, "failed");
  assert.equal((await store.listArtifacts(graph.graphId)).length, 1);
  assert.equal((await store.listGraphEvents(graph.graphId)).filter(event => event.eventType === "graph.replan_rejected").length, 1);
  await store.saveTaskWithGoal({ taskId: "task-scout", runId: "run-scout", nodeId: "worker", projectId: "project", goal: "background inspection", status: "running", dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now(), dispatchOptions: { contextOverrides: { taskType: "scout", goalRunId: "goal-replan" } } }, "goal-replan");
  assert.equal((await processGoalRun(store, "goal-replan")).status, "running");
  assert.equal((await store.getGoalRun("goal-replan"))?.finalReport, undefined);
  await store.appendEvents([{ taskId: "task-scout", runId: "run-scout", nodeId: "worker", seq: 1, eventType: "discovery.report_persisted", timestamp: Date.now(), data: { report: { nodeId: "worker", candidates: [{ projectName: "fixture", canonicalPath: "/project/fixture", evidences: [{ sourcePath: "/project/fixture/README.md", matchedContent: "fixture" }] }] } } }]);
  await store.updateTaskStatus("task-scout", "completed");
  const goal = await processGoalRun(store, "goal-replan");
  // The retried source attempt and the join barrier both produced attempt-bound receipts,
  // so the replanned revision covers the goal instead of degrading to a partial result.
  assert.equal(goal.status, "completed");
  assert.equal(goal.reportEvidence?.coverageChecks?.every(check => check.status === "verified"), true);
  assert.deepEqual(goal.linkedGraphIds, [graph.graphId]);
  assert.equal(goal.linkedTaskIds.length, 4);
  assert.deepEqual(goal.reportEvidence?.artifactIds, (await store.listArtifacts(graph.graphId)).map(artifact => artifact.artifactId));
  assert.deepEqual(goal.reportHistory?.at(-1)?.evidence?.artifacts, (await store.listArtifacts(graph.graphId)).map(artifact => ({ artifactId: artifact.artifactId, sha256: artifact.sha256, producerTaskId: artifact.producerTaskId })));
  assert.match(goal.finalReport!, /fixture/);
  assert.equal((await processGoalRun(store, "goal-replan")).reportRevision, goal.reportRevision);
});

test("规划不再凭关键词扩大用户目标，显式 DAG 保留完整约束，默认任务可通过验收", async (t) => {
  const { store, orchestrator, sent } = graphFixture(t);
  const planner = new AutonomousPlanner(); const goal = "仅检查本地，不访问云端，然后汇总报告";
  const { proposal } = await planner.planGoal(goal);
  assert.equal(proposal.nodes.length, 1); assert.equal(proposal.nodes[0]!.goal, goal);
  assert.notEqual(proposal.nodes[0]!.acceptanceCriteria?.[0]?.type, "custom");
  proposal.nodes[0]!.candidateNodeId = "worker"; proposal.nodes[0]!.candidateProjectId = "project";
  const graph = await orchestrator.createGraph(proposal); await orchestrator.startGraph(graph.graphId);
  const worker = new WorkerGraphArtifacts(sent[0]!.graphContext!);
  await completeSimulatedTask(store, orchestrator, graph.graphId, (await store.listGraphNodes(graph.graphId))[0]!.taskId!, "inspection complete", worker.finish("inspection complete"));
  assert.equal((await store.getGraph(graph.graphId))!.status, "completed");
  const { proposal: explicit } = await planner.planGoal(goal, undefined, [node("one"), { ...node("two"), dependencies: ["one"] }]);
  assert.equal(explicit.nodes.length, 2); assert.ok(explicit.nodes.every((item) => item.goal.includes(goal)));
});

test("SIMULATED_INTEGRATION: 真实 WebSocket（模拟 Worker） 将 Worker 产物传到另一节点，完成下游验收与整图收敛", async (t) => {
  const { default: http } = await import("node:http");
  const { once } = await import("node:events");
  const { WebSocket } = await import("ws");
  const { NodeRegistry } = await import("../src/cluster/coordinator/node-registry.js");
  const { InviteManager } = await import("../src/cluster/identity/invite-manager.js");
  const { TaskScheduler } = await import("../src/cluster/coordinator/task-scheduler.js");
  const { WssGateway } = await import("../src/cluster/coordinator/wss-gateway.js");
  const { createEnvelope, encodeEnvelope } = await import("../src/cluster/protocol/message-codec.js");
  const { store, artifacts } = graphFixture(t);
  const invites = new InviteManager(); const registry = new NodeRegistry(store, invites);
  const scheduler = new TaskScheduler(store, registry, "coordinator");
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler, artifactService: artifacts, validator: new RoutingValidator(store, registry) });
  const server = http.createServer(); const gateway = new WssGateway({ server, store, registry, coordinatorNodeId: "coordinator", scheduler, graphOrchestrator: orchestrator });
  const sockets: InstanceType<typeof WebSocket>[] = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); gateway.close(); scheduler.stop(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  async function connect(nodeId: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/ws/cluster`); sockets.push(socket);
    const queued: any[] = []; const waiting = new Map<string, (value: any) => void>();
    socket.on("message", (raw) => { const message = JSON.parse(String(raw)); const receiver = waiting.get(message.type); if (receiver) { waiting.delete(message.type); receiver(message); } else queued.push(message); });
    const next = (type: string): Promise<any> => {
      const index = queued.findIndex((item) => item.type === type); if (index !== -1) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => { const timer = setTimeout(() => { waiting.delete(type); reject(new Error(`Timeout: ${type}`)); }, 2000); waiting.set(type, (value) => { clearTimeout(timer); resolve(value); }); });
    };
    await once(socket, "open");
    socket.send(encodeEnvelope(createEnvelope("node.hello", { nodeId, name: nodeId, platform: "linux", arch: "x64", hostname: "test", capabilities: [], projects: [], maxConcurrentRuns: 1, inviteCode: invites.createInvite().inviteCode }, nodeId, "coordinator")));
    await next("node.authenticated");
    await store.saveCatalogRevision(nodeId, 1, simulatedCapabilities("linux"));
    await store.upsertProjectCatalog([{ nodeId, projectId: "project", name: "test", status: "active", visibility: "summary", capabilities: [], technologies: [], registeredAt: Date.now(), lastIndexedAt: Date.now(), revision: 1, updatedAt: Date.now() } as any]);
    return { socket, next };
  }
  const producer = await connect("producer"); const consumer = await connect("consumer");
  const graph = await orchestrator.createGraph({ parentGoal: "reports", reasoning: "test", requiresMultiAgent: true, nodes: [
    { ...node("A"), candidateNodeId: "producer", producedArtifacts: [{ name: "report.json", contentType: "application/json" }], acceptanceCriteria: [{ type: "artifact_exists", expected: "report.json", description: "report" }] },
    { ...node("B"), candidateNodeId: "consumer", dependencies: ["A"], requiredArtifacts: [{ name: "report.json", producerNodeId: "A" }], producedArtifacts: [{ name: "result.md", contentType: "text/markdown" }], acceptanceCriteria: [{ type: "artifact_exists", expected: "result.md", description: "summary" }] },
  ] });
  await orchestrator.startGraph(graph.graphId);
  const dispatch = (await producer.next("task.dispatch")).payload;
  const output = new WorkerGraphArtifacts(dispatch.graphContext); output.publish("report.json", '{"verified":true}');
  await recordSimulatedExecution(store, dispatch.taskId);
  producer.socket.send(encodeEnvelope(createEnvelope("task.completed", { taskId: dispatch.taskId, runId: dispatch.runId, nodeId: "producer", finalAnswer: "report", producedArtifacts: output.finish("report"), totalToolCalls: 1, completedAt: Date.now(), durationMs: 1 }, "producer", "coordinator")));
  const downstream = (await consumer.next("task.dispatch")).payload;
  assert.equal(downstream.graphContext.inputs[0].content, '{"verified":true}');
  const finish = new WorkerGraphArtifacts(downstream.graphContext);
  await recordSimulatedExecution(store, downstream.taskId);
  consumer.socket.send(encodeEnvelope(createEnvelope("task.completed", { taskId: downstream.taskId, runId: downstream.runId, nodeId: "consumer", finalAnswer: "verified summary", producedArtifacts: finish.finish("verified summary"), totalToolCalls: 1, completedAt: Date.now(), durationMs: 1 }, "consumer", "coordinator")));
  const deadline = Date.now() + 2000;
  while ((await store.getGraph(graph.graphId))!.status !== "completed" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await store.getGraph(graph.graphId))!.status, "completed");
});

test("Worker 初始化失败也返回终态，不遗留运行标记或事件转发器", async () => {
  const { WorkerTaskRunner } = await import("../src/cluster/worker/worker-task-runner.js");
  const messages: any[] = [];
  const runner = new WorkerTaskRunner({ taskId: "initialization", runId: "run", projectId: "project", goal: "inspect", dispatchAttempt: 1, connectionGeneration: 1 },
    { resolveAndValidateProject() { throw new Error("simulated initialization failure"); } } as any,
    "worker", "coordinator", { readyState: 1, send(raw: string) { messages.push(JSON.parse(raw)); } } as any);
  await runner.run();
  assert.equal(messages.find((message) => message.type === "task.failed")?.payload.error, "simulated initialization failure");
  assert.equal(runner.cancel(), false);
});

test("根节点路由受阻时传播给下游，整图收敛失败而不是永久运行", async (t) => {
  const { store, scheduler } = graphFixture(t);
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: scheduler as any });
  const graph = await orchestrator.createGraph({ parentGoal: "unroutable", reasoning: "test", requiresMultiAgent: true, nodes: [node("A"), { ...node("B"), dependencies: ["A"] }] });
  await orchestrator.startGraph(graph.graphId);
  assert.equal((await store.getGraph(graph.graphId))!.status, "failed");
  assert.equal((await store.getGraphNode(graph.graphId, "B"))!.status, "blocked");
});

test("Worker 返回未声明产物时记录节点失败，不遗留运行态", async (t) => {
  const { store, orchestrator } = graphFixture(t);
  const graph = await orchestrator.createGraph({ parentGoal: "invalid artifact", reasoning: "test", requiresMultiAgent: false, nodes: [node("A")] });
  await orchestrator.startGraph(graph.graphId);
  await completeSimulatedTask(store, orchestrator, graph.graphId, (await store.getGraphNode(graph.graphId, "A"))!.taskId!, "done", [{ name: "undeclared", content: "unexpected" }]);
  assert.equal((await store.getGraph(graph.graphId))!.status, "failed");
  assert.match((await store.getGraphNode(graph.graphId, "A"))!.error!, /undeclared/);
});
