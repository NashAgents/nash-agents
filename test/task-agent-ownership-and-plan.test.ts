import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { TaskManager } from "../src/task/task-manager.js";
import { SubAgentRuntime } from "../src/agent/subagent-runtime.js";
import { ConcurrencyController } from "../src/concurrency/concurrency-controller.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { formatTaskCentricView } from "../src/projection/index.js";
import { AgentTreeProjection } from "../src/presentation/agent-tree-projection.js";

function createMockTtyStream(columns = 80) {
  const stream = new PassThrough() as any;
  stream.isTTY = true;
  stream.columns = columns;
  let buffer = "";

  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });

  return {
    stream,
    getOutput: () => buffer,
    clearBuffer: () => {
      buffer = "";
    },
  };
}

describe("Task-Agent Ownership & Plan Expansion State Subsystem", () => {
  describe("1. Task Ownership Atomic Binding on spawn_agent", () => {
    it("1.1 spawn_agent 指定 taskId 时，在执行前原子将 Task 状态置为 running 并绑定 ownerAgentId", async () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      const taskManager = new TaskManager({ eventBus });
      const concurrencyController = new ConcurrencyController();

      // 创建一个 ready Task
      const task = taskManager.createTask({
        id: "task-test-suite",
        subject: "运行测试套件与代码覆盖率检查",
      });

      assert.equal(task.status, "ready");
      assert.equal(task.ownerAgentId, undefined);

      // 注册 Agent 并模拟原子认领
      const agentRecord = agentRegistry.register({
        name: "test-runner",
        type: "subagent",
        currentTaskId: "task-test-suite",
      });

      taskManager.claimTask("task-test-suite", agentRecord.agentId);

      const runningTask = taskManager.getTask("task-test-suite");
      assert(runningTask);
      assert.equal(runningTask.status, "running", "Task 应原子转移为 running 状态");
      assert.equal(runningTask.ownerAgentId, agentRecord.agentId, "Task 应拥有明确的 ownerAgentId");

      // 标记完成
      taskManager.completeTask("task-test-suite", { summary: "42 unit tests passed" }, { agentId: agentRecord.agentId });

      const completedTask = taskManager.getTask("task-test-suite");
      assert(completedTask);
      assert.equal(completedTask.status, "completed");
      assert.equal(
        completedTask.completedByAgentId,
        agentRecord.agentId,
        "completedByAgentId 应忠实保留执行 Agent"
      );
    });

    it("1.2 completed 任务在 TaskCentric 视图中清晰保留执行 Agent 归属，绝不退化为 unassigned", () => {
      const eventBus = new EventBus();
      const taskManager = new TaskManager({ eventBus });

      const t1 = taskManager.createTask({
        id: "task-build",
        subject: "项目编译与类型检查",
      });

      taskManager.claimTask(t1.id, "build-checker");
      taskManager.completeTask(t1.id, { summary: "TS 编译成功 0 errors" }, { agentId: "build-checker" });

      const t2 = taskManager.createTask({
        id: "task-tests",
        subject: "单元测试运行",
      });
      taskManager.claimTask(t2.id, "test-runner");

      const t3 = taskManager.createTask({
        id: "task-qa",
        subject: "代码质量审查",
      });

      const view = formatTaskCentricView(taskManager);
      assert(view.includes("✓ [task-build]"), "已完成任务符号为 ✓");
      assert(view.includes("(build-checker · completed)"), "已完成任务应显示 (build-checker · completed)");
      assert.equal(view.includes("(unassigned) [task-build]"), false);

      assert(view.includes("→ [task-tests]"), "运行中任务符号为 →");
      assert(view.includes("(test-runner · running)"), "运行中任务应显示 (test-runner · running)");

      assert(view.includes("○ [task-qa]"), "待执行 ready 任务符号为 ○");
      assert(view.includes("(ready)"), "未领取的 ready 任务应显示 (ready)");
    });

    it("1.3 failed 任务应记录 failedByAgentId 且在视图中标记 ✗ (agent · failed)", () => {
      const eventBus = new EventBus();
      const taskManager = new TaskManager({ eventBus });

      const task = taskManager.createTask({
        id: "task-security",
        subject: "依赖安全扫描",
      });
      taskManager.claimTask(task.id, "sec-scanner");
      taskManager.failTask(task.id, { message: "Found high vulnerability" }, { agentId: "sec-scanner" });

      const view = formatTaskCentricView(taskManager);
      assert(view.includes("✗ [task-security]"));
      assert(view.includes("(sec-scanner · failed)"));
    });
  });

  describe("2. Plan Expansion State Management", () => {
    it("2.1 新 Run 开始时 Plan 默认展开，用户按 Ctrl+T 收起，当前 Run 内持久保持", async () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      const taskManager = new TaskManager({ eventBus });
      const mock = createMockTtyStream(80);

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        taskManager,
        stdout: mock.stream,
        isTTY: true,
      });

      taskManager.createTask({
        id: "t-1",
        subject: "第一步：代码扫描",
      });

      try {
        // 启动 Run
        presenter.startRun("Analyze codebase");
        await new Promise((r) => setTimeout(r, 60));

        let out = mock.getOutput();
        assert(out.includes("Plan (0/1)"), "新 Run 默认应展开 Plan (0/1)");
        assert(out.includes("第一步：代码扫描"), "默认展开应展示任务主题");
        assert(out.includes("(Ctrl+T collapse)"));

        mock.clearBuffer();

        // 用户按 Ctrl+T 收起
        const nav = presenter.getNavigationHandler();
        nav.onKeyCtrlT?.();
        await new Promise((r) => setTimeout(r, 60));

        out = mock.getOutput();
        assert(out.includes("(Ctrl+T expand)"), "按 Ctrl+T 后收起为单行");

        mock.clearBuffer();

        // 模拟任务状态更新产生新帧，收起状态不应被重置
        taskManager.createTask({
          id: "t-2",
          subject: "第二步：单元测试",
        });
        await new Promise((r) => setTimeout(r, 80));
        out = mock.getOutput();
        assert(out.includes("Plan (0/2)"), "任务增加应反映在 Plan 计数中");
        assert(out.includes("(Ctrl+T expand)"), "Task 事件更新时必须保持收起状态");

        presenter.stopRun();

        mock.clearBuffer();

        // 下一次新的 Run 启动时，重新默认展开
        presenter.startRun("Next new run");
        await new Promise((r) => setTimeout(r, 80));
        out = mock.getOutput();
        assert(out.includes("Plan (0/2)"), "新的 Run 应重新默认展开");
        assert(out.includes("(Ctrl+T collapse)"));
      } finally {
        presenter.stopRun();
        presenter.destroy();
      }
    });

    it("2.2 没有 Plan 时不显示空的 Plan 区域", async () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      const taskManager = new TaskManager({ eventBus }); // tasks 数组为空
      const mock = createMockTtyStream(80);

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        taskManager,
        stdout: mock.stream,
        isTTY: true,
      });

      try {
        presenter.startRun("Simple question");
        await new Promise((r) => setTimeout(r, 60));

        const out = mock.getOutput();
        assert.equal(out.includes("Plan ("), false);
        assert.equal(out.includes("Plan 0/0"), false);
      } finally {
        presenter.stopRun();
        presenter.destroy();
      }
    });
  });

  describe("3. Agent Tree & Background Job Duration Integrity", () => {
    it("3.1 AgentTreeProjection 能够列出所有 spawned agents 并在面板上正确分层", () => {
      const eventBus = new EventBus();
      const registry = new AgentRegistry({ eventBus });
      const projection = new AgentTreeProjection();

      const mainAgent = registry.register({
        agentId: "main",
        name: "Main",
        type: "main",
      });

      const child1 = registry.register({
        agentId: "build-checker",
        name: "build-checker",
        type: "subagent",
        parentAgentId: "main",
      });

      const child2 = registry.register({
        agentId: "test-runner",
        name: "test-runner",
        type: "subagent",
        parentAgentId: "main",
      });

      registry.updateStatus("build-checker", "completed");
      registry.updateStatus("test-runner", "running");

      const tree = projection.renderNavigableTree(registry, 1, "main");
      assert(tree.includes("Main"));
      assert(tree.includes("build-checker"));
      assert(tree.includes("test-runner"));
      assert(tree.includes("done ✓"));
      assert(tree.includes("working"));
    });
  });
});
