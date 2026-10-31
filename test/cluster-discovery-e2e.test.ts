import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import { ClusterSearchService } from "../src/cluster/coordinator/catalog/cluster-search-service.js";
import { CoordinatorCatalogService } from "../src/cluster/coordinator/catalog/coordinator-catalog-service.js";
import { AutonomousDiscoveryService } from "../src/cluster/discovery/autonomous-discovery-service.js";
import { DiscoveryResultValidator } from "../src/cluster/discovery/discovery-validator.js";
import { CoordinatorMainAgent } from "../src/cluster/coordinator/main-agent/coordinator-main-agent.js";
import { SemanticTaskRouter } from "../src/cluster/router/semantic-task-router.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";

describe("E2E Autonomous Discovery & Coordinator Multi-Turn Workflow", () => {
  let store: InMemoryClusterStore;
  let registry: NodeRegistry;
  let scheduler: TaskScheduler;
  let catalogService: CoordinatorCatalogService;
  let searchService: ClusterSearchService;
  let discoveryService: AutonomousDiscoveryService;
  let validator: DiscoveryResultValidator;
  let router: SemanticTaskRouter;

  beforeEach(async () => {
    store = new InMemoryClusterStore();
    registry = new NodeRegistry(store, new InviteManager());
    scheduler = new TaskScheduler(store, registry, "coordinator");

    // 1. 初始化两台真实物理节点模拟记录
    await store.saveNode({
      nodeId: "node-example-mac",
      name: "example-mac.local",
      role: "worker",
      platform: "darwin",
      arch: "arm64",
      hostname: "example-mac.local",
      tokenHash: "hash-mac",
      status: "online",
      lastSeenAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        projects: [
          { projectId: "proj-nash-agent", name: "nash-agent" },
          { projectId: "proj-srt-project", name: "srt-project" },
        ],
      } as any,
    });

    await store.saveNode({
      nodeId: "node-example-cloud",
      name: "Cloud-Worker",
      role: "worker",
      platform: "linux",
      arch: "x64",
      hostname: "tencent-server",
      tokenHash: "hash-tencent",
      status: "online",
      lastSeenAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        projects: [{ projectId: "proj-nash-cluster", name: "nash-cluster" }],
      } as any,
    });

    // 2. 模拟 Mac 节点上已注册的 MCP 服务（bilibili-subtitles）
    await store.upsertMCPCatalog([
      {
        serverId: "bilibili-subtitles",
        nodeId: "node-example-mac",
        displayName: "bilibili-subtitles",
        transportType: "streamable-http",
        status: "connected",
        capabilitySummary: "bilibili-subtitles: 2 tools (extract_bilibili_subtitles, list_bilibili_subtitles)",
        tools: [
          {
            toolName: "extract_bilibili_subtitles",
            description: "提取 Bilibili 视频字幕文档",
            parameterNames: ["url"],
            riskClassification: "read-only",
            available: true,
          },
          {
            toolName: "list_bilibili_subtitles",
            description: "查询 Bilibili 视频分P与字幕列表",
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
    ]);

    // 3. 模拟初始 Catalog 中尚无 bilibili 关键词的项目
    await store.upsertProjectCatalog([
      {
        projectId: "proj-nash-agent",
        nodeId: "node-example-mac",
        name: "nash-agent",
        summary: "Enterprise-grade TypeScript AI Agent Harness",
        description: "Harness with sandbox",
        technologies: ["TypeScript", "Node.js"],
        capabilities: ["sandbox", "agent-loop"],
        status: "active",
        registeredAt: Date.now(),
        updatedAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision: 1,
        visibility: "discoverable",
      },
      {
        projectId: "proj-srt-project",
        nodeId: "node-example-mac",
        name: "srt-project",
        summary: "专业英语文献阅读器与高精度逐句音频播放器",
        description: "Windows desktop subtitle and audio player",
        technologies: ["Electron", "Vue3", "TypeScript"],
        capabilities: ["audio-player", "realtime-subtitles"],
        status: "active",
        registeredAt: Date.now(),
        updatedAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision: 1,
        visibility: "discoverable",
      },
    ]);

    catalogService = new CoordinatorCatalogService(store, registry, "coordinator");
    searchService = new ClusterSearchService(store, registry, catalogService);
    validator = new DiscoveryResultValidator(store, registry);
    discoveryService = new AutonomousDiscoveryService({
      store,
      registry,
      scheduler,
      validator,
      defaultTimeoutMs: 15000,
    });
    router = new SemanticTaskRouter({
      store,
      registry,
      scheduler,
      searchService,
      catalogService,
    });
  });

  it("E2E-1: 初始检索无匹配时，通过自主探查发现并回写 Catalog，后续检索立即命中", async () => {
    // 1. 验证初始状态搜索 'bilibili' 项目为 0
    const initialProjects = await searchService.searchProjects("bilibili");
    assert.strictEqual(initialProjects.length, 0, "初始 Catalog 项目列表不应包含 bilibili 关键字");

    // 但 MCP 服务检索应能命中
    const initialMcp = await searchService.searchMCPCapabilities("bilibili");
    assert.strictEqual(initialMcp.length, 1, "MCP Catalog 应检索到 bilibili-subtitles");
    assert.strictEqual(initialMcp[0]!.serverId, "bilibili-subtitles");

    // 2. 模拟 Scout 探查回传了 srt-project 与 bilibili 关联的物理证据
    const scoutReport = {
      discoveryId: "disc-e2e-1",
      nodeId: "node-example-mac",
      query: "bilibili 项目",
      timestamp: Date.now(),
      candidates: [
        {
          candidateId: "cand-srt-1",
          nodeId: "node-example-mac",
          candidateProjectId: "proj-srt-project",
          projectName: "srt-project",
          projectSummary: "Windows 桌面端实时字幕提取与英语音频播放应用，支持 B站 字幕导入",
          isRegistered: true,
          verificationStatus: "verified" as const,
          confidence: 0.92,
          evidences: [
            {
              evidenceType: "package_json" as const,
              sourcePath: "/Users/test/Documents/project/srt-project/package.json",
              matchedContent: '{"name": "srt-project", "keywords": ["realtime-subtitles", "streaming-asr"]}',
              confidence: 0.9,
            },
            {
              evidenceType: "mcp_tool" as const,
              matchedContent: "extract_bilibili_subtitles tool available on node-mac",
              confidence: 0.95,
            },
          ],
          relevantCapabilities: [
            {
              capabilityType: "mcp" as const,
              name: "bilibili-subtitles",
              description: "提取 Bilibili 视频字幕文档",
              tools: ["extract_bilibili_subtitles", "list_bilibili_subtitles"],
              status: "verified_live",
            },
          ],
          relevantMemorySnippets: ["支持结合 Bilibili 字幕工具进行逐句高亮与音频对齐"],
        },
      ],
      investigatedPaths: ["/Users/test/Documents/project/srt-project"],
      investigatedMcpServers: ["bilibili-subtitles"],
      summary: "在 Mac 节点定位到 srt-project 实时字幕应用并核验了 bilibili-subtitles MCP 服务",
      durationMs: 210,
    };

    // 3. 经 Validator 审查
    const valResult = await validator.validateReport(scoutReport);
    assert.strictEqual(valResult.valid, true);
    assert.strictEqual(valResult.validatedCandidates[0]!.verificationStatus, "verified");

    // 4. 回写 Catalog 与联邦记忆 (反馈闭环)
    const cand = valResult.validatedCandidates[0]!;
    await store.upsertProjectCatalog([
      {
        projectId: cand.candidateProjectId!,
        nodeId: cand.nodeId,
        name: cand.projectName,
        summary: cand.projectSummary,
        description: cand.projectSummary,
        technologies: ["Vue3", "Electron", "TypeScript"],
        capabilities: ["realtime-subtitles", "bilibili-subtitles"],
        status: "active",
        registeredAt: Date.now(),
        updatedAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision: 2,
        visibility: "discoverable",
        userAliases: ["srt-project", "字幕应用", "bilibili字幕项目"],
      },
    ]);

    // 5. 验证回写后再次搜索 'bilibili' 项目成功命中
    const postSearch = await searchService.searchProjects("bilibili");
    assert.ok(postSearch.length > 0, "回写后搜索 'bilibili' 必须成功返回项目候选");
    assert.strictEqual(postSearch[0]!.projectId, "proj-srt-project");
    assert.strictEqual(postSearch[0]!.nodeId, "node-example-mac");
  });

  it("E2E-2: 人机澄清工具能够暂存多个候选并在用户回答后推进原任务", async () => {
    // 构造澄清问题与选项
    const clarificationQuestion = "在 Mac 节点上发现了两个与您的需求相关的资源：\n1. srt-project 实时字幕阅读器；\n2. bilibili-subtitles MCP 字幕提取能力。\n请问您希望分析哪一个？";
    const options = [
      { id: "1", label: "srt-project 实时字幕项目", nodeId: "node-example-mac", projectId: "proj-srt-project" },
      { id: "2", label: "bilibili-subtitles MCP 提取服务", nodeId: "node-example-mac" },
    ];

    // 保存到会话记录
    const convId = "conv-e2e-clarify";
    if (store.saveConversation) {
      await store.saveConversation({
        id: convId,
        title: "分析bilibili项目",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          {
            id: "msg-1",
            conversationId: convId,
            sender: "user",
            content: "分析一下bilibili的项目",
            messageType: "text",
            timestamp: Date.now(),
          },
          {
            id: "msg-2",
            conversationId: convId,
            sender: "assistant",
            content: clarificationQuestion,
            messageType: "clarification",
            metadata: {
              pendingClarification: {
                question: clarificationQuestion,
                options,
              },
            },
            timestamp: Date.now(),
          },
        ],
      });
    }

    // 验证会话可恢复
    const loadedConv = await store.getConversation!(convId);
    assert.ok(loadedConv);
    assert.strictEqual(loadedConv.messages.length, 2);
    assert.strictEqual(loadedConv.messages[1]!.messageType, "clarification");
    const opts = (loadedConv.messages[1]!.metadata as any).pendingClarification.options;
    assert.strictEqual(opts[0].projectId, "proj-srt-project");

    // 模拟用户回复：“我选第一个”
    const userSelection = "我选第一个 srt-project";
    loadedConv.messages.push({
      id: "msg-3",
      conversationId: convId,
      sender: "user",
      content: userSelection,
      messageType: "text",
      timestamp: Date.now(),
    });

    // 确定性安全下发任务
    const target = opts[0];
    const taskRecord = {
      taskId: "task-clarified-1",
      nodeId: target.nodeId,
      projectId: target.projectId,
      goal: "分析 srt-project 实时字幕项目的整体架构与潜在问题",
      status: "queued" as const,
      dispatchAttempt: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.saveTask(taskRecord);

    loadedConv.linkedTaskIds = [taskRecord.taskId];
    loadedConv.messages.push({
      id: "msg-4",
      conversationId: convId,
      sender: "assistant",
      content: `已确认目标：已在节点 [${target.nodeId}] 派发针对项目 [${target.projectId}] 的代码分析任务。`,
      messageType: "text",
      metadata: { taskId: taskRecord.taskId },
      timestamp: Date.now(),
    });

    await store.saveConversation!(loadedConv);

    const finalConv = await store.getConversation!(convId);
    assert.strictEqual(finalConv?.linkedTaskIds?.[0], "task-clarified-1");
    assert.strictEqual(finalConv?.messages[3]!.messageType, "text");
    assert.match(finalConv?.messages[3]!.content!, /已在节点/);
  });
});
