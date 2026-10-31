/**
 * Global TaskSupervisor (Adaptive Multi-Agent Orchestration 2.0)
 * 任务图全局健康监督、预算告警与 Worker 离线处置：
 * - 写操作或显式固定节点任务在 Worker 掉线时严格收敛为 outcome_unknown，严禁盲目重试
 * - 只读且允许重分配 (explicitNodePinned === false && operation === "analyze") 的分析节点在有可用备选 Worker 时可通过 GraphReplanner 动态重派
 */

import type { IClusterStore } from "../storage/cluster-store.js";
import type { NodeRegistry } from "../coordinator/node-registry.js";
import type { DistributedGraphOrchestrator } from "./graph-orchestrator.js";
import type { GraphReplanner } from "./graph-replanner.js";
import type { DistributedGraphNodeRecord } from "./types.js";

export class GlobalGraphSupervisor {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: IClusterStore,
    private readonly registry: NodeRegistry,
    private readonly orchestrator: DistributedGraphOrchestrator,
    private readonly replanner?: GraphReplanner
  ) {}

  start(intervalMs = 10000): void {
    if (this.timer) return;
    // 启动时立即执行一次冷启动状态恢复与推进检查
    void this.superviseGraphs().catch((err) => {
      console.error(`[GlobalGraphSupervisor] Error in initial recovery pass:`, err);
    });
    this.timer = setInterval(() => {
      this.superviseGraphs().catch((err) => {
        console.error(`[GlobalGraphSupervisor] Error in supervise pass:`, err);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async superviseGraphs(): Promise<void> {
    const runningGraphs = (await this.store.listGraphs?.({ limit: 100000 }) ?? []).filter((g) =>
      ["running", "paused", "blocked", "cancelling", "outcome_unknown"].includes(g.status)
    );
    const now = Date.now();

    for (const graph of runningGraphs) {
      // 等待人工审批不消耗任何执行预算：只要图内有节点在等待审批，
      // 本轮就不得以任何墙钟（图级或节点级）终止它。
      const graphNodes = (await this.store.listGraphNodes?.(graph.graphId)) ?? [];
      const awaitingApproval = await this.hasNodeAwaitingApproval(graphNodes);

      // 1. 图级预算只做「软告警」，不再级联取消仍在工作的 Agent。
      //    A2A 不得用固定墙钟终止执行：运行中的节点由 Worker 自身预算、心跳与用户取消除约束。
      const elapsed = now - graph.createdAt;
      if (!awaitingApproval && graph.status === "running" && graph.budget.totalTimeoutMs > 0 && elapsed > graph.budget.totalTimeoutMs) {
        const graphEvents = (await this.store.listGraphEvents?.(graph.graphId)) ?? [];
        const alreadyNotified = graphEvents.some((event) => event.eventType === "graph.budget_exceeded");
        if (!alreadyNotified) {
          await this.store.appendGraphEvent?.(graph.graphId, "graph.budget_exceeded", {
            graphId: graph.graphId,
            elapsedMs: elapsed,
            totalTimeoutMs: graph.budget.totalTimeoutMs,
            note: "Budget exceeded; running agents are not cancelled. They finish under their own budgets or an explicit user cancel.",
          });
        }
      }

      // 2. 检查各子节点状态同步与 Worker 在线状态
      const nodes = graphNodes;
      for (const node of nodes) {
        if (node.taskId && !["completed", "failed", "cancelled", "skipped"].includes(node.status)) {
          const task = await this.store.getTask(node.taskId);
          if (task?.status === "completed") {
            const events = await this.store.getEventsForTask(task.taskId, 0, 100000);
            const completion = events.reverse().find((e) => e.eventType === "task.completed")?.data;
            await this.orchestrator.handleNodeTaskCompleted(
              graph.graphId,
              task.taskId,
              task.finalAnswer ?? "",
              completion?.producedArtifacts as any,
              completion?.verificationEvidence as any
            );
            continue;
          }
          if (task?.status === "failed") {
            await this.orchestrator.handleNodeTaskFailed(
              graph.graphId,
              task.taskId,
              task.error ?? "Task failed"
            );
            continue;
          }
          if (task?.status === "cancelled") {
            await this.orchestrator.handleNodeTaskCancelled(
              graph.graphId,
              task.taskId,
              task.error
            );
            continue;
          }
          if (task?.status === "outcome_unknown") {
            await this.orchestrator.syncTaskActivity(task.taskId);
            continue;
          }
        }

        if (
          node.status === "running" ||
          node.status === "dispatched" ||
          node.status === "accepted"
        ) {
          // 执行预算由 Worker 计量，避免审批等待被协调器墙钟重复计算。
          // 检查 Worker 连接存活。
          if (node.assignedNodeId) {
            const conn = this.registry.getConnection(node.assignedNodeId);
            if (!conn) {
              // 若是只读分析任务且未显式锁定唯一节点，尝试通过 Replanner 重分配至其他在线 Worker
              let reassigned = false;
              if (
                this.replanner &&
                node.operation === "analyze" &&
                node.explicitNodePinned === false &&
                graph.revision < graph.budget.maxReplanAttempts
              ) {
                const allProjects = (await this.store.listProjectsCatalog?.()) ?? [];
                const altProject = allProjects.find(
                  (p) =>
                    p.status === "active" &&
                    p.nodeId !== node.assignedNodeId &&
                    Boolean(this.registry.getConnection(p.nodeId))
                );
                if (altProject) {
                  const replanRes = await this.replanner.replanGraph({
                    graphId: graph.graphId,
                    trigger: "worker_unavailable",
                    reason: `Read-only analysis worker '${node.assignedNodeId}' disconnected; reassigning '${node.nodeId}' to online worker '${altProject.nodeId}'.`,
                    reassignNodes: [
                      {
                        nodeId: node.nodeId,
                        targetNodeId: altProject.nodeId,
                        targetProjectId: altProject.projectId,
                      },
                    ],
                  });
                  reassigned = replanRes.success;
                }
              }

              if (!reassigned) {
                // 写任务或无可替代 Worker：严格收敛为 OUTCOME_UNKNOWN，杜绝自动换机重试导致双写冲突
                await this.store.updateGraphNodeStatus?.(
                  graph.graphId,
                  node.nodeId,
                  "outcome_unknown",
                  {
                    error: `Worker '${node.assignedNodeId}' disconnected during execution. Outcome is unknown; preserved without blind retry.`,
                  }
                );

                await this.store.appendGraphEvent?.(graph.graphId, "graph.outcome_unknown", {
                  graphId: graph.graphId,
                  nodeId: node.nodeId,
                  workerNodeId: node.assignedNodeId,
                  reason: "Worker disconnected mid-execution",
                });
              }
            }
          }
        }
      }

      // 3. 驱动一次调度推进
      await this.orchestrator.advanceGraph(graph.graphId);
    }
  }

  /**
   * 图中只要存在正在等待人工审批的任务，任何墙钟都不得终止该图。
   * 审批是外部输入驱动的等待，与 Agent 自身执行预算无关。
   */
  private async hasNodeAwaitingApproval(nodes: DistributedGraphNodeRecord[]): Promise<boolean> {
    for (const node of nodes) {
      if (!node.taskId) continue;
      if (["completed", "failed", "cancelled", "skipped"].includes(node.status)) continue;
      const task = await this.store.getTask(node.taskId);
      if (task?.status === "waiting_approval") return true;
    }
    return false;
  }
}
