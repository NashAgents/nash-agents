import { ConversationSnapshots } from "./conversation-snapshots.js";
import { assertGoalTurnFence, ownedByForeignLiveTurn } from "./goal-turn-fence.js";
import { recordGraphCoverage } from "./goal-coverage-contract.js";
import { defaultTraceContext } from "../../observability/trace-context.js";
import { decodeScheduledTask, decodeScheduledRun } from "./scheduled-records.js";
import type { RuntimeSpan } from "../../observability/runtime-phase.js";
import type { ModelUsageRecord } from "../../observability/model-usage.js";
import * as crypto from "node:crypto";
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
  RevisionConflictError,
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
import { ClusterDatabase } from "./db.js";
import { decideScheduleAdmission } from "../scheduled/schedule-admission.js";

import {
  ClusterStorageError,
  type ClusterNodeRecord,
  type ClusterTaskStatus,
  CLUSTER_TASK_TERMINAL,
  canTransitionTask,
  type ClusterTaskRecord,
  type ClusterApprovalRecord,
  type TaskSecurityGrant,
  type TaskSecurityGrantFilter,
  type TaskSecurityGrantTransitionDetails,
  type ClusterOutboxRecord,
  type ClusterRouteRecord,
  type WebMessageRecord,
  type GoalRunRecord,
  type GoalTurnFence,
  type ConversationTitleSource,
  type WebConversationRecord,
  type WebSessionRecord,
  type ScheduleTriggerType,
  type ScheduledTargetType,
  type ScheduleConcurrencyPolicy,
  type ScheduleMisfirePolicy,
  type ScheduledTaskRunStatus,
  type ScheduledTaskRecord,
  type ScheduledTaskRunRecord,
  type SecurityDecisionSource,
  type SecurityReviewStatus,
  type SecurityAuditFeedback,
  type SecurityAuditRecord,
  type SecurityAuditFilter,
  type SecurityAuditStats,
  type GraphCreation,
  type IClusterStore
} from "./cluster-store-types.js";
import { validateWorkerMemorySnapshot, validateCatalogSnapshot } from "./store-validation.js";

