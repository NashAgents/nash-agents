/**
 * Automated Tests: AI Prompt Optimizer & AI Conversation Auto-Titling
 *
 * 验证：
 * 1. Prompt Optimizer Service 单元测试 (语义保真、清洗前缀包裹、空输入拦截、取消、超时)
 * 2. Session Title Service 单元测试 (仅提取人类消息、清洗前缀引号、单行约束、长度建议)
 * 3. Web API 集成测试 (POST /api/ai/optimize-prompt, 权限认证、校验)
 * 4. 会话自动命名异步触发、CAS 防竞态版本校验、用户手动重命名保护 (USER_DEFINED 永不覆盖)
 * 5. SSE conversation.title_updated 实时广播
 */

import { randomBytes } from "node:crypto";
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { PromptOptimizerService } from "../src/ai/prompt-optimizer-service.js";
import { SessionTitleService } from "../src/ai/session-title-service.js";
import { PROMPT_OPTIMIZER_SYSTEM_PROMPT } from "../src/ai/prompts/prompt-optimizer.js";
import { SESSION_TITLE_SYSTEM_PROMPT } from "../src/ai/prompts/session-title.js";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";

const testPassword = randomBytes(24).toString("hex");
const previousApiKey = process.env.DEEPSEEK_API_KEY;
const previousPassword = process.env.DASHBOARD_PASS;

const originalFetch = globalThis.fetch;
let mockChatCompletionHandler: ((url: string, init?: RequestInit) => Promise<any>) | null = null;

