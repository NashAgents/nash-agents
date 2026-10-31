import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  formatToolCallSummary,
  MultiAgentMetricsCollector,
  AgentTreeProjection,
  CliPresenter,
  isUserVisibleBackgroundJob,
} from "../src/presentation/index.js";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/index.js";
import { TaskManager } from "../src/task/index.js";
import { handleSlashCommand } from "../src/cli/slash-commands.js";
import { InputManager } from "../src/cli/input-manager.js";
import { TerminalUI } from "../src/cli/terminal-ui.js";

describe("CLI Presentation & Multi-Agent Observability", () => {
  it("1. formatToolCallSummary 正确格式化为单行人类可读短语，绝不输出 raw JSON 或大段脚本", () => {
    // 1.1 read_file -> reading <path>
    assert.equal(
      formatToolCallSummary("read_file", { path: "src/auth/service.ts" }),
      "reading src/auth/service.ts"
    );

    // 1.2 write_file -> writing <path> (绝不打印 content 大段内容)
    const writeSumm = formatToolCallSummary("write_file", {
      path: "src/auth/service.ts",
      content: "export const secret = 'foo';\n".repeat(100),
    });
    assert.equal(writeSumm, "writing src/auth/service.ts");
    assert.equal(writeSumm.includes("secret"), false);

    // 1.3 bash 短命令提炼
    assert.equal(formatToolCallSummary("bash", { command: "pwd" }), "checking working directory");
    assert.equal(formatToolCallSummary("bash", { command: "git status" }), "checking git status");
    assert.equal(formatToolCallSummary("bash", { command: "npm test" }), "running tests");
    assert.equal(formatToolCallSummary("bash", { command: "npm run build" }), "building project");
    assert.equal(
      formatToolCallSummary("bash", { command: 'python3 -c "import os\nprint(os.getcwd())"' }),
      "running environment check"
    );

    // 1.4 其它工具
    assert.equal(
      formatToolCallSummary("spawn_agent", { name: "env-auditor" }),
      "starting env-auditor"
    );
    assert.equal(
      formatToolCallSummary("send_message", { targetAgentId: "frontend-agent" }),
      "messaging frontend-agent"
    );
    assert.equal(
      formatToolCallSummary("wait_for_change", {}),
      "waiting for team update"
    );
  });

  it("2. Agent 名称规则: Main 始终为 Main (绝不显示为 Team Leader)，仅真 Team Lead 显示为 Lead", () => {
    const registry = new AgentRegistry();
    const projection = new AgentTreeProjection();

    // 普通 Main + SubAgent 场景
    const main = registry.register({ agentId: "main", type: "main", depth: 0 });
    assert.equal(AgentTreeProjection.getDisplayName(main), "Main");

    const sub = registry.register({
      agentId: "env-auditor",
      name: "env-auditor",
      parentAgentId: "main",
      type: "subagent",
      depth: 1,
    });
    assert.equal(AgentTreeProjection.getDisplayName(sub), "env-auditor");

    // 团队协作模式下的真实 Team Lead
    const lead = registry.register({ agentId: "team-lead-1", type: "team-lead", depth: 0 });
    assert.equal(AgentTreeProjection.getDisplayName(lead), "Lead");

    const output = projection.renderTree(registry);
    assert(output.includes("Main"));
    assert.equal(output.includes("Team Leader"), false, "普通 Main 绝不能显示为 Team Leader");
    assert(output.includes("env-auditor"));
  });

  it("3. isUserVisibleBackgroundJob 严格过滤短命令，仅保留真正后台长任务", () => {
    const now = Date.now();

    // 短命令 Job（如 pwd, ls, git status）-> 绝不进入 Background UI
    const shortJob = {
      id: "job-1",
      ownerAgentId: "main",
      command: "pwd",
      startedAt: now,
      status: "completed" as const,
      hardTimeoutMs: 30000,
    } as any;
    assert.equal(isUserVisibleBackgroundJob(shortJob), false);
    assert.equal(isUserVisibleBackgroundJob({ ...shortJob, status: "running", startedAt: 0, softTimeoutMs: 120_000 }), false, "未启动的普通命令不能误判为后台任务");

    // 显式指定 background: true 的后台任务 -> 进入 Background UI
    const bgJob = {
      id: "job-2",
      ownerAgentId: "env-auditor",
      command: "npm test",
      startedAt: now,
      status: "running" as const,
      hardTimeoutMs: 300000,
      backgroundRequested: true,
    } as any;
    assert.equal(isUserVisibleBackgroundJob(bgJob), true);

    // 软超时晋升 (promoted) 为后台长任务 -> 进入 Background UI
    const promotedJob = {
      id: "job-3",
      ownerAgentId: "env-auditor",
      command: "npx playwright test",
      startedAt: now,
      status: "running" as const,
      hardTimeoutMs: 300000,
      promoted: true,
    } as any;
    assert.equal(isUserVisibleBackgroundJob(promotedJob), true);
  });

  it("3.1 前台短命令的 Job 生命周期不重复显示系统通知", () => {
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    agentRegistry.register({ agentId: "main", type: "main" });
    const presenter = new CliPresenter({ eventBus, agentRegistry, isTTY: false });
    try {
      const base = { id: "pwd-job", command: "pwd", ownerAgentId: "main", status: "running", softTimeoutMs: 120_000 };
      for (const [type, data] of [
        ["job.created", { ...base, startedAt: 0 }],
        ["job.started", { ...base, startedAt: Date.now() }],
        ["job.completed", { ...base, startedAt: Date.now(), status: "completed" }],
      ] as const) {
        eventBus.emit({ id: type, type: type as any, timestamp: new Date().toISOString(), projectId: "test", sessionId: "test", data });
      }
      assert.doesNotMatch(presenter.getProjection("main").getDisplayLines().join("\n"), /Background job|Background command|\[system\]/);
    } finally {
      presenter.destroy();
    }
  });

  it("4. MultiAgentMetricsCollector 能够正确统计 Model Calls 并支持 tokens unavailable 判定", () => {
    const collector = new MultiAgentMetricsCollector();
    collector.startRun();

    // 1. 模拟发生模型调用（有 Token 返回）
    collector.recordModelCall("main", 1200, 300, 1500, true, true);
    collector.recordModelCall("env-auditor", 800, 150, 2000, true, true);
    collector.recordToolCall("env-auditor", "read_file", 20, true);

    const stats = collector.getAggregatedStats(3500);
    assert.equal(stats.totalAgents, 2);
    assert.equal(stats.totalModelCalls, 2);
    assert.equal(stats.totalToolCalls, 1);
    assert.equal(stats.totalInputTokens, 2000);
    assert.equal(stats.totalOutputTokens, 450);
    assert.equal(stats.tokensAvailable, true);

    const summary = collector.formatSummary(3500);
    assert(summary.includes("Run summary"));
    assert(summary.includes("2 agents · 1 tools · 3s"));
    assert(summary.includes("2 model calls · 2.0k in · 450 out"));

    // 2. 模拟无 Token 的 provider
    const noTokenCollector = new MultiAgentMetricsCollector();
    noTokenCollector.startRun();
    noTokenCollector.recordModelCall("main", 0, 0, 1000, true, false);

    const noTokenStats = noTokenCollector.getAggregatedStats(1000);
    assert.equal(noTokenStats.totalModelCalls, 1);
    assert.equal(noTokenStats.tokensAvailable, false);

    const noTokenSummary = noTokenCollector.formatSummary(1000);
    assert(noTokenSummary.includes("tokens unavailable"), "无 Token 返回时应展示 unavailable 而不是伪造 0");
  });

  it("5. 斜杠命令 /agents、/agent、/tasks 与 /jobs", async () => {
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry({ eventBus });
    const taskManager = new TaskManager({ eventBus });

    agentRegistry.register({ agentId: "main", type: "main", depth: 0 });
    agentRegistry.register({
      agentId: "env-auditor",
      name: "env-auditor",
      parentAgentId: "main",
      type: "subagent",
      role: "auditor",
      depth: 1,
    });
    taskManager.createTask({ id: "t1", subject: "Scan Project Config" });

    const input = new PassThrough();
    const output = new PassThrough();
    const inputManager = new InputManager({ input, output, isTTY: false });
    const terminalUI = new TerminalUI(output);
    const dummyContextManager = {
      getSession: () => ({ getSummary: async () => ({}) }),
      getProjectContext: () => undefined,
    } as any;

    try {
      // 1. /agents
      const resAgents = await handleSlashCommand("/agents", {
        inputManager,
        terminalUI,
        contextManager: dummyContextManager,
        agentRegistry,
        taskManager,
      });
      assert.equal(resAgents.handled, true);

      // 2. /agent env-auditor
      const resAgentDetail = await handleSlashCommand("/agent env-auditor", {
        inputManager,
        terminalUI,
        contextManager: dummyContextManager,
        agentRegistry,
        taskManager,
      });
      assert.equal(resAgentDetail.handled, true);

      // 3. /tasks
      const resTasks = await handleSlashCommand("/tasks", {
        inputManager,
        terminalUI,
        contextManager: dummyContextManager,
        agentRegistry,
        taskManager,
      });
      assert.equal(resTasks.handled, true);
    } finally {
      inputManager.close();
    }
  });
});
