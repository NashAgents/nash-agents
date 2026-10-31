import { defaultTraceContext } from "../../observability/trace-context.js";
import crypto from "node:crypto";
import type { GraphProposalNode } from "../graph/types.js";
import type { Tool, ToolExecutionContext } from "../../tools/tool.js";
import type { ClusterSearchService } from "../coordinator/catalog/cluster-search-service.js";
import type { CoordinatorCatalogService } from "../coordinator/catalog/coordinator-catalog-service.js";
import type { IClusterStore } from "../storage/cluster-store.js";
import { createScheduledAgentTools } from "../scheduled/scheduled-tools.js";
import type { ScheduleTriggerEngine } from "../scheduled/schedule-trigger-engine.js";

/**
 * 1. search_cluster_projects
 * 发现跨节点的项目、技术栈与功能描述
 */
export class SearchClusterProjectsTool implements Tool<{ query?: string; nodeId?: string; limit?: number }> {
  public readonly name = "search_cluster_projects";
  public readonly description = "Search registered projects across the Nash cluster by natural language, technology tags, or capabilities.";
  public readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search keywords or natural language query (e.g. 'English reader', 'Agent harness', 'subtitles')",
      },
      nodeId: {
        type: "string",
        description: "Optional filter to target a specific cluster node ID",
      },
      limit: {
        type: "number",
        description: "Maximum number of projects to return (default 10)",
      },
    },
  };

  constructor(private readonly searchService: ClusterSearchService) {}

  async execute(args: { query?: string; nodeId?: string; limit?: number }) {
    const results = await this.searchService.searchProjects(args.query, {
      nodeId: args.nodeId,
      limit: args.limit ?? 10,
    });
    return {
      totalFound: results.length,
      projects: results.map((p) => ({
        nodeId: p.nodeId,
        projectId: p.projectId,
        name: p.name,
        summary: p.summary,
        technologies: p.technologies,
        capabilities: p.capabilities,
        score: p.score,
        matchReasons: p.matchReasons,
        nodeOnline: p.nodeOnline,
      })),
    };
  }
}

/**
 * 2. search_cluster_capabilities
 * 发现集群中所有节点的 Skills 与 MCP 工具能力
 */
export class SearchClusterCapabilitiesTool implements Tool<{ query?: string; nodeId?: string; type?: "skills" | "mcp" | "all" }> {
  public readonly name = "search_cluster_capabilities";
  public readonly description = "Discover Skills and MCP tool capabilities available across the Nash cluster.";
  public readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search term for skills or tools (e.g. 'code-review', 'bilibili', 'extract')",
      },
      nodeId: {
        type: "string",
        description: "Optional filter for a specific node ID",
      },
      type: {
        type: "string",
        enum: ["skills", "mcp", "all"],
        description: "Capability type to search ('skills', 'mcp', or 'all')",
      },
    },
  };

  constructor(private readonly searchService: ClusterSearchService) {}

  async execute(args: { query?: string; nodeId?: string; type?: "skills" | "mcp" | "all" }) {
    const type = args.type ?? "all";
    const res: { skills?: any[]; mcp?: any[] } = {};

    if (type === "skills" || type === "all") {
      res.skills = await this.searchService.searchSkills(args.query, { nodeId: args.nodeId });
    }
    if (type === "mcp" || type === "all") {
      res.mcp = await this.searchService.searchMCPCapabilities(args.query, { nodeId: args.nodeId });
    }

    return res;
  }
}

/**
 * 3. search_cluster_memory
 * 执行两级联邦记忆检索 (第一级本地索引过滤，可选第二级远程检索)
 */
export class SearchClusterMemoryTool implements Tool<{ query: string; nodeId?: string; projectId?: string; deep?: boolean; topK?: number }> {
  public readonly name = "search_cluster_memory";
  public readonly description = "Search the federated memory index across cluster projects to find relevant knowledge and candidate projects.";
  public readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural language query or question (e.g. 'How does MCP discovery work?')",
      },
      nodeId: {
        type: "string",
        description: "Optional filter for a specific node",
      },
      projectId: {
        type: "string",
        description: "Optional filter for a specific project ID",
      },
      deep: {
        type: "boolean",
        description: "If true, triggers Stage 2 Remote Memory Search on candidate online nodes for detailed memory snippets",
      },
      topK: {
        type: "number",
        description: "Maximum candidates to return (default 5)",
      },
    },
    required: ["query"],
  };

  constructor(private readonly searchService: ClusterSearchService) {}

  async execute(args: { query: string; nodeId?: string; projectId?: string; deep?: boolean; topK?: number }) {
    const results = await this.searchService.searchFederatedMemory(args.query, {
      nodeId: args.nodeId,
      projectId: args.projectId,
      deep: args.deep ?? false,
      topK: args.topK ?? 5,
    });

    return {
      query: args.query,
      candidatesCount: results.length,
      candidates: results,
    };
  }
}

/**
 * 4. search_remote_memory
 * 直接向指定在线节点发起第二级细粒度远程 Memory 检索
 */
export class SearchRemoteMemoryTool implements Tool<{ nodeId: string; projectId: string; query: string; topK?: number }> {
  public readonly name = "search_remote_memory";
  public readonly description = "Retrieve authoritative memory snippets directly from an online worker node's MemoryService.";
  public readonly parameters = {
    type: "object",
    properties: {
      nodeId: {
        type: "string",
        description: "Target node ID where the project resides",
      },
      projectId: {
        type: "string",
        description: "Target project ID",
      },
      query: {
        type: "string",
        description: "Search query for memory recall",
      },
      topK: {
        type: "number",
        description: "Number of top results to retrieve (default 5)",
      },
    },
    required: ["nodeId", "projectId", "query"],
  };

  constructor(private readonly catalogService: CoordinatorCatalogService) {}

  async execute(args: { nodeId: string; projectId: string; query: string; topK?: number }) {
    return this.catalogService.searchRemoteMemory(args.nodeId, args.projectId, args.query, {
      topK: args.topK ?? 5,
    });
  }
}

/**
 * 5. get_cluster_node
 * 查询特定节点的详情、在线状态与硬件能力
 */
