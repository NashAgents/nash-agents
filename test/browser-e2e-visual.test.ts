import { randomBytes } from "node:crypto";
import { before as configureAuth, after as restoreAuth } from "node:test";
const testPassword = randomBytes(24).toString("hex");
const previousPassword = process.env.DASHBOARD_PASS;
configureAuth(() => { process.env.DASHBOARD_PASS = testPassword; });
restoreAuth(() => { if (previousPassword === undefined) delete process.env.DASHBOARD_PASS; else process.env.DASHBOARD_PASS = previousPassword; });
delete process.env.DISPLAY;
/**
 * Browser E2E & Multi-Device Visual Verification Test
 * 真实无头 Chrome 浏览器渲染验证：
 * 1. 桌面端 (1440x900) 三栏工作台、登录、Chat 交互、右侧上下文
 * 2. 平板端 (820x1180) 双栏触控与自适应视口
 * 3. 移动端 (390x844) 单栏主视图、底部导航与阶段卡片
 * 4. TaskGraph DAG 与阶段视图切换
 * 5. 暗黑与明亮模式无缝切换
 */

import { test, describe, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { chromium, type Browser, type BrowserServer, type Page } from "playwright-core";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";

import { acquireBrowserLock, browserLockPath } from "./browser-lock.js";

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
const SCREENSHOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nash-web-visual-"));
const browserLock = browserLockPath;

describe("Nash Web: Browser E2E & Multi-Device Visual Tests", { skip: !CHROME_PATH ? "Chrome is not installed on this platform; visual coverage runs on Mac" : false }, () => {
  let coordinator: ClusterCoordinator;
  let coordinatorUrl: string;
  let browser: Browser;
  let browserServer: BrowserServer | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let ownsBrowserLock = false;

  async function newPage(options?: Parameters<Browser["newPage"]>[0]): Promise<Page> {
    const page = await browser.newPage(options);
    await page.addInitScript(() => {
      if (!localStorage.getItem("nash_theme")) localStorage.setItem("nash_theme", "dark");
    });
    await page.route("**/*", (route) => ["image", "media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue());
    return page;
  }

  before(async () => {
    // 启动本地全功能协调器服务，挂载 apps/web/dist
    coordinator = new ClusterCoordinator({
      ephemeral: true,
      listenHost: "127.0.0.1",
      listenPort: 0,
      adminApiKey: "test-admin-secret-key",
      webDistDir: path.join(process.cwd(), "apps", "web", "dist"),
    });

    mock.method(coordinator.getMainAgent(), "chat", async () => ({ assistantResponse: "浏览器测试回复", state: "completed" as const, durationMs: 0 }));
    const store = coordinator.getStore();
    // 预置三节点元数据
    await store.saveNode({
      nodeId: "node-example-cloud",
      name: "Tencent-Linux",
      role: "coordinator-worker",
      platform: "linux",
      arch: "x64",
      hostname: "example-cloud-linux",
      tokenHash: "dummy",
      status: "online",
      lastSeenAt: Date.now(),
      metadata: { sandboxBackend: "bubblewrap", capabilities: ["node", "git", "python", "mcp"] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await store.saveNode({
      nodeId: "node-example-mac",
      name: "MacBook-Air",
      role: "worker",
      platform: "darwin",
      arch: "arm64",
      hostname: "example-mac.local",
      tokenHash: "dummy",
      status: "online",
      lastSeenAt: Date.now(),
      metadata: { sandboxBackend: "seatbelt", capabilities: ["node", "git", "bash", "mcp"] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await store.saveNode({
      nodeId: "node-example-wsl",
      name: "WSL2-Linux",
      role: "worker",
      platform: "linux",
      arch: "x64",
      hostname: "FixtureHost",
      tokenHash: "dummy",
      status: "online",
      lastSeenAt: Date.now(),
      metadata: { sandboxBackend: "bubblewrap", capabilities: ["node", "python", "cuda"] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 预置一份产物用于测试
    const artService = coordinator.getArtifactService();
    if (artService) {
      await artService.publishArtifact({
        graphId: "graph-sample",
        producerTaskId: "task-sample",
        producerNodeId: "node-example-mac",
        name: "architecture_audit.json",
        contentType: "application/json",
        content: JSON.stringify({ phase: "Phase 5", status: "production_ready", testsPassed: true }, null, 2),
      });
    }

    const addr = await coordinator.start();
    coordinatorUrl = `http://127.0.0.1:${addr.port}`;

    await acquireBrowserLock();
    ownsBrowserLock = true;
  });

  beforeEach(async () => {
    browserServer = await chromium.launchServer({
      executablePath: CHROME_PATH,
      headless: true,
      args: BROWSER_ARGS,
    });
    watchdog = setTimeout(() => { browserServer?.process().kill("SIGKILL"); }, 30000);
    watchdog.unref();
    browser = await chromium.connect(browserServer.wsEndpoint());

  });

  afterEach(async () => {
    if (watchdog) clearTimeout(watchdog);
    try { if (browser) await browser.close(); }
    finally {
      try { await browserServer?.close(); }
      finally {
        const child = browserServer?.process();
        if (child && child.exitCode === null) child.kill("SIGKILL");
        browserServer = undefined;
      }
    }
  });

  after(async () => {
    if (ownsBrowserLock) fs.rmSync(browserLock, { recursive: true, force: true });
    fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
    await coordinator.stop();
  });

  test("1. Desktop 视图 (1440x900): 登录、进入工作台、发送任务并截图", async () => {
    const page = await newPage({ viewport: { width: 1440, height: 900 } });

    // 1. 打开首页，未登录重定向至 /login
    await page.goto(`${coordinatorUrl}/`);
    await page.waitForURL("**/login**");

    // 2. 填写标准管理员凭据
    await page.getByLabel("管理员账号", { exact: true }).fill("admin");
    await page.getByLabel("密码", { exact: true }).fill(testPassword);
    await page.click('button[type="submit"]');

    // 3. 验证登录成功进入主工作台
    await page.waitForURL(`${coordinatorUrl}/`);
    await page.waitForSelector("textarea");

    // 4. 输入任务并发送
    await page.fill("textarea", "检查之前开发的 Nash MCP 模块");
    await page.click('button:has-text("发送")');

    // 等待消息卡片出现
    await page.getByText("浏览器测试回复", { exact: true }).waitFor();

    // 截图保存桌面暗黑模式工作台
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-workspace-dark.png"),
      fullPage: false,
    });

    // 切换亮色模式并截图
    await page.click('button[title="亮色模式"]');
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-workspace-light.png"),
      fullPage: false,
    });

    await page.close();
  });

  test("2. Desktop 视图 (1440x900): 集群拓扑、产物预览与 TaskGraph", async () => {
    const page = await newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${coordinatorUrl}/`);
    await page.waitForURL("**/login**");
    await page.getByLabel("管理员账号", { exact: true }).fill("admin");
    await page.getByLabel("密码", { exact: true }).fill(testPassword);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${coordinatorUrl}/`);

    // 1. 进入集群拓扑页
    await page.goto(`${coordinatorUrl}/cluster`);
    await page.waitForSelector("h2");
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-cluster-dark.png"),
    });

    // 2. 进入分布式任务图页
    await page.goto(`${coordinatorUrl}/graphs`);
    await page.waitForTimeout(800);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-taskgraph-dark.png"),
    });

    // 3. 进入交付产物页
    await page.goto(`${coordinatorUrl}/artifacts`);
    await page.waitForTimeout(600);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "desktop-artifacts-dark.png"),
    });

    await page.close();
  });

  test("3. Tablet 视图 (820x1180 iPad Air): 自适应双栏与工作台", async () => {
    const page = await newPage({ viewport: { width: 820, height: 1180 } });
    await page.goto(`${coordinatorUrl}/login`);
    await page.getByLabel("管理员账号", { exact: true }).fill("admin");
    await page.getByLabel("密码", { exact: true }).fill(testPassword);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${coordinatorUrl}/`);

    await page.waitForSelector("textarea");
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "tablet-workspace.png"),
    });

    await page.close();
  });

  test("4. Mobile 视图 (390x844 iPhone 14): 单栏主视图、阶段卡片与底部导航", async () => {
    const page = await newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${coordinatorUrl}/login`);
    await page.getByLabel("管理员账号", { exact: true }).fill("admin");
    await page.getByLabel("密码", { exact: true }).fill(testPassword);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${coordinatorUrl}/`);

    await page.waitForSelector("textarea");
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-workspace.png"),
    });

    // 切换到任务图移动端阶段视图
    await page.goto(`${coordinatorUrl}/graphs`);
    await page.waitForTimeout(600);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "mobile-taskgraph-stage.png"),
    });

    await page.close();
  });
  test("5. 默认输入为空，联邦记忆页面直接展示已沉淀条目", async () => {
    const store = coordinator.getStore();
    await store.upsertMemoryIndex([{ entryId: "browser-memory", nodeId: "node-example-cloud", projectId: "rag", topic: "RAG 知识库", summary: "Persisted discovery memory", keywords: ["rag", "知识库"], sourceReference: "README.md", visibility: "retrievable", confidence: 0.9, revision: 1, updatedAt: Date.now() }]);
    const page = await newPage();
    try {
      await page.goto(`${coordinatorUrl}/login`);
      assert.equal(await page.locator('input[type="text"]').inputValue(), "");
      assert.equal(await page.locator('input[type="password"]').inputValue(), "");
      await page.getByLabel("管理员账号", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill(testPassword);
      await page.click('button[type="submit"]');
      await page.waitForURL(`${coordinatorUrl}/`);
      await page.goto(`${coordinatorUrl}/memory`);
      await page.waitForSelector('text=RAG 知识库');
      assert.equal(await page.getByLabel("搜索项目知识", { exact: true }).inputValue(), "");
    } finally { await page.close(); await store.deleteMemoryIndex("node-example-cloud", ["browser-memory"]); }
  });

  test("6. 工作台取消后台任务图后收起执行条，刷新也不恢复分析中", async (t) => {
    const store = coordinator.getStore();
    const graph = await coordinator.getGraphOrchestrator().createGraph({ parentGoal: "取消状态浏览器回归", reasoning: "取消回归", requiresMultiAgent: true, nodes: [
      { nodeId: "pending", title: "尚未派发", goal: "无需执行", dependencies: [] },
    ] });
    await store.updateGraphStatus?.(graph.graphId, "running");
    const orchestrator = coordinator.getGraphOrchestrator();
    const advance = orchestrator.advanceGraph.bind(orchestrator);
    t.mock.method(orchestrator, "advanceGraph", async (id: string) => { if (id !== graph.graphId) await advance(id); });
    const convId = "browser-cancellation";
    const now = Date.now();
    await store.saveConversation?.({ id: convId, title: "取消状态浏览器回归", createdAt: now, updatedAt: now,
      linkedTaskIds: [], linkedGraphIds: [graph.graphId], messages: [
        { id: "cancel-user", conversationId: convId, sender: "user", content: "取消状态浏览器回归", messageType: "text", timestamp: now },
      ] });
    const page = await newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${coordinatorUrl}/login`);
      await page.getByLabel("管理员账号", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill(testPassword);
      await page.click('button[type="submit"]');
      await page.waitForURL(`${coordinatorUrl}/`);
      await page.getByText("Nash Agent 正在协同执行中...", { exact: true }).waitFor({ timeout: 5000 }).catch(async (error) => { throw new Error(`${error}\n${await page.locator("body").innerText()}`); });
      // 后台图运行不能让发送按钮显示模型请求中的加载动画。
      assert.equal(await page.locator('button:has-text("发送") .animate-spin').count(), 0);
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "取消任务", exact: true }).click();
      const confirmBtn = page.getByRole("button", { name: "确定", exact: true });
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click();
      }
      await page.getByText("Nash Agent 正在协同执行中...", { exact: true }).waitFor({ state: "hidden" });
      assert.equal((await store.getGraph?.(graph.graphId))?.status, "cancelled");
      const restored = page.waitForResponse((response) => response.url().endsWith(`/conversations/${convId}`) && response.status() === 200);
      await page.reload(); await restored;
      await page.locator("textarea").waitFor();
      assert.equal(await page.getByRole("button", { name: "取消任务", exact: true }).count(), 0);
      assert.equal(await page.getByText("正在分析用户意图并统筹集群资源...", { exact: true }).count(), 0);
    } finally {
      await page.close();
      await store.deleteConversation?.(convId);
    }
  });

  test("7. 会话产物隔离、系统生成时间与图内审批一致呈现", async () => {
    const page = await newPage({ viewport: { width: 1600, height: 1000 } });
    const now = Date.now();
    const conversation = { id: "browser-isolation", title: "当前会话隔离验证", createdAt: now, updatedAt: now, linkedTaskIds: [], linkedGraphIds: ["graph-current"],
      messages: [{ id: "user", conversationId: "browser-isolation", sender: "user", content: "当前会话隔离验证", timestamp: now }] };
    const artifact = { artifactId: "current-report", graphId: "graph-current", name: "本轮报告.txt", createdAt: now, producerNodeId: "worker", sha256: "verified", sizeBytes: 10 };
    const approval = { approvalId: "browser-approval", taskId: "task-current", nodeId: "worker", reason: "需要读取授权资源", target: "/approved-resource", toolName: "read_file", status: "pending", expiresAt: now + 60000 };
    try {
      await page.route("**/api/cluster/conversations**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        await route.fulfill({ json: pathname.endsWith("/conversations") ? { conversations: [conversation] } : {
          conversation, isRunning: true, activeTurn: null, activeGraphs: [{ graphId: "graph-current", status: "running" }],
          activeTasks: [{ taskId: "task-current", nodeId: "worker", status: "waiting_approval", dispatchOptions: { graphContext: { graphId: "graph-current" } } }],
        } });
      });
      await page.route("**/api/cluster/artifacts**", async (route) => {
        const url = new URL(route.request().url());
        await route.fulfill({ json: url.pathname.endsWith("/content") ? { content: "正文模型日期：2026-04-18" } : {
          artifacts: url.searchParams.get("graphId") === "graph-current" ? [artifact] : [{ ...artifact, artifactId: "old", graphId: "graph-old", name: "上轮旧报告.txt" }],
        } });
      });
      await page.route("**/api/cluster/approvals", (route) => route.fulfill({ json: { approvals: [approval], history: [] } }));
      await page.route("**/api/cluster/graphs/graph-current", (route) => route.fulfill({ json: {
        graph: { graphId: "graph-current", status: "running", parentGoal: "当前图验证" }, snapshot: { pendingApprovalsCount: 1 }, edges: [], revisions: [],
        nodes: [{ graphId: "graph-current", nodeId: "branch", taskId: "task-current", title: "等待审批的分支", status: "waiting_approval", producedArtifacts: [] }],
      } }));
      await page.goto(`${coordinatorUrl}/login`);
      await page.getByLabel("管理员账号", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill(testPassword);
      await page.click('button[type="submit"]'); await page.waitForURL(`${coordinatorUrl}/`);
      await page.getByText("等待审批 · read_file · worker", { exact: true }).waitFor();
      await page.getByRole("tab", { name: "产物仓库", exact: true }).click();
      await page.getByText("本轮报告.txt", { exact: true }).waitFor();
      assert.equal(await page.getByText("上轮旧报告.txt", { exact: true }).count(), 0);
      await page.getByText("本轮报告.txt", { exact: true }).click();
      await page.getByText(/系统记录的生成时间/).waitFor();
      await page.getByText("正文模型日期：2026-04-18", { exact: true }).waitFor();
      await page.getByText("正文由模型生成，正文中的日期不作为系统时间记录。", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: "审批中心", exact: true }).click();
      await page.getByText("请求权限审批", { exact: true }).waitFor();
      // 不放行审批，直接新建草稿验证旧产物清空。
      await page.getByRole("button", { name: /发起新任务/ }).click();
      await page.getByRole("tab", { name: "产物仓库", exact: true }).click();
      await page.getByText("暂无生成产物", { exact: true }).waitFor();
      assert.equal(await page.getByText("本轮报告.txt", { exact: true }).count(), 0);
    } finally { await page.close(); }
  });

  test("8. 联邦记忆按项目浏览、解释问题记录、搜索与手机布局", async () => {
    const page = await newPage({ viewport: { width: 1440, height: 1000 } });
    const shared = "[architecture] 文章阅读器支持逐句播放与字幕高亮";
    const entries = [
      { entryId: "srt", nodeId: "node-example-mac", projectId: "proj-srt", topic: "srt-project · audio-sync", summary: shared, confidence: 0.9, sourceReference: "mem-srt", updatedAt: Date.parse("2026-10-20T18:00:00Z") },
      { entryId: "duplicate", nodeId: "node-example-mac", projectId: "proj-nash", topic: "nash-agent · audio-sync", summary: shared, confidence: 0.9 },
      { entryId: "question", nodeId: "node-example-mac", projectId: "proj-nash", topic: "nash-agent · persona", summary: "[preference] 叫我什么", confidence: 0.9, sourceReference: "mem-persona" },
      { entryId: "mem-disc-project", nodeId: "node-example-cloud", projectId: "proj-nash", topic: "Discovery: nash-agent", summary: "项目能力探查摘要", confidence: 0.85 },
    ];
    let fail = false;
    try {
      await page.route("**/api/cluster/memory/index", (route) => route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: "记忆服务暂不可用" } : { entries } }));
      await page.route("**/api/cluster/memory/search", (route) => route.fulfill({ json: { results: [{ ...entries[0], score: 0.72 }] } }));
      await page.goto(`${coordinatorUrl}/login`);
      await page.getByLabel("管理员账号", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill(testPassword);
      await page.click('button[type="submit"]'); await page.waitForURL(`${coordinatorUrl}/`);
      await page.getByRole("button", { name: "集群资源", exact: true }).click();
      await page.getByRole("link", { name: "联邦记忆", exact: true }).click();
      await page.getByText("共 4 条摘要 · 2 个项目 · 2 个节点", { exact: true }).waitFor();
      assert.equal(await page.getByTestId("memory-card").count(), 4);
      assert.equal(await page.getByText(/90%|Score:/).count(), 0);
      assert.equal(await page.getByText("另有 1 条相同内容", { exact: true }).count(), 2);
      await page.getByRole("button", { name: /^待核对/ }).click();
      assert.equal(await page.getByTestId("memory-card").count(), 1);
      await page.getByText("只保存了一个问题，没有记录具体称谓，无法作为用户偏好使用。", { exact: true }).waitFor();
      await page.getByText("用途与来源", { exact: true }).click();
      await page.getByText("用途尚不明确，需要结合原始来源核对。", { exact: true }).waitFor();
      await page.getByText("mem-persona", { exact: true }).waitFor();
      await page.getByRole("button", { name: "清除筛选", exact: true }).click();
      await page.getByLabel("项目", { exact: true }).selectOption("proj-srt");
      assert.equal(await page.getByTestId("memory-card").count(), 1);
      await page.getByRole("button", { name: "清除筛选", exact: true }).click();
      await page.getByLabel("搜索项目知识", { exact: true }).fill("音频同步");
      await page.getByRole("button", { name: "搜索记忆", exact: true }).click();
      await page.getByText("相关性 72/100", { exact: true }).waitFor();
      await page.getByText(/不代表内容正确率/).waitFor();
      await page.getByRole("button", { name: "返回全部记忆", exact: true }).click();
      await page.getByText("共 4 条摘要 · 2 个项目 · 2 个节点", { exact: true }).waitFor();
      assert.equal(await page.getByText(/相关性 72/).count(), 0);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("heading", { name: "联邦记忆", exact: true }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "手机页面不应横向溢出");
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "memory-mobile.png"), fullPage: true });
      fail = true; await page.getByRole("button", { name: "刷新", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "记忆加载失败" }).waitFor();
      assert.equal(await page.getByText("暂无共享记忆", { exact: true }).count(), 0);
      fail = false; await page.getByRole("button", { name: "重试", exact: true }).click();
      await page.getByText("共 4 条摘要 · 2 个项目 · 2 个节点", { exact: true }).waitFor();
    } finally { await page.close(); }
  });

  test("9. 亮色报告表格保持浅底与清晰对比，暗色切换及手机滚动正常", async () => {
    const page = await newPage({ viewport: { width: 1440, height: 1000 } });
    const now = Date.now();
    const report = ["### 核心环境详细对比", "", "| 维度 | macOS 节点 | 腾讯云 Linux 节点 | 差异与影响 |", "| --- | --- | --- | --- |", "| 主机名 | `example-mac.local` | `example-cloud-linux` | 本地开发机与云端常驻节点 |", "| 操作系统 | macOS 26.0.1 | Ubuntu 24.04.4 LTS | 平台与编译目标不同 |", "| CPU 架构 | Apple M2 | Intel Xeon Platinum 8255C | 异构协作 |", "", "> 仅依据本次探查结果。", "", "```json", '{"status":"completed"}', "```"].join("\n");
    const conversation = { id: "browser-light-report", title: "报告主题验证", linkedTaskIds: [], linkedGraphIds: [], createdAt: now, updatedAt: now, messages: [
      { id: "user", conversationId: "browser-light-report", sender: "user", content: "查看环境对比报告", timestamp: now },
      { id: "assistant", conversationId: "browser-light-report", sender: "assistant", content: report, timestamp: now },
    ] };
    try {
      await page.route("**/api/cluster/conversations**", (route) => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/conversations") ? { conversations: [conversation] } : { conversation, isRunning: false, activeTurn: null, activeTasks: [], activeGraphs: [] } }));
      await page.goto(`${coordinatorUrl}/login`);
      await page.getByLabel("管理员账号", { exact: true }).fill("admin"); await page.getByLabel("密码", { exact: true }).fill(testPassword);
      await page.click('button[type="submit"]'); await page.waitForURL(`${coordinatorUrl}/`);
      await page.getByRole("heading", { name: "核心环境详细对比", exact: true }).waitFor();
      await page.getByRole("button", { name: "亮色模式", exact: true }).click();
      const reportBody = page.locator(".nash-markdown").filter({ has: page.getByRole("heading", { name: "核心环境详细对比", exact: true }) });
      const appearance = await reportBody.evaluate((element) => {
        const th = getComputedStyle(element.querySelector("th")!);
        const stripe = getComputedStyle(element.querySelector("tbody tr:nth-child(2)")!);
        const code = getComputedStyle(element.querySelector("td code")!);
        return { header: th.backgroundColor, text: th.color, stripe: stripe.backgroundColor, code: code.backgroundColor, light: document.documentElement.classList.contains("light") };
      });
      const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const luminance = (value: string) => rgb(value).map(v => v/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((sum, v, i) => sum+v*[.2126,.7152,.0722][i]!, 0);
      assert.equal(appearance.light, true);
      assert.ok(rgb(appearance.header).every(v => v > 230));
      assert.ok(rgb(appearance.stripe).every(v => v > 240));
      assert.ok(rgb(appearance.code).every(v => v > 240));
      assert.ok((luminance(appearance.header)+.05)/(luminance(appearance.text)+.05) >= 7, "表头文字对比度至少7:1");
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "report-light.png"), fullPage: true });
      await page.getByRole("button", { name: "暗色模式", exact: true }).click();
      const dark = await page.locator(".nash-markdown th").first().evaluate(element => getComputedStyle(element).backgroundColor);
      assert.equal(dark, "rgba(39, 39, 42, 0.7)");
      await page.getByRole("button", { name: "亮色模式", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("region", { name: "数据表格", exact: true }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "表格只在自身滚动，不撑破手机页面");
      assert.equal(await page.getByRole("table").count(), 1);
    } finally { await page.close(); }
  });

  test("10. Scout 派发后会话即时显示任务，刷新恢复阶段，汇总回复实时出现", async (t) => {
    const page = await newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store = coordinator.getStore();
    const simulatedNodes = ["node-example-cloud", "node-example-wsl", "node-example-mac"];
    const registry = coordinator.getRegistry();
    const originalConnection = registry.getConnection.bind(registry);
    // The supervisor requires a live connection, not only an online catalog record.
    t.mock.method(registry, "getConnection", (nodeId: string) => simulatedNodes.includes(nodeId)
      ? { nodeId, generation: 1, lastHeartbeatAt: Date.now(), ws: { readyState: 1, send() {} }, metadata: { name: nodeId } } as any
      : originalConnection(nodeId));
    t.mock.method(coordinator.getMainAgent(), "chat", async (_id: string, _input: string, options: any) => {
      for (const [index, nodeId] of simulatedNodes.entries()) {
        // These are simulated Workers; refresh their heartbeat for this delayed run.
        const node = (await store.getNode(nodeId))!;
        await store.saveNode({ ...node, status: "online", lastSeenAt: Date.now() });
        const taskId = `browser-scout-${index}-progress`;
        await store.saveTask({ taskId, nodeId, projectId: "proj-nash-agent", goal: `浏览器探查任务 ${index}`, status: index === 0 ? "completed" : "running",
          dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now(), dispatchOptions: { contextOverrides: { isDiscovery: true } } });
        await options.onScoutTaskDispatched?.(taskId, {});
      }
      options.onProgress?.({ phase: "discovering", detail: "正在并行探查项目证据", timestamp: Date.now() });
      await gate;
      for (const index of [0, 1, 2]) await store.updateTaskStatus(`browser-scout-${index}-progress`, "completed", { finalAnswer: "底层探查结果" });
      return { assistantResponse: "节点证据已核对，探查汇总报告已完成。", state: "completed" as const, durationMs: 1 };
    });
    try {
      await page.goto(`${coordinatorUrl}/login`);
      await page.getByLabel("管理员账号", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill(testPassword);
      await page.click('button[type="submit"]'); await page.waitForURL(`${coordinatorUrl}/`);
      await page.getByRole("button", { name: "发起新任务", exact: true }).click();
      await page.locator("textarea").fill("浏览器探查进度回归"); await page.locator("textarea").press("Enter");
      await page.getByText("正在并行探查项目证据", { exact: true }).waitFor({ timeout: 10000 });
      const monitor = page.getByRole("region", { name: "会话任务监控", exact: true });
      await monitor.getByRole("heading", { name: "多节点探查监控", exact: true }).waitFor();
      assert.equal(await monitor.getByRole("region", { name: /^节点 / }).count(), 3);
      assert.equal(await monitor.getByRole("link", { name: /^查看任务 / }).count(), 3);
      await page.reload();
      await page.getByText("正在并行探查项目证据", { exact: true }).waitFor();
      assert.ok(await page.getByRole("link", { name: /任务:.*progress/ }).count());
      release();
      await page.getByText("节点证据已核对，探查汇总报告已完成。", { exact: true }).waitFor();
      assert.equal(await page.getByText("节点证据已核对，探查汇总报告已完成。", { exact: true }).count(), 1);
      assert.equal(await page.getByText("正在并行探查项目证据", { exact: true }).count(), 0);
      await monitor.getByText("已完成 3/3", { exact: true }).waitFor();
      await page.reload();
      await monitor.getByRole("heading", { name: "多节点探查监控", exact: true }).waitFor();
      assert.equal(await monitor.getByRole("region", { name: /^节点 / }).count(), 3);
      await page.getByRole("button", { name: "发起新任务", exact: true }).click();
      assert.equal(await monitor.count(), 0);
    } catch (error) {
      t.diagnostic(JSON.stringify({ pageErrors, text: await page.locator('body').innerText().catch(() => '') }));
      throw error;
    } finally { release(); await page.close(); }
  });

  test("11. 任务详情同组件切换、审批中取消与 Markdown 安全渲染", async () => {
    const store = coordinator.getStore(); const now = Date.now();
    for (const [taskId, goal, status, finalAnswer] of [
      ["audit-detail-a", "Detail A", "completed", "## Report A\n\n| Name | Value |\n|---|---|\n| A | 1 |\n<script>window.__auditXss = true</script>"],
      ["audit-detail-b", "Detail B", "waiting_approval", ""],
    ]) await store.saveTask({ taskId: taskId!, runId: taskId!, nodeId: "worker", projectId: "p", goal: goal!, status: status as any,
      finalAnswer, dispatchAttempt: 1, createdAt: now, updatedAt: now });
    const page = await newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${coordinatorUrl}/login`);
      await page.getByLabel("管理员账号", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill(testPassword);
      await page.click('button[type="submit"]');
      await page.waitForURL(`${coordinatorUrl}/`);
      await page.goto(`${coordinatorUrl}/tasks/audit-detail-a`);
      await page.getByRole("heading", { name: "Report A" }).waitFor();
      assert.equal(await page.locator(".nash-table-scroll table").count(), 1);
      assert.equal(await page.evaluate(() => (window as any).__auditXss), undefined);
      await page.evaluate(() => { window.history.pushState({}, "", "/tasks/audit-detail-b"); window.dispatchEvent(new PopStateEvent("popstate")); });
      await page.getByRole("heading", { name: "Detail B" }).waitFor();
      assert.equal(await page.getByRole("heading", { name: "Report A" }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "取消任务", exact: true }).count(), 1);
      await page.evaluate(() => { window.history.pushState({}, "", "/tasks/audit-detail-missing"); window.dispatchEvent(new PopStateEvent("popstate")); });
      await page.getByRole("alert").waitFor();
      assert.equal(await page.getByRole("heading", { name: "Detail B" }).count(), 0);
    } finally { await page.close(); }
  });

  test("12. 定时任务 (Scheduled Tasks) 页面渲染、统计概览与执行历史交互", async () => {
    const store = coordinator.getStore();
    await store.saveScheduledTask!({
      id: "sched-test-01",
      name: "每日巡检腾讯云",
      description: "每天上午 09:00 巡检腾讯云服务与内存状态",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      targetType: "single_task",
      taskConfig: {
        goal: "检查腾讯云服务器内存与负载",
        nodeId: "node-example-cloud",
      },
      enabled: true,
      concurrencyPolicy: "SKIP_IF_RUNNING",
      misfirePolicy: "RUN_ONCE_IMMEDIATELY",
      maxConcurrency: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nextRunAt: Date.now() + 3600000,
      runCount: 1,
      lastRunAt: Date.now() - 3600000,
      lastRunStatus: "completed",
      createdBy: "admin",
    });

    const page = await newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${coordinatorUrl}/login`);
      await page.getByLabel("管理员账号", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill(testPassword);
      await page.click('button[type="submit"]');
      await page.waitForURL(`${coordinatorUrl}/`);

      // 导航到 /schedules
      await page.goto(`${coordinatorUrl}/schedules`);
      await page.waitForSelector("h2");
      assert.ok(await page.getByText("每日巡检腾讯云").isVisible());
      assert.ok(await page.getByText("0 9 * * *").isVisible());
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "scheduled-tasks-desktop.png"), fullPage: true });
    } finally {
      await page.close();
    }
  });

  test("13. 安全审查历史 (Security Audit) 页面决策过滤与脱敏呈现", async () => {
    const secStore = coordinator.getStore();
    await secStore.saveSecurityAudit!({
      id: "sec-test-01",
      timestamp: Date.now(),
      taskId: "task-dangerous-fork",
      runId: "run-fork",
      agentId: "worker-agent",
      nodeId: "node-example-mac",
      projectId: "nash-agent",
      toolName: "bash",
      argsFingerprint: "sha256-test-fingerprint",
      sanitizedArgs: { command: "rm -rf /" },
      rawArgsSnippet: "rm -rf / --no-preserve-root",
      decisionSource: "DETERMINISTIC_POLICY",
      verdict: "BLOCK",
      riskCategory: "Destructive File System",
      severity: 99,
      ruleName: "HardBlockRules.DANGEROUS_FS_PATTERNS",
      reason: "确定性硬性拦截：试图破坏根文件系统",
      isHardBlock: true,
      reviewFeedback: { status: "unreviewed" },
      createdAt: Date.now(),
      durationMs: 1,
    });

    const page = await newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${coordinatorUrl}/login`);
      await page.getByLabel("管理员账号", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill(testPassword);
      await page.click('button[type="submit"]');
      await page.waitForURL(`${coordinatorUrl}/`);

      // 导航到 /security/audit
      await page.goto(`${coordinatorUrl}/security/audit`);
      await page.waitForSelector("h2");
      assert.ok(await page.getByText("Destructive File System").isVisible());
      assert.ok(await page.getByText("BLOCK").first().isVisible());
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "security-audit-desktop.png"), fullPage: true });
    } finally {
      await page.close();
    }
  });

  test("14. Project Explorer 紧凑网格/列表切换、项目详情与上下文发起任务", async () => {
    const store = coordinator.getStore();
    // 预置两个项目条目
    await store.upsertProjectCatalog([
      {
        projectId: "nash-agent",
        nodeId: "node-example-mac",
        name: "Nash Agent",
        summary: "TypeScript AI Agent Harness",
        description: "基于 原生 OS 沙箱的安全 AI Agent 环境",
        technologies: ["TypeScript", "Node.js", "Agent"],
        capabilities: ["sandbox", "mcp"],
        status: "active",
        registeredAt: Date.now() - 3600000,
        updatedAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision: 1,
        visibility: "retrievable",
        canonicalPath: "/Users/test/Documents/project/nash-agents",
      },
      {
        projectId: "srt-project",
        nodeId: "node-example-wsl",
        name: "SRT Transcode",
        summary: "离线字幕同步与阅读项目",
        description: "跨平台多媒体音视频字幕转码提取",
        technologies: ["Python", "FastAPI"],
        capabilities: ["transcode"],
        status: "active",
        registeredAt: Date.now() - 7200000,
        updatedAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision: 1,
        visibility: "summary",
        canonicalPath: "/mnt/d/projects/srt",
      },
    ]);

    const page = await newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${coordinatorUrl}/login`);
      await page.getByLabel("管理员账号", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill(testPassword);
      await page.click('button[type="submit"]');
      await page.waitForURL(`${coordinatorUrl}/`);

      // 导航到 /projects
      await page.goto(`${coordinatorUrl}/projects`);
      await page.waitForSelector("h2");
      assert.ok(await page.getByText("Nash Agent").isVisible());
      assert.ok(await page.getByText("SRT Transcode").isVisible());

      // 验证网格到列表模式切换
      await page.click('button[title="列表视图"]');
      await page.waitForTimeout(100);
      assert.ok(await page.getByText("Nash Agent").isVisible());

      // 截图保存 Project Explorer 列表模式
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "projects-list-desktop.png"), fullPage: true });

      // 进入项目详情页
      await page.goto(`${coordinatorUrl}/projects/nash-agent`);
      await page.waitForSelector("h2");
      assert.ok(await page.getByText("项目简介与架构").isVisible());
      assert.ok(await page.getByText("所在物理节点").isVisible());
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "project-detail-desktop.png"), fullPage: true });

      // 点击发起任务并验证 Workspace 携带上下文徽标
      await page.click('button:has-text("在此项目发起任务")');
      await page.waitForURL(`${coordinatorUrl}/`);
      assert.ok(await page.getByText("目标上下文：Nash Agent").isVisible());
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "workspace-project-context.png"), fullPage: true });
    } finally {
      await page.close();
    }
  });

});
