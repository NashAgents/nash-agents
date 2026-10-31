import { observeRuntimePhase } from "../../observability/runtime-phase.js";
import fs from "node:fs";
import path from "node:path";
import { snapshotWorkspace, isRepeatableTestCommand, type WorkspaceSnapshot } from "./verification-snapshot.js";
import { validateWindowsSandboxRequirements } from "../protocol/sandbox-requirements.js";
import { detectNodeHardwareCapabilities } from "./catalog/hardware-detector.js";
import type { FilesystemMode, NetworkMode, SandboxPolicy } from "../../sandbox/types.js";
import { cloneSandboxPolicy } from "../../sandbox/policy.js";
import { createGraphMessageTool } from "./graph-message-tool.js";
import { MCPManager } from "../../mcp/mcp-manager.js";
import { WorkerGraphArtifacts } from "./graph-artifacts.js";
import type { TaskArtifact } from "../protocol/types.js";
import * as crypto from "node:crypto";
import os from "node:os";
import { runAgentLoop, type AgentLoopOptions } from "../../runtime/agent-loop.js";
import { UserMessageRouter } from "../../orchestration/user-message-router.js";
import { ApprovalService } from "../../approval/approval-service.js";
import { FileSystemAccess } from "../../sandbox/filesystem-access.js";
import { SandboxService } from "../../sandbox/sandbox-service.js";
import {
  createDefaultSandboxPolicy,
  createFullCapabilitySandboxPolicy,
} from "../../sandbox/policy.js";
import { EventBus } from "../../observability/event-bus.js";
import { ContextManager } from "../../context/context-manager.js";
import { resolveProjectContext } from "../../project/project-context.js";
import { getNashModelConfig } from "../../config/nash-config.js";
import { loadContextConfigFromSettings, loadSandboxPolicyFromSettings, loadMemoryConfigFromSettings } from "../../config/settings.js";
import { JobManager } from "../../jobs/job-manager.js";
import type { ProjectRegistry } from "./project-registry.js";
import { WorkerEventForwarder } from "./event-forwarder.js";
import { RemoteApprovalProvider } from "./remote-approval-provider.js";
import type { ExecutionJournal } from "./execution-journal.js";
import type { ClusterEnvelope, TaskDispatchPayload, TaskGrantSecurityPayload } from "../protocol/types.js";
import { createEnvelope, encodeEnvelope } from "../protocol/message-codec.js";
import type { WebSocket } from "ws";
import { ProjectDiscoverySession, DiscoveryEvidenceError } from "../discovery/project-discovery-session.js";
import {
  InspectLocalProjectsTool,
  InspectLocalMcpTool,
} from "../discovery/scout-tools.js";
import { PreToolSecurityMonitor } from "../../security/security-monitor.js";
import type { ReviewLimiter } from "../../security/review-limiter.js";
import { WindowsSandboxProbe } from "../../sandbox/windows/capability-probe.js";
import { withProductModels, type ProductModelContext } from "../../product/runtime.js";
import type { ProductInitInput } from "../../product/types.js";

/**
 * 授权目标策略必须逐字段等于既定提权策略。
 * Worker 侧拒绝任何「别的提权形态」，避免被构造消息引导到非预期模式。
 */
export function validateTaskFullAccessPolicy(policy: SandboxPolicy | undefined): string | undefined {
  if (!policy || typeof policy !== "object") return "Missing target policy";
  const filesystem = policy.filesystem?.mode;
  const network = policy.network?.mode;
  const approval = policy.approval?.mode;
  if (filesystem !== "danger-full-access" || network !== "allow" || approval !== "auto-grant") {
    return `Unexpected grant target policy: filesystem=${String(filesystem)}, network=${String(network)}, approval=${String(approval)}`;
  }
  return undefined;
}

export interface TaskRunnerCallbacks {
  onCompleted?: (finalAnswer: string, durationMs: number) => void;
  onFailed?: (error: string, durationMs: number) => void;
}

export class WorkerTaskRunner {
  private readonly abortController = new AbortController();
  private userMessageRouter?: UserMessageRouter;
  private approvalProvider?: RemoteApprovalProvider;
  private forwarder?: WorkerEventForwarder;
  private readonly modifiedFiles = new Set<string>();
  private readonly executedTests = new Set<string>();
  private testExitCode?: number;
  private totalToolCalls = 0;
  private readonly processExits = new Map<string, number>();
  private producedArtifacts: TaskArtifact[] = [];
  private isRunning = false;
  private jobManager?: JobManager;
  private mcpManager?: MCPManager;
  private fsAccess?: FileSystemAccess;
  private sandboxService?: SandboxService;
  private activeGrant?: TaskGrantSecurityPayload;
  private currentPolicy?: SandboxPolicy;
  private preGrantPolicy?: SandboxPolicy;
  private boundConfigurationVersion?: number;
  private lastCoordinatorVersion?: number;

