import * as crypto from "node:crypto";
import type {
  SpanRecord,
  SpanStatus,
  SpanTreeNode,
  RedactedErrorInfo,
} from "./types.js";
import { redactObject } from "./redaction.js";

export interface StartSpanOptions {
  name: string;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  attributes?: Record<string, unknown>;
  startTime?: number;
}

export interface EndSpanOptions {
  durationMs?: number;
  status?: SpanStatus;
  error?: Error | unknown;
  extraAttributes?: Record<string, unknown>;
  endTime?: number;
}

/**
 * TraceRecorder：管理单次 Agent Run 中的所有 Span 记录与层级拓扑
 */
export class TraceRecorder {
  readonly traceId: string;
  private readonly spans = new Map<string, SpanRecord>();
  private rootSpanId?: string;

  constructor(traceId?: string) {
    this.traceId = traceId ?? crypto.randomUUID();
  }

  /**
   * 启动一个新的 Span
   */
  startSpan(options: StartSpanOptions): SpanRecord {
    const spanId = options.spanId ?? crypto.randomUUID();
    const startTime = options.startTime ?? Date.now();

    const record: SpanRecord = {
      traceId: options.traceId || this.traceId,
      spanId,
      parentSpanId: options.parentSpanId,
      name: options.name,
      startTime,
      status: "unset",
      attributes: options.attributes ? (redactObject(options.attributes) as Record<string, unknown>) : {},
    };

    if (!options.parentSpanId && !this.rootSpanId) {
      this.rootSpanId = spanId;
    }

    this.spans.set(spanId, record);
    return record;
  }

  /**
   * 结束指定的 Span 并记录耗时与状态
   */
  endSpan(spanId: string, options?: EndSpanOptions): SpanRecord | undefined {
    const span = this.spans.get(spanId);
    if (!span) {
      return undefined;
    }

    const endTime = options?.endTime ?? Date.now();
    span.endTime = endTime;
    span.durationMs = Math.max(0, options?.durationMs ?? endTime - span.startTime);

    if (options?.status) {
      span.status = options.status;
    } else if (options?.error) {
      span.status = "error";
    } else {
      span.status = "ok";
    }

    if (options?.error) {
      const err = options.error instanceof Error ? options.error : new Error(String(options.error));
      span.error = {
        name: err.name,
        message: err.message,
        stack: err.stack ? err.stack.split("\n").slice(0, 5).join("\n") : undefined,
      };
    }

    if (options?.extraAttributes) {
      const sanitized = redactObject(options.extraAttributes) as Record<string, unknown>;
      span.attributes = {
        ...span.attributes,
        ...sanitized,
      };
    }

    return span;
  }

  /**
   * 获取指定 Span
   */
  getSpan(spanId: string): SpanRecord | undefined {
    return this.spans.get(spanId);
  }

  /**
   * 获取当前已记录的所有 Span 列表
   */
  getSpans(): SpanRecord[] {
    return Array.from(this.spans.values()).sort((a, b) => a.startTime - b.startTime);
  }

  /**
   * 获取 Root Span
   */
  getRootSpan(): SpanRecord | undefined {
    if (this.rootSpanId) {
      return this.spans.get(this.rootSpanId);
    }
    const all = this.getSpans();
    return all.find((s) => !s.parentSpanId);
  }

  /**
   * 将平面的 Span 列表重构为完整的调用树 (Span Tree)
   */
  getSpanTree(): SpanTreeNode | null {
    const all = this.getSpans();
    if (all.length === 0) {
      return null;
    }

    const rootSpan = this.getRootSpan() || all[0];
    if (!rootSpan) {
      return null;
    }

    const nodeMap = new Map<string, SpanTreeNode>();
    for (const span of all) {
      nodeMap.set(span.spanId, { span, children: [] });
    }

    for (const span of all) {
      if (span.parentSpanId && nodeMap.has(span.parentSpanId)) {
        const parentNode = nodeMap.get(span.parentSpanId)!;
        const currentNode = nodeMap.get(span.spanId)!;
        parentNode.children.push(currentNode);
      }
    }

    return nodeMap.get(rootSpan.spanId) ?? null;
  }

  /**
   * 清空所有 Span
   */
  clear(): void {
    this.spans.clear();
    this.rootSpanId = undefined;
  }
}
