import { randomBytes } from "node:crypto";
import { before as configureAuth, after as restoreAuth } from "node:test";
const testPassword = randomBytes(24).toString("hex");
const previousPassword = process.env.DASHBOARD_PASS;
configureAuth(() => { process.env.DASHBOARD_PASS = testPassword; });
restoreAuth(() => { if (previousPassword === undefined) delete process.env.DASHBOARD_PASS; else process.env.DASHBOARD_PASS = previousPassword; });
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClusterApiHandler } from "../src/cluster/coordinator/api-server.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";

async function fixture(t: TestContext, mainAgent?: any, adminApiKey: string | null = "test-key", webDistDir?: string, trustProxy = false) {
  const store = new InMemoryClusterStore();
  const handler = new ClusterApiHandler({ store, registry: { listOnlineConnections: () => [] } as any,
    scheduler: {} as any, inviteManager: {} as any, coordinatorNodeId: "test", adminApiKey: adminApiKey ?? undefined, mainAgent, webDistDir, trustProxy });
  const server = http.createServer((req, res) => { void handler.handleRequest(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { store, handler, url, request: (path: string, options: RequestInit = {}) => fetch(url + path, {
    ...options, headers: { Authorization: "Bearer test-key", "Content-Type": "application/json", ...options.headers },
  }) };
}

test("HTTPS 反代保留公网端口时允许浏览器同源资源与 API，拒绝不同来源", async (t) => {
  const webDistDir = await mkdtemp(join(tmpdir(), "nash-proxy-origin-"));
  t.after(() => rm(webDistDir, { recursive: true, force: true }));
  await writeFile(join(webDistDir, "app.js"), 'document.body.textContent = "loaded";');
  await writeFile(join(webDistDir, "app.css"), 'body { color: black; }');
  const { url } = await fixture(t, undefined, "test-key", webDistDir, true);
  const headers = { Host: "203.0.113.10:18443", "X-Forwarded-Proto": "https", Origin: "https://203.0.113.10:18443" };
  // 原生 HTTP 保留反代 Host；fetch 会根据目标 URL 重建该头，无法模拟外部端口。
  const proxied = (path: string, overrides: Record<string, string> = {}) => new Promise<{ status: number; contentType?: string }>((resolve, reject) => {
    const req = http.get(url + path, { headers: { ...headers, Authorization: "Bearer test-key", ...overrides } }, (res) => {
      res.resume(); res.on("end", () => resolve({ status: res.statusCode!, contentType: res.headers["content-type"] }));
    });
    req.on("error", reject);
  });
  for (const [path, mime] of [["/app.js", "javascript"], ["/app.css", "text/css"]]) {
    const asset = await proxied(path!);
    assert.equal(asset.status, 200); assert.ok(asset.contentType?.includes(mime!));
  }
  assert.equal((await proxied("/api/cluster/status")).status, 200);
  // $host 丢失外部端口会重现白屏；不能通过放宽来源匹配来掩盖部署错误。
  assert.equal((await proxied("/app.js", { Host: "203.0.113.10" })).status, 403);
  assert.equal((await proxied("/api/cluster/status", { Origin: "https://untrusted.invalid" })).status, 403);
  assert.equal((await proxied("/api/cluster/status", { Origin: "https://203.0.113.10:18444" })).status, 403);
});

test("缺失配置不再免登录，畸形 Cookie 不使服务器崩溃，页面跳转登录", async (t) => {
  const { url, request } = await fixture(t, undefined, null);
  assert.equal((await fetch(url + "/api/auth/me")).status, 401);
  assert.equal((await fetch(url + "/api/cluster/tasks", { headers: { Cookie: "nash_session=%E0%A4%A" } })).status, 401);
  const page = await fetch(url + "/graphs", { redirect: "manual" });
  assert.equal(page.status, 302); assert.match(page.headers.get("location")!, /^\/login/);
  const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: testPassword }) });
  assert.equal((await fetch(url + "/api/cluster/status", { headers: { Cookie: login.headers.get("set-cookie")!.split(";")[0]! } })).status, 200);
});

