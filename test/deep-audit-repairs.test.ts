import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { createWriteFileTool } from "../src/tools/write-file.js";
import { createGrepSearchTool } from "../src/tools/grep-search.js";
import { createTaskTools } from "../src/tools/orchestration/index.js";
import { TaskManager } from "../src/task/task-manager.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import { InMemoryClusterStore, type ClusterNodeRecord } from "../src/cluster/storage/cluster-store.js";
import { createLocalClusterStore } from "../src/cluster/storage/local-cluster-store.js";
import { ProjectRegistry } from "../src/cluster/worker/project-registry.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { GlobalGraphSupervisor } from "../src/cluster/graph/global-graph-supervisor.js";
import { GraphReplanner } from "../src/cluster/graph/graph-replanner.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { MemoryWriter } from "../src/memory/memory-writer.js";
import { ExecutionDependencyDetector } from "../src/security/conflict-detector.js";
import { SecurityEvaluator } from "../src/security/security-evaluator.js";
import { PreToolSecurityMonitor } from "../src/security/security-monitor.js";
import type { SecurityContext } from "../src/security/security-types.js";
import { ContextManager } from "../src/context/context-manager.js";
import { LocalSessionStore } from "../src/context/session/local-session-store.js";
import { resolveProjectContext } from "../src/project/project-context.js";
import { runAgentLoop } from "../src/runtime/agent-loop.js";
import { LinuxBubblewrapBackend } from "../src/sandbox/backends/linux-bubblewrap.js";
import { LinuxLandlockBackend } from "../src/sandbox/backends/linux-landlock.js";
import { LinuxSandboxProbe } from "../src/sandbox/linux/capability-probe.js";
import { ResourceController } from "../src/sandbox/linux/resource-controller.js";
import { LinuxSandboxHelperManager } from "../src/sandbox/linux/sandbox-helper.js";
import { executeDirectShellCommand } from "../src/cli/direct-shell-executor.js";
import { ClusterApiHandler } from "../src/cluster/coordinator/api-server.js";
import { isSecureRequest } from "../src/cluster/coordinator/web-security.js";
import { ArtifactService } from "../src/cluster/artifacts/artifact-service.js";
import { highlightCode } from "../apps/web/src/services/markdown.js";
import { resolveWindowsWriteScope } from "../src/sandbox/windows/path-utils.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nash-deep-repairs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function context(root: string, toolName: string, toolArgs: Record<string, unknown>): SecurityContext {
  const rawArgs = JSON.stringify(toolArgs);
  return { cwd: root, toolName, toolArgs, rawArgs, argsFingerprint: SecurityEvaluator.computeFingerprint(toolName, rawArgs), agentIdentity: { agentId: "fixture" }, userAuthorizationContext: {} };
}

test("REAL_SANDBOX F01: default registry enforces child write scopes in the OS", async t => {
  const root = await fixture(t), policy = createDefaultSandboxPolicy(); policy.approval.mode = "never";
  await fs.mkdir(path.join(root, "allowed"));
  const service = new SandboxService({ cwd: root, policy });
  if (!service.isAvailable() || process.platform === "win32") { t.skip("Requires a usable POSIX native sandbox"); return; }
  const access = new FileSystemAccess({ workspaceRoot: root, policy, writeScopes: ["allowed/**"] });
  const bash = createDefaultToolRegistry({ fsAccess: access, sandboxService: service, agentId: "fixture" }).get("bash")!;
  const denied: any = await bash.execute({ command: "printf bad > forbidden.txt" });
  assert.equal(denied.success, false);
  assert.equal(fsSync.existsSync(path.join(root, "forbidden.txt")), false);
  await bash.execute({ command: "printf good > allowed/ok.txt" });
  assert.equal(await fs.readFile(path.join(root, "allowed/ok.txt"), "utf8"), "good");
});

test("REAL_FILESYSTEM F02: multi-link writes are denied without changing the external inode", async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, "workspace"));
  const outside = path.join(root, "outside.txt"); await fs.writeFile(outside, "original");
  await fs.link(outside, path.join(root, "workspace/alias.txt"));
  const access = new FileSystemAccess({ workspaceRoot: path.join(root, "workspace"), policy: createDefaultSandboxPolicy() });
  await assert.rejects(async () => createWriteFileTool(access).execute({ path: "alias.txt", content: "changed" }), /硬链接/);
  assert.equal(await fs.readFile(outside, "utf8"), "original");
});

