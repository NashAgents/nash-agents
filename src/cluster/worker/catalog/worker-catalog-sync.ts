import type { WebSocket } from "ws";
import { LocalCatalogProvider } from "./local-catalog-provider.js";
import { createEnvelope, encodeEnvelope } from "../../protocol/message-codec.js";
import type {
  CatalogSyncSnapshotPayload,
  CatalogSyncDeltaPayload,
  CatalogSyncSnapshotAckPayload,
  CatalogSyncDeltaAckPayload,
  RemoteMemorySearchPayload,
  ClusterEnvelope,
} from "../../protocol/types.js";

export interface WorkerCatalogSyncOptions {
  nodeId: string;
  provider: LocalCatalogProvider;
  getWebSocket: () => WebSocket | null;
  coordinatorNodeId?: string;
  autoSyncIntervalMs?: number;
}

export class WorkerCatalogSyncService {
  private readonly nodeId: string;
  private readonly provider: LocalCatalogProvider;
  private readonly getWebSocket: () => WebSocket | null;
  private readonly coordinatorNodeId: string;
  private autoSyncTimer?: NodeJS.Timeout;
  private lastAckedRevision = 0;
  private isSyncing = false;

  constructor(options: WorkerCatalogSyncOptions) {
    this.nodeId = options.nodeId;
    this.provider = options.provider;
    this.getWebSocket = options.getWebSocket;
    this.coordinatorNodeId = options.coordinatorNodeId ?? "coordinator";

    if (options.autoSyncIntervalMs && options.autoSyncIntervalMs > 0) {
      this.startAutoSync(options.autoSyncIntervalMs);
    }
  }

  startAutoSync(intervalMs = 60000): void {
    if (this.autoSyncTimer) return;
    this.autoSyncTimer = setInterval(() => {
      this.syncIncremental().catch(() => {});
    }, intervalMs);
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = undefined;
    }
  }

  /**
   * 发送全量 Catalog 快照 (上线或对账时)
   */
  async sendSnapshot(): Promise<boolean> {
    const ws = this.getWebSocket();
    if (!ws || ws.readyState !== 1) return false;

    try {
      this.isSyncing = true;
      const snapshot = await this.provider.getSnapshot();
      const envelope = createEnvelope(
        "catalog.sync_snapshot",
        snapshot,
        this.nodeId,
        this.coordinatorNodeId
      );
      ws.send(encodeEnvelope(envelope));
      return true;
    } catch (err) {
      console.warn(`[WorkerCatalogSync] Failed to send catalog snapshot:`, err);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 发送增量更新 Delta (本地发生变化时)
   */
  async syncIncremental(): Promise<boolean> {
    const ws = this.getWebSocket();
    if (!ws || ws.readyState !== 1 || this.isSyncing) return false;

    try {
      this.isSyncing = true;
      this.provider.incrementRevision();
      const delta = await this.provider.getDelta();
      const envelope = createEnvelope(
        "catalog.sync_delta",
        delta,
        this.nodeId,
        this.coordinatorNodeId
      );
      ws.send(encodeEnvelope(envelope));
      return true;
    } catch (err) {
      console.warn(`[WorkerCatalogSync] Failed to send catalog delta:`, err);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 处理收到 Coordinator 的 Snapshot ACK
   */
  handleSnapshotAck(payload: CatalogSyncSnapshotAckPayload): void {
    if (payload.status === "ok") {
      this.lastAckedRevision = Math.max(this.lastAckedRevision, payload.catalogRevision);
      this.provider.acknowledgeRevision(payload.catalogRevision);
    }
  }

  /**
   * 处理收到 Coordinator 的 Delta ACK
   */
  handleDeltaAck(payload: CatalogSyncDeltaAckPayload): void {
    if (payload.status === "ok") {
      this.lastAckedRevision = Math.max(this.lastAckedRevision, payload.catalogRevision);
      this.provider.acknowledgeRevision(payload.catalogRevision);
    } else if (payload.status === "reconcile_required") {
      // 协调器检测到版本空洞或不一致，自动触发一次全量快照对账
      this.sendSnapshot().catch(() => {});
    }
  }

  /**
   * 处理 Coordinator 发起的第二级远程记忆检索请求
   */
  async handleRemoteSearchRequest(
    payload: RemoteMemorySearchPayload,
    correlationId?: string
  ): Promise<void> {
    const ws = this.getWebSocket();
    if (!ws || ws.readyState !== 1) return;

    try {
      const response = await this.provider.handleRemoteMemorySearch(payload);
      const envelope = createEnvelope(
        "memory.search_remote_response",
        response,
        this.nodeId,
        this.coordinatorNodeId,
        correlationId
      );
      ws.send(encodeEnvelope(envelope));
    } catch (err) {
      console.error(`[WorkerCatalogSync] Error processing remote memory search:`, err);
    }
  }
}
