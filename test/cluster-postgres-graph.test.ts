import { simulatedCapabilities, simulatedSandbox, recordSimulatedExecution } from "./helpers/runtime-truth-fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClusterDatabase } from "../src/cluster/storage/db.js";
import { PostgresClusterStore } from "../src/cluster/storage/cluster-store.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { ArtifactService } from "../src/cluster/artifacts/artifact-service.js";

test("REAL_DATABASE + SIMULATED_INTEGRATION: 隔离 schema 的外键、双分支模拟派发与产物汇总", { skip: !process.env.NASH_TEST_DATABASE_URL }, async (t) => {
  const connection = process.env.NASH_TEST_DATABASE_URL!;
  const admin = new ClusterDatabase(connection);
  const schema = `nash_graph_test_${randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(join(tmpdir(), "nash-postgres-graph-"));
  let db: ClusterDatabase | undefined; let schemaCreated = false;
  t.after(async () => {
    try {
      await db?.close();
      if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally { await admin.close(); await rm(directory, { recursive: true, force: true }); }
  });
  assert.equal(await admin.connect(), true);
  await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
  const url = new URL(connection); url.searchParams.set("options", `-c search_path=${schema}`);
  db = new ClusterDatabase(url.toString()); assert.equal(await db.connect(), true); await db.runMigrations();
  assert.equal((await db.query("SELECT current_schema() AS name")).rows[0].name, schema);
  const store = new PostgresClusterStore(db);
  for (const nodeId of ["A", "B", "summary"]) await store.saveNode({ nodeId, name: nodeId, role: "worker", platform: "linux", arch: "x64", hostname: "fixture", tokenHash: "fixture", status: "online", lastSeenAt: 1, metadata: {}, createdAt: 1, updatedAt: 1 });
  for (const n of await store.listNodes()) await store.saveCatalogRevision(n.nodeId, 1, simulatedCapabilities(n.platform));
  const sent: any[] = [];
  const scheduler = new TaskScheduler(store, { getConnection: () => ({ generation: 1, ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw).payload) } }) } as any, "coordinator");
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler, artifactService: new ArtifactService(store, directory),
    validator: { validateCandidate: async () => ({ valid: true, code: "VALID", reason: "isolated fixture" }) } });
  const branch = (id: string) => ({ nodeId: id, title: id, goal: "read-only report", operation: "analyze" as const, dependencies: [], candidateNodeId: id, candidateProjectId: "fixture",
    producedArtifacts: [{ name: `${id}.md`, contentType: "text/markdown" }], acceptanceCriteria: [{ type: "artifact_exists" as const, expected: `${id}.md`, description: "report" }] });
  const graph = await orchestrator.createGraph({ parentGoal: "parallel and join", reasoning: "regression", requiresMultiAgent: true, nodes: [branch("A"), branch("B"),
    { ...branch("summary"), dependencies: ["A", "B"], requiredArtifacts: [{ name: "A.md", producerNodeId: "A" }, { name: "B.md", producerNodeId: "B" }] }] });
  await orchestrator.startGraph(graph.graphId);
  assert.equal(sent.length, 2); assert.equal((await store.getGraph(graph.graphId))!.status, "running");
  for (let index = 0; index < 3; index++) {
    if (index === 1) assert.equal(sent.length, 2);
    if (index === 2) { assert.equal(sent.length, 3); assert.equal(sent[2].graphContext.inputs.length, 2); }
    const task = sent[index]; const id = task.graphContext.graphNodeId;
    await recordSimulatedExecution(store, task.taskId);
    await store.updateTaskStatus(task.taskId, "completed", { finalAnswer: `${id} report` });
    await orchestrator.handleNodeTaskCompleted(graph.graphId, task.taskId, `${id} report`, [{ name: `${id}.md`, contentType: "text/markdown", content: `${id} report` }]);
  }
  assert.equal((await store.getGraph(graph.graphId))!.status, "completed");
  assert.equal((await store.listArtifacts(graph.graphId)).length, 3);
});

test("PostgreSQL 隔离 schema：Worker 记忆快照原子替换、失败回滚与来源隔离", { skip: !process.env.NASH_TEST_DATABASE_URL }, async (t) => {
  const connection = process.env.NASH_TEST_DATABASE_URL!;
  const admin = new ClusterDatabase(connection); const schema = `nash_memory_test_${randomUUID().replaceAll("-", "")}`;
  let db: ClusterDatabase | undefined; let created = false;
  t.after(async () => { try { await db?.close(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.close(); } });
  assert.equal(await admin.connect(), true); await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  const url = new URL(connection); url.searchParams.set("options", `-c search_path=${schema}`);
  db = new ClusterDatabase(url.toString()); assert.equal(await db.connect(), true); await db.runMigrations();
  const store = new PostgresClusterStore(db);
  for (const nodeId of ["worker", "other"]) await store.saveNode({ nodeId, name: nodeId, role: "worker", platform: "linux", arch: "x64", hostname: "fixture", tokenHash: "fixture", status: "online", lastSeenAt: 1, metadata: {}, createdAt: 1, updatedAt: 1 });
  const entry = (entryId: string, nodeId = "worker") => ({ entryId, nodeId, projectId: "project", topic: entryId, summary: entryId, keywords: [], sourceReference: "source", confidence: .8, visibility: "summary" as const, revision: 1, updatedAt: 1 });
  await store.upsertMemoryIndex([entry("old"), entry("mem-disc-owned"), entry("other", "other")]);
  await assert.rejects(store.upsertWorkerMemorySnapshot("worker", [{ ...entry("invalid"), projectId: "x".repeat(129) }]));
  assert.ok((await store.listMemoryIndex()).some(e => e.entryId === "old"));
  await store.upsertWorkerMemorySnapshot("worker", [entry("new")]);
  assert.deepEqual((await store.listMemoryIndex()).map(e => e.entryId).sort(), ["mem-disc-owned", "new", "other"]);
  await store.upsertWorkerMemorySnapshot("worker", []);
  assert.deepEqual((await store.listMemoryIndex()).map(e => e.entryId).sort(), ["mem-disc-owned", "other"]);
});
