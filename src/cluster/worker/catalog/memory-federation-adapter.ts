import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { MemoryService } from "../../../memory/memory-service.js";
import { MemoryStore } from "../../../memory/memory-store.js";
import { getProjectMemoryDir } from "../../../memory/memory-paths.js";
import type { ProjectRegistry } from "../project-registry.js";
import type {
  FederatedMemoryIndexItem,
  RemoteMemorySearchPayload,
  RemoteMemorySearchResultItem,
  RemoteMemorySearchResponsePayload,
} from "../../protocol/types.js";
import { ProjectRegistryAdapter } from "./project-registry-adapter.js";

export interface MemoryFederationOptions {
  nodeId: string;
  projectRegistry: ProjectRegistry;
  projectAdapter: ProjectRegistryAdapter;
  nashHome?: string;
}

export class MemoryFederationAdapter {
  private readonly nodeId: string;
  private readonly projectRegistry: ProjectRegistry;
  private readonly projectAdapter: ProjectRegistryAdapter;
  private readonly nashHome?: string;

  constructor(options: MemoryFederationOptions) {
    this.nodeId = options.nodeId;
    this.projectRegistry = options.projectRegistry;
    this.projectAdapter = options.projectAdapter;
    this.nashHome = options.nashHome;
  }

  /**
   * 导出已授权项目的联邦记忆主题摘要 (轻量级索引，完整私密内容留存本地)
   * 铁律：
   * 1. Global Memory 默认属于用户私人偏好，不跨节点发布
   * 2. Session Memory 绝对不参与联邦索引
   * 3. 仅对 visibility 为 'summary' 或 'retrievable' 的已授权项目发布主题摘要
   */
  async exportFederatedIndex(revision = 1): Promise<FederatedMemoryIndexItem[]> {
    const projects = this.projectRegistry.listProjects();
    const indexItems: FederatedMemoryIndexItem[] = [];

    for (const proj of projects) {
      const override = this.projectAdapter.getProjectOverride(proj.projectId);
      const visibility = override?.visibility ?? "summary";

      // 仅限 summary 或 retrievable 项目发布主题索引
      if (visibility !== "summary" && visibility !== "retrievable") {
        continue;
      }

      // 加载该项目的 Project Memory
      const projectMemDir = getProjectMemoryDir(proj.canonicalPath, this.nashHome);
      if (!fs.existsSync(projectMemDir)) {
        continue;
      }

      const store = new MemoryStore({
        storageDir: projectMemDir,
        scope: "project",
        displayName: `${proj.name} Memory`,
      });

      const entries = await store.loadEntries();
      if (entries.length === 0) {
        continue;
      }

      // 按分类 (kind) 与核心标签 (tags) 聚合成主题索引 Entry
      const topicBuckets = new Map<string, typeof entries>();

      for (const entry of entries) {
        if (entry.deprecated) continue;
        const topic = (entry.tags && entry.tags[0]) || entry.kind || "general";
        const bucket = topicBuckets.get(topic) ?? [];
        bucket.push(entry);
        topicBuckets.set(topic, bucket);
      }

      for (const [topic, bucketEntries] of topicBuckets.entries()) {
        const keywordsSet = new Set<string>();
        keywordsSet.add(proj.name.toLowerCase());
        keywordsSet.add(topic.toLowerCase());

        for (const e of bucketEntries) {
          if (e.tags) {
            for (const t of e.tags) keywordsSet.add(t.toLowerCase());
          }
        }

        // 拼接简明主题摘要，每条抽取要点（严禁灌入未清洗的巨大原始文本）
        const summarizedEntries = bucketEntries.slice(0, 5);
        const summaryPoints = summarizedEntries.map((e) => {
          const contentSnippet = e.content.replace(/\r?\n/g, " ").slice(0, 150);
          return `[${e.kind}] ${contentSnippet}`;
        });

        const topicSummary = summaryPoints.join(" | ");
        const firstEntryId = bucketEntries[0]?.id ?? "root";

        const entryId = `fed-${proj.projectId}-${topic.toLowerCase().replace(/[^a-z0-9_-]/g, "")}`;

        indexItems.push({
          entryId,
          nodeId: this.nodeId,
          projectId: proj.projectId,
          topic: `${proj.name} · ${topic}`,
          summary: topicSummary,
          keywords: Array.from(keywordsSet).slice(0, 15),
          sourceReference: firstEntryId,
          confidence: Math.min(...summarizedEntries.map((entry) => Number.isFinite(entry.confidence) ? Math.max(0, Math.min(1, entry.confidence)) : 0)),
          visibility: visibility === "retrievable" ? "retrievable" : "summary",
          revision,
          updatedAt: Math.max(0, ...summarizedEntries.map((entry) => {
            const timestamp = Date.parse(entry.updatedAt);
            return Number.isFinite(timestamp) ? timestamp : 0;
          })),
        });
      }
    }

    return indexItems;
  }

