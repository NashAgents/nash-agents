import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { TaskManager } from "../src/task/index.js";
import { AgentRegistry, SubAgentRuntime } from "../src/agent/index.js";
import { ConcurrencyController } from "../src/concurrency/index.js";
import { TeamRuntime, Mailbox } from "../src/team/index.js";
import { PlanMode } from "../src/plan/index.js";
import {
  FileSystemAccess,
  createDefaultSandboxPolicy,
} from "../src/sandbox/index.js";
import {
  createDefaultToolRegistry,
} from "../src/tools/index.js";
import { LocalSessionStore } from "../src/context/session/local-session-store.js";
import { SessionReplayEngine } from "../src/orchestration/session-replay.js";
import { WriteScopeConflictError } from "../src/filesystem/errors.js";

describe("Phase G+: Deep End-to-End Lifecycle & Recovery Verification", () => {
  it("1. 校验 ToolRegistry 完整包含全部编排工具且 Schema 符合标准", () => {
    const taskManager = new TaskManager();
    const agentRegistry = new AgentRegistry();
    const concurrencyController = new ConcurrencyController();
    const subAgentRuntime = new SubAgentRuntime({ agentRegistry, concurrencyController });
    const teamRuntime = new TeamRuntime({
      name: "Schema Test Team",
      leaderId: "lead",
      taskManager,
      agentRegistry,
      concurrencyController,
    });
    const planMode = new PlanMode();

    const registry = createDefaultToolRegistry({
      taskManager,
      subAgentRuntime,
      agentRegistry,
      teamRuntime,
      planMode,
    });

    const definitions = registry.getDefinitions();
    const toolNames = definitions.map((d) => d.function.name);

    // 基础工具
    assert(toolNames.includes("bash"));
    assert(toolNames.includes("read_file"));
    assert(toolNames.includes("write_file"));
    assert(toolNames.includes("edit_file"));

    // Task 编排工具
    assert(toolNames.includes("create_task"));
    assert(toolNames.includes("update_task"));
    assert(toolNames.includes("complete_task"));
    assert(toolNames.includes("block_task"));
    assert(toolNames.includes("list_tasks"));

    // SubAgent 工具
    assert(toolNames.includes("spawn_agent"));
    assert(toolNames.includes("interrupt_agent"));
    assert(toolNames.includes("list_agents"));

    // Team 工具
    assert(toolNames.includes("spawn_teammate"));
    assert(toolNames.includes("assign_task"));
    assert(toolNames.includes("claim_task"));
    assert(toolNames.includes("send_message"));
    assert(toolNames.includes("list_team"));
    assert(toolNames.includes("wait_for_change"));

    // Plan 工具
    assert(toolNames.includes("enter_plan_mode"));
    assert(toolNames.includes("propose_plan"));

    // 校验每个工具定义的 JSON Schema 格式合法性
    for (const def of definitions) {
      assert.equal(def.type, "function");
      assert.ok(def.function.name);
      assert.ok(def.function.description);
      assert.equal(def.function.parameters?.type, "object");
    }
  });

  it("2. 共享工作区 (shared workspace) 下重叠 writeScopes 硬性并发互斥拦截", () => {
    const taskManager = new TaskManager();

    // Task 1: 声明负责 src/auth/**
    taskManager.createTask({
      id: "task-auth-core",
      subject: "Refactor core auth logic",
      writeScopes: ["src/auth/**"],
    });

    // Task 2: 声明负责具体的 src/auth/service.ts
    taskManager.createTask({
      id: "task-auth-service",
      subject: "Fix auth service bug",
      writeScopes: ["src/auth/service.ts"],
    });

    // Agent A 先认领 Task 1 变为 running
    taskManager.claimTask("task-auth-core", "agent-A");
    assert.equal(taskManager.getTask("task-auth-core")?.status, "running");

    // Agent B 尝试在共享工作区模式下并发认领 Task 2 -> 被第一层硬性互斥拦截 (WriteScopeConflictError)
    assert.throws(
      () => taskManager.claimTask("task-auth-service", "agent-B", undefined, { workspaceMode: "shared" }),
      (err: unknown) => {
        assert(err instanceof WriteScopeConflictError);
        assert.equal(err.code, "WRITE_SCOPE_CONFLICT");
        return true;
      }
    );

    // 若 Agent B 明确声明使用独立 worktree 模式，则允许并行认领
    const claimedInWorktree = taskManager.claimTask(
      "task-auth-service",
      "agent-B",
      undefined,
      { workspaceMode: "worktree" }
    );
    assert.equal(claimedInWorktree.status, "running");
  });

  it("3. Semaphore 深度嵌套递归与并发槽位让出 (Yield/Resume) 顺畅流转", async () => {
    const concurrency = new ConcurrencyController({
      maxConcurrentAgents: 2,
      maxAgentDepth: 4,
    });

    // 模拟层级: Main (depth=0) -> A (depth=1) -> B (depth=2) -> C (depth=3)
    const slotMain = await concurrency.acquireSlot();
    concurrency.registerAgentSpawn(0);

    // Main 派生 A 时让出槽位
    const resumeMain = concurrency.yieldSlot();
    const slotA = await concurrency.acquireSlot();
    concurrency.registerAgentSpawn(1, "main");

    // A 派生 B 时让出槽位
    const resumeA = concurrency.yieldSlot();
    const slotB = await concurrency.acquireSlot();
    concurrency.registerAgentSpawn(2, "A");

    // B 派生 C 时让出槽位
    const resumeB = concurrency.yieldSlot();
    const slotC = await concurrency.acquireSlot();
    concurrency.registerAgentSpawn(3, "B");

    // C 完成释放
    slotC();

    // B 恢复并完成
    await resumeB();
    slotB();

    // A 恢复并完成
    await resumeA();
    slotA();

    // Main 恢复并完成
    await resumeMain();
    slotMain();

    assert.equal(concurrency.getRunningCount(), 0);
  });

  it("4. 崩溃恢复后 running 状态任务安全自动收敛为 ready 并被重新成功认领", async (t) => {
    const tempDir = path.join(os.tmpdir(), `nash-crash-test-${Date.now()}`);
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    const sessionStore = new LocalSessionStore({ baseDir: tempDir });

    // 1. 模拟崩溃前记录了一系列事件，且 task-job 停留在 running 状态
    await sessionStore.appendDomainEvent("agent.spawned", {
      agent: {
        agentId: "dead-worker",
        name: "Worker",
        type: "team-member",
        depth: 1,
      },
    });

    await sessionStore.appendDomainEvent("task.created", {
      task: {
        id: "task-job",
        subject: "Process data pipeline",
        dependencies: [],
      },
    });

    await sessionStore.appendDomainEvent("task.started", {
      taskId: "task-job",
      agentId: "dead-worker",
    });

    // 2. 模拟进程 Crash 重启，执行冷重放与崩溃自愈 (Crash Recovery)
    const replayed = await SessionReplayEngine.replay(sessionStore, { autoRecoverRunning: true });

    assert.equal(replayed.recoveredTasksCount, 1);
    assert.equal(replayed.recoveredAgentsCount, 1);

    // 3. 验证原 running Agent 收敛为 interrupted
    const agentState = replayed.agentRegistry.getAgent("dead-worker");
    assert.equal(agentState?.status, "interrupted");

    // 4. 验证原 running Task 安全降级为 ready，且解除了已被销毁的 dead-worker 占用
    const taskState = replayed.taskManager.getTask("task-job");
    assert.equal(taskState?.status, "ready");
    assert.equal(taskState?.ownerAgentId, undefined);

    // 5. 新启动的 Agent 可以顺畅重新认领该任务并完成
    const newWorker = replayed.agentRegistry.register({
      agentId: "new-worker",
      type: "team-member",
      depth: 1,
    });

    const claimed = replayed.taskManager.claimTask("task-job", newWorker.agentId);
    assert.equal(claimed.status, "running");

    const completed = replayed.taskManager.completeTask("task-job", { summary: "Pipeline executed successfully" }, { agentId: newWorker.agentId });
    assert.equal(completed.status, "completed");

    await sessionStore.clear();
  });
});
