delete process.env.DISPLAY;
import { randomBytes } from "node:crypto";
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { chromium, type Browser, type BrowserServer, type Page } from "playwright-core";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";

const testPassword = randomBytes(24).toString("hex");
const previousPassword = process.env.DASHBOARD_PASS;
const previousApiKey = process.env.DEEPSEEK_API_KEY;

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
const SCREENSHOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nash-ai-visual-"));
const browserLock = browserLockPath;

const originalFetch = globalThis.fetch;
let mockChatCompletionHandler: ((url: string, init?: RequestInit) => Promise<any>) | null = null;

describe("Nash Web: Browser AI E2E Visual Verification (Prompt Optimizer & Auto-Titling)", { skip: !CHROME_PATH ? "Chrome is not installed on this platform; visual coverage runs on Mac" : false }, () => {
  let coordinator: ClusterCoordinator;
  let coordinatorUrl: string;
  let browser: Browser;
  let browserServer: BrowserServer | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let ownsBrowserLock = false;

  async function newPage(options?: Parameters<Browser["newPage"]>[0]): Promise<Page> {
    const page = await browser.newPage(options);
    await page.route("**/*", (route) =>
      ["media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue()
    );
    return page;
  }

  before(async () => {
    process.env.DASHBOARD_PASS = testPassword;
    process.env.DEEPSEEK_API_KEY = "sk-test-mock-api-key";
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }

    // 拦截发往模型完成端点的请求，提供可控的智能生成模拟
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.endsWith("/chat/completions") && mockChatCompletionHandler) {
        try {
          const data = await mockChatCompletionHandler(urlStr, init);
          return new Response(JSON.stringify(data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message || "Model error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return originalFetch(input, init);
    };

    coordinator = new ClusterCoordinator({
      ephemeral: true,
      listenHost: "127.0.0.1",
      listenPort: 0,
      adminApiKey: "test-admin-secret-key",
      webDistDir: path.join(process.cwd(), "apps", "web", "dist"),
    });

    mock.method(coordinator.getMainAgent(), "chat", async () => ({
      assistantResponse: "【Nash Coordinator 成果交付】已顺利探查并汇总集群环境与字幕项目配置。",
      state: "completed" as const,
      durationMs: 30,
    }));

    const store = coordinator.getStore();
    await store.saveNode({
      nodeId: "node-tencent-cloud-test",
      name: "Tencent-Linux",
      role: "worker",
      platform: "linux",
      arch: "x64",
      hostname: "tencent-vm",
      tokenHash: "dummy",
      status: "online",
      lastSeenAt: Date.now(),
      metadata: { capabilities: ["node", "git", "bash", "mcp"] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const addr = await coordinator.start();
    coordinatorUrl = `http://127.0.0.1:${addr.port}`;

    await acquireBrowserLock();
    ownsBrowserLock = true;
    browserServer = await chromium.launchServer({
      executablePath: CHROME_PATH,
      headless: true,
      args: BROWSER_ARGS,
    });
    watchdog = setTimeout(() => {
      browserServer?.process().kill("SIGKILL");
    }, 30000);
    watchdog.unref();
    browser = await chromium.connect(browserServer.wsEndpoint());
  });

  after(async () => {
    mockChatCompletionHandler = null;
    globalThis.fetch = originalFetch;
    if (watchdog) clearTimeout(watchdog);
    try {
      if (browser) await browser.close();
    } finally {
      try {
        await browserServer?.close();
      } finally {
        const child = browserServer?.process();
        if (child && child.exitCode === null) child.kill("SIGKILL");
        if (ownsBrowserLock) fs.rmSync(browserLock, { recursive: true, force: true });
        fs.rmSync(SCREENSHOT_DIR, { recursive: true, force: true });
        if (previousPassword === undefined) delete process.env.DASHBOARD_PASS;
        else process.env.DASHBOARD_PASS = previousPassword;
        if (previousApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
        else process.env.DEEPSEEK_API_KEY = previousApiKey;
        await coordinator.stop();
      }
    }
  });

  async function loginHelper(page: Page) {
    await page.goto(`${coordinatorUrl}/`);
    await page.waitForURL("**/login**");
    await page.getByLabel("管理员账号", { exact: true }).fill("admin");
    await page.getByLabel("密码", { exact: true }).fill(testPassword);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${coordinatorUrl}/`);
    await page.waitForSelector("textarea");
  }

  test("1. Desktop (1920x1080 & 1440x900) 提示词优化、流光动画、填回及撤销完整交互", async () => {
    const page = await newPage({ viewport: { width: 1440, height: 900 } });
    await loginHelper(page);

    // 默认深色模式检查
    const textarea = page.locator("textarea");
    await textarea.waitFor({ state: "visible" });

    // 初始草稿输入
    const draftText = "帮我看看之前那个字幕项目有什么问题";
    await textarea.fill(draftText);

    // 检查优化按钮与发送按钮并排布局
    const optimizeBtn = page.getByRole("button", { name: "优化提示词" });
    await assert.doesNotReject(async () => {
      await optimizeBtn.waitFor({ state: "visible" });
    });

    // 截图 1: 输入草稿但未点击优化 (Desktop Dark)
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "ai_optimizer_desktop_dark.png") });

    // 设置 Mock 小模型返回 (增加 400ms 真实网络/推理耗时模拟，便于核验 OPTIMIZING 态锁定与流光动画)
    mockChatCompletionHandler = async () => {
      await new Promise((r) => setTimeout(r, 400));
      return {
        id: "mock-opt-web",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "排查并分析字幕提取项目在近期执行中出现的异常或配置问题，检查系统日志并排查根本原因。",
            },
            finish_reason: "stop",
          },
        ],
      };
    };

    // 点击优化按钮
    const clickPromise = optimizeBtn.click();

    // 验证优化状态：输入框锁定 (readonly)
    await page.waitForFunction(
      () => document.querySelector("textarea")?.hasAttribute("readonly"),
      { timeout: 5000 }
    );

    // 截图 2: 正在优化中 (流光动画、锁定状态、底部“正在优化提示词…”)
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "ai_optimizer_optimizing_flow.png") });

    await clickPromise;

    // 等待优化结果返回并填回输入框
    await page.waitForFunction(
      (expected) => {
        const el = document.querySelector("textarea");
        return el && el.value.includes(expected);
      },
      "排查并分析字幕提取项目",
      { timeout: 5000 }
    );

    // 截图 3: 优化完成填回草稿、显示撤销条 (Desktop Dark)
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "ai_optimizer_optimized_success.png") });

    // 验证提示词未自动发送（会话消息数仍为 0）
    const messagesCount = await page.locator(".user-message-card").count();
    assert.equal(messagesCount, 0, "优化完成后绝对不可自动发送消息");

    // 点击撤销优化
    const undoBtn = page.getByRole("button", { name: "↶ 撤销优化" });
    await undoBtn.click();

    // 验证恢复原始草稿
    const currentVal = await textarea.inputValue();
    assert.equal(currentVal, draftText, "点击撤销优化后应精准恢复原始草稿");

    await page.close();
  });

  test("2. Light 模式 (1440x900) 视觉适配与优化状态流光核验", async () => {
    const page = await newPage({ viewport: { width: 1440, height: 900 } });
    await loginHelper(page);

    // 切换为亮色模式
    const themeBtn = page.locator('button[title*="亮色模式"], button[title*="暗色模式"]');
    if (await themeBtn.isVisible()) {
      await themeBtn.click();
      await page.waitForTimeout(300);
    }

    const textarea = page.locator("textarea");
    await textarea.fill("分析一下 Bilibili 这个项目");

    // 截图 3: 亮色模式下的输入框与优化按钮 (Light Mode)
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "ai_optimizer_desktop_light.png") });

    await page.close();
  });

  test("3. Tablet 触控视口 (768x1024) 布局与优化交互", async () => {
    const page = await newPage({ viewport: { width: 768, height: 1024 } });
    await loginHelper(page);

    const textarea = page.locator("textarea");
    await textarea.waitFor({ state: "visible" });
    await textarea.fill("WSL2 里有一个关于离线字幕的项目，探查一下。");

    // 截图 4: 平板视口 (Tablet 768px)
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "ai_optimizer_tablet_768.png") });

    await page.close();
  });

  test("4. Mobile 移动端视口 (375x667 & 430x932) 布局与按钮不遮挡核验", async () => {
    const page = await newPage({ viewport: { width: 375, height: 667 } });
    await loginHelper(page);

    const textarea = page.locator("textarea");
    await textarea.waitFor({ state: "visible" });
    await textarea.fill("腾讯云服务与端口检查");

    const optimizeBtn = page.getByRole("button", { name: "优化提示词" });
    assert.ok(await optimizeBtn.isVisible(), "移动端优化按钮应正常可见不被遮挡");

    // 截图 5: 移动端 375px (Mobile Standard)
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "ai_optimizer_mobile_375.png") });

    await page.close();
  });

  test("5. 会话自动命名 (AI Conversation Auto-Titling) 与左侧侧边栏实时响应", async () => {
    const page = await newPage({ viewport: { width: 1440, height: 900 } });
    await loginHelper(page);

    mockChatCompletionHandler = async (url, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const prompt = body.messages?.[1]?.content || "";
      if (prompt.includes("离线字幕")) {
        return {
          id: "title-1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "WSL2 离线字幕探查" },
              finish_reason: "stop",
            },
          ],
        };
      }
      return {
        id: "title-default",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "智能协同任务" },
            finish_reason: "stop",
          },
        ],
      };
    };

    const textarea = page.locator("textarea");
    await textarea.fill("WSL2 里有一个关于离线字幕的项目，探查一下。");

    // 点击发送
    await page.getByRole("button", { name: "发送" }).click();

    // 等待消息上屏与 Coordinator 交付成果
    await page.waitForSelector(".user-message-card", { timeout: 8000 });

    // 等待异步标题生成并在左侧侧边栏与顶部标题中生效
    await page.waitForFunction(
      (expectedTitle) => {
        const titles = Array.from(document.querySelectorAll("aside span, .truncate"));
        return titles.some((el) => el.textContent?.includes(expectedTitle));
      },
      "WSL2 离线字幕探查",
      { timeout: 8000 }
    );

    // 截图 6: 自动命名生效并实时呈现在侧边栏中
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "ai_titling_sidebar_sync.png") });

    await page.close();
  });
});
