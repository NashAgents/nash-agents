import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { TaskManager } from "../src/task/index.js";
import { AgentRegistry, SubAgentRuntime } from "../src/agent/index.js";
import { ConcurrencyController } from "../src/concurrency/index.js";
import { TeamRuntime } from "../src/team/index.js";
import {
  FileSystemAccess,
  createDefaultSandboxPolicy,
} from "../src/sandbox/index.js";
import {
  createLeadToolRegistry,
  createMemberToolRegistry,
  createSubAgentToolRegistry,
} from "../src/tools/index.js";
import { EventBus } from "../src/observability/event-bus.js";

describe("Real Multi-Agent Orchestration Full Flow Verification", () => {
  const testWorkspace = path.join(os.tmpdir(), `nash-real-e2e-${Date.now()}`);

  before(async () => {
    await fs.mkdir(testWorkspace, { recursive: true });
    await fs.writeFile(
      path.join(testWorkspace, "config.json"),
      JSON.stringify({ active: true, version: 1 }),
      "utf-8"
    );
  });

  after(async () => {
    try {
      await fs.rm(testWorkspace, { recursive: true, force: true });
    } catch {}
  });

  it("链路 1: Main -> create_task -> spawn_agent (独立上下文) -> 修改代码 -> complete_task -> Main 唤醒验证", async () => {
    const eventBus = new EventBus();
    const taskManager = new TaskManager({ eventBus });
    const agentRegistry = new AgentRegistry({ eventBus });
    const concurrencyController = new ConcurrencyController({ maxConcurrentAgents: 2 });
    const subAgentRuntime = new SubAgentRuntime({
      agentRegistry,
      concurrencyController,
      taskManager,
      eventBus,
    });

    // 1. Main Agent 初始化
    const mainAgent = agentRegistry.register({
      agentId: "main-coordinator",
      type: "main",
      depth: 0,
      name: "Main Coordinator",
    });

    const leadRegistry = createLeadToolRegistry({
      taskManager,
      subAgentRuntime,
      agentRegistry,
    });

    // 2. Main Agent 调用 create_task 工具创建全局任务
    const createTaskTool = leadRegistry.getTool("create_task");
    assert.ok(createTaskTool);
    await createTaskTool.execute({
      id: "task-feat-auth",
      subject: "Implement Auth Token Generator",
      writeScopes: ["src/auth/**"],
    });

    assert.equal(taskManager.getTask("task-feat-auth")?.status, "ready");

    // 3. Main Agent 派生子 Agent 执行独立实现
    const subAgent = agentRegistry.register({
      agentId: "sub-worker-1",
      parentAgentId: mainAgent.agentId,
      type: "subagent",
      depth: 1,
      currentTaskId: "task-feat-auth",
    });

    const subRegistry = createSubAgentToolRegistry({
      taskManager,
      agentRegistry,
      agentId: subAgent.agentId,
    });
    taskManager.claimTask("task-feat-auth", subAgent.agentId);

    // 4. SubAgent 工具集中不包含组织特权工具
    assert.equal(subRegistry.hasTool("spawn_teammate"), false);
    assert.equal(subRegistry.hasTool("enter_plan_mode"), false);

    // 5. SubAgent 写入代码并完成任务
    const authPath = path.join(testWorkspace, "src", "auth", "token.ts");
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(authPath, "export function genToken() { return 'jwt-123'; }", "utf-8");

    const completeTool = subRegistry.getTool("complete_task");
    assert.ok(completeTool);
    await completeTool.execute({
      taskId: "task-feat-auth",
      summary: "Generated jwt token generator module in src/auth/token.ts",
      agentId: subAgent.agentId,
      artifacts: ["src/auth/token.ts"],
    });

    // 6. 验证任务已完成且产物落盘
    const task = taskManager.requireTask("task-feat-auth");
    assert.equal(task.status, "completed");
    assert.equal(task.result?.artifacts?.[0], "src/auth/token.ts");

    const fileContent = await fs.readFile(authPath, "utf-8");
    assert(fileContent.includes("jwt-123"));
  });

  it("链路 2: Team 协同 -> Lead 创建成员 -> claim/assign -> Mailbox 沟通 -> wait_for_change 事件唤醒 -> 最终汇总", async () => {
    const eventBus = new EventBus();
    const taskManager = new TaskManager({ eventBus });
    const agentRegistry = new AgentRegistry({ eventBus });
    const concurrencyController = new ConcurrencyController({ maxConcurrentAgents: 4 });

    const team = new TeamRuntime({
      name: "Core Backend Team",
      leaderId: "team-lead",
      taskManager,
      agentRegistry,
      concurrencyController,
      eventBus,
    });

    // 1. Lead 拥有全量工具
    const leadRegistry = createLeadToolRegistry({
      taskManager,
      agentRegistry,
      teamRuntime: team,
    });

    const spawnTeammateTool = leadRegistry.getTool("spawn_teammate");
    assert.ok(spawnTeammateTool);

    // 创建 backend 成员
    await spawnTeammateTool.execute({
      name: "Backend Worker",
      agentId: "worker-backend",
      role: "backend",
      roleDescription: "Handles database schemas and APIs",
    });

    // 创建 frontend 成员
    await spawnTeammateTool.execute({
      name: "Frontend Worker",
      agentId: "worker-frontend",
      role: "frontend",
      roleDescription: "Handles web components and views",
    });

    assert.equal(team.roster.getMemberCount(), 2);

    // 2. Lead 创建两个有依赖关系的任务
    taskManager.createTask({
      id: "task-db",
      subject: "Apply DB Migrations",
      writeScopes: ["db/**"],
    });

    taskManager.createTask({
      id: "task-ui",
      subject: "Render User Profile",
      dependencies: ["task-db"],
      writeScopes: ["ui/**"],
    });

    // 3. Member 工具注册中心（执行级）
    const memberBackendRegistry = createMemberToolRegistry({
      taskManager,
      agentRegistry,
      teamRuntime: team,
      agentId: "worker-backend",
    });

    const memberFrontendRegistry = createMemberToolRegistry({
      taskManager,
      agentRegistry,
      teamRuntime: team,
      agentId: "worker-frontend",
    });

    // 4. Backend 认领任务 1
    const claimTool = memberBackendRegistry.getTool("claim_task");
    assert.ok(claimTool);
    await claimTool.execute({
      taskId: "task-db",
      agentId: "worker-backend",
    });
    assert.equal(taskManager.getTask("task-db")?.status, "running");

    // 5. Frontend 挂起等待前置依赖完成 (wait_for_change)
    const waitPromise = team.waitForChange("worker-frontend", { timeoutMs: 5000 });

    // 6. Backend 成员发送协同消息
    const sendMsgTool = memberBackendRegistry.getTool("send_message");
    assert.ok(sendMsgTool);
    await sendMsgTool.execute({
      senderAgentId: "worker-backend",
      targetAgentId: "worker-frontend",
      content: "DB schema updated: added avatar_url column to users table.",
    });

    // 7. Backend 完成任务 -> 级联唤醒 task-ui 变为 ready
    const completeTaskTool = memberBackendRegistry.getTool("complete_task");
    assert.ok(completeTaskTool);
    await completeTaskTool.execute({
      taskId: "task-db",
      summary: "Migrations applied cleanly",
      agentId: "worker-backend",
    });

    // 8. 验证 Frontend 被非轮询事件唤醒
    const wakeResult = await waitPromise;
    assert(
      wakeResult.reason === "mail_received" ||
      wakeResult.reason === "task_ready" ||
      wakeResult.reason === "task_completed"
    );

    // 9. Frontend 取出 Mailbox 消息并认领已就绪的 task-ui
    const pendingMsgs = team.claimMessagesForStep("worker-frontend");
    assert(pendingMsgs.length >= 1);
    assert(pendingMsgs[0].content.includes("avatar_url"));

    assert.equal(taskManager.requireTask("task-ui").status, "ready");
    await memberFrontendRegistry.getTool("claim_task")!.execute({
      taskId: "task-ui",
      agentId: "worker-frontend",
    });
    assert.equal(taskManager.requireTask("task-ui").status, "running");

    // 10. Frontend 最终完成
    await memberFrontendRegistry.getTool("complete_task")!.execute({
      taskId: "task-ui",
      summary: "Profile component rendered",
      agentId: "worker-frontend",
    });
    assert.equal(taskManager.requireTask("task-ui").status, "completed");

    // 11. Lead 查看最终团队汇总
    const listTeamTool = leadRegistry.getTool("list_team");
    assert.ok(listTeamTool);
    const summaryView = (await listTeamTool.execute({})) as string;
    assert(summaryView.includes("Core Backend Team"));
    assert(summaryView.includes("worker-backend"));
    assert(summaryView.includes("worker-frontend"));
  });
});
