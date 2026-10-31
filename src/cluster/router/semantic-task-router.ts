/**
 * Semantic Task Router
 * Phase 3 核心统一门面 (Facade)
 * 编排自然语言任务理解、跨节点资源与记忆发现、候选打分过滤、确定性安全校验与自主任务派发
 */

import type { IClusterStore } from "../storage/cluster-store.js";
import type { NodeRegistry } from "../coordinator/node-registry.js";
import type { TaskScheduler } from "../coordinator/task-scheduler.js";
import type { ClusterSearchService } from "../coordinator/catalog/cluster-search-service.js";
import type { CoordinatorCatalogService } from "../coordinator/catalog/coordinator-catalog-service.js";

import { TaskIntentAnalyzer } from "./intent-analyzer.js";
import { RoutingCandidateCollector } from "./candidate-collector.js";
import { RoutingCandidateRanker } from "./candidate-ranker.js";
import { RoutingDecisionEngine } from "./decision-engine.js";
import { RoutingValidator } from "./routing-validator.js";
import { AutonomousDispatchService, type AutonomousDispatchResult } from "./autonomous-dispatch-service.js";
import { RoutingSessionManager } from "./routing-session-manager.js";
import { CoordinatorDecisionController } from "./coordinator-decision-controller.js";
import type {
  TaskIntent,
  TaskConstraints,
  RoutingCandidate,
  RoutingDecision,
  RoutingValidationResult,
  RoutingSessionRecord,
} from "./types.js";

export interface SemanticRouterOptions {
  store: IClusterStore;
  registry: NodeRegistry;
  scheduler: TaskScheduler;
  searchService: ClusterSearchService;
  catalogService?: CoordinatorCatalogService;
  enableAgentLoopConsultation?: boolean;
}

export interface RouteTaskOptions {
  constraints?: TaskConstraints;
  dryRun?: boolean;
  sessionId?: string;
}

export interface AutonomousRunResult {
  decision: RoutingDecision;
  validation: RoutingValidationResult;
  dispatchResult?: AutonomousDispatchResult;
  session: RoutingSessionRecord;
}

export class SemanticTaskRouter {
  private readonly analyzer: TaskIntentAnalyzer;
  private readonly collector: RoutingCandidateCollector;
  private readonly ranker: RoutingCandidateRanker;
  private readonly decisionEngine: RoutingDecisionEngine;
  private readonly validator: RoutingValidator;
  private readonly dispatchService: AutonomousDispatchService;
  private readonly sessionManager: RoutingSessionManager;
  private readonly decisionController?: CoordinatorDecisionController;

  constructor(private readonly options: SemanticRouterOptions) {
    this.analyzer = new TaskIntentAnalyzer();
    this.collector = new RoutingCandidateCollector(options.searchService);
    this.ranker = new RoutingCandidateRanker();
    this.decisionEngine = new RoutingDecisionEngine();
    this.validator = new RoutingValidator(options.store, options.registry);
    this.dispatchService = new AutonomousDispatchService(options.scheduler, options.store);
    this.sessionManager = new RoutingSessionManager();

    if (options.enableAgentLoopConsultation) {
      this.decisionController = new CoordinatorDecisionController({
        store: options.store,
        registry: options.registry,
        searchService: options.searchService,
        catalogService: options.catalogService,
      });
    }
  }

  get sessionMgr(): RoutingSessionManager {
    return this.sessionManager;
  }

  /**
   * 1. 纯路由分析 (Route Only / Dry Run)
   */
  async planRoute(
    userInput: string,
    options?: RouteTaskOptions
  ): Promise<{
    intent: TaskIntent;
    candidates: RoutingCandidate[];
    decision: RoutingDecision;
    validation: RoutingValidationResult;
    session: RoutingSessionRecord;
  }> {
    // 1. 意图解析
    const nodes = await this.options.searchService.searchNodes();
    const intent = this.analyzer.analyze(userInput, options?.constraints, nodes);
    const session = options?.sessionId
      ? this.sessionManager.getSession(options.sessionId) ??
        this.sessionManager.createSession(userInput, intent)
      : this.sessionManager.createSession(userInput, intent);

    // 2. 候选收集
    const collectedCandidates = await this.collector.collect(intent);
    const rawCandidates = intent.targetNodeIds === undefined || intent.constraints.preferredNodeId
      ? collectedCandidates
      : collectedCandidates.filter(candidate => intent.targetNodeIds!.includes(candidate.nodeId));

    // 3. 候选排名与硬约束过滤
    const rankedCandidates = this.ranker.rank(intent, rawCandidates);

    // 4. 路由裁决 (确定性判定)
    let decision = this.decisionEngine.decide(intent, rankedCandidates);

    // 若需要且启用了 Coordinator AgentLoop 深层语义咨询
    if (
      decision.decisionType === "CLARIFICATION_REQUIRED" &&
      this.decisionController &&
      rankedCandidates.length > 1
    ) {
      try {
        const consult = await this.decisionController.consultCoordinatorAgentLoop(intent, rankedCandidates);
        if (consult.recommendedNodeId && consult.recommendedProjectId) {
          const matched = rankedCandidates.find(
            (c) => c.nodeId === consult.recommendedNodeId && c.projectId === consult.recommendedProjectId
          );
          if (matched && matched.hardConstraintsSatisfied) {
            decision = {
              ...decision,
              decisionType: "DISPATCH",
              selectedCandidate: matched,
              reason: `经 Coordinator 深层分析裁决: ${consult.analysisReason}`,
            };
          }
        }
      } catch (err) {
        console.warn(`[SemanticTaskRouter] Coordinator AgentLoop consultation failed: ${err}`);
      }
    }

    this.sessionManager.recordDecision(session.sessionId, decision);

    // 5. 确定性安全校验
    const validation = await this.validator.validate(decision, intent);

    return {
      intent,
      candidates: rankedCandidates,
      decision,
      validation,
      session,
    };
  }

  /**
   * 2. 自主端到端任务派发 (Autonomous Run)
   */
  async runAutonomous(
    userInput: string,
    options?: RouteTaskOptions
  ): Promise<AutonomousRunResult> {
    const routePlan = await this.planRoute(userInput, options);
    const { decision, validation, session } = routePlan;

    // 如果是 Dry Run 或无法直接派发 (例如澄清、阻塞、无候选)
    if (options?.dryRun || !validation.valid || decision.decisionType !== "DISPATCH") {
      return {
        decision,
        validation,
        session,
      };
    }

    // 触发自主安全派发
    const dispatchResult = await this.dispatchService.dispatch(decision, validation);

    if (dispatchResult.success && dispatchResult.taskId) {
      this.sessionManager.bindTask(session.sessionId, dispatchResult.taskId, dispatchResult.runId);
    }

    return {
      decision,
      validation,
      dispatchResult,
      session,
    };
  }

  /**
   * 3. 处理用户多轮澄清输入并继续推进任务
   */
  async clarifyAndRun(
    sessionId: string,
    userClarification: string
  ): Promise<AutonomousRunResult> {
    const { session, updatedIntent } = this.sessionManager.handleClarification(
      sessionId,
      userClarification
    );

    return this.runAutonomous(updatedIntent.originalRequest, {
      constraints: updatedIntent.constraints,
      sessionId: session.sessionId,
    });
  }
}
