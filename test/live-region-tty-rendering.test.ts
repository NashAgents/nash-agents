import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  TerminalRenderer,
  getVisibleWidth,
  calculatePhysicalRowsForLine,
  calculateTotalPhysicalRows,
  truncateToDisplayWidth,
  CliPresenter,
} from "../src/presentation/index.js";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/index.js";
import { TaskManager } from "../src/task/index.js";
import { JobManager } from "../src/jobs/index.js";

/**
 * 创建模拟可捕获的 TTY Stream
 */
function createMockTtyStream(columns = 80): {
  stream: NodeJS.WriteStream;
  getOutput: () => string;
  getChunks: () => string[];
  clearBuffer: () => void;
  setColumns: (cols: number) => void;
} {
  const chunks: string[] = [];
  let currentColumns = columns;

  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  (stream as any).isTTY = true;
  Object.defineProperty(stream, "columns", {
    get: () => currentColumns,
    configurable: true,
  });

  const originalWrite = stream.write.bind(stream);
  stream.write = function (chunk: any, ...args: any[]): boolean {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    chunks.push(text);
    return originalWrite(chunk, ...args);
  } as any;

  return {
    stream,
    getOutput: () => chunks.join(""),
    getChunks: () => [...chunks],
    clearBuffer: () => {
      chunks.length = 0;
    },
    setColumns: (cols: number) => {
      currentColumns = cols;
    },
  };
}

function makeEvent<T = any>(partial: Partial<any> & { type: string }): any {
  return {
    id: "evt-" + Math.random().toString(36).slice(2),
    timestamp: Date.now(),
    projectId: "proj-test",
    sessionId: "sess-test",
    data: {},
    ...partial,
  };
}