export class GetClusterNodeTool implements Tool<{ nodeId: string }> {
  public readonly name = "get_cluster_node";
  public readonly description = "Get details, hardware status, and capabilities of a specific cluster node.";
  public readonly parameters = {
    type: "object",
    properties: {
      nodeId: {
        type: "string",
        description: "The unique node ID to inspect",
      },
    },
    required: ["nodeId"],
  };

  constructor(private readonly searchService: ClusterSearchService) {}

  async execute(args: { nodeId: string }) {
    const nodes = await this.searchService.searchNodes(args.nodeId);
    const node = nodes.find((n) => n.nodeId === args.nodeId);
    if (!node) {
      return { found: false, error: `Node ${args.nodeId} not found` };
    }
    return { found: true, node };
  }
}

/**
 * 6. get_cluster_project
 * 查询特定项目的完整元数据、技术栈与目录信息
 */
export class GetClusterProjectTool implements Tool<{ projectId: string; nodeId?: string }> {
  public readonly name = "get_cluster_project";
  public readonly description = "Get detailed catalog metadata for a specific project.";
  public readonly parameters = {
    type: "object",
    properties: {
      projectId: {
        type: "string",
        description: "Project ID to inspect",
      },
      nodeId: {
        type: "string",
        description: "Optional node ID where project is registered",
      },
    },
    required: ["projectId"],
  };

  constructor(private readonly store: IClusterStore) {}

  async execute(args: { projectId: string; nodeId?: string }) {
    if (args.nodeId) {
      const proj = await this.store.getProjectCatalog(args.nodeId, args.projectId);
      if (!proj) {
        return { found: false, error: `Project ${args.projectId} not found on node ${args.nodeId}` };
      }
      return { found: true, project: proj };
    }

    const all = await this.store.listProjectsCatalog();
    const proj = all.find((p) => p.projectId === args.projectId);
    if (!proj) {
      return { found: false, error: `Project ${args.projectId} not found` };
    }
    return { found: true, project: proj };
  }
}

/**
 * 7. route_cluster_task (Phase 3)
 * 根据自然语言目标自主规划任务路由与目标节点/项目推荐
 */
export class RouteClusterTaskTool implements Tool<{ goal: string; dryRun?: boolean; explicitNodeId?: string; explicitProjectId?: string }> {
  public readonly name = "route_cluster_task";
  public readonly description = "Intelligently analyze a natural language task and determine optimal node and project targets based on catalog, memory, and capabilities.";
  public readonly parameters = {
    type: "object",
    properties: {
      goal: {
        type: "string",
        description: "Natural language description of the task goal (e.g. 'inspect Nash sandbox module', 'check PyTorch on WSL2')",
      },
      dryRun: {
        type: "boolean",
        description: "Only plan and rank candidates without dispatching (default true)",
      },
      explicitNodeId: {
        type: "string",
        description: "Optional hard constraint pinning execution to a specific node ID",
      },
      explicitProjectId: {
        type: "string",
        description: "Optional hard constraint pinning execution to a specific project ID",
      },
    },
    required: ["goal"],
  };

  constructor(private readonly router: import("../router/semantic-task-router.js").SemanticTaskRouter) {}

  async execute(args: { goal: string; dryRun?: boolean; explicitNodeId?: string; explicitProjectId?: string }) {
    const res = await this.router.planRoute(args.goal, {
      constraints: {
        explicitNodeId: args.explicitNodeId,
        explicitProjectId: args.explicitProjectId,
      },
      dryRun: args.dryRun !== false,
    });
    return {
      decisionId: res.decision.decisionId,
      decisionType: res.decision.decisionType,
      selectedTarget: res.decision.selectedCandidate
        ? {
            nodeId: res.decision.selectedCandidate.nodeId,
            projectId: res.decision.selectedCandidate.projectId,
            projectName: res.decision.selectedCandidate.projectName,
            score: res.decision.selectedCandidate.score,
          }
        : null,
      reason: res.decision.reason,
      clarificationPrompt: res.decision.clarificationPrompt,
      clarificationOptions: res.decision.clarificationOptions,
      alternativesCount: res.decision.alternativeCandidates.length,
      validation: res.validation,
    };
  }
}

/**
 * 8. explain_cluster_route (Phase 3)
 * 查看路由决策与候选排序的详细依据与排除原因
 */
export class ExplainClusterRouteTool implements Tool<{ decisionId?: string; routeId?: string }> {
  public readonly name = "explain_cluster_route";
  public readonly description = "Explain why a specific cluster node/project was selected and why other candidates were rejected.";
  public readonly parameters = {
    type: "object",
    properties: {
      decisionId: {
        type: "string",
        description: "The routing decision ID or route ID to explain",
      },
    },
    required: ["decisionId"],
  };

  constructor(private readonly store: IClusterStore) {}

  async execute(args: { decisionId?: string; routeId?: string }) {
    const id = args.decisionId || args.routeId;
    if (!id) return { error: "Missing decisionId" };
    const route = await this.store.getRouteDecision?.(id);
    if (!route) {
      return { found: false, error: `Route decision '${id}' not found` };
    }
    return {
      found: true,
      routeId: route.routeId,
      taskId: route.taskId,
      userRequest: route.userRequest,
      decisionType: route.decisionType,
      selectedNodeId: route.selectedNodeId,
      selectedProjectId: route.selectedProjectId,
      reason: route.reason,
      status: route.status,
      candidatesCount: route.candidatesSnapshot?.length ?? 0,
    };
  }
}

/**
 * 9. dispatch_cluster_task (Phase 3)
 * 在通过确定性校验后正式下发任务到目标 Worker
 */
