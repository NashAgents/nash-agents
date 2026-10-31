delete process.env.DISPLAY;
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { chromium, type BrowserServer } from "playwright-core";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { GraphReplanner } from "../src/cluster/graph/graph-replanner.js";
import { defaultTraceContext } from "../src/observability/trace-context.js";
import { acquireBrowserLock, browserLockPath } from "./browser-lock.js";

const chrome = process.env.NASH_CHROME_PATH ?? process.env.CHROME_BIN ?? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
  "/usr/bin/chromium-browser", "/opt/google/chrome/chrome",
].find(file => fs.existsSync(file));

test("SIMULATED_INTEGRATION: graph recovery and background Scout appear under one GoalRun and survive reload", { timeout: 45000, skip: !chrome }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nash-goal-browser-"));
  const previousPassword = process.env.DASHBOARD_PASS;
  const password = randomBytes(24).toString("hex");
  process.env.DASHBOARD_PASS = password;
  const coordinator = new ClusterCoordinator({ ephemeral: true, listenHost: "127.0.0.1", listenPort: 0, adminApiKey: randomBytes(24).toString("hex"), webDistDir: path.join(process.cwd(), "apps/web/dist") });
  let server: BrowserServer | undefined, watchdog: NodeJS.Timeout | undefined, ownsLock = false;
  t.after(async () => {
    clearTimeout(watchdog);
    try { await server?.close(); } finally {
      if (server?.process().exitCode === null) server.process().kill("SIGKILL");
      if (ownsLock) fs.rmSync(browserLockPath, { recursive: true, force: true });
      await coordinator.stop(); fs.rmSync(temp, { recursive: true, force: true });
      if (previousPassword === undefined) delete process.env.DASHBOARD_PASS; else process.env.DASHBOARD_PASS = previousPassword;
    }
  });
  const started = await coordinator.start(), origin = `http://127.0.0.1:${started.port}`;
  const store = coordinator.getStore();
  let graphId = "", goalId = "";
  (coordinator as any).mainAgent.chat = async (conversationId: string, _text: string, options: any) => {
    goalId = options.goalRunId;
    // A real turn runs inside its fenced trace; the fixture must do the same or the store
    // (correctly) refuses to mutate a GoalRun that has a live lease owned by another turn.
    return defaultTraceContext.run({ projectId: "p", sessionId: conversationId, traceId: "trace-browser", goalRunId: goalId, goalTurnFence: options.goalTurnFence }, async () => {
    const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: {} as any });
    const graph = await orchestrator.createGraph({ parentGoal: "后台探查验收目标", reasoning: "fixture", requiresMultiAgent: true, nodes: [
      { nodeId: "node1", title: "失败节点", goal: "inspect", dependencies: [], producedArtifacts: [{ name: "report.md", contentType: "text/markdown" }] },
      { nodeId: "join", title: "汇总节点", goal: "join", dependencies: ["node1"], requiredArtifacts: [{ name: "report.md", producerNodeId: "node1" }] },
    ] });
    graphId = graph.graphId;
    const graphContext = { graphId, graphNodeId: "node1", inputs: [], outputs: [] };
    const base = { nodeId: "node-browser", projectId: "p", goal: "inspect", dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now() };
    await store.saveTaskWithGoal!({ ...base, taskId: "task-first", status: "failed", error: "模拟首次失败", dispatchOptions: { graphContext: { ...graphContext, executionAttempt: 1 } } }, goalId);
    const node = (await store.getGraphNode!(graphId, "node1"))!;
    await store.saveGraphNode!({ ...node, status: "failed", taskId: "task-first", assignedNodeId: "node-browser", error: "模拟首次失败" });
    await store.updateGraphStatus!(graphId, "failed");
    orchestrator.advanceGraph = async () => {};
    let proposals = 0;
    const replanner = new GraphReplanner(store, orchestrator, { chat: async () => ({ content: JSON.stringify(++proposals === 1
      ? { reason: "invalid", rewireDependencies: [{ nodeId: "join", removeDependencies: ["node1"] }] }
      : { reason: "恢复节点", retryNodeIds: ["node1"] }) }) } as any);
    assert.equal((await replanner.replanWithLlm({ graphId, trigger: "task_failed", failedNodeId: "node1" })).success, true);
    assert.equal(proposals, 2);
    await store.saveTaskWithGoal!({ ...base, createdAt: Date.now() + 1, taskId: "task-second", status: "completed", dispatchOptions: { graphContext: { ...graphContext, executionAttempt: 2, retryOfTaskId: "task-first" } } }, goalId);
    await store.saveGraphNode!({ ...node, status: "completed", taskId: "task-second", assignedNodeId: "node-browser", attemptCount: 2 });
    await store.updateGraphStatus!(graphId, "partially_completed");
    await store.saveTaskWithGoal!({ taskId: "task-browser", runId: "run-browser", nodeId: "node-browser", projectId: "p", goal: "scout", status: "running", dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now(), dispatchOptions: { contextOverrides: { goalRunId: goalId, taskType: "scout" } } }, goalId, options.goalTurnFence);
    await options.onScoutTaskDispatched("task-browser");
    return { assistantResponse: "探查仍在运行", state: "task_dispatched", createdGraphId: graphId, durationMs: 1 };
    });
  };
  await acquireBrowserLock(); ownsLock = true;
  // Linux Chrome aborts on launch with --single-process/--no-zygote; the other browser suites
  // use the same guard, so keep the arg set identical across them.
  const browserArgs = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--renderer-process-limit=1", "--disable-extensions", "--disable-component-update", ...(process.platform === "linux" ? [] : ["--single-process", "--no-zygote"])];
  server = await chromium.launchServer({ executablePath: chrome, headless: true, args: browserArgs });
  watchdog = setTimeout(() => server?.process().kill("SIGKILL"), 30000);
  const browser = await chromium.connect(server.wsEndpoint());
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  await page.route("**/*", route => ["image", "media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue());
  await page.goto(`${origin}/login`);
  await page.getByLabel("管理员账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`${origin}/`);
  await page.locator("textarea").fill("后台探查验收目标");
  await page.getByRole("button", { name: /发送/ }).click();
  await page.getByText("阶段性报告", { exact: true }).waitFor();
  assert.ok(goalId && graphId);
  await page.goto(`${origin}/tasks`);
  const goal = page.locator("details").filter({ hasText: "后台探查验收目标" });
  await goal.locator(":scope > summary").click();
  await goal.getByText("探查仍在运行", { exact: false }).waitFor();
  assert.equal(await goal.getByText("最终报告：", { exact: false }).count(), 0);
  await goal.getByRole("link", { name: `任务图 ${graphId}` }).click();
  await page.getByRole("button", { name: /时间线与版本/ }).click();
  await page.getByText("graph.replan_rejected", { exact: false }).waitFor();
  const nodeHistory = page.locator("details").filter({ hasText: "失败节点" });
  await nodeHistory.getByText("恢复成功", { exact: false }).waitFor();
  await nodeHistory.locator("summary").click();
  await nodeHistory.getByText("模拟首次失败", { exact: false }).waitFor();
  await nodeHistory.getByText("执行 2 · completed", { exact: false }).waitFor();
  await page.goto(`${origin}/tasks`);
  await page.locator("details").filter({ hasText: "后台探查验收目标" }).locator(":scope > summary").click();
  await store.updateTaskStatus("task-browser", "completed");
  await goal.locator("p").filter({ hasText: "最终报告：部分结果：执行已结束" }).waitFor({ timeout: 12000 });
  const saved = await store.getGoalRun!(goalId);
  assert.equal(saved?.reportRevision, 2);
  await page.reload();
  await page.locator("details").filter({ hasText: "后台探查验收目标" }).locator(":scope > summary").click();
  const restoredGoal = page.locator("details").filter({ hasText: "后台探查验收目标" }).first();
  await restoredGoal.locator("p").filter({ hasText: "最终报告：部分结果：执行已结束" }).waitFor();
  const history = restoredGoal.locator("details").filter({ hasText: "报告版本与证据来源" });
  await history.locator(":scope > summary").click();
  await history.getByText("版本 2", { exact: false }).waitFor();
  await history.getByText("执行任务：", { exact: false }).waitFor();
  assert.equal((await store.getGoalRun!(goalId))?.reportRevision, 2);
});
