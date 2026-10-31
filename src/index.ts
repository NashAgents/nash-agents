#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { runAgentLoop } from "./runtime/agent-loop.js";
import {
  loadSandboxPolicyFromSettings,
  loadContextConfigFromSettings,
  loadObservabilityConfigFromSettings,
  loadJobsConfigFromSettings,
  loadRuntimeLimitsFromSettings,
  loadMemoryConfigFromSettings,
  loadSkillConfigFromSettings,
} from "./config/settings.js";
import { MemoryService } from "./memory/index.js";
import { SkillService } from "./skills/index.js";
import {
  ensureNashSettings,
  getNashModelConfig,
} from "./config/nash-config.js";
import { ApprovalService } from "./approval/approval-service.js";
import { CliApprovalProvider } from "./approval/cli-approval.js";
import { FileSystemAccess } from "./sandbox/filesystem-access.js";
import { SandboxService } from "./sandbox/sandbox-service.js";
import { createDefaultToolRegistry, ToolExecutor } from "./tools/index.js";
import { ContextManager } from "./context/index.js";
import { LocalSessionStore } from "./context/session/local-session-store.js";
import { resolveProjectContext } from "./project/index.js";
import { TaskManager } from "./task/index.js";
import { AgentRegistry, SubAgentRuntime } from "./agent/index.js";
import { ConcurrencyController } from "./concurrency/index.js";
import { TeamRuntime } from "./team/index.js";
import { PlanMode, PlanPatcher } from "./plan/index.js";
import { JobManager } from "./jobs/index.js";
import { EventBus } from "./observability/event-bus.js";
import { CliPresenter } from "./presentation/cli-presenter.js";
import { UserMessageRouter } from "./orchestration/user-message-router.js";
import { resolveComposerDestination } from "./orchestration/composer-routing.js";
import { DecisionController } from "./decision/index.js";
import {
  InputManager,
  TerminalUI,
  handleSlashCommand,
  isSlashCommand,
  isShellCommand,
  executeDirectShellCommand,
} from "./cli/index.js";
import { runNashDoctor } from "./cli/doctor.js";
import { runNashMcp } from "./cli/mcp-cli.js";
import { MCPManager } from "./mcp/mcp-manager.js";

// Node.js 严格版本保护守卫 (Fail-Early Guard)
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor !== 24 || nodeMinor < 14) {
  console.error(`Nash Agents requires Node.js >=24.14.0 <25.`);
  console.error(`Current: ${process.versions.node}`);
  console.error(`Please upgrade Node.js.`);
  process.exit(1);
}

// 优先尝试读取当前用户工作目录下的 .env 文件（如果存在，静音避免向终端泄漏 injected 调试文本）
try {
  dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });
} catch {
  // 静默忽略
}

function getCliVersion(): string {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(currentDir, "../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
        version?: string;
      };
      if (pkg.version) return pkg.version;
    }
  } catch {}
  return "1.0.0";
}

// 轻量级 CLI 参数处理
const cliArgs = process.argv.slice(2);
if (["init", "start", "stop", "status", "config", "upgrade"].includes(cliArgs[0]) ||
    cliArgs[0] === "node" && ["join", "list", "invite"].includes(cliArgs[1])) {
  const { runProductCli } = await import("./cli/product-cli.js");
  process.exitCode = await runProductCli(cliArgs);
} else {
if (cliArgs[0] === "cluster") {
  const { handleClusterCommand } = await import("./cluster/cli/cluster-commands.js");
  await handleClusterCommand(cliArgs.slice(1));
  // 保留子命令写入的失败退出码（例如 nodes 401/连接失败），不再无条件覆盖为 0。
  process.exit(process.exitCode ?? 0);
}

if (cliArgs[0] === "node") {
  const { handleNodeCommand } = await import("./cluster/cli/node-commands.js");
  await handleNodeCommand(cliArgs.slice(1));
  process.exit(0);
}

if (cliArgs[0] === "sandbox") {
  if (cliArgs[1] === "doctor") {
    if (process.platform === "win32") {
      const { WindowsSandboxDoctor } = await import("./sandbox/windows/doctor.js");
      WindowsSandboxDoctor.printReport();
      process.exit(0);
    }
    const exitCode = await runNashDoctor(cliArgs);
    process.exit(exitCode);
  }
}

if (cliArgs[0] === "mcp") {
  const exitCode = await runNashMcp(cliArgs.slice(1));
  process.exit(exitCode);
}

if (cliArgs[0] === "config") {
  const { handleConfigCommand } = await import("./config/cli-config.js");
  await handleConfigCommand(cliArgs.slice(1));
  process.exit(process.exitCode ?? 0);
}

if (cliArgs.includes("doctor")) {
  const exitCode = await runNashDoctor(cliArgs);
  process.exit(exitCode);
}

if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
  console.log(`Nash Agents v${getCliVersion()}`);
  process.exit(0);
}

