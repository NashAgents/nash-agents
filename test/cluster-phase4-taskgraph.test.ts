import { simulatedSandbox, completeSimulatedTask, recordSimulatedExecution } from "./helpers/runtime-truth-fixtures.js";
import { registerFixtureNodes } from "./helpers/registered-node.js";
/**
 * Nash Cluster Phase 4: Distributed TaskGraph & Cross-Node A2A Tests
 * 完整覆盖：DAG 校验、拓扑分层、自主规划、产物安全交换、分布式邮箱、
 * Join Barrier、失败阻断传播、确定性验收、动态 Replan 与 REST/SSE API
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { DagValidator } from "../src/cluster/graph/dag-validator.js";
import { SimulatedPlanner as AutonomousPlanner } from "./helpers/runtime-truth-fixtures.js";
import { ArtifactService } from "../src/cluster/artifacts/artifact-service.js";
import { DistributedMailbox } from "../src/cluster/a2a/distributed-mailbox.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { ResultVerifier } from "../src/cluster/graph/result-verifier.js";
import { GraphReplanner } from "../src/cluster/graph/graph-replanner.js";
import { GraphStateProjection } from "../src/cluster/graph/graph-state-projection.js";
import { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import type { GraphProposalNode } from "../src/cluster/graph/types.js";

describe("Nash Cluster Phase 4: Distributed TaskGraph & A2A Orchestration", () => {
  let store: InMemoryClusterStore;
  let artifactService: ArtifactService;
  let mailbox: DistributedMailbox;
  let planner: AutonomousPlanner;
  let scheduler: TaskScheduler;
  let orchestrator: DistributedGraphOrchestrator;
  let verifier: ResultVerifier;
  let replanner: GraphReplanner;
  let projection: GraphStateProjection;
  let tempArtifactDir: string;

  before(async () => {
    store = new InMemoryClusterStore();
    await registerFixtureNodes(store, "test-node", "node-mac", "node-wsl2", "node-tencent", "node-remote", "test-coordinator");
    tempArtifactDir = path.join(os.tmpdir(), `nash-test-artifacts-${Date.now()}`);
    fs.mkdirSync(tempArtifactDir, { recursive: true });

    artifactService = new ArtifactService(store, tempArtifactDir);
    mailbox = new DistributedMailbox(store, "test-coordinator");
    planner = new AutonomousPlanner();

    const registry = new NodeRegistry(store, new InviteManager());
    scheduler = new TaskScheduler(store, registry, "test-coordinator");
    orchestrator = new DistributedGraphOrchestrator({
      store,
      scheduler,
      artifactService,
      validator: { validateCandidate: async () => ({ valid: true, code: "VALID", reason: "Unit-test validated target" }) },
    });
    verifier = new ResultVerifier(store, artifactService);
    replanner = new GraphReplanner(store, orchestrator);
    projection = new GraphStateProjection(store);
  });

  after(() => {
    try {
      fs.rmSync(tempArtifactDir, { recursive: true, force: true });
    } catch {}
  });

  // ============================================================
  // 1. DAG 校验与拓扑分析测试
  // ============================================================
  describe("1. DAG Validation & Topological Sorting", () => {
    test("1.1 校验合法 DAG 并正确输出拓扑序与并行阶段", () => {
      const nodes: GraphProposalNode[] = [
        { nodeId: "A", title: "Task A", goal: "Goal A", dependencies: [] },
        { nodeId: "B", title: "Task B", goal: "Goal B", dependencies: [] },
        { nodeId: "C", title: "Task C", goal: "Goal C", dependencies: ["A", "B"] },
        { nodeId: "D", title: "Task D", goal: "Goal D", dependencies: ["C"] },
      ];

      const res = DagValidator.validateProposal(nodes);
      assert.equal(res.valid, true);
      assert.deepEqual(res.parallelStages, [["A", "B"], ["C"], ["D"]]);
      assert.equal(res.topologicalOrder?.includes("C"), true);
      assert.ok(res.topologicalOrder!.indexOf("A") < res.topologicalOrder!.indexOf("C"));
      assert.ok(res.topologicalOrder!.indexOf("B") < res.topologicalOrder!.indexOf("C"));
      assert.ok(res.topologicalOrder!.indexOf("C") < res.topologicalOrder!.indexOf("D"));
    });

    test("1.2 准确检测有向环 (Cycle Detection)", () => {
      const cycleNodes: GraphProposalNode[] = [
        { nodeId: "A", title: "Task A", goal: "Goal A", dependencies: ["C"] },
        { nodeId: "B", title: "Task B", goal: "Goal B", dependencies: ["A"] },
        { nodeId: "C", title: "Task C", goal: "Goal C", dependencies: ["B"] },
      ];

      const res = DagValidator.validateProposal(cycleNodes);
      assert.equal(res.valid, false);
      assert.match(res.reason!, /DAG Cycle detected/);
      assert.ok(res.cyclesDetected!.length >= 3);
    });

    test("1.3 拦截自依赖 (Self Dependency)", () => {
      const selfNodes: GraphProposalNode[] = [
        { nodeId: "A", title: "Task A", goal: "Goal A", dependencies: ["A"] },
      ];
      const res = DagValidator.validateProposal(selfNodes);
      assert.equal(res.valid, false);
      assert.match(res.reason!, /cannot depend on itself/);
    });

    test("1.4 拦截引用不存在的前置依赖 (Missing Dependency)", () => {
      const missingNodes: GraphProposalNode[] = [
        { nodeId: "A", title: "Task A", goal: "Goal A", dependencies: ["non_existent_task"] },
      ];
      const res = DagValidator.validateProposal(missingNodes);
      assert.equal(res.valid, false);
      assert.match(res.reason!, /references non-existent node/);
    });

    test("1.5 产物依赖闭环验证：前置必须声明产生该产物", () => {
      const invalidArtifactNodes: GraphProposalNode[] = [
        { nodeId: "A", title: "Task A", goal: "Goal A", dependencies: [], producedArtifacts: [] },
        {
          nodeId: "B",
          title: "Task B",
          goal: "Goal B",
          dependencies: ["A"],
          requiredArtifacts: [{ name: "missing_file.srt", producerNodeId: "A" }],
        },
      ];
      const res = DagValidator.validateProposal(invalidArtifactNodes);
      assert.equal(res.valid, false);
      assert.match(res.reason!, /does not declare producing it/);
    });

    test("1.6 预算熔断：超出最大节点数或深度时拦截", () => {
      const deepNodes: GraphProposalNode[] = [
        { nodeId: "1", title: "T1", goal: "G1", dependencies: [] },
        { nodeId: "2", title: "T2", goal: "G2", dependencies: ["1"] },
        { nodeId: "3", title: "T3", goal: "G3", dependencies: ["2"] },
        { nodeId: "4", title: "T4", goal: "G4", dependencies: ["3"] },
      ];
      const res = DagValidator.validateProposal(deepNodes, { maxDepth: 2 });
      assert.equal(res.valid, false);
      assert.match(res.reason!, /exceeds maximum depth limit/);
    });
  });

  // ============================================================
  // 2. 自主任务规划 (Autonomous Task Planner) 测试
  // ============================================================
  describe("2. Autonomous Task Planner", () => {
    test("2.1 简单单目标触发 Single Task Fast Path", async () => {
      const { proposal, validation } = await planner.planGoal("查看腾讯云 Node.js 版本");
      assert.equal(proposal.requiresMultiAgent, false);
      assert.equal(proposal.nodes.length, 1);
      assert.equal(validation.valid, true);
    });

    test("2.2 协调器提供显式语义 DAG 后验证 Join Barrier 与产物", async () => {
      const goal = "从 Bilibili 提取视频字幕并导入字幕阅读项目，修复兼容问题并执行测试";
      const { proposal, validation } = await planner.planGoal(goal, undefined, [
        { nodeId: "task_subtitle_extract", title: "extract", goal: "extract", dependencies: [], producedArtifacts: [{ name: "video_subtitles.srt", contentType: "text/plain" }] },
        { nodeId: "task_project_inspect", title: "inspect", goal: "inspect", dependencies: [], producedArtifacts: [{ name: "project_analysis.json", contentType: "application/json" }] },
        { nodeId: "task_plan_import", title: "plan", goal: "plan", dependencies: ["task_subtitle_extract", "task_project_inspect"], dependencyType: "join", requiredArtifacts: [{ name: "video_subtitles.srt", producerNodeId: "task_subtitle_extract" }, { name: "project_analysis.json", producerNodeId: "task_project_inspect" }] },
        { nodeId: "task_execute_import", title: "import", goal: "import", dependencies: ["task_plan_import"] },
        { nodeId: "task_verify_and_test", title: "verify", goal: "verify", dependencies: ["task_execute_import"] },
      ]);

      assert.equal(proposal.requiresMultiAgent, true);
      assert.equal(validation.valid, true);
      assert.equal(proposal.nodes.length, 5);

      const taskA = proposal.nodes.find((n) => n.nodeId === "task_subtitle_extract");
      const taskB = proposal.nodes.find((n) => n.nodeId === "task_project_inspect");
      const taskC = proposal.nodes.find((n) => n.nodeId === "task_plan_import");
      const taskD = proposal.nodes.find((n) => n.nodeId === "task_execute_import");
      const taskE = proposal.nodes.find((n) => n.nodeId === "task_verify_and_test");

      assert.ok(taskA && taskB && taskC && taskD && taskE);

      // Task A 与 Task B 无依赖，应在第一阶段并行
      assert.deepEqual(taskA.dependencies, []);
      assert.deepEqual(taskB.dependencies, []);
      assert.deepEqual(validation.parallelStages?.[0], ["task_subtitle_extract", "task_project_inspect"]);

      // Task C 构成 Join Barrier，同时依赖 A 和 B
      assert.deepEqual(taskC.dependencies, ["task_subtitle_extract", "task_project_inspect"]);
      assert.equal(taskC.dependencyType, "join");

      // 产物声明验证
      assert.equal(taskA.producedArtifacts?.[0].name, "video_subtitles.srt");
      assert.equal(taskB.producedArtifacts?.[0].name, "project_analysis.json");
      assert.equal(taskC.requiredArtifacts?.length, 2);
    });
  });

  // ============================================================
  // 3. 产物安全交换服务 (Artifact Exchange Service) 测试
  // ============================================================
  describe("3. Artifact Exchange Service", () => {
    test("3.1 产物物理安全落盘、计算 SHA256 与元数据持久化", async () => {
      const content = "1\n00:00:01,000 --> 00:00:04,000\nHello Nash Cluster!\n";
      const artifact = await artifactService.publishArtifact({
        graphId: "test-graph-1",
        producerTaskId: "task-1",
        producerNodeId: "node-mac",
        name: "test_subtitles.srt",
        contentType: "text/plain",
        content,
      });

      assert.ok(artifact.artifactId.startsWith("art-"));
      assert.equal(artifact.sizeBytes, Buffer.byteLength(content));
      assert.equal(artifact.status, "available");
      assert.ok(fs.existsSync(artifact.storagePath));
    });

    test("3.2 严格防范 ../ 目录逃逸与危险符号", async () => {
      const artifact = await artifactService.publishArtifact({
        graphId: "test-graph-1",
        producerTaskId: "task-1",
        producerNodeId: "node-mac",
        name: "../../../etc/passwd",
        content: "malicious payload",
      });

      assert.ok(!artifact.storagePath.includes("etc/passwd"));
      assert.ok(path.basename(artifact.storagePath).startsWith("passwd") || path.basename(artifact.storagePath).startsWith("artifact_"));
    });

    test("3.3 授权访问控制：未获授权读取产物抛出 Access Denied", async () => {
      const art = await artifactService.publishArtifact({
        graphId: "test-graph-sec",
        producerTaskId: "task-producer",
        producerNodeId: "node-producer",
        name: "secret.json",
        content: JSON.stringify({ secret: "classified" }),
      });

      // 未授权访问测试
      await assert.rejects(
        async () => {
          await artifactService.readArtifactContent(art.artifactId, "unauthorized-node", "other-task");
        },
        /Access denied/
      );

      // 显式授权后读取成功并校验 SHA256
      await artifactService.grantAccess(art.artifactId, "test-graph-sec", "authorized-node", "consumer-task");
      const readRes = await artifactService.readArtifactContent(art.artifactId, "authorized-node", "consumer-task");
      assert.equal(readRes.record.sha256, art.sha256);
      assert.equal(readRes.data.toString(), JSON.stringify({ secret: "classified" }));
    });

    test("3.4 支持分片流式读取 (Chunked Transfer)", async () => {
      const largeContent = "A".repeat(1024 * 600); // 600KB
      const art = await artifactService.publishArtifact({
        graphId: "test-graph-chunk",
        producerTaskId: "task-chunk",
        producerNodeId: "node-1",
        name: "large_data.bin",
        content: largeContent,
      });

      const chunk0 = await artifactService.readArtifactChunk(art.artifactId, 0, 256 * 1024);
      assert.equal(chunk0.chunkIndex, 0);
      assert.equal(chunk0.isLast, false);
      assert.equal(chunk0.totalChunks, 3);

      const chunk2 = await artifactService.readArtifactChunk(art.artifactId, 2, 256 * 1024);
      assert.equal(chunk2.chunkIndex, 2);
      assert.equal(chunk2.isLast, true);
    });
  });

  // ============================================================
  // 4. 分布式邮箱与跨节点 A2A 通信测试
  // ============================================================
  describe("4. Distributed Mailbox & Cross-Node A2A", () => {
    test("4.1 严格限制在同一 Graph 作用域，无 graphId 拒绝发送", async () => {
      await assert.rejects(
        async () => {
          await mailbox.sendMessage({
            graphId: "",
            sourceNodeId: "node-a",
            sourceAgentId: "agent-1",
            targetNodeId: "node-b",
            targetAgentId: "agent-2",
            payload: { text: "hello" },
          });
        },
        /Security Violation/
      );
    });

    test("4.2 拦截消息伪造系统审批或沙箱越权标记", async () => {
      await assert.rejects(
        async () => {
          await mailbox.sendMessage({
            graphId: "graph-1",
            sourceNodeId: "node-a",
            sourceAgentId: "agent-1",
            targetNodeId: "node-b",
            targetAgentId: "agent-2",
            payload: { isSystemApproval: true },
          });
        },
        /Security Violation/
      );
    });

    test("4.3 本地与入站消息可靠投递、Inbox 幂等去重与 ACK", async () => {
      const graph = await orchestrator.createGraph({ parentGoal: "mailbox", reasoning: "test", requiresMultiAgent: true, nodes: [
        { nodeId: "sender", title: "sender", goal: "sender", candidateNodeId: "node-remote", candidateProjectId: "p" },
        { nodeId: "receiver", title: "receiver", goal: "receiver", candidateNodeId: "test-coordinator", candidateProjectId: "p" },
      ] });
      const msg = await mailbox.sendMessage({
        graphId: graph.graphId,
        sourceNodeId: "node-remote",
        sourceAgentId: "agent-sender",
        targetNodeId: "test-coordinator",
        targetAgentId: "agent-receiver",
        payload: { text: "Please review project layout" },
      });

      assert.equal(msg.deliveryStatus, "delivered");

      // 模拟接收端 ACK
      await mailbox.acknowledge(msg.messageId);
      const saved = await store.getAgentMessage?.(msg.messageId);
      assert.equal(saved.deliveryStatus, "acknowledged");
    });
  });

  // ============================================================
  // 5. 分布式任务图编排器 (Graph Orchestrator) 测试
  // ============================================================
  describe("5. Distributed Graph Orchestrator Execution Flow", () => {
    let testGraphId: string;

    test("5.1 创建并启动任务图，首批无前置依赖的任务原子跃迁为 dispatched", async () => {
      const proposal = {
        parentGoal: "测试并行分支汇聚与串行推进",
        reasoning: "Test DAG execution",
        requiresMultiAgent: true,
        nodes: [
          { nodeId: "A", title: "Task A", goal: "Goal A", candidateNodeId: "test-node", candidateProjectId: "test-project", operation: "analyze" as const, dependencies: [] },
          { nodeId: "B", title: "Task B", goal: "Goal B", candidateNodeId: "test-node", candidateProjectId: "test-project", operation: "analyze" as const, dependencies: [] },
          { nodeId: "C", title: "Task C", goal: "Goal C", candidateNodeId: "test-node", candidateProjectId: "test-project", operation: "analyze" as const, dependencies: ["A", "B"], dependencyType: "join" as const },
        ],
      };

      const graph = await orchestrator.createGraph(proposal);
      testGraphId = graph.graphId;
      assert.equal(graph.status, "ready");

      const started = await orchestrator.startGraph(testGraphId);
      assert.equal(started.status, "running");

      const nodes = await store.listGraphNodes(testGraphId);
      const nodeA = nodes.find((n) => n.nodeId === "A")!;
      const nodeB = nodes.find((n) => n.nodeId === "B")!;
      const nodeC = nodes.find((n) => n.nodeId === "C")!;

      // A 和 B 应进入 dispatched，C 依然等待依赖
      assert.equal(nodeA.status, "dispatched");
      assert.equal(nodeB.status, "dispatched");
      assert.equal(nodeC.status, "waiting_dependencies");
    });

    test("5.2 Join Barrier: 仅当 A 和 B 全部完成时，C 才被调度一次", async () => {
      const nodesBefore = await store.listGraphNodes(testGraphId);
      const nodeA = nodesBefore.find((n) => n.nodeId === "A")!;
      const nodeB = nodesBefore.find((n) => n.nodeId === "B")!;

      // A 完成
      await completeSimulatedTask(store, orchestrator, testGraphId, nodeA.taskId!, "Task A finished successfully");
      let nodesMid = await store.listGraphNodes(testGraphId);
      let nodeC = nodesMid.find((n) => n.nodeId === "C")!;
      // 只有 A 完成，B 还在运行，C 不能提前调度！
      assert.equal(nodeC.status, "waiting_dependencies");

      // B 完成 -> Join Barrier 达成！
      await completeSimulatedTask(store, orchestrator, testGraphId, nodeB.taskId!, "Task B finished successfully");
      const nodesAfter = await store.listGraphNodes(testGraphId);
      nodeC = nodesAfter.find((n) => n.nodeId === "C")!;
      // C 原子被激活并进入 dispatched
      assert.equal(nodeC.status, "dispatched");
    });

    test("5.3 终态收敛：最后一个节点完成，整图自动标记为 completed", async () => {
      const nodes = await store.listGraphNodes(testGraphId);
      const nodeC = nodes.find((n) => n.nodeId === "C")!;

      await completeSimulatedTask(store, orchestrator, testGraphId, nodeC.taskId!, "Task C finished");
      const finalGraph = await store.getGraph(testGraphId);
      assert.equal(finalGraph?.status, "completed");
      assert.ok(finalGraph?.completedAt);
    });

    test("5.3b 真实多节点 Join Barrier 与产物传递闭环: Mac与WSL2产生真实产物 -> Barrier触发Tencent任务 -> 消费产物 -> 全图完成", async () => {
      const proposal = {
        parentGoal: "多节点产物汇聚与真实消费验证",
        reasoning: "Test Multi-node Artifact Barrier",
        requiresMultiAgent: true,
        nodes: [
          {
            nodeId: "Mac-Subtitles",
            title: "Mac提取字幕",
            goal: "Extract subtitles",
            operation: "execute" as const,
            candidateNodeId: "node-mac",
            candidateProjectId: "proj-mac",
            dependencies: [],
            producedArtifacts: [{ name: "subtitles.json", contentType: "application/json" }],
          },
          {
            nodeId: "WSL2-Analysis",
            title: "WSL2分析词频",
            goal: "Analyze word frequencies",
            operation: "analyze" as const,
            candidateNodeId: "node-wsl2",
            candidateProjectId: "proj-wsl2",
            dependencies: [],
            producedArtifacts: [{ name: "word_stats.json", contentType: "application/json" }],
          },
          {
            nodeId: "Tencent-Summary",
            title: "腾讯云合并报表",
            goal: "Combine subtitles and word stats into report",
            operation: "execute" as const,
            candidateNodeId: "node-tencent",
            candidateProjectId: "proj-tencent",
            dependencies: ["Mac-Subtitles", "WSL2-Analysis"],
            dependencyType: "artifact" as const,
            requiredArtifacts: [
              { name: "subtitles.json", producerNodeId: "Mac-Subtitles" },
              { name: "word_stats.json", producerNodeId: "WSL2-Analysis" },
            ],
          },
        ],
      };

      const g = await orchestrator.createGraph(proposal);
      await orchestrator.startGraph(g.graphId);

      let nodes = await store.listGraphNodes(g.graphId);
      const macNode = nodes.find((n) => n.nodeId === "Mac-Subtitles")!;
      const wslNode = nodes.find((n) => n.nodeId === "WSL2-Analysis")!;
      let tencentNode = nodes.find((n) => n.nodeId === "Tencent-Summary")!;

      assert.equal(macNode.status, "dispatched");
      assert.equal(wslNode.status, "dispatched");
      assert.equal(tencentNode.status, "waiting_dependencies");

      // 1. Mac 完成并产生产物
      await completeSimulatedTask(store, orchestrator, g.graphId, macNode.taskId!, "Mac finished subtitles", [
        { name: "subtitles.json", contentType: "application/json", content: JSON.stringify({ lines: 42 }) },
      ]);

      // 此时 WSL2 还在执行，Tencent-Summary 依然处于 waiting_dependencies
      nodes = await store.listGraphNodes(g.graphId);
      tencentNode = nodes.find((n) => n.nodeId === "Tencent-Summary")!;
      assert.equal(tencentNode.status, "waiting_dependencies");

      // 2. WSL2 完成并产生产物 -> 触发 Join Barrier!
      await completeSimulatedTask(store, orchestrator, g.graphId, wslNode.taskId!, "WSL2 finished stats", [
        { name: "word_stats.json", contentType: "application/json", content: JSON.stringify({ uniqueWords: 256 }) },
      ]);

      // Join Barrier 达成！Tencent-Summary 自动跃迁为 dispatched
      nodes = await store.listGraphNodes(g.graphId);
      tencentNode = nodes.find((n) => n.nodeId === "Tencent-Summary")!;
      assert.equal(tencentNode.status, "dispatched");
      assert.ok(tencentNode.taskId);

      // 3. 验证产物已经被正确授权给 Tencent Task
      const arts = await store.listArtifacts?.(g.graphId) ?? [];
      assert.equal(arts.length, 2);
      const subArt = arts.find((a) => a.name === "subtitles.json")!;
      const statArt = arts.find((a) => a.name === "word_stats.json")!;

      // 4. 模拟 Tencent Task 真实消费两份前置产物
      const readSub = await artifactService.readArtifactContent(subArt.artifactId, "node-tencent", tencentNode.taskId!);
      assert.equal(JSON.parse(readSub.data.toString()).lines, 42);

      const readStat = await artifactService.readArtifactContent(statArt.artifactId, "node-tencent", tencentNode.taskId!);
      assert.equal(JSON.parse(readStat.data.toString()).uniqueWords, 256);

      // 5. Tencent Task 汇报完成
      await completeSimulatedTask(store, orchestrator, g.graphId, tencentNode.taskId!, "Report merged successfully");

      // 6. 验证全图达到终态 completed
      const finalGraph = await store.getGraph(g.graphId);
      assert.equal(finalGraph?.status, "completed");
      assert.match(finalGraph?.finalSummary!, /All 3 tasks completed successfully/);

      // 7. 投影快照确认
      const snap = await projection.projectGraphState(g.graphId);
      assert.ok(snap);
      assert.equal(snap.completedNodes, 3);
      assert.equal(snap.runningNodes, 0);
      assert.equal(snap.totalNodes, 3);
    });

    test("5.4 失败阻断传播 (block_dependents)：前置失败，后继被标记为 blocked", async () => {
      const proposal = {
        parentGoal: "测试失败阻断",
        reasoning: "Test Failure Propagation",
        requiresMultiAgent: true,
        nodes: [
          { nodeId: "F1", title: "Fail Task", goal: "Fail", dependencies: [], failurePolicy: "block_dependents" as const },
          { nodeId: "F2", title: "Dependent Task", goal: "Dep", dependencies: ["F1"] },
        ],
      };

      const g = await orchestrator.createGraph(proposal);
      await orchestrator.startGraph(g.graphId);

      const nodes = await store.listGraphNodes(g.graphId);
      const f1 = nodes.find((n) => n.nodeId === "F1")!;

      // 注入 F1 失败
      await orchestrator.handleNodeTaskFailed(g.graphId, f1.taskId!, "Compiler error in F1");

      const nodesAfter = await store.listGraphNodes(g.graphId);
      const f2 = nodesAfter.find((n) => n.nodeId === "F2")!;
      assert.equal(f2.status, "blocked");
      assert.match(f2.error!, /upstream failure of 'F1'/);
    });

    test("5.5 图取消传播 (Cancel Graph)：停止新调度并向运行中的任务发送取消", async () => {
      const proposal = {
        parentGoal: "测试图取消",
        reasoning: "Test Graph Cancel",
        requiresMultiAgent: true,
        nodes: [
          { candidateNodeId: "test-node", candidateProjectId: "test-project", nodeId: "C1", title: "Running Task", goal: "Run", dependencies: [] },
          { candidateNodeId: "test-node", candidateProjectId: "test-project", nodeId: "C2", title: "Waiting Task", goal: "Wait", dependencies: ["C1"] },
        ],
      };

      const g = await orchestrator.createGraph(proposal);
      await orchestrator.startGraph(g.graphId);
      await orchestrator.cancelGraph(g.graphId, "User requested cancellation");

      const gAfter = await store.getGraph(g.graphId);
      assert.equal(gAfter?.status, "cancelled");

      const nodesAfter = await store.listGraphNodes(g.graphId);
      for (const n of nodesAfter) {
        assert.equal(n.status, "cancelled");
      }
    });
  });

  // ============================================================
  // 6. 确定性验收与反馈 (Result Verifier) 测试
  // ============================================================
  describe("6. Result Verification & Acceptance Criteria", () => {
    test("6.1 拦截未授权的 MCP 依赖 (needs_auth 阻断并严禁假装成功)", async () => {
      // 在 Catalog 中注入 needs_auth 的 MCP
      await store.upsertMCPCatalog([
        {
          serverId: "bilibili-subtitles",
          nodeId: "node-mac",
          displayName: "bilibili-subtitles",
          transportType: "streamable-http",
          status: "needs_auth",
          capabilitySummary: "Bilibili Subtitles (needs auth)",
          tools: [],
          resourceCount: 0,
          promptCount: 0,
          lastVerifiedAt: Date.now(),
          revision: 1,
        },
      ]);

      const outcome = await verifier.verifyNode({
        graphId: "test-graph-verify",
        graphNodeId: "task_subtitle",
        taskId: "task-sub-1",
        acceptanceCriteria: [{ type: "artifact_exists", description: "subtitles.srt exists" }],
        requiredCapabilities: ["mcp:bilibili-subtitles"],
      });

      assert.equal(outcome.status, "needs_auth");
      assert.match(outcome.message, /requires authentication \(needs_auth\)/);
    });

    test("6.2 测试退出码非 0 时判定为 FAILED", async () => {
      const outcome = await verifier.verifyNode({
        graphId: "test-graph-testcode",
        graphNodeId: "task_test",
        taskId: "task-test-1",
        acceptanceCriteria: [{ type: "test_exit_code", description: "Must exit 0", expected: 0 }],
        testExitCode: 1, // 失败退出码
      });

      assert.equal(outcome.status, "failed");
      assert.match(outcome.message, /Anti-spoofing|expected 0, got 1/);
    });
  });

  // ============================================================
  // 7. 自省与动态重新规划 (Dynamic Replanner) 测试
  // ============================================================
  describe("7. Reflection & Dynamic Replanning", () => {
    test("7.1 验证失败自动生成 Graph Revision 2，增补 Fix 与 Retest 节点", async () => {
      const proposal = {
        parentGoal: "测试自愈 Replan",
        reasoning: "Test Auto Replan",
        requiresMultiAgent: true,
        nodes: [
          { nodeId: "T1", title: "Compile", goal: "Compile", dependencies: [] },
          { nodeId: "T2", title: "Test Suite", goal: "Run Tests", dependencies: ["T1"] },
        ],
      };

      const g = await orchestrator.createGraph(proposal);
      await orchestrator.startGraph(g.graphId);

      // 触发因测试失败的 Replan
      const replanRes = await replanner.replanGraph({
        graphId: g.graphId,
        trigger: "verification_failed",
        reason: "Test exit code 1: Assertion failed in parseSubtitle",
        failedNodeId: "T2",
        addNodes: [{ nodeId: "fix", title: "Simulated fix", goal: "Fix" }, { nodeId: "retest", title: "Simulated retest", goal: "Retest", dependencies: ["fix"] }],
      });

      assert.equal(replanRes.success, true);
      assert.equal(replanRes.newRevision, 2);
      assert.equal(replanRes.addedNodeIds.length, 2);

      const revisions = await store.listGraphRevisions(g.graphId);
      assert.equal(revisions.length, 2);
      assert.equal(revisions[1].revision, 2);
      assert.match(revisions[1].reason, /Assertion failed/);

      const nodes = await store.listGraphNodes(g.graphId);
      assert.equal(nodes.length, 4); // 原有 2 个 + 增补 Fix + 增补 Retest
    });

    test("7.2 Steer 调整：指示不修改代码时，自动跳过未执行的写任务", async () => {
      const proposal = {
        parentGoal: "测试 Steer 跳过写操作",
        reasoning: "Test Steer",
        requiresMultiAgent: true,
        nodes: [
          { nodeId: "S1", title: "Analyze", goal: "Analyze", operation: "analyze" as const, dependencies: [] },
          { nodeId: "S2", title: "Modify Code", goal: "Write", operation: "execute" as const, dependencies: ["S1"] },
        ],
      };

      const g = await orchestrator.createGraph(proposal);
      await orchestrator.startGraph(g.graphId);

      // 用户注入 Steer
      const replanRes = await replanner.replanGraph({
        graphId: g.graphId,
        trigger: "steer",
        reason: "User steer: 先不要修改代码，只给我输出分析报告",
        steerInstruction: "先不要修改代码，只给我输出分析报告",
      });

      assert.equal(replanRes.success, true);
      const nodes = await store.listGraphNodes(g.graphId);
      const s2 = nodes.find((n) => n.nodeId === "S2")!;
      assert.equal(s2.status, "skipped");
    });
  });

  // ============================================================
  // 8. 任务图状态投影 (Graph State Projection) 测试
  // ============================================================
  describe("8. Graph State Projection", () => {
    test("8.1 确定性计算图快照与当前阶段描述", async () => {
      const proposal = {
        parentGoal: "测试快照投影",
        reasoning: "Projection test",
        requiresMultiAgent: true,
        nodes: [
          { candidateNodeId: "test-node", candidateProjectId: "test-project", nodeId: "P1", title: "Task 1", goal: "G1", operation: "analyze" as const, dependencies: [] },
          { candidateNodeId: "test-node", candidateProjectId: "test-project", nodeId: "P2", title: "Task 2", goal: "G2", operation: "analyze" as const, dependencies: ["P1"] },
        ],
      };

      const g = await orchestrator.createGraph(proposal);
      await orchestrator.startGraph(g.graphId);

      const snapshot = await projection.projectGraphState(g.graphId);
      assert.ok(snapshot);
      assert.equal(snapshot.graphId, g.graphId);
      assert.equal(snapshot.totalNodes, 2);
      assert.equal(snapshot.runningNodes, 1);
      assert.equal(snapshot.waitingNodes, 1);
      assert.match(snapshot.currentPhase, /Executing: Task 1/);
    });
  });
});
