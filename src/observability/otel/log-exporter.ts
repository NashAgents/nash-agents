import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { OpenTelemetryConfig, HarnessEvent } from "../types.js";
import { redactObject } from "../redaction.js";

export interface CreateLoggerProviderOptions {
  config: OpenTelemetryConfig;
  customProcessor?: LogRecordProcessor;
  projectId?: string;
  sessionId?: string;
  isTest?: boolean;
}

export interface LoggerProviderBundle {
  provider: LoggerProvider;
  inMemoryExporter?: InMemoryLogRecordExporter;
  emitEvent: (event: HarnessEvent) => void;
  shutdown: () => Promise<void>;
  flush: () => Promise<void>;
}

export function createLoggerProvider(
  options: CreateLoggerProviderOptions
): LoggerProviderBundle | null {
  if (!options.config.enabled || !options.config.logs) {
    return null;
  }

  try {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.config.serviceName || "nash-agent",
      "nash.project.id": options.projectId || "unknown",
      "nash.session.id": options.sessionId || "unknown",
    });

    let processor: LogRecordProcessor;
    let inMemoryExporter: InMemoryLogRecordExporter | undefined;

    if (options.customProcessor) {
      processor = options.customProcessor;
    } else if (options.isTest) {
      inMemoryExporter = new InMemoryLogRecordExporter();
      processor = new SimpleLogRecordProcessor({ exporter: inMemoryExporter });
    } else {
      const url = options.config.endpoint.endsWith("/v1/logs")
        ? options.config.endpoint
        : `${options.config.endpoint.replace(/\/+$/, "")}/v1/logs`;

      const exporter = new OTLPLogExporter({
        url,
        timeoutMillis: options.config.timeoutMs ?? 5000,
      });

      processor = new BatchLogRecordProcessor({
        exporter,
        maxQueueSize: 512,
        scheduledDelayMillis: 500,
        exportTimeoutMillis: options.config.timeoutMs ?? 5000,
      });
    }

    const provider = new LoggerProvider({
      resource,
      processors: [processor],
    });

    const logger = provider.getLogger("nash-agent");

    return {
      provider,
      inMemoryExporter,
      emitEvent(event: HarnessEvent) {
        try {
          const sanitizedData = (redactObject(event.data) || {}) as Record<string, unknown>;
          logger.emit({
            body: event.type,
            attributes: {
              "event.id": event.id,
              "event.name": event.type,
              "nash.project.id": event.projectId,
              "nash.session.id": event.sessionId,
              "nash.trace.id": event.traceId ?? "",
              "nash.span.id": event.spanId ?? "",
              ...sanitizedData,
            },
            timestamp: new Date(event.timestamp),
          });
        } catch (_err) {
          // best-effort
        }
      },
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
