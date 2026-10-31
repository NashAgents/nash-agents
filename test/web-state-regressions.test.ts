import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { api } from "../apps/web/src/services/api.js";
import { closeAllSseConnections } from "../apps/web/src/services/sse.js";
import { useWorkspaceStore } from "../apps/web/src/stores/workspace.js";
import { useGraphsStore } from "../apps/web/src/stores/graphs.js";

const { setActivePinia, createPinia } = await import(new URL("../apps/web/node_modules/pinia/dist/pinia.mjs", import.meta.url).href);
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, (event: any) => void>();
  onopen?: () => void; onmessage?: (event: any) => void; onerror?: () => void;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, listener); }
  close() {}
  emit(type: string, data: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(data), lastEventId: "" }); }
}
function setup(t: TestContext) {
  const previous = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource as any;
  const pinia = createPinia(); setActivePinia(pinia); FakeEventSource.instances = [];
  t.after(() => { for (const store of pinia._s.values()) store.$dispose(); closeAllSseConnections(); globalThis.EventSource = previous; });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { resolve, promise }; }
const conversation = (id: string) => ({ id, title: id, messages: [], linkedTaskIds: [], createdAt: Date.now(), updatedAt: Date.now() });

test("草稿创建期间阻止重复提交，切换页面不能被旧创建请求抢回焦点", async (t) => {
  setup(t); const workspace = useWorkspaceStore(); workspace.startNewDraft();
  const creation = deferred<any>(); let creates = 0;
  t.mock.method(api, "createConversation", () => { creates++; return creation.promise; });
  t.mock.method(api, "sendConversationMessage", async (id: string) => ({ conversation: conversation(id) }));
  const first = workspace.sendMessage("first"); const second = await workspace.sendMessage("second");
  assert.equal(creates, 1); assert.equal(second, false); assert.equal(workspace.sending, true);
  workspace.startNewDraft(); creation.resolve({ conversation: conversation("created") }); await first;
  assert.equal(workspace.currentConversation?.id, "draft"); assert.ok(workspace.conversations.some((item) => item.id === "created"));
});

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("多节点监控保留已完成节点，切换会话和草稿立即隔离旧任务", async (t) => {
  setup(t); const workspace = useWorkspaceStore();
  t.mock.method(api, "getTask", async (id: string) => ({ task: { taskId: id, status: "completed", nodeId: "Mac" } }));
  t.mock.method(api, "getConversation", async (id: string) => ({ conversation: { ...conversation(id), linkedTaskIds: id === "multi" ? ["A", "B", "C"] : [] },
    isRunning: false, activeTurn: null, activeTasks: [], activeGraphs: [], taskSummaries: id === "multi" ? [
      { taskId: "A", nodeId: "Linux", status: "completed" }, { taskId: "B", nodeId: "WSL", status: "failed" }, { taskId: "C", nodeId: "Mac", status: "completed" },
      { taskId: "foreign", nodeId: "Other", status: "running" },
    ] : [] }));
  await workspace.selectConversation("multi"); await flush();
  assert.equal(workspace.currentExecutionTasks.length, 3);
  assert.ok(workspace.currentExecutionTasks.some(task => task.status === "failed"));
  await workspace.selectConversation("empty"); assert.deepEqual(workspace.currentExecutionTasks, []);
  await workspace.selectConversation("multi"); workspace.startNewDraft(); assert.deepEqual(workspace.currentExecutionTasks, []);
});

test("会话探查进度只作用于所属会话，刷新保留汇总阶段，最终推送无需等待发送请求返回", async (t) => {
  setup(t); const workspace = useWorkspaceStore(); const conv = conversation("scout-chat");
  t.mock.method(api, "getConversation", async () => ({ conversation: conv, isRunning: true, activeTasks: [], activeGraphs: [],
    activeTurn: { startedAt: 1, progress: { phase: "synthesizing", detail: "已收齐节点结果，正在汇总", timestamp: 2 } } }));
  await workspace.selectConversation(conv.id);
  assert.equal(workspace.currentActivity?.phase, "synthesizing");
  const connection = FakeEventSource.instances[0]!;
  connection.emit("coordinator.phase", { conversationId: "other", phase: "discovering", detail: "other" });
  assert.equal(workspace.currentActivity?.phase, "synthesizing");
  connection.emit("coordinator.phase", { conversationId: conv.id, phase: "discovering", detail: "并行探查节点" });
  assert.equal(workspace.currentActivity?.detail, "并行探查节点");
  await workspace.selectConversation(conv.id);
  assert.match(workspace.currentActivity?.detail ?? "", /已收齐/);
  connection.emit("conversation.message_created", { conversationId: conv.id, message: { id: "answer", sender: "assistant", content: "最终报告", timestamp: 3 } });
  assert.equal(workspace.currentConversation?.messages.at(-1)?.content, "最终报告");
  assert.equal(workspace.isCurrentConversationRunning, false);
});

