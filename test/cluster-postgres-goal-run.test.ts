import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { ClusterDatabase } from "../src/cluster/storage/db.js";
import { PostgresClusterStore } from "../src/cluster/storage/cluster-store.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { defaultTraceContext } from "../src/observability/trace-context.js";
import { processGoalRun } from "../src/cluster/coordinator/goal-run-service.js";
import { CLUSTER_MIGRATIONS } from "../src/cluster/storage/migrations.js";
import { ClusterApiHandler } from "../src/cluster/coordinator/api-server.js";
import { EventBus } from "../src/observability/event-bus.js";

const connection = process.env.NASH_TEST_DATABASE_URL;

test("REAL_DATABASE + PROCESS_CRASH: two coordinators recover one turn without replaying the scout", { skip: !connection, timeout: 90000 }, async t => {
  const url = new URL(connection!); assert.match(url.pathname, /(?:test|dev|runtime_truth)/);
  const admin = new ClusterDatabase(connection), schema = `nash_recover_${randomUUID().replaceAll("-", "")}`;
  let db: ClusterDatabase | undefined, db2: ClusterDatabase | undefined, created = false;
  const handlers: ClusterApiHandler[] = [], buses: EventBus[] = [];
  let child: ChildProcessWithoutNullStreams | undefined;
  t.after(async () => { try { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); for (const handler of handlers) handler.close(); for (const bus of buses) bus.clear(); await db2?.close(); await db?.close(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.close(); } });
  assert.equal(await admin.connect(), true); await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  url.searchParams.set("options", `-c search_path=${schema}`);
  db = new ClusterDatabase(url.toString()); db2 = new ClusterDatabase(url.toString());
  assert.equal(await db.connect(), true); assert.equal(await db2.connect(), true); await db.runMigrations();
  const a = new PostgresClusterStore(db), b = new PostgresClusterStore(db2);
  t.diagnostic("isolated schema migrated");
  await a.saveConversation({ id: "c", title: "fixture", createdAt: 1, updatedAt: 1, messages: [] });
  const conversation = (await a.getConversation("c"))!;
  conversation.messages.push({ id: "u", conversationId: "c", sender: "user", content: "inspect", timestamp: 1, metadata: { goalRunId: "g" } });
  await a.createGoalRunWithConversation({ goalRunId: "g", conversationId: "c", userMessageId: "u", rootGoal: "inspect", status: "planning", currentStage: "planning", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 }, conversation);
  await a.saveNode({ nodeId: "worker", name: "worker", role: "worker", platform: "linux", arch: "x64", hostname: "fixture", tokenHash: "fixture", status: "offline", lastSeenAt: 1, metadata: {}, createdAt: 1, updatedAt: 1 });
  const childSource = `
    import { ClusterDatabase } from './src/cluster/storage/db.ts';
    import { PostgresClusterStore } from './src/cluster/storage/cluster-store.ts';
    const db = new ClusterDatabase(process.env.NASH_TEST_CHILD_URL);
    if (!await db.connect()) process.exit(2);
    const store = new PostgresClusterStore(db);
    const lease = await store.claimGoalTurnLease('g', 'u', 'crashed', 60000);
    if (!lease) process.exit(3);
    await store.saveTaskWithGoal({ taskId: 'scout', runId: 'run', nodeId: 'worker', projectId: 'p', goal: 'inspect', status: 'running', dispatchAttempt: 1, createdAt: 1, updatedAt: 1, dispatchOptions: { contextOverrides: { goalRunId: 'g', taskType: 'scout' } } }, 'g', lease);
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `;
  child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource], { cwd: process.cwd(), env: { ...process.env, NASH_TEST_CHILD_URL: url.toString() }, stdio: "pipe" });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child did not persist its task")), 20000);
    child!.stdout.on("data", data => { if (String(data).includes("READY")) { clearTimeout(timeout); resolve(); } });
    child!.once("exit", () => { clearTimeout(timeout); reject(new Error("child exited before persistence")); });
  });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  t.diagnostic("owner process terminated after persisting scout");
  await db.query("UPDATE cluster_goal_runs SET payload=jsonb_set(payload, '{turnLease,expiresAt}', '0'::jsonb) WHERE goal_run_id='g'");
  for (const store of [a, b]) {
    const eventBus = new EventBus(); buses.push(eventBus);
    handlers.push(new ClusterApiHandler({ store, eventBus, scheduler: {} as any, registry: { listOnlineConnections: () => [] } as any, inviteManager: {} as any, coordinatorNodeId: "test", adminApiKey: "test" }));
  }
  const deadline = Date.now() + 15000;
  while (!(await a.getGoalRun("g"))?.turnRecovery && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  const recovered = (await a.getGoalRun("g"))!;
  t.diagnostic("recovery wait finished");
  assert.equal(recovered.turnRecovery?.turnId, "u");
  assert.equal((await a.listTasks({ limit: 100 })).length, 1);
  assert.equal((await a.getConversation("c"))?.messages.filter(message => message.sender === "assistant").length, 1);
  await a.updateTaskStatus("scout", "completed");
  await Promise.all([processGoalRun(a, "g"), processGoalRun(b, "g")]);
  const final = (await a.getGoalRun("g"))!;
  assert.equal(final.status, "partially_completed");
  assert.equal(final.reportHistory?.length, 1);
});

