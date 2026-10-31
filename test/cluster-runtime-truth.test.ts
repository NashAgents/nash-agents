import { redactString, redactObject } from "../src/observability/redaction.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { ArtifactService } from "../src/cluster/artifacts/artifact-service.js";
import { ResultVerifier } from "../src/cluster/graph/result-verifier.js";
import { AutonomousPlanner } from "../src/cluster/graph/autonomous-planner.js";
import { RoutingValidator } from "../src/cluster/router/routing-validator.js";
import type { GraphProposalNode } from "../src/cluster/graph/types.js";

// MOCK_UNIT + SIMULATED_INTEGRATION. No remote worker, model, or sandbox is exercised here.
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "nash-runtime-truth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new InMemoryClusterStore();
  const now = Date.now();
  await store.saveNode({ nodeId: "mac", name: "Mac", role: "worker", platform: "darwin", arch: "arm64", hostname: "test", tokenHash: "fixture", metadata: {}, status: "online", lastSeenAt: now, createdAt: now, updatedAt: now });
  await store.upsertProjectCatalog([{ nodeId: "mac", projectId: "project", name: "Fixture", summary: "test", description: "test", technologies: [], capabilities: [], lastIndexedAt: now, status: "active", canonicalPath: "/runtime-truth-fixture", visibility: "retrievable", revision: 1, registeredAt: now, updatedAt: now }]);
  await store.saveCatalogRevision("mac", 1, [{ name: "seatbelt", category: "sandbox", status: "verified", details: "simulation", detectionMethod: "fixture", detectedAt: now, verifiedAt: now, structuredDetails: { backend: "seatbelt", installed: true, operational: true, filesystemIsolationVerified: true, networkIsolationVerified: true, processIsolationVerified: true, supportedPolicies: ["read-only", "workspace-write"], supportedNetworkModes: ["deny", "allow"], verificationExpiresAt: now + 100000 } }]);
  await store.saveGraph({ graphId: "graph-test", parentGoal: "Analyze fixture", status: "running", revision: 1, budget: { maxNodes: 10, maxParallelTasks: 4, maxReplanAttempts: 2, maxDepth: 6, totalTimeoutMs: 10000, perTaskTimeoutMs: 10000 }, concurrencyPolicy: { maxConcurrentTasks: 4, projectWriteLock: true }, createdAt: now, updatedAt: now });
  await store.saveTask({ taskId: "task", runId: "run", nodeId: "mac", projectId: "project", goal: "Analyze fixture", status: "completed", dispatchAttempt: 1, dispatchOptions: { graphContext: { graphId: "graph-test", graphRevision: 1, graphNodeId: "analyze", inputs: [], outputs: [] } }, createdAt: now, updatedAt: now });
  await store.saveGraphNode({ graphId: "graph-test", nodeId: "analyze", taskId: "task", assignedNodeId: "mac", assignedProjectId: "project", title: "Analyze", goal: "Analyze", operation: "analyze", requiredCapabilities: [], requiredArtifacts: [], producedArtifacts: [{ name: "report.md" }], acceptanceCriteria: [{ type: "artifact_exists", expected: "report.md", description: "Report exists" }], status: "running", failurePolicy: "block_dependents", retryPolicy: { maxRetries: 0, backoffMs: 0 }, attemptCount: 1, createdAt: now, updatedAt: now });
  const artifacts = new ArtifactService(store, root);
  const artifact = await artifacts.publishArtifact({ graphId: "graph-test", producerTaskId: "task", producerNodeId: "mac", name: "report.md", content: "Actual fixture bytes", metadata: { runId: "run", graphRevision: 1 } });
  const record = (type: string, data: Record<string, unknown>, seq: number) => ({ taskId: "task", runId: "run", nodeId: "mac", seq, timestamp: now, eventType: type, data });
  const evidence = async (overrides: Record<string, unknown> = {}) => store.appendEvents([record("tool.result", { source: "ToolExecutor", toolCallId: "call-1", toolName: "read_file", success: true, ...overrides }, 1), record("task.completed", {}, 2)]);
  const verifier = new ResultVerifier(store, artifacts);
  const input = { graphId: "graph-test", graphNodeId: "analyze", taskId: "task", acceptanceCriteria: [{ type: "artifact_exists" as const, expected: "report.md", description: "Report exists" }], resultSummary: "SUCCESS", testExitCode: 0, totalToolCalls: 99 };
  return { store, artifact, artifacts, verifier, input, evidence };
}

