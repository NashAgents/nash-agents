// 手动撤销任务级全访问授权（#22）：
// 管理员通过 HTTP 撤销后，Coordinator 必须用 Worker 的真实 ACK 作为撤销依据；
// Worker 不可达或未确认时必须返回 409（fail-closed），并保留可对账的 revocation_pending 状态。
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { ClusterApiHandler } from "../src/cluster/coordinator/api-server.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { TASK_FULL_ACCESS_POLICY } from "../src/cluster/coordinator/task-security-grant-service.js";
import type { TaskSecurityGrant } from "../src/cluster/storage/cluster-store-types.js";

function grant(overrides: Partial<TaskSecurityGrant> = {}): TaskSecurityGrant {
  return {
    grantId: "grant-1", approvalId: "appr-1", nodeId: "worker-1", taskId: "task-1", runId: "run-1",
    authorizationMode: "task-full-access",
    originalPolicy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, approval: { mode: "ask" } },
    targetPolicy: TASK_FULL_ACCESS_POLICY,
    authorizedBy: "admin", grantedAt: 1, effectiveAt: 1, workerAckAt: 1,
    appliesTo: "subsequent-tool-calls", status: "applied", configurationVersion: 1,
    ...overrides,
  };
}

async function fixture(t: TestContext, options: { nodeOnline?: boolean; ack?: boolean } = {}) {
  const store = new InMemoryClusterStore();
  const nodeOnline = options.nodeOnline ?? true;
  const registry = {
    getConnection: (nodeId: string) => nodeOnline && nodeId === "worker-1" ? { nodeId, generation: 1, ws: { readyState: 1 } } : undefined,
    listOnlineConnections: () => [],
  } as any;
  const scheduler = {
    // 只有真实 Worker ACK 才算撤销成功；这里用返回值模拟两种结论。
    revokeTaskSecurity: async () => options.ack === false
      ? { success: false, message: "Worker security revocation acknowledgement timed out" }
      : { success: true },
  } as any;
  const handler = new ClusterApiHandler({ store, registry, scheduler, inviteManager: {} as any, coordinatorNodeId: "test", adminApiKey: "test-key" });
  const server = http.createServer((req, res) => { void handler.handleRequest(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => {
    handler.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await store.saveTask({ taskId: "task-1", runId: "run-1", nodeId: "worker-1", projectId: "p", goal: "g", prompt: "p", status: "waiting_approval", dispatchAttempt: 1, createdAt: 1, updatedAt: 1 });
  return {
    store, handler, url,
    post: (path: string, body: unknown = {}) => fetch(url + path, {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }),
  };
}

test("admin revocation of an acknowledged grant is confirmed and audited", async (t) => {
  const { store, url, post } = await fixture(t);
  await store.saveTaskSecurityGrant?.(grant());

  const response = await post("/api/cluster/tasks/task-1/revoke-grant", { reason: "incident response" });
  const body = await response.json() as any;
  assert.equal(response.status, 200);
  assert.equal(body.confirmed, true);
  assert.equal(body.status, "revoked");
  assert.equal(body.grantId, "grant-1");
  assert.equal(body.revokedBy, "admin");

  assert.equal((await store.getTaskSecurityGrant?.("grant-1"))?.status, "revoked");
  assert.equal((await store.getTaskSecurityGrant?.("grant-1"))?.revokedBy, "admin");
  assert.equal(await store.getActiveTaskSecurityGrant?.("task-1", "run-1"), null, "撤销后必须立即不再作为授权依据");

  const audits = (await store.listSecurityAudits?.({ taskId: "task-1" }))?.items ?? [];
  assert.ok(audits.some((row) => row.toolName === "system.revoke_security"), "撤销必须留下安全审计记录");
});

test("revocation is refused when the worker does not confirm (fail-closed)", async (t) => {
  const { store, url, post } = await fixture(t, { ack: false });
  await store.saveTaskSecurityGrant?.(grant());

  const response = await post("/api/cluster/tasks/task-1/revoke-grant", {});
  const body = await response.json() as any;
  assert.equal(response.status, 409, "未确认的撤销不得返回成功");
  assert.equal(body.confirmed, false);
  assert.equal(body.code, "REVOCATION_PENDING");
  assert.equal((await store.getTaskSecurityGrant?.("grant-1"))?.status, "revocation_pending");
  assert.equal((await store.getTaskSecurityGrant?.("grant-1"))?.reconciliationRequired, true);
});

test("revocation is refused when the node is offline and the grant was applied", async (t) => {
  const { store, url, post } = await fixture(t, { nodeOnline: false });
  await store.saveTaskSecurityGrant?.(grant());

  const response = await post("/api/cluster/tasks/task-1/revoke-grant", {});
  const body = await response.json() as any;
  assert.equal(response.status, 409);
  assert.equal(body.confirmed, false);
  assert.equal((await store.getTaskSecurityGrant?.("grant-1"))?.status, "revocation_pending");
});

test("an unacknowledged grant on an offline node can be revoked truthfully", async (t) => {
  const { store, url, post } = await fixture(t, { nodeOnline: false });
  await store.saveTaskSecurityGrant?.(grant({ status: "granted", effectiveAt: undefined, workerAckAt: undefined }));

  const response = await post("/api/cluster/tasks/task-1/revoke-grant", {});
  const body = await response.json() as any;
  assert.equal(response.status, 200);
  assert.equal(body.confirmed, true, "从未 ACK 的授权在节点离线时永远不会生效，可以确认撤销");
  assert.equal((await store.getTaskSecurityGrant?.("grant-1"))?.status, "revoked");
});

test("revocation requires an existing active grant and rejects a foreign grantId", async (t) => {
  const { store, url, post } = await fixture(t);

  const missing = await post("/api/cluster/tasks/task-1/revoke-grant", {});
  assert.equal(missing.status, 404);

  await store.saveTaskSecurityGrant?.(grant({ grantId: "grant-other", taskId: "task-2" }));
  const foreign = await post("/api/cluster/tasks/task-1/revoke-grant", { grantId: "grant-other" });
  assert.equal(foreign.status, 404, "显式 grantId 也必须属于当前任务");
  assert.equal((await store.getTaskSecurityGrant?.("grant-other"))?.status, "applied");
});

test("non-admin callers cannot revoke a task grant", async (t) => {
  const { handler, store } = await fixture(t);
  await store.saveTaskSecurityGrant?.(grant());
  const api = handler as any;
  const original = api.authenticateRequest;
  api.authenticateRequest = async () => ({ authenticated: true, user: { username: "operator", role: "operator" } });
  t.after(() => { api.authenticateRequest = original; });

  const req: any = Object.assign(
    new (await import("node:stream")).Readable({ read() { this.push(null); } }),
    { method: "POST", headers: {} },
  );
  await assert.rejects(() => api.handleRevokeTaskGrant("task-1", req, {} as any), /仅管理员/);
  assert.equal((await store.getTaskSecurityGrant?.("grant-1"))?.status, "applied");
});
