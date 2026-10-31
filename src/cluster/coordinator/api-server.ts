import { pollStream } from "./stream-poller.js";
import { processGoalRun } from "./goal-run-service.js";
import { defaultTraceContext } from "../../observability/trace-context.js";
import { projectExecutionProvenance } from "../graph/execution-provenance.js";
import { runtimeRelease } from "../../runtime/release-info.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
  IClusterStore,
  WebConversationRecord,
  WebMessageRecord,
  WebSessionRecord,
  ConversationTitleSource,
  TaskSecurityGrant,
} from "../storage/cluster-store.js";
import type { SandboxPolicy } from "../../sandbox/types.js";
import { CLUSTER_TASK_TERMINAL } from "../storage/cluster-store.js";
import type { NodeRegistry } from "./node-registry.js";
import { TaskSecurityGrantService } from "./task-security-grant-service.js";
import type { TaskScheduler } from "./task-scheduler.js";
import type { AdmissionControl } from "./admission-control.js";
import { AdmissionFrozenError } from "./admission-control.js";
import type { InviteManager } from "../identity/invite-manager.js";
import type { CoordinatorCatalogService } from "./catalog/coordinator-catalog-service.js";
import type { ClusterSearchService } from "./catalog/cluster-search-service.js";
import type { SemanticTaskRouter } from "../router/semantic-task-router.js";
import type { RoutingFeedbackController } from "../router/routing-feedback-controller.js";
import type { AutonomousPlanner } from "../graph/autonomous-planner.js";
import type { DistributedGraphOrchestrator } from "../graph/graph-orchestrator.js";
import type { ArtifactService } from "../artifacts/artifact-service.js";
import type { GraphReplanner } from "../graph/graph-replanner.js";
import { GraphStateProjection } from "../graph/graph-state-projection.js";
import { TaskStateProjection } from "./state-projection.js";
import { createEnvelope, encodeEnvelope } from "../protocol/message-codec.js";
import type { RemoteApprovalResolvePayload } from "../protocol/types.js";
import type { EventBus } from "../../observability/event-bus.js";
import type { AutonomousDiscoveryService } from "../discovery/index.js";
import type { CoordinatorMainAgent } from "./main-agent/index.js";
import { RoutingValidator } from "../router/routing-validator.js";
import { acceptsOrigin, equalSecret, parseCookies, isSecureRequest, WebRequestError } from "./web-security.js";
import { ProductStore } from "../../product/store.js";
import { ProductHttpApi } from "../../product/http-api.js";
import { PromptOptimizerService } from "../../ai/prompt-optimizer-service.js";
import { SessionTitleService } from "../../ai/session-title-service.js";
import type { ScheduleTriggerEngine } from "../scheduled/schedule-trigger-engine.js";
import { ScheduleTriggerEngine as EngineHelper } from "../scheduled/schedule-trigger-engine.js";
import { isValidCronExpression } from "../scheduled/cron-parser.js";
import type { ScheduledTaskRecord, SecurityAuditFilter } from "../storage/cluster-store.js";

function positiveEnvMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * 客户端断开后前台轮次还能继续等待多久。
 * 宽限期满只中止「协调器等待回答」，已派发到 Worker 的任务不受影响。
 */
function clientDisconnectGraceMs(): number { return positiveEnvMs("NASH_TURN_DISCONNECT_GRACE_MS", 60_000); }
/** 单个前台轮次的硬上限，避免会话与 GoalRun 租约被无限占用。 */
function turnMaxDurationMs(): number { return positiveEnvMs("NASH_TURN_MAX_DURATION_MS", 30 * 60_000); }

export interface ApiServerOptions {
  productStore?: ProductStore;
  store: IClusterStore;
  registry: NodeRegistry;
  scheduler: TaskScheduler;
  inviteManager: InviteManager;
  coordinatorNodeId: string;
  adminApiKey?: string;
  allowedOrigins?: string[];
  trustProxy?: boolean;
  webDistDir?: string;
  catalogService?: CoordinatorCatalogService;
  searchService?: ClusterSearchService;
  semanticRouter?: SemanticTaskRouter;
  feedbackController?: RoutingFeedbackController;
  planner?: AutonomousPlanner;
  orchestrator?: DistributedGraphOrchestrator;
  artifactService?: ArtifactService;
  replanner?: GraphReplanner;
  discoveryService?: AutonomousDiscoveryService;
  mainAgent?: CoordinatorMainAgent;
  eventBus?: EventBus;
  scheduledEngine?: ScheduleTriggerEngine;
}

export class ClusterApiHandler {
  private readonly productStore?: ProductStore;
  private readonly productApi?: ProductHttpApi;
  private readonly store: IClusterStore;
  private readonly registry: NodeRegistry;
  private readonly scheduler: TaskScheduler;
  private readonly inviteManager: InviteManager;
  private readonly coordinatorNodeId: string;
  private readonly adminApiKey?: string;
  private readonly webDistDir?: string;
  private readonly catalogService?: CoordinatorCatalogService;
  private readonly searchService?: ClusterSearchService;
  private readonly semanticRouter?: SemanticTaskRouter;
  private readonly feedbackController?: RoutingFeedbackController;
  private readonly planner?: AutonomousPlanner;
  private readonly orchestrator?: DistributedGraphOrchestrator;
  private readonly artifactService?: ArtifactService;
  private readonly replanner?: GraphReplanner;
  private readonly discoveryService?: AutonomousDiscoveryService;
  private readonly mainAgent?: CoordinatorMainAgent;
  private readonly eventBus?: EventBus;
  private readonly scheduledEngine?: ScheduleTriggerEngine;
  private readonly graphProjection: GraphStateProjection;
  private readonly allowedOrigins: string[];
  private readonly trustProxy: boolean;
  private readonly sessionStreams = new Map<ServerResponse, string>();
  private readonly conversationRequests = new Set<string>();
  private readonly loginAttempts = new Map<string, { failures: number; windowStart: number; lockedUntil: number }>();
  private readonly eventSubscriptions: Array<() => void> = [];
  private readonly globalSseClients = new Set<ServerResponse>();
  private goalRecoveryTimer?: NodeJS.Timeout;
  private goalRecoveryActive = false;
  /** 全局流单调序号：用于 Last-Event-ID 断线回放。 */
  private globalEventSeq = 0;
  /** 有界回放缓冲；超出上限丢弃最旧事件，并由 stream.reset 提示客户端重建状态。 */
  private readonly globalEventReplay: Array<{ seq: number; frame: string }> = [];
  private static readonly GLOBAL_REPLAY_LIMIT = 1000;
  private readonly activeConversationTurns = new Map<
    string,
    {
      abortController: AbortController;
      conversationId: string;
      /** 客户端断开的时间；仅用于诊断与事件，不改变已派发任务的执行。 */
      clientDisconnectedAt?: number;
      taskId?: string;
      graphId?: string;
      startedAt: number;
      progress?: { phase: string; detail: string; timestamp: number };
    }
  >();
  private readonly taskSecurityGrants?: TaskSecurityGrantService;
  private readonly promptOptimizer = new PromptOptimizerService();
  private readonly sessionTitleService = new SessionTitleService();
  /** 准入 / 排空控制；由 ClusterCoordinator 在 Gateway 就绪后注入。 */
  private admission?: AdmissionControl;

  /** 供 AdmissionControl 取证：本进程内仍在执行的会话轮次。 */
  listLiveTurns(): string[] {
    return Array.from(this.activeConversationTurns.keys());
  }

  setAdmissionControl(admission: AdmissionControl): void {
    this.admission = admission;
  }

  constructor(options: ApiServerOptions) {
    this.productStore = options.productStore;
    this.taskSecurityGrants = new TaskSecurityGrantService({
      store: options.store,
      scheduler: options.scheduler,
      registry: options.registry,
      productStore: options.productStore,
      emit: (type, data) => this.broadcastGlobalSse(type as any, data),
      onTaskResumed: async (taskId) => { await options.orchestrator?.syncTaskActivity?.(taskId); },
    });
    this.productApi = options.productStore ? new ProductHttpApi(options.productStore, options.store,
      // 全局安全策略收紧时，唯一必须证明的安全事实是：没有任何 Worker 仍持有任务级提权。
      // 这里绝不伪造 cancelled、绝不静默清理 outcome_unknown、绝不改写数据库状态代替真实 ACK。
      // 普通任务的收紧由 Worker 自身的策略轮询 Fail-Closed 取消完成。
      this.taskSecurityGrants!.createSecurityRevocationHandler(),
      async userId => { for (const [stream, sessionId] of this.sessionStreams) { const session = await options.store.getWebSession?.(sessionId); if (session?.userId === userId) { stream.end(); this.sessionStreams.delete(stream); } } }) : undefined;
    this.store = options.store;
    this.registry = options.registry;
    this.scheduler = options.scheduler;
    this.inviteManager = options.inviteManager;
    this.coordinatorNodeId = options.coordinatorNodeId;
    this.adminApiKey = options.adminApiKey;
    this.allowedOrigins = options.allowedOrigins ?? [];
    this.trustProxy = options.trustProxy ?? false;
    this.webDistDir = options.webDistDir ?? path.join(process.cwd(), "apps", "web", "dist");
    this.catalogService = options.catalogService;
    this.searchService = options.searchService;
    this.semanticRouter = options.semanticRouter;
    this.feedbackController = options.feedbackController;
    this.planner = options.planner;
    this.orchestrator = options.orchestrator;
    this.artifactService = options.artifactService;
    this.replanner = options.replanner;
    this.discoveryService = options.discoveryService;
    this.mainAgent = options.mainAgent;
    this.eventBus = options.eventBus;
    this.scheduledEngine = options.scheduledEngine;
    this.graphProjection = new GraphStateProjection(this.store);


    if (this.eventBus) {
      this.eventSubscriptions.push(this.eventBus.subscribe("*", (event) => {
        this.broadcastGlobalSse(event.type, (event.data as Record<string, unknown>) ?? {});
        if (/^(task\.|approval\.|graph\.|discovery\.)/.test(event.type) && this.store.listGoalRuns) {
          const data = (event.data ?? {}) as { taskId?: string; graphId?: string };
          if (data.taskId || data.graphId) void this.store.listGoalRuns().then(async goals => {
            for (const goal of goals) {
              if (!((data.taskId && goal.linkedTaskIds.includes(data.taskId)) || (data.graphId && goal.linkedGraphIds.includes(data.graphId)))) continue;
              const updated = await processGoalRun(this.store, goal.goalRunId);
              if (updated.revision !== goal.revision) this.broadcastGlobalSse("goal_run.updated", { goalRunId: updated.goalRunId, conversationId: updated.conversationId, revision: updated.revision });
            }
          }).catch(error => console.error("GoalRun reconciliation failed", error instanceof Error ? error.message : "unknown error"));
        }
      }));
      this.eventSubscriptions.push(this.eventBus.subscribe("coordinator.task_dispatched", async (ev) => {
        const data = ev.data as any;
        // Scout ownership is persisted by its awaited per-invocation callback.
        if (data?.isScout && data?.conversationId) return;
        if (data?.taskId || data?.graphId) {
          for (const [convId, entry] of this.activeConversationTurns.entries()) {
            if (data.conversationId === convId) {
              if (data.taskId) entry.taskId = data.taskId;
              if (data.graphId) entry.graphId = data.graphId;
              const conv = await this.store.getConversation?.(convId);
              if (conv) {
                if (!conv.linkedTaskIds) conv.linkedTaskIds = [];
                if (data.taskId && !conv.linkedTaskIds.includes(data.taskId)) {
                  conv.linkedTaskIds.push(data.taskId);
                }
                if (data.graphId) conv.linkedGraphIds = [...new Set([...(conv.linkedGraphIds ?? []), data.graphId])];
                await this.store.saveConversation?.(conv);
              }
            }
          }
        }
      }));
    }
    if (this.store.listGoalRuns && this.store.getGoalRun && this.store.updateGoalRun) {
      this.goalRecoveryTimer = setInterval(() => { void this.recoverGoalRuns(); }, 5000);
      this.goalRecoveryTimer.unref();
      void this.recoverGoalRuns();
    }
  }

  private async recoverGoalRuns(): Promise<void> {
    if (this.goalRecoveryActive || !this.store.listGoalRuns) return;
    this.goalRecoveryActive = true;
    try {
      for (const goal of await this.store.listGoalRuns()) {
        try {
          let updated = await processGoalRun(this.store, goal.goalRunId);
          if (updated.currentStage === "planning" && updated.turnLease) {
            updated = await this.recoverInterruptedGoalTurn(updated) ?? updated;
          }
          if (updated.revision !== goal.revision) this.broadcastGlobalSse("goal_run.updated", { goalRunId: updated.goalRunId, conversationId: updated.conversationId, revision: updated.revision });
        } catch { /* A later recovery pass retries from persisted state. */ }
      }
    } catch { /* Store may be temporarily unavailable during startup. */ }
    finally { this.goalRecoveryActive = false; }
  }

