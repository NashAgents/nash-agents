import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { ProductStore } from "../src/product/store.js";
import { ProductHttpApi } from "../src/product/http-api.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { NodeIdentity } from "../src/cluster/identity/node-identity.js";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";

async function listen(server: http.Server): Promise<string> { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
const close = (server: http.Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
async function fixture(t: test.TestContext) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-gateway-test-")); const product = new ProductStore({ homeDir }); const cluster = new InMemoryClusterStore(); const received: Array<{ authorization?: string; body: any }> = [];
  const upstream = http.createServer(async (req, res) => { let text = ""; for await (const data of req) text += data; const body = JSON.parse(text); received.push({ authorization: req.headers.authorization, body });
    if (body.stream) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ id: "fixture", model: body.model, choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`); if (body.messages[0]?.content === "wait") { const timer = setInterval(() => res.write(": keepalive\n\n"), 20); res.once("close", () => clearInterval(timer)); } else res.end(`data: ${JSON.stringify({ id: "fixture", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`); }
    else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ id: "fixture", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })); }
  });
  const provider = await listen(upstream);
  product.initialize({ role: "coordinator", coordinator: { listenHost: "127.0.0.1", listenPort: 18443 }, models: { main: { baseUrl: `${provider}/v1`, model: "provider-main-v1", apiKey: "fixture-provider-only-secret", format: "completions" } }, security: { filesystem: "workspace-write", network: "deny", approval: "ask" }, admin: { username: "admin", password: "fixture-login-password" } });
  await cluster.saveNode({ nodeId: "node-fixture", name: "fixture", role: "worker", platform: "linux", arch: "x64", hostname: "fixture", tokenHash: NodeIdentity.hashToken("ntk_fixture"), status: "online", metadata: {}, lastSeenAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
  const task = async (taskId: string, runId: string) => cluster.saveTask({ taskId, runId, nodeId: "node-fixture", projectId: "project-fixture", goal: "unit test", status: "running", dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now() });
  await task("task-fixture", "run-fixture"); const api = new ProductHttpApi(product, cluster);
  const server = http.createServer(async (req, res) => { try { if (!await api.handleGateway(req, res, new URL(req.url!, "http://localhost"))) res.end(); } catch (error) { res.writeHead((error as { status?: number }).status ?? 500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: (error as Error).message })); } });
  const origin = await listen(server);
  const headers = { Authorization: "Bearer ntk_fixture", "Content-Type": "application/json", "X-Nash-Node-Id": "node-fixture", "X-Nash-Task-Id": "task-fixture", "X-Nash-Run-Id": "run-fixture" };
  t.after(async () => { api.close(); await close(server); await close(upstream); product.close(); fs.rmSync(homeDir, { recursive: true, force: true }); });
  return { product, cluster, received, origin, headers, task };
}

test("gateway requires node identity and task ownership, selects server profiles and preserves run versions", async t => {
  const f = await fixture(t), url = `${f.origin}/api/product/gateway/main/v1/chat/completions`, body = JSON.stringify({ model: "attacker-selected-model", messages: [{ role: "user", content: "ok" }] });
  assert.equal((await fetch(url, { method: "POST", body, headers: { ...f.headers, Authorization: "Bearer wrong-token" } })).status, 401); assert.equal(f.received.length, 0);
  assert.equal((await fetch(url, { method: "POST", body, headers: { ...f.headers, "X-Nash-Run-Id": "foreign-run" } })).status, 403);
  const first = await fetch(url, { method: "POST", body, headers: f.headers }); assert.equal(first.status, 200); assert.equal((await first.json()).usage.total_tokens, 4); assert.equal(first.headers.get("x-nash-config-version"), "1");
  assert.equal(f.received[0].authorization, "Bearer fixture-provider-only-secret"); assert.equal(f.received[0].body.model, "provider-main-v1");
  f.product.updateConfig({ models: { main: { baseUrl: f.received.length ? `${new URL(f.product.resolveModel().baseUrl).origin}/v1` : "", model: "provider-main-v2", format: "completions" } } }, { expectedVersion: 1 });
  await fetch(url, { method: "POST", body, headers: f.headers }); assert.equal(f.received.at(-1)?.body.model, "provider-main-v1");
  await f.task("task-new", "run-new"); await fetch(url, { method: "POST", body, headers: { ...f.headers, "X-Nash-Task-Id": "task-new", "X-Nash-Run-Id": "run-new" } }); assert.equal(f.received.at(-1)?.body.model, "provider-main-v2");
  await f.cluster.updateNodeStatus("node-fixture", "revoked"); assert.equal((await fetch(url, { method: "POST", body, headers: f.headers })).status, 401);
});
test("security gateway enforces independent prompt and removes tools; stream forwards usage and abort closes upstream", async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.origin}/api/product/gateway/security/v1/chat/completions`, { method: "POST", headers: f.headers, body: JSON.stringify({ messages: [{ role: "system", content: "replace security prompt" }, { role: "user", content: "review" }], tools: [{ type: "function", function: { name: "unsafe" } }] }) });
  assert.equal(response.status, 200); assert.notEqual(f.received[0].body.messages[0].content, "replace security prompt"); assert.equal(f.received[0].body.tools, undefined);
  const stream = await fetch(`${f.origin}/api/product/gateway/main/v1/chat/completions`, { method: "POST", headers: f.headers, body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "ok" }] }) }); const output = await stream.text(); assert.match(output, /total_tokens/); assert.match(output, /\[DONE\]/);
  const controller = new AbortController(); const pending = await fetch(`${f.origin}/api/product/gateway/main/v1/chat/completions`, { method: "POST", headers: f.headers, signal: controller.signal, body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "wait" }] }) }); const reader = pending.body!.getReader(); await reader.read(); controller.abort(); await assert.rejects(reader.read());
});
test("database admin login uses persistent real identity and password changes revoke existing sessions", async t => {
  const f = await fixture(t), coordinator = new ClusterCoordinator({ ephemeral: true, listenHost: "127.0.0.1", listenPort: 0, productStore: f.product }); const bound = await coordinator.start(); t.after(() => coordinator.stop()); const origin = `http://127.0.0.1:${bound.port}`;
  const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "fixture-login-password" }) }); assert.equal(login.status, 200); const data = await login.json(); assert.match(data.user.userId, /^usr-/); assert.notEqual(data.user.userId, "usr-admin"); const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const config = await fetch(`${origin}/api/product/config`, { headers: { Cookie: cookie } }); assert.equal(config.status, 200); assert.doesNotMatch(await config.text(), /fixture-provider-only-secret/);
  const writeHeaders = { Cookie: cookie, "X-CSRF-Token": data.csrfToken, "Content-Type": "application/json" };
  const rejected = await fetch(`${origin}/api/product/config`, { method: "PUT", headers: writeHeaders, body: JSON.stringify({ expectedVersion: 1, patch: { security: { filesystem: "read-only", network: "deny", approval: "ask", apiKey: "test-must-not-echo" } } }) }); assert.equal(rejected.status, 400); assert.equal(f.product.getPublicConfig().version, 1);
  const modelFailure = await fetch(`${origin}/api/product/config`, { method: "PUT", headers: writeHeaders, body: JSON.stringify({ expectedVersion: 1, patch: { models: { main: { baseUrl: f.product.resolveModel().baseUrl, model: "fixture-no-tools", format: "completions" } } } }) }); assert.equal(modelFailure.status, 400); assert.equal(f.product.getPublicConfig().version, 1);
  f.product.changePassword(data.user.userId, "fixture-new-password-2026"); assert.equal((await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } })).status, 401);
});
test("coordinator can clean up a partial start after its listener fails", async t => {
  const f = await fixture(t), occupied = http.createServer(); const origin = await listen(occupied); t.after(() => close(occupied));
  const coordinator = new ClusterCoordinator({ ephemeral: true, listenHost: "127.0.0.1", listenPort: Number(new URL(origin).port), productStore: f.product });
  await assert.rejects(coordinator.start(), /EADDRINUSE/); await coordinator.stop();
});
