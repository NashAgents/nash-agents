import os from "node:os";
import path from "node:path";
import { createLocalClusterStore } from "../storage/local-cluster-store.js";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import { ClusterDatabase } from "../storage/db.js";
import {
  ClusterStorageError,
  type IClusterStore,
  InMemoryClusterStore,
  PostgresClusterStore,
} from "../storage/cluster-store.js";
import { NodeIdentity } from "../identity/node-identity.js";
import { InviteManager } from "../identity/invite-manager.js";
import { NodeRegistry } from "./node-registry.js";
import { RoutingValidator } from "../router/routing-validator.js";
import { TaskScheduler } from "./task-scheduler.js";
import { TaskSupervisor } from "./task-supervisor.js";
import { WssGateway } from "./wss-gateway.js";
import { AdmissionControl } from "./admission-control.js";
import { ClusterApiHandler } from "./api-server.js";
import { CoordinatorCatalogService } from "./catalog/coordinator-catalog-service.js";
import { ClusterSearchService } from "./catalog/cluster-search-service.js";
import { SemanticTaskRouter } from "../router/semantic-task-router.js";
import { RoutingFeedbackController } from "../router/routing-feedback-controller.js";
import { ArtifactService } from "../artifacts/artifact-service.js";
import { DistributedMailbox } from "../a2a/distributed-mailbox.js";
import { AutonomousPlanner } from "../graph/autonomous-planner.js";
import { DistributedGraphOrchestrator } from "../graph/graph-orchestrator.js";
import { ResultVerifier } from "../graph/result-verifier.js";
import { GraphReplanner } from "../graph/graph-replanner.js";
import { GlobalGraphSupervisor } from "../graph/global-graph-supervisor.js";
import { GraphStateProjection } from "../graph/graph-state-projection.js";
import { AutonomousDiscoveryService } from "../discovery/index.js";
import { CoordinatorMainAgent } from "./main-agent/index.js";
import { EventBus } from "../../observability/event-bus.js";
import { ScheduleTriggerEngine } from "../scheduled/schedule-trigger-engine.js";
import { ProductStore } from "../../product/store.js";
import { readProductModels } from "../../product/runtime.js";
import { resolveNashHome } from "../../config/data-home.js";

export interface ClusterCoordinatorConfig {
  productStore?: ProductStore;
  customDir?: string;
  ephemeral?: boolean;
  listenHost?: string;
  listenPort?: number;
  publicUrl?: string;
  databaseUrl?: string;
  adminApiKey?: string;
  tls?: {
    certPath?: string;
    keyPath?: string;
  };
  nodeId?: string;
  name?: string;
  webDistDir?: string;
}

export class ClusterCoordinator {
  private readonly server: http.Server | https.Server;
  private readonly store: IClusterStore;
  private readonly db?: ClusterDatabase;
  private readonly identity: NodeIdentity;
  private readonly inviteManager: InviteManager;
  private readonly registry: NodeRegistry;
  private readonly scheduler: TaskScheduler;
  private readonly supervisor: TaskSupervisor;
  private readonly catalogService: CoordinatorCatalogService;
  private readonly searchService: ClusterSearchService;
  private readonly semanticRouter: SemanticTaskRouter;
  private readonly feedbackController: RoutingFeedbackController;
  private readonly artifactService: ArtifactService;
  private readonly distributedMailbox: DistributedMailbox;
  private readonly autonomousPlanner: AutonomousPlanner;
  private readonly graphOrchestrator: DistributedGraphOrchestrator;
  private readonly resultVerifier: ResultVerifier;
  private readonly graphReplanner: GraphReplanner;
  private readonly globalSupervisor: GlobalGraphSupervisor;
  private readonly graphProjection: GraphStateProjection;
  private readonly discoveryService: AutonomousDiscoveryService;
  private readonly eventBus: EventBus;
  private readonly scheduledEngine: ScheduleTriggerEngine;
  private readonly mainAgent: CoordinatorMainAgent;
  private readonly gateway: WssGateway;
  private readonly apiHandler: ClusterApiHandler;
  /** 准入 / 排空控制；在 Gateway 之后创建，供调度器闸门与 API 共享。 */
  private readonly admission: AdmissionControl;
  private readonly temporaryDirectory?: string;
  private isRunning = false;

