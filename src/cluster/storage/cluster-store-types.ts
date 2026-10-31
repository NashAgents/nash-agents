import type { RuntimeSpan } from "../../observability/runtime-phase.js";
import type { ModelUsageRecord } from "../../observability/model-usage.js";
import type { SandboxPolicy } from "../../sandbox/types.js";
import type {
  SequencedEvent,
  CatalogSyncSnapshotPayload,
  GraphTaskContext,
  RemoteApprovalRequestPayload,
  NodeHardwareCapability,
  ProjectCatalogItem,
  SkillCatalogItem,
  MCPCapabilityCatalogItem,
  FederatedMemoryIndexItem,
  CatalogTombstoneItem,
} from "../protocol/types.js";
import {
  type AtomicGraphPatchSpec,
  type GraphPatchApplyResult,
} from "../graph/types.js";
import type {
  DistributedGraphRecord,
  DistributedGraphNodeRecord,
  DistributedGraphEdgeRecord,
  GraphRevisionRecord,
  GraphVerificationRecord,
  GraphStatus,
  GraphNodeStatus,
} from "../graph/types.js";
import type { GoalCoverageEvaluation } from "./goal-coverage-evaluation.js";

export class ClusterStorageError extends Error {
  constructor(message: string) { super(message); this.name = "ClusterStorageError"; }
}

