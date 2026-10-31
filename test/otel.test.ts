import { describe, it } from "node:test";
import assert from "node:assert";
import {
  OpenTelemetryService,
  createTraceProvider,
  createMeterProvider,
  createLoggerProvider,
  EventBus,
} from "../src/observability/index.js";
import type { SpanRecord, MetricsSnapshot } from "../src/observability/types.js";

describe("OpenTelemetry Standard Exporters Subsystem", () => {
  it("36. trace 可以正常导出 (InMemorySpanExporter)", async () => {
    const bundle = createTraceProvider({
      config: {
        enabled: true,
        endpoint: "http://localhost:4318",
        traces: true,
        metrics: false,
        logs: false,
        serviceName: "nash-test",
      },
      projectId: "proj-otel-1",
      sessionId: "sess-otel-1",
      isTest: true,
    });

    assert.ok(bundle);
    const tracer = bundle.provider.getTracer("test");
    const span = tracer.startSpan("model.call", {
      attributes: {
        "gen_ai.system": "deepseek",
        "gen_ai.request.model": "deepseek-chat",
      },
    });
    span.end();

    const finished = bundle.inMemoryExporter?.getFinishedSpans() ?? [];
    assert.strictEqual(finished.length, 1);
    assert.strictEqual(finished[0]?.name, "model.call");
    assert.strictEqual(
      finished[0]?.attributes["gen_ai.system"],
      "deepseek"
    );

    await bundle.shutdown();
  });

  it("37. metrics 可以正常导出 (InMemoryMetricExporter)", async () => {
    const bundle = createMeterProvider({
      config: {
        enabled: true,
        endpoint: "http://localhost:4318",
        traces: false,
        metrics: true,
        logs: false,
        serviceName: "nash-test",
      },
      projectId: "proj-otel-2",
      sessionId: "sess-otel-2",
      isTest: true,
    });

    assert.ok(bundle);
    const meter = bundle.provider.getMeter("test");
    const counter = meter.createCounter("nash.agent.runs");
    counter.add(3, { "nash.project.id": "proj-otel-2" });

    await bundle.flush();

    const metricsData = bundle.inMemoryExporter?.getMetrics() ?? [];
    assert.ok(metricsData.length >= 1);
    assert.strictEqual(
      metricsData[0]?.scopeMetrics[0]?.metrics[0]?.descriptor.name,
      "nash.agent.runs"
    );

    await bundle.shutdown();
  });

  it("38. logs/events 可以正常导出 (InMemoryLogRecordExporter)", async () => {
    const bundle = createLoggerProvider({
      config: {
        enabled: true,
        endpoint: "http://localhost:4318",
        traces: false,
        metrics: false,
        logs: true,
        serviceName: "nash-test",
      },
      projectId: "proj-otel-3",
      sessionId: "sess-otel-3",
      isTest: true,
    });

    assert.ok(bundle);
    bundle.emitEvent({
      id: "ev-1",
      type: "tool.completed",
      timestamp: new Date().toISOString(),
      projectId: "proj-otel-3",
      sessionId: "sess-otel-3",
      traceId: "trace-xyz",
      data: { toolName: "read_file", durationMs: 12 },
    });

    await new Promise((r) => setImmediate(r));

    const records = bundle.inMemoryExporter?.getFinishedLogRecords() ?? [];
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0]?.body, "tool.completed");
    assert.strictEqual(
      records[0]?.attributes["nash.project.id"],
      "proj-otel-3"
    );

    await bundle.shutdown();
  });

  it("39. projectId/sessionId/traceId correlation 正确", async () => {
    const eventBus = new EventBus();
    const service = new OpenTelemetryService({
      config: {
        enabled: true,
        endpoint: "http://localhost:4318",
        traces: true,
        metrics: true,
        logs: true,
        serviceName: "nash-agent-test",
      },
      projectId: "proj-corr",
      sessionId: "sess-corr",
      isTest: true,
      eventBus,
    });

    const spanRecord: SpanRecord = {
      traceId: "trace-corr-1",
      spanId: "span-corr-1",
      parentSpanId: "span-root-0",
      name: "tool.execute:bash",
      startTime: Date.now() - 100,
      endTime: Date.now(),
      durationMs: 100,
      status: "ok",
      attributes: {
        command: "ls -la",
      },
    };

    service.exportSpan(spanRecord);

    const spans = service.traceBundleRef?.inMemoryExporter?.getFinishedSpans() ?? [];
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0]?.attributes["nash.project.id"], "proj-corr");
    assert.strictEqual(spans[0]?.attributes["nash.session.id"], "sess-corr");
    assert.strictEqual(spans[0]?.attributes["nash.trace.id"], "trace-corr-1");
    assert.strictEqual(spans[0]?.attributes["nash.span.id"], "span-corr-1");
    assert.strictEqual(spans[0]?.attributes["nash.parent_span.id"], "span-root-0");

    await service.shutdown();
  });

  it("40. exporter failure 不影响 Agent 流程 (Fail-Safe / Best-Effort)", async () => {
    const service = new OpenTelemetryService({
      config: {
        enabled: true,
        // 配置一个无法连接的无效 endpoint
        endpoint: "http://127.0.0.1:59999",
        traces: true,
        metrics: true,
        logs: true,
        serviceName: "nash-failing",
        timeoutMs: 100,
      },
      projectId: "proj-fail",
      sessionId: "sess-fail",
      isTest: false,
    });

    const spanRecord: SpanRecord = {
      traceId: "t-fail",
      spanId: "s-fail",
      name: "agent.run",
      startTime: Date.now(),
      status: "ok",
      attributes: {},
    };

    // 导出的调用绝不会向外抛出未捕获的 Fatal 异常
    assert.doesNotThrow(() => {
      service.exportSpan(spanRecord);
      service.exportMetrics({
        agentRuns: 1,
        agentSuccess: 1,
        agentFailures: 0,
        agentDurationMs: 100,
        modelCalls: 1,
        modelFailures: 0,
        modelLatencyMs: 50,
        inputTokens: 100,
        outputTokens: 20,
        toolCalls: 0,
        toolFailures: 0,
        toolLatencyMs: 0,
        perToolCallCount: {},
        spills: 0,
        spilledBytes: 0,
        prunes: 0,
        compactions: 0,
        compactionFailures: 0,
        sandboxDenied: 0,
        approvalRequested: 0,
        approvalGranted: 0,
        approvalDenied: 0,
      });
    });

    await service.shutdown();
  });

  it("41. disabled 时完全不尝试外部发送", async () => {
    const service = new OpenTelemetryService({
      config: {
        enabled: false,
        endpoint: "http://invalid-host:4318",
        traces: true,
        metrics: true,
        logs: true,
        serviceName: "nash-disabled",
      },
      projectId: "proj-off",
      sessionId: "sess-off",
    });

    assert.strictEqual(service.isEnabled, false);
    assert.strictEqual(service.traceBundleRef, null);
    assert.strictEqual(service.meterBundleRef, null);
    assert.strictEqual(service.loggerBundleRef, null);

    // 调用应直接 no-op
    assert.doesNotThrow(() => {
      service.exportSpan({
        traceId: "t-off",
        spanId: "s-off",
        name: "test",
        startTime: Date.now(),
        status: "ok",
        attributes: {},
      });
    });
  });
});