  constructor(private readonly config: ClusterCoordinatorConfig = {}) {
    this.temporaryDirectory = config.ephemeral ? fs.mkdtempSync(path.join(os.tmpdir(), "nash-coordinator-")) : undefined;
    const baseDirectory = this.temporaryDirectory ?? config.customDir ?? resolveNashHome();
    this.identity = new NodeIdentity({
      customDir: baseDirectory,
      explicitNodeId: config.nodeId,
      name: config.name ?? "Coordinator",
      role: "coordinator",
    });

    // 1. 初始化持久化存储
    if (config.databaseUrl) {
      this.db = new ClusterDatabase(config.databaseUrl);
      this.store = new PostgresClusterStore(this.db);
    } else {
      this.store = config.ephemeral ? new InMemoryClusterStore() : createLocalClusterStore(path.join(baseDirectory, "cluster", "state.bin"));
    }

    this.eventBus = new EventBus();
    this.inviteManager = new InviteManager(config.productStore);
    this.registry = new NodeRegistry(this.store, this.inviteManager);
    this.scheduler = new TaskScheduler(
      this.store,
      this.registry,
      this.identity.nodeId,
      10000,
      () => !config.productStore?.pendingSecurityApply(),
      () => this.admission.isFrozen(),
    );
    // 仅回收「派发后从未被 Worker 接受」的任务；Worker 接手后的执行时长由 Worker 自身预算裁决。
    this.supervisor = new TaskSupervisor(this.store, this.registry, 180_000, this.scheduler, this.eventBus);

    // 2. 初始化 Catalog 与联邦检索中枢服务 (Phase 2)
    this.catalogService = new CoordinatorCatalogService(
      this.store,
      this.registry,
      this.identity.nodeId
    );
    this.searchService = new ClusterSearchService(
      this.store,
      this.registry,
      this.catalogService
    );

    // 3. 初始化语义任务路由器与执行反馈控制器 (Phase 3)
    this.semanticRouter = new SemanticTaskRouter({
      store: this.store,
      registry: this.registry,
      scheduler: this.scheduler,
      searchService: this.searchService,
      catalogService: this.catalogService,
      enableAgentLoopConsultation: true,
    });
    this.feedbackController = new RoutingFeedbackController(this.store, this.scheduler);

    // 4. 初始化 Phase 4 分布式任务图、A2A 邮箱与产物服务
    this.artifactService = new ArtifactService(this.store, path.join(baseDirectory, "cluster", "artifacts"));
    this.distributedMailbox = new DistributedMailbox(this.store, this.identity.nodeId, this.registry);
    const modelSnapshotProvider = () => config.productStore ? readProductModels(config.productStore.homeDir) : undefined;
    const defaultLlmClient = AutonomousPlanner.createDefaultLlmClient({ usageSink: (record) => this.store.saveModelUsage?.(record) }, modelSnapshotProvider);
    this.resultVerifier = new ResultVerifier(this.store, this.artifactService, config.ephemeral ? undefined : defaultLlmClient);
    this.autonomousPlanner = new AutonomousPlanner({ searchService: this.searchService, store: this.store, llmClient: defaultLlmClient, validator: new RoutingValidator(this.store, this.registry) });
    this.graphOrchestrator = new DistributedGraphOrchestrator({
      eventBus: this.eventBus,
      store: this.store,
      scheduler: this.scheduler,
      router: this.semanticRouter,
      validator: new RoutingValidator(this.store, this.registry),
      artifactService: this.artifactService,
      verifier: this.resultVerifier,
    });
    this.graphReplanner = new GraphReplanner(this.store, this.graphOrchestrator, defaultLlmClient);
    this.globalSupervisor = new GlobalGraphSupervisor(
      this.store,
      this.registry,
      this.graphOrchestrator,
      this.graphReplanner
    );
    this.graphProjection = new GraphStateProjection(this.store);

    // 5. 初始化自主发现服务与 Coordinator 主智能体 (Phase 6 / LLM-Driven Coordinator)
    this.discoveryService = new AutonomousDiscoveryService({
      store: this.store,
      registry: this.registry,
      scheduler: this.scheduler,
      // 生产装配必须注入 eventBus：否则 discovery.started / scout_dispatched /
      // scout_completed / completed 全部被静默丢弃，Web 端永远收不到 Scout 进度。
      eventBus: this.eventBus,
    });

    this.scheduledEngine = new ScheduleTriggerEngine({
      store: this.store,
      scheduler: this.scheduler,
      coordinatorNodeId: this.identity.nodeId,
      orchestrator: this.graphOrchestrator,
      eventBus: this.eventBus,
    });

    this.mainAgent = new CoordinatorMainAgent({
      modelSnapshotProvider,
      store: this.store,
      registry: this.registry,
      scheduler: this.scheduler,
      searchService: this.searchService,
      catalogService: this.catalogService,
      discoveryService: this.discoveryService,
      semanticRouter: this.semanticRouter,
      feedbackController: this.feedbackController,
      planner: this.autonomousPlanner,
      orchestrator: this.graphOrchestrator,
      replanner: this.graphReplanner,
      mailbox: this.distributedMailbox,
      artifactService: this.artifactService,
      graphProjection: this.graphProjection,
      eventBus: this.eventBus,
      scheduledEngine: this.scheduledEngine,
      coordinatorNodeId: this.identity.nodeId,
      // 事实核验失败后用于「重新生成有依据的答案」；ephemeral 环境下不注入，退化为确定性标注。
      llmClient: config.ephemeral ? undefined : defaultLlmClient,
    });

    this.apiHandler = new ClusterApiHandler({
      productStore: config.productStore,
      store: this.store,
      registry: this.registry,
      scheduler: this.scheduler,
      inviteManager: this.inviteManager,
      coordinatorNodeId: this.identity.nodeId,
      adminApiKey: config.adminApiKey ?? process.env.NASH_ADMIN_API_KEY,
      trustProxy: process.env.NASH_TRUST_PROXY === "1",
      allowedOrigins: process.env.NASH_WEB_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean),
      catalogService: this.catalogService,
      searchService: this.searchService,
      semanticRouter: this.semanticRouter,
      feedbackController: this.feedbackController,
      planner: this.autonomousPlanner,
      orchestrator: this.graphOrchestrator,
      artifactService: this.artifactService,
      replanner: this.graphReplanner,
      webDistDir: config.webDistDir,
      discoveryService: this.discoveryService,
      mainAgent: this.mainAgent,
      eventBus: this.eventBus,
      scheduledEngine: this.scheduledEngine,
    });

