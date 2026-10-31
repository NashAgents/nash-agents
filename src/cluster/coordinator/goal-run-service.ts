import type { ClusterTaskRecord, ClusterTaskStatus, GoalReportEvidence, GoalRunRecord, IClusterStore } from "../storage/cluster-store.js";
import { aggregateGoalRunState } from "./goal-run-state.js";
import { createHash } from "node:crypto";
import { collectExecutionEvidence, outcomeFromTaskStatus, type TaskEvidenceInput } from "./main-agent/execution-evidence.js";
import { evaluateEvidenceSet } from "./main-agent/answer-evidence.js";
import { buildFactCatalog, verifyAnswerFacts, type FactCatalog } from "./main-agent/answer-facts.js";
import { defaultTraceContext } from "../../observability/trace-context.js";
import { ownedByForeignLiveTurn } from "../storage/goal-turn-fence.js";
import {
  coverageEvidenceSignature, evaluateGoalCoverage, sameCoverageEvidence, scoutEvidenceFromEvent,
  type GoalCoverageArtifact, type GoalCoverageEvaluation, type ScoutReportEvidence,
} from "../storage/goal-coverage-evaluation.js";
import type { DistributedGraphNodeRecord, DistributedGraphRecord, GraphStatus, GraphVerificationRecord } from "../graph/types.js";

/** Statuses whose report may be (re)built from an evaluation; anything else still owes work. */
const REPORTABLE_GOAL_STATES: ReadonlySet<GoalRunRecord["status"]> = new Set(["verifying", "completed", "partially_completed", "failed", "cancelled", "outcome_unknown"]);
const TERMINAL_TASK_STATES = ["completed", "failed", "cancelled"];
const TERMINAL_GRAPH_STATES = ["completed", "failed", "cancelled", "partially_completed"];
const ACTIVE_TASK_STATES = ["created", "queued", "dispatched", "accepted", "running", "waiting_approval", "interrupting", "cancelling", "outcome_unknown"];
/**
 * 纯对话 GoalRun 的收敛标记：轮次结束且没有关联任何执行。
 * 该标记让 reconcileGoalRun 不要用「空证据 = 待核验」的通用规则把它改回 verifying。
 */
const CONVERSATIONAL_STAGE = "conversational";

export async function changeGoalRun(store: IClusterStore, id: string, edit: (goal: GoalRunRecord) => GoalRunRecord): Promise<GoalRunRecord> {
  if (!store.getGoalRun || !store.updateGoalRun) throw new Error("GoalRun storage unavailable");
  for (let attempt = 0; attempt < 20; attempt++) {
    const old = await store.getGoalRun(id);
    if (!old) throw new Error(`GoalRun ${id} not found`);
    const next = edit(structuredClone(old));
    next.revision = old.revision + 1;
    next.updatedAt = Date.now();
    const trace = defaultTraceContext.get();
    if (await store.updateGoalRun(next, old.revision, trace?.goalRunId === id ? trace.goalTurnFence : undefined)) return next;
  }
  throw new Error(`GoalRun ${id} update conflict`);
}

export async function linkGoalRun(store: IClusterStore, id: string, kind: "task" | "graph", childId: string): Promise<void> {
  await changeGoalRun(store, id, goal => {
    const ids = kind === "task" ? goal.linkedTaskIds : goal.linkedGraphIds;
    if (!ids.includes(childId)) {
      ids.push(childId);
      // New work invalidates any previously verified coverage and its report.
      goal.status = "running"; goal.executionState = "running"; goal.finalReport = undefined; goal.reportFingerprint = undefined; goal.reportState = "pending"; goal.completedAt = undefined;
      goal.coverageEvaluation = undefined;
    }
    return goal;
  });
}

/**
 * Task states the GoalRun state machine consumes. Historical failed attempts of a graph
 * that is still represented stay auditable but cannot override a successful retry.
 */
