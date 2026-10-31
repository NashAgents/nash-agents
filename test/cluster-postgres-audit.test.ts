import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ClusterDatabase } from "../src/cluster/storage/db.js";
import { PostgresClusterStore, type ScheduledTaskRecord, type ScheduledTaskRunRecord } from "../src/cluster/storage/cluster-store.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import type { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";

const connection = process.env.NASH_TEST_DATABASE_URL;
async function fixture(t: TestContext) {
  const admin = new ClusterDatabase(connection), schema = `nash_audit_${randomUUID().replaceAll('-', '')}`;
  const connections: ClusterDatabase[] = []; let created = false;
  t.after(async () => {
    try { for (const db of connections) await db.close(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.close(); }
  });
  assert.equal(await admin.connect(), true);
  await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  const url = new URL(connection!); url.searchParams.set('options', `-c search_path=${schema}`);
  const connect = async () => { const db = new ClusterDatabase(url.toString()); connections.push(db); assert.equal(await db.connect(), true); return db; };
  const db = await connect(); await db.runMigrations();
  return { db, connect, store: new PostgresClusterStore(db) };
}

test("REAL_DATABASE F03: concurrent first registrations cannot replace a node token or revocation", { skip: !connection }, async t => {
  const { store, connect } = await fixture(t), other = new PostgresClusterStore(await connect()), now = Date.now();
  const candidate = (tokenHash: string) => ({ nodeId: "paired-node", name: "fixture", role: "worker" as const, platform: "linux", arch: "x64", hostname: "fixture", tokenHash, status: "online" as const, lastSeenAt: now, metadata: {}, createdAt: now, updatedAt: now });
  const admitted = await Promise.all([store.createNodeIfAbsent(candidate("a")), other.createNodeIfAbsent(candidate("b"))]);
  assert.equal(admitted.filter(Boolean).length, 1);
  const winner = (await store.getNode("paired-node"))!;
  await store.saveNode({ ...winner, status: "revoked" });
  assert.equal(await other.createNodeIfAbsent(candidate("replacement")), false);
  assert.equal((await other.getNode("paired-node"))!.tokenHash, winner.tokenHash);
  assert.equal((await other.getNode("paired-node"))!.status, "revoked");
  assert.equal(await other.updateNodeConnection(winner), false);
  await store.saveNode({ ...winner, status: "offline" });
  await Promise.all([other.updateNodeConnection(winner), store.updateNodeStatus("paired-node", "revoked")]);
  assert.equal((await store.getNode("paired-node"))!.status, "revoked");
});

test("REAL_DATABASE: initial graph creation rolls every table back after a node insert fails", { skip: !connection }, async t => {
  const { db, store } = await fixture(t);
  await db.query(`CREATE FUNCTION reject_fixture_node() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.node_id='B' THEN RAISE EXCEPTION 'fixture node failure'; END IF; RETURN NEW; END $$`);
  await db.query("CREATE TRIGGER reject_fixture_node BEFORE INSERT ON cluster_graph_nodes FOR EACH ROW EXECUTE FUNCTION reject_fixture_node()");
  const graph = new DistributedGraphOrchestrator({ store, scheduler: {} as TaskScheduler });
  await assert.rejects(graph.createGraph({ parentGoal: "fixture", reasoning: "audit regression", requiresMultiAgent: true, nodes: [
    { nodeId: "A", title: "A", goal: "A", dependencies: [] }, { nodeId: "B", title: "B", goal: "B", dependencies: ["A"] },
  ] }), /fixture node failure/);
  for (const table of ['cluster_graphs','cluster_graph_nodes','cluster_graph_edges','cluster_graph_revisions','cluster_graph_events']) {
    assert.equal(Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count), 0, table);
  }
});

test("REAL_DATABASE: schedule row locking admits once across connections and persists execution identity", { skip: !connection }, async t => {
  const { db, connect, store } = await fixture(t), other = new PostgresClusterStore(await connect()), now = Date.now();
  const plan: ScheduledTaskRecord = { id: 's', name: 'fixture', description: '', enabled: true, triggerType: 'interval', intervalMs: 1000, targetType: 'single_task', concurrencyPolicy: 'SKIP_IF_RUNNING', misfirePolicy: 'RUN_ONCE_IMMEDIATELY', maxConcurrency: 1, runCount: 0, createdBy: 'test', createdAt: now, updatedAt: now };
  await store.saveScheduledTask(plan);
  const candidate = (id: string): ScheduledTaskRunRecord => ({ id, scheduledTaskId: 's', targetType: 'single_task', triggerTime: now, startedAt: now, status: 'running', createdAt: now });
  const results = await Promise.all([store.claimScheduledTaskRun(candidate('a')), other.claimScheduledTaskRun(candidate('b'))]);
  assert.equal(results.filter(r => r.admitted).length, 1);
  const run = results.find(r => r.admitted)!.run;
  await store.saveNode({ nodeId: 'fixture', name: 'fixture', role: 'worker', platform: 'linux', arch: 'x64', hostname: 'fixture', tokenHash: 'fixture', metadata: {}, status: 'online', lastSeenAt: now, createdAt: now, updatedAt: now });
  await store.saveTask({ taskId: 'task', nodeId: 'fixture', projectId: 'p', goal: 'fixture', status: 'created', dispatchAttempt: 1, createdAt: now, updatedAt: now });
  await store.updateScheduledTaskRun(run.id, { taskId: 'task' });
  assert.equal((await other.getScheduledTaskRun(run.id))?.taskId, 'task');
  await store.updateScheduledTaskRun(run.id, { status: 'outcome_unknown' });
  assert.equal((await other.claimScheduledTaskRun(candidate('forced'), true)).admitted, false);
  assert.equal((await db.query("SELECT count(*) FROM cluster_scheduled_task_runs WHERE status IN ('running','outcome_unknown')")).rows[0].count, '1');
});

test("REAL_DATABASE: concurrent message append and title snapshots preserve all conversation fields",{skip:!connection},async t=>{
  const {store,connect}=await fixture(t),other=new PostgresClusterStore(await connect());
  await store.saveConversation({id:"chat",title:"old",titleRevision:0,titleSource:"default",createdAt:1,updatedAt:1,messages:[]});
  const title=(await store.getConversation("chat"))!,message=(await other.getConversation("chat"))!;
  title.title="new";title.titleSource="ai_generated";title.titleRevision=1;
  message.messages.push({id:"a",conversationId:"chat",sender:"user",content:"a",messageType:"text",timestamp:2});
  await Promise.all([store.saveConversation(title),other.saveConversation(message),store.appendConversationMessage("chat",{id:"b",conversationId:"chat",sender:"assistant",content:"b",messageType:"text",timestamp:3})]);
  const saved=(await other.getConversation("chat"))!;
  assert.equal(saved.title,"new");assert.deepEqual(saved.messages.map(item=>item.id).sort(),["a","b"]);
  await other.appendConversationMessage("chat",{id:"b",conversationId:"chat",sender:"assistant",content:"b",messageType:"text",timestamp:3});
  assert.equal((await store.getConversation("chat"))!.messages.length,2);
});