export interface ClusterNodeRecord {
  nodeId: string;
  name: string;
  role: "coordinator" | "worker" | "coordinator-worker";
  platform: string;
  arch: string;
  hostname: string;
  tokenHash: string;
  status: "online" | "suspect" | "offline" | "revoked";
  lastSeenAt: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type ClusterTaskStatus =
  | "created"
  | "queued"
  | "dispatched"
  | "accepted"
  | "running"
  | "waiting_approval"
  | "interrupting"
  | "interrupted"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export const CLUSTER_TASK_TERMINAL = new Set<ClusterTaskStatus>(["completed", "failed", "cancelled"]);

export function canTransitionTask(from: ClusterTaskStatus, to: ClusterTaskStatus): boolean {
  if (from === to) return true;
  if (CLUSTER_TASK_TERMINAL.has(from)) return false;
  if (from === "cancelling") return ["completed", "failed", "cancelled", "outcome_unknown"].includes(to);
  const initial = ["created", "queued", "dispatched", "accepted"];
  if (initial.includes(to)) return initial.includes(from) && initial.indexOf(to) >= initial.indexOf(from);
  return true;
}

export interface ClusterTaskRecord {
  runId?: string;
  timeoutMs?: number;
  dispatchOptions?: { maxSteps?: number; contextOverrides?: Record<string, unknown>; graphContext?: GraphTaskContext };
  taskId: string;
  nodeId: string;
  projectId: string;
  goal: string;
  prompt?: string;
  status: ClusterTaskStatus;
  dispatchAttempt: number;
  resultSummary?: string;
  finalAnswer?: string;
  deliverables?: Array<{ path: string; description: string }>;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface ClusterApprovalRecord {
  approvalId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  agentId: string;
  capability: string;
  reason: string;
  target?: string;
  toolName?: string;
  status: "pending" | "resolved" | "expired";
  decision?: "allow-once" | "deny" | "grant-task-full-access";
  requestedAt: number;
  expiresAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
  grantId?: string;
}

/**
 * 任务级安全授权状态机
 *
 * granted            已持久化，正在等待 Worker ACK。**不是**授权依据。
 * applied            Worker 已确认新策略生效。唯一可作为授权依据的状态。
 * revocation_pending 已请求撤销，但未获得 Worker 确认（离线 / ACK 丢失）。
 *                    不授予权限，也不得当作「已撤销」——需要重连后对账。
 * revoked            已确认撤销，或从未 ACK 的授权在节点离线时被安全丢弃。
 * expired            任务进入终态后失效。
 */
export type TaskSecurityGrantStatus =
  | "granted"
  | "applied"
  | "revocation_pending"
  | "revoked"
  | "expired";

export interface TaskSecurityGrantTransitionDetails {
  effectiveAt?: number;
  workerAckAt?: number;
  revokedAt?: number;
  expiredAt?: number;
  revokedBy?: string;
  lastError?: string;
  reconciliationRequired?: boolean;
}

export interface TaskSecurityGrantFilter {
  taskId?: string;
  runId?: string;
  nodeId?: string;
  approvalId?: string;
  status?: TaskSecurityGrantStatus;
}

/**
 * 结构化 Task/Run 安全授权记录 (Task Security Grant)
 */
export interface TaskSecurityGrant {
  grantId: string;
  approvalId: string;
  nodeId: string;
  taskId: string;
  runId: string;
  authorizationMode: "task-full-access";
  originalPolicy: SandboxPolicy;
  targetPolicy: SandboxPolicy;
  authorizedBy: string;
  grantedAt: number;
  effectiveAt?: number;
  workerAckAt?: number;
  revokedAt?: number;
  expiredAt?: number;
  revokedBy?: string;
  lastError?: string;
  reconciliationRequired?: boolean;
  /** 授权作用域：只影响后续工具调用派生出的进程，不追认已在运行的进程。 */
  appliesTo?: "subsequent-tool-calls";
  status: TaskSecurityGrantStatus;
  configurationVersion: number;
}

export interface ClusterOutboxRecord {
  id?: number;
  targetNodeId: string;
  messageId: string;
  messageType: string;
  payload: any;
  status: "pending" | "sent" | "dead";
  attempts: number;
  nextRetryAt: number;
  createdAt: number;
}

export interface ClusterRouteRecord {
  routeId: string;
  taskId?: string;
  userRequest: string;
  intent: any;
  decisionType: string;
  selectedNodeId?: string;
  selectedProjectId?: string;
  reason: string;
  status: string;
  candidatesSnapshot?: any[];
  createdAt: number;
  updatedAt: number;
}

export interface WebMessageRecord {
  id: string;
  conversationId: string;
  sender: "user" | "assistant" | "system";
  content: string;
  messageType?:
    | "text"
    | "clarification"
    | "task_status"
    | "routing_decision"
    | "graph_planning"
    | "agent_activity"
    | "tool_call"
    | "tool_result"
    | "approval_request"
    | "artifact"
    | "error";
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export type ConversationTitleSource = "default" | "ai_generated" | "user_defined";

export interface GoalDiscoveryScope {
  version: number;
  discoveryId: string;
  query: string;
  selectedAt: number;
  snapshotStartedAt: number;
  snapshotCompletedAt: number;
  selectionSource: "explicit_nodes" | "catalog_clues" | "online_snapshot";
  requestedNodeIds?: string[];
  selectedNodeIds: string[];
  knownClueNodeIds: string[];
  snapshot: Array<{ nodeId: string; connected: boolean; catalogRevision?: number }>;
  allowUnregisteredScanning: boolean;
  truncatedByLimit: boolean;
  recoveryOf?: { graphId: string; graphNodeId: string; taskId: string; reason: string };
}

export interface GoalTurnFence { ownerId: string; turnId: string; generation: number }

/** Captures the actual admitted plan; completeness of the user's scope is a separate verification. */
export interface GoalCoverageContract {
  version: number;
  graphId: string;
  graphRevision: number;
  rootGoal: string;
  graphGoal: string;
  rootGoalMatches: boolean;
  source: "admitted_graph" | "graph_replan";
  scopeStatus: "unverified";
  reason: string;
  recordedAt: number;
  catalogSnapshot?: import("../graph/types.js").ExecutionStrategyDecision["catalogSnapshot"];
  requiredTargets: NonNullable<import("../graph/types.js").ExecutionStrategyDecision["requiredTargets"]>;
  checks: Array<{ graphNodeId: string; goal: string; targetNodeId?: string; targetProjectId?: string; acceptanceCriteria: import("../graph/types.js").AcceptanceCriterion[]; requiredSandboxPolicy?: import("../graph/types.js").RequiredSandboxPolicy }>;
}

/** Structured evidence behind one persisted goal report; never model-authored. */
export interface GoalReportEvidence {
  taskIds: string[];
  graphIds: string[];
  coverageVersions?: Array<{ graphId: string; graphRevision: number; version: number; scopeStatus: string }>;
  coverageChecks?: Array<{
    graphId: string; graphRevision?: number; graphNodeId: string; requirementId?: string;
    taskId?: string; nodeId?: string; runId?: string; status: string;
    verificationType?: string; verifiedAt?: number; artifactIds?: string[]; reason?: string;
  }>;
  coverageScopes?: Array<{
    discoveryId: string; status: string; requiredNodeIds: string[]; truncatedByLimit: boolean; reasons: string[];
    nodes: Array<{ nodeId: string; status: string; taskId?: string; runId?: string; candidates: number; checkedRoots: string[]; scanScope?: string; reason: string }>;
  }>;
  coverage?: {
    completion: string;
    counts: GoalCoverageEvaluation["counts"];
    reasons: string[];
    observedScope: GoalCoverageEvaluation["observedScope"];
    requiredTargets: GoalCoverageEvaluation["requiredTargets"];
    coverageGaps: string[];
  };
  artifactIds?: string[];
  artifacts?: Array<{ artifactId: string; sha256: string; producerTaskId: string }>;
  scoutEvents?: Array<{ taskId: string; seq: number; omittedScans?: number }>;
  scoutScans?: Array<{ taskId: string; nodeId: string; seq: number; authorizedRoots: string[]; scope: string; truncated: boolean; errorCount: number }>;
  verdict: string;
  fingerprint: string;
}

export interface GoalReportEntry {
  revision: number;
  fingerprint: string;
  content: string;
  createdAt: number;
  evidence?: GoalReportEvidence;
  status?: GoalRunRecord["status"];
}

export interface GoalRunRecord {
  goalRunId: string;
  conversationId: string;
  userMessageId: string;
  rootGoal: string;
  status: "planning" | "running" | "waiting_approval" | "recovering" | "verifying" | "completed" | "partially_completed" | "failed" | "cancelled" | "outcome_unknown";
  executionState?: "running" | "waiting_approval" | "settled" | "outcome_unknown";
  currentStage?: string;
  linkedGraphIds: string[];
  linkedTaskIds: string[];
  requiredExecutionScope: unknown;
  coverageHistory?: GoalCoverageContract[];
  /** Latest deterministic coverage verdict; cleared whenever new work or a new revision invalidates it. */
  coverageEvaluation?: GoalCoverageEvaluation;
  discoveryScopes?: GoalDiscoveryScope[];
  interimReport?: string;
  interimMessageId?: string;
  turnRecovery?: { turnId: string; recoveredAt: number };
  finalReport?: string;
  reportFingerprint?: string;
  reportState?: "pending" | "ready" | "failed";
  reportEvidence?: GoalReportEvidence;
  reportHistory?: GoalReportEntry[];
  reportRevision: number;
  /** Monotonic generation for the foreground turn owner; never reused after expiry. */
  turnLeaseGeneration?: number;
  turnLease?: { ownerId: string; turnId: string; generation: number; expiresAt: number };
  revision: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface WebConversationRecord {
  id: string;
  title: string;
  titleSource?: ConversationTitleSource;
  titleRevision?: number;
  createdAt: number;
  updatedAt: number;
  linkedTaskIds?: string[];
  linkedGraphIds?: string[];
  messages: WebMessageRecord[];
}

export interface WebSessionRecord {
  sessionId: string;
  userId: string;
  username: string;
  role: "admin" | "operator" | "viewer";
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

// ==========================================
// 定时任务与自主调度系统 (Scheduled Agents & Tasks)
// ==========================================

export type ScheduleTriggerType = "cron" | "interval" | "once";
export type ScheduledTargetType = "single_task" | "graph";
export type ScheduleConcurrencyPolicy = "SKIP_IF_RUNNING" | "QUEUE" | "ALLOW_CONCURRENT";
export type ScheduleMisfirePolicy = "RUN_ONCE_IMMEDIATELY" | "SKIP_MISFIRE" | "CATCH_UP";
export type ScheduledTaskRunStatus = "queued" | "running" | "outcome_unknown" | "completed" | "failed" | "skipped";

export interface ScheduledTaskRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  triggerType: ScheduleTriggerType;
  cronExpression?: string;
  intervalMs?: number;
  runAt?: number;
  timezone?: string;
  targetType: ScheduledTargetType;
  taskConfig?: {
    goal: string;
    prompt?: string;
    nodeId?: string;
    projectId?: string;
    timeoutMs?: number;
    maxSteps?: number;
    contextOverrides?: Record<string, unknown>;
  };
  graphConfig?: {
    parentGoal: string;
    nodes?: any[];
  };
  concurrencyPolicy: ScheduleConcurrencyPolicy;
  misfirePolicy: ScheduleMisfirePolicy;
  maxConcurrency: number;
  lastRunAt?: number;
  lastRunStatus?: ScheduledTaskRunStatus;
  nextRunAt?: number;
  runCount: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledTaskRunRecord {
  id: string;
  scheduledTaskId: string;
  targetType: ScheduledTargetType;
  taskId?: string;
  graphId?: string;
  triggerTime: number;
  startedAt: number;
  completedAt?: number;
  status: ScheduledTaskRunStatus;
  skipReason?: string;
  error?: string;
  resultSummary?: string;
  metrics?: Record<string, unknown>;
  createdAt: number;
}

// ==========================================
// LLM 工具调用安全审查历史 (Security Decision Audit)
// ==========================================

export type SecurityDecisionSource =
  | "LLM_MONITOR"
  | "DETERMINISTIC_POLICY"
  | "USER_APPROVAL"
  | "SYSTEM_FAILURE";

export type SecurityReviewStatus =
  | "unreviewed"
  | "confirmed_risk"
  | "false_positive"
  | "needs_investigation";

export interface SecurityAuditFeedback {
  status: SecurityReviewStatus;
  reviewedAt?: number;
  reviewedBy?: string;
  comment?: string;
}

export interface SecurityAuditRecord {
  id: string;
  timestamp: number;
  toolName: string;
  argsFingerprint: string;
  sanitizedArgs: Record<string, unknown>;
  rawArgsSnippet: string;
  decisionSource: SecurityDecisionSource;
  verdict: "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL";
  severity: number;
  riskCategory: string;
  ruleName?: string;
  reason: string;
  decisionEvidence?: string;
  agentId: string;
  nodeId?: string;
  projectId?: string;
  taskId?: string;
  runId?: string;
  durationMs: number;
  isHardBlock: boolean;
  tokensUsed?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  modelVersion?: string;
  reviewFeedback: SecurityAuditFeedback;
  createdAt: number;
}

export interface SecurityAuditFilter {
  verdict?: "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL";
  decisionSource?: SecurityDecisionSource;
  riskCategory?: string;
  reviewStatus?: SecurityReviewStatus;
  taskId?: string;
  nodeId?: string;
  fromTimestamp?: number;
  toTimestamp?: number;
  limit?: number;
  offset?: number;
}

export interface SecurityAuditStats {
  totalCount: number;
  allowCount: number;
  blockCount: number;
  requireApprovalCount: number;
  sourceCounts: Record<SecurityDecisionSource, number>;
  falsePositiveCount: number;
  topRiskCategories: Array<{ category: string; count: number }>;
}

export interface GraphCreation {
  goalRunId?: string;
  goalTurnFence?: GoalTurnFence;
  graph: DistributedGraphRecord;
  nodes: DistributedGraphNodeRecord[];
  edges: DistributedGraphEdgeRecord[];
  revision: GraphRevisionRecord;
  event: Record<string, unknown>;
}

export interface IClusterStore {
  createGoalRunWithConversation?(goal: GoalRunRecord, conversation: WebConversationRecord, initialLease?: { ownerId: string; ttlMs: number }): Promise<boolean>;
  continueGoalRunWithConversation?(goalRunId: string, conversation: WebConversationRecord, turnId: string, ownerId: string, ttlMs: number): Promise<GoalRunRecord["turnLease"] | null>;
  commitGoalTurnResponse?(goalRunId: string, message: WebMessageRecord, fence?: GoalTurnFence): Promise<{ goal: GoalRunRecord; inserted: boolean }>;
  claimGoalTurnLease?(goalRunId: string, turnId: string, ownerId: string, ttlMs: number): Promise<GoalRunRecord["turnLease"] | null>;
  renewGoalTurnLease?(goalRunId: string, ownerId: string, generation: number, ttlMs: number): Promise<boolean>;
  /** 轮次正常或异常退出时主动交出租约，避免下一条消息被未过期的租约拒绝。 */
  releaseGoalTurnLease?(goalRunId: string, ownerId: string, generation: number): Promise<boolean>;
  executeGoalTaskControl?(goalRunId: string, fence: GoalTurnFence, taskId: string, status: "cancelled" | "cancelling" | "outcome_unknown" | undefined, reason: string | undefined, send?: () => void): Promise<boolean>;
  createGraphAtomic?(input: GraphCreation): Promise<void>;
  saveTaskWithGoal?(task: ClusterTaskRecord, goalRunId: string, fence?: GoalTurnFence): Promise<void>;
  listGraphTaskAttempts?(graphId: string, nodeId: string): Promise<ClusterTaskRecord[]>;
  claimScheduledTaskRun?(run: ScheduledTaskRunRecord, force?: boolean): Promise<{ run: ScheduledTaskRunRecord; admitted: boolean }>;
  listScheduledTasksForExecution?(afterId?: string, limit?: number): Promise<ScheduledTaskRecord[]>;
  listUnsettledScheduledRuns?(afterId?: string, limit?: number): Promise<ScheduledTaskRunRecord[]>;
  getScheduledRunByExecution?(taskId?: string, graphId?: string): Promise<ScheduledTaskRunRecord | null>;
  getTaskCounts?(): Promise<{ total: number; running: number }>;
  findGraphNodeByTaskId?(taskId: string): Promise<DistributedGraphNodeRecord | null>;
  saveRuntimeSpan?(span: RuntimeSpan): Promise<void>;
  listRuntimeSpans?(traceId: string, offset?: number, limit?: number): Promise<RuntimeSpan[]>;
  pruneStaleTelemetry?(retentionDays: number): Promise<{ prunedSpans: number; prunedUsage: number }>;
  saveModelUsage?(record: ModelUsageRecord): Promise<void>;
  listModelUsage?(filter: { traceId?: string; graphId?: string; conversationId?: string; since?: number; until?: number; offset?: number; limit?: number }): Promise<ModelUsageRecord[]>;
  purgeModelUsage?(before: number): Promise<number>;

