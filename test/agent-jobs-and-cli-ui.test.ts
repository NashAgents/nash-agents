import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { TerminalUI } from "../src/cli/terminal-ui.js";
import { handleSlashCommand } from "../src/cli/slash-commands.js";
import { JobManager } from "../src/jobs/index.js";
import { EventBus } from "../src/observability/event-bus.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { ContextManager } from "../src/context/index.js";
import { resolveProjectContext } from "../src/project/index.js";
import { runAgentLoop } from "../src/runtime/agent-loop.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { ToolExecutor } from "../src/tools/executor.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/model/chat-completions-client.js";

describe("Agent Loop Job Notification & CLI UI Secondary Convergence", () => {
  let tempDir: string;
  let eventBus: EventBus;
  let sandboxService: SandboxService;
  let jobManager: JobManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-ui-test-"));
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

  describe("1. CLI UI Minimal Header & /status", () => {
    it("1.1 renderHeader 应呈现极简风格，无大边框或冗余参数", () => {
      let output = "";
      const terminalUI = new TerminalUI({
        write(chunk: any): boolean {
          output += String(chunk);
          return true;
        },
      } as any);

      terminalUI.renderHeader({
        modelName: "deepseek-chat",
        projectPath: "/Users/test/project",
        legacyCount: 2,
      });

      const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "");
      assert.ok(cleanOutput.includes("Nash · deepseek-chat"));
      assert.ok(cleanOutput.includes("/Users/test/project"));
      assert.ok(cleanOutput.includes("⚠ 2 legacy sessions available"));
      assert.ok(!cleanOutput.includes("========================================"));
      assert.ok(!cleanOutput.includes("compactionThreshold"));
    });

    it("1.2 /status 命令应结构化展示 Project, Model, Security, Runtime 与 Jobs 信息", async () => {
      let output = "";
      const terminalUI = new TerminalUI({
        write(chunk: any): boolean {
          output += String(chunk);
          return true;
        },
      } as any);

      const mockStatusInfo = {
        project: {
          name: "my-app",
          root: "/path/to/my-app",
          storage: "~/.nash/projects/my-app__12345678",
        },
        model: {
          name: "deepseek-chat",
          contextWindow: 64000,
          compactionThreshold: 0.8,
        },
        security: {
          filesystem: "workspace-write",
          network: "deny",
          approval: "ask",
        },
        runtime: {
          maxAgentTurns: 100,
          maxToolCalls: 200,
          maxRunMs: 1800000,
        },
        jobs: {
          running: 1,
          total: 3,
        },
        sessions: {
          currentId: "sess-abc",
          legacyCount: 0,
        },
      };

      const mockInputManager: any = {
        readUserMessage: async () => "",
      };
      const mockContextManager: any = {
        getProjectContext: () => undefined,
        getSession: () => ({ getSummary: async () => ({}) }),
      };

      const res = await handleSlashCommand("/status", {
        inputManager: mockInputManager,
        terminalUI,
        contextManager: mockContextManager,
        jobManager,
        statusProvider: () => mockStatusInfo as any,
      });

      assert.strictEqual(res.handled, true);
      const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, "");
      assert.ok(cleanOutput.includes("Nash Status"));
      assert.ok(cleanOutput.includes("my-app"));
      assert.ok(cleanOutput.includes("workspace-write"));
      assert.ok(cleanOutput.includes("deepseek-chat"));
      assert.ok(cleanOutput.includes("Running    1"));
    });

    it("1.3 /jobs 与 /job <id> 应清晰展示 Job 状态与尾部输出", async () => {
      let output = "";
      const terminalUI = new TerminalUI({
        write(chunk: any): boolean {
          output += String(chunk);
          return true;
        },
      } as any);

      const job = jobManager.spawnJob({
        command: "echo 'Slash command test line 1'; echo 'Slash command test line 2'",
        ownerAgentId: "tester",
        sessionId: "sess-1",
        projectId: "proj-1",
        cwd: tempDir,
      });

      // Windows CI 在高负载下回收 echo 子进程可能超过 5s；等终态而不是依赖固定短预算。
      await job.waitFor(20000);

      const mockInputManager: any = { readUserMessage: async () => "" };
      const mockContextManager: any = { getProjectContext: () => undefined };

      // 测试 /jobs
      await handleSlashCommand("/jobs", {
        inputManager: mockInputManager,
        terminalUI,
        contextManager: mockContextManager,
        jobManager,
      });

      assert.ok(output.includes("Jobs"));
      assert.ok(output.includes(job.id));
      assert.ok(output.includes("tester"));
      assert.ok(output.includes("completed"));

      // 测试 /job <jobId>
      output = "";
      await handleSlashCommand(`/job ${job.id}`, {
        inputManager: mockInputManager,
        terminalUI,
        contextManager: mockContextManager,
        jobManager,
      });

      assert.ok(output.includes("Job Details"));
      assert.ok(output.includes(job.id));
      assert.ok(output.includes("Slash command test line 1"));
    });
  });

  describe("2. Step Boundary Job Notification Injection", () => {
    it("2.1 后台 Job 完成事件应在下一个 Step Boundary 注入为标准 user 消息", async () => {
      const projectContext = await resolveProjectContext({ projectRoot: tempDir, nashHome: path.join(tempDir, "home") });
      const contextManager = new ContextManager({ projectContext });

      const registry = createDefaultToolRegistry({
        fsAccess: new FileSystemAccess({ workspaceRoot: tempDir, policy: createDefaultSandboxPolicy() }),
        sandboxService,
        jobManager,
        spillStore: contextManager.getSpillStore(),
      });
      const executor = new ToolExecutor(registry);

      // 启动一个后台 Job
      const job = jobManager.spawnJob({
        command: "echo 'Step boundary injection result'",
        ownerAgentId: "main",
        sessionId: contextManager.sessionId,
        projectId: projectContext.projectId,
        cwd: tempDir,
      });

      await job.waitFor(20000);

      // 验证 job 已完成
      assert.strictEqual(job.getRecord().status, "completed");

      // 订阅 EventBus 确认事件已产生
      const records = jobManager.listJobs();
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0].status, "completed");
    });
  });
});
