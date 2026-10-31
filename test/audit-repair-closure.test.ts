import { registerFixtureNodes } from "./helpers/registered-node.js";
import { PreToolSecurityMonitor } from "../src/security/security-monitor.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { accumulateChatCompletionStream, type ChatCompletionChunk } from "../src/model/chat-completions-client.js";
import { ContextManager } from "../src/context/context-manager.js";
import { LocalSessionStore } from "../src/context/session/local-session-store.js";
import { resolveProjectContext } from "../src/project/project-context.js";
import { runAgentLoop } from "../src/runtime/agent-loop.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { defineTool } from "../src/tools/tool.js";
import { createBashTool } from "../src/tools/bash.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { createFullCapabilitySandboxPolicy as posixFullCapabilityPolicy } from "../src/sandbox/policy.js";
import { EventBus } from "../src/observability/event-bus.js";
import { HookManager } from "../src/middleware/hook-manager.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { WorkerEventForwarder } from "../src/cluster/worker/event-forwarder.js";
import { MAX_MESSAGE_SIZE_BYTES, decodeEnvelope } from "../src/cluster/protocol/message-codec.js";
import { LocalCatalogProvider } from "../src/cluster/worker/catalog/local-catalog-provider.js";
import { ProjectRegistry } from "../src/cluster/worker/project-registry.js";
import { WorkerRuntime } from "../src/cluster/worker/worker-runtime.js";
import { WorkerTaskRunner } from "../src/cluster/worker/worker-task-runner.js";
import { loadSandboxPolicyFromSettings } from "../src/config/settings.js";
import { ApprovalService } from "../src/approval/approval-service.js";

function createFullCapabilitySandboxPolicy() {
  const policy = posixFullCapabilityPolicy();
  if (process.platform === "win32") policy.filesystem.mode = "workspace-write";
  return policy;
}
function nodeCommand(script: string): string {
  return process.platform === "win32"
    ? `& '${process.execPath.replaceAll("'", "''")}' -e "eval(Buffer.from('${Buffer.from(script).toString("base64")}','base64').toString())"`
    : `${JSON.stringify(process.execPath)} -e '${script.replaceAll("'", "'\\''")}'`;
}
function temporary(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-audit-repair-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const response = (message: any) => new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { "Content-Type": "application/json" } });
function model(t: TestContext, handler: typeof fetch) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "mock-audit-key";
  t.after(() => { if (apiKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = apiKey; });
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const result = await handler(input, init);
    if (init?.body && JSON.parse(String(init.body)).stream && result.headers.get("Content-Type")?.includes("application/json")) {
      const data = await result.json() as any;
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: data.choices[0].message, finish_reason: "stop" }], usage: data.usage })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    return result;
  };
  t.after(() => { globalThis.fetch = original; });
}
async function loopFixture(t: TestContext) {
  const dir = temporary(t);
  const project = path.join(dir, "project"); fs.mkdirSync(project);
  const projectContext = await resolveProjectContext({ projectRoot: project, nashHome: path.join(dir, "home") });
  const contextManager = new ContextManager({ projectContext, config: { autoCompact: false } });
  return { projectContext, contextManager, standaloneSystemPrompt: true, systemPrompt: "Test", printStats: false, securityMonitor: new PreToolSecurityMonitor({ enabled: false }) };
}

test("H01: two tool calls retain their own index when subsequent deltas omit IDs", async () => {
  const delta = (calls: any[]) => ({ choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }] });
  const chunks = [delta([{ index: 0, id: "a", function: { name: "first", arguments: '{"x":' } }, { index: 1, id: "b", function: { name: "second", arguments: '{"y":' } }]), delta([{ index: 0, function: { arguments: "1}" } }, { index: 1, function: { arguments: "2}" } }])] as ChatCompletionChunk[];
  const result = await accumulateChatCompletionStream(chunks);
  assert.deepEqual(result.response.choices[0]!.message.tool_calls?.map((call) => JSON.parse(call.function.arguments)), [{ x: 1 }, { y: 2 }]);
});