  applyGraphPatchAtomic?(patch: AtomicGraphPatchSpec): Promise<GraphPatchApplyResult>;
  withGraphLock?<T>(graphId: string, operation: () => Promise<T>): Promise<T>;
  // 节点
  saveNode(node: ClusterNodeRecord): Promise<void>;
  createNodeIfAbsent(node: ClusterNodeRecord): Promise<boolean>;
  updateNodeConnection(node: ClusterNodeRecord): Promise<boolean>;
  getNode(nodeId: string): Promise<ClusterNodeRecord | null>;
  listNodes(): Promise<ClusterNodeRecord[]>;
  updateNodeStatus(nodeId: string, status: ClusterNodeRecord["status"]): Promise<void>;
  updateNodeLastSeen(nodeId: string, lastSeenAt: number): Promise<void>;
  /**
   * 轮换节点凭证哈希（保留 Node Identity，不改状态/角色/注册时间）。
   * 只接收哈希，明文 Token 永远不经过协调器。
   */
  rotateNodeToken?(nodeId: string, tokenHash: string): Promise<boolean>;

  // 任务
  saveTask(task: ClusterTaskRecord): Promise<void>;
  getTask(taskId: string): Promise<ClusterTaskRecord | null>;
  listTasks(filter?: { nodeId?: string; projectId?: string; status?: ClusterTaskStatus; limit?: number }): Promise<ClusterTaskRecord[]>;
  updateTaskStatus(taskId: string, status: ClusterTaskStatus, details?: { error?: string; resultSummary?: string; finalAnswer?: string; deliverables?: any }): Promise<void>;