test("SIMULATED_INTEGRATION: valid runtime records and rehashed artifact permit analysis without a subprocess", async (t) => {
  const f = await fixture(t); await f.evidence();
  assert.equal((await f.verifier.verifyNode(f.input)).status, "passed");
  await f.store.updateGraphNodeStatus("graph-test", "analyze", "completed");
  assert.equal((await f.verifier.verifyGoalCompletion("graph-test")).goalCompleted, true);
});
for (const mutation of ["missing", "tampered", "wrong-task", "wrong-worker", "wrong-revision", "wrong-run"] as const) {
  test(`SIMULATED_INTEGRATION: artifact ${mutation} cannot complete node or goal`, async (t) => {
    const f = await fixture(t); await f.evidence();
    if (mutation === "missing") await rm(f.artifact.storagePath);
    if (mutation === "tampered") await writeFile(f.artifact.storagePath, "Forged replacement");
    if (mutation === "wrong-task") await f.store.saveArtifact({ ...f.artifact, producerTaskId: "other" });
    if (mutation === "wrong-worker") await f.store.saveArtifact({ ...f.artifact, producerNodeId: "other" });
    if (mutation === "wrong-revision") await f.store.saveArtifact({ ...f.artifact, metadata: { ...f.artifact.metadata, graphRevision: 0 } });
    if (mutation === "wrong-run") await f.store.saveArtifact({ ...f.artifact, metadata: { ...f.artifact.metadata, runId: "old" } });
    assert.notEqual((await f.verifier.verifyNode(f.input)).status, "passed");
    await f.store.updateGraphNodeStatus("graph-test", "analyze", "completed");
    assert.equal((await f.verifier.verifyGoalCompletion("graph-test")).goalCompleted, false);
  });
}
test("MOCK_UNIT: forged exit code and SUCCESS cannot substitute for test execution", async (t) => {
  const f = await fixture(t); await f.evidence();
  assert.notEqual((await f.verifier.verifyNode({ ...f.input, acceptanceCriteria: [{ type: "test_exit_code", expected: 0, description: "Tests pass" }] })).status, "passed");
});
test("MOCK_UNIT: known runtime failure dominates model claims", async (t) => {
  const f = await fixture(t); await f.evidence({ success: false, exitCode: 1 });
  assert.equal((await f.verifier.verifyNode(f.input)).status, "failed");
});
for (const status of ["outcome_unknown", "waiting_approval"] as const) test(`MOCK_UNIT: ${status} blocks goal`, async (t) => {
  const f = await fixture(t); await f.evidence(); await f.store.updateGraphNodeStatus("graph-test", "analyze", status);
  assert.equal((await f.verifier.verifyGoalCompletion("graph-test")).goalCompleted, false);
});
test("MOCK_UNIT: no executed tool cannot be disguised by fabricated counters", async (t) => {
  const f = await fixture(t);
  await f.store.appendEvents([{ taskId: "task", runId: "run", nodeId: "mac", seq: 1, timestamp: Date.now(), eventType: "task.completed", data: {} }]);
  assert.equal((await f.verifier.verifyNode(f.input)).status, "failed");
});
test("MOCK_UNIT: planner rejects bwrap on Mac and provides correction feedback to model", async (t) => {
  const f = await fixture(t); let calls = 0;
  const node: GraphProposalNode = { nodeId: "inspect", title: "Inspect", goal: "Read code", candidateNodeId: "mac", candidateProjectId: "project", operation: "analyze", dependencies: [] };
  const planner = new AutonomousPlanner({ store: f.store, llmClient: { chat: async (messages) => {
    calls++;
    if (calls === 2) assert.match(messages.at(-1)!.content, /bwrap/);
    assert.match(messages[1]!.content, /verificationExpiresAt/);
    return { content: JSON.stringify({ nodes: [{ ...node, requiredCapabilities: calls === 1 ? ["bwrap"] : [] }, { ...node, nodeId: "join", dependencies: ["inspect"] }] }) };
  } } });
  const result = await planner.planGoal("并行检查并汇总项目报告");
  assert.equal(result.validation.valid, true); assert.equal(calls, 2);
  assert.equal(result.proposal.strategyDecision?.planningSource, "llm");
});
test("MOCK_UNIT: planner model outage cannot silently produce a static DAG", async (t) => {
  const f = await fixture(t);
  const planner = new AutonomousPlanner({ store: f.store, llmClient: { chat: async () => { throw new Error("fixture transport failure"); } } });
  const result = await planner.planGoal("并行检查并汇总项目报告");
  assert.equal(result.validation.valid, false); assert.equal(result.proposal.nodes.length, 0);
  assert.notEqual(result.proposal.strategyDecision?.planningSource, "synthesizer_fallback");
});
test("MOCK_UNIT: expired capability and unknown runtime are rejected", async (t) => {
  const f = await fixture(t); const validator = new RoutingValidator(f.store);
  const candidate = { nodeId: "mac", projectId: "project" };
  assert.equal((await validator.validateCandidate(candidate, { constraints: { readOnly: true }, requiredCapabilities: ["runtime:missing-python"] })).valid, false);
  const catalog = (await f.store.getCatalogRevision("mac"))!; catalog.capabilities[0]!.structuredDetails!.verificationExpiresAt = Date.now() - 1;
  await f.store.saveCatalogRevision("mac", 2, catalog.capabilities);
  assert.equal((await validator.validateCandidate(candidate, { constraints: { readOnly: true }, requiredCapabilities: [] })).code, "STALE_SANDBOX_CAPABILITY");
});
test("MOCK_UNIT: 分别检查 Mac is a positive request, not the negative 别检查 Mac", async (t) => {
  const f = await fixture(t); const planner = new AutonomousPlanner({ store: f.store });
  const strategy = await planner.evaluateExecutionStrategy("分别检查 Mac、Windows Native、WSL2 和腾讯云测试项目并汇总");
  assert.ok(strategy.selectedWorkers.some((w) => w.nodeId === "mac"));
  const excluded = await planner.evaluateExecutionStrategy("只检查 Windows，不要访问 Mac");
  assert.equal(excluded.selectedWorkers.some((w) => w.nodeId === "mac"), false);
});
test("MOCK_UNIT: independent goal review cannot override deterministic evidence failures and caches by input digest", async (t) => {
  const f = await fixture(t); let modelCalls = 0;
  const verifier = new ResultVerifier(f.store, f.artifacts, { chat: async () => { modelCalls++; return { content: JSON.stringify({ completed: true, reason: "Covered by fixture", missingEvidence: [] }) }; } });
  await f.evidence(); await f.verifier.verifyNode(f.input); await f.store.updateGraphNodeStatus("graph-test", "analyze", "completed");
  assert.equal((await verifier.verifyGoalCompletion("graph-test")).goalCompleted, false); assert.equal(modelCalls, 0);
  assert.equal((await verifier.verifyGoalCompletion("graph-test", true)).goalCompleted, true); assert.equal(modelCalls, 1);
  assert.equal((await verifier.verifyGoalCompletion("graph-test", true)).goalCompleted, true); assert.equal(modelCalls, 1);
  await writeFile(f.artifact.storagePath, "Tampered");
  assert.equal((await verifier.verifyGoalCompletion("graph-test", true)).goalCompleted, false); assert.equal(modelCalls, 1);
});

