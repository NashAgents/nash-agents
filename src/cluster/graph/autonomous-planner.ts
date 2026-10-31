import { observeRuntimePhase } from "../../observability/runtime-phase.js";
import { callChatCompletions, type ChatMessage } from "../../model/chat-completions-client.js";
import type { ModelCallOptions } from "../../observability/model-usage.js";
import { getNashModelConfig } from "../../config/nash-config.js";
import { currentModelContext, withProductModels, type ProductModelContext } from "../../product/runtime.js";
/**
 * Autonomous Task Planner (Adaptive Multi-Agent Orchestration 2.0)
 * 负责单 Agent / 多 Agent 自主决策、可解释证据生成、确定性 Fast Path 与混合串并行 DAG 规划
 */

import { DagValidator } from "./dag-validator.js";
import { TaskIntentAnalyzer } from "../router/intent-analyzer.js";
import { RoutingValidator } from "../router/routing-validator.js";
import type { IClusterStore, ClusterNodeRecord } from "../storage/cluster-store.js";
import type {
  GraphBudget,
  GraphProposal,
  GraphProposalNode,
  TaskGraphValidationResult,
  ExecutionStrategyDecision,
  RequiredSandboxPolicy,
} from "./types.js";

export interface PlannerLlmClient {
  chat?(
    messages: Array<{ role: string; content: string }>,
    tools?: unknown[],
    options?: ModelCallOptions
  ): Promise<{ content?: string | null }>;
  complete?(
    messages: Array<{ role: string; content: string }>
  ): Promise<{ message: { content?: string | null } }>;
}

export interface AutonomousPlannerOptions {
  store?: IClusterStore;
  searchService?: unknown;
  llmClient?: PlannerLlmClient;
  validator?: Pick<RoutingValidator, "validateCandidate">;
}

export interface PlanGoalContext {
  store?: IClusterStore;
  useLlmPlanner?: boolean;
  preferredNodeId?: string;
  preferredProjectId?: string;
}

interface TargetSubgoalSpec {
  key: string;
  label: string;
  nodeId?: string;
  projectId?: string;
  platform?: "darwin" | "linux" | "win32";
  operation: "analyze" | "execute" | "verify" | "synthesize";
  subGoalText: string;
  requiredCapabilities: string[];
}

export class AutonomousPlanner {
  private readonly intentAnalyzer = new TaskIntentAnalyzer();
  private readonly store?: IClusterStore;
  private readonly llmClient?: PlannerLlmClient;
  private readonly validator?: Pick<RoutingValidator, "validateCandidate">;

  constructor(options?: AutonomousPlannerOptions) {
    this.store = options?.store;
    this.llmClient = options?.llmClient;
    this.validator = options?.validator;
  }

  /**
   * 当前是否有可用的规划模型。没有模型时只能走有界的确定性回退，
   * 但绝不能把「模型失败」也当成回退理由。
   */
  private plannerLlm(context?: PlanGoalContext): PlannerLlmClient | null {
    if (context?.useLlmPlanner === false) return null;
    return this.llmClient ?? AutonomousPlanner.createDefaultLlmClient() ?? null;
  }

