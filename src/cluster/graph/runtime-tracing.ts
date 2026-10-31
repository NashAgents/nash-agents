import { randomUUID } from "node:crypto";
import { defaultTraceContext } from "../../observability/trace-context.js";
import { observeRuntimePhase, type RuntimePhase } from "../../observability/runtime-phase.js";
import type { IClusterStore } from "../storage/cluster-store.js";

/** Re-enter durable graph identity on gateway callbacks and after coordinator recovery. */
export async function observeGraphPhase<T>(store: IClusterStore, graphId: string, phase: RuntimePhase, fn: () => Promise<T>, resultStatus?: (result: T) => "ok" | "error"): Promise<T> {
  const graph = await store.getGraph?.(graphId);
  const current = defaultTraceContext.get();
  const traceId = graph?.strategyDecision?.traceId ?? current?.traceId ?? randomUUID();
  return defaultTraceContext.run({ projectId: "coordinator", sessionId: graphId,
    ...(current?.traceId === traceId ? current : {}), traceId, graphId, graphRevision: graph?.revision, conversationId: graph?.strategyDecision?.conversationId ?? current?.conversationId,
    runtimeSpanSink: span => store.saveRuntimeSpan?.(span), modelUsageSink: record => store.saveModelUsage?.(record),
  }, () => observeRuntimePhase(phase, fn, {}, resultStatus));
}
