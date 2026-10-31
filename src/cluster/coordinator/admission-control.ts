/**
 * Admission Control / Cluster Drain
 *
 * 生产停机的安全门禁：冻结新工作准入，并用**真实运行态**证明集群已排空。
 *
 * 真实运行态的取证来源（缺一不可）：
 * 1. 每个在线 Worker 的进程内 Runner 注册表（`node.drain_probe` / `node.drain_status` 往返），
 *    而不是数据库里的任务计数；
 * 2. 本进程内仍在执行的会话轮次（turn）；
 * 3. 集群存储中非终态 Task / 待审批 Approval / 未结束 Graph / 执行中的 GoalRun。
 *
 * 只有全部来源同时为空、且连续两次探测都为空（用来覆盖「冻结瞬间仍在链路上的分派」），
 * 才认定 readyToStop = true。任何节点探测失败都视为「无法证明已排空」。
 */

import type { IClusterStore } from "../storage/cluster-store.js";
import type {
  ClusterTaskRecord,
  ClusterTaskStatus,
  GoalRunRecord,
} from "../storage/cluster-store-types.js";
import type { DistributedGraphRecord } from "../graph/types.js";
import type { NodeRegistry } from "./node-registry.js";
import type { WssGateway } from "./wss-gateway.js";
import type { NodeDrainStatusPayload } from "../protocol/types.js";

/** 仍在推进或仍会推进的任务状态；outcome_unknown / interrupted 不占用执行资源。 */
export const ADMISSION_ACTIVE_TASK_STATUSES: ClusterTaskStatus[] = [
  "created",
  "queued",
  "dispatched",
  "accepted",
  "running",
  "waiting_approval",
  "interrupting",
  "cancelling",
];

/** 仍处于执行链路中的 Graph 状态。 */
const ACTIVE_GRAPH_STATUSES = new Set([
  "planning",
  "validating",
  "ready",
  "paused",
  "running",
  "waiting_approval",
  "blocked",
  "replanning",
  "cancelling",
]);

/** 仍占用执行或等待人工输入的目标运行状态；verifying 只做收敛，不阻塞排空。 */
const ACTIVE_GOAL_STATUSES = new Set(["planning", "running", "waiting_approval", "recovering"]);

export class AdmissionFrozenError extends Error {
  readonly code = "ADMISSION_FROZEN";
  constructor(readonly frozen: { at: number; by: string; reason?: string }, readonly action?: string) {
    super(`Admission is frozen since ${new Date(frozen.at).toISOString()}${action ? `; rejected ${action}` : ""}`);
    this.name = "AdmissionFrozenError";
  }
}

export interface AdmissionFreezeState {
  frozen: boolean;
  at?: number;
  by?: string;
  reason?: string;
}

export interface AdmissionNodeStatus {
  nodeId: string;
  name?: string;
  role?: string;
  reachable: boolean;
  activeRuns: number;
  activeTaskIds: string[];
  pendingDispatches: number;
  acceptingTasks: boolean;
  error?: string;
}

export interface AdmissionSnapshot {
  frozen: boolean;
  frozenAt?: number;
  frozenBy?: string;
  reason?: string;
  observedAt: number;
  /** 集群已排空且可以安全停止产品服务。 */
  readyToStop: boolean;
  settled: boolean;
  settledStreak: number;
  coordinator: {
    liveTurns: string[];
    activeTasks: Array<{ taskId: string; nodeId: string; status: ClusterTaskStatus; updatedAt: number }>;
    pendingApprovals: string[];
    activeGraphs: Array<{ graphId: string; status: string }>;
    activeGoalRuns: Array<{ goalRunId: string; status: GoalRunRecord["status"]; conversationId: string }>;
    pausedInterruptedTasks: number;
    outcomeUnknownTasks: number;
  };
  nodes: AdmissionNodeStatus[];
  /** 阻止判定为「已排空」的具体原因。 */
  unsettledReasons: string[];
}

export interface AdmissionControlOptions {
  store: IClusterStore;
  registry?: NodeRegistry;
  gateway?: WssGateway;
  /** 本进程内仍在执行的会话轮次（Coordinator 内存态）。 */
  liveTurns?: () => string[];
  /** 探针超时；超时即视为节点不可证明，按未排空处理。 */
  probeTimeoutMs?: number;
}