    // 5. 创建 HTTP / HTTPS 服务
    if (config.tls) {
      if (!config.tls.certPath || !config.tls.keyPath) {
        throw new Error("TLS configuration incomplete: both certPath and keyPath are required");
      }
      if (!fs.existsSync(config.tls.certPath)) {
        throw new Error(`TLS certificate file not found: ${config.tls.certPath}`);
      }
      if (!fs.existsSync(config.tls.keyPath)) {
        throw new Error(`TLS key file not found: ${config.tls.keyPath}`);
      }
      let cert: Buffer;
      let key: Buffer;
      try {
        cert = fs.readFileSync(config.tls.certPath);
        key = fs.readFileSync(config.tls.keyPath);
        tls.createSecureContext({ cert, key });
      } catch (err) {
        throw new Error(`Invalid TLS certificate or key: ${err instanceof Error ? err.message : String(err)}`);
      }
      const options = { cert, key };
      this.server = https.createServer(options, (req, res) => {
        this.apiHandler.handleRequest(req, res);
      });
    } else {
      this.server = http.createServer((req, res) => {
        this.apiHandler.handleRequest(req, res);
      });
    }

    // 6. 挂载 WSS Gateway
    this.gateway = new WssGateway({
      server: this.server,
      path: "/ws/cluster",
      store: this.store,
      registry: this.registry,
      coordinatorNodeId: this.identity.nodeId,
      catalogService: this.catalogService,
      graphOrchestrator: this.graphOrchestrator,
      scheduler: this.scheduler,
      mailbox: this.distributedMailbox,
      eventBus: this.eventBus,
      discoveryService: this.discoveryService,
      productStore: config.productStore,
    });

