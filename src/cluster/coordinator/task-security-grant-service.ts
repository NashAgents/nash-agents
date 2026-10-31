import * as crypto from "node:crypto";
import type {
  ClusterApprovalRecord,
  ClusterTaskRecord,
  IClusterStore,
  TaskSecurityGrant,
} from "../storage/cluster-store.js";
import type { SandboxPolicy } from "../../sandbox/types.js";
import type { TaskScheduler } from "./task-scheduler.js";
import type { NodeRegistry } from "./node-registry.js";
import type { ProductStore } from "../../product/store.js";
import type {
  TaskGrantSecurityAckPayload,
  TaskRevokeSecurityAckPayload,
} from "../protocol/types.js";
import { WebRequestError } from "./web-security.js";

/**
 * 任务级全访问授权的唯一目标策略。
 * 任何下发给 Worker 的授权都必须逐字段等于该策略，杜绝「提权成别的模式」。
 */
export const TASK_FULL_ACCESS_POLICY: SandboxPolicy = {
  filesystem: { mode: "danger-full-access" },
  network: { mode: "allow" },
  approval: { mode: "auto-grant" },
};

const CONSERVATIVE_POLICY: SandboxPolicy = {
  filesystem: { mode: "workspace-write" },
  network: { mode: "deny" },
  approval: { mode: "ask" },
};

const ACTIVE_GRANT_STATUSES = ["granted", "applied", "revocation_pending"] as const;

export interface GrantActor {
  username: string;
  role?: string;
}

export interface GrantRequestOutcome {
  grantId: string;
  approvalId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  status: TaskSecurityGrant["status"];
  applied: boolean;
  targetPolicy: SandboxPolicy;
  /** 明确告知前端/审计：授权只影响后续工具调用派生出的进程。 */
  appliesTo: "subsequent-tool-calls";
  message: string;
}

export interface RevocationOutcome {
  grantId: string;
  confirmed: boolean;
  status: TaskSecurityGrant["status"];
  message: string;
}

export interface RevokeAllOutcome {
  confirmed: boolean;
  pending: number;
  revoked: number;
  grants: RevocationOutcome[];
}

export interface GrantEligibility {
  canGrant: boolean;
  reason?: string;
  activeGrant?: TaskSecurityGrant | null;
  pendingGrant?: TaskSecurityGrant | null;
}

export interface AuditRecordInput {
  nodeId: string;
  taskId?: string;
  runId?: string;
  projectId?: string;
  agentId: string;
  toolName: string;
  verdict: "ALLOW" | "BLOCK";
  reason: string;
  sanitizedArgs: Record<string, unknown>;
  ruleName: string;
  riskCategory: string;
  decisionSource?: "USER_APPROVAL" | "DETERMINISTIC_POLICY";
}

export interface TaskSecurityGrantServiceOptions {
  store: IClusterStore;
  scheduler: TaskScheduler;
  registry: NodeRegistry;
  productStore?: ProductStore;
  /** 广播审批/授权状态变化（SSE）。 */
  emit?: (type: string, data: Record<string, unknown>) => void;
  /** 任务从 waiting_approval 恢复执行时同步图状态。 */
  onTaskResumed?: (taskId: string) => Promise<void>;
}

/**
 * TaskSecurityGrantService
 *
 * 负责单个 Task/Run 的安全提权生命周期：
 *   authorized admin → 持久化 granted → 下发 Worker → 真实 ACK → applied → 解除原审批
 *   任何一步失败都不会把授权标记为成功，也不会伪造撤销完成。
 *
 * 状态机（CAS 迁移，见 IClusterStore.transitionTaskSecurityGrant）：
 *   granted --ack(applied)--> applied --revoke(ack)--> revoked
 *   granted --ack(rejected)--> revoked
 *   granted/applied --revoke(timeout|offline)--> revocation_pending --revoke(ack)--> revoked
 *   granted/applied --task terminal--> expired
 *   迟到 ACK 永远不能把 revoked/expired 复活。
 */