if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  console.log(`\x1b[1m\x1b[36mNash Agents CLI\x1b[0m v${getCliVersion()}

\x1b[1mUsage:\x1b[0m
  nash [options]
  nash cluster [command]
  nash node [command]
  nash mcp [command]
  nash doctor

  Source checkout: node dist/index.js <command>
  init             Initialize role, models, security and database administrator
  start            Start configured services (--background is optional)
  stop             Stop this installation's managed service
  status           Inspect actual local service state
  config           Show redacted configuration (validate / versions / rollback)
  node invite      Create a short-lived, one-use Worker invitation
  node join        Pair a Worker by entering its invitation securely
  node list        List registered nodes from a running Coordinator
  upgrade          Check upgrade readiness (--apply for a backed-up upgrade)

\x1b[1mOptions:\x1b[0m
  cluster          Manage Nash Cluster Coordinator, nodes, tasks and remote approvals
  node             Manage local Worker node connection, projects and identity
  mcp              Manage Model Context Protocol (MCP) servers & tools
  doctor           Run comprehensive sandbox & environment diagnostics
  -h, --help       Show this help message and exit
  -v, --version    Show version number and exit

\x1b[1mCommands in REPL:\x1b[0m
  /mcp             Manage connected Model Context Protocol (MCP) servers
  /status          Show comprehensive system, project and runtime status
  /diff            Review local changed files
  /jobs            List background jobs and status
  /job <id>        View details and output tail of a specific job
  /resume [id]     Search and resume a previous session
  /session         Show information about the current session
  /new             Start a brand new session
  /compact         Manually trigger context compaction
  /skills          List and inspect available skills
  /memory          View active memory records
  /help            Show REPL commands
  exit, quit       Exit the harness CLI
`);
  process.exit(0);
}

/**
 * 首次初始化时的访问模式确认。
 *
 * 铁律：
 * 1. 既有安装（settings.json 已存在）永不经过此路径，也绝不被迁移或覆盖；
 * 2. 交互式首次安装默认建议完全访问自主模式，但必须由用户明确确认并看到风险；
 * 3. 非交互安装只有在显式给出 NASH_INIT_ACCESS_MODE / NASH_INIT_FULL_ACCESS 时才启用高权限。
 */
