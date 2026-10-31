import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { DecisionController } from "../src/decision/index.js";
import { DecisionRenderer } from "../src/presentation/decision-renderer.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { InputManager } from "../src/cli/input-manager.js";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { TaskManager } from "../src/task/task-manager.js";
import { PlanMode } from "../src/plan/plan-mode.js";
import { ApprovalService } from "../src/approval/approval-service.js";
import { CliApprovalProvider } from "../src/approval/cli-approval.js";
import type { ProposedPlan } from "../src/plan/types.js";

describe("Structured Decision & Plan Approval Subsystem", () => {
  let eventBus: EventBus;
  let agentRegistry: AgentRegistry;
  let taskManager: TaskManager;
  let planMode: PlanMode;
  let decisionController: DecisionController;
  let mockStdout: PassThrough & { isTTY?: boolean; columns?: number; rows?: number };
  let mockStdin: PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void; setEncoding?: (enc: string) => void };

  beforeEach(() => {
    eventBus = new EventBus();
    agentRegistry = new AgentRegistry({ eventBus });
    taskManager = new TaskManager({ eventBus });
    planMode = new PlanMode({ eventBus });
    decisionController = new DecisionController();

    mockStdout = new PassThrough() as any;
    mockStdout.isTTY = true;
    mockStdout.columns = 80;
    mockStdout.rows = 24;

    mockStdin = new PassThrough() as any;
    mockStdin.isTTY = true;
    mockStdin.setRawMode = () => {};
    mockStdin.setEncoding = ((_enc: string) => mockStdin) as any;
  });

  describe("1. DecisionController Core & State Stability", () => {
    it("1.1 默认选中 defaultIndex，且支持 ↑ / ↓ 循环切换选项", async () => {
      const decPromise = decisionController.requestDecision({
        kind: "plan-approval",
        title: "Plan ready for approval",
        options: [
          { id: "approve", label: "Approve & execute" },
          { id: "revise", label: "Revise plan" },
          { id: "cancel", label: "Cancel" },
        ],
        defaultIndex: 0,
      });

      assert.equal(decisionController.hasActiveDecision(), true);
      const active = decisionController.getActiveDecision();
      assert.equal(active?.selectedIndex, 0);

      // 向下切换 (↓)
      decisionController.selectNext();
      assert.equal(decisionController.getActiveDecision()?.selectedIndex, 1);

      decisionController.selectNext();
      assert.equal(decisionController.getActiveDecision()?.selectedIndex, 2);

      // 循环到首项
      decisionController.selectNext();
      assert.equal(decisionController.getActiveDecision()?.selectedIndex, 0);

      // 向上切换 (↑) 循环到末项
      decisionController.selectPrevious();
      assert.equal(decisionController.getActiveDecision()?.selectedIndex, 2);

      // 确认当前选项
      const confirmed = decisionController.confirmSelected();
      assert.equal(confirmed, "cancel");
      const result = await decPromise;
      assert.equal(result, "cancel");
      assert.equal(decisionController.hasActiveDecision(), false);
    });

    it("1.2 快捷键 shortcut 可直接触发指定选项", async () => {
      const decPromise = decisionController.requestDecision({
        kind: "permission",
        title: "Permission required",
        options: [
          { id: "allow-once", label: "Allow once", shortcut: "y" },
          { id: "deny", label: "Deny", shortcut: "n" },
        ],
        defaultIndex: 0,
      });

      const handled = decisionController.handleShortcut("y");
      assert.equal(handled, "allow-once");
      const result = await decPromise;
      assert.equal(result, "allow-once");
      assert.equal(decisionController.hasActiveDecision(), false);
    });

    it("1.3 多 Decision 遵循严格 FIFO 队列排队", async () => {
      const results: string[] = [];

      const p1 = decisionController.requestDecision({
        id: "d1",
        kind: "plan-approval",
        title: "Decision 1",
        options: [{ id: "opt1", label: "Option 1" }],
      }).then((r) => results.push(r));

      const p2 = decisionController.requestDecision({
        id: "d2",
        kind: "permission",
        title: "Decision 2",
        options: [{ id: "opt2", label: "Option 2" }],
      }).then((r) => results.push(r));

      assert.equal(decisionController.getPendingCount(), 2);
      assert.equal(decisionController.getActiveDecision()?.id, "d1");

      // 解决第一个决策
      decisionController.confirmSelected();
      await p1;

      // 自动激活第二个决策
      assert.equal(decisionController.getActiveDecision()?.id, "d2");
      assert.equal(decisionController.getPendingCount(), 1);

      decisionController.confirmSelected();
      await p2;

      assert.deepEqual(results, ["opt1", "opt2"]);
      assert.equal(decisionController.hasActiveDecision(), false);
    });

    it("1.4 状态保护：timer render / task 事件不重置 selectedIndex", () => {
      decisionController.requestDecision({
        kind: "plan-approval",
        title: "Plan ready for approval",
        options: [
          { id: "approve", label: "Approve & execute" },
          { id: "revise", label: "Revise plan" },
          { id: "cancel", label: "Cancel" },
        ],
        defaultIndex: 0,
      });

      // 用户按 ↓ 选中 Revise plan
      decisionController.selectNext();
      assert.equal(decisionController.getActiveDecision()?.selectedIndex, 1);

      // 模拟 background task / agent 事件到达
      eventBus.emit({
        id: "ev-1",
        type: "agent.running",
        timestamp: new Date().toISOString(),
        projectId: "p",
        sessionId: "s",
        data: {},
      });

      // selectedIndex 绝对不被重置！
      assert.equal(decisionController.getActiveDecision()?.selectedIndex, 1);
    });

    it("1.5 abortAll 能安全清理所有 pending 决策 (如 Ctrl+C)", async () => {
      const p1 = decisionController.requestDecision({
        kind: "confirmation",
        title: "Confirm abort",
        options: [{ id: "yes", label: "Yes" }],
      });

      decisionController.abortAll("User interrupted");
      await assert.rejects(p1, /User interrupted/);
      assert.equal(decisionController.hasActiveDecision(), false);
    });
  });

  describe("2. Plan Approval Flow & TaskGraphBuilder Execution", () => {
    it("2.1 ProposedPlan 完成后自动触发 plan-approval decision，默认选中 Approve & execute", () => {
      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        taskManager,
        planMode,
        decisionController,
        isTTY: true,
        stdout: mockStdout as any,
      });

      presenter.startRun("分析系统并制定方案");

      planMode.enter("分析系统架构");
      const plan = planMode.proposePlan({
        summary: "重构多子系统",
        steps: [
          { id: "s1", subject: "扫描全部模块" },
          { id: "s2", subject: "分析核心依赖" },
        ],
      });

      assert.equal(decisionController.hasActiveDecision(), true);
      const active = decisionController.getActiveDecision();
      assert.equal(active?.kind, "plan-approval");
      assert.equal(active?.selectedIndex, 0);
      assert.equal(active?.options[0].id, "approve");
      assert.equal(active?.options[1].id, "revise");
      assert.equal(active?.options[2].id, "cancel");

      presenter.stopRun();
    });

    it("2.2 Approve & execute 确认后直接将 Plan 注入 TaskManager 并离开 Plan Mode，不产生‘批准’文本", async () => {
      let approvedPlanFromHook: ProposedPlan | undefined;

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        taskManager,
        planMode,
        decisionController,
        isTTY: true,
        stdout: mockStdout as any,
        onPlanApproved: (p) => {
          approvedPlanFromHook = p;
        },
      });

      presenter.startRun("分析系统并制定方案");

      planMode.enter("分析系统架构");
      const plan = planMode.proposePlan({
        summary: "重构多子系统",
        steps: [
          { id: "s1", subject: "步骤一", writeScopes: ["src/a/**"] },
          { id: "s2", subject: "步骤二", dependencies: ["s1"] },
        ],
      });

      // 用户按 Enter 确认 "Approve & execute"
      const confirmed = decisionController.confirmSelected();
      assert.equal(confirmed, "approve");

      // 等待微任务完成
      await new Promise((r) => setTimeout(r, 10));

      // 验证 PlanMode 状态已批准并退出为 executed
      assert.equal(planMode.getState(), "executed");
      assert.equal(planMode.getApprovalDecision()?.approved, true);

      // 验证 TaskGraphBuilder 已真实将任务创建至 TaskManager
      const tasks = taskManager.getTasks();
      assert.equal(tasks.length, 2);
      assert.equal(tasks[0].subject, "步骤一");
      assert.equal(tasks[1].subject, "步骤二");
      assert.deepEqual(tasks[1].dependencies, [tasks[0].id]);

      // 验证外部回调被触发
      assert.equal(approvedPlanFromHook?.planId, plan.planId);

      presenter.stopRun();
    });

    it("2.3 选择 Revise plan 进入 Plan Revision 文本模式，输入后触发修改回调，Esc 可返回决策", async () => {
      let submittedRevision: string | undefined;

      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        taskManager,
        planMode,
        decisionController,
        isTTY: true,
        stdout: mockStdout as any,
        onPlanRevisionSubmitted: (rev) => {
          submittedRevision = rev;
        },
      });

      presenter.startRun("制定方案");
      planMode.enter("目标");
      const plan = planMode.proposePlan({
        summary: "初步方案",
        steps: [{ subject: "步骤 1" }],
      });

      // 选中 Revise plan 并按 Enter
      decisionController.selectNext();
      decisionController.confirmSelected();
      await new Promise((r) => setTimeout(r, 10));

      const navHandler = presenter.getNavigationHandler();
      assert.equal(navHandler.isPlanRevisionInput?.(), true);

      // 用户按 Esc 取消 Revision，应重新返回 Plan Approval 决策
      navHandler.onDecisionCancel?.();
      assert.equal(decisionController.hasActiveDecision(), true);
      assert.equal(navHandler.isPlanRevisionInput?.(), false);

      // 再次选择 Revise plan
      decisionController.selectNext();
      decisionController.confirmSelected();
      await new Promise((r) => setTimeout(r, 10));

      // 提交修改意见
      presenter.submitPlanRevision("将模块拆成两个子 Agent");
      assert.equal(submittedRevision, "将模块拆成两个子 Agent");

      presenter.stopRun();
    });

    it("2.4 Cancel 或 Esc 取消 Plan 不会激活 TaskGraph", async () => {
      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        taskManager,
        planMode,
        decisionController,
        isTTY: true,
        stdout: mockStdout as any,
      });

      presenter.startRun("制定方案");
      planMode.enter("目标");
      planMode.proposePlan({
        summary: "初步方案",
        steps: [{ subject: "步骤 1" }],
      });

      // 切换到 Cancel 并确认
      decisionController.selectNext(); // revise
      decisionController.selectNext(); // cancel
      decisionController.confirmSelected();
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(planMode.getState(), "inactive");
      assert.equal(taskManager.getTasks().length, 0);

      presenter.stopRun();
    });
  });

  describe("3. Input Focus & Navigation Isolation", () => {
    it("3.1 当处于 Plan Approval 时，↑ / ↓ 仅分发给 DecisionController，不改变 Agent Selection", () => {
      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        taskManager,
        planMode,
        decisionController,
        isTTY: true,
        stdout: mockStdout as any,
      });

      presenter.startRun("测试导航隔离");

      // 注册两个 Agent
      agentRegistry.register({ name: "Worker-1", type: "subagent" });
      agentRegistry.register({ name: "Worker-2", type: "subagent" });

      planMode.enter("目标");
      planMode.proposePlan({
        summary: "方案",
        steps: [{ subject: "步骤 1" }],
      });

      assert.equal(decisionController.hasActiveDecision(), true);
      assert.equal(decisionController.getActiveDecision()?.selectedIndex, 0);

      const navHandler = presenter.getNavigationHandler();
      const inputManager = new InputManager({
        input: mockStdin,
        output: mockStdout,
        isTTY: true,
      });
      inputManager.startNavigationMode(navHandler);

      // 模拟按 ↓ 键 (\x1b[B)
      mockStdin.write("\x1b[B");

      // 决策选项下移到了 index 1 (Revise plan)
      assert.equal(decisionController.getActiveDecision()?.selectedIndex, 1);

      inputManager.stopNavigationMode();
      inputManager.close();
      presenter.stopRun();
    });

    it("3.2 当处于 Plan Approval 时，普通字符键不进入 ComposerDraft", () => {
      const presenter = new CliPresenter({
        eventBus,
        agentRegistry,
        taskManager,
        planMode,
        decisionController,
        isTTY: true,
        stdout: mockStdout as any,
      });

      presenter.startRun("测试 Composer 隔离");

      planMode.enter("目标");
      planMode.proposePlan({
        summary: "方案",
        steps: [{ subject: "步骤 1" }],
      });

      let draftOutput = "";
      const baseHandler = presenter.getNavigationHandler();
      const inputManager = new InputManager({
        input: mockStdin,
        output: mockStdout,
        isTTY: true,
      });

      inputManager.startNavigationMode({
        ...baseHandler,
        onComposerChange: (d) => {
          draftOutput = d;
        },
      });

      // 模拟用户误按普通英文字符 "hello"
      mockStdin.write("hello");

      // Composer draft 保持为空，不被污染
      assert.equal(draftOutput, "");

      inputManager.stopNavigationMode();
      inputManager.close();
      presenter.stopRun();
    });
  });

  describe("4. Sandbox / Permission Approval Subsystem", () => {
    it("4.1 Permission Approval 接入 DecisionController，支持 Allow once 与 Deny", async () => {
      const approvalProvider = new CliApprovalProvider({
        inputManager: new InputManager({ input: mockStdin, output: mockStdout, isTTY: true }),
        decisionController,
      });

      const approvalService = new ApprovalService({
        provider: approvalProvider,
        eventBus,
        isTTY: true,
      });

      const reqPromise = approvalService.requestApproval({
        capability: "filesystem-write",
        target: "~/other-project/secret.txt",
        reason: "cross-project analysis",
      });

      assert.equal(decisionController.hasActiveDecision(), true);
      const active = decisionController.getActiveDecision();
      assert.equal(active?.kind, "permission");
      assert.equal(active?.options[0].id, "allow-once");
      assert.equal(active?.options[1].id, "deny");

      // 用户按 Enter 确认 Allow once
      decisionController.confirmSelected();
      const result = await reqPromise;
      assert.equal(result, "allow-once");
    });

    it("4.2 Permission Approval 快捷键 'n' 直接 Deny", async () => {
      const approvalProvider = new CliApprovalProvider({
        inputManager: new InputManager({ input: mockStdin, output: mockStdout as any, isTTY: true }),
        decisionController,
      });

      const approvalService = new ApprovalService({
        provider: approvalProvider,
        eventBus,
        isTTY: true,
      });

      const reqPromise = approvalService.requestApproval({
        capability: "network",
        target: "curl https://api.external.com",
        reason: "fetch external api",
      });

      decisionController.handleShortcut("n");
      const result = await reqPromise;
      assert.equal(result, "deny");
    });
  });

  describe("5. DecisionRenderer & UI Presentation", () => {
    it("5.1 准确格式化包含中文的 Decision 卡片并对齐光标", () => {
      const lines = DecisionRenderer.renderDecision({
        decision: {
          id: "dec-1",
          kind: "confirmation",
          title: "方案设计已完成，请确认",
          description: "目标: 扫描全部垂直领域项目并生成诊断报告",
          options: [
            { id: "approve", label: "批准并立即执行", shortcut: "a" },
            { id: "revise", label: "修改设计方案", shortcut: "r" },
            { id: "cancel", label: "取消方案", destructive: true, shortcut: "c" },
          ],
          selectedIndex: 0,
          resolve: () => {},
          reject: () => {},
          createdAt: Date.now(),
        },
        maxWidth: 80,
      });

      const combined = lines.join("\n");
      assert.match(combined, /方案设计已完成/);
      assert.match(combined, /批准并立即执行/);
      assert.match(combined, /修改设计方案/);
    });

    it("5.2 动态 Hints 在不同交互模式下精准切换", () => {
      // Plan Approval 模式
      const planHints = DecisionRenderer.getDynamicHints({
        hasActiveDecision: true,
        decisionKind: "plan-approval",
      });
      assert.match(planHints, /↑↓ select · Enter confirm · Esc cancel/);

      // Permission 模式
      const permHints = DecisionRenderer.getDynamicHints({
        hasActiveDecision: true,
        decisionKind: "permission",
      });
      assert.match(permHints, /y\/n shortcut/);

      // Plan Revision 模式
      const revHints = DecisionRenderer.getDynamicHints({
        hasActiveDecision: false,
        isPlanRevisionInput: true,
      });
      assert.match(revHints, /Enter submit revision · Esc back/);

      // Alternate Screen 模式附带全局挂起提示
      const altHints = DecisionRenderer.getDynamicHints({
        hasActiveDecision: true,
        isAlternateScreen: true,
      });
      assert.match(altHints, /⚡ Decision Pending!/);
    });
  });
});