export class TaskSecurityGrantService {
  private readonly store: IClusterStore;
  private readonly scheduler: TaskScheduler;
  private readonly registry: NodeRegistry;
  private readonly productStore?: ProductStore;
  private readonly emit?: (type: string, data: Record<string, unknown>) => void;
  private readonly onTaskResumed?: (taskId: string) => Promise<void>;

  constructor(options: TaskSecurityGrantServiceOptions) {
    this.store = options.store;
    this.scheduler = options.scheduler;
    this.registry = options.registry;
    this.productStore = options.productStore;
    this.emit = options.emit;
    this.onTaskResumed = options.onTaskResumed;
  }

  // ---------------------------------------------------------------------------
  // 授权
  // ---------------------------------------------------------------------------

  async requestGrant(approvalId: string, actor: GrantActor): Promise<GrantRequestOutcome> {
    if (actor.role !== "admin") throw new WebRequestError(403, "仅管理员有权为任务授予全访问权限");

    const approvalRecord = await this.store.getApproval(approvalId);
    if (!approvalRecord) throw new WebRequestError(404, `审批条目 ${approvalId} 不存在`);

    // 幂等：同一审批只允许产生一个授权。先于 pending 校验，确保重试返回真实状态。
    const existing = await this.store.getTaskSecurityGrantByApproval?.(approvalId);
    if (existing) {
      if (existing.status === "applied") {
        return {
          grantId: existing.grantId, approvalId, taskId: existing.taskId, runId: existing.runId,
          nodeId: existing.nodeId, status: existing.status, applied: true,
          targetPolicy: existing.targetPolicy, appliesTo: "subsequent-tool-calls",
          message: "该审批已授予任务级全访问权限，无需重复操作",
        };
      }
      if (existing.status === "granted") {
        throw new WebRequestError(409, "该审批的授权仍在处理中 (granted)，请稍后刷新确认");
      }
      if (existing.status === "revocation_pending") {
        // 上一次尝试的撤销尚未被确认：先与 Worker 对账，确认撤销后才允许重新授权。
        const reconciled = await this.revokeGrant(existing.grantId, "Reconcile pending revocation before re-granting", actor.username);
        if (!reconciled.confirmed) {
          throw new WebRequestError(409, "上一次授权的撤销尚未被 Worker 确认，暂不能重新授权，请稍后重试");
        }
      }
      if (existing.status === "expired") {
        throw new WebRequestError(409, "该审批的授权已随任务结束而失效，不能再次授权");
      }
      // revoked（Worker 拒绝 / ACK 超时 / 审批竞态）只代表「上一次尝试未生效」：
      // 审批仍是 pending 时允许管理员在同一审批上重新授权，历史授权保留审计记录。
    }

    const approval = await this.requirePendingApproval(approvalId);
    const task = await this.requireRunningTask(approval);

    const activeGrants = await this.store.listTaskSecurityGrants?.({ taskId: task.taskId, runId: approval.runId }) ?? [];
    const blocking = activeGrants.find((grant) => (ACTIVE_GRANT_STATUSES as readonly string[]).includes(grant.status));
    if (blocking) {
      throw new WebRequestError(409, `该 Task/Run 已存在生效或待生效的授权 (${blocking.status})，不能重复提权`);
    }

    if (this.productStore?.pendingSecurityApply()) {
      throw new WebRequestError(503, "全局安全策略正在应用中 (SECURITY_APPLY_PENDING)，暂不能授予任务级全访问权限");
    }

    const connection = this.registry.getConnection(approval.nodeId);
    if (!connection || connection.ws.readyState !== 1) {
      throw new WebRequestError(503, `执行节点 ${approval.nodeId} 当前不在线，无法动态生效授权`);
    }

    const grant: TaskSecurityGrant = {
      grantId: `grant-${crypto.randomUUID()}`,
      approvalId,
      nodeId: approval.nodeId,
      taskId: approval.taskId,
      runId: approval.runId,
      authorizationMode: "task-full-access",
      originalPolicy: this.coordinatorKnownPolicy(),
      targetPolicy: structuredClone(TASK_FULL_ACCESS_POLICY),
      authorizedBy: actor.username,
      grantedAt: Date.now(),
      appliesTo: "subsequent-tool-calls",
      status: "granted",
      configurationVersion: this.configurationVersion(),
    };

    const created = await this.store.saveTaskSecurityGrant?.(grant);
    if (created === false) {
      // 并发请求输给了另一个授权：按幂等语义重新读取。
      const raced = await this.store.getTaskSecurityGrantByApproval?.(approvalId);
      throw new WebRequestError(409, raced?.status === "applied"
        ? "该审批已授予任务级全访问权限"
        : `该审批的授权正在处理中 (${raced?.status ?? "unknown"})`);
    }

    await this.audit({
      nodeId: approval.nodeId, taskId: approval.taskId, runId: approval.runId, projectId: task.projectId,
      agentId: approval.agentId, toolName: approval.toolName ?? "system.grant_security",
      verdict: "ALLOW", ruleName: "TaskSecurityGrantRequested", riskCategory: "Policy Exception Grant",
      reason: `管理员 ${actor.username} 请求仅对 Task/Run 授予全访问权限`,
      sanitizedArgs: { grantId: grant.grantId, approvalId, targetPolicy: grant.targetPolicy, authorizedBy: actor.username },
    });

    const result = await this.scheduler.grantTaskSecurity(grant);

    if (result.success) {
      const applied = await this.store.transitionTaskSecurityGrant?.(grant.grantId, ["granted"], "applied", {
        effectiveAt: Date.now(),
        workerAckAt: Date.now(),
      });
      if (!applied) {
        // 授权在 ACK 期间被撤销：Worker 已提权，必须立即回滚。
        const revoked = await this.forceRevoke(grant, "Grant was revoked while its acknowledgement was in flight", actor.username);
        throw new WebRequestError(409, `授权在确认期间已被撤销，已请求 Worker 回滚 (${revoked.confirmed ? "已确认" : "待确认"})`);
      }

      const resolved = await this.store.resolveApproval(approvalId, "grant-task-full-access", actor.username, grant.grantId);
      if (!resolved) {
        // 审批被其他操作（allow-once / deny / 过期）抢先：不能保留 Worker 上的提权。
        const revoked = await this.forceRevoke(grant, "Approval was resolved by another operation before grant confirmation", actor.username);
        throw new WebRequestError(409, `审批已被其他操作处理，已请求 Worker 回滚任务级授权 (${revoked.confirmed ? "已确认" : "待确认"})`);
      }

      await this.resumeTaskIfUnblocked(approval.taskId);
      this.emit?.("approval.resolved", {
        approvalId, taskId: approval.taskId, runId: approval.runId, nodeId: approval.nodeId,
        decision: "grant-task-full-access", grantId: grant.grantId, resolvedBy: actor.username,
      });
      this.emit?.("task.grant_applied", {
        grantId: grant.grantId, approvalId, taskId: approval.taskId, runId: approval.runId,
        nodeId: approval.nodeId, effectivePolicy: result.effectivePolicy ?? grant.targetPolicy,
        appliesTo: "subsequent-tool-calls", appliedAt: Date.now(),
      });

      return {
        grantId: grant.grantId, approvalId, taskId: approval.taskId, runId: approval.runId,
        nodeId: approval.nodeId, status: "applied", applied: true,
        targetPolicy: grant.targetPolicy, appliesTo: "subsequent-tool-calls",
        message: "任务级全访问授权已由 Worker 确认生效；后续工具调用仍受安全模型审查与硬拦截约束",
      };
    }

    if (!result.timedOut) {
      // Worker 明确拒绝：没有发生提权，可以安全记为 revoked。
      await this.store.transitionTaskSecurityGrant?.(grant.grantId, ["granted"], "revoked", {
        revokedAt: Date.now(), revokedBy: actor.username,
        lastError: result.message ?? "Worker rejected the task security grant",
      });
      throw new WebRequestError(502, `Worker 节点拒绝应用新沙箱策略: ${result.message ?? "未知错误"}；原审批保持待处理`);
    }

    // ACK 超时：Worker 可能已经提权，也可能没有。保守处理为 revocation_pending 并主动回滚。
    await this.store.transitionTaskSecurityGrant?.(grant.grantId, ["granted"], "revocation_pending", {
      lastError: "Worker acknowledgement timed out; applying rollback",
      reconciliationRequired: true,
    });
    const revoked = await this.forceRevoke(grant, "Grant acknowledgement timed out", actor.username);
    this.emit?.("task.grant_unconfirmed", {
      grantId: grant.grantId, approvalId, taskId: approval.taskId, runId: approval.runId,
      nodeId: approval.nodeId, confirmed: revoked.confirmed,
    });
    throw new WebRequestError(
      502,
      revoked.confirmed
        ? "Worker 授权确认超时，已请求回滚并确认撤销；原审批保持待处理，请重试"
        : "Worker 授权确认超时且未能确认回滚；授权状态未知，已标记为待对账，原审批保持待处理",
    );
  }

