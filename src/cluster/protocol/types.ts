import type { RuntimeReleaseInfo } from "../../runtime/release-info.js";
/**
 * Nash Cluster Protocol Types & Schemas (Phase 1)
 *
 * 统一跨节点通信协议规范 (WSS over TLS):
 * 1. 严格信封格式 (Envelope) 与单调时钟序列
 * 2. 节点身份握手与认证 (NodeHello / NodeAuthenticated / NodeRejected)
 * 3. 任务分发与状态机流转 (TaskDispatch / TaskAccepted / TaskRejected / TaskStarted / TaskProgress / TaskCompleted / TaskFailed / TaskCancelled)
 * 4. 远程双向控制 (TaskControl: Steer / Interrupt / Cancel + TaskControlAck)
 * 5. 远程提权审批 (ApprovalRequested / ApprovalResolved)
 * 6. 可靠单调事件批量回传 (EventBatch / EventAck)
 * 7. 心跳保活与代际同步 (Heartbeat / HeartbeatAck)
 */

import type { ApprovalCapability } from "../../approval/types.js";
import type { SandboxPolicy } from "../../sandbox/types.js";

export const CLUSTER_PROTOCOL_VERSION = "1.0" as const;
export type ClusterProtocolVersion = typeof CLUSTER_PROTOCOL_VERSION;

export type ClusterNodeType = "coordinator" | "worker" | "coordinator-worker";
export type NodeConnectionStatus = "connecting" | "authenticating" | "online" | "suspect" | "offline" | "revoked";

/**
 * 协议消息类型枚举
 */
export type ClusterMessageType =
  // 握手与注册
  | "node.hello"
  | "node.authenticated"
  | "node.rejected"
  | "node.heartbeat"
  | "node.heartbeat_ack"
  | "node.capabilities_updated"
  // 排空探针 (Coordinator → Worker，用于证明节点真实运行态)
  | "node.drain_probe"
  | "node.drain_status"
  // 任务生命周期
  | "task.dispatch"
  | "task.accepted"
  | "task.rejected"
  | "task.started"
  | "task.progress"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.result_ack"
  // 控制与中断
  | "task.control"
  | "task.control_ack"
  // 远程审批
  | "approval.requested"
  | "approval.resolved"
  | "approval.ack"
  // 任务级全访问授权
  | "task.grant_security"
  | "task.grant_security_ack"
  | "task.revoke_security"
  | "task.revoke_security_ack"
  /**
   * Worker → Coordinator：本地审批等待超时，裁决已 Fail-Closed 为 deny。
   * 用于让 Coordinator 把持久化审批记录从 pending 收敛为 resolved，避免永久悬挂。
   */
  | "approval.expired"
  // 集群目录与联邦记忆同步 (Phase 2)
  | "catalog.sync_snapshot"
  | "catalog.sync_snapshot_ack"
  | "catalog.sync_delta"
  | "catalog.sync_delta_ack"
  | "catalog.sync_status"
  // 远程记忆检索 (Phase 2)
  | "memory.search_remote_request"
  | "memory.search_remote_response"
  // 事件批量同步与确认
  | "event.batch"
  | "event.ack"
  | "event.resume_request"
  | "event.resume_response"
  // 分布式任务图与跨节点协同 (Phase 4)
  | "graph.task_ready"
  | "graph.task_started"
  | "graph.task_completed"
  | "graph.task_failed"
  | "graph.replan_requested"
  | "graph.revision_committed"
  // 跨节点分布式 Agent 邮箱 A2A (Phase 4)
  | "agent.message_send"
  | "agent.message_deliver"
  | "agent.message_ack"
  // 跨节点产物交换 Artifact Exchange (Phase 4)
  | "artifact.ready"
  | "artifact.transfer_requested"
  | "artifact.transfer_chunk"
  | "artifact.transfer_completed"
  // 任务图级全局控制 (Phase 4)
  | "graph.control"
  | "graph.control_ack"
  // 错误报告
  | "error";

/**
 * 统一协议消息信封
 */
