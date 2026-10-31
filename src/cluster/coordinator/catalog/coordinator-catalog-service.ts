import { ClusterStorageError, type IClusterStore } from "../../storage/cluster-store.js";
import type { NodeRegistry } from "../node-registry.js";
import { createEnvelope, encodeEnvelope } from "../../protocol/message-codec.js";
import type {
  CatalogSyncSnapshotPayload,
  CatalogSyncSnapshotAckPayload,
  CatalogSyncDeltaPayload,
  CatalogSyncDeltaAckPayload,
  RemoteMemorySearchPayload,
  RemoteMemorySearchResponsePayload,
} from "../../protocol/types.js";

export interface PendingRemoteSearch {
  resolve: (res: RemoteMemorySearchResponsePayload) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class CoordinatorCatalogService {
  private readonly pendingSearches = new Map<string, PendingRemoteSearch>();
  private readonly syncQueues = new Map<string, Promise<void>>();
  private readonly snapshotGenerations = new Map<string, number>();

  constructor(
    private readonly store: IClusterStore,
    private readonly registry: NodeRegistry,
    private readonly coordinatorNodeId: string
  ) {}

  /**
   * 处理节点全量快照同步
   */
  handleSnapshot(snapshot: CatalogSyncSnapshotPayload, generation?: number): Promise<CatalogSyncSnapshotAckPayload> {
    return this.serializeSync(snapshot.nodeId, () => this.applySnapshot(snapshot, generation));
  }

  private serializeSync<T>(nodeId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.syncQueues.get(nodeId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => {}, () => {});
    this.syncQueues.set(nodeId, settled);
    void settled.then(() => { if (this.syncQueues.get(nodeId) === settled) this.syncQueues.delete(nodeId); });
    return result;
  }

  private assertGeneration(nodeId: string, generation?: number): void {
    if (generation !== undefined && this.registry.getConnection(nodeId)?.generation !== generation) {
      throw new ClusterStorageError("Catalog connection generation is no longer current");
    }
  }

  private async applySnapshot(snapshot: CatalogSyncSnapshotPayload, generation?: number): Promise<CatalogSyncSnapshotAckPayload> {
    const { nodeId, catalogRevision, hardwareCapabilities, projects, skills, mcp, memoryIndex } = snapshot;

    try {
      this.assertGeneration(nodeId, generation);
      const current = await this.store.getCatalogRevision(nodeId);
      const newConnection = generation !== undefined && this.snapshotGenerations.get(nodeId) !== generation;
      if (!newConnection && current && catalogRevision < current.revision) throw new ClusterStorageError("Outdated catalog snapshot revision");
      if (!Array.isArray(memoryIndex) || memoryIndex.some((entry) => entry.nodeId !== nodeId || entry.entryId.startsWith("mem-disc-"))) {
        throw new ClusterStorageError("Invalid worker memory snapshot ownership");
      }

      await this.store.upsertNodeCatalogSnapshot(snapshot);
      if (generation !== undefined) this.snapshotGenerations.set(nodeId, generation);

      // 6. 记录同步日志
      await this.store.recordSyncLog(
        nodeId,
        "snapshot",
        catalogRevision,
        {
          projects: projects.length,
          skills: skills.length,
          mcp: mcp.length,
          memory: memoryIndex.length,
        },
        "success"
      );

      return {
        nodeId,
        catalogRevision,
        appliedAt: Date.now(),
        status: "ok",
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[CoordinatorCatalog] Failed to apply snapshot from ${nodeId}:`, err);
      await this.store.recordSyncLog(
        nodeId,
        "snapshot",
        catalogRevision,
        {},
        "failed",
        errMsg
      );
      return {
        nodeId,
        catalogRevision,
        appliedAt: Date.now(),
        status: "rejected",
        reason: errMsg,
      };
    }
  }

  /**
   * 处理节点增量同步 Delta
   */
  handleDelta(delta: CatalogSyncDeltaPayload, generation?: number): Promise<CatalogSyncDeltaAckPayload> {
    return this.serializeSync(delta.nodeId, () => this.applyDelta(delta, generation));
  }

  private async applyDelta(delta: CatalogSyncDeltaPayload, generation?: number): Promise<CatalogSyncDeltaAckPayload> {
    const {
      nodeId,
      catalogRevision,
      hardwareCapabilities,
      projectsUpsert,
      projectsDelete,
      skillsUpsert,
      skillsDelete,
      mcpUpsert,
      mcpDelete,
      memoryIndexUpsert,
      memoryIndexDelete,
    } = delta;

    try {
      this.assertGeneration(nodeId, generation);
      // 1. 版本检查
      const currentRev = await this.store.getCatalogRevision(nodeId);
      if (currentRev && catalogRevision < currentRev.revision) {
        // 收到旧版本更新，拒绝并要求对账
        return {
          nodeId,
          catalogRevision,
          appliedAt: Date.now(),
          status: "reconcile_required",
          reason: `Outdated revision ${catalogRevision} < ${currentRev.revision}`,
        };
      }

      if (memoryIndexUpsert?.some((entry) => entry.nodeId !== nodeId || entry.entryId.startsWith("mem-disc-")) || memoryIndexDelete?.some((entry) => entry.resourceId.startsWith("mem-disc-"))) {
        throw new ClusterStorageError("Invalid worker memory delta ownership");
      }
      if (delta.memoryIndexComplete && !Array.isArray(memoryIndexUpsert)) {
        throw new ClusterStorageError("Complete memory index must include an array, including when empty");
      }

      for (const entries of [projectsUpsert, skillsUpsert, mcpUpsert]) {
        if (entries?.some((entry) => entry.nodeId !== nodeId)) throw new ClusterStorageError("Invalid catalog delta ownership");
      }

      // 3. 项目增删
      if (projectsUpsert && projectsUpsert.length > 0) {
        await this.store.upsertProjectCatalog(projectsUpsert);
      }
      if (projectsDelete && projectsDelete.length > 0) {
        await this.store.deleteProjectCatalog(
          nodeId,
          projectsDelete.map((p) => p.resourceId)
        );
        await this.store.saveTombstones(projectsDelete, nodeId);
      }

      // 4. Skills 增删
      if (skillsUpsert && skillsUpsert.length > 0) {
        await this.store.upsertSkillCatalog(skillsUpsert);
      }
      if (skillsDelete && skillsDelete.length > 0) {
        await this.store.deleteSkillCatalog(
          nodeId,
          skillsDelete.map((s) => s.resourceId)
        );
        await this.store.saveTombstones(skillsDelete, nodeId);
      }

      // 5. MCP 增删
      if (mcpUpsert && mcpUpsert.length > 0) {
        await this.store.upsertMCPCatalog(mcpUpsert);
      }
      if (mcpDelete && mcpDelete.length > 0) {
        await this.store.deleteMCPCatalog(
          nodeId,
          mcpDelete.map((m) => m.resourceId)
        );
        await this.store.saveTombstones(mcpDelete, nodeId);
      }

      // 6. Memory Index 增删
      if (delta.memoryIndexComplete) {
        await this.store.upsertWorkerMemorySnapshot(nodeId, memoryIndexUpsert!);
      } else if (memoryIndexUpsert && memoryIndexUpsert.length > 0) {
        await this.store.upsertMemoryIndex(memoryIndexUpsert);
      }
      if (memoryIndexDelete && memoryIndexDelete.length > 0) {
        await this.store.deleteMemoryIndex(
          nodeId,
          memoryIndexDelete.map((m) => m.resourceId)
        );
        await this.store.saveTombstones(memoryIndexDelete, nodeId);
      }

      await this.store.saveCatalogRevision(nodeId, catalogRevision, hardwareCapabilities ?? currentRev?.capabilities ?? [], "idle");

      // 7. 记录同步审计
      await this.store.recordSyncLog(
        nodeId,
        "delta",
        catalogRevision,
        {
          projectsUpsert: projectsUpsert?.length ?? 0,
          projectsDelete: projectsDelete?.length ?? 0,
          memoryUpsert: memoryIndexUpsert?.length ?? 0,
          memoryDelete: memoryIndexDelete?.length ?? 0,
        },
        "success"
      );

      return {
        nodeId,
        catalogRevision,
        appliedAt: Date.now(),
        status: memoryIndexUpsert !== undefined && !delta.memoryIndexComplete ? "reconcile_required" : "ok",
        ...(memoryIndexUpsert !== undefined && !delta.memoryIndexComplete ? { reason: "A complete Worker memory snapshot is required to reconcile removed entries" } : {}),
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[CoordinatorCatalog] Failed to apply delta from ${nodeId}:`, err);
      return {
        nodeId,
        catalogRevision,
        appliedAt: Date.now(),
        status: "rejected",
        reason: errMsg,
      };
    }
  }

  /**
   * 路由分发第二级远程记忆检索 (向在线 Worker 发起)
   */
  async searchRemoteMemory(
    nodeId: string,
    projectId: string,
    query: string,
    options?: { topK?: number; maxTokens?: number; timeoutMs?: number }
  ): Promise<RemoteMemorySearchResponsePayload> {
    const conn = this.registry.getConnection(nodeId);

    // 铁律：节点离线时不能继续发起不可完成的 Remote Memory Search
    if (!conn || conn.ws.readyState !== 1) {
      return {
        requestId: `req-${Date.now()}`,
        nodeId,
        projectId,
        results: [],
        totalFound: 0,
        retrievalStatus: "error",
        error: `Node ${nodeId} is currently offline. Remote memory search unavailable.`,
        latencyMs: 0,
      };
    }

    const requestId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = options?.timeoutMs ?? 10000;

    const payload: RemoteMemorySearchPayload = {
      requestId,
      nodeId,
      projectId,
      query,
      topK: options?.topK ?? 5,
      maxTokens: options?.maxTokens ?? 1200,
      timeoutMs,
    };

    const envelope = createEnvelope(
      "memory.search_remote_request",
      payload,
      this.coordinatorNodeId,
      nodeId,
      requestId
    );

    return new Promise<RemoteMemorySearchResponsePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSearches.delete(requestId);
        resolve({
          requestId,
          nodeId,
          projectId,
          results: [],
          totalFound: 0,
          retrievalStatus: "error",
          error: `Remote memory search timed out after ${timeoutMs}ms`,
          latencyMs: timeoutMs,
        });
      }, timeoutMs);

      this.pendingSearches.set(requestId, { resolve, reject, timer });

      try {
        conn.ws.send(encodeEnvelope(envelope));
      } catch (err) {
        clearTimeout(timer);
        this.pendingSearches.delete(requestId);
        resolve({
          requestId,
          nodeId,
          projectId,
          results: [],
          totalFound: 0,
          retrievalStatus: "error",
          error: `Failed to send search envelope: ${err instanceof Error ? err.message : String(err)}`,
          latencyMs: 0,
        });
      }
    });
  }

  /**
   * 接收并解析 Worker 回传的远程记忆响应
   */
  handleRemoteSearchResponse(response: RemoteMemorySearchResponsePayload): void {
    const pending = this.pendingSearches.get(response.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSearches.delete(response.requestId);
      pending.resolve(response);
    }
  }
}