  // ---------------------------------------------------------------------------
  // Worker ACK（无论是否被 HTTP 等待方消费，都必须做状态收敛）
  // ---------------------------------------------------------------------------

  async handleGrantAck(ack: TaskGrantSecurityAckPayload, consumedByWaiter: boolean): Promise<void> {
    if (consumedByWaiter) return; // requestGrant 的等待方负责持久化
    const grant = await this.store.getTaskSecurityGrant?.(ack.grantId);
    if (!grant) return;
    if (grant.nodeId !== ack.nodeId || grant.taskId !== ack.taskId || grant.runId !== ack.runId || grant.approvalId !== ack.approvalId) {
      return; // 身份不一致：拒绝任何状态变更
    }

    if (ack.applied) {
      if (grant.status === "granted") {
        const applied = await this.store.transitionTaskSecurityGrant?.(grant.grantId, ["granted"], "applied", {
          effectiveAt: ack.appliedAt, workerAckAt: ack.appliedAt,
        });
        if (!applied) return;
        const resolved = await this.store.resolveApproval(grant.approvalId, "grant-task-full-access", grant.authorizedBy, grant.grantId);
        if (!resolved) {
          await this.forceRevoke(grant, "Approval no longer pending when grant acknowledgement arrived", "system");
          return;
        }
        await this.resumeTaskIfUnblocked(grant.taskId);
        this.emit?.("approval.resolved", {
          approvalId: grant.approvalId, taskId: grant.taskId, runId: grant.runId, nodeId: grant.nodeId,
          decision: "grant-task-full-access", grantId: grant.grantId, resolvedBy: grant.authorizedBy,
        });
        this.emit?.("task.grant_applied", {
          grantId: grant.grantId, approvalId: grant.approvalId, taskId: grant.taskId, runId: grant.runId,
          nodeId: grant.nodeId, effectivePolicy: ack.effectivePolicy ?? grant.targetPolicy,
          appliesTo: "subsequent-tool-calls", appliedAt: ack.appliedAt,
        });
        return;
      }
      // 迟到 ACK：授权已被撤销 / 待对账 / 随任务结束失效，但 Worker 说它生效了
      // → 立即再回滚，绝不复活。
      if (grant.status === "revocation_pending" || grant.status === "revoked" || grant.status === "expired") {
        this.emit?.("task.grant_late_ack", {
          grantId: grant.grantId, taskId: grant.taskId, runId: grant.runId, nodeId: grant.nodeId,
        });
        await this.scheduler.revokeTaskSecurity(grant, "Late grant acknowledgement after revocation", "system");
      }
      return;
    }

    // Worker 拒绝或自撤销：只允许从 granted / applied / revocation_pending 收敛。
    await this.store.transitionTaskSecurityGrant?.(grant.grantId, ["granted", "applied", "revocation_pending"], "revoked", {
      revokedAt: ack.appliedAt, revokedBy: grant.authorizedBy, lastError: ack.error ?? "Worker reported the grant is not applied",
    });
  }

