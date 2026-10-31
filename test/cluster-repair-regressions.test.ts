import { registerFixtureNodes } from "./helpers/registered-node.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { InMemoryClusterStore, type ClusterTaskRecord } from "../src/cluster/storage/cluster-store.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import { WssGateway } from "../src/cluster/coordinator/wss-gateway.js";
import { createEnvelope } from "../src/cluster/protocol/message-codec.js";
import { ExecutionJournal } from "../src/cluster/worker/execution-journal.js";
import { WorkerEventForwarder } from "../src/cluster/worker/event-forwarder.js";
import { SubmitDiscoveryReportTool } from "../src/cluster/discovery/scout-tools.js";
import { AutonomousDiscoveryService } from "../src/cluster/discovery/autonomous-discovery-service.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { ResultVerifier } from "../src/cluster/graph/result-verifier.js";
import { SseConnection } from "../apps/web/src/services/sse.js";

const task = (overrides: Partial<ClusterTaskRecord> = {}): ClusterTaskRecord => ({ taskId: "t", runId: "r", nodeId: "worker", projectId: "p", goal: "goal", status: "running", dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now(), ...overrides });

test("离线派发必须落入 Outbox，重启调度后沿用原 task/run/message 身份", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  let online = false;
  const sent: any[] = [];
  const registry = { getConnection: () => online ? { generation: 2, ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) } } : undefined } as unknown as NodeRegistry;
  const scheduler = new TaskScheduler(store, registry, "coordinator");
  const created = await scheduler.createTask({ nodeId: "worker", projectId: "p", goal: "write once" });
  assert.equal(created.status, "queued");
  const outbox = await store.pollPendingOutbox();
  assert.equal(outbox.length, 1);
  online = true;
  await new TaskScheduler(store, registry, "coordinator").flushOutbox();
  assert.equal(sent[0].messageId, outbox[0].messageId);
  assert.equal(sent[0].payload.runId, created.runId);
  assert.equal(sent[0].payload.connectionGeneration, 2);
  await store.updateTaskStatus(created.taskId, "accepted");
  await scheduler.flushOutbox();
  assert.equal((await store.pollPendingOutbox()).length, 0);
});

test("终态不能被迟到 started/progress/相反终态覆盖", async () => {
  const store = new InMemoryClusterStore();
  await store.saveTask(task({ status: "cancelled" }));
  for (const status of ["running", "completed", "failed"] as const) await store.updateTaskStatus("t", status);
  assert.equal((await store.getTask("t"))!.status, "cancelled");
});

test("Steer/取消必须等待匹配 ACK，取消 ACK 不能宣告任务已停止", async () => {
  const store = new InMemoryClusterStore();
  await store.saveTask(task());
  let scheduler: TaskScheduler;
  const registry = { getConnection: () => ({ ws: { readyState: 1, send: (raw: string) => {
    const p = JSON.parse(raw).payload;
    assert.equal(scheduler.handleControlAck({ ...p, taskId: "other", status: "applied" }), false);
    scheduler.handleControlAck({ ...p, status: "queued" });
  } } }) } as unknown as NodeRegistry;
  scheduler = new TaskScheduler(store, registry, "coordinator", 50);
  const result = await scheduler.sendControl("t", "cancel");
  assert.equal(result.status, "queued");
  assert.equal((await store.getTask("t"))!.status, "cancelling");
});

test("Worker ACK 缺失必须返回未确认，不能报告控制成功", async () => {
  const store = new InMemoryClusterStore();
  await store.saveTask(task());
  const registry = { getConnection: () => ({ ws: { readyState: 1, send() {} } }) } as unknown as NodeRegistry;
  const result = await new TaskScheduler(store, registry, "coordinator", 5).sendControl("t", "steer", { steerContent: "stop writing" });
  assert.equal(result.success, false);
  assert.equal(result.status, "timeout");
});

