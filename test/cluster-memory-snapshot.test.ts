import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { createLocalClusterStore } from "../src/cluster/storage/local-cluster-store.js";
import { CoordinatorCatalogService } from "../src/cluster/coordinator/catalog/coordinator-catalog-service.js";
import { LocalCatalogProvider } from "../src/cluster/worker/catalog/local-catalog-provider.js";
import { ProjectRegistry } from "../src/cluster/worker/project-registry.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import type { FederatedMemoryIndexItem, CatalogSyncSnapshotPayload } from "../src/cluster/protocol/types.js";

const entry = (entryId: string, nodeId = "worker"): FederatedMemoryIndexItem => ({ entryId, nodeId, projectId: "project", topic: entryId, summary: entryId, keywords: [], sourceReference: "source", confidence: 0.8, visibility: "summary", revision: 1, updatedAt: 1 });
const snapshot = (revision: number, memoryIndex: FederatedMemoryIndexItem[]): CatalogSyncSnapshotPayload => ({ nodeId: "worker", catalogRevision: revision, memoryIndex, hardwareCapabilities: [], projects: [], skills: [], mcp: [] });
function fixture() {
  const store = new InMemoryClusterStore(); let generation = 1;
  const service = new CoordinatorCatalogService(store, { getConnection: () => ({ generation }) } as any, "coordinator");
  return { store, service, reconnect: () => { generation++; } };
}

test("完整快照删除本节点旧 Worker 记忆，保留 Discovery 和其他节点；空快照也生效", async () => {
  const { store, service } = fixture();
  await store.upsertMemoryIndex([entry("old"), entry("mem-disc-found"), entry("other", "other")]);
  assert.equal((await service.handleSnapshot(snapshot(2, [entry("new")]))).status, "ok");
  assert.deepEqual((await store.listMemoryIndex()).map(e => e.entryId).sort(), ["mem-disc-found", "new", "other"]);
  assert.equal((await service.handleSnapshot(snapshot(3, []))).status, "ok");
  assert.deepEqual((await store.listMemoryIndex()).map(e => e.entryId).sort(), ["mem-disc-found", "other"]);
});

test("旧版本不能恢复已移除记忆；新连接可重置版本，旧连接不能再写入", async () => {
  const { store, service, reconnect } = fixture();
  await service.handleSnapshot(snapshot(20, [entry("keep")]), 1);
  await service.handleSnapshot(snapshot(21, []), 1);
  assert.equal((await service.handleSnapshot(snapshot(20, [entry("old")] ), 1)).status, "rejected");
  reconnect();
  assert.equal((await service.handleSnapshot(snapshot(1, [entry("new")]), 2)).status, "ok");
  assert.equal((await service.handleSnapshot(snapshot(30, [entry("zombie")]), 1)).status, "rejected");
  assert.deepEqual((await store.listMemoryIndex()).map(e => e.entryId), ["new"]);
});

test("同节点同步串行收敛，迟到的低版本快照不会复活旧记录", async (t) => {
  const { store, service } = fixture();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const original = store.upsertWorkerMemorySnapshot.bind(store);
  let calls = 0;
  t.mock.method(store, "upsertWorkerMemorySnapshot", async (nodeId: string, entries: FederatedMemoryIndexItem[]) => { if (++calls === 1) await gate; await original(nodeId, entries); });
  const first = service.handleSnapshot(snapshot(2, [entry("old")]));
  const second = service.handleSnapshot(snapshot(4, []));
  const late = service.handleSnapshot(snapshot(3, [entry("stale")]));
  release();
  assert.equal((await first).status, "ok"); assert.equal((await second).status, "ok"); assert.equal((await late).status, "rejected");
  assert.deepEqual(await store.listMemoryIndex(), []);
});

test("普通 Delta 不误删缺席条目，旧 Worker 请求完整对账，显式完整 Delta 支持清空", async () => {
  const { store, service } = fixture();
  await store.upsertMemoryIndex([entry("old")]);
  assert.equal((await service.handleDelta({ nodeId: "worker", catalogRevision: 2, memoryIndexUpsert: [entry("new")] })).status, "reconcile_required");
  assert.equal((await store.listMemoryIndex()).length, 2);
  assert.equal((await service.handleDelta({ nodeId: "worker", catalogRevision: 3, memoryIndexComplete: true, memoryIndexUpsert: [] })).status, "ok");
  assert.deepEqual(await store.listMemoryIndex(), []);
  assert.equal((await service.handleDelta({ nodeId: "worker", catalogRevision: 4, memoryIndexComplete: true })).status, "rejected");
});

test("无效跨节点或 Coordinator 保留标识不能通过 Worker 替换原子删除任何数据", async () => {
  const { store, service } = fixture(); await store.upsertMemoryIndex([entry("old")]);
  await assert.rejects(store.upsertWorkerMemorySnapshot("worker", [entry("bad", "other")]));
  await assert.rejects(store.upsertWorkerMemorySnapshot("worker", [entry("mem-disc-stolen")]));
  await assert.rejects(store.upsertWorkerMemorySnapshot("worker", [entry("duplicate"), entry("duplicate")]));
  assert.equal((await service.handleSnapshot(snapshot(2, [entry("bad", "other")]))).status, "rejected");
  assert.deepEqual((await store.listMemoryIndex()).map(e => e.entryId), ["old"]);
});

test("本地持久库重启后不恢复已清理的索引，Worker 导出空 Delta 明确声明完整", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-memory-reconcile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "state.bin"); const store = createLocalClusterStore(file);
  await store.upsertMemoryIndex([entry("old")]); await store.upsertWorkerMemorySnapshot("worker", []);
  assert.deepEqual(await createLocalClusterStore(file).listMemoryIndex(), []);
  const provider = new LocalCatalogProvider({ nodeId: "worker", projectRegistry: new ProjectRegistry({ customDir: root }), nashHome: root });
  const delta = await provider.getDelta(); assert.equal(delta.memoryIndexComplete, true); assert.deepEqual(delta.memoryIndexUpsert, []);
});

test("物理删除原始记忆同时更新 Markdown，磁盘合并与重新加载都不会复活问题片段", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-memory-remove-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ storageDir: root, scope: "project" });
  await store.saveEntries([{ id: "bad-question", scope: "project", kind: "preference", content: "叫我什么", confidence: 1, source: "user-explicit", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", reinforcementCount: 1 }]);
  assert.equal(await store.removeEntry("bad-question"), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8")), []);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "MEMORY.md"), "utf8"), /叫我什么/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "preference.md"), "utf8"), /叫我什么/);
  assert.deepEqual(await new MemoryStore({ storageDir: root, scope: "project" }).loadEntries(), []);
  const sample = { scope: "project" as const, kind: "fact" as const, content: "知识", confidence: 1, source: "verified-code" as const, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", reinforcementCount: 1 };
  await store.saveEntries([ { ...sample, id: "first" }, { ...sample, id: "second" }, { ...sample, id: "keep" } ]);
  await Promise.all([store.removeEntry("first"), store.removeEntry("second")]);
  assert.deepEqual((await new MemoryStore({ storageDir: root, scope: "project" }).loadEntries()).map(e => e.id), ["keep"]);
});
