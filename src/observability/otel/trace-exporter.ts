import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  BatchSpanProcessor,
  InMemorySpanExporter,
  type SpanExporter,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { OpenTelemetryConfig } from "../types.js";

export interface CreateTraceProviderOptions {
  config: OpenTelemetryConfig;
  customExporter?: SpanExporter;
  projectId?: string;
  sessionId?: string;
  isTest?: boolean;
}

export interface TraceProviderBundle {
  provider: BasicTracerProvider;
  exporter: SpanExporter;
  inMemoryExporter?: InMemorySpanExporter;
  shutdown: () => Promise<void>;
  flush: () => Promise<void>;
}

export function createTraceProvider(
  options: CreateTraceProviderOptions
): TraceProviderBundle | null {
  if (!options.config.enabled || !options.config.traces) {
    return null;
  }

  try {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.config.serviceName || "nash-agent",
      "nash.project.id": options.projectId || "unknown",
      "nash.session.id": options.sessionId || "unknown",
    });

    let exporter: SpanExporter;
    let inMemoryExporter: InMemorySpanExporter | undefined;

    if (options.customExporter) {
      exporter = options.customExporter;
    } else if (options.isTest) {
      inMemoryExporter = new InMemorySpanExporter();
      exporter = inMemoryExporter;
    } else {
      const url = options.config.endpoint.endsWith("/v1/traces")
        ? options.config.endpoint
        : `${options.config.endpoint.replace(/\/+$/, "")}/v1/traces`;

      exporter = new OTLPTraceExporter({
        url,
        timeoutMillis: options.config.timeoutMs ?? 5000,
      });
    }

    const processor: SpanProcessor = options.isTest
      ? new SimpleSpanProcessor(exporter)
      : new BatchSpanProcessor(exporter, {
          maxQueueSize: 512,
          scheduledDelayMillis: 500,
          exportTimeoutMillis: options.config.timeoutMs ?? 5000,
        });

    const provider = new BasicTracerProvider({
      resource,
      spanProcessors: [processor],
    });

    return {
      provider,
      exporter,
      inMemoryExporter,
      async flush() {
        try {
          await provider.forceFlush();
        } catch (_err) {
          // best effort
        }
      },
      async shutdown() {
        try {
          await provider.shutdown();
        } catch (_err) {
          // best effort
        }
      },
    };
  } catch (_err) {
    return null;
  }
}
