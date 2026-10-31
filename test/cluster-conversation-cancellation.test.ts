import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { ClusterApiHandler } from "../src/cluster/coordinator/api-server.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { EventBus } from "../src/observability/event-bus.js";
import { AutonomousDiscoveryService } from "../src/cluster/discovery/autonomous-discovery-service.js";
import { DiscoverClusterResourcesTool } from "../src/cluster/tools/cluster-tools.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";
import { registerFixtureNodes } from "./helpers/registered-node.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("并行 Scout 保留各自会话归属，缺少结构化收据时逐节点广播失败", async (t) => {
  const store = new InMemoryClusterStore(); const eventBus = new EventBus(); t.after(() => eventBus.clear());
  const events: any[] = []; eventBus.subscribe("*", (event) => { events.push(event); });
  const linked = new Map<string, string[]>(); let sequence = 0;
  const scheduler = { createTask: async (options: any) => {
    const task = { taskId: `scout-${++sequence}`, nodeId: options.nodeId, projectId: options.projectId,
      goal: options.goal, status: "completed", finalAnswer: "No matching project", dispatchOptions: { contextOverrides: options.contextOverrides } };
    await store.saveTask(task as any);
    await options.beforeDispatch(task);
    assert.ok(linked.get(options.contextOverrides.conversationId)?.includes(task.taskId));
    return task;
  } };
  const service = new AutonomousDiscoveryService({ store, eventBus, scheduler: scheduler as any,
    registry: { getConnection: () => ({}), listOnlineConnections: () => [] } as any,
    validator: { validateReport: async () => ({ valid: true, validatedCandidates: [] }) } as any });
  await Promise.all(["first", "second"].map(async (id) => {
    const tool = new DiscoverClusterResourcesTool(service, { conversationId: id, onTaskDispatched: async (taskId) => {
      await Promise.resolve(); linked.set(id, [...(linked.get(id) ?? []), taskId]);
    } });
    await tool.execute({ query: id, nodeId: id, timeoutMs: 1000 });
  }));
  assert.equal(linked.get("first")?.length, 1); assert.equal(linked.get("second")?.length, 1);
  for (const event of events) {
    assert.equal(event.data.conversationId, event.data.nodeId ?? event.data.query);
    if (event.data.taskId) assert.ok(linked.get(event.data.conversationId)?.includes(event.data.taskId));
  }
  assert.equal(events.filter(e => e.type === "discovery.scout_failed").length, 2);
  assert.equal(events.filter(e => e.type === "discovery.scout_completed").length, 0);
});

test("探查中刷新恢复真实阶段与全部任务，单 Scout 结果不冒充最终答复，最终消息落盘后广播", async (t) => {
  const entered = deferred(); const release = deferred(); t.after(release.resolve);
  const mainAgent = { chat: async (_id: string, _text: string, options: any) => {
    await Promise.all(["scout-A", "scout-B"].map(id => options.onScoutTaskDispatched(id)));
    options.onProgress({ phase: "synthesizing", detail: "探查已结束，正在汇总证据", timestamp: 123 });
    entered.resolve(); await release.promise;
    return { assistantResponse: "汇总后的唯一最终答复", state: "completed", durationMs: 1 };
  } };
  const { store, eventBus, request } = await fixture(t, mainAgent);
  for (const taskId of ["scout-A", "scout-B"]) await store.saveTask({ taskId, status: "completed", finalAnswer: "Scout internal report",
    dispatchOptions: { contextOverrides: { isDiscovery: true } } } as any);
  let persistedAnswer: Promise<any> | undefined;
  eventBus.subscribe("conversation.message_created" as any, (event: any) => {
    if (event.data.message.sender === "assistant") persistedAnswer = store.getConversation("chat");
  });
  const send = request("/messages", { method: "POST", body: JSON.stringify({ content: "探查项目" }) }); await entered.promise;
  const snapshot = await (await request()).json() as any;
  assert.deepEqual(snapshot.conversation.linkedTaskIds.sort(), ["scout-A", "scout-B"]);
  assert.equal(snapshot.activeTurn.progress.phase, "synthesizing");
  assert.equal(snapshot.conversation.messages.length, 1);
  release.resolve(); await send;
  assert.equal((await persistedAnswer).messages.at(-1).content, "汇总后的唯一最终答复");
  const final = await (await request()).json() as any;
  assert.equal(final.isRunning, false); assert.equal(final.conversation.messages.length, 2);
});

