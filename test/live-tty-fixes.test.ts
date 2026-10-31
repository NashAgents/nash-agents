import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { DecisionController } from "../src/decision/decision-controller.js";
import { DecisionRenderer } from "../src/presentation/decision-renderer.js";
import { PlanMode } from "../src/plan/plan-mode.js";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { TaskManager } from "../src/task/task-manager.js";
import { ProposedPlanProjection } from "../src/presentation/proposed-plan-projection.js";
import { InputManager } from "../src/cli/input-manager.js";
import type { ProposedPlan } from "../src/plan/types.js";

class MockTtyStream extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  written: string[] = [];

  write(chunk: any): boolean {
    this.written.push(String(chunk));
    return true;
  }

  setEncoding(_enc: string): void {}
  setRawMode(_mode: boolean): void {}
  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }

  getOutput(): string {
    return this.written.join("");
  }

  getLastFrame(): string {
    const output = this.written.join("");
    const parts = output.split("\x1b[1;1H");
    return parts[parts.length - 1] ?? output;
  }

  clear(): void {
    this.written = [];
  }
}

describe("Live TTY 4大问题专项验证测试集", () => {
  // ===========================================================================
  // 一、Empty Session 初始 Composer 固定在 Bottom Dock
  // ===========================================================================
  describe("一、Empty Session 初始 Composer 固定在 Bottom Dock", () => {
    it("1.1 Empty Session 下 Composer 固定在底部 (rows - agentsHeight)", () => {
      const mock = new MockTtyStream();
      const presenter = new CliPresenter({
        stdout: mock as any,
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
      });

      presenter.enterAppScreen();
      presenter.render();

      const lastFrame = mock.getLastFrame();
      assert.equal(presenter.getInteractionMode(), "empty-session");
      assert.ok(lastFrame.includes("输入指令..."), "空会话应显示输入占位符");
      assert.ok(!lastFrame.includes("/resume · /status · /help"), "不应再有旧版居中 Welcome Banner");
      presenter.destroy();
    });

    it("1.2 从 empty-session -> running-main -> session-ready 保持同一 ScreenLayout", () => {
      const mock = new MockTtyStream();
      const presenter = new CliPresenter({
        stdout: mock as any,
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
      });

      presenter.enterAppScreen();
      assert.equal(presenter.getInteractionMode(), "empty-session");

      // 启动 Run
      presenter.startRun("第一条指令");
      assert.equal(presenter.getInteractionMode(), "running-main");

      // 结束 Run
      presenter.stopRun("完成回复", "耗时 1s");
      assert.equal(presenter.getInteractionMode(), "session-ready");
      assert.equal(presenter.hasSessionHistory(), true);

      presenter.destroy();
    });
  });

  // ===========================================================================
  // 二、Main View 鼠标捕获与滚动
  // ===========================================================================
  describe("二、Main View 鼠标捕获与滚动", () => {
    it("2.1 InputManager 开启与关闭 SGR 鼠标报告", () => {
      const mock = new MockTtyStream();
      const inputManager = new InputManager({
        input: mock as any,
        output: mock as any,
        isTTY: true,
      });

      inputManager.enableMouseReporting();
      const outputOnEnter = mock.getOutput();
      assert.ok(outputOnEnter.includes("\x1b[?1000h\x1b[?1002h\x1b[?1006h"), "应发送 SGR 鼠标报告开启序列");

      inputManager.disableMouseReporting();
      const outputOnLeave = mock.getOutput();
      assert.ok(outputOnLeave.includes("\x1b[?1000l") && outputOnLeave.includes("\x1b[?1006l"), "应发送 SGR 鼠标报告关闭序列");
      inputManager.close();
    });

    it("2.2 InputManager 默认不激活鼠标报告以保证文本选择，显式配置时才激活", () => {
      const mock = new MockTtyStream();
      const inputManager = new InputManager({
        input: mock as any,
        output: mock as any,
        isTTY: true,
      });

      // 默认情况：不激活鼠标报告
      inputManager.setInteractionMode("empty-session");
      assert.strictEqual(mock.getOutput().includes("\x1b[?1000h\x1b[?1002h\x1b[?1006h"), false, "默认模式不应开启鼠标捕获");
      inputManager.close();

      // 显式配置 enableMouseReporting: true 时才激活
      const mockExplicit = new MockTtyStream();
      const explicitManager = new InputManager({
        input: mockExplicit as any,
        output: mockExplicit as any,
        isTTY: true,
        enableMouseReporting: true,
      });
      explicitManager.setInteractionMode("empty-session");
      assert.ok(mockExplicit.getOutput().includes("\x1b[?1000h\x1b[?1002h\x1b[?1006h"), "显式配置时激活鼠标报告");
      explicitManager.close();
    });

    it("2.3 鼠标滚轮事件触发 Transcript 视口上下滚动", () => {
      const mock = new MockTtyStream();
      const presenter = new CliPresenter({
        stdout: mock as any,
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
      });

      const navHandler = presenter.getNavigationHandler();
      // 模拟 20 行输出填充 Transcript
      for (let i = 0; i < 20; i++) {
        presenter.appendTranscript({
          id: `t-${i}`,
          agentId: "main",
          kind: "message",
          text: `Message ${i}`,
          timestamp: Date.now(),
        });
      }

      // 滚轮向上滚动
      assert.doesNotThrow(() => {
        navHandler.onMouseWheelUp?.();
      });

      // 滚轮向下滚动
      assert.doesNotThrow(() => {
        navHandler.onMouseWheelDown?.();
      });

      presenter.destroy();
    });
  });

  // ===========================================================================
  // 三、Plan Approval 视图单次渲染 ProposedPlan
  // ===========================================================================
  describe("三、Plan Approval 视图单次渲染 ProposedPlan", () => {
    const mockPlan: ProposedPlan = {
      planId: "p-test-01",
      goal: "重构网络沙箱隔离机制",
      summary: "升级为动态 Scheme 策略",
      steps: [
        { id: "s-1", subject: "审计当前 backend", description: "读取 macos-seatbelt.ts" },
        { id: "s-2", subject: "注入动态规则", description: "替换 sandbox-exec 模板" },
      ],
      createdAt: Date.now(),
    };

    it("3.1 DecisionRenderer 渲染 plan-approval 时仅渲染选项列表，不重复渲染 Goal 与 Steps", () => {
      const lines = DecisionRenderer.renderDecision({
        decision: {
          id: "dec-plan-01",
          kind: "plan-approval",
          title: "Plan ready for approval",
          description: "Goal: 重构网络沙箱隔离机制\nSummary: 升级为动态 Scheme 策略",
          options: [
            { id: "approve", label: "Approve & execute", shortcut: "a" },
            { id: "revise", label: "Revise plan", shortcut: "r" },
            { id: "cancel", label: "Cancel", destructive: true, shortcut: "c" },
          ],
          selectedIndex: 0,
          createdAt: Date.now(),
          resolve: () => {},
          reject: () => {},
        },
        maxWidth: 80,
      });

      const renderedText = lines.join("\n");
      // 选项存在
      assert.ok(renderedText.includes("Approve & execute"));
      assert.ok(renderedText.includes("Revise plan"));
      assert.ok(renderedText.includes("Cancel"));
      // 不应包含 Goal/Steps
      assert.ok(!renderedText.includes("重构网络沙箱隔离机制"));
      assert.ok(!renderedText.includes("审计当前 backend"));
    });

    it("3.2 ProposedPlanProjection 专职渲染 Goal 与 Steps", () => {
      const lines = ProposedPlanProjection.render(mockPlan, {
        maxWidth: 80,
        maxVisibleSteps: 4,
      });
      const text = lines.join("\n");
      assert.ok(text.includes("Plan ready for approval"));
      assert.ok(text.includes("重构网络沙箱隔离机制"));
      assert.ok(text.includes("1. 审计当前 backend"));
      assert.ok(text.includes("2. 注入动态规则"));
    });

    it("3.3 ProposedPlan 与 ActiveTaskGraphProjection 严格互斥", () => {
      const mock = new MockTtyStream();
      const taskManager = new TaskManager();
      const decisionController = new DecisionController();
      const planMode = new PlanMode({ taskManager, decisionController });
      const presenter = new CliPresenter({
        stdout: mock as any,
        eventBus: new EventBus(),
        agentRegistry: new AgentRegistry(),
        isTTY: true,
        planMode,
        taskManager,
        decisionController,
      });

      planMode.enter("重构网络沙箱隔离机制");
      planMode.requestApproval({
        summary: mockPlan.summary,
        steps: mockPlan.steps,
      }).catch(() => {});

      presenter.render();

      let frame = mock.getLastFrame();
      assert.ok(frame.includes("Plan ready for approval"), "Awaiting Approval 阶段应渲染 Plan ready for approval");
      assert.ok(!frame.includes("Task Graph"), "Awaiting Approval 阶段绝不渲染 Task Graph");

      mock.clear();
      // 批准方案
      decisionController.confirmSelected(); // 选择 approve
      presenter.render();

      frame = mock.getLastFrame();
      assert.ok(!frame.includes("Plan ready for approval"), "Approved 阶段不应再渲染 Proposed Plan");
      presenter.destroy();
    });
  });

  // ===========================================================================
  // 四、Plan Approval 决策去重与单次 Enter
  // ===========================================================================
  describe("四、Plan Approval 决策去重与单次 Enter", () => {
    it("4.1 DecisionController 对相同 planId 的决策请求执行幂等去重", async () => {
      const controller = new DecisionController();
      const plan: ProposedPlan = {
        planId: "plan-dedup-1",
        goal: "测试去重",
        summary: "摘要",
        steps: [{ id: "1", subject: "步骤1" }],
        createdAt: Date.now(),
      };

      const p1 = controller.requestDecision({
        id: `plan-appr-${plan.planId}`,
        kind: "plan-approval",
        title: "Title 1",
        options: [{ id: "approve", label: "Approve" }],
        metadata: { plan },
      });

      // 重复请求相同 planId 的 decision
      const p2 = controller.requestDecision({
        id: `plan-appr-${plan.planId}`,
        kind: "plan-approval",
        title: "Title 2",
        options: [{ id: "approve", label: "Approve" }],
        metadata: { plan },
      });

      assert.equal(p1, p2, "重复请求应返回同一个 Promise 引用");
      assert.equal(controller.getPendingCount(), 1, "队列长度必须为 1，杜绝重复入队");

      controller.confirmSelected();
      const res1 = await p1;
      const res2 = await p2;
      assert.equal(res1, "approve");
      assert.equal(res2, "approve");
    });

    it("4.2 PlanMode.requestApproval 只需按一次 Enter 即可立即批准并退出 Plan Mode", async () => {
      const taskManager = new TaskManager();
      const decisionController = new DecisionController();
      const eventBus = new EventBus();
      const planMode = new PlanMode({
        taskManager,
        decisionController,
        eventBus,
      });

      planMode.enter("构建新系统");
      let approvalResolved = false;

      const approvalPromise = planMode.requestApproval({
        summary: "构建方案",
        steps: [
          { id: "step-1", subject: "初始化模块", description: "创建目录" },
          { id: "step-2", subject: "编写代码", description: "主逻辑" },
        ],
      }).then((result) => {
        approvalResolved = true;
        return result;
      });

      assert.equal(decisionController.hasActiveDecision(), true);
      assert.equal(decisionController.getPendingCount(), 1);

      // 单次 Enter 确认
      decisionController.confirmSelected();

      const result = await approvalPromise;
      assert.equal(approvalResolved, true);
      assert.equal(result.approved, true);
      assert.equal(planMode.getState(), "executed");
      assert.equal(decisionController.hasActiveDecision(), false);
      assert.equal(taskManager.getTasks().length, 2, "TaskGraph 必须成功根据批准方案生成 2 个任务");
    });

    it("4.3 plan.proposed 事件不重复入队决策", () => {
      const eventBus = new EventBus();
      const decisionController = new DecisionController();
      const presenter = new CliPresenter({
        eventBus,
        decisionController,
        agentRegistry: new AgentRegistry(),
        isTTY: false,
      });

      const plan: ProposedPlan = {
        planId: "p-evt-01",
        goal: "事件测试",
        summary: "摘要",
        steps: [{ id: "1", subject: "S1" }],
        createdAt: Date.now(),
      };

      // 预先入队一项决策 (由 PlanMode.requestApproval 触发)
      decisionController.requestDecision({
        id: `plan-appr-${plan.planId}`,
        kind: "plan-approval",
        title: "Initial",
        options: [{ id: "approve", label: "Approve" }],
        metadata: { plan },
      });
      assert.equal(decisionController.getPendingCount(), 1);

      // 模拟随后广播的 plan.proposed 事件
      eventBus.emit({
        id: "evt-1",
        type: "plan.proposed",
        timestamp: new Date().toISOString(),
        projectId: "p-1",
        sessionId: "s-1",
        data: { plan },
      });

      assert.equal(
        decisionController.getPendingCount(),
        1,
        "plan.proposed 事件不得创建多余决策 (队列长度保持为 1)"
      );
      decisionController.confirmSelected();
      presenter.destroy();
    });
  });
});
