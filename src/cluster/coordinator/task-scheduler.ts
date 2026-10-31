import { observeRuntimePhase } from "../../observability/runtime-phase.js";
import { defaultTraceContext } from "../../observability/trace-context.js";
import { linkGoalRun } from "./goal-run-service.js";
import { validateSandboxRequirements } from "../protocol/sandbox-requirements.js";
import type { FilesystemMode, NetworkMode } from "../../sandbox/types.js";
import * as crypto from "node:crypto";
import { CLUSTER_TASK_TERMINAL, type IClusterStore, type ClusterTaskRecord, type ClusterOutboxRecord, type TaskSecurityGrant } from "../storage/cluster-store.js";
import type { NodeRegistry } from "./node-registry.js";
import { createEnvelope, encodeEnvelope, approvalResolutionMessageId, dispatchMessageId } from "../protocol/message-codec.js";
import type { TaskDispatchPayload, TaskControlPayload, TaskControlAction, TaskControlAckPayload, TaskGrantSecurityPayload, TaskGrantSecurityAckPayload, TaskRevokeSecurityPayload, TaskRevokeSecurityAckPayload } from "../protocol/types.js";

export interface CreateTaskOptions {
  nodeId: string;
  projectId: string;
  goal: string;
  prompt?: string;
  timeoutMs?: number;
  maxSteps?: number;
  contextOverrides?: Record<string, unknown>;
  graphContext?: TaskDispatchPayload["graphContext"];
  beforeDispatch?: (task: ClusterTaskRecord) => Promise<void>;
}

export interface ControlResult {
  success: boolean;
  message: string;
  commandId?: string;
  status?: TaskControlAckPayload["status"] | "timeout";
}

export class TaskScheduler {
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private readonly retries = new Map<string, number>();
  private readonly preparingTasks = new Set<string>();
  private readonly pendingControls = new Map<string, { taskId: string; action: TaskControlAction; finish: (result: ControlResult) => void }>();
  private readonly pendingGrants = new Map<string, (ack: TaskGrantSecurityAckPayload) => void>();
  private readonly pendingRevokes = new Map<string, (ack: TaskRevokeSecurityAckPayload) => void>();

