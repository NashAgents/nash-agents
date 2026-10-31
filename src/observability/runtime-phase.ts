import { InstrumentationService } from "./instrumentation-service.js";
import type { SpanRecord } from "./types.js";
import type { ModelUsageRecord } from "./model-usage.js";

export const RUNTIME_PHASES = ["goal_received", "strategy", "planner_request", "planner_response", "plan_validation", "graph_persistence", "routing", "task_dispatch", "transport", "worker_accepted", "agent_loop", "model", "tool", "sandbox_startup", "artifact_publication", "result_verification", "replanner", "graph_patch", "join_wait", "coordinator_continuation", "goal_verification", "final_answer"] as const;
export type RuntimePhase = typeof RUNTIME_PHASES[number];
export interface RuntimeSpan extends SpanRecord {
  phase?: RuntimePhase;
  conversationId?: string; graphId?: string; graphRevision?: number; taskId?: string;
  agentId?: string; nodeId?: string; runId?: string; executionAttempt?: number;
  platform: NodeJS.Platform;
  timingSource: "process_monotonic";
  outcome: "running" | "completed" | "failed" | "cancelled" | "timed_out";
  completeness: "PARTIAL" | "COMPLETE";
}
export type RuntimeSpanSink = (span: RuntimeSpan) => void | Promise<void>;

/** Uses the existing instrumentation/context/event contracts, not a second tracing runtime. */
export function observeRuntimePhase<T>(phase: RuntimePhase, fn: () => Promise<T>, attributes: Record<string, unknown> = {}, resultStatus?: (result: T) => "ok" | "error" | "cancelled" | "timed_out"): Promise<T> {
  return new InstrumentationService().runSpan(`runtime.${phase}`, { phase, ...attributes }, fn, { resultStatus });
}

export function summarizeRuntime(spans: RuntimeSpan[], usage: ModelUsageRecord[]) {
  const unique = new Map<string, RuntimeSpan>();
  for (const span of spans) {
    const old = unique.get(span.spanId);
    if (!old || old.endTime === undefined) unique.set(span.spanId, span);
  }
  const timeline = [...unique.values()].sort((a,b) => a.startTime - b.startTime);
  const covered = new Set(timeline.filter(s => s.endTime !== undefined && s.phase).map(s => s.phase));
  const phases = RUNTIME_PHASES.map(phase => ({ phase, spans: timeline.filter(s => s.phase === phase).length, coverage: covered.has(phase) ? "OBSERVED" : "MISSING" }));
  const purposes = [...new Set(usage.map(r => r.purpose))].map(purpose => ({ purpose, calls: usage.filter(r => r.purpose === purpose).length,
    durationMs: usage.filter(r => r.purpose === purpose).reduce((n,r) => n + (r.durationMs ?? 0),0) }));
  return { timeline, phases, purposes, completeness: phases.every(p => p.coverage === "OBSERVED") ? "COMPLETE" : "PARTIAL",
    timingWarning: "Span durations use local monotonic clocks. Wall timestamps are for display only; cross-node clock offset/uncertainty is unmeasured. No cross-node timestamp subtraction. Nested and parallel durations must not be summed as wall time." };
}
