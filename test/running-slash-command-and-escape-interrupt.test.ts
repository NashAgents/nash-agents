import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { UserMessageRouter } from "../src/orchestration/user-message-router.js";
import { SkillService } from "../src/skills/index.js";
import { DecisionController } from "../src/decision/decision-controller.js";
import { resolveComposerDestination } from "../src/orchestration/composer-routing.js";
import { handleSlashCommand, isSlashCommand } from "../src/cli/slash-commands.js";

describe("Running Slash Commands & Escape Interrupt Subsystem", () => {
  it("1. 运行态输入 Slash 命令（如 /skills）必须被本地立即拦截执行，绝对不进入 userMessageRouter 传给 LLM", async () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    (stream as any).columns = 80;
    (stream as any).rows = 24;

    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: stream,
      isTTY: true,
      nativeScrollback: true,
    });

    const router = new UserMessageRouter({ eventBus });
    const skillService = new SkillService();

    // 模拟运行态：Main 正在运行子代理
    presenter.startRun("分析多代理架构", "run-1");
    assert.equal(presenter.isRunActive(), true);

    let pickerOpened = false;
    presenter.openSkillsPicker = async () => {
      pickerOpened = true;
    };

    // 模拟用户在运行态输入 /skills 并回车
    const text = "/skills";
    const trimmedText = text.trim();

    assert.equal(isSlashCommand(trimmedText), true);

    if (presenter.isRunActive() && isSlashCommand(trimmedText)) {
      const cmdParts = trimmedText.slice(1).split(/\s+/);
      const cmdName = (cmdParts[0] || "").toLowerCase();

      assert.notEqual(cmdName, "resume");

      const cmdContext: any = {
        cliPresenter: presenter,
        skillService,
      };

      await handleSlashCommand(trimmedText, cmdContext);
    } else {
      router.submit(text, "main", "steer");
    }

    assert.equal(pickerOpened, true, "应当秒级直接打开 SkillsPicker 面板");
    assert.equal(router.hasPendingSteer("main"), false, "绝对不得将 /skills 写入 steerBuffers 传给 LLM！");

    presenter.destroy();
  });

  it("2. 运行态在 Main 视图按 Esc 必须真正触发中断（onInterrupt），并清空任何已暂存的 steer 消息", () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    (stream as any).columns = 80;
    (stream as any).rows = 24;

    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: stream,
      isTTY: true,
      nativeScrollback: true,
    });

    const router = new UserMessageRouter({ eventBus });
    const decisionController = new DecisionController();

    const mainController = new AbortController();
    router.registerAbortController("main", mainController);

    // 假设此前用户已输入了一条正常的 steer 指令
    router.submit("Hello world", "main", "steer");
    assert.equal(router.hasPendingSteer("main"), true);

    presenter.startRun("分析多代理架构", "run-1");
    assert.equal(presenter.isRunActive(), true);

    let interrupted = false;
    const baseNav = presenter.getNavigationHandler();
    const combinedNav = {
      ...baseNav,
      onInterrupt: () => {
        interrupted = true;
        router.triggerInterrupt("main", "User requested interrupt");
        decisionController.abortAll("Interrupted by user");
      },
      onKeyEscape: () => {
        if (presenter.isRunActive()) {
          const target = presenter.getActiveViewAgentId();
          if (target !== "main") {
            presenter.returnToMainView();
          } else {
            combinedNav.onInterrupt();
            presenter.showSteerFeedback("\x1b[33mInterrupted by user\x1b[0m");
          }
        } else {
          baseNav.onKeyEscape?.();
        }
      },
    };

    // 处于 Main 视图时按 Esc
    assert.equal(presenter.getActiveViewAgentId(), "main");
    combinedNav.onKeyEscape();

    assert.equal(interrupted, true, "按 Esc 必须真正触发中断");
    assert.equal(mainController.signal.aborted, true, "AbortController 必须被 abort");
    assert.equal(router.hasPendingSteer("main"), false, "中断后待传入的 steer 必须被全部清空，防止残留注入");

    presenter.destroy();
  });

  it("3. 运行态在子代理详情视图中，按 Esc 先平滑退回 Main 视图，再次按 Esc 则触发中断", () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    (stream as any).columns = 80;
    (stream as any).rows = 24;

    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    agentRegistry.register({
      agentId: "subagent-1",
      name: "subagent-1",
      type: "subagent",
    });

    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: stream,
      isTTY: true,
      nativeScrollback: true,
    });

    const router = new UserMessageRouter({ eventBus });
    let interruptedCount = 0;

    const baseNav = presenter.getNavigationHandler();
    const combinedNav = {
      ...baseNav,
      onInterrupt: () => {
        interruptedCount++;
        router.triggerInterrupt("main", "User requested interrupt");
      },
      onKeyEscape: () => {
        if (presenter.isRunActive()) {
          const target = presenter.getActiveViewAgentId();
          if (target !== "main") {
            presenter.returnToMainView();
          } else {
            combinedNav.onInterrupt();
            presenter.showSteerFeedback("\x1b[33mInterrupted by user\x1b[0m");
          }
        } else {
          baseNav.onKeyEscape?.();
        }
      },
    };

    presenter.startRun("分析多代理架构", "run-1");
    assert.equal(presenter.isRunActive(), true);

    // 切入子代理详情视图
    presenter.switchToAgentView("subagent-1");
    assert.equal(presenter.getActiveViewAgentId(), "subagent-1");

    // 第一次按 Esc：退回 Main 视图，不中断运行
    combinedNav.onKeyEscape();
    assert.equal(presenter.getActiveViewAgentId(), "main", "应当退回 Main 视图");
    assert.equal(interruptedCount, 0, "不应触发中断");

    // 第二次在 Main 视图按 Esc：触发中断
    combinedNav.onKeyEscape();
    assert.equal(interruptedCount, 1, "在 Main 视图按 Esc 应触发中断");

    presenter.destroy();
  });

  it("4. nativeScrollback 模式下 ensureElapsedTimer 保持保活，保证主/子代理运行中时间持续自动刷新", () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    (stream as any).columns = 80;
    (stream as any).rows = 24;

    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: stream,
      isTTY: true,
      nativeScrollback: true,
    });

    presenter.startRun("执行测试任务", "run-timer-1");
    // 验证 elapsedTimer 已被正确启动 (并非 undefined)
    assert.ok((presenter as any).elapsedTimer, "即使在 nativeScrollback 模式下，elapsedTimer 也必须已启动");

    presenter.destroy();
  });

  it("5. 运行态插入的 Steer 消息呈现在输入框上方 Pending 队列条中，直到 Step Boundary / agent.steered 触发时才正式注入 Transcript", () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    (stream as any).columns = 80;
    (stream as any).rows = 24;

    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    agentRegistry.register({
      agentId: "subagent-verifier",
      name: "subagent-verifier",
      type: "subagent",
    });

    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: stream,
      isTTY: true,
      nativeScrollback: true,
    });

    const router = new UserMessageRouter({ eventBus, agentRegistry });
    presenter.startRun("运行验证", "run-steer-1");
    presenter.switchToAgentView("subagent-verifier");

    // 用户在运行态输入 1+1等于几 并提交为 Steer
    const steerContent = "1+1等于几";
    router.submit(steerContent, "subagent-verifier", "steer");
    presenter.setPendingSteer("subagent-verifier", steerContent);

    // 检查：此时 Transcript 中绝对不得含有该消息，避免提前入库打乱位置
    const subProj = presenter.getProjection("subagent-verifier");
    assert.equal(
      subProj.getDisplayLines(80).some((l) => l.includes("1+1等于几")),
      false,
      "在工具执行结束前，Steer 消息绝不得提前写入 Transcript！"
    );

    // 检查：Pending Steer 队列条中已就绪
    const pending = presenter.getPendingSteer("subagent-verifier");
    assert.ok(pending);
    assert.equal(pending.content, "1+1等于几");

    // 模拟 Step Boundary 到达，AgentLoop 消费 Steer 并发出 agent.steered 事件
    eventBus.emit({
      id: "e-steer-1",
      type: "agent.steered",
      timestamp: new Date().toISOString(),
      projectId: "test",
      sessionId: "test",
      agentId: "subagent-verifier",
      data: {
        content: steerContent,
      },
    });

    // 检查：Pending 状态已清除，且正式转入 Transcript
    assert.equal(presenter.getPendingSteer("subagent-verifier"), undefined);
    assert.equal(
      subProj.getDisplayLines(80).some((l) => l.includes("1+1等于几")),
      true,
      "Step Boundary / agent.steered 触发后，消息正式移入 Transcript！"
    );

    presenter.destroy();
  });

  it("6. 当有活跃 Tool 正在运行时，按 Esc 优先触发 interruptActiveTool 中断工具，保留 Steer 推进至 LLM", () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    (stream as any).columns = 80;
    (stream as any).rows = 24;

    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    agentRegistry.register({
      agentId: "subagent-runner",
      name: "subagent-runner",
      type: "subagent",
    });

    const router = new UserMessageRouter({ eventBus, agentRegistry });
    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: stream,
      isTTY: true,
      nativeScrollback: true,
    });

    // 注册当前正在运行的 Tool 的 AbortController
    const toolController = new AbortController();
    router.registerToolAbortController("subagent-runner", toolController);
    assert.equal(router.hasActiveTool("subagent-runner"), true);

    // 模拟用户提交了 Steer
    router.submit("重点看内存泄漏", "subagent-runner", "steer");
    presenter.setPendingSteer("subagent-runner", "重点看内存泄漏");

    presenter.startRun("执行评测", "run-tool-inter-1");
    presenter.switchToAgentView("subagent-runner");

    let runInterrupted = false;
    let toolInterrupted = false;

    const baseNav = presenter.getNavigationHandler();
    const combinedNav = {
      ...baseNav,
      onInterrupt: () => {
        runInterrupted = true;
      },
      onKeyEscape: () => {
        if (presenter.isRunActive()) {
          const target = presenter.getActiveViewAgentId();
          const hasQueued =
            router.hasPendingSteer(target) ||
            router.hasPendingSteer("main") ||
            Boolean(presenter.getPendingSteer(target)) ||
            presenter.hasAnyPendingSteer();

          if (hasQueued) {
            toolInterrupted = router.interruptActiveTool(target);
            presenter.showSteerFeedback("\x1b[33mTool interrupted · injecting queued steer into LLM\x1b[0m");
            return;
          }

          if (router.hasActiveTool(target)) {
            toolInterrupted = router.interruptActiveTool(target);
            presenter.showSteerFeedback("\x1b[33mTool interrupted by user\x1b[0m");
            return;
          }
          if (target !== "main") {
            presenter.returnToMainView();
            return;
          }
          combinedNav.onInterrupt();
        }
      },
    };

    // 按 Esc 键
    combinedNav.onKeyEscape();

    // 验证：工具已被中断，且整个 Run 并未被杀死，视口依然停留在子代理！
    assert.equal(toolInterrupted, true, "工具必须被中断");
    assert.equal(toolController.signal.aborted, true, "Tool AbortController 必须触发 abort");
    assert.equal(runInterrupted, false, "有 Queued 消息时按 Esc 绝对不能误杀整个 Run！");
    assert.equal(presenter.getActiveViewAgentId(), "subagent-runner", "按 Esc 必须保留在当前子代理视图，绝不强行退回 Main！");
    assert.equal(router.hasPendingSteer("subagent-runner"), true, "Steer 消息必须完整保留以推进至 LLM！");

    presenter.destroy();
  });

  it("7. 用户在子代理详情页中提交指令，beginRunTransition 保持视口在该子代理，消息进入子代理 Projection 绝不切回 Main", () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    (stream as any).columns = 80;
    (stream as any).rows = 24;

    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    agentRegistry.register({
      agentId: "test-verifier",
      name: "test-verifier",
      type: "subagent",
    });

    const presenter = new CliPresenter({
      eventBus,
      agentRegistry,
      stdout: stream,
      isTTY: true,
      nativeScrollback: true,
    });

    // 切换至子代理视图
    presenter.switchToAgentView("test-verifier");
    assert.equal(presenter.getActiveViewAgentId(), "test-verifier");

    // 用户在子代理中提交新指令
    const prompt = "请分析最新提交";
    presenter.beginRunTransition(prompt, "run-sub-2", "test-verifier");

    // 验证：视口依然在 test-verifier，绝对未切回 main！
    assert.equal(presenter.getActiveViewAgentId(), "test-verifier", "视口必须保持在 test-verifier");

    // 验证：用户消息写入了 test-verifier 的 Projection，而不是 main 的 Projection！
    const subProj = presenter.getProjection("test-verifier");
    const mainProj = presenter.getProjection("main");

    assert.equal(
      subProj.getDisplayLines(80).some((l) => l.includes("请分析最新提交")),
      true,
      "消息必须写入 test-verifier 的 Transcript"
    );
    assert.equal(
      mainProj.getDisplayLines(80).some((l) => l.includes("请分析最新提交")),
      false,
      "Main 的 Transcript 绝对不得包含发送给子代理的独立指令！"
    );

    presenter.destroy();
  });
});