  // 事件
  appendEvents(events: SequencedEvent[]): Promise<number>;
  getEventsForTask(taskId: string, fromSeq?: number, limit?: number): Promise<SequencedEvent[]>;

  // 审批
  saveApproval(approval: ClusterApprovalRecord): Promise<void>;
  getApproval(approvalId: string): Promise<ClusterApprovalRecord | null>;
  listPendingApprovals(): Promise<ClusterApprovalRecord[]>;
  listApprovalHistory?(limit?: number): Promise<ClusterApprovalRecord[]>;
  resolveApproval(approvalId: string, decision: "allow-once" | "deny" | "grant-task-full-access", resolvedBy?: string, grantId?: string): Promise<boolean>;

  // 任务级全访问授权
  /**
   * 持久化授权记录。返回 false 表示该 approval 已存在「生效中」的授权（granted / applied /
   * revocation_pending）——并发重复授权由唯一约束兜底；已结束（revoked / expired）的历史
   * 授权保留审计，不阻止管理员在同一审批上重试。
   */
  saveTaskSecurityGrant?(grant: TaskSecurityGrant): Promise<boolean>;
  getTaskSecurityGrant?(grantId: string): Promise<TaskSecurityGrant | null>;
  getTaskSecurityGrantByApproval?(approvalId: string): Promise<TaskSecurityGrant | null>;
  /** 只返回 Worker 已确认生效 (applied) 的授权；granted / revocation_pending 均不得作为授权依据。 */
  getActiveTaskSecurityGrant?(taskId: string, runId: string): Promise<TaskSecurityGrant | null>;
  listTaskSecurityGrants?(filter?: TaskSecurityGrantFilter): Promise<TaskSecurityGrant[]>;
  /**
   * 原子状态迁移（CAS）。仅当当前状态属于 `from` 时才迁移，返回是否迁移成功。
   * 用于杜绝并发重复授权、迟到 ACK 复活已撤销授权等竞态。
   */
  transitionTaskSecurityGrant?(grantId: string, from: TaskSecurityGrantStatus[], to: TaskSecurityGrantStatus, details?: TaskSecurityGrantTransitionDetails): Promise<boolean>;
  /** 任务进入终态时使授予自动失效；返回受影响条数。 */
  expireTaskSecurityGrantsForTask?(taskId: string): Promise<number>;

