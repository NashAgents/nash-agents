import type { FederatedMemoryIndexItem, CatalogSyncSnapshotPayload } from "../protocol/types.js";
import { ClusterStorageError } from "./cluster-store-types.js";

export function validateWorkerMemorySnapshot(nodeId: string, entries: FederatedMemoryIndexItem[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.nodeId !== nodeId || entry.entryId.startsWith("mem-disc-") || ids.has(entry.entryId)) {
      throw new ClusterStorageError("Invalid worker memory snapshot ownership or duplicate entry");
    }
    ids.add(entry.entryId);
  }
}

export function validateCatalogSnapshot(snapshot: CatalogSyncSnapshotPayload): void {
  validateWorkerMemorySnapshot(snapshot.nodeId, snapshot.memoryIndex);
  for (const [entries, id] of [[snapshot.projects, "projectId"], [snapshot.skills, "skillId"], [snapshot.mcp, "serverId"]] as const) {
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = (entry as unknown as Record<string, string>)[id];
      if (id === "projectId" && key?.startsWith("discovered-")) throw new ClusterStorageError("Worker snapshots cannot overwrite Coordinator discovery projects");
      if (entry.nodeId !== snapshot.nodeId || !key || seen.has(key)) throw new ClusterStorageError("Invalid catalog ownership or duplicate resource");
      seen.add(key);
    }
  }
}