test("任务图后台运行不冒充协调器发送，取消确认前明确显示等待停止", async (t) => {
  setup(t); const workspace = useWorkspaceStore();
  const conv = { ...conversation("graph-chat"), linkedGraphIds: ["graph"] };
  t.mock.method(api, "getConversation", async () => ({ conversation: conv, isRunning: true, activeTurn: null, activeTasks: [], activeGraphs: [{ graphId: "graph", status: "cancelling" }] }));
  await workspace.selectConversation(conv.id);
  assert.equal(workspace.isCurrentConversationRunning, true);
  assert.equal(workspace.sending, false);
  assert.equal(workspace.currentActivity?.phase, "cancelling");
  assert.match(workspace.executionStatusText, /等待执行节点确认停止/);
});

test("任务图终态与心跳刷新清除旧活动，不需要刷新页面", async (t) => {
  setup(t); const workspace = useWorkspaceStore();
  const conv = { ...conversation("graph-chat"), linkedGraphIds: ["graph"] };
  let running = true;
  t.mock.method(api, "getConversation", async () => ({ conversation: conv, isRunning: running, activeTurn: null, activeTasks: [], activeGraphs: running ? [{ graphId: "graph", status: "running" }] : [] }));
  await workspace.selectConversation(conv.id);
  const connection = FakeEventSource.instances[0]!;
  running = false;
  connection.emit("graph.cancelled", { graphId: "other-graph" }); await flush();
  assert.equal(workspace.isCurrentConversationRunning, true);
  connection.emit("graph.cancelled", { graphId: "graph" }); await flush();
  assert.equal(workspace.isCurrentConversationRunning, false);
  assert.equal(workspace.currentActivity, null);
  running = true; await workspace.selectConversation(conv.id);
  running = false; connection.emit("cluster.heartbeat", {}); await flush();
  assert.equal(workspace.isCurrentConversationRunning, false);
});

test("权威空快照清除遗留任务，较早的任务查询不能把取消状态改回运行", async (t) => {
  setup(t); const workspace = useWorkspaceStore();
  const conv = { ...conversation("task-chat"), linkedTaskIds: ["task"] };
  const oldTask = deferred<any>(); t.mock.method(api, "getTask", () => oldTask.promise);
  t.mock.method(api, "getConversation", async () => ({ conversation: conv, isRunning: false, activeTurn: null, activeTasks: [], activeGraphs: [] }));
  workspace.currentConversation = conv; await flush();
  workspace.currentActiveTask = { taskId: "task", status: "running" };
  workspace.activeRunningTasks.task = { taskId: "task", status: "running" };
  await workspace.selectConversation(conv.id);
  oldTask.resolve({ task: { taskId: "task", status: "running" } }); await flush();
  assert.equal(workspace.currentActiveTask, null);
  assert.equal(workspace.isCurrentConversationRunning, false);
});

test("取消后的轮次完成事件解除等待旧 HTTP 回包的执行标记", async (t) => {
  setup(t); const workspace = useWorkspaceStore(); const conv = conversation("sending-chat");
  workspace.currentConversation = conv;
  const response = deferred<any>();
  t.mock.method(api, "sendConversationMessage", () => response.promise);
  t.mock.method(api, "getConversation", async () => ({ conversation: conv, isRunning: false, activeTurn: null, activeTasks: [], activeGraphs: [] }));
  const send = workspace.sendMessage("cancel this");
  t.after(async () => { response.resolve({ conversation: conv }); await send; });
  assert.equal(workspace.isCurrentConversationRunning, true);
  FakeEventSource.instances[0]!.emit("coordinator.turn_completed", { conversationId: conv.id, settled: true }); await flush();
  assert.equal(workspace.isCurrentConversationRunning, false);
  assert.equal(workspace.sending, false);
});

test("列表刷新不删除其他页面刚创建的空会话", async (t) => {
  setup(t); const workspace = useWorkspaceStore();
  t.mock.method(api, "listConversations", async () => ({ conversations: [conversation("fresh")] }));
  const remove = t.mock.method(api, "deleteConversation", async () => ({ success: true }));
  await workspace.loadConversations(); assert.equal(remove.mock.callCount(), 0);
});

test("发送失败保留可恢复错误，不保留未成功发送的乐观消息", async (t) => {
  setup(t); const workspace = useWorkspaceStore();
  workspace.currentConversation = conversation("existing");
  t.mock.method(api, "sendConversationMessage", async () => { throw new Error("network failed"); });
  assert.equal(await workspace.sendMessage("keep this message"), false);
  assert.match(workspace.submissionError, /network failed/); assert.equal(workspace.currentConversation.messages.length, 0);
});

