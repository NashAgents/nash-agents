/**
 * Distributed TaskGraph DAG Validator
 * 复用并扩展原生 TaskGraph 的 DFS 3-Color 染色无环检测、拓扑分层与产物闭环校验
 */

import { TaskGraph } from "../../task/task-graph.js";
import type {
  DistributedGraphNodeRecord,
  DistributedGraphEdgeRecord,
  GraphProposalNode,
  TaskGraphValidationResult,
  GraphBudget,
} from "./types.js";

export class DagValidationError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: unknown) {
    super(`[DagValidator] ${message}`);
    this.name = "DagValidationError";
  }
}

export class DagValidator {
  /**
   * 校验 GraphProposal 的合法性（包含无环、未知依赖、产物闭环与预算）
   */
  static validateProposal(
    nodes: GraphProposalNode[],
    budget?: Partial<GraphBudget>
  ): TaskGraphValidationResult {
    const maxNodes = budget?.maxNodes ?? 15;
    const maxDepth = budget?.maxDepth ?? 10;

    if (!nodes || nodes.length === 0) {
      return {
        valid: false,
        reason: "Graph proposal must contain at least one node.",
      };
    }

    if (nodes.length > maxNodes) {
      return {
        valid: false,
        reason: `Graph node count (${nodes.length}) exceeds budget maxNodes (${maxNodes}).`,
      };
    }

    // 1. 唯一性与格式检查
    const nodeIds = new Set<string>();
    const nodeMap = new Map<string, GraphProposalNode>();
    for (const node of nodes) {
      if (!node.nodeId || typeof node.nodeId !== "string") {
        return { valid: false, reason: "Each node must have a valid string nodeId." };
      }
      if (nodeIds.has(node.nodeId)) {
        return { valid: false, reason: `Duplicate nodeId detected: '${node.nodeId}'.` };
      }
      nodeIds.add(node.nodeId);
      nodeMap.set(node.nodeId, node);
    }

    // 2. 依赖引用完整性与自依赖检测
    const adjacency = new Map<string, string[]>();
    for (const node of nodes) {
      const deps = node.dependencies ?? [];
      adjacency.set(node.nodeId, [...deps]);

      for (const dep of deps) {
        if (dep === node.nodeId) {
          return {
            valid: false,
            reason: `Self-dependency detected: node '${node.nodeId}' cannot depend on itself.`,
            cyclesDetected: [node.nodeId, node.nodeId],
          };
        }
        if (!nodeMap.has(dep)) {
          return {
            valid: false,
            reason: `Missing dependency: node '${node.nodeId}' references non-existent node '${dep}'.`,
            danglingDependencies: [dep],
          };
        }
      }
    }

    // 3. 产物声明与消费闭环校验
    for (const node of nodes) {
      if (node.requiredArtifacts && node.requiredArtifacts.length > 0) {
        for (const req of node.requiredArtifacts) {
          const producer = nodeMap.get(req.producerNodeId);
          if (!producer) {
            return {
              valid: false,
              reason: `Node '${node.nodeId}' requires artifact '${req.name}' from non-existent producer '${req.producerNodeId}'.`,
            };
          }
          // 确保前置生产者在依赖列表中
          const currentDeps = node.dependencies ?? [];
          if (!currentDeps.includes(req.producerNodeId)) {
            return {
              valid: false,
              reason: `Node '${node.nodeId}' requires artifact from '${req.producerNodeId}', but '${req.producerNodeId}' is not listed in dependencies.`,
            };
          }
          // 校验生产者是否声明生成该产物
          const declared = producer.producedArtifacts?.some((p) => p.name === req.name);
          if (!declared) {
            return {
              valid: false,
              reason: `Node '${node.nodeId}' requires artifact '${req.name}', but producer '${req.producerNodeId}' does not declare producing it.`,
            };
          }
        }
      }
    }

    // 3b. Join 必须显式声明每个上游分支的产物引用，否则该分支的产物无法被精确消费。
    for (const node of nodes) {
      if (node.dependencyType !== "join") continue;
      for (const dep of node.dependencies ?? []) {
        const producer = nodeMap.get(dep)!;
        for (const produced of producer.producedArtifacts ?? []) {
          const referenced = (node.requiredArtifacts ?? []).some(
            (req) => req.producerNodeId === dep && req.name === produced.name);
          if (!referenced) {
            return {
              valid: false,
              reason: `Join node '${node.nodeId}' depends on '${dep}' but does not declare requiredArtifacts for its output '${produced.name}'.`,
            };
          }
        }
      }
    }

    // 4. DFS 3-Color 染色环路检测 (White=0, Gray=1, Black=2)
    const visited = new Map<string, number>();
    const recursionStack: string[] = [];
    let detectedCycle: string[] | undefined;

    const dfs = (curr: string) => {
      visited.set(curr, 1); // Gray
      recursionStack.push(curr);

      const deps = adjacency.get(curr) ?? [];
      for (const dep of deps) {
        const state = visited.get(dep) ?? 0;
        if (state === 1) {
          const startIdx = recursionStack.indexOf(dep);
          detectedCycle = [...recursionStack.slice(startIdx), dep];
          return;
        }
        if (state === 0) {
          dfs(dep);
          if (detectedCycle) return;
        }
      }

      recursionStack.pop();
      visited.set(curr, 2); // Black
    };

    for (const nodeId of nodeIds) {
      if ((visited.get(nodeId) ?? 0) === 0) {
        dfs(nodeId);
        if (detectedCycle) break;
      }
    }

    if (detectedCycle) {
      return {
        valid: false,
        reason: `DAG Cycle detected: ${detectedCycle.join(" -> ")}`,
        cyclesDetected: detectedCycle,
      };
    }

    // 5. Kahn 算法拓扑排序与分层计算
    const inDegree = new Map<string, number>();
    const dependentsMap = new Map<string, string[]>();

    for (const node of nodes) {
      const deps = node.dependencies ?? [];
      inDegree.set(node.nodeId, deps.length);
      for (const dep of deps) {
        const list = dependentsMap.get(dep) ?? [];
        list.push(node.nodeId);
        dependentsMap.set(dep, list);
      }
    }

    let currentQueue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) currentQueue.push(id);
    }

    const topologicalOrder: string[] = [];
    const parallelStages: string[][] = [];
    let currentDepth = 0;

    while (currentQueue.length > 0) {
      currentDepth++;
      if (currentDepth > maxDepth) {
        return {
          valid: false,
          reason: `Graph depth (${currentDepth}) exceeds maximum depth limit (${maxDepth}).`,
        };
      }

      parallelStages.push([...currentQueue]);
      const nextQueue: string[] = [];

      for (const curr of currentQueue) {
        topologicalOrder.push(curr);
        const children = dependentsMap.get(curr) ?? [];
        for (const child of children) {
          const deg = (inDegree.get(child) ?? 1) - 1;
          inDegree.set(child, deg);
          if (deg === 0) {
            nextQueue.push(child);
          }
        }
      }

      currentQueue = nextQueue;
    }

    if (topologicalOrder.length !== nodes.length) {
      return {
        valid: false,
        reason: "Failed to topologically sort all nodes, potential hidden cycle or disconnected component.",
      };
    }

    return {
      valid: true,
      topologicalOrder,
      parallelStages,
    };
  }

  /**
   * 校验持久化实体结构是否符合 DAG 约束
   */
  static validateGraphRecords(
    nodes: DistributedGraphNodeRecord[],
    edges: DistributedGraphEdgeRecord[]
  ): TaskGraphValidationResult {
    const proposalNodes: GraphProposalNode[] = nodes.map((n) => {
      const nodeEdges = edges.filter((e) => e.toNodeId === n.nodeId);
      return {
        nodeId: n.nodeId,
        title: n.title,
        goal: n.goal,
        operation: n.operation,
        candidateNodeId: n.assignedNodeId,
        candidateProjectId: n.assignedProjectId,
        dependencies: nodeEdges.map((e) => e.fromNodeId),
        dependencyType: nodeEdges.some((e) => e.dependencyType === "join")
          ? "join" as const
          : nodeEdges[0]?.dependencyType,
        requiredArtifacts: n.requiredArtifacts,
        producedArtifacts: n.producedArtifacts,
        acceptanceCriteria: n.acceptanceCriteria,
        failurePolicy: n.failurePolicy,
      };
    });

    return this.validateProposal(proposalNodes);
  }
}
