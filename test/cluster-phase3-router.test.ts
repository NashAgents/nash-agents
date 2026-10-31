import { simulatedCapabilities, simulatedSandbox } from "./helpers/runtime-truth-fixtures.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";
import { CoordinatorCatalogService } from "../src/cluster/coordinator/catalog/coordinator-catalog-service.js";
import { ClusterSearchService } from "../src/cluster/coordinator/catalog/cluster-search-service.js";
import { ClusterApiHandler } from "../src/cluster/coordinator/api-server.js";

import {
  TaskIntentAnalyzer,
  RoutingCandidateCollector,
  RoutingCandidateRanker,
  RoutingValidator,
  RoutingDecisionEngine,
  RoutingSessionManager,
  AutonomousDispatchService,
  RoutingFeedbackController,
  SemanticTaskRouter,
} from "../src/cluster/router/index.js";
import {
  createClusterAgentTools,
  RouteClusterTaskTool,
  DispatchClusterTaskTool,
} from "../src/cluster/tools/cluster-tools.js";

describe("Nash Cluster Phase 3: Semantic Task Router & Autonomous Dispatch", () => {
  let store: InMemoryClusterStore;
  let inviteManager: InviteManager;
  let registry: NodeRegistry;
  let scheduler: TaskScheduler;
  let catalogService: CoordinatorCatalogService;
  let searchService: ClusterSearchService;
  let router: SemanticTaskRouter;
  let feedbackController: RoutingFeedbackController;

  const COORD_ID = "node-coord-test";
  const MAC_NODE_ID = "node-example-mac";
  const TENCENT_NODE_ID = "node-example-cloud";
  const WSL_NODE_ID = "node-example-wsl";

  beforeEach(async () => {
    store = new InMemoryClusterStore();
    inviteManager = new InviteManager();
    registry = new NodeRegistry(store, inviteManager);
    scheduler = new TaskScheduler(store, registry, COORD_ID);
    catalogService = new CoordinatorCatalogService(store, registry, COORD_ID);
    searchService = new ClusterSearchService(store, registry, catalogService);
    feedbackController = new RoutingFeedbackController(store, scheduler);

    router = new SemanticTaskRouter({
      store,
      registry,
      scheduler,
      searchService,
      catalogService,
      enableAgentLoopConsultation: false,
    });

    // 注册三个标准节点
    await store.saveNode({
      nodeId: MAC_NODE_ID,
      name: "MacBook-Worker",
      role: "worker",
      platform: "darwin",
      arch: "arm64",
      hostname: "macbook.local",
      tokenHash: "hash-mac",
      status: "online",
      lastSeenAt: Date.now(),
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await store.saveNode({
      nodeId: TENCENT_NODE_ID,
      name: "Tencent-Ubuntu-Worker",
      role: "worker",
      platform: "linux",
      arch: "x64",
      hostname: "tencent-vm",
      tokenHash: "hash-tencent",
      status: "online",
      lastSeenAt: Date.now(),
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await store.saveNode({
      nodeId: WSL_NODE_ID,
      name: "WSL2-Worker",
      role: "worker",
      platform: "linux",
      arch: "x64",
      hostname: "wsl2-ubuntu",
      tokenHash: "hash-wsl",
      status: "online",
      lastSeenAt: Date.now(),
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 模拟注册节点在线连接
    (registry as any).connections.set(MAC_NODE_ID, {
      ws: { readyState: 1, send: () => {} },
      generation: 1,
      remoteIp: "127.0.0.1",
      connectedAt: Date.now(),
      lastPingAt: Date.now(),
      missedPings: 0,
    });
    (registry as any).connections.set(TENCENT_NODE_ID, {
      ws: { readyState: 1, send: () => {} },
      generation: 1,
      remoteIp: "203.0.113.10",
      connectedAt: Date.now(),
      lastPingAt: Date.now(),
      missedPings: 0,
    });
    (registry as any).connections.set(WSL_NODE_ID, {
      ws: { readyState: 1, send: () => {} },
      generation: 1,
      remoteIp: "192.0.2.10",
      connectedAt: Date.now(),
      lastPingAt: Date.now(),
      missedPings: 0,
    });

    for (const n of await store.listNodes()) await store.saveCatalogRevision(n.nodeId, 1, simulatedCapabilities(n.platform));
    // 录入测试 Catalog 数据
    // 1. Mac 项目: nash-agent 源码与 srt-project
    await store.upsertProjectCatalog([
      {
        nodeId: MAC_NODE_ID,
        projectId: "proj-nash-agent",
        name: "nash-agent",
        summary: "Nash Agent 核心 Harness 源码，含 AgentLoop、沙箱与 MCP 模块",
        description: "Enterprise-grade autonomous agent loop with seatbelt sandbox",
        technologies: ["TypeScript", "Node.js", "ESM"],
        capabilities: ["AgentLoop", "MCP Client", "Sandbox"],
        status: "active",
        visibility: "retrievable",
        registeredAt: Date.now() - 100000,
        updatedAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision: 1,
        userAliases: ["nash-agents"],
      },
      {
        nodeId: MAC_NODE_ID,
        projectId: "proj-srt-project",
        name: "srt-project",
        summary: "专业英语文献阅读器与高精度逐句音频播放器，支持字幕实时同步滚动",
        description: "Electron + Sherpa ASR audio synced reader",
        technologies: ["TypeScript", "Electron", "Vite"],
        capabilities: ["Audio Playback", "Subtitle Highlighting", "Whisper ASR"],
        status: "active",
        visibility: "summary",
        registeredAt: Date.now() - 100000,
        updatedAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision: 1,
        userAliases: ["english-reader"],
      },
    ]);

    // 2. 腾讯云项目: nash-cluster
    await store.upsertProjectCatalog([
      {
        nodeId: TENCENT_NODE_ID,
        projectId: "proj-nash-cluster",
        name: "nash-cluster",
        summary: "Nash Cluster 分布式 Coordinator 服务部署工程",
        description: "Coordinator runtime, Postgres, WSS gateway",
        technologies: ["Node.js", "PostgreSQL", "Systemd"],
        capabilities: ["Cluster Coordinator", "TaskScheduler"],
        status: "active",
        visibility: "summary",
        registeredAt: Date.now() - 100000,
        updatedAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision: 1,
        userAliases: ["cluster-deploy"],
      },
    ]);

    // 3. WSL2 项目: system-probe
    await store.upsertProjectCatalog([
      {
        nodeId: WSL_NODE_ID,
        projectId: "proj-system-probe",
        name: "system-probe",
        summary: "WSL2 环境探针与 GPU CUDA 探测项目",
        description: "Hardware detector for PyTorch and NVIDIA GPU",
        technologies: ["Python", "Shell"],
        capabilities: ["Hardware Probe"],
        status: "active",
        visibility: "summary",
        registeredAt: Date.now() - 100000,
        updatedAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision: 1,
        userAliases: [],
      },
    ]);

    // 4. 录入 MCP 能力 (腾讯云部署了 Bilibili MCP，状态 available)
    await store.upsertMCPCatalog([
      {
        nodeId: TENCENT_NODE_ID,
        serverId: "bilibili-subtitles",
        displayName: "Bilibili Subtitle MCP",
        transportType: "stdio",
        status: "available",
        capabilitySummary: "提取 Bilibili (B站) 视频字幕与音频文本",
        tools: [
          {
            toolName: "extract_bilibili_subtitles",
            description: "提取 B站字幕文档",
            parameterNames: ["url"],
            riskClassification: "read-only",
            available: true,
          },
        ],
        resourceCount: 0,
        promptCount: 0,
        lastVerifiedAt: Date.now(),
        revision: 1,
      },
      // 模拟 Mac 上也配了一个 Bilibili MCP，但是 status: needs_auth
      {
        nodeId: MAC_NODE_ID,
        serverId: "bilibili-subtitles-unauth",
        displayName: "bilibili-subtitles",
        transportType: "stdio",
        status: "needs_auth",
        capabilitySummary: "提取 B站字幕文档 (待配置 Cookie)",
        tools: [
          {
            toolName: "extract_bilibili_subtitles",
            description: "提取 B站字幕文档",
            parameterNames: ["url"],
            riskClassification: "read-only",
            available: false,
          },
        ],
        resourceCount: 0,
        promptCount: 0,
        lastVerifiedAt: Date.now(),
        revision: 1,
      },
    ]);

    // 5. 录入 Federated Memory 索引
    await store.upsertMemoryIndex([
      {
        nodeId: MAC_NODE_ID,
        projectId: "proj-nash-agent",
        entryId: "fed-nash-mcp",
        topic: "nash-agent · mcp",
        summary: "Nash MCP 模块位于 src/mcp/，原生实现 stdio、sse 与 streamable-http 三协议自适应协商",
        keywords: ["mcp", "protocol", "nash-agent", "client"],
        sourceReference: "mem-nash-mcp-002",
        confidence: 0.95,
        visibility: "retrievable",
        revision: 1,
        updatedAt: Date.now(),
      },
      {
        nodeId: MAC_NODE_ID,
        projectId: "proj-srt-project",
        entryId: "fed-srt-asr",
        topic: "srt-project · subtitle-sync",
        summary: "音频同步使用 Sherpa-onnx 实时流式对齐引擎，毫秒级同步显示当前句子并高亮播放",
        keywords: ["subtitle", "highlight", "audio", "player", "english"],
        sourceReference: "mem-srt-asr-002",
        confidence: 1.0,
        visibility: "summary",
        revision: 1,
        updatedAt: Date.now(),
      },
    ]);
  });

  // ------------------------------------------------------------
  // 1. TaskIntentAnalyzer 意图解析测试
  // ------------------------------------------------------------
  describe("1. TaskIntentAnalyzer", () => {
    const analyzer = new TaskIntentAnalyzer();

    test("能够准确识别 inspect 操作类型与只读硬约束", () => {
      const intent = analyzer.analyze("检查之前开发的 Nash 沙箱模块，不要修改代码");
      assert.equal(intent.operation, "inspect");
      assert.equal(intent.constraints.readOnly, true);
      assert.ok(intent.projectHints.includes("nash-agent"));
    });

    test("能够识别 fix 操作与修改风险提示", () => {
      const intent = analyzer.analyze("修复 Nash Agent 中英语阅读器字幕高亮滚动的 Bug");
      assert.equal(intent.operation, "fix");
      assert.equal(intent.constraints.readOnly, undefined);
      assert.ok(intent.projectHints.includes("nash-agent"));
      assert.ok(intent.riskHints.length > 0);
    });

    test("能够提取节点别名与硬约束", () => {
      const intent = analyzer.analyze("必须在 WSL2 上检查 Python 环境与 CUDA 是否可用", undefined, [{ nodeId: WSL_NODE_ID, name: "WSL2 fixture", platform: "linux" }]);
      assert.equal(intent.constraints.explicitNodeId, WSL_NODE_ID);
      assert.ok(intent.requiredCapabilities.includes("cuda"));
    });
  });

  // ------------------------------------------------------------
  // 2. Candidate Ranker & Hard Constraints 校验
  // ------------------------------------------------------------
  describe("2. Candidate Ranker & Hard Constraints", () => {
    test("用户显式约束节点时，排除非目标节点", () => {
      const analyzer = new TaskIntentAnalyzer();
      const ranker = new RoutingCandidateRanker();

      const intent = analyzer.analyze("必须在 WSL2 上执行检查", undefined, [{ nodeId: WSL_NODE_ID, name: "WSL2 fixture", platform: "linux" }]);
      const candidates = [
        {
          nodeId: MAC_NODE_ID,
          projectId: "proj-nash-agent",
          projectName: "nash-agent",
          projectSummary: "Nash agent",
          technologies: [],
          capabilities: [],
          nodeOnline: true,
          projectStatus: "active" as const,
          score: 0.9,
          confidence: 0.9,
          hardConstraintsSatisfied: true,
          unsatisfiedConstraints: [],
          evidences: [],
          requiredSkillsAvailable: true,
          requiredMCPAvailable: true,
        },
        {
          nodeId: WSL_NODE_ID,
          projectId: "proj-system-probe",
          projectName: "system-probe",
          projectSummary: "Probe",
          technologies: [],
          capabilities: [],
          nodeOnline: true,
          projectStatus: "active" as const,
          score: 0.6,
          confidence: 0.9,
          hardConstraintsSatisfied: true,
          unsatisfiedConstraints: [],
          evidences: [],
          requiredSkillsAvailable: true,
          requiredMCPAvailable: true,
        },
      ];

      const ranked = ranker.rank(intent, candidates);
      assert.equal(ranked[0]!.nodeId, WSL_NODE_ID);
      assert.equal(ranked[0]!.hardConstraintsSatisfied, true);
      assert.equal(ranked[1]!.hardConstraintsSatisfied, false);
      assert.match(ranked[1]!.unsatisfiedConstraints[0]!, /显式约束节点/);
    });

    test("目标节点离线时，硬约束不满足并排在后面", () => {
      const analyzer = new TaskIntentAnalyzer();
      const ranker = new RoutingCandidateRanker();
      const intent = analyzer.analyze("检查项目");

      const candidates = [
        {
          nodeId: MAC_NODE_ID,
          projectId: "proj-nash-agent",
          projectName: "nash-agent",
          projectSummary: "Nash",
          technologies: [],
          capabilities: [],
          nodeOnline: false, // 离线
          projectStatus: "active" as const,
          score: 0.9,
          confidence: 0.9,
          hardConstraintsSatisfied: true,
          unsatisfiedConstraints: [],
          evidences: [],
          requiredSkillsAvailable: true,
          requiredMCPAvailable: true,
        },
        {
          nodeId: TENCENT_NODE_ID,
          projectId: "proj-nash-cluster",
          projectName: "nash-cluster",
          projectSummary: "Cluster",
          technologies: [],
          capabilities: [],
          nodeOnline: true, // 在线
          projectStatus: "active" as const,
          score: 0.8,
          confidence: 0.9,
          hardConstraintsSatisfied: true,
          unsatisfiedConstraints: [],
          evidences: [],
          requiredSkillsAvailable: true,
          requiredMCPAvailable: true,
        },
      ];

      const ranked = ranker.rank(intent, candidates);
      assert.equal(ranked[0]!.nodeId, TENCENT_NODE_ID);
      assert.equal(ranked[0]!.hardConstraintsSatisfied, true);
      assert.equal(ranked[1]!.nodeOnline, false);
      assert.equal(ranked[1]!.hardConstraintsSatisfied, false);
    });
  });

  // ------------------------------------------------------------
  // 3. Routing Validator 确定性安全验证
  // ------------------------------------------------------------
  describe("3. Routing Validator", () => {
    let validator: RoutingValidator;

    beforeEach(() => {
      validator = new RoutingValidator(store, registry);
    });

    test("合法在线项目通过校验", async () => {
      const res = await validator.validateCandidate(
        {
          nodeId: MAC_NODE_ID,
          projectId: "proj-nash-agent",
          projectName: "nash-agent",
          projectSummary: "",
          technologies: [],
          capabilities: [],
          nodeOnline: true,
          projectStatus: "active",
          score: 0.9,
          confidence: 0.9,
          hardConstraintsSatisfied: true,
          unsatisfiedConstraints: [],
          evidences: [],
          requiredSkillsAvailable: true,
          requiredMCPAvailable: true,
        },
        {
          originalRequest: "test",
          goal: "test",
          operation: "inspect",
          projectHints: [],
          nodeHints: [],
          capabilityHints: [],
          requiredCapabilities: [],
          preferredCapabilities: [],
          constraints: {},
          ambiguities: [],
          riskHints: [],
          confidence: 1,
        }
      );
      assert.equal(res.valid, true);
      assert.equal(res.code, "VALID");
    });

    test("未注册的随意路径或未知项目被拒绝", async () => {
      const res = await validator.validateCandidate(
        {
          nodeId: MAC_NODE_ID,
          projectId: "arbitrary-path-attack",
          projectName: "attack",
          projectSummary: "",
          technologies: [],
          capabilities: [],
          nodeOnline: true,
          projectStatus: "active",
          score: 0.9,
          confidence: 0.9,
          hardConstraintsSatisfied: true,
          unsatisfiedConstraints: [],
          evidences: [],
          requiredSkillsAvailable: true,
          requiredMCPAvailable: true,
        },
        {
          originalRequest: "test",
          goal: "test",
          operation: "inspect",
          projectHints: [],
          nodeHints: [],
          capabilityHints: [],
          requiredCapabilities: [],
          preferredCapabilities: [],
          constraints: {},
          ambiguities: [],
          riskHints: [],
          confidence: 1,
        }
      );
      assert.equal(res.valid, false);
      assert.equal(res.code, "PROJECT_NOT_FOUND");
    });
  });

  // ------------------------------------------------------------
  // 4. 端到端路由决策推导测试
  // ------------------------------------------------------------
  describe("4. End-to-End Semantic Task Routing Scenarios", () => {
    test("场景 A: 自然语言自动找到 Nash 源码项目并派发至 Mac", async () => {
      const plan = await router.planRoute("检查之前开发的 Nash MCP 模块");
      assert.equal(plan.decision.decisionType, "DISPATCH");
      assert.equal(plan.decision.selectedCandidate?.nodeId, MAC_NODE_ID);
      assert.equal(plan.decision.selectedCandidate?.projectId, "proj-nash-agent");
      assert.equal(plan.validation.valid, true);
    });

    test("场景 B: 腾讯云服务任务自动路由至 Tencent 节点", async () => {
      const plan = await router.planRoute("检查腾讯云上 Nash Cluster 协调器服务当前状态");
      assert.equal(plan.decision.decisionType, "DISPATCH");
      assert.equal(plan.decision.selectedCandidate?.nodeId, TENCENT_NODE_ID);
      assert.equal(plan.decision.selectedCandidate?.projectId, "proj-nash-cluster");
      assert.equal(plan.validation.valid, true);
    });

    test("场景 B2: 用户指定查询腾讯云 Node.js 版本时，准确绑定腾讯云节点，严禁漂移至 Mac", async () => {
      const plan = await router.planRoute("查询腾讯云 Node.js 版本");
      assert.equal(plan.decision.decisionType, "DISPATCH");
      assert.equal(plan.decision.selectedCandidate?.nodeId, TENCENT_NODE_ID);
      assert.equal(plan.validation.valid, true);
    });

    test("场景 C: WSL2 候选可识别，但未验证 CUDA 不能通过派发校验", async () => {
      const plan = await router.planRoute("在 WSL2 检查 Python 环境和 CUDA 状态");
      assert.equal(plan.decision.decisionType, "DISPATCH");
      assert.equal(plan.decision.selectedCandidate?.nodeId, WSL_NODE_ID);
      assert.equal(plan.decision.selectedCandidate?.projectId, "proj-system-probe");
      assert.equal(plan.validation.valid, false);
      assert.equal(plan.validation.code, "CAPABILITY_UNVERIFIED");
    });

    test("场景 D: 跨节点多能力复合需求识别 (MULTI_NODE_REQUIRED)", async () => {
      const plan = await router.planRoute("从 Bilibili 提取视频字幕，然后导入英语阅读器项目中");
      assert.equal(plan.decision.decisionType, "MULTI_NODE_REQUIRED");
      assert.ok(plan.decision.multiNodePlan);
      assert.equal(plan.decision.multiNodePlan.subTasks.length, 2);
      assert.equal(plan.decision.multiNodePlan.subTasks[0]!.nodeId, TENCENT_NODE_ID);
      assert.equal(plan.decision.multiNodePlan.subTasks[1]!.nodeId, MAC_NODE_ID);
    });

    test("场景 E: 两个候选极其接近时触发歧义澄清 (CLARIFICATION_REQUIRED)", async () => {
      // 构造两个极其相近的项目
      await store.upsertProjectCatalog([
        {
          nodeId: MAC_NODE_ID,
          projectId: "proj-app-demo-v1",
          name: "app-demo",
          summary: "通用移动端演示程序",
          description: "Mobile demo v1",
          technologies: ["React Native"],
          capabilities: ["Demo"],
          status: "active",
          visibility: "summary",
          registeredAt: Date.now(),
          updatedAt: Date.now(),
          lastIndexedAt: Date.now(),
          revision: 1,
          userAliases: [],
        },
        {
          nodeId: MAC_NODE_ID,
          projectId: "proj-app-demo-v2",
          name: "app-demo",
          summary: "通用移动端演示程序",
          description: "Mobile demo v2",
          technologies: ["React Native"],
          capabilities: ["Demo"],
          status: "active",
          visibility: "summary",
          registeredAt: Date.now(),
          updatedAt: Date.now(),
          lastIndexedAt: Date.now(),
          revision: 1,
          userAliases: [],
        },
      ]);

      const plan = await router.planRoute("修复 app-demo 中的启动问题");
      assert.equal(plan.decision.decisionType, "CLARIFICATION_REQUIRED");
      assert.ok(plan.decision.clarificationOptions);
      assert.equal(plan.decision.clarificationOptions.length >= 2, true);
    });

    test("场景 F: 多轮澄清交互继续推进 (clarifyAndRun)", async () => {
      // 预先插入两个歧义 demo 项目
      await store.upsertProjectCatalog([
        {
          nodeId: MAC_NODE_ID,
          projectId: "proj-app-demo-v1",
          name: "app-demo",
          summary: "通用移动端演示程序",
          description: "Mobile demo v1",
          technologies: ["React Native"],
          capabilities: ["Demo"],
          status: "active",
          visibility: "summary",
          registeredAt: Date.now(),
          updatedAt: Date.now(),
          lastIndexedAt: Date.now(),
          revision: 1,
          userAliases: [],
        },
        {
          nodeId: MAC_NODE_ID,
          projectId: "proj-app-demo-v2",
          name: "app-demo",
          summary: "通用移动端演示程序",
          description: "Mobile demo v2",
          technologies: ["React Native"],
          capabilities: ["Demo"],
          status: "active",
          visibility: "summary",
          registeredAt: Date.now(),
          updatedAt: Date.now(),
          lastIndexedAt: Date.now(),
          revision: 1,
          userAliases: [],
        },
      ]);

      // 启动一个歧义任务
      const plan = await router.planRoute("修复 app-demo 中的启动问题");
      assert.equal(plan.decision.decisionType, "CLARIFICATION_REQUIRED");

      // 用户回答选择第 1 项
      const resolved = await router.clarifyAndRun(plan.session.sessionId, "1");
      assert.equal(resolved.decision.decisionType, "DISPATCH");
      assert.equal(resolved.decision.selectedCandidate?.projectId, "proj-app-demo-v1");
      assert.ok(resolved.dispatchResult?.success);
    });

    test("场景 G: 节点离线时生成 DEFERRED 决策", async () => {
      // 模拟断开 WSL2 连接
      (registry as any).connections.delete(WSL_NODE_ID);
      await store.updateNodeStatus(WSL_NODE_ID, "offline");

      const plan = await router.planRoute("在 WSL2 检查 Python 环境");
      assert.equal(plan.decision.decisionType, "DEFERRED");
      assert.equal(plan.decision.selectedCandidate?.nodeId, WSL_NODE_ID);
    });
  });

  // ------------------------------------------------------------
  // 5. Routing Feedback Controller & Outcome Unknown 防护测试
  // ------------------------------------------------------------
  describe("5. Routing Feedback Controller & Replanning", () => {
    test("存在写副作用且节点断线时，坚决收敛为 Outcome Unknown，不自动重新派发", async () => {
      const task = await scheduler.createTask({
        nodeId: MAC_NODE_ID,
        projectId: "proj-nash-agent",
        goal: "修改文件并测试",
      });

      const evaluation = await feedbackController.evaluateIntervention(
        task,
        "NODE_OFFLINE",
        "Worker disconnected abruptly",
        {
          hasSideEffects: true, // 已执行写文件操作
        }
      );

      assert.equal(evaluation.shouldReplan, false);
      assert.equal(evaluation.outcomeUnknown, true);
      assert.match(evaluation.reason, /Outcome Unknown/);

      const replan = await feedbackController.recordAndReconcileReplan(
        task,
        "NODE_OFFLINE",
        "Worker disconnected abruptly",
        evaluation
      );
      assert.equal(replan.status, "outcome_unknown");

      // 验证任务状态更新为 outcome_unknown
      const updatedTask = await store.getTask(task.taskId);
      assert.equal(updatedTask?.status, "outcome_unknown");
    });

    test("达到 Replan 预算上限时，停止自动重试并请求用户确认", async () => {
      const task = await scheduler.createTask({
        nodeId: MAC_NODE_ID,
        projectId: "proj-nash-agent",
        goal: "只读分析",
      });

      // 第一次 Replan
      const eval1 = await feedbackController.evaluateIntervention(task, "EXECUTION_BLOCKED", "Blocked 1");
      await feedbackController.recordAndReconcileReplan(task, "EXECUTION_BLOCKED", "Blocked 1", eval1);

      // 第二次 Replan (在同一任务连续发生)
      const eval2 = await feedbackController.evaluateIntervention(task, "EXECUTION_BLOCKED", "Blocked 2");
      await feedbackController.recordAndReconcileReplan(task, "EXECUTION_BLOCKED", "Blocked 2", eval2);

      // 第三次超出 maxReplans (默认 2)
      const eval3 = await feedbackController.evaluateIntervention(task, "EXECUTION_BLOCKED", "Blocked 3");
      assert.equal(eval3.shouldReplan, false);
      assert.equal(eval3.requiresUserConfirmation, true);
      assert.match(eval3.reason, /最大重新规划预算/);
    });
  });

  // ------------------------------------------------------------
  // 6. Agent Tools 工具集成测试
  // ------------------------------------------------------------
  describe("6. Phase 3 Agent Tools Integration", () => {
    test("route_cluster_task 工具能够执行受控规划", async () => {
      const tool = new RouteClusterTaskTool(router);
      const res = await tool.execute({
        goal: "检查 Nash MCP 模块",
        dryRun: true,
      });

      assert.equal(res.decisionType, "DISPATCH");
      assert.equal(res.selectedTarget?.nodeId, MAC_NODE_ID);
      assert.equal(res.selectedTarget?.projectId, "proj-nash-agent");
    });

    test("dispatch_cluster_task 工具完成端到端任务派发", async () => {
      const tool = new DispatchClusterTaskTool(router);
      const res = await tool.execute({
        goal: "检查腾讯云上的 Nash 服务",
      });

      assert.equal(res.success, true);
      assert.equal(res.nodeId, TENCENT_NODE_ID);
      assert.equal(res.projectId, "proj-nash-cluster");
      assert.ok(res.taskId);
    });
  });

  // ------------------------------------------------------------
  // 7. REST API 端点集成测试
  // ------------------------------------------------------------
  describe("7. Coordinator REST API Integration", () => {
    let server: http.Server;
    let apiPort: number;

    beforeEach(async () => {
      const apiHandler = new ClusterApiHandler({
        store,
        registry,
        scheduler,
        inviteManager,
        coordinatorNodeId: COORD_ID,
        adminApiKey: "test-key",
        semanticRouter: router,
        feedbackController,
      });

      server = http.createServer((req, res) => apiHandler.handleRequest(req, res));
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as any;
          apiPort = addr.port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    });

    test("POST /api/cluster/route 返回结构化路由规划", async () => {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/cluster/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
        body: JSON.stringify({ goal: "检查 Nash MCP 模块" }),
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.decision.decisionType, "DISPATCH");
      assert.equal(data.decision.selectedCandidate.nodeId, MAC_NODE_ID);
      assert.equal(data.decision.selectedCandidate.projectId, "proj-nash-agent");
    });

    test("POST /api/cluster/run 执行自主派发并返回任务记录", async () => {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/cluster/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
        body: JSON.stringify({ goal: "在 WSL2 检查环境" }),
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.decision.decisionType, "DISPATCH");
      assert.equal(data.dispatchResult.success, true);
      assert.equal(data.dispatchResult.nodeId, WSL_NODE_ID);
      assert.ok(data.dispatchResult.taskId);
    });

    test("POST /api/cluster/routes/:id/clarify 能够提交澄清并完成派发", async () => {
      // 预先插入 demo 候选触发澄清
      await store.upsertProjectCatalog([
        {
          nodeId: MAC_NODE_ID,
          projectId: "proj-app-demo-v1",
          name: "app-demo",
          summary: "通用移动端演示程序",
          description: "Mobile demo v1",
          technologies: [],
          capabilities: [],
          status: "active",
          visibility: "summary",
          registeredAt: Date.now(),
          updatedAt: Date.now(),
          lastIndexedAt: Date.now(),
          revision: 1,
          userAliases: [],
        },
        {
          nodeId: MAC_NODE_ID,
          projectId: "proj-app-demo-v2",
          name: "app-demo",
          summary: "通用移动端演示程序",
          description: "Mobile demo v2",
          technologies: [],
          capabilities: [],
          status: "active",
          visibility: "summary",
          registeredAt: Date.now(),
          updatedAt: Date.now(),
          lastIndexedAt: Date.now(),
          revision: 1,
          userAliases: [],
        },
      ]);

      const routeRes = await fetch(`http://127.0.0.1:${apiPort}/api/cluster/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
        body: JSON.stringify({ goal: "修复 app-demo 启动问题" }),
      });
      const routeData = (await routeRes.json()) as any;
      assert.equal(routeData.decision.decisionType, "CLARIFICATION_REQUIRED");
      const sessionId = routeData.session.sessionId;

      // 澄清选择第 2 项
      const clarifyRes = await fetch(`http://127.0.0.1:${apiPort}/api/cluster/routes/${sessionId}/clarify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
        body: JSON.stringify({ clarification: "2" }),
      });
      assert.equal(clarifyRes.status, 200);
      const clarifyData = (await clarifyRes.json()) as any;
      assert.equal(clarifyData.decision.decisionType, "DISPATCH");
      assert.equal(clarifyData.decision.selectedCandidate.projectId, "proj-app-demo-v2");
      assert.equal(clarifyData.dispatchResult.success, true);
    });
  });
});
