import { resolveNashHome } from "../../config/data-home.js";
import { runtimeRelease } from "../../runtime/release-info.js";
import { WebSocket } from "ws";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { NodeIdentity } from "../identity/node-identity.js";
import type { ProjectRegistry } from "./project-registry.js";
import {
  ProtocolError,
  decodeEnvelope,
  encodeEnvelope,
  createEnvelope,
} from "../protocol/message-codec.js";
import type {
  ClusterEnvelope,
  AgentMessageSendPayload,
  NodeHelloPayload,
  NodeAuthenticatedPayload,
  HeartbeatPayload,
  TaskDispatchPayload,
  TaskControlPayload,
  TaskGrantSecurityPayload,
  TaskRevokeSecurityPayload,
  RemoteApprovalResolvePayload,
  EventAckPayload,
  CatalogSyncSnapshotAckPayload,
  CatalogSyncDeltaAckPayload,
  RemoteMemorySearchPayload,
  NodeDrainProbePayload,
  NodeDrainStatusPayload,
} from "../protocol/types.js";

export type WorkerConnectionState = "CONNECTING" | "RETRY_WAIT" | "RECONNECTING" | "CONNECTED" | "BLOCKED" | "STOPPED";
export class WorkerConnectionError extends Error {
  readonly exitCode = 78;
  constructor(public readonly code: string) {
    super(`Worker connection blocked: ${code}`);
    this.name = "WorkerConnectionError";
  }
}
export interface ConnectionStatus {
  state: WorkerConnectionState;
  attempt: number;
  retryAt?: number;
  errorCode?: string;
}

export interface CoordinatorClientOptions {
  coordinatorUrl: string;
  connectTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  onConnectionState?: (status: ConnectionStatus) => void;
  onFatalError?: (error: WorkerConnectionError) => void;
  identity: NodeIdentity;
  projectRegistry: ProjectRegistry;
  inviteCode?: string;
  heartbeatIntervalMs?: number;
  maxConcurrentRuns?: number;
  activeTasksCount?: () => number;
  /**
   * 真实运行态快照：用于回答 Coordinator 的排空探针。
   * 必须来自进程内实际持有的 Runner，而不是数据库状态。
   */
  drainSnapshot?: () => { activeTaskIds: string[]; pendingDispatches: number; acceptingTasks: boolean };
  onAuthenticated?: () => void;
  onTaskDispatch?: (payload: TaskDispatchPayload) => void;
  onAgentMessage?: (payload: AgentMessageSendPayload) => void;
  onTaskControl?: (payload: TaskControlPayload) => void;
  onApprovalResolved?: (payload: RemoteApprovalResolvePayload) => void;
  onTaskGrantSecurity?: (payload: TaskGrantSecurityPayload) => void;
  onTaskRevokeSecurity?: (payload: TaskRevokeSecurityPayload) => void;
  onTaskResultAck?: (payload: { taskId: string; runId: string }) => void;
  onEventAck?: (payload: EventAckPayload) => void;
  onCatalogSnapshotAck?: (payload: CatalogSyncSnapshotAckPayload) => void;
  onCatalogDeltaAck?: (payload: CatalogSyncDeltaAckPayload) => void;
  onRemoteMemorySearchRequest?: (payload: RemoteMemorySearchPayload, correlationId?: string) => void;
}

export class CoordinatorClient {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private isAuthenticating = false;
  private controller?: AbortController;
  private connectionPromise?: Promise<void>;
  private status: ConnectionStatus = { state: "STOPPED", attempt: 0 };
  private lastRetryLogAt = 0;
  private heartbeatTimer?: NodeJS.Timeout;
  private currentGeneration = 0;
  private coordinatorNodeId = "coordinator";
  private reconnectAttempt = 0;

  constructor(private readonly options: CoordinatorClientOptions) {}

  get coordinatorId(): string { return this.coordinatorNodeId; }

