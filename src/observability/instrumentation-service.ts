import type { RuntimeSpan } from "./runtime-phase.js";
import * as crypto from "node:crypto";
import type { EventBus } from "./event-bus.js";
import type { TraceRecorder } from "./trace-recorder.js";
import type { MetricsCollector } from "./metrics-collector.js";
import { TraceContextManager, defaultTraceContext } from "./trace-context.js";
import type { HarnessEventType, HarnessEvent } from "./types.js";
import { redactObject } from "./redaction.js";

export interface InstrumentationServiceOptions {
  eventBus?: EventBus;
  traceRecorder?: TraceRecorder;
  metricsCollector?: MetricsCollector;
  traceContext?: TraceContextManager;
  monotonicNow?: () => number;
}

export interface RunSpanOptions {
  name: string;
  attributes?: Record<string, unknown>;
  eventTypePrefix?: string; // 如 "tool" 会触发 tool.started / tool.completed / tool.failed
  projectId?: string;
  sessionId?: string;
  traceId?: string;
}

/**
 * InstrumentationService：统一串联 EventBus、TraceRecorder、MetricsCollector 与 TraceContext 的轻量级门面
 */
export class InstrumentationService {
  readonly eventBus?: EventBus;
  readonly traceRecorder?: TraceRecorder;
  readonly metricsCollector?: MetricsCollector;
  readonly traceContext: TraceContextManager;
  private readonly monotonicNow: () => number;

  constructor(options?: InstrumentationServiceOptions) {
    this.eventBus = options?.eventBus;
    this.traceRecorder = options?.traceRecorder;
    this.metricsCollector = options?.metricsCollector;
    this.traceContext = options?.traceContext ?? defaultTraceContext;
    this.monotonicNow = options?.monotonicNow ?? (() => performance.now());
  }

  /**
   * 安全触发 EventBus 事件（自动附加当前 TraceContext 上下文与 Agent 身份信息）
   */
  emitEvent<T = Record<string, unknown>>(
    type: HarnessEventType,
    data: T,
    override?: {
      projectId?: string;
      sessionId?: string;
      traceId?: string;
      spanId?: string;
      parentSpanId?: string;
      agentId?: string;
      agentName?: string;
      agentType?: string;
      taskId?: string;
    }
  ): void {
    if (!this.eventBus) return;

    const ctx = this.traceContext.get();
    const event: HarnessEvent<T> = {
      id: crypto.randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      projectId: override?.projectId ?? ctx?.projectId ?? "default",
      sessionId: override?.sessionId ?? ctx?.sessionId ?? "default",
      traceId: override?.traceId ?? ctx?.traceId,
      spanId: override?.spanId ?? ctx?.spanId,
      parentSpanId: override?.parentSpanId ?? ctx?.parentSpanId,
      agentId: override?.agentId ?? ctx?.agentId,
      agentName: override?.agentName ?? ctx?.agentName,
      agentType: override?.agentType ?? ctx?.agentType,
      taskId: override?.taskId ?? ctx?.taskId,
      data: redactObject(data) as T,
    };

    this.eventBus.emit(event);
  }

  /**
   * 高效发射流式思考增量事件
   */
  emitThoughtDelta(
    delta: string,
    metadata?: { agentId?: string; model?: string; accumulatedLength?: number }
  ): void {
    this.emitEvent<{ delta: string; agentId?: string; model?: string; accumulatedLength?: number }>(
      "model.thought_delta",
      {
        delta,
        agentId: metadata?.agentId,
        model: metadata?.model,
        accumulatedLength: metadata?.accumulatedLength,
      },
      metadata?.agentId ? { agentId: metadata.agentId } : undefined
    );
  }

  /**
   * 高效发射流式正文增量事件
   */
  emitContentDelta(
    delta: string,
    metadata?: { agentId?: string; model?: string; accumulatedLength?: number }
  ): void {
    this.emitEvent<{ delta: string; agentId?: string; model?: string; accumulatedLength?: number }>(
      "model.content_delta",
      {
        delta,
        agentId: metadata?.agentId,
        model: metadata?.model,
        accumulatedLength: metadata?.accumulatedLength,
      },
      metadata?.agentId ? { agentId: metadata.agentId } : undefined
    );
  }

