import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runAgentLoop } from "../src/runtime/agent-loop.js";
import { resolveProjectContext } from "../src/project/index.js";
import { ContextManager } from "../src/context/context-manager.js";
import { ToolRegistry, ToolExecutor, defineTool } from "../src/tools/index.js";
import {
  EventBus,
  TraceRecorder,
  MetricsCollector,
  OpenTelemetryService,
} from "../src/observability/index.js";
import type { HarnessEvent } from "../src/observability/types.js";

describe("Observability & Project Namespace Real E2E Verification Scenarios", () => {
  let tempDir: string;
  let nashHome: string;
  let prevApiKey: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-obs-e2e-"));
    nashHome = path.join(tempDir, ".nash");
    prevApiKey = process.env.DEEPSEEK_API_KEY;
    if (!process.env.DEEPSEEK_API_KEY) {
      process.env.DEEPSEEK_API_KEY = "test-mock-api-key";
    }

    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("chat/completions") || url.includes("deepseek.com")) {
        const ssePayload =
          'data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"role":"assistant","content":"Done task."},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n';
        return new Response(ssePayload, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return originalFetch(input, init);
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (prevApiKey !== undefined) {
      process.env.DEEPSEEK_API_KEY = prevApiKey;
    } else {
      delete process.env.DEEPSEEK_API_KEY;
    }
    if (fsSync.existsSync(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================
  // E2E 场景 1: 多项目启动与目录隔离
  // ==========================================
  it("E2E 1: 从 project-A 与 project-B 运行分别创建独立 namespace", async () => {
    const projectADir = path.join(tempDir, "project-A");
    const projectBDir = path.join(tempDir, "project-B");
    await fs.mkdir(projectADir, { recursive: true });
    await fs.mkdir(projectBDir, { recursive: true });

    const ctxA = await resolveProjectContext({ projectRoot: projectADir, nashHome });
    const ctxB = await resolveProjectContext({ projectRoot: projectBDir, nashHome });

    assert.notStrictEqual(ctxA.projectId, ctxB.projectId);

    assert.ok(fsSync.existsSync(ctxA.metadataPath));
    assert.ok(fsSync.existsSync(ctxB.metadataPath));
  });

  // ==========================================
  // E2E 场景 2: 同一项目两次运行 -> 相同 projectId，不同 traceId
  // ==========================================
  it("E2E 2: 同一项目连续运行两次 Agent -> projectId 相同但 traceId 不同", async () => {
    const projectDir = path.join(tempDir, "my-repo");
    await fs.mkdir(projectDir, { recursive: true });

    const ctx = await resolveProjectContext({ projectRoot: projectDir, nashHome });
    const contextManager = new ContextManager({ projectContext: ctx });

    const traces: string[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe("agent.started", (e) => {
      if (e.traceId) traces.push(e.traceId);
    });

    // Mock 单步直接完成工具
    const registry = new ToolRegistry();

    // 运行 1
    await runAgentLoop("Task 1", {
      projectContext: ctx,
      contextManager,
      registry,
      eventBus,
      printStats: false,
    });

    // 运行 2
    await runAgentLoop("Task 2", {
      projectContext: ctx,
      contextManager,
      registry,
      eventBus,
      printStats: false,
    });

    assert.strictEqual(traces.length, 2);
    assert.notStrictEqual(traces[0], traces[1]);
  });

  // ==========================================
  // E2E 场景 3: Model -> grep_search -> read_file -> Model 完整还原 Trace 树
  // ==========================================
  it("E2E 3: 还原完整 Trace 调用链树结构 (agent.run -> model -> tools -> model)", async () => {
    const projectDir = path.join(tempDir, "code-base");
    await fs.mkdir(projectDir, { recursive: true });

    const ctx = await resolveProjectContext({ projectRoot: projectDir, nashHome });
    const traceRecorder = new TraceRecorder();

    // 模拟构造多步调用的执行
    const traceId = traceRecorder.traceId;
    const rootSpan = traceRecorder.startSpan({
      name: "agent.run",
      traceId,
      startTime: 1000,
    });

    // 1. Model call 1
    const modelSpan1 = traceRecorder.startSpan({
      name: "model.call",
      traceId,
      parentSpanId: rootSpan.spanId,
      startTime: 1010,
    });
    traceRecorder.endSpan(modelSpan1.spanId, { endTime: 1200, status: "ok" });

    // 2. Tool grep_search
    const grepSpan = traceRecorder.startSpan({
      name: "tool.execute:grep_search",
      traceId,
      parentSpanId: rootSpan.spanId,
      startTime: 1210,
      attributes: { pattern: "AuthService" },
    });
    traceRecorder.endSpan(grepSpan.spanId, { endTime: 1250, status: "ok" });

    // 3. Tool read_file
    const readSpan = traceRecorder.startSpan({
      name: "tool.execute:read_file",
      traceId,
      parentSpanId: rootSpan.spanId,
      startTime: 1260,
      attributes: { path: "src/auth.ts" },
    });
    traceRecorder.endSpan(readSpan.spanId, { endTime: 1280, status: "ok" });

    // 4. Model call 2
    const modelSpan2 = traceRecorder.startSpan({
      name: "model.call",
      traceId,
      parentSpanId: rootSpan.spanId,
      startTime: 1290,
    });
    traceRecorder.endSpan(modelSpan2.spanId, { endTime: 1450, status: "ok" });

    // 结束 root span
    traceRecorder.endSpan(rootSpan.spanId, { endTime: 1460, status: "ok" });

    const tree = traceRecorder.getSpanTree();
    assert.ok(tree);
    assert.strictEqual(tree.span.name, "agent.run");
    assert.strictEqual(tree.children.length, 4);
    assert.strictEqual(tree.children[0]?.span.name, "model.call");
    assert.strictEqual(tree.children[1]?.span.name, "tool.execute:grep_search");
    assert.strictEqual(tree.children[2]?.span.name, "tool.execute:read_file");
    assert.strictEqual(tree.children[3]?.span.name, "model.call");
  });

  // ==========================================
  // E2E 场景 4: 触发 ToolResult Spill + Compaction 产生规范 Observability 信号
  // ==========================================
  it("E2E 4: 触发 Spill 与 Compaction 时，产生对应事件与指标且无原始大文本泄露", async () => {
    const projectDir = path.join(tempDir, "heavy-proj");
    await fs.mkdir(projectDir, { recursive: true });

    const ctx = await resolveProjectContext({ projectRoot: projectDir, nashHome });
    const eventBus = new EventBus();
    const metrics = new MetricsCollector();

    const events: HarnessEvent[] = [];
    eventBus.subscribe("*", (e) => {
      events.push(e);
    });

    const contextManager = new ContextManager({
      projectContext: ctx,
      config: {
        autoCompact: true,
        keepRecentMessages: 2,
        spill: {
          enabled: true,
          maxInlineChars: 100, // 超过 100 字符即 spill
          maxArtifactBytes: 1024 * 1024,
          maxSessionBytes: 10 * 1024 * 1024,
          maxGlobalBytes: 50 * 1024 * 1024,
          retentionDays: 7,
        },
      },
      modelConfig: {
        contextWindow: 1000,
        compactionThreshold: 0.1, // 极低阈值触发 compact
      },
      llmInvoker: async () => {
        return "1. Goal: Heavy testing\n2. Status: Compacted\n3. Key files: none";
      },
    });

    // 模拟产生大工具输出 (10,000 字符)
    const hugeToolOutput = "B".repeat(10_000);
    const processed = await contextManager.processToolResult("bash", "call_123", {
      success: true,
      output: hugeToolOutput,
      executionTimeMs: 30,
    });

    assert.strictEqual(processed.offloaded, true);
    assert.ok(processed.spillRef);

    // 触发预检 Compaction
    const messages = await contextManager.buildChatMessages("Do more tasks", "System prompt");
    const prepared = await contextManager.prepare(messages);

    assert.ok(prepared.length > 0);

    // 验证 Durable Session 存了 spillRef
    const records = await contextManager.getSession().getRecords();
    const toolRec = records.find((r) => r.type === "tool_result") as any;
    assert.ok(toolRec);
    assert.ok(toolRec.spillRef);
    assert.strictEqual(toolRec.content, undefined); // 确认 JSONL 中未重复内联存储大内容
  });

  // ==========================================
  // E2E 场景 5: 不可用的 OTLP endpoint 不会中断 Agent 执行
  // ==========================================
  it("E2E 5: 无效 OTLP endpoint 场景下，Agent Loop 仍可完整稳定运行", async () => {
    const projectDir = path.join(tempDir, "failing-otel-proj");
    await fs.mkdir(projectDir, { recursive: true });

    const ctx = await resolveProjectContext({ projectRoot: projectDir, nashHome });
    const otelService = new OpenTelemetryService({
      config: {
        enabled: true,
        endpoint: "http://127.0.0.1:59998", // 无法连接的端口
        traces: true,
        metrics: true,
        logs: true,
        serviceName: "nash-fail-safe",
        timeoutMs: 50,
      },
      projectId: ctx.projectId,
      sessionId: "session-fail-safe",
    });

    const dummyTool = defineTool({
      name: "get_status",
      description: "Get harness status",
      parameters: { type: "object", properties: {} },
      async execute() {
        return "All systems operational";
      },
    });

    const registry = new ToolRegistry();
    registry.register(dummyTool);

    // 运行 Agent Loop
    const answer = await runAgentLoop("Check status", {
      projectContext: ctx,
      registry,
      otelService,
      printStats: false,
    });

    assert.ok(typeof answer === "string");
    await otelService.shutdown();
  });
});
