import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  InMemoryClusterStore,
  NodeRegistry,
  InviteManager,
  CoordinatorCatalogService,
  ClusterSearchService,
  LocalCatalogProvider,
  ProjectRegistry,
  detectNodeHardwareCapabilities,
  SearchClusterProjectsTool,
  SearchClusterCapabilitiesTool,
  SearchClusterMemoryTool,
  SearchRemoteMemoryTool,
  GetClusterNodeTool,
  GetClusterProjectTool,
} from "../src/cluster/index.js";
import type {
  CatalogSyncSnapshotPayload,
  CatalogSyncDeltaPayload,
  RemoteMemorySearchResponsePayload,
} from "../src/cluster/protocol/types.js";

test("Phase 2: Cluster Catalog & Federated Memory Subsystem", async (t) => {
  const tmpDir = path.join(os.tmpdir(), `nash-test-catalog-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const dummyProjDir = path.join(tmpDir, "dummy-project");
  fs.mkdirSync(dummyProjDir, { recursive: true });
  fs.writeFileSync(
    path.join(dummyProjDir, "package.json"),
    JSON.stringify({
      name: "english-reader",
      description: "English reading system with audio player and synchronized subtitles",
      dependencies: {
        typescript: "^5.0.0",
        "sherpa-onnx-node": "^1.10.0",
      },
    })
  );

  const store = new InMemoryClusterStore();
  const inviteMgr = new InviteManager();
  const registry = new NodeRegistry(store, inviteMgr);
  const coordinatorService = new CoordinatorCatalogService(store, registry, "coord-1");
  const searchService = new ClusterSearchService(store, registry, coordinatorService);

  await t.test("1. Hardware Detector 严格遵循能力分级准则", async () => {
    const caps = detectNodeHardwareCapabilities();
    assert.ok(caps.length >= 3, "应至少探测 CPU, Memory 与 Runtime");

    const cpuCap = caps.find((c) => c.category === "cpu");
    assert.ok(cpuCap);
    assert.equal(cpuCap.status, "available");

    const runtimeCap = caps.find((c) => c.category === "runtime");
    assert.ok(runtimeCap);
    assert.equal(runtimeCap.status, "verified");

    const gpuCap = caps.find((c) => c.category === "gpu");
    if (gpuCap && gpuCap.name === "NVIDIA GPU") {
      assert.equal(gpuCap.status, "detected", "GPU物理探测必须标记为 detected，绝不盲目宣称可用");
    }
  });

  await t.test("2. LocalCatalogProvider 自动识别项目技术与能力", async () => {
    const projRegistry = new ProjectRegistry({ customDir: tmpDir });
    projRegistry.registerProject(dummyProjDir, "english-reader");

    const provider = new LocalCatalogProvider({
      nodeId: "node-mac",
      projectRegistry: projRegistry,
      nashHome: tmpDir,
    });

    const snapshot = await provider.getSnapshot();
    assert.equal(snapshot.nodeId, "node-mac");
    assert.equal(snapshot.projects.length, 1);

    const proj = snapshot.projects[0];
    assert.equal(proj.name, "english-reader");
    assert.ok(proj.technologies.includes("Node.js"));
    assert.ok(proj.technologies.includes("TypeScript"));
    assert.ok(proj.capabilities.includes("Realtime Subtitles"));
    assert.match(proj.summary, /English reading system/);
  });

  await t.test("3. Coordinator 接收 Snapshot 并持久化至 Catalog Store", async () => {
    // 注册节点到 store
    await store.saveNode({
      nodeId: "node-mac",
      name: "Mac-Worker",
      role: "worker",
      platform: "darwin",
      arch: "arm64",
      hostname: "mac.local",
      tokenHash: "hash123",
      status: "online",
      lastSeenAt: Date.now(),
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const snapshot: CatalogSyncSnapshotPayload = {
      nodeId: "node-mac",
      catalogRevision: 1,
      hardwareCapabilities: [
        {
          name: "Apple Silicon Metal GPU",
          category: "gpu",
          status: "available",
          details: "M3 Max with unified memory",
          detectionMethod: "os.arch",
          detectedAt: Date.now(),
        },
      ],
      projects: [
        {
          projectId: "proj-english-reader",
          nodeId: "node-mac",
          name: "english-reader",
          summary: "英语学习阅读系统，支持逐句音频播放与实时字幕高亮",
          description: "基于 TypeScript / Vue 构建的离线音频文章学习平台",
          technologies: ["TypeScript", "Vue", "Electron"],
          capabilities: ["Audio Playback", "Subtitle Highlighting", "Speech Recognition"],
          status: "active",
          visibility: "summary",
          registeredAt: Date.now(),
          updatedAt: Date.now(),
          lastIndexedAt: Date.now(),
          revision: 1,
          userAliases: ["英语阅读器", "EnglishReader"],
        },
      ],
      skills: [
        {
          skillId: "skill-code-review",
          nodeId: "node-mac",
          name: "code-review",
          description: "Perform comprehensive code review and verify defects",
          scope: "global",
          tags: ["review", "qa"],
          fingerprint: "fp123",
          available: true,
          updatedAt: Date.now(),
        },
      ],
      mcp: [
        {
          serverId: "bilibili-subtitles",
          nodeId: "node-mac",
          displayName: "bilibili-subtitles",
          transportType: "streamable-http",
          status: "available",
          capabilitySummary: "Bilibili Subtitle extraction tool",
          tools: [
            {
              toolName: "extract_bilibili_subtitles",
              description: "Extract subtitle transcripts from BV URLs",
              parameterNames: ["url", "format"],
              riskClassification: "read-only",
              available: true,
            },
          ],
          resourceCount: 0,
          promptCount: 0,
          lastVerifiedAt: Date.now(),
          revision: 1,
        },
      ],
      memoryIndex: [
        {
          entryId: "fed-english-reader-audio",
          nodeId: "node-mac",
          projectId: "proj-english-reader",
          topic: "english-reader · Audio & Subtitles",
          summary: "逐句字幕同步高亮与音频播放调度架构",
          keywords: ["english-reader", "audio", "subtitle", "字幕", "音频", "高亮"],
          sourceReference: "mem-audio-syncer",
          confidence: 0.95,
          visibility: "retrievable",
          revision: 1,
          updatedAt: Date.now(),
        },
      ],
    };

    const ack = await coordinatorService.handleSnapshot(snapshot);
    assert.equal(ack.status, "ok");
    assert.equal(ack.catalogRevision, 1);

    const storedProjects = await store.listProjectsCatalog();
    assert.equal(storedProjects.length, 1);
    assert.equal(storedProjects[0].name, "english-reader");

    const storedMem = await store.listMemoryIndex();
    assert.equal(storedMem.length, 1);
    assert.equal(storedMem[0].topic, "english-reader · Audio & Subtitles");
  });

  await t.test("4. 自然语言与多维度联合检索 (Cross-Resource Discovery)", async () => {
    // 搜索：逐句字幕高亮
    const searchRes = await searchService.searchAll("逐句字幕高亮");
    assert.ok(searchRes.totalMatches >= 1, "应该命中相关资源");

    assert.ok(searchRes.projects.length >= 1, "应该匹配到 english-reader 项目");
    const matchedProj = searchRes.projects[0];
    assert.equal(matchedProj.name, "english-reader");
    assert.ok(matchedProj.score > 0);
    assert.ok(matchedProj.matchReasons.length > 0);

    assert.ok(searchRes.memoryIndex.length >= 1, "应该命中相关联邦记忆索引");
    assert.equal(searchRes.memoryIndex[0].projectId, "proj-english-reader");

    // 搜索：bilibili 字幕
    const mcpSearch = await searchService.searchMCPCapabilities("bilibili 字幕");
    assert.ok(mcpSearch.length >= 1, "应该命中 bilibili-subtitles MCP");
    assert.equal(mcpSearch[0].serverId, "bilibili-subtitles");
  });

  await t.test("5. 离线节点处理与降级 (Offline Node Badge & Safe Fallback)", async () => {
    // node-mac 在 NodeRegistry 中未建立活跃 WebSocket 连接，视为 offline
    const projResults = await searchService.searchProjects("english-reader");
    assert.equal(projResults.length, 1);
    assert.equal(projResults[0].nodeOnline, false, "离线节点必须明确标记 nodeOnline: false");

    // 发起远程记忆检索时，若节点离线，必须安全降级，绝不发起死锁挂起的 RPC
    const remoteRes = await coordinatorService.searchRemoteMemory("node-mac", "proj-english-reader", "音频调度");
    assert.equal(remoteRes.retrievalStatus, "error");
    assert.match(remoteRes.error ?? "", /offline/i);
  });

  await t.test("6. 增量更新与墓碑删除 (Incremental Sync & Tombstone)", async () => {
    const delta: CatalogSyncDeltaPayload = {
      nodeId: "node-mac",
      catalogRevision: 2,
      projectsUpsert: [
        {
          projectId: "proj-agent-core",
          nodeId: "node-mac",
          name: "agent-core",
          summary: "Core harness runtime",
          description: "Nash agent runtime",
          technologies: ["TypeScript"],
          capabilities: ["AgentLoop"],
          status: "active",
          visibility: "summary",
          registeredAt: Date.now(),
          updatedAt: Date.now(),
          lastIndexedAt: Date.now(),
          revision: 2,
        },
      ],
      projectsDelete: [
        {
          resourceType: "project",
          resourceId: "proj-english-reader",
          deletedAt: Date.now(),
          revision: 2,
        },
      ],
    };

    const deltaAck = await coordinatorService.handleDelta(delta);
    assert.equal(deltaAck.status, "ok");

    const currentProjects = await store.listProjectsCatalog({ nodeId: "node-mac" });
    assert.equal(currentProjects.length, 1);
    assert.equal(currentProjects[0].projectId, "proj-agent-core");

    const tombstones = await store.getTombstones("node-mac");
    assert.equal(tombstones.length, 1);
    assert.equal(tombstones[0].resourceId, "proj-english-reader");
  });

  await t.test("7. Phase 3 Agent Tools 端到端执行验证", async () => {
    const projTool = new SearchClusterProjectsTool(searchService);
    const projRes = await projTool.execute({ query: "agent" });
    assert.equal(projRes.totalFound, 1);
    assert.equal(projRes.projects[0].name, "agent-core");

    const capTool = new SearchClusterCapabilitiesTool(searchService);
    const capRes = await capTool.execute({ query: "review", type: "skills" });
    assert.ok(capRes.skills);
    assert.equal(capRes.skills.length, 1);

    const memTool = new SearchClusterMemoryTool(searchService);
    const memRes = await memTool.execute({ query: "Audio", deep: false });
    assert.ok(memRes.candidates);
  });

  // 清理临时测试目录
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
