/**
 * 统一执行证据集合 (Unified Execution Evidence Set)。
 *
 * 过去最终回答的证据闸门只读取「当前任务图」与「Scout 报告」，
 * 导致同一轮里真实成功的普通任务（dispatch_cluster_task）不计入已完成范围，
 * 反过来也让「部分任务未执行」被说成全集群完成。
 *
 * 这里把本轮所有可核验的执行事实收敛成**同一个**证据集合：
 * 普通 Task、Scout Task、DAG 节点、子 Agent 派发、Tool Call、Artifact、Replan/Join、Worker 终态。
 * 每条证据都带有来源身份（任务 / Worker / 产物 / 事件），判定只使用执行记录，不解析模型措辞。
 */

export type EvidenceOutcome =
  | "completed"
  | "failed"
  | "partial"
  | "skipped"
  | "unknown"
  | "pending"
  | "waiting_approval";

export type EvidenceKind =
  | "plain_task"
  | "scout"
  | "graph_node"
  | "sub_agent"
  | "artifact"
  | "replan"
  | "join"
  | "worker";

export type EvidenceScope = "execution" | "artifact" | "diagnostic";
export type VerificationStatus = "verified" | "unverified" | "failed" | "not_applicable";

export interface EvidenceArtifact {
  artifactId: string;
  name: string;
  sha256: string;
  sizeBytes: number;
  producerTaskId?: string;
  producerNodeId?: string;
  createdAt?: number;
  graphId?: string;
}

