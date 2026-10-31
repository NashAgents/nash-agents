import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ClusterDatabase } from "../src/cluster/storage/db.js";
import { PostgresClusterStore } from "../src/cluster/storage/cluster-store.js";
import { AutonomousPlanner } from "../src/cluster/graph/autonomous-planner.js";
import { simulatedCapabilities, simulatedSandbox } from "./helpers/runtime-truth-fixtures.js";

// REAL_LLM + REAL_DATABASE + SIMULATED_INTEGRATION (catalog only).
// This test does not execute a remote worker and cannot establish a four-node E2E.
test("REAL_LLM + REAL_DATABASE: model proposes a DAG from an explicitly simulated capability catalog", {
  skip: process.env.NASH_RUN_REAL_LLM_TESTS !== "1" || !process.env.NASH_TEST_DATABASE_URL,
}, async (t) => {
  const connection = process.env.NASH_TEST_DATABASE_URL!;
  const admin = new ClusterDatabase(connection); let db: ClusterDatabase | undefined;
  const schema = `nash_planner_${randomUUID().replaceAll("-", "")}`; let created = false;
  t.after(async () => { try { await db?.close(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.close(); } });
  assert.equal(await admin.connect(), true); await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  const url = new URL(connection); url.searchParams.set("options", `-c search_path=${schema}`);
  db = new ClusterDatabase(url.toString()); assert.equal(await db.connect(), true); await db.runMigrations();
  const store = new PostgresClusterStore(db); const now = Date.now();
  for (const [nodeId, platform] of [["fixture-mac", "darwin"], ["fixture-linux", "linux"]]) {
    await store.saveNode({ nodeId: nodeId!, name: nodeId!, role: "worker", platform: platform!, arch: "x64", hostname: "SIMULATED", tokenHash: "fixture", status: "online", lastSeenAt: now, metadata: {}, createdAt: now, updatedAt: now });
    await store.saveCatalogRevision(nodeId!, 1, simulatedCapabilities(platform!));
    await store.upsertProjectCatalog([{ nodeId: nodeId!, projectId: `project-${nodeId}`, name: "Simulated project", canonicalPath: "/isolated-fixture", summary: "test", description: "test", technologies: [], capabilities: [], status: "active", visibility: "retrievable", registeredAt: now, updatedAt: now, lastIndexedAt: now, revision: 1 }]);
  }
  const client = AutonomousPlanner.createDefaultLlmClient(); assert.ok(client, "Explicit real model configuration required");
  const result = await new AutonomousPlanner({ store, llmClient: client }).planGoal("分别分析 Mac 与 Linux 测试项目并比较平台差异，最终汇总报告");
  assert.equal(result.validation.valid, true, result.validation.reason ?? result.proposal.strategyDecision?.planningError ?? "Invalid model plan");
  assert.equal(result.proposal.strategyDecision?.planningSource, "llm");
  assert.ok(result.proposal.nodes.length > 1);
  assert.ok(result.proposal.strategyDecision?.planningRequestIds?.length);
});