  /**
   * 评估应该采用 Single-Agent Execution 还是 Multi-Agent Orchestration，
   * 并生成完整的可解释决策证据（用于内部诊断、安全审计与 Web 展示）。
   */
  async evaluateExecutionStrategy(
    userGoal: string,
    context?: PlanGoalContext
  ): Promise<ExecutionStrategyDecision> {
    return observeRuntimePhase("strategy", async () => {
    const cleanGoal = userGoal.trim();
    const lower = cleanGoal.toLowerCase();
    const activeStore = context?.store ?? this.store;
    const intent = this.intentAnalyzer.analyze(cleanGoal, undefined, activeStore ? await activeStore.listNodes() : []);

    // 识别正向提及的目标端点/平台组
    const targetGroups = this.extractDistinctTargetGroups(cleanGoal, lower, intent);
    const hasCrossProjectSignal =
      intent.projectHints.length > 1 ||
      /(?:跨项目|多个项目|两个项目|三个项目|各项目|导入.*项目|同步到.*项目)/i.test(cleanGoal);
    const hasMultiStagePipeline =
      /(?:并行|同时|分别).*(?:汇总|对比|合并|比较|整合|综合)/i.test(cleanGoal) ||
      (/(?:提取|采集|抓取).*(?:导入|写入|转换).*(?:修复|测试|验证)/i.test(cleanGoal)) ||
      (/(?:定位|排查|分析|检查).*(?:修复|修改|解决).*(?:测试|验证|回归)/i.test(cleanGoal)) ||
      (targetGroups.length >= 2 &&
        /(?:找出|对比|比较|汇总|综合|分析|检查|提出|修复|验证)/i.test(cleanGoal));

    // 计算任务复杂度分值 (0 ~ 100)
    let complexityScore = 20;
    if (targetGroups.length >= 2) complexityScore += (targetGroups.length - 1) * 25;
    if (hasCrossProjectSignal) complexityScore += 25;
    if (hasMultiStagePipeline) complexityScore += 20;
    if (intent.requiredCapabilities.length > 0) complexityScore += intent.requiredCapabilities.length * 10;
    if (!intent.constraints.readOnly && (intent.operation === "fix" || intent.operation === "deploy")) {
      complexityScore += 10;
    }
    complexityScore = Math.min(100, complexityScore);

    // 收集在线节点与候选评估证据
    const selectedWorkers: ExecutionStrategyDecision["selectedWorkers"] = [];
    const rejectedWorkers: ExecutionStrategyDecision["rejectedWorkers"] = [];
    const requiredTargets: NonNullable<ExecutionStrategyDecision["requiredTargets"]> = [];
    const scopeErrors: string[] = [];
    let catalogSnapshot: ExecutionStrategyDecision["catalogSnapshot"];

    if (activeStore) {
      const startedAt = Date.now();
      const nodes = await activeStore.listNodes();
      const projects = await activeStore.listProjectsCatalog();
      const observed: NonNullable<ExecutionStrategyDecision["catalogSnapshot"]>["nodes"] = [];
      // 用户显式点名的节点与显式声明的节点数量，都是「执行范围」而非「派发方式」。
      // 这里只把它变成可核验的覆盖要求，最终仍由 LLM 规划、Runtime 校验。
      this.mergeExplicitNodeScope(cleanGoal, nodes, targetGroups, scopeErrors);
      for (const group of targetGroups) requiredTargets.push({ key: group.key, platform: group.platform, label: group.label,
        nodeId: group.nodeId, source: group.key.startsWith("node:") ? "named_node" : group.key.startsWith("count:") ? "cardinality" : group.projectId ? "project" : "platform",
        candidateNodeIds: nodes.filter((n) => this.matchesTargetGroup(n, group)).map((n) => n.nodeId) });

      for (const node of nodes) {
        const nodeProjects = projects.filter((p) => p.nodeId === node.nodeId && p.status === "active");
        const primaryProject = nodeProjects[0];
        const catRev = await activeStore.getCatalogRevision(node.nodeId);
        observed.push({ nodeId: node.nodeId, status: node.status, catalogRevision: catRev?.revision, projectIds: nodeProjects.map(project => project.projectId).sort() });
        const sandboxCap = (catRev?.capabilities ?? []).find((c) => c.category === "sandbox");

        if (node.status !== "online") {
          rejectedWorkers.push({
            nodeId: node.nodeId,
            projectId: primaryProject?.projectId,
            reason: `Node '${node.name || node.nodeId}' is currently ${node.status}.`,
          });
          continue;
        }

        // 检查 Windows Native 受限沙箱约束
        const requiresWriteIsolation = !intent.constraints.readOnly && intent.operation === "fix";
        if (
          node.platform === "win32" &&
          requiresWriteIsolation &&
          sandboxCap?.structuredDetails?.filesystemIsolationVerified === false
        ) {
          rejectedWorkers.push({
            nodeId: node.nodeId,
            projectId: primaryProject?.projectId,
            reason:
              "Windows Native sandbox filesystem write isolation is unverified for workspace-write tasks; restricted write tasks require verified sandbox or read-only inspection.",
          });
          continue;
        }

        const matchedGroup = targetGroups.find((g) => this.matchesTargetGroup(node, g));

        if (targetGroups.length > 0 && !matchedGroup) {
          rejectedWorkers.push({
            nodeId: node.nodeId,
            projectId: primaryProject?.projectId,
            reason: `Node '${node.nodeId}' (${node.platform}) is not targeted by the current goal constraints.`,
          });
          continue;
        }

        selectedWorkers.push({
          nodeId: node.nodeId,
          projectId: primaryProject?.projectId,
          reason: matchedGroup
            ? `Matched target '${matchedGroup.label}' on platform ${node.platform} with active catalog.`
            : `Online worker (${node.platform}/${node.arch}) satisfying capability and sandbox constraints.`,
          score: matchedGroup ? 0.92 : 0.78,
        });
      }
      catalogSnapshot = { startedAt, completedAt: Date.now(), consistency: "sequential", nodes: observed };
    } else {
      for (const group of targetGroups) {
        if (group.nodeId) {
          selectedWorkers.push({
            nodeId: group.nodeId,
            projectId: group.projectId,
            reason: `Matched target platform/node '${group.label}' from goal analysis.`,
            score: 0.9,
          });
        }
      }
    }

    // 语义决策属于 LLM：这里只做「是否存在可验证的多目标结构」的事实统计，
    // 供展示与 Planner LLM 参考。fastPath 不再由关键词决定——
    // 只有当调用方已经把目标显式收敛到单一节点/项目时，才可以跳过 LLM 规划。
    const requiresMultiAgent =
      targetGroups.length >= 2 || hasCrossProjectSignal || hasMultiStagePipeline;

    const explicitSingleBinding = Boolean(
      context?.preferredNodeId || intent.constraints.explicitNodeId
    ) && targetGroups.length <= 1 && !hasCrossProjectSignal && !hasMultiStagePipeline;

    const fastPath = explicitSingleBinding;
    const estimatedSubtasks = requiresMultiAgent
      ? Math.max(3, targetGroups.length + (/(?:修复|修改|fix)/i.test(cleanGoal) ? 2 : 1))
      : 1;
    const estimatedCoordinationOverhead: "low" | "medium" | "high" =
      !requiresMultiAgent ? "low" : estimatedSubtasks <= 4 ? "medium" : "high";

    const reason = requiresMultiAgent
      ? `Multi-Agent Orchestration selected (complexity=${complexityScore}): detected ${
          targetGroups.length >= 2
            ? `${targetGroups.length} distinct target environments (${targetGroups.map((g) => g.label).join(", ")})`
            : hasCrossProjectSignal
              ? `cross-project dependencies (${intent.projectHints.join(", ")})`
              : "multi-stage parallel/join workflow"
        }. Parallel branch execution with Join Barrier minimizes wall-clock latency and isolates node contexts.`
      : `Single-Agent Fast Path selected (complexity=${complexityScore}): goal targets a single coherent scope (${
          targetGroups[0]?.label ?? intent.projectHints[0] ?? "default workspace"
        }) with low coordination overhead.`;

    return {
      mode: requiresMultiAgent ? "multi_agent" : "single_agent",
      fastPath,
      complexityScore,
      reason,
      requiredCapabilities: intent.requiredCapabilities,
      selectedWorkers,
      rejectedWorkers,
      requiredTargets,
      ...(catalogSnapshot ? { catalogSnapshot } : {}),
      ...(scopeErrors.length > 0 ? { scopeErrors } : {}),
      estimatedSubtasks,
      estimatedCoordinationOverhead,
      evaluatedAt: Date.now(),
    };
    });
  }