describe("AI Prompt Optimizer & Conversation Auto-Titling Tests", () => {
  let coordinator: ClusterCoordinator;
  let coordinatorUrl: string;
  const adminKey = "test-ai-key-" + Date.now();
  let cookieHeader = "";
  let csrfToken = "";

  before(async () => {
    process.env.DASHBOARD_PASS = testPassword;
    process.env.DEEPSEEK_API_KEY = "mock-api-test-key";

    // 拦截全局 fetch 中指向 /chat/completions 的小模型请求
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
      listenPort: 19998,
      adminApiKey: adminKey,
      webDistDir: path.join(process.cwd(), "apps", "web", "dist"),
    });

    // Mock MainAgent.chat 避免执行真实外部调用
    mock.method(coordinator.getMainAgent(), "chat", async () => ({
      assistantResponse: "协调器已收到您的任务指令并处理完成。",
      state: "completed" as const,
      durationMs: 50,
    }));

    const addr = await coordinator.start();
    coordinatorUrl = `http://127.0.0.1:${addr.port}`;

    // 登录以获取 Cookie 与 CSRF Token
    const loginRes = await fetch(`${coordinatorUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: testPassword,
      }),
    });
    if (loginRes.ok) {
      const data = (await loginRes.json()) as any;
      csrfToken = data.csrfToken || "";
      const setCookie = loginRes.headers.get("set-cookie");
      if (setCookie) cookieHeader = setCookie.split(";")[0]!;
    }
  });

  after(async () => {
    mockChatCompletionHandler = null;
    globalThis.fetch = originalFetch;
    mock.reset();
    if (previousApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousApiKey;
    if (previousPassword === undefined) delete process.env.DASHBOARD_PASS;
    else process.env.DASHBOARD_PASS = previousPassword;
    await coordinator.stop();
  });

  // =========================================================================
  // 1. Prompt Optimizer Service 单元测试
  // =========================================================================
  describe("1. Prompt Optimizer Service Unit Tests", () => {
    const optimizer = new PromptOptimizerService({
      modelConfig: {
        baseUrl: "https://mock-api.nash.ai/v1",
        apiKey: "mock-key",
        model: "mock-model",
      },
    });

    test("1.1 空输入与纯空白草稿被严格拒绝", async () => {
      await assert.rejects(
        () => optimizer.optimizePrompt(""),
        /提示词草稿不能为空/
      );
      await assert.rejects(
        () => optimizer.optimizePrompt("   \n\t  "),
        /提示词草稿不能为空/
      );
    });

    test("1.2 超长输入被拦截 (15000 字符限制)", async () => {
      const hugeText = "a".repeat(16000);
      await assert.rejects(
        () => optimizer.optimizePrompt(hugeText),
        /超出上限/
      );
    });

    test("1.3 输出清洗逻辑：去除外层 Markdown 代码块包裹与前导废话", () => {
      const rawWithCodeFence = "```markdown\n请编写一个高效的快速排序算法，支持升序降序\n```";
      const cleaned1 = optimizer.sanitizeAndValidateOutput("快速排序算法", rawWithCodeFence);
      assert.equal(cleaned1, "请编写一个高效的快速排序算法，支持升序降序");

      const rawWithPreamble = "以下是优化后的提示词：\n检查 /opt/nash-cluster 目录下的配置文件，排查端口 8080 占用";
      const cleaned2 = optimizer.sanitizeAndValidateOutput("排查端口 8080", rawWithPreamble);
      assert.equal(cleaned2, "检查 /opt/nash-cluster 目录下的配置文件，排查端口 8080 占用");

      const rawWithPreamble2 = "优化结果如下：\n分析 Bilibili 字幕提取服务在 WSL2 上的运行状况";
      const cleaned3 = optimizer.sanitizeAndValidateOutput("分析 Bilibili", rawWithPreamble2);
      assert.equal(cleaned3, "分析 Bilibili 字幕提取服务在 WSL2 上的运行状况");
    });

    test("1.4 输出清洗逻辑：识别并拒绝模型拒答短语", () => {
      assert.throws(
        () => optimizer.sanitizeAndValidateOutput("test", "抱歉，我无法协助执行该提示词优化"),
        /未能正确执行提示词重述/
      );
      assert.throws(
        () => optimizer.sanitizeAndValidateOutput("test", "作为人工智能语言模型，我不能..."),
        /未能正确执行提示词重述/
      );
    });

    test("1.5 真实调用 Mock 模拟：成功优化并保持结构", async () => {
      mockChatCompletionHandler = async (url, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        assert.equal(body.messages[0]!.role, "system");
        assert.equal(body.messages[0]!.content, PROMPT_OPTIMIZER_SYSTEM_PROMPT);
        assert.equal(body.messages[1]!.role, "user");
        assert.equal(body.messages[1]!.content, "帮我看看之前那个字幕项目有什么问题");
        assert.equal(body.temperature, 0.1);

        return {
          id: "mock-opt-1",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "排查并分析字幕提取项目在近期执行中出现的异常或配置问题，检查日志并说明根本原因。",
              },
              finish_reason: "stop",
            },
          ],
        };
      };

      const res = await optimizer.optimizePrompt("帮我看看之前那个字幕项目有什么问题");
      assert.equal(
        res.optimizedText,
        "排查并分析字幕提取项目在近期执行中出现的异常或配置问题，检查日志并说明根本原因。"
      );
      assert.ok(res.durationMs >= 0);
      mockChatCompletionHandler = null;
    });

    test("1.6 支持 AbortSignal 主动取消", async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        () => optimizer.optimizePrompt("帮我排查问题", { signal: controller.signal }),
        /取消/
      );
    });
  });

  // =========================================================================
  // 2. Session Title Service 单元测试
  // =========================================================================
  describe("2. Session Title Service Unit Tests", () => {
    const titleService = new SessionTitleService({
      modelConfig: {
        baseUrl: "https://mock-api.nash.ai/v1",
        apiKey: "mock-key",
        model: "mock-title-model",
      },
    });

    test("2.1 无人类消息时返回优雅保底标题", async () => {
      const res = await titleService.generateTitle([]);
      assert.equal(res.title, "新任务会话");

      const res2 = await titleService.generateTitle([
        { sender: "assistant", content: "你好，我是 Nash Agent" },
      ]);
      assert.equal(res2.title, "新任务会话");
    });

    test("2.2 标题清洗逻辑：严格剥离外层引号、前缀说明、Markdown 标记与代码块", () => {
      const raw1 = '“WSL2 离线字幕项目探查”';
      assert.equal(titleService.sanitizeTitleOutput(raw1, "fallback"), "WSL2 离线字幕项目探查");

      const raw2 = 'Title: Bilibili 项目分析。';
      assert.equal(titleService.sanitizeTitleOutput(raw2, "fallback"), "Bilibili 项目分析");

      const raw3 = '**腾讯云服务与端口检查**';
      assert.equal(titleService.sanitizeTitleOutput(raw3, "fallback"), "腾讯云服务与端口检查");

      const raw4 = '会话标题：`GPU 显存占用分析`\n这是多余的第二行说明';
      assert.equal(titleService.sanitizeTitleOutput(raw4, "fallback"), "GPU 显存占用分析");
    });

    test("2.3 模拟模型调用：按 SESSION_TITLE_SYSTEM_PROMPT 生成自然标题", async () => {
      mockChatCompletionHandler = async (url, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        assert.equal(body.messages[0]!.role, "system");
        assert.equal(body.messages[0]!.content, SESSION_TITLE_SYSTEM_PROMPT);
        assert.ok(body.messages[1]!.content.includes("Human: WSL2 里有一个关于离线字幕的项目，探查一下"));

        return {
          id: "mock-title-1",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "WSL2 离线字幕项目探查",
              },
              finish_reason: "stop",
            },
          ],
        };
      };

      const res = await titleService.generateTitle([
        { sender: "user", content: "WSL2 里有一个关于离线字幕的项目，探查一下。" },
      ]);

      assert.equal(res.title, "WSL2 离线字幕项目探查");
      mockChatCompletionHandler = null;
    });

    test("2.4 模型异常时优雅回退为首条提问截断，绝不抛出异常阻断", async () => {
      mockChatCompletionHandler = async () => {
        throw new Error("Connection refused");
      };

      const res = await titleService.generateTitle([
        { sender: "user", content: "检查腾讯云服务器上运行的全部服务" },
      ]);

      assert.ok(res.title.includes("检查腾讯云服务器"));
      mockChatCompletionHandler = null;
    });
  });

  // =========================================================================
  // 3. Web API 提示词优化与标题管理集成测试
  // =========================================================================
  describe("3. Web API Endpoints Integration Tests", () => {
    test("3.1 POST /api/ai/optimize-prompt 空输入返回 400", async () => {
      const res = await fetch(`${coordinatorUrl}/api/ai/optimize-prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader,
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ text: "   " }),
      });
      assert.equal(res.status, 400);
      const data = (await res.json()) as any;
      assert.ok(data.error.includes("提示词草稿不能为空"));
    });

    test("3.2 POST /api/ai/optimize-prompt 正常请求成功返回优化文本", async () => {
      mockChatCompletionHandler = async () => ({
        id: "mock-opt-api",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "检查远程腾讯云节点运行的服务清单与端口监听状态，排查异常进程。",
            },
            finish_reason: "stop",
          },
        ],
      });

      const res = await fetch(`${coordinatorUrl}/api/ai/optimize-prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader,
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ text: "查一下腾讯云运行的服务和端口" }),
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.optimizedText, "检查远程腾讯云节点运行的服务清单与端口监听状态，排查异常进程。");
      mockChatCompletionHandler = null;
    });

    test("3.3 POST /api/cluster/conversations/:id/generate-title 手动生成标题", async () => {
      const store = coordinator.getStore();
      const convId = `conv-test-${Date.now()}`;
      await store.saveConversation?.({
        id: convId,
        title: "新任务",
        titleSource: "default",
        titleRevision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          {
            id: "m-1",
            conversationId: convId,
            sender: "user",
            content: "帮我分析一下 Bilibili 字幕抓取项目的架构",
            timestamp: Date.now(),
          },
        ],
      });

      mockChatCompletionHandler = async () => ({
        id: "mock-title-api",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Bilibili 字幕项目架构分析",
            },
            finish_reason: "stop",
          },
        ],
      });

      const res = await fetch(`${coordinatorUrl}/api/cluster/conversations/${convId}/generate-title`, {
        method: "POST",
        headers: {
          Cookie: cookieHeader,
          "X-CSRF-Token": csrfToken,
        },
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.title, "Bilibili 字幕项目架构分析");

      // 核验存盘状态已更新为 ai_generated
      const updated = await store.getConversation?.(convId);
      assert.equal(updated?.title, "Bilibili 字幕项目架构分析");
      assert.equal(updated?.titleSource, "ai_generated");
      mockChatCompletionHandler = null;
    });
  });

  // =========================================================================
  // 4. 自动标题覆盖策略与防竞态、用户手动重命名保护 (Section 十一)
  // =========================================================================
  describe("4. Title Overwriting Policy & Manual Protection Tests", () => {
    test("4.1 发送用户消息后异步触发标题生成，并自动更新会话标题", async () => {
      const store = coordinator.getStore();
      const convId = `conv-auto-${Date.now()}`;
      await store.saveConversation?.({
        id: convId,
        title: "新任务",
        titleSource: "default",
        titleRevision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      });

      mockChatCompletionHandler = async () => ({
        id: "mock-async-title",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "WSL2 离线字幕探查",
            },
            finish_reason: "stop",
          },
        ],
      });

      // 发送消息
      const res = await fetch(`${coordinatorUrl}/api/cluster/conversations/${convId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader,
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ content: "WSL2 里有一个关于离线字幕的项目，探查一下" }),
      });
      assert.equal(res.status, 200);

      // 等待异步任务执行完成
      await new Promise((r) => setTimeout(r, 200));

      const updated = await store.getConversation?.(convId);
      assert.equal(updated?.title, "WSL2 离线字幕探查");
      assert.equal(updated?.titleSource, "ai_generated");
      mockChatCompletionHandler = null;
    });

    test("4.2 用户手动重命名 (USER_DEFINED) 后，后续消息绝不覆盖手动标题", async () => {
      const store = coordinator.getStore();
      const convId = `conv-manual-${Date.now()}`;
      await store.saveConversation?.({
        id: convId,
        title: "新任务",
        titleSource: "default",
        titleRevision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      });

      // 1. 用户手动通过 PATCH 改名
      const patchRes = await fetch(`${coordinatorUrl}/api/cluster/conversations/${convId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader,
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ title: "我的专属字幕工作站" }),
      });
      assert.equal(patchRes.status, 200);

      const check1 = await store.getConversation?.(convId);
      assert.equal(check1?.title, "我的专属字幕工作站");
      assert.equal(check1?.titleSource, "user_defined");

      // 2. 随后用户继续发送新消息
      mockChatCompletionHandler = async () => ({
        id: "mock-should-not-override",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "自动生成的其他标题",
            },
            finish_reason: "stop",
          },
        ],
      });

      const msgRes = await fetch(`${coordinatorUrl}/api/cluster/conversations/${convId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader,
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ content: "再检查一下 GPU 显存占用情况" }),
      });
      assert.equal(msgRes.status, 200);

      await new Promise((r) => setTimeout(r, 200));

      // 3. 验证手动标题被严格保留，绝未被 AI 覆盖！
      const check2 = await store.getConversation?.(convId);
      assert.equal(check2?.title, "我的专属字幕工作站");
      assert.equal(check2?.titleSource, "user_defined");
      mockChatCompletionHandler = null;
    });

    test("4.3 防竞态检查：旧 Revision 晚到的响应不得覆盖新 Revision 标题", async () => {
      const store = coordinator.getStore();
      const convId = `conv-race-${Date.now()}`;
      await store.saveConversation?.({
        id: convId,
        title: "新任务",
        titleSource: "default",
        titleRevision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          { id: "m-1", conversationId: convId, sender: "user", content: "第一条消息", timestamp: Date.now() },
        ],
      });

      // 模拟旧请求晚到：triggerAsyncTitleGeneration 传入 targetRevision = 1
      // 但数据库中当前 titleRevision 已经被提升到 5
      const conv = await store.getConversation?.(convId);
      conv!.titleRevision = 5;
      conv!.title = "最新第五版标题";
      conv!.titleSource = "ai_generated";
      await store.saveConversation?.(conv!);

      mockChatCompletionHandler = async () => ({
        id: "mock-stale",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "旧第一版标题（过时）",
            },
            finish_reason: "stop",
          },
        ],
      });

      // 通过直接触发 apiHandler 内部的 triggerAsyncTitleGeneration
      (coordinator as any).apiHandler.triggerAsyncTitleGeneration(convId, 1);

      await new Promise((r) => setTimeout(r, 200));

      const finalConv = await store.getConversation?.(convId);
      // 验证最终标题仍然是最新第五版，过时的旧版本被成功拦截！
      assert.equal(finalConv?.title, "最新第五版标题");
      assert.equal(finalConv?.titleRevision, 5);
      mockChatCompletionHandler = null;
    });
  });
});
