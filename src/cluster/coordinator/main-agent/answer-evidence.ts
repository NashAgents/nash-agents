/**
 * 最终回答的确定性证据闸门。
 *
 * 目标：不允许把「失败 / 超时 / 从未执行」的节点，用自然语言说成「不存在 / 未发现 / 已排查」。
 * 判定只使用运行时执行数据（统一执行证据集合 / goalEvaluation / nodeResults / Scout outcome），
 * 绝不解析模型措辞，也不依赖系统提示词自律。
 *
 * 演进说明：早先只读取「当前任务图」与「Scout 报告」，导致同一轮内真实成功的普通任务
 * （dispatch_cluster_task）被漏出已完成范围，输出「已完成：（无）」的反向低估。
 * 现在统一由 collectExecutionEvidence 生成的证据集合驱动，普通 Task / Scout / DAG /
 * 子 Agent / Artifact 都在同一口径下计数。
 */
import {
  collectExecutionEvidence,
  type EvidenceKind,
  type EvidenceOutcome,
  type ExecutionEvidenceSet,
  type TaskEvidenceInput,
} from "./execution-evidence.js";

export type AnswerEvidenceVerdict = "pass" | "partial" | "unknown";

export interface AnswerEvidenceInput {
  /** 任务图目标评估（来自 run/replan 工具返回值，而不是模型文本）。 */
  goalEvaluation?: {
    completionStatus?: string;
    completedNodeIds?: string[];
    failedNodeIds?: string[];
    blockedNodeIds?: string[];
    pendingNodeIds?: string[];
  };
  /** 任务图节点结果。 */
  nodeResults?: Array<{ nodeId: string; status?: string; error?: string }>;
  /** discover_cluster_resources 的逐节点结论。 */
  scoutEvidence?: {
    nodeReports?: Array<{ nodeId: string; outcome?: string; status?: string }>;
    inconclusiveNodeIds?: string[];
    scopeStatus?: string;
  };
  /** 本次轮次是否尝试过图执行、是否真的建成了图。 */
  graphExecutionAttempted?: boolean;
  graphCreated?: boolean;
}

export interface AnswerEvidenceResult {
  verdict: AnswerEvidenceVerdict;
  completedNodeIds: string[];
  inconclusiveNodeIds: string[];
  reason: string;
  /** 需要前置到回答里的固定模板说明；pass 时为 undefined。 */
  annotation?: string;
  /** 证据覆盖口径（供 API/UI 展示），不参与判定。 */
  coverage?: {
    tasks: number;
    completedTasks: number;
    failedTasks: number;
    unknownTasks: number;
    workers: number;
    artifacts: number;
    kinds: EvidenceKind[];
  };
}

const COMPLETED = new Set(["completed", "succeeded", "success", "done", "skipped"]);

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}

function label(ids: string[]): string {
  return ids.length ? ids.join("、") : "（无）";
}

function evidenceIdFor(entry: { kind: EvidenceKind; graphNodeId?: string; sourceTaskId?: string; sourceWorkerId?: string }): string | undefined {
  // Scout 的结论归属是「节点」而非内部任务号，对外展示与比对都使用节点身份。
  if (entry.kind === "scout") return entry.sourceWorkerId ?? entry.sourceTaskId;
  return entry.graphNodeId ?? entry.sourceTaskId ?? entry.sourceWorkerId;
}

/**
 * 纯函数：基于统一执行证据集合判定本轮回答的证据范围。
 *
 * - pass：所有涉及的执行单元都真实完成，模型可以自由陈述结论；
 * - partial：部分完成、部分未得出结论；
 * - unknown：没有任何执行单元得出结论（或目标根本没有被执行）。
 */