  constructor(
    private readonly payload: TaskDispatchPayload,
    private readonly projectRegistry: ProjectRegistry,
    private readonly nodeId: string,
    private readonly coordinatorNodeId: string,
    private ws: WebSocket | null,
    private readonly journal?: ExecutionJournal,
    private readonly securityMonitorTimeoutMs?: number,
    private readonly modelSnapshotProvider?: () => ProductModelContext | Promise<ProductModelContext>,
    private readonly policyProvider?: () => ProductInitInput["security"],
    /** 节点级共享的真实安全审查并发限流器 (由 WorkerRuntime 注入，跨任务共享)。 */
    private readonly reviewLimiter?: ReviewLimiter,
    /** 人工审批等待上限；超时后 Worker 主动通知 Coordinator 并 Fail-Closed。 */
    private readonly approvalTimeoutMs?: number,
    /** 安全审查总预算 (含重试与退避)。 */
    private readonly securityReviewTotalTimeoutMs?: number
  ) {}

  get taskId(): string {
    return this.payload.taskId;
  }

  get runId(): string {
    return this.payload.runId;
  }

  setWebSocket(ws: WebSocket | null): void {
    this.ws = ws;
    if (this.forwarder) this.forwarder.setWebSocket(ws);
    if (this.approvalProvider) this.approvalProvider.setWebSocket(ws);
  }

  getForwarder(): WorkerEventForwarder | undefined {
    return this.forwarder;
  }

  getApprovalProvider(): RemoteApprovalProvider | undefined {
    return this.approvalProvider;
  }