test("登录使用明确配置的完整密码；Cookie 写请求不可省略 CSRF，跨源访问被拒绝", async (t) => {
  const { url } = await fixture(t);
  const login = (password: string) => fetch(url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password }) });
  assert.equal((await login(testPassword.slice(0, -1))).status, 401);
  const accepted = await login(testPassword); assert.equal(accepted.status, 200);
  const cookie = accepted.headers.get("set-cookie")!.split(";")[0]!;
  const { csrfToken } = await accepted.json() as any;
  const write = (headers: Record<string, string>) => fetch(url + "/api/cluster/conversations", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", ...headers }, body: JSON.stringify({ title: "test" }) });
  assert.equal((await write({})).status, 403);
  assert.equal((await write({ "X-CSRF-Token": "wrong" })).status, 403);
  assert.equal((await write({ "X-CSRF-Token": csrfToken })).status, 201);
  const cors = await fetch(url + "/api/auth/me", { headers: { Cookie: cookie, Origin: "https://untrusted.invalid" } });
  assert.equal(cors.status, 403); assert.equal(cors.headers.get("access-control-allow-origin"), null);
});

test("错误登录触发频控，请求体过大返回 413", async (t) => {
  const { url, request } = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await fetch(url + "/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "wrong" }) })).status, 401);
  const locked = await fetch(url + "/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: testPassword }) });
  assert.equal(locked.status, 429); assert.ok(Number(locked.headers.get("retry-after")) > 0);
  assert.equal((await request("/api/cluster/conversations", { method: "POST", body: JSON.stringify({ title: "x".repeat(1024 * 1024) }) })).status, 413);
});

test("退出会话立即断开已有 SSE，后续私有事件不能继续传输", async (t) => {
  const { store, handler, url } = await fixture(t);
  await store.saveWebSession({ sessionId: "sse-test", userId: "test", username: "test", role: "admin", csrfToken: "csrf", createdAt: Date.now(), expiresAt: Date.now() + 60000 });
  const stream = await fetch(url + "/api/cluster/events/stream", { headers: { Cookie: "nash_session=sse-test" } });
  const reader = stream.body!.getReader(); await reader.read();
  const logout = await fetch(url + "/api/auth/logout", { method: "POST", headers: { Cookie: "nash_session=sse-test", "X-CSRF-Token": "csrf" } });
  assert.equal(logout.status, 200); assert.equal(await store.getWebSession("sse-test"), null);
  handler.broadcastGlobalSse("conversation.message_created", { private: "must-not-arrive" });
  const next = await reader.read(); assert.equal(next.done, true);
});

test("同一会话拒绝并发写入，当前轮取消仍能命中，消息不丢失", async (t) => {
  let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
  let signal: AbortSignal | undefined;
  const mainAgent = { chat: async (_id: string, _text: string, options: any) => {
    signal = options.abortSignal; entered();
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    return { assistantResponse: "cancelled", state: "cancelled", durationMs: 0 };
  } };
  const { store, request } = await fixture(t, mainAgent);
  await store.saveConversation({ id: "conversation", title: "test", createdAt: Date.now(), updatedAt: Date.now(), messages: [], linkedTaskIds: [] });
  const first = request("/api/cluster/conversations/conversation/messages", { method: "POST", body: JSON.stringify({ content: "first" }) });
  await ready;
  assert.equal((await request("/api/cluster/conversations/conversation/messages", { method: "POST", body: JSON.stringify({ content: "second" }) })).status, 409);
  assert.equal((await request("/api/cluster/conversations/conversation/cancel", { method: "POST" })).status, 200);
  await first; assert.equal(signal!.aborted, true);
  const saved = (await store.getConversation("conversation"))!;
  assert.ok(saved.messages.some((message) => message.content === "first"));
  assert.ok(saved.messages.some((message) => message.content === "cancelled"));
});

test("未配置密码时拒绝默认凭据，登录返回 503 且不签发 Cookie", async (t) => {
  const dashboard = process.env.DASHBOARD_PASS; const admin = process.env.ADMIN_PASS;
  delete process.env.DASHBOARD_PASS; delete process.env.ADMIN_PASS;
  t.after(() => { if (dashboard !== undefined) process.env.DASHBOARD_PASS = dashboard; if (admin !== undefined) process.env.ADMIN_PASS = admin; });
  const { url } = await fixture(t);
  const result = await fetch(url + "/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "legacy-default" }) });
  assert.equal(result.status, 503); assert.equal(result.headers.get("set-cookie"), null);
});