function goalTaskStates(goal: GoalRunRecord, tasks: Array<ClusterTaskRecord | null | undefined>, graphs: Array<DistributedGraphRecord | null | undefined>): Array<ClusterTaskStatus | "missing"> {
  const represented = new Set(graphs.filter((graph): graph is DistributedGraphRecord => Boolean(graph)).map(graph => graph.graphId));
  return tasks.filter(task => {
    if (!task) return true;
    const graphId = task.dispatchOptions?.graphContext?.graphId;
    if (!graphId || !represented.has(graphId)) return true;
    return ACTIVE_TASK_STATES.includes(task.status);
  }).map(task => task?.status ?? "missing");
}

/** A discovery scope that selected nodes but never persisted a dispatch for them is a broken turn, not a partial success. */
function hasMissingScoutDispatch(goal: GoalRunRecord, tasks: Array<ClusterTaskRecord | null | undefined>): boolean {
  return (goal.discoveryScopes ?? []).some(scope => scope.selectedNodeIds.some(nodeId =>
    !tasks.some(task => task?.nodeId === nodeId && task.dispatchOptions?.contextOverrides?.discoveryId === scope.discoveryId)));
}

/** Single source of truth for the GoalRun status, shared by reconciliation and report generation. */
function resolveGoalStatus(input: {
  currentStage?: string;
  taskStates: Array<ClusterTaskStatus | "missing">;
  graphStates: Array<GraphStatus | "missing">;
  verification: "pending" | "passed" | "partial" | "failed";
  missingScoutDispatch: boolean;
}): GoalRunRecord["status"] {
  if (input.missingScoutDispatch) return input.currentStage === "planning" ? "running" : "outcome_unknown";
  return aggregateGoalRunState({
    tasks: input.taskStates, graphs: input.graphStates,
    turnFinished: input.currentStage !== "planning", verification: input.verification,
  });
}

/** 没有关联执行、且已按轮次结果收敛的纯对话目标。 */
function isConvergedConversationalGoal(goal: GoalRunRecord): boolean {
  return goal.currentStage === CONVERSATIONAL_STAGE
    && !goal.linkedTaskIds.length && !goal.linkedGraphIds.length
    && !goal.discoveryScopes?.length && !goal.turnRecovery;
}

function goalHasNoExecution(goal: GoalRunRecord): boolean {
  return !goal.linkedTaskIds.length && !goal.linkedGraphIds.length
    && !goal.discoveryScopes?.length && !goal.turnRecovery;
}

/**
 * 轮次已结束、且没有派发任何执行的目标：对话回答本身就是交付。
 * 必须收敛到终态，否则该目标会永远停在 verifying/running，会话与集群排空都无法成立。
 * 轮次仍在 planning 时绝不收敛——前台轮次仍持有租约并可能派发任务。
 */
async function convergeConversationalGoal(store: IClusterStore, goal: GoalRunRecord): Promise<GoalRunRecord> {
  if (goal.currentStage === "planning") return goal;
  if (isConvergedConversationalGoal(goal) && goal.reportState === "ready") return goal;

  const conversation = await store.getConversation?.(goal.conversationId);
  const response = conversation ? [...conversation.messages].reverse().find(message =>
    message.sender === "assistant" && message.metadata?.goalRunId === goal.goalRunId
    && (!goal.turnLease || message.metadata?.goalRunTurnId === goal.turnLease.turnId)) : undefined;
  const state = typeof response?.metadata?.state === "string" ? response.metadata.state : undefined;

  const status: GoalRunRecord["status"] =
    state === "waiting_user_clarification" || response?.messageType === "clarification" ? "waiting_approval"
    : response?.metadata?.recoveredTurn === true ? "outcome_unknown"
    // 客户端断开 / 轮次超时都属于「本轮被停止且没有可核验的执行」，与用户取消同属非成功终态。
    : state === "cancelled" || state === "detached" || state === "timed_out" ? "cancelled"
    : state === "error" || response?.messageType === "error" ? "failed"
    : "completed";

  const content =
    status === "waiting_approval" ? "本轮没有派发执行任务：协调器正在等待用户补充信息，收到答复后继续。"
    : status === "outcome_unknown" ? "本轮没有派发任何执行任务，且协调器回答未能持久化，因此无法确认目标是否完成。"
    : status === "cancelled" ? "本轮在派发任何执行任务前被中止，没有产生执行或外部副作用。"
    : status === "failed" ? `本轮没有派发任何执行任务，且协调器处理失败：${(response?.content ?? "无持久化回答").slice(0, 500)}`
    : "本轮为纯对话回答：没有派发任何执行任务，也没有需要核验的外部副作用。";

  const fingerprint = createHash("sha256").update(`${goal.goalRunId}:${status}:${content}`).digest("hex");
  return changeGoalRun(store, goal.goalRunId, current => {
    if (!goalHasNoExecution(current) || current.currentStage === "planning") return current;
    const settled = status !== "waiting_approval";
    return {
      ...current,
      status,
      executionState: status === "waiting_approval" ? "waiting_approval" : status === "outcome_unknown" ? "outcome_unknown" : "settled",
      currentStage: CONVERSATIONAL_STAGE,
      finalReport: current.finalReport ?? content,
      reportState: "ready",
      reportFingerprint: current.reportFingerprint ?? fingerprint,
      completedAt: settled ? (current.completedAt ?? Date.now()) : undefined,
    };
  });
}

