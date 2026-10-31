import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  ContextManager,
  LocalSpillStore,
  LocalSessionStore,
  TokenMeter,
  ToolResultPruner,
  CompactionEngine,
  COMPACTION_SYSTEM_PROMPT,
  SpillGc,
  SpillArtifactQuotaError,
  SpillSessionQuotaError,
} from "../src/context/index.js";
import { createReadToolResultTool } from "../src/tools/read-tool-result.js";
import type { ChatMessage } from "../src/model/chat-completions-client.js";

describe("Context Management & Compaction Subsystem", () => {
  let tempBaseDir: string;

  before(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-context-test-"));
  });

  after(async () => {
    await fs.rm(tempBaseDir, { recursive: true, force: true });
  });

  // ==========================================
  // 1. Tool Result & Spill Store 测试 (1 - 10)
  // ==========================================
  describe("1. Tool Result & Spill Store Management", () => {
    it("1. 小 ToolResult 不 spill", async () => {
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      const sessionStore = new LocalSessionStore({ baseDir: tempBaseDir });
      const cm = new ContextManager({
        baseDir: tempBaseDir,
        spillStore,
        sessionStore,
        config: {
          spill: {
            enabled: true,
            maxInlineChars: 500,
            maxArtifactBytes: 1024 * 1024,
            maxSessionBytes: 10 * 1024 * 1024,
            maxGlobalBytes: 100 * 1024 * 1024,
            retentionDays: 7,
          },
        },
      });

      const smallResult = {
        success: true,
        output: "Hello, this is a small tool output.",
        executionTimeMs: 12,
      };

      const processed = await cm.processToolResult(
        "read_file",
        "call_1",
        smallResult
      );

      assert.equal(processed.offloaded, false);
      assert.equal(processed.content, "Hello, this is a small tool output.");
      assert.equal(processed.spillRef, undefined);
    });

    it("2. 大 ToolResult 自动 spill", async () => {
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      const sessionStore = new LocalSessionStore({ baseDir: tempBaseDir });
      const cm = new ContextManager({
        baseDir: tempBaseDir,
        spillStore,
        sessionStore,
        config: {
          spill: {
            enabled: true,
            maxInlineChars: 100, // 低阈值触发 spill
            maxArtifactBytes: 1024 * 1024,
            maxSessionBytes: 10 * 1024 * 1024,
            maxGlobalBytes: 100 * 1024 * 1024,
            retentionDays: 7,
          },
        },
      });

      const largeContent = "X".repeat(500);
      const largeResult = {
        success: true,
        output: largeContent,
        executionTimeMs: 50,
      };

      const processed = await cm.processToolResult(
        "bash",
        "call_2",
        largeResult
      );

      assert.equal(processed.offloaded, true);
      assert.ok(processed.spillRef);
      assert.ok(processed.spillRef.locator.startsWith("tool-result://"));
    });

    it("3. context 中只有 preview + SpillRef", async () => {
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      const sessionStore = new LocalSessionStore({ baseDir: tempBaseDir });
      const cm = new ContextManager({
        baseDir: tempBaseDir,
        spillStore,
        sessionStore,
        config: {
          spill: {
            enabled: true,
            maxInlineChars: 50,
            maxArtifactBytes: 1024 * 1024,
            maxSessionBytes: 10 * 1024 * 1024,
            maxGlobalBytes: 100 * 1024 * 1024,
            retentionDays: 7,
          },
        },
      });

      const rawText = "Line 1: important header\n" + "A".repeat(1000);
      const processed = await cm.processToolResult("grep_search", "call_3", {
        success: true,
        output: rawText,
      });

      assert.ok(processed.content.includes("Tool output exceeded the inline context limit."));
      assert.ok(processed.content.includes("Preview:"));
      assert.ok(processed.content.includes("Full output archived as:"));
      assert.ok(processed.content.includes(processed.spillRef!.locator));
      assert.ok(processed.content.includes("Original size:"));
      assert.ok(processed.content.includes("Use read_tool_result with an offset/limit to inspect additional content."));
      assert.ok(!processed.content.includes("A".repeat(800)), "Context 中不应包含全部超长正文");
    });

    it("4. session JSONL 不重复存完整 ToolResult", async () => {
      const sessionStore = new LocalSessionStore({ baseDir: tempBaseDir });
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      const cm = new ContextManager({
        baseDir: tempBaseDir,
        spillStore,
        sessionStore,
        config: {
          spill: {
            enabled: true,
            maxInlineChars: 50,
            maxArtifactBytes: 1024 * 1024,
            maxSessionBytes: 10 * 1024 * 1024,
            maxGlobalBytes: 100 * 1024 * 1024,
            retentionDays: 7,
          },
        },
      });

      const bigPayload = "SECRET_SUPER_LONG_OUTPUT_".repeat(200);
      await cm.processToolResult("bash", "call_4", {
        success: true,
        output: bigPayload,
      });

      const records = await sessionStore.getRecords();
      const toolRecord = records.find((r) => r.type === "tool_result");
      assert.ok(toolRecord);
      assert.equal(toolRecord.type, "tool_result");
      assert.equal(toolRecord.offloaded, true);
      assert.equal(toolRecord.content, undefined);
      assert.ok(toolRecord.spillRef);
      assert.ok(toolRecord.preview);
      assert.equal(toolRecord.originalChars, bigPayload.length);
    });

    it("5. spill 内容完整一致", async () => {
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      const largeContent = "First line\nSecond line\n" + "Data block 12345\n".repeat(50);

      const ref = await spillStore.save(largeContent, {
        sessionId: "session-5",
        toolName: "read_file",
      });

      const readResult = await spillStore.read(ref.id, {
        maxChars: 100000,
      });

      assert.equal(readResult.content, largeContent);
      assert.equal(readResult.totalChars, largeContent.length);
      assert.equal(readResult.totalLines, largeContent.split("\n").length);
    });

    it("6. read_tool_result 可重新读取", async () => {
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      const content = "Row 1\nRow 2\nRow 3\nRow 4\nRow 5";
      const ref = await spillStore.save(content, { sessionId: "session-6" });

      const tool = createReadToolResultTool(spillStore);
      const output = (await tool.execute({
        id: ref.locator,
        offset: 1,
        limit: 10,
      })) as string;

      assert.ok(output.includes(ref.locator));
      assert.ok(output.includes("Row 1\nRow 2\nRow 3\nRow 4\nRow 5"));
    });

    it("7. 行分页正确", async () => {
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
      const content = lines.join("\n");
      const ref = await spillStore.save(content, { sessionId: "session-7" });

      const page1 = await spillStore.read(ref.id, {
        offset: 1,
        limit: 20,
      });

      assert.equal(page1.startLine, 1);
      assert.equal(page1.endLine, 20);
      assert.equal(page1.totalLines, 50);
      assert.equal(page1.hasMore, true);
      assert.equal(page1.nextLineOffset, 21);

      const page2 = await spillStore.read(ref.id, {
        offset: page1.nextLineOffset,
        limit: 20,
      });

      assert.equal(page2.startLine, 21);
      assert.equal(page2.endLine, 40);
      assert.equal(page2.hasMore, true);
      assert.equal(page2.nextLineOffset, 41);

      const page3 = await spillStore.read(ref.id, {
        offset: page2.nextLineOffset,
        limit: 20,
      });

      assert.equal(page3.startLine, 41);
      assert.equal(page3.endLine, 50);
      assert.equal(page3.hasMore, false);
    });

    it("8. 超长单行受到 maxChars 限制", async () => {
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      // 构造一条长达 100,000 字符的单行（中间无换行）
      const ultraLongSingleLine = "A".repeat(100_000);
      const ref = await spillStore.save(ultraLongSingleLine, { sessionId: "session-8" });

      // 即使只请求 limit: 1，依然受到 maxChars 限制
      const result = await spillStore.read(ref.id, {
        offset: 1,
        limit: 1,
        maxChars: 5000,
      });

      assert.equal(result.content.length, 5000);
      assert.equal(result.hasMore, true);
      assert.equal(result.nextCharOffset, 5000);
    });

    it("9. continuation offset 正确", async () => {
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      const raw = "0123456789".repeat(100); // 1000 chars
      const ref = await spillStore.save(raw, { sessionId: "session-9" });

      const part1 = await spillStore.read(ref.id, {
        charOffset: 0,
        maxChars: 300,
      });

      assert.equal(part1.content.length, 300);
      assert.equal(part1.startChar, 0);
      assert.equal(part1.endChar, 300);
      assert.equal(part1.hasMore, true);
      assert.equal(part1.nextCharOffset, 300);

      const part2 = await spillStore.read(ref.id, {
        charOffset: part1.nextCharOffset,
        maxChars: 400,
      });

      assert.equal(part2.content.length, 400);
      assert.equal(part2.startChar, 300);
      assert.equal(part2.endChar, 700);
      assert.equal(part2.hasMore, true);
      assert.equal(part2.nextCharOffset, 700);

      const part3 = await spillStore.read(ref.id, {
        charOffset: part2.nextCharOffset,
        maxChars: 500,
      });

      assert.equal(part3.content.length, 300);
      assert.equal(part3.startChar, 700);
      assert.equal(part3.endChar, 1000);
      assert.equal(part3.hasMore, false);
      assert.equal(part3.nextCharOffset, undefined);
    });

    it("10. read spill 不产生第二个 spill", async () => {
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      const sessionStore = new LocalSessionStore({ baseDir: tempBaseDir });
      const cm = new ContextManager({
        baseDir: tempBaseDir,
        spillStore,
        sessionStore,
        config: {
          spill: {
            enabled: true,
            maxInlineChars: 100, // 很低门槛
          },
        },
      });

      const initialArtifactCount = (await spillStore.list()).length;

      // 模拟 read_tool_result 工具执行返回了 5000 字符的切片
      const readToolOutput = "Slice content: " + "K".repeat(5000);
      const processed = await cm.processToolResult(
        "read_tool_result",
        "call_read_1",
        {
          success: true,
          output: readToolOutput,
        }
      );

      // read_tool_result 绝不会产生新的 spill artifact
      assert.equal(processed.offloaded, false);
      assert.equal(processed.content, readToolOutput);
      const finalArtifactCount = (await spillStore.list()).length;
      assert.equal(finalArtifactCount, initialArtifactCount);
    });
  });

  // ==========================================
  // 2. TokenMeter 测试 (11 - 14)
  // ==========================================
  describe("2. TokenMeter Pressure Measurement", () => {
    it("11. 正确读取 contextWindow", () => {
      const meter = new TokenMeter({
        contextWindow: 1_000_000,
        compactionThreshold: 0.8,
      });
      assert.equal(meter.contextWindow, 1_000_000);
    });

    it("12. 正确读取 compactionThreshold", () => {
      const meter = new TokenMeter({
        contextWindow: 64_000,
        compactionThreshold: 0.75,
      });
      assert.equal(meter.compactionThreshold, 0.75);
    });

    it("13. threshold 未达到时不 compact", () => {
      const meter = new TokenMeter({
        contextWindow: 100_000,
        compactionThreshold: 0.8, // 阈值 80,000 tokens
      });

      const messages: ChatMessage[] = [
        { role: "system", content: "You are an assistant." },
        { role: "user", content: "Hello, what is the weather?" },
      ];

      const metrics = meter.measure(messages);
      assert.ok(metrics.estimatedInputTokens < 100);
      assert.ok(metrics.usageRatio < 0.01);
      assert.equal(metrics.shouldCompact, false);
    });

    it("14. threshold 达到时触发治理", () => {
      const meter = new TokenMeter({
        contextWindow: 1000,
        compactionThreshold: 0.5, // 阈值 500 tokens (约 1900 字符)
      });

      const bigContent = "Word ".repeat(600); // 3000 chars -> ~750 tokens
      const messages: ChatMessage[] = [
        { role: "system", content: "System prompt" },
        { role: "user", content: bigContent },
      ];

      const metrics = meter.measure(messages);
      assert.ok(metrics.estimatedInputTokens >= 500);
      assert.ok(metrics.usageRatio >= 0.5);
      assert.equal(metrics.shouldCompact, true);
    });
  });

  // ==========================================
  // 3. ToolResultPruner 测试 (15 - 17)
  // ==========================================
  describe("3. ToolResultPruner", () => {
    it("15. 优先 prune 旧 ToolResult", () => {
      const pruner = new ToolResultPruner({ keepRecentToolCount: 1 });

      const messages: ChatMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "Run search" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_old_1",
              type: "function",
              function: { name: "grep_search", arguments: JSON.stringify({ pattern: "test" }) },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_old_1",
          content: "VERY_LONG_GREP_OUTPUT_".repeat(100),
        },
        { role: "user", content: "Next step" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_recent_2",
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "foo.ts" }) },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_recent_2",
          content: "RECENT_FILE_CONTENT_PRESERVED",
        },
      ];

      const result = pruner.prune(messages);
      assert.equal(result.prunedCount, 1);
      assert.ok(result.freedChars > 1000);

      const oldToolMsg = result.messages[3];
      assert.ok(oldToolMsg.content?.includes("[Previous tool output pruned]"));
      assert.ok(oldToolMsg.content?.includes("tool: grep_search"));
      assert.ok(oldToolMsg.content?.includes("tool_call_id: call_old_1"));

      const recentToolMsg = result.messages[6];
      assert.equal(recentToolMsg.content, "RECENT_FILE_CONTENT_PRESERVED", "最近的 ToolResult 应当保持未修剪");
    });

    it("16. 不破坏 tool_call / tool_result 对应关系", () => {
      const pruner = new ToolResultPruner({ keepRecentToolCount: 0 });

      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_xyz",
              type: "function",
              function: { name: "bash", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_xyz",
          content: "Huge log 12345",
        },
      ];

      const result = pruner.prune(messages);
      assert.equal(result.messages[1].tool_call_id, "call_xyz");
      assert.equal(result.messages[0].tool_calls?.[0].id, "call_xyz");
    });

    it("17. SpillRef 被保留", () => {
      const pruner = new ToolResultPruner({ keepRecentToolCount: 0 });

      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_spill_ref_test",
              type: "function",
              function: { name: "bash", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_spill_ref_test",
          content: "Tool output exceeded limit.\nFull output archived as:\ntool-result://artifact-999\nOriginal size: 100000",
        },
      ];

      const result = pruner.prune(messages);
      const prunedContent = result.messages[1].content!;
      assert.ok(prunedContent.includes("spill_ref: tool-result://artifact-999"));
    });
  });

  // ==========================================
  // 4. Full Compaction 测试 (18 - 24)
  // ==========================================
  describe("4. Compaction Engine & Governance", () => {
    it("18. prune 后仍超限才触发 Full Compaction", async () => {
      let compactionCalled = false;
      const fakeLlmInvoker = async (msgs: ChatMessage[]) => {
        compactionCalled = true;
        return "Structured Summary\n1. Primary Goal: Done";
      };

      const sessionStore = new LocalSessionStore({ baseDir: tempBaseDir });
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      const pruner = new ToolResultPruner({ keepRecentToolCount: 1 });

      const meter = new TokenMeter({
        contextWindow: 1000,
        compactionThreshold: 0.5, // 500 tokens
      });

      const compactionEngine = new CompactionEngine({
        keepRecentMessages: 2,
        llmInvoker: fakeLlmInvoker,
      });

      const cm = new ContextManager({
        baseDir: tempBaseDir,
        sessionStore,
        spillStore,
        tokenMeter: meter,
        pruner,
        compactionEngine,
      });

      // 构造超长对话（多条 user/assistant 纯文本消息，Pruner 无法完全缩减）
      const messages: ChatMessage[] = [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Long message 1: " + "A".repeat(2000) },
        { role: "assistant", content: "Long answer 1: " + "B".repeat(2000) },
        { role: "user", content: "Long message 2: " + "C".repeat(2000) },
      ];

      const prepared = await cm.prepare(messages);
      assert.equal(compactionCalled, true);
      assert.ok(prepared[1].content?.includes("[Context Summary of Previous Conversation]"));
    });

    it("19. 最近 messages 保留原文", async () => {
      const engine = new CompactionEngine({
        keepRecentMessages: 2,
        llmInvoker: async () => "Summary of history",
      });

      const messages: ChatMessage[] = [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Old question 1" },
        { role: "assistant", content: "Old answer 1" },
        { role: "user", content: "Recent question 2" },
        { role: "assistant", content: "Recent answer 2" },
      ];

      const res = await engine.compact(messages);
      assert.equal(res.compactedMessages.length, 4); // System + Summary + Recent user + Recent assistant
      assert.equal(res.compactedMessages[0].content, "System prompt");
      assert.ok(res.compactedMessages[1].content?.includes("[Context Summary of Previous Conversation]"));
      assert.equal(res.compactedMessages[2].content, "Recent question 2");
      assert.equal(res.compactedMessages[3].content, "Recent answer 2");
    });

    it("20. 老消息被 summary 替代", async () => {
      const engine = new CompactionEngine({
        keepRecentMessages: 1,
        llmInvoker: async () => "1. Primary Goal: Test\n2. Key Decisions: None",
      });

      const messages: ChatMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "Old message Alpha" },
        { role: "assistant", content: "Old message Beta" },
        { role: "user", content: "Latest Gamma" },
      ];

      const res = await engine.compact(messages);
      const combined = res.compactedMessages.map((m) => m.content).join("\n");
      assert.ok(!combined.includes("Old message Alpha"));
      assert.ok(!combined.includes("Old message Beta"));
      assert.ok(combined.includes("Latest Gamma"));
      assert.ok(combined.includes("1. Primary Goal: Test"));
    });

    it("21. Durable Session 原始历史仍存在", async () => {
      const sessionStore = new LocalSessionStore({ baseDir: tempBaseDir });
      const cm = new ContextManager({
        baseDir: tempBaseDir,
        sessionStore,
        tokenMeter: new TokenMeter({ contextWindow: 40, compactionThreshold: 0.5 }),
        compactionEngine: new CompactionEngine({
          keepRecentMessages: 1,
          llmInvoker: async () => "Summary 1",
        }),
      });

      await cm.recordUserMessage("User query 1");
      await cm.recordAssistantMessage("Assistant response 1");
      await cm.recordUserMessage("User query 2");

      const activeMessages: ChatMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "User query 1" },
        { role: "assistant", content: "Assistant response 1" },
        { role: "user", content: "User query 2" },
      ];

      await cm.prepare(activeMessages);

      const records = await sessionStore.getRecords();
      const userRecords = records.filter((r) => r.type === "user");
      const assistantRecords = records.filter((r) => r.type === "assistant");
      const compactionRecords = records.filter((r) => r.type === "compaction");

      assert.equal(userRecords.length, 2, "原始 User 记录必须完整保留在 Session 中");
      assert.equal(assistantRecords.length, 1, "原始 Assistant 记录必须完整保留在 Session 中");
      assert.equal(compactionRecords.length, 1, "Compaction 事件作为独立记录追加");
    });

    it("22. Compaction 调用绝不携带 tools", async () => {
      const engine = new CompactionEngine({
        keepRecentMessages: 1,
        llmInvoker: async (msgs) => {
          // 检查传入的 messages
          assert.equal(msgs[0].role, "system");
          assert.equal(msgs[0].content, COMPACTION_SYSTEM_PROMPT);
          return "Summary generated without tools";
        },
      });

      const messages: ChatMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "Msg 1" },
        { role: "assistant", content: "Msg 2" },
        { role: "user", content: "Msg 3" },
      ];

      await engine.compact(messages);
    });

    it("23. Compact Prompt 不允许 Tool Loop", () => {
      assert.ok(COMPACTION_SYSTEM_PROMPT.includes("Do not call tools."));
      assert.ok(COMPACTION_SYSTEM_PROMPT.includes("Do not perform new work."));
      assert.ok(COMPACTION_SYSTEM_PROMPT.includes("1. Primary Goal"));
      assert.ok(COMPACTION_SYSTEM_PROMPT.includes("12. Immediate Next Step"));
    });

    it("24. 第二次 Compaction 能 consolidate previous summary", async () => {
      let promptSentToLlm = "";
      const engine = new CompactionEngine({
        keepRecentMessages: 1,
        llmInvoker: async (msgs) => {
          promptSentToLlm = msgs.map((m) => m.content).join("\n");
          return "Consolidated Summary 2";
        },
      });

      const messages: ChatMessage[] = [
        { role: "system", content: "System" },
        {
          role: "user",
          content: "[Context Summary of Previous Conversation]\n\nSummary 1 from previous compaction",
        },
        { role: "user", content: "New intermediate request" },
        { role: "assistant", content: "New intermediate response" },
        { role: "user", content: "Latest request" },
      ];

      const res = await engine.compact(messages);
      assert.ok(promptSentToLlm.includes("PREVIOUS CONSOLIDATED SUMMARY"));
      assert.ok(promptSentToLlm.includes("Summary 1 from previous compaction"));
      assert.ok(promptSentToLlm.includes("New intermediate request"));
      assert.equal(res.record.consolidatedCount, 2);
    });
  });

  // ==========================================
  // 5. Session & Storage 测试 (25 - 30)
  // ==========================================
  describe("5. Session Store & Spill Quotas", () => {
    it("25. Session JSONL 可重新读取", async () => {
      const sessionId = "session-resume-test-" + Date.now();
      const sessionStore = new LocalSessionStore({
        sessionId,
        baseDir: tempBaseDir,
      });

      await sessionStore.appendUserMessage("Hello Session");
      await sessionStore.appendAssistantMessage("Hi there");
      await sessionStore.appendToolResult("call_1", "read_file", {
        content: "File contents",
        originalChars: 13,
        offloaded: false,
        success: true,
      });

      // 重新从相同 sessionId 实例化
      const reloadedStore = new LocalSessionStore({
        sessionId,
        baseDir: tempBaseDir,
      });

      const records = await reloadedStore.getRecords();
      assert.equal(records.length, 3);
      assert.equal(records[0].type, "user");
      assert.equal(records[1].type, "assistant");
      assert.equal(records[2].type, "tool_result");

      const chatMsgs = await reloadedStore.toChatMessages();
      assert.equal(chatMsgs.length, 3);
      assert.equal(chatMsgs[0].content, "Hello Session");
    });

    it("26. spilled ToolResult 可以从 session reference 找到", async () => {
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      const sessionStore = new LocalSessionStore({ baseDir: tempBaseDir });
      const cm = new ContextManager({
        baseDir: tempBaseDir,
        spillStore,
        sessionStore,
        config: {
          spill: {
            enabled: true,
            maxInlineChars: 20,
          },
        },
      });

      const bigOutput = "Exact content preserved in spill file: " + "Z".repeat(500);
      await cm.processToolResult("bash", "call_ref_lookup", {
        success: true,
        output: bigOutput,
      });

      const records = await sessionStore.getRecords();
      const toolRec = records.find((r) => r.type === "tool_result");
      assert.ok(toolRec && toolRec.spillRef);

      // 通过 session 记录中的 spillRef 直接去 SpillStore 寻找读取
      const artifact = await spillStore.get(toolRec.spillRef);
      assert.ok(artifact);
      assert.equal(artifact.toolName, "bash");
      assert.equal(artifact.chars, bigOutput.length);

      const readBack = await spillStore.read(toolRec.spillRef, { maxChars: 10000 });
      assert.equal(readBack.content, bigOutput);
    });

    it("27. 单 artifact quota 生效", async () => {
      const spillStore = new LocalSpillStore({
        baseDir: tempBaseDir,
        policy: {
          maxArtifactBytes: 500, // 500 字节上限
        },
      });

      const oversized = "A".repeat(1000);
      await assert.rejects(
        async () => {
          await spillStore.save(oversized, { sessionId: "quota-test-1" });
        },
        SpillArtifactQuotaError
      );
    });

    it("28. session quota 生效", async () => {
      const spillStore = new LocalSpillStore({
        baseDir: tempBaseDir,
        policy: {
          maxArtifactBytes: 1000,
          maxSessionBytes: 1500, // Session 上限 1500 字节
        },
      });

      const sessionId = "quota-session-" + Date.now();
      await spillStore.save("A".repeat(800), { sessionId });

      // 第二次写入导致累计 1600 字节超过 1500
      await assert.rejects(
        async () => {
          await spillStore.save("B".repeat(800), { sessionId });
        },
        SpillSessionQuotaError
      );
    });

    it("29. GC 不删除 active session artifact", async () => {
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      const gc = new SpillGc({
        baseDir: tempBaseDir,
        spillStore,
        policy: {
          retentionDays: 0, // 即刻过期策略
        },
      });

      const activeSessionId = "active-session-" + Date.now();
      const inactiveSessionId = "inactive-session-" + Date.now();

      const artActive = await spillStore.save("active content", { sessionId: activeSessionId });
      const artInactive = await spillStore.save("inactive content", { sessionId: inactiveSessionId });

      const gcRes = await gc.run({
        activeSessionIds: [activeSessionId],
        force: true,
      });

      assert.ok(gcRes.deletedArtifacts >= 1);

      const checkActive = await spillStore.get(artActive.id);
      assert.ok(checkActive !== null, "Active session 的 artifact 必须受到保护不被删除");

      const checkInactive = await spillStore.get(artInactive.id);
      assert.equal(checkInactive, null, "Inactive session 的过期 artifact 应当被清理");
    });

    it("30. expired ended-session artifact 可清理", async () => {
      const spillStore = new LocalSpillStore({ baseDir: tempBaseDir });
      const gc = new SpillGc({
        baseDir: tempBaseDir,
        spillStore,
        policy: {
          retentionDays: 0,
        },
      });

      const endedSessionId = "ended-session-" + Date.now();
      const art = await spillStore.save("old data", { sessionId: endedSessionId });

      const res = await gc.run({
        activeSessionIds: [],
        force: true,
      });

      assert.ok(res.deletedArtifacts >= 1);
      const check = await spillStore.get(art.id);
      assert.equal(check, null);
    });
  });
});