async function resolveFirstRunAccessMode() {
  const settingsPath = path.join(os.homedir(), ".nash", "settings.json");
  if (fs.existsSync(settingsPath)) return undefined;

  const explicit = (process.env.NASH_INIT_ACCESS_MODE ?? "").trim().toLowerCase();
  if (explicit === "full-access" || explicit === "restricted") return explicit;
  if (process.env.NASH_INIT_FULL_ACCESS === "1") return "full-access";

  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      "\n\x1b[1m首次初始化安全模式选择\x1b[0m\n\n" +
      "  \x1b[1m完全访问自主模式\x1b[0m（推荐，默认）\n" +
      "    文件系统: danger-full-access    网络: allow    审批: auto-grant\n" +
      "    · 常规操作在独立安全审查通过后自动执行，不再逐次弹窗；\n" +
      "    · 仍保留确定性硬拦截（破坏性删除、特权文件篡改等一律阻断）；\n" +
      "    · 安全审查不可用时按 Fail-Closed 拒绝，绝不静默放行；\n" +
      "    · \x1b[33m授权范围更大：该模式下不存在完整的文件系统隔离保证，请自行确认目标目录。\x1b[0m\n\n" +
      "  \x1b[1m受限模式\x1b[0m：workspace-write / network deny / 逐次人工审批\n\n" +
      "  随时可用 `nash config set security <full-access|restricted>` 切换。\n"
    );
    const answer = (await rl.question("是否启用完全访问自主模式？[Y/n] ")).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes" || answer === "是" ? "full-access" : "restricted";
  } finally {
    rl.close();
  }
}

