import type { TeamRuntime } from "../team/team-runtime.js";
import { Mailbox } from "../team/mailbox.js";
import { observeRuntimePhase } from "../observability/runtime-phase.js";
import type { ModelUsageSink } from "../observability/model-usage.js";
import type { TraceContextPayload } from "../observability/trace-context.js";
import * as crypto from "node:crypto";
import { getEnvConfig } from "../config/env.js";
import { ModelProtocolError } from "../model/model-adapter.js";
import {
  callChatCompletions,
  streamChatCompletions,
  accumulateChatCompletionStream,
  type ChatMessage,
  type ChatMessageContentPart,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
} from "../model/chat-completions-client.js";
import {
  ToolRegistry,
  ToolExecutor,
  createDefaultToolRegistry,
  type Tool,
  type ToolResult,
  AdaptiveToolExposure,
  createDiscoverToolsTool,
  createActivateToolsTool,
} from "../tools/index.js";
import type {
  HookManager,
  AgentHookContext,
  ModelHookContext,
} from "../middleware/index.js";
import type { SandboxPolicy } from "../sandbox/types.js";
import {
  createDefaultSandboxPolicy,
  createFullCapabilitySandboxPolicy,
} from "../sandbox/policy.js";
import { FileSystemAccess } from "../sandbox/filesystem-access.js";
import { SandboxService } from "../sandbox/sandbox-service.js";
import { withApprovalWaitContext, type ApprovalService } from "../approval/approval-service.js";
import { ContextManager } from "../context/context-manager.js";
import { ConservativeTokenEstimator } from "../context/token-meter.js";
import {
  loadContextConfigFromSettings,
  loadObservabilityConfigFromSettings,
  loadMemoryConfigFromSettings,
  loadSkillConfigFromSettings,
} from "../config/settings.js";
import { getNashModelConfig } from "../config/nash-config.js";
import type { ContextConfig } from "../context/types.js";
import type { ProjectContext } from "../project/project-context.js";
import { resolveProjectContext } from "../project/project-context.js";
import { loadRepositoryInstructions } from "../context/repository-instructions.js";
import { MemoryService } from "../memory/index.js";
import { SkillService } from "../skills/index.js";
import { RunLearningHook } from "../learning/index.js";
import type { MCPManager } from "../mcp/mcp-manager.js";
import {
  PreToolSecurityMonitor,

  SecurityEvaluator,
  ExecutionDependencyDetector,
  type SecurityDecision,
  type SecurityContext,
} from "../security/index.js";
import type {
  ObservabilityConfig,
  EventBus,
  TraceRecorder,
  MetricsCollector,
  OpenTelemetryService,
  InstrumentationService,
} from "../observability/index.js";
import {
  EventBus as DefaultEventBus,
  TraceRecorder as DefaultTraceRecorder,
  MetricsCollector as DefaultMetricsCollector,
  OpenTelemetryService as DefaultOpenTelemetryService,
  InstrumentationService as DefaultInstrumentationService,
  defaultTraceContext,
  redactString,
} from "../observability/index.js";

import { JobManager, type JobRecord } from "../jobs/index.js";
import { ToolLimitError, ExecutionTimeoutError } from "../concurrency/errors.js";
import { AgentInterruptedError } from "../agent/errors.js";
import type { UserMessageRouter } from "../orchestration/user-message-router.js";
import { resolveUserMessageMcpResources } from "../mcp/resource-resolver.js";

/**
 * Agent 默认最大步数，防止陷入无限循环
 */
const DEFAULT_MAX_AGENT_STEPS = 100;
const DEFAULT_MAX_TOOL_CALLS = 200;
const DEFAULT_MAX_RUN_MS = 1_800_000; // 30 分钟

/**
 * 默认 System Prompt（包含基础工具、任务拆解、子代理派发、团队协同与后台 Job 治理指导）
 */
const SYSTEM_PROMPT = `You are Nash Agent, an enterprise-grade autonomous coding assistant with multi-agent orchestration capabilities.

You have access to a rich set of tools across several subsystems:
1. File & Shell Tools:
   - read_file, write_file, edit_file, list_files, grep_search, bash, read_tool_result
   - Prefer dedicated tools for file operations over bash.

2. Task Management Tools:
   - create_task, update_task, complete_task, block_task, list_tasks
   - Use these to break down multi-step tasks, track dependencies, and record deliverables.

3. SubAgent Orchestration:
   - spawn_agent: Use background=true for independent tasks, dispatch them consecutively, then use wait_agent to collect results. Delegate a bounded, independent subtask (e.g. search, review, independent module) to a dedicated sub-agent that executes in isolation.
   - interrupt_agent, list_agents: Manage and monitor active agents.

4. Agent Team Collaboration:
   - spawn_teammate, assign_task, claim_task, send_message, list_team, wait_for_change
   - Use team tools when long-term specialized roles (e.g. architect, devops, security) need to coordinate.
   - When Lead assigns a task with 'assign_task', the assigned teammate is automatically dispatched to execute the task with its own tool context and returns its deliverables. Lead synthesizes and reviews their results rather than performing duplicate work yourself.

5. Plan Mode:
   - enter_plan_mode, propose_plan
   - Use plan mode before major architectural changes to explore read-only, propose a design, and await user approval.

6. Background Job Guidance:
   - For bash commands expected to take significant time (e.g., npm test, build, install, large test suites) and that can run in parallel with other work, prefer background execution (background: true).
   - While background jobs are running, continue working on other tasks that do not depend on their output.
   - Do NOT frequently call job_output to busy-poll. Runtime will automatically notify you via system events when a background job completes.
   - Only use job_output with wait=true when the immediate next step strictly depends on the job result and no other independent work is available.
   - Before presenting the final answer, ensure the final status of all relevant background jobs has been acknowledged.
   - Active jobs that are no longer needed should be explicitly cancelled with job_kill.
   - Do not spawn unnecessary long-running background processes.

7. Persistent Memory & User Preferences:
   - remember: Explicitly persist user persona preferences (e.g. 称谓/人设/妹妹/哥哥), habits, architecture facts, or lessons into long-term memory.
   - search_memory: Look up historical memories and project decisions on demand (Tier 2 Progressive Retrieval).
   - Strict rule: NEVER use write_file to save memory files (such as memory.md). Always use 'remember' to record long-term facts.

8. MCP (Model Context Protocol) Management & Tools:
   - When the user asks to add, configure, inspect, or remove an external MCP server (e.g., "帮我添加这个 MCP: https://..."):
     1. First call 'mcp_propose_add' to probe the endpoint protocol (streamable-http/sse/stdio), capabilities, and authentication requirements.
     2. Explain the discovered configuration, transport, scope, and discovered auth/tools to the user.
     3. Once confirmed or when user supplies needed token, call 'mcp_register' to persist and connect the server. The newly discovered tools will be mounted immediately in the next step without restarting Nash!
     4. Use 'mcp_list_servers', 'mcp_inspect_server', 'mcp_remove_server', 'mcp_set_enabled', 'mcp_reconnect_server' to inspect and manage existing MCP servers.
     5. If multiple external MCP tools are available, you can also use 'search_mcp_tools' to activate specific tools on demand.

Guidelines:
- Communication & Intent: Before calling tools or taking actions, explain in one concise sentence what you are about to do (e.g. "我将检查 write_file 和 edit_file 的实现。"). This intent provides clear user visibility.
- File changes: When modifying several places in one file, send them together in edit_file.edits. A successful edit_file call has already validated every unique match and written the result; do not read the same file again solely to confirm that the edit landed. Read it again only when more context is needed or verification finds a concrete problem.
- For simple or straightforward tasks, execute them directly without unnecessary delegation.
- When delegating independent subtasks or running parallel sweeps, use 'spawn_agent'.
- When coordinating multi-agent workflows, maintain clean task states and do not poll blindly.`;