  async handleRevokeAck(ack: TaskRevokeSecurityAckPayload, consumedByWaiter: boolean): Promise<void> {
    if (consumedByWaiter) return;
    const grant = await this.store.getTaskSecurityGrant?.(ack.grantId);
    if (!grant) return;
    if (grant.nodeId !== ack.nodeId || grant.taskId !== ack.taskId || grant.runId !== ack.runId) return;
    if (!ack.reverted) return;
    const changed = await this.store.transitionTaskSecurityGrant?.(grant.grantId,
      ["granted", "applied", "revocation_pending"], "revoked", {
        revokedAt: ack.revokedAt, revokedBy: "system", reconciliationRequired: false,
      });
    if (changed) {
      this.emit?.("task.grant_revoked", { grantId: grant.grantId, taskId: grant.taskId, runId: grant.runId, nodeId: grant.nodeId });
    }
  }

  // ---------------------------------------------------------------------------
  // 撤销
  // ---------------------------------------------------------------------------

  /**
   * 撤销单个授权。只有收到 Worker 真实 ACK 才算 revoked；
   * 离线或超时只收敛为 revocation_pending，绝不假装撤销完成。
   */
  async revokeGrant(grantId: string, reason: string, revokedBy = "system"): Promise<RevocationOutcome> {
    const grant = await this.store.getTaskSecurityGrant?.(grantId);
    if (!grant) return { grantId, confirmed: false, status: "revoked", message: "Grant not found" };

    if (grant.status === "revoked" || grant.status === "expired") {
      return { grantId, confirmed: true, status: grant.status, message: "Grant already inactive" };
    }

    const nodeOnline = this.isNodeOnline(grant.nodeId);
    if (!nodeOnline) {
      if (grant.status === "granted") {
        // 从未 ACK，且节点离线：授权消息不会被重投（Worker 推送模型），永远不会生效。
        const changed = await this.store.transitionTaskSecurityGrant?.(grantId, ["granted"], "revoked", {
          revokedAt: Date.now(), revokedBy, lastError: "Node offline before acknowledgement; grant was never applied",
        });
        return { grantId, confirmed: true, status: changed ? "revoked" : grant.status, message: "Grant never acknowledged and node is offline" };
      }
      await this.store.transitionTaskSecurityGrant?.(grantId, ["applied"], "revocation_pending", {
        lastError: "Node offline; revocation cannot be confirmed", reconciliationRequired: true,
      });
      return { grantId, confirmed: false, status: "revocation_pending", message: "Node offline; revocation pending reconciliation" };
    }

    const result = await this.scheduler.revokeTaskSecurity(grant, reason, revokedBy);
    if (result.success) {
      const changed = await this.store.transitionTaskSecurityGrant?.(grantId,
        ["granted", "applied", "revocation_pending"], "revoked", {
          revokedAt: Date.now(), revokedBy, reconciliationRequired: false, lastError: undefined,
        });
      if (changed) {
        this.emit?.("task.grant_revoked", { grantId, taskId: grant.taskId, runId: grant.runId, nodeId: grant.nodeId });
        await this.audit({
          nodeId: grant.nodeId, taskId: grant.taskId, runId: grant.runId,
          agentId: "system", toolName: "system.revoke_security",
          verdict: "ALLOW", ruleName: "TaskSecurityGrantRevoked", riskCategory: "Policy Exception Grant",
          decisionSource: "DETERMINISTIC_POLICY",
          reason: `任务级全访问授权已由 Worker 确认撤销：${reason} (by ${revokedBy})`,
          sanitizedArgs: { grantId, reason, revokedBy },
        });
      }
      return { grantId, confirmed: true, status: "revoked", message: "Revocation confirmed by worker" };
    }

    await this.store.transitionTaskSecurityGrant?.(grantId, ["granted", "applied"], "revocation_pending", {
      lastError: result.message ?? "Revocation acknowledgement timed out", reconciliationRequired: true,
    });
    return { grantId, confirmed: false, status: "revocation_pending", message: result.message ?? "Revocation not confirmed" };
  }

