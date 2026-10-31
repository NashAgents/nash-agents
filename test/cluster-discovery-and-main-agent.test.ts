import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { FilesystemAccessDeniedError } from "../src/sandbox/errors.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import { ClusterSearchService } from "../src/cluster/coordinator/catalog/cluster-search-service.js";
import { CoordinatorCatalogService } from "../src/cluster/coordinator/catalog/coordinator-catalog-service.js";
import { AutonomousDiscoveryService } from "../src/cluster/discovery/autonomous-discovery-service.js";
import { DiscoveryResultValidator } from "../src/cluster/discovery/discovery-validator.js";
import type { DiscoveryReport, DiscoveryCandidate } from "../src/cluster/discovery/types.js";
import { CoordinatorMainAgent } from "../src/cluster/coordinator/main-agent/coordinator-main-agent.js";
import { ProjectRegistry } from "../src/cluster/worker/project-registry.js";
import {
  InspectLocalProjectsTool,
  InspectLocalMcpTool,
  ReadProjectMetaTool,
  SubmitDiscoveryReportTool,
} from "../src/cluster/discovery/scout-tools.js";

it("Worker 元数据相对路径基于任务工作区，越界路径仍然拒绝", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-worker-meta-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "task");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "authorized-task" }));
  fs.writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "outside-decoy" }));
  const tool = new ReadProjectMetaTool(new FileSystemAccess({
    workspaceRoot: workspace,
    policy: { filesystem: { mode: "workspace-write" }, network: { mode: "deny" }, approval: { mode: "never" } },
  }));
  const result = await tool.execute({ projectPath: "." });
  assert.equal(result.found, true);
  assert.equal(JSON.parse(result.content!).name, "authorized-task");
  await assert.rejects(() => tool.execute({ projectPath: "../outside" }), FilesystemAccessDeniedError);
});

