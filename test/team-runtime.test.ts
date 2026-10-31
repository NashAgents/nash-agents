import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TeamRuntime, Mailbox } from "../src/team/index.js";
import { TaskManager, TaskAlreadyOwnedError, TaskInvalidStateTransitionError } from "../src/task/index.js";
import { AgentRegistry } from "../src/agent/index.js";
import { ConcurrencyController } from "../src/concurrency/index.js";
import { EventBus } from "../src/observability/event-bus.js";
import { createTeamTools } from "../src/tools/orchestration/index.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";

describe("Phase C: Agent Team & Mailbox & Step-Boundary Injection", () => {
  it("1. 创建团队、添加专业成员与花名册管理", () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController();
    const taskManager = new TaskManager();

    const team = new TeamRuntime({
      name: "Engineering Core Team",
      leaderId: "lead-agent",
      taskManager,
      agentRegistry: registry,
      concurrencyController: concurrency,
    });

    const backend = team.addMember({
      name: "Backend Specialist",
      agentId: "backend-agent",
      role: "backend",
      roleDescription: "Focuses on API, database and business logic",
    });

    const frontend = team.addMember({
      name: "Frontend Specialist",
      agentId: "frontend-agent",
      role: "frontend",
      roleDescription: "Focuses on UI components and client state",
    });

    assert.equal(team.roster.getMemberCount(), 2);
    assert.equal(team.roster.getMember("backend-agent")?.role, "backend");
    assert.equal(team.roster.getMember("frontend-agent")?.role, "frontend");
    assert.equal(registry.getAgent("backend-agent")?.type, "team-member");
  });

  it("2. Lead 分配任务 (assignTask) 与 Member 自主原子认领 (claimTask)", () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController();
    const taskManager = new TaskManager();

    const team = new TeamRuntime({
      name: "Dev Team",
      leaderId: "lead-agent",
      taskManager,
      agentRegistry: registry,
      concurrencyController: concurrency,
    });

    team.addMember({
      name: "Backend",
      agentId: "backend-agent",
      role: "backend",
      roleDescription: "backend dev",
    });

    const task1 = taskManager.createTask({ id: "t1", subject: "DB Migration" });
    const task2 = taskManager.createTask({ id: "t2", subject: "API Handler" });

    // Lead assign
    team.assignTask("t1", "backend-agent");
    assert.equal(taskManager.getTask("t1")?.ownerAgentId, "backend-agent");

    // Member claim
    team.claimTask("t2", "backend-agent");
    assert.equal(taskManager.getTask("t2")?.ownerAgentId, "backend-agent");
    assert.equal(taskManager.getTask("t2")?.status, "running");
  });

  it("3. 两个 TeamMember 并发认领同一任务，仅有一个成功", () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController();
    const taskManager = new TaskManager();

    const team = new TeamRuntime({
      name: "Concurrent Team",
      leaderId: "lead-agent",
      taskManager,
      agentRegistry: registry,
      concurrencyController: concurrency,
    });

    team.addMember({ name: "Worker1", agentId: "w1", role: "dev", roleDescription: "" });
    team.addMember({ name: "Worker2", agentId: "w2", role: "dev", roleDescription: "" });

    taskManager.createTask({ id: "shared-task", subject: "Refactor core" });

    // w1 先 claim
    team.claimTask("shared-task", "w1");

    // w2 尝试 claim 相同 task -> 拒绝
    assert.throws(
      () => team.claimTask("shared-task", "w2"),
      TaskInvalidStateTransitionError
    );
  });

  it("4. Mailbox 点对点与广播消息发送与 Step Boundary 提取", () => {
    const mailbox = new Mailbox();

    mailbox.sendMessage({
      teamId: "team-1",
      senderAgentId: "backend-agent",
      senderName: "Backend Specialist",
      targetAgentId: "frontend-agent",
      content: "user_id 字段已兼容 null，前端请做可选链防护。",
    });

    assert.equal(mailbox.getUnreadCount("frontend-agent"), 1);
    assert.equal(mailbox.getUnreadCount("backend-agent"), 0);

    // Step Boundary 提取消息
    const messages = mailbox.claimPendingMessages("frontend-agent");
    assert.equal(messages.length, 1);
    assert.equal(mailbox.getUnreadCount("frontend-agent"), 0);

    const prompts = Mailbox.formatForPrompt(messages);
    assert.equal(prompts.length, 1);
    assert(prompts[0].includes("[Message from teammate: Backend Specialist (backend-agent)]"));
    assert(prompts[0].includes("user_id 字段已兼容 null"));
  });

  it("5. waitForChange 非轮询事件唤醒（新消息到达时立即唤醒）", async () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController();
    const taskManager = new TaskManager();

    const team = new TeamRuntime({
      name: "Wait Team",
      leaderId: "lead",
      taskManager,
      agentRegistry: registry,
      concurrencyController: concurrency,
    });

    team.addMember({ name: "Worker", agentId: "worker-1", role: "dev", roleDescription: "" });

    const waitPromise = team.waitForChange("worker-1", { timeoutMs: 5000 });

    // 延迟 10ms 发送一条消息
    setTimeout(() => {
      team.sendMessage("lead", "worker-1", "新需求已就绪，请查收");
    }, 10);

    const result = await waitPromise;
    assert.equal(result.reason, "mail_received");
    assert.equal(result.agentId, "worker-1");
  });

  it("6. waitForChange 非轮询事件唤醒（前置 Task 完成触发后继任务 Ready 唤醒）", async () => {
    const eventBus = new EventBus();
    const registry = new AgentRegistry({ eventBus });
    const concurrency = new ConcurrencyController();
    const taskManager = new TaskManager({ eventBus });

    const team = new TeamRuntime({
      name: "Wait Team 2",
      leaderId: "lead",
      taskManager,
      agentRegistry: registry,
      concurrencyController: concurrency,
      eventBus,
    });

    team.addMember({ name: "Worker", agentId: "worker-2", role: "dev", roleDescription: "" });

    taskManager.createTask({ id: "step-1", subject: "Step 1" });
    taskManager.createTask({ id: "step-2", subject: "Step 2", dependencies: ["step-1"] });

    const waitPromise = team.waitForChange("worker-2", { timeoutMs: 5000 });

    // 延迟 10ms 完成 step-1 -> 级联将 step-2 变为 ready -> 触发 task.ready 唤醒
    setTimeout(() => {
      taskManager.claimTask("step-1", "lead");
      taskManager.completeTask("step-1", { summary: "done" });
    }, 10);

    const result = await waitPromise;
    assert(
      result.reason === "task_completed" || result.reason === "task_ready",
      `Expected task_completed or task_ready, got: ${result.reason}`
    );
  });

  it("7. Persistent TeamMember 保持上下文并顺序处理多个 Task", () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController();
    const taskManager = new TaskManager();

    const team = new TeamRuntime({
      name: "Sequential Team",
      leaderId: "lead",
      taskManager,
      agentRegistry: registry,
      concurrencyController: concurrency,
    });

    team.addMember({ name: "Worker", agentId: "persistent-worker", role: "fullstack", roleDescription: "" });

    taskManager.createTask({ id: "job-1", subject: "Job 1" });
    taskManager.createTask({ id: "job-2", subject: "Job 2" });

    // 执行 Job 1
    team.claimTask("job-1", "persistent-worker");
    assert.equal(registry.getAgent("persistent-worker")?.status, "running");
    assert.equal(registry.getAgent("persistent-worker")?.currentTaskId, "job-1");
    taskManager.completeTask("job-1", { summary: "job 1 finished" }, { agentId: "persistent-worker" });

    // 成员进入 waiting
    registry.updateStatus("persistent-worker", "waiting");
    assert.equal(registry.getAgent("persistent-worker")?.status, "waiting");

    // 顺序认领 Job 2
    team.claimTask("job-2", "persistent-worker");
    assert.equal(registry.getAgent("persistent-worker")?.status, "running");
    assert.equal(registry.getAgent("persistent-worker")?.currentTaskId, "job-2");
    taskManager.completeTask("job-2", { summary: "job 2 finished" }, { agentId: "persistent-worker" });
  });

  it("8. 新加入的 TeamMember 初始状态为 ready，且 assign_task 能驱动 subAgentRuntime 执行任务", async () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController();
    const taskManager = new TaskManager();

    const team = new TeamRuntime({
      name: "Execution Team",
      leaderId: "lead",
      taskManager,
      agentRegistry: registry,
      concurrencyController: concurrency,
    });

    const member = team.addMember({
      name: "架构分析师",
      agentId: "architect",
      role: "architect",
      roleDescription: "负责系统拓扑分析",
    });

    // 关键断言：刚加入花名册的成员必须为 ready 状态，杜绝未执行前假性 working
    assert.equal(registry.getAgent("architect")?.status, "ready");

    taskManager.createTask({
      id: "task-survey",
      subject: "代码库架构清查",
      description: "全面扫描根目录与模块依赖",
    });

    let spawnedPrompt = "";
    let spawnedOptions: any = null;
    const mockSubAgentRuntime: any = {
      spawn: async (prompt: string, options: any) => {
        spawnedPrompt = prompt;
        spawnedOptions = options;
        // 模拟执行完成
        registry.updateStatus(options.agentId, "completed");
        return {
          agentId: options.agentId,
          success: true,
          output: "架构清查完成：共包含 5 个核心工程模块，整体依赖健康。",
          durationMs: 120,
        };
      },
    };

    const tools = createTeamTools({
      teamRuntime: team,
      subAgentRuntime: mockSubAgentRuntime,
      taskManager,
      role: "lead",
    });

    const assignTool = tools.find((t) => t.name === "assign_task");
    assert(assignTool, "assign_task 工具必须存在");

    const result = await assignTool.execute({
      taskId: "task-survey",
      agentId: "architect",
    });

    // 验证 assign_task 自动调度了 subAgentRuntime 执行，且任务归属与 prompt 完整传递
    assert(spawnedPrompt.includes("任务 [task-survey]: '代码库架构清查'"));
    assert(spawnedPrompt.includes("架构分析师"));
    assert.equal(spawnedOptions?.agentId, "architect");
    assert(String(result).includes("已由团队成员 '架构分析师' [ID: architect] 执行完成"));
    assert(String(result).includes("共包含 5 个核心工程模块"));
    assert.equal(taskManager.getTask("task-survey")?.ownerAgentId, "architect");
  });

  it("9. 全局任务完成后，CliPresenter.stopRun 能够自动收敛 TeamMember 状态，消除悬挂 working", () => {
    const eventBus = new EventBus();
    const registry = new AgentRegistry({ eventBus });
    const concurrency = new ConcurrencyController();
    const taskManager = new TaskManager({ eventBus });

    const team = new TeamRuntime({
      name: "Auto Converge Team",
      leaderId: "main",
      taskManager,
      agentRegistry: registry,
      concurrencyController: concurrency,
      eventBus,
    });

    team.addMember({
      name: "安全合规审计师",
      agentId: "security",
      role: "security",
      roleDescription: "负责安全审计",
    });

    // 手动模拟该 agent 曾进入 running 状态
    registry.updateStatus("security", "running");
    assert.equal(registry.getAgent("security")?.status, "running");

    const presenter = new CliPresenter({
      eventBus,
      agentRegistry: registry,
      taskManager,
      isTTY: false,
    });

    // 创建任务并标记完成
    taskManager.createTask({ id: "t-sec", subject: "凭据审计" });
    taskManager.claimTask("t-sec", "security");
    taskManager.completeTask("t-sec", { summary: "审计完成" }, { agentId: "security" });

    // 触发 stopRun
    presenter.stopRun("所有分析已完成");

    // 关键断言：任务全部完成后，security 的悬挂 running 状态被自动收敛为 completed
    assert.equal(registry.getAgent("security")?.status, "completed");
  });
});