describe("TerminalRenderer & Live Region TTY Redraw", () => {
  it("1. 中文 CJK / Emoji / ANSI 字符显示宽度与可见宽度测量", () => {
    // 纯英文
    assert.equal(getVisibleWidth("Nash"), 4);

    // ANSI 颜色代码不计入显示宽度
    assert.equal(getVisibleWidth("\x1b[36mNash\x1b[0m"), 4);
    assert.equal(getVisibleWidth("\x1b[1m\x1b[33mworking\x1b[0m"), 7);

    // CJK 双宽中文字符
    assert.equal(getVisibleWidth("创建文件"), 8);
    assert.equal(getVisibleWidth("多子Agent协同"), 13);

    // Emoji 符号
    assert.equal(getVisibleWidth("✓"), 1);
    assert.equal(getVisibleWidth("🚀"), 2);
    assert.equal(getVisibleWidth("⛔"), 2);
  });

  it("2. 长行在指定终端列宽下的物理行数 (Physical Rows) 计算", () => {
    // 80 列宽度下：
    // 短行 (<= 80) -> 1 行
    assert.equal(calculatePhysicalRowsForLine("Hello World", 80), 1);
    assert.equal(calculatePhysicalRowsForLine("", 80), 1);

    // 80 字符英文 (正好 80 列) -> 1 行
    assert.equal(calculatePhysicalRowsForLine("a".repeat(80), 80), 1);

    // 81 字符英文 (超过 80 列) -> 2 行
    assert.equal(calculatePhysicalRowsForLine("a".repeat(81), 80), 2);

    // 160 字符 -> 2 行; 161 字符 -> 3 行
    assert.equal(calculatePhysicalRowsForLine("a".repeat(160), 80), 2);
    assert.equal(calculatePhysicalRowsForLine("a".repeat(161), 80), 3);

    // 中文字符双宽 Wrap 计算: 41 个汉字 = 82 列宽 (在 80 列终端下占 2 行)
    assert.equal(calculatePhysicalRowsForLine("字".repeat(41), 80), 2);
  });

  it("3. 多行 Frame 总物理行数计算", () => {
    const frame = "Line 1\nLine 2\nLine 3\n";
    assert.equal(calculateTotalPhysicalRows(frame, 80), 3);

    // 包含 1 行长行 (100 字符在 80 列下占 2 行) + 2 行短行 -> 总计 4 行
    const longFrame = `Line 1\n${"x".repeat(100)}\nLine 3\n`;
    assert.equal(calculateTotalPhysicalRows(longFrame, 80), 4);
  });

  it("4. truncateToDisplayWidth 确保单行不超过终端列宽", () => {
    const text = "A very long activity description that exceeds limit";
    const truncated = truncateToDisplayWidth(text, 20);
    assert(getVisibleWidth(truncated) <= 20);
    assert(truncated.endsWith("…\x1b[0m") || truncated.endsWith("…"));

    // 中文截断
    const cjkText = "这是一个非常长的中文任务执行说明";
    const cjkTruncated = truncateToDisplayWidth(cjkText, 10);
    assert(getVisibleWidth(cjkTruncated) <= 10);

    const colored = truncateToDisplayWidth("\x1b[48;5;22m\x1b[32m" + "绿色代码".repeat(10) + "\x1b[0m", 12);
    assert(colored.includes("\x1b[48;5;22m"));
    assert(colored.includes("\x1b[32m"));
    assert(getVisibleWidth(colored) <= 12);
  });

  it("5. TerminalRenderer: 第一帧正确输出，第二帧使用 ANSI 光标回退清除旧帧而非简单追加", async () => {
    const mock = createMockTtyStream(80);
    const renderer = new TerminalRenderer({ stdout: mock.stream, isTTY: true });

    // 渲染第一帧 (3 行)
    const frame1 = "Header 00:14\nAgents\n  Main running\n";
    await renderer.renderFrame(frame1);

    assert.equal(renderer.getLastRenderedPhysicalRows(), 3);
    assert.equal(mock.getOutput(), frame1);

    mock.clearBuffer();

    // 渲染第二帧 (3 行，时间变化为 00:16)
    const frame2 = "Header 00:16\nAgents\n  Main running\n";
    await renderer.renderFrame(frame2);

    const out2 = mock.getOutput();
    // 关键校验：第二帧输出前必须先上移 3 行并清除屏幕下方 (\x1b[3A\r\x1b[J)
    assert(
      out2.startsWith("\x1b[3A\r\x1b[J"),
      "必须先回退 3 行并清除屏幕下方，再绘制新帧"
    );
    assert(out2.includes("Header 00:16"));
    assert.equal(renderer.getLastRenderedPhysicalRows(), 3);
  });

  it("6. 旧帧比新帧高时（收缩），底部残留被 \\x1b[J (clearScreenDown) 彻底清除", async () => {
    const mock = createMockTtyStream(80);
    const renderer = new TerminalRenderer({ stdout: mock.stream, isTTY: true });

    // 旧帧高 (5 行)
    const tallFrame = "Header\nLine 1\nLine 2\nLine 3\nLine 4\n";
    await renderer.renderFrame(tallFrame);
    assert.equal(renderer.getLastRenderedPhysicalRows(), 5);

    mock.clearBuffer();

    // 新帧矮 (2 行)
    const shortFrame = "Header\nDone\n";
    await renderer.renderFrame(shortFrame);

    const out = mock.getOutput();
    // 回退旧帧的 5 行并清屏到末尾
    assert(out.startsWith("\x1b[5A\r\x1b[J"));
    assert(out.includes("Done"));
    assert.equal(renderer.getLastRenderedPhysicalRows(), 2);
  });

  it("7. 新帧比旧帧高时（扩展），正确向上回退旧行数并扩展绘制新行", async () => {
    const mock = createMockTtyStream(80);
    const renderer = new TerminalRenderer({ stdout: mock.stream, isTTY: true });

    // 旧帧矮 (2 行)
    const shortFrame = "Header\nMain running\n";
    await renderer.renderFrame(shortFrame);
    assert.equal(renderer.getLastRenderedPhysicalRows(), 2);

    mock.clearBuffer();

    // 新帧高 (5 行，派生了子 Agent)
    const tallFrame = "Header\nAgents\n  Main running\n  └ sub1 running\n  └ sub2 running\n";
    await renderer.renderFrame(tallFrame);

    const out = mock.getOutput();
    assert(out.startsWith("\x1b[2A\r\x1b[J"));
    assert.equal(renderer.getLastRenderedPhysicalRows(), 5);
  });

  it("8. 完全相同的 Frame 不触发重复写入", async () => {
    const mock = createMockTtyStream(80);
    const renderer = new TerminalRenderer({ stdout: mock.stream, isTTY: true });

    const frame = "Static Frame\n";
    await renderer.renderFrame(frame);
    assert.equal(mock.getChunks().length, 1);

    mock.clearBuffer();
    // 再次提交完全相同的 Frame
    await renderer.renderFrame(frame);
    assert.equal(mock.getChunks().length, 0, "完全相同的 Frame 不应重复写入 stdout");
  });

  it("9. 并发调用 renderFrame 严格串行化执行，绝不交叉混乱", async () => {
    const mock = createMockTtyStream(80);
    const renderer = new TerminalRenderer({ stdout: mock.stream, isTTY: true });

    // 并发提交多个 frame
    const p1 = renderer.renderFrame("Frame 1\n");
    const p2 = renderer.renderFrame("Frame 2\n");
    const p3 = renderer.renderFrame("Frame 3\n");

    await Promise.all([p1, p2, p3]);

    // 最终状态必须收敛为 Frame 3
    assert.equal(renderer.getLastRenderedFrame(), "Frame 3\n");
    assert.equal(renderer.getLastRenderedPhysicalRows(), 1);
  });

  it("10. clear() 能够彻底清除 Live Region 并重置状态", async () => {
    const mock = createMockTtyStream(80);
    const renderer = new TerminalRenderer({ stdout: mock.stream, isTTY: true });

    await renderer.renderFrame("Active Line 1\nActive Line 2\n");
    assert.equal(renderer.getLastRenderedPhysicalRows(), 2);

    mock.clearBuffer();
    renderer.clear();

    assert.equal(mock.getOutput(), "\x1b[2A\r\x1b[J");
    assert.equal(renderer.getLastRenderedPhysicalRows(), 0);
  });

  it("11. Terminal Resize 触发自适应重绘", async () => {
    const mock = createMockTtyStream(80);
    const renderer = new TerminalRenderer({ stdout: mock.stream, isTTY: true });

    // 原始宽度 80 下输出 100 字符（占 2 行）
    const longLine = "A".repeat(100);
    await renderer.renderFrame(`${longLine}\n`);
    assert.equal(renderer.getLastRenderedPhysicalRows(), 2);

    // 调整终端宽度到 120 列（100 字符现在只需 1 行）
    mock.setColumns(120);
    renderer.handleResize();

    // 等待渲染调度
    assert.equal(renderer.getLastRenderedPhysicalRows(), 1);
  });

  it("12. Non-TTY 模式不输出任何 ANSI 光标控制序列", async () => {
    const nonTtyStream = new PassThrough() as unknown as NodeJS.WriteStream;
    (nonTtyStream as any).isTTY = false;

    const chunks: string[] = [];
    nonTtyStream.write = function (chunk: any): boolean {
      chunks.push(String(chunk));
      return true;
    } as any;

    const renderer = new TerminalRenderer({ stdout: nonTtyStream, isTTY: false });
    await renderer.renderFrame("Non TTY Frame\n");

    assert.equal(chunks.length, 0, "Non-TTY 模式下 TerminalRenderer 不应输出 ANSI 序列");
  });
});