test("H02/H08: repeated compaction restores recent messages and refreshes the system prompt", async (t) => {
  const baseDir = temporary(t);
  const store = new LocalSessionStore({ baseDir, sessionId: "compact" });
  const context = new ContextManager({ baseDir, sessionStore: store, config: { keepRecentMessages: 2 }, llmInvoker: async () => "summary" });
  await context.buildChatMessages("u1", "old prompt"); await context.recordUserMessage("u1");
  await context.recordAssistantMessage("a1"); await context.appendActiveMessage({ role: "assistant", content: "a1" });
  await context.buildChatMessages("u2", "new prompt"); await context.recordUserMessage("u2");
  await context.compactNow();
  await context.buildChatMessages("u3", "latest prompt"); await context.recordUserMessage("u3");
  await context.compactNow();
  await context.recordUserMessage("u4");
  const restored = await new ContextManager({ baseDir, sessionStore: new LocalSessionStore({ baseDir, sessionId: "compact" }) }).restoreActiveMessages("restored prompt");
  assert.equal(restored[0]?.content, "restored prompt");
  assert.ok(restored.some((message) => message.content === "u3"));
  assert.equal(restored.at(-1)?.content, "u4");
  const refreshed = await context.buildChatMessages("u5", "changed policy");
  assert.equal(refreshed[0]?.content, "changed policy");
});

test("H03: structured tool failures keep their status and shell exit codes", async (t) => {
  const registry = new ToolRegistry();
  registry.register(defineTool({ name: "fail", description: "test", parameters: { type: "object", properties: {} }, execute: async () => ({ success: false, output: "failed", error: "no permission" }) }));
  const executor = new ToolExecutor(registry);
  assert.equal((await executor.execute("fail", "{}")).success, false);
  registry.register(createBashTool({ sandboxService: new SandboxService({ policy: createFullCapabilitySandboxPolicy() }), cwd: temporary(t) }));
  const shell = await executor.execute("bash", JSON.stringify({ command: "echo test-failed; exit 7" }));
  assert.equal(shell.success, false); assert.equal(shell.exitCode, 7, JSON.stringify(shell));
});

test("H04: shell cancellation waits for exit and prevents later writes", async (t) => {
  const dir = temporary(t); const marker = path.join(dir, "late");
  const tool = createBashTool({ sandboxService: new SandboxService({ policy: createFullCapabilitySandboxPolicy() }), cwd: dir });
  const controller = new AbortController();
  const running = tool.execute({ command: nodeCommand("setTimeout(()=>require('fs').writeFileSync('late','late'),1000)") }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 80); t.after(() => clearTimeout(timer));
  const result = await running as any;
  assert.equal(result.success, false); assert.equal(result.interrupted, true);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(fs.existsSync(marker), false);
});

test("H05: elapsed deadline aborts an in-flight model request", async (t) => {
  const options = await loopFixture(t); let aborted = false;
  model(t, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!;
    const fail = () => { aborted = true; reject(signal.reason); };
    if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
  }));
  await assert.rejects(runAgentLoop("deadline", { ...options, tools: [], maxRunMs: 100 }), /100|超时|time/i);
  assert.equal(aborted, true);
});

test("direct tool approvals pause the Agent deadline across repeated waits", async t => {
  const options = await loopFixture(t);
  let calls = 0;
  model(t, async () => ++calls <= 2
    ? response({ role: "assistant", content: null, tool_calls: [{ id: `call-${calls}`, type: "function", function: { name: "approval_probe", arguments: "{}" } }] })
    : response({ role: "assistant", content: "done" }));
  const approvals = new ApprovalService({ askApproval: async () => new Promise(resolve => setTimeout(() => resolve("allow-once"), 600)) });
  const tool = defineTool({ name: "approval_probe", description: "test", parameters: { type: "object", properties: {} }, execute: async () => approvals.requestApproval({ capability: "filesystem-write", reason: "test" }) });
  assert.equal(await runAgentLoop("test", { ...options, tools: [tool], approvalService: approvals, maxRunMs: 1000 }), "done");
});

test("virtual multi-hour approval waits do not consume the Agent execution budget", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const options = await loopFixture(t);
  let calls = 0;
  model(t, async () => ++calls <= 2
    ? response({ role: "assistant", content: null, tool_calls: [{ id: `virtual-${calls}`, type: "function", function: { name: "approval_probe", arguments: "{}" } }] })
    : response({ role: "assistant", content: "done" }));
  const approvals = new ApprovalService({ askApproval: async () => { t.mock.timers.tick(60 * 60 * 1000); return "allow-once"; } });
  const tool = defineTool({ name: "approval_probe", description: "test", parameters: { type: "object", properties: {} }, execute: async () => approvals.requestApproval({ capability: "filesystem-write", reason: "test" }) });
  assert.equal(await runAgentLoop("test", { ...options, tools: [tool], approvalService: approvals, maxRunMs: 1000 }), "done");
  assert.equal(calls, 3);
});