  // Outbox / Inbox
  enqueueOutbox(record: Omit<ClusterOutboxRecord, "id">): Promise<void>;
  hasOutboxMessage?(messageId: string): Promise<boolean>;
  pollPendingOutbox(limit?: number): Promise<ClusterOutboxRecord[]>;
  markOutboxSent(messageId: string): Promise<void>;
  checkAndRecordInbox(messageId: string, sourceNodeId: string): Promise<boolean>;

  // Catalog & Federated Memory (Phase 2)
  saveCatalogRevision(nodeId: string, revision: number, capabilities: NodeHardwareCapability[], syncStatus?: string): Promise<void>;
  getCatalogRevision(nodeId: string): Promise<{ revision: number; capabilities: NodeHardwareCapability[]; lastSyncAt: number; syncStatus: string } | null>;

  upsertNodeCatalogSnapshot(snapshot: CatalogSyncSnapshotPayload): Promise<void>;
  upsertProjectCatalog(projects: ProjectCatalogItem[]): Promise<void>;
  deleteProjectCatalog(nodeId: string, projectIds: string[]): Promise<void>;
  listProjectsCatalog(filter?: { nodeId?: string; visibility?: string }): Promise<ProjectCatalogItem[]>;
  getProjectCatalog(nodeId: string, projectId: string): Promise<ProjectCatalogItem | null>;

