import { PreToolSecurityMonitor } from "../../../security/security-monitor.js";
import { observeRuntimePhase } from "../../../observability/runtime-phase.js";
import { defaultTraceContext } from "../../../observability/trace-context.js";
import { annotateAnswer, evaluateEvidenceSet } from "./answer-evidence.js";
import {
  collectExecutionEvidence,
  outcomeFromTaskStatus,
  type EvidenceArtifact,
  type EvidenceKind,
  type TaskEvidenceInput,
} from "./execution-evidence.js";
import {
  buildFactAnnotation,
  buildFactCatalog,
  buildQuarantineSection,
  describeFactsForRevision,
  sanitizeAnswerFacts,
  verifyAnswerFacts,
  type FactCatalog,
  type FactVerificationResult,
  type QuarantinedClaim,
  type ToolResultFactInput,
} from "./answer-facts.js";
import type { PlannerLlmClient } from "../../graph/autonomous-planner.js";

/**
 * 中止原因 → 会话终态语义。
 *
 * 只有用户主动取消才是 "cancelled"；客户端断开与轮次超时都只是协调器停止等待，
 * 已派发的 Worker 任务继续执行，因此必须分别报告为 "detached" / "timed_out"，
 * 绝不能把断开伪装成「用户手动取消」。
 */
export function turnAbortOutcome(reason: unknown): { state: "detached" | "timed_out" | "cancelled"; message: string } {
  const text = typeof reason === "string" ? reason : String((reason as { message?: unknown } | null | undefined)?.message ?? "");
  if (text.includes("Client disconnected")) {
    return {
      state: "detached",
      message: "客户端已断开，协调器停止等待本轮回答；已派发的任务继续在 Worker 上执行，结果可在任务与会话中查看。",
    };
  }
  if (text.includes("maximum duration")) {
    return {
      state: "timed_out",
      message: "本轮超过最长执行时间，协调器已停止本轮推理；已派发的任务继续执行，结果以任务状态为准。",
    };
  }
  return { state: "cancelled", message: "任务执行已由用户手动取消。" };
}
/**
 * Coordinator Main Agent
 * LLM 驱动的集群主协调智能体
 *
 * 核心职责：
 * 1. 维持跨多轮对话上下文与意图理解；
 * 2. 主动调用集群检索、联邦记忆与分布式 Scout 探查工具；
 * 3. 语义歧义时触发结构化人机澄清 (Human-in-the-Loop)；
 * 4. 目标确定后调用确定性安全校验与任务派发；
 * 5. 产出自然语言回复，与内部执行事件彻底解耦。
 */

import * as crypto from "node:crypto";
import { runAgentLoop } from "../../../runtime/agent-loop.js";
import { ToolRegistry, ToolExecutor } from "../../../tools/index.js";
import { createClusterAgentTools, RequestUserClarificationTool } from "../../tools/cluster-tools.js";
import type { ClusterTaskRecord, IClusterStore, WebMessageRecord } from "../../storage/cluster-store.js";
import type { NodeRegistry } from "../node-registry.js";
import type { TaskScheduler } from "../task-scheduler.js";
import type { ClusterSearchService } from "../catalog/cluster-search-service.js";
import type { CoordinatorCatalogService } from "../catalog/coordinator-catalog-service.js";
import type { AutonomousDiscoveryService } from "../../discovery/autonomous-discovery-service.js";
import type { SemanticTaskRouter } from "../../router/semantic-task-router.js";
import type { RoutingFeedbackController } from "../../router/routing-feedback-controller.js";
import type { AutonomousPlanner } from "../../graph/autonomous-planner.js";
import type { DistributedGraphOrchestrator } from "../../graph/graph-orchestrator.js";
import type { GraphReplanner } from "../../graph/graph-replanner.js";
import type { DistributedMailbox } from "../../a2a/distributed-mailbox.js";
import type { ArtifactService } from "../../artifacts/artifact-service.js";
import type { GraphStateProjection } from "../../graph/graph-state-projection.js";
import type { EventBus } from "../../../observability/event-bus.js";
import type { ScheduleTriggerEngine } from "../../scheduled/schedule-trigger-engine.js";
import { getNashModelConfig, type NashModelConfig } from "../../../config/nash-config.js";
import { currentModelContext, type ProductModelContext } from "../../../product/runtime.js";

export interface CoordinatorMainAgentOptions {
  store: IClusterStore;
  registry: NodeRegistry;
  scheduler?: TaskScheduler;
  searchService: ClusterSearchService;
  catalogService?: CoordinatorCatalogService;
  discoveryService: AutonomousDiscoveryService;
  semanticRouter?: SemanticTaskRouter;
  feedbackController?: RoutingFeedbackController;
  planner?: AutonomousPlanner;
  orchestrator?: DistributedGraphOrchestrator;
  replanner?: GraphReplanner;
  mailbox?: DistributedMailbox;
  artifactService?: ArtifactService;
  graphProjection?: GraphStateProjection;
  eventBus?: EventBus;
  scheduledEngine?: ScheduleTriggerEngine;
  coordinatorNodeId?: string;
  modelConfigOverride?: Partial<NashModelConfig>;
  modelSnapshotProvider?: () => ProductModelContext | undefined;
  /** 用于「事实核验失败后重新生成有依据的答案」的轻量模型客户端；缺失时只做确定性标注。 */
  llmClient?: PlannerLlmClient;
  maxSteps?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  agentLoop?: typeof runAgentLoop;
}

