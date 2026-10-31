import type { TeamRuntime } from "../team/team-runtime.js";
import * as crypto from "node:crypto";
import path from "node:path";
import type { AgentRegistry } from "./agent-registry.js";
import type { ConcurrencyController } from "../concurrency/concurrency-controller.js";
import type { TaskManager } from "../task/task-manager.js";
import type { EventBus } from "../observability/event-bus.js";
import type { ProjectContext } from "../project/project-context.js";
import { resolveProjectContext } from "../project/project-context.js";
import { ContextManager } from "../context/context-manager.js";
import { LocalSessionStore } from "../context/session/local-session-store.js";
import { runAgentLoop, type AgentLoopOptions } from "../runtime/agent-loop.js";
import { AgentNotFoundError, AgentInterruptedError } from "./errors.js";
import type { UserMessageRouter } from "../orchestration/user-message-router.js";
import { createDefaultToolRegistry, type Tool, type ToolRegistry } from "../tools/index.js";
import type { SandboxPolicy } from "../sandbox/types.js";
import type { ApprovalService } from "../approval/approval-service.js";
import { FileSystemAccess } from "../sandbox/filesystem-access.js";
import { SandboxService } from "../sandbox/sandbox-service.js";
import type { HookManager } from "../middleware/index.js";

import type { JobManager } from "../jobs/job-manager.js";

/**
 * 派生 SubAgent 的输入配置
 */
export interface SpawnSubAgentOptions {
  agentId?: string;
  name?: string;
  parentAgentId?: string;
  role?: string;
  roleDescription?: string;
  taskId?: string;
  systemPrompt?: string;
  tools?: Tool[];
  registry?: ToolRegistry;
  policy?: SandboxPolicy;
  approvalService?: ApprovalService;
  fsAccess?: FileSystemAccess;
  sandboxService?: SandboxService;
  jobManager?: JobManager;
  hookManager?: HookManager;
  projectContext?: ProjectContext;
  maxSteps?: number;
  writeScopes?: string[];
  worktreePath?: string;
  yieldParentSlot?: boolean;
  parentSignal?: AbortSignal;
}

/**
 * SubAgent 执行结果结构
 */
export interface SubAgentResult {
  agentId: string;
  success: boolean;
  output: string;
  error?: Error;
  durationMs: number;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface SubAgentRuntimeOptions {
  agentRegistry: AgentRegistry;
  concurrencyController: ConcurrencyController;
  taskManager?: TaskManager;
  eventBus?: EventBus;
  jobManager?: JobManager;
  projectContext?: ProjectContext;
  hookManager?: HookManager;
  approvalService?: ApprovalService;
  policy?: SandboxPolicy;
  fsAccess?: FileSystemAccess;
  sandboxService?: SandboxService;
  userMessageRouter?: UserMessageRouter;
}

/**
 * SubAgent 运行时管理器
 */
export class SubAgentRuntime {
  private readonly agentRegistry: AgentRegistry;
  private readonly concurrencyController: ConcurrencyController;
  private readonly taskManager?: TaskManager;
  private readonly eventBus?: EventBus;
  private readonly jobManager?: JobManager;
  private readonly defaultProjectContext?: ProjectContext;
  private readonly defaultHookManager?: HookManager;
  private readonly defaultApprovalService?: ApprovalService;
  private readonly defaultPolicy?: SandboxPolicy;
  private readonly defaultFsAccess?: FileSystemAccess;
  private readonly defaultSandboxService?: SandboxService;
  private readonly userMessageRouter?: UserMessageRouter;
  private readonly heldSlots = new Set<string>();
  private readonly backgroundRuns = new Map<string, Promise<SubAgentResult>>();
  private teamRuntime?: TeamRuntime;
  setTeamRuntime(team: TeamRuntime): void { this.teamRuntime = team; }

  private readonly abortControllers = new Map<string, AbortController>();