test("SIMULATED_INTEGRATION F03: pairing is atomic and cannot take over or un-revoke identities", async t => {
  const root = await fixture(t);
  for (const store of [new InMemoryClusterStore(), createLocalClusterStore(path.join(root, "cluster.bin"))]) {
    const invites = new InviteManager(), registry = new NodeRegistry(store, invites);
    const hello: any = { nodeId: "victim", name: "fixture", platform: "linux", arch: "x64", hostname: "fixture", projects: [], capabilities: [], nodeVersion: "24", nashVersion: "1" };
    const socket = () => ({ readyState: 1, close() {} }) as any;
    const results = await Promise.all([1, 2].map(() => registry.authenticateNode({ ...hello, inviteCode: invites.createInvite().inviteCode }, socket())));
    assert.equal(results.filter(r => r.success).length, 1);
    const original = (await store.getNode("victim"))!.tokenHash;
    await registry.revokeNode("victim");
    assert.equal((await registry.authenticateNode({ ...hello, inviteCode: invites.createInvite().inviteCode }, socket())).success, false);
    assert.equal((await store.getNode("victim"))!.tokenHash, original);
    assert.equal((await store.getNode("victim"))!.status, "revoked");
  }
});

test("SIMULATED_INTEGRATION F03: revocation while authentication waits cannot publish a connection", async t => {
  const store = new InMemoryClusterStore(), invites = new InviteManager(), registry = new NodeRegistry(store, invites);
  const activate = store.updateNodeConnection.bind(store);
  t.mock.method(store, "updateNodeConnection", async (node: ClusterNodeRecord) => {
    await registry.revokeNode(node.nodeId);
    return activate(node);
  });
  const result = await registry.authenticateNode({ nodeId: "racing-node", name: "fixture", platform: "linux", arch: "x64", hostname: "fixture", projects: [], capabilities: [], nodeVersion: "24", nashVersion: "1", inviteCode: invites.createInvite().inviteCode } as any, { readyState: 1, close() {} } as any);
  assert.equal(result.success, false);
  assert.equal(registry.getConnection("racing-node"), undefined);
  assert.equal((await store.getNode("racing-node"))!.status, "revoked");
});

test("graph execution has no implicit per-task deadline", async () => {
  const store = new InMemoryClusterStore();
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: {} as any });
  const graph = await orchestrator.createGraph({ parentGoal: "fixture", reasoning: "fixture", requiresMultiAgent: true, nodes: [{ nodeId: "n", title: "fixture", goal: "fixture", dependencies: [] }] });
  assert.equal(graph.budget.perTaskTimeoutMs, 0);
  assert.equal(graph.budget.perTaskTimeoutSource, "none");
  const explicit = await orchestrator.createGraph({ parentGoal: "explicit", reasoning: "fixture", requiresMultiAgent: true, nodes: [{ nodeId: "n", title: "fixture", goal: "fixture", dependencies: [] }], budget: { perTaskTimeoutMs: 600000 } });
  assert.equal(explicit.budget.perTaskTimeoutMs, 600000);
  assert.equal(explicit.budget.perTaskTimeoutSource, "unspecified");
  const planner = await orchestrator.createGraph({ parentGoal: "planner", reasoning: "fixture", requiresMultiAgent: true, nodes: [{ nodeId: "n", title: "fixture", goal: "fixture", dependencies: [] }], budget: { perTaskTimeoutMs: 5000, perTaskTimeoutSource: "planner" } });
  assert.equal(planner.budget.perTaskTimeoutSource, "planner");
  const unlimited = await orchestrator.createGraph({ parentGoal: "unlimited", reasoning: "fixture", requiresMultiAgent: true, nodes: [{ nodeId: "n", title: "fixture", goal: "fixture", dependencies: [] }], budget: { perTaskTimeoutMs: 0, perTaskTimeoutSource: "user" } });
  assert.equal(unlimited.budget.perTaskTimeoutSource, "none");
});

