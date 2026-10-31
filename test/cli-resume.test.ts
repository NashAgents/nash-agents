import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PassThrough } from "node:stream";

import {
  LocalSessionStore,
  ContextManager,
  LocalSpillStore,
} from "../src/context/index.js";
import {
  InputManager,
  TerminalUI,
  handleSlashCommand,
  isSlashCommand,
} from "../src/cli/index.js";
import type { ChatMessage } from "../src/model/chat-completions-client.js";

describe("CLI /resume & Session Selection Subsystem", () => {
  let tempBaseDir: string;

  before(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-resume-test-"));
  });

  after(async () => {
    await fs.rm(tempBaseDir, { recursive: true, force: true });
  });

  // ==========================================
  // 1. LocalSessionStore 摘要与列表测试
  // ==========================================
  describe("1. LocalSessionStore Summary & Metadata", () => {
    it("1.1 空会话 getSummary 返回合法的空摘要信息", async () => {
      const store = new LocalSessionStore({
        baseDir: tempBaseDir,
      });

      const summary = await store.getSummary();
      assert.strictEqual(summary.sessionId, store.sessionId);
      assert.strictEqual(summary.recordCount, 0);
      assert.strictEqual(summary.messageCount, 0);
      assert.strictEqual(summary.hasCompaction, false);
      assert.strictEqual(summary.firstUserPrompt, undefined);
    });

    it("1.2 写入多轮对话记录后 getSummary 正确统计与捕获首条 Prompt", async () => {
      const store = new LocalSessionStore({
        baseDir: tempBaseDir,
      });

      await store.appendUserMessage("帮我实现快速排序算法");
      await store.appendAssistantMessage("好的，这是快速排序的实现...", [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "quick_sort.ts" }),
          },
        },
      ]);
      await store.appendToolResult("call_1", "write_file", {
        content: "File written successfully",
        originalChars: 25,
        offloaded: false,
        success: true,
      });
      await store.appendAssistantMessage("已成功写入 quick_sort.ts 文件！");
      await store.appendUserMessage("请继续编写单元测试");

      const summary = await store.getSummary();
      assert.strictEqual(summary.sessionId, store.sessionId);
      assert.strictEqual(summary.recordCount, 5);
      assert.strictEqual(summary.messageCount, 4); // 2 user + 2 assistant
      assert.strictEqual(summary.firstUserPrompt, "帮我实现快速排序算法");
      assert.strictEqual(summary.lastUserPrompt, "请继续编写单元测试");
      assert.strictEqual(summary.hasCompaction, false);
    });

    it("1.3 listSessionSummaries 按 updatedAt 倒序返回所有历史会话", async () => {
      const session1 = new LocalSessionStore({ baseDir: tempBaseDir });
      await session1.appendUserMessage("Session 1 First Prompt");
      await new Promise((r) => setTimeout(r, 20));

      const session2 = new LocalSessionStore({ baseDir: tempBaseDir });
      await session2.appendUserMessage("Session 2 First Prompt");
      await new Promise((r) => setTimeout(r, 20));

      const session3 = new LocalSessionStore({ baseDir: tempBaseDir });
      await session3.appendUserMessage("Session 3 First Prompt");

      const summaries = await LocalSessionStore.listSessionSummaries(tempBaseDir);
      assert.ok(summaries.length >= 3);

      const found1 = summaries.find((s) => s.sessionId === session1.sessionId);
      const found2 = summaries.find((s) => s.sessionId === session2.sessionId);
      const found3 = summaries.find((s) => s.sessionId === session3.sessionId);

      assert.ok(found1 && found2 && found3);
      assert.strictEqual(found1.firstUserPrompt, "Session 1 First Prompt");
      assert.strictEqual(found3.firstUserPrompt, "Session 3 First Prompt");

      // 验证按更新时间倒序
      const idx1 = summaries.findIndex((s) => s.sessionId === session1.sessionId);
      const idx3 = summaries.findIndex((s) => s.sessionId === session3.sessionId);
      assert.ok(idx3 < idx1, "最新创建的 session 应当排在更前");
    });

    it("1.4 sessionExists 正确探测会话是否存在", async () => {
      const store = new LocalSessionStore({ baseDir: tempBaseDir });
      await store.appendUserMessage("Exists Test");

      const exists = await LocalSessionStore.sessionExists(
        store.sessionId,
        tempBaseDir
      );
      assert.strictEqual(exists, true);

      const notExists = await LocalSessionStore.sessionExists(
        "non-existent-session-id",
        tempBaseDir
      );
      assert.strictEqual(notExists, false);
    });
  });

  // ==========================================
  // 2. ContextManager 恢复与上下文构建测试
  // ==========================================
  describe("2. ContextManager Session Restore & Context Continuity", () => {
    it("2.1 switchSession 能无缝切换至历史 Session", async () => {
      const storeA = new LocalSessionStore({ baseDir: tempBaseDir });
      await storeA.appendUserMessage("Session A Prompt");

      const cm = new ContextManager({
        baseDir: tempBaseDir,
      });

      const initialId = cm.sessionId;
      assert.notStrictEqual(initialId, storeA.sessionId);

      const summary = await cm.switchSession(storeA.sessionId);
      assert.strictEqual(cm.sessionId, storeA.sessionId);
      assert.strictEqual(summary.sessionId, storeA.sessionId);
      assert.strictEqual(summary.firstUserPrompt, "Session A Prompt");
    });

    it("2.2 restoreActiveMessages 能正确还原普通历史会话为 ChatMessages", async () => {
      const store = new LocalSessionStore({ baseDir: tempBaseDir });
      await store.appendUserMessage("User Q1");
      await store.appendAssistantMessage("Assistant A1");

      const cm = new ContextManager({
        baseDir: tempBaseDir,
        sessionStore: store,
      });

      const restored = await cm.restoreActiveMessages("System prompt instructions");
      assert.strictEqual(restored.length, 3);
      assert.strictEqual(restored[0].role, "system");
      assert.strictEqual(restored[0].content, "System prompt instructions");
      assert.strictEqual(restored[1].role, "user");
      assert.strictEqual(restored[1].content, "User Q1");
      assert.strictEqual(restored[2].role, "assistant");
      assert.strictEqual(restored[2].content, "Assistant A1");
    });

    it("2.3 restoreActiveMessages 恢复经历过 Compaction 的会话时只取 Summary + 后续新消息", async () => {
      const store = new LocalSessionStore({ baseDir: tempBaseDir });
      await store.appendUserMessage("Old Message 1");
      await store.appendAssistantMessage("Old Response 1");
      await store.appendCompactionRecord(
        "1. Primary Goal: Build ts agent\n2. Key Decisions: Modular design",
        { startIndex: 0, endIndex: 1 },
        2
      );
      await store.appendUserMessage("Subsequent Message After Compaction");

      const cm = new ContextManager({
        baseDir: tempBaseDir,
        sessionStore: store,
      });

      const restored = await cm.restoreActiveMessages("System prompt");
      assert.strictEqual(restored.length, 3);
      assert.strictEqual(restored[0].role, "system");
      assert.strictEqual(restored[1].role, "user");
      assert.ok(restored[1].content?.includes("[Context Summary of Previous Conversation]"));
      assert.ok(restored[1].content?.includes("1. Primary Goal: Build ts agent"));
      assert.strictEqual(restored[2].role, "user");
      assert.strictEqual(restored[2].content, "Subsequent Message After Compaction");
    });

    it("2.4 buildChatMessages 正确追加新自然语言输入并继承已有上下文", async () => {
      const cm = new ContextManager({
        baseDir: tempBaseDir,
      });

      const msgTurn1 = await cm.buildChatMessages("Turn 1 Question", "System Rule");
      assert.strictEqual(msgTurn1.length, 2);
      assert.strictEqual(msgTurn1[0].role, "system");
      assert.strictEqual(msgTurn1[1].content, "Turn 1 Question");

      // 模拟 Assistant 回复
      await cm.recordAssistantMessage("Turn 1 Answer");
      msgTurn1.push({ role: "assistant", content: "Turn 1 Answer" });
      cm.setActiveMessages(msgTurn1);

      // 进入 Turn 2
      const msgTurn2 = await cm.buildChatMessages("Turn 2 Question", "System Rule");
      assert.strictEqual(msgTurn2.length, 4);
      assert.strictEqual(msgTurn2[0].role, "system");
      assert.strictEqual(msgTurn2[1].content, "Turn 1 Question");
      assert.strictEqual(msgTurn2[2].content, "Turn 1 Answer");
      assert.strictEqual(msgTurn2[3].content, "Turn 2 Question");
    });
  });

  // ==========================================
  // 3. Slash Commands /resume 交互测试
  // ==========================================
  describe("3. Slash Command /resume & Session Commands", () => {
    it("3.1 isSlashCommand 正确识别斜杠命令", () => {
      assert.strictEqual(isSlashCommand("/resume"), true);
      assert.strictEqual(isSlashCommand("  /resume 1  "), true);
      assert.strictEqual(isSlashCommand("/session"), true);
      assert.strictEqual(isSlashCommand("/new"), true);
      assert.strictEqual(isSlashCommand("hello"), false);
      assert.strictEqual(isSlashCommand("write code in /src"), false);
    });

    it("3.2 /resume 在无历史会话时友好提示", async () => {
      const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-empty-"));
      const input = new PassThrough();
      const output = new PassThrough();
      let outputText = "";
      output.on("data", (chunk) => {
        outputText += chunk.toString();
      });

      const inputManager = new InputManager({ input, output, isTTY: true });
      const terminalUI = new TerminalUI(output);
      const contextManager = new ContextManager({ baseDir: isolatedDir });

      const result = await handleSlashCommand("/resume", {
        inputManager,
        terminalUI,
        contextManager,
        baseDir: isolatedDir,
      });

      assert.strictEqual(result.handled, true);
      assert.ok(outputText.includes("No saved sessions found"));

      inputManager.close();
      await fs.rm(isolatedDir, { recursive: true, force: true });
    });

    it("3.3 /resume 交互式选择会话序号 [1-N] 成功切换", async () => {
      const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-choose-"));

      // 创建两个历史会话
      const s1 = new LocalSessionStore({ baseDir: testDir });
      await s1.appendUserMessage("Session One Task");
      await new Promise((r) => setTimeout(r, 20));

      const s2 = new LocalSessionStore({ baseDir: testDir });
      await s2.appendUserMessage("Session Two Task");

      const input = new PassThrough();
      const output = new PassThrough();
      let outputText = "";
      output.on("data", (chunk) => {
        outputText += chunk.toString();
      });

      const inputManager = new InputManager({ input, output, isTTY: true });
      const terminalUI = new TerminalUI(output);
      const contextManager = new ContextManager({ baseDir: testDir });

      let switchedSessionId: string | undefined;

      const cmdPromise = handleSlashCommand("/resume", {
        inputManager,
        terminalUI,
        contextManager,
        baseDir: testDir,
        onSessionSwitched: (newId) => {
          switchedSessionId = newId;
        },
      });

      // 等待提示词展示后，模拟用户输入 '1' 恢复第一项
      await new Promise((r) => setTimeout(r, 20));
      input.write("1\r");

      const result = await cmdPromise;
      assert.strictEqual(result.handled, true);
      assert.ok(switchedSessionId);
      assert.strictEqual(contextManager.sessionId, switchedSessionId);
      assert.ok(outputText.includes("Session resumed:"));

      inputManager.close();
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("3.4 /resume <index> 或 /resume <id> 直接带参数恢复", async () => {
      const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-param-"));

      const s1 = new LocalSessionStore({ baseDir: testDir });
      await s1.appendUserMessage("Direct Resume Task 1");

      const input = new PassThrough();
      const output = new PassThrough();
      let outputText = "";
      output.on("data", (chunk) => {
        outputText += chunk.toString();
      });

      const inputManager = new InputManager({ input, output, isTTY: true });
      const terminalUI = new TerminalUI(output);
      const contextManager = new ContextManager({ baseDir: testDir });

      // 按序号直接恢复: /resume 1
      const result1 = await handleSlashCommand("/resume 1", {
        inputManager,
        terminalUI,
        contextManager,
        baseDir: testDir,
      });

      assert.strictEqual(result1.handled, true);
      assert.strictEqual(contextManager.sessionId, s1.sessionId);
      assert.ok(outputText.includes("Session resumed:"));

      // 按 Session ID 直接恢复
      const result2 = await handleSlashCommand(`/resume ${s1.sessionId}`, {
        inputManager,
        terminalUI,
        contextManager,
        baseDir: testDir,
      });

      assert.strictEqual(result2.handled, true);
      assert.strictEqual(contextManager.sessionId, s1.sessionId);

      inputManager.close();
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("3.5 /resume 交互时输入 c 或 cancel 正确取消而不改变当前会话", async () => {
      const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-cancel-"));

      const s1 = new LocalSessionStore({ baseDir: testDir });
      await s1.appendUserMessage("Session One Task");

      const input = new PassThrough();
      const output = new PassThrough();
      let outputText = "";
      output.on("data", (chunk) => {
        outputText += chunk.toString();
      });

      const inputManager = new InputManager({ input, output, isTTY: true });
      const terminalUI = new TerminalUI(output);
      const contextManager = new ContextManager({ baseDir: testDir });
      const originalSessionId = contextManager.sessionId;

      const cmdPromise = handleSlashCommand("/resume", {
        inputManager,
        terminalUI,
        contextManager,
        baseDir: testDir,
      });

      await new Promise((r) => setTimeout(r, 20));
      input.write("c\r");

      const result = await cmdPromise;
      assert.strictEqual(result.handled, true);
      assert.strictEqual(contextManager.sessionId, originalSessionId);
      assert.ok(outputText.includes("Resume cancelled."));

      inputManager.close();
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("3.6 /session 展示当前会话详细元数据", async () => {
      const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-session-cmd-"));

      const input = new PassThrough();
      const output = new PassThrough();
      let outputText = "";
      output.on("data", (chunk) => {
        outputText += chunk.toString();
      });

      const inputManager = new InputManager({ input, output, isTTY: true });
      const terminalUI = new TerminalUI(output);
      const contextManager = new ContextManager({ baseDir: testDir });

      await contextManager.recordUserMessage("Test Session Info Message");

      const result = await handleSlashCommand("/session", {
        inputManager,
        terminalUI,
        contextManager,
        baseDir: testDir,
      });

      assert.strictEqual(result.handled, true);
      assert.ok(outputText.includes("[Session Info]"));
      assert.ok(outputText.includes(contextManager.sessionId));
      assert.ok(outputText.includes("Test Session Info Message"));

      inputManager.close();
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("3.7 /new 成功创建并切换至新的 Session ID", async () => {
      const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-new-cmd-"));

      const input = new PassThrough();
      const output = new PassThrough();
      let outputText = "";
      output.on("data", (chunk) => {
        outputText += chunk.toString();
      });

      const inputManager = new InputManager({ input, output, isTTY: true });
      const terminalUI = new TerminalUI(output);
      const contextManager = new ContextManager({ baseDir: testDir });
      const oldId = contextManager.sessionId;

      const result = await handleSlashCommand("/new", {
        inputManager,
        terminalUI,
        contextManager,
        baseDir: testDir,
      });

      assert.strictEqual(result.handled, true);
      assert.notStrictEqual(contextManager.sessionId, oldId);
      assert.ok(outputText.includes("Started new session:"));

      inputManager.close();
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("3.8 /help 打印所有支持的命令清单", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let outputText = "";
      output.on("data", (chunk) => {
        outputText += chunk.toString();
      });

      const inputManager = new InputManager({ input, output, isTTY: true });
      const terminalUI = new TerminalUI(output);
      const contextManager = new ContextManager({ baseDir: tempBaseDir });

      const result = await handleSlashCommand("/help", {
        inputManager,
        terminalUI,
        contextManager,
        baseDir: tempBaseDir,
      });

      assert.strictEqual(result.handled, true);
      assert.ok(outputText.includes("Nash Agent Commands:"));
      assert.ok(outputText.includes("/resume"));
      assert.ok(outputText.includes("/session"));
      assert.ok(outputText.includes("/new"));
      assert.ok(outputText.includes("/compact"));

      inputManager.close();
    });
  });
});
