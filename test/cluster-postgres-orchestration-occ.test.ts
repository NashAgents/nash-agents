import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ClusterDatabase } from "../src/cluster/storage/db.js";
import { PostgresClusterStore } from "../src/cluster/storage/cluster-store.js";
import type { AtomicGraphPatchSpec, DistributedGraphNodeRecord } from "../src/cluster/graph/types.js";

// REAL_DATABASE only. No model, remote Worker or sandbox is involved.
const connection = process.env.NASH_TEST_DATABASE_URL;
class InjectedDatabase extends ClusterDatabase {
  failAfter?: RegExp;
  override async query<R extends import("pg").QueryResultRow = any>(sql: string, params?: any[]): Promise<import("pg").QueryResult<R>> {
    const result = await super.query<R>(sql, params);
    if (this.failAfter?.test(sql)) { this.failAfter = undefined; throw new Error("CONTROLLED_TRANSACTION_FAILURE"); }
    return result;
  }
}
async function fixture(t: TestContext) {
  const url = new URL(connection!);
  assert.match(url.pathname, /(?:test|dev|runtime_truth)/, "Fault injection requires a dedicated test database");
  const admin = new ClusterDatabase(connection); let db: InjectedDatabase | undefined;
  const schema = `nash_occ_${randomUUID().replaceAll("-", "")}`; let created = false;
  t.after(async () => { try { await db?.close(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.close(); } });
  assert.equal(await admin.connect(), true); await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  url.searchParams.set("options", `-c search_path=${schema}`);
  db = new InjectedDatabase(url.toString()); assert.equal(await db.connect(), true); await db.runMigrations();
  const store = new PostgresClusterStore(db); const now = Date.now();
  await store.saveGraph({ graphId: "graph", parentGoal: "Atomic recovery", status: "running", revision: 1, budget: { maxNodes: 10, maxParallelTasks: 4, maxReplanAttempts: 2, maxDepth: 6, totalTimeoutMs: 10000, perTaskTimeoutMs: 10000 }, concurrencyPolicy: { maxConcurrentTasks: 4, projectWriteLock: true }, createdAt: now, updatedAt: now });
  const node = (id: string): DistributedGraphNodeRecord => ({ graphId: "graph", nodeId: id, title: id, goal: id, operation: "analyze", requiredCapabilities: [], requiredArtifacts: [], producedArtifacts: [], acceptanceCriteria: [], status: "ready", failurePolicy: "block_dependents", retryPolicy: { maxRetries: 0, backoffMs: 0 }, attemptCount: 0, createdAt: now, updatedAt: now });
  await store.saveGraphNode(node("A")); await store.saveGraphNode(node("B"));
  await store.saveGraphEdges([{ graphId: "graph", edgeId: "old", fromNodeId: "A", toNodeId: "B", dependencyType: "success", requiredOutcome: "completed", artifactRequirements: [], createdAt: now }]);
  const patch: AtomicGraphPatchSpec = { graphId: "graph", operationId: "operation", expectedRevision: 1, nextRevision: 2, reason: "Insert C", addNodes: [node("C")], removeEdges: [{ fromNodeId: "A", toNodeId: "B" }], addEdges: [{ graphId: "graph", edgeId: "new", fromNodeId: "C", toNodeId: "B", dependencyType: "success", requiredOutcome: "completed", artifactRequirements: [], createdAt: now }] };
  return { db, store, patch, node, schema, connection: url.toString() };
}

test("REAL_DATABASE: concurrent CAS accepts exactly one patch and rolls the losing graph back", { skip: !connection }, async (t) => {
  const { store, patch, node } = await fixture(t);
  const results = await Promise.all([store.applyGraphPatchAtomic(patch), store.applyGraphPatchAtomic({ ...patch, operationId: "other", addNodes: [node("D")], addEdges: [] })]);
  assert.equal(results.filter((r) => r.success).length, 1); assert.equal(results.filter((r) => r.conflict).length, 1);
  assert.equal((await store.getGraph("graph"))!.revision, 2);
  assert.equal((await store.listGraphNodes("graph")).length, 3);
  assert.equal((await store.listGraphRevisions("graph")).length, 1);
});
test("REAL_DATABASE: operation replay survives a new Store instance and never adds nodes or events twice", { skip: !connection }, async (t) => {
  const { db, store, patch } = await fixture(t); assert.equal((await store.applyGraphPatchAtomic(patch)).success, true);
  const result = await new PostgresClusterStore(db).applyGraphPatchAtomic(patch);
  assert.equal(result.success, true); assert.equal(result.replayed, true);
  assert.equal((await store.listGraphNodes("graph")).length, 3);
  assert.equal((await store.listGraphEvents("graph")).length, 1);
  await assert.rejects(store.applyGraphPatchAtomic({ ...patch, reason: "Different patch with same ID" }), /different content/);
});
for (const [stage, pattern] of [
  ["revision CAS", /UPDATE cluster_graphs SET revision/],
  ["node creation", /INSERT INTO cluster_graph_nodes/],
  ["old edge deletion", /DELETE FROM cluster_graph_edges/],
  ["new edge insertion", /INSERT INTO cluster_graph_edges/],
  ["durable event publication", /INSERT INTO cluster_graph_events/],
  ["operation recording before commit", /INSERT INTO cluster_graph_patch_operations/],
] as const) test(`REAL_DATABASE: failure after ${stage} rolls back all mutations`, { skip: !connection }, async (t) => {
  const { db, store, patch } = await fixture(t); db.failAfter = pattern;
  await assert.rejects(store.applyGraphPatchAtomic(patch), /CONTROLLED_TRANSACTION_FAILURE/);
  assert.equal((await store.getGraph("graph"))!.revision, 1);
  assert.equal(await store.getGraphNode("graph", "C"), null);
  assert.deepEqual((await store.listGraphEdges("graph")).map((e) => e.edgeId), ["old"]);
  assert.equal((await store.listGraphRevisions("graph")).length, 0);
  assert.equal((await store.listGraphEvents("graph")).length, 0);
  assert.equal((await db.query("SELECT count(*) AS count FROM cluster_graph_patch_operations")).rows[0].count, "0");
});
test("REAL_DATABASE: graph cancellation and unknown outcomes prohibit patching", { skip: !connection }, async (t) => {
  const { store, patch } = await fixture(t);
  for (const status of ["cancelling", "cancelled", "waiting_approval", "outcome_unknown"] as const) {
    await store.updateGraphStatus("graph", status);
    assert.equal((await store.applyGraphPatchAtomic(patch)).success, false);
    assert.equal((await store.getGraph("graph"))!.revision, 1);
  }
});
test("REAL_DATABASE: concurrent event appends allocate unique causal sequences", { skip: !connection }, async (t) => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.appendGraphEvent("graph", "test.causal", { i })));
  assert.deepEqual((await store.listGraphEvents("graph")).map((e) => e.seq), Array.from({ length: 20 }, (_, i) => i + 1));
});

