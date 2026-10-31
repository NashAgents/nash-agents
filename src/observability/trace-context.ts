import type { RuntimeSpanSink } from "./runtime-phase.js";
import type { ModelUsageSink, RequestPurpose } from "./model-usage.js";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 运行时 Trace 上下文数据载荷
 */
export interface TraceContextPayload {
  projectId: string;
  sessionId: string;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  agentId?: string;
  agentName?: string;
  agentType?: string;
  taskId?: string;
  toolCallId?: string;
  conversationId?: string;
  goalId?: string;
  goalRunId?: string;
  goalTurnFence?: { ownerId: string; turnId: string; generation: number };
  graphId?: string;
  graphRevision?: number;
  nodeId?: string;
  runId?: string;
  executionAttempt?: number;
  modelPurpose?: RequestPurpose;
  modelUsageSink?: ModelUsageSink;
  runtimeSpanSink?: RuntimeSpanSink;
}

/**
 * TraceContext 管理器：利用 AsyncLocalStorage 跨 async/await 传播 Project/Session/Trace 上下文
 */
export class TraceContextManager {
  private readonly storage = new AsyncLocalStorage<TraceContextPayload>();

  /**
   * 在指定 Trace 上下文中执行异步函数
   */
  run<R>(payload: TraceContextPayload, fn: () => R): R {
    return this.storage.run(payload, fn);
  }

  /**
   * 获取当前活跃的 Trace 上下文
   */
  get(): TraceContextPayload | undefined {
    return this.storage.getStore();
  }

  getProjectId(): string | undefined {
    return this.storage.getStore()?.projectId;
  }

  getSessionId(): string | undefined {
    return this.storage.getStore()?.sessionId;
  }

  getTraceId(): string | undefined {
    return this.storage.getStore()?.traceId;
  }

  getSpanId(): string | undefined {
    return this.storage.getStore()?.spanId;
  }

  /**
   * 在当前上下文基础上嵌套执行 Child Span，自动将原 spanId 作为 parentSpanId，并在完成后恢复上下文
   */
  withChildSpan<R>(newSpanId: string, fn: () => R): R {
    const current = this.storage.getStore();
    if (!current) {
      // 若当前没有上下文，仅临时包裹
      return this.storage.run(
        {
          projectId: "unknown",
          sessionId: "unknown",
          traceId: "unknown",
          spanId: newSpanId,
        },
        fn
      );
    }

    const nextPayload: TraceContextPayload = {
      ...current,
      parentSpanId: current.spanId,
      spanId: newSpanId,
    };

    return this.storage.run(nextPayload, fn);
  }
}

/**
 * 导出一个默认的 TraceContextManager 实例供模块内快捷调用
 */
export const defaultTraceContext = new TraceContextManager();
