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

export class PostgresClusterStore implements IClusterStore {
  private async databaseTimeMs(): Promise<number> {
    const result = await this.db.query<{ now_ms: string }>("SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms");
    return Number(result.rows[0]!.now_ms);
  }
  private async fencedForegroundMutation<T>(operation: () => Promise<T>): Promise<T> {
    const trace = defaultTraceContext.get();
    if (!trace?.goalTurnFence) return operation();
    return this.db.transaction(async () => {
      const result = await this.db.query<{ payload: GoalRunRecord }>("SELECT payload FROM cluster_goal_runs WHERE goal_run_id=$1 FOR UPDATE", [trace.goalRunId]);
      const goal = result.rows[0]?.payload;
      if (!goal) throw new ClusterStorageError("GoalRun not found");
      assertGoalTurnFence(goal, trace.goalTurnFence, await this.databaseTimeMs());
      return operation();
    });
  }
  async claimGoalTurnLease(goalRunId: string, turnId: string, ownerId: string, ttlMs: number): Promise<GoalRunRecord["turnLease"] | null> {
    if (!ownerId || !turnId || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ClusterStorageError("Invalid GoalRun turn lease");
    return this.db.transaction(async () => {
      const result = await this.db.query<{ payload: GoalRunRecord }>("SELECT payload FROM cluster_goal_runs WHERE goal_run_id=$1 FOR UPDATE", [goalRunId]);
      const row = result.rows[0];
      if (!row) throw new ClusterStorageError("GoalRun not found");
      const goal = row.payload;
      const conversation = await this.db.query<{ messages: WebMessageRecord[] }>("SELECT messages FROM cluster_web_conversations WHERE id=$1 FOR UPDATE", [goal.conversationId]);
      const now = await this.databaseTimeMs();
      const messages = conversation.rows[0]?.messages ?? [];
      const turn = messages.filter(message => message.sender === "user" && (message.id === goal.userMessageId || message.metadata?.goalRunId === goalRunId)).at(-1);
      if (turn?.id !== turnId || messages.some(message => message.sender === "assistant" && message.metadata?.goalRunId === goalRunId && message.metadata?.goalRunTurnId === turnId)) return null;
      if (goal.turnLease && goal.turnLease.expiresAt > now) return null;
      const generation = (goal.turnLeaseGeneration ?? 0) + 1;
      const lease = { ownerId, turnId, generation, expiresAt: now + ttlMs };
      const next = { ...goal, turnLease: lease, turnLeaseGeneration: generation, turnRecovery: undefined, status: "planning", executionState: "running", currentStage: "planning", finalReport: undefined, reportFingerprint: undefined, reportState: "pending", completedAt: undefined, revision: goal.revision + 1, updatedAt: now };
      await this.db.query("UPDATE cluster_goal_runs SET revision=$1,payload=$2 WHERE goal_run_id=$3", [next.revision, JSON.stringify(next), goalRunId]);
      return lease;
    });
  }
  async renewGoalTurnLease(goalRunId: string, ownerId: string, generation: number, ttlMs: number): Promise<boolean> {
    if (!ownerId || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ClusterStorageError("Invalid GoalRun turn lease");
    return this.db.transaction(async () => {
      const result = await this.db.query<{ payload: GoalRunRecord }>("SELECT payload FROM cluster_goal_runs WHERE goal_run_id=$1 FOR UPDATE", [goalRunId]);
      const row = result.rows[0];
      if (!row) return false;
      const goal = row.payload, now = await this.databaseTimeMs(), lease = goal.turnLease;
      if (!lease || lease.ownerId !== ownerId || lease.generation !== generation || lease.expiresAt <= now) return false;
      const next = { ...goal, turnLease: { ...lease, expiresAt: now + ttlMs }, revision: goal.revision + 1, updatedAt: now };
      await this.db.query("UPDATE cluster_goal_runs SET revision=$1,payload=$2 WHERE goal_run_id=$3", [next.revision, JSON.stringify(next), goalRunId]);
      return true;
    });
  }
  async releaseGoalTurnLease(goalRunId: string, ownerId: string, generation: number): Promise<boolean> {
    if (!ownerId) throw new ClusterStorageError("Invalid GoalRun turn owner");
    return this.db.transaction(async () => {
      const result = await this.db.query<{ payload: GoalRunRecord }>("SELECT payload FROM cluster_goal_runs WHERE goal_run_id=$1 FOR UPDATE", [goalRunId]);
      const row = result.rows[0];
      if (!row) return false;
      const goal = row.payload, lease = goal.turnLease;
      // 只释放本代际自己的租约；已被新轮次接管的记录绝不能被旧轮次清除。
      if (!lease || lease.ownerId !== ownerId || lease.generation !== generation) return false;
      const now = await this.databaseTimeMs();
      const next = { ...goal, turnLease: undefined, revision: goal.revision + 1, updatedAt: now };
      await this.db.query("UPDATE cluster_goal_runs SET revision=$1,payload=$2 WHERE goal_run_id=$3", [next.revision, JSON.stringify(next), goalRunId]);
      return true;
    });
  }
  async executeGoalTaskControl(goalRunId: string, fence: GoalTurnFence, taskId: string, status: "cancelled" | "cancelling" | "outcome_unknown" | undefined, reason: string | undefined, send?: () => void): Promise<boolean> {
    return this.db.transaction(async () => {
      const result = await this.db.query<{ payload: GoalRunRecord }>("SELECT payload FROM cluster_goal_runs WHERE goal_run_id=$1 FOR UPDATE", [goalRunId]);
      const goal = result.rows[0]?.payload;
      if (!goal || !goal.linkedTaskIds.includes(taskId)) throw new ClusterStorageError("Task is not owned by the fenced GoalRun");
      const row = await this.db.query("SELECT task_id FROM cluster_tasks WHERE task_id=$1 FOR UPDATE", [taskId]);
      assertGoalTurnFence(goal, fence, await this.databaseTimeMs());
      if (!row.rows.length) return false;
      const task = await this.getTask(taskId);
      if (!task || CLUSTER_TASK_TERMINAL.has(task.status) || (task.status === "outcome_unknown" && status !== "outcome_unknown") || (status && !canTransitionTask(task.status, status))) return false;
      if (status) await this.updateTaskStatus(taskId, status, reason ? { error: reason } : undefined);
      send?.();
      return true;
    });
  }
  async createGoalRunWithConversation(goal: GoalRunRecord, conversation: WebConversationRecord, initialLease?: { ownerId: string; ttlMs: number }): Promise<boolean> {
    if (goal.conversationId !== conversation.id || !conversation.messages.some(message => message.id === goal.userMessageId && message.sender === "user" && message.metadata?.goalRunId === goal.goalRunId)) throw new ClusterStorageError("Invalid GoalRun user message ownership");
    if (initialLease && (!initialLease.ownerId || !Number.isSafeInteger(initialLease.ttlMs) || initialLease.ttlMs < 1)) throw new ClusterStorageError("Invalid GoalRun turn lease");
    const created = await this.db.transaction(async () => {
      const locked = await this.db.query("SELECT id FROM cluster_web_conversations WHERE id=$1 FOR UPDATE", [conversation.id]);
      if (!locked.rows.length) throw new ClusterStorageError("GoalRun conversation not found");
      const storedGoal = initialLease ? { ...goal, turnLeaseGeneration: 1, turnLease: { ownerId: initialLease.ownerId, turnId: goal.userMessageId, generation: 1, expiresAt: await this.databaseTimeMs() + initialLease.ttlMs } } : goal;
      if (!await this.createGoalRun(storedGoal)) return false;
      const current = await this.getConversation(conversation.id);
      if (current?.messages.some(message => message.id === goal.userMessageId)) throw new ClusterStorageError("GoalRun user message ID already exists");
      const merged = this.conversationSnapshots.merge(conversation, current);
      await this.db.query(`UPDATE cluster_web_conversations SET title=$2,linked_task_ids=$3,linked_graph_ids=$4,messages=$5,updated_at=$6,title_source=$7,title_revision=$8 WHERE id=$1`,
        [merged.id, merged.title, JSON.stringify(merged.linkedTaskIds ?? []), JSON.stringify(merged.linkedGraphIds ?? []), JSON.stringify(merged.messages), merged.updatedAt, merged.titleSource ?? "default", merged.titleRevision ?? 0]);
      return true;
    });
    if (created) this.conversationSnapshots.remember(conversation);
    return created;
  }
  async continueGoalRunWithConversation(goalRunId: string, conversation: WebConversationRecord, turnId: string, ownerId: string, ttlMs: number): Promise<GoalRunRecord["turnLease"] | null> {
    if (!ownerId || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ClusterStorageError("Invalid GoalRun turn lease");
    const lease = await this.db.transaction(async () => {
      const goalRow = await this.db.query<{ payload: GoalRunRecord }>("SELECT payload FROM cluster_goal_runs WHERE goal_run_id=$1 FOR UPDATE", [goalRunId]);
      const goal = goalRow.rows[0]?.payload;
      const locked = await this.db.query("SELECT id FROM cluster_web_conversations WHERE id=$1 FOR UPDATE", [conversation.id]);
      const turn = conversation.messages.find(message => message.id === turnId && message.sender === "user" && message.metadata?.goalRunId === goalRunId);
      if (!goal || goal.conversationId !== conversation.id || !locked.rows.length || !turn) throw new ClusterStorageError("Invalid GoalRun user message ownership");
      const current = await this.getConversation(conversation.id);
      if (!current || current.messages.some(message => message.id === turnId) || current.messages.some(message => message.sender === "user" && !conversation.messages.some(item => item.id === message.id))) return null;
      const now = await this.databaseTimeMs();
      if (goal.turnLease && goal.turnLease.expiresAt > now) return null;
      const generation = (goal.turnLeaseGeneration ?? 0) + 1;
      const nextLease = { ownerId, turnId, generation, expiresAt: now + ttlMs };
      const next = { ...goal, turnLease: nextLease, turnLeaseGeneration: generation, turnRecovery: undefined, status: "planning", executionState: "running", currentStage: "planning", finalReport: undefined, reportFingerprint: undefined, reportState: "pending", completedAt: undefined, revision: goal.revision + 1, updatedAt: now };
      const merged = this.conversationSnapshots.merge(conversation, current);
      await this.db.query(`UPDATE cluster_web_conversations SET title=$2,linked_task_ids=$3,linked_graph_ids=$4,messages=$5,updated_at=$6,title_source=$7,title_revision=$8 WHERE id=$1`, [merged.id, merged.title, JSON.stringify(merged.linkedTaskIds ?? []), JSON.stringify(merged.linkedGraphIds ?? []), JSON.stringify(merged.messages), merged.updatedAt, merged.titleSource ?? "default", merged.titleRevision ?? 0]);
      await this.db.query("UPDATE cluster_goal_runs SET revision=$1,payload=$2 WHERE goal_run_id=$3", [next.revision, JSON.stringify(next), goalRunId]);
      return nextLease;
    });
    if (lease) this.conversationSnapshots.remember(conversation);
    return lease;
  }
  async commitGoalTurnResponse(goalRunId: string, message: WebMessageRecord, fence?: GoalTurnFence): Promise<{ goal: GoalRunRecord; inserted: boolean }> {
    return this.db.transaction(async () => {
      const result = await this.db.query<{ payload: GoalRunRecord }>("SELECT payload FROM cluster_goal_runs WHERE goal_run_id=$1 FOR UPDATE", [goalRunId]);
      const goal = result.rows[0]?.payload;
      const turnId = message.metadata?.goalRunTurnId;
      if (!goal || message.conversationId !== goal.conversationId || message.sender !== "assistant" || message.metadata?.goalRunId !== goalRunId || typeof turnId !== "string") throw new ClusterStorageError("Invalid GoalRun response ownership");
      const rows = await this.db.query<{ messages: WebMessageRecord[] }>("SELECT messages FROM cluster_web_conversations WHERE id=$1 FOR UPDATE", [goal.conversationId]);
      if (!rows.rows.length) throw new ClusterStorageError("GoalRun conversation not found");
      const turn = (rows.rows[0]!.messages ?? []).find(item => item.id === turnId && item.sender === "user");
      if (!turn || (turn.id !== goal.userMessageId && turn.metadata?.goalRunId !== goalRunId)) throw new ClusterStorageError("GoalRun response turn is not linked");
      if ((rows.rows[0]!.messages ?? []).some(item => item.sender === "assistant" && item.metadata?.goalRunId === goalRunId && item.metadata?.goalRunTurnId === turnId)) return { goal, inserted: false };
      assertGoalTurnFence(goal, fence, await this.databaseTimeMs());
      if (fence && fence.turnId !== turnId) throw new ClusterStorageError("GoalRun response turn fence mismatch");
      if ((rows.rows[0]!.messages ?? []).some(item => item.id === message.id)) throw new ClusterStorageError("GoalRun response message ID already exists");
      const latestTurn = (rows.rows[0]!.messages ?? []).filter(item => item.sender === "user" && (item.id === goal.userMessageId || item.metadata?.goalRunId === goalRunId)).at(-1);
      if (latestTurn?.id !== turnId) throw new ClusterStorageError("Stale GoalRun response turn");
      await this.appendConversationMessage(goal.conversationId, message);
      const next = { ...goal, turnLease: undefined, ...(message.metadata?.recoveredTurn === true ? { turnRecovery: { turnId, recoveredAt: await this.databaseTimeMs() } } : {}), currentStage: "awaiting_verification", interimReport: message.content, interimMessageId: message.id,
        reportRevision: goal.reportRevision + 1, revision: goal.revision + 1, updatedAt: Date.now() };
      await this.db.query("UPDATE cluster_goal_runs SET revision=$1,payload=$2 WHERE goal_run_id=$3", [next.revision, JSON.stringify(next), goalRunId]);
      return { goal: next, inserted: true };
    });
  }
  async createGoalRun(goal: GoalRunRecord): Promise<boolean> {
    const result = await this.db.query(`INSERT INTO cluster_goal_runs(goal_run_id, conversation_id, user_message_id, revision, created_at, payload) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [goal.goalRunId, goal.conversationId, goal.userMessageId, goal.revision, goal.createdAt, JSON.stringify(goal)]);
    return result.rowCount === 1;
  }
  async getGoalRun(id: string): Promise<GoalRunRecord | null> {
    const result = await this.db.query<{ payload: GoalRunRecord }>(`SELECT payload FROM cluster_goal_runs WHERE goal_run_id=$1`, [id]);
    return result.rows[0]?.payload ?? null;
  }
  async listGoalRuns(conversationId?: string): Promise<GoalRunRecord[]> {
    const result = await this.db.query<{ payload: GoalRunRecord }>(`SELECT payload FROM cluster_goal_runs WHERE ($1::text IS NULL OR conversation_id=$1) ORDER BY created_at DESC`, [conversationId ?? null]);
    return result.rows.map(row => row.payload);
  }
  async updateGoalRun(goal: GoalRunRecord, expectedRevision: number, fence?: GoalTurnFence): Promise<boolean> {
    if (goal.revision !== expectedRevision + 1) return false;
    const result = await this.db.query(`UPDATE cluster_goal_runs SET revision=$1, payload=$2 WHERE goal_run_id=$3 AND revision=$4 AND conversation_id=$5 AND user_message_id=$6 AND ($7::text IS NULL OR (payload->'turnLease'->>'ownerId'=$7 AND payload->'turnLease'->>'turnId'=$8 AND (payload->'turnLease'->>'generation')::bigint=$9 AND (payload->'turnLease'->>'expiresAt')::bigint > floor(extract(epoch from clock_timestamp()) * 1000)))`, [goal.revision, JSON.stringify(goal), goal.goalRunId, expectedRevision, goal.conversationId, goal.userMessageId, fence?.ownerId ?? null, fence?.turnId ?? null, fence?.generation ?? null]);
    return result.rowCount === 1;
  }
  async pruneStaleTelemetry(retentionDays: number): Promise<{ prunedSpans: number; prunedUsage: number }> {
    const cutoff = Date.now() - retentionDays * 86400000;
    const resSpans = await this.db.query<{ count: string }>(
      `DELETE FROM cluster_runtime_spans WHERE started_at < $1 AND payload->>'outcome' NOT IN ('running', 'outcome_unknown') RETURNING 1`,
      [cutoff]
    );
    const resUsage = await this.db.query<{ count: string }>(
      `DELETE FROM cluster_model_usage WHERE started_at < $1 AND status != 'started' RETURNING 1`,
      [cutoff]
    );
    return { prunedSpans: resSpans.rowCount ?? 0, prunedUsage: resUsage.rowCount ?? 0 };
  }

  async saveRuntimeSpan(span: RuntimeSpan): Promise<void> {
    await this.db.query(`INSERT INTO cluster_runtime_spans(span_id,trace_id,started_at,payload) VALUES($1,$2,$3,$4)
      ON CONFLICT(span_id) DO UPDATE SET payload=EXCLUDED.payload WHERE cluster_runtime_spans.payload->>'endTime' IS NULL AND cluster_runtime_spans.trace_id=EXCLUDED.trace_id AND cluster_runtime_spans.payload->>'taskId' IS NOT DISTINCT FROM EXCLUDED.payload->>'taskId'`,[span.spanId,span.traceId,span.startTime,JSON.stringify(span)]);
  }
  async listRuntimeSpans(traceId: string, offset = 0, limit = 1000): Promise<RuntimeSpan[]> {
    const result = await this.db.query<{payload:RuntimeSpan}>(`SELECT payload FROM cluster_runtime_spans WHERE trace_id=$1 ORDER BY started_at,span_id LIMIT $2 OFFSET $3`,[traceId,Math.min(1000,limit),offset]);
    return result.rows.map(row=>row.payload);
  }
  async saveModelUsage(record: ModelUsageRecord): Promise<void> {
    await this.db.query(`INSERT INTO cluster_model_usage (accounting_id,trace_id,graph_id,conversation_id,task_id,agent_id,node_id,started_at,status,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (accounting_id) DO UPDATE SET status=EXCLUDED.status, payload=EXCLUDED.payload
      WHERE cluster_model_usage.status='started'
        AND cluster_model_usage.trace_id IS NOT DISTINCT FROM EXCLUDED.trace_id
        AND cluster_model_usage.task_id IS NOT DISTINCT FROM EXCLUDED.task_id`,
      [record.accountingId,record.traceId ?? null,record.graphId ?? null,record.conversationId ?? null,record.taskId ?? null,record.agentId ?? null,record.nodeId ?? null,record.startedAt,record.status,JSON.stringify(record)]);
  }
  async listModelUsage(filter: { traceId?: string; graphId?: string; conversationId?: string; since?: number; until?: number; offset?: number; limit?: number }): Promise<ModelUsageRecord[]> {
    const result = await this.db.query<{payload:ModelUsageRecord}>(`SELECT payload FROM cluster_model_usage
      WHERE ($1::text IS NULL OR trace_id=$1) AND ($2::text IS NULL OR graph_id=$2) AND ($3::text IS NULL OR conversation_id=$3)
      AND started_at >= $4 AND started_at <= $5 ORDER BY started_at,accounting_id LIMIT $6 OFFSET $7`,
      [filter.traceId ?? null,filter.graphId ?? null,filter.conversationId ?? null,filter.since ?? 0,filter.until ?? Number.MAX_SAFE_INTEGER,Math.min(1000,filter.limit ?? 100),filter.offset ?? 0]);
    return result.rows.map(row => row.payload);
  }
  async purgeModelUsage(before: number): Promise<number> {
    const result = await this.db.query(`DELETE FROM cluster_model_usage WHERE started_at < $1 AND status <> 'started'`,[before]);
    return result.rowCount ?? 0;
  }

  private readonly conversationSnapshots = new ConversationSnapshots();

  constructor(private readonly db: ClusterDatabase) {}

  async createGraphAtomic(input: GraphCreation): Promise<void> {
    await this.db.transaction(async () => {
      if (input.goalRunId) await this.linkGoalWithinTransaction(input.goalRunId, "linkedGraphIds", input.graph.graphId, input.goalTurnFence, true, input);
      await this.saveGraph(input.graph);
      for (const node of input.nodes) await this.saveGraphNode(node);
      await this.saveGraphEdges(input.edges);
      await this.recordGraphRevision(input.revision);
      await this.appendGraphEvent(input.graph.graphId, "graph.created", input.event);
    });
  }

  private async linkGoalWithinTransaction(goalId: string, field: "linkedTaskIds" | "linkedGraphIds", id: string, fence?: GoalTurnFence, enforceFence = false, graphCreation?: GraphCreation): Promise<void> {
    const result = await this.db.query<{ payload: GoalRunRecord }>("SELECT payload FROM cluster_goal_runs WHERE goal_run_id=$1 FOR UPDATE", [goalId]);
    const goal = result.rows[0]?.payload;
    if (!goal) throw new ClusterStorageError("GoalRun not found");
    if (fence || enforceFence) assertGoalTurnFence(goal, fence, await this.databaseTimeMs());
    if (graphCreation) recordGraphCoverage(goal, graphCreation.graph, graphCreation.nodes, "admitted_graph", Date.now());
    goal[field] = [...new Set([...goal[field], id])];
    goal.status = "running"; goal.executionState = "running"; goal.finalReport = undefined; goal.reportFingerprint = undefined; goal.reportState = "pending"; goal.completedAt = undefined;
    goal.revision++; goal.updatedAt = Date.now();
    await this.db.query("UPDATE cluster_goal_runs SET revision=$1,payload=$2 WHERE goal_run_id=$3", [goal.revision, JSON.stringify(goal), goalId]);
  }

  async saveTaskWithGoal(task: ClusterTaskRecord, goalRunId: string, fence?: GoalTurnFence): Promise<void> {
    await this.db.transaction(async () => {
      await this.linkGoalWithinTransaction(goalRunId, "linkedTaskIds", task.taskId, fence, !task.dispatchOptions?.graphContext);
      await this.saveTask(task);
    });
  }
  async listGraphTaskAttempts(graphId: string, nodeId: string): Promise<ClusterTaskRecord[]> {
    const result = await this.db.query<{ task_id: string }>(`SELECT task_id FROM cluster_tasks WHERE dispatch_options->'graphContext'->>'graphId'=$1 AND dispatch_options->'graphContext'->>'graphNodeId'=$2 ORDER BY created_at, task_id`, [graphId, nodeId]);
    const tasks = await Promise.all(result.rows.map(row => this.getTask(row.task_id)));
    return tasks.filter((task): task is ClusterTaskRecord => task !== null)
      .sort((a, b) => (a.dispatchOptions?.graphContext?.executionAttempt ?? 0) - (b.dispatchOptions?.graphContext?.executionAttempt ?? 0) || a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
  }

  async claimScheduledTaskRun(candidate: ScheduledTaskRunRecord, force = false): Promise<{ run: ScheduledTaskRunRecord; admitted: boolean }> {
    return this.fencedForegroundMutation(() => this.db.transaction(async () => {
      const locked = await this.db.query("SELECT id FROM cluster_scheduled_tasks WHERE id=$1 FOR UPDATE", [candidate.scheduledTaskId]);
      if (!locked.rows.length) throw new ClusterStorageError("Scheduled task not found");
      const task = await this.getScheduledTask(candidate.scheduledTaskId);
      if (!task) throw new ClusterStorageError("Scheduled task not found");
      const active = await this.db.query("SELECT * FROM cluster_scheduled_task_runs WHERE scheduled_task_id=$1 AND status IN ('queued','running','outcome_unknown')", [task.id]);
      const unsettled = active.rows.map(decodeScheduledRun);
      const result = decideScheduleAdmission(task, candidate, await this.getScheduledTaskRun(candidate.id), unsettled, force);
      await this.saveScheduledTaskRun(result.run);
      return result;
    }));
  }

  async listScheduledTasksForExecution(afterId = "", limit = 100): Promise<ScheduledTaskRecord[]> {
    const result = await this.db.query("SELECT * FROM cluster_scheduled_tasks WHERE enabled=true AND id > $1 ORDER BY id LIMIT $2", [afterId, limit]);
    return result.rows.map(decodeScheduledTask);
  }

  async listUnsettledScheduledRuns(afterId = "", limit = 100): Promise<ScheduledTaskRunRecord[]> {
    const result = await this.db.query("SELECT * FROM cluster_scheduled_task_runs WHERE status IN ('queued','running','outcome_unknown') AND id > $1 ORDER BY id LIMIT $2", [afterId, limit]);
    return result.rows.map(decodeScheduledRun);
  }

  async getScheduledRunByExecution(taskId?: string, graphId?: string): Promise<ScheduledTaskRunRecord | null> {
    const result = await this.db.query("SELECT * FROM cluster_scheduled_task_runs WHERE status IN ('running','outcome_unknown') AND (($1::text IS NOT NULL AND task_id=$1) OR ($2::text IS NOT NULL AND graph_id=$2)) LIMIT 1", [taskId ?? null, graphId ?? null]);
    return result.rows[0] ? decodeScheduledRun(result.rows[0]) : null;
  }

  async getTaskCounts(): Promise<{ total: number; running: number }> {
    const result = await this.db.query<{total:string;running:string}>("SELECT count(*) AS total, count(*) FILTER (WHERE status='running') AS running FROM cluster_tasks");
    return { total: Number(result.rows[0].total), running: Number(result.rows[0].running) };
  }

  async findGraphNodeByTaskId(taskId: string): Promise<DistributedGraphNodeRecord | null> {
    const result = await this.db.query<{graph_id:string;node_id:string}>("SELECT graph_id,node_id FROM cluster_graph_nodes WHERE task_id=$1 LIMIT 1", [taskId]);
    return result.rows[0] ? this.getGraphNode(result.rows[0].graph_id, result.rows[0].node_id) : null;
  }

  async createNodeIfAbsent(node: ClusterNodeRecord): Promise<boolean> {
    const result = await this.db.query(`INSERT INTO cluster_nodes
      (node_id,name,role,platform,arch,hostname,token_hash,status,last_seen_at,metadata,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(node_id) DO NOTHING`,
      [node.nodeId,node.name,node.role,node.platform,node.arch,node.hostname,node.tokenHash,node.status,
        node.lastSeenAt,JSON.stringify(node.metadata ?? {}),node.createdAt,node.updatedAt]);
    return (result.rowCount ?? 0) === 1;
  }

  async rotateNodeToken(nodeId: string, tokenHash: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return false;
    const result = await this.db.query(
      `UPDATE cluster_nodes SET token_hash=$2, updated_at=$3 WHERE node_id=$1 AND status <> 'revoked'`,
      [nodeId, tokenHash, Date.now()]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async updateNodeConnection(node: ClusterNodeRecord): Promise<boolean> {
    const result = await this.db.query(`UPDATE cluster_nodes SET
      name=$3,platform=$4,arch=$5,hostname=$6,metadata=$7,status='online',last_seen_at=$8,updated_at=$9
      WHERE node_id=$1 AND token_hash=$2 AND status <> 'revoked'`,
      [node.nodeId,node.tokenHash,node.name,node.platform,node.arch,node.hostname,JSON.stringify(node.metadata ?? {}),node.lastSeenAt,node.updatedAt]);
    return (result.rowCount ?? 0) === 1;
  }

  async saveNode(node: ClusterNodeRecord): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_nodes (
        node_id, name, role, platform, arch, hostname, token_hash, status, last_seen_at, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (node_id) DO UPDATE SET
        name = EXCLUDED.name,
        role = EXCLUDED.role,
        platform = EXCLUDED.platform,
        arch = EXCLUDED.arch,
        hostname = EXCLUDED.hostname,
        token_hash = EXCLUDED.token_hash,
        status = EXCLUDED.status,
        last_seen_at = EXCLUDED.last_seen_at,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at
      `,
      [
        node.nodeId,
        node.name,
        node.role,
        node.platform,
        node.arch,
        node.hostname,
        node.tokenHash,
        node.status,
        node.lastSeenAt,
        JSON.stringify(node.metadata ?? {}),
        node.createdAt,
        Date.now(),
      ]
    );
  }

  async getNode(nodeId: string): Promise<ClusterNodeRecord | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_nodes WHERE node_id = $1`,
      [nodeId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      nodeId: r.node_id,
      name: r.name,
      role: r.role,
      platform: r.platform,
      arch: r.arch,
      hostname: r.hostname,
      tokenHash: r.token_hash,
      status: r.status,
      lastSeenAt: Number(r.last_seen_at),
      metadata: r.metadata ?? {},
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  async listNodes(): Promise<ClusterNodeRecord[]> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_nodes ORDER BY created_at ASC`
    );
    return res.rows.map((r) => ({
      nodeId: r.node_id,
      name: r.name,
      role: r.role,
      platform: r.platform,
      arch: r.arch,
      hostname: r.hostname,
      tokenHash: r.token_hash,
      status: r.status,
      lastSeenAt: Number(r.last_seen_at),
      metadata: r.metadata ?? {},
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }

  async updateNodeStatus(nodeId: string, status: ClusterNodeRecord["status"]): Promise<void> {
    await this.db.query(
      `UPDATE cluster_nodes SET status = $1, updated_at = $2 WHERE node_id = $3`,
      [status, Date.now(), nodeId]
    );
  }

  async updateNodeLastSeen(nodeId: string, lastSeenAt: number): Promise<void> {
    await this.db.query(
      `UPDATE cluster_nodes SET last_seen_at = $1, updated_at = $2, status = CASE WHEN status = 'suspect' THEN 'online' ELSE status END WHERE node_id = $3`,
      [lastSeenAt, Date.now(), nodeId]
    );
  }

  async saveTask(task: ClusterTaskRecord): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_tasks (
        task_id, node_id, project_id, goal, prompt, status, dispatch_attempt,
        result_summary, final_answer, deliverables, error, created_at, updated_at, completed_at, run_id, timeout_ms, dispatch_options
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (task_id) DO UPDATE SET
        status = EXCLUDED.status,
        dispatch_attempt = EXCLUDED.dispatch_attempt,
        result_summary = EXCLUDED.result_summary,
        final_answer = EXCLUDED.final_answer,
        deliverables = EXCLUDED.deliverables,
        error = EXCLUDED.error,
        updated_at = EXCLUDED.updated_at,
        completed_at = EXCLUDED.completed_at
      `,
      [
        task.taskId,
        task.nodeId,
        task.projectId,
        task.goal,
        task.prompt ?? null,
        task.status,
        task.dispatchAttempt,
        task.resultSummary ?? null,
        task.finalAnswer ?? null,
        task.deliverables ? JSON.stringify(task.deliverables) : null,
        task.error ?? null,
        task.createdAt,
        Date.now(),
        task.completedAt ?? null,
        task.runId ?? null,
        task.timeoutMs ?? null,
        task.dispatchOptions ? JSON.stringify(task.dispatchOptions) : null,
      ]
    );
  }

  async getTask(taskId: string): Promise<ClusterTaskRecord | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_tasks WHERE task_id = $1`,
      [taskId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      taskId: r.task_id,
      nodeId: r.node_id,
      projectId: r.project_id,
      goal: r.goal,
      prompt: r.prompt,
      status: r.status,
      dispatchAttempt: Number(r.dispatch_attempt),
      dispatchOptions: r.dispatch_options ?? undefined,
      runId: r.run_id ?? undefined,
      timeoutMs: r.timeout_ms ? Number(r.timeout_ms) : undefined,
      resultSummary: r.result_summary,
      finalAnswer: r.final_answer,
      deliverables: r.deliverables,
      error: r.error,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      completedAt: r.completed_at ? Number(r.completed_at) : undefined,
    };
  }

  async listTasks(filter?: { nodeId?: string; projectId?: string; status?: ClusterTaskStatus; limit?: number }): Promise<ClusterTaskRecord[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filter?.nodeId) {
      conditions.push(`node_id = $${idx++}`);
      params.push(filter.nodeId);
    }
    if (filter?.projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(filter.projectId);
    }
    if (filter?.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filter.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter?.limit ? `LIMIT ${filter.limit}` : "LIMIT 100";

    const res = await this.db.query<any>(
      `SELECT * FROM cluster_tasks ${where} ORDER BY updated_at DESC ${limit}`,
      params
    );

    return res.rows.map((r) => ({
      taskId: r.task_id,
      nodeId: r.node_id,
      projectId: r.project_id,
      goal: r.goal,
      prompt: r.prompt,
      status: r.status,
      dispatchAttempt: Number(r.dispatch_attempt),
      dispatchOptions: r.dispatch_options ?? undefined,
      runId: r.run_id ?? undefined,
      timeoutMs: r.timeout_ms ? Number(r.timeout_ms) : undefined,
      resultSummary: r.result_summary,
      finalAnswer: r.final_answer,
      deliverables: r.deliverables,
      error: r.error,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      completedAt: r.completed_at ? Number(r.completed_at) : undefined,
    }));
  }

  async updateTaskStatus(
    taskId: string,
    status: ClusterTaskStatus,
    details?: { error?: string; resultSummary?: string; finalAnswer?: string; deliverables?: any }
  ): Promise<void> {
    const completedAt = ["completed", "failed", "cancelled"].includes(status) ? Date.now() : null;
    await this.db.query(
      `
      UPDATE cluster_tasks
      SET
        status = $1,
        error = COALESCE($2, error),
        result_summary = COALESCE($3, result_summary),
        final_answer = COALESCE($4, final_answer),
        deliverables = COALESCE($5, deliverables),
        completed_at = COALESCE($6, completed_at),
        updated_at = $7
      WHERE task_id = $8
        AND (status = $1 OR status NOT IN ('completed', 'failed', 'cancelled'))
        AND (status <> 'cancelling' OR $1 IN ('cancelling', 'completed', 'failed', 'cancelled', 'outcome_unknown'))
        AND ($1 NOT IN ('created', 'queued', 'dispatched', 'accepted')
          OR array_position(ARRAY['created','queued','dispatched','accepted'], status)
             <= array_position(ARRAY['created','queued','dispatched','accepted'], $1))
      `,
      [
        status,
        details?.error ?? null,
        details?.resultSummary ?? null,
        details?.finalAnswer ?? null,
        details?.deliverables ? JSON.stringify(details.deliverables) : null,
        completedAt,
        Date.now(),
        taskId,
      ]
    );
  }

  async appendEvents(events: SequencedEvent[]): Promise<number> {
    let inserted = 0;
    for (let offset = 0; offset < events.length; offset += 200) {
      const first = new Map<string, SequencedEvent>();
      for (const event of events.slice(offset, offset + 200)) {
        const key = JSON.stringify([event.taskId, event.seq]);
        if (!first.has(key)) first.set(key, event);
      }
      const rows = [...first.values()].map(ev => ({ task_id: ev.taskId, run_id: ev.runId, node_id: ev.nodeId,
        seq: ev.seq, event_type: ev.eventType, payload: ev.data ?? {}, created_at: ev.timestamp }));
      const res = await this.db.query(`INSERT INTO cluster_events (task_id, run_id, node_id, seq, event_type, payload, created_at)
        SELECT task_id, run_id, node_id, seq, event_type, payload, created_at
        FROM jsonb_to_recordset($1::jsonb) AS incoming(task_id text, run_id text, node_id text, seq bigint, event_type text, payload jsonb, created_at bigint)
        ON CONFLICT (task_id, seq) DO NOTHING`, [JSON.stringify(rows)]);
      inserted += res.rowCount ?? 0;
    }
    return inserted;
  }

  async getEventsForTask(taskId: string, fromSeq = 0, limit = 500): Promise<SequencedEvent[]> {
    const res = await this.db.query<any>(
      `
      SELECT * FROM cluster_events
      WHERE task_id = $1 AND seq >= $2
      ORDER BY seq ASC
      LIMIT $3
      `,
      [taskId, fromSeq, limit]
    );

    return res.rows.map((r) => ({
      seq: Number(r.seq),
      taskId: r.task_id,
      runId: r.run_id,
      nodeId: r.node_id,
      eventType: r.event_type,
      timestamp: Number(r.created_at),
      data: r.payload ?? {},
    }));
  }

  async saveApproval(approval: ClusterApprovalRecord): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_approvals (
        approval_id, task_id, run_id, node_id, agent_id, capability, reason, target, tool_name,
        status, decision, requested_at, expires_at, resolved_at, resolved_by, grant_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (approval_id) DO UPDATE SET
        status = EXCLUDED.status,
        decision = EXCLUDED.decision,
        resolved_at = EXCLUDED.resolved_at,
        resolved_by = EXCLUDED.resolved_by,
        grant_id = EXCLUDED.grant_id
      `,
      [
        approval.approvalId,
        approval.taskId,
        approval.runId,
        approval.nodeId,
        approval.agentId,
        approval.capability,
        approval.reason,
        approval.target ?? null,
        approval.toolName ?? null,
        approval.status,
        approval.decision ?? null,
        approval.requestedAt,
        approval.expiresAt,
        approval.resolvedAt ?? null,
        approval.resolvedBy ?? null,
        approval.grantId ?? null,
      ]
    );
  }

  async getApproval(approvalId: string): Promise<ClusterApprovalRecord | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_approvals WHERE approval_id = $1`,
      [approvalId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      approvalId: r.approval_id,
      taskId: r.task_id,
      runId: r.run_id,
      nodeId: r.node_id,
      agentId: r.agent_id,
      capability: r.capability,
      reason: r.reason,
      target: r.target,
      toolName: r.tool_name,
      status: r.status,
      decision: r.decision,
      requestedAt: Number(r.requested_at),
      expiresAt: Number(r.expires_at),
      resolvedAt: r.resolved_at ? Number(r.resolved_at) : undefined,
      resolvedBy: r.resolved_by,
      grantId: r.grant_id ?? undefined,
    };
  }

  async listPendingApprovals(): Promise<ClusterApprovalRecord[]> {
    const now = Date.now();
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_approvals WHERE status = 'pending' AND expires_at > $1 ORDER BY requested_at ASC`,
      [now]
    );
    return res.rows.map((r) => ({
      approvalId: r.approval_id,
      taskId: r.task_id,
      runId: r.run_id,
      nodeId: r.node_id,
      agentId: r.agent_id,
      capability: r.capability,
      reason: r.reason,
      target: r.target,
      toolName: r.tool_name,
      status: r.status,
      decision: r.decision,
      requestedAt: Number(r.requested_at),
      expiresAt: Number(r.expires_at),
      resolvedAt: r.resolved_at ? Number(r.resolved_at) : undefined,
      resolvedBy: r.resolved_by,
      grantId: r.grant_id ?? undefined,
    }));
  }

  async listApprovalHistory(limit = 100): Promise<ClusterApprovalRecord[]> {
    const now = Date.now();
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_approvals WHERE status <> 'pending' OR expires_at <= $1 ORDER BY requested_at DESC LIMIT $2`,
      [now, limit]
    );
    return res.rows.map((r) => ({
      approvalId: r.approval_id,
      taskId: r.task_id,
      runId: r.run_id,
      nodeId: r.node_id,
      agentId: r.agent_id,
      capability: r.capability,
      reason: r.reason,
      target: r.target,
      toolName: r.tool_name,
      status: r.status === "pending" ? "expired" : r.status,
      decision: r.decision,
      requestedAt: Number(r.requested_at),
      expiresAt: Number(r.expires_at),
      resolvedAt: r.resolved_at ? Number(r.resolved_at) : undefined,
      resolvedBy: r.resolved_by,
      grantId: r.grant_id ?? undefined,
    }));
  }

  async resolveApproval(
    approvalId: string,
    decision: "allow-once" | "deny" | "grant-task-full-access",
    resolvedBy = "admin",
    grantId?: string
  ): Promise<boolean> {
    const res = await this.db.query(
      `
      UPDATE cluster_approvals
      SET status = 'resolved', decision = $1, resolved_at = $2, resolved_by = $3, grant_id = $4
      WHERE approval_id = $5 AND status = 'pending'
      `,
      [decision, Date.now(), resolvedBy, grantId ?? null, approvalId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  private mapTaskSecurityGrant(r: any): TaskSecurityGrant {
    return {
      grantId: r.grant_id,
      approvalId: r.approval_id,
      nodeId: r.node_id,
      taskId: r.task_id,
      runId: r.run_id,
      authorizationMode: r.authorization_mode,
      originalPolicy: typeof r.original_policy === "string" ? JSON.parse(r.original_policy) : r.original_policy,
      targetPolicy: typeof r.target_policy === "string" ? JSON.parse(r.target_policy) : r.target_policy,
      authorizedBy: r.authorized_by,
      grantedAt: Number(r.granted_at),
      effectiveAt: r.effective_at ? Number(r.effective_at) : undefined,
      workerAckAt: r.worker_ack_at ? Number(r.worker_ack_at) : undefined,
      revokedAt: r.revoked_at ? Number(r.revoked_at) : undefined,
      expiredAt: r.expired_at ? Number(r.expired_at) : undefined,
      revokedBy: r.revoked_by ?? undefined,
      lastError: r.last_error ?? undefined,
      reconciliationRequired: r.reconciliation_required ?? false,
      appliesTo: "subsequent-tool-calls",
      status: r.status,
      configurationVersion: Number(r.configuration_version),
    };
  }

  async saveTaskSecurityGrant(grant: TaskSecurityGrant): Promise<boolean> {
    try {
      return await this.insertTaskSecurityGrant(grant);
    } catch (error) {
      // 23505: 同一审批已存在「生效中」的授权（部分唯一索引）。
      // 并发重复授权按幂等冲突返回 false，由调用方重新读取真实状态。
      if ((error as { code?: string }).code === "23505") return false;
      throw error;
    }
  }

  private async insertTaskSecurityGrant(grant: TaskSecurityGrant): Promise<boolean> {
    const res = await this.db.query(
      `
      INSERT INTO cluster_task_grants(
        grant_id, approval_id, node_id, task_id, run_id, authorization_mode,
        original_policy, target_policy, authorized_by, granted_at, effective_at,
        worker_ack_at, revoked_at, expired_at, status, configuration_version,
        revoked_by, last_error, reconciliation_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT DO NOTHING
      `,
      [
        grant.grantId, grant.approvalId, grant.nodeId, grant.taskId, grant.runId, grant.authorizationMode,
        JSON.stringify(grant.originalPolicy), JSON.stringify(grant.targetPolicy), grant.authorizedBy,
        grant.grantedAt, grant.effectiveAt ?? null, grant.workerAckAt ?? null, grant.revokedAt ?? null,
        grant.expiredAt ?? null, grant.status, grant.configurationVersion,
        grant.revokedBy ?? null, grant.lastError ?? null, grant.reconciliationRequired ?? false,
      ]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getTaskSecurityGrant(grantId: string): Promise<TaskSecurityGrant | null> {
    const res = await this.db.query(`SELECT * FROM cluster_task_grants WHERE grant_id = $1`, [grantId]);
    return res.rows[0] ? this.mapTaskSecurityGrant(res.rows[0]) : null;
  }

  async getTaskSecurityGrantByApproval(approvalId: string): Promise<TaskSecurityGrant | null> {
    const res = await this.db.query(`SELECT * FROM cluster_task_grants WHERE approval_id = $1 ORDER BY granted_at DESC LIMIT 1`, [approvalId]);
    return res.rows[0] ? this.mapTaskSecurityGrant(res.rows[0]) : null;
  }

  async getActiveTaskSecurityGrant(taskId: string, runId: string): Promise<TaskSecurityGrant | null> {
    const res = await this.db.query(
      `SELECT * FROM cluster_task_grants WHERE task_id = $1 AND run_id = $2 AND status = 'applied' ORDER BY granted_at DESC LIMIT 1`,
      [taskId, runId]
    );
    return res.rows[0] ? this.mapTaskSecurityGrant(res.rows[0]) : null;
  }

  async listTaskSecurityGrants(filter?: TaskSecurityGrantFilter): Promise<TaskSecurityGrant[]> {
    const clauses: string[] = [];
    const values: any[] = [];
    if (filter?.taskId) { values.push(filter.taskId); clauses.push(`task_id = $${values.length}`); }
    if (filter?.runId) { values.push(filter.runId); clauses.push(`run_id = $${values.length}`); }
    if (filter?.nodeId) { values.push(filter.nodeId); clauses.push(`node_id = $${values.length}`); }
    if (filter?.approvalId) { values.push(filter.approvalId); clauses.push(`approval_id = $${values.length}`); }
    if (filter?.status) { values.push(filter.status); clauses.push(`status = $${values.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.db.query(`SELECT * FROM cluster_task_grants ${where} ORDER BY granted_at DESC`, values);
    return res.rows.map((r: any) => this.mapTaskSecurityGrant(r));
  }

  async transitionTaskSecurityGrant(
    grantId: string,
    from: TaskSecurityGrant["status"][],
    to: TaskSecurityGrant["status"],
    details?: TaskSecurityGrantTransitionDetails
  ): Promise<boolean> {
    if (!from.length) return false;
    const sets: string[] = ["status = $3"];
    const vals: any[] = [grantId, from, to];
    if (details?.effectiveAt !== undefined) { vals.push(details.effectiveAt); sets.push(`effective_at = $${vals.length}`); }
    if (details?.workerAckAt !== undefined) { vals.push(details.workerAckAt); sets.push(`worker_ack_at = $${vals.length}`); }
    if (details?.revokedAt !== undefined) { vals.push(details.revokedAt); sets.push(`revoked_at = $${vals.length}`); }
    if (details?.expiredAt !== undefined) { vals.push(details.expiredAt); sets.push(`expired_at = $${vals.length}`); }
    if (details?.revokedBy !== undefined) { vals.push(details.revokedBy); sets.push(`revoked_by = $${vals.length}`); }
    if (details?.lastError !== undefined) { vals.push(details.lastError); sets.push(`last_error = $${vals.length}`); }
    if (details?.reconciliationRequired !== undefined) { vals.push(details.reconciliationRequired); sets.push(`reconciliation_required = $${vals.length}`); }
    const res = await this.db.query(
      `UPDATE cluster_task_grants SET ${sets.join(", ")} WHERE grant_id = $1 AND status = ANY($2::text[])`,
      vals
    );
    return (res.rowCount ?? 0) > 0;
  }

  async expireTaskSecurityGrantsForTask(taskId: string): Promise<number> {
    const res = await this.db.query(
      `UPDATE cluster_task_grants SET status = 'expired', expired_at = $1 WHERE task_id = $2 AND status IN ('granted', 'applied')`,
      [Date.now(), taskId]
    );
    return res.rowCount ?? 0;
  }


  async enqueueOutbox(record: Omit<ClusterOutboxRecord, "id">): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_outbox (target_node_id, message_id, message_type, payload, status, attempts, next_retry_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT DO NOTHING
      `,
      [
        record.targetNodeId,
        record.messageId,
        record.messageType,
        JSON.stringify(record.payload),
        record.status,
        record.attempts,
        record.nextRetryAt,
        record.createdAt,
      ]
    );
  }

  async hasOutboxMessage(messageId: string): Promise<boolean> {
    return (await this.db.query("SELECT 1 FROM cluster_outbox WHERE message_id = $1", [messageId])).rows.length > 0;
  }

  async pollPendingOutbox(limit = 50): Promise<ClusterOutboxRecord[]> {
    const now = Date.now();
    const res = await this.db.query<any>(
      `
      SELECT * FROM cluster_outbox
      WHERE status = 'pending' AND next_retry_at <= $1
      ORDER BY id ASC
      LIMIT $2
      `,
      [now, limit]
    );

    return res.rows.map((r) => ({
      id: Number(r.id),
      targetNodeId: r.target_node_id,
      messageId: r.message_id,
      messageType: r.message_type,
      payload: r.payload,
      status: r.status,
      attempts: Number(r.attempts),
      nextRetryAt: Number(r.next_retry_at),
      createdAt: Number(r.created_at),
    }));
  }

  async markOutboxSent(messageId: string): Promise<void> {
    await this.db.query(
      `UPDATE cluster_outbox SET status = 'sent' WHERE message_id = $1`,
      [messageId]
    );
  }

  async checkAndRecordInbox(messageId: string, sourceNodeId: string): Promise<boolean> {
    const res = await this.db.query(
      `
      INSERT INTO cluster_inbox (message_id, source_node_id, received_at, processed_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (message_id) DO NOTHING
      `,
      [messageId, sourceNodeId, Date.now(), Date.now()]
    );
    return (res.rowCount ?? 0) > 0;
  }

  // Catalog & Memory Implementations (Postgres)
  async saveCatalogRevision(
    nodeId: string,
    revision: number,
    capabilities: NodeHardwareCapability[],
    syncStatus = "idle"
  ): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_catalog_revisions (node_id, catalog_revision, hardware_capabilities, last_sync_at, sync_status, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (node_id) DO UPDATE SET
        catalog_revision = EXCLUDED.catalog_revision,
        hardware_capabilities = EXCLUDED.hardware_capabilities,
        last_sync_at = EXCLUDED.last_sync_at,
        sync_status = EXCLUDED.sync_status,
        updated_at = EXCLUDED.updated_at
      `,
      [nodeId, revision, JSON.stringify(capabilities), Date.now(), syncStatus, Date.now()]
    );
  }

  async getCatalogRevision(
    nodeId: string
  ): Promise<{ revision: number; capabilities: NodeHardwareCapability[]; lastSyncAt: number; syncStatus: string } | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_catalog_revisions WHERE node_id = $1`,
      [nodeId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      revision: Number(r.catalog_revision),
      capabilities: Array.isArray(r.hardware_capabilities) ? r.hardware_capabilities : [],
      lastSyncAt: Number(r.last_sync_at),
      syncStatus: r.sync_status,
    };
  }

  async upsertNodeCatalogSnapshot(snapshot: CatalogSyncSnapshotPayload): Promise<void> {
    validateCatalogSnapshot(snapshot);
    await this.db.transaction(async () => {
      for (const table of ["cluster_project_catalog", "cluster_skill_catalog", "cluster_mcp_catalog"]) {
        const discoveryFilter = table === "cluster_project_catalog" ? " AND project_id NOT LIKE 'discovered-%'" : "";
        await this.db.query(`DELETE FROM ${table} WHERE node_id=$1${discoveryFilter}`, [snapshot.nodeId]);
      }
      await this.upsertProjectCatalog(snapshot.projects);
      await this.upsertSkillCatalog(snapshot.skills);
      await this.upsertMCPCatalog(snapshot.mcp);
      await this.upsertWorkerMemorySnapshot(snapshot.nodeId, snapshot.memoryIndex);
      await this.saveCatalogRevision(snapshot.nodeId, snapshot.catalogRevision, snapshot.hardwareCapabilities, "idle");
    });
  }

  async upsertProjectCatalog(projects: ProjectCatalogItem[]): Promise<void> {
    for (const p of projects) {
      await this.db.query(
        `
        INSERT INTO cluster_project_catalog (
          node_id, project_id, name, summary, description, technologies, capabilities,
          status, visibility, registered_at, updated_at, last_indexed_at, revision, user_aliases
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (node_id, project_id) DO UPDATE SET
          name = EXCLUDED.name,
          summary = EXCLUDED.summary,
          description = EXCLUDED.description,
          technologies = EXCLUDED.technologies,
          capabilities = EXCLUDED.capabilities,
          status = EXCLUDED.status,
          visibility = EXCLUDED.visibility,
          updated_at = EXCLUDED.updated_at,
          last_indexed_at = EXCLUDED.last_indexed_at,
          revision = EXCLUDED.revision,
          user_aliases = EXCLUDED.user_aliases
        `,
        [
          p.nodeId,
          p.projectId,
          p.name,
          p.summary,
          p.description,
          JSON.stringify(p.technologies ?? []),
          JSON.stringify(p.capabilities ?? []),
          p.status,
          p.visibility,
          p.registeredAt,
          p.updatedAt,
          p.lastIndexedAt,
          p.revision,
          JSON.stringify(p.userAliases ?? []),
        ]
      );
    }
  }

  async deleteProjectCatalog(nodeId: string, projectIds: string[]): Promise<void> {
    if (projectIds.length === 0) return;
    await this.db.query(
      `DELETE FROM cluster_project_catalog WHERE node_id = $1 AND project_id = ANY($2::varchar[])`,
      [nodeId, projectIds]
    );
  }

  async listProjectsCatalog(filter?: { nodeId?: string; visibility?: string }): Promise<ProjectCatalogItem[]> {
    let sql = `SELECT * FROM cluster_project_catalog WHERE 1=1`;
    const params: any[] = [];
    if (filter?.nodeId) {
      params.push(filter.nodeId);
      sql += ` AND node_id = $${params.length}`;
    }
    if (filter?.visibility) {
      params.push(filter.visibility);
      sql += ` AND visibility = $${params.length}`;
    }
    sql += ` ORDER BY updated_at DESC`;
    const res = await this.db.query<any>(sql, params);
    return res.rows.map((r) => ({
      projectId: r.project_id,
      nodeId: r.node_id,
      name: r.name,
      summary: r.summary,
      description: r.description,
      technologies: Array.isArray(r.technologies) ? r.technologies : [],
      capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
      status: r.status,
      visibility: r.visibility,
      registeredAt: Number(r.registered_at),
      updatedAt: Number(r.updated_at),
      lastIndexedAt: Number(r.last_indexed_at),
      revision: Number(r.revision),
      userAliases: Array.isArray(r.user_aliases) ? r.user_aliases : [],
    }));
  }

  async getProjectCatalog(nodeId: string, projectId: string): Promise<ProjectCatalogItem | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_project_catalog WHERE node_id = $1 AND project_id = $2`,
      [nodeId, projectId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      projectId: r.project_id,
      nodeId: r.node_id,
      name: r.name,
      summary: r.summary,
      description: r.description,
      technologies: Array.isArray(r.technologies) ? r.technologies : [],
      capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
      status: r.status,
      visibility: r.visibility,
      registeredAt: Number(r.registered_at),
      updatedAt: Number(r.updated_at),
      lastIndexedAt: Number(r.last_indexed_at),
      revision: Number(r.revision),
      userAliases: Array.isArray(r.user_aliases) ? r.user_aliases : [],
    };
  }

  async upsertSkillCatalog(skills: SkillCatalogItem[]): Promise<void> {
    for (const s of skills) {
      await this.db.query(
        `
        INSERT INTO cluster_skill_catalog (
          node_id, skill_id, project_id, name, description, scope, tags, fingerprint, available, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (node_id, skill_id) DO UPDATE SET
          project_id = EXCLUDED.project_id,
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          scope = EXCLUDED.scope,
          tags = EXCLUDED.tags,
          fingerprint = EXCLUDED.fingerprint,
          available = EXCLUDED.available,
          updated_at = EXCLUDED.updated_at
        `,
        [
          s.nodeId,
          s.skillId,
          s.projectId ?? null,
          s.name,
          s.description,
          s.scope,
          JSON.stringify(s.tags ?? []),
          s.fingerprint,
          s.available,
          s.updatedAt,
        ]
      );
    }
  }

  async deleteSkillCatalog(nodeId: string, skillIds: string[]): Promise<void> {
    if (skillIds.length === 0) return;
    await this.db.query(
      `DELETE FROM cluster_skill_catalog WHERE node_id = $1 AND skill_id = ANY($2::varchar[])`,
      [nodeId, skillIds]
    );
  }

  async listSkillsCatalog(filter?: { nodeId?: string; projectId?: string }): Promise<SkillCatalogItem[]> {
    let sql = `SELECT * FROM cluster_skill_catalog WHERE 1=1`;
    const params: any[] = [];
    if (filter?.nodeId) {
      params.push(filter.nodeId);
      sql += ` AND node_id = $${params.length}`;
    }
    if (filter?.projectId) {
      params.push(filter.projectId);
      sql += ` AND project_id = $${params.length}`;
    }
    sql += ` ORDER BY name ASC`;
    const res = await this.db.query<any>(sql, params);
    return res.rows.map((r) => ({
      skillId: r.skill_id,
      nodeId: r.node_id,
      projectId: r.project_id ?? undefined,
      name: r.name,
      description: r.description,
      scope: r.scope,
      tags: Array.isArray(r.tags) ? r.tags : [],
      fingerprint: r.fingerprint,
      available: Boolean(r.available),
      updatedAt: Number(r.updated_at),
    }));
  }

  async upsertMCPCatalog(mcpList: MCPCapabilityCatalogItem[]): Promise<void> {
    for (const m of mcpList) {
      await this.db.query(
        `
        INSERT INTO cluster_mcp_catalog (
          node_id, server_id, display_name, transport_type, status, capability_summary,
          tools, resource_count, prompt_count, last_verified_at, revision
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (node_id, server_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          transport_type = EXCLUDED.transport_type,
          status = EXCLUDED.status,
          capability_summary = EXCLUDED.capability_summary,
          tools = EXCLUDED.tools,
          resource_count = EXCLUDED.resource_count,
          prompt_count = EXCLUDED.prompt_count,
          last_verified_at = EXCLUDED.last_verified_at,
          revision = EXCLUDED.revision
        `,
        [
          m.nodeId,
          m.serverId,
          m.displayName,
          m.transportType,
          m.status,
          m.capabilitySummary,
          JSON.stringify(m.tools ?? []),
          m.resourceCount,
          m.promptCount,
          m.lastVerifiedAt,
          m.revision,
        ]
      );
    }
  }

  async deleteMCPCatalog(nodeId: string, serverIds: string[]): Promise<void> {
    if (serverIds.length === 0) return;
    await this.db.query(
      `DELETE FROM cluster_mcp_catalog WHERE node_id = $1 AND server_id = ANY($2::varchar[])`,
      [nodeId, serverIds]
    );
  }

  async listMCPCatalog(filter?: { nodeId?: string }): Promise<MCPCapabilityCatalogItem[]> {
    let sql = `SELECT * FROM cluster_mcp_catalog WHERE 1=1`;
    const params: any[] = [];
    if (filter?.nodeId) {
      params.push(filter.nodeId);
      sql += ` AND node_id = $${params.length}`;
    }
    sql += ` ORDER BY display_name ASC`;
    const res = await this.db.query<any>(sql, params);
    return res.rows.map((r) => ({
      serverId: r.server_id,
      nodeId: r.node_id,
      displayName: r.display_name,
      transportType: r.transport_type,
      status: r.status,
      capabilitySummary: r.capability_summary,
      tools: Array.isArray(r.tools) ? r.tools : [],
      resourceCount: Number(r.resource_count),
      promptCount: Number(r.prompt_count),
      lastVerifiedAt: Number(r.last_verified_at),
      revision: Number(r.revision),
    }));
  }

  async upsertMemoryIndex(entries: FederatedMemoryIndexItem[]): Promise<void> {
    for (const e of entries) {
      await this.db.query(
        `
        INSERT INTO cluster_memory_index (
          node_id, entry_id, project_id, topic, summary, keywords, source_reference,
          confidence, visibility, revision, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (node_id, entry_id) DO UPDATE SET
          project_id = EXCLUDED.project_id,
          topic = EXCLUDED.topic,
          summary = EXCLUDED.summary,
          keywords = EXCLUDED.keywords,
          source_reference = EXCLUDED.source_reference,
          confidence = EXCLUDED.confidence,
          visibility = EXCLUDED.visibility,
          revision = EXCLUDED.revision,
          updated_at = EXCLUDED.updated_at
        `,
        [
          e.nodeId,
          e.entryId,
          e.projectId,
          e.topic,
          e.summary,
          JSON.stringify(e.keywords ?? []),
          e.sourceReference,
          e.confidence,
          e.visibility,
          e.revision,
          e.updatedAt,
        ]
      );
    }
  }

  async upsertWorkerMemorySnapshot(nodeId: string, entries: FederatedMemoryIndexItem[]): Promise<void> {
    validateWorkerMemorySnapshot(nodeId, entries);
    // One statement makes both the upsert and removal atomic, including an empty snapshot.
    await this.db.query(`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($2::jsonb) AS entry(
          "entryId" text, "projectId" text, topic text, summary text, keywords jsonb,
          "sourceReference" text, confidence double precision, visibility text, revision integer, "updatedAt" bigint
        )
      ), updated AS (
        INSERT INTO cluster_memory_index (
          node_id, entry_id, project_id, topic, summary, keywords, source_reference, confidence, visibility, revision, updated_at
        ) SELECT $1, "entryId", "projectId", topic, summary, COALESCE(keywords, '[]'::jsonb), "sourceReference", confidence, visibility, revision, "updatedAt" FROM incoming
        ON CONFLICT (node_id, entry_id) DO UPDATE SET
          project_id=EXCLUDED.project_id, topic=EXCLUDED.topic, summary=EXCLUDED.summary,
          keywords=EXCLUDED.keywords, source_reference=EXCLUDED.source_reference, confidence=EXCLUDED.confidence,
          visibility=EXCLUDED.visibility, revision=EXCLUDED.revision, updated_at=EXCLUDED.updated_at
        RETURNING entry_id
      )
      DELETE FROM cluster_memory_index WHERE node_id=$1 AND entry_id NOT LIKE 'mem-disc-%'
        AND NOT (entry_id=ANY($3::varchar[]))
    `, [nodeId, JSON.stringify(entries), entries.map((entry) => entry.entryId)]);
  }

  async deleteMemoryIndex(nodeId: string, entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) return;
    await this.db.query(
      `DELETE FROM cluster_memory_index WHERE node_id = $1 AND entry_id = ANY($2::varchar[])`,
      [nodeId, entryIds]
    );
  }

  async deleteProjectMemoryIndex(nodeId: string, projectId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM cluster_memory_index WHERE node_id = $1 AND project_id = $2`,
      [nodeId, projectId]
    );
  }

  async listMemoryIndex(filter?: { nodeId?: string; projectId?: string }): Promise<FederatedMemoryIndexItem[]> {
    let sql = `SELECT * FROM cluster_memory_index WHERE 1=1`;
    const params: any[] = [];
    if (filter?.nodeId) {
      params.push(filter.nodeId);
      sql += ` AND node_id = $${params.length}`;
    }
    if (filter?.projectId) {
      params.push(filter.projectId);
      sql += ` AND project_id = $${params.length}`;
    }
    sql += ` ORDER BY updated_at DESC`;
    const res = await this.db.query<any>(sql, params);
    return res.rows.map((r) => ({
      entryId: r.entry_id,
      nodeId: r.node_id,
      projectId: r.project_id,
      topic: r.topic,
      summary: r.summary,
      keywords: Array.isArray(r.keywords) ? r.keywords : [],
      sourceReference: r.source_reference,
      confidence: Number(r.confidence),
      visibility: r.visibility,
      revision: Number(r.revision),
      updatedAt: Number(r.updated_at),
    }));
  }

  async saveTombstones(tombstones: CatalogTombstoneItem[], nodeId: string): Promise<void> {
    for (const t of tombstones) {
      await this.db.query(
        `
        INSERT INTO cluster_catalog_tombstones (node_id, resource_type, resource_id, project_id, deleted_at, revision)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (node_id, resource_type, resource_id) DO UPDATE SET
          project_id = EXCLUDED.project_id,
          deleted_at = EXCLUDED.deleted_at,
          revision = EXCLUDED.revision
        `,
        [nodeId, t.resourceType, t.resourceId, t.projectId ?? null, t.deletedAt, t.revision]
      );
    }
  }

  async getTombstones(nodeId: string, sinceRevision = 0): Promise<CatalogTombstoneItem[]> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_catalog_tombstones WHERE node_id = $1 AND revision >= $2 ORDER BY deleted_at ASC`,
      [nodeId, sinceRevision]
    );
    return res.rows.map((r) => ({
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      projectId: r.project_id ?? undefined,
      deletedAt: Number(r.deleted_at),
      revision: Number(r.revision),
    }));
  }

  async recordSyncLog(
    nodeId: string,
    syncType: string,
    revision: number,
    itemCounts: Record<string, number>,
    status: string,
    error?: string
  ): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_catalog_sync_log (node_id, sync_type, revision, item_counts, status, error, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [nodeId, syncType, revision, JSON.stringify(itemCounts), status, error ?? null, Date.now()]
    );
  }

  async listTombstones(nodeId?: string): Promise<CatalogTombstoneItem[]> {
    let sql = `SELECT * FROM cluster_catalog_tombstones WHERE 1=1`;
    const params: any[] = [];
    if (nodeId) {
      params.push(nodeId);
      sql += ` AND node_id = $1`;
    }
    sql += ` ORDER BY deleted_at ASC`;
    const res = await this.db.query<any>(sql, params);
    return res.rows.map((r) => ({
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      projectId: r.project_id ?? undefined,
      deletedAt: Number(r.deleted_at),
      revision: Number(r.revision),
    }));
  }

  async recordRouteDecision(record: ClusterRouteRecord): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_routes (
        route_id, task_id, user_request, intent, decision_type,
        selected_node_id, selected_project_id, reason, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (route_id) DO UPDATE SET
        task_id = EXCLUDED.task_id,
        decision_type = EXCLUDED.decision_type,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at
      `,
      [
        record.routeId,
        record.taskId ?? null,
        record.userRequest,
        JSON.stringify(record.intent ?? {}),
        record.decisionType,
        record.selectedNodeId ?? null,
        record.selectedProjectId ?? null,
        record.reason,
        record.status,
        record.createdAt,
        record.updatedAt,
      ]
    );

    if (Array.isArray(record.candidatesSnapshot) && record.candidatesSnapshot.length > 0) {
      for (const c of record.candidatesSnapshot) {
        await this.db.query(
          `
          INSERT INTO cluster_route_candidates (
            route_id, node_id, project_id, project_name, score, confidence,
            hard_constraints_satisfied, unsatisfied_constraints, evidences, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `,
          [
            record.routeId,
            c.nodeId,
            c.projectId,
            c.projectName,
            c.score,
            c.confidence,
            c.hardConstraintsSatisfied,
            JSON.stringify(c.unsatisfiedConstraints ?? []),
            JSON.stringify(c.evidences ?? []),
            Date.now(),
          ]
        );
      }
    }
  }

  async getRouteDecision(routeId: string): Promise<ClusterRouteRecord | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_routes WHERE route_id = $1`,
      [routeId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      routeId: r.route_id,
      taskId: r.task_id ?? undefined,
      userRequest: r.user_request,
      intent: r.intent,
      decisionType: r.decision_type,
      selectedNodeId: r.selected_node_id ?? undefined,
      selectedProjectId: r.selected_project_id ?? undefined,
      reason: r.reason,
      status: r.status,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  async recordRouteReplan(record: any): Promise<void> {
    await this.fencedForegroundMutation(async () => { await this.db.query(
      `
      INSERT INTO cluster_route_replans (
        replan_id, route_id, task_id, original_run_id, trigger, trigger_details,
        original_node_id, original_project_id, new_node_id, new_project_id, status,
        outcome_unknown_reason, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (replan_id) DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at
      `,
      [
        record.replanId,
        record.routeId,
        record.taskId,
        record.originalRunId,
        record.trigger,
        record.triggerDetails,
        record.originalCandidate.nodeId,
        record.originalCandidate.projectId,
        record.newCandidate?.nodeId ?? null,
        record.newCandidate?.projectId ?? null,
        record.status,
        record.outcomeUnknownReason ?? null,
        record.createdAt,
        record.updatedAt,
      ]
    ); });
  }

  async getRouteReplan(replanId: string): Promise<any | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_route_replans WHERE replan_id = $1`,
      [replanId]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async listRouteReplans(taskId: string): Promise<any[]> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_route_replans WHERE task_id = $1 ORDER BY created_at ASC`,
      [taskId]
    );
    return res.rows;
  }

  // --- Phase 4 Postgres Methods ---

  async saveGraph(graph: DistributedGraphRecord): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_graphs (
        graph_id, parent_goal, status, revision, planner_session_id,
        budget, concurrency_policy, final_summary, error, created_at, updated_at, completed_at, strategy_decision
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (graph_id) DO UPDATE SET
        status = EXCLUDED.status,
        revision = EXCLUDED.revision,
        budget = EXCLUDED.budget,
        concurrency_policy = EXCLUDED.concurrency_policy,
        strategy_decision = EXCLUDED.strategy_decision,
        final_summary = EXCLUDED.final_summary,
        error = EXCLUDED.error,
        updated_at = EXCLUDED.updated_at,
        completed_at = EXCLUDED.completed_at
      `,
      [
        graph.graphId,
        graph.parentGoal,
        graph.status,
        graph.revision,
        graph.plannerSessionId ?? null,
        JSON.stringify(graph.budget ?? {}),
        JSON.stringify(graph.concurrencyPolicy ?? {}),
        graph.finalSummary ?? null,
        graph.error ?? null,
        graph.createdAt,
        Date.now(),
        graph.completedAt ?? null,
        JSON.stringify(graph.strategyDecision ?? null),
      ]
    );
  }

  async getGraph(graphId: string): Promise<DistributedGraphRecord | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_graphs WHERE graph_id = $1`,
      [graphId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      graphId: r.graph_id,
      parentGoal: r.parent_goal,
      status: r.status,
      revision: Number(r.revision),
      plannerSessionId: r.planner_session_id ?? undefined,
      strategyDecision: r.strategy_decision ?? undefined,
      budget: typeof r.budget === "object" ? r.budget : JSON.parse(r.budget || "{}"),
      concurrencyPolicy: typeof r.concurrency_policy === "object" ? r.concurrency_policy : JSON.parse(r.concurrency_policy || "{}"),
      finalSummary: r.final_summary ?? undefined,
      error: r.error ?? undefined,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      completedAt: r.completed_at ? Number(r.completed_at) : undefined,
    };
  }

  async listGraphs(filter?: { status?: GraphStatus; limit?: number }): Promise<DistributedGraphRecord[]> {
    let sql = `SELECT * FROM cluster_graphs WHERE 1=1`;
    const params: any[] = [];
    if (filter?.status) {
      params.push(filter.status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ` ORDER BY updated_at DESC`;
    if (filter?.limit && filter.limit > 0) {
      params.push(filter.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const res = await this.db.query<any>(sql, params);
    return res.rows.map((r) => ({
      graphId: r.graph_id,
      parentGoal: r.parent_goal,
      status: r.status,
      revision: Number(r.revision),
      plannerSessionId: r.planner_session_id ?? undefined,
      strategyDecision: r.strategy_decision ?? undefined,
      budget: typeof r.budget === "object" ? r.budget : JSON.parse(r.budget || "{}"),
      concurrencyPolicy: typeof r.concurrency_policy === "object" ? r.concurrency_policy : JSON.parse(r.concurrency_policy || "{}"),
      finalSummary: r.final_summary ?? undefined,
      error: r.error ?? undefined,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      completedAt: r.completed_at ? Number(r.completed_at) : undefined,
    }));
  }

  async updateGraphStatus(
    graphId: string,
    status: GraphStatus,
    details?: { error?: string; finalSummary?: string; completedAt?: number }
  ): Promise<void> {
    const fields: string[] = ["status = $2", "updated_at = $3"];
    const params: any[] = [graphId, status, Date.now()];

    if (details?.error !== undefined) {
      params.push(details.error);
      fields.push(`error = $${params.length}`);
    }
    if (details?.finalSummary !== undefined) {
      params.push(details.finalSummary);
      fields.push(`final_summary = $${params.length}`);
    }
    if (details?.completedAt !== undefined) {
      params.push(details.completedAt);
      fields.push(`completed_at = $${params.length}`);
    }

    const sql = `UPDATE cluster_graphs SET ${fields.join(", ")} WHERE graph_id = $1`;
    await this.db.query(sql, params);
  }

  async transitionGraphStatus(graphId: string, expectedRevision: number, expectedStatus: GraphStatus, status: GraphStatus, details?: { error?: string; finalSummary?: string; completedAt?: number }, owner?: { goalRunId: string; fence: GoalTurnFence }): Promise<boolean> {
    const apply = async () => {
      const graph = await this.getGraph(graphId);
      if (!graph || graph.revision !== expectedRevision || graph.status !== expectedStatus) return false;
      if (owner) {
        const result = await this.db.query<{ payload: GoalRunRecord }>("SELECT payload FROM cluster_goal_runs WHERE goal_run_id=$1 FOR UPDATE", [owner.goalRunId]);
        const goal = result.rows[0]?.payload;
        if (!goal?.linkedGraphIds.includes(graphId)) throw new ClusterStorageError("Graph is not owned by the fenced GoalRun");
        assertGoalTurnFence(goal, owner.fence, await this.databaseTimeMs());
      }
      await this.updateGraphStatus(graphId, status, details);
      return true;
    };
    return this.withGraphLock(graphId, apply);
  }

  async saveGraphNode(node: DistributedGraphNodeRecord): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_graph_nodes (
        graph_id, node_id, task_id, title, goal, operation,
        assigned_node_id, assigned_project_id, required_capabilities,
        required_artifacts, produced_artifacts, acceptance_criteria,
        status, failure_policy, retry_policy, attempt_count,
        worker_run_id, result_summary, error, created_at, updated_at,
        started_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      ON CONFLICT (graph_id, node_id) DO UPDATE SET
        task_id = EXCLUDED.task_id,
        title = EXCLUDED.title,
        goal = EXCLUDED.goal,
        operation = EXCLUDED.operation,
        assigned_node_id = EXCLUDED.assigned_node_id,
        assigned_project_id = EXCLUDED.assigned_project_id,
        required_capabilities = EXCLUDED.required_capabilities,
        required_artifacts = EXCLUDED.required_artifacts,
        produced_artifacts = EXCLUDED.produced_artifacts,
        acceptance_criteria = EXCLUDED.acceptance_criteria,
        status = EXCLUDED.status,
        failure_policy = EXCLUDED.failure_policy,
        retry_policy = EXCLUDED.retry_policy,
        attempt_count = EXCLUDED.attempt_count,
        worker_run_id = EXCLUDED.worker_run_id,
        result_summary = EXCLUDED.result_summary,
        error = EXCLUDED.error,
        updated_at = EXCLUDED.updated_at,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at
      `,
      [
        node.graphId,
        node.nodeId,
        node.taskId ?? null,
        node.title,
        node.goal,
        node.operation,
        node.assignedNodeId ?? null,
        node.assignedProjectId ?? null,
        JSON.stringify(node.requiredCapabilities ?? []),
        JSON.stringify(node.requiredArtifacts ?? []),
        JSON.stringify(node.producedArtifacts ?? []),
        JSON.stringify(node.acceptanceCriteria ?? []),
        node.status,
        node.failurePolicy,
        JSON.stringify(node.retryPolicy ?? {}),
        node.attemptCount ?? 0,
        node.workerRunId ?? null,
        node.resultSummary ?? null,
        node.error ?? null,
        node.createdAt,
        Date.now(),
        node.startedAt ?? null,
        node.completedAt ?? null,
      ]
    );
  }

  async getGraphNode(graphId: string, nodeId: string): Promise<DistributedGraphNodeRecord | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_graph_nodes WHERE graph_id = $1 AND node_id = $2`,
      [graphId, nodeId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      graphId: r.graph_id,
      nodeId: r.node_id,
      taskId: r.task_id ?? undefined,
      title: r.title,
      goal: r.goal,
      operation: r.operation,
      assignedNodeId: r.assigned_node_id ?? undefined,
      assignedProjectId: r.assigned_project_id ?? undefined,
      requiredCapabilities: Array.isArray(r.required_capabilities) ? r.required_capabilities : [],
      requiredArtifacts: Array.isArray(r.required_artifacts) ? r.required_artifacts : [],
      producedArtifacts: Array.isArray(r.produced_artifacts) ? r.produced_artifacts : [],
      acceptanceCriteria: Array.isArray(r.acceptance_criteria) ? r.acceptance_criteria : [],
      status: r.status,
      failurePolicy: r.failure_policy,
      retryPolicy: typeof r.retry_policy === "object" ? r.retry_policy : {},
      attemptCount: Number(r.attempt_count),
      workerRunId: r.worker_run_id ?? undefined,
      resultSummary: r.result_summary ?? undefined,
      error: r.error ?? undefined,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      startedAt: r.started_at ? Number(r.started_at) : undefined,
      completedAt: r.completed_at ? Number(r.completed_at) : undefined,
    };
  }

  async listGraphNodes(graphId: string): Promise<DistributedGraphNodeRecord[]> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_graph_nodes WHERE graph_id = $1 ORDER BY created_at ASC`,
      [graphId]
    );
    return res.rows.map((r) => ({
      graphId: r.graph_id,
      nodeId: r.node_id,
      taskId: r.task_id ?? undefined,
      title: r.title,
      goal: r.goal,
      operation: r.operation,
      assignedNodeId: r.assigned_node_id ?? undefined,
      assignedProjectId: r.assigned_project_id ?? undefined,
      requiredCapabilities: Array.isArray(r.required_capabilities) ? r.required_capabilities : [],
      requiredArtifacts: Array.isArray(r.required_artifacts) ? r.required_artifacts : [],
      producedArtifacts: Array.isArray(r.produced_artifacts) ? r.produced_artifacts : [],
      acceptanceCriteria: Array.isArray(r.acceptance_criteria) ? r.acceptance_criteria : [],
      status: r.status,
      failurePolicy: r.failure_policy,
      retryPolicy: typeof r.retry_policy === "object" ? r.retry_policy : {},
      attemptCount: Number(r.attempt_count),
      workerRunId: r.worker_run_id ?? undefined,
      resultSummary: r.result_summary ?? undefined,
      error: r.error ?? undefined,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      startedAt: r.started_at ? Number(r.started_at) : undefined,
      completedAt: r.completed_at ? Number(r.completed_at) : undefined,
    }));
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
    const fields: string[] = ["status = $3", "updated_at = $4"];
    if (status === "completed") fields.push("error = NULL");
    const params: any[] = [graphId, nodeId, status, Date.now()];

    if (details?.taskId !== undefined) {
      params.push(details.taskId);
      fields.push(`task_id = $${params.length}`);
    }
    if (details?.workerRunId !== undefined) {
      params.push(details.workerRunId);
      fields.push(`worker_run_id = $${params.length}`);
    }
    if (details?.resultSummary !== undefined) {
      params.push(details.resultSummary);
      fields.push(`result_summary = $${params.length}`);
    }
    if (details?.error !== undefined) {
      params.push(details.error);
      fields.push(`error = $${params.length}`);
    }
    if (details?.attemptCount !== undefined) {
      params.push(details.attemptCount);
      fields.push(`attempt_count = $${params.length}`);
    }
    if (details?.startedAt !== undefined) {
      params.push(details.startedAt);
      fields.push(`started_at = $${params.length}`);
    }
    if (details?.completedAt !== undefined) {
      params.push(details.completedAt);
      fields.push(`completed_at = $${params.length}`);
    }
    if (details?.assignedNodeId !== undefined) {
      params.push(details.assignedNodeId);
      fields.push(`assigned_node_id = $${params.length}`);
    }
    if (details?.assignedProjectId !== undefined) {
      params.push(details.assignedProjectId);
      fields.push(`assigned_project_id = $${params.length}`);
    }

    const sql = `UPDATE cluster_graph_nodes SET ${fields.join(", ")} WHERE graph_id = $1 AND node_id = $2`;
    await this.db.query(sql, params);
  }

  async saveGraphEdges(edges: DistributedGraphEdgeRecord[]): Promise<void> {
    for (const e of edges) {
      await this.db.query(
        `
        INSERT INTO cluster_graph_edges (
          edge_id, graph_id, from_node_id, to_node_id, dependency_type,
          required_outcome, artifact_requirements, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (graph_id, from_node_id, to_node_id) DO UPDATE SET
          dependency_type = EXCLUDED.dependency_type,
          required_outcome = EXCLUDED.required_outcome,
          artifact_requirements = EXCLUDED.artifact_requirements
        `,
        [
          e.edgeId,
          e.graphId,
          e.fromNodeId,
          e.toNodeId,
          e.dependencyType,
          e.requiredOutcome,
          JSON.stringify(e.artifactRequirements ?? []),
          e.createdAt,
        ]
      );
    }
  }

  async deleteGraphEdges(
    graphId: string,
    edges: Array<{ fromNodeId: string; toNodeId: string }>
  ): Promise<void> {
    for (const e of edges) {
      await this.db.query(
        `DELETE FROM cluster_graph_edges WHERE graph_id = $1 AND from_node_id = $2 AND to_node_id = $3`,
        [graphId, e.fromNodeId, e.toNodeId]
      );
    }
  }
  async updateGraphRevisionCAS(
    graphId: string,
    expectedRevision: number,
    newRevision: number,
    updates?: { status?: GraphStatus; error?: string; finalSummary?: string; completedAt?: number }
  ): Promise<boolean> {
    const fields: string[] = ["revision = $2", "updated_at = $3"];
    const params: any[] = [graphId, newRevision, Date.now(), expectedRevision];

    if (updates?.status !== undefined) {
      params.push(updates.status);
      fields.push(`status = $${params.length}`);
    }
    if (updates?.error !== undefined) {
      params.push(updates.error);
      fields.push(`error = $${params.length}`);
    }
    if (updates?.finalSummary !== undefined) {
      params.push(updates.finalSummary);
      fields.push(`final_summary = $${params.length}`);
    }
    if (updates?.completedAt !== undefined) {
      params.push(updates.completedAt);
      fields.push(`completed_at = $${params.length}`);
    }

    const sql = `UPDATE cluster_graphs SET ${fields.join(", ")} WHERE graph_id = $1 AND revision = $4`;
    const res = await this.db.query(sql, params);
    return (res.rowCount ?? 0) > 0;
  }

  async withGraphLock<T>(graphId: string, operation: () => Promise<T>): Promise<T> {
    return this.db.transaction(async () => {
      await this.db.query("SELECT graph_id FROM cluster_graphs WHERE graph_id = $1 FOR UPDATE", [graphId]);
      return operation();
    });
  }

  async applyGraphPatchAtomic(patch: AtomicGraphPatchSpec): Promise<GraphPatchApplyResult> {
    return this.withGraphLock(patch.graphId, async () => {
      const trace = defaultTraceContext.get();
      if (trace?.goalTurnFence) {
        const result = await this.db.query<{ payload: GoalRunRecord }>("SELECT payload FROM cluster_goal_runs WHERE goal_run_id=$1 FOR UPDATE", [trace.goalRunId]);
        const row = result.rows[0];
        if (!row?.payload.linkedGraphIds.includes(patch.graphId)) throw new ClusterStorageError("Graph is not owned by the fenced GoalRun");
        assertGoalTurnFence(row.payload, trace.goalTurnFence, await this.databaseTimeMs());
      }
      const requestHash = crypto.createHash("sha256").update(JSON.stringify(patch)).digest("hex");
      if (patch.operationId) {
        const previous = await this.db.query("SELECT request_sha256, result FROM cluster_graph_patch_operations WHERE graph_id=$1 AND operation_id=$2", [patch.graphId, patch.operationId]);
        if (previous.rows[0]) {
          if (previous.rows[0].request_sha256 !== requestHash) throw new Error("Graph patch operation ID reused with different content");
          return { ...previous.rows[0].result, replayed: true };
        }
      }
      if (patch.nextRevision !== patch.expectedRevision + 1) throw new Error("Graph revision must increment exactly once");
      const currentGraph = await this.getGraph(patch.graphId);
      if (!currentGraph || ["cancelled", "cancelling", "completed", "outcome_unknown", "waiting_approval"].includes(currentGraph.status)) {
        return { success: false, graphId: patch.graphId, appliedRevision: currentGraph?.revision ?? -1, error: "Graph state does not permit a patch" };
      }
      for (const update of patch.updateNodes ?? []) {
        const rows = await this.db.query("SELECT status FROM cluster_graph_nodes WHERE graph_id=$1 AND node_id=$2 FOR UPDATE", [patch.graphId, update.nodeId]);
        if (!rows.rows[0] || (["completed", "running", "accepted", "dispatched", "waiting_approval", "outcome_unknown"].includes(rows.rows[0].status) && rows.rows[0].status !== update.status)) {
          return { success: false, graphId: patch.graphId, appliedRevision: currentGraph.revision, conflict: true, error: "Graph node state changed before patch commit" };
        }
      }
      // 1. CAS 锁定与校验版本
      const casSuccess = await this.updateGraphRevisionCAS(
        patch.graphId,
        patch.expectedRevision,
        patch.nextRevision,
        {
          status: patch.newGraphStatus,
          error: patch.graphError,
          finalSummary: patch.graphFinalSummary,
        }
      );

      if (!casSuccess) {
        const current = await this.getGraph(patch.graphId);
        return {
          success: false,
          graphId: patch.graphId,
          appliedRevision: current?.revision ?? -1,
          conflict: true,
          error: `Revision conflict: expected ${patch.expectedRevision}, current is ${current?.revision}`,
        };
      }

      // A committed replan invalidates any report based on the old revision.
      // Update the owner under the same transaction as the graph revision.
      const owners = await this.db.query<{ payload: GoalRunRecord }>(
        "SELECT payload FROM cluster_goal_runs WHERE payload->'linkedGraphIds' ? $1 FOR UPDATE", [patch.graphId]);

      // 2. 插入新节点
      for (const node of patch.addNodes ?? []) {
        await this.saveGraphNode(node);
      }

      // 3. 更新现有节点
      for (const upd of patch.updateNodes ?? []) {
        if (upd.record) { await this.saveGraphNode(upd.record); continue; }
        const fields: string[] = ["status = $3", "updated_at = $4"];
        const params: any[] = [patch.graphId, upd.nodeId, upd.status, Date.now()];
        if (upd.assignedNodeId !== undefined) {
          params.push(upd.assignedNodeId);
          fields.push(`assigned_node_id = $${params.length}`);
        }
        if (upd.assignedProjectId !== undefined) {
          params.push(upd.assignedProjectId);
          fields.push(`assigned_project_id = $${params.length}`);
        }
        if (upd.error !== undefined) {
          params.push(upd.error);
          fields.push(`error = $${params.length}`);
        }
        if (upd.resultSummary !== undefined) {
          params.push(upd.resultSummary);
          fields.push(`result_summary = $${params.length}`);
        }
        await this.db.query(
          `UPDATE cluster_graph_nodes SET ${fields.join(", ")} WHERE graph_id = $1 AND node_id = $2`,
          params
        );
      }

      // 4. 移除旧边
      if (patch.removeEdges && patch.removeEdges.length > 0) {
        await this.deleteGraphEdges(patch.graphId, patch.removeEdges);
      }

      // 5. 写入新边
      if (patch.addEdges && patch.addEdges.length > 0) {
        await this.saveGraphEdges(patch.addEdges);
      }

      if (owners.rows.length) {
        const graph = await this.getGraph(patch.graphId);
        if (!graph) throw new ClusterStorageError("Replanned graph disappeared");
        const nodes = await this.listGraphNodes(patch.graphId);
        const now = await this.databaseTimeMs();
        for (const row of owners.rows) {
          const goal = row.payload;
          // The new revision invalidates any prior verdict either way, but restarting delivery state
          // (status/report) belongs to the turn that owns the GoalRun; a background patch must not
          // erase a report another live turn has already delivered.
          if (!ownedByForeignLiveTurn(goal, now)) {
            goal.status = "running"; goal.executionState = "running"; goal.finalReport = undefined; goal.reportFingerprint = undefined; goal.reportState = "pending"; goal.completedAt = undefined;
          }
          recordGraphCoverage(goal, graph, nodes, "graph_replan", Date.now());
          goal.revision++; goal.updatedAt = Date.now();
          await this.db.query("UPDATE cluster_goal_runs SET revision=$1,payload=$2 WHERE goal_run_id=$3", [goal.revision, JSON.stringify(goal), goal.goalRunId]);
        }
      }

      // 6. 记录 revision 审计
      await this.recordGraphRevision({
        graphId: patch.graphId,
        revision: patch.nextRevision,
        reason: patch.reason,
        diffSummary: patch.diffSummary ?? {},
        createdAt: Date.now(),
      });

      // 7. 追加事件
      await this.appendGraphEvent(patch.graphId, "graph.replanned", {
        revision: patch.nextRevision,
        reason: patch.reason,
        diffSummary: patch.diffSummary ?? {},
      });

      const result = { success: true, graphId: patch.graphId, appliedRevision: patch.nextRevision };
      if (patch.operationId) await this.db.query(
        "INSERT INTO cluster_graph_patch_operations (graph_id,operation_id,request_sha256,result,created_at) VALUES ($1,$2,$3,$4,$5)",
        [patch.graphId, patch.operationId, requestHash, JSON.stringify(result), Date.now()]);
      return result;
    });
  }

  async listGraphEdges(graphId: string): Promise<DistributedGraphEdgeRecord[]> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_graph_edges WHERE graph_id = $1 ORDER BY created_at ASC`,
      [graphId]
    );
    return res.rows.map((r) => ({
      edgeId: r.edge_id,
      graphId: r.graph_id,
      fromNodeId: r.from_node_id,
      toNodeId: r.to_node_id,
      dependencyType: r.dependency_type,
      requiredOutcome: r.required_outcome,
      artifactRequirements: Array.isArray(r.artifact_requirements) ? r.artifact_requirements : [],
      createdAt: Number(r.created_at),
    }));
  }

  async recordGraphRevision(rev: GraphRevisionRecord): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_graph_revisions (graph_id, revision, reason, diff_summary, created_at)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [rev.graphId, rev.revision, rev.reason, JSON.stringify(rev.diffSummary ?? {}), rev.createdAt]
    );
  }

  async listGraphRevisions(graphId: string): Promise<GraphRevisionRecord[]> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_graph_revisions WHERE graph_id = $1 ORDER BY revision ASC`,
      [graphId]
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      graphId: r.graph_id,
      revision: Number(r.revision),
      reason: r.reason,
      diffSummary: typeof r.diff_summary === "object" ? r.diff_summary : {},
      createdAt: Number(r.created_at),
    }));
  }

  async appendGraphEvent(graphId: string, eventType: string, payload: Record<string, unknown>): Promise<number> {
    return this.withGraphLock(graphId, async () => {
    const countRes = await this.db.query<any>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM cluster_graph_events WHERE graph_id = $1`,
      [graphId]
    );
    const nextSeq = Number(countRes.rows[0]?.next_seq ?? 1);
    await this.db.query(
      `
      INSERT INTO cluster_graph_events (graph_id, seq, event_type, payload, created_at)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [graphId, nextSeq, eventType, JSON.stringify(payload ?? {}), Date.now()]
    );
    return nextSeq;
    });
  }

