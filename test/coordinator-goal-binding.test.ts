import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { CoordinatorMainAgent } from "../src/cluster/coordinator/main-agent/coordinator-main-agent.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import { DispatchClusterTaskTool, RunDistributedTaskGraphTool } from "../src/cluster/tools/cluster-tools.js";
import type { runAgentLoop } from "../src/runtime/agent-loop.js";
import { setTimeout as delay } from "node:timers/promises";

type Loop = typeof runAgentLoop;
const execute = async (options: NonNullable<Parameters<Loop>[1]>, name: string, args: Record<string, unknown>) =>
  await options.registry!.get(name)!.execute(args) as Record<string, any>;
function setup(t: TestContext, agentLoop: Loop, graphExecute: (...args: any[]) => Promise<any>) {
  const store = new InMemoryClusterStore();
  const calls = { graph: 0, standalone: 0 };
  t.mock.method(RunDistributedTaskGraphTool.prototype, "execute", async function(this: any, args: any) {
    calls.graph++;
    return graphExecute.call(this, args);
  });
  t.mock.method(DispatchClusterTaskTool.prototype, "execute", async () => {
    calls.standalone++;
    return { success: true, taskId: "single-task", finalAnswer: "One branch completed." };
  });
  t.mock.method(store, "getTask", async () => ({ taskId: "single-task", status: "completed" } as any));
  const agent = new CoordinatorMainAgent({
    store, registry: new NodeRegistry(store, new InviteManager()),
    searchService: {} as any, discoveryService: {} as any, semanticRouter: {} as any,
    planner: {} as any,
    orchestrator: { evaluateGoalCompletion: async () => ({ completionStatus: "partially_completed" }) } as any,
    modelConfigOverride: { baseUrl: "http://unused.invalid", apiKey: "mock-only", model: "mock-only" },
    agentLoop,
  });
  return { agent, calls, store };
}

test("MOCK_UNIT: rejected graph planning cannot fall back to standalone completion or a false completed goal", async t => {
  const { agent, calls } = setup(t, async (_input, options) => {
    const graph = await execute(options!, "run_distributed_task_graph", { goal: "rewritten goal" });
    assert.equal(graph.success, false);
    const single = await execute(options!, "dispatch_cluster_task", { goal: "one branch" });
    assert.equal(single.success, false);
    return "All requested environments have completed.";
  }, async function(args) {
    assert.equal(args.goal, "Check all four platforms");
    return { success: false, error: "Required worker is offline" };
  });
  const result = await agent.chat("mock-rejected-plan", "Check all four platforms");
  assert.equal(calls.graph, 1);
  assert.equal(calls.standalone, 0);
  assert.equal(result.state, "incomplete");
  assert.equal(result.goalCompletionStatus, "incomplete");
  assert.match(result.assistantResponse, /目标尚未完成/);
});

test("MOCK_UNIT: an existing graph cannot be replaced by a new graph to bypass its failed history", async t => {
  const { agent, calls } = setup(t, async (_input, options) => {
    assert.equal((await execute(options!, "run_distributed_task_graph", { goal: "original" })).graphId, "bound-graph");
    const replacement = await execute(options!, "run_distributed_task_graph", { goal: "replacement" });
    assert.equal(replacement.success, false);
    assert.match(replacement.error, /replan_distributed_task_graph/);
    return "The second graph passed.";
  }, async function(this: any) {
    this.onGraphCreated("bound-graph", { goal: "original", nodeCount: 3 });
    return { success: false, graphId: "bound-graph", goalEvaluation: { completionStatus: "partially_completed" } };
  });
  const result = await agent.chat("mock-bound-graph", "Check all platforms");
  assert.equal(calls.graph, 1);
  assert.equal(result.createdGraphId, "bound-graph");
  assert.equal(result.state, "partially_completed");
});

test("MOCK_UNIT: concurrent graph calls share the goal binding before graph persistence finishes", async t => {
  const { agent, calls } = setup(t, async (_input, options) => {
    const results = await Promise.all([execute(options!, "run_distributed_task_graph", { goal: "first" }), execute(options!, "run_distributed_task_graph", { goal: "duplicate" })]);
    assert.equal(results.filter(r => r.success === false).length, 1);
    return "One graph executed.";
  }, async function(this: any) {
    await Promise.resolve();
    this.onGraphCreated("bound-graph", { goal: "original", nodeCount: 3 });
    return { success: true, graphId: "bound-graph" };
  });
  await agent.chat("mock-concurrent-graph", "Check all platforms");
  assert.equal(calls.graph, 1);
});

test("MOCK_UNIT: a genuine single-node goal still uses standalone execution", async t => {
  const { agent, calls } = setup(t, async (_input, options) => {
    const result = await execute(options!, "dispatch_cluster_task", { goal: "one worker" });
    await options!.onToolCallEnd?.("dispatch_cluster_task", { success: true, output: JSON.stringify(result) });
    return "The worker finished.";
  }, async () => ({ success: false }));
  const result = await agent.chat("mock-single-node", "Inspect one worker");
  assert.equal(calls.graph, 0);
  assert.equal(calls.standalone, 1);
  assert.equal(result.state, "completed");
});

test("SIMULATED_INTEGRATION: failed heartbeat persistence is contained and slow monitoring passes never overlap", async t => {
  const registry = new NodeRegistry(new InMemoryClusterStore(), new InviteManager());
  t.after(() => registry.stopMonitoring());
  let release!: () => void;
  let started!: () => void;
  let observedFailure!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const failure = new Promise<void>(resolve => { observedFailure = resolve; });
  let calls = 0;
  t.mock.method(registry as any, "checkHeartbeats", async () => {
    calls++;
    started();
    await held;
    throw new Error("Simulated database connection loss");
  });
  t.mock.method(console, "warn", () => { observedFailure(); });
  registry.startMonitoring(1);
  try {
    await firstStarted;
    await delay(15);
    assert.equal(calls, 1);
  } finally { release(); }
  await failure;
  registry.stopMonitoring();
});

test("MOCK_UNIT: a caught cancellation keeps the persisted goal root cancelled", async t => {
  const { agent, store } = setup(t, async () => { throw new DOMException("Cancelled", "AbortError"); }, async () => ({}));
  const spans: any[] = [];
  t.mock.method(store, "saveRuntimeSpan", async (span: any) => { spans.push(span); });
  const controller = new AbortController(); controller.abort(new Error("User cancelled conversation"));
  const result = await agent.chat("mock-cancelled-root", "Inspect platforms", { abortSignal: controller.signal });
  assert.equal(result.state, "cancelled");
  assert.equal(spans.filter(s => s.phase === "goal_received").at(-1).outcome, "cancelled");
});
