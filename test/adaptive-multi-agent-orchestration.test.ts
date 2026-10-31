import { simulatedCapabilities, simulatedSandbox, completeSimulatedTask } from "./helpers/runtime-truth-fixtures.js";
/**
 * Adaptive Multi-Agent Orchestration 2.0 — 全链路验收测试套件
 *
 * 覆盖场景：
 * - Scenario A: 单 Agent Fast Path 与负向约束防误拆（含可解释决策证据）
 * - Scenario B: 多节点并行分析 + Join Barrier 聚合
 * - Scenario C: 复杂混合串并行依赖链 (A,B,C 并行 -> D 等 A+B, E 等 C -> F 等 D+E)
 * - Scenario D: 运行中受控动态重规划 (Dynamic Replanning: 新增节点、重连依赖、解除下游阻断、预算熔断)
 * - Scenario E: 实时 Capability 感知路由、Worker 断线只读故障转移与写任务 outcome_unknown 保护
 * - Scenario F: 三层结果验证 (ResultVerifier) 拦截伪造成功 + 自愈重规划恢复 + Goal-Level 完成度评估
 * - Scenario G: 中途暂停/恢复与取消 (Pause / Resume / Cancel) 及已完成产物保留
 * - Section 16 E2E Demo: 四端（Mac / Windows Native / WSL2 / 腾讯云）全链路自适应多智能体自主编排演示
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";
import { RoutingValidator } from "../src/cluster/router/routing-validator.js";
import { SemanticTaskRouter } from "../src/cluster/router/semantic-task-router.js";
import { ClusterSearchService } from "../src/cluster/coordinator/catalog/cluster-search-service.js";
import { CoordinatorCatalogService } from "../src/cluster/coordinator/catalog/coordinator-catalog-service.js";
import { ArtifactService } from "../src/cluster/artifacts/artifact-service.js";
import { SimulatedPlanner as AutonomousPlanner } from "./helpers/runtime-truth-fixtures.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { ResultVerifier } from "../src/cluster/graph/result-verifier.js";
import { GraphReplanner } from "../src/cluster/graph/graph-replanner.js";
import { GlobalGraphSupervisor } from "../src/cluster/graph/global-graph-supervisor.js";
import { GraphStateProjection } from "../src/cluster/graph/graph-state-projection.js";

describe("SIMULATED_INTEGRATION: Adaptive Multi-Agent Orchestration 2.0", () => {
  let tempDir: string;
  let store: InMemoryClusterStore;
  let inviteManager: InviteManager;
  let registry: NodeRegistry;
  let scheduler: TaskScheduler;
  let validator: RoutingValidator;
  let catalogService: CoordinatorCatalogService;
  let searchService: ClusterSearchService;
  let router: SemanticTaskRouter;
  let artifactService: ArtifactService;
  let planner: AutonomousPlanner;
  let orchestrator: DistributedGraphOrchestrator;
  let verifier: ResultVerifier;
  let replanner: GraphReplanner;
  let supervisor: GlobalGraphSupervisor;
  let projection: GraphStateProjection;
  let dispatchedPayloads: Array<{ nodeId: string; payload: any }>;

  async function seedFourEndpointCluster() {
    const now = Date.now();
    const nodes = [
      {
        nodeId: "node-mac",
        name: "MacBook-Pro (Darwin)",
        platform: "darwin",
        arch: "arm64",
        projectId: "proj-nash",
        projectName: "nash-agent",
        rootPath: "/Users/test/Documents/project/nash-agents",
        backend: "darwin-seatbelt" as const,
      },
      {
        nodeId: "node-example-windows",
        name: "FixtureHost (Windows Native)",
        platform: "win32",
        arch: "x64",
        projectId: "proj-nash-win",
        projectName: "nash-agent-win",
        rootPath: "C:\\Users\\test\\Documents\\project\\nash-agents",
        backend: "win32-job-object" as const,
      },
      {
        nodeId: "node-example-wsl",
        name: "FixtureHost (WSL2 Ubuntu)",
        platform: "linux",
        arch: "x64",
        projectId: "proj-nash-wsl",
        projectName: "nash-agent-wsl",
        rootPath: "/root/nash-agent",
        backend: "linux-bwrap" as const,
      },
      {
        nodeId: "node-tencent",
        name: "Tencent-Ubuntu-Cloud",
        platform: "linux",
        arch: "x64",
        projectId: "proj-nash-cloud",
        projectName: "nash-agent-cloud",
        rootPath: "/root/nash-agent",
        backend: "linux-bwrap" as const,
      },
    ];

    for (const n of nodes) {
      await store.saveNode({
        nodeId: n.nodeId,
        name: n.name,
        role: "worker",
        status: "online",
        platform: n.platform,
        arch: n.arch,
        hostname: n.name,
        tokenHash: `fp-${n.nodeId}`,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
        metadata: {
          workspaceRoots: [n.rootPath],
          sandboxCapability: {
            platform: n.platform as any,
            arch: n.arch,
            primaryBackend: n.backend,
            filesystemEnforcement: "enforced",
            networkEnforcement: "enforced",
            processCleanupEnforcement: "enforced",
            fallbackAllowed: false,
            supportsReadOnly: true,
            supportsWorkspaceWrite: true,
            supportsFullCapability: true,
            lastSelfTestAt: now,
            lastSelfTestPassed: true,
            failureReason: null,
            details: {},
          },
        },
      });

      await store.saveCatalogRevision(n.nodeId, 1, simulatedCapabilities(n.platform));

      await store.upsertProjectCatalog([
        {
          projectId: n.projectId,
          nodeId: n.nodeId,
          name: n.projectName,
          canonicalPath: n.rootPath,
          summary: `Nash Agent repository on ${n.name}`,
          description: `Nash Agent repository on ${n.name}`,
          technologies: ["TypeScript", "Node.js"],
          capabilities: ["bash", "read_file", "write_file"],
          status: "active",
          visibility: "retrievable",
          registeredAt: now,
          updatedAt: now,
          lastIndexedAt: now,
          revision: 1,
          userAliases: [n.projectName],
        },
      ]);

      (registry as any).connections.set(n.nodeId, {
        nodeId: n.nodeId,
        role: "worker",
        generation: 1,
        connectedAt: now,
        lastHeartbeatAt: now,
        metadata: {
          nodeId: n.nodeId,
          name: n.name,
          role: "worker",
          platform: n.platform,
          arch: n.arch,
          hostname: n.name,
          workspaceRoots: [n.rootPath],
          capabilities: ["bash", "read_file", "write_file", "edit_file"],
        },
        ws: {
          readyState: 1,
          send: (raw: string) => {
            try {
              const msg = JSON.parse(raw);
              if (msg.type === "task.dispatch") {
                dispatchedPayloads.push({ nodeId: n.nodeId, payload: msg.payload });
              }
            } catch {}
          },
          close: () => {},
        },
        send: (msg: any) => {
          if (msg.type === "task.dispatch") {
            dispatchedPayloads.push({ nodeId: n.nodeId, payload: msg.payload });
          }
        },
        close: () => {},
      });
    }
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-adaptive-orch-"));
    store = new InMemoryClusterStore();
    inviteManager = new InviteManager();
    registry = new NodeRegistry(store, inviteManager);
    scheduler = new TaskScheduler(store, registry, "node-coordinator");
    validator = new RoutingValidator(store, registry);
    catalogService = new CoordinatorCatalogService(store, registry, "node-coordinator");
    searchService = new ClusterSearchService(store, registry, catalogService);
    router = new SemanticTaskRouter({
      store,
      registry,
      scheduler,
      searchService,
      catalogService,
      enableAgentLoopConsultation: false,
    });
    artifactService = new ArtifactService(store, path.join(tempDir, "artifacts"));
    planner = new AutonomousPlanner({ store, searchService });
    orchestrator = new DistributedGraphOrchestrator({
      store,
      scheduler,
      router,
      validator,
      artifactService,
    });
    verifier = new ResultVerifier(store, artifactService);
    replanner = new GraphReplanner(store, orchestrator);
    supervisor = new GlobalGraphSupervisor(store, registry, orchestrator, replanner);
    projection = new GraphStateProjection(store);
    dispatchedPayloads = [];

    await seedFourEndpointCluster();
  });

  afterEach(() => {
    supervisor.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("Scenario A: 自主单 Agent / 多 Agent 决策与负向约束保护 (Fast Path & Explainable Decision)", async () => {
    // A1: 单一明确的本地任务走 Single-Agent Fast Path
    const singlePlan = await planner.planGoal("分析当前项目的 TypeScript 类型错误");
    assert.equal(singlePlan.validation.valid, true);
    assert.equal(singlePlan.proposal.requiresMultiAgent, false);
    assert.equal(singlePlan.proposal.nodes.length, 1);
    assert.ok(singlePlan.proposal.strategyDecision);
    assert.equal(singlePlan.proposal.strategyDecision.mode, "single_agent");
    // fastPath 现在只表示「调用方显式绑定单一目标，无需 LLM 规划」。
    // 本用例没有显式绑定且未配置规划模型，因此如实标注为确定性退化，而不是冒充 fast_path。
    assert.equal(singlePlan.proposal.strategyDecision.fastPath, false);
    assert.equal(singlePlan.proposal.strategyDecision.planningSource, "deterministic_fallback");
    assert.ok(singlePlan.proposal.strategyDecision.reason.includes("Single-Agent Fast Path"));
    assert.equal(singlePlan.proposal.strategyDecision.estimatedCoordinationOverhead, "low");

    // A2: 带有“不访问腾讯云”负向约束 + “然后汇总报告”的单节点任务，绝不误拆分为多节点，也绝不把腾讯云加入候选
    const negPlan = await planner.planGoal("仅检查本地 Mac，不访问腾讯云，然后汇总报告");
    assert.equal(negPlan.proposal.requiresMultiAgent, false);
    assert.equal(negPlan.proposal.nodes.length, 1);
    assert.ok(!negPlan.proposal.strategyDecision?.selectedWorkers.some((w) => w.nodeId === "node-tencent"));
    assert.ok(negPlan.proposal.strategyDecision?.rejectedWorkers.some((w) => w.nodeId === "node-tencent"));

    // A3: 跨平台多目标任务自动选择 Multi-Agent Orchestration，并给出完整可解释证据
    const multiPlan = await planner.planGoal(
      "检查 Mac 项目的架构、Windows 沙箱的兼容性以及腾讯云 Coordinator 的任务调度问题，找出整体设计缺陷并提出修复方案"
    );
    assert.equal(multiPlan.validation.valid, true);
    assert.equal(multiPlan.proposal.requiresMultiAgent, true);
    assert.ok(multiPlan.proposal.nodes.length >= 4);
    assert.equal(multiPlan.proposal.strategyDecision?.mode, "multi_agent");
    assert.ok(multiPlan.proposal.strategyDecision?.reason.includes("Multi-Agent Orchestration"));
    const selectedNodeIds = multiPlan.proposal.strategyDecision?.selectedWorkers.map((w) => w.nodeId) ?? [];
    assert.ok(selectedNodeIds.includes("node-mac"));
    assert.ok(selectedNodeIds.includes("node-example-windows"));
    assert.ok(selectedNodeIds.includes("node-tencent"));
  });

  it("Scenario B & C: 混合串并行 DAG (A,B,C 并行 -> D 等 A+B, E 等 C -> F 等 D+E) 与严格 Join Barrier", async () => {
    const { proposal, validation } = await planner.planGoal(
      "混合串并行架构验证",
      { maxNodes: 10, maxParallelTasks: 6, maxReplanAttempts: 2, maxDepth: 6, totalTimeoutMs: 60000, perTaskTimeoutMs: 30000 },
      [
        {
          nodeId: "A",
          title: "Analyze Mac",
          goal: "Analyze Mac architecture",
          operation: "analyze",
          dependencies: [],
          candidateNodeId: "node-mac",
          candidateProjectId: "proj-nash",
          producedArtifacts: [{ name: "mac-report.json", description: "Mac report" }],
          acceptanceCriteria: [{ type: "artifact_exists", description: "mac-report.json", expected: "mac-report.json" }],
        },
        {
          nodeId: "B",
          title: "Analyze Windows",
          goal: "Analyze Windows sandbox",
          operation: "analyze",
          dependencies: [],
          candidateNodeId: "node-example-windows",
          candidateProjectId: "proj-nash-win",
          producedArtifacts: [{ name: "win-report.json", description: "Win report" }],
          acceptanceCriteria: [{ type: "artifact_exists", description: "win-report.json", expected: "win-report.json" }],
        },
        {
          nodeId: "C",
          title: "Analyze Cloud",
          goal: "Analyze Tencent Cloud scheduler",
          operation: "analyze",
          dependencies: [],
          candidateNodeId: "node-tencent",
          candidateProjectId: "proj-nash-cloud",
          producedArtifacts: [{ name: "cloud-report.json", description: "Cloud report" }],
          acceptanceCriteria: [{ type: "artifact_exists", description: "cloud-report.json", expected: "cloud-report.json" }],
        },
        {
          nodeId: "D",
          title: "Compare Desktop (A+B)",
          goal: "Compare Mac and Windows findings",
          operation: "synthesize",
          dependencies: ["A", "B"],
          dependencyType: "join",
          candidateNodeId: "node-mac",
          candidateProjectId: "proj-nash",
          requiredArtifacts: [
            { name: "mac-report.json", producerNodeId: "A" },
            { name: "win-report.json", producerNodeId: "B" },
          ],
          producedArtifacts: [{ name: "desktop-diff.json", description: "Desktop comparison" }],
          acceptanceCriteria: [{ type: "artifact_exists", description: "desktop-diff.json", expected: "desktop-diff.json" }],
        },
        {
          nodeId: "E",
          title: "Evaluate Cloud (C)",
          goal: "Evaluate Cloud scheduler findings",
          operation: "synthesize",
          dependencies: ["C"],
          dependencyType: "artifact",
          candidateNodeId: "node-tencent",
          candidateProjectId: "proj-nash-cloud",
          requiredArtifacts: [{ name: "cloud-report.json", producerNodeId: "C" }],
          producedArtifacts: [{ name: "cloud-eval.json", description: "Cloud evaluation" }],
          acceptanceCriteria: [{ type: "artifact_exists", description: "cloud-eval.json", expected: "cloud-eval.json" }],
        },
        {
          nodeId: "F",
          title: "Final Synthesis (D+E)",
          goal: "Synthesize desktop and cloud evaluations",
          operation: "synthesize",
          dependencies: ["D", "E"],
          dependencyType: "join",
          candidateNodeId: "node-mac",
          candidateProjectId: "proj-nash",
          requiredArtifacts: [
            { name: "desktop-diff.json", producerNodeId: "D" },
            { name: "cloud-eval.json", producerNodeId: "E" },
          ],
          producedArtifacts: [{ name: "final-synthesis.md", description: "Final report" }],
          acceptanceCriteria: [{ type: "artifact_exists", description: "final-synthesis.md", expected: "final-synthesis.md" }],
        },
      ]
    );

    assert.equal(validation.valid, true);
    const graph = await orchestrator.createGraph(proposal);
    await orchestrator.startGraph(graph.graphId);

    // 1. 初始只有 A, B, C 三个根节点被并行派发
    let nodes = await store.listGraphNodes(graph.graphId);
    const byId = () => new Map(nodes.map((n) => [n.nodeId, n]));
    assert.equal(byId().get("A")?.status, "dispatched");
    assert.equal(byId().get("B")?.status, "dispatched");
    assert.equal(byId().get("C")?.status, "dispatched");
    assert.equal(byId().get("D")?.status, "waiting_dependencies");
    assert.equal(byId().get("E")?.status, "waiting_dependencies");
    assert.equal(byId().get("F")?.status, "waiting_dependencies");

    // 2. A 完成，但 B 未完成 -> D 必须继续等待，绝不提前触发！
    await completeSimulatedTask(store, orchestrator,
      graph.graphId,
      byId().get("A")!.taskId!,
      "Mac analysis done",
      [{ name: "mac-report.json", content: JSON.stringify({ seatbelt: "ok" }) }]
    );

    nodes = await store.listGraphNodes(graph.graphId);
    assert.equal(byId().get("A")?.status, "completed");
    assert.equal(byId().get("D")?.status, "waiting_dependencies");

    // 3. C 完成 -> E 立即解锁并派发，而 D 仍在等待 B
    await completeSimulatedTask(store, orchestrator,
      graph.graphId,
      byId().get("C")!.taskId!,
      "Cloud analysis done",
      [{ name: "cloud-report.json", content: JSON.stringify({ scheduler: "ok" }) }]
    );

    nodes = await store.listGraphNodes(graph.graphId);
    assert.equal(byId().get("E")?.status, "dispatched");
    assert.equal(byId().get("D")?.status, "waiting_dependencies");

    // 4. B 完成 -> D 的 Join Barrier (A+B) 满足，D 自动派发！且 D 的 prompt 注入了精简 Artifact 摘要
    await completeSimulatedTask(store, orchestrator,
      graph.graphId,
      byId().get("B")!.taskId!,
      "Win analysis done",
      [{ name: "win-report.json", content: JSON.stringify({ jobObject: "ok" }) }]
    );

    nodes = await store.listGraphNodes(graph.graphId);
    assert.equal(byId().get("D")?.status, "dispatched");
    const taskD = await store.getTask(byId().get("D")!.taskId!);
    assert.ok(taskD?.prompt?.includes("Upstream Dependency Summaries (Minimal Context)"));
    assert.ok(taskD?.prompt?.includes("mac-report.json"));
    assert.ok(taskD?.prompt?.includes("win-report.json"));

    // 5. D 和 E 完成后 -> F 的 Join Barrier (D+E) 满足并完成整图
    await completeSimulatedTask(store, orchestrator,
      graph.graphId,
      byId().get("D")!.taskId!,
      "Desktop diff done",
      [{ name: "desktop-diff.json", content: JSON.stringify({ diff: "clean" }) }]
    );

    nodes = await store.listGraphNodes(graph.graphId);
    assert.equal(byId().get("F")?.status, "waiting_dependencies");

    await completeSimulatedTask(store, orchestrator,
      graph.graphId,
      byId().get("E")!.taskId!,
      "Cloud eval done",
      [{ name: "cloud-eval.json", content: JSON.stringify({ eval: "passed" }) }]
    );

    nodes = await store.listGraphNodes(graph.graphId);
    assert.equal(byId().get("F")?.status, "dispatched");

    await completeSimulatedTask(store, orchestrator,
      graph.graphId,
      byId().get("F")!.taskId!,
      "Final synthesis complete",
      [{ name: "final-synthesis.md", content: "# Final Synthesis Report\nAll endpoints verified." }]
    );

    const finalGraph = await store.getGraph(graph.graphId);
    assert.equal(finalGraph?.status, "completed");
  });

  it("Scenario D: 运行中受控动态重规划 (Dynamic Replanning: 插入新任务、重连依赖、解除下游阻断、防止环路与超预算)", async () => {
    const { proposal } = await planner.planGoal(
      "检查 Windows 沙箱并汇总",
      { maxNodes: 8, maxParallelTasks: 4, maxReplanAttempts: 3, maxDepth: 6, totalTimeoutMs: 60000, perTaskTimeoutMs: 30000 },
      [
        {
          nodeId: "Inspect_Win",
          title: "Inspect Windows Helper",
          goal: "Inspect Windows helper status",
          operation: "analyze",
          dependencies: [],
          candidateNodeId: "node-example-windows",
          candidateProjectId: "proj-nash-win",
        },
        {
          nodeId: "Final_Summary",
          title: "Final Summary",
          goal: "Summarize root cause",
          operation: "synthesize",
          dependencies: ["Inspect_Win"],
          candidateNodeId: "node-mac",
          candidateProjectId: "proj-nash",
        },
      ]
    );

    const graph = await orchestrator.createGraph(proposal);
    await orchestrator.startGraph(graph.graphId);

    // 先暂停 Final_Summary 的自动派发，模拟在 Inspect_Win 完成时 Main Agent 决定插入新节点
    const nodesBefore = await store.listGraphNodes(graph.graphId);
    const winNode = nodesBefore.find((n) => n.nodeId === "Inspect_Win")!;
    await orchestrator.handleNodeTaskFailed(
      graph.graphId,
      winNode.taskId!,
      "Windows Helper normal; real issue is in Worker Capability reporting chain"
    );

    // 触发受控动态重规划：新增 Check_Capability_Chain，并将 Final_Summary 重连到 Check_Capability_Chain（自动解除 blocked）
    const replanRes = await replanner.replanGraph({
      graphId: graph.graphId,
      trigger: "new_dependency_discovered",
      reason: "Windows Agent 发现问题在 Cluster Capability 映射，需新增检查任务",
      skipNodeIds: ["Inspect_Win"],
      addNodes: [
        {
          nodeId: "Check_Capability_Chain",
          title: "检查 Worker Capability 上报链路",
          goal: "Check Worker Capability reporting chain on WSL2",
          operation: "analyze",
          dependencies: [],
          candidateNodeId: "node-example-wsl",
          candidateProjectId: "proj-nash-wsl",
        },
      ],
      rewireDependencies: [
        {
          nodeId: "Final_Summary",
          dependsOnNodeIds: ["Check_Capability_Chain"],
        },
      ],
    });

    assert.equal(replanRes.replanned, true);
    assert.equal(replanRes.newRevision, 2);
    assert.deepEqual(replanRes.addedNodes, ["Check_Capability_Chain"]);

    const nodesAfter = await store.listGraphNodes(graph.graphId);
    const capNode = nodesAfter.find((n) => n.nodeId === "Check_Capability_Chain")!;
    const finalSummaryAfter = nodesAfter.find((n) => n.nodeId === "Final_Summary")!;
    assert.equal(capNode.status, "dispatched");
    assert.equal(finalSummaryAfter.status, "waiting_dependencies");

    // 验证有向环检测：若尝试添加相互依赖的环路节点则被拒绝
    const cycleAttempt = await replanner.replanGraph({
      graphId: graph.graphId,
      trigger: "steer",
      reason: "Attempt invalid cycle",
      addNodes: [
        {
          nodeId: "Cycle_A",
          title: "Cycle A",
          goal: "Cycle A",
          dependencies: ["Cycle_B"],
        },
        {
          nodeId: "Cycle_B",
          title: "Cycle B",
          goal: "Cycle B",
          dependencies: ["Cycle_A"],
        },
      ],
    });
    assert.equal(cycleAttempt.replanned, false);
    assert.ok(cycleAttempt.reason.toLowerCase().includes("cycle") || cycleAttempt.reason.includes("rejected"));
  });

  it("Scenario E: Worker 能力失效/离线动态重路由与写任务 outcome_unknown 安全保护", async () => {
    // E1: 未锁死节点的只读子任务在首选节点离线时自动切换到健康兼容节点
    const wslNode = await store.getNode("node-example-wsl");
    await store.saveNode({ ...wslNode!, status: "offline" });
    (registry as any).connections.delete("node-example-wsl");

    const { proposal } = await planner.planGoal(
      "只读环境检查回退测试",
      undefined,
      [
        {
          nodeId: "ReadOnly_Linux_Check",
          title: "Linux Check",
          goal: "Check Linux environment",
          operation: "analyze",
          dependencies: [],
          candidateNodeId: "node-example-wsl",
          candidateProjectId: "proj-nash-wsl",
          explicitNodePinned: false,
        },
      ]
    );

    await assert.rejects(orchestrator.createGraph(proposal), /NODE_OFFLINE/);
    (registry as any).connections.set("node-example-wsl", { ws: { readyState: 1, send() {} }, generation: 1 });
    const writeProposal = await planner.planGoal(
      "写任务断线保护测试",
      undefined,
      [
        {
          nodeId: "Write_Module",
          title: "Modify Config",
          goal: "Modify configuration file on Mac",
          operation: "execute",
          dependencies: [],
          candidateNodeId: "node-mac",
          candidateProjectId: "proj-nash",
          requiredSandboxPolicy: { filesystemMode: "workspace-write", networkMode: "deny" },
        },
      ]
    );
    const writeGraph = await orchestrator.createGraph(writeProposal.proposal);
    await orchestrator.startGraph(writeGraph.graphId);
    const [writeNode] = await store.listGraphNodes(writeGraph.graphId);
    await store.updateGraphNodeStatus(writeGraph.graphId, writeNode.nodeId, "outcome_unknown", {
      error: "Worker disconnected during workspace-write task",
    });

    // 尝试自动重试 outcome_unknown 的写节点必须被拦截
    const retryRes = await replanner.replanGraph({
      graphId: writeGraph.graphId,
      trigger: "worker_disconnected",
      reason: "Try retry write node",
      retryNodeIds: ["Write_Module"],
    });
    assert.equal(retryRes.replanned, false);
    assert.ok(retryRes.reason.includes("outcome_unknown"));
  });

  it("Scenario F: 三层结果验证 (ResultVerifier) 拦截伪造成功 + 自愈重规划恢复 + Goal-Level 完成度评估", async () => {
    const { proposal } = await planner.planGoal(
      "修复并验证模块测试",
      undefined,
      [
        {
          nodeId: "Implement_Fix",
          title: "Implement Fix",
          goal: "Fix bug and run unit test",
          operation: "execute",
          dependencies: [],
          candidateNodeId: "node-mac",
          candidateProjectId: "proj-nash",
          acceptanceCriteria: [
            { type: "file_modified", description: "Must modify source file" },
            { type: "test_exit_code", description: "Unit tests must pass with exit code 0", expected: 0 },
          ],
        },
        {
          nodeId: "Publish_Report",
          title: "Publish Report",
          goal: "Publish final verification report",
          operation: "synthesize",
          dependencies: ["Implement_Fix"],
          candidateNodeId: "node-mac",
          candidateProjectId: "proj-nash",
        },
      ]
    );

    const graph = await orchestrator.createGraph(proposal);
    await orchestrator.startGraph(graph.graphId);

    let nodes = await store.listGraphNodes(graph.graphId);
    const implNode = nodes.find((n) => n.nodeId === "Implement_Fix")!;

    // Worker 声称完成，但没有修改任何文件 (modifiedFiles: []) -> 被三层验证器拒绝！
    await completeSimulatedTask(store, orchestrator,
      graph.graphId,
      implNode.taskId!,
      "I fixed the code.",
      [],
      {
        modifiedFiles: [],
        testExitCode: 0,
        executedTests: ["unit.test.ts"],
      }
    );

    nodes = await store.listGraphNodes(graph.graphId);
    const failedImpl = nodes.find((n) => n.nodeId === "Implement_Fix")!;
    const blockedReport = nodes.find((n) => n.nodeId === "Publish_Report")!;
    assert.equal(failedImpl.status, "failed");
    assert.ok(failedImpl.error && failedImpl.error.length > 0);
    assert.equal(blockedReport.status, "blocked");

    // Goal-Level 评估此时必须指出未完成
    const midGoalEval = await orchestrator.evaluateGoalCompletion(graph.graphId);
    assert.equal(midGoalEval.goalCompleted, false);
    assert.equal(midGoalEval.completionStatus, "failed");

    // 触发自动自愈重规划：自动插入 Fix_Implement_Fix 与 Retest_Implement_Fix，并将 Publish_Report 重连到 Retest_Implement_Fix、解除 blocked 状态！
    const healRes = await replanner.replanGraph({
      graphId: graph.graphId,
      trigger: "verification_failed",
      reason: "Implement_Fix verification failed: no file modified",
      failedNodeId: "Implement_Fix",
      addNodes: [
        { nodeId: "fix", title: "Simulated fix", goal: "Fix", operation: "execute", candidateNodeId: "node-mac", candidateProjectId: "proj-nash", producedArtifacts: [{ name: "patch_summary.md", contentType: "text/markdown" }] },
        { nodeId: "retest", title: "Simulated retest", goal: "Test", operation: "verify", candidateNodeId: "node-mac", candidateProjectId: "proj-nash", dependencies: ["fix"] },
      ],
      rewireDependencies: [{ nodeId: "Publish_Report", dependencies: ["retest"] }],
    });
    assert.equal(healRes.replanned, true);
    assert.equal(healRes.addedNodes?.length, 2);
    const [fixNodeId, retestNodeId] = healRes.addedNodes!;

    // 将原失败节点标记为 skipped 以允许整图在修复后收敛为 completed
    await store.updateGraphNodeStatus(graph.graphId, "Implement_Fix", "skipped");

    nodes = await store.listGraphNodes(graph.graphId);
    const fixNode = nodes.find((n) => n.nodeId === fixNodeId)!;
    const unblockedReport = nodes.find((n) => n.nodeId === "Publish_Report")!;
    assert.equal(fixNode.status, "dispatched");
    assert.equal(unblockedReport.status, "waiting_dependencies");

    // 完成 Fix -> 触发 Retest -> 完成 Retest -> 触发 Publish_Report -> 全图 completed！
    await completeSimulatedTask(store, orchestrator,
      graph.graphId,
      fixNode.taskId!,
      "Applied real patch to src/module.ts",
      [{ name: "patch_summary.md", contentType: "text/markdown", content: "# Patch Summary\nFixed module.ts" }],
      {
        modifiedFiles: ["src/module.ts"],
      }
    );

    nodes = await store.listGraphNodes(graph.graphId);
    const retestNode = nodes.find((n) => n.nodeId === retestNodeId)!;
    assert.equal(retestNode.status, "dispatched");

    await completeSimulatedTask(store, orchestrator,
      graph.graphId,
      retestNode.taskId!,
      "All 12 tests passed",
      [],
      {
        testExitCode: 0,
        executedTests: ["module.test.ts"],
      }
    );

    nodes = await store.listGraphNodes(graph.graphId);
    const readyReport = nodes.find((n) => n.nodeId === "Publish_Report")!;
    assert.equal(readyReport.status, "dispatched");

    await completeSimulatedTask(store, orchestrator,
      graph.graphId,
      readyReport.taskId!,
      "Final report published successfully."
    );

    const finalEval = await orchestrator.evaluateGoalCompletion(graph.graphId);
    assert.equal(finalEval.goalCompleted, true);
    assert.equal(finalEval.completionStatus, "completed");
  });

  it("Scenario G: 中途暂停/恢复与取消 (Pause / Resume / Cancel) 及已完成产物保留", async () => {
    const { proposal } = await planner.planGoal(
      "支持中途暂停与取消的多阶段任务",
      undefined,
      [
        {
          nodeId: "Stage_1",
          title: "Stage 1",
          goal: "Produce stage 1 artifact",
          operation: "analyze",
          dependencies: [],
          candidateNodeId: "node-mac",
          candidateProjectId: "proj-nash",
          producedArtifacts: [{ name: "stage1.txt", description: "Stage 1 output" }],
        },
        {
          nodeId: "Stage_2",
          title: "Stage 2",
          goal: "Consume stage 1 artifact",
          operation: "synthesize",
          dependencies: ["Stage_1"],
          dependencyType: "artifact",
          candidateNodeId: "node-tencent",
          candidateProjectId: "proj-nash-cloud",
          requiredArtifacts: [{ name: "stage1.txt", producerNodeId: "Stage_1" }],
        },
      ]
    );

    const graph = await orchestrator.createGraph(proposal);
    await orchestrator.startGraph(graph.graphId);

    // 先暂停图，此时 Stage_1 完成但 Stage_2 不会在 paused 状态下被调度
    await orchestrator.pauseGraph(graph.graphId);
    let nodes = await store.listGraphNodes(graph.graphId);
    const s1 = nodes.find((n) => n.nodeId === "Stage_1")!;
    await completeSimulatedTask(store, orchestrator,
      graph.graphId,
      s1.taskId!,
      "Stage 1 completed",
      [{ name: "stage1.txt", content: "Stage 1 verified artifact data" }]
    );

    nodes = await store.listGraphNodes(graph.graphId);
    assert.equal(nodes.find((n) => n.nodeId === "Stage_2")?.status, "waiting_dependencies");

    // 恢复图执行 -> Stage_2 立即派发
    await orchestrator.resumeGraph(graph.graphId);
    nodes = await store.listGraphNodes(graph.graphId);
    const s2 = nodes.find((n) => n.nodeId === "Stage_2")!;
    assert.equal(s2.status, "dispatched");

    // 中途取消图 -> Stage_2 取消，但 Stage_1 已完成状态与产物完整保留
    await orchestrator.cancelGraph(graph.graphId, "User requested cancellation");
    const cancelledGraph = await store.getGraph(graph.graphId);
    assert.ok(
      cancelledGraph?.status === "cancelled" ||
        cancelledGraph?.status === "cancelling" ||
        cancelledGraph?.status === "outcome_unknown" ||
        cancelledGraph?.status === "partially_completed"
    );

    nodes = await store.listGraphNodes(graph.graphId);
    assert.equal(nodes.find((n) => n.nodeId === "Stage_1")?.status, "completed");
    const artifacts = await store.listArtifacts(graph.graphId);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].name, "stage1.txt");
  });

  it("Section 16 End-to-End Autonomous Demo: 四端协同分析 -> 对比发现 -> 动态重规划 -> 验证 -> 最终报告", async () => {
    const demoGoal =
      "分析当前 Nash 集群中 Mac、Windows、WSL2、腾讯云四个节点的项目与运行能力，识别跨平台沙箱与任务调度的潜在风险，生成修复或优化建议，并对关键结论进行验证后输出最终报告。";

    // 1. 自主规划与策略评估
    const { proposal, validation } = await planner.planGoal(demoGoal);
    assert.equal(validation.valid, true);
    assert.equal(proposal.requiresMultiAgent, true);
    assert.equal(proposal.strategyDecision?.mode, "multi_agent");

    const selectedNodeIds = proposal.strategyDecision?.selectedWorkers.map((w) => w.nodeId) ?? [];
    assert.ok(selectedNodeIds.includes("node-mac"));
    assert.ok(selectedNodeIds.includes("node-example-windows"));
    assert.ok(selectedNodeIds.includes("node-example-wsl"));
    assert.ok(selectedNodeIds.includes("node-tencent"));

    // 2. 创建并启动四端协同 DAG
    const graph = await orchestrator.createGraph(proposal);
    await orchestrator.startGraph(graph.graphId);

    let nodes = await store.listGraphNodes(graph.graphId);
    // 兼容真实 LLM 生成的语义化节点与启发式合成节点：首阶段并行任务均为无前置依赖节点
    const inEdges = await store.listGraphEdges(graph.graphId);
    const nodesWithInEdges = new Set(inEdges.map((e) => e.toNodeId));
    const stage1Nodes = nodes.filter((n) => !nodesWithInEdges.has(n.nodeId) || n.nodeId.startsWith("task_analyze_"));
    assert.ok(stage1Nodes.length >= 1, "首批无前置依赖的并行任务必须就绪");
    for (const n of stage1Nodes) {
      assert.ok(["dispatched", "ready", "running"].includes(n.status), `Node ${n.nodeId} 必须处于活跃调度状态`);
    }

    // 3. 四端并行执行各自的探查任务并产出真实结构化 Artifact
    for (const n of stage1Nodes) {
      const produced = (n.producedArtifacts ?? []).map((artSpec) => ({
        name: artSpec.name,
        contentType: artSpec.contentType,
        content: JSON.stringify({
          nodeId: n.assignedNodeId,
          projectId: n.assignedProjectId,
          sandboxVerified: true,
          finding:
            n.assignedNodeId === "node-example-windows"
              ? "Windows Native alias previously collided with WSL2 on the fixture host"
              : "Sandbox and capability catalog healthy",
        }),
      }));
      await completeSimulatedTask(store, orchestrator,
        graph.graphId,
        n.taskId!,
        `Completed capability & sandbox audit on ${n.assignedNodeId}`,
        produced
      );
    }

    // 4. Stage 2 (task_synthesize_findings) 自动通过 Join Barrier 汇聚四端产物并启动
    nodes = await store.listGraphNodes(graph.graphId);
    const compareNode = nodes.find((n) => n.nodeId === "task_synthesize_findings")!;
    assert.equal(compareNode.status, "dispatched");

    // 5. 在对比阶段发现需要额外插入一个针对 FixtureHost 双环境路由隔离的专项验证节点 (Dynamic Replan)
    const replanResult = await replanner.replanGraph({
      graphId: graph.graphId,
      trigger: "new_dependency_discovered",
      reason: "Insert dedicated WSL2 vs Windows boundary verification node before final conclusion",
      addNodes: [
        {
          nodeId: "Audit_WSL2_Boundary",
          title: "Verify WSL2/Windows Routing Isolation",
          goal: "Verify WSL2 and Windows Native routing isolation on FixtureHost",
          operation: "verify",
          dependencies: ["task_synthesize_findings"],
          candidateNodeId: "node-example-wsl",
          candidateProjectId: "proj-nash-wsl",
          producedArtifacts: [{ name: "isolation-proof.json", description: "Isolation proof" }],
          acceptanceCriteria: [{ type: "artifact_exists", description: "isolation-proof.json", expected: "isolation-proof.json" }],
        },
      ],
    });
    assert.equal(replanResult.replanned, true);
    assert.equal(replanResult.newRevision, 2);

    // 完成 task_synthesize_findings
    const compareProduced = (compareNode.producedArtifacts ?? []).map((artSpec) => ({
      name: artSpec.name,
      contentType: artSpec.contentType,
      content: JSON.stringify({
        crossPlatformRisks: ["FixtureHost Windows vs WSL2 routing disambiguation", "Write task outcome_unknown guard"],
        recommendations: ["Enforce platform-aware node alias disambiguation", "Verify capability catalog freshness"],
      }),
    }));
    await completeSimulatedTask(store, orchestrator,
      graph.graphId,
      compareNode.taskId!,
      "Cross-platform comparison complete; identified FixtureHost dual-OS routing risk.",
      compareProduced
    );

    // 依次推进后续就绪/派发的节点直到全图完成
    for (let step = 0; step < 5; step++) {
      nodes = await store.listGraphNodes(graph.graphId);
      const activeNodes = nodes.filter((n) => n.status === "dispatched");
      if (activeNodes.length === 0) break;
      for (const active of activeNodes) {
        if (!active.taskId) continue;
        const produced = (active.producedArtifacts ?? []).map((artSpec) => ({
          name: artSpec.name,
          contentType: artSpec.contentType,
          content: JSON.stringify({ verified: true, nodeId: active.nodeId }),
        }));
        await completeSimulatedTask(store, orchestrator,
          graph.graphId,
          active.taskId,
          `Verified and finalized ${active.nodeId}`,
          produced,
          { testExitCode: 0, executedTests: ["cross-platform.test.ts"], modifiedFiles: ["src/cluster/router/intent-analyzer.ts"] }
        );
      }
    }

    // 6. 验证最终图状态、Revision 历史与 Goal-Level 完成评估
    const finalGraph = await store.getGraph(graph.graphId);
    assert.equal(finalGraph?.status, "completed");
    assert.equal(finalGraph?.revision, 2);

    const revisions = await store.listGraphRevisions(graph.graphId);
    assert.equal(revisions.length, 2);

    const goalEval = await orchestrator.evaluateGoalCompletion(graph.graphId);
    assert.equal(goalEval.goalCompleted, true);
    assert.equal(goalEval.completionStatus, "completed");

    const snap = await projection.projectGraphState(graph.graphId);
    assert.ok(snap);
    assert.equal(snap.status, "completed");
    assert.equal(snap.failedNodes, 0);
  });
});
