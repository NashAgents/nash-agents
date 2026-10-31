import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { TaskManager } from "../src/task/task-manager.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { DecisionController } from "../src/decision/decision-controller.js";

function createMockTtyStream(columns = 80, rows = 24) {
  const stream = new PassThrough() as any;
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = rows;
  const frames: string[] = [];
  let currentBuffer = "";

  stream.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    currentBuffer += text;
    // 捕获每一个完整的绝对坐标渲染 Frame (以 \x1b[1;1H 开头或清除屏幕后)
    if (text.includes("\x1b[1;1H")) {
      frames.push(text);
    }
  });

  return {
    stream,
    getRawOutput: () => currentBuffer,
    getFrames: () => frames,
    clear: () => {
      currentBuffer = "";
      frames.length = 0;
    },
  };
}

describe("Run Atomic UI Transition & Transition Guard", () => {
  it("1. Idle Submit 后只出现 1 次 Running initial render（无中间过渡帧）", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.enterAppScreen();
    const idleFramesCount = mock.getFrames().length;
    mock.clear();

    // 触发原子 Run Transition
    presenter.beginRunTransition("你好");
    assert.equal(mock.getFrames().length, 0, "beginRunTransition 期间不得输出任何帧");

    presenter.commitRunTransition();
    assert.equal(mock.getFrames().length, 1, "commit 后应且仅应输出 1 次完整首帧");

    const firstFrame = mock.getFrames()[0];
    assert.ok(firstFrame.includes("Nash"), "首帧必须包含 Header");
    assert.ok(firstFrame.includes(">"), "首帧必须包含 User Message");
    assert.ok(firstFrame.includes("Main"), "首帧必须包含 Main Agent");

    presenter.destroy();
  });

  it("2. 不出现 partial Running frame (首帧必须具备完整 Header/Transcript/Composer)", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.startRun("测试完整首帧");
    const frames = mock.getFrames();
    assert.equal(frames.length, 1);

    const frame = frames[0];
    // 验证核心区域完整性
    assert.ok(frame.includes("Nash") && frame.includes("working"), "区域 1: Header");
    assert.ok(frame.includes(">"), "区域 2: Transcript");
    assert.ok(frame.includes("> 给 Main 输入新的指令..."), "区域 3: Composer");

    presenter.destroy();
  });

  it("3. User Message 出现在第一份 Running Frame", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.startRun("你好，请帮我分析代码");
    const frame = mock.getFrames()[0];
    assert.ok(frame.includes("你好，请帮我分析代码"));

    presenter.destroy();
  });

  it("4. Main Agent 出现在第一份 Running Frame", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    // 启动前 AgentRegistry 无任何注册
    assert.equal(agentRegistry.getAllAgents().length, 0);

    presenter.startRun("启动任务");
    // 启动后 Main 必须已注册为 running
    const mainRecord = agentRegistry.getAgent("main");
    assert.ok(mainRecord);
    assert.equal(mainRecord.status, "running");

    const frame = mock.getFrames()[0];
    assert.ok(frame.includes("Main"));
    assert.ok(frame.includes("working"));

    presenter.destroy();
  });

  it("5. Composer 出现在第一份 Running Frame 且光标位置正确", () => {
    const mock = createMockTtyStream(80, 24);
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.startRun("指令输入测试");
    const raw = mock.getRawOutput();
    assert.ok(raw.includes("> 给 Main 输入新的指令..."));
    // 检查光标激活序列 (\x1b[?25h)
    assert.ok(raw.includes("\x1b[?25h"));

    presenter.destroy();
  });

  it("6. Agents Panel 出现在多 Agent 的第一份 Running Frame", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    agentRegistry.register({ agentId: "main", type: "main" });
    agentRegistry.register({ agentId: "worker-1", name: "worker-1", type: "subagent" });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.startRun("面板测试");
    const frame = mock.getFrames()[0];
    assert.ok(frame.includes("Agents"));
    assert.ok(frame.includes("↑↓ scroll · Ctrl+N/P select · Enter open"));

    presenter.destroy();
  });

  it("7. thinking 事件在 transition 中只 mark dirty，不产生早期 partial frame", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.beginRunTransition("提问");
    assert.equal(mock.getFrames().length, 0);

    // 在 Transition 保护期间到达 model.started 事件
    eventBus.emit({
      id: "1",
      type: "model.started" as any,
      timestamp: new Date().toISOString(),
      projectId: "test",
      sessionId: "test",
      data: {},
    });

    // 验证 Transition 期间仍然 0 帧输出
    assert.equal(mock.getFrames().length, 0);

    // 提交 Transition
    presenter.commitRunTransition();
    assert.equal(mock.getFrames().length, 1);

    // 首帧直接包含了 thinking...
    const frame = mock.getFrames()[0];
    assert.ok(frame.includes("thinking..."));
    assert.ok(frame.includes("> 给 Main 输入新的指令..."));

    presenter.destroy();
  });

  it("8. tool.started 在 transition 中只 mark dirty，不产生早期 partial frame", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.beginRunTransition("读取文件");

    eventBus.emit({
      id: "2",
      type: "tool.started" as any,
      timestamp: new Date().toISOString(),
      projectId: "test",
      sessionId: "test",
      data: { name: "read_file", args: { path: "src/index.ts" } },
    });

    assert.equal(mock.getFrames().length, 0);

    presenter.commitRunTransition();
    assert.equal(mock.getFrames().length, 1);

    const frame = mock.getFrames()[0];
    assert.ok(frame.includes("read_file"));
    assert.ok(frame.includes("src/index.ts"));

    presenter.destroy();
  });

  it("9. 多个 early events 合并成一次 render", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.beginRunTransition("复杂分析");

    // 连续触发多个早期事件
    eventBus.emit({ id: "e1", type: "agent.running" as any, timestamp: "", projectId: "", sessionId: "", data: {} });
    eventBus.emit({ id: "e2", type: "model.started" as any, timestamp: "", projectId: "", sessionId: "", data: {} });
    eventBus.emit({ id: "e3", type: "tool.started" as any, timestamp: "", projectId: "", sessionId: "", data: { name: "grep_search", args: { query: "export" } } });

    assert.equal(mock.getFrames().length, 0);

    presenter.commitRunTransition();
    // 严格合并为一次完整的首帧
    assert.equal(mock.getFrames().length, 1);

    const frame = mock.getFrames()[0];
    assert.ok(frame.includes("grep_search"));
    assert.ok(frame.includes(">"));

    presenter.destroy();
  });

  it("10. transition 后 latest state 正确显示", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.beginRunTransition("状态检查");

    eventBus.emit({
      id: "e4",
      type: "model.started" as any,
      timestamp: "",
      projectId: "",
      sessionId: "",
      data: {},
    });

    presenter.commitRunTransition();
    const frame = mock.getFrames()[0];
    assert.ok(frame.includes("Nash") && frame.includes("working"));
    assert.ok(frame.includes("thinking..."));

    presenter.destroy();
  });

  it("11. startRun UI 不重复执行（幂等性）", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    const runId = "fixed-run-123";
    presenter.startRun("一次任务", runId);
    assert.equal(mock.getFrames().length, 1);

    // 重复对相同 runId 调用 startRun
    presenter.startRun("一次任务", runId);
    assert.equal(mock.getFrames().length, 1, "相同 runId 不得重复触发 startRun 重新渲染");

    presenter.destroy();
  });

  it("12. 不存在 direct stdout transcript write (所有输出通过全屏缓冲区)", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.startRun("测试缓冲");
    const raw = mock.getRawOutput();

    // 确认所有行绘制均基于标准光标绝对定位序列 \x1b[<row>;<col>H
    assert.ok(raw.includes("\x1b[1;1H"));
    assert.ok(raw.includes("\x1b[2;1H"));
    // 不应存在未受控的裸 console.log 乱码
    assert.ok(!raw.includes("undefined"));

    presenter.destroy();
  });

  it("13. transition error 正确恢复 idle", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.beginRunTransition("出错任务");
    assert.equal(presenter.isTransitioning(), true);

    // 模拟初始化失败回滚
    presenter.rollbackRunTransition(new Error("Init failed"));
    assert.equal(presenter.isTransitioning(), false);
    assert.equal(
      presenter.getInteractionMode() === "empty-session" ||
        presenter.getInteractionMode() === "idle",
      true
    );

    const frames = mock.getFrames();
    const lastFrame = frames[frames.length - 1];
    assert.ok(lastFrame.toLowerCase().includes("ready"), "回滚后应呈现 Idle/Ready 视图");

    presenter.destroy();
  });

  it("14. transition error 恢复 cursor", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.beginRunTransition("测试光标");
    mock.clear();

    presenter.rollbackRunTransition(new Error("fail"));
    const raw = mock.getRawOutput();
    assert.ok(raw.includes("\x1b[?25h"), "回滚必须恢复光标可见性");

    presenter.destroy();
  });

  it("15. transition error 不残留 Main Agent running", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.beginRunTransition("错误处理");
    presenter.rollbackRunTransition(new Error("Fatal"));

    const main = agentRegistry.getAgent("main");
    assert.ok(main);
    assert.notEqual(main.status, "running", "Main Agent 状态不得残留为 running");
    assert.equal(main.status, "failed");

    presenter.destroy();
  });

  it("16. resize event during transition 不触发 partial render", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.beginRunTransition("缩放测试");
    assert.equal(mock.getFrames().length, 0);

    // 模拟终端在 Transition 期间触发 resize
    (presenter as any).handleResize();
    assert.equal(mock.getFrames().length, 0, "Transition 期间 resize 不得输出 partial frame");

    presenter.commitRunTransition();
    assert.equal(mock.getFrames().length, 1);

    presenter.destroy();
  });

  it("17. approval event during transition 不触发 partial frame", () => {
    const mock = createMockTtyStream();
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const decisionController = new DecisionController();
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      decisionController,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.beginRunTransition("审批测试");

    // 模拟决策挂起
    decisionController
      .requestDecision({
        id: "dec-1",
        kind: "permission",
        title: "Test permission",
        options: [{ id: "y", label: "Yes" }],
        defaultIndex: 0,
      })
      .catch(() => {});

    assert.equal(mock.getFrames().length, 0);

    presenter.commitRunTransition();
    assert.equal(mock.getFrames().length, 1);

    presenter.destroy();
  });

  it("18. non-TTY 行为保持现有逻辑（不输出 ANSI 控制序列）", () => {
    const mock = createMockTtyStream();
    (mock.stream as any).isTTY = false;
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: false,
    });

    presenter.beginRunTransition("Non-TTY 测试");
    presenter.commitRunTransition();

    // Non-TTY 模式不调用 renderFullScreen
    assert.equal(mock.getFrames().length, 0);
    assert.equal(mock.getRawOutput(), "");

    presenter.destroy();
  });
});