test("实时事件触发的旧快照不能覆盖最新完成状态", async (t) => {
  setup(t); const graphs = useGraphsStore();
  const snapshot = (status: string) => ({ graph: { graphId: "graph", status }, snapshot: {}, nodes: [], edges: [], revisions: [] });
  t.mock.method(api, "getGraph", async () => snapshot("running")); await graphs.loadGraphDetails("graph");
  const requests: Array<{ resolve: (value: any) => void; promise: Promise<any> }> = [];
  t.mock.method(api, "getGraph", () => { const request = deferred<any>(); requests.push(request); return request.promise; });
  const connection = FakeEventSource.instances.find((item) => item.url.includes("/graphs/"))!;
  connection.emit("graph.node_completed", { graphId: "graph", nodeId: "A" }); connection.emit("graph.completed", { graphId: "graph" });
  requests[1]!.resolve(snapshot("completed")); await Promise.resolve(); await Promise.resolve();
  requests[0]!.resolve(snapshot("running")); await Promise.resolve(); await Promise.resolve();
  assert.equal(graphs.currentGraph.status, "completed"); graphs.cleanup();
});

test("产物作用域切换立即清空，旧图延迟响应不能泄漏到新会话或草稿", async (t) => {
  setup(t);
  const { useArtifactsStore } = await import("../apps/web/src/stores/artifacts.js");
  const store = useArtifactsStore();
  const old = deferred<any>();
  t.mock.method(api, "listArtifacts", (graphId?: string) => graphId === "old" ? old.promise : Promise.resolve({ artifacts: [{ artifactId: "new-report", graphId: "new" }, { artifactId: "foreign", graphId: "old" }] }));
  const previous = store.setGraphScope("old");
  await store.setGraphScope("new");
  assert.deepEqual(store.scopedArtifacts.map((a) => a.artifactId), ["new-report"]);
  old.resolve({ artifacts: [{ artifactId: "old-report", graphId: "old" }] }); await previous;
  assert.deepEqual(store.scopedArtifacts.map((a) => a.artifactId), ["new-report"]);
  await store.setGraphScope(null); assert.deepEqual(store.scopedArtifacts, []);
});

test("预览切换或会话清空不能让旧文件内容覆盖当前预览", async (t) => {
  setup(t); const { useArtifactsStore } = await import("../apps/web/src/stores/artifacts.js"); const store = useArtifactsStore();
  const old = deferred<any>();
  t.mock.method(api, "getArtifactContent", (id: string) => id === "old" ? old.promise : Promise.resolve({ content: "new contents" }));
  const first = store.loadPreview("old"); await store.loadPreview("new"); store.clearPreview();
  old.resolve({ content: "old contents" }); await first;
  assert.equal(store.previewContent, ""); assert.equal(store.currentArtifact, null);
});

test("实时审批不依赖刷新补 status，重复事件幂等，重连恢复历史", async (t) => {
  setup(t); const { useApprovalsStore } = await import("../apps/web/src/stores/approvals.js"); const store = useApprovalsStore();
  const unsub = store.startSseListener(); t.after(unsub);
  const event = { approvalId: "approval", taskId: "task", expiresAt: Date.now() + 60000 };
  const connection = FakeEventSource.instances[0]!;
  connection.emit("approval.requested", event); connection.emit("approval.requested", event);
  assert.equal(store.pendingApprovals.length, 1);
  connection.emit("approval.resolved", { approvalId: "approval", decision: "deny" });
  assert.equal(store.pendingApprovals.length, 0);
  t.mock.method(api, "listApprovals", async () => ({ approvals: [], history: [{ ...event, status: "expired" }] }));
  connection.emit("cluster.heartbeat", {}); await flush();
  assert.equal(store.approvals[0].status, "expired");
});

test("图分支纳入会话活动，审批等待不会被模型分析状态覆盖", async (t) => {
  setup(t); const workspace = useWorkspaceStore(); const conv = { ...conversation("graph-chat"), linkedGraphIds: ["graph"] };
  t.mock.method(api, "getConversation", async () => ({ conversation: conv, isRunning: true, activeTurn: { status: "running" }, activeGraphs: [{ graphId: "graph", status: "running" }], activeTasks: [{ taskId: "branch", status: "waiting_approval", dispatchOptions: { graphContext: { graphId: "graph" } } }] }));
  await workspace.selectConversation(conv.id);
  assert.equal(workspace.currentConversationRunningTasks.length, 1);
  assert.match(workspace.executionStatusText, /等待审批/);
  assert.equal(workspace.activeGraphId, "graph");
});

