import * as crypto from "node:crypto";
import type { ProjectContext } from "../project/project-context.js";
import type { EventBus } from "../observability/event-bus.js";
import type {
  MemoryConfig,
  MemoryEntry,
  MemoryQuery,
  MemoryRetrievalResult,
  MemoryScope,
} from "./types.js";
import { DEFAULT_MEMORY_CONFIG } from "./types.js";
import { getGlobalMemoryDir, getProjectMemoryDir } from "./memory-paths.js";
import { MemoryStore } from "./memory-store.js";
import { MemoryRetriever } from "./memory-retriever.js";
import { MemoryWriter, type AddMemoryInput } from "./memory-writer.js";
import { renderPreferencesPrompt, renderMemoryIndexPrompt } from "./memory-renderer.js";

export interface MemoryServiceOptions {
  projectContext?: ProjectContext;
  nashHome?: string;
  config?: Partial<MemoryConfig>;
  eventBus?: EventBus;
}

/**
 * 统一 Memory 核心服务
 */
export class MemoryService {
  private readonly config: MemoryConfig;
  private readonly globalStore: MemoryStore;
  private readonly projectStore?: MemoryStore;
  private readonly retriever: MemoryRetriever;
  private readonly eventBus?: EventBus;
  private readonly projectId: string;