export interface ClusterEnvelope<T = unknown> {
  protocolVersion: ClusterProtocolVersion;
  messageId: string;
  correlationId?: string;
  sourceNodeId: string;
  targetNodeId: string;
  timestamp: number;
  type: ClusterMessageType;
  payload: T;
}

/**
 * 节点硬件与运行环境元数据
 */
export interface NodeMetadata {
  nodeId: string;
  name: string;
  role: ClusterNodeType;
  platform: "darwin" | "linux" | "win32" | string;
  arch: string;
  hostname: string;
  nodeVersion: string;
  nashVersion: string;
  runtimeRelease?: Readonly<RuntimeReleaseInfo>;
  sandboxBackend: "seatbelt" | "bubblewrap" | "landlock" | "windows-sandbox" | "none";
  capabilities: string[];
  maxConcurrentRuns: number;
  projects?: Array<{
    projectId: string;
    name: string;
    canonicalPath?: string;
  }>;
}

/**
 * NodeHello Payload
 */
export interface NodeHelloPayload {
  nodeId: string;
  name: string;
  platform: string;
  arch: string;
  hostname: string;
  nodeVersion: string;
  nashVersion: string;
  runtimeRelease?: Readonly<RuntimeReleaseInfo>;
  sandboxBackend: string;
  capabilities: string[];
  maxConcurrentRuns: number;
  projects: Array<{
    projectId: string;
    name: string;
  }>;
  /** 节点预先颁发或配对成功的持久 token */
  nodeToken?: string;
  /** 若首次加入集群，提供一次性邀请码配对凭证 */
  inviteCode?: string;
}

/**
 * NodeAuthenticated Payload
 */
