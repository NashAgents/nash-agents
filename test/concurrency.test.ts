import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ConcurrencyController,
  AgentDepthLimitError,
  AgentTotalLimitError,
  AgentChildrenLimitError,
  AgentConcurrencyLimitError,
  NoProgressDetectedError,
} from "../src/concurrency/index.js";
import { AgentRegistry } from "../src/agent/index.js";

describe("Phase A: Concurrency Controller & Agent Registry", () => {
  it("1. 深度限制 (maxAgentDepth) 能够阻止过深递归派生", () => {
    const controller = new ConcurrencyController({ maxAgentDepth: 2 });

    // depth 0, 1, 2 均合法
    controller.registerAgentSpawn(0);
    controller.registerAgentSpawn(1, "main");
    controller.registerAgentSpawn(2, "subagent-1");

    // depth 3 抛出 AgentDepthLimitError
    assert.throws(
      () => controller.registerAgentSpawn(3, "subagent-2"),
      AgentDepthLimitError
    );
  });

  it("2. 累计总量限制 (maxTotalAgents) 能够阻断无限累计创建", () => {
    const controller = new ConcurrencyController({ maxTotalAgents: 3 });

    controller.registerAgentSpawn(0);
    controller.registerAgentSpawn(1);
    controller.registerAgentSpawn(1);

    assert.throws(() => controller.registerAgentSpawn(1), AgentTotalLimitError);
  });

  it("3. 单 Agent 子节点上限 (maxChildrenPerAgent) 限制", () => {
    const controller = new ConcurrencyController({ maxChildrenPerAgent: 2 });

    controller.registerAgentSpawn(0); // main
    controller.registerAgentSpawn(1, "main");
    controller.registerAgentSpawn(1, "main");

    assert.throws(
      () => controller.registerAgentSpawn(1, "main"),
      AgentChildrenLimitError
    );
  });

  it("4. 瞬时并发 Semaphore 槽位排队机制", async () => {
    const controller = new ConcurrencyController({ maxConcurrentAgents: 2 });

    const release1 = await controller.acquireSlot();
    const release2 = await controller.acquireSlot();

    assert.equal(controller.getRunningCount(), 2);
    assert.equal(controller.getWaitingQueueLength(), 0);

    let acquired3 = false;
    const promise3 = controller.acquireSlot().then((release) => {
      acquired3 = true;
      return release;
    });

    // 此时第 3 个在排队
    assert.equal(acquired3, false);
    assert.equal(controller.getWaitingQueueLength(), 1);

    // 释放 slot 1
    release1();
    const release3 = await promise3;

    assert.equal(acquired3, true);
    assert.equal(controller.getWaitingQueueLength(), 0);

    release2();
    release3();
    assert.equal(controller.getRunningCount(), 0);
  });

  it("5. 死循环与无进展检测 (NoProgressDetectedError)", () => {
    const controller = new ConcurrencyController({
      enableNoProgressDetection: true,
      noProgressThreshold: 3,
    });

    controller.reportStepProgress(false);
    controller.reportStepProgress(false);
    // 产生一次进展 -> 重置
    controller.reportStepProgress(true);

    controller.reportStepProgress(false);
    controller.reportStepProgress(false);
    assert.throws(
      () => controller.reportStepProgress(false),
      NoProgressDetectedError
    );
  });

  it("6. AgentRegistry 记录与树形层级管理", () => {
    const registry = new AgentRegistry();

    const main = registry.register({
      agentId: "main-agent",
      type: "main",
      name: "Main Coordinator",
    });
    assert.equal(main.depth, 0);

    const sub1 = registry.register({
      agentId: "sub-1",
      parentAgentId: "main-agent",
      type: "subagent",
    });
    assert.equal(sub1.depth, 1);

    const sub2 = registry.register({
      agentId: "sub-2",
      parentAgentId: "sub-1",
      type: "subagent",
    });
    assert.equal(sub2.depth, 2);

    const childrenOfMain = registry.getChildren("main-agent");
    assert.equal(childrenOfMain.length, 1);
    assert.equal(childrenOfMain[0].agentId, "sub-1");

    registry.updateStatus("sub-1", "completed");
    assert.equal(registry.getAgent("sub-1")?.status, "completed");
  });
});