test("replanner feeds rejected artifact dependencies back to the model before committing", async () => {
  const store = new InMemoryClusterStore();
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: {} as any });
  const graph = await orchestrator.createGraph({ parentGoal: "fixture", reasoning: "fixture", requiresMultiAgent: true, nodes: [
    { nodeId: "source", title: "source", goal: "source", dependencies: [], producedArtifacts: [{ name: "report.md", contentType: "text/markdown" }] },
    { nodeId: "join", title: "join", goal: "join", dependencies: ["source"], requiredArtifacts: [{ name: "report.md", producerNodeId: "source" }] },
  ] });
  await store.updateGraphNodeStatus(graph.graphId, "source", "failed", { error: "failure" });
  orchestrator.advanceGraph = async () => {};
  const prompts: string[] = [];
  const replanner = new GraphReplanner(store, orchestrator, { chat: async (messages: any[]) => {
    prompts.push(messages[1].content);
    return { content: JSON.stringify(prompts.length === 1
      ? { reason: "bad", rewireDependencies: [{ nodeId: "join", removeDependencies: ["source"] }] }
      : { reason: "retry source", retryNodeIds: ["source"] }) };
  } } as any);
  const result = await replanner.replanWithLlm({ graphId: graph.graphId, trigger: "task_failed", failedNodeId: "source" });
  assert.equal(result.success, true);
  assert.equal(result.newRevision, 2);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /DagValidator/);
  const events = await store.listGraphEvents(graph.graphId);
  assert.equal(events.filter(e => e.eventType === "graph.replan_rejected").length, 1);
  assert.equal(events.filter(e => e.eventType === "graph.replan_retrying").length, 1);
  assert.equal(events.filter(e => e.eventType === "graph.revision_committed").length, 1);
});

test("SIMULATED_INTEGRATION F04: explicit cancellation retains the lease until cancellation is confirmed", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const store = new InMemoryClusterStore(), now = Date.now(); let requests = 0;
  const scheduler: any = { async sendControl() { requests++; return { success: true, status: "queued" }; } };
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler });
  const graph = await orchestrator.createGraph({ parentGoal: "fixture", reasoning: "fixture", requiresMultiAgent: true, nodes: [{ nodeId: "n", title: "fixture", goal: "fixture", dependencies: [] }], budget: { totalTimeoutMs: 100000, perTaskTimeoutMs: 1 } });
  await store.updateGraphStatus(graph.graphId, "running");
  await store.saveTask({ taskId: "t", nodeId: "worker", projectId: "p", goal: "fixture", runId: "r", status: "running", dispatchAttempt: 1, createdAt: now, updatedAt: now });
  await store.updateGraphNodeStatus(graph.graphId, "n", "running", { taskId: "t", assignedNodeId: "worker", assignedProjectId: "p", startedAt: now });
  t.mock.timers.tick(601000);
  const supervisor = new GlobalGraphSupervisor(store, { getConnection: () => ({ ws: { readyState: 1 } }) } as any, orchestrator);
  await supervisor.superviseGraphs();
  assert.equal(requests, 0, "supervisor must not enforce execution budgets using wall time");
  await orchestrator.requestNodeCancellation(graph.graphId, "t", "user cancelled");
  assert.equal(requests, 1);
  assert.equal((await store.getTask("t"))!.status, "cancelling");
  assert.equal((await store.getGraphNode(graph.graphId, "n"))!.status, "cancelling");
  scheduler.sendControl = async () => ({ success: false, status: "timeout" });
  await orchestrator.requestNodeCancellation(graph.graphId, "t", "unconfirmed");
  assert.equal((await store.getTask("t"))!.status, "outcome_unknown");
  assert.equal((await store.getGraphNode(graph.graphId, "n"))!.status, "outcome_unknown");
});

test("REAL_FILESYSTEM F05: independent memory writers preserve every new record and refuse corrupt indexes", async t => {
  const root = await fixture(t);
  const stores = Array.from({ length: 8 }, () => new MemoryStore({ storageDir: root, scope: "project" }));
  await Promise.all(stores.map((store, i) => new MemoryWriter(store).addMemory({ content: ["alpha ocean", "bravo mountain", "charlie jungle", "delta river", "echo forest", "foxtrot island", "golf valley", "hotel desert"][i]! })));
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "index.json"), "utf8")).length, 8);
  assert.ok(!(await fs.readdir(root)).some(name => name.includes(".tmp") || name.includes(".lock")));
  await fs.writeFile(path.join(root, "index.json"), "corrupt fixture");
  await assert.rejects(stores[0]!.saveEntries([]), /refusing overwrite/);
  assert.equal(await fs.readFile(path.join(root, "index.json"), "utf8"), "corrupt fixture");
});

