delete process.env.DISPLAY;
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chromium, type Browser, type BrowserServer, type Page, type Dialog } from "playwright-core";
import { ProductStore } from "../src/product/store.js";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";
import { acquireBrowserLock, browserLockPath } from "./browser-lock.js";

const chrome = process.env.NASH_CHROME_PATH ?? process.env.CHROME_BIN ?? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
].find(file => fs.existsSync(file));
const isLinux = process.platform === "linux";
const enabled = process.env.NASH_RUN_FORMAL_PRODUCT_BROWSER === "1";

// SIMULATED_INTEGRATION: only the local Provider speaks simulated protocol.
// Authentication, SQLite, ProductHttpApi, configuration transactions and pages are real.
// This is not evidence of real-provider compatibility or physical Worker isolation.
test("SIMULATED_INTEGRATION: real product UI, SQLite auth, configuration and mobile workflows", {
  timeout: 65000,
  skip: !enabled ? "Set NASH_RUN_FORMAL_PRODUCT_BROWSER=1 after building the Web UI; serialized browser coverage" : !chrome ? "Chrome is unavailable" : false,
}, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nash-formal-product-browser-"));
  const home = path.join(temp, "product");
  const previousHome = process.env.NASH_HOME;
  process.env.NASH_HOME = home;
  const password = randomBytes(24).toString("hex");
  const providerSecret = randomBytes(24).toString("hex");
  const securitySecret = randomBytes(24).toString("hex");
  const newPassword = randomBytes(24).toString("hex");
  const changedPassword = randomBytes(24).toString("hex");
  let store: ProductStore | undefined;
  let coordinator: ClusterCoordinator | undefined;
  let browser: Browser | undefined, browserServer: BrowserServer | undefined;
  let watchdog: NodeJS.Timeout | undefined, ownsLock = false, chromeProfile: string | undefined;
  let providerCalls = 0, cancelledStreams = 0, forcedTimeout = false;
  const timers = new Set<NodeJS.Timeout>();
  const pageErrors: string[] = [];
  const snapshots: Array<{ route: string; heading: string; horizontalOverflow: boolean }> = [];
  const provider = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(req.url, "/v1/chat/completions");
      assert.ok([`Bearer ${providerSecret}`, `Bearer ${securitySecret}`].includes(req.headers.authorization ?? ""));
      providerCalls++;
      const last = body.messages?.at(-1);
      const isToolProbe = body.tools?.some((tool: any) => tool.function?.name === "nash_connection_probe")
        && last?.role === "user" && String(last.content).includes("Call nash_connection_probe exactly once");
      const usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 };
      if (!body.stream) {
        const message = isToolProbe
          ? { role: "assistant", content: null, tool_calls: [{ id: "simulated-probe-call", type: "function", function: { name: "nash_connection_probe", arguments: JSON.stringify({ value: "nash-ready" }) } }] }
          : { role: "assistant", content: "OK" };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "simulated-response", model: body.model, choices: [{ index: 0, message, finish_reason: isToolProbe ? "tool_calls" : "stop" }], usage }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      const delta = isToolProbe ? { tool_calls: [{ index: 0, id: "simulated-stream-tool", type: "function", function: { name: "nash_connection_probe", arguments: JSON.stringify({ value: "nash-ready" }) } }] } : { content: "OK" };
      res.write(`data: ${JSON.stringify({ id: "simulated-stream", model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      if (String(last?.content).includes("Count from 1 to 100")) {
        const timer = setInterval(() => { if (!res.destroyed) res.write(": simulated-cancellable-stream\n\n"); }, 20);
        timers.add(timer);
        res.once("close", () => { cancelledStreams++; clearInterval(timer); timers.delete(timer); });
      } else {
        res.end(`data: ${JSON.stringify({ id: "simulated-stream", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: isToolProbe ? "tool_calls" : "stop" }], usage })}\n\ndata: [DONE]\n\n`);
      }
    } catch {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Local simulated Provider contract failure" }));
    }
  });
  const bounded = async (action: Promise<unknown> | undefined, ms: number) => {
    if (!action) return;
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([action.catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  async function capture(page: Page, route: string) {
    snapshots.push({ route, heading: await page.locator(".product-page h1").innerText(), horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1) });
  }
  try {
    store = new ProductStore({ homeDir: home });
    assert.ok(fs.existsSync(path.join(process.cwd(), "apps/web/dist/index.html")), "Build the actual Web UI before this test");
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
    store.initialize({ role: "coordinator", coordinator: { listenHost: "127.0.0.1", listenPort: 18443 }, models: { main: { baseUrl: providerUrl, model: "simulated-main-v1", format: "completions", apiKey: providerSecret } }, security: { filesystem: "workspace-write", network: "deny", approval: "ask" }, admin: { username: "browser-admin", password } });
    coordinator = new ClusterCoordinator({ ephemeral: true, listenHost: "127.0.0.1", listenPort: 0, productStore: store, webDistDir: path.join(process.cwd(), "apps/web/dist") });
    const bound = await coordinator.start(), origin = `http://127.0.0.1:${bound.port}`;
    assert.equal((await coordinator.getStore().listNodes()).length, 0, "No fake Worker fixtures");
    assert.equal((await coordinator.getStore().listTasks()).length, 0, "No fake completed task fixtures");
    await acquireBrowserLock(); ownsLock = true;
    const browserStartedAt = Date.now();
    watchdog = setTimeout(() => { forcedTimeout = true; browserServer?.process().kill("SIGKILL"); }, 30000);
    browserServer = await chromium.launchServer({ executablePath: chrome, headless: true, timeout: 8000,
      downloadsPath: path.join(temp, "downloads"),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage", ...(isLinux ? [] : ["--single-process", "--no-zygote"]), "--renderer-process-limit=1", "--disable-extensions", "--disable-component-update", "--disable-breakpad", "--disable-crash-reporter", "--no-first-run", "--no-default-browser-check"] });
    chromeProfile = browserServer.process().spawnargs.find(argument => argument.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
    browser = await chromium.connect(browserServer.wsEndpoint());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(4000);
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/*", route => ["image", "font", "media"].includes(route.request().resourceType()) ? route.abort() : route.continue());
    await page.goto(`${origin}/login?redirect=/models`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("管理员账号", { exact: true }).fill("browser-admin");
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${origin}/models`);
    await page.locator("#main-model").waitFor();
    assert.equal(await page.locator("#main-model").inputValue(), "simulated-main-v1");
    assert.equal(await page.locator("#main-key").inputValue(), "", "Saved API key never returned into the form");
    assert.equal(await page.locator("#model-target option").count(), 1, "No invented Worker override targets");
    assert.equal(await page.locator("html").evaluate(element => element.classList.contains("light")), true, "New browsers start in the light theme");
    await page.locator("#main-model").fill("simulated-main-v2");
    await page.getByRole("button", { name: "验证并应用配置", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "配置 v2 已应用" }).waitFor();
    assert.equal(store.getPublicConfig().version, 2);
    assert.equal(store.resolveModel({ purpose: "main" }).model, "simulated-main-v2");
    assert.equal(store.resolveModel({ purpose: "main" }).apiKey, providerSecret, "Empty key input preserves the stored key");

    await page.locator("#security-inheritance").selectOption("independent");
    await page.locator("#security-model").fill("simulated-security-independent");
    await page.locator("#security-url").fill(providerUrl);
    await page.locator("#security-key").fill(securitySecret);
    await page.getByRole("button", { name: "测试安全模型", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "能力测试已完成" }).waitFor();
    assert.match(await page.locator(".product-page").innerText(), /工具参数：通过/);
    assert.match(await page.locator(".product-page").innerText(), /取消传播：通过/);
    await page.getByRole("button", { name: "验证并应用配置", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "配置 v3 已应用" }).waitFor();
    assert.equal(store.getPublicConfig().models.security.mode, "independent");
    assert.equal(store.resolveModel({ purpose: "security" }).apiKey, securitySecret);
    assert.equal(await page.locator("#security-key").inputValue(), "");

    await page.getByLabel("选择历史配置版本").selectOption("1");
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "审阅并恢复", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "创建配置 v4" }).waitFor();
    assert.equal(store.getPublicConfig().models.security.mode, "follow-main");
    store.updateConfig({ security: { filesystem: "workspace-write", network: "deny", approval: "ask" } }, { expectedVersion: 4 });
    await page.getByRole("button", { name: "验证并应用配置", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "配置已被其他操作更新" }).waitFor();
    assert.equal(store.getPublicConfig().version, 5, "Stale form cannot overwrite a newer configuration");
    await capture(page, "models");

    await page.goto(`${origin}/security`, { waitUntil: "domcontentloaded" });
    await page.locator("#filesystem-mode").selectOption("danger-full-access");
    assert.equal(await page.getByRole("button", { name: "应用安全策略", exact: true }).isDisabled(), true);
    await page.locator("#filesystem-mode").selectOption("workspace-write");
    assert.equal(store.getPublicConfig().security.filesystem, "workspace-write", "Cancelling Full Access before saving leaves policy unchanged");
    await page.locator("#filesystem-mode").selectOption("danger-full-access");
    await page.getByRole("checkbox", { name: "我了解风险，明确允许该配置使用完全访问。" }).check();
    await page.getByRole("button", { name: "应用安全策略", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "安全策略 v6 已保存" }).waitFor();
    assert.equal(store.getPublicConfig().security.filesystem, "danger-full-access");
    assert.equal(store.getPublicConfig().security.confirmFullAccess, true);
    await page.locator("#filesystem-mode").selectOption("workspace-write");
    await page.getByRole("button", { name: "应用安全策略", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "安全策略 v7 已保存" }).waitFor();
    await capture(page, "security");

    await page.goto(`${origin}/models`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("选择历史配置版本").selectOption("6");
    let confirmations = 0;
    const cancelRisk = (dialog: Dialog) => { confirmations++; return confirmations === 1 ? dialog.accept() : dialog.dismiss(); };
    page.on("dialog", cancelRisk);
    await page.getByRole("button", { name: "审阅并恢复", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "已取消完全访问恢复" }).waitFor();
    page.off("dialog", cancelRisk);
    assert.equal(confirmations, 2, "Dangerous rollback requires a separate risk confirmation");
    assert.equal(store.getPublicConfig().version, 7);
    assert.equal(store.getPublicConfig().security.filesystem, "workspace-write");
    const acceptRisk = (dialog: Dialog) => dialog.accept();
    page.on("dialog", acceptRisk);
    await page.getByRole("button", { name: "审阅并恢复", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "创建配置 v8" }).waitFor();
    page.off("dialog", acceptRisk);
    assert.equal(store.getPublicConfig().security.filesystem, "danger-full-access");
    await page.goto(`${origin}/security`, { waitUntil: "domcontentloaded" });
    await page.locator("#filesystem-mode").selectOption("workspace-write");
    await page.getByRole("button", { name: "应用安全策略", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "安全策略 v9 已保存" }).waitFor();

    await page.goto(`${origin}/settings`, { waitUntil: "domcontentloaded" });
    await page.locator("summary").filter({ hasText: "创建管理员" }).click();
    await page.locator("#admin-username").fill("new-browser-admin");
    await page.locator("#admin-password").fill(newPassword);
    await page.locator("#admin-repeat").fill(newPassword);
    await page.getByRole("button", { name: "创建管理员", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "new-browser-admin 已创建" }).waitFor();
    assert.ok(store.authenticate("new-browser-admin", newPassword));
    const createdUser = store.listUsers().find(user => user.username === "new-browser-admin")!;
    await page.locator("#password-account").selectOption(createdUser.userId);
    await page.locator("#changed-password").fill(changedPassword);
    await page.locator("#changed-repeat").fill(changedPassword);
    await page.getByRole("button", { name: "更新密码并撤销旧会话", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "密码已更新" }).waitFor();
    assert.equal(store.authenticate("new-browser-admin", newPassword), undefined);
    assert.ok(store.authenticate("new-browser-admin", changedPassword));
    await capture(page, "settings");

    await page.goto(`${origin}/diagnostics`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "数据存储", exact: true }).waitFor();
    assert.match(await page.locator(".product-page").innerText(), /连接正常/);
    assert.match(await page.locator(".product-page").innerText(), /还没有已注册节点/);
    await capture(page, "diagnostics");
    await page.goto(`${origin}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.getByText("Coordinator 运行正常", { exact: true }).waitFor();
    assert.match(await page.locator(".product-page").innerText(), /0 \/ 0/);
    assert.match(await page.locator(".product-page").innerText(), /还没有任务记录/);
    assert.match(await page.locator(".product-page").innerText(), /还没有节点/);
    await capture(page, "dashboard");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/models`, { waitUntil: "domcontentloaded" });
    await page.locator("#main-model").waitFor();
    await capture(page, "mobile-models");
    await page.goto(`${origin}/cluster`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "还没有注册的节点", exact: true }).waitFor();
    await capture(page, "mobile-nodes");
    await page.screenshot({ path: path.join(temp, "mobile-empty-nodes.png") });
    const html = await page.content();
    assert.ok(!html.includes(providerSecret) && !html.includes(securitySecret), "Saved Provider secrets do not appear in page HTML");
    assert.deepEqual(pageErrors, [], "No uncaught browser errors");
    assert.equal(forcedTimeout, false, "Browser completes before the physical watchdog");
    assert.ok(Date.now() - browserStartedAt < 30000);
    assert.ok(providerCalls >= 20, "Saving/testing uses the actual HTTP Provider contract");
    assert.ok(cancelledStreams >= 4, "Real upstream connections are aborted by capability probes");
    assert.ok(snapshots.every(snapshot => !snapshot.horizontalOverflow), JSON.stringify(snapshots));
    t.diagnostic(`SIMULATED_INTEGRATION: ${snapshots.length} page states; ${providerCalls} local Provider requests; ${cancelledStreams} cancelled streams; zero fake Workers/tasks.`);
  } finally {
    await bounded(browser?.close(), 1500);
    const child = browserServer?.process();
    if (child?.exitCode === null) child.kill("SIGKILL");
    await bounded(browserServer?.close(), 1500);
    if (watchdog) clearTimeout(watchdog);
    if (chromeProfile && path.basename(chromeProfile).startsWith("playwright_chromiumdev_profile-")) fs.rmSync(chromeProfile, { recursive: true, force: true });
    if (ownsLock) fs.rmSync(browserLockPath, { recursive: true, force: true });
    try { await coordinator?.stop(); }
    finally {
      for (const timer of timers) clearInterval(timer);
      await new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections(); });
      store?.close();
      fs.rmSync(temp, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.NASH_HOME; else process.env.NASH_HOME = previousHome;
    }
  }
});