  get connected(): boolean {
    return this.isConnected;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  getWebSocket(): WebSocket | null {
    return this.ws;
  }

  get connectionStatus(): Readonly<ConnectionStatus> { return { ...this.status }; }

  connect(): Promise<void> {
    if (this.connectionPromise) return this.connectionPromise;
    const controller = new AbortController();
    this.controller = controller;
    let resolveFirst!: () => void;
    let rejectFirst!: (error: unknown) => void;
    this.connectionPromise = new Promise<void>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    void this.runConnections(controller.signal, resolveFirst).catch(error => {
      rejectFirst(error);
      if (!controller.signal.aborted) {
        this.setStatus({ state: "BLOCKED", attempt: this.reconnectAttempt, errorCode: error.code });
        console.error(`[CoordinatorClient] BLOCKED: ${error.code}`);
        this.options.onFatalError?.(error);
      }
    });
    return this.connectionPromise;
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.options.onConnectionState?.({ ...status });
  }

  private async runConnections(signal: AbortSignal, authenticated: () => void): Promise<void> {
    while (!signal.aborted) {
      this.setStatus({ state: this.reconnectAttempt ? "RECONNECTING" : "CONNECTING", attempt: this.reconnectAttempt });
      try {
        await this.doConnect(signal, () => {
          this.reconnectAttempt = 0;
          this.setStatus({ state: "CONNECTED", attempt: 0 });
          authenticated();
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof WorkerConnectionError) throw error;
        const code = (error as NodeJS.ErrnoException).code ?? "CONNECTION_CLOSED";
        const transient = ["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EAI_AGAIN", "ENOTFOUND", "CONNECTION_CLOSED", "HANDSHAKE_TIMEOUT", "HTTP_RETRY"].includes(code);
        if (!transient) throw new WorkerConnectionError(code);
        this.reconnectAttempt++;
        const max = this.options.retryMaxMs ?? 15000;
        const base = Math.min((this.options.retryBaseMs ?? 1000) * Math.pow(1.5, Math.min(this.reconnectAttempt - 1, 30)), max);
        const delay = Math.min(max, Math.round(base * (0.8 + Math.random() * 0.4)));
        this.setStatus({ state: "RETRY_WAIT", attempt: this.reconnectAttempt, retryAt: Date.now() + delay, errorCode: code });
        if (this.reconnectAttempt === 1 || Date.now() - this.lastRetryLogAt >= 60000) {
          // Only emit classified codes: transport errors and server payloads may contain credentials.
          console.warn(`[CoordinatorClient] ${code}; retrying (attempt ${this.reconnectAttempt}, delay ${delay}ms)`);
          this.lastRetryLogAt = Date.now();
        }
        if (signal.aborted) throw signal.reason;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
          signal.addEventListener("abort", abort, { once: true });
        });
      }
    }
    throw signal.reason;
  }

  // One attempt remains pending through authentication until this exact socket disconnects.
  private doConnect(signal: AbortSignal, authenticated: () => void): Promise<void> {
    return new Promise<void>((_resolve, reject) => {
      let ws: WebSocket;
      let finished = false;
      const finish = (error: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.cleanupConnection();
        reject(error);
      };
      const abort = () => finish(signal.reason);
      const timer = setTimeout(() => finish(Object.assign(new Error("Handshake timed out"), { code: "HANDSHAKE_TIMEOUT" })), this.options.connectTimeoutMs ?? 10000);
      signal.addEventListener("abort", abort, { once: true });
      try {
        const url = new URL(this.options.coordinatorUrl);
        if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new WorkerConnectionError("INVALID_COORDINATOR_URL");
        const wsOptions: { ca?: Buffer; handshakeTimeout: number } = { handshakeTimeout: this.options.connectTimeoutMs ?? 10000 };
        const caPath = path.join(resolveNashHome(), "nash-ca.crt");
        if (fs.existsSync(caPath)) wsOptions.ca = fs.readFileSync(caPath);
        ws = new WebSocket(url, wsOptions);
        this.ws = ws;
      } catch (error) {
        finish(error instanceof WorkerConnectionError ? error : new WorkerConnectionError("INVALID_CONNECTION_CONFIG"));
        return;
      }
      ws.on("open", () => {
        this.isAuthenticating = true;
        try { this.sendHello(); } catch { finish(new WorkerConnectionError("INVALID_NODE_IDENTITY")); }
      });
      ws.on("message", data => {
        try {
          const envelope = decodeEnvelope(data as Buffer);
          if (envelope.type === "node.rejected") { finish(new WorkerConnectionError("AUTHENTICATION_REJECTED")); return; }
          if (envelope.type === "node.authenticated" && this.isAuthenticating) {
            const payload = envelope.payload as NodeAuthenticatedPayload;
            if (!Number.isSafeInteger(payload.connectionGeneration) || payload.connectionGeneration < 1 || (payload.assignedNodeId && payload.assignedNodeId !== this.options.identity.nodeId)) {
              finish(new WorkerConnectionError("INVALID_NODE_IDENTITY")); return;
            }
            this.handleEnvelope(envelope);
            clearTimeout(timer);
            authenticated();
          } else if (envelope.type !== "node.authenticated" && this.isConnected) this.handleEnvelope(envelope);
        } catch (error) {
          finish(new WorkerConnectionError(error instanceof ProtocolError ? error.code : "INVALID_HANDSHAKE"));
        }
      });
      ws.on("unexpected-response", (_request, response) => {
        const code = response.statusCode ?? 0;
        response.resume();
        finish(code === 408 || code === 429 || code >= 500
          ? Object.assign(new Error("Gateway unavailable"), { code: "HTTP_RETRY" })
          : new WorkerConnectionError(`HTTP_${code}`));
      });
      ws.on("close", code => finish([1002, 1003, 1008, 4001, 4003].includes(code)
        ? new WorkerConnectionError(`CLOSE_${code}`)
        : Object.assign(new Error("Connection closed"), { code: "CONNECTION_CLOSED" })));
      ws.on("error", finish);
    });
  }