  constructor(
    private readonly store: IClusterStore,
    private readonly registry: NodeRegistry,
    private readonly coordinatorNodeId: string,
    private readonly controlTimeoutMs = 10000,
    private readonly securityReady: () => boolean = () => true,
    /** 准入闸门：返回 true 表示已冻结，禁止创建或分发任何新任务。 */
    private readonly admissionFrozen: () => boolean = () => false
  ) {}

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flushOutbox().catch((err) => console.error("[TaskScheduler] Outbox:", err)); }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const [commandId, pending] of this.pendingControls) {
      pending.finish({ success: false, commandId, status: "failed", message: "Coordinator stopped" });
    }
  }

  async createTask(options: CreateTaskOptions): Promise<ClusterTaskRecord> {
    if (this.admissionFrozen()) throw new Error("ADMISSION_FROZEN: new work is not admitted while the cluster is draining");
    if (!this.securityReady()) throw new Error("SECURITY_APPLY_PENDING: execution is unavailable until the tightened policy is applied");
    let goalId = defaultTraceContext.get()?.goalRunId;
    if (options.graphContext && this.store.listGoalRuns) {
      const matches = (await this.store.listGoalRuns()).filter(goal => goal.linkedGraphIds.includes(options.graphContext!.graphId));
      if (matches.length > 1) throw new Error("Graph belongs to multiple GoalRuns");
      // A graph without persisted ownership is legacy/unknown; the current turn
      // must not silently adopt it during a later replan.
      goalId = matches[0]?.goalRunId;
    }
    if (goalId) options = { ...options, contextOverrides: { ...options.contextOverrides, goalRunId: goalId, taskType: options.graphContext ? "graph_node" : options.contextOverrides?.isDiscovery ? "scout" : "standalone" } };
    // 确定性安全守卫：验证目标节点物理路径与沙箱策略兼容性 (Fail-Closed)
    const node = await this.store.getNode(options.nodeId);
    if (!node) {
      throw new Error(`Target node '${options.nodeId}' does not exist in cluster registry.`);
    }

    const catalogProjects = await this.store.listProjectsCatalog({ nodeId: options.nodeId });
    const project = catalogProjects.find((p) => p.projectId === options.projectId);
    if (project?.canonicalPath) {
      const isWindowsPath = /^[a-zA-Z]:[/\\]/.test(project.canonicalPath);
      if (node.platform === "win32" && !isWindowsPath) {
        const errMsg = `PLATFORM_PATH_MISMATCH: Target node '${options.nodeId}' is win32, but project path '${project.canonicalPath}' is not a Windows absolute path.`;
        await this.recordSecurityBlock(options, errMsg, "PLATFORM_PATH_MISMATCH");
        throw new Error(errMsg);
      }
      if (node.platform !== "win32" && isWindowsPath) {
        const errMsg = `PLATFORM_PATH_MISMATCH: Target node '${options.nodeId}' is ${node.platform}, but project path '${project.canonicalPath}' is a Windows drive path.`;
        await this.recordSecurityBlock(options, errMsg, "PLATFORM_PATH_MISMATCH");
        throw new Error(errMsg);
      }
    }

    const catRev = await this.store.getCatalogRevision(options.nodeId);
    const sandboxCap = (catRev?.capabilities ?? []).find((c) => c.category === "sandbox");
    const details = sandboxCap?.structuredDetails;
    const isReadOnly =
      Boolean(options.contextOverrides?.readOnly) ||
      options.contextOverrides?.operation === "analyze" ||
      options.contextOverrides?.isDiscovery === true;

    const requested = options.contextOverrides?.requiredPolicy as { filesystem?: FilesystemMode; network?: NetworkMode } | undefined;
    const required = { filesystem: requested?.filesystem ?? (isReadOnly ? "read-only" : "workspace-write") as FilesystemMode, network: requested?.network ?? "deny" as NetworkMode };
    if (!["read-only", "workspace-write", "full-capability", "danger-full-access"].includes(required.filesystem) || !["allow", "deny"].includes(required.network)) throw new Error("Invalid sandbox policy");
    options = { ...options, contextOverrides: { ...options.contextOverrides, requiredPolicy: required } };
    {
      const rejection = validateSandboxRequirements(node.platform, sandboxCap, required.filesystem, required.network);
      if (rejection) {
        const message = `${rejection.code}: ${rejection.reason}`;
        await this.recordSecurityBlock(options, message, rejection.code);
        throw new Error(message);
      }
    }

    const taskId = `task-${crypto.randomUUID()}`;
    const runId = `run-${crypto.randomUUID()}`;
    const task: ClusterTaskRecord = {
      taskId, runId, nodeId: options.nodeId, projectId: options.projectId,
      goal: options.goal, prompt: options.prompt, timeoutMs: options.timeoutMs,
      dispatchOptions: { maxSteps: options.maxSteps, contextOverrides: options.contextOverrides, graphContext: options.graphContext },
      status: "created", dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now(),
    };
    const payload: TaskDispatchPayload = {
      taskId, runId, projectId: options.projectId, goal: options.goal, prompt: options.prompt,
      timeoutMs: options.timeoutMs, maxSteps: options.maxSteps, dispatchAttempt: 1,
      connectionGeneration: 0, contextOverrides: options.contextOverrides, graphContext: options.graphContext,
    };
    const envelope = { ...createEnvelope("task.dispatch", payload, this.coordinatorNodeId, options.nodeId), messageId: dispatchMessageId(taskId, runId, 1) };
    const record: ClusterOutboxRecord = {
      targetNodeId: options.nodeId, messageId: envelope.messageId, messageType: "task.dispatch",
      payload, status: "pending", attempts: 0, nextRetryAt: Date.now(), createdAt: Date.now(),
    };
    // 离线与在线使用同一条持久化投递路径，收到 Worker 状态后才退休 Outbox。
    this.preparingTasks.add(taskId);
    try {
      const prepare = async () => {
        const context = options.graphContext;
        if (context) {
          const graph = await this.store.getGraph?.(context.graphId);
          const graphNode = await this.store.getGraphNode?.(context.graphId, context.graphNodeId);
          if (graph?.status !== "running" || (context.graphRevision !== undefined && graph.revision !== context.graphRevision)
            || graphNode?.status !== "ready" || graphNode.taskId) throw new Error("Graph changed before dispatch admission");
        }
      // 图节点的 task_id 是外键；先保存任务，关联与授权全部成功后才能进入 Outbox。
      if (goalId) {
        if (!this.store.saveTaskWithGoal) throw new Error("Atomic GoalRun task storage unavailable");
        // Once a graph exists, its durable state drives node attempts independently of
        // the foreground turn; a completed turn must not expire its running graph.
        await this.store.saveTaskWithGoal(task, goalId, !options.graphContext && defaultTraceContext.get()?.goalRunId === goalId ? defaultTraceContext.get()?.goalTurnFence : undefined);
      } else await this.store.saveTask(task);
      try {
        await options.beforeDispatch?.(task);
      } catch (error) {
        await this.store.updateTaskStatus(taskId, "failed", { error: `Dispatch preparation failed: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      }
      await this.store.enqueueOutbox(record);
      await this.store.updateTaskStatus(taskId, "queued");
      };
      if (options.graphContext && this.store.withGraphLock) await this.store.withGraphLock(options.graphContext.graphId, prepare);
      else await prepare();
    } finally {
      this.preparingTasks.delete(taskId);
    }
    await this.deliver(record);
    return (await this.store.getTask(taskId))!;
  }

  async flushOutbox(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    // 冻结期间停止一切新的任务分发；已在运行的任务所需的审批裁决与 A2A 消息仍要继续投递，
    // 否则等待审批的在途任务会永远无法收敛，排空也就无法成立。
    const dispatchFrozen = this.admissionFrozen();
    try {
      for (const approval of await this.store.listApprovalHistory?.(1000) ?? []) {
        if (approval.status === "resolved" && approval.expiresAt > Date.now()) await this.queueApprovalResolution(approval.approvalId);
      }

      // 补偿 saveTask 与 enqueueOutbox 之间的崩溃窗口；复用已持久化的 run 身份。
      for (const task of dispatchFrozen ? [] : await this.store.listTasks({ status: "created", limit: 200 })) {
        try {
          if (!task.runId || this.preparingTasks.has(task.taskId)) continue;
          if ((await this.store.getTask(task.taskId))?.status !== "created") continue;
          const goalId = task.dispatchOptions?.contextOverrides?.goalRunId;
          // A failed link (lost lease, deleted GoalRun, store hiccup) must not abort the whole pass:
          // the task stays `created` and a later pass retries it under the same run identity.
          if (typeof goalId === "string") await linkGoalRun(this.store, goalId, "task", task.taskId);
          const context = task.dispatchOptions?.graphContext;
          if (context) {
            const node = await this.store.getGraphNode?.(context.graphId, context.graphNodeId);
            if (node?.taskId !== task.taskId) {
              await this.store.updateTaskStatus(task.taskId, "failed", { error: "Dispatch preparation interrupted before graph ownership was persisted" });
              continue;
            }
          }
          const payload: TaskDispatchPayload = { taskId: task.taskId, runId: task.runId, projectId: task.projectId,
            goal: task.goal, prompt: task.prompt, timeoutMs: task.timeoutMs, ...task.dispatchOptions,
            dispatchAttempt: task.dispatchAttempt, connectionGeneration: 0 };
          const messageId = dispatchMessageId(task.taskId, task.runId!, task.dispatchAttempt);
          await this.store.enqueueOutbox({ targetNodeId: task.nodeId, messageId, messageType: "task.dispatch",
            payload, status: "pending", attempts: 0, nextRetryAt: Date.now(), createdAt: Date.now() });
          await this.store.updateTaskStatus(task.taskId, "queued");
        } catch { /* Per-task isolation: one unclaimable task cannot stall dispatch for the rest. */ }
      }
      for (const record of await this.store.pollPendingOutbox(1000)) {
        if (record.messageType === "task.dispatch") { if (!dispatchFrozen) await this.deliver(record); }
        else if (record.messageType === "approval.resolved") await this.deliverApproval(record);
        else if (record.messageType === "agent.message_deliver") await this.deliverAgentMessage(record);
      }
    } finally { this.flushing = false; }
  }

  async queueApprovalResolution(approvalId: string): Promise<void> {
    const approval = await this.store.getApproval(approvalId);
    if (!approval || approval.status !== "resolved" || !approval.decision) return;
    // 任务级全访问授权由 Worker 在执行边界以 allow-once 本地解除，通用审批通道不再重投，
    // 否则会把无法识别的 grant 裁决反复下发并永远等不到 ACK。
    if (approval.decision === "grant-task-full-access") return;
    const record: ClusterOutboxRecord = {
      messageId: approvalResolutionMessageId(approvalId), messageType: "approval.resolved", targetNodeId: approval.nodeId,
      payload: { approvalId, taskId: approval.taskId, runId: approval.runId, decision: approval.decision, resolvedAt: approval.resolvedAt, resolvedBy: approval.resolvedBy },
      status: "pending", attempts: 0, nextRetryAt: Date.now(), createdAt: Date.now(),
    };
    if (await this.store.hasOutboxMessage?.(record.messageId)) return;
    await this.store.enqueueOutbox(record);
  }

  private async deliverAgentMessage(record: ClusterOutboxRecord): Promise<void> {
    const message = record.payload;
    if (message.expiresAt <= Date.now()) {
      await this.store.updateAgentMessageStatus?.(message.messageId, "expired");
      await this.store.markOutboxSent(record.messageId); return;
    }
    if ((this.retries.get(record.messageId) ?? 0) > Date.now()) return;
    const connection = this.registry.getConnection(record.targetNodeId);
    if (!connection || connection.ws.readyState !== 1) return;
    const envelope = createEnvelope("agent.message_deliver", message, this.coordinatorNodeId, record.targetNodeId);
    envelope.messageId = record.messageId;
    this.retries.set(record.messageId, Date.now() + 5000);
    try { connection.ws.send(encodeEnvelope(envelope)); } catch { /* Retained until recipient ACK. */ }
  }

  private async deliverApproval(record: ClusterOutboxRecord): Promise<void> {
    if (!this.securityReady()) return;
    const approval = await this.store.getApproval(record.payload.approvalId);
    const task = await this.store.getTask(record.payload.taskId);
    if (!approval || approval.expiresAt <= Date.now() || (task && CLUSTER_TASK_TERMINAL.has(task.status))) {
      await this.store.markOutboxSent(record.messageId); return;
    }
    if ((this.retries.get(record.messageId) ?? 0) > Date.now()) return;
    const connection = this.registry.getConnection(record.targetNodeId);
    if (!connection || connection.ws.readyState !== 1) return;
    this.retries.set(record.messageId, Date.now() + 5000);
    const envelope = createEnvelope("approval.resolved", record.payload, this.coordinatorNodeId, record.targetNodeId);
    envelope.messageId = record.messageId;
    if (!this.securityReady()) return;
    try { connection.ws.send(encodeEnvelope(envelope)); } catch { /* Retained until Worker ACK. */ }
  }

  private async deliver(record: ClusterOutboxRecord): Promise<void> {
    const context = (record.payload as TaskDispatchPayload).graphContext;
    if (context && this.store.withGraphLock) await this.store.withGraphLock(context.graphId, () => this.deliverLocked(record));
    else await this.deliverLocked(record);
  }

  private async deliverLocked(record: ClusterOutboxRecord): Promise<void> {
    if (!this.securityReady()) return;
    const payload = record.payload as TaskDispatchPayload;
    if (this.preparingTasks.has(payload.taskId)) return;
    const task = await this.store.getTask(payload.taskId);
    if (!task || !["created", "queued", "dispatched"].includes(task.status)) {
      await this.store.markOutboxSent(record.messageId);
      this.retries.delete(record.messageId);
      return;
    }
    if ((this.retries.get(record.messageId) ?? 0) > Date.now()) return;
    const conn = this.registry.getConnection(record.targetNodeId);
    if (!conn || conn.ws.readyState !== 1) return;
    const context = payload.graphContext;
    if (context) {
      const graph = await this.store.getGraph?.(context.graphId);
      const node = await this.store.getGraphNode?.(context.graphId, context.graphNodeId);
      if (!graph || graph.status !== "running" || node?.taskId !== task.taskId) return;
      const edges = (await this.store.listGraphEdges?.(context.graphId) ?? []).filter((e) => e.toNodeId === context.graphNodeId);
      for (const edge of edges) {
        const parent = await this.store.getGraphNode?.(context.graphId, edge.fromNodeId);
        const terminal = parent && ["completed", "failed", "cancelled", "skipped"].includes(parent.status);
        if (parent?.status !== "completed" && !(edge.dependencyType === "completion" && terminal)) return;
      }
      if ((await this.store.listPendingApprovals()).some((a) => a.taskId === task.taskId)) return;
    }
    const envelope = createEnvelope("task.dispatch", { ...payload, connectionGeneration: conn.generation }, this.coordinatorNodeId, record.targetNodeId);
    envelope.messageId = record.messageId;
    this.retries.set(record.messageId, Date.now() + 5000);
    try {
      await this.store.updateTaskStatus(task.taskId, "dispatched");
      await observeRuntimePhase("transport", async () => {
        if (!this.securityReady()) return;
        conn.ws.send(encodeEnvelope(envelope));
      }, { taskId: task.taskId, targetNodeId: record.targetNodeId });
    } catch {
      // 保留同一 task/run/message 身份重投，由 Worker 持久账本防止重复执行。
    }
  }

  handleGrantSecurityAck(ack: TaskGrantSecurityAckPayload): boolean {
    const handler = this.pendingGrants.get(ack.grantId);
    if (!handler) return false;
    handler(ack);
    return true;
  }

  handleRevokeSecurityAck(ack: TaskRevokeSecurityAckPayload): boolean {
    const handler = this.pendingRevokes.get(ack.grantId);
    if (!handler) return false;
    handler(ack);
    return true;
  }

  /**
   * 撤销任务级授权并向 Worker 等待真实 ACK。
   * 超时/离线都只返回失败，绝不视为撤销完成。
   */
  async revokeTaskSecurity(grant: TaskSecurityGrant, reason: string, revokedBy?: string): Promise<{ success: boolean; message?: string; restoredPolicy?: any }> {
    const conn = this.registry.getConnection(grant.nodeId);
    if (!conn || conn.ws.readyState !== 1) {
      return { success: false, message: `Target node ${grant.nodeId} is currently offline; revocation cannot be confirmed` };
    }

    const payload: TaskRevokeSecurityPayload = {
      grantId: grant.grantId,
      taskId: grant.taskId,
      runId: grant.runId,
      nodeId: grant.nodeId,
      reason,
      revokedBy,
    };

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.pendingRevokes.delete(grant.grantId);
          resolve({ success: false, message: "Worker security revocation acknowledgement timed out" });
        }
      }, this.controlTimeoutMs);

      this.pendingRevokes.set(grant.grantId, (ack) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingRevokes.delete(grant.grantId);
        resolve({ success: ack.reverted, message: ack.error, restoredPolicy: ack.restoredPolicy });
      });

      try {
        const envelope = createEnvelope("task.revoke_security", payload, this.coordinatorNodeId, grant.nodeId);
        conn.ws.send(encodeEnvelope(envelope));
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.pendingRevokes.delete(grant.grantId);
          resolve({ success: false, message: String(err) });
        }
      }
    });
  }

  async grantTaskSecurity(grant: TaskSecurityGrant): Promise<{ success: boolean; message?: string; effectivePolicy?: any; timedOut?: boolean }> {
    const conn = this.registry.getConnection(grant.nodeId);
    if (!conn || conn.ws.readyState !== 1) {
      return { success: false, message: `Target node ${grant.nodeId} is currently offline` };
    }

    const payload: TaskGrantSecurityPayload = {
      grantId: grant.grantId,
      approvalId: grant.approvalId,
      taskId: grant.taskId,
      runId: grant.runId,
      nodeId: grant.nodeId,
      targetPolicy: grant.targetPolicy,
      configurationVersion: grant.configurationVersion,
      grantedAt: grant.grantedAt,
      authorizedBy: grant.authorizedBy,
    };

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.pendingGrants.delete(grant.grantId);
          resolve({ success: false, timedOut: true, message: "Worker security grant acknowledgement timed out" });
        }
      }, this.controlTimeoutMs);

      this.pendingGrants.set(grant.grantId, (ack) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingGrants.delete(grant.grantId);
        resolve({
          success: ack.applied,
          message: ack.error,
          effectivePolicy: ack.effectivePolicy,
        });
      });

      try {
        const envelope = createEnvelope("task.grant_security", payload, this.coordinatorNodeId, grant.nodeId);
        conn.ws.send(encodeEnvelope(envelope));
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.pendingGrants.delete(grant.grantId);
          resolve({ success: false, message: String(err) });
        }
      }
    });
  }

  handleControlAck(ack: TaskControlAckPayload): boolean {
    const pending = this.pendingControls.get(ack.commandId);
    if (!pending || pending.taskId !== ack.taskId || pending.action !== ack.action) return false;
    pending.finish({ success: ack.status === "applied" || ack.status === "queued", commandId: ack.commandId,
      status: ack.status, message: ack.message ?? `Worker ${ack.status} ${ack.action}` });
    return true;
  }

  async sendControl(taskId: string, action: TaskControlAction, options?: { steerContent?: string; reason?: string }): Promise<ControlResult> {
    const trace = defaultTraceContext.get();
    const owner = trace?.goalRunId && trace.goalTurnFence ? { goalRunId: trace.goalRunId, fence: trace.goalTurnFence } : undefined;
    if (owner && !this.store.executeGoalTaskControl) throw new Error("Fenced task control is unavailable");
    const task = await this.store.getTask(taskId);
    if (!task) return { success: false, message: `Task ${taskId} not found` };
    // outcome_unknown 表示 Worker 侧结果不可确认：控制命令无法被证实，
    // 必须先在 Worker 账本上对账，绝不产生任何 WS 流量。
    if (task.status === "outcome_unknown") {
      return {
        success: false,
        status: "rejected",
        message: "Task outcome is unknown; control commands cannot be confirmed. Reconcile with the worker ledger first.",
      };
    }
    if (CLUSTER_TASK_TERMINAL.has(task.status)) {
      return { success: action === "cancel", status: "rejected", message: `Task already ${task.status}` };
    }
    if (action === "cancel" && ["created", "queued"].includes(task.status)) {
      if (owner) {
        const changed = await this.store.executeGoalTaskControl!(owner.goalRunId, owner.fence, taskId, "cancelled", options?.reason ?? "Cancelled before dispatch");
        if (!changed) return { success: false, status: "rejected", message: "Task changed before cancellation" };
      } else await this.store.updateTaskStatus(taskId, "cancelled", { error: options?.reason ?? "Cancelled before dispatch" });
      return { success: true, status: "applied", message: "Queued task cancelled" };
    }
    const conn = this.registry.getConnection(task.nodeId);
    if (!conn || conn.ws.readyState !== 1) return { success: false, message: `Target node ${task.nodeId} is currently offline` };
    const commandId = `cmd-${crypto.randomUUID()}`;
    const payload: TaskControlPayload = { commandId, taskId, runId: task.runId, action,
      steerContent: options?.steerContent, reason: options?.reason, timestamp: Date.now() };
    return new Promise<ControlResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish({ success: false, commandId, status: "timeout", message: "Worker acknowledgement timed out; execution state is unconfirmed" }), this.controlTimeoutMs);
      const finish = (result: ControlResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingControls.delete(commandId);
        resolve(result);
      };
      this.pendingControls.set(commandId, { taskId, action, finish });
      void (async () => {
        let sent = false;
        try {
          const send = () => { if (settled) throw new Error("Control timed out before dispatch"); conn.ws.send(encodeEnvelope(createEnvelope("task.control", payload, this.coordinatorNodeId, task.nodeId))); sent = true; };
          if (owner) {
            const admitted = await this.store.executeGoalTaskControl!(owner.goalRunId, owner.fence, taskId, action === "cancel" ? "cancelling" : undefined, undefined, send);
            if (!admitted) { finish({ success: false, commandId, status: "rejected", message: "Task changed before control dispatch" }); return; }
          } else {
            if (action === "cancel") await this.store.updateTaskStatus(taskId, "cancelling");
            send();
          }
        } catch (err) {
          finish({ success: false, commandId, status: sent ? "timeout" : "failed", message: sent ? "Control was sent but its persistence outcome is unknown; reconcile with the Worker." : String(err) });
        }
      })();
    });
  }

  private async recordSecurityBlock(options: CreateTaskOptions, reason: string, ruleName: string): Promise<void> {
    try {
      if (this.store.saveSecurityAudit) {
        await this.store.saveSecurityAudit({
          id: `sec-${crypto.randomUUID()}`,
          timestamp: Date.now(),
          toolName: "task.dispatch",
          argsFingerprint: crypto.createHash("sha256").update(`${options.nodeId}:${options.projectId}`).digest("hex").slice(0, 16),
          sanitizedArgs: { nodeId: options.nodeId, projectId: options.projectId, goal: options.goal },
          rawArgsSnippet: `dispatch target=${options.nodeId} project=${options.projectId}`,
          decisionSource: "DETERMINISTIC_POLICY",
          verdict: "BLOCK",
          severity: 4,
          riskCategory: "SANDBOX_POLICY_VIOLATION",
          ruleName,
          reason,
          agentId: "coordinator-scheduler",
          nodeId: options.nodeId,
          projectId: options.projectId,
          durationMs: 0,
          isHardBlock: true,
          reviewFeedback: { status: "unreviewed" },
          createdAt: Date.now(),
        });
      }
    } catch {}
  }
}