  /**
   * 在统一的 Trace Span 与上下文边界内执行异步代码块
   */
  async runSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: () => Promise<T>,
    options?: {
      eventTypePrefix?: "agent" | "model" | "tool" | "context" | "session";
      spanId?: string;
      resultStatus?: (result: T) => "ok" | "error" | "cancelled" | "timed_out";
    }
  ): Promise<T> {
    const ctx = this.traceContext.get();
    const traceId = ctx?.traceId ?? this.traceRecorder?.traceId ?? crypto.randomUUID();
    const parentSpanId = ctx?.spanId;
    const spanId = options?.spanId ?? crypto.randomUUID();

    const startTime = Date.now();
    const monotonicStart = this.monotonicNow();
    const runtimeSpan: RuntimeSpan = { traceId, spanId, parentSpanId, name, startTime, status: "unset", attributes: {},
      phase: attributes.phase as RuntimeSpan["phase"] ?? (name === "model.call" ? "model" : name.startsWith("tool.execute:") ? "tool" : undefined),
      conversationId: ctx?.conversationId, graphId: ctx?.graphId, graphRevision: ctx?.graphRevision,
      taskId: ctx?.taskId, agentId: ctx?.agentId, nodeId: ctx?.nodeId, runId: ctx?.runId, executionAttempt: ctx?.executionAttempt,
      platform: process.platform, timingSource: "process_monotonic", outcome: "running", completeness: "PARTIAL" };
    const publish = async () => { try { await ctx?.runtimeSpanSink?.(structuredClone(runtimeSpan)); } catch {} };
    if (ctx?.runtimeSpanSink) await publish();


    // 1. Trace 记录开始
    if (this.traceRecorder) {
      this.traceRecorder.startSpan({
        name,
        traceId,
        spanId,
        parentSpanId,
        attributes,
        startTime,
      });
    }

    // 2. 发送 started 事件
    if (options?.eventTypePrefix) {
      const startType = `${options.eventTypePrefix}.started` as HarnessEventType;
      this.emitEvent(startType, { ...attributes, name }, { traceId, spanId, parentSpanId });
    }

    // 3. 在 Child Span 上下文中执行
    try {
      const result = await this.traceContext.run({ projectId: "unknown", sessionId: "unknown", ...ctx, traceId, parentSpanId, spanId, toolCallId: typeof attributes.toolCallId === "string" ? attributes.toolCallId : ctx?.toolCallId }, async () => {
        return await fn();
      });

      const endTime = Date.now();
      const durationMs = Math.max(0, this.monotonicNow() - monotonicStart);

      const resultStatus = options?.resultStatus?.(result);
      const resultFailed = resultStatus !== undefined && resultStatus !== "ok";
      const outcome = resultStatus === "cancelled" || resultStatus === "timed_out" ? resultStatus : resultFailed ? "failed" : "completed";
      Object.assign(runtimeSpan, { endTime, durationMs, status: resultFailed ? "error" : "ok", outcome, completeness: "COMPLETE" });
      await publish();

      // 4. Trace 记录成功结束
      if (this.traceRecorder) {
        this.traceRecorder.endSpan(spanId, {
          status: resultFailed ? "error" : "ok",
          endTime,
          durationMs,
        });
      }

      // 5. 发送 completed 事件
      if (options?.eventTypePrefix) {
        const compType = `${options.eventTypePrefix}.${resultFailed ? "failed" : "completed"}` as HarnessEventType;
        this.emitEvent(compType, { ...attributes, durationMs, name, startTime, endTime, timingSource: "process_monotonic" }, { traceId, spanId, parentSpanId });
      }

      return result;
    } catch (err: unknown) {
      const endTime = Date.now();
      const durationMs = Math.max(0, this.monotonicNow() - monotonicStart);
      const errorObj = err instanceof Error ? err : new Error(String(err));

      Object.assign(runtimeSpan, { endTime, durationMs, status: "error", outcome: /(?:TimeoutError|Timeout)$/.test(errorObj.name) ? "timed_out" : ["AbortError", "AgentInterruptedError", "WorkflowCancelledError"].includes(errorObj.name) ? "cancelled" : "failed", completeness: "COMPLETE", error: { name: errorObj.name, message: "Execution failed; consult authorized task evidence" } });
      await publish();

      // Trace 记录失败结束
      if (this.traceRecorder) {
        this.traceRecorder.endSpan(spanId, {
          status: "error",
          error: errorObj,
          endTime,
          durationMs,
        });
      }

      // 发送 failed 事件
      if (options?.eventTypePrefix) {
        const failType = `${options.eventTypePrefix}.failed` as HarnessEventType;
        this.emitEvent(
          failType,
          {
            ...attributes,
            durationMs,
            name,
            error: {
              name: errorObj.name,
              message: errorObj.message,
            },
          },
          { traceId, spanId, parentSpanId }
        );
      }

      throw err;
    }
  }
}