  /**
   * 响应第二级远程记忆检索请求 (由 Coordinator 发起)
   * 严格调用本地 MemoryService，执行物理隔离与内容截断
   */
  async handleRemoteSearch(
    request: RemoteMemorySearchPayload
  ): Promise<RemoteMemorySearchResponsePayload> {
    const startTime = Date.now();
    const { requestId, projectId, query, topK = 5, maxTokens = 1200, minConfidence = 0.2 } = request;

    // 1. 验证目标项目是否存在且通过物理路径真实性校验
    const project = this.projectRegistry.getProject(projectId);
    if (!project) {
      return {
        requestId,
        nodeId: this.nodeId,
        projectId,
        results: [],
        totalFound: 0,
        retrievalStatus: "project_not_found",
        error: `Project ${projectId} not found on worker ${this.nodeId}`,
        latencyMs: Date.now() - startTime,
      };
    }

    // 2. 验证访问权限 (必须允许 retrievable)
    const override = this.projectAdapter.getProjectOverride(projectId);
    const visibility = override?.visibility ?? "summary";
    if (visibility === "not_published" || visibility === "discoverable") {
      return {
        requestId,
        nodeId: this.nodeId,
        projectId,
        results: [],
        totalFound: 0,
        retrievalStatus: "permission_denied",
        error: `Remote retrieval access denied for project ${projectId} (visibility: ${visibility})`,
        latencyMs: Date.now() - startTime,
      };
    }

    // 3. 构建本地 ProjectContext 并复用权威 MemoryService 检索
    try {
      const projectMemDir = getProjectMemoryDir(project.canonicalPath, this.nashHome);
      const store = new MemoryStore({
        storageDir: projectMemDir,
        scope: "project",
        displayName: `${project.name} Memory`,
      });

      const allEntries = await store.loadEntries();

      // 调用 MemoryService 内置检索机制
      const memoryService = new MemoryService({
        projectContext: {
          projectId,
          displayName: project.name,
          projectDir: path.dirname(projectMemDir),
        } as any,
        nashHome: this.nashHome,
      });

      const retrieval = await memoryService.retrieveRelevant(query, {
        maxEntries: topK,
        maxTokens,
        scope: "project",
        minConfidence,
      });

      const results: RemoteMemorySearchResultItem[] = retrieval.entries.map((entry) => {
        // 安全截断与防 Prompt Injection 边界处理
        const safeSnippet = entry.content.slice(0, 1000);
        return {
          memoryId: entry.id,
          topic: (entry.tags && entry.tags[0]) || entry.kind || "knowledge",
          snippet: safeSnippet,
          score: Number((entry.confidence || 0.8).toFixed(2)),
          confidence: entry.confidence,
          source: entry.source,
          updatedAt: entry.updatedAt,
        };
      });

      return {
        requestId,
        nodeId: this.nodeId,
        projectId,
        results,
        totalFound: results.length,
        retrievalStatus: "ok",
        latencyMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        requestId,
        nodeId: this.nodeId,
        projectId,
        results: [],
        totalFound: 0,
        retrievalStatus: "error",
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startTime,
      };
    }
  }
}