  constructor(options?: MemoryServiceOptions) {
    this.config = {
      ...DEFAULT_MEMORY_CONFIG,
      ...options?.config,
    };
    this.eventBus = options?.eventBus;
    this.projectId = options?.projectContext?.projectId ?? "global";

    const nashHome = options?.nashHome;
    const globalDir = getGlobalMemoryDir(nashHome);
    this.globalStore = new MemoryStore({
      storageDir: globalDir,
      scope: "global",
      displayName: "Global Memory",
    });

    if (options?.projectContext) {
      const projectDir = getProjectMemoryDir(options.projectContext, nashHome);
      this.projectStore = new MemoryStore({
        storageDir: projectDir,
        scope: "project",
        displayName: `${options.projectContext.displayName} Project Memory`,
      });
    }

    this.retriever = new MemoryRetriever();
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: this.projectId,
        sessionId: "memory-session",
        data,
      });
    }
  }

  getConfig(): MemoryConfig {
    return { ...this.config };
  }

  /**
   * 记录一条长期知识 (显式或自动学习)
   */
  async remember(
    input: AddMemoryInput & { scope?: MemoryScope }
  ): Promise<MemoryEntry | null> {
    if (!this.config.enabled) {
      return null;
    }

    const targetScope = input.scope ?? (this.projectStore ? "project" : "global");
    const targetStore = targetScope === "project" && this.projectStore ? this.projectStore : this.globalStore;

    try {
      const writer = new MemoryWriter(targetStore);
      const result = await writer.addMemory(input);

      if (result.action === "created") {
        this.emitEvent("memory.created", { entry: result.entry });
      } else if (result.action === "reinforced") {
        this.emitEvent("memory.updated", { entry: result.entry });
      } else if (result.action === "superseded") {
        this.emitEvent("memory.superseded", {
          entry: result.entry,
          supersededIds: result.supersededIds,
        });
      }

      return result.entry;
    } catch (err: unknown) {
      this.emitEvent("memory.persist_failed", {
        error: err instanceof Error ? err.message : String(err),
        input,
      });
      return null;
    }
  }

  /**
   * 根据当前用户输入或任务召回最相关的长期记忆
   */
  async retrieveRelevant(
    queryText: string,
    options?: Partial<MemoryQuery>
  ): Promise<MemoryRetrievalResult> {
    if (!this.config.enabled) {
      return {
        entries: [],
        totalRetrieved: 0,
        estimatedTokens: 0,
        projectCount: 0,
        globalCount: 0,
      };
    }

    try {
      const allCandidates: MemoryEntry[] = [];

      // 1. 加载 Global Memory
      const globalEntries = await this.globalStore.loadEntries();
      allCandidates.push(...globalEntries);

      // 2. 加载 Project Memory (若存在)
      if (this.projectStore) {
        const projectEntries = await this.projectStore.loadEntries();
        allCandidates.push(...projectEntries);
      }

      const query: MemoryQuery = {
        query: queryText,
        maxEntries: options?.maxEntries ?? this.config.maxContextEntries,
        maxTokens: options?.maxTokens ?? this.config.maxContextTokens,
        scope: options?.scope ?? "all",
        minConfidence: options?.minConfidence,
      };

      const result = this.retriever.retrieve(allCandidates, query);

      if (result.entries.length > 0) {
        this.emitEvent("memory.retrieved", {
          query: queryText,
          count: result.totalRetrieved,
          tokens: result.estimatedTokens,
        });
      }

      return result;
    } catch {
      return {
        entries: [],
        totalRetrieved: 0,
        estimatedTokens: 0,
        projectCount: 0,
        globalCount: 0,
      };
    }
  }

  /**
   * 废弃一条记忆 (标记 deprecated，移出活跃检索)
   */
  async forget(id: string): Promise<boolean> {
    if (this.projectStore) {
      const ok = await this.projectStore.deprecateEntry(id);
      if (ok) {
        this.emitEvent("memory.deprecated", { id, scope: "project" });
        return true;
      }
    }
    const okGlobal = await this.globalStore.deprecateEntry(id);
    if (okGlobal) {
      this.emitEvent("memory.deprecated", { id, scope: "global" });
      return true;
    }
    return false;
  }

  /**
   * 获取所有 Memory 记录
   */
  async getAll(scope?: MemoryScope | "all"): Promise<MemoryEntry[]> {
    const list: MemoryEntry[] = [];
    if (!scope || scope === "all" || scope === "global") {
      list.push(...(await this.globalStore.loadEntries()));
    }
    if ((!scope || scope === "all" || scope === "project") && this.projectStore) {
      list.push(...(await this.projectStore.loadEntries()));
    }
    return list;
  }

  /**
   * 搜索记忆
   */
  async search(query: string, scope?: MemoryScope | "all"): Promise<MemoryEntry[]> {
    const result = await this.retrieveRelevant(query, {
      scope,
      maxEntries: 20,
      maxTokens: 5000,
      minConfidence: 0.1,
    });
    return result.entries;
  }

  /**
   * 获取所有活跃的用户偏好与核心人设约束 (Invariants)
   */
  async getPreferences(): Promise<MemoryEntry[]> {
    if (!this.config.enabled) return [];
    const all = await this.getAll();
    return all.filter(
      (e) => !e.deprecated && (e.kind === "preference" || e.tags?.includes("persona") || e.tags?.includes("invariant"))
    );
  }

  /**
   * 渐进式渲染注入 System Prompt 的持久化记忆段落
   * 架构分层：
   * 1. Tier 1A: 核心人设与用户偏好 (Permanent Invariants，无条件常驻)
   * 2. Tier 1B: 记忆索引大纲 (Progressive Memory Index，按需指引)
   * 3. Tier 2: 任务相关的具体架构事实 (Relevant Memory，词频/置信度匹配补充)
   */
  async renderProgressiveMemoryPrompt(queryText: string = ""): Promise<string> {
    const ctx = await this.getProgressiveMemoryContext(queryText);
    return ctx.prompt;
  }

  /**
   * 获取当前轮次渐进式记忆全景上下文，包含生成的 Prompt 与激活召回的记忆列表
   */
  async getProgressiveMemoryContext(queryText: string = ""): Promise<{
    prompt: string;
    recalledMemories: Array<{ id: string; content: string; kind: string; scope: string }>;
  }> {
    if (!this.config.enabled) {
      return { prompt: "", recalledMemories: [] };
    }

    const all = await this.getAll();
    const active = all.filter((e) => !e.deprecated);
    if (active.length === 0) {
      return { prompt: "", recalledMemories: [] };
    }

    const promptParts: string[] = [];
    const recalledMemories: Array<{ id: string; content: string; kind: string; scope: string }> = [];

    // Tier 1A: 核心偏好与人设 (常驻)
    const preferences = active.filter(
      (e) => e.kind === "preference" || e.tags?.includes("persona") || e.tags?.includes("invariant")
    );
    const preferencesPrompt = renderPreferencesPrompt(active);
    if (preferencesPrompt) {
      promptParts.push(preferencesPrompt);
      for (const p of preferences) {
        recalledMemories.push({ id: p.id, content: p.content, kind: p.kind, scope: p.scope });
      }
    }

    // Tier 1B: 渐进式索引概览
    const indexPrompt = renderMemoryIndexPrompt(active, this.config.maxContextEntries);
    if (indexPrompt) {
      promptParts.push(indexPrompt);
    }

    // Tier 2: 若当前有明确查询，补充召回强相关的具体架构与知识 (排除已常驻的 preferences)
    if (queryText && queryText.trim()) {
      const specificNonPref = this.retriever.retrieve(active.filter(
        e => e.kind !== "preference" && !e.tags?.includes("persona") && !e.tags?.includes("invariant")
      ), { query: queryText, maxEntries: this.config.maxContextEntries, maxTokens: this.config.maxContextTokens }).entries;

      if (specificNonPref.length > 0) {
        const lines = ["# Contextual Domain & Technical Knowledge (Tier 2 Retrieval)"];
        for (const item of specificNonPref) {
          const scopeTag = item.scope === "project" ? " [project]" : " [global]";
          lines.push(`- ${item.content}${scopeTag}`);
          recalledMemories.push({ id: item.id, content: item.content, kind: item.kind, scope: item.scope });
        }
        promptParts.push(lines.join("\n"));
      }
    }

    return {
      prompt: promptParts.join("\n\n"),
      recalledMemories,
    };
  }
}
