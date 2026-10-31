import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  EventBus,
  TraceRecorder,
  MetricsCollector,
  TraceContextManager,
  InstrumentationService,
  redactObject,
  redactString,
  redactToolResult,
} from "../src/observability/index.js";
import type { HarnessEvent } from "../src/observability/types.js";

describe("Observability Core: EventBus, Trace, Metrics & Redaction", () => {
  let eventBus: EventBus;
  let traceRecorder: TraceRecorder;
  let metrics: MetricsCollector;
  let traceContext: TraceContextManager;
  let instrumentation: InstrumentationService;

  beforeEach(() => {
    eventBus = new EventBus();
    traceRecorder = new TraceRecorder("test-trace-id");
    metrics = new MetricsCollector();
    traceContext = new TraceContextManager();
    instrumentation = new InstrumentationService({
      eventBus,
      traceRecorder,
      metricsCollector: metrics,
      traceContext,
    });
  });

  // ==========================================
  // 二、EventBus 测试 (11 - 15)
  // ==========================================
  describe("EventBus Subsystem", () => {
    it("11. emit 后 subscriber 收到事件", () => {
      const received: HarnessEvent[] = [];
      eventBus.subscribe("tool.completed", (e) => {
        received.push(e);
      });

      eventBus.emit({
        id: "e1",
        type: "tool.completed",
        timestamp: new Date().toISOString(),
        projectId: "p1",
        sessionId: "s1",
        data: { toolName: "grep_search", durationMs: 42 },
      });

      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0]?.data.toolName, "grep_search");
    });

    it("12. 多 subscriber 均可收到事件", () => {
      let count1 = 0;
      let count2 = 0;
      eventBus.subscribe("model.completed", () => {
        count1++;
      });
      eventBus.subscribe("model.completed", () => {
        count2++;
      });

      eventBus.emit({
        id: "e2",
        type: "model.completed",
        timestamp: new Date().toISOString(),
        projectId: "p1",
        sessionId: "s1",
        data: {},
      });

      assert.strictEqual(count1, 1);
      assert.strictEqual(count2, 1);
    });

    it("13. unsubscribe 生效", () => {
      let count = 0;
      const unsubscribe = eventBus.subscribe("agent.started", () => {
        count++;
      });

      eventBus.emit({
        id: "e3",
        type: "agent.started",
        timestamp: new Date().toISOString(),
        projectId: "p1",
        sessionId: "s1",
        data: {},
      });
      assert.strictEqual(count, 1);

      unsubscribe();

      eventBus.emit({
        id: "e4",
        type: "agent.started",
        timestamp: new Date().toISOString(),
        projectId: "p1",
        sessionId: "s1",
        data: {},
      });
      assert.strictEqual(count, 1);
    });

    it("14. subscriber 异常不会破坏 Agent (Fail-Safe 隔离)", () => {
      eventBus.subscribe("tool.started", () => {
        throw new Error("Subscriber internal bug!");
      });

      let normalSubscriberReceived = false;
      eventBus.subscribe("tool.started", () => {
        normalSubscriberReceived = true;
      });

      // emit 不应向外抛出异常
      assert.doesNotThrow(() => {
        eventBus.emit({
          id: "e5",
          type: "tool.started",
          timestamp: new Date().toISOString(),
          projectId: "p1",
          sessionId: "s1",
          data: {},
        });
      });

      assert.strictEqual(normalSubscriberReceived, true);
    });

    it("15. listener 不泄漏 (clear & unsubscribe 清理验证)", () => {
      const unsub1 = eventBus.subscribe("agent.started", () => {});
      const unsub2 = eventBus.subscribe("tool.started", () => {});
      assert.strictEqual(eventBus.subscriberCount, 2);

      unsub1();
      assert.strictEqual(eventBus.subscriberCount, 1);

      eventBus.clear();
      assert.strictEqual(eventBus.subscriberCount, 0);
    });
  });

  // ==========================================
  // 三、Trace 测试 (16 - 22)
  // ==========================================
  describe("TraceRecorder & TraceContext Subsystem", () => {
    it("16. 一次 Agent Run 只有一个 traceId", () => {
      const recorder = new TraceRecorder("trace-fixed-1");
      const s1 = recorder.startSpan({ name: "agent.run", traceId: recorder.traceId });
      const s2 = recorder.startSpan({
        name: "model.call",
        traceId: recorder.traceId,
        parentSpanId: s1.spanId,
      });

      assert.strictEqual(s1.traceId, "trace-fixed-1");
      assert.strictEqual(s2.traceId, "trace-fixed-1");
    });

    it("17. 多个 Agent Run traceId 不同", () => {
      const r1 = new TraceRecorder();
      const r2 = new TraceRecorder();
      assert.notStrictEqual(r1.traceId, r2.traceId);
    });

    it("18. model/tool span parent 正确", () => {
      const recorder = new TraceRecorder("trace-tree");
      const root = recorder.startSpan({ name: "agent.run", traceId: recorder.traceId });
      const modelSpan = recorder.startSpan({
        name: "model.call",
        traceId: recorder.traceId,
        parentSpanId: root.spanId,
      });
      const toolSpan = recorder.startSpan({
        name: "tool.execute:grep_search",
        traceId: recorder.traceId,
        parentSpanId: root.spanId,
      });

      assert.strictEqual(modelSpan.parentSpanId, root.spanId);
      assert.strictEqual(toolSpan.parentSpanId, root.spanId);

      const tree = recorder.getSpanTree();
      assert.ok(tree);
      assert.strictEqual(tree.children.length, 2);
      assert.strictEqual(tree.children[0]?.span.name, "model.call");
      assert.strictEqual(tree.children[1]?.span.name, "tool.execute:grep_search");
    });

    it("19. duration 统计正确", async () => {
      const recorder = new TraceRecorder("trace-time");
      const span = recorder.startSpan({
        name: "test.timer",
        traceId: recorder.traceId,
        startTime: 1000,
      });
      recorder.endSpan(span.spanId, { endTime: 1250, status: "ok" });

      const updated = recorder.getSpan(span.spanId);
      assert.strictEqual(updated?.durationMs, 250);
      assert.strictEqual(updated?.status, "ok");
    });

    it("20. error span status 正确", () => {
      const recorder = new TraceRecorder("trace-err");
      const span = recorder.startSpan({ name: "test.fail", traceId: recorder.traceId });
      recorder.endSpan(span.spanId, {
        error: new Error("Seatbelt Sandbox Denied"),
      });

      const updated = recorder.getSpan(span.spanId);
      assert.strictEqual(updated?.status, "error");
      assert.strictEqual(updated?.error?.message, "Seatbelt Sandbox Denied");
    });

    it("21. compaction model call 属于 compact span 子节点", () => {
      const recorder = new TraceRecorder("trace-comp");
      const root = recorder.startSpan({ name: "agent.run", traceId: recorder.traceId });
      const compactSpan = recorder.startSpan({
        name: "context.compact",
        traceId: recorder.traceId,
        parentSpanId: root.spanId,
      });
      const compactModelSpan = recorder.startSpan({
        name: "model.call:compaction",
        traceId: recorder.traceId,
        parentSpanId: compactSpan.spanId,
      });

      const tree = recorder.getSpanTree();
      assert.ok(tree);
      assert.strictEqual(tree.children.length, 1);
      const compactNode = tree.children[0];
      assert.ok(compactNode);
      assert.strictEqual(compactNode.span.name, "context.compact");
      assert.strictEqual(compactNode.children.length, 1);
      assert.strictEqual(compactNode.children[0]?.span.name, "model.call:compaction");
    });

    it("22. AsyncLocalStorage 跨 async/await 正确传播 context", async () => {
      const contextManager = new TraceContextManager();

      await contextManager.run(
        {
          projectId: "proj-async",
          sessionId: "sess-async",
          traceId: "trace-async",
          spanId: "span-root",
        },
        async () => {
          assert.strictEqual(contextManager.getProjectId(), "proj-async");
          assert.strictEqual(contextManager.getTraceId(), "trace-async");
          assert.strictEqual(contextManager.getSpanId(), "span-root");

          await contextManager.withChildSpan("span-child-1", async () => {
            // 模拟异步 I/O 延迟
            await new Promise((r) => setTimeout(r, 10));

            assert.strictEqual(contextManager.getSpanId(), "span-child-1");
            const ctx = contextManager.get();
            assert.strictEqual(ctx?.parentSpanId, "span-root");
          });

          // 恢复为 root span
          assert.strictEqual(contextManager.getSpanId(), "span-root");
        }
      );
    });
  });

  // ==========================================
  // 四、Metrics 测试 (23 - 30)
  // ==========================================
  describe("MetricsCollector Subsystem", () => {
    it("23. modelCalls 统计正确", () => {
      metrics.recordModelCall(120, true, 100, 20);
      metrics.recordModelCall(180, true, 150, 30);
      metrics.recordModelCall(50, false);

      const snap = metrics.getSnapshot();
      assert.strictEqual(snap.modelCalls, 3);
      assert.strictEqual(snap.modelFailures, 1);
      assert.strictEqual(snap.modelLatencyMs, 350);
    });

    it("24. toolCalls 统计正确", () => {
      metrics.recordToolCall("read_file", 10, true);
      metrics.recordToolCall("read_file", 15, true);
      metrics.recordToolCall("grep_search", 40, true);
      metrics.recordToolCall("bash", 100, false);

      const snap = metrics.getSnapshot();
      assert.strictEqual(snap.toolCalls, 4);
      assert.strictEqual(snap.toolFailures, 1);
      assert.strictEqual(snap.perToolCallCount["read_file"], 2);
      assert.strictEqual(snap.perToolCallCount["grep_search"], 1);
      assert.strictEqual(snap.perToolCallCount["bash"], 1);
    });

    it("25. error count 正确", () => {
      metrics.recordAgentRun(1000, false);
      metrics.recordModelCall(200, false);
      metrics.recordToolCall("bash", 50, false);
      metrics.recordCompaction(false);

      const snap = metrics.getSnapshot();
      assert.strictEqual(snap.agentFailures, 1);
      assert.strictEqual(snap.modelFailures, 1);
      assert.strictEqual(snap.toolFailures, 1);
      assert.strictEqual(snap.compactionFailures, 1);
    });

    it("26. latency 正确累加", () => {
      metrics.recordAgentRun(1500, true);
      metrics.recordModelCall(400, true);
      metrics.recordToolCall("grep_search", 150, true);

      const snap = metrics.getSnapshot();
      assert.strictEqual(snap.agentDurationMs, 1500);
      assert.strictEqual(snap.modelLatencyMs, 400);
      assert.strictEqual(snap.toolLatencyMs, 150);
    });

    it("27. token 累加正确", () => {
      metrics.recordModelCall(100, true, 5000, 300);
      metrics.recordModelCall(120, true, 4000, 250);

      const snap = metrics.getSnapshot();
      assert.strictEqual(snap.inputTokens, 9000);
      assert.strictEqual(snap.outputTokens, 550);
    });

    it("28. spill bytes 正确累加", () => {
      metrics.recordSpill(1024 * 50); // 50 KB
      metrics.recordSpill(1024 * 150); // 150 KB

      const snap = metrics.getSnapshot();
      assert.strictEqual(snap.spills, 2);
      assert.strictEqual(snap.spilledBytes, 1024 * 200);
    });

    it("29. compaction count 正确", () => {
      metrics.recordCompaction(true);
      metrics.recordCompaction(false);

      const snap = metrics.getSnapshot();
      assert.strictEqual(snap.compactions, 2);
      assert.strictEqual(snap.compactionFailures, 1);
    });

    it("30. approval count 正确", () => {
      metrics.recordApproval("requested");
      metrics.recordApproval("granted");
      metrics.recordApproval("requested");
      metrics.recordApproval("denied");

      const snap = metrics.getSnapshot();
      assert.strictEqual(snap.approvalRequested, 2);
      assert.strictEqual(snap.approvalGranted, 1);
      assert.strictEqual(snap.approvalDenied, 1);
    });
  });

  // ==========================================
  // 五、Redaction 测试 (31 - 35)
  // ==========================================
  describe("Redaction & Privacy Protection", () => {
    it("31. API Key 不进入 event (redactObject & redactString)", () => {
      const raw = {
        apiKey: "sk-test-600bad913d3a0adef",
        DEEPSEEK_API_KEY: "secret-token-key-12345",
        normalKey: "hello world",
      };

      const redacted = redactObject(raw) as any;
      assert.strictEqual(redacted.apiKey, "[REDACTED]");
      assert.strictEqual(redacted.DEEPSEEK_API_KEY, "[REDACTED]");
      assert.strictEqual(redacted.normalKey, "hello world");
    });

    it("32. API Key 不进入 trace attributes", () => {
      const s = traceRecorder.startSpan({
        name: "test.span",
        traceId: "t1",
        attributes: {
          user_token: "secret-token",
          authorization: "Bearer my-secret-jwt-token-value-12345",
          query: "find all files",
        },
      });

      assert.strictEqual(s.attributes["user_token"], "[REDACTED]");
      assert.strictEqual(s.attributes["authorization"], "[REDACTED]");
      assert.strictEqual(s.attributes["query"], "find all files");
    });

    it("33. Bearer Token 在文本中被脱敏", () => {
      const text = "Request header had Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 and sk-1234567890123456";
      const cleaned = redactString(text);
      assert.strictEqual(cleaned.includes("eyJhbG"), false);
      assert.strictEqual(cleaned.includes("1234567890123456"), false);
      assert.strictEqual(cleaned.includes("[REDACTED]"), true);
    });

    it("34. Authorization header 被清理", () => {
      const headers = {
        Authorization: "Bearer secret-access-token-9999",
        "content-type": "application/json",
      };

      const cleaned = redactObject(headers) as any;
      assert.strictEqual(cleaned.Authorization, "[REDACTED]");
      assert.strictEqual(cleaned["content-type"], "application/json");
    });

    it("35. 超长 ToolResult 不被 observability 重复保存 (仅记录元数据与摘要)", () => {
      const hugeOutput = "A".repeat(100_000);
      const toolResult = {
        success: true,
        output: hugeOutput,
        executionTimeMs: 45,
      };

      const summary = redactToolResult("bash", toolResult, "tool-result://artifact-123");
      assert.strictEqual(summary["toolName"], "bash");
      assert.strictEqual(summary["outputChars"], 100_000);
      assert.strictEqual(summary["spillRef"], "tool-result://artifact-123");
      // 确认不会完整内联 100,000 字符
      assert.ok(String(summary["preview"]).length < 500);
    });
  });
});