export interface WaitForSettledOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** 需要连续多少次探测都为空；默认 2 次，用来覆盖冻结瞬间的在途分派。 */
  consecutive?: number;
  signal?: AbortSignal;
}

export class AdmissionControl {
  private readonly store: IClusterStore;
  private readonly registry?: NodeRegistry;
  private readonly gateway?: WssGateway;
  private readonly liveTurns?: () => string[];
  private readonly probeTimeoutMs: number;
  private freezeState: { at: number; by: string; reason?: string } | null = null;
  private settledStreak = 0;

  constructor(options: AdmissionControlOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.gateway = options.gateway;
    this.liveTurns = options.liveTurns;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5000;
  }

  isFrozen(): boolean {
    return this.freezeState !== null;
  }

  state(): AdmissionFreezeState {
    return this.freezeState
      ? { frozen: true, at: this.freezeState.at, by: this.freezeState.by, reason: this.freezeState.reason }
      : { frozen: false };
  }

  freeze(by: string, reason?: string): AdmissionFreezeState {
    if (!this.freezeState) {
      this.freezeState = { at: Date.now(), by, reason };
      this.settledStreak = 0;
    }
    return this.state();
  }

  /** 解除冻结并重置连续排空计数；调用方负责记录操作者。 */
  unfreeze(): AdmissionFreezeState {
    this.freezeState = null;
    this.settledStreak = 0;
    return { frozen: false };
  }

  /** 准入断言：冻结期间任何新工作都必须在入口处被拒绝。 */
  assertAdmitting(action: string): void {
    if (this.freezeState) throw new AdmissionFrozenError(this.freezeState, action);
  }

  private async listActiveTasks(): Promise<{ active: ClusterTaskRecord[]; interrupted: number; outcomeUnknown: number }> {
    const active: ClusterTaskRecord[] = [];
    for (const status of ADMISSION_ACTIVE_TASK_STATUSES) {
      const rows = await this.store.listTasks({ status, limit: 5000 });
      active.push(...rows);
    }
    const interruptedRows = await this.store.listTasks({ status: "interrupted", limit: 5000 });
    const unknownRows = await this.store.listTasks({ status: "outcome_unknown", limit: 5000 });
    return { active, interrupted: interruptedRows.length, outcomeUnknown: unknownRows.length };
  }