export function evaluateEvidenceSet(set: ExecutionEvidenceSet): AnswerEvidenceResult {
  const coverage = {
    tasks: set.counts.tasks,
    completedTasks: set.counts.completedTasks,
    failedTasks: set.counts.failedTasks,
    unknownTasks: set.counts.unknownTasks,
    workers: set.counts.workers,
    artifacts: set.counts.artifacts,
    kinds: [...new Set(set.entries.map((entry) => entry.kind))],
  };

  // 1. 尝试过图执行但没有建成图：目标根本没有被执行。
  if (set.turn?.graphExecutionAttempted && !set.turn?.graphCreated) {
    return {
      verdict: "unknown",
      completedNodeIds: [],
      inconclusiveNodeIds: unique(set.unknownTaskIds),
      reason: "任务图未建立并通过验证，目标未被真实执行。",
      annotation: "【证据范围（确定性校验）】本轮任务图未建立，目标未被真实执行。以下内容不得表述为“已排查 / 不存在 / 未发现”。",
      coverage,
    };
  }

  // 2. 探查范围本身不成立（无在线节点 / 已知节点全部离线）。
  const scopeStatus = set.scout?.scopeStatus;
  if (scopeStatus && scopeStatus !== "completed") {
    return {
      verdict: "unknown",
      completedNodeIds: [],
      inconclusiveNodeIds: unique([...(set.scout?.inconclusiveNodeIds ?? []), ...set.unknownTaskIds]),
      reason: `探查范围状态为 '${scopeStatus}'，未执行任何有效节点扫描。`,
      annotation: `【证据范围（确定性校验）】探查范围状态为“${scopeStatus}”，本轮未执行有效节点扫描，集群覆盖为零。以下内容不得表述为“已排查 / 不存在 / 未发现”。`,
      coverage,
    };
  }

  const completed: string[] = [];
  const inconclusive: string[] = [];

  // 3. 统一证据集合：普通任务、图节点、Scout、子 Agent 一视同仁。
  //    Artifact 证据跟随其生产任务，不单独计入完成范围，避免用产物冒充当节点结论。
  for (const entry of set.entries) {
    if (entry.kind === "artifact") continue;
    const id = evidenceIdFor(entry);
    if (!id) continue;
    if (COMPLETED.has(entry.outcome)) completed.push(id);
    else inconclusive.push(id);
  }

  // 4. 任务图目标评估作为补充口径（工具返回值，非模型声明）。
  const completionStatus = set.graph?.completionStatus;
  const completedNodeIds = unique(completed);
  const inconclusiveNodeIds = unique(inconclusive).filter((id) => !completedNodeIds.includes(id));

  if (inconclusiveNodeIds.length === 0) {
    if (completedNodeIds.length === 0) {
      return {
        verdict: "pass",
        completedNodeIds,
        inconclusiveNodeIds,
        reason: "本轮没有涉及多节点执行证据，无需附加范围说明。",
        coverage,
      };
    }
    return { verdict: "pass", completedNodeIds, inconclusiveNodeIds, reason: "所有涉及节点均已完成。", coverage };
  }

  const verdict: AnswerEvidenceVerdict = completedNodeIds.length > 0 ? "partial" : "unknown";
  const annotation =
    `【证据范围（确定性校验）】已完成：${label(completedNodeIds)}；未得出结论：${label(inconclusiveNodeIds)}` +
    (completionStatus ? `（目标状态：${completionStatus}）` : "") +
    "。以下结论不构成对未得出结论节点的物理状态确认，不得表述为“不存在 / 未发现 / 已排查”。";

  return {
    verdict,
    completedNodeIds,
    inconclusiveNodeIds,
    reason: completedNodeIds.length === 0
      ? "没有任何节点得出确定结论"
      : `存在 ${inconclusiveNodeIds.length} 个未得出结论的节点。`,
    annotation,
    coverage,
  };
}

const NODE_STATUS_TO_OUTCOME: Record<string, EvidenceOutcome> = {
  completed: "completed",
  succeeded: "completed",
  success: "completed",
  done: "completed",
  skipped: "skipped",
  failed: "failed",
};

/**
 * 兼容入口：把历史输入形态（任务图 + Scout）折算成统一证据集合后判定。
 * 新代码应直接使用 evaluateEvidenceSet。
 */
export function evaluateAnswerEvidence(input: AnswerEvidenceInput): AnswerEvidenceResult {
  const tasks: TaskEvidenceInput[] = [];

  for (const node of input.nodeResults ?? []) {
    tasks.push({
      taskId: `graph-node:${node.nodeId}`,
      kind: "graph_node",
      graphNodeId: node.nodeId,
      outcome: (node.status ? NODE_STATUS_TO_OUTCOME[node.status] : undefined) ?? "unknown",
      detail: node.error,
    });
  }

  for (const id of input.goalEvaluation?.completedNodeIds ?? []) {
    if (!tasks.some((task) => task.graphNodeId === id)) {
      tasks.push({ taskId: `graph-node:${id}`, kind: "graph_node", graphNodeId: id, outcome: "completed" });
    }
  }
  const inconclusiveGoalIds = unique([
    ...(input.goalEvaluation?.failedNodeIds ?? []),
    ...(input.goalEvaluation?.blockedNodeIds ?? []),
    ...(input.goalEvaluation?.pendingNodeIds ?? []),
  ]);
  for (const id of inconclusiveGoalIds) {
    if (!tasks.some((task) => task.graphNodeId === id)) {
      tasks.push({ taskId: `graph-node:${id}`, kind: "graph_node", graphNodeId: id, outcome: "unknown" });
    }
  }

  const scoutReports = input.scoutEvidence?.nodeReports ?? [];
  for (const report of scoutReports) {
    tasks.push({
      taskId: `scout:${report.nodeId}`,
      kind: "scout",
      nodeId: report.nodeId,
      outcome: (report.outcome ?? report.status) === "completed" ? "completed" : "unknown",
    });
  }
  for (const nodeId of input.scoutEvidence?.inconclusiveNodeIds ?? []) {
    if (!tasks.some((task) => task.kind === "scout" && task.nodeId === nodeId)) {
      tasks.push({ taskId: `scout:${nodeId}`, kind: "scout", nodeId, outcome: "unknown" });
    }
  }

  const set = collectExecutionEvidence({
    tasks,
    graph: input.goalEvaluation?.completionStatus ? { graphId: "graph:legacy", completionStatus: input.goalEvaluation.completionStatus } : undefined,
    scout: input.scoutEvidence?.scopeStatus ? { scopeStatus: input.scoutEvidence.scopeStatus } : undefined,
    turn: { graphExecutionAttempted: input.graphExecutionAttempted, graphCreated: input.graphCreated },
  });

  // 旧入口的「节点」语义包含 Scout 逐节点结论，完成 id 以 nodeId 呈现。
  return evaluateEvidenceSet(set);
}

/** 把确定性说明前置到回答正文（保留模型原文，不改写其结论）。 */
export function annotateAnswer(answer: string | undefined, guard: AnswerEvidenceResult): string {
  if (!guard.annotation) return answer ?? "";
  const body = (answer ?? "").trim();
  return body ? `${guard.annotation}\n\n${body}` : guard.annotation;
}
