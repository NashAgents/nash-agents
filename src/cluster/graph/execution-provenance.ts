import { aggregateModelUsage } from "../../observability/model-usage.js";
import { summarizeRuntime } from "../../observability/runtime-phase.js";
import type { IClusterStore } from "../storage/cluster-store.js";

function usageTotals(value: any) {
  const inputTokens = Number(value?.promptTokens ?? value?.prompt_tokens ?? value?.inputTokens ?? value?.inTokens ?? 0);
  const outputTokens = Number(value?.completionTokens ?? value?.completion_tokens ?? value?.outputTokens ?? value?.outTokens ?? 0);
  return { inputTokens, outputTokens, totalTokens: Number(value?.totalTokens ?? value?.total_tokens ?? inputTokens + outputTokens) };
}

/** Worker timestamps are never subtracted from coordinator timestamps. */
export async function projectExecutionProvenance(store: IClusterStore, graphId: string) {
  const graph = await store.getGraph?.(graphId);
  if (!graph) return null;
  const nodes = await store.listGraphNodes?.(graphId) ?? [];
  const edges = await store.listGraphEdges?.(graphId) ?? [];
  const coordinatorEvents = await store.listGraphEvents?.(graphId) ?? [];
  const executions = await Promise.all(nodes.filter((n) => n.taskId).map(async (node) => {
    const task = await store.getTask(node.taskId!);
    const events = (await store.getEventsForTask(node.taskId!, 0, 100000)).filter((e) => e.runId === task?.runId && e.nodeId === task?.nodeId);
    const terminal = [...events].reverse().find((e) => ["task.completed", "task.failed", "task.cancelled"].includes(e.eventType));
    const durationMs = typeof terminal?.data.durationMs === "number" ? terminal.data.durationMs : null;
    const spans = events.filter((e) => /^(?:model|tool)\.(?:completed|failed)$/.test(e.eventType)).map((e) => ({
      seq: e.seq, type: e.eventType, traceId: e.data.traceId, spanId: e.data.spanId, parentSpanId: e.data.parentSpanId,
      durationMs: e.data.durationMs, toolCallId: e.data.toolCallId, toolName: e.data.toolName,
      model: e.data.model, usage: e.data.usage ?? (e.data.hasUsage === true ? usageTotals(e.data) : undefined), timingSource: e.data.timingSource,
    }));
    return { graphNodeId: node.nodeId, taskId: node.taskId, runId: task?.runId, workerNodeId: task?.nodeId,
      attempt: task?.dispatchAttempt, status: task?.status, durationMs, spans,
      modelCalls: Math.max(events.filter((e) => e.eventType === "model.started").length, spans.filter((s) => s.type.startsWith("model.")).length),
      tokenUsage: spans.filter((s) => s.type.startsWith("model.")).reduce((sum, span) => { const usage = usageTotals(span.usage); return { inputTokens: sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens + usage.outputTokens, totalTokens: sum.totalTokens + usage.totalTokens, unknownUsageCalls: sum.unknownUsageCalls + (span.usage ? 0 : 1) }; }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownUsageCalls: 0 }),
      tools: events.filter((e) => e.eventType === "tool.result").map((e) => ({ seq: e.seq, ...e.data })),
      causalEvents: coordinatorEvents.filter((e) => e.payload?.taskId === node.taskId).map((e) => ({ seq: e.seq, type: e.eventType, classification: e.payload?.classification, graphNodeId: e.payload?.nodeId, coordinatorReceivedAt: e.createdAt })),
    };
  }));
  const cost = new Map(executions.map((e) => [e.graphNodeId, e.durationMs ?? 0]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const longest = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = (cost.get(id) ?? 0) + Math.max(0, ...edges.filter((e) => e.toNodeId === id).map((e) => longest(e.fromNodeId)));
    visiting.delete(id); memo.set(id, value); return value;
  };
  const replans = coordinatorEvents.filter((e) => e.eventType === "graph.replan_proposed").map((e) => ({ ...e.payload, seq: e.seq }));
  const goalReviews = (await store.listGraphVerifications?.(graphId) ?? []).filter((check) => check.verificationType === "goal_semantic");
  const workerUsage = executions.map((execution) => execution.tokenUsage);
  const knownUsages = [graph.strategyDecision?.planningTokens, ...replans.map((replan) => replan.usage), ...goalReviews.map((check) => check.evidence.usage)].filter(Boolean).map(usageTotals);
  const tokenUsage = [...workerUsage, ...knownUsages].reduce((sum, usage) => ({ inputTokens: sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens + usage.outputTokens, totalTokens: sum.totalTokens + usage.totalTokens }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const plannerCalls = graph.strategyDecision?.planningRequestIds?.length ?? 0;
  const replannerCalls = Math.max(replans.length, coordinatorEvents.filter((event) => event.eventType === "graph.replan_started").length);
  const workerModelCalls = executions.reduce((sum, execution) => sum + execution.modelCalls, 0);
  const createdTiming = coordinatorEvents.find(e => e.eventType === "graph.created");
  const terminalTiming = coordinatorEvents.filter(e => ["graph.completed", "graph.failed", "graph.partially_completed", "graph.cancelled"].includes(e.eventType)).at(-1);
  const monotonicGraphMs = createdTiming?.payload?.clockId && terminalTiming && terminalTiming.payload?.clockId === createdTiming.payload.clockId
    && typeof terminalTiming.payload.monotonicAt === "number" && typeof createdTiming.payload.monotonicAt === "number"
    ? Math.max(0, terminalTiming.payload.monotonicAt - createdTiming.payload.monotonicAt) : null;
  const traceId = graph.strategyDecision?.traceId;
  const usageRecords = traceId ? await store.listModelUsage?.({ traceId, limit: 1000 }) ?? [] : [];
  const runtimeSpans = traceId ? await store.listRuntimeSpans?.(traceId, 0, 1000) ?? [] : [];
  const unifiedUsage = aggregateModelUsage(usageRecords);
  const runtimeTrace = summarizeRuntime(runtimeSpans, unifiedUsage.requests);
  return {
    unifiedUsage: { ...unifiedUsage, completeness: usageRecords.length === 1000 ? "PARTIAL" : unifiedUsage.completeness, truncated: usageRecords.length === 1000, scope: "same execution trace, including outer Main and observed auxiliary requests; independently generated titles may use separate traces" },
    runtimeTrace: { ...runtimeTrace, truncated: runtimeSpans.length === 1000 },
    criticalPath: (() => {
      const rootSpan = runtimeSpans.find(s => s.phase === "goal_received" && s.endTime !== undefined);
      const planSpan = runtimeSpans.find(s => s.phase === "planner_request" && s.endTime !== undefined);
      const goalVerifySpan = runtimeSpans.find(s => s.phase === "goal_verification" && s.endTime !== undefined);
      const joinWaitSpans = runtimeSpans.filter(s => s.phase === "join_wait" && s.endTime !== undefined);

      const endToEndWallMs = rootSpan?.durationMs ?? null;
      const planningMs = planSpan?.durationMs ?? graph.strategyDecision?.planningDurationMs ?? 0;
      const taskChainMs = Math.max(0, ...nodes.map((n) => longest(n.nodeId)));
      const replanMs = replans.reduce((sum, r) => sum + Number(r.durationMs ?? 0), 0);
      const joinWaitMs = joinWaitSpans.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
      const goalVerifyMs = goalVerifySpan?.durationMs ?? 0;

      const totalCausalDurationMs = planningMs + taskChainMs + replanMs + joinWaitMs + goalVerifyMs;
      const totalWorkerSumMs = executions.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
      const parallelOverlap = taskChainMs > 0 ? Number((totalWorkerSumMs / taskChainMs).toFixed(2)) : 1.0;

      // 判断主要瓶颈阶段
      let bottleneckStage = "worker_execution";
      let maxStageDuration = taskChainMs;
      if (planningMs > maxStageDuration) { bottleneckStage = "planning"; maxStageDuration = planningMs; }
      if (replanMs > maxStageDuration) { bottleneckStage = "replanning"; maxStageDuration = replanMs; }
      if (joinWaitMs > maxStageDuration) { bottleneckStage = "join_wait"; maxStageDuration = joinWaitMs; }
      if (goalVerifyMs > maxStageDuration) { bottleneckStage = "goal_verification"; }

      const completeness = (rootSpan && (executions.every(e => e.durationMs !== null) || nodes.length === 0)) ? "COMPLETE" : "PARTIAL";

      return {
        completeness,
        endToEndObservedWallTimeMs: endToEndWallMs,
        totalCausalDurationMs: Number(totalCausalDurationMs.toFixed(2)),
        planningDurationMs: Number(planningMs.toFixed(2)),
        taskChainDurationMs: Number(taskChainMs.toFixed(2)),
        replanDurationMs: Number(replanMs.toFixed(2)),
        joinWaitDurationMs: Number(joinWaitMs.toFixed(2)),
        goalVerificationDurationMs: Number(goalVerifyMs.toFixed(2)),
        summedWorkerExecutionMs: Number(totalWorkerSumMs.toFixed(2)),
        parallelOverlapRatio: parallelOverlap,
        bottleneckStage,
        historicalRevisionCount: graph.revision ?? 1,
        scope: "Comprehensive causal path across dynamic graph revisions, including dedicated planner, task DAG critical chain, historical replanning latency, join waits, and goal semantic verification.",
      };
    })(),
    graphModelCalls: plannerCalls + replannerCalls + goalReviews.length + workerModelCalls,
    plannerCalls, replannerCalls, workerModelCalls, goalVerificationCalls: goalReviews.length,
    replannerDurationMs: replans.reduce((sum, replan) => sum + Number(replan.durationMs ?? 0), 0),
    tokenUsage,
    unknownTokenUsageCalls: workerUsage.reduce((sum, usage) => sum + usage.unknownUsageCalls, 0) + replannerCalls - replans.filter((replan) => replan.usage).length + goalReviews.filter((check) => !check.evidence.usage).length,
    usageScope: "graph planner, replanner, workers and semantic goal reviews; excludes outer Main Agent conversation and auxiliary security/compaction/title model requests",
    graphId, revision: graph.revision, traceId: graph.strategyDecision?.traceId,
    graphWallTimeMs: monotonicGraphMs ?? Math.max(0, (graph.completedAt ?? Date.now()) - graph.createdAt),
    graphWallTimeCompleteness: monotonicGraphMs === null ? "PARTIAL" : "COMPLETE",
    graphTimingSource: monotonicGraphMs === null ? "coordinator_wall_clock_unmeasured_clock_changes" : "coordinator_process_monotonic",
    graphTimingScope: "graph persistence through terminal state; excludes earlier planning and later final answer",
    plannerDurationMs: graph.strategyDecision?.planningDurationMs ?? null,
    plannerTokens: graph.strategyDecision?.planningTokens ?? null,
    plannerRequestIds: graph.strategyDecision?.planningRequestIds ?? [],
    replans,
    summedWorkerExecutionMs: executions.reduce((sum, e) => sum + (e.durationMs ?? 0), 0),
    taskCriticalPathMs: Math.max(0, ...nodes.map((n) => longest(n.nodeId))),
    criticalPathScope: "sum of worker local durations along current DAG; excludes network, planner and coordinator gaps",
    unknownWorkerDurations: executions.filter((e) => e.durationMs === null).map((e) => e.taskId),
    modelCalls: workerModelCalls,
    toolCalls: executions.reduce((sum, e) => sum + e.tools.length, 0),
    executions,
  };
}
