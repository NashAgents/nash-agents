import type { DistributedGraphNodeRecord, DistributedGraphRecord } from "../graph/types.js";
import type { GoalCoverageContract, GoalRunRecord } from "./cluster-store-types.js";

/** Captures exactly what was admitted, without claiming that the plan covers the user goal. */
export function recordGraphCoverage(goal: GoalRunRecord, graph: DistributedGraphRecord, nodes: DistributedGraphNodeRecord[], source: GoalCoverageContract["source"], now: number): void {
  const history = goal.coverageHistory ?? [];
  // A new admitted revision invalidates the verdict computed from the previous one.
  goal.coverageEvaluation = undefined;
  goal.coverageHistory = [...history, {
    version: (history.at(-1)?.version ?? 0) + 1,
    graphId: graph.graphId, graphRevision: graph.revision, rootGoal: goal.rootGoal, graphGoal: graph.parentGoal,
    rootGoalMatches: goal.rootGoal === graph.parentGoal, source, scopeStatus: "unverified",
    reason: "DAG validation and planner-selected targets do not independently prove complete coverage of the original user goal.",
    recordedAt: now, catalogSnapshot: structuredClone(graph.strategyDecision?.catalogSnapshot),
    requiredTargets: structuredClone(graph.strategyDecision?.requiredTargets ?? []),
    checks: nodes.map(node => ({ graphNodeId: node.nodeId, goal: node.goal, targetNodeId: node.assignedNodeId,
      targetProjectId: node.assignedProjectId, acceptanceCriteria: structuredClone(node.acceptanceCriteria), requiredSandboxPolicy: structuredClone(node.requiredSandboxPolicy) })),
  }];
  const existing = goal.requiredExecutionScope;
  if (existing == null || (typeof existing === "object" && (existing as { kind?: unknown }).kind === "graph_plan_coverage")) {
    const current = new Map<string, GoalCoverageContract>();
    for (const contract of goal.coverageHistory) current.set(contract.graphId, contract);
    goal.requiredExecutionScope = { kind: "graph_plan_coverage", completeness: "unverified", graphContracts: [...current.values()].map(contract => ({ graphId: contract.graphId, version: contract.version, graphRevision: contract.graphRevision })) };
  }
}