/** True when another live turn owns this GoalRun, so a derived-state reconciler must not overwrite its report. */
export async function reconcileGoalRun(store: IClusterStore, id: string): Promise<GoalRunRecord> {
  if (!store.getGoalRun || !store.updateGoalRun) throw new Error("GoalRun storage unavailable");
  for (let attempt = 0; attempt < 20; attempt++) {
    const goal = await store.getGoalRun(id);
    if (!goal) throw new Error(`GoalRun ${id} not found`);
    const tasks = await Promise.all(goal.linkedTaskIds.map(taskId => store.getTask(taskId)));
    const graphs = await Promise.all(goal.linkedGraphIds.map(graphId => store.getGraph?.(graphId)));
    const signature = coverageEvidenceSignature({ tasks, graphs });
    // Only a coverage verdict computed from exactly these task/graph states may drive the state machine;
    // anything else is stale and must be recomputed before the goal can converge.
    const persisted = goal.coverageEvaluation && sameCoverageEvidence(goal.coverageEvaluation.evidence, signature) ? goal.coverageEvaluation : undefined;
    const verification: "pending" | "passed" | "partial" | "failed" = persisted?.goalVerification
      ?? (goal.reportState === "ready" ? "partial" : "pending");
    const status = resolveGoalStatus({
      currentStage: goal.currentStage,
      taskStates: goalTaskStates(goal, tasks, graphs),
      graphStates: graphs.map(graph => graph?.status ?? "missing"),
      verification,
      missingScoutDispatch: hasMissingScoutDispatch(goal, tasks),
    });
    const executionState: NonNullable<GoalRunRecord["executionState"]> = status === "outcome_unknown" ? "outcome_unknown" : status === "waiting_approval" ? "waiting_approval" : ["running", "recovering", "planning"].includes(status) ? "running" : "settled";
    const active = ["running", "waiting_approval", "recovering", "outcome_unknown"].includes(status);
    const now = Date.now();
    // Another live turn owns this record: only its holder (or a post-turn reconciler once the
    // lease expires) may converge derived state, so a superseded owner can never rewrite a report.
    if (ownedByForeignLiveTurn(goal, now)) return goal;
    // 已收敛的纯对话目标没有执行证据可核验：通用状态机在这里只会把它改回 verifying，
    // 让会话被一个永不结束的目标锁住。续聊时 currentStage 会被重置为 planning。
    if (isConvergedConversationalGoal(goal)) return goal;
    const invalidateReport = active && (goal.finalReport || goal.completedAt);
    if (status === goal.status && executionState === goal.executionState && !invalidateReport) return goal;
    const next: GoalRunRecord = {
      ...goal, status, executionState,
      ...(active ? {
        completedAt: undefined,
        ...(invalidateReport ? { finalReport: undefined, reportState: "pending" as const, reportFingerprint: undefined } : {}),
      } : {}),
      revision: goal.revision + 1, updatedAt: now,
    };
    if (await store.updateGoalRun(next, goal.revision)) return next;
  }
  throw new Error(`GoalRun ${id} reconciliation conflict`);
}

