/**
 * Deterministic GoalRun coverage evaluation.
 *
 * A terminal Task state is not proof that the user's goal was covered. This module
 * turns coverage requirements (admitted graph checks and discovery scopes) into
 * per-requirement verdicts bound to one attempt, run, worker and evidence receipt,
 * and derives the GoalRun's completion from those verdicts alone.
 *
 * Nothing here calls a model. The model may describe the resulting evaluation in
 * natural language afterwards, but it never decides whether coverage passed.
 */
import type { ClusterTaskRecord, GoalCoverageContract, GoalDiscoveryScope, GoalRunRecord } from "./cluster-store-types.js";
import type { DistributedGraphNodeRecord, DistributedGraphRecord, GraphVerificationRecord } from "../graph/types.js";

export type GoalCoverageCheckState =
  | "verified"
  | "completed_unverified"
  | "revision_mismatch"
  | "superseded"
  | "planned"
  | "dispatched"
  | "running"
  | "waiting_approval"
  | "failed"
  | "inconclusive"
  | "unknown"
  | "missing";

/** Rollup for one discovery scope; `pending` means at least one node still owes evidence. */
export type GoalCoverageScopeStatus = "verified" | "pending" | "failed" | "inconclusive" | "unknown";

/** States that mean "work still owed", so the goal may not converge yet. */
const ACTIVE_STATES: ReadonlySet<GoalCoverageCheckState> = new Set(["planned", "dispatched", "running", "waiting_approval"]);

/** Graph states that will not schedule further work for their nodes. */
const TERMINAL_GRAPH_STATUSES: ReadonlySet<string> = new Set(["completed", "partially_completed", "failed", "cancelled"]);

export interface GoalCoverageArtifact {
  artifactId: string;
  name: string;
  sha256: string;
  sizeBytes?: number;
  producerTaskId?: string;
  producerNodeId?: string;
  graphId?: string;
  status?: string;
  createdAt?: number;
}

/** A persisted `discovery.report_persisted` event, bound to the emitting attempt. */
export interface ScoutReportEvidence {
  taskId: string;
  nodeId: string;
  runId?: string;
  seq: number;
  report: {
    nodeId?: unknown;
    query?: unknown;
    candidates?: unknown;
    scanReceipts?: unknown;
    scanReceiptsOmitted?: unknown;
    outcome?: unknown;
    stillRunning?: unknown;
    summary?: unknown;
  };
}

export interface GoalCoverageGraphCheck {
  kind: "graph_node";
  requirementId: string;
  graphId: string;
  graphNodeId: string;
  goal: string;
  targetNodeId?: string;
  targetProjectId?: string;
  status: GoalCoverageCheckState;
  reason: string;
  taskId?: string;
  nodeId?: string;
  runId?: string;
  attempt?: number;
  verificationType?: string;
  verifiedAt?: number;
  artifactIds: string[];
  replacedBy?: string;
  met: boolean;
}

export interface GoalCoverageScoutNode {
  kind: "scout_node";
  requirementId: string;
  discoveryId: string;
  nodeId: string;
  status: GoalCoverageCheckState;
  reason: string;
  taskId?: string;
  runId?: string;
  reportSeq?: number;
  candidates: number;
  checkedRoots: string[];
  scanScope?: string;
  truncated?: boolean;
  met: boolean;
}

export interface GoalCoverageScopeEvaluation {
  discoveryId: string;
  query: string;
  selectionSource: GoalDiscoveryScope["selectionSource"];
  requiredNodeIds: string[];
  snapshotOnlineNodeIds: string[];
  unselectedOnlineNodeIds: string[];
  truncatedByLimit: boolean;
  status: GoalCoverageScopeStatus;
  reasons: string[];
  nodes: GoalCoverageScoutNode[];
}

export interface GoalCoverageRequiredTarget {
  requirementId: string;
  graphId: string;
  key: string;
  label?: string;
  nodeId?: string;
  candidateNodeIds: string[];
  status: "covered" | "uncovered" | "pending";
  satisfiedBy: string[];
}