export class DispatchClusterTaskTool implements Tool<{
  goal: string;
  nodeId?: string;
  projectId?: string;
  waitTimeoutMs?: number;
  taskTimeoutMs?: number;
  timeoutMs?: number;
  waitCompletion?: boolean;
}> {
  public readonly name = "dispatch_cluster_task";
  public readonly description = "Dispatch an autonomous task to a verified cluster node and project, and wait for completion to obtain the deliverable.";
  public readonly parameters = {
    type: "object",
    properties: {
      goal: {
        type: "string",
        description: "The task goal to execute",
      },
      nodeId: {
        type: "string",
        description: "Target node ID (optional, will auto-route if omitted)",
      },
      projectId: {
        type: "string",
        description: "Target project ID (optional, will auto-route if omitted)",
      },
      waitTimeoutMs: {
        type: "number",
        description: "Front-end wait window in milliseconds (default 300000). Only bounds how long this call waits; it never limits how long the worker agent may run.",
      },
      taskTimeoutMs: {
        type: "number",
        description: "Optional worker run budget in milliseconds. Leave unset to use the worker's own agent budget. This is the ONLY value that can stop a running worker agent.",
      },
      timeoutMs: {
        type: "number",
        description: "Deprecated alias for waitTimeoutMs. It no longer limits worker execution time.",
      },
      waitCompletion: {
        type: "boolean",
        description: "Whether to suspend and wait until the remote worker completes execution (default true). Avoids wasting LLM steps polling.",
      },
    },
    required: ["goal"],
  };

  constructor(
    private readonly router: import("../router/semantic-task-router.js").SemanticTaskRouter,
    private readonly store?: IClusterStore,
    private readonly eventBus?: import("../../observability/event-bus.js").EventBus,
    private readonly onTaskDispatched?: (taskId: string, details: { nodeId?: string; projectId?: string; goal?: string }) => void | Promise<void>
  ) {}

  async execute(
    args: {
      goal: string;
      nodeId?: string;
      projectId?: string;
      waitTimeoutMs?: number;
      taskTimeoutMs?: number;
      timeoutMs?: number;
      waitCompletion?: boolean;
    },
    context?: ToolExecutionContext
  ) {
    // 关键解耦：前台等待窗口与 Worker 执行预算必须是两个独立参数。
    // 历史上 timeoutMs 同时充当两者，任何 180000（3 分钟）的传入都会把仍在工作的 Agent 杀掉。
    const res = await this.router.runAutonomous(args.goal, {
      constraints: {
        explicitNodeId: args.nodeId,
        explicitProjectId: args.projectId,
        timeoutMs: args.taskTimeoutMs,
      },
      dryRun: false,
    });

    const taskId = res.dispatchResult?.taskId;
    const shouldWait = args.waitCompletion !== false;

    // 核心即时通知：任务一旦创建并下发至调度器，立即触发通知，绝不阻塞等待
    if (res.dispatchResult?.success && taskId) {
      if (this.onTaskDispatched) {
        try {
          await this.onTaskDispatched(taskId, {
            nodeId: res.dispatchResult.nodeId,
            projectId: res.dispatchResult.projectId,
            goal: args.goal,
          });
        } catch {}
      }
      if (this.eventBus) {
        try {
          this.eventBus.emit({
            id: crypto.randomUUID(),
            type: "coordinator.task_dispatched" as any,
            timestamp: new Date().toISOString(),
            projectId: res.dispatchResult.projectId || "coordinator",
            sessionId: taskId,
            data: {
              taskId,
              nodeId: res.dispatchResult.nodeId,
              projectId: res.dispatchResult.projectId,
              goal: args.goal,
              status: "dispatched",
            },
          });
        } catch {}
      }
    }

    let finalTaskState: any = null;
    const requestedWaitMs = args.waitTimeoutMs ?? args.timeoutMs;
    const effectiveTimeoutMs = requestedWaitMs && requestedWaitMs > 0 ? requestedWaitMs : 300000;
    if (res.dispatchResult?.success && taskId && this.store && shouldWait) {
      finalTaskState = await this.waitForTaskCompletion(taskId, effectiveTimeoutMs, context?.signal);
    }

    const isTerminal = finalTaskState && ["completed", "failed", "cancelled"].includes(finalTaskState.status);
    const isTimedOut = shouldWait && !isTerminal;

    // 当等待超时但 Worker 仍在后台持续运行时，生成友好的后台交付说明
    let deliverableAnswer = finalTaskState?.finalAnswer;
    if (isTimedOut && !deliverableAnswer) {
      deliverableAnswer = `【任务已在后台持续执行中】\n任务已成功下发至节点（任务 ID: \`${taskId}\`），由于当前操作较为复杂或耗时较长，已超过前台同步等待阈值（${Math.round(effectiveTimeoutMs / 1000)}秒），目前 Worker 正在沙箱中持续推进执行。系统将在任务完成后自动同步交付成果，您也可在任务列表中查看实时事件时间线。`;
    }

    return {
      success: res.dispatchResult?.success ?? false,
      decisionType: res.decision.decisionType,
      taskId,
      nodeId: res.dispatchResult?.nodeId,
      projectId: res.dispatchResult?.projectId,
      status: finalTaskState?.status ?? res.dispatchResult?.status ?? res.decision.decisionType,
      timedOut: isTimedOut,
      finalAnswer: deliverableAnswer,
      resultSummary: finalTaskState?.resultSummary ?? (isTimedOut ? "任务已转入后台持续执行" : undefined),
      deliverables: deliverableAnswer ? [deliverableAnswer] : undefined,
      note: isTimedOut
        ? "Task is still actively running in the background on the target worker. DO NOT dispatch another task for this goal or create a DAG. Inform the user that the task is executing in background."
        : undefined,
      error: finalTaskState?.error ?? res.dispatchResult?.error ?? res.validation.reason,
    };
  }

  private async waitForTaskCompletion(taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    const effectiveTimeout = timeoutMs > 0 ? timeoutMs : 300000;
    const deadline = Date.now() + effectiveTimeout;
    while (Date.now() < deadline && !signal?.aborted) {
      const task = await this.store!.getTask(taskId);
      if (task) {
        if (["completed", "failed", "cancelled"].includes(task.status)) {
          return task;
        }
      }
      if (signal?.aborted) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 800);
        if (signal) {
          const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
    return await this.store!.getTask(taskId);
  }
}

/**
 * 10. get_cluster_task_status (Phase 3)
 * 查询远程任务执行进度、当前动作与最终产出
 */
export class GetClusterTaskStatusTool implements Tool<{ taskId: string; waitTimeoutMs?: number }> {
  public readonly name = "get_cluster_task_status";
  public readonly description = "Get current status, live progress, and deliverables of a cluster task. Supports suspending and waiting for completion.";
  public readonly parameters = {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The cluster task ID to inspect",
      },
      waitTimeoutMs: {
        type: "number",
        description: "Optional milliseconds to wait for task completion before returning status (default 0)",
      },
    },
    required: ["taskId"],
  };

  constructor(private readonly store: IClusterStore) {}

  async execute(args: { taskId: string; waitTimeoutMs?: number }, context?: ToolExecutionContext) {
    let task = await this.store.getTask(args.taskId);
    if (!task) {
      return { found: false, error: `Task '${args.taskId}' not found` };
    }

    // 若任务在运行中且指定了等待窗口，挂起等待直至完成或超时
    if (args.waitTimeoutMs && args.waitTimeoutMs > 0 && ["dispatched", "accepted", "running"].includes(task.status)) {
      const deadline = Date.now() + Math.min(args.waitTimeoutMs, 60000);
      while (Date.now() < deadline && !context?.signal?.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 800);
          if (context?.signal) {
            const onAbort = () => {
              clearTimeout(timer);
              context.signal?.removeEventListener("abort", onAbort);
              resolve();
            };
            context.signal.addEventListener("abort", onAbort, { once: true });
          }
        });
        task = await this.store.getTask(args.taskId);
        if (!task || ["completed", "failed", "cancelled"].includes(task.status)) {
          break;
        }
      }
    }

    if (!task) {
      return { found: false, error: `Task '${args.taskId}' not found` };
    }

    const events = await this.store.getEventsForTask(args.taskId, 0, 50);
    return {
      found: true,
      task: {
        taskId: task.taskId,
        nodeId: task.nodeId,
        projectId: task.projectId,
        goal: task.goal,
        status: task.status,
        resultSummary: task.resultSummary,
        finalAnswer: task.finalAnswer,
        error: task.error,
        updatedAt: task.updatedAt,
      },
      recentEventsCount: events.length,
      lastEvent: events[events.length - 1],
    };
  }
}