  async listGraphEvents(
    graphId: string,
    fromSeq = 0
  ): Promise<Array<{ seq: number; eventType: string; payload: any; createdAt: number }>> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_graph_events WHERE graph_id = $1 AND seq >= $2 ORDER BY seq ASC`,
      [graphId, fromSeq]
    );
    return res.rows.map((r) => ({
      seq: Number(r.seq),
      eventType: r.event_type,
      payload: r.payload,
      createdAt: Number(r.created_at),
    }));
  }

  async recordGraphVerification(v: GraphVerificationRecord): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_graph_verifications (
        graph_id, graph_node_id, verification_type, status, evidence, message, verified_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [v.graphId, v.graphNodeId, v.verificationType, v.status, JSON.stringify(v.evidence ?? {}), v.message ?? null, v.verifiedAt]
    );
  }

  async listGraphVerifications(graphId: string, graphNodeId?: string): Promise<GraphVerificationRecord[]> {
    let sql = `SELECT * FROM cluster_graph_verifications WHERE graph_id = $1`;
    const params: any[] = [graphId];
    if (graphNodeId) {
      params.push(graphNodeId);
      sql += ` AND graph_node_id = $2`;
    }
    sql += ` ORDER BY verified_at ASC`;
    const res = await this.db.query<any>(sql, params);
    return res.rows.map((r) => ({
      id: Number(r.id),
      graphId: r.graph_id,
      graphNodeId: r.graph_node_id,
      verificationType: r.verification_type,
      status: r.status,
      evidence: typeof r.evidence === "object" ? r.evidence : {},
      message: r.message ?? undefined,
      verifiedAt: Number(r.verified_at),
    }));
  }

  async saveAgentMessage(msg: any): Promise<void> {
    await this.fencedForegroundMutation(async () => { await this.db.query(
      `
      INSERT INTO cluster_agent_mailbox (
        message_id, graph_id, source_node_id, source_agent_id, source_task_id,
        target_node_id, target_agent_id, target_task_id, message_type,
        correlation_id, payload, delivery_status, sent_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (message_id) DO UPDATE SET
        delivery_status = EXCLUDED.delivery_status
      `,
      [
        msg.messageId,
        msg.graphId,
        msg.sourceNodeId,
        msg.sourceAgentId,
        msg.sourceTaskId ?? null,
        msg.targetNodeId,
        msg.targetAgentId,
        msg.targetTaskId ?? null,
        msg.messageType ?? "agent.message",
        msg.correlationId ?? null,
        JSON.stringify(msg.payload ?? {}),
        msg.deliveryStatus ?? "pending",
        msg.sentAt,
        msg.expiresAt,
      ]
    ); });
  }

  async getAgentMessage(messageId: string): Promise<any | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_agent_mailbox WHERE message_id = $1`,
      [messageId]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async pollPendingAgentMessages(targetNodeId: string, targetAgentId: string): Promise<any[]> {
    const now = Date.now();
    const res = await this.db.query<any>(
      `
      SELECT * FROM cluster_agent_mailbox
      WHERE target_node_id = $1 AND (target_agent_id = $2 OR target_agent_id = '*')
        AND delivery_status = 'pending' AND expires_at > $3
      ORDER BY sent_at ASC
      `,
      [targetNodeId, targetAgentId, now]
    );
    return res.rows;
  }

  async updateAgentMessageStatus(messageId: string, status: string, timestamp = Date.now()): Promise<void> {
    const fields = ["delivery_status = $2"];
    const params: any[] = [messageId, status];
    if (status === "delivered") {
      params.push(timestamp);
      fields.push(`delivered_at = $${params.length}`);
    }
    if (status === "acknowledged") {
      params.push(timestamp);
      fields.push(`acknowledged_at = $${params.length}`);
    }
    await this.db.query(
      `UPDATE cluster_agent_mailbox SET ${fields.join(", ")} WHERE message_id = $1`,
      params
    );
  }

  async saveArtifact(artifact: any): Promise<void> {
    await this.fencedForegroundMutation(async () => { await this.db.query(
      `
      INSERT INTO cluster_artifacts (
        artifact_id, graph_id, producer_task_id, producer_node_id, name,
        content_type, size_bytes, sha256, storage_path, status, metadata, created_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (artifact_id) DO UPDATE SET
        size_bytes = EXCLUDED.size_bytes,
        sha256 = EXCLUDED.sha256,
        storage_path = EXCLUDED.storage_path,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata
      `,
      [
        artifact.artifactId,
        artifact.graphId,
        artifact.producerTaskId ?? null,
        artifact.producerNodeId,
        artifact.name,
        artifact.contentType ?? "text/plain",
        artifact.sizeBytes ?? 0,
        artifact.sha256,
        artifact.storagePath,
        artifact.status ?? "pending",
        JSON.stringify(artifact.metadata ?? {}),
        artifact.createdAt,
        artifact.expiresAt ?? null,
      ]
    ); });
  }

  async getArtifact(artifactId: string): Promise<any | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_artifacts WHERE artifact_id = $1`,
      [artifactId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      artifactId: r.artifact_id,
      graphId: r.graph_id,
      producerTaskId: r.producer_task_id ?? undefined,
      producerNodeId: r.producer_node_id,
      name: r.name,
      contentType: r.content_type,
      sizeBytes: Number(r.size_bytes),
      sha256: r.sha256,
      storagePath: r.storage_path,
      status: r.status,
      metadata: typeof r.metadata === "object" ? r.metadata : {},
      createdAt: Number(r.created_at),
      expiresAt: r.expires_at ? Number(r.expires_at) : undefined,
    };
  }

  async listArtifacts(graphId?: string): Promise<any[]> {
    const mapRow = (r: any) => ({
      artifactId: r.artifact_id,
      graphId: r.graph_id,
      producerTaskId: r.producer_task_id ?? undefined,
      producerNodeId: r.producer_node_id,
      name: r.name,
      contentType: r.content_type,
      sizeBytes: Number(r.size_bytes),
      sha256: r.sha256,
      storagePath: r.storage_path,
      status: r.status,
      metadata: typeof r.metadata === "object" ? r.metadata : {},
      createdAt: Number(r.created_at),
      expiresAt: r.expires_at ? Number(r.expires_at) : undefined,
    });

    if (graphId) {
      const res = await this.db.query<any>(
        `SELECT * FROM cluster_artifacts WHERE graph_id = $1 ORDER BY created_at ASC`,
        [graphId]
      );
      return res.rows.map(mapRow);
    }
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_artifacts ORDER BY created_at DESC LIMIT 100`
    );
    return res.rows.map(mapRow);
  }

  async grantArtifactAccess(
    artifactId: string,
    graphId: string,
    consumerNodeId: string,
    consumerTaskId?: string
  ): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_artifact_grants (artifact_id, graph_id, consumer_node_id, consumer_task_id, granted_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (artifact_id, consumer_node_id, consumer_task_id) DO NOTHING
      `,
      [artifactId, graphId, consumerNodeId, consumerTaskId ?? "", Date.now()]
    );
  }

  async hasArtifactAccess(artifactId: string, consumerNodeId: string, consumerTaskId?: string): Promise<boolean> {
    const res = await this.db.query<any>(
      `
      SELECT 1 FROM cluster_artifact_grants
      WHERE artifact_id = $1 AND consumer_node_id = $2
        AND (consumer_task_id = $3 OR consumer_task_id = '' OR consumer_task_id IS NULL)
      `,
      [artifactId, consumerNodeId, consumerTaskId ?? ""]
    );
    return res.rows.length > 0;
  }

  async recordGraphControl(ctrl: any): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_graph_controls (control_id, graph_id, action, payload, status, issued_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [ctrl.controlId, ctrl.graphId, ctrl.action, JSON.stringify(ctrl.payload ?? {}), ctrl.status ?? "pending", ctrl.issuedAt]
    );
  }

  async getPendingGraphControls(graphId: string): Promise<any[]> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_graph_controls WHERE graph_id = $1 AND status = 'pending' ORDER BY issued_at ASC`,
      [graphId]
    );
    return res.rows;
  }

  async updateGraphControlStatus(controlId: string, status: string): Promise<void> {
    await this.db.query(
      `UPDATE cluster_graph_controls SET status = $1, executed_at = $2 WHERE control_id = $3`,
      [status, Date.now(), controlId]
    );
  }

  // Web Control Plane & Conversations (Phase 5)
  async saveConversation(conversation: WebConversationRecord): Promise<void> {
    const input = conversation;
    await this.db.transaction(async () => {
    await this.db.query("SELECT id FROM cluster_web_conversations WHERE id = $1 FOR UPDATE", [conversation.id]);
    conversation = this.conversationSnapshots.merge(input, await this.getConversation(conversation.id));
    await this.db.query(
      `
      INSERT INTO cluster_web_conversations (
        id, title, linked_task_ids, linked_graph_ids, messages, created_at, updated_at, title_source, title_revision
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        linked_task_ids = EXCLUDED.linked_task_ids,
        linked_graph_ids = EXCLUDED.linked_graph_ids,
        messages = EXCLUDED.messages,
        updated_at = EXCLUDED.updated_at,
        title_source = EXCLUDED.title_source,
        title_revision = EXCLUDED.title_revision
      `,
      [
        conversation.id,
        conversation.title,
        JSON.stringify(conversation.linkedTaskIds ?? []),
        JSON.stringify(conversation.linkedGraphIds ?? []),
        JSON.stringify(conversation.messages ?? []),
        conversation.createdAt,
        conversation.updatedAt,
        conversation.titleSource ?? "default",
        conversation.titleRevision ?? 0,
      ]
    );
    });
    this.conversationSnapshots.remember(input);
  }

  async getConversation(id: string): Promise<WebConversationRecord | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_web_conversations WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return this.conversationSnapshots.read({
      id: r.id,
      title: r.title,
      titleSource: r.title_source || "default",
      titleRevision: Number(r.title_revision || 0),
      linkedTaskIds: Array.isArray(r.linked_task_ids) ? r.linked_task_ids : [],
      linkedGraphIds: Array.isArray(r.linked_graph_ids) ? r.linked_graph_ids : [],
      messages: Array.isArray(r.messages) ? r.messages : [],
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    });
  }

  async listConversations(limit = 50): Promise<WebConversationRecord[]> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_web_conversations ORDER BY updated_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) => ({
      id: r.id,
      title: r.title,
      titleSource: r.title_source || "default",
      titleRevision: Number(r.title_revision || 0),
      linkedTaskIds: Array.isArray(r.linked_task_ids) ? r.linked_task_ids : [],
      linkedGraphIds: Array.isArray(r.linked_graph_ids) ? r.linked_graph_ids : [],
      messages: Array.isArray(r.messages) ? r.messages : [],
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }

  async deleteConversation(id: string): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM cluster_web_conversations WHERE id = $1`,
      [id]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async appendConversationMessage(conversationId: string, message: WebMessageRecord): Promise<void> {
    await this.db.query(`UPDATE cluster_web_conversations SET messages = COALESCE(messages, '[]'::jsonb) || $2::jsonb, updated_at = GREATEST(updated_at, $3) WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(messages, '[]'::jsonb)) item WHERE item->>'id' = $4)`, [conversationId, JSON.stringify([message]), message.timestamp, message.id]);
  }

  async saveWebSession(session: WebSessionRecord): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_web_sessions (
        session_id, user_id, username, role, csrf_token, created_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (session_id) DO UPDATE SET
        role = EXCLUDED.role,
        csrf_token = EXCLUDED.csrf_token,
        expires_at = EXCLUDED.expires_at
      `,
      [
        session.sessionId,
        session.userId,
        session.username,
        session.role,
        session.csrfToken,
        session.createdAt,
        session.expiresAt,
      ]
    );
  }

  async getWebSession(sessionId: string): Promise<WebSessionRecord | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_web_sessions WHERE session_id = $1 AND expires_at > $2`,
      [sessionId, Date.now()]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      sessionId: r.session_id,
      userId: r.user_id,
      username: r.username,
      role: r.role,
      csrfToken: r.csrf_token,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
    };
  }

  async deleteWebSession(sessionId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM cluster_web_sessions WHERE session_id = $1`,
      [sessionId]
    );
  }

  async cleanExpiredWebSessions(): Promise<number> {
    const res = await this.db.query(
      `DELETE FROM cluster_web_sessions WHERE expires_at < $1`,
      [Date.now()]
    );
    return res.rowCount ?? 0;
  }

  // Scheduled Tasks (Phase 5)
  async saveScheduledTask(task: ScheduledTaskRecord): Promise<void> {
    await this.fencedForegroundMutation(async () => { await this.db.query(
      `
      INSERT INTO cluster_scheduled_tasks (
        id, name, description, enabled, trigger_type, cron_expression, interval_ms,
        run_at, timezone, target_type, task_config, graph_config, concurrency_policy,
        misfire_policy, max_concurrency, last_run_at, last_run_status, next_run_at,
        run_count, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        enabled = EXCLUDED.enabled,
        trigger_type = EXCLUDED.trigger_type,
        cron_expression = EXCLUDED.cron_expression,
        interval_ms = EXCLUDED.interval_ms,
        run_at = EXCLUDED.run_at,
        timezone = EXCLUDED.timezone,
        target_type = EXCLUDED.target_type,
        task_config = EXCLUDED.task_config,
        graph_config = EXCLUDED.graph_config,
        concurrency_policy = EXCLUDED.concurrency_policy,
        misfire_policy = EXCLUDED.misfire_policy,
        max_concurrency = EXCLUDED.max_concurrency,
        last_run_at = EXCLUDED.last_run_at,
        last_run_status = EXCLUDED.last_run_status,
        next_run_at = EXCLUDED.next_run_at,
        run_count = EXCLUDED.run_count,
        updated_at = EXCLUDED.updated_at
      `,
      [
        task.id,
        task.name,
        task.description,
        task.enabled,
        task.triggerType,
        task.cronExpression ?? null,
        task.intervalMs ?? null,
        task.runAt ?? null,
        task.timezone ?? "UTC",
        task.targetType,
        JSON.stringify(task.taskConfig ?? {}),
        JSON.stringify(task.graphConfig ?? {}),
        task.concurrencyPolicy,
        task.misfirePolicy,
        task.maxConcurrency,
        task.lastRunAt ?? null,
        task.lastRunStatus ?? null,
        task.nextRunAt ?? null,
        task.runCount,
        task.createdBy,
        task.createdAt,
        task.updatedAt,
      ]
    ); });
  }

  async getScheduledTask(id: string): Promise<ScheduledTaskRecord | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_scheduled_tasks WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return decodeScheduledTask(r);
  }

  async listScheduledTasks(filter?: { enabled?: boolean; targetType?: ScheduledTargetType; limit?: number; offset?: number }): Promise<ScheduledTaskRecord[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filter?.enabled !== undefined) {
      conditions.push(`enabled = $${idx++}`);
      params.push(filter.enabled);
    }
    if (filter?.targetType) {
      conditions.push(`target_type = $${idx++}`);
      params.push(filter.targetType);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = filter?.offset ? `OFFSET ${filter.offset}` : "";
    const limit = filter?.limit ? `LIMIT ${filter.limit}` : "LIMIT 100";

    const res = await this.db.query<any>(
      `SELECT * FROM cluster_scheduled_tasks ${where} ORDER BY updated_at DESC ${limit} ${offset}`,
      params
    );

    return res.rows.map(decodeScheduledTask);
  }

  async updateScheduledTask(id: string, patch: Partial<ScheduledTaskRecord>): Promise<ScheduledTaskRecord | null> {
    return this.fencedForegroundMutation(async () => {
    const existing = await this.getScheduledTask(id);
    if (!existing) return null;
    const updated: ScheduledTaskRecord = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    };
    await this.saveScheduledTask(updated);
    return updated;
    });
  }

  async deleteScheduledTask(id: string): Promise<boolean> {
    return this.fencedForegroundMutation(async () => {
      const res = await this.db.query(`DELETE FROM cluster_scheduled_tasks WHERE id = $1`, [id]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  async saveScheduledTaskRun(run: ScheduledTaskRunRecord): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_scheduled_task_runs (
        id, scheduled_task_id, target_type, task_id, graph_id, trigger_time,
        started_at, completed_at, status, skip_reason, error, result_summary,
        metrics, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (id) DO UPDATE SET
        task_id = EXCLUDED.task_id,
        graph_id = EXCLUDED.graph_id,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at,
        status = EXCLUDED.status,
        skip_reason = EXCLUDED.skip_reason,
        error = EXCLUDED.error,
        result_summary = EXCLUDED.result_summary,
        metrics = EXCLUDED.metrics
      `,
      [
        run.id,
        run.scheduledTaskId,
        run.targetType,
        run.taskId ?? null,
        run.graphId ?? null,
        run.triggerTime,
        run.startedAt,
        run.completedAt ?? null,
        run.status,
        run.skipReason ?? null,
        run.error ?? null,
        run.resultSummary ?? null,
        JSON.stringify(run.metrics ?? {}),
        run.createdAt,
      ]
    );
  }

  async getScheduledTaskRun(runId: string): Promise<ScheduledTaskRunRecord | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_scheduled_task_runs WHERE id = $1`,
      [runId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return decodeScheduledRun(r);
  }

  async listScheduledTaskRuns(scheduledTaskId?: string, filter?: { status?: ScheduledTaskRunStatus; limit?: number; offset?: number }): Promise<ScheduledTaskRunRecord[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (scheduledTaskId) {
      conditions.push(`scheduled_task_id = $${idx++}`);
      params.push(scheduledTaskId);
    }
    if (filter?.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filter.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = filter?.offset ? `OFFSET ${filter.offset}` : "";
    const limit = filter?.limit ? `LIMIT ${filter.limit}` : "LIMIT 50";

    const res = await this.db.query<any>(
      `SELECT * FROM cluster_scheduled_task_runs ${where} ORDER BY created_at DESC ${limit} ${offset}`,
      params
    );

    return res.rows.map(decodeScheduledRun);
  }

  async updateScheduledTaskRun(runId: string, patch: Partial<ScheduledTaskRunRecord>): Promise<void> {
    const existing = await this.getScheduledTaskRun(runId);
    if (!existing) return;
    const updated: ScheduledTaskRunRecord = { ...existing, ...patch };
    await this.saveScheduledTaskRun(updated);
  }

  // Security Decision Audit (Phase 5)
  async saveSecurityAudit(record: SecurityAuditRecord): Promise<void> {
    await this.db.query(
      `
      INSERT INTO cluster_security_audits (
        id, timestamp, tool_name, args_fingerprint, sanitized_args, raw_args_snippet,
        decision_source, verdict, severity, risk_category, rule_name, reason,
        decision_evidence, agent_id, node_id, project_id, task_id, run_id,
        duration_ms, is_hard_block, tokens_used, model_version, review_feedback, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      ON CONFLICT (id) DO UPDATE SET
        review_feedback = EXCLUDED.review_feedback
      `,
      [
        record.id,
        record.timestamp,
        record.toolName,
        record.argsFingerprint,
        JSON.stringify(record.sanitizedArgs ?? {}),
        record.rawArgsSnippet,
        record.decisionSource,
        record.verdict,
        record.severity,
        record.riskCategory,
        record.ruleName ?? null,
        record.reason,
        record.decisionEvidence ?? null,
        record.agentId,
        record.nodeId ?? null,
        record.projectId ?? null,
        record.taskId ?? null,
        record.runId ?? null,
        record.durationMs,
        record.isHardBlock,
        JSON.stringify(record.tokensUsed ?? {}),
        record.modelVersion ?? null,
        JSON.stringify(record.reviewFeedback ?? {}),
        record.createdAt,
      ]
    );
  }

  async getSecurityAudit(id: string): Promise<SecurityAuditRecord | null> {
    const res = await this.db.query<any>(
      `SELECT * FROM cluster_security_audits WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      timestamp: Number(r.timestamp),
      toolName: r.tool_name,
      argsFingerprint: r.args_fingerprint,
      sanitizedArgs: typeof r.sanitized_args === "object" ? r.sanitized_args : {},
      rawArgsSnippet: r.raw_args_snippet,
      decisionSource: r.decision_source,
      verdict: r.verdict,
      severity: Number(r.severity),
      riskCategory: r.risk_category,
      ruleName: r.rule_name ?? undefined,
      reason: r.reason,
      decisionEvidence: r.decision_evidence ?? undefined,
      agentId: r.agent_id,
      nodeId: r.node_id ?? undefined,
      projectId: r.project_id ?? undefined,
      taskId: r.task_id ?? undefined,
      runId: r.run_id ?? undefined,
      durationMs: Number(r.duration_ms),
      isHardBlock: Boolean(r.is_hard_block),
      tokensUsed: typeof r.tokens_used === "object" ? r.tokens_used : undefined,
      modelVersion: r.model_version ?? undefined,
      reviewFeedback: typeof r.review_feedback === "object" ? r.review_feedback : { status: "unreviewed" },
      createdAt: Number(r.created_at),
    };
  }

  async listSecurityAudits(filter?: SecurityAuditFilter): Promise<{ items: SecurityAuditRecord[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (filter?.verdict) {
      conditions.push(`verdict = $${idx++}`);
      params.push(filter.verdict);
    }
    if (filter?.decisionSource) {
      conditions.push(`decision_source = $${idx++}`);
      params.push(filter.decisionSource);
    }
    if (filter?.riskCategory) {
      conditions.push(`risk_category ILIKE $${idx++}`);
      params.push(`%${filter.riskCategory}%`);
    }
    if (filter?.reviewStatus) {
      conditions.push(`review_feedback->>'status' = $${idx++}`);
      params.push(filter.reviewStatus);
    }
    if (filter?.taskId) {
      conditions.push(`task_id = $${idx++}`);
      params.push(filter.taskId);
    }
    if (filter?.nodeId) {
      conditions.push(`node_id = $${idx++}`);
      params.push(filter.nodeId);
    }
    if (filter?.fromTimestamp) {
      conditions.push(`timestamp >= $${idx++}`);
      params.push(filter.fromTimestamp);
    }
    if (filter?.toTimestamp) {
      conditions.push(`timestamp <= $${idx++}`);
      params.push(filter.toTimestamp);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const countRes = await this.db.query<any>(
      `SELECT COUNT(*) AS cnt FROM cluster_security_audits ${where}`,
      params
    );
    const total = Number(countRes.rows[0]?.cnt ?? 0);

    const offset = filter?.offset ? `OFFSET ${filter.offset}` : "";
    const limit = filter?.limit ? `LIMIT ${filter.limit}` : "LIMIT 50";

    const res = await this.db.query<any>(
      `SELECT * FROM cluster_security_audits ${where} ORDER BY timestamp DESC ${limit} ${offset}`,
      params
    );

    const items: SecurityAuditRecord[] = res.rows.map((r) => ({
      id: r.id,
      timestamp: Number(r.timestamp),
      toolName: r.tool_name,
      argsFingerprint: r.args_fingerprint,
      sanitizedArgs: typeof r.sanitized_args === "object" ? r.sanitized_args : {},
      rawArgsSnippet: r.raw_args_snippet,
      decisionSource: r.decision_source,
      verdict: r.verdict,
      severity: Number(r.severity),
      riskCategory: r.risk_category,
      ruleName: r.rule_name ?? undefined,
      reason: r.reason,
      decisionEvidence: r.decision_evidence ?? undefined,
      agentId: r.agent_id,
      nodeId: r.node_id ?? undefined,
      projectId: r.project_id ?? undefined,
      taskId: r.task_id ?? undefined,
      runId: r.run_id ?? undefined,
      durationMs: Number(r.duration_ms),
      isHardBlock: Boolean(r.is_hard_block),
      tokensUsed: typeof r.tokens_used === "object" ? r.tokens_used : undefined,
      modelVersion: r.model_version ?? undefined,
      reviewFeedback: typeof r.review_feedback === "object" ? r.review_feedback : { status: "unreviewed" },
      createdAt: Number(r.created_at),
    }));

    return { items, total };
  }

  async updateSecurityAuditFeedback(id: string, feedback: SecurityAuditFeedback): Promise<SecurityAuditRecord | null> {
    const existing = await this.getSecurityAudit(id);
    if (!existing) return null;
    const mergedFeedback = {
      ...existing.reviewFeedback,
      ...feedback,
      reviewedAt: feedback.reviewedAt ?? Date.now(),
    };
    await this.db.query(
      `UPDATE cluster_security_audits SET review_feedback = $1 WHERE id = $2`,
      [JSON.stringify(mergedFeedback), id]
    );
    return { ...existing, reviewFeedback: mergedFeedback };
  }

  async getSecurityAuditStats(windowMs?: number): Promise<SecurityAuditStats> {
    let where = "";
    const params: any[] = [];
    if (windowMs && windowMs > 0) {
      where = "WHERE timestamp >= $1";
      params.push(Date.now() - windowMs);
    }

    const res = await this.db.query<any>(
      `
      SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN verdict = 'ALLOW' THEN 1 END) AS allow_count,
        COUNT(CASE WHEN verdict = 'BLOCK' THEN 1 END) AS block_count,
        COUNT(CASE WHEN verdict = 'REQUIRE_APPROVAL' THEN 1 END) AS require_approval_count,
        COUNT(CASE WHEN decision_source = 'LLM_MONITOR' THEN 1 END) AS src_llm,
        COUNT(CASE WHEN decision_source = 'DETERMINISTIC_POLICY' THEN 1 END) AS src_det,
        COUNT(CASE WHEN decision_source = 'USER_APPROVAL' THEN 1 END) AS src_usr,
        COUNT(CASE WHEN decision_source = 'SYSTEM_FAILURE' THEN 1 END) AS src_sys,
        COUNT(CASE WHEN review_feedback->>'status' = 'false_positive' THEN 1 END) AS fp_count
      FROM cluster_security_audits ${where}
      `,
      params
    );

    const catRes = await this.db.query<any>(
      `
      SELECT risk_category, COUNT(*) AS cnt
      FROM cluster_security_audits ${where}
      GROUP BY risk_category
      ORDER BY cnt DESC
      LIMIT 10
      `,
      params
    );

    const row = res.rows[0] ?? {};
    return {
      totalCount: Number(row.total ?? 0),
      allowCount: Number(row.allow_count ?? 0),
      blockCount: Number(row.block_count ?? 0),
      requireApprovalCount: Number(row.require_approval_count ?? 0),
      sourceCounts: {
        LLM_MONITOR: Number(row.src_llm ?? 0),
        DETERMINISTIC_POLICY: Number(row.src_det ?? 0),
        USER_APPROVAL: Number(row.src_usr ?? 0),
        SYSTEM_FAILURE: Number(row.src_sys ?? 0),
      },
      falsePositiveCount: Number(row.fp_count ?? 0),
      topRiskCategories: catRes.rows.map((r: any) => ({
        category: r.risk_category || "Routine Operation",
        count: Number(r.cnt ?? 0),
      })),
    };
  }
}
