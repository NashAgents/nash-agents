import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  JobManager,
  ProcessJob,
  BoundedOutputBuffer,
  createJobListTool,
  createJobOutputTool,
  createJobKillTool,
  JobPermissionDeniedError,
} from "../src/jobs/index.js";
import { createBashTool } from "../src/tools/bash.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { EventBus } from "../src/observability/event-bus.js";
import type { HarnessEvent } from "../src/observability/types.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/tools/executor.js";

describe("Background Job Runtime & Tool Timing Subsystem", () => {
  let tempDir: string;
  let eventBus: EventBus;
  let sandboxService: SandboxService;
  let jobManager: JobManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-jobs-test-"));
    eventBus = new EventBus();
    sandboxService = new SandboxService({
      policy: createDefaultSandboxPolicy(),
      cwd: tempDir,
    });
    jobManager = new JobManager({
      eventBus,
      defaultProjectId: "test-proj",
      defaultSessionId: "test-sess",
      sandboxService,
    });
  });

  afterEach(async () => {
    await jobManager.cleanupAll();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("1. Bounded Output Buffer", () => {
    it("1.1 应正确捕获 stdout 与 stderr 并在限额内完整保留", () => {
      const buffer = new BoundedOutputBuffer({ maxRetainedBytes: 1024 });
      buffer.appendStdout("Hello stdout\n");
      buffer.appendStderr("Hello stderr\n");

      const snapshot = buffer.getSnapshot();
      assert.strictEqual(snapshot.totalBytes, 26);
      assert.strictEqual(snapshot.truncated, false);
      assert.strictEqual(snapshot.stdoutTail, "Hello stdout\n");
      assert.strictEqual(snapshot.stderrTail, "Hello stderr\n");
      assert.ok(snapshot.combinedTail.includes("Hello stdout\n"));
      assert.ok(snapshot.combinedTail.includes("Hello stderr\n"));
    });

    it("1.2 超过最大容量时应自动截断头部旧数据并保留尾部 (tail)", () => {
      const buffer = new BoundedOutputBuffer({ maxRetainedBytes: 100 });
      for (let i = 0; i < 50; i++) {
        buffer.appendStdout(`Line ${i}: some output data\n`);
      }

      const snapshot = buffer.getSnapshot();
      assert.ok(snapshot.totalBytes > 500);
      assert.strictEqual(snapshot.truncated, true);
      assert.ok(snapshot.retainedBytes <= 100);
      assert.ok(snapshot.stdoutTail.includes("Line 49:"));
    });

    it("1.3 getTailLines 应返回指定行数且不撑爆内存", () => {
      const buffer = new BoundedOutputBuffer();
      for (let i = 1; i <= 20; i++) {
        buffer.appendStdout(`Row ${i}\n`);
      }

      const tail = buffer.getTailLines(5);
      assert.ok(tail.includes("Row 20"));
      assert.ok(tail.includes("Row 16"));
      assert.ok(!tail.includes("Row 10\n"));
    });
  });

  describe("2. ProcessJob & Sandbox Isolation", () => {
    it("2.1 正常命令应在软超时前完成并输出结果", async () => {
      const job = jobManager.spawnJob({
        command: "echo 'ProcessJob Test 1'",
        ownerAgentId: "main",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
      });

      const record = await job.waitFor(5000);
      assert.strictEqual(record.status, "completed", JSON.stringify(record));
      assert.strictEqual(record.exitCode, 0);
      assert.ok(record.resultSummary?.includes("ProcessJob Test 1"));
    });

    it("2.2 失败命令应正确捕获退出码与 stderr", async () => {
      const job = jobManager.spawnJob({
        command: process.platform === "win32" ? "[Console]::Error.WriteLine('error message'); exit 42" : "echo 'error message' >&2; exit 42",
        ownerAgentId: "main",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
      });

      const record = await job.waitFor(5000);
      assert.strictEqual(record.status, "failed");
      assert.strictEqual(record.exitCode, 42);
      assert.ok(record.resultSummary?.includes("error message"));
    });

    it("2.3 硬超时 (hardTimeout) 到达时应发送 SIGTERM 并在宽限期后终止", async () => {
      const events: string[] = [];
      eventBus.subscribe("job.timed_out", () => {
        events.push("timed_out");
      });

      const job = jobManager.spawnJob({
        command: "sleep 10",
        ownerAgentId: "main",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
        timingPolicy: {
          hardTimeoutMs: 1000,
          killGraceMs: 400,
        },
      });

      const record = await job.waitFor(8000);
      assert.strictEqual(record.status, "timed_out");
      assert.ok(events.includes("timed_out"));
    });

    it("2.4 主动等待 (waitTimeout) 超时应返回 running 状态且绝对不杀掉底层进程", async () => {
      const job = jobManager.spawnJob({
        command: "sleep 1.5; echo 'Still alive'",
        ownerAgentId: "main",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
      });

      // 主动等待 100ms (小于 1500ms)
      const earlyRecord = await job.waitFor(100);
      assert.strictEqual(earlyRecord.status, "running");

      // 再次等待其真实完成
      const finalRecord = await job.waitFor(8000);
      assert.strictEqual(finalRecord.status, "completed");
      assert.ok(finalRecord.resultSummary?.includes("Still alive"));
    });

    it("2.5 后台 Job 必须继承 Sandbox 隔离策略 (写外部目录被阻断)", async () => {
      const outsidePath = path.join(os.tmpdir(), `nash-escape-${Date.now()}.txt`);
      const job = jobManager.spawnJob({
        command: `echo 'attack' > "${outsidePath}"`,
        ownerAgentId: "main",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
      });

      const record = await job.waitFor(5000);
      // macOS Seatbelt 或 Fail-Closed 会阻断对外部路径的写入
      if (process.platform === "darwin") {
        assert.ok(record.exitCode !== 0 || !fs.existsSync(outsidePath));
      }
      try {
        fs.unlinkSync(outsidePath);
      } catch {}
    });
  });

  describe("3. Bash Tool & Soft Timeout Auto-Promotion", () => {
    it("3.1 前台执行在 softTimeout 内完成直接返回标准输出", async () => {
      const bash = createBashTool({
        sandboxService,
        jobManager,
        ownerAgentId: "tester",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
        timingPolicy: {
          softTimeoutMs: 5000,
        },
      });

      const result = (await bash.execute({ command: "echo 'Fast sync test'" })) as string;
      assert.ok(result.includes("Fast sync test"));
      assert.ok(!result.includes('"promoted": true'));
    });

    it("3.2 超过 softTimeout 自动转入后台 (promoted=true) 且进程不中断", async () => {
      const bash = createBashTool({
        sandboxService,
        jobManager,
        ownerAgentId: "tester",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
        timingPolicy: {
          softTimeoutMs: 250, // 250ms 软超时
        },
      });

      const startTime = Date.now();
      const rawResult = (await bash.execute({
        command: "sleep 1.5; echo 'Promoted finished'",
      })) as string;
      const durationMs = Date.now() - startTime;

      // 验证返回时间在 250ms 左右，未阻塞 1500ms
      assert.ok(durationMs < 1200, `耗时 ${durationMs}ms 应接近 250ms 软超时且远小于 1500ms`);

      const parsed = JSON.parse(rawResult);
      assert.strictEqual(parsed.status, "running");
      assert.strictEqual(parsed.promoted, true);
      assert.ok(parsed.jobId);

      // 后台进程继续执行并最终成功 (高并发测试下容忍最长 8000ms 等待)
      const job = jobManager.getJob(parsed.jobId);
      assert.ok(job);
      const finalRec = await job.waitFor(8000);
      assert.strictEqual(finalRec.status, "completed");
      assert.ok(finalRec.resultSummary?.includes("Promoted finished"));
    });

    it("3.3 显式指定 background=true 立即返回 Job ID", async () => {
      const bash = createBashTool({
        sandboxService,
        jobManager,
        ownerAgentId: "builder",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
      });

      const startTime = Date.now();
      const rawResult = (await bash.execute({
        command: "sleep 0.2; echo 'Build complete'",
        background: true,
      })) as string;
      const durationMs = Date.now() - startTime;

      assert.ok(durationMs < 400, `主动后台化应在极短时间内瞬间返回，实际耗时 ${durationMs}ms`);

      const parsed = JSON.parse(rawResult);
      assert.strictEqual(parsed.status, "running");
      assert.ok(parsed.jobId);

      const job = jobManager.getJob(parsed.jobId);
      assert.ok(job);
      const finalRec = await job.waitFor(5000);
      assert.strictEqual(finalRec.status, "completed");
      assert.ok(finalRec.resultSummary?.includes("Build complete"));
    });
  });

  describe("4. Job Tools & Permission Isolation", () => {
    let listTool: any;
    let outputTool: any;
    let killTool: any;

    beforeEach(() => {
      listTool = createJobListTool(jobManager, "agent-a");
      outputTool = createJobOutputTool(jobManager, "agent-a");
      killTool = createJobKillTool(jobManager, "agent-a");
    });

    it("4.1 job_list 默认仅列出当前 Agent 拥有的 Job", async () => {
      jobManager.spawnJob({
        command: "echo 'Job A'",
        ownerAgentId: "agent-a",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
      });

      jobManager.spawnJob({
        command: "echo 'Job B'",
        ownerAgentId: "agent-b",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
      });

      const listOutput = (await listTool.execute({})) as string;
      assert.ok(listOutput.includes("agent-a"));
      assert.ok(!listOutput.includes("agent-b"));

      // Main / Lead 使用 all=true 可查看全局
      const leadListTool = createJobListTool(jobManager, "main");
      const globalOutput = (await leadListTool.execute({ all: true })) as string;
      assert.ok(globalOutput.includes("agent-a"));
      assert.ok(globalOutput.includes("agent-b"));
    });

    it("4.2 job_output 支持非阻塞与 wait=true 查询", async () => {
      const job = jobManager.spawnJob({
        command: "echo 'Output tool data'",
        ownerAgentId: "agent-a",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
      });

      const outputResult = (await outputTool.execute({
        jobId: job.id,
        wait: true,
      })) as string;

      assert.ok(outputResult.includes("Output tool data"));
      assert.ok(outputResult.includes(job.id));
      assert.ok(outputResult.includes("completed"));
    });

    it("4.3 job_kill 权限隔离：非 owner 且非 Lead 试图终止他人 Job 抛出 PermissionDenied", async () => {
      const jobB = jobManager.spawnJob({
        command: "sleep 5",
        ownerAgentId: "agent-b",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
      });

      // agent-a 尝试 kill agent-b 的 job
      await assert.rejects(
        async () => {
          await killTool.execute({ jobId: jobB.id });
        },
        (err: Error) => {
          return (
            err instanceof JobPermissionDeniedError &&
            err.message.includes("agent-a") &&
            err.message.includes("agent-b")
          );
        }
      );

      // agent-a 自身拥有的 job 可以正常 kill
      const jobA = jobManager.spawnJob({
        command: "sleep 5",
        ownerAgentId: "agent-a",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
      });

      const killResult = await killTool.execute({ jobId: jobA.id });
      assert.ok(killResult.includes("已成功终止"));
      assert.strictEqual(jobA.getRecord().status, "cancelled");
    });
  });

  describe("5. Session Cancellation & Crash Recovery", () => {
    it("5.1 会话清理 cleanupSession 能够清理属于该会话的所有运行中 Job，不遗留孤儿进程", async () => {
      const job1 = jobManager.spawnJob({
        command: "sleep 10",
        ownerAgentId: "agent-1",
        sessionId: "sess-clean",
        projectId: "proj-1",
        cwd: tempDir,
      });

      const job2 = jobManager.spawnJob({
        command: "sleep 10",
        ownerAgentId: "agent-2",
        sessionId: "sess-other",
        projectId: "proj-1",
        cwd: tempDir,
      });

      await jobManager.cleanupSession("sess-clean");

      assert.strictEqual(job1.getRecord().status, "cancelled");
      assert.strictEqual(job2.getRecord().status, "running");
    });

    it("5.2 崩溃恢复 (recoverSessionJobs) 将旧 running Job 安全收敛为 interrupted", () => {
      const mockSavedRecords: any[] = [
        {
          id: "job-old-1",
          status: "running",
          command: "npm test",
          ownerAgentId: "tester",
          sessionId: "sess-crash",
          projectId: "proj-1",
          startedAt: Date.now() - 10000,
        },
        {
          id: "job-old-2",
          status: "completed",
          command: "npm run build",
          ownerAgentId: "builder",
          sessionId: "sess-crash",
          startedAt: Date.now() - 20000,
          completedAt: Date.now() - 15000,
        },
      ];

      const recovered = jobManager.recoverSessionJobs(mockSavedRecords);
      const oldJob1 = recovered.find((r) => r.id === "job-old-1");
      const oldJob2 = recovered.find((r) => r.id === "job-old-2");

      assert.strictEqual(oldJob1?.status, "interrupted");
      assert.ok(oldJob1?.error?.includes("PROCESS_CRASH_RECOVERED"));
      assert.strictEqual(oldJob2?.status, "completed");
    });
  });
});