test("MOCK_UNIT: credential redaction preserves task IDs and planning usage while truncating deep unknown data", () => {
  const taskId = "task-2201837b-3a47-47fa-8037-566071b99c13";
  assert.equal(redactString(taskId), taskId);
  assert.equal(redactString("sk-test-aaf47d2ad540aaa"), "[REDACTED]");
  assert.deepEqual(redactObject({ planningTokens: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } }), { planningTokens: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } });
  assert.ok(!JSON.stringify(redactObject({ a: { b: { password: "private-value" } } }, 0, 1)).includes("private-value"));
});
test("MOCK_UNIT: a fresh valid heartbeat restores suspect status without reviving revoked nodes", async (t) => {
  const f = await fixture(t);
  await f.store.updateNodeStatus("mac", "suspect"); await f.store.updateNodeLastSeen("mac", Date.now());
  assert.equal((await f.store.getNode("mac"))!.status, "online");
  await f.store.updateNodeStatus("mac", "revoked"); await f.store.updateNodeLastSeen("mac", Date.now());
  assert.equal((await f.store.getNode("mac"))!.status, "revoked");
});


test("SIMULATED_INTEGRATION: replacing a failed producer must not retain its impossible join edge or artifact binding", async (t) => {
  const f = await fixture(t);
  const { GraphReplanner } = await import("../src/cluster/graph/graph-replanner.js");
  const source = (await f.store.getGraphNode("graph-test", "analyze"))!;
  await f.store.updateGraphNodeStatus("graph-test", "analyze", "failed");
  await f.store.saveGraphNode({ ...source, nodeId: "join", taskId: undefined, status: "blocked", requiredArtifacts: [{ name: "report.md", producerNodeId: "analyze" }] });
  await f.store.saveGraphEdges([{ graphId: "graph-test", edgeId: "old", fromNodeId: "analyze", toNodeId: "join", dependencyType: "success", requiredOutcome: "completed", artifactRequirements: [], createdAt: Date.now() }]);
  const replanner = new GraphReplanner(f.store, { advanceGraph: async () => {} } as any);
  const replacement: GraphProposalNode = { nodeId: "replacement", title: "Verify", goal: "Verify", producedArtifacts: [{ name: "report.md" }] };
  const incomplete = await replanner.replanGraph({ graphId: "graph-test", trigger: "task_failed", reason: "Replace failure", addNodes: [replacement], skipNodeIds: ["analyze"], rewireDependencies: [{ nodeId: "join", addDependencies: ["replacement"] }] });
  assert.equal(incomplete.success, false); assert.match(incomplete.reason, /superseded producer/);
  assert.equal((await f.store.getGraph("graph-test"))!.revision, 1);
  assert.equal(await f.store.getGraphNode("graph-test", "replacement"), null);
  const complete = await replanner.replanGraph({ graphId: "graph-test", trigger: "task_failed", reason: "Replace failure and bindings", addNodes: [replacement], skipNodeIds: ["analyze"], rewireDependencies: [{ nodeId: "join", dependencies: ["replacement"], requiredArtifacts: [{ name: "report.md", producerNodeId: "replacement" }] }] });
  assert.equal(complete.success, true); assert.equal((await f.store.getGraphNode("graph-test", "join"))!.status, "waiting_dependencies");
});