test("H07: budget summary persists the final answer and closes lifecycle hooks", async (t) => {
  const options = await loopFixture(t); const hooks = new HookManager(); let closed = 0;
  hooks.register("afterAgentRun", async () => { closed++; });
  const events: string[] = []; const bus = new EventBus(); bus.subscribe("*", (event) => { events.push(event.type); });
  let calls = 0;
  model(t, async () => ++calls === 1 ? response({ role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "echo", arguments: "{}" } }] }) : response({ role: "assistant", content: "budget summary" }));
  const tool = defineTool({ name: "echo", description: "test", parameters: { type: "object", properties: {} }, execute: async () => "result" });
  assert.equal(await runAgentLoop("finish", { ...options, tools: [tool], maxSteps: 1, hookManager: hooks, eventBus: bus }), "budget summary");
  assert.equal(closed, 1); assert.ok(events.includes("agent.completed"));
  assert.equal((await options.contextManager.getSession().toChatMessages()).at(-1)?.content, "budget summary");
});

test("H09: quoted interruption wording in tool output is ordinary content", async (t) => {
  const options = await loopFixture(t); let calls = 0;
  model(t, async () => ++calls === 1 ? response({ role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "echo", arguments: "{}" } }] }) : response({ role: "assistant", content: "normal answer" }));
  const tool = defineTool({ name: "echo", description: "test", parameters: { type: "object", properties: {} }, execute: async () => "documentation: interrupted by user (用户中断)" });
  assert.equal(await runAgentLoop("read documentation", { ...options, tools: [tool] }), "normal answer");
});

test("D01: project sandbox restrictions override global permissions", (t) => {
  const dir = temporary(t); const projectRoot = path.join(dir, "project"); const homeDir = path.join(dir, "home");
  fs.mkdirSync(projectRoot); fs.mkdirSync(path.join(homeDir, ".nash"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "settings.json"), JSON.stringify({ sandbox: { filesystem: "read-only", network: "deny", approval: "never" } }));
  const policy = loadSandboxPolicyFromSettings(undefined, { projectRoot, homeDir });
  assert.equal(policy.filesystem.mode, "read-only"); assert.equal(policy.network.mode, "deny");
});

test("D02: Worker respects capacity and serializes tasks for one project", async (t) => {
  const dir = temporary(t); let running = 0; let peak = 0; const releases: Array<() => void> = [];
  const runMock = mock.method(WorkerTaskRunner.prototype, "run", async () => { running++; peak = Math.max(peak, running); await new Promise<void>((resolve) => releases.push(resolve)); running--; });
  t.after(() => runMock.mock.restore());
  const runtime = new WorkerRuntime({ customDir: dir, maxConcurrentRuns: 2 });
  const state = runtime as any; state.isRunning = true;
  for (const [taskId, projectId] of [["one", "a"], ["two", "a"], ["three", "b"], ["four", "c"]]) await state.handleTaskDispatch({ taskId, runId: taskId, projectId, goal: "test", connectionGeneration: state.client.generation });
  assert.equal(running, 2); assert.equal(state.pendingDispatches.size, 2);
  releases.shift()!(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(running, 2); assert.equal(peak, 2);
  state.isRunning = false; releases.splice(0).forEach((release) => release());
  await Promise.allSettled(state.executions);
});

test("D03: resolved approvals survive offline delivery and wait for acknowledgement", async () => {
  const store = new InMemoryClusterStore(); let online = false; const sent: any[] = [];
  const scheduler = new TaskScheduler(store, { getConnection: () => online ? { ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) } } : undefined } as any, "coordinator");
  await store.saveTask({ taskId: "t", runId: "r", nodeId: "worker", projectId: "p", goal: "test", status: "waiting_approval", dispatchAttempt: 1, createdAt: 1, updatedAt: 1 });
  await store.saveApproval({ approvalId: "a", taskId: "t", runId: "r", nodeId: "worker", status: "resolved", decision: "allow-once", requestedAt: Date.now(), resolvedAt: Date.now(), expiresAt: Date.now() + 60000, request: {} } as any);
  await scheduler.flushOutbox(); assert.equal((await store.pollPendingOutbox()).length, 1); assert.equal(sent.length, 0);
  online = true; await scheduler.flushOutbox(); assert.equal(sent[0].type, "approval.resolved");
  assert.equal((await store.pollPendingOutbox()).length, 1);
  await store.markOutboxSent(sent[0].messageId); await scheduler.flushOutbox();
  assert.equal((await store.pollPendingOutbox()).length, 0); assert.equal(sent.length, 1);
});