export interface GoalCoverageEvaluation {
  evaluatedAt: number;
  graphContracts: Array<{
    graphId: string;
    version: number;
    graphRevision: number;
    observedGraphRevision?: number;
    graphStatus?: string;
    current: boolean;
    rootGoalMatches: boolean;
    source: GoalCoverageContract["source"];
    requirementCount: number;
  }>;
  checks: GoalCoverageGraphCheck[];
  scopes: GoalCoverageScopeEvaluation[];
  requiredTargets: GoalCoverageRequiredTarget[];
  coverageGaps: string[];
  counts: {
    requirements: number;
    verified: number;
    replaced: number;
    failed: number;
    pending: number;
    inconclusive: number;
    unknown: number;
    unverified: number;
  };
  /** Coverage-only conclusion; the GoalRun status is still derived with the graph/task states. */
  completion: "completed" | "partially_completed" | "failed" | "outcome_unknown" | "pending";
  goalVerification: "passed" | "partial" | "failed" | "pending";
  reasons: string[];
  observedScope: { nodeIds: string[]; authorizedRoots: string[]; truncatedScopes: number };
  /** Staleness guard: reconcile only trusts a persisted evaluation with matching signatures. */
  evidence: { taskStates: Array<[string, string, number | undefined]>; graphStates: Array<[string, string, number]> };
}

export interface GoalCoverageEvaluationInput {
  goal: GoalRunRecord;
  now: number;
  graphs: Array<DistributedGraphRecord | null | undefined>;
  tasks: Array<ClusterTaskRecord | null | undefined>;
  graphNodes: Map<string, DistributedGraphNodeRecord[]>;
  graphVerifications: Map<string, GraphVerificationRecord[]>;
  artifacts: GoalCoverageArtifact[];
  scoutReports: ScoutReportEvidence[];
  /** Names of workers observed online in the plan-time catalog snapshot (per graphId). */
  catalogNodes?: Map<string, Array<{ nodeId: string; status: string }>>;
}

/** Coerce one persisted scout event into typed evidence, or undefined when it is not one. */
export function scoutEvidenceFromEvent(event: { taskId: string; nodeId: string; runId?: string; seq: number; eventType: string; data: Record<string, any> }): ScoutReportEvidence | undefined {
  if (event.eventType !== "discovery.report_persisted") return undefined;
  const report = event.data?.report;
  if (!report || typeof report !== "object") return undefined;
  return { taskId: event.taskId, nodeId: event.nodeId, runId: event.runId, seq: event.seq, report };
}

function isTask(value: ClusterTaskRecord | null | undefined): value is ClusterTaskRecord {
  return Boolean(value && typeof value.taskId === "string");
}

function isGraph(value: DistributedGraphRecord | null | undefined): value is DistributedGraphRecord {
  return Boolean(value && typeof value.graphId === "string");
}

/** Keep only the newest contract version per graph; older versions stay auditable in history. */
export function latestContracts(history: GoalCoverageContract[] | undefined): Map<string, GoalCoverageContract> {
  const current = new Map<string, GoalCoverageContract>();
  for (const contract of history ?? []) {
    const existing = current.get(contract.graphId);
    if (!existing || existing.version < contract.version) current.set(contract.graphId, contract);
  }
  return current;
}

function nodeState(node: DistributedGraphNodeRecord): GoalCoverageCheckState {
  switch (node.status) {
    case "completed": return "completed_unverified";
    case "failed": case "cancelled": return "failed";
    case "outcome_unknown": return "unknown";
    case "waiting_approval": return "waiting_approval";
    case "running": return "running";
    case "queued": case "dispatched": case "accepted": return "dispatched";
    case "ready": case "pending": case "waiting_dependencies": return "planned";
    case "blocked": return "inconclusive";
    case "skipped": return "superseded";
    default: return "inconclusive";
  }
}