  /**
   * 动态应用任务级全访问授权 (TaskSecurityGrant)
   *
   * 作用域严格限定：只影响后续工具调用派生出的进程。
   * 已在运行的进程（后台 Job、已建立的 stdio MCP 子进程）不会被追认提权，
   * ACK 中必须显式声明这一点，禁止把「授权已生效」表述成「整个 Run 已提权」。
   */
  applyTaskSecurityGrant(grant: TaskGrantSecurityPayload): { success: boolean; effectivePolicy?: SandboxPolicy; error?: string } {
    if (!this.isRunning || this.payload.taskId !== grant.taskId || this.payload.runId !== grant.runId || grant.nodeId !== this.nodeId) {
      return { success: false, error: "Task, run or node identity does not match the active execution" };
    }

    if (this.activeGrant?.grantId === grant.grantId) {
      // 重复投递：幂等成功，绝不重复解除审批或重复执行工具。
      return { success: true, effectivePolicy: this.currentPolicy };
    }

    if (this.activeGrant) {
      return { success: false, error: `Task already holds an active grant (${this.activeGrant.grantId})` };
    }

    if (!this.fsAccess || !this.sandboxService || !this.currentPolicy) {
      // 启动窗口内（服务尚未构建）绝不能假装生效：文件/网络/审批三处策略都还没就位。
      return { success: false, error: "Runner sandbox services are not initialized yet; retry after task startup completes" };
    }

    const policyError = validateTaskFullAccessPolicy(grant.targetPolicy);
    if (policyError) return { success: false, error: policyError };

    if (this.boundConfigurationVersion !== undefined && grant.configurationVersion < this.boundConfigurationVersion) {
      return { success: false, error: `Stale grant configuration version ${grant.configurationVersion} < run version ${this.boundConfigurationVersion}` };
    }
    if (this.boundConfigurationVersion !== undefined && this.lastCoordinatorVersion !== undefined && grant.configurationVersion < this.lastCoordinatorVersion) {
      return { success: false, error: `Stale grant configuration version ${grant.configurationVersion} < latest coordinator version ${this.lastCoordinatorVersion}` };
    }

    const previousPolicy = cloneSandboxPolicy(this.currentPolicy);
    let sandboxUpdated = false;
    let fsUpdated = false;
    try {
      // 先升级 OS 沙箱（失败即整体放弃），再升级文件访问判定。
      this.sandboxService.updatePolicy(grant.targetPolicy);
      sandboxUpdated = true;
      this.fsAccess.updatePolicy(grant.targetPolicy);
      fsUpdated = true;

      this.activeGrant = grant;
      this.currentPolicy = cloneSandboxPolicy(grant.targetPolicy);

      this.forwarder?.emitEvent("security.audit", {
        type: "TASK_SECURITY_GRANT_APPLIED",
        grantId: grant.grantId,
        approvalId: grant.approvalId,
        taskId: grant.taskId,
        runId: grant.runId,
        nodeId: this.nodeId,
        authorizedBy: grant.authorizedBy,
        targetPolicy: grant.targetPolicy,
        appliesTo: "subsequent-tool-calls",
        affectsRunningProcesses: false,
        timestamp: Date.now(),
      });

      // 执行边界：原挂起操作以 allow-once 放行一次；后续调用由安全模型审查后自动放行。
      if (this.approvalProvider && grant.approvalId) {
        this.approvalProvider.resolveApproval(grant.approvalId, "allow-once");
      }

      return { success: true, effectivePolicy: this.currentPolicy };
    } catch (err) {
      // 部分生效必须完整回滚，绝不能留下「文件已全访问、网络仍拒绝」的半提权状态。
      if (fsUpdated) { try { this.fsAccess.updatePolicy(previousPolicy); } catch { /* 回滚失败在下方如实上报 */ } }
      if (sandboxUpdated) { try { this.sandboxService.updatePolicy(previousPolicy); } catch { /* 回滚失败在下方如实上报 */ } }
      this.activeGrant = undefined;
      this.currentPolicy = previousPolicy;
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to apply task security grant: ${errorMsg}` };
    }
  }

  /**
   * 撤销任务级全访问授权：恢复到授权前的真实策略。
   * 撤销只会收紧权限，因此任何情况下都可以安全执行。
   */
  revokeTaskSecurityGrant(grantId: string, reason: string): { reverted: boolean; restoredPolicy?: SandboxPolicy; error?: string } {
    if (!this.activeGrant) {
      return { reverted: true, restoredPolicy: this.currentPolicy };
    }
    if (this.activeGrant.grantId !== grantId) {
      return { reverted: false, error: `Active grant ${this.activeGrant.grantId} does not match ${grantId}` };
    }

    // 撤销时恢复到本 Runner 记录的真实起点策略，而不是 Coordinator 的推测值。
    // 若起点策略缺失（理论上不可达），宁可用保守默认值也不保留全访问。
    const target = cloneSandboxPolicy(this.preGrantPolicy ?? createDefaultSandboxPolicy());
    try {
      this.sandboxService?.updatePolicy(target);
      this.fsAccess?.updatePolicy(target);
      this.currentPolicy = target;
      this.activeGrant = undefined;
      this.forwarder?.emitEvent("security.audit", {
        type: "TASK_SECURITY_GRANT_REVOKED",
        grantId,
        taskId: this.payload.taskId,
        runId: this.payload.runId,
        nodeId: this.nodeId,
        reason,
        restoredPolicy: target,
        timestamp: Date.now(),
      });
      return { reverted: true, restoredPolicy: target };
    } catch (err) {
      return { reverted: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  hasActiveGrant(): boolean {
    return Boolean(this.activeGrant);
  }

  getActiveGrant(): TaskGrantSecurityPayload | undefined {
    return this.activeGrant;
  }

  getCurrentPolicy(): SandboxPolicy | undefined {
    return this.currentPolicy;
  }

  /** 记录本次 Run 绑定的配置版本，用于拒绝过期授权。 */
  setBoundConfigurationVersion(version: number | undefined): void {
    if (version !== undefined) this.boundConfigurationVersion = version;
  }

  /** 记录 Coordinator 最新观测到的配置版本。 */
  noteCoordinatorPolicyVersion(version: number | undefined): void {
    if (version !== undefined) this.lastCoordinatorVersion = version;
  }

  /**
   * 启动任务执行循环
   */
  async run(): Promise<void> {
    const { taskId, runId, projectId, goal, prompt, maxSteps, timeoutMs, contextOverrides } = this.payload;
    const startTime = performance.now();
    this.isRunning = true;
    const isDiscovery = Boolean(contextOverrides?.isDiscovery) || goal.includes("Scout 探查任务");
    let lastDiscoveryReportOutput: string | undefined;
    let lastToolOutputSummary: string | undefined;
    try {
      const modelSnapshot = await this.modelSnapshotProvider?.();

      let targetProjectId = projectId;
      let canonicalPath: string | undefined;

      if (isDiscovery && (!projectId || projectId === "discovery" || projectId === "auto")) {
        const projects = this.projectRegistry.listProjects();
        if (projects.length > 0) {
          targetProjectId = projects[0]!.projectId;
        } else {
          const defaultWorkspace = path.join(this.projectRegistry.nashHome, "workspace");
          if (!fs.existsSync(defaultWorkspace)) {
            fs.mkdirSync(defaultWorkspace, { recursive: true, mode: 0o700 });
          }
          canonicalPath = fs.realpathSync(defaultWorkspace);
        }
      }

      if (!canonicalPath) {
        // 1. 本地安全项目校验 (realpath + 防逃逸)
        const projectCheck = this.projectRegistry.resolveAndValidateProject(targetProjectId);
        if (!projectCheck.valid || !projectCheck.canonicalPath) {
          const errReason = projectCheck.reason ?? "Project validation failed";
          this.sendTaskRejected(errReason, "PROJECT_ACCESS_DENIED");
          this.isRunning = false;
          return;
        }
        canonicalPath = projectCheck.canonicalPath;
      }

      // 4. 构建沙箱服务与本地配置策略 (Scout 探查任务只读)
      const policy = await observeRuntimePhase("sandbox_startup", async () => {
        const productPolicy = modelSnapshot?.effectivePolicy ?? this.policyProvider?.();
        const configuredPolicy = productPolicy ? { filesystem: { mode: productPolicy.filesystem }, network: { mode: productPolicy.network }, approval: { mode: productPolicy.approval } } : loadSandboxPolicyFromSettings(undefined, { projectRoot: canonicalPath, nashHome: this.projectRegistry.nashHome });
        const required = contextOverrides?.requiredPolicy as { filesystem?: FilesystemMode; network?: NetworkMode } | undefined;
        if (required?.filesystem && !["read-only", "workspace-write", "full-capability", "danger-full-access"].includes(required.filesystem) ||
            required?.network && !["allow", "deny"].includes(required.network)) {
          this.sendTaskRejected("Invalid requested sandbox policy", "SANDBOX_INCOMPATIBLE"); throw new Error("SANDBOX_INCOMPATIBLE");
        }
        const privilege = { "read-only": 0, "workspace-write": 1, "full-capability": 2, "danger-full-access": 3 };
        if ((required?.filesystem && privilege[required.filesystem] > privilege[configuredPolicy.filesystem.mode]) || (required?.network === "allow" && configuredPolicy.network.mode !== "allow")) {
          this.sendTaskRejected("Requested policy exceeds local authorization", "SANDBOX_INCOMPATIBLE"); throw new Error("SANDBOX_INCOMPATIBLE");
        }
        const resolvedPolicy = {
          ...configuredPolicy,
          filesystem: { mode: isDiscovery || contextOverrides?.operation === "analyze" || contextOverrides?.readOnly ? "read-only" as const : required?.filesystem ?? configuredPolicy.filesystem.mode },
          network: { mode: required?.network ?? configuredPolicy.network.mode },
        };
        if (process.platform === "win32") {
          const capability = detectNodeHardwareCapabilities().find(c => c.category === "sandbox");
          const rejection = validateWindowsSandboxRequirements(capability, resolvedPolicy.filesystem.mode, resolvedPolicy.network.mode);
          if (rejection) { this.sendTaskRejected(rejection.reason, rejection.code); throw new Error(rejection.code); }
        }
        return resolvedPolicy;
      }, { taskId, runId, nodeId: this.nodeId, platform: process.platform });


      // 2. 初始化事件转发器与远程审批提供者
      this.forwarder = new WorkerEventForwarder(taskId, runId, this.nodeId, this.coordinatorNodeId, 500, this.journal?.eventPath(taskId));
      this.forwarder.setWebSocket(this.ws);
      this.forwarder.start();

      // 绑定本地 Security Monitor 审计事件转发至 Coordinator
      const securityMonitor = new PreToolSecurityMonitor({
        timeoutMs: this.securityMonitorTimeoutMs,
        totalTimeoutMs: this.securityReviewTotalTimeoutMs,
        reviewLimiter: this.reviewLimiter,
        auditSink: (auditRecord) => {
          this.forwarder?.emitEvent("security.audit", {
            ...auditRecord,
            nodeId: this.nodeId,
            taskId,
            runId,
          });
        },
      });

      this.approvalProvider = new RemoteApprovalProvider(taskId, runId, this.nodeId, this.coordinatorNodeId, this.approvalTimeoutMs);
      this.approvalProvider.setWebSocket(this.ws);

      // 3. 初始发送 task.accepted 与 task.started
      this.sendTaskAccepted();
      this.sendTaskStarted();
      this.forwarder?.emitEvent("task.started", {
        taskId,
        runId,
        projectId: targetProjectId,
        canonicalPath,
        goal,
        isDiscovery,
      });

      const eventBus = new EventBus();
      const approvalService = new ApprovalService({
        provider: this.approvalProvider,
        eventBus,
        isTTY: false,
      });

      const fsAccess = new FileSystemAccess({ workspaceRoot: canonicalPath, policy, approvalService, eventBus });
      const sandboxService = new SandboxService({ policy, cwd: canonicalPath, approvalService });
      this.currentPolicy = policy;
      this.preGrantPolicy = cloneSandboxPolicy(policy);
      this.setBoundConfigurationVersion(modelSnapshot?.version);
      this.fsAccess = fsAccess;
      this.sandboxService = sandboxService;
      this.jobManager = new JobManager({ eventBus, sandboxService, defaultProjectId: targetProjectId, defaultSessionId: runId });

      this.userMessageRouter = new UserMessageRouter({
        eventBus,
        projectId: targetProjectId,
        jobManager: this.jobManager,
      });

      // 监听本地 EventBus 并转换为 SequencedEvent 转发给 Coordinator
      eventBus.subscribe("*", (event) => {
        const data = event.data as Record<string, any>;
        if (["job.completed", "job.failed"].includes(event.type) && typeof data?.toolCallId === "string" && typeof data?.exitCode === "number") this.processExits.set(data.toolCallId, data.exitCode);
        if (event.type === "file.modified" && typeof data?.path === "string") this.modifiedFiles.add(data.path);
        if (["job.completed", "job.failed"].includes(event.type) && typeof data?.exitCode === "number" && /(?:^|[;&|])\s*(?:npm\s+(?:run\s+)?test|pytest\b|python(?:3)?\s+-m\s+pytest|node\s+--test)/.test(String(data.command))) {
          this.testExitCode = data.exitCode;
          this.executedTests.add(String(data.command).trim());
        }
        const forward = ["model.thought_delta", "model.content_delta"].includes(event.type)
          ? this.forwarder?.queueStreamDelta.bind(this.forwarder) : this.forwarder?.emitEvent.bind(this.forwarder);
        forward?.(event.type, { ...((event.data as Record<string, unknown>) ?? {}),
          traceId: data?.traceId ?? event.traceId, spanId: data?.spanId ?? event.spanId, parentSpanId: data?.parentSpanId ?? event.parentSpanId,
          agentId: event.agentId, graphId: this.payload.graphContext?.graphId,
          graphRevision: this.payload.graphContext?.graphRevision,
          sandboxPolicy: this.currentPolicy ?? policy, workerPlatform: process.platform,
          sandboxBackend: sandboxService.getBackend().name,
        });
      });

      const projectContext = await resolveProjectContext({ projectRoot: canonicalPath, nashHome: this.projectRegistry.nashHome });
      const modelConfig = modelSnapshot?.main ?? getNashModelConfig();
      const contextConfig = loadContextConfigFromSettings(path.join(this.projectRegistry.nashHome, "settings.json"));
      const contextManager = new ContextManager({
        projectContext,
        config: contextConfig,
        modelConfig,
      });

      if (!isDiscovery) {
        this.mcpManager = new MCPManager({ projectRoot: canonicalPath, nashHome: projectContext.nashHome,
          approvalService, eventBus, sandboxService, sandboxPolicy: policy,
          spillStore: contextManager.getSpillStore(), sessionId: contextManager.sessionId });
        await this.mcpManager.initialize();
      }

      const discoverySession = new ProjectDiscoverySession({
        nodeId: this.nodeId, taskId, runId, query: goal, projectRegistry: this.projectRegistry, fsAccess,
        memoryConfig: loadMemoryConfigFromSettings(),
        onPersisted: (report) => this.forwarder?.emitEvent("discovery.report_persisted", { report }),
      });
      const discoveryTools = [discoverySession.readTool, discoverySession.reportTool,
        ...(contextOverrides?.allowUnregisteredScanning === false ? [] : [discoverySession.scanTool])];
      let scoutTools: any[] | undefined;
      if (isDiscovery) {
        scoutTools = [
          new InspectLocalProjectsTool(this.projectRegistry),
          new InspectLocalMcpTool(this.projectRegistry.nashHome),
          ...discoveryTools,
        ];
      }

      const graphArtifacts = this.payload.graphContext ? new WorkerGraphArtifacts(this.payload.graphContext) : undefined;
      const fullPrompt = (prompt ? `${goal}\n\n${prompt}` : goal) + (graphArtifacts?.prompt() ?? "") +
        `\n\nRuntime execution environment (provided by the harness, not model claims): ${JSON.stringify({ nodeId: this.nodeId, taskId, runId, platform: process.platform, arch: process.arch, operatingSystem: { type: os.type(), release: os.release(), version: os.version() }, nodeVersion: process.version, projectRoot: canonicalPath, sandboxBackend: sandboxService.getBackend().name, sandboxPolicy: policy })}.\nThe process tool already runs inside this sandbox. Stay inside the registered project workspace; OS metadata above is supplied by the runtime and does not require reading host files such as /etc/os-release. The sandbox capabilities were independently checked by the harness; do not invent additional boundary probes outside the original authorization. For project environment verification, inspect the registered project's files and existing test scripts. Do not launch nested sandboxes, create OS accounts, install dependencies, or alter host services unless the original goal explicitly authorizes those changes. Preserve actual command failures as evidence; never claim a failed tool succeeded.\n` +
        (this.payload.graphContext && !isDiscovery ? "\n\n当前项目已由 ProjectRegistry 登记且物理路径已校验。常规图内检查、测试和报告任务直接读取项目文件并发布声明的产物；无需重复提交项目发现报告。只有原目标要求发现新项目时才进入发现流程。" : "\n\n项目发现记忆契约：如果本任务发现或确认项目路径与用途，必须使用 read_project_meta 读取该项目的 README.md/pyproject.toml/package.json 等元数据，再调用 submit_discovery_report，提供 canonicalPath、projectName、projectSummary 与真实文件内容 evidences（sourcePath 和 matchedContent）。工具成功后才可声称已保存记忆；发现不授予执行权限。查无登记项目不能推断磁盘上不存在，可使用 scan_local_projects 在常见目录做有界只读搜索；范围不足或审批被拒绝时须说明限制。");
      const testStarts = new Map<string, { command: string; before: WorkspaceSnapshot }>();
      let hasTestSnapshots = false;
      const options: AgentLoopOptions = {
        traceId: this.payload.graphContext?.traceId,
        traceContext: { spanId: this.payload.graphContext?.parentSpanId, conversationId: this.payload.graphContext?.conversationId,
          graphId: this.payload.graphContext?.graphId, graphRevision: this.payload.graphContext?.graphRevision,
          nodeId: this.nodeId, runId, executionAttempt: this.payload.graphContext?.executionAttempt ?? 1 },
        projectContext,
        fsAccess,
        approvalService,
        securityMonitor,
        contextManager,
        eventBus,
        policy,
        getPolicy: () => this.currentPolicy ?? policy,
        sandboxService,
        jobManager: this.jobManager,
        tools: scoutTools,
        additionalTools: [...(!isDiscovery ? discoveryTools : []), ...(graphArtifacts?.tools() ?? []), ...(this.payload.graphContext && this.forwarder ? [createGraphMessageTool({ nodeId: this.nodeId, taskId, graphId: this.payload.graphContext.graphId }, this.forwarder)] : [])],
        systemPrompt: isDiscovery ? fullPrompt : undefined,
        standaloneSystemPrompt: isDiscovery,
        userMessageRouter: this.userMessageRouter,
        abortSignal: this.abortController.signal,
        maxSteps: maxSteps ?? 50,
        maxRunMs: timeoutMs ?? 0,
        printStats: false,
        agentId: isDiscovery ? "scout" : "main",
        agentName: isDiscovery ? "ScoutAgent" : undefined,
        agentType: isDiscovery ? "scout" : "main",
        taskId,
        mcpManager: this.mcpManager,
        onToolCallStart: async (toolName, rawArgs, metadata) => {
          if (metadata?.executionKind === "process") {
            try {
              const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
              if (typeof args?.command === "string" && !args.background && isRepeatableTestCommand(args.command)) {
                hasTestSnapshots = true;
                testStarts.set(metadata.toolCallId, { command: args.command.trim(), before: await snapshotWorkspace(fsAccess) });
              }
            } catch { /* Unsupported evidence remains unresolved; execution policy is unchanged. */ }
          }
          this.totalToolCalls++;
          console.log(`[WorkerTaskRunner:${taskId.slice(0, 8)}] Tool start: ${toolName}`);
        },
        onToolCallEnd: async (toolName, result, metadata) => {
          const started = metadata && testStarts.get(metadata.toolCallId);
          if (started) {
            this.forwarder?.emitEvent("verification.test_execution", { ...started, after: await snapshotWorkspace(fsAccess),
              toolCallId: metadata!.toolCallId, exitCode: typeof result.exitCode === "number" ? result.exitCode : this.processExits.get(metadata!.toolCallId), exitCodeSource: typeof result.exitCode === "number" ? "ToolExecutor" : "bound_JobManager_event", success: result.success, source: "WorkerTaskRunner" });
            testStarts.delete(metadata!.toolCallId);
            this.processExits.delete(metadata!.toolCallId);
          }
          console.log(`[WorkerTaskRunner:${taskId.slice(0, 8)}] Tool end: ${toolName} -> success=${result.success}`);
          if (isDiscovery && toolName === "submit_discovery_report" && result.success) {
            lastDiscoveryReportOutput = result.output;
          }
          if (result.success && result.output && result.output.trim().length > 0) {
            lastToolOutputSummary = result.output;
          }
        },
      };

      // 5. 触发真实 Nash AgentLoop 执行
      let finalAnswer = await runAgentLoop(fullPrompt, { ...options, modelSnapshot });

      if (isDiscovery && !discoverySession.reportTool.getReport()) {
        throw new DiscoveryEvidenceError("Scout finished without an accepted structured report; discovery memory has not been committed.");
      }

      if (isDiscovery && lastDiscoveryReportOutput) finalAnswer = lastDiscoveryReportOutput;

      // 若模型最后一轮输出为空，提取任务执行过程中的有效工具产出保底交付
      if ((!finalAnswer || finalAnswer.trim().length === 0) && (lastDiscoveryReportOutput || lastToolOutputSummary)) {
        finalAnswer = lastDiscoveryReportOutput || `【任务执行产出】\n${lastToolOutputSummary}`;
      }

      if (hasTestSnapshots) this.forwarder?.emitEvent("verification.workspace_final", { snapshot: await snapshotWorkspace(fsAccess), source: "WorkerTaskRunner" });
      this.producedArtifacts = graphArtifacts?.finish(finalAnswer) ?? [];
      await this.jobManager?.cleanupAll();
      const durationMs = performance.now() - startTime;
      this.forwarder?.emitEvent("task.completed", {
        taskId,
        runId,
        finalAnswer,
        producedArtifacts: this.producedArtifacts,
        verificationEvidence: {
          modifiedFiles: [...this.modifiedFiles],
          executedTests: [...this.executedTests],
          testExitCode: this.testExitCode,
          totalToolCalls: this.totalToolCalls,
        },
        durationMs,
      });

      await this.jobManager?.cleanupAll();
      this.sendTaskCompleted(finalAnswer, durationMs);
    } catch (err) {
      await this.jobManager?.cleanupAll();
      const durationMs = performance.now() - startTime;
      const isAborted = this.abortController.signal.aborted;
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Early Exit / 自然完工保护：若 Scout 已提交报告，或常规任务步数达到上限但已产出实质工具结果，不应误判为任务失败
      if (!isAborted && isDiscovery && lastDiscoveryReportOutput) {
        console.log(`[WorkerTaskRunner:${taskId.slice(0, 8)}] Scout 任务已成功提交探查报告，按完成状态正常退出收敛。`);
        this.forwarder?.emitEvent("task.completed", {
          taskId,
          runId,
          finalAnswer: lastDiscoveryReportOutput,
          durationMs,
        });
        this.sendTaskCompleted(lastDiscoveryReportOutput, durationMs);
        return;
      }

      if (isAborted) {
        this.forwarder?.emitEvent("task.cancelled", {
          taskId,
          runId,
          reason: errorMsg,
          durationMs,
        });
        this.sendTaskCancelled(errorMsg);
      } else {
        this.forwarder?.emitEvent("task.failed", {
          taskId,
          runId,
          error: errorMsg,
          partialResult: lastToolOutputSummary,
          durationMs,
        });
        this.sendTaskFailed(errorMsg, durationMs, lastToolOutputSummary);
      }
    } finally {
      await this.jobManager?.cleanupAll();
      await this.mcpManager?.close();
      this.isRunning = false;
      this.forwarder?.stop();
    }
  }