/**
 * Agent 运行循环的配置项
 */
export interface AgentLoopOptions {
  modelSnapshot?: import("../product/runtime.js").ProductModelContext;
  teamRuntime?: TeamRuntime;
  traceId?: string;
  traceContext?: Partial<TraceContextPayload>;
  modelUsageSink?: ModelUsageSink;
  /**
   * 自定义项目上下文（隔离 Session / Spill / Observability）
   */
  projectContext?: ProjectContext;

  /**
   * 自定义上下文管理器（用于管理 Active Context、Durable Session、Spill Store 与 Compaction）
   */
  contextManager?: ContextManager;

  /**
   * 上下文治理配置项
   */
  contextConfig?: ContextConfig;

  /**
   * 可观测性配置项
   */
  observabilityConfig?: ObservabilityConfig;

  /**
   * 事件总线
   */
  eventBus?: EventBus;

  /**
   * Trace 记录器
   */
  traceRecorder?: TraceRecorder;

  /**
   * 指标收集器
   */
  metricsCollector?: MetricsCollector;

  /**
   * OpenTelemetry 服务
   */
  otelService?: OpenTelemetryService;

  /**
   * 统一 Instrumentation 辅助服务
   */
  instrumentationService?: InstrumentationService;

  /**
   * 是否在终端打印 Run Stats 统计摘要（默认遵从 observability.consoleSummary）
   */
  printStats?: boolean;

  /**
   * 自定义工具注册中心。若传入则优先使用，覆盖 tools 与默认工具集。
   */
  registry?: ToolRegistry;

  /**
   * 自定义工具执行器。若未提供，将基于 registry 自动实例化默认 ToolExecutor。
   */
  executor?: ToolExecutor;

  /**
   * 工具列表。若在未提供 registry 的情况下传入，将自动基于这些工具创建注册中心。
   */
  tools?: Tool[];

  /** Extra task-scoped tools, registered alongside the normal sandboxed tools. */
  additionalTools?: Tool[];

  /**
   * 允许的最大迭代步数，默认为 100。
   */
  maxSteps?: number;

  /**
   * 单次 Run 允许调用的最大工具总次数，默认为 200。
   */
  maxToolCalls?: number;

  /**
   * 单次 Run 允许的最长 Wall-Clock 耗时（毫秒），默认为 1,800,000 (30分钟)。
   */
  maxRunMs?: number;

  /**
   * 后台 Job 管理器
   */
  jobManager?: JobManager;

  /**
   * 生命周期 Hook 管理器
   */
  hookManager?: HookManager;

  /**
   * 沙箱安全策略（当未显式注入 registry/tools 时用于配置默认工具集）
   */
  policy?: SandboxPolicy;

  /**
   * 运行时实时策略读取器。任务级安全授权热升级后，审批门必须读取最新有效策略，
   * 绝不能继续使用任务启动时的快照。
   */
  getPolicy?: () => SandboxPolicy;

  /**
   * 审批服务实例
   */
  approvalService?: ApprovalService;

  /**
   * 统一文件系统访问控制层实例
   */
  fsAccess?: FileSystemAccess;

  /**
   * 进程沙箱服务实例
   */
  sandboxService?: SandboxService;

  /**
   * 当前执行 Agent 的身份标识信息
   */
  agentId?: string;
  agentName?: string;
  agentType?: string;
  parentAgentId?: string;
  taskId?: string;

  /**
   * 工具调用开始时的回调函数
   */
  onToolCallStart?: (toolName: string, rawArgs: string | unknown, metadata?: { toolCallId: string; executionKind?: string }) => void | Promise<void>;

  /**
   * 工具调用结束时的回调函数
   */
  onToolCallEnd?: (toolName: string, result: ToolResult, metadata?: { toolCallId: string; executionKind?: string }) => void | Promise<void>;

  /**
   * 用户运行期消息路由器 (Steer / Queue / Interrupt)
   */
  userMessageRouter?: UserMessageRouter;

  /**
   * 运行期中断信号
   */
  abortSignal?: AbortSignal;

  /**
   * Pre-Tool Security Monitor 独立安全审查中枢
   */
  securityMonitor?: PreToolSecurityMonitor;

  /**
   * 关联的 Cluster 节点、项目与任务上下文 (用于 Security Context 构建)
   */
  nodeId?: string;
  projectId?: string;
  runId?: string;
  nodeType?: "coordinator" | "worker" | "scout" | "subagent" | "team_member" | "main";
  userIntent?: string;
  standingAuthorizations?: string[];
  sessionSummary?: string;

  /**
   * 长期记忆服务实例
   */
  memoryService?: MemoryService;

  /**
   * 技能管理服务实例
   */
  skillService?: SkillService;

  /**
   * MCP 统一管理服务实例
   */
  mcpManager?: MCPManager;

  /**
   * 自定义系统提示词。若提供，将替换默认的系统提示词 SYSTEM_PROMPT。
   */
  systemPrompt?: string;

  /**
   * 是否跳过本地仓库指令与记忆注入（例如纯 Coordinator 模式仅需自身提示词）
   */
  standaloneSystemPrompt?: boolean;
}

/**
 * 运行 Agent 核心循环
 */
export async function runAgentLoop(
  userInput: string | ChatMessageContentPart[],
  options?: AgentLoopOptions
): Promise<string> {
  const { currentModelContext, readProductModels, withProductModels } = await import("../product/runtime.js");
  const snapshot = options?.modelSnapshot ?? currentModelContext() ?? readProductModels();
  return snapshot ? withProductModels(snapshot, () => runAgentLoopBound(userInput, options)) : runAgentLoopBound(userInput, options);
}