  /**
   * 判断是否应该走单任务快速通道 (Single Task Fast Path)
   */
  isSingleTaskFastPath(userGoal: string): boolean {
    const cleanGoal = userGoal.trim();
    const lower = cleanGoal.toLowerCase();
    const intent = this.intentAnalyzer.analyze(cleanGoal);
    const targetGroups = this.extractDistinctTargetGroups(cleanGoal, lower, intent);
    const hasCrossProjectSignal =
      intent.projectHints.length > 1 ||
      /(?:跨项目|多个项目|两个项目|三个项目|导入.*项目)/i.test(cleanGoal);
    const hasMultiStagePipeline =
      /(?:并行|同时|分别).*(?:汇总|对比|合并|比较|整合|综合)/i.test(cleanGoal) ||
      /(?:提取|采集|抓取).*(?:导入|写入|转换).*(?:修复|测试|验证)/i.test(cleanGoal) ||
      (targetGroups.length >= 2 &&
        /(?:找出|对比|比较|汇总|综合|分析|检查|提出|修复|验证)/i.test(cleanGoal));

    return !(targetGroups.length >= 2 || hasCrossProjectSignal || hasMultiStagePipeline);
  }

  /**
   * 根据用户目标生成验证通过的 GraphProposal
   */
  async planGoal(
    userGoal: string,
    customBudget?: Partial<GraphBudget>,
    proposedNodes?: GraphProposalNode[],
    context?: PlanGoalContext
  ): Promise<{ proposal: GraphProposal; validation: TaskGraphValidationResult }> {
    const cleanGoal = userGoal.trim();
    const strategyDecision = await this.evaluateExecutionStrategy(cleanGoal, context);

    let proposal: GraphProposal;
    if (proposedNodes && proposedNodes.length > 0) {
      const normalizedNodes = this.normalizeExplicitNodes(cleanGoal, proposedNodes);
      const effectiveDecision: ExecutionStrategyDecision = {
        ...strategyDecision,
        mode: normalizedNodes.length > 1 ? "multi_agent" : "single_agent",
        fastPath: normalizedNodes.length === 1,
        estimatedSubtasks: normalizedNodes.length,
      };
      proposal = {
        parentGoal: cleanGoal,
        reasoning: `Explicit semantic TaskGraph provided (${normalizedNodes.length} nodes). ${effectiveDecision.reason}`,
        requiresMultiAgent: normalizedNodes.length > 1,
        budget: customBudget,
        nodes: normalizedNodes,
        strategyDecision: effectiveDecision,
      };
    } else if (strategyDecision.fastPath || (!this.plannerLlm(context) && strategyDecision.mode === "single_agent")) {
      // 只有调用方显式绑定单一目标才算 fast_path；无规划模型时的确定性退化要如实标注。
      strategyDecision.planningSource = strategyDecision.fastPath ? "fast_path" : "deterministic_fallback";
      const intent = this.intentAnalyzer.analyze(cleanGoal);
      const defaultPolicy = this.deriveSandboxPolicy(
        intent.constraints.readOnly ? "analyze" : "execute",
        cleanGoal
      );
      proposal = {
        parentGoal: cleanGoal,
        reasoning: strategyDecision.reason,
        requiresMultiAgent: false,
        budget: customBudget,
        strategyDecision,
        nodes: [
          {
            nodeId: "task_1",
            title: cleanGoal.slice(0, 60),
            goal: cleanGoal,
            description: cleanGoal,
            operation: intent.constraints.readOnly ? "analyze" : "execute",
            candidateNodeId: context?.preferredNodeId ?? intent.constraints.explicitNodeId ?? strategyDecision.selectedWorkers[0]?.nodeId,
            candidateProjectId: context?.preferredProjectId ?? intent.constraints.explicitProjectId
              ?? strategyDecision.selectedWorkers.find((w) => w.nodeId === (context?.preferredNodeId ?? intent.constraints.explicitNodeId ?? strategyDecision.selectedWorkers[0]?.nodeId))?.projectId,
            explicitNodePinned: Boolean(intent.constraints.explicitNodeId),
            dependencies: [],
            requiredCapabilities: intent.requiredCapabilities,
            requiredSandboxPolicy: defaultPolicy,
            expectedOutputs: ["final_answer"],
            acceptanceCriteria: [],
            failurePolicy: "cancel_graph",
            retryClassification: intent.constraints.readOnly ? "transient" : "none",
          },
        ],
      };
    } else {
      // Static synthesis is an explicit simulation mode; runtime model failures stay visible.
      let decomposedNodes: GraphProposalNode[] | null = null;
      const llmAvailable = Boolean(this.plannerLlm(context));
      const llmResult = llmAvailable
        ? await this.tryLlmDecomposition(cleanGoal, strategyDecision, context)
        : null;
      if (llmResult && llmResult.nodes.length > 0) {
        decomposedNodes = llmResult.nodes;
        strategyDecision.planningSource = "llm";
        strategyDecision.planningDurationMs = llmResult.durationMs;
        strategyDecision.planningModel = llmResult.model;
        if (llmResult.usage) {
          strategyDecision.planningTokens = {
            promptTokens: llmResult.usage.prompt_tokens ?? 0,
            completionTokens: llmResult.usage.completion_tokens ?? 0,
            totalTokens: llmResult.usage.total_tokens ?? 0,
          };
        }
      } else if (!llmAvailable) {
        decomposedNodes = await this.synthesizeMultiAgentNodes(cleanGoal, strategyDecision, context);
        strategyDecision.planningSource = "synthesizer_fallback";
      } else {
        decomposedNodes = [];
      }
      proposal = {
        parentGoal: cleanGoal,
        reasoning: strategyDecision.reason,
        requiresMultiAgent: decomposedNodes.length > 1,
        budget: customBudget,
        nodes: decomposedNodes,
        strategyDecision,
      };
    }

    let validation = proposal.nodes.length === 0 && strategyDecision.planningError
      ? { valid: false, reason: strategyDecision.planningError }
      : DagValidator.validateProposal(proposal.nodes, proposal.budget);
    if (validation.valid && context?.useLlmPlanner !== false) {
      const constraintErrors = await this.validatePlanConstraints(proposal.nodes, context);
      if (constraintErrors.length) validation = { valid: false, reason: constraintErrors.join("; ") };
    }
    // 用户显式要求的范围无法被满足时，必须明确说明，而不是用一个更小的计划冒充完成。
    if (strategyDecision.scopeErrors?.length) {
      validation = { valid: false, reason: `PLANNING_SCOPE_UNSATISFIED: ${strategyDecision.scopeErrors.join("; ")}` };
    }
    if (validation.valid) {
      const coverageErrors = this.validateTargetCoverage(proposal.nodes, strategyDecision.requiredTargets ?? []);
      if (coverageErrors.length) validation = { valid: false, reason: coverageErrors.join("; ") };
    }
    return { proposal, validation };
  }

