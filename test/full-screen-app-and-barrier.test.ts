import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { TaskManager } from "../src/task/task-manager.js";
import { PlanMode, TaskGraphBuilder } from "../src/plan/index.js";
import { DecisionController } from "../src/decision/index.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { TerminalRenderer, getVisibleWidth } from "../src/presentation/terminal-renderer.js";
import { AgentTranscriptProjection } from "../src/presentation/agent-transcript-projection.js";
import { InputManager } from "../src/cli/input-manager.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { SubAgentRuntime } from "../src/agent/subagent-runtime.js";
import { ConcurrencyController } from "../src/concurrency/index.js";
import { TeamRuntime } from "../src/team/index.js";

function createMockTtyStream(columns = 80, rows = 24) {
  const stream = new PassThrough() as any;
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = rows;
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

describe("Full-Screen Terminal Application, Layout, Cursor, Projection & Plan Barrier Suite", () => {
  describe("一、Terminal Layout (用例 1 ~ 12)", () => {
    it("1. interactive Nash 启动进入 app alternate screen", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.enterAppScreen();
      assert(mock.getOutput().includes("\x1b[?1049h"), "启动必须发送 \\x1b[?1049h 进入备用屏幕");
      presenter.leaveAppScreen();
      assert(mock.getOutput().includes("\x1b[?1049l"), "退出必须发送 \\x1b[?1049l 离开备用屏幕");
      presenter.destroy();
    });

    it("1.1 退出备用屏幕后不再向 Shell 主屏幕重绘", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });
      presenter.startRun("Inspect shutdown");
      presenter.destroy();
      const output = mock.getOutput();
      const leaveIndex = output.lastIndexOf("\x1b[?1049l");
      assert(leaveIndex >= 0, "退出时必须恢复 Shell 主屏幕");
      assert.equal(output.slice(leaveIndex).includes("\x1b[1;1H"), false, "恢复 Shell 后不得再绘制 Nash 界面");
    });

    it("2. Header 固定在第 1 行，包含品牌、状态与视图信息", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Inspect header");
      const out = mock.getOutput();
      assert(out.includes("\x1b[1;1H"), "Header 必须绘制在第一行 (1;1H)");
      assert(out.includes("Nash"), "必须包含 Nash 品牌名称");
      assert(out.includes("Main"), "默认视图为 Main");
      presenter.stopRun();
      presenter.destroy();
    });

    it("3. shell history 不进入 App screen", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Clean start");
      const out = mock.getOutput();
      assert(out.includes("\x1b[?1049h") && out.includes("\x1b[2J\x1b[H"), "全屏备用屏幕清空历史");
      presenter.stopRun();
      presenter.destroy();
    });

    it("4. Agents bottom row === terminal bottom rows", () => {
      const mock = createMockTtyStream(80, 24);
      const agentRegistry = new AgentRegistry();
      agentRegistry.register({ agentId: "main", type: "main" });
      agentRegistry.register({ agentId: "worker-1", name: "worker-1", type: "subagent" });

      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Check bottom");
      const out = mock.getOutput();
      assert(out.includes("\x1b[24;1H"), "最后一行 (行 24) 必须包含内容且属于 Agents 区域");
      presenter.stopRun();
      presenter.destroy();
    });

    it("5. Composer 直接位于 Agents 上方", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Check composer position");
      const out = mock.getOutput();
      assert(out.includes("> 给 Main 输入新的指令..."), "必须包含 Composer 区域");
      presenter.stopRun();
      presenter.destroy();
    });

    it("6. Plan 直接位于 Composer 上方", () => {
      const mock = createMockTtyStream(80, 24);
      const taskManager = new TaskManager();
      taskManager.createTask({ id: "t1", subject: "Task A" });

      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        taskManager,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Check plan position");
      const out = mock.getOutput();
      assert(out.includes("Plan (0/1)"), "Plan 必须位于 Composer 上方且展示进度");
      presenter.stopRun();
      presenter.destroy();
    });

    it("7. Transcript 使用剩余区域", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Analyze transcript region");
      const out = mock.getOutput();
      assert(out.includes("\x1b[2;1H"), "Transcript 起始行必须为第 2 行");
      presenter.stopRun();
      presenter.destroy();
    });

    it("8. 没有独立 Hints row 在 Agents 下方", () => {
      const mock = createMockTtyStream(80, 24);
      const agentRegistry = new AgentRegistry();
      agentRegistry.register({ agentId: "worker-1", name: "worker-1", type: "subagent" });
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Check hints");
      const out = mock.getOutput();
      assert(out.includes("↑↓ scroll · Ctrl+N/P select · Enter open"), "快捷键提示必须内联在 Agents 标题行右侧");
      assert.equal(out.includes("\x1b[25;1H"), false, "绝不在屏幕外第 25 行输出 Hints");
      presenter.stopRun();
      presenter.destroy();
    });

    it("9. Background Job 不改变 bottom layout 顺序", () => {
      const mock = createMockTtyStream(80, 24);
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry();
      agentRegistry.register({ agentId: "main", type: "main" });
      agentRegistry.register({ agentId: "worker-1", name: "worker-1", type: "subagent" });
      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Background layout");
      eventBus.emit({
        id: "e1",
        type: "job.started" as any,
        timestamp: new Date().toISOString(),
        projectId: "p1",
        sessionId: "s1",
        data: { id: "j1", command: "npm test", ownerAgentId: "main", startedAt: Date.now(), status: "running", backgroundRequested: true },
      });

      const out = mock.getOutput();
      assert(out.includes("Agents"), "多 Agent 下包含 Agents 面板");
      presenter.stopRun();
      presenter.destroy();
    });

    it("10. terminal resize 正确重新计算全屏 layout", () => {
      const mock = createMockTtyStream(100, 30);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Resize test");
      mock.clearBuffer();

      mock.stream.rows = 40;
      mock.stream.columns = 120;
      mock.stream.emit("resize");

      presenter.render();
      const out = mock.getOutput();
      assert(out.includes("\x1b[40;1H"), "在 40 行终端下，底部行定位为 40");
      presenter.stopRun();
      presenter.destroy();
    });

    it("11. Agent list 超高时使用 Viewport 限制高度", () => {
      const mock = createMockTtyStream(80, 24);
      const agentRegistry = new AgentRegistry();
      for (let i = 0; i < 20; i++) {
        agentRegistry.register({ agentId: `agent-${i}`, name: `agent-${i}`, type: "subagent" });
      }

      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Many agents");
      const out = mock.getOutput();
      assert(out.includes("agent-0"), "首屏展示前几个 Agent");
      assert.equal(out.includes("agent-19"), false, "超高 Agent 被视口安全截断，不撑爆全屏");
      presenter.stopRun();
      presenter.destroy();
    });

    it("12. Plan 超高时限制最大高度并提示 more tasks", () => {
      const mock = createMockTtyStream(80, 24);
      const taskManager = new TaskManager();
      for (let i = 0; i < 25; i++) {
        taskManager.createTask({ id: `task-${i}`, subject: `Subject ${i}` });
      }

      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        taskManager,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Large plan");
      const out = mock.getOutput();
      assert(out.includes("more tasks"), "超出高度时应提示 … more tasks");
      presenter.stopRun();
      presenter.destroy();
    });
  });

  describe("二、Cursor 与 CJK 显示定位 (用例 13 ~ 22)", () => {
    it("13. Composer focus 时显示光标 (show cursor)", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Cursor test");
      const out = mock.getOutput();
      assert(out.includes("\x1b[?25h"), "绘制完成后必须输出 \\x1b[?25h 显式开启光标");
      presenter.stopRun();
      presenter.destroy();
    });

    it("14. 光标精准定位在 ASCII 输入末尾", () => {
      const renderer = new TerminalRenderer({ stdout: createMockTtyStream(80, 24).stream, isTTY: true });
      const draft = "hello";
      const col = 3 + getVisibleWidth(draft);
      assert.equal(col, 8);
    });

    it("15. 光标精准定位在中文 (CJK 2 列) 输入末尾", () => {
      const draft = "你好世界";
      const col = 3 + getVisibleWidth(draft);
      assert.equal(col, 3 + 8, "4个中文字符占8列，加上前缀3列应为11");
    });

    it("16. 光标在 Emoji 后物理列宽计算正确", () => {
      const draft = "🚀 nash";
      const col = 3 + getVisibleWidth(draft);
      assert.equal(col, 3 + 2 + 1 + 4, "Emoji 2列 + 空格1列 + nash 4列");
    });

    it("17. left/right 方向键光标移动字形簇边界安全", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      const inputManager = new InputManager({ input: input as any, output: output as any, isTTY: true });
      inputManager.startNavigationMode({ onKeyUp: () => {} });
      inputManager.stopNavigationMode();

      const readPromise = inputManager.readUserMessage("> ");
      input.write("ab");
      input.write("\x1b[D"); // Left
      input.write("c");
      input.write("\r\n");

      const res = await readPromise;
      assert.equal(res, "acb", "向左移动光标后插入应在中间插入字符");
      inputManager.close();
    });

    it("18. backspace 正确删除前一个完整字形簇且无残影", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      const inputManager = new InputManager({ input: input as any, output: output as any, isTTY: true });
      const readPromise = inputManager.readUserMessage("> ");
      input.write("你好");
      input.write("\x7f"); // Backspace
      input.write("\r\n");

      const res = await readPromise;
      assert.equal(res, "你", "退格后应仅剩一个中文字符");
      inputManager.close();
    });

    it("19. redraw 后光标不掉落到屏幕最底部", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Check cursor stay");
      presenter.setComposerDraft("只看 MetroWise");
      const out = mock.getOutput();
      // 光标应在 Composer 所在行，而不是在第 24 行之后
      assert(out.includes(";17H\x1b[?25h") || out.includes(";18H\x1b[?25h") || out.includes("\x1b[?25h"));
      presenter.stopRun();
      presenter.destroy();
    });

    it("20. render 绝对不输出 trailing newline", () => {
      const mock = createMockTtyStream(80, 24);
      const renderer = new TerminalRenderer({ stdout: mock.stream, isTTY: true });

      mock.clearBuffer();
      renderer.renderFullScreen(["Line 1", "Line 2"], { row: 1, col: 1 });
      const raw = mock.getOutput();
      assert.equal(raw.endsWith("\n"), false, "全屏渲染绝对不能以 \\n 结尾以防产生滚动");
    });

    it("21. Decision 状态下 cursor 自动隐藏 (hidden)", () => {
      const mock = createMockTtyStream(80, 24);
      const decisionController = new DecisionController();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        decisionController,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Decision cursor");
      decisionController.requestDecision({
        kind: "plan-approval",
        title: "Plan ready",
        options: [{ id: "approve", label: "Approve" }],
      }).catch(() => {});

      presenter.render();
      const out = mock.getOutput();
      assert(out.endsWith("\x1b[?25l"), "Decision 状态下最后控制序列必须为隐藏光标 (\\x1b[?25l)");
      presenter.stopRun();
      presenter.destroy();
    });

    it("22. Agent View 中 Composer 光标位置正确", () => {
      const mock = createMockTtyStream(80, 24);
      const agentRegistry = new AgentRegistry();
      agentRegistry.register({ agentId: "agent-a", name: "agent-a", type: "subagent" });

      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Agent composer");
      presenter.switchToAgentView("agent-a");
      presenter.setComposerDraft("check tests");

      const out = mock.getOutput();
      assert(out.includes("agent-a"), "视图呈现 agent-a");
      assert(out.includes("check tests"), "呈现 draft 文本");
      assert(out.includes("\x1b[?25h"), "光标保持开启");
      presenter.stopRun();
      presenter.destroy();
    });
  });

  describe("三、Projection 隔离与 Presentation 产品化 (用例 23 ~ 32)", () => {
    it("23. Main 只显示 Main Tool Event", () => {
      const proj = new AgentTranscriptProjection("main");
      proj.addToolCallStart("call-m", "create_task", "构建多模块分析任务");
      proj.completeToolCall("call-m", "create_task", true, 2, "Task created");

      const lines = proj.getAllRenderedLines().join("\n");
      assert(lines.includes("create_task"));
      assert(lines.includes("构建多模块分析任务"));
    });

    it("24. Child bash 绝不进入 Main Transcript", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      const mock = createMockTtyStream(80, 24);

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Isolation check");
      mock.clearBuffer();

      // Child 发射 bash 工具事件
      eventBus.emit({
        id: "e-child-bash",
        type: "tool.started" as any,
        agentId: "child-agent-1",
        timestamp: new Date().toISOString(),
        projectId: "p1",
        sessionId: "s1",
        data: { name: "bash", args: { command: "python3 -c 'import torch; print(1)'" } },
      });

      presenter.render();
      const out = mock.getOutput();
      assert.equal(out.includes("python3 -c"), false, "Main Transcript 绝不出现 Child 的 bash 命令");
      presenter.stopRun();
      presenter.destroy();
    });

    it("25. Child read_file 绝不进入 Main Transcript", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      const mock = createMockTtyStream(80, 24);

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Read file isolation");
      mock.clearBuffer();

      eventBus.emit({
        id: "e-child-read",
        type: "tool.started" as any,
        agentId: "child-agent-2",
        timestamp: new Date().toISOString(),
        projectId: "p1",
        sessionId: "s1",
        data: { name: "read_file", args: { path: "secret/internal.ts" } },
      });

      presenter.render();
      const out = mock.getOutput();
      assert.equal(out.includes("secret/internal.ts"), false, "Main 绝不展示 Child 的 read_file 路径");
      presenter.stopRun();
      presenter.destroy();
    });

    it("26. Child background job 细节不进入 Main Transcript", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      const mock = createMockTtyStream(80, 24);

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Job isolation");
      mock.clearBuffer();

      eventBus.emit({
        id: "e-job",
        type: "job.started" as any,
        timestamp: new Date().toISOString(),
        projectId: "p1",
        sessionId: "s1",
        data: { id: "j-child", command: "pytest -v", ownerAgentId: "child-worker", startedAt: Date.now(), status: "running" },
      });

      presenter.render();
      const out = mock.getOutput();
      assert.equal(out.includes("pytest -v"), false, "Main 视图不展示 Child 具体的后台命令细节");
      presenter.stopRun();
      presenter.destroy();
    });

    it("27. Child Tool Result 绝不进入 Main Transcript", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      const mock = createMockTtyStream(80, 24);

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Result isolation");
      mock.clearBuffer();

      eventBus.emit({
        id: "e-child-res",
        type: "tool.completed" as any,
        agentId: "child-agent-3",
        timestamp: new Date().toISOString(),
        projectId: "p1",
        sessionId: "s1",
        data: { name: "grep_search", durationMs: 120, preview: "FOUND SECRET KEY 123456" },
      });

      presenter.render();
      const out = mock.getOutput();
      assert.equal(out.includes("FOUND SECRET KEY"), false, "Child 工具输出绝不进入 Main");
      presenter.stopRun();
      presenter.destroy();
    });

    it("28. Child started 高层生命周期摘要可进入 Main", () => {
      const proj = new AgentTranscriptProjection("main");
      proj.addChildLifecycleNotice("ai-analyzer", "started");
      const lines = proj.getAllRenderedLines().join("\n");
      assert(lines.includes("ai-analyzer started"), "Main 应展示子 Agent 的 started 高层摘要");
    });

    it("29. Child completed 高层生命周期摘要可进入 Main", () => {
      const proj = new AgentTranscriptProjection("main");
      proj.addChildLifecycleNotice("data-analyzer", "completed");
      const lines = proj.getAllRenderedLines().join("\n");
      assert(lines.includes("data-analyzer completed ✓"), "Main 应展示子 Agent 的 completed 高层摘要");
    });

    it("30. Agent Detail 视图展示该 Child 完整 Tool Loop", () => {
      const proj = new AgentTranscriptProjection("child-analyzer");
      proj.addThought();
      proj.addToolCallStart("c1", "read_file", "pyproject.toml");
      proj.completeToolCall("c1", "read_file", true, 2, "version = 1.0");
      proj.addToolCallStart("c2", "bash", "pytest");
      proj.completeToolCall("c2", "bash", true, 800, "10 passed");

      const lines = proj.getAllRenderedLines().join("\n");
      assert(lines.includes("pyproject.toml"));
      assert(lines.includes("pytest"));
      assert(lines.includes("10 passed"));
    });

    it("31. agent displayName 优先于 agentId 显示", () => {
      const agentRegistry = new AgentRegistry();
      agentRegistry.register({
        agentId: "agent-9776d30e",
        name: "data-intelligence-analyzer",
        type: "subagent",
      });

      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Display name check");
      const out = mock.getOutput();
      assert(out.includes("data-intelligence-analyzer"), "界面应优先展示可读名称");
      presenter.stopRun();
      presenter.destroy();
    });

    it("32. Main Tool 不污染 Child Transcript", () => {
      const childProj = new AgentTranscriptProjection("child-isolated");
      assert.equal(childProj.getAllRenderedLines().length, 0);
    });
  });

  describe("四、Plan Approval Runtime Execution Barrier (用例 33 ~ 46)", () => {
    it("33. propose_plan 后 status 进入 proposed / awaiting_approval", () => {
      const planMode = new PlanMode();
      planMode.enter("重构方案设计");
      planMode.proposePlan({
        summary: "重构方案概要",
        steps: [{ subject: "步骤 1" }],
      });

      assert.equal(planMode.getState(), "proposed");
    });

    it("34. propose_plan 真正 await Human Decision (挂起执行)", async () => {
      const decisionController = new DecisionController();
      const planMode = new PlanMode({ decisionController });
      planMode.enter("方案设计");

      let resolved = false;
      const approvalPromise = planMode.requestApproval({
        summary: "方案详情",
        steps: [{ subject: "步骤 A" }],
      }).then(() => {
        resolved = true;
      });

      assert.equal(decisionController.hasActiveDecision(), true);
      assert.equal(resolved, false, "在决策完成前 Promise 必须处于挂起状态");

      decisionController.confirmSelected(); // 确认 Approve
      await approvalPromise;
      assert.equal(resolved, true, "确认后 Promise 恢复完成");
    });

    it("35. Run 不提前 finalize，保持在 Barrier 状态", () => {
      const decisionController = new DecisionController();
      decisionController.requestDecision({
        kind: "plan-approval",
        title: "Plan Approval Barrier",
        options: [{ id: "approve", label: "Approve" }],
      });

      assert.equal(decisionController.hasActiveDecision(), true);
    });

    it("36. normal Composer 在 Plan 审批期间不恢复（排他性渲染选择器）", () => {
      const mock = createMockTtyStream(80, 24);
      const decisionController = new DecisionController();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        decisionController,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Awaiting decision");
      decisionController.requestDecision({
        kind: "plan-approval",
        title: "Plan ready for approval",
        options: [{ id: "approve", label: "Approve & execute" }],
      }).catch(() => {});

      presenter.render();
      const out = mock.getOutput();
      assert(out.includes("Approve & execute"), "必须展示选择器");
      assert.equal(out.includes("Type to steer"), false, "普通 Composer 提示不可见");
      presenter.stopRun();
      presenter.destroy();
    });

    it("37. approve 前 Active TaskGraph 不存在任何已激活任务", () => {
      const taskManager = new TaskManager();
      assert.equal(taskManager.getTasks().length, 0);
    });

    it("38. approve 前调用 spawn_agent 执行任务被严格拦截阻断", async () => {
      const planMode = new PlanMode();
      planMode.enter("调研阶段");

      const agentRegistry = new AgentRegistry();
      const concurrencyController = new ConcurrencyController();
      const subAgentRuntime = new SubAgentRuntime({ agentRegistry, concurrencyController });

      const registry = createDefaultToolRegistry({ planMode, agentRegistry, subAgentRuntime });
      const spawnTool = registry.getTool("spawn_agent");

      const result = await spawnTool?.execute({ prompt: "开始执行代码重构" });
      assert(String(result).includes("当前处于 Plan Mode (exploring) 状态，在方案获得用户批准前禁止派生执行子 Agent"));
    });

    it("39. approve 前调用 create_task / assign_task 被严格拦截阻断", async () => {
      const planMode = new PlanMode();
      planMode.enter("调研阶段");
      const taskManager = new TaskManager();

      const registry = createDefaultToolRegistry({ planMode, taskManager });
      const createTaskTool = registry.getTool("create_task");

      const result = await createTaskTool?.execute({ subject: "提前创建执行任务" });
      assert(String(result).includes("当前处于 Plan Mode (exploring) 状态，在方案获得用户批准前禁止直接创建 Active Task"));
      assert.equal(taskManager.getTasks().length, 0);
    });

    it("40. approve 后才通过 TaskGraphBuilder 构建 Active TaskGraph", async () => {
      const taskManager = new TaskManager();
      const planMode = new PlanMode({ taskManager });
      planMode.enter("设计目标");

      planMode.proposePlan({
        summary: "方案",
        steps: [
          { id: "s1", subject: "步骤 1" },
          { id: "s2", subject: "步骤 2", dependencies: ["s1"] },
        ],
      });

      assert.equal(taskManager.getTasks().length, 0);

      planMode.resolveApproval(true);
      assert.equal(taskManager.getTasks().length, 2);
      assert.equal(taskManager.getTasks()[0].subject, "步骤 1");
    });

    it("41. approve 退出 Plan Mode 后才允许派生执行 Agent", async () => {
      const planMode = new PlanMode();
      planMode.enter("目标");
      planMode.proposePlan({ summary: "s", steps: [{ subject: "a" }] });
      planMode.resolveApproval(true);
      planMode.exit();

      assert.equal(planMode.getState(), "executed");
    });

    it("42. revise 操作不 activate TaskGraph", async () => {
      const taskManager = new TaskManager();
      const planMode = new PlanMode({ taskManager });
      planMode.enter("目标");
      planMode.proposePlan({ summary: "初步", steps: [{ subject: "a" }] });

      planMode.submitRevision("需要增加安全检查");
      assert.equal(planMode.getState(), "exploring");
      assert.equal(taskManager.getTasks().length, 0, "Revise 绝不创建 Active Task");
    });

    it("43. revise 后重新调整并再次进入 approval", async () => {
      const planMode = new PlanMode();
      planMode.enter("目标");
      planMode.proposePlan({ summary: "v1", steps: [{ subject: "a" }] });
      planMode.submitRevision("修改意见");

      const newPlan = planMode.proposePlan({ summary: "v2", steps: [{ subject: "a" }, { subject: "b" }] });
      assert.equal(newPlan.steps.length, 2);
      assert.equal(planMode.getState(), "proposed");
    });

    it("44. cancel 终止方案且不执行任何 Task", () => {
      const taskManager = new TaskManager();
      const planMode = new PlanMode({ taskManager });
      planMode.enter("目标");
      planMode.proposePlan({ summary: "方案", steps: [{ subject: "a" }] });
      planMode.resolveApproval(false, "Cancel");

      assert.equal(planMode.getState(), "rejected");
      assert.equal(taskManager.getTasks().length, 0);
    });

    it("45. 普通文本‘批准’不具备控制协议作用", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      const inputManager = new InputManager({ input: input as any, output: output as any, isTTY: true });
      const readPromise = inputManager.readUserMessage("Nash > ");
      input.write("批准\r\n");

      const res = await readPromise;
      assert.equal(res, "批准", "文本作为普通消息原样返回，不自动改变状态机");
      inputManager.close();
    });

    it("46. DecisionController 是唯一的审批权威与控制来源", async () => {
      const controller = new DecisionController();
      let approved = false;

      const p = controller.requestDecision({
        kind: "plan-approval",
        title: "Authority check",
        options: [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }],
      }).then((opt) => {
        if (opt === "approve") approved = true;
      });

      controller.confirmSelected();
      await p;
      assert.equal(approved, true);
    });
  });
});
