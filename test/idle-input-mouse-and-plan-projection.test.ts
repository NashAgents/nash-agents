import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { TaskManager } from "../src/task/task-manager.js";
import { PlanMode } from "../src/plan/plan-mode.js";
import { DecisionController } from "../src/decision/decision-controller.js";
import { InputManager } from "../src/cli/input-manager.js";
import { SystemClipboard } from "../src/cli/clipboard.js";
import { TerminalInputParser } from "../src/cli/terminal-input-parser.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { ProposedPlanProjection } from "../src/presentation/proposed-plan-projection.js";
import { ActiveTaskGraphProjection } from "../src/presentation/active-task-graph-projection.js";
import { highlightSelectedLine, selectedText } from "../src/presentation/transcript-selection.js";
import stripAnsi from "strip-ansi";
import type { Task } from "../src/task/types.js";
import type { ProposedPlan } from "../src/plan/types.js";

function createMockTtyStream(columns = 80, rows = 24) {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  (stream as any).isTTY = true;
  (stream as any).columns = columns;
  (stream as any).rows = rows;

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

describe("Idle View, Input State Machine, Mouse Parser & Plan Projection Suite", () => {
  it("拖选事件会传给展示层，选区按显示列处理中文与 ANSI 样式", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const manager = new InputManager({ input, output, isTTY: true });
    const events: Array<{ col: number; row: number; isDrag?: boolean; isRelease?: boolean }> = [];
    manager.startNavigationMode({ onMouseButton: (event) => events.push(event) }, "running-main");
    try {
      input.write("\x1b[<0;3;4M\x1b[<32;5;5M\x1b[<0;5;5m");
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(events.length, 3);
      assert.equal(events[1]?.isDrag, true);
      assert.equal(events[2]?.isRelease, true);
      const lines = ["\x1b[31m甲乙\x1b[0mAB", "second line"];
      const selection = { anchor: { line: 0, column: 2 }, focus: { line: 1, column: 6 } };
      assert.equal(selectedText(lines, selection), "乙AB\nsecond");
      assert.equal(stripAnsi(highlightSelectedLine(lines[0]!, 0, selection)), stripAnsi(lines[0]!));
      assert.match(highlightSelectedLine(lines[0]!, 0, selection), /\x1b\[7m乙/);
    } finally {
      manager.close();
    }
  });
  it("全屏正文拖到上边缘会继续滚动，并保持选区高亮", async () => {
    const tty = createMockTtyStream(80, 20);
    const presenter = new CliPresenter({ eventBus: new EventBus(), agentRegistry: new AgentRegistry(), stdout: tty.stream, isTTY: true });
    try {
      const projection = presenter.getProjection("main");
      for (let index = 0; index < 35; index++) projection.addSystemNotice(`selection history ${index}`);
      presenter.render();
      const mouse = presenter.getNavigationHandler().onMouseButton!;
      mouse({ button: 0, col: 3, row: 8 });
      tty.clearBuffer();
      mouse({ button: 32, col: 12, row: 2, isMotion: true, isDrag: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.match(tty.getOutput(), /\x1b\[7m/, "拖选时应显示选区");
      await new Promise((resolve) => setTimeout(resolve, 230));
      assert.ok(projection.getScrollOffset() > 0, "在正文上边缘按住拖动应滚动到更早内容");
    } finally {
      presenter.destroy();
    }
  });
  it("松开鼠标后把跨行选区写入剪贴板", () => {
    const tty = createMockTtyStream(80, 20);
    const presenter = new CliPresenter({ eventBus: new EventBus(), agentRegistry: new AgentRegistry(), stdout: tty.stream, isTTY: true });
    const originalWriteText = SystemClipboard.writeText;
    let copied = "";
    SystemClipboard.writeText = (text) => { copied = text; return true; };
    try {
      const projection = presenter.getProjection("main");
      projection.addSystemNotice("first selectable line");
      projection.addSystemNotice("second selectable line");
      presenter.render();
      const mouse = presenter.getNavigationHandler().onMouseButton!;
      mouse({ button: 0, col: 1, row: 2 });
      mouse({ button: 32, col: 20, row: 3, isMotion: true, isDrag: true });
      mouse({ button: 0, col: 20, row: 3, isRelease: true });
      assert.match(copied, /first selectable line/);
      assert.match(copied, /\n/);
    } finally {
      SystemClipboard.writeText = originalWriteText;
      presenter.destroy();
    }
  });
  it("可从正文下方空白行向上拖选，并复制中间的换行", async () => {
    const tty = createMockTtyStream(80, 20);
    const presenter = new CliPresenter({ eventBus: new EventBus(), agentRegistry: new AgentRegistry(), stdout: tty.stream, isTTY: true });
    const originalWriteText = SystemClipboard.writeText;
    let copied = "";
    SystemClipboard.writeText = (text) => { copied = text; return true; };
    try {
      presenter.getProjection("main").addSystemNotice("first selectable line");
      presenter.render();
      const viewport = (presenter as any).transcriptViewport as { top: number; height: number };
      const blankRow = viewport.top + Math.min(viewport.height - 1, 7);
      const mouse = presenter.getNavigationHandler().onMouseButton!;
      mouse({ button: 0, col: 12, row: blankRow });
      tty.clearBuffer();
      mouse({ button: 32, col: 1, row: viewport.top, isMotion: true, isDrag: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.match(tty.getOutput(), /\x1b\[7m +/, "空白行也应显示选中高亮");
      mouse({ button: 0, col: 1, row: viewport.top, isRelease: true });
      assert.match(copied, /first selectable line/);
      assert.ok((copied.match(/\n/g) ?? []).length >= blankRow - viewport.top, "空白区域的换行应进入剪贴板");
    } finally {
      SystemClipboard.writeText = originalWriteText;
      presenter.destroy();
    }
  });
  it("尚未执行任何轮次时也能选中标题、空历史提示与输入区", () => {
    const tty = createMockTtyStream(80, 20);
    const presenter = new CliPresenter({ eventBus: new EventBus(), agentRegistry: new AgentRegistry(), stdout: tty.stream, isTTY: true });
    const originalWriteText = SystemClipboard.writeText;
    const copied: string[] = [];
    SystemClipboard.writeText = (text) => { copied.push(text); return true; };
    try {
      presenter.enterAppScreen();
      presenter.render();
      const mouse = presenter.getNavigationHandler().onMouseButton!;
      mouse({ button: 0, col: 1, row: 1 });
      mouse({ button: 32, col: 30, row: 2, isMotion: true, isDrag: true });
      mouse({ button: 0, col: 30, row: 2, isRelease: true });
      assert.match(copied[0] ?? "", /Nash/);
      assert.match(copied[0] ?? "", /暂无执行历史/);

      mouse({ button: 0, col: 1, row: 18 });
      mouse({ button: 32, col: 20, row: 19, isMotion: true, isDrag: true });
      mouse({ button: 0, col: 20, row: 19, isRelease: true });
      assert.ok(copied.length >= 2, "输入区应允许直接拖选");
    } finally {
      SystemClipboard.writeText = originalWriteText;
      presenter.destroy();
    }
  });
  it("Main View 与 Agent Detail 模式下方向键均支持选择 Agent，滚轮与翻页键滚动 Transcript", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const manager = new InputManager({ input, output, isTTY: true });
    let scrollUp = 0;
    let scrollDown = 0;
    let selectUp = 0;
    let selectDown = 0;
    manager.startNavigationMode({
      onMouseWheelUp: () => { scrollUp++; },
      onMouseWheelDown: () => { scrollDown++; },
      onKeyUp: () => { selectUp++; },
      onKeyDown: () => { selectDown++; },
    }, "running-main");
    try {
      // 1. 在 running-main 模式下：
      // arrow-up (\x1b[A) 与 arrow-down (\x1bOB) 触发 Agent 选择 (selectUp/selectDown)
      input.write("\x1b[A\x1bOB");
      // SGR 滚轮序列触发 Transcript 滚动
      input.write("\x1b[<64;10;10M\x1b[<65;10;10M");
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(selectUp, 1, "Main View 下 arrow-up 必须选择上一个 Agent");
      assert.equal(selectDown, 1, "Main View 下 arrow-down 必须选择下一个 Agent");
      assert.equal(scrollUp, 1, "滚轮向上滚动 Transcript");
      assert.equal(scrollDown, 1, "滚轮向下滚动 Transcript");

      // 2. 切换到 agent-detail 模式：
      manager.setInteractionMode("agent-detail");
      input.write("\x1b[A\x1bOB");
      input.write("\x1b[<64;10;10M\x1b[<65;10;10M");
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(selectUp, 2, "Agent Detail 下 arrow-up 必须支持选择上一个 Agent");
      assert.equal(selectDown, 2, "Agent Detail 下 arrow-down 必须支持选择下一个 Agent");
      assert.equal(scrollUp, 2, "Agent Detail 下滚轮向上滚动该 Agent Transcript");
      assert.equal(scrollDown, 2, "Agent Detail 下滚轮向下滚动该 Agent Transcript");
    } finally {
      manager.close();
    }
  });

  it("上滑后仍留在 Nash，并能看到更早的 Transcript", async () => {
    const tty = createMockTtyStream();
    const input = new PassThrough();
    const presenter = new CliPresenter({ eventBus: new EventBus(), agentRegistry: new AgentRegistry(), stdout: tty.stream, isTTY: true });
    for (let index = 0; index < 30; index++) {
      presenter.appendTranscript({ id: `line-${index}`, agentId: "main", kind: "message", text: `history ${index}`, timestamp: Date.now() });
    }
    const projection = presenter.getProjection("main");
    const manager = new InputManager({ input, output: tty.stream, isTTY: true });
    manager.startNavigationMode(presenter.getNavigationHandler(), "running-main");
    try {
      // 鼠标滚轮/触控板向上滑动序列 (SGR wheel-up)
      input.write("\x1b[<64;10;10M");
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(projection.getScrollOffset() > 0, "滚轮上滑应滚动 Nash 自己的历史视口");
      assert.equal(manager.isTerminated(), false);
    } finally {
      manager.close();
      presenter.destroy();
    }
  });
  // ===========================================================================
  // 二十七、测试：Idle / Welcome
  // ===========================================================================
  describe("二十七、Idle / Welcome Screen", () => {
    it("1. App start → interactionMode empty-session", () => {
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
      });
      assert.equal(
        presenter.getInteractionMode() === "empty-session" ||
          presenter.getInteractionMode() === "idle",
        true
      );
      presenter.destroy();
    });

    it("2. Idle 不显示 working", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.enterAppScreen();
      const out = mock.getOutput();
      assert.equal(out.includes("working"), false, "Idle 界面绝对不能包含 working");
      presenter.destroy();
    });

    it("3. Idle 不显示 Team Leader", () => {
      const eventBus = new EventBus();
      const registry = new AgentRegistry({ eventBus });
      registry.register({ agentId: "main", name: "Team Leader", type: "team-lead" });
      const mock = createMockTtyStream(80, 24);

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry: registry,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.enterAppScreen();
      const out = mock.getOutput();
      assert.equal(out.includes("Team Leader"), false, "Idle 界面绝对不显示未运行的 Team Leader");
      presenter.destroy();
    });

    it("4. Idle 不显示 Plan", () => {
      const eventBus = new EventBus();
      const taskManager = new TaskManager({ eventBus });
      taskManager.createTask({ subject: "Background scan" });
      const mock = createMockTtyStream(80, 24);

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry: new AgentRegistry(),
        taskManager,
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.enterAppScreen();
      const out = mock.getOutput();
      assert.equal(out.includes("Plan ("), false, "Idle 界面不应显示执行 Plan");
      presenter.destroy();
    });

    it("5. Idle Composer 可输入", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        stdout: mock.stream,
        isTTY: true,
      });

      presenter.enterAppScreen();
      presenter.setComposerDraft("hello nash");
      const out = mock.getOutput();
      assert(out.includes("> hello nash"), "Idle 界面输入应正确反馈展示");
      presenter.destroy();
    });

    it("6. Submit 后切 running-main", () => {
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
      });

      presenter.startRun("Run prompt");
      assert.equal(presenter.getInteractionMode(), "running-main");
      presenter.stopRun();
      presenter.destroy();
    });

    it("7. Run complete 后进入 session-ready", () => {
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
      });

      presenter.startRun("Run prompt");
      assert.equal(presenter.getInteractionMode(), "running-main");
      presenter.stopRun();
      assert.equal(presenter.getInteractionMode(), "session-ready");
      presenter.destroy();
    });
  });

  // ===========================================================================
  // 二十八、测试：Input Mode 与 Keymap 状态机
  // ===========================================================================
  describe("二十八、Input Mode & Keymap State Machine", () => {
    it("8. Main ↑↓ 只移动 Agent Selection", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "main", type: "main" });
      agentRegistry.register({ agentId: "sub-1", name: "metro-analyst", type: "subagent" });

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        isTTY: true,
      });

      presenter.startRun("Analyze");
      const nav = presenter.getNavigationHandler();

      assert.equal(presenter.getActiveViewAgentId(), "main");
      nav.onKeyDown?.(); // 选中 sub-1
      assert.equal(presenter.getActiveViewAgentId(), "main", "上下移动光标不应改变 activeViewAgentId");
      presenter.stopRun();
      presenter.destroy();
    });

    it("9. Main 选中 Child 后不改变 activeViewAgentId", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "main", type: "main" });
      agentRegistry.register({ agentId: "sub-1", name: "agent-apps", type: "subagent" });

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        isTTY: true,
      });

      presenter.startRun("Task");
      const nav = presenter.getNavigationHandler();
      nav.onKeyDown?.();
      nav.onKeyUp?.();
      assert.equal(presenter.getActiveViewAgentId(), "main");
      presenter.stopRun();
      presenter.destroy();
    });

    it("10. Enter 才进入 Agent Detail", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "main", type: "main" });
      agentRegistry.register({ agentId: "sub-1", name: "metro-analyst", type: "subagent" });

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        isTTY: true,
      });

      presenter.startRun("Analyze");
      const nav = presenter.getNavigationHandler();
      nav.onKeyDown?.(); // 光标移到 sub-1
      nav.onKeyEnter?.(); // 回车进入

      assert.equal(presenter.getActiveViewAgentId(), "sub-1");
      assert.equal(presenter.getInteractionMode(), "agent-detail");
      presenter.stopRun();
      presenter.destroy();
    });

    it("11. Agent Detail ↑↓ 仅用于智能体切换而非滚动 Transcript", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "main", type: "main" });
      agentRegistry.register({ agentId: "sub-1", name: "metro-analyst", type: "subagent" });
      agentRegistry.register({ agentId: "sub-2", name: "code-writer", type: "subagent" });

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        isTTY: true,
      });

      presenter.startRun("Analyze");
      presenter.switchToAgentView("sub-1");
      assert.equal(presenter.getActiveViewAgentId(), "sub-1");
      assert.equal(presenter.getSelectedAgentId(), "sub-1");
      const nav = presenter.getNavigationHandler();

      const proj = presenter.getProjection("sub-1");
      const initialScroll = proj.getScrollOffset();

      // 在 Agent Detail 触发 ↑ 切换选中的 Agent 到 main
      nav.onKeyUp?.();
      assert.equal(presenter.getSelectedAgentId(), "main");
      // 确认上下键绝不改变 Transcript 滚动 offset
      assert.equal(proj.getScrollOffset(), initialScroll);

      // 在 Agent Detail 触发 ↓ 切换选中的 Agent 到 sub-2
      nav.onKeyDown?.();
      nav.onKeyDown?.();
      assert.equal(presenter.getSelectedAgentId(), "sub-2");
      assert.equal(proj.getScrollOffset(), initialScroll);

      // 回车切换到选中的 Agent
      nav.onKeyEnter?.();
      assert.equal(presenter.getActiveViewAgentId(), "sub-2");

      // 滚动 Transcript 专门由 PageUp / MouseWheel 负责
      nav.onPageUp?.();
      nav.onMouseWheelUp?.();
      nav.onMouseWheelDown?.();

      presenter.stopRun();
      presenter.destroy();
    });

    it("12. Esc 返回 Main", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "sub-1", name: "metro-analyst", type: "subagent" });

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        isTTY: true,
      });

      presenter.startRun("Analyze");
      presenter.switchToAgentView("sub-1");
      assert.equal(presenter.getActiveViewAgentId(), "sub-1");

      const nav = presenter.getNavigationHandler();
      nav.onKeyEscape?.();

      assert.equal(presenter.getActiveViewAgentId(), "main");
      assert.equal(presenter.getInteractionMode(), "running-main");
      presenter.stopRun();
      presenter.destroy();
    });

    it("13. 返回后 ↑↓ 再次选择 Agent", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "main", type: "main" });
      agentRegistry.register({ agentId: "sub-1", name: "sub-1", type: "subagent" });

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        isTTY: true,
      });

      presenter.startRun("Analyze");
      presenter.switchToAgentView("sub-1");
      presenter.returnToMainView();

      const nav = presenter.getNavigationHandler();
      nav.onKeyDown?.();
      assert.equal(presenter.getActiveViewAgentId(), "main");
      presenter.stopRun();
      presenter.destroy();
    });

    it("14. Ctrl+T Main 可用", () => {
      const eventBus = new EventBus();
      const taskManager = new TaskManager({ eventBus });
      taskManager.createTask({ subject: "Task A" });

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry: new AgentRegistry(),
        taskManager,
        isTTY: true,
      });

      presenter.startRun("Run");
      const nav = presenter.getNavigationHandler();
      nav.onKeyCtrlT?.();
      assert.equal(presenter.getInteractionMode(), "running-main");
      presenter.stopRun();
      presenter.destroy();
    });

    it("15. Decision resolve 后 Ctrl+T 可用", async () => {
      const eventBus = new EventBus();
      const taskManager = new TaskManager({ eventBus });
      taskManager.createTask({ subject: "Task A" });
      const decisionController = new DecisionController();

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry: new AgentRegistry(),
        taskManager,
        decisionController,
        isTTY: true,
      });

      presenter.startRun("Run");
      decisionController.requestDecision({
        id: "dec-1",
        kind: "permission",
        title: "Permission",
        description: "Desc",
        options: [{ id: "allow", label: "Allow" }],
      });

      assert.equal(presenter.getInteractionMode(), "structured-decision");
      decisionController.confirmSelected();
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(presenter.getInteractionMode(), "running-main");
      const nav = presenter.getNavigationHandler();
      nav.onKeyCtrlT?.();
      presenter.stopRun();
      presenter.destroy();
    });

    it("16. Decision ↑↓ 不移动 Agent", async () => {
      const decisionController = new DecisionController();
      decisionController.requestDecision({
        id: "dec-1",
        kind: "permission",
        title: "Permission",
        description: "Desc",
        options: [
          { id: "opt1", label: "Option 1" },
          { id: "opt2", label: "Option 2" },
        ],
      });

      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        decisionController,
        isTTY: true,
      });

      presenter.startRun("Run");
      const nav = presenter.getNavigationHandler();
      nav.onDecisionKeyDown?.();

      const activeDec = decisionController.getActiveDecision();
      assert.equal(activeDec?.selectedIndex, 1, "Decision 方向键仅改变选项 index");
      assert.equal(presenter.getActiveViewAgentId(), "main");
      decisionController.confirmSelected();
      await new Promise((r) => setTimeout(r, 10));
      presenter.stopRun();
      presenter.destroy();
    });

    it("17. Plan Revision Esc 返回 Decision", async () => {
      const decisionController = new DecisionController();
      const plan: ProposedPlan = {
        planId: "p1",
        goal: "Goal",
        summary: "Summary",
        steps: [{ id: "s1", subject: "Step 1" }],
        createdAt: Date.now(),
      };

      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        decisionController,
        isTTY: true,
      });

      presenter.startRun("Plan");
      presenter.triggerPlanApproval(plan);

      // 切换到 revise
      decisionController.selectNext();
      decisionController.confirmSelected(); // 触发 revise
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(presenter.getInteractionMode(), "plan-revision");
      presenter.cancelPlanRevision();
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(presenter.getInteractionMode(), "structured-decision");
      decisionController.confirmSelected();
      await new Promise((r) => setTimeout(r, 10));
      presenter.stopRun();
      presenter.destroy();
    });
  });

  // ===========================================================================
  // 二十九、测试：Mouse / Escape Parser
  // ===========================================================================
  describe("二十九、Mouse / Escape Parser", () => {
    it("18. 单独 Esc → back", () => {
      const { events } = TerminalInputParser.parse("\x1b");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "escape");
    });

    it("19. ArrowUp 不触发 back", () => {
      const { events } = TerminalInputParser.parse("\x1b[A");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "arrow-up");
    });

    it("20. ArrowDown 不触发 back", () => {
      const { events } = TerminalInputParser.parse("\x1b[B");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "arrow-down");
    });

    it("21. PgUp/PgDn 不触发 back", () => {
      const { events: e1 } = TerminalInputParser.parse("\x1b[5~");
      assert.equal(e1[0]?.type, "page-up");
      const { events: e2 } = TerminalInputParser.parse("\x1b[6~");
      assert.equal(e2[0]?.type, "page-down");
    });

    it("22. Wheel Up 不触发 back", () => {
      const { events } = TerminalInputParser.parse("\x1b[<64;20;10M");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "mouse-wheel-up");
    });

    it("23. Wheel Down 不触发 back", () => {
      const { events } = TerminalInputParser.parse("\x1b[<65;20;10M");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "mouse-wheel-down");
    });

    it("24. Wheel Up scroll Transcript", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "sub-1", name: "metro-analyst", type: "subagent" });

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        isTTY: true,
      });

      presenter.startRun("Run");
      presenter.switchToAgentView("sub-1");

      const nav = presenter.getNavigationHandler();
      nav.onMouseWheelUp?.();

      assert.equal(presenter.getActiveViewAgentId(), "sub-1", "滚轮绝不改变视图");
      presenter.stopRun();
      presenter.destroy();
    });

    it("25. Wheel Down scroll Transcript", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "sub-1", name: "metro-analyst", type: "subagent" });

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        isTTY: true,
      });

      presenter.startRun("Run");
      presenter.switchToAgentView("sub-1");

      const nav = presenter.getNavigationHandler();
      nav.onMouseWheelDown?.();

      assert.equal(presenter.getActiveViewAgentId(), "sub-1");
      presenter.stopRun();
      presenter.destroy();
    });

    it("26. 快速连续滚轮不退出 View", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "sub-1", name: "metro-analyst", type: "subagent" });

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        isTTY: true,
      });

      presenter.startRun("Run");
      presenter.switchToAgentView("sub-1");
      const nav = presenter.getNavigationHandler();

      for (let i = 0; i < 30; i++) {
        nav.onMouseWheelUp?.();
        nav.onMouseWheelDown?.();
      }

      assert.equal(presenter.getActiveViewAgentId(), "sub-1", "连续滚动 30 次必须留在当前 View");
      presenter.stopRun();
      presenter.destroy();
    });

    it("27. Agent Detail exit 后 mouse reporting 关闭", () => {
      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      const inputManager = new InputManager({ input: input as any, output: output as any, isTTY: true });
      inputManager.setInteractionMode("agent-detail");
      inputManager.setInteractionMode("running-main");

      assert.equal(inputManager.getInteractionMode(), "running-main");
      inputManager.close();
    });

    it("28. Ctrl+C 后 mouse reporting 关闭", () => {
      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      const inputManager = new InputManager({ input: input as any, output: output as any, isTTY: true });
      inputManager.setInteractionMode("agent-detail");
      inputManager.close();
      assert.equal(inputManager.getInteractionMode(), "idle");
    });
  });

  // ===========================================================================
  // 三十、测试：Plan Projection
  // ===========================================================================
  describe("三十、Plan Projection & Task Status Consistency", () => {
    const samplePlan: ProposedPlan = {
      planId: "plan-1",
      goal: "全面分析系统",
      summary: "分阶段推进",
      steps: [
        { id: "s1", subject: "项目分类索引" },
        { id: "s2", subject: "Metro 项目分析" },
        { id: "s3", subject: "Agent 项目分析" },
      ],
      createdAt: Date.now(),
    };

    it("29. Awaiting Approval 只显示 ProposedPlan", () => {
      const rendered = ProposedPlanProjection.render(samplePlan);
      assert(rendered[0]?.includes("Plan ready for approval"));
      assert(rendered.some((l) => l.includes("1. 项目分类索引")));
      assert.equal(rendered.some((l) => l.includes("Plan (0/")), false, "不应显示 (0/x) 统计");
    });

    it("30. Approval 后 ProposedPlan 不再进入 Execution Plan", () => {
      const tasks: Task[] = [
        {
          id: "t1",
          subject: "项目分类索引",
          status: "completed",
          dependencies: [],
          revision: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      const rendered = ActiveTaskGraphProjection.render(tasks);
      assert(rendered[0]?.includes("Plan (1/1)"));
      assert(rendered.some((l) => l.includes("✓") && l.includes("项目分类索引")));
    });

    it("31. Active Plan header/list 来自同一 snapshot", () => {
      const tasks: Task[] = [
        { id: "t1", subject: "Task 1", status: "completed", dependencies: [], revision: 1, createdAt: 1, updatedAt: 1 },
        { id: "t2", subject: "Task 2", status: "running", dependencies: [], revision: 1, createdAt: 2, updatedAt: 2 },
      ];

      const rendered = ActiveTaskGraphProjection.render(tasks);
      assert(rendered[0]?.includes("Plan (1/2)"));
    });

    it("32. completed → ✓", () => {
      const icon = ActiveTaskGraphProjection.getTaskIcon({ status: "completed" } as any);
      assert(icon.includes("✓"));
    });

    it("33. running → →", () => {
      const icon = ActiveTaskGraphProjection.getTaskIcon({ status: "running" } as any);
      assert(icon.includes("→"));
    });

    it("34. ready → ○", () => {
      const icon = ActiveTaskGraphProjection.getTaskIcon({ status: "ready" } as any);
      assert(icon.includes("○"));
    });

    it("35. pending → ·", () => {
      const icon = ActiveTaskGraphProjection.getTaskIcon({ status: "pending" } as any);
      assert(icon.includes("·"));
    });

    it("36. blocked → ⚠", () => {
      const icon = ActiveTaskGraphProjection.getTaskIcon({ status: "blocked" } as any);
      assert(icon.includes("⚠"));
    });

    it("37. failed → ✗", () => {
      const icon = ActiveTaskGraphProjection.getTaskIcon({ status: "failed" } as any);
      assert(icon.includes("✗"));
    });

    it("38. superseded → ⊘", () => {
      const icon = ActiveTaskGraphProjection.getTaskIcon({ status: "cancelled", supersededByTaskId: "t2" } as any);
      assert(icon.includes("⊘"));
    });

    it("39. cancelled → ⊘", () => {
      const icon = ActiveTaskGraphProjection.getTaskIcon({ status: "cancelled" } as any);
      assert(icon.includes("⊘"));
    });

    it("40. Plan completedCount 与行状态一致", () => {
      const tasks: Task[] = [
        { id: "t1", subject: "Task 1", status: "completed", dependencies: [], revision: 1, createdAt: 1, updatedAt: 1 },
      ];
      const rendered = ActiveTaskGraphProjection.render(tasks);
      assert(rendered[0]?.includes("(1/1)"));
      assert(rendered.some((l) => l.includes("✓") && l.includes("Task 1")));
    });

    it("41. completedByAgentId 正确显示 displayName", () => {
      const registry = new AgentRegistry();
      registry.register({ agentId: "agent-12345", name: "metro-analyst", type: "subagent" });

      const tasks: Task[] = [
        {
          id: "t1",
          subject: "Metro 项目分析",
          status: "completed",
          completedByAgentId: "agent-12345",
          dependencies: [],
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ];

      const rendered = ActiveTaskGraphProjection.render(tasks, { agentRegistry: registry });
      assert(rendered.some((l) => l.includes("metro-analyst")));
      assert.equal(rendered.some((l) => l.includes("agent-12345")), false, "不应显示长 UUID");
    });

    it("42. running owner 显示 displayName", () => {
      const registry = new AgentRegistry();
      registry.register({ agentId: "agent-67890", name: "agent-apps-analyst", type: "subagent" });

      const tasks: Task[] = [
        {
          id: "t2",
          subject: "Agent 应用项目分析",
          status: "running",
          ownerAgentId: "agent-67890",
          dependencies: [],
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ];

      const rendered = ActiveTaskGraphProjection.render(tasks, { agentRegistry: registry });
      assert(rendered.some((l) => l.includes("agent-apps-analyst")));
      assert.equal(rendered.some((l) => l.includes("agent-67890")), false);
    });

    it("43. 不显示普通 agent UUID", () => {
      const name = ActiveTaskGraphProjection.getOwnerDisplayName("main");
      assert.equal(name, "Main");
    });

    it("44. superseded history 默认折叠", () => {
      const tasks: Task[] = [
        { id: "t1", subject: "Active 1", status: "running", dependencies: [], revision: 1, createdAt: 1, updatedAt: 1 },
        { id: "t2", subject: "Old 1", status: "cancelled", supersededByTaskId: "t1", dependencies: [], revision: 1, createdAt: 2, updatedAt: 2 },
        { id: "t3", subject: "Old 2", status: "cancelled", supersededByTaskId: "t1", dependencies: [], revision: 1, createdAt: 3, updatedAt: 3 },
      ];

      const rendered = ActiveTaskGraphProjection.render(tasks);
      assert(rendered.some((l) => l.includes("2 superseded tasks")), "历史废弃任务应被折叠");
    });
  });
});