/**
 * 11. request_cluster_replan (Phase 3)
 * 当任务遇到无法克服的问题或目标改变时向 Coordinator 申请重新规划
 */
export class RequestClusterReplanTool implements Tool<{ taskId: string; trigger?: string; details: string }> {
  public readonly name = "request_cluster_replan";
  public readonly description = "Request Coordinator to re-evaluate and replan a task when blocked or goal changed.";
  public readonly parameters = {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Target task ID",
      },
      trigger: {
        type: "string",
        description: "Replan trigger (e.g. 'EXECUTION_BLOCKED', 'USER_GOAL_CHANGED', 'CAPABILITY_UNAVAILABLE')",
      },
      details: {
        type: "string",
        description: "Reason and details of the replan request",
      },
    },
    required: ["taskId", "details"],
  };

  constructor(private readonly feedbackController: import("../router/routing-feedback-controller.js").RoutingFeedbackController, private readonly store: IClusterStore) {}

  async execute(args: { taskId: string; trigger?: string; details: string }) {
    const task = await this.store.getTask(args.taskId);
    if (!task) {
      return { success: false, error: `Task '${args.taskId}' not found` };
    }
    const trigger = (args.trigger as any) ?? "WORKER_REQUESTS_HELP";
    const evalResult = await this.feedbackController.evaluateIntervention(task, trigger, args.details);
    const replan = await this.feedbackController.recordAndReconcileReplan(task, trigger, args.details, evalResult);
    return {
      success: evalResult.shouldReplan,
      evaluation: evalResult,
      replanId: replan.replanId,
      status: replan.status,
    };
  }
}

const graphNodesSchema = {
  type: "array",
  description: "Your semantic decomposition of the complete user request. Preserve prohibitions and explicit node/project constraints. Omit for single-task fast path or automatic multi-agent decomposition.",
  items: { type: "object", properties: {
    nodeId: { type: "string" }, title: { type: "string" }, goal: { type: "string" },
    description: { type: "string" },
    operation: { type: "string", enum: ["execute", "analyze", "verify", "synthesize"] },
    candidateNodeId: { type: "string" }, candidateProjectId: { type: "string" },
    explicitNodePinned: { type: "boolean" },
    dependencies: { type: "array", items: { type: "string" } },
    dependencyType: { type: "string", enum: ["completion", "success", "artifact", "join"] },
    requiredCapabilities: { type: "array", items: { type: "string" } },
    producedArtifacts: { type: "array", items: { type: "object", properties: { name: { type: "string" }, contentType: { type: "string" } }, required: ["name", "contentType"] } },
    requiredArtifacts: { type: "array", items: { type: "object", properties: { name: { type: "string" }, producerNodeId: { type: "string" } }, required: ["name", "producerNodeId"] } },
    acceptanceCriteria: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: ["artifact_exists", "test_exit_code", "file_modified", "schema_match", "custom"] }, description: { type: "string" }, expected: {} }, required: ["type", "description"] } },
  }, required: ["nodeId", "title", "goal", "dependencies"] },
};

/**
 * 12. plan_distributed_task (Phase 4 / Adaptive Orchestration 2.0)
 * 使用 AutonomousPlanner 评估单/多 Agent 策略并生成结构化 TaskGraph 提案
 */
export class PlanDistributedTaskTool implements Tool<{ goal: string; nodes?: GraphProposalNode[]; maxNodes?: number; maxParallelTasks?: number }> {
  public readonly name = "plan_distributed_task";
  public readonly description = "Evaluate Single-Agent vs Multi-Agent execution strategy and validate a semantic DAG proposal.";
  public readonly parameters = {
    type: "object",
    properties: {
      nodes: graphNodesSchema,
      goal: {
        type: "string",
        description: "The overarching multi-stage objective",
      },
      maxNodes: {
        type: "number",
        description: "Maximum subtasks limit (default 10)",
      },
      maxParallelTasks: {
        type: "number",
        description: "Maximum parallel tasks limit (default 5)",
      },
    },
    required: ["goal"],
  };

  constructor(
    private readonly planner: import("../graph/autonomous-planner.js").AutonomousPlanner,
    private readonly store?: IClusterStore
  ) {}

  async execute(args: { goal: string; nodes?: GraphProposalNode[]; maxNodes?: number; maxParallelTasks?: number }) {
    const { proposal, validation } = await this.planner.planGoal(
      args.goal,
      {
        maxNodes: args.maxNodes,
        maxParallelTasks: args.maxParallelTasks,
      },
      args.nodes,
      { store: this.store }
    );
    return {
      valid: validation.valid,
      validationReason: validation.reason,
      requiresMultiAgent: proposal.requiresMultiAgent,
      strategyDecision: proposal.strategyDecision,
      reasoning: proposal.reasoning,
      nodeCount: proposal.nodes.length,
      proposal,
      nodes: proposal.nodes,
      topologicalOrder: validation.topologicalOrder,
      parallelStages: validation.parallelStages,
    };
  }
}