  upsertSkillCatalog(skills: SkillCatalogItem[]): Promise<void>;
  deleteSkillCatalog(nodeId: string, skillIds: string[]): Promise<void>;
  listSkillsCatalog(filter?: { nodeId?: string; projectId?: string }): Promise<SkillCatalogItem[]>;

  upsertMCPCatalog(mcp: MCPCapabilityCatalogItem[]): Promise<void>;
  deleteMCPCatalog(nodeId: string, serverIds: string[]): Promise<void>;
  listMCPCatalog(filter?: { nodeId?: string }): Promise<MCPCapabilityCatalogItem[]>;

  upsertMemoryIndex(entries: FederatedMemoryIndexItem[]): Promise<void>;
  upsertWorkerMemorySnapshot(nodeId: string, entries: FederatedMemoryIndexItem[]): Promise<void>;
  deleteMemoryIndex(nodeId: string, entryIds: string[]): Promise<void>;
  deleteProjectMemoryIndex(nodeId: string, projectId: string): Promise<void>;
  listMemoryIndex(filter?: { nodeId?: string; projectId?: string }): Promise<FederatedMemoryIndexItem[]>;

  saveTombstones(tombstones: CatalogTombstoneItem[], nodeId: string): Promise<void>;
  getTombstones(nodeId: string, sinceRevision?: number): Promise<CatalogTombstoneItem[]>;
  listTombstones?(nodeId?: string): Promise<CatalogTombstoneItem[]>;