  private async recoverInterruptedGoalTurn(goal: import("../storage/cluster-store.js").GoalRunRecord): Promise<import("../storage/cluster-store.js").GoalRunRecord | null> {
    if (!goal.turnLease || !this.store.claimGoalTurnLease || !this.store.renewGoalTurnLease || !this.store.commitGoalTurnResponse) return null;
    const lease = await this.store.claimGoalTurnLease(goal.goalRunId, goal.turnLease.turnId, `recovery-${crypto.randomUUID()}`, 45_000);
    if (!lease) return null;
    const fence = { ownerId: lease.ownerId, turnId: lease.turnId, generation: lease.generation };
    let renewing = false, leaseLost = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.store.renewGoalTurnLease!(goal.goalRunId, fence.ownerId, fence.generation, 45_000)
        .then(valid => { if (!valid) leaseLost = true; }).catch(() => { leaseLost = true; }).finally(() => { renewing = false; });
    }, 10_000);
    timer.unref();
    try {
      const owned = await this.store.getGoalRun?.(goal.goalRunId);
      if (!owned) throw new Error("GoalRun disappeared during recovery");
      // A persisted ready graph was admitted before the crash but never started.
      // Its CAS start and task identities prevent replaying already dispatched work.
      for (const graphId of owned.linkedGraphIds) {
        if (leaseLost) throw new Error("GoalRun recovery lease lost");
        const graph = await this.store.getGraph?.(graphId);
        if (graph?.status === "ready" && this.orchestrator) {
          await defaultTraceContext.run({ projectId: "coordinator", sessionId: goal.conversationId, conversationId: goal.conversationId, goalRunId: goal.goalRunId, goalTurnFence: fence, traceId: crypto.randomUUID() }, () => this.orchestrator!.startGraph(graphId));
        }
      }
      if (leaseLost) throw new Error("GoalRun recovery lease lost");
      const message: WebMessageRecord = {
        id: `msg-recovery-${crypto.createHash("sha256").update(`${goal.goalRunId}:${lease.turnId}`).digest("hex").slice(0, 20)}`,
        conversationId: goal.conversationId, sender: "assistant", messageType: "text", timestamp: Date.now(),
        content: "阶段性报告：协调器在回答持久化前中断。已保留的任务和探查将按其持久化状态继续核对；尚未检查的范围和未保存的回答不能确认。",
        metadata: { goalRunId: goal.goalRunId, goalRunTurnId: lease.turnId, reportKind: "interim", recoveredTurn: true },
      };
      const committed = await this.store.commitGoalTurnResponse(goal.goalRunId, message, fence);
      if (committed.inserted) this.eventBus?.emit({ id: crypto.randomUUID(), type: "conversation.message_created" as any,
        timestamp: new Date().toISOString(), projectId: "coordinator", sessionId: goal.conversationId,
        data: { conversationId: goal.conversationId, message } });
      return processGoalRun(this.store, goal.goalRunId);
    } finally { clearInterval(timer); }
  }

  close(): void {
    if (this.goalRecoveryTimer) clearInterval(this.goalRecoveryTimer);
    this.productApi?.close();
    for (const unsubscribe of this.eventSubscriptions.splice(0)) unsubscribe();
    for (const entry of this.activeConversationTurns.values()) entry.abortController.abort(new Error("Coordinator stopping"));
    this.activeConversationTurns.clear();
    for (const response of this.globalSseClients) response.end();
    this.globalSseClients.clear();
    for (const response of this.sessionStreams.keys()) response.end();
    this.sessionStreams.clear();
  }

  public broadcastGlobalSse(eventType: string, data: any): void {
    const seq = ++this.globalEventSeq;
    // 回放序号只放在 SSE 的 `id:` 帧字段，绝不写进 data 载荷：
    // 前端 tasks store 用 data.seq 做「任务内」事件去重，注入全局序号会让
    // 合法事件被误判为重复而静默丢弃（进度因此不再刷新）。
    const payload = `id: ${seq}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    this.globalEventReplay.push({ seq, frame: payload });
    if (this.globalEventReplay.length > ClusterApiHandler.GLOBAL_REPLAY_LIMIT) this.globalEventReplay.shift();
    for (const client of this.globalSseClients) {
      try {
        if (client.writableLength > 1024 * 1024) { client.destroy(); this.globalSseClients.delete(client); continue; }
        client.write(payload);
      } catch {
        this.globalSseClients.delete(client);
      }
    }
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.dispatchRequest(req, res);
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) { res.end(); return; }
      const frozen = error instanceof AdmissionFrozenError;
      const status = error instanceof WebRequestError ? error.status : frozen ? 409 : 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(frozen
        ? { error: error.message, code: "ADMISSION_FROZEN" }
        : { error: error instanceof WebRequestError ? error.message : "请求处理失败，请稍后重试" }));
    }
  }

  private async dispatchRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method?.toUpperCase();

    if (!acceptsOrigin(req, this.allowedOrigins, this.trustProxy)) throw new WebRequestError(403, "请求来源不受信任");
    res.setHeader("Vary", "Origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.headers.origin) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token, Last-Event-ID");
    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (await this.productApi?.handleGateway(req, res, url)) return;

    const publicApi = pathname === "/api/auth/login" || pathname === "/api/auth/logout";
    const protectedPage = !pathname.startsWith("/api/") && pathname !== "/login" && !path.extname(pathname);
    if ((pathname.startsWith("/api/") && !publicApi) || protectedPage || pathname === "/index.html") {
      const auth = await this.authenticateRequest(req, res);
      if (!auth.authenticated) {
        if (protectedPage || pathname === "/index.html") {
          res.writeHead(302, { Location: `/login?redirect=${encodeURIComponent(pathname + url.search)}` });
          res.end();
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "未登录或登录会话已过期", authenticated: false }));
        }
        return;
      }
      if (auth.user?.role === "viewer" && ["POST", "PUT", "PATCH", "DELETE"].includes(method ?? "")) {
        throw new WebRequestError(403, "当前账号没有执行权限");
      }
      if (pathname.endsWith("/stream") && auth.session) this.trackSessionStream(res, auth.session);
      if (auth.user && await this.productApi?.handle(req, res, url, auth.user)) return;
    }

    try {
      // ============================================================
      // Phase 5: Web Control Plane & Authentication Endpoints
      // ============================================================
      if (method === "POST" && pathname === "/api/auth/login") {
        await this.handleAuthLogin(req, res);
      } else if (method === "POST" && pathname === "/api/auth/logout") {
        await this.handleAuthLogout(req, res);
      } else if (method === "GET" && pathname === "/api/auth/me") {
        await this.handleAuthMe(req, res);
      } else if (method === "GET" && pathname === "/api/cluster/events/stream") {
        await this.handleGlobalEventStream(req, res);
      // ============================================================
      // Phase 5: Web Conversations & Chat Workspace Endpoints
      // ============================================================
      } else if (method === "POST" && (pathname === "/api/ai/optimize-prompt" || pathname === "/api/cluster/ai/optimize-prompt")) {
        await this.handleOptimizePrompt(req, res);
      } else if (method === "GET" && pathname === "/api/cluster/conversations") {
        await this.handleListConversations(url, res);
      } else if (method === "GET" && pathname === "/api/cluster/goal-runs") {
        const goals = await this.store.listGoalRuns?.(url.searchParams.get("conversationId") ?? undefined) ?? [];
        const current = await Promise.all(goals.map(async goal => {
          try { return await processGoalRun(this.store, goal.goalRunId); }
          catch { return await this.store.getGoalRun?.(goal.goalRunId) ?? goal; }
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        const enriched = await Promise.all(current.map(async goal => ({ ...goal,
          taskSummaries: (await Promise.all(goal.linkedTaskIds.map(taskId => this.store.getTask(taskId)))).filter(task => task !== null).map(task => ({
            taskId: task.taskId, status: task.status,
            dispatchOptions: { graphContext: task.dispatchOptions?.graphContext ? { graphId: task.dispatchOptions.graphContext.graphId, graphNodeId: task.dispatchOptions.graphContext.graphNodeId } : undefined,
              contextOverrides: { taskType: task.dispatchOptions?.contextOverrides?.taskType, recoveryOf: task.dispatchOptions?.contextOverrides?.recoveryOf } },
          })),
        })));
        res.end(JSON.stringify({ goals: enriched }));
      } else if (method === "POST" && pathname === "/api/cluster/conversations") {
        await this.handleCreateConversation(req, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/conversations\/([^/]+)$/)) {
        const id = pathname.split("/")[4]!;
        await this.handleGetConversation(id, res);
      } else if (method === "PATCH" && pathname.match(/^\/api\/cluster\/conversations\/([^/]+)$/)) {
        const id = pathname.split("/")[4]!;
        await this.handleUpdateConversation(id, req, res);
      } else if (method === "DELETE" && pathname.match(/^\/api\/cluster\/conversations\/([^/]+)$/)) {
        const id = pathname.split("/")[4]!;
        await this.handleDeleteConversation(id, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/conversations\/([^/]+)\/usage$/)) {
        const conversationId = pathname.split("/")[4]!;
        const conversation = await this.store.getConversation?.(conversationId);
        const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 100);
        if (!conversation) { res.writeHead(404); res.end(JSON.stringify({error:"Conversation not found"})); }
        else if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) { res.writeHead(400); res.end(JSON.stringify({error:"Invalid paging"})); }
        else { const items=await this.store.listModelUsage?.({conversationId,offset,limit}) ?? [];res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify({conversationId,items,nextOffset:items.length===limit?offset+limit:null,scope:"All observed conversation requests, including independently traced titles; paged evidence"})); }
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/conversations\/([^/]+)\/generate-title$/)) {
        const id = pathname.split("/")[4]!;
        await this.handleGenerateConversationTitle(id, req, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/conversations\/([^/]+)\/messages$/)) {
        const id = pathname.split("/")[4]!;
        await this.handleConversationMessage(id, req, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/conversations\/([^/]+)\/cancel$/)) {
        const id = pathname.split("/")[4]!;
        await this.handleCancelConversation(id, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/conversations\/([^/]+)\/interrupt$/)) {
        const id = pathname.split("/")[4]!;
        await this.handleInterruptConversation(id, res);
      // ============================================================
      // Phase 5: Artifact Exchange & Preview Endpoints
      // ============================================================
      } else if (method === "GET" && pathname === "/api/cluster/artifacts") {
        await this.handleListArtifacts(url, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/artifacts\/([^/]+)$/)) {
        const artId = pathname.split("/")[4]!;
        await this.handleGetArtifactDetails(artId, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/artifacts\/([^/]+)\/content$/)) {
        const artId = pathname.split("/")[4]!;
        await this.handleGetArtifactContent(artId, req, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/artifacts\/([^/]+)\/download$/)) {
        const artId = pathname.split("/")[4]!;
        await this.handleDownloadArtifact(artId, req, res);
      } else if (method === "GET" && pathname === "/api/cluster/admission") {
        await this.handleGetAdmission(res);
      } else if (method === "POST" && pathname === "/api/cluster/admission/freeze") {
        await this.handleFreezeAdmission(req, res);
      } else if (method === "POST" && pathname === "/api/cluster/admission/unfreeze") {
        await this.handleUnfreezeAdmission(req, res);
      } else if (method === "POST" && pathname === "/api/cluster/admission/drain") {
        await this.handleDrainAdmission(req, res);
      } else if (method === "GET" && pathname === "/api/cluster/status") {
        await this.handleGetStatus(res);
      } else if (method === "GET" && pathname === "/api/cluster/nodes") {
        await this.handleGetNodes(res);
      } else if (method === "POST" && pathname === "/api/cluster/invite") {
        await this.handleCreateInvite(req, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/nodes\/([^/]+)\/rotate-token$/)) {
        const nodeId = pathname.split("/")[4]!;
        await this.handleRotateNodeToken(nodeId, req, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/nodes\/([^/]+)\/revoke$/)) {
        const nodeId = pathname.split("/")[4];
        await this.handleRevokeNode(nodeId, req, res);
      } else if (method === "GET" && pathname === "/api/cluster/tasks") {
        await this.handleGetTasks(url, res);
      } else if (method === "POST" && pathname === "/api/cluster/tasks") {
        await this.handleCreateTask(req, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/tasks\/([^/]+)$/)) {
        const taskId = pathname.split("/")[4];
        await this.handleGetTaskDetails(taskId, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/tasks\/([^/]+)\/events$/)) {
        const taskId = pathname.split("/")[4];
        await this.handleGetTaskEvents(taskId, url, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/tasks\/([^/]+)\/stream$/)) {
        const taskId = pathname.split("/")[4];
        await this.handleTaskEventStream(taskId, req, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/tasks\/([^/]+)\/steer$/)) {
        const taskId = pathname.split("/")[4];
        await this.handleSteerTask(taskId, req, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/tasks\/([^/]+)\/interrupt$/)) {
        const taskId = pathname.split("/")[4];
        await this.handleInterruptTask(taskId, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/tasks\/([^/]+)\/revoke-grant$/)) {
        const taskId = pathname.split("/")[4];
        await this.handleRevokeTaskGrant(taskId, req, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/tasks\/([^/]+)\/cancel$/)) {
        const taskId = pathname.split("/")[4];
        await this.handleCancelTask(taskId, req, res);
      } else if (method === "GET" && pathname === "/api/cluster/approvals") {
        await this.handleGetApprovals(req, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/approvals\/([^/]+)\/resolve$/)) {
        const approvalId = pathname.split("/")[4];
        await this.handleResolveApproval(approvalId, req, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/approvals\/([^/]+)\/grant-full-access$/)) {
        const approvalId = pathname.split("/")[4];
        await this.handleGrantTaskFullAccess(approvalId, req, res);
      // ============================================================
      // Phase 2: Cluster Catalog & Federated Memory Endpoints
      // ============================================================
      } else if (method === "GET" && pathname === "/api/cluster/catalog/nodes") {
        await this.handleCatalogNodes(url, res);
      } else if (method === "GET" && pathname === "/api/cluster/catalog/projects") {
        await this.discoveryService?.recoverHistoricalReports();
        await this.handleCatalogProjects(url, res);
      } else if (method === "GET" && pathname === "/api/cluster/catalog/skills") {
        await this.handleCatalogSkills(url, res);
      } else if (method === "GET" && pathname === "/api/cluster/catalog/mcp") {
        await this.handleCatalogMCP(url, res);
      } else if (method === "GET" && pathname === "/api/cluster/catalog/status") {
        await this.handleCatalogStatus(res);
      } else if (method === "POST" && pathname === "/api/cluster/catalog/search") {
        await this.handleCatalogSearch(req, res);
      } else if (method === "GET" && pathname === "/api/cluster/memory/index") {
        await this.discoveryService?.recoverHistoricalReports();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ entries: await this.store.listMemoryIndex({}) }));
      } else if (method === "POST" && pathname === "/api/cluster/memory/search") {
        await this.discoveryService?.recoverHistoricalReports();
        await this.handleMemorySearch(req, res);
      } else if (method === "POST" && pathname === "/api/cluster/memory/search-remote") {
        await this.handleMemorySearchRemote(req, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/projects\/([^/]+)$/)) {
        const projId = pathname.split("/")[4];
        await this.handleGetProjectDetails(projId, url, res);
      // ============================================================
      // Phase 6: Autonomous Discovery & Coordinator Main Agent Endpoints
      // ============================================================
      } else if (method === "POST" && pathname === "/api/cluster/discovery/run") {
        await this.handleRunDiscovery(req, res);
      // ============================================================
      // Phase 3: Semantic Task Router & Autonomous Dispatch Endpoints
      // ============================================================
      } else if (method === "POST" && pathname === "/api/cluster/route") {
        await this.handleRouteTask(req, res);
      } else if (method === "POST" && pathname === "/api/cluster/run") {
        await this.handleRunAutonomous(req, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/routes\/([^/]+)$/)) {
        const routeId = pathname.split("/")[4];
        await this.handleGetRouteDetails(routeId, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/routes\/([^/]+)\/candidates$/)) {
        const routeId = pathname.split("/")[4];
        await this.handleGetRouteCandidates(routeId, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/routes\/([^/]+)\/clarify$/)) {
        const sessionId = pathname.split("/")[4];
        await this.handleRouteClarify(sessionId, req, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/tasks\/([^/]+)\/replan$/)) {
        const taskId = pathname.split("/")[4];
        await this.handleTaskReplan(taskId, req, res);
      // ============================================================
      // Phase 4: Distributed TaskGraph & A2A Endpoints
      // ============================================================
      } else if (method === "POST" && pathname === "/api/cluster/graphs/plan") {
        await this.handleGraphPlan(req, res);
      } else if (method === "POST" && pathname === "/api/cluster/graphs/run") {
        await this.handleGraphRun(req, res);
      } else if (method === "GET" && pathname === "/api/cluster/graphs") {
        await this.handleListGraphs(url, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/graphs\/([^/]+)$/)) {
        const graphId = pathname.split("/")[4];
        await this.handleGetGraphDetails(graphId, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/graphs\/([^/]+)\/(?:usage|trace)$/)) {
        await this.handleRuntimeEvidence(pathname.split("/")[4]!, pathname.endsWith("/trace"), url, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/graphs\/([^/]+)\/tasks$/)) {
        const graphId = pathname.split("/")[4];
        await this.handleGetGraphTasks(graphId, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/graphs\/([^/]+)\/artifacts$/)) {
        const graphId = pathname.split("/")[4];
        await this.handleGetGraphArtifacts(graphId, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/graphs\/([^/]+)\/events$/)) {
        const graphId = pathname.split("/")[4];
        await this.handleGetGraphEvents(graphId, url, res);
      } else if (method === "GET" && pathname.match(/^\/api\/cluster\/graphs\/([^/]+)\/stream$/)) {
        const graphId = pathname.split("/")[4];
        await this.handleGraphEventStream(graphId, req, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/graphs\/([^/]+)\/steer$/)) {
        const graphId = pathname.split("/")[4];
        await this.handleGraphSteer(graphId, req, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/graphs\/([^/]+)\/pause$/)) {
        const graphId = pathname.split("/")[4];
        await this.handleGraphPause(graphId, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/graphs\/([^/]+)\/resume$/)) {
        const graphId = pathname.split("/")[4];
        await this.handleGraphResume(graphId, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/graphs\/([^/]+)\/cancel$/)) {
        const graphId = pathname.split("/")[4];
        await this.handleGraphCancel(graphId, req, res);
      } else if (method === "POST" && pathname.match(/^\/api\/cluster\/graphs\/([^/]+)\/replan$/)) {
        const graphId = pathname.split("/")[4]!;
        await this.handleGraphManualReplan(graphId, req, res);
      // ============================================================
      // Phase 5: Scheduled Agents & Tasks Endpoints
      // ============================================================
      } else if (method === "GET" && (pathname === "/api/cluster/scheduled-tasks" || pathname === "/api/cluster/schedules")) {
        await this.handleListScheduledTasks(url, res);
      } else if (method === "POST" && (pathname === "/api/cluster/scheduled-tasks" || pathname === "/api/cluster/schedules")) {
        await this.handleCreateScheduledTask(req, res);
      } else if (method === "GET" && (pathname.match(/^\/api\/cluster\/scheduled-tasks\/([^/]+)$/) || pathname.match(/^\/api\/cluster\/schedules\/([^/]+)$/))) {
        const id = pathname.split("/")[4]!;
        await this.handleGetScheduledTaskDetails(id, res);
      } else if (method === "PATCH" && (pathname.match(/^\/api\/cluster\/scheduled-tasks\/([^/]+)$/) || pathname.match(/^\/api\/cluster\/schedules\/([^/]+)$/))) {
        const id = pathname.split("/")[4]!;
        await this.handleUpdateScheduledTask(id, req, res);
      } else if (method === "DELETE" && (pathname.match(/^\/api\/cluster\/scheduled-tasks\/([^/]+)$/) || pathname.match(/^\/api\/cluster\/schedules\/([^/]+)$/))) {
        const id = pathname.split("/")[4]!;
        await this.handleDeleteScheduledTask(id, res);
      } else if (method === "POST" && (pathname.match(/^\/api\/cluster\/scheduled-tasks\/([^/]+)\/pause$/) || pathname.match(/^\/api\/cluster\/schedules\/([^/]+)\/pause$/))) {
        const id = pathname.split("/")[4]!;
        await this.handlePauseScheduledTask(id, res);
      } else if (method === "POST" && (pathname.match(/^\/api\/cluster\/scheduled-tasks\/([^/]+)\/resume$/) || pathname.match(/^\/api\/cluster\/schedules\/([^/]+)\/resume$/))) {
        const id = pathname.split("/")[4]!;
        await this.handleResumeScheduledTask(id, res);
      } else if (method === "POST" && (pathname.match(/^\/api\/cluster\/scheduled-tasks\/([^/]+)\/run$/) || pathname.match(/^\/api\/cluster\/schedules\/([^/]+)\/run$/))) {
        const id = pathname.split("/")[4]!;
        await this.handleRunScheduledTaskNow(id, req, res);
      } else if (method === "GET" && (pathname.match(/^\/api\/cluster\/scheduled-tasks\/([^/]+)\/history$/) || pathname.match(/^\/api\/cluster\/schedules\/([^/]+)\/(history|runs|executions)$/))) {
        const id = pathname.split("/")[4]!;
        await this.handleGetScheduledTaskHistory(id, url, res);
      // ============================================================
      // Phase 5: Security Decision Audit Endpoints
      // ============================================================
      } else if (method === "GET" && (pathname === "/api/cluster/security/audits" || pathname === "/api/cluster/security/decisions")) {
        await this.handleListSecurityAudits(url, res);
      } else if (method === "GET" && pathname === "/api/cluster/security/stats") {
        await this.handleGetSecurityAuditStats(url, res);
      } else if (method === "GET" && (pathname.match(/^\/api\/cluster\/security\/audits\/([^/]+)$/) || pathname.match(/^\/api\/cluster\/security\/decisions\/([^/]+)$/))) {
        const id = pathname.split("/")[5]!;
        await this.handleGetSecurityAuditDetails(id, res);
      } else if (method === "POST" && (pathname.match(/^\/api\/cluster\/security\/audits\/([^/]+)\/feedback$/) || pathname.match(/^\/api\/cluster\/security\/decisions\/([^/]+)\/review$/))) {
        const id = pathname.split("/")[5]!;
        await this.handleSubmitSecurityAuditFeedback(id, req, res);
      } else if (method === "GET" && this.shouldServeStatic(pathname)) {
        await this.handleServeStatic(pathname, res);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Endpoint not found" }));
      }
    } catch (err) {
      throw err;
    }
  }

  // ============================================================
  // 准入 / 排空 (Admission Control)
  // ============================================================
  private requireAdmission(): AdmissionControl {
    if (!this.admission) throw new WebRequestError(503, "准入控制尚未就绪");
    return this.admission;
  }

  private async handleGetAdmission(res: ServerResponse): Promise<void> {
    const snapshot = await this.requireAdmission().snapshot();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(snapshot));
  }

  private async handleFreezeAdmission(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.requireAdministrator(req, res);
    const body = await this.parseJsonBody(req);
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;
    const state = this.requireAdmission().freeze("admin", reason);
    const snapshot = await this.requireAdmission().snapshot();
    this.eventBus?.emit({ id: crypto.randomUUID(), type: "admission.frozen" as any, timestamp: Date.now(), data: { ...state, reason } } as any);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ admission: state, snapshot }));
  }

  private async handleUnfreezeAdmission(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.requireAdministrator(req, res);
    await this.parseJsonBody(req);
    const state = this.requireAdmission().unfreeze();
    this.eventBus?.emit({ id: crypto.randomUUID(), type: "admission.unfrozen" as any, timestamp: Date.now(), data: state } as any);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ admission: state }));
  }

  private async handleDrainAdmission(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.requireAdministrator(req, res);
    const body = await this.parseJsonBody(req);
    // timeoutMs 既可从请求体读取（集群 API 约定），也可从查询参数读取（与本机控制端点和 CLI 一致）。
    const queryTimeout = Number(new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("timeoutMs"));
    const requestedTimeout = typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs) ? body.timeoutMs : queryTimeout;
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(Math.max(requestedTimeout, 1000), 600_000)
      : 120_000;
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : "operator drain";
    const admission = this.requireAdmission();
    const state = admission.freeze("admin", reason);
    this.eventBus?.emit({ id: crypto.randomUUID(), type: "admission.frozen" as any, timestamp: Date.now(), data: state } as any);
    const snapshot = await admission.waitForSettled({ timeoutMs, pollMs: 2000, consecutive: 2 });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ admission: state, snapshot }));
  }

  private async handleGetStatus(res: ServerResponse): Promise<void> {
    const rawNodes = await this.store.listNodes();
    const counts = this.store.getTaskCounts ? await this.store.getTaskCounts() : await this.store.listTasks({ limit: 100 }).then(tasks => ({ total: tasks.length, running: tasks.filter(t => t.status === "running").length }));
    const onlineConns = this.registry.listOnlineConnections();
    const onlineNodeIds = new Set(onlineConns.map((c) => c.nodeId));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        coordinatorNodeId: this.coordinatorNodeId,
        runtimeRelease,
        totalNodes: rawNodes.filter(node => node.status !== "revoked").length,
        historicalNodes: rawNodes.filter(node => node.status === "revoked").length,
        onlineNodes: onlineNodeIds.size,
        totalTasks: counts.total,
        runningTasks: counts.running,
        pendingApprovals: (await this.store.listPendingApprovals()).length,
        timestamp: Date.now(),
      })
    );
  }

  private async handleGetNodes(res: ServerResponse): Promise<void> {
    const rawNodes = await this.store.listNodes();
    const nodes = await Promise.all(
      rawNodes.map(async (n) => {
        const conn = this.registry.getConnection(n.nodeId);
        const isOnline = !!conn;
        const catRev = await this.store.getCatalogRevision(n.nodeId);
        const sandboxCap = (catRev?.capabilities ?? []).find((c) => c.category === "sandbox");

        let environmentType = "linux_cloud";
        let displayTag = "Linux Cloud";
        if (n.platform === "win32") {
          environmentType = "windows_native";
          displayTag = "Windows Native";
        } else if (n.platform === "darwin") {
          environmentType = "macos";
          displayTag = "macOS";
        } else if (
          n.platform === "linux" &&
          (n.hostname.toLowerCase().includes("wsl") ||
            n.hostname.toLowerCase().includes("subsystem") ||
            n.name.toLowerCase().includes("wsl"))
        ) {
          environmentType = "wsl2";
          displayTag = "WSL2";
        }

        const displayName = n.name.includes("(") ? n.name : `${n.name} (${displayTag})`;

        const { tokenHash: _tokenHash, ...publicNode } = n;
        return {
          ...publicNode,
          displayName,
          environmentType,
          status: n.status === "revoked" ? "revoked" : isOnline ? "online" : "offline",
          lastSeenAt: conn?.lastHeartbeatAt ?? n.lastSeenAt,
          connectionGeneration: conn?.generation,
          runtimeRelease: conn?.metadata.runtimeRelease ?? null,
          catalogRevision: catRev?.revision ?? 0,
          capabilities: catRev?.capabilities ?? [],
          sandboxCapability: sandboxCap,
        };
      })
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ nodes }));
  }

  private async handleCreateInvite(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.requireAdministrator(req, res);
    const body = await this.parseJsonBody(req);
    if ((body.role !== undefined && !["worker", "coordinator-worker"].includes(body.role)) || (body.maxUses !== undefined && body.maxUses !== 1) || (body.ttlMs !== undefined && (!Number.isSafeInteger(body.ttlMs) || body.ttlMs < 60000 || body.ttlMs > 7 * 24 * 3600 * 1000))) throw new WebRequestError(400, "邀请必须为单次使用，有效期为 1 分钟至 7 天");
    const invite = this.inviteManager.createInvite({
      role: body.role,
      ttlMs: body.ttlMs,
      maxUses: body.maxUses,
    });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(invite));
  }

  /**
   * 轮换节点凭证：请求体只接受新凭证的 SHA-256（64 位小写十六进制）。
   * 明文 Token 由节点本地生成并留在节点上，协调器不接收、不回显、不落日志。
   */
  private async handleRotateNodeToken(nodeId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.requireAdministrator(req, res);
    const body = await this.parseJsonBody(req);
    const tokenHash = typeof body.tokenHash === "string" ? body.tokenHash.trim().toLowerCase() : "";
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new WebRequestError(400, "tokenHash must be a lowercase hex SHA-256 of the new node credential");
    const node = await this.store.getNode(nodeId);
    if (!node) throw new WebRequestError(404, `Node ${nodeId} not found`);
    if (node.status === "revoked") throw new WebRequestError(409, `Node ${nodeId} has been revoked; issue a new invite instead`);
    const ok = await this.registry.rotateNodeToken(nodeId, tokenHash);
    if (!ok) throw new WebRequestError(409, `Node ${nodeId} credential rotation was rejected`);
    res.writeHead(200, { "Content-Type": "application/json" });
    // 响应只确认结果，绝不包含任何凭证材料。
    res.end(JSON.stringify({ success: true, nodeId, rotatedAt: Date.now() }));
  }

  private async handleRevokeNode(nodeId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.requireAdministrator(req, res);
    const ok = await this.registry.revokeNode(nodeId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: ok, nodeId }));
  }

  private async handleGetTasks(url: URL, res: ServerResponse): Promise<void> {
    const nodeId = url.searchParams.get("nodeId") ?? undefined;
    const status = (url.searchParams.get("status") as any) ?? undefined;
    const limit = Number(url.searchParams.get("limit")) || 50;

    const kind = url.searchParams.get("kind");
    if (kind && !["scout", "graph", "plain"].includes(kind)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown kind; expected scout|graph|plain" }));
      return;
    }

    // 执行种类以持久化的 dispatchOptions 为唯一权威，不再靠 goal 文案前缀猜测。
    const classified = (await this.store.listTasks({ nodeId, status, limit })).map((task) => {
      const overrides = (task.dispatchOptions?.contextOverrides ?? {}) as Record<string, unknown>;
      const executionKind: "graph" | "scout" | "plain" =
        task.dispatchOptions?.graphContext ? "graph" : overrides.isDiscovery ? "scout" : "plain";
      return { ...task, isScout: executionKind === "scout", executionKind };
    });
    const tasks = kind ? classified.filter((task) => task.executionKind === kind) : classified;

    const tasksWithGrants = await Promise.all(tasks.map(async (task) => {
      const activeGrant = task.runId ? await this.store.getActiveTaskSecurityGrant?.(task.taskId, task.runId) : null;
      return activeGrant ? { ...task, activeGrant } : task;
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks: tasksWithGrants }));
  }

  private async handleCreateTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.admission?.assertAdmitting("task creation");
    const body = await this.parseJsonBody(req);
    if (!body.nodeId || !body.projectId || !body.goal) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: nodeId, projectId, goal" }));
      return;
    }

    const requiredPolicy = body.requiredPolicy;
    if (requiredPolicy && (!requiredPolicy.filesystem || !["read-only", "workspace-write", "full-capability", "danger-full-access"].includes(requiredPolicy.filesystem) ||
        !requiredPolicy.network || !["allow", "deny"].includes(requiredPolicy.network))) throw new WebRequestError(400, "Invalid sandbox policy");
    const contextOverrides = { readOnly: body.readOnly === true, requiredPolicy };
    const target = await new RoutingValidator(this.store, this.registry).validateCandidate(
      { nodeId: body.nodeId, projectId: body.projectId }, { constraints: contextOverrides, requiredCapabilities: [] });
    if (!target.valid) throw new WebRequestError(422, target.reason);

    const task = await this.scheduler.createTask({
      nodeId: body.nodeId,
      projectId: body.projectId,
      goal: body.goal,
      prompt: body.prompt,
      timeoutMs: body.timeoutMs,
      maxSteps: body.maxSteps,
      contextOverrides,
    });

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ task }));
  }

  private async handleGetTaskDetails(taskId: string, res: ServerResponse): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Task ${taskId} not found` }));
      return;
    }

    const events = await this.store.getEventsForTask(taskId, 0, 500);
    const projection = TaskStateProjection.project(task, events);
    const activeGrant = task.runId ? await this.store.getActiveTaskSecurityGrant?.(taskId, task.runId) : null;
    // 任务进入终态后授权必须自动失效，避免 UI/审计长期显示「全访问」。
    if (activeGrant && CLUSTER_TASK_TERMINAL.has(task.status)) {
      await this.store.expireTaskSecurityGrantsForTask?.(taskId);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      task: activeGrant ? { ...task, activeGrant } : task,
      projection,
      activeGrant,
    }));
  }

  private async handleGetTaskEvents(taskId: string, url: URL, res: ServerResponse): Promise<void> {
    const fromSeq = Number(url.searchParams.get("fromSeq")) || 0;
    const limit = Number(url.searchParams.get("limit")) || 500;

    const events = await this.store.getEventsForTask(taskId, fromSeq, limit);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ taskId, fromSeq, events }));
  }

  /**
   * SSE (Server-Sent Events) 实时订阅指定任务执行事件流
   */
  private readEventCursor(req: IncomingMessage): number {
    const query = new URL(req.url ?? "/", "http://localhost").searchParams.get("lastEventId");
    const cursor = Number(req.headers["last-event-id"] ?? query ?? 0);
    return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
  }

  private async handleTaskEventStream(taskId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Task ${taskId} not found` }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "stream.connected", taskId })}\n\n`);

    let lastSeq = this.readEventCursor(req);
    // 1. 先推送历史事件
    const existing = await this.store.getEventsForTask(taskId, lastSeq + 1, 500);
    for (const ev of existing) {
      res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
      if (ev.seq > lastSeq) lastSeq = ev.seq;
    }

    pollStream(res, 500, async () => {
      const fresh = await this.store.getEventsForTask(taskId, lastSeq + 1, 100);
      for (const ev of fresh) {
        res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
        lastSeq = Math.max(lastSeq, ev.seq);
      }
      const current = await this.store.getTask(taskId);
      if (current && ["completed", "failed", "cancelled"].includes(current.status) && !fresh.length) {
        res.write(`data: ${JSON.stringify({ type: "stream.ended", status: current.status })}\n\n`);
        res.end();
      }
    });
  }

  private async handleSteerTask(taskId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseJsonBody(req);
    const content = body.content || body.steerContent;
    if (!content) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required field: content or steerContent" }));
      return;
    }

    const result = await this.scheduler.sendControl(taskId, "steer", {
      steerContent: content,
    });
    res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  }

  private async handleInterruptTask(taskId: string, res: ServerResponse): Promise<void> {
    const result = await this.scheduler.sendControl(taskId, "interrupt");
    res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  }

  private async handleCancelTask(taskId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseJsonBody(req);
    const result = await this.scheduler.sendControl(taskId, "cancel", {
      reason: body.reason,
    });
    res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  }

  private async handleGetApprovals(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await this.authenticateRequest(req, res);
    // 任务级全访问是管理员级权限：非管理员在 UI 上不得看到可点击的授权入口。
    // 服务端的写接口仍会独立校验角色（403），这里只是保持一致的可操作视图。
    const isAdmin = auth.user?.role === "admin";
    const approvals = await this.store.listPendingApprovals();
    const globalSecurity = this.productStore?.getPublicConfig().security;
    const globalPolicy = globalSecurity ? {
      filesystem: { mode: globalSecurity.filesystem },
      network: { mode: globalSecurity.network },
      approval: { mode: globalSecurity.approval },
    } : undefined;
    const enrichedPending = await Promise.all(approvals.map(async (appr) => {
      const task = await this.store.getTask(appr.taskId);
      const activeGrant = await this.store.getActiveTaskSecurityGrant?.(appr.taskId, appr.runId);
      const eligibility = this.taskSecurityGrants
        ? await this.taskSecurityGrants.eligibility(appr)
        : { canGrant: false, reason: "任务级安全授权服务未初始化" };
      return {
        ...appr,
        taskStatus: task?.status,
        nodeOnline: this.taskSecurityGrants?.isNodeOnline(appr.nodeId) ?? false,
        currentPolicy: activeGrant?.targetPolicy ?? globalPolicy,
        activeGrant,
        grantEligible: isAdmin && eligibility.canGrant,
        grantIneligibleReason: isAdmin ? eligibility.reason : "仅管理员可授予任务级全访问权限",
        pendingGrant: eligibility.pendingGrant ?? null,
      };
    }));
    const history = await this.store.listApprovalHistory?.() ?? [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ approvals: enrichedPending, history }));
  }

  private async handleResolveApproval(approvalId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseJsonBody(req);
    const decision = body.decision;
    if (decision !== "allow-once" && decision !== "deny") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Decision must be 'allow-once' or 'deny'" }));
      return;
    }

    const approval = await this.store.getApproval(approvalId);
    if (!approval) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Approval ${approvalId} not found` }));
      return;
    }

    if (approval.expiresAt <= Date.now()) throw new WebRequestError(409, "审批已过期");
    const resolved = await this.store.resolveApproval(approvalId, decision, body.resolvedBy ?? "web-user");
    const current = await this.store.getApproval(approvalId);
    if (!resolved && (current?.status !== "resolved" || current.decision !== decision)) {
      throw new WebRequestError(409, "审批已有不同裁决");
    }
    await this.scheduler.queueApprovalResolution(approvalId);

    const pendingApprovals = (await this.store.listPendingApprovals()).length;

    res.writeHead(200, { "Content-Type": "application/json" });
    this.eventBus?.emit({ id: crypto.randomUUID(), type: "approval.resolved" as any,
      timestamp: new Date().toISOString(), projectId: "coordinator", sessionId: approval.taskId,
      data: { approvalId, taskId: approval.taskId, runId: approval.runId, decision, pendingApprovals } });

    // 立即向全局 SSE 客户端广播最新心跳快照，彻底消除定时心跳延迟
    try {
      const runningTasks = this.store.getTaskCounts ? (await this.store.getTaskCounts()).running : (await this.store.listTasks({ status: "running", limit: 100000 })).length;
      this.broadcastGlobalSse("cluster.heartbeat", {
        onlineNodes: this.registry.listOnlineConnections().filter((connection) => connection.ws.readyState === 1).length,
        pendingApprovals,
        runningTasks,
        timestamp: Date.now(),
      });
    } catch {}

    res.end(JSON.stringify({ success: true, approvalId, decision, deliveryStatus: "pending", message: "裁决已保存，等待执行节点确认" }));
  }

  private async handleGrantTaskFullAccess(approvalId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await this.authenticateRequest(req, res);
    if (!auth.authenticated || auth.user?.role !== "admin") {
      throw new WebRequestError(403, "仅管理员有权为任务授予全访问权限");
    }
    if (!this.taskSecurityGrants) throw new WebRequestError(503, "任务级安全授权服务未初始化");

    const outcome = await this.taskSecurityGrants.requestGrant(approvalId, {
      username: auth.user.username,
      role: auth.user.role,
    });

    const task = await this.store.getTask(outcome.taskId);
    const pendingApprovals = (await this.store.listPendingApprovals()).length;
    this.eventBus?.emit({
      id: crypto.randomUUID(),
      type: "approval.resolved" as any,
      timestamp: new Date().toISOString(),
      projectId: task?.projectId ?? "coordinator",
      sessionId: outcome.taskId,
      data: {
        approvalId, taskId: outcome.taskId, runId: outcome.runId,
        decision: "grant-task-full-access", grantId: outcome.grantId, pendingApprovals,
      },
    });

    try {
      const runningTasks = this.store.getTaskCounts ? (await this.store.getTaskCounts()).running : (await this.store.listTasks({ status: "running", limit: 100000 })).length;
      this.broadcastGlobalSse("cluster.heartbeat", {
        onlineNodes: this.registry.listOnlineConnections().filter((c) => c.ws.readyState === 1).length,
        pendingApprovals,
        runningTasks,
        timestamp: Date.now(),
      });
    } catch { /* heartbeat 只是 UI 快照，失败不影响授权结论 */ }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      grantId: outcome.grantId,
      approvalId,
      taskId: outcome.taskId,
      runId: outcome.runId,
      applied: outcome.applied,
      status: outcome.status,
      targetPolicy: outcome.targetPolicy,
      appliesTo: outcome.appliesTo,
      message: outcome.message,
    }));
  }

  /**
   * 管理员手动撤销任务级全访问授权。
   * 只有 Worker 真实 ACK 才返回 200/confirmed；离线或未确认必须以 409 暴露，
   * 让调用方知道提权可能仍然生效（fail-closed），而不是假装撤销完成。
   */
  private async handleRevokeTaskGrant(taskId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await this.authenticateRequest(req, res);
    if (!auth.authenticated || auth.user?.role !== "admin") {
      throw new WebRequestError(403, "仅管理员有权撤销任务级全访问权限");
    }
    if (!this.taskSecurityGrants) throw new WebRequestError(503, "任务级安全授权服务未初始化");

    const body = await this.parseJsonBody(req);
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "Manual grant revocation by administrator";
    const task = await this.store.getTask(taskId);
    if (!task) throw new WebRequestError(404, `任务 ${taskId} 不存在`);

    const runId = typeof body.runId === "string" && body.runId ? body.runId : task.runId;
    let grantId = typeof body.grantId === "string" && body.grantId ? body.grantId : undefined;
    if (grantId) {
      const explicit = await this.store.getTaskSecurityGrant?.(grantId);
      // 显式 grantId 也必须属于该任务，避免跨任务撤销。
      if (!explicit || explicit.taskId !== taskId) throw new WebRequestError(404, `任务 ${taskId} 不存在授权 ${grantId}`);
    } else {
      if (!runId) throw new WebRequestError(409, "任务没有关联的 runId，无法定位授权；请显式提供 grantId");
      // getActiveTaskSecurityGrant 只返回已 ACK 的 applied 授权；
      // 尚未生效或正在撤销中的授权同样必须可被管理员撤销，因此显式回退到状态列表。
      const active = await this.store.getActiveTaskSecurityGrant?.(taskId, runId);
      if (active) {
        grantId = active.grantId;
      } else {
        const candidates = (await this.store.listTaskSecurityGrants?.({ taskId })) ?? [];
        const pending = candidates.find((item) => item.runId === runId
          && (item.status === "granted" || item.status === "applied" || item.status === "revocation_pending"));
        if (!pending) throw new WebRequestError(404, `任务 ${taskId} 当前没有可撤销的全访问授权`);
        grantId = pending.grantId;
      }
    }

    const outcome = await this.taskSecurityGrants.revokeGrant(grantId, reason, auth.user.username);

    this.eventBus?.emit({
      id: crypto.randomUUID(),
      type: "task.grant_revoked" as any,
      timestamp: new Date().toISOString(),
      projectId: task.projectId ?? "coordinator",
      sessionId: taskId,
      data: { grantId, taskId, runId, confirmed: outcome.confirmed, status: outcome.status, reason, revokedBy: auth.user.username },
    });

    res.writeHead(outcome.confirmed ? 200 : 409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: outcome.confirmed,
      confirmed: outcome.confirmed,
      ...(outcome.confirmed ? {} : { code: "REVOCATION_PENDING" }),
      grantId,
      taskId,
      runId,
      status: outcome.status,
      message: outcome.message,
      reason,
      revokedBy: auth.user.username,
    }));
  }

  private parseJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = "";
      let size = 0;
      let settled = false;
      const fail = (error: WebRequestError) => { if (!settled) { settled = true; reject(error); } };
      req.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += Buffer.byteLength(chunk);
        if (size > 1024 * 1024) { fail(new WebRequestError(413, "请求内容过大")); return; }
        data += chunk;
      });
      req.on("end", () => {
        if (settled) return;
        try {
          const body: unknown = data ? JSON.parse(data) : {};
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new WebRequestError(400, "请求必须为 JSON 对象");
          settled = true;
          resolve(body);
        } catch { fail(new WebRequestError(400, "请求 JSON 格式不正确")); }
      });
      req.on("error", () => fail(new WebRequestError(400, "请求读取失败")));
      req.on("aborted", () => fail(new WebRequestError(400, "请求已中断")));
    });
  }

  private async handleCatalogNodes(url: URL, res: ServerResponse): Promise<void> {
    if (!this.searchService) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SearchService not available" }));
      return;
    }
    const query = url.searchParams.get("query") ?? undefined;
    const nodes = await this.searchService.searchNodes(query);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ nodes }));
  }

  private async handleCatalogProjects(url: URL, res: ServerResponse): Promise<void> {
    if (!this.searchService) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SearchService not available" }));
      return;
    }
    const query = url.searchParams.get("query") ?? undefined;
    const nodeId = url.searchParams.get("nodeId") ?? undefined;
    const limit = Number(url.searchParams.get("limit")) || 50;
    const projects = await this.searchService.searchProjects(query, { nodeId, limit });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ projects }));
  }

  private async handleCatalogSkills(url: URL, res: ServerResponse): Promise<void> {
    if (!this.searchService) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SearchService not available" }));
      return;
    }
    const query = url.searchParams.get("query") ?? undefined;
    const nodeId = url.searchParams.get("nodeId") ?? undefined;
    const limit = Number(url.searchParams.get("limit")) || 50;
    const skills = await this.searchService.searchSkills(query, { nodeId, limit });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ skills }));
  }

  private async handleCatalogMCP(url: URL, res: ServerResponse): Promise<void> {
    if (!this.searchService) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SearchService not available" }));
      return;
    }
    const query = url.searchParams.get("query") ?? undefined;
    const nodeId = url.searchParams.get("nodeId") ?? undefined;
    const limit = Number(url.searchParams.get("limit")) || 50;
    const mcp = await this.searchService.searchMCPCapabilities(query, { nodeId, limit });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ mcp }));
  }

  private async handleCatalogStatus(res: ServerResponse): Promise<void> {
    const nodes = await this.store.listNodes();
    const projects = await this.store.listProjectsCatalog();
    const skills = await this.store.listSkillsCatalog();
    const mcp = await this.store.listMCPCatalog();
    const memory = await this.store.listMemoryIndex();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        nodesCount: nodes.length,
        projectsCount: projects.length,
        skillsCount: skills.length,
        mcpCount: mcp.length,
        memoryIndexCount: memory.length,
        timestamp: Date.now(),
      })
    );
  }

  private async handleCatalogSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.searchService) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SearchService not available" }));
      return;
    }
    const body = await this.parseJsonBody(req);
    const query = body.query || "";
    const deep = Boolean(body.deep);
    const topK = Number(body.topK) || 10;
    const results = await this.searchService.searchAll(query, { topK, deep });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results));
  }

  private async handleMemorySearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.searchService) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SearchService not available" }));
      return;
    }
    const body = await this.parseJsonBody(req);
    const query = body.query || "";
    const nodeId = body.nodeId;
    const projectId = body.projectId;
    const topK = Number(body.topK) || 10;
    const results = await this.searchService.searchFederatedMemory(query, {
      nodeId,
      projectId,
      deep: false,
      topK,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results }));
  }

  private async handleMemorySearchRemote(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.searchService) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SearchService not available" }));
      return;
    }
    const body = await this.parseJsonBody(req);
    const query = body.query || "";
    const nodeId = body.nodeId;
    const projectId = body.projectId;
    const topK = Number(body.topK) || 10;
    const results = await this.searchService.searchFederatedMemory(query, {
      nodeId,
      projectId,
      deep: true,
      topK,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results }));
  }

  private async handleGetProjectDetails(projectId: string, url: URL, res: ServerResponse): Promise<void> {
    const nodeId = url.searchParams.get("nodeId");
    let proj = null;
    if (nodeId) {
      proj = await this.store.getProjectCatalog(nodeId, projectId);
    } else {
      const all = await this.store.listProjectsCatalog();
      proj = all.find((p) => p.projectId === projectId) || null;
    }

    if (!proj) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Project ${projectId} not found` }));
      return;
    }

    // 关联数据聚合查询
    const targetNodeId = proj.nodeId;
    const [node, memoryEntries, skills, mcpCapabilities, recentTasks] = await Promise.all([
      this.store.getNode(targetNodeId).catch(() => null),
      this.store.listMemoryIndex({ projectId: proj.projectId }).catch(() => []),
      this.store.listSkillsCatalog({ nodeId: targetNodeId }).catch(() => []),
      this.store.listMCPCatalog({ nodeId: targetNodeId }).catch(() => []),
      this.store.listTasks({ projectId: proj.projectId, limit: 15 }).catch(() => []),
    ]);

    // 过滤与该项目相关的 skills（project 作用域匹配或 global 作用域）
    const relevantSkills = (skills || []).filter(
      (s: any) => !s.projectId || s.projectId === proj.projectId
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        project: proj,
        node: node || null,
        memory: memoryEntries || [],
        skills: relevantSkills,
        mcp: mcpCapabilities || [],
        tasks: recentTasks || [],
      })
    );
  }

  // ============================================================
  // Phase 6 Autonomous Discovery Handlers
  // ============================================================

  private async handleRunDiscovery(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.discoveryService) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "AutonomousDiscoveryService not initialized" }));
      return;
    }
    const body = await this.parseJsonBody(req);
    const query = body.query || body.goal || "";
    if (!query) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'query' in request body" }));
      return;
    }

    const result = await this.discoveryService.discover(query, {
      nodeIds: body.nodeId ? [body.nodeId] : body.nodeIds,
      scoutTimeoutMs: body.timeoutMs,
      maxScoutSteps: body.maxSteps,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  }

  // ============================================================
  // Phase 3 Semantic Router Handlers
  // ============================================================

  private async handleRouteTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.semanticRouter) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SemanticTaskRouter not initialized" }));
      return;
    }
    const body = await this.parseJsonBody(req);
    const goal = body.goal || body.prompt || body.query;
    if (!goal || typeof goal !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required 'goal' parameter in request body" }));
      return;
    }

    const routePlan = await this.semanticRouter.planRoute(goal, {
      constraints: body.constraints,
      dryRun: true,
      sessionId: body.sessionId,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(routePlan));
  }

  private async handleRunAutonomous(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.admission?.assertAdmitting("autonomous run");
    if (!this.semanticRouter) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SemanticTaskRouter not initialized" }));
      return;
    }
    const body = await this.parseJsonBody(req);
    const goal = body.goal || body.prompt;
    if (!goal || typeof goal !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required 'goal' parameter in request body" }));
      return;
    }

    const runResult = await this.semanticRouter.runAutonomous(goal, {
      constraints: body.constraints,
      dryRun: Boolean(body.dryRun),
      sessionId: body.sessionId,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(runResult));
  }

  private async handleGetRouteDetails(routeId: string, res: ServerResponse): Promise<void> {
    const route = await this.store.getRouteDecision?.(routeId);
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Route decision '${routeId}' not found` }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ route }));
  }

  private async handleGetRouteCandidates(routeId: string, res: ServerResponse): Promise<void> {
    const route = await this.store.getRouteDecision?.(routeId);
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Route decision '${routeId}' not found` }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ candidates: route.candidatesSnapshot ?? [] }));
  }

  private async handleRouteClarify(sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.semanticRouter) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SemanticTaskRouter not initialized" }));
      return;
    }
    const body = await this.parseJsonBody(req);
    const clarification = body.clarification || body.selection || body.input;
    if (!clarification || typeof clarification !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'clarification' string in request body" }));
      return;
    }

    const result = await this.semanticRouter.clarifyAndRun(sessionId, clarification);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  }

  private async handleTaskReplan(taskId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.feedbackController) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "RoutingFeedbackController not initialized" }));
      return;
    }
    const task = await this.store.getTask(taskId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Task '${taskId}' not found` }));
      return;
    }
    const body = await this.parseJsonBody(req);
    const trigger = body.trigger ?? "USER_GOAL_CHANGED";
    const details = body.details ?? "Manual replan requested via API";

    const evalResult = await this.feedbackController.evaluateIntervention(task, trigger, details);
    const replanRecord = await this.feedbackController.recordAndReconcileReplan(
      task,
      trigger,
      details,
      evalResult
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ evaluation: evalResult, replan: replanRecord }));
  }

  // ============================================================
  // Phase 4 Distributed TaskGraph Handlers
  // ============================================================

  private async handleGraphPlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.planner) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "AutonomousPlanner not initialized" }));
      return;
    }
    const body = await this.parseJsonBody(req);
    const goal = body.goal || body.prompt;
    if (!goal || typeof goal !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required 'goal' string in request body" }));
      return;
    }

    const budget = body.budget && typeof body.budget === "object" ? { ...body.budget, perTaskTimeoutSource: body.budget.perTaskTimeoutMs ? "user" : "none" } : undefined;
    const { proposal, validation } = await this.planner.planGoal(goal, budget, body.nodes);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ proposal, validation }));
  }

  private async handleGraphRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.admission?.assertAdmitting("graph run");
    if (!this.planner || !this.orchestrator) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Planner or Orchestrator not initialized" }));
      return;
    }
    const body = await this.parseJsonBody(req);
    const goal = body.goal || body.prompt;
    if (!goal || typeof goal !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required 'goal' string in request body" }));
      return;
    }

    // 1. 自动规划
    const budget = body.budget && typeof body.budget === "object" ? { ...body.budget, perTaskTimeoutSource: body.budget.perTaskTimeoutMs ? "user" : "none" } : undefined;
    const { proposal, validation } = await this.planner.planGoal(goal, budget, body.nodes);
    if (!validation.valid) {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Graph proposal validation failed: ${validation.reason}`, validation }));
      return;
    }

    // 2. 检查 Single Task Fast Path
    if (!proposal.requiresMultiAgent && this.semanticRouter) {
      // 快速通道：直接调用 Phase 3 自主派发
      const autoRes = await this.semanticRouter.runAutonomous(goal);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ mode: "fast_path", result: autoRes }));
      return;
    }

    // 3. 多任务图创建与启动
    const graph = await this.orchestrator.createGraph(proposal);
    const started = await this.orchestrator.startGraph(graph.graphId);
    const snapshot = await this.graphProjection.projectGraphState(graph.graphId);

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ graph: started, snapshot, proposal }));
  }

  private async handleListGraphs(url: URL, res: ServerResponse): Promise<void> {
    const status = url.searchParams.get("status") as any;
    const limit = Number(url.searchParams.get("limit")) || 50;
    const graphs = await this.store.listGraphs?.({ status, limit }) ?? [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ graphs }));
  }

  private async handleRuntimeEvidence(graphId: string, trace: boolean, url: URL, res: ServerResponse): Promise<void> {
    const graph = await this.store.getGraph?.(graphId);
    if (!graph) { res.writeHead(404); res.end(JSON.stringify({ error: "Graph not found" })); return; }
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 100);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      res.writeHead(400); res.end(JSON.stringify({ error: "offset >= 0 and 1 <= limit <= 1000 required" })); return;
    }
    const traceId = graph.strategyDecision?.traceId;
    const items = !traceId ? [] : trace ? await this.store.listRuntimeSpans?.(traceId, offset, limit) ?? []
      : await this.store.listModelUsage?.({ traceId, offset, limit }) ?? [];
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ graphId, traceId, items, offset, limit, nextOffset: items.length === limit ? offset + limit : null,
      completeness: traceId ? "PARTIAL" : "NO_DATA", scope: "Authorized graph execution trace; page contents do not imply complete instrumentation" }));
  }

  private async handleGetGraphDetails(graphId: string, res: ServerResponse): Promise<void> {
    const graph = await this.store.getGraph?.(graphId);
    if (!graph) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Graph '${graphId}' not found` }));
      return;
    }
    const snapshot = await this.graphProjection.projectGraphState(graphId);
    const [nodes, edges, revisions, verifications, artifacts, events] = await Promise.all([
      this.store.listGraphNodes?.(graphId) ?? [],
      this.store.listGraphEdges?.(graphId) ?? [],
      this.store.listGraphRevisions?.(graphId) ?? [],
      this.store.listGraphVerifications?.(graphId) ?? [],
      this.store.listArtifacts?.(graphId) ?? [],
      this.store.listGraphEvents?.(graphId, 0) ?? [],
    ]);
    const nodesWithAttempts = await Promise.all(nodes.map(async node => {
      const history = await this.store.listGraphTaskAttempts?.(graphId, node.nodeId) ?? [];
      const latest = history.at(-1);
      const hadFailure = history.slice(0, -1).some(task => task.status === "failed");
      const recoveryState = hadFailure && latest && latest.taskId === node.taskId && latest.status === "completed" && node.status === "completed" ? "recovered"
        : hadFailure && latest && latest.taskId === node.taskId && ["created", "queued", "dispatched", "accepted", "running", "waiting_approval"].includes(latest.status) ? "recovering"
        : undefined;
      return { ...node, recoveryState,
      attempts: history.map(task => ({
        taskId: task.taskId, status: task.status, error: task.error, resultSummary: task.resultSummary,
        createdAt: task.createdAt, completedAt: task.completedAt,
        retryOfTaskId: task.dispatchOptions?.graphContext?.retryOfTaskId,
      })) };
    }));
    let goalEvaluation = undefined;
    if (this.orchestrator && typeof this.orchestrator.evaluateGoalCompletion === "function") {
      try {
        goalEvaluation = await this.orchestrator.evaluateGoalCompletion(graphId);
      } catch {
        // Ignore goal evaluation errors in read-only detail query
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        graph,
        snapshot,
        nodes: nodesWithAttempts,
        edges,
        revisions,
        verifications,
        artifacts,
        events,
        goalEvaluation,
        provenance: await projectExecutionProvenance(this.store, graphId),
      })
    );
  }

  private async handleGetGraphTasks(graphId: string, res: ServerResponse): Promise<void> {
    const nodes = await this.store.listGraphNodes?.(graphId) ?? [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks: nodes }));
  }

  private async handleGetGraphArtifacts(graphId: string, res: ServerResponse): Promise<void> {
    const artifacts = await this.store.listArtifacts?.(graphId) ?? [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ artifacts }));
  }

  private async handleGetGraphEvents(graphId: string, url: URL, res: ServerResponse): Promise<void> {
    const fromSeq = Number(url.searchParams.get("fromSeq")) || 0;
    const events = await this.store.listGraphEvents?.(graphId, fromSeq) ?? [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ events }));
  }

  private async handleGraphEventStream(graphId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const graph = await this.store.getGraph?.(graphId);
    if (!graph) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Graph '${graphId}' not found` }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let lastSeq = this.readEventCursor(req);

    // 先回放已有历史事件
    const existing = await this.store.listGraphEvents?.(graphId, lastSeq + 1) ?? [];
    for (const evt of existing) {
      res.write(`id: ${evt.seq}\nevent: ${evt.eventType}\ndata: ${JSON.stringify(evt.payload)}\n\n`);
      lastSeq = evt.seq;
    }

    pollStream(res, 1000, async () => {
      const nextBatch = await this.store.listGraphEvents?.(graphId, lastSeq + 1) ?? [];
      for (const evt of nextBatch) {
        res.write(`id: ${evt.seq}\nevent: ${evt.eventType}\ndata: ${JSON.stringify(evt.payload)}\n\n`);
        lastSeq = evt.seq;
      }
      const g = await this.store.getGraph?.(graphId);
      if (g && ["completed", "failed", "cancelled", "partially_completed"].includes(g.status)) {
        res.write(`event: graph.end\ndata: ${JSON.stringify({ status: g.status })}\n\n`);
        res.end();
      }
    });
  }

  private async handleGraphSteer(graphId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.replanner) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GraphReplanner not initialized" }));
      return;
    }
    const body = await this.parseJsonBody(req);
    const instruction = body.instruction || body.steerContent;
    if (!instruction || typeof instruction !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'instruction' string in request body" }));
      return;
    }

    const replanResult = await this.replanner.replanGraph({
      graphId,
      trigger: "steer",
      reason: `User steer instruction: ${instruction}`,
      steerInstruction: instruction,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(replanResult));
  }

  private async handleGraphPause(graphId: string, res: ServerResponse): Promise<void> {
    if (!this.orchestrator) throw new WebRequestError(503, "任务图服务尚未就绪");
    await this.orchestrator.pauseGraph(graphId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, status: (await this.store.getGraph?.(graphId))?.status, message: `Graph '${graphId}' paused.` }));
  }

  private async handleGraphResume(graphId: string, res: ServerResponse): Promise<void> {
    if (!this.orchestrator) throw new WebRequestError(503, "任务图服务尚未就绪");
    await this.orchestrator.resumeGraph(graphId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, status: (await this.store.getGraph?.(graphId))?.status, message: `Graph '${graphId}' resumed.` }));
  }

  private async handleGraphCancel(graphId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.orchestrator) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GraphOrchestrator not initialized" }));
      return;
    }
    const body = await this.parseJsonBody(req);
    const reason = body.reason || "Cancelled by user via API";
    await this.orchestrator.cancelGraph(graphId, reason);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, status: (await this.store.getGraph?.(graphId))?.status, message: `Graph '${graphId}' cancelled.` }));
  }

  private async handleGraphManualReplan(graphId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.replanner) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GraphReplanner not initialized" }));
      return;
    }
    const body = await this.parseJsonBody(req);
    const reason = body.reason || "Manual replan requested via API";
    const failedNodeId = body.failedNodeId;

    const replanResult = await this.replanner.replanGraph({
      graphId,
      trigger: body.trigger || "task_failed",
      reason,
      failedNodeId,
      addNodes: body.addNodes,
      rewireDependencies: body.rewireDependencies,
      reassignNodes: body.reassignNodes,
      retryNodeIds: body.retryNodeIds,
      skipNodeIds: body.skipNodeIds,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(replanResult));
  }

  // ============================================================
  // Phase 5: Web Authentication & Authorization
  // ============================================================

  private parseCookies(req: IncomingMessage): Record<string, string> { return parseCookies(req); }

  private trackSessionStream(res: ServerResponse, session: WebSessionRecord): void {
    this.sessionStreams.set(res, session.sessionId);
    const timer = setTimeout(() => res.end(), Math.max(1, session.expiresAt - Date.now()));
    timer.unref();
    res.on("close", () => { clearTimeout(timer); this.sessionStreams.delete(res); });
  }

  private async authenticateRequest(
    req: IncomingMessage,
    _res: ServerResponse
  ): Promise<{ authenticated: boolean; user?: { username: string; role: string; userId: string }; session?: WebSessionRecord }> {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ") && this.adminApiKey && equalSecret(authHeader.slice(7), this.adminApiKey)) {
      const user = this.productStore?.listUsers().find(candidate => candidate.role === "admin");
      if (this.productStore && !user) return { authenticated: false };
      return { authenticated: true, user: user ?? { username: "admin", role: "admin", userId: "usr-admin" } };
    }
    const sessionId = parseCookies(req)["nash_session"];
    const session = sessionId ? await this.store.getWebSession?.(sessionId) : undefined;
    if (!session || session.expiresAt <= Date.now()) return { authenticated: false };
    if (this.productStore) {
      const user = this.productStore.getUser(session.userId);
      const version = Number(/^sess-v(\d+)-/.exec(session.sessionId)?.[1]);
      if (!user || user.credentialVersion !== version) { await this.store.deleteWebSession?.(session.sessionId); return { authenticated: false }; }
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method?.toUpperCase() ?? "")) {
      const csrf = req.headers["x-csrf-token"];
      if (typeof csrf !== "string" || !equalSecret(csrf, session.csrfToken)) throw new WebRequestError(403, "请求校验失败，请刷新页面后重试");
    }
    return { authenticated: true, session, user: { username: session.username, role: session.role, userId: session.userId } };
  }

  private async handleAuthLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseJsonBody(req);
    const inputUser = String(body.username ?? "");
    const inputPass = String(body.password ?? "");

    const expectedUser = process.env.DASHBOARD_USER || process.env.ADMIN_USER || "admin";
    const expectedPass = process.env.DASHBOARD_PASS || process.env.ADMIN_PASS;
    if (!this.productStore && !expectedPass) throw new WebRequestError(503, "请先配置 DASHBOARD_PASS 或 ADMIN_PASS 后再登录");

    const ip = req.socket?.remoteAddress ?? "unknown";
    const nowAttempt = Date.now();
    for (const [key, value] of this.loginAttempts) {
      if (value.lockedUntil <= nowAttempt && nowAttempt - value.windowStart > 5 * 60_000) this.loginAttempts.delete(key);
    }
    const attempts = this.loginAttempts.get(ip) ?? { failures: 0, windowStart: nowAttempt, lockedUntil: 0 };
    if (attempts.lockedUntil > nowAttempt) {
      const retryAfter = Math.ceil((attempts.lockedUntil - nowAttempt) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      throw new WebRequestError(429, `尝试次数过多，请在 ${retryAfter} 秒后重试`);
    }
    const productUser = this.productStore?.authenticate(inputUser, inputPass);
    if (this.productStore ? !productUser : (!equalSecret(inputUser, expectedUser) || !equalSecret(inputPass, expectedPass!))) {
      attempts.failures++;
      if (attempts.failures >= 5) attempts.lockedUntil = nowAttempt + 10 * 60_000;
      this.loginAttempts.set(ip, attempts);
      await new Promise((resolve) => setTimeout(resolve, 300));
      throw new WebRequestError(401, "用户名或密码错误");
    }
    this.loginAttempts.delete(ip);

    const sessionId = `sess-${productUser ? `v${productUser.credentialVersion}-` : ""}${crypto.randomBytes(24).toString("hex")}`;
    const csrfToken = crypto.randomBytes(16).toString("hex");
    const now = Date.now();
    const expiresAt = now + 7 * 24 * 3600 * 1000; // 7 天有效期

    const session: WebSessionRecord = {
      sessionId,
      userId: productUser?.userId ?? "usr-admin",
      username: productUser?.username ?? expectedUser,
      role: productUser?.role ?? "admin",
      csrfToken,
      createdAt: now,
      expiresAt,
    };
    if (productUser) Object.assign(session, { credentialVersion: productUser.credentialVersion });

    if (this.store.saveWebSession) {
      await this.store.saveWebSession(session);
    }

    // 设置安全 HttpOnly Cookie
    const isHttps = isSecureRequest(req, this.trustProxy);
    const cookieFlags = [
      `nash_session=${sessionId}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${7 * 24 * 3600}`,
      ...(isHttps ? ["Secure"] : []),
    ].join("; ");

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": cookieFlags,
    });
    res.end(
      JSON.stringify({
        success: true,
        user: { username: session.username, role: session.role, userId: session.userId },
        csrfToken,
      })
    );
  }

  private async handleAuthLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cookies = this.parseCookies(req);
    const sessionId = cookies["nash_session"];
    if (sessionId && this.store.deleteWebSession) {
      const session = await this.store.getWebSession?.(sessionId);
      if (session) await this.authenticateRequest(req, res);
      await this.store.deleteWebSession(sessionId);
      for (const [response, owner] of this.sessionStreams) if (owner === sessionId) response.end();
    }

    const isHttps = isSecureRequest(req, this.trustProxy);
    const cookieFlags = [
      "nash_session=",
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
      ...(isHttps ? ["Secure"] : []),
    ].join("; ");

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": cookieFlags,
    });
    res.end(JSON.stringify({ success: true, message: "Logged out successfully" }));
  }

  private async handleAuthMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await this.authenticateRequest(req, res);
    if (!auth.authenticated || !auth.user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not authenticated" }));
      return;
    }

    const cookies = this.parseCookies(req);
    const sessionId = cookies["nash_session"];
    let csrfToken: string | undefined;
    if (sessionId && this.store.getWebSession) {
      const s = await this.store.getWebSession(sessionId);
      csrfToken = s?.csrfToken;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        authenticated: true,
        user: auth.user,
        csrfToken,
      })
    );
  }

  // ============================================================
  // Phase 5: Artifact Exchange & Preview Endpoints
  // ============================================================

  private async handleListArtifacts(url: URL, res: ServerResponse): Promise<void> {
    const graphId = url.searchParams.get("graphId") ?? undefined;
    const artifacts = (await this.store.listArtifacts?.(graphId)) ?? [];

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ artifacts }));
  }

  private async handleGetArtifactDetails(artifactId: string, res: ServerResponse): Promise<void> {
    const artifact = await this.store.getArtifact?.(artifactId);
    if (!artifact) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Artifact '${artifactId}' not found` }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ artifact }));
  }

  private async requireAdministrator(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await this.authenticateRequest(req, res);
    if (!auth.authenticated || auth.user?.role !== "admin") throw new WebRequestError(403, "当前操作仅管理员有权执行");
  }

  private async requireArtifactAdministrator(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.requireAdministrator(req, res);
  }

  private async handleGetArtifactContent(artifactId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const artifact = await this.store.getArtifact?.(artifactId);
    if (!artifact) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Artifact '${artifactId}' not found` }));
      return;
    }

    if (!this.artifactService) throw new WebRequestError(503, "产物服务尚未就绪");
    await this.requireArtifactAdministrator(req, res);
    const { handle } = await this.artifactService.openVerifiedArtifact(artifactId, artifact.producerNodeId);
    const maxPreviewSize = 100 * 1024;
    const buffer = Buffer.alloc(Math.min(artifact.sizeBytes, maxPreviewSize));
    let bytesRead = 0;
    try { ({ bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)); }
    finally { await handle.close(); }
    const truncated = artifact.sizeBytes > maxPreviewSize;
    const content = buffer.subarray(0, bytesRead).toString("utf-8");

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        artifactId,
        name: artifact.name,
        contentType: artifact.contentType,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        content,
        truncated,
      })
    );
  }

  private async handleDownloadArtifact(artifactId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const artifact = await this.store.getArtifact?.(artifactId);
    if (!artifact) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Artifact '${artifactId}' not found` }));
      return;
    }

    if (!this.artifactService) throw new WebRequestError(503, "产物服务尚未就绪");

    await this.requireArtifactAdministrator(req, res);

    let handleInfo;
    try {
      handleInfo = await this.artifactService.openVerifiedArtifact(
        artifactId,
        artifact.producerNodeId
      );
    } catch (err) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Access denied" }));
      return;
    }

    const { handle } = handleInfo;
    const safeFilename = path.basename(artifact.name).replace(/[^a-zA-Z0-9._\-]/g, "_");
    const rangeHeader = req.headers.range;

    // 支持 HTTP Range 分片流式传输与断点续传 (HTTP 206 Partial Content / HTTP 416)
    if (rangeHeader) {
      const match = rangeHeader.trim().match(/^bytes=(\d+)-(\d+)?$/);
      if (!match) {
        res.writeHead(416, {
          "Content-Type": "application/json",
          "Content-Range": `bytes */${artifact.sizeBytes}`,
        });
        await handle.close();
        res.end(JSON.stringify({ error: "Invalid Range specification" }));
        return;
      }

      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : artifact.sizeBytes - 1;

      if (start >= artifact.sizeBytes || start < 0 || end < start) {
        res.writeHead(416, {
          "Content-Type": "application/json",
          "Content-Range": `bytes */${artifact.sizeBytes}`,
        });
        await handle.close();
        res.end(JSON.stringify({ error: "Range Not Satisfiable" }));
        return;
      }

      const effectiveEnd = Math.min(end, artifact.sizeBytes - 1);
      const chunkLength = effectiveEnd - start + 1;

      res.writeHead(206, {
        "Content-Type": artifact.contentType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
        "Content-Range": `bytes ${start}-${effectiveEnd}/${artifact.sizeBytes}`,
        "Content-Length": chunkLength,
        "Accept-Ranges": "bytes",
        "X-Artifact-Sha256": artifact.sha256,
        "Cache-Control": "private, no-transform",
      });

      const stream = handle.createReadStream({ start, end: effectiveEnd, autoClose: true });
      stream.on("error", () => { res.destroy(); });
      res.on("close", () => { stream.destroy(); });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Type": artifact.contentType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
        "Content-Length": artifact.sizeBytes,
        "Accept-Ranges": "bytes",
        "X-Artifact-Sha256": artifact.sha256,
        "Cache-Control": "private, no-transform",
      });

      const stream = handle.createReadStream({ start: 0, autoClose: true });
      stream.on("error", () => { res.destroy(); });
      res.on("close", () => { stream.destroy(); });
      stream.pipe(res);
    }
  }

  // ============================================================
  // Phase 5: Web Conversations & Workspace Endpoints
  // ============================================================

  private async handleListConversations(url: URL, res: ServerResponse): Promise<void> {
    const limit = Number(url.searchParams.get("limit")) || 50;
    const includeEmpty = url.searchParams.get("includeEmpty") !== "false";
    const allConvs = (await this.store.listConversations?.(limit)) ?? [];

    // 若 includeEmpty 为 false，过滤空会话；默认保持 REST API 语义完整性
    const conversations = includeEmpty
      ? allConvs
      : allConvs.filter((c) => Array.isArray(c.messages) && c.messages.length > 0);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ conversations }));
  }

  private async handleCreateConversation(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseJsonBody(req);
    const id = `conv-${crypto.randomUUID().slice(0, 10)}`;
    const now = Date.now();
    const title = body.title || "新任务会话";
    const titleSource: ConversationTitleSource = (body.titleSource as ConversationTitleSource) || "default";

    const conversation: WebConversationRecord = {
      id,
      title,
      titleSource,
      titleRevision: 1,
      createdAt: now,
      updatedAt: now,
      linkedTaskIds: [],
      linkedGraphIds: [],
      messages: [],
    };

    if (body.initialPrompt) {
      conversation.messages.push({
        id: `msg-${crypto.randomUUID().slice(0, 8)}`,
        conversationId: id,
        sender: "user",
        content: body.initialPrompt,
        messageType: "text",
        timestamp: now,
      });
    }

    if (this.store.saveConversation) {
      await this.store.saveConversation(conversation);
    }

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ conversation }));
  }

  private async handleGetConversation(conversationId: string, res: ServerResponse): Promise<void> {
    const conv = await this.store.getConversation?.(conversationId);
    if (!conv) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Conversation '${conversationId}' not found` }));
      return;
    }

    // 核心会话自愈补偿机制：
    // 1. 若会话关联的任务已完成且产生 finalAnswer，而当前会话末尾为报错或处于临时等待态，自动替换为最终成果；
    // 2. 若会话关联的任务已被取消，而当前会话残留了超时错误提示，自愈为明确的取消状态；
    // 3. 若 Coordinator 已经产出了正式答复，坚决不追加重复兜底消息。
    if (conv.linkedTaskIds && conv.linkedTaskIds.length > 0) {
      for (const taskId of conv.linkedTaskIds) {
        const task = await this.store.getTask(taskId);
        const latestUser = [...conv.messages].reverse().find((message) => message.sender === "user");
        if (latestUser && (!task || task.createdAt < latestUser.timestamp)) continue;
        if (!this.conversationRequests.has(conversationId) && task && !task.dispatchOptions?.contextOverrides?.isDiscovery && task.finalAnswer && task.finalAnswer.trim().length > 0) {
          const alreadyIncluded = conv.messages.some(
            (m) =>
              (m.content && m.content.includes(task.finalAnswer!)) ||
              (m.metadata?.taskId === taskId && m.metadata?.source === "worker_deliverable")
          );
          if (!alreadyIncluded) {
            const lastMsg = conv.messages[conv.messages.length - 1];
            if (
              lastMsg &&
              lastMsg.sender === "assistant" &&
              (lastMsg.messageType === "error" ||
                lastMsg.content.includes("超时") ||
                lastMsg.content.includes("处理异常") ||
                lastMsg.content.includes("后台正在持续运行探查中"))
            ) {
              lastMsg.content = `【Worker 执行已完成，成果交付】\n${task.finalAnswer}`;
              lastMsg.messageType = "text";
              lastMsg.metadata = {
                state: "completed",
                taskId,
                source: "worker_deliverable",
                deliveredAt: Date.now(),
              };
              conv.updatedAt = Date.now();
              await this.store.saveConversation?.(conv);
            } else if (lastMsg && lastMsg.sender === "user") {
              // 仅当末尾为用户消息（协调器未回复任何内容）时才追加
              const deliverableMsg: WebMessageRecord = {
                id: `msg-${crypto.randomUUID().slice(0, 8)}`,
                conversationId,
                sender: "assistant",
                content: `【Worker 执行已完成，成果交付】\n${task.finalAnswer}`,
                messageType: "text",
                metadata: {
                  state: "completed",
                  taskId,
                  source: "worker_deliverable",
                  deliveredAt: Date.now(),
                },
                timestamp: Date.now(),
              };
              conv.messages.push(deliverableMsg);
              conv.updatedAt = Date.now();
              await this.store.saveConversation?.(conv);
            }
          }
        } else if (task && task.status === "cancelled") {
          // 若底层任务已取消，而会话末尾误报超时或处理异常，自动纠偏为清晰的手动取消状态
          const lastMsg = conv.messages[conv.messages.length - 1];
          if (
            lastMsg &&
            lastMsg.sender === "assistant" &&
            (lastMsg.content.includes("超时") || lastMsg.content.includes("处理异常"))
          ) {
            lastMsg.content = "任务执行已由用户手动取消。";
            lastMsg.messageType = "text";
            lastMsg.metadata = {
              state: "cancelled",
              taskId,
              cancelledAt: Date.now(),
            };
            conv.updatedAt = Date.now();
            await this.store.saveConversation?.(conv);
          }
        }
      }
    }

    // 整理清洗会话中被重复追加的 Worker 兜底交付物：
    // 若在同一个对话轮次中，Coordinator 已经产出了正式完整的回答，且紧随其后被追加了以【Worker 执行已完成，成果交付】开头的冗余消息，自动清理冗余项
    const cleanedMessages: WebMessageRecord[] = [];
    let turnIndex = 0;
    const completedTurns = new Set<number>();
    for (const message of conv.messages) {
      if (message.sender === "user") turnIndex++;
      if (message.sender === "assistant" && message.metadata?.state === "completed" && message.metadata?.source !== "worker_deliverable") completedTurns.add(turnIndex);
    }
    turnIndex = 0;
    for (let i = 0; i < conv.messages.length; i++) {
      const msg = conv.messages[i];
      if (msg.sender === "user") turnIndex++;
      if (msg.metadata?.source === "worker_deliverable" && completedTurns.has(turnIndex)) continue;
      if (
        msg.sender === "assistant" &&
        msg.content.includes("【Worker 执行已完成，成果交付】") &&
        i > 0 &&
        conv.messages[i - 1].sender === "assistant" &&
        !conv.messages[i - 1].content.includes("超时") &&
        !conv.messages[i - 1].content.includes("处理异常") &&
        !conv.messages[i - 1].content.includes("后台正在持续运行探查中")
      ) {
        // 跳过这条重复追加的冗余消息
        continue;
      }
      cleanedMessages.push(msg);
    }
    if (cleanedMessages.length !== conv.messages.length) {
      conv.messages = cleanedMessages;
      await this.store.saveConversation?.(conv);
    }

    // 整理清洗会话中的矛盾瞬态报错：
    // 1. 若会话已成功包含了 Worker 的成果交付（【Worker 执行已完成，成果交付】），
    // 则此前因等待超时产生的过渡性报错（如“协调器推理处理超时，请尝试简化任务或稍后重试。”）应被自动剔除；
    // 2. 若会话已被用户手动取消，剔除误报的超时提示。
    const hasDeliverable = conv.messages.some(
      (m) => m.sender === "assistant" && m.content && m.content.includes("【Worker 执行已完成，成果交付】")
    );
    const isCancelledTurn = conv.messages.some(
      (m) => m.content && (m.content.includes("用户手动取消") || m.metadata?.state === "cancelled")
    );
    if (hasDeliverable || isCancelledTurn) {
      const filtered = conv.messages.filter(
        (m) =>
          !(
            m.sender === "assistant" &&
            (m.content.includes("协调器推理处理超时") || m.content.includes("协调器主智能体执行遇到异常"))
          )
      );
      if (filtered.length !== conv.messages.length) {
        conv.messages = filtered;
        await this.store.saveConversation?.(conv);
      }
    }

    // 查询当前该会话是否处于后台推理轮次或正在执行关联任务中
    const activeTurn = this.activeConversationTurns.get(conversationId);
    let isRunning = Boolean(activeTurn);
    const graphTaskIds = (await Promise.all((conv.linkedGraphIds ?? []).map((graphId) => this.store.listGraphNodes?.(graphId) ?? [])))
      .flat().map((node) => node.taskId).filter((taskId): taskId is string => Boolean(taskId));
    const conversationTaskIds = [...new Set([...(conv.linkedTaskIds ?? []), ...graphTaskIds])];
    const tasks = (await Promise.all(conversationTaskIds.map((taskId) => this.store.getTask(taskId))))
      .filter((task): task is NonNullable<typeof task> => Boolean(task));
    const activeTasks = tasks
      .filter((task) => task && ["created", "queued", "accepted", "running", "dispatched", "interrupting", "waiting_approval", "cancelling", "outcome_unknown"].includes(task.status));
    if (activeTasks.length > 0) isRunning = true;
    const activeGraphs = (await Promise.all((conv.linkedGraphIds ?? []).map((graphId) => this.store.getGraph?.(graphId))))
      .filter((graph) => graph && ["running", "replanning", "waiting_approval", "cancelling", "outcome_unknown"].includes(graph.status));
    if (activeGraphs.length > 0) isRunning = true;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        conversation: conv,
        isRunning,
        activeTasks,
        taskSummaries: tasks.map((task) => ({
          taskId: task.taskId, nodeId: task.nodeId, projectId: task.projectId, goal: task.goal,
          status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt,
          resultSummary: task.resultSummary, error: task.error,
          isScout: task.dispatchOptions?.contextOverrides?.isDiscovery === true,
        })),
        activeGraphs,
        activeTurn: activeTurn
          ? {
              startedAt: activeTurn.startedAt,
              taskId: activeTurn.taskId,
              graphId: activeTurn.graphId,
              status: activeTurn.abortController.signal.aborted ? "cancelling" : "running",
              progress: activeTurn.progress,
            }
          : null,
      })
    );
  }

  private async handleUpdateConversation(conversationId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const conv = await this.store.getConversation?.(conversationId);
    if (!conv) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Conversation '${conversationId}' not found` }));
      return;
    }

    const body = await this.parseJsonBody(req);
    if (body.title !== undefined) {
      conv.title = String(body.title).trim();
      // 用户手动修改过的标题应受到保护 (Section 十一: USER_DEFINED)
      conv.titleSource = (body.titleSource as ConversationTitleSource) || "user_defined";
      conv.titleRevision = (conv.titleRevision ?? 0) + 1;
    }
    conv.updatedAt = Date.now();

    if (this.store.saveConversation) {
      await this.store.saveConversation(conv);
    }

    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: "conversation.title_updated" as any,
        timestamp: new Date().toISOString(),
        projectId: "coordinator",
        sessionId: conversationId,
        data: {
          conversationId,
          title: conv.title,
          titleSource: conv.titleSource,
          titleRevision: conv.titleRevision,
        },
      });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ conversation: conv }));
  }

  private async handleDeleteConversation(conversationId: string, res: ServerResponse): Promise<void> {
    if (this.conversationRequests.has(conversationId)) throw new WebRequestError(409, "此会话仍在执行，请先取消执行后再删除");
    const ok = (await this.store.deleteConversation?.(conversationId)) ?? false;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: ok, conversationId }));
  }

  private async handleConversationMessage(conversationId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 冻结期间不再受理新的对话轮次（排空的必要条件）；取消 / 中断接口仍然可用。
    this.admission?.assertAdmitting("conversation turn");
    if (this.conversationRequests.has(conversationId)) throw new WebRequestError(409, "此会话正在处理上一条消息，请稍后重试或先取消当前执行");
    this.conversationRequests.add(conversationId);
    try { await this.runConversationMessage(conversationId, req, res); }
    finally { this.conversationRequests.delete(conversationId); }
  }

  private async runConversationMessage(conversationId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const conv = await this.store.getConversation?.(conversationId);
    if (!conv) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Conversation '${conversationId}' not found` }));
      return;
    }

    const body = await this.parseJsonBody(req);
    let userText = String(body.content || body.prompt || "").trim();
    let selection: { optionId: string; nodeId: string; projectId?: string } | undefined;
    if (body.selection) {
      const previous = conv.messages[conv.messages.length - 1];
      const pending = previous?.sender === "assistant" ? previous.metadata?.pendingClarification as any : undefined;
      const option = pending?.options?.find((item: any) => item.id === body.selection.optionId);
      if (!option) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Clarification option is invalid or expired" }));
        return;
      }
      selection = { optionId: option.id, nodeId: option.nodeId, projectId: option.projectId };
      userText = option.label;
    }
    if (!userText) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing message content" }));
      return;
    }

    const now = Date.now();
    const userMsgId = `msg-${crypto.randomUUID().slice(0, 8)}`;
    const userMessage: WebMessageRecord = {
      id: userMsgId,
      conversationId,
      sender: "user",
      content: userText,
      metadata: selection ? { selection } : undefined,
      messageType: "text",
      timestamp: now,
    };

    conv.messages.push(userMessage);

    // 默认如果会话是默认标题，可临时采用首条用户提问前 30 字作为初始 fallback
    if (conv.titleSource !== "user_defined") {
      if (conv.title === "新任务会话" || conv.title === "新任务" || !conv.titleSource || conv.titleSource === "default") {
        if (conv.messages.filter((m) => m.sender === "user").length <= 1) {
          conv.title = userText.slice(0, 30);
          conv.titleSource = "default";
        }
      }
    }
    conv.titleRevision = (conv.titleRevision ?? 0) + 1;
    const currentTitleRevision = conv.titleRevision;
    conv.updatedAt = now;

    let goalRunId: string | undefined;
    let goalTurnFence: import("../storage/cluster-store.js").GoalTurnFence | undefined;
    const turnOwnerId = crypto.randomUUID();
    if (this.store.createGoalRun && this.store.getGoalRun) {
      if (!this.store.commitGoalTurnResponse || !this.store.createGoalRunWithConversation) throw new Error("Atomic GoalRun conversation storage unavailable");
      const previousUser = selection ? [...conv.messages.slice(0, -1)].reverse().find(message => message.sender === "user") : undefined;
      const previousGoal = selection ? conv.messages.at(-2)?.metadata?.goalRunId ?? previousUser?.metadata?.goalRunId ?? (await this.store.listGoalRuns?.(conversationId) ?? []).find(goal => goal.userMessageId === previousUser?.id)?.goalRunId : undefined;
      const existingGoal = typeof previousGoal === "string" ? await this.store.getGoalRun(previousGoal) : undefined;
      if (existingGoal?.conversationId === conversationId) {
        goalRunId = existingGoal.goalRunId;
        userMessage.metadata = { ...userMessage.metadata, goalRunId };
        if (!this.store.continueGoalRunWithConversation) throw new Error("Atomic GoalRun continuation storage unavailable");
        const lease = await this.store.continueGoalRunWithConversation(goalRunId, conv, userMsgId, turnOwnerId, 45_000);
        if (!lease) throw new Error("GoalRun turn is already owned or conversation changed");
        goalTurnFence = { ownerId: lease.ownerId, turnId: lease.turnId, generation: lease.generation };
      }
      else {
        goalRunId = `goal-${crypto.randomUUID()}`;
        userMessage.metadata = { ...userMessage.metadata, goalRunId };
        const created = await this.store.createGoalRunWithConversation({ goalRunId, conversationId, userMessageId: userMsgId, rootGoal: userText,
          status: "planning", executionState: "running", currentStage: "planning", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null,
          reportRevision: 0, revision: 1, createdAt: now, updatedAt: now }, conv, { ownerId: turnOwnerId, ttlMs: 45_000 });
        if (!created) throw new Error("GoalRun creation conflict");
        goalTurnFence = { ownerId: turnOwnerId, turnId: userMsgId, generation: 1 };
      }
    } else await this.store.saveConversation?.(conv);

    // 异步触发 AI 会话自动命名 (AI Conversation Auto-Titling)
    // 铁律：独立异步执行，绝不阻塞 Coordinator Task Dispatch 或 Main Agent 执行！
    if (conv.titleSource !== "user_defined") {
      this.triggerAsyncTitleGeneration(conversationId, currentTitleRevision);
    }

    // 广播用户消息已入库与轮次已开始
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: "conversation.message_created" as any,
        timestamp: new Date().toISOString(),
        projectId: "coordinator",
        sessionId: conversationId,
        data: { conversationId, message: userMessage },
      });
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: "coordinator.turn_started" as any,
        timestamp: new Date().toISOString(),
        projectId: "coordinator",
        sessionId: conversationId,
        data: { conversationId, userText },
      });
    }

    let assistantResponse: WebMessageRecord | null = null;
    let responseInserted = true;
    let createdTaskId: string | undefined;
    let createdGraphId: string | undefined;
    // 最终回答的确定性核验结论（证据范围 + 事实一致性），随响应返回供 UI/审计直接核对。
    let turnEvidenceGuard: unknown;
    let turnFactCheck: unknown;

    const turnAbortController = new AbortController();
    let leaseTimer: NodeJS.Timeout | undefined;
    const turnTimers: NodeJS.Timeout[] = [];
    let clientDisconnectedAt: number | undefined;
    {
      // 客户端断开后仍给前台轮次一段宽限；超时后停止等待，任务继续在 Worker 上执行。
      let clientGone = false;
      const onClientGone = () => {
        if (clientGone || res.writableEnded) return;
        clientGone = true;
        clientDisconnectedAt = Date.now();
        const grace = setTimeout(() => {
          if (!turnAbortController.signal.aborted) turnAbortController.abort(new Error("Client disconnected from the conversation turn"));
        }, clientDisconnectGraceMs());
        grace.unref?.();
        turnTimers.push(grace);
      };
      if (typeof (req as { on?: unknown }).on === "function") req.on("aborted", onClientGone);
      if (typeof (res as { on?: unknown }).on === "function") res.on("close", onClientGone);
      // 硬上限：任何前台轮次都不允许无限占用会话与 GoalRun 租约。
      const watchdog = setTimeout(() => {
        if (!turnAbortController.signal.aborted) turnAbortController.abort(new Error("Turn exceeded maximum duration"));
      }, turnMaxDurationMs());
      watchdog.unref?.();
      turnTimers.push(watchdog);
    }
    if (goalRunId) {
      if (!this.store.claimGoalTurnLease || !this.store.renewGoalTurnLease) throw new Error("GoalRun turn lease storage unavailable");
      if (!goalTurnFence) {
        const lease = await this.store.claimGoalTurnLease(goalRunId, userMsgId, turnOwnerId, 45_000);
        if (!lease) throw new Error("GoalRun turn is already owned or has been answered");
        goalTurnFence = { ownerId: lease.ownerId, turnId: lease.turnId, generation: lease.generation };
      }
      let renewing = false;
      leaseTimer = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void this.store.renewGoalTurnLease!(goalRunId!, goalTurnFence!.ownerId, goalTurnFence!.generation, 45_000)
          .then(valid => { if (!valid) turnAbortController.abort(new Error("GoalRun turn lease lost")); })
          .catch(() => turnAbortController.abort(new Error("GoalRun turn lease renewal failed")))
          .finally(() => { renewing = false; });
      }, 10_000);
      leaseTimer.unref();
    }
    const turnEntry = {
      abortController: turnAbortController,
      conversationId,
      startedAt: Date.now(),
      clientDisconnectedAt,
      taskId: undefined as string | undefined,
      graphId: undefined as string | undefined,
      progress: undefined as { phase: string; detail: string; timestamp: number } | undefined,
    };
    this.activeConversationTurns.set(conversationId, turnEntry);
    let linkWrites = Promise.resolve();
    const linkTask = (taskId: string) => {
      conv.linkedTaskIds = [...new Set([...(conv.linkedTaskIds ?? []), taskId])];
      linkWrites = linkWrites.then(async () => {
        const latest = await this.store.getConversation?.(conversationId);
        if (latest) {
          latest.linkedTaskIds = [...new Set([...(latest.linkedTaskIds ?? []), taskId])];
          latest.updatedAt = Date.now();
          await this.store.saveConversation?.(latest);
          // 关键：将数据库最新的标题与状态同步回当前运行中的闭包内存，杜绝用陈旧快照回冲
          conv.title = latest.title;
          conv.titleSource = latest.titleSource;
          conv.titleRevision = latest.titleRevision;
          conv.linkedTaskIds = latest.linkedTaskIds;
        } else {
          await this.store.saveConversation?.(conv);
        }
        // 关键新增：实时广播 SSE 事件，确保前端第一时间将新任务纳入会话白名单，杜绝任务滞后展示
        this.broadcastGlobalSse("conversation.task_linked", { conversationId, taskId, linkedTaskIds: conv.linkedTaskIds });
        this.broadcastGlobalSse("coordinator.task_dispatched", { conversationId, taskId });
      });
      return linkWrites;
    };

    try {
      // 优先交由 LLM 驱动的 Coordinator 主智能体处理 (Phase 6 / LLM-Driven Coordinator Main Agent)
      if (this.mainAgent) {
        try {
          const chatResult = await this.mainAgent.chat(conversationId, selection ? JSON.stringify({ type: "clarification_selection", ...selection }) : userText, {
            goalRunId,
            goalTurnFence,
            abortSignal: turnAbortController.signal,
            onProgress: (progress) => { turnEntry.progress = progress; },
            onScoutTaskDispatched: async (taskId) => {
              await linkTask(taskId);
            },
            onTaskDispatched: async (taskId) => {
              createdTaskId = taskId;
              turnEntry.taskId = taskId;
              await linkTask(taskId);
            },
          });
          if (chatResult.createdTaskId) {
            createdTaskId = chatResult.createdTaskId;
            turnEntry.taskId = createdTaskId;
            conv.linkedTaskIds = Array.from(new Set([...(conv.linkedTaskIds ?? []), createdTaskId]));
          }
          if (chatResult.createdGraphId) {
            createdGraphId = chatResult.createdGraphId;
            turnEntry.graphId = createdGraphId;
            conv.linkedGraphIds = Array.from(new Set([...(conv.linkedGraphIds ?? []), createdGraphId]));
          }
          turnEvidenceGuard = chatResult.evidenceGuard;
          turnFactCheck = chatResult.factCheck;

        assistantResponse = {
          id: `msg-${crypto.randomUUID().slice(0, 8)}`,
          conversationId,
          sender: "assistant",
          content: chatResult.assistantResponse,
          messageType: chatResult.state === "waiting_user_clarification" ? "clarification" : "text",
          metadata: {
            goalRunId,
            state: chatResult.state,
            goalCompletionStatus: chatResult.goalCompletionStatus,
            taskId: createdTaskId,
            graphId: createdGraphId,
            pendingClarification: chatResult.pendingClarification,
            durationMs: chatResult.durationMs,
            // 确定性证据闸门与事实核验结论（仅结论，不含回答正文）
            evidenceGuard: chatResult.evidenceGuard,
            factCheck: chatResult.factCheck,
            // 模型原始输出仅供审计；正文已被隔离处理，二者不可混用。
            rawAssistantContent: chatResult.rawResponse,
          },
          timestamp: Date.now(),
        };
      } catch (err) {
        const isCancelled = turnAbortController.signal.aborted;
        const abortReason = String((turnAbortController.signal.reason as any)?.message ?? "");
        // 中断原因决定会话终态语义：客户端离开 / 轮次超时都只停止「协调器等待」，
        // 已派发的 Worker 任务继续执行，因此不能伪装成用户取消。
        const abortedByDisconnect = isCancelled && abortReason.includes("Client disconnected");
        const abortedByWatchdog = isCancelled && abortReason.includes("maximum duration");
        assistantResponse = {
          id: `msg-${crypto.randomUUID().slice(0, 8)}`,
          conversationId,
          sender: "assistant",
          content: abortedByDisconnect
            ? "客户端已断开，协调器停止等待本轮回答；已派发的任务继续在 Worker 上执行，结果可在任务与会话中查看。"
            : abortedByWatchdog
              ? "本轮超过最长执行时间，协调器已停止本轮推理；已派发的任务继续执行，结果以任务状态为准。"
              : isCancelled ? "协调器推理已中断；远程任务取消结果以任务状态为准。" : `协调器主智能体处理异常: ${err instanceof Error ? err.message : String(err)}`,
          messageType: isCancelled ? "text" : "error",
          metadata: {
            state: abortedByDisconnect ? "detached" : abortedByWatchdog ? "timed_out" : isCancelled ? "cancelled" : "error",
            taskId: createdTaskId,
          },
          timestamp: Date.now(),
        };
      }
    } else if (this.planner && this.orchestrator) {
      // 降级兼容模式 (当 Coordinator Main Agent 未注入时的旧逻辑)
      try {
        const { proposal, validation } = await this.planner.planGoal(userText);
        if (proposal.requiresMultiAgent) {
          const graph = await defaultTraceContext.run({ projectId: "coordinator", sessionId: conversationId, conversationId, goalRunId, goalTurnFence, traceId: crypto.randomUUID() }, () => this.orchestrator!.createGraph(proposal));
          await defaultTraceContext.run({ projectId: "coordinator", sessionId: conversationId, conversationId, goalRunId, goalTurnFence, traceId: crypto.randomUUID() }, () => this.orchestrator!.startGraph(graph.graphId));
          createdGraphId = graph.graphId;
          conv.linkedGraphIds = Array.from(new Set([...(conv.linkedGraphIds ?? []), graph.graphId]));

          assistantResponse = {
            id: `msg-${crypto.randomUUID().slice(0, 8)}`,
            conversationId,
            sender: "assistant",
            content: `已为您规划并启动分布式任务图（共 ${proposal.nodes.length} 个子阶段）：\n` +
              proposal.nodes.map((n, i) => `${i + 1}. [${n.candidateNodeId ?? "自动选点"}] ${n.title}`).join("\n"),
            messageType: "graph_planning",
            metadata: { graphId: graph.graphId, nodeCount: proposal.nodes.length },
            timestamp: Date.now(),
          };
        } else if (this.semanticRouter) {
          const autoRes = await defaultTraceContext.run({ projectId: "coordinator", sessionId: conversationId, conversationId, goalRunId, goalTurnFence, traceId: crypto.randomUUID() }, () => this.semanticRouter!.runAutonomous(userText));
          if (autoRes.dispatchResult?.taskId) {
            createdTaskId = autoRes.dispatchResult.taskId;
            conv.linkedTaskIds = Array.from(new Set([...(conv.linkedTaskIds ?? []), createdTaskId]));
          }
          assistantResponse = {
            id: `msg-${crypto.randomUUID().slice(0, 8)}`,
            conversationId,
            sender: "assistant",
            content: autoRes.decision.selectedCandidate
              ? `已为您选定最优节点 [${autoRes.decision.selectedCandidate.nodeId}] / 项目 [${autoRes.decision.selectedCandidate.projectId}]，子任务已派发执行。`
              : `任务已创建，原因: ${autoRes.decision.reason}`,
            messageType: "routing_decision",
            metadata: {
              taskId: createdTaskId,
              decisionType: autoRes.decision.decisionType,
              candidate: autoRes.decision.selectedCandidate,
            },
            timestamp: Date.now(),
          };
        }
      } catch (err) {
        assistantResponse = {
          id: `msg-${crypto.randomUUID().slice(0, 8)}`,
          conversationId,
          sender: "assistant",
          content: `执行规划调度遇到错误: ${err instanceof Error ? err.message : String(err)}`,
          messageType: "error",
          timestamp: Date.now(),
        };
      }
    }

    // 核心成果保障：若 Coordinator 异常或未正常组织语言，但底层关联的 Worker 任务已产生最终产物，保底提取交付
    const fallbackTaskId =
      createdTaskId;

    if (fallbackTaskId && (!assistantResponse || assistantResponse.messageType === "error")) {
      const task = await this.store.getTask(fallbackTaskId);
      if (task && !task.dispatchOptions?.contextOverrides?.isDiscovery && task.finalAnswer) {
        assistantResponse = {
          id: `msg-${crypto.randomUUID().slice(0, 8)}`,
          conversationId,
          sender: "assistant",
          content: `【Worker 执行已完成，成果交付】\n${task.finalAnswer}`,
          messageType: "text",
          metadata: {
            state: "completed",
            taskId: fallbackTaskId,
            source: "worker_deliverable",
          },
          timestamp: Date.now(),
        };
      }
    }

    const latest = await this.store.getConversation?.(conversationId);
    if (latest) {
      const ids = new Set(latest.messages.map((message) => message.id));
      conv.messages = [...latest.messages, ...conv.messages.filter((message) => !ids.has(message.id))];
      // 核心一致性保证：完整同步最新的标题、来源与修订版本，绝对杜绝用 default 状态回退 AI 或用户命名的标题！
      if (
        (latest.titleSource && latest.titleSource !== "default") ||
        (latest.titleRevision ?? 0) > (conv.titleRevision ?? 0) ||
        (latest.title && latest.title !== conv.title && conv.titleSource === "default")
      ) {
        conv.title = latest.title;
        conv.titleSource = latest.titleSource;
        conv.titleRevision = latest.titleRevision;
      } else {
        conv.title = latest.title;
        if (latest.titleSource) conv.titleSource = latest.titleSource;
        if (latest.titleRevision) conv.titleRevision = latest.titleRevision;
      }
      conv.linkedTaskIds = [...new Set([...(latest.linkedTaskIds ?? []), ...(conv.linkedTaskIds ?? [])])];
      conv.linkedGraphIds = [...new Set([...(latest.linkedGraphIds ?? []), ...(conv.linkedGraphIds ?? [])])];
    }

    if (assistantResponse) {
      if (goalRunId) {
        const goal = await this.store.getGoalRun?.(goalRunId);
        const interim = Boolean(goal && (goal.linkedTaskIds.length || goal.linkedGraphIds.length));
        assistantResponse.metadata = { ...assistantResponse.metadata, goalRunId, goalRunTurnId: userMsgId, ...(interim ? { reportKind: "interim" } : {}) };
        if (interim) assistantResponse.content = `阶段性报告：关联执行及目标覆盖范围尚待最终核验，未检查范围不能据此作出结论。\n\n${assistantResponse.content}`;
      }
      if (!goalRunId) conv.messages.push(assistantResponse);
    }
    conv.updatedAt = Date.now();

    if (this.store.saveConversation) {
      await this.store.saveConversation(conv);
    }

    if (goalRunId && assistantResponse) {
      const committed = await this.store.commitGoalTurnResponse!(goalRunId, assistantResponse, goalTurnFence);
      responseInserted = committed.inserted;
      const persisted = await this.store.getConversation?.(conversationId);
      if (persisted) {
        conv.messages = persisted.messages;
        if (!responseInserted) assistantResponse = persisted.messages.find(message => message.sender === "assistant" && message.metadata?.goalRunId === goalRunId && message.metadata?.goalRunTurnId === userMsgId) ?? assistantResponse;
      }
      const goal = await processGoalRun(this.store, goalRunId);
      this.broadcastGlobalSse("goal_run.updated", { goalRunId, revision: goal.revision, conversationId });
    }

    if (assistantResponse && responseInserted) this.eventBus?.emit({
      id: crypto.randomUUID(), type: "conversation.message_created" as any,
      timestamp: new Date().toISOString(), projectId: "coordinator", sessionId: conversationId,
      data: { conversationId, message: assistantResponse },
    });

    // 只有当任务确实仍在异步后台运行，且 Coordinator 尚未交付最终回答时，才启动后台监视器
    if (
      !goalRunId &&
      createdTaskId &&
      assistantResponse &&
      (assistantResponse.messageType === "error" ||
        assistantResponse.metadata?.state === "task_dispatched" ||
        assistantResponse.content.includes("后台正在持续运行探查中"))
    ) {
      this.watchAndDeliverWorkerResult(conversationId, createdTaskId);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        userMessage,
        assistantMessage: assistantResponse,
        taskId: createdTaskId,
        graphId: createdGraphId,
        evidenceGuard: turnEvidenceGuard ?? null,
        factCheck: turnFactCheck ?? null,
        conversation: conv,
      })
    );
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
      for (const timer of turnTimers) clearTimeout(timer);
      // 轮次退出后必须立刻交出租约：否则用户在下一条消息时会被
      // 「GoalRun turn is already owned」拒绝，直到 45s TTL 自然过期。
      if (goalRunId && goalTurnFence && this.store.releaseGoalTurnLease) {
        await this.store.releaseGoalTurnLease(goalRunId, goalTurnFence.ownerId, goalTurnFence.generation).catch(() => false);
      }
      if (this.activeConversationTurns.get(conversationId) === turnEntry) {
        this.activeConversationTurns.delete(conversationId);
        // MainAgent 的完成事件可能早于消息落盘；这里才是会话轮次真正退出的边界。
        this.eventBus?.emit({
          id: crypto.randomUUID(), type: "coordinator.turn_completed" as any,
          timestamp: new Date().toISOString(), projectId: "coordinator", sessionId: conversationId,
          data: { conversationId, settled: true },
        });
      }
    }
  }

  private async handleCancelConversation(conversationId: string, res: ServerResponse): Promise<void> {
    let cancelled = false;
    const failures: string[] = [];
    const controlledTasks = new Set<string>();
    const controlledGraphs = new Set<string>();
    // 1. 中断正在执行中的协调器推理
    const activeTurn = this.activeConversationTurns.get(conversationId);
    if (activeTurn) {
      activeTurn.abortController.abort(new Error("User cancelled conversation"));
      if (activeTurn.taskId) {
        controlledTasks.add(activeTurn.taskId);
        const result = await this.scheduler.sendControl(activeTurn.taskId, "cancel", { reason: "User cancelled conversation" });
        if (!result.success) failures.push(result.message);
      }
      if (activeTurn.graphId && this.orchestrator) {
        controlledGraphs.add(activeTurn.graphId);
        await this.orchestrator.cancelGraph(activeTurn.graphId);
      }
      cancelled = true;
    }

    // 2. 检查会话关联的全部历史任务中是否有处于 running 的任务
    const conv = await this.store.getConversation?.(conversationId);
    if (conv && conv.linkedTaskIds) {
      for (const taskId of conv.linkedTaskIds) {
        if (controlledTasks.has(taskId)) continue;
        const task = await this.store.getTask(taskId);
        if (task && (["created", "queued", "accepted", "running", "dispatched", "interrupting", "waiting_approval", "cancelling", "outcome_unknown"].includes(task.status))) {
          const result = await this.scheduler.sendControl(taskId, "cancel", { reason: "User cancelled conversation" });
          if (result.success) cancelled = true;
          else failures.push(result.message);
        }
      }
    }
    if (conv && conv.linkedGraphIds && this.orchestrator) {
      for (const graphId of conv.linkedGraphIds) {
        if (controlledGraphs.has(graphId)) continue;
        const graph = await this.store.getGraph?.(graphId);
        if (graph && (["running", "paused", "blocked", "planning", "replanning", "waiting_approval", "cancelling", "outcome_unknown"].includes(graph.status))) {
          await this.orchestrator.cancelGraph(graphId);
          cancelled = true;
        }
      }
    }

    // 3. 确保会话消息中不会残留误判的“协调器推理处理超时”报错，而是明确记录取消状态
    if (conv) {
      if (!conv.messages) conv.messages = [];
      const lastMsg = conv.messages[conv.messages.length - 1];
      if (
        lastMsg &&
        lastMsg.sender === "assistant" &&
        (lastMsg.content.includes("超时") || lastMsg.content.includes("处理异常"))
      ) {
        lastMsg.content = "已请求取消任务，执行是否停止以节点确认状态为准。";
        lastMsg.messageType = "text";
        lastMsg.metadata = { state: "cancelling" };
      } else if (!lastMsg || lastMsg.sender === "user") {
        conv.messages.push({
          id: `msg-${crypto.randomUUID().slice(0, 8)}`,
          conversationId,
          sender: "assistant",
          content: "已请求取消任务，正在等待执行节点确认停止。",
          messageType: "text",
          metadata: { state: "cancelling" },
          timestamp: Date.now(),
        });
      }
      conv.updatedAt = Date.now();
      await this.store.saveConversation?.(conv);
    }

    // 广播 SSE 告知前端会话已取消
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: "coordinator.turn_cancelled" as any,
        timestamp: new Date().toISOString(),
        projectId: "coordinator",
        sessionId: conversationId,
        data: { conversationId },
      });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: failures.length === 0, cancelled, message: failures.length ? failures.join("; ") : "Cancellation requested; waiting for Worker termination" }));
  }

  private async handleInterruptConversation(conversationId: string, res: ServerResponse): Promise<void> {
    let interrupted = false;
    const failures: string[] = [];
    const controlled = new Set<string>();
    const activeTurn = this.activeConversationTurns.get(conversationId);
    if (activeTurn?.taskId) {
      const result = await this.scheduler.sendControl(activeTurn.taskId, "interrupt");
      controlled.add(activeTurn.taskId);
      if (result.success) interrupted = true; else failures.push(result.message);
    }
    const conv = await this.store.getConversation?.(conversationId);
    if (conv && conv.linkedTaskIds) {
      for (const taskId of conv.linkedTaskIds) {
        const task = await this.store.getTask(taskId);
        if (task && task.status === "running" && !controlled.has(taskId)) {
          const result = await this.scheduler.sendControl(taskId, "interrupt");
          if (result.success) interrupted = true; else failures.push(result.message);
        }
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: interrupted && failures.length === 0, interrupted, message: failures.length ? failures.join("; ") : interrupted ? "Worker acknowledged tool interrupt" : "No running task to interrupt" }));
  }

  /**
   * 后台异步监视远程 Worker 执行，确保一旦完成其成果 100% 安全沉淀至用户会话
   */
  private watchAndDeliverWorkerResult(conversationId: string, taskId: string): void {
    const startTime = Date.now();
    const interval = setInterval(async () => {
      try {
        if (this.conversationRequests.has(conversationId)) return;
        if (Date.now() - startTime > 1800000) {
          clearInterval(interval);
          // 绝不能静默放弃：长任务仍在后台推进时，必须给会话留下可追溯的状态说明。
          if (this.store.getConversation && this.store.saveConversation) {
            try {
              const conv = await this.store.getConversation(conversationId);
              if (conv) {
                const latestUser = [...conv.messages].reverse().find((message) => message.sender === "user");
                if (!latestUser || latestUser.timestamp <= startTime) {
                  conv.messages.push({
                    id: `msg-${crypto.randomUUID().slice(0, 8)}`,
                    conversationId,
                    sender: "assistant",
                    content: `任务 \`${taskId}\` 已在目标节点后台持续运行超过 30 分钟，仍未收到终态。协调器已停止前台等待，但不会重复派发；任务完成或失败后会再次尝试交付结果。`,
                    messageType: "text",
                    metadata: { taskId, source: "worker_deliverable_watchdog" },
                    timestamp: Date.now(),
                  });
                  await this.store.saveConversation(conv);
                  this.broadcastGlobalSse("conversation.message_created", { conversationId, taskId });
                }
              }
            } catch { /* 状态说明失败不影响既有结果 */ }
          }
          return;
        }
        const task = await this.store.getTask(taskId);
        if (task && ["completed", "failed"].includes(task.status)) {
          clearInterval(interval);
          if (task.finalAnswer && this.store.getConversation && this.store.saveConversation) {
            const conv = await this.store.getConversation(conversationId);
            if (conv) {
              const latestUser = [...conv.messages].reverse().find((message) => message.sender === "user");
              if (latestUser && task.createdAt < latestUser.timestamp) return;
              const alreadyHas = conv.messages.some(
                (m) =>
                  (m.content && m.content.includes(task.finalAnswer!)) ||
                  (m.metadata?.taskId === taskId && m.metadata?.source === "worker_deliverable")
              );
              if (!alreadyHas) {
                const lastMsg = conv.messages[conv.messages.length - 1];
                if (
                  lastMsg &&
                  lastMsg.sender === "assistant" &&
                  (lastMsg.messageType === "error" ||
                    lastMsg.content.includes("超时") ||
                    lastMsg.content.includes("处理异常") ||
                    lastMsg.content.includes("后台正在持续运行探查中") ||
                    lastMsg.content.includes("后台持续执行中") ||
                    lastMsg.content.includes("后台持续推进"))
                ) {
                  lastMsg.content = `【Worker 执行已完成，成果交付】\n${task.finalAnswer}`;
                  lastMsg.messageType = "text";
                  lastMsg.metadata = {
                    state: "completed",
                    taskId,
                    source: "worker_deliverable",
                    deliveredAt: Date.now(),
                  };
                  conv.updatedAt = Date.now();
                  await this.store.saveConversation(conv);
                  if (this.eventBus) {
                    this.eventBus.emit({
                      id: crypto.randomUUID(),
                      type: "conversation.message_created" as any,
                      timestamp: new Date().toISOString(),
                      projectId: "coordinator",
                      sessionId: conversationId,
                      data: { conversationId, message: lastMsg },
                    });
                  }
                } else if (lastMsg && lastMsg.sender === "user") {
                  // 仅当末尾为用户消息（协调器未回复任何内容）时才追加首条回答
                  const deliverableMsg: WebMessageRecord = {
                    id: `msg-${crypto.randomUUID().slice(0, 8)}`,
                    conversationId,
                    sender: "assistant",
                    content: `【Worker 执行已完成，成果交付】\n${task.finalAnswer}`,
                    messageType: "text",
                    metadata: {
                      state: "completed",
                      taskId,
                      source: "worker_deliverable",
                      deliveredAt: Date.now(),
                    },
                    timestamp: Date.now(),
                  };
                  conv.messages.push(deliverableMsg);
                  conv.updatedAt = Date.now();
                  await this.store.saveConversation(conv);
                  if (this.eventBus) {
                    this.eventBus.emit({
                      id: crypto.randomUUID(),
                      type: "conversation.message_created" as any,
                      timestamp: new Date().toISOString(),
                      projectId: "coordinator",
                      sessionId: conversationId,
                      data: { conversationId, message: deliverableMsg },
                    });
                  }
                }
              }
            }
          }
        }
      } catch {}
    }, 1500);
  }

  // ============================================================
  // Phase 5+: AI Prompt Optimizer & Auto-Titling Endpoints
  // ============================================================

  private async handleOptimizePrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseJsonBody(req);
    const text = String(body.text || "").trim();
    if (!text) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "提示词草稿不能为空" }));
      return;
    }
    if (text.length > 15000) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "提示词长度超出限制 (最多 15000 字符)" }));
      return;
    }

    try {
      const result = await this.promptOptimizer.optimizePrompt(text, { usageSink: record => this.store.saveModelUsage?.(record), context: { traceId: crypto.randomUUID() } });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          optimizedText: result.optimizedText,
          model: result.model,
          durationMs: result.durationMs,
        })
      );
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message || "提示词优化失败，请稍后重试" }));
    }
  }

  private async handleGenerateConversationTitle(conversationId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const conv = await this.store.getConversation?.(conversationId);
    if (!conv) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Conversation '${conversationId}' not found` }));
      return;
    }

    try {
      const result = await this.sessionTitleService.generateTitle(conv.messages, { usageSink: record => this.store.saveModelUsage?.(record), context: { conversationId, traceId: crypto.randomUUID() } });
      if (result.title) {
        conv.title = result.title;
        conv.titleSource = "ai_generated";
        conv.titleRevision = (conv.titleRevision ?? 0) + 1;
        conv.updatedAt = Date.now();
        if (this.store.saveConversation) {
          await this.store.saveConversation(conv);
        }
        if (this.eventBus) {
          this.eventBus.emit({
            id: crypto.randomUUID(),
            type: "conversation.title_updated" as any,
            timestamp: new Date().toISOString(),
            projectId: "coordinator",
            sessionId: conversationId,
            data: {
              conversationId,
              title: result.title,
              titleSource: "ai_generated",
              titleRevision: conv.titleRevision,
            },
          });
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ title: conv.title, model: result.model }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message || "生成标题失败" }));
    }
  }

  /**
   * 异步触发会话智能命名 (AI Conversation Auto-Titling)
   * 铁律：必须完全异步执行，绝不阻塞 Coordinator Task Dispatch 或 Main Agent 思考执行！
   */
  private triggerAsyncTitleGeneration(conversationId: string, targetRevision: number): void {
    setImmediate(async () => {
      try {
        const conv = await this.store.getConversation?.(conversationId);
        if (!conv) return;

        // 手动重命名保护：用户已手动命名的会话绝对不自动覆盖 (Section 十一: USER_DEFINED)
        if (conv.titleSource === "user_defined") return;

        // 防竞态：当前版本如果已落后于目标版本，放弃本次过时生成
        if ((conv.titleRevision ?? 0) > targetRevision) return;

        const result = await this.sessionTitleService.generateTitle(conv.messages, { usageSink: record => this.store.saveModelUsage?.(record), context: { conversationId, traceId: crypto.randomUUID() } });
        if (!result.title || !result.title.trim()) return;

        // CAS 二次核验：再次获取最新会话，防止模型调用期间用户在界面进行了手动重命名或提交了新消息
        const latestConv = await this.store.getConversation?.(conversationId);
        if (!latestConv) return;
        if (latestConv.titleSource === "user_defined") return;
        if ((latestConv.titleRevision ?? 0) > targetRevision) return;

        const newRevision = Math.max(latestConv.titleRevision ?? 0, targetRevision) + 1;
        latestConv.title = result.title;
        latestConv.titleSource = "ai_generated";
        latestConv.titleRevision = newRevision;
        latestConv.updatedAt = Date.now();

        if (this.store.saveConversation) {
          await this.store.saveConversation(latestConv);
        }

        // 广播会话标题更新事件，实时驱动侧边栏与当前会话标题无感替换
        if (this.eventBus) {
          this.eventBus.emit({
            id: crypto.randomUUID(),
            type: "conversation.title_updated" as any,
            timestamp: new Date().toISOString(),
            projectId: "coordinator",
            sessionId: conversationId,
            data: {
              conversationId,
              title: result.title,
              titleSource: "ai_generated",
              titleRevision: newRevision,
            },
          });
        }
      } catch (err) {
        // 标题生成为辅助功能，失败记录警告，绝不干扰主会话
        console.warn(`[SessionTitleService] Auto-titling for conversation ${conversationId} failed:`, err);
      }
    });
  }

  // ============================================================
  // Phase 5: Global Real-Time Cluster SSE Stream
  // ============================================================

  private clusterSnapshot?: { expiresAt: number; pending: Promise<Record<string, unknown>> };

  private getClusterSnapshot(): Promise<Record<string, unknown>> {
    if (this.clusterSnapshot && this.clusterSnapshot.expiresAt > Date.now()) return this.clusterSnapshot.pending;
    const pending = (async () => {
      const [nodes, counts, approvals, graphs] = await Promise.all([
        this.store.listNodes(),
        this.store.getTaskCounts ? this.store.getTaskCounts() : this.store.listTasks({ status: "running", limit: 100000 }).then(tasks => ({ total: tasks.length, running: tasks.length })),
        this.store.listPendingApprovals(),
        this.store.listGraphs?.({ status: "running", limit: 100000 }) ?? [],
      ]);
      return { onlineNodes: this.registry.listOnlineConnections().filter(c => c.ws.readyState === 1).length,
        totalNodes: nodes.filter(n => n.status !== "revoked").length, historicalNodes: nodes.filter(n => n.status === "revoked").length,
        runningTasks: counts.running, pendingApprovals: approvals.length, activeGraphs: graphs.length, timestamp: Date.now() };
    })();
    this.clusterSnapshot = { expiresAt: Date.now() + 1000, pending };
    void pending.catch(() => { if (this.clusterSnapshot?.pending === pending) this.clusterSnapshot = undefined; });
    return pending;
  }

  private async handleGlobalEventStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    this.globalSseClients.add(res);
    res.once("close", () => this.globalSseClients.delete(res));

    // 断线重放：先按 Last-Event-ID 补齐缓存事件，再给一次全量快照。
    // 游标已超出缓冲范围时明确告知客户端，由前端强制重建状态，而不是静默丢事件。
    const cursor = this.readEventCursor(req);
    if (cursor > 0) {
      const oldest = this.globalEventReplay[0]?.seq ?? this.globalEventSeq + 1;
      if (cursor + 1 < oldest) {
        res.write(`event: stream.reset\ndata: ${JSON.stringify({ reason: "cursor_expired", cursor, oldest })}\n\n`);
      } else {
        for (const entry of this.globalEventReplay) {
          if (entry.seq > cursor) res.write(entry.frame);
        }
      }
    }
    res.write(`event: cluster.snapshot\ndata: ${JSON.stringify(await this.getClusterSnapshot())}\n\n`);
    pollStream(res, 5000, async () => {
      res.write(`event: cluster.heartbeat\ndata: ${JSON.stringify(await this.getClusterSnapshot())}\n\n`);
    });
  }

  // ============================================================
  // Phase 5: SPA Static Assets Serving
  // ============================================================

  private shouldServeStatic(pathname: string): boolean {
    if (pathname.startsWith("/api/")) return false;
    if (!this.webDistDir) return false;
    return fs.existsSync(this.webDistDir);
  }

  private async handleServeStatic(pathname: string, res: ServerResponse): Promise<void> {
    if (!this.webDistDir) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const MIME_MAP: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".webmanifest": "application/manifest+json",
    };

    let targetFile = path.join(this.webDistDir, pathname === "/" ? "index.html" : pathname);

    // 防目录逃逸
    const realDist = fs.realpathSync(this.webDistDir);
    if (fs.existsSync(targetFile)) {
      const realTarget = fs.realpathSync(targetFile);
      if (!realTarget.startsWith(realDist)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
    } else {
      // SPA Fallback: 客户端路由统一返回 index.html
      targetFile = path.join(this.webDistDir, "index.html");
      if (!fs.existsSync(targetFile)) {
        res.writeHead(404);
        res.end("Web bundle not built. Please run npm run build in apps/web.");
        return;
      }
    }

    const ext = path.extname(targetFile).toLowerCase();
    const contentType = MIME_MAP[ext] ?? "application/octet-stream";
    const stat = fs.statSync(targetFile);

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });

    fs.createReadStream(targetFile).pipe(res);
  }

  // ============================================================
  // Phase 5: Scheduled Tasks Handlers
  // ============================================================

  private async handleListScheduledTasks(url: URL, res: ServerResponse): Promise<void> {
    const enabledParam = url.searchParams.get("enabled");
    const targetType = url.searchParams.get("targetType") as any;
    const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 100;
    const offset = url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!, 10) : 0;

    const filter: any = { limit, offset };
    if (enabledParam !== null && enabledParam !== "") {
      filter.enabled = enabledParam === "true";
    }
    if (targetType) {
      filter.targetType = targetType;
    }

    const tasks = (await this.store.listScheduledTasks?.(filter)) ?? [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks, total: tasks.length }));
  }

  private async handleCreateScheduledTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseJsonBody(req);
    if (!body.name || !body.triggerType) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: name, triggerType" }));
      return;
    }

    if (body.triggerType === "cron") {
      if (!body.cronExpression || !isValidCronExpression(body.cronExpression)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Invalid cronExpression: ${body.cronExpression}` }));
        return;
      }
    } else if (body.triggerType === "interval") {
      if (!body.intervalMs || body.intervalMs <= 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Invalid intervalMs: ${body.intervalMs}` }));
        return;
      }
    }

    const id = `sched-${crypto.randomUUID()}`;
    const now = Date.now();
    const task: ScheduledTaskRecord = {
      id,
      name: body.name,
      description: body.description || "",
      enabled: body.enabled !== false,
      triggerType: body.triggerType,
      cronExpression: body.cronExpression,
      intervalMs: body.intervalMs,
      runAt: body.runAt,
      timezone: body.timezone || "UTC",
      targetType: body.targetType || "single_task",
      taskConfig: body.taskConfig ?? { goal: body.goal || body.name },
      graphConfig: body.graphConfig ?? { parentGoal: body.name },
      concurrencyPolicy: body.concurrencyPolicy || "SKIP_IF_RUNNING",
      misfirePolicy: body.misfirePolicy || "RUN_ONCE_IMMEDIATELY",
      maxConcurrency: body.maxConcurrency || 1,
      runCount: 0,
      createdBy: "web_admin",
      createdAt: now,
      updatedAt: now,
    };

    task.nextRunAt = EngineHelper.calculateNextRunTime(task, now);

    if (this.store.saveScheduledTask) {
      await this.store.saveScheduledTask(task);
    }
    if (this.scheduledEngine) {
      await this.scheduledEngine.reschedule();
    }

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(task));
  }

  private async handleGetScheduledTaskDetails(id: string, res: ServerResponse): Promise<void> {
    const task = await this.store.getScheduledTask?.(id);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Scheduled task '${id}' not found` }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(task));
  }

  private async handleUpdateScheduledTask(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const existing = await this.store.getScheduledTask?.(id);
    if (!existing) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Scheduled task '${id}' not found` }));
      return;
    }

    const body = await this.parseJsonBody(req);
    const patch: Partial<ScheduledTaskRecord> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.triggerType !== undefined) patch.triggerType = body.triggerType;
    if (body.cronExpression !== undefined) {
      if (body.cronExpression && !isValidCronExpression(body.cronExpression)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Invalid cronExpression: ${body.cronExpression}` }));
        return;
      }
      patch.cronExpression = body.cronExpression;
    }
    if (body.intervalMs !== undefined) patch.intervalMs = body.intervalMs;
    if (body.timezone !== undefined) patch.timezone = body.timezone;
    if (body.targetType !== undefined) patch.targetType = body.targetType;
    if (body.taskConfig !== undefined) patch.taskConfig = body.taskConfig;
    if (body.graphConfig !== undefined) patch.graphConfig = body.graphConfig;
    if (body.concurrencyPolicy !== undefined) patch.concurrencyPolicy = body.concurrencyPolicy;
    if (body.misfirePolicy !== undefined) patch.misfirePolicy = body.misfirePolicy;
    if (body.maxConcurrency !== undefined) patch.maxConcurrency = body.maxConcurrency;

    const merged = { ...existing, ...patch };
    patch.nextRunAt = EngineHelper.calculateNextRunTime(merged);

    const updated = await this.store.updateScheduledTask?.(id, patch);
    if (this.scheduledEngine) {
      await this.scheduledEngine.reschedule();
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(updated));
  }

  private async handleDeleteScheduledTask(id: string, res: ServerResponse): Promise<void> {
    const success = (await this.store.deleteScheduledTask?.(id)) ?? false;
    if (!success) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Scheduled task '${id}' not found or already deleted` }));
      return;
    }
    if (this.scheduledEngine) {
      await this.scheduledEngine.reschedule();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, id }));
  }

  private async handlePauseScheduledTask(id: string, res: ServerResponse): Promise<void> {
    const updated = await this.store.updateScheduledTask?.(id, { enabled: false });
    if (!updated) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Scheduled task '${id}' not found` }));
      return;
    }
    if (this.scheduledEngine) {
      await this.scheduledEngine.reschedule();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(updated));
  }

  private async handleResumeScheduledTask(id: string, res: ServerResponse): Promise<void> {
    const existing = await this.store.getScheduledTask?.(id);
    if (!existing) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Scheduled task '${id}' not found` }));
      return;
    }
    const nextRun = EngineHelper.calculateNextRunTime(existing);
    const updated = await this.store.updateScheduledTask?.(id, { enabled: true, nextRunAt: nextRun });
    if (this.scheduledEngine) {
      await this.scheduledEngine.reschedule();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(updated));
  }

  private async handleRunScheduledTaskNow(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.scheduledEngine) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Scheduled engine is not active on this coordinator" }));
      return;
    }
    let body: any = {};
    try {
      body = await this.parseJsonBody(req);
    } catch {}

    try {
      const run = await this.scheduledEngine.runNow(id, Boolean(body.force));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, run }));
    } catch (err: any) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message || String(err) }));
    }
  }

  private async handleGetScheduledTaskHistory(id: string, url: URL, res: ServerResponse): Promise<void> {
    const status = url.searchParams.get("status") as any;
    const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 50;
    const offset = url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!, 10) : 0;

    const runs = (await this.store.listScheduledTaskRuns?.(id, { status, limit, offset })) ?? [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ runs, total: runs.length }));
  }

  // ============================================================
  // Phase 5: Security Decision Audit Handlers
  // ============================================================

  private async handleListSecurityAudits(url: URL, res: ServerResponse): Promise<void> {
    const filter: SecurityAuditFilter = {};
    if (url.searchParams.get("verdict")) {
      filter.verdict = url.searchParams.get("verdict") as any;
    }
    if (url.searchParams.get("decisionSource")) {
      filter.decisionSource = url.searchParams.get("decisionSource") as any;
    }
    if (url.searchParams.get("riskCategory")) {
      filter.riskCategory = url.searchParams.get("riskCategory")!;
    }
    if (url.searchParams.get("reviewStatus")) {
      filter.reviewStatus = url.searchParams.get("reviewStatus") as any;
    }
    if (url.searchParams.get("taskId")) {
      filter.taskId = url.searchParams.get("taskId")!;
    }
    if (url.searchParams.get("nodeId")) {
      filter.nodeId = url.searchParams.get("nodeId")!;
    }
    if (url.searchParams.get("from")) {
      filter.fromTimestamp = parseInt(url.searchParams.get("from")!, 10);
    }
    if (url.searchParams.get("to")) {
      filter.toTimestamp = parseInt(url.searchParams.get("to")!, 10);
    }
    filter.limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 50;
    filter.offset = url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!, 10) : 0;

    const result = (await this.store.listSecurityAudits?.(filter)) ?? { items: [], total: 0 };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  }

  private async handleGetSecurityAuditDetails(id: string, res: ServerResponse): Promise<void> {
    const audit = await this.store.getSecurityAudit?.(id);
    if (!audit) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Security audit record '${id}' not found` }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(audit));
  }

  private async handleSubmitSecurityAuditFeedback(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const audit = await this.store.getSecurityAudit?.(id);
    if (!audit) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Security audit record '${id}' not found` }));
      return;
    }

    const body = await this.parseJsonBody(req);
    if (!body.status || !["unreviewed", "confirmed_risk", "false_positive", "needs_investigation"].includes(body.status)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid review status" }));
      return;
    }

    const feedback = {
      status: body.status,
      reviewedBy: body.reviewedBy || "web_admin",
      comment: body.comment || "",
      reviewedAt: Date.now(),
    };

    const updated = await this.store.updateSecurityAuditFeedback?.(id, feedback);

    // 铁律校验反馈：若为硬拦截，明确返回提示不可绕过
    const responsePayload: any = {
      success: true,
      audit: updated,
    };
    if (audit.isHardBlock) {
      responsePayload.hardBlockEnforced = true;
      responsePayload.warning = "此操作命中确定性硬拦截规则 (Hard Block)。复核标记已记录为安全模型调优凭据，系统坚决不会自动放行或绕过硬安全规则。";
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responsePayload));
  }

  private async handleGetSecurityAuditStats(url: URL, res: ServerResponse): Promise<void> {
    const windowMs = url.searchParams.get("windowMs") ? parseInt(url.searchParams.get("windowMs")!, 10) : undefined;
    const stats = (await this.store.getSecurityAuditStats?.(windowMs)) ?? {
      totalCount: 0,
      allowCount: 0,
      blockCount: 0,
      requireApprovalCount: 0,
      sourceCounts: { LLM_MONITOR: 0, DETERMINISTIC_POLICY: 0, USER_APPROVAL: 0, SYSTEM_FAILURE: 0 },
      falsePositiveCount: 0,
      topRiskCategories: [],
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats));
  }
}