test("真实 WebSocket 拒绝未认证、跨节点及过期 run 的任务状态更新", async (t) => {
  const store = new InMemoryClusterStore();
  await store.saveTask(task());
  const invites = new InviteManager();
  const registry = new NodeRegistry(store, invites);
  const server = http.createServer();
  const gateway = new WssGateway({ server, store, registry, coordinatorNodeId: "coordinator" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/ws/cluster`);
  t.after(async () => { ws.terminate(); gateway.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  await once(ws, "open");
  const send = async (type: any, payload: any, source = "worker") => {
    const response = once(ws, "message");
    ws.send(JSON.stringify(createEnvelope(type, payload, source, "coordinator")));
    return JSON.parse(String((await response)[0]));
  };
  assert.equal((await send("task.completed", { taskId: "t", runId: "r", finalAnswer: "forged" })).payload.code, "UNAUTHENTICATED");
  const invite = invites.createInvite();
  const authenticated = await send("node.hello", { nodeId: "worker", name: "test", platform: "linux", arch: "x64", hostname: "test", capabilities: [], projects: [], maxConcurrentRuns: 1, inviteCode: invite.inviteCode });
  assert.equal(authenticated.type, "node.authenticated");
  assert.equal((await send("task.completed", { taskId: "t", runId: "old", nodeId: "worker" })).payload.code, "TASK_MISMATCH");
  assert.equal((await send("task.completed", { taskId: "t", runId: "r" }, "other")).payload.code, "UNAUTHENTICATED");
  assert.equal((await store.getTask("t"))!.status, "running");
});

test("Worker 持久账本跨实例阻止重入，未确认事件可跨重启恢复", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-journal-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = new ExecutionJournal(dir);
  assert.equal(journal.claim("t", "r"), true);
  assert.equal(new ExecutionJournal(dir).claim("t", "r"), false);
  const forwarder = new WorkerEventForwarder("t", "r", "worker", "coordinator", 500, journal.eventPath("t"));
  forwarder.emitEvent("task.started", {});
  forwarder.emitEvent("task.completed", { finalAnswer: "done" });
  const recovered = new WorkerEventForwarder("t", "r", "worker", "coordinator", 500, journal.eventPath("t"));
  assert.equal(recovered.getPendingCount(), 2);
  recovered.handleEventAck(99);
  assert.equal(recovered.getPendingCount(), 2);
  recovered.handleEventAck(1);
  assert.equal(new WorkerEventForwarder("t", "r", "worker", "coordinator", 500, journal.eventPath("t")).getPendingCount(), 1);
  journal.finish(createEnvelope("task.completed", { taskId: "t", runId: "r", finalAnswer: "done" }, "worker", "coordinator"));
  assert.equal(new ExecutionJournal(dir).get("t")?.terminal?.type, "task.completed");
});

test("历史回答即使包含 Scout 标题和看似完整的证据，也不能冒充持久化执行收据", async () => {
  const store = new InMemoryClusterStore();
  const registry = new NodeRegistry(store, new InviteManager());
  await store.saveNode({ nodeId: "worker", name: "worker", role: "worker", platform: "linux", arch: "x64", hostname: "test", tokenHash: "test", status: "offline", lastSeenAt: 0, metadata: {}, createdAt: 0, updatedAt: 0 });
  const reportTool = new SubmitDiscoveryReportTool();
  const report = await reportTool.execute({ candidates: [{ projectName: "知识库", projectSummary: "RAG retrieval project", canonicalPath: "/projects/rag", evidences: [{ evidenceType: "file_content", sourcePath: "/projects/rag/README.md", matchedContent: "Knowledge base with RAG retrieval", confidence: 0.9 }] } as any], summary: "Found RAG" });
  assert.equal(report.candidates.length, 1);
  await store.saveTask(task({ status: "completed", goal: "[分布式 Scout 探查任务] RAG", finalAnswer: JSON.stringify(report) }));
  for (let i = 0; i < 2; i++) await new AutonomousDiscoveryService({ store, registry }).recoverHistoricalReports();
  assert.equal((await store.listProjectsCatalog()).length, 0);
  const memories = await store.listMemoryIndex({});
  assert.equal(memories.length, 0);
});

test("无路由任务不得使用硬编码机器；并发推进同一节点只能派发一次", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  const scheduler = new TaskScheduler(store, new NodeRegistry(store, new InviteManager()), "coordinator");
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler, validator: { validateCandidate: async () => ({ valid: true, code: "VALID", reason: "Unit-test target" }) } });
  const unroutable = await orchestrator.createGraph({ parentGoal: "missing route", nodes: [{ nodeId: "A", title: "A", goal: "A" }] } as any);
  await orchestrator.startGraph(unroutable.graphId);
  assert.equal((await store.listGraphNodes(unroutable.graphId))[0].status, "blocked");
  assert.equal((await store.listTasks()).length, 0);
  const graph = await orchestrator.createGraph({ parentGoal: "once", nodes: [{ nodeId: "A", title: "A", goal: "A", operation: "analyze", candidateNodeId: "worker", candidateProjectId: "p" }] } as any);
  await store.updateGraphStatus(graph.graphId, "running");
  await Promise.all(Array.from({ length: 10 }, () => orchestrator.advanceGraph(graph.graphId)));
  assert.equal((await store.listTasks()).length, 1);
});

test("没有物理修改证据不能以非空摘要通过验收，未通过验收不放行下游", async () => {
  const store = new InMemoryClusterStore();
  const verifier = new ResultVerifier(store);
  assert.equal((await verifier.verifyNode({ graphId: "g", graphNodeId: "A", taskId: "t", acceptanceCriteria: [{ type: "file_modified", description: "patch exists" }], resultSummary: "I changed all requested files" })).status, "failed");
  const scheduler = new TaskScheduler(store, new NodeRegistry(store, new InviteManager()), "coordinator");
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler, validator: { validateCandidate: async () => ({ valid: true, code: "VALID", reason: "Unit-test target" }) } });
  const graph = await orchestrator.createGraph({ parentGoal: "verify", nodes: [{ nodeId: "A", title: "A", goal: "A", candidateNodeId: "worker", candidateProjectId: "p", acceptanceCriteria: [{ type: "test_exit_code", expected: 0, description: "tests pass" }] }, { nodeId: "B", title: "B", goal: "B", dependencies: ["A"] }] } as any);
  await orchestrator.startGraph(graph.graphId);
  const a = (await store.listGraphNodes(graph.graphId))[0];
  await orchestrator.handleNodeTaskCompleted(graph.graphId, a.taskId!, "done");
  assert.equal((await store.listGraphNodes(graph.graphId)).find((n) => n.nodeId === "B")!.status, "blocked");
});

test("SSE 断线会安排重连，订阅可恢复关闭后的连接，普通事件正确解包", (t) => {
  const previous = globalThis.EventSource;
  class FakeEventSource {
    onopen?: () => void; onerror?: () => void; onmessage?: (event: any) => void;
    close() {} addEventListener() {}
  }
  globalThis.EventSource = FakeEventSource as any;
  const sse = new SseConnection("/test");
  t.after(() => { sse.close(); globalThis.EventSource = previous; });
  const received: any[] = [];
  let unsubscribe = sse.subscribe((event) => received.push(event));
  const source = (sse as any).eventSource as FakeEventSource;
  source.onmessage!({ data: JSON.stringify({ eventType: "task.completed", taskId: "t", seq: 2, data: { finalAnswer: "done" } }), lastEventId: "2" });
  assert.equal(received[0].type, "task.completed");
  assert.equal(received[0].data.finalAnswer, "done");
  source.onerror!();
  assert.ok((sse as any).reconnectTimer);
  unsubscribe();
  unsubscribe = sse.subscribe(() => {});
  assert.ok((sse as any).eventSource);
  unsubscribe();
});

test("本地集群存储跨实例恢复任务、Outbox、目录和记忆", async (t) => {
  const { createLocalClusterStore } = await import("../src/cluster/storage/local-cluster-store.js");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nash-local-store-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.bin");
  const first = createLocalClusterStore(file);
  await first.saveTask(task({ status: "created", dispatchOptions: { maxSteps: 9, contextOverrides: { isDiscovery: true } } }));
  await first.upsertMemoryIndex([{ entryId: "m", nodeId: "worker", projectId: "p", topic: "知识库", summary: "RAG", keywords: ["rag"], sourceReference: "README.md", visibility: "retrievable", confidence: 1, revision: 1, updatedAt: 0 }]);
  const second = createLocalClusterStore(file);
  assert.equal((await second.getTask("t"))?.runId, "r");
  assert.equal((await second.listMemoryIndex({})).length, 1);
  const registry = new NodeRegistry(second, new InviteManager());
  await new TaskScheduler(second, registry, "coordinator").flushOutbox();
  const outbox = await second.pollPendingOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].payload.maxSteps, 9);
  assert.equal(outbox[0].payload.contextOverrides.isDiscovery, true);
  assert.equal((await createLocalClusterStore(file).getTask("t"))?.status, "queued");
});

test("没有物理证据的历史模型猜测不得被合成为项目或记忆", async () => {
  const store = new InMemoryClusterStore();
  await store.saveNode({ nodeId: "worker", name: "worker", role: "worker", platform: "linux", arch: "x64", hostname: "test", tokenHash: "test", status: "offline", lastSeenAt: 0, metadata: {}, createdAt: 0, updatedAt: 0 });
  await store.saveTask(task({ status: "completed", goal: "Scout probe", finalAnswer: JSON.stringify({ candidates: [{ projectName: "猜测的知识库", projectSummary: "Possibly exists" }] }) }));
  await new AutonomousDiscoveryService({ store, registry: new NodeRegistry(store, new InviteManager()) }).recoverHistoricalReports();
  assert.equal((await store.listProjectsCatalog()).length, 0);
  assert.equal((await store.listMemoryIndex({})).length, 0);
});

test("ephemeral Coordinator 的产物也必须隔离并在关闭后删除", async () => {
  const { ClusterCoordinator } = await import("../src/cluster/coordinator/cluster-coordinator.js");
  const coordinator = new ClusterCoordinator({ ephemeral: true, listenHost: "127.0.0.1", listenPort: 0 });
  let storagePath = "";
  try {
    await coordinator.start();
    const artifact = await coordinator.getArtifactService()!.publishArtifact({ graphId: "g", producerTaskId: "t", producerNodeId: "worker", name: "sample.json", content: "{}", contentType: "application/json" });
    storagePath = artifact.storagePath;
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), fs.realpathSync.native(storagePath));
    assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    assert.ok(fs.existsSync(storagePath));
  } finally { await coordinator.stop(); }
  assert.equal(fs.existsSync(storagePath), false);
});