test("REAL_DATABASE: turn lease excludes concurrent owners and fences stale writes", { skip: !connection }, async t => {
  const url = new URL(connection!); assert.match(url.pathname, /(?:test|dev|runtime_truth)/);
  const admin = new ClusterDatabase(connection), schema = `nash_lease_${randomUUID().replaceAll("-", "")}`;
  let db: ClusterDatabase | undefined, db2: ClusterDatabase | undefined, created = false;
  t.after(async () => { try { await db2?.close(); await db?.close(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.close(); } });
  assert.equal(await admin.connect(), true); await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  url.searchParams.set("options", `-c search_path=${schema}`);
  db = new ClusterDatabase(url.toString()); db2 = new ClusterDatabase(url.toString());
  assert.equal(await db.connect(), true); assert.equal(await db2.connect(), true); await db.runMigrations();
  const a = new PostgresClusterStore(db), b = new PostgresClusterStore(db2);
  await a.saveConversation({ id: "c", title: "fixture", createdAt: 1, updatedAt: 1, messages: [{ id: "u", conversationId: "c", sender: "user", content: "inspect", timestamp: 1 }] });
  await a.createGoalRun({ goalRunId: "g", conversationId: "c", userMessageId: "u", rootGoal: "inspect", status: "planning", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  const claims = await Promise.all([a.claimGoalTurnLease("g", "u", "a", 60000), b.claimGoalTurnLease("g", "u", "b", 60000)]);
  const first = claims.find(Boolean)!;
  assert.equal(claims.filter(Boolean).length, 1);
  const graphOwner = { projectId: "coordinator", sessionId: "c", traceId: "trace", goalRunId: "g", goalTurnFence: first };
  const orchestrator = new DistributedGraphOrchestrator({ store: a, scheduler: {} as any });
  const proposal = { parentGoal: "inspect", reasoning: "test", requiresMultiAgent: true, nodes: [{ nodeId: "n", title: "n", goal: "n", dependencies: [] }] };
  const graph = await defaultTraceContext.run(graphOwner, () => orchestrator.createGraph(proposal));
  await db.query("UPDATE cluster_goal_runs SET payload=jsonb_set(payload, '{turnLease,expiresAt}', '0'::jsonb) WHERE goal_run_id='g'");
  const second = (await b.claimGoalTurnLease("g", "u", "replacement", 60000))!;
  assert.equal(second.generation, first.generation + 1);
  assert.equal(await a.renewGoalTurnLease("g", first.ownerId, first.generation, 60000), false);
  await assert.rejects(defaultTraceContext.run(graphOwner, () => orchestrator.createGraph(proposal)), /lease expired or was superseded/);
  await assert.rejects(defaultTraceContext.run(graphOwner, () => orchestrator.startGraph(graph.graphId)), /lease expired or was superseded/);
  assert.equal((await a.getGraph(graph.graphId))?.status, "ready");
  const task = { taskId: "t", nodeId: "n", projectId: "p", goal: "inspect", status: "created" as const, dispatchAttempt: 1, createdAt: 1, updatedAt: 1 };
  await assert.rejects(a.saveTaskWithGoal(task, "g", first), /lease expired or was superseded/);
  assert.equal(await a.getTask("t"), null);
  const answer = { id: "answer", conversationId: "c", sender: "assistant" as const, content: "pending", timestamp: 2, metadata: { goalRunId: "g", goalRunTurnId: "u" } };
  await assert.rejects(a.commitGoalTurnResponse("g", answer, first), /lease expired or was superseded/);
  assert.equal((await b.commitGoalTurnResponse("g", answer, second)).inserted, true);
  assert.equal((await a.commitGoalTurnResponse("g", { ...answer, id: "duplicate" }, first)).inserted, false);
  assert.equal((await a.getConversation("c"))?.messages.length, 2);
});
class InjectedDatabase extends ClusterDatabase {
  failAfter?: RegExp;
  override async query<R extends import("pg").QueryResultRow = any>(sql: string, params?: any[]): Promise<import("pg").QueryResult<R>> {
    const result = await super.query<R>(sql, params);
    if (this.failAfter?.test(sql)) { this.failAfter = undefined; throw new Error("injected failure"); }
    return result;
  }
}
test("REAL_DATABASE: new GoalRun and user message roll back or commit together", { skip: !connection }, async t => {
  const url = new URL(connection!); assert.match(url.pathname, /(?:test|dev|runtime_truth)/);
  const admin = new ClusterDatabase(connection), schema = `nash_create_${randomUUID().replaceAll("-", "")}`;
  let db: InjectedDatabase | undefined, created = false;
  t.after(async () => { try { await db?.close(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.close(); } });
  assert.equal(await admin.connect(), true); await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  url.searchParams.set("options", `-c search_path=${schema}`);
  db = new InjectedDatabase(url.toString()); assert.equal(await db.connect(), true); await db.runMigrations();
  const store = new PostgresClusterStore(db);
  await store.saveConversation({ id: "c", title: "fixture", createdAt: 1, updatedAt: 1, messages: [] });
  const conversation = (await store.getConversation("c"))!;
  conversation.messages.push({ id: "u", conversationId: "c", sender: "user", content: "inspect", timestamp: 2, metadata: { goalRunId: "g" } });
  const goal = { goalRunId: "g", conversationId: "c", userMessageId: "u", rootGoal: "inspect", status: "planning" as const, linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 2, updatedAt: 2 };
  db.failAfter = /UPDATE cluster_web_conversations SET title/;
  await assert.rejects(store.createGoalRunWithConversation(goal, conversation, { ownerId: "owner", ttlMs: 60_000 }), /injected failure/);
  assert.equal(await store.getGoalRun("g"), null);
  assert.equal((await store.getConversation("c"))?.messages.length, 0);
  assert.equal(await store.createGoalRunWithConversation(goal, conversation, { ownerId: "owner", ttlMs: 60_000 }), true);
  assert.equal(await store.createGoalRunWithConversation(goal, conversation), false);
  const restored = new PostgresClusterStore(db);
  assert.equal((await restored.getGoalRun("g"))?.userMessageId, "u");
  assert.equal((await restored.getGoalRun("g"))?.turnLease?.ownerId, "owner");
  assert.equal((await restored.getConversation("c"))?.messages[0]?.metadata?.goalRunId, "g");
});
test("REAL_DATABASE: response and GoalRun stage commit atomically and deduplicate concurrent delivery", { skip: !connection }, async t => {
  const url = new URL(connection!); assert.match(url.pathname, /(?:test|dev|runtime_truth)/);
  const admin = new ClusterDatabase(connection), schema = `nash_turn_${randomUUID().replaceAll("-", "")}`;
  let db: InjectedDatabase | undefined, created = false;
  t.after(async () => { try { await db?.close(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.close(); } });
  assert.equal(await admin.connect(), true); await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  url.searchParams.set("options", `-c search_path=${schema}`);
  db = new InjectedDatabase(url.toString()); assert.equal(await db.connect(), true); await db.runMigrations();
  const store = new PostgresClusterStore(db);
  await store.saveConversation({ id: "c", title: "fixture", createdAt: 1, updatedAt: 1, messages: [{ id: "u", conversationId: "c", sender: "user", content: "inspect", timestamp: 1 }] });
  await store.createGoalRun({ goalRunId: "g", conversationId: "c", userMessageId: "u", rootGoal: "inspect", status: "planning", currentStage: "planning", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  const message = { id: "answer", conversationId: "c", sender: "assistant" as const, content: "still running", timestamp: 2, metadata: { goalRunId: "g", goalRunTurnId: "u" } };
  db.failAfter = /UPDATE cluster_goal_runs SET revision/;
  await assert.rejects(store.commitGoalTurnResponse("g", message), /injected failure/);
  assert.equal((await store.getConversation("c"))?.messages.length, 1);
  assert.equal((await store.getGoalRun("g"))?.currentStage, "planning");
  const commits = await Promise.all([store.commitGoalTurnResponse("g", message), store.commitGoalTurnResponse("g", { ...message, id: "duplicate" })]);
  assert.deepEqual(commits.map(result => result.inserted).sort(), [false, true]);
  assert.equal((await store.getConversation("c"))?.messages.length, 2);
  const result = (await new PostgresClusterStore(db).getGoalRun("g"))!;
  assert.equal(result.currentStage, "awaiting_verification");
  assert.equal(result.reportRevision, 1);
  assert.equal(result.interimMessageId, (await store.getConversation("c"))?.messages[1]?.id);
});

test("REAL_DATABASE: clarification and lease roll back together on failure", { skip: !connection }, async t => {
  const url = new URL(connection!); assert.match(url.pathname, /(?:test|dev|runtime_truth)/);
  const admin = new ClusterDatabase(connection), schema = `nash_continue_${randomUUID().replaceAll("-", "")}`;
  let db: InjectedDatabase | undefined, created = false;
  t.after(async () => { try { await db?.close(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.close(); } });
  assert.equal(await admin.connect(), true); await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  url.searchParams.set("options", `-c search_path=${schema}`);
  db = new InjectedDatabase(url.toString()); assert.equal(await db.connect(), true); await db.runMigrations();
  const store = new PostgresClusterStore(db);
  await store.saveConversation({ id: "c", title: "fixture", createdAt: 1, updatedAt: 1, messages: [{ id: "u", conversationId: "c", sender: "user", content: "inspect", timestamp: 1 }] });
  await store.createGoalRun({ goalRunId: "g", conversationId: "c", userMessageId: "u", rootGoal: "inspect", status: "partially_completed", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 1, revision: 1, createdAt: 1, updatedAt: 1 });
  const conversation = (await store.getConversation("c"))!;
  conversation.messages.push({ id: "u2", conversationId: "c", sender: "user", content: "choice", timestamp: 2, metadata: { goalRunId: "g" } });
  db.failAfter = /UPDATE cluster_goal_runs SET revision/;
  await assert.rejects(store.continueGoalRunWithConversation("g", conversation, "u2", "owner", 60_000), /injected failure/);
  assert.deepEqual((await store.getConversation("c"))?.messages.map(message => message.id), ["u"]);
  assert.equal((await store.getGoalRun("g"))?.turnLease, undefined);
  assert.equal((await store.continueGoalRunWithConversation("g", conversation, "u2", "owner", 60_000))?.turnId, "u2");
  assert.equal((await new PostgresClusterStore(db).getGoalRun("g"))?.turnLease?.turnId, "u2");
  assert.deepEqual((await store.getConversation("c"))?.messages.map(message => message.id), ["u", "u2"]);
});
test("REAL_DATABASE: GoalRun graph and task ownership are atomic and reports survive restart", { skip: !connection }, async t => {
  const url = new URL(connection!);
  assert.match(url.pathname, /(?:test|dev|runtime_truth)/);
  const admin = new ClusterDatabase(connection), schema = `nash_goal_${randomUUID().replaceAll("-", "")}`;
  let db: InjectedDatabase | undefined, created = false;
  t.after(async () => { try { await db?.close(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.close(); } });
  assert.equal(await admin.connect(), true);
  await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  url.searchParams.set("options", `-c search_path=${schema}`);
  db = new InjectedDatabase(url.toString()); assert.equal(await db.connect(), true);
  await db.runMigrations(); await db.runMigrations();
  const store = new PostgresClusterStore(db);
  await store.saveConversation({ id: "conv", title: "test", createdAt: 1, updatedAt: 1, messages: [] });
  await store.createGoalRun({ goalRunId: "goal", conversationId: "conv", userMessageId: "msg", rootGoal: "inspect", status: "running", currentStage: "awaiting_verification", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  await store.saveNode({ nodeId: "worker", name: "worker", role: "worker", platform: "linux", arch: "x64", hostname: "fixture", tokenHash: "fixture", status: "offline", lastSeenAt: 1, metadata: {}, createdAt: 1, updatedAt: 1 });
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: {} as any });
  const proposal = { parentGoal: "inspect", reasoning: "test", requiresMultiAgent: true, nodes: [{ nodeId: "n", title: "n", goal: "n", dependencies: [] }] };
  db.failAfter = /INSERT INTO cluster_graph_nodes/;
  await assert.rejects(defaultTraceContext.run({ projectId: "c", sessionId: "conv", traceId: "t", goalRunId: "goal" }, () => orchestrator.createGraph(proposal)), /injected failure/);
  assert.equal((await store.listGraphs()).length, 0);
  assert.deepEqual((await store.getGoalRun("goal"))?.linkedGraphIds, []);
  assert.equal((await store.getGoalRun("goal"))?.coverageHistory, undefined);
  const graph = await defaultTraceContext.run({ projectId: "c", sessionId: "conv", traceId: "t", goalRunId: "goal" }, () => orchestrator.createGraph(proposal));
  assert.deepEqual((await store.getGoalRun("goal"))?.linkedGraphIds, [graph.graphId]);
  assert.equal((await store.getGoalRun("goal"))?.coverageHistory?.[0]?.graphRevision, 1);
  const task = { taskId: "scout", runId: "run", nodeId: "worker", projectId: "p", goal: "inspect", status: "running" as const, dispatchAttempt: 1, createdAt: 1, updatedAt: 1, dispatchOptions: { contextOverrides: { goalRunId: "goal", taskType: "scout" } } };
  db.failAfter = /INSERT INTO cluster_tasks/;
  await assert.rejects(store.saveTaskWithGoal(task, "goal"), /injected failure/);
  assert.equal(await store.getTask("scout"), null);
  assert.deepEqual((await store.getGoalRun("goal"))?.linkedTaskIds, []);
  await store.saveTaskWithGoal(task, "goal");
  const graphContext = { graphId: graph.graphId, graphNodeId: "n", inputs: [], outputs: [] };
  await store.saveTaskWithGoal({ ...task, taskId: "a-second", runId: "second", status: "completed", dispatchOptions: { graphContext: { ...graphContext, executionAttempt: 2 } } }, "goal");
  await store.saveTaskWithGoal({ ...task, taskId: "z-first", runId: "first", status: "failed", dispatchOptions: { graphContext: { ...graphContext, executionAttempt: 1 } } }, "goal");
  assert.deepEqual((await store.listGraphTaskAttempts(graph.graphId, "n")).map(item => item.taskId), ["z-first", "a-second"]);
  await store.updateGraphStatus(graph.graphId, "partially_completed");
  await store.updateTaskStatus("scout", "completed");
  await Promise.all([processGoalRun(store, "goal"), processGoalRun(store, "goal")]);
  const restored = new PostgresClusterStore(db);
  const result = (await restored.getGoalRun("goal"))!;
  assert.equal(result.status, "partially_completed");
  assert.equal(result.reportRevision, 1);
  assert.ok(result.completedAt);
  assert.equal(result.reportHistory?.length, 1);
  const patch = { graphId: graph.graphId, operationId: "replan", expectedRevision: 1, nextRevision: 2, reason: "recover", newGraphStatus: "running" as const };
  db.failAfter = /INSERT INTO cluster_graph_revisions/;
  await assert.rejects(store.applyGraphPatchAtomic(patch), /injected failure/);
  assert.equal((await store.getGoalRun("goal"))?.finalReport, result.finalReport);
  assert.equal((await store.getGoalRun("goal"))?.coverageHistory?.length, 1);
  assert.equal((await store.getGraph(graph.graphId))?.revision, 1);
  assert.equal((await store.applyGraphPatchAtomic(patch)).success, true);
  const afterPatch = (await store.getGoalRun("goal"))!;
  assert.equal(afterPatch.status, "running");
  assert.equal(afterPatch.finalReport, undefined);
  assert.equal(afterPatch.completedAt, undefined);
  assert.equal(afterPatch.reportHistory?.length, 1);
  assert.deepEqual(afterPatch.coverageHistory?.map(coverage => coverage.graphRevision), [1, 2]);
});

test("REAL_DATABASE: coverage evaluation persists and only attempt-bound receipts can complete the goal", { skip: !connection }, async t => {
  const url = new URL(connection!);
  assert.match(url.pathname, /(?:test|dev|runtime_truth)/);
  const admin = new ClusterDatabase(connection), schema = `nash_coverage_${randomUUID().replaceAll("-", "")}`;
  let db: InjectedDatabase | undefined, created = false;
  t.after(async () => { try { await db?.close(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.close(); } });
  assert.equal(await admin.connect(), true);
  await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  url.searchParams.set("options", `-c search_path=${schema}`);
  db = new InjectedDatabase(url.toString()); assert.equal(await db.connect(), true);
  await db.runMigrations();
  const store = new PostgresClusterStore(db);
  await store.saveConversation({ id: "conv", title: "coverage", createdAt: 1, updatedAt: 1, messages: [] });
  await store.createGoalRun({ goalRunId: "goal", conversationId: "conv", userMessageId: "msg", rootGoal: "探查哪一个节点有知识库项目",
    status: "running", currentStage: "awaiting_verification", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null,
    reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  await store.saveNode({ nodeId: "worker", name: "worker", role: "worker", platform: "linux", arch: "x64", hostname: "fixture", tokenHash: "fixture", status: "online", lastSeenAt: 1, metadata: {}, createdAt: 1, updatedAt: 1 });
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: {} as any });
  const graph = await defaultTraceContext.run({ projectId: "c", sessionId: "conv", traceId: "t", goalRunId: "goal" }, () => orchestrator.createGraph({
    parentGoal: "探查哪一个节点有知识库项目", reasoning: "fixture", requiresMultiAgent: true,
    nodes: [{ nodeId: "probe", title: "probe", goal: "探查 worker", candidateNodeId: "worker", dependencies: [] }],
  }));
  const graphContext = { graphId: graph.graphId, graphNodeId: "probe", inputs: [], outputs: [] };
  await store.saveTaskWithGoal({ taskId: "task-probe", runId: "run-probe", nodeId: "worker", projectId: "p", goal: "探查", status: "completed",
    dispatchAttempt: 1, createdAt: 1, updatedAt: 2, completedAt: 2, dispatchOptions: { graphContext } }, "goal");
  await store.updateGraphNodeStatus(graph.graphId, "probe", "completed", { taskId: "task-probe", assignedNodeId: "worker" });
  await store.updateGraphStatus(graph.graphId, "completed");

  // A receipt bound to a different run cannot complete the goal.
  await store.recordGraphVerification({ graphId: graph.graphId, graphNodeId: "probe", verificationType: "simulated", status: "passed",
    evidence: { taskId: "task-probe", runId: "run-other", workerNodeId: "worker", executionSource: "authenticated_worker_runtime" } as any, verifiedAt: 3 });
  const partial = await processGoalRun(store, "goal");
  assert.equal(partial.status, "partially_completed");
  assert.equal(partial.reportEvidence?.coverageChecks?.[0]?.status, "completed_unverified");

  await store.recordGraphVerification({ graphId: graph.graphId, graphNodeId: "probe", verificationType: "simulated", status: "passed",
    evidence: { taskId: "task-probe", runId: "run-probe", workerNodeId: "worker", executionSource: "authenticated_worker_runtime" } as any, verifiedAt: 4 });
  const completed = await processGoalRun(store, "goal");
  assert.equal(completed.status, "completed");
  assert.equal(completed.reportEvidence?.coverage?.completion, "completed");

  // The verdict survives a fresh connection: it is persisted in the GoalRun payload, not in memory.
  const restored = (await new PostgresClusterStore(db).getGoalRun("goal"))!;
  assert.equal(restored.status, "completed");
  assert.equal(restored.coverageEvaluation?.completion, "completed");
  assert.deepEqual(restored.coverageEvaluation?.checks.map(check => [check.graphNodeId, check.status]), [["probe", "verified"]]);
  // Two revisions: the partial report written before the bound receipt existed, then the completed one.
  assert.equal(restored.reportHistory?.length, 2);
  assert.equal(restored.reportHistory?.at(-1)?.status, "completed");
  assert.equal(restored.reportHistory?.at(0)?.status, "partially_completed");
  assert.equal(restored.reportEvidence?.coverageChecks?.[0]?.runId, "run-probe");

  // A converged graph cannot be patched behind the completed verdict, and re-running the
  // processor must not churn the report.
  const patched = await store.applyGraphPatchAtomic({ graphId: graph.graphId, operationId: "replan", expectedRevision: 1, nextRevision: 2, reason: "recover", newGraphStatus: "running" });
  assert.equal(patched.success, false);
  const again = await processGoalRun(store, "goal");
  assert.equal(again.status, "completed");
  assert.equal(again.reportRevision, completed.reportRevision);
  assert.equal((await store.getGoalRun("goal"))?.coverageEvaluation?.completion, "completed");
});

test("REAL_DATABASE: a replan from another connection cannot erase a report owned by a live turn", { skip: !connection }, async t => {
  const url = new URL(connection!);
  assert.match(url.pathname, /(?:test|dev|runtime_truth)/);
  const admin = new ClusterDatabase(connection), schema = `nash_replan_${randomUUID().replaceAll("-", "")}`;
  let db: InjectedDatabase | undefined, db2: InjectedDatabase | undefined, created = false;
  t.after(async () => { try { await db2?.close(); await db?.close(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.close(); } });
  assert.equal(await admin.connect(), true);
  await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  url.searchParams.set("options", `-c search_path=${schema}`);
  db = new InjectedDatabase(url.toString()); db2 = new InjectedDatabase(url.toString());
  assert.equal(await db.connect(), true); assert.equal(await db2.connect(), true);
  await db.runMigrations();
  const store = new PostgresClusterStore(db), otherConnection = new PostgresClusterStore(db2);
  await store.saveConversation({ id: "conv", title: "replan", createdAt: 1, updatedAt: 1, messages: [] });
  await store.createGoalRun({ goalRunId: "goal", conversationId: "conv", userMessageId: "msg", rootGoal: "探查", status: "running",
    currentStage: "awaiting_verification", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null,
    reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1 });
  await store.saveNode({ nodeId: "worker", name: "worker", role: "worker", platform: "linux", arch: "x64", hostname: "fixture", tokenHash: "fixture", status: "online", lastSeenAt: 1, metadata: {}, createdAt: 1, updatedAt: 1 });
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: {} as any });
  const graph = await defaultTraceContext.run({ projectId: "c", sessionId: "conv", traceId: "t", goalRunId: "goal" }, () => orchestrator.createGraph({
    parentGoal: "探查", reasoning: "fixture", requiresMultiAgent: true,
    nodes: [{ nodeId: "probe", title: "probe", goal: "探查 worker", candidateNodeId: "worker", dependencies: [] }],
  }));

  // Deliver a report from a foreground turn that still holds the lease.
  const delivered = (await store.getGoalRun("goal"))!;
  const lease = { ownerId: "owner-x", turnId: "msg", generation: 2, expiresAt: Date.now() + 60_000 };
  assert.equal(await store.updateGoalRun({ ...delivered, status: "completed", currentStage: "report_ready", finalReport: "delivered report",
    reportState: "ready", reportFingerprint: "fp", reportRevision: 1, completedAt: 2, turnLease: lease, turnLeaseGeneration: 2,
    revision: delivered.revision + 1, updatedAt: 2 }, delivered.revision), true);

  // A concurrent background patch on a different connection must not clear it.
  const reopened = (await store.getGraph(graph.graphId))!.revision;
  const foreign = await otherConnection.applyGraphPatchAtomic({ graphId: graph.graphId, expectedRevision: reopened, nextRevision: reopened + 1, reason: "background replan" });
  assert.equal(foreign.success, true);
  const afterForeign = (await store.getGoalRun("goal"))!;
  assert.equal(afterForeign.status, "completed");
  assert.equal(afterForeign.reportState, "ready");
  assert.equal(afterForeign.finalReport, "delivered report");
  assert.equal(afterForeign.reportRevision, 1);
  assert.equal(afterForeign.coverageEvaluation, undefined);
  assert.deepEqual(afterForeign.coverageHistory?.map(coverage => coverage.graphRevision), [reopened, reopened + 1]);
  assert.ok(afterForeign.revision > delivered.revision + 1);

  // The owner's own replan may restart delivery state.
  const owned = await defaultTraceContext.run(
    { projectId: "c", sessionId: "conv", traceId: "t-owned", goalRunId: "goal", goalTurnFence: lease },
    () => store.applyGraphPatchAtomic({ graphId: graph.graphId, expectedRevision: reopened + 1, nextRevision: reopened + 2, reason: "owner replan" }),
  );
  assert.equal(owned.success, true);
  const restarted = (await store.getGoalRun("goal"))!;
  assert.equal(restarted.status, "running");
  assert.equal(restarted.finalReport, undefined);
  assert.equal(restarted.reportState, "pending");
});

test("REAL_DATABASE: upgrading a pre-GoalRun schema preserves an unclassified historical timeout", { skip: !connection }, async t => {
  const url = new URL(connection!); assert.match(url.pathname, /(?:test|dev|runtime_truth)/);
  const admin = new ClusterDatabase(connection), schema = `nash_upgrade_${randomUUID().replaceAll("-", "")}`;
  let db: ClusterDatabase | undefined, created = false;
  t.after(async () => { try { await db?.close(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.close(); } });
  assert.equal(await admin.connect(), true); await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  url.searchParams.set("options", `-c search_path=${schema}`);
  db = new ClusterDatabase(url.toString()); assert.equal(await db.connect(), true);
  await db.query("CREATE TABLE cluster_schema_migrations (version INT PRIMARY KEY,name VARCHAR(128) NOT NULL,applied_at BIGINT NOT NULL)");
  for (const migration of CLUSTER_MIGRATIONS.filter(item => item.version < 14)) {
    await db.query(migration.sql);
    await db.query("INSERT INTO cluster_schema_migrations VALUES ($1,$2,$3)", [migration.version, migration.name, Date.now()]);
  }
  const store = new PostgresClusterStore(db), now = Date.now();
  await store.saveGraph({ graphId: "graph-legacy", parentGoal: "historical", status: "running", revision: 1,
    budget: { maxNodes: 10, maxParallelTasks: 2, maxReplanAttempts: 1, maxDepth: 4, totalTimeoutMs: 1800000, perTaskTimeoutMs: 600000 },
    concurrencyPolicy: { maxConcurrentTasks: 2, projectWriteLock: true }, createdAt: now, updatedAt: now });
  await db.runMigrations(); await db.runMigrations();
  const legacy = (await store.getGraph("graph-legacy"))!;
  assert.equal(legacy.budget.perTaskTimeoutMs, 600000);
  assert.equal(legacy.budget.perTaskTimeoutSource, undefined);
  assert.equal(legacy.status, "running");
  assert.deepEqual(await store.listGoalRuns(), []);
});
