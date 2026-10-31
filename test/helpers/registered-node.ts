import { simulatedCapabilities } from "./runtime-truth-fixtures.js";
import type { IClusterStore } from "../../src/cluster/storage/cluster-store.js";

export async function registerFixtureNodes(store: IClusterStore, ...ids: string[]): Promise<void> {
  for (const nodeId of ids) { await store.saveCatalogRevision(nodeId, 1, simulatedCapabilities("linux")); await store.saveNode({ nodeId, name: nodeId, role: "worker", platform: "linux", arch: "x64", hostname: "fixture", tokenHash: "fixture", status: "offline", lastSeenAt: 0, metadata: {}, createdAt: 0, updatedAt: 0 }); }
}