/**
 * 12.5 run_distributed_task_graph (Phase 4 / Adaptive Orchestration 2.0)
 * 规划并直接启动跨节点、多阶段的分布式任务图 (DAG)
 */
export class RunDistributedTaskGraphTool implements Tool<{ goal: string; nodes?: GraphProposalNode[]; maxNodes?: number }> {
  public readonly name = "run_distributed_task_graph";
  public readonly description = "Validate and execute a semantic DAG across cluster nodes with Join Barriers, artifact exchange, and 3-layer result verification.";
  public readonly parameters = {
    type: "object",
    properties: {
      nodes: graphNodesSchema,
      goal: {
        type: "string",
        description: "The overarching multi-stage or multi-node objective to plan and execute as a DAG TaskGraph",
      },
      maxNodes: {
        type: "number",
        description: "Maximum subtasks limit (default 10)",
      },
    },
    required: ["goal"],
  };

  constructor(
    private readonly planner: import("../graph/autonomous-planner.js").AutonomousPlanner,
    private readonly orchestrator: import("../graph/graph-orchestrator.js").DistributedGraphOrchestrator,
    private readonly onGraphCreated?: (graphId: string, details: { goal: string; nodeCount: number }) => void,
    private readonly completion?: { store: IClusterStore; abortSignal?: AbortSignal; traceId?: string }
  ) {}

  async execute(args: { goal: string; nodes?: GraphProposalNode[]; maxNodes?: number }) {
    const { proposal, validation } = await this.planner.planGoal(
      args.goal,
      {
        maxNodes: args.maxNodes,
      },
      args.nodes,
      { store: this.completion?.store }
    );

    this.completion?.abortSignal?.throwIfAborted();

    if (!validation.valid) {
      return {
        success: false,
        error: `DAG 验证失败: ${validation.reason}`,
      };
    }

    if (proposal.strategyDecision && this.completion?.traceId) { proposal.strategyDecision.traceId = this.completion.traceId; proposal.strategyDecision.conversationId = defaultTraceContext.get()?.conversationId; }
    const graph = await this.orchestrator.createGraph(proposal);
    this.onGraphCreated?.(graph.graphId, {
      goal: args.goal,
      nodeCount: proposal.nodes.length,
    });
    let started = await this.orchestrator.startGraph(graph.graphId);
    if (started.status === "running" && this.completion) {
      started = await this.orchestrator.waitForCompletion(graph.graphId, started.budget.totalTimeoutMs, this.completion.abortSignal);
    }
    const nodeResults = this.completion ? await this.completion.store.listGraphNodes?.(graph.graphId) ?? [] : [];
    const goalEvaluation = await this.orchestrator.evaluateGoalCompletion(graph.graphId);

    return {
      success: ["running", "completed"].includes(started.status),
      graphId: graph.graphId,
      status: started.status,
      revision: started.revision,
      strategyDecision: proposal.strategyDecision,
      goalEvaluation,
      remainingReplanRequests: Math.max(0, started.budget.maxReplanAttempts - (await this.completion?.store.listGraphEvents?.(graph.graphId) ?? []).filter((event) => event.eventType === "graph.replan_started").length),
      nodeCount: proposal.nodes.length,
      error: started.error,
      nodeResults: nodeResults.map((node) => ({ nodeId: node.nodeId, taskId: node.taskId, status: node.status, error: node.error, result: node.resultSummary })),
      stages: (validation.parallelStages || []).map((stage, idx) => ({
        stageIndex: idx + 1,
        nodes: stage.map((nid) => {
          const n = proposal.nodes.find((item) => item.nodeId === nid);
          return {
            nodeId: nid,
            title: n?.title,
            targetClusterNode: n?.candidateNodeId,
            dependencies: n?.dependencies,
          };
        }),
      })),
      message: started.status === "completed" ? "任务图全部阶段已完成并通过产物验收，请根据汇总节点结果交付一次最终答复。" : started.status === "running" ? `任务图已启动（${proposal.nodes.length} 个阶段）。` : `任务图状态：${started.status}。可使用 replan_distributed_task_graph 在原图上进行受控动态重规划（新增修复/验证节点、重连依赖或重分配 Worker），切勿重复创建无关新图。`,
    };
  }
}

/**
 * 12.6 replan_distributed_task_graph (Adaptive Orchestration 2.0)
 * 在已有 TaskGraph 上进行受控动态重规划（新增节点、重连依赖、重选 Worker、受控重试）并推进完成
 */