  recordSyncLog(nodeId: string, syncType: string, revision: number, itemCounts: Record<string, number>, status: string, error?: string): Promise<void>;

  // Semantic Routing (Phase 3)
  recordRouteDecision?(record: ClusterRouteRecord): Promise<void>;
  getRouteDecision?(routeId: string): Promise<ClusterRouteRecord | null>;
  recordRouteReplan?(record: any): Promise<void>;
  getRouteReplan?(replanId: string): Promise<any | null>;
  listRouteReplans?(taskId: string): Promise<any[]>;

  // Distributed TaskGraph & A2A & Artifacts (Phase 4)
  saveGraph?(graph: DistributedGraphRecord): Promise<void>;
  getGraph?(graphId: string): Promise<DistributedGraphRecord | null>;
  listGraphs?(filter?: { status?: GraphStatus; limit?: number }): Promise<DistributedGraphRecord[]>;
  updateGraphStatus?(graphId: string, status: GraphStatus, details?: { error?: string; finalSummary?: string; completedAt?: number }): Promise<void>;
  transitionGraphStatus?(graphId: string, expectedRevision: number, expectedStatus: GraphStatus, status: GraphStatus, details?: { error?: string; finalSummary?: string; completedAt?: number }, owner?: { goalRunId: string; fence: GoalTurnFence }): Promise<boolean>;

  saveGraphNode?(node: DistributedGraphNodeRecord): Promise<void>;
  getGraphNode?(graphId: string, nodeId: string): Promise<DistributedGraphNodeRecord | null>;
  listGraphNodes?(graphId: string): Promise<DistributedGraphNodeRecord[]>;
  updateGraphNodeStatus?(graphId: string, nodeId: string, status: GraphNodeStatus, details?: { taskId?: string; workerRunId?: string; resultSummary?: string; error?: string; attemptCount?: number; startedAt?: number; completedAt?: number; assignedNodeId?: string; assignedProjectId?: string }): Promise<void>;

  saveGraphEdges?(edges: DistributedGraphEdgeRecord[]): Promise<void>;
  deleteGraphEdges?(graphId: string, edges: Array<{ fromNodeId: string; toNodeId: string }>): Promise<void>;
  listGraphEdges?(graphId: string): Promise<DistributedGraphEdgeRecord[]>;

  recordGraphRevision?(rev: GraphRevisionRecord): Promise<void>;
  listGraphRevisions?(graphId: string): Promise<GraphRevisionRecord[]>;

  appendGraphEvent?(graphId: string, eventType: string, payload: Record<string, unknown>): Promise<number>;
  listGraphEvents?(graphId: string, fromSeq?: number): Promise<Array<{ seq: number; eventType: string; payload: any; createdAt: number }>>;