test("SIMULATED_INTEGRATION: a partial ordered tool stream cannot finalize before its terminal execution event", async (t) => {
  const f = await fixture(t);
  await f.store.appendEvents([{ taskId: "task", runId: "run", nodeId: "mac", seq: 1, timestamp: Date.now(), eventType: "tool.result", data: { source: "ToolExecutor", toolCallId: "partial", success: true } }]);
  const pending = await f.verifier.verifyNode(f.input); assert.equal(pending.status, "incomplete"); assert.equal(pending.evidence.pendingEvidence, true);
  await f.store.appendEvents([{ taskId: "task", runId: "run", nodeId: "mac", seq: 2, timestamp: Date.now(), eventType: "task.completed", data: {} }]);
  assert.equal((await f.verifier.verifyNode(f.input)).status, "passed");
});
test("SIMULATED_INTEGRATION: an artifact input requires its own successful bound read, not just arbitrary tool counts", async (t) => {
  const f = await fixture(t); const task = (await f.store.getTask("task"))!;
  task.dispatchOptions!.graphContext!.inputs = [{ artifactId: f.artifact.artifactId, producerNodeId: "upstream", name: "report.md", sha256: f.artifact.sha256, content: "Actual fixture bytes" }]; await f.store.saveTask(task);
  await f.evidence(); assert.equal((await f.verifier.verifyNode(f.input)).status, "failed");
  await f.store.appendEvents([{ taskId: "task", runId: "run", nodeId: "mac", seq: 3, timestamp: Date.now(), eventType: "tool.started", data: { toolCallId: "read", toolName: "read_graph_artifact", rawArgs: JSON.stringify({ name:"report.md", producerNodeId:"upstream" }) } }, { taskId: "task", runId: "run", nodeId: "mac", seq: 4, timestamp: Date.now(), eventType: "tool.result", data: { source:"ToolExecutor", toolCallId:"read", toolName:"read_graph_artifact", success:true } }]);
  assert.equal((await f.verifier.verifyNode(f.input)).status, "passed");
});


test("SIMULATED_INTEGRATION: stale concurrent verification snapshots reuse the persisted identical semantic review", async (t) => {
  const f = await fixture(t); await f.evidence(); await f.verifier.verifyNode(f.input); await f.store.updateGraphNodeStatus("graph-test", "analyze", "completed");
  let calls = 0;
  const verifier = new ResultVerifier(f.store, f.artifacts, { chat: async () => { calls++; return { content: JSON.stringify({ completed: true, reason: "Verified fixture", missingEvidence: [] }) }; } });
  const original = f.store.listGraphVerifications.bind(f.store); let reads = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.store.listGraphVerifications = async (...args) => { const snapshot = await original(...args); if (++reads === 2) await gate; return snapshot; };
  const first = verifier.verifyGoalCompletion("graph-test", true); const second = verifier.verifyGoalCompletion("graph-test", true);
  assert.equal((await first).goalCompleted, true); release(); assert.equal((await second).goalCompleted, true); assert.equal(calls, 1);
});