export interface CoordinatorChatResult {
  assistantResponse: string;
  state: "idle" | "timeout" | "task_dispatched" | "waiting_user_clarification" | "discovery_in_progress" | "completed" | "error" | "cancelled" | "detached" | "timed_out" | "partially_completed" | "blocked" | "needs_approval" | "needs_auth" | "failed" | "incomplete";
  goalCompletionStatus?: "completed" | "partially_completed" | "blocked" | "needs_approval" | "needs_auth" | "failed" | "incomplete";
  createdTaskId?: string;
  createdGraphId?: string;
  pendingClarification?: {
    question: string;
    options: Array<{ id: string; label: string; nodeId: string; projectId?: string; details?: string }>;
  };
  durationMs: number;
  /** 最终回答的确定性证据闸门结论（不包含回答正文）。 */
  evidenceGuard?: {
    verdict: "pass" | "partial" | "unknown";
    completedNodeIds: string[];
    inconclusiveNodeIds: string[];
    reason: string;
    coverage?: {
      tasks: number;
      completedTasks: number;
      failedTasks: number;
      unknownTasks: number;
      workers: number;
      artifacts: number;
      kinds: string[];
    };
  };
  /** 最终回答的事实一致性核验结论（确定性校验，不含模型自述）。 */
  factCheck?: {
    verdict: "pass" | "violations" | "not_applicable";
    checkedClaims: number;
    violations: Array<{ claim: string; expected: string; source: string; message: string }>;
    unverifiable: Array<{ claim: string; message: string }>;
    /** 被移出正文的原始表述，供审计与人工复核。 */
    quarantined?: QuarantinedClaim[];
  };
  /** 模型本轮原始输出（未经注解与隔离处理），仅供审计，不直接展示。 */
  rawResponse?: string;
}

export class CoordinatorMainAgent {
  private readonly agentLoop: typeof runAgentLoop;
  private readonly store: IClusterStore;
  private readonly registry: NodeRegistry;
  private readonly scheduler?: TaskScheduler;
  private readonly searchService: ClusterSearchService;
  private readonly catalogService?: CoordinatorCatalogService;
  private readonly discoveryService: AutonomousDiscoveryService;
  private readonly semanticRouter?: SemanticTaskRouter;
  private readonly feedbackController?: RoutingFeedbackController;
  private readonly planner?: AutonomousPlanner;
  private readonly orchestrator?: DistributedGraphOrchestrator;
  private readonly replanner?: GraphReplanner;
  private readonly mailbox?: DistributedMailbox;
  private readonly artifactService?: ArtifactService;
  private readonly graphProjection?: GraphStateProjection;
  private readonly eventBus?: EventBus;
  private readonly scheduledEngine?: ScheduleTriggerEngine;
  private readonly coordinatorNodeId?: string;
  private readonly modelConfigOverride?: Partial<NashModelConfig>;
  private readonly optionsModelSnapshot?: () => ProductModelContext | undefined;
  private readonly maxSteps: number;
  private readonly maxToolCalls: number;
  private readonly timeoutMs: number;
  private readonly llmClient?: PlannerLlmClient;

  constructor(options: CoordinatorMainAgentOptions) {
    this.agentLoop = options.agentLoop ?? runAgentLoop;
    this.llmClient = options.llmClient;
    this.store = options.store;
    this.registry = options.registry;
    this.scheduler = options.scheduler;
    this.searchService = options.searchService;
    this.catalogService = options.catalogService;
    this.discoveryService = options.discoveryService;
    this.semanticRouter = options.semanticRouter;
    this.feedbackController = options.feedbackController;
    this.planner = options.planner;
    this.orchestrator = options.orchestrator;
    this.replanner = options.replanner;
    this.mailbox = options.mailbox;
    this.artifactService = options.artifactService;
    this.graphProjection = options.graphProjection;
    this.eventBus = options.eventBus;
    this.scheduledEngine = options.scheduledEngine;
    this.coordinatorNodeId = options.coordinatorNodeId;
    this.modelConfigOverride = options.modelConfigOverride;
    this.optionsModelSnapshot = options.modelSnapshotProvider;
    // 复用 Nash 原生 AgentLoop 预算机制，杜绝人为设窄步数导致结果丢弃
    this.maxSteps = options.maxSteps ?? 100;
    this.maxToolCalls = options.maxToolCalls ?? 150;
    // A2A 层不再给 Coordinator 叠加固定总墙钟：0 表示不设总时限，
    // 由 maxSteps / maxToolCalls、单次模型与工具超时、心跳与用户取消除共同约束。
    this.timeoutMs = options.timeoutMs ?? 0;
  }

  /**
   * 处理用户与 Coordinator 的自然多轮对话
   */
  async chat(
    conversationId: string,
    userInput: string,
    chatOptions?: {
      goalRunId?: string;
      goalTurnFence?: import("../../storage/cluster-store.js").GoalTurnFence;
      abortSignal?: AbortSignal;
      onTaskDispatched?: (taskId: string, details: { nodeId?: string; projectId?: string; goal?: string }) => void | Promise<void>;
      onScoutTaskDispatched?: (taskId: string, details: { nodeId: string; projectId: string; goal: string }) => void | Promise<void>;
      onProgress?: (progress: { phase: string; detail: string; timestamp: number }) => void;
    }
  ): Promise<CoordinatorChatResult> {
    return defaultTraceContext.run({ projectId: "coordinator", sessionId: conversationId,
      conversationId, goalRunId: chatOptions?.goalRunId, goalTurnFence: chatOptions?.goalTurnFence, traceId: crypto.randomUUID(), nodeId: this.coordinatorNodeId, modelPurpose: "agent",
      runtimeSpanSink: (span) => this.store.saveRuntimeSpan?.(span),
      modelUsageSink: (record) => this.store.saveModelUsage?.(record),
    }, () => observeRuntimePhase("goal_received", () => this.chatInContext(conversationId, userInput, chatOptions), {}, result =>
      ["cancelled", "detached", "timed_out"].includes(result.state) ? "cancelled" : ["error", "failed", "incomplete", "partially_completed", "blocked"].includes(result.state) ? "error" : "ok"));
  }