async function fixture(t: TestContext, mainAgent?: any, scheduler: any = {}) {
  const store = new InMemoryClusterStore();
  const eventBus = new EventBus();
  const handler = new ClusterApiHandler({ store, eventBus, mainAgent, scheduler,
    registry: { listOnlineConnections: () => [] } as any, inviteManager: {} as any,
    coordinatorNodeId: "test", adminApiKey: "test-key" });
  const server = http.createServer((req, res) => { void handler.handleRequest(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => {
    handler.close(); eventBus.clear(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await store.saveConversation({ id: "chat", title: "test", createdAt: Date.now(), updatedAt: Date.now(), messages: [], linkedTaskIds: [], linkedGraphIds: [] });
  const request = (path = "", options: RequestInit = {}) => fetch(`${url}/api/cluster/conversations/chat${path}`, {
    ...options, headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
  });
  return { store, eventBus, request };
}

test("legacy planner fallback creates its graph under the originating GoalRun", async t => {
  const store = new InMemoryClusterStore();
  await store.saveConversation({ id: "chat", title: "test", createdAt: 1, updatedAt: 1, messages: [] });
  const scheduler = {} as any;
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler });
  orchestrator.startGraph = async graphId => (await store.getGraph(graphId))!;
  const proposal = { parentGoal: "inspect", reasoning: "fixture", requiresMultiAgent: true, nodes: [{ nodeId: "n", title: "n", goal: "n", dependencies: [] }] };
  const handler = new ClusterApiHandler({ store, scheduler, orchestrator, planner: { planGoal: async () => ({ proposal, validation: { valid: true } }) } as any,
    registry: { listOnlineConnections: () => [] } as any, inviteManager: {} as any, coordinatorNodeId: "test", adminApiKey: "test-key" });
  const server = http.createServer((req, res) => { void handler.handleRequest(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/cluster/conversations/chat/messages`, {
    method: "POST", headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" }, body: JSON.stringify({ content: "inspect" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { graphId: string };
  const goals = await store.listGoalRuns("chat");
  assert.equal(goals.length, 1);
  assert.deepEqual(goals[0]?.linkedGraphIds, [body.graphId]);
});

test("legacy single-task routing fallback retains GoalRun ownership", async t => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  await store.saveConversation({ id: "chat", title: "test", createdAt: 1, updatedAt: 1, messages: [] });
  const scheduler = new TaskScheduler(store, { getConnection: () => undefined } as any, "test");
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler });
  const router = { runAutonomous: async () => {
    const task = await scheduler.createTask({ nodeId: "worker", projectId: "p", goal: "inspect", contextOverrides: { readOnly: true } });
    return { dispatchResult: { taskId: task.taskId }, decision: { selectedCandidate: { nodeId: "worker", projectId: "p" } } };
  } };
  const handler = new ClusterApiHandler({ store, scheduler, orchestrator, semanticRouter: router as any,
    planner: { planGoal: async () => ({ proposal: { requiresMultiAgent: false }, validation: { valid: true } }) } as any,
    registry: { listOnlineConnections: () => [] } as any, inviteManager: {} as any, coordinatorNodeId: "test", adminApiKey: "test-key" });
  const server = http.createServer((req, res) => { void handler.handleRequest(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/cluster/conversations/chat/messages`, {
    method: "POST", headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" }, body: JSON.stringify({ content: "inspect" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { taskId: string };
  const goals = await store.listGoalRuns("chat");
  assert.deepEqual(goals[0]?.linkedTaskIds, [body.taskId]);
  assert.equal((await store.getTask(body.taskId))?.dispatchOptions?.contextOverrides?.goalRunId, goals[0]?.goalRunId);
});

test("clarification stays on its GoalRun and the next user goal gets a distinct identity", async t => {
  const seen: string[] = [];
  const mainAgent = { chat: async (_id: string, _text: string, options: any) => {
    seen.push(options.goalRunId);
    return seen.length === 1
      ? { assistantResponse: "请选择", state: "waiting_user_clarification", pendingClarification: { options: [{ id: "choice", nodeId: "node", label: "选择节点" }] }, durationMs: 1 }
      : { assistantResponse: "已收到", state: "completed", durationMs: 1 };
  } };
  const { store, request } = await fixture(t, mainAgent);
  assert.equal((await request("/messages", { method: "POST", body: JSON.stringify({ content: "第一个目标" }) })).status, 200);
  assert.equal((await request("/messages", { method: "POST", body: JSON.stringify({ selection: { optionId: "choice" } }) })).status, 200);
  assert.equal((await request("/messages", { method: "POST", body: JSON.stringify({ content: "第二个目标" }) })).status, 200);
  assert.equal(seen[0], seen[1]);
  assert.notEqual(seen[0], seen[2]);
  assert.equal((await store.listGoalRuns("chat")).length, 2);
  const conversation = (await store.getConversation("chat"))!;
  assert.equal(conversation.messages[0]?.metadata?.goalRunId, seen[0]);
  assert.equal(conversation.messages[2]?.metadata?.goalRunId, seen[0]);
  assert.equal(conversation.messages[4]?.metadata?.goalRunId, seen[2]);
});

test("a GoalRun child completing cannot replace the conversation interim report", async t => {
  let store!: InMemoryClusterStore;
  const mainAgent = { chat: async (_id: string, _text: string, options: any) => {
    await store.saveTaskWithGoal({ taskId: "task-owned", runId: "run", nodeId: "worker", projectId: "p", goal: "inspect", status: "running", dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now() }, options.goalRunId, options.goalTurnFence);
    return { assistantResponse: "后台持续执行中", state: "task_dispatched", createdTaskId: "task-owned", durationMs: 1 };
  } };
  const fixtureResult = await fixture(t, mainAgent); store = fixtureResult.store;
  await fixtureResult.request("/messages", { method: "POST", body: JSON.stringify({ content: "inspect" }) });
  const message = (await store.getConversation("chat"))!.messages.at(-1)!;
  assert.equal(message.metadata?.reportKind, "interim");
  assert.match(message.content, /目标覆盖范围尚待最终核验/);
  await store.updateTaskStatus("task-owned", "completed", { finalAnswer: "unverified child result" });
  await new Promise(resolve => setTimeout(resolve, 1700));
  const saved = (await store.getConversation("chat"))!.messages.at(-1)!;
  assert.equal(saved.id, message.id);
  assert.doesNotMatch(saved.content, /unverified child result/);
});

test("a replaced turn owner cannot dispatch or overwrite the persisted answer through HTTP", async t => {
  const entered = deferred(), resume = deferred();
  t.after(resume.resolve);
  let options: any, store!: InMemoryClusterStore;
  let rejected = false;
  const mainAgent = { chat: async (_id: string, _text: string, supplied: any) => {
    options = supplied; entered.resolve(); await resume.promise;
    try {
      await store.saveTaskWithGoal({ taskId: "late", nodeId: "worker", projectId: "p", goal: "inspect", status: "created", dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now() }, supplied.goalRunId, supplied.goalTurnFence);
    } catch { rejected = true; }
    return { assistantResponse: "stale response", state: "completed", durationMs: 1 };
  } };
  const f = await fixture(t, mainAgent); store = f.store;
  const response = f.request("/messages", { method: "POST", body: JSON.stringify({ content: "inspect" }) });
  await entered.promise;
  const initial = (await store.getGoalRun(options.goalRunId))!;
  await store.updateGoalRun({ ...initial, turnLease: { ...initial.turnLease!, expiresAt: 0 }, revision: initial.revision + 1 }, initial.revision);
  const replacement = (await store.claimGoalTurnLease(options.goalRunId, options.goalTurnFence.turnId, "recovery", 60_000))!;
  await store.commitGoalTurnResponse(options.goalRunId, { id: "recovered", conversationId: "chat", sender: "assistant", content: "persisted recovery response", timestamp: Date.now(), metadata: { goalRunId: options.goalRunId, goalRunTurnId: replacement.turnId } }, replacement);
  resume.resolve();
  assert.equal((await response).status, 200);
  assert.equal(rejected, true);
  assert.equal(await store.getTask("late"), null);
  const messages = (await store.getConversation("chat"))!.messages;
  assert.deepEqual(messages.filter(message => message.sender === "assistant").map(message => message.content), ["persisted recovery response"]);
});

test("仅后台图处于取消中时不返回虚构的协调器轮次", async (t) => {
  const { store, request } = await fixture(t);
  await store.saveGraph({ graphId: "graph", status: "cancelling" } as any);
  const conversation = (await store.getConversation("chat"))!;
  conversation.linkedGraphIds = ["graph"]; await store.saveConversation(conversation);
  const snapshot = await (await request()).json() as any;
  assert.equal(snapshot.isRunning, true);
  assert.equal(snapshot.activeTurn, null);
  assert.equal(snapshot.activeGraphs[0].status, "cancelling");
  await store.updateGraphStatus("graph", "cancelled");
  const cancelled = await (await request()).json() as any;
  assert.equal(cancelled.isRunning, false);
  assert.deepEqual(cancelled.activeGraphs, []);
});

test("会话快照返回全部所属任务摘要，包括已完成节点，不泄漏外部任务和内部提示词", async (t) => {
  const { store, request } = await fixture(t);
  for (const [index, status] of ["completed", "running", "failed", "running"].entries()) {
    await store.saveTask({ taskId: `task-${index}`, nodeId: `node-${index}`, projectId: "project", goal: "探查", status,
      prompt: "internal prompt", finalAnswer: "internal report", dispatchOptions: { contextOverrides: { isDiscovery: true } } } as any);
  }
  const conv = (await store.getConversation("chat"))!;
  conv.linkedTaskIds = ["task-0", "task-1", "task-2"]; await store.saveConversation(conv);
  const result = await (await request()).json() as any;
  assert.deepEqual(result.taskSummaries.map((task: any) => task.taskId), conv.linkedTaskIds);
  assert.equal(result.activeTasks.length, 1);
  assert.equal(result.taskSummaries[0].status, "completed");
  assert.equal(result.taskSummaries[2].status, "failed");
  assert.ok(result.taskSummaries.every((task: any) => task.isScout && !("prompt" in task) && !("finalAnswer" in task)));
});

test("协调器取消清理中显示 cancelling，真正退出后广播收敛事件", async (t) => {
  const entered = deferred(); const release = deferred(); t.after(release.resolve);
  const mainAgent = { chat: async () => {
    entered.resolve(); await release.promise;
    return { assistantResponse: "cancelled", state: "cancelled", durationMs: 0 };
  } };
  const { eventBus, request } = await fixture(t, mainAgent);
  const events: any[] = []; eventBus.subscribe("coordinator.turn_completed" as any, (event) => { events.push(event.data); });
  const send = request("/messages", { method: "POST", body: JSON.stringify({ content: "run" }) });
  await entered.promise;
  await request("/cancel", { method: "POST" });
  const stopping = await (await request()).json() as any;
  assert.equal(stopping.isRunning, true);
  assert.equal(stopping.activeTurn.status, "cancelling");
  assert.equal(events.length, 0);
  release.resolve(); await send;
  const stopped = await (await request()).json() as any;
  assert.equal(stopped.isRunning, false);
  assert.equal(stopped.activeTurn, null);
  assert.ok(events.some((event) => event.conversationId === "chat" && event.settled));
});

test("取消当前轮次与关联历史中的同一任务只发送一次控制", async (t) => {
  const entered = deferred(); const release = deferred(); t.after(release.resolve);
  const mainAgent = { chat: async (_id: string, _text: string, options: any) => {
    await options.onTaskDispatched("task"); entered.resolve(); await release.promise;
    return { assistantResponse: "cancelled", state: "cancelled", durationMs: 0 };
  } };
  let controls = 0;
  const { store, request } = await fixture(t, mainAgent, { sendControl: async () => {
    controls++; return { success: true, message: "accepted" };
  } });
  await store.saveTask({ taskId: "task", status: "running" } as any);
  const send = request("/messages", { method: "POST", body: JSON.stringify({ content: "run" }) });
  await entered.promise;
  const result = await (await request("/cancel", { method: "POST" })).json() as any;
  assert.equal(result.success, true); assert.equal(controls, 1);
  const snapshot = await (await request()).json() as any;
  assert.equal(snapshot.activeTasks[0].status, "running");
  release.resolve(); await send;
});

test("主协调器汇总期间刷新会话不提前交付单分支，历史提前交付仅在同轮最终答复存在时收起", async (t) => {
  const entered = deferred(); const release = deferred(); t.after(release.resolve);
  const mainAgent = { chat: async (_id: string, _text: string, options: any) => {
    await options.onTaskDispatched("branch"); entered.resolve(); await release.promise;
    return { assistantResponse: "Final comparison of both branches", state: "completed", durationMs: 0 };
  } };
  const { store, request } = await fixture(t, mainAgent);
  await store.saveTask({ taskId: "branch", status: "completed", finalAnswer: "Mac branch only" } as any);
  const send = request("/messages", { method: "POST", body: JSON.stringify({ content: "compare" }) });
  await entered.promise;
  const during = await (await request()).json() as any;
  assert.equal(during.conversation.messages.filter((message: any) => message.sender === "assistant").length, 0);
  release.resolve(); await send;
  const conversation = (await store.getConversation("chat"))!;
  conversation.messages.splice(1, 0, { id: "legacy-fallback", conversationId: "chat", sender: "assistant", content: "Mac branch only", messageType: "text", timestamp: 1,
    metadata: { state: "completed", source: "worker_deliverable", taskId: "branch" } });
  await store.saveConversation(conversation);
  const final = await (await request()).json() as any;
  const answers = final.conversation.messages.filter((message: any) => message.sender === "assistant");
  assert.equal(answers.length, 1); assert.equal(answers[0].content, "Final comparison of both branches");
});
