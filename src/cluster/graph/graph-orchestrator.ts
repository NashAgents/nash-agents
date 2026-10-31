import type { EventBus } from "../../observability/event-bus.js";
import { observeGraphPhase } from "./runtime-tracing.js";
import { observeRuntimePhase } from "../../observability/runtime-phase.js";
import { randomUUID } from "node:crypto";
import { defaultTraceContext } from "../../observability/trace-context.js";
/**
 * Distributed Graph Orchestrator (Phase 4)
 * 分布式任务图调度引擎、并发治理、Join Barrier 汇聚与失败/取消传播控制器
 * 严格复用 Phase 1 TaskScheduler 派发、Phase 3 SemanticRouter 路由与原子状态推进
 */

import * as crypto from "node:crypto";
import type { IClusterStore } from "../storage/cluster-store.js";
import type { TaskScheduler } from "../coordinator/task-scheduler.js";
import type { SemanticTaskRouter } from "../router/semantic-task-router.js";
import type { ArtifactService } from "../artifacts/artifact-service.js";
import { ResultVerifier, type VerifyNodeResultInput } from "./result-verifier.js";
import { MAX_GRAPH_ARTIFACT_BYTES } from "../worker/graph-artifacts.js";
import type { GraphTaskContext } from "../protocol/types.js";
import type { RoutingValidator } from "../router/routing-validator.js";
import { DagValidator } from "./dag-validator.js";
import type {
  DistributedGraphRecord,
  DistributedGraphNodeRecord,
  DistributedGraphEdgeRecord,
  GraphProposal,
  GraphStatus,
  GraphNodeStatus,
  GraphBudget,
  GraphFailureClassification,
} from "./types.js";

export interface OrchestratorOptions {
  eventBus?: EventBus;
  store: IClusterStore;
  scheduler: TaskScheduler;
  router?: SemanticTaskRouter;
  validator?: Pick<RoutingValidator, "validateCandidate">;
  artifactService?: ArtifactService;
  verifier?: ResultVerifier;
}

export class GraphExecutionError extends Error {
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  constructor(message: string, details?: { code?: string } & Record<string, unknown>) {
    super(message);
    this.name = "GraphExecutionError";
    this.code = details?.code;
    this.details = details;
  }
}

export class DistributedGraphOrchestrator {
  private readonly store: IClusterStore;
  private readonly eventBus?: EventBus;
  private readonly scheduler: TaskScheduler;
  private readonly router?: SemanticTaskRouter;
  private readonly validator?: Pick<RoutingValidator, "validateCandidate">;
  private readonly artifactService?: ArtifactService;

  // 项目写租约 (Project Write Lease)，防止同一项目被并发写任务污染
  private readonly activeProjectWrites = new Set<string>();
  private advancement: Promise<void> = Promise.resolve();
  private readonly completing = new Set<string>();
  private readonly verifier: ResultVerifier;
  private readonly completionListeners = new Map<string, Set<() => void>>();

  constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.eventBus = options.eventBus;
    this.verifier = options.verifier ?? new ResultVerifier(options.store, options.artifactService);
    this.scheduler = options.scheduler;
    this.router = options.router;
    this.validator = options.validator;
    this.artifactService = options.artifactService;
  }

  async syncTaskActivity(taskId: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    const context = task?.dispatchOptions?.graphContext;
    if (!task || !context || !["accepted", "running", "waiting_approval", "outcome_unknown"].includes(task.status)) return;
    const node = await this.store.getGraphNode?.(context.graphId, context.graphNodeId);
    if (!node || node.taskId !== taskId || !["dispatched", "accepted", "running", "waiting_approval", "cancelling"].includes(node.status)) return;
    if (node.status === task.status) return;
    await this.store.updateGraphNodeStatus?.(context.graphId, node.nodeId, task.status as GraphNodeStatus);
    await this.store.appendGraphEvent?.(context.graphId, "graph.node_activity", {
      graphId: context.graphId, nodeId: node.nodeId, taskId, status: task.status,
    });
    if (task.status === "outcome_unknown") await this.checkGraphConvergence(context.graphId);
  }

  /**
   * 1. 从 Proposal 创建并持久化分布式任务图
   */
  async createGraph(proposal: GraphProposal): Promise<DistributedGraphRecord> {
    return observeRuntimePhase("graph_persistence", async () => {
    const validation = DagValidator.validateProposal(proposal.nodes, proposal.budget);
    if (!validation.valid) throw new GraphExecutionError(`Invalid graph: ${validation.reason}`);
    if (proposal.nodes.some((node) => node.dependencyType === "conditional")) throw new GraphExecutionError("Conditional dependencies require a deterministic condition and are not supported");
    for (const node of proposal.nodes) {
      if (node.candidateNodeId && node.candidateProjectId && this.validator) {
        const check = await this.validator.validateCandidate({ nodeId: node.candidateNodeId, projectId: node.candidateProjectId }, {
          constraints: { readOnly: node.operation === "analyze" || node.operation === "synthesize",
            requiredPolicy: { filesystem: node.requiredSandboxPolicy?.filesystemMode, network: node.requiredSandboxPolicy?.networkMode } },
          requiredCapabilities: node.requiredCapabilities ?? [],
        });
        if (!check.valid) throw new GraphExecutionError(`PLANNING_CONSTRAINT_VIOLATION ${node.nodeId}: ${check.code}: ${check.reason}`);
      }
    }
    const graphId = `graph-${crypto.randomUUID().slice(0, 10)}`;
    const now = Date.now();
    const persistenceMonotonicAt = performance.now();

    const budget: GraphBudget = {
      maxNodes: proposal.budget?.maxNodes ?? 10,
      maxParallelTasks: proposal.budget?.maxParallelTasks ?? 5,
      maxReplanAttempts: proposal.budget?.maxReplanAttempts ?? 3,
      maxDepth: proposal.budget?.maxDepth ?? 6,
      totalTimeoutMs: proposal.budget?.totalTimeoutMs ?? 1800000,
      perTaskTimeoutMs: proposal.budget?.perTaskTimeoutMs ?? 0,
      perTaskTimeoutSource: proposal.budget?.perTaskTimeoutMs ? proposal.budget.perTaskTimeoutSource ?? "unspecified" : "none",
    };

    const graph: DistributedGraphRecord = {
      graphId,
      parentGoal: proposal.parentGoal,
      status: "ready",
      revision: 1,
      budget,
      concurrencyPolicy: {
        maxConcurrentTasks: budget.maxParallelTasks,
        projectWriteLock: true,
      },
      strategyDecision: proposal.strategyDecision,
      createdAt: now,
      updatedAt: now,
    };

    if (!this.store.createGraphAtomic) throw new GraphExecutionError("Atomic graph creation is unavailable");

    // 2. 保存各 GraphNode
    const nodes: DistributedGraphNodeRecord[] = [];
    const edges: DistributedGraphEdgeRecord[] = [];

    for (const pNode of proposal.nodes) {
      const hasDeps = pNode.dependencies && pNode.dependencies.length > 0;
      const initialStatus: GraphNodeStatus = hasDeps ? "waiting_dependencies" : "ready";

      const nodeRecord: DistributedGraphNodeRecord = {
        graphId,
        nodeId: pNode.nodeId,
        title: pNode.title,
        goal: pNode.goal,
        description: pNode.description ?? pNode.title,
        operation: pNode.operation ?? "execute",
        assignedNodeId: pNode.candidateNodeId,
        assignedProjectId: pNode.candidateProjectId,
        explicitNodePinned: pNode.explicitNodePinned ?? Boolean(pNode.candidateNodeId),
        requiredCapabilities: pNode.requiredCapabilities ?? [],
        requiredSandboxPolicy: pNode.requiredSandboxPolicy,
        inputs: pNode.inputs,
        expectedOutputs: pNode.expectedOutputs,
        requiredArtifacts: pNode.requiredArtifacts ?? [],
        producedArtifacts: pNode.producedArtifacts ?? [],
        acceptanceCriteria: pNode.acceptanceCriteria ?? [],
        status: initialStatus,
        failurePolicy: pNode.failurePolicy ?? "block_dependents",
        retryPolicy: {
          maxRetries: 1,
          backoffMs: 5000,
          classification: pNode.retryClassification,
        },
        timeoutMs: pNode.timeoutMs,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      nodes.push(nodeRecord);

      // 创建依赖边
      if (hasDeps) {
        for (const depId of pNode.dependencies!) {
          const edgeId = `edge-${crypto.randomUUID().slice(0, 8)}`;
          const edgeRecord: DistributedGraphEdgeRecord = {
            edgeId,
            graphId,
            fromNodeId: depId,
            toNodeId: pNode.nodeId,
            dependencyType: pNode.dependencyType ?? "success",
            requiredOutcome: "completed",
            artifactRequirements: pNode.requiredArtifacts ?? [],
            createdAt: now,
          };
          edges.push(edgeRecord);
        }
      }
    }


    // 3. 记录 Revision 1
    const revision: import("./types.js").GraphRevisionRecord = {
      graphId,
      revision: 1,
      reason: "Initial graph creation from autonomous planner proposal",
      triggerType: "initial_plan",
      diffSummary: {
        addedNodes: nodes.map((n) => n.nodeId),
        addedEdges: edges.map((e) => e.edgeId),
      },
      createdAt: now,
    };

    // Commit the aggregate and its first event together.
    await this.store.createGraphAtomic({ goalRunId: defaultTraceContext.get()?.goalRunId, goalTurnFence: defaultTraceContext.get()?.goalTurnFence, graph, nodes, edges, revision, event: { monotonicAt: persistenceMonotonicAt, clockId: `${process.pid}:${performance.timeOrigin}`,
      graphId,
      goal: proposal.parentGoal,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      requiresMultiAgent: proposal.requiresMultiAgent,
      strategyDecision: proposal.strategyDecision,
    } });

    return graph;
    });
  }

  /**
   * 2. 启动并驱动任务图执行
   */
  async startGraph(graphId: string): Promise<DistributedGraphRecord> {
    const graph = await this.store.getGraph?.(graphId);
    if (!graph) throw new Error(`Graph '${graphId}' not found.`);

    if (graph.status !== "ready") {
      throw new Error(`Cannot start graph '${graphId}' with status '${graph.status}'.`);
    }

    const trace = defaultTraceContext.get();
    const owner = trace?.goalRunId && trace.goalTurnFence ? { goalRunId: trace.goalRunId, fence: trace.goalTurnFence } : undefined;
    if (this.store.transitionGraphStatus) {
      if (!await this.store.transitionGraphStatus(graphId, graph.revision, "ready", "running", undefined, owner)) throw new GraphExecutionError(`Graph '${graphId}' changed before start`);
    } else {
      if (owner) throw new GraphExecutionError("Fenced graph start is unavailable");
      await this.store.updateGraphStatus?.(graphId, "running");
    }
    await this.store.appendGraphEvent?.(graphId, "graph.started", { graphId, startedAt: Date.now() });

    // 立即执行一次依赖推进
    await this.advanceGraph(graphId);

    return (await this.store.getGraph?.(graphId))!;
  }

  waitForCompletion(graphId: string, timeoutMs: number, signal?: AbortSignal): Promise<DistributedGraphRecord> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const listeners = this.completionListeners.get(graphId);
        listeners?.delete(check);
        if (listeners?.size === 0) this.completionListeners.delete(graphId);
      };
      const finish = (graph?: DistributedGraphRecord, error?: unknown) => {
        if (settled) return;
        settled = true; cleanup();
        if (graph) resolve(graph); else reject(error);
      };
      const check = () => {
        void this.store.getGraph?.(graphId).then((graph) => {
          if (!graph) finish(undefined, new GraphExecutionError(`Graph '${graphId}' not found`));
          else if (["completed", "failed", "cancelled", "partially_completed", "blocked", "outcome_unknown"].includes(graph.status)) finish(graph);
        }).catch((error: unknown) => finish(undefined, error));
      };
      const onAbort = () => finish(undefined, signal?.reason ?? new GraphExecutionError("Graph wait cancelled"));
      const timer = setTimeout(() => finish(undefined, new GraphExecutionError("Graph completion wait timed out; inspect the existing graph before retrying")), timeoutMs);
      const listeners = this.completionListeners.get(graphId) ?? new Set<() => void>();
      listeners.add(check); this.completionListeners.set(graphId, listeners);
      if (signal?.aborted) onAbort();
      else { signal?.addEventListener("abort", onAbort, { once: true }); check(); }
    });
  }

  private notifyCompletion(graphId: string): void {
    for (const listener of this.completionListeners.get(graphId) ?? []) listener();
  }

  /**
   * 3. 核心依赖状态推进引擎 (Join Barrier, 并发限额与任务派发)
   */
  advanceGraph(graphId: string): Promise<void> {
    const next = this.advancement.then(() => this.advanceGraphLocked(graphId));
    this.advancement = next.catch(() => {});
    return next;
  }

  private async advanceGraphLocked(graphId: string): Promise<void> {
    // 进程重启后从持久化活跃节点重建项目写租约。
    this.activeProjectWrites.clear();
    for (const existing of await this.store.listGraphs?.({ limit: 100000 }) ?? []) {
      if (!["running", "paused", "blocked", "cancelling", "outcome_unknown"].includes(existing.status)) continue;
      for (const n of await this.store.listGraphNodes?.(existing.graphId) ?? []) {
        if (n.operation !== "analyze" && n.assignedNodeId && n.assignedProjectId && ["dispatched", "accepted", "running", "waiting_approval", "cancelling", "outcome_unknown"].includes(n.status)) {
          this.activeProjectWrites.add(`${n.assignedNodeId}::${n.assignedProjectId}`);
        }
      }
    }
    const graph = await this.store.getGraph?.(graphId);
    if (!graph || graph.status !== "running") return;

    const [allNodes, allEdges] = await Promise.all([
      this.store.listGraphNodes?.(graphId) ?? [],
      this.store.listGraphEdges?.(graphId) ?? [],
    ]);

    // 1. 统计当前正在运行的任务数量
    const runningNodes = allNodes.filter((n) => ["dispatched", "accepted", "running", "queued", "waiting_approval", "cancelling", "outcome_unknown"].includes(n.status));
    const availableSlots = Math.max(0, graph.budget.maxParallelTasks - runningNodes.length);

    if (availableSlots <= 0) {
      await this.checkGraphConvergence(graphId);
      return; // 并发槽位已满，等待运行中的任务完工唤醒
    }

    // 2. 评估所有 waiting_dependencies 节点的前置满足状态 (Join Barrier)
    for (const node of allNodes) {
      if (node.status === "waiting_dependencies") {
        const inEdges = allEdges.filter((e) => e.toNodeId === node.nodeId);
        let allSatisfied = true;
        let impossible = false;

        for (const edge of inEdges) {
          const parentNode = allNodes.find((n) => n.nodeId === edge.fromNodeId);
          const terminal = parentNode && ["completed", "failed", "skipped", "cancelled"].includes(parentNode.status);
          const acceptsFailure = edge.dependencyType === "completion" || (parentNode?.failurePolicy === "allow_degraded" && edge.dependencyType !== "artifact");
          if (!parentNode || (parentNode.status !== "completed" && !(terminal && acceptsFailure))) {
            allSatisfied = false;
            impossible = Boolean(terminal);
            break;
          }

          // 如果是有产物依赖，二次确认产物是否存在且就绪
          if (edge.dependencyType === "artifact" && edge.artifactRequirements.length > 0) {
            for (const req of edge.artifactRequirements.filter((r) => !r.producerNodeId || r.producerNodeId === parentNode.nodeId || r.producerNodeId === parentNode.assignedNodeId)) {
              const arts = await this.store.listArtifacts?.(graphId) ?? [];
              const art = arts.find((a) => a.producerTaskId === parentNode.taskId && a.name === req.name);
              if (!art || art.status !== "available") {
                impossible = Boolean(terminal);
                allSatisfied = false;
                break;
              }
            }
          }
        }

        if (allSatisfied && node.requiredArtifacts.length > 0) {
          const artifacts = await this.store.listArtifacts?.(graphId) ?? [];
          allSatisfied = node.requiredArtifacts.every((requirement) => artifacts.some((artifact) => {
            const producer = allNodes.find((n) => n.nodeId === requirement.producerNodeId);
            return artifact.name === requirement.name && artifact.status === "available"
              && (producer ? artifact.producerTaskId === producer.taskId : artifact.producerNodeId === requirement.producerNodeId)
              && (!requirement.requiredSha256 || artifact.sha256 === requirement.requiredSha256);
          }));
        }

        if (!allSatisfied && node.requiredArtifacts.length > 0) {
          impossible ||= node.requiredArtifacts.some((requirement) => {
            const producer = allNodes.find((candidate) => candidate.nodeId === requirement.producerNodeId);
            return producer && ["completed", "failed", "skipped", "cancelled"].includes(producer.status);
          }) && inEdges.every((edge) => {
            const parent = allNodes.find((candidate) => candidate.nodeId === edge.fromNodeId);
            return parent && ["completed", "failed", "skipped", "cancelled"].includes(parent.status);
          });
        }
        if (impossible) {
          node.status = "blocked";
          await this.store.updateGraphNodeStatus?.(graphId, node.nodeId, "blocked", { error: "Upstream finished without the required outcome or artifacts" });
          await this.propagateBlockage(graphId, node.nodeId, "Required dependency cannot be satisfied");
          continue;
        }

        // 若前置全部达成，原子跃迁为 ready
        if (allSatisfied) {
          node.status = "ready";
          await this.store.updateGraphNodeStatus?.(graphId, node.nodeId, "ready");
          await this.store.appendGraphEvent?.(graphId, "graph.node_ready", {
            graphId,
            nodeId: node.nodeId,
            title: node.title,
          });
        }
      }
    }

    // 3. 收集所有处于 ready 状态的节点准备派发
    const readyNodes = allNodes.filter((n) => n.status === "ready");
    let dispatched = 0;
    for (const node of readyNodes) {
      if (dispatched >= availableSlots) break;
      await this.dispatchNodeTask(graph, node);
      if (node.status === "dispatched") dispatched++;
    }

    // 4. 检查整张图的终态收敛 (All Done?)
    await this.checkGraphConvergence(graphId);
  }

  /**
   * 4. 派发单个子任务 (接入 SemanticRouter 智能选点、可回退重选与固定节点安全校验)
   */
  private async dispatchNodeTask(graph: DistributedGraphRecord, node: DistributedGraphNodeRecord): Promise<void> {
    return observeGraphPhase(this.store, graph.graphId, "routing", async () => {
    let targetNodeId = node.assignedNodeId;
    let targetProjectId = node.assignedProjectId;

    // 动态项目绑定与路由兜底：若未指定 project 或指定 project 在目标节点不存在，自动查询该节点活跃项目
    if (targetNodeId && !targetProjectId) {
      const nodeProjects = (await this.store.listProjectsCatalog?.({ nodeId: targetNodeId })) ?? [];
      const activeProj = nodeProjects.find((p) => p.status === "active") || nodeProjects[0];
      if (activeProj) {
        targetProjectId = activeProj.projectId;
      }
    }

    // 若仍未绑定特定节点或项目，借助 Phase 3 路由决策引擎解析
    if ((!targetNodeId || !targetProjectId) && this.router) {
      try {
        const routePlan = await this.router.planRoute(node.goal, {
          constraints: {
            preferredNodeId: targetNodeId || node.assignedNodeId,
            preferredProjectId: targetProjectId || node.assignedProjectId,
            explicitNodeId: node.explicitNodePinned ? targetNodeId : undefined,
          },
        });
        if (routePlan.validation.valid && routePlan.decision.decisionType === "DISPATCH" && routePlan.decision.selectedCandidate) {
          targetNodeId = targetNodeId || routePlan.decision.selectedCandidate.nodeId;
          targetProjectId = targetProjectId || routePlan.decision.selectedCandidate.projectId;
        }
      } catch (err) {
        console.warn(`[GraphOrchestrator] Router auto-resolution failed for node ${node.nodeId}: ${err}`);
      }
    }

    if (!targetNodeId || !targetProjectId) {
      await this.store.updateGraphNodeStatus?.(graph.graphId, node.nodeId, "blocked", { error: "No validated route; explicit node/project selection required" });
      await this.store.appendGraphEvent?.(graph.graphId, "graph.node_blocked", { graphId: graph.graphId, nodeId: node.nodeId, reason: "routing_required" });
      await this.propagateBlockage(graph.graphId, node.nodeId, "No validated route");
      return;
    }

    const buildValidationIntent = (candNodeId: string, candProjId: string) => ({
      operation: node.operation === "analyze" || node.operation === "synthesize" ? "inspect" : "fix",
      constraints: {
        explicitNodeId: candNodeId,
        explicitProjectId: candProjId,
        readOnly:
          node.requiredSandboxPolicy?.filesystemMode === "read-only" ||
          node.operation === "analyze" ||
          node.operation === "synthesize",
        requiredPolicy: node.requiredSandboxPolicy
          ? {
              filesystem: node.requiredSandboxPolicy.filesystemMode,
              network: node.requiredSandboxPolicy.networkMode,
            }
          : undefined,
      },
      requiredCapabilities: node.requiredCapabilities,
    });

    let validation = await this.validator?.validateCandidate(
      { nodeId: targetNodeId, projectId: targetProjectId },
      buildValidationIntent(targetNodeId, targetProjectId) as any
    );

    // 当未显式锁定唯一节点 (explicitNodePinned === false) 且首选 Worker 离线或能力不满足时，自动回退尝试其他合规在线 Worker
    if (
      !validation?.valid &&
      node.explicitNodePinned === false &&
      this.validator &&
      validation?.code &&
      ["NODE_OFFLINE", "SANDBOX_INCOMPATIBLE", "STALE_SANDBOX_CAPABILITY", "CAPABILITY_UNVERIFIED", "PROJECT_NOT_FOUND"].includes(validation.code)
    ) {
      const allProjects = (await this.store.listProjectsCatalog?.()) ?? [];
      for (const altProj of allProjects) {
        if (altProj.status !== "active" || (altProj.nodeId === targetNodeId && altProj.projectId === targetProjectId)) {
          continue;
        }
        const altCheck = await this.validator.validateCandidate(
          { nodeId: altProj.nodeId, projectId: altProj.projectId },
          buildValidationIntent(altProj.nodeId, altProj.projectId) as any
        );
        if (altCheck.valid) {
          const previousNodeId = targetNodeId;
          targetNodeId = altProj.nodeId;
          targetProjectId = altProj.projectId;
          validation = altCheck;
          await this.store.appendGraphEvent?.(graph.graphId, "graph.worker_reassigned", {
            graphId: graph.graphId,
            nodeId: node.nodeId,
            previousNodeId,
            newNodeId: targetNodeId,
            newProjectId: targetProjectId,
            reason: `Fallback from '${previousNodeId}' to qualified online worker '${targetNodeId}'`,
          });
          break;
        }
      }
    }

    if (!validation?.valid) {
      await this.store.updateGraphNodeStatus?.(graph.graphId, node.nodeId, "blocked", { error: validation?.reason ?? "Routing validator is unavailable" });
      await this.store.appendGraphEvent?.(graph.graphId, "graph.node_blocked", { graphId: graph.graphId, nodeId: node.nodeId, reason: validation?.code ?? "validation_required" });
      await this.propagateBlockage(graph.graphId, node.nodeId, validation?.reason ?? "Routing validator unavailable");
      return;
    }

    // 项目写租约防护
    const isWriteOp = node.operation !== "analyze" && node.operation !== "synthesize";
    if (graph.concurrencyPolicy.projectWriteLock && isWriteOp) {
      const leaseKey = `${targetNodeId}::${targetProjectId}`;
      if (this.activeProjectWrites.has(leaseKey)) {
        // 项目正在被其它写任务占用，保持 ready 等待锁释放
        return;
      }
      this.activeProjectWrites.add(leaseKey);
    }

    // Resolve exact producers before dispatch; equal filenames from another branch cannot satisfy an input.
    let taskRecord;
    try {
      const inputs: GraphTaskContext["inputs"] = await observeRuntimePhase("join_wait", async () => {
        const resolvedInputs: GraphTaskContext["inputs"] = [];
        for (const requirement of node.requiredArtifacts) {
          const producer = await this.store.getGraphNode?.(graph.graphId, requirement.producerNodeId);
          const candidates = (await this.store.listArtifacts?.(graph.graphId) ?? []).filter((item) =>
            item.name === requirement.name && item.producerTaskId === producer?.taskId && item.status === "available"
            && (!requirement.requiredSha256 || item.sha256 === requirement.requiredSha256));
          // 同名产物绝不自动取第一条：0 条与多条都必须显式失败，并列出可定位的候选。
          if (!this.artifactService) throw new GraphExecutionError(`Artifact service unavailable; cannot resolve '${requirement.name}'`);
          if (candidates.length === 0) {
            const sameName = (await this.store.listArtifacts?.(graph.graphId) ?? [])
              .filter((item) => item.name === requirement.name)
              .map((item) => ({ artifactId: item.artifactId, producerNodeId: item.producerNodeId, producerTaskId: item.producerTaskId }));
            throw new GraphExecutionError(`Required artifact unavailable: '${requirement.name}' from producer '${requirement.producerNodeId}' (task ${producer?.taskId ?? "unassigned"}). Candidates with the same name: ${JSON.stringify(sameName)}`, { code: "ARTIFACT_NOT_FOUND", artifactName: requirement.name, producerNodeId: requirement.producerNodeId, candidates: sameName });
          }
          if (candidates.length > 1) {
            throw new GraphExecutionError(`Artifact reference is ambiguous: '${requirement.name}' from producer '${requirement.producerNodeId}' matches ${candidates.length} artifacts`, { code: "ARTIFACT_AMBIGUOUS", artifactName: requirement.name, producerNodeId: requirement.producerNodeId, candidates: candidates.map((item) => ({ artifactId: item.artifactId, producerTaskId: item.producerTaskId, sha256: item.sha256 })) });
          }
          const artifact = candidates[0]!;
          if (artifact.sizeBytes > MAX_GRAPH_ARTIFACT_BYTES) throw new GraphExecutionError("Input artifact exceeds transfer limit");
          const { data } = await this.artifactService.readArtifactContent(artifact.artifactId, artifact.producerNodeId);
          resolvedInputs.push({ artifactId: artifact.artifactId, producerNodeId: requirement.producerNodeId, producerTaskId: artifact.producerTaskId,
            name: artifact.name, contentType: artifact.contentType, sha256: artifact.sha256, content: data.toString("utf-8") });
        }
        return resolvedInputs;
      }, { graphId: graph.graphId, nodeId: node.nodeId });
      if (Buffer.byteLength(JSON.stringify(inputs)) > MAX_GRAPH_ARTIFACT_BYTES) throw new GraphExecutionError("Input artifacts exceed transfer limit");

      const inEdges = (await this.store.listGraphEdges?.(graph.graphId))?.filter((e) => e.toNodeId === node.nodeId) ?? [];
      const upstreamNodes: DistributedGraphNodeRecord[] = [];
      for (const e of inEdges) {
        const p = await this.store.getGraphNode?.(graph.graphId, e.fromNodeId);
        if (p) upstreamNodes.push(p);
      }
      const upstreamSummaryLine =
        upstreamNodes.length > 0 || inputs.length > 0
          ? `\nUpstream Dependency Summaries (Minimal Context):\n` +
            upstreamNodes
              .map((u) => `- [${u.nodeId}] ${u.title}: ${(u.resultSummary ?? "completed").slice(0, 240)}`)
              .join("\n") +
            (inputs.length > 0
              ? `\nInput Artifacts: ${inputs.map((i) => `${i.name} [artifactId:${i.artifactId}, from ${i.producerNodeId}/${i.producerTaskId ?? "unassigned"}, sha256:${i.sha256.slice(0, 8)}]`).join(", ")}`
              : "")
          : "";

      const expectedArtifactsLine =
        node.producedArtifacts.length > 0
          ? `\nDeclared Output Artifacts: ${node.producedArtifacts.map((a) => `${a.name} (${a.contentType})`).join(", ")}`
          : "";
      const criteriaLine =
        node.acceptanceCriteria.length > 0
          ? `\nAcceptance Criteria: ${node.acceptanceCriteria.map((c) => `${c.type}: ${c.description}`).join("; ")}`
          : "";

      const fsMode =
        node.requiredSandboxPolicy?.filesystemMode ??
        (node.operation === "analyze" || node.operation === "synthesize" ? "read-only" : "workspace-write");
      const netMode =
        node.requiredSandboxPolicy?.networkMode ??
        (node.requiredCapabilities.includes("sandbox:network-allow") ? "allow" : "deny");

      const priorAttempts = (node.attemptCount ?? 0) > 0
        ? (await (this.store.listGraphTaskAttempts?.(graph.graphId, node.nodeId) ?? this.store.listTasks({ limit: 100000 }))).filter(task => {
          const context = task.dispatchOptions?.graphContext;
          return context?.graphId === graph.graphId && context.graphNodeId === node.nodeId && context.executionAttempt === node.attemptCount;
        }) : [];
      if (priorAttempts.length > 1) throw new GraphExecutionError(`Ambiguous previous attempt for ${graph.graphId}/${node.nodeId}`);

      taskRecord = await observeRuntimePhase("task_dispatch", () => this.scheduler.createTask({
      nodeId: targetNodeId,
      projectId: targetProjectId,
      goal: node.goal,
      prompt: `[Task: ${node.title}] (Graph: ${graph.graphId}, Node: ${node.nodeId}, Operation: ${node.operation})\nGoal: ${node.goal}${upstreamSummaryLine}${expectedArtifactsLine}${criteriaLine}\nTrusted dispatch time: ${new Date().toISOString()}; Beijing time (Asia/Shanghai): ${new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" })}. Use the runtime date for this report; never reuse dates from historical reports or guess from training data.`,
      timeoutMs: node.timeoutMs ?? graph.budget.perTaskTimeoutMs,
      contextOverrides: { operation: node.operation, requiredPolicy: {
        filesystem: fsMode,
        network: netMode,
      } },
      graphContext: {
        traceId: graph.strategyDecision?.traceId,
        parentSpanId: defaultTraceContext.get()?.spanId ?? randomUUID(),
        conversationId: graph.strategyDecision?.conversationId ?? defaultTraceContext.get()?.conversationId,
        executionAttempt: (node.attemptCount ?? 0) + 1,
        retryOfTaskId: priorAttempts[0]?.taskId,
        graphId: graph.graphId,
        graphRevision: graph.revision,
        graphNodeId: node.nodeId,
        inputs,
        outputs: node.producedArtifacts.map((a) => ({
          name: a.name,
          contentType: a.contentType ?? (a.name.endsWith(".md") ? "text/markdown" : "application/json"),
        })),
      },
      beforeDispatch: async (task) => {
        node.taskId = task.taskId;
        node.assignedNodeId = targetNodeId;
        node.assignedProjectId = targetProjectId;
        node.status = "dispatched";
        await this.store.saveGraphNode?.({ ...node, startedAt: Date.now(), attemptCount: (node.attemptCount ?? 0) + 1 });
        await this.store.updateGraphNodeStatus?.(graph.graphId, node.nodeId, "dispatched", {
          taskId: task.taskId,
          startedAt: Date.now(),
          attemptCount: (node.attemptCount ?? 0) + 1,
          assignedNodeId: targetNodeId,
          assignedProjectId: targetProjectId,
        });
        if (this.artifactService) {
          const artifacts = await this.store.listArtifacts?.(graph.graphId) ?? [];
          for (const requirement of node.requiredArtifacts) {
            const producer = await this.store.getGraphNode?.(graph.graphId, requirement.producerNodeId);
            for (const found of artifacts.filter((a) => a.name === requirement.name && a.producerTaskId === producer?.taskId)) {
              await this.artifactService.grantAccess(found.artifactId, graph.graphId, targetNodeId!, task.taskId);
            }
          }
        }
      },
    }));

    } catch (err) {
      this.activeProjectWrites.delete(`${targetNodeId}::${targetProjectId}`);
      node.status = "blocked";
      await this.store.updateGraphNodeStatus?.(graph.graphId, node.nodeId, "blocked", { error: String(err) });
      await this.store.appendGraphEvent?.(graph.graphId, "graph.node_blocked", { graphId: graph.graphId, nodeId: node.nodeId, reason: String(err) });
      await this.propagateBlockage(graph.graphId, node.nodeId, String(err));
      return;
    }

    await this.store.appendGraphEvent?.(graph.graphId, "graph.task_dispatched", {
      graphId: graph.graphId,
      nodeId: node.nodeId,
      taskId: taskRecord.taskId,
      targetNodeId,
      targetProjectId,
      assignedNodeId: targetNodeId,
      assignedProjectId: targetProjectId,
    });
    });
  }

  /**
   * 评估整张 TaskGraph 的 Goal-Level 完成情况
   */
  async evaluateGoalCompletion(graphId: string) {
    return this.verifier.verifyGoalCompletion(graphId);
  }

  /**
   * 5. 接收子任务执行完成通知并推进后继
   */
  async handleNodeTaskCompleted(
    graphId: string,
    taskId: string,
    resultSummary: string,
    producedArtifacts?: Array<{ name: string; contentType?: string; content?: string }>,
    evidence?: Partial<VerifyNodeResultInput>
  ): Promise<void> {
    const allNodes = await this.store.listGraphNodes?.(graphId) ?? [];
    const node = allNodes.find((n) => n.taskId === taskId);
    if (!node || ["completed", "failed", "cancelled"].includes(node.status) || this.completing.has(taskId)) return;
    this.completing.add(taskId);
    try {

    // 释放项目写租约
    if (node.assignedNodeId && node.assignedProjectId) {
      this.activeProjectWrites.delete(`${node.assignedNodeId}::${node.assignedProjectId}`);
    }

    // 注册产物到 ArtifactService
    if (producedArtifacts && producedArtifacts.length > 0 && this.artifactService) {
      for (const art of producedArtifacts) {
        if (!node.producedArtifacts.some((spec) => spec.name === art.name && (!art.contentType || spec.contentType === art.contentType))) throw new GraphExecutionError("Worker published an undeclared artifact");
        if (art.content !== undefined) {
          const existing = (await this.store.listArtifacts?.(graphId) ?? []).find((item) => item.producerTaskId === taskId && item.name === art.name);
          if (existing) continue;
          await this.artifactService.publishArtifact({
            graphId,
            producerTaskId: taskId,
            producerNodeId: node.assignedNodeId ?? "unknown",
            name: art.name,
            contentType: art.contentType,
            content: art.content,
            metadata: { runId: (await this.store.getTask(taskId))?.runId,
              graphRevision: (await this.store.getTask(taskId))?.dispatchOptions?.graphContext?.graphRevision },
          });
        }
      }
    }

    const verification = await this.verifier.verifyNode({ ...evidence, graphId, graphNodeId: node.nodeId, taskId,
      acceptanceCriteria: node.acceptanceCriteria, requiredCapabilities: node.requiredCapabilities,
      resultSummary, producedArtifactNames: producedArtifacts?.map((a) => a.name) });
    if (verification.evidence.pendingEvidence) return;
    if (verification.status !== "passed") {
      await this.handleNodeTaskFailed(graphId, taskId, verification.message, "VERIFICATION_FAILURE");
      return;
    }

    // 将 GraphNode 状态推进为 completed
    await this.store.updateGraphNodeStatus?.(graphId, node.nodeId, "completed", {
      resultSummary,
      completedAt: Date.now(),
    });

    await this.store.appendGraphEvent?.(graphId, "graph.node_completed", {
      graphId,
      nodeId: node.nodeId,
      taskId,
      resultSummary,
    });

    // 暂停仅停止新派发；已经完成的节点仍需推动终态收敛。
    await this.checkGraphConvergence(graphId);
    await this.advanceGraph(graphId);
    } catch (error) {
      await this.handleNodeTaskFailed(graphId, taskId, error instanceof Error ? error.message : String(error));
    } finally { this.completing.delete(taskId); }
  }

  /**
   * 6. 接收子任务失败通知并执行失败策略传播
   */
  async requestNodeCancellation(graphId: string, taskId: string, reason: string): Promise<void> {
    const node = (await this.store.listGraphNodes?.(graphId) ?? []).find(n => n.taskId === taskId);
    if (!node || ["completed", "failed", "cancelled"].includes(node.status)) return;
    let confirmed = false;
    try { confirmed = (await this.scheduler.sendControl(taskId, "cancel", { reason })).success; }
    catch { /* No transport confirmation means the outcome remains unknown. */ }
    const task = await this.store.getTask(taskId);
    if (task?.status === "cancelled") { await this.handleNodeTaskCancelled(graphId, taskId, reason); return; }
    if (task && ["completed", "failed"].includes(task.status)) return;
    const status = confirmed ? "cancelling" : "outcome_unknown";
    await this.store.updateTaskStatus(taskId, status, { error: reason });
    await this.store.updateGraphNodeStatus?.(graphId, node.nodeId, status, { error: reason });
    await this.store.appendGraphEvent?.(graphId, `graph.node_${status}`, { graphId, nodeId: node.nodeId, taskId, reason });
    await this.checkGraphConvergence(graphId);
  }

  async handleNodeTaskFailed(graphId: string, taskId: string, error: string, classification: GraphFailureClassification = "RUNTIME_EXECUTION_FAILURE"): Promise<void> {
    const allNodes = await this.store.listGraphNodes?.(graphId) ?? [];
    const node = allNodes.find((n) => n.taskId === taskId);
    if (!node || ["completed", "failed", "cancelled"].includes(node.status)) return;

    // 释放租约
    if (node.assignedNodeId && node.assignedProjectId) {
      this.activeProjectWrites.delete(`${node.assignedNodeId}::${node.assignedProjectId}`);
    }

    await this.store.updateGraphNodeStatus?.(graphId, node.nodeId, "failed", {
      error,
      completedAt: Date.now(),
    });

    await this.store.appendGraphEvent?.(graphId, "graph.node_failed", {
      graphId,
      nodeId: node.nodeId,
      taskId,
      error,
      failurePolicy: node.failurePolicy,
      classification,
    });

    // 根据失败策略传播
    if (node.failurePolicy === "cancel_graph") {
      await this.cancelGraph(graphId, `Node '${node.nodeId}' failed: ${error}`);
    } else if (node.failurePolicy === "block_dependents") {
      await this.propagateBlockage(graphId, node.nodeId, error);
    } else if (node.failurePolicy === "skip_dependents") {
      await this.propagateBlockage(graphId, node.nodeId, error, "skipped");
    }

    await this.advanceGraph(graphId);
    await this.checkGraphConvergence(graphId);
  }

  /**
   * 7. 传播下游任务阻断 (Block Dependents)
   */
  private async propagateBlockage(graphId: string, failedNodeId: string, reason: string, status: "blocked" | "skipped" = "blocked"): Promise<void> {
    const [allNodes, allEdges] = await Promise.all([
      this.store.listGraphNodes?.(graphId) ?? [],
      this.store.listGraphEdges?.(graphId) ?? [],
    ]);

    const queue: string[] = [failedNodeId];
    const blockedNodes = new Set<string>();

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const dependents = allEdges.filter((e) => e.fromNodeId === curr && e.dependencyType !== "completion").map((e) => e.toNodeId);
      for (const dep of dependents) {
        if (!blockedNodes.has(dep)) {
          blockedNodes.add(dep);
          queue.push(dep);
        }
      }
    }

    for (const bNodeId of blockedNodes) {
      const node = allNodes.find((n) => n.nodeId === bNodeId);
      if (node && (node.status === "waiting_dependencies" || node.status === "ready" || node.status === "pending")) {
        await this.store.updateGraphNodeStatus?.(graphId, bNodeId, status, {
          error: `Blocked due to upstream failure of '${failedNodeId}': ${reason}`,
        });
        await this.store.appendGraphEvent?.(graphId, `graph.node_${status}`, {
          graphId,
          nodeId: bNodeId,
          causedBy: failedNodeId,
        });
      }
    }
  }

  /**
   * 8. 全图终态收敛检查
   */
  private async checkGraphConvergence(graphId: string): Promise<void> {
    const graph = await this.store.getGraph?.(graphId);
    if (!graph || !["running", "paused", "cancelling"].includes(graph.status)) return;

    const allNodes = await this.store.listGraphNodes?.(graphId) ?? [];
    if (allNodes.length === 0) return;

    const completed = allNodes.filter((n) => n.status === "completed").length;
    const failed = allNodes.filter((n) => n.status === "failed").length;
    const blocked = allNodes.filter((n) => n.status === "blocked").length;
    const skipped = allNodes.filter((n) => n.status === "skipped").length;
    const cancelled = allNodes.filter((n) => n.status === "cancelled").length;
    const unknown = allNodes.some(n => n.status === "outcome_unknown");
    const active = allNodes.filter((n) => ["ready", "dispatched", "accepted", "running", "waiting_dependencies", "waiting_approval", "queued", "cancelling"].includes(n.status)).length;

    if (active === 0 || (unknown && !allNodes.some(n => ["dispatched", "accepted", "running", "waiting_approval", "cancelling"].includes(n.status)))) {
      // 释放所有残留的项目写租约
      for (const node of allNodes) {
        if (node.status !== "outcome_unknown" && node.assignedNodeId && node.assignedProjectId) {
          this.activeProjectWrites.delete(`${node.assignedNodeId}::${node.assignedProjectId}`);
        }
      }

      const anyCancelled = allNodes.some((n) => n.status === "cancelled");
      const goalEvaluation = unknown ? { goalCompleted: false, summary: "Worker outcome is unknown; reconciliation required" } : await observeGraphPhase(this.store, graphId, "goal_verification", () => this.verifier.verifyGoalCompletion(graphId, true), result => result.goalCompleted ? "ok" : "error");
      const currentNodes = await this.store.listGraphNodes?.(graphId) ?? [];
      if (currentNodes.length !== allNodes.length || currentNodes.some((node) => {
        const before = allNodes.find((item) => item.nodeId === node.nodeId);
        return node.taskId !== before?.taskId || node.status !== before?.status;
      })) return;
      const status = unknown ? "outcome_unknown" : goalEvaluation.goalCompleted ? "completed"
        : anyCancelled || (completed > 0 && (failed > 0 || blocked > 0 || skipped > 0))
          ? (completed === 0 && anyCancelled && failed === 0 ? "cancelled" : "partially_completed") : "failed";
      const now = Date.now();
      const details = goalEvaluation.goalCompleted
        ? { finalSummary: `All ${completed} tasks completed successfully.`, completedAt: now }
        : { error: goalEvaluation.summary, completedAt: now };
      const transitioned = this.store.transitionGraphStatus
        ? await this.store.transitionGraphStatus(graphId, graph.revision, graph.status, status, details)
        : false;
      if (!transitioned) return;
      await this.store.appendGraphEvent?.(graphId, `graph.${status}`, { graphId, completedAt: now, monotonicAt: performance.now(), clockId: `${process.pid}:${performance.timeOrigin}` });
      this.eventBus?.emit({ id: randomUUID(), type: `graph.${status}` as any, timestamp: new Date().toISOString(), projectId: "coordinator", sessionId: graphId, data: { graphId, status, ...details } });
      this.notifyCompletion(graphId);
    }
  }

  async pauseGraph(graphId: string): Promise<void> {
    const operation = this.advancement.then(async () => {
      const graph = await this.store.getGraph?.(graphId);
      if (!graph || graph.status !== "running") throw new GraphExecutionError("Only a running graph can be paused");
      if (!await this.transitionOrUpdate(graphId, graph.revision, "running", "paused")) throw new GraphExecutionError("Graph changed before pause");
      await this.store.appendGraphEvent?.(graphId, "graph.paused", { graphId });
    });
    this.advancement = operation.catch(() => {});
    return operation;
  }

  async resumeGraph(graphId: string): Promise<void> {
    const graph = await this.store.getGraph?.(graphId);
    if (!graph || graph.status !== "paused") throw new GraphExecutionError("Only a paused graph can be resumed");
    if (!await this.transitionOrUpdate(graphId, graph.revision, "paused", "running")) throw new GraphExecutionError("Graph changed before resume");
    await this.store.appendGraphEvent?.(graphId, "graph.resumed", { graphId });
    await this.advanceGraph(graphId);
  }

  /** Compare-and-set a graph status so a concurrent replan or terminal transition is never overwritten. */
  private async transitionOrUpdate(graphId: string, expectedRevision: number, expectedStatus: GraphStatus, status: GraphStatus, details?: { error?: string; finalSummary?: string; completedAt?: number }): Promise<boolean> {
    if (this.store.transitionGraphStatus) return this.store.transitionGraphStatus(graphId, expectedRevision, expectedStatus, status, details);
    const current = await this.store.getGraph?.(graphId);
    if (!current || current.status !== expectedStatus) return false;
    await this.store.updateGraphStatus?.(graphId, status, details);
    return true;
  }

  /**
   * 9. 取消任务图
   */
  async cancelGraph(graphId: string, reason = "Cancelled by user"): Promise<void> {
    const claimCancellation = async () => {
      const current = await this.store.getGraph?.(graphId);
      if (!current || ["completed", "failed", "cancelled", "partially_completed"].includes(current.status)) return undefined;
      await this.store.updateGraphStatus?.(graphId, "cancelling");
      return current;
    };
    const graph = this.store.withGraphLock ? await this.store.withGraphLock(graphId, claimCancellation) : await claimCancellation();
    if (!graph) return;
    const allNodes = await this.store.listGraphNodes?.(graphId) ?? [];

    let hasActiveTasks = false;
    for (const node of allNodes) {
      if (["pending", "waiting_dependencies", "ready"].includes(node.status)) {
        await this.store.updateGraphNodeStatus?.(graphId, node.nodeId, "cancelled");
        node.status = "cancelled";
      } else if (node.taskId && ["queued", "dispatched", "accepted", "running", "waiting_approval", "cancelling", "outcome_unknown"].includes(node.status)) {
        // 向远程 TaskScheduler 发送取消
        let delivered = false;
        try {
          const ctrlRes = await this.scheduler.sendControl(node.taskId, "cancel", { reason });
          delivered = ctrlRes.success;
        } catch {}

        const task = await this.store.getTask(node.taskId);
        if (task?.status === "cancelled") {
          await this.store.updateGraphNodeStatus?.(graphId, node.nodeId, "cancelled");
          node.status = "cancelled";
        } else if (delivered) {
          hasActiveTasks = true;
          await this.store.updateGraphNodeStatus?.(graphId, node.nodeId, "cancelling");
          node.status = "cancelling";
        } else {
          // 未确认取消不得伪装为停止。
          hasActiveTasks = true;
          await this.store.updateGraphNodeStatus?.(graphId, node.nodeId, "outcome_unknown", {
            error: `Cancelled while worker node is offline or unreachable: ${reason}`,
          });
          node.status = "outcome_unknown";
        }
      }
      // 已处于 completed 终态的任务绝对保留 completed，不被取消强行覆盖
    }

    if (hasActiveTasks) await this.checkGraphConvergence(graphId);
    if (!hasActiveTasks) {
      const anyCompleted = allNodes.some((n) => n.status === "completed");
      const targetStatus = anyCompleted ? "partially_completed" : "cancelled";
      // A node that converges completed while cancellation is running owns the terminal state;
      // never clobber it with an unconditional write.
      const applied = await this.transitionOrUpdate(graphId, graph.revision, "cancelling", targetStatus, { error: reason, completedAt: Date.now() });
      if (!applied) return;
      await this.store.appendGraphEvent?.(graphId, "graph.cancelled", { graphId, reason, cancelledAt: Date.now() });
      this.eventBus?.emit({ id: randomUUID(), type: `graph.${targetStatus}` as any, timestamp: new Date().toISOString(), projectId: "coordinator", sessionId: graphId, data: { graphId, status: targetStatus, error: reason } });
      this.notifyCompletion(graphId);
    }
  }

  /**
   * 10. 处理子任务取消完成事件
   */
  async handleNodeTaskCancelled(graphId: string, taskId: string, reason?: string): Promise<void> {
    const allNodes = await this.store.listGraphNodes?.(graphId) ?? [];
    const node = allNodes.find((n) => n.taskId === taskId);
    if (!node) return;

    if (["completed", "failed", "cancelled"].includes(node.status)) return;
    if (node.assignedNodeId && node.assignedProjectId) this.activeProjectWrites.delete(`${node.assignedNodeId}::${node.assignedProjectId}`);
    if (node.status !== "completed") {
      await this.store.updateGraphNodeStatus?.(graphId, node.nodeId, "cancelled", {
        error: reason ?? "Cancelled",
        completedAt: Date.now(),
      });
      node.status = "cancelled";
    }

    await this.store.appendGraphEvent?.(graphId, "graph.node_cancelled", {
      graphId,
      nodeId: node.nodeId,
      taskId,
      reason,
    });

    await this.checkGraphConvergence(graphId);
  }
}