export class InMemoryClusterStore implements IClusterStore {
  private assertForegroundFence(): void {
    const trace = defaultTraceContext.get();
    if (!trace?.goalTurnFence) return;
    const goal = trace.goalRunId && this.goalRuns.get(trace.goalRunId);
    if (!goal) throw new ClusterStorageError("GoalRun not found");
    assertGoalTurnFence(goal, trace.goalTurnFence, Date.now());
  }
  private readonly goalRuns = new Map<string, GoalRunRecord>();
  async claimGoalTurnLease(goalRunId: string, turnId: string, ownerId: string, ttlMs: number): Promise<GoalRunRecord["turnLease"] | null> {
    if (!ownerId || !turnId || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ClusterStorageError("Invalid GoalRun turn lease");
    const goal = this.goalRuns.get(goalRunId);
    if (!goal) throw new ClusterStorageError("GoalRun not found");
    const conversation = this.conversations.get(goal.conversationId);
    const turn = conversation?.messages.filter(message => message.sender === "user" && (message.id === goal.userMessageId || message.metadata?.goalRunId === goalRunId)).at(-1);
    if (turn?.id !== turnId || conversation?.messages.some(message => message.sender === "assistant" && message.metadata?.goalRunId === goalRunId && message.metadata?.goalRunTurnId === turnId)) return null;
    const now = Date.now();
    if (goal.turnLease && goal.turnLease.expiresAt > now) return null;
    const generation = (goal.turnLeaseGeneration ?? 0) + 1;
    const lease = { ownerId, turnId, generation, expiresAt: now + ttlMs };
    this.goalRuns.set(goalRunId, { ...goal, turnLease: lease, turnLeaseGeneration: generation, turnRecovery: undefined, status: "planning", executionState: "running", currentStage: "planning", finalReport: undefined, reportFingerprint: undefined, reportState: "pending", completedAt: undefined, revision: goal.revision + 1, updatedAt: now });
    return structuredClone(lease);
  }
  async renewGoalTurnLease(goalRunId: string, ownerId: string, generation: number, ttlMs: number): Promise<boolean> {
    if (!ownerId || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ClusterStorageError("Invalid GoalRun turn lease");
    const goal = this.goalRuns.get(goalRunId), now = Date.now();
    const lease = goal?.turnLease;
    if (!goal || !lease || lease.ownerId !== ownerId || lease.generation !== generation || lease.expiresAt <= now) return false;
    this.goalRuns.set(goalRunId, { ...goal, turnLease: { ...lease, expiresAt: now + ttlMs }, revision: goal.revision + 1, updatedAt: now });
    return true;
  }
  async releaseGoalTurnLease(goalRunId: string, ownerId: string, generation: number): Promise<boolean> {
    if (!ownerId) throw new ClusterStorageError("Invalid GoalRun turn owner");
    const goal = this.goalRuns.get(goalRunId), lease = goal?.turnLease;
    if (!goal || !lease || lease.ownerId !== ownerId || lease.generation !== generation) return false;
    const now = Date.now();
    this.goalRuns.set(goalRunId, { ...goal, turnLease: undefined, revision: goal.revision + 1, updatedAt: now });
    return true;
  }
  async executeGoalTaskControl(goalRunId: string, fence: GoalTurnFence, taskId: string, status: "cancelled" | "cancelling" | "outcome_unknown" | undefined, reason: string | undefined, send?: () => void): Promise<boolean> {
    const goal = this.goalRuns.get(goalRunId), task = this.tasks.get(taskId);
    if (!goal || !goal.linkedTaskIds.includes(taskId)) throw new ClusterStorageError("Task is not owned by the fenced GoalRun");
    assertGoalTurnFence(goal, fence, Date.now());
    if (!task || CLUSTER_TASK_TERMINAL.has(task.status) || (task.status === "outcome_unknown" && status !== "outcome_unknown") || (status && !canTransitionTask(task.status, status))) return false;
    const before = structuredClone(task);
    if (status) {
      task.status = status; task.updatedAt = Date.now();
      if (reason) task.error = reason;
      if (CLUSTER_TASK_TERMINAL.has(status)) task.completedAt = Date.now();
    }
    try { send?.(); } catch (error) { this.tasks.set(taskId, before); throw error; }
    return true;
  }
  async createGoalRunWithConversation(goal: GoalRunRecord, conversation: WebConversationRecord, initialLease?: { ownerId: string; ttlMs: number }): Promise<boolean> {
    if (goal.conversationId !== conversation.id || !conversation.messages.some(message => message.id === goal.userMessageId && message.sender === "user" && message.metadata?.goalRunId === goal.goalRunId)) throw new ClusterStorageError("Invalid GoalRun user message ownership");
    if (this.goalRuns.has(goal.goalRunId) || [...this.goalRuns.values()].some(item => item.conversationId === goal.conversationId && item.userMessageId === goal.userMessageId)) return false;
    const current = this.conversations.get(conversation.id);
    if (!current) throw new ClusterStorageError("GoalRun conversation not found");
    if (current.messages.some(message => message.id === goal.userMessageId)) throw new ClusterStorageError("GoalRun user message ID already exists");
    const merged = this.conversationSnapshots.merge(conversation, current);
    if (initialLease && (!initialLease.ownerId || !Number.isSafeInteger(initialLease.ttlMs) || initialLease.ttlMs < 1)) throw new ClusterStorageError("Invalid GoalRun turn lease");
    const storedGoal = structuredClone(initialLease ? { ...goal, turnLeaseGeneration: 1, turnLease: { ownerId: initialLease.ownerId, turnId: goal.userMessageId, generation: 1, expiresAt: Date.now() + initialLease.ttlMs } } : goal);
    this.conversations.set(conversation.id, merged);
    this.goalRuns.set(goal.goalRunId, storedGoal);
    this.conversationSnapshots.remember(conversation);
    return true;
  }
  async continueGoalRunWithConversation(goalRunId: string, conversation: WebConversationRecord, turnId: string, ownerId: string, ttlMs: number): Promise<GoalRunRecord["turnLease"] | null> {
    if (!ownerId || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ClusterStorageError("Invalid GoalRun turn lease");
    const goal = this.goalRuns.get(goalRunId), current = this.conversations.get(conversation.id);
    const turn = conversation.messages.find(message => message.id === turnId && message.sender === "user" && message.metadata?.goalRunId === goalRunId);
    if (!goal || goal.conversationId !== conversation.id || !current || !turn) throw new ClusterStorageError("Invalid GoalRun user message ownership");
    if (current.messages.some(message => message.id === turnId) || current.messages.some(message => message.sender === "user" && !conversation.messages.some(item => item.id === message.id))) return null;
    const now = Date.now();
    if (goal.turnLease && goal.turnLease.expiresAt > now) return null;
    const generation = (goal.turnLeaseGeneration ?? 0) + 1;
    const lease = { ownerId, turnId, generation, expiresAt: now + ttlMs };
    const merged = this.conversationSnapshots.merge(conversation, current);
    this.conversations.set(conversation.id, merged);
    this.goalRuns.set(goalRunId, { ...goal, turnLease: lease, turnLeaseGeneration: generation, turnRecovery: undefined, status: "planning", executionState: "running", currentStage: "planning", finalReport: undefined, reportFingerprint: undefined, reportState: "pending", completedAt: undefined, revision: goal.revision + 1, updatedAt: now });
    this.conversationSnapshots.remember(conversation);
    return structuredClone(lease);
  }
  async commitGoalTurnResponse(goalRunId: string, message: WebMessageRecord, fence?: GoalTurnFence): Promise<{ goal: GoalRunRecord; inserted: boolean }> {
    const goal = this.goalRuns.get(goalRunId);
    const conversation = goal && this.conversations.get(goal.conversationId);
    const turnId = message.metadata?.goalRunTurnId;
    if (!goal || !conversation || message.conversationId !== goal.conversationId || message.sender !== "assistant" || message.metadata?.goalRunId !== goalRunId || typeof turnId !== "string") throw new ClusterStorageError("Invalid GoalRun response ownership");
    const turn = conversation.messages.find(item => item.id === turnId && item.sender === "user");
    if (!turn || (turn.id !== goal.userMessageId && turn.metadata?.goalRunId !== goalRunId)) throw new ClusterStorageError("GoalRun response turn is not linked");
    if (conversation.messages.some(item => item.sender === "assistant" && item.metadata?.goalRunId === goalRunId && item.metadata?.goalRunTurnId === turnId)) return { goal: structuredClone(goal), inserted: false };
    assertGoalTurnFence(goal, fence, Date.now());
    if (fence && fence.turnId !== turnId) throw new ClusterStorageError("GoalRun response turn fence mismatch");
    if (conversation.messages.some(item => item.id === message.id)) throw new ClusterStorageError("GoalRun response message ID already exists");
    const latestTurn = conversation.messages.filter(item => item.sender === "user" && (item.id === goal.userMessageId || item.metadata?.goalRunId === goalRunId)).at(-1);
    if (latestTurn?.id !== turnId) throw new ClusterStorageError("Stale GoalRun response turn");
    const next = { ...goal, turnLease: undefined, ...(message.metadata?.recoveredTurn === true ? { turnRecovery: { turnId, recoveredAt: Date.now() } } : {}), currentStage: "awaiting_verification", interimReport: message.content, interimMessageId: message.id,
      reportRevision: goal.reportRevision + 1, revision: goal.revision + 1, updatedAt: Date.now() };
    const updated = structuredClone(conversation);
    updated.messages.push(structuredClone(message));
    updated.updatedAt = Math.max(updated.updatedAt, message.timestamp);
    this.conversations.set(updated.id, updated);
    this.goalRuns.set(goalRunId, next);
    return { goal: structuredClone(next), inserted: true };
  }
  async createGoalRun(goal: GoalRunRecord): Promise<boolean> {
    if (this.goalRuns.has(goal.goalRunId) || [...this.goalRuns.values()].some(g => g.conversationId === goal.conversationId && g.userMessageId === goal.userMessageId)) return false;
    this.goalRuns.set(goal.goalRunId, structuredClone(goal));
    return true;
  }
  async getGoalRun(id: string): Promise<GoalRunRecord | null> { return structuredClone(this.goalRuns.get(id) ?? null); }
  async listGoalRuns(conversationId?: string): Promise<GoalRunRecord[]> {
    return structuredClone([...this.goalRuns.values()].filter(g => !conversationId || g.conversationId === conversationId).sort((a, b) => b.createdAt - a.createdAt));
  }
  async updateGoalRun(goal: GoalRunRecord, expectedRevision: number, fence?: GoalTurnFence): Promise<boolean> {
    const previous = this.goalRuns.get(goal.goalRunId);
    if (!previous || previous.revision !== expectedRevision || goal.revision !== expectedRevision + 1 || previous.conversationId !== goal.conversationId || previous.userMessageId !== goal.userMessageId) return false;
    if (fence) assertGoalTurnFence(previous, fence, Date.now());
    this.goalRuns.set(goal.goalRunId, structuredClone(goal));
    return true;
  }
  private readonly runtimeSpans = new Map<string, RuntimeSpan>();
  async saveRuntimeSpan(span: RuntimeSpan): Promise<void> {
    const old = this.runtimeSpans.get(span.spanId);
    if (!old || old.endTime === undefined && old.traceId === span.traceId && old.taskId === span.taskId) this.runtimeSpans.set(span.spanId, structuredClone(span));
  }
  async pruneStaleTelemetry(retentionDays: number): Promise<{ prunedSpans: number; prunedUsage: number }> {
    const cutoff = Date.now() - retentionDays * 86400000;
    let prunedSpans = 0; let prunedUsage = 0;
    for (const [id, span] of this.runtimeSpans) {
      if (span.startTime < cutoff) { this.runtimeSpans.delete(id); prunedSpans++; }
    }
    for (const [id, usage] of this.modelUsage) {
      if (usage.startedAt < cutoff) { this.modelUsage.delete(id); prunedUsage++; }
    }
    return { prunedSpans, prunedUsage };
  }

  async listRuntimeSpans(traceId: string, offset = 0, limit = 1000): Promise<RuntimeSpan[]> {
    return [...this.runtimeSpans.values()].filter(s => s.traceId === traceId).sort((a,b) => a.startTime - b.startTime || a.spanId.localeCompare(b.spanId)).slice(offset,offset+Math.min(1000,limit));
  }
  private readonly modelUsage = new Map<string, ModelUsageRecord>();
  async saveModelUsage(record: ModelUsageRecord): Promise<void> {
    const old = this.modelUsage.get(record.accountingId);
    if (!old || old.status === "started" && old.traceId === record.traceId && old.taskId === record.taskId) this.modelUsage.set(record.accountingId, structuredClone(record));
  }
  async listModelUsage(filter: { traceId?: string; graphId?: string; conversationId?: string; since?: number; until?: number; offset?: number; limit?: number }): Promise<ModelUsageRecord[]> {
    return [...this.modelUsage.values()].filter(r => (!filter.traceId || r.traceId === filter.traceId) && (!filter.graphId || r.graphId === filter.graphId) && (!filter.conversationId || r.conversationId === filter.conversationId) && r.startedAt >= (filter.since ?? 0) && r.startedAt <= (filter.until ?? Number.MAX_SAFE_INTEGER))
      .sort((a,b) => a.startedAt - b.startedAt || a.accountingId.localeCompare(b.accountingId)).slice(filter.offset ?? 0, (filter.offset ?? 0) + Math.min(1000, filter.limit ?? 100));
  }
  async purgeModelUsage(before: number): Promise<number> {
    let count = 0;
    for (const [id, record] of this.modelUsage) if (record.startedAt < before && record.status !== "started") { this.modelUsage.delete(id); count++; }
    return count;
  }

  private readonly nodes = new Map<string, ClusterNodeRecord>();
  private readonly tasks = new Map<string, ClusterTaskRecord>();
  private readonly events = new Map<string, SequencedEvent[]>(); // taskId -> events
  private readonly approvals = new Map<string, ClusterApprovalRecord>();
  private readonly taskGrants = new Map<string, TaskSecurityGrant>();
  private readonly outbox: ClusterOutboxRecord[] = [];
  private readonly inbox = new Set<string>();

  // Scheduled Tasks & Security Audits Maps
  private readonly scheduledTasks = new Map<string, ScheduledTaskRecord>();
  private readonly scheduledTaskRuns = new Map<string, ScheduledTaskRunRecord>();
  private readonly securityAudits = new Map<string, SecurityAuditRecord>();

  // Catalog & Memory Maps
  private readonly catalogRevisions = new Map<string, { revision: number; capabilities: NodeHardwareCapability[]; lastSyncAt: number; syncStatus: string }>();
  private readonly projectsCatalog = new Map<string, ProjectCatalogItem>(); // nodeId::projectId
  private readonly skillsCatalog = new Map<string, SkillCatalogItem>(); // nodeId::skillId
  private readonly mcpCatalog = new Map<string, MCPCapabilityCatalogItem>(); // nodeId::serverId
  private readonly memoryIndex = new Map<string, FederatedMemoryIndexItem>(); // nodeId::entryId
  private readonly tombstones: CatalogTombstoneItem[] = [];
  private readonly syncLogs: any[] = [];
  private readonly routes = new Map<string, ClusterRouteRecord>();
  private readonly replans = new Map<string, any>();

  // Phase 4 Maps
  private readonly graphs = new Map<string, DistributedGraphRecord>();
  private readonly graphNodes = new Map<string, DistributedGraphNodeRecord>(); // graphId::nodeId
  private readonly graphEdges = new Map<string, DistributedGraphEdgeRecord[]>(); // graphId -> edges
  private readonly graphRevisions = new Map<string, GraphRevisionRecord[]>(); // graphId -> revisions
  private readonly graphEvents = new Map<string, Array<{ seq: number; eventType: string; payload: any; createdAt: number }>>(); // graphId -> events
  private readonly graphVerifications = new Map<string, GraphVerificationRecord[]>(); // graphId -> verifications
  private readonly agentMessages = new Map<string, any>(); // messageId -> msg
  private readonly artifacts = new Map<string, any>(); // artifactId -> artifact
  private readonly artifactGrants = new Set<string>(); // artifactId::consumerNodeId::consumerTaskId
  private readonly graphControls = new Map<string, any[]>(); // graphId -> controls

  private readonly patchOperations = new Map<string, { hash: string; result: GraphPatchApplyResult }>();
  async createGraphAtomic(input: GraphCreation): Promise<void> {
    const data = structuredClone(input);
    if (this.graphs.has(data.graph.graphId)) throw new ClusterStorageError("Graph already exists");
    if (data.nodes.some(n => n.graphId !== data.graph.graphId) || data.edges.some(e => e.graphId !== data.graph.graphId)) throw new ClusterStorageError("Graph ownership mismatch");
    const goal = data.goalRunId ? this.goalRuns.get(data.goalRunId) : undefined;
    if (data.goalRunId && !goal) throw new ClusterStorageError("GoalRun not found");
    if (goal) assertGoalTurnFence(goal, data.goalTurnFence, Date.now());
    // No await in the commit: readers cannot observe an incomplete aggregate.
    this.graphs.set(data.graph.graphId, data.graph);
    for (const n of data.nodes) this.graphNodes.set(`${n.graphId}::${n.nodeId}`, n);
    this.graphEdges.set(data.graph.graphId, data.edges);
    this.graphRevisions.set(data.graph.graphId, [data.revision]);
    this.graphEvents.set(data.graph.graphId, [{ seq: 1, eventType: "graph.created", payload: data.event, createdAt: Date.now() }]);
    if (goal) {
      const updated = { ...goal, status: "running" as const, executionState: "running" as const, finalReport: undefined, reportFingerprint: undefined, reportState: "pending" as const, completedAt: undefined, linkedGraphIds: [...new Set([...goal.linkedGraphIds, data.graph.graphId])], revision: goal.revision + 1, updatedAt: Date.now() };
      recordGraphCoverage(updated, data.graph, data.nodes, "admitted_graph", Date.now());
      this.goalRuns.set(goal.goalRunId, updated);
    }
  }

  async saveTaskWithGoal(task: ClusterTaskRecord, goalRunId: string, fence?: GoalTurnFence): Promise<void> {
    const goal = this.goalRuns.get(goalRunId);
    if (!goal) throw new ClusterStorageError("GoalRun not found");
    if (fence || !task.dispatchOptions?.graphContext) assertGoalTurnFence(goal, fence, Date.now());
    if (this.tasks.has(task.taskId)) throw new ClusterStorageError("Task already exists");
    const stored = structuredClone(task);
    this.tasks.set(stored.taskId, { ...stored, updatedAt: Date.now() });
    this.goalRuns.set(goalRunId, { ...goal, status: "running", executionState: "running", finalReport: undefined, reportFingerprint: undefined, reportState: "pending", completedAt: undefined, linkedTaskIds: [...new Set([...goal.linkedTaskIds, task.taskId])], revision: goal.revision + 1, updatedAt: Date.now() });
  }
  async listGraphTaskAttempts(graphId: string, nodeId: string): Promise<ClusterTaskRecord[]> {
    return structuredClone([...this.tasks.values()].filter(task => task.dispatchOptions?.graphContext?.graphId === graphId && task.dispatchOptions.graphContext.graphNodeId === nodeId)
      .sort((a, b) => (a.dispatchOptions?.graphContext?.executionAttempt ?? 0) - (b.dispatchOptions?.graphContext?.executionAttempt ?? 0) || a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId)));
  }

  async claimScheduledTaskRun(candidate: ScheduledTaskRunRecord, force = false): Promise<{ run: ScheduledTaskRunRecord; admitted: boolean }> {
    this.assertForegroundFence();
    const task = this.scheduledTasks.get(candidate.scheduledTaskId);
    if (!task) throw new ClusterStorageError("Scheduled task not found");
    const result = decideScheduleAdmission(task, candidate, this.scheduledTaskRuns.get(candidate.id) ?? null,
      [...this.scheduledTaskRuns.values()].filter(r => r.scheduledTaskId === task.id && ["queued", "running", "outcome_unknown"].includes(r.status)), force);
    this.scheduledTaskRuns.set(result.run.id, structuredClone(result.run));
    return result;
  }

  async listScheduledTasksForExecution(afterId = "", limit = 100): Promise<ScheduledTaskRecord[]> {
    return [...this.scheduledTasks.values()].filter(t => t.enabled && t.id > afterId).sort((a,b) => a.id < b.id ? -1 : 1).slice(0, limit).map(t => structuredClone(t));
  }

  async listUnsettledScheduledRuns(afterId = "", limit = 100): Promise<ScheduledTaskRunRecord[]> {
    return [...this.scheduledTaskRuns.values()].filter(r => r.id > afterId && ["queued", "running", "outcome_unknown"].includes(r.status)).sort((a,b) => a.id < b.id ? -1 : 1).slice(0, limit).map(r => structuredClone(r));
  }

  async getScheduledRunByExecution(taskId?: string, graphId?: string): Promise<ScheduledTaskRunRecord | null> {
    const run = [...this.scheduledTaskRuns.values()].find(r => (taskId ? r.taskId === taskId : graphId && r.graphId === graphId) && ["running", "outcome_unknown"].includes(r.status));
    return run ? structuredClone(run) : null;
  }

  async getTaskCounts(): Promise<{ total: number; running: number }> {
    return { total: this.tasks.size, running: [...this.tasks.values()].filter(t => t.status === "running").length };
  }

  async findGraphNodeByTaskId(taskId: string): Promise<DistributedGraphNodeRecord | null> {
    return [...this.graphNodes.values()].find(n => n.taskId === taskId) ?? null;
  }

  async applyGraphPatchAtomic(patch: AtomicGraphPatchSpec): Promise<GraphPatchApplyResult> {
    const trace = defaultTraceContext.get();
    if (trace?.goalTurnFence) {
      const goal = trace.goalRunId && this.goalRuns.get(trace.goalRunId);
      if (!goal || !goal.linkedGraphIds.includes(patch.graphId)) throw new ClusterStorageError("Graph is not owned by the fenced GoalRun");
      assertGoalTurnFence(goal, trace.goalTurnFence, Date.now());
    }
    const key = `${patch.graphId}::${patch.operationId}`;
    const hash = crypto.createHash("sha256").update(JSON.stringify(patch)).digest("hex");
    const previous = patch.operationId ? this.patchOperations.get(key) : undefined;
    if (previous) {
      if (previous.hash !== hash) throw new Error("Graph patch operation ID reused with different content");
      return { ...previous.result, replayed: true };
    }
    const graph = this.graphs.get(patch.graphId);
    if (!graph || graph.revision !== patch.expectedRevision) return { success: false, conflict: true, graphId: patch.graphId, appliedRevision: graph?.revision ?? -1 };
    if (["cancelled", "cancelling", "completed", "outcome_unknown", "waiting_approval"].includes(graph.status)) return { success: false, graphId: patch.graphId, appliedRevision: graph.revision, error: "Graph state does not permit a patch" };
    for (const update of patch.updateNodes ?? []) {
      const node = this.graphNodes.get(`${patch.graphId}::${update.nodeId}`);
      if (!node || (["completed", "running", "accepted", "dispatched", "waiting_approval", "outcome_unknown"].includes(node.status) && node.status !== update.status)) return { success: false, graphId: patch.graphId, appliedRevision: graph.revision, conflict: true, error: "Graph node state changed before patch commit" };
    }
    if (patch.nextRevision !== patch.expectedRevision + 1) throw new Error("Graph revision must increment exactly once");
    const removed = new Set((patch.removeEdges ?? []).map((e) => `${e.fromNodeId}->${e.toNodeId}`));
    for (const node of patch.addNodes ?? []) this.graphNodes.set(`${patch.graphId}::${node.nodeId}`, structuredClone(node));
    for (const upd of patch.updateNodes ?? []) {
      const nodeKey = `${patch.graphId}::${upd.nodeId}`;
      const node = this.graphNodes.get(nodeKey);
      if (node) this.graphNodes.set(nodeKey, structuredClone(upd.record ?? { ...node, ...upd }));
    }
    this.graphEdges.set(patch.graphId, [...(this.graphEdges.get(patch.graphId) ?? []).filter((e) => !removed.has(`${e.fromNodeId}->${e.toNodeId}`)), ...(patch.addEdges ?? [])]);
    this.graphs.set(patch.graphId, { ...graph, revision: patch.nextRevision, status: patch.newGraphStatus ?? graph.status, error: patch.graphError ?? graph.error, finalSummary: patch.graphFinalSummary ?? graph.finalSummary, updatedAt: Date.now() });
    const now = Date.now();
    for (const [id, goal] of this.goalRuns) {
      if (!goal.linkedGraphIds.includes(patch.graphId)) continue;
      // The new revision invalidates any prior verdict either way, but restarting delivery state
      // (status/report) belongs to the turn that owns the GoalRun; a background patch must not
      // erase a report another live turn has already delivered.
      const updated = ownedByForeignLiveTurn(goal, now)
        ? { ...goal, revision: goal.revision + 1, updatedAt: now }
        : { ...goal, status: "running" as const, executionState: "running" as const, finalReport: undefined, reportFingerprint: undefined, reportState: "pending" as const, completedAt: undefined, revision: goal.revision + 1, updatedAt: now };
      const revisedGraph = this.graphs.get(patch.graphId)!;
      recordGraphCoverage(updated, revisedGraph, [...this.graphNodes.values()].filter(node => node.graphId === patch.graphId), "graph_replan", now);
      this.goalRuns.set(id, updated);
    }
    const revisions = this.graphRevisions.get(patch.graphId) ?? [];
    this.graphRevisions.set(patch.graphId, [...revisions, { graphId: patch.graphId, revision: patch.nextRevision, reason: patch.reason, diffSummary: patch.diffSummary ?? {}, createdAt: Date.now() }]);
    const events = this.graphEvents.get(patch.graphId) ?? [];
    events.push({ seq: (events.at(-1)?.seq ?? 0) + 1, eventType: "graph.replanned", payload: { revision: patch.nextRevision, reason: patch.reason, diffSummary: patch.diffSummary ?? {} }, createdAt: Date.now() });
    this.graphEvents.set(patch.graphId, events);
    const result = { success: true, graphId: patch.graphId, appliedRevision: patch.nextRevision };
    if (patch.operationId) this.patchOperations.set(key, { hash, result });
    return result;
  }

  async saveNode(node: ClusterNodeRecord): Promise<void> {
    this.nodes.set(node.nodeId, { ...node, updatedAt: Date.now() });
  }

  async createNodeIfAbsent(node: ClusterNodeRecord): Promise<boolean> {
    if (this.nodes.has(node.nodeId)) return false;
    this.nodes.set(node.nodeId, structuredClone(node));
    return true;
  }

  async updateNodeConnection(node: ClusterNodeRecord): Promise<boolean> {
    const current = this.nodes.get(node.nodeId);
    if (!current || current.status === "revoked" || current.tokenHash !== node.tokenHash) return false;
    this.nodes.set(node.nodeId, { ...structuredClone(node), tokenHash: current.tokenHash, role: current.role, createdAt: current.createdAt });
    return true;
  }

  async getNode(nodeId: string): Promise<ClusterNodeRecord | null> {
    return this.nodes.get(nodeId) ?? null;
  }

  async listNodes(): Promise<ClusterNodeRecord[]> {
    return Array.from(this.nodes.values());
  }

  async updateNodeStatus(nodeId: string, status: ClusterNodeRecord["status"]): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.status = status;
      node.updatedAt = Date.now();
    }
  }