export interface NodeAuthenticatedPayload {
  assignedNodeId: string;
  nodeToken: string;
  coordinatorVersion: string;
  connectionGeneration: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

/**
 * NodeRejected Payload
 */
export interface NodeRejectedPayload {
  reason: string;
  code: "INVALID_TOKEN" | "EXPIRED_INVITE" | "ALREADY_CONNECTED" | "UNSUPPORTED_VERSION" | "REVOKED" | "INTERNAL_ERROR";
}

/**
 * Heartbeat Payload
 */
export interface HeartbeatPayload {
  nodeId: string;
  timestamp: number;
  generation: number;
  activeTasksCount: number;
  lastAcknowledgedSeq?: Record<string, number>; // taskId -> seq
}

/**
 * HeartbeatAck Payload
 */
export interface HeartbeatAckPayload {
  timestamp: number;
  generation: number;
  coordinatorTime: number;
}

/**
 * DrainProbe Payload (Coordinator → Worker)
 *
 * 排空状态必须由节点真实运行态证明，不能用数据库任务计数代替：
 * 主动向 Worker 询问其当前真正持有的执行实例。
 */
export interface NodeDrainProbePayload {
  probeId: string;
  requestedAt: number;
}

/**
 * DrainStatus Payload (Worker → Coordinator)
 *
 * activeTaskIds 来自 Worker 进程内真实的 Runner 注册表；
 * acceptingTasks 表示 Worker 是否仍会接受新的分派。
 */
export interface NodeDrainStatusPayload {
  nodeId: string;
  probeId: string;
  activeRuns: number;
  activeTaskIds: string[];
  pendingDispatches: number;
  acceptingTasks: boolean;
  respondingAt: number;
}

/**
 * TaskDispatch Payload
 */
export interface TaskArtifact { name: string; contentType?: string; content: string; }

export interface GraphTaskContext {
  traceId?: string;
  parentSpanId?: string;
  conversationId?: string;
  executionAttempt?: number;
  retryOfTaskId?: string;
  graphId: string;
  graphRevision?: number;
  graphNodeId: string;
  inputs: Array<TaskArtifact & { artifactId: string; producerNodeId: string; producerTaskId?: string; sha256: string }>;
  outputs: Array<{ name: string; contentType: string }>;
}

export interface TaskDispatchPayload {
  taskId: string;
  runId: string;
  projectId: string;
  goal: string;
  prompt?: string;
  timeoutMs?: number;
  maxSteps?: number;
  dispatchAttempt: number;
  idempotencyKey?: string;
  connectionGeneration: number;
  contextOverrides?: Record<string, unknown>;
  graphContext?: GraphTaskContext;
}

/**
 * TaskAccepted Payload
 */
export interface TaskAcceptedPayload {
  taskId: string;
  runId: string;
  nodeId: string;
  acceptedAt: number;
}

/**
 * TaskRejected Payload
 */
export interface TaskRejectedPayload {
  taskId: string;
  runId: string;
  nodeId: string;
  reason: string;
  code: "PROJECT_NOT_FOUND" | "PROJECT_ACCESS_DENIED" | "SANDBOX_UNAVAILABLE" | "CONCURRENCY_EXCEEDED" | "ALREADY_RUNNING" | "OUTCOME_UNKNOWN";
}

/**
 * TaskStarted Payload
 */
export interface TaskStartedPayload {
  taskId: string;
  runId: string;
  nodeId: string;
  sessionId: string;
  startedAt: number;
}

/**
 * TaskProgress Payload
 */
export interface TaskProgressPayload {
  taskId: string;
  runId: string;
  nodeId: string;
  currentStep: number;
  maxSteps?: number;
  activitySummary: string;
  recentToolName?: string;
}

/**
 * TaskCompleted Payload
 */
export interface TaskCompletedPayload {
  taskId: string;
  runId: string;
  nodeId: string;
  completedAt: number;
  durationMs: number;
  finalAnswer: string;
  totalToolCalls: number;
  totalTokensUsed?: number;
  producedArtifacts?: TaskArtifact[];
  deliverables?: Array<{
    path: string;
    description: string;
  }>;
}

/**
 * TaskFailed Payload
 */
export interface TaskFailedPayload {
  taskId: string;
  runId: string;
  nodeId: string;
  failedAt: number;
  durationMs: number;
  error: string;
  errorCategory?: string;
  isRetryable: boolean;
  partialResult?: string;
}

/**
 * TaskCancelled Payload
 */
export interface TaskCancelledPayload {
  taskId: string;
  runId: string;
  nodeId: string;
  cancelledAt: number;
  reason: string;
}

/**
 * TaskControl Action
 */
export type TaskControlAction = "steer" | "interrupt" | "cancel";

/**
 * TaskControl Payload
 */
export interface TaskControlPayload {
  commandId: string;
  taskId: string;
  runId?: string;
  action: TaskControlAction;
  /** 仅针对 steer 动作包含的调整内容 */
  steerContent?: string;
  reason?: string;
  timestamp: number;
}

/**
 * TaskControlAck Payload
 */
export interface TaskControlAckPayload {
  commandId: string;
  taskId: string;
  action: TaskControlAction;
  status: "applied" | "queued" | "rejected" | "failed";
  message?: string;
}

/**
 * ApprovalRequested Payload
 */
export interface RemoteApprovalRequestPayload {
  approvalId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  agentId: string;
  agentName: string;
  capability: ApprovalCapability;
  reason: string;
  target?: string;
  toolName?: string;
  toolArgsSummary?: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * ApprovalExpired Payload (Worker → Coordinator)
 *
 * Worker 端审批等待超时后必须显式告知 Coordinator，否则持久化记录会永远停留在 pending。
 * 裁决固定为 deny（Fail-Closed），reason 说明超时来源。
 */
export interface RemoteApprovalExpiredPayload {
  approvalId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  decision: "deny";
  reason: string;
  resolvedAt: number;
}

/**
 * ApprovalResolved Payload
 */
export interface RemoteApprovalResolvePayload {
  approvalId: string;
  taskId: string;
  runId: string;
  decision: "allow-once" | "deny";
  resolvedAt: number;
  resolvedBy?: string;
}

/**
 * 任务级全访问授权下发 Payload (Coordinator → Worker)
 *
 * 作用域严格限定：只影响该 Task/Run 后续工具调用派生出的进程；
 * 已在运行的进程（后台 Job、已启动的 stdio MCP 子进程）保持原有隔离。
 */
export interface TaskGrantSecurityPayload {
  grantId: string;
  approvalId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  targetPolicy: SandboxPolicy;
  configurationVersion: number;
  grantedAt: number;
  authorizedBy: string;
}

/**
 * 任务级全访问授权确认 Payload (Worker → Coordinator)
 */
export interface TaskGrantSecurityAckPayload {
  grantId: string;
  approvalId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  applied: boolean;
  effectivePolicy?: SandboxPolicy;
  appliedAt: number;
  /** 明确声明作用域，避免把「已运行进程」误报为已提权。 */
  appliesTo?: "subsequent-tool-calls";
  affectsRunningProcesses?: false;
  error?: string;
}

/**
 * 撤销任务级全访问授权 (Coordinator → Worker)
 *
 * Worker 收到后必须把该 Task/Run 恢复到授权前的策略，并 ACK。
 * 离线/ACK 丢失时 Coordinator 只能记为 revocation_pending，绝不可假装已撤销。
 */
export interface TaskRevokeSecurityPayload {
  grantId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  reason: string;
  revokedBy?: string;
}

/**
 * 撤销任务级全访问授权确认 (Worker → Coordinator)
 */
export interface TaskRevokeSecurityAckPayload {
  grantId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  /** runner 上已不存在该授权（或从未生效）时为 true。 */
  reverted: boolean;
  restoredPolicy?: SandboxPolicy;
  revokedAt: number;
  error?: string;
}

/**
 * 单条持久化执行事件
 */
export interface SequencedEvent {
  seq: number;
  taskId: string;
  runId: string;
  nodeId: string;
  eventType: string;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * EventBatch Payload
 */
export interface EventBatchPayload {
  taskId: string;
  runId: string;
  nodeId: string;
  events: SequencedEvent[];
}

/**
 * EventAck Payload
 */
export interface EventAckPayload {
  taskId: string;
  runId: string;
  lastAckedSeq: number;
}

/**
 * EventResumeRequest Payload
 */
export interface EventResumeRequestPayload {
  taskId: string;
  runId: string;
  fromSeq: number;
}

/**
 * EventResumeResponse Payload
 */
export interface EventResumeResponsePayload {
  taskId: string;
  runId: string;
  fromSeq: number;
  events: SequencedEvent[];
}

/**
 * ErrorMessage Payload
 */
export interface ClusterErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// ============================================================
// Phase 2: Cluster Catalog & Federated Memory Protocol Types
// ============================================================

/**
 * 硬件与能力检测/验证状态
 * 严格区分操作系统物理检测到与实际可执行配置
 */
export type CapabilityVerificationStatus =
  | "detected"
  | "available"
  | "configured"
  | "verified"
  | "degraded"
  | "unavailable"
  | "unknown";

export interface SandboxCapabilityDetails {
  backend: "seatbelt" | "bubblewrap" | "landlock" | "windows-sandbox" | "none";
  installed: boolean;
  operational: boolean;
  filesystemIsolationVerified: boolean;
  networkIsolationVerified: boolean;
  processIsolationVerified: boolean;
  supportedPolicies: Array<"read-only" | "workspace-write" | "full-capability" | "danger-full-access">;
  supportedNetworkModes: Array<"deny" | "allow">;
  requiresWslForRestrictedExecution?: boolean;
  verifiedAt?: number;
  verificationExpiresAt?: number;
  failureReason?: string;
  helperPath?: string;
  helperSha256?: string;
}

export interface NodeHardwareCapability {
  name: string;
  category: "cpu" | "gpu" | "memory" | "sandbox" | "runtime" | "other";
  status: CapabilityVerificationStatus;
  details: string;
  detectionMethod: string;
  detectedAt: number;
  verifiedAt?: number;
  structuredDetails?: SandboxCapabilityDetails;
}

/**
 * 项目目录公开权限
 */
export type ProjectVisibility =
  | "not_published"
  | "discoverable"
  | "summary"
  | "retrievable";

/**
 * 项目目录条目
 */
export interface ProjectCatalogItem {
  projectId: string;
  nodeId: string;
  name: string;
  summary: string;
  description: string;
  technologies: string[];
  capabilities: string[];
  status: "active" | "archived" | "migrated";
  registeredAt: number;
  updatedAt: number;
  lastIndexedAt: number;
  revision: number;
  visibility: ProjectVisibility;
  canonicalPath?: string;
  userAliases?: string[];
}

/**
 * Skill 能力条目
 */
export interface SkillCatalogItem {
  skillId: string;
  nodeId: string;
  projectId?: string;
  name: string;
  description: string;
  scope: "global" | "project";
  tags: string[];
  fingerprint: string;
  available: boolean;
  updatedAt: number;
}

/**
 * MCP Server 状态
 */
export type MCPCapabilityStatus =
  | "configured"
  | "connected"
  | "available"
  | "needs_auth"
  | "disabled"
  | "failed"
  | "unknown";

/**
 * MCP Tool 条目
 */
export interface MCPToolCatalogItem {
  toolName: string;
  description: string;
  parameterNames: string[];
  riskClassification: "read-only" | "idempotent-write" | "destructive" | "unknown";
  available: boolean;
}

/**
 * MCP Server 能力条目
 */
export interface MCPCapabilityCatalogItem {
  serverId: string;
  nodeId: string;
  displayName: string;
  transportType: "streamable-http" | "stdio" | "sse";
  status: MCPCapabilityStatus;
  capabilitySummary: string;
  tools: MCPToolCatalogItem[];
  resourceCount: number;
  promptCount: number;
  lastVerifiedAt: number;
  revision: number;
}

/**
 * 联邦记忆摘要条目 (轻量索引，源码/私密知识留存在 Worker)
 */
export interface FederatedMemoryIndexItem {
  entryId: string;
  nodeId: string;
  projectId: string;
  topic: string;
  summary: string;
  keywords: string[];
  sourceReference: string;
  confidence: number;
  visibility: "summary" | "retrievable";
  revision: number;
  updatedAt: number;
}

export type CatalogResourceType = "project" | "skill" | "mcp" | "memory";

/**
 * 资源删除/共享撤销墓碑 (Tombstone)
 */
export interface CatalogTombstoneItem {
  resourceType: CatalogResourceType;
  resourceId: string;
  nodeId?: string;
  projectId?: string;
  deletedAt: number;
  revision: number;
}

/**
 * Catalog 增量同步 Payload
 */
export interface CatalogSyncDeltaPayload {
  nodeId: string;
  catalogRevision: number;
  hardwareCapabilities?: NodeHardwareCapability[];
  projectsUpsert?: ProjectCatalogItem[];
  projectsDelete?: CatalogTombstoneItem[];
  skillsUpsert?: SkillCatalogItem[];
  skillsDelete?: CatalogTombstoneItem[];
  mcpUpsert?: MCPCapabilityCatalogItem[];
  mcpDelete?: CatalogTombstoneItem[];
  memoryIndexUpsert?: FederatedMemoryIndexItem[];
  /** True only when memoryIndexUpsert contains the complete current Worker memory index. */
  memoryIndexComplete?: boolean;
  memoryIndexDelete?: CatalogTombstoneItem[];
}

/**
 * Catalog 增量同步确认 Payload
 */
export interface CatalogSyncDeltaAckPayload {
  nodeId: string;
  catalogRevision: number;
  appliedAt: number;
  status: "ok" | "rejected" | "reconcile_required";
  reason?: string;
}

/**
 * Catalog 全量快照 Payload
 */
export interface CatalogSyncSnapshotPayload {
  nodeId: string;
  catalogRevision: number;
  hardwareCapabilities: NodeHardwareCapability[];
  projects: ProjectCatalogItem[];
  skills: SkillCatalogItem[];
  mcp: MCPCapabilityCatalogItem[];
  memoryIndex: FederatedMemoryIndexItem[];
}

/**
 * Catalog 全量快照确认 Payload
 */
export interface CatalogSyncSnapshotAckPayload {
  nodeId: string;
  catalogRevision: number;
  appliedAt: number;
  status: "ok" | "rejected";
  reason?: string;
}

/**
 * 第二级远程记忆检索请求 Payload
 */
export interface RemoteMemorySearchPayload {
  requestId: string;
  nodeId: string;
  projectId: string;
  query: string;
  topK?: number;
  maxTokens?: number;
  scope?: "project" | "all";
  minConfidence?: number;
  timeoutMs?: number;
}

/**
 * 远程记忆检索单条结果
 */
export interface RemoteMemorySearchResultItem {
  memoryId: string;
  topic: string;
  snippet: string;
  score: number;
  confidence: number;
  source: string;
  updatedAt: string;
}

/**
 * 第二级远程记忆检索响应 Payload
 */
export interface RemoteMemorySearchResponsePayload {
  requestId: string;
  nodeId: string;
  projectId: string;
  results: RemoteMemorySearchResultItem[];
  totalFound: number;
  retrievalStatus: "ok" | "permission_denied" | "project_not_found" | "error";
  error?: string;
  latencyMs: number;
}

/**
 * ==========================================
 * Phase 4: 分布式任务图与跨节点协同 Payloads
 * ==========================================
 */

export interface GraphTaskReadyPayload {
  graphId: string;
  graphNodeId: string;
  taskId: string;
  assignedNodeId: string;
  assignedProjectId: string;
  goal: string;
  operation: string;
  requiredArtifacts: string[];
  acceptanceCriteria: Array<{
    type: string;
    description: string;
    expected?: unknown;
  }>;
}

export interface GraphTaskStartedPayload {
  graphId: string;
  graphNodeId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  startedAt: number;
}

export interface GraphTaskCompletedPayload {
  graphId: string;
  graphNodeId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  resultSummary: string;
  producedArtifacts: Array<{
    artifactId: string;
    name: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }>;
  completedAt: number;
}

export interface GraphTaskFailedPayload {
  graphId: string;
  graphNodeId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  error: string;
  failurePolicy: string;
  failedAt: number;
}

export interface GraphReplanRequestedPayload {
  graphId: string;
  trigger: string;
  reason: string;
  failedNodeId?: string;
  requestedAt: number;
}

export interface GraphRevisionCommittedPayload {
  graphId: string;
  revision: number;
  reason: string;
  addedNodes: string[];
  removedNodes: string[];
  committedAt: number;
}

export interface AgentMessageSendPayload {
  messageId: string;
  graphId: string;
  sourceNodeId: string;
  sourceAgentId: string;
  sourceTaskId?: string;
  targetNodeId: string;
  targetAgentId: string;
  targetTaskId?: string;
  messageType: string;
  correlationId?: string;
  payload: Record<string, unknown>;
  sentAt: number;
  expiresAt: number;
}

export interface AgentMessageDeliverPayload {
  messageId: string;
  graphId: string;
  sourceNodeId: string;
  sourceAgentId: string;
  targetNodeId: string;
  targetAgentId: string;
  messageType: string;
  correlationId?: string;
  payload: Record<string, unknown>;
  deliveredAt: number;
}

export interface AgentMessageAckPayload {
  messageId: string;
  graphId: string;
  targetNodeId: string;
  targetAgentId: string;
  status: "acknowledged" | "rejected" | "expired";
  reason?: string;
  acknowledgedAt: number;
}

export interface ArtifactReadyPayload {
  artifactId: string;
  graphId: string;
  producerTaskId: string;
  producerNodeId: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface ArtifactTransferRequestPayload {
  artifactId: string;
  graphId: string;
  requesterNodeId: string;
  requesterTaskId: string;
  offset?: number;
  length?: number;
}

export interface ArtifactTransferChunkPayload {
  artifactId: string;
  graphId: string;
  chunkIndex: number;
  totalChunks: number;
  dataBase64: string;
  isLast: boolean;
  sha256Part: string;
}

export interface ArtifactTransferCompletedPayload {
  artifactId: string;
  graphId: string;
  requesterNodeId: string;
  requesterTaskId: string;
  sizeBytes: number;
  sha256: string;
  completedAt: number;
}

export type GraphControlAction = "pause" | "resume" | "cancel" | "steer" | "replan";

export interface GraphControlPayload {
  controlId: string;
  graphId: string;
  action: GraphControlAction;
  payload?: Record<string, unknown>;
  issuedAt: number;
}

export interface GraphControlAckPayload {
  controlId: string;
  graphId: string;
  action: GraphControlAction;
  status: "applied" | "rejected" | "failed";
  reason?: string;
  appliedAt: number;
}

