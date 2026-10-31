import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProductStore, ProductConfigError, type ProductInitInput } from "../src/product/index.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import { workerModels } from "../src/product/worker-models.js";
import { NodeIdentity } from "../src/cluster/identity/node-identity.js";
import { withProductModels, currentModelContext } from "../src/product/runtime.js";
import { ProductHttpApi } from "../src/product/http-api.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { Readable } from "node:stream";

const initial = (): ProductInitInput => ({ role: "coordinator-worker", coordinator: { listenHost: "127.0.0.1", listenPort: 18443 }, models: { main: { baseUrl: "https://provider.invalid/v1", model: "main-v1", apiKey: "fixture-model-secret-never-persist-plain", format: "responses" } }, security: { filesystem: "workspace-write", network: "deny", approval: "ask" }, admin: { username: "admin", password: "fixture-password-2026" } });
function fixture(t: test.TestContext) { const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-product-test-")); let store = new ProductStore({ homeDir }); t.after(() => { try { store.close(); } catch {} fs.rmSync(homeDir, { recursive: true, force: true }); }); return { homeDir, get store() { return store; }, reopen() { store.close(); store = new ProductStore({ homeDir }); return store; } }; }

test("product database persists real users and encrypted secrets without public key disclosure", t => {
  const f = fixture(t), config = f.store.initialize(initial());
  assert.equal(config.version, 1); assert.equal(config.models.main?.apiKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(config), /fixture-model-secret|fixture-password/);
  const user = f.store.authenticate("admin", "fixture-password-2026"); assert.ok(user); assert.notEqual(user.userId, "usr-admin");
  assert.equal(f.store.authenticate("admin", "wrong-password"), undefined);
  assert.equal(f.reopen().authenticate("admin", "fixture-password-2026")?.userId, user.userId);
  assert.equal(f.store.resolveModel({ purpose: "main" }).apiKey, initial().models.main?.apiKey);
  const db = fs.readFileSync(path.join(f.homeDir, "product.db")); assert.ok(!db.includes(Buffer.from("fixture-model-secret"))); assert.ok(!db.includes(Buffer.from("fixture-password")));
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(f.homeDir, "master.key")).mode & 0o777, 0o600);
});
test("failed initialization rolls back users, configuration and secrets and can be rerun", t => {
  const f = fixture(t), input = initial(); input.admin!.password = "short";
  assert.throws(() => f.store.initialize(input), ProductConfigError); assert.equal(f.store.isInitialized(), false); assert.deepEqual(f.store.listUsers(), []);
  assert.equal(f.store.initialize(initial()).version, 1);
  assert.throws(() => f.store.initialize(initial()), /已存在/);
});
test("initialization preflight and runtime patch validation cannot persist or echo unknown secret fields", t => {
  const f = fixture(t), input = initial(); f.store.validateInitialization(input); assert.equal(f.store.isInitialized(), false); assert.deepEqual(f.store.listUsers(), []);
  f.store.initialize(input);
  assert.throws(() => f.store.updateConfig({ security: { ...input.security, apiKey: "test-must-never-echo" } } as never, { expectedVersion: 1 }), /不支持/);
  assert.throws(() => f.store.updateConfig({ worker: { coordinatorUrl: "ws://localhost:18443", name: { apiKey: "test-must-never-echo" } } } as never, { expectedVersion: 1 }), /字段格式/);
  assert.throws(() => f.store.updateConfig({ models: { main: { ...input.models.main!, streaming: { apiKey: "test-must-never-echo" } } } } as never, { expectedVersion: 1 }), /格式无效/);
  assert.equal(f.store.getPublicConfig().version, 1); assert.doesNotMatch(JSON.stringify(f.store.getPublicConfig()), /test-must-never-echo/);
});
test("security follows main dynamically while active run snapshots and rollbacks remain deterministic", t => {
  const f = fixture(t); f.store.initialize(initial());
  const frozenVersion = f.store.bindRunConfiguration("run-1", "node-1", "task-1");
  const update = { ...initial().models.main!, model: "main-v2", format: "messages" as const, apiKey: undefined };
  f.store.updateConfig({ models: { main: update } }, { expectedVersion: 1 });
  assert.equal(f.store.resolveModel({ purpose: "security" }).model, "main-v2"); assert.equal(f.store.resolveModel({ purpose: "security" }).format, "messages");
  assert.equal(f.store.resolveModel({ purpose: "main", version: frozenVersion }).model, "main-v1"); assert.equal(f.store.bindRunConfiguration("run-1", "node-1", "task-1"), 1);
  assert.throws(() => f.store.bindRunConfiguration("run-1", "node-2", "task-1"));
  assert.throws(() => f.store.updateConfig({}, { expectedVersion: 1 }), /其他操作/);
  assert.equal(f.store.rollback(1, 2).version, 3); assert.equal(f.store.resolveModel({ purpose: "main" }).model, "main-v1");
});
test("historical configuration payload version follows its durable row identity", t => {
  const f = fixture(t); f.store.initialize(initial());
  f.store.updateConfig({ models: { main: { ...initial().models.main!, model: "main-v2" } } }, { expectedVersion: 1 });
  f.store.rollback(1, 2);
  const db = (f.store as any).db;
  const row = db.prepare("SELECT value FROM product_configs WHERE version=3").get() as { value: string };
  const stale = JSON.parse(row.value); stale.version = 2;
  db.prepare("UPDATE product_configs SET value=? WHERE version=3").run(JSON.stringify(stale));
  assert.equal(f.reopen().getPublicConfig().version, 3);
  assert.throws(() => f.store.updateConfig({}, { expectedVersion: 2 }), /其他操作/);
  assert.equal(f.store.updateConfig({}, { expectedVersion: 3 }).version, 4);
  assert.equal(f.store.resolveModel({ purpose: "main", version: 3 }).model, "main-v1");
  assert.deepEqual(f.store.listVersions().map(v => v.version), [4, 3, 2, 1]);
});
test("danger full access requires explicit confirmation and invalid updates preserve effective state", t => {
  const f = fixture(t); f.store.initialize(initial());
  assert.throws(() => f.store.updateConfig({ security: { filesystem: "danger-full-access", network: "allow", approval: "never" } }, { expectedVersion: 1 }), /明确确认/);
  assert.equal(f.store.getPublicConfig().version, 1);
  assert.throws(() => f.store.updateConfig({ models: { main: { ...initial().models.main!, baseUrl: "https://test-user:test-password@provider.invalid" } } }, { expectedVersion: 1 }));
  assert.equal(f.store.resolveModel({ purpose: "main" }).model, "main-v1");
});
test("auto-grant requires explicit full-access confirmation and survives reload", t => {
  const f = fixture(t); f.store.initialize(initial());
  const security = { filesystem: "danger-full-access" as const, network: "allow" as const, approval: "auto-grant" as const };
  assert.throws(() => f.store.updateConfig({ security }, { expectedVersion: 1 }), /明确确认/);
  f.store.updateConfig({ security: { ...security, confirmFullAccess: true } }, { expectedVersion: 1 });
  assert.equal(f.reopen().getPublicConfig().security.approval, "auto-grant");
});
test("post-commit security callback failure reports the committed version", async t => {
  const f = fixture(t); f.store.initialize(initial());
  const api = new ProductHttpApi(f.store, new InMemoryClusterStore(), async () => { throw new Error("fixture-secret"); });
  t.after(() => api.close());
  const req = Readable.from([JSON.stringify({ expectedVersion: 1, patch: { security: { filesystem: "read-only", network: "deny", approval: "ask" } } })]) as any;
  req.method = "PUT";
  await assert.rejects(api.handle(req, {} as any, new URL("http://localhost/api/product/config"), { userId: "admin", role: "admin" }), error => {
    assert.match(String(error), /COMMITTED_APPLY_FAILED.*v2/);
    assert.doesNotMatch(String(error), /fixture-secret/);
    return true;
  });
  assert.equal(f.store.getPublicConfig().version, 2);
  assert.equal(f.store.getPublicConfig().security.filesystem, "read-only");
  assert.equal(f.store.pendingSecurityApply()?.version, 2);
  assert.equal(f.store.pendingSecurityApply()?.state, "waiting_retry");
  assert.equal(f.store.pendingSecurityApply()?.attempts, 1);
  assert.ok((f.store.pendingSecurityApply()?.nextRetryAt ?? 0) > Date.now());
  api.close();
  f.reopen();
  assert.equal(f.store.pendingSecurityApply()?.version, 2);
  const recovery = new ProductHttpApi(f.store, new InMemoryClusterStore(), async () => {});
  t.after(() => recovery.close());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.pendingSecurityApply(), undefined);
});
test("missing security apply handler is durable and requires service repair", async t => {
  const f = fixture(t); f.store.initialize(initial());
  const api = new ProductHttpApi(f.store, new InMemoryClusterStore()); t.after(() => api.close());
  const req = Readable.from([JSON.stringify({ expectedVersion: 1, patch: { security: { filesystem: "read-only", network: "deny", approval: "ask" } } })]) as any;
  req.method = "PUT";
  await assert.rejects(api.handle(req, {} as any, new URL("http://localhost/api/product/config"), { userId: "admin", role: "admin" }), /COMMITTED_APPLY_FAILED/);
  assert.equal(f.store.pendingSecurityApply()?.state, "blocked");
  assert.equal(f.store.pendingSecurityApply()?.errorCode, "HANDLER_UNAVAILABLE");
  api.close(); f.reopen();
  assert.equal(f.store.pendingSecurityApply()?.state, "blocked");
  const recovery = new ProductHttpApi(f.store, new InMemoryClusterStore(), async () => {}); t.after(() => recovery.close());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.pendingSecurityApply(), undefined);
});
test("a newer security policy fences a delayed apply of the previous version", async t => {
  const f = fixture(t); f.store.initialize(initial());
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const api = new ProductHttpApi(f.store, new InMemoryClusterStore(), async () => { entered(); await gate; });
  t.after(() => { release(); api.close(); });
  const req = Readable.from([JSON.stringify({ expectedVersion: 1, patch: { security: { filesystem: "read-only", network: "deny", approval: "ask" } } })]) as any;
  req.method = "PUT";
  const applying = api.handle(req, {} as any, new URL("http://localhost/api/product/config"), { userId: "admin", role: "admin" });
  await started;
  f.store.updateConfig({ security: initial().security }, { expectedVersion: 2 });
  assert.equal(f.store.pendingSecurityApply()?.version, 3);
  release();
  await assert.rejects(applying, /COMMITTED_APPLY_FAILED/);
  assert.equal(f.store.pendingSecurityApply()?.version, 3);
  assert.equal(f.store.completeSecurityApply(2), false);
  api.close(); f.reopen();
  assert.equal(f.store.pendingSecurityApply()?.version, 3);
  const recovery = new ProductHttpApi(f.store, new InMemoryClusterStore(), async () => {});
  t.after(() => recovery.close());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.pendingSecurityApply(), undefined);
});
test("rolling back security while an apply is pending retains a versioned fail-closed barrier", t => {
  const f = fixture(t); f.store.initialize(initial());
  f.store.updateConfig({ security: { filesystem: "read-only", network: "deny", approval: "ask" } }, { expectedVersion: 1 });
  assert.equal(f.store.pendingSecurityApply()?.version, 2);
  assert.equal(f.store.rollback(1, 2).version, 3);
  assert.equal(f.store.pendingSecurityApply()?.version, 3);
  assert.equal(f.store.completeSecurityApply(2), false);
  assert.equal(f.reopen().pendingSecurityApply()?.version, 3);
  assert.equal(f.store.completeSecurityApply(3), true);
});
test("configuration persistence failure is distinguished from an applied change", async t => {
  const f = fixture(t); f.store.initialize(initial());
  (f.store as any).db.exec("CREATE TRIGGER injected_config_failure BEFORE INSERT ON product_configs BEGIN SELECT RAISE(ABORT, 'injected database failure'); END");
  const api = new ProductHttpApi(f.store, new InMemoryClusterStore(), async () => {}); t.after(() => api.close());
  const req = Readable.from([JSON.stringify({ expectedVersion: 1, patch: { security: { filesystem: "read-only", network: "deny", approval: "ask" } } })]) as any;
  req.method = "PUT";
  await assert.rejects(api.handle(req, {} as any, new URL("http://localhost/api/product/config"), { userId: "admin", role: "admin" }), /CONFIG_PERSISTENCE_FAILED/);
  assert.equal(f.store.getPublicConfig().version, 1);
  assert.equal(f.store.pendingSecurityApply(), undefined);
});
test("invitations survive coordinator restart and cannot be consumed twice", t => {
  const f = fixture(t); f.store.initialize(initial()); const manager = new InviteManager(f.store); const invitation = manager.createInvite();
  const restored = new InviteManager(f.reopen()); assert.equal(restored.verifyAndConsume(invitation.inviteCode).valid, true); assert.equal(new InviteManager(f.reopen()).verifyAndConsume(invitation.inviteCode).valid, false);
  const expired = new InviteManager(f.store).createInvite({ ttlMs: -1 }); assert.equal(new InviteManager(f.store).verifyAndConsume(expired.inviteCode).valid, false);
  const revoked = new InviteManager(f.store).createInvite(); new InviteManager(f.store).revokeInvite(revoked.inviteCode); assert.equal(new InviteManager(f.store).verifyAndConsume(revoked.inviteCode).valid, false);
});
test("colocated worker uses node authenticated gateway without copying provider credentials", t => {
  const f = fixture(t); f.store.initialize(initial()); const identity = new NodeIdentity({ customDir: path.join(f.homeDir, "local-worker") }); identity.setCoordinatorUrl("ws://127.0.0.1:18443/ws/cluster"); identity.setNodeToken("ntk_fixture_node_identity");
  const models = workerModels(f.store, identity, "task-fixture", "run-fixture");
  assert.match(models.main.baseUrl, /\/api\/product\/gateway\/main\/v1$/); assert.equal(models.main.apiKey, "ntk_fixture_node_identity"); assert.equal(models.security.headers?.["X-Nash-Task-Id"], "task-fixture");
  assert.doesNotMatch(JSON.stringify(models), /fixture-model-secret/);
});
test("async model contexts isolate simultaneous requests", async t => {
  const f = fixture(t); f.store.initialize(initial()); const main = f.store.resolveModel({ purpose: "main" });
  await Promise.all([1, 2].map(version => withProductModels({ main: { ...main, model: `v${version}` }, security: main, version }, async () => { await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(currentModelContext()?.main.model, `v${version}`); })));
  assert.equal(currentModelContext(), undefined);
});