test("记忆检索旧响应不能覆盖新查询，浏览列表不冒充相关性得分", async (t) => {
  setup(t); const { useMemoryStore } = await import("../apps/web/src/stores/memory.js"); const store = useMemoryStore();
  const pending = deferred<any>();
  t.mock.method(api, "searchMemory", () => pending.promise);
  t.mock.method(api, "listMemory", async () => ({ entries: [{ entryId: "current", nodeId: "worker", projectId: "project", topic: "topic", summary: "current", confidence: 0.9 }] }));
  const old = store.load("old"); await store.load();
  pending.resolve({ results: [{ entryId: "stale", nodeId: "worker", projectId: "project", topic: "topic", summary: "stale", score: 1 }] }); await old;
  assert.equal(store.activeQuery, ""); assert.equal(store.items[0]?.entryId, "current"); assert.equal(store.items[0]?.score, undefined);
});

test("记忆接口错误明确可恢复，不伪装成空结果；销毁后的请求不再写状态", async (t) => {
  setup(t); const { useMemoryStore } = await import("../apps/web/src/stores/memory.js"); const store = useMemoryStore();
  t.mock.method(api, "listMemory", async () => { throw new Error("暂时离线"); });
  await store.load(); assert.equal(store.error, "暂时离线"); assert.equal(store.loaded, false); assert.equal(store.loading, false);
  const pending = deferred<any>(); t.mock.method(api, "searchMemory", () => pending.promise);
  const request = store.load("query"); store.$dispose(); pending.resolve({ results: [{ entryId: "late" }] }); await request;
  assert.deepEqual(store.results, []);
});

test("任务详情切换立即清空旧结果，旧请求不覆盖新页面或加载状态", async (t) => {
  setup(t); const { useTasksStore } = await import("../apps/web/src/stores/tasks.js");
  const store = useTasksStore(); const first = deferred<any>(); const second = deferred<any>();
  t.mock.method(api, "getTask", (id: string) => id === "a" ? first.promise : second.promise);
  t.mock.method(api, "getTaskEvents", async () => ({ events: [] }));
  store.currentTask = { taskId: "old", finalAnswer: "must clear" }; store.currentEvents = [{ eventType: "old" }];
  const a = store.loadTaskDetails("a"); assert.equal(store.currentTask, null); assert.deepEqual(store.currentEvents, []);
  const b = store.loadTaskDetails("b"); first.resolve({ task: { taskId: "a" } }); await a;
  assert.equal(store.loading, true); assert.equal(store.currentTask, null);
  second.resolve({ task: { taskId: "b", status: "waiting_approval" } }); await b;
  assert.equal((store.currentTask as any).taskId, "b"); assert.equal(store.loading, false);
  store.cleanup(); assert.equal(store.currentTask, null);
});

test("审批通过后全局待办徽标立即乐观清零，且 SSE 与 clusterStore 双向实时同步", async (t) => {
  setup(t);
  const { useApprovalsStore } = await import("../apps/web/src/stores/approvals.js");
  const { useClusterStore } = await import("../apps/web/src/stores/cluster.js");
  const approvalsStore = useApprovalsStore();
  const clusterStore = useClusterStore();
  const unsubApprovals = approvalsStore.startSseListener();
  const unsubCluster = clusterStore.startSseListener();
  t.after(unsubApprovals);
  t.after(unsubCluster);

  const event = { approvalId: "appr-1", taskId: "task-1", expiresAt: Date.now() + 60000 };
  const connection = FakeEventSource.instances[0]!;

  // 1. 模拟收到新待审批
  connection.emit("approval.requested", event);
  assert.equal(approvalsStore.pendingApprovals.length, 1);
  assert.equal(clusterStore.pendingApprovalsCount, 1);

  // 2. 模拟前端 resolve 执行乐观更新
  t.mock.method(api, "resolveApproval", async () => ({ success: true }));
  const resolvePromise = approvalsStore.resolve("appr-1", "allow-once");
  // 乐观更新下，无需等待网络完成，clusterStore.pendingApprovalsCount 立即归零
  assert.equal(clusterStore.pendingApprovalsCount, 0);
  assert.equal(approvalsStore.pendingApprovals.length, 0);
  await resolvePromise;
  assert.equal(clusterStore.pendingApprovalsCount, 0);

  // 3. 模拟收到 approval.resolved 事件，确保幂等且不反弹
  connection.emit("approval.resolved", { approvalId: "appr-1", decision: "allow-once", pendingApprovals: 0 });
  assert.equal(clusterStore.pendingApprovalsCount, 0);
  assert.equal(approvalsStore.pendingApprovals.length, 0);
});