  async rotateNodeToken(nodeId: string, tokenHash: string): Promise<boolean> {
    const node = this.nodes.get(nodeId);
    if (!node || node.status === "revoked") return false;
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return false;
    node.tokenHash = tokenHash;
    node.updatedAt = Date.now();
    return true;
  }

  async updateNodeLastSeen(nodeId: string, lastSeenAt: number): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.lastSeenAt = lastSeenAt;
      if (node.status === "suspect") node.status = "online";
      node.updatedAt = Date.now();
    }
  }

  async saveTask(task: ClusterTaskRecord): Promise<void> {
    this.tasks.set(task.taskId, { ...task, updatedAt: Date.now() });
  }

  async getTask(taskId: string): Promise<ClusterTaskRecord | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async listTasks(filter?: { nodeId?: string; projectId?: string; status?: ClusterTaskStatus; limit?: number }): Promise<ClusterTaskRecord[]> {
    let list = Array.from(this.tasks.values());
    if (filter?.nodeId) {
      list = list.filter((t) => t.nodeId === filter.nodeId);
    }
    if (filter?.projectId) {
      list = list.filter((t) => t.projectId === filter.projectId);
    }
    if (filter?.status) {
      list = list.filter((t) => t.status === filter.status);
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    if (filter?.limit) {
      list = list.slice(0, filter.limit);
    }
    return list;
  }

  async updateTaskStatus(
    taskId: string,
    status: ClusterTaskStatus,
    details?: { error?: string; resultSummary?: string; finalAnswer?: string; deliverables?: any }
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task && canTransitionTask(task.status, status)) {
      task.status = status;
      task.updatedAt = Date.now();
      if (details?.error) task.error = details.error;
      if (details?.resultSummary) task.resultSummary = details.resultSummary;
      if (details?.finalAnswer) task.finalAnswer = details.finalAnswer;
      if (details?.deliverables) task.deliverables = details.deliverables;
      if (CLUSTER_TASK_TERMINAL.has(status)) {
        task.completedAt = Date.now();
      }
    }
  }

  async appendEvents(events: SequencedEvent[]): Promise<number> {
    let inserted = 0;
    for (const ev of events) {
      let list = this.events.get(ev.taskId);
      if (!list) {
        list = [];
        this.events.set(ev.taskId, list);
      }
      // 保证 (taskId, seq) 严格唯一
      const exists = list.some((e) => e.seq === ev.seq);
      if (!exists) {
        list.push(ev);
        list.sort((a, b) => a.seq - b.seq);
        inserted++;
      }
    }
    return inserted;
  }

  async getEventsForTask(taskId: string, fromSeq = 0, limit = 500): Promise<SequencedEvent[]> {
    const list = this.events.get(taskId) ?? [];
    return list.filter((e) => e.seq >= fromSeq).slice(0, limit);
  }

  async saveApproval(approval: ClusterApprovalRecord): Promise<void> {
    this.approvals.set(approval.approvalId, { ...approval });
  }

  async getApproval(approvalId: string): Promise<ClusterApprovalRecord | null> {
    return this.approvals.get(approvalId) ?? null;
  }

  async listPendingApprovals(): Promise<ClusterApprovalRecord[]> {
    const now = Date.now();
    return Array.from(this.approvals.values()).filter(
      (a) => a.status === "pending" && a.expiresAt > now
    );
  }

  async listApprovalHistory(limit = 100): Promise<ClusterApprovalRecord[]> {
    const now = Date.now();
    return [...this.approvals.values()].filter((a) => a.status !== "pending" || a.expiresAt <= now)
      .sort((a, b) => b.requestedAt - a.requestedAt).slice(0, limit).map((a) => ({ ...a, status: a.status === "pending" ? "expired" : a.status }));
  }

  async resolveApproval(
    approvalId: string,
    decision: "allow-once" | "deny" | "grant-task-full-access",
    resolvedBy = "admin",
    grantId?: string
  ): Promise<boolean> {
    const a = this.approvals.get(approvalId);
    if (!a || a.status !== "pending") return false;
    a.status = "resolved";
    a.decision = decision;
    a.resolvedAt = Date.now();
    a.resolvedBy = resolvedBy;
    if (grantId) a.grantId = grantId;
    return true;
  }

  async saveTaskSecurityGrant(grant: TaskSecurityGrant): Promise<boolean> {
    const active: ReadonlyArray<TaskSecurityGrant["status"]> = ["granted", "applied", "revocation_pending"];
    for (const existing of this.taskGrants.values()) {
      // 与 Postgres 的部分唯一索引保持一致：同一审批同一时刻只允许一个生效中的授权。
      // 已结束（revoked / expired）的历史授权保留审计，不阻塞重新授权；同一 grantId 重放视为幂等成功。
      if (
        existing.approvalId === grant.approvalId &&
        existing.grantId !== grant.grantId &&
        active.includes(existing.status) &&
        active.includes(grant.status)
      ) return false;
    }
    if (!this.taskGrants.has(grant.grantId)) this.taskGrants.set(grant.grantId, structuredClone(grant));
    return true;
  }

  async getTaskSecurityGrant(grantId: string): Promise<TaskSecurityGrant | null> {
    const grant = this.taskGrants.get(grantId);
    return grant ? structuredClone(grant) : null;
  }

  async getTaskSecurityGrantByApproval(approvalId: string): Promise<TaskSecurityGrant | null> {
    let latest: TaskSecurityGrant | undefined;
    for (const grant of this.taskGrants.values()) {
      if (grant.approvalId !== approvalId) continue;
      if (!latest || grant.grantedAt >= latest.grantedAt) latest = grant;
    }
    return latest ? structuredClone(latest) : null;
  }

  async getActiveTaskSecurityGrant(taskId: string, runId: string): Promise<TaskSecurityGrant | null> {
    let found: TaskSecurityGrant | undefined;
    for (const grant of this.taskGrants.values()) {
      if (grant.taskId === taskId && grant.runId === runId && grant.status === "applied") {
        if (!found || grant.grantedAt > found.grantedAt) found = grant;
      }
    }
    return found ? structuredClone(found) : null;
  }

  async listTaskSecurityGrants(filter?: TaskSecurityGrantFilter): Promise<TaskSecurityGrant[]> {
    return [...this.taskGrants.values()].filter(g => {
      if (filter?.taskId && g.taskId !== filter.taskId) return false;
      if (filter?.runId && g.runId !== filter.runId) return false;
      if (filter?.nodeId && g.nodeId !== filter.nodeId) return false;
      if (filter?.approvalId && g.approvalId !== filter.approvalId) return false;
      if (filter?.status && g.status !== filter.status) return false;
      return true;
    }).sort((a, b) => b.grantedAt - a.grantedAt).map(g => structuredClone(g));
  }

  async transitionTaskSecurityGrant(
    grantId: string,
    from: TaskSecurityGrant["status"][],
    to: TaskSecurityGrant["status"],
    details?: TaskSecurityGrantTransitionDetails
  ): Promise<boolean> {
    const grant = this.taskGrants.get(grantId);
    if (!grant || !from.includes(grant.status)) return false;
    grant.status = to;
    if (details?.effectiveAt !== undefined) grant.effectiveAt = details.effectiveAt;
    if (details?.workerAckAt !== undefined) grant.workerAckAt = details.workerAckAt;
    if (details?.revokedAt !== undefined) grant.revokedAt = details.revokedAt;
    if (details?.expiredAt !== undefined) grant.expiredAt = details.expiredAt;
    if (details?.revokedBy !== undefined) grant.revokedBy = details.revokedBy;
    if (details?.lastError !== undefined) grant.lastError = details.lastError;
    if (details?.reconciliationRequired !== undefined) grant.reconciliationRequired = details.reconciliationRequired;
    return true;
  }

  async expireTaskSecurityGrantsForTask(taskId: string): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const grant of this.taskGrants.values()) {
      if (grant.taskId === taskId && (grant.status === "granted" || grant.status === "applied")) {
        grant.status = "expired";
        grant.expiredAt = now;
        count++;
      }
    }
    return count;
  }

  async enqueueOutbox(record: Omit<ClusterOutboxRecord, "id">): Promise<void> {
    if (this.outbox.some((item) => item.messageId === record.messageId)) return;
    this.outbox.push({
      ...record,
      id: this.outbox.length + 1,
    });
  }

  async hasOutboxMessage(messageId: string): Promise<boolean> { return this.outbox.some(item => item.messageId === messageId); }

  async pollPendingOutbox(limit = 50): Promise<ClusterOutboxRecord[]> {
    const now = Date.now();
    return this.outbox
      .filter((m) => m.status === "pending" && m.nextRetryAt <= now)
      .slice(0, limit);
  }

  async markOutboxSent(messageId: string): Promise<void> {
    const item = this.outbox.find((m) => m.messageId === messageId);
    if (item) {
      item.status = "sent";
    }
  }

  async checkAndRecordInbox(messageId: string, _sourceNodeId: string): Promise<boolean> {
    if (this.inbox.has(messageId)) {
      return false; // 已处理过
    }
    this.inbox.add(messageId);
    return true; // 首次接收
  }

  // Catalog & Memory Implementations (InMemory)
  async saveCatalogRevision(
    nodeId: string,
    revision: number,
    capabilities: NodeHardwareCapability[],
    syncStatus = "idle"
  ): Promise<void> {
    this.catalogRevisions.set(nodeId, {
      revision,
      capabilities: [...capabilities],
      lastSyncAt: Date.now(),
      syncStatus,
    });
  }

  async getCatalogRevision(
    nodeId: string
  ): Promise<{ revision: number; capabilities: NodeHardwareCapability[]; lastSyncAt: number; syncStatus: string } | null> {
    return this.catalogRevisions.get(nodeId) ?? null;
  }

  async upsertNodeCatalogSnapshot(snapshot: CatalogSyncSnapshotPayload): Promise<void> {
    validateCatalogSnapshot(snapshot);
    const { nodeId } = snapshot;
    for (const map of [this.projectsCatalog, this.skillsCatalog, this.mcpCatalog]) {
      for (const [key, entry] of map) {
        if (entry.nodeId === nodeId && !(map === this.projectsCatalog && "projectId" in entry && entry.projectId?.startsWith("discovered-"))) map.delete(key);
      }
    }
    for (const entry of snapshot.projects) this.projectsCatalog.set(`${nodeId}::${entry.projectId}`, { ...entry });
    for (const entry of snapshot.skills) this.skillsCatalog.set(`${nodeId}::${entry.skillId}`, { ...entry });
    for (const entry of snapshot.mcp) this.mcpCatalog.set(`${nodeId}::${entry.serverId}`, { ...entry });
    for (const [key, entry] of this.memoryIndex) if (entry.nodeId === nodeId && !entry.entryId.startsWith("mem-disc-")) this.memoryIndex.delete(key);
    for (const entry of snapshot.memoryIndex) this.memoryIndex.set(`${nodeId}::${entry.entryId}`, { ...entry });
    this.catalogRevisions.set(nodeId, { revision: snapshot.catalogRevision, capabilities: [...snapshot.hardwareCapabilities], lastSyncAt: Date.now(), syncStatus: "idle" });
  }

  async upsertProjectCatalog(projects: ProjectCatalogItem[]): Promise<void> {
    for (const p of projects) {
      this.projectsCatalog.set(`${p.nodeId}::${p.projectId}`, { ...p });
    }
  }

  async deleteProjectCatalog(nodeId: string, projectIds: string[]): Promise<void> {
    const set = new Set(projectIds);
    for (const [k, p] of this.projectsCatalog.entries()) {
      if (p.nodeId === nodeId && set.has(p.projectId)) {
        this.projectsCatalog.delete(k);
      }
    }
  }

  async listProjectsCatalog(filter?: { nodeId?: string; visibility?: string }): Promise<ProjectCatalogItem[]> {
    let list = Array.from(this.projectsCatalog.values());
    if (filter?.nodeId) {
      list = list.filter((p) => p.nodeId === filter.nodeId);
    }
    if (filter?.visibility) {
      list = list.filter((p) => p.visibility === filter.visibility);
    }
    return list;
  }

  async getProjectCatalog(nodeId: string, projectId: string): Promise<ProjectCatalogItem | null> {
    return this.projectsCatalog.get(`${nodeId}::${projectId}`) ?? null;
  }

  async upsertSkillCatalog(skills: SkillCatalogItem[]): Promise<void> {
    for (const s of skills) {
      this.skillsCatalog.set(`${s.nodeId}::${s.skillId}`, { ...s });
    }
  }

  async deleteSkillCatalog(nodeId: string, skillIds: string[]): Promise<void> {
    const set = new Set(skillIds);
    for (const [k, s] of this.skillsCatalog.entries()) {
      if (s.nodeId === nodeId && set.has(s.skillId)) {
        this.skillsCatalog.delete(k);
      }
    }
  }

  async listSkillsCatalog(filter?: { nodeId?: string; projectId?: string }): Promise<SkillCatalogItem[]> {
    let list = Array.from(this.skillsCatalog.values());
    if (filter?.nodeId) {
      list = list.filter((s) => s.nodeId === filter.nodeId);
    }
    if (filter?.projectId) {
      list = list.filter((s) => s.projectId === filter.projectId);
    }
    return list;
  }

  async upsertMCPCatalog(mcpList: MCPCapabilityCatalogItem[]): Promise<void> {
    for (const m of mcpList) {
      this.mcpCatalog.set(`${m.nodeId}::${m.serverId}`, { ...m });
    }
  }

  async deleteMCPCatalog(nodeId: string, serverIds: string[]): Promise<void> {
    const set = new Set(serverIds);
    for (const [k, m] of this.mcpCatalog.entries()) {
      if (m.nodeId === nodeId && set.has(m.serverId)) {
        this.mcpCatalog.delete(k);
      }
    }
  }

  async listMCPCatalog(filter?: { nodeId?: string }): Promise<MCPCapabilityCatalogItem[]> {
    let list = Array.from(this.mcpCatalog.values());
    if (filter?.nodeId) {
      list = list.filter((m) => m.nodeId === filter.nodeId);
    }
    return list;
  }

  async upsertMemoryIndex(entries: FederatedMemoryIndexItem[]): Promise<void> {
    for (const e of entries) {
      this.memoryIndex.set(`${e.nodeId}::${e.entryId}`, { ...e });
    }
  }

  async upsertWorkerMemorySnapshot(nodeId: string, entries: FederatedMemoryIndexItem[]): Promise<void> {
    validateWorkerMemorySnapshot(nodeId, entries);
    const next = new Map(entries.map((entry) => [entry.entryId, entry]));
    // Discovery records are owned by the coordinator, not by Worker snapshots.
    for (const [key, entry] of this.memoryIndex) {
      if (entry.nodeId === nodeId && !entry.entryId.startsWith("mem-disc-") && !next.has(entry.entryId)) this.memoryIndex.delete(key);
    }
    for (const entry of entries) this.memoryIndex.set(`${nodeId}::${entry.entryId}`, { ...entry });
  }

  async deleteMemoryIndex(nodeId: string, entryIds: string[]): Promise<void> {
    const set = new Set(entryIds);
    for (const [k, e] of this.memoryIndex.entries()) {
      if (e.nodeId === nodeId && set.has(e.entryId)) {
        this.memoryIndex.delete(k);
      }
    }
  }

  async deleteProjectMemoryIndex(nodeId: string, projectId: string): Promise<void> {
    for (const [k, e] of this.memoryIndex.entries()) {
      if (e.nodeId === nodeId && e.projectId === projectId) {
        this.memoryIndex.delete(k);
      }
    }
  }

  async listMemoryIndex(filter?: { nodeId?: string; projectId?: string }): Promise<FederatedMemoryIndexItem[]> {
    let list = Array.from(this.memoryIndex.values());
    if (filter?.nodeId) {
      list = list.filter((e) => e.nodeId === filter.nodeId);
    }
    if (filter?.projectId) {
      list = list.filter((e) => e.projectId === filter.projectId);
    }
    return list;
  }

  async saveTombstones(tombstones: CatalogTombstoneItem[], nodeId: string): Promise<void> {
    for (const t of tombstones) {
      const itemNodeId = t.nodeId ?? nodeId;
      const idx = this.tombstones.findIndex(
        (x) => (x.nodeId ?? nodeId) === itemNodeId && x.resourceType === t.resourceType && x.resourceId === t.resourceId
      );
      const withNode: CatalogTombstoneItem = { ...t, nodeId: itemNodeId };
      if (idx >= 0) {
        this.tombstones[idx] = withNode;
      } else {
        this.tombstones.push(withNode);
      }
    }
  }

  async getTombstones(nodeId: string, sinceRevision = 0): Promise<CatalogTombstoneItem[]> {
    return this.tombstones.filter((t) => (t.nodeId ?? nodeId) === nodeId && t.revision >= sinceRevision);
  }

  async recordSyncLog(
    nodeId: string,
    syncType: string,
    revision: number,
    itemCounts: Record<string, number>,
    status: string,
    error?: string
  ): Promise<void> {
    this.syncLogs.push({
      nodeId,
      syncType,
      revision,
      itemCounts,
      status,
      error,
      createdAt: Date.now(),
    });
  }

  async listTombstones(nodeId?: string): Promise<CatalogTombstoneItem[]> {
    if (!nodeId) return [...this.tombstones];
    return this.tombstones.filter(t => t.nodeId === nodeId);
  }

  async recordRouteDecision(record: ClusterRouteRecord): Promise<void> {
    this.routes.set(record.routeId, { ...record, updatedAt: Date.now() });
  }

  async getRouteDecision(routeId: string): Promise<ClusterRouteRecord | null> {
    return this.routes.get(routeId) ?? null;
  }

  async recordRouteReplan(record: any): Promise<void> {
    this.assertForegroundFence();
    this.replans.set(record.replanId, { ...record, updatedAt: Date.now() });
  }

  async getRouteReplan(replanId: string): Promise<any | null> {
    return this.replans.get(replanId) ?? null;
  }

  async listRouteReplans(taskId: string): Promise<any[]> {
    return Array.from(this.replans.values()).filter((r) => r.taskId === taskId);
  }

  // --- Phase 4 InMemory Methods ---

  async saveGraph(graph: DistributedGraphRecord): Promise<void> {
    this.graphs.set(graph.graphId, { ...graph, updatedAt: Date.now() });
  }

  async getGraph(graphId: string): Promise<DistributedGraphRecord | null> {
    return this.graphs.get(graphId) ?? null;
  }

  async listGraphs(filter?: { status?: GraphStatus; limit?: number }): Promise<DistributedGraphRecord[]> {
    let list = Array.from(this.graphs.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    if (filter?.status) {
      list = list.filter((g) => g.status === filter.status);
    }
    if (filter?.limit && filter.limit > 0) {
      list = list.slice(0, filter.limit);
    }
    return list;
  }

  async updateGraphStatus(
    graphId: string,
    status: GraphStatus,
    details?: { error?: string; finalSummary?: string; completedAt?: number }
  ): Promise<void> {
    const g = this.graphs.get(graphId);
    if (!g) return;
    g.status = status;
    g.updatedAt = Date.now();
    if (details?.error !== undefined) g.error = details.error;
    if (details?.finalSummary !== undefined) g.finalSummary = details.finalSummary;
    if (details?.completedAt !== undefined) g.completedAt = details.completedAt;
  }

  async transitionGraphStatus(graphId: string, expectedRevision: number, expectedStatus: GraphStatus, status: GraphStatus, details?: { error?: string; finalSummary?: string; completedAt?: number }, owner?: { goalRunId: string; fence: GoalTurnFence }): Promise<boolean> {
    const graph = this.graphs.get(graphId);
    if (!graph || graph.revision !== expectedRevision || graph.status !== expectedStatus) return false;
    if (owner) {
      const goal = this.goalRuns.get(owner.goalRunId);
      if (!goal?.linkedGraphIds.includes(graphId)) throw new ClusterStorageError("Graph is not owned by the fenced GoalRun");
      assertGoalTurnFence(goal, owner.fence, Date.now());
    }
    Object.assign(graph, { status, updatedAt: Date.now() }, details);
    return true;
  }

  async saveGraphNode(node: DistributedGraphNodeRecord): Promise<void> {
    this.graphNodes.set(`${node.graphId}::${node.nodeId}`, { ...node, updatedAt: Date.now() });
  }

  async getGraphNode(graphId: string, nodeId: string): Promise<DistributedGraphNodeRecord | null> {
    return this.graphNodes.get(`${graphId}::${nodeId}`) ?? null;
  }

  async listGraphNodes(graphId: string): Promise<DistributedGraphNodeRecord[]> {
    const res: DistributedGraphNodeRecord[] = [];
    for (const [k, v] of this.graphNodes.entries()) {
      if (k.startsWith(`${graphId}::`)) res.push({ ...v });
    }
    return res;
  }

  async updateGraphNodeStatus(
    graphId: string,
    nodeId: string,
    status: GraphNodeStatus,
    details?: {
      taskId?: string;
      workerRunId?: string;
      resultSummary?: string;
      error?: string;
      attemptCount?: number;
      startedAt?: number;
      completedAt?: number;
      assignedNodeId?: string;
      assignedProjectId?: string;
    }
  ): Promise<void> {
    const n = this.graphNodes.get(`${graphId}::${nodeId}`);
    if (!n) return;
    n.status = status;
    if (status === "completed") n.error = undefined;
    n.updatedAt = Date.now();
    if (details?.taskId !== undefined) n.taskId = details.taskId;
    if (details?.workerRunId !== undefined) n.workerRunId = details.workerRunId;
    if (details?.resultSummary !== undefined) n.resultSummary = details.resultSummary;
    if (details?.error !== undefined) n.error = details.error;
    if (details?.attemptCount !== undefined) n.attemptCount = details.attemptCount;
    if (details?.startedAt !== undefined) n.startedAt = details.startedAt;
    if (details?.completedAt !== undefined) n.completedAt = details.completedAt;
    if (details?.assignedNodeId !== undefined) n.assignedNodeId = details.assignedNodeId;
    if (details?.assignedProjectId !== undefined) n.assignedProjectId = details.assignedProjectId;
  }

  async saveGraphEdges(edges: DistributedGraphEdgeRecord[]): Promise<void> {
    if (edges.length === 0) return;
    const graphId = edges[0].graphId;
    const existing = this.graphEdges.get(graphId) ?? [];
    for (const e of edges) {
      const idx = existing.findIndex((x) => x.fromNodeId === e.fromNodeId && x.toNodeId === e.toNodeId);
      if (idx >= 0) existing[idx] = e;
      else existing.push(e);
    }
    this.graphEdges.set(graphId, existing);
  }

  async deleteGraphEdges(
    graphId: string,
    edges: Array<{ fromNodeId: string; toNodeId: string }>
  ): Promise<void> {
    if (edges.length === 0) return;
    const existing = this.graphEdges.get(graphId) ?? [];
    const removeSet = new Set(edges.map((e) => `${e.fromNodeId}->${e.toNodeId}`));
    this.graphEdges.set(
      graphId,
      existing.filter((x) => !removeSet.has(`${x.fromNodeId}->${x.toNodeId}`))
    );
  }

  async listGraphEdges(graphId: string): Promise<DistributedGraphEdgeRecord[]> {
    return this.graphEdges.get(graphId) ?? [];
  }

  async recordGraphRevision(rev: GraphRevisionRecord): Promise<void> {
    const list = this.graphRevisions.get(rev.graphId) ?? [];
    list.push(rev);
    this.graphRevisions.set(rev.graphId, list);
  }

  async listGraphRevisions(graphId: string): Promise<GraphRevisionRecord[]> {
    return this.graphRevisions.get(graphId) ?? [];
  }

  async appendGraphEvent(graphId: string, eventType: string, payload: Record<string, unknown>): Promise<number> {
    const list = this.graphEvents.get(graphId) ?? [];
    const seq = list.length + 1;
    list.push({ seq, eventType, payload, createdAt: Date.now() });
    this.graphEvents.set(graphId, list);
    return seq;
  }

  async listGraphEvents(
    graphId: string,
    fromSeq = 0
  ): Promise<Array<{ seq: number; eventType: string; payload: any; createdAt: number }>> {
    const list = this.graphEvents.get(graphId) ?? [];
    return list.filter((e) => e.seq >= fromSeq);
  }

  async recordGraphVerification(v: GraphVerificationRecord): Promise<void> {
    const list = this.graphVerifications.get(v.graphId) ?? [];
    list.push(v);
    this.graphVerifications.set(v.graphId, list);
  }

  async listGraphVerifications(graphId: string, graphNodeId?: string): Promise<GraphVerificationRecord[]> {
    const list = this.graphVerifications.get(graphId) ?? [];
    if (graphNodeId) return list.filter((v) => v.graphNodeId === graphNodeId);
    return list;
  }

  async saveAgentMessage(msg: any): Promise<void> {
    this.assertForegroundFence();
    this.agentMessages.set(msg.messageId, { ...msg });
  }

  async getAgentMessage(messageId: string): Promise<any | null> {
    return this.agentMessages.get(messageId) ?? null;
  }

  async pollPendingAgentMessages(targetNodeId: string, targetAgentId: string): Promise<any[]> {
    const res: any[] = [];
    const now = Date.now();
    for (const msg of this.agentMessages.values()) {
      if (
        msg.targetNodeId === targetNodeId &&
        (msg.targetAgentId === targetAgentId || msg.targetAgentId === "*") &&
        msg.deliveryStatus === "pending" &&
        msg.expiresAt > now
      ) {
        res.push({ ...msg });
      }
    }
    return res;
  }

  async updateAgentMessageStatus(messageId: string, status: string, timestamp = Date.now()): Promise<void> {
    const msg = this.agentMessages.get(messageId);
    if (!msg) return;
    msg.deliveryStatus = status;
    if (status === "delivered") msg.deliveredAt = timestamp;
    if (status === "acknowledged") msg.acknowledgedAt = timestamp;
  }

  async saveArtifact(artifact: any): Promise<void> {
    this.assertForegroundFence();
    this.artifacts.set(artifact.artifactId, { ...artifact });
  }

  async getArtifact(artifactId: string): Promise<any | null> {
    return this.artifacts.get(artifactId) ?? null;
  }

  async listArtifacts(graphId?: string): Promise<any[]> {
    if (graphId) {
      return Array.from(this.artifacts.values()).filter((a) => a.graphId === graphId);
    }
    return Array.from(this.artifacts.values()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  // Web Control Plane & Conversations (Phase 5)
  private readonly conversationSnapshots = new ConversationSnapshots();
  private readonly conversations = new Map<string, WebConversationRecord>();
  private readonly webSessions = new Map<string, WebSessionRecord>();

  async saveConversation(conversation: WebConversationRecord): Promise<void> {
    this.conversations.set(conversation.id, this.conversationSnapshots.merge(conversation, this.conversations.get(conversation.id) ?? null));
    this.conversationSnapshots.remember(conversation);
  }

  async getConversation(id: string): Promise<WebConversationRecord | null> {
    const current = this.conversations.get(id);
    return current ? this.conversationSnapshots.read(current) : null;
  }

  async listConversations(limit = 50): Promise<WebConversationRecord[]> {
    return Array.from(this.conversations.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((c) => ({
        ...c,
        messages: [...c.messages],
        linkedTaskIds: c.linkedTaskIds ? [...c.linkedTaskIds] : [],
        linkedGraphIds: c.linkedGraphIds ? [...c.linkedGraphIds] : [],
      }));
  }

  async deleteConversation(id: string): Promise<boolean> {
    return this.conversations.delete(id);
  }

  async appendConversationMessage(conversationId: string, message: WebMessageRecord): Promise<void> {
    const c = this.conversations.get(conversationId);
    if (!c) return;
    if (c.messages.some(item => item.id === message.id)) return;
    c.messages.push(structuredClone(message));
    c.updatedAt = message.timestamp;
  }

  async saveWebSession(session: WebSessionRecord): Promise<void> {
    this.webSessions.set(session.sessionId, { ...session });
  }

  async getWebSession(sessionId: string): Promise<WebSessionRecord | null> {
    const s = this.webSessions.get(sessionId);
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      this.webSessions.delete(sessionId);
      return null;
    }
    return { ...s };
  }

  async deleteWebSession(sessionId: string): Promise<void> {
    this.webSessions.delete(sessionId);
  }

  async cleanExpiredWebSessions(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, s] of this.webSessions.entries()) {
      if (s.expiresAt < now) {
        this.webSessions.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  async grantArtifactAccess(
    artifactId: string,
    graphId: string,
    consumerNodeId: string,
    consumerTaskId?: string
  ): Promise<void> {
    this.artifactGrants.add(`${artifactId}::${consumerNodeId}::${consumerTaskId ?? ""}`);
  }

  async hasArtifactAccess(artifactId: string, consumerNodeId: string, consumerTaskId?: string): Promise<boolean> {
    if (this.artifactGrants.has(`${artifactId}::${consumerNodeId}::${consumerTaskId ?? ""}`)) return true;
    if (this.artifactGrants.has(`${artifactId}::${consumerNodeId}::`)) return true;
    return false;
  }

  async recordGraphControl(ctrl: any): Promise<void> {
    const list = this.graphControls.get(ctrl.graphId) ?? [];
    list.push(ctrl);
    this.graphControls.set(ctrl.graphId, list);
  }

  async getPendingGraphControls(graphId: string): Promise<any[]> {
    const list = this.graphControls.get(graphId) ?? [];
    return list.filter((c) => c.status === "pending");
  }

  async updateGraphControlStatus(controlId: string, status: string): Promise<void> {
    for (const list of this.graphControls.values()) {
      const c = list.find((x) => x.controlId === controlId);
      if (c) {
        c.status = status;
        if (status === "executed") c.executedAt = Date.now();
        break;
      }
    }
  }

  // Scheduled Tasks (Phase 5)
  async saveScheduledTask(task: ScheduledTaskRecord): Promise<void> {
    this.assertForegroundFence();
    this.scheduledTasks.set(task.id, { ...task });
  }

  async getScheduledTask(id: string): Promise<ScheduledTaskRecord | null> {
    const t = this.scheduledTasks.get(id);
    return t ? { ...t } : null;
  }

  async listScheduledTasks(filter?: { enabled?: boolean; targetType?: ScheduledTargetType; limit?: number; offset?: number }): Promise<ScheduledTaskRecord[]> {
    let list = Array.from(this.scheduledTasks.values());
    if (filter?.enabled !== undefined) {
      list = list.filter((t) => t.enabled === filter.enabled);
    }
    if (filter?.targetType) {
      list = list.filter((t) => t.targetType === filter.targetType);
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 100;
    return list.slice(offset, offset + limit).map((t) => ({ ...t }));
  }

  async updateScheduledTask(id: string, patch: Partial<ScheduledTaskRecord>): Promise<ScheduledTaskRecord | null> {
    this.assertForegroundFence();
    const existing = this.scheduledTasks.get(id);
    if (!existing) return null;
    const updated: ScheduledTaskRecord = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    };
    this.scheduledTasks.set(id, updated);
    return { ...updated };
  }

  async deleteScheduledTask(id: string): Promise<boolean> {
    this.assertForegroundFence();
    const deleted = this.scheduledTasks.delete(id);
    if (deleted) {
      for (const [runId, run] of this.scheduledTaskRuns.entries()) {
        if (run.scheduledTaskId === id) {
          this.scheduledTaskRuns.delete(runId);
        }
      }
    }
    return deleted;
  }

  async saveScheduledTaskRun(run: ScheduledTaskRunRecord): Promise<void> {
    this.scheduledTaskRuns.set(run.id, { ...run });
  }

  async getScheduledTaskRun(runId: string): Promise<ScheduledTaskRunRecord | null> {
    const r = this.scheduledTaskRuns.get(runId);
    return r ? { ...r } : null;
  }

  async listScheduledTaskRuns(scheduledTaskId?: string, filter?: { status?: ScheduledTaskRunStatus; limit?: number; offset?: number }): Promise<ScheduledTaskRunRecord[]> {
    let list = Array.from(this.scheduledTaskRuns.values());
    if (scheduledTaskId) {
      list = list.filter((r) => r.scheduledTaskId === scheduledTaskId);
    }
    if (filter?.status) {
      list = list.filter((r) => r.status === filter.status);
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;
    return list.slice(offset, offset + limit).map((r) => ({ ...r }));
  }

  async updateScheduledTaskRun(runId: string, patch: Partial<ScheduledTaskRunRecord>): Promise<void> {
    const existing = this.scheduledTaskRuns.get(runId);
    if (!existing) return;
    this.scheduledTaskRuns.set(runId, { ...existing, ...patch });
  }

  // Security Decision Audit (Phase 5)
  async saveSecurityAudit(record: SecurityAuditRecord): Promise<void> {
    this.securityAudits.set(record.id, { ...record });
  }

  async getSecurityAudit(id: string): Promise<SecurityAuditRecord | null> {
    const a = this.securityAudits.get(id);
    return a ? { ...a } : null;
  }

  async listSecurityAudits(filter?: SecurityAuditFilter): Promise<{ items: SecurityAuditRecord[]; total: number }> {
    let list = Array.from(this.securityAudits.values());
    if (filter?.verdict) {
      list = list.filter((a) => a.verdict === filter.verdict);
    }
    if (filter?.decisionSource) {
      list = list.filter((a) => a.decisionSource === filter.decisionSource);
    }
    if (filter?.riskCategory) {
      list = list.filter((a) => a.riskCategory.toLowerCase().includes(filter.riskCategory!.toLowerCase()));
    }
    if (filter?.reviewStatus) {
      list = list.filter((a) => a.reviewFeedback.status === filter.reviewStatus);
    }
    if (filter?.taskId) {
      list = list.filter((a) => a.taskId === filter.taskId);
    }
    if (filter?.nodeId) {
      list = list.filter((a) => a.nodeId === filter.nodeId);
    }
    if (filter?.fromTimestamp) {
      list = list.filter((a) => a.timestamp >= filter.fromTimestamp!);
    }
    if (filter?.toTimestamp) {
      list = list.filter((a) => a.timestamp <= filter.toTimestamp!);
    }
    list.sort((a, b) => b.timestamp - a.timestamp);
    const total = list.length;
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;
    const items = list.slice(offset, offset + limit).map((a) => ({ ...a }));
    return { items, total };
  }

  async updateSecurityAuditFeedback(id: string, feedback: SecurityAuditFeedback): Promise<SecurityAuditRecord | null> {
    const existing = this.securityAudits.get(id);
    if (!existing) return null;
    const updated: SecurityAuditRecord = {
      ...existing,
      reviewFeedback: {
        ...existing.reviewFeedback,
        ...feedback,
        reviewedAt: feedback.reviewedAt ?? Date.now(),
      },
    };
    this.securityAudits.set(id, updated);
    return { ...updated };
  }

  async getSecurityAuditStats(windowMs?: number): Promise<SecurityAuditStats> {
    let list = Array.from(this.securityAudits.values());
    if (windowMs && windowMs > 0) {
      const threshold = Date.now() - windowMs;
      list = list.filter((a) => a.timestamp >= threshold);
    }
    let allowCount = 0;
    let blockCount = 0;
    let requireApprovalCount = 0;
    let falsePositiveCount = 0;
    const sourceCounts: Record<SecurityDecisionSource, number> = {
      LLM_MONITOR: 0,
      DETERMINISTIC_POLICY: 0,
      USER_APPROVAL: 0,
      SYSTEM_FAILURE: 0,
    };
    const catMap = new Map<string, number>();

    for (const a of list) {
      if (a.verdict === "ALLOW") allowCount++;
      else if (a.verdict === "BLOCK") blockCount++;
      else if (a.verdict === "REQUIRE_APPROVAL") requireApprovalCount++;

      if (a.decisionSource && sourceCounts[a.decisionSource] !== undefined) {
        sourceCounts[a.decisionSource]++;
      }
      if (a.reviewFeedback.status === "false_positive") {
        falsePositiveCount++;
      }
      const cat = a.riskCategory || "Routine Operation";
      catMap.set(cat, (catMap.get(cat) ?? 0) + 1);
    }

    const topRiskCategories = Array.from(catMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([category, count]) => ({ category, count }));

    return {
      totalCount: list.length,
      allowCount,
      blockCount,
      requireApprovalCount,
      sourceCounts,
      falsePositiveCount,
      topRiskCategories,
    };
  }
}

/**
 * PostgreSQL 持久化实现
 */