interface GoalEvidence {
  tasks: ClusterTaskRecord[];
  graphs: DistributedGraphRecord[];
  graphNodes: Map<string, DistributedGraphNodeRecord[]>;
  graphVerifications: Map<string, GraphVerificationRecord[]>;
  artifacts: GoalCoverageArtifact[];
  scoutReports: ScoutReportEvidence[];
}

async function loadGoalEvidence(store: IClusterStore, goal: GoalRunRecord): Promise<GoalEvidence> {
  const tasks = (await Promise.all(goal.linkedTaskIds.map(taskId => store.getTask(taskId)))).filter((task): task is ClusterTaskRecord => Boolean(task));
  const graphs = (await Promise.all(goal.linkedGraphIds.map(graphId => store.getGraph?.(graphId)))).filter((graph): graph is DistributedGraphRecord => Boolean(graph));
  const graphNodes = new Map<string, DistributedGraphNodeRecord[]>();
  const graphVerifications = new Map<string, GraphVerificationRecord[]>();
  for (const graph of graphs) {
    graphNodes.set(graph.graphId, await store.listGraphNodes?.(graph.graphId) ?? []);
    graphVerifications.set(graph.graphId, await store.listGraphVerifications?.(graph.graphId) ?? []);
  }
  const artifacts = (await Promise.all(goal.linkedGraphIds.map(graphId => store.listArtifacts?.(graphId) ?? []))).flat() as GoalCoverageArtifact[];
  const scoutReports: ScoutReportEvidence[] = [];
  for (const task of tasks.filter(task => task.status === "completed"
    && (task.dispatchOptions?.contextOverrides?.taskType === "scout"
      || task.dispatchOptions?.contextOverrides?.isDiscovery === true
      || typeof task.dispatchOptions?.contextOverrides?.discoveryId === "string"))) {
    const events = await store.getEventsForTask(task.taskId, 0, 100000);
    for (const event of events) {
      if (event.runId !== task.runId || event.nodeId !== task.nodeId) continue;
      const evidence = scoutEvidenceFromEvent(event as { taskId: string; nodeId: string; runId?: string; seq: number; eventType: string; data: Record<string, any> });
      if (evidence) scoutReports.push(evidence);
    }
  }
  return { tasks, graphs, graphNodes, graphVerifications, artifacts, scoutReports };
}

function evaluationDigest(evaluation: GoalCoverageEvaluation): string {
  return createHash("sha256").update(JSON.stringify({ ...evaluation, evaluatedAt: 0 })).digest("hex");
}

/** Persist the verdict before any report text is generated so a report failure cannot lose it. */
async function persistCoverageEvaluation(store: IClusterStore, goal: GoalRunRecord, evaluation: GoalCoverageEvaluation): Promise<GoalRunRecord> {
  if (goal.coverageEvaluation && evaluationDigest(goal.coverageEvaluation) === evaluationDigest(evaluation)) return goal;
  return changeGoalRun(store, goal.goalRunId, current => ({ ...current, coverageEvaluation: evaluation }));
}

/** Generate a conservative, explicitly partial report when execution settled but coverage is unverified. */
export async function processGoalRun(store: IClusterStore, id: string): Promise<GoalRunRecord> {
  let initial: GoalRunRecord | null | undefined;
  try { initial = await store.getGoalRun?.(id); return await processGoalRunOnce(store, id); }
  catch (error) {
    try {
      const goal = await store.getGoalRun?.(id);
      const newerReport = goal?.reportState === "ready" && (initial?.reportState !== "ready" || goal.reportFingerprint !== initial.reportFingerprint || goal.reportRevision !== initial.reportRevision);
      if (goal && goal.currentStage !== "planning" && goal.reportState !== "failed" && !newerReport && !ownedByForeignLiveTurn(goal, Date.now())) {
        await changeGoalRun(store, id, current => {
          // Another handler may have committed a report, or linked new work, after
          // the failing handler read its snapshot. Never invalidate that state.
          if (current.revision !== goal.revision) return current;
          return { ...current, reportState: "failed", currentStage: "report_retry", finalReport: undefined, reportFingerprint: undefined, completedAt: undefined };
        });
      }
    } catch { /* Keep the original error; the next pass reloads durable state. */ }
    throw error;
  }
}