  private async forceRevoke(grant: TaskSecurityGrant, reason: string, revokedBy: string): Promise<RevocationOutcome> {
    return this.revokeGrant(grant.grantId, reason, revokedBy);
  }

  /**
   * 全局权限收紧时撤销所有仍然活跃的任务级授权。
   * 返回 not confirmed 表示仍可能有 Worker 持有提权 —— 调用方必须保持安全应用 pending。
   */
  async revokeAllActiveGrants(reason: string, revokedBy = "system"): Promise<RevokeAllOutcome> {
    const grants = await this.store.listTaskSecurityGrants?.({}) ?? [];
    const active = grants.filter((grant) => (ACTIVE_GRANT_STATUSES as readonly string[]).includes(grant.status));
    const outcomes = await Promise.all(active.map((grant) => this.revokeGrant(grant.grantId, reason, revokedBy)));
    const pending = outcomes.filter((outcome) => !outcome.confirmed).length;
    return {
      confirmed: pending === 0,
      pending,
      revoked: outcomes.length - pending,
      grants: outcomes,
    };
  }

  /** 任务终态：授权自动失效（revocation_pending 保留，等待对账）。 */
  async expireForTask(taskId: string): Promise<void> {
    await this.store.expireTaskSecurityGrantsForTask?.(taskId);
  }

