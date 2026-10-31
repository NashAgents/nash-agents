import { observeRuntimePhase } from "../../observability/runtime-phase.js";
import type { RuntimeSpan } from "../../observability/runtime-phase.js";
import type { ModelUsageRecord } from "../../observability/model-usage.js";
import { runtimeRelease } from "../../runtime/release-info.js";
import { validateMessageMembership } from "../a2a/distributed-mailbox.js";
import { applyWorkerApprovalExpiry } from "./approval-expiry.js";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import * as crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { IClusterStore } from "../storage/cluster-store.js";
import { canTransitionTask, CLUSTER_TASK_TERMINAL } from "../storage/cluster-store.js";
import type { TaskScheduler } from "./task-scheduler.js";
import { TaskSecurityGrantService } from "./task-security-grant-service.js";
import type { ProductStore } from "../../product/store.js";
import type { NodeRegistry } from "./node-registry.js";
import type { CoordinatorCatalogService } from "./catalog/coordinator-catalog-service.js";
import type { DistributedGraphOrchestrator } from "../graph/graph-orchestrator.js";
import type { DistributedMailbox } from "../a2a/distributed-mailbox.js";
import type { EventBus } from "../../observability/event-bus.js";
import type { AutonomousDiscoveryService } from "../discovery/autonomous-discovery-service.js";
import type { DiscoveryReport } from "../discovery/types.js";
import {
  decodeEnvelope,
  encodeEnvelope,
  createEnvelope,
  approvalResolutionMessageId,
  ProtocolError,
} from "../protocol/message-codec.js";
import type {
  ClusterEnvelope,
  NodeHelloPayload,
  NodeAuthenticatedPayload,
  NodeRejectedPayload,
  HeartbeatPayload,
  HeartbeatAckPayload,
  TaskAcceptedPayload,
  TaskRejectedPayload,
  TaskStartedPayload,
  TaskProgressPayload,
  TaskCompletedPayload,
  TaskFailedPayload,
  TaskCancelledPayload,
  EventBatchPayload,
  EventAckPayload,
  RemoteApprovalRequestPayload,
  RemoteApprovalExpiredPayload,
  TaskGrantSecurityAckPayload,
  TaskRevokeSecurityAckPayload,
  CatalogSyncSnapshotPayload,
  CatalogSyncDeltaPayload,
  RemoteMemorySearchResponsePayload,
  NodeDrainProbePayload,
  NodeDrainStatusPayload,
} from "../protocol/types.js";

export interface WssGatewayOptions {
  server: HttpServer | HttpsServer;
  path?: string;
  store: IClusterStore;
  registry: NodeRegistry;
  coordinatorNodeId: string;
  catalogService?: CoordinatorCatalogService;
  graphOrchestrator?: DistributedGraphOrchestrator;
  mailbox?: DistributedMailbox;
  scheduler?: TaskScheduler;
  eventBus?: EventBus;
  discoveryService?: AutonomousDiscoveryService;
  productStore?: ProductStore;
}