test("REAL_MULTI_PROCESS F05: memory locking works across independent Node processes", async t => {
  const root = await fixture(t), moduleUrl = new URL("../src/memory/memory-store.ts", import.meta.url).href;
  const children: ReturnType<typeof spawn>[] = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); });
  await Promise.all([0, 1].map(worker => new Promise<void>((resolve, reject) => {
    const script = `import {MemoryStore} from ${JSON.stringify(moduleUrl)}; const store=new MemoryStore({storageDir:${JSON.stringify(root)},scope:'project'});for(let n=0;n<8;n++) await store.saveEntries([{id:'${worker}-'+n,content:'fixture '+n,scope:'project',kind:'fact',source:'verified-code',confidence:1,createdAt:'fixture',updatedAt:'fixture',reinforcementCount:1}]);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] }); children.push(child);
    let error = ""; child.stderr!.on("data", chunk => error += chunk);
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(error)));
  })));
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "index.json"), "utf8")).length, 16);
});

test("REAL_FILESYSTEM F05: concurrent reinforcement is one atomic read/modify/write operation", async t => {
  const root = await fixture(t);
  const stores = Array.from({ length: 8 }, () => new MemoryStore({ storageDir: root, scope: "project" }));
  await Promise.all(stores.map(store => new MemoryWriter(store).addMemory({ content: "Identical fixture fact", kind: "fact" })));
  const entries = await new MemoryStore({ storageDir: root, scope: "project" }).loadEntries();
  assert.equal(entries.length, 1); assert.equal(entries[0]!.reinforcementCount, 8);
});

test("MOCK_UNIT F06: tool actors cannot be omitted or spoofed to mutate another agent's task", async () => {
  const manager = new TaskManager(), task = manager.createTask({ subject: "owned" }); manager.claimTask(task.id, "owner");
  const tools = createTaskTools({ taskManager: manager, agentId: "attacker", role: "member" });
  await assert.rejects(async () => tools.find(t => t.name === "complete_task")!.execute({ taskId: task.id, summary: "spoof", agentId: "owner" }));
  await assert.rejects(async () => tools.find(t => t.name === "block_task")!.execute({ taskId: task.id, reason: "spoof" }));
  assert.throws(() => manager.completeTask(task.id, { summary: "spoof" }, { agentId: "agent-any-prefix" }));
  assert.equal(manager.getTask(task.id)!.status, "running");
  const owner = createDefaultToolRegistry({ taskManager: manager, role: "member", agentId: "owner" }).get("complete_task")!;
  await owner.execute({ taskId: task.id, summary: "done", agentId: "attacker" });
  assert.equal(manager.getTask(task.id)!.completedByAgentId, "owner");
});

test("MOCK_UNIT F07: indirect execution and write/read dependencies invalidate preflight decisions", () => {
  for (const [first, second] of [
    [context(process.cwd(), "write_file", { path: "test.js" }), context(process.cwd(), "bash", { command: "npm test" })],
    [context(process.cwd(), "bash", { command: "python transform.py" }), context(process.cwd(), "read_file", { path: "result" })],
    [context(process.cwd(), "write_file", { path: "a" }), context(process.cwd(), "read_file", { path: "a" })],
  ]) assert.equal(ExecutionDependencyDetector.detectConflict(second!, [first!]).requiresReevaluation, true);
});

test("MOCK_UNIT F07: dependency review bypasses an otherwise valid cached model decision", async t => {
  const root = await fixture(t), monitor = new PreToolSecurityMonitor({ cacheEnabled: true });
  const evaluator = (monitor as any).evaluator as SecurityEvaluator; let calls = 0;
  t.mock.method(evaluator, "evaluateDeterministic", () => null);
  t.mock.method(evaluator, "evaluateWithModel", async (ctx: SecurityContext) => ({ verdict: ++calls === 1 ? "ALLOW" as const : "BLOCK" as const, severity: calls === 1 ? 10 : 90, reason: "fixture", fingerprint: ctx.argsFingerprint, toolName: ctx.toolName, evaluatedAt: Date.now(), durationMs: 0 }));
  const ctx = context(root, "external_tool", {});
  assert.equal((await monitor.evaluateToolCall(ctx)).verdict, "ALLOW");
  assert.equal((await monitor.evaluateToolCall(ctx)).fromCache, true);
  assert.equal((await monitor.evaluateToolCall(ctx, undefined, { bypassCache: true })).verdict, "BLOCK");
  assert.equal(calls, 2);
});

test("MOCK_UNIT F08: unavailable or malformed security decisions fail closed for sensitive and unknown tools", async t => {
  const root = await fixture(t), evaluator: any = new SecurityEvaluator({ failClosedOnHighRisk: true });
  for (const ctx of [context(root, "read_file", { path: "credentials.json" }), context(root, "mcp__mail__send", {}), context(root, "dispatch_cluster_task", {})]) {
    assert.equal(evaluator.handleFallbackOnError(ctx, new Error("fixture timeout"), Date.now()).verdict, "REQUIRE_APPROVAL");
    assert.equal(evaluator.handleUnparsableOutput(ctx, "garbled response").verdict, "REQUIRE_APPROVAL");
    assert.equal(evaluator.handleFallbackOnMissingConfig(ctx, Date.now()).verdict, "REQUIRE_APPROVAL");
  }
});

test("REAL_FILESYSTEM F09/F10: identity is path-stable, legacy references survive, and revocation refreshes", async t => {
  const root = await fixture(t), a = path.join(root, "a/app"), b = path.join(root, "b/app"), data = path.join(root, "registry");
  await fs.mkdir(a, { recursive: true }); await fs.mkdir(b, { recursive: true }); await fs.mkdir(data);
  await fs.writeFile(path.join(data, "cluster-projects.json"), JSON.stringify([{ projectId: "proj-legacy", name: "old", canonicalPath: fsSync.realpathSync(a), registeredAt: 1 }]));
  const first = new ProjectRegistry({ customDir: data }), other = new ProjectRegistry({ customDir: data });
  const original = first.registerProject(a, "renamed"), next = other.registerProject(b, "renamed");
  assert.equal(original.projectId, "proj-legacy"); assert.notEqual(original.projectId, next.projectId);
  assert.equal(first.listProjects().length, 2);
  other.removeProject(original.projectId);
  assert.equal(first.resolveAndValidateProject(original.projectId).valid, false);
  assert.equal(first.listProjects().length, 1);
  await fs.writeFile(path.join(data, "cluster-projects.json"), "invalid");
  assert.throws(() => first.resolveAndValidateProject(next.projectId), /Fail-Closed/);
});

test("MOCK_UNIT F11: ABI 1/2 cannot advertise filesystem isolation", t => {
  t.mock.method(LinuxSandboxProbe, "probe", () => ({ landlockAvailable: true, landlockAbi: 2, helperAvailable: true }) as any);
  assert.equal(new LinuxLandlockBackend().getCapabilities().filesystemIsolation, false);
});

test("REAL_FILESYSTEM F13: directory search never returns sensitive files for a generic query", async t => {
  const root = await fixture(t), marker = "fixture-marker";
  await fs.writeFile(path.join(root, "credentials.json"), marker);
  await fs.writeFile(path.join(root, "source.ts"), marker);
  const grep = createGrepSearchTool(new FileSystemAccess({ workspaceRoot: root, policy: createDefaultSandboxPolicy() }));
  const output = await grep.execute({ query: marker });
  assert.equal(typeof output, "string");
  assert.ok(typeof output === "string");
  assert.ok(output.includes("source.ts")); assert.ok(!output.includes("credentials.json"));
});

test("REAL_FILESYSTEM F01: Windows ACL scopes preserve recursive directories and reject broader glob grants", async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, "allowed"));
  assert.equal(resolveWindowsWriteScope("allowed/**", root), fsSync.realpathSync.native(path.join(root, "allowed")));
  assert.throws(() => resolveWindowsWriteScope("allowed/*.ts", root), /Fail-Closed/);
  assert.throws(() => resolveWindowsWriteScope("../escape/**", root), /escapes/);
});

test("SIMULATED_INTEGRATION F14: cancellation during security review persists every tool response", async t => {
  const root = await fixture(t);
  for (const [key, value] of Object.entries({ DEEPSEEK_API_KEY: "fixture-only", DEEPSEEK_BASE_URL: "http://unused.invalid", DEEPSEEK_MODEL: "fixture" })) {
    const previous = process.env[key]; process.env[key] = value; t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  t.mock.method(globalThis, "fetch", async () => new Response(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "cancelled-call", type: "function", function: { name: "fixture_tool", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
  const projectContext = await resolveProjectContext({ projectRoot: root, nashHome: path.join(root, "home") });
  const sessionStore = new LocalSessionStore({ sessionsDir: projectContext.sessionsDir });
  const contextManager = new ContextManager({ projectContext, sessionStore }), monitor = new PreToolSecurityMonitor();
  t.mock.method(monitor, "evaluateParallelToolCalls", async () => { throw new DOMException("fixture cancelled", "AbortError"); });
  await assert.rejects(runAgentLoop("fixture", { projectContext, contextManager, securityMonitor: monitor, tools: [], standaloneSystemPrompt: true, maxSteps: 1, printStats: false }));
  const records = await sessionStore.getRecords();
  assert.equal(records.filter(r => r.type === "tool_result" && r.toolCallId === "cancelled-call").length, 1);
});

test("MOCK_UNIT F15: Bubblewrap wraps the entire launch in a cgroup entry helper", async t => {
  const root = await fixture(t); let released = 0;
  t.mock.method(ResourceController, "createCgroupSync", () => ({ cgroupPath: "/fixture-cgroup", cleanup: async () => { released++; } }) as any);
  t.mock.method(LinuxSandboxHelperManager, "buildExecutionArgs", (config: any) => ({ executable: "fixture-helper", args: [JSON.stringify(config)], cleanup() {} }));
  const spec = new LinuxBubblewrapBackend({ enableSeccomp: false, resourceLimits: { pidsMax: 3 } }).buildExecutionSpec({ cwd: root, policy: createDefaultSandboxPolicy(), command: "true" });
  const config = JSON.parse(spec.args[0]!);
  assert.equal(config.cgroupPath, "/fixture-cgroup"); assert.equal(config.seccompEnabled, false);
  assert.ok(config.args.includes("--unshare-pid")); spec.cleanup!();
  assert.equal(released, 1);
});

test("REAL_PROCESS F16: direct shell scrubs secrets from both persisted and model-visible messages", async t => {
  const root = await fixture(t), secret = "sk-test-5d2bde652d9f5b42f0789"; let stored = "", active = "", metadata: any;
  const command = process.platform === "win32" ? `Write-Output '${secret}'` : `printf '${secret}'`;
  await executeDirectShellCommand({ command, cwd: root, writeToConsole: false, contextManager: { recordUserMessage: async (text: string, meta: any) => { stored = text; metadata = meta; }, appendActiveMessage: async (message: any) => { active = message.content; } } as any });
  assert.ok(!stored.includes(secret)); assert.ok(!active.includes(secret)); assert.ok(!JSON.stringify(metadata).includes(secret));
});

test("SIMULATED_REQUEST F17: native TLS gets Secure cookies and untrusted proxy headers do not", async t => {
  const previous = process.env.DASHBOARD_PASS; process.env.DASHBOARD_PASS = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env.DASHBOARD_PASS; else process.env.DASHBOARD_PASS = previous; });
  const handler = new ClusterApiHandler({ store: new InMemoryClusterStore(), registry: {} as any, scheduler: {} as any, inviteManager: {} as any, coordinatorNodeId: "fixture" }); t.after(() => handler.close());
  t.mock.method(handler as any, "parseJsonBody", async () => ({ username: process.env.DASHBOARD_USER || process.env.ADMIN_USER || "admin", password: "fixture-only" }));
  let cookie = ""; const res: any = { setHeader() {}, writeHead(_status: number, headers: any) { cookie = headers["Set-Cookie"]; }, end() {} };
  await (handler as any).handleAuthLogin({ headers: {}, socket: { encrypted: true, remoteAddress: "fixture" } }, res);
  assert.match(cookie, /; Secure/);
  assert.equal(isSecureRequest({ headers: { "x-forwarded-proto": "https" }, socket: {} } as any), false);
  assert.equal(isSecureRequest({ headers: { "x-forwarded-proto": "https" }, socket: {} } as any, true), true);
});

test("SIMULATED_STREAM F18: timeout aborts a stalled body and removes partial downloads", async t => {
  const root = await fixture(t); let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } })));
  const service = new ArtifactService(new InMemoryClusterStore(), path.join(root, "artifacts"));
  await assert.rejects(service.downloadRemoteArtifactStream("https://fixture.invalid", path.join(root, "download"), { timeoutMs: 20 }), /abort/i);
  assert.equal(cancelled, true); assert.ok(!(await fs.readdir(root)).some(name => name.startsWith("download")));
});

test("PURE_FUNCTION F19: highlighting never rewrites its own markup and preserves source text", () => {
  const source = 'const x = 1; // "class=400"\nlet html = "<b>400 & 9</b>";';
  const highlighted = highlightCode(source);
  assert.ok(!highlighted.includes("class=<"));
  assert.equal(highlighted.replace(/<\/?span(?: [^>]*)?>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&"), source);
});