  private sendHello(): void {
    if (!this.ws || this.ws.readyState !== 1) return;

    const projects = this.options.projectRegistry.listProjects().map((p) => ({
      projectId: p.projectId,
      name: p.name,
    }));

    let sandboxBackend: "seatbelt" | "bubblewrap" | "windows-sandbox" | "none" = "none";
    if (process.platform === "darwin") {
      sandboxBackend = "seatbelt";
    } else if (process.platform === "linux") {
      sandboxBackend = "bubblewrap";
    } else if (process.platform === "win32") {
      sandboxBackend = "windows-sandbox";
    }

    const payload: NodeHelloPayload = {
      nodeId: this.options.identity.nodeId,
      name: this.options.identity.name,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      nodeVersion: process.version,
      nashVersion: runtimeRelease.packageVersion ?? "1.0.0",
      runtimeRelease,
      sandboxBackend,
      capabilities: ["filesystem", "shell", "tools", "mcp", "memory"],
      maxConcurrentRuns: this.options.maxConcurrentRuns ?? 4,
      projects,
      nodeToken: this.options.identity.nodeToken,
      inviteCode: this.options.identity.nodeToken ? undefined : this.options.inviteCode,
    };

    const envelope = createEnvelope(
      "node.hello",
      payload,
      this.options.identity.nodeId,
      "coordinator"
    );

    this.ws.send(encodeEnvelope(envelope));
  }