  async snapshot(): Promise<AdmissionSnapshot> {
    const observedAt = Date.now();
    const store = this.store;

    const [{ active, interrupted, outcomeUnknown }, pendingApprovals, graphs, goalRuns] = await Promise.all([
      this.listActiveTasks(),
      store.listPendingApprovals(),
      store.listGraphs ? store.listGraphs() : Promise.resolve([] as DistributedGraphRecord[]),
      store.listGoalRuns ? store.listGoalRuns() : Promise.resolve([] as GoalRunRecord[]),
    ]);

    const activeGraphs = graphs
      .filter((graph) => ACTIVE_GRAPH_STATUSES.has(String(graph.status)))
      .map((graph) => ({ graphId: graph.graphId, status: String(graph.status) }));

    // 只有真正持有执行（或仍被活跃租约占有）的目标才算未排空；
    // 等待用户澄清、没有任何关联任务的会话不占用运行时资源。
    const activeGoalRuns = goalRuns
      .filter((goal) => {
        const leaseAlive = Boolean(goal.turnLease && goal.turnLease.expiresAt > observedAt);
        const holdsWork = Boolean(goal.linkedTaskIds.length || goal.linkedGraphIds.length || goal.discoveryScopes?.length);
        return leaseAlive || (ACTIVE_GOAL_STATUSES.has(goal.status) && holdsWork);
      })
      .map((goal) => ({ goalRunId: goal.goalRunId, status: goal.status, conversationId: goal.conversationId }));

    const liveTurns = this.liveTurns ? this.liveTurns() : [];

    // 真实运行态：逐个在线节点往返取证，不接受「乐观默认」。
    const connections = this.registry?.listOnlineConnections() ?? [];
    const nodes: AdmissionNodeStatus[] = [];
    for (const conn of connections) {
      const base = {
        nodeId: conn.nodeId,
        name: conn.metadata?.name,
        role: conn.metadata?.role,
      };
      if (!this.gateway) {
        nodes.push({ ...base, reachable: false, activeRuns: 0, activeTaskIds: [], pendingDispatches: 0, acceptingTasks: false, error: "drain probe unavailable" });
        continue;
      }
      const status = await this.gateway.probeDrainStatus(conn.nodeId, this.probeTimeoutMs);
      nodes.push(toNodeStatus(base, status));
    }

    const unsettledReasons: string[] = [];
    if (liveTurns.length) unsettledReasons.push(`${liveTurns.length} live coordinator turn(s)`);
    if (active.length) unsettledReasons.push(`${active.length} active task(s)`);
    if (pendingApprovals.length) unsettledReasons.push(`${pendingApprovals.length} pending approval(s)`);
    if (activeGraphs.length) unsettledReasons.push(`${activeGraphs.length} active graph(s)`);
    if (activeGoalRuns.length) unsettledReasons.push(`${activeGoalRuns.length} active goal run(s)`);
    for (const node of nodes) {
      if (!node.reachable) unsettledReasons.push(`node ${node.nodeId} could not prove drain (${node.error ?? "unreachable"})`);
      else if (node.activeRuns > 0) unsettledReasons.push(`node ${node.nodeId} runs ${node.activeRuns} task(s)`);
      else if (node.pendingDispatches > 0) unsettledReasons.push(`node ${node.nodeId} holds ${node.pendingDispatches} pending dispatch(es)`);
    }

    const settled = unsettledReasons.length === 0;
    this.settledStreak = settled ? this.settledStreak + 1 : 0;

    return {
      frozen: this.isFrozen(),
      ...(this.freezeState ? { frozenAt: this.freezeState.at, frozenBy: this.freezeState.by, reason: this.freezeState.reason } : {}),
      observedAt,
      // 未冻结时「可安全停止」没有意义：不冻结就无法阻止新工作进入。
      readyToStop: settled && this.isFrozen() && this.settledStreak >= 2,
      settled,
      settledStreak: this.settledStreak,
      coordinator: {
        liveTurns,
        activeTasks: active.map((task) => ({ taskId: task.taskId, nodeId: task.nodeId, status: task.status, updatedAt: task.updatedAt })),
        pendingApprovals: pendingApprovals.map((approval) => approval.approvalId),
        activeGraphs,
        activeGoalRuns,
        pausedInterruptedTasks: interrupted,
        outcomeUnknownTasks: outcomeUnknown,
      },
      nodes,
      unsettledReasons,
    };
  }

  /**
   * 等待集群真正排空。要求连续 N 次探测为空，避免把冻结瞬间仍在链路上的分派误判为已排空。
   * 超时返回最后一次快照（readyToStop=false 且 unsettledReasons 非空）。
   */
  async waitForSettled(options: WaitForSettledOptions = {}): Promise<AdmissionSnapshot> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const pollMs = options.pollMs ?? 2000;
    const consecutive = Math.max(1, options.consecutive ?? 2);
    const deadline = Date.now() + timeoutMs;
    let snapshot = await this.snapshot();
    while (Date.now() < deadline) {
      if (options.signal?.aborted) return snapshot;
      if (snapshot.settled && this.settledStreak >= consecutive) return snapshot;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        timer.unref?.();
        options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (options.signal?.aborted) return snapshot;
      snapshot = await this.snapshot();
    }
    return snapshot;
  }
}

function toNodeStatus(
  base: { nodeId: string; name?: string; role?: string },
  status: NodeDrainStatusPayload | null,
): AdmissionNodeStatus {
  if (!status) {
    return { ...base, reachable: false, activeRuns: 0, activeTaskIds: [], pendingDispatches: 0, acceptingTasks: false, error: "no drain_status response" };
  }
  if (status.nodeId !== base.nodeId) {
    return { ...base, reachable: false, activeRuns: 0, activeTaskIds: [], pendingDispatches: 0, acceptingTasks: false, error: "drain_status node mismatch" };
  }
  return {
    ...base,
    reachable: true,
    activeRuns: status.activeRuns,
    activeTaskIds: status.activeTaskIds,
    pendingDispatches: status.pendingDispatches,
    acceptingTasks: status.acceptingTasks,
  };
}
