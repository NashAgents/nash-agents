import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  ContextManager,
  LocalSpillStore,
  LocalSessionStore,
  TokenMeter,
  ToolResultPruner,
  CompactionEngine,
} from "../src/context/index.js";
import { createReadToolResultTool } from "../src/tools/read-tool-result.js";
import type { ChatMessage } from "../src/model/chat-completions-client.js";

describe("Context Management Real E2E Scenarios", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-e2e-context-"));
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // 场景 1: 让 bash 产生明显超过 maxInlineChars 的输出 -> 确认 spill -> context 只有 preview + ref
  it("E2E 场景 1: bash 产生超长输出 -> 自动 spill 并仅向 context 提供 preview + ref", async () => {
    const spillStore = new LocalSpillStore({ baseDir: tempDir });
    const sessionStore = new LocalSessionStore({ baseDir: tempDir });

    const cm = new ContextManager({
      baseDir: tempDir,
      spillStore,
      sessionStore,
      config: {
        spill: {
          enabled: true,
          maxInlineChars: 200, // 较低阈值验证超长截断
        },
      },
    });

    const superLongLog = Array.from({ length: 100 }, (_, i) => `[LOG ${i + 1}] Build step succeeded with hash ${i * 999999}`).join("\n");

    const processed = await cm.processToolResult("bash", "call_bash_e2e_1", {
      success: true,
      output: superLongLog,
    });

    assert.equal(processed.offloaded, true);
    assert.ok(processed.spillRef);
    assert.ok(processed.content.includes("Tool output exceeded the inline context limit."));
    assert.ok(processed.content.includes(processed.spillRef.locator));
    assert.ok(processed.content.includes("Use read_tool_result"));
    assert.ok(processed.content.length < superLongLog.length);
  });

  // 场景 2: 让 Agent 使用 read_tool_result 继续读取后半部分 -> 确认分页正确
  it("E2E 场景 2: 使用 read_tool_result 读取溢出产物的后半部分", async () => {
    const spillStore = new LocalSpillStore({ baseDir: tempDir });
    const longData = Array.from({ length: 30 }, (_, i) => `RowItem_${i + 1}_val`).join("\n");
    const ref = await spillStore.save(longData, { sessionId: "e2e-session-2" });

    const readTool = createReadToolResultTool(spillStore);

    // 读取后半部分：offset = 16, limit = 15
    const result = await readTool.execute({
      id: ref.locator,
      offset: 16,
      limit: 15,
    });

    assert.ok(result.includes("Lines 16-30 of 30"));
    assert.ok(result.includes("RowItem_16_val"));
    assert.ok(result.includes("RowItem_30_val"));
    assert.ok(!result.includes("RowItem_1_val"), "后半段不应包含前半段的 RowItem_1_val");
  });

  // 场景 3: 生成一个单行超长文件 -> 确认 read_tool_result / read_file 不会因为只有 1 行而塞入整个超长内容
  it("E2E 场景 3: 单行超长内容受到 maxChars 硬约束，不会因单行而撑爆上下文", async () => {
    const spillStore = new LocalSpillStore({ baseDir: tempDir });
    const singleLine2MB = "A".repeat(2_000_000);
    const ref = await spillStore.save(singleLine2MB, { sessionId: "e2e-session-3" });

    const readTool = createReadToolResultTool(spillStore);
    const result = await readTool.execute({
      id: ref.locator,
      offset: 1,
      limit: 1, // 只读 1 行
      maxChars: 5000,
    });

    assert.ok(result.length < 10000, "返回文本必须在万级以内安全截断");
    assert.ok(result.includes("hasMore: true"));
    assert.ok(result.includes("nextCharOffset: 5000"));
  });

  // 场景 4: 构造足够大的 fake conversation -> 达到 contextWindow * compactionThreshold -> 先 prune -> 不够 -> full compact
  it("E2E 场景 4: 构造大体积对话触发两阶段治理 (先 Prune -> 仍超限则 Full Compact)", async () => {
    let compactionInvoked = false;

    const pruner = new ToolResultPruner({ keepRecentToolCount: 1 });
    const meter = new TokenMeter({
      contextWindow: 1000,
      compactionThreshold: 0.5, // 500 tokens
    });

    const compactionEngine = new CompactionEngine({
      keepRecentMessages: 2,
      llmInvoker: async () => {
        compactionInvoked = true;
        return `1. Primary Goal: Complete context management\n2. Key Decisions: Use LocalSpillStore\n3. Security: Fail-Closed`;
      },
    });

    const cm = new ContextManager({
      baseDir: tempDir,
      tokenMeter: meter,
      pruner,
      compactionEngine,
    });

    // 构造大对话历史
    const activeMessages: ChatMessage[] = [
      { role: "system", content: "System instructions" },
      { role: "user", content: "Initial requirement" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_big_1",
            type: "function",
            function: { name: "grep_search", arguments: JSON.stringify({ pattern: "test" }) },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_big_1",
        content: "OLD_GREP_RESULT_".repeat(100),
      },
      { role: "user", content: "Very large user context details: " + "X".repeat(2000) },
      { role: "assistant", content: "Very large assistant intermediate response: " + "Y".repeat(2000) },
      { role: "user", content: "Latest prompt to proceed" },
    ];

    const prepared = await cm.prepare(activeMessages);

    assert.equal(compactionInvoked, true, "应当触发 Full Compaction");
    assert.ok(prepared[1].content?.includes("[Context Summary of Previous Conversation]"));
    assert.ok(prepared[1].content?.includes("1. Primary Goal: Complete context management"));
    assert.equal(prepared[prepared.length - 1].content, "Latest prompt to proceed");
  });

  // 场景 5: Compact 后继续运行 Agent -> 确认模型仍能获取目标、状态、Pending Task、Security 约束
  it("E2E 场景 5: Compact 后生成的上下文使模型保留任务状态、安全约束与目标", async () => {
    const summaryText = [
      "1. Primary Goal",
      "   - Implement Context Management for nash-agents.",
      "",
      "2. Current Architecture / State",
      "   - LocalSpillStore and LocalSessionStore are implemented.",
      "",
      "3. Key Decisions",
      "   - Fail-closed sandbox, no docker, opaque SpillRef.",
      "",
      "7. Security and Safety Constraints",
      "   - Filesystem workspace-write, network deny, approval ask.",
      "",
      "9. Pending Tasks",
      "   - Verify E2E scenarios.",
      "",
      "12. Immediate Next Step",
      "   - Run test suite.",
    ].join("\n");

    const engine = new CompactionEngine({
      keepRecentMessages: 1,
      llmInvoker: async () => summaryText,
    });

    const cm = new ContextManager({
      baseDir: tempDir,
      compactionEngine: engine,
    });

    const compacted = await cm.compactNow([
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Start work on context system." },
      { role: "assistant", content: "I will design types." },
      { role: "user", content: "Please run test suite now." },
    ]);

    assert.ok(compacted);
    assert.ok(compacted.summary.includes("1. Primary Goal"));
    assert.ok(compacted.summary.includes("7. Security and Safety Constraints"));
    assert.ok(compacted.summary.includes("9. Pending Tasks"));
    assert.ok(compacted.summary.includes("12. Immediate Next Step"));
  });
});