test("D04: event batches stay below the wire limit and drain after ACK", () => {
  const sent: string[] = []; const forwarder = new WorkerEventForwarder("t", "r", "w", "c");
  for (let i = 0; i < 50; i++) forwarder.emitEvent("output", { content: "中".repeat(12000) });
  forwarder.setWebSocket({ readyState: 1, send: (raw: string) => sent.push(raw) } as any);
  while (forwarder.getPendingCount()) {
    forwarder.flush(); const raw = sent.at(-1)!;
    assert.ok(Buffer.byteLength(raw) <= MAX_MESSAGE_SIZE_BYTES);
    const envelope = decodeEnvelope(raw); assert.ok(envelope);
    forwarder.handleEventAck((envelope.payload as any).events.at(-1).seq);
  }
  forwarder.stop();
});

for (const policy of ["skip_dependents", "allow_degraded", "block_dependents"] as const) test(`D06: graph failure policy ${policy} converges`, async () => {
  const store = new InMemoryClusterStore(); await registerFixtureNodes(store, "w"); const scheduler = new TaskScheduler(store, { getConnection: () => undefined } as any, "c");
  const graph = new DistributedGraphOrchestrator({ store, scheduler, validator: { validateCandidate: async () => ({ valid: true, code: "VALID", reason: "test" }) } });
  const record = await graph.createGraph({ reasoning: "test", requiresMultiAgent: true, parentGoal: "test", nodes: [{ nodeId: "a", title: "a", goal: "a", candidateNodeId: "w", candidateProjectId: "p", failurePolicy: policy }, { nodeId: "b", title: "b", goal: "b", dependencies: ["a"], candidateNodeId: "w", candidateProjectId: "q" }] });
  await graph.startGraph(record.graphId); const parent = (await store.getGraphNode(record.graphId, "a"))!;
  await graph.handleNodeTaskFailed(record.graphId, parent.taskId!, "failed");
  assert.equal((await store.getGraphNode(record.graphId, "b"))?.status, policy === "skip_dependents" ? "skipped" : policy === "block_dependents" ? "blocked" : "dispatched");
  if (policy !== "allow_degraded") assert.equal((await store.getGraph(record.graphId))?.status, "failed");
});

test("D07: full snapshot removes absent resources, rejects cross-node ownership atomically", async () => {
  const store = new InMemoryClusterStore();
  const item = (nodeId: string, projectId: string) => ({ nodeId, projectId, name: projectId, revision: 1 } as any);
  await store.upsertProjectCatalog([item("w", "removed"), item("other", "keep")]);
  const snapshot = { nodeId: "w", catalogRevision: 2, hardwareCapabilities: [], projects: [item("w", "new")], skills: [], mcp: [], memoryIndex: [] };
  await store.upsertNodeCatalogSnapshot(snapshot);
  assert.equal(await store.getProjectCatalog("w", "removed"), null); assert.ok(await store.getProjectCatalog("other", "keep"));
  await assert.rejects(store.upsertNodeCatalogSnapshot({ ...snapshot, projects: [item("other", "forged")] }));
  assert.ok(await store.getProjectCatalog("w", "new")); assert.equal(await store.getProjectCatalog("other", "forged"), null);
});

test("D07: catalog tombstones repeat until the matching revision is acknowledged", async (t) => {
  const dir = temporary(t); const registry = new ProjectRegistry({ customDir: dir });
  const provider = new LocalCatalogProvider({ nodeId: "w", projectRegistry: registry, nashHome: dir });
  const priorRevision = provider.getRevision();
  provider.recordTombstone({ resourceType: "project", resourceId: "deleted", revision: 1, deletedAt: Date.now(), nodeId: "w" });
  assert.equal((await provider.getDelta()).projectsDelete?.length, 1);
  provider.acknowledgeRevision(priorRevision);
  assert.equal((await provider.getDelta()).projectsDelete?.length, 1);
  provider.acknowledgeRevision(provider.getRevision());
  assert.equal((await provider.getDelta()).projectsDelete?.length, 0);
});