async function crashChild(config: Record<string, unknown>) {
  const child = spawn(process.execPath, ["test/fixtures/cluster-graph-crash-child.mjs"], {
    env: { ...process.env, NASH_CRASH_FIXTURE: JSON.stringify(config) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; });
  let error = ""; child.stderr.on("data", (chunk) => { error += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  try {
    const [code, signal] = await once(child, "exit");
    assert.equal(code, null, error); assert.equal(signal, "SIGKILL", error);
    return output;
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}
for (const stage of ["after_node", "before_commit", "after_commit"] as const) test(`REAL_DATABASE: process SIGKILL ${stage} preserves transaction boundaries across restart`, { skip: !connection }, async (t) => {
  const f = await fixture(t); const output = await crashChild({ connection: f.connection, patch: f.patch, stage });
  assert.equal((await f.store.getGraph("graph"))!.revision, stage === "after_commit" ? 2 : 1);
  assert.equal(Boolean(await f.store.getGraphNode("graph", "C")), stage === "after_commit");
  if (stage === "after_commit") {
    assert.match(output, /PATCH_COMMITTED/);
    assert.equal((await new PostgresClusterStore(f.db).applyGraphPatchAtomic(f.patch)).replayed, true);
  } else assert.equal((await f.store.listGraphRevisions("graph")).length, 0);
});
test("REAL_DATABASE + SIMULATED_INTEGRATION: real Coordinator process restart preserves unknown write outcome and never redispatches it", { skip: !connection }, async (t) => {
  const f = await fixture(t); const root = await mkdtemp(join(tmpdir(), "nash-crash-coordinator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await f.store.updateGraphStatus("graph", "outcome_unknown");
  await f.store.updateGraphNodeStatus("graph", "A", "outcome_unknown");
  await f.store.saveGraphNode({ ...f.node("A"), operation: "execute", status: "outcome_unknown" });
  for (let attempt = 0; attempt < 2; attempt++) assert.match(await crashChild({ connection: f.connection, stage: "supervisor", directory: root }), /SUPERVISOR_RECOVERED/);
  assert.equal((await f.store.getGraphNode("graph", "A"))!.status, "outcome_unknown");
  assert.equal((await f.store.listTasks()).length, 0); assert.equal((await f.store.pollPendingOutbox()).length, 0);
});
test("REAL_DATABASE: atomic patch binds real status and text values, including node updates", { skip: !connection }, async (t) => {
  const { store, patch } = await fixture(t);
  const result = await store.applyGraphPatchAtomic({ ...patch, newGraphStatus: "running", graphError: "original error details", graphFinalSummary: "real summary", updateNodes: [{ nodeId: "B", status: "waiting_dependencies", error: "dependency changed", resultSummary: "retained text" }] });
  assert.equal(result.success, true);
  const graph = (await store.getGraph("graph"))!;
  assert.equal(graph.status, "running"); assert.equal(graph.error, "original error details"); assert.equal(graph.finalSummary, "real summary");
  const node = (await store.getGraphNode("graph", "B"))!;
  assert.equal(node.status, "waiting_dependencies"); assert.equal(node.error, "dependency changed"); assert.equal(node.resultSummary, "retained text");
});

test("REAL_DATABASE: a delayed verifier cannot finalize over cancellation or a newer graph revision", { skip: !connection }, async (t) => {
  const { store, patch } = await fixture(t);
  assert.equal(await store.transitionGraphStatus('graph', 1, 'running', 'cancelling'), true);
  assert.equal(await store.transitionGraphStatus('graph', 1, 'running', 'completed'), false);
  assert.equal((await store.getGraph('graph'))!.status, 'cancelling');
  await store.updateGraphStatus('graph', 'running');
  assert.equal((await store.applyGraphPatchAtomic(patch)).success, true);
  assert.equal(await store.transitionGraphStatus('graph', 1, 'running', 'completed'), false);
  assert.equal((await store.getGraph('graph'))!.revision, 2);
  assert.equal((await store.getGraph('graph'))!.status, 'running');
});


test("REAL_DATABASE: graph cancellation claims the latest revision when racing an atomic patch", { skip: !connection }, async (t) => {
  const { store, patch } = await fixture(t);
  const { DistributedGraphOrchestrator } = await import("../src/cluster/graph/graph-orchestrator.js");
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: {} as any });
  await Promise.all([store.applyGraphPatchAtomic(patch), orchestrator.cancelGraph("graph")]);
  assert.equal((await store.getGraph("graph"))!.status,"cancelled");
  assert.ok((await store.listGraphNodes("graph")).every(node=>node.status==='cancelled'));
});


for (const stage of ["outbox_before_send", "outbox_after_send_before_ack"] as const) test(`REAL_DATABASE + SIMULATED_INTEGRATION: Coordinator SIGKILL ${stage} preserves delivery identity and durable claim`, { skip: !connection }, async (t) => {
  const f = await fixture(t); const root = await mkdtemp(join(tmpdir(), "nash-outbox-crash-")); t.after(()=>rm(root,{recursive:true,force:true}));
  await f.store.updateGraphStatus("graph","paused");
  const now=Date.now(); const targetNodeId="outbox-worker";const projectId="outbox-project";
  await f.store.saveNode({nodeId:targetNodeId,name:"SIMULATED worker",role:"worker",platform:process.platform,arch:process.arch,hostname:"fixture",tokenHash:"fixture",status:"online",lastSeenAt:now,createdAt:now,updatedAt:now,metadata:{}});
  const { simulatedCapabilities } = await import("./helpers/runtime-truth-fixtures.js");
  await f.store.saveCatalogRevision(targetNodeId,1,simulatedCapabilities(process.platform));
  await f.store.upsertProjectCatalog([{nodeId:targetNodeId,projectId,name:"fixture",summary:"simulation",description:"simulation",status:"active",technologies:[],capabilities:[],canonicalPath:root,registeredAt:now,updatedAt:now,lastIndexedAt:now,revision:1,visibility:"discoverable"}]);
  const config={connection:f.connection,directory:root,targetNodeId,projectId};
  const count=async()=>Number(await readFile(join(root,"counter.txt"),'utf8').catch(()=>"0"));
  await crashChild({...config,stage});
  assert.equal(await count(),stage==='outbox_before_send'?0:1);
  const original=(await f.store.listTasks())[0]!;
  assert.ok(original.runId); assert.equal((await f.store.pollPendingOutbox()).length,1);
  await crashChild({...config,stage:'outbox_replay'});
  assert.ok(await count()<=1,'Durable journal must never repeat the simulated side effect');
  assert.equal((await f.store.listTasks()).length,1);assert.equal((await f.store.getTask(original.taskId))!.runId,original.runId);
  const frames=(await readFile(join(root,'frames.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.ok(new Set(frames.map(frame=>frame.messageId)).size<=1);
  if(stage==='outbox_after_send_before_ack')assert.equal(await count(),1);
});
