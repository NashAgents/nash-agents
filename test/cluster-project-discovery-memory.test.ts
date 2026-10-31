import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { ProjectDiscoverySession } from "../src/cluster/discovery/project-discovery-session.js";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { ProjectRegistry } from "../src/cluster/worker/project-registry.js";
import { resolveProjectContext } from "../src/project/project-context.js";
import { MemoryService } from "../src/memory/memory-service.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import { AutonomousDiscoveryService } from "../src/cluster/discovery/autonomous-discovery-service.js";
import { WssGateway } from "../src/cluster/coordinator/wss-gateway.js";
import { RoutingValidator } from "../src/cluster/router/routing-validator.js";
import { createEnvelope } from "../src/cluster/protocol/message-codec.js";
import type { DiscoveryCandidate, DiscoveryReport } from "../src/cluster/discovery/types.js";

function fixture(t: { after: (fn: () => void) => void }, memoryEnabled = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nash-project-discovery-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nashHome = path.join(root, "state");
  const project = path.join(root, "Documents", "MetroDataAgent");
  fs.mkdirSync(project, { recursive: true });
  const text = '[project]\nname = "MetroDataAgent"\ndescription = "NL2SQL using FastAPI and LangGraph"';
  fs.writeFileSync(path.join(project, "pyproject.toml"), text);
  const registry = new ProjectRegistry({ customDir: nashHome });
  const receipts: DiscoveryReport[] = [];
  const session = new ProjectDiscoverySession({
    nodeId: "worker", taskId: "task", runId: "run", query: "MetroDataAgent NL2SQL", projectRegistry: registry,
    fsAccess: new FileSystemAccess({ workspaceRoot: root, policy: createDefaultSandboxPolicy() }),
    memoryConfig: { enabled: memoryEnabled }, scanRoots: [path.join(root, "Documents")],
    onPersisted: (report) => receipts.push(report),
  });
  const candidate: DiscoveryCandidate = {
    candidateId: "model-id", nodeId: "forged-node", candidateProjectId: "forged-project", projectName: "MetroDataAgent",
    projectSummary: "NL2SQL using FastAPI and LangGraph", canonicalPath: project, isRegistered: true,
    verificationStatus: "verified", confidence: 1,
    evidences: [{ evidenceType: "file_content", sourcePath: path.join(project, "pyproject.toml"), matchedContent: text, confidence: 1 }],
    relevantCapabilities: [{ name: "nl2sql", capabilityType: "service", description: "NL2SQL" }], relevantMemorySnippets: [],
  };
  return { root, nashHome, project, registry, receipts, session, candidate };
}

test("未登记项目发现后写入自身 Project Memory，重复提交幂等且不授予执行权限", async (t) => {
  const f = fixture(t);
  const scan = await f.session.scanTool.execute({ filter: "MetroDataAgent nl2sql" }) as any;
  assert.equal(scan.projects[0].canonicalPath, f.project);
  assert.equal((await f.session.readTool.execute({ projectPath: f.project, fileName: "pyproject.toml" })).found, true);
  for (let i = 0; i < 2; i++) await f.session.reportTool.execute({ candidates: [f.candidate], summary: "Found MetroDataAgent" });
  const context = await resolveProjectContext({ projectRoot: f.project, nashHome: f.nashHome });
  const memories = await new MemoryService({ projectContext: context, nashHome: f.nashHome }).getAll("project");
  assert.equal(memories.length, 1);
  assert.equal(memories[0].projectId, context.projectId);
  assert.equal(memories[0].reinforcementCount, 1);
  assert.equal(memories[0].evidence?.[0].runId, "run");
  assert.equal(f.receipts[0].candidates[0].nodeId, "worker");
  assert.match(f.receipts[0].candidates[0].candidateProjectId!, /^discovered-/);
  assert.equal(f.receipts[0].candidates[0].isRegistered, false);
  // The harness reports what it actually scanned: an untruncated, error-free scan of the
  // declared roots is `completed` regardless of what the model text claims.
  assert.equal(f.receipts[0].outcome, "completed");
  assert.deepEqual(f.receipts[0].scanReceipts?.[0]?.authorizedRoots, [path.join(f.root, "Documents")]);
  assert.equal(f.receipts[0].scanReceipts?.[0]?.maxDepth, 3);
  assert.match(f.receipts[0].scanReceipts?.[0]?.scope ?? "", /not an exhaustive/);
  assert.equal(f.registry.listProjects().length, 0);
  assert.equal(f.registry.resolveAndValidateProject(f.receipts[0].candidates[0].candidateProjectId!).valid, false);
});

test("未读取、伪造、跨项目及变更后的证据不能入库，凭据与软链接不能作为元数据读取", async (t) => {
  const f = fixture(t);
  const submit = (candidate = f.candidate) => f.session.reportTool.execute({ candidates: [candidate], summary: "found" });
  await assert.rejects(submit(), /Read project metadata first/);
  await f.session.readTool.execute({ projectPath: f.project, fileName: "pyproject.toml" });
  await assert.rejects(submit({ ...f.candidate, evidences: [{ ...f.candidate.evidences[0], matchedContent: "invented evidence that was never read" }] }), /Unobserved/);
  const other = path.join(f.root, "other"); fs.mkdirSync(other);
  await assert.rejects(submit({ ...f.candidate, canonicalPath: other }), /cross-project/);
  assert.equal((await f.session.readTool.execute({ projectPath: f.project, fileName: "../credentials.json" })).found, false);
  fs.symlinkSync(path.join(f.project, "pyproject.toml"), path.join(f.project, "README.md"));
  assert.equal((await f.session.readTool.execute({ projectPath: f.project, fileName: "README.md" })).found, false);
  fs.appendFileSync(path.join(f.project, "pyproject.toml"), "\nchanged = true");
  await assert.rejects(submit(), /Unobserved/);
  assert.equal(f.receipts.length, 0);
});