describe("CliPresenter Live Region Lifecycle & State Convergence", () => {
  it("13. CliPresenter 在 TTY 模式下原地刷新 elapsed 与 Agent 动态", async () => {
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    agentRegistry.register({
      agentId: "main",
      type: "main",
      depth: 0,
    });
    agentRegistry.updateStatus("main", "running");
    const mock = createMockTtyStream(80);

    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    try {
      presenter.startRun("Analyze project");
      // 等待初始渲染
      await new Promise((r) => setTimeout(r, 80));

      const firstOutput = mock.getOutput();
      assert(firstOutput.includes("Nash"), "第一帧应包含品牌 Header");
      assert(firstOutput.includes("working"), "第一帧应包含 working 状态");

      mock.clearBuffer();

      // 注册并派生一个 SubAgent
      agentRegistry.register({
        agentId: "arch-reviewer",
        name: "arch-reviewer",
        parentAgentId: "main",
        type: "subagent",
        depth: 1,
      });
      agentRegistry.updateStatus("arch-reviewer", "running");

      // 触发 tool.started 事件
      eventBus.emit(
        makeEvent({
          type: "tool.started",
          agentId: "arch-reviewer",
          agentName: "arch-reviewer",
          data: {
            name: "read_file",
            args: { path: "src/index.ts" },
          },
        })
      );

      // 等待节流调度
      await new Promise((r) => setTimeout(r, 100));

      const updateOutput = mock.getOutput();
      assert(updateOutput.includes("Agents"), "派生子代理后应展开 Agents 面板");
      assert(updateOutput.includes("arch-reviewer"));
    } finally {
      presenter.stopRun();
      presenter.destroy();
    }
  });

  it("14. Background Job 状态流转在 Agent 独立视图中完整跟踪", async () => {
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    agentRegistry.register({
      agentId: "data-analyzer",
      name: "data-analyzer",
      type: "subagent",
    });
    const mock = createMockTtyStream(80);

    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    try {
      presenter.startRun("Run background task");
      await new Promise((r) => setTimeout(r, 80));

      mock.clearBuffer();

      // 启动一个可见的 Background Job
      const bgJob = {
        id: "job-bg-1",
        ownerAgentId: "data-analyzer",
        command: "npm test",
        startedAt: Date.now(),
        status: "running" as const,
        hardTimeoutMs: 300000,
        backgroundRequested: true,
      };

      eventBus.emit(
        makeEvent({
          type: "job.started",
          data: bgJob,
        })
      );

      await new Promise((r) => setTimeout(r, 100));

      // 切换到 data-analyzer 视图
      presenter.switchToAgentView("data-analyzer");
      presenter.render();
      const bgOutput = mock.getOutput();
      assert(bgOutput.includes("background · npm test"), "后台命令运行时应在底部状态行显示");
      assert(!bgOutput.includes("Background job started"), "后台命令不重复写入系统通知");

      mock.clearBuffer();

      // Background Job 完成
      eventBus.emit(
        makeEvent({
          type: "job.completed",
          data: {
            ...bgJob,
            status: "completed",
            durationMs: 4000,
          },
        })
      );

      await new Promise((r) => setTimeout(r, 100));

      const finishOutput = mock.getOutput();
      assert(!finishOutput.includes("Background job completed"), "成功结束后应安静收起后台状态");
    } finally {
      presenter.stopRun();
      presenter.destroy();
    }
  });

  it("15. stopRun() 与 restoreTerminal() 正确清理 Live Region 并恢复光标", async () => {
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const mock = createMockTtyStream(80);

    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    presenter.startRun("Test run");
    await new Promise((r) => setTimeout(r, 80));

    mock.clearBuffer();

    // 正常停止
    presenter.stopRun();

    const stopOutput = mock.getOutput();
    // 必须包含清空序列与显示光标序列 (\x1b[?25h\x1b[0m)
    assert(stopOutput.includes("\x1b[?25h\x1b[0m"), "必须恢复终端光标显示");

    mock.clearBuffer();

    // 异常恢复 (restoreTerminal)
    presenter.restoreTerminal();
    const restoreOutput = mock.getOutput();
    assert(restoreOutput.includes("\x1b[?25h"), "异常恢复时也必须恢复光标");

    presenter.destroy();
  });

  it("16. Non-TTY 模式下保持 Append-Only，绝不输出 ANSI Cursor Sequences", () => {
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: any) => logs.push(String(msg));

    const nonTtyStream = new PassThrough() as unknown as NodeJS.WriteStream;
    (nonTtyStream as any).isTTY = false;

    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: nonTtyStream,
      isTTY: false,
    });

    try {
      presenter.startRun("Non-TTY test");

      // 发射 Tool 事件
      eventBus.emit(
        makeEvent({
          type: "tool.started",
          agentId: "main",
          agentName: "Main",
          data: { name: "read_file", args: { path: "package.json" } },
        })
      );

      // 发射 Agent 完成事件
      eventBus.emit(
        makeEvent({
          type: "agent.completed",
          agentId: "main",
          agentName: "Main",
        })
      );

      assert(logs.some((l) => l.includes("[Main] reading package.json")));
      assert(logs.some((l) => l.includes("[Main] completed ✓")));
    } finally {
      console.log = originalLog;
      presenter.stopRun();
      presenter.destroy();
    }
  });
});
