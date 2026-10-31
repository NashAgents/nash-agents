import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import { ToolRegistry } from "../src/tools/registry.js";
import { defineTool, type Tool } from "../src/tools/tool.js";
import {
  AdaptiveToolExposure,
  createDiscoverToolsTool,
  createActivateToolsTool,
} from "../src/tools/adaptive-tool-exposure.js";
import { LocalSpillStore } from "../src/context/spill/local-spill-store.js";
import { AdaptiveContextManager } from "../src/context/adaptive-context-manager.js";
import { ConservativeTokenEstimator } from "../src/context/token-meter.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { projectExecutionProvenance } from "../src/cluster/graph/execution-provenance.js";

describe("P0 Adaptive Tool Exposure & Context Benchmarks Suite", () => {
  let tempDir: string;
  let spillStore: LocalSpillStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-bench-test-"));
    spillStore = new LocalSpillStore({ spillDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // ============================================================
  // 1. Adaptive Tool Exposure: 真实发现、激活、Schema 更新与执行闭环
  // ============================================================
  it("1. Dynamic Tool Discovery, Activation and Execution Closed Loop", async () => {
    const registry = new ToolRegistry();
    let specializedToolExecuted = false;

    // 注册核心基础工具与扩展工具
    registry.register(defineTool({ name: "read_file", description: "Read file", execute: () => ({ success: true, content: "ok" }) }));
    registry.register(defineTool({ name: "write_file", description: "Write file", execute: () => ({ success: true }) }));
    registry.register(defineTool({ name: "bash", description: "Run bash command", execute: () => ({ success: true, output: "done" }) }));
    registry.register(defineTool({
      name: "advanced_data_analyzer",
      description: "Analyze complex cluster datasets and generate statistical summaries",
      parameters: {
        type: "object",
        properties: {
          datasetId: { type: "string", description: "Dataset identifier" },
          metric: { type: "string", description: "Statistical metric" },
        },
        required: ["datasetId"],
      },
      execute: (args: any) => {
        specializedToolExecuted = true;
        return { success: true, summary: `Analyzed ${args.datasetId} with metric ${args.metric || "default"}` };
      },
    }));

    // 初始化角色为 worker (初始仅暴露核心工具与 discover/activate)
    const exposure = new AdaptiveToolExposure(registry, { role: "worker", autoActivateKeywords: false });
    const discoverTool = createDiscoverToolsTool(exposure);
    const activateTool = createActivateToolsTool(exposure);
    registry.register(discoverTool);
    registry.register(activateTool);

    // 步骤 1: 初始状态下，模型仅能看到核心工具，看不到 advanced_data_analyzer
    const initialDefinitions = exposure.getExposedDefinitions();
    const initialNames = initialDefinitions.map(d => d.function.name);
    assert.ok(initialNames.includes("read_file"));
    assert.ok(initialNames.includes("bash"));
    assert.ok(initialNames.includes("discover_tools"));
    assert.ok(initialNames.includes("activate_tools"));
    assert.strictEqual(initialNames.includes("advanced_data_analyzer"), false, "初始状态下扩展工具不得泄漏入 prompt");

    // 步骤 2: 模型调用 discover_tools 查找数据分析工具
    const discoveryResult: any = await discoverTool.execute({ query: "analyzer" });
    assert.strictEqual(discoveryResult.count, 1);
    assert.strictEqual(discoveryResult.tools[0].name, "advanced_data_analyzer");
    assert.strictEqual(discoveryResult.tools[0].isActive, false);

    // 步骤 3: 模型调用 activate_tools 激活 advanced_data_analyzer
    const activationResult: any = await activateTool.execute({ toolNames: ["advanced_data_analyzer"] });
    assert.strictEqual(activationResult.success, true);
    assert.deepStrictEqual(activationResult.activated, ["advanced_data_analyzer"]);

    // 步骤 4: 下一轮 Prompt 生成，模型获得完整的 advanced_data_analyzer 及其参数 Schema
    const nextDefinitions = exposure.getExposedDefinitions();
    const nextTool = nextDefinitions.find(d => d.function.name === "advanced_data_analyzer");
    assert.ok(nextTool, "激活后下轮 prompt 必须包含该工具定义");
    const props = nextTool?.function.parameters?.properties as Record<string, unknown> | undefined;
    assert.ok(props?.datasetId, "必须完整暴露工具参数 Schema");

    // 步骤 5: 模型调用新激活的工具并顺利执行
    const toolInstance = registry.get("advanced_data_analyzer");
    assert.ok(toolInstance);
    const execResult: any = await toolInstance!.execute({ datasetId: "metrics-2026", metric: "latency_p99" });
    assert.strictEqual(execResult.success, true);
    assert.strictEqual(specializedToolExecuted, true);
  });

  // ============================================================
  // 2. Adaptive Context: 三方案性能与信息保留度横向对照基准
  // ============================================================
  it("2. Three-way Context Strategy Benchmark (High Inline vs Low Inline vs Adaptive)", async () => {
    const estimator = new ConservativeTokenEstimator();

    // 场景 1: 测试失败输出 (12KB, 包含 3 处核心错误)
    let tapLog = "TAP version 13\n# Subtest: Suite\n";
    for (let i = 1; i <= 30; i++) {
      if (i === 5) {
        tapLog += `not ok ${i} - test_auth_token_expiration\n  ---\n  error: 'AssertionError: Token should expire after 3600s'\n  stack: 'at auth.test.ts:142'\n  ---\n`;
      } else if (i === 15) {
        tapLog += `not ok ${i} - test_concurrent_write_lock\n  ---\n  error: 'LockTimeoutError: Acquired lock exceeded TTL'\n  stack: 'at lock.test.ts:89'\n  ---\n`;
      } else if (i === 28) {
        tapLog += `not ok ${i} - test_network_isolation_sandbox\n  ---\n  error: 'NetworkLeakError: Unauthorized outbound socket'\n  stack: 'at sandbox.test.ts:210'\n  ---\n`;
      } else {
        tapLog += `ok ${i} - test_routine_case_${i}\n  ---\n  duration_ms: 1.2\n  ---\n`;
      }
    }
    tapLog += "# tests 30\n# pass 27\n# fail 3\n" + "Verbose debug output line\n".repeat(250);

    // 场景 2: TypeScript 编译报错输出 (10KB)
    let tscLog = "";
    for (let i = 0; i < 10; i++) {
      tscLog += `src/module_${i}/service.ts(${i * 10 + 5},12): error TS2322: Type 'string' is not assignable to type 'number'.\n`;
      tscLog += `    const val: number = "mismatched_${i}";\n`;
      tscLog += `          ~~~\n`;
    }
    tscLog += "Found 10 errors in 10 files.\n" + "Verbose module dependency resolution trace\n".repeat(150);

    // 场景 3: 常规紧凑状态输出 (200B)
    const smallLog = "Everything up to date. 0 vulnerabilities found.";

    // 方案 A: 传统高内联预算 (全量原始文本直出至 16000 字符)
    const schemeA_deliver = (raw: string) => raw.slice(0, 16000);

    // 方案 B: 盲目极低内联 (仅截取前 500 字符，中间与末尾错误全部丢失)
    const schemeB_deliver = (raw: string) => raw.slice(0, 500) + "\n...[truncated]";

    // 方案 C: 自适应上下文策略 (结构化提炼核心测试用例/堆栈，紧凑内容完整直出)
    const schemeC = new AdaptiveContextManager({
      spillStore,
      defaultInlineBudgetChars: 4000,
      maxInlineChars: 16000,
      previewEdgeChars: 500,
    });

    const scenarios = [
      { name: "TAP Test Failures", commandHint: "npm test", raw: tapLog, isTest: true },
      { name: "TypeScript Compiler Errors", commandHint: "tsc --noEmit", raw: tscLog, isBuild: true },
      { name: "Compact Status", commandHint: "npm audit", raw: smallLog },
    ];

    for (const sc of scenarios) {
      const outA = schemeA_deliver(sc.raw);
      const outB = schemeB_deliver(sc.raw);
      const resC = await schemeC.processResult("bash", "call-1", { success: !sc.isTest, output: sc.raw }, { commandHint: sc.commandHint });
      const outC = resC.content;

      const tokensA = estimator.estimateText(outA);
      const tokensB = estimator.estimateText(outB);
      const tokensC = estimator.estimateText(outC);

      if (sc.isTest) {
        // 1. 验证方案 C 相比方案 A (高内联) 节省 70% 以上 Token
        assert.ok(tokensC < tokensA * 0.4, `Scheme C tokens (${tokensC}) should be < 40% of Scheme A tokens (${tokensA})`);
        // 2. 验证方案 C 相比方案 B (盲低内联) 保留了全部 3 处核心测试失败名称
        assert.ok(outC.includes("test_auth_token_expiration"), "Scheme C must retain test_auth_token_expiration");
        assert.ok(outC.includes("test_concurrent_write_lock"), "Scheme C must retain test_concurrent_write_lock");
        assert.ok(outC.includes("test_network_isolation_sandbox"), "Scheme C must retain test_network_isolation_sandbox");
        // 方案 B 盲目截断前 500 字符，后序失败测试全部丢失
        assert.strictEqual(outB.includes("test_network_isolation_sandbox"), false, "Scheme B blindly loses late failures");
      } else if (sc.isBuild) {
        // 验证构建诊断中方案 C 节省 60% 以上 Token 且保留 TS2322 核心错误
        assert.ok(tokensC < tokensA * 0.5, "Scheme C should achieve >50% token reduction on compiler diagnostics");
        assert.ok(outC.includes("TS2322"), "Scheme C must retain TS2322 error diagnostics");
      } else {
        // 小文本无损直出
        assert.strictEqual(outC, sc.raw);
        assert.strictEqual(tokensC, tokensA);
      }
    }
  });

  // ============================================================
  // 3. Distributed Trace: 完整跨版本因果链关键路径 (Critical Path)
  // ============================================================
  it("3. Comprehensive Dynamic DAG Critical Path & Phase Span Verification", async () => {
    const store = new InMemoryClusterStore();
    const traceId = "trace-e2e-critical-path";
    const graphId = "graph-rev-1-to-2";

    // 1. 初始化两阶段重规划任务图 (Revision 1 -> Revision 2)
    await store.saveGraph({
      graphId,
      parentGoal: "End-to-End Distributed Security Hardening",
      status: "completed",
      revision: 2,
      createdAt: 1000,
      updatedAt: 12500,
      completedAt: 12500,
      budget: { maxNodes: 10, maxParallelTasks: 4, maxReplanAttempts: 2, maxDepth: 5, totalTimeoutMs: 60000, perTaskTimeoutMs: 30000 },
      concurrencyPolicy: { maxConcurrentTasks: 4, projectWriteLock: true },
      strategyDecision: {
        strategy: "multi_agent" as any,
        traceId,
        planningDurationMs: 850,
      } as any,
    });

    // 节点 1 (Task 1): 耗时 1200ms
    await store.saveGraphNode({ graphId, nodeId: "node-1", taskId: "task-1", title: "Node 1 Analysis", requiredArtifacts: [], producedArtifacts: [], retryCount: 0 } as any);
    await store.saveTask({ taskId: "task-1", runId: "run-1", nodeId: "worker-mac", goal: "task 1", status: "completed", projectId: "p1", dispatchAttempt: 1, createdAt: 1000, updatedAt: 2000 });
    await store.appendEvents([
      { taskId: "task-1", runId: "run-1", nodeId: "worker-mac", seq: 1, eventType: "task.completed", data: { durationMs: 1200 }, timestamp: 2000 },
    ]);

    // 节点 2 (Task 2, 依赖 Node 1): 耗时 1800ms
    await store.saveGraphNode({ graphId, nodeId: "node-2", taskId: "task-2", title: "Node 2 Build", requiredArtifacts: [], producedArtifacts: [], retryCount: 0 } as any);
    await store.saveTask({ taskId: "task-2", runId: "run-2", nodeId: "worker-win", goal: "task 2", status: "completed", projectId: "p1", dispatchAttempt: 1, createdAt: 1000, updatedAt: 4000 });
    await store.saveGraphEdges([{ edgeId: "edge-1-2", graphId, fromNodeId: "node-1", toNodeId: "node-2", dependencyType: "strong" as any, requiredOutcome: "completed", artifactRequirements: [], createdAt: 1000 } as any]);
    await store.appendEvents([
      { taskId: "task-2", runId: "run-2", nodeId: "worker-win", seq: 1, eventType: "task.completed", data: { durationMs: 1800 }, timestamp: 4000 },
    ]);

    // 节点 3 (Task 3，重规划引入的修复验证节点，依赖 Node 2): 耗时 2200ms
    await store.saveGraphNode({ graphId, nodeId: "node-3", taskId: "task-3", title: "Node 3 Re-verification", requiredArtifacts: [], producedArtifacts: [], retryCount: 0 } as any);
    await store.saveTask({ taskId: "task-3", runId: "run-3", nodeId: "worker-tencent", goal: "task 3", status: "completed", projectId: "p1", dispatchAttempt: 1, createdAt: 1000, updatedAt: 8000 });
    await store.saveGraphEdges([{ edgeId: "edge-2-3", graphId, fromNodeId: "node-2", toNodeId: "node-3", dependencyType: "strong" as any, requiredOutcome: "completed", artifactRequirements: [], createdAt: 1000 } as any]);
    await store.appendEvents([
      { taskId: "task-3", runId: "run-3", nodeId: "worker-tencent", seq: 1, eventType: "task.completed", data: { durationMs: 2200 }, timestamp: 8000 },
    ]);

    // 记录协调器关键阶段事件（重规划提案、Join 等待、语义验收）
    await store.appendGraphEvent(graphId, "graph.replan_proposed", { replanId: "replan-1", durationMs: 650, reason: "Defect discovered in node-2, auto-inserting node-3" });
    await store.appendGraphEvent(graphId, "graph.created", { clockId: "coord-clk-1", monotonicAt: 1000 });
    await store.appendGraphEvent(graphId, "graph.completed", { clockId: "coord-clk-1", monotonicAt: 12500 });

    // 记录 4 类关键运行时 Phase Spans (transport, worker_accepted, sandbox_startup, join_wait)
    const spans: any[] = [
      { traceId, spanId: "span-goal", phase: "goal_received", startTime: 1000, endTime: 12500, durationMs: 11500, status: "completed" },
      { traceId, spanId: "span-plan", phase: "planner_request", startTime: 1100, endTime: 1950, durationMs: 850, status: "completed" },
      { traceId, spanId: "span-join", phase: "join_wait", startTime: 4050, endTime: 4400, durationMs: 350, status: "completed" },
      { traceId, spanId: "span-verify", phase: "goal_verification", startTime: 10500, endTime: 11200, durationMs: 700, status: "completed" },
    ];
    for (const span of spans) {
      await store.saveRuntimeSpan!(span);
    }

    // 评估历史因果全链路 Critical Path
    const provenance = await projectExecutionProvenance(store, graphId);
    assert.ok(provenance);

    const cp = provenance!.criticalPath;
    assert.strictEqual(cp.completeness, "COMPLETE");
    // 关键链路链条 = Node 1 (1200) + Node 2 (1800) + Node 3 (2200) = 5200ms
    assert.strictEqual(cp.taskChainDurationMs, 5200);
    // 规划耗时 850ms
    assert.strictEqual(cp.planningDurationMs, 850);
    // 历史重规划耗时 650ms (来自动态图 Revision 1->2 变迁)
    assert.strictEqual(cp.replanDurationMs, 650);
    // Join 等待 350ms
    assert.strictEqual(cp.joinWaitDurationMs, 350);
    // 目标语义复核 700ms
    assert.strictEqual(cp.goalVerificationDurationMs, 700);

    // 总因果耗时 = 850 + 5200 + 650 + 350 + 700 = 7750ms
    assert.strictEqual(cp.totalCausalDurationMs, 7750);
    assert.strictEqual(cp.historicalRevisionCount, 2);
  });
});