export interface TaskEvidenceInput {
  taskId: string;
  kind: EvidenceKind;
  nodeId?: string;
  graphId?: string;
  graphNodeId?: string;
  outcome: EvidenceOutcome;
  /** 该任务产出的已登记产物（归属与哈希由 ArtifactService 负责）。 */
  artifacts?: EvidenceArtifact[];
  verificationStatus?: VerificationStatus;
  /** 支撑该结论的执行事件标识（例如 "task.completed"）。 */
  sourceEvent?: string;
  detail?: string;
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface EvidenceCollectionInput {
  tasks?: TaskEvidenceInput[];
  graph?: {
    graphId: string;
    revision?: number;
    completionStatus?: string;
    replanApplied?: boolean;
  };
  scout?: {
    scopeStatus?: string;
    inconclusiveNodeIds?: string[];
    nodeReports?: Array<{ nodeId: string; outcome?: string; status?: string; taskId?: string }>;
  };
  onlineNodeIds?: string[];
  turn?: { graphExecutionAttempted?: boolean; graphCreated?: boolean };
}

export interface ExecutionEvidenceEntry {
  evidenceId: string;
  kind: EvidenceKind;
  sourceTaskId?: string;
  sourceWorkerId?: string;
  graphId?: string;
  graphNodeId?: string;
  outcome: EvidenceOutcome;
  verificationStatus: VerificationStatus;
  evidenceScope: EvidenceScope;
  sourceEvent?: string;
  sourceArtifact?: EvidenceArtifact;
  detail?: string;
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface WorkerEvidenceSummary {
  nodeId: string;
  completedTaskIds: string[];
  failedTaskIds: string[];
  unknownTaskIds: string[];
}

export interface ExecutionEvidenceSet {
  entries: ExecutionEvidenceEntry[];
  tasks: TaskEvidenceInput[];
  completedTaskIds: string[];
  failedTaskIds: string[];
  unknownTaskIds: string[];
  skippedTaskIds: string[];
  workers: WorkerEvidenceSummary[];
  artifacts: EvidenceArtifact[];
  counts: {
    tasks: number;
    completedTasks: number;
    failedTasks: number;
    unknownTasks: number;
    skippedTasks: number;
    workers: number;
    artifacts: number;
    graphNodes: number;
  };
  graph?: EvidenceCollectionInput["graph"];
  scout?: EvidenceCollectionInput["scout"];
  /** 轮次级事实：是否尝试过图执行、是否真的建成图。 */
  turn?: { graphExecutionAttempted?: boolean; graphCreated?: boolean };
}

const COMPLETED_OUTCOMES = new Set<EvidenceOutcome>(["completed"]);
const SKIPPED_OUTCOMES = new Set<EvidenceOutcome>(["skipped"]);

function uniq(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}

function entry(
  task: TaskEvidenceInput,
  outcome: EvidenceOutcome,
  extra?: Partial<ExecutionEvidenceEntry>
): ExecutionEvidenceEntry {
  return {
    evidenceId: `ev-${task.taskId}-${task.graphNodeId ?? task.kind}`,
    kind: task.kind,
    sourceTaskId: task.taskId,
    sourceWorkerId: task.nodeId,
    graphId: task.graphId,
    graphNodeId: task.graphNodeId,
    outcome,
    verificationStatus: task.verificationStatus ?? "unverified",
    evidenceScope: "execution",
    sourceEvent: task.sourceEvent,
    detail: task.detail,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    ...extra,
  };
}

/**
 * 纯函数：把本轮观察到的执行事实归一成统一证据集合。
 * 不做任何模型文本解析，不臆造未观察到的任务。
 */
export function collectExecutionEvidence(input: EvidenceCollectionInput): ExecutionEvidenceSet {
  const tasks = input.tasks ?? [];
  const entries: ExecutionEvidenceEntry[] = [];
  const artifacts: EvidenceArtifact[] = [];
  const seenArtifacts = new Set<string>();

  for (const task of tasks) {
    entries.push(entry(task, task.outcome));

    // Scout 报告的逐节点结论与任务证据并列，避免「Scout 失败但仍被当成已完成」。
    if (task.kind === "scout" && task.detail === undefined) {
      entries[entries.length - 1].detail = `Scout task ${task.taskId} outcome=${task.outcome}`;
    }

    for (const artifact of task.artifacts ?? []) {
      if (seenArtifacts.has(artifact.artifactId)) continue;
      seenArtifacts.add(artifact.artifactId);
      artifacts.push(artifact);
      entries.push({
        evidenceId: `ev-art-${artifact.artifactId}`,
        kind: "artifact",
        sourceTaskId: task.taskId,
        sourceWorkerId: artifact.producerNodeId ?? task.nodeId,
        graphId: artifact.graphId ?? task.graphId,
        graphNodeId: task.graphNodeId,
        outcome: task.outcome,
        verificationStatus: task.verificationStatus === "verified" || task.verificationStatus === undefined
          ? "verified"
          : task.verificationStatus,
        evidenceScope: "artifact",
        sourceEvent: "artifact.published",
        sourceArtifact: artifact,
        detail: `artifact ${artifact.name} sha256=${artifact.sha256.slice(0, 12)}…`,
        createdAt: artifact.createdAt,
      });
    }
  }

  // Scout 逐节点结论（即使未落到独立 task 记录，也必须有明确归属）。
  for (const report of input.scout?.nodeReports ?? []) {
    const outcome = normalizeScoutOutcome(report.outcome ?? report.status);
    entries.push({
      evidenceId: `ev-scout-${report.taskId ?? report.nodeId}`,
      kind: "scout",
      sourceTaskId: report.taskId,
      sourceWorkerId: report.nodeId,
      outcome,
      verificationStatus: outcome === "completed" ? "verified" : "unverified",
      evidenceScope: "diagnostic",
      sourceEvent: "discovery.node_report",
      detail: `scout node ${report.nodeId} outcome=${report.outcome ?? report.status ?? "unknown"}`,
    });
  }

  for (const nodeId of input.scout?.inconclusiveNodeIds ?? []) {
    entries.push({
      evidenceId: `ev-scout-inconclusive-${nodeId}`,
      kind: "scout",
      sourceWorkerId: nodeId,
      outcome: "unknown",
      verificationStatus: "unverified",
      evidenceScope: "diagnostic",
      sourceEvent: "discovery.inconclusive",
      detail: `scout node ${nodeId} inconclusive`,
    });
  }

  // Worker 终态：用于回答里「N 个节点」类断言与「全集群」类断言的确定性对照。
  const nodeIds = uniq([
    ...tasks.map((task) => task.nodeId),
    ...artifacts.map((artifact) => artifact.producerNodeId),
    ...(input.onlineNodeIds ?? []),
  ]);
  const workers: WorkerEvidenceSummary[] = nodeIds.map((nodeId) => {
    const ofNode = tasks.filter((task) => task.nodeId === nodeId);
    return {
      nodeId,
      completedTaskIds: ofNode.filter((task) => COMPLETED_OUTCOMES.has(task.outcome)).map((task) => task.taskId),
      failedTaskIds: ofNode.filter((task) => task.outcome === "failed" || task.outcome === "partial").map((task) => task.taskId),
      unknownTaskIds: ofNode.filter((task) => task.outcome === "unknown" || task.outcome === "pending" || task.outcome === "waiting_approval").map((task) => task.taskId),
    };
  });

  const completedTaskIds = uniq(tasks.filter((task) => COMPLETED_OUTCOMES.has(task.outcome)).map((task) => task.taskId));
  // 跳过的图节点不算「完成」，也不算「未知」——它在目标评估里是明确的处置结果。
  const skippedTaskIds = uniq(tasks.filter((task) => SKIPPED_OUTCOMES.has(task.outcome)).map((task) => task.taskId));
  const failedTaskIds = uniq(tasks.filter((task) => task.outcome === "failed" || task.outcome === "partial").map((task) => task.taskId));
  const unknownTaskIds = uniq(tasks
    .filter((task) => !COMPLETED_OUTCOMES.has(task.outcome) && !SKIPPED_OUTCOMES.has(task.outcome)
      && task.outcome !== "failed" && task.outcome !== "partial")
    .map((task) => task.taskId));

  return {
    entries,
    tasks,
    completedTaskIds,
    failedTaskIds,
    unknownTaskIds,
    skippedTaskIds,
    workers,
    artifacts,
    counts: {
      tasks: tasks.length,
      completedTasks: completedTaskIds.length,
      failedTasks: failedTaskIds.length,
      unknownTasks: unknownTaskIds.length,
      skippedTasks: skippedTaskIds.length,
      workers: nodeIds.length,
      artifacts: artifacts.length,
      graphNodes: tasks.filter((task) => task.kind === "graph_node").length,
    },
    graph: input.graph,
    scout: input.scout,
    turn: input.turn,
  };
}

function normalizeScoutOutcome(raw?: string): EvidenceOutcome {
  switch (raw) {
    case "completed":
    case "succeeded":
    case "success":
      return "completed";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "timed_out":
    case "timeout":
      return "unknown";
    case undefined:
    case "":
      return "unknown";
    default:
      return "unknown";
  }
}

/** 把任务状态映射为证据结论；未列出的状态一律视为未得出结论，绝不乐观推断。 */
export function outcomeFromTaskStatus(status?: string): EvidenceOutcome {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "failed";
    case "waiting_approval":
      return "waiting_approval";
    case "outcome_unknown":
      return "unknown";
    case "running":
    case "accepted":
    case "dispatched":
    case "queued":
    case "created":
    case "interrupting":
    case "interrupted":
    case "cancelling":
      return "pending";
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}