export class WssGateway {
  private readonly eventWatermarks = new Map<string, number>();
  private readonly authenticated = new WeakMap<WebSocket, { nodeId: string; generation: number }>();
  private readonly wss: WebSocketServer;
  private readonly scheduler?: TaskScheduler;
  private readonly taskSecurityGrants?: TaskSecurityGrantService;
  private readonly store: IClusterStore;
  private readonly registry: NodeRegistry;
  private readonly coordinatorNodeId: string;
  private readonly catalogService?: CoordinatorCatalogService;
  private readonly graphOrchestrator?: DistributedGraphOrchestrator;
  private readonly mailbox?: DistributedMailbox;
  private readonly eventBus?: EventBus;
  private readonly discoveryService?: AutonomousDiscoveryService;
  /** 未完成的排空探针：probeId -> 等待器。超时由调用方清理，避免无限悬挂。 */
  private readonly drainProbes = new Map<string, {
    nodeId: string;
    probeId: string;
    resolve: (status: NodeDrainStatusPayload) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(options: WssGatewayOptions) {
    this.store = options.store;
    this.scheduler = options.scheduler;
    this.taskSecurityGrants = options.scheduler ? new TaskSecurityGrantService({
      store: options.store,
      scheduler: options.scheduler,
      registry: options.registry,
      productStore: options.productStore,
      emit: (type, data) => this.emitBusEvent(type, data),
      onTaskResumed: async (taskId) => { await options.graphOrchestrator?.syncTaskActivity?.(taskId); },
    }) : undefined;
    this.registry = options.registry;
    this.coordinatorNodeId = options.coordinatorNodeId;
    this.catalogService = options.catalogService;
    this.graphOrchestrator = options.graphOrchestrator;
    this.mailbox = options.mailbox;
    this.eventBus = options.eventBus;
    this.discoveryService = options.discoveryService;

    this.wss = new WebSocketServer({
      server: options.server,
      path: options.path ?? "/ws/cluster",
      maxPayload: 1024 * 1024, // 1MB 硬限制
    });
    this.wss.on("error", (error: NodeJS.ErrnoException) => {
      // The owning HTTP server rejects startup; never throw before its listener can observe the error.
      console.warn(`[WssGateway] Transport unavailable: ${error.code ?? "WEBSOCKET_ERROR"}`);
    });

    this.init();
  }

  private init(): void {
    this.wss.on("connection", (ws: WebSocket, req) => {
      const remoteIp = req.socket.remoteAddress;
      let authenticatedNodeId: string | null = null;
      let generation = 0;

      let processing = Promise.resolve();
      const reportError = (err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errCode = err instanceof ProtocolError ? err.code : "INVALID_MESSAGE";
        try {
          ws.send(encodeEnvelope(createEnvelope("error", { code: errCode, message: errMsg }, this.coordinatorNodeId, authenticatedNodeId ?? "unknown")));
        } catch {}
      };
      const processEnvelope = async (envelope: ClusterEnvelope) => {
        try {
          await this.handleEnvelope(envelope, ws, remoteIp, (nodeId, gen) => {
            this.authenticated.set(ws, { nodeId, generation: gen });
            authenticatedNodeId = nodeId;
            generation = gen;
          });
        } catch (err) { reportError(err); }
      };
      ws.on("message", (data) => {
        let envelope: ClusterEnvelope;
        try { envelope = decodeEnvelope(data as any); }
        catch (err) { reportError(err); return; }
        // Liveness must not queue behind durable event ingestion; identity checks still run in handleEnvelope.
        if (this.authenticated.has(ws) && envelope.type === "node.heartbeat") void processEnvelope(envelope);
        else processing = processing.then(() => processEnvelope(envelope));
      });

      ws.on("close", () => {
        if (authenticatedNodeId) {
          void this.registry.handleDisconnect(authenticatedNodeId, generation).catch(() => {
            console.warn("[WssGateway] Disconnect persistence failed; connection remains unavailable for dispatch.");
          });
        }
      });

      ws.on("error", (err) => {
        console.warn(`[WssGateway] WebSocket error from ${remoteIp}:`, err);
      });
    });
  }

  /**
   * 向指定节点发起排空探针，返回其进程内的真实执行态。
   * 无连接、发送失败或超时均返回 null —— 调用方必须把 null 当作「无法证明已排空」。
   */
  async probeDrainStatus(nodeId: string, timeoutMs = 5000): Promise<NodeDrainStatusPayload | null> {
    const conn = this.registry.getConnection(nodeId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return null;

    const probeId = crypto.randomUUID();
    const payload: NodeDrainProbePayload = { probeId, requestedAt: Date.now() };
    return await new Promise<NodeDrainStatusPayload | null>((resolve) => {
      const timer = setTimeout(() => {
        this.drainProbes.delete(probeId);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.drainProbes.set(probeId, { nodeId, probeId, resolve, timer });
      try {
        conn.ws.send(encodeEnvelope(createEnvelope("node.drain_probe", payload, this.coordinatorNodeId, nodeId)));
      } catch {
        clearTimeout(timer);
        this.drainProbes.delete(probeId);
        resolve(null);
      }
    });
  }

  private async handleEnvelope(
    envelope: ClusterEnvelope,
    ws: WebSocket,
    remoteIp: string | undefined,
    onAuthSuccess: (nodeId: string, gen: number) => void
  ): Promise<void> {
    const { type, payload, sourceNodeId, messageId } = envelope;

    const identity = this.authenticated.get(ws);
    if (type !== "node.hello") {
      const connection = identity && this.registry.getConnection(identity.nodeId);
      if (!identity || !connection || connection.ws !== ws || connection.generation !== identity.generation || sourceNodeId !== identity.nodeId) {
        throw new ProtocolError("Authenticated current-generation connection required", "UNAUTHENTICATED");
      }
      const p = payload as Record<string, any>;
      if (type.startsWith("catalog.sync_")) {
        for (const field of ["projects", "skills", "mcp", "memoryIndex", "projectsUpsert", "skillsUpsert", "mcpUpsert", "memoryIndexUpsert"]) {
          if (p[field] && (!Array.isArray(p[field]) || p[field].some((item: any) => item.nodeId !== identity.nodeId))) {
            throw new ProtocolError("Catalog item owner mismatch", "NODE_MISMATCH");
          }
        }
      }
      if (p.nodeId && p.nodeId !== identity.nodeId) throw new ProtocolError("Payload node mismatch", "NODE_MISMATCH");
      if (type.startsWith("task.") || type === "event.batch" || type.startsWith("approval.")) {
        const task = await this.store.getTask(p.taskId);
        if (!task || task.nodeId !== identity.nodeId || (task.runId && type !== "task.control_ack" && task.runId !== p.runId)) {
          throw new ProtocolError("Task owner or run mismatch", "TASK_MISMATCH");
        }
        if (type === "event.batch" && (!Array.isArray(p.events) || p.events.some((e: any) =>
          e.taskId !== p.taskId || e.runId !== p.runId || e.nodeId !== identity.nodeId || !Number.isSafeInteger(e.seq) || e.seq < 1))) {
          throw new ProtocolError("Invalid event batch", "INVALID_EVENTS");
        }
        const next = ({ "task.accepted": "accepted", "task.started": "running", "task.progress": "running",
          "task.completed": "completed", "task.failed": "failed", "task.cancelled": "cancelled", "task.rejected": "failed" } as const)[type as "task.completed"];
        if (next && (!canTransitionTask(task.status, next) || CLUSTER_TASK_TERMINAL.has(task.status))) {
          if (CLUSTER_TASK_TERMINAL.has(task.status) && ["task.completed", "task.failed", "task.cancelled", "task.rejected"].includes(type)) this.acknowledgeResult(ws, p.taskId, p.runId, sourceNodeId);
          return;
        }
      }
    } else if (identity || (payload as NodeHelloPayload).nodeId !== sourceNodeId) {
      throw new ProtocolError("Invalid or repeated handshake", "INVALID_HANDSHAKE");
    }

    // 幂等去重检查 (除握手与心跳外)
    if (type !== "node.hello" && type !== "node.heartbeat" && type !== "event.batch" && !type.startsWith("task.")) {
      const isNew = await this.store.checkAndRecordInbox(messageId, sourceNodeId);
      if (!isNew) {
        return; // 消息重复到达，幂等忽略
      }
    }

    switch (type) {
      case "node.hello": {
        const hello = payload as NodeHelloPayload;
        const authRes = await this.registry.authenticateNode(hello, ws, remoteIp);

        if (!authRes.success) {
          const rejectedPayload: NodeRejectedPayload = {
            reason: authRes.reason ?? "Authentication rejected",
            code: "INVALID_TOKEN",
          };
          ws.send(
            encodeEnvelope(
              createEnvelope("node.rejected", rejectedPayload, this.coordinatorNodeId, hello.nodeId, messageId)
            )
          );
          ws.close(4003, authRes.reason);
          return;
        }

        onAuthSuccess(hello.nodeId, authRes.generation);

        const authPayload: NodeAuthenticatedPayload = {
          assignedNodeId: hello.nodeId,
          nodeToken: authRes.nodeToken,
          coordinatorVersion: runtimeRelease.packageVersion ?? "1.0.0",
          connectionGeneration: authRes.generation,
          heartbeatIntervalMs: 10000,
          heartbeatTimeoutMs: 30000,
        };

        ws.send(
          encodeEnvelope(
            createEnvelope("node.authenticated", authPayload, this.coordinatorNodeId, hello.nodeId, messageId)
          )
        );
        // 节点重连后重新对账任务级授权：只处理尚未确认撤销的授权，绝不复活已撤销的授权。
        void this.reconcileTaskSecurityGrants(hello.nodeId).catch(() => {});
        break;
      }

      case "node.heartbeat": {
        const hb = payload as HeartbeatPayload;
        if (!await this.registry.recordHeartbeat(hb.nodeId, hb.generation)) throw new ProtocolError("Current heartbeat generation required", "STALE_GENERATION");
        const ack: HeartbeatAckPayload = {
          timestamp: hb.timestamp,
          generation: hb.generation,
          coordinatorTime: Date.now(),
        };
        ws.send(
          encodeEnvelope(
            createEnvelope("node.heartbeat_ack", ack, this.coordinatorNodeId, hb.nodeId, messageId)
          )
        );
        break;
      }

      case "node.drain_status": {
        const p = payload as NodeDrainStatusPayload;
        const waiter = this.drainProbes.get(p.probeId);
        if (waiter && waiter.nodeId === p.nodeId) {
          this.drainProbes.delete(p.probeId);
          clearTimeout(waiter.timer);
          waiter.resolve(p);
        }
        break;
      }

      case "task.accepted": {
        const p = payload as TaskAcceptedPayload;
        await observeRuntimePhase("worker_accepted", async () => {
          await this.store.updateTaskStatus(p.taskId, "accepted");
          await this.graphOrchestrator?.syncTaskActivity?.(p.taskId);
        }, { taskId: p.taskId, nodeId: sourceNodeId });
        break;
      }

      case "task.rejected": {
        const p = payload as TaskRejectedPayload;
        await this.store.updateTaskStatus(p.taskId, p.code === "OUTCOME_UNKNOWN" ? "outcome_unknown" : "failed", {
          error: `Task rejected by worker: ${p.reason} (${p.code})`,
        });
        if (p.code === "OUTCOME_UNKNOWN") {
          await this.graphOrchestrator?.syncTaskActivity(p.taskId);
          this.emitBusEvent("task.outcome_unknown", { ...p, error: p.reason });
        }
        else {
          this.emitBusEvent("task.failed", { ...p, error: p.reason });
          const node = await this.store.findGraphNodeByTaskId?.(p.taskId);
          if (node) await this.graphOrchestrator?.handleNodeTaskFailed(node.graphId, p.taskId, p.reason);
        }
        break;
      }

      case "task.started": {
        const p = payload as TaskStartedPayload;
        await this.store.updateTaskStatus(p.taskId, "running");
        await this.graphOrchestrator?.syncTaskActivity?.(p.taskId);
        this.emitBusEvent("task.started", p as any);
        break;
      }

      case "task.progress": {
        const p = payload as TaskProgressPayload;
        await this.store.updateTaskStatus(p.taskId, "running", {
          resultSummary: p.activitySummary,
        });
        await this.graphOrchestrator?.syncTaskActivity?.(p.taskId);
        this.emitBusEvent("task.progress", p as any);
        break;
      }

      case "task.completed": {
        const p = payload as TaskCompletedPayload;
        await this.store.updateTaskStatus(p.taskId, "completed", {
          finalAnswer: p.finalAnswer,
          deliverables: p.deliverables,
        });
        this.emitBusEvent("task.completed", p as any);

        // Phase 4: 联动通知分布式任务图编排器
        if (this.graphOrchestrator) {
          try {
            const matched = await this.store.findGraphNodeByTaskId?.(p.taskId);
            if (matched) await this.graphOrchestrator.handleNodeTaskCompleted(matched.graphId, p.taskId,
              p.finalAnswer ?? "Task completed", p.producedArtifacts, (p as any).verificationEvidence);
          } catch (err) {
            console.error(`[WssGateway] Error notifying graph orchestrator of task completion:`, err);
          }
        }
        break;
      }

      case "task.failed": {
        const p = payload as TaskFailedPayload;
        await this.store.updateTaskStatus(p.taskId, "failed", {
          error: p.error,
          resultSummary: p.partialResult,
        });
        this.emitBusEvent("task.failed", p as any);

        // Phase 4: 联动通知分布式任务图编排器
        if (this.graphOrchestrator) {
          try {
            const matched = await this.store.findGraphNodeByTaskId?.(p.taskId);
            if (matched) await this.graphOrchestrator.handleNodeTaskFailed(matched.graphId, p.taskId, p.error);
          } catch (err) {
            console.error(`[WssGateway] Error notifying graph orchestrator of task failure:`, err);
          }
        }
        break;
      }

      case "agent.message_send": {
        const msg = payload as any;
        if (msg.sourceNodeId !== sourceNodeId || !msg.sourceTaskId || !msg.targetTaskId || !Number.isFinite(msg.expiresAt) || msg.expiresAt <= Date.now()) throw new ProtocolError("Invalid A2A identity or expiry", "TASK_MISMATCH");
        await validateMessageMembership(this.store, msg);
        if (msg.payload?.isSystemApproval || msg.payload?.escalatePrivileges || msg.payload?.bypassSandbox) throw new ProtocolError("A2A privilege escalation rejected", "TASK_MISMATCH");
        const existing = await this.store.getAgentMessage?.(msg.messageId);
        if (existing && (existing.sourceNodeId !== msg.sourceNodeId || existing.sourceTaskId !== msg.sourceTaskId || existing.targetTaskId !== msg.targetTaskId || existing.targetNodeId !== msg.targetNodeId || existing.graphId !== msg.graphId || JSON.stringify(existing.payload) !== JSON.stringify(msg.payload))) throw new ProtocolError("A2A message identity reused", "TASK_MISMATCH");
        if (!existing) await this.store.saveAgentMessage?.({ ...msg, deliveryStatus: "pending" });
        await this.store.enqueueOutbox({ targetNodeId: msg.targetNodeId, messageId: msg.messageId, messageType: "agent.message_deliver", payload: msg, status: "pending", attempts: 0, nextRetryAt: Date.now(), createdAt: Date.now() });
        await this.scheduler?.flushOutbox();
        break;
      }

      case "agent.message_ack": {
        const ack = payload as any;
        const msg = await this.store.getAgentMessage?.(ack.messageId);
        if (!msg || msg.targetNodeId !== sourceNodeId || msg.targetTaskId !== ack.taskId || ack.status !== "acknowledged") throw new ProtocolError("A2A acknowledgement identity mismatch", "TASK_MISMATCH");
        await this.store.updateAgentMessageStatus?.(ack.messageId, "acknowledged");
        await this.store.markOutboxSent(ack.messageId);
        break;
      }

      case "artifact.ready": {
        const art = payload as any;
        const task = art.producerTaskId ? await this.store.getTask(art.producerTaskId) : null;
        const existing = await this.store.getArtifact?.(art.artifactId);
        // Worker paths belong to a different filesystem; only Coordinator-published records are authoritative.
        if (art.producerNodeId !== sourceNodeId || !task || task.nodeId !== sourceNodeId || task.dispatchOptions?.graphContext?.graphId !== art.graphId || !existing || existing.graphId !== art.graphId || existing.producerNodeId !== sourceNodeId || existing.producerTaskId !== task.taskId || existing.storagePath !== art.storagePath || existing.sha256 !== art.sha256) {
          throw new ProtocolError("Untrusted artifact publication", "TASK_MISMATCH");
        }
        break;
      }

      case "task.control_ack": {
        const p = payload as any;
        this.scheduler?.handleControlAck(p);
        this.emitBusEvent("task.control_ack", p);
        // ACK 仅确认请求已被接受；必须等待 task.cancelled 才能宣告取消完成。
        break;
      }

      case "task.grant_security_ack": {
        const p = payload as TaskGrantSecurityAckPayload;
        // 若 HTTP 请求方仍在等待，由 requestGrant 负责持久化；否则由这里收敛。
        const consumed = this.scheduler?.handleGrantSecurityAck(p) ?? false;
        await this.taskSecurityGrants?.handleGrantAck(p, consumed);
        break;
      }

      case "task.revoke_security_ack": {
        const p = payload as TaskRevokeSecurityAckPayload;
        const consumed = this.scheduler?.handleRevokeSecurityAck(p) ?? false;
        await this.taskSecurityGrants?.handleRevokeAck(p, consumed);
        break;
      }

      case "task.cancelled": {
        const p = payload as TaskCancelledPayload;
        const currentTask = await this.store.getTask(p.taskId);
        if (currentTask && currentTask.status !== "completed") {
          await this.store.updateTaskStatus(p.taskId, "cancelled", {
            error: p.reason,
          });
        }
        this.emitBusEvent("task.cancelled", p as any);
        if (this.graphOrchestrator) {
          const allGraphs = (await this.store.listGraphs?.()) ?? [];
          for (const g of allGraphs) {
            if (["running", "paused", "blocked", "cancelling", "outcome_unknown"].includes(g.status)) {
              const nodes = (await this.store.listGraphNodes?.(g.graphId)) ?? [];
              const matched = nodes.find((n) => n.taskId === p.taskId);
              if (matched) {
                await this.graphOrchestrator.handleNodeTaskCancelled(g.graphId, p.taskId, p.reason);
                break;
              }
            }
          }
        }
        break;
      }

      case "event.batch": {
        const p = payload as EventBatchPayload;
        if (Array.isArray(p.events) && p.events.length > 0) {
          if (p.events.some((event) => event.nodeId !== p.nodeId || event.taskId !== p.taskId || event.runId !== p.runId)) throw new ProtocolError("Event owner or run mismatch", "TASK_MISMATCH");
          await this.store.appendEvents(p.events);
          const usageTask = await this.store.getTask(p.taskId);
          for (const event of p.events.filter(e => e.eventType === "runtime.span")) {
            const span = event.data as unknown as RuntimeSpan;
            if (!/^[a-f0-9-]{36}$/.test(span.spanId)) continue;
            await this.store.saveRuntimeSpan?.({ ...span, spanId: span.spanId, taskId: p.taskId, runId: p.runId, nodeId: sourceNodeId,
              traceId: usageTask?.dispatchOptions?.graphContext?.traceId ?? span.traceId,
              graphId: usageTask?.dispatchOptions?.graphContext?.graphId, graphRevision: usageTask?.dispatchOptions?.graphContext?.graphRevision,
            });
          }
          for (const event of p.events.filter(e => e.eventType === "model.usage")) {
            const record = event.data as unknown as ModelUsageRecord;
            if (!/^[a-f0-9-]{36}$/.test(record.accountingId) || !Number.isSafeInteger(record.startedAt)) continue;
            await this.store.saveModelUsage?.({ ...record, accountingId: `${p.taskId}:${record.accountingId}`,
              taskId: p.taskId, runId: p.runId, nodeId: sourceNodeId,
              graphId: usageTask?.dispatchOptions?.graphContext?.graphId,
              graphRevision: usageTask?.dispatchOptions?.graphContext?.graphRevision,
              traceId: usageTask?.dispatchOptions?.graphContext?.traceId,
              conversationId: usageTask?.dispatchOptions?.graphContext?.conversationId,
            });
          }


          // 防御性状态推进：如果批量事件中包含 task.started，确保任务状态为 running
          const hasStarted = p.events.some((e) => e.eventType === "task.started");
          if (hasStarted) {
            const currentTask = await this.store.getTask(p.taskId);
            if (currentTask && (currentTask.status === "created" || currentTask.status === "accepted" || currentTask.status === "dispatched")) {
              await this.store.updateTaskStatus(p.taskId, "running");
            }
          }

          for (const ev of p.events) {
            if (ev.eventType === "discovery.report_persisted") {
              // ACK only after indexing succeeds; the durable Worker Outbox retries failures.
              await this.discoveryService?.ingestPersistedReport(ev.data.report as DiscoveryReport, sourceNodeId);
            }
            if (ev.eventType === "agent.message_send") {
              try {
                await this.handleEnvelope(createEnvelope("agent.message_send", { ...ev.data, sourceNodeId, sourceTaskId: p.taskId }, sourceNodeId, this.coordinatorNodeId), ws, remoteIp, onAuthSuccess);
              } catch (error) {
                this.emitBusEvent("agent.message_rejected" as any, { taskId: p.taskId, messageId: ev.data.messageId, reason: String(error) });
              }
            }
            if (ev.eventType === "security.audit") {
              // Workers also use this event type for grant status notifications
              // (TASK_SECURITY_GRANT_APPLIED / TASK_SECURITY_GRANT_REVOKED). Those are not audit
              // records: passing them to the audit store violates its NOT NULL id and throws,
              // which aborts the whole batch before it can be acknowledged, so the Worker
              // retries the same events forever.
              const record = ev.data as Record<string, unknown> | undefined;
              const isAuditRecord = Boolean(
                record
                && typeof record.id === "string"
                && typeof record.argsFingerprint === "string"
                && typeof record.toolName === "string"
                && typeof record.verdict === "string"
              );
              if (isAuditRecord) {
                await this.store.saveSecurityAudit?.(record as any);
              } else {
                this.emitBusEvent("security.audit_unrecognized" as any, { taskId: p.taskId, nodeId: sourceNodeId, type: record?.type ?? null });
              }
            }
            if (["task.completed", "task.failed", "task.cancelled"].includes(ev.eventType)) {
              const replay = createEnvelope(ev.eventType as any, { ...ev.data, taskId: p.taskId, runId: p.runId, nodeId: p.nodeId }, sourceNodeId, this.coordinatorNodeId);
              await this.handleEnvelope(replay, ws, remoteIp, onAuthSuccess);
            }
          }
          const watermarkKey = `${p.taskId}:${p.runId}`;
          let maxSeq = this.eventWatermarks.get(watermarkKey) ?? 0;
          while (true) {
            const batch = await this.store.getEventsForTask(p.taskId, maxSeq + 1, 1000);
            const before = maxSeq;
            for (const event of batch) {
              if (event.runId !== p.runId || event.seq !== maxSeq + 1) break;
              maxSeq = event.seq;
            }
            if (batch.length < 1000 || maxSeq === before || batch.at(-1)?.seq !== maxSeq) break;
          }
          if (this.eventWatermarks.size >= 10000) this.eventWatermarks.delete(this.eventWatermarks.keys().next().value!);
          this.eventWatermarks.set(watermarkKey, maxSeq);
          const ack: EventAckPayload = {
            taskId: p.taskId,
            runId: p.runId,
            lastAckedSeq: maxSeq,
          };
          ws.send(
            encodeEnvelope(
              createEnvelope("event.ack", ack, this.coordinatorNodeId, p.nodeId, messageId)
            )
          );
        }
        break;
      }

      case "approval.ack": {
        const p = payload as { approvalId: string; taskId: string; runId: string };
        const approval = await this.store.getApproval(p.approvalId);
        if (!approval || approval.taskId !== p.taskId || approval.runId !== p.runId || approval.nodeId !== sourceNodeId) throw new ProtocolError("Approval owner mismatch", "TASK_MISMATCH");
        await this.store.markOutboxSent(approvalResolutionMessageId(p.approvalId));
        const task = await this.store.getTask(p.taskId);
        const pending = (await this.store.listPendingApprovals()).some((item) => item.taskId === p.taskId);
        if (task?.status === "waiting_approval" && !pending) {
          await this.store.updateTaskStatus(p.taskId, "running");
          await this.graphOrchestrator?.syncTaskActivity?.(p.taskId);
        }
        break;
      }

      case "approval.expired": {
        // Worker 端审批等待超时：裁决已在 Worker 本地 Fail-Closed 为 deny，
        // 这里负责把持久化记录从 pending 收敛，并让任务回到真实执行态。
        const p = payload as RemoteApprovalExpiredPayload;
        if (p.nodeId !== sourceNodeId) throw new ProtocolError("Approval owner mismatch", "TASK_MISMATCH");
        const result = await applyWorkerApprovalExpiry(this.store, p);
        if (!result) throw new ProtocolError("Approval owner mismatch", "TASK_MISMATCH");
        if (result.alreadyResolved) break;
        if (result.resumed) {
          await this.graphOrchestrator?.syncTaskActivity?.(p.taskId);
          this.emitBusEvent("task.started", { taskId: p.taskId, runId: p.runId, nodeId: p.nodeId });
        }
        this.emitBusEvent("approval.resolved", {
          approvalId: p.approvalId,
          taskId: p.taskId,
          runId: p.runId,
          nodeId: p.nodeId,
          decision: "deny",
          resolvedBy: p.reason || "worker-timeout",
          expired: true,
        });
        break;
      }

      case "approval.requested": {
        const p = payload as RemoteApprovalRequestPayload;
        const existing = await this.store.getApproval(p.approvalId);
        if (existing) {
          if (existing.taskId !== p.taskId || existing.runId !== p.runId || existing.nodeId !== p.nodeId) throw new ProtocolError("Approval identity mismatch", "TASK_MISMATCH");
          if (existing.status === "resolved") await this.scheduler?.queueApprovalResolution(p.approvalId);
          break;
        }
        await this.store.saveApproval({
          approvalId: p.approvalId,
          taskId: p.taskId,
          runId: p.runId,
          nodeId: p.nodeId,
          agentId: p.agentId,
          capability: p.capability,
          reason: p.reason,
          target: p.target,
          toolName: p.toolName,
          status: "pending",
          requestedAt: p.createdAt,
          expiresAt: p.expiresAt,
        });
        await this.store.updateTaskStatus(p.taskId, "waiting_approval");
        await this.graphOrchestrator?.syncTaskActivity?.(p.taskId);
        const currentPending = (await this.store.listPendingApprovals()).length;
        this.emitBusEvent("approval.requested", { ...p, status: "pending", pendingApprovals: currentPending } as any);
        break;
      }

      case "catalog.sync_snapshot": {
        if (this.catalogService) {
          const snapshot = payload as CatalogSyncSnapshotPayload;
          const ack = await this.catalogService.handleSnapshot(snapshot, identity!.generation);
          ws.send(
            encodeEnvelope(
              createEnvelope("catalog.sync_snapshot_ack", ack, this.coordinatorNodeId, sourceNodeId, messageId)
            )
          );
        }
        break;
      }

      case "catalog.sync_delta": {
        if (this.catalogService) {
          const delta = payload as CatalogSyncDeltaPayload;
          const ack = await this.catalogService.handleDelta(delta, identity!.generation);
          ws.send(
            encodeEnvelope(
              createEnvelope("catalog.sync_delta_ack", ack, this.coordinatorNodeId, sourceNodeId, messageId)
            )
          );
        }
        break;
      }

      case "memory.search_remote_response": {
        if (this.catalogService) {
          const res = payload as RemoteMemorySearchResponsePayload;
          this.catalogService.handleRemoteSearchResponse(res);
        }
        break;
      }
    }
    if (["task.completed", "task.failed", "task.cancelled", "task.rejected"].includes(type)) {
      const p = payload as { taskId: string; runId: string };
      // 任务终态即授权终点：granted/applied 自动失效；revocation_pending 保留待对账。
      await this.taskSecurityGrants?.expireForTask(p.taskId);
      this.acknowledgeResult(ws, p.taskId, p.runId, sourceNodeId);
    }
  }

  /**
   * 节点重连后的授权对账：
   * 仅对 granted / revocation_pending 的授权重新下发撤销并等待真实 ACK。
   * applied 的授权说明 Worker 已确认，保持有效；revoked/expired 永不复活。
   */
  private async reconcileTaskSecurityGrants(nodeId: string): Promise<void> {
    if (!this.scheduler) return;
    const grants = await this.store.listTaskSecurityGrants?.({ nodeId }) ?? [];
    for (const grant of grants) {
      if (grant.status !== "granted" && grant.status !== "revocation_pending") continue;
      const result = await this.scheduler.revokeTaskSecurity(grant,
        "Reconciling task security grant after node reconnect", "reconciliation");
      if (!result.success) continue;
      const changed = await this.store.transitionTaskSecurityGrant?.(grant.grantId,
        ["granted", "applied", "revocation_pending"], "revoked", {
          revokedAt: Date.now(), revokedBy: "reconciliation", reconciliationRequired: false,
        });
      if (changed) this.emitBusEvent("task.grant_revoked", { grantId: grant.grantId, taskId: grant.taskId, runId: grant.runId, nodeId });
    }
  }

  private acknowledgeResult(ws: WebSocket, taskId: string, runId: string, nodeId: string): void {
    ws.send(encodeEnvelope(createEnvelope("task.result_ack", { taskId, runId }, this.coordinatorNodeId, nodeId)));
  }

  private emitBusEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: "coordinator",
        sessionId: "main-coordinator",
        data,
      });
    }
  }

  close(): void {
    try {
      for (const client of this.wss.clients) client.terminate();
      this.wss.close();
    } catch {}
  }
}
