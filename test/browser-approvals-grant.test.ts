import { randomBytes } from "node:crypto";
const testPassword = randomBytes(24).toString("hex");
const previousUser = process.env.DASHBOARD_USER;
const previousPassword = process.env.DASHBOARD_PASS;
process.env.DASHBOARD_USER = "admin";
process.env.DASHBOARD_PASS = testPassword;
delete process.env.DISPLAY;

/**
 * 浏览器点击级验收：审批页「仅此任务启用全访问」按钮。
 *
 * 覆盖：
 *  1. 管理员可见按钮 → 打开风险确认弹窗 → 未勾选知情确认时禁止提交；
 *  2. 真实后端失败路径（节点离线）在弹窗中原样显示错误，绝不假装成功；
 *  3. 非管理员看不到可点击的授权入口，只看到权限说明；
 *  4. 移动端 390x844 下按钮与弹窗可用；
 *  5. UI_STATE_ONLY：拦截授权 API 返回成功时，列表转为历史「全访问 · 安全模型审查」。
 *
 * 真实授权成功（Worker ACK）权限语义由 test/cluster-task-grant-e2e.test.ts 以真实
 * Coordinator + Worker + OS 沙箱证明；本文件只验证点击级交互与展示一致性。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";
import { WorkerRuntime } from "../src/cluster/worker/worker-runtime.js";
import { acquireBrowserLock, browserLockPath } from "./browser-lock.js";

const CHROME_PATH = process.env.NASH_CHROME_PATH ?? process.env.CHROME_BIN ?? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
].find((candidate) => fs.existsSync(candidate)) ?? "";
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
const THREE_TARGET_BUTTON = /仅此任务启用全访问/;
const CONFIRM_BUTTON = /确认仅此任务启用全访问/;

describe(
  "Nash Web approvals: third-button click-level acceptance",
  { skip: !CHROME_PATH ? "Chrome is not installed on this platform; approvals click coverage runs where Chrome exists" : false },
  () => {
    let coordinator: ClusterCoordinator;
    let worker: WorkerRuntime | undefined;
    let origin: string;
    let browser: Browser;
    let ownsBrowserLock = false;
    const contexts: BrowserContext[] = [];
    let root: string;

    async function newContext(): Promise<BrowserContext> {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      contexts.push(context);
      return context;
    }

    async function login(page: Page): Promise<void> {
      await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
      await page.locator("#username").fill("admin");
      await page.locator("#password").fill(testPassword);
      await page.getByRole("button", { name: /登录工作台/ }).click();
      await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 15000 });
    }

    async function openApprovals(page: Page): Promise<void> {
      await page.goto(`${origin}/approvals`, { waitUntil: "domcontentloaded" });
      await page.getByText("人机协同安全边界").waitFor({ timeout: 15000 });
    }

    before(async () => {
      await acquireBrowserLock();
      ownsBrowserLock = true;
      root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-approvals-browser-"));
      coordinator = new ClusterCoordinator({
        ephemeral: true,
        customDir: path.join(root, "coordinator"),
        listenHost: "127.0.0.1",
        listenPort: 0,
        adminApiKey: randomBytes(16).toString("hex"),
        webDistDir: path.join(process.cwd(), "apps", "web", "dist"),
      });
      const { port } = await coordinator.start();
      origin = `http://127.0.0.1:${port}`;
      const store = coordinator.getStore();
      const now = Date.now();
      await store.saveTask({
        taskId: "task-ui-grant",
        runId: "run-ui-grant",
        nodeId: "worker-ui",
        projectId: "project-ui",
        goal: "browser approval fixture",
        status: "waiting_approval",
        dispatchAttempt: 1,
        createdAt: now,
        updatedAt: now,
      });
      await store.saveApproval({
        approvalId: "appr-ui-grant",
        taskId: "task-ui-grant",
        runId: "run-ui-grant",
        nodeId: "worker-ui",
        agentId: "main",
        capability: "filesystem-outside-workspace",
        reason: "Agent 试图写入工作区外部的路径 '/tmp/browser-report.txt'。",
        target: "/tmp/browser-report.txt",
        status: "pending",
        requestedAt: now,
        expiresAt: now + 10 * 60_000,
      });
      await store.saveWebSession?.({
        sessionId: "sess-browser-viewer",
        userId: "usr-viewer",
        username: "viewer",
        role: "viewer",
        csrfToken: "viewer-csrf",
        createdAt: now,
        expiresAt: now + 3600_000,
      });

      // 真实在线 Worker：第三按钮的可用性由服务端 isNodeOnline 决定；点击后的拒绝同样来自真实 Worker。
      worker = new WorkerRuntime({
        coordinatorUrl: `ws://127.0.0.1:${port}/ws/cluster`,
        inviteCode: coordinator.getInviteManager().createInvite({ role: "worker", maxUses: 1 }).inviteCode,
        customDir: path.join(root, "worker-ui"),
        nodeId: "worker-ui",
      });
      await worker.start();
      const onlineDeadline = Date.now() + 15000;
      while (Date.now() < onlineDeadline && !coordinator.getRegistry().getConnection("worker-ui")) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(coordinator.getRegistry().getConnection("worker-ui"), "worker-ui 必须真实在线，否则第三按钮按设计不可见");

      browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: BROWSER_ARGS });
    });

    after(async () => {
      for (const context of contexts) await context.close().catch(() => {});
      await browser?.close().catch(() => {});
      await worker?.stop().catch(() => {});
      await coordinator?.stop().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
      if (ownsBrowserLock) await fs.promises.rm(browserLockPath, { recursive: true, force: true });
      if (previousUser === undefined) delete process.env.DASHBOARD_USER; else process.env.DASHBOARD_USER = previousUser;
      if (previousPassword === undefined) delete process.env.DASHBOARD_PASS; else process.env.DASHBOARD_PASS = previousPassword;
    });

    test("管理员点击第三按钮：弹窗、身份知情确认门禁、真实 Worker 拒绝如实展示", async () => {
      const context = await newContext();
      const page = await context.newPage();
      await login(page);
      await openApprovals(page);

      const target = page.getByRole("button", { name: THREE_TARGET_BUTTON });
      await target.waitFor({ timeout: 15000 });
      assert.equal(await target.isVisible(), true, "管理员必须看到第三按钮");
      await target.click();

      await page.getByRole("heading", { name: "确认仅对此任务启用完全访问？" }).waitFor({ timeout: 5000 });
      assert.match(await page.locator("body").innerText(), /worker-ui/);
      assert.match(await page.locator("body").innerText(), /task-ui-grant/);
      assert.match(await page.locator("body").innerText(), /run-ui-grant/);
      assert.match(await page.locator("body").innerText(), /danger-full-access \+ allow \+ auto-grant/);
      assert.match(await page.locator("body").innerText(), /安全模型审查未通过或模型服务不可用时/);

      const confirm = page.getByRole("button", { name: CONFIRM_BUTTON });
      assert.equal(await confirm.isDisabled(), true, "未勾选知情确认前禁止提交");
      await page.getByRole("checkbox").check();
      assert.equal(await confirm.isDisabled(), false, "勾选知情确认后允许提交");

      // 真实后端 + 真实在线 Worker：该 Worker 上没有对应 Runner → ACK 明确拒绝，
      // 授权绝不能标记成功，原审批必须保持待处理。
      await confirm.click();
      await page.getByText(/拒绝应用新沙箱策略/).waitFor({ timeout: 20000 });
      const bodyText = await page.locator("body").innerText();
      assert.match(bodyText, /原审批保持待处理/);
      assert.equal((await coordinator.getStore().getApproval("appr-ui-grant"))?.status, "pending");
      assert.equal(await page.getByRole("heading", { name: "确认仅对此任务启用完全访问？" }).isVisible(), true, "失败时弹窗必须保持打开");
      assert.equal(await page.getByText(/正在下发授权并等待 Worker 确认/).count(), 0, "等待态必须结束");

      await page.getByRole("button", { name: "取消" }).click();
      await page.getByRole("heading", { name: "确认仅对此任务启用完全访问？" }).waitFor({ state: "detached", timeout: 5000 });
    });

    test("非管理员看不到可点击的授权入口，只看到权限说明", async () => {
      const context = await newContext();
      await context.addCookies([{ name: "nash_session", value: "sess-browser-viewer", domain: "127.0.0.1", path: "/" }]);
      const page = await context.newPage();
      await openApprovals(page);
      await page.getByText(/仅管理员可授予任务级全访问权限/).waitFor({ timeout: 15000 });
      assert.equal(await page.getByRole("button", { name: THREE_TARGET_BUTTON }).count(), 0, "非管理员不得看到第三按钮");
      assert.equal(await page.getByRole("button", { name: /放行一次/ }).count(), 1, "普通审批按钮仍然可用");
    });

    test("移动端 390x844：按钮可见且风险弹窗可操作", async () => {
      const context = await newContext();
      const page = await context.newPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await login(page);
      await openApprovals(page);
      const target = page.getByRole("button", { name: THREE_TARGET_BUTTON });
      await target.waitFor({ timeout: 15000 });
      await target.click();
      await page.getByRole("heading", { name: "确认仅对此任务启用完全访问？" }).waitFor({ timeout: 5000 });
      const confirm = page.getByRole("button", { name: CONFIRM_BUTTON });
      assert.equal(await confirm.isDisabled(), true);
      await page.getByRole("checkbox").check();
      assert.equal(await confirm.isDisabled(), false);
      const box = await page.locator("div.fixed.inset-0").first().boundingBox();
      assert.ok(box && box.width <= 390 && box.height <= 844, "弹窗必须保持在移动视口内");
      await page.getByRole("button", { name: "取消" }).click();
    });

    test("UI_STATE_ONLY：授权 API 返回成功后，条目转为历史「全访问 · 安全模型审查」", async () => {
      const context = await newContext();
      const page = await context.newPage();
      await login(page);
      await openApprovals(page);

      let granted = false;
      const now = Date.now();
      await page.route("**/api/cluster/approvals/*/grant-full-access", async (route) => {
        granted = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            grantId: "grant-ui-only",
            approvalId: "appr-ui-grant",
            taskId: "task-ui-grant",
            runId: "run-ui-grant",
            applied: true,
            status: "applied",
            targetPolicy: { filesystem: { mode: "danger-full-access" }, network: { mode: "allow" }, approval: { mode: "auto-grant" } },
            appliesTo: "subsequent-tool-calls",
            message: "UI state fixture",
          }),
        });
      });
      await page.route("**/api/cluster/approvals", async (route) => {
        if (!granted || route.request().method() !== "GET") return route.continue();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            approvals: [],
            history: [{
              approvalId: "appr-ui-grant", taskId: "task-ui-grant", runId: "run-ui-grant", nodeId: "worker-ui",
              agentId: "main", capability: "filesystem-outside-workspace", reason: "fixture",
              target: "/tmp/browser-report.txt", status: "approved", decision: "grant-task-full-access",
              grantId: "grant-ui-only", requestedAt: now, expiresAt: now + 60000, resolvedAt: now,
            }],
          }),
        });
      });

      await page.getByRole("button", { name: THREE_TARGET_BUTTON }).click();
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: CONFIRM_BUTTON }).click();
      await page.getByText("全访问 · 安全模型审查").waitFor({ timeout: 10000 });
      assert.equal(await page.getByRole("heading", { name: "确认仅对此任务启用完全访问？" }).count(), 0, "成功后弹窗必须关闭");
    });
  }
);
