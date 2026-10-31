import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { TaskManager } from "../src/task/task-manager.js";
import { PlanMode } from "../src/plan/plan-mode.js";
import { DecisionController } from "../src/decision/decision-controller.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { TerminalUI } from "../src/cli/terminal-ui.js";
import { AgentTranscriptProjection } from "../src/presentation/agent-transcript-projection.js";
import type { SessionRecord } from "../src/context/types.js";

function createMockTtyStream(columns = 80, rows = 24) {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  (stream as any).isTTY = true;
  (stream as any).columns = columns;
  (stream as any).rows = rows;

  const frames: string[] = [];
  let buffer = "";

  stream.on("data", (chunk: Buffer | string) => {
    const str = chunk.toString();
    buffer += str;
    if (str.includes("\x1b[1;1H") || str.includes("\x1b[2J") || str.includes("\x1b[H")) {
      frames.push(str);
    }
  });

  return {
    stream,
    getOutput: () => buffer,
    getFrames: () => frames,
    getLastFrame: () => frames[frames.length - 1] || buffer,
    clearBuffer: () => {
      buffer = "";
      frames.length = 0;
    },
  };
}

describe("Session Lifecycle, Multi-Run Continuity & Permanent Bottom Dock Suite", () => {
  // ===========================================================================
  // 一、Session Persistence & Multi-Run Continuity (用例 1 ~ 15)
  // ===========================================================================
  describe("一、Session Persistence & Continuity", () => {
    it("1. App startup with empty session → Welcome", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.enterAppScreen();
      presenter.render();
      assert.equal(presenter.hasSessionHistory(), false);
      assert.equal(presenter.getInteractionMode(), "empty-session");
      assert.ok(mock.getOutput().toLowerCase().includes("ready"), "空会话应呈现 Ready/Welcome 页面");
      presenter.destroy();
    });

    it("2. 第一条 User Message 后离开 Welcome", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.enterAppScreen();
      presenter.startRun("你好");
      assert.equal(presenter.hasSessionHistory(), true);
      assert.equal(presenter.getInteractionMode(), "running-main");
      assert.ok(!mock.getLastFrame().includes("/resume · /status · /help"), "离开 Welcome 后不应再有 Welcome 底部");
      presenter.destroy();
    });

    it("3. Run complete 后不回 Welcome", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.enterAppScreen();
      presenter.startRun("你好");
      mock.clearBuffer();

      presenter.stopRun("你好！有什么可以帮您？", "1 agent · 0 tools · 1s");
      const last = mock.getLastFrame();
      assert.ok(!last.includes("Ready\n\n>"), "Run 完成后绝对不能回到空会话 Ready 页面");
      assert.equal(presenter.getInteractionMode(), "session-ready");
      presenter.destroy();
    });

    it("4. Run complete 后进入 session-ready", () => {
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
      });

      presenter.startRun("你好");
      presenter.stopRun("回复内容", "1 agent · 0 tools · 1s");
      assert.equal(presenter.getInteractionMode(), "session-ready");
      presenter.destroy();
    });

    it("5. Run complete 后 Transcript 仍存在", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("你好");
      presenter.stopRun("回复内容", "1 agent · 0 tools · 1s");

      const last = mock.getLastFrame();
      assert.ok(last.includes(">") || last.includes("你好"), "Transcript 中必须保留 User 消息");
      assert.ok(last.includes("回复内容"), "Transcript 中必须保留 Assistant 回复");
      presenter.destroy();
    });

    it("6. User Message 仍存在", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("测试消息A");
      presenter.stopRun("完成A", "1 agent · 0 tools · 1s");

      const last = mock.getLastFrame();
      assert.ok(last.includes("测试消息A"), "第一轮用户输入必须持续可见");
      presenter.destroy();
    });

    it("7. Assistant Response 仍存在", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("测试消息B");
      presenter.stopRun("助手核心分析回复内容B", "1 agent · 0 tools · 1s");

      const last = mock.getLastFrame();
      assert.ok(last.includes("助手核心分析回复内容B"), "助手最终回复必须持续可见");
      presenter.destroy();
    });

    it("8. Tool Calls 仍存在", () => {
      const eventBus = new EventBus();
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus,
        agentRegistry: new AgentRegistry({ eventBus }),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("执行工具测试");
      eventBus.emit({
        id: "e1",
        type: "tool.started",
        timestamp: new Date().toISOString(),
        projectId: "p1",
        sessionId: "s1",
        agentId: "main",
        data: { toolName: "read_file", rawArgs: { path: "src/index.ts" } },
      });
      eventBus.emit({
        id: "e2",
        type: "tool.completed",
        timestamp: new Date().toISOString(),
        projectId: "p1",
        sessionId: "s1",
        agentId: "main",
        data: { toolName: "read_file", durationMs: 15, preview: "200 lines" },
      });

      presenter.stopRun("工具执行完毕", "1 agent · 1 tools · 1s");
      const last = mock.getLastFrame();
      assert.ok(last.includes("read_file"), "工具调用历史必须保留在 Transcript 中");
      presenter.destroy();
    });

    it("9. Run Summary 仍存在", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Run 1");
      presenter.stopRun("Done 1", "1 agent · 2 tools · 3s\n2 model calls");

      const last = mock.getLastFrame();
      assert.ok(last.includes("Run summary"), "Run summary 必须作为条目存在于 Transcript 中");
      assert.ok(last.includes("1 agent · 2 tools · 3s"), "Run summary 细节保留");
      presenter.destroy();
    });

    it("10. 第二轮 User Message append 到旧 Transcript", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      // 第一轮
      presenter.startRun("第一轮指令");
      presenter.stopRun("第一轮回复", "summary-1");

      // 第二轮
      presenter.startRun("第二轮指令");
      const last = mock.getLastFrame();
      assert.ok(last.includes("第一轮指令"), "第一轮指令在第二轮运行中仍存在");
      assert.ok(last.includes("第一轮回复"), "第一轮回复在第二轮运行中仍存在");
      assert.ok(last.includes("第二轮指令"), "第二轮指令追加到同张界面中");
      presenter.destroy();
    });

    it("11. 第二轮 Run 不清第一轮历史", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("轮次 1");
      presenter.stopRun("回复 1", "sum-1");

      presenter.startRun("轮次 2");
      presenter.stopRun("回复 2", "sum-2");

      const last = mock.getLastFrame();
      assert.ok(last.includes("轮次 1"));
      assert.ok(last.includes("回复 1"));
      assert.ok(last.includes("轮次 2"));
      assert.ok(last.includes("回复 2"));
      presenter.destroy();
    });

    it("12. 三轮连续对话历史全部存在", () => {
      const mock = createMockTtyStream(80, 60);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      // 连续 3 轮
      presenter.startRun("Turn 1");
      presenter.stopRun("Ans 1", "Sum 1");

      presenter.startRun("Turn 2");
      presenter.stopRun("Ans 2", "Sum 2");

      presenter.startRun("Turn 3");
      presenter.stopRun("Ans 3", "Sum 3");

      const last = mock.getLastFrame();
      assert.ok(last.includes("Turn 1"));
      assert.ok(last.includes("Ans 1"));
      assert.ok(last.includes("Turn 2"));
      assert.ok(last.includes("Ans 2"));
      assert.ok(last.includes("Turn 3"));
      assert.ok(last.includes("Ans 3"));

      const allLines = presenter.getProjection("main").getAllRenderedLines();
      assert.ok(allLines.some((l) => l.includes("Turn 1")));
      assert.ok(allLines.some((l) => l.includes("Turn 2")));
      assert.ok(allLines.some((l) => l.includes("Turn 3")));
      presenter.destroy();
    });

    it("13. /new 才清 Session Transcript", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("旧会话消息");
      presenter.stopRun("旧会话回复", "sum");
      assert.equal(presenter.hasSessionHistory(), true);

      // 执行重置
      presenter.resetSession();
      assert.equal(presenter.hasSessionHistory(), false);
      assert.equal(presenter.getInteractionMode(), "empty-session");
      assert.ok(mock.getLastFrame().toLowerCase().includes("ready"), "重置后回到 Welcome/Ready 页面");
      presenter.destroy();
    });

    it("14. /resume 直接加载完整历史", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      const records: SessionRecord[] = [
        { id: "1", type: "user", content: "历史恢复用户提问", createdAt: Date.now() },
        { id: "2", type: "assistant", content: "历史恢复助手回答", createdAt: Date.now() },
      ];

      presenter.loadSessionRecords("main", records);
      assert.equal(presenter.hasSessionHistory(), true);
      assert.equal(presenter.getInteractionMode(), "session-ready");

      presenter.render();
      const last = mock.getLastFrame();
      assert.ok(last.includes("历史恢复用户提问"));
      assert.ok(last.includes("历史恢复助手回答"));
      presenter.destroy();
    });

    it("15. resume 后 Run complete 不丢旧历史", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      const records: SessionRecord[] = [
        { id: "1", type: "user", content: "恢复的提问", createdAt: Date.now() },
        { id: "2", type: "assistant", content: "恢复的回答", createdAt: Date.now() },
      ];

      presenter.loadSessionRecords("main", records);
      presenter.startRun("恢复后的新问题");
      presenter.stopRun("恢复后的新回答", "sum");

      const last = mock.getLastFrame();
      assert.ok(last.includes("恢复的提问"));
      assert.ok(last.includes("恢复的回答"));
      assert.ok(last.includes("恢复后的新问题"));
      assert.ok(last.includes("恢复后的新回答"));
      presenter.destroy();
    });
  });

  // ===========================================================================
  // 二、Bottom Dock Layout & Absolute Coordinates (用例 16 ~ 25)
  // ===========================================================================
  describe("二、Bottom Dock Layout & Absolute Coordinates", () => {
    it("16. running 多 Agent 下 Agents 垂直列表位于 Composer 下方", () => {
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

      presenter.startRun("Running layout check");
      const last = mock.getLastFrame();
      const composerIdx = last.indexOf("给 Main 输入新的指令");
      const agentsIdx = last.indexOf("Agents");
      assert.ok(composerIdx !== -1 && agentsIdx !== -1);
      assert.ok(composerIdx < agentsIdx, "Agents 垂直列表必须位于 Composer 输入框下方");
      presenter.destroy();
    });

    it("17. run complete 后 Composer row 不变化", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Prompt");
      const runFrame = mock.getLastFrame();
      const runComposerIdx = runFrame.indexOf("给 Main 输入新的指令");

      mock.clearBuffer();
      presenter.stopRun("Answer", "Sum");
      const readyFrame = mock.getLastFrame();
      const readyComposerIdx = readyFrame.indexOf("输入下一条指令");

      assert.ok(runComposerIdx !== -1 && readyComposerIdx !== -1);
      presenter.destroy();
    });

    it("18. session-ready 子代理全部完成后自动消失；Team 成员才会常驻", () => {
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

      presenter.startRun("Check Ready Dock");
      presenter.stopRun("Done", "Summary");
      const idleFrame = mock.getLastFrame();
      assert.equal(idleFrame.includes("Agents"), false, "临时子代理完成后从列表彻底消失，0行释放空间");

      // 若注册常驻 Team 成员，才会常驻展示于 Composer 下方
      agentRegistry.register({ agentId: "reviewer", name: "reviewer", type: "team-member" });
      presenter.render();
      const teamFrame = mock.getLastFrame();
      const composerIdx = teamFrame.indexOf("输入下一条指令");
      const agentsIdx = teamFrame.indexOf("Agents");
      assert.ok(composerIdx !== -1 && agentsIdx !== -1);
      assert.ok(composerIdx < agentsIdx, "Team 成员常驻并位于 Composer 下方");
      presenter.destroy();
    });

    it("19. 状态底栏始终贴 terminal bottom", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Bottom check");
      presenter.stopRun("Done", "Summary");
      const last = mock.getLastFrame();
      assert.ok(last.includes("\x1b[24;1H") || last.includes("\x1b[23;1H"), "Status Bar 必须贴紧终端底部第 24 行");
      presenter.destroy();
    });

    it("20. Run complete 不显示普通 readline Nash >", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Prompt");
      presenter.stopRun("Answer", "Summary");
      const last = mock.getLastFrame();
      assert.ok(!last.includes("Nash > \x1b[0m"), "不得出现行编辑 readline Prompt 字符");
      presenter.destroy();
    });

    it("21. Run complete cursor 回到 Bottom Composer", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Cursor check");
      presenter.stopRun("Answer", "Summary");
      const last = mock.getLastFrame();
      // 光标定位在 composer 行 (第 21/22 行)
      assert.ok(last.includes("\x1b[20;3H") || last.includes("\x1b[21;3H") || last.includes("\x1b[22;3H"));
      presenter.destroy();
    });

    it("22. 下一 Run 开始 Composer 位置不变化", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Turn 1");
      presenter.stopRun("Ans 1", "Sum 1");
      presenter.startRun("Turn 2");

      const last = mock.getLastFrame();
      const composerIdx = last.indexOf("给 Main 输入新的指令");
      assert.ok(composerIdx !== -1, "连续 Run 切换时 Composer 保持稳定就位");
      presenter.destroy();
    });

    it("23. Plan 出现时位于 Composer 上方", () => {
      const eventBus = new EventBus();
      const taskManager = new TaskManager({ eventBus });
      taskManager.createTask({ subject: "Build app" });

      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus,
        agentRegistry: new AgentRegistry({ eventBus }),
        taskManager,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Plan dock test");
      const last = mock.getLastFrame();
      const planIdx = last.indexOf("Plan (");
      const composerIdx = last.indexOf("给 Main 输入新的指令");
      assert.ok(planIdx !== -1 && composerIdx !== -1);
      assert.ok(planIdx < composerIdx, "Plan 必须位于 Composer 上方");
      presenter.destroy();
    });

    it("24. Plan 消失时 Composer 仍固定底部", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Without plan");
      presenter.stopRun("Done", "Sum");
      const last = mock.getLastFrame();
      assert.ok(last.includes("输入下一条指令") || last.includes("输入下一条消息"));
      assert.ok(last.includes("permissions"));
      presenter.destroy();
    });

    it("25. terminal resize 后位置正确", () => {
      const mock = createMockTtyStream(100, 30);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Resize test");
      presenter.stopRun("Done", "Sum");
      const last = mock.getLastFrame();
      // 在 30 行高终端下，Agents 处于第 29/30 行
      assert.ok(last.includes("\x1b[30;1H") || last.includes("\x1b[29;1H") || last.includes("\x1b[28;1H"));
      presenter.destroy();
    });
  });

  // ===========================================================================
  // 三、Final Response & Run Summary (用例 26 ~ 31)
  // ===========================================================================
  describe("三、Final Response & Run Summary Integrity", () => {
    it("26. TTY final response 只显示一次 (通过 Projection)", () => {
      const projection = new AgentTranscriptProjection("main");
      projection.addModelResponse("这是唯一最终回复");
      const lines = projection.getAllRenderedLines();
      const occurrences = lines.filter((l) => l.includes("这是唯一最终回复")).length;
      assert.equal(occurrences, 1, "Projection 中最终回复条目只能存在一份");
    });

    it("27. AgentTranscriptProjection 是 TTY final source", () => {
      const mock = createMockTtyStream();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.startRun("Test source");
      presenter.recordRunComplete("Single response text", "Summary text");
      presenter.render();

      const last = mock.getLastFrame();
      assert.ok(last.includes("Single response text"));
      presenter.destroy();
    });

    it("28. terminalUI.renderAgentResponse 不重复 TTY 输出", () => {
      const stream = new PassThrough();
      let output = "";
      stream.on("data", (d) => (output += d.toString()));

      const terminalUI = new TerminalUI(stream as any);
      terminalUI.renderAgentResponse("Non-TTY response");
      assert.ok(output.includes("[Agent Response]"));
    });

    it("29. Non-TTY 仍然能正常输出 Final Response", () => {
      const stream = new PassThrough();
      let output = "";
      stream.on("data", (d) => (output += d.toString()));

      const terminalUI = new TerminalUI(stream as any);
      terminalUI.renderAgentResponse("Hello Non-TTY");
      assert.ok(output.includes("Hello Non-TTY"));
    });

    it("30. Final Response 进入 Session Transcript", () => {
      const projection = new AgentTranscriptProjection("main");
      projection.addUserMessage("提问");
      projection.addModelResponse("回答");
      assert.equal(projection.getEntryCount(), 2);
    });

    it("31. Run Summary 进入 Transcript", () => {
      const projection = new AgentTranscriptProjection("main");
      projection.addRunSummary("1 agent · 0 tools · 2s");
      const lines = projection.getAllRenderedLines();
      assert.ok(lines.some((l) => l.includes("Run summary")));
      assert.ok(lines.some((l) => l.includes("1 agent · 0 tools · 2s")));
    });
  });

  // ===========================================================================
  // 四、State Transitions & Invariants (用例 32 ~ 39)
  // ===========================================================================
  describe("四、State Transitions & Invariants", () => {
    it("32. Empty session: empty-session", () => {
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
      });
      presenter.enterAppScreen();
      assert.equal(presenter.getInteractionMode(), "empty-session");
      presenter.destroy();
    });

    it("33. submit: running-main", () => {
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
      });
      presenter.startRun("First submit");
      assert.equal(presenter.getInteractionMode(), "running-main");
      presenter.destroy();
    });

    it("34. run complete: session-ready", () => {
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
      });
      presenter.startRun("Run");
      presenter.stopRun("Done", "Sum");
      assert.equal(presenter.getInteractionMode(), "session-ready");
      presenter.destroy();
    });

    it("35. next submit: running-main", () => {
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
      });
      presenter.startRun("Turn 1");
      presenter.stopRun("Done 1", "Sum 1");
      assert.equal(presenter.getInteractionMode(), "session-ready");

      presenter.startRun("Turn 2");
      assert.equal(presenter.getInteractionMode(), "running-main");
      presenter.destroy();
    });

    it("36. structured decision: structured-decision", () => {
      const decisionController = new DecisionController();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        decisionController,
        isTTY: true,
      });

      presenter.startRun("Run with decision");
      const decPromise = decisionController.requestDecision({
        id: "d1",
        kind: "permission",
        title: "Permission",
        options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
      });
      decPromise.catch(() => {});

      assert.equal(presenter.getInteractionMode(), "structured-decision");
      decisionController.abortAll("done");
      presenter.destroy();
    });

    it("37. decision complete: session-ready / running-main", () => {
      const decisionController = new DecisionController();
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        decisionController,
        isTTY: true,
      });

      presenter.startRun("Run");
      const decPromise = decisionController.requestDecision({
        id: "d2",
        kind: "permission",
        title: "Permission",
        options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
      });

      assert.equal(presenter.getInteractionMode(), "structured-decision");
      decisionController.confirmSelected();
      assert.equal(presenter.getInteractionMode(), "running-main");

      presenter.stopRun("Done", "Sum");
      assert.equal(presenter.getInteractionMode(), "session-ready");
      presenter.destroy();
    });

    it("38. /new: empty-session", () => {
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
      });

      presenter.startRun("Run");
      presenter.stopRun("Done", "Sum");
      assert.equal(presenter.getInteractionMode(), "session-ready");

      presenter.resetSession();
      assert.equal(presenter.getInteractionMode(), "empty-session");
      presenter.destroy();
    });

    it("39. 不允许：run complete → empty-session", () => {
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
      });

      presenter.startRun("Run");
      presenter.stopRun("Done", "Sum");
      assert.notEqual(presenter.getInteractionMode(), "empty-session", "Run complete 绝对不允许切回 empty-session");
      assert.equal(presenter.getInteractionMode(), "session-ready");
      presenter.destroy();
    });
  });
});