async function processGoalRunOnce(store: IClusterStore, id: string): Promise<GoalRunRecord> {
  const before = await store.getGoalRun?.(id);
  if (before?.currentStage === "planning") {
    const conversation = await store.getConversation?.(before.conversationId);
    const response = conversation ? [...conversation.messages].reverse().find(message => message.sender === "assistant" && message.metadata?.goalRunId === id &&
      (!before.turnLease || message.metadata?.goalRunTurnId === before.turnLease.turnId)) : undefined;
    if (response) await changeGoalRun(store, id, current => {
      if (current.currentStage === "planning") { current.currentStage = "awaiting_verification"; current.interimReport = response.content; current.interimMessageId = response.id; current.reportRevision++; }
      return current;
    });
  }
  let goal = await reconcileGoalRun(store, id);
  if (!REPORTABLE_GOAL_STATES.has(goal.status)) return goal;
  if (goalHasNoExecution(goal)) return convergeConversationalGoal(store, goal);
  const records = await loadGoalEvidence(store, goal);
  if (records.tasks.some(task => !TERMINAL_TASK_STATES.includes(task.status))
    || records.graphs.some(graph => !TERMINAL_GRAPH_STATES.includes(graph.status))) return goal;

  const now = Date.now();
  const evaluation = evaluateGoalCoverage({
    goal, now, graphs: records.graphs, tasks: records.tasks,
    graphNodes: records.graphNodes, graphVerifications: records.graphVerifications,
    artifacts: records.artifacts, scoutReports: records.scoutReports,
  });
  // Required work is still in flight: keep waiting instead of publishing a premature verdict.
  if (evaluation.goalVerification === "pending") return goal;
  goal = await persistCoverageEvaluation(store, goal, evaluation);
  const resolvedStatus = resolveGoalStatus({
    currentStage: goal.currentStage,
    taskStates: goalTaskStates(goal, records.tasks, records.graphs),
    graphStates: records.graphs.map(graph => graph.status),
    verification: evaluation.goalVerification,
    missingScoutDispatch: hasMissingScoutDispatch(goal, records.tasks),
  });

  const artifacts = records.artifacts
    .filter(artifact => (artifact.status ?? "available") === "available" && records.tasks.some(task => task.taskId === artifact.producerTaskId));
  const scoutReports = records.scoutReports;
  const scoutCandidates = scoutReports.flatMap(item => (Array.isArray(item.report.candidates) ? item.report.candidates : [] as unknown[])
    .slice(0, 20)
    .filter((candidate): candidate is { projectName: string; canonicalPath: string; evidences: unknown[] } =>
      Boolean(candidate && typeof candidate === "object" && typeof (candidate as any).projectName === "string"
        && typeof (candidate as any).canonicalPath === "string" && Array.isArray((candidate as any).evidences) && (candidate as any).evidences.length > 0))
    .map(candidate => ({ taskId: item.taskId, nodeId: item.nodeId, seq: item.seq, name: candidate.projectName.slice(0, 200), path: candidate.canonicalPath.slice(0, 500) })));
  const scoutScans = scoutReports.flatMap(item => (Array.isArray(item.report.scanReceipts) ? item.report.scanReceipts as any[] : [])
    .filter((scan: any) => scan && Array.isArray(scan.authorizedRoots) && scan.authorizedRoots.every((root: unknown) => typeof root === "string")
      && typeof scan.scope === "string" && typeof scan.truncated === "boolean" && Array.isArray(scan.errors))
    .slice(0, 10)
    .map((scan: any) => ({ taskId: item.taskId, nodeId: item.nodeId, seq: item.seq, authorizedRoots: scan.authorizedRoots.slice(0, 20), scope: scan.scope.slice(0, 1000), truncated: scan.truncated, errorCount: scan.errors.length })));

  const facts: TaskEvidenceInput[] = records.tasks.map(task => ({
    taskId: task.taskId, nodeId: task.nodeId,
    graphId: task.dispatchOptions?.graphContext?.graphId,
    graphNodeId: task.dispatchOptions?.graphContext?.graphNodeId,
    kind: task.dispatchOptions?.graphContext ? "graph_node" : task.dispatchOptions?.contextOverrides?.taskType === "scout" ? "scout" : "plain_task",
    outcome: outcomeFromTaskStatus(task.status), verificationStatus: "unverified", sourceEvent: `task.${task.status}`,
    createdAt: task.createdAt, completedAt: task.completedAt,
    artifacts: artifacts.filter(artifact => artifact.producerTaskId === task.taskId).map(artifact => ({
      artifactId: artifact.artifactId, name: artifact.name, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes ?? 0,
      producerTaskId: artifact.producerTaskId, producerNodeId: artifact.producerNodeId, graphId: artifact.graphId, createdAt: artifact.createdAt ?? task.createdAt,
    })),
  }));
  const evidence = collectExecutionEvidence({ tasks: facts });
  const assessment = evaluateEvidenceSet(evidence);

  const coverageVersions = evaluation.graphContracts.map(contract => ({
    graphId: contract.graphId, graphRevision: contract.graphRevision, version: contract.version,
    scopeStatus: contract.current ? "verified" : "superseded",
  }));
  const coverageChecks = evaluation.checks.map(check => ({
    graphId: check.graphId,
    graphRevision: evaluation.graphContracts.find(contract => contract.graphId === check.graphId)?.graphRevision,
    graphNodeId: check.graphNodeId, requirementId: check.requirementId,
    taskId: check.taskId, nodeId: check.nodeId, runId: check.runId, status: check.status,
    verificationType: check.verificationType, verifiedAt: check.verifiedAt, artifactIds: check.artifactIds, reason: check.reason,
  }));

  const snapshot = {
    status: resolvedStatus,
    evaluation: { completion: evaluation.completion, verification: evaluation.goalVerification, counts: evaluation.counts, gaps: evaluation.coverageGaps, targets: evaluation.requiredTargets.map(target => [target.requirementId, target.status]) },
    taskStates: records.tasks.map(task => [task.taskId, task.status, task.updatedAt]),
    graphStates: records.graphs.map(graph => [graph.graphId, graph.status, graph.revision]),
    artifacts: artifacts.map(artifact => [artifact.artifactId, artifact.sha256]),
    scoutCandidates, scoutEvents: scoutReports.map(item => [item.taskId, item.seq]), scoutScans,
    discoveryScopes: goal.discoveryScopes, coverageVersions, coverageChecks, requiredExecutionScope: goal.requiredExecutionScope,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  if (goal.reportFingerprint === fingerprint && goal.reportState === "ready" && goal.status === resolvedStatus) return goal;

  const catalog = buildFactCatalog({ evidence, toolResults: scoutReports.map(item => ({ sourceId: `${item.taskId}:${item.seq}`, taskId: item.taskId, nodeId: item.nodeId, text: JSON.stringify(item.report) })) });
  for (const graph of records.graphs) catalog.identifiers.add(graph.graphId);
  for (const task of records.tasks) { catalog.identifiers.add(task.taskId); catalog.identifiers.add(task.nodeId); if (task.runId) catalog.identifiers.add(task.runId); }
  for (const check of evaluation.checks) { if (check.nodeId) catalog.identifiers.add(check.nodeId); if (check.taskId) catalog.identifiers.add(check.taskId); }

  const report = resolvedStatus === "completed"
    ? buildCompletedReport({ evaluation, records, artifacts, scoutCandidates })
    : buildPartialReport({ evaluation, records, artifacts, scoutCandidates, assessment: assessment.verdict });
  const finalReport = finalizeReport(report, catalog);

  const reportEvidence: GoalReportEvidence = {
    taskIds: records.tasks.map(task => task.taskId), graphIds: records.graphs.map(graph => graph.graphId),
    coverageVersions, coverageChecks,
    coverageScopes: evaluation.scopes.map(scope => ({
      discoveryId: scope.discoveryId, status: scope.status, requiredNodeIds: scope.requiredNodeIds,
      truncatedByLimit: scope.truncatedByLimit, reasons: scope.reasons,
      nodes: scope.nodes.map(node => ({ nodeId: node.nodeId, status: node.status, taskId: node.taskId, runId: node.runId, candidates: node.candidates, checkedRoots: node.checkedRoots, scanScope: node.scanScope, reason: node.reason })),
    })),
    coverage: {
      completion: evaluation.completion, counts: evaluation.counts, reasons: evaluation.reasons,
      observedScope: evaluation.observedScope, requiredTargets: evaluation.requiredTargets, coverageGaps: evaluation.coverageGaps,
    },
    artifactIds: artifacts.map(artifact => artifact.artifactId),
    artifacts: artifacts.map(artifact => ({ artifactId: artifact.artifactId, sha256: artifact.sha256, producerTaskId: artifact.producerTaskId ?? "" })),
    scoutEvents: scoutReports.map(item => ({ taskId: item.taskId, seq: item.seq, ...(Number.isSafeInteger(item.report.scanReceiptsOmitted) && (item.report.scanReceiptsOmitted as number) > 0 ? { omittedScans: item.report.scanReceiptsOmitted as number } : {}) })),
    scoutScans, verdict: assessment.verdict, fingerprint,
  };
  const reportRevision = goal.reportRevision + 1;
  const next: GoalRunRecord = {
    ...goal, status: resolvedStatus, currentStage: "report_ready", finalReport, reportState: "ready", reportFingerprint: fingerprint,
    reportEvidence, reportRevision, revision: goal.revision + 1, updatedAt: now, completedAt: now,
    reportHistory: [...(goal.reportHistory ?? []), { revision: reportRevision, fingerprint, content: finalReport, createdAt: now, evidence: reportEvidence, status: resolvedStatus }],
  };
  if (await store.updateGoalRun!(next, goal.revision)) return next;
  // A concurrent update owns the latest state. A later event or recovery pass retries.
  return (await store.getGoalRun!(id))!;
}

/**
 * Keep the deterministic report and drop only free-text lines (paths, queries, candidate
 * names) that would assert a number the execution records cannot corroborate.
 */
function finalizeReport(lines: string[], catalog: FactCatalog): string {
  const report = lines.join("\n");
  if (verifyAnswerFacts(report, catalog).violations.length === 0) return report;
  const kept = lines.filter(line => verifyAnswerFacts(line, catalog).violations.length === 0);
  const filtered = kept.join("\n");
  if (verifyAnswerFacts(filtered, catalog).violations.length) throw new Error("Generated execution report failed fact verification");
  return filtered;
}

function coverageCountLines(evaluation: GoalCoverageEvaluation): string[] {
  const { counts } = evaluation;
  return [
    `覆盖检查：合计 ${counts.requirements}，已核验 ${counts.verified}，由替代项承接 ${counts.replaced}，失败 ${counts.failed}，证据不足 ${counts.inconclusive}，结果未知 ${counts.unknown}，执行结束但未通过核验 ${counts.unverified}。`,
    ...evaluation.graphContracts.map(contract => `任务图 ${contract.graphId} 覆盖记录第 ${contract.version} 版（图修订 ${contract.graphRevision}）：检查项合计 ${contract.requirementCount}，当前修订${contract.current ? "一致" : "已推进"}。`),
  ];
}

function buildCompletedReport(input: {
  evaluation: GoalCoverageEvaluation;
  records: GoalEvidence;
  artifacts: GoalCoverageArtifact[];
  scoutCandidates: Array<{ taskId: string; nodeId: string; seq: number; name: string; path: string }>;
}): string[] {
  const { evaluation, records, artifacts, scoutCandidates } = input;
  const scopeNodes = evaluation.scopes.flatMap(scope => scope.nodes);
  return [
    "目标已完成：全部覆盖检查都取得了与各自执行尝试绑定的验证收据，规划阶段要求的检查范围均已完成。",
    ...coverageCountLines(evaluation),
    "实际检查的节点与授权范围：",
    ...(scopeNodes.length ? scopeNodes.flatMap(node => [
      `- 节点 ${node.nodeId}：授权根目录 ${node.checkedRoots.length ? node.checkedRoots.join("、") : "（收据未记录根目录）"}；扫描方式 ${JSON.stringify(node.scanScope ?? "未记录")}（任务 ${node.taskId ?? "无"}）。`,
    ]) : []),
    ...records.graphs.flatMap(graph => evaluation.checks.filter(check => check.graphId === graph.graphId).map(check =>
      `- 图节点 ${check.graphNodeId}（任务图 ${graph.graphId}）：Worker ${check.nodeId ?? "未记录"}，任务 ${check.taskId ?? "无"}，验证方式 ${check.verificationType ?? "未记录"}。`)),
    ...(artifacts.length ? ["已登记产物：", ...artifacts.map(artifact => `- ${artifact.artifactId}（来自任务 ${artifact.producerTaskId ?? "未记录"}）`)] : []),
    ...(scoutCandidates.length
      ? ["探查上报的候选（Worker 已校验真实路径与已读取的文件内容，协调器未另行独立复核）：", ...scoutCandidates.map(candidate => `- ${JSON.stringify(candidate.name)}，路径 ${JSON.stringify(candidate.path)}，来源任务 ${candidate.taskId}。`)]
      : evaluation.scopes.length
        ? ["结论：在本次实际检查的授权根目录与扫描方式范围内，没有发现与被探查目标相关的项目。"]
        : ["结论：全部规划检查项均已执行完成，并取得与各自执行尝试绑定的验证收据；具体结果以上面列出的执行记录与产物为准。"]),
    "边界说明：该结论只覆盖上面列出的节点、授权根目录与扫描方式；未列入的位置没有检查证据，不能据此判断那些位置是否存在目标项目。",
  ];
}

function buildPartialReport(input: {
  evaluation: GoalCoverageEvaluation;
  records: GoalEvidence;
  artifacts: GoalCoverageArtifact[];
  scoutCandidates: Array<{ taskId: string; nodeId: string; seq: number; name: string; path: string }>;
  assessment: string;
}): string[] {
  const { evaluation, records, artifacts, scoutCandidates, assessment } = input;
  const unmet = [
    ...evaluation.checks.filter(check => !check.met).map(check => `检查 ${check.graphNodeId}（任务图 ${check.graphId}）：${check.status}，${check.reason}`),
    ...evaluation.scopes.flatMap(scope => scope.nodes.filter(node => !node.met).map(node => `节点 ${node.nodeId} 的探查：${node.status}，${node.reason}`)),
    ...evaluation.scopes.filter(scope => scope.status !== "verified").flatMap(scope => scope.reasons.map(reason => `探查 ${scope.discoveryId}：${reason}`)),
    ...evaluation.requiredTargets.filter(target => target.status !== "covered").map(target => `规划必需目标 ${target.key}：${target.status}`),
    ...evaluation.coverageGaps,
  ];
  return [
    records.tasks.length || records.graphs.length
      ? "部分结果：执行已结束，但目标覆盖范围和结论尚未完成独立核验。不能据此判断未检查范围内是否存在目标。"
      : "部分结果：没有可核验的关联执行记录，目标覆盖范围尚未确认。不能据此判断未检查范围内是否存在目标。",
    ...coverageCountLines(evaluation),
    ...(unmet.length ? ["未通过核验的必需项：", ...unmet.map(item => `- ${item}`)] : []),
    "实际检查的节点与授权范围：",
    ...evaluation.scopes.flatMap(scope => scope.nodes.map(node =>
      `- 节点 ${node.nodeId}：${node.status}，授权根目录 ${node.checkedRoots.length ? node.checkedRoots.join("、") : "（收据未记录根目录）"}，任务 ${node.taskId ?? "无"}。`)),
    "执行记录：",
    ...records.graphs.map(graph => `任务图 ${graph.graphId}: ${graph.status}`),
    ...records.tasks.map(task => `任务 ${task.taskId}（节点 ${task.nodeId}）: ${task.status}`),
    ...artifacts.map(artifact => `登记产物 ${artifact.artifactId}（来自任务 ${artifact.producerTaskId ?? "未记录"}）`),
    ...scoutCandidates.map(candidate => `Scout 上报候选（尚未独立核验） ${JSON.stringify(candidate.name)}，路径 ${JSON.stringify(candidate.path)}，来源任务 ${candidate.taskId}`),
    `证据状态：${assessment}。请查看任务事件和产物核对具体结果。`,
  ];
}
