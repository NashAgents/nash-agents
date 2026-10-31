import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryFederationAdapter } from "../src/cluster/worker/catalog/memory-federation-adapter.js";
import { ProjectRegistry } from "../src/cluster/worker/project-registry.js";
import { ProjectRegistryAdapter } from "../src/cluster/worker/catalog/project-registry-adapter.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { getProjectMemoryDir } from "../src/memory/memory-paths.js";
import type { MemoryEntry } from "../src/memory/types.js";
import { formatMemoryTime, memoryDuplicates, memoryKey, memoryOrigin, memoryPoints, memoryPurpose, memoryReviewReason, type MemoryRecord } from "../apps/web/src/services/memory-presentation.js";

const record = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({ entryId: "entry", nodeId: "worker", projectId: "project", topic: "Project · architecture", summary: "[architecture] 独立知识", ...overrides });

test("记忆浏览保留跨项目与跨节点归属，重复内容仅提示，不吞掉来源", () => {
  const a = record(); const b = record({ projectId: "other" }); const c = record({ nodeId: "other" });
  const duplicates = memoryDuplicates([a, b, c, a]);
  assert.equal(duplicates.get(memoryKey(a))?.length, 2);
  assert.notEqual(memoryKey(a), memoryKey(c));
  assert.equal(memoryOrigin(record({ entryId: "mem-disc-project", topic: "Discovery: Project" })), "discovery");
  assert.equal(memoryOrigin(a), "project");
});

test("摘要分段保留内容中的管道符，含糊问题说明用途缺失而不伪装为确定偏好", () => {
  const item = record({ summary: "[architecture] use a | b | [fact] 另一条记录" });
  assert.deepEqual(memoryPoints(item), [{ kind: "架构", content: "use a | b" }, { kind: "事实", content: "另一条记录" }]);
  const question = record({ summary: "[preference] 叫我什么" });
  assert.match(memoryReviewReason(question), /没有记录具体称谓/);
  assert.match(memoryPurpose(question), /用途尚不明确/);
  assert.equal(memoryReviewReason(record({ summary: "[preference] 请称呼我 Kenny" })), "");
  assert.match(memoryReviewReason(record({ summary: "[fact] 到当前目录下的 report.md 文件中。" })), /依赖当时的目录/);
});

test("时间缺失与非法时间不伪造为今天，已知时间明确转换为北京时间", () => {
  assert.equal(formatMemoryTime(record()), "时间未记录");
  assert.equal(formatMemoryTime(record({ updatedAt: "invalid" })), "时间未记录");
  assert.equal(formatMemoryTime(record({ updatedAt: 0 })), "时间未记录");
  assert.match(formatMemoryTime(record({ updatedAt: "2026-10-20T18:28:35.878Z" })), /2026\/10\/21 02:28/);
});

test("联邦摘要沿用贡献记录的置信度与真实更新时间，重复导出不刷新知识时间", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-memory-presentation-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projectRoot = path.join(home, "source"); fs.mkdirSync(projectRoot);
  const registry = new ProjectRegistry({ customDir: home });
  const project = registry.registerProject(projectRoot, "memory-project");
  const adapter = new ProjectRegistryAdapter(registry, "worker", home);
  const store = new MemoryStore({ storageDir: getProjectMemoryDir(projectRoot, home), scope: "project" });
  const entry = (id: string, confidence: number, updatedAt: string): MemoryEntry => ({ id, content: `事实 ${id}`, kind: "fact", scope: "project", source: "verified-code", confidence, updatedAt, createdAt: updatedAt, reinforcementCount: 1, tags: ["topic"] });
  await store.saveEntries([entry("older", 0.75, "2026-10-10T12:00:00Z"), entry("newer", 0.6, "2026-10-11T12:00:00Z")]);
  const federation = new MemoryFederationAdapter({ nodeId: "worker", projectRegistry: registry, projectAdapter: adapter, nashHome: home });
  const first = await federation.exportFederatedIndex(); const second = await federation.exportFederatedIndex(2);
  assert.equal(first.length, 1); assert.equal(first[0]?.confidence, 0.6);
  assert.equal(first[0]?.updatedAt, Date.parse("2026-10-11T12:00:00Z"));
  assert.equal(second[0]?.updatedAt, first[0]?.updatedAt);
  assert.equal(first[0]?.sourceReference, "older");
});