test("H06: task write conflict releases the slot and ends the failed agent", async (t) => {
  const { TaskManager } = await import("../src/task/task-manager.js");
  const { AgentRegistry } = await import("../src/agent/agent-registry.js");
  const { SubAgentRuntime } = await import("../src/agent/subagent-runtime.js");
  const { ConcurrencyController } = await import("../src/concurrency/concurrency-controller.js");
  const tasks = new TaskManager(); const agents = new AgentRegistry(); const concurrency = new ConcurrencyController({ maxConcurrentAgents: 1 });
  tasks.createTask({ id: "a", subject: "a", writeScopes: ["src/**"] }); tasks.createTask({ id: "b", subject: "b", writeScopes: ["src/**"] });
  tasks.claimTask("a", "owner");
  const runtime = new SubAgentRuntime({ taskManager: tasks, agentRegistry: agents, concurrencyController: concurrency });
  await assert.rejects(runtime.spawn("conflicting", { agentId: "conflict", taskId: "b" }), /write|scope|conflict|写入/i);
  assert.equal(concurrency.getStats().currentRunningAgents, 0); assert.equal(agents.getAgent("conflict")?.status, "failed");
});

test("assembly: background dispatch overlaps runs and gives children role-scoped tools", async (t) => {
  const options = await loopFixture(t);
  const { SubAgentRuntime } = await import("../src/agent/subagent-runtime.js");
  const { AgentRegistry } = await import("../src/agent/agent-registry.js");
  const { TaskManager } = await import("../src/task/task-manager.js");
  const { ConcurrencyController } = await import("../src/concurrency/concurrency-controller.js");
  const agents = new AgentRegistry(); const concurrency = new ConcurrencyController({ maxConcurrentAgents: 2 });
  const runtime = new SubAgentRuntime({ agentRegistry: agents, concurrencyController: concurrency, taskManager: new TaskManager(), projectContext: options.projectContext, policy: createFullCapabilitySandboxPolicy() });
  const toolLists: string[][] = []; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(release);
  model(t, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    toolLists.push(body.tools.map((tool: any) => tool.function.name));
    await gate; return response({ role: "assistant", content: "done" });
  });
  const a = runtime.spawnInBackground("review a", { agentId: "a" });
  const b = runtime.spawnInBackground("review b", { agentId: "b" });
  for (let i = 0; i < 100 && toolLists.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(toolLists.length, 2); assert.equal(concurrency.getStats().currentRunningAgents, 2);
  for (const list of toolLists) { assert.ok(list.includes("complete_task")); assert.ok(list.includes("spawn_agent")); assert.equal(list.includes("create_task"), false); assert.equal(list.includes("assign_task"), false); }
  release(); assert.equal((await runtime.waitForAgent(a))?.success, true); assert.equal((await runtime.waitForAgent(b))?.success, true);
  assert.equal(concurrency.getStats().currentRunningAgents, 0);
});

test("assembly: A2A wire delivery reaches the assigned task once and rejects another graph", async (t) => {
  const { CoordinatorClient } = await import("../src/cluster/worker/coordinator-client.js");
  const runtime = new WorkerRuntime({ customDir: temporary(t), nodeId: "receiver" });
  const state = runtime as any; const acks: any[] = []; const messages: string[] = [];
  t.mock.method(state.client, "getWebSocket", () => ({ readyState: 1, send: (raw: string) => acks.push(JSON.parse(raw)) }));
  state.journal.claim("target", "run");
  state.activeRunners.set("target", { taskId: "target", acceptsGraphMessage: (graph: string, agent: string) => graph === "g" && agent === "main", steer: (text: string) => { messages.push(text); return true; } });
  const payload = { messageId: "message", graphId: "g", sourceNodeId: "sender", sourceTaskId: "source", sourceAgentId: "main", targetNodeId: "receiver", targetTaskId: "target", targetAgentId: "main", messageType: "agent.message", payload: { text: "hello" }, sentAt: Date.now(), expiresAt: Date.now() + 60000 };
  state.client.handleEnvelope({ type: "agent.message_deliver", payload });
  state.client.handleEnvelope({ type: "agent.message_deliver", payload });
  state.client.handleEnvelope({ type: "agent.message_deliver", payload: { ...payload, graphId: "unrelated", messageId: "forged" } });
  assert.equal(messages.length, 1); assert.equal(acks.length, 2); assert.equal(acks[0].type, "agent.message_ack");
  assert.deepEqual(state.journal.get("target").inboundMessageIds, ["message"]);
});

