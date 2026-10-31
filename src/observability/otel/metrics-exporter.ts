import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  type MetricReader,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { OpenTelemetryConfig } from "../types.js";

export interface CreateMeterProviderOptions {
  config: OpenTelemetryConfig;
  customReader?: MetricReader;
  projectId?: string;
  sessionId?: string;
  isTest?: boolean;
}

export interface MeterProviderBundle {
  provider: MeterProvider;
  reader: MetricReader;
  inMemoryExporter?: InMemoryMetricExporter;
  shutdown: () => Promise<void>;
  flush: () => Promise<void>;
}

export function createMeterProvider(
  options: CreateMeterProviderOptions
): MeterProviderBundle | null {
  if (!options.config.enabled || !options.config.metrics) {
    return null;
  }

  try {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.config.serviceName || "nash-agent",
      "nash.project.id": options.projectId || "unknown",
      "nash.session.id": options.sessionId || "unknown",
    });

    let reader: MetricReader;
    let inMemoryExporter: InMemoryMetricExporter | undefined;

    if (options.customReader) {
      reader = options.customReader;
    } else if (options.isTest) {
      inMemoryExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      reader = new PeriodicExportingMetricReader({
        exporter: inMemoryExporter,
        exportIntervalMillis: 100,
      });
    } else {
      const url = options.config.endpoint.endsWith("/v1/metrics")
        ? options.config.endpoint
        : `${options.config.endpoint.replace(/\/+$/, "")}/v1/metrics`;

      const exporter = new OTLPMetricExporter({
        url,
        timeoutMillis: options.config.timeoutMs ?? 5000,
      });

      reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 1000,
        exportTimeoutMillis: options.config.timeoutMs ?? 5000,
      });
    }

    const provider = new MeterProvider({
      resource,
      readers: [reader],
    });

    return {
      provider,
      reader,
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