export class ReplanDistributedTaskGraphTool implements Tool<{
  graphId: string;
  trigger: import("../graph/graph-replanner.js").ReplanTriggerType;
  reason: string;
  failedNodeId?: string;
  addNodes?: GraphProposalNode[];
  rewireDependencies?: import("../graph/graph-replanner.js").RewireDependencySpec[];
  reassignNodes?: import("../graph/graph-replanner.js").ReassignNodeSpec[];
  retryNodeIds?: string[];
  skipNodeIds?: string[];
  waitForCompletion?: boolean;
}> {
  public readonly name = "replan_distributed_task_graph";
  public readonly description = "Dynamically modify an existing TaskGraph (add diagnostic/fix/verify nodes, rewire dependencies, reassign workers, or retry recoverable nodes) while preserving completed node history and incrementing Graph Revision.";
  public readonly parameters = {
    type: "object",
    properties: {
      graphId: { type: "string", description: "Target Graph ID to replan" },
      trigger: {
        type: "string",
        enum: [
          "task_failed",
          "steer",
          "verification_failed",
          "artifact_missing",
          "new_dependency_discovered",
          "worker_unavailable",
          "conflict_detected",
          "goal_incomplete",
        ],
        description: "Reason category triggering the replan",
      },
      reason: { type: "string", description: "Detailed explanation for the dynamic replan" },
      failedNodeId: { type: "string", description: "Optional failed node ID for automatic fix+retest insertion" },
      addNodes: graphNodesSchema,
      rewireDependencies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            nodeId: { type: "string" },
            addDependencies: { type: "array", items: { type: "string" } },
            removeDependencies: { type: "array", items: { type: "string" } },
            dependencyType: { type: "string", enum: ["completion", "success", "artifact", "join"] },
          },
          required: ["nodeId"],
        },
      },
      reassignNodes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            nodeId: { type: "string" },
            targetNodeId: { type: "string" },
            targetProjectId: { type: "string" },
          },
          required: ["nodeId", "targetNodeId"],
        },
      },
      retryNodeIds: { type: "array", items: { type: "string" } },
      skipNodeIds: { type: "array", items: { type: "string" } },
      waitForCompletion: { type: "boolean", description: "Whether to wait for the replanned graph to settle (default true)" },
    },
    required: ["graphId", "trigger", "reason"],
  };

  constructor(
    private readonly replanner: import("../graph/graph-replanner.js").GraphReplanner,
    private readonly orchestrator: import("../graph/graph-orchestrator.js").DistributedGraphOrchestrator,
    private readonly completion?: { store: IClusterStore; abortSignal?: AbortSignal }
  ) {}

  async execute(args: {
    graphId: string;
    trigger: import("../graph/graph-replanner.js").ReplanTriggerType;
    reason: string;
    failedNodeId?: string;
    addNodes?: GraphProposalNode[];
    rewireDependencies?: import("../graph/graph-replanner.js").RewireDependencySpec[];
    reassignNodes?: import("../graph/graph-replanner.js").ReassignNodeSpec[];
    retryNodeIds?: string[];
    skipNodeIds?: string[];
    waitForCompletion?: boolean;
  }) {
    const failedNode = args.failedNodeId ? await this.completion?.store.getGraphNode?.(args.graphId, args.failedNodeId) : undefined;
    const replanResult = args.trigger === "steer" ? await this.replanner.replanGraph({
      graphId: args.graphId, trigger: args.trigger, reason: args.reason,
      failedNodeId: args.failedNodeId, addNodes: args.addNodes, rewireDependencies: args.rewireDependencies,
      reassignNodes: args.reassignNodes, retryNodeIds: args.retryNodeIds, skipNodeIds: args.skipNodeIds,
    }) : await this.replanner.replanWithLlm({
      graphId: args.graphId, trigger: args.trigger, failedNodeId: args.failedNodeId,
      failureDetails: { error: failedNode?.error, resultSummary: failedNode?.resultSummary,
        unresolvedIssues: (await this.completion?.store.listGraphVerifications?.(args.graphId, args.failedNodeId) ?? [])
          .filter((v) => v.status !== "passed").map((v) => v.message ?? v.verificationType) },
    });

    if (!replanResult.success) {
      return {
        success: false,
        graphId: args.graphId,
        revision: replanResult.newRevision,
        error: replanResult.reason,
      };
    }

    let graph = await this.completion?.store.getGraph?.(args.graphId);
    if (args.waitForCompletion !== false && graph?.status === "running" && this.completion) {
      graph = await this.orchestrator.waitForCompletion(
        args.graphId,
        graph.budget.totalTimeoutMs,
        this.completion.abortSignal
      );
    }

    const nodeResults = this.completion
      ? (await this.completion.store.listGraphNodes?.(args.graphId)) ?? []
      : [];
    const goalEvaluation = await this.orchestrator.evaluateGoalCompletion(args.graphId);

    return {
      success: true,
      graphId: args.graphId,
      newRevision: replanResult.newRevision,
      addedNodeIds: replanResult.addedNodeIds,
      modifiedNodeIds: replanResult.modifiedNodeIds,
      unblockedNodeIds: replanResult.unblockedNodeIds,
      status: graph?.status ?? "running",
      goalEvaluation,
      nodeResults: nodeResults.map((node) => ({
        nodeId: node.nodeId,
        taskId: node.taskId,
        status: node.status,
        error: node.error,
        result: node.resultSummary,
      })),
    };
  }
}

/**
 * 13. send_agent_message (Phase 4)
 * 跨节点 Agent 之间发送业务协作与求助消息
 */
export class SendAgentMessageTool implements Tool<{
  graphId: string;
  sourceNodeId: string;
  sourceAgentId: string;
  sourceTaskId?: string;
  targetTaskId?: string;
  targetNodeId: string;
  targetAgentId: string;
  content: string;
  correlationId?: string;
}> {
  public readonly name = "send_agent_message";
  public readonly description = "Send an asynchronous collaboration message to another agent on the same or remote cluster node within the same Graph.";
  public readonly parameters = {
    type: "object",
    properties: {
      graphId: { type: "string", description: "The active Graph ID" },
      sourceNodeId: { type: "string", description: "Source node ID" },
      sourceAgentId: { type: "string", description: "Source agent ID" },
      sourceTaskId: { type: "string", description: "Source task ID (required for remote delivery)" },
      targetTaskId: { type: "string", description: "Target task ID (required for remote delivery)" },
      targetNodeId: { type: "string", description: "Target node ID" },
      targetAgentId: { type: "string", description: "Target agent ID" },
      content: { type: "string", description: "Text or structured message content" },
      correlationId: { type: "string", description: "Optional correlation tracking ID" },
    },
    required: ["graphId", "sourceNodeId", "sourceAgentId", "targetNodeId", "targetAgentId", "content"],
  };

  constructor(private readonly mailbox: import("../a2a/distributed-mailbox.js").DistributedMailbox) {}

  async execute(args: {
    graphId: string;
    sourceNodeId: string;
    sourceAgentId: string;
    sourceTaskId?: string;
    targetTaskId?: string;
    targetNodeId: string;
    targetAgentId: string;
    content: string;
    correlationId?: string;
  }) {
    const record = await this.mailbox.sendMessage({
      graphId: args.graphId,
      sourceNodeId: args.sourceNodeId,
      sourceAgentId: args.sourceAgentId,
      sourceTaskId: args.sourceTaskId,
      targetTaskId: args.targetTaskId,
      targetNodeId: args.targetNodeId,
      targetAgentId: args.targetAgentId,
      payload: { message: args.content },
      correlationId: args.correlationId,
    });
    return {
      success: true,
      messageId: record.messageId,
      deliveryStatus: record.deliveryStatus,
      sentAt: record.sentAt,
    };
  }
}