  async planningCapabilities(context?: PlanGoalContext): Promise<unknown[]> {
    const store = context?.store ?? this.store;
    if (!store) return [];
    return Promise.all((await store.listNodes()).map(async (node) => ({
      nodeId: node.nodeId, name: node.name, platform: node.platform, arch: node.arch,
      online: node.status === "online", lastSeenAt: node.lastSeenAt,
      catalog: await store.getCatalogRevision(node.nodeId),
      projects: await store.listProjectsCatalog({ nodeId: node.nodeId }),
      skills: (await store.listSkillsCatalog({ nodeId: node.nodeId })).map((s) => ({ skillId: s.skillId, name: s.name })),
    })));
  }

  async validatePlanConstraints(nodes: GraphProposalNode[], context?: PlanGoalContext): Promise<string[]> {
    return observeRuntimePhase("plan_validation", async () => {
    const store = context?.store ?? this.store;
    const validator = this.validator ?? (store ? new RoutingValidator(store) : undefined);
    if (!validator) return ["PLANNING_CONSTRAINT_VIOLATION: verified worker catalog is unavailable"];
    const errors: string[] = [];
    for (const node of nodes) {
      if (node.requiredSandboxPolicy !== undefined && (typeof node.requiredSandboxPolicy !== "object" || node.requiredSandboxPolicy === null || Array.isArray(node.requiredSandboxPolicy))) {
        errors.push(`${node.nodeId}: PLANNING_CONSTRAINT_VIOLATION: requiredSandboxPolicy must be an object`); continue;
      }
      if (!node.candidateNodeId || !node.candidateProjectId) {
        errors.push(`${node.nodeId}: PLANNING_CONSTRAINT_VIOLATION: an exact authorized worker and project are required`);
        continue;
      }
      if (node.requiredSandboxPolicy?.filesystemMode === "danger-full-access" || node.requiredSandboxPolicy?.networkMode === "allow") {
        errors.push(`${node.nodeId}: PLANNING_CONSTRAINT_VIOLATION: model cannot expand sandbox or network authorization`);
        continue;
      }
      const check = await validator.validateCandidate({ nodeId: node.candidateNodeId, projectId: node.candidateProjectId }, {
        constraints: { readOnly: node.operation === "analyze" || node.operation === "synthesize",
          requiredPolicy: { filesystem: node.requiredSandboxPolicy?.filesystemMode, network: node.requiredSandboxPolicy?.networkMode } },
        requiredCapabilities: node.requiredCapabilities ?? [],
      });
      if (!check.valid) errors.push(`${node.nodeId}: ${check.code}: ${check.reason}`);
    }
    return errors;
    });
  }

  private normalizeExplicitNodes(userGoal: string, proposedNodes: GraphProposalNode[]): GraphProposalNode[] {
    const conciseParentConstraint =
      userGoal.length <= 320 ? userGoal : `${userGoal.slice(0, 320)}...`;
    return proposedNodes.map((node) => {
      const op = node.operation ?? "execute";
      const goalWithConstraint = node.goal.includes(userGoal) || node.goal.includes(conciseParentConstraint)
        ? node.goal
        : `${node.goal}\n\n[Parent Goal Constraint: ${conciseParentConstraint}]`;
      return {
        ...node,
        operation: op,
        description: node.description ?? node.title,
        goal: goalWithConstraint,
        explicitNodePinned: node.explicitNodePinned ?? Boolean(node.candidateNodeId),
        requiredSandboxPolicy: node.requiredSandboxPolicy ?? this.deriveSandboxPolicy(op, node.goal),
        acceptanceCriteria:
          node.acceptanceCriteria && node.acceptanceCriteria.length > 0
            ? node.acceptanceCriteria
            : (node.producedArtifacts ?? []).map((art) => ({
                type: "artifact_exists" as const,
                description: `Produced artifact '${art.name}' must exist`,
                expected: art.name,
              })),
        failurePolicy: node.failurePolicy ?? "block_dependents",
        retryClassification:
          node.retryClassification ?? (op === "analyze" || op === "verify" ? "reassignable" : "none"),
      };
    });
  }

