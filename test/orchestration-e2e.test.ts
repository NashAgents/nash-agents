import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { TaskManager, TaskGraph } from "../src/task/index.js";
import { AgentRegistry, SubAgentRuntime } from "../src/agent/index.js";
import { ConcurrencyController } from "../src/concurrency/index.js";
import { TeamRuntime, Mailbox } from "../src/team/index.js";
import { WorkflowRuntime } from "../src/workflow/index.js";
import { PlanMode, TaskGraphBuilder, Replanner } from "../src/plan/index.js";
import {
  FileSystemAccess,
  createDefaultSandboxPolicy,
} from "../src/sandbox/index.js";
import {
  FileObservationStore,
  StaleFileVersionError,
  checkScopeOverlap,
} from "../src/filesystem/index.js";
import {
  formatTaskCentricView,
  formatAgentCentricView,
  formatTeamView,
} from "../src/projection/index.js";
import { EventBus } from "../src/observability/event-bus.js";

describe("Phase G: Comprehensive Orchestration Runtime E2E Scenarios", () => {
  it("E2E 场景 1: Plan Mode -> Approved Plan -> TaskGraphBuilder -> Task Execution Flow", () => {
    const eventBus = new EventBus();
    const emittedEvents: string[] = [];
    eventBus.subscribe("*", (e) => {
      emittedEvents.push(e.type);
    });

    const planMode = new PlanMode({ eventBus });
    const taskManager = new TaskManager({ eventBus });

    // 1. 用户输入目标，进入 Plan 模式探索
    planMode.enter("Build Microservice Authentication");

    // 2. 形成结构化方案提案
    planMode.proposePlan({
      summary: "Three-stage authentication service implementation",
      steps: [
        {
          id: "step-db",
          subject: "Setup user credentials schema",
          writeScopes: ["src/db/**"],
        },
        {
          id: "step-jwt",
          subject: "Implement token sign and verify",
          dependencies: ["step-db"],
          writeScopes: ["src/auth/**"],
        },
        {
          id: "step-test",
          subject: "Write end-to-end auth test suite",
          dependencies: ["step-jwt"],
          writeScopes: ["test/**"],
        },
      ],
    });

    // 3. 用户审批通过
    planMode.resolveApproval(true, "Architecture approved.");
    planMode.exit();

    const approvedPlan = planMode.requireApprovedPlan();

    // 4. TaskGraphBuilder 忠实将已批准方案转换为 TaskGraph (不重新调用 Planner)
    const runtimeTasks = TaskGraphBuilder.buildIntoTaskManager(approvedPlan, taskManager);
    assert.equal(runtimeTasks.length, 3);

    const [taskDb, taskJwt, taskTest] = runtimeTasks;

    // 5. 验证依赖与初始 readiness
    assert.equal(taskDb.status, "ready");
    assert.equal(taskJwt.status, "pending");
    assert.equal(taskTest.status, "pending");

    // 6. 顺序执行第一阶段
    taskManager.claimTask(taskDb.id, "backend-agent");
    taskManager.completeTask(taskDb.id, { summary: "Schema applied" }, { agentId: "backend-agent" });

    // 7. 级联验证第二阶段已自动 ready
    assert.equal(taskManager.requireTask(taskJwt.id).status, "ready");
    assert.equal(taskManager.requireTask(taskTest.id).status, "pending");

    // 8. 验证事件完整性
    assert(emittedEvents.includes("plan.entered"));
    assert(emittedEvents.includes("plan.proposed"));
    assert(emittedEvents.includes("plan.approved"));
    assert(emittedEvents.includes("plan.exited"));
    assert(emittedEvents.includes("task.created"));
    assert(emittedEvents.includes("task.completed"));
  });

  it("E2E 场景 2: Agent Team 协作、Mailbox Step-Boundary 注入与 CLI 视图投影", async () => {
    const eventBus = new EventBus();
    const registry = new AgentRegistry({ eventBus });
    const concurrency = new ConcurrencyController({ maxConcurrentAgents: 4 });
    const taskManager = new TaskManager({ eventBus });

    const team = new TeamRuntime({
      name: "Core Platform Team",
      leaderId: "main-lead",
      taskManager,
      agentRegistry: registry,
      concurrencyController: concurrency,
      eventBus,
    });

    // 1. 添加专业角色
    team.addMember({
      name: "Backend Specialist",
      agentId: "backend-specialist",
      role: "backend",
      roleDescription: "API and Database logic",
      writeScopes: ["src/backend/**"],
    });

    team.addMember({
      name: "Frontend Specialist",
      agentId: "frontend-specialist",
      role: "frontend",
      roleDescription: "UI and Web Client",
      writeScopes: ["src/frontend/**"],
    });

    // 2. 创建并分配任务
    taskManager.createTask({
      id: "task-api",
      subject: "Build GraphQL endpoint",
      writeScopes: ["src/backend/graphql/**"],
    });

    taskManager.createTask({
      id: "task-ui",
      subject: "Integrate Apollo Client",
      dependencies: ["task-api"],
      writeScopes: ["src/frontend/**"],
    });

    team.assignTask("task-api", "backend-specialist");
    team.claimTask("task-api", "backend-specialist");

    // 3. 点对点通信
    team.sendMessage(
      "backend-specialist",
      "frontend-specialist",
      "GraphQL endpoint /api/graphql is ready on port 3000."
    );

    // 4. 验证 Step-Boundary 提取
    const pending = team.claimMessagesForStep("frontend-specialist");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].content, "GraphQL endpoint /api/graphql is ready on port 3000.");

    // 5. 校验 CLI Projections 文本渲染
    const taskCentric = formatTaskCentricView(taskManager);
    assert(taskCentric.includes("[task-api]"));
    assert(taskCentric.includes("backend-specialist"));

    const agentCentric = formatAgentCentricView(registry, taskManager);
    assert(agentCentric.includes("main-lead"));
    assert(agentCentric.includes("backend-specialist"));

    const teamView = formatTeamView(team);
    assert(teamView.includes("Core Platform Team"));
    assert(teamView.includes("Roster Members"));
  });

  it("E2E 场景 3: 多 Agent 并发文件写防护 (writeScopes 拦截 + Stale Version 拦截 + 重新读取自愈)", async () => {
    const tempDir = path.join(os.tmpdir(), `nash-e2e-files-${Date.now()}`);
    const filePath = path.join(tempDir, "service-config.json");

    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ port: 8080, version: "1.0" }), "utf-8");

    try {
      const observationStore = new FileObservationStore();

      const fsAccessBackend = new FileSystemAccess({
        workspaceRoot: tempDir,
        policy: createDefaultSandboxPolicy(),
        agentId: "agent-backend",
        writeScopes: ["service-config.json"],
        observationStore,
      });

      // 1. Backend Agent 读取
      await fsAccessBackend.resolveForRead("service-config.json");

      // 2. 外部 Agent / 进程覆写
      await fs.writeFile(filePath, JSON.stringify({ port: 9000, version: "2.0" }), "utf-8");

      // 3. Backend Agent 基于旧版本写入被拦截 (StaleFileVersionError)
      await assert.rejects(
        async () => {
          await fsAccessBackend.resolveForWrite("service-config.json");
        },
        StaleFileVersionError
      );

      // 4. 自愈机制：重新使用 read_file 读取最新文件
      await fsAccessBackend.resolveForRead("service-config.json");

      // 5. 再次写入成功
      const writeOk = await fsAccessBackend.resolveForWrite("service-config.json");
      assert.equal(writeOk, filePath);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("E2E 场景 4: Workflow 多阶段 Pipeline 与 并发限制验证", async () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController({ maxConcurrentAgents: 3 });
    const subRuntime = new SubAgentRuntime({
      agentRegistry: registry,
      concurrencyController: concurrency,
    });
    const wf = new WorkflowRuntime({
      subAgentRuntime: subRuntime,
      concurrencyController: concurrency,
    });

    const pipelineResult = await wf.execute("audit-pipeline", async (ctx) => {
      ctx.phase("Static Analysis");
      const files = ["auth.ts", "session.ts", "sandbox.ts"];

      const results = await ctx.pipeline<string, { file: string; secure: boolean }>(
        files,
        async (f) => `analyzed:${f}`,
        async (analyzed, orig) => ({ file: orig, secure: true })
      );

      ctx.phase("Summary");
      return results;
    });

    assert.equal(pipelineResult.length, 3);
    assert.equal(pipelineResult[0].secure, true);
    assert.equal(pipelineResult[1].file, "session.ts");
  });
});