  private async chatInContext(
    conversationId: string,
    userInput: string,
    chatOptions?: {
      goalRunId?: string;
      goalTurnFence?: import("../../storage/cluster-store.js").GoalTurnFence;
      abortSignal?: AbortSignal;
      onTaskDispatched?: (taskId: string, details: { nodeId?: string; projectId?: string; goal?: string }) => void | Promise<void>;
      onScoutTaskDispatched?: (taskId: string, details: { nodeId: string; projectId: string; goal: string }) => void | Promise<void>;
      onProgress?: (progress: { phase: string; detail: string; timestamp: number }) => void;
    }
  ): Promise<CoordinatorChatResult> {
    const startTime = Date.now();
    const monotonicStart = performance.now();
    const traceId = defaultTraceContext.get()!.traceId;

    // 1. 严格模型配置校验 (Section 17: 不得静默降级为规则路由器)
    const modelSnapshot = this.optionsModelSnapshot?.() ?? currentModelContext();
    const baseConfig = modelSnapshot?.main ?? getNashModelConfig();
    const modelConfig = { ...baseConfig, ...this.modelConfigOverride };
    if (!modelConfig.apiKey || !modelConfig.baseUrl || !modelConfig.model) {
      return {
        assistantResponse:
          "【Coordinator Model Unavailable】协调器主智能体未配置有效的 LLM 模型凭据。\n" +
          "请运行 nash init，或在 Web 控制台的模型设置中配置并测试主模型。",
        state: "error",
        durationMs: performance.now() - monotonicStart,
      };
    }

    let createdTaskId: string | undefined;
    let createdGraphId: string | undefined;
    let graphExecutionAttempted = false;
    // 确定性证据采集：全部来自工具返回值，绝不采信模型文本。
    let lastGoalEvaluation: Record<string, unknown> | undefined;
    let graphNodeResults: Array<{ nodeId: string; status?: string; error?: string }> = [];
    let scoutEvidence: { nodeReports?: Array<{ nodeId: string; outcome?: string; status?: string }>; inconclusiveNodeIds?: string[]; scopeStatus?: string } | undefined;
    let graphExecutionInFlight = false;
    let graphReplanApplied = false;
    // 统一执行证据采集：任务身份、工具返回原文、产物绑定，全部来自工具返回值与持久层。
    const observedTasks = new Map<string, { kind: EvidenceKind; nodeId?: string; graphId?: string; graphNodeId?: string }>();
    const observedToolResults: ToolResultFactInput[] = [];
    let observedArtifacts: EvidenceArtifact[] = [];

    const abortController = new AbortController();
    if (chatOptions?.abortSignal) {
      if (chatOptions.abortSignal.aborted) {
        abortController.abort(chatOptions.abortSignal.reason);
      } else {
        chatOptions.abortSignal.addEventListener("abort", () => {
          abortController.abort(chatOptions.abortSignal?.reason);
        });
      }
    }
    // 2. 装配当前 Coordinator 专属工具注册中心
    const tools = createClusterAgentTools({
      traceId,
      searchService: this.searchService,
      catalogService: this.catalogService,
      store: this.store,
      registry: this.registry,
      router: this.semanticRouter,
      discoveryService: this.discoveryService,
      feedbackController: this.feedbackController,
      planner: this.planner,
      orchestrator: this.orchestrator,
      replanner: this.replanner,
      mailbox: this.mailbox,
      artifactService: this.artifactService,
      graphProjection: this.graphProjection,
      eventBus: this.eventBus,
      scheduledEngine: this.scheduledEngine,
      coordinatorNodeId: this.coordinatorNodeId,
      abortSignal: abortController.signal,
      discoveryContext: { conversationId, onTaskDispatched: chatOptions?.onScoutTaskDispatched },
      onTaskDispatched: async (taskId, details) => {
        createdTaskId = taskId;
        await chatOptions?.onTaskDispatched?.(taskId, details);
        this.emitAgentEvent("coordinator.task_dispatched", {
          conversationId,
          taskId,
          nodeId: details.nodeId,
          projectId: details.projectId,
          goal: details.goal,
        });
      },
      onGraphCreated: (graphId, details) => {
        createdGraphId = graphId;
        this.emitAgentEvent("coordinator.task_dispatched", {
          conversationId,
          graphId,
          goal: details.goal,
        });
      },
    });

    const clarificationTool = tools.find((t) => t.name === "request_user_clarification") as
      | RequestUserClarificationTool
      | undefined;

    const toolRegistry = new ToolRegistry();
    for (const tool of tools) {
      if (["plan_distributed_task", "run_distributed_task_graph"].includes(tool.name)) {
        // Goal-only Main Agent calls must go through the dedicated, capability-constrained model planner.
        const execute = tool.execute.bind(tool);
        const parameters = tool.parameters as { properties?: Record<string, unknown> };
        if (parameters.properties) delete parameters.properties.nodes;
        tool.execute = (args: Record<string, unknown>, context) => {
          const { nodes: _nodes, ...goalOnly } = args;
          if (tool.name !== "run_distributed_task_graph") return execute({ ...goalOnly, goal: userInput }, context);
          if (createdGraphId) return Promise.resolve({ success: false, error: `This goal is bound to graph ${createdGraphId}. Recover through replan_distributed_task_graph; do not replace its execution history with another graph.` });
          if (graphExecutionInFlight) return Promise.resolve({ success: false, error: "Graph planning/execution for this goal is already in progress. Do not submit a duplicate graph." });
          graphExecutionAttempted = true;
          graphExecutionInFlight = true;
          return Promise.resolve().then(() => execute({ ...goalOnly, goal: userInput }, context)).finally(() => { graphExecutionInFlight = false; });
        };
      }
      if (tool.name === "dispatch_cluster_task") {
        const execute = tool.execute.bind(tool);
        tool.execute = (args: Record<string, unknown>, context) => graphExecutionAttempted || createdGraphId
          ? Promise.resolve({ success: false, error: `This goal requires graph execution${createdGraphId ? ` (${createdGraphId})` : " but graph planning has not succeeded"}. Repair graph planning or use replan_distributed_task_graph. Standalone task completion cannot verify this goal.` })
          : execute(args, context);
      }
      if (tool.name === "replan_distributed_task_graph") {
        const execute = tool.execute.bind(tool);
        const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;
        for (const key of ["addNodes", "rewireDependencies", "reassignNodes", "retryNodeIds", "skipNodeIds"]) if (properties) delete properties[key];
        tool.execute = (args: Record<string, unknown>, context) => {
          const { addNodes, rewireDependencies, reassignNodes, retryNodeIds, skipNodeIds, ...feedback } = args;
          return execute(feedback, context);
        };
      }
      toolRegistry.register(tool);
    }

    // 工具执行后置钩子：捕获任务派发、分布式规划等关键副作用
    const toolExecutor = new ToolExecutor(toolRegistry);

    // 3. 读取会话历史以构建多轮连续上下文 (Section 11)
    let historyContext = "";
    if (this.store.getConversation) {
      try {
        const conv = await this.store.getConversation(conversationId);
        if (conv && conv.messages && conv.messages.length > 0) {
          const recent = conv.messages.slice(-8);
          historyContext = recent
            .map((m) => `[${m.sender === "user" ? "User" : "Coordinator"}]: ${m.content}`)
            .join("\n");
        }
      } catch {}
    }

    // 4. 构建主智能体 System Prompt
    const onlineNodes = this.registry.listOnlineConnections();
    const onlineSummary =
      onlineNodes.length > 0
        ? onlineNodes.map((n) => `${n.nodeId} (${n.metadata.name}, ${n.metadata.platform})`).join("; ")
        : "无在线Worker";

    const systemPrompt = `你现在是 Nash Cluster 的主协调智能体（Coordinator Main Agent）。
当前真实执行时间: ${new Date().toISOString()}；北京时间: ${new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" })}。报告日期依据本次执行时间，不能沿用历史产物或猜测日期。
当前在线节点: ${onlineSummary}

## 你的核心准则
- **语义理解驱动的调度决策 (Semantic-Driven Orchestration Decision)**：
  - **分布式任务图 (run_distributed_task_graph)**：面向任何需要多节点协同执行、全集群巡检/比对/探查、跨机器协作、或多阶段依赖流水线的场景。由 Planner 规划生成包含各节点独立并行分支的分布式 DAG 任务图，汇总节点依赖各分支成果，并在控制台实时呈现完整的 DAG 执行拓扑；
  - **单节点任务 (dispatch_cluster_task)**：面向目标明确属于单一机器、单项目、单机调试或独立局部操作；
  - **严禁单机局部任务滥用任务图**：针对明确仅需单一节点即可独立完成的单机任务（如本地写文件、跑单机测试、清理单个临时文件），坚决直接调用 dispatch_cluster_task，禁止擅自将其包装为复杂任务图；
- **防虚假否定与真实物理证据铁律 (Anti-Hallucination & Evidence Invariant)**：
  - 若任何节点或探查工具的执行状态为 failed、cancelled、timeout、遇到网络/证书异常或因人机审批超时而中断，**绝对严禁**将其空结果推导断言为“经排查该节点不存在某项目/未发现某服务”！
  - 缺少真实物理执行证据的状态属于“状态未知/探查中断”，必须如实向用户说明：“该节点因 [具体报错或审批超时] 未能完成探查，物理状态未确认”。只有在节点真正成功执行完毕且返回了有效扫描记录后，才允许向用户确认其排查结果；
- 调用 plan_distributed_task / run_distributed_task_graph 时，默认只提交用户原始 goal，由真实 Planner LLM 根据实时能力目录生成自由依赖 DAG；仅在用户明确提供 DAG 时传 nodes。不得用手写静态图替代 Planner。所有子目标必须遵守用户原始约束与禁止事项。
- 用户要求同时执行的独立探查节点应处于同一 DAG 层且互不依赖，汇总节点依赖所有分支并通过 requiredArtifacts 引用各分支真实产物。artifact_exists 验收必须有对应 producedArtifacts 声明。
- 以 goalEvaluation 的真实目标完成状态为准。目标尚未完成且仍有重规划预算、存在不突破授权的恢复路径时，应继续在原图受控重规划；不能因为已收到部分报告就停止。只有安全边界、能力、预算或不可恢复的执行证据阻止继续时才终止，并说明具体原因。被拒绝的工作区写入不能重试或提权，但可以改用本来就允许的 publish_artifact 发布产物。
- run_distributed_task_graph 会等待真实图终态并返回 nodeResults 与 goalEvaluation。图部分失败、发现新依赖或验收未通过时，可调用 replan_distributed_task_graph 对原图执行受控动态重规划（插入修复/验证节点、重连依赖或重分配节点），或者如实汇报失败与阻塞原因，禁止另起串行单任务后声称原 DAG 成功或并行完成。最终成果由你统一汇总后交付一次。
1. **自主 Agent 决策主脑**：你负责理解用户意图并统筹集群资源，而不是被动的规则调度器。
2. **通用对话直接回答**：如果用户只是打招呼（如“你好”）或咨询通用技术概念，直接用简洁专业的中文回答，绝不无意义调用集群工具或搜索节点。
3. **先查目录与记忆，按需定向核验 (Directory & Federated Memory First)**：
   - 当用户要求查找、分析或在项目上执行任务时，必须先调用 search_cluster_projects 与 search_cluster_memory 综合检索项目目录与长期联邦记忆；
   - **先复用记忆，定向核验已知目标**：
     - 若项目目录未直接命中，但联邦记忆中已存在明确的项目名称、节点归属或路径线索，**严禁盲目向全网节点发起全局 Scout 探查**！
     - 优先依据记忆线索锁定的目标节点进行定向核验（例如指定 nodeId 调用 discover_cluster_resources 进行单节点定向验证，或核验该节点项目注册与在线状态）；
     - 若记忆线索指向的目标节点当前处于离线状态 (offline)，必须明确向用户如实反馈已知节点离线，**绝对禁止无依据地遍历其他在线机器**；
   - **全网探查作为最后兜底**：仅当项目目录与联邦记忆均无有效线索、线索已彻底失效、目标仍完全不明确或用户明确要求“全网搜索/全节点扫描”时，才调用 discover_cluster_resources 扩大探查范围；
   - **执行权限隔离铁律**：记忆与 Scout 仅提供定位证据，绝不能自动获得执行权限。未在目标节点正式注册的项目严禁直接派发写或执行任务；
4. **多候选与歧义澄清**：
   - 若存在多个合理候选（例如同名项目在不同机器，或者既有独立项目又有相关 MCP 服务能力）且无法确证用户指的是哪一个，必须调用 request_user_clarification 向用户给出清晰的选项；
   - 若用户回答“第一个”、“第二个”等，依据先前的上下文准确选定目标；
5. **任务推进与调度选择**：
   - **分布式任务图模式 (run_distributed_task_graph)**：当用户需求属于多节点/全集群并行探查、跨机器协同比对、多阶段依赖流水线（Stage 1 -> Stage 2），或涉及全网整体协同目标时，坚决调用 run_distributed_task_graph 自动生成并启动自由依赖的分布式任务图，并在回复中告知用户已在“分布式任务图”页面建立实时 DAG 流；
   - **单节点任务 (dispatch_cluster_task)**：针对目标单一明确、仅需单个特定节点即可独立完成的单机开发、修改或测试；
   - **受控动态重规划 (replan_distributed_task_graph)**：当任务图出现子任务验证失败、发现新依赖或 Worker 能力变化时，使用 replan_distributed_task_graph 在原图上进行增量重规划，严禁覆盖已完成节点或自动重试 outcome_unknown 的写任务；
   - **事件驱动等待机制与后台运行防重入**：dispatch_cluster_task 会在底层自动等待远程 Worker 完成并直接返回交付成果 (finalAnswer)。若工具返回 timedOut: true 或任务仍在后台运行，说明任务已下发并在节点沙箱中持续推进中，**绝对禁止再次调用 dispatch_cluster_task 派发相同或重复的检查/清理任务，绝对禁止调用 run_distributed_task_graph**！你必须直接向用户汇报任务已在目标节点后台持续执行，告知任务 ID 与当前进展，用户可随时在任务列表中查看实时进度；
   - 拿到 Worker 结果后，将其整理提炼为高质量结构化中文报告并交付给用户；
6. **定时与周期任务识别 (Scheduled Agents & Tasks)**：
   - 当用户在日常会话中提出定时、未来某时或周期性执行需求（例如“每天早上9点检查WSL2字幕项目”、“每隔6小时检查集群节点”、“每周一分析任务失败情况”、“明天上午分析Mac项目”）：
   - 必须主动调用 create_scheduled_task 创建持久化定时任务，若用户指定了特定机器或项目（如 WSL2、Mac、Tencent），严格填入目标 nodeId / projectId；
   - 正确推算 Cron 表达式（如每天9点为 '0 9 * * *'）或间隔，绝不在当前会话中盲目忙等等待定时时刻；
   - 创建成功后，以自然中文友好向用户反馈任务名称、频率、下次计划触发时间、执行节点，并告知可随时在 Web 控制台“定时任务”页面查看详情或执行历史；
   - 当用户提出修改时间、暂停、恢复、查询执行历史或立即触发一次时，主动调用 update_scheduled_task、pause_scheduled_task、resume_scheduled_task、get_scheduled_task_history、run_scheduled_task_now 等工具；
7. **优雅交互**：
   - 永远向用户输出自然、专业、结构清晰的中文报告；
   - 绝对禁止向用户输出 routing_decision、NO_CANDIDATE、raw json 等内部事件名。`;

    const userPrompt = historyContext
      ? `=== 会话近期历史 ===\n${historyContext}\n\n=== 用户最新输入 ===\n${userInput}`
      : userInput;

    let timedOut = false;
    const timer = this.timeoutMs > 0
      ? setTimeout(() => { timedOut = true; abortController.abort(new DOMException("Coordinator deadline exceeded", "TimeoutError")); }, this.timeoutMs)
      : undefined;

    let workerFinalAnswer: string | undefined;
    let goalCompletionStatus: CoordinatorChatResult["goalCompletionStatus"];

    try {
      this.emitAgentEvent("coordinator.turn_started", {
        conversationId,
        userInput,
        timestamp: startTime,
      });

      const response = await this.agentLoop(userPrompt, {
        modelSnapshot,
        traceId,
        securityMonitor: new PreToolSecurityMonitor({ auditSink: record => this.store.saveSecurityAudit?.(record) }),
        eventBus: this.eventBus,
        registry: toolRegistry,
        executor: toolExecutor,
        systemPrompt,
        standaloneSystemPrompt: true,
        maxSteps: this.maxSteps,
        maxToolCalls: this.maxToolCalls,
        maxRunMs: this.timeoutMs,
        agentName: "CoordinatorMainAgent",
        agentType: "coordinator",
        abortSignal: abortController.signal,
        onToolCallStart: (toolName) => {
          const detail = toolName === "discover_cluster_resources" ? "正在向在线节点派发探查任务，收集项目证据…"
            : toolName.startsWith("search_") ? "正在检索项目目录、节点能力与联邦记忆…"
            : toolName === "run_distributed_task_graph" ? "正在执行分布式任务图…"
            : toolName === "replan_distributed_task_graph" ? "正在执行任务图动态重规划…"
            : "正在协调节点任务…";
          const progress = { phase: toolName === "discover_cluster_resources" ? "discovering" : "running", detail, timestamp: Date.now() };
          chatOptions?.onProgress?.(progress);
          this.emitAgentEvent("coordinator.phase", { conversationId, ...progress });
        },
        onToolCallEnd: (toolName, result) => {
          const progress = { phase: "synthesizing", detail: "已收到执行结果，正在核对证据并整理答复…", timestamp: Date.now() };
          chatOptions?.onProgress?.(progress);
          this.emitAgentEvent("coordinator.phase", { conversationId, ...progress });
          // 事实核验的来源：模型当时真实拿到的工具返回（截断到 256KiB，仅用于数值溯源）。
          const rawOutput = typeof result.output === "string"
            ? result.output
            : result.output === undefined || result.output === null
              ? ""
              : (() => { try { return JSON.stringify(result.output); } catch { return ""; } })();
          if (rawOutput) {
            observedToolResults.push({
              sourceId: `tool:${toolName}:${observedToolResults.length}`,
              sourceLabel: `工具 ${toolName} 返回`,
              text: rawOutput.length > 262144 ? rawOutput.slice(0, 262144) : rawOutput,
            });
          }
          if (toolName === "discover_cluster_resources" && result.output) {
            let parsed: any = result.output;
            if (typeof result.output === "string") {
              try { parsed = JSON.parse(result.output); } catch { parsed = null; }
            }
            if (parsed && typeof parsed === "object") {
              scoutEvidence = {
                nodeReports: Array.isArray(parsed.nodeReports) ? parsed.nodeReports : undefined,
                inconclusiveNodeIds: Array.isArray(parsed.inconclusiveNodeIds) ? parsed.inconclusiveNodeIds : undefined,
                scopeStatus: typeof parsed.scopeStatus === "string" ? parsed.scopeStatus : parsed.status,
              };
              // Scout 内部派发的任务同样进入统一证据集合，不能被排除在「已完成」之外。
              for (const report of Array.isArray(parsed.nodeReports) ? parsed.nodeReports : []) {
                if (typeof report?.taskId === "string") {
                  observedTasks.set(report.taskId, { kind: "scout", nodeId: report.nodeId, graphId: undefined, graphNodeId: undefined });
                }
              }
              if (typeof parsed.taskId === "string") {
                observedTasks.set(parsed.taskId, { kind: "scout", nodeId: parsed.nodeId, graphId: undefined, graphNodeId: undefined });
              }
            }
          }
          if ((toolName === "dispatch_cluster_task" || toolName === "run_distributed_task_graph" || toolName === "replan_distributed_task_graph") && result.output) {
            let parsed: any = result.output;
            if (typeof result.output === "string") {
              try {
                parsed = JSON.parse(result.output);
              } catch {
                parsed = null;
              }
            }
            if (parsed && typeof parsed === "object") {
              if (toolName === "replan_distributed_task_graph") graphReplanApplied = true;
              if (parsed.taskId) {
                createdTaskId = parsed.taskId;
                this.emitAgentEvent("coordinator.task_dispatched", {
                  conversationId,
                  taskId: createdTaskId,
                });
              }
              if (parsed.graphId) {
                createdGraphId = parsed.graphId;
                const traceContext = defaultTraceContext.get();
                if (traceContext) traceContext.graphId = parsed.graphId;
              }
              if (parsed.finalAnswer) {
                workerFinalAnswer = parsed.finalAnswer;
              }
              if (parsed.goalEvaluation?.completionStatus) {
                goalCompletionStatus = parsed.goalEvaluation.completionStatus;
              }
              if (parsed.goalEvaluation && typeof parsed.goalEvaluation === "object") {
                lastGoalEvaluation = parsed.goalEvaluation;
              }
              if (Array.isArray(parsed.nodeResults)) {
                graphNodeResults = parsed.nodeResults as Array<{ nodeId: string; status?: string; error?: string }>;
                for (const node of parsed.nodeResults) {
                  if (typeof node?.taskId !== "string") continue;
                  observedTasks.set(node.taskId, {
                    kind: "graph_node",
                    nodeId: typeof node.nodeId === "string" ? node.nodeId : undefined,
                    graphId: typeof parsed.graphId === "string" ? parsed.graphId : undefined,
                    graphNodeId: typeof node.nodeId === "string" ? node.nodeId : undefined,
                  });
                }
              }
              // 子 Agent 与普通任务派发：按工具身份归类，DAG 内节点以图节点身份为准。
              if (typeof parsed.taskId === "string" && !parsed.graphId) {
                const kind: EvidenceKind = toolName === "dispatch_cluster_task" ? "plain_task" : "graph_node";
                if (!observedTasks.has(parsed.taskId)) {
                  observedTasks.set(parsed.taskId, {
                    kind,
                    nodeId: typeof parsed.nodeId === "string" ? parsed.nodeId : typeof parsed.targetNodeId === "string" ? parsed.targetNodeId : undefined,
                    graphId: typeof parsed.graphId === "string" ? parsed.graphId : undefined,
                    graphNodeId: typeof parsed.graphNodeId === "string" ? parsed.graphNodeId : undefined,
                  });
                }
              }
            }
          }
        },
      });

      clearTimeout(timer);

      // 若主智能体回复过短或为空但实际已拿到 Worker 结果，将 Worker 结果保底交付
      const rawModelResponse = response;
      let finalResponse = response;
      if ((!finalResponse || finalResponse.trim().length === 0) && workerFinalAnswer) {
        finalResponse = workerFinalAnswer;
      }

      if (graphExecutionAttempted && !createdGraphId) {
        goalCompletionStatus = "incomplete";
        finalResponse = `分布式目标尚未完成：任务图未建立并通过验证。以下说明不能作为完整目标验收。\n\n${finalResponse ?? ""}`;
      } else if (createdGraphId && this.orchestrator) {
        goalCompletionStatus = (await this.orchestrator.evaluateGoalCompletion(createdGraphId)).completionStatus;
      } else if (createdTaskId) {
        const task = await this.store.getTask(createdTaskId);
        goalCompletionStatus = task?.status === "completed" ? "completed" : task?.status === "failed" ? "failed" : task?.status === "waiting_approval" ? "needs_approval" : "incomplete";
      }
      // ==== 统一执行证据集合：普通任务 / Scout / DAG 节点 / 子 Agent / Artifact ====
      const resolvedTasks: TaskEvidenceInput[] = [];
      for (const [taskId, meta] of observedTasks) {
        let record: ClusterTaskRecord | null = null;
        try { record = (await this.store.getTask?.(taskId)) ?? null; } catch { record = null; }
        resolvedTasks.push({
          taskId,
          kind: meta.kind,
          nodeId: record?.nodeId ?? meta.nodeId,
          graphId: meta.graphId ?? record?.dispatchOptions?.graphContext?.graphId,
          graphNodeId: meta.graphNodeId ?? record?.dispatchOptions?.graphContext?.graphNodeId,
          outcome: outcomeFromTaskStatus(record?.status),
          verificationStatus: record?.status === "completed" ? "verified" : "unverified",
          sourceEvent: record ? `task.${record.status}` : "dispatch.tool_result",
          createdAt: record?.createdAt,
          completedAt: record?.completedAt,
        });
      }
      if (createdGraphId && this.store.listArtifacts) {
        try {
          const listed = await this.store.listArtifacts(createdGraphId);
          observedArtifacts = listed.map((artifact) => ({
            artifactId: artifact.artifactId,
            name: artifact.name,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
            producerTaskId: artifact.producerTaskId,
            producerNodeId: artifact.producerNodeId,
            createdAt: (artifact as { createdAt?: number }).createdAt,
            graphId: artifact.graphId,
          }));
        } catch { observedArtifacts = []; }
      }
      for (const artifact of observedArtifacts) {
        const producer = resolvedTasks.find((task) => task.taskId === artifact.producerTaskId);
        if (producer) producer.artifacts = [...(producer.artifacts ?? []), artifact];
      }

      const evidenceSet = collectExecutionEvidence({
        tasks: resolvedTasks,
        graph: createdGraphId
          ? { graphId: createdGraphId, replanApplied: graphReplanApplied, completionStatus: lastGoalEvaluation?.completionStatus as string | undefined }
          : undefined,
        scout: scoutEvidence
          ? {
            scopeStatus: scoutEvidence.scopeStatus,
            inconclusiveNodeIds: scoutEvidence.inconclusiveNodeIds,
            nodeReports: (scoutEvidence.nodeReports ?? []).map((report) => ({ nodeId: report.nodeId, outcome: report.outcome, status: report.status })),
          }
          : undefined,
        onlineNodeIds: this.registry.listOnlineConnections().map((conn) => conn.nodeId),
        turn: { graphExecutionAttempted, graphCreated: Boolean(createdGraphId) },
      });
      // 确定性证据闸门：仅在存在执行证据时生效，pass 路径零改动。
      const evidenceGuard = evaluateEvidenceSet(evidenceSet);

      // ==== 事实一致性核验：回答里的确定性数字必须能追溯到执行记录或本轮产物 ====
      // 真实 E2E 已出现「产物写 1793177600…，回答写 1793177811…」的事实不一致，
      // 这类问题无法靠措辞检查发现，必须用带来源的结构化事实目录判定。
      const factCatalog = buildFactCatalog({ evidence: evidenceSet, toolResults: observedToolResults });
      let factCheck: FactVerificationResult = verifyAnswerFacts(finalResponse ?? "", factCatalog);
      if (factCheck.violations.length > 0 && this.llmClient) {
        const revised = await this.reviseAnswerWithFacts(finalResponse ?? "", factCheck, factCatalog, abortController.signal);
        if (revised) {
          const recheck = verifyAnswerFacts(revised, factCatalog);
          // 只在「更少冲突」时采用重生成结果，避免修正反而引入新错误。
          if (recheck.violations.length <= factCheck.violations.length) {
            finalResponse = revised;
            factCheck = recheck;
          }
        }
      }
      let quarantinedClaims: QuarantinedClaim[] = [];
      if (factCheck.violations.length > 0) {
        // 已被执行证据确定性证伪的断言不允许继续作为正常正文展示：
        // 从正文移除并隔离到核验详情；原始模型输出另存审计字段，不丢证据。
        const { sanitized, quarantined } = sanitizeAnswerFacts(finalResponse ?? "", factCheck);
        quarantinedClaims = quarantined;
        const section = buildQuarantineSection(quarantined, factCheck.unverifiable) ?? buildFactAnnotation(factCheck);
        finalResponse = [
          section,
          sanitized || "（原始回答中可核验的断言均与执行记录冲突，已全部移入上方核验详情。）",
        ].filter(Boolean).join("\n\n").trim();
      }

      if (evidenceGuard.verdict !== "pass") {
        finalResponse = annotateAnswer(finalResponse, evidenceGuard);
        if (!goalCompletionStatus || goalCompletionStatus === "completed") {
          goalCompletionStatus = evidenceGuard.verdict === "partial" ? "partially_completed" : "incomplete";
        }
      }

      const pendingClarification = clarificationTool?.getPendingClarification();
      let state: CoordinatorChatResult["state"] = "idle";
      if (pendingClarification) state = "waiting_user_clarification";
      else if (goalCompletionStatus && goalCompletionStatus !== "completed") state = goalCompletionStatus;
      else if (finalResponse?.trim()) state = "completed";
      else if (createdTaskId || createdGraphId) state = "task_dispatched";
      if (!goalCompletionStatus && state === "completed") goalCompletionStatus = "completed";

      const durationMs = performance.now() - monotonicStart;
      this.emitAgentEvent("coordinator.turn_completed", {
        conversationId,
        state,
        goalCompletionStatus,
        createdTaskId,
        createdGraphId,
        durationMs,
      });

      return {
        assistantResponse: finalResponse,
        state,
        goalCompletionStatus,
        createdTaskId,
        createdGraphId,
        pendingClarification,
        durationMs,
        evidenceGuard: {
          verdict: evidenceGuard.verdict,
          completedNodeIds: evidenceGuard.completedNodeIds,
          inconclusiveNodeIds: evidenceGuard.inconclusiveNodeIds,
          reason: evidenceGuard.reason,
          coverage: evidenceGuard.coverage,
        },
        factCheck: {
          verdict: factCheck.verdict,
          checkedClaims: factCheck.checkedClaims,
          violations: factCheck.violations.map((item) => ({ claim: item.claim, expected: item.expected, source: item.source, message: item.message })),
          unverifiable: factCheck.unverifiable.map((item) => ({ claim: item.claim, message: item.message })),
          quarantined: quarantinedClaims,
        },
        rawResponse: rawModelResponse,
      };
    } catch (err: any) {
      clearTimeout(timer);
      const isCancelled = Boolean(chatOptions?.abortSignal?.aborted);
      const isTimeout = timedOut && !isCancelled;
      const durationMs = performance.now() - monotonicStart;

      // 核心韧性保障：即使 Coordinator 主推理中途超时或遇到异常，绝不能丢失已完成的 Worker 成果
      if (graphExecutionAttempted && !createdGraphId) goalCompletionStatus = "incomplete";
      if (workerFinalAnswer) {
        return {
          assistantResponse: `【Worker 执行已完成，成果交付】\n${workerFinalAnswer}`,
          state: goalCompletionStatus && goalCompletionStatus !== "completed" ? goalCompletionStatus : "completed",
          goalCompletionStatus,
          createdTaskId,
          createdGraphId,
          durationMs,
        };
      }

      // 中止原因决定会话终态语义：客户端断开 / 轮次超时只停止「协调器等待」，
      // 已派发的 Worker 任务继续执行，因此绝不能伪装成用户手动取消。
      if (isCancelled) {
        const outcome = turnAbortOutcome(chatOptions?.abortSignal?.reason);
        return {
          assistantResponse: outcome.message,
          state: outcome.state,
          createdTaskId,
          createdGraphId,
          durationMs,
        };
      }

      // 核心韧性：若已成功派发了远程任务，即使 Coordinator 推理中途超时或由于长耗时任务挂起，只要任务仍在 Worker 端运行，不应判定为失败报错
      if (createdTaskId) {
        try {
          const task = await this.store.getTask(createdTaskId);
          if (task && (task.status === "running" || task.status === "dispatched")) {
            return {
              assistantResponse: `分布式任务已成功派发至节点执行（任务 ID: \`${createdTaskId}\`），后台正在持续运行探查中，完成后将在此自动呈现实时成果。`,
              state: "task_dispatched",
              createdTaskId,
              createdGraphId,
              durationMs,
            };
          }
        } catch {}
      }

      const errorMsg = isTimeout
        ? "协调器推理处理超时，请尝试简化任务或稍后重试。"
        : `协调器主智能体执行遇到异常: ${err.message || String(err)}`;

      return {
        assistantResponse: errorMsg,
        state: isTimeout ? "timeout" : "error",
        createdTaskId,
        createdGraphId,
        durationMs,
      };
    }
  }

