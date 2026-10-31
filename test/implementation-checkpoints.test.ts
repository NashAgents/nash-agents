import fs from "node:fs/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { TaskManager } from "../src/task/index.js";
import { LocalSessionStore } from "../src/context/session/local-session-store.js";
import { SessionReplayEngine } from "../src/orchestration/session-replay.js";
import { WriteScopeConflictError } from "../src/filesystem/errors.js";
import {
  createDefaultToolRegistry,
  createLeadToolRegistry,
  createSubAgentToolRegistry,
  createMemberToolRegistry,
} from "../src/tools/index.js";
import { AgentRegistry, SubAgentRuntime } from "../src/agent/index.js";
import { ConcurrencyController } from "../src/concurrency/index.js";
import { TeamRuntime } from "../src/team/index.js";
import { PlanMode } from "../src/plan/index.js";

describe("4 Detailed Implementation Checkpoints Verification", () => {
  it("检查点 1: assignTask 与 claimTask 一样经过严格的 writeScopes 冲突检查", () => {
    const taskManager = new TaskManager();

    // 创建两个重叠范围任务
    taskManager.createTask({
      id: "task-1",
      subject: "Task 1",
      writeScopes: ["src/auth/**"],
    });

    taskManager.createTask({
      id: "task-2",
      subject: "Task 2",
      writeScopes: ["src/auth/service.ts"],
    });

    // Task 1 正在运行
    taskManager.claimTask("task-1", "agent-A");

    // Lead 尝试将重叠的 Task 2 assign 分配给 agent-B -> 受到相同的 WriteScopeConflictError 拦截
    assert.throws(
      () => taskManager.assignTask("task-2", "agent-B", undefined, { workspaceMode: "shared" }),
      (err: unknown) => {
        assert(err instanceof WriteScopeConflictError);
        assert.equal(err.code, "WRITE_SCOPE_CONFLICT");
        return true;
      }
    );
  });

  it("检查点 2: 崩溃恢复 Task 时完整清理旧状态 (ownerAgentId 置空, revision 递增)", async (t) => {
    const tempDir = path.join(os.tmpdir(), `nash-recovery-audit-${Date.now()}`);
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    const sessionStore = new LocalSessionStore({ baseDir: tempDir });

    // 模拟奔溃前：Task 被 dead-agent 占有，revision 为 2
    await sessionStore.appendDomainEvent("agent.spawned", {
      agent: { agentId: "dead-agent", type: "team-member", depth: 1 },
    });
    await sessionStore.appendDomainEvent("task.created", {
      task: { id: "crash-task", subject: "Critical job", dependencies: [] },
    });
    await sessionStore.appendDomainEvent("task.started", {
      taskId: "crash-task",
      agentId: "dead-agent",
    });

    // 重放并恢复
    const replayed = await SessionReplayEngine.replay(sessionStore, { autoRecoverRunning: true });
    const recoveredTask = replayed.taskManager.requireTask("crash-task");

    assert.equal(recoveredTask.status, "ready");
    assert.equal(recoveredTask.ownerAgentId, undefined, "旧 owner 必须彻底清理");
    assert.equal(recoveredTask.revision, 3, "revision 必须原子递增");

    await sessionStore.clear();
  });

  it("检查点 3: worktree 模式下不同物理目录允许绕过重叠 writeScopes 冲突", () => {
    const taskManager = new TaskManager();

    taskManager.createTask({
      id: "task-shared",
      subject: "Task on Shared Workspace",
      writeScopes: ["src/auth/**"],
    });

    taskManager.createTask({
      id: "task-worktree",
      subject: "Task on Isolated Worktree",
      writeScopes: ["src/auth/**"],
    });

    // Task 1 在共享工作区 running
    taskManager.claimTask("task-shared", "agent-1", undefined, {
      workspaceMode: "shared",
    });

    // Task 2 明确在独立物理 worktree 路径下运行 -> 允许并发启动
    const claimedWorktree = taskManager.claimTask("task-worktree", "agent-2", undefined, {
      workspaceMode: "worktree",
      worktreePath: "/tmp/nash-worktrees/agent-2",
    });

    assert.equal(claimedWorktree.status, "running");
    assert.equal(claimedWorktree.ownerAgentId, "agent-2");
  });

  it("检查点 4: 三档权限体系 (Lead vs SubAgent vs TeamMember) 精准隔离与全量覆盖", () => {
    const taskManager = new TaskManager();
    const agentRegistry = new AgentRegistry();
    const concurrencyController = new ConcurrencyController();
    const subAgentRuntime = new SubAgentRuntime({ agentRegistry, concurrencyController });
    const teamRuntime = new TeamRuntime({
      name: "Role Team",
      leaderId: "lead",
      taskManager,
      agentRegistry,
      concurrencyController,
    });
    const planMode = new PlanMode();

    const baseOptions = {
      taskManager,
      subAgentRuntime,
      agentRegistry,
      teamRuntime,
      planMode,
    };

    // 1. Lead 工具注册中心（全量组织级 + 执行级）
    const leadRegistry = createLeadToolRegistry(baseOptions);
    const leadTools = leadRegistry.getDefinitions().map((d) => d.function.name);
    assert(leadTools.includes("create_task"));
    assert(leadTools.includes("update_task"));
    assert(leadTools.includes("complete_task"), "Lead 必须能完成自身任务");
    assert(leadTools.includes("send_message"), "Lead 必须能发送沟通消息");
    assert(leadTools.includes("wait_for_change"), "Lead 必须能等待事件唤醒");
    assert(leadTools.includes("spawn_teammate"));
    assert(leadTools.includes("assign_task"));
    assert(leadTools.includes("enter_plan_mode"));
    assert(leadTools.includes("spawn_agent"));

    // 2. SubAgent 工具注册中心（执行级 + 有限派生）
    const subRegistry = createSubAgentToolRegistry(baseOptions);
    const subTools = subRegistry.getDefinitions().map((d) => d.function.name);
    assert(subTools.includes("complete_task"));
    assert(subTools.includes("list_tasks"));
    assert(subTools.includes("spawn_agent"), "SubAgent 在 depth 允许范围内可有限派生");
    assert.equal(subTools.includes("spawn_teammate"), false, "SubAgent 禁止创建队员");
    assert.equal(subTools.includes("assign_task"), false, "SubAgent 禁止指派任务");
    assert.equal(subTools.includes("enter_plan_mode"), false, "SubAgent 禁止进入 Plan Mode");

    // 3. Member 工具注册中心（执行级 + 团队协作）
    const memberRegistry = createMemberToolRegistry(baseOptions);
    const memberTools = memberRegistry.getDefinitions().map((d) => d.function.name);
    assert(memberTools.includes("claim_task"));
    assert(memberTools.includes("complete_task"));
    assert(memberTools.includes("send_message"));
    assert(memberTools.includes("wait_for_change"));
    assert(memberTools.includes("list_tasks"));
    assert.equal(memberTools.includes("create_task"), false, "Member 禁止创建 Global Task");
    assert.equal(memberTools.includes("spawn_teammate"), false, "Member 禁止添加队员");
    assert.equal(memberTools.includes("enter_plan_mode"), false, "Member 禁止进入 Plan Mode");
    assert.equal(memberTools.includes("spawn_agent"), false, "Member 禁止派生子 Agent");
  });
});
