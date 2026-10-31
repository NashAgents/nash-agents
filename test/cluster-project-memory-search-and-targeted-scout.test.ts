import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import {
  ClusterSearchService,
  normalizeProjectName,
} from "../src/cluster/coordinator/catalog/cluster-search-service.js";
import { CoordinatorCatalogService } from "../src/cluster/coordinator/catalog/coordinator-catalog-service.js";
import { AutonomousDiscoveryService } from "../src/cluster/discovery/autonomous-discovery-service.js";
import { DiscoveryResultValidator } from "../src/cluster/discovery/discovery-validator.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";
import { RoutingCandidateCollector } from "../src/cluster/router/candidate-collector.js";
import { RoutingDecisionEngine } from "../src/cluster/router/decision-engine.js";
import { RoutingCandidateRanker } from "../src/cluster/router/candidate-ranker.js";
import { RoutingValidator } from "../src/cluster/router/routing-validator.js";
import type { TaskIntent } from "../src/cluster/router/types.js";

test("Cluster Project Name Normalization, Federated Memory & Targeted Scout", async (t) => {
  await t.test("1. normalizeProjectName 与多种命名变体均能精确召回同一项目", async () => {
    assert.equal(normalizeProjectName("MetroWise_V2"), "metrowisev2");
    assert.equal(normalizeProjectName("MetroWiseV2"), "metrowisev2");
    assert.equal(normalizeProjectName("metro-wise-v2"), "metrowisev2");
    assert.equal(normalizeProjectName("metro wise v2"), "metrowisev2");
    assert.equal(normalizeProjectName("MetroWise V2"), "metrowisev2");

    const store = new InMemoryClusterStore();
    const registry = new NodeRegistry(store, new InviteManager());
    const coordinatorCatalog = new CoordinatorCatalogService(store, registry, "coord-1");
    const searchService = new ClusterSearchService(store, registry, coordinatorCatalog);

    // 录入包含下划线的项目
    await store.upsertProjectCatalog([
      {
        nodeId: "node-mac",
        projectId: "proj-metrowise-v2",
        name: "MetroWise_V2",
        summary: "Enterprise RAG knowledge base search system with FastAPI, Milvus, and MongoDB",
        description: "MetroWise V2 Document Retrieval and RAG workbench",
        technologies: ["Python", "FastAPI", "Milvus", "MongoDB"],
        capabilities: ["rag_search", "document_indexing"],
        visibility: "discoverable",
        status: "active",
        registeredAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision: 1,
        updatedAt: Date.now(),
      },
    ]);

    // 录入包含下划线的联邦记忆
    await store.upsertMemoryIndex([
      {
        nodeId: "node-mac",
        projectId: "proj-metrowise-v2",
        entryId: "mem-metrowise-v2",
        topic: "MetroWise_V2",
        summary: "MetroWise V2 企业级智能知识库检索与管理系统，采用 Python/FastAPI、Milvus、MongoDB",
        keywords: ["MetroWise_V2", "FastAPI", "Milvus", "RAG"],
        sourceReference: "Discovery Report on Mac",
        confidence: 0.9,
        visibility: "summary",
        revision: 1,
        updatedAt: Date.now(),
      },
    ]);

    const queries = ["MetroWiseV2", "MetroWise_V2", "metro-wise-v2", "metro wise v2"];

    for (const q of queries) {
      // 验证目录检索命中
      const projResults = await searchService.searchProjects(q);
      assert.ok(projResults.length > 0, `Query "${q}" 应能命中项目目录`);
      assert.equal(projResults[0]!.name, "MetroWise_V2");
      assert.equal(projResults[0]!.projectId, "proj-metrowise-v2");

      // 验证联邦记忆检索命中
      const memResults = await searchService.searchFederatedMemory(q);
      assert.ok(memResults.length > 0, `Query "${q}" 应能命中联邦记忆`);
      assert.equal(memResults[0]!.topic, "MetroWise_V2");
      assert.equal(memResults[0]!.projectId, "proj-metrowise-v2");
    }
  });

  await t.test("2. 有有效记忆时，不再重复派发全节点 Scout，仅定向探查已知节点", async () => {
    const store = new InMemoryClusterStore();
    const registry = new NodeRegistry(store, new InviteManager());

    // 注册 3 台在线 Worker 节点
    const nodes = ["node-mac", "node-wsl", "node-tencent"];
    for (const n of nodes) {
      await store.saveNode({
        nodeId: n,
        name: n,
        role: "worker",
        platform: "darwin",
        arch: "arm64",
        hostname: `${n}.local`,
        tokenHash: `token-${n}`,
        status: "online",
        lastSeenAt: Date.now(),
        metadata: {} as any,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      // 注册活动连接
      (registry as any).connections.set(n, {
        nodeId: n,
        nodeName: n,
        role: "worker",
        platform: "darwin",
        metadata: {} as any,
        ws: { readyState: 1 } as any,
        generation: 1,
        connectedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      });
    }

    // 在记忆中记录 MetroWise_V2 位于 node-mac
    await store.upsertMemoryIndex([
      {
        nodeId: "node-mac",
        projectId: "proj-metrowise-v2",
        entryId: "mem-metrowise",
        topic: "MetroWise_V2",
        summary: "MetroWise V2 知识库系统，位于 Mac 节点",
        keywords: ["MetroWise_V2", "RAG"],
        sourceReference: "Discovery on Mac",
        confidence: 0.9,
        visibility: "summary",
        revision: 1,
        updatedAt: Date.now(),
      },
    ]);

    const scheduler = new TaskScheduler(store, registry, "coord-1");
    const dispatchedNodes: string[] = [];
    const origCreateTask = scheduler.createTask.bind(scheduler);
    scheduler.createTask = async (opts: any) => {
      dispatchedNodes.push(opts.nodeId);
      return origCreateTask(opts);
    };

    const discoveryService = new AutonomousDiscoveryService({
      store,
      registry,
      scheduler,
      validator: new DiscoveryResultValidator(store, registry),
      defaultTimeoutMs: 500,
    });

    // 用户查询 MetroWiseV2 (未显式指定 nodeId)
    await discoveryService.discover("MetroWiseV2");

    // 核心断言：探查任务只派发给记忆中已知的 node-mac，绝对不向 node-wsl 与 node-tencent 扩散！
    assert.deepEqual(
      dispatchedNodes,
      ["node-mac"],
      "存在记忆线索时，必须仅定向探查已知节点 node-mac，严禁向其他在线机器广播"
    );
  });

  await t.test("3. 已知节点离线时明确反馈，坚决阻断盲目遍历其他机器", async () => {
    const store = new InMemoryClusterStore();
    const registry = new NodeRegistry(store, new InviteManager());

    // 其它机器处于在线状态 (WSL2, Tencent)
    for (const n of ["node-wsl", "node-tencent"]) {
      await store.saveNode({
        nodeId: n,
        name: n,
        role: "worker",
        platform: "linux",
        arch: "x64",
        hostname: `${n}.local`,
        tokenHash: `token-${n}`,
        status: "online",
        lastSeenAt: Date.now(),
        metadata: {} as any,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      (registry as any).connections.set(n, {
        nodeId: n,
        nodeName: n,
        role: "worker",
        platform: "linux",
        metadata: {} as any,
        ws: { readyState: 1 } as any,
        generation: 1,
        connectedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      });
    }

    // 记忆中的目标节点 node-mac 处于离线状态 (无 active ws 连接)
    await store.saveNode({
      nodeId: "node-mac",
      name: "node-mac",
      role: "worker",
      platform: "darwin",
      arch: "arm64",
      hostname: "node-mac.local",
      tokenHash: "token-mac",
      status: "offline",
      lastSeenAt: Date.now() - 3600000,
      metadata: {} as any,
      createdAt: Date.now() - 7200000,
      updatedAt: Date.now() - 3600000,
    });

    await store.upsertMemoryIndex([
      {
        nodeId: "node-mac",
        projectId: "proj-metrowise-v2",
        entryId: "mem-metrowise",
        topic: "MetroWise_V2",
        summary: "MetroWise V2 知识库系统，位于 Mac 节点",
        keywords: ["MetroWise_V2", "RAG"],
        sourceReference: "Discovery on Mac",
        confidence: 0.9,
        visibility: "summary",
        revision: 1,
        updatedAt: Date.now(),
      },
    ]);

    const scheduler = new TaskScheduler(store, registry, "coord-1");
    let taskDispatchedCount = 0;
    scheduler.createTask = async (opts: any) => {
      taskDispatchedCount++;
      return {} as any;
    };

    const discoveryService = new AutonomousDiscoveryService({
      store,
      registry,
      scheduler,
      validator: new DiscoveryResultValidator(store, registry),
      defaultTimeoutMs: 500,
    });

    const result = await discoveryService.discover("MetroWiseV2");

    // 核心断言：检测到已知线索节点离线，阻止盲目向 node-wsl 与 node-tencent 派发！
    assert.equal(result.status, "known_nodes_offline");
    assert.deepEqual(result.offlineClueNodes, ["node-mac"]);
    assert.equal(taskDispatchedCount, 0, "已知节点离线时绝对禁止向其他机器发起遍历探查");
    assert.match(result.summary || "", /离线状态/);
  });

  await t.test("4. 同名多项目歧义保留与澄清机制", async () => {
    const store = new InMemoryClusterStore();
    const registry = new NodeRegistry(store, new InviteManager());

    // 两个节点上分别有同名项目
    for (const n of ["node-mac", "node-tencent"]) {
      await store.saveNode({
        nodeId: n,
        name: n,
        role: "worker",
        platform: n === "node-mac" ? "darwin" : "linux",
        arch: "x64",
        hostname: `${n}.local`,
        tokenHash: `token-${n}`,
        status: "online",
        lastSeenAt: Date.now(),
        metadata: {} as any,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      (registry as any).connections.set(n, {
        nodeId: n,
        nodeName: n,
        role: "worker",
        platform: n === "node-mac" ? "darwin" : "linux",
        metadata: {} as any,
        ws: { readyState: 1 } as any,
        generation: 1,
        connectedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      });
    }

    await store.upsertProjectCatalog([
      {
        nodeId: "node-mac",
        projectId: "proj-metrowise-mac",
        name: "MetroWise_V2",
        summary: "MetroWise V2 on Mac",
        description: "Mac local deployment",
        technologies: ["Python"],
        capabilities: ["rag"],
        visibility: "discoverable",
        status: "active",
        registeredAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision: 1,
        updatedAt: Date.now(),
      },
      {
        nodeId: "node-tencent",
        projectId: "proj-metrowise-cloud",
        name: "MetroWise_V2",
        summary: "MetroWise V2 on Tencent Cloud",
        description: "Cloud deployment",
        technologies: ["Python"],
        capabilities: ["rag"],
        visibility: "discoverable",
        status: "active",
        registeredAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision: 1,
        updatedAt: Date.now(),
      },
    ]);

    const coordinatorCatalog = new CoordinatorCatalogService(store, registry, "coord-1");
    const searchService = new ClusterSearchService(store, registry, coordinatorCatalog);
    const collector = new RoutingCandidateCollector(searchService);
    const ranker = new RoutingCandidateRanker();
    const decisionEngine = new RoutingDecisionEngine();

    const intent: TaskIntent = {
      originalRequest: "检查 MetroWiseV2 的健康状态",
      goal: "检查 MetroWiseV2 的健康状态",
      operation: "inspect",
      projectHints: ["MetroWiseV2"],
      nodeHints: [],
      capabilityHints: [],
      requiredCapabilities: [],
      preferredCapabilities: [],
      constraints: {},
      ambiguities: [],
      riskHints: [],
      confidence: 0.9,
    };

    const candidates = await collector.collect(intent);
    assert.equal(candidates.length, 2, "应收集到 Mac 与 Tencent 两个候选项目");

    const ranked = ranker.rank(intent, candidates);
    const decision = decisionEngine.decide(intent, ranked);

    // 核心断言：多个满足条件的候选项目得分相同/接近时，必须触发澄清，保留歧义并向用户询问
    assert.equal(
      decision.decisionType,
      "CLARIFICATION_REQUIRED",
      "存在同名多项目且得分接近时，必须触发澄清向用户确认"
    );
    assert.ok(decision.clarificationOptions && decision.clarificationOptions.length >= 2);
  });

  await t.test("5. 未注册项目不能凭记忆绕过执行权限检查 (Deterministic Safety Boundary)", async () => {
    const store = new InMemoryClusterStore();
    const registry = new NodeRegistry(store, new InviteManager());

    await store.saveNode({
      nodeId: "node-mac",
      name: "node-mac",
      role: "worker",
      platform: "darwin",
      arch: "arm64",
      hostname: "node-mac.local",
      tokenHash: "token-mac",
      status: "online",
      lastSeenAt: Date.now(),
      metadata: {} as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    (registry as any).connections.set("node-mac", {
      nodeId: "node-mac",
      nodeName: "node-mac",
      role: "worker",
      platform: "darwin",
      metadata: {} as any,
      ws: { readyState: 1 } as any,
      generation: 1,
      connectedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    });

    // 仅在记忆中发现过，但在节点上尚未正式注册 (discovered-*)
    const validator = new RoutingValidator(store, registry);
    const checkUnregistered = await validator.validateCandidate(
      {
        nodeId: "node-mac",
        projectId: "discovered-9a1b2c3d4e5f6789",
      },
      {
        constraints: {},
        requiredCapabilities: [],
      }
    );

    // 核心断言：未注册项目被严厉拒绝，绝不能直接执行
    assert.equal(checkUnregistered.valid, false);
    assert.equal(checkUnregistered.code, "PROJECT_NOT_FOUND");
    assert.match(checkUnregistered.reason, /not registered/);
  });
});
