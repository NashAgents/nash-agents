import { describe, it } from "node:test";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { TaskManager } from "../src/task/task-manager.js";
import { ConcurrencyController } from "../src/concurrency/concurrency-controller.js";
import { SubAgentRuntime } from "../src/agent/subagent-runtime.js";
import { ApprovalService } from "../src/approval/approval-service.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { InputManager } from "../src/cli/input-manager.js";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { defineTool } from "../src/tools/tool.js";
import { PlanMode } from "../src/plan/plan-mode.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import type { SandboxPolicy } from "../src/sandbox/types.js";
import type { ApprovalRequest, ApprovalDecision } from "../src/approval/types.js";

function createMockTtyStream(columns = 80) {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  (stream as any).isTTY = true;
  (stream as any).columns = columns;

  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
  });

  return {
    stream,
    getOutput: () => buffer,
    clearBuffer: () => {
      buffer = "";
    },
  };
}

describe("Multi-Agent Approval Routing & Navigation Architecture", () => {
  describe("1. Keyboard Navigation & Mode Transitions", () => {
    it("1.1 导航模式正确捕获 ↑ / ↓ / Enter / Esc / ← / Ctrl+T", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      const inputManager = new InputManager({
        input: input as any,
        output: output as any,
        isTTY: true,
      });

      const events: string[] = [];
      const handler = {
        onKeyUp: () => events.push("up"),
        onKeyDown: () => events.push("down"),
        onMouseWheelUp: () => events.push("up"),
        onMouseWheelDown: () => events.push("down"),
        onKeyEnter: () => events.push("enter"),
        onKeyEscape: () => events.push("escape"),
        onKeyLeft: () => events.push("left"),
        onKeyCtrlT: () => events.push("ctrl-t"),
        onApprovalKey: (k: "y" | "n") => events.push(`approval:${k}`),
      };

      try {
        inputManager.startNavigationMode(handler);
        assert.equal(inputManager.getInteractionMode(), "navigation");

        // 发送按键
        input.write("\x1b[A"); // Up
        input.write("\x1b[B"); // Down
        input.write("\x14"); // Ctrl+T
        input.write("\r"); // Enter
        input.write("\x1b[D"); // Left
        input.write("\x1b"); // Esc
        input.write("y"); // y
        input.write("n"); // n

        await new Promise((r) => setTimeout(r, 20));

        assert.deepEqual(events, [
          "up",
          "down",
          "ctrl-t",
          "enter",
          "left",
          "escape",
          "approval:y",
          "approval:n",
        ]);

        inputManager.stopNavigationMode();
        assert.equal(inputManager.getInteractionMode(), "idle");
      } finally {
        inputManager.close();
      }
    });

    it("1.2 导航模式下的按键不会泄漏至随后的 readUserMessage Prompt 中", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      const inputManager = new InputManager({
        input: input as any,
        output: output as any,
        isTTY: true,
      });

      try {
        inputManager.startNavigationMode({
          onKeyUp: () => {},
        });

        // 在导航期间输入字符
        input.write("hello world");
        await new Promise((r) => setTimeout(r, 20));

        inputManager.stopNavigationMode();

        // 开始正常读取
        const readPromise = inputManager.readUserMessage("Prompt> ");
        input.write("actual input\r\n");

        const result = await readPromise;
        assert.equal(result, "actual input", "导航期间键入的内容绝不能泄漏到新 Prompt 中");
      } finally {
        inputManager.close();
      }
    });
  });

  describe("2. Transcript Stream & Bottom Panel Isolation", () => {
    it("2.1 Main 与 Child Agent 的 Transcript 彼此隔离，切换视图回放独立历史", async () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      const mock = createMockTtyStream(80);

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      try {
        presenter.startRun("Main Task");

        // 注册 Child Agent
        agentRegistry.register({
          agentId: "child-1",
          name: "code-scanner",
          type: "subagent",
          parentAgentId: "main",
        });

        // 发射 Main 的 Tool
        presenter.appendTranscript({
          id: "t1",
          agentId: "main",
          timestamp: Date.now(),
          kind: "tool_start",
          text: "  read_file: src/index.ts (Main only)",
        });

        // 发射 Child 的 Tool
        presenter.appendTranscript({
          id: "t2",
          agentId: "child-1",
          timestamp: Date.now(),
          kind: "tool_start",
          text: "  read_file: src/child.ts (Child only)",
        });

        await new Promise((r) => setTimeout(r, 80));

        const mainOutput = mock.getOutput();
        assert(mainOutput.includes("Main only"), "Main 视图应展示 Main 的 Transcript");
        assert.equal(mainOutput.includes("Child only"), false, "Main 视图不应混入 Child 的具体 Tool 细节");

        mock.clearBuffer();

        // 切换到 Child 视图 (在同一个 Application Screen 内独立呈现，不向 Main stdout 打印 banner)
        presenter.switchToAgentView("child-1");
        await new Promise((r) => setTimeout(r, 80));

        const childOutput = mock.getOutput();
        assert(childOutput.includes("code-scanner"));
        assert(childOutput.includes("Child only"), "Child 视图呈现其自己的 Transcript");
        assert.equal(childOutput.includes("Viewing Agent:"), false, "绝不向 Main stdout 输出 Viewing Agent banner");

        mock.clearBuffer();

        // 返回 Main 视图 (Main 干净恢复)
        presenter.returnToMainView();
        await new Promise((r) => setTimeout(r, 80));

        const backOutput = mock.getOutput();
        assert.equal(backOutput.includes("Returned to Main View"), false, "绝不向 Main stdout 输出 Returned to Main banner");
      } finally {
        presenter.stopRun();
        presenter.destroy();
      }
    });

    it("2.2 底部 Live Region 处于默认展开状态，Ctrl+T 收起/展开 Task 树", async () => {
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

      try {
        // 创建 Task
        taskManager.createTask({
          id: "task-1",
          subject: "Inspect system architecture",
        });

        presenter.startRun("Test Plan");
        await new Promise((r) => setTimeout(r, 80));

        const defaultOutput = mock.getOutput();
        assert(defaultOutput.includes("Plan (0/1)"), "新 Run 默认应展开 Plan 0/1");
        assert(defaultOutput.includes("Inspect system architecture"), "默认展开状态应展示 Task 详细内容");

        mock.clearBuffer();

        // 触发 Ctrl+T 折叠
        const nav = presenter.getNavigationHandler();
        nav.onKeyCtrlT?.();
        await new Promise((r) => setTimeout(r, 80));

        const collapsedOutput = mock.getOutput();
        assert(collapsedOutput.includes("(Ctrl+T expand)"), "按 Ctrl+T 后应折叠");

        // 再次触发 Ctrl+T 重新展开
        nav.onKeyCtrlT?.();
        await new Promise((r) => setTimeout(r, 80));

        const expandedOutput = mock.getOutput();
        assert(expandedOutput.includes("Inspect system architecture"), "再次按下应重新展开");
      } finally {
        presenter.stopRun();
        presenter.destroy();
      }
    });
  });

  describe("3. Multi-Agent Shared ApprovalQueue & Concurrency Slot Yielding", () => {
    it("3.1 审批等待期间主动调用 yieldSlot 释放并发槽位，审批完成后恢复", async () => {
      const concurrency = new ConcurrencyController({
        maxConcurrentAgents: 1, // 槽位上限为 1
      });

      let askCount = 0;
      let resolvePromise: ((decision: ApprovalDecision) => void) | null = null;

      const approvalService = new ApprovalService({
        provider: {
          askApproval: async (req) => {
            askCount++;
            return new Promise<ApprovalDecision>((res) => {
              resolvePromise = res;
            });
          },
        },
      });

      // 1. Agent 1 占有唯一槽位
      const release1 = await concurrency.acquireSlot();
      assert.equal(concurrency.getRunningCount(), 1);

      // 2. Agent 1 请求提权并让出槽位
      const requestPromise = approvalService.requestApproval(
        {
          capability: "filesystem-write",
          target: "outside.txt",
          reason: "Scan outside",
          agentId: "agent-1",
        },
        {
          yieldSlot: () => concurrency.yieldSlot(),
          agentId: "agent-1",
        }
      );

      // yieldSlot 调用后，running agents 应变为 0
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(concurrency.getRunningCount(), 0, "等待审批时必须让出并发槽位");
      assert.equal(approvalService.hasPending(), true);

      // 3. 此时 Agent 2 能够成功申请到执行槽位（无死锁）
      const release2 = await concurrency.acquireSlot();
      assert.equal(concurrency.getRunningCount(), 1);
      release2(); // Agent 2 结束工作释放槽位

      // 4. 用户批准 Agent 1 的请求
      assert(resolvePromise);
      (resolvePromise as any)("allow-once");

      const decision = await requestPromise;
      assert.equal(decision, "allow-once");

      // Agent 1 恢复后应重新占有槽位
      assert.equal(concurrency.getRunningCount(), 1, "审批恢复后应重新占用槽位");

      release1();
    });

    it("3.2 多个 Agent 并发请求审批时由 ApprovalQueue 严格按 FIFO 顺序排队", async () => {
      const order: string[] = [];

      const approvalService = new ApprovalService({
        provider: {
          askApproval: async (req) => {
            order.push(`ask:${req.agentId}`);
            return "allow-once";
          },
        },
      });

      const p1 = approvalService.requestApproval({
        capability: "filesystem-outside-workspace",
        reason: "Read A",
        agentId: "agent-a",
      });

      const p2 = approvalService.requestApproval({
        capability: "network",
        reason: "Access Net",
        agentId: "agent-b",
      });

      const p3 = approvalService.requestApproval({
        capability: "filesystem-write",
        reason: "Write C",
        agentId: "agent-c",
      });

      const results = await Promise.all([p1, p2, p3]);

      assert.deepEqual(results, ["allow-once", "allow-once", "allow-once"]);
      assert.deepEqual(order, ["ask:agent-a", "ask:agent-b", "ask:agent-c"], "必须按 FIFO 顺序排队处理");
    });

    it("3.3 Non-TTY 且无交互环境时严格 Fail-Closed (返回 deny)", async () => {
      const approvalService = new ApprovalService({
        isTTY: false,
        // 无 provider
      });

      const decision = await approvalService.requestApproval({
        capability: "filesystem-outside-workspace",
        reason: "Read outside",
        agentId: "subagent-1",
      });

      assert.equal(decision, "deny", "Non-TTY 无交互环境必须直接拒绝");
    });
  });

  describe("4. Sandbox Allow-Once, Structured Deny & Plan Mode Guarantees", () => {
    it("4.1 Allow-once 临时放行并重试一次，绝不污染全局 SandboxPolicy", async () => {
      const policy: SandboxPolicy = {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "ask" },
      };

      let approved = false;
      const approvalService = new ApprovalService({
        provider: {
          askApproval: async () => {
            approved = true;
            return "allow-once";
          },
        },
      });

      const fsAccess = new FileSystemAccess({
        workspaceRoot: process.cwd(),
        policy,
        approvalService,
        agentId: "test-agent",
      });

      const outsideFile = path.join(os.tmpdir(), "nash-allow-once-test.txt");
      const resolved = await fsAccess.resolveForRead(outsideFile);
      assert.equal(resolved, outsideFile);
      assert.equal(approved, true);

      // 全局 policy 未被修改
      assert.equal(policy.filesystem.mode, "workspace-write");
      assert.equal(policy.approval.mode, "ask");
    });

    it("4.2 用户拒绝审批时，ToolExecutor 返回 PERMISSION_DENIED 且 Agent 不发生崩溃", async () => {
      const approvalService = new ApprovalService({
        provider: {
          askApproval: async () => "deny",
        },
      });

      const policy: SandboxPolicy = {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "ask" },
      };
      const fsAccess = new FileSystemAccess({
        workspaceRoot: process.cwd(),
        policy,
        approvalService,
        agentId: "test-agent",
      });

      const registry = new ToolRegistry();
      registry.register(
        defineTool({
          name: "read_custom",
          async execute(args: any) {
            return await fsAccess.resolveForRead(args.path);
          },
        })
      );

      const executor = new ToolExecutor(registry);
      const result = await executor.execute("read_custom", { path: "/tmp/denied-file.txt" });

      assert.equal(result.success, false);
      assert.equal(result.error, "PERMISSION_DENIED");
      assert(result.output.includes("PERMISSION_DENIED"));
      assert(result.output.includes("Replan"));
    });

    it("4.3 Plan Mode 期间强制 approval: never，拦截一切写提权且不弹窗", async () => {
      let askCalled = false;
      const approvalService = new ApprovalService({
        provider: {
          askApproval: async () => {
            askCalled = true;
            return "allow-once";
          },
        },
      });

      const policy = createDefaultSandboxPolicy();
      const fsAccess = new FileSystemAccess({
        workspaceRoot: process.cwd(),
        policy,
        approvalService,
        agentId: "plan-agent",
      });

      const planMode = new PlanMode({
        fsAccess,
      });

      planMode.enter("Design refactor");

      // 在 Plan Mode 期间尝试写文件
      let writeError: Error | null = null;
      try {
        await fsAccess.resolveForWrite("/tmp/plan-write.txt");
      } catch (err: any) {
        writeError = err;
      }

      assert(writeError, "Plan Mode 下写操作必须被拦截");
      assert.equal(askCalled, false, "Plan Mode 下绝不能弹出写审批窗口");

      planMode.exit();
    });

    it("4.4 中断与取消时安全清理挂起的审批 Promise，不产生未处理异常", async () => {
      const approvalService = new ApprovalService({
        provider: {
          askApproval: async () => {
            return new Promise(() => {}); // 挂起
          },
        },
      });

      const reqPromise = approvalService.requestApproval({
        capability: "network",
        reason: "Test abort",
        agentId: "agent-interrupted",
      });

      await new Promise((r) => setTimeout(r, 10));
      assert.equal(approvalService.hasPending(), true);

      // 中断所有审批
      approvalService.abortAll("User cancelled");

      const decision = await reqPromise;
      assert.equal(decision, "deny", "中断时应收敛为 deny 终态并解析 Promise");
      assert.equal(approvalService.hasPending(), false);
    });
  });
});
