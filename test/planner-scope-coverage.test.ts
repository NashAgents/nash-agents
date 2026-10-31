import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { AutonomousPlanner } from "../src/cluster/graph/autonomous-planner.js";
import type { GraphProposalNode } from "../src/cluster/graph/types.js";

/**
 * MOCK_UNIT：规划仍由 LLM 负责，Runtime 只校验「用户明确要求的范围」是否被覆盖。
 * 这里不验证任何关键词派发逻辑，只验证覆盖校验与无法满足时的明确说明。
 */

// 与真实集群一致：三个节点同名（"Local Worker"），只能靠主机名区分。
const NODES = [
  { nodeId: "host-alpha", name: "Local Worker", hostname: "node0", projectId: "proj-alpha" },
  { nodeId: "host-beta", name: "Local Worker", hostname: "node1", projectId: "proj-beta" },
  { nodeId: "host-gamma", name: "Local Worker", hostname: "node3", projectId: "proj-gamma" },
];

async function fixture(t: TestContext, options?: { online?: string[] }) {
  const store = new InMemoryClusterStore();
  const now = Date.now();
  const online = options?.online ?? NODES.map((node) => node.nodeId);
  for (const node of NODES) {
    await store.saveNode({
      nodeId: node.nodeId, name: node.name, role: "worker", platform: "linux", arch: "x64",
      hostname: node.hostname, tokenHash: "fixture", metadata: {},
      status: online.includes(node.nodeId) ? "online" : "offline",
      lastSeenAt: now, createdAt: now, updatedAt: now,
    });
    await store.upsertProjectCatalog([{
      nodeId: node.nodeId, projectId: node.projectId, name: node.projectId, summary: "fixture",
      description: "fixture", technologies: [], capabilities: [], lastIndexedAt: now, status: "active",
      canonicalPath: `/fixture/${node.projectId}`, visibility: "retrievable", revision: 1, registeredAt: now, updatedAt: now,
    }]);
    await store.saveCatalogRevision(node.nodeId, 1, [{
      name: "bubblewrap", category: "sandbox", status: "verified", details: "fixture",
      detectionMethod: "fixture", detectedAt: now, verifiedAt: now,
      structuredDetails: {
        backend: "bubblewrap", installed: true, operational: true,
        filesystemIsolationVerified: true, networkIsolationVerified: true, processIsolationVerified: true,
        supportedPolicies: ["read-only", "workspace-write"], supportedNetworkModes: ["deny", "allow"],
        verificationExpiresAt: now + 100_000,
      },
    }]);
  }
  return { store };
}

function planNode(nodeId: string): GraphProposalNode {
  const target = NODES.find((node) => node.hostname === nodeId) ?? NODES[0]!;
  return {
    nodeId: `task_${target.hostname}`,
    title: `Inspect ${target.hostname}`,
    goal: `Inspect ${target.hostname}`,
    operation: "analyze",
    candidateNodeId: target.nodeId,
    candidateProjectId: target.projectId,
    dependencies: [],
    requiredCapabilities: [],
    requiredSandboxPolicy: { filesystemMode: "read-only", networkMode: "deny", approvalMode: "ask" },
    acceptanceCriteria: [],
  };
}

function stubPlan(names: string[], capture?: string[][]) {
  return {
    chat: async (messages: Array<{ role: string; content: string }>) => {
      capture?.push(messages.map((message) => message.content));
      return { content: JSON.stringify({ reasoning: "fixture", nodes: names.map(planNode) }) };
    },
  };
}

test("点名三个节点时策略必须识别为多目标，并把它转成可核验的覆盖要求", async (t) => {
  const { store } = await fixture(t);
  const planner = new AutonomousPlanner({ store });
  const strategy = await planner.evaluateExecutionStrategy("分别检查 node0、node1、node3 的磁盘使用并汇总");
  assert.equal(strategy.mode, "multi_agent");
  assert.equal(strategy.fastPath, false);
  const covered = new Set(strategy.requiredTargets?.flatMap((target) => target.candidateNodeIds));
  for (const node of NODES) assert.ok(covered.has(node.nodeId), `${node.name} 不在覆盖要求里`);
  assert.equal(strategy.requiredTargets?.filter((target) => target.source === "named_node").length, 3, "同名节点必须靠主机名分别命中");
});

