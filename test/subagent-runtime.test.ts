import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubAgentRuntime, AgentRegistry } from "../src/agent/index.js";
import { ConcurrencyController, AgentDepthLimitError, AgentTotalLimitError } from "../src/concurrency/index.js";
import { TaskManager } from "../src/task/index.js";
import { EventBus } from "../src/observability/event-bus.js";

describe("Phase B: SubAgent Runtime", () => {
  it("1. 校验深度超限拒绝 spawn", async () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController({ maxAgentDepth: 1 });
    const runtime = new SubAgentRuntime({
      agentRegistry: registry,
      concurrencyController: concurrency,
    });

    registry.register({
      agentId: "main-agent",
      type: "main",
      depth: 0,
    });

    registry.register({
      agentId: "sub-1",
      parentAgentId: "main-agent",
      type: "subagent",
      depth: 1,
    });

    // sub-1 再次尝试派生 sub-2 (depth 将达到 2，超限 1)
    await assert.rejects(
      async () => {
        await runtime.spawn("Task prompt", {
          parentAgentId: "sub-1",
        });
      },
      AgentDepthLimitError
    );
  });

  it("2. 校验累计总量超限拒绝 spawn", async () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController({ maxTotalAgents: 1 });
    const runtime = new SubAgentRuntime({
      agentRegistry: registry,
      concurrencyController: concurrency,
    });

    concurrency.registerAgentSpawn(0); // 占用唯一的名额

    await assert.rejects(
      async () => {
        await runtime.spawn("another task");
      },
      AgentTotalLimitError
    );
  });

  it("3. 中断 (interrupt) 能够将运行中的 Agent 状态置为 interrupted", () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController();
    const runtime = new SubAgentRuntime({
      agentRegistry: registry,
      concurrencyController: concurrency,
    });

    registry.register({
      agentId: "agent-worker",
      type: "subagent",
      depth: 1,
    });

    const interrupted = runtime.interrupt("agent-worker", "User cancelled");
    assert.equal(interrupted, true);
    assert.equal(registry.getAgent("agent-worker")?.status, "interrupted");
    assert.equal(
      registry.getAgent("agent-worker")?.error?.code,
      "AGENT_INTERRUPTED"
    );
  });

  it("4. EventBus 完整捕获 SubAgent 生命周期事件", () => {
    const eventBus = new EventBus();
    const events: string[] = [];
    eventBus.subscribe("*", (e) => {
      events.push(e.type);
    });

    const registry = new AgentRegistry({ eventBus });

    registry.register({
      agentId: "test-sub",
      type: "subagent",
      depth: 1,
    });
    assert(events.includes("agent.spawned"));

    registry.updateStatus("test-sub", "waiting");
    assert(events.includes("agent.waiting"));

    registry.updateStatus("test-sub", "completed");
    assert(events.includes("agent.completed"));
  });
});