  recordGraphVerification?(v: GraphVerificationRecord): Promise<void>;
  listGraphVerifications?(graphId: string, graphNodeId?: string): Promise<GraphVerificationRecord[]>;

  saveAgentMessage?(msg: any): Promise<void>;
  getAgentMessage?(messageId: string): Promise<any | null>;
  pollPendingAgentMessages?(targetNodeId: string, targetAgentId: string): Promise<any[]>;
  updateAgentMessageStatus?(messageId: string, status: string, timestamp?: number): Promise<void>;

  saveArtifact?(artifact: any): Promise<void>;
  getArtifact?(artifactId: string): Promise<any | null>;
  listArtifacts?(graphId?: string): Promise<any[]>;
  grantArtifactAccess?(artifactId: string, graphId: string, consumerNodeId: string, consumerTaskId?: string): Promise<void>;
  hasArtifactAccess?(artifactId: string, consumerNodeId: string, consumerTaskId?: string): Promise<boolean>;

  recordGraphControl?(ctrl: any): Promise<void>;
  getPendingGraphControls?(graphId: string): Promise<any[]>;
  updateGraphControlStatus?(controlId: string, status: string): Promise<void>;

  // Web Control Plane & Conversations (Phase 5)
  createGoalRun?(goal: GoalRunRecord): Promise<boolean>;
  getGoalRun?(goalRunId: string): Promise<GoalRunRecord | null>;
  listGoalRuns?(conversationId?: string): Promise<GoalRunRecord[]>;
  updateGoalRun?(goal: GoalRunRecord, expectedRevision: number, fence?: GoalTurnFence): Promise<boolean>;
  saveConversation?(conversation: WebConversationRecord): Promise<void>;
  getConversation?(id: string): Promise<WebConversationRecord | null>;
  listConversations?(limit?: number): Promise<WebConversationRecord[]>;
  deleteConversation?(id: string): Promise<boolean>;
  appendConversationMessage?(conversationId: string, message: WebMessageRecord): Promise<void>;

  saveWebSession?(session: WebSessionRecord): Promise<void>;
  getWebSession?(sessionId: string): Promise<WebSessionRecord | null>;
  deleteWebSession?(sessionId: string): Promise<void>;
  cleanExpiredWebSessions?(): Promise<number>;

  // Scheduled Tasks & History Runs
  saveScheduledTask?(task: ScheduledTaskRecord): Promise<void>;
  getScheduledTask?(id: string): Promise<ScheduledTaskRecord | null>;
  listScheduledTasks?(filter?: { enabled?: boolean; targetType?: ScheduledTargetType; limit?: number; offset?: number }): Promise<ScheduledTaskRecord[]>;
  updateScheduledTask?(id: string, patch: Partial<ScheduledTaskRecord>): Promise<ScheduledTaskRecord | null>;
  deleteScheduledTask?(id: string): Promise<boolean>;

  saveScheduledTaskRun?(run: ScheduledTaskRunRecord): Promise<void>;
  getScheduledTaskRun?(runId: string): Promise<ScheduledTaskRunRecord | null>;
  listScheduledTaskRuns?(scheduledTaskId?: string, filter?: { status?: ScheduledTaskRunStatus; limit?: number; offset?: number }): Promise<ScheduledTaskRunRecord[]>;
  updateScheduledTaskRun?(runId: string, patch: Partial<ScheduledTaskRunRecord>): Promise<void>;

  // Security Decision Audit
  saveSecurityAudit?(record: SecurityAuditRecord): Promise<void>;
  getSecurityAudit?(id: string): Promise<SecurityAuditRecord | null>;
  listSecurityAudits?(filter?: SecurityAuditFilter): Promise<{ items: SecurityAuditRecord[]; total: number }>;
  updateSecurityAuditFeedback?(id: string, feedback: SecurityAuditFeedback): Promise<SecurityAuditRecord | null>;
  getSecurityAuditStats?(windowMs?: number): Promise<SecurityAuditStats>;
}

