import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { LinuxBubblewrapBackend } from "../src/sandbox/backends/linux-bubblewrap.js";
import { JobManager } from "../src/jobs/job-manager.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { EventBus } from "../src/observability/event-bus.js";

describe("Linux Sandbox Process E2E Tests (进程树治理与防孤儿泄漏)", { skip: process.platform !== "linux" ? "Requires Linux platform" : false }, () => {
  let workspaceRoot: string;
  let backend: LinuxBubblewrapBackend;
  let sandboxService: SandboxService;
  let jobManager: JobManager;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nash-proc-ws-"));
    backend = new LinuxBubblewrapBackend();
    sandboxService = new SandboxService({
      backend,
      policy: createDefaultSandboxPolicy(),
      cwd: workspaceRoot,
    });
    jobManager = new JobManager({
      eventBus: new EventBus(),
      sandboxService,
    });
  });

  afterEach(async () => {
    await jobManager.cleanupAll();
    if (fsSync.existsSync(workspaceRoot)) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 40. bash 直接子进程被取消
  // =========================================================================
  it("40. bash child 被取消: 主动取消单个 bash 睡眠子进程并回收", async () => {
    const job = jobManager.spawnJob({
      command: "sleep 30",
      ownerAgentId: "main",
      sessionId: "s1",
      projectId: "p1",
      cwd: workspaceRoot,
    });

    assert.strictEqual(job.getRecord().status, "running");
    await new Promise((r) => setTimeout(r, 200));

    await jobManager.killJob(job.id, "main");
    assert.strictEqual(job.getRecord().status, "cancelled");
  });

  // =========================================================================
  // 41. bash -> node child tree 被取消 (防孙进程残留)
  // =========================================================================
  it("41. bash -> node child tree 被取消: 杀死进程组时孙进程 node 同步退出", async () => {
    const token = `token_node_${Date.now()}`;
    const job = jobManager.spawnJob({
      command: `node -e "setInterval(() => { /* ${token} */ }, 1000)"`,
      ownerAgentId: "main",
      sessionId: "s2",
      projectId: "p2",
      cwd: workspaceRoot,
    });

    await new Promise((r) => setTimeout(r, 600));

    // 确认该 node 进程在运行
    const psBefore = execSync(`ps aux | grep "${token}" | grep -v grep || true`, {
      encoding: "utf-8",
    });
    assert.ok(psBefore.includes(token), "Node 子孙进程必须已经启动");

    // 取消 Job
    await jobManager.killJob(job.id, "main");
    await new Promise((r) => setTimeout(r, 600));

    // 验证进程树无残留
    const psAfter = execSync(`ps aux | grep "${token}" | grep -v grep || true`, {
      encoding: "utf-8",
    });
    assert.strictEqual(psAfter.trim(), "", "Node 孙进程必须被彻底回收，零残留");
  });

  // =========================================================================
  // 42. npm / 复杂命令 worker tree 被取消
  // =========================================================================
  it("42. worker tree 被取消: bash 派生的多层 worker 进程被完整杀死", async () => {
    const token = `worker_sub_${Date.now()}`;
    const script = `python3 -c "import time; time.sleep(30)" # ${token}`;
    const job = jobManager.spawnJob({
      command: script,
      ownerAgentId: "main",
      sessionId: "s3",
      projectId: "p3",
      cwd: workspaceRoot,
    });

    await new Promise((r) => setTimeout(r, 500));
    await jobManager.killJob(job.id, "main");
    await new Promise((r) => setTimeout(r, 500));

    const psAfter = execSync(`ps aux | grep "${token}" | grep -v grep || true`, {
      encoding: "utf-8",
    });
    assert.strictEqual(psAfter.trim(), "", "多层 worker 进程必须被安全回收");
  });

  // =========================================================================
  // 43. hard timeout 到达时无残留进程
  // =========================================================================
  it("43. hard timeout 无残留进程: 触发硬超时后整个隔离沙箱进程树安全退出", async () => {
    const token = `timeout_marker_${Date.now()}`;
    const job = jobManager.spawnJob({
      command: `node -e "setInterval(() => { /* ${token} */ }, 1000)"`,
      ownerAgentId: "main",
      sessionId: "s4",
      projectId: "p4",
      cwd: workspaceRoot,
      timingPolicy: {
        hardTimeoutMs: 1000,
        killGraceMs: 500,
      },
    });

    // 等待硬超时触发
    await job.waitFor(3000);
    assert.strictEqual(job.getRecord().status, "timed_out");

    await new Promise((r) => setTimeout(r, 600));
    const psAfter = execSync(`ps aux | grep "${token}" | grep -v grep || true`, {
      encoding: "utf-8",
    });
    assert.strictEqual(psAfter.trim(), "", "超时后底层进程树必须被完全回收");
  });

  // =========================================================================
  // 44. Session / Run cleanupSession 全部回收
  // =========================================================================
  it("44. Run interrupt 无残留: cleanupSession 能够批量收敛会话下的全部 Job", async () => {
    const tokenA = `sess_tok_A_${Date.now()}`;
    const tokenB = `sess_tok_B_${Date.now()}`;

    jobManager.spawnJob({
      command: `sleep 30 # ${tokenA}`,
      ownerAgentId: "main",
      sessionId: "sess-to-clean",
      projectId: "p5",
      cwd: workspaceRoot,
    });

    jobManager.spawnJob({
      command: `sleep 30 # ${tokenB}`,
      ownerAgentId: "main",
      sessionId: "sess-to-clean",
      projectId: "p5",
      cwd: workspaceRoot,
    });

    await new Promise((r) => setTimeout(r, 300));
    await jobManager.cleanupSession("sess-to-clean");
    await new Promise((r) => setTimeout(r, 300));

    const psAfter = execSync(`ps aux | grep "sess_tok_" | grep -v grep || true`, {
      encoding: "utf-8",
    });
    assert.strictEqual(psAfter.trim(), "", "会话清理后不留任何孤儿进程");
  });

  // =========================================================================
  // 45. 崩溃自愈：旧 running 记录收敛为 interrupted
  // =========================================================================
  it("45. Nash crash/recovery 不把旧 Job 误标 running", () => {
    const staleRecords: any[] = [
      {
        id: "job-old-1",
        status: "running",
        command: "npm run build",
        ownerAgentId: "main",
        sessionId: "s-old",
        projectId: "p-old",
      },
      {
        id: "job-old-2",
        status: "completed",
        command: "echo done",
        ownerAgentId: "main",
        sessionId: "s-old",
        projectId: "p-old",
      },
    ];

    const recovered = jobManager.recoverSessionJobs(staleRecords);
    assert.strictEqual(recovered[0].status, "interrupted");
    assert.ok(recovered[0].error?.includes("PROCESS_CRASH_RECOVERED"));
    assert.strictEqual(recovered[1].status, "completed");
  });
});