async function main() {
  const terminalUI = new TerminalUI();
  const inputManager = new InputManager();
  inputManager.disableMouseReporting();
  const decisionController = new DecisionController();

  // 1. 检查并在必要时初始化 NASH_HOME 目录及 settings.json（默认 ~/.nash-agents）
  // 首次初始化必须由用户显式确认访问模式；非交互安装需要显式授权参数。
  ensureNashSettings({ accessMode: await resolveFirstRunAccessMode() });

  // 2. 解析当前项目的 Project Namespace (稳定哈希与独立持久化存储隔离)
  const projectContext = await resolveProjectContext();

  // 检查是否存在旧的 Legacy Session 存储
  const legacySessions = await LocalSessionStore.detectLegacySessions(projectContext.nashHome);

  // 3. 载入模型、上下文及 Observability、Jobs、Runtime 配置信息
  const modelConfig = getNashModelConfig();
  const contextConfig = loadContextConfigFromSettings();
  const obsConfig = loadObservabilityConfigFromSettings();
  const jobsConfig = loadJobsConfigFromSettings();
  const runtimeLimits = loadRuntimeLimitsFromSettings();

  // 4. 从 settings.json (工作区优先或 NASH_HOME 回退) 加载全局沙箱策略
  const policy = loadSandboxPolicyFromSettings();

  // 5. 极简启动首屏呈现 (仅非交互式管道/重定向模式调用；交互式 TTY 由 CliPresenter 统一接管渲染，杜绝双 Header 重叠)
  if (!process.stdout.isTTY) {
    terminalUI.renderHeader({
      modelName: modelConfig.model,
      projectPath: projectContext.projectRoot,
      legacyCount: legacySessions.length,
    });
  }

  // 6. 初始化 CLI 审批提供者与服务（注入统一的 InputManager, DecisionController 与 TerminalUI）
  const approvalProvider = new CliApprovalProvider({
    inputManager,
    terminalUI,
    decisionController,
  });
  const approvalService = new ApprovalService({
    provider: approvalProvider,
    eventBus: new EventBus(),
    isTTY: Boolean(process.stdout.isTTY),
  });

  // 7. 初始化文件系统安全访问控制层与进程沙箱服务
  const fsAccess = new FileSystemAccess({
    policy,
    approvalService,
    agentId: "main",
  });

  const sandboxService = new SandboxService({
    policy,
    approvalService,
  });

  // 8. 初始化上下文管理器（绑定当前 ProjectContext 实现按项目隔离 Session / Spill）
  const contextManager = new ContextManager({
    projectContext,
    config: contextConfig,
    modelConfig,
  });

  // 9. 初始化事件总线与后台 Job 治理中枢 (JobManager)
  const eventBus = new EventBus();
  const jobManager = new JobManager({
    eventBus,
    defaultProjectId: projectContext.projectId,
    defaultSessionId: contextManager.sessionId,
    sandboxService,
    maxConsecutiveWakes: jobsConfig.maxConsecutiveWakes,
  });

  // 10. 初始化多 Agent 协同与编排运行时子系统
  const taskManager = new TaskManager({
    eventBus,
    projectId: projectContext.projectId,
  });
  const agentRegistry = new AgentRegistry({
    eventBus,
    projectId: projectContext.projectId,
  });
  const concurrencyController = new ConcurrencyController({
    maxAgentTurns: runtimeLimits.maxAgentTurns,
    maxToolCalls: runtimeLimits.maxToolCalls,
    maxRunMs: runtimeLimits.maxRunMs,
    maxConsecutiveWakes: jobsConfig.maxConsecutiveWakes,
  });

  const userMessageRouter = new UserMessageRouter({
    eventBus,
    projectId: projectContext.projectId,
    sessionId: contextManager.sessionId,
    agentRegistry,
    jobManager,
  });

  const subAgentRuntime = new SubAgentRuntime({
    agentRegistry,
    concurrencyController,
    taskManager,
    eventBus,
    jobManager,
    projectContext,
    approvalService,
    policy,
    fsAccess,
    sandboxService,
    userMessageRouter,
  });

  const teamRuntime = new TeamRuntime({
    name: "Default Team",
    leaderId: "main",
    taskManager,
    agentRegistry,
    concurrencyController,
    eventBus,
  });

  subAgentRuntime.setTeamRuntime(teamRuntime);

  const planMode = new PlanMode({
    eventBus,
    projectId: projectContext.projectId,
    fsAccess,
    decisionController,
    taskManager,
  });

  // 10.1 初始化持久化 Memory 与 Skills 服务
  const memoryConfig = loadMemoryConfigFromSettings();
  const memoryService = new MemoryService({
    projectContext,
    config: memoryConfig,
    eventBus,
  });

  const skillConfig = loadSkillConfigFromSettings();
  const skillService = new SkillService({
    projectContext,
    config: skillConfig,
    eventBus,
  });

  // 10.2 初始化 MCP 统一管理服务中枢
  const mcpManager = new MCPManager({
    projectRoot: projectContext.projectRoot,
    nashHome: projectContext.nashHome,
    approvalService,
    eventBus,
    spillStore: contextManager.getSpillStore(),
    sessionId: contextManager.sessionId,
    // MCP 调用必须遵守 CLI 当前生效的沙箱策略（network / approval 边界）：
    // 不注入 sandboxService 会让远程 MCP 调用绕过 network: deny。
    sandboxService,
    sandboxPolicy: policy,
  });
  await mcpManager.initialize();

  // 11. 创建并注册注入了沙箱、Spill、JobManager 与全套多 Agent 编排依赖的完整工具集
  const registry = createDefaultToolRegistry({
    fsAccess,
    sandboxService,
    spillStore: contextManager.getSpillStore(),
    jobManager,
    taskManager,
    subAgentRuntime,
    agentRegistry,
    teamRuntime,
    planMode,
    skillService,
    memoryService,
    mcpManager,
    sessionId: contextManager.sessionId,
    projectId: projectContext.projectId,
  });

  // 12. 创建通用工具执行器
  const executor = new ToolExecutor(registry);

  // 13. 初始化统一 CLI 展示层 (CliPresenter)
  const cliPresenter = new CliPresenter({
    eventBus,
    agentRegistry,
    nativeScrollback: true,
    taskManager,
    jobManager,
    approvalService,
    decisionController,
    planMode,
    modelName: modelConfig.model,
    projectRoot: projectContext.projectRoot,
    onPlanApproved: (_plan) => {
      // 方案批准通过 propose_plan 工具返回值直接交付当前正在运行的 AgentLoop，
      // 此处不重复向 queue 提交指令，避免导致重复触发下一轮运行与输出冗余报告
    },
    onPlanRevisionSubmitted: (revisionText, plan) => {
      userMessageRouter.submit(
        `用户对方案提出了修改意见: "${revisionText}"\n请根据用户反馈重新调研调整，并调用 propose_plan 重新提交修改后的方案。`,
        "main",
        "queue"
      );
    },
  });

  cliPresenter.setOnInteractionModeChange((mode) => {
    inputManager.setInteractionMode(mode);
  });

  // 14. 构造 /status 状态提供者
  const statusProvider = () => {
    const limits = concurrencyController.getLimits();
    const jobs = jobManager.listJobs();
    const runningJobs = jobs.filter((j) => j.status === "running").length;

    return {
      project: {
        name: projectContext.displayName,
        root: projectContext.projectRoot,
        storage: projectContext.projectDir,
      },
      model: {
        name: modelConfig.model,
        contextWindow: modelConfig.contextWindow,
        compactionThreshold: modelConfig.compactionThreshold,
      },
      security: {
        backend: sandboxService.getBackend().name,
        filesystem: policy.filesystem.mode,
        network: policy.network.mode,
        approval: policy.approval.mode,
        seccomp: process.platform === "linux" ? "per-process (see sandbox diagnostics)" : "not applicable",
        noNewPrivs: process.platform === "linux" ? "per-process (see sandbox diagnostics)" : "not applicable",
        resources: process.platform === "linux" ? "cgroup-v2 when configured and available" : "not available on this platform",
      },
      runtime: {
        maxAgentTurns: limits.maxAgentTurns,
        maxToolCalls: limits.maxToolCalls,
        maxRunMs: limits.maxRunMs,
      },
      jobs: {
        running: runningJobs,
        total: jobs.length,
      },
      sessions: {
        currentId: contextManager.sessionId,
        legacyCount: legacySessions.length,
      },
    };
  };

  const isTTY = Boolean(process.stdout.isTTY);

  // 14. 构造统一 Navigation 与输入分发处理器
  let turnResolver: ((value: { text: string; target: string }) => void) | null = null;
  let turnRejecter: ((err: Error) => void) | null = null;

  const baseNavHandler = cliPresenter.getNavigationHandler();
  const combinedNavHandler = {
    ...baseNavHandler,
    isRunActive: () => cliPresenter.isRunActive(),
    onComposerChange: (draft: string, cursorIndex?: number) => {
      cliPresenter.setComposerDraft(draft, cursorIndex);
    },
    onFollowupModeChange: (mode: "steer" | "queue") => {
      cliPresenter.setFollowupMode(mode);
    },
    onComposerSubmit: (
      text: string,
      mode: "steer" | "queue" | "start-run"
    ) => {
      const target = cliPresenter.getActiveViewAgentId();
      const destination = resolveComposerDestination({
        interactionMode: cliPresenter.getInteractionMode(),
        isRunActive: cliPresenter.isRunActive(),
        viewedAgentId: target,
        requestedMode: mode,
      });
      if (destination === "plan-revision") {
        cliPresenter.submitPlanRevision(text);
        return;
      }
      if (destination === "start-run") {
        if (turnResolver) {
          const r = turnResolver;
          turnResolver = null;
          turnRejecter = null;
          const fullText = inputManager.getAttachmentManager().expandText(text);
          r({ text: fullText, target });
        }
        return;
      }
      if (destination === "unsupported-child-queue") {
        cliPresenter.showSteerFeedback("Queue is available for Main; use Enter to steer this agent.");
        return;
      }
      if (text.trim().startsWith("!")) {
        cliPresenter.showSteerFeedback("! commands cannot run while an agent is active");
        return;
      }
      const trimmedText = text.trim();
      if (cliPresenter.isRunActive() && isSlashCommand(trimmedText)) {
        const cmdParts = trimmedText.slice(1).split(/\s+/);
        const cmdName = (cmdParts[0] || "").toLowerCase();

        // 运行中禁止破坏性会话切换或压缩
        if (cmdName === "resume" || cmdName === "new" || cmdName === "compact") {
          cliPresenter.showSteerFeedback(`/${cmdName} cannot run while an agent is active`);
          return;
        }

        const cmdContext = {
          inputManager,
          terminalUI,
          contextManager,
          projectContext,
          baseDir: contextConfig.baseDir,
          agentRegistry,
          taskManager,
          jobManager,
          cliPresenter,
          statusProvider,
          memoryService,
          skillService,
          mcpManager,
          onSessionSwitched: async (newSessionId: string) => {
            const session = contextManager.getSession();
            const records = await session.getRecords();
            cliPresenter.loadResumedSession(records);
          },
        };

        void handleSlashCommand(trimmedText, cmdContext).catch((err: unknown) => {
          cliPresenter.showSteerFeedback(
            `Command failed: ${err instanceof Error ? err.message : String(err)}`
          );
        });
        return;
      }
      if (destination === "steer") {
        const fullText = inputManager.getAttachmentManager().expandText(text);
        userMessageRouter.submit(fullText, target, "steer");
        // 暂存于输入框上方作为 Pending Steer 队列卡片，等待下一轮 Tool 结束或 Esc 中断时正式注入 Transcript
        cliPresenter.setPendingSteer(target, fullText);
        cliPresenter.showSteerFeedback(
          `↻ Queued for ${target === "main" ? "Main" : target} (esc to interrupt tool & send)`
        );
      } else {
        const fullText = inputManager.getAttachmentManager().expandText(text);
        userMessageRouter.submit(fullText, target, "queue");
        cliPresenter.setFollowupCount(userMessageRouter.getQueueLength());
        // 即时将 Queued 消息追加至当前界面历史
        cliPresenter.addUserMessageToTranscript(text, target, "queue");
        cliPresenter.showSteerFeedback(
          `✓ Queued for next turn: "${text.slice(0, 25)}..."`
        );
      }
    },
    onInterrupt: () => {
      userMessageRouter.triggerInterrupt("main", "User requested interrupt");
      cliPresenter.clearPendingSteer();
      decisionController.abortAll("Interrupted by user");
      approvalService.abortAll("Interrupted by user");
    },
    onAgentInterrupt: () => {
      const target = cliPresenter.getActiveViewAgentId();
      if (target !== "main") {
        userMessageRouter.triggerInterrupt(target, "User interrupted agent");
        cliPresenter.clearPendingSteer(target);
        subAgentRuntime.interrupt(target, "User interrupted");
      }
    },
    onKeyEscape: () => {
      if (cliPresenter.isRunActive()) {
        const target = cliPresenter.getActiveViewAgentId();
        const hasQueued =
          userMessageRouter.hasPendingSteer(target) ||
          userMessageRouter.hasPendingSteer("main") ||
          Boolean(cliPresenter.getPendingSteer(target)) ||
          cliPresenter.hasAnyPendingSteer();

        // Esc 语义：
        // 场景 A：如果用户在运行中插入了消息（有待注入的 Steer 消息）
        // 此时按 Esc 的唯一目的：掐停当前正在跑的 Tool / 步骤，把暂存的 Steer 消息直接传进 LLM！
        // 绝对不得中断整个 Run / Loop，也绝对不得切换视图退回 Main！
        if (hasQueued) {
          userMessageRouter.interruptActiveTool(target);
          cliPresenter.showSteerFeedback("\x1b[33mTool interrupted · injecting queued steer into LLM\x1b[0m");
          return;
        }

        // 场景 B：用户没有任何待发送的输入或队列（纯空闲/无 Steer 状态）
        // 1. 若当前有正在运行的 Tool，按 Esc 仅中断该 Tool
        if (userMessageRouter.hasActiveTool(target) || userMessageRouter.hasActiveTool("main")) {
          userMessageRouter.interruptActiveTool(target);
          cliPresenter.showSteerFeedback("\x1b[33mTool interrupted by user · resuming LLM\x1b[0m");
          return;
        }

        // 2. 若在子代理详情页且无正在执行的 Tool、无队列消息，按 Esc 平滑退回 Main 视图
        if (target !== "main") {
          cliPresenter.returnToMainView();
          return;
        }

        // 3. 在 Main 视图且无活跃 Tool、无队列消息，按 Esc 触发全局中断
        combinedNavHandler.onInterrupt();
        cliPresenter.showSteerFeedback("\x1b[33mInterrupted by user\x1b[0m");
      } else {
        baseNavHandler.onKeyEscape?.();
      }
    },
  };

  cliPresenter.setOnInteractionModeChange((mode) => {
    inputManager.setInteractionMode(mode);
  });

  if (isTTY) {
    inputManager.startNavigationMode(
      combinedNavHandler,
      cliPresenter.getInteractionMode()
    );
  }

  async function getNextUserInput(): Promise<{ text: string; target: string }> {
    if (!isTTY) {
      const msg = await inputManager.readUserMessage("\x1b[36mNash > \x1b[0m");
      return { text: msg, target: "main" };
    }
    return new Promise<{ text: string; target: string }>((resolve, reject) => {
      turnResolver = resolve;
      turnRejecter = reject;
    });
  }

  try {
    cliPresenter.enterAppScreen();

    while (true) {
      let userInputItem: { text: string; target: string };
      try {
        userInputItem = await getNextUserInput();
      } catch (err: unknown) {
        if (
          err &&
          typeof err === "object" &&
          "message" in err &&
          (err.message === "InputManager closed" ||
            String(err.message).includes("closed"))
        ) {
          break;
        }
        throw err;
      }

      const trimmed = userInputItem.text.trim();
      const runTarget = userInputItem.target || "main";

      if (!trimmed) {
        continue;
      }

      if (isSlashCommand(trimmed)) {
        const cmdResult = await handleSlashCommand(trimmed, {
          inputManager,
          terminalUI,
          contextManager,
          projectContext,
          baseDir: contextConfig.baseDir,
          agentRegistry,
          taskManager,
          jobManager,
          cliPresenter,
          statusProvider,
          memoryService,
          skillService,
          mcpManager,
          onSessionSwitched: async (newSessionId) => {
            const session = contextManager.getSession();
            const records = await session.getRecords();
            cliPresenter.loadResumedSession(records);
          },
        });

        if (cmdResult.shouldExit) {
          if (!isTTY) console.log("Goodbye!");
          break;
        }

        if (cmdResult.handled) {
          continue;
        }
      }

      if (isShellCommand(trimmed)) {
        const shellCmd = trimmed.slice(1).trim();
        if (!shellCmd) {
          if (cliPresenter.isInteractiveTTY()) {
            cliPresenter.showSteerFeedback("Usage: ! <command> (e.g. ! git status)");
          } else {
            terminalUI.renderWarning("Usage: ! <command> (e.g. ! git status)\n");
          }
          continue;
        }

        await executeDirectShellCommand({
          command: shellCmd,
          cwd: projectContext.projectRoot,
          cliPresenter,
          inputManager,
          contextManager,
          terminalUI,
        });
        continue;
      }

      const lower = trimmed.toLowerCase();
      if (lower === "exit" || lower === "quit") {
        if (!isTTY) console.log("Goodbye!");
        break;
      }

      let activePrompt: string | undefined = trimmed;

      while (activePrompt) {
        const currentTurnPrompt = activePrompt;
        activePrompt = undefined;

        // 若用户在非 Main 的子代理详情页中提交新指令，由 subAgentRuntime 驱动该子代理执行，视口始终保持在子代理！
        if (runTarget !== "main") {
          const agentRec = agentRegistry.getAgent(runTarget) ?? agentRegistry.findByName(runTarget);
          if (agentRec) {
            cliPresenter.beginRunTransition(currentTurnPrompt, undefined, agentRec.agentId);
            inputManager.startNavigationMode(combinedNavHandler, "agent-detail");
            cliPresenter.commitRunTransition();

            const targetAbortController = new AbortController();
            userMessageRouter.registerAbortController(agentRec.agentId, targetAbortController);

            try {
              const res = await subAgentRuntime.spawn(currentTurnPrompt, {
                agentId: agentRec.agentId,
                name: agentRec.name,
                role: agentRec.role,
                roleDescription: agentRec.roleDescription,
                worktreePath: agentRec.worktreePath,
              });
              cliPresenter.stopRun(res.output);
            } catch (err: unknown) {
              cliPresenter.stopRun(undefined, err instanceof Error ? err.message : String(err));
            } finally {
              userMessageRouter.unregisterAbortController(agentRec.agentId);
            }
            continue;
          }
        }

        const mainAbortController = new AbortController();
        userMessageRouter.registerAbortController("main", mainAbortController);

        const runStart = Date.now();

        // 1. 开启原子 Run Transition Guard (抑制中间帧输出，注册 Main Agent 并初始化数据投影)
        cliPresenter.beginRunTransition(currentTurnPrompt);

        // 2. 挂载 NavigationHandler 并激活 running-main 模式
        inputManager.startNavigationMode(combinedNavHandler, "running-main");

        // 3. 提交 Transition，一次性渲染完整稳定的 RunningMainView 首帧
        cliPresenter.commitRunTransition();

        // 4. 解析多模态与长文本 Payload (将图片附件转为 image_url，将粘贴块展开为完整文本)
        const agentInputPayload = inputManager
          .getAttachmentManager()
          .toMessageContent(currentTurnPrompt);

        try {
          const answer = await runAgentLoop(agentInputPayload, {
            agentId: "main",
            agentName: "Main",
            agentType: "main",
            projectContext,
            registry,
            teamRuntime,
            executor,
            contextManager,
            eventBus,
            jobManager,
            memoryService,
            skillService,
            policy,
            approvalService,
            fsAccess,
            sandboxService,
            observabilityConfig: obsConfig,
            maxSteps: runtimeLimits.maxAgentTurns,
            maxToolCalls: runtimeLimits.maxToolCalls,
            maxRunMs: runtimeLimits.maxRunMs,
            printStats: false,
            userMessageRouter,
            mcpManager,
            abortSignal: mainAbortController.signal,
          });

          const summary = obsConfig.consoleSummary
            ? cliPresenter.metricsCollector.formatSummary(Date.now() - runStart)
            : undefined;

          // 平滑过渡至 session-ready，将 Final Response 与 Run Summary 记录至 Transcript 投影
          cliPresenter.stopRun(answer, summary);

          if (!isTTY) {
            terminalUI.renderAgentResponse(answer);
            if (summary) {
              console.log("\n" + summary + "\n");
            }
          }
        } catch (err: unknown) {
          cliPresenter.rollbackRunTransition(err);
          const errorMessage = err instanceof Error ? err.message : String(err);
          if (!isTTY) {
            terminalUI.renderError(errorMessage);
          } else {
            cliPresenter.recordRunComplete(undefined, `Error: ${errorMessage}`);
          }
        } finally {
          userMessageRouter.unregisterAbortController("main");
        }

        // 检查是否存在排队的下一轮用户消息 (Followup Queue)
        if (userMessageRouter.getQueueLength() > 0) {
          const nextFollowup = userMessageRouter.dequeueFollowup();
          cliPresenter.setFollowupCount(userMessageRouter.getQueueLength());
          if (nextFollowup && nextFollowup.content.trim()) {
            activePrompt = nextFollowup.content.trim();
            if (!isTTY) {
              console.log(
                `\n\x1b[36m[Auto-executing queued followup]:\x1b[0m ${activePrompt}\n`
              );
            }
          }
        }
      }
    }
  } finally {
    if (turnRejecter) {
      turnRejecter(new Error("InputManager closed"));
      turnResolver = null;
      turnRejecter = null;
    }
    await jobManager.cleanupSession(contextManager.sessionId);
    await mcpManager.close();
    cliPresenter.destroy();
    inputManager.close();
  }
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
}
