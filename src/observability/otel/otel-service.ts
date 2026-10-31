import type {
  OpenTelemetryConfig,
  SpanRecord,
  MetricsSnapshot,
  HarnessEvent,
} from "../types.js";
import {
  createTraceProvider,
  type TraceProviderBundle,
} from "./trace-exporter.js";
import {
  createMeterProvider,
  type MeterProviderBundle,
} from "./metrics-exporter.js";
import {
  createLoggerProvider,
  type LoggerProviderBundle,
} from "./log-exporter.js";
import type { EventBus } from "../event-bus.js";
import { redactObject } from "../redaction.js";

export interface OpenTelemetryServiceOptions {
  config: OpenTelemetryConfig;
  projectId?: string;
  sessionId?: string;
  isTest?: boolean;
  eventBus?: EventBus;
}

/**
 * OpenTelemetryService：统一管理 Traces、Metrics 与 Logs/Events 导出的服务门面
 * 遵循 Fail-Safe 与 Best-Effort 原则：OTel Collector 不可用或网络异常时，绝不抛出异常阻断 Agent 任务
 */
export class OpenTelemetryService {
  readonly config: OpenTelemetryConfig;
  readonly projectId: string;
  readonly sessionId: string;

  private traceBundle: TraceProviderBundle | null = null;
  private meterBundle: MeterProviderBundle | null = null;
  private loggerBundle: LoggerProviderBundle | null = null;
  private unsubscribeEventBus?: () => void;

  constructor(options: OpenTelemetryServiceOptions) {
    this.config = options.config;
    this.projectId = options.projectId || "default";
    this.sessionId = options.sessionId || "default";

    if (this.config.enabled) {
      this.init(options);
    }
  }

  private init(options: OpenTelemetryServiceOptions): void {
    try {
      this.traceBundle = createTraceProvider({
        config: this.config,
        projectId: this.projectId,
        sessionId: this.sessionId,
        isTest: options.isTest,
      });

      this.meterBundle = createMeterProvider({
        config: this.config,
        projectId: this.projectId,
        sessionId: this.sessionId,
        isTest: options.isTest,
      });

      this.loggerBundle = createLoggerProvider({
        config: this.config,
        projectId: this.projectId,
        sessionId: this.sessionId,
        isTest: options.isTest,
      });

      // 订阅 EventBus 自动转发事件到 OTel Logs
      if (options.eventBus && this.loggerBundle) {
        this.unsubscribeEventBus = options.eventBus.subscribe("*", (event) => {
          this.exportEvent(event);
        });
      }
    } catch (_err) {
      // best-effort 忽略初始化异常
    }
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }

  get traceBundleRef(): TraceProviderBundle | null {
    return this.traceBundle;
  }

  get meterBundleRef(): MeterProviderBundle | null {
    return this.meterBundle;
  }

  get loggerBundleRef(): LoggerProviderBundle | null {
    return this.loggerBundle;
  }

  /**
   * 将完成的 Span 记录导出至 OTel Tracer
   */
  exportSpan(span: SpanRecord): void {
    if (!this.config.enabled || !this.traceBundle) {
      return;
    }

    try {
      const tracer = this.traceBundle.provider.getTracer("nash-agent", "1.0.0");
      const startTime = span.startTime;
      const endTime = span.endTime ?? span.startTime;

      const sanitizedAttrs = (redactObject(span.attributes) || {}) as Record<string, unknown>;

      const otelSpan = tracer.startSpan(span.name, {
        startTime,
        attributes: {
          "nash.project.id": this.projectId,
          "nash.session.id": this.sessionId,
          "nash.trace.id": span.traceId,
          "nash.span.id": span.spanId,
          "nash.parent_span.id": span.parentSpanId ?? "",
          ...sanitizedAttrs,
        },
      });

      if (span.status === "error") {
        otelSpan.setStatus({
          code: 2, // SpanStatusCode.ERROR
          message: span.error?.message,
        });
        if (span.error) {
          otelSpan.recordException({
            name: span.error.name,
            message: span.error.message,
            stack: span.error.stack,
          });
        }
      } else if (span.status === "ok") {
        otelSpan.setStatus({ code: 1 }); // SpanStatusCode.OK
      }

      otelSpan.end(endTime);
    } catch (_err) {
      // best effort
    }
  }

  /**
   * 将事件导出至 OTel Logs
   */
  exportEvent(event: HarnessEvent): void {
    if (!this.config.enabled || !this.loggerBundle) {
      return;
    }
    this.loggerBundle.emitEvent(event);
  }

  /**
   * 将指标快照导出至 OTel Meter
   */
  exportMetrics(metrics: MetricsSnapshot): void {
    if (!this.config.enabled || !this.meterBundle) {
      return;
    }

    try {
      const meter = this.meterBundle.provider.getMeter("nash-agent", "1.0.0");

      const agentRunsCounter = meter.createCounter("nash.agent.runs");
      agentRunsCounter.add(metrics.agentRuns, { "nash.project.id": this.projectId });

      const modelCallsCounter = meter.createCounter("nash.model.calls");
      modelCallsCounter.add(metrics.modelCalls, { "nash.project.id": this.projectId });

      const toolCallsCounter = meter.createCounter("nash.tool.calls");
      toolCallsCounter.add(metrics.toolCalls, { "nash.project.id": this.projectId });

      const tokenCounter = meter.createCounter("nash.tokens.total");
      tokenCounter.add(metrics.inputTokens + metrics.outputTokens, { "nash.project.id": this.projectId });
    } catch (_err) {
      // best effort
    }
  }

  /**
   * 刷新所有未发送的批处理数据
   */
  async flush(): Promise<void> {
    const promises: Promise<void>[] = [];
    if (this.traceBundle) promises.push(this.traceBundle.flush());
    if (this.meterBundle) promises.push(this.meterBundle.flush());
    if (this.loggerBundle) promises.push(this.loggerBundle.flush());

    try {
      await Promise.allSettled(promises);
    } catch (_err) {
      // best effort
    }
  }

  /**
   * 优雅关闭并释放所有 OTel 资源与订阅
   */
  async shutdown(): Promise<void> {
    if (this.unsubscribeEventBus) {
      this.unsubscribeEventBus();
      this.unsubscribeEventBus = undefined;
    }

    const promises: Promise<void>[] = [];
    if (this.traceBundle) promises.push(this.traceBundle.shutdown());
    if (this.meterBundle) promises.push(this.meterBundle.shutdown());
    if (this.loggerBundle) promises.push(this.loggerBundle.shutdown());

    try {
      await Promise.allSettled(promises);
    } catch (_err) {
      // best effort
    }
  }
}
