import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { TaskManager } from "../src/task/task-manager.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { TerminalScreenManager } from "../src/presentation/terminal-screen-manager.js";
import { AgentTranscriptProjection } from "../src/presentation/agent-transcript-projection.js";
import type { SessionRecord } from "../src/context/types.js";

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

describe("Alternate Screen & Full Tool Loop Transcript Subsystem", () => {
  describe("1. TerminalScreenManager Isolation & Idempotence", () => {
    it("1.0 原生滚动区保留历史且不捕获鼠标", () => {
      const mock = createMockTtyStream(80, 16);
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "main", type: "main" });
      const presenter = new CliPresenter({ eventBus, agentRegistry, isTTY: true, stdout: mock.stream, nativeScrollback: true });
      try {
        presenter.enterAppScreen();
        const projection = presenter.getProjection("main");
        for (let i = 0; i < 30; i++) projection.addSystemNotice(`native history ${i}`);
        presenter.render();
        const output = mock.getOutput();
        assert.match(stripAnsi(output), /Nash ·/);
        assert(!output.includes("\x1b[?1049h"), "原生滚动区不得切换至备用屏幕");
        assert(!output.includes("\x1b[?1000h"), "普通鼠标划选必须保持可用");
        assert.match(stripAnsi(output), /native history 0/);
        assert.match(stripAnsi(output), /native history 29/);
        assert.match(output, /native history 0[\s\S]*native history 29/, "历史内容应按顺序写入终端滚动区");
        assert(!output.includes("\x1b[1;1H"), "原生滚动区不得用绝对坐标整屏重绘");
      } finally {
        presenter.destroy();
      }
    });

    it("1.0.1 原生滚动区退出时只清除临时底栏，不闪回 Nash 画面", () => {
      const mock = createMockTtyStream(80, 24);
      const presenter = new CliPresenter({
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
        stdout: mock.stream,
        nativeScrollback: true,
      });
      presenter.enterAppScreen();
      presenter.render();
      mock.clearBuffer();
      presenter.destroy();
      const exitOutput = mock.getOutput();
      assert(exitOutput.includes("\r\x1b[J"), "退出时应清除输入栏和 Agent 列表");
      assert.equal(stripAnsi(exitOutput).includes("Nash"), false, "退出时不得重绘 Nash 画面");
    });

    it("1.0.2 子代理与选择器沿用主屏幕历史，不捕获滚轮或右键", async () => {
      const mock = createMockTtyStream(80, 16);
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "main", type: "main" });
      agentRegistry.register({ agentId: "worker", type: "subagent", name: "worker", parentAgentId: "main" });
      const presenter = new CliPresenter({ eventBus, agentRegistry, isTTY: true, stdout: mock.stream, nativeScrollback: true });
      try {
        mock.stream.write("host shell history\r\n");
        presenter.enterAppScreen();
        presenter.getProjection("main").addSystemNotice("main history");
        presenter.render();
        presenter.getProjection("worker").addSystemNotice("worker history");
        presenter.switchToAgentView("worker");
        presenter.returnToMainView();
        const picker = presenter.openResumePicker([], "current");
        presenter.getNavigationHandler().onResumeCancel?.();
        await picker;
        const skills = presenter.openSkillsPicker({ getAllSkillsWithModes: async () => [] } as any);
        await Promise.resolve();
        presenter.getNavigationHandler().onSkillsClose?.();
        await skills;
        const output = mock.getOutput();
        assert.match(output, /host shell history[\s\S]*main history[\s\S]*worker history/);
        assert.match(output, /Resume a session/);
        assert.equal(output.includes("\x1b[?1049h"), false);
        assert.equal(output.includes("\x1b[?1000h"), false);
        assert.equal(output.includes("\x1b[2J"), false);
      } finally {
        presenter.destroy();
      }
    });

    it("1.1 进入与退出 Alternate Screen 发送标准控制序列且完全幂等", () => {
      const mock = createMockTtyStream();
      const manager = new TerminalScreenManager({ stdout: mock.stream, isTTY: true });

      assert.equal(manager.isAlternateScreen(), false);

      // 进入
      manager.enterAlternateScreen();
      assert.equal(manager.isAlternateScreen(), true);
      assert(mock.getOutput().includes("\x1b[?1049h"));
      assert.equal(mock.getOutput().includes("\x1b[?1007h"), false, "备用屏幕严禁开启 1007 将滚轮转为方向键");
      assert(mock.getOutput().includes("\x1b[?1000h\x1b[?1002h\x1b[?1006h"), "备用屏幕必须启用拖动与滚轮报告");

      mock.clearBuffer();

      // 重复进入应无副作用 (幂等)
      manager.enterAlternateScreen();
      assert.equal(mock.getOutput(), "");

      // 退出
      manager.leaveAlternateScreen();
      assert.equal(manager.isAlternateScreen(), false);
      assert(mock.getOutput().includes("\x1b[?1049l"));
      assert(mock.getOutput().includes("\x1b[?1000l"));
      assert(mock.getOutput().includes("\x1b[?1006l"));

      mock.clearBuffer();

      // 重复退出无副作用
      manager.leaveAlternateScreen();
      assert.equal(mock.getOutput(), "");
    });

    it("1.2 Non-TTY 环境下自动降级为 No-op，不输出任何控制字符", () => {
      const mock = createMockTtyStream();
      const manager = new TerminalScreenManager({ stdout: mock.stream, isTTY: false });

      manager.enterAlternateScreen();
      manager.clearAlternateScreen();
      manager.leaveAlternateScreen();

      assert.equal(mock.getOutput(), "");
      assert.equal(manager.isAlternateScreen(), false);
    });

    it("1.3 强制恢复 forceRestore 能安全收敛终端状态", () => {
      const mock = createMockTtyStream();
      const manager = new TerminalScreenManager({ stdout: mock.stream, isTTY: true });

      manager.enterAlternateScreen();
      mock.clearBuffer();

      manager.forceRestore();
      assert(mock.getOutput().includes("\x1b[?1049l"));
      assert.equal(manager.isAlternateScreen(), false);
    });
  });

  describe("2. Main Terminal Scrollback Zero-Pollution", () => {
    it("2.1 进入 Agent 详情视图使用 Application Screen，绝对不向 Main stdout append banner", async () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      const mock = createMockTtyStream();

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      agentRegistry.register({
        agentId: "build-checker",
        name: "build-checker",
        type: "subagent",
        parentAgentId: "main",
      });

      try {
        presenter.startRun("Run audit");
        await new Promise((r) => setTimeout(r, 60));

        assert(mock.getOutput().includes("\x1b[?1049h"), "启动必须使用 \\x1b[?1049h 进入全屏备用屏幕");

        mock.clearBuffer();

        // 切换到 Agent View
        presenter.switchToAgentView("build-checker");
        await new Promise((r) => setTimeout(r, 60));

        const output = mock.getOutput();
        assert(output.includes("build-checker"), "视图应显示 Agent 名称");
        // 严禁输出旧的 banner
        assert.equal(output.includes("Viewing Agent:"), false, "严禁输出 'Viewing Agent:'");
        assert.equal(output.includes("──────────────────────────────────────────────────\nViewing Agent"), false);

        mock.clearBuffer();

        // 退出回 Main
        presenter.returnToMainView();
        await new Promise((r) => setTimeout(r, 60));

        const backOutput = mock.getOutput();
        assert.equal(backOutput.includes("Returned to Main View"), false, "严禁输出 'Returned to Main View'");
      } finally {
        presenter.stopRun();
        presenter.leaveAppScreen();
        assert(mock.getOutput().includes("\x1b[?1049l"), "退出必须使用 \\x1b[?1049l 退出备用屏幕");
        presenter.destroy();
      }
    });

    it("2.2 连续进入/退出同一 Agent 10 次，Main stdout 历史记录零增长", async () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      const mock = createMockTtyStream();

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      agentRegistry.register({
        agentId: "test-runner",
        name: "test-runner",
        type: "subagent",
      });

      try {
        presenter.startRun("Main scan");
        await new Promise((r) => setTimeout(r, 60));

        for (let i = 0; i < 10; i++) {
          mock.clearBuffer();
          presenter.switchToAgentView("test-runner");
          await new Promise((r) => setTimeout(r, 20));
          const enterOut = mock.getOutput();
          assert.equal(enterOut.includes("Viewing Agent:"), false);

          mock.clearBuffer();
          presenter.returnToMainView();
          await new Promise((r) => setTimeout(r, 20));
          const leaveOut = mock.getOutput();
          assert.equal(leaveOut.includes("Returned to Main View"), false);
        }
      } finally {
        presenter.stopRun();
        presenter.destroy();
      }
    });

    it("2.3 Main 代理进入 AppScreen 即进入 Alternate Screen，固定在窗口内且退出时主屏幕零残留", async () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      const mock = createMockTtyStream(80, 24);

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
        // 默认 nativeScrollback = false
      });

      try {
        presenter.enterAppScreen();
        assert(mock.getOutput().includes("\x1b[?1049h"), "启动 Main 必须使用 \\x1b[?1049h 进入全屏备用屏幕");
        assert(mock.getOutput().includes("\x1b[?1000h\x1b[?1002h\x1b[?1006h"), "备用屏幕必须启用拖动与滚轮报告");

        const mainProj = presenter.getProjection("main");
        for (let i = 0; i < 20; i++) {
          mainProj.addSystemNotice(`Main transcript message ${i}`);
        }
        presenter.render();

        // 视口固定渲染，使用的是绝对坐标 renderFullScreen 而不是写入 Shell scrollback
        assert(mock.getOutput().includes("\x1b[1;1H"), "全屏备用屏幕下必须使用绝对坐标重绘视口");
        mock.clearBuffer();

        // 模拟用户在 Main 界面上滚滚轮
        const nav = presenter.getNavigationHandler();
        nav.onMouseWheelUp?.();
        nav.onMouseWheelUp?.();
        // 验证滚轮仅在备用屏幕内滚动 Transcript，未退出备用屏幕
        assert.equal(mock.getOutput().includes("\x1b[?1049l"), false, "滚轮查看历史严禁退出备用屏幕");

        mock.clearBuffer();
      } finally {
        // 退出 CLI
        presenter.leaveAppScreen();
        presenter.destroy();
        const exitOutput = mock.getOutput();
        assert(exitOutput.includes("\x1b[?1049l"), "退出必须下发 \\x1b[?1049l 彻底恢复宿主主屏幕");
        assert(exitOutput.includes("\x1b[?1000l") && exitOutput.includes("\x1b[?1006l"), "退出必须彻底注销鼠标捕获");
      }
    });
  });

  describe("3. AgentTranscriptProjection & Tool Call/Result Pairing", () => {
    it("3.1 准确按 callId 配对 tool_call 与 tool_result 并单行展示状态，自动收敛瞬态 thinking", () => {
      const proj = new AgentTranscriptProjection("test-runner");

      // 1. 模型思考中应可展示 thinking...
      proj.addThought();
      assert(proj.getAllRenderedLines().join("\n").includes("thinking..."));

      // 2. 工具开始执行时，瞬态 thinking 自动被清理收敛，工具呈现为初始行（前置指示灯 ●）
      proj.addToolCallStart("call-1", "bash", "npm test");
      const linesAfterStart = proj.getAllRenderedLines();
      assert.equal(linesAfterStart.join("\n").includes("thinking..."), false, "工具启动后瞬态 thinking 应被自动收敛");
      assert(linesAfterStart.some((l) => l.includes("bash") && l.includes("npm test") && l.includes("●")));

      // 3. 工具执行完成，前置指示灯变为 ✔，耗时在尾部呈现
      proj.completeToolCall("call-1", "bash", true, 1200, "42 tests passed");

      proj.addToolCallStart("call-2", "read_file", "package.json");
      proj.completeToolCall("call-2", "read_file", true, 2, "{\"name\": \"nash\"}");

      const allLines = proj.getAllRenderedLines();
      const rendered = allLines.join("\n");

      assert.equal(rendered.includes("thinking..."), false, "最终 transcript 不应包含孤儿 thinking");
      // 验证第一行即为 ✔ + 工具名 + 参数 + 耗时
      const bashLine = allLines.find((l) => l.includes("bash"));
      assert(bashLine, "应存在 bash 工具行");
      assert(bashLine.includes("npm test"), "bash 行应包含参数摘要");
      assert(bashLine.includes("✔"), "bash 行首部应包含完成状态灯 ✔");
      assert(bashLine.includes("1.2s"), "bash 行尾部应包含执行耗时");

      // 验证次行缩进展示 preview
      assert(rendered.includes("42 tests passed"));

      const readFileLine = allLines.find((l) => l.includes("read_file"));
      assert(readFileLine, "应存在 read_file 工具行");
      assert(readFileLine.includes("package.json"));
      assert(readFileLine.includes("✔"));
      assert(readFileLine.includes("2ms"));
    });

    it("3.2 失败的工具调用应在同一行标红 ✖ 并展示错误信息", () => {
      const proj = new AgentTranscriptProjection("test-runner");

      proj.addToolCallStart("call-err", "bash", "cargo build");
      proj.completeToolCall("call-err", "bash", false, 450, "error[E0425]: cannot find value");

      const allLines = proj.getAllRenderedLines();
      const errLine = allLines.find((l) => l.includes("bash"));
      assert(errLine, "应存在 bash 工具行");
      assert(errLine.includes("cargo build"));
      assert(errLine.includes("✖"));
      assert(errLine.includes("450ms"));
      assert(allLines.join("\n").includes("cannot find value"));
    });

    it("3.3 能够从 Session Records 批量回放包含 toolCalls 与 toolResults 的完整历史", () => {
      const proj = new AgentTranscriptProjection("builder");

      const records: SessionRecord[] = [
        {
          type: "user",
          id: "u1",
          content: "Please build the project",
          createdAt: Date.now() - 5000,
        },
        {
          type: "assistant",
          id: "a1",
          content: "I will check build configuration.",
          toolCalls: [
            {
              id: "call-100",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "tsconfig.json" }),
              },
            },
          ],
          createdAt: Date.now() - 4000,
        },
        {
          type: "tool_result",
          id: "tr1",
          toolCallId: "call-100",
          toolName: "read_file",
          preview: "{\n  \"compilerOptions\": { \"strict\": true }\n}",
          originalChars: 50,
          offloaded: false,
          success: true,
          executionTimeMs: 5,
          createdAt: Date.now() - 3900,
        },
        {
          type: "assistant",
          id: "a2",
          content: "Build check completed successfully.",
          createdAt: Date.now() - 1000,
        },
      ];

      proj.projectFromSessionRecords(records);
      const rendered = proj.getAllRenderedLines().join("\n");

      assert(rendered.includes("Please build the project"));
      assert(rendered.includes("I will check build configuration."));
      assert(rendered.includes("read_file"));
      assert(rendered.includes("tsconfig.json"));
      assert(rendered.includes("✔"));
      assert(rendered.includes("5ms"));
      assert(rendered.includes("Build check completed successfully."));
    });

    it("3.4 已完成 (completed) 的 Agent 仍然可以通过 loadSessionRecords 查看完整历史", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      const mock = createMockTtyStream();

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        stdout: mock.stream,
        isTTY: true,
      });

      const agent = agentRegistry.register({
        agentId: "archived-agent",
        name: "archived-agent",
        type: "subagent",
      });
      agentRegistry.updateStatus("archived-agent", "completed");

      const records: SessionRecord[] = [
        {
          type: "assistant",
          id: "m1",
          content: null,
          toolCalls: [
            {
              id: "c-old",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: "git status" }),
              },
            },
          ],
          createdAt: Date.now() - 10000,
        },
        {
          type: "tool_result",
          id: "r-old",
          toolCallId: "c-old",
          toolName: "bash",
          preview: "On branch main, working tree clean",
          originalChars: 35,
          offloaded: false,
          success: true,
          executionTimeMs: 15,
          createdAt: Date.now() - 9980,
        },
      ];

      presenter.loadSessionRecords("archived-agent", records);
      presenter.startRun("Inspect history");

      presenter.switchToAgentView("archived-agent");
      const out = mock.getOutput();

      assert(out.includes("archived-agent"));
      assert(out.includes("git status"));
      assert(out.includes("15ms"));

      presenter.stopRun();
      presenter.destroy();
    });

    it("3.5 支持流式思考 (appendThoughtDelta) 与思考摘要块 (finalizeThought)", () => {
      const proj = new AgentTranscriptProjection("thought-tester");

      // 1. 逐步接收思考流
      proj.appendThoughtDelta("Analyzing the codebase architecture");
      proj.appendThoughtDelta(" and checking file access boundaries.");

      const runningLines = proj.getAllRenderedLines().join("\n");
      assert(runningLines.includes("💭 thinking..."));
      assert(runningLines.includes("Analyzing the codebase architecture"));

      // 2. 思考完成，收敛为 Thought Summary 块
      proj.finalizeThought(2400, 320);

      const finalizedLines = proj.getAllRenderedLines().join("\n");
      assert.equal(finalizedLines.includes("💭 thinking..."), false);
      assert(finalizedLines.includes("Thought for 2.4s"));
      assert.equal(finalizedLines.includes("320 tokens"), false);
      assert(finalizedLines.includes("↳ Analyzing the codebase architecture"));

      // 3. 开始流式输出正文
      proj.appendContentDelta("Here is the **detailed** report.");
      proj.appendContentDelta("\n- Item 1\n- Item 2");
      proj.finalizeContent();

      const finalAll = proj.getAllRenderedLines().join("\n");
      assert(finalAll.includes("Thought for 2.4s"));
      assert(finalAll.includes("Here is the"));
      assert(finalAll.includes("detailed"));
      assert(finalAll.includes("Item 1"));
    });

    it("3.6 从包含 reasoning_content 的 SessionRecord 重建历史思考摘要块", () => {
      const proj = new AgentTranscriptProjection("history-reasoner");

      const records: SessionRecord[] = [
        {
          type: "user",
          id: "u-r1",
          content: "Why is the build failing?",
          createdAt: Date.now() - 10000,
        },
        {
          type: "assistant",
          id: "a-r1",
          content: "The compiler options are mismatched.",
          reasoning_content: "Checking tsconfig.json compilerOptions strict mode flag.",
          reasoningDurationMs: 1800,
          createdAt: Date.now() - 9000,
        } as any,
      ];

      proj.projectFromSessionRecords(records);
      const rendered = proj.getAllRenderedLines().join("\n");

      assert(rendered.includes("Why is the build failing?"));
      assert(rendered.includes("Thought for 1.8s"));
      assert(rendered.includes("↳ Checking tsconfig.json compilerOptions strict mode flag."));
      assert(rendered.includes("The compiler options are mismatched."));
    });

    it("3.7 edit_file 与 write_file 产生详细的代码 Diff 与内容写入预览 (终端 Diff 预览风格)", () => {
      const proj = new AgentTranscriptProjection("coder");

      // 1. 测试 edit_file (JSON 字符串形式入参)
      proj.addToolCallStart("call-edit-1", "edit_file", "editing index.ts", JSON.stringify({
        path: "index.ts",
        old_text: "const a = 1;\nconst b = 2;",
        new_text: "const a = 10;\nconst b = 20;\nconst c = 30;",
      }));
      proj.completeToolCall("call-edit-1", "edit_file", true, 4, undefined, JSON.stringify({
        path: "index.ts",
        old_text: "const a = 1;\nconst b = 2;",
        new_text: "const a = 10;\nconst b = 20;\nconst c = 30;",
      }));

      const renderedEdit = proj.getAllRenderedLines().join("\n");
      const plainEdit = stripAnsi(renderedEdit);
      assert(plainEdit.includes("Update(index.ts)"));
      assert(plainEdit.includes("Added 3 lines, removed 2 lines"));
      assert(plainEdit.includes("- const a = 1;"));
      assert(plainEdit.includes("- const b = 2;"));
      assert(plainEdit.includes("+ const a = 10;"));
      assert(plainEdit.includes("+ const b = 20;"));
      assert(plainEdit.includes("+ const c = 30;"));
      assert(renderedEdit.includes("\x1b[48;5;52m"));
      assert(renderedEdit.includes("\x1b[48;5;22m"));

      // 2. 测试 write_file (对象形式入参)
      proj.addToolCallStart("call-write-1", "write_file", "writing app.html", {
        path: "app.html",
        content: "<!DOCTYPE html>\n<html>\n<body>\n<h1>Hello</h1>\n</body>\n</html>",
      });
      proj.completeToolCall("call-write-1", "write_file", true, 5, undefined, {
        path: "app.html",
        content: "<!DOCTYPE html>\n<html>\n<body>\n<h1>Hello</h1>\n</body>\n</html>",
      });

      const renderedAll = proj.getAllRenderedLines().join("\n");
      assert(renderedAll.includes("Write(app.html)"));
      assert(renderedAll.includes("Written 6 lines"));
      assert(stripAnsi(renderedAll).includes("1 +  <!DOCTYPE html>"));
      assert(stripAnsi(renderedAll).includes("4 +  <h1>Hello</h1>"));
    });
  });

  describe("4. Viewport Scrolling & Auto-Follow Semantics", () => {
    it("4.1 视口默认处于 auto-follow 状态，新事件到达时自动滚到底部", () => {
      const proj = new AgentTranscriptProjection("agent-scroll");
      assert.equal(proj.isAutoFollow(), true);
      assert.equal(proj.getScrollOffset(), 0);

      for (let i = 0; i < 30; i++) {
        proj.addToolCallStart(`c-${i}`, "bash", `echo step-${i}`);
        proj.completeToolCall(`c-${i}`, "bash", true, 10, `result-${i}`);
      }

      const lines = proj.renderViewport({ width: 80, height: 10, scrollOffset: proj.getScrollOffset() });
      assert.equal(lines.length, 10);
      assert(lines[lines.length - 2].includes("result-29") || lines[lines.length - 3].includes("step-29"));
    });

    it("4.2 用户主动向上滚动后自动暂停 auto-follow，新事件不强制拉回底部", () => {
      const proj = new AgentTranscriptProjection("agent-scroll");

      for (let i = 0; i < 20; i++) {
        proj.addToolCallStart(`c-${i}`, "bash", `echo item-${i}`);
        proj.completeToolCall(`c-${i}`, "bash", true, 5, `out-${i}`);
      }

      // 用户向上滚动 5 行
      proj.scrollUp(5);
      assert.equal(proj.isAutoFollow(), false);
      assert.equal(proj.getScrollOffset(), 5);

      // 新事件到达
      proj.addToolCallStart("c-new", "bash", "echo new-step");
      proj.completeToolCall("c-new", "bash", true, 5, "out-new");

      // auto-follow 依然为 false，保持用户查看的位置
      assert.equal(proj.isAutoFollow(), false);

      // 按 End 键恢复 follow
      proj.scrollToBottom();
      assert.equal(proj.isAutoFollow(), true);
      assert.equal(proj.getScrollOffset(), 0);
    });

    it("4.3 支持 PageUp / PageDown 与 Home / End 导航", () => {
      const proj = new AgentTranscriptProjection("agent-nav");

      for (let i = 0; i < 50; i++) {
        proj.addToolCallStart(`c-${i}`, "tool", `args-${i}`);
        proj.completeToolCall(`c-${i}`, "tool", true, 1, `res-${i}`);
      }

      proj.pageUp(15);
      assert.equal(proj.isAutoFollow(), false);
      assert.equal(proj.getScrollOffset(), 15);

      proj.pageDown(5);
      assert.equal(proj.getScrollOffset(), 10);

      proj.scrollToTop(150, 15);
      assert(proj.getScrollOffset() > 100);

      proj.scrollToBottom();
      assert.equal(proj.getScrollOffset(), 0);
      assert.equal(proj.isAutoFollow(), true);
    });
  });
});