async function runAgentLoopBound(userInput: string | ChatMessageContentPart[], options?: AgentLoopOptions): Promise<string> {
  // maxRunMs === 0 表示「不设 Agent 总墙钟」：由 Loop/Tool/Model 限制、通信超时与用户取消共同约束。
  const deadlineMs = options?.maxRunMs ?? DEFAULT_MAX_RUN_MS;
  const deadlineDisabled = deadlineMs === 0;
  const effectiveDeadlineMs = deadlineDisabled ? Number.MAX_SAFE_INTEGER : deadlineMs;
  const deadlineController = new AbortController();
  const runStartedAt = Date.now();
  // 审批等待等「外部输入驱动」的等待必须挂起墙钟：
  // 人机审批不属于 Agent 的执行预算，等待期间不得让 maxRunMs 把整个 Run 判死。
  let pausedAt: number | null = null;
  let pausedTotalMs = 0;
  let approvalWaitCount = 0;
  let deadlineTimer: NodeJS.Timeout | undefined;
  const consumedRunMs = () => {
    const now = Date.now();
    const currentPause = pausedAt !== null ? now - pausedAt : 0;
    return now - runStartedAt - pausedTotalMs - currentPause;
  };
  const armDeadline = (remainingMs: number) => {
    deadlineTimer = setTimeout(
      () => deadlineController.abort(new ExecutionTimeoutError(consumedRunMs(), effectiveDeadlineMs)),
      Math.max(1, Math.min(remainingMs, 2_147_483_647))
    );
    deadlineTimer.unref();
  };
  if (!deadlineDisabled) armDeadline(deadlineMs);
  const pauseRunDeadline = () => {
    if (pausedAt !== null || deadlineController.signal.aborted) return;
    pausedAt = Date.now();
    if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = undefined; }
  };
  const resumeRunDeadline = () => {
    if (pausedAt === null) return;
    pausedTotalMs += Date.now() - pausedAt;
    pausedAt = null;
    if (deadlineController.signal.aborted || deadlineDisabled) return;
    armDeadline(Math.max(1, deadlineMs - consumedRunMs()));
  };
  const runSignal = options?.abortSignal ? AbortSignal.any([options.abortSignal, deadlineController.signal]) : deadlineController.signal;
  options = { ...options, abortSignal: runSignal };
  const ensureRunActive = () => {
    if (deadlineController.signal.aborted) throw deadlineController.signal.reason;
    if (runSignal.aborted) throw new AgentInterruptedError(options?.agentId ?? "main", String(runSignal.reason ?? "用户中断"));
  };
  return withApprovalWaitContext({
    start: () => { if (approvalWaitCount++ === 0) pauseRunDeadline(); },
    end: () => { if (--approvalWaitCount === 0) resumeRunDeadline(); },
  }, async () => {
  try {
  const env = getEnvConfig();
  const hookManager = options?.hookManager;

  const agentId = options?.agentId ?? "main";
  const agentName = options?.agentName ?? (agentId === "main" ? "Main" : agentId);
  const runSecurityMonitor = options?.securityMonitor ?? new PreToolSecurityMonitor();
  const agentType = options?.agentType ?? "main";
  const taskId = options?.taskId;

  // 1. 初始化项目上下文与会话治理
  const projectContext =
    options?.projectContext ??
    options?.contextManager?.getProjectContext() ??
    (await resolveProjectContext());

  const modelConfig = getNashModelConfig();
  const contextConfig =
    options?.contextConfig ?? loadContextConfigFromSettings();

  const contextManager =
    options?.contextManager ??
    new ContextManager({
      projectContext,
      config: contextConfig,
      modelConfig,
    });

  const sessionId = contextManager.sessionId;
  // 每次 runAgentLoop 产生全新的 traceId
  const traceId = options?.traceId ?? crypto.randomUUID();

  // 2. 初始化 Observability 子系统
  const obsConfig =
    options?.observabilityConfig ?? loadObservabilityConfigFromSettings();
  const eventBus = options?.eventBus ?? new DefaultEventBus();
  const traceRecorder =
    options?.traceRecorder ?? new DefaultTraceRecorder(traceId);
  const metricsCollector =
    options?.metricsCollector ?? new DefaultMetricsCollector();

  const otelService =
    options?.otelService ??
    new DefaultOpenTelemetryService({
      config: obsConfig.otel,
      projectId: projectContext.projectId,
      sessionId,
      eventBus,
    });

  const instrumentation =
    options?.instrumentationService ??
    new DefaultInstrumentationService({
      eventBus,
      traceRecorder,
      metricsCollector,
      traceContext: defaultTraceContext,
    });

  // 注入 instrumentation 至 ContextManager，便于捕获 Spill / Compaction 信号
  contextManager.setInstrumentationService(instrumentation);

  // 初始化 Memory 与 Skills 服务
  const memoryConfig = loadMemoryConfigFromSettings();
  const memoryService =
    options?.memoryService ??
    new MemoryService({
      projectContext,
      config: memoryConfig,
      eventBus,
    });

  const skillConfig = loadSkillConfigFromSettings();
  const skillService =
    options?.skillService ??
    new SkillService({
      projectContext,
      config: skillConfig,
      eventBus,
    });

  const loopStartTime = Date.now();
  const loopMonotonicStart = performance.now();

  // 3. 在 TraceContext 上下文边界中执行 Agent Run
  return await defaultTraceContext.run(
    {
      ...defaultTraceContext.get(),
      ...options?.traceContext,
      modelPurpose: "agent",
      runtimeSpanSink: defaultTraceContext.get()?.runtimeSpanSink ?? ((span) => instrumentation.emitEvent("runtime.span", span)),
      modelUsageSink: options?.modelUsageSink ?? defaultTraceContext.get()?.modelUsageSink ?? ((record) => instrumentation.emitEvent("model.usage", record)),
      projectId: projectContext.projectId,
      sessionId,
      traceId,
      agentId,
      agentName,
      agentType,
      taskId,
    },
    async () => observeRuntimePhase("agent_loop", async () => {
      // 启动 root span: agent.run
      const rootSpan = traceRecorder.startSpan({
        name: "agent.run",
        traceId,
        spanId: defaultTraceContext.get()?.spanId,
        parentSpanId: defaultTraceContext.get()?.parentSpanId,
        startTime: loopStartTime,
        attributes: {
          userInput,
          projectId: projectContext.projectId,
          sessionId,
        },
      });

      defaultTraceContext.get()!.spanId = rootSpan.spanId;
      const userInputText =
        typeof userInput === "string"
          ? userInput
          : userInput
              .map((p) => (p.type === "text" ? p.text : "[Image Attachment]"))
              .filter(Boolean)
              .join("\n");

      instrumentation.emitEvent("agent.started", { userInput: userInputText }, { traceId, spanId: rootSpan.spanId });

      // 构建系统提示词与上下文：System > AGENTS.md > Relevant Memory > Available Skills
      let composedSystemPrompt = options?.systemPrompt ?? SYSTEM_PROMPT;
      let progressiveMemory: { prompt?: string; recalledMemories: any[] } = { recalledMemories: [] };

      if (!options?.standaloneSystemPrompt) {
        // 1. 注入仓库官方规则 AGENTS.md (或 CLAUDE.md)
        const repoInstructions = await loadRepositoryInstructions(projectContext.projectRoot);
        if (repoInstructions.hasInstructions && repoInstructions.content) {
          composedSystemPrompt += `\n\n# Repository Instructions (${repoInstructions.sourceFile})\n${repoInstructions.content}`;
        }

        // 2. 渐进式注入持久化记忆 (Tier 1A 核心偏好/人设常驻 + Tier 1B 索引概览 + Tier 2 技术事实动态补充)
        progressiveMemory = await memoryService.getProgressiveMemoryContext(userInputText);
        if (progressiveMemory.prompt) {
          composedSystemPrompt += `\n\n${progressiveMemory.prompt}`;
        }
        if (progressiveMemory.recalledMemories.length > 0) {
          instrumentation.emitEvent(
            "memory.recalled",
            {
              count: progressiveMemory.recalledMemories.length,
              memories: progressiveMemory.recalledMemories,
            },
            { agentId, traceId, spanId: rootSpan.spanId }
          );
        }

        // 3. 注入 Available Skills Level 1 元数据 (受 maxMetadataEntries 限制)
        const availableSkillsPrompt = await skillService.renderAvailableSkillsPrompt(userInputText);
        if (availableSkillsPrompt) {
          composedSystemPrompt += `\n\n# ${availableSkillsPrompt}`;
        }

        // 4. 渐进式注入已连接 MCP Servers 概览 (Tier 1 Catalog，大量工具时按需引导)
        if (options?.mcpManager) {
          const discovery = options.mcpManager.toolDiscovery;
          if (discovery.shouldUseProgressiveDiscovery()) {
            composedSystemPrompt += `\n\n${discovery.generateCatalogSummary()}\n\nNote: Multiple external MCP tools are available. You can use 'search_mcp_tools' to search and activate specific tools on demand.`;
          }
        }
      }

      // 5. 解析用户输入中的 MCP 资源引用 (@server:uri)
      let effectiveUserInput: string | ChatMessageContentPart[] = userInput;
      let effectiveUserInputText = userInputText;
      if (options?.mcpManager && typeof userInputText === "string" && userInputText.includes("@")) {
        const { resolvedInput } = await resolveUserMessageMcpResources(
          userInputText,
          options.mcpManager
        );
        if (resolvedInput !== userInputText) {
          effectiveUserInputText = resolvedInput;
          effectiveUserInput = resolvedInput;
        }
      }

      // 初始化对话上下文
      let messages = await contextManager.buildChatMessages(
        effectiveUserInput,
        composedSystemPrompt
      );

      // 记录用户消息至 Durable Session（关联当前 traceId / spanId）
      await contextManager.recordUserMessage(effectiveUserInputText, {
        traceId,
        spanId: rootSpan.spanId,
        agentId,
        agentType,
      });

      const agentContext: AgentHookContext = {
        userInput: userInputText,
        messages,
        metadata: {
          traceId,
          spanId: rootSpan.spanId,
        },
      };

      // 触发 beforeAgentRun 生命周期钩子
      if (hookManager) {
        await hookManager.execute("beforeAgentRun", agentContext);
      }

      // 订阅后台 Job 完成/失败事件以实现 Step Boundary 注入
      // 关键防重复防护：只有显式后台启动 (backgroundRequested) 或超时提升为后台 (promoted) 的真正异步 Job 才注入通知
      // 前台同步已在 Tool Result 返回的短命令坚决不重复注入，杜绝上下文污染与 KV Cache 膨胀
      const pendingJobNotifications: JobRecord[] = [];
      const unsubscribeJobEvents = eventBus.subscribe("*", (evt: any) => {
        if (
          evt.type === "job.completed" ||
          evt.type === "job.failed" ||
          evt.type === "job.cancelled" ||
          evt.type === "job.timed_out"
        ) {
          const rec = evt.data as JobRecord;
          if (
            rec &&
            (rec.backgroundRequested || rec.promoted) &&
            (rec.ownerAgentId === agentId || agentId === "main" || agentId === "main-agent")
          ) {
            pendingJobNotifications.push(rec);
          }
        }
      });

      try {
        const policy = options?.policy ?? createDefaultSandboxPolicy();
        const fsAccess =
          options?.fsAccess ??
          new FileSystemAccess({
            policy,
            approvalService: options?.approvalService,
            agentId,
          });
        const sandboxService =
          options?.sandboxService ??
          new SandboxService({
            policy,
            approvalService: options?.approvalService,
          });

        const jobManager =
          options?.jobManager ??
          new JobManager({
            eventBus,
            defaultProjectId: projectContext.projectId,
            defaultSessionId: sessionId,
            sandboxService,
          });

        // 初始化工具注册中心与执行器
        let registry: ToolRegistry;
        if (options?.registry) {
          registry = options.registry;
        } else if (options?.tools) {
          registry = new ToolRegistry();
          registry.registerMany(options.tools);
        } else {
          registry = createDefaultToolRegistry({
            fsAccess,
            sandboxService,
            spillStore: contextManager.getSpillStore(),
            jobManager,
            agentId,
            sessionId,
            projectId: projectContext.projectId,
            skillService,
            memoryService,
            mcpManager: options?.mcpManager,
          });
        }

        if (options?.additionalTools) registry.registerMany(options.additionalTools);

        // 初始化自适应工具暴露控制器 (Adaptive Tool Exposure)
        const exposure = new AdaptiveToolExposure(registry, { role: agentType, initialActiveTools: ["read_tool_result", "search_mcp_tools", ...options?.mcpManager?.toolDiscovery.getAlwaysLoadToolNames() ?? []] });
        registry.register(createDiscoverToolsTool(exposure));
        registry.register(createActivateToolsTool(exposure));
        exposure.autoActivateForContext(userInputText);

        const executor =
          options?.executor ?? new ToolExecutor(registry, hookManager);

        const maxSteps = options?.maxSteps ?? DEFAULT_MAX_AGENT_STEPS;
        const maxToolCalls = options?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
        const maxRunMs = options?.maxRunMs ?? DEFAULT_MAX_RUN_MS;

        let step = 0;
        let totalToolCallsCount = 0;
        const executedToolCalls: Array<{
          name: string;
          args: Record<string, unknown> | string;
          result?: string;
          success?: boolean;
        }> = [];
        let lastTestResult: { command: string; passed: boolean; redToGreen?: boolean } | undefined;

        const completeRun = async (finalAnswer: string, reasoningContent = "", reasoningDurationMs = 0): Promise<string> => {
          ensureRunActive();
            await contextManager.recordAssistantMessage(finalAnswer, undefined, {
              traceId,
              spanId: rootSpan.spanId,
              reasoning_content: reasoningContent || undefined,
              reasoningDurationMs,
              recalledMemories: progressiveMemory.recalledMemories.length > 0 ? progressiveMemory.recalledMemories : undefined,
              recalledMemoriesCount: progressiveMemory.recalledMemories.length || undefined,
            });

            messages.push({
              role: "assistant",
              content: finalAnswer,
              reasoning_content: reasoningContent || undefined,
            });
            contextManager.setActiveMessages(messages);
            agentContext.response = finalAnswer;

            // 触发 afterAgentRun 钩子
            if (hookManager) {
              await hookManager.execute("afterAgentRun", agentContext);
            }

            // 触发 Run 结束自动学习与知识沉淀 (Fail-Safe 保证，失败绝不阻断用户任务)
            try {
              const learningHook = new RunLearningHook({
                memoryService,
                skillService,
                projectContext,
              });
              await learningHook.processRun({
                sessionId,
                runId: traceId,
                userInput: userInputText,
                response: finalAnswer,
                toolCalls: executedToolCalls,
                testResults: lastTestResult,
                isError: false,
                metadata: {
                  projectId: projectContext.projectId,
                  agentId,
                },
              });
            } catch {}

            const loopEndTime = Date.now();
            const totalDuration = performance.now() - loopMonotonicStart;

            // 结束 root span 并记录指标
            traceRecorder.endSpan(rootSpan.spanId, {
              status: "ok",
              endTime: loopEndTime,
              durationMs: totalDuration,
            });
            metricsCollector.recordAgentRun(totalDuration, true);
            instrumentation.emitEvent("agent.completed", { durationMs: totalDuration }, { traceId, spanId: rootSpan.spanId });

            // 导出 OTel
            for (const span of traceRecorder.getSpans()) {
              otelService.exportSpan(span);
            }
            otelService.exportMetrics(metricsCollector.getSnapshot());

            // 打印 CLI Run Stats 摘要
            const shouldPrintStats =
              options?.printStats ?? obsConfig.consoleSummary;
            if (shouldPrintStats) {
              console.log("\n" + metricsCollector.formatSummary() + "\n");
            }

            return finalAnswer;
        };

        // 开始 Agent 迭代循环
        while (step < maxSteps) {
          step++;

          // 检查外部中断信号
          if (options?.abortSignal?.aborted) {
            throw new AgentInterruptedError(agentId, String(options.abortSignal.reason ?? "用户中断"));
          }

          // Wall-clock 时间硬限制校验（仅统计真实执行时间，审批等待已挂起）
          if (maxRunMs > 0 && consumedRunMs() > maxRunMs) {
            throw new ExecutionTimeoutError(consumedRunMs(), maxRunMs);
          }

          const team = options?.teamRuntime;
          const mail = team?.claimMessagesForStep(agentId) ?? [];
          if (mail.length && team) {
            const ids = mail.map(message => message.messageId);
            try {
              for (const content of Mailbox.formatForPrompt(mail)) {
                await contextManager.recordUserMessage(content, { traceId, spanId: rootSpan.spanId, source: "team-mailbox" });
                messages.push({ role: "user", content });
              }
              team.mailbox.acknowledgeMessages(agentId, ids);
            } catch (error) { team.mailbox.nackMessages(agentId, ids); throw error; }
          }

          // Step Boundary 检查：注入已完成的后台 Job 通知（作为标准 user 消息注入，杜绝 unmatched tool messages）
          if (pendingJobNotifications.length > 0) {
            const notifications = [...pendingJobNotifications];
            pendingJobNotifications.length = 0;

            for (const rec of notifications) {
              const durationSec = Math.floor((rec.durationMs ?? 0) / 1000);
              const mins = Math.floor(durationSec / 60);
              const secs = durationSec % 60;
              const durationStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

              const rawNotice =
                `[System Event: Background Job Completed]\n` +
                `Job ID: ${rec.id}\n` +
                `Command: ${rec.command}\n` +
                `Status: ${rec.status}\n` +
                `Exit code: ${rec.exitCode ?? "N/A"}\n` +
                `Duration: ${durationStr} (${durationSec}s)\n` +
                `Output summary:\n${rec.resultSummary || "(无输出)"}`;

              const notice = redactString(rawNotice);

              messages.push({
                role: "user",
                content: notice,
              });

              await contextManager.recordUserMessage(notice, {
                traceId,
                spanId: rootSpan.spanId,
                source: "background-job-notification",
              });
            }
          }

          // 上下文准备管线 (Token 测量 -> Prune -> Compaction)
          messages = await contextManager.prepare(messages, runSignal);
          ensureRunActive();

          // 动态获取自适应工具暴露定义（若调用方显式透传指定工具集则尊重全量透传，否则采用自适应收敛模式）
          exposure.activate(options?.mcpManager?.getActivatedToolNames() ?? []);
          const currentToolDefinitions = options?.tools ? registry.getDefinitions() : exposure.getExposedDefinitions();

          const request: ChatCompletionRequest = {
            model: env.model,
            messages,
            tools: env.toolCalling !== false && currentToolDefinitions.length > 0 ? currentToolDefinitions : undefined,
          };

          const modelContext: ModelHookContext = {
            request,
            metadata: {
              traceId,
              parentSpanId: rootSpan.spanId,
            },
          };

          // 触发 beforeModelCall 钩子
          if (hookManager) {
            await hookManager.execute("beforeModelCall", modelContext);
          }

          let response: ChatCompletionResponse;
          let reasoningContent = "";
          let reasoningDurationMs = 0;
          const modelStartTime = performance.now();
          let firstThoughtTime: number | undefined;
          let thoughtEndedTime: number | undefined;

          instrumentation.emitEvent("model.started", {
            model: env.model,
          }, { traceId, spanId: rootSpan.spanId });

          try {
            const streamResult = await instrumentation.runSpan(
              "model.call",
              {
                phase: agentType === "coordinator" && defaultTraceContext.get()?.graphId ? "coordinator_continuation" : "model",
                "gen_ai.system": "openai_compatible",
                "gen_ai.request.model": env.model,
                "gen_ai.request.stream": env.streaming !== false,
              },
              async () => {
                if (env.streaming === false) {
                  const result = await callChatCompletions(env.baseUrl, env.apiKey, request, { signal: runSignal, purpose: "agent", format: env.format, headers: env.headers, timeoutMs: env.timeoutMs });
                  const message = result.choices[0]?.message;
                  if (message?.reasoning_content) instrumentation.emitThoughtDelta(message.reasoning_content, { agentId, model: env.model });
                  if (message?.content) instrumentation.emitContentDelta(message.content, { agentId, model: env.model });
                  return { response: result, reasoning_content: message?.reasoning_content ?? "" };
                }
                const stream = streamChatCompletions(
                  env.baseUrl,
                  env.apiKey,
                  request,
                  { signal: runSignal, purpose: "agent", format: env.format, headers: env.headers, timeoutMs: env.timeoutMs }
                );

                return await accumulateChatCompletionStream(
                  stream,
                  {
                    onThoughtDelta: (delta) => {
                      if (!firstThoughtTime) firstThoughtTime = performance.now();
                      instrumentation.emitThoughtDelta(delta, { agentId, model: env.model });
                    },
                    onContentDelta: (delta) => {
                      if (firstThoughtTime && !thoughtEndedTime) {
                        thoughtEndedTime = performance.now();
                        reasoningDurationMs = Math.max(0, thoughtEndedTime - firstThoughtTime);
                      }
                      instrumentation.emitContentDelta(delta, { agentId, model: env.model });
                    },
                  },
                  runSignal
                );
              }
            );

            response = streamResult.response;
            reasoningContent = streamResult.reasoning_content;
            if (firstThoughtTime && !thoughtEndedTime) {
              thoughtEndedTime = performance.now();
              reasoningDurationMs = Math.max(0, thoughtEndedTime - firstThoughtTime);
            }

            const modelLatency = performance.now() - modelStartTime;
            let inTokens = response.usage?.prompt_tokens ?? 0;
            let outTokens = response.usage?.completion_tokens ?? 0;
            if (inTokens === 0 && outTokens === 0) {
              const estimator = new ConservativeTokenEstimator();
              inTokens = estimator.estimateMessages(request.messages);
              const choice = response.choices[0];
              const asstMsg = choice?.message;
              outTokens = estimator.estimateText(asstMsg?.content ?? "") +
                estimator.estimateText(asstMsg?.reasoning_content ?? "");
              if (asstMsg?.tool_calls) {
                for (const tc of asstMsg.tool_calls) {
                  outTokens += 4 + estimator.estimateText(tc.function.name) + estimator.estimateText(tc.function.arguments);
                }
              }
            }
            const hasUsage = inTokens > 0 || outTokens > 0;
            metricsCollector.recordModelCall(modelLatency, true, inTokens, outTokens);

            // 向 EventBus 发送唯一的 model.completed 事件（携带 Token、思考耗时与指标）
            instrumentation.emitEvent("model.completed", {
              durationMs: modelLatency,
              reasoningDurationMs,
              hasReasoning: Boolean(reasoningContent),
              inTokens,
              outTokens,
              hasUsage: Boolean(response.usage),
              usageSource: response.usage ? "PROVIDER_REPORTED" : "LOCALLY_ESTIMATED",
              modelRequestId: response.id,
              usage: response.usage,
              model: env.model,
            }, { traceId, spanId: rootSpan.spanId, agentId, agentName, agentType });

            modelContext.response = response;

            // 触发 afterModelCall 钩子
            if (hookManager) {
              await hookManager.execute("afterModelCall", modelContext);
            }
          } catch (err: unknown) {
            const modelLatency = performance.now() - modelStartTime;
            metricsCollector.recordModelCall(modelLatency, false);

            const modelError =
              err instanceof Error ? err : new Error(String(err));
            modelContext.error = modelError;

            instrumentation.emitEvent("model.failed", {
              model: env.model,
              error: modelError.message,
              durationMs: modelLatency,
            }, { traceId, spanId: rootSpan.spanId, agentId, agentName, agentType });

            // 触发 onModelError 钩子
            if (hookManager) {
              await hookManager.execute("onModelError", modelContext);
            }
            throw modelError;
          }

          ensureRunActive();
          const choice = response.choices[0];
          const assistantMessage = choice?.message;

          if (!assistantMessage) {
            throw new Error("模型返回了空响应，未包含任何有效消息。");
          }
          if (env.toolCalling === false && assistantMessage.tool_calls?.length) throw new ModelProtocolError("Provider returned tools while tool calling is disabled");

          // 若模型未发起任何工具调用，说明已得出最终答案
          if (
            !assistantMessage.tool_calls ||
            assistantMessage.tool_calls.length === 0
          ) {
            const finalAnswer = assistantMessage.content ?? "";

            // 检查是否存在待注入的 Steer 指令，若有则注入并继续推进循环
            if (options?.userMessageRouter && options.userMessageRouter.hasPendingSteer(agentId)) {
              await contextManager.recordAssistantMessage(finalAnswer, undefined, {
                traceId,
                spanId: rootSpan.spanId,
                reasoning_content: reasoningContent || undefined,
                reasoningDurationMs,
                recalledMemories: progressiveMemory.recalledMemories.length > 0 ? progressiveMemory.recalledMemories : undefined,
                recalledMemoriesCount: progressiveMemory.recalledMemories.length || undefined,
              });
              messages.push({
                role: "assistant",
                content: finalAnswer,
                reasoning_content: reasoningContent || undefined,
              });

              const steers = options.userMessageRouter.drainSteer(agentId);
              for (const s of steers) {
                const steerText = `[User guidance / steer]\n${s.content}`;
                messages.push({
                  role: "user",
                  content: steerText,
                });
                await contextManager.recordUserMessage(steerText, {
                  traceId,
                  spanId: rootSpan.spanId,
                  isSteer: true,
                  steerId: s.id,
                });
                instrumentation.emitEvent("agent.steered", {
                  agentId,
                  steerId: s.id,
                  content: s.content,
                });
              }
              continue;
            }

            return await observeRuntimePhase("final_answer", () => completeRun(finalAnswer, reasoningContent, reasoningDurationMs));
          }

          // 记录包含 tool_calls 的 assistant 消息至 Durable Session
          await contextManager.recordAssistantMessage(
            assistantMessage.content ?? null,
            assistantMessage.tool_calls,
            {
              traceId,
              spanId: rootSpan.spanId,
              reasoning_content: reasoningContent || undefined,
              reasoningDurationMs,
            }
          );

          messages.push({
            role: "assistant",
            content: assistantMessage.content ?? null,
            reasoning_content: reasoningContent || undefined,
            tool_calls: assistantMessage.tool_calls,
          });

          // 遍历并动态分发执行模型请求的所有工具调用
          const executedToolCallIds = new Set<string>();

          // 提取用户意图与最近消息 (构建 Security Context)
          let effectiveUserIntent = options?.userIntent;
          if (!effectiveUserIntent) {
            for (let idx = messages.length - 1; idx >= 0; idx--) {
              const m = messages[idx];
              if (m.role === "user") {
                if (typeof m.content === "string") {
                  effectiveUserIntent = m.content;
                  break;
                } else if (Array.isArray(m.content)) {
                  const textPart = m.content.find((p: any) => p && p.type === "text");
                  if (textPart && "text" in textPart) {
                    effectiveUserIntent = (textPart as any).text;
                    break;
                  }
                }
              }
            }
          }

          const recentUserMessages = messages
            .filter((m) => m.role === "user")
            .map((m) => {
              if (typeof m.content === "string") return m.content;
              if (Array.isArray(m.content)) {
                return m.content
                  .filter((p: any) => p && p.type === "text")
                  .map((p: any) => (p as any).text)
                  .join(" ");
              }
              return JSON.stringify(m.content);
            })
            .slice(-5);

          const securityMonitor = runSecurityMonitor;

          // 为该轮的所有待执行工具分别构建 SecurityContext
          try {
            const securityContexts: SecurityContext[] = assistantMessage.tool_calls.map((tc) => {
              let parsedArgs: Record<string, unknown> = {};
              try {
                parsedArgs = JSON.parse(tc.function.arguments);
              } catch {
                parsedArgs = { _raw: tc.function.arguments };
              }
              const fingerprint = SecurityEvaluator.computeFingerprint(
                tc.function.name,
                tc.function.arguments
              );
              return {
                toolName: tc.function.name,
                executionKind: registry.get(tc.function.name)?.executionKind,
                toolArgs: parsedArgs,
                rawArgs: tc.function.arguments,
                argsFingerprint: fingerprint,
                agentIdentity: {
                  agentId,
                  role: options?.agentType ?? options?.agentName,
                  nodeType: options?.nodeType ?? "worker",
                },
                taskId: options?.taskId,
                runId: options?.runId,
                nodeId: options?.nodeId,
                projectId: options?.projectId ?? projectContext.projectId,
                cwd: projectContext.projectRoot,
                userAuthorizationContext: {
                  userIntent: effectiveUserIntent,
                  recentUserMessages,
                  standingAuthorizations: options?.standingAuthorizations,
                  sessionHistorySummary: options?.sessionSummary,
                },
              };
            });

            // 执行前并行审查该轮所有待执行工具调用 (降低 Wall-Clock 延迟)
            const securityDecisions = await securityMonitor.evaluateParallelToolCalls(securityContexts, runSignal);
            const executedContextsInStep: SecurityContext[] = [];

            for (let toolIndex = 0; toolIndex < assistantMessage.tool_calls.length; toolIndex++) {
              ensureRunActive();
              const toolCall = assistantMessage.tool_calls[toolIndex];
              const securityContext = securityContexts[toolIndex];
              let decision = securityDecisions[toolIndex];
              const toolName = toolCall.function.name;
              const rawArgs = toolCall.function.arguments;

              // 校验参数指纹：保证被审查的参数与实际执行参数严格一致
              const isFingerprintMatch = securityMonitor.verifyFingerprint(
                toolName,
                rawArgs,
                decision.fingerprint
              );
              if (!isFingerprintMatch) {
                // 参数被篡改或发生变化，重新触发安全审查
                decision = await securityMonitor.evaluateToolCall(securityContext, runSignal);
              }

              // 检测前置工具执行副作用引起的依赖时序冲突
              if (toolIndex > 0) {
                const conflict = ExecutionDependencyDetector.detectConflict(
                  securityContext,
                  executedContextsInStep
                );
                if (conflict.hasConflict && conflict.requiresReevaluation) {
                  decision = await securityMonitor.evaluateToolCall(securityContext, runSignal, { bypassCache: true });
                }
              }

              // 判定 1: BLOCK 阻断拦截
              // isHardBlock（确定性硬拦截：破坏性删除、特权文件篡改等）任何人工审批都不得放行，
              // 因此它先于 REQUIRE_APPROVAL 分支生效，禁止被 allow-once 绕过。
              if (decision.verdict === "BLOCK" || decision.isHardBlock) {
                instrumentation.emitEvent("security.blocked", {
                  toolName,
                  category: decision.category,
                  reason: decision.reason,
                  severity: decision.severity,
                });

                const blockResult: ToolResult = {
                  success: false,
                  output: `[Security Monitor: BLOCK] 工具 '${toolName}' 操作被安全审查拦截。原因: ${decision.reason} (威胁分类: ${decision.category || "Safety Violation"})。请调整命令避免访问系统敏感路径，或直接基于已有信息进行分析和总结交付。`,
                  error: `SecurityBlockError: ${decision.reason}`,
                  executionTimeMs: decision.durationMs,
                };

                const processed = await contextManager.processToolResult(
                  toolName,
                  toolCall.id,
                  blockResult
                );

                executedToolCallIds.add(toolCall.id);
                executedToolCalls.push({
                  name: toolName,
                  args: rawArgs,
                  result: blockResult.output,
                  success: false,
                });

                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: processed.content,
                });

                continue;
              }

              // 判定 2: REQUIRE_APPROVAL 需要人机协同审批
              if (decision.verdict === "REQUIRE_APPROVAL") {
                let isApproved = false;
                const approvalMode = (options?.getPolicy?.() ?? options?.policy)?.approval.mode;

                // approval.mode === "never"：不交互、违规即拒绝。
                // 无头/无人值守场景绝不能挂起等待一个永远不会到来的审批。
                if (approvalMode === "never") {
                  securityMonitor.recordDenial(securityContext, decision.reason);
                  instrumentation.emitEvent("security.approval_denied", {
                    toolName,
                    category: decision.category,
                    reason: decision.reason,
                    severity: decision.severity,
                  });
                  const unapprovableResult: ToolResult = {
                    success: false,
                    output: `[Security Monitor: REQUIRE_APPROVAL] 当前沙箱策略为 approval=never，不存在交互式审批通道，已按 Fail-Closed 拒绝执行高风险工具 '${toolName}'。原因: ${decision.reason}`,
                    error: "ApprovalUnavailableError: approval mode is 'never'",
                    executionTimeMs: decision.durationMs,
                  };
                  const processed = await contextManager.processToolResult(toolName, toolCall.id, unapprovableResult);
                  executedToolCallIds.add(toolCall.id);
                  executedToolCalls.push({ name: toolName, args: rawArgs, result: unapprovableResult.output, success: false });
                  messages.push({ role: "tool", tool_call_id: toolCall.id, content: processed.content });
                  continue;
                }

                // auto-grant（完全访问自主模式）：安全审查通过的调用直接放行，不逐次打扰用户。
                // 但「安全审查模型不可用」的 Fail-Closed 升级绝不能被自动放行。
                if (approvalMode === "auto-grant") {
                  if (decision.reviewUnavailable) {
                    securityMonitor.recordDenial(securityContext, decision.reason);
                    instrumentation.emitEvent("security.approval_denied", {
                      toolName,
                      category: decision.category,
                      reason: `安全审查不可用，auto-grant 拒绝自动放行: ${decision.reason}`,
                      severity: decision.severity,
                    });
                    const reviewDownResult: ToolResult = {
                      success: false,
                      output: `[Security Monitor: REQUIRE_APPROVAL] 独立安全审查不可用 (${decision.reason})，当前为 auto-grant 模式但绝不在审查故障时静默放行，已按 Fail-Closed 拒绝工具 '${toolName}'。`,
                      error: "SecurityReviewUnavailableError",
                      executionTimeMs: decision.durationMs,
                    };
                    const processed = await contextManager.processToolResult(toolName, toolCall.id, reviewDownResult);
                    executedToolCallIds.add(toolCall.id);
                    executedToolCalls.push({ name: toolName, args: rawArgs, result: reviewDownResult.output, success: false });
                    messages.push({ role: "tool", tool_call_id: toolCall.id, content: processed.content });
                    continue;
                  }
                  isApproved = true;
                  securityMonitor.grantApproval(securityContext);
                  securityMonitor.consumeApproval(securityContext);
                  for (const capability of ["filesystem-outside-workspace", "filesystem-write", "network"]) {
                    options?.approvalService?.grantPreApproved(`${agentId}::${capability}`, 10000);
                  }
                  instrumentation.emitEvent("security.auto_granted", {
                    toolName,
                    category: decision.category,
                    severity: decision.severity,
                    approvalMode,
                  });
                } else if (options?.approvalService) {
                  // 审批等待期间挂起运行墙钟：等待人不是 Agent 的执行预算。
                  try {
                    const approvalDecision = await options.approvalService.requestApproval(
                      {
                        capability: `security-monitor:${toolName}`,
                        target: rawArgs.slice(0, 300),
                        reason: decision.needsApprovalReason || decision.reason,
                        agentId,
                      },
                      { agentId, signal: runSignal }
                    );
                    if (approvalDecision === "allow-once") {
                      isApproved = true;
                      securityMonitor.grantApproval(securityContext);
                      securityMonitor.consumeApproval(securityContext);
                      // 注入单步预授权，防止底层 FileSystemAccess / SandboxService 触发重复二次弹窗打扰。
                      // 只授权底层真实会申请的三个能力，绝不用 "*" 通配放大一次审批的授权面。
                      for (const capability of ["filesystem-outside-workspace", "filesystem-write", "network"]) {
                        options.approvalService.grantPreApproved(`${agentId}::${capability}`, 10000);
                      }
                    }
                  } catch {
                    isApproved = false;
                  }
                }

                if (!isApproved) {
                  securityMonitor.recordDenial(securityContext, decision.reason);
                  instrumentation.emitEvent("security.approval_denied", {
                    toolName,
                    category: decision.category,
                    reason: decision.reason,
                    severity: decision.severity,
                  });

                  const deniedResult: ToolResult = {
                    success: false,
                    output: `[Security Monitor: REQUIRE_APPROVAL] 用户未批准执行高风险工具 '${toolName}'。原因: ${decision.reason}`,
                    error: "ApprovalDeniedError: 用户未批准执行该高风险操作",
                    executionTimeMs: decision.durationMs,
                  };

                  const processed = await contextManager.processToolResult(
                    toolName,
                    toolCall.id,
                    deniedResult
                  );

                  executedToolCallIds.add(toolCall.id);
                  executedToolCalls.push({
                    name: toolName,
                    args: rawArgs,
                    result: deniedResult.output,
                    success: false,
                  });

                  messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: processed.content,
                  });

                  continue;
                }
              }

              // 判定 3: ALLOW 放行 -> 交付原生 ToolExecutor 执行
              totalToolCallsCount++;
              if (totalToolCallsCount > maxToolCalls) {
                throw new ToolLimitError(totalToolCallsCount, maxToolCalls);
              }

              // 触发可选工具调用开始回调
              if (options?.onToolCallStart) {
                await options.onToolCallStart(toolName, rawArgs, { toolCallId: toolCall.id, executionKind: registry.get(toolName)?.executionKind });
              }

              const toolStartTime = performance.now();
              const toolAbortController = new AbortController();
              options?.userMessageRouter?.registerToolAbortController(agentId, toolAbortController);

              let executionResponse: Awaited<ReturnType<typeof executor.executeToolCall>>;
              let isToolInterrupted = false;

              try {
                executionResponse = await instrumentation.runSpan(
                  `tool.execute:${toolName}`,
                  {
                    toolName,
                    rawArgs,
                    toolCallId: toolCall.id,
                  },
                  async () => {
                    const signal = AbortSignal.any([runSignal, toolAbortController.signal]);
                    const result = await executor.executeToolCall(toolCall, { signal });
                    instrumentation.emitEvent("tool.result", {
                      source: "ToolExecutor", toolCallId: toolCall.id, toolName,
                      success: result.result.success, exitCode: result.result.exitCode,
                      interrupted: result.result.interrupted, error: result.result.error,
                      executionTimeMs: result.result.executionTimeMs,
                    });
                    isToolInterrupted = toolAbortController.signal.aborted || Boolean(result.result.interrupted);
                    return result;
                  },
                  { eventTypePrefix: "tool", resultStatus: response => response.result.success ? "ok" : "error" }
                );

                const toolLatency = performance.now() - toolStartTime;
                metricsCollector.recordToolCall(
                  toolName,
                  toolLatency,
                  executionResponse.result.success
                );
              } catch (err: unknown) {
                const toolLatency = performance.now() - toolStartTime;
                metricsCollector.recordToolCall(toolName, toolLatency, false);
                throw err;
              } finally {
                options?.userMessageRouter?.unregisterToolAbortController(agentId);
              }

              // 触发工具调用结束回调
              if (options?.onToolCallEnd) {
                await options.onToolCallEnd(toolName, executionResponse.result, { toolCallId: toolCall.id, executionKind: registry.get(toolName)?.executionKind });
              }

              // 全链路敏感凭据脱敏处理 (覆盖 read_file、bash/cat 等各类输出)
              if (executionResponse.result.output) {
                executionResponse.result.output = redactString(executionResponse.result.output);
              }

              // 处理 ToolResult
              const processed = await contextManager.processToolResult(
                toolName,
                executionResponse.tool_call_id,
                executionResponse.result
              );

              // 记录已成功执行并持久化的 call_id 与上下文 (供后续步骤进行读写依赖与时序冲突检测)
              executedToolCallIds.add(executionResponse.tool_call_id);
              executedContextsInStep.push(securityContext);
              executedToolCalls.push({
                name: toolName,
                args: rawArgs,
                result: executionResponse.result.output,
                success: executionResponse.result.success,
              });

              // 检查工具是否被用户中断，若被中断则对本轮后续尚未执行的工具调用进行取消合成补偿，并立即跳出工具循环，推进至 Steer 注入
              if (isToolInterrupted) {
                for (const remainingCall of assistantMessage.tool_calls) {
                  if (!executedToolCallIds.has(remainingCall.id)) {
                    const synthResult: ToolResult = {
                      success: false,
                      output: "[Tool execution was cancelled before start due to user interrupt]",
                      executionTimeMs: 0,
                    };
                    const synthProcessed = await contextManager.processToolResult(
                      remainingCall.function.name,
                      remainingCall.id,
                      synthResult
                    );
                    messages.push({
                      role: "tool",
                      tool_call_id: remainingCall.id,
                      content: synthProcessed.content,
                    });
                    executedToolCallIds.add(remainingCall.id);
                  }
                }
                break;
              }

              if (toolName === "bash") {
                const cmdStr = typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as any).command : String(rawArgs);
                if (/(?:test|pytest|npm test|vitest|cargo test|go test)/i.test(cmdStr)) {
                  lastTestResult = {
                    command: cmdStr,
                    passed: executionResponse.result.success,
                  };
                }
              }

              // 将处理后的工具执行结果放入 Active Context
              messages.push({
                role: "tool",
                tool_call_id: executionResponse.tool_call_id,
                content: processed.content,
              });
            }
          } catch (err: unknown) {
            // 协议完整性保障：当中途发生异常或中断时，立即为未执行的 tool_calls 持久化 cancelled synthetic tool_result
            for (const tc of assistantMessage.tool_calls) {
              if (!executedToolCallIds.has(tc.id)) {
                try {
                  const syntheticResult: ToolResult = {
                    success: false,
                    output: `[System] Tool execution was interrupted or cancelled before completion (${
                      err instanceof Error ? err.message : String(err)
                    }).`,
                  };
                  const processed = await contextManager.processToolResult(
                    tc.function.name,
                    tc.id,
                    syntheticResult
                  );
                  messages.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: processed.content,
                  });
                  executedToolCallIds.add(tc.id);
                } catch (persistErr: unknown) {
                  // 审计告警：若补偿写入持久化失败，记录强类型事件与结构化日志，不完全静默
                  instrumentation.emitEvent("session.synthetic_compensation_failed", {
                    toolCallId: tc.id,
                    toolName: tc.function.name,
                    error: persistErr instanceof Error ? persistErr.message : String(persistErr),
                    agentId,
                  }, { traceId, spanId: rootSpan.spanId });

                  // 内存态 Active Context 仍补齐合成消息作为当轮保底
                  messages.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: `[System] Tool execution was interrupted and synthetic persistence encountered error.`,
                  });
                }
              }
            }
            throw err;
          }

          // Step Boundary: 检查并排空属于当前 Agent 的用户 Steer 调整指令
          if (options?.userMessageRouter && options.userMessageRouter.hasPendingSteer(agentId)) {
            const steers = options.userMessageRouter.drainSteer(agentId);
            for (const s of steers) {
              const steerText = `[User guidance / steer]\n${s.content}`;
              messages.push({
                role: "user",
                content: steerText,
              });
              await contextManager.recordUserMessage(steerText, {
                traceId,
                spanId: rootSpan.spanId,
                isSteer: true,
                steerId: s.id,
              });
              instrumentation.emitEvent("agent.steered", {
                agentId,
                steerId: s.id,
                content: s.content,
              });
            }
          }
        }

        // 核心成果挽救与优雅完工：若已执行过实质性工具调用，尝试单轮无工具总结，杜绝成果由于步数超限被粗暴抛弃
        if (executedToolCalls.length > 0) {
          try {
            const summaryPrompt = "当前任务执行步数已达上限。请立即根据前面获取到的全部文件内容、代码结构、日志与探索证据，向用户输出一份完整、严谨、详实的结构化成果与分析总结报告。";
            messages.push({
              role: "user",
              content: summaryPrompt,
            });
            const finalReq: ChatCompletionRequest = {
              model: env.model,
              messages,
              tools: undefined, // 不再提供工具，强迫模型输出最终文本回答
            };
            ensureRunActive();
            await contextManager.recordUserMessage(summaryPrompt, { source: "budget-summary" });
            const finalResp = await callChatCompletions(env.baseUrl, env.apiKey, finalReq, { signal: runSignal });
            const finalContent = finalResp.choices?.[0]?.message?.content;
            if (finalContent && finalContent.trim().length > 0) {
              instrumentation.emitContentDelta(finalContent, { agentId, model: env.model });
              return await observeRuntimePhase("final_answer", () => completeRun(finalContent));
            }
          } catch (error) { ensureRunActive(); }
        }

        throw new Error(
          `Agent 循环步数已达上限 (${maxSteps} 步)，未能生成最终结果。`
        );
      } catch (err: unknown) {
        const loopEndTime = Date.now();
        const totalDuration = performance.now() - loopMonotonicStart;
        const agentError = deadlineController.signal.aborted ? deadlineController.signal.reason as Error
          : runSignal.aborted ? new AgentInterruptedError(agentId, String(runSignal.reason))
          : err instanceof Error ? err : new Error(String(err));

        traceRecorder.endSpan(rootSpan.spanId, {
          status: "error",
          error: agentError,
          endTime: loopEndTime,
          durationMs: totalDuration,
        });
        metricsCollector.recordAgentRun(totalDuration, false);
        instrumentation.emitEvent(
          "agent.failed",
          { durationMs: totalDuration, error: agentError.message },
          { traceId, spanId: rootSpan.spanId }
        );

        // 导出 OTel
        for (const span of traceRecorder.getSpans()) {
          otelService.exportSpan(span);
        }
        otelService.exportMetrics(metricsCollector.getSnapshot());

        agentContext.error = agentError;

        // 触发 onAgentError 钩子
        if (hookManager) {
          await hookManager.execute("onAgentError", agentContext);
        }

        throw agentError;
      } finally {
        unsubscribeJobEvents();
      }
    })
  );
  } finally { clearTimeout(deadlineTimer); }
  });
}