  /**
   * 注入用户 Steer 指令
   */
  steer(content: string): boolean {
    if (!this.isRunning || !this.userMessageRouter) return false;
    this.userMessageRouter.submit(content, "main", "steer");
    this.forwarder?.emitEvent("agent.steered", {
      taskId: this.taskId,
      runId: this.runId,
      content,
    });
    return true;
  }

  acceptsGraphMessage(graphId: string, targetAgentId: string): boolean {
    return this.isRunning && Boolean(this.userMessageRouter) && this.payload.graphContext?.graphId === graphId && targetAgentId === "main";
  }

  /**
   * 中断当前工具执行
   */
  interrupt(): boolean {
    if (!this.isRunning || !this.userMessageRouter) return false;
    const interrupted = this.userMessageRouter.interruptActiveTool("main");
    if (!interrupted) return false;
    this.forwarder?.emitEvent("agent.interrupted", {
      taskId: this.taskId,
      runId: this.runId,
    });
    return true;
  }

  /**
   * 取消整个任务运行
   */
  cancel(reason = "Cancelled by user"): boolean {
    if (!this.isRunning) return false;
    this.abortController.abort(new Error(reason));
    this.approvalProvider?.cancelPending();
    return true;
  }

  private deliverLifecycle(envelope: ClusterEnvelope): void {
    if (["task.completed", "task.failed", "task.cancelled", "task.rejected"].includes(envelope.type)) this.journal?.finish(envelope);
    if (!this.ws || this.ws.readyState !== 1) return;
    try { this.ws.send(encodeEnvelope(envelope)); } catch { /* 已持久化，重连后重送。 */ }
  }