/**
 * 14. publish_artifact (Phase 4)
 * 发布并持久化任务执行产物
 */
export class PublishArtifactTool implements Tool<{
  graphId: string;
  taskId: string;
  nodeId: string;
  name: string;
  content: string;
  contentType?: string;
}> {
  public readonly name = "publish_artifact";
  public readonly description = "Publish a named deliverable artifact (e.g. report, subtitle, JSON data) to the cluster Artifact Store.";
  public readonly parameters = {
    type: "object",
    properties: {
      graphId: { type: "string", description: "The active Graph ID" },
      taskId: { type: "string", description: "Current task ID" },
      nodeId: { type: "string", description: "Current worker node ID" },
      name: { type: "string", description: "Artifact filename" },
      content: { type: "string", description: "Text or base64 file content" },
      contentType: { type: "string", description: "MIME type (default text/plain)" },
    },
    required: ["graphId", "taskId", "nodeId", "name", "content"],
  };

  constructor(private readonly artifactService: import("../artifacts/artifact-service.js").ArtifactService) {}

  async execute(args: {
    graphId: string;
    taskId: string;
    nodeId: string;
    name: string;
    content: string;
    contentType?: string;
  }) {
    const artifact = await this.artifactService.publishArtifact({
      graphId: args.graphId,
      producerTaskId: args.taskId,
      producerNodeId: args.nodeId,
      name: args.name,
      contentType: args.contentType ?? "text/plain",
      content: args.content,
    });
    return {
      success: true,
      artifactId: artifact.artifactId,
      name: artifact.name,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      status: artifact.status,
    };
  }
}

/**
/**
 * 15. get_graph_status (Phase 4)
 * 查询整个分布式任务图的执行快照与各节点进度
 */
export class GetGraphStatusTool implements Tool<{ graphId: string }> {
  public readonly name = "get_graph_status";
  public readonly description = "Get execution progress, active tasks, and stage projections for a distributed TaskGraph.";
  public readonly parameters = {
    type: "object",
    properties: {
      graphId: { type: "string", description: "Target Graph ID" },
    },
    required: ["graphId"],
  };

  constructor(private readonly projection: import("../graph/graph-state-projection.js").GraphStateProjection) {}

  async execute(args: { graphId: string }) {
    const snapshot = await this.projection.projectGraphState(args.graphId);
    if (!snapshot) {
      return { found: false, error: `Graph '${args.graphId}' not found` };
    }
    return { found: true, snapshot };
  }
}

/**
 * 16. discover_cluster_resources (Phase 6 / Autonomous Discovery)
 * 当 Catalog 检索不足或缺少证据时，主动跨节点唤起分布式 Scout Agent 探查物理证据
 */
export class DiscoverClusterResourcesTool implements Tool<{
  query: string;
  nodeId?: string;
  timeoutMs?: number;
  recoveryOf?: { graphId: string; graphNodeId: string; reason: string };
}> {
  public readonly name = "discover_cluster_resources";
  public readonly description = "Autonomously dispatch distributed Scout Agents across cluster nodes to investigate files, metadata, and services when Catalog search is insufficient.";
  public readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords or objective to search for (e.g. 'bilibili subtitle project', 'sentiment analysis')",
      },
      nodeId: {
        type: "string",
        description: "Optional node ID to restrict discovery to a specific machine (e.g. 'node-example')",
      },
      timeoutMs: {
        type: "number",
        description: "Discovery timeout in milliseconds (default 45000)",
      },
      recoveryOf: { type: "object", description: "For a recovery investigation only: identify the failed graph node and why this Scout is needed. This does not retry or change that node.", properties: { graphId: { type: "string" }, graphNodeId: { type: "string" }, reason: { type: "string" } }, required: ["graphId", "graphNodeId", "reason"] },
    },
    required: ["query"],
  };

  constructor(
    private readonly discoveryService: import("../discovery/autonomous-discovery-service.js").AutonomousDiscoveryService,
    private readonly context?: import("../discovery/types.js").DiscoveryRunContext
  ) {}

  async execute(args: { query: string; nodeId?: string; timeoutMs?: number; recoveryOf?: { graphId: string; graphNodeId: string; reason: string } }) {
    const result = await this.discoveryService.discover(args.query, {
      nodeIds: args.nodeId ? [args.nodeId] : undefined,
      scoutTimeoutMs: args.timeoutMs,
      recoveryOf: args.recoveryOf,
    }, this.context);

    return {
      discoveryId: result.discoveryId,
      query: result.query,
      scoutCount: result.scoutReports.length,
      nodesScouted: result.scoutReports.map((r) => ({
        nodeId: r.nodeId,
        // 以服务端 outcome 为准：timed_out 的节点不得被呈现为 completed
        status: r.outcome === "completed" ? "partial" : r.outcome ?? (r.error ? "failed" : "unknown"),
        error: r.error,
        candidatesCount: r.candidates?.length ?? 0,
        summary: r.summary,
      })),
      hasErrors: result.scoutReports.some(report => Boolean(report.error) || ["failed", "timed_out", "outcome_unknown"].includes(report.outcome ?? "")),
      coverageIncomplete: true,
      warning: result.scoutReports.some((r) => Boolean(r.error))
        ? "存在探查失败或超时的节点，物理状态未确认。严禁将探查失败节点的未发现结论断言为该节点不存在目标资源！"
        : undefined,
      candidatesFound: result.aggregatedCandidates.length,
      candidates: result.aggregatedCandidates.map((c) => ({
        candidateId: c.candidateId,
        nodeId: c.nodeId,
        projectId: c.candidateProjectId,
        projectName: c.projectName,
        projectSummary: c.projectSummary,
        canonicalPath: c.canonicalPath,
        isRegistered: c.isRegistered,
        verificationStatus: c.verificationStatus,
        confidence: c.confidence,
        evidencesCount: c.evidences.length,
        topEvidence: c.evidences[0]?.matchedContent?.slice(0, 300),
        capabilities: c.relevantCapabilities.map((cap) => `${cap.name} (${cap.capabilityType})`),
      })),
      catalogUpdatesCount: result.catalogUpdatesCount,
      memoryUpdatesCount: result.memoryUpdatesCount,
      durationMs: result.durationMs,
      status: result.status,
      offlineClueNodes: result.offlineClueNodes,
      summary: result.summary,
      // Task completion alone does not establish that the requested search scope was covered.
      nodeReports: result.scoutReports.map((report) => ({
        nodeId: report.nodeId,
        taskId: report.taskId,
        outcome: report.outcome === "completed" ? "partial" : report.outcome ?? (report.error ? "failed" : "unknown"),
        stillRunning: report.stillRunning ?? false,
        candidatesFound: report.candidates.length,
        error: report.error,
        durationMs: report.durationMs,
      })),
      inconclusiveNodeIds: result.scoutReports.map((report) => report.nodeId),
      evidenceScopeNote: "目标覆盖范围尚未独立核验。只能报告实际取得的证据；空候选不能证明节点或全集群不存在目标。",
    };
  }
}

