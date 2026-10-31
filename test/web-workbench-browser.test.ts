delete process.env.DISPLAY;
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { acquireBrowserLock, browserLockPath } from "./browser-lock.js";
import { chromium, type BrowserServer, type Locator } from "playwright-core";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";

const CHROME_PATH = process.env.NASH_CHROME_PATH ?? process.env.CHROME_BIN ?? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
].find(candidate => fs.existsSync(candidate)) ?? "";
const isLinux = process.platform === "linux";
const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--renderer-process-limit=1",
  "--disable-extensions",
  "--disable-component-update",
  ...(isLinux ? [] : ["--single-process", "--no-zygote"]),
];

test("Workbench: 真实拖拽、键盘、持久化、取消清理与七档视口视觉验收", { timeout: 60000, skip: !CHROME_PATH ? "Chrome is not installed on this platform; visual coverage runs on Mac" : false }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nash-workbench-"));
  const output = process.env.NASH_VISUAL_OUTPUT_DIR || temp;
  fs.mkdirSync(output, { recursive: true });
  const lock = browserLockPath;
  const previousPassword = process.env.DASHBOARD_PASS;
  const password = randomBytes(24).toString("hex");
  process.env.DASHBOARD_PASS = password;
  const coordinator = new ClusterCoordinator({ ephemeral: true, listenHost: "127.0.0.1", listenPort: 0,
    adminApiKey: "workbench-test", webDistDir: path.join(process.cwd(), "apps/web/dist") });
  let server: BrowserServer | undefined, watchdog: NodeJS.Timeout | undefined, ownsLock = false;
  t.after(async () => {
    clearTimeout(watchdog);
    try { await server?.close(); } finally {
      const child = server?.process(); if (child?.exitCode === null) child.kill("SIGKILL");
      if (ownsLock) fs.rmSync(lock, { recursive: true, force: true });
      await coordinator.stop(); fs.rmSync(temp, { recursive: true, force: true });
      if (previousPassword === undefined) delete process.env.DASHBOARD_PASS; else process.env.DASHBOARD_PASS = previousPassword;
    }
  });
  const started = await coordinator.start();
  const url = `http://127.0.0.1:${started.port}`;
  await acquireBrowserLock(); ownsLock = true;
  server = await chromium.launchServer({ executablePath: CHROME_PATH, headless: true,
    args: BROWSER_ARGS });
  watchdog = setTimeout(() => server?.process().kill("SIGKILL"), 30000);
  const browser = await chromium.connect(server.wsEndpoint());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const now = Date.now();
  const conversations = Array.from({ length: 24 }, (_, i) => ({ id: `layout-${i}`, title: `工作台布局验收 · 会话 ${i + 1}`, createdAt: now, updatedAt: now,
    linkedTaskIds: [], linkedGraphIds: ["layout-graph"], messages: [{ id: `m-${i}`, conversationId: `layout-${i}`, sender: "assistant", content: "布局验收：会话、任务图与输入草稿保持稳定。", timestamp: now }] }));
  let graphRequests = 0;
  await page.route("**/*", route => ["image", "media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue());
  await page.route("**/api/cluster/conversations**", route => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    return route.fulfill({ json: id === "conversations" ? { conversations } : { conversation: conversations.find(c => c.id === id) || conversations[0], isRunning: false, activeTasks: [], activeGraphs: [] } });
  });
  await page.route("**/api/cluster/graphs/layout-graph", route => {
    graphRequests++;
    return route.fulfill({ json: { graph: { graphId: "layout-graph", status: "running", parentGoal: "跨节点任务图 · 容器自适应与实时状态验证" }, snapshot: {}, revisions: [],
      nodes: ["a", "b"].map((id, index) => ({ graphId: "layout-graph", nodeId: id, title: index ? "生成产物" : "检查项目", status: "running", goal: "验证宽度变化后的图形边界", producedArtifacts: [] })),
      edges: [{ fromNodeId: "a", toNodeId: "b" }] } });
  });
  await page.goto(`${url}/login`);
  await page.evaluate(() => localStorage.setItem("nash_theme", "dark"));
  await page.reload();
  await page.getByLabel("管理员账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`${url}/`); await page.locator("textarea").waitFor();
  await page.locator(".vue-flow__node").first().waitFor();
  const sidebar = page.locator('[data-panel="sidebar"]');
  const inspector = page.locator('[data-panel="inspector"]');
  const conversation = page.locator('[data-panel="conversation"]');
  const left = page.getByRole("separator", { name: "调整左侧导航栏宽度", exact: true });
  const right = page.getByRole("separator", { name: "调整右侧检查器面板宽度", exact: true });
  const horizontal = page.getByRole("separator", { name: "调整侧边栏功能导航与最近会话区域高度分配", exact: true });
  async function width(locator: Locator) { return (await locator.boundingBox())!.width; }
  async function value(locator: Locator) { return Number(await locator.getAttribute("aria-valuenow")); }
  async function shot(name: string) { await page.waitForTimeout(180); await page.screenshot({ path: path.join(output, `${name}.png`) }); }
  async function startDrag(locator: Locator) { const box = (await locator.boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); return box; }
  async function drag(locator: Locator, dx: number, dy = 0) { const box = await startDrag(locator); await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 3 }); await page.mouse.up(); }
  await page.mouse.move(700, 30);
  await shot("desktop-default-dark");
  assert.equal(await width(left), 1, "分隔线仅占1px");
  assert.equal(await left.locator(".splitter-grip").evaluate(e => getComputedStyle(e).opacity), "0");
  await left.hover(); await page.waitForTimeout(170); await shot("splitter-hover");
  assert.equal(await left.locator(".splitter-grip").evaluate(e => getComputedStyle(e).opacity), "1");
  await page.locator("textarea").fill("未发送的输入草稿");
  const initialGraphRequests = graphRequests;
  const box = await startDrag(left);
  const storageBefore = await page.evaluate(() => localStorage.getItem("nash_workbench_layout_v2"));
  await page.mouse.move(box.x + 61, box.y + 100);
  await shot("splitter-dragging");
  assert.equal(await value(left), 341);
  assert.equal(await page.evaluate(() => localStorage.getItem("nash_workbench_layout_v2")), storageBefore);
  await page.mouse.up();
  assert.equal(await page.evaluate(() => document.body.style.cursor), "");
  assert.equal(await page.locator("textarea").inputValue(), "未发送的输入草稿");
  assert.equal(graphRequests, initialGraphRequests, "拖动不重新建立图SSE或加载任务");
  await drag(right, -80); assert.equal(await value(right), 480);
  await page.waitForTimeout(180);
  const graphBox = (await page.locator(".vue-flow").boundingBox())!;
  assert.ok(graphBox.width < await width(inspector));
  assert.ok(await width(conversation) >= 500);
  const beforeHeight = await value(horizontal);
  await drag(horizontal, 0, 70); assert.equal(await value(horizontal), beforeHeight + 70);
  await shot("recent-height-adjusted");
  const recent = page.getByLabel("最近会话", { exact: true });
  await recent.evaluate(e => { e.scrollTop = 150; });
  const recentY = (await recent.boundingBox())!.y;
  const recentScroll = await recent.evaluate(e => e.scrollTop);
  const groups = page.locator('nav[aria-label="功能导航"] button[aria-expanded]');
  await groups.nth(0).click(); await groups.nth(1).click();
  assert.equal(await page.locator('nav button[aria-expanded="true"]').count(), 1);
  assert.equal((await recent.boundingBox())!.y, recentY);
  assert.equal(await recent.evaluate(e => e.scrollTop), recentScroll);
  await shot("navigation-expanded");
  await left.focus(); await left.press("ArrowRight"); assert.equal(await value(left), 349);
  await left.press("Shift+ArrowLeft"); assert.equal(await value(left), 317);
  await right.focus(); await right.press("Home"); assert.equal(await value(right), 300);
  await right.press("End"); assert.ok(await width(conversation) >= 500);
  await right.press("Enter"); assert.equal(await value(right), 400);
  await left.dblclick(); assert.equal(await value(left), 280);
  await horizontal.dblclick(); assert.equal(await value(horizontal), beforeHeight);
  await drag(left, 5000); assert.equal(await value(left), 400);
  await left.dblclick();
  await drag(right, 5000); assert.equal(await value(right), 300);
  await right.dblclick();
  const savedWidth = await width(sidebar);
  await page.reload(); await left.waitFor(); assert.equal(await width(sidebar), savedWidth);
  assert.equal(await page.locator('nav button[aria-expanded="true"]').count(), 1);
  await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();
  assert.equal(await width(sidebar), 64); await shot("sidebar-collapsed");
  await page.reload(); await page.getByRole("button", { name: "展开侧边栏", exact: true }).waitFor();
  assert.equal(await width(sidebar), 64);
  await page.getByRole("button", { name: "展开侧边栏", exact: true }).click(); assert.equal(await width(sidebar), savedWidth);
  await page.getByRole("button", { name: "收起上下文面板", exact: true }).click();
  assert.equal(await width(inspector), 40); await shot("inspector-collapsed");
  await page.getByRole("button", { name: "展开上下文面板", exact: true }).click();
  // 非活动指针不能结束另一个指针的拖动；取消、失焦和卸载均释放光标与遮罩。
  await startDrag(left);
  await left.dispatchEvent("pointercancel", { pointerId: 99 }); assert.equal(await page.locator(".splitter-shield").count(), 1);
  await left.dispatchEvent("pointercancel", { pointerId: 1 }); assert.equal(await page.locator(".splitter-shield").count(), 0);
  await page.mouse.up();
  await startDrag(left); await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  assert.equal(await page.evaluate(() => document.body.style.userSelect), ""); await page.mouse.up();
  await startDrag(left);
  await page.evaluate(() => { history.pushState({}, "", "/tasks"); dispatchEvent(new PopStateEvent("popstate")); });
  await page.locator("textarea").waitFor({ state: "detached" });
  await page.locator(".splitter-shield").waitFor({ state: "detached" });
  assert.equal(await page.locator(".splitter-shield").count(), 0);
  assert.equal(await page.evaluate(() => document.body.style.cursor), ""); await page.mouse.up();
  await page.goto(url); await page.locator("textarea").waitFor();
  await page.locator("textarea").fill("跨设备调整保留草稿");
  for (const viewport of [375, 430, 768, 1024, 1280, 1440, 1920]) {
    await page.setViewportSize({ width: viewport, height: 900 });
    await page.waitForTimeout(170);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${viewport}px 不产生浏览器横向滚动`);
    assert.ok(await width(conversation) >= (viewport >= 1024 ? 500 : viewport - 1), `${viewport}px conversation=${await width(conversation)}`);
    assert.equal(await page.locator("textarea").inputValue(), "跨设备调整保留草稿");
    const input = (await page.locator("textarea").boundingBox())!;
    assert.ok(input.width > 200 && input.x + input.width <= viewport, `${viewport}px 输入框可用`);
    if (viewport < 768) assert.equal(await page.getByRole("separator").count(), 0);
    if (viewport === 1024) {
      assert.equal(await page.locator(".inspector-graph-summary").isVisible(), true);
      assert.equal(await page.locator(".inspector-graph-canvas").isVisible(), false);
    }
    await shot(`viewport-${viewport}-dark`);
    if (viewport < 1024) {
      await page.getByRole("button", { name: "展开上下文面板", exact: true }).click();
      assert.ok(await width(inspector) <= viewport - 24);
      await shot(`viewport-${viewport}-inspector`);
      await page.getByRole("button", { name: "收起上下文面板", exact: true }).click();
    }
  }
  await page.getByRole("button", { name: "亮色模式", exact: true }).click();
  await page.waitForTimeout(350);
  assert.equal(await page.locator(".assistant-message-card").first().evaluate(e => getComputedStyle(e).backgroundColor), "rgb(255, 255, 255)");
  await shot("desktop-light");
  for (const viewport of [375, 430, 768, 1024, 1280, 1440, 1920]) {
    await page.setViewportSize({ width: viewport, height: 900 });
    await page.waitForTimeout(170);
    await shot(`viewport-${viewport}-light`);
  }
  await page.setViewportSize({ width: 375, height: 812 }); await shot("mobile-light");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${url}/schedules`);
  const createdSchedules: string[] = [];
  for (const trigger of ["cron", "interval", "once"]) {
    await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
    const modal = page.locator(".fixed.inset-0.z-50");
    await modal.locator('input[placeholder="例如: 每日节点状态巡检"]').fill(`表单验收-${trigger}`);
    await modal.locator("select").first().selectOption(trigger);
    await modal.locator("textarea").fill("仅验证持久化表单，未来触发前由测试清理。");
    if (trigger === "cron") await modal.locator('input[placeholder="0 9 * * *"]').fill("0 0 1 1 *");
    if (trigger === "interval") await page.getByLabel("间隔（分钟）*").fill("120");
    if (trigger === "once") await page.getByLabel("执行时间（本地时区）*").fill("2099-01-01T09:00");
    const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/cluster/scheduled-tasks") && response.request().method() === "POST");
    await modal.getByRole("button", { name: "创建任务", exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 201, await response.text());
    const saved = await response.json();
    assert.equal(saved.triggerType, trigger);
    if (trigger === "interval") assert.equal(saved.intervalMs, 7200000);
    if (trigger === "once") assert.ok(saved.runAt > Date.now());
    assert.ok(saved.timezone);
    createdSchedules.push(saved.id);
    await modal.waitFor({ state: "detached" });
  }
  for (const id of createdSchedules) await coordinator.getStore().deleteScheduledTask?.(id);
  assert.deepEqual(errors, []);
  await page.close(); await browser.close();
  t.diagnostic(`视觉截图：${output}`);
});