  private deriveSandboxPolicy(
    operation: "execute" | "analyze" | "verify" | "synthesize",
    goalText: string
  ): RequiredSandboxPolicy {
    const lower = goalText.toLowerCase();
    const isReadOnly =
      operation === "analyze" ||
      operation === "synthesize" ||
      lower.includes("只读") ||
      lower.includes("不要修改") ||
      lower.includes("read-only");
    return {
      filesystemMode: isReadOnly ? "read-only" : "workspace-write",
      networkMode: lower.includes("network-allow") || lower.includes("联网") ? "allow" : "deny",
      approvalMode: "ask",
    };
  }

  private isNegated(lower: string, keyword: string): boolean {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(?:不|不要|禁止|无需|不用|(?<!分)别|切勿|not\\s+|without\\s+)(?:访问|使用|调用|去|在|检查|修改|连接|触碰|动)?\\s*${escaped}`,
      "i"
    );
    return re.test(lower);
  }

  private matchesTargetGroup(node: Pick<ClusterNodeRecord, "nodeId" | "name" | "platform">, group: TargetSubgoalSpec): boolean {
    // 点名到具体节点时只认该节点；否则同平台的其他节点会被算作已覆盖，覆盖校验形同虚设。
    if (group.nodeId) return group.nodeId === node.nodeId;
    const name = `${node.nodeId} ${node.name ?? ""} ${(node as { hostname?: string }).hostname ?? ""}`.toLowerCase();
    if (group.key === "mac") return node.platform === "darwin";
    if (group.key === "windows") return node.platform === "win32";
    if (group.key === "wsl") return node.platform === "linux" && /wsl|subsystem/.test(name);
    if (group.key === "cloud") return node.platform === "linux" && /tencent|cloud|server|腾讯|云端|服务器/.test(name);
    return Boolean(group.platform && group.platform === node.platform);
  }

  /**
   * 把「用户点名的节点」与「用户声明的节点数量」并入目标组。
   *
   * 这是执行范围声明，不是派发规则：这里只产出可核验的覆盖要求，
   * 具体节点仍由 LLM 规划、由 validateTargetCoverage 与 DagValidator 校验。
   */
  private mergeExplicitNodeScope(
    raw: string,
    nodes: ClusterNodeRecord[],
    groups: TargetSubgoalSpec[],
    errors: string[]
  ): void {
    const lower = raw.toLowerCase();
    const online = nodes.filter((node) => node.status === "online");
    const mentioned: ClusterNodeRecord[] = [];
    for (const node of nodes) {
      // 用户通常用主机名（node0/node1/node3）或节点名点名，两者都必须能对上已注册节点。
      const aliases = [node.name, node.hostname, node.nodeId]
        .filter((alias): alias is string => Boolean(alias) && alias.length >= 3)
        .map((alias) => alias.toLowerCase());
      const hit = aliases.find((alias) =>
        new RegExp(`(?<![a-z0-9_-])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_-])`, "i").test(raw)
        && !this.isNegated(lower, alias));
      if (hit) mentioned.push(node);
    }

    const requested = this.extractRequestedNodeCount(raw);
    const scopeNodes = new Set<ClusterNodeRecord>(mentioned);
    if (mentioned.length < 2 && requested !== undefined) {
      if (online.length < requested) {
        errors.push(`goal requires ${requested} nodes but only ${online.length} are online`);
      }
      for (const node of online) scopeNodes.add(node);
    }
    const label = (node: ClusterNodeRecord) => node.hostname || node.name || node.nodeId;
    for (const node of mentioned) {
      if (node.status !== "online") {
        errors.push(`requested node '${label(node)}' is ${node.status}`);
      }
    }

    for (const node of scopeNodes) {
      if (groups.some((group) => group.nodeId === node.nodeId)) continue;
      groups.push({
        key: `node:${node.nodeId}`,
        label: `${label(node)} (${node.platform})`,
        nodeId: node.nodeId,
        platform: node.platform as "darwin" | "linux" | "win32",
        operation: "analyze",
        subGoalText: `Analyze ${label(node)} for: ${raw}`,
        requiredCapabilities: [],
      });
    }
  }

  /** 用户声明的节点数量（"三个节点" / "3 台机器"），忽略项目数量等其他量词。 */
  private extractRequestedNodeCount(raw: string): number | undefined {
    const cnNumbers: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const match = raw.match(/([0-9]{1,2}|[一二两三四五六七八九十])\s*(?:个|台|名|只)?\s*(?:节点|机器|主机|worker|node)/i);
    if (!match || match.index === undefined) return undefined;
    // 「不要扩展到三个节点」之类的负向句式不是范围声明。
    const prefix = raw.slice(Math.max(0, match.index - 8), match.index).toLowerCase();
    if (/(?:不|不要|禁止|无需|不用|别|not\s+|without\s+)[^。；;，,]{0,6}$/.test(prefix)) return undefined;
    const token = match[1]!;
    const value = /^\d+$/.test(token) ? Number(token) : cnNumbers[token];
    return value !== undefined && value >= 2 ? value : undefined;
  }

  /**
   * 确定性范围覆盖校验：用户明确要求的每个目标都必须被计划中的某个节点真实覆盖。
   * 只做校验，不生成或改写计划，也不参与派发。
   */
  validateTargetCoverage(
    nodes: GraphProposalNode[],
    requiredTargets: NonNullable<ExecutionStrategyDecision["requiredTargets"]>
  ): string[] {
    const covered = new Set(nodes.map((node) => node.candidateNodeId).filter((id): id is string => Boolean(id)));
    const errors: string[] = [];
    for (const target of requiredTargets) {
      if (target.candidateNodeIds.length === 0) continue;
      if (target.candidateNodeIds.some((nodeId) => covered.has(nodeId))) continue;
      errors.push(
        `PLANNING_SCOPE_MISSING: required target '${target.label ?? target.key}' (${target.candidateNodeIds.join(", ")}) is not covered by any plan node; do not drop requested targets`
      );
    }
    return errors;
  }

  private extractDistinctTargetGroups(
    raw: string,
    lower: string,
    intent: ReturnType<TaskIntentAnalyzer["analyze"]>
  ): TargetSubgoalSpec[] {
    const groups: TargetSubgoalSpec[] = [];

    const patterns: Array<{
      key: string;
      label: string;
      aliases: string[];
      platform: "darwin" | "linux" | "win32";
    }> = [
      {
        key: "mac",
        label: "Mac (darwin-arm64)",
        aliases: ["macbook", "macos", "mac", "苹果", "本地"],
        platform: "darwin",
      },
      {
        key: "windows",
        label: "Windows Native (win32-x64)",
        aliases: ["windows native", "win32", "windows"],
        platform: "win32",
      },
      {
        key: "wsl",
        label: "WSL2 Ubuntu (linux-x64)",
        aliases: ["wsl2", "wsl", "cuda", "gpu"],
        platform: "linux",
      },
      {
        key: "cloud",
        label: "Cloud Linux (linux-x64)",
        aliases: ["cloud", "tencent", "腾讯云", "云端", "服务器"],
        platform: "linux",
      },
    ];

    for (const p of patterns) {
      const matchedAlias = p.aliases.find((a) => lower.includes(a) && !this.isNegated(lower, a));
      if (matchedAlias) {
        groups.push({
          key: p.key,
          label: p.label,
          platform: p.platform,
          operation: "analyze",
          subGoalText: `Inspect and analyze ${p.label} regarding: ${raw}`,
          requiredCapabilities: p.key === "wsl" && lower.includes("cuda") ? ["cuda"] : [],
        });
      }
    }

    // 若未提及多个物理节点，但提及了多个不同项目
    if (groups.length < 2 && intent.projectHints.length >= 2) {
      for (const proj of intent.projectHints) {
        groups.push({
          key: proj.replace(/[^a-zA-Z0-9_]/g, "_"),
          label: `Project ${proj}`,
          projectId: proj,
          operation: "analyze",
          subGoalText: `Analyze project '${proj}' for goal: ${raw}`,
          requiredCapabilities: [],
        });
      }
    }

    return groups;
  }

  private async synthesizeMultiAgentNodes(
    userGoal: string,
    strategy: ExecutionStrategyDecision,
    context?: PlanGoalContext
  ): Promise<GraphProposalNode[]> {
    const lower = userGoal.toLowerCase();
    const activeStore = context?.store ?? this.store;
    const intent = this.intentAnalyzer.analyze(userGoal, undefined, activeStore ? await activeStore.listNodes() : []);
    const groups = this.extractDistinctTargetGroups(userGoal, lower, intent);

    // 若有 store，尝试为每个 group 绑定真实登记的 candidateProjectId / online nodeId
    const projects = activeStore ? await activeStore.listProjectsCatalog() : [];
    const onlineNodes = activeStore
      ? (await activeStore.listNodes()).filter((n) => n.status === "online")
      : [];

    const resolveTarget = (g: TargetSubgoalSpec): { nodeId?: string; projectId?: string } => {
      let nodeId = g.nodeId;
      let projectId = g.projectId;

      if (activeStore && onlineNodes.length > 0) {
        const exactOnline = onlineNodes.find((n) => n.nodeId === nodeId);
        if (!exactOnline && g.platform) {
          const candidates = onlineNodes.filter(node => this.matchesTargetGroup(node, g));
          const platformMatch = candidates.length === 1 ? candidates[0] : undefined;
          if (platformMatch) nodeId = platformMatch.nodeId;
        }
      }

      if (nodeId && !projectId && projects.length > 0) {
        const nodeProjects = projects.filter((p) => p.nodeId === nodeId && p.status === "active");
        if (nodeProjects.length === 1) {
          projectId = nodeProjects[0]!.projectId;
        }
      } else if (projectId && !nodeId && projects.length > 0) {
        const matchingProj = projects.find(
          (p) => (p.projectId === projectId || p.name === projectId) && p.status === "active"
        );
        if (matchingProj) {
          nodeId = matchingProj.nodeId;
          projectId = matchingProj.projectId;
        }
      }

      return { nodeId, projectId };
    };

    const nodes: GraphProposalNode[] = [];
    const branchNodeIds: string[] = [];
    const branchArtifacts: Array<{ name: string; producerNodeId: string; contentType: string }> = [];

    const effectiveGroups: TargetSubgoalSpec[] =
      groups.length >= 2
        ? groups
        : [
            {
              key: "branch_a",
              label: "Primary Analysis Branch",
              nodeId: strategy.selectedWorkers[0]?.nodeId,
              projectId: strategy.selectedWorkers[0]?.projectId,
              operation: "analyze",
              subGoalText: `Analyze primary target and extract findings for: ${userGoal}`,
              requiredCapabilities: intent.requiredCapabilities,
            },
            {
              key: "branch_b",
              label: "Secondary Inspection Branch",
              nodeId: strategy.selectedWorkers[1]?.nodeId ?? strategy.selectedWorkers[0]?.nodeId,
              projectId: strategy.selectedWorkers[1]?.projectId ?? strategy.selectedWorkers[0]?.projectId,
              operation: "analyze",
              subGoalText: `Inspect target workspace compatibility and constraints for: ${userGoal}`,
              requiredCapabilities: [],
            },
          ];

    // Stage 1: 并行探测 / 分析节点
    for (const g of effectiveGroups) {
      const resolved = resolveTarget(g);
      const nodeId = `task_analyze_${g.key}`;
      const artifactName = `${g.key}_findings.json`;
      branchNodeIds.push(nodeId);
      branchArtifacts.push({
        name: artifactName,
        producerNodeId: nodeId,
        contentType: "application/json",
      });

      nodes.push({
        nodeId,
        title: `Analyze ${g.label}`,
        goal: `${g.subGoalText}\n\n[Parent Goal Constraint: ${userGoal}]`,
        description: `Parallel analysis branch for ${g.label}`,
        operation: "analyze",
        candidateNodeId: resolved.nodeId,
        candidateProjectId: resolved.projectId,
        explicitNodePinned: false,
        dependencies: [],
        requiredCapabilities: g.requiredCapabilities,
        requiredSandboxPolicy: {
          filesystemMode: "read-only",
          networkMode: "deny",
          approvalMode: "ask",
        },
        expectedOutputs: [artifactName],
        producedArtifacts: [
          {
            name: artifactName,
            contentType: "application/json",
            description: `Structured analysis findings from ${g.label}`,
          },
        ],
        acceptanceCriteria: [
          {
            type: "artifact_exists",
            description: `Analysis artifact '${artifactName}' must be published`,
            expected: artifactName,
          },
        ],
        failurePolicy: "block_dependents",
        retryClassification: "reassignable",
      });
    }

    // Stage 2: Join Barrier 汇聚对比与方案合成节点
    const synthesisTarget = resolveTarget(effectiveGroups[0]!);
    const synthesisNodeId = "task_synthesize_findings";
    const synthesisArtifact = "synthesis_report.md";

    nodes.push({
      nodeId: synthesisNodeId,
      title: "Compare Findings & Synthesize Plan",
      goal: `Compare upstream findings from ${effectiveGroups.map((g) => g.label).join(", ")} and synthesize root causes and actionable plan for: ${userGoal}`,
      description: "Join barrier waiting for all parallel analysis branches before synthesizing findings",
      operation: "synthesize",
      candidateNodeId: synthesisTarget.nodeId,
      candidateProjectId: synthesisTarget.projectId,
      explicitNodePinned: false,
      dependencies: [...branchNodeIds],
      dependencyType: "join",
      requiredCapabilities: [],
      requiredSandboxPolicy: {
        filesystemMode: "read-only",
        networkMode: "deny",
        approvalMode: "ask",
      },
      requiredArtifacts: branchArtifacts.map((a) => ({
        name: a.name,
        producerNodeId: a.producerNodeId,
        contentType: a.contentType,
      })),
      expectedOutputs: [synthesisArtifact],
      producedArtifacts: [
        {
          name: synthesisArtifact,
          contentType: "text/markdown",
          description: "Cross-node comparison and root-cause synthesis report",
        },
      ],
      acceptanceCriteria: [
        {
          type: "artifact_exists",
          description: `Synthesis report '${synthesisArtifact}' must be produced`,
          expected: synthesisArtifact,
        },
      ],
      failurePolicy: "block_dependents",
      retryClassification: "transient",
    });

    // Stage 3 (可选): 若用户请求包含代码修复/实施且未要求只读，则追加执行与验证阶段
    const wantsExecution =
      !intent.constraints.readOnly &&
      (/(?:修复|修改|实现|导入|执行修复|apply fix)/i.test(userGoal) &&
        !/(?:只提出|仅提出|不要修改|不修改)/i.test(userGoal));

    if (wantsExecution) {
      const fixNodeId = "task_execute_remediation";
      nodes.push({
        nodeId: fixNodeId,
        title: "Execute Remediation",
        goal: `Execute the synthesized remediation steps based on '${synthesisArtifact}' for: ${userGoal}`,
        description: "Apply targeted fixes within workspace write boundary",
        operation: "execute",
        candidateNodeId: synthesisTarget.nodeId,
        candidateProjectId: synthesisTarget.projectId,
        explicitNodePinned: false,
        dependencies: [synthesisNodeId],
        dependencyType: "artifact",
        requiredCapabilities: [],
        requiredSandboxPolicy: {
          filesystemMode: "workspace-write",
          networkMode: "deny",
          approvalMode: "ask",
        },
        requiredArtifacts: [
          {
            name: synthesisArtifact,
            producerNodeId: synthesisNodeId,
            contentType: "text/markdown",
          },
        ],
        acceptanceCriteria: [
          {
            type: "test_exit_code",
            description: "Remediation execution must succeed",
            expected: 0,
          },
        ],
        failurePolicy: "block_dependents",
        retryClassification: "none",
      });

      nodes.push({
        nodeId: "task_verify_integration",
        title: "Verify Remediation & Run Tests",
        goal: `Verify the applied changes and run verification checks for: ${userGoal}`,
        description: "Deterministic verification stage after remediation",
        operation: "verify",
        candidateNodeId: synthesisTarget.nodeId,
        candidateProjectId: synthesisTarget.projectId,
        explicitNodePinned: false,
        dependencies: [fixNodeId],
        dependencyType: "success",
        requiredCapabilities: [],
        requiredSandboxPolicy: {
          filesystemMode: "read-only",
          networkMode: "deny",
          approvalMode: "ask",
        },
        acceptanceCriteria: [
          {
            type: "test_exit_code",
            description: "Verification tests exit with code 0",
            expected: 0,
          },
        ],
        failurePolicy: "cancel_graph",
        retryClassification: "transient",
      });
    }

    return nodes;
  }

  /**
   * 尝试从本地 NASH_HOME/settings.json（默认 ~/.nash-agents）或环境变量装配真实 LLM 客户端
   */
  public static createDefaultLlmClient(defaultOptions?: ModelCallOptions, snapshotProvider?: () => ProductModelContext | undefined): PlannerLlmClient | undefined {
    const initial = currentModelContext()?.main ?? snapshotProvider?.()?.main ?? getNashModelConfig();
    if (!initial.baseUrl || !initial.apiKey || !initial.model) return undefined;
    return {
      async chat(messages: Array<{ role: string; content: string }>, tools?: unknown[], options?: ModelCallOptions) {
        const snapshot = currentModelContext() ?? snapshotProvider?.();
        const config = snapshot?.main ?? getNashModelConfig();
        const { baseUrl, apiKey, model, format } = config;
        if (!baseUrl || !apiKey || !model) throw new Error("Planner model is not configured");
        const startTime = performance.now();
        const run = () => callChatCompletions(baseUrl, apiKey, { model, messages: messages as ChatMessage[], temperature: 0.1 },
          { signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000), purpose: "planner", format, ...defaultOptions, ...options });
        const data = await (snapshot ? withProductModels(snapshot, run) : run());
        const choice = data?.choices?.[0];
        const content = choice?.message?.content ?? "";
        return {
          content,
          usage: data?.usage,
          model: model,
          durationMs: performance.now() - startTime,
          requestId: data?.id,
        } as any;
      },
    };
  }

  private async tryLlmDecomposition(
    userGoal: string,
    strategy: ExecutionStrategyDecision,
    context?: PlanGoalContext,
  ): Promise<{ nodes: GraphProposalNode[]; durationMs: number; usage?: any; model?: string } | null> {
    const client = this.llmClient ?? AutonomousPlanner.createDefaultLlmClient();
    if (!client) { strategy.planningError = "Planner LLM is not configured"; return null; }
    const started = performance.now();
    const messages = [
      { role: "system", content: `You are the Nash Distributed Autonomous TaskGraph Planner.