    // 7. 准入控制：真实运行态排空证明（Worker 探针 + 本进程轮次 + 集群存储）
    this.admission = new AdmissionControl({
      store: this.store,
      registry: this.registry,
      gateway: this.gateway,
      liveTurns: () => this.apiHandler.listLiveTurns(),
    });
    this.apiHandler.setAdmissionControl(this.admission);
  }

  get nodeId(): string {
    return this.identity.nodeId;
  }

  getStore(): IClusterStore {
    return this.store;
  }

  getRegistry(): NodeRegistry {
    return this.registry;
  }

  getScheduler(): TaskScheduler {
    return this.scheduler;
  }

  getAdmissionControl(): AdmissionControl {
    return this.admission;
  }

  getInviteManager(): InviteManager {
    return this.inviteManager;
  }

  getCatalogService(): CoordinatorCatalogService {
    return this.catalogService;
  }

  getSearchService(): ClusterSearchService {
    return this.searchService;
  }

  getSemanticRouter(): SemanticTaskRouter {
    return this.semanticRouter;
  }

  getFeedbackController(): RoutingFeedbackController {
    return this.feedbackController;
  }

  getArtifactService(): ArtifactService {
    return this.artifactService;
  }

  getDistributedMailbox(): DistributedMailbox {
    return this.distributedMailbox;
  }

  getAutonomousPlanner(): AutonomousPlanner {
    return this.autonomousPlanner;
  }

  getGraphOrchestrator(): DistributedGraphOrchestrator {
    return this.graphOrchestrator;
  }

  getResultVerifier(): ResultVerifier {
    return this.resultVerifier;
  }

  getGraphReplanner(): GraphReplanner {
    return this.graphReplanner;
  }

  getGlobalSupervisor(): GlobalGraphSupervisor {
    return this.globalSupervisor;
  }

  getGraphProjection(): GraphStateProjection {
    return this.graphProjection;
  }

  getDiscoveryService(): AutonomousDiscoveryService {
    return this.discoveryService;
  }

  getMainAgent(): CoordinatorMainAgent {
    return this.mainAgent;
  }

  getScheduledEngine(): ScheduleTriggerEngine {
    return this.scheduledEngine;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.isRunning) {
      const addr = this.server.address() as any;
      return { host: addr?.address ?? "127.0.0.1", port: addr?.port ?? this.config.listenPort ?? 18443 };
    }

    try {
    // 若配置了 Postgres，先连库并运行迁移
    if (this.db) {
      const connected = await this.db.connect();
      if (!connected) throw new ClusterStorageError("Configured PostgreSQL is unavailable; Coordinator startup refused");
      await this.db.runMigrations();
    }

    this.registry.startMonitoring(10000);
    this.supervisor.start(15000);
    this.scheduler.start();
    this.globalSupervisor.start(10000);
    await this.scheduledEngine.start();

    const host = this.config.listenHost ?? "127.0.0.1";
    const port = this.config.listenPort ?? 18443;

    await new Promise<void>((resolve, reject) => {
      this.server.listen(port, host, () => {
        this.isRunning = true;
        resolve();
      });
      this.server.once("error", reject);
    });

    const actualAddr = this.server.address() as any;
    return {
      host: actualAddr?.address ?? host,
      port: actualAddr?.port ?? port,
    };
    } catch (error) { await this.stop(); throw error; }
  }

  async stop(): Promise<void> {
    this.scheduledEngine.stop();
    this.globalSupervisor.stop();
    this.supervisor.stop();
    this.scheduler.stop();
    this.registry.stopMonitoring();
    this.gateway.close();
    this.apiHandler.close();

    if (this.server.listening) await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });

    if (this.db) {
      await this.db.close();
    }

    this.isRunning = false;
    if (this.temporaryDirectory) fs.rmSync(this.temporaryDirectory, { recursive: true, force: true });
  }
}