  /**
   * 事实核验失败后的有界重生成。
   *
   * 只允许模型「按执行记录更正数字」，不允许它改用新的结论；重生成结果仍要再核验一次，
   * 核验不通过时调用方会退回确定性标注，绝不把未确认的断言当成已验证事实输出。
   */
  private async reviseAnswerWithFacts(
    answer: string,
    check: FactVerificationResult,
    catalog: FactCatalog,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    if (!this.llmClient || signal?.aborted) return undefined;
    const facts = describeFactsForRevision(catalog);
    if (!facts) return undefined;
    const violations = check.violations
      .map((item) => `- “${item.claim}”：${item.message} 真实值：${item.expected}`)
      .join("\n");
    const messages = [
      {
        role: "system",
        content: "你是事实校正器。只修正与真实执行记录冲突的数字断言，保留原文结构、结论与语气，"
          + "不得新增任何未被证据支持的事实，也不得删除证据范围说明。",
      },
      {
        role: "user",
        content: `【真实执行记录】\n${facts}\n\n【原文中与记录冲突的断言】\n${violations}\n\n`
          + `【待修正的回答】\n${answer}\n\n请直接输出修正后的完整回答（纯文本，不要解释修改过程）。`,
      },
    ];
    try {
      const call = this.llmClient.chat
        ? this.llmClient.chat(messages).then((response) => response?.content ?? undefined)
        : this.llmClient.complete
          ? this.llmClient.complete(messages).then((response) => response?.message?.content ?? undefined)
          : Promise.resolve(undefined);
      const timeout = new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 60_000);
        timer.unref?.();
      });
      const content = await Promise.race([call, timeout]);
      const trimmed = typeof content === "string" ? content.trim() : "";
      return trimmed || undefined;
    } catch {
      return undefined;
    }
  }

  private emitAgentEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: "coordinator",
        sessionId: "main-coordinator",
        data,
      });
    }
  }
}