test("D06: completion edges run after failure, unavailable artifact dependencies block", async () => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "w");
  const graph = new DistributedGraphOrchestrator({ store, scheduler: new TaskScheduler(store, { getConnection: () => undefined } as any, "c"), validator: { validateCandidate: async () => ({ valid: true, code: "VALID", reason: "test" }) } });
  const record = await graph.createGraph({ parentGoal: "completion", reasoning: "test", requiresMultiAgent: true, nodes: [
    { nodeId: "a", title: "a", goal: "a", candidateNodeId: "w", candidateProjectId: "a", failurePolicy: "allow_degraded", producedArtifacts: [{ name: "missing", contentType: "text/plain" }] },
    { nodeId: "b", title: "b", goal: "b", dependencies: ["a"], dependencyType: "completion", candidateNodeId: "w", candidateProjectId: "b" },
    { nodeId: "c", title: "c", goal: "c", dependencies: ["a"], dependencyType: "artifact", requiredArtifacts: [{ name: "missing", producerNodeId: "a" }], candidateNodeId: "w", candidateProjectId: "c" },
  ] });
  await graph.startGraph(record.graphId);
  await graph.handleNodeTaskFailed(record.graphId, (await store.getGraphNode(record.graphId, "a"))!.taskId!, "failed");
  assert.equal((await store.getGraphNode(record.graphId, "b"))?.status, "dispatched");
  assert.equal((await store.getGraphNode(record.graphId, "c"))?.status, "blocked");
});

test("MCP assembly uses the configured Nash home and propagates aborts without claiming remote completion", async (t) => {
  const { MCPManager } = await import("../src/mcp/mcp-manager.js");
  const { MCPToolAdapter } = await import("../src/mcp/mcp-tool-adapter.js");
  const { MCPResultAdapter } = await import("../src/mcp/mcp-result-adapter.js");
  const dir = temporary(t); const manager = new MCPManager({ projectRoot: dir, nashHome: path.join(dir, "configured-home") });
  assert.equal(manager.configManager.userConfigPath, path.join(dir, "configured-home", "settings.json"));
  assert.equal((manager.credentialStore as any).storagePath, path.join(dir, "configured-home", "credentials.enc.json"));
  t.after(() => manager.close());
  const controller = new AbortController(); let received: AbortSignal | undefined;
  const tool = new MCPToolAdapter({ serverName: "test", serverConfig: { transport: "stdio", command: "unused", enabled: true }, rawTool: { name: "mutate", inputSchema: { type: "object" } }, resultAdapter: new MCPResultAdapter(),
    callToolHandler: async (_name, _args, signal) => { received = signal; controller.abort(); signal?.throwIfAborted(); },
  });
  const registry = new ToolRegistry(); registry.register(tool);
  const result = await new ToolExecutor(registry).execute(tool.name, "{}", { signal: controller.signal });
  assert.equal(received, controller.signal); assert.equal(result.success, false); assert.equal(result.interrupted, true); assert.match(result.output, /Outcome Unknown/);
});

test("Worker graph messaging binds sender identity and stores messages in its durable event stream", async (t) => {
  const { createGraphMessageTool } = await import("../src/cluster/worker/graph-message-tool.js");
  const forwarder = new WorkerEventForwarder("task", "run", "worker", "coordinator", 500, path.join(temporary(t), "events.json"));
  const tool = createGraphMessageTool({ nodeId: "worker", taskId: "task", graphId: "graph" }, forwarder);
  const result = JSON.parse(await tool.execute({ targetNodeId: "other", targetTaskId: "target", content: "review" }));
  assert.equal(result.deliveryStatus, "pending");
  const recovered = new WorkerEventForwarder("task", "run", "worker", "coordinator", 500, (forwarder as any).persistencePath);
  const sent: any[] = []; recovered.setWebSocket({ readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) } as any);
  const event = sent.at(-1).payload.events[0];
  assert.equal(event.eventType, "agent.message_send"); assert.equal(event.data.sourceTaskId, "task"); assert.equal(event.data.sourceNodeId, "worker");
  forwarder.stop(); recovered.stop();
});