  private sendTaskAccepted(): void {
    const envelope = createEnvelope(
      "task.accepted",
      { taskId: this.taskId, runId: this.runId, nodeId: this.nodeId, acceptedAt: Date.now() },
      this.nodeId,
      this.coordinatorNodeId
    );
    this.deliverLifecycle(envelope);
  }

  private sendTaskStarted(): void {
    const envelope = createEnvelope(
      "task.started",
      { taskId: this.taskId, runId: this.runId, nodeId: this.nodeId, startedAt: Date.now() },
      this.nodeId,
      this.coordinatorNodeId
    );
    this.deliverLifecycle(envelope);
  }

  private sendTaskRejected(reason: string, code: any): void {
    const envelope = createEnvelope(
      "task.rejected",
      { taskId: this.taskId, runId: this.runId, nodeId: this.nodeId, reason, code },
      this.nodeId,
      this.coordinatorNodeId
    );
    this.deliverLifecycle(envelope);
  }

  private sendTaskCompleted(finalAnswer: string, durationMs: number): void {
    const envelope = createEnvelope(
      "task.completed",
      {
        taskId: this.taskId,
        runId: this.runId,
        nodeId: this.nodeId,
        completedAt: Date.now(),
        durationMs,
        finalAnswer,
        totalToolCalls: this.totalToolCalls,
        producedArtifacts: this.producedArtifacts,
        verificationEvidence: {
          modifiedFiles: [...this.modifiedFiles],
          executedTests: [...this.executedTests],
          testExitCode: this.testExitCode,
          totalToolCalls: this.totalToolCalls,
        },
      },
      this.nodeId,
      this.coordinatorNodeId
    );
    this.deliverLifecycle(envelope);
  }

  private sendTaskFailed(error: string, durationMs: number, partialResult?: string): void {
    const envelope = createEnvelope(
      "task.failed",
      {
        taskId: this.taskId,
        runId: this.runId,
        nodeId: this.nodeId,
        failedAt: Date.now(),
        durationMs,
        error,
        isRetryable: false,
        partialResult,
      },
      this.nodeId,
      this.coordinatorNodeId
    );
    this.deliverLifecycle(envelope);
  }

  private sendTaskCancelled(reason: string): void {
    const envelope = createEnvelope(
      "task.cancelled",
      { taskId: this.taskId, runId: this.runId, nodeId: this.nodeId, cancelledAt: Date.now(), reason },
      this.nodeId,
      this.coordinatorNodeId
    );
    this.deliverLifecycle(envelope);
  }
}
