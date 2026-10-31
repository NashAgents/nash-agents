import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UserMessageRouter } from "../src/orchestration/user-message-router.js";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { SubAgentRuntime } from "../src/agent/subagent-runtime.js";
import { ConcurrencyController } from "../src/concurrency/concurrency-controller.js";
import { TaskManager } from "../src/task/task-manager.js";
import { AgentInterruptedError } from "../src/agent/errors.js";

describe("UserMessageRouter & Steer / Queue / Interrupt Subsystem", () => {
  describe("1. Message Routing & Boundary Drain", () => {
    it("1.1 Steer 消息按目标 agentId 隔离暂存，并在 Step Boundary 精确被 drain", () => {
      const router = new UserMessageRouter();

      // 向 Main 提交 Steer
      const msg1 = router.submit("Focus on runtime only", "main", "steer");
      // 向 test-runner 提交 Steer
      const msg2 = router.submit("Only run unit tests", "test-runner", "steer");

      assert.equal(router.hasPendingSteer("main"), true);
      assert.equal(router.hasPendingSteer("test-runner"), true);
      assert.equal(router.hasPendingSteer("other-agent"), false);

      // Main drain 其自己的消息
      const mainSteers = router.drainSteer("main");
      assert.equal(mainSteers.length, 1);
      assert.equal(mainSteers[0].content, "Focus on runtime only");
      assert.equal(router.hasPendingSteer("main"), false, "Drain 后缓冲区应清空");

      // test-runner 消息不受影响
      assert.equal(router.hasPendingSteer("test-runner"), true);
      const childSteers = router.drainSteer("test-runner");
      assert.equal(childSteers.length, 1);
      assert.equal(childSteers[0].content, "Only run unit tests");
    });

    it("1.2 Queue 消息不进入 SteerBuffer，严格按 FIFO 顺序排队并在 Run 结束时出队", () => {
      const router = new UserMessageRouter();

      router.submit("Update README after done", "main", "queue");
      router.submit("Add git commit", "main", "queue");

      assert.equal(router.hasPendingSteer("main"), false, "Queue 消息绝不污染 Steer 活跃上下文");
      assert.equal(router.getQueueLength(), 2);

      const first = router.dequeueFollowup();
      assert.equal(first?.content, "Update README after done");
      assert.equal(router.getQueueLength(), 1);

      const second = router.dequeueFollowup();
      assert.equal(second?.content, "Add git commit");
      assert.equal(router.getQueueLength(), 0);

      assert.equal(router.dequeueFollowup(), undefined);
    });
  });

  describe("2. Cancellation Tree & Granular Interrupt", () => {
    it("2.1 Main Interrupt 触发 Run-level 中断，中止所有已注册的 AbortController", () => {
      const router = new UserMessageRouter();

      const mainController = new AbortController();
      const child1Controller = new AbortController();
      const child2Controller = new AbortController();

      router.registerAbortController("main", mainController);
      router.registerAbortController("agent-child-1", child1Controller);
      router.registerAbortController("agent-child-2", child2Controller);

      assert.equal(mainController.signal.aborted, false);
      assert.equal(child1Controller.signal.aborted, false);
      assert.equal(child2Controller.signal.aborted, false);

      // 触发 Run-level 中断
      router.triggerInterrupt("main", "User stopped whole run");

      assert.equal(mainController.signal.aborted, true);
      assert.equal(child1Controller.signal.aborted, true);
      assert.equal(child2Controller.signal.aborted, true);
    });

    it("2.2 Agent-level Interrupt 仅中止特定目标 Agent，不杀死整个 Run", () => {
      const router = new UserMessageRouter();

      const mainController = new AbortController();
      const child1Controller = new AbortController();
      const child2Controller = new AbortController();

      router.registerAbortController("main", mainController);
      router.registerAbortController("build-checker", child1Controller);
      router.registerAbortController("test-runner", child2Controller);

      // 用户在 Detail 视图中按 x 中断 build-checker
      router.triggerInterrupt("build-checker", "User stopped build-checker only");

      assert.equal(child1Controller.signal.aborted, true, "目标 Agent 被中止");
      assert.equal(mainController.signal.aborted, false, "Main 保持存活");
      assert.equal(child2Controller.signal.aborted, false, "其他兄弟 Agent 保持存活");
    });

    it("2.3 SubAgentRuntime.interrupt 能够精准中断指定子任务并更新状态", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      const taskManager = new TaskManager({ eventBus });
      const concurrencyController = new ConcurrencyController();
      const router = new UserMessageRouter({ eventBus });

      const runtime = new SubAgentRuntime({
        agentRegistry,
        concurrencyController,
        taskManager,
        eventBus,
        userMessageRouter: router,
      });

      const agentRecord = agentRegistry.register({
        name: "long-task-agent",
        type: "subagent",
      });
      agentRegistry.updateStatus(agentRecord.agentId, "running");

      // 中断该 Agent
      const ok = runtime.interrupt(agentRecord.agentId, "Stop this test");
      assert.equal(ok, true);

      const updated = agentRegistry.getAgent(agentRecord.agentId);
      assert.equal(updated?.status, "interrupted");
      assert.equal(updated?.error?.code, "AGENT_INTERRUPTED");
    });

    it("2.4 triggerInterrupt 触发时必须清空待注入的 steerBuffers，防止中断后残留执行", () => {
      const router = new UserMessageRouter();
      router.submit("pending steer message 1", "main", "steer");
      router.submit("pending steer message 2", "subagent-1", "steer");

      assert.equal(router.hasPendingSteer("main"), true);
      assert.equal(router.hasPendingSteer("subagent-1"), true);

      // 单个 Agent 中断只清空该 Agent 的 steer
      router.triggerInterrupt("subagent-1", "Cancelled");
      assert.equal(router.hasPendingSteer("subagent-1"), false);
      assert.equal(router.hasPendingSteer("main"), true);

      // Run-level 中断清空所有 steer
      router.triggerInterrupt("main", "Stop all");
      assert.equal(router.hasPendingSteer("main"), false);
    });
  });
});
