/**
 * Graph State Projection (Phase 4)
 * 纯确定性事件聚合状态机与快照投影器
 * 为 CLI, TUI, REST API, SSE 及 Phase 5 Web 提供毫秒级实时视图
 */

import type { IClusterStore } from "../storage/cluster-store.js";
import type { GraphStateSnapshot, GraphStatus } from "./types.js";

export class GraphStateProjection {
  constructor(private readonly store: IClusterStore) {}

  /**
   * 计算指定 Graph 的最新状态快照
   */
  async projectGraphState(graphId: string): Promise<GraphStateSnapshot | null> {
    const graph = await this.store.getGraph?.(graphId);
    if (!graph) return null;

    const [nodes, artifacts, approvals] = await Promise.all([
      this.store.listGraphNodes?.(graphId) ?? [],
      this.store.listArtifacts?.(graphId) ?? [],
      this.store.listPendingApprovals(),
    ]);
    const taskIds = new Set(nodes.map((node) => node.taskId).filter(Boolean));
    const pendingApprovalsCount = approvals.filter((approval) => taskIds.has(approval.taskId)).length;

    let completedNodes = 0;
    let runningNodes = 0;
    let waitingNodes = 0;
    let blockedNodes = 0;
    let failedNodes = 0;

    const activeNodesByHost: Record<string, string[]> = {};

    for (const n of nodes) {
      if (n.status === "completed") completedNodes++;
      else if (["dispatched", "accepted", "running"].includes(n.status)) {
        runningNodes++;
        const host = n.assignedNodeId ?? "unassigned";
        if (!activeNodesByHost[host]) activeNodesByHost[host] = [];
        activeNodesByHost[host].push(n.nodeId);
      } else if (["pending", "waiting_dependencies", "ready", "waiting_approval"].includes(n.status)) {
        waitingNodes++;
      } else if (n.status === "blocked") {
        blockedNodes++;
      } else if (n.status === "failed") {
        failedNodes++;
      }
    }

    // 计算当前活跃阶段描述
    let currentPhase = "Ready to start";
    if (graph.status === "completed") {
      currentPhase = "All tasks completed successfully";
    } else if (graph.status === "failed") {
      currentPhase = "Execution failed";
    } else if (graph.status === "cancelled") {
      currentPhase = "Execution cancelled";
    } else if (pendingApprovalsCount > 0) {
      currentPhase = `Waiting for ${pendingApprovalsCount} approval(s)`;
    } else if (runningNodes > 0) {
      const runningTitles = nodes
        .filter((n) => ["dispatched", "accepted", "running"].includes(n.status))
        .map((n) => n.title)
        .slice(0, 2)
        .join("; ");
      currentPhase = `Executing: ${runningTitles}`;
    } else if (waitingNodes > 0) {
      currentPhase = "Waiting on dependency barriers";
    }

    return {
      graphId,
      parentGoal: graph.parentGoal,
      status: graph.status,
      revision: graph.revision,
      totalNodes: nodes.length,
      completedNodes,
      runningNodes,
      waitingNodes,
      blockedNodes,
      failedNodes,
      currentPhase,
      activeNodesByHost,
      pendingApprovalsCount,
      artifactsCount: artifacts.length,
      updatedAt: graph.updatedAt,
    };
  }
}