  /**
   * 审批解除后让任务回到真实执行态。
   * 只有在「该任务没有任何仍待处理的审批」时才迁移，避免多审批并发时提前放行。
   */
  private async resumeTaskIfUnblocked(taskId: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task || task.status !== "waiting_approval") return;
    const pending = (await this.store.listPendingApprovals()).some((item) => item.taskId === taskId);
    if (pending) return;
    await this.store.updateTaskStatus(taskId, "running");
    try { await this.onTaskResumed?.(taskId); } catch { /* 图状态同步失败不影响授权结论 */ }
  }

  // ---------------------------------------------------------------------------
  // 查询
  // ---------------------------------------------------------------------------

  async eligibility(approval: ClusterApprovalRecord): Promise<GrantEligibility> {
    if (approval.status !== "pending") return { canGrant: false, reason: `审批状态为 ${approval.status}` };
    if (approval.expiresAt <= Date.now()) return { canGrant: false, reason: "审批已过期" };
    const task = await this.store.getTask(approval.taskId);
    if (!task) return { canGrant: false, reason: "目标任务不存在" };
    if (task.nodeId !== approval.nodeId || task.runId !== approval.runId) return { canGrant: false, reason: "任务执行实例与审批绑定不一致" };
    if (task.status !== "waiting_approval") return { canGrant: false, reason: `任务当前状态为 ${task.status}，不在等待审批` };

    const existing = await this.store.getTaskSecurityGrantByApproval?.(approval.approvalId);
    const active = await this.store.getActiveTaskSecurityGrant?.(approval.taskId, approval.runId);
    if (existing?.status === "applied" || active) {
      return { canGrant: false, reason: "该任务已获得全访问授权", activeGrant: active ?? existing };
    }
    if (existing && (existing.status === "granted" || existing.status === "revocation_pending")) {
      return { canGrant: false, reason: "授权正在处理中", pendingGrant: existing };
    }
    if (!this.isNodeOnline(approval.nodeId)) return { canGrant: false, reason: "执行节点不在线", activeGrant: active };
    return { canGrant: true, activeGrant: active };
  }

  isNodeOnline(nodeId: string): boolean {
    const connection = this.registry.getConnection(nodeId);
    return Boolean(connection && connection.ws.readyState === 1);
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  private async requirePendingApproval(approvalId: string): Promise<ClusterApprovalRecord> {
    const approval = await this.store.getApproval(approvalId);
    if (!approval) throw new WebRequestError(404, `审批条目 ${approvalId} 不存在`);
    if (approval.status !== "pending") throw new WebRequestError(409, `审批状态已为 ${approval.status}，无法重复授权`);
    if (approval.expiresAt <= Date.now()) throw new WebRequestError(409, "审批已过期，无法授权");
    return approval;
  }

  private async requireRunningTask(approval: ClusterApprovalRecord): Promise<ClusterTaskRecord> {
    const task = await this.store.getTask(approval.taskId);
    if (!task) throw new WebRequestError(404, `目标任务 ${approval.taskId} 不存在`);
    if (task.runId !== approval.runId || task.nodeId !== approval.nodeId) {
      throw new WebRequestError(409, "任务执行实例与审批条目绑定不一致");
    }
    if (["completed", "failed", "cancelled", "outcome_unknown"].includes(task.status)) {
      throw new WebRequestError(409, `任务已处于终态 (${task.status})，无法授予全访问权限`);
    }
    if (task.status !== "waiting_approval") {
      throw new WebRequestError(409, `任务当前状态为 ${task.status}，不在等待审批，无法授予全访问权限`);
    }
    return task;
  }

  private coordinatorKnownPolicy(): SandboxPolicy {
    try {
      const security = this.productStore?.getPublicConfig().security;
      if (security) {
        return {
          filesystem: { mode: security.filesystem },
          network: { mode: security.network },
          approval: { mode: security.approval },
        };
      }
    } catch { /* 配置不可读时退化为保守基线 */ }
    return structuredClone(CONSERVATIVE_POLICY);
  }

  private configurationVersion(): number {
    try { return this.productStore?.getPublicConfig().version ?? 1; } catch { return 1; }
  }

  /**
   * 全局安全策略变更（收紧）时的撤销处理器。
   * 只负责一件事：证明没有任何 Worker 仍持有任务级提权。
   * 绝不改写任务状态、绝不清理 outcome_unknown、绝不伪造取消结果。
   */
  createSecurityRevocationHandler(): () => Promise<void> {
    return async () => {
      const outcome = await this.revokeAllActiveGrants("Global security policy tightened");
      if (!outcome.confirmed) {
        throw new Error(`${outcome.pending} task-level security grant(s) are not confirmed revoked; security apply remains pending`);
      }
    };
  }

  private async audit(input: AuditRecordInput): Promise<void> {
    if (!this.store.saveSecurityAudit) return;
    const now = Date.now();
    await this.store.saveSecurityAudit({
      id: `audit-${crypto.randomUUID()}`,
      timestamp: now,
      createdAt: now,
      toolName: input.toolName,
      argsFingerprint: `fp-${crypto.randomUUID()}`,
      sanitizedArgs: input.sanitizedArgs,
      rawArgsSnippet: JSON.stringify(input.sanitizedArgs).slice(0, 4096),
      verdict: input.verdict,
      severity: 0,
      riskCategory: input.riskCategory,
      decisionSource: input.decisionSource ?? "USER_APPROVAL",
      ruleName: input.ruleName,
      isHardBlock: false,
      reason: input.reason,
      durationMs: 0,
      agentId: input.agentId,
      nodeId: input.nodeId,
      taskId: input.taskId,
      runId: input.runId,
      projectId: input.projectId,
      reviewFeedback: { status: "unreviewed" },
    });
  }
}