Return JSON {"reasoning":"...","nodes":GraphProposalNode[]} with a free dependency DAG.
Each node needs nodeId, title, goal, operation (analyze/execute/verify/synthesize), dependencies,
candidateNodeId AND candidateProjectId from the supplied verified catalog, requiredCapabilities,
requiredSandboxPolicy {filesystemMode:read-only/workspace-write,networkMode:deny},
producedArtifacts [{name,contentType}], acceptanceCriteria [{type:artifact_exists,expected:name,description}].
Use parallel independent branches and a join when appropriate. A join MUST declare requiredArtifacts
[{name,producerNodeId:graphNodeId}] for every report it reads, dependencies and dependencyType:join.
Do not infer tools from platform names. Use only verified current capabilities. Respect excluded workers,
project visibility, approval constraints and read-only goals. Never relax policies or use danger-full-access.
Inspection of a sandbox does NOT require invoking every platform's backend on every worker.
Never manufacture execution evidence. The runtime validates the proposal before any dispatch.` },
      { role: "user", content: JSON.stringify({ goal: userGoal, strategy,
        capabilities: await this.planningCapabilities(context), now: Date.now() }) },
    ];
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response: any = await observeRuntimePhase<any>("planner_request", () => client.chat ? client.chat(messages) : client.complete!(messages));
        const raw = response.content ?? response.message?.content ?? "";
        const parsed = await observeRuntimePhase("planner_response", async () => JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "null"));
        for (const key of Object.keys(usage) as Array<keyof typeof usage>) usage[key] += response.usage?.[key] ?? 0;
        strategy.planningRequestIds = [...(strategy.planningRequestIds ?? []), response.requestId ?? response.id ?? "unreported"];
        if (!Array.isArray(parsed?.nodes) || !parsed.nodes.length) throw new Error("Planner returned no DAG nodes");
        const nodes = this.normalizeExplicitNodes(userGoal, parsed.nodes);
        const dag = DagValidator.validateProposal(nodes);
        const errors = dag.valid ? await this.validatePlanConstraints(nodes, context) : [dag.reason ?? "Invalid DAG"];
        for (const target of strategy.requiredTargets ?? []) {
          if (!nodes.some((n) => n.candidateNodeId && target.candidateNodeIds.includes(n.candidateNodeId))) errors.push(`Goal coverage missing required target '${target.key}'; do not drop requested targets to repair constraint errors`);
        }
        const allowed = new Set(strategy.selectedWorkers.map((w) => w.nodeId));
        for (const node of nodes) if (node.candidateNodeId && !allowed.has(node.candidateNodeId)) errors.push(`${node.nodeId}: worker is outside the user goal's selected scope`);
        strategy.planningAttempts = [...(strategy.planningAttempts ?? []), { attempt: attempt + 1, errors, nodes }];
        if (!errors.length) return { nodes, durationMs: performance.now() - started, usage, model: response.model };
        messages.push({ role: "assistant", content: raw }, { role: "user", content: JSON.stringify({ constraintErrors: errors, instruction: "Correct the plan using the supplied catalog. Do not execute." }) });
        strategy.planningError = errors.join("; ");
      } catch (error) {
        strategy.planningError = error instanceof Error ? error.message : "Planner request failed";
        // Transport failures and invalid responses do not trigger blind model retries.
        return null;
      } finally { strategy.planningDurationMs = performance.now() - started; }
    }
    return null;
  }
}