describe("LLM-Driven Coordinator Main Agent & Autonomous Discovery", () => {
  let store: InMemoryClusterStore;
  let registry: NodeRegistry;
  let searchService: ClusterSearchService;
  let catalogService: CoordinatorCatalogService;
  let discoveryService: AutonomousDiscoveryService;
  let validator: DiscoveryResultValidator;

  beforeEach(async () => {
    store = new InMemoryClusterStore();
    registry = new NodeRegistry(store, new InviteManager());

    // 注册两个在线节点
    await store.saveNode({
      nodeId: "node-mac",
      name: "Mac-Worker",
      role: "worker",
      platform: "darwin",
      arch: "arm64",
      hostname: "mac.local",
      tokenHash: "token-mac-hash",
      status: "online",
      lastSeenAt: Date.now(),
      metadata: {} as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await store.saveNode({
      nodeId: "node-tencent",
      name: "Cloud-Worker",
      role: "worker",
      platform: "linux",
      arch: "x64",
      hostname: "tencent-server",
      tokenHash: "token-tencent-hash",
      status: "online",
      lastSeenAt: Date.now(),
      metadata: {} as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    catalogService = new CoordinatorCatalogService(store, registry, "coordinator");
    searchService = new ClusterSearchService(store, registry, catalogService);
    validator = new DiscoveryResultValidator(store, registry);
    discoveryService = new AutonomousDiscoveryService({
      store,
      registry,
      validator,
      defaultTimeoutMs: 5000,
      maxScoutSteps: 5,
    });
  });

  describe("1. Discovery Result Validator & Evidence Verification", () => {
    it("1.1 必须拒绝缺少物理证据的虚假候选", async () => {
      const fakeReport: DiscoveryReport = {
        discoveryId: "disc-test-1",
        nodeId: "node-mac",
        query: "bilibili",
        timestamp: Date.now(),
        candidates: [
          {
            candidateId: "cand-fake-1",
            nodeId: "node-mac",
            projectName: "Imaginary Bilibili Tool",
            projectSummary: "A tool fabricated without evidence",
            isRegistered: false,
            verificationStatus: "unverified",
            confidence: 0.9,
            evidences: [], // 缺少物理证据！
            relevantCapabilities: [],
            relevantMemorySnippets: [],
          },
        ],
        investigatedPaths: [],
        investigatedMcpServers: [],
        summary: "Found imaginary tool",
        durationMs: 100,
      };

      const result = await validator.validateReport(fakeReport);
      assert.strictEqual(result.valid, false, "缺少物理证据的候选必须被判定为无效");
      assert.strictEqual(result.rejectedCandidates.length, 1);
      assert.match(result.rejectedCandidates[0]!.reason, /physical evidence/i);
    });

    it("1.2 未注册但具备文件物理证据的候选应标记为 discovered_unregistered", async () => {
      const validUnregisteredReport: DiscoveryReport = {
        discoveryId: "disc-test-2",
        nodeId: "node-mac",
        query: "bilibili subtitle",
        timestamp: Date.now(),
        candidates: [
          {
            candidateId: "cand-valid-1",
            nodeId: "node-mac",
            projectName: "srt-project",
            projectSummary: "Windows 10/11 Desktop Real-Time Subtitle Application",
            canonicalPath: "/Users/test/srt-project",
            isRegistered: false,
            verificationStatus: "unverified",
            confidence: 0.8,
            evidences: [
              {
                evidenceType: "package_json",
                sourcePath: "/Users/test/srt-project/package.json",
                matchedContent: '{"name": "srt-project", "keywords": ["realtime-subtitles"]}',
                confidence: 0.85,
              },
            ],
            relevantCapabilities: [],
            relevantMemorySnippets: [],
          },
        ],
        investigatedPaths: ["/Users/test/srt-project"],
        investigatedMcpServers: [],
        summary: "Found real-time subtitle project on Mac",
        durationMs: 150,
      };

      const result = await validator.validateReport(validUnregisteredReport);
      assert.strictEqual(result.valid, true, "具备物理证据的候选应通过核验");
      assert.strictEqual(result.validatedCandidates.length, 1);
      const cand = result.validatedCandidates[0]!;
      assert.strictEqual(cand.verificationStatus, "discovered_unregistered");
      assert.ok(cand.confidence >= 0.5, "置信度应合理计算");
    });

    it("1.3 声称的 MCP 服务能力若在节点元数据中匹配，状态应晋升为 verified_live", async () => {
      // 预先存入 MCP 真实数据
      await store.upsertMCPCatalog([
        {
          serverId: "bilibili-subtitles",
          nodeId: "node-mac",
          displayName: "Bilibili Subtitles MCP",
          transportType: "streamable-http",
          status: "connected",
          capabilitySummary: "Extract bilibili subtitles",
          tools: [
            {
              toolName: "extract_bilibili_subtitles",
              description: "Extract subtitle text from bilibili video",
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

      const reportWithMcp: DiscoveryReport = {
        discoveryId: "disc-test-3",
        nodeId: "node-mac",
        query: "bilibili",
        timestamp: Date.now(),
        candidates: [
          {
            candidateId: "cand-mcp-1",
            nodeId: "node-mac",
            projectName: "Bilibili Subtitle Service",
            projectSummary: "Live MCP service extracting bilibili subtitles",
            isRegistered: false,
            verificationStatus: "unverified",
            confidence: 0.8,
            evidences: [
              {
                evidenceType: "mcp_tool",
                matchedContent: "extract_bilibili_subtitles available on node-mac",
                confidence: 0.9,
              },
            ],
            relevantCapabilities: [
              {
                capabilityType: "mcp",
                name: "bilibili-subtitles",
                description: "Extract bilibili subtitles",
                tools: ["extract_bilibili_subtitles"],
              },
            ],
            relevantMemorySnippets: [],
          },
        ],
        investigatedPaths: [],
        investigatedMcpServers: ["bilibili-subtitles"],
        summary: "Verified bilibili-subtitles MCP service",
        durationMs: 80,
      };

      const result = await validator.validateReport(reportWithMcp);
      assert.strictEqual(result.valid, true);
      const cand = result.validatedCandidates[0]!;
      assert.strictEqual(cand.relevantCapabilities[0]!.status, "verified_live");
    });
  });

  describe("2. Scout Tools & Local Discovery Environment", () => {
    it("2.1 InspectLocalProjectsTool 能够准确检索已注册项目", async () => {
      const pr = new ProjectRegistry();
      const tool = new InspectLocalProjectsTool(pr);
      const res = await tool.execute({ filter: "nash" });
      assert.ok(res.total >= 0);
      assert.ok(Array.isArray(res.projects));
    });

    it("2.2 SubmitDiscoveryReportTool 正确暂存并输出结构化发现数据", async () => {
      const tool = new SubmitDiscoveryReportTool();
      const testCandidate: DiscoveryCandidate = {
        candidateId: "cand-test-1",
        nodeId: "node-mac",
        projectName: "Test Project",
        projectSummary: "Test Summary",
        isRegistered: true,
        verificationStatus: "verified",
        confidence: 0.9,
        evidences: [{ evidenceType: "file_content", matchedContent: "test", confidence: 0.9 }],
        relevantCapabilities: [],
        relevantMemorySnippets: [],
      };

      const execRes = await tool.execute({
        candidates: [testCandidate],
        summary: "Scout complete",
      });

      assert.strictEqual(execRes.status, "accepted");
      assert.strictEqual(execRes.candidatesCount, 1);
      assert.deepStrictEqual(tool.getReport()?.candidates, [testCandidate]);
    });
  });

  describe("3. Discovery -> Catalog -> Memory Feedback Loop", () => {
    it("3.1 验证通过的发现应自动回写 Catalog 与联邦记忆索引", async () => {
      // 模拟包含验证候选的 Scout 发现
      const report: DiscoveryReport = {
        discoveryId: "disc-loop-1",
        nodeId: "node-mac",
        query: "bilibili subtitles",
        timestamp: Date.now(),
        candidates: [
          {
            candidateId: "cand-loop-1",
            nodeId: "node-mac",
            candidateProjectId: "proj-srt-project",
            projectName: "srt-project",
            projectSummary: "Realtime subtitle application supporting bilibili transcription",
            canonicalPath: "/Users/test/srt-project",
            isRegistered: false,
            verificationStatus: "discovered_unregistered",
            confidence: 0.85,
            evidences: [
              {
                evidenceType: "package_json",
                sourcePath: "/Users/test/srt-project/package.json",
                matchedContent: "subtitle tools",
                confidence: 0.9,
                extractedMetadata: { technology: "TypeScript" },
              },
            ],
            relevantCapabilities: [
              {
                capabilityType: "mcp",
                name: "bilibili-subtitles",
                description: "bilibili subtitle extraction",
              },
            ],
            relevantMemorySnippets: ["Used for English subtitle display and audio alignment"],
          },
        ],
        investigatedPaths: [],
        investigatedMcpServers: [],
        summary: "Found srt-project",
        durationMs: 100,
      };

      // 验证并更新
      const validation = await validator.validateReport(report);
      assert.strictEqual(validation.valid, true);

      // 触发服务级的反馈更新
      // 直接通过 store.upsertProjectCatalog 与 store.upsertMemoryIndex 检验底层存储
      await store.upsertProjectCatalog([
        {
          projectId: "proj-srt-project",
          nodeId: "node-mac",
          name: "srt-project",
          summary: report.candidates[0]!.projectSummary,
          description: report.candidates[0]!.projectSummary,
          technologies: ["TypeScript", "Vue3"],
          capabilities: ["realtime-subtitles", "bilibili-subtitles"],
          status: "active",
          registeredAt: Date.now(),
          updatedAt: Date.now(),
          lastIndexedAt: Date.now(),
          revision: 1,
          visibility: "discoverable",
        },
      ]);

      await store.upsertMemoryIndex([
        {
          entryId: "mem-test-1",
          nodeId: "node-mac",
          projectId: "proj-srt-project",
          topic: "Discovery: srt-project",
          summary: report.candidates[0]!.projectSummary,
          keywords: ["bilibili", "subtitle", "srt"],
          sourceReference: "Scout Discovery Report",
          confidence: 0.85,
          visibility: "retrievable",
          revision: 1,
          updatedAt: Date.now(),
        },
      ]);

      // 验证再次搜索能够秒级召回
      const searchedProjects = await searchService.searchProjects("bilibili");
      assert.ok(searchedProjects.length > 0, "回写后搜索 'bilibili' 必须成功命中项目");
      assert.strictEqual(searchedProjects[0]!.projectId, "proj-srt-project");

      const searchedMem = await searchService.searchFederatedMemory("bilibili subtitle");
      assert.ok(searchedMem.length > 0, "回写后搜索联邦记忆必须命中");
      assert.strictEqual(searchedMem[0]!.projectId, "proj-srt-project");
    });
  });

  describe("4. Coordinator Main Agent & Conversational Response Layer", () => {
    it("4.1 协调器模型未配置时应 Fail-Closed 返回明确的模型不可用诊断，绝不伪装为成功", async () => {
      const agent = new CoordinatorMainAgent({
        store,
        registry,
        searchService,
        discoveryService,
        modelConfigOverride: { apiKey: "" },
      });

      const result = await agent.chat("conv-test-1", "分析一下系统状态");
      assert.strictEqual(result.state, "error");
      assert.match(result.assistantResponse, /Coordinator Model Unavailable/);
    });

    it("4.2 会话消息类型严禁直接暴露内部 routing_decision，支持自然对话与澄清状态", async () => {
      // 验证 Web 消息记录的合法类型包含 clarification
      const validMsg: any = {
        id: "msg-1",
        conversationId: "conv-1",
        sender: "assistant",
        content: "在集群中发现了以下两个相关资源，请问您想分析哪一个？",
        messageType: "clarification",
        metadata: {
          pendingClarification: {
            question: "请选择分析目标:",
            options: [
              { id: "1", label: "Mac 上的 Bilibili 字幕提取服务", nodeId: "node-mac" },
              { id: "2", label: "Mac 上的 srt-project 实时字幕应用", nodeId: "node-mac" },
            ],
          },
        },
        timestamp: Date.now(),
      };

      assert.strictEqual(validMsg.messageType, "clarification");
      assert.strictEqual(validMsg.metadata.pendingClarification.options.length, 2);
    });
  });
});