/**
 * 17. request_user_clarification (Phase 6 / Human-in-the-Loop)
 * 当存在多个合理候选且 LLM 无法唯一确定时，向用户提出明确选项并进入澄清等待
 */
export class RequestUserClarificationTool implements Tool<{
  question: string;
  options: Array<{ id: string; label: string; nodeId: string; projectId?: string; details?: string }>;
}> {
  public readonly name = "request_user_clarification";
  public readonly description = "Request user clarification when multiple genuine candidate projects or ambiguous interpretations exist.";
  public readonly parameters = {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "Clear and polite question to ask the user (e.g. '在集群中发现以下两个相关项目，请问您想分析哪一个？')",
      },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            nodeId: { type: "string" },
            projectId: { type: "string" },
            details: { type: "string" },
          },
          required: ["id", "label", "nodeId"],
        },
        description: "List of numbered or labeled options for the user to choose from",
      },
    },
    required: ["question", "options"],
  };

  private pendingClarification?: { question: string; options: any[] };

  getPendingClarification() {
    return this.pendingClarification;
  }

  async execute(args: {
    question: string;
    options: Array<{ id: string; label: string; nodeId: string; projectId?: string; details?: string }>;
  }) {
    this.pendingClarification = args;
    return {
      status: "clarification_requested",
      question: args.question,
      optionsCount: args.options.length,
      options: args.options,
      instructions: "Clarification recorded. Present this question and options to the user clearly.",
    };
  }
}

export function createClusterAgentTools(options: {
  traceId?: string;
  discoveryContext?: import("../discovery/types.js").DiscoveryRunContext;
  searchService: ClusterSearchService;
  catalogService?: CoordinatorCatalogService;
  store: IClusterStore;
  registry?: any;
  router?: import("../router/semantic-task-router.js").SemanticTaskRouter;
  discoveryService?: import("../discovery/autonomous-discovery-service.js").AutonomousDiscoveryService;
  feedbackController?: import("../router/routing-feedback-controller.js").RoutingFeedbackController;
  planner?: import("../graph/autonomous-planner.js").AutonomousPlanner;
  orchestrator?: import("../graph/graph-orchestrator.js").DistributedGraphOrchestrator;
  replanner?: import("../graph/graph-replanner.js").GraphReplanner;
  mailbox?: import("../a2a/distributed-mailbox.js").DistributedMailbox;
  artifactService?: import("../artifacts/artifact-service.js").ArtifactService;
  graphProjection?: import("../graph/graph-state-projection.js").GraphStateProjection;
  eventBus?: import("../../observability/event-bus.js").EventBus;
  abortSignal?: AbortSignal;
  onTaskDispatched?: (taskId: string, details: { nodeId?: string; projectId?: string; goal?: string }) => void | Promise<void>;
  onGraphCreated?: (graphId: string, details: { goal: string; nodeCount: number }) => void;
  scheduledEngine?: ScheduleTriggerEngine;
  coordinatorNodeId?: string;
}): Tool<any>[] {
  const tools: Tool<any>[] = [
    new SearchClusterProjectsTool(options.searchService),
    new SearchClusterCapabilitiesTool(options.searchService),
    new SearchClusterMemoryTool(options.searchService),
    new GetClusterNodeTool(options.searchService),
    new GetClusterProjectTool(options.store),
  ];

  if (options.catalogService) {
    tools.push(new SearchRemoteMemoryTool(options.catalogService));
  }

  if (options.discoveryService) {
    tools.push(new DiscoverClusterResourcesTool(options.discoveryService, options.discoveryContext));
  }

  tools.push(new RequestUserClarificationTool());

  if (options.router) {
    tools.push(new RouteClusterTaskTool(options.router));
    tools.push(
      new DispatchClusterTaskTool(
        options.router,
        options.store,
        options.eventBus,
        options.onTaskDispatched
      )
    );
  }

  tools.push(new ExplainClusterRouteTool(options.store));
  tools.push(new GetClusterTaskStatusTool(options.store));

  if (options.feedbackController) {
    tools.push(new RequestClusterReplanTool(options.feedbackController, options.store));
  }

  // Phase 4 / Adaptive Orchestration 2.0 Tools
  if (options.planner) {
    tools.push(new PlanDistributedTaskTool(options.planner, options.store));
  }
  if (options.planner && options.orchestrator) {
    tools.push(new RunDistributedTaskGraphTool(options.planner, options.orchestrator, options.onGraphCreated, { store: options.store, abortSignal: options.abortSignal, traceId: options.traceId }));
  }
  if (options.replanner && options.orchestrator) {
    tools.push(new ReplanDistributedTaskGraphTool(options.replanner, options.orchestrator, { store: options.store, abortSignal: options.abortSignal }));
  }
  if (options.mailbox) {
    tools.push(new SendAgentMessageTool(options.mailbox));
  }
  if (options.artifactService) {
    tools.push(new PublishArtifactTool(options.artifactService));
  }
  if (options.graphProjection) {
    tools.push(new GetGraphStatusTool(options.graphProjection));
  }

  // Phase 5: Scheduled Agents & Tasks Tools
  if (options.scheduledEngine) {
    tools.push(
      ...createScheduledAgentTools({
        store: options.store,
        engine: options.scheduledEngine,
        coordinatorNodeId: options.coordinatorNodeId ?? "coordinator",
      })
    );
  }

  return tools;
}