  constructor(options: SubAgentRuntimeOptions) {
    this.agentRegistry = options.agentRegistry;
    this.concurrencyController = options.concurrencyController;
    this.taskManager = options.taskManager;
    this.eventBus = options.eventBus;
    this.jobManager = options.jobManager;
    this.defaultProjectContext = options.projectContext;
    this.defaultHookManager = options.hookManager;
    this.defaultApprovalService = options.approvalService;
    this.defaultPolicy = options.policy;
    this.defaultFsAccess = options.fsAccess;
    this.defaultSandboxService = options.sandboxService;
    this.userMessageRouter = options.userMessageRouter;
  }

  spawnInBackground(prompt: string, options?: SpawnSubAgentOptions): string {
    const agentId = options?.agentId ?? `agent-${crypto.randomUUID().slice(0, 8)}`;
    if (this.backgroundRuns.has(agentId) || this.abortControllers.has(agentId)) throw new Error(`Agent '${agentId}' is already executing`);
    const execution = this.spawn(prompt, { ...options, agentId, yieldParentSlot: false }).catch((error: Error) => ({ agentId, success: false, output: "", error, durationMs: 0 }));
    this.backgroundRuns.set(agentId, execution);
    return agentId;
  }

  async waitForAgent(agentId: string, timeoutMs = 60000, signal?: AbortSignal, callerAgentId?: string): Promise<SubAgentResult | undefined> {
    const execution = this.backgroundRuns.get(agentId);
    if (!execution) throw new AgentNotFoundError(agentId);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const resume = callerAgentId && this.heldSlots.delete(callerAgentId) ? this.concurrencyController.yieldSlot(callerAgentId) : undefined;
    try {
      return await Promise.race([execution, new Promise<undefined>((resolve, reject) => {
        timer = setTimeout(() => resolve(undefined), Math.max(1, Math.min(timeoutMs, 60000)));
        onAbort = () => reject(signal?.reason ?? new AgentInterruptedError(agentId));
        if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (resume) { await resume(); this.heldSlots.add(callerAgentId!); }
    }
  }

  /**
   * 派生并执行一个独立的 SubAgent
   */
  async spawn(
    prompt: string,
    options?: SpawnSubAgentOptions
  ): Promise<SubAgentResult> {
    const parentAgentId = options?.parentAgentId;
    let depth = 1;

    if (parentAgentId) {
      const parent = this.agentRegistry.getAgent(parentAgentId);
      if (parent) {
        depth = parent.depth + 1;
      }
    }

    const existing = options?.agentId ? this.agentRegistry.getAgent(options.agentId) : undefined;
    if (!existing) {
      // 1. 校验并发深度、总量与单 Agent 子节点数限制
      this.concurrencyController.registerAgentSpawn(depth, parentAgentId);
    }

    // 2. 注册或复用 AgentRecord
    const agentRecord = this.agentRegistry.register({
      agentId: options?.agentId,
      name: options?.name ?? existing?.name,
      parentAgentId: parentAgentId ?? existing?.parentAgentId,
      type: existing?.type ?? "subagent",
      depth,
      role: options?.role ?? existing?.role,
      roleDescription: options?.roleDescription ?? existing?.roleDescription,
      worktreePath: options?.worktreePath ?? existing?.worktreePath,
      currentTaskId: options?.taskId,
      status: "running",
    });

    const agentId = agentRecord.agentId;
    const abortController = new AbortController();
    const onParentAbort = () => abortController.abort(options?.parentSignal?.reason);
    options?.parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    if (options?.parentSignal?.aborted) onParentAbort();
    this.abortControllers.set(agentId, abortController);
    this.userMessageRouter?.registerAbortController(agentId, abortController);

    // 若父 Agent 显式指定 yieldParentSlot 或正在挂起等待，让出父槽位以防死锁
    let resumeParentSlot: (() => Promise<void>) | undefined;
    if (options?.yieldParentSlot !== false && parentAgentId && this.heldSlots.delete(parentAgentId)) {
      resumeParentSlot = this.concurrencyController.yieldSlot(parentAgentId);
    }

    // 3. 申请瞬时并发执行槽位 (排队等待 Semaphore)
    let releaseSlot: (() => void) | undefined;
    const startTime = Date.now();
    try {
    releaseSlot = await this.concurrencyController.acquireSlot(abortController.signal, agentId);
    this.heldSlots.add(agentId);
    this.agentRegistry.updateStatus(agentId, "running", {
      currentTaskId: options?.taskId,
    });

    // 原子绑定并认领 Task 所有权
    if (options?.taskId && this.taskManager) {
      try {
        const task = this.taskManager.getTask(options.taskId);
        if (task) {
          this.taskManager.updateTask(task.id, { metadata: { ...task.metadata, delegatedTo: agentId } });
          if (task.status === "ready") {
            this.taskManager.claimTask(options.taskId, agentId, undefined, {
              worktreePath: options.worktreePath,
              workspaceMode: options.worktreePath ? "worktree" : "shared",
            });
          } else {
            this.taskManager.assignTask(options.taskId, agentId, undefined, {
              worktreePath: options.worktreePath,
              workspaceMode: options.worktreePath ? "worktree" : "shared",
            });
          }
        }
      } catch (err: unknown) { throw err; }
    }

      if (abortController.signal.aborted) {
        throw new AgentInterruptedError(agentId, "在进入执行前被中断");
      }

      // 4. 准备独立的 ContextManager 与 Session
      const projectContext =
        options?.projectContext ??
        this.defaultProjectContext ??
        (await resolveProjectContext());

      const contextManager = new ContextManager({
        projectContext,
        sessionStore: new LocalSessionStore({
          sessionsDir: path.join(projectContext.projectDir, "agent-sessions"),
        }),
      });

      // 5. 准备沙箱、文件系统与审批服务（支持审批等待时释放并发槽位）
      const baseApprovalService =
        options?.approvalService ?? this.defaultApprovalService;
      const policy = options?.policy ?? this.defaultPolicy;

      let approvalService = baseApprovalService;
      if (baseApprovalService) {
        approvalService = Object.assign(
          Object.create(Object.getPrototypeOf(baseApprovalService)),
          baseApprovalService,
          {
            requestApproval: (req: any, opt?: any) => {
              return baseApprovalService.requestApproval(
                {
                  ...req,
                  agentId,
                  agentName: options?.name ?? agentId,
                },
                {
                  ...opt,
                  agentId,
                  agentName: options?.name ?? agentId,
                  yieldSlot: () => this.concurrencyController.yieldSlot(agentId),
                }
              );
            },
          }
        );
      }

      const fsAccess =
        options?.fsAccess ??
        (policy
          ? new FileSystemAccess({
              policy,
              workspaceRoot: options?.worktreePath ?? projectContext.projectRoot,
              approvalService,
              agentId,
              writeScopes: options?.writeScopes,
            })
          : this.defaultFsAccess);

      const sandboxService =
        options?.sandboxService ??
        (policy
          ? new SandboxService({
              policy,
              cwd: options?.worktreePath ?? projectContext.projectRoot,
              approvalService,
            })
          : this.defaultSandboxService);

      // 调用核心 AgentLoop 执行独立推理循环
      const roleRegistry = !options?.registry && !options?.tools ? createDefaultToolRegistry({
        role: agentRecord.type === "team-member" ? "member" : "subagent", agentId,
        fsAccess, sandboxService, jobManager: options?.jobManager ?? this.jobManager,
        taskManager: this.taskManager, agentRegistry: this.agentRegistry, subAgentRuntime: this,
        teamRuntime: this.teamRuntime, spillStore: contextManager.getSpillStore(),
        sessionId: contextManager.sessionId, projectId: projectContext.projectId,
      }) : undefined;
      const loopOptions: AgentLoopOptions = {
        agentId,
        agentName: options?.name ?? agentRecord.name ?? agentId,
        agentType: agentRecord.type,
        parentAgentId,
        taskId: options?.taskId,
        projectContext,
        contextManager,
        registry: options?.registry ?? roleRegistry,
        tools: options?.tools,
        policy,
        approvalService,
        fsAccess,
        sandboxService,
        jobManager: options?.jobManager ?? this.jobManager,
        hookManager: options?.hookManager ?? this.defaultHookManager,
        eventBus: this.eventBus,
        maxSteps: options?.maxSteps,
        printStats: false,
        userMessageRouter: this.userMessageRouter,
        teamRuntime: this.teamRuntime,
        abortSignal: abortController.signal,
      };

      const finalOutput = await runAgentLoop(prompt, loopOptions);
      const durationMs = Date.now() - startTime;

      // 6. 更新状态与 Task
      this.agentRegistry.updateStatus(agentId, "completed");

      if (options?.taskId && this.taskManager) {
        try {
          const task = this.taskManager.getTask(options.taskId);
          if (task && (task.status === "running" || task.status === "ready")) {
            this.taskManager.completeTask(
              options.taskId,
              {
                summary: finalOutput.slice(0, 500),
                artifacts: options.worktreePath ? [options.worktreePath] : undefined,
              },
              { agentId }
            );
          }
        } catch (taskErr: unknown) {
          // 仅记录警告，不影响子代理本身的完成状态 (业务执行已成功)
        }
      }

      return {
        agentId,
        success: true,
        output: finalOutput,
        durationMs,
        taskId: options?.taskId,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const error = err instanceof Error ? err : new Error(String(err));
      const isInterrupted = error instanceof AgentInterruptedError;

      const terminalStatus = isInterrupted ? "interrupted" : "failed";
      this.agentRegistry.updateStatus(agentId, terminalStatus, {
        error: {
          code: (error as any).code ?? "SUBAGENT_EXECUTION_ERROR",
          message: error.message,
          stack: error.stack,
        },
      });
      if (error.name === "WriteScopeConflictError") throw error;

      if (options?.taskId && this.taskManager) {
        const task = this.taskManager.getTask(options.taskId);
        if (task && task.status === "running") {
          if (isInterrupted) {
            this.taskManager.blockTask(options.taskId, `SubAgent 中断: ${error.message}`, undefined, { agentId });
          } else {
            this.taskManager.failTask(
              options.taskId,
              { message: error.message, code: (error as any).code },
              { agentId }
            );
          }
        }
      }

      return {
        agentId,
        success: false,
        output: "",
        error,
        durationMs,
        taskId: options?.taskId,
      };
    } finally {
      options?.parentSignal?.removeEventListener("abort", onParentAbort);
      this.abortControllers.delete(agentId);
      this.userMessageRouter?.unregisterAbortController(agentId);
      this.heldSlots.delete(agentId);
      releaseSlot?.();
      if (resumeParentSlot) {
        await resumeParentSlot();
        this.heldSlots.add(parentAgentId!);
      }
    }
  }

  /**
   * 中断指定运行中的 SubAgent
   */
  interrupt(agentId: string, reason?: string): boolean {
    const record = this.agentRegistry.getAgent(agentId);
    if (!record) {
      throw new AgentNotFoundError(agentId);
    }

    const controller = this.abortControllers.get(agentId);
    if (controller) {
      controller.abort(reason);
      this.agentRegistry.updateStatus(agentId, "interrupted", {
        error: {
          code: "AGENT_INTERRUPTED",
          message: reason ?? "用户或父 Agent 中断了子任务",
        },
      });
      return true;
    }

    if (record.status === "running" || record.status === "waiting") {
      this.agentRegistry.updateStatus(agentId, "interrupted", {
        error: {
          code: "AGENT_INTERRUPTED",
          message: reason ?? "显式中断",
        },
      });
      return true;
    }

    return false;
  }
}