test("记忆关闭时提交明确失败，不产生成功报告或联邦事件", async (t) => {
  const f = fixture(t, false);
  await f.session.readTool.execute({ projectPath: f.project, fileName: "pyproject.toml" });
  await assert.rejects(f.session.reportTool.execute({ candidates: [f.candidate], summary: "found" }), /not persisted/);
  assert.equal(f.receipts.length, 0);
  assert.equal(f.session.reportTool.getReport(), undefined);
});

test("未登记目录扫描遵守文件权限、跳过软链接并响应取消", async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(path.dirname(f.project), "linked-project"));
  const result = await f.session.scanTool.execute({}) as any;
  assert.equal(result.projects.some((project: any) => project.name === "linked-project"), false);
  const denied = new ProjectDiscoverySession({ nodeId: "worker", taskId: "task", runId: "run", query: "", projectRegistry: f.registry,
    fsAccess: new FileSystemAccess({ workspaceRoot: f.project, policy: createDefaultSandboxPolicy() }), scanRoots: [f.root], onPersisted() {} });
  await assert.rejects(async () => denied.scanTool.execute({}));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(async () => f.session.scanTool.execute({}, { signal: controller.signal }));
});

test("普通任务的持久发现事件经真实 WebSocket 入联邦索引，重复与重启恢复不丢失、不自动注册", async (t) => {
  const f = fixture(t);
  await f.session.readTool.execute({ projectPath: f.project, fileName: "pyproject.toml" });
  await f.session.reportTool.execute({ candidates: [f.candidate], summary: "found" });
  const store = new InMemoryClusterStore(); const invites = new InviteManager(); const registry = new NodeRegistry(store, invites);
  const discoveryService = new AutonomousDiscoveryService({ store, registry });
  const server = http.createServer();
  const gateway = new WssGateway({ server, store, registry, coordinatorNodeId: "coordinator", discoveryService });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/ws/cluster`);
  t.after(async () => { ws.terminate(); gateway.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  await once(ws, "open");
  const send = async (type: any, payload: any) => {
    const response = once(ws, "message"); ws.send(JSON.stringify(createEnvelope(type, payload, "worker", "coordinator")));
    return JSON.parse(String((await response)[0]));
  };
  assert.equal((await send("node.hello", { nodeId: "worker", name: "test", platform: "linux", arch: "x64", hostname: "test", capabilities: [], projects: [], maxConcurrentRuns: 1, inviteCode: invites.createInvite().inviteCode })).type, "node.authenticated");
  const timestamp = f.receipts[0].timestamp;
  await store.saveTask({ taskId: "task", runId: "run", nodeId: "worker", projectId: "unrelated-project", goal: "检查本地项目", status: "running", dispatchAttempt: 1, createdAt: timestamp, updatedAt: timestamp });
  const event = { taskId: "task", runId: "run", nodeId: "worker", seq: 1, timestamp, eventType: "discovery.report_persisted", data: { report: f.receipts[0] } };
  const upsert = store.upsertMemoryIndex.bind(store);
  let attempts = 0;
  t.mock.method(store, "upsertMemoryIndex", async (...args: Parameters<typeof upsert>) => {
    if (++attempts === 1) throw new Error("simulated transient index failure");
    return upsert(...args);
  });
  assert.notEqual((await send("event.batch", { taskId: "task", runId: "run", nodeId: "worker", events: [event] })).type, "event.ack");
  for (let i = 0; i < 2; i++) assert.equal((await send("event.batch", { taskId: "task", runId: "run", nodeId: "worker", events: [event] })).type, "event.ack");
  let memories = await store.listMemoryIndex();
  assert.equal(memories.length, 1); assert.equal(memories[0].visibility, "summary");
  assert.equal(memories[0].revision, 1); assert.equal(memories[0].updatedAt, timestamp);
  assert.notEqual(memories[0].projectId, "unrelated-project");
  assert.equal(((await store.getNode("worker"))?.metadata.projects as unknown[])?.length, 0);
  const validation = await new RoutingValidator(store, registry).validateCandidate({ nodeId: "worker", projectId: memories[0].projectId }, {} as any);
  assert.equal(validation.code, "PROJECT_NOT_FOUND");
  await store.upsertNodeCatalogSnapshot({ nodeId: "worker", catalogRevision: 2, hardwareCapabilities: [], projects: [], skills: [], mcp: [], memoryIndex: [] });
  assert.equal((await store.listProjectsCatalog()).length, 1, "Reconnect snapshots must preserve discoveries");
  assert.equal((await store.listMemoryIndex()).length, 1);
  await store.updateTaskStatus("task", "completed");
  // Simulate a crash after saving the receipt but before indexing it.
  const recovered = new InMemoryClusterStore();
  await recovered.saveNode((await store.getNode("worker"))!);
  await recovered.saveTask((await store.getTask("task"))!); await recovered.appendEvents([event]);
  await new AutonomousDiscoveryService({ store: recovered, registry: new NodeRegistry(recovered, invites) }).recoverHistoricalReports();
  memories = await recovered.listMemoryIndex(); assert.equal(memories.length, 1); assert.equal(memories[0].updatedAt, timestamp);
  await assert.rejects(discoveryService.ingestPersistedReport({ ...f.receipts[0], nodeId: "other" }, "worker"), /identity mismatch/);
});
