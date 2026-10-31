import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { TaskManager } from "../src/task/task-manager.js";
import { InputManager } from "../src/cli/input-manager.js";
import { ActiveTaskGraphProjection } from "../src/presentation/active-task-graph-projection.js";
import { TerminalScreenManager } from "../src/presentation/terminal-screen-manager.js";
import { TaskGraphBuilder } from "../src/plan/task-graph-builder.js";
import type { Task } from "../src/task/types.js";

function createMockTtyStream(columns = 80, rows = 24) {
  let buffer = "";
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  (stream as any).isTTY = true;
  (stream as any).columns = columns;
  (stream as any).rows = rows;
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

describe("子代理交互隔离、键盘导航与 Plan 模式标号测试套件", () => {
  it("1. 主代理与子代理共用终端原生滚动历史", async () => {
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const mock = createMockTtyStream(80, 24);

    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
      nativeScrollback: true,
    });

    agentRegistry.register({
      agentId: "analyst-1",
      name: "data-analyst",
      type: "subagent",
      parentAgentId: "main",
    });

    try {
      presenter.startRun("Analyze codebase");
      await new Promise((r) => setTimeout(r, 60));

      // 往 Main 中写入 Main 专有历史
      presenter.appendTranscript({
        id: "msg-main-1",
        agentId: "main",
        kind: "message",
        text: "Main secret history that should not leak to child",
        timestamp: Date.now(),
      });
      presenter.render();

      mock.clearBuffer();

      // 切进子代理 analyst-1
      presenter.switchToAgentView("analyst-1");
      await new Promise((r) => setTimeout(r, 60));

      const childOutput = mock.getOutput();
      assert.equal(childOutput.includes("\x1b[?1049h"), false, "子代理不得切入备用屏幕");
      assert.equal(childOutput.includes("\x1b[?1000h"), false, "子代理不得捕获原生鼠标事件");
      assert.ok(childOutput.includes("data-analyst"), "子代理视图中呈现子代理名称");
      assert.strictEqual(
        childOutput.includes("Main secret history that should not leak to child"),
        false,
        "子代理视图中绝不出现 Main 的专有历史记录"
      );

      mock.clearBuffer();

      // 切回 Main
      presenter.returnToMainView();
      await new Promise((r) => setTimeout(r, 60));

      const backOutput = mock.getOutput();
      assert.equal(backOutput.includes("\x1b[?1049l"), false, "切回 Main 不应切换屏幕缓冲区");
    } finally {
      presenter.stopRun();
      presenter.leaveAppScreen();
      presenter.destroy();
    }
  });

  it("2. agent-detail 模式下 ↑ / ↓ 键允许平滑上下切换选中的 Agent，按 Enter 进入", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const manager = new InputManager({ input, output, isTTY: true });

    let selectUpCount = 0;
    let selectDownCount = 0;
    let enterCount = 0;
    let escapeCount = 0;

    manager.startNavigationMode({
      onKeyUp: () => { selectUpCount++; },
      onKeyDown: () => { selectDownCount++; },
      onKeyEnter: () => { enterCount++; },
      onKeyEscape: () => { escapeCount++; },
    }, "agent-detail");

    try {
      // 模拟用户在子代理详情按上下键
      input.write("\x1b[A"); // arrow-up
      input.write("\x1b[B"); // arrow-down
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(selectUpCount, 1, "agent-detail 模式下按 ↑ 必须触发 onKeyUp 切换选中的 Agent");
      assert.strictEqual(selectDownCount, 1, "agent-detail 模式下按 ↓ 必须触发 onKeyDown 切换选中的 Agent");

      // 按 Enter
      input.write("\r");
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(enterCount, 1, "按 Enter 必须触发 onKeyEnter 打开目标 Agent");

      // 按 Esc
      input.write("\x1b");
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(escapeCount, 1, "按 Esc 必须触发 onKeyEscape 返回 Main");
    } finally {
      manager.close();
    }
  });

  it("3. Plan 模式任务项严格具备固定序号标号，Header 呈现进度与当前执行序号", () => {
    const tasks: Task[] = [
      {
        id: "t1",
        subject: "准备基础数据",
        status: "completed",
        dependencies: [],
        revision: 1,
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: "t2",
        subject: "运行核心分析管道",
        status: "running",
        dependencies: ["t1"],
        revision: 1,
        createdAt: 2000,
        updatedAt: 2000,
      },
      {
        id: "t3",
        subject: "输出最终评估报告",
        status: "ready",
        dependencies: ["t2"],
        revision: 1,
        createdAt: 3000,
        updatedAt: 3000,
      },
    ];

    const rendered = ActiveTaskGraphProjection.render(tasks);

    // 1. Header 包含总进度与当前执行序号: (1/3) · running #2
    assert.ok(rendered[0].includes("Plan (1/3)"), "Header 必须清晰呈现完成度 (1/3)");
    assert.ok(rendered[0].includes("running #2"), "Header 必须清晰标识当前正在执行第 2 步");

    // 2. 步骤列表必须有严格的数字序号 1., 2., 3.
    assert.ok(
      rendered.some((l) => l.includes("1.") && l.includes("✓") && l.includes("准备基础数据")),
      "第 1 步必须显示序号 '1.' 并标记已完成 '✓'"
    );
    assert.ok(
      rendered.some((l) => l.includes("2.") && l.includes("→") && l.includes("运行核心分析管道") && l.includes("running #2")),
      "第 2 步必须显示序号 '2.' 并标记执行中 '→' 及 '(running #2)'"
    );
    assert.ok(
      rendered.some((l) => l.includes("3.") && l.includes("○") && l.includes("输出最终评估报告")),
      "第 3 步必须显示序号 '3.' 并标记待执行 '○'"
    );

    // 3. 折叠模式下也必须标出当前运行步骤
    const collapsed = ActiveTaskGraphProjection.render(tasks, { isExpanded: false });
    assert.ok(collapsed[0].includes("#2"), "折叠时也必须标出当前正在运行的任务序号 #2");
  });

  it("4. 派生子代理启动事件自动将 userInput 记录至子代理的初始 Transcript", async () => {
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const mock = createMockTtyStream(80, 24);

    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    agentRegistry.register({
      agentId: "sub-tester",
      name: "sub-tester",
      type: "subagent",
      parentAgentId: "main",
    });

    try {
      // 触发 agent.started 事件
      eventBus.emit({
        id: "evt-1",
        type: "agent.started",
        timestamp: new Date().toISOString(),
        projectId: "proj",
        sessionId: "sess",
        agentId: "sub-tester",
        data: {
          userInput: "请对模块 A 进行全面单元测试",
        },
      });

      const childProj = presenter.getProjection("sub-tester");
      const lines = childProj.getDisplayLines(80);
      assert.ok(
        lines.some((l) => l.includes("请对模块 A 进行全面单元测试")),
        "子代理 Transcript 必须记录初始输入任务目标"
      );
    } finally {
      presenter.destroy();
    }
  });

  it("5. TerminalScreenManager 进入备用屏幕时下发 SGR 鼠标滚轮捕获，严禁下发 ?1007h 导致滚轮转方向键", () => {
    const mock = createMockTtyStream(80, 24);
    const screenManager = new TerminalScreenManager({ stdout: mock.stream, isTTY: true });

    screenManager.enterAlternateScreen();
    const output = mock.getOutput();

    // 必须包含点击、拖动与 SGR 坐标报告。
    assert.ok(output.includes("\x1b[?1000h\x1b[?1002h\x1b[?1006h"), "备用屏幕必须开启拖动与滚轮报告");
    // 严禁包含 \x1b[?1007h (会导致滚轮转为上下按键)
    assert.strictEqual(output.includes("\x1b[?1007h"), false, "备用屏幕严禁开启 1007 Alternate Scroll 将滚轮转为方向键");

    mock.clearBuffer();
    screenManager.leaveAlternateScreen();
    const exitOutput = mock.getOutput();
    assert.ok(
      exitOutput.includes("\x1b[?1000l") && exitOutput.includes("\x1b[?1006l"),
      "退出备用屏幕必须关闭鼠标捕获恢复原生复制"
    );
  });

  it("6. Main 认领任务后指派子代理协作完成，放行完工，不抛出 TaskAlreadyOwnedError", () => {
    const taskManager = new TaskManager({ defaultWorkspacePath: process.cwd() });
    taskManager.createTask({
      id: "task-collab-1",
      subject: "分析子系统架构",
      description: "由 Main 认领后指派子代理分析",
    });

    // 1. Main 认领任务
    taskManager.claimTask("task-collab-1", "main");
    const task = taskManager.getTask("task-collab-1");
    assert.strictEqual(task?.ownerAgentId, "main");
    assert.strictEqual(task?.status, "running");

    // 2. 指派子代理执行：assignTask 允许所有权转移或协作
    taskManager.assignTask("task-collab-1", "agent-sub-123");
    const reassigned = taskManager.getTask("task-collab-1");
    assert.strictEqual(reassigned?.ownerAgentId, "agent-sub-123");

    // 3. 子代理执行完成后调用 completeTask
    assert.doesNotThrow(() => {
      taskManager.completeTask(
        "task-collab-1",
        { summary: "架构深度分析报告已生成" },
        { agentId: "agent-sub-123" }
      );
    }, "子代理完工不应抛出 TaskAlreadyOwnedError");

    const finished = taskManager.getTask("task-collab-1");
    assert.strictEqual(finished?.status, "completed");
    assert.strictEqual(finished?.completedByAgentId, "agent-sub-123");
  });

  it("7. Agent 运行结束 (endRun) 时保留未提交的输入草稿 (composerDraft)，避免输入框闪烁清空与字符拼接", () => {
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const mock = createMockTtyStream(80, 24);

    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: mock.stream,
      isTTY: true,
    });

    try {
      presenter.startRun("Task prompt");
      // 模拟用户在运行中打字录入草稿 1234
      presenter.setComposerDraft("1234", 4);
      assert.strictEqual((presenter as any).composerDraft, "1234");

      // Agent 运行结束
      presenter.stopRun();

      // stopRun 之后草稿必须完整保留，绝不能被置空
      assert.strictEqual((presenter as any).composerDraft, "1234", "stopRun 必须保留未发送的输入草稿 1234");
    } finally {
      presenter.destroy();
    }
  });

  it("8. Plan 模式下新方案注入 TaskManager 时自动作废之前未启动的旧方案任务，避免孤儿任务堆叠残留", () => {
    const taskManager = new TaskManager({ defaultWorkspacePath: process.cwd() });

    // 方案 1: 提出 2 个步骤并注入
    const plan1 = {
      planId: "plan-v1",
      goal: "初版分析方案",
      summary: "旧方案",
      steps: [
        { id: "s1", subject: "旧任务步骤 1", description: "步骤1" },
        { id: "s2", subject: "旧任务步骤 2", description: "步骤2" },
      ],
      createdAt: 1000,
    };
    const oldTasks = TaskGraphBuilder.buildIntoTaskManager(plan1 as any, taskManager);

    assert.strictEqual(taskManager.getTasks().length, 2);
    assert.strictEqual(taskManager.getTasks().every((t: any) => t.status === "ready"), true);

    // 方案 2: 用户引导后更新方案并注入
    const plan2 = {
      planId: "plan-v2",
      goal: "新版分析工作流",
      summary: "新方案",
      steps: [
        { id: "n1", subject: "工作流-阶段1", description: "新步骤1" },
        { id: "n2", subject: "工作流-阶段2", description: "新步骤2" },
      ],
      createdAt: 2000,
    };
    const newTasks = TaskGraphBuilder.buildIntoTaskManager(plan2 as any, taskManager);

    // 检查旧方案任务是否已被自动废弃 (cancelled / superseded)
    const oldTask1 = taskManager.getTask(oldTasks[0]!.id);
    const oldTask2 = taskManager.getTask(oldTasks[1]!.id);
    assert.strictEqual(oldTask1?.status, "cancelled", "旧任务 1 必须被标记为 cancelled 避免残留");
    assert.strictEqual(oldTask2?.status, "cancelled", "旧任务 2 必须被标记为 cancelled 避免残留");

    // 检查新方案任务处于 ready 状态
    const newTask1 = taskManager.getTask(newTasks[0]!.id);
    assert.strictEqual(newTask1?.status, "ready", "新任务 1 必须就绪");

    // ActiveTaskGraphProjection 渲染时过滤掉 cancelled 任务，只展示新方案任务
    const lines = ActiveTaskGraphProjection.render(taskManager.getTasks());
    assert.ok(lines.some((l) => l.includes("工作流-阶段1")), "呈现新方案任务");
    assert.strictEqual(lines.some((l) => l.includes("旧任务步骤 1")), false, "旧任务步骤绝不污染当前 Plan 面板");
  });
});