function taskState(task: ClusterTaskRecord | undefined): GoalCoverageCheckState | undefined {
  if (!task) return undefined;
  switch (task.status) {
    case "completed": return "completed_unverified";
    case "failed": case "cancelled": return "failed";
    case "outcome_unknown": return "unknown";
    case "waiting_approval": return "waiting_approval";
    case "running": case "interrupting": return "running";
    case "cancelling": return "running";
    case "queued": case "dispatched": case "accepted": case "created": return "dispatched";
    default: return "planned";
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function latestVerification(records: GraphVerificationRecord[], graphNodeId: string): GraphVerificationRecord | undefined {
  const matches = records.filter(record => record.graphNodeId === graphNodeId);
  if (!matches.length) return undefined;
  return [...matches].sort((a, b) => a.verifiedAt - b.verifiedAt).at(-1);
}

interface CheckBindingInput {
  contract: GoalCoverageContract;
  graph: DistributedGraphRecord | undefined;
  node: DistributedGraphNodeRecord | undefined;
  task: ClusterTaskRecord | undefined;
  verification: GraphVerificationRecord | undefined;
  artifacts: GoalCoverageArtifact[];
  replacedBy?: string;
}

function describeUnverified(binding: CheckBindingInput): { status: GoalCoverageCheckState; reason: string } {
  const { graph, node, task, verification } = binding;
  if (!graph) return { status: "missing", reason: "任务图记录不存在，无法核验该检查项。" };
  if (graph.revision !== binding.contract.graphRevision) {
    return { status: "revision_mismatch", reason: `覆盖契约记录的是图修订 ${binding.contract.graphRevision}，当前图已推进到修订 ${graph.revision}。` };
  }
  if (!node) return { status: "missing", reason: "当前图修订中不存在该检查节点。" };
  let state = nodeState(node);
  // A convergence graph cannot still owe work: a node projection left in an active state is a
  // stale read, so it must degrade to "inconclusive" instead of holding the goal at "verifying".
  if (ACTIVE_STATES.has(state) && TERMINAL_GRAPH_STATUSES.has(graph.status)) {
    state = "inconclusive";
  }
  if (state !== "completed_unverified") {
    if (state === "superseded") {
      return binding.replacedBy
        ? { status: "superseded", reason: `该检查节点被跳过，覆盖由其替代项 ${binding.replacedBy} 承担。` }
        : { status: "inconclusive", reason: "该检查节点被跳过，且没有可追溯的替代项承接这一检查。" };
    }
    return { status: state, reason: `检查节点当前状态为 ${node.status}，尚未产生可核验的完成证据。` };
  }
  if (!node.taskId) return { status: "completed_unverified", reason: "检查节点已完成，但没有绑定执行任务。" };
  if (!task) return { status: "missing", reason: "检查节点绑定的任务记录不存在。" };
  const context = task.dispatchOptions?.graphContext;
  if (context?.graphId !== binding.contract.graphId || context?.graphNodeId !== node.nodeId) {
    return { status: "inconclusive", reason: "任务执行上下文不属于该图的这个节点，不能作为该检查项的证据。" };
  }
  if (node.assignedNodeId !== task.nodeId) {
    return { status: "inconclusive", reason: "节点分派的 Worker 与任务记录的 Worker 不一致。" };
  }
  const plannedTarget = binding.contract.checks.find(check => check.graphNodeId === node.nodeId)?.targetNodeId;
  if (plannedTarget && plannedTarget !== task.nodeId) {
    return { status: "inconclusive", reason: "任务实际执行的 Worker 不是规划时指定的目标节点。" };
  }
  if (!task.runId) return { status: "completed_unverified", reason: "任务没有持久化 run 身份，无法绑定验证收据。" };
  // A finished attempt without a matching receipt never counts as verified, even when
  // the task itself reports success and the model text claims completion.
  if (!verification) return { status: "completed_unverified", reason: "该次执行没有产生验证记录。" };
  if (verification.status !== "passed") return { status: "completed_unverified", reason: `验证记录状态为 ${verification.status}，不构成通过证据。` };
  if (verification.evidence?.executionSource !== "authenticated_worker_runtime") {
    return { status: "completed_unverified", reason: "验证记录不是由已认证 Worker 运行时产生。" };
  }
  if (verification.evidence?.taskId !== task.taskId) return { status: "completed_unverified", reason: "验证记录绑定的任务与当前执行尝试不一致。" };
  if (verification.evidence?.runId !== task.runId) return { status: "completed_unverified", reason: "验证记录绑定的 run 与当前执行尝试不一致。" };
  const workerNodeId = verification.evidence?.workerNodeId;
  if (typeof workerNodeId === "string" && workerNodeId !== task.nodeId) {
    return { status: "completed_unverified", reason: "验证记录绑定的 Worker 与任务记录的 Worker 不一致。" };
  }
  if (verification.evidence?.customChecksPassed === false) {
    return { status: "completed_unverified", reason: "验证记录显示自定义验收检查未通过。" };
  }
  const missing = (binding.contract.checks.find(check => check.graphNodeId === node.nodeId)?.acceptanceCriteria ?? [])
    .filter(criterion => criterion.type === "artifact_exists" && typeof criterion.expected === "string")
    .map(criterion => criterion.expected as string)
    .filter(name => !binding.artifacts.some(artifact => artifact.name === name && (artifact.status ?? "available") === "available" && (artifact.producerTaskId === task.taskId || artifact.graphId === binding.contract.graphId)));
  if (missing.length) return { status: "completed_unverified", reason: `缺少验收所需产物：${missing.slice(0, 3).join("、")}。` };
  const requiredMissing = (node.requiredArtifacts ?? [])
    .filter(requirement => !binding.artifacts.some(artifact => artifact.name === requirement.name
      && (artifact.status ?? "available") === "available"
      && (!requirement.requiredSha256 || artifact.sha256 === requirement.requiredSha256)));
  if (requiredMissing.length) return { status: "completed_unverified", reason: `缺少上游必需产物：${requiredMissing.map(item => item.name).slice(0, 3).join("、")}。` };
  return { status: "verified", reason: "验证收据与当前执行尝试、run、Worker 和产物一致。" };
}

function evaluateGraphContract(input: GoalCoverageEvaluationInput, contract: GoalCoverageContract): {
  checks: GoalCoverageGraphCheck[];
  contract: GoalCoverageEvaluation["graphContracts"][number];
  requiredTargets: GoalCoverageRequiredTarget[];
} {
  const graph = (input.graphs ?? []).filter(isGraph).find(item => item.graphId === contract.graphId);
  const nodes = input.graphNodes.get(contract.graphId) ?? [];
  const verifications = input.graphVerifications.get(contract.graphId) ?? [];
  const tasks = (input.tasks ?? []).filter(isTask);

  const baseChecks = contract.checks.map(check => {
    const node = nodes.find(item => item.nodeId === check.graphNodeId);
    const task = node?.taskId ? tasks.find(item => item.taskId === node.taskId) : undefined;
    const verification = latestVerification(verifications, check.graphNodeId);
    const binding: CheckBindingInput = { contract, graph, node, task, verification, artifacts: input.artifacts };
    return { check, node, task, verification, binding };
  });

  // A skipped node only counts as replaced when another check in the same revision
  // verifiably covers the same target worker/project.
  for (const entry of baseChecks) {
    if (entry.node?.status !== "skipped") continue;
    const target = entry.check.targetNodeId ?? entry.node.assignedNodeId;
    const replacement = baseChecks.find(other => other !== entry && other.node?.status === "completed" && other.node.nodeId !== entry.node!.nodeId
      && ((target && (other.check.targetNodeId ?? other.node.assignedNodeId) === target)
        || (entry.check.targetProjectId && other.check.targetProjectId === entry.check.targetProjectId)));
    if (replacement) entry.binding.replacedBy = replacement.check.graphNodeId;
  }

  const checks: GoalCoverageGraphCheck[] = baseChecks.map(({ check, node, task, verification, binding }) => {
    const described = describeUnverified(binding);
    const artifactIds = input.artifacts
      .filter(artifact => task && artifact.producerTaskId === task.taskId && (artifact.status ?? "available") === "available")
      .map(artifact => artifact.artifactId);
    const status = described.status;
    return {
      kind: "graph_node" as const,
      requirementId: `graph:${contract.graphId}:${check.graphNodeId}`,
      graphId: contract.graphId,
      graphNodeId: check.graphNodeId,
      goal: check.goal,
      targetNodeId: check.targetNodeId ?? node?.assignedNodeId,
      targetProjectId: check.targetProjectId ?? node?.assignedProjectId,
      status,
      reason: described.reason,
      taskId: task?.taskId,
      nodeId: task?.nodeId ?? node?.assignedNodeId,
      runId: task?.runId,
      attempt: task?.dispatchOptions?.graphContext?.executionAttempt,
      verificationType: verification?.verificationType,
      verifiedAt: verification?.verifiedAt,
      artifactIds,
      replacedBy: binding.replacedBy,
      met: status === "verified" || (status === "superseded" && Boolean(binding.replacedBy)),
    };
  });

  const requiredTargets: GoalCoverageRequiredTarget[] = (contract.requiredTargets ?? []).map(target => {
    const matches = checks.filter(check => target.nodeId
      ? check.nodeId === target.nodeId || check.targetNodeId === target.nodeId
      : target.candidateNodeIds.some(candidate => candidate === check.nodeId || candidate === check.targetNodeId));
    const satisfiedBy = matches.filter(check => check.met).map(check => check.graphNodeId);
    const status: GoalCoverageRequiredTarget["status"] = satisfiedBy.length
      ? "covered"
      : matches.some(check => ACTIVE_STATES.has(check.status)) ? "pending" : "uncovered";
    return {
      requirementId: `target:${contract.graphId}:${target.key}`,
      graphId: contract.graphId,
      key: target.key, label: target.label, nodeId: target.nodeId,
      candidateNodeIds: [...target.candidateNodeIds], status, satisfiedBy,
    };
  });

  return {
    checks,
    requiredTargets,
    contract: {
      graphId: contract.graphId, version: contract.version, graphRevision: contract.graphRevision,
      observedGraphRevision: graph?.revision, graphStatus: graph?.status,
      current: Boolean(graph && graph.revision === contract.graphRevision),
      rootGoalMatches: contract.rootGoalMatches, source: contract.source,
      requirementCount: contract.checks.length,
    },
  };
}

function evaluateScoutNode(scope: GoalDiscoveryScope, nodeId: string, tasks: ClusterTaskRecord[], reports: ScoutReportEvidence[], onlineAtSnapshot: boolean): GoalCoverageScoutNode {
  const task = tasks.find(item => item.nodeId === nodeId
    && item.dispatchOptions?.contextOverrides?.discoveryId === scope.discoveryId
    && (item.dispatchOptions?.contextOverrides?.taskType === "scout" || item.dispatchOptions?.contextOverrides?.isDiscovery === true));
  const base = {
    kind: "scout_node" as const,
    requirementId: `scout:${scope.discoveryId}:${nodeId}`,
    discoveryId: scope.discoveryId,
    nodeId,
    candidates: 0,
    checkedRoots: [] as string[],
  };
  if (!task) {
    return { ...base, status: onlineAtSnapshot ? "missing" : "unknown", met: false,
      reason: onlineAtSnapshot ? "该节点在快照时在线，但没有为本次探查建立任何执行记录。" : "该节点在规划快照时就不在线，未产生任何检查证据。" };
  }
  const state = taskState(task);
  if (!task.runId || task.status !== "completed") {
    return { ...base, taskId: task.taskId, runId: task.runId, status: state ?? "missing", met: false,
      reason: `探查任务状态为 ${task.status}，尚未产生可核验的完成收据。` };
  }
  const receipt = reports
    .filter(item => item.taskId === task.taskId && item.nodeId === nodeId && item.runId === task.runId && item.report?.nodeId === nodeId)
    .sort((a, b) => a.seq - b.seq).at(-1);
  if (!receipt) {
    return { ...base, taskId: task.taskId, runId: task.runId, status: "completed_unverified", met: false,
      reason: "探查任务已完成，但没有为该次 run 持久化结构化发现报告。" };
  }
  const candidates = Array.isArray(receipt.report.candidates)
    ? receipt.report.candidates.filter(candidate => candidate && typeof candidate === "object"
      && typeof (candidate as any).projectName === "string" && typeof (candidate as any).canonicalPath === "string"
      && Array.isArray((candidate as any).evidences) && (candidate as any).evidences.length > 0)
    : [];
  const receipts = Array.isArray(receipt.report.scanReceipts) ? receipt.report.scanReceipts as Array<Record<string, unknown>> : [];
  const omitted = typeof receipt.report.scanReceiptsOmitted === "number" ? receipt.report.scanReceiptsOmitted : 0;
  const checkedRoots = receipts.flatMap(item => stringArray(item.authorizedRoots)).slice(0, 20);
  const scopes = receipts.map(item => typeof item.scope === "string" ? item.scope : "").filter(Boolean);
  const truncated = receipts.some(item => item.truncated === true);
  const errors = receipts.reduce((total, item) => total + (Array.isArray(item.errors) ? item.errors.length : 0), 0);
  const outcome = typeof receipt.report.outcome === "string" ? receipt.report.outcome : undefined;
  const common = { ...base, taskId: task.taskId, runId: task.runId, reportSeq: receipt.seq, candidates: candidates.length, checkedRoots, scanScope: scopes[0], truncated };

  if (outcome === "failed" || outcome === "timed_out" || outcome === "outcome_unknown") {
    return { ...common, status: "failed", met: false, reason: `探查报告如实记录了 ${outcome}，该节点的检查范围没有被覆盖。` };
  }
  if (candidates.length > 0) {
    // A positive finding answers "does this node have it?" regardless of scan truncation.
    return { ...common, status: "verified", met: true, reason: "该节点给出了带真实路径与文件内容证据的候选，属于阳性发现。" };
  }
  if (!receipts.length) {
    return { ...common, status: "inconclusive", met: false, reason: "报告没有附任何扫描收据，空结果不能证明目标不存在。" };
  }
  if (omitted > 0) {
    return { ...common, status: "inconclusive", met: false, reason: `有 ${omitted} 条扫描收据被省略，无法确认完整检查范围。` };
  }
  if (truncated) {
    return { ...common, status: "inconclusive", met: false, reason: "扫描收据标记为被截断，未检查的目录不能断言不存在。" };
  }
  if (errors > 0) {
    return { ...common, status: "inconclusive", met: false, reason: `扫描过程中有 ${errors} 处读取错误，检查范围不完整。` };
  }
  if (!checkedRoots.length) {
    return { ...common, status: "inconclusive", met: false, reason: "扫描收据没有记录任何授权根目录。" };
  }
  if (outcome && outcome !== "completed" && outcome !== "partial") {
    return { ...common, status: "inconclusive", met: false, reason: `探查报告状态为 ${outcome}，不作为覆盖证据。` };
  }
  return { ...common, status: "verified", met: true, reason: "扫描收据完整覆盖了授权的根目录，空结果在該范围内成立。" };
}

function evaluateScope(scope: GoalDiscoveryScope, tasks: ClusterTaskRecord[], reports: ScoutReportEvidence[]): GoalCoverageScopeEvaluation {
  const snapshotOnlineNodeIds = scope.snapshot.filter(entry => entry.nodeId && entry.connected).map(entry => entry.nodeId);
  const requiredNodeIds = [...new Set([...scope.selectedNodeIds, ...(scope.selectionSource === "catalog_clues" ? scope.knownClueNodeIds : [])])];
  const reasons: string[] = [];
  if (!requiredNodeIds.length) reasons.push("本次探查没有确定任何需要检查的节点，无法证明任何覆盖范围。");
  if (scope.truncatedByLimit) reasons.push("目标节点因数量上限被截断，未选中的节点没有检查证据。");
  const unselectedOnlineNodeIds = scope.selectionSource === "online_snapshot"
    ? snapshotOnlineNodeIds.filter(nodeId => !requiredNodeIds.includes(nodeId))
    : [];
  if (unselectedOnlineNodeIds.length) reasons.push(`快照时在线但未纳入检查的节点：${unselectedOnlineNodeIds.slice(0, 5).join("、")}。`);
  const offlineClues = scope.selectionSource === "catalog_clues"
    ? scope.knownClueNodeIds.filter(nodeId => scope.snapshot.find(entry => entry.nodeId === nodeId)?.connected === false)
    : [];
  if (offlineClues.length) reasons.push(`已知线索节点离线，未取得证据：${offlineClues.slice(0, 5).join("、")}。`);

  const nodes = requiredNodeIds.map(nodeId => evaluateScoutNode(scope, nodeId, tasks, reports, snapshotOnlineNodeIds.includes(nodeId)));
  const states = nodes.map(node => node.status);
  const status: GoalCoverageScopeStatus = !requiredNodeIds.length || unselectedOnlineNodeIds.length || scope.truncatedByLimit
    ? "inconclusive"
    : states.some(state => ACTIVE_STATES.has(state)) ? "pending"
      : states.every(state => state === "verified") ? "verified"
        : states.some(state => state === "unknown" || state === "missing") ? "unknown"
          : states.every(state => state === "failed") ? "failed" : "inconclusive";
  if (status !== "verified" && !reasons.length) reasons.push("必需节点的检查证据不完整。");
  return {
    discoveryId: scope.discoveryId, query: scope.query, selectionSource: scope.selectionSource,
    requiredNodeIds, snapshotOnlineNodeIds, unselectedOnlineNodeIds, truncatedByLimit: scope.truncatedByLimit,
    status, reasons, nodes,
  };
}

/** Build the two staleness signatures reconcile uses to decide whether a persisted evaluation still applies. */
export function coverageEvidenceSignature(input: { tasks: Array<ClusterTaskRecord | null | undefined>; graphs: Array<DistributedGraphRecord | null | undefined> }): GoalCoverageEvaluation["evidence"] {
  return {
    taskStates: (input.tasks ?? []).filter(isTask).map(task => [task.taskId, task.status, task.updatedAt ?? task.completedAt]),
    graphStates: (input.graphs ?? []).filter(isGraph).map(graph => [graph.graphId, graph.status, graph.revision]),
  };
}

export function sameCoverageEvidence(a: GoalCoverageEvaluation["evidence"] | undefined, b: GoalCoverageEvaluation["evidence"]): boolean {
  if (!a) return false;
  const normalize = (value: unknown) => JSON.stringify(value ?? []);
  return normalize(a.taskStates) === normalize(b.taskStates) && normalize(a.graphStates) === normalize(b.graphStates);
}

export function evaluateGoalCoverage(input: GoalCoverageEvaluationInput): GoalCoverageEvaluation {
  const tasks = (input.tasks ?? []).filter(isTask);
  const contracts = latestContracts(input.goal.coverageHistory);
  const evaluatedContracts = [...contracts.values()].map(contract => evaluateGraphContract(input, contract));

  const checks = evaluatedContracts.flatMap(item => item.checks);
  const requiredTargets = evaluatedContracts.flatMap(item => item.requiredTargets);
  const graphContracts = evaluatedContracts.map(item => item.contract);
  const scopes = (input.goal.discoveryScopes ?? []).map(scope => evaluateScope(scope, tasks, input.scoutReports ?? []));
  const scopeNodes = scopes.flatMap(scope => scope.nodes);

  const coverageGaps: string[] = [];
  for (const [graphId, contract] of contracts) {
    if (!contract.rootGoalMatches) coverageGaps.push(`任务图 ${graphId} 的计划目标与用户原始目标不一致，其检查不能代表用户目标。`);
    const currentVerifiedNodeIds = new Set(checks.filter(check => check.graphId === graphId && check.met).map(check => check.graphNodeId));
    const currentVerifiedTargets = new Set(checks.filter(check => check.graphId === graphId && check.met)
      .map(check => `${check.targetNodeId ?? ""}|${check.targetProjectId ?? ""}`).filter(key => key !== "|"));
    for (const older of (input.goal.coverageHistory ?? []).filter(item => item.graphId === graphId && item.version < contract.version)) {
      for (const check of older.checks) {
        if (currentVerifiedNodeIds.has(check.graphNodeId)) continue;
        const targetKey = `${check.targetNodeId ?? ""}|${check.targetProjectId ?? ""}`;
        if (targetKey === "|") continue; // no target identity to trace a replacement through
        if (currentVerifiedTargets.has(targetKey)) continue;
        coverageGaps.push(`任务图 ${graphId} 第 ${older.version} 版的检查节点 ${check.graphNodeId} 未被核验，且当前修订没有可追溯的替代检查。`);
      }
    }
  }

  const requirements = [...checks, ...scopeNodes];
  const counts = {
    requirements: requirements.length,
    verified: requirements.filter(item => item.status === "verified").length,
    replaced: requirements.filter(item => item.status === "superseded" && item.met).length,
    failed: requirements.filter(item => item.status === "failed").length,
    pending: requirements.filter(item => ACTIVE_STATES.has(item.status)).length,
    inconclusive: requirements.filter(item => item.status === "inconclusive" || (item.status === "superseded" && !item.met)).length,
    unknown: requirements.filter(item => item.status === "unknown" || item.status === "missing").length,
    unverified: requirements.filter(item => item.status === "completed_unverified" || item.status === "revision_mismatch").length,
  };

  const reasons: string[] = [];
  const unmet = requirements.filter(item => !item.met);
  const graphsById = new Map((input.graphs ?? []).filter(isGraph).map(graph => [graph.graphId, graph]));
  const failingGraph = [...graphsById.values()].find(graph => graph.status === "failed");
  const unknownGraph = [...graphsById.values()].find(graph => graph.status === "outcome_unknown");
  const incompleteGraph = [...graphsById.values()].find(graph => !["completed"].includes(graph.status));

  let completion: GoalCoverageEvaluation["completion"];
  if (!requirements.length) {
    completion = "partially_completed";
    reasons.push("没有任何可核验的覆盖计划：任务终态不能证明用户目标已被覆盖。");
  } else if (counts.pending > 0 || requiredTargets.some(target => target.status === "pending") || scopes.some(scope => scope.status === "pending")) {
    completion = "pending";
    reasons.push("仍有覆盖检查在执行或等待审批，目标不能提前收敛。");
  } else if (counts.unknown > 0 || scopes.some(scope => scope.status === "unknown")) {
    completion = "outcome_unknown";
    reasons.push("存在结果未知的必需检查，无法判断目标是否覆盖。");
  } else if (failingGraph) {
    completion = "failed";
    reasons.push(`任务图 ${failingGraph.graphId} 已失败，目标未能完成。`);
  } else if (unmet.length === 0 && !coverageGaps.length && requiredTargets.every(target => target.status === "covered") && !incompleteGraph) {
    completion = "completed";
    reasons.push("全部覆盖检查都取得了与当前执行尝试一致的验证收据。");
  } else {
    completion = "partially_completed";
    if (unmet.length) reasons.push(`有 ${unmet.length} 项必需检查没有取得可核验的完成证据。`);
    if (coverageGaps.length) reasons.push(...coverageGaps.slice(0, 3));
    const uncovered = requiredTargets.filter(target => target.status === "uncovered");
    if (uncovered.length) reasons.push(`有 ${uncovered.length} 个规划必需目标没有对应已验证检查：${uncovered.map(target => target.key).slice(0, 3).join("、")}。`);
    if (incompleteGraph && !unknownGraph) reasons.push(`任务图 ${incompleteGraph.graphId} 状态为 ${incompleteGraph.status}，不能作为完整覆盖。`);
    if (unknownGraph) reasons.push(`任务图 ${unknownGraph.graphId} 结果未知。`);
  }

  const goalVerification: GoalCoverageEvaluation["goalVerification"] =
    completion === "pending" ? "pending"
      : completion === "completed" ? "passed"
        : completion === "failed" ? "failed" : "partial";

  const authorizedRoots = [...new Set(scopes.flatMap(scope => scope.nodes.flatMap(node => node.checkedRoots)))].slice(0, 40);

  return {
    evaluatedAt: input.now,
    graphContracts, checks, scopes, requiredTargets, coverageGaps, counts, completion, goalVerification,
    reasons, observedScope: {
      nodeIds: [...new Set(scopes.flatMap(scope => scope.nodes.filter(node => node.met || node.status === "failed").map(node => node.nodeId)))],
      authorizedRoots,
      truncatedScopes: scopes.filter(scope => scope.truncatedByLimit).length,
    },
    evidence: coverageEvidenceSignature({ tasks, graphs: input.graphs }),
  };
}