test("H04: cancellation also kills descendants that ignore SIGTERM and close inherited output", async (t) => {
  const dir = temporary(t); const controller = new AbortController();
  const child = `${process.platform === "win32" ? "require('fs').closeSync(1);require('fs').closeSync(2);" : ""}process.on('SIGTERM', () => {}); require('fs').writeFileSync('ready', String(process.pid)); const wait = setInterval(() => { if (require('fs').existsSync('go')) { clearInterval(wait); setTimeout(() => require('fs').writeFileSync('late', 'unexpected'), 500); } }, 10);`;
  const parent = `const p = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: '${process.platform === "win32" ? "inherit" : "ignore"}' }); p.on('error', e => { const fs=require('fs'); let access='ok',nullAccess='ok'; try { fs.accessSync(process.execPath,fs.constants.X_OK); } catch (err) { access=err.code; } if(process.platform !== 'win32') try { fs.closeSync(fs.openSync('/dev/null','r+')); } catch (err) { nullAccess=err.code; } console.error('child launch:',e.code,'exec access:',access,'null access:',nullAccess,'cwd:',process.cwd()); process.exit(1); }); setInterval(() => {}, 1000);`;
  const sandboxService = new SandboxService({ cwd: dir, policy: createFullCapabilitySandboxPolicy() });
  const tool = createBashTool({ cwd: dir, sandboxService });
  const running = tool.execute({ command: nodeCommand(parent) }, { signal: controller.signal });
  let earlyResult: unknown;
  void Promise.resolve(running).then(result => { earlyResult = result; }, error => { earlyResult = String(error); });
  t.after(async () => { controller.abort(); await running; });
  for (let i = 0; i < (process.platform === "win32" ? 1500 : 500) && !fs.existsSync(path.join(dir, "ready")); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(path.join(dir, "ready")), true, `child did not start with ${sandboxService.getBackend().name}: ${JSON.stringify(earlyResult)}`);
  fs.writeFileSync(path.join(dir, "go"), "go");
  controller.abort(); await running;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(fs.existsSync(path.join(dir, "late")), false);
});

test("H04: sandbox setup failure leaves a terminal job and cannot deadlock cleanup", async () => {
  const { JobManager } = await import("../src/jobs/job-manager.js");
  const service = new SandboxService({ policy: createFullCapabilitySandboxPolicy(), backend: { name: "unavailable-test", isAvailable: () => true,
    buildExecutionSpec: () => { throw new Error("sandbox setup failed"); }, run: async () => { throw new Error("unreachable"); },
  } });
  const jobs = new JobManager({ sandboxService: service });
  assert.throws(() => jobs.spawnJob({ ownerAgentId: "main", sessionId: "s", projectId: "p", cwd: os.tmpdir(), command: "never-executed" }), /sandbox setup failed/);
  assert.equal(jobs.listJobs()[0]?.status, "failed");
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([jobs.cleanupAll(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("cleanup hung")), 100); })]); }
  finally { if (timer) clearTimeout(timer); }
});

test("D02: two catalog aliases for the same physical project share one execution lock", async (t) => {
  const dir = temporary(t); const project = path.join(dir, "project"); fs.mkdirSync(project);
  const runtime = new WorkerRuntime({ customDir: path.join(dir, "home"), maxConcurrentRuns: 2 });
  const a = runtime.projects.registerProject(project, "alias-a"); const b = runtime.projects.registerProject(project, "alias-b");
  let finish!: () => void; let calls = 0;
  t.mock.method(WorkerTaskRunner.prototype, "run", async () => { calls++; await new Promise<void>((resolve) => { finish = resolve; }); });
  const state = runtime as any;
  for (const [taskId, projectId] of [["a", a.projectId], ["b", b.projectId]]) await state.handleTaskDispatch({ taskId, runId: taskId, projectId, goal: "test", connectionGeneration: state.client.generation });
  assert.equal(calls, 1); assert.equal(state.pendingDispatches.size, 1);
  finish(); await Promise.allSettled(state.executions);
});