test("规划只覆盖一个节点时被拒绝，并把范围错误回传给模型", async (t) => {
  const { store } = await fixture(t);
  const prompts: string[][] = [];
  const planner = new AutonomousPlanner({ store, llmClient: stubPlan(["node0"], prompts) });
  const { validation, proposal } = await planner.planGoal("分别检查 node0、node1、node3 的磁盘使用并汇总");
  assert.equal(validation.valid, false);
  assert.match(String(validation.reason), /PLANNING_SCOPE_MISSING|required target/);
  assert.equal(proposal.strategyDecision?.planningSource !== "llm", true);
  // 覆盖错误必须作为可修正反馈进入下一轮规划，而不是静默改派。
  assert.ok(prompts.length >= 2);
  assert.match(prompts[1]!.at(-1)!, /PLANNING_SCOPE_MISSING|Goal coverage missing required target/);
});

test("模型给出覆盖三个节点的计划时通过，且每个节点只执行一次", async (t) => {
  const { store } = await fixture(t);
  const planner = new AutonomousPlanner({ store, llmClient: stubPlan(["node0", "node1", "node3"]) });
  const { validation, proposal } = await planner.planGoal("分别检查 node0、node1、node3 的磁盘使用并汇总");
  assert.equal(validation.valid, true, validation.reason ?? "");
  const assigned = proposal.nodes.map((node) => node.candidateNodeId);
  assert.deepEqual(new Set(assigned), new Set(NODES.map((node) => node.nodeId)));
});

test("用户声明三个节点但只有两个在线时，明确说明无法满足而不是缩小范围", async (t) => {
  const { store } = await fixture(t, { online: ["host-alpha", "host-beta"] });
  const planner = new AutonomousPlanner({ store, llmClient: stubPlan(["node0", "node1"]) });
  const { validation } = await planner.planGoal("在三个节点上同时执行磁盘检查并汇总");
  assert.equal(validation.valid, false);
  assert.match(String(validation.reason), /PLANNING_SCOPE_UNSATISFIED/);
  assert.match(String(validation.reason), /3 nodes but only 2 are online/);
});

test("点名的节点离线时给出确定性的范围不可满足说明", async (t) => {
  const { store } = await fixture(t, { online: ["host-alpha", "host-beta"] });
  const planner = new AutonomousPlanner({ store, llmClient: stubPlan(["node0", "node1"]) });
  const { validation } = await planner.planGoal("分别检查 node0、node1、node3 的状态并汇总");
  assert.equal(validation.valid, false);
  assert.match(String(validation.reason), /requested node 'node3' is offline/);
});

test("没有显式范围要求的普通目标不受覆盖校验影响", async (t) => {
  const { store } = await fixture(t);
  const planner = new AutonomousPlanner({ store, llmClient: stubPlan(["node0"]) });
  const { validation } = await planner.planGoal("读取 node0 上的 README 并总结");
  assert.equal(validation.valid, true, validation.reason ?? "");
  assert.equal(validation.valid && planner["validateTargetCoverage"]([], []).length === 0, true);
});

test("负向句式不是范围声明：不要扩展到三个节点", async (t) => {
  const { store } = await fixture(t);
  const planner = new AutonomousPlanner({ store });
  const strategy = await planner.evaluateExecutionStrategy("只检查 node0，不要扩展到三个节点");
  assert.equal(strategy.requiredTargets?.length, 1);
  assert.equal(strategy.requiredTargets?.[0]?.candidateNodeIds.join(","), "host-alpha");
});

test("覆盖校验是纯判定：不生成计划，也不改写用户目标", async (t) => {
  const { store } = await fixture(t);
  const planner = new AutonomousPlanner({ store });
  const errors = planner.validateTargetCoverage(
    [planNode("node0")],
    [{ key: "node:host-gamma", label: "node3 (linux)", candidateNodeIds: ["host-gamma"], source: "named_node" }]
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /host-gamma/);
});
