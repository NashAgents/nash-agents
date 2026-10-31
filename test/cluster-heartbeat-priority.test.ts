import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { InMemoryClusterStore, PostgresClusterStore } from "../src/cluster/storage/cluster-store.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import { WssGateway } from "../src/cluster/coordinator/wss-gateway.js";
import { createEnvelope } from "../src/cluster/protocol/message-codec.js";

test("SIMULATED_INTEGRATION: authenticated heartbeats bypass slow event storage without reordering business events or weakening identity", { timeout: 5000 }, async t => {
  const store = new InMemoryClusterStore();
  await store.saveTask({ taskId: "task", runId: "run", nodeId: "worker", projectId: "project", goal: "test", status: "running", dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now() });
  const invites = new InviteManager(), registry = new NodeRegistry(store, invites);
  const server = http.createServer(), gateway = new WssGateway({ server, store, registry, coordinatorNodeId: "coordinator" });
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const append = store.appendEvents.bind(store);
  let appendCalls = 0;
  t.mock.method(store, "appendEvents", async (events: Parameters<typeof append>[0]) => {
    appendCalls++;
    if (appendCalls === 1) { entered(); await hold; }
    return append(events);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/ws/cluster`);
  t.after(async () => { release(); ws.terminate(); gateway.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const messages: any[] = [];
  ws.on("message", raw => messages.push(JSON.parse(String(raw))));
  await once(ws, "open");
  const send = (type: any, payload: any) => ws.send(JSON.stringify(createEnvelope(type, payload, "worker", "coordinator")));
  const next = async (type: string) => {
    while (true) {
      const index = messages.findIndex(m => m.type === type);
      if (index >= 0) return messages.splice(index, 1)[0];
      await once(ws, "message", { signal: AbortSignal.timeout(1500) });
    }
  };
  send("node.hello", { nodeId: "worker", name: "test", platform: "linux", arch: "x64", hostname: "test", capabilities: [], projects: [], maxConcurrentRuns: 1, inviteCode: invites.createInvite().inviteCode });
  const generation = (await next("node.authenticated")).payload.connectionGeneration;
  const event = (seq: number) => ({ taskId: "task", runId: "run", nodeId: "worker", seq, eventType: "test.evidence", data: { seq }, timestamp: Date.now() });
  send("event.batch", { taskId: "task", runId: "run", nodeId: "worker", events: [event(1)] });
  await blocked;
  send("event.batch", { taskId: "task", runId: "run", nodeId: "worker", events: [event(2)] });
  const connection = registry.getConnection("worker")!;
  connection.lastHeartbeatAt = Date.now() - 60000;
  send("node.heartbeat", { nodeId: "worker", generation, timestamp: Date.now(), activeTasksCount: 1 });
  await next("node.heartbeat_ack");
  assert.ok(Date.now() - connection.lastHeartbeatAt < 1000);
  assert.equal(appendCalls, 1);
  assert.equal((await store.getEventsForTask("task")).length, 0);
  assert.equal(messages.some(m => m.type === "event.ack"), false);
  send("node.heartbeat", { nodeId: "other", generation, timestamp: Date.now() });
  assert.equal((await next("error")).payload.code, "NODE_MISMATCH");
  send("node.heartbeat", { nodeId: "worker", generation: generation - 1, timestamp: Date.now() });
  assert.equal((await next("error")).payload.code, "STALE_GENERATION");
  release();
  await next("event.ack"); await next("event.ack");
  assert.deepEqual((await store.getEventsForTask("task")).map(e => e.seq), [1, 2]);
});

test("MOCK_UNIT: PostgreSQL event ingestion uses bounded batches, retains first duplicate payload and preserves inserted counts", async () => {
  const calls: any[] = [];
  const store = new PostgresClusterStore({ query: async (_sql: string, args: any[]) => {
    const rows = JSON.parse(args[0]); calls.push(rows); return { rowCount: rows.length };
  } } as any);
  const events = Array.from({ length: 450 }, (_, seq) => ({ taskId: "task", runId: "run", nodeId: "worker", seq: seq + 1, eventType: "test", data: { seq }, timestamp: 1 }));
  events.splice(1, 0, { ...events[0]!, data: { seq: -1 } });
  assert.equal(await store.appendEvents(events), 450);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0][0].payload, { seq: 0 });
  assert.equal(calls.flat().length, 450);
  assert.equal(await store.appendEvents([]), 0);
  assert.equal(calls.length, 3);
});