  private handleEnvelope(envelope: ClusterEnvelope): void {
    const { type, payload, sourceNodeId } = envelope;

    switch (type) {
      case "node.authenticated": {
        const p = payload as NodeAuthenticatedPayload;
        this.isConnected = true;
        this.isAuthenticating = false;
        this.currentGeneration = p.connectionGeneration;
        this.coordinatorNodeId = sourceNodeId;

        // 保存更新持久 Token
        if (p.nodeToken) {
          this.options.identity.setNodeToken(p.nodeToken);
        }
        if (p.assignedNodeId && p.assignedNodeId !== this.options.identity.nodeId) {
          this.options.identity.setNodeId(p.assignedNodeId);
        }

        // 启动心跳
        this.startHeartbeat(p.heartbeatIntervalMs ?? this.options.heartbeatIntervalMs ?? 10000);

        // 握手成功通知 (用于 Catalog 全量同步)
        if (this.options.onAuthenticated) {
          this.options.onAuthenticated();
        }
        break;
      }

      case "node.rejected": {
        this.cleanupConnection();
        // Rejections are classified by the connection lifecycle before dispatch.
        break;
      }

      case "node.heartbeat_ack": {
        // 心跳 ACK 正常收到
        break;
      }

      case "catalog.sync_snapshot_ack": {
        if (this.options.onCatalogSnapshotAck) {
          this.options.onCatalogSnapshotAck(payload as CatalogSyncSnapshotAckPayload);
        }
        break;
      }

      case "catalog.sync_delta_ack": {
        if (this.options.onCatalogDeltaAck) {
          this.options.onCatalogDeltaAck(payload as CatalogSyncDeltaAckPayload);
        }
        break;
      }

      case "memory.search_remote_request": {
        if (this.options.onRemoteMemorySearchRequest) {
          this.options.onRemoteMemorySearchRequest(payload as RemoteMemorySearchPayload, envelope.correlationId);
        }
        break;
      }

      case "task.dispatch": {
        if (!this.isConnected || sourceNodeId !== this.coordinatorNodeId) return;
        if (this.options.onTaskDispatch) {
          this.options.onTaskDispatch(payload as TaskDispatchPayload);
        }
        break;
      }

      case "node.drain_probe": {
        // 只接受当前 Coordinator 的探针；应答内容是进程内真实 Runner 注册表。
        if (!this.isConnected || sourceNodeId !== this.coordinatorNodeId) return;
        const probe = payload as NodeDrainProbePayload;
        const snapshot = this.options.drainSnapshot?.();
        const status: NodeDrainStatusPayload = {
          nodeId: this.options.identity.nodeId,
          probeId: probe.probeId,
          activeRuns: snapshot?.activeTaskIds.length ?? 0,
          activeTaskIds: snapshot?.activeTaskIds ?? [],
          pendingDispatches: snapshot?.pendingDispatches ?? 0,
          acceptingTasks: snapshot?.acceptingTasks ?? true,
          respondingAt: Date.now(),
        };
        try {
          this.ws?.send(encodeEnvelope(createEnvelope("node.drain_status", status, this.options.identity.nodeId, this.coordinatorNodeId)));
        } catch {}
        break;
      }

      case "task.control": {
        if (this.options.onTaskControl) {
          this.options.onTaskControl(payload as TaskControlPayload);
        }
        break;
      }

      case "agent.message_deliver": {
        this.options.onAgentMessage?.(payload as AgentMessageSendPayload);
        break;
      }

      case "approval.resolved": {
        if (this.options.onApprovalResolved) {
          this.options.onApprovalResolved(payload as RemoteApprovalResolvePayload);
        }
        break;
      }

      case "task.grant_security": {
        if (this.options.onTaskGrantSecurity) {
          this.options.onTaskGrantSecurity(payload as TaskGrantSecurityPayload);
        }
        break;
      }

      case "task.revoke_security": {
        if (this.options.onTaskRevokeSecurity) {
          this.options.onTaskRevokeSecurity(payload as TaskRevokeSecurityPayload);
        }
        break;
      }

      case "task.result_ack": {
        this.options.onTaskResultAck?.(payload as { taskId: string; runId: string });
        break;
      }

      case "event.ack": {
        if (this.options.onEventAck) {
          this.options.onEventAck(payload as EventAckPayload);
        }
        break;
      }
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== 1 || !this.isConnected) return;

    const payload: HeartbeatPayload = {
      nodeId: this.options.identity.nodeId,
      timestamp: Date.now(),
      generation: this.currentGeneration,
      activeTasksCount: this.options.activeTasksCount?.() ?? 0,
    };

    const envelope = createEnvelope(
      "node.heartbeat",
      payload,
      this.options.identity.nodeId,
      this.coordinatorNodeId
    );

    try {
      this.ws.send(encodeEnvelope(envelope));
    } catch {}
  }

  private cleanupConnection(): void {
    this.isConnected = false;
    this.isAuthenticating = false;
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.on("error", () => {});
        this.ws.terminate();
      } catch {}
      this.ws = null;
    }
  }

  disconnect(): void {
    this.controller?.abort(new DOMException("Worker stopped", "AbortError"));
    this.cleanupConnection();
    this.connectionPromise = undefined;
    this.reconnectAttempt = 0;
    this.setStatus({ state: "STOPPED", attempt: 0 });
  }
}
