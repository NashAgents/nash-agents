import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { CoordinatorClient, WorkerConnectionError, type ConnectionStatus } from "../src/cluster/worker/coordinator-client.js";
import { NodeIdentity } from "../src/cluster/identity/node-identity.js";
import { ProjectRegistry } from "../src/cluster/worker/project-registry.js";
import { createEnvelope, encodeEnvelope } from "../src/cluster/protocol/message-codec.js";
import { ProductStore } from "../src/product/index.js";

async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "condition timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function fixture(t: TestContext, url: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-cold-start-"));
  const identity = new NodeIdentity({ customDir: home });
  const registry = new ProjectRegistry({ customDir: home });
  const states: ConnectionStatus[] = [];
  const client = new CoordinatorClient({ coordinatorUrl: url, identity, projectRegistry: registry,
    retryBaseMs: 20, retryMaxMs: 40, connectTimeoutMs: 150, onConnectionState: status => states.push(status) });
  t.after(() => { client.disconnect(); fs.rmSync(home, { recursive: true, force: true }); });
  return { client, identity, registry, states };
}

test("cold start survives refusal, authenticates once service returns and preserves identity across reconnect", async t => {
  const reserve = net.createServer();
  await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const { client, identity, registry, states } = fixture(t, `ws://127.0.0.1:${port}`);
  const initialId = identity.nodeId;
  const initialProjects = registry.listProjects();
  const connection = client.connect();
  assert.equal(client.connect(), connection, "concurrent callers share a single lifecycle");
  await waitFor(() => states.some(s => s.state === "RETRY_WAIT"));
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const hellos: string[] = [];
  server.on("connection", ws => ws.on("message", raw => {
    const envelope = JSON.parse(raw.toString());
    if (envelope.type !== "node.hello") return;
    hellos.push(envelope.payload.nodeId);
    ws.send(encodeEnvelope(createEnvelope("node.authenticated", { assignedNodeId: initialId, connectionGeneration: hellos.length, nodeToken: "test-token", heartbeatIntervalMs: 100 }, "coordinator", initialId)));
  }));
  await connection;
  assert.equal(client.connected, true);
  for (const ws of server.clients) ws.close(1012, "test service restart");
  await waitFor(() => hellos.length === 2 && client.connected);
  assert.deepEqual(hellos, [initialId, initialId]);
  assert.deepEqual(registry.listProjects(), initialProjects);
  assert.equal(client.generation, 2);
  assert.ok(states.filter(s => s.retryAt).every(s => s.retryAt! - Date.now() <= 40));
  client.disconnect();
});

test("disconnect aborts cold-start wait and cancels all scheduled reconnects", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const { client, states } = fixture(t, `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
  const connection = client.connect();
  const rejected = assert.rejects(connection, { name: "AbortError" });
  await waitFor(() => server.clients.size === 1);
  client.disconnect();
  await rejected;
  const count = states.length;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(states.length, count);
  assert.equal(client.connectionStatus.state, "STOPPED");
});

for (const mode of ["rejected", "protocol", "identity", "superseded"] as const) {
  test(`permanent ${mode} failure stops retries and does not leak server payload`, async t => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>(resolve => server.once("listening", resolve));
    t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const { client, identity, states } = fixture(t, `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
    let count = 0;
    server.on("connection", ws => { count++; ws.once("message", () => {
      if (mode === "superseded") { ws.close(4001, "secret-server-detail"); return; }
      const message = createEnvelope(mode === "rejected" ? "node.rejected" : "node.authenticated", mode === "rejected" ? { reason: "secret-server-detail" } : { assignedNodeId: mode === "identity" ? "wrong-id" : identity.nodeId, connectionGeneration: 1 }, "coordinator", identity.nodeId);
      ws.send(JSON.stringify(mode === "protocol" ? { ...message, protocolVersion: "unsupported" } : message));
    }); });
    await assert.rejects(client.connect(), error => error instanceof WorkerConnectionError && error.exitCode === 78 && !error.message.includes("secret-server-detail"));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(count, 1);
    assert.equal(states.at(-1)?.state, "BLOCKED");
  });
}

test("HTTP authentication denial is permanent while a temporary gateway failure recovers", async t => {
  let status = 503;
  const server = http.createServer((_req, res) => { res.writeHead(status); res.end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const { client, states } = fixture(t, `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
  const connection = client.connect();
  const rejected = assert.rejects(connection, (error: unknown) => error instanceof WorkerConnectionError && error.code === "HTTP_401");
  await waitFor(() => states.some(s => s.errorCode === "HTTP_RETRY"));
  status = 401;
  await rejected;
  assert.equal(client.connectionStatus.state, "BLOCKED");
});

test("invalid configuration fails permanently before opening any socket", async t => {
  const { client } = fixture(t, "https://user:secret@invalid");
  await assert.rejects(client.connect(), (error: unknown) => error instanceof WorkerConnectionError && error.code === "INVALID_COORDINATOR_URL");
});

test("product worker exits nonzero when a connected Coordinator later rejects its identity", { timeout: 30000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-worker-fatal-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const port = (server.address() as net.AddressInfo).port;
  const store = new ProductStore({ homeDir: home });
  try {
    store.initialize({ role: "worker", coordinator: { listenHost: "127.0.0.1", listenPort: 18443 },
      worker: { coordinatorUrl: `ws://127.0.0.1:${port}/ws/cluster`, inheritModels: true },
      models: {}, security: { filesystem: "workspace-write", network: "deny", approval: "ask" } });
  } finally { store.close(); }
  let nodeId = "";
  let connection: import("ws").WebSocket | undefined;
  server.on("connection", ws => { connection = ws; ws.once("message", raw => {
    const hello = JSON.parse(raw.toString()); nodeId = hello.payload.nodeId;
    ws.send(encodeEnvelope(createEnvelope("node.authenticated", { assignedNodeId: nodeId, connectionGeneration: 1, nodeToken: "fixture-token", heartbeatIntervalMs: 100 }, "coordinator", nodeId)));
  }); });
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "start", "--service"],
    { cwd: process.cwd(), env: { ...process.env, NASH_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => { stdout += String(chunk); });
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  exited = new Promise(resolve => child!.once("exit", (code, signal) => resolve({ code, signal })));
  // The full TSX-loaded product process took over seven seconds to cold-start
  // on the Windows fixture; this bound is for startup, not the failure verdict.
  try { await waitFor(() => stdout.includes("Nash Agents 已启动") || child!.exitCode !== null || child!.signalCode !== null, 20000); }
  catch { throw new Error(`fixture worker readiness timed out; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)} connected=${Boolean(connection)}`); }
  assert.ok(stdout.includes("Nash Agents 已启动"), `fixture worker did not start: ${stderr}`);
  connection!.send(encodeEnvelope(createEnvelope("node.rejected", { reason: "fixture rejection" }, "coordinator", nodeId)));
  const result = await exited;
  assert.deepEqual(result, { code: 78, signal: null });
});
