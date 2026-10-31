import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  FileSystemAccess,
  createDefaultSandboxPolicy,
  FilesystemAccessDeniedError,
} from "../src/sandbox/index.js";
import {
  FileLockManager,
  FileObservationStore,
  StaleFileVersionError,
} from "../src/filesystem/index.js";
import { ConcurrencyController } from "../src/concurrency/index.js";
import { SubAgentRuntime, AgentRegistry } from "../src/agent/index.js";
import { Mailbox } from "../src/team/index.js";
import { LocalSessionStore } from "../src/context/session/local-session-store.js";
import { SessionReplayEngine } from "../src/orchestration/session-replay.js";
import { PlanMode } from "../src/plan/index.js";
import { WorktreeManager, DirtyWorkspaceError } from "../src/worktree/index.js";

describe("Production Readiness Audit Scenarios", () => {
  const testDir = path.join(os.tmpdir(), `nash-audit-test-${Date.now()}`);
  const targetFile = path.join(testDir, "concurrent-target.ts");

  before(async () => {
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(targetFile, "export const value = 0;", "utf-8");
  });

  after(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("审计点 1: 文件并发写入在 KeyedMutex 保护下原子执行，绝不发生静默覆盖", async () => {
    const lockManager = new FileLockManager();
    const observationStore = new FileObservationStore();

    const fsAccessA = new FileSystemAccess({
      workspaceRoot: testDir,
      policy: createDefaultSandboxPolicy(),
      agentId: "agent-A",
      lockManager,
      observationStore,
    });

    const fsAccessB = new FileSystemAccess({
      workspaceRoot: testDir,
      policy: createDefaultSandboxPolicy(),
      agentId: "agent-B",
      lockManager,
      observationStore,
    });

    // 1. Agent A 和 B 均读取了版本 v0
    await fsAccessA.resolveForRead("concurrent-target.ts");
    await fsAccessB.resolveForRead("concurrent-target.ts");

    // 2. A 和 B 几乎同时发起原子写操作
    const writePromiseA = fsAccessA.executeAtomicWrite("concurrent-target.ts", async (p) => {
      await fs.writeFile(p, "export const value = 1; // by A", "utf-8");
      return "written by A";
    });

    const writePromiseB = fsAccessB.executeAtomicWrite("concurrent-target.ts", async (p) => {
      await fs.writeFile(p, "export const value = 2; // by B", "utf-8");
      return "written by B";
    });

    const results = await Promise.allSettled([writePromiseA, writePromiseB]);

    // 必有且仅有一个成功，另一个必须被 StaleFileVersionError 拒绝，绝无静默覆盖
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert((rejected[0] as PromiseRejectedResult).reason instanceof StaleFileVersionError);
  });

  it("审计点 2: maxConcurrentAgents = 1 时，父 Agent 派生并等待子 Agent 不死锁 (Yield/Resume)", async () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController({ maxConcurrentAgents: 1 });

    // Main 占据了唯一的并发槽位
    const releaseMain = await concurrency.acquireSlot();
    assert.equal(concurrency.getRunningCount(), 1);

    // Main 即将 await 子 Agent，让出槽位 (yieldSlot)
    const resumeMain = concurrency.yieldSlot();
    assert.equal(concurrency.getRunningCount(), 0);

    // 子 Agent 能够顺利拿到槽位执行
    const releaseChild = await concurrency.acquireSlot();
    assert.equal(concurrency.getRunningCount(), 1);

    // 子 Agent 完成释放槽位
    releaseChild();
    assert.equal(concurrency.getRunningCount(), 0);

    // Main 顺利恢复槽位
    await resumeMain();
    assert.equal(concurrency.getRunningCount(), 1);
    releaseMain();
    assert.equal(concurrency.getRunningCount(), 0);
  });

  it("审计点 3: Mailbox 状态机 (pending -> delivered -> acknowledged / nack) 保证消息不丢失", () => {
    const mailbox = new Mailbox();

    const msg = mailbox.sendMessage({
      teamId: "audit-team",
      senderAgentId: "lead",
      targetAgentId: "worker-1",
      content: "Important migration task",
    });

    assert.equal(mailbox.getUnreadCount("worker-1"), 1);

    // Step Boundary 提取（标记为 delivered）
    const claimed = mailbox.claimPendingMessages("worker-1");
    assert.equal(claimed.length, 1);
    assert.equal(mailbox.getUnreadCount("worker-1"), 0);

    // 假设发生异常未完成，调用 nack 回滚
    mailbox.nackMessages("worker-1", [msg.messageId]);
    assert.equal(mailbox.getUnreadCount("worker-1"), 1);

    // 重新提取并在持久化后正式 ACK 确认
    const reclaimed = mailbox.claimPendingMessages("worker-1");
    assert.equal(reclaimed.length, 1);
    mailbox.acknowledgeMessages("worker-1", [msg.messageId]);

    // 最终完成归档
    assert.equal(mailbox.getUnreadCount("worker-1"), 0);
    assert.equal(mailbox.peekAllMessages("worker-1").length, 0);
  });

  it("审计点 4: session.jsonl 重放能 100% 还原运行时 Task / Agent 状态", async (t) => {
    const sessionDir = path.join(os.tmpdir(), `nash-session-test-${Date.now()}`);
    t.after(() => fs.rm(sessionDir, { recursive: true, force: true }));
    const sessionStore = new LocalSessionStore({
      baseDir: sessionDir,
    });

    // 1. 模拟持久化一系列领域事件到 session.jsonl
    await sessionStore.appendDomainEvent("agent.spawned", {
      agent: {
        agentId: "replayed-backend",
        name: "Backend",
        type: "team-member",
        depth: 1,
        role: "backend",
      },
    });

    await sessionStore.appendDomainEvent("task.created", {
      task: {
        id: "task-auth",
        subject: "Implement Auth",
        dependencies: [],
      },
    });

    await sessionStore.appendDomainEvent("task.started", {
      taskId: "task-auth",
      agentId: "replayed-backend",
    });

    await sessionStore.appendDomainEvent("task.completed", {
      taskId: "task-auth",
      result: { summary: "Auth completed" },
      agentId: "replayed-backend",
    });

    // 2. 从 session.jsonl 执行冷重放 (Replay)
    const replayed = await SessionReplayEngine.replay(sessionStore);

    assert.equal(replayed.eventCount, 4);

    const replayedAgent = replayed.agentRegistry.getAgent("replayed-backend");
    assert.ok(replayedAgent);
    assert.equal(replayedAgent.name, "Backend");

    const replayedTask = replayed.taskManager.getTask("task-auth");
    assert.ok(replayedTask);
    assert.equal(replayedTask.status, "completed");
    assert.equal(replayedTask.result?.summary, "Auth completed");

    await sessionStore.clear();
  });

  it("审计点 5: 进入 Plan Mode 后物理沙箱强制切为 read-only，拦截一切文件修改", async () => {
    const fsAccess = new FileSystemAccess({
      workspaceRoot: testDir,
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "ask" },
      },
    });

    const planMode = new PlanMode({ fsAccess });

    // 初始处于 workspace-write 模式
    assert.equal(fsAccess.getPolicy().filesystem.mode, "workspace-write");

    // 进入 Plan Mode
    planMode.enter("Research Architecture");
    assert.equal(fsAccess.getPolicy().filesystem.mode, "read-only");

    // 尝试在 Plan Mode 期间写入文件 -> 遭到安全策略直接拒绝
    await assert.rejects(
      async () => {
        await fsAccess.resolveForWrite("test.txt");
      },
      (err: unknown) => {
        assert(err instanceof FilesystemAccessDeniedError);
        assert.equal(err.operation, "write");
        return true;
      }
    );

    // 用户审批并退出 Plan Mode -> 安全策略自动恢复为 workspace-write
    planMode.proposePlan({ summary: "Plan", steps: [{ subject: "s1" }] });
    planMode.resolveApproval(true);
    planMode.exit();

    assert.equal(fsAccess.getPolicy().filesystem.mode, "workspace-write");
  });
});
